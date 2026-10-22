"""T3.3 重排层接线测试：retrieve_chunks 在 KNOWLEDGE_RERANK 开关下的行为.

reranker.py 自身的纯函数覆盖见 test_reranker.py；本文件只覆盖 retrieval_service
如何接线（开关 off 完全不调用；开关 on 合并候选过 rerank 再截断 limit）。
"""

from __future__ import annotations

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
    await db_session.execute(
        text(
            "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, content) "
            "VALUES (1, 10, 'c1', 0, '内容一'), (2, 10, 'c2', 1, '内容二')"
        )
    )
    await db_session.execute(
        text(
            "INSERT INTO knowledge_chunk_category (chunk_id, category_id, confidence, source) "
            "VALUES (1, 1, 0.9, 'llm'), (2, 1, 0.8, 'llm')"
        )
    )
    await db_session.commit()
    yield db_session
    for t in TABLES:
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    await db_session.commit()


def _fake_settings(monkeypatch, **overrides) -> None:
    base = {"KNOWLEDGE_RERANK": False, "RERANKER_API_URL": ""}
    base.update(overrides)
    monkeypatch.setattr(
        retrieval_service_module, "get_settings", lambda: types.SimpleNamespace(**base)
    )


@pytest.mark.asyncio
async def test_rerank_explicit_off_matches_legacy_order(db: AsyncSession, monkeypatch):
    """显式关闭开关：不调用 reranker，行为与旧版 100% 一致."""
    _fake_settings(monkeypatch, KNOWLEDGE_RERANK=False, RERANKER_API_URL="http://mock/rerank")
    called = {"n": 0}

    async def fake_rerank(query, chunks, top_k):
        called["n"] += 1
        return chunks[:top_k]

    monkeypatch.setattr(retrieval_service_module, "rerank", fake_rerank)
    svc = KnowledgeRetrievalService(db, rag=FakeRag())
    result = await svc.retrieve_chunks("ReAct范式", threshold=1, include_rag=False)
    assert result["decision"] == "mysql"
    assert [c["chunk_id"] for c in result["chunks"]] == [1, 2]
    assert called["n"] == 0  # 开关 off：完全不涉及 reranker


@pytest.mark.asyncio
async def test_rerank_default_on_without_endpoint_is_hermetic_noop(db: AsyncSession):
    """真实默认配置（2026-08-18 评估验证后默认 on）+ conftest 置空端点 →
    重排自动 no-op、不触网、顺序与旧版一致."""
    from app.core.config import get_settings

    assert get_settings().KNOWLEDGE_RERANK is True  # 新默认
    assert get_settings().RERANKER_API_URL == ""  # conftest 隔离生效
    svc = KnowledgeRetrievalService(db, rag=FakeRag())
    result = await svc.retrieve_chunks("ReAct范式", threshold=1, include_rag=False)
    assert [c["chunk_id"] for c in result["chunks"]] == [1, 2]
    assert "rerank_score" not in result["chunks"][0]


@pytest.mark.asyncio
async def test_rerank_on_reorders_and_annotates_score(db: AsyncSession, monkeypatch):
    """开关 on：合并候选过 rerank，附 rerank_score，按 mock 分数重排."""
    _fake_settings(monkeypatch, KNOWLEDGE_RERANK=True, RERANKER_API_URL="http://mock/rerank")

    async def fake_rerank(query, chunks, top_k):
        reordered = list(reversed(chunks))[:top_k]
        for i, c in enumerate(reordered):
            c["rerank_score"] = 1.0 - i * 0.1
        return reordered

    monkeypatch.setattr(retrieval_service_module, "rerank", fake_rerank)
    svc = KnowledgeRetrievalService(db, rag=FakeRag())
    result = await svc.retrieve_chunks("ReAct范式", threshold=1, include_rag=False)
    assert result["decision"] == "mysql"
    assert [c["chunk_id"] for c in result["chunks"]] == [2, 1]
    assert result["chunks"][0]["rerank_score"] == 1.0


@pytest.mark.asyncio
async def test_rerank_on_but_endpoint_unconfigured_is_noop(db: AsyncSession, monkeypatch):
    """开关 on 但未配置端点：reranker.rerank() 内部 no-op，检索结果顺序不变."""
    _fake_settings(monkeypatch, KNOWLEDGE_RERANK=True, RERANKER_API_URL="")
    svc = KnowledgeRetrievalService(db, rag=FakeRag())
    result = await svc.retrieve_chunks("ReAct范式", threshold=1, include_rag=False)
    assert [c["chunk_id"] for c in result["chunks"]] == [1, 2]
    assert "rerank_score" not in result["chunks"][0]
