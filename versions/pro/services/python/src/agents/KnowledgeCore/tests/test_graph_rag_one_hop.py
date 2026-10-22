"""T4.5：GraphRAG 一跳 —— GraphService.direct_prerequisites /

retrieval_service.prerequisite_evidence_chunks / decision_service.resolve() 接线.
"""

from __future__ import annotations

import types
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.decision.services import decision_service as decision_service_module
from app.decision.services.decision_service import DecisionService
from app.graph.services.graph_service import GraphService
from app.knowledge.services.retrieval_service import KnowledgeRetrievalService

from tests.test_knowledge_retrieval import DDL, SEED, FakeRag

PREREQ_DDL = """
CREATE TABLE IF NOT EXISTS knowledge_category_prerequisite (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id INTEGER NOT NULL,
    category_id INTEGER NOT NULL,
    prereq_category_id INTEGER NOT NULL,
    edge_type VARCHAR(32) NOT NULL DEFAULT 'prerequisite',
    confidence DECIMAL(5,4) NOT NULL DEFAULT 1.0,
    status VARCHAR(20) NOT NULL DEFAULT 'proposed',
    source VARCHAR(32) NOT NULL DEFAULT 'human',
    UNIQUE (category_id, prereq_category_id)
)
"""

ENRICHMENT_DDL = """
CREATE TABLE IF NOT EXISTS knowledge_chunk_enrichment (
    chunk_id INTEGER PRIMARY KEY,
    defines_json TEXT,
    uses_json TEXT
)
"""


@pytest_asyncio.fixture
async def knowledge_db(db_session: AsyncSession):
    """建 knowledge 四表 + knowledge_category_prerequisite + 灌种子数据."""
    for ddl in DDL:
        await db_session.execute(text(ddl))
    await db_session.execute(text("DROP TABLE IF EXISTS knowledge_category_prerequisite"))
    await db_session.execute(text(PREREQ_DDL))
    for stmt in SEED:
        await db_session.execute(text(stmt))
    await db_session.commit()
    yield db_session
    for table in (
        "knowledge_category_prerequisite",
        "knowledge_chunk_enrichment",
        "knowledge_chunk_category",
        "knowledge_chunk",
        "knowledge_category",
        "knowledge_document",
        "knowledge_domain",
    ):
        await db_session.execute(text(f"DROP TABLE IF EXISTS {table}"))
    await db_session.commit()


async def add_edge(db: AsyncSession, category_id: int, prereq_category_id: int, confidence: float = 0.9):
    await db.execute(
        text(
            "INSERT INTO knowledge_category_prerequisite "
            "(domain_id, category_id, prereq_category_id, edge_type, confidence, status, source) "
            "VALUES (1, :cat, :prereq, 'prerequisite', :conf, 'active', 'human')"
        ),
        {"cat": category_id, "prereq": prereq_category_id, "conf": confidence},
    )
    await db.commit()


def make_service(db: AsyncSession, rag_chunks: list[dict[str, Any]] | None = None) -> DecisionService:
    retriever = KnowledgeRetrievalService(db, rag=FakeRag(chunks=rag_chunks or []))
    return DecisionService(db, knowledge_retriever=retriever)


def _fake_settings(monkeypatch, **overrides) -> None:
    base = {"KNOWLEDGE_GRAPH_RAG": False}
    base.update(overrides)
    monkeypatch.setattr(
        decision_service_module, "get_settings", lambda: types.SimpleNamespace(**base)
    )


# ── GraphService.direct_prerequisites ───────────────────────────────────────


@pytest.mark.asyncio
async def test_direct_prerequisites_returns_active_edges_only(knowledge_db: AsyncSession):
    """category 3(ReAct) 的先修是 category 4(Plan-and-Solve)：只返回 active 边."""
    await add_edge(knowledge_db, category_id=3, prereq_category_id=4, confidence=0.85)
    # proposed 边不应出现
    await knowledge_db.execute(
        text(
            "INSERT INTO knowledge_category_prerequisite "
            "(domain_id, category_id, prereq_category_id, edge_type, confidence, status, source) "
            "VALUES (1, 3, 5, 'prerequisite', 0.5, 'proposed', 'llm')"
        )
    )
    await knowledge_db.commit()

    svc = GraphService(knowledge_db)
    result = await svc.direct_prerequisites(3)
    assert len(result) == 1
    assert result[0]["category_id"] == 4
    assert result[0]["name"] == "Plan-and-Solve"
    assert result[0]["confidence"] == pytest.approx(0.85)


@pytest.mark.asyncio
async def test_direct_prerequisites_missing_table_degrades_gracefully(db_session: AsyncSession):
    await db_session.execute(text("DROP TABLE IF EXISTS knowledge_category_prerequisite"))
    await db_session.commit()
    svc = GraphService(db_session)
    assert await svc.direct_prerequisites(3) == []


# ── retrieval_service.prerequisite_evidence_chunks ──────────────────────────


@pytest.mark.asyncio
async def test_prerequisite_evidence_chunks_basic(knowledge_db: AsyncSession):
    """category 4（Plan-and-Solve）只有一条切片（chunk 3）."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    chunks = await svc.prerequisite_evidence_chunks(4, limit=2)
    assert len(chunks) == 1
    assert chunks[0]["chunk_id"] == 3
    assert chunks[0]["source"] == "prerequisite"


@pytest.mark.asyncio
async def test_prerequisite_evidence_chunks_prefers_defines(knowledge_db: AsyncSession):
    """有 defines_json 的块优先于置信度更高但无 defines 的块."""
    await knowledge_db.execute(text(ENRICHMENT_DDL))
    # chunk 1 置信度更高(0.9)但无 defines；chunk 2 置信度略低(0.8)但有 defines
    await knowledge_db.execute(
        text("INSERT INTO knowledge_chunk_enrichment (chunk_id, defines_json) VALUES (2, '[\"ReAct\"]')")
    )
    await knowledge_db.commit()
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    chunks = await svc.prerequisite_evidence_chunks(3, limit=1)
    assert chunks[0]["chunk_id"] == 2


@pytest.mark.asyncio
async def test_prerequisite_evidence_chunks_enrichment_missing_degrades(knowledge_db: AsyncSession):
    """enrichment 表不存在 → 静默降级为普通置信度排序，不报错."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    chunks = await svc.prerequisite_evidence_chunks(3, limit=2)
    # category 3(ReAct) 切片：chunk1(0.9) chunk2(0.8) chunk6(0.75)，取 confidence 最高的两条
    assert [c["chunk_id"] for c in chunks] == [1, 2]


@pytest.mark.asyncio
async def test_prerequisite_evidence_chunks_limit_respected(knowledge_db: AsyncSession):
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    chunks = await svc.prerequisite_evidence_chunks(3, limit=1)
    assert len(chunks) == 1


# ── decision_service.resolve()：GraphRAG 一跳接线 ───────────────────────────


@pytest.mark.asyncio
async def test_graph_rag_off_by_default_no_prerequisite_chain(knowledge_db: AsyncSession):
    """默认 off：不查先修、不追加先修证据，行为与现状一致."""
    await add_edge(knowledge_db, category_id=3, prereq_category_id=4)
    service = make_service(knowledge_db)
    contract = await service.resolve(query="ReAct范式", dataset_ids=["ds_1"])

    steps = {s["step"]: s for s in contract["audit_trail"]}
    assert steps["prerequisite_chain"]["result"]["chain"] == []
    assert contract["evidence_count"] == 3  # 未追加先修证据
    assert not any(i["evidence_role"] == "prerequisite" for i in contract["evidence_items"])


@pytest.mark.asyncio
async def test_graph_rag_on_fills_prerequisite_chain_and_evidence(knowledge_db: AsyncSession, monkeypatch):
    """开关 on：FactSnapshot.prerequisite_chain 填充 1 跳先修；证据追加 prerequisite 项，
    总数 ≤3，且不影响已算出的 coverage_score（对照 off 时的值）."""
    await add_edge(knowledge_db, category_id=3, prereq_category_id=4, confidence=0.85)
    _fake_settings(monkeypatch, KNOWLEDGE_GRAPH_RAG=True)

    service = make_service(knowledge_db)
    contract = await service.resolve(query="ReAct范式", dataset_ids=["ds_1"])

    steps = {s["step"]: s for s in contract["audit_trail"]}
    chain = steps["prerequisite_chain"]["result"]["chain"]
    assert len(chain) == 1
    assert chain[0]["category_id"] == 4
    assert chain[0]["name"] == "Plan-and-Solve"

    prereq_items = [i for i in contract["evidence_items"] if i["evidence_role"] == "prerequisite"]
    assert len(prereq_items) == 1
    assert prereq_items[0]["chunk_id"] == "3"  # category 4 的唯一切片

    # coverage_score 与 off 时一致（3 条基础证据 → 1.0），先修证据不计入分子
    assert contract["coverage_score"] == pytest.approx(1.0)
    # evidence_count 从 3 变为 4（先修证据确实进入 evidence_items/citations 候选池）
    assert contract["evidence_count"] == 4


@pytest.mark.asyncio
async def test_graph_rag_on_no_prerequisite_edge_yields_empty_chain(knowledge_db: AsyncSession, monkeypatch):
    """开关 on 但目标知识点无先修边 → chain 为空，不追加证据，不报错."""
    _fake_settings(monkeypatch, KNOWLEDGE_GRAPH_RAG=True)
    service = make_service(knowledge_db)
    contract = await service.resolve(query="ReAct范式", dataset_ids=["ds_1"])

    steps = {s["step"]: s for s in contract["audit_trail"]}
    assert steps["prerequisite_chain"]["result"]["chain"] == []
    assert contract["evidence_count"] == 3
