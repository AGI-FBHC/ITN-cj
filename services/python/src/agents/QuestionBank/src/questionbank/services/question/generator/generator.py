"""Question Generator —— 出题工作流（DESIGN v2 §5 / §9 / §12 阶段 3）.

输入只有 KnowledgeContext + 生成要求（禁止自行访问数据库 / RAGFlow）。
流程：参数校验 → KC get_context → 覆盖度检查 → LLM 生成 → 防线1 Schema →
防线2 Evidence → 去重 → 入库（proposed, source_type=llm, 证据快照 + 生成元数据）。
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Any

import pymysql

from questionbank.llm import LLMClient
from questionbank.services.knowledge_core import KnowledgeCore, KnowledgeContext
from questionbank.services.question.models import (
    EvidenceRef,
    KnowledgePointRef,
    QuestionCreate,
)
from questionbank.services.question.question_service import (
    DuplicateQuestionError,
    QuestionService,
)
from questionbank.services.question.validators import (
    COGNITIVE_LEVELS,
    QUESTION_TYPES,
    ValidationError,
)

from .prompts import SYSTEM_PROMPT, build_user_prompt
from .schemas import GeneratedQuestion, GeneratedQuestions

PROMPT_VERSION = "question-v1"
KNOWLEDGE_CORE_VERSION = "v1"

# 覆盖度不足时不生成（DESIGN v2 §9 失败策略：不放宽约束）
INSUFFICIENT_EVIDENCE = "QUESTION_GENERATION_INSUFFICIENT_EVIDENCE"


class GenerationRejected(Exception):
    """覆盖度不足 / 参数非法，不调用 LLM 直接拒绝."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _match_evidence(context: KnowledgeContext, ref: int | str) -> dict[str, Any] | None:
    """将 LLM 返回的 evidence 引用匹配到 context 中的真实证据（防线2）."""
    if isinstance(ref, int):
        return next((e for e in context.evidence if e.chunk_id == ref), None)
    ref_str = str(ref).strip()
    if ref_str.isdigit():
        return next((e for e in context.evidence if e.chunk_id == int(ref_str)), None)
    return next((e for e in context.evidence if e.ragflow_chunk_id == ref_str), None)


def _normalize_answer(question_type: str, answer: list[str]) -> Any:
    """LLM 统一返回数组 → 按题型归一化（单选/判断/简答取单值，多选保留列表）."""
    if question_type == "multiple_choice":
        return answer
    return answer[0] if answer else ""


def _knowledge_context_hash(context: KnowledgeContext) -> str:
    canonical = json.dumps(context.model_dump(), ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class QuestionGenerator:
    MAX_ROUNDS = 2  # 首轮失败后按题型重试一轮（LLM 单题格式错误常见，重试显著提高产出率）

    def __init__(self, llm: LLMClient, service: QuestionService, settings: Any):
        self.llm = llm
        self.service = service
        self.settings = settings

    async def generate(
        self,
        knowledge_core: KnowledgeCore,
        *,
        category_id: int | None = None,
        knowledge_point: str | None = None,
        question_type: str | None = None,
        difficulty: int = 3,
        cognitive_level: str | None = None,
        count: int = 5,
        created_by: str = "llm",
        conn: pymysql.Connection | None = None,
    ) -> dict[str, Any]:
        """出题并入库，返回 {created, skipped, failed, coverage, trace}."""
        # ① 参数校验
        if count < 1 or count > 20:
            raise GenerationRejected("INVALID_COUNT", "count 必须为 1~20")
        if not 1 <= difficulty <= 5:
            raise GenerationRejected("INVALID_DIFFICULTY", "difficulty 必须为 1~5")
        if question_type and question_type not in QUESTION_TYPES:
            raise GenerationRejected("INVALID_TYPE", f"非法题型: {question_type}")
        if cognitive_level and cognitive_level not in COGNITIVE_LEVELS:
            raise GenerationRejected("INVALID_COGNITIVE", f"非法认知层级: {cognitive_level}")
        if category_id is None and not knowledge_point:
            raise GenerationRejected("MISSING_TARGET", "必须提供 category_id 或 knowledge_point")

        # ② Knowledge Core 获取上下文
        context = await knowledge_core.get_context(
            category_id=category_id,
            knowledge_point=knowledge_point,
            purpose="question_generation",
        )

        # ③ 覆盖度检查（失败策略：empty/weak 一律拒绝，不放宽约束）
        if not context.is_usable():
            raise GenerationRejected(
                INSUFFICIENT_EVIDENCE,
                f"知识点覆盖度不足（{context.coverage.coverage_level}），拒绝生成；"
                f"请先为知识点补充知识切片（strategy={context.trace.strategy}）",
            )
        if context.coverage.coverage_level != "sufficient":
            raise GenerationRejected(
                INSUFFICIENT_EVIDENCE,
                f"知识点覆盖度 {context.coverage.coverage_level}（direct="
                f"{context.coverage.direct_chunk_count}），拒绝生成；"
                "RAG 兜底不足以支撑出题质量底线",
            )

        generation_metadata = {
            "model": self.settings.llm_model,
            "prompt_version": PROMPT_VERSION,
            "knowledge_context_hash": _knowledge_context_hash(context),
            "knowledge_core_version": KNOWLEDGE_CORE_VERSION,
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }

        created: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        failed: list[dict[str, Any]] = []

        # ④ 首轮生成（指定题型或混合）
        await self._generate_round(
            context, question_type=question_type, difficulty=difficulty,
            cognitive_level=cognitive_level, count=count, created_by=created_by,
            generation_metadata=generation_metadata, conn=conn,
            created=created, skipped=skipped, failed=failed,
        )

        # ⑤ 重试轮：失败的题按题型分组补生成（最多 1 轮，避免无限循环）
        retryable = [f for f in failed if f.get("question_type") in QUESTION_TYPES]
        if retryable and self.MAX_ROUNDS >= 2:
            by_type: dict[str, int] = {}
            for f in retryable:
                by_type[f["question_type"]] = by_type.get(f["question_type"], 0) + 1
            for qtype, n in by_type.items():
                await self._generate_round(
                    context, question_type=qtype, difficulty=difficulty,
                    cognitive_level=cognitive_level, count=n, created_by=created_by,
                    generation_metadata=generation_metadata, conn=conn,
                    created=created, skipped=skipped, failed=failed,
                )

        return {
            "created": created,
            "skipped": skipped,
            "failed": failed,
            "coverage": context.coverage.model_dump(),
            "trace": context.trace.model_dump(),
        }

    async def _generate_round(
        self,
        context: KnowledgeContext,
        *,
        question_type: str | None,
        difficulty: int,
        cognitive_level: str | None,
        count: int,
        created_by: str,
        generation_metadata: dict[str, Any],
        conn: pymysql.Connection | None,
        created: list[dict[str, Any]],
        skipped: list[dict[str, Any]],
        failed: list[dict[str, Any]],
    ) -> None:
        """生成一轮：prompt → LLM → 防线1/2 → 去重 → 入库（结果追加到各列表）."""
        prompt = build_user_prompt(
            context,
            question_type=question_type,
            difficulty=difficulty,
            cognitive_level=cognitive_level,
            count=count,
        )
        fallback: dict[str, Any] = {"questions": []}
        try:
            raw = await self.llm.complete_json(SYSTEM_PROMPT, prompt, fallback)
        except Exception as exc:  # noqa: BLE001 — LLM 波动/不可达按批次失败返回
            failed.append({"index": -1, "error": f"LLM 调用失败: {exc}", "question_type": question_type})
            return
        try:
            generated = GeneratedQuestions.model_validate(raw)
        except Exception as exc:  # noqa: BLE001
            failed.append({"index": -1, "error": f"LLM 输出结构非法: {exc}", "question_type": question_type})
            return

        for idx, q in enumerate(generated.questions):
            try:
                data = self._to_question_create(context, q, generation_metadata, created_by)
                record = self.service.create(data, conn=conn)
                created.append({"index": idx, "question_id": record["id"]})
            except DuplicateQuestionError as exc:
                skipped.append({"index": idx, "reason": str(exc)})
            except ValidationError as exc:
                failed.append({"index": idx, "error": f"校验失败: {exc}", "question_type": q.question_type})
            except Exception as exc:  # noqa: BLE001 — 单题失败不影响其余
                failed.append({"index": idx, "error": f"{type(exc).__name__}: {exc}", "question_type": q.question_type})

    def _to_question_create(
        self,
        context: KnowledgeContext,
        q: GeneratedQuestion,
        generation_metadata: dict[str, Any],
        created_by: str,
    ) -> QuestionCreate:
        """防线2（Evidence 子集校验）在此完成：非法引用剔除，无有效证据则拒题."""
        # 证据匹配（LLM 不能自创证据 ID）
        matched: list[EvidenceRef] = []
        seen: set[str] = set()
        for ref in q.evidence_chunk_ids[:10]:
            ev = _match_evidence(context, ref)
            if ev is None:
                continue
            key = f"{ev.chunk_id}:{ev.ragflow_chunk_id or ''}"
            if key in seen:
                continue
            seen.add(key)
            matched.append(
                EvidenceRef(
                    chunk_id=ev.chunk_id,
                    document_id=ev.document_id,
                    score=ev.score,
                    source=ev.source,
                )
            )
        if not matched:
            raise ValidationError("题目未引用任何有效证据（evidence_chunk_ids 不在上下文内）")

        # 知识点关联：primary 取目标知识点；LLM 返回的 secondary 也必须是 context 内（目标或前置）
        valid_secondary = {p.id for p in context.prerequisites}
        knowledge_points: list[KnowledgePointRef] = [
            KnowledgePointRef(category_id=context.knowledge_point.id, role="primary", weight=1.0)
        ]
        for cid in q.secondary_category_ids[:10]:
            if cid == context.knowledge_point.id:
                continue
            if cid not in valid_secondary:
                continue
            knowledge_points.append(KnowledgePointRef(category_id=cid, role="secondary", weight=0.5))

        return QuestionCreate(
            question_type=q.question_type,
            difficulty=q.difficulty,
            cognitive_level=q.cognitive_level,
            stem=q.stem,
            options=[{"key": o.key.upper(), "text": o.content} for o in q.options]
            if q.options is not None else None,
            reference_answer=_normalize_answer(q.question_type, q.reference_answer),
            explanation=q.explanation,
            status="proposed",  # LLM 题必须 proposed（防线：create 内二次校验）
            source_type="llm",
            evidence_refs=matched,
            generation_metadata=generation_metadata,
            knowledge_points=knowledge_points or None,
            created_by=created_by,
        )


def new_request_id() -> str:
    return uuid.uuid4().hex[:16]
