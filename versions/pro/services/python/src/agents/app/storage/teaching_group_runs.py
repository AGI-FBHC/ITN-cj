from __future__ import annotations

import json
from datetime import datetime
from uuid import UUID

from app.config import Settings
from app.domain.models import TeachingGroupRunRequest
from app.storage.platform_db import platform_connect


class TeachingGroupRunStore:
    """Persist public five-agent runs so the designed collaboration UI can replay them."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._schema_ready = False

    @staticmethod
    def _loads(value, fallback):
        if value is None:
            return fallback
        if isinstance(value, (dict, list)):
            return value
        try:
            return json.loads(value)
        except (TypeError, ValueError, json.JSONDecodeError):
            return fallback

    def ensure_schema(self) -> None:
        if self._schema_ready:
            return
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS teaching_group_runs (
                      id BINARY(16) PRIMARY KEY,
                      user_id BINARY(16) NOT NULL,
                      learner_id BINARY(16) NOT NULL,
                      knowledge_point_id VARCHAR(64) NULL,
                      mode VARCHAR(24) NOT NULL,
                      prompt VARCHAR(1000) NULL,
                      status VARCHAR(24) NOT NULL DEFAULT 'running',
                      events_json JSON NOT NULL,
                      result_json JSON NULL,
                      error_code VARCHAR(80) NULL,
                      created_at TIMESTAMP(6) NOT NULL,
                      updated_at TIMESTAMP(6) NOT NULL,
                      INDEX idx_teaching_run_user (user_id, updated_at),
                      INDEX idx_teaching_run_learner (learner_id, updated_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
            connection.commit()
        self._schema_ready = True

    def create(self, run_id: UUID, user_id: UUID, request: TeachingGroupRunRequest) -> dict:
        self.ensure_schema()
        now = datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO teaching_group_runs(id,user_id,learner_id,knowledge_point_id,mode,prompt,"
                    "status,events_json,created_at,updated_at) VALUES(%s,%s,%s,%s,%s,%s,'running',%s,%s,%s)",
                    (
                        run_id.bytes,
                        user_id.bytes,
                        request.learner_id.bytes,
                        request.knowledge_point_id,
                        request.mode,
                        request.prompt,
                        json.dumps([], ensure_ascii=False),
                        now,
                        now,
                    ),
                )
            connection.commit()
        return self.get(run_id, user_id)

    def record_event(self, run_id: UUID, user_id: UUID, event: dict) -> bool:
        self.ensure_schema()
        now = datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT events_json FROM teaching_group_runs WHERE id=%s AND user_id=%s FOR UPDATE",
                    (run_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
                if row is None:
                    return False
                events = self._loads(row.get("events_json"), [])
                events.append(event)
                event_type = str(event.get("type") or "")
                data = event.get("data") if isinstance(event.get("data"), dict) else {}
                status = "completed" if event_type == "run_completed" else "failed" if event_type == "run_failed" else "running"
                result = json.dumps(data, ensure_ascii=False) if event_type == "run_completed" else None
                error_code = str(data.get("code") or "")[:80] or None if event_type == "run_failed" else None
                cursor.execute(
                    "UPDATE teaching_group_runs SET events_json=%s,status=%s,"
                    "result_json=COALESCE(%s,result_json),error_code=COALESCE(%s,error_code),updated_at=%s "
                    "WHERE id=%s AND user_id=%s",
                    (
                        json.dumps(events, ensure_ascii=False),
                        status,
                        result,
                        error_code,
                        now,
                        run_id.bytes,
                        user_id.bytes,
                    ),
                )
            connection.commit()
        return True

    def mark_interrupted(self, run_id: UUID, user_id: UUID) -> None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE teaching_group_runs SET status='interrupted',error_code='STREAM_INTERRUPTED',updated_at=%s "
                    "WHERE id=%s AND user_id=%s AND status='running'",
                    (datetime.utcnow(), run_id.bytes, user_id.bytes),
                )
            connection.commit()

    def get(self, run_id: UUID, user_id: UUID) -> dict | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM teaching_group_runs WHERE id=%s AND user_id=%s",
                    (run_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
        return self._serialize(row, include_events=True) if row else None

    def list(self, user_id: UUID, limit: int = 30, learner_id: UUID | None = None) -> list[dict]:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                if learner_id is None:
                    cursor.execute(
                        "SELECT * FROM teaching_group_runs WHERE user_id=%s ORDER BY updated_at DESC LIMIT %s",
                        (user_id.bytes, max(1, min(limit, 100))),
                    )
                else:
                    cursor.execute(
                        "SELECT * FROM teaching_group_runs WHERE user_id=%s AND learner_id=%s "
                        "ORDER BY updated_at DESC LIMIT %s",
                        (user_id.bytes, learner_id.bytes, max(1, min(limit, 100))),
                    )
                rows = cursor.fetchall()
        return [self._serialize(row, include_events=False) for row in rows]

    def _serialize(self, row: dict, include_events: bool) -> dict:
        events = self._loads(row.get("events_json"), [])
        result = self._loads(row.get("result_json"), None)
        diagnosis = result.get("diagnosis") if isinstance(result, dict) else {}
        decision = result.get("decision") if isinstance(result, dict) else {}
        payload = {
            "id": str(UUID(bytes=row["id"])),
            "runId": str(UUID(bytes=row["id"])),
            "learnerId": str(UUID(bytes=row["learner_id"])),
            "knowledgePointId": row.get("knowledge_point_id"),
            "mode": row["mode"],
            "prompt": row.get("prompt"),
            "status": row["status"],
            "eventCount": len(events),
            "focus": str((diagnosis or {}).get("focus") or ""),
            "nextAction": str((decision or {}).get("nextAction") or ""),
            "errorCode": row.get("error_code"),
            "createdAt": row["created_at"].isoformat(),
            "updatedAt": row["updated_at"].isoformat(),
        }
        if include_events:
            payload["events"] = events
            payload["result"] = result
        return payload
