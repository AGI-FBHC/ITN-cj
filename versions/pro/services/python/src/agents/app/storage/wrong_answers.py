from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import UUID, uuid4

from app.config import Settings
from app.storage.learning_resources import LearningResourceStore
from app.storage.platform_db import platform_connect


def _coerce_category_id(value: object) -> int | None:
    try:
        category_id = int(value) if value is not None else None
        return category_id if category_id is not None and category_id > 0 else None
    except (TypeError, ValueError):
        return None


def _iso_utc(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class WrongAnswerStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._schema_ready = False

    def ensure_schema(self) -> None:
        if self._schema_ready:
            return
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS learning_wrong_answers (
                      id BINARY(16) PRIMARY KEY, user_id BINARY(16) NOT NULL,
                      resource_id BINARY(16) NULL, question_id VARCHAR(80) NOT NULL,
                      stem TEXT NOT NULL, options_json JSON NOT NULL,
                      user_answer INT NOT NULL, correct_answer INT NOT NULL,
                      explanation TEXT NULL, difficulty VARCHAR(16) NOT NULL,
                      citations_json JSON NULL,
                      knowledge_category_id BIGINT UNSIGNED NULL,
                      knowledge_category_name VARCHAR(160) NULL,
                      knowledge_match_confidence DECIMAL(5,4) NULL,
                      knowledge_match_locked TINYINT(1) NOT NULL DEFAULT 0,
                      review_status VARCHAR(24) NOT NULL DEFAULT 'unreviewed',
                      review_count INT NOT NULL DEFAULT 0,
                      created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL,
                      UNIQUE KEY uk_wrong_user_question (user_id, resource_id, question_id),
                      INDEX idx_wrong_user_status (user_id, review_status, updated_at),
                      INDEX idx_wrong_knowledge (knowledge_category_id)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                for column, column_type in (
                    ("learner_id", "BINARY(16) NULL"), ("kp_id", "VARCHAR(64) NULL"),
                    ("from_source", "VARCHAR(32) NULL"), ("first_at", "DATETIME(6) NULL"),
                    ("streak", "INT NOT NULL DEFAULT 0"), ("last_pick", "INT NULL"),
                    ("mastered", "TINYINT(1) NOT NULL DEFAULT 0"), ("kb_refs_json", "TEXT NULL"),
                ):
                    cursor.execute(f"SHOW COLUMNS FROM learning_wrong_answers LIKE '{column}'")
                    if cursor.fetchone() is None:
                        cursor.execute(f"ALTER TABLE learning_wrong_answers ADD COLUMN {column} {column_type}")
            connection.commit()
        self._schema_ready = True

    @staticmethod
    def _serialize(row: dict) -> dict:
        return {
            "id": str(UUID(bytes=row["id"])),
            "resourceId": str(UUID(bytes=row["resource_id"])) if row.get("resource_id") else None,
            "questionId": row["question_id"], "stem": row["stem"],
            "learnerId": str(UUID(bytes=row["learner_id"])) if row.get("learner_id") else None,
            "kpId": row.get("kp_id"), "fromSource": row.get("from_source"),
            "firstAt": _iso_utc(row.get("first_at") or row["created_at"]),
            "streak": row.get("streak") or 0, "lastPick": row.get("last_pick"),
            "mastered": bool(row.get("mastered")), "kbRefs": json.loads(row.get("kb_refs_json") or "[]"),
            "options": json.loads(row["options_json"] or "[]"),
            "userAnswer": row["user_answer"], "correctAnswer": row["correct_answer"],
            "explanation": row.get("explanation") or "", "difficulty": row["difficulty"],
            "citations": json.loads(row.get("citations_json") or "[]"),
            "knowledgeCategoryId": int(row["knowledge_category_id"]) if row.get("knowledge_category_id") is not None else None,
            "knowledgeCategoryName": row.get("knowledge_category_name"),
            "knowledgeMatchConfidence": float(row["knowledge_match_confidence"]) if row.get("knowledge_match_confidence") is not None else None,
            "knowledgeMatchLocked": bool(row.get("knowledge_match_locked")),
            "reviewStatus": row["review_status"], "reviewCount": row["review_count"],
            "createdAt": _iso_utc(row["created_at"]), "updatedAt": _iso_utc(row["updated_at"]),
        }

    def list(self, user_id: UUID, keyword: str | None = None) -> list[dict]:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                if keyword and keyword.strip():
                    like = f"%{keyword.strip()}%"
                    cursor.execute(
                        "SELECT * FROM learning_wrong_answers WHERE user_id=%s "
                        "AND (stem LIKE %s OR explanation LIKE %s OR knowledge_category_name LIKE %s) "
                        "ORDER BY updated_at DESC",
                        (user_id.bytes, like, like, like),
                    )
                else:
                    cursor.execute("SELECT * FROM learning_wrong_answers WHERE user_id=%s ORDER BY updated_at DESC", (user_id.bytes,))
                rows = cursor.fetchall()
        return [self._serialize(row) for row in rows]

    def count_by_kp(self, user_id: UUID) -> dict[str, int]:
        """Aggregate wrong-answer counts per knowledge point without loading full rows."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT kp_id, COUNT(*) AS n FROM learning_wrong_answers "
                    "WHERE user_id=%s GROUP BY kp_id",
                    (user_id.bytes,),
                )
                rows = cursor.fetchall()
        return {str(row.get("kp_id") or ""): int(row["n"]) for row in rows if row.get("kp_id")}

    def record(self, user_id: UUID, resource_id: UUID | None, question: dict, user_answer: int,
               point: dict, learner_id: UUID | None = None,
               from_source: str = "quiz", kb_refs: list[str] | None = None) -> dict:
        self.ensure_schema()
        match = None
        knowledge_id = _coerce_category_id(point.get("categoryId"))
        category_locked = knowledge_id is not None
        knowledge_name = point.get("categoryName") or point.get("name")
        if knowledge_id is None:
            match = LearningResourceStore(self.settings).match_knowledge_category(
                f"{point.get('name', '')} {question.get('stem', '')} {question.get('explanation', '')}"
            )
            knowledge_id, knowledge_name = (match or {}).get("id"), (match or {}).get("name")
        now, wrong_id = datetime.utcnow(), uuid4()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("""
                    INSERT INTO learning_wrong_answers
                    (id,user_id,learner_id,kp_id,from_source,first_at,streak,last_pick,mastered,
                     resource_id,question_id,stem,options_json,user_answer,correct_answer,explanation,difficulty,
                     citations_json,kb_refs_json,knowledge_category_id,knowledge_category_name,knowledge_match_confidence,knowledge_match_locked,
                     review_status,review_count,created_at,updated_at)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'unreviewed',0,%s,%s)
                    ON DUPLICATE KEY UPDATE user_answer=VALUES(user_answer), explanation=VALUES(explanation),
                     review_status='unreviewed', first_at=COALESCE(first_at, VALUES(first_at)),
                     streak=0, last_pick=VALUES(last_pick), mastered=0, updated_at=VALUES(updated_at)
                """, (wrong_id.bytes, user_id.bytes,
                      learner_id.bytes if learner_id else None, point.get("kpId") or point.get("id"),
                      from_source, now, 0, user_answer, 0,
                      resource_id.bytes if resource_id else None, str(question["id"]), question["stem"],
                      json.dumps(question.get("options") or [], ensure_ascii=False), user_answer, question["correctIndex"],
                      question.get("explanation"), question.get("difficulty", "medium"),
                      json.dumps(question.get("citations") or []), json.dumps(kb_refs or [], ensure_ascii=False),
                      knowledge_id, knowledge_name,
                      (match or {}).get("confidence"), 1 if category_locked else 0, now, now))
            connection.commit()
        return next(item for item in self.list(user_id)
                    if item["resourceId"] == (str(resource_id) if resource_id else None) and item["questionId"] == str(question["id"]))

    def update(self, wrong_id: UUID, user_id: UUID, payload: dict) -> dict | None:
        fields, values = [], []
        if payload.get("review_status") is not None:
            fields.append("review_status=%s"); values.append(payload["review_status"])
        if payload.get("mastered") is not None:
            fields.append("mastered=%s"); values.append(1 if payload["mastered"] else 0)
        if payload.get("streak") is not None:
            fields.append("streak=%s"); values.append(payload["streak"])
        if payload.get("last_pick") is not None:
            fields.append("last_pick=%s"); values.append(payload["last_pick"])
        if "knowledge_category_id" in payload:
            fields.extend(("knowledge_category_id=%s", "knowledge_category_name=%s",
                           "knowledge_match_confidence=NULL", "knowledge_match_locked=1"))
            values.extend((payload.get("knowledge_category_id"), payload.get("knowledge_category_name")))
        if not fields:
            return next((item for item in self.list(user_id) if item["id"] == str(wrong_id)), None)
        fields.append("updated_at=%s"); values.extend((datetime.utcnow(), wrong_id.bytes, user_id.bytes))
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                affected = cursor.execute(f"UPDATE learning_wrong_answers SET {', '.join(fields)} WHERE id=%s AND user_id=%s", tuple(values))
            connection.commit()
        return next((item for item in self.list(user_id) if item["id"] == str(wrong_id)), None) if affected else None

    def review(self, wrong_id: UUID, user_id: UUID, answer: int) -> dict | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT options_json, correct_answer, mastered FROM learning_wrong_answers WHERE id=%s AND user_id=%s",
                    (wrong_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
                if row is None:
                    return None
                options = json.loads(row.get("options_json") or "[]")
                if answer >= len(options):
                    raise ValueError("Answer index is outside the available options")
                correct = answer == row["correct_answer"]
                cursor.execute(
                    """
                    UPDATE learning_wrong_answers
                    SET last_pick=%s,
                        streak=CASE WHEN %s THEN streak+1 ELSE 0 END,
                        mastered=CASE WHEN %s THEN mastered ELSE 0 END,
                        review_status=CASE WHEN mastered=1 AND %s THEN 'mastered' ELSE 'reviewing' END,
                        review_count=review_count+1,
                        updated_at=%s
                    WHERE id=%s AND user_id=%s
                    """,
                    (answer, correct, correct, correct, datetime.now(timezone.utc).replace(tzinfo=None), wrong_id.bytes, user_id.bytes),
                )
            connection.commit()
        item = next((entry for entry in self.list(user_id) if entry["id"] == str(wrong_id)), None)
        return {"item": item, "correct": correct} if item else None

    def delete(self, wrong_id: UUID, user_id: UUID) -> bool:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                affected = cursor.execute("DELETE FROM learning_wrong_answers WHERE id=%s AND user_id=%s", (wrong_id.bytes, user_id.bytes))
            connection.commit()
        return affected > 0

    def delete_by_resource(self, user_id: UUID, resource_id: UUID) -> None:
        '重新练习：清除该用户对此资源的全部错题记录。'
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM learning_wrong_answers WHERE user_id=%s AND resource_id=%s",
                    (user_id.bytes, resource_id.bytes),
                )
            connection.commit()


