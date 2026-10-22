"""审计日志服务."""
from __future__ import annotations
from typing import Optional

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models.orm import AuditRecordORM


class AuditService:
    """审计日志记录与查询."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def create_audit(
        self,
        domain_id: str,
        audit_type: str,
        contract_id: Optional[str] = None,
        domain_runtime_snapshot_id: Optional[str] = None,
        fact_snapshot_id: Optional[str] = None,
        details_json: Optional[dict] = None,
        request_query: Optional[str] = None,
        request_context: Optional[dict] = None,
        result_status: str = "success",
        result_summary: Optional[str] = None,
    ) -> AuditRecordORM:
        """创建审计记录."""
        audit = AuditRecordORM(
            audit_id=f"audit_{uuid.uuid4().hex[:8]}",
            domain_id=domain_id,
            contract_id=contract_id,
            audit_type=audit_type,
            domain_runtime_snapshot_id=domain_runtime_snapshot_id,
            fact_snapshot_id=fact_snapshot_id,
            details_json=details_json,
            request_query=request_query,
            request_context=request_context,
            result_status=result_status,
            result_summary=result_summary,
        )
        self.db.add(audit)
        await self.db.commit()
        await self.db.refresh(audit)
        return audit

    async def get_audit(self, audit_id: str) -> Optional[AuditRecordORM]:
        """获取审计记录."""
        result = await self.db.execute(
            select(AuditRecordORM).where(AuditRecordORM.audit_id == audit_id)
        )
        return result.scalar_one_or_none()

    async def list_audits(
        self,
        domain_id: Optional[str] = None,
        contract_id: Optional[str] = None,
        audit_type: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> tuple[list[AuditRecordORM], int]:
        """列出审计记录."""
        query = select(AuditRecordORM)
        count_query = select(func.count()).select_from(AuditRecordORM)

        if domain_id:
            query = query.where(AuditRecordORM.domain_id == domain_id)
            count_query = count_query.where(AuditRecordORM.domain_id == domain_id)
        if contract_id:
            query = query.where(AuditRecordORM.contract_id == contract_id)
            count_query = count_query.where(AuditRecordORM.contract_id == contract_id)
        if audit_type:
            query = query.where(AuditRecordORM.audit_type == audit_type)
            count_query = count_query.where(AuditRecordORM.audit_type == audit_type)

        # Get total count
        total_result = await self.db.execute(count_query)
        total = total_result.scalar() or 0

        # Get paginated results
        query = query.order_by(AuditRecordORM.created_at.desc()).limit(limit).offset(offset)
        result = await self.db.execute(query)
        items = list(result.scalars().all())

        return items, total

    async def log_decision(
        self,
        domain_id: str,
        contract_id: str,
        domain_runtime_snapshot_id: str,
        fact_snapshot_id: str,
        query: str,
        decision: str,
        hf_score: float,
        details: Optional[dict] = None,
    ) -> AuditRecordORM:
        """记录决策审计."""
        return await self.create_audit(
            domain_id=domain_id,
            audit_type="decision",
            contract_id=contract_id,
            domain_runtime_snapshot_id=domain_runtime_snapshot_id,
            fact_snapshot_id=fact_snapshot_id,
            request_query=query,
            details_json={
                "decision": decision,
                "hf_score": hf_score,
                **(details or {}),
            },
            result_status="success" if decision == "permit" else decision,
            result_summary=f"Decision: {decision}, HF Score: {hf_score:.2f}",
        )

    async def log_validation(
        self,
        domain_id: str,
        version: str,
        is_valid: bool,
        errors: list[str],
        warnings: list[str],
    ) -> AuditRecordORM:
        """记录校验审计."""
        return await self.create_audit(
            domain_id=domain_id,
            audit_type="validation",
            details_json={
                "version": version,
                "is_valid": is_valid,
                "errors": errors,
                "warnings": warnings,
            },
            result_status="success" if is_valid else "failed",
            result_summary=f"Validation {'passed' if is_valid else 'failed'}: {len(errors)} errors, {len(warnings)} warnings",
        )

    async def log_activation(
        self,
        domain_id: str,
        version: str,
        snapshot_id: str,
        activated_by: Optional[str] = None,
    ) -> AuditRecordORM:
        """记录激活审计."""
        return await self.create_audit(
            domain_id=domain_id,
            audit_type="activation",
            domain_runtime_snapshot_id=snapshot_id,
            details_json={
                "version": version,
                "activated_by": activated_by,
            },
            result_status="success",
            result_summary=f"Version {version} activated, snapshot: {snapshot_id}",
        )

    async def log_rollback(
        self,
        domain_id: str,
        from_version: str,
        to_version: str,
    ) -> AuditRecordORM:
        """记录回滚审计."""
        return await self.create_audit(
            domain_id=domain_id,
            audit_type="rollback",
            details_json={
                "from_version": from_version,
                "to_version": to_version,
            },
            result_status="success",
            result_summary=f"Rolled back from {from_version} to {to_version}",
        )
