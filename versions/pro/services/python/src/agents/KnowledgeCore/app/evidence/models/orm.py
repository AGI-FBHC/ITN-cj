"""Evidence module ORM models."""

from __future__ import annotations
from typing import Optional

from datetime import datetime

from sqlalchemy import DateTime, Enum, Float, ForeignKey, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class EvidencePackORM(Base):
    """证据包表."""

    __tablename__ = "evidence_packs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    pack_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    query: Mapped[str] = mapped_column(Text, nullable=False)
    domain_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    domain_version_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)

    # Scores
    coverage_score: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
    authority_score: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
    freshness_score: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
    applicability_score: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
    source_independence_score: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
    conflict_risk_score: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")

    # Coverage details
    covered_aspects: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    missing_aspects: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    authority_distribution: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    conflicts: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    # Snapshot references
    snapshot_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    # Relationships
    items: Mapped[list["EvidenceItemORM"]] = relationship(back_populates="pack", cascade="all, delete-orphan")


class EvidenceItemORM(Base):
    """证据项表."""

    __tablename__ = "evidence_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    evidence_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    pack_id: Mapped[str] = mapped_column(String(64), ForeignKey("evidence_packs.pack_id"), nullable=False, index=True)
    chunk_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    document_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    domain_id: Mapped[str] = mapped_column(String(64), nullable=False)
    domain_version_id: Mapped[str] = mapped_column(String(64), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    section_path: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    heading: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    chunk_type: Mapped[str] = mapped_column(String(32), default="mixed", server_default="mixed")

    # Scores
    similarity_score: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
    vector_similarity: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
    term_similarity: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")

    # Evidence attributes
    evidence_role: Mapped[str] = mapped_column(
        Enum("base", "extended", "example", "reference", name="evidence_role"),
        default="base",
        server_default="base",
    )
    authority_level: Mapped[str] = mapped_column(
        Enum("official", "reference", "example", "community", name="evidence_authority_level"),
        default="official",
        server_default="official",
    )
    coverage_aspects: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    # Related assets
    figure_ids: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    contains_code: Mapped[bool] = mapped_column(default=False, server_default="0")
    contains_table: Mapped[bool] = mapped_column(default=False, server_default="0")

    metadata_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    # Relationships
    pack: Mapped["EvidencePackORM"] = relationship(back_populates="items")
