"""MySQL 连接（pymysql，同步——RuleCore 是独立服务，MVP 不需要异步池）."""
from __future__ import annotations

from typing import Any

import pymysql
from pymysql.cursors import DictCursor

from app.core.config import settings


def get_conn() -> pymysql.connections.Connection:
    return pymysql.connect(
        **settings.mysql_dsn,
        cursorclass=DictCursor,
        connect_timeout=15,
        read_timeout=120,
        write_timeout=120,
    )


class db_session:
    """简单上下文管理器：自动 commit / rollback / close.

    `as cur` 拿到的是 DictCursor，fetchone/fetchall 返回 dict 行。
    """

    conn: pymysql.connections.Connection
    cur: Any  # DictCursor

    def __enter__(self) -> Any:
        self.conn = get_conn()
        self.cur = self.conn.cursor()
        return self.cur

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                self.conn.commit()
            else:
                self.conn.rollback()
        finally:
            self.conn.close()
        return False
