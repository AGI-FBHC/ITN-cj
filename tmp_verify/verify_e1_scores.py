# -*- coding: utf-8 -*-
"""
E1 隔离矩阵实测：PUT /v1/learners/scores 本地化（只读验证：脚本自身不改 src/）。

断言要点：
  - 合法请求 200 {"ok":true}，且 scores_json 落库形状与 Python json.dumps 一致
  - pydantic dict[str,int] 宽松强转：bool->1、整数值字符串->int
  - 非法值 422 且 loc 精确到 ["body","scores","<key>"]
  - scores 缺失/非对象、body 非对象/空/坏 JSON 的 422 形状
  - scores={} 与「无 learner」共用同一条 404 文案
  - 归属隔离：B 改不到 A 的行
  - 本地化证据：该路径不得落到上游桩（MARKER 不出现）

天气：Spire 端口 18821，agents 桩 18921。
密钥：JWT_SECRET / PLATFORM_DB_URL 运行时从 src/agents/.env 就地解析，不打印、不落盘。

用法： D:\\anaconda\\python.exe tmp_verify/verify_e1_scores.py
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pymysql

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXE = os.path.join(ROOT, "target", "release", "bin", "main.exe")
ENV_FILE = r"d:\project\ITN-full\src\agents\.env"

CJ = r"D:\software\cangjie\sdk-1.2.0\cangjie"
ANACONDA_LIB = r"D:\anaconda\Library\bin"

PREFERRED_PORT = 18821
STUB_PREFERRED = 18921
MARKER = "SPIREVERIFYE1-UPSTREAM-HIT"

RESULTS = []
LOG = None
STUB_HITS = []


def mark(rid, label, ok, detail=""):
    RESULTS.append((rid, label, "PASS" if ok else "FAIL", detail))
    line = "[%s] %-5s %s%s" % ("PASS" if ok else "FAIL", rid, label,
                               ("  :: " + detail) if detail else "")
    print(line)
    if LOG:
        LOG.write(line + "\n")
        LOG.flush()


def logline(text):
    print(text)
    if LOG:
        LOG.write(text + "\n")
        LOG.flush()


def http_req(port, method, path, body=None, headers=None, timeout=30):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        r = conn.getresponse()
        return r.status, dict(r.getheaders()), r.read()
    finally:
        conn.close()


def wait_port(port, timeout=25.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.15)
    return False


def pick_port(preferred, tries=20):
    p = preferred
    for _ in range(tries):
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", p))
            s.close()
            return p
        except OSError:
            s.close()
            p += 1
    return p


def start_stub(port):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _send(self, code, body):
            b = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def _hit(self):
            STUB_HITS.append(self.command + " " + self.path)
            return MARKER + ":" + self.command + ":" + self.path

        def do_GET(self):
            self._send(200, self._hit())

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            self.rfile.read(n)
            self._send(200, self._hit())

        def do_PUT(self):
            n = int(self.headers.get("Content-Length") or 0)
            self.rfile.read(n)
            self._send(200, self._hit())

    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


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
    seg = (b64url(json.dumps(header, separators=(",", ":")).encode("utf-8")) + "." +
           b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8")))
    sig = hmac.new(secret.encode("utf-8"), seg.encode("ascii"), hashlib.sha256).digest()
    return seg + "." + b64url(sig)


def build_env(secrets, spire_port, stub_port):
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
    env["SPIRE_HTTP_URL"] = "http://127.0.0.1:%d" % spire_port
    env["SPIRE_AGENTS_URL"] = "http://127.0.0.1:%d" % stub_port
    env["SPIRE_SPRING_URL"] = "http://127.0.0.1:1"
    # 合入同事主干后，网关读的是他的配置键
    env["AGENTS_UPSTREAM"] = "http://127.0.0.1:%d" % stub_port
    env["JAVA_UPSTREAM"] = "http://127.0.0.1:1"
    env["SPIRE_FORWARD_TIMEOUT"] = "10"
    env["JWT_SECRET"] = secrets["JWT_SECRET"]
    env["PLATFORM_DB_URL"] = secrets["PLATFORM_DB_URL"]
    return env


def jbody(raw):
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:                    # noqa: BLE001
        return None


def main():
    global LOG
    LOG = open(os.path.join(HERE, "verify_e1_scores.log"), "w", encoding="utf-8")
    hms = time.strftime("%H%M%S")
    srv = None
    proc = None
    db = None
    dbname = "?"
    user_ids = []

    try:
        if not os.path.exists(EXE):
            print("main.exe 缺失：%s" % EXE)
            return 2

        secrets = load_env(ENV_FILE)
        sec = secrets.get("JWT_SECRET", "")
        url = secrets.get("PLATFORM_DB_URL", "")
        logline("env JWT_SECRET set=%s len=%d" % (bool(sec), len(sec)))
        logline("env PLATFORM_DB_URL set=%s len=%d" % (bool(url), len(url)))
        if not sec or not url:
            print("缺少 JWT_SECRET 或 PLATFORM_DB_URL")
            return 2

        host, port, user, pwd, dbname = parse_db(url)
        db = pymysql.connect(host=host, port=port, user=user, password=pwd,
                             database=dbname, charset="utf8mb4",
                             cursorclass=pymysql.cursors.DictCursor, autocommit=True)
        logline("db=%s connected (autocommit=True)" % dbname)

        tag = "e1" + hms
        u_a = uuid.uuid4()
        u_b = uuid.uuid4()
        u_none = uuid.uuid4()
        lid_a = uuid.uuid4()
        lid_b = uuid.uuid4()
        user_ids = [u_a.bytes, u_b.bytes, u_none.bytes]

        cur = db.cursor()
        for u in (u_a, u_b, u_none):
            cur.execute(
                "INSERT INTO users (id, email, password_hash, active, account_type, "
                "created_at, updated_at) VALUES (%s,%s,%s,1,'LEARNER',NOW(6),NOW(6))",
                (u.bytes, "%s-%s@e1.local" % (tag, u.hex[:8]), "x"))
        for uid, lid, sc in ((u_a.bytes, lid_a.bytes, '{"kp-old": 33}'),
                             (u_b.bytes, lid_b.bytes, '{"kp-old": 44}')):
            cur.execute(
                "INSERT INTO learners (id, user_id, code, name, scores_json, status, "
                "created_at, updated_at) VALUES (%s,%s,%s,%s,%s,1,NOW(6),NOW(6))",
                (lid, uid, tag, "E1 " + tag, sc))
        logline("seeded users A/B/none + learners: A=%s B=%s" % (lid_a, lid_b))

        spire_port = pick_port(PREFERRED_PORT)
        stub_port = pick_port(STUB_PREFERRED)
        srv = start_stub(stub_port)
        if not wait_port(stub_port):
            print("桩未起")
            return 2

        env = build_env(secrets, spire_port, stub_port)
        logf = open(os.path.join(HERE, "verify_e1_spire.log"), "w", encoding="utf-8")
        proc = subprocess.Popen([EXE], env=env, stdout=logf, stderr=subprocess.STDOUT,
                                cwd=ROOT)
        if not wait_port(spire_port):
            print("Spire 未起（看 verify_e1_spire.log）")
            return 2
        logline("spire=%d stub=%d TAG=%s" % (spire_port, stub_port, tag))

        def hdr(u):
            return {"Authorization": "Bearer " + sign_jwt(sec, str(u)),
                    "Content-Type": "application/json"}

        def put_scores(token_u, obj_bytes, raw=None):
            body = raw if raw is not None else json.dumps(obj_bytes, ensure_ascii=False)
            return http_req(spire_port, "PUT", "/v1/learners/scores",
                            body=body.encode("utf-8"), headers=hdr(token_u))

        def stored(uid):
            c = db.cursor()
            c.execute("SELECT scores_json FROM learners WHERE user_id=%s", (uid,))
            r = c.fetchone()
            return None if r is None else r["scores_json"]

        # ---- E1-1 合法：200 ok:true + 落库形状 ----
        st, _, raw = put_scores(u_a, {"scores": {"kp-ds": 50}})
        body = jbody(raw)
        ok = st == 200 and body == {"ok": True}
        store = stored(u_a.bytes)
        mark("E1-1", "PUT scores {kp-ds:50} -> 200 {ok:true}",
             ok and store == '{"kp-ds": 50}',
             "st=%s body=%s store=%r" % (st, body, store))

        # ---- E1-2 clamp 0..100 ----
        st, _, raw = put_scores(u_a, {"scores": {"kp-ds": 250, "kp-co": -5}})
        store = stored(u_a.bytes)
        mark("E1-2", "clamp 0..100（250->100, -5->0）",
             st == 200 and store == '{"kp-ds": 100, "kp-co": 0}',
             "st=%s store=%r" % (st, store))

        # ---- E1-3 key 顺序保持 ----
        put_scores(u_a, {"scores": {"b": 1, "a": 2}})
        store = stored(u_a.bytes)
        mark("E1-3", "json.dumps 顺序与分隔符（\"b\" 在前）",
             store == '{"b": 1, "a": 2}', "store=%r" % (store,))

        # ---- E1-4 bool -> 1、整数值字符串 -> int ----
        st, _, raw = put_scores(u_a, {"scores": {"kp-true": True, "kp-str": "60"}})
        store = stored(u_a.bytes)
        mark("E1-4", "宽松强转 true->1, \"60\"->60",
             st == 200 and store == '{"kp-true": 1, "kp-str": 60}',
             "st=%s store=%r" % (st, store))

        # ---- E1-5 scores 缺失 -> 422 missing loc [body,scores] ----
        st, _, raw = put_scores(u_a, {})
        body = jbody(raw)
        d0 = (body or {}).get("details") or [{}]
        mark("E1-5", "缺失 scores -> 422 missing @ [body,scores]",
             st == 422 and body and body.get("code") == "VALIDATION_FAILED"
             and d0[0].get("type") == "missing"
             and d0[0].get("loc") == ["body", "scores"],
             "st=%s body=%s" % (st, body))

        # ---- E1-6 scores 非对象 -> 422 dict_type ----
        st, _, raw = put_scores(u_a, {"scores": [1, 2]})
        body = jbody(raw)
        d0 = (body or {}).get("details") or [{}]
        mark("E1-6", "scores 为数组 -> 422 dict_type @ [body,scores]",
             st == 422 and d0[0].get("type") == "dict_type"
             and d0[0].get("loc") == ["body", "scores"],
             "st=%s body=%s" % (st, body))

        # ---- E1-7 非法值各自报错，loc 到 key ----
        st, _, raw = put_scores(u_a, {"scores": {"kp-bad": "abc"}})
        body = jbody(raw)
        d0 = (body or {}).get("details") or [{}]
        mark("E1-7", "\"abc\" -> 422 int_parsing @ [body,scores,kp-bad]",
             st == 422 and d0[0].get("type") == "int_parsing"
             and d0[0].get("loc") == ["body", "scores", "kp-bad"],
             "st=%s body=%s" % (st, body))

        st, _, raw = put_scores(u_a, {"scores": {"kp-f": 50.5}})
        body = jbody(raw)
        d0 = (body or {}).get("details") or [{}]
        mark("E1-8", "50.5 -> 422 int_from_float @ [body,scores,kp-f]",
             st == 422 and d0[0].get("type") == "int_from_float"
             and d0[0].get("loc") == ["body", "scores", "kp-f"],
             "st=%s body=%s" % (st, body))

        # ---- E1-9 一个对象里多个坏值 -> details 多条 ----
        st, _, raw = put_scores(u_a, {"scores": {"kp-1": "x", "kp-2": None}})
        body = jbody(raw)
        det = (body or {}).get("details") or []
        locs = sorted([tuple(d.get("loc", [])) for d in det])
        mark("E1-9", "同一对象多个坏值 -> details >= 2 且 loc 各自到 key",
             st == 422 and len(det) >= 2
             and ("body", "scores", "kp-1") in locs,
             "st=%s details=%s" % (st, det))

        # ---- E1-10 body 空 / 坏 JSON / 非对象 ----
        st, _, raw = http_req(spire_port, "PUT", "/v1/learners/scores",
                              body=b"", headers=hdr(u_a))
        b1 = jbody(raw)
        st2, _, raw2 = http_req(spire_port, "PUT", "/v1/learners/scores",
                                body=b"{not json", headers=hdr(u_a))
        b2 = jbody(raw2)
        st3, _, raw3 = http_req(spire_port, "PUT", "/v1/learners/scores",
                                body=b"[1,2]", headers=hdr(u_a))
        b3 = jbody(raw3)
        mark("E1-10", "空 body->422 missing @[body]；坏 JSON->422 json_invalid；数组->422 model_attributes_type",
             st == 422 and (b1 or {}).get("details", [{}])[0].get("loc") == ["body"]
             and st2 == 422 and (b2 or {}).get("details", [{}])[0].get("type") == "json_invalid"
             and st3 == 422 and (b3 or {}).get("details", [{}])[0].get("type") == "model_attributes_type",
             "empty=%s/%s bad=%s/%s arr=%s/%s" % (st, b1, st2, b2, st3, b3))

        # ---- E1-11 scores={} -> 404 ----
        st, _, raw = put_scores(u_a, {"scores": {}})
        body = jbody(raw)
        mark("E1-11", "scores={} -> 404 Learner not found or no valid scores",
             st == 404 and body == {"detail": "Learner not found or no valid scores"},
             "st=%s body=%s" % (st, body))

        # ---- E1-12 无 learner 用户 -> 同一条 404 ----
        st, _, raw = put_scores(u_none, {"scores": {"kp-ds": 10}})
        body = jbody(raw)
        mark("E1-12", "无 learner 用户 -> 404 同一文案",
             st == 404 and body == {"detail": "Learner not found or no valid scores"},
             "st=%s body=%s" % (st, body))

        # ---- E1-13 归属隔离：B 改 B，A 不动 ----
        store_a_before = stored(u_a.bytes)
        st, _, raw = put_scores(u_b, {"scores": {"kp-b": 77}})
        store_b = stored(u_b.bytes)
        store_a_after = stored(u_a.bytes)
        mark("E1-13", "B 写只影响 B 的行（A 行不变）",
             st == 200 and store_b == '{"kp-b": 77}' and store_a_after == store_a_before,
             "st=%s B=%r A %r -> %r" % (st, store_b, store_a_before, store_a_after))

        # ---- E1-14 本地化证据：不落上游桩 ----
        before = len(STUB_HITS)
        put_scores(u_a, {"scores": {"kp-ds": 1}})
        mark("E1-14", "该路径未落到上游桩（本地化生效）",
             len(STUB_HITS) == before,
             "stub hits delta=%d" % (len(STUB_HITS) - before))

        # ---- E1-15 无鉴权 -> 401 ----
        st, _, raw = http_req(spire_port, "PUT", "/v1/learners/scores",
                              body=b'{"scores":{"a":1}}',
                              headers={"Content-Type": "application/json"})
        mark("E1-15", "无 token -> 401", st == 401, "st=%s body=%s" % (st, jbody(raw)))

        # ---- E1-16 冒烟：catch-all 仍把未注册的 /v1 路径转发到上游桩 ----
        before = len(STUB_HITS)
        st, _, raw = http_req(spire_port, "GET", "/v1/no-such-e1-route",
                              headers=hdr(u_a))
        mark("E1-16", "冒烟：catch-all 仍转发未注册 /v1 路径",
             len(STUB_HITS) > before and MARKER.encode() in raw,
             "st=%s stub delta=%d" % (st, len(STUB_HITS) - before))

        # ---- E1-17 冒烟：既有本地路由（C-a GET /v1/memories）仍本地响应 ----
        st, _, raw = http_req(spire_port, "GET", "/v1/memories", headers=hdr(u_a))
        mark("E1-17", "冒烟：C-a GET /v1/memories 仍本地（无 MARKER）",
             st == 200 and MARKER.encode() not in raw,
             "st=%s body=%s" % (st, raw[:120]))

    finally:
        if proc:
            try:
                proc.kill()
            except Exception:            # noqa: BLE001
                pass
        if srv:
            try:
                srv.shutdown()
            except Exception:            # noqa: BLE001
                pass
        if db:
            try:
                c = db.cursor()
                for uid in user_ids:
                    c.execute("DELETE FROM learners WHERE user_id=%s", (uid,))
                for uid in user_ids:
                    c.execute("DELETE FROM users WHERE id=%s", (uid,))
            except Exception:            # noqa: BLE001
                pass
            try:
                db.close()
            except Exception:            # noqa: BLE001
                pass
        if LOG:
            LOG.close()
        try:
            logf.close()
        except Exception:                # noqa: BLE001
            pass

    ok = sum(1 for r in RESULTS if r[2] == "PASS")
    print("\n=== E1 %d/%d  TAG=%s db=%s spire=%s ===" % (ok, len(RESULTS), hms,
                                                         dbname, PREFERRED_PORT))
    return 0 if ok == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
