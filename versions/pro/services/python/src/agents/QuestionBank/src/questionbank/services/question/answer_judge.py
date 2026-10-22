"""Answer Judge —— 判题（DESIGN v2 §22~§24 / §26）.

- 客观题（single_choice / multiple_choice / true_false）：纯代码判定，不调 LLM
  稳定 / 便宜 / 可重复 / 可测试
- 主观题（short_answer）：LLM + KnowledgeContext 联合判定
  （学生可用不同于参考答案的正确表达，KC evidence 可证明正确）

与 Question Reviewer（审题）完全独立：Judge 判断"用户答得对不对"。
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from questionbank.llm import LLMClient
from questionbank.services.knowledge_core.schemas import KnowledgeContext

JudgeMode = Literal["rule", "llm", "none"]


class Judgment(BaseModel):
    """判题结果（落库 question_attempt.is_correct / score / judge_details）."""

    is_correct: bool | None = Field(None, description="是否答对（主观题未判时为 None）")
    score: float | None = Field(None, ge=0.0, le=1.0, description="得分 0~1")
    judge_mode: JudgeMode = Field(..., description="rule=客观规则 / llm=主观AI判 / none=仅记录")
    judge_details: dict[str, Any] | None = Field(
        default=None, description="主观题：matched_points / missing_points / feedback / rationale"
    )


OBJECTIVE_TYPES = ("single_choice", "multiple_choice", "true_false")


def _normalize_submitted(question_type: str, submitted: Any) -> Any:
    if question_type == "single_choice":
        return str(submitted).strip().upper() if submitted is not None else ""
    if question_type == "multiple_choice":
        if isinstance(submitted, str):
            submitted = [s.strip() for s in submitted.split(",") if s.strip()]
        if not isinstance(submitted, (list, tuple)):
            return []
        return sorted(str(s).strip().upper() for s in submitted)
    if question_type == "true_false":
        if isinstance(submitted, bool):
            return submitted
        if submitted in (0, 1):
            return bool(submitted)
        return str(submitted).strip().lower() in ("true", "1", "对", "正确")
    return submitted


def judge_objective(question_type: str, reference_answer: Any, submitted: Any) -> Judgment:
    """客观题规则判分（纯代码）."""
    if question_type == "single_choice":
        ok = _normalize_submitted(question_type, submitted) == str(reference_answer).strip().upper()
    elif question_type == "multiple_choice":
        ref = sorted(str(s).strip().upper() for s in reference_answer)
        ok = _normalize_submitted(question_type, submitted) == ref
    elif question_type == "true_false":
        ok = _normalize_submitted(question_type, submitted) == bool(reference_answer)
    else:
        raise ValueError(f"客观判分不支持题型: {question_type}")
    return Judgment(
        is_correct=bool(ok),
        score=1.0 if ok else 0.0,
        judge_mode="rule",
        judge_details={"rule": question_type, "submitted_normalized": _normalize_submitted(question_type, submitted)},
    )


SUBJECTIVE_JUDGE_PROMPT = """你是一名严谨的作业批改老师。请对学生的主观题作答进行评阅。

判定规则：
1. 学生答案不必与参考答案逐字一致，只要表达出关键得分点即可判对。
2. 学生答案中的表述如能被 Knowledge Evidence 证实正确，即使参考答案未提及，也应采纳。
3. 输出分数 score（0~1）与是否算对 is_correct（通常 score ≥ 0.6 视为正确，但可结合题目灵活）。
4. 明确指出学生答对的得分点（matched_points）与遗漏点（missing_points），并给出简短反馈。

输出要求：只输出一个 JSON 对象，不要输出其他文字：
{
  "score": 0.8,
  "is_correct": true,
  "matched_points": ["…", "…"],
  "missing_points": ["…"],
  "feedback": "对学生的简短评语"
}"""


def build_subjective_prompt(
    question: dict[str, Any],
    submitted: str,
    context: KnowledgeContext,
) -> str:
    lines = [
        "# 题目",
        f"题干：{question.get('stem', '')}",
        f"参考答案：{question.get('reference_answer')}",
    ]
    if question.get("explanation"):
        lines.append(f"解析：{question.get('explanation')}")
    lines.append(f"\n# 学生答案\n{submitted}")
    lines.append(f"\n# 目标知识点\n{context.knowledge_point.name} (ID={context.knowledge_point.id})")
    lines.append("\n# Knowledge Evidence（用于判断学生表述是否正确）")
    for idx, ev in enumerate(context.evidence[:5], start=1):
        ref = ev.chunk_id if ev.chunk_id > 0 else (ev.ragflow_chunk_id or "rag")
        lines.append(f"[{idx}] id={ref}\n{ev.content.strip()[:600]}")
    lines.append("\n请输出 JSON 评阅结果。")
    return "\n".join(lines)


async def judge_subjective(
    llm: LLMClient,
    question: dict[str, Any],
    submitted: str,
    context: KnowledgeContext,
) -> Judgment:
    """主观题 LLM 判分（用户答案 + 参考答案 + Knowledge Evidence 联合判断）."""
    prompt = build_subjective_prompt(question, submitted, context)
    fallback: dict[str, Any] = {
        "score": None, "is_correct": None,
        "matched_points": [], "missing_points": [],
        "feedback": "AI 评阅失败，请人工批改",
    }
    try:
        raw = await llm.complete_json(SUBJECTIVE_JUDGE_PROMPT, prompt, fallback, temperature=0.2)
    except Exception as exc:  # noqa: BLE001 — LLM 波动 → 不判分，转人工
        return Judgment(is_correct=None, score=None, judge_mode="llm",
                         judge_details={"error": f"AI 评阅调用失败: {exc}"})
    try:
        score = float(raw.get("score"))
        if not 0.0 <= score <= 1.0:
            score = None
        is_correct = raw.get("is_correct")
        if is_correct is not None:
            is_correct = bool(is_correct)
        details = {
            "matched_points": raw.get("matched_points") or [],
            "missing_points": raw.get("missing_points") or [],
            "feedback": raw.get("feedback") or "",
            "rationale": raw.get("rationale"),
        }
        return Judgment(
            is_correct=is_correct,
            score=score,
            judge_mode="llm",
            judge_details=details,
        )
    except (TypeError, ValueError):  # noqa: BLE001
        return Judgment(is_correct=None, score=None, judge_mode="llm",
                         judge_details={"error": "AI 评阅输出结构非法"})
