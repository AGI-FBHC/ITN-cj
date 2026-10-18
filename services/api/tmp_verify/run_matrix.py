import os, sys, json, time, hmac, hashlib, base64, subprocess, urllib.request, urllib.error
from datetime import datetime

HOST = "127.0.0.2"
PORT = 18766
BASE = f"http://{HOST}:{PORT}"
JWT_SECRET = os.environ["VERIFY_JWT_SECRET"]
MYSQL_PW = os.environ["VERIFY_MYSQL_PW"]
DB = dict(
    host=os.environ.get("VERIFY_MYSQL_HOST", "127.0.0.1"),
    port=int(os.environ.get("VERIFY_MYSQL_PORT", "3306")),
    user=os.environ.get("VERIFY_MYSQL_USER", "root"),
    password=MYSQL_PW,
    database=os.environ.get("VERIFY_MYSQL_DB", "itn_cangjie_dev"),
)
TAG = "SPIREVERIFY" + datetime.now().strftime("%H%M%S")
USER_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
USER_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
FAKE = "99999999-ffff-4fff-8fff-ffffffffffff"
EXE = r"D:\cangjie\zyqprojects\itn_spire_run2\target\release\bin\main.exe"
LOG = r"C:\Users\Lenovo\AppData\Local\Temp\spire_verify.log"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(sub: str) -> str:
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    exp = int(time.time()) + 3600
    payload = b64url(json.dumps({"sub": sub, "exp": exp}, separators=(",", ":")).encode())
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
        with urllib.request.urlopen(r, timeout=15) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read()
        status = e.code
    except Exception as e:
        return None, f"ERR {type(e).__name__}: {e}", None
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception:
        parsed = raw.decode("utf-8", "replace")[:400]
    return status, parsed, raw[:200]


results = []


def check(name, cond, detail=""):
    results.append((name, "PASS" if cond else "FAIL", detail))
    print(f"{'PASS' if cond else 'FAIL':4} | {name} | {detail}")


env = os.environ.copy()
env["JWT_SECRET"] = JWT_SECRET
env["SPIRE_HTTP_URL"] = "http://127.0.0.2:18766"
env["PLATFORM_DB_URL"] = (
    f"mysql://{DB['user']}:{DB['password']}@{DB['host']}:{DB['port']}/{DB['database']}"
)
env["CANGJIE_STDX_PATH"] = r"D:\cangjie\cangjie-stdx-windows-x64-1.1.3.1\windows_x86_64_cjnative\static\stdx"
env["PATH"] = r"D:\OpenSSL-Win64\OpenSSL-Win64\bin;" + env["PATH"]

logf = open(LOG, "w", encoding="utf-8", errors="replace")
proc = subprocess.Popen(
    [EXE],
    env=env,
    stdout=logf,
    stderr=subprocess.STDOUT,
    cwd=os.path.dirname(EXE),
)
print("started pid", proc.pid, "tag", TAG)

ok = False
for _ in range(40):
    time.sleep(0.25)
    try:
        with urllib.request.urlopen(BASE + "/health", timeout=2) as r:
            body = r.read().decode("utf-8", "replace")
            if r.status == 200:
                print("health", repr(body))
                ok = True
                break
    except Exception:
        pass
if not ok:
    print("SERVICE NOT UP")
    try:
        print(open(LOG, "r", errors="replace").read()[-2000:])
    except Exception:
        pass
    proc.kill()
    sys.exit(1)

tokA, tokB = make_jwt(USER_A), make_jwt(USER_B)
print("--- auth sanity ---")
s, b, _ = req("GET", "/v1/notes", tokA)
check("auth A list notes", s in (200, 503), f"{s} {str(b)[:120]}")
s, b, _ = req("GET", "/v1/notes")
check("no token -> 401", s == 401, f"{s} {str(b)[:80]}")

print("--- categories ---")
s, b, _ = req("GET", "/v1/note-categories", tokA)
check("cat list empty A", s == 200 and isinstance(b, dict) and b.get("categories") == [], f"{s} {str(b)[:120]}")
s, b, _ = req("POST", "/v1/note-categories", tokA, {"name": f"{TAG}-catA", "color": "#112233"})
check("cat create A", s == 201, f"{s} {str(b)[:200]}")
catA = b if isinstance(b, dict) else {}
catA_id = catA.get("id") or catA.get("categoryId") or (catA.get("category") or {}).get("id")
check("cat A has id", bool(catA_id), f"id={catA_id} keys={list(catA.keys()) if isinstance(catA, dict) else type(b)}")
s, b, _ = req("POST", "/v1/note-categories", tokA, {"name": f"{TAG}-catA", "color": "#445566"})
check("cat duplicate 409", s == 409, f"{s} {str(b)[:120]}")
s, b, _ = req("GET", "/v1/note-categories", tokA)
cats_a = b.get("categories", []) if isinstance(b, dict) else []
check("cat list has A", s == 200 and any(c.get("id") == catA_id for c in cats_a), f"{s} n={len(cats_a)}")
s, b, _ = req("GET", "/v1/note-categories", tokB)
check("cat list B empty", s == 200 and isinstance(b, dict) and b.get("categories") == [], f"{s} {str(b)[:80]}")
s, b, _ = req("PATCH", f"/v1/note-categories/{catA_id}", tokA, {"name": f"{TAG}-catA2", "color": "#654321"})
check("cat update A", s == 200, f"{s} {str(b)[:160]}")
s, b, _ = req("PATCH", f"/v1/note-categories/{catA_id}", tokB, {"name": "hacked"})
check("cat update B -> 404", s == 404, f"{s} {str(b)[:80]}")
s, b, _ = req("PATCH", f"/v1/note-categories/{FAKE}", tokA, {"name": "nope"})
check("cat update missing 404", s == 404, f"{s} {str(b)[:80]}")

print("--- notes ---")
s, b, _ = req("POST", "/v1/notes", tokA, {"title": f"{TAG}-note1", "content": "content-1 中文", "category_id": catA_id})
check("note create A", s == 201, f"{s} {str(b)[:220]}")
note = b if isinstance(b, dict) else {}
note_id = note.get("id") or note.get("noteId")
check("note has id", bool(note_id), f"id={note_id} keys={list(note.keys()) if isinstance(note, dict) else type(b)}")
cat_field = note.get("category_id") if "category_id" in note else note.get("categoryId")
check("note category linked", cat_field == catA_id, f"cat={cat_field}")
s, b, _ = req("GET", "/v1/notes", tokA)
notes = b.get("notes", []) if isinstance(b, dict) else []
check("list A has note (refresh)", s == 200 and any(n.get("id") == note_id for n in notes), f"{s} n={len(notes)}")
s, b, _ = req("GET", "/v1/notes", tokB)
notesB = b.get("notes", []) if isinstance(b, dict) else []
check("list B no A note", s == 200 and not any(n.get("id") == note_id for n in notesB), f"{s} n={len(notesB)}")

s, b, _ = req("PATCH", f"/v1/notes/{note_id}", tokA, {"title": f"{TAG}-note1-upd", "content": "content-2"})
check("note update A", s == 200, f"{s} {str(b)[:180]}")
check("note title updated", isinstance(b, dict) and b.get("title") == f"{TAG}-note1-upd", f"title={b.get('title') if isinstance(b, dict) else b}")
s, b, _ = req("PATCH", f"/v1/notes/{note_id}", tokB, {"title": "steal"})
check("note update B -> 404", s == 404, f"{s} {str(b)[:80]}")
s, b, _ = req("PATCH", f"/v1/notes/{FAKE}", tokA, {"title": "x"})
check("note update missing 404", s == 404, f"{s} {str(b)[:80]}")
s, b, _ = req("DELETE", f"/v1/notes/{note_id}", tokB)
check("note delete B -> 404", s == 404, f"{s} {str(b)[:80]}")
s, b, _ = req("GET", "/v1/notes", tokA)
notes2 = b.get("notes", []) if isinstance(b, dict) else []
check("note still there after B delete", any(n.get("id") == note_id for n in notes2), f"n={len(notes2)}")

s, b, _ = req("PATCH", f"/v1/notes/{note_id}", tokA, {"category_id": None})
unlink_cat = b.get("category_id") if isinstance(b, dict) else None
if isinstance(b, dict) and "category_id" not in b:
    unlink_cat = b.get("categoryId")
check("note unlink category", s == 200 and not unlink_cat, f"{s} cat={unlink_cat}")
s, b, _ = req("DELETE", f"/v1/note-categories/{catA_id}", tokA)
check("cat delete A", s == 204, f"{s} {str(b)[:80]}")
s, b, _ = req("DELETE", f"/v1/note-categories/{catA_id}", tokA)
check("cat delete again 404", s == 404, f"{s} {str(b)[:80]}")

s, b, _ = req("DELETE", f"/v1/notes/{note_id}", tokA)
check("note delete A", s == 204, f"{s} {str(b)[:80]}")
s, b, _ = req("GET", "/v1/notes", tokA)
notes3 = b.get("notes", []) if isinstance(b, dict) else []
check("note gone after delete", not any(n.get("id") == note_id for n in notes3), f"n={len(notes3)}")
s, b, _ = req("DELETE", f"/v1/notes/{note_id}", tokA)
check("note delete again 404", s == 404, f"{s} {str(b)[:80]}")

print("--- category delete unlink ---")
s, b, _ = req("POST", "/v1/note-categories", tokA, {"name": f"{TAG}-catB"})
catB = b if isinstance(b, dict) else {}
catB_id = catB.get("id")
s, b, _ = req("POST", "/v1/notes", tokA, {"title": f"{TAG}-note2", "content": "x", "category_id": catB_id})
note2_id = b.get("id") if isinstance(b, dict) else None
check("note2 create with cat", s == 201 and note2_id, f"{s} id={note2_id}")
s, b, _ = req("DELETE", f"/v1/note-categories/{catB_id}", tokA)
check("catB delete (has note)", s == 204, f"{s}")
s, b, _ = req("GET", "/v1/notes", tokA)
n2 = next((n for n in (b.get("notes", []) if isinstance(b, dict) else []) if n.get("id") == note2_id), None)
n2_cat = None
if n2:
    n2_cat = n2.get("category_id") if "category_id" in n2 else n2.get("categoryId")
check("note2 category unlinked after cat delete", n2 is not None and not n2_cat, f"n2_cat={n2_cat}")
s, b, _ = req("DELETE", f"/v1/notes/{note2_id}", tokA)
check("note2 cleanup 204", s == 204, f"{s}")

print("--- validation ---")
s, b, _ = req("POST", "/v1/notes", tokA, {"content": "no title"})
check("note missing title 422", s == 422, f"{s} {str(b)[:120]}")
s, b, _ = req("POST", "/v1/note-categories", tokA, {"name": ""})
check("cat empty name rejected", s in (400, 422), f"{s} {str(b)[:100]}")

print("\n===== SUMMARY =====")
fails = [r for r in results if r[1] == "FAIL"]
print(f"total={len(results)} pass={len(results) - len(fails)} fail={len(fails)}")
for n, st, d in fails:
    print(f"  FAIL {n}: {d}")

try:
    import pymysql

    conn = pymysql.connect(**DB, charset="utf8mb4")
    cur = conn.cursor()
    cur.execute("SELECT id FROM learning_notes WHERE title LIKE %s", (TAG + "%",))
    rows = cur.fetchall()
    for r in rows:
        cur.execute("DELETE FROM learning_notes WHERE id=%s", (r[0],))
    cur.execute("SELECT id FROM learning_note_categories WHERE name LIKE %s", (TAG + "%",))
    cats = cur.fetchall()
    for r in cats:
        cur.execute("DELETE FROM learning_note_categories WHERE id=%s", (r[0],))
    conn.commit()
    print(f"cleanup notes={len(rows)} cats={len(cats)}")
    conn.close()
except Exception as e:
    print("cleanup err", e)

proc.kill()
logf.close()
print("done")
