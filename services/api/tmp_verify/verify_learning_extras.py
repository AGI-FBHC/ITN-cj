# -*- coding: utf-8 -*-
"""
/v1 纯数据库端点隔离验证。

  POST /v1/learning-resources/batch-delete
  GET  /v1/teaching-group/runs
  GET  /v1/teaching-group/runs/{run_id}

用法： D:\\anaconda\\python.exe tmp_verify/verify_learning_extras.py
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

import pymysql

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXE = os.path.join(ROOT, "target", "release", "bin", "main.exe")
ENV_FILE = r"d:\project\ITN-full\src\agents\.env"

CJ = r"D:\software\cangjie\sdk-1.2.0\cangjie"
ANACONDA_LIB = r"D:\anaconda\Library\bin"
PREFERRED_PORT = 18877

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


def main():
    global LOG
    procs = []
    LOG = open(os.path.join(HERE, "verify_learning_extras.log"), "w", encoding="utf-8")
    suffix = uuid.uuid4().hex[:6]
    db = None
    user_a = {}
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
        other_uid = uuid.uuid4()
        token = sign_jwt(sec, str(uid))
        other_token = sign_jwt(sec, str(other_uid))
        H = {"Authorization": "Bearer " + token}
        H2 = {"Authorization": "Bearer " + other_token}
        user_a["uid"] = uid
        user_a["other"] = other_uid
        cur = db.cursor()
        cur.execute(
            "INSERT INTO users(id,email,password_hash,nickname,active,account_type,"
            "organization_id,admin_scope,created_at,updated_at) VALUES("
            + unhexv(uid) + ",%s,'x','扩展验证',1,'LEARNER',NULL,NULL,NOW(6),NOW(6))",
            ("le-%s@example.test" % suffix,))
        cur.execute(
            "INSERT INTO users(id,email,password_hash,nickname,active,account_type,"
            "organization_id,admin_scope,created_at,updated_at) VALUES("
            + unhexv(other_uid) + ",%s,'x','他人',1,'LEARNER',NULL,NULL,NOW(6),NOW(6))",
            ("le-other-%s@example.test" % suffix,))

        def add_resource(rid, owner, title):
            cur.execute(
                "INSERT INTO generated_learning_resources(id,user_id,resource_type,title,"
                "topic,content_json,sources_json,created_at,updated_at) VALUES("
                + unhexv(rid) + "," + unhexv(owner) +
                ",'quiz',%s,'t','{}','[]','2026-02-01 10:00:00.123456',"
                "'2026-02-01 10:00:00.123456')", (title,))

        def add_message(mid, rid, owner):
            cur.execute(
                "INSERT INTO learning_resource_messages(id,resource_id,user_id,role,content,"
                "created_at) VALUES(" + unhexv(mid) + "," + unhexv(rid) + "," + unhexv(owner) +
                ",'user','hi','2026-02-01 10:00:00')")

        r1, r2, r3, r_other = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        add_resource(r1, uid, "资源1")
        add_resource(r2, uid, "资源2")
        add_resource(r3, uid, "资源3")
        add_resource(r_other, other_uid, "他人资源")
        m1, m2, m_other = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        add_message(m1, r1, uid)
        add_message(m2, r2, uid)
        add_message(m_other, r_other, other_uid)
        user_a["resources"] = [r1, r2, r3, r_other]
        user_a["messages"] = [m1, m2, m_other]

        def add_run(run_id, owner, learner, mode, status, events, result, err,
                    created, updated, kp=None, prompt=None):
            cur.execute(
                "INSERT INTO teaching_group_runs(id,user_id,learner_id,knowledge_point_id,"
                "mode,prompt,status,events_json,result_json,error_code,created_at,updated_at)"
                " VALUES(" + unhexv(run_id) + "," + unhexv(owner) + "," + unhexv(learner) +
                ",%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (kp, mode, prompt, status, json.dumps(events, ensure_ascii=False),
                 None if result is None else json.dumps(result, ensure_ascii=False),
                 err, created, updated))

        learner_id = uuid.uuid4()
        run1, run2, run3, run_other = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        add_run(run1, uid, learner_id, "diagnose", "completed",
                [{"type": "a"}, {"type": "run_completed"}],
                {"diagnosis": {"focus": "分数运算"},
                 "decision": {"nextAction": "练习 20 题"}},
                None, "2026-02-02 09:00:00.000000", "2026-02-02 09:30:00.500000",
                kp="kp-1-2", prompt="帮我看看")
        add_run(run2, uid, learner_id, "review", "failed", [{"type": "run_failed"}],
                None, "STREAM_INTERRUPTED",
                "2026-02-03 09:00:00.000000", "2026-02-03 09:10:00.000000")
        add_run(run3, uid, uuid.uuid4(), "diagnose", "running", [],
                None, None, "2026-02-01 09:00:00.000000", "2026-02-01 09:05:00.000000")
        add_run(run_other, other_uid, learner_id, "diagnose", "running", [], None, None,
                "2026-02-04 09:00:00.000000", "2026-02-04 09:05:00.000000")
        user_a["runs"] = [run1, run2, run3, run_other]

        def req(method, path, who=None, body=None, headers=None):
            hh = dict(H if who == "a" else H2 if who == "b" else {})
            if headers:
                hh.update(headers)
            if body is not None:
                hh["Content-Type"] = "application/json"
                body = json.dumps(body).encode("utf-8")
            st, rh, rb = http_req(spire_port, method, path, body, hh)
            return st, jbody(rb), rb

        # ---------------- A batch-delete ----------------
        st, j, b = req("POST", "/v1/learning-resources/batch-delete", None,
                       {"resourceIds": [str(r1)]})
        mark("A1", "未登录 -> 401", st == 401, "status=%d" % st)

        st, j, b = req("POST", "/v1/learning-resources/batch-delete", "a", {})
        mark("A2", "缺 resourceIds -> 422 detail",
             st == 422 and j.get("detail") == "resourceIds must contain 1 to 100 items",
             "status=%d body=%r" % (st, b[:160]))

        st, j, b = req("POST", "/v1/learning-resources/batch-delete", "a",
                       {"resourceIds": []})
        mark("A3", "空数组 -> 422 detail", st == 422
             and j.get("detail") == "resourceIds must contain 1 to 100 items",
             "status=%d" % st)

        st, j, b = req("POST", "/v1/learning-resources/batch-delete", "a",
                       {"resourceIds": [str(uuid.uuid4()) for _ in range(101)]})
        mark("A4", "101 项 -> 422 detail", st == 422
             and j.get("detail") == "resourceIds must contain 1 to 100 items",
             "status=%d" % st)

        st, j, b = req("POST", "/v1/learning-resources/batch-delete", "a",
                       {"resourceIds": ["abc"]})
        mark("A5", "非法 id -> 422「Invalid resource id」",
             st == 422 and j.get("detail") == "Invalid resource id",
             "status=%d body=%r" % (st, b[:120]))

        st, j, b = req("POST", "/v1/learning-resources/batch-delete", "a",
                       {"resourceIds": [str(r1), str(r1), str(r2), str(r_other)]})
        d = j or {}
        mark("A6", "只删自有资源，重复 id 折叠，他人资源保留",
             st == 200 and d.get("count") == 2
             and sorted(d.get("deleted") or []) == sorted([str(r1), str(r2)]),
             "status=%d body=%r" % (st, b[:220]))

        cur.execute("SELECT COUNT(*) c FROM generated_learning_resources WHERE id IN ("
                    + ",".join(unhexv(x) for x in [r1, r2, r3, r_other]) + ")")
        left = cur.fetchone()["c"]
        cur.execute("SELECT COUNT(*) c FROM learning_resource_messages WHERE id IN ("
                    + ",".join(unhexv(x) for x in [m1, m2, m_other]) + ")")
        msgs = cur.fetchone()["c"]
        mark("A7", "库内：r1/r2 已删、r3 与他人资源仍在、对应消息只删自己的",
             left == 2 and msgs == 1, "resources_left=%d messages_left=%d" % (left, msgs))

        st, j, b = req("POST", "/v1/learning-resources/batch-delete", "a",
                       {"resourceIds": [str(uuid.uuid4())]})
        mark("A8", "不存在的合法 id -> 200 count=0 deleted=[]",
             st == 200 and j.get("count") == 0 and j.get("deleted") == [],
             "body=%r" % b[:120])

        st, j, b = req("POST", "/v1/learning-resources/batch-delete", "a",
                       {"resourceIds": [str(r3)]})
        cur.execute("SELECT id FROM generated_learning_resources WHERE id=" + unhexv(r3))
        mark("A9", "自有单条删除生效", st == 200 and cur.fetchone() is None,
             "status=%d body=%r" % (st, b[:120]))

        # ---------------- B teaching-group runs 列表 ----------------
        st, j, b = req("GET", "/v1/teaching-group/runs", None)
        mark("B1", "未登录 -> 401", st == 401, "status=%d" % st)

        st, j, b = req("GET", "/v1/teaching-group/runs", "a")
        runs = (j or {}).get("runs") or []
        mark("B2", "列表信封 runs，按 updated_at DESC（3 条，不含他人）",
             st == 200 and list((j or {}).keys()) == ["runs"] and len(runs) == 3
             and [x["runId"] for x in runs] == [str(run2), str(run1), str(run3)],
             "runs=%r" % ([x["runId"] for x in runs],))
        first = next((x for x in runs if x["runId"] == str(run1)), {})
        mark("B3", "字段顺序与值（focus/nextAction/eventCount/errorCode）",
             list(first.keys()) == ["id", "runId", "learnerId", "knowledgePointId", "mode",
                                    "prompt", "status", "eventCount", "focus", "nextAction",
                                    "errorCode", "createdAt", "updatedAt"]
             and first.get("knowledgePointId") == "kp-1-2"
             and first.get("prompt") == "帮我看看"
             and first.get("eventCount") == 2
             and first.get("focus") == "分数运算"
             and first.get("nextAction") == "练习 20 题"
             and first.get("errorCode") is None
             and first.get("createdAt") == "2026-02-02T09:00:00"
             and first.get("updatedAt") == "2026-02-02T09:30:00.500000",
             "first=%r" % (first,))
        failed = next((x for x in runs if x["runId"] == str(run2)), {})
        mark("B4", "失败运行：errorCode 透出，focus/nextAction 回落空串",
             failed.get("errorCode") == "STREAM_INTERRUPTED"
             and failed.get("focus") == "" and failed.get("nextAction") == "",
             "run=%r" % (failed,))
        mark("B5", "列表不带 events/result", all(
            "events" not in x and "result" not in x for x in runs), "")

        st, j, b = req("GET", "/v1/teaching-group/runs?learnerId=%s" % str(learner_id).upper(), "a")
        runs = (j or {}).get("runs") or []
        mark("B6", "learnerId 过滤（大小写不敏感）",
             st == 200 and len(runs) == 2
             and all(x["learnerId"] == str(learner_id) for x in runs),
             "runs=%r" % ([x["runId"] for x in runs],))

        st, j, b = req("GET", "/v1/teaching-group/runs?limit=1", "a")
        mark("B7", "limit=1 只回 1 条", st == 200 and len((j or {}).get("runs") or []) == 1,
             "body=%r" % b[:120])

        # ---------------- C 参数校验 ----------------
        st, j, b = req("GET", "/v1/teaching-group/runs?limit=0", "a")
        mark("C1", "limit=0 -> 422 greater_than_equal",
             st == 422 and (j or {}).get("code") == "VALIDATION_FAILED"
             and j["details"][0]["type"] == "greater_than_equal"
             and j["details"][0]["loc"] == ["query", "limit"],
             "status=%d body=%r" % (st, b[:220]))

        st, j, b = req("GET", "/v1/teaching-group/runs?limit=101", "a")
        mark("C2", "limit=101 -> 422 less_than_equal",
             st == 422 and j["details"][0]["type"] == "less_than_equal",
             "status=%d body=%r" % (st, b[:200]))

        st, j, b = req("GET", "/v1/teaching-group/runs?limit=abc", "a")
        mark("C3", "limit 非整数 -> 422 int_parsing",
             st == 422 and j["details"][0]["type"] == "int_parsing",
             "status=%d body=%r" % (st, b[:200]))

        st, j, b = req("GET", "/v1/teaching-group/runs?learnerId=nope", "a")
        mark("C4", "learnerId 非 UUID -> 422 uuid_parsing",
             st == 422 and j["details"][0]["type"] == "uuid_parsing"
             and j["details"][0]["loc"] == ["query", "learnerId"],
             "status=%d body=%r" % (st, b[:220]))

        # ---------------- D 详情 ----------------
        st, j, b = req("GET", "/v1/teaching-group/runs/%s" % run1, "a")
        mark("D1", "详情裸对象含 events/result",
             st == 200 and list((j or {}).keys()) == [
                 "id", "runId", "learnerId", "knowledgePointId", "mode", "prompt",
                 "status", "eventCount", "focus", "nextAction", "errorCode",
                 "createdAt", "updatedAt", "events", "result"]
             and len(j.get("events") or []) == 2
             and (j.get("result") or {}).get("decision", {}).get("nextAction") == "练习 20 题",
             "body=%r" % b[:260])

        st, j, b = req("GET", "/v1/teaching-group/runs/%s" % run1, "b")
        mark("D2", "他人运行 -> 404 detail", st == 404
             and j.get("detail") == "Teaching group run not found",
             "status=%d body=%r" % (st, b[:140]))

        st, j, b = req("GET", "/v1/teaching-group/runs/not-a-uuid", "a")
        mark("D3", "非法 run id -> 422 uuid_parsing",
             st == 422 and j["details"][0]["type"] == "uuid_parsing"
             and j["details"][0]["loc"] == ["path", "run_id"],
             "status=%d body=%r" % (st, b[:220]))

        st, j, b = req("GET", "/v1/teaching-group/runs/%s" % uuid.uuid4(), "a")
        mark("D4", "不存在 -> 404 detail", st == 404 and j.get("detail") == "Teaching group run not found",
             "status=%d" % st)

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
                uids = [user_a.get("uid"), user_a.get("other")]
                uids = [x for x in uids if x]
                if uids:
                    in_list = ",".join(unhexv(x) for x in uids)
                    cur.execute("DELETE FROM learning_resource_messages WHERE user_id IN ("
                                + in_list + ")")
                    cur.execute("DELETE FROM generated_learning_resources WHERE user_id IN ("
                                + in_list + ")")
                    cur.execute("DELETE FROM teaching_group_runs WHERE user_id IN ("
                                + in_list + ")")
                    cur.execute("DELETE FROM users WHERE id IN (" + in_list + ")")
                db.close()
        except Exception as exc:  # noqa: BLE001
            logline("cleanup failed: %r" % (exc,))
        if LOG:
            LOG.close()


if __name__ == "__main__":
    sys.exit(main())
