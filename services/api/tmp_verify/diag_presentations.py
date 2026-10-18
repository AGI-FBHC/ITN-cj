"""One-off probe for the three matrix outliers: list ETag, DELETE failed-status
task, GET .../slides when the pptx is missing. Seeds two rows only, cleans up.
"""
import os, sys, json, time, hmac, hashlib, base64, urllib.request, urllib.error
import pymysql

BASE = os.environ.get("VERIFY_BASE", "http://127.0.0.2:19406")
JWT_SECRET = os.environ["JWT_SECRET"]
DB = dict(
    host=os.environ.get("VERIFY_MYSQL_HOST", "43.160.236.121"),
    port=int(os.environ.get("VERIFY_MYSQL_PORT", "3306")),
    user=os.environ.get("VERIFY_MYSQL_USER", "root"),
    password=os.environ["VERIFY_MYSQL_PW"],
    database=os.environ.get("VERIFY_MYSQL_DB", "itn_cangjie_dev"),
    charset="utf8mb4",
)
TAG = "SPIREDIAG" + time.strftime("%H%M%S")
USER_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
P_FAIL = "aaaaaaaa-7201-4000-8000-000000000001"
P_NOUT = "aaaaaaaa-7202-4000-8000-000000000002"
P_PLAIN = "aaaaaaaa-7203-4000-8000-000000000003"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(sub: str) -> str:
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(json.dumps({"sub": sub, "exp": int(time.time()) + 3600},
                                separators=(",", ":")).encode())
    msg = f"{header}.{payload}".encode()
    sig = hmac.new(JWT_SECRET.encode(), msg, hashlib.sha256).digest()
    return f"{header}.{payload}.{b64url(sig)}"


def raw_req(method, path, token, body=None):
    url = BASE + path
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)
    except Exception as e:
        return None, str(e).encode(), {}


tok = make_jwt(USER_A)
conn = pymysql.connect(**DB)
conn.autocommit(True)
cur = conn.cursor()
NOW = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()) + ".123456"


def seed(pid, status, output_path):
    cur.execute(
        "INSERT INTO presentation_tasks(id,user_id,organization_id,resource_scope,"
        "is_public,title,status,progress,stage_message,error_message,request_json,"
        "learned_json,output_path,outline_json,events_json,created_at,updated_at,"
        "archived_at,checkpoint_stage,review_status,is_template,revision,resume_enabled) "
        "VALUES(UNHEX(%s),UNHEX(%s),NULL,'USER',0,%s,%s,100,'stage',NULL,"
        "CAST(%s AS JSON),CAST(%s AS JSON),%s,NULL,NULL,%s,%s,NULL,'ck','needs_review',0,1,1)",
        (pid.replace("-", ""), USER_A.replace("-", ""), f"{TAG} {pid}", status,
         '{"tag": "x"}', '{"learned": false}', output_path, NOW, NOW),
    )


try:
    seed(P_FAIL, "failed", "")
    seed(P_NOUT, "completed", "/nonexistent/definitely/missing.pptx")
    seed(P_PLAIN, "completed", "")

    print("== list ETag ==")
    st, body, hdr = raw_req("GET", "/v1/presentations?limit=5", tok)
    print("status", st, "etag", repr(hdr.get("ETag")), "hdr_keys", sorted(hdr.keys()))
    print("body", body[:120])

    print("== DELETE failed ==")
    st, body, hdr = raw_req("DELETE", f"/v1/presentations/{P_FAIL}", tok)
    print("status", st, "body", body[:200])
    cur.execute("SELECT COUNT(*) FROM presentation_tasks WHERE id=UNHEX(%s)", (P_FAIL.replace("-", ""),))
    print("row left:", cur.fetchone()[0])

    print("== GET slides missing pptx ==")
    st, body, hdr = raw_req("GET", f"/v1/presentations/{P_NOUT}/slides", tok)
    print("status", st, "body", body[:300], "hdr_keys", sorted(hdr.keys()))

    print("== GET slides/0 missing pptx ==")
    st, body, hdr = raw_req("GET", f"/v1/presentations/{P_NOUT}/slides/0", tok)
    print("status", st, "body", body[:300])

    print("== GET slides empty output_path ==")
    st, body, hdr = raw_req("GET", f"/v1/presentations/{P_PLAIN}/slides", tok)
    print("status", st, "body", body[:300])
finally:
    for pid in (P_FAIL, P_NOUT, P_PLAIN):
        cur.execute("DELETE FROM presentation_tasks WHERE id=UNHEX(%s)", (pid.replace("-", ""),))
    conn.commit()
    conn.close()
    print("cleanup done")
