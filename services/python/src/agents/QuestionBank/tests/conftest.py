"""测试公共设施：可选连接独立测试 MySQL（事务回滚，零污染）。

每个测试注入独立的 `qb_conn`（autocommit=False），服务方法通过 conn 参数
复用该连接；fixture teardown 统一 rollback，测试数据永不落库。

安全约束（T5.2）：连接信息只读取专用的 ``TEST_MYSQL_*`` 环境变量，
**不再**读取 `questionbank.config`（应用运行态用的 `MYSQL_*`，在
`src/agents/.env` 中指向生产库 113.249.110.108/itn-platform）。若检测到
`TEST_MYSQL_*` 仍指向生产库特征（生产库 host、库名为 `itn-platform`，
或 host 不是 localhost/127.0.0.1 的内网测试库），直接 `pytest.exit`，
避免单测误连生产数据库。未配置 `TEST_MYSQL_*` 时按原逻辑 `pytest.skip`，
不影响不依赖 MySQL 的绝大多数单测。
"""
import os
import uuid

import pytest
import pymysql

from questionbank.services.question import QuestionCreate

# 生产库特征：见 src/agents/.env.example（MYSQL_HOST=113.249.110.108,
# MYSQL_DATABASE=itn-platform）与 QuestionBank/.env.example。
_PROD_HOSTS = {"113.249.110.108"}
_PROD_DATABASES = {"itn-platform"}
_SAFE_HOSTS = {"", "localhost", "127.0.0.1"}


def _looks_like_production(host: str, database: str) -> bool:
    if host in _PROD_HOSTS or database in _PROD_DATABASES:
        return True
    if host and host not in _SAFE_HOSTS:
        return True
    return False


def _test_mysql_config() -> dict | None:
    host = os.environ.get("TEST_MYSQL_HOST", "")
    if not host:
        return None
    database = os.environ.get("TEST_MYSQL_DATABASE", "")
    if _looks_like_production(host, database):
        pytest.exit(
            "检测到 TEST_MYSQL_HOST/TEST_MYSQL_DATABASE 指向疑似生产库"
            f"（host={host!r}, database={database!r}）。QuestionBank 测试套件"
            "禁止连接生产 MySQL，请改配隔离的测试库。",
            returncode=1,
        )
    return {
        "host": host,
        "port": int(os.environ.get("TEST_MYSQL_PORT", "3306")),
        "user": os.environ.get("TEST_MYSQL_USER", ""),
        "password": os.environ.get("TEST_MYSQL_PASSWORD", ""),
        "database": database,
    }


@pytest.fixture(scope="session")
def qb_conn():
    cfg = _test_mysql_config()
    if cfg is None:
        pytest.skip("未配置 TEST_MYSQL_*（题库集成测试需要独立测试库，默认跳过）")
    try:
        conn = pymysql.connect(
            host=cfg["host"],
            port=cfg["port"],
            user=cfg["user"],
            password=cfg["password"],
            database=cfg["database"],
            charset="utf8mb4",
            connect_timeout=8,
            autocommit=False,
            cursorclass=pymysql.cursors.DictCursor,
        )
    except pymysql.MySQLError as exc:
        pytest.skip(f"MySQL 不可达: {exc}")
    yield conn
    conn.close()


@pytest.fixture
def rollback(qb_conn):
    """每个测试结束后回滚（依赖注入：先执行 SQL 再自动回滚）."""
    yield qb_conn
    qb_conn.rollback()


def unique_stem(prefix: str = "测试题") -> str:
    """唯一题干，避免 content_hash 跨测试冲突."""
    return f"{prefix} {uuid.uuid4().hex[:12]}"


def make_single_choice(**overrides) -> QuestionCreate:
    base = {
        "question_type": "single_choice",
        "difficulty": 3,
        "cognitive_level": "understand",
        "stem": unique_stem(),
        "options": [
            {"key": "A", "text": "选项A"},
            {"key": "B", "text": "选项B"},
            {"key": "C", "text": "选项C"},
            {"key": "D", "text": "选项D"},
        ],
        "reference_answer": "B",
        "explanation": "答案解析",
        "source_type": "human",
    }
    base.update(overrides)
    return QuestionCreate(**base)
