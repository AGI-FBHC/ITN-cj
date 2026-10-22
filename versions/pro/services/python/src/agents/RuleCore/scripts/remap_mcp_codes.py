"""一次性迁移：按新 stable_code 算法原地重算 MCP 规则 rule_code + 合并真重复.

背景（2026-08-25）：
旧算法把条件字段名与原始值算进 hash。LLM 抽取非确定性（同一句原文，两次给出
不同字段名 role/implementation_type、不同值大小写 MCP_client/mcp_client）导致
同一逻辑规则拿到不同 code → 双双入库（authorization 页产生 3 组真重复）。
新算法（stable_code.py 已改）只取 source_text + conclusions + 归一化条件值集。
本脚本把已入库的 108 条 MCP 规则按新算法重算 code：
  - 新 code == 旧 code：不动
  - 新 code != 旧 code：UPDATE 重命名（含 rule_execution 同步，若存在）
  - 多条同新 code（真重复）：保留 confidence 最高（平手取 id 最小），删除其余
R38-* 种子规则不参与（手工命名、无漂移风险，且 A/B 对照引用其 code）。

默认 dry-run（只打印计划，不写库）；--apply 真执行。可重复运行（幂等）。

用法：
  .venv/bin/python scripts/remap_mcp_codes.py            # dry-run
  .venv/bin/python scripts/remap_mcp_codes.py --apply    # 真执行
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from app.core.database import db_session  # noqa: E402
from app.rule_engine import stable_code  # noqa: E402
from app.rule_engine.repositories import rule_repository as repo  # noqa: E402

PREFIX = "MCP-"


def load_mcp_rows() -> list[dict]:
    with db_session() as cur:
        cur.execute(
            f"SELECT {repo.RULE_COLUMNS} FROM domain_rule "
            f"WHERE rule_code LIKE %s ORDER BY id", (f"{PREFIX}%",),
        )
        return list(cur.fetchall())


def prefix_of(code: str) -> str:
    # MCP-<section>-<10hex> → 去掉最后 11 字符
    return code[: -11]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真执行（默认 dry-run）")
    args = ap.parse_args()

    rows = load_mcp_rows()
    print(f"载入 MCP 规则 {len(rows)} 条")

    # 1) 按新算法算 code，分组
    groups: dict[str, list[dict]] = {}
    for row in rows:
        rule = repo._row_to_schema(row)  # noqa: SLF001
        pfx = prefix_of(row["rule_code"])
        new_code = stable_code.stable_rule_code(pfx, rule)
        groups.setdefault(new_code, []).append((row, rule, pfx))

    rename, keep, delete = [], [], []
    for new_code, members in groups.items():
        # 幸存者：confidence 最高，平手 id 最小
        members.sort(key=lambda m: (-float(m[0]["confidence"] or 0), m[0]["id"]))
        winner = members[0][0]
        keep.append(winner)
        for row, _, _ in members[1:]:
            delete.append(row)
        for row, _, _ in members:
            if row["rule_code"] != new_code:
                rename.append((row["id"], row["rule_code"], new_code))

    n_unchanged = len(rows) - len({r[0] for r in rename} | {row["id"] for row in delete})
    print(f"\n计划：")
    print(f"  不变: {n_unchanged} 条（新旧 code 相同）")
    print(f"  重命名: {len(rename)} 条")
    for rid, old, new in rename:
        print(f"    id={rid}  {old}  ->  {new}")
    print(f"  合并删除: {len(delete)} 条（同新 code，保留高 conf）")
    for row in delete:
        print(f"    id={row['id']}  {row['rule_code']}  conf={row['confidence']}  status={row['status']}  {row['name'][:40]}")

    # 终态唯一性断言：幸存者的新 code 必须互不相同
    final_codes: set[str] = set()
    for new_code, members in groups.items():
        members.sort(key=lambda m: (-float(m[0]["confidence"] or 0), m[0]["id"]))
        if new_code in final_codes:  # 理论上不可能（已按新 code 分组）
            print("!! 终态 code 冲突，中止"); sys.exit(1)
        final_codes.add(new_code)
    # 还要确认幸存新 code 不与任何将被删除但尚未处理的旧 code 撞（删除在后，无影响）
    # 以及与库内非 MCP 规则（R38）不撞
    with db_session() as cur:
        cur.execute("SELECT rule_code FROM domain_rule WHERE rule_code NOT LIKE %s", (f"{PREFIX}%",))
        others = {r["rule_code"] for r in cur.fetchall()}
    clash = final_codes & others
    if clash:
        print(f"!! 与已有规则 code 冲突: {clash}，中止"); sys.exit(1)

    if not args.apply:
        print(f"\nDRY-RUN：未写库。执行后将剩 {len(keep)} 条 MCP 规则。加 --apply 真执行。")
        return

    # 2) 执行：先删 loser（含执行日志），再两阶段重命名（防新旧 code 撞唯一键）
    #    阶段一：全部重命名 -> 临时码 TMP_...（临时码空间与新旧码不交）
    #    阶段二：临时码 -> 最终码
    with db_session() as cur:
        for row in delete:
            cur.execute("DELETE FROM rule_execution WHERE rule_code=%s", (row["rule_code"],))
            cur.execute("DELETE FROM domain_rule WHERE id=%s", (row["id"],))
        for i, (rid, old, new) in enumerate(rename):
            tmp = f"TMPREM_{rid}_{i}"
            cur.execute("UPDATE rule_execution SET rule_code=%s WHERE rule_code=%s", (tmp, old))
            cur.execute("UPDATE domain_rule SET rule_code=%s WHERE id=%s", (tmp, rid))
        for i, (rid, old, new) in enumerate(rename):
            tmp = f"TMPREM_{rid}_{i}"
            cur.execute("UPDATE rule_execution SET rule_code=%s WHERE rule_code=%s", (new, tmp))
            cur.execute("UPDATE domain_rule SET rule_code=%s WHERE rule_code=%s", (new, tmp))
        cur.execute("SELECT COUNT(*) AS n FROM domain_rule WHERE rule_code LIKE %s", (f"{PREFIX}%",))
        print(f"\n已执行。剩余 MCP 规则: {cur.fetchone()['n']} 条")

    # 3) 复验：无重复新 code
    with db_session() as cur:
        cur.execute(
            "SELECT rule_code, COUNT(*) n FROM domain_rule "
            "WHERE rule_code LIKE %s GROUP BY rule_code HAVING n>1", (f"{PREFIX}%",),
        )
        dups = cur.fetchall()
        print(f"复验重复 code: {len(dups)} 条（应为 0）")


if __name__ == "__main__":
    main()
