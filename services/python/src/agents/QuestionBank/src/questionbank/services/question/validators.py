"""防线 1：Schema 校验（DESIGN v2 §5）——纯代码，零 LLM，失败直接丢弃/retry.

覆盖规则：
- 题型合法（single_choice / multiple_choice / true_false / short_answer）
- difficulty 1~5
- cognitive_level 合法
- stem 非空
- 单选：options ≥ 2，答案数量 = 1，答案必须存在于选项 key
- 多选：options ≥ 2，答案数量 ≥ 2，答案 ⊆ 选项 key（去重）
- 判断：答案仅 true / false
- 简答：答案非空字符串
"""
from __future__ import annotations

from typing import Any, Literal

QUESTION_TYPES = ("single_choice", "multiple_choice", "true_false", "short_answer")
COGNITIVE_LEVELS = ("remember", "understand", "apply", "analyze", "evaluate", "create")
STATUSES = ("proposed", "active", "rejected", "deprecated")
SOURCE_TYPES = ("human", "llm", "imported")

QuestionType = Literal["single_choice", "multiple_choice", "true_false", "short_answer"]


class ValidationError(ValueError):
    """题目结构不合法（防线 1 失败）."""


def validate_question_type(question_type: str) -> QuestionType:
    if question_type not in QUESTION_TYPES:
        raise ValidationError(f"非法题型: {question_type}，允许 {QUESTION_TYPES}")
    return question_type  # type: ignore[return-value]


def validate_difficulty(difficulty: int) -> int:
    try:
        d = int(difficulty)
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"难度必须为整数 1~5，收到: {difficulty!r}") from exc
    if not 1 <= d <= 5:
        raise ValidationError(f"难度必须为 1~5，收到: {d}")
    return d


def validate_cognitive_level(cognitive_level: str | None) -> str:
    level = (cognitive_level or "remember").strip().lower()
    if level not in COGNITIVE_LEVELS:
        raise ValidationError(f"非法认知层级: {cognitive_level}，允许 {COGNITIVE_LEVELS}")
    return level


def validate_options(options: Any) -> list[dict[str, str]]:
    """选择题选项结构：非空列表，每项含非空 key/text，key 唯一."""
    if not isinstance(options, list) or len(options) < 2:
        raise ValidationError("选择题 options 必须为 ≥2 项的数组")
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()
    for opt in options:
        if not isinstance(opt, dict) or not opt.get("key") or not opt.get("text"):
            raise ValidationError(f"选项结构非法: {opt!r}，需要 {{key, text}}")
        key = str(opt["key"]).strip().upper()
        text = str(opt["text"]).strip()
        if not key or not text:
            raise ValidationError(f"选项 key/text 不能为空: {opt!r}")
        if key in seen:
            raise ValidationError(f"选项 key 重复: {key}")
        seen.add(key)
        normalized.append({"key": key, "text": text})
    return normalized


def validate_reference_answer(
    question_type: str, options: list[dict[str, str]] | None, answer: Any
) -> Any:
    """按题型校验参考答案结构，返回规范化后的答案."""
    if question_type == "single_choice":
        if not isinstance(answer, str) or not answer.strip():
            raise ValidationError("单选答案必须是非空字符串")
        key = answer.strip().upper()
        if options is None or not any(o["key"] == key for o in options):
            raise ValidationError(f"单选答案 {key!r} 不在选项中")
        return key

    if question_type == "multiple_choice":
        if not isinstance(answer, (list, tuple)) or len(answer) < 2:
            raise ValidationError("多选答案必须为 ≥2 项的数组")
        keys = []
        for a in answer:
            if not isinstance(a, str) or not a.strip():
                raise ValidationError(f"多选答案项非法: {a!r}")
            k = a.strip().upper()
            if k in keys:
                continue  # 去重
            if options is None or not any(o["key"] == k for o in options):
                raise ValidationError(f"多选答案 {k!r} 不在选项中")
            keys.append(k)
        if len(keys) < 2:
            raise ValidationError("多选答案去重后不足 2 项")
        return keys

    if question_type == "true_false":
        if not isinstance(answer, bool):
            if answer in (0, 1):
                return bool(answer)
            if isinstance(answer, str):
                norm = answer.strip().lower()
                if norm in ("true", "t", "对", "正确", "是", "√", "yes", "1"):
                    return True
                if norm in ("false", "f", "错", "错误", "否", "×", "no", "0"):
                    return False
            raise ValidationError(f"判断题答案必须为 true/false，收到: {answer!r}")
        return answer

    if question_type == "short_answer":
        if not isinstance(answer, str) or not answer.strip():
            raise ValidationError("简答题答案必须为非空文本")
        return answer.strip()

    raise ValidationError(f"未支持题型: {question_type}")


def validate_question(
    *,
    question_type: str,
    difficulty: int,
    cognitive_level: str | None,
    stem: str,
    options: Any,
    reference_answer: Any,
) -> tuple[str, int, str, list[dict[str, str]] | None, Any]:
    """整体校验，返回规范化后的 (type, difficulty, cognitive_level, options, answer).

    校验失败抛 ValidationError。纯函数，不落库。
    """
    qtype = validate_question_type(question_type)
    diff = validate_difficulty(difficulty)
    level = validate_cognitive_level(cognitive_level)
    if not stem or not str(stem).strip():
        raise ValidationError("题干 stem 不能为空")
    opts = validate_options(options) if qtype in ("single_choice", "multiple_choice") else None
    if qtype in ("single_choice", "multiple_choice") and options is None:
        raise ValidationError(f"{qtype} 必须提供 options")
    answer = validate_reference_answer(qtype, opts, reference_answer)
    return qtype, diff, level, opts, answer
