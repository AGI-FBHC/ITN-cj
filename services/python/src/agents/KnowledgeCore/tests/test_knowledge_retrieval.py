"""混合检索服务与阈值计算测试."""

from __future__ import annotations

from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.knowledge.services.retrieval_service import (
    KnowledgeRetrievalService,
    compute_threshold,
)

DDL = [
    """
    CREATE TABLE IF NOT EXISTS knowledge_domain (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code VARCHAR(64) UNIQUE, name VARCHAR(128)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS knowledge_document (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_code VARCHAR(255), title VARCHAR(512),
        document_type VARCHAR(64), source_type VARCHAR(64),
        source_name VARCHAR(255), publisher VARCHAR(255),
        publish_year INTEGER, reliability_score DECIMAL(5,4),
        created_at TEXT, updated_at TEXT
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

SEED = [
    "INSERT INTO knowledge_domain (id, code, name) VALUES (1, 'agent', '智能体')",
    # 文档（reliability_score / publish_year 供 authority/freshness 评分）
    "INSERT INTO knowledge_document (id, document_code, title, document_type, source_type, source_name, publisher, publish_year, reliability_score, created_at, updated_at) "
    "VALUES (10, 'doc10', '第四章 智能体经典范式构建', 'course_markdown', 'web', 'Hello Agents · Datawhale', 'Datawhale', 2025, 0.9, '2026-08-05 15:56:04', '2026-08-05 15:56:04')",
    # level1
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (1, 1, NULL, 'construction', '智能体构建', 1, 'category', 1)",
    # level2
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (2, 1, 1, 'ch4-paradigms', '第四章 智能体经典范式构建', 2, 'category', 1)",
    # level3 知识点
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, description, level, node_type, sort_order) "
    "VALUES (3, 1, 2, 'kp-react', 'ReAct范式', '思考-行动-观察协同循环', 3, 'knowledge_point', 1)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, description, level, node_type, sort_order) "
    "VALUES (4, 1, 2, 'kp-plan', 'Plan-and-Solve', '规划与执行分离', 3, 'knowledge_point', 2)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, description, level, node_type, sort_order) "
    "VALUES (5, 1, 2, 'kp-empty', 'Reflection', '自我反思', 3, 'knowledge_point', 3)",
    # 孤立章节：整章无切片（用于测 RAG 兜底分支）
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (6, 1, 1, 'ch7-helloagents', '第七章 自建HelloAgents框架', 2, 'category', 2)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, description, level, node_type, sort_order) "
    "VALUES (7, 1, 6, 'kp-env', '环境搭建', 'HelloAgents 环境准备', 3, 'knowledge_point', 1)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, description, level, node_type, sort_order) "
    "VALUES (8, 1, 6, 'kp-design', '框架设计原理', 'HelloAgents 架构设计', 3, 'knowledge_point', 2)",
    # 切片：ReAct 3 条；Plan 1 条；章节 3 条；孤立章（ch7）0 条
    "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, title_path, section_title, content, ragflow_chunk_id) "
    "VALUES (1, 10, 'chunk_000001', 0, '第四章/ReAct', 'ReAct 概念', 'ReAct 范式内容一', 'ragf_1')",
    "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, title_path, section_title, content, ragflow_chunk_id) "
    "VALUES (2, 10, 'chunk_000002', 1, '第四章/ReAct', 'ReAct 实现', 'ReAct 代码实现二', 'ragf_2')",
    "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, title_path, section_title, content, ragflow_chunk_id) "
    "VALUES (3, 10, 'chunk_000003', 2, '第四章/Plan', 'Plan 概览', 'Plan-and-Solve 概述三', 'ragf_3')",
    "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, title_path, section_title, content, ragflow_chunk_id) "
    "VALUES (4, 10, 'chunk_000004', 3, '第四章/Reflection', 'Reflection 概览', 'Reflection 概述四', 'ragf_4')",
    "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, title_path, section_title, content, ragflow_chunk_id) "
    "VALUES (5, 10, 'chunk_000005', 4, '第四章/Reflection', 'Reflection 原理', 'Reflection 原理五', 'ragf_5')",
    "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, title_path, section_title, content, ragflow_chunk_id) "
    "VALUES (6, 10, 'chunk_000006', 5, '第四章/ReAct', 'ReAct 进阶', 'ReAct 深入原理六', 'ragf_6')",
    "INSERT INTO knowledge_chunk (id, document_id, chunk_code, chunk_index, title_path, section_title, content, ragflow_chunk_id) "
    "VALUES (7, 10, 'chunk_000007', 6, '第四章/综述', '第四章 综述', '第四章 范式综述七', 'ragf_7')",
    # 分类：chunk1-2,6 → ReAct(3)；chunk3 → Plan(4)；chunk4-5,7 → 章节(2)
    "INSERT INTO knowledge_chunk_category (chunk_id, category_id, relation_type, confidence, source) VALUES (1, 3, 'classified', 0.9, 'llm')",
    "INSERT INTO knowledge_chunk_category (chunk_id, category_id, relation_type, confidence, source) VALUES (2, 3, 'classified', 0.8, 'llm')",
    "INSERT INTO knowledge_chunk_category (chunk_id, category_id, relation_type, confidence, source) VALUES (6, 3, 'classified', 0.75, 'llm')",
    "INSERT INTO knowledge_chunk_category (chunk_id, category_id, relation_type, confidence, source) VALUES (3, 4, 'classified', 0.7, 'llm')",
    "INSERT INTO knowledge_chunk_category (chunk_id, category_id, relation_type, confidence, source) VALUES (4, 2, 'classified', 0.6, 'llm')",
    "INSERT INTO knowledge_chunk_category (chunk_id, category_id, relation_type, confidence, source) VALUES (5, 2, 'classified', 0.6, 'llm')",
    "INSERT INTO knowledge_chunk_category (chunk_id, category_id, relation_type, confidence, source) VALUES (7, 2, 'classified', 0.6, 'llm')",
]


@pytest_asyncio.fixture
async def knowledge_db(db_session: AsyncSession):
    """建表 + 灌种子数据."""
    for ddl in DDL:
        await db_session.execute(text(ddl))
    for stmt in SEED:
        await db_session.execute(text(stmt))
    await db_session.commit()
    yield db_session
    # 清理：DROP 而非 DELETE（重建表时 AUTOINCREMENT 序列归零，避免自增 id 跨测试漂移）
    for table in ("knowledge_chunk_category", "knowledge_chunk", "knowledge_category", "knowledge_document", "knowledge_domain"):
        await db_session.execute(text(f"DROP TABLE IF EXISTS {table}"))
    await db_session.commit()


# ── 知识点定位（resolve_category 精确匹配增强） ────────────────────────


@pytest.mark.asyncio
async def test_resolve_category_exact_name(knowledge_db: AsyncSession):
    """输入与知识点名完全一致 → 精确命中（优先于 LIKE）."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    cat = await svc.resolve_category(1, "ReAct范式")
    assert cat is not None
    assert cat["id"] == 3
    assert cat["node_type"] == "knowledge_point"


@pytest.mark.asyncio
async def test_resolve_category_exact_node_code(knowledge_db: AsyncSession):
    """输入与 node_code 完全一致 → 精确命中."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    cat = await svc.resolve_category(1, "kp-react")
    assert cat is not None
    assert cat["id"] == 3


@pytest.mark.asyncio
async def test_resolve_category_multitoken_and(knowledge_db: AsyncSession):
    """多词输入（带空格）→ 分词 AND 命中：'ReAct 范式' 应命中 id=3 而非章节."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    cat = await svc.resolve_category(1, "ReAct 范式")
    assert cat is not None
    assert cat["id"] == 3


@pytest.mark.asyncio
async def test_resolve_category_by_id(knowledge_db: AsyncSession):
    """category_id 直查（最强精确）：跳过名称匹配直接定位."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    cat = await svc.resolve_category(1, "随便什么名字", category_id=4)
    assert cat is not None
    assert cat["id"] == 4
    assert cat["name"] == "Plan-and-Solve"
    # 不存在的 ID → None
    assert await svc.resolve_category(1, "x", category_id=999) is None


@pytest.mark.asyncio
async def test_resolve_category_fuzzy_fallback(knowledge_db: AsyncSession):
    """无精确/多词命中 → LIKE 模糊兜底（章节名部分匹配）."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    cat = await svc.resolve_category(1, "经典范式")
    assert cat is not None
    assert cat["id"] == 2  # 第四章（仅 LIKE 命中章节）


@pytest.mark.asyncio
async def test_domain_code_filled_in_mysql_hit(knowledge_db: AsyncSession):
    """bug 修复：mysql 精确命中时 domain_code 不再为空字符串."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    result = await svc.retrieve_chunks("ReAct范式", include_rag=False)
    assert result["decision"] == "mysql"
    assert result["domain_code"] == "agent"


@pytest.mark.asyncio
async def test_chunks_min_confidence_filter(knowledge_db: AsyncSession):
    """min_confidence 过滤低置信度分类：ReAct 3 条中 confidence<0.78 的被过滤."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    hits = await svc.chunks_by_category(3, source="mysql", min_confidence=0.78)
    assert len(hits) == 2  # 0.9 / 0.8 通过，0.75 被过滤
    assert all(h["confidence"] >= 0.78 for h in hits)


@pytest.mark.asyncio
async def test_retrieve_with_category_id(knowledge_db: AsyncSession):
    """检索入口支持 category_id 直查：Plan 只有 1 条切片，threshold=1 时精确命中."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    result = await svc.retrieve_chunks("任意名称", category_id=4, threshold=1, include_rag=False)
    assert result["decision"] == "mysql"
    assert result["category_id"] == 4


@pytest.mark.asyncio
async def test_chapter_node_aggregates_descendant_chunks(knowledge_db: AsyncSession):
    """章节节点（level2）精确层聚合子知识点切片：ch4 自身挂 3 条 + 子节点 4 条 = 7 条."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    result = await svc.retrieve_chunks("第四章 智能体经典范式构建", include_rag=False)
    assert result["decision"] == "mysql"
    assert result["category_id"] == 2
    assert result["stats"]["exact"] == 7
    assert result["via_parent"] is False


@pytest.mark.asyncio
async def test_top_level_node_aggregates_all_descendants(knowledge_db: AsyncSession):
    """顶层节点（level1）精确层递归聚合全部子孙：查"智能体构建"应返回全部 7 条切片."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    result = await svc.retrieve_chunks("智能体构建", include_rag=False)
    assert result["decision"] == "mysql"
    assert result["category_id"] == 1
    assert result["stats"]["exact"] == 7


@pytest.mark.asyncio
async def test_rollup_stops_at_chapter_not_top_level(knowledge_db: AsyncSession):
    """上卷只到章节（level2），不会上卷到顶层拿全领域内容：ch7 知识点无切片 → 不上卷顶层."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    result = await svc.retrieve_chunks("环境搭建", include_rag=False)
    # ch7 无切片，上卷 ch7(level2) 也 0 → 不到顶层 → 不命中 parent → empty
    assert result["decision"] == "empty"
    assert result["stats"]["parent"] == 0


# ── 阈值计算（纯函数） ────────────────────────────────────────────────────


def test_compute_threshold_fixed():
    """fixed 模式：知识点与章节都取固定值 3."""
    assert compute_threshold() == 3
    assert compute_threshold(None) == 3
    assert compute_threshold(None, is_chapter=True) == 3


def test_compute_threshold_auto():
    """auto 模式：基于章节内有切片知识点的均值，封顶 8，下限 2."""
    # 均值 8 条 → 0.5*8=4
    assert compute_threshold({"kp_chunks": 40, "kp_with_chunks": 5}, mode="auto") == 4
    # 均值 40 条 → 20 → 封顶 8
    assert compute_threshold({"kp_chunks": 200, "kp_with_chunks": 5}, mode="auto") == 8
    # 无统计 → 回退固定值 3
    assert compute_threshold({}, mode="auto") == 3
    assert compute_threshold(None, mode="auto") == 3
    # 章节节点在 auto 模式仍取固定 3
    assert compute_threshold({"kp_chunks": 200, "kp_with_chunks": 5}, mode="auto", is_chapter=True) == 3


# ── 混合检索流程 ─────────────────────────────────────────────────────────


class FakeRag:
    """模拟 RAGFlow 客户端."""

    def __init__(self, chunks: list[dict[str, Any]] | None = None):
        self.chunks = chunks or []

    async def resolve_dataset_ids(self, domain_code: str, explicit=None):
        return explicit or ["ds_1"]

    async def retrieve(self, question, dataset_ids, page_size=8, similarity_threshold=0.2, **kw):
        return self.chunks


@pytest.mark.asyncio
async def test_exact_hit(knowledge_db: AsyncSession):
    """精确层命中：ReAct 有 3 条切片 >= 固定阈值 3 → decision=mysql."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    result = await svc.retrieve_chunks("ReAct范式", include_rag=False)
    assert result["decision"] == "mysql"
    assert result["category_id"] == 3
    assert len(result["chunks"]) == 3
    assert all(c["source"] == "mysql" for c in result["chunks"])
    assert result["stats"]["exact"] == 3
    assert result["via_parent"] is False


@pytest.mark.asyncio
async def test_exact_hit_with_custom_threshold(knowledge_db: AsyncSession):
    """显式 threshold=1 时，Plan 的 1 条切片即可精确命中."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    result = await svc.retrieve_chunks("Plan-and-Solve", threshold=1, include_rag=False)
    assert result["decision"] == "mysql"
    assert result["stats"]["exact"] == 1


@pytest.mark.asyncio
async def test_below_threshold_falls_to_parent(knowledge_db: AsyncSession):
    """精确层不足 → 父级上卷：Plan 只有 1 条(<3)，章节有 3 条(>=3) → decision=parent."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    result = await svc.retrieve_chunks("Plan-and-Solve", include_rag=False)
    assert result["decision"] == "parent"
    assert result["via_parent"] is True
    # 上卷层聚合章节自身(3) + 子知识点切片(4) = 7
    assert result["stats"] == {"exact": 1, "parent": 7, "rag": 0}
    assert all(c["source"] == "parent" for c in result["chunks"])


@pytest.mark.asyncio
async def test_rag_fallback_when_all_layers_empty(knowledge_db: AsyncSession):
    """精确/父级全空 → RAG 兜底."""
    fake_rag = FakeRag(
        chunks=[
            {"id": "ragf_7", "content": "HelloAgents 环境搭建教程", "similarity": 0.61, "document_id": "doc1"},
            {"id": "ragf_8", "content": "HelloAgents 目录结构", "similarity": 0.55, "document_id": "doc1"},
        ]
    )
    svc = KnowledgeRetrievalService(knowledge_db, rag=fake_rag)
    result = await svc.retrieve_chunks("环境搭建")
    assert result["decision"] == "rag"
    assert result["stats"] == {"exact": 0, "parent": 0, "rag": 2}
    assert result["via_parent"] is False
    assert all(c["source"] == "rag" for c in result["chunks"])
    rag_hit = result["chunks"][0]
    assert rag_hit["similarity"] == 0.61
    assert rag_hit["ragflow_chunk_id"] == "ragf_7"


@pytest.mark.asyncio
async def test_rag_disabled_returns_empty(knowledge_db: AsyncSession):
    """include_rag=false 且各层不足 → decision=empty."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    result = await svc.retrieve_chunks("环境搭建", include_rag=False)
    assert result["decision"] == "empty"
    assert result["warning"] == "低于阈值且 include_rag=false"


@pytest.mark.asyncio
async def test_unknown_knowledge_point_goes_rag(knowledge_db: AsyncSession):
    """知识点名未命中目录树 → 直接 RAG."""
    fake_rag = FakeRag(
        chunks=[{"id": "ragf_x", "content": "不存在的知识点内容", "similarity": 0.5, "document_id": "doc1"}]
    )
    svc = KnowledgeRetrievalService(knowledge_db, rag=fake_rag)
    result = await svc.retrieve_chunks("完全不存在的知识点XYZ")
    assert result["decision"] == "rag"
    assert result["category_id"] is None
    assert result["stats"]["rag"] == 1
    assert result["warning"] is not None


@pytest.mark.asyncio
async def test_unknown_domain(knowledge_db: AsyncSession):
    """领域不存在 → empty + warning."""
    svc = KnowledgeRetrievalService(knowledge_db, rag=FakeRag())
    result = await svc.retrieve_chunks("ReAct范式", domain="nope")
    assert result["decision"] == "empty"
    assert "领域不存在" in result["warning"]


@pytest.mark.asyncio
async def test_rag_failure_degrades_gracefully(knowledge_db: AsyncSession):
    """RAGFlow 不可达 → 降级返回 empty + warning，不抛异常."""

    class BrokenRag(FakeRag):
        async def retrieve(self, *a, **kw):
            raise RuntimeError("connection refused")

    svc = KnowledgeRetrievalService(knowledge_db, rag=BrokenRag())
    result = await svc.retrieve_chunks("环境搭建")
    assert result["decision"] == "empty"
    assert "RAGFlow 检索失败" in result["warning"]


# ── 分类审计与纠错（精确层错挂自愈） ───────────────────────────────────────


@pytest.mark.asyncio
async def test_classification_audit_lists_low_confidence_first(knowledge_db: AsyncSession):
    """审计列表按置信度升序（最可疑排最前）且只含 <= max_confidence 的记录."""
    from app.knowledge.services.classification_service import ClassificationService

    svc = ClassificationService(knowledge_db)
    data = await svc.list_audit(domain_id=1, max_confidence=0.7)
    assert data["total"] == 4  # 0.7/0.6/0.6/0.6 四条
    confs = [i["confidence"] for i in data["items"]]
    assert confs == sorted(confs)
    assert all(c <= 0.7 for c in confs)
    assert data["items"][0]["chunk_code"] == "chunk_000004"  # 0.6 最可疑排最前


@pytest.mark.asyncio
async def test_classification_audit_filter_by_source(knowledge_db: AsyncSession):
    """按 source 过滤：llm 4 条；无记录的其他 source → 0 条."""
    from app.knowledge.services.classification_service import ClassificationService

    svc = ClassificationService(knowledge_db)
    data = await svc.list_audit(domain_id=1, max_confidence=1.0, source="llm")
    assert data["total"] == 7
    data2 = await svc.list_audit(domain_id=1, max_confidence=1.0, source="manual")
    assert data2["total"] == 0


@pytest.mark.asyncio
async def test_classification_correct_delete(knowledge_db: AsyncSession):
    """纠错-删除：删除 chunk_000004 → 章节(2) 的错挂分类."""
    from app.knowledge.services.classification_service import ClassificationService

    svc = ClassificationService(knowledge_db)
    result = await svc.correct(action="delete", chunk_id=4, old_category_id=2)
    assert result["ok"] is True
    assert result["action"] == "delete"
    # 记录已删
    data = await svc.list_audit(domain_id=1, max_confidence=1.0)
    assert data["total"] == 6


@pytest.mark.asyncio
async def test_classification_correct_move(knowledge_db: AsyncSession):
    """纠错-改挂：chunk_000004 从章节(2) 改挂到 ReAct(3)，写 source='manual'."""
    from app.knowledge.services.classification_service import ClassificationService

    svc = ClassificationService(knowledge_db)
    result = await svc.correct(
        action="move", chunk_id=4, old_category_id=2, new_category_id=3, confidence=0.95
    )
    assert result["ok"] is True
    assert result["action"] == "move"
    # 验证新归属存在且 source=manual
    row = (
        await knowledge_db.execute(
            text(
                "SELECT chunk_id, category_id, confidence, source FROM knowledge_chunk_category "
                "WHERE chunk_id = 4 AND category_id = 3"
            )
        )
    ).mappings().first()
    assert row is not None
    assert float(row["confidence"]) == 0.95
    assert row["source"] == "manual"
    # 旧归属已删除
    old = (
        await knowledge_db.execute(
            text("SELECT 1 FROM knowledge_chunk_category WHERE chunk_id = 4 AND category_id = 2")
        )
    ).first()
    assert old is None


@pytest.mark.asyncio
async def test_classification_correct_set_confidence(knowledge_db: AsyncSession):
    """纠错-调置信度：只改 confidence 不动归属."""
    from app.knowledge.services.classification_service import ClassificationService

    svc = ClassificationService(knowledge_db)
    result = await svc.correct(action="set_confidence", chunk_id=1, old_category_id=3, confidence=0.99)
    assert result["ok"] is True
    row = (
        await knowledge_db.execute(
            text("SELECT confidence FROM knowledge_chunk_category WHERE chunk_id = 1 AND category_id = 3")
        )
    ).mappings().first()
    assert float(row["confidence"]) == 0.99


@pytest.mark.asyncio
async def test_classification_correct_missing_target(knowledge_db: AsyncSession):
    """目标记录不存在 → ok=False + error."""
    from app.knowledge.services.classification_service import ClassificationService

    svc = ClassificationService(knowledge_db)
    result = await svc.correct(action="delete", classification_id=99999)
    assert result["ok"] is False
    assert "不存在" in result["error"]


@pytest.mark.asyncio
async def test_classification_correct_move_to_missing_category(knowledge_db: AsyncSession):
    """改挂到不存在的知识点 → ok=False + error."""
    from app.knowledge.services.classification_service import ClassificationService

    svc = ClassificationService(knowledge_db)
    result = await svc.correct(action="move", chunk_id=1, old_category_id=3, new_category_id=99999)
    assert result["ok"] is False
    assert "目标知识点不存在" in result["error"]


@pytest.mark.asyncio
async def test_classification_correct_assign(knowledge_db: AsyncSession):
    """新增归属：无归属切片 → assign 到知识点，且替换已有分类（单归属）."""
    from app.knowledge.services.classification_service import ClassificationService

    svc = ClassificationService(knowledge_db)
    # chunk_000007 原本挂 ReAct(3)，assign 到章节子节点 Plan(4) 会先清旧再写新
    result = await svc.correct(action="assign", chunk_id=7, new_category_id=4, confidence=0.85)
    assert result["ok"] is True
    assert result["action"] == "assign"
    # 只保留一条新归属
    rows = (
        await knowledge_db.execute(
            text("SELECT category_id, confidence, source FROM knowledge_chunk_category WHERE chunk_id = 7")
        )
    ).mappings().all()
    assert len(rows) == 1
    assert rows[0]["category_id"] == 4
    assert float(rows[0]["confidence"]) == 0.85
    assert rows[0]["source"] == "manual"


@pytest.mark.asyncio
async def test_classification_correct_assign_missing_params(knowledge_db: AsyncSession):
    """assign 缺参数 → ok=False + error."""
    from app.knowledge.services.classification_service import ClassificationService

    svc = ClassificationService(knowledge_db)
    result = await svc.correct(action="assign", chunk_id=1)
    assert result["ok"] is False
    assert "assign 需要" in result["error"]


# ── chunks_by_ids（题库 get_evidence 数据源） ───────────────────────────


@pytest.mark.asyncio
async def test_chunks_by_ids_returns_in_request_order(knowledge_db: AsyncSession):
    """按请求顺序回取切片，非法/不存在 ID 静默跳过."""
    svc = KnowledgeRetrievalService(knowledge_db)
    hits = await svc.chunks_by_ids([3, 1, 999, 0])
    assert [h["chunk_id"] for h in hits] == [3, 1]
    assert hits[0]["content"] == "Plan-and-Solve 概述三"
    assert hits[0]["source"] == "mysql"
    assert hits[0]["document_id"] == "10"  # 与 ChunkHit 模型一致（str）
    assert hits[0]["confidence"] is None


@pytest.mark.asyncio
async def test_chunks_by_ids_empty_input(knowledge_db: AsyncSession):
    """空 ID 列表 → 空结果，不报错."""
    svc = KnowledgeRetrievalService(knowledge_db)
    assert await svc.chunks_by_ids([]) == []
    assert await svc.chunks_by_ids([0, -1]) == []
