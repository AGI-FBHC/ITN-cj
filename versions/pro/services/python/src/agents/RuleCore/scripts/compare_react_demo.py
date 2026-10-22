#!/usr/bin/env python3
"""A/B 对照测试用例：ReAct 范式 + 反思（与 MCP 无关）.

用途：一键发起一次"有规则 vs 无规则"对照并轮询到完成，打印命中规则与两臂成绩。
命中规则：R38-001（T-A-O 循环）、R38-002（Finish 输出）、R38-004（反思终止条件）、
         R38-005（反思串行对延迟的影响，SHOULD）。

用法：
    .venv/bin/python scripts/compare_react_demo.py            # 发起新对照并等待
    .venv/bin/python scripts/compare_react_demo.py --task-id cmp_xxx   # 只查已有对照
    .venv/bin/python scripts/compare_react_demo.py --base http://127.0.0.1:8201
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request

TASK = (
    "为一款内部知识问答系统编写智能体核心循环的设计说明文档。"
    "该智能体采用 ReAct 范式（paradigm=ReAct），并且启用了反思机制"
    "（use_reflection=true）用于提升答案质量。请说明："
    "(1) 每一轮推理-行动循环如何组织；"
    "(2) 何时以及如何输出最终答案；"
    "(3) 反思循环的终止条件；"
    "(4) 反思对整体响应延迟的影响。"
)


def _post(base: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(body).encode() if body else None,
        headers={"Content-Type": "application/json"},
        method="POST" if body else "GET",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def _get(base: str, path: str) -> dict:
    with urllib.request.urlopen(f"{base}{path}", timeout=30) as r:
        return json.loads(r.read().decode())


def _show_check(tag: str, c: dict | None) -> None:
    if not c:
        print(f"  {tag}: (无)")
        return
    print(f"  {tag}: passed={c['passed']}")
    for r in c["results"]:
        print(f"    {r['status']:5} {r['rule_code']}  {str(r.get('evidence') or r.get('reason'))[:90]}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8201")
    ap.add_argument("--task-id", help="只查询已有对照，不发起新任务")
    ap.add_argument("--poll-interval", type=float, default=20.0)
    ap.add_argument("--timeout", type=float, default=600.0)
    args = ap.parse_args()

    if args.task_id:
        task_id = args.task_id
    else:
        print(f"发起对照（任务：{TASK[:40]}...）")
        task_id = _post(args.base, "/api/rules/compare", {"task": TASK})["task_id"]
        print(f"task_id: {task_id}")

    deadline = time.time() + args.timeout
    t: dict = {}
    while time.time() < deadline:
        t = _get(args.base, f"/api/rules/compare/{task_id}")
        status = t.get("status")
        print(f"  [{time.strftime('%H:%M:%S')}] status={status}")
        if status in ("DONE", "FAILED"):
            break
        time.sleep(args.poll_interval)
    else:
        print("超时未完成，可用 --task-id 继续查询")
        return 1

    if t.get("status") == "FAILED":
        print("FAILED:", t.get("error"))
        return 1

    print()
    print("facts:", t.get("facts_json"))
    print("matched_rules:", t.get("matched_rules"))
    print("summary:", json.dumps(t.get("summary"), ensure_ascii=False))
    print()
    _show_check("A 臂(无规则)", t.get("check_a_json"))
    _show_check("B 臂(有规则)", t.get("check_b_json"))
    if t.get("check_b_revised_json"):
        _show_check("B 臂(修正后)", t["check_b_revised_json"])
    s = t.get("summary") or {}
    print()
    print(f"结果：A {s.get('arm_a_pass')}/{s.get('constraint_total')}  vs  "
          f"B {s.get('arm_b_pass')}/{s.get('constraint_total')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
