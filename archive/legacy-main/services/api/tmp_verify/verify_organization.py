# -*- coding: utf-8 -*-
"""
机构与成员管理隔离验证（OrganizationController 可迁移的 11 条）。

覆盖：
  GET    /api/v1/organization/branding
  GET    /api/v1/organization/branding/logo
  GET    /api/v1/admin/organization
  PUT    /api/v1/admin/organization
  DELETE /api/v1/admin/organization/logo
  GET    /api/v1/admin/users
  GET    /api/v1/admin/users/{id}
  POST   /api/v1/admin/users/{id}/enable
  POST   /api/v1/admin/users/{id}/disable
  POST   /api/v1/admin/users/{id}/reset
  POST   /api/v1/admin/organization/invites

POST /api/v1/admin/organization/logo 仍转发 Java（multipart + ImageIO 重编码），
本脚本只验证它没有被 Spire 抢走：请求应落到网关（指向一个死端口时 502）。

用法： D:\\anaconda\\python.exe tmp_verify/verify_organization.py
"""

import base64
import hashlib
import hmac
import http.client
import json
import os
import re
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

PREFERRED_PORT = 18873

RESULTS = []
LOG = None
DB = None


def mark(rid, label, ok, detail=""):
    RESULTS.append((rid, label, ok, detail))
    line = "[%s] %-4s %s%s" % ("PASS" if ok else "FAIL", rid, label,
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
        return r.status, dict((k.lower(), v) for k, v in r.getheaders()), data
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


def build_env(secrets, spire_port):
    env = os.environ.copy()
    env["CANGJIE_HOME"] = CJ
    env["CANGJIE_STDX_PATH"] = r"D:\software\cangjie\stdx-1.2.0\windows_x86_64_cjnative\static\stdx"
    prefix = ";".join([
        os.path.join(CJ, "runtime", "lib", "windows_x86_64_cjnative"),
        os.path.join(CJ, "lib", "windows_x86_64_cjnative"),
        os.path.join(CJ, "bin"), os.path.join(CJ, "tools", "bin"),
        os.path.join(CJ, "tools", "lib"), ANACONDA_LIB,
    ])
    env["PATH"] = prefix + ";" + env.get("PATH", "")
    env["JWT_SECRET"] = secrets["JWT_SECRET"]
    env["PLATFORM_DB_URL"] = secrets["PLATFORM_DB_URL"]
    env["SPIRE_HTTP_URL"] = "http://127.0.0.1:%d" % spire_port
    env["AGENTS_UPSTREAM"] = "http://127.0.0.1:1"
    env["JAVA_UPSTREAM"] = "http://127.0.0.1:1"
    return env


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def sign_jwt(secret, sub):
    header = {"alg": "HS256", "typ": "JWT"}
    now = int(time.time())
    payload = {"sub": sub, "iat": now, "exp": now + 3600}
    seg = (b64url(json.dumps(header, separators=(",", ":")).encode()) + "." +
           b64url(json.dumps(payload, separators=(",", ":")).encode()))
    sig = hmac.new(secret.encode(), seg.encode("ascii"), hashlib.sha256).digest()
    return seg + "." + b64url(sig)


def jbody(raw):
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def unhexv(raw):
    return "UNHEX('%s')" % raw.hex


def sha256_hex(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


def main():
    global LOG, DB
    procs = []
    LOG = open(os.path.join(HERE, "verify_organization.log"), "w", encoding="utf-8")
    suffix = uuid.uuid4().hex[:6]
    ids = {}
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
            return 2

        rest = url.split("://", 1)[1]
        userinfo, hostpart = rest.split("@", 1)
        user, pwd = userinfo.split(":", 1)
        hostport, dbname = hostpart.split("/", 1)
        host, port = hostport.split(":", 1)
        DB = pymysql.connect(host=host, port=int(port), user=user, password=pwd,
                             database=dbname, charset="utf8mb4",
                             cursorclass=pymysql.cursors.DictCursor, autocommit=True)
        logline("db=%s connected" % dbname)

        spire_port = pick_port(PREFERRED_PORT)
        spire = subprocess.Popen([EXE], cwd=os.path.dirname(EXE),
                                 env=build_env(secrets, spire_port),
                                 stdout=LOG, stderr=LOG)
        procs.append(spire)
        if not wait_port(spire_port):
            print("Spire 未起来")
            return 2
        time.sleep(0.3)
        logline("spire pid=%s port=%d" % (spire.pid, spire_port))

        # ---------------- 造隔离数据 ----------------
        org_id = uuid.uuid4()
        org2_id = uuid.uuid4()
        admin_id = uuid.uuid4()
        learner_id = uuid.uuid4()
        outsider_id = uuid.uuid4()
        tokens = {}
        for key, uid in [("admin", admin_id), ("learner", learner_id),
                         ("outsider", outsider_id)]:
            tokens[key] = sign_jwt(sec, str(uid))
        H = {k: {"Authorization": "Bearer " + v} for k, v in tokens.items()}

        org_code = "ORG-%s" % suffix
        cur = DB.cursor()
        ids["org"] = org_id
        ids["users"] = [admin_id, learner_id, outsider_id]
        for oid, code, name, short in [
                (org_id, org_code, "验证机构%s" % suffix, "验证%s" % suffix),
                (org2_id, "ORG2-%s" % suffix, "另一机构%s" % suffix, "另一%s" % suffix)]:
            cur.execute(
                "INSERT INTO organizations(id,code,name,short_name,status,created_at,updated_at)"
                " VALUES(" + unhexv(oid) + ",%s,%s,%s,1,NOW(6),NOW(6))", (code, name, short))

        def add_user(uid, email, account_type, org, nickname, created):
            cur.execute(
                "INSERT INTO users(id,email,password_hash,nickname,active,account_type,"
                "organization_id,admin_scope,created_at,updated_at) VALUES("
                + unhexv(uid) + ",%s,'x',%s,1,%s," +
                ("%s" if org else "NULL") + ",NULL,%s,%s)",
                tuple([email, nickname, account_type] + ([org.bytes] if org else []) +
                      [created, created]))
            cur.execute(
                "INSERT INTO user_sessions(token_hash,user_id,created_at,expires_at,"
                "revoked_at,ip_address,user_agent) VALUES(%s," + unhexv(uid) +
                ",NOW(6),DATE_ADD(NOW(6), INTERVAL 2 HOUR),NULL,NULL,'verify-org')",
                (sha256_hex(tokens_by_uid[uid]),))

        tokens_by_uid = {admin_id: tokens["admin"], learner_id: tokens["learner"],
                         outsider_id: tokens["outsider"]}
        add_user(admin_id, "org-admin-%s@example.test" % suffix, "ADMIN", org_id,
                 "管理员", "2026-01-01 10:00:00")
        add_user(learner_id, "org-learner-%s@example.test" % suffix, "LEARNER", org_id,
                 "学习者", "2026-01-02 10:00:00")
        add_user(outsider_id, "org-out-%s@example.test" % suffix, "LEARNER", org2_id,
                 "外机构", "2026-01-03 10:00:00")

        def req(method, path, who=None, body=None, extra=None):
            headers = dict(H.get(who, {})) if who else {}
            if extra:
                headers.update(extra)
            if body is not None:
                headers["Content-Type"] = "application/json"
                body = json.dumps(body).encode("utf-8")
            return http_req(spire_port, method, path, body, headers)

        # ---------------- A 鉴权 ----------------
        st, _, b = http_req(spire_port, "GET", "/api/v1/organization/branding")
        mark("A1", "未登录 branding -> 401", st == 401, "status=%d" % st)

        st, hh, b = req("GET", "/api/v1/admin/organization", "learner")
        j = jbody(b)
        mark("A2", "非管理员访问 /admin/organization -> 403/1006「仅机构管理员…」",
             st == 403 and j.get("code") == 1006
             and j.get("message") == "仅机构管理员可以执行此操作",
             "status=%d body=%r" % (st, b[:160]))

        st, hh, b = req("GET", "/api/v1/admin/users", "learner")
        j = jbody(b)
        mark("A3", "非管理员访问 /admin/users -> 403/1006", st == 403 and j.get("code") == 1006,
             "status=%d body=%r" % (st, b[:120]))

        # ---------------- B 品牌读 ----------------
        st, hh, b = req("GET", "/api/v1/organization/branding", "learner")
        j = jbody(b)
        d = j.get("data") if isinstance(j, dict) else None
        mark("B1", "branding 信封 code=0/message=success/timestamp",
             st == 200 and j.get("code") == 0 and j.get("message") == "success"
             and "timestamp" in j, "status=%d body=%r" % (st, b[:200]))
        mark("B2", "branding 字段与顺序齐全",
             list(d.keys()) == ["code", "name", "shortName", "logoUrl", "logoUpdatedAt"]
             and d.get("code") == org_code
             and d.get("name") == "验证机构%s" % suffix,
             "data=%r" % (d,))
        mark("B3", "无 Logo 时 logoUrl / logoUpdatedAt 均为 null",
             d.get("logoUrl") is None and d.get("logoUpdatedAt") is None, "data=%r" % (d,))

        st, hh, b = req("GET", "/api/v1/admin/organization", "admin")
        j = jbody(b)
        mark("B4", "管理员 GET /admin/organization 与 branding 同形",
             st == 200 and j.get("code") == 0 and j.get("data", {}).get("code") == org_code,
             "status=%d body=%r" % (st, b[:160]))

        st, hh, b = req("GET", "/api/v1/organization/branding/logo", "learner")
        j = jbody(b)
        mark("B5", "无 Logo 时 GET logo -> 404/4001「机构尚未配置 Logo」",
             st == 404 and j.get("code") == 4001 and j.get("message") == "机构尚未配置 Logo",
             "status=%d body=%r" % (st, b[:160]))

        # ---------------- C PUT 机构信息 ----------------
        st, hh, b = req("PUT", "/api/v1/admin/organization", "admin",
                        {"name": "  新机构名%s  " % suffix, "shortName": "  新简%s " % suffix},
                        {"X-Request-Id": "verify-org-" + suffix})
        j = jbody(b)
        d = j.get("data") if isinstance(j, dict) else None
        mark("C1", "PUT 成功 message=机构信息已更新",
             st == 200 and j.get("code") == 0 and j.get("message") == "机构信息已更新",
             "status=%d body=%r" % (st, b[:200]))
        mark("C2", "name/shortName 已 strip",
             d.get("name") == "新机构名%s" % suffix
             and d.get("shortName") == "新简%s" % suffix, "data=%r" % (d,))

        cur.execute("SELECT name,short_name FROM organizations WHERE id=" + unhexv(org_id))
        row = cur.fetchone()
        mark("C3", "落库为 strip 后的值",
             row["name"] == "新机构名%s" % suffix
             and row["short_name"] == "新简%s" % suffix, "row=%r" % (row,))

        cur.execute("SELECT action,target_type,target_id,before_json,after_json,request_id"
                    " FROM organization_audit_log WHERE organization_id=" + unhexv(org_id) +
                    " AND action='ORGANIZATION_BRANDING_UPDATED'")
        arow = cur.fetchone()
        mark("C4", "审计行写入（before/after + request_id）",
             arow is not None
             and arow["target_type"] == "organization"
             and arow["target_id"] == str(org_id)
             and arow["request_id"] == "verify-org-" + suffix
             and isinstance(arow["before_json"], str)
             and json.loads(arow["after_json"])["name"] == "新机构名%s" % suffix,
             "row=%r" % (arow,))

        st, hh, b = req("PUT", "/api/v1/admin/organization", "admin",
                        {"name": "   ", "shortName": "x"})
        j = jbody(b)
        mark("C5", "空白 name -> 400/1000「name: must not be blank」",
             st == 400 and j.get("code") == 1000
             and j.get("message") == "name: must not be blank",
             "status=%d body=%r" % (st, b[:160]))

        st, hh, b = req("PUT", "/api/v1/admin/organization", "admin",
                        {"name": "a" * 129, "shortName": "b" * 65})
        j = jbody(b)
        mark("C6", "超长 -> 两条错误按 ; 连接",
             st == 400 and j.get("code") == 1000
             and j.get("message") ==
             "name: size must be between 0 and 128; shortName: size must be between 0 and 64",
             "status=%d body=%r" % (st, b[:200]))

        st, hh, b = req("PUT", "/api/v1/admin/organization", "admin", None)
        st2, _, b2 = http_req(spire_port, "PUT", "/api/v1/admin/organization",
                              b"{not-json", dict(H["admin"], **{"Content-Type": "application/json"}))
        j = jbody(b2)
        mark("C7", "非 JSON 请求体 -> 400/1000 统一提示",
             st2 == 400 and j.get("code") == 1000
             and j.get("message") == "请求体不是有效的 JSON 或字段类型错误",
             "status=%d body=%r" % (st2, b2[:160]))

        # ---------------- D Logo 读 / 删 ----------------
        logo_bytes = b"\x89PNG\r\n\x1a\n" + ("LOGO-%s" % suffix).encode()
        cur.execute("UPDATE organizations SET logo_data=%s,logo_content_type='image/png',"
                    "logo_updated_at=NOW(6) WHERE id=" + unhexv(org_id),
                    (logo_bytes,))
        st, hh, b = req("GET", "/api/v1/organization/branding/logo", "learner")
        mark("D1", "有 Logo -> 200 字节一致 + Content-Type",
             st == 200 and b == logo_bytes
             and (hh.get("content-type") or "").startswith("image/png"),
             "status=%d len=%d ct=%r" % (st, len(b), hh.get("content-type")))
        mark("D2", "Logo 响应 Cache-Control=max-age=3600, private",
             hh.get("cache-control") == "max-age=3600, private",
             "cc=%r" % hh.get("cache-control"))

        st, hh, b = req("GET", "/api/v1/organization/branding", "learner")
        d = jbody(b).get("data")
        url = d.get("logoUrl") or ""
        m = re.match(r"^/api/v1/organization/branding/logo\?v=(\d+)$", url)
        now_ms = int(time.time() * 1000)
        mark("D3", "logoUrl 带 ?v=<epochMilli>，且时间接近现在",
             bool(m) and abs(int(m.group(1)) - now_ms) < 180000,
             "logoUrl=%r" % url)
        mark("D4", "logoUpdatedAt 是 ISO_INSTANT",
             bool(ISO_Z.match(str(d.get("logoUpdatedAt")))), "v=%r" % d.get("logoUpdatedAt"))

        st, hh, b = req("DELETE", "/api/v1/admin/organization/logo", "admin")
        j = jbody(b)
        d = j.get("data") if isinstance(j, dict) else None
        mark("D5", "DELETE logo -> 200 message=机构 Logo 已恢复默认 且 logoUrl=null",
             st == 200 and j.get("message") == "机构 Logo 已恢复默认"
             and d.get("logoUrl") is None and d.get("logoUpdatedAt") is None,
             "status=%d body=%r" % (st, b[:200]))
        st, hh, b = req("GET", "/api/v1/organization/branding/logo", "learner")
        mark("D6", "删后 GET logo -> 404/4001", st == 404
             and (jbody(b) or {}).get("code") == 4001, "status=%d" % st)

        # ---------------- E 用户列表 ----------------
        st, hh, b = req("GET", "/api/v1/admin/users", "admin")
        j = jbody(b)
        d = j.get("data") or {}
        mark("E1", "users 分页信封 items/page/size/totalElements/totalPages",
             st == 200 and list(d.keys()) == ["items", "page", "size", "totalElements",
                                              "totalPages"],
             "data=%r" % (d,))
        mark("E2", "本机构 2 个账号（不含外机构）", d.get("totalElements") == 2
             and len(d.get("items") or []) == 2, "data=%r" % (d,))
        mark("E3", "page/size 默认 0/20，totalPages=ceil",
             d.get("page") == 0 and d.get("size") == 20 and d.get("totalPages") == 1,
             "data=%r" % (d,))
        emails = [x.get("email") for x in d.get("items") or []]
        mark("E4", "按 createdAt DESC（学习者 01-02 在管理员 01-01 之前）",
             emails == ["org-learner-%s@example.test" % suffix,
                        "org-admin-%s@example.test" % suffix], "emails=%r" % (emails,))
        first = (d.get("items") or [{}])[0]
        mark("E5", "AdminUserResponse 字段与类型",
             list(first.keys()) == ["id", "email", "nickname", "accountType", "active",
                                    "createdAt", "updatedAt"]
             and first.get("accountType") == "LEARNER" and first.get("active") is True
             and first.get("id") == str(learner_id)
             and ISO_Z.match(str(first.get("createdAt"))) is not None,
             "first=%r" % (first,))

        st, hh, b = req("GET", "/api/v1/admin/users?size=999&page=-3", "admin")
        d = jbody(b).get("data") or {}
        mark("E6", "size 上限 100、page 下限 0", d.get("size") == 100 and d.get("page") == 0,
             "data=%r" % (d,))
        st, hh, b = req("GET", "/api/v1/admin/users?page=abc", "admin")
        j = jbody(b)
        mark("E7", "page 非整数 -> 400/1000 参数类型不正确：page",
             st == 400 and j.get("message") == "参数类型不正确：page",
             "status=%d body=%r" % (st, b[:120]))

        # ---------------- F 用户详情 / 越权 ----------------
        st, hh, b = req("GET", "/api/v1/admin/users/%s" % learner_id, "admin")
        j = jbody(b)
        mark("F1", "本机构用户详情 200", st == 200 and j.get("data", {}).get("email")
             == "org-learner-%s@example.test" % suffix, "status=%d" % st)
        st, hh, b = req("GET", "/api/v1/admin/users/%s" % outsider_id, "admin")
        j = jbody(b)
        mark("F2", "外机构用户 -> 404/3004「本机构内未找到该账号」",
             st == 404 and j.get("code") == 3004 and j.get("message") == "本机构内未找到该账号",
             "status=%d body=%r" % (st, b[:140]))
        st, hh, b = req("GET", "/api/v1/admin/users/not-a-uuid", "admin")
        j = jbody(b)
        mark("F3", "非法 UUID -> 400/1000 参数类型不正确：id",
             st == 400 and j.get("code") == 1000
             and j.get("message") == "参数类型不正确：id",
             "status=%d body=%r" % (st, b[:140]))

        # ---------------- G 启用 / 停用 ----------------
        st, hh, b = req("POST", "/api/v1/admin/users/%s/disable" % learner_id, "admin",
                        extra={"X-Request-Id": "verify-org-off-" + suffix})
        j = jbody(b)
        mark("G1", "停用 -> 200 message=账号已停用 且 active=false",
             st == 200 and j.get("message") == "账号已停用"
             and j.get("data", {}).get("active") is False,
             "status=%d body=%r" % (st, b[:200]))
        cur.execute("SELECT active FROM users WHERE id=" + unhexv(learner_id))
        mark("G2", "落库 active=0", cur.fetchone()["active"] == 0, "")

        st, hh, b = req("POST", "/api/v1/admin/users/%s/enable" % learner_id, "admin",
                        extra={"X-Request-Id": "verify-org-on-" + suffix})
        j = jbody(b)
        mark("G3", "启用 -> 200 message=账号已启用 且 active=true",
             st == 200 and j.get("message") == "账号已启用"
             and j.get("data", {}).get("active") is True, "status=%d" % st)
        cur.execute("SELECT action,request_id FROM organization_audit_log"
                    " WHERE organization_id=" + unhexv(org_id) +
                    " AND action IN ('USER_DISABLED','USER_ENABLED') ORDER BY id")
        acts = [(r["action"], r["request_id"]) for r in cur.fetchall()]
        mark("G4", "两条审计（DISABLED / ENABLED）",
             acts == [("USER_DISABLED", "verify-org-off-" + suffix),
                      ("USER_ENABLED", "verify-org-on-" + suffix)], "acts=%r" % (acts,))

        st, hh, b = req("POST", "/api/v1/admin/users/%s/disable" % admin_id, "admin")
        j = jbody(b)
        mark("G5", "停用自己 -> 400/1000「不能停用当前登录的管理员账号」",
             st == 400 and j.get("code") == 1000
             and j.get("message") == "不能停用当前登录的管理员账号",
             "status=%d body=%r" % (st, b[:160]))

        # ---------------- H 重置使用记录 ----------------
        learner_row = uuid.uuid4()
        session_row = uuid.uuid4()
        msg_row = uuid.uuid4()
        cur.execute("INSERT INTO learners(id,user_id,name,status,created_at,updated_at)"
                    " VALUES(" + unhexv(learner_row) + "," + unhexv(learner_id) +
                    ",'重置验证',1,NOW(6),NOW(6))")
        cur.execute("INSERT INTO chat_sessions(id,user_id,title,archived,created_at,updated_at)"
                    " VALUES(" + unhexv(session_row) + "," + unhexv(learner_id) +
                    ",'重置会话',0,NOW(6),NOW(6))")
        cur.execute("INSERT INTO chat_messages(id,session_id,seq,role,content,created_at)"
                    " VALUES(" + unhexv(msg_row) + "," + unhexv(session_row) +
                    ",1,'user','hi',NOW(6))")

        st, hh, b = req("POST", "/api/v1/admin/users/%s/reset" % learner_id, "admin")
        j = jbody(b)
        mark("H1", "reset -> 200 message=使用记录已重置…",
             st == 200 and j.get("message") == "使用记录已重置，该账号将重新进入画像建档",
             "status=%d body=%r" % (st, b[:200]))
        cur.execute("SELECT COUNT(*) c FROM learners WHERE id=" + unhexv(learner_row))
        c1 = cur.fetchone()["c"]
        cur.execute("SELECT COUNT(*) c FROM chat_sessions WHERE id=" + unhexv(session_row))
        c2 = cur.fetchone()["c"]
        cur.execute("SELECT COUNT(*) c FROM chat_messages WHERE id=" + unhexv(msg_row))
        c3 = cur.fetchone()["c"]
        mark("H2", "学习者行 / 会话 / 消息全部删除",
             c1 == 0 and c2 == 0 and c3 == 0, "learners=%d sessions=%d msgs=%d" % (c1, c2, c3))
        cur.execute("SELECT COUNT(*) c FROM users WHERE id=" + unhexv(learner_id))
        mark("H3", "users 行保留（不误删账号）", cur.fetchone()["c"] == 1, "")

        st, hh, b = req("POST", "/api/v1/admin/users/%s/reset" % admin_id, "admin")
        j = jbody(b)
        mark("H4", "重置管理员 -> 400/1000「仅可重置学习者账号的使用记录」",
             st == 400 and j.get("code") == 1000
             and j.get("message") == "仅可重置学习者账号的使用记录",
             "status=%d body=%r" % (st, b[:160]))

        # ---------------- I 邀请码 ----------------
        st, hh, b = req("POST", "/api/v1/admin/organization/invites", "admin",
                        {}, {"X-Request-Id": "verify-org-inv-" + suffix})
        j = jbody(b)
        d = j.get("data") if isinstance(j, dict) else None
        mark("I1", "空对象 -> 200 message=邀请码已生成…",
             st == 200 and j.get("message") == "邀请码已生成，请立即安全发送给机构成员",
             "status=%d body=%r" % (st, b[:200]))
        mark("I2", "邀请码形如 CB-XXXXXXXXXX（字母表无 I/O/0/1）",
             bool(re.match(r"^CB-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$",
                           str(d.get("invitationCode")))), "data=%r" % (d,))
        mark("I3", "缺省 label/maxUses/expiresAt 均为 null，usedCount=0、active=true",
             d.get("label") is None and d.get("maxUses") is None
             and d.get("expiresAt") is None and d.get("usedCount") == 0
             and d.get("active") is True, "data=%r" % (d,))
        mark("I4", "字段顺序与类型（id 是 UUID 字符串、createdAt ISO_INSTANT）",
             list(d.keys()) == ["id", "invitationCode", "label", "maxUses", "usedCount",
                                "expiresAt", "active", "createdAt"]
             and ISO_Z.match(str(d.get("createdAt"))) is not None,
             "data=%r" % (d,))
        normalized = d["invitationCode"].replace("-", "").replace(" ", "").upper()
        cur.execute("SELECT code_hash,organization_id,created_by,label,max_uses,used_count,"
                    "expires_at,active FROM organization_invites WHERE code_hash=%s",
                    (sha256_hex(normalized),))
        irow = cur.fetchone()
        mark("I5", "落库 code_hash=sha256(normalize(code))，机构与创建人正确",
             irow is not None and irow["organization_id"] == org_id.bytes
             and irow["created_by"] == admin_id.bytes and irow["max_uses"] is None
             and irow["used_count"] == 0 and irow["active"] == 1,
             "row=%r" % (irow,))
        cur.execute("SELECT COUNT(*) c FROM organization_audit_log WHERE organization_id=" +
                    unhexv(org_id) + " AND action='ORGANIZATION_BRANDING_UPDATED'")
        mark("I6", "建邀请码不写审计（与 Java 一致）",
             cur.fetchone()["c"] == 1, "")

        st, hh, b = req("POST", "/api/v1/admin/organization/invites", "admin",
                        {"label": "  班级邀请  ", "maxUses": 5, "expiresInDays": 7})
        j = jbody(b)
        d = j.get("data") if isinstance(j, dict) else None
        now = int(time.time())
        exp = d.get("expiresAt") or ""
        exp_ok = False
        if ISO_Z.match(exp):
            import datetime
            dt = datetime.datetime.strptime(exp.replace("Z", "+0000"), "%Y-%m-%dT%H:%M:%S.%f%z") \
                if "." in exp else datetime.datetime.strptime(exp, "%Y-%m-%dT%H:%M:%SZ").replace(
                    tzinfo=datetime.timezone.utc)
            exp_ok = abs(dt.timestamp() - (now + 7 * 86400)) < 300
        mark("I7", "带参：label 已 strip、maxUses、expiresAt≈now+7d",
             st == 200 and d.get("label") == "班级邀请" and d.get("maxUses") == 5 and exp_ok,
             "data=%r" % (d,))

        st, hh, b = req("POST", "/api/v1/admin/organization/invites", "admin",
                        {"maxUses": 0, "expiresInDays": 366})
        j = jbody(b)
        mark("I8", "@Min/@Max 组合错误按 ; 连接",
             st == 400 and j.get("message") ==
             "maxUses: must be greater than or equal to 1; "
             "expiresInDays: must be less than or equal to 365",
             "status=%d body=%r" % (st, b[:200]))

        st, hh, b = req("POST", "/api/v1/admin/organization/invites", "admin",
                        {"label": "x" * 129})
        j = jbody(b)
        mark("I9", "label 超 128 -> 400/1000 size 提示",
             st == 400 and j.get("message") == "label: size must be between 0 and 128",
             "status=%d body=%r" % (st, b[:160]))

        # reset 会把该学习者的 user_sessions 一并清掉（Java 的级联语义），
        # 所以这里补一条新会话，保证下面的越权用例测的是「已登录的非管理员」。
        cur.execute(
            "INSERT INTO user_sessions(token_hash,user_id,created_at,expires_at,"
            "revoked_at,ip_address,user_agent) VALUES(%s," + unhexv(learner_id) +
            ",NOW(6),DATE_ADD(NOW(6), INTERVAL 2 HOUR),NULL,NULL,'verify-org')",
            (sha256_hex(tokens["learner"]),))
        st, hh, b = req("POST", "/api/v1/admin/organization/invites", "learner", {})
        mark("I10", "非管理员建邀请码 -> 403/1006", st == 403
             and (jbody(b) or {}).get("code") == 1006, "status=%d" % st)

        # ---------------- J Logo 上传仍走网关 ----------------
        st, hh, b = http_req(spire_port, "POST", "/api/v1/admin/organization/logo",
                             b"--x--", dict(H["admin"], **{
                                 "Content-Type": "multipart/form-data; boundary=x"}))
        mark("J1", "multipart Logo 上传未被 Spire 接管（转发目标死端口 -> 502/503）",
             st in (502, 503), "status=%d body=%r" % (st, b[:120]))

        passed = sum(1 for r in RESULTS if r[2])
        logline("\n==== %d/%d ====" % (passed, len(RESULTS)))
        return 0 if passed == len(RESULTS) else 1

    finally:
        for p in procs:
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass
        try:
            if DB is not None:
                cur = DB.cursor()
                try:
                    if ids.get("org"):
                        cur.execute("DELETE FROM organization_invites WHERE organization_id="
                                    + unhexv(ids["org"]))
                        cur.execute("DELETE FROM organization_audit_log WHERE organization_id="
                                    + unhexv(ids["org"]))
                        uids = ids.get("users") or []
                        if uids:
                            in_list = ",".join(unhexv(u) for u in uids)
                            cur.execute("DELETE FROM chat_messages WHERE session_id IN"
                                        " (SELECT id FROM chat_sessions WHERE user_id IN ("
                                        + in_list + "))")
                            cur.execute("DELETE FROM chat_sessions WHERE user_id IN ("
                                        + in_list + ")")
                            cur.execute("DELETE FROM learners WHERE user_id IN (" + in_list + ")")
                            cur.execute("DELETE FROM user_sessions WHERE user_id IN ("
                                        + in_list + ")")
                            cur.execute("DELETE FROM users WHERE id IN (" + in_list + ")")
                        cur.execute("DELETE FROM organizations WHERE id=" + unhexv(ids["org"]))
                finally:
                    DB.close()
        except Exception as exc:  # noqa: BLE001
            logline("cleanup failed: %r" % (exc,))
        if LOG:
            LOG.close()


if __name__ == "__main__":
    sys.exit(main())
