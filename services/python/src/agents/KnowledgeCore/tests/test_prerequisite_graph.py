"""先修图服务测试：四道防线 + 先修链查询（dag-design.md §5-§6）.

覆盖：方向白名单（同章/跨章/跨层/level1）、祖先检查（直接环/传递环）、
related 跳过防环、出度上限（LLM 降级 / human 拒绝）、审核激活 Kahn（单条/批量）、
跨域约束（人工/源域匹配/L1 章节）、先修链 BFS、一致性校验、软删。
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
    OutdegreeExceededError,
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

# 目录树种子（domain 1 = agent，domain 2 = math）
#   L1: 1 construction
#   L2: 2 ch4(父1, sort1)  3 ch5(父1, sort2)  4 math-linear(父20, sort1, domain2)
#   L3: 10 react(父2,sort1) 11 plan(父2,sort2) 12 reflect(父2,sort3)
#       13 ch5kp(父3,sort1)  14 ch4kp2(父2,sort4)
SEED = [
    "INSERT INTO knowledge_domain (id, code, name) VALUES (1, 'agent', '智能体')",
    "INSERT INTO knowledge_domain (id, code, name) VALUES (2, 'math', '数学')",
    # level1
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (1, 1, NULL, 'construction', '智能体构建', 1, 'category', 1)",
    # level2
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (2, 1, 1, 'ch4', '第四章 经典范式', 2, 'category', 1)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (3, 1, 1, 'ch5', '第五章 低代码平台', 2, 'category', 2)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (4, 2, 20, 'linear', '线性代数', 2, 'category', 1)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (20, 2, NULL, 'math-root', '数学基础', 1, 'category', 1)",
    # level3 知识点
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (10, 1, 2, 'kp-react', 'ReAct范式', 3, 'knowledge_point', 1)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (11, 1, 2, 'kp-plan', 'Plan-and-Solve', 3, 'knowledge_point', 2)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (12, 1, 2, 'kp-reflect', 'Reflection', 3, 'knowledge_point', 3)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (13, 1, 3, 'kp-ch5', '扣子平台', 3, 'knowledge_point', 1)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (14, 1, 2, 'kp-ch4-2', '工具调用', 3, 'knowledge_point', 4)",
]


@pytest_asyncio.fixture(autouse=True)
async def setup_db(db_session: AsyncSession):
    """每个测试前 DROP+重建表 + 播种目录树（避免跨测试文件 SQLite 数据残留）."""
    for t in ("knowledge_category_prerequisite", "knowledge_category", "knowledge_domain"):
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    for ddl in DDL:
        await db_session.execute(text(ddl))
    for sql in SEED:
        await db_session.execute(text(sql))
    await db_session.commit()
    yield
    # teardown：DROP 而非 DELETE（与 test_knowledge_retrieval 一致，避免跨文件数据残留）
    for t in ("knowledge_category_prerequisite", "knowledge_category", "knowledge_domain"):
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    await db_session.commit()


def service(db_session: AsyncSession) -> PrerequisiteService:
    return PrerequisiteService(db_session)


async def add(svc: PrerequisiteService, cat: int, prereq: int, **kw):
    return await svc.add_prerequisite(category_id=cat, prereq_category_id=prereq, **kw)


# ── 防线 1：方向白名单 ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_same_chapter_kp_ok(db_session):
    """同章知识点 sort_order 小→大：允许（proposed）."""
    edge, warnings = await add(service(db_session), 11, 10)
    assert edge.status == "proposed"
    assert edge.edge_type == "prerequisite"
    assert warnings == []


@pytest.mark.asyncio
async def test_reverse_sort_order_rejected(db_session):
    """同章知识点 sort_order 大→小（回头边）：防线 1 拒绝."""
    with pytest.raises(DirectionViolationError):
        await add(service(db_session), 10, 11)


@pytest.mark.asyncio
async def test_cross_chapter_kp_rejected(db_session):
    """跨章知识点直连（10→13，不同 parent）：拒绝，必须走章节边."""
    with pytest.raises(DirectionViolationError):
        await add(service(db_session), 13, 10)


@pytest.mark.asyncio
async def test_chapter_to_kp_ok(db_session):
    """章节→其知识点（level2→3 同章）：允许（章节先修约束知识点）."""
    edge, _ = await add(service(db_session), 10, 2)
    assert edge.edge_type == "prerequisite"


@pytest.mark.asyncio
async def test_chapter_to_other_chapter_kp_rejected(db_session):
    """章节→非直接包含的知识点：拒绝."""
    with pytest.raises(DirectionViolationError):
        await add(service(db_session), 13, 2)  # ch4 先修 ch5 的知识点


@pytest.mark.asyncio
async def test_kp_to_chapter_rejected(db_session):
    """知识点→章节（level3→2）：拒绝."""
    with pytest.raises(DirectionViolationError):
        await add(service(db_session), 2, 10)


@pytest.mark.asyncio
async def test_level1_rejected(db_session):
    """level1 顶层节点参与：拒绝（依赖语义由章节边承载）."""
    with pytest.raises(DirectionViolationError):
        await add(service(db_session), 2, 1)
    with pytest.raises(DirectionViolationError):
        await add(service(db_session), 1, 2)


@pytest.mark.asyncio
async def test_same_parent_chapter_order(db_session):
    """同父章节边：sort_order 小→大允许（ch4→ch5），大→小拒绝."""
    edge, _ = await add(service(db_session), 3, 2)  # ch4 → ch5
    assert edge.edge_type == "prerequisite"
    with pytest.raises(DirectionViolationError):
        await add(service(db_session), 2, 3)  # ch5 → ch4 回头


@pytest.mark.asyncio
async def test_cross_parent_chapter_human_only(db_session):
    """跨父章节边：仅人工允许（agent 域 ch4 的跨父先修 = 新 level1 下的章节）."""
    svc = service(db_session)
    # 构造第二个 level1（5）及其章节（6），与 ch4(2) 跨父
    await db_session.execute(text(
        "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
        "VALUES (5, 1, NULL, 'practice', '实战', 1, 'category', 2)"
    ))
    await db_session.execute(text(
        "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
        "VALUES (6, 1, 5, 'ch13', '第十三章 旅行助手', 2, 'category', 1)"
    ))
    await db_session.commit()
    # agent 来源跨父 → 拒绝
    with pytest.raises(DirectionViolationError):
        await add(svc, 6, 2, source="agent")
    # human 跨父 → 允许（L1 章节边人工维护）
    edge, _ = await add(svc, 6, 2, source="human")
    assert edge.edge_type == "prerequisite"


# ── 防线 2：祖先检查 ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_direct_cycle_rejected(db_session):
    """防线 2 祖先检查：跨父章节边 A→B 后 B→A（回头）→ CycleDetectedError.

    同章内回头边会被防线 1 拦截（更便宜），这里用跨父章节边构造
    能过白名单、只能靠祖先检查发现的环。
    """
    svc = service(db_session)
    # 构造第二个 level1（5）及其章节（6），与 ch4(2) 跨父
    await db_session.execute(text(
        "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
        "VALUES (5, 1, NULL, 'practice', '实战', 1, 'category', 2)"
    ))
    await db_session.execute(text(
        "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
        "VALUES (6, 1, 5, 'ch13', '第十三章 旅行助手', 2, 'category', 1)"
    ))
    await db_session.commit()
    await add(svc, 6, 2, source="human")  # ch4(2) → ch13(6)，跨父人工放行
    with pytest.raises(CycleDetectedError):
        await add(svc, 2, 6, source="human")  # 回头：ch13(6) → ch4(2) 构成环


@pytest.mark.asyncio
async def test_transitive_cycle_rejected(db_session):
    """传递环：2→6, 6→7, 再 7→2 → 防线 2 祖先检查拒绝."""
    svc = service(db_session)
    await db_session.execute(text(
        "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
        "VALUES (5, 1, NULL, 'practice', '实战', 1, 'category', 2)"
    ))
    await db_session.execute(text(
        "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
        "VALUES (6, 1, 5, 'ch13', '第十三章 旅行助手', 2, 'category', 1)"
    ))
    await db_session.execute(text(
        "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
        "VALUES (7, 1, 5, 'ch14', '第十四章 深度研究', 2, 'category', 2)"
    ))
    await db_session.commit()
    await add(svc, 6, 2, source="human")   # 2→6
    await add(svc, 7, 6, source="human")   # 6→7
    with pytest.raises(CycleDetectedError):
        await add(svc, 2, 7, source="human")  # 7→2：2 可达 7（2→6→7），构成环


@pytest.mark.asyncio
async def test_ancestor_path_ok(db_session):
    """非环长链：10→11→12 后再加 10→12（传递边，非环）允许."""
    await add(service(db_session), 11, 10)
    await add(service(db_session), 12, 11)
    # 10→12：12 不能到达 10（12 无出边），允许（冗余传递边，查询时自然去重）
    edge, _ = await add(service(db_session), 12, 10)
    assert edge.status == "proposed"


# ── related 边：跳过防环 ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_related_skips_checks(db_session):
    """related 边：无方向语义，同章反向也允许，直接 active."""
    edge, _ = await add(service(db_session), 10, 11, edge_type="related")
    assert edge.status == "active"
    assert edge.edge_type == "related"


@pytest.mark.asyncio
async def test_related_not_in_chain(db_session):
    """related 边不参与先修链查询."""
    await add(service(db_session), 10, 11, edge_type="related")
    result = await service(db_session).query_prerequisites(10)
    assert result["edges"] == []


# ── 规则 3：出度上限 ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_outdegree_llm_downgraded(db_session):
    """LLM 建边超过出度上限：自动降级 related + warning（proposed 也占位）."""
    svc = service(db_session)
    # 动态补同章知识点，凑出 5 个目标（10→11/12/14 + 10→15/16 = 5 条达上限）
    for i, kid in enumerate([15, 16]):
        await db_session.execute(text(
            "INSERT INTO knowledge_category "
            "(id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
            f"VALUES ({kid}, 1, 2, 'kp-x{i}', 'KP{i}', 3, 'knowledge_point', {5 + i})"
        ))
    await db_session.commit()
    for target in (11, 12, 14, 15, 16):
        edge, w = await add(svc, target, 10)
        assert edge.status == "proposed" and not w
    # 第 6 条（10→17）：LLM 来源 → 自动降级 related + warning
    await db_session.execute(text(
        "INSERT INTO knowledge_category "
        "(id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
        "VALUES (17, 1, 2, 'kp-x2', 'KP2', 3, 'knowledge_point', 7)"
    ))
    await db_session.commit()
    edge, warnings = await add(svc, 17, 10)
    assert edge.edge_type == "related"
    assert edge.status == "active"  # related 直接生效
    assert any("降级" in w for w in warnings)


@pytest.mark.asyncio
async def test_outdegree_human_rejected(db_session):
    """human 建边超过出度上限：拒绝（提醒先整理）."""
    svc = service(db_session)
    for i, kid in enumerate([15, 16, 17, 18, 19]):
        await db_session.execute(text(
            "INSERT INTO knowledge_category "
            "(id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
            f"VALUES ({kid}, 1, 2, 'kp-h{i}', 'KPH{i}', 3, 'knowledge_point', {8 + i})"
        ))
    await db_session.commit()
    for target in (11, 12, 14, 15, 16):
        await add(svc, target, 10, source="human", direct_active=True)
    with pytest.raises(OutdegreeExceededError):
        await add(svc, 17, 10, source="human", direct_active=True)


# ── 审核（防线 3） ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_review_single_approve(db_session):
    """单条审核通过：active."""
    svc = service(db_session)
    edge, _ = await add(svc, 11, 10)
    assert edge.status == "proposed"
    reviewed = await svc.review_edge(edge.id, approve=True)
    assert reviewed.status == "active"


@pytest.mark.asyncio
async def test_review_batch_cycle_detected(db_session):
    """批量激活防环：注入存量 active 边 + 1 条 proposed，激活会构成传递环 → 拒绝.

    （绕过防线 1 手工注入，模拟存量数据漂移场景）
    """
    svc = service(db_session)
    await db_session.execute(text(
        "INSERT INTO knowledge_category_prerequisite "
        "(domain_id, category_id, prereq_category_id, edge_type, status, source) "
        "VALUES (1, 11, 10, 'prerequisite', 'active', 'human'), "
        "(1, 12, 11, 'prerequisite', 'active', 'human'), "
        "(1, 10, 12, 'prerequisite', 'proposed', 'human')"
    ))
    await db_session.commit()
    # 待激活边：12→10（与 active 的 10→11、11→12 构成环）
    result = await db_session.execute(text(
        "SELECT id FROM knowledge_category_prerequisite "
        "WHERE category_id = 10 AND prereq_category_id = 12"
    ))
    edge_id = result.scalar_one()
    with pytest.raises(CycleDetectedError) as exc:
        await svc.review_batch([edge_id], approve=True)
    assert exc.value.cycle_members  # 环成员非空


@pytest.mark.asyncio
async def test_review_reject(db_session):
    """审核拒绝：rejected."""
    svc = service(db_session)
    edge, _ = await add(svc, 11, 10)
    reviewed = await svc.review_edge(edge.id, approve=False)
    assert reviewed.status == "rejected"


# ── 跨域边 ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cross_domain_requires_human(db_session):
    """跨域边禁止 LLM/agent 生成."""
    with pytest.raises(InvalidEdgeError):
        await add(service(db_session), 2, 4, edge_type="cross_domain_prerequisite",
                   source_domain_id=2, source="agent")


@pytest.mark.asyncio
async def test_cross_domain_level_restriction(db_session):
    """跨域先修必须是源域 L1 章节（level2）：level3 拒绝."""
    with pytest.raises(InvalidEdgeError):
        await add(service(db_session), 2, 10, edge_type="cross_domain_prerequisite",
                   source_domain_id=1, source="human")


@pytest.mark.asyncio
async def test_cross_domain_source_mismatch(db_session):
    """source_domain_id 必须匹配先修节点领域."""
    with pytest.raises(InvalidEdgeError):
        await add(service(db_session), 2, 4, edge_type="cross_domain_prerequisite",
                   source_domain_id=1, source="human")  # 先修 4 属于 domain 2


@pytest.mark.asyncio
async def test_cross_domain_ok(db_session):
    """合法跨域边：agent ch4(2) 的先修 = math 线性代数(4)，人工创建."""
    svc = service(db_session)
    edge, _ = await add(svc, 2, 4, edge_type="cross_domain_prerequisite",
                        source_domain_id=2, source="human")
    assert edge.status == "proposed"
    assert edge.source_domain_id == 2


# ── 先修链查询 ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_query_prerequisites_chain(db_session):
    """多级先修链 BFS：2→10→11→12 链（先审核激活）. """
    svc = service(db_session)
    e1, _ = await add(svc, 11, 10)
    e2, _ = await add(svc, 12, 11)
    e3, _ = await add(svc, 10, 2)  # ch4 先修 ReAct
    for e in (e1, e2, e3):
        await svc.review_edge(e.id, approve=True)
    result = await svc.query_prerequisites(12)
    prereq_ids = {e["prereq_category_id"] for e in result["edges"]}
    assert prereq_ids == {11, 10, 2}
    node_ids = {n["category_id"] for n in result["nodes"]}
    assert node_ids == {11, 10, 2}
    # 节点带 domain 标注
    assert all(n["domain_id"] == 1 for n in result["nodes"])


@pytest.mark.asyncio
async def test_query_includes_cross_domain(db_session):
    """先修链包含跨域边：节点带源域标注."""
    svc = service(db_session)
    e1, _ = await add(svc, 10, 2)  # ch4 → ReAct（域内）
    e2, _ = await add(svc, 2, 4, edge_type="cross_domain_prerequisite",
                      source_domain_id=2, source="human")
    await svc.review_edge(e1.id, approve=True)
    await svc.review_edge(e2.id, approve=True)
    result = await svc.query_prerequisites(10)
    domain_ids = {n["domain_id"] for n in result["nodes"]}
    assert domain_ids == {1, 2}  # 本域 + 跨域 math
    cross_edges = [e for e in result["edges"] if e["edge_type"] == "cross_domain_prerequisite"]
    assert len(cross_edges) == 1
    assert cross_edges[0]["source_domain_id"] == 2


# ── 一致性校验 & 软删 ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_validate_consistency_ok(db_session):
    svc = service(db_session)
    await add(svc, 11, 10)
    await add(svc, 12, 11)
    result = await svc.validate_consistency(1)
    assert result["is_consistent"] is True
    assert result["errors"] == []


@pytest.mark.asyncio
async def test_validate_consistency_orphan_edge(db_session):
    """孤儿边（引用不存在的 category）→ 校验失败."""
    svc = service(db_session)
    await add(svc, 11, 10)
    await db_session.execute(text(
        "INSERT INTO knowledge_category_prerequisite "
        "(domain_id, category_id, prereq_category_id, edge_type, status, source) "
        "VALUES (1, 999, 10, 'prerequisite', 'active', 'human')"
    ))
    await db_session.commit()
    result = await svc.validate_consistency(1)
    assert result["is_consistent"] is False
    assert any("999" in e for e in result["errors"])


@pytest.mark.asyncio
async def test_validate_consistency_cycle(db_session):
    """存量环（手工注入绕过防线）→ 校验报环成员."""
    svc = service(db_session)
    await db_session.execute(text(
        "INSERT INTO knowledge_category_prerequisite "
        "(domain_id, category_id, prereq_category_id, edge_type, status, source) "
        "VALUES (1, 11, 10, 'prerequisite', 'active', 'human'), "
        "(1, 10, 11, 'prerequisite', 'active', 'human')"
    ))
    await db_session.commit()
    result = await svc.validate_consistency(1)
    assert result["is_consistent"] is False
    assert any("环" in e for e in result["errors"])


@pytest.mark.asyncio
async def test_plan_path_reachable(db_session):
    """路径可达：2→10→11→12 链，from=2 to=12 返回路径."""
    svc = service(db_session)
    e1, _ = await add(svc, 11, 10)
    e2, _ = await add(svc, 12, 11)
    e3, _ = await add(svc, 10, 2)
    for e in (e1, e2, e3):
        await svc.review_edge(e.id, approve=True)
    result = await svc.plan_path(2, 12)
    assert result["reachable"] is True
    assert result["path_ids"] == [2, 10, 11, 12]
    assert all(n["name"] for n in result["path"])


@pytest.mark.asyncio
async def test_plan_path_unreachable(db_session):
    """路径不可达：返回目标先修链 + 缺连接提示."""
    svc = service(db_session)
    e1, _ = await add(svc, 12, 11)
    await svc.review_edge(e1.id, approve=True)
    result = await svc.plan_path(10, 12)  # 10 不是 12 的先修链
    assert result["reachable"] is False
    assert result["missing_connection"]
    assert result["target_prerequisite_ids"] == [11]


@pytest.mark.asyncio
async def test_plan_path_includes_cross_domain(db_session):
    """路径含跨域边：节点带 domain 标注."""
    svc = service(db_session)
    e1, _ = await add(svc, 10, 2)
    e2, _ = await add(svc, 2, 4, edge_type="cross_domain_prerequisite",
                      source_domain_id=2, source="human")
    await svc.review_edge(e1.id, approve=True)
    await svc.review_edge(e2.id, approve=True)
    result = await svc.plan_path(4, 10)
    assert result["reachable"] is True
    assert result["path_ids"] == [4, 2, 10]
    domain_ids = {n["domain_id"] for n in result["path"]}
    assert domain_ids == {1, 2}


@pytest.mark.asyncio
async def test_delete_edge_soft(db_session):
    """删除：软删 deprecated，不物理删除."""
    svc = service(db_session)
    edge, _ = await add(svc, 11, 10)
    deleted = await svc.delete_edge(edge.id)
    assert deleted.status == "deprecated"
    # deprecated 边不再参与先修链
    result = await svc.query_prerequisites(11)
    assert result["edges"] == []


@pytest.mark.asyncio
async def test_duplicate_edge_rejected(db_session):
    """重复建边（同一对）幂等拒绝."""
    svc = service(db_session)
    await add(svc, 11, 10)
    with pytest.raises(InvalidEdgeError, match="已存在"):
        await add(svc, 11, 10)
