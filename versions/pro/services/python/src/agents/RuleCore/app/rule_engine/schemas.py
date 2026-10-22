"""RuleCore Pydantic 数据模型（§6 结构化数据模型 + §12 RuleEvaluationResult）."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class RuleCondition(BaseModel):
    field: str
    operator: str
    value: Any | None = None
    unit: str | None = None


class RuleConclusion(BaseModel):
    type: Literal["SET", "MUST", "MUST_NOT", "SHOULD"]
    field: str | None = None
    value: Any | None = None
    content: str | None = None


class DomainRuleSchema(BaseModel):
    rule_code: str
    name: str
    conditions: list[RuleCondition]
    conclusions: list[RuleConclusion]
    source_text: str
    source_section: str | None = None
    source_document_id: int | None = None
    source_chunk_id: int | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class ReasoningStep(BaseModel):
    round: int
    rule: str
    reason: str
    result: str


class ConstraintItem(BaseModel):
    rule_code: str
    type: str
    content: str | None = None
    source: str | None = None  # 来源章节/文档，用于前端展示


class RuleEvaluationResult(BaseModel):
    input_facts: dict[str, Any] = Field(default_factory=dict)
    derived_facts: dict[str, Any] = Field(default_factory=dict)
    matched_rules: list[str] = Field(default_factory=list)
    constraints: list[ConstraintItem] = Field(default_factory=list)
    reasoning_trace: list[ReasoningStep] = Field(default_factory=list)


class VerifyResult(BaseModel):
    valid: bool
    confidence: float
    issues: list[str] = Field(default_factory=list)


class CheckItem(BaseModel):
    rule_code: str
    status: str  # PASS / FAIL / SKIPPED
    evidence: str | None = None
    reason: str | None = None


class CheckResult(BaseModel):
    passed: bool
    results: list[CheckItem] = Field(default_factory=list)


class ExtractedFact(BaseModel):
    """Fact Extractor 输出容器."""
    facts: dict[str, Any] = Field(default_factory=dict)
