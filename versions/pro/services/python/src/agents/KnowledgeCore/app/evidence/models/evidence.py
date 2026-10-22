from __future__ import annotations
from typing import Optional
from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class ConflictStatus(str, Enum):
    NONE = "none"
    MINOR = "minor"
    MAJOR = "major"
    CRITICAL = "critical"


class RetrievalStatus(str, Enum):
    COMPLETE = "complete"
    PARTIAL = "partial"
    NO_RESULTS = "no_results"
    RETRIEVE_AGAIN = "retrieve_again"


class CoverageMetrics(BaseModel):
    role_coverage: float = Field(ge=0.0, le=1.0, description="证据角色覆盖率")
    critical_claim_coverage: float = Field(ge=0.0, le=1.0, description="关键主张覆盖率")
    authority_score: float = Field(ge=0.0, le=1.0, description="权威性得分")
    freshness_score: float = Field(ge=0.0, le=1.0, description="时效性得分")
    source_independence_score: float = Field(ge=0.0, le=1.0, description="来源独立性得分")
    applicability_score: float = Field(ge=0.0, le=1.0, description="适用性得分")
    conflict_score: float = Field(ge=0.0, le=1.0, description="冲突风险得分")


class EvidenceItem(BaseModel):
    id: Optional[int] = None
    item_id: str
    pack_id: str
    doc_id: Optional[str] = None
    version_id: Optional[str] = None
    chunk_id: Optional[str] = None
    citation_anchor: Optional[str] = None
    authority_level: Optional[str] = None
    applicability_score: Optional[float] = None
    freshness_score: Optional[float] = None
    evidence_role: Optional[str] = None
    covered_claim_ids: Optional[list[str]] = None
    source_family: Optional[str] = None
    relevance_score: Optional[float] = None
    conflict_status: ConflictStatus = ConflictStatus.NONE
    created_at: Optional[datetime] = None


class EvidencePack(BaseModel):
    id: Optional[int] = None
    pack_id: str
    domain_id: str
    domain_runtime_snapshot_id: str
    request_id: Optional[str] = None
    task_id: Optional[str] = None
    evidence_items: list[EvidenceItem] = []
    coverage_metrics: Optional[CoverageMetrics] = None
    retrieval_status: RetrievalStatus = RetrievalStatus.COMPLETE
    created_at: Optional[datetime] = None
