"""Database configuration and session management."""

from collections.abc import AsyncGenerator
from functools import lru_cache

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import get_settings


class Base(DeclarativeBase):
    """SQLAlchemy declarative base for all ORM models."""
    pass


@lru_cache
def get_engine():
    """Get async engine (lazy, cached — 进程内只建一次，连接池可复用)."""
    settings = get_settings()
    DATABASE_URL = (
        f"mysql+aiomysql://{settings.MYSQL_USER}:{settings.MYSQL_PASSWORD}"
        f"@{settings.MYSQL_HOST}:{settings.MYSQL_PORT}/{settings.MYSQL_DB}"
    )
    return create_async_engine(DATABASE_URL, echo=settings.DEBUG, pool_pre_ping=True)


@lru_cache
def get_session_factory():
    """Get async session factory (cached — 复用同一 engine/连接池)."""
    return async_sessionmaker(get_engine(), class_=AsyncSession, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Dependency for getting async database session."""
    session_factory = get_session_factory()
    async with session_factory() as session:
        yield session
