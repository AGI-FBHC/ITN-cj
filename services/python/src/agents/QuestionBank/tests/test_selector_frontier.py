"""QuestionSelector frontier_first 参数测试（T4.2 学习前沿配合选题）.

集成测试（直连测试 MySQL，事务回滚零污染；未配置 TEST_MYSQL_* 时自动 skip，
与项目其余选题器测试同一约定，见 tests/test_attempt_selector_revalidation.py）。
"""
from __future__ import annotations

import random

import pytest

from questionbank.services.question import QuestionSelector, QuestionService
from questionbank.store import QuestionStore

from conftest import make_single_choice, unique_stem


@pytest.fixture
def svc(rollback):
    from questionbank.config import get_settings

    return QuestionService(QuestionStore(get_settings())), rollback


def _active_question(svc, conn, category_id: int, **overrides) -> dict:
    q = svc.create(
        make_single_choice(
            knowledge_points=[{"category_id": category_id, "role": "primary"}],
            **overrides,
        ),
        conn=conn,
    )
    svc.set_status(q["id"], "active", conn=conn)
    return svc.get(q["id"], conn=conn)


def test_frontier_first_prioritizes_frontier_category_questions(svc):
    svc, conn = svc
    frontier_cat, other_cat = 9101, 9102
    frontier_q = _active_question(svc, conn, frontier_cat, stem=unique_stem("前沿题"))
    other_qs = [
        _active_question(svc, conn, other_cat, stem=unique_stem(f"非前沿题{i}"))
        for i in range(4)
    ]

    selector = QuestionSelector(svc, rng=random.Random(1))
    result = selector.select(
        "user-frontier",
        count=5,
        exclude_recent_days=0,
        frontier_first=True,
        frontier_category_ids=[frontier_cat],
        conn=conn,
    )
    ids = [q["id"] for q in result["items"]]
    assert frontier_q["id"] in ids
    assert ids[0] == frontier_q["id"]  # frontier 题目排在新题最前
    assert result["strategy"]["frontier_first"] == 1
    assert all(q["id"] in ids for q in [frontier_q] + other_qs) or len(ids) == 5


def test_frontier_first_false_by_default_no_reorder_marker(svc):
    svc, conn = svc
    cat = 9103
    _active_question(svc, conn, cat, stem=unique_stem("默认题"))
    selector = QuestionSelector(svc, rng=random.Random(2))
    result = selector.select("user-default", count=5, exclude_recent_days=0, conn=conn)
    assert "frontier_first" not in result["strategy"]


def test_frontier_first_without_category_ids_is_noop(svc):
    """frontier_first=True 但未提供 frontier_category_ids → 退化为普通随机（不报错）."""
    svc, conn = svc
    cat = 9104
    q = _active_question(svc, conn, cat, stem=unique_stem("无前沿列表题"))
    selector = QuestionSelector(svc, rng=random.Random(3))
    result = selector.select(
        "user-noop", count=5, exclude_recent_days=0, frontier_first=True, conn=conn
    )
    ids = [item["id"] for item in result["items"]]
    assert q["id"] in ids
    assert "frontier_first" not in result["strategy"]


# ── 纯逻辑单测（假 service/store，不连库，保证不依赖 TEST_MYSQL_* 也能验证行为） ──


class _FakeStore:
    def __init__(self, frontier_ids: set[int]):
        self._frontier_ids = frontier_ids

    def recent_attempt_question_ids(self, user_id, days, conn=None):
        return []

    def wrong_question_ids(self, user_id, conn=None):
        return []

    def question_ids_by_category(self, category_ids, conn=None):
        return self._frontier_ids if category_ids else set()


class _FakeService:
    def __init__(self, items: list[dict], frontier_ids: set[int]):
        self._items = items
        self.store = _FakeStore(frontier_ids)

    def search(self, **kwargs):
        return {"items": list(self._items), "total": len(self._items)}


def test_frontier_first_reorders_fresh_pool_without_db():
    items = [{"id": i, "question_type": "single_choice", "difficulty": 3,
              "cognitive_level": "remember", "stem": f"q{i}", "options": None} for i in range(1, 6)]
    # 题目 3、5 属于 frontier 知识点
    service = _FakeService(items, frontier_ids={3, 5})
    selector = QuestionSelector(service, rng=random.Random(0))
    result = selector.select(
        "u1", count=5, exclude_recent_days=0, frontier_first=True,
        frontier_category_ids=[999],
    )
    ids = [q["id"] for q in result["items"]]
    assert set(ids[:2]) == {3, 5}  # frontier 题目排在最前两位
    assert result["strategy"]["frontier_first"] == 2


def test_frontier_first_no_matching_questions_falls_back_gracefully():
    items = [{"id": i, "question_type": "single_choice", "difficulty": 3,
              "cognitive_level": "remember", "stem": f"q{i}", "options": None} for i in range(1, 4)]
    service = _FakeService(items, frontier_ids=set())
    selector = QuestionSelector(service, rng=random.Random(0))
    result = selector.select(
        "u1", count=3, exclude_recent_days=0, frontier_first=True,
        frontier_category_ids=[999],
    )
    assert result["strategy"]["frontier_first"] == 0
    assert len(result["items"]) == 3
