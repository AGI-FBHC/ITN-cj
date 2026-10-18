#!/usr/bin/env python3
"""P3 path-coverage table: every Python /v1 and /internal/v1 route must be
either LOCAL (Spire implements it) or FWD (hit the catch-all forwarder).
Uncovered must be 0.

Also flags routes that Spire serves locally but that Python's generation
registry owns (create/restart/cancel/delete of generation tasks) — those must
be FWD, not LOCAL, or the asyncio enqueue never happens.

Usage: python route_coverage.py
Writes: tmp_verify/route_coverage.md   (human table)
        tmp_verify/route_coverage.json (machine check)
"""
from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BETA = r"D:\cangjie\ITN-Beta"

PUBLIC = os.path.join(BETA, "src", "agents", "app", "routers", "public.py")
INTERNAL = os.path.join(BETA, "src", "agents", "app", "routers", "internal.py")

DECOR = re.compile(
    r'^@router\.(get|post|put|patch|delete)\(\s*"([^"]+)"',
    re.IGNORECASE | re.MULTILINE,
)
MULTI = re.compile(
    r'^@router\.(get|post|put|patch|delete)\(\s*\n\s*"([^"]+)"',
    re.IGNORECASE | re.MULTILINE,
)
SPIRE = re.compile(
    r'app\.map(Get|Post|Put|Patch|Delete)?\(\s*"([^"]+)"',
    re.IGNORECASE,
)

# Python routes whose write path must stay in Python because they call
# _enqueue_generation / cancel a task in one of the in-process registries
# (_learning_resource_generation_tasks, _course_tasks, _course_resource_retry_tasks).
# Spire must NOT register these — the catch-all forwards them.
# Measured against public.py call sites, 2026-10-17.
GEN_LIFECYCLE = {
    ("POST", "/v1/presentations"),
    ("POST", "/v1/presentations/{task_id}/restart"),
    ("POST", "/v1/presentations/{task_id}/cancel"),
    ("POST", "/v1/presentations/{task_id}/generate"),
    ("POST", "/v1/courses"),
    ("POST", "/v1/courses/{course_id}/regenerate"),
    ("POST", "/v1/courses/{course_id}/retry"),
    ("POST", "/v1/courses/{course_id}/chapters/{chapter_id}/resources/{resource_type}/retry"),
    ("DELETE", "/v1/courses/{course_id}"),
    ("POST", "/v1/learning-resource-tasks/{resource_type}"),
    ("POST", "/v1/learning-resource-tasks/{task_id}/restart"),
    ("POST", "/v1/learning-resource-tasks/{task_id}/cancel"),
    ("DELETE", "/v1/learning-resource-tasks/{task_id}"),
    ("POST", "/v1/admin-generation-batches"),
    ("POST", "/v1/customize-resource"),
}


def is_gen_lifecycle(method: str, path: str) -> bool:
    return (method, path) in GEN_LIFECYCLE


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def python_routes():
    out = []
    for src, prefix in ((PUBLIC, "/v1"), (INTERNAL, "/internal/v1")):
        text = read(src)
        for m in DECOR.finditer(text):
            method, path = m.group(1).upper(), m.group(2)
            out.append((method, prefix + path))
        for m in MULTI.finditer(text):
            method, path = m.group(1).upper(), m.group(2)
            if (method, prefix + path) not in out:
                out.append((method, prefix + path))
    return out


def spire_routes():
    out = []
    for name in sorted(os.listdir(os.path.join(ROOT, "src"))):
        if not name.endswith(".cj"):
            continue
        text = read(os.path.join(ROOT, "src", name))
        for m in SPIRE.finditer(text):
            verb, path = m.group(1), m.group(2)
            method = (verb or "ANY").upper()
            out.append((method, "/" + path.lstrip("/")))
    return out


def normalize(p):
    return "/" + p.lstrip("/")


def pattern_matches(pattern, path):
    """ASP.NET-ish: {x} one segment, {*rest} the remainder."""
    pp = [s for s in normalize(pattern).split("/") if s != ""]
    sp = [s for s in normalize(path).split("/") if s != ""]
    i = 0
    for seg in pp:
        if seg.startswith("{*"):
            return True
        if i >= len(sp):
            return False
        if seg.startswith("{"):
            i += 1
            continue
        if seg.lower() != sp[i].lower():
            return False
        i += 1
    return i == len(sp)


def main():
    py = python_routes()
    sp = spire_routes()

    local = [(m, normalize(p)) for m, p in sp if p not in ("/health",) and normalize(p).startswith(("/v1", "/internal/v1"))]
    catchalls = [normalize(p) for m, p in sp if "{*rest}" in p]

    rows = []
    uncovered = []
    wrong_owner = []
    gen_missing = []

    for method, path in py:
        path = normalize(path)
        # exact / pattern match against a LOCAL registration of the same method
        local_hit = None
        for lm, lp in local:
            if lm == method and (lp == path or pattern_matches(lp, path)):
                local_hit = lp
                break
        # some Spire regs use ANY (app.map) — those are the catch-alls themselves
        if local_hit:
            owner = "LOCAL"
            # generation-lifecycle writes must not be local
            if is_gen_lifecycle(method, path):
                wrong_owner.append({"method": method, "path": path, "local_pattern": local_hit})
        else:
            # does it fall through to a catch-all?
            hit = any(
                (path == c) or path.startswith(c.replace("/{*rest}", "/")) or pattern_matches(c, path)
                for c in catchalls
            )
            owner = "FWD" if hit else "UNCOVERED"
            if not hit:
                uncovered.append({"method": method, "path": path})
        rows.append({"method": method, "path": path, "owner": owner, "local_pattern": local_hit})

    # Spire LOCAL routes that no Python route claims (extra surface — fine, but listed)
    extra = []
    for lm, lp in local:
        if not any(lm == rm and (lp == rp or pattern_matches(lp, rp)) for rm, rp in py):
            extra.append({"method": lm, "path": lp})

    # every generation-lifecycle route must exist in Python and be owned by FWD
    by_key = {(r["method"], r["path"]): r for r in rows}
    for key in sorted(GEN_LIFECYCLE):
        r = by_key.get(key)
        if r is None:
            gen_missing.append({"method": key[0], "path": key[1], "why": "not in Python route list"})
        elif r["owner"] != "FWD":
            gen_missing.append({"method": key[0], "path": key[1], "why": "owner=" + r["owner"]})

    result = {
        "python_route_count": len(py),
        "spire_local_count": len(local),
        "catchalls": catchalls,
        "uncovered_count": len(uncovered),
        "uncovered": uncovered,
        "wrong_owner_count": len(wrong_owner),
        "wrong_owner": wrong_owner,
        "gen_lifecycle_not_fwd": gen_missing,
        "spire_local_without_python_twin": extra,
        "rows": rows,
    }

    os.makedirs(HERE, exist_ok=True)
    with open(os.path.join(HERE, "route_coverage.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    def md_escape(s):
        return s.replace("|", "\\|")

    lines = []
    lines.append("# P3 路径覆盖表 (LOCAL vs FWD)")
    lines.append("")
    lines.append("生成方式: `python tmp_verify/route_coverage.py`（对比 Python 路由与 Spire 本地注册）")
    lines.append("")
    lines.append("| 口径 | 数值 |")
    lines.append("| --- | --- |")
    lines.append("| Python `/v1` + `/internal/v1` 路由 | %d |" % len(py))
    lines.append("| Spire 本地注册 (不含 health) | %d |" % len(local))
    lines.append("| 转发兜底 `v1/{*rest}` / `internal/v1/{*rest}` | %d |" % len(catchalls))
    lines.append("| **未覆盖 (uncovered)** | **%d** |" % len(uncovered))
    lines.append("| 归属错误 (生成生命周期被本地接管) | %d |" % len(wrong_owner))
    lines.append("")
    lines.append("## 逐条")
    lines.append("")
    lines.append("| Method | Path | 归属 | Spire 本地模式 |")
    lines.append("| --- | --- | --- | --- |")
    for r in rows:
        lines.append(
            "| %s | `%s` | %s | %s |"
            % (r["method"], md_escape(r["path"]), r["owner"], ("`%s`" % md_escape(r["local_pattern"])) if r["local_pattern"] else "—")
        )
    lines.append("")
    if wrong_owner:
        lines.append("## 归属错误 (必须改为 FWD)")
        lines.append("")
        for w in wrong_owner:
            lines.append("- `%s %s` 被本地 `%s` 接管" % (w["method"], w["path"], w["local_pattern"]))
        lines.append("")
    if extra:
        lines.append("## Spire 本地有、Python 无同名 (额外面, 不影响覆盖)")
        lines.append("")
        for e in extra:
            lines.append("- `%s %s`" % (e["method"], e["path"]))
        lines.append("")

    with open(os.path.join(HERE, "route_coverage.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print("python routes      : %d" % len(py))
    print("spire local        : %d" % len(local))
    print("uncovered          : %d" % len(uncovered))
    print("wrong owner        : %d" % len(wrong_owner))
    print("gen-lifecycle not FWD: %d" % len(gen_missing))
    print("spire-only extras  : %d" % len(extra))
    for w in wrong_owner:
        print("  WRONG-OWNER %s %s -> %s" % (w["method"], w["path"], w["local_pattern"]))
    for u in uncovered:
        print("  UNCOVERED  %s %s" % (u["method"], u["path"]))
    for g in gen_missing:
        print("  GEN-NOT-FWD %s %s  (%s)" % (g["method"], g["path"], g["why"]))
    print("wrote tmp_verify/route_coverage.md / .json")
    sys.exit(0 if not uncovered and not wrong_owner and not gen_missing else 1)


if __name__ == "__main__":
    main()
