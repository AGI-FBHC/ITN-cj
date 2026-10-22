"""T4.7 传递归约闸门测试（激活时防冗余边 + 离线批量归约 + 反转边）.

场景：已有 A→B→C（active），激活候选 A→C 应被拒绝并给出替代路径说明；
离线管理接口对存量 active 图跑一次归约，冗余边软删为 status='redundant'；
反转边（T4.8 铺垫）：原边 rejected + 反方向重新过四道防线生成新 proposed 边。
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.services.prerequisite_service import (
    CycleDetectedError,
    DirectionViolationError,
    InvalidEdgeError,
    PrerequisiteService,
    RedundantEdgeError,
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

# 目录树：1(L1) -> 2(ch4, L2) -> 10(react,sort1) 11(plan,sort2) 12(reflect,sort3)（同章 L3）
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
    """每个测试前 DROP+重建表 + 播种目录树（与 test_prerequisite_graph 同款隔离策略）."""
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


def service(db_session: AsyncSession) -> PrerequisiteService:
    return PrerequisiteService(db_session)


async def add(svc: PrerequisiteService, cat: int, prereq: int, **kw):
    return await svc.add_prerequisite(category_id=cat, prereq_category_id=prereq, **kw)


# ── 激活闸门：传递归约拒绝 ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_activate_redundant_edge_rejected_with_path(db_session):
    """已有 A(10)→B(11)→C(12) 均 active，激活候选 A→C 应被拒绝并给出替代路径."""
    svc = service(db_session)
    e_ab, _ = await add(svc, 11, 10)   # A(10) → B(11)
    e_bc, _ = await add(svc, 12, 11)   # B(11) → C(12)
    await svc.review_edge(e_ab.id, approve=True)
    await svc.review_edge(e_bc.id, approve=True)

    # 候选冗余边 A(10) → C(12)：非环（12 无出边），add_prerequisite 允许创建为 proposed
    e_ac, _ = await add(svc, 12, 10)
    assert e_ac.status == "proposed"

    with pytest.raises(RedundantEdgeError) as exc:
        await svc.review_edge(e_ac.id, approve=True)

    # 边仍保持 proposed（拒绝不改变状态）
    await db_session.refresh(e_ac)
    assert e_ac.status == "proposed"

    # 异常携带替代路径说明
    assert exc.value.redundant_edges
    detail = exc.value.redundant_edges[0]
    assert detail["edge_id"] == e_ac.id
    assert detail["path"] == [10, 11, 12]
    assert "传递蕴含" in str(exc.value)
    assert "10" in str(exc.value) and "11" in str(exc.value) and "12" in str(exc.value)


@pytest.mark.asyncio
async def test_activate_non_redundant_edge_ok(db_session):
    """无替代路径的边正常激活（不应被误判冗余）."""
    svc = service(db_session)
    e_ab, _ = await add(svc, 11, 10)
    reviewed = await svc.review_edge(e_ab.id, approve=True)
    assert reviewed.status == "active"


@pytest.mark.asyncio
async def test_batch_activate_redundant_rejected(db_session):
    """批量激活：批内候选边若相对 active+批内其他边冗余，整体拒绝."""
    svc = service(db_session)
    e_ab, _ = await add(svc, 11, 10)
    e_bc, _ = await add(svc, 12, 11)
    e_ac, _ = await add(svc, 12, 10)
    await svc.review_edge(e_ab.id, approve=True)

    with pytest.raises(RedundantEdgeError):
        await svc.review_batch([e_bc.id, e_ac.id], approve=True)

    await db_session.refresh(e_bc)
    await db_session.refresh(e_ac)
    assert e_bc.status == "proposed"
    assert e_ac.status == "proposed"


# ── 离线管理接口：存量归约 ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_reduce_redundant_edges_offline(db_session):
    """离线归约：手工注入存量 active 冗余边（绕过激活闸门模拟历史数据），归约后软删."""
    svc = service(db_session)
    await db_session.execute(text(
        "INSERT INTO knowledge_category_prerequisite "
        "(domain_id, category_id, prereq_category_id, edge_type, status, source) "
        "VALUES (1, 11, 10, 'prerequisite', 'active', 'human'), "
        "(1, 12, 11, 'prerequisite', 'active', 'human'), "
        "(1, 12, 10, 'prerequisite', 'active', 'human')"
    ))
    await db_session.commit()

    result = await svc.reduce_redundant_edges(domain_id=1)
    assert result["checked"] == 3
    assert result["redundant"] == 1

    row = await db_session.execute(text(
        "SELECT status FROM knowledge_category_prerequisite "
        "WHERE category_id = 12 AND prereq_category_id = 10"
    ))
    assert row.scalar_one() == "redundant"

    # 归约后的边不再参与先修链查询（软删生效）：不再有 10→12 的直接边，
    # 但经 10→11→12 仍可传递到达 10（链路完整性不受影响）。
    chain = await svc.query_prerequisites(12)
    direct_10_to_12 = [
        e for e in chain["edges"]
        if e["prereq_category_id"] == 10 and e["category_id"] == 12
    ]
    assert direct_10_to_12 == []
    prereq_ids = {e["prereq_category_id"] for e in chain["edges"]}
    assert prereq_ids == {10, 11}


@pytest.mark.asyncio
async def test_reduce_redundant_edges_no_active_noop(db_session):
    """无 active 边：直接返回空结果，不报错."""
    svc = service(db_session)
    result = await svc.reduce_redundant_edges()
    assert result == {"checked": 0, "redundant": 0, "redundant_edge_ids": []}


@pytest.mark.asyncio
async def test_reduce_redundant_edges_existing_cycle_raises(db_session):
    """存量环（漂移数据）→ 归约前先报错，不做归约（避免 transitive_reduction 报错崩溃）."""
    svc = service(db_session)
    await db_session.execute(text(
        "INSERT INTO knowledge_category_prerequisite "
        "(domain_id, category_id, prereq_category_id, edge_type, status, source) "
        "VALUES (1, 11, 10, 'prerequisite', 'active', 'human'), "
        "(1, 10, 11, 'prerequisite', 'active', 'human')"
    ))
    await db_session.commit()
    with pytest.raises(CycleDetectedError):
        await svc.reduce_redundant_edges()


# ── 反转边（T4.8 铺垫）────────────────────────────────────────────────
#
# 注意：方向白名单里"同章知识点"的先后由 sort_order（文档顺序）固定约束，
# 反转会天然违反该约束——这符合设计本意（同章顺序不该反转）。
# "反转"真正适用的场景是跨父章节边（方向由人工判定、无 sort_order 硬约束）。


@pytest.mark.asyncio
async def test_reverse_edge_same_chapter_rejected_by_direction_whitelist(db_session):
    """同章知识点边（受 sort_order 约束）反转：违反方向白名单，原边不受影响（仍 proposed）."""
    svc = service(db_session)
    edge, _ = await add(svc, 11, 10)  # 10(sort1) → 11(sort2)，同章
    with pytest.raises(DirectionViolationError):
        await svc.reverse_edge(edge.id)
    await db_session.refresh(edge)
    assert edge.status == "proposed"  # 校验先于落库，原边未被误置 rejected


@pytest.mark.asyncio
async def test_reverse_edge_requires_proposed_status(db_session):
    """已激活的边不能反转（先 reject 再重建）."""
    svc = service(db_session)
    edge, _ = await add(svc, 11, 10)
    await svc.review_edge(edge.id, approve=True)
    with pytest.raises(InvalidEdgeError):
        await svc.reverse_edge(edge.id)


@pytest.mark.asyncio
async def test_reverse_edge_cross_parent_creates_swapped_proposed(db_session):
    """跨父章节边（人工维护、无 sort_order 约束）：反转成功，原边 rejected + 新边 proposed."""
    svc = service(db_session)
    await db_session.execute(text(
        "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
        "VALUES (5, 1, NULL, 'practice', '实战', 1, 'category', 2)"
    ))
    await db_session.execute(text(
        "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
        "VALUES (6, 1, 5, 'ch13', '第十三章 旅行助手', 2, 'category', 1)"
    ))
    await db_session.commit()

    edge, _ = await add(svc, 6, 2, source="human")  # ch4(2) → ch13(6)，跨父人工建边
    result = await svc.reverse_edge(edge.id)
    old_edge, new_edge = result["old_edge"], result["new_edge"]
    assert old_edge.status == "rejected"
    assert new_edge.status == "proposed"
    assert new_edge.category_id == 2
    assert new_edge.prereq_category_id == 6
    assert new_edge.source == "human"

    # 新边仍需走 approve 才激活（反转本身不自动激活）
    activated = await svc.review_edge(new_edge.id, approve=True)
    assert activated.status == "active"
