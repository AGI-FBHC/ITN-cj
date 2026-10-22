"""文档切片读取（Rule Pipeline 输入源，§8.1）.

直接从 knowledge_document + knowledge_chunk 读取，不重新解析 PDF。
去重策略（用户要求）：
1. 只取 status='active' 的切片（排除 superseded 旧版本）
2. 同文档内按 content_hash 去重（同文不同 index 只取一次）
3. 同文档内按 content 全文 SHA-256 二次去重（兜底 content_hash 缺失/不一致）
4. 空切片跳过
"""
from __future__ import annotations

import hashlib

from app.core.database import db_session

RULE_CANDIDATE_KEYWORDS = (
    "必须", "不得", "禁止", "严禁", "应当", "应该", "应", "须",
    "不得超过", "至少", "不低于", "不高于", "超过", "低于",
    "如果", "若", "只有", "之前", "之后",
)


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def list_documents(status: str | None = "uploaded") -> list[dict]:
    with db_session() as cur:
        if status:
            cur.execute(
                "SELECT id, document_code, title, source_name, status "
                "FROM knowledge_document WHERE status=%s ORDER BY id",
                (status,),
            )
        else:
            cur.execute(
                "SELECT id, document_code, title, source_name, status "
                "FROM knowledge_document ORDER BY id"
            )
        return list(cur.fetchall())


def get_document(document_id: int) -> dict | None:
    with db_session() as cur:
        cur.execute(
            "SELECT id, document_code, title, source_name, status "
            "FROM knowledge_document WHERE id=%s",
            (document_id,),
        )
        return cur.fetchone()


def iter_chunks(document_id: int, only_rule_candidates: bool = True) -> list[dict]:
    """读取文档的 active 切片并去重.

    返回字段：chunk_id, chunk_index, section_title, content, dedup_key
    """
    with db_session() as cur:
        cur.execute(
            "SELECT id, chunk_index, section_title, content, content_hash "
            "FROM knowledge_chunk "
            "WHERE document_id=%s AND status='active' AND content IS NOT NULL "
            "ORDER BY chunk_index, id",
            (document_id,),
        )
        rows = list(cur.fetchall())

    seen_hash: set[str] = set()
    seen_text: set[str] = set()
    result: list[dict] = []
    dropped_superseded = 0
    dropped_dup_hash = 0
    dropped_dup_text = 0
    dropped_empty = 0

    for row in rows:
        content = (row.get("content") or "").strip()
        if not content:
            dropped_empty += 1
            continue

        # 去重 1：content_hash
        h = row.get("content_hash") or _content_hash(content)
        if h in seen_hash:
            dropped_dup_hash += 1
            continue

        # 去重 2：全文 SHA-256 兜底
        th = _content_hash(content)
        if th in seen_text:
            dropped_dup_text += 1
            continue

        # 候选过滤：只保留含规则关键词的切片（§8.2，关键词只做候选）
        if only_rule_candidates and not any(k in content for k in RULE_CANDIDATE_KEYWORDS):
            continue

        seen_hash.add(h)
        seen_text.add(th)
        result.append({
            "chunk_id": row["id"],
            "chunk_index": row["chunk_index"],
            "section_title": row.get("section_title") or "",
            "content": content,
            "dedup_key": th,
        })

    iter_chunks.stats = {  # type: ignore[attr-defined]
        "total_active": len(rows),
        "dropped_empty": dropped_empty,
        "dropped_dup_hash": dropped_dup_hash,
        "dropped_dup_text": dropped_dup_text,
        "kept": len(result),
    }
    return result


def dedup_report(document_id: int) -> dict:
    iter_chunks(document_id)  # type: ignore[misc]
    return dict(getattr(iter_chunks, "stats", {}))  # type: ignore[attr-defined]
