"""Audit API routes."""
from __future__ import annotations
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.audit.schemas import (
    AuditListResponse,
    AuditRecordResponse,
)
from app.audit.services.audit_service import AuditService

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("", response_model=AuditListResponse)
async def list_audits(
    domain_id: Optional[str] = None,
    contract_id: Optional[str] = None,
    audit_type: Optional[str] = None,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """列出审计记录."""
    service = AuditService(db)
    items, total = await service.list_audits(
        domain_id=domain_id,
        contract_id=contract_id,
        audit_type=audit_type,
        limit=limit,
        offset=offset,
    )
    return AuditListResponse(total=total, items=items)


@router.get("/{audit_id}", response_model=AuditRecordResponse)
async def get_audit(
    audit_id: str,
    db: AsyncSession = Depends(get_db),
):
    """获取审计记录."""
    service = AuditService(db)
    audit = await service.get_audit(audit_id)
    if not audit:
        raise HTTPException(status_code=404, detail=f"Audit record '{audit_id}' not found")
    return audit


@router.get("/decision/{contract_id}", response_model=AuditListResponse)
async def get_decision_audit(
    contract_id: str,
    db: AsyncSession = Depends(get_db),
):
    """获取决策审计记录."""
    service = AuditService(db)
    items, total = await service.list_audits(contract_id=contract_id)
    return AuditListResponse(total=total, items=items)
