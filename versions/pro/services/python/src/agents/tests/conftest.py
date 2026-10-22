import os
from pathlib import Path
import sqlite3

os.environ.setdefault("AGENT_INTERNAL_SECRET", "test-internal-secret-that-is-at-least-32-bytes")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret")
os.environ.setdefault("AGENT_DATABASE_PATH", str(Path(".pytest_cache") / "agents-test.db"))
os.environ.setdefault("LLM_PROVIDER", "mock")

import pytest
from fastapi.testclient import TestClient

from app.routers.internal import repository
from app.routers.public import chat_store, directory, presentation_store
from app.config import get_settings
from app.main import create_app
from app.storage import run_repository as run_repo_module


class _FakeRunCursor:
    """把 pymysql 风格的 cursor 映射到 sqlite，方便无 MySQL 环境下跑 run 仓库测试。"""
    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn
        self._rows: list[dict] = []

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def execute(self, sql: str, params=None):
        sqlite_sql = sql.replace("%s", "?")
        cursor = self._conn.execute(sqlite_sql, params or ())
        if sqlite_sql.lstrip().upper().startswith("SELECT"):
            self._rows = [dict(row) for row in cursor.fetchall()]
        else:
            self._rows = []
        return cursor

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _FakeRunConnection:
    def __init__(self, path):
        self._conn = sqlite3.connect(path)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self._conn.commit()
        else:
            self._conn.rollback()
        self._conn.close()
        return False

    def cursor(self):
        return _FakeRunCursor(self._conn)

    def commit(self):
        self._conn.commit()


@pytest.fixture(autouse=True)
def fake_run_repository_db(tmp_path, monkeypatch):
    db_path = tmp_path / "agent-runs.db"

    def fake_connect(settings):
        return _FakeRunConnection(db_path)

    monkeypatch.setattr(run_repo_module, "platform_connect", fake_connect)


@pytest.fixture(autouse=True)
def reset_dependencies(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_DATABASE_PATH", str(tmp_path / "agents.db"))
    get_settings.cache_clear()
    repository.cache_clear()
    chat_store.cache_clear()
    directory.cache_clear()
    presentation_store.cache_clear()
    yield
    repository.cache_clear()
    chat_store.cache_clear()
    directory.cache_clear()
    presentation_store.cache_clear()
    get_settings.cache_clear()


@pytest.fixture
def client():
    with TestClient(create_app()) as test_client:
        yield test_client
