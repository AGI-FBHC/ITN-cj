"""Document module ORM models."""

from __future__ import annotations
from typing import Optional

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class DocumentORM(Base):
    """文档表."""

    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    domain_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    domain_version_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    source_uri: Mapped[Optional[str]] = mapped_column(String(1024), nullable=True)
    file_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    file_size: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    mime_type: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    authority_level: Mapped[str] = mapped_column(
        Enum("official", "reference", "example", "community", name="authority_level"),
        default="official",
        server_default="official",
    )
    applicability_scope: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    metadata_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(
        Enum("active", "deprecated", "archived", name="document_status"),
        default="active",
        server_default="active",
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    # Relationships
    chunks: Mapped[list["DocumentChunkORM"]] = relationship(back_populates="document", cascade="all, delete-orphan")


class DocumentChunkORM(Base):
    """文档分块表."""

    __tablename__ = "document_chunks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    chunk_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    document_id: Mapped[str] = mapped_column(String(64), ForeignKey("documents.document_id"), nullable=False, index=True)
    domain_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    domain_version_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    content_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    chunk_type: Mapped[str] = mapped_column(
        Enum("text", "code", "table", "figure", "mixed", name="chunk_type"),
        default="mixed",
        server_default="mixed",
    )
    section_path: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    heading: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    char_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    contains_code: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    contains_table: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    figure_ids: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    metadata_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    # Relationships
    document: Mapped["DocumentORM"] = relationship(back_populates="chunks")
