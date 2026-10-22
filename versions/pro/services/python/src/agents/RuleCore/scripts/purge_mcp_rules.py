"""按前缀整批删除规则（默认 MCP- 前缀）+ 关联执行日志.

配合 scripts/ingest_mcp_rules.py：入库内容"可删除"的保证。
默认 DRY-RUN（只打印将删除的规则清单与数量），加 --apply 才真删。

用法：
  .venv/bin/python scripts/purge_mcp_rules.py                # 预览（MCP- 前缀）
  .venv/bin/python scripts/purge_mcp_rules.py --prefix MCP- --apply   # 真删
  .venv/bin/python scripts/purge_mcp_rules.py --prefix R38- --apply   # 删种子规则
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from app.core.database import db_session  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prefix", default="MCP-", help="rule_code 前缀")
    ap.add_argument("--apply", action="store_true", help="真删（默认 dry-run 只预览）")
    args = ap.parse_args()

    with db_session() as cur:
        cur.execute(
            "SELECT id, rule_code, name, status, confidence FROM domain_rule "
            "WHERE rule_code LIKE %s ORDER BY id",
            (f"{args.prefix}%",),
        )
        rows = cur.fetchall()

    print(f"匹配前缀 '{args.prefix}%' 的规则: {len(rows)} 条")
    for r in rows:
        print(f"  [{r['status']}] {r['rule_code']} conf={r['confidence']:.2f} {r['name'][:40]}")

    if not rows:
        print("无可删除规则，退出。")
        return

    if not args.apply:
        print("\nDRY-RUN：未删除。加 --apply 执行真删。")
        return

    with db_session() as cur:
        cur.execute(
            "DELETE FROM rule_execution WHERE rule_code LIKE %s", (f"{args.prefix}%",)
        )
        exec_deleted = cur.rowcount
        cur.execute(
            "DELETE FROM domain_rule WHERE rule_code LIKE %s", (f"{args.prefix}%",)
        )
        rule_deleted = cur.rowcount

    print(f"\n已删除: domain_rule {rule_deleted} 条, rule_execution {exec_deleted} 条")


if __name__ == "__main__":
    main()
