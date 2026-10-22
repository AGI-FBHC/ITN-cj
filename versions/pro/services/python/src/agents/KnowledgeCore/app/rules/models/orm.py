"""Rules module ORM models."""

from __future__ import annotations
from typing import Optional

from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class RuleBundleORM(Base):
    """规则包表."""

    __tablename__ = "rule_bundles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    bundle_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    domain_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    domain_version_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    version: Mapped[str] = mapped_column(String(32), nullable=False)
    rules_json: Mapped[list] = mapped_column(JSON, nullable=False)
    predicate_dependencies: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    test_suite_ref: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(
        Enum("draft", "active", "deprecated", name="rule_bundle_status_enum"),
        default="draft",
        server_default="draft",
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class RuleExecutionLogORM(Base):
    """规则执行日志表."""

    __tablename__ = "rule_execution_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    execution_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    domain_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    bundle_id: Mapped[str] = mapped_column(String(64), nullable=False)
    fact_snapshot_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    # Execution results
    hit_rules: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    blocked_by: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    restricted_by: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    messages: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    passed: Mapped[bool] = mapped_column(default=True, server_default="1")

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
