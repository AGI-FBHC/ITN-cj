"""knowledge_retrieval_miss (T2.3 检索 miss 日志)

Revision ID: ef9012836728
Revises: 6319bd4c501e
Create Date: 2026-08-17 00:00:01.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ef9012836728'
down_revision: Union[str, Sequence[str], None] = '6319bd4c501e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    knowledge_retrieval_miss：检索 miss 日志，写入点两处（均 fire-and-forget，失败静默）：
    ① retrieval_service.retrieve_chunks 三级降级全空；
    ② decision_service.resolve 门控 gate_type == 'insufficient_evidence'。
    """
    op.create_table(
        'knowledge_retrieval_miss',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('query', sa.Text(), nullable=True),
        sa.Column('domain_id', sa.BigInteger(), nullable=True),
        sa.Column(
            'stage', sa.String(length=16), nullable=True,
            # resolve_category / chunks / gate
        ),
        sa.Column('task_type', sa.String(length=32), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        mysql_charset='utf8mb4',
        mysql_collate='utf8mb4_unicode_ci',  # 对齐平台既有表，避免跨表比较 collation 冲突
    )
    op.create_index('idx_created', 'knowledge_retrieval_miss', ['created_at'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('idx_created', table_name='knowledge_retrieval_miss')
    op.drop_table('knowledge_retrieval_miss')
