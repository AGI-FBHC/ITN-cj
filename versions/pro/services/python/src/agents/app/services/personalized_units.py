from __future__ import annotations

import hashlib
import json
from datetime import datetime
from uuid import UUID

from app.config import Settings
from app.services.learning_content import LearningContentService
from app.storage.platform_db import PlatformDirectory, platform_connect


class PersonalizedUnitStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._ready = False

    def ensure_schema(self) -> None:
        if self._ready:
            return
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS personalized_learning_units (
                      user_id BINARY(16) NOT NULL, learner_id BINARY(16) NOT NULL,
                      kp_id VARCHAR(64) NOT NULL, topic_id VARCHAR(96) NOT NULL,
                      profile_signature VARCHAR(64) NOT NULL, content_json JSON NOT NULL,
                      sources_json JSON NOT NULL, created_at DATETIME(6) NOT NULL,
                      updated_at DATETIME(6) NOT NULL,
                      PRIMARY KEY (user_id, learner_id, kp_id, topic_id, profile_signature),
                      INDEX idx_personalized_unit_lookup (user_id, learner_id, kp_id, topic_id, updated_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
            connection.commit()
        self._ready = True

    def get(self, user_id: UUID, learner_id: UUID, kp_id: str, topic_id: str, signature: str) -> dict | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT content_json,sources_json,updated_at FROM personalized_learning_units "
                    "WHERE user_id=%s AND learner_id=%s AND kp_id=%s AND topic_id=%s AND profile_signature=%s LIMIT 1",
                    (user_id.bytes, learner_id.bytes, kp_id, topic_id, signature),
                )
                row = cursor.fetchone()
        if not row:
            return None
        content = row["content_json"] if isinstance(row["content_json"], dict) else json.loads(row["content_json"])
        sources = row["sources_json"] if isinstance(row["sources_json"], list) else json.loads(row["sources_json"])
        return {**content, "sources": sources, "updatedAt": row["updated_at"].isoformat(), "cached": True}

    def put(self, user_id: UUID, learner_id: UUID, kp_id: str, topic_id: str, signature: str,
            content: dict, sources: list[dict]) -> dict:
        self.ensure_schema()
        now = datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("""
                    INSERT INTO personalized_learning_units
                      (user_id,learner_id,kp_id,topic_id,profile_signature,content_json,sources_json,created_at,updated_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON DUPLICATE KEY UPDATE content_json=VALUES(content_json),sources_json=VALUES(sources_json),updated_at=VALUES(updated_at)
                """, (user_id.bytes, learner_id.bytes, kp_id, topic_id, signature,
                       json.dumps(content, ensure_ascii=False), json.dumps(sources, ensure_ascii=False), now, now))
            connection.commit()
        return {**content, "sources": sources, "updatedAt": now.isoformat(), "cached": False}


class PersonalizedUnitService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.directory = PlatformDirectory(settings)
        self.store = PersonalizedUnitStore(settings)

    @staticmethod
    def _signature(learner: dict) -> str:
        payload = {key: learner.get(key) for key in ("education", "targetJob", "learningStyle", "scores", "goal", "preferredFormat")}
        return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()

    def topic(self, kp_id: str, topic_id: str) -> dict | None:
        km = self.directory.load_knowledge_map()
        for chapter in km.get("chapters") or []:
            if chapter.get("code") == kp_id:
                return next((topic for topic in chapter.get("topics") or [] if topic["id"] == topic_id), None)
        return None

    def point_name(self, kp_id: str) -> str | None:
        km = self.directory.load_knowledge_map()
        return (km.get("byCode") or {}).get(kp_id)

    async def get_or_generate(self, user_id: UUID, learner_id: UUID, kp_id: str, topic_id: str) -> dict:
        learner = self.directory.load_learner(learner_id, user_id)
        topic = self.topic(kp_id, topic_id)
        point_name = self.point_name(kp_id)
        if not learner or not topic or not point_name:
            raise KeyError("learner or smallest knowledge topic not found")
        signature = self._signature(learner)
        cached = self.store.get(user_id, learner_id, kp_id, topic_id, signature)
        if cached:
            return cached
        score = int((learner.get("scores") or {}).get(kp_id, 50))
        context = {
            "profile": learner,
            "mastery": {"ability": score / 100, "evidenceLevel": "profile"},
            "recommendation": {"difficulty": "introductory" if score < 55 else "advanced" if score > 75 else "systematic",
                               "reason": f"当前最小知识点掌握度约 {score}%"},
            "scope": {"kpId": kp_id, "topicId": topic_id, "topicName": topic["name"],
                      "rule": "只讲当前最小知识点，不扩展成父章节或完整课程"},
        }
        generator = LearningContentService(self.settings)
        try:
            lecture, sources, _decision = await generator.generate_lecture({
                "topic": f"{topic['name']}（所属领域：{point_name}）",
                "title": topic["name"], "detail_level": "balanced",
            }, context)
        finally:
            await generator.close()
        blocks = []
        index = 0
        for chapter in lecture.get("chapters") or []:
            for section in chapter.get("sections") or []:
                index += 1
                blocks.append({
                    "kind": "concept", "id": f"{kp_id}-{topic_id}-b{index}",
                    "title": str(section.get("title") or topic["name"]),
                    "text": str(section.get("content") or ""),
                    "citations": section.get("citations") or [],
                    "script": str(section.get("content") or "").replace("#", "")[:1800],
                    "kbRefs": [],
                })
        blocks.append({"kind": "summary", "id": f"{kp_id}-{topic_id}-summary",
                       "text": str(lecture.get("summary") or f"完成{topic['name']}的学习。"),
                       "script": str(lecture.get("summary") or f"完成{topic['name']}的学习。")})
        content = {
            "kpId": kp_id, "topicId": topic_id, "topicName": topic["name"],
            "difficulty": "零基础" if score < 55 else "进阶" if score > 75 else "标准",
            "styleLabel": self._style(learner), "blocks": blocks,
        }
        return self.store.put(user_id, learner_id, kp_id, topic_id, signature, content, sources)

    @staticmethod
    def _style(learner: dict) -> str:
        styles = " ".join(learner.get("learningStyle") or [])
        if "实操" in styles or "步骤" in styles: return "实操导向"
        if "案例" in styles: return "案例对照"
        if "图" in styles or "视频" in styles: return "图解优先"
        return "理论先行"
