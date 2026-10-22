"""审题结果模型（DESIGN v2 §14）."""
from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


class ReviewVerdict(BaseModel):
    """Reviewer 四项独立检查的结论（只审不改，不携带任何修改建议之外的改动）."""

    grounded: bool = Field(False, description="题目能否由证据支持")
    answer_correct: bool = Field(False, description="参考答案是否正确")
    unambiguous: bool = Field(False, description="题目是否无歧义")
    difficulty_match: bool = Field(False, description="难度是否与 rubric 匹配")
    confidence: float = Field(default=0.0, ge=0.0, le=1.0, description="整体置信度")
    issues: list[str] = Field(default_factory=list, description="问题列表（通过时为空）")
    suggested_difficulty: int | None = Field(default=None, ge=1, le=5, description="建议难度")

    @field_validator("confidence")
    @classmethod
    def _clamp_confidence(cls, v: float) -> float:
        return max(0.0, min(1.0, v))

    @property
    def passed(self) -> bool:
        """四项全过才算通过（任一不通过 → 拒绝）."""
        return bool(
            self.grounded
            and self.answer_correct
            and self.unambiguous
            and self.difficulty_match
        )

    def summary(self) -> str:
        if self.passed:
            return f"通过（confidence={self.confidence:.2f}）"
        failed = []
        if not self.grounded:
            failed.append("证据不支持")
        if not self.answer_correct:
            failed.append("答案不正确")
        if not self.unambiguous:
            failed.append("有歧义")
        if not self.difficulty_match:
            failed.append(f"难度不匹配(建议{self.suggested_difficulty})")
        return f"拒绝（{'、'.join(failed)}，confidence={self.confidence:.2f}）"
