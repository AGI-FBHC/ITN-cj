"""Domain module request/response schemas."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


# ── Request Schemas ─────────────────────────────────────────────────────────


class CreateDomainRequest(BaseModel):
    """创建领域请求."""

    domain_id: str = Field(..., min_length=1, max_length=64, description="领域唯一标识")
    name: str = Field(..., min_length=1, max_length=255, description="领域名称")
    description: Optional[str] = Field(None, description="领域描述")
    owner: Optional[str] = Field(None, max_length=128, description="领域所有者")


class CreateVersionRequest(BaseModel):
    """创建领域版本请求."""

    version: str = Field(..., min_length=1, max_length=32, description="版本号")
    created_by: Optional[str] = Field(None, max_length=128, description="创建者")


class ActivateVersionRequest(BaseModel):
    """激活领域版本请求."""

    version: str = Field(..., min_length=1, max_length=32, description="要激活的版本号")
    activated_by: Optional[str] = Field(None, max_length=128, description="激活者")


class RollbackRequest(BaseModel):
    """回滚请求."""

    target_version: str = Field(..., min_length=1, max_length=32, description="目标版本号")


class CreateProfileRequest(BaseModel):
    """创建领域配置请求."""

    domain_version_id: str = Field(..., description="领域版本 ID")
    profile_type: str = Field(..., description="配置类型")
    schema_json: dict[str, Any] = Field(..., description="配置 JSON")
    version: Optional[str] = Field(None, max_length=32, description="配置版本")


class CreateEntityTypeRequest(BaseModel):
    """创建实体类型请求."""

    domain_version_id: str = Field(..., description="领域版本 ID")
    name: str = Field(..., max_length=128, description="实体类型名称")
    description: Optional[str] = Field(None, description="描述")
    constraints_json: Optional[dict[str, Any]] = Field(None, description="约束 JSON")


class CreateRelationTypeRequest(BaseModel):
    """创建关系类型请求."""

    domain_version_id: str = Field(..., description="领域版本 ID")
    name: str = Field(..., max_length=128, description="关系类型名称")
    description: Optional[str] = Field(None, description="描述")
    source_types: Optional[list[str]] = Field(None, description="源实体类型列表")
    target_types: Optional[list[str]] = Field(None, description="目标实体类型列表")
    constraints_json: Optional[dict[str, Any]] = Field(None, description="约束 JSON")


class CreateEvidenceRoleRequest(BaseModel):
    """创建证据角色请求."""

    domain_version_id: str = Field(..., description="领域版本 ID")
    role_name: str = Field(..., max_length=64, description="角色名称")
    required_fields: Optional[dict[str, Any]] = Field(None, description="必需字段")
    risk_policy: str = Field("optional", description="风险策略")


class CreateRuleBundleRequest(BaseModel):
    """创建规则包请求."""

    domain_version_id: str = Field(..., description="领域版本 ID")
    bundle_version: str = Field(..., max_length=32, description="规则包版本")
    rules_json: list[dict[str, Any]] = Field(..., description="规则列表")
    predicate_dependencies: Optional[list[str]] = Field(None, description="谓词依赖")
    test_suite_ref: Optional[str] = Field(None, description="测试套件引用")


class CreateClaimSchemaRequest(BaseModel):
    """创建关键主张请求."""

    domain_version_id: str = Field(..., description="领域版本 ID")
    task_type: str = Field(..., max_length=64, description="任务类型")
    claim_id: str = Field(..., max_length=64, description="主张 ID")
    criticality: str = Field("important", description="重要性")
    required_roles: Optional[list[str]] = Field(None, description="必需证据角色")
    description: Optional[str] = Field(None, description="描述")


# ── Response Schemas ────────────────────────────────────────────────────────


class DomainResponse(BaseModel):
    """领域响应."""

    id: int
    domain_id: str
    name: str
    description: Optional[str] = None
    owner: Optional[str] = None
    status: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DomainVersionResponse(BaseModel):
    """领域版本响应."""

    id: int
    domain_version_id: str
    domain_id: str
    version: str
    effective_from: Optional[datetime] = None
    effective_to: Optional[datetime] = None
    status: str
    created_by: Optional[str] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class DomainRuntimeSnapshotResponse(BaseModel):
    """领域运行快照响应."""

    id: int
    snapshot_id: str
    domain_id: str
    domain_version_id: str
    rule_bundle_version: Optional[str] = None
    graph_version: Optional[str] = None
    evidence_role_version: Optional[str] = None
    claim_schema_version: Optional[str] = None
    retrieval_profile_version: Optional[str] = None
    document_versions: Optional[dict] = None
    chunk_versions: Optional[dict] = None
    chunk_policy: Optional[dict] = None
    figure_policy: Optional[dict] = None
    metadata_defaults: Optional[dict] = None
    retrieval_profile: Optional[dict] = None
    activated_at: Optional[datetime] = None
    created_by: Optional[str] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class DomainProfileResponse(BaseModel):
    """领域配置响应."""

    id: int
    domain_id: str
    domain_version_id: str
    profile_type: str
    schema_json: dict
    version: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DomainEntityTypeResponse(BaseModel):
    """实体类型响应."""

    id: int
    domain_id: str
    domain_version_id: str
    name: str
    description: Optional[str] = None
    constraints_json: Optional[dict] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class DomainRelationTypeResponse(BaseModel):
    """关系类型响应."""

    id: int
    domain_id: str
    domain_version_id: str
    name: str
    description: Optional[str] = None
    source_types: Optional[list[str]] = None
    target_types: Optional[list[str]] = None
    constraints_json: Optional[dict] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class DomainEvidenceRoleResponse(BaseModel):
    """证据角色响应."""

    id: int
    domain_id: str
    domain_version_id: str
    role_name: str
    required_fields: Optional[dict] = None
    risk_policy: str
    created_at: datetime

    model_config = {"from_attributes": True}


class DomainRuleBundleResponse(BaseModel):
    """规则包响应."""

    id: int
    domain_id: str
    domain_version_id: str
    bundle_version: str
    rules_json: list[dict]
    predicate_dependencies: Optional[list[str]] = None
    test_suite_ref: Optional[str] = None
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}


class DomainClaimSchemaResponse(BaseModel):
    """关键主张响应."""

    id: int
    domain_id: str
    domain_version_id: str
    task_type: str
    claim_id: str
    criticality: str
    required_roles: Optional[list[str]] = None
    description: Optional[str] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class ValidateResponse(BaseModel):
    """校验响应."""

    domain_id: str
    version: str
    is_valid: bool
    errors: list[str] = []
    warnings: list[str] = []
    checks: dict[str, bool] = {}
