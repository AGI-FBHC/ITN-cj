"""Verify knowledge-match writeback on note create/update against a real knowledge_category row.

Inserts one isolated SPIREVERIFY category, creates a note whose text should match it,
asserts knowledgeCategoryId/Name/Confidence are persisted, then cleans up both.
"""
import os, sys, json, time, hmac, hashlib, base64, urllib.request, urllib.error
import pymysql

BASE = os.environ.get("VERIFY_BASE", "http://127.0.0.2:18768")
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
TAG = "SPIREVERIFYKM" + time.strftime("%H%M%S")
USER = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
MARKER = f"{TAG}-函数调用工具"


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
        with urllib.request.urlopen(r, timeout=25) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
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
tok = make_jwt(USER)
conn = pymysql.connect(**DB)
cur = conn.cursor()
kc_id = None
note_id = None

try:
    # 1) seed an isolated knowledge_category row
    cur.execute(
        "INSERT INTO knowledge_category "
        "(domain_id,parent_id,node_code,name,full_path,level,node_type,description,sort_order,status,created_by,created_at,updated_at) "
        "VALUES (1,NULL,%s,%s,%s,1,'knowledge_point',%s,0,1,'SPIREVERIFY',NOW(),NOW())",
        (f"{TAG}-code", MARKER, MARKER, f"{TAG} isolated row"),
    )
    kc_id = cur.lastrowid
    conn.commit()
    check("seed knowledge_category", kc_id is not None, f"id={kc_id}")

    # 2) create a note whose text contains the marker (auto-match path)
    s, b = req("POST", "/v1/notes", tok, {
        "title": f"关于{MARKER}的笔记",
        "content": f"这里是{MARKER}的说明文本，用于知识点自动匹配。",
        "sourceKind": "manual",
        "sourceType": "manual",
    })
    check("note create", s == 201, f"{s} {str(b)[:220]}")
    if isinstance(b, dict):
        note_id = b.get("id")
        kid = b.get("knowledgeCategoryId")
        kname = b.get("knowledgeCategoryName")
        conf = b.get("knowledgeMatchConfidence")
        check("auto-match knowledgeCategoryId", kid == kc_id, f"got={kid} want={kc_id}")
        check("auto-match knowledgeCategoryName", kname == MARKER, f"got={kname!r}")
        check("auto-match confidence set", conf is not None, f"conf={conf}")
        check("not locked (auto)", b.get("knowledgeMatchLocked") in (0, False, None), f"locked={b.get('knowledgeMatchLocked')}")
    else:
        check("auto-match knowledgeCategoryId", False, "no body")
        check("auto-match knowledgeCategoryName", False, "no body")
        check("auto-match confidence set", False, "no body")
        check("not locked (auto)", False, "no body")

    # 3) read back from DB (writeback actually persisted)
    if note_id:
        cur.execute(
            "SELECT knowledge_category_id,knowledge_category_name,knowledge_match_confidence,knowledge_match_locked "
            "FROM learning_notes WHERE title LIKE %s",
            (f"关于{MARKER}%",),
        )
        row = cur.fetchone()
        check("db writeback id", row and row[0] == kc_id, f"row={row}")
        check("db writeback name", row and row[1] == MARKER, f"name={row[1] if row else None!r}")
        check("db writeback confidence", row and row[2] is not None, f"conf={row[2] if row else None}")

    # 4) explicit knowledgeCategoryId locks the match
    s, b = req("POST", "/v1/notes", tok, {
        "title": "locked-note",
        "content": "no marker here",
        "knowledgeCategoryId": 123456789,
        "knowledgeCategoryName": "手动指定",
    })
    check("note create with explicit kp", s == 201, f"{s} {str(b)[:180]}")
    if isinstance(b, dict):
        check("explicit id written", b.get("knowledgeCategoryId") == 123456789, f"got={b.get('knowledgeCategoryId')}")
        check("explicit locked", b.get("knowledgeMatchLocked") in (1, True), f"locked={b.get('knowledgeMatchLocked')}")
        note_id2 = b.get("id")
        # update title should NOT overwrite a locked match
        s2, b2 = req("PATCH", f"/v1/notes/{note_id2}", tok, {"title": "locked-note-updated"})
        check("patch keeps lock", s2 == 200 and (b2 or {}).get("knowledgeCategoryId") == 123456789,
              f"{s2} kid={(b2 or {}).get('knowledgeCategoryId')} locked={(b2 or {}).get('knowledgeMatchLocked')}")
        req("DELETE", f"/v1/notes/{note_id2}", tok)
    else:
        check("explicit id written", False, "no body")
        check("explicit locked", False, "no body")
        check("patch keeps lock", False, "no body")

finally:
    # cleanup any leftover notes from this tag + the seeded category
    try:
        cur.execute("SELECT id FROM learning_notes WHERE title LIKE %s", (f"%{MARKER}%",))
        rows = cur.fetchall()
        for r in rows:
            cur.execute("DELETE FROM learning_notes WHERE id=%s", (r[0],))
        if note_id:
            req("DELETE", f"/v1/notes/{note_id}", tok)
        if kc_id:
            cur.execute("DELETE FROM knowledge_category WHERE id=%s", (kc_id,))
        conn.commit()
        print(f"cleanup notes={len(rows)} kc={kc_id}")
    except Exception as e:
        print("cleanup err", e)
    try:
        conn.close()
    except Exception:
        pass

fail = [r for r in results if r[1] == "FAIL"]
print("===== KNOWLEDGE MATCH SUMMARY =====")
print(f"total={len(results)} pass={len(results)-len(fail)} fail={len(fail)}")
for name, st, det in fail:
    print("FAIL", name, det)
print("done")
sys.exit(1 if fail else 0)
