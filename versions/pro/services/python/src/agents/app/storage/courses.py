from __future__ import annotations

import json
from datetime import datetime
from uuid import UUID, uuid4

from app.config import Settings
from app.storage.platform_db import platform_connect


class CourseStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._schema_ready = False

    def ensure_schema(self) -> None:
        if self._schema_ready:
            return
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS generated_courses (
                      id BINARY(16) PRIMARY KEY, user_id BINARY(16) NOT NULL,
                      learner_id BINARY(16) NULL,
                      learning_goal_id BINARY(16) NULL, title VARCHAR(160) NOT NULL,
                      learning_goal_ids_json JSON NULL,
                      description TEXT NULL, prompt TEXT NOT NULL, domain_name VARCHAR(160) NULL,
                      depth VARCHAR(20) NOT NULL, scale VARCHAR(20) NOT NULL,
                      course_style VARCHAR(24) NOT NULL DEFAULT 'none',
                      resource_types_json JSON NOT NULL, status VARCHAR(24) NOT NULL,
                      progress INT NOT NULL DEFAULT 0, stage_message VARCHAR(500) NOT NULL,
                      current_chapter_id BINARY(16) NULL, events_json JSON NULL,
                      error_message TEXT NULL, created_at DATETIME(6) NOT NULL,
                      updated_at DATETIME(6) NOT NULL,
                      INDEX idx_generated_course_user (user_id, updated_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                cursor.execute("SHOW COLUMNS FROM generated_courses LIKE 'learner_id'")
                if cursor.fetchone() is None:
                    cursor.execute(
                        "ALTER TABLE generated_courses ADD COLUMN learner_id BINARY(16) NULL AFTER user_id"
                    )
                cursor.execute("SHOW INDEX FROM generated_courses WHERE Key_name='idx_generated_course_learner'")
                if cursor.fetchone() is None:
                    cursor.execute(
                        "ALTER TABLE generated_courses ADD INDEX idx_generated_course_learner "
                        "(user_id, learner_id, updated_at)"
                    )
                # Legacy rows were generated with a learner context but the relationship was
                # not persisted. Backfill only exact target matches; ambiguous rows stay NULL.
                cursor.execute(
                    "UPDATE generated_courses gc JOIN learners l ON l.user_id=gc.user_id "
                    "AND l.status=1 AND ("
                    "l.target_job COLLATE utf8mb4_unicode_ci=gc.title COLLATE utf8mb4_unicode_ci OR "
                    "l.target_job COLLATE utf8mb4_unicode_ci=gc.domain_name COLLATE utf8mb4_unicode_ci) "
                    "SET gc.learner_id=l.id WHERE gc.learner_id IS NULL"
                )
                cursor.execute("SHOW COLUMNS FROM generated_courses LIKE 'course_style'")
                if cursor.fetchone() is None:
                    cursor.execute(
                        "ALTER TABLE generated_courses ADD COLUMN course_style VARCHAR(24) "
                        "NOT NULL DEFAULT 'none' AFTER scale"
                    )
                cursor.execute(
                    "UPDATE generated_courses SET course_style='none' "
                    "WHERE course_style IN ('systematic','project','case','inquiry')"
                )
                cursor.execute("SHOW COLUMNS FROM generated_courses LIKE 'learning_goal_ids_json'")
                if cursor.fetchone() is None:
                    cursor.execute(
                        "ALTER TABLE generated_courses ADD COLUMN learning_goal_ids_json JSON NULL "
                        "AFTER learning_goal_id"
                    )
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS generated_course_chapters (
                      id BINARY(16) PRIMARY KEY, course_id BINARY(16) NOT NULL,
                      chapter_index INT NOT NULL, title VARCHAR(200) NOT NULL,
                      summary TEXT NULL, objectives_json JSON NULL,
                      sections_json JSON NULL,
                      status VARCHAR(24) NOT NULL, progress INT NOT NULL DEFAULT 0,
                      resources_json JSON NULL, created_at DATETIME(6) NOT NULL,
                      updated_at DATETIME(6) NOT NULL,
                      UNIQUE KEY uk_course_chapter_index (course_id, chapter_index),
                      INDEX idx_course_chapters (course_id, chapter_index)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                cursor.execute("SHOW COLUMNS FROM generated_course_chapters LIKE 'sections_json'")
                if cursor.fetchone() is None:
                    cursor.execute(
                        "ALTER TABLE generated_course_chapters ADD COLUMN sections_json JSON NULL "
                        "AFTER objectives_json"
                    )
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

    def _chapter(self, row: dict) -> dict:
        return {
            "id": str(UUID(bytes=row["id"])), "index": row["chapter_index"],
            "title": row["title"], "summary": row.get("summary") or "",
            "objectives": self._loads(row.get("objectives_json"), []),
            "sections": self._loads(row.get("sections_json"), []),
            "status": row["status"], "progress": row["progress"],
            "resources": self._loads(row.get("resources_json"), {}),
            "createdAt": row["created_at"].isoformat(), "updatedAt": row["updated_at"].isoformat(),
        }

    def _course(self, row: dict, chapters: list[dict] | None = None) -> dict:
        result = {
            "id": str(UUID(bytes=row["id"])), "title": row["title"],
            "learnerId": str(UUID(bytes=row["learner_id"])) if row.get("learner_id") else None,
            "description": row.get("description") or "", "prompt": row["prompt"],
            "learningGoalId": str(UUID(bytes=row["learning_goal_id"])) if row.get("learning_goal_id") else None,
            "learningGoalIds": self._loads(row.get("learning_goal_ids_json"), []),
            "domainName": row.get("domain_name") or "当前学习领域", "depth": row["depth"],
            "scale": row["scale"], "courseStyle": row.get("course_style") or "none",
            "resourceTypes": self._loads(row["resource_types_json"], []),
            "status": row["status"], "progress": row["progress"],
            "stageMessage": row["stage_message"], "errorMessage": row.get("error_message"),
            "currentChapterId": str(UUID(bytes=row["current_chapter_id"])) if row.get("current_chapter_id") else None,
            "events": self._loads(row.get("events_json"), []),
            "createdAt": row["created_at"].isoformat(), "updatedAt": row["updated_at"].isoformat(),
        }
        if chapters is not None:
            result["chapters"] = chapters
        return result

    def create(self, user_id: UUID, payload: dict, context: dict) -> dict:
        self.ensure_schema()
        course_id, now = uuid4(), datetime.utcnow()
        goal = context.get("goal") or {}
        title = str(goal.get("title") or goal.get("knowledgeDomainName") or "个性化课程")[:160]
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO generated_courses(id,user_id,learner_id,learning_goal_id,learning_goal_ids_json,title,description,prompt,domain_name,depth,scale,course_style,resource_types_json,status,progress,stage_message,events_json,created_at,updated_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'planning',3,%s,%s,%s,%s)",
                    (course_id.bytes, user_id.bytes,
                     payload.get("learner_id").bytes if payload.get("learner_id") else None,
                     payload.get("learning_goal_id").bytes if payload.get("learning_goal_id") else None,
                     json.dumps([str(item) for item in payload.get("learning_goal_ids") or []]),
                     title, goal.get("description") or "", payload["prompt"], goal.get("knowledgeDomainName") or title,
                     payload["depth"], payload["scale"], payload.get("course_style") or "none",
                     json.dumps(payload["resource_types"]),
                     "正在规划课程章节", json.dumps([{"time": now.isoformat(), "title": "开始规划课程", "detail": "已读取学习目标与个人画像"}], ensure_ascii=False), now, now),
                )
            connection.commit()
        return self.get(course_id, user_id)

    def list(self, user_id: UUID, learner_id: UUID | None = None) -> list[dict]:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                if learner_id is None:
                    cursor.execute("SELECT * FROM generated_courses WHERE user_id=%s ORDER BY updated_at DESC", (user_id.bytes,))
                else:
                    cursor.execute(
                        "SELECT * FROM generated_courses WHERE user_id=%s AND learner_id=%s "
                        "ORDER BY updated_at DESC", (user_id.bytes, learner_id.bytes),
                    )
                rows = cursor.fetchall()
                result = []
                for row in rows:
                    cursor.execute("SELECT * FROM generated_course_chapters WHERE course_id=%s ORDER BY chapter_index", (row["id"],))
                    result.append(self._course(row, [self._chapter(item) for item in cursor.fetchall()]))
        return result

    def get(self, course_id: UUID, user_id: UUID) -> dict | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT * FROM generated_courses WHERE id=%s AND user_id=%s", (course_id.bytes, user_id.bytes))
                row = cursor.fetchone()
                if not row:
                    return None
                cursor.execute("SELECT * FROM generated_course_chapters WHERE course_id=%s ORDER BY chapter_index", (course_id.bytes,))
                chapters = [self._chapter(item) for item in cursor.fetchall()]
        return self._course(row, chapters)

    def list_recoverable(self) -> list[dict]:
        """Return persisted inputs for courses left active by a process restart."""
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id,user_id,learning_goal_id,learning_goal_ids_json,prompt,depth,scale,course_style,resource_types_json "
                    "FROM generated_courses WHERE status IN ('planning','generating') "
                    "ORDER BY updated_at"
                )
                rows = cursor.fetchall()
        return [
            {
                "id": str(UUID(bytes=row["id"])),
                "userId": str(UUID(bytes=row["user_id"])),
                "learningGoalId": str(UUID(bytes=row["learning_goal_id"])) if row.get("learning_goal_id") else None,
                "learningGoalIds": self._loads(row.get("learning_goal_ids_json"), []),
                "prompt": row["prompt"], "depth": row["depth"], "scale": row["scale"],
                "courseStyle": row.get("course_style") or "none",
                "resourceTypes": self._loads(row["resource_types_json"], []),
            }
            for row in rows
        ]

    def progress(self, user_id: UUID, learner_id: UUID | None = None) -> dict | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                if learner_id is None:
                    cursor.execute(
                        "SELECT id,title,resource_types_json FROM generated_courses "
                        "WHERE user_id=%s ORDER BY updated_at DESC LIMIT 1", (user_id.bytes,),
                    )
                else:
                    cursor.execute(
                        "SELECT id,title,resource_types_json FROM generated_courses "
                        "WHERE user_id=%s AND learner_id=%s ORDER BY updated_at DESC LIMIT 1",
                        (user_id.bytes, learner_id.bytes),
                    )
                row = cursor.fetchone()
                if row is None:
                    return None
                course_id = row["id"]
                cursor.execute(
                    "SELECT resources_json FROM generated_course_chapters WHERE course_id=%s", (course_id,),
                )
                chapter_rows = cursor.fetchall()
        resource_types = self._loads(row.get("resource_types_json"), [])
        total = 0
        completed = 0
        for chapter_row in chapter_rows:
            resources = self._loads(chapter_row.get("resources_json"), {})
            for kind in resource_types:
                item = resources.get(kind)
                if not isinstance(item, dict) or item.get("status") != "completed" or not item.get("id"):
                    continue
                total += 1
                if self._resource_learned(user_id, kind, str(item["id"])):
                    completed += 1
        percent = round(completed / total * 100) if total else 0
        return {
            "courseId": str(UUID(bytes=course_id)), "courseTitle": row["title"],
            "total": total, "completed": completed, "percent": percent,
        }

    def _resource_learned(self, user_id: UUID, kind: str, resource_id: str) -> bool:
        try:
            rid = UUID(resource_id)
        except (TypeError, ValueError):
            return False
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                if kind == "ppt":
                    cursor.execute(
                        "SELECT learned_json FROM presentation_tasks WHERE id=%s AND archived_at IS NULL AND resource_scope='USER' AND (user_id=%s OR is_public=1)", (rid.bytes, user_id.bytes),
                    )
                    row = cursor.fetchone()
                    if row is not None and (row.get("user_id") != user_id.bytes):
                        cursor.execute(
                            "SELECT learned_json FROM presentation_task_user_state WHERE task_id=%s AND user_id=%s",
                            (rid.bytes, user_id.bytes),
                        )
                        user_row = cursor.fetchone()
                        learned_raw = user_row.get("learned_json") if user_row else None
                    else:
                        learned_raw = row.get("learned_json") if row else None
                    return bool(self._loads(learned_raw, {}).get("learned", False))
                cursor.execute(
                    "SELECT state_json FROM generated_learning_resources WHERE id=%s AND archived_at IS NULL AND resource_scope='USER' AND (user_id=%s OR is_public=1)", (rid.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
                if row is not None and (row.get("user_id") != user_id.bytes):
                    cursor.execute(
                        "SELECT state_json FROM learning_resource_user_state WHERE resource_id=%s AND user_id=%s",
                        (rid.bytes, user_id.bytes),
                    )
                    user_row = cursor.fetchone()
                    state_raw = user_row.get("state_json") if user_row else None
                else:
                    state_raw = row.get("state_json") if row else None
                state = self._loads(state_raw, {})
                return bool(state.get("learned")) or (kind == "quiz" and bool(state.get("completed")))

    def set_outline(self, course_id: UUID, title: str, description: str, chapters: list[dict]) -> None:
        now = datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("UPDATE generated_courses SET title=%s,description=%s,status='generating',progress=10,stage_message=%s,updated_at=%s WHERE id=%s", (title[:160], description, "课程规划完成，正在生成章节资源", now, course_id.bytes))
                for index, chapter in enumerate(chapters, 1):
                    cursor.execute("INSERT INTO generated_course_chapters(id,course_id,chapter_index,title,summary,objectives_json,sections_json,status,progress,resources_json,created_at,updated_at) VALUES(%s,%s,%s,%s,%s,%s,%s,'queued',0,%s,%s,%s)",
                                   (uuid4().bytes, course_id.bytes, index, str(chapter.get("title") or f"第 {index} 章")[:200], str(chapter.get("summary") or ""), json.dumps(chapter.get("objectives") or [], ensure_ascii=False), json.dumps(chapter.get("sections") or [], ensure_ascii=False), json.dumps({}), now, now))
            connection.commit()

    def update_chapter(self, course_id: UUID, chapter_id: UUID, status: str, progress: int, resources: dict | None = None) -> None:
        now = datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("UPDATE generated_course_chapters SET status=%s,progress=%s,resources_json=COALESCE(%s,resources_json),updated_at=%s WHERE id=%s AND course_id=%s",
                               (status, progress, json.dumps(resources, ensure_ascii=False) if resources is not None else None, now, chapter_id.bytes, course_id.bytes))
                cursor.execute("SELECT COUNT(*) total,SUM(status='completed') completed FROM generated_course_chapters WHERE course_id=%s", (course_id.bytes,))
                counts = cursor.fetchone(); total = max(1, counts["total"]); completed = int(counts["completed"] or 0)
                course_status = "completed" if completed == total else "generating"
                course_progress = 10 + round(90 * completed / total)
                stage_message = f"已完成 {completed}/{total} 章"
                if course_status == "completed":
                    cursor.execute(
                        "SELECT resources_json FROM generated_course_chapters WHERE course_id=%s",
                        (course_id.bytes,),
                    )
                    failed_resources = 0
                    for row in cursor.fetchall():
                        chapter_resources = row.get("resources_json") or {}
                        if isinstance(chapter_resources, str):
                            try:
                                chapter_resources = json.loads(chapter_resources)
                            except json.JSONDecodeError:
                                chapter_resources = {}
                        failed_resources += sum(
                            1 for item in chapter_resources.values()
                            if isinstance(item, dict) and item.get("status") in {"failed", "cancelled"}
                        )
                    stage_message = (
                        f"课程主体已完成，{failed_resources} 项资源待重新生成"
                        if failed_resources else "课程已生成完成"
                    )
                cursor.execute("UPDATE generated_courses SET status=%s,progress=%s,stage_message=%s,updated_at=%s WHERE id=%s",
                               (course_status, course_progress, stage_message, now, course_id.bytes))
            connection.commit()

    def fail(self, course_id: UUID, message: str) -> None:
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("UPDATE generated_courses SET status='failed',error_message=%s,stage_message='课程生成失败',updated_at=%s WHERE id=%s", (message[:2000], datetime.utcnow(), course_id.bytes))
            connection.commit()

    def append_event(self, course_id: UUID, title: str, detail: str, agent: str | None = None) -> None:
        self.ensure_schema()
        now = datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT events_json FROM generated_courses WHERE id=%s", (course_id.bytes,)
                )
                row = cursor.fetchone()
                events = self._loads(row.get("events_json") if row else None, []) if row else []
                events.append({
                    "time": now.isoformat(), "title": title, "detail": detail, "agent": agent or "GEN-03",
                })
                cursor.execute(
                    "UPDATE generated_courses SET events_json=%s, updated_at=%s WHERE id=%s",
                    (json.dumps(events, ensure_ascii=False), now, course_id.bytes),
                )
            connection.commit()

    def restart(self, course_id: UUID, user_id: UUID) -> bool:
        """Move a failed course back to a recoverable state without discarding completed work."""
        self.ensure_schema()
        now = datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT COUNT(*) chapter_count FROM generated_course_chapters WHERE course_id=%s",
                    (course_id.bytes,),
                )
                chapter_count = int((cursor.fetchone() or {}).get("chapter_count") or 0)
                next_status = "generating" if chapter_count else "planning"
                next_progress = 10 if chapter_count else 3
                message = "正在继续生成未完成资源" if chapter_count else "正在重新规划课程章节"
                cursor.execute(
                    "UPDATE generated_courses SET status=%s,progress=%s,stage_message=%s,error_message=NULL,updated_at=%s "
                    "WHERE id=%s AND user_id=%s AND status='failed'",
                    (next_status, next_progress, message, now, course_id.bytes, user_id.bytes),
                )
                updated = cursor.rowcount > 0
            connection.commit()
        return updated

    def update_course_meta(self, course_id: UUID, user_id: UUID, title: str | None = None,
                          description: str | None = None) -> dict | None:
        self.ensure_schema()
        now = datetime.utcnow()
        sets, args = [], []
        if title is not None:
            sets.append("title=%s"); args.append(title[:160])
        if description is not None:
            sets.append("description=%s"); args.append(description[:2000])
        if not sets:
            return self.get(course_id, user_id)
        sets.append("updated_at=%s"); args.append(now)
        args.extend([course_id.bytes, user_id.bytes])
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"UPDATE generated_courses SET {', '.join(sets)} WHERE id=%s AND user_id=%s", tuple(args),
                )
                updated = cursor.rowcount > 0
            connection.commit()
        return self.get(course_id, user_id) if updated else None

    def update_chapter_meta(self, course_id: UUID, chapter_id: UUID, user_id: UUID,
                           title: str | None = None, summary: str | None = None) -> dict | None:
        self.ensure_schema()
        now = datetime.utcnow()
        sets, args = [], []
        if title is not None:
            sets.append("title=%s"); args.append(title[:200])
        if summary is not None:
            sets.append("summary=%s"); args.append(summary[:1000])
        if not sets:
            return self.get(course_id, user_id)
        sets.append("updated_at=%s"); args.append(now)
        args.extend([chapter_id.bytes, course_id.bytes, course_id.bytes, user_id.bytes])
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"UPDATE generated_course_chapters SET {', '.join(sets)}"
                    " WHERE id=%s AND course_id=%s AND course_id IN (SELECT id FROM generated_courses WHERE id=%s AND user_id=%s)",
                    tuple(args),
                )
                updated = cursor.rowcount > 0
            connection.commit()
        return self.get(course_id, user_id) if updated else None

    def delete(self, course_id: UUID, user_id: UUID) -> bool:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT id FROM generated_courses WHERE id=%s AND user_id=%s", (course_id.bytes, user_id.bytes))
                if not cursor.fetchone():
                    return False
                cursor.execute("DELETE FROM generated_course_chapters WHERE course_id=%s", (course_id.bytes,))
                cursor.execute("DELETE FROM generated_courses WHERE id=%s AND user_id=%s", (course_id.bytes, user_id.bytes))
            connection.commit()
        return True
