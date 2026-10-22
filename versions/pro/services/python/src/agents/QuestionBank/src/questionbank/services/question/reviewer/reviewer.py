"""Question Reviewer —— 防线 3：LLM 审题（DESIGN v2 §14）.

职责：
- 接收题目 + 参考答案 + 解析 + KnowledgeContext
- 四项独立检查：grounded / answer_correct / unambiguous / difficulty_match
- 只审不改：不修改原题，只返回判定与问题列表

失败策略：LLM 调用失败 → 保守拒绝（confidence=0, 全部检查不过），
宁可拒绝不可误放（题目保持 proposed，转人工）。
"""
from __future__ import annotations

from typing import Any

from questionbank.llm import LLMClient
from questionbank.services.knowledge_core.schemas import KnowledgeContext

from .prompts import REVIEW_SYSTEM_PROMPT, build_review_prompt
from .schemas import ReviewVerdict

REVIEW_PROMPT_VERSION = "review-v1"


def _conservative_reject(reason: str) -> ReviewVerdict:
    return ReviewVerdict(
        grounded=False,
        answer_correct=False,
        unambiguous=False,
        difficulty_match=False,
        confidence=0.0,
        issues=[reason],
    )


class QuestionReviewer:
    def __init__(self, llm: LLMClient):
        self.llm = llm

    @staticmethod
    def merge_snapshot_evidence(
        context: KnowledgeContext,
        snapshot: list[dict[str, Any]],
    ) -> KnowledgeContext:
        """把题目证据快照（evidence_refs 回取）合并进审题上下文（去重）.

        审题的 grounded 检查必须基于生成时刻的证据（溯源不断），
        同时保留当前 context（供检测知识变化，阶段 8 重校验使用）。
        """
        if not snapshot:
            return context
        ctx_ids = {e.chunk_id for e in context.evidence if e.chunk_id > 0}
        missing = [e for e in snapshot if e.chunk_id > 0 and e.chunk_id not in ctx_ids]
        if missing:
            # 快照证据（生成依据）前置：prompt 截断时保证优先展示
            context = context.model_copy(update={"evidence": [*missing, *context.evidence]})
        return context

    async def review(
        self,
        question: dict[str, Any],
        context: KnowledgeContext,
    ) -> ReviewVerdict:
        """审题：返回 ReviewVerdict（不落库，由调用方决定处置）."""
        prompt = build_review_prompt(question, context)
        fallback: dict[str, Any] = {
            "grounded": False, "answer_correct": False, "unambiguous": False,
            "difficulty_match": False, "confidence": 0.0,
            "issues": ["LLM 审题调用失败（fallback 保守拒绝）"],
        }
        try:
            raw = await self.llm.complete_json(
                REVIEW_SYSTEM_PROMPT, prompt, fallback, temperature=0.2
            )
        except Exception as exc:  # noqa: BLE001 — LLM 波动 → 保守拒绝
            return _conservative_reject(f"LLM 审题调用失败: {exc}")

        try:
            verdict = ReviewVerdict.model_validate(raw)
        except Exception as exc:  # noqa: BLE001
            return _conservative_reject(f"审题输出结构非法: {exc}")
        # 兜底：判定不一致时（如 issues 非空但 passed），以保守为准
        if verdict.passed and verdict.issues:
            return ReviewVerdict(
                grounded=verdict.grounded,
                answer_correct=verdict.answer_correct,
                unambiguous=verdict.unambiguous,
                difficulty_match=verdict.difficulty_match,
                confidence=verdict.confidence,
                issues=verdict.issues,
                suggested_difficulty=verdict.suggested_difficulty,
            )
        return verdict
