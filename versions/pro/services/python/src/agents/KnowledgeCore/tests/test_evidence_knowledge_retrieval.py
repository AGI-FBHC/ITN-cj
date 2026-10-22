"""EvidenceService 检索层复用 knowledge 模块三级降级检索的测试.

验证 search_evidence 不再直连 RAGFlow，而是走
KnowledgeRetrievalService.retrieve_chunks（MySQL 精确 → 父级上卷 → RAG 兜底），
并把 ChunkHit 转换为 evidence items 落库。
"""

from __future__ import annotations

from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.evidence.services.evidence_service import EvidenceService
from app.knowledge.services.retrieval_service import KnowledgeRetrievalService

from tests.test_knowledge_retrieval import DDL, SEED, FakeRag


@pytest_asyncio.fixture
async def knowledge_db(db_session: AsyncSession):
    """建 knowledge 四表 + 灌种子数据（与 knowledge 模块测试共用）. """
    for ddl in DDL:
        await db_session.execute(text(ddl))
    for stmt in SEED:
        await db_session.execute(text(stmt))
    await db_session.commit()
    yield db_session
    for table in ("knowledge_chunk_category", "knowledge_chunk", "knowledge_category", "knowledge_document", "knowledge_domain"):
        await db_session.execute(text(f"DROP TABLE IF EXISTS {table}"))
    await db_session.commit()


def make_service(
    db: AsyncSession,
    rag_chunks: list[dict[str, Any]] | None = None,
) -> EvidenceService:
    """构造注入 FakeRag 的 EvidenceService."""
    retriever = KnowledgeRetrievalService(db, rag=FakeRag(chunks=rag_chunks or []))
    return EvidenceService(db, knowledge_retriever=retriever)


@pytest.mark.asyncio
async def test_search_evidence_uses_mysql_exact_layer(knowledge_db: AsyncSession):
    """检索走 knowledge 三级降级的①MySQL 精确层：ReAct 3 条切片全量转 evidence items."""
    service = make_service(knowledge_db)
    pack = await service.search_evidence(
        domain_id="dmn_test",
        query="ReAct范式",
        dataset_ids=["ds_1"],
    )

    items = await service.get_evidence_items(pack.pack_id)
    assert len(items) == 3  # chunk 1/2/6 → ReAct 知识点（id=3）
    contents = [i.content for i in items]
    assert "ReAct 范式内容一" in contents
    # mysql 层无相似度 → 用分类置信度作为评分
    assert all(i.similarity_score > 0 for i in items)
    # chunk_id 落库为 knowledge_chunk.id
    assert {i.chunk_id for i in items} == {"1", "2", "6"}
    # 包评分被计算
    assert pack.coverage_score == pytest.approx(1.0)


@pytest.mark.asyncio
async def test_search_evidence_rag_fallback(knowledge_db: AsyncSession):
    """精确层命中知识点但无切片 → 上卷也无 → RAG 兜底（FakeRag 返回 2 条）."""
    fake_chunks = [
        {"id": "ragf_7", "content": "HelloAgents 环境搭建教程", "similarity": 0.61, "document_id": "doc1"},
        {"id": "ragf_8", "content": "HelloAgents 目录结构", "similarity": 0.55, "document_id": "doc1"},
    ]
    service = make_service(knowledge_db, rag_chunks=fake_chunks)
    pack = await service.search_evidence(
        domain_id="dmn_test",
        query="环境搭建",  # 树中有该知识点（id=7）但无切片
        dataset_ids=["ds_1"],
    )

    items = await service.get_evidence_items(pack.pack_id)
    assert len(items) == 2
    assert {i.chunk_id for i in items} == {"ragf_7", "ragf_8"}  # RAG 命中取 ragflow_chunk_id
    assert {i.similarity_score for i in items} == {0.61, 0.55}
    assert pack.coverage_score == pytest.approx(2 / 3)


@pytest.mark.asyncio
async def test_search_evidence_unknown_point_goes_rag(knowledge_db: AsyncSession):
    """自然语言问题（树中无节点）→ 直接 RAG 兜底."""
    fake_chunks = [
        {"id": "ragf_9", "content": "ACID 事务特性", "similarity": 0.7, "document_id": "doc2"},
    ]
    service = make_service(knowledge_db, rag_chunks=fake_chunks)
    pack = await service.search_evidence(
        domain_id="dmn_test",
        query="什么是数据库事务的 ACID 特性？",
        dataset_ids=["ds_1"],
    )

    items = await service.get_evidence_items(pack.pack_id)
    assert len(items) == 1
    assert items[0].content == "ACID 事务特性"
    assert items[0].similarity_score == 0.7


@pytest.mark.asyncio
async def test_search_evidence_domain_id_fallback(knowledge_db: AsyncSession):
    """decision 的 domain_id 匹配不到 knowledge 领域 → 回退第一个领域（agent）仍可检索."""
    service = make_service(knowledge_db)
    pack = await service.search_evidence(
        domain_id="dmn_nonexistent",
        query="ReAct范式",
        dataset_ids=["ds_1"],
    )

    items = await service.get_evidence_items(pack.pack_id)
    assert len(items) == 3


@pytest.mark.asyncio
async def test_search_evidence_without_datasets_skips_retrieval(knowledge_db: AsyncSession):
    """不传 dataset_ids → 不触发检索，pack 仍创建成功（原有行为保持）."""
    service = make_service(knowledge_db)
    pack = await service.search_evidence(
        domain_id="dmn_test",
        query="ReAct范式",
    )

    assert pack.pack_id.startswith("epack_")
    items = await service.get_evidence_items(pack.pack_id)
    assert items == []


# ── 六维评分真值化（authority/freshness/conflict 接入真实信号） ──────────


def make_inline_service(
    db: AsyncSession,
    rag_chunks: list[dict[str, Any]] | None = None,
) -> EvidenceService:
    """构造注入 FakeRag 的 EvidenceService（inline 检索用）."""
    retriever = KnowledgeRetrievalService(db, rag=FakeRag(chunks=rag_chunks or []))
    return EvidenceService(db, knowledge_retriever=retriever)


@pytest.mark.asyncio
async def test_inline_authority_freshness_from_document_meta(knowledge_db: AsyncSession):
    """mysql 精确层命中 → authority=文档 reliability_score(0.9)，freshness 按 publish_year(2025) 计算."""
    service = make_inline_service(knowledge_db)
    result = await service.search_evidence_inline(
        query="ReAct范式",
        domain_code="agent",
        dataset_ids=["ds_1"],
    )

    assert result["decision"] == "mysql"
    assert len(result["items"]) == 3
    # 文档元数据已挂到 item.metadata.doc
    docs = {it["metadata"]["doc"]["id"] for it in result["items"] if it.get("metadata", {}).get("doc")}
    assert docs == {10}
    # authority 来自 reliability_score=0.9（不再恒 1.0）
    assert result["scores"]["authority_score"] == pytest.approx(0.9)
    # freshness = 1 - (2026-2025)/10 = 0.9（不再恒 0.8）
    assert result["scores"]["freshness_score"] == pytest.approx(0.9)
    # conflict 无冲突 → 0
    assert result["scores"]["conflict_risk_score"] == 0.0


@pytest.mark.asyncio
async def test_inline_rag_items_resolve_doc_meta_via_ragflow_id(knowledge_db: AsyncSession):
    """RAG 兜底命中 → chunk_id 为 RAGFlow id → 经 knowledge_chunk.ragflow_chunk_id 反查文档元数据."""
    fake_chunks = [
        {"id": "ragf_6", "content": "ReAct 深入原理", "similarity": 0.61, "document_id": "doc1"},
        {"id": "ragf_7", "content": "HelloAgents 环境搭建教程", "similarity": 0.55, "document_id": "doc1"},
    ]
    service = make_inline_service(knowledge_db, rag_chunks=fake_chunks)
    result = await service.search_evidence_inline(
        query="环境搭建",
        domain_code="agent",
        dataset_ids=["ds_1"],
    )

    assert len(result["items"]) == 2
    # ragf_6 / ragf_7 在测试 SEED 中对应 knowledge_chunk(6, 7)，document_id=10
    assert all(it.get("metadata", {}).get("doc", {}).get("id") == 10 for it in result["items"])
    assert result["scores"]["authority_score"] == pytest.approx(0.9)
    assert result["scores"]["freshness_score"] == pytest.approx(0.9)


@pytest.mark.asyncio
async def test_inline_no_doc_meta_falls_back_to_defaults(knowledge_db: AsyncSession):
    """文档元数据缺失（chunk 无对应文档/查询失败）→ authority/freshness 回退 0.8，不崩溃."""
    service = make_inline_service(knowledge_db)
    items = [
        {
            "evidence_id": "evi_x1",
            "chunk_id": "99999",  # 不存在的 chunk
            "document_id": "99999",
            "content": "测试内容",
            "similarity_score": 0.7,
        },
    ]
    await service._attach_document_meta(items)
    assert items[0].get("metadata", {}).get("doc") is None
    scores = service._calculate_pack_scores(items)
    assert scores["authority_score"] == 0.8
    assert scores["freshness_score"] == 0.8
    assert scores["applicability_score"] == pytest.approx(0.7)


@pytest.mark.asyncio
async def test_detect_conflicts_similarity_and_duplicate(knowledge_db: AsyncSession):
    """同 section 内相似度极差 >0.3 与正文重复 → 两类冲突都被检出，折算进 conflict_risk."""
    service = make_inline_service(knowledge_db)
    items = [
        {"evidence_id": "evi_a", "section_path": "第四章/ReAct", "content": "ReAct 循环机制介绍", "similarity_score": 0.9},
        {"evidence_id": "evi_b", "section_path": "第四章/ReAct", "content": "ReAct 与计划无关的内容", "similarity_score": 0.2},
        {"evidence_id": "evi_c", "section_path": "第四章/ReAct", "content": "ReAct 循环机制介绍", "similarity_score": 0.85},
        {"evidence_id": "evi_d", "section_path": "第四章/ReAct", "content": "ReAct 循环机制介绍", "similarity_score": 0.88},
    ]
    conflicts = await service.detect_conflicts(items)
    types = {c["type"] for c in conflicts}
    assert "similarity_variance" in types
    assert "duplicate_content" in types

    scores = service._calculate_pack_scores(
        items,
        conflict_risk_score=min(1.0, len(conflicts) * 0.2),
    )
    assert scores["conflict_risk_score"] == pytest.approx(0.4)


# ── LLM 证据相关性复核（Evidence Judge / Context Precision） ──────────────


class FakeJudge:
    """测试用 LLM judge：按全局 index 判定相关/不相关；fail=True 模拟 LLM 故障."""

    def __init__(self, verdicts: dict[int, bool] | None = None, fail: bool = False):
        self.verdicts = verdicts or {}
        self.fail = fail
        self.calls = 0

    async def judge(self, query: str, items: list[dict]) -> dict:
        self.calls += 1
        if self.fail:
            raise RuntimeError("LLM down")
        kept, rejected = [], []
        for i, it in enumerate(items):
            if self.verdicts.get(i, True):
                kept.append(it)
            else:
                it["judge_reason"] = "测试剔除"
                rejected.append(it)
        return {"kept": kept, "rejected": rejected, "used_llm": True, "warning": None}


def make_judge_service(
    db: AsyncSession,
    judge: FakeJudge,
) -> EvidenceService:
    retriever = KnowledgeRetrievalService(db, rag=FakeRag(chunks=[]))
    return EvidenceService(db, knowledge_retriever=retriever, judge=judge)


@pytest.mark.asyncio
async def test_judge_filters_irrelevant_evidence(knowledge_db: AsyncSession):
    """judge 判定第 2 条不相关 → 证据被剔除，评分基于保留项重算."""
    judge = FakeJudge(verdicts={0: True, 1: False, 2: True})
    service = make_judge_service(knowledge_db, judge)
    result = await service.search_evidence_inline(
        query="ReAct范式",
        domain_code="agent",
        dataset_ids=["ds_1"],
    )

    assert judge.calls == 1
    assert result["judge"]["used_llm"] is True
    assert len(result["judge"]["rejected"]) == 1
    assert len(result["items"]) == 2  # 3 → 2
    # 被剔除的项不在 kept 里
    kept_contents = {it["content"] for it in result["items"]}
    assert "ReAct 代码实现二" not in kept_contents  # chunk 2 被剔除
    # 评分基于保留项重算（coverage = 2/3，applicability 为保留项均值）
    assert result["scores"]["coverage_score"] == pytest.approx(2 / 3)


@pytest.mark.asyncio
async def test_judge_failure_degrades_gracefully(knowledge_db: AsyncSession):
    """judge 抛异常 → 全部保留 + used_llm=False + warning，不中断检索."""
    judge = FakeJudge(fail=True)
    service = make_judge_service(knowledge_db, judge)
    result = await service.search_evidence_inline(
        query="ReAct范式",
        domain_code="agent",
        dataset_ids=["ds_1"],
    )

    assert result["judge"]["used_llm"] is False
    assert len(result["items"]) == 3  # 全部保留
    assert "LLM judge 异常" in result["judge"]["warning"]
    # 评分正常（未因 judge 失败而中断）
    assert result["scores"]["coverage_score"] == pytest.approx(1.0)


@pytest.mark.asyncio
async def test_judge_all_relevant_keeps_all(knowledge_db: AsyncSession):
    """全部相关 → 不过滤."""
    judge = FakeJudge(verdicts={0: True, 1: True, 2: True})
    service = make_judge_service(knowledge_db, judge)
    result = await service.search_evidence_inline(
        query="ReAct范式",
        domain_code="agent",
        dataset_ids=["ds_1"],
    )

    assert len(result["items"]) == 3
    assert len(result["judge"]["rejected"]) == 0


@pytest.mark.asyncio
async def test_judge_disabled_by_default(knowledge_db: AsyncSession):
    """未注入 judge 且未开启配置 → 不调用 LLM，全部保留."""
    service = make_inline_service(knowledge_db)  # 不注入 judge
    result = await service.search_evidence_inline(
        query="ReAct范式",
        domain_code="agent",
        dataset_ids=["ds_1"],
    )

    assert result["judge"]["used_llm"] is False
    assert len(result["items"]) == 3


@pytest.mark.asyncio
async def test_inline_without_dataset_ids_uses_mysql_layers(knowledge_db: AsyncSession):
    """不传 dataset_ids → 精确/上卷层照常工作（历史缺陷：整体跳过返回空包）."""
    service = make_inline_service(knowledge_db)
    result = await service.search_evidence_inline(
        query="ReAct范式",
        domain_code="agent",
    )

    assert result["decision"] == "mysql"
    assert len(result["items"]) == 3


@pytest.mark.asyncio
async def test_inline_without_dataset_ids_rag_fallback_self_discovers(knowledge_db: AsyncSession):
    """不传 dataset_ids 且知识点未命中 → RAG 兜底按领域 code 自发现数据集照常工作."""
    fake_chunks = [
        {"id": "ragf_6", "content": "ReAct 深入原理", "similarity": 0.9, "document_id": "doc1"},
    ]
    service = make_inline_service(knowledge_db, rag_chunks=fake_chunks)
    result = await service.search_evidence_inline(
        query="完全不存在的知识点XYZQWE",
        domain_code="agent",
    )

    assert result["decision"] == "rag"
    assert len(result["items"]) == 1
