"""graph-sync 测试：diff 候选生成、缓存命中零调用、LLM 判定写回、孤儿边清理.

复用 test_prerequisite_graph 的目录树种子；LLM 用 FakeJudge 模拟。
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
]

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


class FakeJudge(PrerequisiteJudge):
    """可编程 fake：verdicts 为 (prereq_id, target_id) -> bool；记录调用次数."""

    def __init__(self, verdicts: dict | None = None, disabled: bool = False):
        self.verdicts = verdicts or {}
        self.disabled = disabled
        self.calls = 0

    async def judge_pairs(self, chapter_name: str, pairs: list[dict]) -> list[dict] | None:
        self.calls += 1
        if self.disabled:
            return None
        return [
            {
                **p,
                "is_prerequisite": self.verdicts.get((p["prereq_id"], p["target_id"]), False),
                "confidence": 0.9,
                "rationale": "fake-judge",
            }
            for p in pairs
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


def make_sync(db_session, judge, tmp_path):
    return GraphSyncService(db_session, judge=judge, cache_path=tmp_path / "cache.json")


async def count_edges(db_session: AsyncSession, status: str | None = None) -> list[tuple[int, int, str]]:
    where = ""
    if status:
        where = f" WHERE status = '{status}'"
    result = await db_session.execute(
        text(f"SELECT prereq_category_id, category_id, status FROM knowledge_category_prerequisite{where}")
    )
    return [(r[0], r[1], r[2]) for r in result.fetchall()]


@pytest.mark.asyncio
async def test_sync_adds_proposed_edges(db_session, tmp_path):
    """LLM 判 10→11 为先修 → 写入 proposed 边 + 缓存."""
    judge = FakeJudge(verdicts={(10, 11): True})
    sync = make_sync(db_session, judge, tmp_path)
    report = await sync.run_sync(1)

    assert report.candidates >= 6  # 同章 3 对 + 章节→知识点 3 条
    assert report.added == 1
    assert judge.calls >= 1
    edges = await count_edges(db_session, "proposed")
    assert (10, 11, "proposed") in edges
    # 缓存已写入
    assert sync._cache["10:11"]["is_prerequisite"] is True


@pytest.mark.asyncio
async def test_sync_cache_hit_no_llm_calls(db_session, tmp_path):
    """第二次 sync：缓存命中，零 LLM 调用，不重复建边."""
    judge = FakeJudge(verdicts={(10, 11): True})
    sync1 = make_sync(db_session, judge, tmp_path)
    r1 = await sync1.run_sync(1)
    assert r1.llm_calls >= 1

    # 新 sync 实例（同一 cache 文件）重跑
    judge2 = FakeJudge(verdicts={})
    sync2 = make_sync(db_session, judge2, tmp_path)
    r2 = await sync2.run_sync(1)
    assert r2.cache_hits >= 1
    assert judge2.calls == 0  # 全缓存命中，零 LLM 调用
    edges = await count_edges(db_session, "proposed")
    assert (10, 11, "proposed") in edges


@pytest.mark.asyncio
async def test_sync_skips_existing_and_rejected(db_session, tmp_path):
    """已存在边（active/proposed/rejected）不生成候选."""
    # 手工建 active（10→11）和 rejected（10→12）
    await db_session.execute(text(
        "INSERT INTO knowledge_category_prerequisite "
        "(domain_id, category_id, prereq_category_id, edge_type, status, source) "
        "VALUES (1, 11, 10, 'prerequisite', 'active', 'human'), "
        "(1, 12, 10, 'prerequisite', 'rejected', 'human')"
    ))
    await db_session.commit()

    judge = FakeJudge(verdicts={})
    sync = make_sync(db_session, judge, tmp_path)
    report = await sync.run_sync(1)

    # 候选只剩 11→12（10→11/10→12 已有）+ 章节边 2→10/11/12
    assert report.candidates == 4
    assert report.added == 0


@pytest.mark.asyncio
async def test_sync_deprecates_orphan_edges(db_session, tmp_path):
    """边引用已删除的 category → deprecated."""
    await db_session.execute(text(
        "INSERT INTO knowledge_category_prerequisite "
        "(domain_id, category_id, prereq_category_id, edge_type, status, source) "
        "VALUES (1, 999, 10, 'prerequisite', 'active', 'human')"
    ))
    await db_session.commit()

    sync = make_sync(db_session, FakeJudge(verdicts={}), tmp_path)
    report = await sync.run_sync(1)
    assert report.orphan_edges_deprecated == 1
    edges = await count_edges(db_session, "deprecated")
    assert (10, 999, "deprecated") in edges


@pytest.mark.asyncio
async def test_sync_llm_disabled_graceful(db_session, tmp_path):
    """LLM 不可用（返回 None）→ 跳过不写入，不中断."""
    sync = make_sync(db_session, FakeJudge(verdicts={}, disabled=True), tmp_path)
    report = await sync.run_sync(1)
    assert report.added == 0
    assert report.llm_calls >= 1
    assert len(await count_edges(db_session)) == 0


@pytest.mark.asyncio
async def test_sync_duplicate_pair_idempotent(db_session, tmp_path):
    """重复跑 sync（已有 proposed 边）不重复建边（幂等）."""
    judge = FakeJudge(verdicts={(10, 11): True})
    sync = make_sync(db_session, judge, tmp_path)
    r1 = await sync.run_sync(1)
    r2 = await sync.run_sync(1)
    assert r1.added == 1
    assert r2.added == 0  # 已有边跳过
    edges = await count_edges(db_session, "proposed")
    assert len([e for e in edges if e[0] == 10 and e[1] == 11]) == 1


@pytest.mark.asyncio
async def test_sync_new_category_reported(db_session, tmp_path):
    """新增知识点（无边）在报告中标记."""
    # 已有 active 边覆盖 10/11，12 是新增
    await db_session.execute(text(
        "INSERT INTO knowledge_category_prerequisite "
        "(domain_id, category_id, prereq_category_id, edge_type, status, source) "
        "VALUES (1, 11, 10, 'prerequisite', 'active', 'human')"
    ))
    await db_session.commit()
    sync = make_sync(db_session, FakeJudge(verdicts={}), tmp_path)
    report = await sync.run_sync(1)
    # 无任何边的节点：12（知识点）+ 3（章节 ch5）
    assert report.new_categories >= 2
