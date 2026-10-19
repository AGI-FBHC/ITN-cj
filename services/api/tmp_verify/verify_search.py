# -*- coding: utf-8 -*-
"""
GET /api/v1/search 隔离验证（LearnForgeSupportController 迁移）。

用法： D:\\anaconda\\python.exe tmp_verify/verify_search.py
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
from urllib.parse import quote

import pymysql

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXE = os.path.join(ROOT, "target", "release", "bin", "main.exe")
ENV_FILE = r"d:\project\ITN-full\src\agents\.env"

CJ = r"D:\software\cangjie\sdk-1.2.0\cangjie"
ANACONDA_LIB = r"D:\anaconda\Library\bin"
PREFERRED_PORT = 18875

RESULTS = []
LOG = None


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


def http_req(port, method, path, headers=None, timeout=30):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request(method, path, headers=headers or {})
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


def main():
    global LOG
    procs = []
    LOG = open(os.path.join(HERE, "verify_search.log"), "w", encoding="utf-8")
    suffix = uuid.uuid4().hex[:6].upper()
    db = None
    try:
        if not os.path.exists(EXE):
            print("main.exe 缺失")
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
        db = pymysql.connect(host=host, port=int(port), user=user, password=pwd,
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

        # ---------------- 隔离数据 ----------------
        uid = uuid.uuid4()
        token = sign_jwt(sec, str(uid))
        H = {"Authorization": "Bearer " + token}
        cur = db.cursor()
        cur.execute(
            "INSERT INTO users(id,email,password_hash,nickname,active,account_type,"
            "organization_id,admin_scope,created_at,updated_at) VALUES("
            + unhexv(uid) + ",%s,'x','搜索验证',1,'LEARNER',NULL,NULL,NOW(6),NOW(6))",
            ("sr-%s@example.test" % suffix,))
        cur.execute(
            "INSERT INTO user_sessions(token_hash,user_id,created_at,expires_at,"
            "revoked_at,ip_address,user_agent) VALUES(%s," + unhexv(uid) +
            ",NOW(6),DATE_ADD(NOW(6), INTERVAL 2 HOUR),NULL,NULL,'verify-search')",
            (hashlib.sha256(token.encode()).hexdigest(),))

        domain_id = None
        created_domain = False
        cur.execute("SELECT id FROM knowledge_domain ORDER BY id LIMIT 1")
        row = cur.fetchone()
        if row:
            domain_id = row["id"]
        else:
            cur.execute(
                "INSERT INTO knowledge_domain(code,name,status,created_at,updated_at)"
                " VALUES(%s,'搜索验证域',1,NOW(6),NOW(6))", ("SR-%s" % suffix,))
            domain_id = cur.lastrowid
            created_domain = True

        def add_point(code, name, desc, topics, sort_order, status=1):
            cur.execute(
                "INSERT INTO knowledge_point(code,name,description,core_topics_json,"
                "sort_order,status,domain_id) VALUES(%s,%s,%s,%s,%s,%s,%s)",
                (code, name, desc, topics, sort_order, status, domain_id))

        def add_category(node_code, name, full_path, status=1, level=1):
            cur.execute(
                "INSERT INTO knowledge_category(domain_id,node_code,name,full_path,level,"
                "node_type,description,sort_order,status) VALUES(%s,%s,%s,%s,%s,'category',%s,0,%s)",
                (domain_id, node_code, name, full_path, level, "分类说明 " + name, status))

        # 一批用于命中的知识点（sort_order 故意乱序，验证排序）
        add_point("KP-%s-C" % suffix, "排序-%s-第三" % suffix,
                  "desc three", '["alpha"]', 30)
        add_point("KP-%s-A" % suffix, "排序-%s-第一" % suffix,
                  "desc one", '["alpha"]', 10)
        add_point("KP-%s-B" % suffix, "排序-%s-第二" % suffix,
                  "desc two", '["alpha"]', 20)
        # 只靠 code 命中
        add_point("HIDDEN-%s" % suffix, "无关标题", None, None, 40)
        # 只靠 description 命中
        add_point("KP-%s-D" % suffix, "第四", "含关键词%s的说明" % suffix, None, 50)
        # 只靠 core_topics_json 命中
        add_point("KP-%s-E" % suffix, "第五", None, '["TOPIC%s"]' % suffix, 60)
        # status=0 必须被排除
        add_point("KP-%s-OFF" % suffix, "禁用 %s" % suffix, None, None, 70, status=0)

        add_category("CAT-%s-1" % suffix, "分类名%s" % suffix, "root/分类名%s" % suffix)
        add_category("CAT-%s-2" % suffix, "二级", "root/BY%s" % suffix)
        add_category("CAT-%s-OFF" % suffix, "禁用分类%s" % suffix, None, status=0)

        # 20 条上限：25 个命中点
        for i in range(25):
            add_point("CAP%s-%02d" % (suffix, i), "上限%s-%02d" % (suffix, i),
                      None, None, 100 + i)
        # 混合：19 个点 + 2 个分类
        for i in range(19):
            add_point("MIX%s-%02d" % (suffix, i), "混合%s-%02d" % (suffix, i),
                      None, None, 200 + i)
        add_category("MIXC-%s-1" % suffix, "混合分类%s-1" % suffix, "root/MIX%s-1" % suffix)
        add_category("MIXC-%s-2" % suffix, "混合分类%s-2" % suffix, "root/MIX%s-2" % suffix)

        def req(path, headers):
            st, hh, b = http_req(spire_port, "GET", path, headers)
            return st, jbody(b), b

        def items_of(j):
            d = (j or {}).get("data") or {}
            return d.get("items") or []

        # ---------------- A 基础 ----------------
        st, j, b = req("/api/v1/search?q=x", None)
        mark("A1", "未登录 -> 401", st == 401, "status=%d" % st)

        st, j, b = req("/api/v1/search", H)
        mark("A2", "缺省 q -> 200 total=0 items=[]",
             st == 200 and j.get("code") == 0
             and j.get("data") == {"total": 0, "items": []},
             "status=%d body=%r" % (st, b[:160]))

        st, j, b = req("/api/v1/search?q=%20%20%20", H)
        mark("A3", "纯空白 q 视为空", st == 200 and j.get("data") == {"total": 0, "items": []},
             "body=%r" % b[:120])

        # ---------------- B 知识点命中 ----------------
        st, j, b = req("/api/v1/search?q=" + quote(("排序-" + suffix).lower()), H)
        d = j.get("data") or {}
        mark("B1", "知识点按 sortOrder ASC 返回 3 条", d.get("total") == 3
             and [x["title"] for x in items_of(j)] ==
             ["排序-%s-第一" % suffix, "排序-%s-第二" % suffix, "排序-%s-第三" % suffix],
             "data=%r" % (d,))
        first = (items_of(j) or [{}])[0]
        mark("B2", "类型/id/title/excerpt/url 形状",
             list(first.keys()) == ["type", "id", "title", "excerpt", "url"]
             and first["type"] == "knowledge"
             and first["id"] == "KP-%s-A" % suffix
             and first["url"] == "/learn/KP-%s-A" % suffix
             and first["excerpt"] == "desc one", "first=%r" % (first,))

        st, j, b = req("/api/v1/search?q=HIDDEN-%s" % suffix, H)
        its = items_of(j)
        mark("B3", "只命中 code（标题无关）", len(its) == 1 and its[0]["id"] == "HIDDEN-%s" % suffix,
             "items=%r" % (its,))

        st, j, b = req("/api/v1/search?q=%E5%90%AB%E5%85%B3%E9%94%AE%E8%AF%8D" + suffix, H)
        its = items_of(j)
        mark("B4", "只命中 description",
             len(its) == 1 and its[0]["id"] == "KP-%s-D" % suffix, "items=%r" % (its,))

        st, j, b = req("/api/v1/search?q=TOPIC%s" % suffix, H)
        its = items_of(j)
        mark("B5", "只命中 core_topics_json",
             len(its) == 1 and its[0]["id"] == "KP-%s-E" % suffix, "items=%r" % (its,))

        st, j, b = req("/api/v1/search?q=KP-%s-OFF" % suffix, H)
        its = items_of(j)
        mark("B6", "禁用知识点（status=0）被排除", len(its) == 0, "items=%r" % (its,))

        st, j, b = req("/api/v1/search?q=hidden-%s" % suffix, H)
        mark("B7", "大小写不敏感（小写 q 命中大写 code）", len(items_of(j)) == 1,
             "items=%r" % (items_of(j),))

        # ---------------- C 分类命中 ----------------
        st, j, b = req("/api/v1/search?q=%E5%88%86%E7%B1%BB%E5%90%8D" + suffix, H)
        its = items_of(j)
        mark("C1", "分类按 name 命中 -> type=category，id 为数字字符串，url=/knowledge",
             len(its) == 1 and its[0]["type"] == "category"
             and its[0]["id"].isdigit()
             and its[0]["url"] == "/knowledge"
             and its[0]["excerpt"] == "分类说明 分类名%s" % suffix,
             "items=%r" % (its,))

        st, j, b = req("/api/v1/search?q=BY%s" % suffix, H)
        its = items_of(j)
        mark("C2", "分类按 full_path 命中", len(its) == 1
             and its[0]["title"] == "二级", "items=%r" % (its,))

        st, j, b = req("/api/v1/search?q=%E7%A6%81%E7%94%A8%E5%88%86%E7%B1%BB" + suffix, H)
        its = items_of(j)
        mark("C3", "status!=1 的分类被排除", len(its) == 0, "items=%r" % (its,))

        # ---------------- D 上限与顺序 ----------------
        st, j, b = req("/api/v1/search?q=CAP%s" % suffix, H)
        d = j.get("data") or {}
        mark("D1", "知识点段满 20 条即停（25 个命中只回 20）",
             d.get("total") == 20 and len(items_of(j)) == 20
             and all(x["type"] == "knowledge" for x in items_of(j)), "total=%r" % d.get("total"))

        st, j, b = req("/api/v1/search?q=MIX%s" % suffix, H)
        d = j.get("data") or {}
        its = items_of(j)
        mark("D2", "19 个知识点 + 1 个分类 = 20，知识点在前",
             d.get("total") == 20 and len(its) == 20
             and sum(1 for x in its if x["type"] == "knowledge") == 19
             and its[-1]["type"] == "category", "items=%r" % (its,))

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
            if db is not None:
                cur = db.cursor()
                cur.execute("DELETE FROM knowledge_point WHERE code LIKE %s", ("%%%s%%" % suffix,))
                cur.execute("DELETE FROM knowledge_category WHERE node_code LIKE %s",
                            ("%%%s%%" % suffix,))
                if created_domain:
                    cur.execute("DELETE FROM knowledge_domain WHERE code=%s",
                                ("SR-%s" % suffix,))
                db.close()
        except Exception as exc:  # noqa: BLE001
            logline("cleanup failed: %r" % (exc,))
        if LOG:
            LOG.close()


if __name__ == "__main__":
    sys.exit(main())
