"""题库领域模型（pydantic 输入/输出）."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

QuestionType = Literal["single_choice", "multiple_choice", "true_false", "short_answer"]
Status = Literal["proposed", "active", "rejected", "deprecated"]
SourceType = Literal["human", "llm", "imported"]
CognitiveLevel = Literal["remember", "understand", "apply", "analyze", "evaluate", "create"]


class OptionItem(BaseModel):
    key: str = Field(..., description="选项标识，如 A/B/C/D")
    text: str = Field(..., description="选项内容")


class KnowledgePointRef(BaseModel):
    """题目-知识点关联."""

    category_id: int = Field(..., ge=1, description="knowledge_category.id")
    role: Literal["primary", "secondary", "related"] = Field(default="primary")
    weight: float = Field(default=1.0, ge=0.0, le=1.0)


class EvidenceRef(BaseModel):
    """证据快照引用（落库后知识库变化仍可溯源）."""

    chunk_id: int = Field(0, description="knowledge_chunk.id（RAG 项为 0）")
    document_id: int | str | None = None
    score: float | None = None
    source: Literal["mysql", "parent", "rag"] | None = Field(default=None, description="证据来源层级")


class QuestionCreate(BaseModel):
    question_type: QuestionType
    difficulty: int = Field(default=3, ge=1, le=5)
    cognitive_level: CognitiveLevel = Field(default="remember")
    stem: str = Field(..., min_length=1, description="题干（支持 Markdown）")
    options: list[OptionItem] | None = Field(default=None, description="选择题选项")
    reference_answer: Any = Field(..., description="参考答案（按题型校验）")
    explanation: str | None = None
    status: Status = Field(default="proposed", description="LLM 题必须 proposed")
    source_type: SourceType = Field(default="human")
    evidence_refs: list[EvidenceRef] | None = Field(default=None, description="出题依据证据快照")
    generation_metadata: dict[str, Any] | None = Field(default=None, description="生成溯源元数据")
    metadata: dict[str, Any] | None = Field(default=None)
    knowledge_points: list[KnowledgePointRef] | None = Field(default=None, description="知识点关联")
    created_by: str | None = Field(default=None, description="human/agent/用户标识")

    @field_validator("stem")
    @classmethod
    def _stem_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("题干不能为空")
        return v


class QuestionUpdate(BaseModel):
    """更新字段均为可选；None 表示不更新."""

    question_type: QuestionType | None = None
    difficulty: int | None = Field(default=None, ge=1, le=5)
    cognitive_level: CognitiveLevel | None = None
    stem: str | None = None
    options: list[OptionItem] | None = None
    reference_answer: Any = None
    explanation: str | None = None
    source_type: SourceType | None = None
    evidence_refs: list[EvidenceRef] | None = None
    generation_metadata: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None
    knowledge_points: list[KnowledgePointRef] | None = Field(
        default=None, description="提供则整体替换关联"
    )
