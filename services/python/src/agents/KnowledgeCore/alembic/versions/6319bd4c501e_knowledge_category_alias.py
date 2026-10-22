"""knowledge_category_alias (T1.5 别名表 + 语义入口)

Revision ID: 6319bd4c501e
Revises: e2489764e0dc
Create Date: 2026-08-17 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6319bd4c501e'
down_revision: Union[str, Sequence[str], None] = 'e2489764e0dc'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    knowledge_category_alias：知识点别名表，服务 T1.5 语义入口——
    resolve_category 精确全匹配之后、多词 AND 之前插入别名精确命中。
    与 knowledge_category（唯一事实源六表之一）同库，但不建物理外键
    （目录树重组频繁，一致性靠应用层校验，与 knowledge_category_prerequisite 同惯例）。
    """
    op.create_table(
        'knowledge_category_alias',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('category_id', sa.BigInteger(), nullable=False),
        sa.Column('alias', sa.String(length=255), nullable=False),
        sa.Column(
            'source', sa.String(length=32), nullable=False, server_default='manual',
            # manual / definition_extract
        ),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('category_id', 'alias', name='uk_cat_alias'),
        mysql_charset='utf8mb4',
        mysql_collate='utf8mb4_unicode_ci',  # 对齐平台既有表，避免跨表比较 collation 冲突
    )
    op.create_index('idx_alias', 'knowledge_category_alias', ['alias'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('idx_alias', table_name='knowledge_category_alias')
    op.drop_table('knowledge_category_alias')
