"""T1.3（prefer 元数据过滤）、T1.4（RAG 命中回写精确层）、T2.3（检索 miss 日志）测试.

三者共用同一套 knowledge_* 最小 DDL（贴近 test_knowledge_retrieval.py 风格，独立建表避免相互影响）。
"""

from __future__ import annotations

import asyncio
import types
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

import app.knowledge.services.retrieval_service as retrieval_service_module
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
        contains_code TINYINT DEFAULT 0, contains_table TINYINT DEFAULT 0,
        contains_figure TINYINT DEFAULT 0, canonical_chunk_id INTEGER DEFAULT NULL
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
    """
    CREATE TABLE IF NOT EXISTS knowledge_retrieval_miss (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT, domain_id INTEGER, stage VARCHAR(16),
        task_type VARCHAR(32), created_at TEXT
    )
    """,
]

TABLES = (
    "knowledge_retrieval_miss",
    "knowledge_chunk_category",
    "knowledge_chunk",
    "knowledge_category",
    "knowledge_domain",
)


@pytest_asyncio.fixture
async def db(db_session: AsyncSession):
    for ddl in DDL:
        await db_session.execute(text(ddl))
    await db_session.execute(
        text("INSERT INTO knowledge_domain (id, code, name) VALUES (1, 'agent', '智能体')")
    )
    await db_session.commit()
    yield db_session
    for t in TABLES:
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    await db_session.commit()


class FakeRag:
    def __init__(self, chunks: list[dict[str, Any]] | None = None):
        self.chunks = chunks or []

    async def resolve_dataset_ids(self, domain_code: str, explicit=None):
        return explicit or ["ds_1"]

    async def retrieve(self, question, dataset_ids, page_size=8, similarity_threshold=0.2, **kw):
        return self.chunks


# ── T1.3：prefer 排序 ────────────────────────────────────────────────────


@pytest_asyncio.fixture
async def prefer_db(db: AsyncSession):
    await db.execute(
        text(
            "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
            "VALUES (1, 1, NULL, 'kp-react', 'ReAct范式', 1, 'knowledge_point', 1)"
        )
    )
    # 3 条切片：置信度 0.9 / 0.8 / 0.7；只有第 3 条（最低置信度）含代码块
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, content, contains_code) "
            "VALUES (1, 10, 'c1', 0, '概念说明', 0)"
        )
    )
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, content, contains_code) "
            "VALUES (2, 10, 'c2', 1, '原理说明', 0)"
        )
    )
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, content, contains_code) "
            "VALUES (3, 10, 'c3', 2, '示例代码', 1)"
        )
    )
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk_category (chunk_id, category_id, confidence, source) "
            "VALUES (1, 1, 0.9, 'llm'), (2, 1, 0.8, 'llm'), (3, 1, 0.7, 'llm')"
        )
    )
    await db.commit()
    yield db


@pytest.mark.asyncio
async def test_prefer_code_puts_code_chunk_first(prefer_db: AsyncSession):
    """混合含码/不含码切片：prefer='code' 时含码块（chunk 3，置信度最低）排最前."""
    svc = KnowledgeRetrievalService(prefer_db, rag=FakeRag())
    hits = await svc.chunks_by_category(1, source="mysql", prefer="code")
    assert [h["chunk_id"] for h in hits] == [3, 1, 2]


@pytest.mark.asyncio
async def test_no_prefer_keeps_confidence_order(prefer_db: AsyncSession):
    """不传 prefer：保持原有按置信度降序排序，不受影响."""
    svc = KnowledgeRetrievalService(prefer_db, rag=FakeRag())
    hits = await svc.chunks_by_category(1, source="mysql")
    assert [h["chunk_id"] for h in hits] == [1, 2, 3]


@pytest.mark.asyncio
async def test_retrieve_chunks_forwards_prefer(prefer_db: AsyncSession):
    """retrieve_chunks 透传 prefer 到精确层排序."""
    svc = KnowledgeRetrievalService(prefer_db, rag=FakeRag())
    result = await svc.retrieve_chunks("ReAct范式", threshold=1, include_rag=False, prefer="code")
    assert result["decision"] == "mysql"
    assert result["chunks"][0]["chunk_id"] == 3


# ── T1.4：RAG 命中回写精确层 ───────────────────────────────────────────────


@pytest_asyncio.fixture
async def backfill_db(db: AsyncSession):
    await db.execute(
        text(
            "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
            "VALUES (1, 1, NULL, 'kp-env', '环境搭建', 1, 'knowledge_point', 1)"
        )
    )
    # chunk 存在但尚未挂分类（模拟 RAG 命中后待回写）
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, content, ragflow_chunk_id) "
            "VALUES (1, 10, 'c1', 0, '环境搭建教程', 'ragf_env1')"
        )
    )
    await db.commit()
    yield db


def _fake_allow_write(monkeypatch, allow: bool) -> None:
    monkeypatch.setattr(
        retrieval_service_module,
        "get_settings",
        lambda: types.SimpleNamespace(KNOWLEDGE_ALLOW_WRITE=allow),
    )


@pytest.mark.asyncio
async def test_backfill_writes_when_enabled(backfill_db: AsyncSession, monkeypatch):
    """开关 on：第一次查询 RAG 命中回写，第二次查询精确层命中（decision 从 rag 变 mysql）."""
    _fake_allow_write(monkeypatch, True)
    fake_rag = FakeRag(
        [{"id": "ragf_env1", "content": "环境搭建教程", "similarity": 0.61, "document_id": "doc1"}]
    )
    svc = KnowledgeRetrievalService(backfill_db, rag=fake_rag)

    result1 = await svc.retrieve_chunks("环境搭建", threshold=1)
    assert result1["decision"] == "rag"

    # 等待 fire-and-forget 回写任务完成（测试内显式同步，生产不阻塞响应）
    if svc._pending_backfill_tasks:
        await asyncio.gather(*svc._pending_backfill_tasks)

    result2 = await svc.retrieve_chunks("环境搭建", threshold=1, include_rag=False)
    assert result2["decision"] == "mysql"
    assert result2["chunks"][0]["chunk_id"] == 1


@pytest.mark.asyncio
async def test_backfill_off_by_default(backfill_db: AsyncSession):
    """开关默认 off：两次查询都走 RAG，不回写."""
    fake_rag = FakeRag(
        [{"id": "ragf_env1", "content": "环境搭建教程", "similarity": 0.61, "document_id": "doc1"}]
    )
    svc = KnowledgeRetrievalService(backfill_db, rag=fake_rag)

    result1 = await svc.retrieve_chunks("环境搭建", threshold=1)
    assert result1["decision"] == "rag"
    assert svc._pending_backfill_tasks == []

    result2 = await svc.retrieve_chunks("环境搭建", threshold=1)
    assert result2["decision"] == "rag"


@pytest.mark.asyncio
async def test_backfill_skips_low_similarity(backfill_db: AsyncSession, monkeypatch):
    """开关 on 但相似度 < 0.5：不回写."""
    _fake_allow_write(monkeypatch, True)
    fake_rag = FakeRag(
        [{"id": "ragf_env1", "content": "环境搭建教程", "similarity": 0.3, "document_id": "doc1"}]
    )
    svc = KnowledgeRetrievalService(backfill_db, rag=fake_rag)
    await svc.retrieve_chunks("环境搭建", threshold=1)
    assert svc._pending_backfill_tasks == []


# ── T2.3：检索 miss 日志 ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_retrieve_miss_logged_when_unresolved(db: AsyncSession):
    """知识点名完全查不到 + RAG 也无结果 → miss 表出现记录，接口响应不变."""
    svc = KnowledgeRetrievalService(db, rag=FakeRag(chunks=[]))
    result = await svc.retrieve_chunks("完全不存在的知识点XYZ")
    assert result["decision"] == "empty"

    rows = (
        await db.execute(text("SELECT stage, task_type FROM knowledge_retrieval_miss"))
    ).mappings().all()
    assert len(rows) == 1
    assert rows[0]["stage"] == "resolve_category"


@pytest.mark.asyncio
async def test_retrieve_miss_logged_when_chunks_all_empty(db: AsyncSession):
    """知识点命中但三级全空（无切片 + RAG 关闭）→ miss 表记录 stage=chunks."""
    await db.execute(
        text(
            "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
            "VALUES (1, 1, NULL, 'kp-empty', '空知识点', 1, 'knowledge_point', 1)"
        )
    )
    await db.commit()
    svc = KnowledgeRetrievalService(db, rag=FakeRag(chunks=[]))
    result = await svc.retrieve_chunks("空知识点", include_rag=False, task_type="question")
    assert result["decision"] == "empty"

    rows = (
        await db.execute(text("SELECT stage, task_type FROM knowledge_retrieval_miss"))
    ).mappings().all()
    assert len(rows) == 1
    assert rows[0]["stage"] == "chunks"
    assert rows[0]["task_type"] == "question"


@pytest.mark.asyncio
async def test_no_miss_logged_on_hit(prefer_db: AsyncSession):
    """正常命中不写 miss 记录."""
    svc = KnowledgeRetrievalService(prefer_db, rag=FakeRag())
    result = await svc.retrieve_chunks("ReAct范式", threshold=1, include_rag=False)
    assert result["decision"] == "mysql"
    rows = (await prefer_db.execute(text("SELECT * FROM knowledge_retrieval_miss"))).mappings().all()
    assert rows == []


@pytest.mark.asyncio
async def test_miss_log_failure_does_not_break_response(db: AsyncSession):
    """miss 表不存在（未迁移场景）→ 写入静默失败，接口响应不受影响."""
    await db.execute(text("DROP TABLE IF EXISTS knowledge_retrieval_miss"))
    await db.commit()
    svc = KnowledgeRetrievalService(db, rag=FakeRag(chunks=[]))
    result = await svc.retrieve_chunks("完全不存在的知识点XYZ")
    assert result["decision"] == "empty"
