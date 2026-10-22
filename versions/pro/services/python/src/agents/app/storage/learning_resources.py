from __future__ import annotations

import json
import re
from datetime import datetime
from uuid import UUID, uuid4

from app.config import Settings
from app.storage.platform_db import platform_connect


DEFAULT_ORGANIZATION_ID = UUID("00000000-0000-0000-0000-000000000108")


def _category_tokens(value: str) -> set[str]:
    lowered = value.lower()
    english = set(re.findall(r"[a-z][a-z0-9+.#-]*", lowered))
    compact = re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", lowered)
    semantic: set[str] = set()
    aliases = {
        "functioncall": ("functioncall", "functioncalling", "函数调用", "工具函数"),
        "toolcall": ("toolcall", "工具调用"),
        "jsonschema": ("jsonschema", "参数定义", "参数模式"),
        "parameter": ("parameter", "参数"),
        "errorhandling": ("errorhandling", "错误处理", "异常处理"),
        "workflow": ("workflow", "工作流"),
        "mcp": ("mcp", "模型上下文协议"),
        "protocol": ("protocol", "协议"),
    }
    for canonical, variants in aliases.items():
        if any(variant in compact for variant in variants):
            semantic.add(canonical)
    for keyword in ("function", "call", "agent", "tool", "json", "schema", "memory", "reflection"):
        if keyword in compact:
            semantic.add(keyword)
    chinese = "".join(re.findall(r"[\u4e00-\u9fff]", lowered))
    bigrams = {chinese[i:i + 2] for i in range(max(0, len(chinese) - 1))}
    return english | semantic | bigrams


def _category_similarity(left: str, right: str) -> float:
    left_tokens, right_tokens = _category_tokens(left), _category_tokens(right)
    if not left_tokens or not right_tokens:
        return 0.0
    shared = left_tokens & right_tokens
    semantic = {"functioncall", "toolcall", "jsonschema", "parameter", "errorhandling", "workflow", "mcp", "protocol"}
    return len(shared) / len(left_tokens | right_tokens) + 0.18 * len(shared & semantic)


class LearningResourceStore:
    """Persistent lectures and adaptive quiz sessions in platform MySQL."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._schema_ready = False

    def ensure_schema(self) -> None:
        if self._schema_ready:
            return
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS generated_learning_resources (
                      id BINARY(16) PRIMARY KEY, user_id BINARY(16) NOT NULL,
                      resource_type VARCHAR(16) NOT NULL, title VARCHAR(160) NOT NULL,
                      topic VARCHAR(500) NOT NULL, learning_goal_id BINARY(16) NULL,
                      content_json JSON NOT NULL, sources_json JSON NOT NULL,
                      state_json JSON NULL, created_at DATETIME(6) NOT NULL,
                      updated_at DATETIME(6) NOT NULL,
                      INDEX idx_learning_resource_user_type (user_id, resource_type, updated_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS learning_resource_messages (
                      id BINARY(16) PRIMARY KEY, resource_id BINARY(16) NOT NULL,
                      user_id BINARY(16) NOT NULL, role VARCHAR(16) NOT NULL,
                      content TEXT NOT NULL, created_at DATETIME(6) NOT NULL,
                      INDEX idx_resource_message (resource_id, user_id, created_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS learning_resource_source_feedback (
                      id BINARY(16) PRIMARY KEY, resource_id BINARY(16) NOT NULL,
                      user_id BINARY(16) NOT NULL, source_id VARCHAR(160) NOT NULL,
                      issue_type VARCHAR(32) NOT NULL, note VARCHAR(1000) NULL,
                      status VARCHAR(24) NOT NULL DEFAULT 'submitted',
                      created_at DATETIME(6) NOT NULL,
                      INDEX idx_resource_source_feedback (resource_id, user_id, created_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                cursor.execute("SHOW COLUMNS FROM generated_learning_resources LIKE 'context_json'")
                if cursor.fetchone() is None:
                    cursor.execute("ALTER TABLE generated_learning_resources ADD COLUMN context_json JSON NULL AFTER state_json")
                cursor.execute("SHOW COLUMNS FROM generated_learning_resources LIKE 'decision_json'")
                if cursor.fetchone() is None:
                    cursor.execute("ALTER TABLE generated_learning_resources ADD COLUMN decision_json JSON NULL AFTER context_json")
                cursor.execute("SHOW COLUMNS FROM generated_learning_resources LIKE 'course_id'")
                if cursor.fetchone() is None:
                    cursor.execute("ALTER TABLE generated_learning_resources ADD COLUMN course_id BINARY(16) NULL AFTER learning_goal_id, ADD COLUMN chapter_id BINARY(16) NULL AFTER course_id, ADD INDEX idx_learning_resource_course (course_id,chapter_id)")
                for column in ("learner_id", "kp_id", "form", "level", "version", "quiz_ids_json", "kb_refs_json"):
                    cursor.execute(f"SHOW COLUMNS FROM generated_learning_resources LIKE '{column}'")
                    if cursor.fetchone() is None:
                        column_type = "BINARY(16) NULL" if column == "learner_id" else "TEXT NULL"
                        cursor.execute(f"ALTER TABLE generated_learning_resources ADD COLUMN {column} {column_type} NULL")
                cursor.execute("SHOW COLUMNS FROM generated_learning_resources LIKE 'is_public'")
                if cursor.fetchone() is None:
                    cursor.execute("ALTER TABLE generated_learning_resources ADD COLUMN is_public TINYINT(1) NOT NULL DEFAULT 0")
                cursor.execute("SHOW COLUMNS FROM generated_learning_resources LIKE 'resource_scope'")
                if cursor.fetchone() is None:
                    cursor.execute("ALTER TABLE generated_learning_resources ADD COLUMN resource_scope VARCHAR(24) NOT NULL DEFAULT 'USER'")
                cursor.execute("SHOW COLUMNS FROM generated_learning_resources LIKE 'organization_id'")
                if cursor.fetchone() is None:
                    cursor.execute("ALTER TABLE generated_learning_resources ADD COLUMN organization_id BINARY(16) NULL")
                cursor.execute("SHOW COLUMNS FROM generated_learning_resources LIKE 'review_status'")
                if cursor.fetchone() is None:
                    cursor.execute("ALTER TABLE generated_learning_resources ADD COLUMN review_status VARCHAR(24) NOT NULL DEFAULT 'PUBLISHED'")
                cursor.execute("SHOW COLUMNS FROM generated_learning_resources LIKE 'domain_code'")
                if cursor.fetchone() is None:
                    cursor.execute("ALTER TABLE generated_learning_resources ADD COLUMN domain_code VARCHAR(80) NULL")
                cursor.execute("SHOW COLUMNS FROM generated_learning_resources LIKE 'category_node_code'")
                if cursor.fetchone() is None:
                    cursor.execute("ALTER TABLE generated_learning_resources ADD COLUMN category_node_code VARCHAR(120) NULL")
                cursor.execute("SHOW COLUMNS FROM generated_learning_resources LIKE 'resource_group'")
                if cursor.fetchone() is None:
                    cursor.execute("ALTER TABLE generated_learning_resources ADD COLUMN resource_group VARCHAR(120) NULL")
                cursor.execute("SHOW COLUMNS FROM generated_learning_resources LIKE 'archived_at'")
                if cursor.fetchone() is None:
                    cursor.execute("ALTER TABLE generated_learning_resources ADD COLUMN archived_at DATETIME(6) NULL")
                cursor.execute("SHOW COLUMNS FROM users LIKE 'organization_id'")
                if cursor.fetchone() is None:
                    cursor.execute("ALTER TABLE users ADD COLUMN organization_id BINARY(16) NULL")
                cursor.execute(
                    "UPDATE users SET organization_id=%s "
                    "WHERE organization_id IS NULL AND UPPER(COALESCE(account_type,''))='ADMIN'",
                    (DEFAULT_ORGANIZATION_ID.bytes,),
                )
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS learning_resource_user_state (
                      resource_id BINARY(16) NOT NULL,
                      user_id BINARY(16) NOT NULL,
                      state_json JSON NULL,
                      updated_at DATETIME(6) NOT NULL,
                      PRIMARY KEY (resource_id, user_id)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                # 资源分组占位：还没有资源时也能持久化保存空分组
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS admin_resource_groups (
                      id BIGINT NOT NULL AUTO_INCREMENT,
                      domain_code VARCHAR(128) NOT NULL,
                      node_code VARCHAR(128) NOT NULL,
                      group_name VARCHAR(120) NOT NULL,
                      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                      PRIMARY KEY (id),
                      UNIQUE KEY uk_admin_resource_group (domain_code, node_code, group_name)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
            connection.commit()
        self._schema_ready = True

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

    def _serialize(self, row: dict, summary: bool = False) -> dict:
        state = self._loads(row.get("state_json"), {})
        content = self._loads(row.get("content_json"), {})
        progress = state.get("progress") if isinstance(state.get("progress"), dict) else {}
        started = bool(
            state.get("learned") or state.get("completed")
            or state.get("answered")
            or progress.get("currentBlockId")
            or progress.get("visitedBlockIds")
            or progress.get("completedStepIds")
            or int(progress.get("elapsedSeconds") or 0) > 0
        )
        if state.get("learned") or state.get("completed"):
            progress_ratio = 1.0
        elif row["resource_type"] == "quiz":
            total = len(content.get("questions") or [])
            progress_ratio = min(1.0, len(state.get("answered") or []) / total) if total else 0.0
        elif row["resource_type"] == "practice":
            total = len(content.get("steps") or [])
            progress_ratio = min(1.0, len(progress.get("completedStepIds") or []) / total) if total else 0.0
        else:
            blocks = list(content.get("sections") or [])
            for chapter in content.get("chapters") or []:
                if isinstance(chapter, dict):
                    blocks.extend(chapter.get("sections") or [])
            total = len(blocks)
            progress_ratio = min(1.0, len(progress.get("visitedBlockIds") or []) / total) if total else 0.0
        # 列表摘要（未拉 content_json）时按 state 作答/访问数量估算进度，避免失真为 0
        if not content and not state.get("learned") and not state.get("completed"):
            answered = len(state.get("answered") or [])
            completed_steps = len(progress.get("completedStepIds") or [])
            visited = len(progress.get("visitedBlockIds") or [])
            progress_ratio = max(progress_ratio, min(1.0, max(answered, completed_steps, visited)))
        if started and progress_ratio <= 0:
            progress_ratio = 0.01
        mastery_ratio = 0.0
        if row["resource_type"] == "quiz":
            questions = {str(item.get("id")): item for item in content.get("questions") or [] if isinstance(item, dict)}
            difficulty_weights = {"easy": 1.0, "medium": 1.5, "hard": 2.0}
            weighted_total = weighted_correct = 0.0
            for answer in state.get("answered") or []:
                if not isinstance(answer, dict):
                    continue
                question = questions.get(str(answer.get("questionId")), {})
                weight = difficulty_weights.get(str(question.get("difficulty", "easy")).lower(), 1.0)
                weighted_total += weight
                if answer.get("correct"):
                    weighted_correct += weight
            mastery_ratio = weighted_correct / weighted_total if weighted_total else 0.0
        elif row["resource_type"] in {"lecture", "practice"}:
            assessments = state.get("selfAssessments") if isinstance(state.get("selfAssessments"), dict) else {}
            values = [max(0.0, min(1.0, float(value))) for value in assessments.values() if isinstance(value, (int, float))]
            mastery_ratio = sum(values) / len(values) if values else 0.0
        result = {
            "id": str(UUID(bytes=row["id"])), "type": row["resource_type"],
            "title": row["title"], "topic": row["topic"],
            "learningGoalId": str(UUID(bytes=row["learning_goal_id"])) if row.get("learning_goal_id") else None,
            "learnerId": str(UUID(bytes=row["learner_id"])) if row.get("learner_id") else None,
            "kpId": row.get("kp_id"), "form": row.get("form"), "level": row.get("level"),
            "version": row.get("version"),
            "quizIds": self._loads(row.get("quiz_ids_json"), []),
            "kbRefs": self._loads(row.get("kb_refs_json"), []),
            "courseId": str(UUID(bytes=row["course_id"])) if row.get("course_id") else None,
            "chapterId": str(UUID(bytes=row["chapter_id"])) if row.get("chapter_id") else None,
            "sources": self._loads(row.get("sources_json"), []),
            "createdAt": row["created_at"].isoformat(), "updatedAt": row["updated_at"].isoformat(),
            "context": self._loads(row.get("context_json"), {}),
            "decision": self._loads(row.get("decision_json"), {}),
            "learned": bool(state.get("learned") or state.get("completed")),
            "started": started,
            "progressRatio": round(progress_ratio, 4),
            "masteryRatio": round(mastery_ratio, 4),
            "learnedAt": state.get("learnedAt"),
        }
        if not summary:
            result["content"] = self._loads(row.get("content_json"), {})
            result["state"] = state
        return result

    def create(self, user_id: UUID, kind: str, payload: dict, content: dict,
               sources: list[dict], state: dict | None = None,
               context: dict | None = None, decision: dict | None = None,
               course_id: UUID | None = None, chapter_id: UUID | None = None,
               learner_id: UUID | None = None, kp_id: str | None = None,
               form: str | None = None, level: str | None = None,
               version: str | None = None, quiz_ids: list[str] | None = None,
               kb_refs: list[str] | None = None,
               task_id: UUID | None = None) -> dict:
        self.ensure_schema()
        resource_id, now = uuid4(), datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1 AS found FROM users WHERE id=%s LIMIT 1", (user_id.bytes,))
                if cursor.fetchone() is None:
                    raise ValueError(f"Resource owner does not exist: {user_id}")
                resource_group = str((context or {}).get("resourceGroup") or (payload.get("generation_context") or {}).get("groupName") or "默认分组")
                cursor.execute(
                    "INSERT INTO generated_learning_resources "
                    "(id,user_id,learner_id,kp_id,form,level,version,quiz_ids_json,kb_refs_json,resource_type,title,topic,learning_goal_id,course_id,chapter_id,content_json,sources_json,state_json,context_json,decision_json,resource_group,created_at,updated_at) "
                    "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (resource_id.bytes, user_id.bytes,
                     learner_id.bytes if learner_id else None, kp_id, form, level, version,
                     json.dumps(quiz_ids or [], ensure_ascii=False), json.dumps(kb_refs or [], ensure_ascii=False),
                     kind, payload["title"], payload["topic"],
                     payload.get("learning_goal_id").bytes if payload.get("learning_goal_id") else None,
                     course_id.bytes if course_id else None, chapter_id.bytes if chapter_id else None,
                     json.dumps(content, ensure_ascii=False), json.dumps(sources, ensure_ascii=False),
                     json.dumps(state or {}, ensure_ascii=False), json.dumps(context or {}, ensure_ascii=False),
                     json.dumps(decision or {}, ensure_ascii=False), resource_group, now, now),
                )
                if task_id is not None:
                    cursor.execute(
                        "UPDATE learning_resource_generation_tasks SET resource_id=%s,updated_at=%s "
                        "WHERE id=%s AND user_id=%s",
                        (resource_id.bytes, now, task_id.bytes, user_id.bytes),
                    )
            connection.commit()
        return self.get(resource_id, user_id)

    def promote_admin_generation(self, resource_id: UUID, user_id: UUID,
                                 domain_code: str, node_code: str) -> None:
        """Move an administrator-generated result into their organization library."""
        self.ensure_schema()
        if not domain_code.strip() or not node_code.strip():
            raise ValueError("Administrator generation requires a domain and knowledge point")
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT organization_id,account_type FROM users WHERE HEX(id)=%s FOR UPDATE",
                    (user_id.hex.upper(),),
                )
                user = cursor.fetchone()
                if not user or str(user.get("account_type") or "").upper() != "ADMIN" or not user.get("organization_id"):
                    raise PermissionError("Only organization administrators can create shared resources")
                cursor.execute(
                    "SELECT resource_type FROM generated_learning_resources "
                    "WHERE id=%s AND user_id=%s AND archived_at IS NULL FOR UPDATE",
                    (resource_id.bytes, user_id.bytes),
                )
                generated = cursor.fetchone()
                if not generated:
                    raise ValueError("Generated resource could not be added to the organization library")
                resource_type = str(generated["resource_type"])
                # The template slot is unique per organization/domain/node/type.
                # Demote the existing active template first so a replacement can
                # take the same slot without hitting the generated unique key.
                cursor.execute(
                    "UPDATE generated_learning_resources SET is_template=0,is_public=0,updated_at=NOW(6) "
                    "WHERE organization_id=%s AND resource_scope='ORGANIZATION' "
                    "AND domain_code=%s AND category_node_code=%s AND resource_type=%s "
                    "AND is_template=1 AND archived_at IS NULL AND id<>%s",
                    (user["organization_id"], domain_code.strip(), node_code.strip(),
                     resource_type, resource_id.bytes),
                )
                affected = cursor.execute(
                    "UPDATE generated_learning_resources SET organization_id=%s,resource_scope='ORGANIZATION',"
                    "review_status='DRAFT',domain_code=%s,category_node_code=%s,learner_id=NULL,"
                    "learning_goal_id=NULL,course_id=NULL,chapter_id=NULL,is_public=0,is_template=1,updated_at=NOW(6) "
                    "WHERE id=%s AND user_id=%s AND archived_at IS NULL",
                    (user["organization_id"], domain_code.strip(), node_code.strip(), resource_id.bytes, user_id.bytes),
                )
                if affected != 1:
                    raise ValueError("Generated resource could not be added to the organization library")
            connection.commit()

    def archive_previous_for_group(
        self, domain_code: str, node_code: str, group_name: str, resource_type: str, keep_resource_id: UUID,
    ) -> int:
        """Archive previous resources in the same organization as the replacement."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT organization_id FROM generated_learning_resources WHERE id=%s",
                    (keep_resource_id.bytes,),
                )
                replacement = cursor.fetchone()
                organization_id = replacement.get("organization_id") if replacement else None
                if not organization_id:
                    return 0
                affected = cursor.execute(
                    "UPDATE generated_learning_resources SET archived_at=NOW(6),"
                    "archive_reason='重新生成替换',is_template=0,is_public=0,updated_at=NOW(6) "
                    "WHERE resource_scope='ORGANIZATION' AND organization_id=%s "
                    "AND domain_code=%s AND category_node_code=%s "
                    "AND resource_type=%s AND COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(context_json,'$.resourceGroup')))=%s "
                    "AND archived_at IS NULL AND id<>%s",
                    (organization_id, domain_code, node_code, resource_type, group_name, keep_resource_id.bytes),
                )
            connection.commit()
        return int(affected)

    def get(self, resource_id: UUID, user_id: UUID) -> dict | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT resource.* FROM generated_learning_resources resource "
                    "JOIN users viewer ON viewer.id=%s "
                    "WHERE resource.id=%s AND resource.archived_at IS NULL AND ("
                    "(resource.resource_scope='USER' AND (resource.user_id=%s OR resource.is_public=1)) OR "
                    "(resource.resource_scope='ORGANIZATION' AND resource.organization_id=viewer.organization_id AND ("
                    "EXISTS (SELECT 1 FROM generated_learning_resources marker "
                    "WHERE marker.organization_id=resource.organization_id "
                    "AND BINARY marker.domain_code=BINARY resource.domain_code "
                    "AND BINARY marker.category_node_code=BINARY resource.category_node_code "
                    "AND BINARY COALESCE(marker.resource_group,'默认分组')=BINARY COALESCE(resource.resource_group,'默认分组') "
                    "AND marker.resource_scope='ORGANIZATION' AND marker.is_template=1 AND marker.archived_at IS NULL) OR "
                    "EXISTS (SELECT 1 FROM presentation_tasks marker "
                    "WHERE marker.organization_id=resource.organization_id "
                    "AND BINARY marker.domain_code=BINARY resource.domain_code "
                    "AND BINARY marker.category_node_code=BINARY resource.category_node_code "
                    "AND BINARY COALESCE(marker.resource_group,'默认分组')=BINARY COALESCE(resource.resource_group,'默认分组') "
                    "AND marker.resource_scope='ORGANIZATION' AND marker.is_template=1 AND marker.archived_at IS NULL)"
                    ")))",
                    (user_id.bytes, resource_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
                shared_template = row is not None and row.get("resource_scope") == "ORGANIZATION"
                if row is not None and (shared_template or (row.get("is_public") and not self._is_owner(row, user_id))):
                    row["state_json"] = json.dumps(self._user_state(cursor, resource_id, user_id), ensure_ascii=False)
        return self._serialize(row) if row else None

    def get_admin(self, resource_id: UUID, user_id: UUID) -> dict | None:
        """Return an admin-generated organization resource for the same admin account."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM generated_learning_resources "
                    "WHERE id=%s AND user_id=%s AND archived_at IS NULL AND resource_scope='ORGANIZATION'",
                    (resource_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
        if row is None:
            return None
        item = self._serialize(row)
        item.update({
            "scope": row["resource_scope"],
            "reviewStatus": row.get("review_status"),
            "revision": row.get("revision"),
            "domainCode": row.get("domain_code"),
            "nodeCode": row.get("category_node_code"),
            "baseResourceId": str(UUID(bytes=row["base_resource_id"])) if row.get("base_resource_id") else None,
            "template": bool(row.get("is_template")),
            "groupName": (self._loads(row.get("context_json"), {}).get("resourceGroup")),
            "archivedAt": row["archived_at"].isoformat() if row.get("archived_at") else None,
            "archiveReason": row.get("archive_reason"),
            "ownerAccount": None,
        })
        return item

    def list_admin_generation_groups(self, domain_code: str, node_code: str) -> list[dict]:
        """Return existing admin groups plus resource type statuses per group."""
        self.ensure_schema()
        groups: dict[str, set[str]] = {}
        details: dict[str, dict[str, set[str]]] = {}

        def add_status(group_name: str, resource_type: str, status: str) -> None:
            if status in {"generated", "generating"}:
                groups.setdefault(group_name, set()).add(resource_type)
            details.setdefault(group_name, {}).setdefault(resource_type, set()).add(status)

        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(context_json,'$.resourceGroup')), '默认分组') resource_group, resource_type FROM generated_learning_resources "
                    "WHERE domain_code=%s AND category_node_code=%s AND resource_scope='ORGANIZATION' "
                    "AND archived_at IS NULL",
                    (domain_code, node_code),
                )
                for row in cursor.fetchall():
                    add_status(str(row["resource_group"]), str(row["resource_type"]), "generated")
                cursor.execute(
                    "SELECT COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.groupName')), '默认分组') resource_group FROM presentation_tasks "
                    "WHERE domain_code=%s AND category_node_code=%s AND resource_scope='ORGANIZATION' "
                    "AND status='completed' AND archived_at IS NULL",
                    (domain_code, node_code),
                )
                for row in cursor.fetchall():
                    add_status(str(row["resource_group"]), "ppt", "generated")
                cursor.execute(
                    "SELECT resource_type, "
                    "JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.domainCode')) domain_code, "
                    "JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.nodeCode')) node_code, "
                    "JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.groupName')) group_name "
                    "FROM learning_resource_generation_tasks "
                    "WHERE status NOT IN ('completed','failed','cancelled')",
                )
                for row in cursor.fetchall():
                    if str(row.get("domain_code") or "") == domain_code and str(row.get("node_code") or "") == node_code:
                        add_status(str(row.get("group_name") or "默认分组"), str(row["resource_type"]), "generating")
                cursor.execute(
                    "SELECT resource_type, "
                    "JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.domainCode')) domain_code, "
                    "JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.nodeCode')) node_code, "
                    "JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.groupName')) group_name, "
                    "status "
                    "FROM learning_resource_generation_tasks "
                    "WHERE status IN ('failed','cancelled')",
                )
                for row in cursor.fetchall():
                    if str(row.get("domain_code") or "") == domain_code and str(row.get("node_code") or "") == node_code:
                        add_status(str(row.get("group_name") or "默认分组"), str(row["resource_type"]), str(row["status"]))
                cursor.execute(
                    "SELECT COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.groupName')), '默认分组') resource_group FROM presentation_tasks "
                    "WHERE domain_code=%s AND category_node_code=%s AND resource_scope='ORGANIZATION' "
                    "AND status NOT IN ('completed','failed','cancelled') AND archived_at IS NULL",
                    (domain_code, node_code),
                )
                for row in cursor.fetchall():
                    add_status(str(row["resource_group"]), "ppt", "generating")
                cursor.execute(
                    "SELECT COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.groupName')), '默认分组') resource_group, status FROM presentation_tasks "
                    "WHERE domain_code=%s AND category_node_code=%s AND resource_scope='ORGANIZATION' "
                    "AND status IN ('failed','cancelled')",
                    (domain_code, node_code),
                )
                for row in cursor.fetchall():
                    add_status(str(row["resource_group"]), "ppt", str(row["status"]))
                cursor.execute(
                    "SELECT group_name FROM admin_resource_groups "
                    "WHERE domain_code=%s AND node_code=%s ORDER BY created_at, id",
                    (domain_code, node_code),
                )
                for row in cursor.fetchall():
                    groups.setdefault(str(row["group_name"]), set())
        return [{"groupName": name, "types": sorted(types), "details": {
            resource_type: sorted(statuses) for resource_type, statuses in sorted(details.get(name, {}).items())
        }} for name, types in sorted(groups.items())]

    def create_admin_generation_group(self, domain_code: str, node_code: str, group_name: str) -> None:
        """持久化一个空分组；同名重复创建时幂等。"""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT IGNORE INTO admin_resource_groups (domain_code, node_code, group_name, created_at) "
                    "VALUES (%s, %s, %s, NOW())",
                    (domain_code, node_code, group_name),
                )
            connection.commit()

    def delete_admin_generation_group(self, domain_code: str, node_code: str, group_name: str) -> None:
        """删除空分组占位记录（分组下已有资源时由资源删除接口统一清理）。"""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM admin_resource_groups "
                    "WHERE domain_code=%s AND node_code=%s AND BINARY group_name=BINARY %s",
                    (domain_code, node_code, group_name),
                )
            connection.commit()

    def get_admin_group_resource(
        self, domain_code: str, node_code: str, group_name: str, resource_type: str,
    ) -> dict | None:
        """Return the latest unarchived resource from one administrator group."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id,title,content_json,sources_json,decision_json,context_json,updated_at "
                    "FROM generated_learning_resources WHERE domain_code=%s AND category_node_code=%s "
                    "AND resource_scope='ORGANIZATION' AND resource_type=%s AND archived_at IS NULL "
                    "AND BINARY COALESCE(resource_group,JSON_UNQUOTE(JSON_EXTRACT(context_json,'$.resourceGroup')),'默认分组')=BINARY %s "
                    "ORDER BY updated_at DESC LIMIT 1",
                    (domain_code, node_code, resource_type, group_name),
                )
                row = cursor.fetchone()
        if not row:
            return None
        return {
            "id": str(UUID(bytes=row["id"])),
            "title": row.get("title") or "",
            "content": self._loads(row.get("content_json"), {}),
            "sources": self._loads(row.get("sources_json"), []),
            "decision": self._loads(row.get("decision_json"), {}),
            "context": self._loads(row.get("context_json"), {}),
            "updatedAt": row["updated_at"].isoformat() if row.get("updated_at") else None,
        }

    @staticmethod
    def _is_owner(row: dict, user_id: UUID) -> bool:
        owner = row.get("user_id")
        return owner is not None and owner == user_id.bytes

    @staticmethod
    def _user_state(cursor, resource_id: UUID, user_id: UUID) -> dict:
        cursor.execute(
            "SELECT state_json FROM learning_resource_user_state WHERE resource_id=%s AND user_id=%s",
            (resource_id.bytes, user_id.bytes),
        )
        state_row = cursor.fetchone()
        if state_row is None or state_row.get("state_json") is None:
            return {}
        try:
            parsed = json.loads(state_row["state_json"])
        except (TypeError, json.JSONDecodeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}

    def list(self, user_id: UUID, kind: str | None = None, include_course: bool = False,
             learner_id: UUID | None = None, kp_id: str | None = None,
             form: str | None = None, level: str | None = None,
             course_id: UUID | None = None, chapter_id: UUID | None = None) -> list[dict]:
        self.ensure_schema()
        # 列表只需要摘要字段：不拉 content/sources/context/decision 大 JSON，
        # 详情由 get() 按需获取。远程 MySQL 跨公网时避免一次传输数十 MB。
        sql = (
            "SELECT id,user_id,learner_id,kp_id,form,level,version,quiz_ids_json,kb_refs_json,"
            "resource_type,title,topic,learning_goal_id,course_id,chapter_id,"
            "state_json,created_at,updated_at,is_public "
            "FROM generated_learning_resources WHERE archived_at IS NULL AND resource_scope='USER' AND (user_id=%s OR is_public=1)"
        )
        args = [user_id.bytes]
        if not include_course:
            sql += " AND course_id IS NULL"
        if kind:
            sql += " AND resource_type=%s"
            args.append(kind)
        if learner_id is not None:
            sql += " AND learner_id=%s"
            args.append(learner_id.bytes)
        if kp_id:
            sql += " AND kp_id=%s"
            args.append(kp_id)
        if form:
            sql += " AND form=%s"
            args.append(form)
        if level:
            sql += " AND level=%s"
            args.append(level)
        if course_id is not None:
            sql += " AND course_id=%s"
            args.append(course_id.bytes)
        if chapter_id is not None:
            sql += " AND chapter_id=%s"
            args.append(chapter_id.bytes)
        sql += " ORDER BY updated_at DESC"
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(sql, tuple(args)); rows = cursor.fetchall()
                # 批量读取该用户对公共资源的独立状态，避免逐行远程查询（N+1）
                shared_ids = [
                    UUID(bytes=row["id"])
                    for row in rows
                    if row.get("is_public") and not self._is_owner(row, user_id)
                ]
                state_by_id: dict[str, dict] = {}
                if shared_ids:
                    placeholders = ",".join(["%s"] * len(shared_ids))
                    cursor.execute(
                        f"SELECT resource_id, state_json FROM learning_resource_user_state "
                        f"WHERE user_id=%s AND resource_id IN ({placeholders})",
                        (user_id.bytes, *(item.bytes for item in shared_ids)),
                    )
                    for state_row in cursor.fetchall():
                        parsed = self._loads(state_row.get("state_json"), {})
                        if isinstance(parsed, dict):
                            state_by_id[str(UUID(bytes=state_row["resource_id"]))] = parsed
                resolved = []
                for row in rows:
                    if row.get("is_public") and not self._is_owner(row, user_id):
                        row = dict(row)
                        row["state_json"] = json.dumps(
                            state_by_id.get(str(UUID(bytes=row["id"])), {}),
                            ensure_ascii=False,
                        )
                    resolved.append(row)
        return [self._serialize(row, summary=True) for row in resolved]

    def batch_delete(self, resource_ids: list[UUID], user_id: UUID) -> list[str]:
        """Delete owned generated resources and their chat history atomically."""
        self.ensure_schema()
        if not resource_ids:
            return []
        placeholders = ",".join(["%s"] * len(resource_ids))
        id_bytes = [item.bytes for item in resource_ids]
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"SELECT id FROM generated_learning_resources WHERE user_id=%s AND id IN ({placeholders})",
                    (user_id.bytes, *id_bytes),
                )
                owned = [row["id"] for row in cursor.fetchall()]
                if owned:
                    owned_placeholders = ",".join(["%s"] * len(owned))
                    cursor.execute(
                        f"DELETE FROM learning_resource_messages WHERE user_id=%s AND resource_id IN ({owned_placeholders})",
                        (user_id.bytes, *owned),
                    )
                    cursor.execute(
                        f"DELETE FROM generated_learning_resources WHERE user_id=%s AND id IN ({owned_placeholders})",
                        (user_id.bytes, *owned),
                    )
            connection.commit()
        return [str(UUID(bytes=value)) for value in owned]

    @staticmethod
    def _save_user_state(cursor, resource_id: UUID, user_id: UUID, state: dict) -> None:
        cursor.execute(
            "INSERT INTO learning_resource_user_state (resource_id, user_id, state_json, updated_at) "
            "VALUES (%s,%s,%s,%s) "
            "ON DUPLICATE KEY UPDATE state_json=VALUES(state_json), updated_at=VALUES(updated_at)",
            (resource_id.bytes, user_id.bytes,
             json.dumps(state, ensure_ascii=False), datetime.utcnow()),
        )

    def _owner_of(self, resource_id: UUID) -> dict | None:
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT user_id, is_public FROM generated_learning_resources WHERE id=%s AND archived_at IS NULL AND resource_scope='USER'",
                    (resource_id.bytes,),
                )
                row = cursor.fetchone()
        return row

    def update_state(self, resource_id: UUID, user_id: UUID, state: dict) -> dict | None:
        owner = self._owner_of(resource_id)
        if owner is None:
            return None
        if owner.get("is_public") and not self._is_owner(owner, user_id):
            with platform_connect(self.settings) as connection:
                with connection.cursor() as cursor:
                    self._save_user_state(cursor, resource_id, user_id, state)
                connection.commit()
            return self.get(resource_id, user_id)
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                affected = cursor.execute(
                    "UPDATE generated_learning_resources SET state_json=%s,updated_at=%s WHERE id=%s AND user_id=%s",
                    (json.dumps(state, ensure_ascii=False), datetime.utcnow(), resource_id.bytes, user_id.bytes),
                )
            connection.commit()
        return self.get(resource_id, user_id) if affected else None

    def replace_content_and_state(self, resource_id: UUID, user_id: UUID, content: dict, state: dict) -> dict | None:
        """Replace quiz content while writing the latest adaptive answer state together."""
        self.ensure_schema()
        now = datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                affected = cursor.execute(
                    "UPDATE generated_learning_resources SET content_json=%s,state_json=%s,updated_at=%s "
                    "WHERE id=%s AND user_id=%s AND resource_scope='USER'",
                    (json.dumps(content, ensure_ascii=False), json.dumps(state, ensure_ascii=False),
                     now, resource_id.bytes, user_id.bytes),
                )
            connection.commit()
        return self.get(resource_id, user_id) if affected else None

    def update_progress(self, resource_id: UUID, user_id: UUID, progress: dict) -> dict | None:
        """Merge resumable player progress while preserving quiz/mastery state."""
        self.ensure_schema()
        now = datetime.utcnow()
        owner = self._owner_of(resource_id)
        if owner is None:
            return None
        public_shared = bool(owner.get("is_public")) and not self._is_owner(owner, user_id)
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                if public_shared:
                    row = {"state_json": json.dumps(self._user_state(cursor, resource_id, user_id), ensure_ascii=False)}
                else:
                    cursor.execute(
                        "SELECT state_json FROM generated_learning_resources "
                        "WHERE id=%s AND user_id=%s FOR UPDATE",
                        (resource_id.bytes, user_id.bytes),
                    )
                    row = cursor.fetchone()
                if row is None:
                    return None
                state = self._loads(row.get("state_json"), {})
                current = state.get("progress") if isinstance(state.get("progress"), dict) else {}
                visited = list(dict.fromkeys(
                    str(value)[:160] for value in progress.get("visited_block_ids", []) if str(value).strip()
                ))[:500]
                completed_steps = list(dict.fromkeys(
                    str(value)[:160] for value in progress.get("completed_step_ids", []) if str(value).strip()
                ))[:200]
                state["progress"] = {
                    **current,
                    "currentBlockId": progress.get("current_block_id"),
                    "visitedBlockIds": visited,
                    "completedStepIds": completed_steps,
                    "elapsedSeconds": max(
                        int(current.get("elapsedSeconds") or 0),
                        int(progress.get("elapsed_seconds") or 0),
                    ),
                    "lastOpenedAt": now.isoformat(),
                }
                assessments = progress.get("self_assessments") or {}
                if assessments:
                    current_assessments = state.get("selfAssessments") if isinstance(state.get("selfAssessments"), dict) else {}
                    for block_id, value in assessments.items():
                        clean_id = str(block_id).strip()[:160]
                        if clean_id:
                            current_assessments[clean_id] = round(max(0.0, min(1.0, float(value))), 2)
                    state["selfAssessments"] = current_assessments
                if public_shared:
                    self._save_user_state(cursor, resource_id, user_id, state)
                else:
                    cursor.execute(
                        "UPDATE generated_learning_resources SET state_json=%s,updated_at=%s "
                        "WHERE id=%s AND user_id=%s",
                        (json.dumps(state, ensure_ascii=False), now, resource_id.bytes, user_id.bytes),
                    )
            connection.commit()
        return self.get(resource_id, user_id)

    def create_source_feedback(self, resource_id: UUID, user_id: UUID, payload: dict) -> dict | None:
        """Record a user citation concern only when the resource belongs to that user."""
        self.ensure_schema()
        feedback_id, now = uuid4(), datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO learning_resource_source_feedback"
                    "(id,resource_id,user_id,source_id,issue_type,note,status,created_at) "
                    "SELECT %s,id,%s,%s,%s,%s,'submitted',%s "
                    "FROM generated_learning_resources WHERE id=%s AND archived_at IS NULL AND resource_scope='USER' AND (user_id=%s OR is_public=1)",
                    (
                        feedback_id.bytes,
                        user_id.bytes,
                        str(payload.get("source_id") or "")[:160],
                        str(payload.get("issue_type") or "needs_review")[:32],
                        payload.get("note"),
                        now,
                        resource_id.bytes,
                        user_id.bytes,
                    ),
                )
                if cursor.rowcount != 1:
                    return None
            connection.commit()
        return {
            "id": str(feedback_id),
            "resourceId": str(resource_id),
            "sourceId": str(payload.get("source_id") or ""),
            "issueType": str(payload.get("issue_type") or "needs_review"),
            "note": payload.get("note"),
            "status": "submitted",
            "createdAt": now.isoformat(),
        }

    def mark_learned(self, resource_id: UUID, user_id: UUID) -> dict | None:
        self.ensure_schema()
        now = datetime.utcnow()
        owner = self._owner_of(resource_id)
        if owner is None:
            return None
        public_shared = bool(owner.get("is_public")) and not self._is_owner(owner, user_id)
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                if public_shared:
                    state = self._user_state(cursor, resource_id, user_id)
                    state["learned"] = True
                    state["learnedAt"] = now.isoformat()
                    self._save_user_state(cursor, resource_id, user_id, state)
                else:
                    cursor.execute(
                        "SELECT state_json FROM generated_learning_resources WHERE id=%s AND user_id=%s FOR UPDATE",
                        (resource_id.bytes, user_id.bytes),
                    )
                    row = cursor.fetchone()
                    if row is None:
                        return None
                    state = self._loads(row.get("state_json"), {})
                    state["learned"] = True
                    state["learnedAt"] = now.isoformat()
                    cursor.execute(
                        "UPDATE generated_learning_resources SET state_json=%s,updated_at=%s WHERE id=%s AND user_id=%s",
                        (json.dumps(state, ensure_ascii=False), now, resource_id.bytes, user_id.bytes),
                    )
            connection.commit()
        return self.get(resource_id, user_id)

    def add_message(self, resource_id: UUID, user_id: UUID, role: str, content: str) -> None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO learning_resource_messages(id,resource_id,user_id,role,content,created_at) VALUES(%s,%s,%s,%s,%s,%s)",
                    (uuid4().bytes, resource_id.bytes, user_id.bytes, role, content, datetime.utcnow()),
                )
            connection.commit()

    def messages(self, resource_id: UUID, user_id: UUID) -> list[dict]:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT role,content,created_at FROM learning_resource_messages WHERE resource_id=%s AND user_id=%s ORDER BY created_at",
                    (resource_id.bytes, user_id.bytes),
                ); rows = cursor.fetchall()
        return [{"role": r["role"], "content": r["content"], "createdAt": r["created_at"].isoformat()} for r in rows]

    def bind_knowledge_categories(self, content: dict, candidates: list[dict] | None = None) -> dict:
        """Attach real platform category ids by exact or fuzzy knowledge-point name."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                for point in content.get("knowledgePoints", []):
                    if not isinstance(point, dict) or point.get("categoryId"):
                        continue
                    name = str(point.get("name") or "").strip()
                    if not name:
                        continue
                    cursor.execute(
                        "SELECT id,name FROM knowledge_category WHERE name=%s OR name LIKE %s "
                        "ORDER BY (name=%s) DESC, CHAR_LENGTH(name) ASC LIMIT 1",
                        (name, f"%{name}%", name),
                    )
                    row = cursor.fetchone()
                    if row:
                        point["categoryId"] = int(row["id"])
                        point["categoryName"] = row["name"]
        # Models sometimes paraphrase a supplied database name. Resolve that
        # deterministically against the candidate set instead of losing the
        # category link required by learner-profile updates.
        for point in content.get("knowledgePoints", []):
            if not isinstance(point, dict) or point.get("categoryId") or not candidates:
                continue
            ranked = []
            for candidate in candidates:
                score = _category_similarity(
                    f"{point.get('name', '')} {point.get('description', '')}",
                    f"{candidate.get('name', '')} {candidate.get('description', '')}",
                )
                ranked.append((score, candidate))
            score, candidate = max(ranked, key=lambda item: item[0])
            if score >= .07:
                point["categoryId"] = int(candidate["id"])
                point["categoryName"] = candidate["name"]
        return content

    def knowledge_point_candidates(self, topic: str, limit: int = 20) -> list[dict]:
        terms = re.findall(r"[A-Za-z][A-Za-z0-9+.#-]*|[\u4e00-\u9fff]{2,6}", topic)
        terms = list(dict.fromkeys(term for term in terms if len(term) >= 2))[:8]
        if not terms:
            return []
        clauses = " OR ".join(["name LIKE %s OR full_path LIKE %s"] * len(terms))
        values = [value for term in terms for value in (f"%{term}%", f"%{term}%")]
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"SELECT kc.id,kc.name,kc.description,COALESCE(NULLIF(kc.full_path,''), "
                    "CONCAT_WS(' / ',root.name,parent.name,kc.name)) full_path "
                    "FROM knowledge_category kc "
                    "LEFT JOIN knowledge_category parent ON parent.id=kc.parent_id "
                    "LEFT JOIN knowledge_category root ON root.id=parent.parent_id "
                    f"WHERE kc.status=1 AND ({clauses.replace('name LIKE', 'kc.name LIKE').replace('full_path LIKE', 'kc.full_path LIKE')}) "
                    "ORDER BY (kc.name=%s) DESC,(kc.node_type='knowledge_point') DESC,kc.level DESC LIMIT %s",
                    (*values, topic.strip(), limit),
                )
                rows = cursor.fetchall()
        return [{"id": int(row["id"]), "name": row["name"],
                 "description": row.get("description") or "", "path": row.get("full_path") or ""}
                for row in rows]

    def match_knowledge_category(self, text: str) -> dict | None:
        candidates = self.knowledge_point_candidates(text, limit=40)
        if not candidates:
            return None
        score, candidate = max(
            ((_category_similarity(text, f"{item['name']} {item['description']} {item['path']}"), item)
             for item in candidates),
            key=lambda pair: pair[0],
        )
        if score < .05:
            return None
        return {"id": candidate["id"], "name": candidate["name"], "path": candidate["path"],
                "confidence": round(min(1.0, score), 3)}
