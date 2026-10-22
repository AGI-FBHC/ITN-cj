from __future__ import annotations

import json
from datetime import datetime
from uuid import UUID, uuid4

from app.config import Settings
from app.storage.platform_db import platform_connect


class UserMemoryStore:
    """Small, typed user-memory store shared by learning and agent features."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._schema_ready = False

    def ensure_schema(self) -> None:
        if self._schema_ready:
            return
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS user_memories (
                      id BINARY(16) PRIMARY KEY,
                      user_id BINARY(16) NOT NULL,
                      learner_id BINARY(16) NULL,
                      namespace VARCHAR(32) NOT NULL,
                      memory_key VARCHAR(160) NOT NULL,
                      scope_json JSON NOT NULL,
                      scope_hash VARCHAR(64) NOT NULL,
                      value_json JSON NOT NULL,
                      summary VARCHAR(500) NOT NULL,
                      source_type VARCHAR(32) NOT NULL,
                      confidence DECIMAL(5,4) NOT NULL DEFAULT 1,
                      importance DECIMAL(5,4) NOT NULL DEFAULT .5,
                      status VARCHAR(24) NOT NULL DEFAULT 'active',
                      version INT NOT NULL DEFAULT 1,
                      expires_at DATETIME(6) NULL,
                      last_used_at DATETIME(6) NULL,
                      created_at DATETIME(6) NOT NULL,
                      updated_at DATETIME(6) NOT NULL,
                      UNIQUE KEY uk_user_memory (user_id, namespace, memory_key, scope_hash, status),
                      INDEX idx_user_memory_active (user_id, status, namespace, updated_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS user_memory_events (
                      id BINARY(16) PRIMARY KEY,
                      user_id BINARY(16) NOT NULL,
                      learner_id BINARY(16) NULL,
                      event_type VARCHAR(64) NOT NULL,
                      source_module VARCHAR(64) NOT NULL,
                      source_id VARCHAR(160) NOT NULL,
                      scope_json JSON NOT NULL,
                      payload_json JSON NOT NULL,
                      occurred_at DATETIME(6) NOT NULL,
                      created_at DATETIME(6) NOT NULL,
                      UNIQUE KEY uk_user_memory_event (user_id, source_module, source_id, event_type),
                      INDEX idx_user_memory_event (user_id, occurred_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS user_memory_usage (
                      id BINARY(16) PRIMARY KEY,
                      user_id BINARY(16) NOT NULL,
                      memory_id BINARY(16) NOT NULL,
                      scene VARCHAR(64) NOT NULL,
                      task_id VARCHAR(160) NULL,
                      created_at DATETIME(6) NOT NULL,
                      INDEX idx_user_memory_usage (user_id, created_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
            connection.commit()
        self._schema_ready = True

    @staticmethod
    def _json(value) -> str:
        return json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))

    @staticmethod
    def _loads(value, fallback):
        if isinstance(value, (dict, list)):
            return value
        try:
            return json.loads(value) if value else fallback
        except (TypeError, json.JSONDecodeError):
            return fallback

    @staticmethod
    def scope_hash(scope: dict) -> str:
        import hashlib
        normalized = json.dumps(scope or {}, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    def primary_learner_id(self, user_id: UUID) -> UUID | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id FROM learners WHERE user_id=%s AND status=1 "
                    "ORDER BY (target_job IS NOT NULL) DESC,(diagnosis_summary IS NOT NULL) DESC,updated_at DESC LIMIT 1",
                    (user_id.bytes,),
                )
                row = cursor.fetchone()
        return UUID(bytes=row["id"]) if row else None

    def append_event(self, user_id: UUID, learner_id: UUID | None, event_type: str,
                     source_module: str, source_id: str, scope: dict, payload: dict) -> bool:
        self.ensure_schema()
        now = datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                affected = cursor.execute(
                    "INSERT IGNORE INTO user_memory_events "
                    "(id,user_id,learner_id,event_type,source_module,source_id,scope_json,payload_json,occurred_at,created_at) "
                    "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (uuid4().bytes, user_id.bytes, learner_id.bytes if learner_id else None,
                     event_type, source_module, source_id, self._json(scope or {}),
                     self._json(payload or {}), now, now),
                )
            connection.commit()
        return bool(affected)

    def upsert(self, user_id: UUID, learner_id: UUID | None, namespace: str, memory_key: str,
               scope: dict, value: dict, summary: str, source_type: str,
               confidence: float = 1.0, importance: float = .5) -> dict:
        self.ensure_schema()
        now = datetime.utcnow()
        scope_digest = self.scope_hash(scope)
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id,version FROM user_memories WHERE user_id=%s AND namespace=%s "
                    "AND memory_key=%s AND scope_hash=%s AND status='active' LIMIT 1 FOR UPDATE",
                    (user_id.bytes, namespace, memory_key, scope_digest),
                )
                existing = cursor.fetchone()
                if existing:
                    memory_id = UUID(bytes=existing["id"])
                    cursor.execute(
                        "UPDATE user_memories SET learner_id=%s,value_json=%s,summary=%s,source_type=%s,"
                        "confidence=%s,importance=%s,version=%s,updated_at=%s WHERE id=%s",
                        (learner_id.bytes if learner_id else None, self._json(value), summary[:500],
                         source_type, max(0, min(1, confidence)), max(0, min(1, importance)),
                         int(existing["version"] or 1) + 1, now, memory_id.bytes),
                    )
                else:
                    memory_id = uuid4()
                    cursor.execute(
                        "INSERT INTO user_memories "
                        "(id,user_id,learner_id,namespace,memory_key,scope_json,scope_hash,value_json,summary,"
                        "source_type,confidence,importance,status,version,created_at,updated_at) "
                        "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'active',1,%s,%s)",
                        (memory_id.bytes, user_id.bytes, learner_id.bytes if learner_id else None,
                         namespace, memory_key, self._json(scope or {}), scope_digest,
                         self._json(value), summary[:500], source_type,
                         max(0, min(1, confidence)), max(0, min(1, importance)), now, now),
                    )
            connection.commit()
        return self.get(memory_id, user_id) or {}

    def has_tombstone(self, user_id: UUID, namespace: str, memory_key: str, scope: dict) -> bool:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT 1 FROM user_memories WHERE user_id=%s AND namespace=%s AND memory_key=%s "
                    "AND scope_hash=%s AND status='deleted' LIMIT 1",
                    (user_id.bytes, namespace, memory_key, self.scope_hash(scope)),
                )
                return cursor.fetchone() is not None

    def get(self, memory_id: UUID, user_id: UUID) -> dict | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT * FROM user_memories WHERE id=%s AND user_id=%s", (memory_id.bytes, user_id.bytes))
                row = cursor.fetchone()
        return self._serialize(row) if row else None

    def list(self, user_id: UUID, namespace: str | None = None) -> list[dict]:
        self.ensure_schema()
        sql = "SELECT * FROM user_memories WHERE user_id=%s AND status='active' AND (expires_at IS NULL OR expires_at>NOW())"
        args: list[object] = [user_id.bytes]
        if namespace:
            sql += " AND namespace=%s"
            args.append(namespace)
        sql += " ORDER BY importance DESC,confidence DESC,updated_at DESC"
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql, tuple(args))
                rows = cursor.fetchall()
        return [self._serialize(row) for row in rows]

    def delete(self, memory_id: UUID, user_id: UUID) -> bool:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT namespace,memory_key,scope_hash FROM user_memories "
                    "WHERE id=%s AND user_id=%s AND status='active' LIMIT 1 FOR UPDATE",
                    (memory_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
                if row is None:
                    return False
                cursor.execute(
                    "DELETE FROM user_memories WHERE user_id=%s AND namespace=%s AND memory_key=%s "
                    "AND scope_hash=%s AND status='deleted'",
                    (user_id.bytes, row["namespace"], row["memory_key"], row["scope_hash"]),
                )
                affected = cursor.execute(
                    "UPDATE user_memories SET status='deleted',updated_at=%s WHERE id=%s AND user_id=%s AND status='active'",
                    (datetime.utcnow(), memory_id.bytes, user_id.bytes),
                )
            connection.commit()
        return bool(affected)

    def record_usage(self, user_id: UUID, memory_ids: list[str], scene: str, task_id: str | None = None) -> None:
        if not memory_ids:
            return
        self.ensure_schema()
        now = datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                for value in memory_ids:
                    try:
                        memory_id = UUID(value)
                    except ValueError:
                        continue
                    cursor.execute(
                        "INSERT INTO user_memory_usage (id,user_id,memory_id,scene,task_id,created_at) VALUES(%s,%s,%s,%s,%s,%s)",
                        (uuid4().bytes, user_id.bytes, memory_id.bytes, scene, task_id, now),
                    )
                    cursor.execute("UPDATE user_memories SET last_used_at=%s WHERE id=%s AND user_id=%s", (now, memory_id.bytes, user_id.bytes))
            connection.commit()

    def _serialize(self, row: dict) -> dict:
        return {
            "id": str(UUID(bytes=row["id"])),
            "learnerId": str(UUID(bytes=row["learner_id"])) if row.get("learner_id") else None,
            "namespace": row["namespace"], "key": row["memory_key"],
            "scope": self._loads(row.get("scope_json"), {}),
            "value": self._loads(row.get("value_json"), {}), "summary": row["summary"],
            "sourceType": row["source_type"], "confidence": float(row["confidence"]),
            "importance": float(row["importance"]), "status": row["status"],
            "version": int(row["version"]),
            "lastUsedAt": row["last_used_at"].isoformat() if row.get("last_used_at") else None,
            "createdAt": row["created_at"].isoformat(), "updatedAt": row["updated_at"].isoformat(),
        }
