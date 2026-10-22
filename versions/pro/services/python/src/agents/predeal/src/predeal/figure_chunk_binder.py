"""Figure-chunk binder — 统一切片评审（结构调整 + 图归属）. 

2026 演进：
- 初版：按图调用 LLM（每图一次）
- v2：单切片评审（图归属 + 语义切分，一次调用双任务）
- v3（当前）：窗口级质量评审 —— 规则粗切后，LLM 检查每个切片是否合理
  （过短应合并 / 过长或有主题断裂应再切 / 内容位置问题），带规则约束
  （合并后 ≤ hard_max、切分后 ≥ MIN_VALID_CHUNK、代码块不可切、只相邻合并），
  不再只针对长段，也不再单切片孤立分析（窗口提供相邻上下文）。

A figure may belong to the previous chunk, the next chunk, or multiple chunks.
This module uses LLM reasoning to determine the binding, then physically
moves or copies the <img> tags into the appropriate chunk content.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from typing import Optional

import httpx
import pymysql
from pymysql.cursors import DictCursor

from .embedding_client import as_embed_fn
from .semantic_splitter import SPLIT_TASK_PROMPT, parse_json_response, resolve_split
from .utils.markdown import find_code_block_ranges

logger = logging.getLogger(__name__)

# LLM configuration
LLM_API_URL = os.environ.get("LLM_API_URL")
LLM_API_KEY = os.environ.get("LLM_API_KEY")
LLM_MODEL = os.environ.get("LLM_MODEL", "deepseek-chat")

# MiMo 推理模型限制：max_tokens 需 ≥ 4096，否则推理 token 耗尽导致 content 为空
LLM_MAX_TOKENS = 4096
LLM_TIMEOUT = 120.0
LLM_RETRIES = 3
# 切片评审并发度（mimo 推理模型单次 10~60s，串行 52 切片不可行）
REVIEW_CONCURRENCY = int(os.environ.get("SLICE_REVIEW_CONCURRENCY", "8"))

# MySQL connection
MYSQL_CONFIG = {
    "host": os.environ.get("MYSQL_HOST"),
    "port": int(os.environ.get("MYSQL_PORT", 3306)),
    "user": os.environ.get("MYSQL_USER"),
    "password": os.environ.get("MYSQL_PASSWORD"),
    "database": os.environ.get("MYSQL_DATABASE"),
    "charset": "utf8mb4",
    "cursorclass": DictCursor,
}

_IMG_TAG_RE = re.compile(r'<img\s+[^>]*data-figure-id="(\d+)"[^>]*/?>', re.IGNORECASE)


def _get_connection() -> pymysql.Connection:
    return pymysql.connect(**MYSQL_CONFIG)


# ── Data structures ────────────────────────────────────────────────────────


@dataclass
class FigureContext:
    figure_db_id: int
    occurrence_no: int
    caption: str
    alt_text: str
    vlm_description: str
    img_tag: str  # The full <img> tag
    prev_chunk_idx: Optional[int] = None
    current_chunk_idx: Optional[int] = None
    next_chunk_idx: Optional[int] = None
    bound_chunk_ids: str = ""       # cached LLM decision (JSON list), if any
    bound_context_hash: str = ""    # chunk context hash the decision was made for


@dataclass
class BindingResult:
    figure_db_id: int
    target_chunk_indices: list[int]  # Indices in the chunks list
    reasoning: str


# ── Load figures from DB ────────────────────────────────────────────────────


def load_figures_for_document(document_db_id: int) -> list[dict]:
    """Load all figures for a document from knowledge_figures."""
    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT id, occurrence_no, figure_label, caption, alt_text, vlm_description, "
                "vlm_model, source_url, storage_key, sha256, download_status, upload_status, "
                "vlm_status, bound_chunk_ids, bound_context_hash "
                "FROM knowledge_figures WHERE document_id = %s ORDER BY occurrence_no",
                (document_db_id,),
            )
            return cursor.fetchall()
    finally:
        conn.close()


# ── Build contexts ──────────────────────────────────────────────────────────


def save_figure_binding(
    figure_db_id: int,
    chunk_indices: list[int],
    context_hash: str,
) -> None:
    """Persist a figure's chunk-binding decision (deterministic cache).

    Stored so that re-runs with an identical chunk context reuse the previous
    LLM decision instead of calling the model again (non-deterministic).
    """
    import json
    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "UPDATE knowledge_figures SET bound_chunk_ids=%s, "
                "bound_context_hash=%s, updated_at=NOW() WHERE id=%s",
                (json.dumps(chunk_indices), context_hash, figure_db_id),
            )
            conn.commit()
    finally:
        conn.close()


def build_figure_contexts(
    figures: list[dict],
    chunks: list[dict],
    enhanced_text: str,
) -> list[FigureContext]:
    """Build context for each figure by locating its img tag in chunks."""
    # Extract all img tags from enhanced text, keyed by figure_db_id
    img_tags: dict[int, str] = {}
    for m in _IMG_TAG_RE.finditer(enhanced_text):
        fid = int(m.group(1))
        img_tags[fid] = m.group(0)

    contexts = []
    for fig in figures:
        fig_id = fig["id"]
        tag = img_tags.get(fig_id, "")

        # Find which chunk contains this figure
        current_idx = None
        for c_idx, chunk in enumerate(chunks):
            if f'data-figure-id="{fig_id}"' in chunk.get("content", ""):
                current_idx = c_idx
                break

        # If not found by data-figure-id, try by caption proximity
        if current_idx is None:
            search = fig.get("caption") or fig.get("alt_text") or ""
            if search:
                for c_idx, chunk in enumerate(chunks):
                    if search[:20] in chunk.get("content", ""):
                        current_idx = c_idx
                        break

        prev_idx = current_idx - 1 if current_idx is not None and current_idx > 0 else None
        next_idx = current_idx + 1 if current_idx is not None and current_idx < len(chunks) - 1 else None

        contexts.append(FigureContext(
            figure_db_id=fig_id,
            occurrence_no=fig.get("occurrence_no", 0),
            caption=fig.get("caption") or "",
            alt_text=fig.get("alt_text") or "",
            vlm_description=fig.get("vlm_description") or "",
            img_tag=tag,
            prev_chunk_idx=prev_idx,
            current_chunk_idx=current_idx,
            next_chunk_idx=next_idx,
            bound_chunk_ids=fig.get("bound_chunk_ids") or "",
            bound_context_hash=fig.get("bound_context_hash") or "",
        ))

    return contexts


# ── LLM reasoning ──────────────────────────────────────────────────────────


BINDING_PROMPT = """你是一个知识图谱专家。请判断以下图片应该归属到哪些切片中。

图片信息：
- 图号：{caption}
- 描述：{vlm_description}

{prev_context}

当前切片（图片所在位置）：
{current_context}

{next_context}

请判断这张图片应该归属到哪些切片。可能的情况：
1. 只属于当前切片
2. 属于当前切片和前一个切片
3. 属于当前切片和后一个切片
4. 只属于前一个切片
5. 只属于后一个切片

请严格返回以下 JSON 格式：
{{"target_indices": [切片序号1, 切片序号2], "reasoning": "简要说明归属理由"}}

注意：
- target_indices 使用 0-based 序号（第一个切片是 0）
- 最多归属 2 个切片
- 如果无法判断，归到当前切片"""


def bind_figure(
    ctx: FigureContext,
    chunks: list[dict],
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> BindingResult:
    """Use LLM to determine which chunks a figure belongs to."""
    url = api_url or LLM_API_URL
    key = api_key or LLM_API_KEY
    mdl = model or LLM_MODEL

    def chunk_desc(idx: Optional[int], label: str) -> str:
        if idx is None:
            return f"{label}：无"
        c = chunks[idx]
        content = c.get("content", "")
        snippet = content[:400] + ("..." if len(content) > 400 else "")
        return f"{label}（序号 {idx}，{c.get('title_path', '')}）：\n{snippet}"

    prompt = BINDING_PROMPT.format(
        caption=ctx.caption or "无",
        vlm_description=ctx.vlm_description or "无",
        prev_context=chunk_desc(ctx.prev_chunk_idx, "前一个切片"),
        current_context=chunk_desc(ctx.current_chunk_idx, "当前切片"),
        next_context=chunk_desc(ctx.next_chunk_idx, "后一个切片"),
    )

    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    body = {
        "model": mdl,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1,
        "max_tokens": 4000,
    }

    with httpx.Client(timeout=60.0, proxy=None) as client:
        resp = client.post(url, headers=headers, json=body)
        resp.raise_for_status()

    data = resp.json()
    text = data["choices"][0]["message"]["content"].strip()

    if "```" in text:
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()

    result = json.loads(text)
    indices = result.get("target_indices", [])

    # Validate indices
    valid_indices = [i for i in indices if 0 <= i < len(chunks)]
    if not valid_indices and ctx.current_chunk_idx is not None:
        valid_indices = [ctx.current_chunk_idx]

    return BindingResult(
        figure_db_id=ctx.figure_db_id,
        target_chunk_indices=valid_indices,
        reasoning=result.get("reasoning", ""),
    )


# ── Apply binding: move/copy img tags ───────────────────────────────────────


def apply_figure_binding(
    chunks: list[dict],
    figures: list[dict],
    enhanced_text: str,
    binding_results: list[BindingResult],
) -> list[dict]:
    """Apply figure binding results by moving/copying img tags into chunk content.

    Returns the modified chunks list (in-place modification).
    """
    # Build a map: figure_db_id -> img_tag
    img_tags: dict[int, str] = {}
    for m in _IMG_TAG_RE.finditer(enhanced_text):
        fid = int(m.group(1))
        img_tags[fid] = m.group(0)

    # Build a map: figure_db_id -> BindingResult
    binding_map: dict[int, BindingResult] = {br.figure_db_id: br for br in binding_results}

    # For each chunk, collect figures that should be in it
    chunk_figure_map: dict[int, list[str]] = {i: [] for i in range(len(chunks))}

    for fig in figures:
        fig_id = fig["id"]
        tag = img_tags.get(fig_id, "")
        if not tag:
            continue

        br = binding_map.get(fig_id)
        if br:
            for idx in br.target_chunk_indices:
                if 0 <= idx < len(chunks):
                    chunk_figure_map[idx].append(tag)

    # Remove all existing figure tags from all chunks
    for chunk in chunks:
        content = chunk.get("content", "")
        content = _IMG_TAG_RE.sub('', content)
        content = re.sub(r'\n{3,}', '\n\n', content).strip()
        chunk["content"] = content

    # Insert figures into their target chunks
    for idx, tags in chunk_figure_map.items():
        if not tags:
            continue
        # Deduplicate tags
        seen = set()
        unique_tags = []
        for tag in tags:
            if tag not in seen:
                seen.add(tag)
                unique_tags.append(tag)

        # Append figures at the end of the chunk content
        fig_block = "\n\n" + "\n\n".join(unique_tags)
        chunks[idx]["content"] = chunks[idx]["content"] + fig_block

    return chunks


# ── Main entry point ───────────────────────────────────────────────────────


def bind_figures_to_chunks(
    figures: list[dict],
    chunks: list[dict],
    enhanced_text: str,
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> list[BindingResult]:
    """Bind figures to chunks and move/copy img tags accordingly.

    Args:
        figures: From knowledge_figures
        chunks: Mutable list of chunk dicts (content will be modified)
        enhanced_text: Full enhanced markdown (for extracting img tags)

    Returns:
        List of BindingResult
    """
    contexts = build_figure_contexts(figures, chunks, enhanced_text)
    results = []

    for ctx in contexts:
        if not ctx.img_tag:
            logger.warning(f"Figure {ctx.figure_db_id}: no img tag found, skipping")
            results.append(BindingResult(
                figure_db_id=ctx.figure_db_id,
                target_chunk_indices=[],
                reasoning="No img tag found",
            ))
            continue

        try:
            result = bind_figure(ctx, chunks, api_url, api_key, model)
            results.append(result)
            logger.info(
                f"Figure {ctx.figure_db_id} ({ctx.caption}): "
                f"bound to chunks {result.target_chunk_indices}"
            )
        except Exception as e:
            logger.error(f"Failed to bind figure {ctx.figure_db_id}: {e}")
            # Default: keep in current chunk
            default_idx = ctx.current_chunk_idx
            results.append(BindingResult(
                figure_db_id=ctx.figure_db_id,
                target_chunk_indices=[default_idx] if default_idx is not None else [],
                reasoning=f"Error fallback: {e}",
            ))

    # Apply all bindings at once
    apply_figure_binding(chunks, figures, enhanced_text, results)

    return results


# ── 窗口级切片质量评审（结构调整：合并/再切/位置检查） ──────────────────

# 每个评审窗口的切片数（窗口提供相邻上下文，LLM 才能判断合并/边界问题）
WINDOW_SIZE = 5
# 窗口内每个切片的预览长度
CHUNK_PREVIEW_CHARS = 150

WINDOW_PROMPT = """你是一个课程切片质量审核专家。下面是文档中连续的一段切片序列（0-based 序号），每个切片附语义单元列表（代码块是整体单元，不可切开）。

{chunks}

请检查每个切片是否合理，输出调整建议（actions）：
1. merge：相邻且都过短（< 300 字）或内容属于同一主题、应合并成一个完整切片的
2. split：切片内部存在明显主题断裂（两个独立主题/概念被拼在一起）时再切分
3. 其他不合理（如内容明显错位）→ 无法自动处理，仅在 reasoning 中说明

规则（必须遵守）：
- merge 只允许相邻切片；合并后 ≤ 1800 字
- split 后每片 ≥ 200 字；代码块不可切开；split_after 必须来自该切片的单元序号
- 每片目标 300~1200 字
- 不要过度调整：长度合理、主题连贯的切片保持不动

严格返回 JSON，不要输出任何分析或思考过程：
{{"actions": [{{"type": "merge", "indices": [0, 1]}}, {{"type": "split", "index": 3, "split_after": [2]}}], "reasoning": "..."}}
actions 元素：
- merge: indices = 相邻切片序号列表（按序拼接）
- split: index = 切片序号，split_after = 该切片语义单元切分点（单元序号，在该切片单元列表中取值）"""


# ── 图归属（单切片上下文，含图才调用 + DB 缓存） ──────────────────────────


REVIEW_PROMPT = """你是一个知识图谱与文本切分专家。请对当前切片完成以下任务。

任务1（图片归属）：判断图片应归属到哪些切片中（可能属于前一个/当前/后一个切片）。

图片信息：
{figures_info}

{prev_context}

当前切片（图片所在位置）：
{current_context}

{next_context}

请对每张图返回 target_indices（0-based 全局切片序号，最多 2 个；无法判断则归当前切片）。

{split_task}

请严格返回以下 JSON，不要输出任何分析或思考过程，直接给出结果：
{{"figure_targets": {{"<图ID>": [切片序号1, 切片序号2]}}, "split_after": [单元序号], "reasoning": "一句话说明"}}
split_after：语义切分点（单元序号，从 0 开始）；不需要切分或未提供单元列表时返回 []。"""


@dataclass
class ReviewResult:
    figure_targets: dict[int, list[int]]  # figure_db_id -> chunk indices
    split_after: list[int]                # 语义切分单元序号
    reasoning: str


def review_slice(
    ctxs: list[FigureContext],
    chunks: list[dict],
    unit_listing: str,
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> ReviewResult:
    """对单个切片做一次 LLM 调用：同时输出图归属与语义切分建议."""
    url = api_url if api_url is not None else LLM_API_URL
    key = api_key if api_key is not None else LLM_API_KEY
    mdl = model if model is not None else LLM_MODEL
    if not url or not key:
        raise RuntimeError("LLM_API_URL/LLM_API_KEY not configured")

    def chunk_desc(idx: Optional[int], label: str) -> str:
        if idx is None:
            return f"{label}：无"
        c = chunks[idx]
        content = c.get("content", "")
        snippet = content[:400] + ("..." if len(content) > 400 else "")
        return f"{label}（序号 {idx}，{c.get('title_path', '')}）：\n{snippet}"

    current_idx = ctxs[0].current_chunk_idx
    figures_info = "\n".join(
        f"- 图 {ctx.figure_db_id}（{ctx.caption or '无'}）：{ctx.vlm_description or '无描述'}"
        for ctx in ctxs
    )
    split_task = SPLIT_TASK_PROMPT.format(units=unit_listing) if unit_listing else (
        "任务2（语义切分）：当前切片无需切分，split_after 返回 []。"
    )

    prompt = REVIEW_PROMPT.format(
        figures_info=figures_info,
        prev_context=chunk_desc(ctxs[0].prev_chunk_idx, "前一个切片"),
        current_context=chunk_desc(current_idx, "当前切片"),
        next_context=chunk_desc(ctxs[0].next_chunk_idx, "后一个切片"),
        split_task=split_task,
    )

    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    body = {
        "model": mdl,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1,
        "max_tokens": LLM_MAX_TOKENS,
    }

    result: Optional[dict] = None
    last_err: Optional[Exception] = None
    for _ in range(LLM_RETRIES):
        try:
            with httpx.Client(timeout=LLM_TIMEOUT, proxy=None) as client:
                resp = client.post(url, headers=headers, json=body)
                resp.raise_for_status()
            raw = resp.json()["choices"][0]["message"]["content"].strip()
            result = parse_json_response(raw)
            if result is not None:
                break
        except Exception as e:  # noqa: BLE001
            last_err = e
    if result is None:
        raise RuntimeError(f"LLM review failed after {LLM_RETRIES} tries: {last_err}")

    figure_targets: dict[int, list[int]] = {}
    raw_targets = result.get("figure_targets") or {}
    for fid_str, indices in raw_targets.items():
        try:
            fid = int(fid_str)
        except (ValueError, TypeError):
            continue
        valid = [i for i in indices if isinstance(i, int) and 0 <= i < len(chunks)]
        if valid:
            figure_targets[fid] = valid

    split_after = result.get("split_after") or []
    split_after = [i for i in split_after if isinstance(i, int)]

    return ReviewResult(
        figure_targets=figure_targets,
        split_after=split_after,
        reasoning=result.get("reasoning", ""),
    )


def review_window(
    window_chunks: list[dict],
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> dict:
    """对窗口内切片序列做一次 LLM 质量评审（合并/再切/位置检查）.

    Returns: {"actions": [...], "reasoning": "..."}（未解析/失败时抛异常由调用方兜底）
    """
    url = api_url if api_url is not None else LLM_API_URL
    key = api_key if api_key is not None else LLM_API_KEY
    mdl = model if model is not None else LLM_MODEL
    if not url or not key:
        raise RuntimeError("LLM_API_URL/LLM_API_KEY not configured")

    from .semantic_splitter import build_unit_listing, unit_preview

    parts = []
    for i, c in enumerate(window_chunks):
        content = c.get("content", "")
        len_no_figs = len(_IMG_TAG_RE.sub("", content))
        heading = c.get("title_path", "") or ""
        preview = content[:CHUNK_PREVIEW_CHARS].replace("\n", " ")
        parts.append(f"[{i}]（{len_no_figs}字）{heading} | {preview}")
        units, _ = build_unit_listing(content, find_code_block_ranges(content))
        unit_str = " | ".join(unit_preview(u, j) for j, u in enumerate(units)) or "(无)"
        parts.append(f"    单元: {unit_str}")

    prompt = WINDOW_PROMPT.format(chunks="\n".join(parts))
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    body = {
        "model": mdl,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1,
        "max_tokens": LLM_MAX_TOKENS,
    }

    result: Optional[dict] = None
    last_err: Optional[Exception] = None
    for _ in range(LLM_RETRIES):
        try:
            with httpx.Client(timeout=LLM_TIMEOUT, proxy=None) as client:
                resp = client.post(url, headers=headers, json=body)
                resp.raise_for_status()
            raw = resp.json()["choices"][0]["message"]["content"].strip()
            result = parse_json_response(raw)
            if result is not None:
                break
        except Exception as e:  # noqa: BLE001
            last_err = e
    if result is None:
        raise RuntimeError(f"window review failed after {LLM_RETRIES} tries: {last_err}")
    return result


def _apply_window_actions(
    win: list[dict],
    actions: list[dict],
    policy,
) -> list[dict]:
    """校验并应用窗口调整建议（merge/split），返回调整后的窗口切片列表.

    规则一致性校验：
    - merge：只允许相邻；合并后（去图）≤ hard_max；不同 merge 组不重叠
    - split：index 合法；切点经 apply_split_offsets 校验（代码块保护/过碎/超限）
    - 冲突：同一切片同时被 merge 与 split → 丢弃 split
    """
    from .semantic_splitter import apply_split_offsets, build_unit_listing

    if not actions:
        return win

    # ── 收集并校验 merge 组 ──
    merge_groups: list[list[int]] = []
    for act in actions:
        if not isinstance(act, dict) or act.get("type") != "merge":
            continue
        indices = act.get("indices") or []
        indices = [i for i in indices if isinstance(i, int) and 0 <= i < len(win)]
        if len(indices) < 2:
            continue
        indices = sorted(set(indices))
        if indices != list(range(indices[0], indices[-1] + 1)):
            continue  # 必须连续相邻
        # 合并后长度校验
        merged_len = sum(len(_IMG_TAG_RE.sub("", win[i].get("content", ""))) for i in indices)
        if merged_len > policy.hard_max_chars:
            continue
        # 与已有组不重叠
        if any(i in g for g in merge_groups for i in indices):
            continue
        merge_groups.append(indices)

    # ── 收集并校验 split ──
    split_plans: dict[int, list[int]] = {}
    for act in actions:
        if not isinstance(act, dict) or act.get("type") != "split":
            continue
        idx = act.get("index")
        split_after = act.get("split_after") or []
        if not isinstance(idx, int) or not 0 <= idx < len(win):
            continue
        if any(idx in g for g in merge_groups):
            continue  # 冲突：被 merge 的切片不 split
        split_after = [u for u in split_after if isinstance(u, int)]
        if split_after:
            split_plans[idx] = split_after

    if not merge_groups and not split_plans:
        return win

    # ── 应用：先生成中间结构（split 增加、merge 合并），再重建列表 ──
    # 简化：逐窗口内操作，使用局部标记
    merged_away: set[int] = set()  # 被合并掉的切片（非组首）
    for g in merge_groups:
        for i in g[1:]:
            merged_away.add(i)

    new_win: list[dict] = []
    for i, c in enumerate(win):
        if i in merged_away:
            continue
        # merge：组首合并后续内容
        for g in merge_groups:
            if g[0] == i:
                merged_content = "\n\n".join(
                    win[j].get("content", "").strip() for j in g
                )
                piece = dict(c)
                piece["content"] = merged_content
                piece["merge_reason"] = "window_merge"
                c = piece
                break
        new_win.append(c)

    # 重映射 split 索引（merge 后的新索引 ≠ 原索引）：先不做复杂映射，
    # 按原索引在 new_win 中查找 chunk_id 匹配
    if split_plans:
        for idx, split_after in split_plans.items():
            src = win[idx]
            target_pos = next(
                (n for n, c in enumerate(new_win) if c.get("chunk_id") == src.get("chunk_id")),
                None,
            )
            if target_pos is None:
                continue
            content = new_win[target_pos].get("content", "")
            code_ranges = find_code_block_ranges(content)
            units, _ = build_unit_listing(content, code_ranges)
            offsets = [units[u]["end"] for u in split_after if 0 <= u < len(units)]
            splits = apply_split_offsets(content, offsets, code_ranges, policy)
            if not splits or len(splits) < 2:
                continue
            new_pieces = []
            for k, (s, e, reason) in enumerate(splits):
                piece = dict(new_win[target_pos])
                piece["chunk_id"] = f"{piece.get('chunk_id', idx)}#{k}"
                piece["content"] = content[s:e].strip()
                piece["split_reason"] = reason
                new_pieces.append(piece)
            new_win[target_pos : target_pos + 1] = new_pieces

    return new_win


def review_and_bind(
    chunks: list[dict],
    figures: list[dict],
    enhanced_text: str,
    policy,
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> list[dict]:
    """规则粗切后：窗口级 LLM 质量评审（合并/再切/位置检查）→ 图归属.

    1. 切片按 WINDOW_SIZE 分组（窗口提供相邻上下文，可判断合并/边界问题）
    2. 每个窗口一次 LLM 调用（并发），输出 merge/split actions
    3. 应用 actions（规则校验：相邻合并、≤ hard_max、代码块保护、过碎拦截）
    4. 图归属（调整后的切片上，含图才调 + DB 缓存）
    """
    semantic_enabled = bool(getattr(policy, "semantic_split", False))

    # ── 1+2+3. 窗口评审与结构调整 ──
    if semantic_enabled and len(chunks) > 1:
        chunks = _window_review(chunks, policy, api_url, api_key, model)

    # ── 4. 图归属 ──
    if figures:
        chunks = _figure_binding(chunks, figures, enhanced_text, api_url, api_key, model)

    return chunks


def _embedding_presplit(chunks: list[dict], policy) -> list[dict]:
    """T3.7 接线：窗口 LLM 评审前，逐块尝试 embedding 断点检测直接切分.

    只对长度超过 ``policy.target_max_chars`` 的切片尝试（更短的切片本就不需要
    拆分，交给窗口评审判断是否合并）；命中 embedding 路径（满足
    hard_max_chars / MIN_VALID_CHUNK 约束，见 semantic_splitter.resolve_split）
    时零 LLM 调用直接采用切分结果，该切片不再需要窗口 LLM 判断"是否要切"；
    未命中（句子太少 / 无明显主题断点 / 切出的片超限）时原样保留，交由下面
    的窗口级 LLM 评审处理——行为与接线前完全一致，不引入新的失败模式。

    embed_fn 注入（817 待办第 8 项）：默认使用
    ``embedding_client.as_embed_fn()``（硅基流动 BAAI/bge-m3）；未配置
    EMBEDDING_API_URL/EMBEDDING_API_KEY 或调用失败时，该函数内部自动回落到
    ``semantic_splitter.tf_embed``，对本函数完全透明——接入前后行为一致。
    """
    embed_fn = as_embed_fn()
    result: list[dict] = []
    for c in chunks:
        content = c.get("content", "")
        plain_len = len(_IMG_TAG_RE.sub("", content))
        if plain_len <= policy.target_max_chars:
            result.append(c)
            continue
        splits = resolve_split(content, policy, embed_fn=embed_fn)
        if not splits or len(splits) < 2:
            result.append(c)
            continue
        base_id = c.get("chunk_id", "")
        logger.info(
            f"embedding presplit hit: chunk {base_id} ({plain_len} chars) "
            f"-> {len(splits)} pieces (LLM window review skipped for this chunk)"
        )
        for k, (s, e, reason) in enumerate(splits):
            piece = dict(c)
            piece["chunk_id"] = f"{base_id}#{k}"
            piece["content"] = content[s:e].strip()
            piece["split_reason"] = reason
            result.append(piece)
    return result


def _window_review(
    chunks: list[dict],
    policy,
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> list[dict]:
    """窗口化并发评审 + 从后往前应用 actions. """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    # T3.7: embedding 断点检测前置（零 LLM 调用）；命中的切片已经切好，
    # 不再进入下面的窗口级 LLM 评审要求它判断"是否要切"。
    chunks = _embedding_presplit(chunks, policy)

    starts = list(range(0, len(chunks), WINDOW_SIZE))
    windows = {s: chunks[s : s + WINDOW_SIZE] for s in starts}
    results: dict[int, dict] = {}

    with ThreadPoolExecutor(max_workers=min(REVIEW_CONCURRENCY, len(starts))) as pool:
        futures = {
            pool.submit(review_window, win, api_url, api_key, model): s
            for s, win in windows.items()
        }
        for fut in as_completed(futures):
            s = futures[fut]
            try:
                results[s] = fut.result()
                n_actions = len(results[s].get("actions", []))
                logger.info(f"window review @{s}: {n_actions} actions")
            except Exception as e:
                logger.warning(f"window review @{s} failed: {e}")

    # 从后往前应用（后面的窗口调整不影响前面窗口的切片位置）
    for s in sorted(results.keys(), reverse=True):
        actions = results[s].get("actions", []) or []
        if not actions:
            continue
        win = chunks[s : s + WINDOW_SIZE]
        new_win = _apply_window_actions(win, actions, policy)
        if len(new_win) != len(win):
            chunks[s : s + len(win)] = new_win
            logger.info(f"window @{s}: {len(win)} -> {len(new_win)} chunks")
    return chunks


def _figure_binding(
    chunks: list[dict],
    figures: list[dict],
    enhanced_text: str,
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> list[dict]:
    """图归属：含图切片必调（单切片上下文），DB 缓存命中则复用. """
    import json as _json

    from .utils.hash import content_hash

    contexts = build_figure_contexts(figures, chunks, enhanced_text)
    binding_results: list[BindingResult] = []

    for ctx in contexts:
        if not ctx.img_tag:
            logger.warning(f"Figure {ctx.figure_db_id}: no img tag found, skipping")
            continue
        # 缓存检查
        parts = []
        for idx in (ctx.prev_chunk_idx, ctx.current_chunk_idx, ctx.next_chunk_idx):
            if idx is not None and 0 <= idx < len(chunks):
                parts.append(chunks[idx]["content"])
        ctx_hash = content_hash("\n||\n".join(parts))
        targets: Optional[list[int]] = None
        if ctx.bound_context_hash == ctx_hash and ctx.bound_chunk_ids:
            try:
                stored = _json.loads(ctx.bound_chunk_ids)
                valid = [i for i in stored if isinstance(i, int) and 0 <= i < len(chunks)]
                if valid:
                    targets = valid
            except (ValueError, TypeError):
                pass
        if targets is None:
            try:
                result = review_slice(
                    [ctx], chunks, "", api_url, api_key, model
                )
                targets = result.figure_targets.get(ctx.figure_db_id)
                if not targets:
                    targets = [ctx.current_chunk_idx]
            except Exception as e:
                logger.warning(f"figure review {ctx.figure_db_id} failed: {e}")
                targets = [ctx.current_chunk_idx] if ctx.current_chunk_idx is not None else []
        binding_results.append(BindingResult(
            figure_db_id=ctx.figure_db_id,
            target_chunk_indices=targets,
            reasoning="cached" if targets and ctx.bound_context_hash == ctx_hash else "review",
        ))

    apply_figure_binding(chunks, figures, enhanced_text, binding_results)
    return chunks
