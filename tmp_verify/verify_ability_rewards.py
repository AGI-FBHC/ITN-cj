"""Isolated live matrix for Phase 1 close-out batch.

Routes under test (Spire 19406):
  POST   /v1/learning-resources/{id}/ability-reward
  GET    /v1/learning-resources/{id}/messages
  DELETE /v1/learning-resource-tasks/{id}

Seeds SPIREVERIFYAR* rows only (users/learners/resources/messages/tasks),
exercises the routes, then cleans up. The learning_resource_ability_rewards
table is intentionally NOT pre-created — the first call must create it via the
mirrored Python ensure_schema.
"""
import os, sys, json, time, hmac, hashlib, base64
import urllib.request, urllib.error, urllib.parse
from decimal import Decimal
import pymysql

BASE = os.environ.get("VERIFY_BASE", "http://127.0.0.1:19406")
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
TAG = "SPIREVERIFYAR" + time.strftime("%H%M%S")
USER_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
USER_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

LEARN_A = "33333333-cccc-4ccc-8ccc-cccccccccccc"       # A, status=1 (reset per case)
LEARN_B = "44444444-dddd-4ddd-8ddd-dddddddddddd"       # B, status=1
LEARN_A_OFF = "55555555-eeee-4eee-8eee-eeeeeeeeeeee"  # A, status=0
LEARN_GHOST = "99999999-9999-4999-8999-999999999999"   # no learners row

R_NOLEARN = "aaaaaaaa-2001-4000-8000-000000000001"
R_LECT = "aaaaaaaa-2002-4000-8000-000000000002"
R_PRACTICE = "aaaaaaaa-2003-4000-8000-000000000003"
R_PPT = "aaaaaaaa-2004-4000-8000-000000000004"
R_QUIZ = "aaaaaaaa-2005-4000-8000-000000000005"
R_QUIZ0 = "aaaaaaaa-2006-4000-8000-000000000006"
R_QUIZ_EMPTY = "aaaaaaaa-2007-4000-8000-000000000007"
R_QUIZ_OBJ = "aaaaaaaa-2008-4000-8000-000000000008"
R_UNSUP = "aaaaaaaa-2009-4000-8000-000000000009"
R_ORDER = "aaaaaaaa-200a-4000-8000-00000000000a"
R_ORDER2 = "aaaaaaaa-200b-4000-8000-00000000000b"
R_CLAMP96 = "aaaaaaaa-200c-4000-8000-00000000000c"
R_CLAMP12 = "aaaaaaaa-200d-4000-8000-00000000000d"
R_ROUND = "aaaaaaaa-200e-4000-8000-00000000000e"
R_TRUTHY = "aaaaaaaa-200f-4000-8000-00000000000f"
R_CORRUPT = "aaaaaaaa-2010-4000-8000-000000000010"
R_BADJSON = "aaaaaaaa-2011-4000-8000-000000000011"
R_APPEND = "aaaaaaaa-2012-4000-8000-000000000012"
R_UPPER = "aaaaaaaa-2013-4000-8000-000000000013"
R_EMPTYTYPE = "aaaaaaaa-2014-4000-8000-000000000014"
R_LNOT1 = "aaaaaaaa-2015-4000-8000-000000000015"
R_LNOT2 = "aaaaaaaa-2016-4000-8000-000000000016"
R_LNOT3 = "aaaaaaaa-2017-4000-8000-000000000017"
R_BY_B = "bbbbbbbb-2018-4000-8000-000000000018"        # owned by user B
R_STRVAL = "aaaaaaaa-2019-4000-8000-000000000019"

T_DEL = "cccccccc-3001-4000-8000-000000000001"
T_OTHER = "cccccccc-3002-4000-8000-000000000002"       # owned by user B
GHOST = "ffffffff-ffff-4fff-8fff-ffffffffffff"

ALL_A_RES = [R_NOLEARN, R_LECT, R_PRACTICE, R_PPT, R_QUIZ, R_QUIZ0, R_QUIZ_EMPTY,
             R_QUIZ_OBJ, R_UNSUP, R_ORDER, R_ORDER2, R_CLAMP96, R_CLAMP12,
             R_ROUND, R_TRUTHY, R_CORRUPT, R_BADJSON, R_APPEND, R_UPPER,
             R_EMPTYTYPE, R_LNOT1, R_LNOT2, R_LNOT3, R_STRVAL]


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(sub: str) -> str:
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
        with urllib.request.urlopen(r, timeout=60) as resp:
            raw = resp.read()
            if not raw:
                return resp.status, None, dict(resp.headers)
            try:
                return resp.status, json.loads(raw.decode("utf-8")), dict(resp.headers)
            except Exception:
                return resp.status, raw.decode("utf-8", "replace")[:300], dict(resp.headers)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw.decode("utf-8")), dict(e.headers)
        except Exception:
            return e.code, raw.decode("utf-8", "replace")[:300], dict(e.headers)
    except Exception as e:
        return None, f"ERR {type(e).__name__}: {e}", {}


results = []


def check(name, cond, detail=""):
    results.append((name, "PASS" if cond else "FAIL", detail))
    print(f"{'PASS' if cond else 'FAIL':4} | {name} | {detail}")


def uhex(u):
    return u.replace("-", "")


print("TAG", TAG, "BASE", BASE)
tok_a = make_jwt(USER_A)
tok_b = make_jwt(USER_B)
conn = pymysql.connect(**DB)
conn.autocommit(True)
cur = conn.cursor()


def seed_user(uid, email):
    cur.execute(
        "INSERT INTO users (id,email,password_hash,nickname,active,account_type,created_at,updated_at) "
        "VALUES (UNHEX(%s),%s,'x',%s,1,'LEARNER',NOW(6),NOW(6)) "
        "ON DUPLICATE KEY UPDATE email=VALUES(email)",
        (uhex(uid), email, TAG),
    )


def seed_learner(lid, uid, status, scores):
    cur.execute(
        "INSERT INTO learners (id,user_id,code,name,scores_json,status,created_at,updated_at) "
        "VALUES (UNHEX(%s),UNHEX(%s),%s,%s,%s,%s,NOW(6),NOW(6)) "
        "ON DUPLICATE KEY UPDATE name=VALUES(name)",
        (uhex(lid), uhex(uid), f"{TAG}-{lid[:4]}", TAG, scores, status),
    )


def set_scores(scores_text):
    cur.execute("UPDATE learners SET scores_json=%s WHERE id=UNHEX(%s)",
                (scores_text, uhex(LEARN_A)))


def seed_resource(rid, uid, rtype, title, content, state=None, learner=None, kp=None):
    cur.execute(
        "INSERT INTO generated_learning_resources "
        "(id,user_id,resource_type,title,topic,content_json,sources_json,state_json,"
        "context_json,decision_json,kp_id,form,level,version,quiz_ids_json,kb_refs_json,"
        "is_public,resource_scope,review_status,learner_id,created_at,updated_at) "
        "VALUES (UNHEX(%s),UNHEX(%s),%s,%s,%s,CAST(%s AS JSON),CAST(%s AS JSON),CAST(%s AS JSON),"
        "NULL,NULL,%s,'quiz','L1','1','[]','[]',0,'USER','PUBLISHED',%s,NOW(6),NOW(6))",
        (uhex(rid), uhex(uid), rtype, title, title,
         json.dumps(content, ensure_ascii=False),
         json.dumps([], ensure_ascii=False),
         json.dumps(state if state is not None else {"ability": 0.0, "mastery": {}, "answered": []},
                    ensure_ascii=False),
         kp, bytes.fromhex(uhex(learner)) if learner else None),
    )


def seed_msg(mid, rid, uid, role, content, created):
    cur.execute(
        "INSERT INTO learning_resource_messages (id,resource_id,user_id,role,content,created_at) "
        "VALUES (UNHEX(%s),UNHEX(%s),UNHEX(%s),%s,%s,%s)",
        (uhex(mid), uhex(rid), uhex(uid), role, content, created),
    )


def seed_task(tid, uid):
    cur.execute(
        "INSERT INTO learning_resource_generation_tasks(id,user_id,resource_type,title,"
        "status,progress,stage_message,request_json,events_json,resource_id,"
        "checkpoint_stage,error_message,created_at,updated_at) "
        "VALUES(UNHEX(%s),UNHEX(%s),'lecture',%s,'completed',100,'stage',"
        "CAST(%s AS JSON),CAST(%s AS JSON),NULL,NULL,NULL,NOW(6),NOW(6))",
        (uhex(tid), uhex(uid), f"{TAG} task", "{}", "[]"),
    )


KP_NONE = {"knowledgePoints": [], "sections": []}
KP_NET = {"title": None, "knowledgePoints": [], "sections": []}


def content_with(kp_name=None, ctitle=None):
    c = {"sections": [], "knowledgePoints": []}
    if ctitle is not None:
        c["title"] = ctitle
    if kp_name is not None:
        c["knowledgePoints"] = [{"id": "kp-1", "name": kp_name}]
    return c


try:
    seed_user(USER_A, f"{TAG.lower()}-a@example.com")
    seed_user(USER_B, f"{TAG.lower()}-b@example.com")
    seed_learner(LEARN_A, USER_A, 1, "{}")
    seed_learner(LEARN_B, USER_B, 1, "{}")
    seed_learner(LEARN_A_OFF, USER_A, 0, "{}")

    # lecture, no learner -> route-side no-learner
    seed_resource(R_NOLEARN, USER_A, "lecture", f"{TAG} nolearner", KP_NONE)
    # ch1-intro -> primary kp-agent (0.6), secondary kp-ds (0.4)
    seed_resource(R_LECT, USER_A, "lecture", f"{TAG} lect", content_with("记忆", f"{TAG} ct"),
                  learner=LEARN_A, kp="ch1-intro")
    # keyword group 2 (代码) -> kp-os primary, kp-co secondary
    seed_resource(R_PRACTICE, USER_A, "practice", f"{TAG} 代码实践", content_with(None, None),
                  learner=LEARN_A, kp="misc")
    # ch3-llm -> kp-ds (0.7), kp-co (0.3)
    seed_resource(R_PPT, USER_A, "ppt", f"{TAG} ppt", content_with(None, None),
                  learner=LEARN_A, kp="ch3-llm")
    # ch8-memory-rag equal weights -> stable literal order kp-ds, kp-network
    # truthy correct: True, 1, "yes", [1], {"x":1} -> 5/11 ({} and [] are falsy)
    seed_resource(R_QUIZ, USER_A, "quiz", f"{TAG} quiz", content_with(None, None),
                  state={"answered": [{"correct": True}, {"correct": 1}, {"correct": "yes"},
                                      {"correct": False}, {"correct": 0}, {"correct": None},
                                      {"correct": ""}, {"correct": {}}, {"correct": []},
                                      {"correct": [1]}, {"correct": {"x": 1}}]},
                  learner=LEARN_A, kp="ch8-memory-rag")
    seed_resource(R_QUIZ0, USER_A, "quiz", f"{TAG} quiz0", content_with(None, None),
                  state={"answered": [{"correct": False}, {"correct": 0}]},
                  learner=LEARN_A, kp="ch8-memory-rag")
    seed_resource(R_QUIZ_EMPTY, USER_A, "quiz", f"{TAG} quizempty", content_with(None, None),
                  state={"answered": []}, learner=LEARN_A, kp="ch8-memory-rag")
    seed_resource(R_QUIZ_OBJ, USER_A, "quiz", f"{TAG} quizobj", content_with(None, None),
                  state={"answered": {"a": 1}}, learner=LEARN_A, kp="ch8-memory-rag")
    seed_resource(R_UNSUP, USER_A, "note", f"{TAG} unsup", content_with(None, None),
                  learner=LEARN_A, kp="misc")
    # group order: 推理(kp-co) before 代码(kp-os)
    seed_resource(R_ORDER, USER_A, "lecture", f"{TAG} 代码 推理", content_with(None, None),
                  learner=LEARN_A, kp="misc")
    # 代码(kp-os) before 网络(kp-network)
    seed_resource(R_ORDER2, USER_A, "lecture", f"{TAG} 网络 代码", content_with(None, None),
                  learner=LEARN_A, kp="misc")
    seed_resource(R_CLAMP96, USER_A, "lecture", f"{TAG} clamp96", content_with(None, None),
                  learner=LEARN_A, kp="ch1-intro")
    seed_resource(R_CLAMP12, USER_A, "lecture", f"{TAG} clamp12", content_with(None, None),
                  learner=LEARN_A, kp="ch2-history")
    # default keyword group 6 (理解) -> kp-ds primary, kp-co secondary
    seed_resource(R_ROUND, USER_A, "lecture", f"{TAG} 理解", content_with(None, None),
                  learner=LEARN_A, kp="misc")
    seed_resource(R_TRUTHY, USER_A, "lecture", f"{TAG} truthy", content_with(None, None),
                  learner=LEARN_A, kp="ch1-intro")
    seed_resource(R_CORRUPT, USER_A, "lecture", f"{TAG} corrupt", content_with(None, None),
                  learner=LEARN_A, kp="ch1-intro")
    seed_resource(R_BADJSON, USER_A, "lecture", f"{TAG} badjson", content_with(None, None),
                  learner=LEARN_A, kp="ch1-intro")
    seed_resource(R_APPEND, USER_A, "lecture", f"{TAG} append", content_with(None, None),
                  learner=LEARN_A, kp="ch1-intro")
    seed_resource(R_UPPER, USER_A, "PPT", f"{TAG} upper", content_with(None, None),
                  learner=LEARN_A, kp="misc")
    seed_resource(R_EMPTYTYPE, USER_A, "", f"{TAG} emptytype", content_with(None, None),
                  learner=LEARN_A, kp="misc")
    seed_resource(R_LNOT1, USER_A, "lecture", f"{TAG} lnot1", content_with(None, None),
                  learner=LEARN_GHOST, kp="misc")
    seed_resource(R_LNOT2, USER_A, "lecture", f"{TAG} lnot2", content_with(None, None),
                  learner=LEARN_A_OFF, kp="misc")
    seed_resource(R_LNOT3, USER_A, "lecture", f"{TAG} lnot3", content_with(None, None),
                  learner=LEARN_B, kp="misc")
    seed_resource(R_STRVAL, USER_A, "lecture", f"{TAG} strval", content_with(None, None),
                  learner=LEARN_A, kp="ch1-intro")
    seed_resource(R_BY_B, USER_B, "lecture", f"{TAG} byb", content_with(None, None),
                  learner=LEARN_B, kp="misc")

    seed_msg("dddddddd-4001-4000-8000-000000000001", R_LECT, USER_A, "user",
             f"{TAG} m1", "2026-10-16 01:02:03.000000")
    seed_msg("dddddddd-4002-4000-8000-000000000002", R_LECT, USER_A, "assistant",
             f"{TAG} m2", "2026-10-16 01:02:03.123456")
    seed_msg("dddddddd-4003-4000-8000-000000000003", R_LECT, USER_A, "user",
             f"{TAG} m3", "2026-10-16 01:02:04.500000")
    seed_msg("dddddddd-4004-4000-8000-000000000004", R_LECT, USER_B, "user",
             f"{TAG} m4b", "2026-10-16 01:02:05.000000")

    seed_task(T_DEL, USER_A)
    seed_task(T_OTHER, USER_B)
    print("seeded")

    # ---------- auth / 422 / 404 ----------
    def check_uuid_422(name, body, loc_name):
        """Exact agents-service envelope: main.py:44-46 {"code","details":[pydantic err]}."""
        d = (body or {}).get("details") if isinstance(body, dict) else None
        ok = (isinstance(body, dict) and body.get("code") == "VALIDATION_FAILED"
              and isinstance(d, list) and len(d) == 1 and isinstance(d[0], dict))
        if ok:
            it = d[0]
            ok = (it.get("type") == "uuid_parsing"
                  and it.get("loc") == ["path", loc_name]
                  and str(it.get("msg", "")).startswith("Input should be a valid UUID")
                  and it.get("input") == "not-a-uuid"
                  and isinstance(it.get("ctx"), dict) and "error" in it.get("ctx", {}))
        check(name, ok, f"{str(body)[:200]}")

    st, body, _ = req("POST", f"/v1/learning-resources/{R_LECT}/ability-reward")
    check("ability-reward no-token 401", st == 401, f"{st} {str(body)[:80]}")
    st, body, _ = req("POST", "/v1/learning-resources/not-a-uuid/ability-reward", tok_a)
    check("ability-reward bad uuid 422", st == 422, f"{st}")
    check_uuid_422("ability-reward 422 shape", body, "resource_id")
    st, body, _ = req("POST", f"/v1/learning-resources/{GHOST}/ability-reward", tok_a)
    check("ability-reward ghost 404", st == 404 and isinstance(body, dict)
          and body.get("detail") == "Resource not found", f"{st} {body}")
    st, body, _ = req("POST", f"/v1/learning-resources/{R_BY_B}/ability-reward", tok_a)
    check("ability-reward other-user 404", st == 404 and isinstance(body, dict)
          and body.get("detail") == "Resource not found", f"{st} {body}")
    st, body, _ = req("GET", f"/v1/learning-resources/{R_LECT}/messages")
    check("messages no-token 401", st == 401, f"{st} {str(body)[:80]}")
    st, body, _ = req("GET", "/v1/learning-resources/not-a-uuid/messages", tok_a)
    check("messages bad uuid 422", st == 422, f"{st}")
    check_uuid_422("messages 422 shape", body, "resource_id")
    st, body, _ = req("DELETE", f"/v1/learning-resource-tasks/{GHOST}")
    check("task-delete no-token 401", st == 401, f"{st} {str(body)[:80]}")
    st, body, _ = req("DELETE", "/v1/learning-resource-tasks/not-a-uuid", tok_a)
    check("task-delete bad uuid 422", st == 422, f"{st}")
    check_uuid_422("task-delete 422 shape", body, "task_id")

    # ---------- route-side false reasons ----------
    st, body, _ = req("POST", f"/v1/learning-resources/{R_NOLEARN}/ability-reward", tok_a)
    check("no-learner 200 false", st == 200 and isinstance(body, dict)
          and body.get("rewarded") is False and body.get("reason") == "no-learner",
          f"{st} {body}")
    set_scores("{}")
    st, body, _ = req("POST", f"/v1/learning-resources/{R_UNSUP}/ability-reward", tok_a)
    check("unsupported-type 200 false", st == 200 and body.get("rewarded") is False
          and body.get("reason") == "unsupported-type", f"{st} {body}")
    st, body, _ = req("POST", f"/v1/learning-resources/{R_UNSUP}/ability-reward", tok_a)
    check("unsupported-type beats already-rewarded", body.get("reason") == "unsupported-type",
          f"{st} {body}")

    # ---------- learner-not-found family ----------
    for rid, name in ((R_LNOT1, "learner-not-found missing row"),
                      (R_LNOT2, "learner-not-found status=0"),
                      (R_LNOT3, "learner-not-found other-user learner")):
        set_scores("{}")
        st, body, _ = req("POST", f"/v1/learning-resources/{rid}/ability-reward", tok_a)
        check(name, st == 200 and body.get("rewarded") is False
              and body.get("reason") == "learner-not-found", f"{st} {body}")

    # ---------- happy path lecture (chapter ch1-intro) ----------
    set_scores("{}")
    st, body, _ = req("POST", f"/v1/learning-resources/{R_LECT}/ability-reward", tok_a)
    check("lecture rewarded 200", st == 200 and body.get("rewarded") is True, f"{st} {str(body)[:160]}")
    check("lecture key order", list(body.keys()) ==
          ["rewarded", "primaryDimension", "secondaryDimension", "deltas", "scores"],
          str(list(body.keys())))
    check("lecture dims ch1-intro", body.get("primaryDimension") == "kp-agent"
          and body.get("secondaryDimension") == "kp-ds", str(body.get("primaryDimension")))
    deltas = body.get("deltas") or {}
    check("lecture deltas from 50.0 to 51/50", deltas.get("kp-agent", {}).get("from") == 50.0
          and deltas.get("kp-agent", {}).get("to") == 51
          and deltas.get("kp-ds", {}).get("from") == 50.0
          and deltas.get("kp-ds", {}).get("to") == 50, str(deltas))
    check("delta from is float, to is int", isinstance(deltas.get("kp-agent", {}).get("from"), float)
          and isinstance(deltas.get("kp-agent", {}).get("to"), int), str(deltas.get("kp-agent")))
    check("lecture scores", body.get("scores", {}).get("kp-agent") == 51
          and body.get("scores", {}).get("kp-ds") == 50, str(body.get("scores")))
    cur.execute("SELECT scores_json FROM learners WHERE id=UNHEX(%s)", (uhex(LEARN_A),))
    srow = cur.fetchone()[0]
    check("scores_json written", '"kp-agent": 51' in srow.replace(":", ": ") or
          json.loads(srow).get("kp-agent") == 51, srow)
    cur.execute(
        "SELECT resource_type,main_dimension,secondary_dimension,reward_points,created_at "
        "FROM learning_resource_ability_rewards WHERE resource_id=UNHEX(%s)",
        (uhex(R_LECT),))
    rrow = cur.fetchone()
    check("reward row inserted", rrow is not None, str(rrow))
    if rrow:
        check("reward row fields", rrow[0] == "lecture" and rrow[1] == "kp-agent"
              and rrow[2] == "kp-ds" and float(rrow[3]) == 1.5, str(rrow[:4]))
        import datetime
        drift = abs((datetime.datetime.utcnow() - rrow[4]).total_seconds())
        check("reward created_at naive utc", drift < 300, f"drift={drift}s {rrow[4]}")
    cur.execute(
        "SHOW COLUMNS FROM learning_resource_ability_rewards")
    cols = {r[0] for r in cur.fetchall()}
    check("ensure_schema created table", {"id", "user_id", "learner_id", "resource_id",
                                          "resource_type", "main_dimension",
                                          "secondary_dimension", "reward_points",
                                          "created_at"} <= cols, str(sorted(cols)))
    st, body, _ = req("POST", f"/v1/learning-resources/{R_LECT}/ability-reward", tok_a)
    check("already-rewarded", st == 200 and body.get("rewarded") is False
          and body.get("reason") == "already-rewarded", f"{st} {body}")

    # ---------- practice keyword dims ----------
    set_scores("{}")
    st, body, _ = req("POST", f"/v1/learning-resources/{R_PRACTICE}/ability-reward", tok_a)
    check("practice dims 代码->kp-os", body.get("primaryDimension") == "kp-os"
          and body.get("secondaryDimension") == "kp-co", f"{st} {str(body)[:120]}")
    check("practice points 2.0/1.0", body.get("deltas", {}).get("kp-os", {}).get("to") == 52
          and body.get("deltas", {}).get("kp-co", {}).get("to") == 51, str(body.get("deltas")))

    # ---------- ppt chapter ch3-llm ----------
    set_scores("{}")
    st, body, _ = req("POST", f"/v1/learning-resources/{R_PPT}/ability-reward", tok_a)
    check("ppt dims ch3-llm", body.get("primaryDimension") == "kp-ds"
          and body.get("secondaryDimension") == "kp-co", f"{st} {str(body)[:120]}")
    # 50+1.5=51.5 -> banker's round 52; 50+0.75=50.75 -> 51
    check("ppt points 1.5/0.75", body.get("deltas", {}).get("kp-ds", {}).get("to") == 52
          and body.get("deltas", {}).get("kp-co", {}).get("to") == 51,
          str(body.get("deltas")))

    # ---------- quiz correct_rate + equal-weight chapter ----------
    set_scores("{}")
    st, body, _ = req("POST", f"/v1/learning-resources/{R_QUIZ}/ability-reward", tok_a)
    # truthy correct = True,1,"yes",[1],{"x":1} -> 5/11 -> 2.0*rate=0.91, 1.0*rate=0.45
    check("quiz dims ch8 equal weights stable", body.get("primaryDimension") == "kp-ds"
          and body.get("secondaryDimension") == "kp-network", f"{st} {str(body)[:140]}")
    d = body.get("deltas", {})
    check("quiz rate 5/11 scaled points", d.get("kp-ds", {}).get("to") == 51
          and d.get("kp-network", {}).get("to") == 50, str(d))
    cur.execute("SELECT reward_points FROM learning_resource_ability_rewards WHERE resource_id=UNHEX(%s)",
                (uhex(R_QUIZ),))
    prow = cur.fetchone()
    check("quiz reward_points 1.36", prow is not None and float(prow[0]) == 1.36, str(prow))

    set_scores("{}")
    st, body, _ = req("POST", f"/v1/learning-resources/{R_QUIZ0}/ability-reward", tok_a)
    check("quiz rate 0 rewarded but no deltas", body.get("rewarded") is True
          and body.get("deltas") == {}, f"{st} {str(body)[:140]}")
    check("quiz rate 0 scores unchanged keys", body.get("scores") == {}, str(body.get("scores")))
    cur.execute("SELECT reward_points FROM learning_resource_ability_rewards WHERE resource_id=UNHEX(%s)",
                (uhex(R_QUIZ0),))
    prow = cur.fetchone()
    check("quiz rate 0 reward row points 0", prow is not None and float(prow[0]) == 0.0, str(prow))

    set_scores("{}")
    st, body, _ = req("POST", f"/v1/learning-resources/{R_QUIZ_EMPTY}/ability-reward", tok_a)
    check("quiz empty answered rate 1.0", body.get("deltas", {}).get("kp-ds", {}).get("to") == 52
          and body.get("deltas", {}).get("kp-network", {}).get("to") == 51, str(body.get("deltas")))

    set_scores("{}")
    st, body, _ = req("POST", f"/v1/learning-resources/{R_QUIZ_OBJ}/ability-reward", tok_a)
    check("quiz non-list answered rate 1.0", body.get("deltas", {}).get("kp-ds", {}).get("to") == 52,
          str(body.get("deltas")))

    # ---------- clamp + banker's rounding ----------
    set_scores(json.dumps({"kp-agent": 95.6}))
    st, body, _ = req("POST", f"/v1/learning-resources/{R_CLAMP96}/ability-reward", tok_a)
    check("clamp high 96", body.get("deltas", {}).get("kp-agent", {}).get("to") == 96,
          str(body.get("deltas")))
    set_scores(json.dumps({"kp-ds": 5.0}))
    st, body, _ = req("POST", f"/v1/learning-resources/{R_CLAMP12}/ability-reward", tok_a)
    check("clamp low 12", body.get("deltas", {}).get("kp-ds", {}).get("to") == 12,
          str(body.get("deltas")))

    set_scores(json.dumps({"kp-ds": 12.5, "kp-co": 12.0}))
    st, body, _ = req("POST", f"/v1/learning-resources/{R_ROUND}/ability-reward", tok_a)
    d = body.get("deltas", {})
    check("banker's round 13.5->14", d.get("kp-ds", {}).get("to") == 14, str(d))
    check("banker's round 12.5->12", d.get("kp-co", {}).get("to") == 12, str(d))

    # ---------- truthiness / string numeric ----------
    set_scores(json.dumps({"kp-agent": 0, "kp-ds": False}))
    st, body, _ = req("POST", f"/v1/learning-resources/{R_TRUTHY}/ability-reward", tok_a)
    d = body.get("deltas", {})
    check("falsy scores fall back to 50", d.get("kp-agent", {}).get("from") == 50.0
          and d.get("kp-ds", {}).get("from") == 50.0, str(d))
    set_scores(json.dumps({"kp-agent": "60", "kp-ds": 40}))
    st, body, _ = req("POST", f"/v1/learning-resources/{R_STRVAL}/ability-reward", tok_a)
    d = body.get("deltas", {})
    # ch1-intro: kp-agent primary ("60" parses -> 60.0 -> 61), kp-ds secondary (40+0.5 -> 40)
    check("string numeric score parsed", d.get("kp-agent", {}).get("from") == 60.0
          and d.get("kp-agent", {}).get("to") == 61
          and d.get("kp-ds", {}).get("from") == 40.0
          and d.get("kp-ds", {}).get("to") == 40, str(d))

    # ---------- corrupt scores value -> 500 like Python float() ----------
    set_scores(json.dumps({"kp-agent": "abc"}))
    st, body, _ = req("POST", f"/v1/learning-resources/{R_CORRUPT}/ability-reward", tok_a)
    check("corrupt score value 500", st == 500, f"{st} {str(body)[:100]}")
    cur.execute("SELECT COUNT(*) FROM learning_resource_ability_rewards WHERE resource_id=UNHEX(%s)",
                (uhex(R_CORRUPT),))
    check("corrupt case no reward row", cur.fetchone()[0] == 0, "")

    # ---------- unparsable scores_json -> treated as {} ----------
    set_scores("not-json")
    st, body, _ = req("POST", f"/v1/learning-resources/{R_BADJSON}/ability-reward", tok_a)
    check("bad scores_json treated as empty", st == 200 and body.get("rewarded") is True
          and body.get("deltas", {}).get("kp-agent", {}).get("from") == 50.0, f"{st} {str(body)[:140]}")

    # ---------- key order: update in place, append new ----------
    set_scores(json.dumps({"kp-custom": 70, "kp-agent": 30}))
    st, body, _ = req("POST", f"/v1/learning-resources/{R_APPEND}/ability-reward", tok_a)
    keys = list((body.get("scores") or {}).keys())
    check("scores key order preserved + append",
          keys == ["kp-custom", "kp-agent", "kp-ds"], str(keys))
    cur.execute("SELECT scores_json FROM learners WHERE id=UNHEX(%s)", (uhex(LEARN_A),))
    dbk = list(json.loads(cur.fetchone()[0]).keys())
    check("scores_json key order matches", dbk == ["kp-custom", "kp-agent", "kp-ds"], str(dbk))

    # ---------- type normalization ----------
    set_scores("{}")
    st, body, _ = req("POST", f"/v1/learning-resources/{R_UPPER}/ability-reward", tok_a)
    check("type PPT lowered", body.get("rewarded") is True, f"{st} {str(body)[:100]}")
    cur.execute("SELECT resource_type FROM learning_resource_ability_rewards WHERE resource_id=UNHEX(%s)",
                (uhex(R_UPPER),))
    check("reward row stores lowercase type", cur.fetchone()[0] == "ppt", "")
    set_scores("{}")
    st, body, _ = req("POST", f"/v1/learning-resources/{R_EMPTYTYPE}/ability-reward", tok_a)
    # "" -> lecture points 1.0/0.5; no keyword -> default kp-ds/kp-co
    check("empty type -> lecture", body.get("rewarded") is True
          and body.get("deltas", {}).get("kp-ds", {}).get("to") == 51
          and body.get("deltas", {}).get("kp-co", {}).get("to") == 50,
          f"{st} {str(body)[:140]}")

    # ---------- messages ----------
    st, body, _ = req("GET", f"/v1/learning-resources/{R_LECT}/messages", tok_a)
    msgs = (body or {}).get("messages") if isinstance(body, dict) else None
    check("messages 200 list", st == 200 and isinstance(msgs, list), f"{st} {str(body)[:120]}")
    check("messages count (B's hidden)", msgs is not None and len(msgs) == 3, str(len(msgs or [])))
    if msgs and len(msgs) == 3:
        check("messages ordered by created_at",
              [m.get("content") for m in msgs] == [f"{TAG} m1", f"{TAG} m2", f"{TAG} m3"],
              str([m.get("content") for m in msgs]))
        check("message fields", set(msgs[0].keys()) == {"role", "content", "createdAt"},
              str(msgs[0].keys()))
        check("createdAt micros-0 iso", msgs[0].get("createdAt") == "2026-10-16T01:02:03",
              str(msgs[0].get("createdAt")))
        check("createdAt micros iso", msgs[1].get("createdAt") == "2026-10-16T01:02:03.123456",
              str(msgs[1].get("createdAt")))
        check("message roles", msgs[0].get("role") == "user" and msgs[1].get("role") == "assistant",
              str([m.get("role") for m in msgs]))
    st, body, _ = req("GET", f"/v1/learning-resources/{R_LECT}/messages", tok_b)
    bmsgs = (body or {}).get("messages") if isinstance(body, dict) else None
    check("messages B isolation", st == 200 and isinstance(bmsgs, list) and len(bmsgs) == 1
          and bmsgs[0].get("content") == f"{TAG} m4b", f"{st} {str(bmsgs)[:120]}")
    st, body, _ = req("GET", f"/v1/learning-resources/{R_NOLEARN}/messages", tok_a)
    check("messages empty 200", st == 200 and body.get("messages") == [], f"{st} {body}")
    st, body, _ = req("GET", f"/v1/learning-resources/{GHOST}/messages", tok_a)
    check("messages ghost NO 404 always 200", st == 200 and body.get("messages") == [],
          f"{st} {body}")

    # ---------- DELETE resource-task ----------
    st, body, _ = req("DELETE", f"/v1/learning-resource-tasks/{T_DEL}", tok_a)
    check("task-delete 204", st == 204 and (body is None or body == ""), f"{st} {str(body)[:80]}")
    cur.execute("SELECT COUNT(*) FROM learning_resource_generation_tasks WHERE id=UNHEX(%s)",
                (uhex(T_DEL),))
    check("task row gone", cur.fetchone()[0] == 0, "")
    st, body, _ = req("DELETE", f"/v1/learning-resource-tasks/{T_DEL}", tok_a)
    check("task-delete twice 404", st == 404 and isinstance(body, dict)
          and body.get("detail") == "任务不存在或无权删除", f"{st} {body}")
    st, body, _ = req("DELETE", f"/v1/learning-resource-tasks/{GHOST}", tok_a)
    check("task-delete missing 404", st == 404 and isinstance(body, dict)
          and body.get("detail") == "任务不存在或无权删除", f"{st} {body}")
    st, body, _ = req("DELETE", f"/v1/learning-resource-tasks/{T_OTHER}", tok_a)
    check("task-delete other-user 404", st == 404 and body.get("detail") == "任务不存在或无权删除",
          f"{st} {body}")
    cur.execute("SELECT COUNT(*) FROM learning_resource_generation_tasks WHERE id=UNHEX(%s)",
                (uhex(T_OTHER),))
    check("other-user task row kept", cur.fetchone()[0] == 1, "")

    # ---------- module smoke (regression on untouched read paths) ----------
    st, body, _ = req("GET", "/v1/learning-resources?resource_type=lecture", tok_a)
    check("smoke resources list 200", st == 200 and isinstance(body, dict), f"{st} {str(body)[:80]}")
    st, body, _ = req("GET", "/v1/learning-resource-tasks", tok_a)
    check("smoke resource-tasks list 200", st == 200 and isinstance(body, dict)
          and "tasks" in body, f"{st} {str(body)[:80]}")
    st, body, _ = req("GET", f"/v1/learning-resource-tasks/{T_OTHER}", tok_b)
    check("smoke task get 200", st == 200 and isinstance(body, dict), f"{st} {str(body)[:80]}")

finally:
    try:
        cur.execute("DELETE FROM learning_resource_ability_rewards WHERE user_id=UNHEX(%s)",
                    (uhex(USER_A),))
        cur.execute("DELETE FROM learning_resource_ability_rewards WHERE user_id=UNHEX(%s)",
                    (uhex(USER_B),))
        cur.execute("DELETE FROM learning_resource_messages WHERE content LIKE %s", (TAG + "%",))
        cur.execute("DELETE FROM learning_resource_generation_tasks WHERE title LIKE %s", (TAG + "%",))
        in_list = ",".join(f"UNHEX('{uhex(r)}')" for r in ALL_A_RES + [R_BY_B])
        cur.execute(f"DELETE FROM generated_learning_resources WHERE id IN ({in_list})")
        cur.execute("DELETE FROM learners WHERE name=%s", (TAG,))
        cur.execute("DELETE FROM users WHERE email IN (%s, %s)",
                    (f"{TAG.lower()}-a@example.com", f"{TAG.lower()}-b@example.com"))
        print("cleanup done")
    except Exception as e:
        print("cleanup error", e)
    conn.close()

passed = sum(1 for _, s, _ in results if s == "PASS")
failed = sum(1 for _, s, _ in results if s == "FAIL")
print(f"\n=== {passed}/{passed + failed} passed ===")
if failed:
    for name, s, detail in results:
        if s == "FAIL":
            print(f"  FAIL {name} :: {detail}")
    sys.exit(1)
