"""Exercise the notes API through the Vite dev proxy, matching the old frontend's request shape.

Frontend uses requestDirect -> fetch(`${API_BASE}/v1/...`) with Bearer from localStorage 'lf.token'.
Vite proxies /v1 -> VITE_AGENT_BASE. This script hits http://127.0.0.1:3002 so the
proxy hop is in the path (not a direct Spire call).
"""
import os, sys, json, time, hmac, hashlib, base64, urllib.request, urllib.error

VITE = os.environ.get("VITE_BASE", "http://127.0.0.1:3002")
JWT_SECRET = os.environ["JWT_SECRET"]
TAG = "VITENOTE" + time.strftime("%H%M%S")
USER = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


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
    url = VITE + path
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=25) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read()
        status = e.code
    except Exception as e:
        return None, f"ERR {type(e).__name__}: {e}"
    try:
        return status, json.loads(raw.decode("utf-8"))
    except Exception:
        return status, raw.decode("utf-8", "replace")[:400]


results = []


def check(name, cond, detail=""):
    results.append((name, "PASS" if cond else "FAIL", detail))
    print(f"{'PASS' if cond else 'FAIL':4} | {name} | {detail}")


print("TAG", TAG, "VITE", VITE)
tok = make_jwt(USER)

# 1) Vite itself serves the app shell
s, b = req("GET", "/")
check("vite serves index", s == 200 and (isinstance(b, str) and ("root" in b or "<!doctype" in b.lower() or "html" in b.lower())), f"{s} {str(b)[:120]}")

# 2) /v1/health via proxy (frontend never calls this, but proves proxy target)
s, b = req("GET", "/v1/../health")
# some proxies normalize; also try direct health is not under /v1 so skip

# 3) list notes — NotesContext reloadNotes / initial effect
s, b = req("GET", "/v1/notes", tok)
check("listNotes via vite", s == 200 and isinstance(b, dict) and "notes" in b, f"{s} {str(b)[:200]}")

# 4) create note — NotesContext.addNote shape
body = {
    "title": f"{TAG}-title",
    "content": f"{TAG} 内容-前端形状",
    "kpId": "kp-vite-test",
    "sourceKind": "manual",
    "sourceType": "manual",
    "sourceRef": "block#1",
    "sourceContext": f"{TAG}-ctx",
    "kbRefs": ["kb1", "kb2"],
}
s, b = req("POST", "/v1/notes", tok, body)
check("createNote via vite", s == 201 and isinstance(b, dict) and b.get("id"), f"{s} {str(b)[:240]}")
note_id = (b or {}).get("id") if isinstance(b, dict) else None

# 5) response fields the frontend LearningNoteRecord / toNote() needs
if isinstance(b, dict) and note_id:
    need = ["id", "title", "content", "status", "sourceType", "createdAt", "updatedAt"]
    missing = [k for k in need if k not in b]
    check("LearningNoteRecord fields", not missing, f"missing={missing} keys={list(b.keys())}")
    check("kbRefs array", isinstance(b.get("kbRefs"), list), f"kbRefs={b.get('kbRefs')!r}")
else:
    check("LearningNoteRecord fields", False, "no created note")
    check("kbRefs array", False, "no created note")

# 6) list again (refresh recovery through proxy)
s, b = req("GET", "/v1/notes", tok)
notes = b.get("notes", []) if isinstance(b, dict) else []
check("list has new note", s == 200 and any(n.get("id") == note_id for n in notes), f"{s} n={len(notes)}")

# 7) deleteNote via proxy
s, b = req("DELETE", f"/v1/notes/{note_id}", tok)
check("deleteNote via vite", s in (200, 204), f"{s} {str(b)[:120]}")

# 8) list after delete
s, b = req("GET", "/v1/notes", tok)
notes = b.get("notes", []) if isinstance(b, dict) else []
check("list after delete", s == 200 and not any(n.get("id") == note_id for n in notes), f"{s} n={len(notes)}")

# 9) categories list (MyNotes / admin UI may use it)
s, b = req("GET", "/v1/note-categories", tok)
check("listCategories via vite", s == 200 and isinstance(b, dict) and "categories" in b, f"{s} {str(b)[:160]}")

# 10) no token through proxy -> 401 (frontend unauthenticated path)
s, b = req("GET", "/v1/notes")
check("no token via vite -> 401", s == 401, f"{s} {str(b)[:80]}")

fail = [r for r in results if r[1] == "FAIL"]
print("===== VITE PROXY SUMMARY =====")
print(f"total={len(results)} pass={len(results)-len(fail)} fail={len(fail)}")
for name, st, det in fail:
    print("FAIL", name, det)
print("done")
sys.exit(1 if fail else 0)
