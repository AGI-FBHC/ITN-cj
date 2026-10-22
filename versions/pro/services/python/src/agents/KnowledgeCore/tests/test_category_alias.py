"""T1.5：knowledge_category_alias 别名表 + resolve_category 语义入口测试."""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.knowledge.services.retrieval_service import KnowledgeRetrievalService

DDL = [
    """
    CREATE TABLE IF NOT EXISTS knowledge_domain (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code VARCHAR(64) UNIQUE, name VARCHAR(128)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS knowledge_category (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain_id INTEGER, parent_id INTEGER,
        node_code VARCHAR(64), name VARCHAR(255), description TEXT,
        full_path VARCHAR(1000), level INTEGER, node_type VARCHAR(32),
        sort_order INTEGER, status INTEGER DEFAULT 1
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS knowledge_category_alias (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL,
        alias VARCHAR(255) NOT NULL,
        source VARCHAR(32) NOT NULL DEFAULT 'manual',
        created_at TEXT,
        UNIQUE (category_id, alias)
    )
    """,
]

SEED = [
    "INSERT INTO knowledge_domain (id, code, name) VALUES (1, 'db', '数据库')",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (1, 1, NULL, 'construction', '事务管理', 1, 'category', 1)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (2, 1, 1, 'kp-isolation', '事务的隔离级别', 3, 'knowledge_point', 1)",
]

TABLES = ("knowledge_category_alias", "knowledge_category", "knowledge_domain")


@pytest_asyncio.fixture
async def alias_db(db_session: AsyncSession):
    for ddl in DDL:
        await db_session.execute(text(ddl))
    for stmt in SEED:
        await db_session.execute(text(stmt))
    await db_session.commit()
    yield db_session
    for t in TABLES:
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    await db_session.commit()


class FakeRag:
    async def resolve_dataset_ids(self, domain_code: str, explicit=None):
        return explicit or ["ds_1"]

    async def retrieve(self, *a, **kw):
        return []


@pytest.mark.asyncio
async def test_alias_exact_match_resolves_category(alias_db: AsyncSession):
    """插入别名 ("ACID" → "事务的隔离级别" 节点)，resolve_category("ACID") 命中该节点."""
    await alias_db.execute(
        text(
            "INSERT INTO knowledge_category_alias (category_id, alias, source) "
            "VALUES (2, 'ACID', 'manual')"
        )
    )
    await alias_db.commit()
    svc = KnowledgeRetrievalService(alias_db, rag=FakeRag())
    cat = await svc.resolve_category(1, "ACID")
    assert cat is not None
    assert cat["id"] == 2
    assert cat["name"] == "事务的隔离级别"


@pytest.mark.asyncio
async def test_exact_name_match_takes_priority_over_alias(alias_db: AsyncSession):
    """精确全匹配优先于别名：若输入恰好也是另一节点的正式名称，走正式名称."""
    await alias_db.execute(
        text(
            "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
            "VALUES (3, 1, 1, 'kp-acid', 'ACID', 3, 'knowledge_point', 2)"
        )
    )
    await alias_db.execute(
        text(
            "INSERT INTO knowledge_category_alias (category_id, alias, source) "
            "VALUES (2, 'ACID', 'manual')"
        )
    )
    await alias_db.commit()
    svc = KnowledgeRetrievalService(alias_db, rag=FakeRag())
    cat = await svc.resolve_category(1, "ACID")
    assert cat["id"] == 3  # 正式节点名精确匹配优先于别名


@pytest.mark.asyncio
async def test_alias_no_match_falls_through(alias_db: AsyncSession):
    """别名表无匹配 → 不影响后续匹配阶段（多词 AND / LIKE 兜底）."""
    svc = KnowledgeRetrievalService(alias_db, rag=FakeRag())
    cat = await svc.resolve_category(1, "隔离级别")
    assert cat is not None
    assert cat["id"] == 2


@pytest.mark.asyncio
async def test_alias_table_missing_degrades_gracefully(db_session: AsyncSession):
    """别名表不存在（未迁移场景）→ 查询静默跳过，不影响其他匹配阶段."""
    await db_session.execute(
        text(
            "CREATE TABLE knowledge_domain (id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "code VARCHAR(64) UNIQUE, name VARCHAR(128))"
        )
    )
    await db_session.execute(
        text(
            "CREATE TABLE knowledge_category (id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "domain_id INTEGER, parent_id INTEGER, node_code VARCHAR(64), name VARCHAR(255), "
            "description TEXT, full_path VARCHAR(1000), level INTEGER, node_type VARCHAR(32), "
            "sort_order INTEGER, status INTEGER DEFAULT 1)"
        )
    )
    await db_session.execute(text("INSERT INTO knowledge_domain (id, code, name) VALUES (1, 'db', '数据库')"))
    await db_session.execute(
        text(
            "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
            "VALUES (2, 1, NULL, 'kp-isolation', '事务的隔离级别', 3, 'knowledge_point', 1)"
        )
    )
    await db_session.commit()
    svc = KnowledgeRetrievalService(db_session, rag=FakeRag())
    cat = await svc.resolve_category(1, "事务的隔离级别")
    assert cat is not None
    assert cat["id"] == 2
    for t in ("knowledge_category", "knowledge_domain"):
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    await db_session.commit()
