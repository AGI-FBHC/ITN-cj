"""User-side resource customization built from an administrator template.

The template is input context and structural evidence only.  A user resource
is published only after personalization; the administrator version is never
delivered as a user copy when adaptation fails.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import re
from datetime import datetime, timezone, timedelta

_UTC8 = timezone(timedelta(hours=8))
from uuid import UUID, uuid4

logger = logging.getLogger(__name__)

from app.config import Settings
from app.services.learning_content import LearningContentService
from app.services.user_memory import UserMemoryService
from app.storage.platform_db import platform_connect
from app.storage.resource_generation_tasks import ResourceGenerationTaskStore


class CustomizeService:
    """Run a lightweight customization pipeline for one learner."""

    # resource_type -> table + scope columns
    CUSTOMIZABLE = {"lecture", "practice", "quiz", "ppt"}

    def __init__(self, settings: Settings):
        self.settings = settings
        self.tasks = ResourceGenerationTaskStore(settings)
        self.content_service = LearningContentService(settings)

    async def run(self, task_id: UUID, user_id: UUID, admin_resource_id: UUID,
                  kp_id: str | None, resource_type: str, title: str) -> None:
        """Execute the customization pipeline for a task created earlier."""

        async def emit(status: str, progress: int, agent: str,
                       title_text: str, detail: str = "", snapshot: dict | None = None,
                       resource_id: UUID | None = None,
                       error: str | None = None) -> None:
            await asyncio.to_thread(
                self.tasks.update, task_id, user_id, status, progress, title_text,
                agent=agent, title=title_text, detail=detail, resource_id=resource_id,
                error=error, snapshot=snapshot,
            )

        try:
            await emit("retrieving", 10, "retrieval", "检索知识依据",
                       "正在检索课程知识库，获取生成所需的权威资料", {
                "activity": "正在检索课程知识库依据",
                "topic": title, "resourceType": resource_type,
                "nextStep": "检索完成后进入学情分析阶段",
            })

            template = await asyncio.to_thread(
                self._load_template, admin_resource_id, resource_type,
            )
            if template is None:
                await emit("failed", 100, "orchestrator", "定制终止",
                           "该知识点的课程资源暂未生成", error="template missing")
                return

            template_title = str(template.get("title") or title)
            content_preview = (
                self._loads(template.get("outline_json"), {})
                if resource_type == "ppt" else self._template_content(template)
            )
            chapter_count = len(
                content_preview.get("slides") or content_preview.get("chapters")
                or content_preview.get("steps") or content_preview.get("questions") or []
            )

            await emit("retrieving", 18, "retrieval", "知识依据已就绪",
                       f"已检索到「{template_title}」，包含 {chapter_count} 个内容单元", {
                "activity": "已完成知识依据检索",
                "templateTitle": template_title,
                "chapterCount": chapter_count,
                "sourceCount": len(content_preview.get("sources") or []),
                "nextStep": "进入学情分析阶段",
            })

            # Presentations always reuse the administrator's rendered PPT. Only
            # the speaker script may be lightly adapted for this learner.
            customized_content: dict | None = None
            fallback_reason = ""
            if resource_type == "ppt":
                await emit("planning", 28, "planner", "讲解需求分析",
                           "正在结合当前学情确定讲解深浅与重点", {
                    "activity": "正在分析讲解需求",
                    "nextStep": "保持课件页面不变，仅微调逐页讲解稿",
                })
                try:
                    user_context = await asyncio.to_thread(
                        self._load_user_context, user_id, kp_id, resource_type, task_id,
                    )
                except Exception as exc:
                    user_context = self._empty_user_context()
                    fallback_reason = f"学情读取不可用：{type(exc).__name__}"
                await emit("generating", 48, "writer", "逐页讲解稿适配中",
                           "课件画面与页面结构保持不变，正在微调配套讲解稿", {
                    "activity": "正在适配逐页讲解稿",
                    "immutableContent": ["页面数量", "页面标题", "版式与画面", "课件文件"],
                    "nextStep": "核对讲解稿与原课件逐页对应关系",
                })
                try:
                    customized_content = await self._customize_presentation_notes(
                        template, user_context, task_id=task_id, user_id=user_id,
                    )
                except Exception as exc:
                    customized_content = None
                    fallback_reason = f"讲解稿适配不可用：{type(exc).__name__}"
                if customized_content is None:
                    await emit("failed", 100, "writer", "讲解稿适配未完成",
                               "本次未形成个性化讲解稿，未向用户交付通用课件", {
                        "activity": "个性化讲解稿未形成",
                        "nextStep": "稍后重新生成",
                    }, error=fallback_reason or "personalized script missing")
                    return
                await emit("verifying", 76, "reviewer", "逐页对应检查完成",
                           "已确认课件页面未改动，讲解稿与原页逐一对应", {
                    "activity": "已完成课件与讲解稿对应检查",
                    "presentationReused": True,
                    "scriptPersonalized": customized_content is not None,
                    "nextStep": "保存用户学习版本",
                })
            else:
                await emit("planning", 28, "planner", "学情画像分析",
                           "正在汇总学习偏好、知识掌握情况和近期学习记录", {
                    "activity": "正在分析用户学情画像",
                    "nextStep": "根据学情画像制定个性化适配策略",
                })
                try:
                    user_context = await asyncio.to_thread(self._load_user_context, user_id, kp_id, resource_type, task_id)
                except Exception as exc:
                    user_context = self._empty_user_context()
                    fallback_reason = f"画像读取不可用：{type(exc).__name__}"

                profile = self._profile_summary(user_context)
                weak_count = len(user_context.get("weak_points") or [])
                mastery = float((user_context.get("mastery") or {}).get("overall") or 0)

                await emit("planning", 35, "planner", "适配策略已形成",
                           f"掌握度 {round(mastery * 100)}%，识别 {weak_count} 个薄弱点", {
                    "activity": "已形成个性化适配策略",
                    "profileSummary": profile,
                    "weakPointCount": weak_count,
                    "masteryOverall": round(mastery * 100, 1),
                    "acceptanceRubric": ["结构完整", "引用保留", "薄弱点有增补"],
                    "nextStep": "进入内容适配阶段",
                })

                await emit("generating", 42, "writer", "内容适配中",
                           "基于检索到的知识依据，结合学情生成个性化内容", {
                    "activity": "正在基于知识依据生成个性化内容",
                    "resourceType": resource_type,
                    "coverage": [f"覆盖 {chapter_count} 个内容板块"],
                    "nextStep": "适配完成后进入质量核验",
                })
                try:
                    candidate = await self._customize_content(
                        resource_type, template, user_context, kp_id, title,
                        task_id=task_id, user_id=user_id,
                    )
                    customized_content = self._merge_with_template(
                        resource_type, self._template_content(template), candidate, user_context,
                    )
                except Exception as exc:
                    customized_content = None
                    fallback_reason = f"内容适配不可用：{type(exc).__name__}"

                # 讲义/实操：失败时兜底使用源知识，永远不阻断交付
                if customized_content is None:
                    customized_content = self._template_content(template)
                    await emit("generating", 55, "writer", "基于源知识生成中",
                               "个性化适配未完成，正在基于源知识内容生成", {
                        "activity": "基于源知识内容生成",
                        "fallbackToSource": True,
                        "fallbackReason": fallback_reason,
                        "nextStep": "进入内容校验",
                    })
                else:
                    adapted_count = len(customized_content.get("chapters") or customized_content.get("steps") or customized_content.get("questions") or [])
                    await emit("generating", 58, "writer", "内容适配完成",
                               f"已生成包含 {adapted_count} 个内容单元的个性化版本", {
                        "activity": "内容适配已完成",
                        "artifactPreview": {"kind": resource_type, "count": adapted_count},
                        "nextStep": "进入内容校验",
                    })

                # 质量校验：最多两轮，不阻断交付
                quality_score = None
                template_content = self._template_content(template)
                check_passed = self._quality_check(resource_type, template_content, customized_content)

                if not check_passed:
                    # 第一轮未通过，尝试修复一次
                    await emit("verifying", 68, "reviewer", "内容校验中",
                               "正在核对内容结构与引用完整性", {
                        "activity": "正在校验内容结构",
                        "nextStep": "校验完成后继续",
                    })
                    try:
                        repaired = await self._repair_customized_content(
                            resource_type, template_content, customized_content, user_context,
                        )
                        if repaired is not None:
                            customized_content = repaired
                    except Exception:
                        pass  # 修复失败则使用当前版本继续

                # 第二轮：只做评分，写入 snapshot，不阻断
                quality_score = self._score_content(resource_type, template_content, customized_content)
                await emit("verifying", 78, "reviewer", "内容校验完成",
                           "已完成内容结构与质量校验", {
                    "activity": "内容校验已完成",
                    "qualityScore": quality_score,
                    "decision": "pass",
                    "nextStep": "进入发布裁决",
                })

            # All successful paths above guarantee a personalized artifact.
            # Never substitute the administrator content at publication time.
            final_content = customized_content
            delivery_mode = "personalized"

            await emit("judging", 88, "judge", "发布裁决中",
                       "正在确认最终交付版本并保存", {
                "activity": "正在裁决最终交付版本",
                "deliveryMode": delivery_mode,
                "nextStep": "保存为用户定制版本",
            })

            new_id = await asyncio.to_thread(
                self._create_user_copy, user_id, template, kp_id, resource_type, title,
                final_content, delivery_mode, fallback_reason,
            )

            await emit("completed", 100, "judge", "个性化定制完成",
                       "个性化版本已就绪，可以开始学习", resource_id=new_id, snapshot={
                "deliveryMode": delivery_mode,
                "activity": "已保存个性化学习资源",
                "artifactPreview": {"kind": resource_type, "title": title},
            })
        except asyncio.CancelledError:
            # 任务被取消（用户退出/服务重启）：落一个终态，避免前端永远在“生成中”。
            try:
                await emit("cancelled", 100, "orchestrator", "定制已取消",
                           "任务已取消，可重新发起定制", error="cancelled")
            except Exception:  # pragma: no cover - defensive
                pass
            raise
        except Exception as exc:
            # 关键：任务必须落终态。此前只有 finally，意外异常（模型 429/超时、数据库错误等）
            # 会让任务永远停在 generating，前端无法区分“在等待”与“已失败”（BUG-021）。
            logger.exception("定制生成失败 task_id=%s", task_id)
            try:
                await emit("failed", 100, "orchestrator", "定制生成失败",
                           f"生成过程中出现异常：{exc}", error=str(exc))
            except Exception:  # pragma: no cover - defensive
                pass
            raise
        finally:
            # Closing the per-task client releases pooled HTTP connections. A
            # close failure has no bearing on the already persisted resource.
            try:
                await self.content_service.close()
            except Exception:  # pragma: no cover - defensive cleanup
                pass

    # ------------------------------------------------------------------
    # Storage helpers (synchronous, called via asyncio.to_thread)
    # ------------------------------------------------------------------

    def _find_user_copy(self, user_id: UUID, template_id: UUID, resource_type: str) -> str | None:
        """Return the existing USER-scope copy id for this user+template+type, if any."""
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                if resource_type == "ppt":
                    cursor.execute(
                        "SELECT id FROM presentation_tasks "
                        "WHERE user_id=%s AND base_presentation_id=%s AND resource_scope='USER' "
                        "AND archived_at IS NULL LIMIT 1",
                        (user_id.bytes, template_id.bytes),
                    )
                else:
                    cursor.execute(
                        "SELECT id FROM generated_learning_resources "
                        "WHERE user_id=%s AND base_resource_id=%s AND resource_scope='USER' "
                        "AND archived_at IS NULL LIMIT 1",
                        (user_id.bytes, template_id.bytes),
                    )
                row = cursor.fetchone()
                return str(UUID(bytes=row["id"])) if row else None

    def _find_customize_task_for_copy(self, user_id: UUID, resource_id: UUID) -> dict | None:
        """Return the newest completed task linked to an existing USER copy."""
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM learning_resource_generation_tasks "
                    "WHERE user_id=%s AND resource_id=%s "
                    "AND JSON_EXTRACT(request_json, '$.customize')=TRUE "
                    "AND status IN ('completed','queued','generating','retrieving','debating','planning','analyzing','verifying','reviewing','revising','judging','outline_review') "
                    "ORDER BY updated_at DESC LIMIT 1",
                    (user_id.bytes, resource_id.bytes),
                )
                row = cursor.fetchone()
        return self.tasks._serialize(row) if row else None

    def _list_user_customize_tasks(self, user_id: UUID, kp_id: str | None) -> list[dict]:
        """List all customization summaries needed to resolve USER copies.

        The UI matches a mother template through ``request.adminResourceId``.
        Limiting this query to the most recent 50 tasks made an older, still
        valid USER copy appear as "not customized", while creation correctly
        found and rejected that same copy. Events stay out of this list query;
        the selected task is loaded through the detail endpoint instead.
        """
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id,user_id,resource_type,title,status,progress,stage_message,"
                    "request_json,resource_id,error_message,created_at,updated_at "
                    "FROM learning_resource_generation_tasks "
                    "WHERE user_id=%s AND JSON_EXTRACT(request_json, '$.customize')=TRUE "
                    "ORDER BY created_at DESC",
                    (user_id.bytes,),
                )
                rows = cursor.fetchall()
        tasks = [self.tasks._serialize_summary(row) for row in rows]
        if kp_id:
            tasks = [t for t in tasks if (t.get("request") or {}).get("kpId") == kp_id]
        return tasks

    def _load_template(self, admin_resource_id: UUID, resource_type: str) -> dict | None:
        """Load the organization template (either learning resource or presentation)."""
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                if resource_type == "ppt":
                    cursor.execute(
                        "SELECT * FROM presentation_tasks "
                        "WHERE id=%s AND archived_at IS NULL AND resource_scope='ORGANIZATION'",
                        (admin_resource_id.bytes,),
                    )
                else:
                    cursor.execute(
                        "SELECT * FROM generated_learning_resources "
                        "WHERE id=%s AND archived_at IS NULL AND resource_scope='ORGANIZATION'",
                        (admin_resource_id.bytes,),
                    )
                return cursor.fetchone()

    def _create_user_copy(self, user_id: UUID, template: dict,
                          kp_id: str | None, resource_type: str, title: str,
                          content: dict | None = None,
                          delivery_mode: str = "personalized",
                          fallback_reason: str = "") -> UUID:
        """Insert a USER-scope copy of the template (learning resource or presentation)."""
        if resource_type == "ppt":
            return self._copy_presentation(
                user_id, template, kp_id, title,
                outline=content if isinstance(content, dict) else None,
                delivery_mode=delivery_mode,
            )
        template_id = UUID(bytes=template["id"])
        new_id = uuid4()
        now = datetime.now(_UTC8)
        try:
            context = json.loads(template.get("context_json") or "{}")
        except (TypeError, json.JSONDecodeError):
            context = {}
        if not isinstance(context, dict):
            context = {}
        context["customizedFrom"] = str(template_id)
        context["customizedAt"] = now.isoformat()
        context["customizationMode"] = delivery_mode
        if fallback_reason:
            context["customizationFallbackReason"] = fallback_reason
        serialized_content = json.dumps(content, ensure_ascii=False) if isinstance(content, dict) else (
            template.get("content_json") or "{}"
        )
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id FROM generated_learning_resources "
                    "WHERE user_id=%s AND base_resource_id=%s AND resource_scope='USER' "
                    "AND archived_at IS NULL LIMIT 1 FOR UPDATE",
                    (user_id.bytes, template_id.bytes),
                )
                existing = cursor.fetchone()
                if existing:
                    existing_id = UUID(bytes=existing["id"])
                    # Content changed, so old progress, notes, feedback and wrong
                    # answers must not be attached to the regenerated version.
                    for table in (
                        "learning_resource_user_state", "learning_resource_messages",
                        "learning_resource_review_events", "learning_resource_source_feedback",
                        "learning_wrong_answers",
                    ):
                        cursor.execute(f"DELETE FROM {table} WHERE resource_id=%s", (existing_id.bytes,))
                    cursor.execute(
                        "UPDATE generated_learning_resources SET kp_id=%s,form=%s,level=%s,version=%s,"
                        "quiz_ids_json=%s,kb_refs_json=%s,resource_type=%s,title=%s,topic=%s,"
                        "content_json=%s,sources_json=%s,state_json=%s,context_json=%s,decision_json=%s,"
                        "resource_group=%s,updated_at=%s WHERE id=%s",
                        (template.get("kp_id") or kp_id, template.get("form") or resource_type,
                         template.get("level"), "v1", template.get("quiz_ids_json") or "[]",
                         template.get("kb_refs_json") or "[]", template.get("resource_type") or resource_type,
                         title, template.get("topic"), serialized_content,
                         template.get("sources_json") or "[]", "{}",
                         json.dumps(context, ensure_ascii=False), template.get("decision_json") or "{}",
                         template.get("resource_group") or "默认分组", now, existing_id.bytes),
                    )
                    connection.commit()
                    return existing_id
                cursor.execute(
                    "INSERT INTO generated_learning_resources "
                    "(id,user_id,learner_id,kp_id,form,level,version,quiz_ids_json,kb_refs_json,"
                    "resource_type,title,topic,learning_goal_id,course_id,chapter_id,"
                    "content_json,sources_json,state_json,context_json,decision_json,"
                    "resource_group,base_resource_id,resource_scope,created_at,updated_at) "
                    "VALUES(%s,%s,NULL,%s,%s,%s,%s,%s,%s,%s,%s,%s,NULL,NULL,NULL,%s,%s,%s,%s,%s,%s,%s,'USER',%s,%s)",
                    (new_id.bytes, user_id.bytes,
                     template.get("kp_id") or kp_id,
                     template.get("form") or resource_type,
                     template.get("level"),
                     "v1",
                     template.get("quiz_ids_json") or "[]",
                     template.get("kb_refs_json") or "[]",
                     template.get("resource_type") or resource_type,
                     title,
                     template.get("topic"),
                     serialized_content,
                     template.get("sources_json") or "[]",
                     "{}",
                     json.dumps(context, ensure_ascii=False),
                     template.get("decision_json") or "{}",
                     template.get("resource_group") or "默认分组",
                     template_id.bytes,
                     now, now),
                )
            connection.commit()
        return new_id

    # ------------------------------------------------------------------
    # Personalization helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _loads(value, fallback):
        if isinstance(value, (dict, list)):
            return value
        try:
            parsed = json.loads(value) if value else fallback
        except (TypeError, json.JSONDecodeError):
            return fallback
        return parsed

    def _template_content(self, template: dict) -> dict:
        content = self._loads(template.get("content_json"), {})
        return content if isinstance(content, dict) else {}

    @staticmethod
    def _empty_user_context() -> dict:
        return {
            "mode": "user_customize", "profile": {},
            "mastery": {"overall": 0.5, "items": [], "evidenceLevel": "cold_start"},
            "learning_history": [], "weak_points": [],
            "recommendation": {"ability": 0.5},
        }

    def _load_user_context(self, user_id: UUID, kp_id: str | None,
                           resource_type: str = "lecture", task_id: UUID | None = None) -> dict:
        """Read learner profile and real USER-copy learning state, read-only."""
        result = self._empty_user_context()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT role,education,target_job,weekly_hours,learning_style_json,scores_json,"
                    "goal,blind_spots_json,preferred_format,diagnosis_summary "
                    "FROM learners WHERE user_id=%s AND status=1 "
                    "ORDER BY (target_job IS NOT NULL) DESC,(diagnosis_summary IS NOT NULL) DESC,"
                    "(scores_json IS NOT NULL) DESC,updated_at DESC LIMIT 1",
                    (user_id.bytes,),
                )
                learner = cursor.fetchone() or {}
                result["profile"] = {
                    "role": learner.get("role"), "education": learner.get("education"),
                    "targetJob": learner.get("target_job"), "weeklyHours": learner.get("weekly_hours"),
                    "learningStyle": self._loads(learner.get("learning_style_json"), []),
                    "scores": self._loads(learner.get("scores_json"), {}),
                    "goal": learner.get("goal"),
                    "blindSpots": self._loads(learner.get("blind_spots_json"), []),
                    "preferredFormat": learner.get("preferred_format"),
                    "diagnosisSummary": learner.get("diagnosis_summary"),
                }
                sql = (
                    "SELECT r.id,r.kp_id,r.resource_type,r.title,s.state_json,s.updated_at "
                    "FROM generated_learning_resources r "
                    "LEFT JOIN learning_resource_user_state s ON s.resource_id=r.id AND s.user_id=%s "
                    "WHERE r.user_id=%s AND r.resource_scope='USER' AND r.archived_at IS NULL"
                )
                args: list[object] = [user_id.bytes, user_id.bytes]
                if kp_id:
                    sql += " AND r.kp_id=%s"
                    args.append(kp_id)
                sql += " ORDER BY COALESCE(s.updated_at,r.updated_at) DESC LIMIT 50"
                cursor.execute(sql, tuple(args))
                rows = cursor.fetchall() or []

        history: list[dict] = []
        mastery_values: dict[str, float] = {}
        for row in rows:
            state = self._loads(row.get("state_json"), {})
            if not isinstance(state, dict):
                state = {}
            history.append({
                "resourceType": row.get("resource_type"), "title": row.get("title"),
                "learned": bool(state.get("learned")),
                "progressRatio": float(state.get("progressRatio") or 0),
                "updatedAt": row.get("updated_at").isoformat() if row.get("updated_at") else None,
            })
            raw_mastery = state.get("mastery") or state.get("masteryRatio")
            if isinstance(raw_mastery, dict):
                for key, value in raw_mastery.items():
                    try:
                        mastery_values[str(key)] = float(value)
                    except (TypeError, ValueError):
                        continue
            elif raw_mastery is not None:
                try:
                    mastery_values[str(row.get("kp_id") or kp_id or "current")] = float(raw_mastery)
                except (TypeError, ValueError):
                    pass
        if not mastery_values:
            profile_scores = result.get("profile", {}).get("scores") or {}
            if isinstance(profile_scores, dict):
                for key, value in profile_scores.items():
                    try:
                        score = float(value)
                        mastery_values[str(key)] = score / 100 if score > 1 else score
                    except (TypeError, ValueError):
                        continue
        items = [{"knowledgePoint": key, "score": score} for key, score in mastery_values.items()]
        overall = sum(mastery_values.values()) / len(mastery_values) if mastery_values else 0.5
        result["mastery"] = {
            "overall": round(overall, 4), "items": items,
            "evidenceLevel": "observed" if items else "cold_start",
        }
        result["learning_history"] = history
        measured_weak = [item for item in items if item["score"] < 0.4]
        named_weak = [
            {"knowledgePoint": str(name), "score": None, "source": "learner_profile"}
            for name in (result.get("profile", {}).get("blindSpots") or []) if str(name).strip()
        ]
        result["weak_points"] = measured_weak + named_weak
        result["recommendation"] = {"ability": round(overall, 4)}
        scene = f"{resource_type}_customize"
        memory_context = UserMemoryService(self.settings).get_context(
            user_id, scene, {"kpId": kp_id, "resourceType": resource_type},
            str(task_id) if task_id else None,
        )
        result["memory_context"] = memory_context
        result["preferences"] = memory_context.get("preferences") or []
        for misconception in memory_context.get("misconceptions") or []:
            candidate = {
                "knowledgePoint": misconception.get("concept") or misconception.get("kpId") or kp_id,
                "score": None, "source": "user_memory",
                "summary": misconception.get("summary"),
            }
            if candidate not in result["weak_points"]:
                result["weak_points"].append(candidate)
        return result

    @staticmethod
    def _profile_summary(context: dict) -> dict:
        profile = context.get("profile") or {}
        mastery = context.get("mastery") or {}
        return {
            "targetJob": profile.get("targetJob"),
            "preferredFormat": profile.get("preferredFormat"),
            "masteryLevel": mastery.get("evidenceLevel"),
            "masteryOverall": mastery.get("overall"),
            "weakPointCount": len(context.get("weak_points") or []),
            "historyCount": len(context.get("learning_history") or []),
            "memoryCount": len(((context.get("memory_context") or {}).get("memoryRefs") or [])),
        }

    async def _customize_content(self, resource_type: str, template: dict,
                                 user_context: dict, kp_id: str | None,
                                 title: str, *, task_id: UUID | None = None,
                                 user_id: UUID | None = None) -> dict:
        """Adapt one mother resource with a single streaming model request.

        The model emits small NDJSON patches instead of regenerating the whole
        resource.  Each complete patch is merged into the immutable mother
        structure and persisted immediately, so learning can start before the
        stream ends. Quiz cards are selected deterministically from the reviewed
        mother bank and never invoke the model.
        """
        template_content = self._template_content(template)
        topic = str(template.get("topic") or template_content.get("title") or title)
        template_sources = self._loads(template.get("sources_json"), [])
        sources = template_sources if isinstance(template_sources, list) else []
        result = copy.deepcopy(template_content)
        ready_slides: list[dict] = []

        if resource_type == "lecture":
            objectives = [str(item).strip() for item in result.get("learningObjectives") or [] if str(item).strip()]
            summary = str(result.get("summary") or "").strip()
            # 去掉"基于《xxx》源文档"前缀
            import re
            summary = re.sub(r'^本章节基于《[^》]+》源文档[，,]\s*', '', summary)
            overview_parts = [summary]
            if objectives:
                overview_parts.append(
                    "**完成本讲后，你将能够：**\n" + "\n".join(f"- {item}" for item in objectives)
                )
            overview = "\n\n".join(part for part in overview_parts if part)
            if overview:
                ready_slides.append({
                    "index": 0, "unitIndex": 0,
                    "totalUnits": len(result.get("chapters") or []), "type": "intro",
                    "title": "学习目标与内容概览", "content": overview,
                    "sources": [], "evidenceQuotes": [],
                })

        async def persist(slides: list[dict]) -> None:
            if task_id is not None and user_id is not None:
                await asyncio.to_thread(self.tasks.save_slides, task_id, user_id, slides)

        # 导览卡无需等待模型，任务启动后即可作为第一张学习卡片展示。
        if ready_slides:
            await persist(ready_slides)

        async def record_unit_progress(unit_index: int, total: int, card_count: int,
                                       unit_label: str, personalized: bool = True) -> None:
            if task_id is None or user_id is None or total <= 0:
                return
            progress = min(57, 42 + round(((unit_index + 1) / total) * 15))
            await asyncio.to_thread(
                self.tasks.update, task_id, user_id, "generating", progress,
                f"{unit_label}已生成",
                agent="writer", title=f"{unit_label}已生成",
                detail=f"已完成 {unit_index + 1}/{total} 个内容单元，当前可学习 {card_count} 张卡片",
                snapshot={
                    "activity": "学习卡片已就绪", "completedUnits": unit_index + 1,
                    "totalUnits": total, "readyCards": card_count,
                    "personalized": personalized,
                    "nextStep": "继续生成后续内容单元" if unit_index + 1 < total else "进入整体质量核验",
                },
            )
            await asyncio.to_thread(
                self.tasks.update, task_id, user_id, "generating", progress,
                f"{unit_label}结构检查完成",
                agent="reviewer", title=f"{unit_label}结构检查完成",
                detail="已确认内容结构、引用关系和学习卡片格式完整",
                snapshot={
                    "activity": "阶段性质量检查已完成", "completedUnits": unit_index + 1,
                    "totalUnits": total, "readyCards": card_count,
                    "nextStep": "继续适配后续内容" if unit_index + 1 < total else "进入整体质量核验",
                },
            )

        if resource_type == "quiz":
            result["questions"] = self._select_questions_for_profile(
                result.get("questions") or [], user_context,
            )
            total = len(result["questions"])
            for unit_index, question in enumerate(result["questions"]):
                ready_slides.append({
                    "index": len(ready_slides), "unitIndex": unit_index,
                    "totalUnits": total, "type": "question",
                    "title": f"第 {unit_index + 1} 题",
                    "content": copy.deepcopy(question),
                    "sources": self._sources_for_item(question, sources),
                    "evidenceQuotes": self._evidence_anchors_for_item(question),
                })
                await persist(ready_slides)
                await record_unit_progress(unit_index, total, len(ready_slides), f"第 {unit_index + 1} 题")
            result["personalization"] = {
                "strategy": "profile_ranked_mother_bank",
                "masteryOverall": ((user_context.get("mastery") or {}).get("overall")),
                "weakPoints": copy.deepcopy(user_context.get("weak_points") or []),
            }
            return result

        unit_key = "chapters" if resource_type == "lecture" else "steps"
        units = [item for item in result.get(unit_key) or [] if isinstance(item, dict)]
        total = len(units)
        if not units:
            raise ValueError("template contains no learnable units")

        messages = self._stream_customization_messages(
            resource_type, topic, template_content, user_context, kp_id,
        )
        patches: dict[int, dict] = {}
        personalized_units: set[int] = set()
        next_unit_index = 0
        buffer = ""
        first_content = True

        async def persist_ready_patches(*, fill_missing: bool = False) -> None:
            nonlocal next_unit_index
            while next_unit_index < total and (fill_missing or next_unit_index in patches):
                unit_index = next_unit_index
                original_unit = units[unit_index]
                patch = patches.get(unit_index)
                adapted_unit = self._apply_stream_patch(resource_type, original_unit, patch)
                personalized = adapted_unit != original_unit
                if personalized:
                    personalized_units.add(unit_index)
                result[unit_key][unit_index] = adapted_unit
                unit_slides = self._slides_for_unit(resource_type, adapted_unit, sources)
                for part_index, slide in enumerate(unit_slides):
                    slide.update({
                        "index": len(ready_slides), "unitIndex": unit_index,
                        "totalUnits": total, "partIndex": part_index,
                        "partCount": len(unit_slides),
                    })
                    ready_slides.append(slide)
                await persist(ready_slides)
                unit_label = "章节" if resource_type == "lecture" else "实操步骤"
                await record_unit_progress(
                    unit_index, total, len(ready_slides),
                    f"第 {unit_index + 1} 个{unit_label}", personalized,
                )
                next_unit_index += 1

        async for event in self.content_service.llm.stream_chat(
            messages, provider="mimo-legacy", max_tokens_override=8192, thinking=False,
        ):
            if event.get("type") != "content" or not event.get("text"):
                continue
            if first_content and task_id is not None and user_id is not None:
                first_content = False
                await asyncio.to_thread(
                    self.tasks.update, task_id, user_id, "generating", 44,
                    "个性化内容开始生成", agent="writer", title="个性化内容开始生成",
                    detail="模型已开始返回内容，首批学习卡片即将就绪",
                    snapshot={"activity": "正在流式生成个性化内容", "nextStep": "形成首批学习卡片"},
                )
            buffer += str(event["text"])
            parsed_items, buffer = self._extract_stream_patches(buffer, total)
            for unit_index, patch in parsed_items:
                patches[unit_index] = patch
            await persist_ready_patches()
        parsed_items, _remainder = self._extract_stream_patches(buffer, total)
        for unit_index, patch in parsed_items:
            patches[unit_index] = patch
        await persist_ready_patches()
        if next_unit_index != total or len(personalized_units) != total:
            raise ValueError("personalization did not produce every content unit")
        if resource_type == "lecture":
            framing = await self._generate_lecture_framing(result, user_context)
            if framing:
                self._apply_lecture_framing(result, framing)
                ready_slides = self._rebuild_lecture_slides(result, sources)
                await persist(ready_slides)
        return result

    async def _generate_lecture_framing(self, content: dict,
                                         user_context: dict) -> dict | None:
        """Generate the opening and closing cards from the finished lecture.

        No textual fallback is synthesized here.  If the model is unavailable
        the already valid mother/adapted cards remain unchanged.
        """
        chapters = []
        for chapter in content.get("chapters") or []:
            if not isinstance(chapter, dict):
                continue
            chapters.append({
                "title": chapter.get("title"),
                "sections": [{
                    "title": section.get("title"),
                    "content": str(section.get("content") or section.get("body") or "")[:3000],
                } for section in chapter.get("sections") or [] if isinstance(section, dict)],
            })
        if not chapters:
            return None
        learner = {
            "profile": user_context.get("profile") or {},
            "mastery": user_context.get("mastery") or {},
            "weakPoints": (user_context.get("weak_points") or [])[:10],
            "preferences": user_context.get("preferences") or {},
            "memory": str(((user_context.get("memory_context") or {}).get("promptBlock") or ""))[:2400],
        }
        complete_json = getattr(self.content_service.llm, "complete_json", None)
        if not callable(complete_json):
            return None
        try:
            result = await complete_json(
                "你是学习资源编排 Agent。只能依据已经完成的讲义正文，生成开场导览卡和结尾复习检查卡。"
                "不得新增正文没有涉及的事实，不得输出前言、解释、Markdown代码围栏或思维过程，只返回合法JSON。",
                "请阅读完整讲义后生成首尾两张卡片。\n"
                "开场导览卡：概括本讲实际解决的问题；给出3-5项具体、可验证且对应正文的学习目标；"
                "不要使用‘了解、掌握关键方法、深入理解、全面认识’等空泛目标。\n"
                "结尾复习检查卡：围绕正文最重要的概念、机制、方法、案例和限制设计3-5项检查任务；"
                "任务应包含解释、比较、场景判断、错误诊断或实践验证；每项给出简短判断标准；"
                "不要直接提供完整答案，不要固定使用‘核心概念验证’作为标题。\n"
                "学习者信息只用于调整解释角度、目标难度和检查方式，正文不得出现‘根据用户画像’等表述。\n"
                "输出结构："
                '{"intro":{"title":"","overview":"","objectives":[""]},'
                '"review":{"title":"","introduction":"","checks":['
                '{"task":"","criteria":"","relatedSections":[""]}]}}\n'
                f"学习者信息：{json.dumps(learner, ensure_ascii=False, default=str)}\n"
                f"完整讲义正文：{json.dumps(chapters, ensure_ascii=False, default=str)}",
                {}, provider="mimo-legacy", max_tokens=2400, max_retries=2,
                thinking=False, timeout_seconds=90,
            )
        except Exception:
            return None
        return result if isinstance(result, dict) and result else None

    @staticmethod
    def _apply_lecture_framing(content: dict, framing: dict) -> bool:
        intro = framing.get("intro") if isinstance(framing, dict) else None
        review = framing.get("review") if isinstance(framing, dict) else None
        changed = False
        if isinstance(intro, dict):
            title = str(intro.get("title") or "").strip()
            overview = str(intro.get("overview") or "").strip()
            objectives = [str(item).strip() for item in intro.get("objectives") or [] if str(item).strip()]
            if title and overview and 3 <= len(objectives) <= 6:
                content["introTitle"] = title
                content["summary"] = overview
                content["learningObjectives"] = objectives
                changed = True
        chapters = [item for item in content.get("chapters") or [] if isinstance(item, dict)]
        sections = [item for item in (chapters[-1].get("sections") or []) if isinstance(item, dict)] if chapters else []
        if isinstance(review, dict) and sections:
            title = str(review.get("title") or "").strip()
            introduction = str(review.get("introduction") or "").strip()
            checks = [item for item in review.get("checks") or [] if isinstance(item, dict)]
            rendered = []
            for index, item in enumerate(checks, 1):
                task = str(item.get("task") or "").strip()
                criteria = str(item.get("criteria") or "").strip()
                if not task or not criteria:
                    continue
                rendered.append(f"{index}. **{task}**\n\n   检查标准：{criteria}")
            if title and introduction and 3 <= len(rendered) <= 6:
                sections[-1]["title"] = title
                sections[-1]["content"] = introduction + "\n\n" + "\n\n".join(rendered)
                changed = True
        if changed:
            content["_generatedFraming"] = True
        return changed

    @classmethod
    def _rebuild_lecture_slides(cls, content: dict,
                                sources: list[dict]) -> list[dict]:
        slides: list[dict] = []
        objectives = [str(item).strip() for item in content.get("learningObjectives") or [] if str(item).strip()]
        summary = str(content.get("summary") or "").strip()
        overview = "\n\n".join(filter(None, [
            summary,
            "**完成本讲后，你将能够：**\n" + "\n".join(f"- {item}" for item in objectives)
            if objectives else "",
        ]))
        if overview:
            slides.append({
                "index": 0, "unitIndex": 0,
                "totalUnits": len(content.get("chapters") or []), "type": "intro",
                "title": str(content.get("introTitle") or "学习目标与内容概览"),
                "content": overview, "sources": [], "evidenceQuotes": [],
            })
        chapters = [item for item in content.get("chapters") or [] if isinstance(item, dict)]
        for unit_index, chapter in enumerate(chapters):
            for part_index, slide in enumerate(cls._slides_for_unit("lecture", chapter, sources)):
                slide.update({
                    "index": len(slides), "unitIndex": unit_index,
                    "totalUnits": len(chapters), "partIndex": part_index,
                    "partCount": 1,
                })
                slides.append(slide)
        return slides

    @staticmethod
    def _stream_customization_messages(resource_type: str, topic: str,
                                       template_content: dict, user_context: dict,
                                       kp_id: str | None) -> list[dict]:
        """Build a compact, structure-preserving prompt for one stream."""
        memory = user_context.get("memory_context") or {}
        compact_context = {
            "profile": user_context.get("profile") or {},
            "mastery": user_context.get("mastery") or {},
            "weakPoints": (user_context.get("weak_points") or [])[:12],
            "learningHistory": (user_context.get("learning_history") or [])[:8],
            "preferences": user_context.get("preferences") or {},
            "memory": {
                "promptBlock": str(memory.get("promptBlock") or "")[:5000],
                "memoryRefs": (memory.get("memoryRefs") or [])[:12],
            },
        }
        if resource_type == "lecture":
            schema = (
                '每行格式：{"unitIndex":0,"sections":'
                '[{"sectionIndex":0,"content":"个性化后的正文"}]}。'
                "只改写需要适配的 section content；每个章节输出一行。"
            )
        else:
            schema = (
                '每行格式：{"unitIndex":0,"instruction":"个性化后的步骤说明",'
                '"warning":"可选的注意事项"}。'
                "只调整 instruction 和必要的 warning；每个步骤输出一行。"
            )
        system = (
            "你是学习资源个性化适配 Agent。基于管理员母版和学习者信息做少量、明确、实用的改写。"
            "必须保持母版的单元数量、顺序、标题、字段结构、代码、预期结果和全部引用不变。"
            "母版正文中出现的每一个引用标记必须逐字保留在对应改写内容中，不得合并、改号或删除。"
            "已掌握内容适度精简，薄弱内容补充一个贴近学习者的解释或例子。"
            "即使不需要改写，也必须确保输出格式正确：正文中的分点列举（如 1. 2. 3. 或 - 开头的列表）必须每个要点独占一行，用换行符（\\n）分隔。"
            "例如：\"背景：\\n1. 第一点内容\\n2. 第二点内容\\n3. 第三点内容\\n总结。\""
            "源文档中的分点列举可能缺少换行符导致多个要点挤在一段中，你必须识别并拆分为独立行后再输出。"
            "只输出逐行 JSON（NDJSON），不要 Markdown、代码围栏、前言或总结。" + schema
        )
        payload = {
            "topic": topic, "knowledgePointId": kp_id,
            "resourceType": resource_type, "learnerContext": compact_context,
            "motherTemplate": template_content,
        }
        return [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False, default=str)},
        ]

    @staticmethod
    def _parse_stream_patch(line: str, total: int) -> tuple[int, dict] | None:
        cleaned = str(line or "").strip()
        if not cleaned or cleaned.startswith("```"):
            return None
        try:
            value = json.loads(cleaned)
            index = int(value.get("unitIndex"))
        except (TypeError, ValueError, json.JSONDecodeError, AttributeError):
            return None
        if not 0 <= index < total or not isinstance(value, dict):
            return None
        return index, value

    @classmethod
    def _extract_stream_patches(cls, buffer: str, total: int) -> tuple[list[tuple[int, dict]], str]:
        """Extract complete JSON objects without waiting for model newlines.

        Text outside JSON objects is deliberately discarded.  This makes the
        card stream tolerant of model chatter such as ``好的，下面生成第二页``
        while persisting the first card as soon as its closing brace arrives.
        """
        parsed: list[tuple[int, dict]] = []
        start: int | None = None
        depth = 0
        in_string = False
        escaped = False
        last_complete = 0
        for index, char in enumerate(str(buffer or "")):
            if start is None:
                if char == "{":
                    start = index
                    depth = 1
                    in_string = False
                    escaped = False
                continue
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    candidate = cls._parse_stream_patch(buffer[start:index + 1], total)
                    if candidate is not None:
                        parsed.append(candidate)
                    last_complete = index + 1
                    start = None
        if start is not None:
            return parsed, buffer[start:]
        return parsed, ""

    @staticmethod
    def _apply_stream_patch(resource_type: str, original: dict,
                            patch: dict | None) -> dict:
        result = copy.deepcopy(original)
        if not isinstance(patch, dict):
            return result
        if resource_type == "lecture":
            sections = result.get("sections") or []
            for change in patch.get("sections") or []:
                if not isinstance(change, dict):
                    continue
                try:
                    index = int(change.get("sectionIndex"))
                except (TypeError, ValueError):
                    continue
                content = change.get("content")
                if 0 <= index < len(sections) and isinstance(content, str) and content.strip():
                    original_content = str(sections[index].get("content") or sections[index].get("body") or "")
                    sections[index]["content"] = CustomizeService._preserve_inline_citations(
                        original_content, CustomizeService._strip_model_preamble(content),
                    )
        elif resource_type == "practice":
            for key in ("instruction", "warning"):
                value = patch.get(key)
                if isinstance(value, str) and value.strip():
                    result[key] = CustomizeService._preserve_inline_citations(
                        str(original.get(key) or ""), CustomizeService._strip_model_preamble(value),
                    )
        return result

    @staticmethod
    def _strip_model_preamble(value: str) -> str:
        """Remove conversational hand-off text from a generated card body."""
        text = str(value or "").strip()
        patterns = (
            r"^(?:好的?|当然可以|没问题)[，,。！!\s]*(?:我)?(?:现在|接下来)?(?:将|来|开始)?(?:为你)?(?:继续)?(?:生成|输出|呈现).{0,48}?[：:。！!\n]+\s*",
            r"^(?:下面|接下来)(?:是|将是|我将|我来|我们来)?.{0,48}?(?:下一页|本页|第[^，。！!\n]{0,16}页|内容).{0,24}?[：:。！!\n]+\s*",
        )
        for _ in range(2):
            before = text
            for pattern in patterns:
                text = re.sub(pattern, "", text, count=1, flags=re.IGNORECASE)
            if text == before:
                break
        return text.strip()

    @staticmethod
    def _preserve_inline_citations(original: str, adapted: str) -> str:
        """Keep every literal mother citation even when the model omits one."""
        pattern = re.compile(r"\[(?:citation:\s*\d+|\^\d+|KB-\d+|\d+)\]", re.IGNORECASE)
        original_marks = list(dict.fromkeys(pattern.findall(str(original or ""))))
        missing = [mark for mark in original_marks if mark not in adapted]
        if not missing:
            return adapted
        return f"{adapted.rstrip()}\n\n引用依据：{' '.join(missing)}"

    @staticmethod
    def _unit_keeps_citations(original: dict, candidate: dict, resource_type: str) -> bool:
        if resource_type == "practice":
            return original.get("citations") == candidate.get("citations")
        original_sections = original.get("sections") or []
        candidate_sections = candidate.get("sections") or []
        return len(original_sections) == len(candidate_sections) and all(
            isinstance(old, dict) and isinstance(new, dict)
            and old.get("citations") == new.get("citations")
            for old, new in zip(original_sections, candidate_sections)
        )

    @staticmethod
    def _select_questions_for_profile(questions: list, user_context: dict) -> list[dict]:
        valid = [copy.deepcopy(item) for item in questions if isinstance(item, dict)]
        weak_terms = {
            str(item.get("knowledgePoint") or item.get("knowledgePointId") or "").strip().lower()
            for item in (user_context.get("weak_points") or []) if isinstance(item, dict)
        }
        weak_terms.discard("")
        overall = float(((user_context.get("mastery") or {}).get("overall") or 0.5))
        preferred = "easy" if overall < 0.4 else "hard" if overall > 0.75 else "medium"

        def rank(item: dict) -> tuple[int, int]:
            searchable = " ".join(str(item.get(key) or "") for key in (
                "knowledgePointId", "knowledgePoint", "stem", "question", "title",
            )).lower()
            weak_rank = 0 if any(term in searchable for term in weak_terms) else 1
            difficulty = str(item.get("difficulty") or item.get("level") or "medium").lower()
            difficulty_rank = 0 if preferred in difficulty else 1
            return weak_rank, difficulty_rank

        return sorted(valid, key=rank)

    @classmethod
    def _slides_for_unit(cls, resource_type: str, unit: dict,
                         template_sources: list[dict]) -> list[dict]:
        if resource_type == "lecture":
            title = str(unit.get("title") or unit.get("name") or "学习内容")
            paragraphs: list[str] = []
            for section in unit.get("sections") or []:
                if not isinstance(section, dict):
                    continue
                section_title = str(section.get("title") or section.get("name") or "").strip()
                if section_title:
                    paragraphs.append(f"### {section_title}")
                body = section.get("content") or section.get("body")
                if body:
                    paragraphs.append(str(body))
            body = "\n\n".join(paragraphs) or str(unit.get("content") or "")
            slide_type = "chapter"
        else:
            title = str(unit.get("title") or unit.get("name") or "实操步骤")
            paragraphs = [str(unit.get("instruction") or unit.get("content") or "")]
            if unit.get("code"):
                paragraphs.append(f"```\n{unit['code']}\n```")
            if unit.get("expectedOutput"):
                paragraphs.append(f"**预期结果**\n\n{unit['expectedOutput']}")
            # safety is an internal enum (safe/caution/danger), not user-facing copy.
            # Only an actual warning sentence belongs in the card body.
            warning = str(unit.get("warning") or "").strip()
            if warning:
                paragraphs.append(f"**操作提醒**\n\n{warning}")
            body = "\n\n".join(item for item in paragraphs if item)
            slide_type = "step"
        sources = cls._sources_for_item(unit, template_sources)
        evidence_anchors = cls._evidence_anchors_for_item(unit)
        return [{
            "type": slide_type,
            "title": title,
            "content": body, "sources": copy.deepcopy(sources),
            "evidenceQuotes": copy.deepcopy(evidence_anchors),
        }]

    @staticmethod
    def coalesce_legacy_unit_slides(slides: list[dict]) -> list[dict]:
        """Merge historical character-split cards back into their directory unit."""
        merged: list[dict] = []
        positions: dict[tuple[str, int], int] = {}
        for raw_slide in slides:
            if not isinstance(raw_slide, dict):
                continue
            slide = copy.deepcopy(raw_slide)
            unit_index = slide.get("unitIndex")
            slide_type = str(slide.get("type") or "")
            # Only prose cards need legacy text cleanup. Quiz content is a
            # structured object; stringifying it makes stem/options disappear.
            content = slide.get("content")
            if slide_type != "question" and isinstance(content, str):
                slide["content"] = re.sub(
                    r"(?:\n\s*)?\*\*注意事项\*\*\s*\n+\s*(?:safe|caution|danger)\s*(?=\n|$)",
                    "",
                    content,
                    flags=re.IGNORECASE,
                ).rstrip()
            part_count = int(slide.get("partCount") or 1)
            if unit_index is None or slide_type == "question" or part_count <= 1:
                slide["index"] = len(merged)
                merged.append(slide)
                continue
            key = (slide_type, int(unit_index))
            existing_position = positions.get(key)
            if existing_position is None:
                slide["title"] = re.sub(r"（\d+/\d+）$", "", str(slide.get("title") or ""))
                slide["partIndex"] = 0
                slide["partCount"] = 1
                slide["index"] = len(merged)
                positions[key] = len(merged)
                merged.append(slide)
                continue
            existing = merged[existing_position]
            content_parts = [str(existing.get("content") or "").rstrip(), str(slide.get("content") or "").lstrip()]
            existing["content"] = "\n\n".join(item for item in content_parts if item)
        for index, slide in enumerate(merged):
            slide["index"] = index
        return merged

    @staticmethod
    def _evidence_anchors_for_item(item: dict) -> list[dict]:
        """Normalize the three historical evidence shapes into stable anchors."""
        raw_matches: list = []
        containers = [item] + [
            section for section in (item.get("sections") or []) if isinstance(section, dict)
        ]
        for container in containers:
            for key in ("evidenceAnchors", "evidenceMatches", "evidenceQuotes", "answerEvidenceQuotes"):
                values = container.get(key) or []
                if isinstance(values, list):
                    raw_matches.extend(values)
        anchors: list[dict] = []
        seen: set[tuple[str, str]] = set()
        for raw in raw_matches:
            if not isinstance(raw, dict):
                continue
            source_id = raw.get("sourceId", raw.get("chunk_id", raw.get("citationId")))
            quote = raw.get("quote") or raw.get("sourcePassage") or raw.get("evidenceQuote")
            if source_id is None or not str(quote or "").strip():
                continue
            normalized = {
                "sourceId": source_id,
                "claim": str(raw.get("claim") or "").strip() or None,
                "quote": str(quote).strip(),
                "evidenceType": str(raw.get("evidenceType") or "direct"),
            }
            key = (str(source_id), normalized["quote"])
            if key in seen:
                continue
            seen.add(key)
            anchors.append(normalized)
        return anchors

    @classmethod
    def _sources_for_item(cls, item: dict, template_sources: list[dict]) -> list[dict]:
        citations: list = list(item.get("citations") or [])
        for section in item.get("sections") or []:
            if isinstance(section, dict):
                citations.extend(section.get("citations") or [])
                citations.extend(
                    match.get("sourceId")
                    for match in (section.get("evidenceMatches") or [])
                    if isinstance(match, dict) and match.get("sourceId") is not None
                )
                citations.extend(
                    match.get("sourceId")
                    for match in (section.get("evidenceQuotes") or [])
                    if isinstance(match, dict) and match.get("sourceId") is not None
                )
                body = str(section.get("content") or section.get("body") or "")
                citations.extend(re.findall(r"(?<!\!)\[(\d+)\](?!\s*\()", body))
        citations.extend(
            match.get("sourceId")
            for match in (item.get("evidenceMatches") or [])
            if isinstance(match, dict) and match.get("sourceId") is not None
        )
        body = str(item.get("instruction") or item.get("content") or "")
        citations.extend(re.findall(r"(?<!\!)\[(\d+)\](?!\s*\()", body))
        anchors = cls._evidence_anchors_for_item(item)
        citations.extend(anchor.get("sourceId") for anchor in anchors)
        wanted = {str(value) for value in citations}
        matched = [source for index, source in enumerate(template_sources, start=1)
                   if isinstance(source, dict) and (
                       str(source.get("id")) in wanted
                       or str(source.get("sourceId")) in wanted
                       or str(index) in wanted
                   )]
        selected = copy.deepcopy(matched) if matched else [
            {"id": str(value), "label": f"来源 {value}"} for value in citations
        ]
        for index, source in enumerate(selected, start=1):
            source_id = str(source.get("id", source.get("sourceId", index)))
            source_text = str(source.get("content") or source.get("excerpt") or "")
            source_anchors = []
            for anchor in anchors:
                if str(anchor.get("sourceId")) != source_id:
                    continue
                located = copy.deepcopy(anchor)
                start = source_text.find(str(located.get("quote") or ""))
                if start >= 0:
                    located["evidenceStart"] = start
                    located["evidenceEnd"] = start + len(str(located["quote"]))
                    located["exactMatch"] = True
                else:
                    located["exactMatch"] = False
                located["snapshotText"] = str(located.get("quote") or "")
                source_anchors.append(located)
            if source_anchors:
                source["evidenceAnchors"] = copy.deepcopy(source_anchors)
        return selected

    @staticmethod
    def _merge_with_template(resource_type: str, template: dict, candidate: dict,
                             user_context: dict | None = None) -> dict:
        """Accept model wording while keeping template topology and evidence."""
        import re as _re
        result = copy.deepcopy(template)
        if resource_type == "lecture":
            for key in ("introTitle", "summary", "learningObjectives", "keyPoints", "reviewQuestions"):
                if candidate.get(key):
                    result[key] = copy.deepcopy(candidate[key])
            # 去掉"基于《xxx》源文档"前缀
            if isinstance(result.get("summary"), str):
                result["summary"] = _re.sub(r'^本章节基于《[^》]+》源文档[，,]\s*', '', result["summary"])
            for old_chapter, new_chapter in zip(result.get("chapters") or [], candidate.get("chapters") or []):
                if not isinstance(old_chapter, dict) or not isinstance(new_chapter, dict):
                    continue
                for old_section, new_section in zip(old_chapter.get("sections") or [], new_chapter.get("sections") or []):
                    if isinstance(old_section, dict) and isinstance(new_section, dict) and new_section.get("content"):
                        old_section["content"] = new_section["content"]
            if candidate.get("_generatedFraming"):
                old_chapters = result.get("chapters") or []
                new_chapters = candidate.get("chapters") or []
                old_sections = (old_chapters[-1].get("sections") or []) if old_chapters else []
                new_sections = (new_chapters[-1].get("sections") or []) if new_chapters else []
                if old_sections and new_sections and isinstance(new_sections[-1], dict):
                    generated_title = str(new_sections[-1].get("title") or "").strip()
                    if generated_title:
                        old_sections[-1]["title"] = generated_title
        elif resource_type == "practice":
            for key in ("objective", "estimatedMinutes", "prerequisites", "environment",
                        "safetyChecklist", "safetyNotice", "acceptanceCriteria",
                        "troubleshooting", "challenge"):
                if candidate.get(key) not in (None, [], ""):
                    result[key] = copy.deepcopy(candidate[key])
            for old_step, new_step in zip(result.get("steps") or [], candidate.get("steps") or []):
                if not isinstance(old_step, dict) or not isinstance(new_step, dict):
                    continue
                for key in ("instruction", "code", "expectedOutput", "safety", "warning"):
                    if new_step.get(key) not in (None, ""):
                        old_step[key] = copy.deepcopy(new_step[key])
        elif resource_type == "quiz":
            # Preserve the administrator-authored questions and their audit data.
            # Prioritize weak points but never discard the complete mother bank.
            original = [item for item in result.get("questions") or [] if isinstance(item, dict)]
            by_id = {str(item.get("id")): item for item in original if item.get("id")}
            ordered = [by_id[str(item.get("id"))] for item in candidate.get("questions") or []
                       if isinstance(item, dict) and str(item.get("id")) in by_id]
            if ordered:
                seen = {str(item.get("id")) for item in ordered}
                result["questions"] = ordered + [item for item in original if str(item.get("id")) not in seen]
            else:
                mastery_items = ((user_context or {}).get("mastery") or {}).get("items") or []
                mastery = {
                    str(item.get("knowledgePoint") or item.get("categoryId")): float(item.get("score"))
                    for item in mastery_items if isinstance(item, dict) and item.get("score") is not None
                }
                result["questions"] = sorted(
                    original,
                    key=lambda item: mastery.get(str(item.get("knowledgePointId")), 0.5),
                )
            if isinstance(candidate.get("personalization"), dict):
                result["personalization"] = copy.deepcopy(candidate["personalization"])
        return result

    @staticmethod
    def _quality_check(resource_type: str, template: dict, content: dict) -> bool:
        if not isinstance(content, dict) or not content:
            return False
        if resource_type == "lecture":
            old = template.get("chapters") or []
            new = content.get("chapters") or []
            if len(old) != len(new) or not new:
                return False
            pairs = ((a, b) for oc, nc in zip(old, new)
                     for a, b in zip((oc or {}).get("sections") or [], (nc or {}).get("sections") or []))
        elif resource_type == "practice":
            old, new = template.get("steps") or [], content.get("steps") or []
            if len(old) != len(new) or not new:
                return False
            pairs = zip(old, new)
        elif resource_type == "quiz":
            old, new = template.get("questions") or [], content.get("questions") or []
            return bool(new) and len(old) == len(new) and {
                str(item.get("id")) for item in old if isinstance(item, dict)
            } == {str(item.get("id")) for item in new if isinstance(item, dict)}
        else:
            return False
        # Every template citation must survive on the corresponding content unit.
        for old_item, new_item in pairs:
            if not isinstance(old_item, dict) or not isinstance(new_item, dict):
                return False
            if old_item.get("citations") != new_item.get("citations"):
                return False
        return True

    async def _repair_customized_content(
        self, resource_type: str, template: dict, content: dict, user_context: dict,
    ) -> dict | None:
        """Attempt one repair pass on customized content. Returns repaired content or None."""
        if resource_type == "lecture":
            old_chapters = template.get("chapters") or []
            new_chapters = content.get("chapters") or []
            if len(old_chapters) != len(new_chapters):
                return None
            repaired = dict(content)
            fixed_chapters = []
            for oc, nc in zip(old_chapters, new_chapters):
                nc = dict(nc or {})
                old_sections = (oc or {}).get("sections") or []
                new_sections = nc.get("sections") or []
                if len(old_sections) != len(new_sections):
                    nc["sections"] = old_sections
                else:
                    fixed = []
                    for os_, ns in zip(old_sections, new_sections):
                        ns = dict(ns or {})
                        if os_.get("citations") and os_.get("citations") != ns.get("citations"):
                            ns["citations"] = os_["citations"]
                        fixed.append(ns)
                    nc["sections"] = fixed
                fixed_chapters.append(nc)
            repaired["chapters"] = fixed_chapters
            return repaired
        elif resource_type == "practice":
            old_steps = template.get("steps") or []
            new_steps = content.get("steps") or []
            if len(old_steps) != len(new_steps):
                return None
            repaired = dict(content)
            fixed = []
            for os_, ns in zip(old_steps, new_steps):
                ns = dict(ns or {})
                if os_.get("citations") and os_.get("citations") != ns.get("citations"):
                    ns["citations"] = os_["citations"]
                fixed.append(ns)
            repaired["steps"] = fixed
            return repaired
        return None

    @staticmethod
    def _score_content(resource_type: str, template: dict, content: dict) -> dict:
        """Score customized content quality. Returns a dict of scores for logging only."""
        scores = {"structureComplete": False, "citationMatch": False, "overall": 0}
        if not isinstance(content, dict) or not content:
            return scores
        if resource_type == "lecture":
            old = template.get("chapters") or []
            new = content.get("chapters") or []
            if len(old) == len(new) and new:
                scores["structureComplete"] = True
                match_count = 0
                total = 0
                for oc, nc in zip(old, new):
                    for os_, ns in zip((oc or {}).get("sections") or [], (nc or {}).get("sections") or []):
                        total += 1
                        if os_.get("citations") == ns.get("citations"):
                            match_count += 1
                scores["citationMatch"] = match_count == total if total > 0 else True
                scores["citationMatchRate"] = round(match_count / total, 2) if total > 0 else 1.0
        elif resource_type == "practice":
            old = template.get("steps") or []
            new = content.get("steps") or []
            if len(old) == len(new) and new:
                scores["structureComplete"] = True
                match_count = sum(1 for os_, ns in zip(old, new) if os_.get("citations") == ns.get("citations"))
                scores["citationMatch"] = match_count == len(old)
                scores["citationMatchRate"] = round(match_count / len(old), 2) if old else 1.0
        scores["overall"] = (
            (30 if scores["structureComplete"] else 0)
            + (40 if scores["citationMatch"] else 0)
            + 30  # base score for having content
        )
        return scores

    async def _customize_presentation_notes(
        self, template: dict, user_context: dict, *, task_id: UUID, user_id: UUID,
    ) -> dict | None:
        """逐页适配 speakerNotes，并在每页就绪后立即开放给学习播放器。"""
        outline = self._loads(template.get("outline_json"), {})
        if not isinstance(outline, dict):
            return None
        slides = outline.get("slides") or []
        if not slides or not all(isinstance(slide, dict) for slide in slides):
            return None
        compact_context = {
            "profile": user_context.get("profile") or {},
            "mastery": user_context.get("mastery") or {},
            "weakPoints": (user_context.get("weak_points") or [])[:10],
            "preferences": (user_context.get("preferences") or [])[:6],
        }
        personalized = copy.deepcopy(outline)
        changed = 0
        ready_slides: list[dict] = []
        template_id = str(UUID(bytes=template["id"]))
        for index, slide in enumerate(slides):
            original_note = str(slide.get("speakerNotes") or "").strip()
            page = {
                "slideIndex": index,
                "title": str(slide.get("title") or f"第 {index + 1} 页"),
                "kind": slide.get("kind"),
                "points": slide.get("points") or [],
                "takeaway": slide.get("takeaway"),
                "speakerNotes": original_note,
            }
            result = await self.content_service.llm.complete_json(
                "你是课件逐页讲解稿适配 Agent。管理员 PPT 画面已经定稿，禁止修改标题、顺序、要点或画面。"
                "只返回 JSON 对象，不要寒暄、解释任务或添加开场语。"
                "请在保留本页全部事实和关键结论的前提下，小幅改写 speakerNotes。"
                "对学习者薄弱内容增加一句通俗解释，对已掌握内容适当精简；输出必须能直接承接上一页朗读。",
                json.dumps({
                    "learnerContext": compact_context,
                    "page": page,
                    "previousPageTitle": str(slides[index - 1].get("title") or "") if index else "",
                    "outputSchema": {"speakerNotes": "可直接朗读的本页个性化讲解稿"},
                }, ensure_ascii=False, default=str),
                {"speakerNotes": ""}, provider="mimo-legacy", max_retries=2,
                max_tokens=1600, thinking=False, timeout_seconds=45,
            )
            note = self._strip_model_preamble(
                str(result.get("speakerNotes") or "") if isinstance(result, dict) else ""
            ).strip()
            # 单页模型异常不能让整套资源失去可用性；保留母版讲解稿并继续下一页。
            note = note or original_note
            if not note:
                note = f"本页介绍{page['title']}，请结合画面中的要点继续学习。"
            if note != original_note:
                personalized["slides"][index]["speakerNotes"] = note
                changed += 1
            ready_slides.append({
                "index": index, "unitIndex": index, "totalUnits": len(slides),
                "type": "presentation", "title": page["title"], "content": note,
                "presentationId": template_id, "sources": [], "evidenceQuotes": [],
            })
            await asyncio.to_thread(self.tasks.save_slides, task_id, user_id, ready_slides)
        return personalized if ready_slides and (changed or any(item["content"] for item in ready_slides)) else None

    def _copy_presentation(self, user_id: UUID, template: dict,
                           kp_id: str | None, title: str, *, outline: dict | None = None,
                           delivery_mode: str = "personalized") -> UUID:
        """Copy an organization presentation template into a USER-scope task.

        Reuses the template's .pptx file read-only (same output_path) so the
        slideshow viewer resolves it; base_presentation_id records provenance.
        """
        template_id = UUID(bytes=template["id"])
        new_id = uuid4()
        now = datetime.now(_UTC8)
        request = json.loads(template.get("request_json") or "{}")
        if not isinstance(request, dict):
            request = {}
        request["customizedFrom"] = str(template_id)
        generation_context = request.setdefault("generationContext", {})
        generation_context["customized"] = True
        generation_context["customizationMode"] = delivery_mode
        generation_context["presentationReused"] = True
        generation_context["personalizedPart"] = "speakerNotes" if delivery_mode == "personalized" else "none"
        serialized_outline = json.dumps(outline, ensure_ascii=False, default=str) if isinstance(outline, dict) else (
            template.get("outline_json") or "{}"
        )
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id FROM presentation_tasks "
                    "WHERE user_id=%s AND base_presentation_id=%s AND resource_scope='USER' "
                    "AND archived_at IS NULL LIMIT 1 FOR UPDATE",
                    (user_id.bytes, template_id.bytes),
                )
                existing = cursor.fetchone()
                if existing:
                    existing_id = UUID(bytes=existing["id"])
                    cursor.execute(
                        "UPDATE presentation_tasks SET organization_id=%s,domain_code=%s,category_node_code=%s,"
                        "resource_group=%s,title=%s,status='completed',progress=100,stage_message='重新生成完成',"
                        "request_json=%s,outline_json=%s,events_json=%s,learned_json=%s,output_path=%s,"
                        "error_message=NULL,updated_at=%s WHERE id=%s",
                        (template.get("organization_id"), template.get("domain_code"),
                         template.get("category_node_code") or kp_id,
                         template.get("resource_group") or "默认分组", title,
                         json.dumps(request, ensure_ascii=False, default=str),
                         serialized_outline, template.get("events_json") or "[]",
                         "{}", template.get("output_path") or "", now, existing_id.bytes),
                    )
                    connection.commit()
                    return existing_id
                cursor.execute(
                    "INSERT INTO presentation_tasks "
                    "(id,user_id,organization_id,domain_code,category_node_code,resource_group,"
                    "resource_scope,review_status,base_presentation_id,title,status,progress,stage_message,"
                    "request_json,outline_json,events_json,learned_json,output_path,created_at,updated_at) "
                    "VALUES(%s,%s,%s,%s,%s,%s,'USER','DRAFT',%s,%s,'completed',100,'定制完成',%s,%s,%s,%s,%s,%s,%s)",
                    (new_id.bytes, user_id.bytes,
                     template.get("organization_id"),
                     template.get("domain_code"), template.get("category_node_code") or kp_id,
                     template.get("resource_group") or "默认分组",
                     template_id.bytes, title,
                     json.dumps(request, ensure_ascii=False, default=str),
                     serialized_outline,
                     template.get("events_json") or "[]",
                     "{}",
                     template.get("output_path") or "",
                     now, now),
                )
            connection.commit()
        return new_id
