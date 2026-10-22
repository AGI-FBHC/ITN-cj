"""Audit module request/response schemas."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


# ── Response Schemas ────────────────────────────────────────────────────────


class AuditRecordResponse(BaseModel):
    """审计记录响应."""

    id: int
    audit_id: str
    domain_id: str
    contract_id: Optional[str] = None
    audit_type: str
    domain_runtime_snapshot_id: Optional[str] = None
    fact_snapshot_id: Optional[str] = None
    details_json: Optional[dict] = None
    request_query: Optional[str] = None
    request_context: Optional[dict] = None
    result_status: str
    result_summary: Optional[str] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class AuditListResponse(BaseModel):
    """审计记录列表响应."""

    total: int
    items: list[AuditRecordResponse] = []
