# -*- coding: utf-8 -*-
"""
知识库读侧隔离验证（KnowledgeController 4 个端点）。

  GET /api/v1/knowledge/articles          列表
  GET /api/v1/knowledge/articles/{id}     正文
  GET /api/v1/knowledge/categories        分类聚合
  GET /api/v1/knowledge/assets/{assetId}  静态资产

做法与 verify_f2_admin_resources.py 相同：
  - 从 src/agents/.env 就地读取 JWT_SECRET / PLATFORM_DB_URL（只打印是否设置/长度）；
  - 起 main.exe，独立机构 + ADMIN 账号 + 会话，隔离知识源/文章/资产；
  - 跑断言并输出 m/n；结束时清掉自己造的数据与临时资产目录。

用法： D:\\anaconda\\python.exe tmp_verify/verify_knowledge.py
"""

import base64
import hashlib
import hmac
import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid

import pymysql

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXE = os.path.join(ROOT, "target", "release", "bin", "main.exe")
ENV_FILE = r"d:\project\ITN-full\src\agents\.env"

CJ = r"D:\software\cangjie\sdk-1.2.0\cangjie"
ANACONDA_LIB = r"D:\anaconda\Library\bin"

PREFERRED_PORT = 18871

RESULTS = []
LOG = None
DB = None
DBCFG = {}


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


def build_env(secrets, spire_port, asset_dir):
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
    env["KNOWLEDGE_ASSET_DIR"] = asset_dir
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


def unhex(hexs):
    return "UNHEX('%s')" % hexs


def unhexv(raw):
    return "UNHEX('%s')" % raw.hex


def insert_user(cur, uid, email, account_type, org_id):
    cur.execute(
        "INSERT INTO users(id,email,password_hash,nickname,active,account_type,"
        "organization_id,admin_scope,created_at,updated_at) VALUES("
        + unhexv(uid) + ",%s,'x',NULL,1,%s," +
        ("%s" if org_id else "NULL") +
        ",NULL,NOW(6),NOW(6))",
        tuple([email, account_type] + ([org_id.bytes] if org_id else [])))


def insert_session(cur, uid, token):
    cur.execute(
        "INSERT INTO user_sessions(token_hash,user_id,created_at,expires_at,"
        "revoked_at,ip_address,user_agent) VALUES(%s," + unhexv(uid) +
        ",NOW(6),DATE_ADD(NOW(6), INTERVAL 2 HOUR),NULL,NULL,'verify-knowledge')",
        (sha256_hex(token.encode("utf-8")),))


def insert_source(cur, src_id, name):
    cur.execute(
        "INSERT INTO knowledge_sources(id,name,description,created_at,updated_at)"
        " VALUES(%s,%s,NULL,NOW(6),NOW(6))", (src_id, name))


def insert_article(cur, aid, src_id, slug, title, category, subcategory, source_path,
                   excerpt, markdown, plain_text, status, image_count=0, word_count=10):
    cur.execute(
        "INSERT INTO knowledge_articles(id,source_id,slug,title,category,subcategory,"
        "source_path,content_hash,excerpt,markdown,plain_text,image_count,word_count,"
        "status,published_at,created_at,updated_at) VALUES("
        + unhexv(aid) + ",%s,%s,%s,%s," +
        ("%s" if subcategory is not None else "NULL") +
        ",%s,%s,%s,%s,%s,%s,%s,%s,NOW(6),NOW(6),NOW(6))",
        tuple([src_id, slug, title, category] +
              ([subcategory] if subcategory is not None else []) +
              [source_path, "a" * 64, excerpt, markdown, plain_text,
               image_count, word_count, status]))


def insert_asset(cur, asset_id, file_name, ext, mime, size_bytes, storage_path):
    cur.execute(
        "INSERT INTO knowledge_assets(id,file_name,extension,mime_type,size_bytes,"
        "width,height,storage_path,source_url,created_at,updated_at) VALUES("
        "%s,%s,%s,%s,%s,NULL,NULL,%s,NULL,NOW(6),NOW(6))",
        (asset_id, file_name, ext, mime, size_bytes, storage_path))


ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


def main():
    global LOG, DB, DBCFG
    procs = []
    LOG = open(os.path.join(HERE, "verify_knowledge.log"), "w", encoding="utf-8")
    hms = time.strftime("%H%M%S")
    suffix = uuid.uuid4().hex[:6]
    org_id = admin_id = None
    src_id = None
    asset_id = None
    evil_id = None
    asset_dir = tempfile.mkdtemp(prefix="spire_know_")
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

        spire_port = pick_port(PREFERRED_PORT)
        spire = subprocess.Popen([EXE], cwd=os.path.dirname(EXE),
                                 env=build_env(secrets, spire_port, asset_dir),
                                 stdout=LOG, stderr=LOG)
        procs.append(("main.exe", spire))
        if not wait_port(spire_port):
            print("Spire %d 未起来（检查 PATH/DLL）" % spire_port)
            return 2
        time.sleep(0.3)
        logline("spire pid=%s port=%d" % (spire.pid, spire_port))

        # ---------------- 造隔离数据 ----------------
        org_id = uuid.uuid4()
        admin_id = uuid.uuid4()
        admin_token = sign_jwt(sec, str(admin_id))
        admin_h = {"Authorization": "Bearer " + admin_token}
        src_id = "kn-%s-%s" % (hms, suffix)

        cur = DB.cursor()
        cur.execute(
            "INSERT INTO organizations(id,code,name,short_name,status,created_at,updated_at)"
            " VALUES(" + unhexv(org_id) + ",%s,%s,NULL,1,NOW(6),NOW(6))",
            ("kn-%s-%s" % (hms, suffix), "Knowledge验证机构" + suffix))
        insert_user(cur, admin_id, "kn-admin-%s-%s@example.test" % (hms, suffix),
                    "ADMIN", org_id)
        insert_session(cur, admin_id, admin_token)
        insert_source(cur, src_id, "知识源" + suffix)

        A = {}
        for key in ["a1", "a2", "a3", "a4", "adraft"]:
            A[key] = uuid.uuid4()
        uniq = "ZQKN%s" % suffix.upper()
        # a1: cs_learn + chapter1  —— sortOrder 1000 + 1
        insert_article(cur, A["a1"], src_id, "s1", "%s 第一章" % uniq, "cs_learn", "chapter1",
                       "src/01_intro.md", "摘要一 %s" % uniq,
                       "图片 ![x](knowledge-asset://%s)\n正文" % ("b" * 64),
                       "正文纯文本 %s" % uniq, "PUBLISHED")
        # a2: cs_learn 无 subcategory —— sortOrder 1000
        insert_article(cur, A["a2"], src_id, "s2", "%s 无子类" % uniq, "cs_learn", None,
                       "src/00_head.md", None, "md2", "plain2 %s" % uniq, "PUBLISHED")
        # a3: mysql + 01_base (前导数字下划线) —— sortOrder 2001
        insert_article(cur, A["a3"], src_id, "s3", "%s MySQL" % uniq, "mysql", "01_base",
                       "src/mysql/01_base.md", "摘要三", "md3", "plain3", "PUBLISHED")
        # a4: 未知 category（categoryDisplayName 回落 category，sortOrder 99900）
        insert_article(cur, A["a4"], src_id, "s4", "%s 未知类" % uniq, "zz_unknown", "01_x",
                       "src/zz/01_x.md", "摘要四", "md4", "plain4", "PUBLISHED")
        # adraft: 非 PUBLISHED，必须被过滤掉
        insert_article(cur, A["adraft"], src_id, "s5", "%s 草稿" % uniq, "cs_learn", "chapter2",
                       "src/02_draft.md", "摘要草稿", "md5", "plain5", "DRAFT")

        # asset：64 位小写 hex id，真实文件在 <asset_dir>/kb/f/<id>.png
        asset_id = hashlib.sha256(("asset-%s" % suffix).encode("utf-8")).hexdigest()
        rel_dir = os.path.join("kb", "f")
        os.makedirs(os.path.join(asset_dir, rel_dir), exist_ok=True)
        asset_bytes = b"\x89PNG\r\n\x1a\n" + ("KNOWLEDGE-ASSET-%s" % suffix).encode("ascii")
        asset_rel = "%s/%s.png" % (rel_dir.replace(os.sep, "/"), asset_id)
        with open(os.path.join(asset_dir, rel_dir, asset_id + ".png"), "wb") as fh:
            fh.write(asset_bytes)
        insert_asset(cur, asset_id, asset_id + ".png", "png", "image/png",
                     len(asset_bytes), asset_rel)
        # 目录穿越的 storage_path（必须 404）
        evil_id = hashlib.sha256(("evil-%s" % suffix).encode("utf-8")).hexdigest()
        insert_asset(cur, evil_id, "passwd", "txt", "text/plain", 10,
                     "../../../../../../etc/passwd")
        logline("seeded org=%s admin=%s src=%s asset=%s dir=%s"
                % (org_id, admin_id, src_id, asset_id, asset_dir))

        def req(method, path, headers=None, body=None):
            st, hh, b = http_req(spire_port, method, path, body, headers)
            return st, jbody(b), b, hh

        def data_of(j):
            return j.get("data") if isinstance(j, dict) else None

        # ---------------- A 鉴权 ----------------
        st, j, b, _ = req("GET", "/api/v1/knowledge/articles")
        mark("A1", "未登录 articles -> 401（已知 401 信封差异，与 admin_resources 一致）",
             st == 401 and isinstance(j, dict) and j.get("detail") == "Bearer token required",
             "status=%d body=%r" % (st, b[:120]))

        st, j, b, _ = req("GET", "/api/v1/knowledge/categories")
        mark("A2", "未登录 categories -> 401", st == 401, "status=%d" % st)

        # ---------------- B 列表 ----------------
        st, j, b, _ = req("GET", "/api/v1/knowledge/articles?sourceId=" + src_id, admin_h)
        d = data_of(j) or {}
        mark("B1", "articles 列表信封 code=0/data", st == 200 and isinstance(j, dict)
             and j.get("code") == 0 and j.get("message") == "success" and "timestamp" in j,
             "status=%d body=%r" % (st, b[:160]))
        mark("B2", "total 只算 PUBLISHED（草稿被过滤）",
             d.get("total") == 4 and d.get("page") == 0 and d.get("size") == 20,
             "data=%r" % (d,))
        items = d.get("items") or []
        mark("B3", "items 4 条且按 source_path ASC",
             [it.get("title") for it in items] == [
                 "%s 无子类" % uniq, "%s 第一章" % uniq, "%s MySQL" % uniq, "%s 未知类" % uniq],
             "titles=%r" % [it.get("title") for it in items])
        first = items[0] if items else {}
        mark("B4", "summary 字段齐 + 空 excerpt 为 null",
             set(first.keys()) == {"id", "sourceId", "sourceName", "slug", "title",
                                   "category", "subcategory", "excerpt", "imageCount",
                                   "wordCount", "updatedAt"} and first.get("excerpt") is None
             and first.get("subcategory") is None,
             "first=%r" % (first,))
        mark("B5", "sourceName 来自 knowledge_sources join",
             first.get("sourceName") == "知识源" + suffix, "sourceName=%r" % first.get("sourceName"))
        mark("B6", "updatedAt 是 ISO_INSTANT",
             bool(ISO_Z.match(str(first.get("updatedAt")))), "updatedAt=%r" % first.get("updatedAt"))

        st, j, _, _ = req("GET", "/api/v1/knowledge/articles?sourceId=" + src_id + "&page=1&size=2", admin_h)
        d = data_of(j) or {}
        mark("B7", "分页 page=1 size=2 -> 2 条 offset 生效",
             d.get("page") == 1 and d.get("size") == 2 and len(d.get("items") or []) == 2
             and (d.get("items") or [{}])[0].get("slug") == "s3", "data=%r" % (d,))

        st, j, _, _ = req("GET", "/api/v1/knowledge/articles?sourceId=" + src_id + "&size=999&page=-5", admin_h)
        d = data_of(j) or {}
        mark("B8", "size 上限 50 / page 下限 0",
             d.get("size") == 50 and d.get("page") == 0, "data=%r" % (d,))

        st, j, _, _ = req("GET", "/api/v1/knowledge/articles?sourceId=" + src_id + "&category=mysql", admin_h)
        d = data_of(j) or {}
        mark("B9", "category 过滤",
             d.get("total") == 1 and (d.get("items") or [{}])[0].get("slug") == "s3",
             "data=%r" % (d,))

        st, j, _, _ = req("GET", "/api/v1/knowledge/articles?sourceId=" + src_id + "&subcategory=chapter1", admin_h)
        d = data_of(j) or {}
        mark("B10", "subcategory 过滤", d.get("total") == 1
             and (d.get("items") or [{}])[0].get("slug") == "s1", "data=%r" % (d,))

        st, j, _, _ = req("GET", "/api/v1/knowledge/articles?search=" + uniq + "%20MySQL", admin_h)
        d = data_of(j) or {}
        mark("B11", "search 命中 title", d.get("total") == 1
             and (d.get("items") or [{}])[0].get("slug") == "s3", "data=%r" % (d,))

        st, j, _, _ = req("GET", "/api/v1/knowledge/articles?search=%E7%BA%AF%E6%96%87%E6%9C%AC%20" + uniq, admin_h)
        d = data_of(j) or {}
        mark("B12", "search 命中 plain_text", d.get("total") == 1
             and (d.get("items") or [{}])[0].get("slug") == "s1", "data=%r" % (d,))

        st, j, b, _ = req("GET", "/api/v1/knowledge/articles?page=abc", admin_h)
        mark("B13", "page 非整数 -> 400 code=1000 参数类型不正确",
             st == 400 and isinstance(j, dict) and j.get("code") == 1000
             and j.get("message") == "参数类型不正确：page",
             "status=%d body=%r" % (st, b[:160]))

        # ---------------- C 正文 ----------------
        st, j, b, _ = req("GET", "/api/v1/knowledge/articles/%s" % A["a1"], admin_h)
        d = data_of(j) or {}
        base = "http://127.0.0.1:%d" % spire_port
        mark("C1", "正文信封 + 字段齐",
             st == 200 and j.get("code") == 0 and set(d.keys()) == {
                 "id", "sourceId", "sourceName", "slug", "title", "category", "subcategory",
                 "excerpt", "markdown", "imageCount", "wordCount", "publishedAt", "updatedAt"},
             "status=%d keys=%r" % (st, sorted(d.keys())))
        mark("C2", "knowledge-asset:// 重写成 base+资产前缀",
             d.get("markdown") == "图片 ![x](%s/api/v1/knowledge/assets/%s)\n正文" % (base, "b" * 64),
             "markdown=%r" % d.get("markdown"))
        mark("C3", "publishedAt 非空且 ISO_INSTANT",
             bool(ISO_Z.match(str(d.get("publishedAt")))), "publishedAt=%r" % d.get("publishedAt"))

        st, j, b, _ = req("GET", "/api/v1/knowledge/articles/%s" % A["adraft"], admin_h)
        mark("C4", "草稿 id -> 404 code=4000",
             st == 404 and j.get("code") == 4000
             and j.get("message") == "Knowledge article not found",
             "status=%d body=%r" % (st, b[:160]))

        st, j, b, _ = req("GET", "/api/v1/knowledge/articles/not-a-uuid", admin_h)
        mark("C5", "非法 UUID -> 400 code=1000（Java 参数转换失败，不是 Python 422）",
             st == 400 and j.get("code") == 1000
             and j.get("message") == "参数类型不正确：articleId",
             "status=%d body=%r" % (st, b[:160]))

        st, j, _, _ = req("GET", "/api/v1/knowledge/articles/%s" % str(uuid.uuid4()), admin_h)
        mark("C6", "不存在的 UUID -> 404 code=4000", st == 404 and j.get("code") == 4000,
             "status=%d body=%r" % (st, j))

        # ---------------- D 分类聚合 ----------------
        st, j, b, _ = req("GET", "/api/v1/knowledge/categories", admin_h)
        d = data_of(j)
        arr = [x for x in (d or []) if x.get("sourceId") == src_id]
        mark("D1", "categories 是裸数组 + 信封", st == 200 and j.get("code") == 0
             and isinstance(d, list), "status=%d body=%r" % (st, b[:200]))
        mark("D2", "4 组（草稿不进聚合）", len(arr) == 4, "arr=%r" % (arr,))
        mark("D3", "顺序 = sortOrder,displayName（无子类 1000 排前）",
             [x.get("displayName") for x in arr] ==
             ["CS 导论", "第 1 章 · 初识智能体", "基础", "x"],
             "names=%r" % [x.get("displayName") for x in arr])
        mark("D4", "sortOrder 计算正确（cool 1000 / chapter 1001 / 01_base 2001 / 未知名 99901）",
             [x.get("sortOrder") for x in arr] == [1000, 1001, 2001, 99901],
             "sort=%r" % [x.get("sortOrder") for x in arr])
        mark("D5", "无子类行 displayName 回落 categoryDisplayName 且 subcategory=null",
             arr[0].get("categoryDisplayName") == "CS 导论"
             and arr[0].get("displayName") == "CS 导论"
             and arr[0].get("subcategory") is None,
             "row=%r" % (arr[0],))
        mark("D6", "未知 category 回落原文；非 chapter 命名剥离前导数字+下划线",
             arr[3].get("categoryDisplayName") == "zz_unknown"
             and arr[3].get("displayName") == "x"
             and arr[2].get("displayName") == "基础",
             "rows=%r" % (arr[2:],))
        mark("D7", "articleCount = PUBLISHED 计数且为数字", all(
             isinstance(x.get("articleCount"), int) for x in arr), "counts=%r" % [x.get("articleCount") for x in arr])

        # ---------------- E 资产 ----------------
        st, hh, b = http_req(spire_port, "GET", "/api/v1/knowledge/assets/%s" % asset_id)
        mark("E1", "资产 200 + 字节一致 + Content-Type",
             st == 200 and b == asset_bytes
             and (hh.get("content-type") or "").startswith("image/png"),
             "status=%d len=%d ct=%r" % (st, len(b), hh.get("content-type")))
        mark("E2", "ETag/Content-Length/Cache-Control",
             hh.get("etag") == '"%s"' % asset_id
             and hh.get("content-length") == str(len(asset_bytes))
             and hh.get("cache-control") == "max-age=31536000, public, immutable",
             "etag=%r len=%r cc=%r" % (hh.get("etag"), hh.get("content-length"),
                                       hh.get("cache-control")))
        st, hh, b = http_req(spire_port, "GET", "/api/v1/knowledge/assets/%s" % asset_id,
                             headers={"If-None-Match": '"%s"' % asset_id})
        mark("E3", "If-None-Match 命中 -> 304 空体",
             st == 304 and b == b"" and hh.get("etag") == '"%s"' % asset_id,
             "status=%d len=%d etag=%r" % (st, len(b), hh.get("etag")))
        st, hh, b = http_req(spire_port, "GET", "/api/v1/knowledge/assets/%s" % evil_id)
        j = jbody(b)
        mark("E4", "目录穿越 storage_path -> 404 code=4001",
             st == 404 and isinstance(j, dict) and j.get("code") == 4001,
             "status=%d body=%r" % (st, b[:160]))
        st, hh, b = http_req(spire_port, "GET", "/api/v1/knowledge/assets/ZZZZ")
        j = jbody(b)
        mark("E5", "非 64 位小写 hex 的 assetId -> 404 code=4001",
             st == 404 and isinstance(j, dict) and j.get("code") == 4001,
             "status=%d body=%r" % (st, b[:160]))
        st, hh, b = http_req(spire_port, "GET", "/api/v1/knowledge/assets/%s" % ("c" * 64))
        j = jbody(b)
        mark("E6", "不存在但格式合法的 assetId -> 404 code=4001",
             st == 404 and isinstance(j, dict) and j.get("code") == 4001,
             "status=%d body=%r" % (st, b[:160]))
        st, hh, b = http_req(spire_port, "GET", "/api/v1/knowledge/assets/%s" % asset_id,
                             headers={"If-None-Match": 'W/"other"'})
        mark("E7", "If-None-Match 不命中 -> 200 全量", st == 200 and b == asset_bytes,
             "status=%d len=%d" % (st, len(b)))

        passed = sum(1 for r in RESULTS if r[2])
        logline("\n==== %d/%d ====" % (passed, len(RESULTS)))
        return 0 if passed == len(RESULTS) else 1

    finally:
        for name, p in procs:
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass
        # 清掉隔离数据
        try:
            if DB is not None:
                cur = DB.cursor()
                if src_id:
                    cur.execute("DELETE FROM knowledge_articles WHERE source_id=%s", (src_id,))
                    cur.execute("DELETE FROM knowledge_sources WHERE id=%s", (src_id,))
                if asset_id:
                    cur.execute("DELETE FROM knowledge_assets WHERE id IN (%s,%s)",
                                (asset_id, evil_id))
                if admin_id:
                    cur.execute("DELETE FROM user_sessions WHERE user_id=" + unhexv(admin_id))
                    cur.execute("DELETE FROM users WHERE id=" + unhexv(admin_id))
                if org_id:
                    cur.execute("DELETE FROM organizations WHERE id=" + unhexv(org_id))
                DB.close()
        except Exception as exc:  # noqa: BLE001
            logline("cleanup failed: %r" % (exc,))
        shutil.rmtree(asset_dir, ignore_errors=True)
        if LOG:
            LOG.close()


if __name__ == "__main__":
    sys.exit(main())
