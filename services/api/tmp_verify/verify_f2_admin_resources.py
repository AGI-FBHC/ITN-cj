# -*- coding: utf-8 -*-
"""
P4-2 管理员资源中心隔离验证（12 个端点）。

做法与 verify_c_a.py 相同：
  - 从 src/agents/.env 就地读取 JWT_SECRET / PLATFORM_DB_URL（只打印是否设置/长度）；
  - 起一个本地 agents 桩（校验 X-ITN-Signature，并模拟内部彻底删除）；
  - 起 main.exe，独立机构 + ADMIN/LEARNER/无机构账号 + 隔离数据；
  - 跑断言并输出 m/n；结束时清掉自己造的数据。

用法： D:\\anaconda\\python.exe tmp_verify/verify_f2_admin_resources.py
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
from urllib.parse import quote, urlsplit

import pymysql

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXE = os.path.join(ROOT, "target", "release", "bin", "main.exe")
ENV_FILE = r"d:\project\ITN-full\src\agents\.env"

CJ = r"D:\software\cangjie\sdk-1.2.0\cangjie"
ANACONDA_LIB = r"D:\anaconda\Library\bin"

PREFERRED_PORT = 18821
STUB_PREFERRED = 18921

RESULTS = []
LOG = None
DB = None
DBCFG = {}
SIGNATURES = []
GROUP_CALLS = []


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
        return r.status, dict(r.getheaders()), data
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


def build_env(secrets, spire_port, stub_port, internal_secret):
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
    env["AGENTS_UPSTREAM"] = "http://127.0.0.1:%d" % stub_port
    env["JAVA_UPSTREAM"] = "http://127.0.0.1:1"
    env["AGENT_INTERNAL_SECRET"] = internal_secret
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


def start_stub(port, internal_secret):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _send(self, code, body=b""):
            self.send_response(code)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)

        def do_DELETE(self):
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else b""
            split = urlsplit(self.path)
            path = split.path
            ts = self.headers.get("X-ITN-Timestamp", "")
            nonce = self.headers.get("X-ITN-Nonce", "")
            uid = self.headers.get("X-ITN-User-Id", "")
            sig = self.headers.get("X-ITN-Signature", "")
            canonical = "\n".join(["DELETE", path, ts, nonce, uid, sha256_hex(body)])
            expected = hmac.new(internal_secret.encode("utf-8"),
                                canonical.encode("utf-8"), hashlib.sha256).hexdigest()
            ok = bool(ts and nonce and uid and hmac.compare_digest(expected, sig))
            SIGNATURES.append((path, ok))
            if path.startswith("/internal/v1/admin/presentations/"):
                task = path.rsplit("/", 1)[-1]
                conn = None
                try:
                    # 独立连接：Spire 批量清理时持有事件表锁，这里快速失败即可
                    # （Spire 会忽略 agents 失败并继续删 DB 行，与 Java 一致）。
                    conn = pymysql.connect(**DBCFG)
                    with conn.cursor() as cur:
                        cur.execute("SET SESSION innodb_lock_wait_timeout=2")
                        cur.execute("DELETE FROM presentation_tasks"
                                    " WHERE id=UNHEX(REPLACE(%s,'-',''))", (task,))
                    conn.commit()
                    self._send(204)
                except Exception as exc:  # noqa: BLE001
                    logline("stub presentation delete failed: %r" % (exc,))
                    self._send(500, b"error")
                finally:
                    if conn is not None:
                        try:
                            conn.close()
                        except Exception:  # noqa: BLE001
                            pass
                return
            GROUP_CALLS.append(self.path)
            self._send(200, b"{}")

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
        ",NOW(6),DATE_ADD(NOW(6), INTERVAL 2 HOUR),NULL,NULL,'verify-f2')",
        (sha256_hex(token.encode("utf-8")),))


def insert_resource(cur, rid, uid, org_id, domain, node, group, rtype, title, topic,
                    review, archived=False, is_template=0):
    cur.execute(
        "INSERT INTO generated_learning_resources"
        "(id,user_id,organization_id,domain_code,category_node_code,resource_scope,"
        "review_status,revision,archived_at,archive_reason,resource_type,title,topic,"
        "content_json,sources_json,state_json,context_json,decision_json,created_at,"
        "updated_at,is_public,is_template,resource_group) VALUES("
        + unhex(rid.hex) + "," + unhex(uid.hex) + ",%s,%s,%s,'ORGANIZATION',%s,1,"
        + ("NOW(6)" if archived else "NULL") +
        ",%s,%s,%s,%s,'{\"body\":\"c\"}','[]',JSON_OBJECT(),JSON_OBJECT(),JSON_OBJECT(),"
        "NOW(6),NOW(6),0,%s,%s)",
        (org_id.bytes, domain, node, review,
         "测试归档" if archived else None, rtype, title, topic, is_template, group))


def insert_presentation(cur, pid, uid, org_id, domain, node, group, title, topic,
                        review, archived=False, is_template=0):
    request_json = json.dumps({
        "generationContext": {
            "topicName": topic,
            "current": {"topicName": topic},
            "groupName": group,
            "kpId": "kp-f2",
        },
        "requirement": topic,
    }, ensure_ascii=False, separators=(",", ":"))
    cur.execute(
        "INSERT INTO presentation_tasks"
        "(id,user_id,organization_id,domain_code,category_node_code,resource_scope,"
        "review_status,revision,archived_at,archive_reason,title,status,progress,"
        "stage_message,request_json,outline_json,events_json,learned_json,created_at,"
        "updated_at,is_public,is_template,resource_group) VALUES("
        + unhex(pid.hex) + "," + unhex(uid.hex) + ",%s,%s,%s,'ORGANIZATION',%s,1,"
        + ("NOW(6)" if archived else "NULL") +
        ",%s,%s,'completed',100,'done',%s,'{}','[]',JSON_OBJECT(),NOW(6),NOW(6),0,%s,%s)",
        (org_id.bytes, domain, node, review,
         "测试归档" if archived else None, title, request_json, is_template, group))


def db_one(cur, sql, args=()):
    cur.execute(sql, args)
    return cur.fetchone()


def main():
    global LOG, DB, DBCFG
    procs = []
    LOG = open(os.path.join(HERE, "verify_f2_admin_resources.log"), "w", encoding="utf-8")
    hms = time.strftime("%H%M%S")
    suffix = uuid.uuid4().hex[:6]
    stub = None
    org_id = None
    admin_id = normal_id = noorg_id = None
    org_code = "spiref2-%s-%s" % (hms, suffix)
    spire_port = PREFERRED_PORT
    dbname = "?"

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

        internal_secret = uuid.uuid4().hex
        spire_port = pick_port(PREFERRED_PORT)
        stub_port = pick_port(STUB_PREFERRED)
        stub = start_stub(stub_port, internal_secret)
        if not wait_port(stub_port):
            print("agents 桩 %d 未起来" % stub_port)
            return 2

        spire = subprocess.Popen([EXE], cwd=os.path.dirname(EXE),
                                 env=build_env(secrets, spire_port, stub_port,
                                               internal_secret),
                                 stdout=LOG, stderr=LOG)
        procs.append(("main.exe", spire))
        if not wait_port(spire_port):
            print("Spire %d 未起来（检查 PATH/DLL）" % spire_port)
            return 2
        time.sleep(0.3)
        logline("spire pid=%s port=%d stub=%d" % (spire.pid, spire_port, stub_port))

        # ---------------- 造隔离机构与账号 ----------------
        org_id = uuid.uuid4()
        admin_id = uuid.uuid4()
        normal_id = uuid.uuid4()
        noorg_id = uuid.uuid4()
        admin_token = sign_jwt(sec, str(admin_id))
        normal_token = sign_jwt(sec, str(normal_id))
        noorg_token = sign_jwt(sec, str(noorg_id))
        admin_h = {"Authorization": "Bearer " + admin_token,
                   "Content-Type": "application/json"}
        normal_h = {"Authorization": "Bearer " + normal_token,
                    "Content-Type": "application/json"}
        noorg_h = {"Authorization": "Bearer " + noorg_token,
                   "Content-Type": "application/json"}

        cur = DB.cursor()
        cur.execute(
            "INSERT INTO organizations(id,code,name,short_name,status,created_at,updated_at)"
            " VALUES(" + unhex(org_id.hex) + ",%s,%s,NULL,1,NOW(6),NOW(6))",
            (org_code, "F2验证机构" + suffix))
        insert_user(cur, admin_id, "f2-admin-%s-%s@example.test" % (hms, suffix),
                    "ADMIN", org_id)
        insert_user(cur, normal_id, "f2-normal-%s-%s@example.test" % (hms, suffix),
                    "LEARNER", org_id)
        insert_user(cur, noorg_id, "f2-noorg-%s-%s@example.test" % (hms, suffix),
                    "LEARNER", None)
        insert_session(cur, admin_id, admin_token)
        insert_session(cur, normal_id, normal_token)
        insert_session(cur, noorg_id, noorg_token)

        R = {}
        for key in ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "rdel",
                    "rcand"]:
            R[key] = uuid.uuid4()
        P = {}
        for key in ["p1", "p2", "p3", "p4", "p5", "p6", "parch", "pdel"]:
            P[key] = uuid.uuid4()

        insert_resource(cur, R["r1"], admin_id, org_id, "dom-a", "node-1", "分组A",
                        "lecture", "F2资源A1", "topicA1", "DRAFT")
        insert_resource(cur, R["r2"], admin_id, org_id, "dom-a", "node-1", "分组A",
                        "practice", "F2资源A2", "topicA2", "PENDING")
        insert_resource(cur, R["r3"], admin_id, org_id, "dom-a", "node-1", "分组A",
                        "quiz", "F2资源A3", "topicA3", "APPROVED")
        insert_resource(cur, R["r4"], admin_id, org_id, "dom-a", "node-1", "分组B",
                        "lecture", "F2资源B1", "topicB1", "PUBLISHED")
        insert_resource(cur, R["r5"], admin_id, org_id, "dom-a", "node-2", "分组R",
                        "lecture", "F2资源R1", "topicR1", "DRAFT", archived=True)
        insert_resource(cur, R["r6"], admin_id, org_id, "dom-a", "node-1", "分组C",
                        "lecture", "F2资源C1", "topicC1", "DRAFT")
        insert_resource(cur, R["r7"], admin_id, org_id, None, None, "默认分组",
                        "lecture", "F2未绑定", "topicU", "DRAFT")
        insert_resource(cur, R["r8"], admin_id, org_id, "dom-a", "node-1", "分组D",
                        "lecture", "F2归档D", "topicD", "DRAFT", archived=True)
        insert_resource(cur, R["r9"], admin_id, org_id, "dom-a", "node-1", "分组G",
                        "practice", "F2拒绝资源", "topicG", "PENDING")
        insert_resource(cur, R["rdel"], admin_id, org_id, "dom-a", "node-1", "分组Z",
                        "lecture", "F2删除资源", "topicZ", "DRAFT", archived=True)
        insert_resource(cur, R["rcand"], admin_id, org_id, "dom-a", "node-1", "分组Y",
                        "lecture", "F2候选源资源", "topicY", "DRAFT", archived=True)

        insert_presentation(cur, P["p1"], admin_id, org_id, "dom-a", "node-1", "分组A",
                            "F2课件A", "topicP1", "DRAFT")
        insert_presentation(cur, P["p2"], admin_id, org_id, "dom-a", "node-1", "分组E",
                            "F2课件E", "topicP2", "PENDING")
        insert_presentation(cur, P["p3"], admin_id, org_id, "dom-a", "node-1", "分组B",
                            "F2课件B", "topicP3", "APPROVED")
        insert_presentation(cur, P["p4"], admin_id, org_id, "dom-a", "node-2", "分组R",
                            "F2归档课件R", "topicP4", "DRAFT", archived=True)
        insert_presentation(cur, P["p5"], admin_id, org_id, "dom-a", "node-1", "分组C",
                            "F2课件C", "topicP5", "DRAFT")
        insert_presentation(cur, P["p6"], admin_id, org_id, "dom-a", "node-1", "分组D",
                            "F2归档课件D", "topicP6", "DRAFT", archived=True)
        insert_presentation(cur, P["parch"], admin_id, org_id, "dom-a", "node-1", "分组F",
                            "F2待归档课件", "topicP7", "DRAFT")
        insert_presentation(cur, P["pdel"], admin_id, org_id, "dom-a", "node-1", "分组Z",
                            "F2删除课件", "topicP8", "DRAFT", archived=True)
        logline("seeded org=%s admin=%s normal=%s noorg=%s"
                % (org_code, admin_id, normal_id, noorg_id))

        def req(method, path, headers=None, body=None):
            st, _h, b = http_req(spire_port, method, path, body, headers)
            return st, jbody(b), b

        def code_of(j):
            return j.get("code") if isinstance(j, dict) else None

        def msg_of(j):
            return j.get("message") if isinstance(j, dict) else None

        # ---------------- A 鉴权 ----------------
        st, j, b = req("GET", "/api/v1/admin/resources/stats")
        mark("A1", "未登录 GET stats -> 401",
             st == 401 and isinstance(j, dict) and j.get("detail") == "Bearer token required",
             "status=%d body=%r" % (st, b[:120]))

        st, j, b = req("GET", "/api/v1/admin/resources/stats", normal_h)
        ok = (st == 403 and code_of(j) == 1006 and msg_of(j) == "仅机构管理员可以执行此操作"
              and "data" not in j and "timestamp" in j)
        mark("A2", "普通用户 GET stats -> 403/1006 文案一致", ok,
             "status=%d code=%s msg=%s body=%r" % (st, code_of(j), msg_of(j), b[:160]))

        st, j, b = req("GET", "/api/v1/admin/resources", normal_h)
        mark("A3", "普通用户 GET list -> 403/1006", st == 403 and code_of(j) == 1006,
             "status=%d code=%s" % (st, code_of(j)))

        st, j, b = req("GET", "/api/v1/admin/resources/stats", noorg_h)
        mark("A4", "无机构 LEARNER GET stats -> 403/1006", st == 403 and code_of(j) == 1006,
             "status=%d code=%s" % (st, code_of(j)))

        # ---------------- B stats ----------------
        st, j, b = req("GET", "/api/v1/admin/resources/stats", admin_h)
        data = j.get("data") if isinstance(j, dict) else None
        expect = {"library": 12, "pending": 3, "published": 1, "recycle": 7}
        ok = (st == 200 and code_of(j) == 0 and isinstance(data, dict)
              and set(data.keys()) == set(expect.keys()) and data == expect)
        mark("B1", "stats 四键与隔离机构计数", ok,
             "status=%d data=%s expect=%s" % (st, data, expect))

        # ---------------- C list ----------------
        RES_KEYS = ["id", "type", "title", "topic", "scope", "reviewStatus", "revision",
                    "domainCode", "nodeCode", "template", "groupName", "baseResourceId",
                    "learnerId", "kpId", "createdAt", "updatedAt", "archivedAt",
                    "archiveReason", "ownerAccount"]
        PPT_KEYS = ["id", "type", "status", "title", "topic", "scope", "reviewStatus",
                    "revision", "domainCode", "nodeCode", "template", "groupName",
                    "baseResourceId", "learnerId", "kpId", "createdAt", "updatedAt",
                    "archivedAt", "archiveReason", "ownerAccount"]

        st, j, b = req("GET", "/api/v1/admin/resources?view=library", admin_h)
        d = j.get("data") if isinstance(j, dict) else None
        items = d.get("items") if isinstance(d, dict) else None
        ok = (st == 200 and code_of(j) == 0 and isinstance(items, list) and len(items) == 7
              and d.get("total") == 7 and all(list(it.keys()) == RES_KEYS for it in items)
              and all(it["archivedAt"] is None for it in items))
        mark("C1", "list library total=7 且 items 键顺序逐字一致", ok,
             "status=%d total=%s n=%s first=%s" % (
                 st, d.get("total") if isinstance(d, dict) else None,
                 len(items) if isinstance(items, list) else None,
                 list(items[0].keys()) if items else None))

        for view, rid in [("archive", R["r5"]), ("recycle", R["r8"])]:
            st, j, b = req("GET", "/api/v1/admin/resources?view=%s" % view, admin_h)
            d = j.get("data") if isinstance(j, dict) else None
            items = d.get("items") if isinstance(d, dict) else []
            ok = (st == 200 and d.get("total") == len(items) == 4
                  and all(it["archivedAt"] is not None for it in items)
                  and rid.hex in [it["id"].replace("-", "") for it in items])
            mark("C2-%s" % view, "list %s 只含归档 4 条" % view, ok,
                 "status=%d total=%s n=%s" % (st, d.get("total") if isinstance(d, dict) else None,
                                              len(items)))

        st, j, b = req("GET", "/api/v1/admin/resources?view=nope", admin_h)
        mark("C3", "非法 view -> 400/1000 资源视图无效",
             st == 400 and code_of(j) == 1000 and msg_of(j) == "资源视图无效",
             "status=%d code=%s msg=%s" % (st, code_of(j), msg_of(j)))

        st, j, b = req("GET", "/api/v1/admin/resources?view=library&type=ppt", admin_h)
        d = j.get("data") if isinstance(j, dict) else None
        items = d.get("items") if isinstance(d, dict) else []
        ok = (st == 200 and len(items) == 5 and d.get("total") == 5
              and all(list(it.keys()) == PPT_KEYS for it in items)
              and all(it["type"] == "ppt" for it in items))
        mark("C4", "type=ppt -> presentation 分支 total=5 键顺序一致", ok,
             "status=%d total=%s n=%s keys=%s" % (
                 st, d.get("total") if isinstance(d, dict) else None, len(items),
                 list(items[0].keys()) if items else None))

        st, j, b = req("GET", "/api/v1/admin/resources?view=library&domainCode=dom-a"
                       "&nodeCode=node-1&keyword=" + quote("F2资源A") + "&type=lecture",
                       admin_h)
        d = j.get("data") if isinstance(j, dict) else None
        items = d.get("items") if isinstance(d, dict) else []
        ok = st == 200 and len(items) == 1 and items[0]["title"] == "F2资源A1"
        mark("C5", "domain/node/keyword/type 过滤", ok,
             "status=%d n=%s titles=%s" % (st, len(items), [i.get("title") for i in items]))

        # ---------------- D detail ----------------
        DET_KEYS = ["id", "type", "title", "topic", "scope", "reviewStatus", "revision",
                    "domainCode", "nodeCode", "template", "kpId", "groupName", "content",
                    "sources", "decision", "createdAt", "updatedAt", "archivedAt",
                    "archiveReason"]
        PPT_DET_KEYS = ["id", "type", "title", "topic", "scope", "reviewStatus", "revision",
                        "domainCode", "nodeCode", "template", "kpId", "content", "sources",
                        "decision", "createdAt", "updatedAt", "archivedAt", "archiveReason"]
        st, j, b = req("GET", "/api/v1/admin/resources/%s" % R["r1"], admin_h)
        d = j.get("data") if isinstance(j, dict) else None
        ok = (st == 200 and code_of(j) == 0 and isinstance(d, dict)
              and list(d.keys()) == DET_KEYS and d.get("title") == "F2资源A1"
              and d.get("content") == {"body": "c"})
        mark("D1", "detail 资源键顺序/内容", ok,
             "status=%d keys=%s" % (st, list(d.keys()) if isinstance(d, dict) else None))

        st, j, b = req("GET", "/api/v1/admin/resources/%s" % P["p1"], admin_h)
        d = j.get("data") if isinstance(j, dict) else None
        ok = (st == 200 and isinstance(d, dict) and d.get("type") == "ppt"
              and list(d.keys()) == PPT_DET_KEYS and d.get("title") == "F2课件A")
        mark("D2", "detail 课件回退", ok,
             "status=%d type=%s keys=%s" % (st, d.get("type") if isinstance(d, dict) else None,
                                            list(d.keys()) if isinstance(d, dict) else None))

        st, j, b = req("GET", "/api/v1/admin/resources/%s" % uuid.uuid4(), admin_h)
        mark("D3", "detail 不存在 -> 404/4001 文案",
             st == 404 and code_of(j) == 4001 and msg_of(j) == "资源不存在或不属于当前机构",
             "status=%d code=%s msg=%s" % (st, code_of(j), msg_of(j)))

        # ---------------- E restore ----------------
        st, j, b = req("POST", "/api/v1/admin/resources/%s/restore" % R["r5"], admin_h)
        row = db_one(cur, "SELECT HEX(user_id) u, learner_id, archived_at, resource_scope,"
                          " review_status FROM generated_learning_resources WHERE id="
                          + unhex(R["r5"].hex))
        ev = db_one(cur, "SELECT action,from_status,to_status FROM learning_resource_review_events"
                         " WHERE resource_id=" + unhex(R["r5"].hex) + " AND action='RESTORE'")
        ok = (st == 200 and code_of(j) == 0 and "data" not in j
              and msg_of(j) == "资源已恢复到机构资源库草稿"
              and row and row["u"] == admin_id.hex.upper() and row["learner_id"] is None
              and row["archived_at"] is None and row["resource_scope"] == "ORGANIZATION"
              and row["review_status"] == "DRAFT" and ev and ev["to_status"] == "DRAFT")
        mark("E1", "restore 归档资源 + 事件/DB 断言", ok,
             "status=%d code=%s msg=%s row=%s ev=%s"
             % (st, code_of(j), msg_of(j), row, ev))

        st, j, b = req("POST", "/api/v1/admin/resources/%s/restore" % R["r5"], admin_h)
        mark("E2", "restore 非归档 -> 404/4001", st == 404 and code_of(j) == 4001,
             "status=%d code=%s" % (st, code_of(j)))

        # ---------------- F candidate ----------------
        st, j, b = req("POST", "/api/v1/admin/resources/%s/candidate" % R["rcand"], admin_h)
        d = j.get("data") if isinstance(j, dict) else None
        new_id = d.get("id") if isinstance(d, dict) else None
        row = None
        if new_id:
            row = db_one(cur, "SELECT HEX(base_resource_id) b, revision, review_status,"
                              " resource_scope, archived_at, title FROM generated_learning_resources"
                              " WHERE id=UNHEX(REPLACE(%s,'-',''))", (new_id,))
        ok = (st == 200 and code_of(j) == 0 and msg_of(j) == "已复制为通用资源草稿"
              and new_id and row and row["b"] == R["rcand"].hex.upper()
              and row["revision"] == 1 and row["review_status"] == "DRAFT"
              and row["resource_scope"] == "ORGANIZATION" and row["archived_at"] is None
              and row["title"] == "F2候选源资源")
        mark("F1", "candidate 资源复制（base/revision/标题）", ok,
             "status=%d msg=%s new=%s row=%s" % (st, msg_of(j), new_id, row))

        st, j, b = req("POST", "/api/v1/admin/resources/%s/candidate" % R["r1"], admin_h)
        mark("F2", "candidate 非归档 -> 404/4001", st == 404 and code_of(j) == 4001,
             "status=%d code=%s" % (st, code_of(j)))

        st, j, b = req("POST", "/api/v1/admin/resources/%s/candidate" % P["p4"], admin_h)
        d = j.get("data") if isinstance(j, dict) else None
        pid_new = d.get("id") if isinstance(d, dict) else None
        prow = None
        if pid_new:
            prow = db_one(cur, "SELECT HEX(base_presentation_id) b, revision, review_status,"
                               " resource_scope, archived_at FROM presentation_tasks"
                               " WHERE id=UNHEX(REPLACE(%s,'-',''))", (pid_new,))
        ok = (st == 200 and pid_new and prow and prow["b"] == P["p4"].hex.upper()
              and prow["revision"] == 1 and prow["review_status"] == "DRAFT"
              and prow["archived_at"] is None)
        mark("F3", "candidate presentation 回退分支", ok,
             "status=%d new=%s row=%s" % (st, pid_new, prow))

        # ---------------- G review 状态机 ----------------
        def review(rid, action):
            return req("POST", "/api/v1/admin/resources/%s/review" % rid, admin_h,
                       json.dumps({"action": action, "comment": "verify " + action}).encode())

        st, j, b = review(R["r1"], "submit")
        row = db_one(cur, "SELECT review_status FROM generated_learning_resources WHERE id="
                          + unhex(R["r1"].hex))
        ev = db_one(cur, "SELECT action,from_status,to_status FROM learning_resource_review_events"
                         " WHERE resource_id=" + unhex(R["r1"].hex) + " AND action='SUBMIT'")
        mark("G1", "review submit DRAFT->PENDING", st == 200 and code_of(j) == 0
             and row and row["review_status"] == "PENDING" and ev
             and ev["from_status"] == "DRAFT",
             "status=%d row=%s ev=%s" % (st, row, ev))

        st, j, b = review(R["r1"], "submit")
        mark("G2", "review submit PENDING -> 400 状态不允许",
             st == 400 and code_of(j) == 1000
             and msg_of(j) == "当前审核状态不允许执行该操作",
             "status=%d code=%s msg=%s" % (st, code_of(j), msg_of(j)))

        st, j, b = review(R["r1"], "approve")
        row = db_one(cur, "SELECT review_status FROM generated_learning_resources WHERE id="
                          + unhex(R["r1"].hex))
        mark("G3", "review approve PENDING->APPROVED",
             st == 200 and row and row["review_status"] == "APPROVED",
             "status=%d row=%s" % (st, row))

        st, j, b = review(R["r1"], "publish")
        row = db_one(cur, "SELECT review_status FROM generated_learning_resources WHERE id="
                          + unhex(R["r1"].hex))
        mark("G4", "review publish APPROVED->PUBLISHED",
             st == 200 and row and row["review_status"] == "PUBLISHED",
             "status=%d row=%s" % (st, row))

        st, j, b = review(R["r1"], "deprecate")
        row = db_one(cur, "SELECT review_status FROM generated_learning_resources WHERE id="
                          + unhex(R["r1"].hex))
        mark("G5", "review deprecate PUBLISHED->DEPRECATED",
             st == 200 and row and row["review_status"] == "DEPRECATED",
             "status=%d row=%s" % (st, row))

        st, j, b = review(R["r1"], "reject")
        mark("G6", "review reject DEPRECATED -> 400 状态不允许",
             st == 400 and msg_of(j) == "当前审核状态不允许执行该操作",
             "status=%d msg=%s" % (st, msg_of(j)))

        st, j, b = review(R["r1"], "nonsense")
        mark("G7", "review 非法 action -> 400 审核操作无效",
             st == 400 and msg_of(j) == "审核操作无效",
             "status=%d msg=%s" % (st, msg_of(j)))

        st, j, b = review(R["r9"], "reject")
        row = db_one(cur, "SELECT review_status FROM generated_learning_resources WHERE id="
                          + unhex(R["r9"].hex))
        mark("G8", "review reject PENDING->REJECTED",
             st == 200 and row and row["review_status"] == "REJECTED",
             "status=%d row=%s" % (st, row))

        st, j, b = review(R["r9"], "submit")
        row = db_one(cur, "SELECT review_status FROM generated_learning_resources WHERE id="
                          + unhex(R["r9"].hex))
        mark("G9", "review submit REJECTED->PENDING",
             st == 200 and row and row["review_status"] == "PENDING",
             "status=%d row=%s" % (st, row))

        st, j, b = review(P["p2"], "approve")
        row = db_one(cur, "SELECT review_status FROM presentation_tasks WHERE id="
                          + unhex(P["p2"].hex))
        ev = db_one(cur, "SELECT action FROM presentation_review_events WHERE presentation_id="
                         + unhex(P["p2"].hex) + " AND action='APPROVE'")
        mark("G10", "review presentation 回退 PENDING->APPROVED",
             st == 200 and row and row["review_status"] == "APPROVED" and ev,
             "status=%d row=%s ev=%s" % (st, row, ev))

        # ---------------- H archive ----------------
        st, j, b = req("POST", "/api/v1/admin/resources/%s/archive" % R["r3"], admin_h,
                       json.dumps({"reason": "测试归档"}).encode())
        row = db_one(cur, "SELECT archived_at, archive_reason, is_template, is_public"
                          " FROM generated_learning_resources WHERE id=" + unhex(R["r3"].hex))
        ok = (st == 200 and code_of(j) == 0 and "data" not in j and msg_of(j) == "资源已归档"
              and row and row["archived_at"] is not None and row["archive_reason"] == "测试归档"
              and row["is_template"] == 0 and row["is_public"] == 0)
        mark("H1", "archive 资源（reason）", ok,
             "status=%d msg=%s row=%s" % (st, msg_of(j), row))

        st, j, b = req("POST", "/api/v1/admin/resources/%s/archive" % P["parch"], admin_h)
        row = db_one(cur, "SELECT archived_at, archive_reason FROM presentation_tasks WHERE id="
                          + unhex(P["parch"].hex))
        ok = (st == 200 and row and row["archived_at"] is not None
              and row["archive_reason"] == "管理员归档")
        mark("H2", "archive 课件无 body -> reason 管理员归档", ok,
             "status=%d row=%s" % (st, row))

        st, j, b = req("POST", "/api/v1/admin/resources/%s/archive" % uuid.uuid4(), admin_h)
        mark("H3", "archive 不存在 -> 404/4001", st == 404 and code_of(j) == 4001,
             "status=%d code=%s" % (st, code_of(j)))

        st, j, b = req("POST", "/api/v1/admin/resources/%s/archive" % R["r3"], admin_h)
        mark("H4", "archive 已归档 -> 404/4001", st == 404 and code_of(j) == 4001,
             "status=%d code=%s" % (st, code_of(j)))

        # ---------------- I template ----------------
        st, j, b = req("POST", "/api/v1/admin/resources/%s/template" % R["r1"], admin_h)
        mark("I1", "template 分组A -> 200 已设为母版",
             st == 200 and code_of(j) == 0 and msg_of(j) == "已设为母版",
             "status=%d msg=%s" % (st, msg_of(j)))

        rows = db_one(cur, "SELECT SUM(is_template) s FROM generated_learning_resources"
                           " WHERE organization_id=" + unhex(org_id.hex)
                           + " AND domain_code='dom-a' AND category_node_code='node-1'"
                           + " AND resource_scope='ORGANIZATION' AND archived_at IS NULL"
                           + " AND COALESCE(resource_group,'默认分组')='分组A'")
        prows = db_one(cur, "SELECT SUM(is_template) s FROM presentation_tasks"
                            " WHERE organization_id=" + unhex(org_id.hex)
                            + " AND domain_code='dom-a' AND category_node_code='node-1'"
                            + " AND resource_scope='ORGANIZATION' AND archived_at IS NULL"
                            + " AND COALESCE(resource_group,'默认分组')='分组A'")
        mark("I2", "template 分组A 两表 is_template=1", rows["s"] == 2 and prows["s"] == 1,
             "resources=%s presentations=%s" % (rows["s"], prows["s"]))

        st, j, b = req("POST", "/api/v1/admin/resources/%s/template" % R["r4"], admin_h)
        old = db_one(cur, "SELECT SUM(is_template) s FROM generated_learning_resources"
                          " WHERE organization_id=" + unhex(org_id.hex)
                          + " AND domain_code='dom-a' AND category_node_code='node-1'"
                          + " AND archived_at IS NULL AND COALESCE(resource_group,'默认分组')='分组A'")
        oldp = db_one(cur, "SELECT SUM(is_template) s FROM presentation_tasks"
                           " WHERE organization_id=" + unhex(org_id.hex)
                           + " AND domain_code='dom-a' AND category_node_code='node-1'"
                           + " AND archived_at IS NULL AND COALESCE(resource_group,'默认分组')='分组A'")
        new = db_one(cur, "SELECT SUM(is_template) s FROM generated_learning_resources"
                          " WHERE organization_id=" + unhex(org_id.hex)
                          + " AND domain_code='dom-a' AND category_node_code='node-1'"
                          + " AND archived_at IS NULL AND COALESCE(resource_group,'默认分组')='分组B'")
        newp = db_one(cur, "SELECT SUM(is_template) s FROM presentation_tasks"
                           " WHERE organization_id=" + unhex(org_id.hex)
                           + " AND domain_code='dom-a' AND category_node_code='node-1'"
                           + " AND archived_at IS NULL AND COALESCE(resource_group,'默认分组')='分组B'")
        ok = (st == 200 and old["s"] == 0 and oldp["s"] == 0
              and new["s"] == 1 and newp["s"] == 1)
        mark("I3", "template 分组B 后：A 全 0、B 两表唯一", ok,
             "A=%s/%s B=%s/%s" % (old["s"], oldp["s"], new["s"], newp["s"]))

        st, j, b = req("POST", "/api/v1/admin/resources/%s/template" % R["r7"], admin_h)
        mark("I4", "template 未绑定 -> 400 文案",
             st == 400 and msg_of(j) == "未绑定知识点的资源不能设为母版",
             "status=%d code=%s msg=%s" % (st, code_of(j), msg_of(j)))

        st, j, b = req("POST", "/api/v1/admin/resources/%s/template" % uuid.uuid4(), admin_h)
        mark("I5", "template 不存在 -> 404/4001", st == 404 and code_of(j) == 4001,
             "status=%d code=%s" % (st, code_of(j)))

        # ---------------- J delete ----------------
        st, j, b = req("DELETE", "/api/v1/admin/resources/%s" % R["rdel"], admin_h)
        row = db_one(cur, "SELECT COUNT(*) c FROM generated_learning_resources WHERE id="
                          + unhex(R["rdel"].hex))
        mark("J1", "DELETE 归档资源 -> 200 且行已删",
             st == 200 and code_of(j) == 0 and msg_of(j) == "资源已彻底删除"
             and row["c"] == 0,
             "status=%d msg=%s left=%s" % (st, msg_of(j), row["c"]))

        st, j, b = req("DELETE", "/api/v1/admin/resources/%s" % R["r1"], admin_h)
        mark("J2", "DELETE 非归档资源 -> 404/4001", st == 404 and code_of(j) == 4001,
             "status=%d code=%s" % (st, code_of(j)))

        before = len(SIGNATURES)
        st, j, b = req("DELETE", "/api/v1/admin/resources/%s" % P["pdel"], admin_h)
        row = db_one(cur, "SELECT COUNT(*) c FROM presentation_tasks WHERE id="
                          + unhex(P["pdel"].hex))
        sigs = SIGNATURES[before:]
        ok = (st == 200 and code_of(j) == 0 and row["c"] == 0
              and len(sigs) == 1 and sigs[0][1])
        mark("J3", "DELETE 归档课件 -> agents 签名正确且行已删", ok,
             "status=%d left=%s sig=%s" % (st, row["c"], sigs))

        # ---------------- K delete groups ----------------
        st, j, b = req("DELETE", "/api/v1/admin/resources/groups?domainCode=dom-a"
                       "&nodeCode=node-1&groupName=%E5%88%86%E7%BB%84C", admin_h)
        rc = db_one(cur, "SELECT COUNT(*) c FROM generated_learning_resources WHERE id="
                         + unhex(R["r6"].hex))
        pc = db_one(cur, "SELECT COUNT(*) c FROM presentation_tasks WHERE id="
                         + unhex(P["p5"].hex))
        ok = (st == 200 and code_of(j) == 0 and msg_of(j) == "分组已彻底删除"
              and rc["c"] == 0 and pc["c"] == 0 and len(GROUP_CALLS) >= 1)
        mark("K1", "DELETE groups -> 两表行删除 + agents 调用", ok,
             "status=%d msg=%s r=%s p=%s calls=%d"
             % (st, msg_of(j), rc["c"], pc["c"], len(GROUP_CALLS)))

        st, j, b = req("DELETE", "/api/v1/admin/resources/groups?domainCode=dom-a"
                       "&nodeCode=node-1&groupName=", admin_h)
        mark("K2", "DELETE groups 空名称 -> 400",
             st == 400 and msg_of(j) == "分组名称不能为空",
             "status=%d msg=%s" % (st, msg_of(j)))

        st, j, b = req("DELETE", "/api/v1/admin/resources/groups?domainCode=dom-a"
                       "&nodeCode=node-1&groupName=%E9%BB%98%E8%AE%A4%E5%88%86%E7%BB%84",
                       admin_h)
        mark("K3", "DELETE groups 默认分组 -> 400",
             st == 400 and msg_of(j) == "默认分组不允许彻底删除，可先清空该分组下资源",
             "status=%d msg=%s" % (st, msg_of(j)))

        st, j, b = req("DELETE", "/api/v1/admin/resources/groups?domainCode="
                       "&nodeCode=&groupName=x", admin_h)
        mark("K4", "DELETE groups 未绑定 -> 400",
             st == 400 and msg_of(j) == "未绑定知识点的资源不能设为母版",
             "status=%d msg=%s" % (st, msg_of(j)))

        # ---------------- L purge archived ----------------
        cnt = db_one(cur, "SELECT (SELECT COUNT(*) FROM generated_learning_resources"
                          " WHERE organization_id=" + unhex(org_id.hex)
                          + " AND archived_at IS NOT NULL) + (SELECT COUNT(*) FROM"
                          " presentation_tasks WHERE organization_id=" + unhex(org_id.hex)
                          + " AND archived_at IS NOT NULL) c")
        expect_n = cnt["c"]
        st, j, b = req("DELETE", "/api/v1/admin/resources/archived", admin_h)
        left = db_one(cur, "SELECT (SELECT COUNT(*) FROM generated_learning_resources"
                            " WHERE organization_id=" + unhex(org_id.hex)
                            + " AND archived_at IS NOT NULL) + (SELECT COUNT(*) FROM"
                            " presentation_tasks WHERE organization_id=" + unhex(org_id.hex)
                            + " AND archived_at IS NOT NULL) c")
        ok = (st == 200 and code_of(j) == 0
              and msg_of(j) == "已彻底清理 %d 条归档内容" % expect_n and left["c"] == 0)
        mark("L1", "DELETE archived 清理条数与文案", ok,
             "status=%d expect=%s msg=%s left=%s"
             % (st, expect_n, msg_of(j), left["c"]))

        # ---------------- M learning-template-resources ----------------
        TPL_KEYS = ["id", "type", "title", "topic", "domainCode", "nodeCode",
                    "groupName", "createdAt", "updatedAt"]
        st, j, b = req("GET", "/api/v1/learning-template-resources", admin_h)
        d = j.get("data") if isinstance(j, dict) else None
        items = d.get("items") if isinstance(d, dict) else []
        ids = sorted([it.get("id") for it in items]) if items else []
        ok = (st == 200 and code_of(j) == 0 and d.get("total") == 2 and len(items) == 2
              and all(list(it.keys()) == TPL_KEYS for it in items)
              and sorted([str(R["r4"]), str(P["p3"])]) == ids)
        mark("M1", "learning-template-resources 管理员两表合并", ok,
             "status=%d total=%s ids=%s keys=%s"
             % (st, d.get("total") if isinstance(d, dict) else None, ids,
                list(items[0].keys()) if items else None))

        st, j, b = req("GET", "/api/v1/learning-template-resources", normal_h)
        d = j.get("data") if isinstance(j, dict) else None
        ok = st == 200 and isinstance(d, dict) and d.get("total") == 2
        mark("M2", "learning-template-resources 普通用户可读", ok,
             "status=%d total=%s" % (st, d.get("total") if isinstance(d, dict) else None))

        st, j, b = req("GET", "/api/v1/learning-template-resources?domainCode=nope", admin_h)
        d = j.get("data") if isinstance(j, dict) else None
        ok = st == 200 and isinstance(d, dict) and d.get("total") == 0
        mark("M3", "learning-template-resources domain 过滤", ok,
             "status=%d total=%s" % (st, d.get("total") if isinstance(d, dict) else None))

        st, j, b = req("GET", "/api/v1/learning-template-resources", noorg_h)
        d = j.get("data") if isinstance(j, dict) else None
        ok = (st == 200 and isinstance(d, dict) and d.get("items") == []
              and d.get("total") == 0)
        mark("M4", "learning-template-resources 无机构 -> 空结果", ok,
             "status=%d data=%s" % (st, d))

        st, j, b = req("GET", "/api/v1/learning-template-resources")
        mark("M5", "learning-template-resources 未登录 -> 401", st == 401,
             "status=%d" % st)

    finally:
        # ---------------- 清理 ----------------
        try:
            if (DB is not None and org_id is not None
                    and admin_id is not None and normal_id is not None
                    and noorg_id is not None):
                cur = DB.cursor()
                uid_lits = ",".join([unhex(x.hex) for x in
                                     (admin_id, normal_id, noorg_id)])
                cur.execute("DELETE FROM learning_resource_review_events WHERE organization_id="
                            + unhex(org_id.hex))
                cur.execute("DELETE FROM presentation_review_events WHERE organization_id="
                            + unhex(org_id.hex))
                cur.execute("DELETE FROM presentation_task_user_state WHERE task_id IN"
                            " (SELECT id FROM presentation_tasks WHERE organization_id="
                            + unhex(org_id.hex) + ")")
                cur.execute("DELETE FROM generated_learning_resources WHERE organization_id="
                            + unhex(org_id.hex))
                cur.execute("DELETE FROM presentation_tasks WHERE organization_id="
                            + unhex(org_id.hex))
                cur.execute("DELETE FROM learning_resource_generation_tasks WHERE user_id IN ("
                            + uid_lits + ")")
                cur.execute("DELETE FROM user_sessions WHERE user_id IN (" + uid_lits + ")")
                cur.execute("DELETE FROM users WHERE id IN (" + uid_lits + ")")
                cur.execute("DELETE FROM organizations WHERE id=" + unhex(org_id.hex))
                logline("cleanup done for org=%s" % org_code)
        except Exception as exc:  # noqa: BLE001
            logline("cleanup failed: %r" % (exc,))
        if stub is not None:
            try:
                stub.shutdown()
            except Exception:  # noqa: BLE001
                pass
        for _name, proc in procs:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                pass
        try:
            if DB is not None:
                DB.close()
        except Exception:  # noqa: BLE001
            pass

    passed = sum(1 for r in RESULTS if r[2])
    total = len(RESULTS)
    logline("")
    logline("RESULT %d/%d  port=%d db=%s" % (passed, total, spire_port, dbname))
    failed = [r for r in RESULTS if not r[2]]
    if failed:
        logline("FAILURES:")
        for rid, label, _ok, detail in failed:
            logline("  [%s] %s :: %s" % (rid, label, detail))
    if LOG:
        LOG.close()
    return 0 if total > 0 and passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
