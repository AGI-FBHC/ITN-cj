from __future__ import annotations

import json
from datetime import datetime
from uuid import UUID, uuid4

from app.config import Settings
from app.storage.platform_db import platform_connect


ABILITY_DIMENSIONS = ("kp-ds", "kp-co", "kp-os", "kp-network", "kp-db", "kp-agent")

CHAPTER_ABILITY_WEIGHTS: dict[str, dict[str, float]] = {
    "ch1-intro": {"kp-agent": 0.6, "kp-ds": 0.4},
    "ch2-history": {"kp-ds": 0.6, "kp-agent": 0.4},
    "ch3-llm": {"kp-ds": 0.7, "kp-co": 0.3},
    "ch4-paradigms": {"kp-co": 0.6, "kp-os": 0.4},
    "ch5-lowcode": {"kp-os": 0.7, "kp-db": 0.3},
    "ch6-frameworks": {"kp-os": 0.6, "kp-db": 0.4},
    "ch7-helloagents": {"kp-os": 0.8, "kp-co": 0.2},
    "ch8-memory-rag": {"kp-ds": 0.5, "kp-network": 0.5},
    "ch9-context": {"kp-network": 0.6, "kp-ds": 0.4},
    "ch10-protocols": {"kp-network": 0.6, "kp-db": 0.4},
    "ch11-agentic-rl": {"kp-co": 0.5, "kp-db": 0.5},
    "ch12-evaluation": {"kp-db": 0.5, "kp-co": 0.5},
    "ch13-travel": {"kp-os": 0.5, "kp-db": 0.5},
    "ch14-research": {"kp-network": 0.5, "kp-ds": 0.5},
    "ch15-cyber": {"kp-os": 0.5, "kp-db": 0.5},
    "ch16-graduation": {"kp-db": 0.6, "kp-os": 0.4},
}

_KEYWORD_DIMENSIONS: list[tuple[tuple[str, ...], str]] = [
    (("推理", "逻辑", "判断", "分析"), "kp-co"),
    (("代码", "工程", "实现", "实践", "实操", "开发"), "kp-os"),
    (("网络", "协议", "排查", "诊断", "问题"), "kp-network"),
    (("设计", "架构", "方案", "建模"), "kp-db"),
    (("迁移", "应用", "结合", "举一反三"), "kp-agent"),
    (("理解", "概念", "知识", "记忆"), "kp-ds"),
]

_RESOURCE_REWARDS = {
    "lecture": (1.0, 0.5),
    "practice": (2.0, 1.0),
    "ppt": (1.5, 0.75),
    "quiz": (2.0, 1.0),
}


def _clamp(value: float) -> int:
    return max(12, min(96, round(value)))


def resolve_dimensions(kp_id: str | None, hint: str = "") -> tuple[str, str]:
    weights = CHAPTER_ABILITY_WEIGHTS.get(kp_id or "")
    if weights:
        ranked = sorted(weights.items(), key=lambda item: item[1], reverse=True)
        primary = ranked[0][0]
        secondary = next((dim for dim, _ in ranked[1:] if dim != primary), None)
        return primary, secondary or ("kp-co" if primary != "kp-co" else "kp-ds")
    searchable = f"{kp_id or ''} {hint}"
    primary = "kp-ds"
    for keywords, dim in _KEYWORD_DIMENSIONS:
        if any(keyword in searchable for keyword in keywords):
            primary = dim
            break
    secondary = "kp-co" if primary != "kp-co" else "kp-ds"
    return primary, secondary


class AbilityRewardStore:
    """异步六维能力加分：学习资源完成一次只奖励一次，直接写回 learners.scores_json。"""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._schema_ready = False

    def ensure_schema(self) -> None:
        if self._schema_ready:
            return
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS learning_resource_ability_rewards (
                      id BINARY(16) PRIMARY KEY,
                      user_id BINARY(16) NOT NULL,
                      learner_id BINARY(16) NOT NULL,
                      resource_id BINARY(16) NOT NULL,
                      resource_type VARCHAR(16) NOT NULL,
                      main_dimension VARCHAR(32) NOT NULL,
                      secondary_dimension VARCHAR(32) NOT NULL,
                      reward_points DECIMAL(4,2) NOT NULL,
                      created_at DATETIME(6) NOT NULL,
                      UNIQUE KEY uk_ability_reward_resource (user_id, resource_id)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
            connection.commit()
        self._schema_ready = True

    def apply(
        self, user_id: UUID, learner_id: UUID, resource_id: UUID,
        resource_type: str, kp_id: str | None = None,
        hint: str = "", correct_rate: float = 1.0,
    ) -> dict:
        self.ensure_schema()
        resource_type = str(resource_type or "lecture").lower()
        if resource_type not in _RESOURCE_REWARDS:
            return {"rewarded": False, "reason": "unsupported-type"}
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id FROM learning_resource_ability_rewards "
                    "WHERE user_id=%s AND resource_id=%s LIMIT 1",
                    (user_id.bytes, resource_id.bytes),
                )
                if cursor.fetchone() is not None:
                    return {"rewarded": False, "reason": "already-rewarded"}
                cursor.execute(
                    "SELECT scores_json FROM learners WHERE id=%s AND user_id=%s AND status=1 LIMIT 1",
                    (learner_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
        if row is None:
            return {"rewarded": False, "reason": "learner-not-found"}

        primary, secondary = resolve_dimensions(kp_id, hint)
        primary_points, secondary_points = _RESOURCE_REWARDS[resource_type]
        if resource_type == "quiz":
            rate = max(0.0, min(1.0, float(correct_rate if correct_rate is not None else 0.8)))
            primary_points = round(primary_points * rate, 2)
            secondary_points = round(secondary_points * rate, 2)

        raw_scores = row.get("scores_json")
        try:
            scores = json.loads(raw_scores) if isinstance(raw_scores, str) else dict(raw_scores or {})
        except (TypeError, ValueError, json.JSONDecodeError):
            scores = {}
        if not isinstance(scores, dict):
            scores = {}

        deltas: dict[str, dict[str, float]] = {}
        for dim, points in ((primary, primary_points), (secondary, secondary_points)):
            if points <= 0:
                continue
            before = float(scores.get(dim) or 50)
            after = _clamp(before + points)
            scores[dim] = after
            deltas[dim] = {"from": before, "to": after}

        now = datetime.utcnow()
        reward_id = uuid4()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE learners SET scores_json=%s, updated_at=%s WHERE id=%s AND user_id=%s AND status=1",
                    (json.dumps(scores, ensure_ascii=False), now, learner_id.bytes, user_id.bytes),
                )
                updated = cursor.rowcount > 0
                if updated:
                    cursor.execute(
                        "INSERT INTO learning_resource_ability_rewards "
                        "(id,user_id,learner_id,resource_id,resource_type,main_dimension,secondary_dimension,reward_points,created_at) "
                        "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (reward_id.bytes, user_id.bytes, learner_id.bytes, resource_id.bytes,
                         resource_type, primary, secondary,
                         round(primary_points + secondary_points, 2), now),
                    )
            connection.commit()
        if not updated:
            return {"rewarded": False, "reason": "update-failed"}
        return {
            "rewarded": True,
            "primaryDimension": primary,
            "secondaryDimension": secondary,
            "deltas": deltas,
            "scores": scores,
        }
