"""T4.4：contrasts_with 易混淆边 —— 候选生成 / 建边 / LLM 把关 / 查询."""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.services.candidate_generator import (
    CategoryRow,
    ChunkConceptRow,
    build_contrast_candidates,
)
from app.graph.services.contrast_service import ContrastSyncService
from app.graph.services.prerequisite_service import (
    EDGE_TYPES,
    STATUSES,
    InvalidEdgeError,
    PrerequisiteService,
)

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
    CREATE TABLE IF NOT EXISTS knowledge_category_prerequisite (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain_id INTEGER NOT NULL,
        category_id INTEGER NOT NULL,
        prereq_category_id INTEGER NOT NULL,
        edge_type VARCHAR(32) NOT NULL DEFAULT 'prerequisite',
        source_domain_id INTEGER,
        confidence DECIMAL(5,4) NOT NULL DEFAULT 1.0,
        rationale TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'proposed',
        source VARCHAR(32) NOT NULL DEFAULT 'agent',
        evidence_json TEXT,
        created_by VARCHAR(64),
        created_at TEXT,
        updated_at TEXT,
        UNIQUE (category_id, prereq_category_id)
    )
    """,
]

# domain 1；ReAct(10) / Plan-and-Solve(11) / Reflection(12) 三个 level3 知识点同章
SEED = [
    "INSERT INTO knowledge_domain (id, code, name) VALUES (1, 'agent', '智能体')",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (1, 1, NULL, 'construction', '智能体构建', 1, 'category', 1)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (2, 1, 1, 'ch4', '第四章 经典范式', 2, 'category', 1)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (10, 1, 2, 'kp-react', 'ReAct范式', 3, 'knowledge_point', 1)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (11, 1, 2, 'kp-plan', 'Plan-and-Solve', 3, 'knowledge_point', 2)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (12, 1, 2, 'kp-reflect', 'Reflection', 3, 'knowledge_point', 3)",
]


@pytest_asyncio.fixture(autouse=True)
async def setup_db(db_session: AsyncSession):
    for t in ("knowledge_category_prerequisite", "knowledge_category", "knowledge_domain"):
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    for ddl in DDL:
        await db_session.execute(text(ddl))
    for sql in SEED:
        await db_session.execute(text(sql))
    await db_session.commit()
    yield
    for t in ("knowledge_category_prerequisite", "knowledge_category", "knowledge_domain"):
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    await db_session.commit()


class FakeContrastJudge:
    """T4.4：mock LLM 判定器（端到端测试不打真实网络）."""

    def __init__(self, verdicts: dict[int, bool] | None = None, confidence: float = 0.8, fail: bool = False):
        self.verdicts = verdicts or {}
        self.confidence = confidence
        self.fail = fail
        self.calls: list[list[dict]] = []

    async def judge_pairs(self, pairs: list[dict]):
        self.calls.append(pairs)
        if self.fail:
            raise RuntimeError("mock LLM 故障")
        return [
            {
                **p,
                "is_contrast": self.verdicts.get(i, True),
                "confidence": self.confidence,
                "rationale": "mock rationale",
            }
            for i, p in enumerate(pairs)
        ]


# ── candidate_generator.build_contrast_candidates ───────────────────────────


def test_build_contrast_candidates_from_co_occurrence():
    """两个不同知识点各自 defines 一个概念，第三方 chunk 同时 uses 两者 → 生成候选对."""
    rows = [
        ChunkConceptRow(chunk_id=1, category_id=10, defines=["思考-行动循环"], uses=[]),
        ChunkConceptRow(chunk_id=2, category_id=11, defines=["规划-执行分离"], uses=[]),
        ChunkConceptRow(
            chunk_id=3, category_id=12,
            defines=[], uses=["思考-行动循环", "规划-执行分离"],
        ),
    ]
    lookup = {
        10: CategoryRow(id=10, domain_id=1, parent_id=2, name="ReAct范式"),
        11: CategoryRow(id=11, domain_id=1, parent_id=2, name="Plan-and-Solve"),
    }
    candidates = build_contrast_candidates(rows, category_lookup=lookup)
    assert len(candidates) == 1
    cand = candidates[0]
    assert {cand.a_id, cand.b_id} == {10, 11}
    assert cand.evidence == {"co_occurrence_chunk": 3}
    assert "ReAct" in cand.a_name or "ReAct" in cand.b_name


def test_build_contrast_candidates_skips_existing_pairs():
    """existing_pairs 命中（任意方向）→ 不重复生成候选."""
    rows = [
        ChunkConceptRow(chunk_id=1, category_id=10, defines=["X"], uses=[]),
        ChunkConceptRow(chunk_id=2, category_id=11, defines=["Y"], uses=[]),
        ChunkConceptRow(chunk_id=3, category_id=12, defines=[], uses=["X", "Y"]),
    ]
    candidates = build_contrast_candidates(rows, existing_pairs={(11, 10)})
    assert candidates == []


def test_build_contrast_candidates_ignores_same_category_use():
    """概念在同知识点内定义即用 → 不构成候选（无跨知识点混淆信号）."""
    rows = [
        ChunkConceptRow(chunk_id=1, category_id=10, defines=["X"], uses=["X"]),
    ]
    assert build_contrast_candidates(rows) == []


# ── prerequisite_service：contrasts_with 边类型 ─────────────────────────────


def test_contrasts_with_in_edge_types_and_statuses():
    assert "contrasts_with" in EDGE_TYPES
    assert "needs_review" in STATUSES


@pytest.mark.asyncio
async def test_contrasts_with_defaults_to_proposed(db_session: AsyncSession):
    """contrasts_with 边默认 proposed（与 related 不同，需人工审核才生效）."""
    svc = PrerequisiteService(db_session)
    edge, warnings = await svc.add_prerequisite(
        category_id=11, prereq_category_id=10, domain_id=1,
        edge_type="contrasts_with", source="llm",
        evidence_json={"co_occurrence_chunk": 3},
    )
    assert edge.status == "proposed"
    assert edge.edge_type == "contrasts_with"
    assert warnings == []
    assert edge.evidence_json == {"co_occurrence_chunk": 3}


@pytest.mark.asyncio
async def test_contrasts_with_direct_active(db_session: AsyncSession):
    """direct_active=True → 直接 active（人工确认场景）."""
    svc = PrerequisiteService(db_session)
    edge, _ = await svc.add_prerequisite(
        category_id=11, prereq_category_id=10, domain_id=1,
        edge_type="contrasts_with", source="human", direct_active=True,
    )
    assert edge.status == "active"


@pytest.mark.asyncio
async def test_contrasts_with_skips_direction_and_ancestor_check(db_session: AsyncSession):
    """对称关系：不受方向白名单/祖先环检测约束（同一对反向也能各自建边，不视为成环）."""
    svc = PrerequisiteService(db_session)
    # 10 sort_order(1) < 11 sort_order(2)：若是 prerequisite 边，11→10 会被防线1拒绝；
    # contrasts_with 无方向语义，不受此限制。
    edge, _ = await svc.add_prerequisite(
        category_id=10, prereq_category_id=11, domain_id=1,
        edge_type="contrasts_with", source="llm",
    )
    assert edge.status == "proposed"


# ── PrerequisiteService.list_contrasts ──────────────────────────────────────


@pytest.mark.asyncio
async def test_list_contrasts_only_active(db_session: AsyncSession):
    """只返回 active 边；proposed 候选不出现在出题干扰项数据源里."""
    svc = PrerequisiteService(db_session)
    await svc.add_prerequisite(
        category_id=11, prereq_category_id=10, domain_id=1,
        edge_type="contrasts_with", source="llm",
    )  # 仍是 proposed
    contrasts = await svc.list_contrasts(10)
    assert contrasts == []

    await svc.add_prerequisite(
        category_id=12, prereq_category_id=10, domain_id=1,
        edge_type="contrasts_with", source="human", direct_active=True,
    )
    contrasts = await svc.list_contrasts(10)
    assert len(contrasts) == 1
    assert contrasts[0]["category_id"] == 12
    assert contrasts[0]["name"] == "Reflection"


@pytest.mark.asyncio
async def test_list_contrasts_symmetric_both_directions(db_session: AsyncSession):
    """无论边存成 (a,b) 还是 (b,a)，list_contrasts(a) 与 list_contrasts(b) 都能看到对方."""
    svc = PrerequisiteService(db_session)
    await svc.add_prerequisite(
        category_id=11, prereq_category_id=10, domain_id=1,
        edge_type="contrasts_with", source="human", direct_active=True,
    )
    assert [c["category_id"] for c in await svc.list_contrasts(10)] == [11]
    assert [c["category_id"] for c in await svc.list_contrasts(11)] == [10]


# ── ContrastSyncService：候选 + LLM 把关 + 写入 ──────────────────────────────


@pytest.mark.asyncio
async def test_contrast_sync_writes_proposed_edges_on_yes_verdict(db_session: AsyncSession):
    rows = [
        ChunkConceptRow(chunk_id=1, category_id=10, defines=["思考-行动循环"], uses=[]),
        ChunkConceptRow(chunk_id=2, category_id=11, defines=["规划-执行分离"], uses=[]),
        ChunkConceptRow(chunk_id=3, category_id=12, defines=[], uses=["思考-行动循环", "规划-执行分离"]),
    ]
    lookup = {
        10: CategoryRow(id=10, domain_id=1, parent_id=2, name="ReAct范式"),
        11: CategoryRow(id=11, domain_id=1, parent_id=2, name="Plan-and-Solve"),
    }
    judge = FakeContrastJudge(verdicts={0: True})
    svc = ContrastSyncService(db_session, judge=judge)
    report = await svc.sync_contrasts(rows, domain_id=1, category_lookup=lookup)

    assert report.candidates == 1
    assert report.judged_yes == 1
    assert report.added == 1
    assert judge.calls  # LLM 确实被调用（mock）

    edges = await PrerequisiteService(db_session).list_edges(domain_id=1, edge_type="contrasts_with")
    assert len(edges) == 1
    assert edges[0].status == "proposed"
    assert edges[0].source == "llm"
    assert edges[0].evidence_json == {"co_occurrence_chunk": 3}


@pytest.mark.asyncio
async def test_contrast_sync_skips_on_no_verdict(db_session: AsyncSession):
    """LLM 判定 is_contrast=False → 不建边."""
    rows = [
        ChunkConceptRow(chunk_id=1, category_id=10, defines=["X"], uses=[]),
        ChunkConceptRow(chunk_id=2, category_id=11, defines=["Y"], uses=[]),
        ChunkConceptRow(chunk_id=3, category_id=12, defines=[], uses=["X", "Y"]),
    ]
    judge = FakeContrastJudge(verdicts={0: False})
    svc = ContrastSyncService(db_session, judge=judge)
    report = await svc.sync_contrasts(rows, domain_id=1)
    assert report.candidates == 1
    assert report.judged_yes == 0
    assert report.added == 0

    edges = await PrerequisiteService(db_session).list_edges(domain_id=1, edge_type="contrasts_with")
    assert edges == []


@pytest.mark.asyncio
async def test_contrast_sync_llm_failure_writes_nothing(db_session: AsyncSession):
    """LLM 调用异常 → 宁缺毋滥，不写任何边，report 记录 skipped 原因."""
    rows = [
        ChunkConceptRow(chunk_id=1, category_id=10, defines=["X"], uses=[]),
        ChunkConceptRow(chunk_id=2, category_id=11, defines=["Y"], uses=[]),
        ChunkConceptRow(chunk_id=3, category_id=12, defines=[], uses=["X", "Y"]),
    ]
    judge = FakeContrastJudge(fail=True)
    svc = ContrastSyncService(db_session, judge=judge)
    report = await svc.sync_contrasts(rows, domain_id=1)
    assert report.added == 0
    assert report.skipped

    edges = await PrerequisiteService(db_session).list_edges(domain_id=1, edge_type="contrasts_with")
    assert edges == []


@pytest.mark.asyncio
async def test_contrast_sync_no_candidates_short_circuits(db_session: AsyncSession):
    """无候选（无共现信号）→ 不调用 LLM，report 全零."""
    judge = FakeContrastJudge()
    svc = ContrastSyncService(db_session, judge=judge)
    report = await svc.sync_contrasts([], domain_id=1)
    assert report.candidates == 0
    assert report.added == 0
    assert not judge.calls


@pytest.mark.asyncio
async def test_add_prerequisite_rejects_unknown_edge_type(db_session: AsyncSession):
    svc = PrerequisiteService(db_session)
    with pytest.raises(InvalidEdgeError):
        await svc.add_prerequisite(
            category_id=11, prereq_category_id=10, domain_id=1, edge_type="bogus_type"
        )
