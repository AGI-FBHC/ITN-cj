"""T3.1 一次 LLM 通道 — chunk enrichment (轴心).

Replaces the classification-only LLM call (``category_classifier.py``) with a
single per-chunk LLM call that produces, in one JSON response:

- ``category_ids`` / ``confidence``  — same contract as before, still written
  to ``knowledge_chunk_category`` so existing consumers (retrieval, decision
  service, etc.) keep working unchanged.
- ``defines`` / ``uses``             — concept extraction (consumed by T3.2's
  evidence-driven prerequisite edges).
- ``context_prefix`` / ``questions`` — retrieval-time text augmentation,
  consumed by ``ragflow_packager2._chunk_ragflow_text``.
- ``near_duplicate_hint``            — T3.5 dedup signal.
- ``asset_summary``                  — T3.6 (folded into this task): a short
  summary emitted only for chunks containing code/tables, also injected into
  the packaged RAGFlow text.

All of the above (except category_ids/confidence) is written to
``knowledge_chunk_enrichment``.

Caching (idempotency): ``content_hash`` is the cache key. A chunk is skipped
entirely (zero LLM calls) when ``knowledge_chunk_enrichment.content_hash``
already matches ``knowledge_chunk.content_hash`` for that row *and* it
already has a category classification. ``chunk_repository.sync_chunks``
gives ``inserted``/``updated`` chunks a fresh content_hash, so only those
(plus any chunk that lost its classification) show up in the work list
built by :func:`get_chunks_needing_enrichment` — ``unchanged`` chunks are
immune (E2 增量传播).
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Optional

import httpx
import pymysql
from pymysql.cursors import DictCursor

from .. import category_classifier as classifier
from ..embedding_client import EmbeddingClient, get_default_client
from ..semantic_splitter import cosine_similarity
from ..utils.hash import content_hash as _content_hash

logger = logging.getLogger(__name__)

# LLM configuration (same env vars as category_classifier — one shared LLM channel)
LLM_API_URL = os.environ.get("LLM_API_URL")
LLM_API_KEY = os.environ.get("LLM_API_KEY")
LLM_MODEL = os.environ.get("LLM_MODEL", "deepseek-chat")

MYSQL_CONFIG = {
    "host": os.environ.get("MYSQL_HOST"),
    "port": int(os.environ.get("MYSQL_PORT", 3306)),
    "user": os.environ.get("MYSQL_USER"),
    "password": os.environ.get("MYSQL_PASSWORD"),
    "database": os.environ.get("MYSQL_DATABASE"),
    "charset": "utf8mb4",
    "cursorclass": DictCursor,
    "connect_timeout": 15,
}

# T3.5：判定同文档近重复的最小文本相似度（近重复提示 + 内容相似度双重确认）
DUPLICATE_SIMILARITY_THRESHOLD = 0.90
# 817 待办第 8 项：embedding 可用时改用余弦相似度判重（阈值高于文本相似度，
# 因为真实语义向量对"表述不同但同义"的文本也会给出较高相似度）
EMBEDDING_DUPLICATE_THRESHOLD = 0.95


def _get_connection() -> pymysql.Connection:
    return pymysql.connect(**MYSQL_CONFIG)


# ── Result type ──────────────────────────────────────────────────────────────


@dataclass
class EnrichmentResult:
    chunk_id: str
    db_id: Optional[int] = None
    category_ids: list[int] = field(default_factory=list)
    confidence: float = 0.0
    defines: list[str] = field(default_factory=list)
    uses: list[str] = field(default_factory=list)
    context_prefix: str = ""
    questions: list[str] = field(default_factory=list)
    near_duplicate_hint: bool = False
    asset_summary: str = ""
    error: Optional[str] = None


# ── LLM prompt / call ─────────────────────────────────────────────────────────

ENRICHMENT_PROMPT = """你是一个知识库切片理解专家。请阅读以下切片内容，一次性完成分类、概念抽取与检索增强信息生成。

{category_tree}

切片标题路径：{title_path}
切片内容：
{content}

请严格按以下 JSON 格式输出，不要输出任何多余文字：
{{"category_ids": [知识点ID], "confidence": 0.0到1.0之间的置信度, "defines": ["本块定义的概念"], "uses": ["本块引用/依赖的概念"], "context_prefix": "一句话：本块在全文的位置与主题", "questions": ["该块能回答的问题1", "问题2"], "near_duplicate_hint": false, "asset_summary": "仅当含代码/表格时输出摘要，否则给空字符串"}}

注意：
- category_ids 规则与分类任务一致：只选最具体的叶子知识点，一个切片最多归到 1 个，无匹配则返回空列表 []
- 【禁止】把切片归到章节节点（level 1/2 的 category 节点），包括章节首页/综述、本章小结、习题、参考文献等章节级内容
- defines/uses 是概念短语列表，找不到就给空数组 []
- context_prefix 用一句话说明本块在全文中的位置与主题，便于检索时理解上下文
- questions 给出 1-3 个该切片能够直接回答的问题
- near_duplicate_hint 仅当你判断本块与常见样板/重复内容高度相似时为 true，否则为 false
- asset_summary 仅当切片含代码块或表格时填写一句话摘要，否则给空字符串 """


def build_enrichment_prompt(content: str, title_path: str, category_tree: str) -> str:
    return ENRICHMENT_PROMPT.format(
        category_tree=category_tree,
        title_path=title_path,
        content=content[:3000],
    )


def call_llm_enrich(
    content: str,
    title_path: str,
    category_tree: str,
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> dict:
    """Call the LLM once and return the parsed JSON dict. Raises on failure."""
    url = api_url or LLM_API_URL
    key = api_key or LLM_API_KEY
    mdl = model or LLM_MODEL

    prompt = build_enrichment_prompt(content, title_path, category_tree)

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

    return json.loads(text)


# ── Database: worklist / save / read ──────────────────────────────────────────


def get_chunks_needing_enrichment(document_db_id: int) -> list[dict]:
    """Active chunks that need a (re-)enrichment call.

    A chunk shows up here when either:
    - it has no enrichment row yet, or its stored content_hash is stale
      (content changed since the last successful enrichment), or
    - it has no category classification yet (covers the pre-T3.1 self-heal
      scenario where only knowledge_chunk_category lost a row).

    Chunks that are fully up to date on both fronts are never returned —
    this is what makes re-runs zero-LLM-call idempotent.
    """
    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT kc.id AS db_id, kc.chunk_code AS chunk_id, kc.content, "
                "       kc.content_hash, kc.title_path, kc.section_title "
                "FROM knowledge_chunk kc "
                "LEFT JOIN knowledge_chunk_enrichment kce ON kce.chunk_id = kc.id "
                "LEFT JOIN knowledge_chunk_category kcc ON kcc.chunk_id = kc.id "
                "WHERE kc.document_id = %s AND kc.status = 'active' "
                "  AND (kce.chunk_id IS NULL OR kce.content_hash IS NULL "
                "       OR kce.content_hash != kc.content_hash OR kcc.id IS NULL) "
                "ORDER BY kc.chunk_index",
                (document_db_id,),
            )
            return cursor.fetchall()
    finally:
        conn.close()


def count_chunks_needing_enrichment(document_db_id: int) -> int:
    """Cheap count version of :func:`get_chunks_needing_enrichment`."""
    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT COUNT(*) AS c FROM knowledge_chunk kc "
                "LEFT JOIN knowledge_chunk_enrichment kce ON kce.chunk_id = kc.id "
                "LEFT JOIN knowledge_chunk_category kcc ON kcc.chunk_id = kc.id "
                "WHERE kc.document_id = %s AND kc.status = 'active' "
                "  AND (kce.chunk_id IS NULL OR kce.content_hash IS NULL "
                "       OR kce.content_hash != kc.content_hash OR kcc.id IS NULL)",
                (document_db_id,),
            )
            return cursor.fetchone()["c"]
    finally:
        conn.close()


def save_enrichment(chunk_db_id: int, content_hash_value: str, data: dict) -> None:
    """Upsert one row of ``knowledge_chunk_enrichment``."""
    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "INSERT INTO knowledge_chunk_enrichment "
                "(chunk_id, defines_json, uses_json, context_prefix, questions_json, "
                " asset_summary, near_duplicate_hint, content_hash, updated_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW()) "
                "ON DUPLICATE KEY UPDATE "
                "  defines_json = VALUES(defines_json), "
                "  uses_json = VALUES(uses_json), "
                "  context_prefix = VALUES(context_prefix), "
                "  questions_json = VALUES(questions_json), "
                "  asset_summary = VALUES(asset_summary), "
                "  near_duplicate_hint = VALUES(near_duplicate_hint), "
                "  content_hash = VALUES(content_hash), "
                "  updated_at = NOW()",
                (
                    chunk_db_id,
                    json.dumps(data.get("defines") or [], ensure_ascii=False),
                    json.dumps(data.get("uses") or [], ensure_ascii=False),
                    data.get("context_prefix") or "",
                    json.dumps(data.get("questions") or [], ensure_ascii=False),
                    data.get("asset_summary") or "",
                    1 if data.get("near_duplicate_hint") else 0,
                    content_hash_value,
                ),
            )
            conn.commit()
    finally:
        conn.close()


def _parse_json_column(value) -> list:
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except (ValueError, TypeError):
            return []
    return []


def get_enrichment_for_chunks(chunk_db_ids: list[int]) -> dict[int, dict]:
    """Return ``{chunk_db_id: {"context_prefix", "questions", "asset_summary"}}``.

    Used by ``ragflow_packager2`` to inject retrieval-time context into the
    packaged RAGFlow text.
    """
    if not chunk_db_ids:
        return {}
    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            fmt = ",".join(["%s"] * len(chunk_db_ids))
            cursor.execute(
                f"SELECT chunk_id, context_prefix, questions_json, asset_summary "
                f"FROM knowledge_chunk_enrichment WHERE chunk_id IN ({fmt})",
                list(chunk_db_ids),
            )
            out: dict[int, dict] = {}
            for row in cursor.fetchall():
                out[row["chunk_id"]] = {
                    "context_prefix": row.get("context_prefix") or "",
                    "questions": _parse_json_column(row.get("questions_json")),
                    "asset_summary": row.get("asset_summary") or "",
                }
            return out
    finally:
        conn.close()


def get_confidence_by_chunk_code(document_db_id: int) -> dict[str, float]:
    """``{chunk_code: confidence}`` for a document's active, classified chunks.

    Used by T3.9's ``low_confidence`` QC check.
    """
    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT kc.chunk_code AS chunk_id, kcc.confidence AS confidence "
                "FROM knowledge_chunk kc "
                "JOIN knowledge_chunk_category kcc ON kcc.chunk_id = kc.id "
                "WHERE kc.document_id = %s AND kc.status = 'active'",
                (document_db_id,),
            )
            return {
                r["chunk_id"]: float(r["confidence"])
                for r in cursor.fetchall()
                if r.get("confidence") is not None
            }
    finally:
        conn.close()


# ── Main entry points ──────────────────────────────────────────────────────────


def enrich_chunks(
    chunks: list[dict],
    domain_id: int,
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> list[EnrichmentResult]:
    """Enrich a list of chunk dicts (one LLM call each).

    Args:
        chunks: dicts with keys chunk_id / db_id / content / title_path
            (content_hash optional — recomputed if absent).
        domain_id: knowledge_domain.id (numeric).
    """
    nodes = classifier.load_category_tree(domain_id)
    category_tree = classifier.build_category_prompt(nodes) if nodes else ""
    if not nodes:
        logger.warning("No categories found for domain %s", domain_id)

    results: list[EnrichmentResult] = []
    for chunk in chunks:
        chunk_id = chunk.get("chunk_id", "")
        db_id = chunk.get("db_id")
        h = chunk.get("content_hash") or _content_hash(chunk["content"])
        try:
            data = call_llm_enrich(
                content=chunk["content"],
                title_path=chunk.get("title_path", ""),
                category_tree=category_tree,
                api_url=api_url,
                api_key=api_key,
                model=model,
            )
            result = EnrichmentResult(
                chunk_id=chunk_id,
                db_id=db_id,
                category_ids=[int(c) for c in (data.get("category_ids") or [])],
                confidence=float(data.get("confidence", 0.0)),
                defines=list(data.get("defines") or []),
                uses=list(data.get("uses") or []),
                context_prefix=data.get("context_prefix") or "",
                questions=list(data.get("questions") or []),
                near_duplicate_hint=bool(data.get("near_duplicate_hint", False)),
                asset_summary=data.get("asset_summary") or "",
            )

            if db_id:
                if result.category_ids:
                    classifier.save_chunk_categories(
                        chunk_db_id=db_id,
                        category_ids=result.category_ids,
                        confidence=result.confidence,
                        source="llm",
                    )
                save_enrichment(db_id, h, data)

            results.append(result)
            logger.info(
                "Chunk %s enriched: categories=%s confidence=%.2f defines=%d uses=%d "
                "questions=%d near_dup=%s",
                chunk_id, result.category_ids, result.confidence,
                len(result.defines), len(result.uses), len(result.questions),
                result.near_duplicate_hint,
            )
        except Exception as e:  # noqa: BLE001 — one bad chunk must not abort the run
            logger.error(f"Failed to enrich chunk {chunk_id}: {e}")
            results.append(EnrichmentResult(chunk_id=chunk_id, db_id=db_id, error=str(e)))

    return results


def enrich_missing_for_document(
    document_db_id: int,
    domain_id: int,
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> list[EnrichmentResult]:
    """Enrich only the chunks of a document that need it (see
    :func:`get_chunks_needing_enrichment`). Zero-call when nothing is stale.
    """
    worklist = get_chunks_needing_enrichment(document_db_id)
    if not worklist:
        return []
    return enrich_chunks(
        [dict(w) for w in worklist], domain_id,
        api_url=api_url, api_key=api_key, model=model,
    )


# ── T3.5: index-time dedup ─────────────────────────────────────────────────────


def compute_canonical_map(
    chunks: list[dict],
    embed_client: Optional[EmbeddingClient] = None,
) -> dict[int, int]:
    """Pure function: decide which chunks are near-duplicates of an earlier one.

    Args:
        chunks: dicts with keys ``db_id`` (int), ``chunk_index`` (int),
            ``content`` (str), ``near_duplicate_hint`` (bool). Only chunks
            flagged ``near_duplicate_hint=True`` by the LLM are considered —
            this keeps the (O(n^2)) text comparison scoped to a small subset.
        embed_client: optional injected client (tests pass a fake/mocked
            one). Defaults to the process-wide singleton
            (``embedding_client.get_default_client()``), which is
            "unconfigured" unless ``EMBEDDING_API_URL``/``EMBEDDING_API_KEY``
            are set — in that case this function is byte-for-byte identical
            to the pre-817 ``SequenceMatcher``-only behavior.

    Returns:
        ``{later_db_id: canonical_db_id}`` — the later chunk (by
        ``chunk_index``) in each near-duplicate pair points at the earlier
        one. 817 待办第 8 项：当 embedding 客户端已配置时，先批量取一次
        embedding（进程内 sha256 缓存，重复内容零重复调用），成对判重改用
        余弦相似度 ``>= EMBEDDING_DUPLICATE_THRESHOLD``；embedding 不可用
        （未配置/请求失败）时逐对回落到原有的 ``SequenceMatcher`` 文本相似度
        （``>= DUPLICATE_SIMILARITY_THRESHOLD``），行为与接入前完全一致。
    """
    flagged = sorted(
        (c for c in chunks if c.get("near_duplicate_hint") and c.get("db_id")),
        key=lambda c: c["chunk_index"],
    )

    client = embed_client if embed_client is not None else get_default_client()
    embeddings: dict[int, dict] = {}
    if flagged and client.is_configured:
        vectors = client.embed_batch([c["content"] for c in flagged])
        if vectors is not None:
            for c, vec in zip(flagged, vectors):
                if vec is not None:
                    embeddings[c["db_id"]] = vec

    canonical: dict[int, int] = {}
    kept: list[dict] = []
    for chunk in flagged:
        match = None
        chunk_vec = embeddings.get(chunk["db_id"])
        for earlier in kept:
            earlier_vec = embeddings.get(earlier["db_id"])
            if chunk_vec is not None and earlier_vec is not None:
                sim = cosine_similarity(chunk_vec, earlier_vec)
                threshold = EMBEDDING_DUPLICATE_THRESHOLD
            else:
                sim = SequenceMatcher(
                    None, earlier["content"].strip(), chunk["content"].strip()
                ).ratio()
                threshold = DUPLICATE_SIMILARITY_THRESHOLD
            if sim >= threshold:
                match = earlier
                break
        if match is not None:
            # chain to the ultimate canonical chunk, not just the immediate match
            canonical[chunk["db_id"]] = canonical.get(match["db_id"], match["db_id"])
        else:
            kept.append(chunk)
    return canonical


def dedup_document_chunks(
    document_db_id: int,
    embed_client: Optional[EmbeddingClient] = None,
) -> int:
    """T3.5: after enrichment, mark near-duplicate chunks with
    ``canonical_chunk_id`` pointing at the first occurrence.

    Cheap no-op when no active chunk is flagged ``near_duplicate_hint`` (the
    common case) — no extra LLM calls, one SQL SELECT plus (only when
    duplicates are found) a handful of UPDATEs. ``embed_client`` is forwarded
    to :func:`compute_canonical_map` (see there for the embedding/degrade
    semantics).
    """
    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT kc.id AS db_id, kc.chunk_index AS chunk_index, kc.content AS content "
                "FROM knowledge_chunk kc "
                "JOIN knowledge_chunk_enrichment kce ON kce.chunk_id = kc.id "
                "WHERE kc.document_id = %s AND kc.status = 'active' "
                "  AND kce.near_duplicate_hint = 1 AND kc.canonical_chunk_id IS NULL "
                "ORDER BY kc.chunk_index",
                (document_db_id,),
            )
            rows = cursor.fetchall()
            if not rows:
                return 0
            for r in rows:
                r["near_duplicate_hint"] = True
            canonical_map = compute_canonical_map(rows, embed_client=embed_client)
            for later_id, canonical_id in canonical_map.items():
                cursor.execute(
                    "UPDATE knowledge_chunk SET canonical_chunk_id = %s WHERE id = %s",
                    (canonical_id, later_id),
                )
            conn.commit()
            if canonical_map:
                logger.info(
                    "dedup_document_chunks doc=%s: %d chunk(s) marked canonical",
                    document_db_id, len(canonical_map),
                )
            return len(canonical_map)
    finally:
        conn.close()
