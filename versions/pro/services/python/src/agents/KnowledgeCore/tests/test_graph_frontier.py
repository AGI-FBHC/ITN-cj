"""GraphService.learning_frontier 测试（T4.2 学习前沿）.

场景：读 user_knowledge_state（mastery>=0.7 视为已掌握）+
knowledge_category_prerequisite 的 active 先修边，返回"先修全掌握而自身未掌握"
的节点列表。表结构与 test_graph_consistency.py（T1.2）保持一致的 SQLite 建表风格。
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.services.graph_service import GraphService

PREREQ_DDL = """
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

STATE_DDL = """
CREATE TABLE IF NOT EXISTS user_knowledge_state (
    user_id VARCHAR(64) NOT NULL,
    category_id INTEGER NOT NULL,
    mastery DECIMAL(4,3) NOT NULL DEFAULT 0,
    evidence_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT,
    PRIMARY KEY (user_id, category_id)
)
"""

CATEGORY_DDL = """
CREATE TABLE IF NOT EXISTS knowledge_category (
    id INTEGER PRIMARY KEY,
    domain_id INTEGER,
    parent_id INTEGER,
    name VARCHAR(255),
    level INTEGER,
    node_type VARCHAR(32),
    sort_order INTEGER
)
"""


@pytest_asyncio.fixture
async def frontier_db(db_session: AsyncSession):
    # knowledge_category_prerequisite 已是 Base 管理的 ORM 表（T3.2 加了 evidence_json
    # 列），其 BigInteger 主键在 SQLite 下不具备隐式 rowid 自增语义；同 T1.2
    # test_graph_consistency.py 的做法一致：先 DROP 再用兼容 SQLite AUTOINCREMENT
    # 的定义重建，测试结束后再清理，不影响其它模块基于 ORM 表结构的用例。
    for table in ("knowledge_category_prerequisite", "user_knowledge_state", "knowledge_category"):
        await db_session.execute(text(f"DROP TABLE IF EXISTS {table}"))
    for ddl in (PREREQ_DDL, STATE_DDL, CATEGORY_DDL):
        await db_session.execute(text(ddl))
    await db_session.commit()
    yield db_session
    for table in ("knowledge_category_prerequisite", "user_knowledge_state", "knowledge_category"):
        await db_session.execute(text(f"DROP TABLE IF EXISTS {table}"))
    await db_session.commit()


async def add_edge(db: AsyncSession, *, category_id: int, prereq_category_id: int, domain_id: int = 1):
    await db.execute(
        text(
            "INSERT INTO knowledge_category_prerequisite "
            "(domain_id, category_id, prereq_category_id, edge_type, status, source) "
            "VALUES (:domain, :cat, :prereq, 'prerequisite', 'active', 'human')"
        ),
        {"domain": domain_id, "cat": category_id, "prereq": prereq_category_id},
    )
    await db.commit()


async def set_mastery(db: AsyncSession, *, user_id: str, category_id: int, mastery: float):
    await db.execute(
        text(
            "INSERT INTO user_knowledge_state (user_id, category_id, mastery, evidence_count) "
            "VALUES (:uid, :cat, :mastery, 5)"
        ),
        {"uid": user_id, "cat": category_id, "mastery": mastery},
    )
    await db.commit()


async def add_category(db: AsyncSession, *, id: int, name: str, level: int = 3, node_type: str = "point"):
    await db.execute(
        text(
            "INSERT INTO knowledge_category (id, domain_id, parent_id, name, level, node_type, sort_order) "
            "VALUES (:id, 1, NULL, :name, :level, :node_type, 0)"
        ),
        {"id": id, "name": name, "level": level, "node_type": node_type},
    )
    await db.commit()


@pytest.mark.asyncio
async def test_frontier_includes_node_with_all_prereqs_mastered(frontier_db: AsyncSession):
    """A→B 先修边，A 已掌握（mastery>=0.7）、B 未掌握 → B 出现在 frontier."""
    await add_edge(frontier_db, category_id=2, prereq_category_id=1)
    await set_mastery(frontier_db, user_id="u1", category_id=1, mastery=0.9)
    svc = GraphService(frontier_db)
    result = await svc.learning_frontier(domain_id=1, user_id="u1")
    ids = [n["category_id"] for n in result]
    assert ids == [2]
    assert result[0]["mastered_prerequisites"] == [1]


@pytest.mark.asyncio
async def test_frontier_excludes_node_with_unmastered_prereq(frontier_db: AsyncSession):
    """A→C、B→C：A 已掌握但 B 未掌握 → C 不在 frontier（先修未全掌握）."""
    await add_edge(frontier_db, category_id=3, prereq_category_id=1)
    await add_edge(frontier_db, category_id=3, prereq_category_id=2)
    await set_mastery(frontier_db, user_id="u1", category_id=1, mastery=0.9)
    await set_mastery(frontier_db, user_id="u1", category_id=2, mastery=0.3)
    svc = GraphService(frontier_db)
    result = await svc.learning_frontier(domain_id=1, user_id="u1")
    assert result == []


@pytest.mark.asyncio
async def test_frontier_excludes_already_mastered_node(frontier_db: AsyncSession):
    """A→B，A、B 均已掌握 → B 不出现在 frontier（自身已掌握，无需再学）."""
    await add_edge(frontier_db, category_id=2, prereq_category_id=1)
    await set_mastery(frontier_db, user_id="u1", category_id=1, mastery=0.9)
    await set_mastery(frontier_db, user_id="u1", category_id=2, mastery=0.8)
    svc = GraphService(frontier_db)
    result = await svc.learning_frontier(domain_id=1, user_id="u1")
    assert result == []


@pytest.mark.asyncio
async def test_frontier_excludes_node_without_prerequisite_edges(frontier_db: AsyncSession):
    """孤立节点（无任何先修边指向它）不参与 frontier 判定（不是"先修图上的目标"）."""
    await set_mastery(frontier_db, user_id="u1", category_id=1, mastery=0.9)
    svc = GraphService(frontier_db)
    result = await svc.learning_frontier(domain_id=1, user_id="u1")
    assert result == []


@pytest.mark.asyncio
async def test_frontier_never_attempted_prereq_blocks(frontier_db: AsyncSession):
    """先修节点从未有作答记录（user_knowledge_state 无行）→ 视为未掌握，目标不进入 frontier."""
    await add_edge(frontier_db, category_id=2, prereq_category_id=1)
    svc = GraphService(frontier_db)
    result = await svc.learning_frontier(domain_id=1, user_id="new-user")
    assert result == []


@pytest.mark.asyncio
async def test_frontier_enriches_node_name_when_category_table_available(frontier_db: AsyncSession):
    """节点详情表可用时补 name/level/node_type."""
    await add_edge(frontier_db, category_id=2, prereq_category_id=1)
    await add_category(frontier_db, id=2, name="事务隔离级别")
    await set_mastery(frontier_db, user_id="u1", category_id=1, mastery=1.0)
    svc = GraphService(frontier_db)
    result = await svc.learning_frontier(domain_id=1, user_id="u1")
    assert result[0]["category_id"] == 2
    assert result[0]["name"] == "事务隔离级别"


@pytest.mark.asyncio
async def test_frontier_filters_by_domain_id(frontier_db: AsyncSession):
    """domain_id 过滤：其他领域的先修边不参与本领域 frontier 判定."""
    await add_edge(frontier_db, category_id=20, prereq_category_id=10, domain_id=2)
    await set_mastery(frontier_db, user_id="u1", category_id=10, mastery=1.0)
    svc = GraphService(frontier_db)
    result = await svc.learning_frontier(domain_id=1, user_id="u1")
    assert result == []
    result_other_domain = await svc.learning_frontier(domain_id=2, user_id="u1")
    assert [n["category_id"] for n in result_other_domain] == [20]


@pytest.mark.asyncio
async def test_frontier_missing_tables_returns_empty(db_session: AsyncSession):
    """表不存在（查询失败）→ 优雅降级返回空列表，不抛异常."""
    svc = GraphService(db_session)
    result = await svc.learning_frontier(domain_id=1, user_id="u1")
    assert result == []
