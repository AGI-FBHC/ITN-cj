"""Graph module ORM models."""

from __future__ import annotations
from typing import Optional

from datetime import datetime

from sqlalchemy import DateTime, Enum, Float, ForeignKey, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class GraphNodeORM(Base):
    """图谱节点表."""

    __tablename__ = "graph_nodes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    node_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    domain_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    domain_version_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    node_type: Mapped[str] = mapped_column(
        Enum("concept", "skill", "document", "rule", name="node_type"),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    properties: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class GraphEdgeORM(Base):
    """图谱边表."""

    __tablename__ = "graph_edges"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    edge_id: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    domain_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    domain_version_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    source_id: Mapped[str] = mapped_column(String(64), ForeignKey("graph_nodes.node_id"), nullable=False, index=True)
    target_id: Mapped[str] = mapped_column(String(64), ForeignKey("graph_nodes.node_id"), nullable=False, index=True)
    edge_type: Mapped[str] = mapped_column(
        Enum("prerequisite", "related", "contains", "applies_to", name="edge_type"),
        nullable=False,
    )
    weight: Mapped[float] = mapped_column(Float, default=1.0, server_default="1")
    properties: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
