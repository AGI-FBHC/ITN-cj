"""Distinguish getRaw-None vs store.delete-None for DELETE on a failed-status
task: GET the same row first, then DELETE, then run the exact probe SQL
verbatim through pymysql."""
import os, json, time, hmac, hashlib, base64, urllib.request, urllib.error
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
USER_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
P_FAIL = "aaaaaaaa-7401-4000-8000-000000000001"
TAG = "SPIREDIAG3" + time.strftime("%H%M%S")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(sub: str) -> str:
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(json.dumps({"sub": sub, "exp": int(time.time()) + 3600},
                                separators=(",", ":")).encode())
    msg = f"{header}.{payload}".encode()
    sig = hmac.new(JWT_SECRET.encode(), msg, hashlib.sha256).digest()
    return f"{header}.{payload}.{b64url(sig)}"


def req(method, path, token, timeout=25):
    r = urllib.request.Request(BASE + path, method=method)
    r.add_header("Authorization", f"Bearer {token}")
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read(), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.read(), time.time() - t0
    except Exception as e:
        return None, str(e).encode(), time.time() - t0


tok = make_jwt(USER_A)
conn = pymysql.connect(**DB)
conn.autocommit(True)
cur = conn.cursor()
NOW = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()) + ".123456"

try:
    cur.execute(
        "INSERT INTO presentation_tasks(id,user_id,organization_id,resource_scope,"
        "is_public,title,status,progress,stage_message,error_message,request_json,"
        "learned_json,output_path,outline_json,events_json,created_at,updated_at,"
        "archived_at,checkpoint_stage,review_status,is_template,revision,resume_enabled) "
        "VALUES(UNHEX(%s),UNHEX(%s),NULL,'USER',0,%s,'failed',100,'stage',NULL,"
        "CAST('{}' AS JSON),CAST('{}' AS JSON),'',NULL,NULL,%s,%s,NULL,'ck','needs_review',0,1,1)",
        (P_FAIL.replace("-", ""), USER_A.replace("-", ""), TAG, NOW, NOW),
    )

    print("-- raw row --")
    cur.execute(
        "SELECT HEX(id), HEX(user_id), resource_scope, is_public, status, archived_at, "
        "is_template, revision FROM presentation_tasks WHERE id=UNHEX(%s)",
        (P_FAIL.replace("-", ""),))
    print(cur.fetchall())

    print("-- visibility SQL (owner branch, exactly as Spire builds it) --")
    cur.execute(
        "SELECT HEX(id) FROM presentation_tasks WHERE id=UNHEX(%s) "
        "AND archived_at IS NULL AND ((user_id=UNHEX(%s) AND resource_scope IN ('USER','ORGANIZATION')) "
        "OR (resource_scope='USER' AND is_public=1) "
        "OR (resource_scope='ORGANIZATION' AND organization_id=(SELECT organization_id FROM users WHERE HEX(id)=%s)))",
        (P_FAIL.replace("-", ""), USER_A.replace("-", ""), USER_A.upper()))
    print("rows:", cur.fetchall())

    print("-- delete probe SQL (verbatim) --")
    cur.execute(
        "SELECT output_path FROM presentation_tasks WHERE id=UNHEX(%s) AND user_id=UNHEX(%s) "
        "AND status IN ('completed','failed','cancelled')",
        (P_FAIL.replace("-", ""), USER_A.replace("-", "")))
    print("rows:", cur.fetchall())

    st, body, dt = req("GET", f"/v1/presentations/{P_FAIL}", tok)
    print(f"GET single -> {st} ({dt:.2f}s) {body[:200]!r}")

    st, body, dt = req("DELETE", f"/v1/presentations/{P_FAIL}", tok)
    print(f"DELETE -> {st} ({dt:.2f}s) {body[:200]!r}")

    cur.execute("SELECT COUNT(*) FROM presentation_tasks WHERE id=UNHEX(%s)",
                (P_FAIL.replace("-", ""),))
    print("row left:", cur.fetchone()[0])
finally:
    cur.execute("DELETE FROM presentation_tasks WHERE id=UNHEX(%s)",
                (P_FAIL.replace("-", ""),))
    conn.commit()
    conn.close()
    print("cleanup done")
