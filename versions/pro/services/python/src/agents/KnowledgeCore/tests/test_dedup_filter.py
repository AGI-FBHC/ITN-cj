"""T3.5 索引期去冗余：检索侧按 knowledge_chunk.canonical_chunk_id 过滤重复切片."""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.knowledge.services.retrieval_service import KnowledgeRetrievalService

DDL = [
    """
    CREATE TABLE IF NOT EXISTS knowledge_domain (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code VARCHAR(64) UNIQUE, name VARCHAR(128)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS knowledge_category (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain_id INTEGER, parent_id INTEGER,
        node_code VARCHAR(64), name VARCHAR(255), description TEXT,
        full_path VARCHAR(1000), level INTEGER, node_type VARCHAR(32),
        sort_order INTEGER, status INTEGER DEFAULT 1
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS knowledge_chunk (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER, chunk_code VARCHAR(128), chunk_index INTEGER,
        title_path VARCHAR(1000), section_title VARCHAR(512),
        content TEXT, summary TEXT, ragflow_chunk_id VARCHAR(128),
        canonical_chunk_id INTEGER DEFAULT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS knowledge_chunk_category (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id INTEGER, category_id INTEGER,
        relation_type VARCHAR(32), confidence DECIMAL(5,4), source VARCHAR(32),
        UNIQUE (chunk_id, category_id)
    )
    """,
]

TABLES = ("knowledge_chunk_category", "knowledge_chunk", "knowledge_category", "knowledge_domain")


class FakeRag:
    async def resolve_dataset_ids(self, domain_code: str, explicit=None):
        return explicit or ["ds_1"]

    async def retrieve(self, question, dataset_ids, page_size=8, similarity_threshold=0.2, **kw):
        return []


@pytest_asyncio.fixture
async def db(db_session: AsyncSession):
    for t in TABLES:
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    for ddl in DDL:
        await db_session.execute(text(ddl))
    await db_session.execute(
        text("INSERT INTO knowledge_domain (id, code, name) VALUES (1, 'agent', '智能体')")
    )
    await db_session.execute(
        text(
            "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
            "VALUES (1, 1, NULL, 'kp-react', 'ReAct范式', 1, 'knowledge_point', 1)"
        )
    )
    await db_session.commit()
    yield db_session
    for t in TABLES:
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    await db_session.commit()


@pytest.mark.asyncio
async def test_canonical_duplicate_chunk_filtered_out(db: AsyncSession):
    """重复块（canonical_chunk_id 指向规范块）→ 检索只返回规范块."""
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, content, canonical_chunk_id) "
            "VALUES (1, 10, 'c1', 0, '规范内容', NULL), "
            "(2, 10, 'c2', 1, '规范内容重复', 1)"
        )
    )
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk_category (chunk_id, category_id, confidence, source) "
            "VALUES (1, 1, 0.9, 'llm'), (2, 1, 0.8, 'llm')"
        )
    )
    await db.commit()
    svc = KnowledgeRetrievalService(db, rag=FakeRag())
    hits = await svc.chunks_by_category(1, source="mysql")
    assert [h["chunk_id"] for h in hits] == [1]


@pytest.mark.asyncio
async def test_canonical_null_default_keeps_current_behavior(db: AsyncSession):
    """canonical_chunk_id 全为 NULL（生产去重跑批前的现状）→ 过滤条件恒真，行为不变."""
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, content) "
            "VALUES (1, 10, 'c1', 0, '内容一'), (2, 10, 'c2', 1, '内容二')"
        )
    )
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk_category (chunk_id, category_id, confidence, source) "
            "VALUES (1, 1, 0.9, 'llm'), (2, 1, 0.8, 'llm')"
        )
    )
    await db.commit()
    svc = KnowledgeRetrievalService(db, rag=FakeRag())
    hits = await svc.chunks_by_category(1, source="mysql")
    assert [h["chunk_id"] for h in hits] == [1, 2]


@pytest.mark.asyncio
async def test_canonical_filter_combined_with_min_confidence(db: AsyncSession):
    """canonical 过滤与 min_confidence 同时生效（回归验证 T3.5 新增 AND 未破坏既有过滤条件）."""
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, content, canonical_chunk_id) "
            "VALUES (1, 10, 'c1', 0, '高置信规范块', NULL), "
            "(2, 10, 'c2', 1, '低置信规范块', NULL), "
            "(3, 10, 'c3', 2, '高置信重复块', 1)"
        )
    )
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk_category (chunk_id, category_id, confidence, source) "
            "VALUES (1, 1, 0.9, 'llm'), (2, 1, 0.5, 'llm'), (3, 1, 0.95, 'llm')"
        )
    )
    await db.commit()
    svc = KnowledgeRetrievalService(db, rag=FakeRag())
    hits = await svc.chunks_by_category(1, source="mysql", min_confidence=0.8)
    # chunk3 置信度更高但是重复块被过滤；chunk2 置信度不足被过滤 → 只剩 chunk1
    assert [h["chunk_id"] for h in hits] == [1]


@pytest.mark.asyncio
async def test_canonical_filter_applies_to_descendant_aggregation(db: AsyncSession):
    """include_descendants=True（章节聚合）时 canonical 过滤同样生效，且不破坏 OR 逻辑."""
    await db.execute(
        text(
            "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
            "VALUES (2, 1, NULL, 'ch1', '第一章', 1, 'category', 1)"
        )
    )
    await db.execute(
        text(
            "UPDATE knowledge_category SET parent_id = 2 WHERE id = 1"
        )
    )
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, content, canonical_chunk_id) "
            "VALUES (1, 10, 'c1', 0, '规范内容', NULL), "
            "(2, 10, 'c2', 1, '重复内容', 1)"
        )
    )
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk_category (chunk_id, category_id, confidence, source) "
            "VALUES (1, 1, 0.9, 'llm'), (2, 1, 0.8, 'llm')"
        )
    )
    await db.commit()
    svc = KnowledgeRetrievalService(db, rag=FakeRag())
    hits = await svc.chunks_by_category(2, source="mysql", include_descendants=True)
    assert [h["chunk_id"] for h in hits] == [1]
