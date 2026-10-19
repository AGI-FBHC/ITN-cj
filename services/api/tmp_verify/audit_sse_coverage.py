# -*- coding: utf-8 -*-
"""
SSE 覆盖率静态审计：把 Python/Java 里所有流式端点抓出来，
用与 gateway.cj 完全相同的判定规则逐条核对，输出覆盖矩阵。

退出码 1 表示存在未覆盖端点。

用法： D:\\anaconda\\python.exe tmp_verify/audit_sse_coverage.py
"""

import re
import sys

PUBLIC = r"d:\project\ITN-full\src\agents\app\routers\public.py"
INTERNAL = r"d:\project\ITN-full\src\agents\app\routers\internal.py"
PREDEAL = r"d:\project\ITN-full\src\agents\predeal\src\predeal\web\app.py"


def routes_with_streaming(path):
    """Return [(method, route)] for every StreamingResponse-bearing handler."""
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    decorators = []
    for i, line in enumerate(lines):
        m = re.match(r'@router\.(get|post|put|delete)\(("([^"]+)")', line)
        if m:
            decorators.append((i + 1, m.group(1).upper(), m.group(3)))
    out = []
    for i, line in enumerate(lines):
        if "StreamingResponse(" not in line or "import" in line:
            continue
        prev = [d for d in decorators if d[0] < i + 1]
        if prev:
            out.append((prev[-1][1], prev[-1][2]))
    return out


# 与 gateway.cj 的 isKnownStreamPath 保持一致（手工同步；不一致时本审计会报错）
def is_known_stream(path):
    p = path.lower()
    if "stream" in p:
        return True, "contains stream"
    if "/tts" in p:
        return True, "tts"
    if "/audio/" in p:
        return True, "slide audio"
    if "/memory/profile-analysis" in p:
        return True, "profile-analysis"
    if "/chat/sessions/" in p and "/resume" in p:
        return True, "chat resume"
    if "/admin/predeal/progress/" in p:
        return True, "predeal progress"
    return False, ""


def main():
    rows = []
    for p in (PUBLIC, INTERNAL):
        for method, route in routes_with_streaming(p):
            rows.append((p.split("\\")[-1], method, route))

    # Java 侧流式：AdminKnowledgeProxyController 的 predeal progress
    rows.append(("AdminKnowledgeProxyController.java", "GET",
                 "/api/v1/admin/predeal/progress/{taskId}"))

    # predeal 自带 SSE（GET /api/progress/<id>）不经过 Spire：
    #   浏览器 -> /api/v1/admin/predeal/progress/{taskId} -> Java -> predeal
    # 因此它不在网关的覆盖范围内，上面那条 Java 路由才是 Spire 需要处理的入口。

    print("%-34s %-6s %-46s %-8s %s" % ("source", "method", "path", "covered", "rule"))
    print("-" * 110)
    missed = 0
    for src, method, route in rows:
        # 网关匹配的是实际请求路径（带开头斜杠）
        actual = route if route.startswith("/") else "/" + route
        ok, why = is_known_stream(actual)
        if not ok:
            missed += 1
        print("%-34s %-6s %-46s %-8s %s" % (src, method, route, "YES" if ok else "NO", why))

    print("-" * 110)
    print("total=%d covered=%d uncovered=%d" % (len(rows), len(rows) - missed, missed))
    return 0 if missed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
