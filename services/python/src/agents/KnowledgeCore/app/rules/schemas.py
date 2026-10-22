"""Rules module request/response schemas."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


# ── Request Schemas ─────────────────────────────────────────────────────────


class ExecuteRulesRequest(BaseModel):
    """执行规则请求."""

    domain_id: str = Field(..., description="领域 ID")
    fact_snapshot_id: str = Field(..., description="事实快照 ID")
    rule_bundle_id: Optional[str] = Field(None, description="规则包 ID（为空则使用活跃版本）")


# ── Response Schemas ────────────────────────────────────────────────────────


class RuleResponse(BaseModel):
    """规则响应."""

    rule_id: str
    level: str
    name: str
    predicate: str
    params: dict[str, Any] = {}
    action: str
    message: str = ""


class RuleBundleResponse(BaseModel):
    """规则包响应."""

    id: int
    bundle_id: str
    domain_id: str
    domain_version_id: str
    version: str
    rules_json: list[dict]
    predicate_dependencies: Optional[list[str]] = None
    test_suite_ref: Optional[str] = None
    status: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class RuleExecutionResponse(BaseModel):
    """规则执行响应."""

    execution_id: str
    domain_id: str
    bundle_id: str
    fact_snapshot_id: str
    passed: bool
    hit_rules: list[dict] = []
    blocked_by: list[dict] = []
    restricted_by: list[dict] = []
    messages: list[str] = []
    created_at: datetime
