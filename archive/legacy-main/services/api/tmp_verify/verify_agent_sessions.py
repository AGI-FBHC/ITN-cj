"""Isolated live matrix for Spire agent-sessions + GET /course-progress.

Seeds SPIREVERIFYAS* rows on two known test users only, exercises the 11 routes,
then cleans those rows up. Real rows are never touched.
"""
import os, sys, json, time, hmac, hashlib, base64, urllib.request, urllib.error
import pymysql

BASE = os.environ.get("VERIFY_BASE", "http://127.0.0.1:19137")
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
TAG = "SPIREVERIFYAS" + time.strftime("%H%M%S")
USER_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
USER_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
LEARNER_1 = "33333333-cccc-4ccc-8ccc-cccccccccccc"
LEARNER_2 = "44444444-dddd-4ddd-8ddd-dddddddddddd"

# Fixed session ids so we can pre-seed messages/decisions and re-read DB state.
S_OWN = "aaaaaaaa-3001-4000-8000-000000000001"   # A, learner 1, with messages+decisions
S_OTH = "bbbbbbbb-3002-4000-8000-000000000002"   # B
S_TTL = "aaaaaaaa-3003-4000-8000-000000000003"   # A, for title updates
S_CMP = "aaaaaaaa-3004-4000-8000-000000000004"   # A, for complete
S_DEL = "aaaaaaaa-3005-4000-8000-000000000005"   # A, for delete (with children)
S_ORP = "aaaaaaaa-3006-4000-8000-000000000006"   # A, fail-closed probe
S_SIB = "aaaaaaaa-3007-4000-8000-000000000007"   # A, sibling that must survive
S_EMPTY = "aaaaaaaa-3008-4000-8000-000000000008"  # A, empty messages/decisions

M1 = "aaaaaaaa-3101-4000-8000-000000000001"
M2 = "aaaaaaaa-3102-4000-8000-000000000002"
D1 = "aaaaaaaa-3201-4000-8000-000000000001"

# course-progress fixtures
C_NONE = "aaaaaaaa-4001-4000-8000-000000000001"   # A learner1, no resources
C_PCT = "aaaaaaaa-4002-4000-8000-000000000002"    # A learner1, 8 lecture resources
C_QZ = "aaaaaaaa-4003-4000-8000-000000000003"     # A learner2, quiz completed via completed flag
C_PPT = "aaaaaaaa-4004-4000-8000-000000000004"    # A learner2, ppt via user_state
C_B = "bbbbbbbb-4005-4000-8000-000000000005"      # B, must not leak into A
C_OLD = "aaaaaaaa-4006-4000-8000-000000000006"    # A learner1, older than C_PCT (latest wins)
C_VIS = "aaaaaaaa-4007-4000-8000-000000000007"    # A learner1, visibility probes

GHOST = "ffffffff-ffff-4fff-8fff-ffffffffffff"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(sub: str) -> str:
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(json.dumps({"sub": sub, "exp": int(time.time()) + 3600}, separators=(",", ":")).encode())
    msg = f"{header}.{payload}".encode()
    sig = hmac.new(JWT_SECRET.encode(), msg, hashlib.sha256).digest()
    return f"{header}.{payload}.{b64url(sig)}"


def req(method, path, token=None, body=None):
    """Returns (status, body, headers). `body` is None, a JSON value, or a
    dict marker ({__raw__}/{__err__}) — never a bare str, so callers can
    always use .get() without crashing the run."""
    url = BASE + path
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            raw = resp.read()
            if not raw:
                return resp.status, None, dict(resp.headers)
            try:
                return resp.status, json.loads(raw.decode("utf-8")), dict(resp.headers)
            except Exception:
                return resp.status, {"__raw__": raw.decode("utf-8", "replace")[:300]}, dict(resp.headers)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw.decode("utf-8")), dict(e.headers)
        except Exception:
            return e.code, {"__raw__": raw.decode("utf-8", "replace")[:300]}, dict(e.headers)
    except Exception as e:
        return None, {"__err__": f"{type(e).__name__}: {e}"}, {}


results = []


def check(name, cond, detail=""):
    results.append((name, "PASS" if cond else "FAIL", detail))
    safe = str(detail).encode("gbk", "replace").decode("gbk", "replace")
    print(f"{'PASS' if cond else 'FAIL':4} | {name} | {safe}")


def vitem(body):
    """First item of the measured pydantic 422 envelope
    {"code":"VALIDATION_FAILED","details":[{type,loc,msg,...}]}.
    msg is the bare pydantic text ("Field required", "Input should be a valid
    string", ...) — NEVER a flattened "Field required: title". Ground truth is
    tmp_verify/fastapi_ref_422.json (recorded against real agents-service)."""
    if not isinstance(body, dict):
        return {}
    d = body.get("details")
    if isinstance(d, list) and d and isinstance(d[0], dict):
        return d[0]
    return {}


def uhex(u):
    return u.replace("-", "")


def count(sql, *args):
    cur.execute(sql, args)
    row = cur.fetchone()
    return 0 if row is None else int(row[0])


print("TAG", TAG, "BASE", BASE)
tok_a = make_jwt(USER_A)
tok_b = make_jwt(USER_B)
conn = pymysql.connect(**DB)
conn.autocommit(True)  # see Spire's committed writes immediately
cur = conn.cursor()

NOW = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
NOW_MICRO = NOW + ".123456"
NOW_MICRO_2 = NOW + ".654321"


def seed_user(uid, email):
    cur.execute(
        "INSERT INTO users (id,email,password_hash,nickname,active,account_type,"
        "created_at,updated_at) VALUES (UNHEX(%s),%s,'x',%s,1,'LEARNER',NOW(6),NOW(6)) "
        "ON DUPLICATE KEY UPDATE email=VALUES(email)",
        (uhex(uid), email, TAG),
    )


def seed_learner(lid, uid, code):
    cur.execute(
        "INSERT INTO learners (id,user_id,code,name,created_at,updated_at) "
        "VALUES (UNHEX(%s),UNHEX(%s),%s,%s,NOW(6),NOW(6)) "
        "ON DUPLICATE KEY UPDATE name=VALUES(name)",
        (uhex(lid), uhex(uid), code, TAG),
    )


def insert_session(sid, uid, learner, title, status, created, updated):
    cur.execute(
        "INSERT INTO agent_sessions(id,user_id,learner_id,session_type,title,status,"
        "created_at,updated_at) VALUES(UNHEX(%s),UNHEX(%s),UNHEX(%s),'agent',%s,%s,%s,%s)",
        (uhex(sid), uhex(uid), uhex(learner) if learner else None, title, status, created, updated),
    )


def insert_message(mid, sid, uid, agent_id, kind, content, created):
    cur.execute(
        "INSERT INTO agent_messages(id,session_id,user_id,agent_id,kind,content,created_at) "
        "VALUES(UNHEX(%s),UNHEX(%s),UNHEX(%s),%s,%s,%s,%s)",
        (uhex(mid), uhex(sid), uhex(uid), agent_id, kind, content, created),
    )


def insert_decision(did, sid, uid, learner, stage, text, created):
    cur.execute(
        "INSERT INTO agent_decisions(id,session_id,user_id,learner_id,stage,text,created_at) "
        "VALUES(UNHEX(%s),UNHEX(%s),UNHEX(%s),UNHEX(%s),%s,%s,%s)",
        (uhex(did), uhex(sid), uhex(uid), uhex(learner) if learner else None, stage, text, created),
    )


def insert_course(cid, uid, learner, title, updated, rtypes, progress=100):
    cur.execute(
        "INSERT INTO generated_courses(id,user_id,learner_id,learning_goal_id,"
        "learning_goal_ids_json,title,description,prompt,domain_name,depth,scale,"
        "course_style,resource_types_json,status,progress,stage_message,"
        "current_chapter_id,events_json,error_message,created_at,updated_at) "
        "VALUES(UNHEX(%s),UNHEX(%s),UNHEX(%s),NULL,'[]',%s,%s,%s,%s,'standard','medium',"
        "'none',%s,'completed',%s,'',NULL,'[]',NULL,%s,%s)",
        (uhex(cid), uhex(uid), uhex(learner) if learner else None, title,
         f"{TAG} 描述", f"{TAG} prompt", f"{TAG} 领域",
         json.dumps(rtypes, ensure_ascii=False), progress, NOW, updated),
    )


def insert_chapter(chid, cid, idx, resources, updated):
    cur.execute(
        "INSERT INTO generated_course_chapters(id,course_id,chapter_index,title,summary,"
        "objectives_json,sections_json,status,progress,resources_json,created_at,updated_at) "
        "VALUES(UNHEX(%s),UNHEX(%s),%s,%s,'',\"[]\",'[]','completed',100,%s,%s,%s)",
        (uhex(chid), uhex(cid), idx, f"{TAG} 章{idx}",
         json.dumps(resources, ensure_ascii=False), NOW, updated),
    )


def insert_glr(rid, uid, rtype, state, is_public=0, scope="USER", archived=None):
    cur.execute(
        "INSERT INTO generated_learning_resources "
        "(id,user_id,resource_type,title,topic,content_json,sources_json,state_json,"
        "context_json,decision_json,kp_id,form,level,version,quiz_ids_json,kb_refs_json,"
        "is_public,resource_scope,review_status,created_at,updated_at,archived_at) "
        "VALUES (UNHEX(%s),UNHEX(%s),%s,%s,%s,CAST(%s AS JSON),CAST(%s AS JSON),CAST(%s AS JSON),"
        "NULL,NULL,'kp','quiz','L1','1','[]','[]',%s,%s,'PUBLISHED',NOW(6),NOW(6),%s)",
        (uhex(rid), uhex(uid), rtype, f"{TAG} res", f"{TAG} topic",
         json.dumps({"k": 1}, ensure_ascii=False), json.dumps([], ensure_ascii=False),
         json.dumps(state, ensure_ascii=False), is_public, scope, archived),
    )


def insert_glr_state(rid, uid, state):
    cur.execute(
        "INSERT INTO learning_resource_user_state(resource_id,user_id,state_json,updated_at) "
        "VALUES(UNHEX(%s),UNHEX(%s),CAST(%s AS JSON),NOW(6)) "
        "ON DUPLICATE KEY UPDATE state_json=VALUES(state_json)",
        (uhex(rid), uhex(uid), json.dumps(state, ensure_ascii=False)),
    )


def insert_ppt(pid, uid, learned, is_public=0, scope="USER", archived=None):
    cur.execute(
        "INSERT INTO presentation_tasks(id,user_id,organization_id,resource_scope,"
        "is_public,title,status,progress,stage_message,error_message,request_json,"
        "learned_json,output_path,created_at,updated_at,archived_at,review_status,"
        "is_template,revision,resume_enabled) "
        "VALUES(UNHEX(%s),UNHEX(%s),NULL,%s,%s,%s,'completed',100,'stage',NULL,"
        "CAST(%s AS JSON),CAST(%s AS JSON),'',%s,%s,%s,'needs_review',0,1,1)",
        (uhex(pid), uhex(uid), scope, is_public, f"{TAG} ppt",
         json.dumps({"tag": TAG}, ensure_ascii=False),
         json.dumps(learned, ensure_ascii=False), NOW_MICRO, NOW_MICRO, archived),
    )


def insert_ppt_state(pid, uid, learned):
    cur.execute(
        "INSERT INTO presentation_task_user_state(task_id,user_id,learned_json,updated_at) "
        "VALUES(UNHEX(%s),UNHEX(%s),CAST(%s AS JSON),NOW(6)) "
        "ON DUPLICATE KEY UPDATE learned_json=VALUES(learned_json)",
        (uhex(pid), uhex(uid), json.dumps(learned, ensure_ascii=False)),
    )


# 8 lecture resource ids for the banker's-rounding matrix
PCT_RES = [f"aaaaaaaa-5{i:03d}-4000-8000-00000000000{i}" for i in range(8)]
QUIZ_RES = "aaaaaaaa-5100-4000-8000-000000000010"
PPT_RES = "aaaaaaaa-5200-4000-8000-000000000020"
VIS_OWN = "aaaaaaaa-5300-4000-8000-000000000030"
VIS_PUB = "aaaaaaaa-5301-4000-8000-000000000031"
VIS_PRIV = "aaaaaaaa-5302-4000-8000-000000000032"
VIS_ARCH = "aaaaaaaa-5303-4000-8000-000000000033"
VIS_ORG = "aaaaaaaa-5304-4000-8000-000000000034"

try:
    # ---- seed ----
    seed_user(USER_A, f"{TAG.lower()}-a@example.com")
    seed_user(USER_B, f"{TAG.lower()}-b@example.com")
    seed_learner(LEARNER_1, USER_A, f"{TAG}-L1")
    seed_learner(LEARNER_2, USER_A, f"{TAG}-L2")

    insert_session(S_OWN, USER_A, LEARNER_1, f"{TAG} 会话一 标题", "running", NOW, NOW_MICRO)
    insert_session(S_OTH, USER_B, LEARNER_1, f"{TAG} 会话B", "running", NOW, NOW)
    insert_session(S_TTL, USER_A, None, f"{TAG} 会话标题", "running", NOW, NOW)
    insert_session(S_CMP, USER_A, None, f"{TAG} 会话完成", "running", NOW, NOW)
    insert_session(S_DEL, USER_A, LEARNER_1, f"{TAG} 会话删除", "running", NOW, NOW)
    insert_session(S_ORP, USER_A, None, f"{TAG} 会话孤儿探针", "running", NOW, NOW)
    insert_session(S_SIB, USER_A, None, f"{TAG} 会话兄弟", "running", NOW, NOW)
    insert_session(S_EMPTY, USER_A, None, f"{TAG} 会话空", "running", NOW, NOW)

    insert_message(M1, S_OWN, USER_A, "planner", "agent", f"{TAG} 消息一 中文 ? emoji", NOW)
    insert_message(M2, S_OWN, USER_A, None, "user", f"{TAG} 消息二", NOW_MICRO)
    insert_decision(D1, S_OWN, USER_A, None, "plan", f"{TAG} 决策一 中文", NOW)

    # delete fixture children
    insert_message("aaaaaaaa-3105-4000-8000-000000000005", S_DEL, USER_A, None, "agent", f"{TAG} 删消息", NOW)
    insert_decision("aaaaaaaa-3205-4000-8000-000000000005", S_DEL, USER_A, None, "act", f"{TAG} 删决策", NOW)

    # course-progress fixtures
    insert_course(C_NONE, USER_A, LEARNER_1, f"{TAG} 空课程", NOW_MICRO, ["lecture"], progress=50)
    insert_chapter("aaaaaaaa-4101-4000-8000-000000000001", C_NONE, 1, {}, NOW_MICRO)

    insert_course(C_OLD, USER_A, LEARNER_1, f"{TAG} 旧课程", "2020-01-01 00:00:00", ["lecture"])
    insert_chapter("aaaaaaaa-4106-4000-8000-000000000006", C_OLD, 1,
                   {"lecture": {"id": GHOST, "status": "completed"}}, "2020-01-01 00:00:00")

    insert_course(C_PCT, USER_A, LEARNER_1, f"{TAG} 进度课程", NOW_MICRO_2, ["lecture"])
    for i, rid in enumerate(PCT_RES, 1):
        insert_chapter(f"aaaaaaaa-45{i:02d}-4000-8000-00000000000{i}",
                       C_PCT, i, {"lecture": {"id": rid, "status": "completed"}}, NOW_MICRO_2)
        insert_glr(rid, USER_A, "lecture", {"learned": False})
        insert_glr_state(rid, USER_A, {"learned": False})

    insert_course(C_QZ, USER_A, LEARNER_2, f"{TAG} 测验课程", NOW_MICRO, ["quiz"])
    insert_chapter("aaaaaaaa-4120-4000-8000-000000000020", C_QZ, 1,
                   {"quiz": {"id": QUIZ_RES, "status": "completed"}}, NOW_MICRO)
    insert_glr(QUIZ_RES, USER_A, "quiz", {"learned": False})
    insert_glr_state(QUIZ_RES, USER_A, {"learned": False, "completed": True})

    insert_course(C_PPT, USER_A, LEARNER_2, f"{TAG} PPT课程", NOW_MICRO_2, ["ppt"])
    insert_chapter("aaaaaaaa-4121-4000-8000-000000000021", C_PPT, 1,
                   {"ppt": {"id": PPT_RES, "status": "completed"}}, NOW_MICRO_2)
    insert_ppt(PPT_RES, USER_A, {"learned": False})
    insert_ppt_state(PPT_RES, USER_A, {"learned": True, "learnedAt": "2026-01-01T00:00:00"})

    insert_course(C_B, USER_B, LEARNER_1, f"{TAG} B课程", NOW_MICRO, ["lecture"])
    insert_chapter("bbbbbbbb-4130-4000-8000-000000000030", C_B, 1,
                   {"lecture": {"id": PCT_RES[0], "status": "completed"}}, NOW_MICRO)

    # visibility probes: 5 resources, only own+public visible; user_state says learned for all
    insert_course(C_VIS, USER_A, LEARNER_1, f"{TAG} 可见性课程", NOW_MICRO, ["lecture"])
    for i, (rid, owner, is_pub, scope, arch) in enumerate([
        (VIS_OWN, USER_A, 0, "USER", None),
        (VIS_PUB, USER_B, 1, "USER", None),
        (VIS_PRIV, USER_B, 0, "USER", None),
        (VIS_ARCH, USER_A, 0, "USER", NOW_MICRO),
        (VIS_ORG, USER_A, 0, "ORGANIZATION", None),
    ], 1):
        insert_chapter(f"aaaaaaaa-414{i}-4000-8000-00000000004{i}", C_VIS, i,
                       {"lecture": {"id": rid, "status": "completed"}}, NOW_MICRO)
        insert_glr(rid, owner, "lecture", {"learned": False}, is_public=is_pub, scope=scope, archived=arch)
        insert_glr_state(rid, USER_A, {"learned": True})

    # ---- auth ----
    st, body, _ = req("GET", "/v1/agent-sessions")
    check("list no token 401", st == 401 and body.get("detail") == "Bearer token required", f"{st} {body}")
    st, body, _ = req("GET", "/v1/agent-sessions", "not-a-jwt")
    check("list bad token 401", st == 401 and body.get("detail") == "Invalid or expired token", f"{st} {body}")
    st, body, _ = req("POST", "/v1/agent-sessions", None, {})
    check("create no token 401", st == 401, f"{st} {body}")
    st, body, _ = req("GET", "/v1/course-progress")
    check("progress no token 401", st == 401, f"{st} {body}")

    # ---- create ----
    st, body, _ = req("POST", "/v1/agent-sessions", tok_a, {})
    ok = st == 201 and isinstance(body, dict) and body.get("sessionType") == "agent"
    check("create defaults 201", ok, f"{st} {str(body)[:160]}")
    created1 = body.get("id") if ok else None
    check("create default status running", body.get("status") == "running", body.get("status"))
    check("create default title null", body.get("title") is None, body.get("title"))
    check("create default learnerId null", body.get("learnerId") is None, body.get("learnerId"))
    check("create has messages array", isinstance(body.get("messages"), list), type(body.get("messages")))
    check("create has decisions array", isinstance(body.get("decisions"), list), type(body.get("decisions")))
    check("create has createdAt", bool(body.get("createdAt")), body.get("createdAt"))
    check("create has updatedAt", bool(body.get("updatedAt")), body.get("updatedAt"))
    check("create iso naive ts", "T" in (body.get("createdAt") or "") and "Z" not in (body.get("createdAt") or ""),
          body.get("createdAt"))

    # learner_id HAS validation_alias learnerId (camel binds). session_type does
    # NOT (measured: camel sessionType ignored -> default "agent"; same class as
    # fastapi_ref_422.json "msg agentId too long" -> 200).
    st, body, _ = req("POST", "/v1/agent-sessions", tok_a, {"learnerId": LEARNER_1, "sessionType": "agent-dock", "title": f"{TAG} 新建"})
    ok = (st == 201 and body.get("learnerId") == LEARNER_1
          and body.get("sessionType") == "agent" and body.get("title") == f"{TAG} 新建")
    check("create camel learnerId binds, sessionType ignored", ok, f"{st} {str(body)[:160]}")
    created2 = body.get("id") if st == 201 else None

    st, body, _ = req("POST", "/v1/agent-sessions", tok_a, {"learner_id": LEARNER_2})
    check("create snake learner_id accepted", st == 201 and body.get("learnerId") == LEARNER_2, f"{st} {body.get('learnerId')}")

    st, body, _ = req("POST", "/v1/agent-sessions", tok_a, {"learnerId": None, "title": None})
    check("create optional nulls ok", st == 201 and body.get("sessionType") == "agent" and body.get("title") is None
          and body.get("learnerId") is None, f"{st} {str(body)[:120]}")
    # session_type is `str` (not Optional) — explicit null must 422, not fall
    # back to default. Only the snake key binds; camel sessionType is ignored
    # (fastapi_ref_422.json "sess session_type null" -> 422 string_type).
    st, body, _ = req("POST", "/v1/agent-sessions", tok_a, {"session_type": None})
    it = vitem(body)
    check("create session_type null 422", st == 422 and it.get("type") == "string_type"
          and it.get("loc") == ["body", "session_type"] and it.get("msg") == "Input should be a valid string",
          f"{st} {str(body)[:140]}")
    st, body, _ = req("POST", "/v1/agent-sessions", tok_a, {"sessionType": None})
    check("create camel sessionType null ignored 201", st == 201 and body.get("sessionType") == "agent",
          f"{st} {str(body)[:100]}")

    st, body, _ = req("POST", "/v1/agent-sessions", tok_a, {"unknown": 1, "title": f"{TAG} 忽略"})
    check("create extra keys ignored", st == 201 and body.get("title") == f"{TAG} 忽略", f"{st} {body.get('title')}")

    st, body, _ = req("POST", "/v1/agent-sessions", tok_a, {"learnerId": "not-a-uuid"})
    it = vitem(body)
    check("create bad learnerId 422", st == 422, f"{st} {body}")
    check("create bad learnerId msg", it.get("type") == "uuid_parsing" and it.get("loc") == ["body", "learnerId"]
          and str(it.get("msg", "")).startswith("Input should be a valid UUID"), body)

    st, body, _ = req("POST", "/v1/agent-sessions", tok_a, {"session_type": "x" * 33})
    it = vitem(body)
    check("create session_type 33 422", st == 422 and it.get("type") == "string_too_long"
          and it.get("loc") == ["body", "session_type"], f"{st} {str(body)[:120]}")
    st, body, _ = req("POST", "/v1/agent-sessions", tok_a, {"sessionType": "x" * 33})
    check("create camel sessionType 33 ignored 201", st == 201 and body.get("sessionType") == "agent",
          f"{st} {str(body)[:100]}")
    st, body, _ = req("POST", "/v1/agent-sessions", tok_a, {"title": "x" * 256})
    check("create title 256 422", st == 422, f"{st} {str(body)[:120]}")
    st, body, _ = req("POST", "/v1/agent-sessions", tok_a, {"title": 123})
    it = vitem(body)
    check("create title non-string 422", st == 422 and it.get("type") == "string_type"
          and it.get("loc") == ["body", "title"] and it.get("msg") == "Input should be a valid string",
          f"{st} {str(body)[:140]}")

    # ---- list ----
    st, body, _ = req("GET", "/v1/agent-sessions", tok_a)
    sess = body.get("sessions") if isinstance(body, dict) else None
    check("list 200 sessions key", st == 200 and isinstance(sess, list), f"{st} {type(sess)}")
    ids_a = [s.get("id") for s in (sess or [])]
    check("list A sees own", S_OWN in ids_a and S_TTL in ids_a, f"n={len(ids_a)}")
    check("list A does not see B", S_OTH not in ids_a, "")
    # newest by updated_at: S_OWN has NOW_MICRO, others NOW — S_OWN should be first among seeded
    check("list order updated_at DESC", ids_a.index(S_OWN) < ids_a.index(S_TTL) if (S_OWN in ids_a and S_TTL in ids_a) else False,
          ids_a[:5])

    st, body, _ = req("GET", "/v1/agent-sessions", tok_b)
    ids_b = [s.get("id") for s in (body.get("sessions") or [])] if isinstance(body, dict) else []
    check("list B sees only own", S_OTH in ids_b and S_OWN not in ids_b, f"n={len(ids_b)}")

    # ---- get ----
    st, body, _ = req("GET", f"/v1/agent-sessions/{S_OWN}", tok_a)
    check("get 200", st == 200 and body.get("id") == S_OWN, f"{st} {body.get('id')}")
    check("get title", body.get("title") == f"{TAG} 会话一 标题", body.get("title"))
    check("get learnerId", body.get("learnerId") == LEARNER_1, body.get("learnerId"))
    check("get sessionType", body.get("sessionType") == "agent", body.get("sessionType"))
    check("get status", body.get("status") == "running", body.get("status"))
    msgs = body.get("messages") or []
    check("get messages n=2", len(msgs) == 2, len(msgs))
    check("msg field keys", set(msgs[0].keys()) == {"id", "agentId", "kind", "content", "createdAt"}, set(msgs[0].keys()))
    check("msg agentId present", msgs[0].get("agentId") == "planner", msgs[0].get("agentId"))
    check("msg agentId null", msgs[1].get("agentId") is None, msgs[1].get("agentId"))
    check("msg content chinese", msgs[0].get("content") == f"{TAG} 消息一 中文 ? emoji", msgs[0].get("content"))
    check("msg order created_at", msgs[0].get("id") == M1 and msgs[1].get("id") == M2, [m.get("id") for m in msgs])
    decs = body.get("decisions") or []
    check("decisions n=1", len(decs) == 1, len(decs))
    check("dec field keys", set(decs[0].keys()) == {"id", "stage", "text", "createdAt"}, set(decs[0].keys()))
    check("dec stage/text", decs[0].get("stage") == "plan" and decs[0].get("text") == f"{TAG} 决策一 中文", decs[0])

    st, body, _ = req("GET", f"/v1/agent-sessions/{S_EMPTY}", tok_a)
    check("get empty messages", body.get("messages") == [] and body.get("decisions") == [], (body.get("messages"), body.get("decisions")))

    st, body, _ = req("GET", f"/v1/agent-sessions/{GHOST}", tok_a)
    check("get missing 404", st == 404 and body.get("detail") == "Agent session not found", f"{st} {body}")
    st, body, _ = req("GET", f"/v1/agent-sessions/{S_OTH}", tok_a)
    check("get other user 404", st == 404 and body.get("detail") == "Agent session not found", f"{st} {body}")
    st, body, _ = req("GET", "/v1/agent-sessions/not-a-uuid", tok_a)
    check("get bad uuid 422", st == 422, f"{st} {str(body)[:120]}")

    # ---- patch title ----
    st, body, _ = req("PATCH", f"/v1/agent-sessions/{S_TTL}", tok_a, {"title": f"{TAG} 新标题 ?"})
    check("patch title 200", st == 200 and body.get("title") == f"{TAG} 新标题 ?", f"{st} {body.get('title')}")
    check("patch keeps messages field", isinstance(body.get("messages"), list), body.get("messages"))

    st, body, _ = req("PATCH", f"/v1/agent-sessions/{S_TTL}", tok_a, {"title": "  a   b\t\nc  "})
    check("patch collapse ws", st == 200 and body.get("title") == "a b c", repr(body.get("title")))

    st, body, _ = req("PATCH", f"/v1/agent-sessions/{S_TTL}", tok_a, {"title": "   \t\n  "})
    before = count("SELECT COUNT(*) FROM agent_sessions WHERE id=UNHEX(%s) AND title=%s",
                   uhex(S_TTL), "a b c")
    check("patch all-ws 200 unchanged", st == 200 and body.get("title") == "a b c", f"{st} {repr(body.get('title'))}")
    check("patch all-ws no write", before == 1, before)

    st, body, _ = req("PATCH", f"/v1/agent-sessions/{S_TTL}", tok_a, {"title": "x" * 255})
    check("patch title 255 ok", st == 200 and len(body.get("title") or "") == 255, len(body.get("title") or ""))
    st, body, _ = req("PATCH", f"/v1/agent-sessions/{S_TTL}", tok_a, {"title": "x" * 256})
    check("patch title 256 422", st == 422, f"{st} {str(body)[:120]}")
    st, body, _ = req("PATCH", f"/v1/agent-sessions/{S_TTL}", tok_a, {"title": ""})
    check("patch title empty 422", st == 422 and "at least 1 character" in json.dumps(body), f"{st} {str(body)[:120]}")
    # Measured envelope (fastapi_ref_422.json "sessup missing title" /
    # "sessup title null"): msg is the bare pydantic text, loc names the field.
    st, body, _ = req("PATCH", f"/v1/agent-sessions/{S_TTL}", tok_a, {})
    it = vitem(body)
    check("patch title missing 422", st == 422 and it.get("type") == "missing"
          and it.get("loc") == ["body", "title"] and it.get("msg") == "Field required",
          f"{st} {str(body)[:140]}")
    st, body, _ = req("PATCH", f"/v1/agent-sessions/{S_TTL}", tok_a, {"title": 9})
    it = vitem(body)
    check("patch title non-string 422", st == 422 and it.get("type") == "string_type"
          and it.get("loc") == ["body", "title"] and it.get("msg") == "Input should be a valid string",
          f"{st} {str(body)[:140]}")

    # collapse + truncate to 255 runes
    long_cjk = "课" * 300
    st, body, _ = req("PATCH", f"/v1/agent-sessions/{S_TTL}", tok_a, {"title": long_cjk})
    check("patch 300 cjk 422 raw len", st == 422, f"{st} {str(body)[:100]}")
    spaced = ("  " + "课" * 300 + "  ")
    st, body, _ = req("PATCH", f"/v1/agent-sessions/{S_TTL}", tok_a, {"title": spaced})
    check("patch spaced 300 cjk 422", st == 422, f"{st} {str(body)[:100]}")
    # 256 runes of 'a' with lots of spaces that collapse to 256 -> store truncates to 255
    wrap = "  " + "a" * 256 + "  "
    st, body, _ = req("PATCH", f"/v1/agent-sessions/{S_TTL}", tok_a, {"title": wrap})
    check("patch wrap 256 a raw 262 422", st == 422, f"{st} {str(body)[:80]}")
    # raw len 255 but collapses to 253 then keeps 253 (under cap)
    wrap2 = "  " + "b" * 251 + "  "
    st, body, _ = req("PATCH", f"/v1/agent-sessions/{S_TTL}", tok_a, {"title": wrap2})
    check("patch wrap collapses under cap", st == 200 and body.get("title") == "b" * 251, len(body.get("title") or ""))

    st, body, _ = req("PATCH", f"/v1/agent-sessions/{GHOST}", tok_a, {"title": "x"})
    check("patch missing 404", st == 404 and body.get("detail") == "Agent session not found", f"{st} {body}")
    st, body, _ = req("PATCH", f"/v1/agent-sessions/{S_OTH}", tok_a, {"title": "x"})
    check("patch other user 404", st == 404, f"{st} {body}")
    still = count("SELECT COUNT(*) FROM agent_sessions WHERE id=UNHEX(%s) AND title=%s",
                  uhex(S_OTH), f"{TAG} 会话B")
    check("patch other user no write", still == 1, still)

    # ---- complete ----
    st, body, _ = req("POST", f"/v1/agent-sessions/{S_CMP}/complete", tok_a)
    check("complete 200", st == 200 and body.get("status") == "completed", f"{st} {body.get('status')}")
    check("complete returns session", body.get("id") == S_CMP, body.get("id"))
    st, body, _ = req("POST", f"/v1/agent-sessions/{S_CMP}/complete", tok_a)
    check("complete again 200", st == 200 and body.get("status") == "completed", f"{st} {body.get('status')}")
    st, body, _ = req("POST", f"/v1/agent-sessions/{GHOST}/complete", tok_a)
    check("complete missing 404", st == 404 and body.get("detail") == "Agent session not found", f"{st} {body}")
    st, body, _ = req("POST", f"/v1/agent-sessions/{S_OTH}/complete", tok_a)
    check("complete other user 404", st == 404, f"{st} {body}")

    # ---- messages list / append ----
    st, body, _ = req("GET", f"/v1/agent-sessions/{S_EMPTY}/messages", tok_a)
    check("messages list empty", st == 200 and body == {"messages": []}, f"{st} {body}")
    st, body, _ = req("GET", f"/v1/agent-sessions/{S_OWN}/messages", tok_a)
    check("messages list 200", st == 200 and isinstance(body.get("messages"), list) and len(body["messages"]) == 2,
          len(body.get("messages") or []))
    st, body, _ = req("GET", f"/v1/agent-sessions/{GHOST}/messages", tok_a)
    check("messages missing 404", st == 404 and body.get("detail") == "Agent session not found", f"{st} {body}")
    st, body, _ = req("GET", f"/v1/agent-sessions/{S_OTH}/messages", tok_a)
    check("messages other user 404", st == 404, f"{st} {body}")

    st, body, _ = req("POST", f"/v1/agent-sessions/{S_EMPTY}/messages", tok_a, {"content": f"{TAG} 追加消息"})
    ok = st == 201 and isinstance(body, dict) and body.get("id") == S_EMPTY
    check("append message 201 session", ok, f"{st} {str(body)[:120]}")
    msgs = (body or {}).get("messages") or []
    check("append message appears", len(msgs) == 1 and msgs[0].get("content") == f"{TAG} 追加消息", msgs)
    check("append message defaults kind=agent", msgs and msgs[0].get("kind") == "agent", msgs[0].get("kind") if msgs else None)
    check("append message default agentId null", msgs and msgs[0].get("agentId") is None, msgs[0].get("agentId") if msgs else None)

    st, body, _ = req("POST", f"/v1/agent-sessions/{S_EMPTY}/messages", tok_a,
                      {"agentId": "tutor", "kind": "user", "content": "x" * 10000})
    msgs = (body or {}).get("messages") or []
    check("append message 10000 ok", st == 201 and msgs[-1].get("kind") == "user" and len(msgs[-1].get("content") or "") == 10000,
          (st, len(msgs)))
    st, body, _ = req("POST", f"/v1/agent-sessions/{S_EMPTY}/messages", tok_a, {"content": "x" * 10001})
    check("append message 10001 422", st == 422, f"{st} {str(body)[:100]}")
    st, body, _ = req("POST", f"/v1/agent-sessions/{S_EMPTY}/messages", tok_a, {"content": ""})
    check("append message empty 422", st == 422 and "at least 1 character" in json.dumps(body), f"{st} {str(body)[:100]}")
    st, body, _ = req("POST", f"/v1/agent-sessions/{S_EMPTY}/messages", tok_a, {"kind": "x" * 33, "content": "y"})
    check("append message kind 33 422", st == 422, f"{st} {str(body)[:100]}")
    st, body, _ = req("POST", f"/v1/agent-sessions/{S_EMPTY}/messages", tok_a, {"kind": None, "content": "y"})
    it = vitem(body)
    check("append message kind null 422", st == 422 and it.get("type") == "string_type"
          and it.get("loc") == ["body", "kind"] and it.get("msg") == "Input should be a valid string",
          f"{st} {str(body)[:140]}")
    # agent_id has NO validation_alias — camel agentId is extra=ignore, so the
    # 65-char value never reaches the validator (fastapi_ref_422.json
    # "msg agentId too long" -> 200; snake "msg agent_id too long" -> 422).
    st, body, _ = req("POST", f"/v1/agent-sessions/{S_EMPTY}/messages", tok_a, {"agentId": "a" * 65, "content": "y"})
    check("append message camel agentId 65 ignored 201", st == 201, f"{st} {str(body)[:100]}")
    st, body, _ = req("POST", f"/v1/agent-sessions/{S_EMPTY}/messages", tok_a, {"agent_id": "a" * 65, "content": "y"})
    it = vitem(body)
    check("append message snake agent_id 65 422", st == 422 and it.get("type") == "string_too_long"
          and it.get("loc") == ["body", "agent_id"], f"{st} {str(body)[:140]}")
    st, body, _ = req("POST", f"/v1/agent-sessions/{S_EMPTY}/messages", tok_a, {})
    it = vitem(body)
    check("append message missing content 422", st == 422 and it.get("type") == "missing"
          and it.get("loc") == ["body", "content"] and it.get("msg") == "Field required",
          f"{st} {str(body)[:140]}")

    # fail closed: no orphan insert
    before_orp = count("SELECT COUNT(*) FROM agent_messages WHERE session_id=UNHEX(%s)", uhex(GHOST))
    st, body, _ = req("POST", f"/v1/agent-sessions/{GHOST}/messages", tok_a, {"content": "orphan?"})
    after_orp = count("SELECT COUNT(*) FROM agent_messages WHERE session_id=UNHEX(%s)", uhex(GHOST))
    check("append missing 404", st == 404 and body.get("detail") == "Agent session not found", f"{st} {body}")
    check("append missing no orphan", before_orp == 0 and after_orp == 0, (before_orp, after_orp))

    before_oth = count("SELECT COUNT(*) FROM agent_messages WHERE session_id=UNHEX(%s)", uhex(S_OTH))
    st, body, _ = req("POST", f"/v1/agent-sessions/{S_OTH}/messages", tok_a, {"content": "steal"})
    after_oth = count("SELECT COUNT(*) FROM agent_messages WHERE session_id=UNHEX(%s)", uhex(S_OTH))
    check("append other user 404", st == 404, f"{st} {body}")
    check("append other user no write", before_oth == after_oth == 0, (before_oth, after_oth))

    # ---- decisions ----
    st, body, _ = req("GET", f"/v1/agent-sessions/{S_EMPTY}/decisions", tok_a)
    check("decisions list empty", st == 200 and body == {"decisions": []}, f"{st} {body}")
    st, body, _ = req("GET", f"/v1/agent-sessions/{S_OWN}/decisions", tok_a)
    check("decisions list 200", st == 200 and len(body.get("decisions") or []) == 1, body)
    st, body, _ = req("GET", f"/v1/agent-sessions/{GHOST}/decisions", tok_a)
    check("decisions missing 404", st == 404, f"{st} {body}")

    st, body, _ = req("POST", f"/v1/agent-sessions/{S_EMPTY}/decisions", tok_a,
                      {"stage": "review", "text": f"{TAG} 追加决策"})
    ok = st == 201 and body.get("id") == S_EMPTY
    check("append decision 201 session", ok, f"{st} {str(body)[:120]}")
    decs = (body or {}).get("decisions") or []
    check("append decision appears", len(decs) == 1 and decs[0].get("stage") == "review", decs)
    check("append decision has no learnerId", "learnerId" not in (decs[0] if decs else {}), decs[0] if decs else None)
    check("append decision text", decs and decs[0].get("text") == f"{TAG} 追加决策", decs[0].get("text") if decs else None)

    st, body, _ = req("POST", f"/v1/agent-sessions/{S_EMPTY}/decisions", tok_a, {"stage": "", "text": "x"})
    check("append decision empty stage 422", st == 422 and "at least 1 character" in json.dumps(body), f"{st} {str(body)[:100]}")
    st, body, _ = req("POST", f"/v1/agent-sessions/{S_EMPTY}/decisions", tok_a, {"stage": "s" * 33, "text": "x"})
    check("append decision stage 33 422", st == 422, f"{st} {str(body)[:100]}")
    st, body, _ = req("POST", f"/v1/agent-sessions/{S_EMPTY}/decisions", tok_a, {"stage": "s", "text": "x" * 1001})
    check("append decision text 1001 422", st == 422, f"{st} {str(body)[:100]}")
    st, body, _ = req("POST", f"/v1/agent-sessions/{S_EMPTY}/decisions", tok_a, {"stage": "s"})
    it = vitem(body)
    check("append decision missing text 422", st == 422 and it.get("type") == "missing"
          and it.get("loc") == ["body", "text"] and it.get("msg") == "Field required",
          f"{st} {str(body)[:140]}")
    st, body, _ = req("POST", f"/v1/agent-sessions/{S_EMPTY}/decisions", tok_a, {"text": "x"})
    it = vitem(body)
    check("append decision missing stage 422", st == 422 and it.get("type") == "missing"
          and it.get("loc") == ["body", "stage"] and it.get("msg") == "Field required",
          f"{st} {str(body)[:140]}")

    before_od = count("SELECT COUNT(*) FROM agent_decisions WHERE session_id=UNHEX(%s)", uhex(GHOST))
    st, body, _ = req("POST", f"/v1/agent-sessions/{GHOST}/decisions", tok_a, {"stage": "s", "text": "orphan?"})
    after_od = count("SELECT COUNT(*) FROM agent_decisions WHERE session_id=UNHEX(%s)", uhex(GHOST))
    check("append decision missing 404", st == 404, f"{st} {body}")
    check("append decision missing no orphan", before_od == after_od == 0, (before_od, after_od))

    # ---- delete ----
    st, body, _ = req("DELETE", f"/v1/agent-sessions/{GHOST}", tok_a)
    check("delete missing 404", st == 404 and body.get("detail") == "Agent session not found", f"{st} {body}")
    st, body, _ = req("DELETE", f"/v1/agent-sessions/{S_OTH}", tok_a)
    check("delete other user 404", st == 404, f"{st} {body}")
    check("delete other user keeps row", count("SELECT COUNT(*) FROM agent_sessions WHERE id=UNHEX(%s)", uhex(S_OTH)) == 1, "")

    st, body, _ = req("DELETE", f"/v1/agent-sessions/{S_DEL}", tok_a)
    check("delete 204", st == 204, st)
    check("delete 204 empty body", body is None, body)
    check("delete removed session row", count("SELECT COUNT(*) FROM agent_sessions WHERE id=UNHEX(%s)", uhex(S_DEL)) == 0, "")
    check("delete cascaded messages", count("SELECT COUNT(*) FROM agent_messages WHERE session_id=UNHEX(%s)", uhex(S_DEL)) == 0, "")
    check("delete cascaded decisions", count("SELECT COUNT(*) FROM agent_decisions WHERE session_id=UNHEX(%s)", uhex(S_DEL)) == 0, "")
    st, body, _ = req("GET", f"/v1/agent-sessions/{S_DEL}", tok_a)
    check("get after delete 404", st == 404, st)
    st, body, _ = req("DELETE", f"/v1/agent-sessions/{S_DEL}", tok_a)
    check("delete again 404", st == 404, st)
    st, body, _ = req("GET", f"/v1/agent-sessions/{S_SIB}", tok_a)
    check("sibling session intact", st == 200 and body.get("title") == f"{TAG} 会话兄弟", f"{st} {body.get('title')}")

    # ---- course-progress ----
    st, body, _ = req("GET", "/v1/course-progress", tok_a)
    check("progress A defaults 200", st == 200 and isinstance(body, dict), f"{st} {body}")
    check("progress has keys", set(body.keys()) >= {"courseId", "courseTitle", "total", "completed", "percent"},
          set(body.keys()))

    st, body, _ = req("GET", f"/v1/course-progress?learnerId={LEARNER_1}", tok_a)
    check("progress learner1 latest is C_PCT", body.get("courseId") == C_PCT, body.get("courseId"))

    st, body, _ = req("GET", "/v1/course-progress?learnerId=not-a-uuid", tok_a)
    it = vitem(body)
    check("progress bad learnerId 422", st == 422 and it.get("type") == "uuid_parsing"
          and it.get("loc") == ["query", "learnerId"]
          and str(it.get("msg", "")).startswith("Input should be a valid UUID"),
          f"{st} {str(body)[:140]}")

    st, body, _ = req("GET", f"/v1/course-progress?learnerId={LEARNER_2}", tok_b)
    check("progress B no course zeros", body == {"total": 0, "completed": 0, "percent": 0}, body)

    st, body, _ = req("GET", "/v1/course-progress", tok_b)
    check("progress B default course", body.get("courseId") == C_B and body.get("total") == 1, body)

    # C_OLD must not win over C_PCT (updated_at DESC)
    st, body, _ = req("GET", f"/v1/course-progress?learnerId={LEARNER_1}", tok_a)
    check("progress latest by updated_at", body.get("courseId") == C_PCT, body.get("courseId"))
    check("progress C_PCT total 8", body.get("total") == 8, body.get("total"))
    check("progress C_PCT completed 0", body.get("completed") == 0, body.get("completed"))
    check("progress C_PCT percent 0", body.get("percent") == 0, body.get("percent"))

    def set_learned(n):
        for i, rid in enumerate(PCT_RES):
            insert_glr_state(rid, USER_A, {"learned": i < n})

    for n, expect in [(1, 12), (3, 38), (5, 62), (7, 88), (8, 100), (0, 0), (2, 25), (6, 75)]:
        set_learned(n)
        st, body, _ = req("GET", f"/v1/course-progress?learnerId={LEARNER_1}", tok_a)
        check(f"percent n={n} -> {expect}", body.get("percent") == expect and body.get("completed") == n,
              f"{body.get('completed')}/{body.get('total')} = {body.get('percent')}")

    # quiz: learned=false but completed=true still counts.
    # C_PPT has a later updated_at than C_QZ, so isolate C_QZ first — otherwise
    # latest-by-updated_at correctly picks C_PPT and the quiz course is never read.
    cur.execute("UPDATE generated_courses SET learner_id=UNHEX(%s) WHERE id=UNHEX(%s)",
                (uhex("77777777-7777-4777-8777-777777777777"), uhex(C_PPT)))
    st, body, _ = req("GET", f"/v1/course-progress?learnerId={LEARNER_2}", tok_a)
    check("quiz completed counts as learned", body.get("courseId") == C_QZ and body.get("completed") == 1,
          f"{body.get('courseId')} {body.get('completed')}/{body.get('total')}")
    check("quiz percent 100", body.get("percent") == 100, body.get("percent"))
    cur.execute("UPDATE generated_courses SET learner_id=UNHEX(%s) WHERE id=UNHEX(%s)",
                (uhex(LEARNER_2), uhex(C_PPT)))

    # ppt uses presentation_task_user_state even for the owner
    insert_ppt_state(PPT_RES, USER_A, {"learned": True})
    # C_QZ is older than C_PPT, so flip C_QZ away to make C_PPT the only learner2 course.
    cur.execute("UPDATE generated_courses SET learner_id=UNHEX(%s) WHERE id=UNHEX(%s)",
                (uhex("99999999-9999-4999-8999-999999999999"), uhex(C_QZ)))
    st, body, _ = req("GET", f"/v1/course-progress?learnerId={LEARNER_2}", tok_a)
    check("ppt user_state learned", body.get("courseId") == C_PPT and body.get("completed") == 1,
          f"{body.get('courseId')} {body.get('completed')}/{body.get('total')}")
    check("ppt percent 100", body.get("percent") == 100, body.get("percent"))
    cur.execute("UPDATE generated_courses SET learner_id=UNHEX(%s) WHERE id=UNHEX(%s)",
                (uhex(LEARNER_2), uhex(C_QZ)))

    # empty course → zeros-ish (total 0)
    cur.execute("UPDATE generated_courses SET learner_id=UNHEX(%s) WHERE id=UNHEX(%s)",
                (uhex("88888888-8888-4888-8888-888888888888"), uhex(C_PCT)))
    cur.execute("UPDATE generated_courses SET learner_id=UNHEX(%s) WHERE id=UNHEX(%s)",
                (uhex("88888888-8888-4888-8888-888888888888"), uhex(C_OLD)))
    cur.execute("UPDATE generated_courses SET learner_id=UNHEX(%s) WHERE id=UNHEX(%s)",
                (uhex("88888888-8888-4888-8888-888888888888"), uhex(C_VIS)))
    st, body, _ = req("GET", f"/v1/course-progress?learnerId={LEARNER_1}", tok_a)
    check("empty course total 0", body.get("courseId") == C_NONE and body.get("total") == 0, body)
    check("empty course percent 0", body.get("percent") == 0 and body.get("completed") == 0, body)

    # visibility: only own + public count; user_state says learned for all 5
    cur.execute("UPDATE generated_courses SET learner_id=UNHEX(%s) WHERE id=UNHEX(%s)",
                (uhex(LEARNER_1), uhex(C_VIS)))
    cur.execute("UPDATE generated_courses SET updated_at='2030-01-01 00:00:00' WHERE id=UNHEX(%s)", (uhex(C_VIS),))
    st, body, _ = req("GET", f"/v1/course-progress?learnerId={LEARNER_1}", tok_a)
    check("visibility course selected", body.get("courseId") == C_VIS, body.get("courseId"))
    check("visibility total 5", body.get("total") == 5, body.get("total"))
    check("visibility completed 2 (own+public)", body.get("completed") == 2, body.get("completed"))
    check("visibility percent 40", body.get("percent") == 40, body.get("percent"))

    # ---- DB readback ----
    cur.execute("SELECT title,status FROM agent_sessions WHERE id=UNHEX(%s)", (uhex(S_CMP),))
    row = cur.fetchone()
    check("db readback completed", row is not None and row[1] == "completed", row)
    cur.execute("SELECT COUNT(*) FROM agent_messages WHERE session_id=UNHEX(%s)", (uhex(S_EMPTY),))
    n = cur.fetchone()[0]
    # default + 10000-char + the camel agentId-65 one (camel is extra=ignore, so
    # it DOES insert — measured "msg agentId too long" -> 200). The snake
    # agent_id-65 case is the one that 422s and does not insert.
    check("db readback messages appended", n == 3, n)
    cur.execute("SELECT COUNT(*) FROM agent_decisions WHERE session_id=UNHEX(%s)", (uhex(S_EMPTY),))
    n = cur.fetchone()[0]
    check("db readback decisions appended", n == 1, n)
    cur.execute("SELECT title FROM agent_sessions WHERE id=UNHEX(%s)", (uhex(S_TTL),))
    row = cur.fetchone()
    check("db readback collapsed title", row is not None and row[0] == "b" * 251, (row[0][:20] if row else None, len(row[0]) if row else 0))

finally:
    try:
        like = TAG + "%"
        cur.execute("DELETE FROM agent_messages WHERE content LIKE %s", (like,))
        cur.execute("DELETE FROM agent_decisions WHERE text LIKE %s", (like,))
        cur.execute("DELETE FROM agent_sessions WHERE title LIKE %s", (like,))
        cur.execute("DELETE FROM generated_course_chapters WHERE title LIKE %s", (like,))
        cur.execute("DELETE FROM generated_courses WHERE title LIKE %s OR description LIKE %s", (like, like))
        cur.execute("DELETE FROM generated_learning_resources WHERE title LIKE %s", (like,))
        state_ids = [uhex(r) for r in PCT_RES + [QUIZ_RES, VIS_OWN, VIS_PUB, VIS_PRIV, VIS_ARCH, VIS_ORG]]
        fmt = ",".join(["UNHEX(%s)"] * len(state_ids))
        cur.execute(f"DELETE FROM learning_resource_user_state WHERE resource_id IN ({fmt})", tuple(state_ids))
        cur.execute("DELETE FROM presentation_tasks WHERE title LIKE %s", (like,))
        cur.execute("DELETE FROM presentation_task_user_state WHERE task_id=UNHEX(%s)", (uhex(PPT_RES),))
        cur.execute("DELETE FROM learners WHERE name=%s", (TAG,))
        cur.execute("DELETE FROM users WHERE nickname=%s", (TAG,))
        print("cleanup done")
    except Exception as e:
        print("cleanup error", e)

n_pass = sum(1 for _, s, _ in results if s == "PASS")
n_fail = sum(1 for _, s, _ in results if s == "FAIL")
print(f"\n=== {n_pass}/{n_pass + n_fail} passed ===")
for name, st, detail in results:
    if st == "FAIL":
        safe = str(detail).encode("gbk", "replace").decode("gbk", "replace")
        print(f"  FAIL {name} :: {safe}")
sys.exit(1 if n_fail else 0)
