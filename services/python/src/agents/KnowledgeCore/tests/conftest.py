"""Test configuration and fixtures."""

from __future__ import annotations

import asyncio
import os
from typing import AsyncGenerator

# ── 测试隔离：单测绝不触网 ──
# config.Settings 会加载 src/agents/.env（部署配置），若其中配置了真实的
# reranker 端点/密钥，KNOWLEDGE_RERANK 默认 on 会让检索单测真调云 API
# （2026-08-18 实测把套件从 ~15s 拖到 ~90s）。环境变量优先级高于 .env 文件，
# 在导入任何 app 模块之前置空，保证 reranker 在单测中恒为 no-op；
# 需要验证重排逻辑的测试自行 mock settings / rerank 函数。
os.environ["RERANKER_API_URL"] = ""
os.environ["RERANKER_API_KEY"] = ""
# 同理隔离 LLM 证据复核开关：.env 开启 KNOWLEDGE_LLM_JUDGE 时单测会真调 LLM
# （2026-08-19 并行任务实测导致挂起/偶发失败）。需要验证 judge 逻辑的测试自行
# mock judge / fake settings。
os.environ["KNOWLEDGE_LLM_JUDGE"] = "false"

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.database import Base


# Use SQLite for testing (in-memory)
TEST_DATABASE_URL = "sqlite+aiosqlite:///./test.db"


@pytest.fixture(scope="session")
def event_loop():
    """Create event loop for the test session."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="session")
async def engine():
    """Create async engine for testing."""
    engine = create_async_engine(TEST_DATABASE_URL, echo=False)

    # Create all tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield engine

    # Drop all tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(engine) -> AsyncGenerator[AsyncSession, None]:
    """Create a new database session for a test."""
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with session_factory() as session:
        yield session
        await session.rollback()
