"""先修图模块请求/响应 schemas（dag-design.md §7/§9）."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

# ── Request ────────────────────────────────────────────────────────────────


class PrerequisiteAddRequest(BaseModel):
    """新增先修边请求：行 (category_id=B, prereq_category_id=A) ⇔ 边 A→B."""

    category_id: int = Field(..., description="目标知识点（后修）B")
    prereq_category_id: int = Field(..., description="先修知识点 A")
    domain_id: int | None = Field(None, description="所属领域（缺省取目标节点领域）")
    edge_type: str = Field(
        "prerequisite",
        description="prerequisite | cross_domain_prerequisite | related",
    )
    source_domain_id: int | None = Field(None, description="跨域边的源领域（跨学科用）")
    confidence: float = Field(1.0, ge=0, le=1, description="建边置信度（LLM 输出）")
    rationale: str | None = Field(None, description="建边理由（LLM rationale，审计用）")
    source: str = Field("agent", description="human | agent | llm | derived")
    created_by: str | None = Field(None, description="创建人/任务标识")
    direct_active: bool = Field(False, description="true 时跳过审核直接 active（仅人工场景）")


class ReviewRequest(BaseModel):
    """审核请求（single 或 batch）."""

    edge_ids: list[int] = Field(..., description="边 id 列表（批量审核）")
    approve: bool = Field(True, description="true=通过(active) false=拒绝(rejected)")


class EdgeDeleteRequest(BaseModel):
    """删除边请求（软删 → deprecated）."""

    edge_id: int = Field(..., description="边 id")


# ── Response ───────────────────────────────────────────────────────────────


class PrerequisiteEdgeResponse(BaseModel):
    """先修边响应.

    category_id / prereq_category_id 以字符串输出，避免超出 JS 安全整数后被舍入。
    """

    model_config = ConfigDict(coerce_numbers_to_str=True)

    id: int
    domain_id: int
    category_id: str
    prereq_category_id: str
    edge_type: str
    source_domain_id: int | None = None
    confidence: float
    rationale: str | None = None
    status: str
    source: str
    created_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class PrereqNode(BaseModel):
    """先修链节点（带 domain 标注，前端可区分本课程/跨学科先修）."""

    category_id: int
    domain_id: int
    parent_id: int | None = None
    name: str
    level: int
    node_type: str


class PrereqEdgeBrief(BaseModel):
    """先修链边（压缩字段）."""

    id: int
    prereq_category_id: int
    category_id: int
    edge_type: str
    source_domain_id: int | None = None
    confidence: float


class PrerequisiteChainResponse(BaseModel):
    """先修链查询响应."""

    category_id: int
    nodes: list[PrereqNode]
    edges: list[PrereqEdgeBrief]
    decision: str = Field(..., description="ok | missing_prerequisites")
    missing: list[int] = Field(
        default_factory=list,
        description="未掌握的先修（掌握度数据源不在相关表范围，第一版由调用方判定）",
    )
    suggestion_type: str = Field("blocking", description="blocking | advisory（跨域边为 advisory）")


class ConsistencyResponse(BaseModel):
    """一致性校验响应."""

    is_consistent: bool
    errors: list[str]
    edge_count: int
    active_prereq_count: int


class AddPrerequisiteResult(BaseModel):
    """建边结果（含警告，如自动降级 related）."""

    edge: PrerequisiteEdgeResponse
    warnings: list[str] = Field(default_factory=list)
