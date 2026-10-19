# -*- coding: utf-8 -*-
"""
E1 差分对照：真 Python agents-service(:8000) vs Spire（本地实现）。

为什么必须现在跑：一旦 Python 侧 public.py 的那条路由下线，就再也没有参照物了。
本脚本对同一份种子数据、同一批请求，先打 Python 再打 Spire，逐条比对
(status, body, 落库 scores_json)。

密钥：JWT_SECRET / PLATFORM_DB_URL 运行时从 src/agents/.env 就地解析，不打印、不落盘。

用法： D:\\anaconda\\python.exe tmp_verify/verify_e1_diff.py
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

PY_PORT = 8000
SPIRE_PREFERRED = 18831
BASELINE = '{"kp-old": 33}'

RESULTS = []


def rep(rid, label, same, dp, ds, extra=""):
    RESULTS.append((rid, label, same))
    line = "[%s] %-6s %s" % ("SAME" if same else "DIFF", rid, label)
    print(line)
    if not same:
        print("        python = %s" % (dp,))
        print("        spire  = %s" % (ds,))
    if extra:
        print("        " + extra)


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


def build_env(secrets, spire_port):
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
    env["SPIRE_AGENTS_URL"] = "http://127.0.0.1:1"
    env["SPIRE_SPRING_URL"] = "http://127.0.0.1:1"
    # 关键：上游指真 Python，未注册路由仍能转发（对照真实部署）
    env["AGENTS_UPSTREAM"] = "http://127.0.0.1:%d" % PY_PORT
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
    proc = None
    db = None
    user_ids = []
    spire_port = PREFERRED = SPIRE_PREFERRED

    try:
        secrets = load_env(ENV_FILE)
        sec = secrets.get("JWT_SECRET", "")
        url = secrets.get("PLATFORM_DB_URL", "")
        if not sec or not url:
            print("缺少 JWT_SECRET 或 PLATFORM_DB_URL")
            return 2

        host, port, user, pwd, dbname = parse_db(url)
        db = pymysql.connect(host=host, port=port, user=user, password=pwd,
                             database=dbname, charset="utf8mb4",
                             cursorclass=pymysql.cursors.DictCursor, autocommit=True)
        print("db=%s  python=%d" % (dbname, PY_PORT))

        if not wait_port(PY_PORT, timeout=3):
            print("Python agents(:%d) 未在跑 —— 差分需要一个活的参照物" % PY_PORT)
            return 2

        tag = "e1diff" + time.strftime("%H%M%S")
        u_a = uuid.uuid4()
        u_b = uuid.uuid4()
        u_none = uuid.uuid4()
        lid_a = uuid.uuid4()
        user_ids = [u_a.bytes, u_b.bytes, u_none.bytes]

        cur = db.cursor()
        for u in (u_a, u_b, u_none):
            cur.execute(
                "INSERT INTO users (id, email, password_hash, active, account_type, "
                "created_at, updated_at) VALUES (%s,%s,%s,1,'LEARNER',NOW(6),NOW(6))",
                (u.bytes, "%s-%s@e1.local" % (tag, u.hex[:8]), "x"))
        cur.execute(
            "INSERT INTO learners (id, user_id, code, name, scores_json, status, "
            "created_at, updated_at) VALUES (%s,%s,%s,%s,%s,1,NOW(6),NOW(6))",
            (lid_a.bytes, u_a.bytes, tag, "E1diff " + tag, BASELINE))

        spire_port = pick_port(SPIRE_PREFERRED)
        env = build_env(secrets, spire_port)
        logf = open(os.path.join(HERE, "verify_e1_diff_spire.log"), "w", encoding="utf-8")
        proc = subprocess.Popen([EXE], env=env, stdout=logf, stderr=subprocess.STDOUT,
                                cwd=ROOT)
        if not wait_port(spire_port):
            print("Spire 未起（看 verify_e1_diff_spire.log）")
            return 2
        print("spire=%d TAG=%s" % (spire_port, tag))

        tok_a = "Bearer " + sign_jwt(sec, str(u_a))
        tok_b = "Bearer " + sign_jwt(sec, str(u_b))
        tok_none = "Bearer " + sign_jwt(sec, str(u_none))

        def hdr(tok):
            return {"Authorization": tok, "Content-Type": "application/json"}

        def call(port_, tok, raw_body):
            return http_req(port_, "PUT", "/v1/learners/scores",
                            body=raw_body, headers=hdr(tok))

        def reset(uid):
            c = db.cursor()
            c.execute("UPDATE learners SET scores_json=%s WHERE user_id=%s",
                      (BASELINE, uid))

        def stored(uid):
            c = db.cursor()
            c.execute("SELECT scores_json FROM learners WHERE user_id=%s", (uid,))
            r = c.fetchone()
            return None if r is None else r["scores_json"]

        json_cases = [
            ("E1D-1", "合法", {"scores": {"kp-ds": 50}}, tok_a),
            ("E1D-2", "clamp 0..100", {"scores": {"kp-ds": 250, "kp-co": -5}}, tok_a),
            ("E1D-3", "key 顺序", {"scores": {"b": 1, "a": 2}}, tok_a),
            ("E1D-4", "true/\"60\" 强转", {"scores": {"kp-true": True, "kp-str": "60"}}, tok_a),
            ("E1D-5", "scores={}", {"scores": {}}, tok_a),
            ("E1D-6", "缺 scores", {}, tok_a),
            ("E1D-7", "scores 非对象", {"scores": [1, 2]}, tok_a),
            ("E1D-8", "\"abc\"", {"scores": {"kp-bad": "abc"}}, tok_a),
            ("E1D-9", "50.5", {"scores": {"kp-f": 50.5}}, tok_a),
            ("E1D-10", "多坏值", {"scores": {"kp-1": "x", "kp-2": None}}, tok_a),
            ("E1D-11", "null 值", {"scores": {"kp-n": None}}, tok_a),
            ("E1D-12", "无 learner 用户", {"scores": {"kp-ds": 10}}, tok_none),
            ("E1D-13", "B 用户（无 learner）", {"scores": {"kp-x": 1}}, tok_b),
        ]
        raw_cases = [
            ("E1D-14", "空 body", b""),
            ("E1D-15", "坏 JSON", b"{not json"),
            ("E1D-16", "body 数组", b"[1,2]"),
            ("E1D-17", "body null", b"null"),
            ("E1D-18", "整数值字符串全量", b'{"scores": {"kp-a": "7"}}'),
            ("E1D-19", "空对象以外的对象", b'{"other": 1}'),
        ]

        for rid, label, obj, tok in json_cases:
            raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            reset(u_a.bytes)
            stp, rp = call(PY_PORT, tok, raw)
            sp = stored(u_a.bytes)
            reset(u_a.bytes)
            sts, rs = call(spire_port, tok, raw)
            ss = stored(u_a.bytes)
            dp = (stp, jbody(rp))
            ds = (sts, jbody(rs))
            same = (dp == ds) and (sp == ss)
            rep(rid, label, same, dp, ds, extra="store python=%r spire=%r" % (sp, ss))

        for rid, label, raw in raw_cases:
            reset(u_a.bytes)
            stp, rp = call(PY_PORT, "Bearer " + sign_jwt(sec, str(u_a)), raw)
            sp = stored(u_a.bytes)
            reset(u_a.bytes)
            sts, rs = call(spire_port, "Bearer " + sign_jwt(sec, str(u_a)), raw)
            ss = stored(u_a.bytes)
            dp = (stp, jbody(rp))
            ds = (sts, jbody(rs))
            rep(rid, label, (dp == ds) and (sp == ss), dp, ds,
                extra="store python=%r spire=%r" % (sp, ss))

        # 无鉴权
        stp, rp = http_req(PY_PORT, "PUT", "/v1/learners/scores", body=b'{"scores":{"a":1}}',
                           headers={"Content-Type": "application/json"})
        sts, rs = http_req(spire_port, "PUT", "/v1/learners/scores",
                           body=b'{"scores":{"a":1}}',
                           headers={"Content-Type": "application/json"})
        rep("E1D-20", "无 token", (stp, jbody(rp)) == (sts, jbody(rs)),
            (stp, jbody(rp)), (sts, jbody(rs)))

    finally:
        if proc:
            try:
                proc.kill()
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
        try:
            logf.close()
        except Exception:                # noqa: BLE001
            pass

    same = sum(1 for r in RESULTS if r[2])
    print("\n=== E1 差分 %d/%d 一致  db=%s python=%d spire=%d ===" %
          (same, len(RESULTS), dbname, PY_PORT, spire_port))
    return 0 if same == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
