"""T3.4 父子多粒度返回（轻量版）测试：短块自动补邻 / 长块不补 / 显式开关 / 边界不越界."""

from __future__ import annotations

from typing import Any

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
    def __init__(self, chunks: list[dict[str, Any]] | None = None):
        self.chunks = chunks or []

    async def resolve_dataset_ids(self, domain_code: str, explicit=None):
        return explicit or ["ds_1"]

    async def retrieve(self, question, dataset_ids, page_size=8, similarity_threshold=0.2, **kw):
        return self.chunks


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
async def test_short_chunk_auto_expands_context(db: AsyncSession):
    """短块（<200 字符）自动补邻：同文档 chunk_index±1 且 title_path 一致."""
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, title_path, content) "
            "VALUES (1, 10, 'c0', 0, '第四章/ReAct', '上文'), "
            "(2, 10, 'c1', 1, '第四章/ReAct', '短命中块'), "
            "(3, 10, 'c2', 2, '第四章/ReAct', '下文')"
        )
    )
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk_category (chunk_id, category_id, confidence, source) "
            "VALUES (2, 1, 0.9, 'llm')"
        )
    )
    await db.commit()
    svc = KnowledgeRetrievalService(db, rag=FakeRag())
    result = await svc.retrieve_chunks("ReAct范式", threshold=1, include_rag=False)
    assert result["decision"] == "mysql"
    assert [c["chunk_id"] for c in result["chunks"]] == [2]
    context_ids = sorted(c["chunk_id"] for c in result["context_chunks"])
    assert context_ids == [1, 3]
    assert all(c["source"] == "context" for c in result["context_chunks"])


@pytest.mark.asyncio
async def test_long_chunk_not_expanded_without_flag(db: AsyncSession):
    """长块（>=200 字符）且未显式 expand_context=True → 不补邻."""
    long_content = "长内容" * 100  # 远超 200 字符
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, title_path, content) "
            "VALUES (1, 10, 'c0', 0, '第四章/ReAct', '上文'), "
            "(2, 10, 'c1', 1, '第四章/ReAct', :content)"
        ),
        {"content": long_content},
    )
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk_category (chunk_id, category_id, confidence, source) "
            "VALUES (2, 1, 0.9, 'llm')"
        )
    )
    await db.commit()
    svc = KnowledgeRetrievalService(db, rag=FakeRag())
    result = await svc.retrieve_chunks("ReAct范式", threshold=1, include_rag=False)
    assert result["context_chunks"] == []


@pytest.mark.asyncio
async def test_expand_context_flag_forces_expansion_for_long_chunk(db: AsyncSession):
    """expand_context=True：即使长块也补邻."""
    long_content = "长内容" * 100
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, title_path, content) "
            "VALUES (1, 10, 'c0', 0, '第四章/ReAct', '上文'), "
            "(2, 10, 'c1', 1, '第四章/ReAct', :content)"
        ),
        {"content": long_content},
    )
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk_category (chunk_id, category_id, confidence, source) "
            "VALUES (2, 1, 0.9, 'llm')"
        )
    )
    await db.commit()
    svc = KnowledgeRetrievalService(db, rag=FakeRag())
    result = await svc.retrieve_chunks(
        "ReAct范式", threshold=1, include_rag=False, expand_context=True
    )
    assert [c["chunk_id"] for c in result["context_chunks"]] == [1]


@pytest.mark.asyncio
async def test_expand_context_does_not_cross_section_boundary(db: AsyncSession):
    """文档边界/章节边界不越界：相邻 chunk_index 但 title_path 不同 → 不补."""
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, title_path, content) "
            "VALUES (1, 10, 'c0', 0, '第四章/Plan', '上一节内容'), "
            "(2, 10, 'c1', 1, '第四章/ReAct', '短命中块')"
        )
    )
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk_category (chunk_id, category_id, confidence, source) "
            "VALUES (2, 1, 0.9, 'llm')"
        )
    )
    await db.commit()
    svc = KnowledgeRetrievalService(db, rag=FakeRag())
    result = await svc.retrieve_chunks("ReAct范式", threshold=1, include_rag=False)
    assert result["context_chunks"] == []


@pytest.mark.asyncio
async def test_response_backward_compatible_fields_present(db: AsyncSession):
    """返回体向后兼容：原 chunks 字段保留，新增 hit_chunks/context_chunks 可选消费."""
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, content) "
            "VALUES (1, 10, 'c1', 0, '内容')"
        )
    )
    await db.execute(
        text(
            "INSERT INTO knowledge_chunk_category (chunk_id, category_id, confidence, source) "
            "VALUES (1, 1, 0.9, 'llm')"
        )
    )
    await db.commit()
    svc = KnowledgeRetrievalService(db, rag=FakeRag())
    result = await svc.retrieve_chunks("ReAct范式", threshold=1, include_rag=False)
    assert result["chunks"] == result["hit_chunks"]
    assert "context_chunks" in result


@pytest.mark.asyncio
async def test_rag_only_branch_includes_backward_compatible_fields(db: AsyncSession):
    """知识点未命中目录树、走纯 RAG 分支：同样带 hit_chunks/context_chunks（空）."""
    fake_rag = FakeRag(
        chunks=[{"id": "ragf_1", "content": "内容", "similarity": 0.5, "document_id": "doc1"}]
    )
    svc = KnowledgeRetrievalService(db, rag=fake_rag)
    result = await svc.retrieve_chunks("完全不存在的知识点XYZ")
    assert result["decision"] == "rag"
    assert result["hit_chunks"] == result["chunks"]
    assert result["context_chunks"] == []
