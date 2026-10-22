"""AttemptService —— 作答提交与判分落库（DESIGN v2 §21）.

流程：加载题目（必须 active）→ AnswerJudge（客观规则 / 主观 LLM+KC）→
落库 knowledge_question_attempt → 返回判分结果。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import pymysql

from questionbank.llm import LLMClient
from questionbank.services.knowledge_core import KnowledgeCore, KnowledgeContext
from questionbank.services.mastery import MasteryService
from questionbank.services.question.answer_judge import (
    OBJECTIVE_TYPES,
    Judgment,
    judge_objective,
    judge_subjective,
)
from questionbank.services.question.question_service import QuestionNotFoundError, QuestionService
from questionbank.store import QuestionStore


class QuestionNotActiveError(Exception):
    pass


class AttemptService:
    def __init__(
        self,
        store: QuestionStore,
        service: QuestionService,
        llm: LLMClient | None = None,
        knowledge_core: KnowledgeCore | None = None,
    ):
        self.store = store
        self.service = service
        self.llm = llm
        self.knowledge_core = knowledge_core

    async def submit(
        self,
        user_id: str,
        question_id: int,
        submitted_answer: Any,
        *,
        judge_mode: str = "auto",
        started_at: str | None = None,
        duration_ms: int | None = None,
        conn: pymysql.Connection | None = None,
    ) -> dict[str, Any]:
        """提交作答：客观题即时规则判分；主观题 LLM+KC 判分（judge_mode='none' 仅记录）.

        judge_mode: auto（默认，主观题走 LLM）/ none（主观题不判分，is_correct=NULL）
        """
        own_conn = conn is None
        c = self.store.connect() if own_conn else conn
        try:
            row = self.store.get_question(question_id, conn=c)
            if row is None:
                raise QuestionNotFoundError(f"题目不存在: {question_id}")
            if row["status"] != "active":
                raise QuestionNotActiveError(f"题目未启用（status={row['status']}），不可作答")

            question_type = row["question_type"]
            reference_answer = json.loads(row["reference_answer"])

            judgment: Judgment
            if question_type in OBJECTIVE_TYPES:
                judgment = judge_objective(question_type, reference_answer, submitted_answer)
            else:  # short_answer
                if judge_mode == "none" or self.llm is None:
                    judgment = Judgment(
                        is_correct=None, score=None, judge_mode="none",
                        judge_details={"note": "主观题未判分（judge_mode=none）"},
                    )
                else:
                    context = await self._load_judge_context(question_id, conn=c)
                    if context is None:
                        judgment = Judgment(
                            is_correct=None, score=None, judge_mode="none",
                            judge_details={"note": "主观题未判分（缺少知识点/Knowledge Core 上下文）"},
                        )
                    else:
                        judgment = await judge_subjective(
                            self.llm,
                            dict(row, reference_answer=reference_answer),
                            str(submitted_answer),
                            context,
                        )

            now = datetime.now(timezone.utc)
            attempt_id = self.store.insert_attempt(
                {
                    "user_id": user_id,
                    "question_id": question_id,
                    "submitted_answer": json.dumps(submitted_answer, ensure_ascii=False),
                    "is_correct": judgment.is_correct,
                    "score": judgment.score,
                    "judge_details": json.dumps(judgment.judge_details, ensure_ascii=False)
                    if judgment.judge_details else None,
                    "started_at": started_at,
                    "submitted_at": now.strftime("%Y-%m-%d %H:%M:%S"),
                    "duration_ms": duration_ms,
                },
                conn=c,
            )
            # T4.1：提交作答后增量更新该题关联知识点的掌握度（半衰期14天加权正确率×置信折扣）。
            # 与主流程同事务：own_conn 时随下方 commit 一并落库；失败不吞掉主流程之外的行为，
            # 但也不应因掌握度计算异常阻断作答提交——静默降级，仅作答记录保证落库。
            try:
                mastery_service = MasteryService(self.store)
                for point in self.store.list_knowledge_points(question_id, conn=c):
                    mastery_service.update_state(user_id, point["category_id"], conn=c)
            except Exception:  # noqa: BLE001
                pass
            if own_conn:
                c.commit()
            return {
                "attempt_id": attempt_id,
                "question_id": question_id,
                "is_correct": judgment.is_correct,
                "score": judgment.score,
                "judge_mode": judgment.judge_mode,
                "judge_details": judgment.judge_details,
                # 作答完成后展示解析（取题接口不泄题，此处为答后复盘）
                "reference_answer": reference_answer,
                "explanation": row.get("explanation"),
            }
        finally:
            if own_conn:
                c.close()

    async def _load_judge_context(
        self, question_id: int, conn: pymysql.Connection | None = None
    ) -> KnowledgeContext | None:
        """主观判题上下文：primary 知识点的当前 evidence（DESIGN §23）."""
        if self.knowledge_core is None:
            return None
        points = self.store.list_knowledge_points(question_id, conn=conn)
        primary = next((p for p in points if p["role"] == "primary"), None)
        if primary is None:
            return None
        return await self.knowledge_core.get_context(
            category_id=primary["category_id"], purpose="judge"
        )
