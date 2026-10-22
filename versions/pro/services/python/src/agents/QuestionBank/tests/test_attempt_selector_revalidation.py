"""AttemptService / QuestionSelector / RevalidationService 集成测试
（直连生产 MySQL，事务回滚零污染；LLM/KC 用 fake 或降级）."""
import asyncio
import random

import pytest

from questionbank.services.question import (
    AttemptService,
    QuestionCreate,
    QuestionSelector,
    QuestionService,
    RevalidationService,
)
from questionbank.store import QuestionStore

from conftest import make_single_choice, unique_stem


@pytest.fixture
def svc(rollback):
    from questionbank.config import get_settings

    return QuestionService(QuestionStore(get_settings())), rollback


def _active_question(svc, conn, **overrides) -> dict:
    q = svc.create(
        make_single_choice(
            knowledge_points=[{"category_id": 71, "role": "primary"}],
            **overrides,
        ),
        conn=conn,
    )
    svc.set_status(q["id"], "active", conn=conn)
    return svc.get(q["id"], conn=conn)


# ── AttemptService（客观题规则判分落库） ───────────────────────────────────


def test_submit_objective_correct_and_wrong(svc):
    svc, conn = svc
    q = _active_question(svc, conn)
    attempt = AttemptService(svc.store, svc, llm=None, knowledge_core=None)

    ok = asyncio.run(attempt.submit("user-a", q["id"], "B", conn=conn))
    assert ok["is_correct"] is True
    assert ok["score"] == 1.0
    assert ok["judge_mode"] == "rule"

    bad = asyncio.run(attempt.submit("user-a", q["id"], "C", conn=conn))
    assert bad["is_correct"] is False
    assert bad["score"] == 0.0

    # 落库验证
    rows = svc.store.list_attempts("user-a", question_id=q["id"], conn=conn)
    assert rows["total"] == 2
    assert rows["items"][0]["is_correct"] == 0  # 最近一条（错误）在前


def test_submit_rejects_inactive(svc):
    svc, conn = svc
    q = svc.create(make_single_choice(), conn=conn)  # proposed 未激活
    attempt = AttemptService(svc.store, svc, llm=None, knowledge_core=None)
    with pytest.raises(Exception) as ei:
        asyncio.run(attempt.submit("user-a", q["id"], "B", conn=conn))
    assert "未启用" in str(ei.value)


def test_submit_short_answer_none_mode_records_only(svc):
    svc, conn = svc
    q = _active_question(
        svc, conn,
        question_type="short_answer", options=None, reference_answer="标准化协议",
    )
    attempt = AttemptService(svc.store, svc, llm=None, knowledge_core=None)
    result = asyncio.run(
        attempt.submit("user-a", q["id"], "MCP 是标准化协议", judge_mode="none", conn=conn)
    )
    assert result["is_correct"] is None
    assert result["score"] is None
    assert result["judge_mode"] == "none"
    rows = svc.store.list_attempts("user-a", conn=conn)
    assert rows["total"] == 1


# ── QuestionSelector ───────────────────────────────────────────────────────


def test_selector_returns_active_only_and_strips_answers(svc):
    svc, conn = svc
    q1 = _active_question(svc, conn)
    q2 = svc.create(make_single_choice(stem=unique_stem()), conn=conn)  # proposed，不可取
    selector = QuestionSelector(svc, rng=random.Random(42))
    result = selector.select("user-s", category_id=71, count=5, conn=conn)
    ids = [q["id"] for q in result["items"]]
    assert q1["id"] in ids
    assert q2["id"] not in ids
    # 剥离答案字段
    for item in result["items"]:
        assert "reference_answer" not in item
        assert "explanation" not in item
        assert "evidence_refs" not in item
        assert "metadata" not in item


def test_selector_excludes_recent_and_prefers_wrong(svc):
    svc, conn = svc
    q1 = _active_question(svc, conn)
    q2 = _active_question(svc, conn, stem=unique_stem("第二题"))
    q3 = _active_question(svc, conn, stem=unique_stem("第三题"))
    attempt = AttemptService(svc.store, svc, llm=None, knowledge_core=None)

    # user-x 做过 q1（答错）；user-y 做过 q2
    asyncio.run(attempt.submit("user-x", q1["id"], "C", conn=conn))  # 错
    asyncio.run(attempt.submit("user-y", q2["id"], "B", conn=conn))  # 对

    selector = QuestionSelector(svc, rng=random.Random(7))
    result = selector.select("user-x", category_id=71, count=5, conn=conn)
    ids = [q["id"] for q in result["items"]]
    assert q1["id"] not in ids  # 近期做过被排除
    assert q2["id"] in ids and q3["id"] in ids

    # 无排除策略（exclude_recent_days=0）→ q1 可选且错题优先排最前
    result2 = selector.select("user-x", category_id=71, count=5, exclude_recent_days=0, conn=conn)
    ids2 = [q["id"] for q in result2["items"]]
    assert ids2[0] == q1["id"]  # 错题优先
    assert result2["strategy"]["wrong_first"] >= 1


# ── RevalidationService ────────────────────────────────────────────────────


def test_mark_by_chunk_and_list_queue(svc):
    svc, conn = svc
    q = svc.create(
        make_single_choice(evidence_refs=[{"chunk_id": 1303, "document_id": 38}]),
        conn=conn,
    )
    reval = RevalidationService(svc.store, svc)
    result = reval.mark_by_chunk_ids([1303], reason="doc_updated", conn=conn)
    # 全库可能还有其他引用 1303 的真实题目，只断言本测试创建的题被标记
    assert q["id"] in result["question_ids"]
    record = svc.get(q["id"], conn=conn)
    assert record["metadata"]["needs_revalidation"]["reason"] == "doc_updated"

    queue = reval.list_queue(only_active=False, conn=conn)
    assert any(item["id"] == q["id"] for item in queue["items"])


def test_mark_no_match(svc):
    svc, conn = svc
    reval = RevalidationService(svc.store, svc)
    result = reval.mark_by_chunk_ids([99999], conn=conn)
    assert result["count"] == 0


async def _fake_reviewer_passed(record, context):
    from questionbank.services.question.reviewer import ReviewVerdict

    return ReviewVerdict(
        grounded=True, answer_correct=True, unambiguous=True, difficulty_match=True,
        confidence=0.9, issues=[],
    )


class FakeReviewerPassed:
    async def review(self, record, context):
        from questionbank.services.question.reviewer import ReviewVerdict

        return ReviewVerdict(
            grounded=True, answer_correct=True, unambiguous=True,
            difficulty_match=True, confidence=0.9, issues=[],
        )


def test_revalidate_passed_clears_flag_and_activates(svc):
    svc, conn = svc
    q = _active_question(svc, conn, evidence_refs=[{"chunk_id": 1303, "document_id": 38}])
    reval = RevalidationService(svc.store, svc)
    reval.mark_by_chunk_ids([1303], conn=conn)

    result = asyncio.run(reval.revalidate(q["id"], FakeReviewerPassed(), None, conn=conn))

    assert result["passed"] is True
    assert result["status"] == "active"
    record = svc.get(q["id"], conn=conn)
    assert "needs_revalidation" not in (record["metadata"] or {})
