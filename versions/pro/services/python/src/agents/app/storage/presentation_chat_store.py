from __future__ import annotations

from datetime import datetime
from uuid import UUID, uuid4

from app.config import Settings
from app.storage.platform_db import platform_connect


class PresentationChatStore:
    """Dedicated persistence for conversations belonging to one PPT task."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._schema_ready = False

    def ensure_schema(self) -> None:
        if self._schema_ready:
            return
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS presentation_chat_sessions (
                      id BINARY(16) PRIMARY KEY,
                      user_id BINARY(16) NOT NULL,
                      presentation_task_id BINARY(16) NOT NULL,
                      title VARCHAR(80) NOT NULL DEFAULT '新演示对话',
                      created_at DATETIME(6) NOT NULL,
                      updated_at DATETIME(6) NOT NULL,
                      INDEX idx_presentation_chat_owner
                        (user_id, presentation_task_id, updated_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    """
                )
                cursor.execute("SHOW COLUMNS FROM presentation_chat_sessions LIKE 'model_provider'")
                if cursor.fetchone() is None:
                    cursor.execute(
                        "ALTER TABLE presentation_chat_sessions ADD COLUMN model_provider "
                        "VARCHAR(16) NOT NULL DEFAULT 'mimo' AFTER title"
                    )
                cursor.execute("SHOW COLUMNS FROM presentation_chat_messages LIKE 'attachment_id'")
                if cursor.fetchone() is None:
                    cursor.execute(
                        "ALTER TABLE presentation_chat_messages ADD COLUMN "
                        "attachment_id BINARY(16) NULL AFTER input_type"
                    )
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS presentation_chat_messages (
                      id BINARY(16) PRIMARY KEY,
                      session_id BINARY(16) NOT NULL,
                      seq INT NOT NULL,
                      role VARCHAR(16) NOT NULL,
                      content TEXT NOT NULL,
                      input_type VARCHAR(16) NOT NULL DEFAULT 'text',
                      attachment_id BINARY(16) NULL,
                      created_at DATETIME(6) NOT NULL,
                      UNIQUE KEY uq_presentation_chat_seq (session_id, seq),
                      INDEX idx_presentation_chat_messages (session_id, seq)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                    """
                )
            connection.commit()
        self._schema_ready = True

    @staticmethod
    def _session(row: dict) -> dict:
        return {
            "id": str(UUID(bytes=row["id"])),
            "taskId": str(UUID(bytes=row["presentation_task_id"])),
            "title": row["title"],
            "modelProvider": row.get("model_provider") or "mimo",
            "createdAt": row["created_at"].isoformat(),
            "updatedAt": row["updated_at"].isoformat(),
        }

    def create(self, task_id: UUID, user_id: UUID, model_provider: str = "mimo") -> dict:
        self.ensure_schema()
        session_id, now = uuid4(), datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO presentation_chat_sessions"
                    "(id,user_id,presentation_task_id,title,model_provider,created_at,updated_at) "
                    "VALUES(%s,%s,%s,%s,%s,%s,%s)",
                    (session_id.bytes, user_id.bytes, task_id.bytes, "新演示对话", model_provider, now, now),
                )
            connection.commit()
        return {
            "id": str(session_id), "taskId": str(task_id), "title": "新演示对话",
            "modelProvider": model_provider, "createdAt": now.isoformat(), "updatedAt": now.isoformat(),
        }

    def list(self, task_id: UUID, user_id: UUID) -> list[dict]:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM presentation_chat_sessions "
                    "WHERE presentation_task_id=%s AND user_id=%s ORDER BY updated_at DESC",
                    (task_id.bytes, user_id.bytes),
                )
                rows = cursor.fetchall()
        return [self._session(row) for row in rows]

    def owned(
        self,
        session_id: UUID,
        task_id: UUID,
        user_id: UUID,
        model_provider: str | None = None,
    ) -> bool:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                query = (
                    "SELECT 1 FROM presentation_chat_sessions "
                    "WHERE id=%s AND presentation_task_id=%s AND user_id=%s"
                )
                params: list[object] = [session_id.bytes, task_id.bytes, user_id.bytes]
                if model_provider is not None:
                    query += " AND model_provider=%s"
                    params.append(model_provider)
                cursor.execute(query, tuple(params))
                return cursor.fetchone() is not None

    def messages(self, session_id: UUID) -> list[dict]:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id,seq,role,content,input_type,attachment_id,created_at "
                    "FROM presentation_chat_messages WHERE session_id=%s ORDER BY seq",
                    (session_id.bytes,),
                )
                rows = cursor.fetchall()
        return [{
            "id": str(UUID(bytes=row["id"])), "seq": row["seq"], "role": row["role"],
            "content": row["content"], "inputType": row["input_type"],
            "attachmentId": str(UUID(bytes=row["attachment_id"])) if row.get("attachment_id") else None,
            "createdAt": row["created_at"].isoformat(),
        } for row in rows]

    def append(self, session_id: UUID, role: str, content: str, input_type: str = "text",
               attachment_id: UUID | None = None) -> dict:
        self.ensure_schema()
        message_id, now = uuid4(), datetime.utcnow()
        clean = content.strip()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT COALESCE(MAX(seq),0)+1 AS next_seq "
                    "FROM presentation_chat_messages WHERE session_id=%s FOR UPDATE",
                    (session_id.bytes,),
                )
                seq = int(cursor.fetchone()["next_seq"])
                cursor.execute(
                    "INSERT INTO presentation_chat_messages"
                    "(id,session_id,seq,role,content,input_type,attachment_id,created_at) "
                    "VALUES(%s,%s,%s,%s,%s,%s,%s,%s)",
                    (message_id.bytes, session_id.bytes, seq, role, clean, input_type,
                     attachment_id.bytes if attachment_id else None, now),
                )
                cursor.execute(
                    "UPDATE presentation_chat_sessions SET "
                    "title=IF(title='新演示对话' AND %s='user',LEFT(%s,80),title),updated_at=%s "
                    "WHERE id=%s",
                    (role, clean or "语音消息", now, session_id.bytes),
                )
            connection.commit()
        return {"id": str(message_id), "seq": seq}

    def delete(self, session_id: UUID, task_id: UUID, user_id: UUID) -> bool:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                if not self.owned(session_id, task_id, user_id):
                    return False
                cursor.execute(
                    "DELETE FROM presentation_chat_messages WHERE session_id=%s",
                    (session_id.bytes,),
                )
                affected = cursor.execute(
                    "DELETE FROM presentation_chat_sessions WHERE id=%s",
                    (session_id.bytes,),
                )
            connection.commit()
        return affected > 0
