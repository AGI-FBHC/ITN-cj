"""Evidence module request/response schemas."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


# ── Request Schemas ─────────────────────────────────────────────────────────


class SearchEvidenceRequest(BaseModel):
    """证据检索请求."""

    domain_id: str = Field(..., description="领域 ID")
    query: str = Field(..., min_length=1, description="检索查询")
    snapshot_id: Optional[str] = Field(None, description="运行快照 ID")
    top_k: int = Field(10, ge=1, le=50, description="返回结果数量")
    similarity_threshold: float = Field(0.2, ge=0.0, le=1.0, description="相似度阈值")
    document_ids: Optional[list[str]] = Field(None, description="文档 ID 过滤")
    dataset_ids: Optional[list[str]] = Field(None, description="RAGFlow 数据集 ID（不传则跳过检索，仅建包）")


# ── Response Schemas ────────────────────────────────────────────────────────


class EvidenceItemResponse(BaseModel):
    """证据项响应."""

    evidence_id: str
    chunk_id: str
    document_id: str
    domain_id: str
    domain_version_id: str
    content: str
    section_path: list[str] = []
    heading: Optional[str] = None
    chunk_type: str = "mixed"

    # Scores
    similarity_score: float = 0.0
    vector_similarity: float = 0.0
    term_similarity: float = 0.0

    # Attributes
    evidence_role: str = "base"
    authority_level: str = "official"
    coverage_aspects: list[str] = []

    # Related assets
    figure_ids: list[str] = []
    contains_code: bool = False
    contains_table: bool = False

    metadata: dict[str, Any] = {}


class EvidencePackResponse(BaseModel):
    """证据包响应."""

    pack_id: str
    query: str
    domain_id: str
    domain_version_id: str

    # Evidence items
    evidence_items: list[EvidenceItemResponse] = []

    # Coverage
    coverage_score: float = 0.0
    covered_aspects: list[str] = []
    missing_aspects: list[str] = []

    # Authority
    authority_score: float = 0.0
    authority_distribution: dict[str, int] = {}

    # Other scores
    freshness_score: float = 0.0
    applicability_score: float = 0.0
    source_independence_score: float = 0.0
    conflict_risk_score: float = 0.0
    conflicts: list[dict[str, Any]] = []

    created_at: datetime


class SearchEvidenceResponse(BaseModel):
    """证据检索响应."""

    pack_id: str
    query: str
    domain_id: str
    evidence_count: int
    evidence_items: list[EvidenceItemResponse] = []

    # Summary scores
    coverage_score: float = 0.0
    authority_score: float = 0.0
    applicability_score: float = 0.0
