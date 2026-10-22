"""轻量知识检索 + 轻量生成器（对照演示自包含，§24.5）.

生成链路接入前，对照编排用本地轻量检索代替 Knowledge Core RAGFlow：
- 关键词切词打分（章节标题权重高）
- 同文档 top_k chunks
- 输出 REFERENCE KNOWLEDGE 文本块

接入真实 Generation Service 后，本模块可整体替换为 knowledge_core.retrieve(...)，
对照编排（comparison.py）保持不变。
"""
from __future__ import annotations

import re
from typing import Any

from app.core.database import db_session
from app.rule_engine.llm import llm
from app.core.config import settings

# 中文停用词（轻量；整词集合，含单字与双字词）
STOPWORDS = {
    "的", "了", "在", "是", "和", "就", "不", "都", "还", "有", "要", "会",
    "这", "那", "被", "把", "与", "及", "或", "它", "对", "等",
    "如果", "因为", "所以", "但是", "并且", "一个", "我们", "它们", "对于",
    "通过", "进行", "以及", "等等", "可以", "需要", "应该", "使用", "以及",
}

_CJK_RE = re.compile(r"[\u4e00-\u9fff]+")
_TOKEN_RE = re.compile(r"[A-Za-z0-9_\-\.]+")


def _tokens(text: str) -> list[str]:
    """中英混合切词：英文按词，中文按 2-gram 滑窗."""
    toks: list[str] = []
    for m in _TOKEN_RE.finditer(text):
        t = m.group(0).lower()
        if len(t) >= 2 and t not in STOPWORDS:
            toks.append(t)
    for seg in _CJK_RE.findall(text):
        if len(seg) == 1:
            continue
        for i in range(len(seg) - 1):
            bigram = seg[i : i + 2]
            if bigram not in STOPWORDS:
                toks.append(bigram)
    return toks


def retrieve_knowledge(task: str, document_ids: list[int] | None = None,
                       top_k: int = 8, max_chars: int = 12000) -> dict:
    """关键词打分检索（本地轻量版）. 返回 {text, chunks:[{...}]}."""
    task_toks = _tokens(task)
    if not task_toks:
        return {"text": "", "chunks": []}

    with db_session() as cur:
        if document_ids:
            placeholders = ",".join(["%s"] * len(document_ids))
            cur.execute(
                "SELECT id, document_id, chunk_index, section_title, content "
                "FROM knowledge_chunk WHERE status='active' "
                f"AND document_id IN ({placeholders}) AND content IS NOT NULL",
                tuple(document_ids),
            )
        else:
            cur.execute(
                "SELECT id, document_id, chunk_index, section_title, content "
                "FROM knowledge_chunk WHERE status='active' AND content IS NOT NULL"
            )
        rows = list(cur.fetchall())

    scored: list[tuple[float, dict]] = []
    for row in rows:
        content = (row.get("content") or "")
        title = (row.get("section_title") or "")
        title_toks = set(_tokens(title))
        content_toks = set(_tokens(content))
        score = 0.0
        for t in task_toks:
            if t in title_toks:
                score += 3.0  # 章节标题命中权重高
            if t in content_toks:
                score += 1.0
        if score > 0:
            scored.append((score, row))

    scored.sort(key=lambda x: (-x[0], x[1]["document_id"], x[1]["chunk_index"]))
    picked = scored[:top_k]

    blocks: list[str] = []
    chunks: list[dict] = []
    total = 0
    for score, row in picked:
        snippet = (row.get("content") or "").strip()
        if not snippet:
            continue
        header = f"### {row['section_title']}（doc#{row['document_id']}，相关度 {score:.0f}）"
        blocks.append(f"{header}\n{snippet}")
        total += len(snippet)
        chunks.append({
            "chunk_id": row["id"],
            "document_id": row["document_id"],
            "section_title": row.get("section_title"),
            "score": score,
            "chars": len(snippet),
        })
        if total >= max_chars:
            break

    return {
        "text": "\n\n".join(blocks),
        "chunks": chunks,
    }


# ── 轻量生成器（对照演示用；接入真实 Generation Service 后替换）────────────

GENERATE_SYSTEM = (
    "你是一位资深的行业培训设计师。请根据【参考资料】撰写培训内容，"
    "结构完整（背景/目标/步骤/注意事项），语言专业、可直接用于培训材料。"
    "只输出正文，不要输出解释。"
)

GENERATE_SYSTEM_CONSTRAINED = (
    "你是一位资深的行业培训设计师。请根据【参考资料】撰写培训内容，"
    "结构完整（背景/目标/步骤/注意事项），语言专业、可直接用于培训材料。\n"
    "同时，你必须严格遵守【强制领域规则】区块中的全部 MUST 要求、"
    "并避免 MUST_NOT 禁止的行为。这些约束来自领域规范，不得遗漏或违反。\n"
    "只输出正文，不要输出解释。"
)


def format_knowledge_block(knowledge_text: str) -> str:
    return f"【REFERENCE KNOWLEDGE 参考资料】\n{knowledge_text}"


def format_constraint_block(constraints: list) -> str:
    lines = ["【HARD CONSTRAINTS 强制领域规则（来自领域规范，MUST/MUST_NOT 不得遗漏或违反）】"]
    for c in constraints:
        lines.append(f"- [{c.rule_code}] {c.type}：{c.content}"
                     + (f"（来源：{c.source}）" if c.source else ""))
    return "\n".join(lines)


async def generate_content(task: str, knowledge_text: str,
                           constraints: list | None = None) -> str:
    """轻量生成：A 臂 constraints=None，B 臂 constraints=约束列表."""
    if constraints:
        system = GENERATE_SYSTEM_CONSTRAINED
        user_prompt = (
            f"{format_knowledge_block(knowledge_text)}\n\n"
            f"{format_constraint_block(constraints)}\n\n"
            f"【任务】{task}\n\n请撰写培训内容。"
        )
    else:
        system = GENERATE_SYSTEM
        user_prompt = (
            f"{format_knowledge_block(knowledge_text)}\n\n"
            f"【任务】{task}\n\n请撰写培训内容。"
        )
    content = await llm.complete(
        system=system,
        prompt=user_prompt,
        temperature=0.3,
        max_tokens=settings.GENERATE_MAX_TOKENS,
    )
    return content or ""
