"""交接遗留项 c：graph_sync.py 接入 knowledge_chunk_enrichment 的 defines/uses

→ candidate_generator.build_evidence_candidates() / extract_bracket_aliases()
（T3.2 自动化编排，此前"能力就绪但未接线"）.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.services.graph_sync import GraphSyncService
from app.graph.services.prerequisite_llm import PrerequisiteJudge

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
    """
    CREATE TABLE IF NOT EXISTS knowledge_chunk_category (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id INTEGER, category_id INTEGER,
        relation_type VARCHAR(32), confidence DECIMAL(5,4), source VARCHAR(32)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS knowledge_chunk_enrichment (
        chunk_id INTEGER PRIMARY KEY,
        defines_json TEXT, uses_json TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS knowledge_category_alias (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL,
        alias VARCHAR(255) NOT NULL,
        source VARCHAR(32) NOT NULL DEFAULT 'manual',
        created_at TEXT,
        UNIQUE (category_id, alias)
    )
    """,
]

# 同 test_graph_sync.py 的目录树：ch4(2) 下 10(ReAct) 11(Plan) 12(Reflection)；ch5(3) 独立
SEED = [
    "INSERT INTO knowledge_domain (id, code, name) VALUES (1, 'agent', '智能体')",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, description, level, node_type, sort_order) "
    "VALUES (1, 1, NULL, 'construction', '智能体构建', '', 1, 'category', 1)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, description, level, node_type, sort_order) "
    "VALUES (2, 1, 1, 'ch4', '第四章 经典范式', '范式章节', 2, 'category', 1)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, description, level, node_type, sort_order) "
    "VALUES (3, 1, 1, 'ch5', '第五章 低代码平台', '低代码', 2, 'category', 2)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, description, level, node_type, sort_order) "
    "VALUES (10, 1, 2, 'kp-react', 'ReAct范式', '思考行动观察', 3, 'knowledge_point', 1)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, description, level, node_type, sort_order) "
    "VALUES (11, 1, 2, 'kp-plan', 'Plan-and-Solve', '规划执行分离', 3, 'knowledge_point', 2)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, description, level, node_type, sort_order) "
    "VALUES (12, 1, 2, 'kp-reflect', 'Reflection', '自我反思', 3, 'knowledge_point', 3)",
]

TABLES = (
    "knowledge_category_alias",
    "knowledge_chunk_enrichment",
    "knowledge_chunk_category",
    "knowledge_category_prerequisite",
    "knowledge_category",
    "knowledge_domain",
)


class FakeJudge(PrerequisiteJudge):
    """结构候选一律判 false（本测试只关心证据通道，不希望结构候选掺进来干扰计数）."""

    def __init__(self):
        self.calls = 0

    async def judge_pairs(self, chapter_name: str, pairs: list[dict]) -> list[dict] | None:
        self.calls += 1
        return [{**p, "is_prerequisite": False, "confidence": 0.1, "rationale": ""} for p in pairs]


@pytest_asyncio.fixture
async def evidence_db(db_session: AsyncSession):
    for t in TABLES:
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    for ddl in DDL:
        await db_session.execute(text(ddl))
    for sql in SEED:
        await db_session.execute(text(sql))
    await db_session.commit()
    yield db_session
    for t in TABLES:
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    await db_session.commit()


def make_sync(db_session, tmp_path, judge=None):
    return GraphSyncService(db_session, judge=judge or FakeJudge(), cache_path=tmp_path / "cache.json")


async def get_edges(db_session: AsyncSession) -> list[dict]:
    rows = (
        await db_session.execute(
            text(
                "SELECT prereq_category_id, category_id, status, source, evidence_json "
                "FROM knowledge_category_prerequisite"
            )
        )
    ).mappings().all()
    return [dict(r) for r in rows]


@pytest.mark.asyncio
async def test_sync_wires_evidence_candidates_from_enrichment(evidence_db: AsyncSession, tmp_path):
    """chunk 挂 ReAct(10)/Plan(11)，enrichment 记录跨知识点概念共现 → 证据候选边（proposed）."""
    await evidence_db.execute(
        text(
            "INSERT INTO knowledge_chunk_category (chunk_id, category_id, confidence, source) "
            "VALUES (101, 10, 0.9, 'llm'), (102, 11, 0.9, 'llm')"
        )
    )
    await evidence_db.execute(
        text(
            "INSERT INTO knowledge_chunk_enrichment (chunk_id, defines_json, uses_json) VALUES "
            "(101, '[\"思考-行动循环\"]', '[]'), "
            "(102, '[]', '[\"思考-行动循环\"]')"
        )
    )
    await evidence_db.commit()

    sync = make_sync(evidence_db, tmp_path)
    report = await sync.run_sync(1)

    assert report.evidence_edges_added == 1
    edges = await get_edges(evidence_db)
    evidence_edge = next(
        e for e in edges if e["prereq_category_id"] == 10 and e["category_id"] == 11
    )
    assert evidence_edge["status"] == "proposed"
    assert evidence_edge["source"] == "llm"
    assert evidence_edge["evidence_json"] is not None
    import json as _json

    evidence_payload = _json.loads(evidence_edge["evidence_json"])
    assert evidence_payload["concept"] == "思考-行动循环"
    assert evidence_payload["def_chunk"] == 101
    assert evidence_payload["use_chunk"] == 102


@pytest.mark.asyncio
async def test_sync_wires_bracket_alias_extraction(evidence_db: AsyncSession, tmp_path):
    """defines 中形如 "X（Y)" 的括注 → 写入 knowledge_category_alias(source=definition_extract)."""
    await evidence_db.execute(
        text(
            "INSERT INTO knowledge_chunk_category (chunk_id, category_id, confidence, source) "
            "VALUES (201, 10, 0.9, 'llm')"
        )
    )
    await evidence_db.execute(
        text(
            "INSERT INTO knowledge_chunk_enrichment (chunk_id, defines_json, uses_json) VALUES "
            "(201, '[\"思考-行动循环（ReAct)\"]', '[]')"
        )
    )
    await evidence_db.commit()

    sync = make_sync(evidence_db, tmp_path)
    report = await sync.run_sync(1)

    assert report.aliases_added == 1
    row = (
        await evidence_db.execute(
            text("SELECT category_id, alias, source FROM knowledge_category_alias")
        )
    ).mappings().first()
    assert row["category_id"] == 10
    assert row["alias"] == "ReAct"
    assert row["source"] == "definition_extract"


@pytest.mark.asyncio
async def test_sync_alias_write_idempotent(evidence_db: AsyncSession, tmp_path):
    """重复 sync 不重复插入别名（UNIQUE(category_id, alias) 幂等）."""
    await evidence_db.execute(
        text(
            "INSERT INTO knowledge_chunk_category (chunk_id, category_id, confidence, source) "
            "VALUES (201, 10, 0.9, 'llm')"
        )
    )
    await evidence_db.execute(
        text(
            "INSERT INTO knowledge_chunk_enrichment (chunk_id, defines_json, uses_json) VALUES "
            "(201, '[\"思考-行动循环（ReAct)\"]', '[]')"
        )
    )
    await evidence_db.commit()

    sync1 = make_sync(evidence_db, tmp_path)
    r1 = await sync1.run_sync(1)
    assert r1.aliases_added == 1

    sync2 = make_sync(evidence_db, tmp_path)
    r2 = await sync2.run_sync(1)
    assert r2.aliases_added == 0  # 已存在，INSERT IGNORE 无新增行

    count = (
        await evidence_db.execute(text("SELECT COUNT(*) FROM knowledge_category_alias"))
    ).scalar()
    assert count == 1


@pytest.mark.asyncio
async def test_sync_enrichment_table_missing_degrades_silently(db_session: AsyncSession, tmp_path):
    """enrichment 表不存在（predeal T3.1 未迁移）→ 静默跳过，不影响 run_sync 主流程/其余候选."""
    for t in TABLES:
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    for ddl in DDL:
        if "knowledge_chunk_enrichment" in ddl:
            continue
        await db_session.execute(text(ddl))
    for sql in SEED:
        await db_session.execute(text(sql))
    await db_session.commit()

    sync = make_sync(db_session, tmp_path)
    report = await sync.run_sync(1)
    assert report.evidence_edges_added == 0
    assert report.aliases_added == 0
    # 结构候选仍正常跑（enrichment 缺失不影响主流程）
    assert report.candidates >= 6

    for t in TABLES:
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    await db_session.commit()


@pytest.mark.asyncio
async def test_sync_no_enrichment_rows_for_domain_is_no_op(evidence_db: AsyncSession, tmp_path):
    """enrichment 表存在但该领域无数据 → evidence_edges_added/aliases_added 均为 0，不报错."""
    sync = make_sync(evidence_db, tmp_path)
    report = await sync.run_sync(1)
    assert report.evidence_edges_added == 0
    assert report.aliases_added == 0
