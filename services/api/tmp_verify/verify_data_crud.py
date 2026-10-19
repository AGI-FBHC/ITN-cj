# -*- coding: utf-8 -*-
"""
第二批纯数据 CRUD 隔离验证（6 条）：

  GET  /v1/course-recommendations
  GET  /v1/learning-context
  GET  /v1/learning-resources/{id}/next-question
  GET  /api/v1/auth/me
  POST /api/v1/auth/logout
  POST /api/v1/auth/bind-identity

用法： D:\\anaconda\\python.exe tmp_verify/verify_data_crud.py
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
from urllib.parse import quote

import pymysql

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXE = os.path.join(ROOT, "target", "release", "bin", "main.exe")
ENV_FILE = r"d:\project\ITN-full\src\agents\.env"

CJ = r"D:\software\cangjie\sdk-1.2.0\cangjie"
ANACONDA_LIB = r"D:\anaconda\Library\bin"
PREFERRED_PORT = 18879

RESULTS = []
LOG = None


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


def sign_jwt(secret, sub, nonce=None):
    header = {"alg": "HS256", "typ": "JWT"}
    now = int(time.time())
    payload = {"sub": sub, "iat": now, "exp": now + 3600}
    if nonce:
        payload["jti"] = nonce
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


ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
ISO_OFFSET = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{6})?\+00:00$")


def main():
    global LOG
    procs = []
    LOG = open(os.path.join(HERE, "verify_data_crud.log"), "w", encoding="utf-8")
    suffix = uuid.uuid4().hex[:6]
    db = None
    created = {"users": [], "resources": [], "presentations": [], "goals": [],
               "mastery": [], "categories": [], "identities": []}
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

        cur = db.cursor()

        def add_user(email, account_type="LEARNER", active=1, nickname="数据验证"):
            uid = uuid.uuid4()
            cur.execute(
                "INSERT INTO users(id,email,password_hash,nickname,active,account_type,"
                "organization_id,admin_scope,created_at,updated_at) VALUES("
                + unhexv(uid) + ",%s,'x',%s,%s,%s,NULL,NULL,NOW(6),NOW(6))",
                (email, nickname, active, account_type))
            created["users"].append(uid)
            return uid

        def add_session(uid, token):
            cur.execute(
                "INSERT INTO user_sessions(token_hash,user_id,created_at,expires_at,"
                "revoked_at,ip_address,user_agent) VALUES(%s," + unhexv(uid) +
                ",NOW(6),DATE_ADD(NOW(6), INTERVAL 2 HOUR),NULL,NULL,'verify-data')",
                (hashlib.sha256(token.encode()).hexdigest(),))

        def add_resource(rid, owner, rtype, title, content, updated, course=None,
                         scope="USER", is_public=0, archived=False):
            cur.execute(
                "INSERT INTO generated_learning_resources(id,user_id,resource_type,title,"
                "topic,content_json,sources_json,resource_scope,is_public,course_id,"
                "archived_at,created_at,updated_at) VALUES("
                + unhexv(rid) + "," + unhexv(owner) + ",%s,%s,'t',%s,'[]',%s,%s," +
                ("%s" if course else "NULL") +
                "," + ("NOW(6)" if archived else "NULL") + ",%s,%s)",
                tuple([rtype, title, json.dumps(content, ensure_ascii=False), scope,
                       is_public] + ([course.bytes] if course else []) + [updated, updated]))
            created["resources"].append(rid)

        def add_presentation(pid, owner, title, status, updated):
            cur.execute(
                "INSERT INTO presentation_tasks(id,user_id,title,status,progress,"
                "stage_message,request_json,created_at,updated_at) VALUES("
                + unhexv(pid) + "," + unhexv(owner) +
                ",%s,%s,0,'x','{}',%s,%s)", (title, status, updated, updated))
            created["presentations"].append(pid)

        # ---------------- 账号 ----------------
        me_id = add_user("dc-me-%s@example.test" % suffix, nickname="我")
        other_id = add_user("dc-other-%s@example.test" % suffix, nickname="他人")
        blocked_id = add_user("dc-blocked-%s@example.test" % suffix, active=0)
        token = sign_jwt(sec, str(me_id))
        token2 = sign_jwt(sec, str(me_id), "second-" + suffix)
        other_token = sign_jwt(sec, str(other_id))
        blocked_token = sign_jwt(sec, str(blocked_id))
        add_session(me_id, token)
        add_session(me_id, token2)
        add_session(other_id, other_token)
        add_session(blocked_id, blocked_token)
        H = {"Authorization": "Bearer " + token}
        H2 = {"Authorization": "Bearer " + token2}
        HO = {"Authorization": "Bearer " + other_token}
        HB = {"Authorization": "Bearer " + blocked_token}

        def req(method, path, headers=None, body=None):
            hh = dict(headers or {})
            if body is not None:
                hh["Content-Type"] = "application/json"
                body = json.dumps(body).encode("utf-8")
            st, rh, rb = http_req(spire_port, method, path, body, hh)
            return st, jbody(rb), rb

        # ================= A /api/v1/auth/me =================
        st, j, b = req("GET", "/api/v1/auth/me")
        mark("A1", "未登录 /auth/me -> 401", st == 401, "status=%d" % st)

        st, j, b = req("GET", "/api/v1/auth/me", H)
        d = (j or {}).get("data") or {}
        mark("A2", "已登录 -> 200 code=0 + UserResponse 五字段",
             st == 200 and j.get("code") == 0
             and list(d.keys()) == ["id", "email", "nickname", "active", "createdAt"]
             and d.get("id") == str(me_id) and d.get("nickname") == "我"
             and d.get("active") is True
             and ISO_Z.match(str(d.get("createdAt"))) is not None,
             "status=%d data=%r" % (st, d))

        st, j, b = req("GET", "/api/v1/auth/me", HB)
        mark("A3", "停用账号的活会话 -> 401（requireUserApi 校验 active）", st == 401,
             "status=%d" % st)

        # ================= B /api/v1/auth/logout =================
        st, j, b = req("POST", "/api/v1/auth/logout", HO)
        mark("B1", "已登录 logout -> 200 message=退出登录成功 且无 data",
             st == 200 and j.get("code") == 0 and j.get("message") == "退出登录成功"
             and "data" not in j,
             "status=%d body=%r" % (st, b[:160]))

        cur.execute("SELECT revoked_at FROM user_sessions WHERE user_id=" + unhexv(other_id))
        row = cur.fetchone()
        mark("B2", "库内 revoked_at 已置", row is not None and row["revoked_at"] is not None,
             "row=%r" % (row,))

        st, j, b = req("POST", "/api/v1/auth/logout", HO)
        mark("B3", "同一 token 再注销 -> 401", st == 401, "status=%d" % st)

        cur.execute("SELECT COUNT(*) c FROM user_sessions WHERE user_id=" + unhexv(me_id)
                    + " AND revoked_at IS NULL")
        mark("B4", "只撤销当前会话（me 的两条仍有效）", cur.fetchone()["c"] == 2, "")

        # ================= C /api/v1/auth/bind-identity =================
        st, j, b = req("POST", "/api/v1/auth/bind-identity", None,
                       {"identityType": "PHONE", "identityValue": "13800000000"})
        mark("C1", "未登录 bind -> 401", st == 401, "status=%d" % st)

        phone = "138%08d" % (int(suffix, 16) % 100000000)
        st, j, b = req("POST", "/api/v1/auth/bind-identity", H,
                       {"identityType": "phone", "identityValue": "  %s  " % phone})
        d = (j or {}).get("data") or {}
        mark("C2", "绑定 PHONE -> 200，返回当前用户，类型已大写",
             st == 200 and j.get("code") == 0 and d.get("id") == str(me_id),
             "status=%d body=%r" % (st, b[:200]))

        cur.execute("SELECT identity_type,identity_value,identity_extra_json FROM user_identities"
                    " WHERE user_id=" + unhexv(me_id) + " ORDER BY created_at DESC LIMIT 1")
        row = cur.fetchone()
        created["identities"].append(phone)
        mark("C3", "落库 identity_type=PHONE、value 已 trim、extra 为 NULL",
             row is not None and row["identity_type"] == "PHONE"
             and row["identity_value"] == phone and row["identity_extra_json"] is None,
             "row=%r" % (row,))

        st, j, b = req("POST", "/api/v1/auth/bind-identity", H,
                       {"identityType": "WECHAT", "identityValue": "wx-%s" % suffix})
        cur.execute("SELECT COUNT(*) c FROM user_identities WHERE user_id=" + unhexv(me_id))
        mark("C4", "第二种身份可继续绑定", st == 200 and cur.fetchone()["c"] == 2,
             "status=%d" % st)

        st, j, b = req("POST", "/api/v1/auth/bind-identity", H,
                       {"identityType": "PHONE", "identityValue": phone})
        mark("C5", "重复绑定 -> 409/1001「该身份已绑定其他账号」",
             st == 409 and j.get("code") == 1001
             and j.get("message") == "该身份已绑定其他账号",
             "status=%d body=%r" % (st, b[:160]))

        st, j, b = req("POST", "/api/v1/auth/bind-identity", H,
                       {"identityType": "FOO", "identityValue": "x-%s" % suffix})
        mark("C6", "非法类型 -> 400/1000「身份类型不合法」",
             st == 400 and j.get("code") == 1000 and j.get("message") == "身份类型不合法",
             "status=%d body=%r" % (st, b[:160]))

        st, j, b = req("POST", "/api/v1/auth/bind-identity", H,
                       {"identityType": "   ", "identityValue": "v"})
        mark("C7", "空白 identityType -> 400 NotBlank",
             st == 400 and j.get("message") == "identityType: must not be blank",
             "status=%d body=%r" % (st, b[:160]))

        st, j, b = req("POST", "/api/v1/auth/bind-identity", H,
                       {"identityType": "A" * 33, "identityValue": "v"})
        mark("C8", "identityType 超 32 -> 400 size",
             st == 400 and j.get("message") == "identityType: size must be between 0 and 32",
             "status=%d body=%r" % (st, b[:160]))

        st, j, b = req("POST", "/api/v1/auth/bind-identity", H,
                       {"identityType": "PHONE", "identityValue": "v", "nickname": "n" * 65})
        mark("C9", "nickname 超 64 -> 400 size",
             st == 400 and j.get("message") == "nickname: size must be between 0 and 64",
             "status=%d body=%r" % (st, b[:160]))

        st, j, b = req("POST", "/api/v1/auth/bind-identity", H,
                       {"identityType": "DEMO", "identityValue": "d-%s" % suffix,
                        "organizationCode": "NO-SUCH-%s" % suffix})
        cur.execute("SELECT identity_extra_json FROM user_identities WHERE user_id="
                    + unhexv(me_id) + " AND identity_type='DEMO' LIMIT 1")
        row = cur.fetchone()
        mark("C10", "organizationCode 查不到时仍绑定成功且 extra 为 NULL",
             st == 200 and row is not None and row["identity_extra_json"] is None,
             "status=%d row=%r" % (st, row))

        st, j, b = req("POST", "/api/v1/auth/bind-identity", H, {"identityType": "PHONE"})
        mark("C11", "缺 identityValue -> 400 NotBlank",
             st == 400 and j.get("message") == "identityValue: must not be blank",
             "status=%d body=%r" % (st, b[:160]))

        # ================= D /v1/course-recommendations =================
        st, j, b = req("GET", "/v1/course-recommendations")
        mark("D1", "未登录 -> 401", st == 401, "status=%d" % st)

        course = uuid.uuid4()
        r1, r2, r_other, r_arch = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        p1, p_failed = uuid.uuid4(), uuid.uuid4()
        add_resource(r1, me_id, "lecture", "我的讲义", {}, "2037-03-01 10:00:00.000000",
                     course=course)
        add_resource(r2, me_id, "quiz", "我的题库", {}, "2037-03-03 10:00:00.000000",
                     course=None)
        add_resource(r_other, other_id, "practice", "他人实操", {}, "2037-03-04 10:00:00.000000")
        add_resource(r_arch, me_id, "lecture", "已归档", {}, "2037-03-05 10:00:00.000000",
                     archived=True)
        add_presentation(p1, me_id, "", "completed", "2037-03-02 10:00:00.000000")
        add_presentation(p_failed, me_id, "失败的PPT", "failed", "2037-03-06 10:00:00.000000")

        st, j, b = req("GET", "/v1/course-recommendations?limit=50", H)
        cands = (j or {}).get("candidates") or []
        ids = [c["id"] for c in cands]
        our_expected = [str(p1), str(r1)]
        ours = [x for x in our_expected if x in ids]
        mark("D2", "只含 course_id 非空的本人资源 + completed PPT；他人/归档/failed/无课程资源均不出现",
             st == 200 and ours == our_expected
             and str(r2) not in ids and str(r_other) not in ids
             and str(r_arch) not in ids and str(p_failed) not in ids,
             "ids=%r" % (ids,))
        mark("D3", "updatedAt 为 naive isoformat",
             [c["updatedAt"] for c in cands if c["id"] in ours] ==
             ["2037-03-02T10:00:00", "2037-03-01T10:00:00"],
             "values=%r" % [c["updatedAt"] for c in cands if c["id"] in ours])
        first = next((c for c in cands if c["id"] == str(p1)), {})
        mark("D4", "字段与顺序：type,id,title,courseId,chapterId,updatedAt",
             list(first.keys()) == ["type", "id", "title", "courseId", "chapterId", "updatedAt"]
             and first.get("type") == "ppt" and first.get("courseId") is None,
             "first=%r" % (first,))
        ppt = next((c for c in cands if c["id"] == str(p1)), {})
        mark("D5", "空标题 PPT 回落「最近的 PPT」", ppt.get("title") == "最近的 PPT",
             "ppt=%r" % (ppt,))
        lecture = next((c for c in cands if c["id"] == str(r1)), {})
        mark("D6", "courseId 透出", lecture.get("courseId") == str(course),
             "lecture=%r" % (lecture,))

        st, j, b = req("GET", "/v1/course-recommendations?limit=1", H)
        mark("D7", "limit=1 只回 1 条", st == 200 and len((j or {}).get("candidates") or []) == 1,
             "body=%r" % b[:120])
        st, j, b = req("GET", "/v1/course-recommendations?limit=0", H)
        mark("D8", "limit=0 -> 422 greater_than_equal",
             st == 422 and j["details"][0]["type"] == "greater_than_equal"
             and j["details"][0]["loc"] == ["query", "limit"], "status=%d" % st)
        st, j, b = req("GET", "/v1/course-recommendations?limit=51", H)
        mark("D9", "limit=51 -> 422 less_than_equal",
             st == 422 and j["details"][0]["type"] == "less_than_equal", "status=%d" % st)

        # ---------------- E /v1/learning-context ----------------
        st, j, b = req("GET", "/v1/learning-context")
        mark("E1", "未登录 -> 401", st == 401, "status=%d" % st)

        st, j, b = req("GET", "/v1/learning-context", H)
        d = j or {}
        mark("E2", "顶层键与 generatedAt 形态",
             st == 200 and list(d.keys()) == ["generatedAt", "mode", "goal", "profile",
                                             "mastery", "knowledgeCoverage", "recommendation"]
             and d.get("mode") == "goal_driven"
             and ISO_OFFSET.match(str(d.get("generatedAt"))) is not None,
             "keys=%r gen=%r" % (list(d.keys()), d.get("generatedAt")))
        mark("E3", "无画像/无目标 -> inferred 默认目标 + profile 全 null",
             d["goal"]["inferred"] is True and d["goal"]["id"] is None
             and d["goal"]["status"] == "ACTIVE"
             and d["profile"] == {"educationLevel": None, "major": None,
                                  "technicalFoundation": None, "learningPreference": None},
             "goal=%r profile=%r" % (d.get("goal"), d.get("profile")))
        mark("E4", "无证据 -> mastery.overall=0(int)、cold_start、推荐走冷启动",
             d["mastery"]["overall"] == 0 and d["mastery"]["items"] == []
             and d["mastery"]["evidenceLevel"] == "cold_start"
             and d["recommendation"]["reason"] ==
             "当前缺少足够的作答证据，先通过讲义与短测完成能力冷启动。",
             "mastery=%r rec=%r" % (d.get("mastery"), d.get("recommendation")))
        cov = d["knowledgeCoverage"]
        mark("E5", "knowledgeCoverage 结构（agent 域，计数为非负整数且层级自洽）",
             cov["domainCode"] == "agent" and cov["domainName"] == "智能体"
             and cov["status"] in ("partial", "complete")
             and isinstance(cov["knowledgePointCount"], int)
             and isinstance(cov["coveredKnowledgePointCount"], int)
             and isinstance(cov["coveredCategoryCount"], int)
             and 0 <= cov["coveredKnowledgePointCount"] <= cov["knowledgePointCount"]
             and cov["coveredKnowledgePointCount"] <= cov["coveredCategoryCount"],
             "coverage=%r" % (cov,))

        # 企业用户：画像 + 目标 + 掌握度
        cur.execute("SELECT id FROM knowledge_domain ORDER BY id LIMIT 1")
        row = cur.fetchone()
        if row:
            domain_id = row["id"]
        else:
            cur.execute("INSERT INTO knowledge_domain(code,name,status,created_at,updated_at)"
                        " VALUES(%s,'数据验证域',1,NOW(6),NOW(6))", ("DC-%s" % suffix,))
            domain_id = cur.lastrowid
        cur.execute(
            "INSERT INTO knowledge_category(domain_id,node_code,name,level,node_type,"
            "status,sort_order,created_at,updated_at) VALUES(%s,%s,%s,3,'kp',1,0,NOW(6),NOW(6))",
            (domain_id, "dc-%s" % suffix, "薄弱知识点%s" % suffix))
        cat_id = cur.lastrowid
        created["categories"].append(cat_id)

        cur.execute(
            "INSERT INTO user_profiles(user_id,education_level,major,technical_foundation,"
            "learning_preference,current_goal_id,created_at,updated_at) VALUES("
            + unhexv(me_id) + ",'BACHELOR','计算机','BASIC','PRACTICE_DRIVEN',NULL,NOW(6),NOW(6))")
        goal = uuid.uuid4()
        cur.execute(
            "INSERT INTO learning_goals(id,user_id,goal_type,title,description,expected_level,"
            "initial_level,assessment_method,target_date,status,created_at,updated_at) VALUES("
            + unhexv(goal) + "," + unhexv(me_id) +
            ",'SKILL_IMPROVEMENT','智能体进阶','desc','INTERMEDIATE','BEGINNER',"
            "'DIAGNOSTIC_TEST','2026-12-31','ACTIVE',NOW(6),NOW(6))")
        created["goals"].append(goal)
        mid = uuid.uuid4()
        cur.execute(
            "INSERT INTO knowledge_mastery(id,user_id,knowledge_category_id,mastery_score,"
            "attempt_count,correct_count,updated_at) VALUES("
            + unhexv(mid) + "," + unhexv(me_id) + ",%s,0.2000,3,0,NOW(6))", (cat_id,))
        created["mastery"].append(mid)
        cur.execute("UPDATE user_profiles SET current_goal_id=" + unhexv(goal)
                    + " WHERE user_id=" + unhexv(me_id))

        st, j, b = req("GET", "/v1/learning-context", H)
        d = j or {}
        mark("E6", "有目标 -> inferred=false、targetDate 只到日、expectedLevel 透出",
             d["goal"]["inferred"] is False and d["goal"]["id"] == str(goal)
             and d["goal"]["targetDate"] == "2026-12-31"
             and d["goal"]["expectedLevel"] == "INTERMEDIATE",
             "goal=%r" % (d.get("goal"),))
        mark("E7", "画像字段透出", d["profile"]["educationLevel"] == "BACHELOR"
             and d["profile"]["learningPreference"] == "PRACTICE_DRIVEN",
             "profile=%r" % (d.get("profile"),))
        items = d["mastery"]["items"]
        mark("E8", "mastery 项字段与数值",
             len(items) == 1 and items[0]["categoryId"] == cat_id
             and items[0]["name"] == "薄弱知识点%s" % suffix
             and items[0]["path"] == "" and items[0]["score"] == 0.2
             and items[0]["attempts"] == 3
             and d["mastery"]["overall"] == 0.2
             and d["mastery"]["evidenceLevel"] == "observed",
             "mastery=%r" % (d.get("mastery"),))
        rec = d["recommendation"]
        mark("E9", "有证据 -> 选最薄弱项，0.2 -> foundation/lecture/9/20",
             rec["topic"] == "薄弱知识点%s" % suffix
             and rec["ability"] == 0.2 and rec["difficulty"] == "foundation"
             and rec["nextResourceType"] == "lecture" and rec["questionCount"] == 9
             and rec["ppt"]["slideCount"] == 20 and rec["detailLevel"] == "detailed"
             and rec["reason"] == "该知识点当前掌握度约 20%，低于目标水平。",
             "rec=%r" % (rec,))

        st, j, b = req("GET", "/v1/learning-context?learning_goal_id=nope", H)
        mark("E10", "learning_goal_id 非法 -> 422 uuid_parsing",
             st == 422 and j["details"][0]["type"] == "uuid_parsing"
             and j["details"][0]["loc"] == ["query", "learning_goal_id"], "status=%d" % st)

        st, j, b = req("GET", "/v1/learning-context?learning_goal_id=%s" % str(goal).upper(), H)
        mark("E11", "显式 learning_goal_id 生效（大小写不敏感）",
             st == 200 and (j or {}).get("goal", {}).get("id") == str(goal), "status=%d" % st)

        # ================= F next-question =================
        quiz_id = uuid.uuid4()
        questions = [
            {"id": "q1", "stem": "easy-1", "options": ["a", "b"], "correctIndex": 0,
             "explanation": "e1", "difficulty": "easy", "knowledgePointId": "kp-a",
             "knowledgePointName": "点A"},
            {"id": "q2", "stem": "medium-1", "options": ["a", "b"], "correctIndex": 1,
             "explanation": "e2", "difficulty": "medium", "knowledgePointId": "kp-b",
             "knowledgePointName": "点B"},
            {"id": "q3", "stem": "hard-1", "options": ["a", "b"], "correctIndex": 1,
             "explanation": "e3", "difficulty": "hard", "knowledgePointId": "kp-c",
             "knowledgePointName": "点C"},
            {"id": "q4", "stem": "easy-2", "options": ["a", "b"], "correctIndex": 1,
             "explanation": "e4", "difficulty": "easy", "knowledgePointId": "kp-d",
             "knowledgePointName": "点D"},
        ]
        add_resource(quiz_id, me_id, "quiz", "自适应测验",
                     {"questions": questions}, "2026-03-07 10:00:00.000000")
        lecture_id = uuid.uuid4()
        add_resource(lecture_id, me_id, "lecture", "讲义", {"sections": []},
                     "2026-03-07 11:00:00.000000")
        other_quiz = uuid.uuid4()
        add_resource(other_quiz, other_id, "quiz", "他人测验", {"questions": questions},
                     "2026-03-07 12:00:00.000000")

        st, j, b = req("GET", "/v1/learning-resources/%s/next-question" % quiz_id)
        mark("F1", "未登录 -> 401", st == 401, "status=%d" % st)

        st, j, b = req("GET", "/v1/learning-resources/%s/next-question" % lecture_id, H)
        mark("F2", "非 quiz -> 404「Quiz not found」",
             st == 404 and (j or {}).get("detail") == "Quiz not found", "status=%d" % st)

        st, j, b = req("GET", "/v1/learning-resources/%s/next-question" % other_quiz, H)
        mark("F3", "他人 quiz -> 404", st == 404, "status=%d" % st)

        st, j, b = req("GET", "/v1/learning-resources/%s/next-question" % quiz_id, H)
        d = j or {}
        q = d.get("question") or {}
        mark("F4", "无 state -> ability=.35 选 easy，completed=false",
             st == 200 and d.get("completed") is False and q.get("id") == "q1"
             and d.get("state") == {},
             "body=%r" % b[:220])
        mark("F5", "题面剔除 correctIndex / explanation，保留 options 与 kp 字段",
             "correctIndex" not in q and "explanation" not in q
             and q.get("options") == ["a", "b"] and q.get("knowledgePointId") == "kp-a",
             "q=%r" % (q,))

        # state：ability=0.35 时 mastery 决定两题 easy 的先后
        cur.execute("UPDATE generated_learning_resources SET state_json=%s WHERE id="
                    + unhexv(quiz_id),
                    (json.dumps({"ability": 0.35, "mastery": {"kp-a": 0.6, "kp-d": 0.2}}),))
        st, j, b = req("GET", "/v1/learning-resources/%s/next-question" % quiz_id, H)
        q = (j or {}).get("question") or {}
        mark("F6", "两题同级 easy -> mastery 更低者优先（kp-d）", q.get("id") == "q4",
             "q=%r" % (q,))

        cur.execute("UPDATE generated_learning_resources SET state_json=%s WHERE id="
                    + unhexv(quiz_id),
                    (json.dumps({"ability": 0.35, "answered": [
                        {"questionId": "q1"}, {"questionId": "q2"},
                        {"questionId": "q3"}, {"questionId": "q4"}]}),))
        st, j, b = req("GET", "/v1/learning-resources/%s/next-question" % quiz_id, H)
        d = j or {}
        mark("F7", "全部答完 -> completed=true, question=null",
             d.get("completed") is True and d.get("question") is None
             and d.get("state", {}).get("ability") == 0.35,
             "body=%r" % b[:200])

        st, j, b = req("GET", "/v1/learning-resources/not-a-uuid/next-question", H)
        mark("F8", "非法 UUID -> 422 uuid_parsing",
             st == 422 and j["details"][0]["type"] == "uuid_parsing"
             and j["details"][0]["loc"] == ["path", "resource_id"], "status=%d" % st)

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
                uids = created["users"]
                if uids:
                    in_list = ",".join(unhexv(x) for x in uids)
                    cur.execute("DELETE FROM user_identities WHERE user_id IN (" + in_list + ")")
                    cur.execute("DELETE FROM knowledge_mastery WHERE user_id IN (" + in_list + ")")
                    cur.execute("DELETE FROM learning_goals WHERE user_id IN (" + in_list + ")")
                    cur.execute("DELETE FROM user_profiles WHERE user_id IN (" + in_list + ")")
                    cur.execute("DELETE FROM generated_learning_resources WHERE user_id IN ("
                                + in_list + ")")
                    cur.execute("DELETE FROM presentation_tasks WHERE user_id IN (" + in_list + ")")
                    cur.execute("DELETE FROM user_sessions WHERE user_id IN (" + in_list + ")")
                    cur.execute("DELETE FROM users WHERE id IN (" + in_list + ")")
                if created["categories"]:
                    cur.execute("DELETE FROM knowledge_category WHERE id IN ("
                                + ",".join(str(x) for x in created["categories"]) + ")")
                db.close()
        except Exception as exc:  # noqa: BLE001
            logline("cleanup failed: %r" % (exc,))
        if LOG:
            LOG.close()


if __name__ == "__main__":
    sys.exit(main())
