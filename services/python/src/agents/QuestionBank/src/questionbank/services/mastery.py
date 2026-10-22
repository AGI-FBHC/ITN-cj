"""掌握度估计（T4.1，817 行动方案 · 数据飞轮第一步）.

mastery(user_id, category_id)
    = 半衰期 14 天指数衰减加权正确率 × 置信折扣 min(1, n/5)

其中 n 为该用户在该知识点下的有效作答次数（is_correct 非 NULL，主观题
judge_mode=none 未判分的记录不计入）；折扣项保证样本太少时掌握度趋于保守（0）。

写入 `user_knowledge_state` 表（T4.1 新迁移），供：
- `GET /v1/practice/mastery` 展示；
- KnowledgeCore `GET /api/v1/knowledge/graph/{domain_id}/frontier`（T4.2）判定"已掌握"；
- `qb graph-vote`（T4.3）按掌握度分组读取。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

# 半衰期（天）：14 天前的一次作答权重衰减为 0.5。
HALF_LIFE_DAYS = 14.0
# 置信折扣分母：达到 5 次有效作答后折扣封顶为 1（即不再打折）。
CONFIDENCE_FLOOR_ATTEMPTS = 5
MASTERED_THRESHOLD = 0.7  # 与 T4.2 frontier / 前端展示口径保持一致


def _decay_weight(days_ago: float) -> float:
    """指数衰减权重：0.5 ** (days_ago / HALF_LIFE_DAYS)."""
    return 0.5 ** (max(0.0, days_ago) / HALF_LIFE_DAYS)


def _as_aware_datetime(value: Any, *, default_tz=timezone.utc) -> datetime:
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        dt = datetime.fromisoformat(value)
    else:
        raise TypeError(f"submitted_at 类型不支持: {type(value)!r}")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=default_tz)
    return dt


def compute_from_attempts(
    attempts: list[dict[str, Any]],
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """纯函数：给定作答记录列表算 mastery（不碰数据库，便于单测）.

    attempts: [{"is_correct": 0/1/True/False/None, "submitted_at": datetime|str|None}, ...]
    - is_correct 为 None（未判分）的记录不计入证据；
    - submitted_at 为空的记录按权重 0 处理（等效不计入分子分母，但仍计入 evidence_count，
      因为它确实是一次已完成判分的作答，只是时间缺失导致无法参与时间加权——保守处理）。

    返回 {"mastery": float(0~1，3 位小数), "evidence_count": int}.
    """
    now = now or datetime.now(timezone.utc)
    scored = [a for a in attempts if a.get("is_correct") is not None]
    n = len(scored)
    if n == 0:
        return {"mastery": 0.0, "evidence_count": 0}

    weighted_correct = 0.0
    weighted_total = 0.0
    for a in scored:
        submitted_at = a.get("submitted_at")
        weight = 1.0
        if submitted_at is not None:
            days_ago = (now - _as_aware_datetime(submitted_at)).total_seconds() / 86400.0
            weight = _decay_weight(days_ago)
        weighted_total += weight
        if a["is_correct"]:
            weighted_correct += weight

    weighted_accuracy = weighted_correct / weighted_total if weighted_total > 0 else 0.0
    confidence_discount = min(1.0, n / CONFIDENCE_FLOOR_ATTEMPTS)
    mastery = weighted_accuracy * confidence_discount
    # 数值保护：浮点误差可能略微越界
    mastery = max(0.0, min(1.0, mastery))
    return {"mastery": round(mastery, 3), "evidence_count": n}


class MasteryService:
    """读作答记录、算 mastery、写/读 `user_knowledge_state`（T4.1）."""

    def __init__(self, store: Any):
        self.store = store  # QuestionStore（避免循环 import，不做类型强绑定）

    def compute(self, user_id: str, category_id: int, *, conn=None) -> dict[str, Any]:
        """只算不落库（供预览/单测复用真实数据源）."""
        attempts = self.store.list_attempts_for_mastery(user_id, category_id, conn=conn)
        result = compute_from_attempts(list(attempts))
        return {"user_id": user_id, "category_id": category_id, **result}

    def update_state(self, user_id: str, category_id: int, *, conn=None) -> dict[str, Any]:
        """算并 upsert 落库：作答提交后增量更新对应知识点（DESIGN §21 触发点）."""
        result = self.compute(user_id, category_id, conn=conn)
        self.store.upsert_knowledge_state(
            user_id, category_id, result["mastery"], result["evidence_count"], conn=conn
        )
        return result

    def get_states(self, user_id: str, *, conn=None) -> list[dict[str, Any]]:
        """用户全部知识点的掌握度快照（`GET /v1/practice/mastery` 用）."""
        rows = self.store.list_knowledge_state(user_id, conn=conn)
        items = []
        for r in rows:
            mastery = float(r["mastery"])
            items.append(
                {
                    "category_id": int(r["category_id"]),
                    "mastery": mastery,
                    "evidence_count": int(r["evidence_count"]),
                    "mastered": mastery >= MASTERED_THRESHOLD,
                    "updated_at": r["updated_at"],
                }
            )
        return items
