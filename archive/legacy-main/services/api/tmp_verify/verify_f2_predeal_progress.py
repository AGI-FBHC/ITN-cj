# -*- coding: utf-8 -*-
"""
F2 / P4-5 回归：/api/v1/admin/predeal/progress/{taskId} 必须逐段透传（SSE），
不能被网关缓冲到上游结束。

做法：起一个原始 socket 上游，按 chunked 先发一帧、停 3 秒、再发一帧。
若 Spire 逐段透传，客户端在 1.5 秒内就能读到第一帧；若被缓冲，要等约 3 秒。

同时回归：普通 /api/v1 JSON 仍然完整缓冲（status/body/Content-Type 不变）。

用法： D:\\anaconda\\python.exe tmp_verify/verify_f2_predeal_progress.py
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

STUB_PORT = 18871
SPIRE_PORT = 18872
MARK1 = b"data: {\"stage\":\"intake\"}\n\n"
MARK2 = b"data: {\"stage\":\"done\"}\n\n"

RESULTS = []


def mark(rid, label, ok, detail=""):
    RESULTS.append((rid, ok))
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


def stub_server():
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", STUB_PORT))
    srv.listen(8)

    def serve():
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
            path = buf.split(b" ")[1].decode("latin1")
            if "/admin/predeal/progress/" in path:
                c.sendall(b"HTTP/1.1 200 OK\r\n"
                          b"Content-Type: text/event-stream\r\n"
                          b"Cache-Control: no-cache\r\n"
                          b"Transfer-Encoding: chunked\r\n\r\n")
                c.sendall(chunk(MARK1))
                time.sleep(3.0)
                c.sendall(chunk(MARK2))
                c.sendall(b"0\r\n\r\n")
            else:
                body = b'{"ok":true,"path":"plain"}'
                c.sendall(b"HTTP/1.1 200 OK\r\n"
                          b"Content-Type: application/json; charset=utf-8\r\n" +
                          ("Content-Length: %d\r\n\r\n" % len(body)).encode("ascii") + body)
        except OSError:
            pass
        finally:
            try:
                c.close()
            except OSError:
                pass

    threading.Thread(target=serve, daemon=True).start()
    return srv


def hget(hdrs, name):
    for k, v in hdrs.items():
        if k.lower() == name.lower():
            return v
    return ""


def read_sse(port, path):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    t0 = time.time()
    conn.request("GET", path)
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
    conn.close()
    return r.status, buf, first_at, total, dict(r.getheaders())


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
        env["JAVA_UPSTREAM"] = "http://127.0.0.1:%d" % STUB_PORT
        env["AGENTS_UPSTREAM"] = "http://127.0.0.1:1"
        env["SPIRE_FORWARD_TIMEOUT"] = "10"
        env["JWT_SECRET"] = secrets.get("JWT_SECRET", "")
        env["PLATFORM_DB_URL"] = secrets.get("PLATFORM_DB_URL", "")

        stub_server()
        if not wait_port(STUB_PORT, 3):
            print("桩未启动")
            return 2

        logf = open(os.path.join(HERE, "verify_f2_predeal_progress.log"), "w",
                    encoding="utf-8")
        proc = subprocess.Popen([EXE], env=env, stdout=logf, stderr=subprocess.STDOUT,
                                cwd=ROOT)
        if not wait_port(SPIRE_PORT):
            print("Spire 未起（看 verify_f2_predeal_progress.log）")
            return 2

        st, body, first_at, total, hdrs = read_sse(
            SPIRE_PORT, "/api/v1/admin/predeal/progress/abcdef12")
        mark("F2-1", "SSE 状态 200", st == 200, "status=%d" % st)
        mark("F2-2", "Content-Type 保真",
             hget(hdrs, "Content-Type").startswith("text/event-stream"),
             hget(hdrs, "Content-Type"))
        mark("F2-3", "首帧在 1.5s 内到达（未被缓冲）",
             first_at is not None and first_at < 1.5,
             "first=%.2fs" % (first_at if first_at is not None else -1))
        mark("F2-4", "两帧内容完整且顺序正确", body == MARK1 + MARK2,
             "len=%d" % len(body))
        mark("F2-5", "总耗时约等于上游 3s（说明第二帧也是到达即发）",
             2.5 <= total <= 6.0, "total=%.2fs" % total)

        # 普通 JSON 仍走缓冲
        conn = http.client.HTTPConnection("127.0.0.1", SPIRE_PORT, timeout=10)
        conn.request("GET", "/api/v1/plain")
        r = conn.getresponse()
        jb = r.read()
        conn.close()
        mark("F2-6", "普通 /api/v1 JSON 缓冲正常",
             r.status == 200 and jb == b'{"ok":true,"path":"plain"}',
             "status=%d body=%r" % (r.status, jb))

    finally:
        if proc:
            try:
                proc.kill()
            except Exception:            # noqa: BLE001
                pass
        try:
            logf.close()
        except Exception:                # noqa: BLE001
            pass

    ok = sum(1 for _, o in RESULTS if o)
    print("\n=== F2 P4-5 progress: %d/%d ===" % (ok, len(RESULTS)))
    return 0 if ok == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
