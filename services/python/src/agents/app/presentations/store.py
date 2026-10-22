from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta

_UTC8 = timezone(timedelta(hours=8))
from uuid import UUID, uuid4

from app.config import Settings
from app.presentations.models import PresentationRequest
from app.storage.platform_db import platform_connect


class PresentationStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._initialized = False

    def available(self) -> bool:
        return bool(self.settings.platform_db_url)

    def ensure_schema(self) -> None:
        if self._initialized or not self.available():
            return
        sql = """
        CREATE TABLE IF NOT EXISTS presentation_tasks (
          id BINARY(16) PRIMARY KEY,
          user_id BINARY(16) NOT NULL,
          title VARCHAR(120) NOT NULL,
          status VARCHAR(24) NOT NULL,
          progress INT NOT NULL DEFAULT 0,
          stage_message VARCHAR(255) NOT NULL,
          request_json JSON NOT NULL,
          outline_json JSON NULL,
          events_json JSON NULL,
          resume_enabled TINYINT(1) NOT NULL DEFAULT 0,
          checkpoint_stage VARCHAR(48) NULL,
          checkpoint_json JSON NULL,
          learned_json JSON NULL,
          output_path VARCHAR(500) NULL,
          error_message TEXT NULL,
          created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
          updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          INDEX idx_presentation_tasks_user_created (user_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql)
                cursor.execute("SHOW COLUMNS FROM presentation_tasks LIKE 'events_json'")
                if cursor.fetchone() is None:
                    cursor.execute("ALTER TABLE presentation_tasks ADD COLUMN events_json JSON NULL AFTER outline_json")
                cursor.execute("SHOW COLUMNS FROM presentation_tasks LIKE 'learned_json'")
                if cursor.fetchone() is None:
                    cursor.execute("ALTER TABLE presentation_tasks ADD COLUMN learned_json JSON NULL AFTER events_json")
                cursor.execute("SHOW COLUMNS FROM presentation_tasks LIKE 'is_public'")
                if cursor.fetchone() is None:
                    cursor.execute("ALTER TABLE presentation_tasks ADD COLUMN is_public TINYINT(1) NOT NULL DEFAULT 0")
                cursor.execute("SHOW COLUMNS FROM presentation_tasks LIKE 'resource_scope'")
                if cursor.fetchone() is None:
                    cursor.execute("ALTER TABLE presentation_tasks ADD COLUMN resource_scope VARCHAR(24) NOT NULL DEFAULT 'USER'")
                cursor.execute("SHOW COLUMNS FROM presentation_tasks LIKE 'archived_at'")
                if cursor.fetchone() is None:
                    cursor.execute("ALTER TABLE presentation_tasks ADD COLUMN archived_at DATETIME(6) NULL")
                for column, ddl in (
                    ("organization_id", "ALTER TABLE presentation_tasks ADD COLUMN organization_id BINARY(16) NULL"),
                    ("domain_code", "ALTER TABLE presentation_tasks ADD COLUMN domain_code VARCHAR(80) NULL"),
                    ("category_node_code", "ALTER TABLE presentation_tasks ADD COLUMN category_node_code VARCHAR(120) NULL"),
                    ("review_status", "ALTER TABLE presentation_tasks ADD COLUMN review_status VARCHAR(24) NOT NULL DEFAULT 'PUBLISHED'"),
                    ("resource_group", "ALTER TABLE presentation_tasks ADD COLUMN resource_group VARCHAR(120) NULL"),
                    ("resume_enabled", "ALTER TABLE presentation_tasks ADD COLUMN resume_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER events_json"),
                    ("checkpoint_stage", "ALTER TABLE presentation_tasks ADD COLUMN checkpoint_stage VARCHAR(48) NULL AFTER resume_enabled"),
                    ("checkpoint_json", "ALTER TABLE presentation_tasks ADD COLUMN checkpoint_json JSON NULL AFTER checkpoint_stage"),
                ):
                    cursor.execute("SHOW COLUMNS FROM presentation_tasks LIKE %s", (column,))
                    if cursor.fetchone() is None:
                        cursor.execute(ddl)
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS presentation_task_user_state (
                      task_id BINARY(16) NOT NULL,
                      user_id BINARY(16) NOT NULL,
                      learned_json JSON NULL,
                      updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
                      PRIMARY KEY (task_id, user_id)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                """)
            connection.commit()
        self._initialized = True

    @staticmethod
    def _loads(value, fallback):
        if value is None:
            return fallback
        if isinstance(value, (dict, list)):
            return value
        try:
            return json.loads(value)
        except (TypeError, json.JSONDecodeError):
            return fallback

    @staticmethod
    def _serialize(row: dict, *, summary: bool = False) -> dict:
        task_id = UUID(bytes=row["id"])
        base: dict = {
            "id": str(task_id), "title": row["title"], "status": row["status"],
            "progress": row["progress"], "stageMessage": row["stage_message"],
            "checkpointStage": row.get("checkpoint_stage") if "checkpoint_stage" in row else None,
            "errorMessage": row.get("error_message"),
            "downloadUrl": f"/v1/presentations/{task_id}/download" if row["status"] == "completed" else None,
            "outputPath": row.get("output_path") or "",
            "learned": PresentationStore._loads(row.get("learned_json"), {}).get("learned", False),
            "learnedMeta": PresentationStore._loads(row.get("learned_json"), {}),
            "createdAt": row["created_at"].isoformat(), "updatedAt": row["updated_at"].isoformat(),
        }
        if summary:
            if row.get("request_json") is not None:
                request_data = PresentationStore._loads(row.get("request_json"), {})
                # 列表只需少量管理端上下文：避免完整 request/generationContext 随列表下发（曾拖慢工作台轮询）
                if isinstance(request_data, dict) and isinstance(request_data.get("generationContext"), dict):
                    ctx = request_data["generationContext"]
                    base["request"] = {"generationContext": {
                        k: ctx.get(k) for k in (
                            "adminGeneration", "topicName", "domainCode", "nodeCode", "kpId",
                            "groupName", "queueSequence", "batchId",
                        )}
                    }
            return base
        request_data = row.get("request_json")
        outline_data = row.get("outline_json")
        events_data = row.get("events_json")
        if isinstance(request_data, str):
            request_data = json.loads(request_data)
        if isinstance(outline_data, str):
            outline_data = json.loads(outline_data)
        if isinstance(events_data, str):
            events_data = json.loads(events_data)
        base["request"] = request_data or {}
        base["outline"] = outline_data
        base["events"] = events_data if isinstance(events_data, list) else []
        return base

    def create(self, user_id: UUID, request: PresentationRequest) -> dict:
        self.ensure_schema()
        task_id = uuid4()
        title = request.title or request.requirement.strip().splitlines()[0][:80]
        payload = request.model_dump(mode="json", by_alias=True)
        admin_context = (request.generation_context or {}) if isinstance(request.generation_context, dict) else {}
        is_admin_generation = admin_context.get("adminGeneration") is True
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                organization_id = None
                if is_admin_generation:
                    # PyMySQL may encode BINARY(16) byte parameters through the
                    # connection charset, making an otherwise identical UUID
                    # fail equality comparison.  Compare the canonical hex
                    # value for identity lookups instead.
                    cursor.execute(
                        "SELECT organization_id,account_type FROM users WHERE HEX(id)=%s",
                        (user_id.hex.upper(),),
                    )
                    user = cursor.fetchone()
                    if not user or str(user.get("account_type") or "").upper() != "ADMIN" or not user.get("organization_id"):
                        raise PermissionError("Only organization administrators can create shared presentations")
                    if not str(admin_context.get("domainCode") or "").strip() or not str(admin_context.get("nodeCode") or "").strip():
                        raise ValueError("Administrator generation requires a domain and knowledge point")
                    organization_id = user["organization_id"]
                    from app.services.resource_group import resolve_resource_group
                    resolved_group = resolve_resource_group(
                        self.settings,
                        str(admin_context.get("domainCode") or ""), str(admin_context.get("nodeCode") or ""),
                        str(admin_context.get("groupName") or ""),
                    )
                    admin_context["groupName"] = resolved_group
                    if isinstance(payload.get("generationContext"), dict):
                        payload["generationContext"]["groupName"] = resolved_group
                cursor.execute(
                    "INSERT INTO presentation_tasks (id,user_id,organization_id,domain_code,category_node_code,resource_group,resource_scope,review_status,title,status,progress,stage_message,request_json,events_json,resume_enabled) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'queued',0,%s,%s,%s,%s)",
                    (
                        task_id.bytes, user_id.bytes, organization_id,
                        str(admin_context.get("domainCode") or "").strip() or None,
                        str(admin_context.get("nodeCode") or "").strip() or None,
                        str(admin_context.get("groupName") or "默认分组"),
                        "ORGANIZATION" if is_admin_generation else "USER",
                        "DRAFT" if is_admin_generation else None,
                        title, "等待 PPT Agent 分析",
                        json.dumps(payload, ensure_ascii=False),
                        json.dumps([{
                            "time": datetime.now(_UTC8).isoformat(timespec="seconds"),
                            "phase": "queued", "title": "任务已创建",
                            "detail": "等待 PPT Agent 开始分析需求",
                        }], ensure_ascii=False),
                        int(is_admin_generation),
                    ),
                )
            connection.commit()
        return self.get(task_id, user_id)

    def save_checkpoint(self, task_id: UUID, stage: str, payload: dict | None = None) -> bool:
        """Persist the latest PPT resume milestone without clearing events."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                saved = cursor.execute(
                    "UPDATE presentation_tasks SET checkpoint_stage=%s,checkpoint_json=%s,updated_at=NOW(6) WHERE id=%s",
                    (stage[:48], json.dumps(payload or {}, ensure_ascii=False, default=str), task_id.bytes),
                )
            connection.commit()
        return saved > 0

    def load_checkpoint(self, task_id: UUID) -> dict | None:
        """Return the PPT task resume state."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT resume_enabled,checkpoint_stage,checkpoint_json,output_path,outline_json "
                    "FROM presentation_tasks WHERE id=%s",
                    (task_id.bytes,),
                )
                row = cursor.fetchone()
        if not row:
            return None
        payload = PresentationStore._loads(row.get("checkpoint_json"), {})
        if not isinstance(payload, dict):
            payload = {}
        return {
            "resumeEnabled": bool(row.get("resume_enabled")),
            "stage": row.get("checkpoint_stage") or "created",
            "outputPath": row.get("output_path"),
            "outline": row.get("outline_json"),
            "payload": payload,
        }

    def mark_orphaned_recoverable(self) -> int:
        """Queue resume-enabled PPT tasks that lost their asyncio worker."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                affected = cursor.execute(
                    "UPDATE presentation_tasks SET status='queued',progress=0,"
                    "stage_message='服务恢复，等待从断点继续生成',error_message=NULL,updated_at=NOW(6) "
                    "WHERE resume_enabled=1 AND status IN ('analyzing','outline_review','generating','reviewing')"
                )
            connection.commit()
        return affected

    def get(self, task_id: UUID, user_id: UUID) -> dict | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM presentation_tasks WHERE id=%s AND archived_at IS NULL AND "
                    "((user_id=%s AND resource_scope IN ('USER','ORGANIZATION')) OR "
                    "(resource_scope='USER' AND is_public=1) OR "
                    "(resource_scope='ORGANIZATION' AND organization_id=(SELECT organization_id FROM users WHERE HEX(id)=%s)))",
                    (task_id.bytes, user_id.bytes, user_id.hex.upper()),
                )
                row = cursor.fetchone()
                if row is not None and not self._is_owner(row, user_id) and (row.get("is_public") or self._is_org_shared(row, user_id)):
                    row = dict(row)
                    row["learned_json"] = json.dumps(
                        self._user_learned(cursor, task_id, user_id), ensure_ascii=False,
                    )
        return self._serialize(row) if row else None

    @staticmethod
    def _is_owner(row: dict, user_id: UUID) -> bool:
        owner = row.get("user_id")
        return owner is not None and owner == user_id.bytes

    @staticmethod
    def _is_org_shared(row: dict, user_id: UUID) -> bool:
        """Organization-scope presentations are visible to every user in the org."""
        return (not PresentationStore._is_owner(row, user_id)
                and row.get("resource_scope") == "ORGANIZATION")

    @staticmethod
    def _user_learned(cursor, task_id: UUID, user_id: UUID) -> dict:
        cursor.execute(
            "SELECT learned_json FROM presentation_task_user_state WHERE task_id=%s AND user_id=%s",
            (task_id.bytes, user_id.bytes),
        )
        state_row = cursor.fetchone()
        if state_row is None or state_row.get("learned_json") is None:
            return {}
        try:
            parsed = json.loads(state_row["learned_json"])
        except (TypeError, json.JSONDecodeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}

    @staticmethod
    def _save_user_learned(cursor, task_id: UUID, user_id: UUID, learned: dict) -> None:
        cursor.execute(
            "INSERT INTO presentation_task_user_state (task_id, user_id, learned_json) "
            "VALUES (%s,%s,%s) "
            "ON DUPLICATE KEY UPDATE learned_json=VALUES(learned_json)",
            (task_id.bytes, user_id.bytes, json.dumps(learned, ensure_ascii=False)),
        )

    def get_internal(self, task_id: UUID) -> dict | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT * FROM presentation_tasks WHERE id=%s", (task_id.bytes,))
                return cursor.fetchone()

    def mark_learned(self, task_id: UUID, user_id: UUID) -> bool:
        self.ensure_schema()
        now = datetime.now(_UTC8)
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT user_id, is_public, resource_scope, status, learned_json FROM presentation_tasks "
                    "WHERE id=%s AND ((user_id=%s AND resource_scope IN ('USER','ORGANIZATION')) OR "
                    "(resource_scope='USER' AND is_public=1) OR "
                    "(resource_scope='ORGANIZATION' AND organization_id=(SELECT organization_id FROM users WHERE HEX(id)=%s)))",
                    (task_id.bytes, user_id.bytes, user_id.hex.upper()),
                )
                owner = cursor.fetchone()
                if owner is None or owner.get("status") != "completed":
                    return False
                if (owner.get("is_public") or self._is_org_shared(owner, user_id)) and not self._is_owner(owner, user_id):
                    current = self._user_learned(cursor, task_id, user_id)
                    current["learned"] = True
                    current.setdefault("learnedAt", now.isoformat())
                    self._save_user_learned(cursor, task_id, user_id, current)
                else:
                    current = self._loads(owner.get("learned_json"), {})
                    if not isinstance(current, dict):
                        current = {}
                    current["learned"] = True
                    current.setdefault("learnedAt", now.isoformat())
                    current["mastery"] = max(float(current.get("mastery") or 0), 1.0)
                    current["updatedAt"] = now.isoformat()
                    affected = cursor.execute(
                        "UPDATE presentation_tasks SET learned_json=%s,updated_at=%s "
                        "WHERE id=%s AND user_id=%s AND status='completed'",
                        (json.dumps(current, ensure_ascii=False), now, task_id.bytes, user_id.bytes),
                    )
                    if not affected:
                        return False
            connection.commit()
        return True

    def update_learning(
        self, task_id: UUID, user_id: UUID, *,
        page_index: int | None = None, page_count: int | None = None,
        learned: bool | None = None, mastery: float | None = None,
    ) -> dict | None:
        """更新 PPT 学习进度：翻页进度 / 完成标记 / 掌握程度（公共任务按用户隔离存储）。"""
        self.ensure_schema()
        now = datetime.now(_UTC8)
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT user_id, is_public, resource_scope, status, learned_json FROM presentation_tasks "
                    "WHERE id=%s AND ((user_id=%s AND resource_scope IN ('USER','ORGANIZATION')) OR "
                    "(resource_scope='USER' AND is_public=1) OR "
                    "(resource_scope='ORGANIZATION' AND organization_id=(SELECT organization_id FROM users WHERE HEX(id)=%s)))",
                    (task_id.bytes, user_id.bytes, user_id.hex.upper()),
                )
                row = cursor.fetchone()
                if row is None or row.get("status") != "completed":
                    return None
                public_shared = (row.get("is_public") or self._is_org_shared(row, user_id)) and not self._is_owner(row, user_id)
                current = self._loads(row.get("learned_json"), {})
                if public_shared:
                    current = self._user_learned(cursor, task_id, user_id)
                if not isinstance(current, dict):
                    current = {}
                if page_index is not None:
                    current["maxPageViewed"] = max(
                        int(current.get("maxPageViewed") or 0), int(page_index) + 1,
                    )
                if page_count is not None:
                    current["pageCount"] = int(page_count)
                if learned is not None:
                    current["learned"] = bool(learned)
                    if learned:
                        current.setdefault("learnedAt", now.isoformat())
                if mastery is not None:
                    current["mastery"] = max(
                        float(current.get("mastery") or 0),
                        0.0,
                        min(1.0, float(mastery)),
                    )
                current["updatedAt"] = now.isoformat()
                if public_shared:
                    self._save_user_learned(cursor, task_id, user_id, current)
                else:
                    cursor.execute(
                        "UPDATE presentation_tasks SET learned_json=%s,updated_at=%s "
                        "WHERE id=%s AND user_id=%s",
                        (
                            json.dumps(current, ensure_ascii=False), now,
                            task_id.bytes, user_id.bytes,
                        ),
                    )
            connection.commit()
        return self.get(task_id, user_id)

    def output_for(self, task_id: UUID, user_id: UUID) -> str | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT output_path FROM presentation_tasks WHERE id=%s AND archived_at IS NULL AND "
                    "((user_id=%s AND resource_scope IN ('USER','ORGANIZATION')) OR "
                    "(resource_scope='USER' AND is_public=1) OR "
                    "(resource_scope='ORGANIZATION' AND organization_id=(SELECT organization_id FROM users WHERE HEX(id)=%s))) AND status='completed'",
                    (task_id.bytes, user_id.bytes, user_id.hex.upper()),
                )
                row = cursor.fetchone()
        return row.get("output_path") if row else None

    def list(self, user_id: UUID, limit: int = 20, *, summary: bool = False,
             exclude_course: bool = False) -> list[dict]:
        self.ensure_schema()
        columns = (
            "id,title,status,progress,stage_message,error_message,created_at,updated_at"
            + ",learned_json,user_id,is_public,resource_scope"
            + (",request_json" if exclude_course else "")
            if summary
            else "*"
        )
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"SELECT {columns} FROM presentation_tasks "
                    f"WHERE archived_at IS NULL AND ((user_id=%s AND resource_scope IN ('USER','ORGANIZATION')) "
                    f"OR (resource_scope='USER' AND is_public=1) OR "
                    f"(resource_scope='ORGANIZATION' AND organization_id=(SELECT organization_id FROM users WHERE HEX(id)=%s))) "
                    f"ORDER BY created_at DESC LIMIT %s",
                    (user_id.bytes, user_id.hex.upper(), limit),
                )
                rows = cursor.fetchall()
                shared_ids = [
                    UUID(bytes=row["id"])
                    for row in rows
                    if (row.get("is_public") or self._is_org_shared(row, user_id)) and not self._is_owner(row, user_id)
                ]
                learned_by_id: dict[str, dict] = {}
                if shared_ids:
                    placeholders = ",".join(["%s"] * len(shared_ids))
                    cursor.execute(
                        f"SELECT task_id, learned_json FROM presentation_task_user_state "
                        f"WHERE user_id=%s AND task_id IN ({placeholders})",
                        (user_id.bytes, *(item.bytes for item in shared_ids)),
                    )
                    for state_row in cursor.fetchall():
                        parsed = self._loads(state_row.get("learned_json"), {})
                        if isinstance(parsed, dict):
                            learned_by_id[str(UUID(bytes=state_row["task_id"]))] = parsed
                resolved = []
                for row in rows:
                    if (row.get("is_public") or self._is_org_shared(row, user_id)) and not self._is_owner(row, user_id):
                        row = dict(row)
                        row["learned_json"] = json.dumps(
                            learned_by_id.get(str(UUID(bytes=row["id"])), {}),
                            ensure_ascii=False,
                        )
                    resolved.append(row)
        if exclude_course and summary:
            resolved = [
                row for row in resolved
                if not self._row_has_course_context(row)
            ]
        return [self._serialize(row, summary=summary) for row in resolved]

    def list_same_name(self, user_id: UUID, title: str) -> list[dict]:
        """Return owned presentation task records replaced by a new same-title task."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id,status FROM presentation_tasks WHERE user_id=%s AND title=%s"
                    " ORDER BY created_at DESC",
                    (user_id.bytes, title[:120]),
                )
                rows = cursor.fetchall()
        return [
            {"id": str(UUID(bytes=row["id"])), "status": str(row.get("status") or "")}
            for row in rows
        ]

    def delete_same_name_except(self, user_id: UUID, title: str, keep_task_id: UUID) -> int:
        """Delete replaced task history while retaining the new task and output files."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM presentation_tasks WHERE user_id=%s AND title=%s AND id<>%s",
                    (user_id.bytes, title[:120], keep_task_id.bytes),
                )
                deleted = int(cursor.rowcount)
            connection.commit()
        return deleted

    @staticmethod
    def _row_has_course_context(row: dict) -> bool:
        raw = row.get("request_json")
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except (TypeError, json.JSONDecodeError):
                return False
        if not isinstance(raw, dict):
            return False
        context = raw.get("generationContext")
        return isinstance(context, dict) and bool(context.get("courseId"))

    def update(self, task_id: UUID, *, status: str, progress: int, stage_message: str,
               outline: dict | None = None, output_path: str | None = None,
               error_message: str | None = None, title: str | None = None) -> None:
        fields = ["status=%s", "progress=%s", "stage_message=%s"]
        values: list = [status, progress, stage_message]
        if title is not None:
            fields.append("title=%s")
            values.append(title[:120])
        if outline is not None:
            fields.append("outline_json=%s")
            values.append(json.dumps(outline, ensure_ascii=False))
        if output_path is not None:
            fields.append("output_path=%s")
            values.append(output_path)
        if error_message is not None:
            fields.append("error_message=%s")
            values.append(error_message[:2000])
        values.append(task_id.bytes)
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(f"UPDATE presentation_tasks SET {', '.join(fields)} WHERE id=%s", values)
            connection.commit()

    def set_planned_slide_count(self, task_id: UUID, slide_count: int) -> None:
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE presentation_tasks "
                    "SET request_json=JSON_SET(request_json, '$.slideCount', %s) WHERE id=%s",
                    (slide_count, task_id.bytes),
                )
            connection.commit()
    @staticmethod
    def role_for_phase(phase: str) -> tuple[str, str]:
        """PPT 生成事件的教研组角色映射（适配工作台泳道五列展示）。"""
        key = str(phase or "running").lower()
        if key in {"queued", "failed", "cancelled", "completed", "paused", "system"}:
            return "SYSTEM", "系统流程"
        if key in {"plan", "planning", "analysis", "analyz", "agenda", "outline", "curriculum"}:
            return "DIA-01", "教学策划 Agent"
        if key in {"retrieval", "retrieving", "knowledge"}:
            return "RET-02", "知识检索 Agent"
        if key in {"content", "generating", "generate", "html_generate", "style_guide", "speech", "audio", "voice", "render", "produce"}:
            return "GEN-03", "内容生成 Agent"
        if key in {"outline_review", "review", "reviewing", "html_validate", "validation", "visual", "verify"}:
            return "VER-04", "质量核验 Agent"
        if key in {"judge", "judging", "debate", "arbitration", "consensus"}:
            return "ARB-05", "发布仲裁 Agent"
        return "GEN-03", "内容生成 Agent"
    def append_event(self, task_id: UUID, phase: str, title: str,
                     detail: str = "", data: dict | None = None) -> dict | None:
        agent_id, agent_name = PresentationStore.role_for_phase(phase)
        event = {
            "time": datetime.now(_UTC8).isoformat(timespec="seconds"),
            "phase": phase, "title": title[:120], "detail": detail[:1000],
            "agent": agent_id, "agentName": agent_name, "status": phase,
            "actorType": "system" if agent_id == "SYSTEM" else "agent",
            "eventType": "task_lifecycle" if agent_id == "SYSTEM" else "agent_work",
            "snapshot": data or {},
        }
        if data:
            event["data"] = data
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT events_json FROM presentation_tasks WHERE id=%s FOR UPDATE",
                    (task_id.bytes,),
                )
                row = cursor.fetchone()
                if row is None:
                    return
                events = row.get("events_json")
                if isinstance(events, str):
                    events = json.loads(events)
                if not isinstance(events, list):
                    events = []
                event["seq"] = len(events) + 1
                events.append(event)
                cursor.execute(
                    "UPDATE presentation_tasks SET events_json=%s WHERE id=%s",
                    (json.dumps(events, ensure_ascii=False), task_id.bytes),
                )
            connection.commit()
        return event

    def attach_event_summary(self, task_id: UUID, seq: int, summary: str) -> bool:
        """Write the generated summary back into the persisted event JSON."""
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT events_json FROM presentation_tasks WHERE id=%s FOR UPDATE",
                    (task_id.bytes,),
                )
                row = cursor.fetchone()
                if row is None:
                    return False
                events = row.get("events_json")
                if isinstance(events, str):
                    events = json.loads(events)
                if not isinstance(events, list):
                    return False
                index = seq - 1
                if not 0 <= index < len(events):
                    return False
                event = dict(events[index])
                event["executionSummary"] = summary
                events[index] = event
                cursor.execute(
                    "UPDATE presentation_tasks SET events_json=%s WHERE id=%s",
                    (json.dumps(events, ensure_ascii=False), task_id.bytes),
                )
            connection.commit()
        return True

    def cancel(self, task_id: UUID, user_id: UUID) -> bool:
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE presentation_tasks SET status='cancelled', progress=100, "
                    "stage_message='生成已由用户中断' "
                    "WHERE id=%s AND user_id=%s AND status IN ('queued','analyzing','generating','reviewing')",
                    (task_id.bytes, user_id.bytes),
                )
                changed = cursor.rowcount > 0
            connection.commit()
        if changed:
            self.append_event(task_id, "cancelled", "用户中断生成", "后台任务已收到停止信号")
        return changed

    def restart(self, task_id: UUID, user_id: UUID) -> dict | None:
        """Reset a failed or cancelled presentation task for a debug rerun."""
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT status FROM presentation_tasks WHERE id=%s AND user_id=%s FOR UPDATE",
                    (task_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
                if row is None or str(row.get("status")) not in {"failed", "cancelled"}:
                    return None
        self.append_event(task_id, "queued", "任务已重新启动", "已从失败/取消状态重新启动生成")
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE presentation_tasks SET status='queued',progress=0,stage_message='任务已重新启动',"
                    "error_message=NULL,updated_at=NOW(6) WHERE id=%s AND user_id=%s",
                    (task_id.bytes, user_id.bytes),
                )
            connection.commit()
        return self.get(task_id, user_id)

    def archive_previous_for_group(
        self, domain_code: str, node_code: str, group_name: str, keep_task_id: UUID,
    ) -> int:
        """Archive previous presentations in the replacement's organization only."""
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT organization_id FROM presentation_tasks WHERE id=%s",
                    (keep_task_id.bytes,),
                )
                replacement = cursor.fetchone()
                organization_id = replacement.get("organization_id") if replacement else None
                if not organization_id:
                    return 0
                affected = cursor.execute(
                    "UPDATE presentation_tasks SET archived_at=NOW(6),archived_by=NULL,"
                    "archive_reason='重新生成替换',is_template=0,is_public=0,updated_at=NOW(6) "
                    "WHERE resource_scope='ORGANIZATION' AND organization_id=%s "
                    "AND domain_code=%s AND category_node_code=%s "
                    "AND COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.groupName')))=%s "
                    "AND archived_at IS NULL AND id<>%s",
                    (organization_id, domain_code, node_code, group_name, keep_task_id.bytes),
                )
            connection.commit()
        return int(affected)

    def delete(self, task_id: UUID, user_id: UUID) -> str | None:
        """Delete an owned terminal task and return its former output path."""
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT output_path FROM presentation_tasks "
                    "WHERE id=%s AND user_id=%s AND status IN ('completed','failed','cancelled')",
                    (task_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
                if row is None:
                    return None
                cursor.execute(
                    "DELETE FROM presentation_tasks WHERE id=%s AND user_id=%s",
                    (task_id.bytes, user_id.bytes),
                )
            connection.commit()
        return row.get("output_path") or ""

    def admin_delete_archived(self, task_id: UUID, admin_user_id: UUID) -> str | None:
        """Permanently delete one archived task in the administrator's organization."""
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT p.output_path FROM presentation_tasks p "
                    "JOIN users admin_user ON admin_user.id=%s "
                    "WHERE p.id=%s AND p.archived_at IS NOT NULL "
                    "AND p.organization_id=admin_user.organization_id FOR UPDATE",
                    (admin_user_id.bytes, task_id.bytes),
                )
                row = cursor.fetchone()
                if row is None:
                    return None
                cursor.execute("DELETE FROM presentation_tasks WHERE id=%s", (task_id.bytes,))
            connection.commit()
        return row.get("output_path") or ""

    def batch_delete(self, task_ids, user_id: UUID):
        """Delete multiple owned terminal tasks atomically.

        Returns the list of former ``output_path`` values for caller-side file cleanup.
        Raises ``ValueError`` if any task is missing, not owned by the user, or still active.
        All-or-nothing: any single failure aborts the transaction.
        """
        if not task_ids:
            return []
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                placeholders = ",".join(["%s"] * len(task_ids))
                cursor.execute(
                    f"SELECT id, output_path, status FROM presentation_tasks "
                    f"WHERE user_id=%s AND id IN ({placeholders}) FOR UPDATE",
                    [user_id.bytes, *(task_id.bytes for task_id in task_ids)],
                )
                rows = cursor.fetchall()
                found_ids = {UUID(bytes=row["id"]) for row in rows}
                missing = [str(task_id) for task_id in task_ids if task_id not in found_ids]
                if missing:
                    raise ValueError(f"任务不存在或不属于当前用户: {', '.join(missing)}")
                active = [UUID(bytes=row["id"]) for row in rows if row["status"] not in {"completed", "failed", "cancelled"}]
                if active:
                    raise ValueError(f"任务仍在进行中，无法删除: {', '.join(str(i) for i in active)}")
                cursor.execute(
                    f"DELETE FROM presentation_tasks "
                    f"WHERE user_id=%s AND id IN ({placeholders})",
                    [user_id.bytes, *(task_id.bytes for task_id in task_ids)],
                )
            connection.commit()
        return [row.get("output_path") or "" for row in rows]
