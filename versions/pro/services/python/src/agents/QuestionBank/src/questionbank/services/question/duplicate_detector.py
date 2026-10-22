"""防线 4 第一级：精确重复检测（DESIGN v2 §5 / §15）.

content_hash = sha256(canonical JSON(stem + options + reference_answer))。

canonical 序列化：ensure_ascii=False + sort_keys，选项按原顺序（选项顺序变化
视为不同题目）。多选答案排序后归一，避免 ["A","B"] / ["B","A"] 重复入库。
"""
from __future__ import annotations

import hashlib
import json
from typing import Any


def _normalize_answer(question_type: str, answer: Any) -> Any:
    if question_type == "multiple_choice" and isinstance(answer, list):
        return sorted(str(a).strip().upper() for a in answer)
    if question_type == "single_choice" and isinstance(answer, str):
        return answer.strip().upper()
    if question_type == "true_false":
        return bool(answer)
    return answer


def content_hash(
    *,
    question_type: str,
    stem: str,
    options: list[dict[str, str]] | None,
    reference_answer: Any,
) -> str:
    """题目内容 canonical sha256（64 位 hex）."""
    canonical = json.dumps(
        {
            "question_type": question_type,
            "stem": str(stem).strip(),
            "options": options,
            "reference_answer": _normalize_answer(question_type, reference_answer),
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
