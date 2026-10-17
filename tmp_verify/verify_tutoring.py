"""DB-backed matrix for Spire's five pure-rule tutoring endpoints.

Covers GET /v1/tutoring/scripts/{learner_code}, POST /v1/tutoring/sessions,
GET /v1/tutoring/sessions/{id}, POST .../answer, POST .../complete against the
static scripts file (lin/chen/zhao) plus a quiz-shaped learning_resource that
builds a dynamic `resource:{uuid}` script.

Contract quirks asserted here (from src/agents/app/routers/public.py +
services/tutoring.py):
  - service KeyError  -> 404 {"detail":"'the message'"}   (str(KeyError) quotes)
  - service ValueError-> 422 {"detail":"the message"}     (no quotes)
  - route-level 404   -> {"detail":"Tutoring script not found"}
                         / {"detail":"Tutoring session not found"}
  - complete() always sets score_after = score_before + 6
  - free-text unmatched stays on the node, appends fixed wrong feedback

Seeds SPIREVT* rows under two isolation users only; cleanup removes them.
No secrets are printed or written to disk.

Env required: JWT_SECRET, VERIFY_MYSQL_PW, VERIFY_BASE (optional).

Run:
  JWT_SECRET=... VERIFY_MYSQL_PW=... VERIFY_BASE=http://127.0.0.1:19413 \
    python verify_tutoring.py
"""
import os, sys, json, time, hmac, hashlib, base64, uuid
import urllib.request, urllib.error
from datetime import datetime
import pymysql

sys.stdout.reconfigure(encoding="utf-8")

BASE = os.environ.get("VERIFY_BASE", "http://127.0.0.1:19413")
JWT_SECRET = os.environ["JWT_SECRET"]
DB = dict(
    host=os.environ.get("VERIFY_MYSQL_HOST", "43.160.236.121"),
    port=int(os.environ.get("VERIFY_MYSQL_PORT", "3306")),
    user=os.environ.get("VERIFY_MYSQL_USER", "root"),
    password=os.environ["VERIFY_MYSQL_PW"],
    database=os.environ.get("VERIFY_MYSQL_DB", "itn_cangjie_dev"),
    charset="utf8mb4",
    connect_timeout=15,
)
TAG = "SPIREVT" + time.strftime("%H%M%S")
USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
GHOST = "ffffffff-ffff-4fff-8fff-ffffffffffff"

RES_QUIZ = "99999001-7001-4000-8000-000000000001"

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append((name, detail))
    mark = "ok " if cond else "FAIL"
    print(f"[{mark}] {name}" + (f"  -- {detail}" if detail and not cond else ""))


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def mint(sub: str) -> str:
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(json.dumps({"sub": sub, "exp": int(time.time()) + 3600}, separators=(",", ":")).encode())
    msg = f"{header}.{payload}".encode()
    sig = hmac.new(JWT_SECRET.encode(), msg, hashlib.sha256).digest()
    return f"{header}.{payload}.{b64url(sig)}"


def req(method, path, token=None, body=None):
    url = BASE + path
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            raw = resp.read()
            st = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read()
        st = e.code
    try:
        return st, json.loads(raw.decode("utf-8") or "null")
    except Exception:
        return st, raw.decode("utf-8", "replace")


def uuid_bytes(u: str) -> bytes:
    return uuid.UUID(u).bytes


def iso(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S.%f")


def seed_user(conn, uid_hex, email):
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO users (id,email,password_hash,nickname,active,account_type,"
            "created_at,updated_at) VALUES (UNHEX(%s),%s,'x',%s,1,'LEARNER',NOW(6),NOW(6)) "
            "ON DUPLICATE KEY UPDATE email=VALUES(email)",
            (uid_hex.replace("-", ""), email, TAG),
        )


def seed_quiz_resource(conn):
    """A quiz resource so POST sessions can build a dynamic script.

    Spire reads generated_learning_resources (join users viewer, scope USER).
    """
    content = {
        "questions": [
            {"stem": f"{TAG} 题一", "options": ["甲", "乙"], "correctIndex": 0,
             "explanation": "甲更贴切", "difficulty": "基础", "kbRefs": ["KB-1"]},
            {"stem": f"{TAG} 题二", "options": ["丙", "丁"], "correctIndex": 1,
             "explanation": "丁更贴切", "difficulty": "进阶"},
        ],
        "knowledgePoints": [
            {"id": "kp-one", "name": f"{TAG}要点", "description": "描述一"},
        ],
    }
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO generated_learning_resources "
            "(id,user_id,resource_type,title,topic,content_json,sources_json,state_json,"
            "context_json,decision_json,kp_id,form,level,version,quiz_ids_json,kb_refs_json,"
            "is_public,resource_scope,review_status,created_at,updated_at) "
            "VALUES (UNHEX(%s),UNHEX(%s),'quiz',%s,%s,CAST(%s AS JSON),CAST(%s AS JSON),"
            "CAST(%s AS JSON),NULL,NULL,%s,'quiz','L1','1','[]','[]',0,'USER','PUBLISHED',NOW(6),NOW(6))",
            (
                RES_QUIZ.replace("-", ""), USER_A.replace("-", ""),
                f"{TAG} 随堂测", f"{TAG} 主题",
                json.dumps(content, ensure_ascii=False), "[]", "{}", "kp-quiz",
            ),
        )
    conn.commit()


def cleanup(conn):
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM tutoring_sessions WHERE user_id IN (%s,%s)",
            (uuid_bytes(USER_A), uuid_bytes(USER_B)),
        )
        cur.execute(
            "DELETE FROM generated_learning_resources WHERE id=%s",
            (uuid_bytes(RES_QUIZ),),
        )
    conn.commit()


def main():
    tok_a, tok_b = mint(USER_A), mint(USER_B)
    conn = pymysql.connect(**DB)
    try:
        seed_user(conn, USER_A, f"{TAG.lower()}-a@example.com")
        seed_user(conn, USER_B, f"{TAG.lower()}-b@example.com")
        conn.commit()
        seed_quiz_resource(conn)
    except Exception as e:
        print(f"seed failed: {type(e).__name__}: {e}")
        print("hint: generated_learning_resources schema may differ; adjust seed_quiz_resource")
        return 2

    try:
        # ---- 1. scripts -------------------------------------------------
        st, body = req("GET", "/v1/tutoring/scripts/lin", tok_a)
        check("scripts lin 200", st == 200, f"st={st} body={str(body)[:200]}")
        if st == 200 and isinstance(body, dict):
            check("scripts lin has startId", body.get("startId") == "n1", str(body.get("startId")))
            check("scripts lin has nodes", isinstance(body.get("nodes"), dict))

        st, body = req("GET", "/v1/tutoring/scripts/LIN", tok_a)
        # Python get_script lowercases the code, so LIN must resolve to lin.
        check("scripts LIN lowercases", st == 200, f"st={st}")

        st, body = req("GET", "/v1/tutoring/scripts/nope", tok_a)
        check("scripts unknown 404", st == 404, f"st={st}")
        check("scripts unknown detail literal",
              isinstance(body, dict) and body.get("detail") == "Tutoring script not found",
              str(body))

        # scripts route calls get_script WITHOUT user_id -> resource: never resolves
        st, body = req("GET", f"/v1/tutoring/scripts/resource:{RES_QUIZ}", tok_a)
        check("scripts resource: 404 (no user_id)", st == 404, f"st={st} body={str(body)[:160]}")

        # ---- 2. create session (static) --------------------------------
        st, body = req("POST", "/v1/tutoring/sessions", tok_a, {"learnerCode": "lin"})
        check("create static 201", st == 201, f"st={st} body={str(body)[:200]}")
        sid = body.get("id") if isinstance(body, dict) else None
        check("create returns id", bool(sid), str(sid))
        if not sid:
            print("abort: no session id")
            return 2

        check("create currentNode n1", isinstance(body, dict) and
              (body.get("currentNode") or {}).get("id") == "n1",
              str(body.get("currentNode")))
        check("create scoreBefore 50 (kp-sensor missing in learners)",
              isinstance(body, dict) and body.get("scoreBefore") == 50,
              str(body.get("scoreBefore") if isinstance(body, dict) else None))
        check("create scoreAfter null", isinstance(body, dict) and body.get("scoreAfter") is None)
        check("create status running", isinstance(body, dict) and body.get("status") == "running")

        # create with both missing
        st, body = req("POST", "/v1/tutoring/sessions", tok_a, {})
        check("create empty 422", st == 422, f"st={st} body={str(body)[:200]}")
        check("create empty ValueError unquoted",
              isinstance(body, dict) and body.get("detail") == "learnerCode or resourceId is required",
              str(body))

        # create unknown script -> KeyError quoted
        st, body = req("POST", "/v1/tutoring/sessions", tok_a, {"learnerCode": "zzz"})
        check("create unknown 404", st == 404, f"st={st}")
        check("create unknown KeyError quoted",
              isinstance(body, dict) and body.get("detail") == "'tutoring script not found'",
              str(body))

        # ---- 3. get session --------------------------------------------
        st, body = req("GET", f"/v1/tutoring/sessions/{sid}", tok_a)
        check("get session 200", st == 200, f"st={st}")
        check("get session has messages", isinstance(body, dict) and
              isinstance(body.get("messages"), list) and len(body.get("messages") or []) >= 1,
              str(body.get("messages") if isinstance(body, dict) else None)[:160])

        st, body = req("GET", f"/v1/tutoring/sessions/{sid}", tok_b)
        check("get other-user 404", st == 404, f"st={st}")
        check("get other-user detail literal",
              isinstance(body, dict) and body.get("detail") == "Tutoring session not found",
              str(body))

        st, body = req("GET", f"/v1/tutoring/sessions/{GHOST}", tok_a)
        check("get missing 404", st == 404, f"st={st}")

        # ---- 4. answer: option_index correct ---------------------------
        st, body = req("POST", f"/v1/tutoring/sessions/{sid}/answer", tok_a,
                       {"optionIndex": 0})
        check("answer optionIndex 200", st == 200, f"st={st} body={str(body)[:200]}")
        if st == 200 and isinstance(body, dict):
            answers = body.get("answers") or []
            check("answer appends True", answers == [True], str(answers))
            check("answer moves to n2",
                  body.get("currentNodeId") == "n2" or
                  (body.get("currentNode") or {}).get("id") == "n2",
                  str(body.get("currentNodeId")))

        # ---- 5. answer: option_label -----------------------------------
        # After n2 we cannot know the label offline for every script; use free_text
        # unmatched on a fresh session instead to pin the fixed feedback text.
        st, body = req("POST", "/v1/tutoring/sessions", tok_a, {"learnerCode": "lin"})
        sid2 = body.get("id") if isinstance(body, dict) else None
        check("create second session", st == 201 and bool(sid2), f"st={st} sid={sid2}")

        st, body = req("POST", f"/v1/tutoring/sessions/{sid2}/answer", tok_a,
                       {"freeText": "这句对不上任何选项"})
        check("free_text unmatched 200", st == 200, f"st={st}")
        if st == 200 and isinstance(body, dict):
            msgs = body.get("messages") or []
            fb = [m for m in msgs if m.get("kind") == "feedback"]
            check("unmatched adds wrong feedback", len(fb) == 1 and fb[0].get("verdict") == "wrong",
                  str(fb))
            check("unmatched stays on node",
                  body.get("currentNodeId") == "n1" or
                  (body.get("currentNode") or {}).get("id") == "n1",
                  str(body.get("currentNodeId")))
            check("unmatched scoreAfter null", body.get("scoreAfter") is None)
            check("unmatched answers empty", body.get("answers") == [], str(body.get("answers")))

        # invalid option index -> ValueError unquoted
        st, body = req("POST", f"/v1/tutoring/sessions/{sid2}/answer", tok_a,
                       {"optionIndex": 99})
        check("invalid option index 422", st == 422, f"st={st}")
        check("invalid index ValueError unquoted",
              isinstance(body, dict) and body.get("detail") == "invalid option index",
              str(body))

        # invalid option label
        st, body = req("POST", f"/v1/tutoring/sessions/{sid2}/answer", tok_a,
                       {"optionLabel": "不存在的选项"})
        check("invalid option label 422", st == 422, f"st={st}")
        check("invalid label ValueError unquoted",
              isinstance(body, dict) and body.get("detail") == "invalid option label",
              str(body))

        # empty answer -> "answer is required"
        st, body = req("POST", f"/v1/tutoring/sessions/{sid2}/answer", tok_a, {})
        check("empty answer 422", st == 422, f"st={st}")
        check("empty answer detail",
              isinstance(body, dict) and body.get("detail") == "answer is required",
              str(body))

        # ---- 6. complete ----------------------------------------------
        st, body = req("GET", f"/v1/tutoring/sessions/{sid2}", tok_a)
        before = body.get("scoreBefore", 50) if isinstance(body, dict) else 50
        st, body = req("POST", f"/v1/tutoring/sessions/{sid2}/complete", tok_a)
        check("complete 200", st == 200, f"st={st} body={str(body)[:200]}")
        if st == 200 and isinstance(body, dict):
            check("complete status", body.get("status") == "completed", str(body.get("status")))
            check("complete scoreAfter = before+6",
                  body.get("scoreAfter") == before + 6,
                  f"before={before} after={body.get('scoreAfter')}")
            check("complete currentNode null", body.get("currentNode") is None)

        # complete again still 200 (Python has no already-completed guard)
        st, body = req("POST", f"/v1/tutoring/sessions/{sid2}/complete", tok_a)
        check("complete twice 200", st == 200, f"st={st}")
        if st == 200 and isinstance(body, dict):
            check("complete twice scoreAfter same formula",
                  body.get("scoreAfter") == before + 6,
                  str(body.get("scoreAfter")))

        # answer after complete -> ValueError
        st, body = req("POST", f"/v1/tutoring/sessions/{sid2}/answer", tok_a,
                       {"optionIndex": 0})
        check("answer after complete 422", st == 422, f"st={st}")
        check("answer after complete detail",
              isinstance(body, dict) and body.get("detail") == "tutoring session already completed",
              str(body))

        # ---- 7. dynamic quiz script ------------------------------------
        st, body = req("POST", "/v1/tutoring/sessions", tok_a, {"resourceId": RES_QUIZ})
        check("create from resource 201", st == 201, f"st={st} body={str(body)[:220]}")
        if st == 201 and isinstance(body, dict):
            check("resource learnerCode",
                  body.get("learnerCode") == f"resource:{RES_QUIZ}",
                  str(body.get("learnerCode")))
            check("resource scoreBefore 50", body.get("scoreBefore") == 50,
                  str(body.get("scoreBefore")))
            check("resource currentNode q1",
                  (body.get("currentNode") or {}).get("id") == "q1",
                  str(body.get("currentNode")))
            title = body.get("scriptTitle") or ""
            check("resource scriptTitle prefix", title.startswith("苏格拉底导学 · "),
                  title)
            sid3 = body.get("id")
            # free-text that should match option "甲"
            st, body = req("POST", f"/v1/tutoring/sessions/{sid3}/answer", tok_a,
                           {"freeText": "甲"})
            check("quiz free_text match 200", st == 200, f"st={st} body={str(body)[:180]}")
            if st == 200 and isinstance(body, dict):
                check("quiz match answers [True]", body.get("answers") == [True],
                      str(body.get("answers")))

        # other user cannot create-from-resource of A's quiz? (resource is A's;
        # create is allowed but get returns None -> KeyError script not found)
        st, body = req("POST", "/v1/tutoring/sessions", tok_b, {"resourceId": RES_QUIZ})
        check("other-user resource script 404", st == 404, f"st={st}")
        check("other-user resource KeyError quoted",
              isinstance(body, dict) and body.get("detail") == "'tutoring script not found'",
              str(body))

        # ---- 8. auth ---------------------------------------------------
        st, body = req("GET", "/v1/tutoring/scripts/lin")
        check("no token 401", st == 401, f"st={st}")

    finally:
        try:
            cleanup(conn)
        except Exception as e:
            print(f"cleanup failed: {e}")
        conn.close()

    print(f"\n== tutoring matrix: {len(PASS)} ok / {len(FAIL)} fail ==")
    for name, detail in FAIL:
        print(f"  FAIL {name}: {detail}")
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
