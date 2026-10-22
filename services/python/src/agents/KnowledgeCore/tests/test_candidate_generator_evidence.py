"""T3.2 证据通道测试：defines/uses 概念共现 → 带证据的候选先修边 + 括注别名抽取.

覆盖：
- build_evidence_candidates 纯函数：跨知识点 join 生成 evidence；同知识点内定义即用不产出；
  已有边幂等跳过；同一 (prereq,target) 多概念命中只保留一条。
- extract_bracket_aliases 纯函数："X（Y)" 括注抽取，去重。
- 集成：证据候选走 PrerequisiteService.add_prerequisite 全套四道防线 —— 正常场景写为
  proposed 边并落库 evidence_json；已存在反向边导致成环场景仍被防线 2 拒绝（即便带证据）。
"""

from __future__ import annotations

import json

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.services.candidate_generator import (
    CandidatePair,
    CategoryRow,
    ChunkConceptRow,
    build_evidence_candidates,
    extract_bracket_aliases,
)
from app.graph.services.prerequisite_service import (
    CycleDetectedError,
    PrerequisiteService,
)

# ── 纯函数测试（无 DB） ──────────────────────────────────────────────────


def test_build_evidence_candidates_cross_category_join():
    """B 的 chunk uses 了 A 的 chunk defines 的概念 → A→B 候选边，带 evidence."""
    rows = [
        ChunkConceptRow(chunk_id=101, category_id=10, defines=["ReAct范式"], uses=[]),
        ChunkConceptRow(chunk_id=201, category_id=11, defines=[], uses=["ReAct范式"]),
    ]
    candidates = build_evidence_candidates(rows)
    assert len(candidates) == 1
    c = candidates[0]
    assert (c.prereq_id, c.target_id) == (10, 11)
    assert c.evidence == {"concept": "ReAct范式", "def_chunk": 101, "use_chunk": 201}


def test_build_evidence_candidates_same_category_no_pair():
    """同知识点内定义即用（自引用）不构成跨知识点先修证据."""
    rows = [
        ChunkConceptRow(chunk_id=1, category_id=10, defines=["概念A"], uses=["概念A"]),
    ]
    assert build_evidence_candidates(rows) == []


def test_build_evidence_candidates_skips_existing_edges():
    """已有有效边（幂等）→ 不重复生成候选."""
    rows = [
        ChunkConceptRow(chunk_id=1, category_id=10, defines=["X"], uses=[]),
        ChunkConceptRow(chunk_id=2, category_id=11, defines=[], uses=["X"]),
    ]
    # 兼容 build_candidates 同款三元组 existing_edges
    candidates = build_evidence_candidates(rows, existing_edges=[(10, 11, "prerequisite")])
    assert candidates == []
    # 也兼容纯二元组集合
    candidates2 = build_evidence_candidates(rows, existing_edges={(10, 11)})
    assert candidates2 == []


def test_build_evidence_candidates_dedup_multiple_concepts():
    """同一 (prereq,target) 被多个概念命中 → 只保留一条候选（首个命中的证据）."""
    rows = [
        ChunkConceptRow(chunk_id=1, category_id=10, defines=["X", "Y"], uses=[]),
        ChunkConceptRow(chunk_id=2, category_id=11, defines=[], uses=["X", "Y"]),
    ]
    candidates = build_evidence_candidates(rows)
    assert len(candidates) == 1
    assert (candidates[0].prereq_id, candidates[0].target_id) == (10, 11)


def test_build_evidence_candidates_fills_names_from_lookup():
    """提供 category_lookup 时补全 prereq_name/target_name."""
    rows = [
        ChunkConceptRow(chunk_id=1, category_id=10, defines=["X"], uses=[]),
        ChunkConceptRow(chunk_id=2, category_id=11, defines=[], uses=["X"]),
    ]
    lookup = {
        10: CategoryRow(id=10, domain_id=1, parent_id=2, name="ReAct范式"),
        11: CategoryRow(id=11, domain_id=1, parent_id=2, name="Plan-and-Solve"),
    }
    candidates = build_evidence_candidates(rows, category_lookup=lookup)
    assert candidates[0].prereq_name == "ReAct范式"
    assert candidates[0].target_name == "Plan-and-Solve"


def test_extract_bracket_aliases_basic():
    """defines 中 "X（Y)" 括注 → alias 候选（source=definition_extract）."""
    rows = [
        ChunkConceptRow(chunk_id=1, category_id=10, defines=["原子性（Atomicity)", "无括注概念"]),
    ]
    aliases = extract_bracket_aliases(rows)
    assert aliases == [
        {"category_id": 10, "alias": "Atomicity", "source": "definition_extract"}
    ]


def test_extract_bracket_aliases_dedup_same_category():
    """同一知识点重复出现同一括注 → 去重."""
    rows = [
        ChunkConceptRow(chunk_id=1, category_id=10, defines=["A（B)"]),
        ChunkConceptRow(chunk_id=2, category_id=10, defines=["A（B)"]),
    ]
    assert extract_bracket_aliases(rows) == [
        {"category_id": 10, "alias": "B", "source": "definition_extract"}
    ]


def test_extract_bracket_aliases_ascii_parens():
    """半角括号同样支持."""
    rows = [ChunkConceptRow(chunk_id=1, category_id=10, defines=["ACID(原子性一致性隔离性持久性)"])]
    aliases = extract_bracket_aliases(rows)
    assert aliases[0]["alias"] == "原子性一致性隔离性持久性"


# ── 集成：证据候选走四道防线（dag-design.md §5-§6） ─────────────────────

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


@pytest.mark.asyncio
async def test_evidence_candidate_written_as_proposed_edge_with_evidence(db_session: AsyncSession):
    """证据候选（10→11，defines/uses 命中）走 add_prerequisite → proposed 边 + evidence_json 落库."""
    rows = [
        ChunkConceptRow(chunk_id=101, category_id=10, defines=["ReAct范式"], uses=[]),
        ChunkConceptRow(chunk_id=201, category_id=11, defines=[], uses=["ReAct范式"]),
    ]
    candidates = build_evidence_candidates(rows)
    assert len(candidates) == 1
    pair: CandidatePair = candidates[0]

    svc = PrerequisiteService(db_session)
    edge, warnings = await svc.add_prerequisite(
        category_id=pair.target_id,
        prereq_category_id=pair.prereq_id,
        domain_id=1,
        edge_type="prerequisite",
        confidence=0.7,
        source="llm",
        created_by="graph-sync-evidence",
        evidence_json=pair.evidence,
    )
    assert edge.status == "proposed"
    assert edge.evidence_json == pair.evidence
    assert warnings == []

    row = (
        await db_session.execute(
            text("SELECT evidence_json, status FROM knowledge_category_prerequisite WHERE id = :id"),
            {"id": edge.id},
        )
    ).mappings().first()
    assert row["status"] == "proposed"
    stored = row["evidence_json"]
    if isinstance(stored, str):
        stored = json.loads(stored)
    assert stored == {"concept": "ReAct范式", "def_chunk": 101, "use_chunk": 201}


@pytest.mark.asyncio
async def test_evidence_candidate_still_blocked_by_cycle_gate(db_session: AsyncSession):
    """防线 2（祖先检查）对证据候选同样生效：已有反向边会导致成环 → 拒绝，即便带 evidence_json."""
    # 手工建立已生效的 11→10 边（模拟已有先修关系）
    await db_session.execute(
        text(
            "INSERT INTO knowledge_category_prerequisite "
            "(domain_id, category_id, prereq_category_id, edge_type, status, source) "
            "VALUES (1, 10, 11, 'prerequisite', 'active', 'human')"
        )
    )
    await db_session.commit()

    rows = [
        ChunkConceptRow(chunk_id=101, category_id=10, defines=["ReAct范式"], uses=[]),
        ChunkConceptRow(chunk_id=201, category_id=11, defines=[], uses=["ReAct范式"]),
    ]
    candidates = build_evidence_candidates(rows)
    pair = candidates[0]
    assert (pair.prereq_id, pair.target_id) == (10, 11)

    svc = PrerequisiteService(db_session)
    with pytest.raises(CycleDetectedError):
        await svc.add_prerequisite(
            category_id=pair.target_id,
            prereq_category_id=pair.prereq_id,
            domain_id=1,
            edge_type="prerequisite",
            confidence=0.7,
            source="llm",
            evidence_json=pair.evidence,
        )
