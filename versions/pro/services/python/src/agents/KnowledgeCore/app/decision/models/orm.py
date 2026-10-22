"""Decision module ORM models."""

from __future__ import annotations
from typing import Optional

from datetime import datetime

from sqlalchemy import DateTime, Enum, Float, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class DecisionRecordORM(Base):
    """决策记录表."""

    __tablename__ = "decision_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    contract_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    domain_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    domain_version_id: Mapped[str] = mapped_column(String(64), nullable=False)

    # Decision
    decision: Mapped[str] = mapped_column(
        Enum("permit", "restrict_scope", "retrieve_again", "block", "request_human_review", name="decision_type"),
        nullable=False,
    )
    high_fidelity_score: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")

    # Snapshot references
    domain_runtime_snapshot_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    fact_snapshot_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    evidence_pack_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    # Eligibility details
    eligibility_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # Decision details
    permitted_actions: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    required_citations: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    prohibited_content: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    remediation_items: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    # Audit
    audit_trail: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    # Query context
    query: Mapped[str] = mapped_column(Text, nullable=False)
    task_type: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    user_context: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class FactSnapshotORM(Base):
    """事实快照表."""

    __tablename__ = "fact_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    fact_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    domain_runtime_snapshot_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    # Task context
    query: Mapped[str] = mapped_column(Text, nullable=False)
    task_type: Mapped[str] = mapped_column(
        Enum("question", "explanation", "exercise", "troubleshooting", name="task_type"),
        default="question",
        server_default="question",
    )
    user_context: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # Domain context
    relevant_sections: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    relevant_skills: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    # Graph context
    prerequisite_chain: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    related_entities: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    # Constraints
    constraints: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
