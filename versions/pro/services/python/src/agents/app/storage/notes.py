from __future__ import annotations

from datetime import datetime
import json
from uuid import UUID, uuid4

from app.config import Settings
from app.storage.platform_db import platform_connect
from app.storage.learning_resources import LearningResourceStore


class NoteStore:
    """Persistent user notes stored in the platform MySQL database."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._schema_ready = False

    def available(self) -> bool:
        return bool(self.settings.platform_db_url)

    def ensure_schema(self) -> None:
        if self._schema_ready:
            return
        ddl = """
        CREATE TABLE IF NOT EXISTS learning_notes (
          id BINARY(16) PRIMARY KEY,
          user_id BINARY(16) NOT NULL,
          title VARCHAR(160) NOT NULL,
          content TEXT NOT NULL,
          status VARCHAR(24) NOT NULL DEFAULT 'approved',
          source_type VARCHAR(32) NOT NULL DEFAULT 'manual',
          source_ref VARCHAR(128) NULL,
          source_context VARCHAR(500) NULL,
          created_at DATETIME(6) NOT NULL,
          updated_at DATETIME(6) NOT NULL,
          INDEX idx_learning_notes_user_updated (user_id, updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(ddl)
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS learning_note_categories (
                      id BINARY(16) PRIMARY KEY,
                      user_id BINARY(16) NOT NULL,
                      name VARCHAR(80) NOT NULL,
                      color CHAR(7) NOT NULL DEFAULT '#5b7f68',
                      created_at DATETIME(6) NOT NULL,
                      updated_at DATETIME(6) NOT NULL,
                      UNIQUE KEY uk_note_category_user_name (user_id, name),
                      INDEX idx_note_category_user (user_id, updated_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                cursor.execute("SHOW COLUMNS FROM learning_notes LIKE 'category_id'")
                if cursor.fetchone() is None:
                    cursor.execute(
                        "ALTER TABLE learning_notes ADD COLUMN category_id BINARY(16) NULL "
                        "AFTER user_id, ADD INDEX idx_learning_notes_category (category_id)"
                    )
                cursor.execute("SHOW COLUMNS FROM learning_notes LIKE 'knowledge_category_id'")
                if cursor.fetchone() is None:
                    cursor.execute(
                        "ALTER TABLE learning_notes ADD COLUMN knowledge_category_id BIGINT UNSIGNED NULL, "
                        "ADD COLUMN knowledge_category_name VARCHAR(160) NULL, "
                        "ADD COLUMN knowledge_match_confidence DECIMAL(5,4) NULL, "
                        "ADD COLUMN knowledge_match_locked TINYINT(1) NOT NULL DEFAULT 0, "
                        "ADD INDEX idx_learning_notes_knowledge (knowledge_category_id)"
                    )
                for column in ("learner_id", "kp_id", "source_kind", "kb_refs_json"):
                    cursor.execute(f"SHOW COLUMNS FROM learning_notes LIKE '{column}'")
                    if cursor.fetchone() is None:
                        column_type = "BINARY(16) NULL" if column == "learner_id" else "TEXT NULL"
                        cursor.execute(f"ALTER TABLE learning_notes ADD COLUMN {column} {column_type} NULL")
            connection.commit()
        self._schema_ready = True

    @staticmethod
    def _serialize(row: dict) -> dict:
        return {
            "id": str(UUID(bytes=row["id"])),
            "title": row["title"],
            "content": row["content"],
            "status": row["status"],
            "sourceType": row["source_type"],
            "sourceRef": row["source_ref"],
            "sourceContext": row["source_context"],
            "learnerId": str(UUID(bytes=row["learner_id"])) if row.get("learner_id") else None,
            "kpId": row.get("kp_id"), "sourceKind": row.get("source_kind"),
            "kbRefs": json.loads(row.get("kb_refs_json") or "[]"),
            "categoryId": str(UUID(bytes=row["category_id"])) if row.get("category_id") else None,
            "knowledgeCategoryId": int(row["knowledge_category_id"]) if row.get("knowledge_category_id") is not None else None,
            "knowledgeCategoryName": row.get("knowledge_category_name"),
            "knowledgeMatchConfidence": float(row["knowledge_match_confidence"]) if row.get("knowledge_match_confidence") is not None else None,
            "knowledgeMatchLocked": bool(row.get("knowledge_match_locked")),
            "createdAt": row["created_at"].isoformat(),
            "updatedAt": row["updated_at"].isoformat(),
        }

    def list(self, user_id: UUID) -> list[dict]:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM learning_notes WHERE user_id=%s ORDER BY updated_at DESC",
                    (user_id.bytes,),
                )
                rows = cursor.fetchall()
        return [self._serialize(row) for row in rows]

    def create(self, user_id: UUID, payload: dict) -> dict:
        self.ensure_schema()
        note_id = uuid4()
        now = datetime.utcnow()
        match = None
        if payload.get("knowledge_category_id") is None:
            match = LearningResourceStore(self.settings).match_knowledge_category(
                f"{payload['title']} {payload['content']} {payload.get('source_context') or ''}"
            )
        knowledge_id = payload.get("knowledge_category_id") or (match or {}).get("id")
        knowledge_name = payload.get("knowledge_category_name") or (match or {}).get("name")
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO learning_notes "
                    "(id,user_id,learner_id,kp_id,category_id,knowledge_category_id,knowledge_category_name,knowledge_match_confidence,knowledge_match_locked,"
                    "title,content,status,source_type,source_kind,source_ref,source_context,kb_refs_json,created_at,updated_at) "
                    "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (
                        note_id.bytes, user_id.bytes,
                        payload.get("learner_id").bytes if payload.get("learner_id") else None,
                        payload.get("kp_id"),
                        payload.get("category_id").bytes if payload.get("category_id") else None,
                        knowledge_id, knowledge_name, (match or {}).get("confidence"),
                        1 if payload.get("knowledge_category_id") is not None else 0,
                        payload["title"], payload["content"],
                        payload.get("status", "approved"), payload.get("source_type", "manual"),
                        payload.get("source_kind"),
                        payload.get("source_ref"), payload.get("source_context"),
                        json.dumps(payload.get("kb_refs") or [], ensure_ascii=False), now, now,
                    ),
                )
            connection.commit()
        return self.get(note_id, user_id)

    def get(self, note_id: UUID, user_id: UUID) -> dict | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM learning_notes WHERE id=%s AND user_id=%s",
                    (note_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
        return self._serialize(row) if row else None

    def update(self, note_id: UUID, user_id: UUID, payload: dict) -> dict | None:
        self.ensure_schema()
        fields, values = [], []
        for key in ("title", "content", "status"):
            if key in payload and payload[key] is not None:
                fields.append(f"{key}=%s")
                values.append(payload[key])
        if "category_id" in payload:
            fields.append("category_id=%s")
            category_id = payload.get("category_id")
            values.append(category_id.bytes if category_id else None)
        if "learner_id" in payload:
            learner_id = payload.get("learner_id")
            fields.append("learner_id=%s")
            values.append(learner_id.bytes if learner_id else None)
        if "kp_id" in payload:
            fields.append("kp_id=%s")
            values.append(payload.get("kp_id"))
        if "source_kind" in payload:
            fields.append("source_kind=%s")
            values.append(payload.get("source_kind"))
        if "kb_refs" in payload:
            fields.append("kb_refs_json=%s")
            values.append(json.dumps(payload.get("kb_refs") or [], ensure_ascii=False))
        if "knowledge_category_id" in payload:
            knowledge_id = payload.get("knowledge_category_id")
            fields.extend(("knowledge_category_id=%s", "knowledge_category_name=%s",
                           "knowledge_match_confidence=%s", "knowledge_match_locked=%s"))
            values.extend((knowledge_id, payload.get("knowledge_category_name"), None, 1))
        elif any(key in payload for key in ("title", "content")):
            current = self.get(note_id, user_id)
            if current and not current.get("knowledgeMatchLocked"):
                match = LearningResourceStore(self.settings).match_knowledge_category(
                    f"{payload.get('title') or current['title']} {payload.get('content') or current['content']}"
                )
                fields.extend(("knowledge_category_id=%s", "knowledge_category_name=%s",
                               "knowledge_match_confidence=%s"))
                values.extend(((match or {}).get("id"), (match or {}).get("name"),
                               (match or {}).get("confidence")))
        if fields:
            fields.append("updated_at=%s")
            values.extend((datetime.utcnow(), note_id.bytes, user_id.bytes))
            with platform_connect(self.settings) as connection:
                with connection.cursor() as cursor:
                    affected = cursor.execute(
                        f"UPDATE learning_notes SET {', '.join(fields)} WHERE id=%s AND user_id=%s",
                        tuple(values),
                    )
                connection.commit()
            if not affected:
                return None
        return self.get(note_id, user_id)

    def delete(self, note_id: UUID, user_id: UUID) -> bool:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                affected = cursor.execute(
                    "DELETE FROM learning_notes WHERE id=%s AND user_id=%s",
                    (note_id.bytes, user_id.bytes),
                )
            connection.commit()
        return affected > 0

    @staticmethod
    def _serialize_category(row: dict) -> dict:
        return {
            "id": str(UUID(bytes=row["id"])), "name": row["name"], "color": row["color"],
            "createdAt": row["created_at"].isoformat(), "updatedAt": row["updated_at"].isoformat(),
        }

    def list_categories(self, user_id: UUID) -> list[dict]:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM learning_note_categories WHERE user_id=%s ORDER BY name",
                    (user_id.bytes,),
                )
                rows = cursor.fetchall()
        return [self._serialize_category(row) for row in rows]

    def create_category(self, user_id: UUID, name: str, color: str) -> dict:
        self.ensure_schema()
        category_id, now = uuid4(), datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO learning_note_categories(id,user_id,name,color,created_at,updated_at) "
                    "VALUES(%s,%s,%s,%s,%s,%s)",
                    (category_id.bytes, user_id.bytes, name, color, now, now),
                )
            connection.commit()
        return next(item for item in self.list_categories(user_id) if item["id"] == str(category_id))

    def update_category(self, category_id: UUID, user_id: UUID, payload: dict) -> dict | None:
        fields, values = [], []
        for key in ("name", "color"):
            if payload.get(key) is not None:
                fields.append(f"{key}=%s")
                values.append(payload[key])
        if fields:
            fields.append("updated_at=%s")
            values.extend((datetime.utcnow(), category_id.bytes, user_id.bytes))
            with platform_connect(self.settings) as connection:
                with connection.cursor() as cursor:
                    affected = cursor.execute(
                        f"UPDATE learning_note_categories SET {', '.join(fields)} WHERE id=%s AND user_id=%s",
                        tuple(values),
                    )
                connection.commit()
            if not affected:
                return None
        return next((item for item in self.list_categories(user_id) if item["id"] == str(category_id)), None)

    def delete_category(self, category_id: UUID, user_id: UUID) -> bool:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE learning_notes SET category_id=NULL WHERE user_id=%s AND category_id=%s",
                    (user_id.bytes, category_id.bytes),
                )
                affected = cursor.execute(
                    "DELETE FROM learning_note_categories WHERE id=%s AND user_id=%s",
                    (category_id.bytes, user_id.bytes),
                )
            connection.commit()
        return affected > 0
