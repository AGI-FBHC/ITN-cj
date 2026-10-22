"""一次性：执行 RuleCore migrations + 探查第四章文档 ID."""
from __future__ import annotations

import sys
from pathlib import Path

import pymysql

HERE = Path(__file__).resolve().parent.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from app.core.config import settings  # noqa: E402


def main() -> None:
    sql = (HERE / "migrations" / "2026_08_25_rule_engine.sql").read_text()
    conn = pymysql.connect(
        host=settings.MYSQL_HOST, port=settings.MYSQL_PORT,
        user=settings.MYSQL_USER, password=settings.MYSQL_PASSWORD,
        database=settings.MYSQL_DATABASE, charset="utf8mb4",
    )
    try:
        with conn.cursor() as cur:
            # 逐行去掉注释，再按分号切句（避免注释前缀导致整句被跳过）
            lines = [ln for ln in sql.splitlines() if not ln.strip().startswith("--")]
            clean_sql = "\n".join(lines)
            for stmt in [s.strip() for s in clean_sql.split(";") if s.strip()]:
                cur.execute(stmt)
            conn.commit()
            for t in ("domain_rule", "rule_execution", "rule_compare"):
                cur.execute("SHOW TABLES LIKE %s", (t,))
                row = cur.fetchone()
                print(f"table {t}: {'OK' if row else 'MISSING'}")
            cur.execute(
                "SELECT id, title, source_name FROM knowledge_document "
                "WHERE title LIKE %s OR title LIKE %s ORDER BY id",
                ("%第四章%", "%智能体%"),
            )
            print("--- 候选文档 ---")
            for r in cur.fetchall():
                print(r)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
