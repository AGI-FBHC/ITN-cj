"""Isolated live matrix for the Spire wrong-answers module.

Uses SPIREVERIFYWA* question ids on the two known test users only, then
cleans those rows (and any seeded knowledge_category) up. Real rows in
learning_wrong_answers are never touched.
"""
import os, sys, json, time, hmac, hashlib, base64, urllib.request, urllib.error
import pymysql

BASE = os.environ.get("VERIFY_BASE", "http://127.0.0.1:18769")
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
TAG = "SPIREVERIFYWA" + time.strftime("%H%M%S")
USER_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
USER_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
RES_A = "aaaaaaaa-0001-4000-8000-000000000001"
Q1 = f"{TAG}-q1"
Q2 = f"{TAG}-q2"
Q3 = f"{TAG}-q3"
Q4 = f"{TAG}-q4"


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
                return resp.status, None
            return resp.status, json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw.decode("utf-8"))
        except Exception:
            return e.code, raw.decode("utf-8", "replace")[:300]
    except Exception as e:
        return None, f"ERR {type(e).__name__}: {e}"


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
created_ids = []

try:
    # ---- isolated knowledge_category for auto-match on add ----
    marker = f"{TAG}-函数调用"
    cur.execute(
        "INSERT INTO knowledge_category "
        "(domain_id,parent_id,node_code,name,full_path,level,node_type,description,sort_order,status,created_by,created_at,updated_at) "
        "VALUES (1,NULL,%s,%s,%s,1,'knowledge_point',%s,0,1,'SPIREVERIFY',NOW(),NOW())",
        (f"{TAG}-code", marker, marker, f"{TAG} isolated row"),
    )
    kc_id = cur.lastrowid
    conn.commit()
    print("seeded knowledge_category", kc_id)

    # 1) no token -> 401
    st, body = req("GET", "/v1/wrong-answers")
    check("no-token list 401", st == 401, f"{st} {body}")

    # 2) add (manual wrong book entry)
    add1 = {
        "resourceId": RES_A,
        "questionId": Q1,
        "stem": f"{TAG} 题干 一 选项测试",
        "options": ["甲", "乙", "丙", "丁"],
        "userAnswer": 1,
        "correctAnswer": 2,
        "explanation": f"{TAG} 解析 中文",
        "difficulty": "hard",
        "kpId": f"{TAG}-kp",
        "knowledgeCategoryName": marker,
    }
    st, item = req("POST", "/v1/wrong-answers/add", tok_a, add1)
    check("add 201", st == 201, f"{st} {str(item)[:120]}")
    check("add returns camelCase id", isinstance(item, dict) and bool(item.get("id")), str(item)[:120])
    if isinstance(item, dict):
        created_ids.append(item.get("id"))
        check("add questionId", item.get("questionId") == Q1, str(item.get("questionId")))
        check("add stem utf8", item.get("stem") == add1["stem"], repr(item.get("stem")))
        check("add options array", item.get("options") == add1["options"], str(item.get("options")))
        check("add userAnswer", item.get("userAnswer") == 1, str(item.get("userAnswer")))
        check("add correctAnswer", item.get("correctAnswer") == 2, str(item.get("correctAnswer")))
        check("add difficulty", item.get("difficulty") == "hard", str(item.get("difficulty")))
        check("add default fromSource quiz", item.get("fromSource") == "quiz", str(item.get("fromSource")))
        check("add reviewStatus unreviewed", item.get("reviewStatus") == "unreviewed", str(item.get("reviewStatus")))
        check("add reviewCount 0", item.get("reviewCount") == 0, str(item.get("reviewCount")))
        check("add mastered false", item.get("mastered") is False, str(item.get("mastered")))
        check("add createdAt ends Z", str(item.get("createdAt", "")).endswith("Z"), str(item.get("createdAt")))
        check("add firstAt present", bool(item.get("firstAt")), str(item.get("firstAt")))
        # auto-match writeback (enrichment; may be None if scoring missed)
        kid = item.get("knowledgeCategoryId")
        check("add auto-match id or null", kid is None or isinstance(kid, int), str(kid))
        check("add auto-match locked false", item.get("knowledgeMatchLocked") in (False, 0), str(item.get("knowledgeMatchLocked")))

    # 3) ON DUPLICATE KEY UPDATE: same resource+question re-add keeps id, resets review
    st, again = req("POST", "/v1/wrong-answers/add", tok_a, add1)
    check("re-add same question 201", st == 201, str(st))
    if isinstance(again, dict):
        check("re-add keeps same id", again.get("id") == item.get("id"), f"{again.get('id')} vs {item.get('id')}")

    # 4) list without keyword includes the row
    st, listing = req("GET", "/v1/wrong-answers", tok_a)
    items = (listing or {}).get("items") if isinstance(listing, dict) else None
    check("list 200 items[]", st == 200 and isinstance(items, list), f"{st} n={len(items) if isinstance(items, list) else items}")
    q1s = [x for x in (items or []) if x.get("questionId") == Q1]
    check("list contains Q1", len(q1s) == 1, f"n={len(q1s)}")

    # 5) keyword filter
    st, filtered = req("GET", f"/v1/wrong-answers?keyword={TAG}", tok_a)
    fitems = (filtered or {}).get("items") if isinstance(filtered, dict) else None
    check("keyword list hits", st == 200 and isinstance(fitems, list) and len(fitems) >= 1,
          f"{st} n={len(fitems) if isinstance(fitems, list) else fitems}")
    st, miss = req("GET", f"/v1/wrong-answers?keyword={TAG}-NOSUCH", tok_a)
    miss_n = len((miss or {}).get("items") or []) if isinstance(miss, dict) else -1
    check("keyword miss empty", st == 200 and miss_n == 0, f"{st} n={miss_n}")

    # 6) ownership: user B must not see or patch A's row
    st, bl = req("GET", "/v1/wrong-answers", tok_b)
    bitems = (bl or {}).get("items") if isinstance(bl, dict) else None
    b_has = any(x.get("questionId") == Q1 for x in (bitems or []))
    check("user B list hides A row", st == 200 and not b_has, f"st={st} has={b_has}")
    wid = item.get("id")
    st, body = req("PATCH", f"/v1/wrong-answers/{wid}", tok_b, {"mastered": True})
    check("user B patch 404", st == 404 and isinstance(body, dict) and body.get("detail") == "Wrong answer not found",
          f"{st} {body}")
    st, body = req("DELETE", f"/v1/wrong-answers/{wid}", tok_b)
    check("user B delete 404", st == 404, f"{st} {body}")

    # 7) PATCH fields. last_pick has NO validation_alias (measured Python:
    # extra=ignore -> 200 and nothing written for camel "lastPick"; only the
    # snake_case key binds). review_status DOES alias reviewStatus, so that one
    # camel key works. See wrong_answers_api.cj parseWrongUpdate.
    before_lp = item.get("lastPick") if isinstance(item, dict) else None
    st, upd = req("PATCH", f"/v1/wrong-answers/{wid}", tok_a, {
        "reviewStatus": "reviewing", "mastered": False, "streak": 3, "lastPick": 2,
    })
    check("patch 200", st == 200, f"{st} {str(upd)[:120]}")
    if isinstance(upd, dict):
        check("patch reviewStatus", upd.get("reviewStatus") == "reviewing", str(upd.get("reviewStatus")))
        check("patch streak", upd.get("streak") == 3, str(upd.get("streak")))
        check("patch camel lastPick ignored", upd.get("lastPick") == before_lp,
              f"before={before_lp} after={upd.get('lastPick')}")
    st, upd2 = req("PATCH", f"/v1/wrong-answers/{wid}", tok_a, {"last_pick": 2})
    check("patch snake last_pick 200", st == 200 and isinstance(upd2, dict), f"{st} {str(upd2)[:120]}")
    if isinstance(upd2, dict):
        check("patch last_pick", upd2.get("lastPick") == 2, str(upd2.get("lastPick")))

    # 8) PATCH no-op still returns the row (Python affected_rows quirk intentionally not copied)
    st, noop = req("PATCH", f"/v1/wrong-answers/{wid}", tok_a, {
        "reviewStatus": "reviewing", "mastered": False, "streak": 3, "lastPick": 2,
    })
    check("patch identical values 200", st == 200 and isinstance(noop, dict), f"{st} {str(noop)[:80]}")

    # 9) PATCH knowledge_category_id present locks the match
    st, kupd = req("PATCH", f"/v1/wrong-answers/{wid}", tok_a, {
        "knowledgeCategoryId": int(kc_id), "knowledgeCategoryName": marker,
    })
    check("patch knowledge 200", st == 200, f"{st} {str(kupd)[:120]}")
    if isinstance(kupd, dict):
        check("patch knowledge id", kupd.get("knowledgeCategoryId") == kc_id, str(kupd.get("knowledgeCategoryId")))
        check("patch knowledge name", kupd.get("knowledgeCategoryName") == marker, str(kupd.get("knowledgeCategoryName")))
        check("patch knowledge locked", kupd.get("knowledgeMatchLocked") in (True, 1), str(kupd.get("knowledgeMatchLocked")))
        check("patch knowledge confidence null", kupd.get("knowledgeMatchConfidence") is None,
              str(kupd.get("knowledgeMatchConfidence")))

    # 10) name-only PATCH does not touch knowledge fields (Pydantic exclude_unset)
    st, noname = req("PATCH", f"/v1/wrong-answers/{wid}", tok_a, {"knowledgeCategoryName": "IGNORED"})
    if isinstance(noname, dict):
        check("name-only patch keeps knowledge", noname.get("knowledgeCategoryName") == marker,
              f"got={noname.get('knowledgeCategoryName')}")

    # 11) PATCH validation
    st, body = req("PATCH", f"/v1/wrong-answers/{wid}", tok_a, {"reviewStatus": "nope"})
    check("patch bad status 422", st == 422 and isinstance(body, dict) and body.get("code") == "VALIDATION_FAILED",
          f"{st} {str(body)[:100]}")
    st, body = req("PATCH", f"/v1/wrong-answers/{wid}", tok_a, {"streak": -1})
    check("patch streak<0 422", st == 422 and isinstance(body, dict) and body.get("code") == "VALIDATION_FAILED",
          f"{st} {str(body)[:100]}")
    st, body = req("PATCH", f"/v1/wrong-answers/{wid}", tok_a, {"lastPick": -2})
    check("patch camel lastPick<-1 ignored 200", st == 200 and isinstance(body, dict),
          f"{st} {str(body)[:100]}")
    st, body = req("PATCH", f"/v1/wrong-answers/{wid}", tok_a, {"last_pick": -2})
    check("patch last_pick<-1 422", st == 422 and isinstance(body, dict) and body.get("code") == "VALIDATION_FAILED",
          f"{st} {str(body)[:100]}")
    st, body = req("PATCH", f"/v1/wrong-answers/{wid}", tok_a, {"knowledgeCategoryId": 0})
    check("patch knowledgeId<1 422", st == 422 and isinstance(body, dict) and body.get("code") == "VALIDATION_FAILED",
          f"{st} {str(body)[:100]}")

    # 12) review correct (correctAnswer=2)
    st, rev = req("POST", f"/v1/wrong-answers/{wid}/review", tok_a, {"answer": 2})
    check("review correct 200", st == 200 and isinstance(rev, dict), f"{st} {str(rev)[:120]}")
    if isinstance(rev, dict):
        check("review correct flag", rev.get("correct") is True, str(rev.get("correct")))
        rit = rev.get("item") or {}
        check("review item streak=4", rit.get("streak") == 4, str(rit.get("streak")))
        check("review item count=1", rit.get("reviewCount") == 1, str(rit.get("reviewCount")))
        check("review item status reviewing", rit.get("reviewStatus") == "reviewing", str(rit.get("reviewStatus")))
        check("review item lastPick=2", rit.get("lastPick") == 2, str(rit.get("lastPick")))

    # 13) review wrong -> streak reset
    st, rev2 = req("POST", f"/v1/wrong-answers/{wid}/review", tok_a, {"answer": 0})
    if isinstance(rev2, dict):
        rit = rev2.get("item") or {}
        check("review wrong correct=false", rev2.get("correct") is False, str(rev2.get("correct")))
        check("review wrong streak=0", rit.get("streak") == 0, str(rit.get("streak")))
        check("review wrong count=2", rit.get("reviewCount") == 2, str(rit.get("reviewCount")))

    # 14) mastered=true then correct review -> reviewStatus mastered
    st, _ = req("PATCH", f"/v1/wrong-answers/{wid}", tok_a, {"mastered": True, "streak": 1})
    st, rev3 = req("POST", f"/v1/wrong-answers/{wid}/review", tok_a, {"answer": 2})
    if isinstance(rev3, dict):
        rit = rev3.get("item") or {}
        check("mastered correct keeps mastered", rit.get("mastered") is True and rit.get("reviewStatus") == "mastered",
              f"mastered={rit.get('mastered')} status={rit.get('reviewStatus')}")

    # 15) review index out of range (4 options)
    st, body = req("POST", f"/v1/wrong-answers/{wid}/review", tok_a, {"answer": 4})
    check("review OOR 422 detail", st == 422 and isinstance(body, dict)
          and body.get("detail") == "Answer index is outside the available options", f"{st} {body}")

    # 16) review validation (missing answer / bad range)
    st, body = req("POST", f"/v1/wrong-answers/{wid}/review", tok_a, {})
    check("review missing answer 422", st == 422 and isinstance(body, dict) and body.get("code") == "VALIDATION_FAILED",
          f"{st} {str(body)[:100]}")
    st, body = req("POST", f"/v1/wrong-answers/{wid}/review", tok_a, {"answer": 26})
    check("review answer>25 422", st == 422 and isinstance(body, dict) and body.get("code") == "VALIDATION_FAILED",
          f"{st} {str(body)[:100]}")

    # 17) missing wrong id -> 404
    ghost = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    st, body = req("PATCH", f"/v1/wrong-answers/{ghost}", tok_a, {"mastered": True})
    check("patch ghost 404", st == 404 and body.get("detail") == "Wrong answer not found", f"{st} {body}")
    st, body = req("POST", f"/v1/wrong-answers/{ghost}/review", tok_a, {"answer": 0})
    check("review ghost 404", st == 404 and body.get("detail") == "Wrong answer not found", f"{st} {body}")
    st, body = req("DELETE", f"/v1/wrong-answers/{ghost}", tok_a)
    check("delete ghost 404", st == 404 and body.get("detail") == "Wrong answer not found", f"{st} {body}")

    # 18) add without resourceId (NULL unique-key quirk -> separate rows)
    for q in (Q2, Q3):
        st, row = req("POST", "/v1/wrong-answers/add", tok_a, {
            "questionId": q,
            "stem": f"{TAG} 无资源 {q}",
            "options": ["对", "错"],
            "userAnswer": 0,
            "correctAnswer": 1,
        })
        check(f"add null-resource {q} 201", st == 201, str(st))
        if isinstance(row, dict):
            created_ids.append(row.get("id"))
            check(f"add null-resource {q} resourceId null", row.get("resourceId") is None, str(row.get("resourceId")))
            check(f"add null-resource {q} difficulty default", row.get("difficulty") == "medium", str(row.get("difficulty")))
    st, l2 = req("GET", "/v1/wrong-answers", tok_a)
    ids = [x.get("id") for x in ((l2 or {}).get("items") or []) if str(x.get("questionId", "")).startswith(TAG)]
    check("null-resource rows are distinct", len(set(ids)) >= 2, f"ids={ids}")

    # 19) add validation
    st, body = req("POST", "/v1/wrong-answers/add", tok_a, {"stem": "x", "options": [], "userAnswer": 0, "correctAnswer": 0})
    check("add missing questionId 422", st == 422 and isinstance(body, dict) and body.get("code") == "VALIDATION_FAILED",
          f"{st} {str(body)[:100]}")
    st, body = req("POST", "/v1/wrong-answers/add", tok_a, {"resourceId": "not-a-uuid", "questionId": Q4,
                                                            "stem": "x", "userAnswer": 0, "correctAnswer": 0})
    check("add bad resourceId 422", st == 422 and isinstance(body, dict) and body.get("code") == "VALIDATION_FAILED",
          f"{st} {str(body)[:100]}")

    # 20) delete then 404
    st, _ = req("DELETE", f"/v1/wrong-answers/{wid}", tok_a)
    check("delete 204", st == 204, str(st))
    st, body = req("DELETE", f"/v1/wrong-answers/{wid}", tok_a)
    check("delete again 404", st == 404, f"{st} {body}")

    # 21) pymysql readback of one remaining row
    cur.execute(
        "SELECT question_id,stem,review_status FROM learning_wrong_answers WHERE user_id=UNHEX(%s) AND question_id=%s",
        (USER_A.replace("-", ""), Q2),
    )
    row = cur.fetchone()
    check("db readback Q2", row is not None and row[0] == Q2, str(row))

finally:
    # cleanup only isolated rows
    try:
        cur.execute(
            "DELETE FROM learning_wrong_answers WHERE question_id LIKE %s",
            (TAG + "%",),
        )
        deleted = cur.rowcount
        conn.commit()
        print("cleaned learning_wrong_answers rows", deleted)
    except Exception as e:
        print("cleanup wrong_answers failed", e)
    if kc_id is not None:
        try:
            cur.execute("DELETE FROM knowledge_category WHERE id=%s", (kc_id,))
            conn.commit()
            print("cleaned knowledge_category", kc_id)
        except Exception as e:
            print("cleanup knowledge_category failed", e)
    conn.close()

fail = [r for r in results if r[1] == "FAIL"]
print("===== WRONG-ANSWERS SUMMARY =====")
print(f"total={len(results)} pass={len(results) - len(fail)} fail={len(fail)}")
for name, status, detail in fail:
    print("FAIL", name, detail)
sys.exit(1 if fail else 0)
