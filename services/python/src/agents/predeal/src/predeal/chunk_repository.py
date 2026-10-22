"""Database repository for knowledge_chunk table.

Provides idempotent, diff-based chunk synchronization:

- Unchanged chunks (same content hash) keep their DB id and rows untouched.
- Changed chunks (same position, different content) are updated in place;
  their category classifications are cleared so the classifier re-runs.
- New chunks are inserted.
- Chunks no longer present are soft-deleted (status='superseded') and their
  category classifications removed — never physically deleted, so historical
  references keep working.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import Optional

import pymysql
from pymysql.cursors import DictCursor

from .utils.hash import content_hash

logger = logging.getLogger(__name__)

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


def _get_connection() -> pymysql.Connection:
    return pymysql.connect(**MYSQL_CONFIG)


# ── Sync report ────────────────────────────────────────────────────────────


class ChunkSyncReport:
    """Outcome of one diff-based chunk synchronization."""

    def __init__(self) -> None:
        self.inserted: list[dict] = []      # [{"chunk_id", "db_id"}]  -> need classify + RAGFlow add
        self.updated: list[dict] = []       # [{"chunk_id", "db_id"}]  -> need classify + RAGFlow update
        self.unchanged: list[dict] = []     # [{"chunk_id", "db_id"}]  -> reuse
        self.superseded_ids: list[int] = []  # DB ids now status='superseded' -> RAGFlow disable
        self._all_db_ids: dict[str, int] = {}

    @property
    def all_db_ids(self) -> dict[str, int]:
        return self._all_db_ids

    @property
    def active_count(self) -> int:
        return len(self.inserted) + len(self.updated) + len(self.unchanged)

    def changed_count(self) -> int:
        return len(self.inserted) + len(self.updated)

    def to_dict(self) -> dict:
        return {
            "inserted": len(self.inserted),
            "updated": len(self.updated),
            "unchanged": len(self.unchanged),
            "superseded": len(self.superseded_ids),
            "active": self.active_count,
        }


def _fetch_active_chunks(document_db_id: int, cursor: pymysql.cursors.Cursor) -> list[dict]:
    """Fetch active chunks of a document ordered by chunk_index."""
    cursor.execute(
        "SELECT id, chunk_code, chunk_index, content_hash, content, "
        "title_path, section_title, token_count, char_start, char_end, status "
        "FROM knowledge_chunk "
        "WHERE document_id = %s AND status = 'active' "
        "ORDER BY chunk_index",
        (document_db_id,),
    )
    return cursor.fetchall()


def _fetch_all_chunks(document_db_id: int, cursor: pymysql.cursors.Cursor) -> list[dict]:
    """Fetch all chunks of a document (active + superseded) ordered by chunk_index."""
    cursor.execute(
        "SELECT id, chunk_code, chunk_index, content_hash, content, "
        "title_path, section_title, token_count, char_start, char_end, status "
        "FROM knowledge_chunk "
        "WHERE document_id = %s "
        "ORDER BY chunk_index",
        (document_db_id,),
    )
    return cursor.fetchall()


def _delete_chunk_categories(cursor: pymysql.cursors.Cursor, chunk_db_ids: list[int]) -> None:
    """Remove category classifications for the given chunk ids."""
    if not chunk_db_ids:
        return
    fmt = ",".join(["%s"] * len(chunk_db_ids))
    cursor.execute(
        f"DELETE FROM knowledge_chunk_category WHERE chunk_id IN ({fmt})",
        chunk_db_ids,
    )


# ── T4.6: graph incremental re-review queue ─────────────────────────────────
#
# Chunks whose content changed (updated) or disappeared (superseded) may
# invalidate LLM-generated graph edges whose evidence pointed at their old
# content/classification. sync_chunks records their ids into
# `graph_review_pending`; KnowledgeCore's graph module consumes/clears that
# queue on its own schedule (predeal only produces, never consumes).


def _pending_chunk_ids(report: "ChunkSyncReport") -> list[int]:
    """Chunk db ids that are candidates for graph incremental re-review.

    Only `updated` (content changed in place) and `superseded` (chunk
    disappeared) chunks are relevant — `inserted` chunks have no prior graph
    edges to invalidate, and `unchanged` chunks keep whatever edges already
    reference them.
    """
    ids = [row["db_id"] for row in report.updated]
    ids.extend(report.superseded_ids)
    return ids


def _record_graph_review_pending(
    cursor: pymysql.cursors.Cursor, chunk_ids: list[int]
) -> None:
    """Fire-and-forget insert into `graph_review_pending`.

    Any failure (e.g. migration not applied yet) is swallowed and logged —
    this must never block or fail the main chunk-sync transaction.
    """
    if not chunk_ids:
        return
    try:
        now = datetime.now()
        cursor.executemany(
            "INSERT INTO graph_review_pending (chunk_id, created_at) VALUES (%s, %s)",
            [(cid, now) for cid in chunk_ids],
        )
    except Exception as e:  # noqa: BLE001 - fire-and-forget, never break sync_chunks
        logger.warning(f"graph_review_pending write failed (ignored): {e}")


def sync_chunks(
    document_db_id: int,
    chunks: list,
) -> ChunkSyncReport:
    """Diff the compiled chunks against the current active chunks.

    Args:
        document_db_id: knowledge_document.id
        chunks: List of KnowledgeChunk objects from chunk_compiler

    Returns:
        ChunkSyncReport describing what was inserted / updated / unchanged /
        superseded. All changes are committed in a single transaction.
    """
    report = ChunkSyncReport()
    if not chunks:
        return report

    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            old_rows = _fetch_all_chunks(document_db_id, cursor)
            now = datetime.now()

            old_active: dict[int, dict] = {r["id"]: r for r in old_rows if r["status"] == "active"}
            old_by_hash: dict[str, dict] = {}
            old_by_index: dict[int, dict] = {}
            for row in old_rows:
                if row.get("content_hash"):
                    old_by_hash.setdefault(row["content_hash"], row)
                if row["status"] == "active":
                    old_by_index.setdefault(row["chunk_index"], row)

            used_ids: set[int] = set()
            id_by_hash: dict[str, int] = {}

            for chunk in chunks:
                h = content_hash(chunk.content)
                title_path = " > ".join(chunk.section_path) if chunk.section_path else ""
                section_title = chunk.heading or ""

                # 1) content-hash match -> reuse (reactivate superseded chunks so a
                #    deleted-and-re-added section keeps its chunk ids)
                old = old_by_hash.get(h) if h not in id_by_hash else None
                if old is not None and old["id"] not in used_ids:
                    used_ids.add(old["id"])
                    db_id = old["id"]
                    new_status = "active"
                    if old.get("status") != "active":
                        new_status = "active"  # reactivate
                    if (old.get("title_path") != title_path
                            or old.get("section_title") != section_title
                            or old.get("chunk_index") != chunk.chunk_order
                            or old.get("chunk_code") != chunk.chunk_id
                            or old.get("status") != "active"):
                        cursor.execute(
                            "UPDATE knowledge_chunk SET chunk_code=%s, chunk_index=%s, "
                            "title_path=%s, section_title=%s, content_hash=%s, "
                            "status=%s, updated_at=%s WHERE id=%s",
                            (chunk.chunk_id, chunk.chunk_order, title_path, section_title,
                             h, new_status, now, db_id),
                        )
                    report.unchanged.append({"chunk_id": chunk.chunk_id, "db_id": db_id})
                    report._all_db_ids[chunk.chunk_id] = db_id
                    continue

                # 2) same position, different content -> update in place
                old = old_by_index.get(chunk.chunk_order)
                if old is not None and old["id"] not in used_ids:
                    used_ids.add(old["id"])
                    db_id = old["id"]
                    if old.get("content") == chunk.content:
                        # identical content (e.g. content_hash column was NULL
                        # from a pre-migration run) -> backfill, keep unchanged
                        cursor.execute(
                            "UPDATE knowledge_chunk SET chunk_code=%s, chunk_index=%s, "
                            "title_path=%s, section_title=%s, content_hash=%s, "
                            "status='active', updated_at=%s WHERE id=%s",
                            (chunk.chunk_id, chunk.chunk_order, title_path, section_title,
                             h, now, db_id),
                        )
                        report.unchanged.append({"chunk_id": chunk.chunk_id, "db_id": db_id})
                        report._all_db_ids[chunk.chunk_id] = db_id
                        continue
                    cursor.execute(
                        "UPDATE knowledge_chunk SET chunk_code=%s, chunk_index=%s, "
                        "title_path=%s, section_title=%s, content=%s, content_hash=%s, "
                        "token_count=%s, char_start=%s, char_end=%s, status='active', "
                        "updated_at=%s WHERE id=%s",
                        (chunk.chunk_id, chunk.chunk_order, title_path, section_title,
                         chunk.content, h, chunk.approx_token_count,
                         chunk.source_start_offset, chunk.source_end_offset, now, db_id),
                    )
                    # classification is stale -> re-classify
                    _delete_chunk_categories(cursor, [db_id])
                    report.updated.append({"chunk_id": chunk.chunk_id, "db_id": db_id})
                    report._all_db_ids[chunk.chunk_id] = db_id
                    continue

                # 3) brand-new chunk
                cursor.execute(
                    "INSERT INTO knowledge_chunk ("
                    "document_id, chunk_code, chunk_index, title_path, section_title, "
                    "content, content_hash, token_count, char_start, char_end, status, "
                    "created_at, updated_at"
                    ") VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'active',%s,%s)",
                    (document_db_id, chunk.chunk_id, chunk.chunk_order, title_path,
                     section_title, chunk.content, h, chunk.approx_token_count,
                     chunk.source_start_offset, chunk.source_end_offset, now, now),
                )
                db_id = cursor.lastrowid
                report.inserted.append({"chunk_id": chunk.chunk_id, "db_id": db_id})
                report._all_db_ids[chunk.chunk_id] = db_id

            # 4) soft-delete chunks that disappeared (deleted chapter/section);
            #    category associations are removed so the current index never
            #    surfaces them (chunks themselves are kept for history)
            superseded = [
                row["id"] for row in old_active.values()
                if row["id"] not in used_ids
            ]
            if superseded:
                fmt = ",".join(["%s"] * len(superseded))
                cursor.execute(
                    f"UPDATE knowledge_chunk SET status='superseded', updated_at=%s "
                    f"WHERE id IN ({fmt})",
                    [now] + superseded,
                )
                _delete_chunk_categories(cursor, superseded)
                report.superseded_ids = superseded

            # T4.6: queue updated/superseded chunks for KnowledgeCore's graph
            # incremental re-review (fire-and-forget, failure never blocks sync)
            _record_graph_review_pending(cursor, _pending_chunk_ids(report))

            conn.commit()
            logger.info(
                f"sync_chunks doc={document_db_id}: {report.to_dict()}"
            )
            return report
    finally:
        conn.close()


# ── Per-chunk helpers ──────────────────────────────────────────────────────


def insert_chunks(
    document_db_id: int,
    chunks: list,
) -> list[dict]:
    """DEPRECATED — legacy full-replace insert used by pipeline.py.

    Deletes all existing chunks of the document and re-inserts them.
    New code should use :func:`sync_chunks` (diff-based, idempotent).
    """
    conn = _get_connection()
    results = []
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "DELETE FROM knowledge_chunk WHERE document_id = %s",
                (document_db_id,),
            )
            for chunk in chunks:
                title_path = " > ".join(chunk.section_path) if chunk.section_path else ""
                sql = """
                    INSERT INTO knowledge_chunk (
                        document_id, chunk_code, chunk_index,
                        title_path, section_title, content,
                        content_hash, token_count, char_start, char_end,
                        status, created_at, updated_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'active', %s, %s)
                """
                from .utils.hash import content_hash as _ch
                now = datetime.now()
                cursor.execute(sql, (
                    document_db_id,
                    chunk.chunk_id,
                    chunk.chunk_order,
                    title_path,
                    chunk.heading or "",
                    chunk.content,
                    _ch(chunk.content),
                    chunk.approx_token_count,
                    chunk.source_start_offset,
                    chunk.source_end_offset,
                    now,
                    now,
                ))
                results.append({"chunk_id": chunk.chunk_id, "db_id": cursor.lastrowid})
            conn.commit()
            logger.info(f"Inserted {len(results)} chunks for document {document_db_id}")
    finally:
        conn.close()
    return results


def update_chunk_ragflow_id(
    chunk_db_id: int,
    ragflow_chunk_id: str,
) -> None:
    """Update a chunk's ragflow_chunk_id after RAGFlow sync."""
    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "UPDATE knowledge_chunk SET ragflow_chunk_id = %s, updated_at = %s "
                "WHERE id = %s",
                (ragflow_chunk_id, datetime.now(), chunk_db_id),
            )
            conn.commit()
    finally:
        conn.close()


def get_active_chunks(document_db_id: int) -> list[dict]:
    """Fetch active chunk rows ordered by chunk_index (content included)."""
    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            return _fetch_active_chunks(document_db_id, cursor)
    finally:
        conn.close()


def missing_ragflow_ids(document_db_id: int) -> list[int]:
    """Active chunks whose ragflow_chunk_id is not yet mapped (NULL).

    Used by the sync self-heal: an upload whose RAGFlow parsing finished
    after the pipeline exited leaves these NULL until a later run backfills
    them (see ragflow_packager2.self_heal_chunk_ragflow_ids).
    """
    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT id FROM knowledge_chunk "
                "WHERE document_id = %s AND status = 'active' "
                "AND ragflow_chunk_id IS NULL",
                (document_db_id,),
            )
            return [r["id"] for r in cursor.fetchall()]
    finally:
        conn.close()


def get_ragflow_chunk_ids(
    document_db_id: int,
    chunk_db_ids: Optional[list[int]] = None,
) -> dict:
    """Return {chunk_db_id: ragflow_chunk_id} for a document's chunks.

    Args:
        document_db_id: knowledge_document.id
        chunk_db_ids: Restrict to these chunk ids (default: all chunks)
    """
    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            if chunk_db_ids:
                fmt = ",".join(["%s"] * len(chunk_db_ids))
                cursor.execute(
                    f"SELECT id, ragflow_chunk_id FROM knowledge_chunk "
                    f"WHERE document_id = %s AND id IN ({fmt})",
                    [document_db_id] + list(chunk_db_ids),
                )
            else:
                cursor.execute(
                    "SELECT id, ragflow_chunk_id FROM knowledge_chunk "
                    "WHERE document_id = %s",
                    (document_db_id,),
                )
            return {r["id"]: r["ragflow_chunk_id"] for r in cursor.fetchall()}
    finally:
        conn.close()


def count_active_chunks(document_db_id: int) -> int:
    """Count active chunks of a document."""
    conn = _get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT COUNT(*) AS c FROM knowledge_chunk "
                "WHERE document_id = %s AND status = 'active'",
                (document_db_id,),
            )
            return cursor.fetchone()["c"]
    finally:
        conn.close()
