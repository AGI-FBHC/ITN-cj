"""T4.6：图谱增量重审 —— GraphReviewPendingService 消费 graph_review_pending."""

from __future__ import annotations

import types

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.api import graph_routes
from app.graph.services.review_pending_service import GraphReviewPendingService

DDL = [
    """
    CREATE TABLE IF NOT EXISTS knowledge_category_prerequisite (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain_id INTEGER NOT NULL,
        category_id INTEGER NOT NULL,
        prereq_category_id INTEGER NOT NULL,
        edge_type VARCHAR(32) NOT NULL DEFAULT 'prerequisite',
        confidence DECIMAL(5,4) NOT NULL DEFAULT 1.0,
        status VARCHAR(20) NOT NULL DEFAULT 'proposed',
        source VARCHAR(32) NOT NULL DEFAULT 'agent',
        created_at TEXT, updated_at TEXT,
        UNIQUE (category_id, prereq_category_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS knowledge_chunk_category (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id INTEGER, category_id INTEGER,
        confidence DECIMAL(5,4), source VARCHAR(32)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS graph_review_pending (
        chunk_id INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
    """,
]

TABLES = ("graph_review_pending", "knowledge_chunk_category", "knowledge_category_prerequisite")


@pytest_asyncio.fixture
async def review_db(db_session: AsyncSession):
    for t in TABLES:
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    for ddl in DDL:
        await db_session.execute(text(ddl))
    await db_session.commit()
    yield db_session
    for t in TABLES:
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    await db_session.commit()


async def add_edge(
    db: AsyncSession, category_id: int, prereq_category_id: int, source: str = "llm", status: str = "active"
):
    await db.execute(
        text(
            "INSERT INTO knowledge_category_prerequisite "
            "(domain_id, category_id, prereq_category_id, source, status) "
            "VALUES (1, :cat, :prereq, :source, :status)"
        ),
        {"cat": category_id, "prereq": prereq_category_id, "source": source, "status": status},
    )
    await db.commit()


async def get_edge_status(db: AsyncSession, category_id: int, prereq_category_id: int) -> str:
    row = (
        await db.execute(
            text(
                "SELECT status FROM knowledge_category_prerequisite "
                "WHERE category_id = :cat AND prereq_category_id = :prereq"
            ),
            {"cat": category_id, "prereq": prereq_category_id},
        )
    ).mappings().first()
    return row["status"]


# ── 正常流程 ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_process_pending_marks_llm_edges_needs_review(review_db: AsyncSession):
    """chunk 归属知识点 10 的 llm 边被标 needs_review；非 llm 边不受影响；pending 行被清理."""
    await add_edge(review_db, category_id=11, prereq_category_id=10, source="llm", status="active")
    await add_edge(review_db, category_id=12, prereq_category_id=10, source="human", status="active")
    await review_db.execute(
        text("INSERT INTO knowledge_chunk_category (chunk_id, category_id) VALUES (101, 10)")
    )
    await review_db.execute(text("INSERT INTO graph_review_pending (chunk_id) VALUES (101)"))
    await review_db.commit()

    report = await GraphReviewPendingService(review_db).process_pending()

    assert report.pending_chunks == 1
    assert report.affected_categories == 1
    assert report.edges_marked == 1
    assert report.warnings == []

    assert await get_edge_status(review_db, 11, 10) == "needs_review"
    assert await get_edge_status(review_db, 12, 10) == "active"  # human 边不受影响

    remaining = (
        await review_db.execute(text("SELECT COUNT(*) FROM graph_review_pending"))
    ).scalar()
    assert remaining == 0


@pytest.mark.asyncio
async def test_process_pending_marks_edges_on_either_side(review_db: AsyncSession):
    """待重审知识点既可能是边的目标(category_id)也可能是先修(prereq_category_id)."""
    await add_edge(review_db, category_id=10, prereq_category_id=20, source="llm", status="proposed")
    await review_db.execute(
        text("INSERT INTO knowledge_chunk_category (chunk_id, category_id) VALUES (200, 20)")
    )
    await review_db.execute(text("INSERT INTO graph_review_pending (chunk_id) VALUES (200)"))
    await review_db.commit()

    report = await GraphReviewPendingService(review_db).process_pending()
    assert report.edges_marked == 1
    assert await get_edge_status(review_db, 10, 20) == "needs_review"


@pytest.mark.asyncio
async def test_process_pending_chunk_without_category_still_clears_pending(review_db: AsyncSession):
    """chunk 未挂任何知识点（无 knowledge_chunk_category 行）→ 0 条边被标记，但 pending 行仍被清理（幂等）."""
    await review_db.execute(text("INSERT INTO graph_review_pending (chunk_id) VALUES (999)"))
    await review_db.commit()

    report = await GraphReviewPendingService(review_db).process_pending()
    assert report.pending_chunks == 1
    assert report.affected_categories == 0
    assert report.edges_marked == 0

    remaining = (
        await review_db.execute(text("SELECT COUNT(*) FROM graph_review_pending"))
    ).scalar()
    assert remaining == 0


@pytest.mark.asyncio
async def test_process_pending_empty_table_no_op(review_db: AsyncSession):
    report = await GraphReviewPendingService(review_db).process_pending()
    assert report.pending_chunks == 0
    assert report.edges_marked == 0
    assert report.warnings == []


@pytest.mark.asyncio
async def test_process_pending_already_needs_review_not_double_counted(review_db: AsyncSession):
    """已经是 needs_review 的边不会被重复"标记"（WHERE status IN (active, proposed)）."""
    await add_edge(review_db, category_id=11, prereq_category_id=10, source="llm", status="needs_review")
    await review_db.execute(
        text("INSERT INTO knowledge_chunk_category (chunk_id, category_id) VALUES (101, 10)")
    )
    await review_db.execute(text("INSERT INTO graph_review_pending (chunk_id) VALUES (101)"))
    await review_db.commit()

    report = await GraphReviewPendingService(review_db).process_pending()
    assert report.edges_marked == 0
    assert await get_edge_status(review_db, 11, 10) == "needs_review"


@pytest.mark.asyncio
async def test_process_pending_batch_size_limits_rows(review_db: AsyncSession):
    for cid in (101, 102, 103):
        await review_db.execute(text("INSERT INTO graph_review_pending (chunk_id) VALUES (:c)"), {"c": cid})
    await review_db.commit()

    report = await GraphReviewPendingService(review_db).process_pending(batch_size=2)
    assert report.pending_chunks == 2
    remaining = (
        await review_db.execute(text("SELECT COUNT(*) FROM graph_review_pending"))
    ).scalar()
    assert remaining == 1  # 第 3 条留到下一批


# ── 表未迁移：优雅降级 ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_process_pending_missing_table_degrades_gracefully(db_session: AsyncSession):
    await db_session.execute(text("DROP TABLE IF EXISTS graph_review_pending"))
    await db_session.commit()
    report = await GraphReviewPendingService(db_session).process_pending()
    assert report.pending_chunks == 0
    assert report.warnings  # 有降级提示，但不抛异常


# ── 管理端点：KNOWLEDGE_ALLOW_WRITE 守门 ─────────────────────────────────


def _fake_settings(monkeypatch, **overrides) -> None:
    base = {"KNOWLEDGE_ALLOW_WRITE": False}
    base.update(overrides)
    monkeypatch.setattr(graph_routes, "get_settings", lambda: types.SimpleNamespace(**base))


@pytest.mark.asyncio
async def test_process_review_pending_endpoint_requires_write_flag(review_db: AsyncSession, monkeypatch):
    _fake_settings(monkeypatch, KNOWLEDGE_ALLOW_WRITE=False)
    with pytest.raises(HTTPException) as exc_info:
        await graph_routes.process_review_pending(batch_size=500, db=review_db)
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_process_review_pending_endpoint_processes_when_enabled(review_db: AsyncSession, monkeypatch):
    _fake_settings(monkeypatch, KNOWLEDGE_ALLOW_WRITE=True)
    await add_edge(review_db, category_id=11, prereq_category_id=10, source="llm", status="active")
    await review_db.execute(
        text("INSERT INTO knowledge_chunk_category (chunk_id, category_id) VALUES (101, 10)")
    )
    await review_db.execute(text("INSERT INTO graph_review_pending (chunk_id) VALUES (101)"))
    await review_db.commit()

    report = await graph_routes.process_review_pending(batch_size=500, db=review_db)
    assert report.edges_marked == 1
    assert await get_edge_status(review_db, 11, 10) == "needs_review"
