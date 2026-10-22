"""qb graph-vote 检验逻辑单测（T4.3 作答数据投票）.

用构造数据验证纯函数 `_two_proportion_ztest` / `_vote_for_edge`，不连库
（DB 读写走 store.list_prerequisite_edges / attempt_correctness_grouped_by_prereq_mastery /
patch_prerequisite_edge_vote，已在 store.py 单独实现，此处只测检验/决策逻辑）。
"""
from __future__ import annotations

import pytest

from questionbank.cli import _norm_cdf, _two_proportion_ztest, _vote_for_edge

EDGE = {"id": 1, "category_id": 200, "prereq_category_id": 100, "confidence": 0.6}


def test_norm_cdf_known_values():
    assert _norm_cdf(0.0) == pytest.approx(0.5, abs=1e-6)
    assert _norm_cdf(1.96) == pytest.approx(0.975, abs=1e-3)


def test_sample_too_small_is_not_conclusive():
    """n_each < min_n（默认 30）→ 不出结论，即使比例差异很大."""
    high = [1] * 10  # n=10 < 30
    low = [0] * 10
    result = _vote_for_edge(EDGE, high, low, min_n=30)
    assert result["conclusive"] is False
    assert "样本不足" in result["reason"]
    assert result["n_high"] == 10 and result["n_low"] == 10


def test_significant_positive_diff_boosts_confidence_and_no_review():
    """掌握 A 组（高组）显著优于低组 → 正向支持先修关系，confidence 上调，不标 needs_review."""
    high = [1] * 27 + [0] * 3   # n=30, 27 correct -> p=0.9
    low = [1] * 10 + [0] * 20   # n=30, 10 correct -> p=0.333
    result = _vote_for_edge(EDGE, high, low, min_n=30, alpha=0.05)
    assert result["conclusive"] is True
    assert result["significant"] is True
    assert result["diff"] > 0
    assert result["significant_positive"] is True
    assert result["significant_negative"] is False
    assert result["needs_review"] is False
    assert result["new_confidence"] > EDGE["confidence"]
    assert result["new_confidence"] <= 1.0


def test_significant_negative_diff_flags_needs_review_and_lowers_confidence():
    """掌握 A 组反而更差（显著为负）→ 先修关系存疑，needs_review=True，confidence 下调."""
    high = [1] * 10 + [0] * 20   # n=30, p=0.333（掌握 A 的人反而答错更多）
    low = [1] * 27 + [0] * 3     # n=30, p=0.9
    result = _vote_for_edge(EDGE, high, low, min_n=30, alpha=0.05)
    assert result["conclusive"] is True
    assert result["significant"] is True
    assert result["diff"] < 0
    assert result["significant_negative"] is True
    assert result["needs_review"] is True
    assert result["new_confidence"] < EDGE["confidence"]
    assert result["new_confidence"] >= 0.1


def test_not_significant_diff_keeps_confidence_unchanged():
    """两组正确率接近（不显著）→ 不出显著结论，confidence 维持原值，不标 needs_review."""
    high = [1] * 15 + [0] * 15   # n=30, p=0.5
    low = [1] * 16 + [0] * 14    # n=30, p=0.533
    result = _vote_for_edge(EDGE, high, low, min_n=30, alpha=0.05)
    assert result["conclusive"] is True
    assert result["significant"] is False
    assert result["needs_review"] is False
    assert result["new_confidence"] == pytest.approx(EDGE["confidence"])


def test_all_same_outcome_both_groups_does_not_crash():
    """两组全对/全对（pooled p=1）→ 方差为 0，退化为不显著而非抛异常."""
    high = [1] * 30
    low = [1] * 30
    result = _vote_for_edge(EDGE, high, low, min_n=30)
    assert result["conclusive"] is True
    assert result["p_value"] == 1.0
    assert result["significant"] is False


def test_two_proportion_ztest_matches_manual_expectation():
    """直接校验统计量：27/30 vs 10/30，z 应较大且 p_value 很小."""
    stat = _two_proportion_ztest(27, 30, 10, 30)
    assert stat["diff"] == pytest.approx(27 / 30 - 10 / 30, abs=1e-6)
    assert stat["z"] > 3.0
    assert stat["p_value"] < 0.01
