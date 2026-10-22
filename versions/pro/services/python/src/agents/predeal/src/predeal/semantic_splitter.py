"""语义辅助切分工具库（LLM 调用已合并进 figure_chunk_binder 的统一切片评审）.

设计演进（2026）：
- 初版：semantic_splitter 独立调 LLM（每个超长段一次调用）
- 现状：为节约 token，LLM 调用统一由 figure_chunk_binder 的切片评审执行
  （同一切片同时需要图归属 + 语义切分时，一次调用完成两个任务）。
  本模块保留纯函数工具：单元化 / 切分校验 / JSON 宽松解析 / 单元列表构建。

触发链（chunk_compiler）：
  规则切分 → binder 切片评审（LLM：图归属 + 超长再切，同一切片一次调用）
    → 段落安全切分（规则兜底，无 LLM 时）
    → 安全点硬切（最后兜底）
"""

from __future__ import annotations

import json
import logging
import re
import statistics
from typing import Callable, Optional

from .config import ChunkPolicy
from .utils.markdown import find_code_block_ranges, is_in_code_block

logger = logging.getLogger(__name__)

EmbeddingFn = Callable[[str], dict]

# 单元/切片尺寸约束
UNIT_MAX_CHARS = 300      # 语义单元上限（LLM 看到的粒度）
MIN_VALID_CHUNK = 200     # 低于此长度的片合并/丢弃（防过碎，≈ target_min 的 2/3）

SPLIT_TASK_PROMPT = """任务2（语义切分检查）：请判断当前切片是否需要按【语义边界】进一步切分。

语义单元列表（代码块整体是一个单元，不可切开）：
{units}

判断规则：
- 若切片内部存在明显的主题断裂（两个独立主题/概念被拼在一起，且各自内容完整）→ 在断裂处切分
- 若切片主题连贯、内容完整 → 返回空数组 []
- 切分后每片目标 300~1200 字，不超过 1800 字；代码块单元不能切开
- 只输出 JSON，不要输出任何分析或思考过程"""


# ── 单元化：把超长段切成 LLM 可读的语义单元 ──────────────────────────────


def split_into_units(text: str, code_ranges: list[tuple[int, int]]) -> list[dict]:
    """把文本切成语义单元（代码块整体一个单元，普通文本按段落/句子），
    返回 [{start, end, text, is_code}]，偏移基于 text 原文。"""
    units: list[dict] = []
    n = len(text)
    i = 0

    # 代码块整体为一个单元
    for (cs, ce) in code_ranges:
        if cs > i:
            _split_prose(text, i, cs, units)
        units.append({"start": cs, "end": ce, "text": text[cs:ce], "is_code": True})
        i = ce
    if i < n:
        _split_prose(text, i, n, units)
    return units


def _split_prose(text: str, start: int, end: int, units: list[dict]) -> None:
    """普通文本按段落（空行）切；段落超长的再按句子（。！？；）切。"""
    seg = text[start:end]
    # 段落边界：\n\n+
    para_starts = [0]
    for m in re.finditer(r"\n\s*\n", seg):
        para_starts.append(m.end())
    para_ends = para_starts[1:] + [len(seg)]
    for ps, pe in zip(para_starts, para_ends):
        p = seg[ps:pe].strip()
        if not p:
            continue
        if len(p) <= UNIT_MAX_CHARS:
            units.append({"start": start + ps, "end": start + pe, "text": p, "is_code": False})
        else:
            # 按句子切分
            sent_starts = [0]
            for m in re.finditer(r"[。！？；]\s*", p):
                sent_starts.append(m.end())
            for si, ss in enumerate(sent_starts):
                se = sent_starts[si + 1] if si + 1 < len(sent_starts) else len(p)
                s = p[ss:se].strip()
                if s:
                    units.append(
                        {"start": start + ps + ss, "end": start + ps + se,
                         "text": s, "is_code": False}
                    )


def unit_preview(unit: dict, idx: int) -> str:
    tag = " [code]" if unit["is_code"] else ""
    preview = unit["text"][:50].replace("\n", " ")
    return f"[{idx}]（{len(unit['text'])}字）{preview}{tag}"


def build_unit_listing(text: str, code_ranges: list[tuple[int, int]]) -> tuple[list[dict], str]:
    """构建语义单元列表 + prompt 文本（供切片评审的 split 任务使用）. """
    units = split_into_units(text, code_ranges)
    listing = "\n".join(unit_preview(u, i) for i, u in enumerate(units))
    return units, listing


# ── 切分校验：LLM 建议 → 合法切片偏移 ────────────────────────────────────


def apply_split_offsets(
    text: str,
    split_offsets: list[int],
    code_ranges: list[tuple[int, int]],
    policy: ChunkPolicy,
) -> Optional[list[tuple[int, int, str]]]:
    """把 LLM 的切分偏移转成合法切片：代码块保护 / 过碎合并 / 超限重切.

    Returns:
        [(start, end, reason), ...] 或 None（无有效切分）
    """
    if not split_offsets:
        return None
    offsets = sorted(set(split_offsets))
    if offsets[-1] >= len(text):
        offsets = [o for o in offsets if o < len(text)]

    # 代码块内切点移除（代码块整体不可切）
    offsets = [o for o in offsets if not is_in_code_block(o, code_ranges)]
    if not offsets:
        return None

    # 过碎防御：距文本头部/上一片边界太近的切点直接丢弃（避免 < MIN_VALID_CHUNK 的碎片）
    offsets = [o for o in offsets if o >= MIN_VALID_CHUNK]
    if not offsets:
        return None

    bounds = [0] + offsets + [len(text)]
    splits: list[tuple[int, int, str]] = []
    for i in range(len(bounds) - 1):
        s, e = bounds[i], bounds[i + 1]
        splits.append((s, e, "semantic_split"))

    # 过碎合并：任意短片（< MIN_VALID_CHUNK）并入前一片；首片过短已被切点
    # 过滤拦截，此处兜底中间片/末片（合并后不超 hard_max 由下方重切保证）
    merged: list[tuple[int, int, str]] = []
    for s, e, reason in splits:
        if merged and e - s < MIN_VALID_CHUNK:
            ps, pe, _ = merged.pop()
            merged.append((ps, e, reason))
        else:
            merged.append((s, e, reason))
    splits = merged

    # 超限防御：LLM 建议导致的超长片用安全点再切（永不切代码块）
    final: list[tuple[int, int, str]] = []
    for s, e, reason in splits:
        if e - s <= policy.hard_max_chars:
            final.append((s, e, reason))
            continue
        from .steps.section_splitter import _force_split_at_safe_points

        sub = _force_split_at_safe_points(text[s:e], policy.hard_max_chars, code_ranges)
        if len(sub) < 2:
            final.append((s, e, reason))
        else:
            for ss, se, sr in sub:
                final.append((s + ss, s + se, f"semantic_split+{sr}"))
    return final if len(final) >= 2 else None


# ── JSON 宽松解析（供 binder 复用同一套容错） ─────────────────────────────


def parse_json_response(raw: str) -> Optional[dict]:
    """宽松解析 LLM 的 JSON 响应：直接解析 → ```json 块 → 首尾 { } 提取."""
    if not raw:
        return None
    candidates = []
    # 1. 直接解析
    candidates.append(raw)
    # 2. ```json 代码块
    if "```" in raw:
        parts = raw.split("```")
        if len(parts) >= 3:
            block = parts[1]
            if block.startswith("json"):
                block = block[4:]
            candidates.append(block.strip())
    # 3. 首尾 { } 提取（容忍前后废话/截断标记）
    s, e = raw.find("{"), raw.rfind("}")
    if s != -1 and e > s:
        candidates.append(raw[s : e + 1])
    for c in candidates:
        try:
            parsed = json.loads(c)
            if isinstance(parsed, dict):
                return parsed
        except (ValueError, TypeError):
            continue
    return None


# ── T3.7: embedding 断点检测（LLM 切分前置） ─────────────────────────────
#
# 目标：超长段落切分前先尝试"逐句 embedding 相邻相似度"检测语义断点；命中且
# 满足尺寸约束时直接采用，零 LLM 调用；不满足时回落现有 LLM 路径（binder 的
# 统一切片评审）。真实 embedding 服务可通过 embed_fn 参数注入替换默认的 TF
# 余弦占位实现，无需改动本模块其余逻辑。

_SENTENCE_END_RE = re.compile(r"[。！？；\n]+")


def split_sentences(text: str) -> list[str]:
    """按句末标点（。！？；\\n）切句，供 embedding 断点检测 / QC 复用。"""
    sentences, _ = _split_sentences_with_offsets(text)
    return sentences


def _split_sentences_with_offsets(text: str) -> tuple[list[str], list[int]]:
    """句子列表 + 每句在原文中的起始偏移（用于把断点映射回字符位置）。"""
    sentences: list[str] = []
    offsets: list[int] = []
    start = 0
    for m in _SENTENCE_END_RE.finditer(text):
        end = m.end()
        seg = text[start:end]
        if seg.strip():
            sentences.append(seg)
            offsets.append(start)
        start = end
    if start < len(text):
        tail = text[start:]
        if tail.strip():
            sentences.append(tail)
            offsets.append(start)
    return sentences, offsets


def tf_embed(text: str) -> dict:
    """占位 embedding：字符 bigram 词频向量（中文无空格，用 2-gram 近似语义）。

    真实实现可替换（见 try_embedding_split / _embedding_breakpoints 的
    embed_fn 参数），接口保持 ``str -> dict[str, float]`` 不变即可接入。
    """
    cleaned = text.strip()
    if not cleaned:
        return {}
    if len(cleaned) < 2:
        grams = [cleaned]
    else:
        grams = [cleaned[i:i + 2] for i in range(len(cleaned) - 1)]
    vec: dict[str, float] = {}
    for g in grams:
        vec[g] = vec.get(g, 0.0) + 1.0
    total = float(len(grams))
    return {k: v / total for k, v in vec.items()}


def cosine_similarity(vec_a: dict, vec_b: dict) -> float:
    """稀疏向量（dict）余弦相似度，任一为空返回 0.0。"""
    if not vec_a or not vec_b:
        return 0.0
    # iterate the smaller dict for speed
    if len(vec_a) > len(vec_b):
        vec_a, vec_b = vec_b, vec_a
    dot = sum(v * vec_b.get(k, 0.0) for k, v in vec_a.items())
    norm_a = statistics.fsum(v * v for v in vec_a.values()) ** 0.5
    norm_b = statistics.fsum(v * v for v in vec_b.values()) ** 0.5
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


# 两条路径的命中计数（日志/测试观测用）
SPLIT_PATH_COUNTS: dict[str, int] = {"embedding": 0, "llm": 0}


def _record_split_path(path: str) -> None:
    SPLIT_PATH_COUNTS[path] = SPLIT_PATH_COUNTS.get(path, 0) + 1
    logger.info(
        "semantic split path=%s (embedding=%d, llm=%d)",
        path, SPLIT_PATH_COUNTS.get("embedding", 0), SPLIT_PATH_COUNTS.get("llm", 0),
    )


def _embedding_breakpoints(text: str, embed_fn: Optional[EmbeddingFn] = None) -> list[int]:
    """逐句 embedding，相邻相似度低于 (mean - std) 处为候选切点。

    返回候选切点在 ``text`` 中的字符偏移列表（切点即下一句的起始位置）。
    句子数 < 3 时无法计算有意义的均值/方差，直接返回 []。
    """
    fn = embed_fn or tf_embed
    sentences, offsets = _split_sentences_with_offsets(text)
    if len(sentences) < 3:
        return []

    vectors = [fn(s) for s in sentences]
    sims = [
        cosine_similarity(vectors[i], vectors[i + 1])
        for i in range(len(vectors) - 1)
    ]
    if not sims:
        return []

    mean = statistics.fmean(sims)
    std = statistics.pstdev(sims) if len(sims) > 1 else 0.0
    threshold = mean - std

    return [offsets[i + 1] for i, sim in enumerate(sims) if sim < threshold]


def try_embedding_split(
    text: str,
    policy: ChunkPolicy,
    code_ranges: Optional[list[tuple[int, int]]] = None,
    embed_fn: Optional[EmbeddingFn] = None,
) -> Optional[list[tuple[int, int, str]]]:
    """尝试用 embedding 断点直接切分（跳过 LLM）.

    仅当所有候选切点都落在合法约束内（不在代码块内、每片长度介于
    MIN_VALID_CHUNK 与 policy.hard_max_chars 之间）才采用；否则返回 None，
    交由调用方回落现有 LLM 路径。命中/未命中都会记入 SPLIT_PATH_COUNTS。
    """
    if code_ranges is None:
        code_ranges = find_code_block_ranges(text)

    breakpoints = _embedding_breakpoints(text, embed_fn=embed_fn)
    breakpoints = sorted(
        {b for b in breakpoints if not is_in_code_block(b, code_ranges)}
    )
    if not breakpoints:
        _record_split_path("llm")
        return None

    bounds = [0] + breakpoints + [len(text)]
    pieces = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]

    for s, e in pieces:
        length = e - s
        if length < MIN_VALID_CHUNK or length > policy.hard_max_chars:
            _record_split_path("llm")
            return None

    _record_split_path("embedding")
    return [(s, e, "embedding_split") for s, e in pieces]


def resolve_split(
    text: str,
    policy: ChunkPolicy,
    code_ranges: Optional[list[tuple[int, int]]] = None,
    llm_fallback: Optional[Callable[[str], Optional[list[tuple[int, int, str]]]]] = None,
    embed_fn: Optional[EmbeddingFn] = None,
) -> Optional[list[tuple[int, int, str]]]:
    """语义切分统一入口：先尝试 embedding 断点检测（零 LLM 调用）；不满足
    约束时才回落 ``llm_fallback``（未提供时返回 None，由调用方决定兜底）。
    """
    result = try_embedding_split(text, policy, code_ranges=code_ranges, embed_fn=embed_fn)
    if result is not None:
        return result
    if llm_fallback is not None:
        return llm_fallback(text)
    return None
