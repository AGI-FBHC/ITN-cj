# -*- coding: utf-8 -*-
"""
SSE 真实链路对照：直连 Python(:8000) vs 经 Spire 网关。

不使用桩。造一条非终态任务（status=generating），Python 会持续输出事件并保活，
因此：
  - 网关若缓冲 → 4 秒窗口内一个字节都收不到（会一直等到连接结束/120s 超时）
  - 网关若逐段透传 → 首帧在 1 秒内到达

用法： D:\\anaconda\\python.exe tmp_verify/verify_sse_real.py
"""

import base64
import hashlib
import hmac
import http.client
import json
import os
import socket
import subprocess
import sys
import time
import uuid

import pymysql

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXE = os.path.join(ROOT, "target", "release", "bin", "main.exe")
ENV_FILE = r"d:\project\ITN-full\src\agents\.env"
CJ = r"D:\software\cangjie\sdk-1.2.0\cangjie"
ANACONDA_LIB = r"D:\anaconda\Library\bin"

PY_PORT = 8000
SPIRE_PORT = 18902
WINDOW = 4.0
RESULTS = []


def mark(rid, label, ok, detail=""):
    RESULTS.append(ok)
    print("[%s] %-4s %s%s" % ("PASS" if ok else "FAIL", rid, label,
                              ("  :: " + detail) if detail else ""))


def wait_port(port, timeout=20.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.15)
    return False


def load_env(path):
    out = {}
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            k, v = s.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def parse_db(url):
    rest = url
    for pre in ("mysql+pymysql://", "mysql://", "mysql:"):
        if rest.startswith(pre):
            rest = rest[len(pre):]
            break
    rest = rest.lstrip("/")
    hp, _, db = rest.partition("/")
    ui, _, hp = hp.partition("@")
    user, _, pwd = ui.partition(":")
    host, _, port = hp.partition(":")
    return host, int(port or 3306), user, pwd, db


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def sign_jwt(secret, sub, ttl=3600):
    header = {"alg": "HS256", "typ": "JWT"}
    now = int(time.time())
    payload = {"sub": sub, "iat": now, "exp": now + ttl}
    seg = (b64url(json.dumps(header, separators=(",", ":")).encode()) + "." +
           b64url(json.dumps(payload, separators=(",", ":")).encode()))
    sig = hmac.new(secret.encode(), seg.encode(), hashlib.sha256).digest()
    return seg + "." + b64url(sig)


def collect(port, path, token, window=WINDOW):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=window + 2)
    t0 = time.time()
    conn.request("GET", path, headers={"Authorization": "Bearer " + token,
                                       "Accept": "text/event-stream"})
    r = conn.getresponse()
    sock = conn.sock
    sock.settimeout(0.3)
    chunks = []
    first = None
    deadline = t0 + window
    try:
        while time.time() < deadline:
            try:
                b = r.read1(4096)
            except socket.timeout:
                continue
            except Exception:            # noqa: BLE001
                break
            if not b:
                break
            if first is None:
                first = time.time() - t0
            chunks.append((time.time() - t0, b))
    finally:
        try:
            conn.close()
        except Exception:                # noqa: BLE001
            pass
    return r.status, r.getheader("Content-Type"), first, chunks


def main():
    proc = None
    logf = None
    db = None
    u = uuid.uuid4()
    task = uuid.uuid4()
    try:
        secrets = load_env(ENV_FILE)
        sec = secrets.get("JWT_SECRET", "")
        url = secrets.get("PLATFORM_DB_URL", "")
        if not sec or not url:
            print("缺少 JWT_SECRET / PLATFORM_DB_URL")
            return 2
        if not wait_port(PY_PORT, 3):
            print("Python agents(:%d) 未运行，无法做真实链路对照" % PY_PORT)
            return 2

        host, port, user, pwd, dbname = parse_db(url)
        db = pymysql.connect(host=host, port=port, user=user, password=pwd,
                             database=dbname, charset="utf8mb4", autocommit=True)
        cur = db.cursor()
        cur.execute(
            "INSERT INTO users (id,email,password_hash,active,account_type,created_at,updated_at) "
            "VALUES (UNHEX(%s),%s,'x',1,'LEARNER',NOW(6),NOW(6))",
            (u.hex, "ssereal-%s@local" % u.hex[:8]))
        events = [
            {"type": "agent", "agentName": "researcher", "title": "步骤一", "detail": "解析主题"},
            {"type": "agent", "agentName": "writer", "title": "步骤二", "detail": "生成大纲"},
            {"type": "agent", "agentName": "reviewer", "title": "步骤三", "detail": "内容审查"},
        ]
        cur.execute(
            "INSERT INTO presentation_tasks "
            "(id,user_id,title,status,progress,stage_message,request_json,events_json,"
            "resource_scope,created_at,updated_at) "
            "VALUES (UNHEX(%s),UNHEX(%s),'SSE real test','generating',10,'running',"
            "CAST('{}' AS JSON),CAST(%s AS JSON),'USER',NOW(6),NOW(6))",
            (task.hex, u.hex, json.dumps(events, ensure_ascii=False)))

        token = sign_jwt(sec, str(u))
        path = "/v1/admin-generation-tasks/ppt/%s/stream" % task

        # 1) 直连 Python
        st_py, ct_py, first_py, chunks_py = collect(PY_PORT, path, token)
        mark("R1", "直连 Python 首帧 <1.5s",
             st_py == 200 and first_py is not None and first_py < 1.5,
             "status=%d ct=%s first=%s chunks=%d" %
             (st_py, ct_py, ("%.2fs" % first_py) if first_py else "none", len(chunks_py)))

        # 2) 启动 Spire 指向真实 Python
        env = os.environ.copy()
        env["CANGJIE_HOME"] = CJ
        env["CANGJIE_STDX_PATH"] = r"D:\software\cangjie\stdx-1.2.0\windows_x86_64_cjnative\static\stdx"
        prefix = ";".join([
            os.path.join(CJ, "runtime", "lib", "windows_x86_64_cjnative"),
            os.path.join(CJ, "lib", "windows_x86_64_cjnative"),
            os.path.join(CJ, "bin"),
            os.path.join(CJ, "tools", "bin"),
            os.path.join(CJ, "tools", "lib"),
            ANACONDA_LIB,
        ])
        env["PATH"] = prefix + ";" + env.get("PATH", "")
        env["SPIRE_HTTP_URL"] = "http://127.0.0.1:%d" % SPIRE_PORT
        env["AGENTS_UPSTREAM"] = "http://127.0.0.1:%d" % PY_PORT
        env["JAVA_UPSTREAM"] = "http://127.0.0.1:1"
        env["JWT_SECRET"] = sec
        env["PLATFORM_DB_URL"] = url
        env["SPIRE_FORWARD_TIMEOUT"] = "30"
        logf = open(os.path.join(HERE, "verify_sse_real.log"), "w", encoding="utf-8")
        proc = subprocess.Popen([EXE], env=env, stdout=logf, stderr=subprocess.STDOUT, cwd=ROOT)
        if not wait_port(SPIRE_PORT):
            print("Spire 未起")
            return 2

        st_sp, ct_sp, first_sp, chunks_sp = collect(SPIRE_PORT, path, token)
        mark("R2", "经 Spire 首帧 <1.5s（未缓冲）",
             st_sp == 200 and first_sp is not None and first_sp < 1.5,
             "status=%d ct=%s first=%s chunks=%d" %
             (st_sp, ct_sp, ("%.2fs" % first_sp) if first_sp else "none", len(chunks_sp)))
        mark("R3", "首帧内容与直连一致",
             bool(chunks_py) and bool(chunks_sp) and chunks_sp[0][1] == chunks_py[0][1],
             "direct=%r spire=%r" % (chunks_py[0][1][:40] if chunks_py else b"",
                                     chunks_sp[0][1][:40] if chunks_sp else b""))
        mark("R4", "4 秒内收到累计字节且与直连等价",
             sum(len(x[1]) for x in chunks_sp) >= sum(len(x[1]) for x in chunks_py),
             "direct_bytes=%d spire_bytes=%d" %
             (sum(len(x[1]) for x in chunks_py), sum(len(x[1]) for x in chunks_sp)))
        mark("R5", "Spire 未额外引入缓冲延迟（差值 <0.5s）",
             first_py is not None and first_sp is not None and abs(first_sp - first_py) < 0.5,
             "direct=%.2fs spire=%.2fs delta=%.2fs" %
             (first_py or -1, first_sp or -1,
              abs((first_sp or 0) - (first_py or 0))))
        mark("R6", "Content-Type 保真",
             (ct_sp or "").startswith("text/event-stream"), str(ct_sp))

    finally:
        try:
            if db:
                c = db.cursor()
                c.execute("DELETE FROM presentation_tasks WHERE id=UNHEX(%s)", (task.hex,))
                c.execute("DELETE FROM users WHERE id=UNHEX(%s)", (u.hex,))
                db.close()
        except Exception:                # noqa: BLE001
            pass
        if proc:
            try:
                proc.kill()
            except Exception:            # noqa: BLE001
                pass
        if logf:
            try:
                logf.close()
            except Exception:            # noqa: BLE001
                pass

    ok = sum(1 for x in RESULTS if x)
    print("\n=== real-upstream SSE: %d/%d ===" % (ok, len(RESULTS)))
    return 0 if ok == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
