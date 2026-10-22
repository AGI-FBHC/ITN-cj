"""Decision module request/response schemas."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


# ── Request Schemas ─────────────────────────────────────────────────────────


class ResolveRequest(BaseModel):
    """双轨推断请求."""

    domain_id: Optional[str] = Field(None, description="领域 ID（可选，默认使用第一个可用领域）")
    query: str = Field(..., min_length=1, description="查询内容")
    task_type: Optional[str] = Field(None, description="任务类型 (question/explanation/exercise/troubleshooting)")
    user_context: Optional[dict[str, Any]] = Field(None, description="用户上下文")
    constraints: Optional[dict[str, Any]] = Field(None, description="运行约束")
    top_k: int = Field(10, ge=1, le=50, description="检索结果数量")
    similarity_threshold: float = Field(0.2, ge=0.0, le=1.0, description="相似度阈值")
    dataset_ids: Optional[list[str]] = Field(None, description="RAGFlow 数据集 ID 列表（可选）")


class ReplayRequest(BaseModel):
    """决策回放请求."""

    domain_runtime_snapshot_id: str = Field(..., description="领域运行快照 ID")
    query: str = Field(..., min_length=1, description="查询内容")
    task_type: Optional[str] = Field(None, description="任务类型")


# ── Response Schemas ────────────────────────────────────────────────────────


class EligibilityResponse(BaseModel):
    """资格门控响应."""

    is_eligible: bool
    gate_type: str
    coverage_passed: bool
    authority_passed: bool
    applicability_passed: bool
    freshness_passed: bool
    conflict_check_passed: bool
    failure_reasons: list[str] = []
    remediation_suggestions: list[str] = []
    scores: Optional[dict[str, float]] = None


class HFScoreDetailResponse(BaseModel):
    """高保真评分详情响应."""

    dimension: str
    score: float
    weight: float
    contribution: float


class ResolveResponse(BaseModel):
    """双轨推断响应."""

    contract_id: str
    decision: str
    high_fidelity_score: float

    # Snapshot references
    domain_runtime_snapshot_id: str
    fact_snapshot_id: str
    evidence_pack_id: str

    # Eligibility
    eligibility: EligibilityResponse

    # Decision details
    permitted_actions: list[str] = []
    required_citations: list[str] = []
    prohibited_content: list[str] = []
    remediation_items: list[str] = []

    # Evidence summary
    evidence_count: int = 0
    evidence_items: list[dict[str, Any]] = []
    coverage_score: float = 0.0
    authority_score: float = 0.0

    # Rule hits
    rule_hits: list[dict[str, Any]] = []

    # Audit
    audit_trail: list[dict[str, Any]] = []

    created_at: datetime


class DecisionDetailResponse(BaseModel):
    """决策详情响应."""

    id: int
    contract_id: str
    domain_id: str
    domain_version_id: str
    decision: str
    high_fidelity_score: float
    domain_runtime_snapshot_id: str
    fact_snapshot_id: str
    evidence_pack_id: str
    eligibility_json: Optional[dict] = None
    permitted_actions: Optional[list[str]] = None
    required_citations: Optional[list[str]] = None
    prohibited_content: Optional[list[str]] = None
    remediation_items: Optional[list[str]] = None
    audit_trail: Optional[list[dict[str, Any]]] = None
    query: str
    task_type: Optional[str] = None
    user_context: Optional[dict] = None
    created_at: datetime

    model_config = {"from_attributes": True}
