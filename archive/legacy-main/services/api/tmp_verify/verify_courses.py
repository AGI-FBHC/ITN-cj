"""Isolated live matrix for the Spire 「我的学习 · 课程」 read + metadata write-back.

Seeds SPIREVERIFYCO* rows on two known test users only, exercises the 5 routes,
then cleans those rows up. Real rows are never touched.
"""
import os, sys, json, time, hmac, hashlib, base64, urllib.request, urllib.error
import pymysql

BASE = os.environ.get("VERIFY_BASE", "http://127.0.0.1:18811")
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
TAG = "SPIREVERIFYCO" + time.strftime("%H%M%S")
USER_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
USER_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
LEARNER_1 = "33333333-cccc-4ccc-8ccc-cccccccccccc"
LEARNER_2 = "44444444-dddd-4ddd-8ddd-dddddddddddd"
COURSE_1 = "aaaaaaaa-1001-4000-8000-000000000001"   # user A, learner 1, 2 chapters
COURSE_2 = "aaaaaaaa-1002-4000-8000-000000000002"   # user A, learner 2, 1 chapter
COURSE_B = "bbbbbbbb-2001-4000-8000-000000000001"   # user B
CHAP_1A = "aaaaaaaa-1101-4000-8000-000000000001"    # course1 index 2 (inserted first)
CHAP_1B = "aaaaaaaa-1102-4000-8000-000000000002"    # course1 index 1
CHAP_2A = "aaaaaaaa-1201-4000-8000-000000000003"
CHAP_B = "bbbbbbbb-2101-4000-8000-000000000001"
PPT_OWN = "aaaaaaaa-2001-4000-8000-000000000001"    # owned by A, visible to A
PPT_PUB = "aaaaaaaa-2002-4000-8000-000000000002"    # owned by B, is_public=1
PPT_PRIV = "aaaaaaaa-2003-4000-8000-000000000003"   # owned by B, private
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
    url = BASE + path
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
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
    safe = str(detail).encode("gbk", "replace").decode("gbk", "replace")
    print(f"{'PASS' if cond else 'FAIL':4} | {name} | {safe}")


def uhex(u):
    return u.replace("-", "")


print("TAG", TAG, "BASE", BASE)
tok_a = make_jwt(USER_A)
tok_b = make_jwt(USER_B)
conn = pymysql.connect(**DB)
conn.autocommit(True)  # see Spire's committed writes immediately (REPEATABLE READ otherwise)
cur = conn.cursor()

NOW = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
NOW_MICRO = NOW + ".123456"


def insert_course(cid, uid, learner, title, desc, updated, progress=10, status="generating",
                  domain=None, style="none", events="[]", goal_ids="[]"):
    cur.execute(
        "INSERT INTO generated_courses(id,user_id,learner_id,learning_goal_id,"
        "learning_goal_ids_json,title,description,prompt,domain_name,depth,scale,"
        "course_style,resource_types_json,status,progress,stage_message,"
        "current_chapter_id,events_json,error_message,created_at,updated_at) "
        "VALUES(UNHEX(%s),UNHEX(%s),UNHEX(%s),NULL,%s,%s,%s,%s,%s,'standard','medium',"
        "%s,%s,%s,%s,%s,NULL,%s,NULL,%s,%s)",
        (uhex(cid), uhex(uid), uhex(learner) if learner else None, goal_ids, title, desc,
         f"{TAG} prompt 内容",
         (f"{TAG} 领域" if domain is None else domain), style,
         json.dumps(["lecture", "quiz"], ensure_ascii=False), status, progress,
         f"{TAG} 阶段消息", events, NOW, updated),
    )


def insert_chapter(chid, cid, idx, title, summary, resources, updated):
    cur.execute(
        "INSERT INTO generated_course_chapters(id,course_id,chapter_index,title,summary,"
        "objectives_json,sections_json,status,progress,resources_json,created_at,updated_at) "
        "VALUES(UNHEX(%s),UNHEX(%s),%s,%s,%s,%s,%s,'queued',0,%s,%s,%s)",
        (uhex(chid), uhex(cid), idx, title, summary,
         json.dumps([f"{TAG} 目标一"], ensure_ascii=False),
         json.dumps([{"title": f"{TAG} 小节", "summary": "小节摘要"}], ensure_ascii=False),
         json.dumps(resources, ensure_ascii=False), NOW, updated),
    )


def insert_ppt(pid, uid, title, status, progress, error, is_public=0, archived=None):
    cur.execute(
        "INSERT INTO presentation_tasks(id,user_id,organization_id,resource_scope,"
        "is_public,title,status,progress,stage_message,error_message,request_json,"
        "learned_json,output_path,created_at,updated_at,archived_at,review_status,"
        "is_template,revision,resume_enabled) "
        "VALUES(UNHEX(%s),UNHEX(%s),NULL,'USER',%s,%s,%s,%s,%s,%s,"
        "CAST(%s AS JSON),CAST(%s AS JSON),'',%s,%s,%s,"
        "'needs_review',0,1,1)",
        (uhex(pid), uhex(uid), is_public, title, status, progress,
         f"{TAG} stage", error,
         json.dumps({"tag": TAG}, ensure_ascii=False),
         json.dumps({"learned": False}, ensure_ascii=False),
         NOW_MICRO, NOW_MICRO, archived),
    )


def seed_user(uid, email):
    cur.execute(
        "INSERT INTO users (id,email,password_hash,nickname,active,account_type,"
        "created_at,updated_at) VALUES (UNHEX(%s),%s,'x',%s,1,'LEARNER',NOW(6),NOW(6)) "
        "ON DUPLICATE KEY UPDATE email=VALUES(email)",
        (uhex(uid), email, TAG),
    )


try:
    # ---- seed ----
    seed_user(USER_A, f"{TAG.lower()}-a@example.com")
    seed_user(USER_B, f"{TAG.lower()}-b@example.com")
    insert_course(COURSE_1, USER_A, LEARNER_1, f"{TAG} 课程一 标题", f"{TAG} 描述一",
                  NOW_MICRO, progress=42, status="generating", style="systematic",
                  events=json.dumps([{"time": NOW, "title": f"{TAG} 事件", "detail": "d"}],
                                    ensure_ascii=False),
                  goal_ids=json.dumps([GHOST], ensure_ascii=False))
    insert_course(COURSE_2, USER_A, LEARNER_2, f"{TAG} 课程二", "", NOW, progress=0,
                  status="planning", domain="", style="")
    insert_course(COURSE_B, USER_B, None, f"{TAG} 课程B", "B描述", NOW_MICRO)

    # chapter_index 2 inserted before 1 — list must come back ordered
    insert_chapter(CHAP_1A, COURSE_1, 2, f"{TAG} 章二", "章二摘要",
                   {"lecture": {"status": "queued", "progress": 0},
                    "ppt": {"id": PPT_OWN, "status": "queued", "progress": 0,
                            "title": "旧标题", "error": "旧错误"}},
                   NOW)
    insert_chapter(CHAP_1B, COURSE_1, 1, f"{TAG} 章一", "",
                   {"quiz": {"status": "completed", "progress": 100, "id": GHOST},
                    "ppt": {"id": PPT_PRIV, "status": "queued"}},
                   NOW)
    insert_chapter(CHAP_2A, COURSE_2, 1, f"{TAG} 章A", "摘要A",
                   {"ppt": {"id": PPT_PUB, "status": "queued", "progress": 0,
                            "title": "待覆盖", "error": None},
                    "note": "中文 🎉 emoji"},
                   NOW)
    insert_chapter(CHAP_B, COURSE_B, 1, f"{TAG} 章B", "", {}, NOW)

    insert_ppt(PPT_OWN, USER_A, f"{TAG} ppt-owned", "generating", 42, None)
    insert_ppt(PPT_PUB, USER_B, f"{TAG} ppt-public", "completed", 100, None, is_public=1)
    insert_ppt(PPT_PRIV, USER_B, f"{TAG} ppt-private", "failed", 10, f"{TAG} ppt error")

    conn.commit()

    # ---- auth ----
    st, body, _ = req("GET", "/v1/courses")
    check("list no token 401", st == 401, f"{st} {body}")
    st, body, _ = req("GET", "/v1/courses", "not-a-jwt")
    check("list bad token 401", st == 401, f"{st} {body}")
    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}", None, {"title": "x"})
    check("put no token 401", st == 401, f"{st} {body}")

    # ---- GET list ----
    st, body, _ = req("GET", "/v1/courses", tok_a)
    check("list 200", st == 200 and isinstance(body, dict), f"{st} {str(body)[:120]}")
    courses = (body or {}).get("courses") or []
    check("list has courses key", isinstance(courses, list), str(type(courses)))
    check("list A sees 2", len(courses) == 2, f"n={len(courses)}")
    titles = [c.get("title") for c in courses]
    check("list order updated_at DESC", titles == [f"{TAG} 课程一 标题", f"{TAG} 课程二"],
          str(titles))

    st, body, _ = req("GET", "/v1/courses", tok_b)
    check("list B sees 1", len((body or {}).get("courses") or []) == 1,
          str(len((body or {}).get("courses") or [])))
    check("list B title", ((body or {}).get("courses") or [{}])[0].get("title") == f"{TAG} 课程B",
          str(((body or {}).get("courses") or [{}])[0].get("title")))

    st, body, _ = req("GET", f"/v1/courses?learnerId={LEARNER_1}", tok_a)
    c1 = (body or {}).get("courses") or []
    check("list learnerId filter", len(c1) == 1 and c1[0].get("id") == COURSE_1,
          f"n={len(c1)} ids={[c.get('id') for c in c1]}")

    st, body, _ = req("GET", f"/v1/courses?learnerId={LEARNER_2}", tok_a)
    c2 = (body or {}).get("courses") or []
    check("list learnerId filter 2", len(c2) == 1 and c2[0].get("id") == COURSE_2,
          f"n={len(c2)}")

    st, body, _ = req("GET", "/v1/courses?learnerId=not-a-uuid", tok_a)
    check("list bad learnerId 422", st == 422, f"{st} {body}")

    # ---- GET detail ----
    st, body, _ = req("GET", f"/v1/courses/{COURSE_1}", tok_a)
    check("get 200", st == 200 and isinstance(body, dict), f"{st} {str(body)[:120]}")
    c = body or {}
    check("get id", c.get("id") == COURSE_1, str(c.get("id")))
    check("get title", c.get("title") == f"{TAG} 课程一 标题", str(c.get("title")))
    check("get learnerId", c.get("learnerId") == LEARNER_1, str(c.get("learnerId")))
    check("get description", c.get("description") == f"{TAG} 描述一", str(c.get("description")))
    check("get prompt", c.get("prompt") == f"{TAG} prompt 内容", str(c.get("prompt")))
    check("get learningGoalId null", c.get("learningGoalId") is None, str(c.get("learningGoalId")))
    check("get learningGoalIds", c.get("learningGoalIds") == [GHOST], str(c.get("learningGoalIds")))
    check("get domainName", c.get("domainName") == f"{TAG} 领域", str(c.get("domainName")))
    check("get depth/scale", c.get("depth") == "standard" and c.get("scale") == "medium",
          f"{c.get('depth')}/{c.get('scale')}")
    check("get courseStyle", c.get("courseStyle") == "systematic", str(c.get("courseStyle")))
    check("get resourceTypes", c.get("resourceTypes") == ["lecture", "quiz"],
          str(c.get("resourceTypes")))
    check("get status/progress", c.get("status") == "generating" and c.get("progress") == 42,
          f"{c.get('status')}/{c.get('progress')}")
    check("get stageMessage", c.get("stageMessage") == f"{TAG} 阶段消息", str(c.get("stageMessage")))
    check("get errorMessage null", c.get("errorMessage") is None, str(c.get("errorMessage")))
    check("get currentChapterId null", c.get("currentChapterId") is None,
          str(c.get("currentChapterId")))
    check("get events len", isinstance(c.get("events"), list) and len(c["events"]) == 1,
          str(c.get("events"))[:100])
    check("get createdAt present", isinstance(c.get("createdAt"), str) and "T" in c["createdAt"],
          str(c.get("createdAt")))
    check("get updatedAt present", isinstance(c.get("updatedAt"), str) and "T" in c["updatedAt"],
          str(c.get("updatedAt")))
    chs = c.get("chapters") or []
    check("get chapters n=2", len(chs) == 2, f"n={len(chs)}")
    check("get chapters order", [x.get("index") for x in chs] == [1, 2],
          str([x.get("index") for x in chs]))

    ch1 = chs[0] if chs else {}
    check("chapter id", ch1.get("id") == CHAP_1B, str(ch1.get("id")))
    check("chapter title", ch1.get("title") == f"{TAG} 章一", str(ch1.get("title")))
    check("chapter summary empty default", ch1.get("summary") == "", repr(ch1.get("summary")))
    check("chapter objectives", ch1.get("objectives") == [f"{TAG} 目标一"], str(ch1.get("objectives")))
    check("chapter sections", isinstance(ch1.get("sections"), list) and len(ch1["sections"]) == 1,
          str(ch1.get("sections"))[:80])
    check("chapter status/progress", ch1.get("status") == "queued" and ch1.get("progress") == 0,
          f"{ch1.get('status')}/{ch1.get('progress')}")
    res1 = ch1.get("resources") or {}
    check("chapter resources quiz passthrough",
          (res1.get("quiz") or {}).get("status") == "completed"
          and (res1.get("quiz") or {}).get("id") == GHOST,
          str(res1.get("quiz")))
    # PPT_PRIV is owned by B and private → A must NOT get the overlay
    ppt1 = res1.get("ppt") or {}
    check("private ppt not enriched", ppt1.get("status") == "queued"
          and ppt1.get("title") is None and "error" not in ppt1,
          str(ppt1))

    ch2 = chs[1] if len(chs) > 1 else {}
    res2 = ch2.get("resources") or {}
    # PPT_OWN is owned by A → overlay status/progress/title/error from the task row
    ppt2 = res2.get("ppt") or {}
    check("owned ppt enriched status", ppt2.get("status") == "generating", str(ppt2))
    check("owned ppt enriched progress", ppt2.get("progress") == 42, str(ppt2.get("progress")))
    check("owned ppt enriched title", ppt2.get("title") == f"{TAG} ppt-owned", str(ppt2.get("title")))
    check("owned ppt enriched error null", ppt2.get("error") is None, str(ppt2.get("error")))
    check("owned ppt keeps id", ppt2.get("id") == PPT_OWN, str(ppt2.get("id")))

    st, body, _ = req("GET", f"/v1/courses/{COURSE_2}", tok_a)
    if not isinstance(body, dict):
        check("get course2 is object", False, f"st={st} body={str(body)[:400]!r}")
        raise SystemExit(1)
    check("get course2 200", st == 200, f"st={st}")
    chs2 = body.get("chapters")
    if not isinstance(chs2, list) or not chs2 or not isinstance(chs2[0], dict):
        check("course2 chapters is list", False, f"chs={str(chs2)[:300]!r}")
        raise SystemExit(1)
    res = chs2[0].get("resources") or {}
    if not isinstance(res, dict):
        check("course2 resources is object", False, f"res={str(res)[:300]!r}")
        raise SystemExit(1)
    ppt = res.get("ppt") or {}
    # PPT_PUB is public and owned by B → visible to A
    check("public ppt enriched", ppt.get("status") == "completed" and ppt.get("progress") == 100
          and ppt.get("title") == f"{TAG} ppt-public", str(ppt))
    check("chapter note key kept", res.get("note") == "中文 🎉 emoji", str(res.get("note")))
    check("empty domainName defaults", (body or {}).get("domainName") == "当前学习领域",
          str((body or {}).get("domainName")))
    check("empty courseStyle defaults", (body or {}).get("courseStyle") == "none",
          str((body or {}).get("courseStyle")))
    check("empty description stays empty", (body or {}).get("description") == "",
          repr((body or {}).get("description")))

    st, body, _ = req("GET", f"/v1/courses/{COURSE_1}", tok_b)
    check("get other user 404", st == 404 and isinstance(body, dict)
          and body.get("detail") == "Course not found", f"{st} {body}")

    st, body, _ = req("GET", f"/v1/courses/{GHOST}", tok_a)
    check("get missing 404", st == 404 and (body or {}).get("detail") == "Course not found",
          f"{st} {body}")

    st, body, _ = req("GET", "/v1/courses/not-a-uuid", tok_a)
    check("get bad uuid 422", st == 422, f"{st} {body}")

    # ---- PUT course meta ----
    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}", tok_a, {"title": f"{TAG} 新标题 ✨"})
    check("put title 200", st == 200 and (body or {}).get("title") == f"{TAG} 新标题 ✨",
          f"{st} {(body or {}).get('title')}")
    check("put title keeps chapters", len((body or {}).get("chapters") or []) == 2,
          str(len((body or {}).get("chapters") or [])))
    check("put title keeps description", (body or {}).get("description") == f"{TAG} 描述一",
          str((body or {}).get("description")))

    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}", tok_a, {"description": "改过的描述"})
    check("put description 200", st == 200 and (body or {}).get("description") == "改过的描述",
          f"{st} {(body or {}).get('description')}")
    check("put description keeps title", (body or {}).get("title") == f"{TAG} 新标题 ✨",
          str((body or {}).get("title")))

    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}", tok_a,
                      {"title": f"{TAG} 两者标题", "description": "两者描述", "junk": 1})
    check("put both + extra ignored", st == 200
          and (body or {}).get("title") == f"{TAG} 两者标题"
          and (body or {}).get("description") == "两者描述",
          f"{st} {(body or {}).get('title')}/{(body or {}).get('description')}")

    # empty body / explicit null → no write, still 200 with current row
    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}", tok_a, {})
    check("put empty body 200", st == 200 and (body or {}).get("title") == f"{TAG} 两者标题",
          f"{st} {(body or {}).get('title')}")
    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}", tok_a, {"title": None, "description": None})
    check("put nulls 200", st == 200 and (body or {}).get("title") == f"{TAG} 两者标题",
          f"{st} {(body or {}).get('title')}")

    # title whitespace-only → 422 blank_title
    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}", tok_a, {"title": "   "})
    check("put blank title 422", st == 422 and isinstance(body, dict)
          and body.get("code") == "VALIDATION_FAILED", f"{st} {body}")
    check("put blank title msg", "title must not be blank" in json.dumps(body, ensure_ascii=False),
          str(body)[:160])

    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}", tok_a, {"title": ""})
    check("put empty title 422", st == 422, f"{st} {body}")

    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}", tok_a, {"title": "x" * 161})
    check("put title 161 chars 422", st == 422, f"{st} {str(body)[:120]}")

    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}", tok_a, {"description": "x" * 2001})
    check("put description 2001 422", st == 422, f"{st} {str(body)[:120]}")

    # unicode length: 160 CJK chars is OK (Python len() == rune count)
    cjk160 = "课" * 160
    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}", tok_a, {"title": cjk160})
    check("put title 160 CJK 200", st == 200 and (body or {}).get("title") == cjk160,
          f"{st} {str((body or {}).get('title'))[:40]}")

    st, body, _ = req("PUT", f"/v1/courses/{GHOST}", tok_a, {"title": "x"})
    check("put missing 404", st == 404 and (body or {}).get("detail") == "Course not found",
          f"{st} {body}")

    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}", tok_b, {"title": "hack"})
    check("put other user 404", st == 404 and (body or {}).get("detail") == "Course not found",
          f"{st} {body}")
    # confirm the row was not modified
    cur.execute("SELECT title FROM generated_courses WHERE id=UNHEX(%s)", (uhex(COURSE_1),))
    cur.execute("SELECT title FROM generated_courses WHERE id=UNHEX(%s)", (uhex(COURSE_1),))
    _keep = cur.fetchone()
    check("put other user no write", _keep and _keep[0] == cjk160, str(_keep))

    # ---- PUT chapter meta ----
    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}/chapters/{CHAP_1B}", tok_a,
                      {"title": f"{TAG} 章一改"})
    check("put chapter title 200", st == 200, f"{st} {str(body)[:100]}")
    chs = (body or {}).get("chapters") or []
    check("put chapter title applied",
          any(x.get("id") == CHAP_1B and x.get("title") == f"{TAG} 章一改" for x in chs),
          str([x.get("title") for x in chs]))
    check("put chapter returns course", (body or {}).get("id") == COURSE_1, str((body or {}).get("id")))

    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}/chapters/{CHAP_1B}", tok_a,
                      {"summary": f"{TAG} 摘要改 🎯"})
    check("put chapter summary 200", st == 200, f"{st}")
    chs = (body or {}).get("chapters") or []
    check("put chapter summary applied",
          any(x.get("id") == CHAP_1B and x.get("summary") == f"{TAG} 摘要改 🎯" for x in chs),
          str([x.get("summary") for x in chs]))

    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}/chapters/{CHAP_1B}", tok_a,
                      {"title": f"{TAG} 章一最终", "summary": "最终摘要"})
    check("put chapter both 200", st == 200, f"{st}")
    chs = (body or {}).get("chapters") or []
    check("put chapter both applied",
          any(x.get("id") == CHAP_1B and x.get("title") == f"{TAG} 章一最终"
              and x.get("summary") == "最终摘要" for x in chs),
          str([(x.get("title"), x.get("summary")) for x in chs]))

    # empty body → returns course even when chapter_id is wrong (Python quirk)
    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}/chapters/{GHOST}", tok_a, {})
    check("put chapter empty body wrong id 200", st == 200 and (body or {}).get("id") == COURSE_1,
          f"{st} {(body or {}).get('id')}")

    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}/chapters/{GHOST}", tok_a, {"title": "x"})
    check("put chapter wrong id 404", st == 404 and (body or {}).get("detail")
          == "Course chapter not found", f"{st} {body}")

    st, body, _ = req("PUT", f"/v1/courses/{GHOST}/chapters/{CHAP_1B}", tok_a, {"title": "x"})
    check("put chapter missing course 404", st == 404 and (body or {}).get("detail")
          == "Course chapter not found", f"{st} {body}")

    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}/chapters/{CHAP_1B}", tok_b, {"title": "hack"})
    check("put chapter other user 404", st == 404 and (body or {}).get("detail")
          == "Course chapter not found", f"{st} {body}")

    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}/chapters/{CHAP_1B}", tok_a, {"title": "  "})
    check("put chapter blank title 422", st == 422 and "title must not be blank"
          in json.dumps(body, ensure_ascii=False), f"{st} {str(body)[:140]}")

    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}/chapters/{CHAP_1B}", tok_a, {"title": "x" * 201})
    check("put chapter title 201 422", st == 422, f"{st} {str(body)[:120]}")

    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}/chapters/{CHAP_1B}", tok_a, {"summary": "x" * 1001})
    check("put chapter summary 1001 422", st == 422, f"{st} {str(body)[:120]}")

    # CJK chapter title at the 200 boundary
    cjk200 = "章" * 200
    st, body, _ = req("PUT", f"/v1/courses/{COURSE_1}/chapters/{CHAP_1A}", tok_a, {"title": cjk200})
    check("put chapter title 200 CJK 200", st == 200, f"{st}")
    chs = (body or {}).get("chapters") or []
    check("put chapter 200 CJK applied",
          any(x.get("id") == CHAP_1A and x.get("title") == cjk200 for x in chs),
          "ok" if any(x.get("id") == CHAP_1A and x.get("title") == cjk200 for x in chs) else "missing")

    # ---- persistence readback ----
    cur.execute("SELECT title, description FROM generated_courses WHERE id=UNHEX(%s)",
                (uhex(COURSE_1),))
    row = cur.fetchone()
    check("db readback course", row[0] == cjk160 and row[1] == "两者描述", str(row))

    cur.execute("SELECT title, summary FROM generated_course_chapters WHERE id=UNHEX(%s)",
                (uhex(CHAP_1B),))
    row = cur.fetchone()
    check("db readback chapter", row[0] == f"{TAG} 章一最终" and row[1] == "最终摘要", str(row))

    # ---- DELETE ----
    st, body, _ = req("DELETE", f"/v1/courses/{GHOST}", tok_a)
    check("delete missing 404", st == 404 and (body or {}).get("detail") == "Course not found",
          f"{st} {body}")

    st, body, _ = req("DELETE", f"/v1/courses/{COURSE_1}", tok_b)
    check("delete other user 404", st == 404 and (body or {}).get("detail") == "Course not found",
          f"{st} {body}")
    cur.execute("SELECT COUNT(*) FROM generated_courses WHERE id=UNHEX(%s)", (uhex(COURSE_1),))
    _n = cur.fetchone()
    check("delete other user no delete", _n and _n[0] == 1, str(_n))

    st, body, hdr = req("DELETE", f"/v1/courses/{COURSE_1}", tok_a)
    check("delete 204", st == 204, str(st))
    check("delete 204 empty body", body is None, repr(body))

    cur.execute("SELECT COUNT(*) FROM generated_courses WHERE id=UNHEX(%s)", (uhex(COURSE_1),))
    _n = cur.fetchone()
    check("delete removed course row", _n and _n[0] == 0, str(_n))
    cur.execute("SELECT COUNT(*) FROM generated_course_chapters WHERE course_id=UNHEX(%s)",
                (uhex(COURSE_1),))
    _n = cur.fetchone()
    check("delete cascaded chapters", _n and _n[0] == 0, str(_n))

    st, body, _ = req("GET", f"/v1/courses/{COURSE_1}", tok_a)
    check("get after delete 404", st == 404, f"{st}")

    st, body, _ = req("DELETE", f"/v1/courses/{COURSE_1}", tok_a)
    check("delete again 404", st == 404, f"{st}")

    # ---- remaining course still readable ----
    st, body, _ = req("GET", f"/v1/courses/{COURSE_2}", tok_a)
    check("sibling course intact", st == 200 and (body or {}).get("title") == f"{TAG} 课程二",
          f"{st} {(body or {}).get('title')}")

finally:
    try:
        cur.execute("DELETE FROM generated_course_chapters WHERE title LIKE %s OR summary LIKE %s",
                    (TAG + "%", TAG + "%"))
        cur.execute("DELETE FROM generated_courses WHERE title LIKE %s OR prompt LIKE %s",
                    (TAG + "%", TAG + "%"))
        cur.execute("DELETE FROM presentation_tasks WHERE title LIKE %s", (TAG + "%",))
        cur.execute("DELETE FROM users WHERE nickname=%s", (TAG,))
        conn.commit()
        print("cleanup done")
    except Exception as e:
        print("cleanup error", e)
        conn.rollback()
    conn.close()

passed = sum(1 for _, s, _ in results if s == "PASS")
failed = sum(1 for _, s, _ in results if s == "FAIL")
print(f"\n=== {passed}/{passed + failed} passed ===")
if failed:
    for name, s, detail in results:
        if s == "FAIL":
            safe = str(detail).encode("gbk", "replace").decode("gbk", "replace")
            print(f"  FAIL {name} :: {safe}")
    sys.exit(1)
