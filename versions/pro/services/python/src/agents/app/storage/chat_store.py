from datetime import datetime
from uuid import UUID, uuid4

import json

from app.config import Settings
from app.storage.platform_db import platform_connect

DEFAULT_SESSION_TITLE = "新对话"
SESSION_TITLE_MAX_LENGTH = 64


class ChatSessionStore:
    """Chat session persistence in the platform MySQL database."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._tools_column_checked = False

    def available(self) -> bool:
        return bool(self.settings.platform_db_url)

    @staticmethod
    def _now() -> datetime:
        return datetime.utcnow()

    def _ensure_tools_column(self) -> None:
        """Add tools_json column to chat_messages if missing (runtime migration)."""
        if self._tools_column_checked:
            return
        self._tools_column_checked = True
        try:
            with platform_connect(self.settings) as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SHOW COLUMNS FROM chat_messages LIKE 'tools_json'")
                    if cursor.fetchone() is None:
                        cursor.execute(
                            "ALTER TABLE chat_messages "
                            "ADD COLUMN tools_json JSON NULL AFTER reasoning"
                        )
                    connection.commit()
        except Exception:
            pass  # 迁移失败不阻塞读写，tools 列缺失时按空处理

    def _ensure_archive_column(self) -> None:
        """Keep the Agents API usable before the Spring migration is restarted."""
        if getattr(self, "_archive_column_checked", False):
            return
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SHOW COLUMNS FROM chat_sessions LIKE 'archived'")
                if cursor.fetchone() is None:
                    cursor.execute(
                        "ALTER TABLE chat_sessions "
                        "ADD COLUMN archived BOOLEAN NOT NULL DEFAULT FALSE AFTER title"
                    )
            connection.commit()
        self._archive_column_checked = True

    @staticmethod
    def _session_row(row: dict) -> dict:
        return {
            "id": str(UUID(bytes=row["id"])),
            "title": row["title"],
            "archived": bool(row.get("archived", False)),
            "created_at": row["created_at"].isoformat(),
            "updated_at": row["updated_at"].isoformat(),
        }

    def create_session(self, user_id: UUID) -> dict:
        self._ensure_archive_column()
        session_id = uuid4()
        now = self._now()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO chat_sessions(id, user_id, title, created_at, updated_at) "
                    "VALUES(%s, %s, %s, %s, %s)",
                    (session_id.bytes, user_id.bytes, DEFAULT_SESSION_TITLE, now, now),
                )
            connection.commit()
        return {"id": str(session_id), "title": DEFAULT_SESSION_TITLE, "archived": False,
                "created_at": now.isoformat(), "updated_at": now.isoformat()}

    def list_sessions(self, user_id: UUID, archived: bool = False) -> list[dict]:
        self._ensure_archive_column()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id, title, archived, created_at, updated_at FROM chat_sessions "
                    "WHERE user_id = %s AND archived = %s ORDER BY updated_at DESC",
                    (user_id.bytes, archived),
                )
                rows = cursor.fetchall()
        return [self._session_row(row) for row in rows]

    def get_session(self, session_id: UUID, user_id: UUID) -> dict | None:
        self._ensure_archive_column()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id, title, archived, created_at, updated_at FROM chat_sessions "
                    "WHERE id = %s AND user_id = %s",
                    (session_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
        return self._session_row(row) if row else None

    def set_archived(self, session_id: UUID, user_id: UUID, archived: bool) -> dict | None:
        now = self._now()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                affected = cursor.execute(
                    "UPDATE chat_sessions SET archived = %s, updated_at = %s "
                    "WHERE id = %s AND user_id = %s",
                    (archived, now, session_id.bytes, user_id.bytes),
                )
            connection.commit()
        return self.get_session(session_id, user_id) if affected else None

    def delete_session(self, session_id: UUID, user_id: UUID) -> bool:
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                affected = cursor.execute(
                    "DELETE FROM chat_sessions WHERE id = %s AND user_id = %s",
                    (session_id.bytes, user_id.bytes),
                )
            connection.commit()
        return affected > 0

    def list_messages(self, session_id: UUID) -> list[dict]:
        self._ensure_tools_column()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id, seq, role, content, reasoning, tools_json, created_at "
                    "FROM chat_messages WHERE session_id = %s ORDER BY seq",
                    (session_id.bytes,),
                )
                rows = cursor.fetchall()
        messages = [{
            "id": str(UUID(bytes=row["id"])),
            "seq": row["seq"],
            "role": row["role"],
            "content": row["content"],
            "reasoning": row["reasoning"],
            "tools": self._decode_tools(row["tools_json"]),
            "created_at": row["created_at"].isoformat(),
        } for row in rows]
        attachments = self._attachments_for_messages([UUID(bytes=row["id"]) for row in rows])
        for message in messages:
            items = attachments.get(message["id"])
            if items:
                message["attachments"] = items
        return messages

    def _attachments_for_messages(self, message_ids: list[UUID]) -> dict[str, list[dict]]:
        if not message_ids:
            return {}
        placeholders = ", ".join(["%s"] * len(message_ids))
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"SELECT id, message_id, filename, mime_type, size_bytes "
                    f"FROM chat_attachments WHERE message_id IN ({placeholders}) "
                    f"ORDER BY created_at",
                    tuple(item.bytes for item in message_ids),
                )
                rows = cursor.fetchall()
        grouped: dict[str, list[dict]] = {}
        for row in rows:
            key = str(UUID(bytes=row["message_id"]))
            grouped.setdefault(key, []).append({
                "id": str(UUID(bytes=row["id"])),
                "name": row["filename"],
                "mimeType": row["mime_type"],
                "size": row["size_bytes"],
            })
        return grouped

    @staticmethod
    def _decode_tools(tools_json) -> list | None:
        if not tools_json:
            return None
        try:
            if isinstance(tools_json, (bytes, str)):
                return json.loads(tools_json)
            return tools_json
        except (TypeError, ValueError):
            return None

    def update_message(self, message_id: UUID, content: str, reasoning: str | None = None,
                       tools: list[dict] | None = None) -> None:
        self._ensure_tools_column()
        tools_json = json.dumps(tools, ensure_ascii=False) if tools else None
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE chat_messages SET content = %s, reasoning = %s, tools_json = %s "
                    "WHERE id = %s",
                    (content, reasoning, tools_json, message_id.bytes),
                )
            connection.commit()

    def append_message(self, session_id: UUID, role: str, content: str,
                       reasoning: str | None = None,
                       attachments: list[UUID] | None = None,
                       user_id: UUID | None = None) -> dict:
        message_id = uuid4()
        now = self._now()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM chat_messages WHERE session_id = %s",
                    (session_id.bytes,),
                )
                next_seq = cursor.fetchone()["next_seq"]
                cursor.execute(
                    "INSERT INTO chat_messages(id, session_id, seq, role, content, reasoning, created_at) "
                    "VALUES(%s, %s, %s, %s, %s, %s, %s)",
                    (message_id.bytes, session_id.bytes, next_seq, role, content, reasoning, now),
                )
                if attachments and user_id is not None:
                    placeholders = ", ".join(["%s"] * len(attachments))
                    cursor.execute(
                        f"UPDATE chat_attachments SET session_id = %s, message_id = %s "
                        f"WHERE id IN ({placeholders}) AND user_id = %s AND message_id IS NULL",
                        (session_id.bytes, message_id.bytes,
                         *[item.bytes for item in attachments], user_id.bytes),
                    )
                cursor.execute("UPDATE chat_sessions SET updated_at = %s WHERE id = %s",
                               (now, session_id.bytes))
            connection.commit()
        return {"id": str(message_id), "seq": next_seq, "role": role, "content": content,
                "reasoning": reasoning, "created_at": now.isoformat()}

    def rename_session(self, session_id: UUID, user_id: UUID, title: str) -> dict | None:
        clean = title.strip().replace("\n", " ")[:SESSION_TITLE_MAX_LENGTH] or DEFAULT_SESSION_TITLE
        now = self._now()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                affected = cursor.execute(
                    "UPDATE chat_sessions SET title = %s, updated_at = %s WHERE id = %s AND user_id = %s",
                    (clean, now, session_id.bytes, user_id.bytes),
                )
            connection.commit()
        if not affected:
            return None
        row = self.get_session(session_id, user_id)
        return row

    def auto_title(self, session_id: UUID, content: str) -> None:
        title = content.strip().replace("\n", " ")[:SESSION_TITLE_MAX_LENGTH] or DEFAULT_SESSION_TITLE
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE chat_sessions SET title = %s WHERE id = %s AND title = %s",
                    (title, session_id.bytes, DEFAULT_SESSION_TITLE),
                )
            connection.commit()
