# -*- coding: utf-8 -*-
"""
E2 / §17.4 步骤 2+3 实测：scores_json 单写入方、统一 clamp、原子合并。

覆盖：
  W4 PUT /v1/learners/scores
     - 合并写入（不再整列替换，保留他人键）
     - 拒绝非 kp- 键（422）
     - 拒绝越界 0-100（422）
  W6 POST /v1/learning-resources/{id}/ability-reward
     - clamp 统一为 0-100（旧 12-96 会得到 96）
     - 响应的 scores 是落库后的真实值
 并发：W4 与 W6 同时写，两个键都不丢（原子 JSON_SET）

用法： D:\\anaconda\\python.exe tmp_verify/verify_e2_scores.py
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

import pymysql

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXE = os.path.join(ROOT, "target", "release", "bin", "main.exe")
ENV_FILE = r"d:\project\ITN-full\src\agents\.env"

CJ = r"D:\software\cangjie\sdk-1.2.0\cangjie"
ANACONDA_LIB = r"D:\anaconda\Library\bin"

SPIRE_PORT = 18851
RESULTS = []


def mark(rid, label, ok, detail=""):
    RESULTS.append(ok)
    print("[%s] %-4s %s%s" % ("PASS" if ok else "FAIL", rid, label,
                              ("  :: " + detail) if detail else ""))


def http_req(port, method, path, body=None, headers=None, timeout=30):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        r = conn.getresponse()
        return r.status, r.read()
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
    seg = (b64url(json.dumps(header, separators=(",", ":")).encode()) + "." +
           b64url(json.dumps(payload, separators=(",", ":")).encode()))
    sig = hmac.new(secret.encode(), seg.encode(), hashlib.sha256).digest()
    return seg + "." + b64url(sig)


def jbody(raw):
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:                    # noqa: BLE001
        return None


def main():
    proc = None
    logf = None
    db = None
    u = uuid.uuid4()
    lid = uuid.uuid4()
    rid_high = uuid.uuid4()      # 高分资源（clamp 判别）
    rid_race = uuid.uuid4()      # 并发资源
    try:
        secrets = load_env(ENV_FILE)
        sec = secrets.get("JWT_SECRET", "")
        url = secrets.get("PLATFORM_DB_URL", "")
        if not sec or not url:
            print("缺少 JWT_SECRET / PLATFORM_DB_URL")
            return 2
        host, port, user, pwd, dbname = parse_db(url)
        db = pymysql.connect(host=host, port=port, user=user, password=pwd,
                             database=dbname, charset="utf8mb4", autocommit=True)
        cur = db.cursor()

        def uhex(x):
            return x.hex if hasattr(x, "hex") else x.replace("-", "")

        cur.execute("DELETE FROM learners WHERE id=UNHEX(%s)", (uhex(lid),))
        cur.execute("DELETE FROM users WHERE id=UNHEX(%s)", (uhex(u),))
        cur.execute(
            "INSERT INTO users (id,email,password_hash,active,account_type,created_at,updated_at) "
            "VALUES (UNHEX(%s),%s,'x',1,'LEARNER',NOW(6),NOW(6))",
            (uhex(u), "e2-%s@local" % u.hex[:8]))
        cur.execute(
            "INSERT INTO learners (id,user_id,code,name,scores_json,status,created_at,updated_at) "
            "VALUES (UNHEX(%s),UNHEX(%s),%s,%s,%s,1,NOW(6),NOW(6))",
            (uhex(lid), uhex(u), "e2-" + u.hex[:8], "E2", '{"kp-keep":42}'))

        def seed_resource(rid, kp):
            cur.execute(
                "INSERT INTO generated_learning_resources "
                "(id,user_id,resource_type,title,topic,content_json,sources_json,state_json,"
                "context_json,decision_json,kp_id,form,level,version,quiz_ids_json,kb_refs_json,"
                "is_public,resource_scope,review_status,learner_id,created_at,updated_at) "
                "VALUES (UNHEX(%s),UNHEX(%s),'lecture',%s,%s,'{}','[]',"
                "'{\"ability\": 0.0, \"mastery\": {}, \"answered\": []}','{}','{}',%s,"
                "'quiz','L1','1','[]','[]',0,'USER','PUBLISHED',UNHEX(%s),NOW(6),NOW(6))",
                (uhex(rid), uhex(u), "E2 " + kp, "E2 " + kp, kp, uhex(lid)))

        seed_resource(rid_high, "ch3-llm")
        seed_resource(rid_race, "ch3-llm")

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
        env["AGENTS_UPSTREAM"] = "http://127.0.0.1:1"
        env["JAVA_UPSTREAM"] = "http://127.0.0.1:1"
        env["JWT_SECRET"] = sec
        env["PLATFORM_DB_URL"] = url

        logf = open(os.path.join(HERE, "verify_e2_scores.log"), "w", encoding="utf-8")
        proc = subprocess.Popen([EXE], env=env, stdout=logf, stderr=subprocess.STDOUT, cwd=ROOT)
        if not wait_port(SPIRE_PORT):
            print("Spire 未起")
            return 2

        tok = "Bearer " + sign_jwt(sec, str(u))
        H = {"Authorization": tok, "Content-Type": "application/json"}

        def scores():
            cur2 = db.cursor()
            cur2.execute("SELECT scores_json FROM learners WHERE id=UNHEX(%s)", (uhex(lid),))
            return json.loads(cur2.fetchone()[0] or "{}")

        def put(payload):
            st, raw = http_req(SPIRE_PORT, "PUT", "/v1/learners/scores",
                               json.dumps(payload).encode(), H)
            return st, jbody(raw)

        # E2-1 合并写入：保留 kp-keep
        st, body = put({"scores": {"kp-ds": 80}})
        s = scores()
        mark("E2-1", "W4 合并写入保留他人键",
             st == 200 and s.get("kp-keep") == 42 and s.get("kp-ds") == 80,
             "status=%d scores=%s" % (st, s))

        # E2-2 非 kp 键拒绝
        st, body = put({"scores": {"foo": 10}})
        s = scores()
        mark("E2-2", "W4 拒绝非知识点键 422",
             st == 422 and "value_error" in json.dumps(body, ensure_ascii=False)
             and s.get("kp-ds") == 80,
             "status=%d body=%s" % (st, str(body)[:120]))

        # E2-3 越界拒绝（>100）
        st, body = put({"scores": {"kp-ds": 101}})
        s = scores()
        mark("E2-3", "W4 拒绝 >100", st == 422 and s.get("kp-ds") == 80,
             "status=%d body=%s" % (st, str(body)[:100]))

        # E2-4 越界拒绝（<0）
        st, body = put({"scores": {"kp-ds": -1}})
        s = scores()
        mark("E2-4", "W4 拒绝 <0", st == 422 and s.get("kp-ds") == 80,
             "status=%d body=%s" % (st, str(body)[:100]))

        # E2-5 clamp 统一 0-100：kp-ds=97 + lecture 1.0 -> 98（旧 12-96 会是 96）
        cur.execute("UPDATE learners SET scores_json=%s WHERE id=UNHEX(%s)",
                    ('{"kp-ds": 97, "kp-co": 50}', uhex(lid)))
        st, raw = http_req(SPIRE_PORT, "POST",
                           "/v1/learning-resources/%s/ability-reward" % rid_high,
                           b"", {"Authorization": tok})
        body = jbody(raw)
        s = scores()
        mark("E2-5", "ability-reward clamp 统一 0-100（97+1=98）",
             st == 200 and s.get("kp-ds") == 98,
             "status=%d scores=%s resp=%s" % (st, s, str(body)[:100]))
        mark("E2-6", "响应 scores 为落库真实值",
             isinstance(body, dict) and body.get("scores", {}).get("kp-ds") == 98,
             str(body)[:120] if isinstance(body, dict) else str(body)[:120])

        # E2-7 并发：W4 写 kp-ds，W6 写 kp-ds/kp-co，kp-keep 与 kp-co 都不能丢
        cur.execute("UPDATE learners SET scores_json=%s WHERE id=UNHEX(%s)",
                    ('{"kp-keep": 7, "kp-ds": 10, "kp-co": 20}', uhex(lid)))

        def do_put():
            put({"scores": {"kp-ds": 30}})

        th = threading.Thread(target=do_put)
        th.start()
        http_req(SPIRE_PORT, "POST",
                 "/v1/learning-resources/%s/ability-reward" % rid_race,
                 b"", {"Authorization": tok})
        th.join()
        s = scores()
        mark("E2-7", "并发写不丢键（kp-keep / kp-co 仍在）",
             s.get("kp-keep") == 7 and "kp-co" in s and "kp-ds" in s,
             "scores=%s" % s)

    finally:
        try:
            if db:
                c = db.cursor()
                c.execute("DELETE FROM learning_resource_ability_rewards WHERE learner_id=UNHEX(%s)", (uhex(lid),))
                c.execute("DELETE FROM generated_learning_resources WHERE user_id=UNHEX(%s)", (uhex(u),))
                c.execute("DELETE FROM learners WHERE id=UNHEX(%s)", (uhex(lid),))
                c.execute("DELETE FROM users WHERE id=UNHEX(%s)", (uhex(u),))
                db.close()
        except Exception:                # noqa: BLE001
            pass
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
    print("\n=== E2 scores single-writer: %d/%d ===" % (ok, len(RESULTS)))
    return 0 if ok == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
