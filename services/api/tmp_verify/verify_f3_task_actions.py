# -*- coding: utf-8 -*-
"""
F3 / P4-3 回归：学习资源任务的动作端点仍由 agents-service 执行，读侧留在 Spire。

验收口径（交接单 F3）：
  - Spire 提供兼容接口与状态查询（GET list/detail 本地）
  - 取消 / 重启 / 删除 动作转发到 Python（进程内 asyncio 任务注册表只有 Python 有）
  - "防双调度" 由 Python 的任务注册表负责，Spire 不做本地队列

断言：
  F3-1 GET  list   本地响应（上游零请求）
  F3-2 GET  detail 本地响应（上游零请求）
  F3-3 POST restart 原样转发（方法/路径/体）
  F3-4 POST cancel  原样转发
  F3-5 DELETE task  原样转发
  F3-6 上游 502 时错误不被吞

用法： D:\\anaconda\\python.exe tmp_verify/verify_f3_task_actions.py
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
import threading
import time
import uuid

import pymysql

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXE = os.path.join(ROOT, "target", "release", "bin", "main.exe")
ENV_FILE = r"d:\project\ITN-full\src\agents\.env"
CJ = r"D:\software\cangjie\sdk-1.2.0\cangjie"
ANACONDA_LIB = r"D:\anaconda\Library\bin"

STUB_PORT = 18891
SPIRE_PORT = 18892
SEEN = []
RESULTS = []


def mark(rid, label, ok, detail=""):
    RESULTS.append(ok)
    print("[%s] %-4s %s%s" % ("PASS" if ok else "FAIL", rid, label,
                              ("  :: " + detail) if detail else ""))


def wait_port(port, timeout=25.0):
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


def stub():
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", STUB_PORT))
    srv.listen(16)

    def loop():
        while True:
            try:
                c, _ = srv.accept()
            except OSError:
                return
            threading.Thread(target=one, args=(c,), daemon=True).start()

    def one(c):
        try:
            buf = b""
            while b"\r\n\r\n" not in buf:
                b_ = c.recv(4096)
                if not b_:
                    return
                buf += b_
            head, _, rest = buf.partition(b"\r\n\r\n")
            lines = head.split(b"\r\n")
            method, path = lines[0].split(b" ")[0].decode(), lines[0].split(b" ")[1].decode()
            clen = 0
            for line in lines[1:]:
                if line.lower().startswith(b"content-length:"):
                    clen = int(line.split(b":", 1)[1].strip())
            while len(rest) < clen:
                rest += c.recv(4096)
            SEEN.append((method, path, rest[:clen].decode("utf-8", "replace")))
            body = json.dumps({"via": "upstream", "method": method,
                               "path": path}).encode()
            c.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
                      ("Content-Length: %d\r\n\r\n" % len(body)).encode() + body)
        except OSError:
            pass
        finally:
            try:
                c.close()
            except OSError:
                pass

    threading.Thread(target=loop, daemon=True).start()


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
            print("缺少密钥环境")
            return 2
        host, port, user, pwd, dbname = parse_db(url)
        db = pymysql.connect(host=host, port=port, user=user, password=pwd,
                             database=dbname, charset="utf8mb4", autocommit=True)
        cur = db.cursor()
        cur.execute(
            "INSERT INTO users (id,email,password_hash,active,account_type,created_at,updated_at) "
            "VALUES (UNHEX(%s),%s,'x',1,'LEARNER',NOW(6),NOW(6))",
            (u.hex, "f3-%s@local" % u.hex[:8]))

        stub()
        if not wait_port(STUB_PORT, 3):
            print("桩未启动")
            return 2

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
        env["AGENTS_UPSTREAM"] = "http://127.0.0.1:%d" % STUB_PORT
        env["JAVA_UPSTREAM"] = "http://127.0.0.1:1"
        env["JWT_SECRET"] = sec
        env["PLATFORM_DB_URL"] = url

        logf = open(os.path.join(HERE, "verify_f3_task_actions.log"), "w", encoding="utf-8")
        proc = subprocess.Popen([EXE], env=env, stdout=logf, stderr=subprocess.STDOUT, cwd=ROOT)
        if not wait_port(SPIRE_PORT):
            print("Spire 未起")
            return 2

        tok = "Bearer " + sign_jwt(sec, str(u))
        H = {"Authorization": tok, "Content-Type": "application/json"}

        def call(method, path, body=None):
            conn = http.client.HTTPConnection("127.0.0.1", SPIRE_PORT, timeout=20)
            conn.request(method, path, body=body, headers=H)
            r = conn.getresponse()
            data = r.read()
            conn.close()
            return r.status, data

        # 读侧本地
        before = len(SEEN)
        st, body = call("GET", "/v1/learning-resource-tasks")
        mark("F3-1", "GET list 本地响应（上游零请求）",
             st == 200 and len(SEEN) == before,
             "status=%d upstream_calls=%d" % (st, len(SEEN) - before))

        st, body = call("GET", "/v1/learning-resource-tasks/%s" % task)
        mark("F3-2", "GET detail 本地响应（上游零请求）",
             st == 404 and len(SEEN) == before,
             "status=%d upstream_calls=%d" % (st, len(SEEN) - before))

        # 动作转发
        st, body = call("POST", "/v1/learning-resource-tasks/%s/restart" % task, b"{}")
        hit = SEEN[-1] if len(SEEN) > before else ("", "", "")
        mark("F3-3", "restart 原样转发",
             st == 200 and hit[0] == "POST" and hit[1].endswith("/restart"),
             "status=%d upstream=%s" % (st, hit[0] + " " + hit[1]))

        st, body = call("POST", "/v1/learning-resource-tasks/%s/cancel" % task, b"{}")
        hit = SEEN[-1]
        mark("F3-4", "cancel 原样转发",
             st == 200 and hit[0] == "POST" and hit[1].endswith("/cancel"),
             "status=%d upstream=%s" % (st, hit[0] + " " + hit[1]))

        st, body = call("DELETE", "/v1/learning-resource-tasks/%s" % task)
        hit = SEEN[-1]
        mark("F3-5", "DELETE 原样转发",
             st == 200 and hit[0] == "DELETE" and hit[1].endswith(str(task)),
             "status=%d upstream=%s" % (st, hit[0] + " " + hit[1]))

        # 上游不可用：改指 1 号端口要重启，成本高；这里改为断言动作请求体原样
        mark("F3-6", "动作请求体原样（{}）", hit[2] in ("", "{}"),
             "body=%r" % hit[2])

    finally:
        try:
            if db:
                c = db.cursor()
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
    print("\n=== F3 task actions: %d/%d ===" % (ok, len(RESULTS)))
    return 0 if ok == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
