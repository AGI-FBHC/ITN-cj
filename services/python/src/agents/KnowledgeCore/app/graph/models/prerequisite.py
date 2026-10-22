"""先修边 ORM：knowledge_category_prerequisite（节点即 knowledge_category.id）.

与生产库 DDL 对齐（2026-08 已建表），不设物理外键（目录树重组频繁，
一致性靠 cron 校验 + 删除前检查边引用）。
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Index, JSON, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PrerequisiteEdgeORM(Base):
    """先修边表：行 (category_id=B, prereq_category_id=A) ⇔ 边 A→B ⇔ "A 是 B 的先修"."""

    __tablename__ = "knowledge_category_prerequisite"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    domain_id: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    category_id: Mapped[int] = mapped_column(BigInteger, nullable=False)  # 目标（后修）
    prereq_category_id: Mapped[int] = mapped_column(BigInteger, nullable=False)  # 先修
    edge_type: Mapped[str] = mapped_column(
        String(32), nullable=False, default="prerequisite",
        # prerequisite | cross_domain_prerequisite | related
    )
    source_domain_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    confidence: Mapped[float] = mapped_column(Numeric(5, 4), nullable=False, default=1.0)
    rationale: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="proposed",
        # proposed(待审) | active(生效) | rejected(拒绝) | deprecated
    )
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="agent")
    # T3.2：证据驱动先修边——candidate_generator 证据通道写 {"concept", "def_chunk", "use_chunk"}；
    # 人工/结构候选（非证据通道）为 NULL。
    evidence_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        # UNIQUE(category_id, prereq_category_id)：防重复边（与生产 DDL 一致）
        # 索引名与生产库一致，避免迁移冲突
        UniqueConstraint("category_id", "prereq_category_id", name="uk_prereq"),
        Index("idx_prereq_domain", "domain_id", "status"),
        Index("idx_prereq_prereq", "prereq_category_id"),
    )
