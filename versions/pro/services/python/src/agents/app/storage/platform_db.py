import json
from urllib.parse import urlparse
from uuid import UUID

import pymysql
import time
import pymysql.cursors

from app.config import Settings


def platform_connect(settings: Settings):
    parsed = urlparse(settings.platform_db_url)
    return pymysql.connect(
        host=parsed.hostname,
        port=parsed.port or 3306,
        user=parsed.username,
        password=parsed.password,
        database=parsed.path.lstrip("/"),
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=10,
        read_timeout=120,
        write_timeout=120,
        max_allowed_packet=64 * 1024 * 1024,
    )




_KNOWLEDGE_MAP_CACHE: dict[str, tuple[float, dict]] = {}
_KNOWLEDGE_MAP_TTL_SECONDS = 60.0


class PlatformDirectory:
    """Read-only access to the platform MySQL database owned by Spring Boot."""

    def __init__(self, settings: Settings):
        self.settings = settings

    def available(self) -> bool:
        return bool(self.settings.platform_db_url)

    def _connect(self):
        return platform_connect(self.settings)

    def load_goal(self, user_id: UUID, learning_goal_id: UUID) -> dict | None:
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT goal_type, expected_level, initial_level FROM learning_goals "
                    "WHERE id = %s AND user_id = %s",
                    (learning_goal_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        return {
            "goalType": row["goal_type"],
            "expectedLevel": row["expected_level"],
            "initialLevel": row["initial_level"],
        }

    def load_learner(self, learner_id: UUID, user_id: UUID) -> dict | None:
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id, code, name, avatar, role, education, target_job, weekly_hours,"
                    " learning_style_json, scores_json, goal, blind_spots_json, preferred_format,"
                    " diagnosis_summary FROM learners WHERE id = %s AND user_id = %s AND status = 1",
                    (learner_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        return {
            "id": str(UUID(bytes=row["id"])),
            "code": row["code"], "name": row["name"], "avatar": row["avatar"],
            "role": row["role"], "education": row["education"], "targetJob": row["target_job"],
            "weeklyHours": row["weekly_hours"], "goal": row["goal"],
            "preferredFormat": row["preferred_format"], "diagnosisSummary": row["diagnosis_summary"],
            "learningStyle": self._parse_json(row["learning_style_json"], []),
            "scores": self._parse_json(row["scores_json"], {}),
            "blindSpots": self._parse_json(row["blind_spots_json"], []),
        }

    def load_primary_learner(self, user_id: UUID) -> dict | None:
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id FROM learners WHERE user_id = %s AND status = 1 "
                    "ORDER BY created_at ASC LIMIT 1",
                    (user_id.bytes,),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        return self.load_learner(UUID(bytes=row["id"]), user_id)

    def load_knowledge_points(self) -> list[dict]:
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT code, name, en_name, weight, target_level, coverage, description, core_topics_json"
                    " FROM knowledge_point WHERE status = 1 ORDER BY sort_order, id"
                )
                rows = cursor.fetchall()
        return [self._knowledge_point(row) for row in rows]

    def load_knowledge_point(self, code: str) -> dict | None:
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT code, name, en_name, weight, target_level, coverage, description, core_topics_json"
                    " FROM knowledge_point WHERE code = %s AND status = 1 LIMIT 1",
                    (code,),
                )
                row = cursor.fetchone()
        return self._knowledge_point(row) if row else None

    def load_knowledge_topics(self, kp_code: str) -> list[dict]:
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT kt.code,kt.name,kt.full_name,kt.topic_index FROM knowledge_topic kt "
                    "JOIN knowledge_point kp ON kp.id=kt.knowledge_point_id "
                    "WHERE kp.code=%s ORDER BY kt.topic_index,kt.id",
                    (kp_code,),
                )
                rows = cursor.fetchall()
        return [{"id": row["code"], "name": row["full_name"] or row["name"], "index": row["topic_index"]} for row in rows]

    def load_knowledge_map(self, domain_code: str = "agent") -> dict:
        """真实知识树（knowledge_category + job_target_levels）：与前端知识网络同源。"""
        cache_key = f"knowledge_map:{domain_code}"
        now = time.monotonic()
        hit = _KNOWLEDGE_MAP_CACHE.get(cache_key)
        if hit and now - hit[0] < _KNOWLEDGE_MAP_TTL_SECONDS:
            return hit[1]
        with self._connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT kc.id,kc.parent_id,kc.node_code,kc.name,kc.level,kc.sort_order "
                    "FROM knowledge_category kc JOIN knowledge_domain kd ON kd.id=kc.domain_id "
                    "WHERE kd.code=%s AND kc.status=1 ORDER BY kc.level,kc.sort_order,kc.id",
                    (domain_code,),
                )
                rows = cursor.fetchall()
                try:
                    cursor.execute("SELECT node_code, target_mastery FROM job_target_levels")
                    target_rows = cursor.fetchall()
                except Exception:
                    target_rows = []
        targets = {str(r["node_code"]): int(r["target_mastery"] or 0) for r in target_rows}
        chapters: list[dict] = []
        by_code: dict[str, str] = {}
        chapter_index: dict[int, int] = {}
        for row in rows:
            level = int(row["level"])
            code = str(row["node_code"] or "")
            name = str(row["name"] or code)
            if level == 2:
                by_code[code] = name
                chapter_index[int(row["id"])] = len(chapters)
                chapters.append({
                    "code": code, "name": name,
                    "targetLevel": targets.get(code, 80),
                    "topics": [],
                })
        for row in rows:
            if int(row["level"]) == 3:
                code = str(row["node_code"] or "")
                name = str(row["name"] or code)
                by_code[code] = name
                idx = chapter_index.get(int(row["parent_id"] or 0))
                if idx is not None:
                    chapters[idx]["topics"].append({
                        "id": code, "name": name,
                        "targetLevel": targets.get(code, 80),
                    })
        result = {"chapters": chapters, "byCode": by_code}
        _KNOWLEDGE_MAP_CACHE[cache_key] = (time.monotonic(), result)
        return result

    def load_profile(self, user_id: UUID) -> dict:
        with self._connect() as connection:
            with connection.cursor() as cursor:
                try:
                    cursor.execute(
                        "SELECT education_level, major, technical_foundation, learning_preference, "
                        "tts_voice, tts_speed FROM user_profiles WHERE user_id = %s",
                        (user_id.bytes,),
                    )
                except pymysql.err.OperationalError as exc:
                    if exc.args[0] != 1054:
                        raise
                    cursor.execute(
                        "SELECT education_level, major, technical_foundation, learning_preference, "
                        "tts_voice FROM user_profiles WHERE user_id = %s",
                        (user_id.bytes,),
                    )
                row = cursor.fetchone()
                cursor.execute(
                    "SELECT education, role, target_job, weekly_hours, learning_style_json, "
                    "scores_json, goal, blind_spots_json, preferred_format, diagnosis_summary "
                    "FROM learners WHERE user_id = %s AND status = 1 "
                    "ORDER BY created_at, id LIMIT 1",
                    (user_id.bytes,),
                )
                learner = cursor.fetchone()
        profile = {}
        if row is not None:
            profile = {
                "educationLevel": row["education_level"],
                "major": row["major"],
                "technicalFoundation": row["technical_foundation"],
                "learningPreference": row["learning_preference"],
                "ttsVoice": row["tts_voice"],
                "ttsSpeed": row.get("tts_speed") or "normal",
            }
        if learner is not None:
            if not profile:
                profile = {"ttsVoice": "苏打", "ttsSpeed": "normal"}
            profile["educationLevel"] = profile.get("educationLevel") or learner.get("education")
            profile["role"] = learner.get("role") or profile.get("role")
            profile["targetJob"] = learner.get("target_job") or profile.get("targetJob")
            profile["weeklyHours"] = learner.get("weekly_hours") if learner.get("weekly_hours") is not None else profile.get("weeklyHours")
            profile["learningStyle"] = self._parse_json(learner.get("learning_style_json"), [])
            profile["scores"] = self._parse_json(learner.get("scores_json"), {})
            profile["goal"] = learner.get("goal") or profile.get("goal")
            profile["blindSpots"] = self._parse_json(learner.get("blind_spots_json"), [])
            profile["preferredFormat"] = learner.get("preferred_format") or profile.get("preferredFormat")
            profile["diagnosisSummary"] = learner.get("diagnosis_summary") or profile.get("diagnosisSummary")
        return profile

    @staticmethod
    def _parse_json(value, default):
        if not value:
            return default
        try:
            return json.loads(value)
        except Exception:
            return default

    @staticmethod
    def _knowledge_point(row: dict) -> dict:
        return {
            "code": row["code"], "name": row["name"], "enName": row.get("en_name"),
            "weight": float(row["weight"] or 0), "targetLevel": row["target_level"],
            "coverage": row["coverage"], "description": row.get("description"),
            "coreTopics": json.loads(row["core_topics_json"]) if row.get("core_topics_json") else [],
        }
