"""DecisionService.resolve 纯内存链路测试（仅依赖 knowledge_* 六表，不落任何新表）.

验证：领域取自 knowledge_domain、规则用内置默认、证据走三级降级检索、
事实快照/证据包/决策契约全部内存化。
"""

from __future__ import annotations

from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.decision.services.decision_service import DecisionService
from app.knowledge.services.retrieval_service import KnowledgeRetrievalService

from tests.test_knowledge_retrieval import DDL, SEED, FakeRag


@pytest_asyncio.fixture
async def knowledge_db(db_session: AsyncSession):
    """建 knowledge 四表 + 灌种子数据."""
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
    judge=None,
) -> DecisionService:
    retriever = KnowledgeRetrievalService(db, rag=FakeRag(chunks=rag_chunks or []))
    return DecisionService(db, knowledge_retriever=retriever, judge=judge)


@pytest.mark.asyncio
async def test_resolve_permit_full_flow(knowledge_db: AsyncSession):
    """完整链路：ReAct 精确层 3 条 → 门控全过 → decision=permit + HF 评分."""
    service = make_service(knowledge_db)
    contract = await service.resolve(
        query="ReAct范式",
        dataset_ids=["ds_1"],
    )

    assert contract["contract_id"].startswith("kdc_")
    assert contract["decision"] == "permit"
    assert contract["high_fidelity_score"] > 0.5
    assert contract["domain_runtime_snapshot_id"] == "kdom_1"  # knowledge_domain id=1
    assert contract["fact_snapshot_id"].startswith("fact_")
    assert contract["evidence_pack_id"].startswith("epack_mem_")
    # 证据来自 MySQL 精确层（ReAct 3 条）
    assert contract["evidence_count"] == 3
    assert len(contract["required_citations"]) == 3
    assert "answer_question" in contract["permitted_actions"]
    # 内置规则：证据充足（3 条）→ evidence_count_below 不应命中（修复 A1：context 注入 evidence_pack）
    rule_ids = [r["rule_id"] for r in contract["rule_hits"]]
    assert "rule_evidence_min" not in rule_ids
    assert isinstance(contract["rule_hits"], list)
    assert contract["audit_trail"][0]["step"] == "eligibility_check"
    assert contract["created_at"]


@pytest.mark.asyncio
async def test_resolve_no_evidence_retrieve_again(knowledge_db: AsyncSession):
    """无任何证据（树中无节点 + RAG 无结果）→ decision=retrieve_again，不崩溃."""
    service = make_service(knowledge_db)
    contract = await service.resolve(
        query="完全不存在的内容",
        dataset_ids=["ds_1"],
    )

    assert contract["decision"] == "retrieve_again"
    assert contract["evidence_count"] == 0
    assert contract["high_fidelity_score"] == 0.0
    assert "证据数量不足" in " ".join(contract["eligibility"]["failure_reasons"])
    # 证据为 0 → evidence_count_below 命中（真实反映证据不足）
    rule_ids = [r["rule_id"] for r in contract["rule_hits"]]
    assert "rule_evidence_min" in rule_ids


@pytest.mark.asyncio
async def test_resolve_rag_fallback(knowledge_db: AsyncSession):
    """树上命中知识点但无切片 → RAG 兜底证据 → 可 permit."""
    fake_chunks = [
        {"id": "ragf_7", "content": "HelloAgents 环境搭建教程", "similarity": 0.61, "document_id": "doc1"},
        {"id": "ragf_8", "content": "HelloAgents 目录结构", "similarity": 0.55, "document_id": "doc1"},
    ]
    service = make_service(knowledge_db, rag_chunks=fake_chunks)
    contract = await service.resolve(
        query="环境搭建",
        dataset_ids=["ds_1"],
    )

    assert contract["evidence_count"] == 2
    assert contract["required_citations"] == ["ragf_7", "ragf_8"]
    assert contract["decision"] == "permit"


@pytest.mark.asyncio
async def test_resolve_high_risk_task_rule_hit(knowledge_db: AsyncSession):
    """task_type=exercise → 内置 high_risk_task 规则命中 → rule_hits 有记录."""
    service = make_service(knowledge_db)
    contract = await service.resolve(
        query="ReAct范式",
        task_type="exercise",
        dataset_ids=["ds_1"],
    )

    rule_ids = [r["rule_id"] for r in contract["rule_hits"]]
    assert "rule_high_risk_task" in rule_ids


@pytest.mark.asyncio
async def test_resolve_does_not_write_any_table(knowledge_db: AsyncSession):
    """不落库验证：resolve 前后 knowledge 表行数不变，且不触碰其他表."""
    service = make_service(knowledge_db)

    async def counts() -> dict[str, int]:
        out = {}
        for t in ("knowledge_chunk", "knowledge_chunk_category", "knowledge_category", "knowledge_domain"):
            r = await knowledge_db.execute(text(f"SELECT COUNT(*) FROM {t}"))
            out[t] = r.scalar()
        return out

    before = await counts()
    await service.resolve(query="ReAct范式", dataset_ids=["ds_1"])
    await service.resolve(query="环境搭建", dataset_ids=["ds_1"])
    after = await counts()

    assert before == after


@pytest.mark.asyncio
async def test_resolve_default_rules_do_not_block(knowledge_db: AsyncSession):
    """内置默认规则为 soft（restrict 不 block）→ 证据充足时仍 permit."""
    service = make_service(knowledge_db)
    contract = await service.resolve(
        query="ReAct范式",
        task_type="troubleshooting",  # 高风险任务，规则命中但只 restrict
        dataset_ids=["ds_1"],
    )

    # restrict 不改变裁决，仅记录
    assert contract["decision"] == "permit"
    assert any(r["rule_id"] == "rule_high_risk_task" for r in contract["rule_hits"])


@pytest.mark.asyncio
async def test_resolve_with_judge_filters_evidence(knowledge_db: AsyncSession):
    """LLM judge 剔除 1 条不相关证据 → 契约证据数减少，applicability 基于保留项."""
    from tests.test_evidence_knowledge_retrieval import FakeJudge

    judge = FakeJudge(verdicts={0: True, 1: False, 2: True})
    service = make_service(knowledge_db, judge=judge)
    contract = await service.resolve(
        query="ReAct范式",
        dataset_ids=["ds_1"],
    )

    assert contract["evidence_count"] == 2  # 3 → 2
    # 被剔除的切片不出现在必需引用中
    assert len(contract["required_citations"]) == 2
    assert contract["decision"] == "permit"


@pytest.mark.asyncio
async def test_resolve_judge_failure_keeps_all(knowledge_db: AsyncSession):
    """judge 故障 → 证据全部保留，决策不受影响."""
    from tests.test_evidence_knowledge_retrieval import FakeJudge

    judge = FakeJudge(fail=True)
    service = make_service(knowledge_db, judge=judge)
    contract = await service.resolve(
        query="ReAct范式",
        dataset_ids=["ds_1"],
    )

    assert contract["evidence_count"] == 3
    assert contract["decision"] == "permit"


# ── T1.2 / T2.4：graph_consistency 真值化 + HF 明细可见 ────────────────────


@pytest.mark.asyncio
async def test_resolve_audit_trail_has_hf_breakdown(knowledge_db: AsyncSession):
    """audit_trail 含 hf_scoring(各维度贡献) 与 graph_consistency_detail 两步.

    此 fixture 未建 knowledge_category_prerequisite 表 → 图查询失败，
    graph_consistency 走兼容默认值 0.8（与 T1.2 手册"查询失败返回 0.8"一致）。
    """
    service = make_service(knowledge_db)
    contract = await service.resolve(query="ReAct范式", dataset_ids=["ds_1"])

    steps = {s["step"]: s for s in contract["audit_trail"]}
    assert "hf_scoring" in steps
    breakdown = steps["hf_scoring"]["result"]["hf_breakdown"]
    assert set(breakdown.keys()) == set(service.HF_WEIGHTS.keys())
    assert breakdown["graph_consistency"] == pytest.approx(service.HF_WEIGHTS["graph_consistency"] * 0.8)

    assert "graph_consistency_detail" in steps
    assert steps["graph_consistency_detail"]["result"]["details"] == []


@pytest.mark.asyncio
async def test_resolve_graph_consistency_same_category_when_graph_present(knowledge_db: AsyncSession):
    """图谱非空时，证据与问题同知识点（category_id=3）→ 一致性同点 1.0."""
    from sqlalchemy import text

    # 该表已由 SQLAlchemy Base metadata（PrerequisiteEdgeORM，BIGINT 主键）建过，
    # SQLite 下 BIGINT 主键不具备 rowid 别名自增语义，需 DROP 后按 INTEGER PRIMARY KEY 重建
    # （与 tests/test_prerequisite_graph.py 的做法一致）。
    await knowledge_db.execute(text("DROP TABLE IF EXISTS knowledge_category_prerequisite"))
    await knowledge_db.execute(
        text(
            "CREATE TABLE knowledge_category_prerequisite ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, domain_id INTEGER NOT NULL, "
            "category_id INTEGER NOT NULL, prereq_category_id INTEGER NOT NULL, "
            "edge_type VARCHAR(32) NOT NULL DEFAULT 'prerequisite', status VARCHAR(20) NOT NULL DEFAULT 'active', "
            "source VARCHAR(32) NOT NULL DEFAULT 'human')"
        )
    )
    # 与本次查询无关的一条边，仅用于让"图非空"成立
    await knowledge_db.execute(
        text(
            "INSERT INTO knowledge_category_prerequisite "
            "(domain_id, category_id, prereq_category_id, status) VALUES (1, 4, 5, 'active')"
        )
    )
    await knowledge_db.commit()

    service = make_service(knowledge_db)
    contract = await service.resolve(query="ReAct范式", dataset_ids=["ds_1"])
    steps = {s["step"]: s for s in contract["audit_trail"]}
    details = steps["graph_consistency_detail"]["result"]["details"]
    # 3 条证据（chunk 1/2/6）均属 category_id=3（DISTINCT 去重后 1 条），问题同样解析到 3
    assert len(details) == 1
    assert all(d["distance"] == 0 and d["score"] == pytest.approx(1.0) for d in details)

    await knowledge_db.execute(text("DROP TABLE IF EXISTS knowledge_category_prerequisite"))
    await knowledge_db.commit()


# ── T1.3：task_type → prefer 映射 ──────────────────────────────────────────


def test_prefer_for_task_type_mapping():
    """exercise/troubleshooting → code；question/explanation/None → 不特殊排序."""
    assert DecisionService._prefer_for_task_type("exercise") == "code"
    assert DecisionService._prefer_for_task_type("troubleshooting") == "code"
    assert DecisionService._prefer_for_task_type("question") is None
    assert DecisionService._prefer_for_task_type("explanation") is None
    assert DecisionService._prefer_for_task_type(None) is None


@pytest.mark.asyncio
async def test_resolve_exercise_task_type_reorder_failure_degrades_gracefully(knowledge_db: AsyncSession):
    """练习类任务触发 prefer=code 重排；参考检索列缺失等异常时静默降级，decision 不受影响."""
    service = make_service(knowledge_db)
    contract = await service.resolve(
        query="ReAct范式",
        task_type="exercise",
        dataset_ids=["ds_1"],
    )
    assert contract["decision"] == "permit"
    assert contract["evidence_count"] == 3


# ── T2.3：门控 insufficient_evidence → miss 日志 ──────────────────────────


@pytest.mark.asyncio
async def test_resolve_gate_insufficient_evidence_logs_miss(knowledge_db: AsyncSession):
    """证据不足（gate_type=insufficient_evidence）→ knowledge_retrieval_miss 出现 stage=gate 记录."""
    from sqlalchemy import text

    await knowledge_db.execute(
        text(
            "CREATE TABLE IF NOT EXISTS knowledge_retrieval_miss ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT, domain_id INTEGER, "
            "stage VARCHAR(16), task_type VARCHAR(32), created_at TEXT)"
        )
    )
    await knowledge_db.commit()

    service = make_service(knowledge_db)
    contract = await service.resolve(query="完全不存在的内容", dataset_ids=["ds_1"])
    assert contract["decision"] == "retrieve_again"

    rows = (
        await knowledge_db.execute(text("SELECT stage FROM knowledge_retrieval_miss"))
    ).mappings().all()
    stages = [r["stage"] for r in rows]
    assert "gate" in stages

    await knowledge_db.execute(text("DROP TABLE IF EXISTS knowledge_retrieval_miss"))
    await knowledge_db.commit()
