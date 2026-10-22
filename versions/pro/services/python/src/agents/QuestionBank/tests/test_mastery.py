"""MasteryService / compute_from_attempts 单测（T4.1 掌握度估计）.

纯函数测试（不连库）覆盖手册验收场景：全对→高分、全错→低分、次数少→折扣生效；
另附一个可选的落库集成测试（依赖 TEST_MYSQL_*，未配置时按项目约定自动 skip）。
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from questionbank.services.mastery import (
    CONFIDENCE_FLOOR_ATTEMPTS,
    MasteryService,
    compute_from_attempts,
)


def _attempt(is_correct, days_ago: float = 0.0, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    return {
        "is_correct": is_correct,
        "submitted_at": now - timedelta(days=days_ago),
    }


NOW = datetime(2026, 8, 18, tzinfo=timezone.utc)


def test_all_correct_gives_high_mastery():
    """全对（且样本量达到折扣封顶 5 次）→ mastery 接近 1."""
    attempts = [_attempt(1, days_ago=d, now=NOW) for d in (0, 1, 2, 3, 4)]
    result = compute_from_attempts(attempts, now=NOW)
    assert result["evidence_count"] == 5
    assert result["mastery"] == pytest.approx(1.0, abs=1e-3)


def test_all_wrong_gives_low_mastery():
    """全错 → mastery 为 0（不管样本量多少）."""
    attempts = [_attempt(0, days_ago=d, now=NOW) for d in (0, 1, 2, 3, 4)]
    result = compute_from_attempts(attempts, now=NOW)
    assert result["evidence_count"] == 5
    assert result["mastery"] == pytest.approx(0.0, abs=1e-3)


def test_few_attempts_applies_confidence_discount():
    """次数少（n < CONFIDENCE_FLOOR_ATTEMPTS）→ 即使全对也被打折，低于样本充足时的分数."""
    few = compute_from_attempts([_attempt(1, days_ago=0, now=NOW)], now=NOW)
    plenty = compute_from_attempts(
        [_attempt(1, days_ago=d, now=NOW) for d in range(CONFIDENCE_FLOOR_ATTEMPTS)], now=NOW
    )
    assert few["evidence_count"] == 1
    assert plenty["evidence_count"] == CONFIDENCE_FLOOR_ATTEMPTS
    assert few["mastery"] < plenty["mastery"]
    # 1 次正确 × 折扣 1/5 = 0.2
    assert few["mastery"] == pytest.approx(0.2, abs=1e-3)


def test_no_scored_attempts_returns_zero():
    """全部是未判分（is_correct=None）的主观题记录 → 无有效证据，mastery=0."""
    attempts = [{"is_correct": None, "submitted_at": NOW}]
    result = compute_from_attempts(attempts, now=NOW)
    assert result == {"mastery": 0.0, "evidence_count": 0}


def test_recent_correct_outweighs_old_wrong():
    """半衰期加权：近期答对 + 远期答错，加权正确率应偏向近期（体现遗忘曲线）."""
    attempts = [
        _attempt(0, days_ago=60, now=NOW),  # 远期答错，权重很小
        _attempt(1, days_ago=0, now=NOW),   # 近期答对，权重接近 1
        _attempt(1, days_ago=1, now=NOW),
        _attempt(1, days_ago=2, now=NOW),
        _attempt(1, days_ago=3, now=NOW),
    ]
    result = compute_from_attempts(attempts, now=NOW)
    # 5 次达到折扣封顶，且加权正确率应明显高于简单平均 4/5=0.8（远期错题权重被衰减稀释）
    assert result["evidence_count"] == 5
    assert result["mastery"] > 0.8


def test_half_life_weight_matches_expected_decay():
    """半衰期 14 天：14 天前的单次记录权重应约为 0.5（间接验证衰减公式）."""
    from questionbank.services.mastery import _decay_weight

    assert _decay_weight(14.0) == pytest.approx(0.5, abs=1e-6)
    assert _decay_weight(0.0) == pytest.approx(1.0, abs=1e-6)
    assert _decay_weight(28.0) == pytest.approx(0.25, abs=1e-6)


# ── MasteryService（依赖 store 注入，用假 store 验证 compute/update_state 编排） ──


class _FakeStore:
    def __init__(self, attempts: list[dict]):
        self._attempts = attempts
        self.upserted: list[tuple] = []

    def list_attempts_for_mastery(self, user_id, category_id, conn=None):
        return self._attempts

    def upsert_knowledge_state(self, user_id, category_id, mastery, evidence_count, conn=None):
        self.upserted.append((user_id, category_id, mastery, evidence_count))

    def list_knowledge_state(self, user_id, conn=None):
        return [
            {
                "category_id": cid,
                "mastery": mastery,
                "evidence_count": n,
                "updated_at": "2026-08-18T00:00:00",
            }
            for (_, cid, mastery, n) in self.upserted
        ]


def test_mastery_service_update_state_persists_computed_value():
    store = _FakeStore([_attempt(1, days_ago=d, now=NOW) for d in range(5)])
    service = MasteryService(store)
    result = service.update_state("user-1", 71)
    assert result["mastery"] == pytest.approx(compute_from_attempts(store._attempts)["mastery"])
    assert store.upserted == [("user-1", 71, result["mastery"], result["evidence_count"])]


def test_mastery_service_get_states_marks_mastered_threshold():
    store = _FakeStore([])
    store.upserted = [("user-1", 71, 0.9, 5), ("user-1", 72, 0.5, 5)]
    service = MasteryService(store)
    states = service.get_states("user-1")
    by_cat = {s["category_id"]: s for s in states}
    assert by_cat[71]["mastered"] is True
    assert by_cat[72]["mastered"] is False


# ── 可选集成测试：真连测试库时验证提交作答后 state 落库 ──────────────────────


def test_submit_updates_user_knowledge_state(rollback):
    """提交作答后 user_knowledge_state 增量更新（需要 TEST_MYSQL_* 且已跑过本迁移，
    未配置 TEST_MYSQL_* 时由 conftest 的 rollback fixture 自动 skip）."""
    from questionbank.config import get_settings
    from questionbank.services.question import AttemptService, QuestionService
    from questionbank.store import QuestionStore

    from conftest import make_single_choice

    conn = rollback
    store = QuestionStore(get_settings())
    svc = QuestionService(store)
    q = svc.create(
        make_single_choice(knowledge_points=[{"category_id": 71, "role": "primary"}]),
        conn=conn,
    )
    svc.set_status(q["id"], "active", conn=conn)
    q = svc.get(q["id"], conn=conn)

    attempt = AttemptService(store, svc, llm=None, knowledge_core=None)
    asyncio.run(attempt.submit("mastery-test-user", q["id"], "B", conn=conn))

    service = MasteryService(store)
    result = service.compute("mastery-test-user", 71, conn=conn)
    assert result["evidence_count"] >= 1
