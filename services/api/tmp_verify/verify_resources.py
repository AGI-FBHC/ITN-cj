"""Isolated live matrix for the Spire learning-resources / knowledge-match module.

Seeds SPIREVERIFYLR* rows on two known test users only, exercises the 10 routes,
then cleans those rows (and any seeded knowledge_category) up. Real rows are
never touched.
"""
import os, sys, json, time, hmac, hashlib, base64, urllib.request, urllib.error, urllib.parse
import pymysql

BASE = os.environ.get("VERIFY_BASE", "http://127.0.0.1:18801")
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
TAG = "SPIREVERIFYLR" + time.strftime("%H%M%S")
USER_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
USER_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
RES_QUIZ = "aaaaaaaa-1001-4000-8000-000000000001"
RES_LECT = "aaaaaaaa-1002-4000-8000-000000000002"
GHOST = "ffffffff-ffff-4fff-8fff-ffffffffffff"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(sub: str) -> str:
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(json.dumps({"sub": sub, "exp": int(time.time()) + 3600}, separators=(",", ":")).encode())
    msg = f"{header}.{payload}".encode()
    sig = hmac.new(JWT_SECRET.encode(), msg, hashlib.sha256).digest()
    return f"{header}.{payload}.{b64url(sig)}"


def req(method, path, token=None, body=None, headers=None):
    url = BASE + path
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
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
    print(f"{'PASS' if cond else 'FAIL':4} | {name} | {detail}")


print("TAG", TAG, "BASE", BASE)
tok_a = make_jwt(USER_A)
tok_b = make_jwt(USER_B)
conn = pymysql.connect(**DB)
cur = conn.cursor()
kc_id = None

quiz_content = {
    "knowledgePoints": [
        {"id": "kp1", "name": "基础概念"},
        {"id": "kp2", "name": "综合应用"},
    ],
    "questions": [
        {"id": f"{TAG}-q1", "knowledgePointId": "kp1", "difficulty": "easy",
         "stem": f"{TAG} 第一题 题干", "options": ["甲", "乙"],
         "correctIndex": 0, "explanation": f"{TAG} 解析一", "citations": [1]},
        {"id": f"{TAG}-q2", "knowledgePointId": "kp1", "difficulty": "medium",
         "stem": f"{TAG} 第二题 题干", "options": ["丙", "丁"],
         "correctIndex": 1, "explanation": f"{TAG} 解析二", "citations": [1, 2]},
        {"id": f"{TAG}-q3", "knowledgePointId": "kp2", "difficulty": "hard",
         "stem": f"{TAG} 第三题 题干", "options": ["对", "错"],
         "correctIndex": 0, "explanation": f"{TAG} 解析三", "citations": [2]},
    ],
}
lect_content = {
    "chapters": [
        {"title": f"{TAG} 第一章", "sections": [
            {"title": f"{TAG} 第一节", "content": "正文一", "citations": [1]},
            {"title": f"{TAG} 第二节", "content": "正文二", "citations": [1, 2]},
        ]},
    ],
    "sections": [
        {"title": f"{TAG} 概述", "content": "概述正文", "citations": [1]},
    ],
    "steps": [
        {"title": f"{TAG} 步骤一", "instruction": "做一步", "citations": [1]},
    ],
    "questions": [],
}
sources = [
    {"id": 1, "document": f"{TAG} 教材", "url": "https://example.com/1",
     "content": "A" * 300, "similarity": 0.9, "type": "知识库"},
    {"id": 2, "document": f"{TAG} 论文", "url": "https://example.com/2",
     "content": "B" * 100, "similarity": 0.4, "type": "互联网"},
]


def seed_user(uid_hex, email):
    cur.execute(
        "INSERT INTO users (id,email,password_hash,nickname,active,account_type,created_at,updated_at) "
        "VALUES (UNHEX(%s),%s,'x',%s,1,'LEARNER',NOW(6),NOW(6)) "
        "ON DUPLICATE KEY UPDATE email=VALUES(email)",
        (uid_hex.replace("-", ""), email, TAG),
    )


def seed_resource(rid_hex, rtype, title, content):
    cur.execute(
        "INSERT INTO generated_learning_resources "
        "(id,user_id,resource_type,title,topic,content_json,sources_json,state_json,"
        "context_json,decision_json,kp_id,form,level,version,quiz_ids_json,kb_refs_json,"
        "is_public,resource_scope,review_status,created_at,updated_at) "
        "VALUES (UNHEX(%s),UNHEX(%s),%s,%s,%s,CAST(%s AS JSON),CAST(%s AS JSON),CAST(%s AS JSON),"
        "NULL,NULL,%s,'quiz','L1','1','[]','[]',0,'USER','PUBLISHED',NOW(6),NOW(6))",
        (rid_hex.replace("-", ""), USER_A.replace("-", ""), rtype, title, title,
         json.dumps(content, ensure_ascii=False), json.dumps(sources, ensure_ascii=False),
         json.dumps({"ability": 0.35, "mastery": {}, "answered": []}, ensure_ascii=False),
         f"{TAG}-kp"),
    )


try:
    seed_user(USER_A, f"{TAG.lower()}-a@example.com")
    seed_user(USER_B, f"{TAG.lower()}-b@example.com")
    seed_resource(RES_QUIZ, "quiz", f"{TAG} 测验", quiz_content)
    seed_resource(RES_LECT, "lecture", f"{TAG} 讲义", lect_content)

    marker = f"{TAG}-知识点"
    cur.execute(
        "INSERT INTO knowledge_category "
        "(domain_id,parent_id,node_code,name,full_path,level,node_type,description,sort_order,status,created_by,created_at,updated_at) "
        "VALUES (1,NULL,%s,%s,%s,1,'knowledge_point',%s,0,1,'SPIREVERIFY',NOW(),NOW())",
        (f"{TAG}-code", marker, marker, f"{TAG} isolated row"),
    )
    kc_id = cur.lastrowid
    conn.commit()
    print("seeded users / resources / knowledge_category", kc_id)

    # ---- auth ----
    st, body, _ = req("GET", "/v1/learning-resources")
    check("no-token list 401", st == 401, f"{st} {body}")
    st, body, _ = req("GET", f"/v1/learning-resources/{RES_QUIZ}", tok_b)
    # B does not own A's private resource; list/get should not expose it
    st2, body2, _ = req("GET", "/v1/learning-resources?resource_type=quiz", tok_b)
    b_has = isinstance(body2, dict) and any(
        (it or {}).get("id") == RES_QUIZ for it in (body2.get("resources") or [])
    )
    check("B does not see A private quiz in list", not b_has, str(body2)[:120])

    # ---- 1. list + ETag ----
    st, body, hdrs = req("GET", "/v1/learning-resources?resource_type=quiz", tok_a)
    check("list quiz 200", st == 200 and isinstance(body, dict), f"{st} {str(body)[:120]}")
    items = (body or {}).get("resources") or []
    mine = [it for it in items if isinstance(it, dict) and it.get("id") == RES_QUIZ]
    check("list contains seeded quiz", len(mine) == 1, f"n={len(mine)}")
    if mine:
        it = mine[0]
        check("list summary has title", it.get("title") == f"{TAG} 测验", str(it.get("title")))
        check("list summary omits content", "content" not in it, str(sorted(it.keys()))[:160])
        check("list summary type", it.get("type") == "quiz" or it.get("resourceType") == "quiz",
              str(it.get("type")) + "/" + str(it.get("resourceType")))
    etag = (hdrs or {}).get("ETag") or (hdrs or {}).get("etag")
    check("list returns ETag", bool(etag), str(etag))
    if etag:
        st3, body3, hdrs3 = req("GET", "/v1/learning-resources?resource_type=quiz", tok_a,
                                headers={"If-None-Match": etag})
        check("list If-None-Match 304", st3 == 304, f"{st3} {str(body3)[:80]}")

    st, body, _ = req("GET", "/v1/learning-resources?resource_type=bogus", tok_a)
    check("list bad type 422", st == 422 and isinstance(body, dict)
          and body.get("detail") == "Invalid resource type", f"{st} {body}")

    # ---- 2. detail ----
    st, body, _ = req("GET", f"/v1/learning-resources/{RES_QUIZ}", tok_a)
    check("get quiz 200", st == 200 and isinstance(body, dict), f"{st} {str(body)[:120]}")
    if isinstance(body, dict):
        check("get has content.questions", isinstance((body.get("content") or {}).get("questions"), list),
              str(list((body.get("content") or {}).keys()))[:120])
        check("get has state", isinstance(body.get("state"), dict), str(body.get("state"))[:80])
    st, body, _ = req("GET", f"/v1/learning-resources/{GHOST}", tok_a)
    check("get ghost 404", st == 404 and isinstance(body, dict)
          and body.get("detail") == "Learning resource not found", f"{st} {body}")

    # ---- 3. traceability ----
    st, body, _ = req("GET", f"/v1/learning-resources/{RES_LECT}/traceability", tok_a)
    check("traceability 200", st == 200 and isinstance(body, dict), f"{st} {str(body)[:120]}")
    items = (body or {}).get("items") or []
    check("traceability has items", isinstance(items, list) and len(items) >= 2, f"n={len(items)}")
    if items:
        first = items[0]
        check("traceability kbId", str(first.get("kbId", "")).startswith("KB-"), str(first.get("kbId")))
        check("traceability credibility 0-100",
              isinstance(first.get("credibility"), (int, float)) and 0 <= first["credibility"] <= 100,
              str(first.get("credibility")))
        check("traceability excerpt <=240", len(str(first.get("excerpt") or "")) <= 240,
              str(len(str(first.get("excerpt") or ""))))
        check("traceability positions list", isinstance(first.get("positions"), list),
              str(first.get("positions"))[:80])

    # ---- 4. knowledge-categories/match ----
    st, body, _ = req("GET", "/v1/knowledge-categories/match", tok_a)
    check("match missing query 422", st == 422, f"{st} {body}")
    q = urllib.parse.quote(marker)
    st, body, _ = req("GET", f"/v1/knowledge-categories/match?query={q}&limit=5", tok_a)
    check("match 200", st == 200 and isinstance(body, dict), f"{st} {str(body)[:120]}")
    if isinstance(body, dict):
        m = body.get("match")
        cands = body.get("candidates") or []
        check("match has candidates", isinstance(cands, list) and len(cands) >= 1, f"n={len(cands)}")
        check("match field present", "match" in body, str(list(body.keys())))
        if isinstance(m, dict):
            check("match shape", set(m.keys()) >= {"id", "name", "path", "confidence"}, str(m.keys()))
            check("match confidence 0-1", 0.0 <= float(m.get("confidence", -1)) <= 1.0,
                  str(m.get("confidence")))
        if cands:
            c = cands[0]
            check("candidate shape", set(c.keys()) >= {"id", "name", "description", "path"}, str(c.keys()))

    # ---- 5. complete ----
    st, body, _ = req("POST", f"/v1/learning-resources/{RES_LECT}/complete", tok_a, {})
    check("complete 200", st == 200 and isinstance(body, dict), f"{st} {str(body)[:120]}")
    if isinstance(body, dict):
        check("complete learned=true", body.get("learned") is True, str(body.get("learned")))
        res = body.get("resource") or {}
        st_in = res.get("state") or {}
        check("complete state.learned", st_in.get("learned") is True, str(st_in.get("learned")))
        check("complete has learnedAt", bool(st_in.get("learnedAt")), str(st_in.get("learnedAt")))
    st, body, _ = req("POST", f"/v1/learning-resources/{GHOST}/complete", tok_a, {})
    check("complete ghost 404", st == 404 and isinstance(body, dict)
          and body.get("detail") == "Learning resource not found", f"{st} {body}")

    # ---- 6. progress ----
    st, body, _ = req("PATCH", f"/v1/learning-resources/{RES_LECT}/progress", tok_a, {
        "currentBlockId": "block-1",
        "visitedBlockIds": ["block-1", "block-2"],
        "completedStepIds": ["step-1"],
        "elapsedSeconds": 42,
        "selfAssessments": {"step-1": 0.8},
    })
    check("progress 200", st == 200 and isinstance(body, dict), f"{st} {str(body)[:120]}")
    if isinstance(body, dict):
        res = body.get("resource") or {}
        st_in = res.get("state") or {}
        prog = st_in.get("progress") or {}
        check("progress state.progress.currentBlockId", prog.get("currentBlockId") == "block-1",
              str(prog.get("currentBlockId")))
        check("progress state.progress.visited", "block-2" in (prog.get("visitedBlockIds") or []),
              str(prog.get("visitedBlockIds")))
        check("progress state.progress.elapsed", prog.get("elapsedSeconds") == 42,
              str(prog.get("elapsedSeconds")))
    st, body, _ = req("PATCH", f"/v1/learning-resources/{RES_LECT}/progress", tok_a,
                      {"visitedBlockIds": ["x"] * 600})
    check("progress too many 422", st == 422 and isinstance(body, dict)
          and body.get("code") == "VALIDATION_FAILED", f"{st} {str(body)[:100]}")

    # ---- 7. source-feedback ----
    st, body, _ = req("POST", f"/v1/learning-resources/{RES_LECT}/source-feedback", tok_a, {
        "sourceId": "1", "issueType": "mismatch", "note": f"{TAG} 备注",
    })
    check("source-feedback 201", st == 201 and isinstance(body, dict), f"{st} {str(body)[:120]}")
    if isinstance(body, dict):
        fb = body.get("feedback") or {}
        check("feedback sourceId", fb.get("sourceId") == "1", str(fb.get("sourceId")))
        check("feedback issueType", fb.get("issueType") == "mismatch", str(fb.get("issueType")))
        check("feedback note utf8", fb.get("note") == f"{TAG} 备注", repr(fb.get("note")))
        check("feedback status", fb.get("status") == "submitted", str(fb.get("status")))
    st, body, _ = req("POST", f"/v1/learning-resources/{RES_LECT}/source-feedback", tok_a,
                      {"sourceId": "1", "issueType": "nope"})
    check("feedback bad type 422", st == 422, f"{st} {str(body)[:100]}")

    # ---- 8. answers/grade (no writes) ----
    st, body, _ = req("POST", f"/v1/learning-resources/{RES_QUIZ}/answers/grade", tok_a, {
        "questionId": f"{TAG}-q1", "answer": "0", "durationSeconds": 10,
    })
    check("grade 200", st == 200 and isinstance(body, dict), f"{st} {str(body)[:120]}")
    if isinstance(body, dict):
        check("grade correct=true", body.get("correct") is True, str(body.get("correct")))
        check("grade correctIndex", body.get("correctIndex") == 0, str(body.get("correctIndex")))
        check("grade feedback keys",
              set(body.keys()) >= {"correct", "correctIndex", "explanation", "ability", "mastery", "completed"},
              str(sorted(body.keys())))
        check("grade ability 0.45", abs(float(body.get("ability", 0)) - 0.45) < 0.001,
              str(body.get("ability")))
        check("grade no state field", "state" not in body, str(sorted(body.keys())))
    # grade must not have written state
    st, chk, _ = req("GET", f"/v1/learning-resources/{RES_QUIZ}", tok_a)
    st_in = (chk or {}).get("state") or {}
    check("grade did not persist answered", len(st_in.get("answered") or []) == 0,
          str(st_in.get("answered")))

    # ---- 9. answers (wrong -> wrongAnswer row) ----
    st, body, _ = req("POST", f"/v1/learning-resources/{RES_QUIZ}/answers", tok_a, {
        "questionId": f"{TAG}-q1", "answer": "1", "durationSeconds": 30,
    })
    check("answer wrong 200", st == 200 and isinstance(body, dict), f"{st} {str(body)[:160]}")
    if isinstance(body, dict):
        check("answer correct=false", body.get("correct") is False, str(body.get("correct")))
        check("answer knowledgePoint", isinstance(body.get("knowledgePoint"), dict)
              or body.get("knowledgePoint") is None, str(body.get("knowledgePoint"))[:80])
        wa = body.get("wrongAnswer")
        check("answer wrongAnswer object", isinstance(wa, dict), str(wa)[:160])
        if isinstance(wa, dict):
            check("wrongAnswer questionId", wa.get("questionId") == f"{TAG}-q1",
                  str(wa.get("questionId")))
            check("wrongAnswer userAnswer=1", wa.get("userAnswer") == 1, str(wa.get("userAnswer")))
            check("wrongAnswer correctAnswer=0", wa.get("correctAnswer") == 0,
                  str(wa.get("correctAnswer")))
        check("answer has state", isinstance(body.get("state"), dict), str(body.get("state"))[:80])
        check("answer masteryDelta present", "masteryDelta" in body, str(body.get("masteryDelta")))
        check("answer confidence present", "confidence" in body, str(body.get("confidence")))
        dec = body.get("decision") or {}
        check("answer decision.writeback", dec.get("type") == "writeback", str(dec.get("type")))
        check("answer adaptive=false", body.get("adaptive") is False, str(body.get("adaptive")))
        check("answer nextQuestion null", body.get("nextQuestion") is None,
              str(body.get("nextQuestion"))[:80])
        st_in = body.get("state") or {}
        check("answer state.ability 0.27", abs(float(st_in.get("ability", 0)) - 0.27) < 0.001,
              str(st_in.get("ability")))
        check("answer state.answered len=1", len(st_in.get("answered") or []) == 1,
              str(len(st_in.get("answered") or [])))

    # re-answer same question -> 409
    st, body, _ = req("POST", f"/v1/learning-resources/{RES_QUIZ}/answers", tok_a, {
        "questionId": f"{TAG}-q1", "answer": "0",
    })
    check("re-answer 409", st == 409 and isinstance(body, dict)
          and body.get("detail") == "Question is missing or already answered", f"{st} {body}")

    # missing question -> 409 (Python raises the same ValueError as already-answered)
    st, body, _ = req("POST", f"/v1/learning-resources/{RES_QUIZ}/answers", tok_a, {
        "questionId": "nope", "answer": "0",
    })
    check("missing question 409", st == 409 and isinstance(body, dict)
          and body.get("detail") == "Question is missing or already answered", f"{st} {body}")
    st, body, _ = req("POST", f"/v1/learning-resources/{RES_QUIZ}/answers/grade", tok_a, {
        "questionId": "nope", "answer": "0",
    })
    check("grade missing question 409", st == 409 and isinstance(body, dict)
          and body.get("detail") == "Question is missing or already answered", f"{st} {body}")

    # missing resource on answers/grade -> 404 "Quiz not found"
    st, body, _ = req("POST", f"/v1/learning-resources/{GHOST}/answers", tok_a, {
        "questionId": "x", "answer": "0",
    })
    check("answers ghost 404 Quiz not found", st == 404 and isinstance(body, dict)
          and body.get("detail") == "Quiz not found", f"{st} {body}")
    st, body, _ = req("POST", f"/v1/learning-resources/{GHOST}/answers/grade", tok_a, {
        "questionId": "x", "answer": "0",
    })
    check("grade ghost 404 Quiz not found", st == 404 and isinstance(body, dict)
          and body.get("detail") == "Quiz not found", f"{st} {body}")

    # non-quiz resource on answers -> 404 "Quiz not found"
    st, body, _ = req("POST", f"/v1/learning-resources/{RES_LECT}/answers", tok_a, {
        "questionId": "x", "answer": "0",
    })
    check("answers on lecture 404", st == 404 and isinstance(body, dict)
          and body.get("detail") == "Quiz not found", f"{st} {body}")

    # correct answer q2 -> no wrongAnswer row
    st, body, _ = req("POST", f"/v1/learning-resources/{RES_QUIZ}/answers", tok_a, {
        "questionId": f"{TAG}-q2", "answer": "1", "durationSeconds": 60,
    })
    check("answer correct 200", st == 200 and isinstance(body, dict)
          and body.get("correct") is True, f"{st} {str(body)[:120]}")
    if isinstance(body, dict):
        check("answer correct wrongAnswer null", body.get("wrongAnswer") is None,
              str(body.get("wrongAnswer"))[:80])

    # option-text answer on q3
    st, body, _ = req("POST", f"/v1/learning-resources/{RES_QUIZ}/answers", tok_a, {
        "questionId": f"{TAG}-q3", "answer": "对", "durationSeconds": 200,
    })
    check("answer by option text 200", st == 200 and isinstance(body, dict), f"{st} {str(body)[:120]}")
    if isinstance(body, dict):
        check("option-text correct", body.get("correct") is True, str(body.get("correct")))
        st_in = body.get("state") or {}
        check("all answered completed", st_in.get("completed") is True, str(st_in.get("completed")))
        check("completed sets learned", st_in.get("learned") is True, str(st_in.get("learned")))
        check("completed sets learnedAt", bool(st_in.get("learnedAt")), str(st_in.get("learnedAt")))

    # ---- 10. reset ----
    st, body, _ = req("POST", f"/v1/learning-resources/{RES_QUIZ}/reset", tok_a, {})
    check("reset 200", st == 200 and isinstance(body, dict), f"{st} {str(body)[:120]}")
    if isinstance(body, dict):
        st_in = (body.get("resource") or {}).get("state") or {}
        check("reset state emptied", not st_in.get("answered") and not st_in.get("completed")
              and not st_in.get("learned"), str(st_in)[:160])
    st, body, _ = req("POST", f"/v1/learning-resources/{GHOST}/reset", tok_a, {})
    check("reset ghost 404 detail", st == 404 and isinstance(body, dict)
          and body.get("detail") == "Resource not found", f"{st} {body}")

    # wrong-answers rows for this resource must be gone after reset
    cur.execute(
        "SELECT COUNT(*) FROM learning_wrong_answers WHERE resource_id=UNHEX(%s)",
        (RES_QUIZ.replace("-", ""),),
    )
    nwa = cur.fetchone()[0]
    check("reset deleted wrong-answer rows", nwa == 0, f"n={nwa}")

finally:
    # cleanup isolated rows only
    try:
        cur.execute("DELETE FROM learning_wrong_answers WHERE question_id LIKE %s", (TAG + "%",))
        cur.execute("DELETE FROM learning_resource_source_feedback WHERE note LIKE %s", (TAG + "%",))
        cur.execute("DELETE FROM learning_resource_user_state WHERE resource_id IN (UNHEX(%s),UNHEX(%s))",
                    (RES_QUIZ.replace("-", ""), RES_LECT.replace("-", "")))
        cur.execute("DELETE FROM generated_learning_resources WHERE id IN (UNHEX(%s),UNHEX(%s))",
                    (RES_QUIZ.replace("-", ""), RES_LECT.replace("-", "")))
        if kc_id is not None:
            cur.execute("DELETE FROM knowledge_category WHERE id=%s", (kc_id,))
        cur.execute("DELETE FROM users WHERE email IN (%s, %s)",
                    (f"{TAG.lower()}-a@example.com", f"{TAG.lower()}-b@example.com"))
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
            print(f"  FAIL {name} :: {detail}")
    sys.exit(1)
