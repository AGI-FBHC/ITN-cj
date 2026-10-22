from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta
from uuid import UUID, uuid4

_UTC8 = timezone(timedelta(hours=8))

def _now_utc8() -> datetime:
    return datetime.now(_UTC8)

from app.config import Settings
from app.storage.platform_db import platform_connect


class ResourceGenerationTaskStore:
    """Persistent background tasks for lecture, practice and quiz generation."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._schema_ready = False

    def ensure_schema(self) -> None:
        if self._schema_ready:
            return
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS learning_resource_generation_tasks (
                      id BINARY(16) PRIMARY KEY, user_id BINARY(16) NOT NULL,
                      resource_type VARCHAR(16) NOT NULL, title VARCHAR(160) NOT NULL,
                      status VARCHAR(24) NOT NULL, progress INT NOT NULL DEFAULT 0,
                      stage_message VARCHAR(500) NOT NULL, request_json JSON NOT NULL,
                      events_json JSON NOT NULL, slides_json JSON NOT NULL DEFAULT (JSON_ARRAY()),
                      resource_id BINARY(16) NULL,
                      resume_enabled TINYINT(1) NOT NULL DEFAULT 0,
                      checkpoint_stage VARCHAR(48) NULL,
                      checkpoint_json JSON NULL,
                      error_message TEXT NULL, created_at DATETIME(6) NOT NULL,
                      updated_at DATETIME(6) NOT NULL,
                      INDEX idx_resource_task_user_status (user_id,status,updated_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                cursor.execute(
                    "SELECT COUNT(*) AS count FROM information_schema.COLUMNS "
                    "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='learning_resource_generation_tasks' "
                    "AND COLUMN_NAME='slides_json'"
                )
                if int((cursor.fetchone() or {}).get("count") or 0) == 0:
                    cursor.execute(
                        "ALTER TABLE learning_resource_generation_tasks "
                        "ADD COLUMN slides_json JSON NOT NULL DEFAULT (JSON_ARRAY()) AFTER events_json"
                    )
                for column, ddl in (
                    ("resume_enabled", "ALTER TABLE learning_resource_generation_tasks ADD COLUMN resume_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER resource_id"),
                    ("checkpoint_stage", "ALTER TABLE learning_resource_generation_tasks ADD COLUMN checkpoint_stage VARCHAR(48) NULL AFTER resume_enabled"),
                    ("checkpoint_json", "ALTER TABLE learning_resource_generation_tasks ADD COLUMN checkpoint_json JSON NULL AFTER checkpoint_stage"),
                ):
                    cursor.execute(
                        "SELECT COUNT(*) AS count FROM information_schema.COLUMNS "
                        "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='learning_resource_generation_tasks' AND COLUMN_NAME=%s",
                        (column,),
                    )
                    if int((cursor.fetchone() or {}).get("count") or 0) == 0:
                        cursor.execute(ddl)
            connection.commit()
        self._schema_ready = True

    @staticmethod
    def _loads(value, fallback):
        if isinstance(value, (dict, list)):
            return value
        try:
            return json.loads(value) if value else fallback
        except (TypeError, json.JSONDecodeError):
            return fallback

    def _serialize(self, row: dict) -> dict:
        return {
            "id": str(UUID(bytes=row["id"])), "resourceType": row["resource_type"],
            "title": row["title"], "status": row["status"], "progress": row["progress"],
            "stageMessage": row["stage_message"], "events": self._loads(row.get("events_json"), []),
            "resourceId": str(UUID(bytes=row["resource_id"])) if row.get("resource_id") else None,
            "checkpointStage": row.get("checkpoint_stage") if "checkpoint_stage" in row else None,
            "errorMessage": row.get("error_message"),
            "request": self._loads(row.get("request_json"), {}),
            "createdAt": row["created_at"].isoformat(), "updatedAt": row["updated_at"].isoformat(),
        }

    def create(self, user_id: UUID, kind: str, title: str, request: dict) -> dict:
        self.ensure_schema()
        task_id, now = uuid4(), _now_utc8()
        generation_context = request.get("generation_context") or request.get("generationContext") or {}
        resume_enabled = 1 if (
            bool(request.get("resumeEnabled"))
            or bool(request.get("resume_enabled"))
            or bool((generation_context or {}).get("resumeEnabled"))
            or bool((generation_context or {}).get("resume_enabled"))
            or bool((generation_context or {}).get("adminGeneration"))
        ) else 0
        events = [{"seq": 1, "time": now.isoformat(), "agent": "SYSTEM", "agentName": "系统流程",
                   "actorType": "system", "eventType": "task_lifecycle",
                   "status": "queued", "phase": "queued", "title": "任务已创建",
                   "detail": "等待 AI 教研组开始执行", "snapshot": {"resourceType": kind}}]
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO learning_resource_generation_tasks "
                    "(id,user_id,resource_type,title,status,progress,stage_message,request_json,events_json,resume_enabled,created_at,updated_at) "
                    "VALUES(%s,%s,%s,%s,'queued',2,%s,%s,%s,%s,%s,%s)",
                    (task_id.bytes, user_id.bytes, kind, title[:160], "等待教研组执行",
                     json.dumps(request, ensure_ascii=False, default=str), json.dumps(events, ensure_ascii=False), resume_enabled, now, now),
                )
            connection.commit()
        return self.get(task_id, user_id)

    def save_checkpoint(self, task_id: UUID, user_id: UUID, stage: str, payload: dict) -> bool:
        """Persist an internal resume milestone for AI research tasks."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                saved = cursor.execute(
                    "UPDATE learning_resource_generation_tasks "
                    "SET checkpoint_stage=%s,checkpoint_json=%s,updated_at=%s "
                    "WHERE id=%s AND user_id=%s",
                    (stage[:48], json.dumps(payload, ensure_ascii=False, default=str),
                     _now_utc8(), task_id.bytes, user_id.bytes),
                )
            connection.commit()
        return saved > 0

    def load_checkpoint(self, task_id: UUID, user_id: UUID) -> dict | None:
        """Return checkpoint metadata for a task if one exists."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT resume_enabled,checkpoint_stage,checkpoint_json "
                    "FROM learning_resource_generation_tasks WHERE id=%s AND user_id=%s",
                    (task_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
        if not row:
            return None
        payload = self._loads(row.get("checkpoint_json"), {}) if row.get("checkpoint_json") is not None else {}
        if isinstance(payload, dict):
            payload = dict(payload)
        return {
            "resumeEnabled": bool(row.get("resume_enabled")),
            "stage": row.get("checkpoint_stage") or "created",
            "payload": payload,
        }

    def create_reused(self, user_id: UUID, kind: str, title: str, request: dict,
                      resource_id: UUID) -> dict:
        """Persist a completed task when an existing resource is reused.

        The task list is the operator-facing audit trail. Returning an ad-hoc
        response without inserting a row makes the item disappear on refresh.
        """
        task = self.create(user_id, kind, title, request)
        task_id = UUID(task["id"])
        self.update(
            task_id, user_id, "completed", 100, "已复用现有资源",
            agent="orchestrator", title="复用已生成资源",
            detail="该知识点已有可用资源，本次任务已关联现有资源",
            resource_id=resource_id,
            snapshot={"resourceType": kind, "resourceId": str(resource_id), "reused": True},
        )
        return self.get(task_id, user_id)

    def get(self, task_id: UUID, user_id: UUID) -> dict | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT * FROM learning_resource_generation_tasks WHERE id=%s AND user_id=%s", (task_id.bytes, user_id.bytes))
                row = cursor.fetchone()
        return self._serialize(row) if row else None

    def stream_state(self, task_id: UUID, user_id: UUID) -> dict | None:
        """Compact state for SSE polling; avoids loading request_json/resource data."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT status,progress,stage_message,events_json "
                    "FROM learning_resource_generation_tasks WHERE id=%s AND user_id=%s",
                    (task_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
        if not row:
            return None
        return {
            "status": row["status"], "progress": row["progress"],
            "stageMessage": row["stage_message"],
            "events": self._loads(row.get("events_json"), []),
            "resourceId": str(UUID(bytes=row["resource_id"])) if row.get("resource_id") else None,
        }

    def fail_orphaned(self) -> int:
        """进程重启后将失去协程的中间任务放回持久化队列。

        Events and checkpoint are preserved so the recovery path can continue
        from the nearest persisted milestone instead of silently wiping history.
        """
        self.ensure_schema()
        now = _now_utc8()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                affected = cursor.execute(
                    "UPDATE learning_resource_generation_tasks"
                    " SET status='queued', stage_message='服务恢复，等待从断点继续生成',"
                    " error_message=NULL, updated_at=%s"
                    " WHERE resume_enabled=1 AND status NOT IN ('queued','completed','failed','cancelled')",
                    (now,),
                )
            connection.commit()
        return affected

    def cancel(self, task_id: UUID, user_id: UUID) -> dict | None:
        """用户主动取消生成任务；已结束的任务不允许取消。"""
        self.ensure_schema()
        now = _now_utc8()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                affected = cursor.execute(
                    "UPDATE learning_resource_generation_tasks"
                    " SET status='cancelled', progress=100, stage_message='任务已取消', updated_at=%s"
                    " WHERE id=%s AND user_id=%s AND status NOT IN ('completed','failed','cancelled')",
                    (now, task_id.bytes, user_id.bytes),
                )
            connection.commit()
        return self.get(task_id, user_id) if affected else None

    def request(self, task_id: UUID, user_id: UUID) -> dict | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT request_json FROM learning_resource_generation_tasks WHERE id=%s AND user_id=%s", (task_id.bytes, user_id.bytes))
                row = cursor.fetchone()
        return self._loads(row.get("request_json"), {}) if row else None

    def save_slides(self, task_id: UUID, user_id: UUID, slides: list[dict]) -> bool:
        """Atomically replace the cards already available for a generation task."""
        self.ensure_schema()
        now = _now_utc8()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE learning_resource_generation_tasks SET slides_json=%s,updated_at=%s "
                    "WHERE id=%s AND user_id=%s",
                    (json.dumps(slides, ensure_ascii=False, default=str), now,
                     task_id.bytes, user_id.bytes),
                )
                saved = cursor.rowcount > 0
            connection.commit()
        return saved

    def get_slides(self, task_id: UUID, user_id: UUID) -> list[dict] | None:
        """Return ready cards, or ``None`` when the owned task does not exist."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT slides_json FROM learning_resource_generation_tasks "
                    "WHERE id=%s AND user_id=%s",
                    (task_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        slides = self._loads(row.get("slides_json"), [])
        return slides if isinstance(slides, list) else []

    def list(self, user_id: UUID, limit: int = 30, *, summary: bool = False) -> list[dict]:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                # events_json can be very large for observable multi-Agent runs.
                # Sorting SELECT * makes MySQL carry every JSON payload through
                # the filesort and can exhaust sort memory. Sort only compact ids,
                # then load the selected rows without a JSON-heavy filesort.
                cursor.execute(
                    "SELECT id FROM learning_resource_generation_tasks"
                    " WHERE user_id=%s ORDER BY updated_at DESC LIMIT %s",
                    (user_id.bytes, limit),
                )
                ordered_ids = [row["id"] for row in cursor.fetchall()]
                if not ordered_ids:
                    return []
                placeholders = ",".join(["%s"] * len(ordered_ids))
                columns = (
                    "id,user_id,resource_type,title,status,progress,stage_message,request_json,"
                    "resource_id,error_message,created_at,updated_at"
                    if summary else "*"
                )
                cursor.execute(
                    f"SELECT {columns} FROM learning_resource_generation_tasks WHERE id IN ({placeholders})",
                    tuple(ordered_ids),
                )
                by_id = {row["id"]: row for row in cursor.fetchall()}
        return [self._serialize_summary(by_id[task_id]) if summary else self._serialize(by_id[task_id])
                for task_id in ordered_ids if task_id in by_id]

    def _serialize_summary(self, row: dict) -> dict:
        """列表页专用轻量记录；完整 events 只在打开单个任务时读取。"""
        return {
            "id": str(UUID(bytes=row["id"])), "resourceType": row["resource_type"],
            "title": row["title"], "status": row["status"], "progress": row["progress"],
            "stageMessage": row["stage_message"], "events": [],
            "resourceId": str(UUID(bytes=row["resource_id"])) if row.get("resource_id") else None,
            "errorMessage": row.get("error_message"),
            "request": self._loads(row.get("request_json"), {}),
            "createdAt": row["created_at"].isoformat(), "updatedAt": row["updated_at"].isoformat(),
        }

    def find_running(self, user_id: UUID, kind: str, title: str) -> dict | None:
        """返回同用户同类型同标题仍在进行中的任务，避免重复创建。"""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM learning_resource_generation_tasks"
                    " WHERE user_id=%s AND resource_type=%s AND title=%s"
                    " AND status NOT IN ('completed','failed','cancelled')"
                    " ORDER BY updated_at DESC LIMIT 1",
                    (user_id.bytes, kind, title[:160]),
                )
                row = cursor.fetchone()
        return self._serialize(row) if row else None

    def list_same_name(self, user_id: UUID, kind: str, title: str) -> list[dict]:
        """Return owned task records that a newly created task should replace."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id,status FROM learning_resource_generation_tasks"
                    " WHERE user_id=%s AND resource_type=%s AND title=%s"
                    " ORDER BY created_at DESC",
                    (user_id.bytes, kind, title[:160]),
                )
                rows = cursor.fetchall()
        return [
            {"id": str(UUID(bytes=row["id"])), "status": str(row.get("status") or "")}
            for row in rows
        ]

    def delete_same_name_except(
        self, user_id: UUID, kind: str, title: str, keep_task_id: UUID,
    ) -> int:
        """Delete replaced task history while retaining the new task and generated resources."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM learning_resource_generation_tasks"
                    " WHERE user_id=%s AND resource_type=%s AND title=%s AND id<>%s",
                    (user_id.bytes, kind, title[:160], keep_task_id.bytes),
                )
                deleted = int(cursor.rowcount)
            connection.commit()
        return deleted

    def update(self, task_id: UUID, user_id: UUID, status: str, progress: int, stage: str,
               *, agent: str, title: str, detail: str = "", resource_id: UUID | None = None,
               error: str | None = None, snapshot: dict | None = None) -> dict | None:
        self.ensure_schema()
        now = _now_utc8()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT events_json FROM learning_resource_generation_tasks WHERE id=%s AND user_id=%s FOR UPDATE", (task_id.bytes, user_id.bytes))
                row = cursor.fetchone()
                if not row:
                    return
                events = self._loads(row.get("events_json"), [])
                agent_id, agent_name = {
                    "planner": ("DIA-01", "教学策划 Agent"),
                    "retrieval": ("RET-02", "知识检索 Agent"),
                    "writer": ("GEN-03", "内容生成 Agent"),
                    "schema_validator": ("VER-04", "质量核验 Agent"),
                    "citation_verifier": ("VER-04", "质量核验 Agent"),
                    "reviewer": ("VER-04", "质量核验 Agent"),
                    "revision": ("GEN-03", "内容生成 Agent"),
                    "judge": ("ARB-05", "发布仲裁 Agent"),
                    "orchestrator": ("SYSTEM", "系统流程"),
                }.get(agent, (agent, agent))
                event = {
                    "seq": len(events) + 1, "time": now.isoformat(), "agent": agent_id,
                    "agentName": agent_name, "status": status, "phase": status,
                    "title": title, "detail": detail, "snapshot": snapshot or {},
                    "actorType": "system" if agent_id == "SYSTEM" else "agent",
                    "eventType": "task_lifecycle" if agent_id == "SYSTEM" else "agent_work",
                }
                events.append(event)
                cursor.execute(
                    "UPDATE learning_resource_generation_tasks SET status=%s,progress=%s,stage_message=%s,events_json=%s,resource_id=%s,error_message=%s,updated_at=%s WHERE id=%s AND user_id=%s",
                    (status, max(0, min(progress, 100)), stage[:500], json.dumps(events, ensure_ascii=False),
                     resource_id.bytes if resource_id else None, error, now, task_id.bytes, user_id.bytes),
                )
                # Discard generated resource on failure — no partial results in the library
                if status == "failed" and resource_id:
                    cursor.execute(
                        "DELETE FROM generated_learning_resources WHERE id=%s",
                        (resource_id.bytes,),
                    )
            connection.commit()
        return event

    def attach_event_summary(self, task_id: UUID, user_id: UUID, seq: int, summary: str) -> bool:
        """Write the generated summary back into the persisted event JSON."""
        self.ensure_schema()
        now = _now_utc8()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT events_json FROM learning_resource_generation_tasks WHERE id=%s AND user_id=%s FOR UPDATE",
                    (task_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
                if not row:
                    return False
                events = self._loads(row.get("events_json"), [])
                index = seq - 1
                if not 0 <= index < len(events):
                    return False
                event = dict(events[index])
                event["executionSummary"] = summary
                events[index] = event
                cursor.execute(
                    "UPDATE learning_resource_generation_tasks SET events_json=%s, updated_at=%s WHERE id=%s AND user_id=%s",
                    (json.dumps(events, ensure_ascii=False), now, task_id.bytes, user_id.bytes),
                )
            connection.commit()
        return True

    def restart(self, task_id: UUID, user_id: UUID) -> dict | None:
        """Reset a failed or cancelled task to queued and rerun it later."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT status FROM learning_resource_generation_tasks WHERE id=%s AND user_id=%s FOR UPDATE",
                    (task_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
                if row is None or str(row.get("status")) not in {"failed", "cancelled"}:
                    return None
        self.update(
            task_id, user_id, "queued", 2, "任务已重新启动",
            agent="orchestrator", title="任务已重新启动",
            detail="已从失败/取消状态重新启动生成",
        )
        return self.get(task_id, user_id)

    def delete(self, task_id: UUID, user_id: UUID) -> bool:
        """永久删除任务记录（未完成任务删除时由其对应数据一并清理）。"""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM learning_resource_generation_tasks WHERE id=%s AND user_id=%s",
                    (task_id.bytes, user_id.bytes),
                )
                deleted = cursor.rowcount > 0
            connection.commit()
        return deleted
