"""Pin down the GET .../slides hang: timing, repeatability, and whether the
server stays responsive afterwards."""
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
TAG = "SPIREDIAG2" + time.strftime("%H%M%S")
USER_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
P_NOUT = "aaaaaaaa-7301-4000-8000-000000000001"
P_PLAIN = "aaaaaaaa-7302-4000-8000-000000000002"
P_WINPATH = "aaaaaaaa-7303-4000-8000-000000000003"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(sub: str) -> str:
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(json.dumps({"sub": sub, "exp": int(time.time()) + 3600},
                                separators=(",", ":")).encode())
    msg = f"{header}.{payload}".encode()
    sig = hmac.new(JWT_SECRET.encode(), msg, hashlib.sha256).digest()
    return f"{header}.{payload}.{b64url(sig)}"


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


def timed(label, path, timeout=8):
    url = BASE + path
    r = urllib.request.Request(url, method="GET")
    r.add_header("Authorization", f"Bearer {tok}")
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            body = resp.read()
            st, info = resp.status, body[:120]
    except urllib.error.HTTPError as e:
        st, info = e.code, e.read()[:120]
    except Exception as e:
        st, info = None, f"{type(e).__name__}: {e}"
    print(f"{(time.time() - t0):6.2f}s | {label:38} -> {st} {info!r}", flush=True)
    return st


try:
    seed(P_NOUT, "completed", "/nonexistent/definitely/missing.pptx")
    seed(P_PLAIN, "completed", "")
    seed(P_WINPATH, "completed", "C:/definitely/not/here/x.pptx")

    timed("warm list", "/v1/presentations?limit=2")
    timed("NOUT /slides/0", f"/v1/presentations/{P_NOUT}/slides/0")
    timed("NOUT /slides (1st)", f"/v1/presentations/{P_NOUT}/slides")
    timed("NOUT /slides (2nd)", f"/v1/presentations/{P_NOUT}/slides")
    timed("PLAIN /slides", f"/v1/presentations/{P_PLAIN}/slides")
    timed("WINPATH /slides", f"/v1/presentations/{P_WINPATH}/slides")
    timed("NOUT /slides (3rd)", f"/v1/presentations/{P_NOUT}/slides")
    timed("list still alive", "/v1/presentations?limit=2")
finally:
    for pid in (P_NOUT, P_PLAIN, P_WINPATH):
        cur.execute("DELETE FROM presentation_tasks WHERE id=UNHEX(%s)", (pid.replace("-", ""),))
    conn.commit()
    conn.close()
    print("cleanup done")
