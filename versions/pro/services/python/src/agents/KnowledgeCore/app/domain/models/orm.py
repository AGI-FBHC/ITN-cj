"""Domain module ORM models."""

from __future__ import annotations
from typing import Optional

from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class DomainORM(Base):
    """领域表."""

    __tablename__ = "domains"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    domain_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    owner: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    status: Mapped[str] = mapped_column(
        Enum("draft", "active", "deprecated", "archived", name="domain_status"),
        default="draft",
        server_default="draft",
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    # Relationships
    versions: Mapped[list["DomainVersionORM"]] = relationship(back_populates="domain", cascade="all, delete-orphan")
    profiles: Mapped[list["DomainProfileORM"]] = relationship(back_populates="domain", cascade="all, delete-orphan")
    entity_types: Mapped[list["DomainEntityTypeORM"]] = relationship(back_populates="domain", cascade="all, delete-orphan")
    relation_types: Mapped[list["DomainRelationTypeORM"]] = relationship(back_populates="domain", cascade="all, delete-orphan")
    evidence_roles: Mapped[list["DomainEvidenceRoleORM"]] = relationship(back_populates="domain", cascade="all, delete-orphan")
    rule_bundles: Mapped[list["DomainRuleBundleORM"]] = relationship(back_populates="domain", cascade="all, delete-orphan")
    claim_schemas: Mapped[list["DomainClaimSchemaORM"]] = relationship(back_populates="domain", cascade="all, delete-orphan")


class DomainVersionORM(Base):
    """领域版本表."""

    __tablename__ = "domain_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    domain_version_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    domain_id: Mapped[str] = mapped_column(String(64), ForeignKey("domains.domain_id"), nullable=False, index=True)
    version: Mapped[str] = mapped_column(String(32), nullable=False)
    effective_from: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    effective_to: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(
        Enum("draft", "validating", "shadow", "active", "deprecated", "rolled_back", name="domain_version_status"),
        default="draft",
        server_default="draft",
    )
    created_by: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    # Relationships
    domain: Mapped["DomainORM"] = relationship(back_populates="versions")
    runtime_snapshots: Mapped[list["DomainRuntimeSnapshotORM"]] = relationship(back_populates="domain_version", cascade="all, delete-orphan")


class DomainRuntimeSnapshotORM(Base):
    """领域运行快照表."""

    __tablename__ = "domain_runtime_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    snapshot_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    domain_id: Mapped[str] = mapped_column(String(64), ForeignKey("domains.domain_id"), nullable=False, index=True)
    domain_version_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("domain_versions.domain_version_id"), nullable=False, index=True
    )
    rule_bundle_version: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    graph_version: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    evidence_role_version: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    claim_schema_version: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    retrieval_profile_version: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    document_versions: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    chunk_versions: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    chunk_policy: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    figure_policy: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    metadata_defaults: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    retrieval_profile: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    activated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_by: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    # Relationships
    domain_version: Mapped["DomainVersionORM"] = relationship(back_populates="runtime_snapshots")


class DomainProfileORM(Base):
    """领域配置文件表."""

    __tablename__ = "domain_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    domain_id: Mapped[str] = mapped_column(String(64), ForeignKey("domains.domain_id"), nullable=False, index=True)
    domain_version_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    profile_type: Mapped[str] = mapped_column(
        Enum(
            "ontology", "terminology", "evidence_role", "risk_policy",
            "retrieval", "graph", "claim_schema", "evaluation", "activation",
            name="profile_type",
        ),
        nullable=False,
    )
    schema_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    version: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    # Relationships
    domain: Mapped["DomainORM"] = relationship(back_populates="profiles")


class DomainEntityTypeORM(Base):
    """领域实体类型表."""

    __tablename__ = "domain_entity_types"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    domain_id: Mapped[str] = mapped_column(String(64), ForeignKey("domains.domain_id"), nullable=False, index=True)
    domain_version_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    constraints_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    # Relationships
    domain: Mapped["DomainORM"] = relationship(back_populates="entity_types")


class DomainRelationTypeORM(Base):
    """领域关系类型表."""

    __tablename__ = "domain_relation_types"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    domain_id: Mapped[str] = mapped_column(String(64), ForeignKey("domains.domain_id"), nullable=False, index=True)
    domain_version_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source_types: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    target_types: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    constraints_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    # Relationships
    domain: Mapped["DomainORM"] = relationship(back_populates="relation_types")


class DomainEvidenceRoleORM(Base):
    """领域证据角色表."""

    __tablename__ = "domain_evidence_roles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    domain_id: Mapped[str] = mapped_column(String(64), ForeignKey("domains.domain_id"), nullable=False, index=True)
    domain_version_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    role_name: Mapped[str] = mapped_column(String(64), nullable=False)
    required_fields: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    risk_policy: Mapped[str] = mapped_column(
        Enum("optional", "recommended", "required", name="risk_policy"),
        default="optional",
        server_default="optional",
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    # Relationships
    domain: Mapped["DomainORM"] = relationship(back_populates="evidence_roles")


class DomainRuleBundleORM(Base):
    """领域规则包表."""

    __tablename__ = "domain_rule_bundles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    domain_id: Mapped[str] = mapped_column(String(64), ForeignKey("domains.domain_id"), nullable=False, index=True)
    domain_version_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    bundle_version: Mapped[str] = mapped_column(String(32), nullable=False)
    rules_json: Mapped[list] = mapped_column(JSON, nullable=False)
    predicate_dependencies: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    test_suite_ref: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(
        Enum("draft", "active", "deprecated", name="rule_bundle_status"),
        default="draft",
        server_default="draft",
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    # Relationships
    domain: Mapped["DomainORM"] = relationship(back_populates="rule_bundles")


class DomainClaimSchemaORM(Base):
    """领域关键主张表."""

    __tablename__ = "domain_claim_schemas"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    domain_id: Mapped[str] = mapped_column(String(64), ForeignKey("domains.domain_id"), nullable=False, index=True)
    domain_version_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    task_type: Mapped[str] = mapped_column(String(64), nullable=False)
    claim_id: Mapped[str] = mapped_column(String(64), nullable=False)
    criticality: Mapped[str] = mapped_column(
        Enum("critical", "important", "optional", name="claim_criticality"),
        default="important",
        server_default="important",
    )
    required_roles: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    # Relationships
    domain: Mapped["DomainORM"] = relationship(back_populates="claim_schemas")
