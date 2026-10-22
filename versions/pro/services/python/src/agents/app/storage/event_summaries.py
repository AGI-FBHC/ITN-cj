from __future__ import annotations

from datetime import datetime
from uuid import UUID

from app.config import Settings
from app.storage.platform_db import platform_connect


class EventSummaryStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._schema_ready = False

    def ensure_schema(self) -> None:
        if self._schema_ready:
            return
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS admin_event_summaries (
                      id BIGINT AUTO_INCREMENT PRIMARY KEY,
                      user_id BINARY(16) NOT NULL,
                      task_type VARCHAR(16) NOT NULL,
                      task_id BINARY(16) NOT NULL,
                      seq INT NOT NULL,
                      revision INT NOT NULL,
                      event_title VARCHAR(200) NOT NULL,
                      event_agent VARCHAR(120) NOT NULL,
                      summary MEDIUMTEXT NOT NULL,
                      model VARCHAR(80) NOT NULL,
                      fallback TINYINT(1) NOT NULL DEFAULT 0,
                      created_at DATETIME(6) NOT NULL,
                      UNIQUE KEY uq_admin_event_summary_revision (user_id,task_type,task_id,seq,revision),
                      INDEX idx_admin_event_summary_lookup (user_id,task_type,task_id,seq)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                """)
            connection.commit()
        self._schema_ready = True

    @staticmethod
    def _serialize(row: dict | None) -> dict | None:
        if not row:
            return None
        return {
            "id": row["id"],
            "taskType": row["task_type"],
            "taskId": str(UUID(bytes=row["task_id"])),
            "seq": row["seq"],
            "revision": row["revision"],
            "eventTitle": row["event_title"],
            "eventAgent": row["event_agent"],
            "summary": row["summary"],
            "model": row["model"],
            "fallback": bool(row["fallback"]),
            "createdAt": row["created_at"].isoformat(),
        }

    def latest(self, user_id: UUID, task_type: str, task_id: UUID, seq: int) -> dict | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM admin_event_summaries "
                    "WHERE user_id=%s AND task_type=%s AND task_id=%s AND seq=%s "
                    "ORDER BY revision DESC LIMIT 1",
                    (user_id.bytes, task_type, task_id.bytes, seq),
                )
                row = cursor.fetchone()
        return self._serialize(row)

    def list_revisions(self, user_id: UUID, task_type: str, task_id: UUID, seq: int) -> list[dict]:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM admin_event_summaries "
                    "WHERE user_id=%s AND task_type=%s AND task_id=%s AND seq=%s "
                    "ORDER BY revision",
                    (user_id.bytes, task_type, task_id.bytes, seq),
                )
                rows = cursor.fetchall()
        return [item for item in (self._serialize(row) for row in rows) if item]

    def latest_by_task(self, user_id: UUID, task_type: str, task_id: UUID) -> dict[int, dict]:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT s.* FROM admin_event_summaries s JOIN ("
                    "SELECT seq, MAX(revision) revision FROM admin_event_summaries "
                    "WHERE user_id=%s AND task_type=%s AND task_id=%s GROUP BY seq"
                    ") latest ON latest.seq=s.seq AND latest.revision=s.revision",
                    (user_id.bytes, task_type, task_id.bytes),
                )
                rows = cursor.fetchall()
        result: dict[int, dict] = {}
        for row in rows:
            item = self._serialize(row)
            if item:
                result[item["seq"]] = item
        return result

    def save_revision(
        self,
        user_id: UUID,
        task_type: str,
        task_id: UUID,
        seq: int,
        event_title: str,
        event_agent: str,
        summary: str,
        model: str,
        fallback: bool,
    ) -> dict | None:
        self.ensure_schema()
        now = datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT COALESCE(MAX(revision), 0) + 1 FROM admin_event_summaries "
                    "WHERE user_id=%s AND task_type=%s AND task_id=%s AND seq=%s",
                    (user_id.bytes, task_type, task_id.bytes, seq),
                )
                revision = int(cursor.fetchone()["COALESCE(MAX(revision), 0) + 1"])
                cursor.execute(
                    "INSERT INTO admin_event_summaries "
                    "(user_id,task_type,task_id,seq,revision,event_title,event_agent,summary,model,fallback,created_at) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (
                        user_id.bytes, task_type, task_id.bytes, seq, revision,
                        event_title[:200], event_agent[:120], summary, model, int(fallback), now,
                    ),
                )
            connection.commit()
        return self.latest(user_id, task_type, task_id, seq)
