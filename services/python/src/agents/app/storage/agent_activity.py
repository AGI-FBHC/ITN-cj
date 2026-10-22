from __future__ import annotations

import json
from datetime import datetime
from uuid import UUID, uuid4

from app.config import Settings
from app.storage.platform_db import platform_connect


class AgentActivityStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._schema_ready = False

    def ensure_schema(self) -> None:
        if self._schema_ready:
            return
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS agent_sessions (
                      id BINARY(16) PRIMARY KEY,
                      user_id BINARY(16) NOT NULL,
                      learner_id BINARY(16) NULL,
                      session_type VARCHAR(32) NOT NULL,
                      title VARCHAR(255) NULL,
                      status VARCHAR(32) NOT NULL DEFAULT 'running',
                      created_at TIMESTAMP(6) NOT NULL,
                      updated_at TIMESTAMP(6) NOT NULL,
                      INDEX idx_agent_session_user (user_id, updated_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS agent_messages (
                      id BINARY(16) PRIMARY KEY,
                      session_id BINARY(16) NOT NULL,
                      user_id BINARY(16) NOT NULL,
                      agent_id VARCHAR(64) NULL,
                      kind VARCHAR(32) NOT NULL,
                      content TEXT NOT NULL,
                      created_at TIMESTAMP(6) NOT NULL,
                      INDEX idx_agent_message_session (session_id, created_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS agent_decisions (
                      id BINARY(16) PRIMARY KEY,
                      session_id BINARY(16) NULL,
                      user_id BINARY(16) NOT NULL,
                      learner_id BINARY(16) NULL,
                      stage VARCHAR(32) NOT NULL,
                      text VARCHAR(1000) NOT NULL,
                      created_at TIMESTAMP(6) NOT NULL,
                      INDEX idx_agent_decision_user (user_id, created_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
            connection.commit()
        self._schema_ready = True

    def create_session(self, user_id: UUID, learner_id: UUID | None,
                       session_type: str, title: str | None) -> dict:
        self.ensure_schema()
        session_id, now = uuid4(), datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO agent_sessions(id,user_id,learner_id,session_type,title,status,created_at,updated_at) "
                    "VALUES(%s,%s,%s,%s,%s,'running',%s,%s)",
                    (session_id.bytes, user_id.bytes, learner_id.bytes if learner_id else None,
                     session_type, title, now, now),
                )
            connection.commit()
        return self.get_session(session_id, user_id)

    def get_session(self, session_id: UUID, user_id: UUID) -> dict | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM agent_sessions WHERE id=%s AND user_id=%s",
                    (session_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
                if not row:
                    return None
                messages = self._messages(connection, session_id)
                decisions = self._decisions(connection, session_id)
        return {
            "id": str(UUID(bytes=row["id"])),
            "learnerId": str(UUID(bytes=row["learner_id"])) if row.get("learner_id") else None,
            "sessionType": row["session_type"],
            "title": row["title"],
            "status": row["status"],
            "messages": messages,
            "decisions": decisions,
            "createdAt": row["created_at"].isoformat(),
            "updatedAt": row["updated_at"].isoformat(),
        }

    def list_sessions(self, user_id: UUID) -> list[dict]:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id FROM agent_sessions WHERE user_id=%s ORDER BY updated_at DESC LIMIT 100",
                    (user_id.bytes,),
                )
                rows = cursor.fetchall()
        return [self.get_session(UUID(bytes=row["id"]), user_id) for row in rows if row["id"]]

    def append_message(self, session_id: UUID, user_id: UUID, agent_id: str | None,
                       kind: str, content: str) -> dict:
        self.ensure_schema()
        message_id, now = uuid4(), datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO agent_messages(id,session_id,user_id,agent_id,kind,content,created_at) "
                    "VALUES(%s,%s,%s,%s,%s,%s,%s)",
                    (message_id.bytes, session_id.bytes, user_id.bytes, agent_id, kind, content, now),
                )
                cursor.execute(
                    "UPDATE agent_sessions SET updated_at=%s WHERE id=%s AND user_id=%s",
                    (now, session_id.bytes, user_id.bytes),
                )
            connection.commit()
        return self.get_session(session_id, user_id)

    def append_decision(self, session_id: UUID, user_id: UUID, learner_id: UUID | None,
                        stage: str, text: str) -> dict:
        self.ensure_schema()
        decision_id, now = uuid4(), datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO agent_decisions(id,session_id,user_id,learner_id,stage,text,created_at) "
                    "VALUES(%s,%s,%s,%s,%s,%s,%s)",
                    (decision_id.bytes, session_id.bytes, user_id.bytes, learner_id.bytes if learner_id else None,
                     stage, text, now),
                )
                cursor.execute(
                    "UPDATE agent_sessions SET updated_at=%s WHERE id=%s AND user_id=%s",
                    (now, session_id.bytes, user_id.bytes),
                )
            connection.commit()
        return self.get_session(session_id, user_id)

    def delete(self, session_id: UUID, user_id: UUID) -> bool:
        """删除会话及其消息、决策（仅归属用户）。"""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM agent_decisions WHERE session_id=%s AND user_id=%s",
                    (session_id.bytes, user_id.bytes),
                )
                cursor.execute(
                    "DELETE FROM agent_messages WHERE session_id=%s AND user_id=%s",
                    (session_id.bytes, user_id.bytes),
                )
                affected = cursor.execute(
                    "DELETE FROM agent_sessions WHERE id=%s AND user_id=%s",
                    (session_id.bytes, user_id.bytes),
                )
            connection.commit()
        return affected > 0

    def complete_session(self, session_id: UUID, user_id: UUID) -> dict | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE agent_sessions SET status='completed', updated_at=%s WHERE id=%s AND user_id=%s",
                    (datetime.utcnow(), session_id.bytes, user_id.bytes),
                )
            connection.commit()
        return self.get_session(session_id, user_id)

    def update_title(self, session_id: UUID, user_id: UUID, title: str) -> dict | None:
        self.ensure_schema()
        clean_title = " ".join(str(title or "").split()).strip()[:255]
        if not clean_title:
            return self.get_session(session_id, user_id)
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                affected = cursor.execute(
                    "UPDATE agent_sessions SET title=%s, updated_at=%s WHERE id=%s AND user_id=%s",
                    (clean_title, datetime.utcnow(), session_id.bytes, user_id.bytes),
                )
            connection.commit()
        return self.get_session(session_id, user_id) if affected else None

    def _messages(self, connection, session_id: UUID) -> list[dict]:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT id,agent_id,kind,content,created_at FROM agent_messages "
                "WHERE session_id=%s ORDER BY created_at",
                (session_id.bytes,),
            )
            return [{
                "id": str(UUID(bytes=row["id"])),
                "agentId": row["agent_id"], "kind": row["kind"], "content": row["content"],
                "createdAt": row["created_at"].isoformat(),
            } for row in cursor.fetchall()]

    def _decisions(self, connection, session_id: UUID) -> list[dict]:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT id,stage,text,created_at FROM agent_decisions "
                "WHERE session_id=%s ORDER BY created_at",
                (session_id.bytes,),
            )
            return [{
                "id": str(UUID(bytes=row["id"])), "stage": row["stage"], "text": row["text"],
                "createdAt": row["created_at"].isoformat(),
            } for row in cursor.fetchall()]
