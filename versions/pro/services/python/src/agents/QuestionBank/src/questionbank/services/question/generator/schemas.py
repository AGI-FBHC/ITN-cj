"""LLM 出题输出的 pydantic 模型（防线1 校验前的一道软校验）."""
from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from ..models import CognitiveLevel, QuestionType


class GeneratedOption(BaseModel):
    key: str
    content: str


class GeneratedQuestion(BaseModel):
    question_type: QuestionType
    difficulty: int = Field(default=3, ge=1, le=5)
    cognitive_level: CognitiveLevel = Field(default="understand")
    stem: str = Field(..., min_length=1)
    options: list[GeneratedOption] | None = None
    reference_answer: list[str] = Field(..., min_length=1, description="LLM 统一返回数组，按题型归一化")
    explanation: str | None = None
    primary_category_id: int | None = Field(default=None, description="目标知识点 ID（应等于 context）")
    secondary_category_ids: list[int] = Field(default_factory=list)
    evidence_chunk_ids: list[int | str] = Field(
        default_factory=list, description="引用的证据 id（chunk_id 数字或 ragflow_chunk_id 字符串）"
    )

    @field_validator("stem")
    @classmethod
    def _stem_strip(cls, v: str) -> str:
        return v.strip()

    @field_validator("explanation")
    @classmethod
    def _explanation_strip(cls, v: str | None) -> str | None:
        return v.strip() if v else None

    @field_validator("reference_answer")
    @classmethod
    def _answer_strip(cls, v: list[str]) -> list[str]:
        return [a.strip() for a in v if a.strip()]


class GeneratedQuestions(BaseModel):
    questions: list[GeneratedQuestion] = Field(default_factory=list)
