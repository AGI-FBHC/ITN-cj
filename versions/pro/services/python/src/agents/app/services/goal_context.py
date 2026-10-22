from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from app.config import Settings
from app.storage.platform_db import platform_connect


LEVEL_SCORE = {
    "BEGINNER": 0.18,
    "ELEMENTARY": 0.32,
    "INTERMEDIATE": 0.5,
    "PROFICIENT": 0.68,
    "ADVANCED": 0.82,
    "EXPERT": 0.92,
}


@dataclass(frozen=True)
class GoalContextService:
    """Build a generation context without mutating colleague-owned knowledge tables."""

    settings: Settings

    @staticmethod
    def _uuid(value: bytes | None) -> str | None:
        return str(UUID(bytes=value)) if value else None

    def build(self, user_id: UUID, goal_id: UUID | None = None) -> dict[str, Any]:
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT education_level,major,technical_foundation,learning_preference,current_goal_id "
                    "FROM user_profiles WHERE user_id=%s",
                    (user_id.bytes,),
                )
                profile = cursor.fetchone() or {}
                selected_goal = goal_id.bytes if goal_id else profile.get("current_goal_id")
                goal = None
                if selected_goal:
                    cursor.execute(
                        "SELECT id,goal_type,title,description,expected_level,initial_level,assessment_method," 
                        "target_date,status FROM learning_goals WHERE id=%s AND user_id=%s",
                        (selected_goal, user_id.bytes),
                    )
                    goal = cursor.fetchone()

                cursor.execute(
                    "SELECT km.knowledge_category_id,c.name,c.full_path,km.mastery_score,km.attempt_count "
                    "FROM knowledge_mastery km JOIN knowledge_category c ON c.id=km.knowledge_category_id "
                    "WHERE km.user_id=%s ORDER BY km.mastery_score ASC,km.attempt_count DESC LIMIT 30",
                    (user_id.bytes,),
                )
                mastery_rows = cursor.fetchall() or []

                # Read-only coverage inventory. A category is usable when it has at least one relation.
                cursor.execute(
                    "SELECT c.id,c.name,c.full_path,c.level,COUNT(kcc.id) chunk_count "
                    "FROM knowledge_category c "
                    "JOIN knowledge_domain d ON d.id=c.domain_id "
                    "LEFT JOIN knowledge_chunk_category kcc ON kcc.category_id=c.id "
                    "WHERE d.code='agent' AND c.status=1 "
                    "GROUP BY c.id,c.name,c.full_path,c.level "
                    "ORDER BY c.level DESC,c.sort_order,c.id"
                )
                coverage_rows = cursor.fetchall() or []

        goal_data = self._goal(goal)
        profile_data = {
            "educationLevel": profile.get("education_level"),
            "major": profile.get("major"),
            "technicalFoundation": profile.get("technical_foundation"),
            "learningPreference": profile.get("learning_preference"),
        }
        mastery = [
            {
                "categoryId": int(row["knowledge_category_id"]),
                "name": row["name"],
                "path": row.get("full_path") or "",
                "score": float(row.get("mastery_score") or 0),
                "attempts": int(row.get("attempt_count") or 0),
            }
            for row in mastery_rows
        ]
        covered = [row for row in coverage_rows if int(row.get("chunk_count") or 0) > 0]
        coverage = {
            "domainCode": "agent",
            "domainName": "智能体",
            "knowledgePointCount": len([r for r in coverage_rows if int(r.get("level") or 0) == 3]),
            "coveredKnowledgePointCount": len([r for r in covered if int(r.get("level") or 0) == 3]),
            "coveredCategoryCount": len(covered),
            "status": "partial" if len(covered) < len(coverage_rows) else "complete",
        }
        recommendation = self._recommend(goal_data, profile_data, mastery, covered)
        return {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "mode": "goal_driven",
            "goal": goal_data,
            "profile": profile_data,
            "mastery": {
                "overall": round(sum(x["score"] for x in mastery) / len(mastery), 4) if mastery else 0,
                "items": mastery,
                "evidenceLevel": "observed" if mastery else "cold_start",
            },
            "knowledgeCoverage": coverage,
            "recommendation": recommendation,
        }

    def _goal(self, row: dict | None) -> dict[str, Any]:
        if not row:
            return {
                "id": None,
                "title": "大模型智能体工程：从原理到独立项目开发",
                "description": "系统掌握智能体原理、框架、工具、记忆、RAG、评估与工程实践。",
                "goalType": "SKILL_IMPROVEMENT",
                "expectedLevel": "PROFICIENT",
                "initialLevel": None,
                "assessmentMethod": "DIAGNOSTIC_TEST",
                "status": "ACTIVE",
                "inferred": True,
            }
        return {
            "id": self._uuid(row.get("id")),
            "title": row.get("title"),
            "description": row.get("description"),
            "goalType": row.get("goal_type"),
            "expectedLevel": row.get("expected_level"),
            "initialLevel": row.get("initial_level"),
            "assessmentMethod": row.get("assessment_method"),
            "targetDate": row.get("target_date").isoformat() if row.get("target_date") else None,
            "status": row.get("status"),
            "inferred": False,
        }

    @staticmethod
    def _recommend(goal: dict, profile: dict, mastery: list[dict], covered: list[dict]) -> dict:
        expected = LEVEL_SCORE.get(str(goal.get("expectedLevel") or "PROFICIENT"), 0.68)
        observed = [item for item in mastery if item["attempts"] > 0]
        weakest = min(observed, key=lambda item: item["score"]) if observed else None
        if weakest:
            topic = weakest["name"]
            ability = weakest["score"]
            reason = (
                f"该知识点当前掌握度约 {round(ability * 100)}%，低于目标水平。"
                if ability < expected else
                f"已有学习证据显示掌握度约 {round(ability * 100)}%，可以通过进阶测试验证迁移能力。"
            )
        else:
            preferred = next((row for row in covered if int(row.get("level") or 0) == 3), None)
            topic = preferred["name"] if preferred else "大模型智能体核心原理与工程实践"
            reason = "当前缺少足够的作答证据，先通过讲义与短测完成能力冷启动。"
            initial = str(goal.get("initialLevel") or "BEGINNER")
            ability = LEVEL_SCORE.get(initial, 0.28)
        difficulty = "foundation" if ability < .42 else "advanced" if ability < .72 else "challenge"
        preference = profile.get("learningPreference") or "PRACTICE_DRIVEN"
        detail = "detailed" if ability < .45 else "balanced"
        return {
            "topic": topic,
            "reason": reason,
            "ability": round(ability, 4),
            "difficulty": difficulty,
            "detailLevel": detail,
            "preferredFormat": preference,
            "nextResourceType": "lecture" if not observed or ability < .55 else "quiz",
            "questionCount": 9 if ability < .55 else 12,
            "ppt": {
                "title": f"{topic}：个性化学习课件",
                "requirement": (
                    f"围绕“{topic}”生成服务于当前学习目标“{goal.get('title')}”的个性化课件。"
                    f"学习者当前能力约为 {round(ability * 100)}%，目标水平为 {goal.get('expectedLevel')}。"
                    "优先使用智能体领域知识库中的可溯源内容，包含原理解释、工程案例、代码或流程、易错点和练习。"
                ),
                "slideCount": 20 if ability < .55 else 12,
                "detailLevel": detail,
            },
        }
