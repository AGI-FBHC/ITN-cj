"""Tests for RuleService."""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.rules.services.rule_service import RuleService


@pytest.mark.asyncio
async def test_build_fact_snapshot(db_session: AsyncSession):
    """Test building a fact snapshot."""
    service = RuleService(db_session)

    task = {
        "query": "What is Python?",
        "task_type": "question",
        "user_context": {"level": "beginner"},
    }

    fact = await service.build_fact_snapshot(
        task=task,
        learner={"name": "test_learner"},
        domain_id="test_domain",
        snapshot_id="test_snapshot",
    )

    assert fact["fact_id"].startswith("fact_")
    assert fact["query"] == "What is Python?"
    assert fact["task_type"] == "question"
    assert fact["domain_runtime_snapshot_id"] == "test_snapshot"


@pytest.mark.asyncio
async def test_execute_rules(db_session: AsyncSession):
    """Test executing rules."""
    service = RuleService(db_session)

    fact_snapshot = {
        "fact_id": "fact_test",
        "query": "test query",
        "task_type": "question",
    }

    rules = [
        {
            "rule_id": "rule_001",
            "level": "hard",
            "name": "Test Rule",
            "predicate": "always",
            "action": "allow",
            "message": "Always allow",
        },
    ]

    result = await service.execute_rules(
        fact_snapshot=fact_snapshot,
        rules=rules,
        domain_id="test_domain",
    )

    assert result["passed"] is True
    assert len(result["hit_rules"]) == 1
    assert result["hit_rules"][0]["rule_id"] == "rule_001"


@pytest.mark.asyncio
async def test_execute_rules_block(db_session: AsyncSession):
    """Test executing rules that block."""
    service = RuleService(db_session)

    fact_snapshot = {
        "fact_id": "fact_test",
        "query": "test query",
        "task_type": "troubleshooting",
    }

    rules = [
        {
            "rule_id": "rule_block",
            "level": "hard",
            "name": "Block Rule",
            "predicate": "high_risk_task",
            "action": "block",
            "message": "Block high risk tasks",
        },
    ]

    result = await service.execute_rules(
        fact_snapshot=fact_snapshot,
        rules=rules,
        domain_id="test_domain",
    )

    assert result["passed"] is False
    assert len(result["blocked_by"]) == 1


@pytest.mark.asyncio
async def test_pre_retrieval_rules(db_session: AsyncSession):
    """Test pre-retrieval rules."""
    service = RuleService(db_session)

    fact_snapshot = {
        "fact_id": "fact_test",
        "query": "test query",
        "task_type": "question",
    }

    rules = [
        {
            "rule_id": "rule_expand",
            "level": "operational",
            "name": "Expand Query",
            "predicate": "always",
            "action": "expand_query",
            "params": {"queries": ["related query 1", "related query 2"]},
        },
    ]

    hints = await service.pre_retrieval_rules(fact_snapshot, rules)

    assert "expanded_queries" in hints
    assert len(hints["expanded_queries"]) == 2


@pytest.mark.asyncio
async def test_post_retrieval_rules(db_session: AsyncSession):
    """Test post-retrieval rules."""
    service = RuleService(db_session)

    fact_snapshot = {
        "fact_id": "fact_test",
        "query": "test query",
        "task_type": "question",
    }

    evidence_pack = {
        "evidence_items": [
            {"similarity_score": 0.8, "evidence_role": "base"},
            {"similarity_score": 0.3, "evidence_role": "example"},
            {"similarity_score": 0.9, "evidence_role": "base"},
        ],
    }

    rules = [
        {
            "rule_id": "rule_filter",
            "level": "operational",
            "name": "Filter Low Similarity",
            "predicate": "always",
            "action": "filter_evidence",
            "params": {"min_similarity": 0.5},
        },
    ]

    result = await service.post_retrieval_rules(fact_snapshot, evidence_pack, rules)

    assert "filtered_items" in result
    assert len(result["filtered_items"]) == 2  # Only items with similarity >= 0.5


@pytest.mark.asyncio
async def test_evaluate_predicate(db_session: AsyncSession):
    """Test predicate evaluation."""
    service = RuleService(db_session)

    # Test 'always' predicate
    assert service._evaluate_predicate("always", {}, {}) is True

    # Test 'never' predicate
    assert service._evaluate_predicate("never", {}, {}) is False

    # Test 'high_risk_task' predicate
    assert service._evaluate_predicate("high_risk_task", {}, {"task_type": "troubleshooting"}) is True
    assert service._evaluate_predicate("high_risk_task", {}, {"task_type": "question"}) is False

    # Test 'query_contains' predicate
    assert service._evaluate_predicate(
        "query_contains",
        {"keywords": ["python", "java"]},
        {"query": "What is Python?"}
    ) is True

    assert service._evaluate_predicate(
        "query_contains",
        {"keywords": ["python", "java"]},
        {"query": "What is Go?"}
    ) is False
