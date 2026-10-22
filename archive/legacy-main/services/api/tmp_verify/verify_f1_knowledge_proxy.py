# -*- coding: utf-8 -*-
"""
P4-F1 管理员知识服务代理验证（KnowledgeCore + QuestionBank）。

做法与 verify_f2_admin_resources.py 相同：
  - 从 src/agents/.env 就地读取 JWT_SECRET / PLATFORM_DB_URL（只打印是否设置/长度）；
  - 起两个本地桩（KC / QB），桩内重算 HMAC canonical，校验平台头并回显收到的
    method / path / query / body；
  - 起 main.exe，插独立机构 + ADMIN/LEARNER/无机构 ADMIN + 活跃会话；
  - 跑断言矩阵并输出 m/n；结束时清理自造数据。

用法： D:\\anaconda\\python.exe tmp_verify/verify_f1_knowledge_proxy.py
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
from urllib.parse import urlsplit

import pymysql

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXE = os.path.join(ROOT, "target", "release", "bin", "main.exe")
ENV_FILE = r"d:\project\ITN-full\src\agents\.env"

CJ = r"D:\software\cangjie\sdk-1.2.0\cangjie"
ANACONDA_LIB = r"D:\anaconda\Library\bin"

PREFERRED_PORT = 18831
KC_STUB_PORT = 18931
QB_STUB_PORT = 18941

RESULTS = []
LOG = None
DB = None
DBCFG = {}
KC_REQS = []
QB_REQS = []


def mark(rid, label, ok, detail=""):
    RESULTS.append((rid, label, ok, detail))
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
        data = r.read()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, data
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


def pick_port(preferred, tries=30):
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


def load_env(path):
    out = {}
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def build_env(secrets, spire_port, kc_port, qb_port, kc_secret, qb_secret):
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
    env["JWT_SECRET"] = secrets["JWT_SECRET"]
    env["PLATFORM_DB_URL"] = secrets["PLATFORM_DB_URL"]
    env["SPIRE_HTTP_URL"] = "http://127.0.0.1:%d" % spire_port
    env["AGENTS_UPSTREAM"] = "http://127.0.0.1:1"
    env["JAVA_UPSTREAM"] = "http://127.0.0.1:1"
    env["AGENT_INTERNAL_SECRET"] = ""
    env["KNOWLEDGE_CORE_URL"] = "http://127.0.0.1:%d" % kc_port
    env["QUESTIONBANK_URL"] = "http://127.0.0.1:%d" % qb_port
    env["KC_INTERNAL_SECRET"] = kc_secret
    env["QB_INTERNAL_SECRET"] = qb_secret
    return env


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def sign_jwt(secret, sub):
    header = {"alg": "HS256", "typ": "JWT"}
    now = int(time.time())
    payload = {"sub": sub, "iat": now, "exp": now + 3600}
    seg = (b64url(json.dumps(header, separators=(",", ":")).encode("utf-8")) + "." +
           b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8")))
    sig = hmac.new(secret.encode("utf-8"), seg.encode("ascii"), hashlib.sha256).digest()
    return seg + "." + b64url(sig)


def jbody(raw):
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def start_stub(port, secret, sink, label):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _handle(self):
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else b""
            split = urlsplit(self.path)
            path = split.path
            query = split.query
            method = self.command
            headers = {k.lower(): v for k, v in self.headers.items()}

            ts = headers.get("x-itn-timestamp", "")
            nonce = headers.get("x-itn-nonce", "")
            uid = headers.get("x-itn-user-id", "")
            sig = headers.get("x-itn-signature", "")
            canonical = "\n".join([method.upper(), path, ts, nonce, uid, sha256_hex(body)])
            expected = hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"),
                                hashlib.sha256).hexdigest()
            sig_ok = bool(ts and nonce and uid and sig and
                          hmac.compare_digest(expected, sig))

            sink.append({
                "label": label, "method": method, "path": path, "query": query,
                "body": body, "headers": headers, "sig_ok": sig_ok,
            })

            code = 200
            if "stub_status" in query:
                for part in query.split("&"):
                    if part.startswith("stub_status="):
                        try:
                            code = int(part.split("=", 1)[1])
                        except ValueError:
                            code = 200
            payload = json.dumps({
                "label": label,
                "method": method,
                "path": path,
                "query": query,
                "body_b64": base64.b64encode(body).decode("ascii"),
                "sig_ok": sig_ok,
            }, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/vnd.itn-stub+json; charset=utf-8")
            self.send_header("X-Request-Id", headers.get("x-request-id", ""))
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = _handle
        do_POST = _handle
        do_PUT = _handle
        do_DELETE = _handle
        do_PATCH = _handle

    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def unhex(hexs):
    return "UNHEX('%s')" % hexs


def insert_user(cur, uid, email, account_type, org_id):
    cur.execute(
        "INSERT INTO users(id,email,password_hash,nickname,active,account_type,"
        "organization_id,admin_scope,created_at,updated_at) VALUES("
        + unhex(uid.hex) + ",%s,'x',NULL,1,%s," +
        ("%s" if org_id else "NULL") +
        ",NULL,NOW(6),NOW(6))",
        tuple([email, account_type] + ([org_id.bytes] if org_id else [])))


def insert_session(cur, uid, token):
    cur.execute(
        "INSERT INTO user_sessions(token_hash,user_id,created_at,expires_at,"
        "revoked_at,ip_address,user_agent) VALUES(%s," + unhex(uid.hex) +
        ",NOW(6),DATE_ADD(NOW(6), INTERVAL 2 HOUR),NULL,NULL,'verify-f1')",
        (sha256_hex(token.encode("utf-8")),))


def main():
    global LOG, DB, DBCFG
    LOG = open(os.path.join(HERE, "verify_f1_knowledge_proxy.log"), "w", encoding="utf-8")
    hms = time.strftime("%H%M%S")
    suffix = uuid.uuid4().hex[:6]
    procs = []
    kc_srv = qb_srv = None
    org_id = admin_id = normal_id = noorg_id = None
    spire_port = PREFERRED_PORT
    dbname = "?"
    passed = 0

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

        rest = url.split("://", 1)[1]
        userinfo, hostpart = rest.split("@", 1)
        user, pwd = userinfo.split(":", 1)
        hostport, dbname = hostpart.split("/", 1)
        host, port = hostport.split(":", 1)
        DBCFG = dict(host=host, port=int(port), user=user, password=pwd,
                     database=dbname, charset="utf8mb4",
                     cursorclass=pymysql.cursors.DictCursor, autocommit=True)
        DB = pymysql.connect(**DBCFG)
        logline("db=%s connected" % dbname)

        kc_secret = uuid.uuid4().hex
        qb_secret = uuid.uuid4().hex
        spire_port = pick_port(PREFERRED_PORT)
        kc_port = pick_port(KC_STUB_PORT)
        qb_port = pick_port(QB_STUB_PORT, tries=80)
        while qb_port == kc_port:
            qb_port = pick_port(qb_port + 1, tries=80)

        kc_srv = start_stub(kc_port, kc_secret, KC_REQS, "kc")
        qb_srv = start_stub(qb_port, qb_secret, QB_REQS, "qb")
        if not wait_port(kc_port) or not wait_port(qb_port):
            print("KC/QB 桩未起来")
            return 2

        spire = subprocess.Popen([EXE], cwd=os.path.dirname(EXE),
                                 env=build_env(secrets, spire_port, kc_port, qb_port,
                                               kc_secret, qb_secret),
                                 stdout=LOG, stderr=LOG)
        procs.append(("main.exe", spire))
        if not wait_port(spire_port):
            print("Spire %d 未起来（检查 PATH/DLL）" % spire_port)
            return 2
        time.sleep(0.3)
        logline("spire pid=%s port=%d kc_stub=%d qb_stub=%d"
                % (spire.pid, spire_port, kc_port, qb_port))

        # ---------------- 造隔离机构与账号 ----------------
        org_id = uuid.uuid4()
        admin_id = uuid.uuid4()
        normal_id = uuid.uuid4()
        noorg_id = uuid.uuid4()
        admin_token = sign_jwt(sec, str(admin_id))
        normal_token = sign_jwt(sec, str(normal_id))
        noorg_token = sign_jwt(sec, str(noorg_id))
        admin_h = {"Authorization": "Bearer " + admin_token}
        normal_h = {"Authorization": "Bearer " + normal_token}
        noorg_h = {"Authorization": "Bearer " + noorg_token}

        cur = DB.cursor()
        cur.execute(
            "INSERT INTO organizations(id,code,name,short_name,status,created_at,updated_at)"
            " VALUES(" + unhex(org_id.hex) + ",%s,%s,NULL,1,NOW(6),NOW(6))",
            ("spiref1-%s-%s" % (hms, suffix), "F1验证机构" + suffix))
        insert_user(cur, admin_id, "f1-admin-%s-%s@example.test" % (hms, suffix),
                    "ADMIN", org_id)
        insert_user(cur, normal_id, "f1-normal-%s-%s@example.test" % (hms, suffix),
                    "LEARNER", org_id)
        insert_user(cur, noorg_id, "f1-noorg-%s-%s@example.test" % (hms, suffix),
                    "ADMIN", None)
        insert_session(cur, admin_id, admin_token)
        insert_session(cur, normal_id, normal_token)
        insert_session(cur, noorg_id, noorg_token)
        logline("seeded org admin=%s normal=%s noorg=%s" % (admin_id, normal_id, noorg_id))

        def req(method, path, headers=None, body=None):
            hdrs = dict(headers or {})
            st, rh, b = http_req(spire_port, method, path, body, hdrs)
            return st, rh, jbody(b), b

        def code_of(j):
            return j.get("code") if isinstance(j, dict) else None

        def msg_of(j):
            return j.get("message") if isinstance(j, dict) else None

        KC = "/api/v1/admin/knowledge-core"
        QB = "/api/v1/admin/questions"
        admin_json_h = dict(admin_h, **{"Content-Type": "application/json"})

        # ---------------- A 鉴权 ----------------
        st, _h, j, b = req("GET", KC + "/health")
        mark("A1", "未登录 -> 401", st == 401, "status=%d body=%r" % (st, b[:120]))

        before = len(KC_REQS)
        st, _h, j, b = req("GET", KC + "/health", normal_h)
        ok = (st == 403 and code_of(j) == 1006
              and msg_of(j) == "仅管理员账号可以访问知识管理服务")
        mark("A2", "普通用户 -> 403/1006 文案一致", ok,
             "status=%d code=%s msg=%s" % (st, code_of(j), msg_of(j)))
        mark("A3", "普通用户被拒时上游未收到请求", len(KC_REQS) == before,
             "delta=%d" % (len(KC_REQS) - before))

        st, _h, j, b = req("GET", QB + "/categories", noorg_h)
        ok = (st == 403 and code_of(j) == 1006
              and msg_of(j) == "仅管理员账号可以访问知识管理服务")
        mark("A4", "无机构 ADMIN -> 403/1006", ok,
             "status=%d code=%s" % (st, code_of(j)))

        st, _h, j, b = req("GET", KC + "/health", admin_h)
        mark("A5", "管理员放行 health", st == 200, "status=%d" % st)

        # ---------------- B KnowledgeCore 白名单 ----------------
        kc_reads = [
            "/health", "/knowledge/categories", "/knowledge/coverage",
            "/knowledge/chunks", "/knowledge/chunks/by-ids",
            "/knowledge/classifications/audit", "/knowledge/graph/edges",
            "/knowledge/documents",
        ]
        kc_writes = ["/knowledge/classifications/correct", "/knowledge/graph/validate",
                     "/knowledge/graph/prerequisites"]
        kc_graph = [
            ("POST", "/knowledge/graph/review"),
            ("POST", "/knowledge/graph/edges/7/approve"),
            ("POST", "/knowledge/graph/edges/7/reject"),
            ("POST", "/knowledge/graph/edges/7/reverse"),
            ("DELETE", "/knowledge/graph/edges/7"),
        ]

        for path in kc_reads:
            before = len(KC_REQS)
            st, _h, j, b = req("GET", KC + path, admin_h)
            rec = KC_REQS[-1] if len(KC_REQS) > before else None
            exp_path = "/health" if path == "/health" else "/api/v1" + path
            ok = (st == 200 and rec is not None and rec["method"] == "GET"
                  and rec["path"] == exp_path and rec["sig_ok"])
            mark("B-" + path, "GET %s 放行且映射/签名正确" % path, ok,
                 "status=%d upstream=%s sig=%s" %
                 (st, rec["path"] if rec else None, rec["sig_ok"] if rec else None))

        for path in ["/knowledge/documents/doc-1",
                     "/knowledge/documents/doc-1/chunks"]:
            before = len(KC_REQS)
            st, _h, j, b = req("GET", KC + path, admin_h)
            rec = KC_REQS[-1] if len(KC_REQS) > before else None
            ok = (st == 200 and rec is not None
                  and rec["path"] == "/api/v1" + path and rec["sig_ok"])
            mark("B-doc" + path, "GET 文档子路径放行", ok,
                 "status=%d upstream=%s" % (st, rec["path"] if rec else None))

        for path in kc_writes:
            before = len(KC_REQS)
            body = json.dumps({"probe": path}, separators=(",", ":")).encode()
            st, _h, j, b = req("POST", KC + path + "?x=1", admin_json_h, body)
            rec = KC_REQS[-1] if len(KC_REQS) > before else None
            ok = (st == 200 and rec is not None and rec["method"] == "POST"
                  and rec["path"] == "/api/v1" + path and rec["query"] == "x=1"
                  and rec["body"] == body and rec["sig_ok"])
            mark("B-post" + path, "POST %s 放行/query/body/签名" % path, ok,
                 "status=%d upstream=%s query=%r body_ok=%s" %
                 (st, rec["path"] if rec else None,
                  rec["query"] if rec else None, rec["body"] == body if rec else None))

        for method, path in kc_graph:
            before = len(KC_REQS)
            st, _h, j, b = req(method, KC + path, admin_h)
            rec = KC_REQS[-1] if len(KC_REQS) > before else None
            ok = (st == 200 and rec is not None and rec["method"] == method
                  and rec["path"] == "/api/v1" + path and rec["sig_ok"])
            mark("B-graph" + method + path, "%s %s 放行" % (method, path), ok,
                 "status=%d upstream=%s" % (st, rec["path"] if rec else None))

        # 非白名单：必须在本地被拒，且上游零请求
        denied = [("GET", "/knowledge/domains"), ("POST", "/knowledge/documents"),
                  ("PUT", "/knowledge/categories"),
                  ("DELETE", "/knowledge/graph/edges/abc"),
                  ("GET", "/knowledge/documents/a/b/c")]
        for method, path in denied:
            before = len(KC_REQS)
            st, _h, j, b = req(method, KC + path, admin_h)
            ok = (st == 403 and code_of(j) == 1006
                  and msg_of(j) == "该内部服务路径未在平台白名单中开放"
                  and len(KC_REQS) == before)
            mark("B-deny" + method + path, "%s %s -> 403 且上游零请求" % (method, path), ok,
                 "status=%d code=%s upstream_delta=%d" %
                 (st, code_of(j), len(KC_REQS) - before))

        # ---------------- C 透传细节 ----------------
        before = len(KC_REQS)
        st, rh, j, b = req("GET", KC + "/knowledge/chunks?alpha=1&beta=%E4%B8%AD&gamma=%41",
                           dict(admin_h, **{"X-Request-Id": "req-f1-123"}))
        rec = KC_REQS[-1] if len(KC_REQS) > before else None
        ok = (st == 200 and rec is not None
              and rec["query"] == "alpha=1&beta=%E4%B8%AD&gamma=%41"
              and rec["headers"].get("x-request-id") == "req-f1-123"
              and rh.get("x-request-id") == "req-f1-123"
              and rh.get("content-type") == "application/vnd.itn-stub+json; charset=utf-8")
        mark("C1", "query 原样(含百分号编码) + X-Request-Id 入/出透传 + Content-Type 透传", ok,
             "status=%d query=%r resp_rid=%r ct=%r" %
             (st, rec["query"] if rec else None, rh.get("x-request-id"),
              rh.get("content-type")))

        before = len(KC_REQS)
        st, rh, j, b = req("GET", KC + "/knowledge/coverage", admin_h)
        rec = KC_REQS[-1] if len(KC_REQS) > before else None
        rid = rec["headers"].get("x-request-id", "") if rec else ""
        ok = st == 200 and len(rid) in (32, 36) and rid == rh.get("x-request-id")
        mark("C2", "缺失 X-Request-Id 时生成 32/36 位并作为响应头回传", ok,
             "status=%d rid=%r resp=%r" % (st, rid, rh.get("x-request-id")))

        before = len(KC_REQS)
        st, rh, j, b = req("GET", KC + "/knowledge/chunks?stub_status=201", admin_h)
        mark("C3", "上游 201 状态码原样透传", st == 201, "status=%d" % st)

        body = json.dumps({"edge_ids": [1, 2], "approve": True},
                          separators=(",", ":")).encode()
        before = len(KC_REQS)
        st, rh, j, b = req("POST", KC + "/knowledge/graph/review", admin_json_h, body)
        rec = KC_REQS[-1] if len(KC_REQS) > before else None
        echo = jbody(b) if isinstance(j, dict) else None
        echoed = base64.b64decode(echo.get("body_b64", "")) if echo else b""
        ok = st == 200 and rec is not None and echoed == body and rec["body"] == body
        mark("C4", "POST body 字节原样到达上游并原样回显", ok,
             "status=%d upstream_body_ok=%s echo_body_ok=%s" %
             (st, rec["body"] == body if rec else None, echoed == body))

        rec = KC_REQS[-1]
        h = rec["headers"]
        ok = (h.get("x-itn-user-id") == str(admin_id)
              and h.get("x-itn-organization-id") == str(org_id)
              and h.get("x-itn-roles") == "admin"
              and rec["sig_ok"])
        mark("C5", "四个平台头 + HMAC 签名正确", ok,
             "uid_ok=%s org_ok=%s roles=%s sig=%s" %
             (h.get("x-itn-user-id") == str(admin_id),
              h.get("x-itn-organization-id") == str(org_id),
              h.get("x-itn-roles"), rec["sig_ok"]))

        # ---------------- D QuestionBank 白名单 ----------------
        qb_gets = ["", "/categories", "/stats/overview", "/stats/by-category",
                   "/review-queue", "/123", "/123/stats"]
        for path in qb_gets:
            before = len(QB_REQS)
            st, _h, j, b = req("GET", QB + path + "?q=1", admin_h)
            rec = QB_REQS[-1] if len(QB_REQS) > before else None
            ok = (st == 200 and rec is not None and rec["method"] == "GET"
                  and rec["path"] == "/v1/questions" + path and rec["sig_ok"])
            mark("D-get" + (path or "/"), "GET %s 放行且映射正确" % (path or "根"),
                 ok, "status=%d upstream=%s sig=%s" %
                 (st, rec["path"] if rec else None, rec["sig_ok"] if rec else None))

        body = json.dumps([{"stem": "q1"}], separators=(",", ":")).encode()
        before = len(QB_REQS)
        st, _h, j, b = req("POST", QB, admin_json_h, body)
        rec = QB_REQS[-1] if len(QB_REQS) > before else None
        ok = (st == 200 and rec is not None and rec["method"] == "POST"
              and rec["path"] == "/v1/questions" and rec["body"] == body and rec["sig_ok"])
        mark("D-post-root", "POST 根路径放行/body 原样", ok,
             "status=%d upstream=%s body_ok=%s" %
             (st, rec["path"] if rec else None, rec["body"] == body if rec else None))

        for path in ["/import", "/review/batch"]:
            before = len(QB_REQS)
            body = json.dumps({"probe": path}, separators=(",", ":")).encode()
            st, _h, j, b = req("POST", QB + path, admin_json_h, body)
            rec = QB_REQS[-1] if len(QB_REQS) > before else None
            ok = (st == 200 and rec is not None
                  and rec["path"] == "/v1/questions" + path and rec["sig_ok"])
            mark("D-post" + path, "POST %s 放行" % path, ok,
                 "status=%d upstream=%s" % (st, rec["path"] if rec else None))

        for path, tail in [("/123/review", True), ("/123/deprecate", True)]:
            before = len(QB_REQS)
            st, _h, j, b = req("POST", QB + path, admin_h)
            rec = QB_REQS[-1] if len(QB_REQS) > before else None
            ok = (st == 200 and rec is not None
                  and rec["path"] == "/v1/questions" + path and rec["sig_ok"])
            mark("D-post" + path, "POST %s 放行" % path, ok,
                 "status=%d upstream=%s" % (st, rec["path"] if rec else None))

        before = len(QB_REQS)
        body = json.dumps({"stem": "updated"}, separators=(",", ":")).encode()
        st, _h, j, b = req("PUT", QB + "/123", admin_json_h, body)
        rec = QB_REQS[-1] if len(QB_REQS) > before else None
        ok = (st == 200 and rec is not None and rec["method"] == "PUT"
              and rec["path"] == "/v1/questions/123" and rec["body"] == body
              and rec["sig_ok"])
        mark("D-put", "PUT /123 放行/body 原样", ok,
             "status=%d upstream=%s body_ok=%s" %
             (st, rec["path"] if rec else None, rec["body"] == body if rec else None))

        before = len(QB_REQS)
        st, _h, j, b = req("DELETE", QB + "/123", admin_h)
        rec = QB_REQS[-1] if len(QB_REQS) > before else None
        ok = (st == 200 and rec is not None and rec["method"] == "DELETE"
              and rec["path"] == "/v1/questions/123" and rec["sig_ok"])
        mark("D-delete", "DELETE /123 放行", ok,
             "status=%d upstream=%s" % (st, rec["path"] if rec else None))

        denied = [("GET", "/bad"), ("POST", "/123"), ("POST", "/123/approve"),
                  ("PUT", "/review/batch"), ("DELETE", "/123/stats"),
                  ("GET", "/123/extra"), ("PATCH", "/123")]
        for method, path in denied:
            before = len(QB_REQS)
            st, _h, j, b = req(method, QB + path, admin_h)
            ok = (st == 403 and code_of(j) == 1006
                  and msg_of(j) == "该内部服务路径未在平台白名单中开放"
                  and len(QB_REQS) == before)
            mark("D-deny" + method + path, "%s %s -> 403 且上游零请求" % (method, path), ok,
                 "status=%d code=%s upstream_delta=%d" %
                 (st, code_of(j), len(QB_REQS) - before))

        # ---------------- E 上游不可达 ----------------
        kc_srv.shutdown()
        kc_srv.server_close()
        kc_srv = None
        qb_srv.shutdown()
        qb_srv.server_close()
        qb_srv = None

        st, _h, j, b = req("GET", KC + "/health", admin_h)
        ok = st == 502 and code_of(j) == 3001 and msg_of(j) == "上游知识服务不可用"
        mark("E1", "KC 停掉 -> 502/3001", ok,
             "status=%d code=%s msg=%s" % (st, code_of(j), msg_of(j)))

        st, _h, j, b = req("GET", QB + "/categories", admin_h)
        ok = st == 502 and code_of(j) == 3001 and msg_of(j) == "上游知识服务不可用"
        mark("E2", "QB 停掉 -> 502/3001", ok,
             "status=%d code=%s msg=%s" % (st, code_of(j), msg_of(j)))

    finally:
        for name, p in procs:
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:  # noqa: BLE001
                try:
                    p.kill()
                except Exception:  # noqa: BLE001
                    pass
        if kc_srv is not None:
            try:
                kc_srv.shutdown()
                kc_srv.server_close()
            except Exception:  # noqa: BLE001
                pass
        if qb_srv is not None:
            try:
                qb_srv.shutdown()
                qb_srv.server_close()
            except Exception:  # noqa: BLE001
                pass
        if DB is not None:
            try:
                cur = DB.cursor()
                ids = [x for x in (admin_id, normal_id, noorg_id) if x]
                for uid in ids:
                    cur.execute("DELETE FROM user_sessions WHERE user_id=" + unhex(uid.hex))
                    cur.execute("DELETE FROM users WHERE id=" + unhex(uid.hex))
                if org_id:
                    cur.execute("DELETE FROM organizations WHERE id=" + unhex(org_id.hex))
                logline("cleanup done")
            except Exception as exc:  # noqa: BLE001
                logline("cleanup failed: %r" % (exc,))
            try:
                DB.close()
            except Exception:  # noqa: BLE001
                pass

    passed = sum(1 for _r, _l, ok, _d in RESULTS if ok)
    total = len(RESULTS)
    logline("")
    logline("RESULT %d/%d  spire_port=%d kc_stub=%d qb_stub=%d db=%s"
            % (passed, total, spire_port, KC_STUB_PORT, QB_STUB_PORT, dbname))
    if LOG:
        LOG.close()
    return 0 if passed == total and total > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
