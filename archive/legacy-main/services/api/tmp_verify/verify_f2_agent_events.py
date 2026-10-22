# -*- coding: utf-8 -*-
"""
F2 / P4-4 回归：Agent 事件过程日志三条路径必须正确转发到 agents-service。

断言：
  E1  GET  /v1/admin-generation-tasks/ppt/{id}/stream      → 逐段透传（首帧 <1.5s）
  E2  GET  /v1/admin-generation-events/ppt/{id}/summarize  → 缓冲转发，JSON 原样
  E3  POST /v1/admin-generation-events/ppt/{id}/backfill-summaries → 202 原样
  E4  Authorization 头透传到上游
  E5  以上路径不被 Spire 本地拦截（响应里带桩标记）

用法： D:\\anaconda\\python.exe tmp_verify/verify_f2_agent_events.py
"""

import http.client
import os
import socket
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXE = os.path.join(ROOT, "target", "release", "bin", "main.exe")
ENV_FILE = r"d:\project\ITN-full\src\agents\.env"

CJ = r"D:\software\cangjie\sdk-1.2.0\cangjie"
ANACONDA_LIB = r"D:\anaconda\Library\bin"

STUB_PORT = 18881
SPIRE_PORT = 18882
FRAME1 = b'id: 1\nevent: generation_event\ndata: {"seq":1}\n\n'
FRAME2 = b'event: generation_done\ndata: {"status":"completed"}\n\n'
AUTH_SEEN = {"value": None}
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


def chunk(data):
    return ("%x\r\n" % len(data)).encode("ascii") + data + b"\r\n"


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
            for line in lines[1:]:
                if line.lower().startswith(b"authorization:"):
                    AUTH_SEEN["value"] = line.split(b":", 1)[1].strip().decode()
            if method == "POST":
                clen = 0
                for line in lines[1:]:
                    if line.lower().startswith(b"content-length:"):
                        clen = int(line.split(b":", 1)[1].strip())
                while len(rest) < clen:
                    rest += c.recv(4096)

            if path.startswith("/v1/admin-generation-tasks/") and path.endswith("/stream"):
                c.sendall(b"HTTP/1.1 200 OK\r\n"
                          b"Content-Type: text/event-stream\r\n"
                          b"Cache-Control: no-cache\r\n"
                          b"X-Accel-Buffering: no\r\n"
                          b"Transfer-Encoding: chunked\r\n\r\n")
                c.sendall(chunk(FRAME1))
                time.sleep(2.0)
                c.sendall(chunk(FRAME2))
                c.sendall(b"0\r\n\r\n")
            elif "/summarize" in path:
                body = b'{"seq":1,"summary":"STUB-SUMMARIZE","source":"upstream"}'
                c.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
                          ("Content-Length: %d\r\n\r\n" % len(body)).encode() + body)
            elif "/backfill-summaries" in path:
                body = b'{"started":true,"alreadyRunning":false,"pending":3}'
                c.sendall(b"HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\n" +
                          ("Content-Length: %d\r\n\r\n" % len(body)).encode() + body)
            else:
                c.sendall(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
        except OSError:
            pass
        finally:
            try:
                c.close()
            except OSError:
                pass

    threading.Thread(target=loop, daemon=True).start()


def hget(hdrs, name):
    for k, v in hdrs.items():
        if k.lower() == name.lower():
            return v
    return ""


def req(port, method, path, body=None, headers=None, timeout=20):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    conn.request(method, path, body=body, headers=headers or {})
    r = conn.getresponse()
    data = r.read()
    hd = dict(r.getheaders())
    conn.close()
    return r.status, data, hd


def main():
    proc = None
    logf = None
    try:
        if not os.path.exists(EXE):
            print("main.exe 缺失：%s" % EXE)
            return 2
        secrets = load_env(ENV_FILE)
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
        env["SPIRE_FORWARD_TIMEOUT"] = "10"
        env["JWT_SECRET"] = secrets.get("JWT_SECRET", "")
        env["PLATFORM_DB_URL"] = secrets.get("PLATFORM_DB_URL", "")

        stub()
        if not wait_port(STUB_PORT, 3):
            print("桩未启动")
            return 2
        logf = open(os.path.join(HERE, "verify_f2_agent_events.log"), "w", encoding="utf-8")
        proc = subprocess.Popen([EXE], env=env, stdout=logf, stderr=subprocess.STDOUT, cwd=ROOT)
        if not wait_port(SPIRE_PORT):
            print("Spire 未起")
            return 2

        tok = "Bearer test-token-abc"
        # E1 SSE 逐段
        conn = http.client.HTTPConnection("127.0.0.1", SPIRE_PORT, timeout=20)
        t0 = time.time()
        conn.request("GET", "/v1/admin-generation-tasks/ppt/11111111-1111-1111-1111-111111111111/stream",
                     headers={"Authorization": tok})
        r = conn.getresponse()
        first_at = None
        buf = b""
        while True:
            b_ = r.read(1)
            if not b_:
                break
            if first_at is None:
                first_at = time.time() - t0
            buf += b_
        total = time.time() - t0
        hd = dict(r.getheaders())
        conn.close()
        mark("P4-4-1", "事件流状态 200", r.status == 200, "status=%d" % r.status)
        mark("P4-4-2", "SSE 逐段：首帧 <1.5s", first_at is not None and first_at < 1.5,
             "first=%.2fs" % (first_at if first_at is not None else -1))
        mark("P4-4-3", "两帧完整", buf == FRAME1 + FRAME2, "len=%d" % len(buf))
        mark("P4-4-4", "总耗时≈上游 2s", 1.8 <= total <= 5.0, "total=%.2fs" % total)
        mark("P4-4-5", "Content-Type 为 SSE",
             hget(hd, "Content-Type").startswith("text/event-stream"), hget(hd, "Content-Type"))

        # E2 summarize 缓冲
        st, body, _ = req(SPIRE_PORT, "GET",
                          "/v1/admin-generation-events/ppt/11111111-1111-1111-1111-111111111111/summarize?seq=1",
                          headers={"Authorization": tok})
        mark("P4-4-6", "summarize 转发原样",
             st == 200 and body == b'{"seq":1,"summary":"STUB-SUMMARIZE","source":"upstream"}',
             "status=%d body=%r" % (st, body))

        # E3 backfill 202
        st, body, _ = req(SPIRE_PORT, "POST",
                          "/v1/admin-generation-events/ppt/11111111-1111-1111-1111-111111111111/backfill-summaries",
                          body=b"{}", headers={"Authorization": tok, "Content-Type": "application/json"})
        mark("P4-4-7", "backfill-summaries 202 转发原样",
             st == 202 and b'"pending":3' in body, "status=%d body=%r" % (st, body))

        # E4 Authorization 透传
        mark("P4-4-8", "Authorization 头透传", AUTH_SEEN["value"] == tok,
             "seen=%r" % AUTH_SEEN["value"])

    finally:
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
    print("\n=== F2 P4-4 agent events: %d/%d ===" % (ok, len(RESULTS)))
    return 0 if ok == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
