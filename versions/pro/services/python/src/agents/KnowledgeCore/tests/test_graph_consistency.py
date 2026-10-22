"""GraphService.consistency_score / consistency_detail 测试（T1.2）.

覆盖手册验收场景：A→B 先修边、证据全在 A、问题在 B → 一跳 0.8；
证据与问题同知识点 → 1.0；空图 → 0.8（兼容旧写死常量）。
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.services.graph_service import (
    GRAPH_CONSISTENCY_DEFAULT_SCORE,
    GraphService,
)

DDL = """
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
    created_by VARCHAR(64),
    created_at TEXT,
    updated_at TEXT,
    UNIQUE (category_id, prereq_category_id)
)
"""


@pytest_asyncio.fixture
async def prereq_db(db_session: AsyncSession):
    await db_session.execute(text("DROP TABLE IF EXISTS knowledge_category_prerequisite"))
    await db_session.execute(text(DDL))
    await db_session.commit()
    yield db_session
    await db_session.execute(text("DROP TABLE IF EXISTS knowledge_category_prerequisite"))
    await db_session.commit()


async def add_edge(db: AsyncSession, category_id: int, prereq_category_id: int, status: str = "active"):
    await db.execute(
        text(
            "INSERT INTO knowledge_category_prerequisite "
            "(domain_id, category_id, prereq_category_id, edge_type, status, source) "
            "VALUES (1, :cat, :prereq, 'prerequisite', :status, 'human')"
        ),
        {"cat": category_id, "prereq": prereq_category_id, "status": status},
    )
    await db.commit()


@pytest.mark.asyncio
async def test_one_hop_via_prerequisite_edge(prereq_db: AsyncSession):
    """A→B 先修边，证据全在 A、问题在 B → 一跳 0.8."""
    await add_edge(prereq_db, category_id=2, prereq_category_id=1)  # 1(A) → 2(B)
    svc = GraphService(prereq_db)
    score = await svc.consistency_score([1], 2)
    assert score == pytest.approx(0.8)


@pytest.mark.asyncio
async def test_same_category_is_fully_consistent(prereq_db: AsyncSession):
    """证据与问题同知识点 → 1.0."""
    await add_edge(prereq_db, category_id=2, prereq_category_id=1)
    svc = GraphService(prereq_db)
    score = await svc.consistency_score([5], 5)
    assert score == pytest.approx(1.0)


@pytest.mark.asyncio
async def test_empty_graph_returns_default(prereq_db: AsyncSession):
    """空图（无任何边）→ 兼容默认值 0.8."""
    svc = GraphService(prereq_db)
    score = await svc.consistency_score([1], 2)
    assert score == pytest.approx(GRAPH_CONSISTENCY_DEFAULT_SCORE)
    assert score == pytest.approx(0.8)


@pytest.mark.asyncio
async def test_query_failure_returns_default(db_session: AsyncSession):
    """表不存在（查询失败）→ 兼容默认值 0.8，不抛异常."""
    await db_session.execute(text("DROP TABLE IF EXISTS knowledge_category_prerequisite"))
    await db_session.commit()
    svc = GraphService(db_session)
    score = await svc.consistency_score([1], 2)
    assert score == pytest.approx(0.8)


@pytest.mark.asyncio
async def test_two_hop_distance(prereq_db: AsyncSession):
    """A→B→C 链，证据在 A、问题在 C → 二跳 0.6."""
    await add_edge(prereq_db, category_id=2, prereq_category_id=1)  # 1 → 2
    await add_edge(prereq_db, category_id=3, prereq_category_id=2)  # 2 → 3
    svc = GraphService(prereq_db)
    score = await svc.consistency_score([1], 3)
    assert score == pytest.approx(0.6)


@pytest.mark.asyncio
async def test_no_path_returns_low_score(prereq_db: AsyncSession):
    """图非空但证据与目标不连通 → 无路径 0.3."""
    await add_edge(prereq_db, category_id=2, prereq_category_id=1)
    svc = GraphService(prereq_db)
    score = await svc.consistency_score([99], 2)
    assert score == pytest.approx(0.3)


@pytest.mark.asyncio
async def test_average_across_multiple_evidence(prereq_db: AsyncSession):
    """多条证据取均值：一跳(0.8) 与同点(1.0) 均值 0.9."""
    await add_edge(prereq_db, category_id=2, prereq_category_id=1)
    svc = GraphService(prereq_db)
    score = await svc.consistency_score([1, 2], 2)
    assert score == pytest.approx(0.9)


@pytest.mark.asyncio
async def test_no_target_category_returns_default(prereq_db: AsyncSession):
    """目标未知（target_category_id=None）→ 默认值 0.8."""
    svc = GraphService(prereq_db)
    score = await svc.consistency_score([1], None)
    assert score == pytest.approx(0.8)


@pytest.mark.asyncio
async def test_consistency_detail_shape(prereq_db: AsyncSession):
    """consistency_detail 返回每条证据的距离明细，供 audit_trail 展示."""
    await add_edge(prereq_db, category_id=2, prereq_category_id=1)
    svc = GraphService(prereq_db)
    detail = await svc.consistency_detail([1, 2], 2)
    by_cat = {d["evidence_category_id"]: d for d in detail}
    assert by_cat[1]["distance"] == 1
    assert by_cat[1]["score"] == pytest.approx(0.8)
    assert by_cat[2]["distance"] == 0
    assert by_cat[2]["score"] == pytest.approx(1.0)


@pytest.mark.asyncio
async def test_consistency_detail_empty_when_no_target(prereq_db: AsyncSession):
    """无目标/无证据 → 明细为空列表（区别于"已算出但无路径"）."""
    svc = GraphService(prereq_db)
    assert await svc.consistency_detail([], 2) == []
    assert await svc.consistency_detail([1], None) == []
