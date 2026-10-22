"""Question Selector —— 取题（DESIGN v2 §19 / §20）.

第一阶段策略（可替换，API 不变）：
1. 基础过滤：status=active + 知识点/题型/难度
2. 排除近期做过（默认 7 天，防重复刷）
3. 错题优先（最近一次答错的题排前）
4. 难度按目标分布随机补足

未来可扩展（不改变接口）：排除近期做过的时间窗动态化、掌握度匹配、
DAG 学习位置、难度动态调整。

学习端取题永远不返回 reference_answer / explanation / evidence / metadata
（DESIGN v2 §20）。
"""
from __future__ import annotations

import random
from typing import Any

from questionbank.services.question.question_service import QuestionService

SELECTABLE_FIELDS = (
    "id", "question_type", "difficulty", "cognitive_level", "stem", "options",
)


class QuestionSelector:
    def __init__(self, service: QuestionService, rng: random.Random | None = None):
        self.service = service
        self.rng = rng or random.Random()

    def select(
        self,
        user_id: str,
        *,
        category_id: int | None = None,
        count: int = 5,
        question_type: str | None = None,
        difficulty: int | None = None,
        exclude_recent_days: int = 7,
        wrong_first: bool = True,
        frontier_first: bool = False,
        frontier_category_ids: list[int] | None = None,
        conn=None,
    ) -> dict[str, Any]:
        """为用户取题：{items: [...], strategy: {...}}，题目剥离答案字段.

        frontier_first（T4.2 学习前沿）：调用方先查 KnowledgeCore
        `GET /api/v1/knowledge/graph/{domain_id}/frontier?user_id=` 拿到"先修全掌握
        而自身未掌握"的知识点 id 列表，作为 frontier_category_ids 传入；这些知识点
        关联的题目在新题池（排除错题后）中优先排列，让用户优先练"刚好够得着"的下一步。
        """
        if count < 1 or count > 50:
            raise ValueError("count 必须为 1~50")

        result = self.service.search(
            category_id=category_id,
            question_type=question_type,
            difficulty=difficulty,
            status="active",
            size=200,
            conn=conn,
        )
        pool = list(result["items"])
        strategy: dict[str, Any] = {"pool_size": len(pool)}

        # 1. 排除近期做过
        if exclude_recent_days > 0 and user_id:
            recent = self.service.store.recent_attempt_question_ids(
                user_id, exclude_recent_days, conn=conn
            )
            recent_set = set(recent)
            if recent_set:
                pool = [q for q in pool if q["id"] not in recent_set]
                strategy["excluded_recent"] = len(recent_set)

        # 2. 错题优先
        wrong_ids: set[int] = set()
        if wrong_first and user_id:
            wrong_ids = set(self.service.store.wrong_question_ids(user_id, conn=conn))
            if wrong_ids:
                strategy["wrong_available"] = len(wrong_ids & {q["id"] for q in pool})

        # 3. 组卷：错题排前（最多一半），其余随机（frontier_first 时新题内再把
        #    frontier 知识点的题目优先于其余新题，不影响错题优先级）
        selected: list[dict[str, Any]] = []
        wrong_pool = [q for q in pool if q["id"] in wrong_ids]
        fresh_pool = [q for q in pool if q["id"] not in wrong_ids]
        wrong_slots = min(len(wrong_pool), max(1, count // 2))
        if wrong_pool:
            self.rng.shuffle(wrong_pool)
            selected.extend(wrong_pool[:wrong_slots])

        if frontier_first and frontier_category_ids:
            frontier_ids = self.service.store.question_ids_by_category(
                frontier_category_ids, conn=conn
            )
            frontier_fresh = [q for q in fresh_pool if q["id"] in frontier_ids]
            other_fresh = [q for q in fresh_pool if q["id"] not in frontier_ids]
            self.rng.shuffle(frontier_fresh)
            self.rng.shuffle(other_fresh)
            fresh_pool = frontier_fresh + other_fresh
            strategy["frontier_first"] = len(frontier_fresh)
        else:
            self.rng.shuffle(fresh_pool)
        selected.extend(fresh_pool[: count - len(selected)])

        items = [
            {k: q[k] for k in SELECTABLE_FIELDS if k in q} for q in selected[:count]
        ]
        strategy["selected_count"] = len(items)
        strategy["wrong_first"] = wrong_slots
        return {"items": items, "strategy": strategy}
