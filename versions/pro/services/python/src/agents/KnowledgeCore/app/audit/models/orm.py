"""Audit module ORM models."""

from __future__ import annotations
from typing import Optional

from datetime import datetime

from sqlalchemy import DateTime, Enum, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AuditRecordORM(Base):
    """审计记录表."""

    __tablename__ = "audit_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    audit_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    domain_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    contract_id: Mapped[Optional[str]] = mapped_column(String(64), index=True, nullable=True)

    # Audit type
    audit_type: Mapped[str] = mapped_column(
        Enum("decision", "validation", "activation", "rollback", name="audit_type"),
        nullable=False,
    )

    # Snapshot references
    domain_runtime_snapshot_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    fact_snapshot_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    # Audit details
    details_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # Request info
    request_query: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    request_context: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # Result
    result_status: Mapped[str] = mapped_column(
        Enum("success", "failed", "blocked", "restricted", name="audit_result_status"),
        default="success",
        server_default="success",
    )
    result_summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
