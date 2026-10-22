"""knowledge_category_prerequisite 加 evidence_json 列 (T3.2 定义/使用 -> 证据驱动先修边)

Revision ID: 7c2f9a1d3b6e
Revises: ef9012836728
Create Date: 2026-08-18 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7c2f9a1d3b6e'
down_revision: Union[str, Sequence[str], None] = 'ef9012836728'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    evidence_json：T3.2 证据驱动先修边——candidate_generator 的证据通道
    （"B 的 chunk uses 了 A 的 chunk defines 的概念"）为每条候选边写入
    {"concept": ..., "def_chunk": ..., "use_chunk": ...}，仍走现有四道防线，
    proposed 状态机不直接激活。人工/结构候选（非证据通道）该列为 NULL。
    """
    op.add_column(
        'knowledge_category_prerequisite',
        sa.Column('evidence_json', sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('knowledge_category_prerequisite', 'evidence_json')
