# -*- coding: utf-8 -*-
"""
SSE 缓冲问题彻底性验证：枚举 Python/Java 全部流式端点，逐个经 Spire 网关打一遍。

判定标准：上游先发一帧、停 2 秒、再发一帧。
  - 首帧 < 1.5s  → 逐段透传（未被缓冲）
  - 首帧 ≈ 2s    → 被缓冲（缺陷）

用法： D:\\anaconda\\python.exe tmp_verify/verify_sse_all.py
"""

import http.client
import os
import socket
import subprocess
import sys
import threading
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXE = os.path.join(ROOT, "target", "release", "bin", "main.exe")
ENV_FILE = r"d:\project\ITN-full\src\agents\.env"
CJ = r"D:\software\cangjie\sdk-1.2.0\cangjie"
ANACONDA_LIB = r"D:\anaconda\Library\bin"

STUB_PORT = 18901
SPIRE_PORT = 18902
F1 = b"data: {\"seq\":1}\n\n"
F2 = b"data: {\"seq\":2}\n\n"
RESULTS = []

TID = str(uuid.uuid4())

CASES = [
    ("S01", "POST", "/v1/teaching-group/runs/stream"),
    ("S02", "POST", "/v1/presentations/%s/chat/stream" % TID),
    ("S03", "POST", "/v1/presentations/%s/chat/tts" % TID),
    ("S04", "POST", "/v1/assistant/tts"),
    ("S05", "POST", "/v1/presentations/%s/chat/audio-stream" % TID),
    ("S06", "POST", "/v1/presentations/%s/chat/image-stream" % TID),
    ("S07", "POST", "/v1/assistant/audio-stream"),
    ("S08", "POST", "/v1/assistant/plan-stream"),
    ("S09", "POST", "/v1/agent/ask/stream"),
    ("S10", "POST", "/v1/agent/ask/image-stream"),
    ("S11", "GET", "/v1/memory/profile-analysis"),
    ("S12", "GET", "/v1/admin-generation-tasks/ppt/%s/stream" % TID),
    ("S13", "POST", "/v1/agent-runs/stream"),
    ("S14", "POST", "/v1/chat/stream"),
    ("S15", "GET", "/v1/chat/sessions/%s/resume" % TID),
    ("S16", "POST", "/internal/v1/agent-runs/stream"),
    ("S17", "POST", "/internal/v1/chat/stream"),
    ("S18", "GET", "/v1/presentations/%s/audio/0" % TID),
    ("S19", "GET", "/api/v1/admin/predeal/progress/abcdef12"),
]

CONTROL = ("S20", "GET", "/v1/agent-runs/%s" % TID)


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
    return ("%x\r\n" % len(data)).encode() + data + b"\r\n"


def is_stream_path(path):
    p = path.lower()
    return ("stream" in p or "/tts" in p or "/audio/" in p
            or "/memory/profile-analysis" in p
            or ("/chat/sessions/" in p and "/resume" in p)
            or "/admin/predeal/progress/" in p)


def stub():
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", STUB_PORT))
    srv.listen(32)

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
            head = buf.split(b"\r\n\r\n", 1)[0]
            path = head.split(b" ")[1].decode("latin1")
            if is_stream_path(path):
                c.sendall(b"HTTP/1.1 200 OK\r\n"
                          b"Content-Type: text/event-stream\r\n"
                          b"Cache-Control: no-cache\r\n"
                          b"Transfer-Encoding: chunked\r\n\r\n")
                c.sendall(chunk(F1))
                time.sleep(2.0)
                c.sendall(chunk(F2))
                c.sendall(b"0\r\n\r\n")
            else:
                body = b'{"ok":true,"kind":"json"}'
                half = len(body) // 2
                c.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
                          ("Content-Length: %d\r\n\r\n" % len(body)).encode())
                c.sendall(body[:half])
                time.sleep(2.0)
                c.sendall(body[half:])
        except OSError:
            pass
        finally:
            try:
                c.close()
            except OSError:
                pass

    threading.Thread(target=loop, daemon=True).start()


def call(method, path):
    conn = http.client.HTTPConnection("127.0.0.1", SPIRE_PORT, timeout=20)
    t0 = time.time()
    conn.request(method, path, body=b"" if method == "POST" else None,
                 headers={"Content-Type": "application/json"})
    r = conn.getresponse()
    first = None
    buf = b""
    while True:
        b_ = r.read(1)
        if not b_:
            break
        if first is None:
            first = time.time() - t0
        buf += b_
    total = time.time() - t0
    conn.close()
    return r.status, buf, first, total


def main():
    proc = None
    logf = None
    try:
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
        env["JAVA_UPSTREAM"] = "http://127.0.0.1:%d" % STUB_PORT
        env["JWT_SECRET"] = secrets.get("JWT_SECRET", "")
        env["PLATFORM_DB_URL"] = secrets.get("PLATFORM_DB_URL", "")
        env["SPIRE_FORWARD_TIMEOUT"] = "10"

        stub()
        if not wait_port(STUB_PORT, 3):
            print("桩未启动")
            return 2
        logf = open(os.path.join(HERE, "verify_sse_all.log"), "w", encoding="utf-8")
        proc = subprocess.Popen([EXE], env=env, stdout=logf, stderr=subprocess.STDOUT, cwd=ROOT)
        if not wait_port(SPIRE_PORT):
            print("Spire 未起")
            return 2

        for rid, method, path in CASES:
            st, body, first, total = call(method, path)
            ok = (st == 200 and first is not None and first < 1.5
                  and body == F1 + F2)
            mark(rid, method + " " + path, ok,
                 "status=%d first=%.2fs total=%.2fs len=%d" %
                 (st, first if first is not None else -1, total, len(body)))

        rid, method, path = CONTROL
        st, body, first, total = call(method, path)
        ok = (st == 200 and body == b'{"ok":true,"kind":"json"}'
              and first is not None and first >= 1.9)
        mark(rid, "普通 JSON 仍缓冲（%s）" % path, ok,
             "status=%d first=%.2fs total=%.2fs" %
             (st, first if first is not None else -1, total))

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
    print("\n=== SSE coverage: %d/%d ===" % (ok, len(RESULTS)))
    return 0 if ok == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
