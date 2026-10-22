"""Category classifier — assign knowledge chunks to knowledge points via LLM.

Uses an OpenAI-compatible API to classify each chunk into one or more
knowledge_category nodes (level 3, node_type = "knowledge_point").
Results are written to knowledge_chunk_category.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Optional

import httpx
import pymysql
from pymysql.cursors import DictCursor

logger = logging.getLogger(__name__)

# LLM configuration
LLM_API_URL = os.environ.get("LLM_API_URL")
LLM_API_KEY = os.environ.get("LLM_API_KEY")
LLM_MODEL = os.environ.get("LLM_MODEL", "deepseek-chat")

# MySQL connection (shared pattern)
MYSQL_CONFIG = {
    "host": os.environ.get("MYSQL_HOST"),
    "port": int(os.environ.get("MYSQL_PORT", 3306)),
    "user": os.environ.get("MYSQL_USER"),
    "password": os.environ.get("MYSQL_PASSWORD"),
    "database": os.environ.get("MYSQL_DATABASE"),
    "charset": "utf8mb4",
    "cursorclass": DictCursor,
}


def _get_connection() -> pymysql.Connection:
    return pymysql.connect(**MYSQL_CONFIG)


# ── Category tree loading ──────────────────────────────────────────────────


@dataclass
class CategoryNode:
    id: int
    parent_id: int
    node_code: str
    name: str
    description: str
    level: int
    node_type: str


def get_domain_db_id(domain_code: str) -> Optional[int]:
    """Look up knowledge_domain.id by code."""
    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT id FROM knowledge_domain WHERE code = %s",
                (domain_code,),
            )
            row = cursor.fetchone()
            return row["id"] if row else None
    finally:
        conn.close()


def load_category_tree(domain_id: int) -> list[CategoryNode]:
    """Load all knowledge_category rows for a domain, ordered by level and sort_order."""
    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT id, parent_id, node_code, name, description, level, node_type "
                "FROM knowledge_category WHERE domain_id = %s AND status = 1 "
                "ORDER BY level, sort_order",
                (domain_id,),
            )
            return [CategoryNode(**row) for row in cursor.fetchall()]
    finally:
        conn.close()


def build_category_prompt(nodes: list[CategoryNode]) -> str:
    """Build a compact representation of the category tree for the LLM prompt."""
    lines = ["以下是知识点目录树：\n"]
    for n in nodes:
        indent = "  " * (n.level - 1)
        desc = f" — {n.description}" if n.description else ""
        lines.append(f"{indent}[{n.id}] {n.name}{desc}")
    return "\n".join(lines)


# ── LLM classification ────────────────────────────────────────────────────


@dataclass
class ClassificationResult:
    chunk_id: str
    category_ids: list[int]
    confidence: float
    reasoning: str


CLASSIFICATION_PROMPT = """你是一个知识分类专家。请根据以下切片内容，将其归类到最合适的一个或多个知识点。

{category_tree}

请分析以下切片内容，返回最匹配的知识点 ID 列表。

切片标题路径：{title_path}
切片内容：
{content}

请严格返回以下 JSON 格式，不要返回其他内容：
{{"category_ids": [知识点ID1, 知识点ID2], "confidence": 0.0到1.0之间的置信度, "reasoning": "简要说明分类理由"}}

注意：
- category_ids 必须是上方目录树中 [数字] 标注的 ID
- 必须选择最具体的叶子节点（level 最大的知识点）
- 一个切片只归到 1 个最匹配的知识点
- 【禁止】将切片归到章节节点（level 1/2 的 category 节点），包括章节首页/综述、本章小结、习题、参考文献等章节级内容——这类切片不与任何知识点直接匹配，应返回空列表 []
- 如果内容属于某个章节下的主题，但目录树中没有对应知识点节点，返回空列表 []（不要用章节节点兜底）
- 如果内容与任何知识点都不匹配，返回空列表 []"""


def classify_chunk(
    content: str,
    title_path: str,
    category_tree: str,
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> ClassificationResult:
    """Call LLM to classify a single chunk."""
    url = api_url or LLM_API_URL
    key = api_key or LLM_API_KEY
    mdl = model or LLM_MODEL

    prompt = CLASSIFICATION_PROMPT.format(
        category_tree=category_tree,
        title_path=title_path,
        content=content[:3000],  # Truncate to avoid token limit
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

    # Parse JSON from response (handle markdown code blocks)
    if "```" in text:
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()

    result = json.loads(text)
    return ClassificationResult(
        chunk_id="",
        category_ids=result.get("category_ids", []),
        confidence=float(result.get("confidence", 0.0)),
        reasoning=result.get("reasoning", ""),
    )


# ── Database write ─────────────────────────────────────────────────────────


def save_chunk_categories(
    chunk_db_id: int,
    category_ids: list[int],
    confidence: float,
    source: str = "llm",
) -> None:
    """Insert classification results into knowledge_chunk_category.

    约定：一个切片只允许分配到一个知识点（单归属）——只取 category_ids 的第一个。
    """
    if not category_ids:
        return

    # 单归属约束：只保留最匹配的第一个知识点
    primary_id = category_ids[0]

    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            # Delete existing classifications for this chunk
            cursor.execute(
                "DELETE FROM knowledge_chunk_category WHERE chunk_id = %s",
                (chunk_db_id,),
            )

            # Insert single classification
            cursor.execute(
                "INSERT INTO knowledge_chunk_category "
                "(chunk_id, category_id, relation_type, confidence, source) "
                "VALUES (%s, %s, %s, %s, %s)",
                (chunk_db_id, primary_id, "classified", confidence, source),
            )
            conn.commit()
    finally:
        conn.close()


# ── Main entry point ───────────────────────────────────────────────────────


def get_chunks_without_category(document_db_id: int) -> list[dict]:
    """Fetch active chunks of a document that have no category classification yet.

    This is the incremental/retry-safe worklist: only chunks that were newly
    inserted, had their content changed (classifications cleared), or whose
    previous classification failed will show up here. Unchanged chunks are
    skipped entirely — no LLM calls are repeated.
    """
    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT kc.id AS db_id, kc.chunk_code AS chunk_id, kc.content, "
                "       kc.title_path, kc.section_title "
                "FROM knowledge_chunk kc "
                "LEFT JOIN knowledge_chunk_category kcc ON kcc.chunk_id = kc.id "
                "WHERE kc.document_id = %s AND kc.status = 'active' "
                "  AND kcc.id IS NULL "
                "ORDER BY kc.chunk_index",
                (document_db_id,),
            )
            return cursor.fetchall()
    finally:
        conn.close()


def count_chunks_without_category(document_db_id: int) -> int:
    """Count active chunks of a document lacking classifications (cheap check)."""
    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT COUNT(*) AS c FROM knowledge_chunk kc "
                "LEFT JOIN knowledge_chunk_category kcc ON kcc.chunk_id = kc.id "
                "WHERE kc.document_id = %s AND kc.status = 'active' AND kcc.id IS NULL",
                (document_db_id,),
            )
            return cursor.fetchone()["c"]
    finally:
        conn.close()


def classify_missing_for_document(
    document_db_id: int,
    domain_id: int,
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> list[ClassificationResult]:
    """Classify only the chunks of a document that lack classifications.

    Covers: newly inserted chunks, chunks whose content changed, and chunks
    whose previous LLM classification failed (they remain unclassified, so the
    next run retries them naturally). Chunks already classified are untouched.
    """
    worklist = get_chunks_without_category(document_db_id)
    if not worklist:
        return []

    return classify_chunks(
        [dict(w) for w in worklist],
        domain_id,
        api_url=api_url,
        api_key=api_key,
        model=model,
    )


def classify_chunks(
    chunks: list[dict],
    domain_id: int,
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> list[ClassificationResult]:
    """Classify all chunks into knowledge categories.

    Args:
        chunks: List of dicts with keys:
            - chunk_id: str (internal ID like "chunk_000001")
            - db_id: int (knowledge_chunk.id in MySQL)
            - content: str
            - title_path: str
        domain_id: knowledge_domain.id (numeric)

    Returns:
        List of ClassificationResult
    """

    # Load category tree
    nodes = load_category_tree(domain_id)
    if not nodes:
        logger.warning("No categories found")
        return []

    category_tree = build_category_prompt(nodes)
    logger.info(f"Loaded {len(nodes)} categories for domain {domain_id}")

    results = []
    for chunk in chunks:
        try:
            result = classify_chunk(
                content=chunk["content"],
                title_path=chunk.get("title_path", ""),
                category_tree=category_tree,
                api_url=api_url,
                api_key=api_key,
                model=model,
            )
            result.chunk_id = chunk["chunk_id"]

            # Save to database
            if result.category_ids and chunk.get("db_id"):
                save_chunk_categories(
                    chunk_db_id=chunk["db_id"],
                    category_ids=result.category_ids,
                    confidence=result.confidence,
                )

            results.append(result)
            logger.info(
                f"Chunk {chunk['chunk_id']}: "
                f"categories={result.category_ids}, "
                f"confidence={result.confidence:.2f}"
            )

        except Exception as e:
            logger.error(f"Failed to classify chunk {chunk['chunk_id']}: {e}")
            results.append(ClassificationResult(
                chunk_id=chunk["chunk_id"],
                category_ids=[],
                confidence=0.0,
                reasoning=f"Error: {e}",
            ))

    return results
