"""Tests for DecisionService."""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.decision.services.decision_service import DecisionService, HF_THRESHOLDS


# ── T2.4：双轨评分诚实化 ─────────────────────────────────────────────────


def test_hf_weights_positive_sum_to_one():
    """freshness 已并入 applicability：正权重（不含 conflict_risk 负项）之和为 1."""
    weights = DecisionService.HF_WEIGHTS
    assert "freshness" not in weights
    positive_sum = sum(v for k, v in weights.items() if k != "conflict_risk")
    assert positive_sum == pytest.approx(1.0)
    assert weights["conflict_risk"] < 0


def test_hf_thresholds_module_constant():
    """HF_THRESHOLDS 抽成模块常量，DecisionService.HF_THRESHOLDS 与之一致（兼容旧用法）."""
    assert DecisionService.HF_THRESHOLDS == HF_THRESHOLDS
    # 2026-08-20 按 40 条 qa_golden 校准落地（详见修改记录 2026-08-20）
    assert HF_THRESHOLDS == {"high": 0.5, "medium": 0.3, "low": 0.1}


@pytest.mark.asyncio
async def test_hf_memory_breakdown_visible(db_session: AsyncSession):
    """_hf_memory 返回 (score, breakdown)：各维度贡献可见，用于 audit_trail 展示."""
    service = DecisionService(db_session)
    eligibility = {
        "is_eligible": True,
        "scores": {
            "coverage": 0.8,
            "authority": 0.9,
            "applicability": 0.7,
            "conflict_risk": 0.1,
        },
    }
    hf_score, breakdown = service._hf_memory(
        eligibility, {"source_independence_score": 0.5}, graph_consistency=0.8
    )
    assert set(breakdown.keys()) == set(DecisionService.HF_WEIGHTS.keys())
    assert breakdown["graph_consistency"] == pytest.approx(0.15 * 0.8)
    assert hf_score == pytest.approx(sum(breakdown.values()))


@pytest.mark.asyncio
async def test_hf_memory_not_eligible_zero_breakdown(db_session: AsyncSession):
    """不资格 → 各维度贡献均为 0，hf_score 为 0."""
    service = DecisionService(db_session)
    hf_score, breakdown = service._hf_memory({"is_eligible": False}, {}, graph_consistency=1.0)
    assert hf_score == 0.0
    assert all(v == 0.0 for v in breakdown.values())


@pytest.mark.asyncio
async def test_check_eligibility(db_session: AsyncSession):
    """Test eligibility check."""
    service = DecisionService(db_session)

    # Create a mock fact snapshot
    fact_snapshot = {
        "fact_id": "fact_test",
        "query": "test query",
        "task_type": "question",
    }

    # Test with empty evidence (should fail eligibility)
    eligibility = await service.check_eligibility(
        fact_snapshot=fact_snapshot,
        evidence_pack_id="nonexistent",
        rule_results={"passed": True},
        graph_validation={"is_consistent": True},
    )

    assert "is_eligible" in eligibility
    assert "gate_type" in eligibility
    assert "failure_reasons" in eligibility


@pytest.mark.asyncio
async def test_calculate_hf_score(db_session: AsyncSession):
    """Test HF score calculation."""
    service = DecisionService(db_session)

    # Test with eligible eligibility
    eligibility = {
        "is_eligible": True,
        "scores": {
            "coverage": 0.8,
            "authority": 0.9,
            "applicability": 0.7,
            "freshness": 0.8,
            "conflict_risk": 0.1,
        },
    }

    hf_score = await service.calculate_high_fidelity_score(
        eligibility=eligibility,
        evidence_pack_id="test_pack",
        graph_validation={"consistency_score": 1.0},
    )

    assert 0.0 <= hf_score <= 1.0
    assert hf_score > 0.5  # Should be reasonably high


@pytest.mark.asyncio
async def test_calculate_hf_score_not_eligible(db_session: AsyncSession):
    """Test HF score calculation when not eligible."""
    service = DecisionService(db_session)

    # Test with non-eligible eligibility
    eligibility = {
        "is_eligible": False,
        "scores": {},
    }

    hf_score = await service.calculate_high_fidelity_score(
        eligibility=eligibility,
        evidence_pack_id="test_pack",
        graph_validation={"consistency_score": 1.0},
    )

    assert hf_score == 0.0


@pytest.mark.asyncio
async def test_generate_decision_contract(db_session: AsyncSession):
    """Test decision contract generation."""
    service = DecisionService(db_session)

    contract = await service.generate_decision_contract(
        domain_id="test_domain",
        snapshot_id="test_snapshot",
        decision_status="permit",
        hf_score=0.85,
        evidence_pack_id="test_pack",
        matched_rules=["rule_001"],
        fact_snapshot={
            "fact_id": "fact_test",
            "query": "test query",
            "task_type": "question",
        },
        eligibility={
            "is_eligible": True,
            "coverage_passed": True,
            "authority_passed": True,
            "applicability_passed": True,
            "freshness_passed": True,
            "conflict_check_passed": True,
            "failure_reasons": [],
            "remediation_suggestions": [],
        },
    )

    assert contract["contract_id"].startswith("kdc_")
    assert contract["decision"] == "permit"
    assert contract["high_fidelity_score"] == 0.85
    assert "permitted_actions" in contract
    assert "required_citations" in contract
    assert "audit_trail" in contract


@pytest.mark.asyncio
async def test_generate_decision_contract_blocked(db_session: AsyncSession):
    """Test decision contract generation for blocked decision."""
    service = DecisionService(db_session)

    contract = await service.generate_decision_contract(
        domain_id="test_domain",
        snapshot_id="test_snapshot",
        decision_status="block",
        hf_score=0.0,
        evidence_pack_id="test_pack",
        matched_rules=[],
        fact_snapshot={
            "fact_id": "fact_test",
            "query": "test query",
            "task_type": "question",
        },
        eligibility={
            "is_eligible": False,
            "coverage_passed": False,
            "authority_passed": False,
            "applicability_passed": True,
            "freshness_passed": True,
            "conflict_check_passed": True,
            "failure_reasons": ["Coverage insufficient"],
            "remediation_suggestions": ["Add more evidence"],
        },
    )

    assert contract["decision"] == "block"
    assert contract["high_fidelity_score"] == 0.0
    assert "any_response" in contract["prohibited_content"]


@pytest.mark.asyncio
async def test_determine_permitted_actions(db_session: AsyncSession):
    """Test permitted actions determination."""
    service = DecisionService(db_session)

    # Test permit
    actions = service._determine_permitted_actions("permit", 0.9)
    assert "answer_question" in actions
    assert "provide_explanation" in actions

    # Test block
    actions = service._determine_permitted_actions("block", 0.0)
    assert len(actions) == 0

    # Test restrict_scope
    actions = service._determine_permitted_actions("restrict_scope", 0.6)
    assert "answer_question" in actions
    assert "provide_explanation" in actions

    # Test restrict_scope with low score
    actions = service._determine_permitted_actions("restrict_scope", 0.3)
    assert "answer_question" in actions
    assert "provide_explanation" not in actions
