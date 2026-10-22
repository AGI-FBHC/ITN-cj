from __future__ import annotations

from uuid import UUID

from app.config import Settings
from app.storage.platform_db import platform_connect
from app.storage.user_memories import UserMemoryStore


SCENE_NAMESPACES = {
    "lecture_customize": {"profile", "goal", "preference", "knowledge", "misconception", "learning_strategy"},
    "practice_customize": {"profile", "goal", "preference", "knowledge", "misconception", "learning_strategy"},
    "quiz_customize": {"goal", "preference", "knowledge", "misconception"},
    "ppt_customize": {"profile", "goal", "preference", "knowledge", "misconception"},
    "ai_tutoring": {"profile", "goal", "preference", "knowledge", "misconception", "episodic"},
    "learning_recommendation": {"goal", "preference", "knowledge", "misconception"},
}


class UserMemoryService:
    """Deterministic memory facade. LLM callers consume one compact context shape."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.store = UserMemoryStore(settings)

    def bootstrap_profile(self, user_id: UUID) -> UUID | None:
        learner_id = self.store.primary_learner_id(user_id)
        if learner_id is None:
            return None
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT role,education,target_job,weekly_hours,learning_style_json,scores_json,goal,"
                    "blind_spots_json,preferred_format,diagnosis_summary FROM learners WHERE id=%s AND user_id=%s",
                    (learner_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone() or {}
        profile = {
            "role": row.get("role"), "education": row.get("education"),
            "targetJob": row.get("target_job"), "weeklyHours": row.get("weekly_hours"),
            "preferredFormat": row.get("preferred_format"),
            "learningStyle": self.store._loads(row.get("learning_style_json"), []),
        }
        if not self.store.has_tombstone(user_id, "profile", "profile.basic", {}):
            self.store.upsert(user_id, learner_id, "profile", "profile.basic", {}, profile,
                              "用户的基础学习背景", "system_calculated", 1, .9)
        goal = str(row.get("goal") or row.get("target_job") or "").strip()
        if goal and not self.store.has_tombstone(user_id, "goal", "goal.primary", {}):
            self.store.upsert(user_id, learner_id, "goal", "goal.primary", {},
                              {"goal": goal, "targetRole": row.get("target_job"), "priority": 1},
                              f"主要学习目标：{goal}", "user_declared", 1, 1)
        preferences = [str(item) for item in self.store._loads(row.get("learning_style_json"), []) if item]
        if row.get("preferred_format"):
            preferences.append(str(row["preferred_format"]))
        if preferences and not self.store.has_tombstone(user_id, "preference", "preference.content_format", {}):
            preferences = list(dict.fromkeys(preferences))
            self.store.upsert(user_id, learner_id, "preference", "preference.content_format", {},
                              {"dimension": "content_format", "preferred": preferences, "avoided": []},
                              "偏好的学习内容形式：" + "、".join(preferences),
                              "user_declared", 1, .8)
        return learner_id

    def record_event(self, user_id: UUID, event_type: str, source_module: str,
                     source_id: str, scope: dict | None = None, payload: dict | None = None) -> bool:
        scope, payload = scope or {}, payload or {}
        learner_id = self.bootstrap_profile(user_id)
        accepted = self.store.append_event(user_id, learner_id, event_type, source_module, source_id, scope, payload)
        if not accepted:
            return False
        kp_id = str(scope.get("kpId") or payload.get("kpId") or "").strip()
        if event_type in {"resource_progress", "resource_completed", "quiz_answered"} and kp_id:
            mastery = payload.get("mastery")
            progress = 1.0 if event_type == "resource_completed" else payload.get("progress")
            value = {"kpId": kp_id}
            if mastery is not None:
                value["mastery"] = max(0, min(1, float(mastery)))
            if progress is not None:
                value["progress"] = max(0, min(1, float(progress)))
            value["lastActivityType"] = event_type
            self.store.upsert(user_id, learner_id, "knowledge", f"knowledge.{kp_id}",
                              {"domainId": scope.get("domainId"), "kpId": kp_id}, value,
                              f"知识点 {kp_id} 的学习状态已更新", "system_calculated", .95, .9)
        if event_type == "quiz_answered" and not payload.get("correct") and kp_id:
            question_id = str(payload.get("questionId") or source_id)
            concept = str(payload.get("concept") or payload.get("question") or "本题所考查的概念")[:160]
            self.store.upsert(
                user_id, learner_id, "misconception", f"misconception.{kp_id}.{question_id}",
                {"domainId": scope.get("domainId"), "kpId": kp_id},
                {"kpId": kp_id, "questionId": question_id, "concept": concept,
                 "selectedAnswer": payload.get("selectedAnswer"), "resolved": False},
                f"在“{concept}”相关题目中出现过错误", "system_calculated", .85, .85,
            )
        if event_type == "resource_completed":
            self.store.upsert(
                user_id, learner_id, "episodic", f"episodic.resource_completed.{source_id}", scope,
                {"eventType": event_type, "resourceId": source_id, "title": payload.get("title"),
                 "resourceType": payload.get("resourceType")},
                f"已完成学习：{payload.get('title') or source_id}", "system_calculated", 1, .5,
            )
        return True

    def get_context(self, user_id: UUID, scene: str, scope: dict | None = None,
                    task_id: str | None = None) -> dict:
        scope = scope or {}
        self.bootstrap_profile(user_id)
        allowed = SCENE_NAMESPACES.get(scene, set().union(*SCENE_NAMESPACES.values()))
        kp_id = str(scope.get("kpId") or "")
        records = []
        for memory in self.store.list(user_id):
            if memory["namespace"] not in allowed:
                continue
            memory_kp = str((memory.get("scope") or {}).get("kpId") or (memory.get("value") or {}).get("kpId") or "")
            if memory_kp and kp_id and memory_kp != kp_id:
                continue
            records.append(memory)
        records = records[:20]
        by_namespace: dict[str, list[dict]] = {}
        for item in records:
            by_namespace.setdefault(item["namespace"], []).append(item)
        context = {
            "scene": scene, "scope": scope,
            "profile": self._first_value(by_namespace, "profile"),
            "goals": [item["value"] for item in by_namespace.get("goal", [])[:3]],
            "knowledge": self._first_value(by_namespace, "knowledge"),
            "misconceptions": [item["value"] | {"summary": item["summary"], "confidence": item["confidence"]}
                               for item in by_namespace.get("misconception", [])[:5]],
            "preferences": [item["value"] for item in by_namespace.get("preference", [])[:4]],
            "strategies": [item["value"] for item in by_namespace.get("learning_strategy", [])[:3]],
            "recentEpisodes": [item["value"] | {"summary": item["summary"]}
                               for item in by_namespace.get("episodic", [])[:3]],
            "memoryRefs": [{"memoryId": item["id"], "summary": item["summary"]} for item in records],
        }
        self.store.record_usage(user_id, [item["id"] for item in records], scene, task_id)
        return context

    @staticmethod
    def _first_value(grouped: dict[str, list[dict]], namespace: str) -> dict:
        items = grouped.get(namespace) or []
        return items[0]["value"] if items else {}

    async def extract_from_chat(self, user_id: UUID, messages: list[dict],
                               reply: str, scope: dict | None = None) -> None:
        """After a chat reply, asynchronously extract memory signals from the conversation.
        Fire-and-forget: failures are silently ignored. Max 3 memories per extraction."""
        import json as _json
        scope = scope or {}
        kp_id = str(scope.get("kpId") or "")
        # Build a compact conversation summary for the LLM
        recent = []
        for msg in messages[-6:]:
            role = msg.get("role", "user")
            content = str(msg.get("content") or "")[:300]
            recent.append(f"{role}: {content}")
        recent.append(f"assistant: {reply[:300]}")
        conversation = "\n".join(recent)
        prompt = (
            "从以下对话中提取用户暴露的学习信号。只提取明确的、可操作的信号，不推断。"
            "返回 JSON：{"
            '"misconceptions": [{"concept": "概念名", "evidence": "用户原话摘要"}], '
            '"preferences": [{"dimension": "偏好维度", "value": "偏好值"}], '
            '"goals": [{"goal": "目标描述"}]'
            "}。如果某个类别没有明确信号，返回空数组。最多3条。\n\n"
            f"对话内容：\n{conversation}"
        )
        try:
            from app.llm import LLMClient
            llm = LLMClient(self.settings)
            result = await llm.complete_json(
                "你是学习信号提取器，只返回JSON。从用户消息中提取明确的学习薄弱点、偏好和目标。",
                prompt, {}, provider="mimo", max_tokens=800, max_retries=1,
                thinking=False, timeout_seconds=30,
            )
            if not isinstance(result, dict):
                return
            learner_id = self.bootstrap_profile(user_id)
            count = 0
            for item in (result.get("misconceptions") or [])[:1]:
                concept = str(item.get("concept") or "").strip()
                evidence = str(item.get("evidence") or "").strip()
                if not concept:
                    continue
                mid = f"chat.{hash(concept) % 10**8:08d}"
                self.store.upsert(
                    user_id, learner_id, "misconception", f"misconception.{mid}",
                    {"kpId": kp_id}, {"concept": concept, "evidence": evidence, "source": "chat"},
                    f'对话中暴露对「{concept}」的理解偏差', "agent_inferred", .7, .7,
                )
                count += 1
            for item in (result.get("preferences") or [])[:1]:
                dimension = str(item.get("dimension") or "").strip()
                value = str(item.get("value") or "").strip()
                if not dimension or not value:
                    continue
                pid = f"chat.{hash(dimension) % 10**8:08d}"
                self.store.upsert(
                    user_id, learner_id, "preference", f"preference.{pid}",
                    {"kpId": kp_id}, {"dimension": dimension, "preferred": [value]},
                    f'表达过{dimension}偏好：{value}', "agent_inferred", .6, .6,
                )
                count += 1
            for item in (result.get("goals") or [])[:1]:
                goal = str(item.get("goal") or "").strip()
                if not goal:
                    continue
                gid = f"chat.{hash(goal) % 10**8:08d}"
                self.store.upsert(
                    user_id, learner_id, "goal", f"goal.{gid}",
                    {"kpId": kp_id}, {"goal": goal},
                    f'对话中提到目标：{goal}', "agent_inferred", .6, .7,
                )
                count += 1
        except Exception:
            pass  # fire-and-forget

    @staticmethod
    def prompt_block(context: dict) -> str:
        if not context.get("memoryRefs"):
            return ""
        import json
        safe = {key: context.get(key) for key in (
            "profile", "goals", "knowledge", "misconceptions", "preferences", "strategies", "recentEpisodes"
        )}
        return (
            "以下是当前用户已授权使用的学习记忆。仅在相关时用于调整表达和建议，"
            "不得改变事实、答案或引用；不要声称知道未提供的个人信息：\n"
            + json.dumps(safe, ensure_ascii=False, default=str)
        )
