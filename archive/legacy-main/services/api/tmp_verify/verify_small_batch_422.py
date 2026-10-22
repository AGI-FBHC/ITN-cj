"""422 writer unification battery — compares live Spire envelopes to
tmp_verify/fastapi_ref_422.json (240 measured pydantic 2.10.4 cases).

No database needed: every 422 case is rejected before any storage check.
Structural JSON comparison (dict key order ignored, array order kept).

The main score only counts ref cases whose measured status is 422.
Ref-200 controls are not expected to pass without a DB; instead we flag
any live 422 on a ref-200 case as OVER-STRICT (Spire invented a
constraint pydantic does not apply).

Run:
  JWT_SECRET=KNOWNSECRET20CHARSXX VERIFY_BASE=http://127.0.0.1:19411 \
    python verify_small_batch_422.py
"""
import os, sys, json, hmac, hashlib, base64, time, urllib.request, urllib.error

sys.stdout.reconfigure(encoding="utf-8")

BASE = os.environ.get("VERIFY_BASE", "http://127.0.0.1:19411")
JWT_SECRET = os.environ["JWT_SECRET"]
HERE = os.path.dirname(os.path.abspath(__file__))
REF = json.load(open(os.path.join(HERE, "fastapi_ref_422.json"), encoding="utf-8"))

USER_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
NOTE_ID = "aaaaaaaa-0001-4000-8000-000000000001"
CAT_ID = "bbbbbbbb-0002-4000-8000-000000000002"
COURSE_ID = "cccccccc-0003-4000-8000-000000000003"
CHAP_ID = "dddddddd-0004-4000-8000-000000000004"
WRONG_ID = "eeeeeeee-0005-4000-8000-000000000005"
SESS_ID = "ffffffff-0006-4000-8000-000000000006"
RES_ID = "12345678-0007-4000-8000-000000000007"

# (method, ref path) -> (method, spire path template with %s for the id)
ROUTE = {
    ("POST", "/note"): ("POST", "/v1/notes"),
    ("PUT", "/note"): ("PATCH", f"/v1/notes/{NOTE_ID}"),
    ("POST", "/cat"): ("POST", "/v1/note-categories"),
    ("PUT", "/cat"): ("PATCH", f"/v1/note-categories/{CAT_ID}"),
    ("POST", "/resource"): ("POST", "/v1/learning-resource-tasks/lecture"),
    ("PUT", "/course"): ("PUT", f"/v1/courses/{COURSE_ID}"),
    ("PUT", "/chapter"): ("PUT", f"/v1/courses/{COURSE_ID}/chapters/{CHAP_ID}"),
    ("POST", "/wrong"): ("POST", "/v1/wrong-answers/add"),
    ("PUT", "/wrong"): ("PATCH", f"/v1/wrong-answers/{WRONG_ID}"),
    ("POST", "/review"): ("POST", f"/v1/wrong-answers/{WRONG_ID}/review"),
    ("POST", "/sess"): ("POST", "/v1/agent-sessions"),
    ("PUT", "/sess"): ("PATCH", f"/v1/agent-sessions/{SESS_ID}"),
    ("POST", "/msg"): ("POST", f"/v1/agent-sessions/{SESS_ID}/messages"),
    ("POST", "/dec"): ("POST", f"/v1/agent-sessions/{SESS_ID}/decisions"),
    ("POST", "/quiz"): ("POST", f"/v1/learning-resources/{RES_ID}/answers/grade"),
    ("POST", "/prog"): ("PATCH", f"/v1/learning-resources/{RES_ID}/progress"),
    ("POST", "/sf"): ("POST", f"/v1/learning-resources/{RES_ID}/source-feedback"),
    ("GET", "/km"): ("GET", "/v1/knowledge-categories/match"),
    ("GET", "/res"): ("GET", "/v1/learning-resources"),
}


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(sub: str) -> str:
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(json.dumps({"sub": sub, "exp": int(time.time()) + 3600}, separators=(",", ":")).encode())
    msg = f"{header}.{payload}".encode()
    sig = hmac.new(JWT_SECRET.encode(), msg, hashlib.sha256).digest()
    return f"{header}.{payload}.{b64url(sig)}"


TOK = make_jwt(USER_A)


def req(method, path, body=None):
    url = BASE + path
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    r.add_header("Authorization", f"Bearer {TOK}")
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
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
        return status, raw.decode("utf-8", "replace")[:300]


results = []


def check(name, cond, detail=""):
    results.append((name, "PASS" if cond else "FAIL", detail))
    print(f"{'PASS' if cond else 'FAIL':4} | {name} | {detail}")


def norm(o):
    """Recursively sort dict keys so == is order-insensitive; lists keep order."""
    if isinstance(o, dict):
        return {k: norm(v) for k, v in sorted(o.items())}
    if isinstance(o, list):
        return [norm(v) for v in o]
    return o


print("TAG", time.strftime("422%H%M%S"), "BASE", BASE, "REF", len(REF))

unmapped = 0
missing_key = 0
status_bad = 0
shape_bad = 0
pass_n = 0
over_strict = []
no_db = 0
n422 = 0

for case in REF:
    ref_path = case["path"]
    # /km?... and /res?... carry the query on the path; strip for ROUTE lookup.
    bare = ref_path.split("?", 1)[0]
    key = (case["method"], bare)
    if ref_path.startswith("/courses?"):
        method, path = "GET", "/v1/courses" + ref_path[len("/courses"):]
    elif key in ROUTE:
        m, p = ROUTE[key]
        method = m
        path = p + ("?" + ref_path.split("?", 1)[1] if "?" in ref_path else "")
    else:
        unmapped += 1
        check(f"unmapped {case['name']}", False, str(key))
        continue

    st, body = req(method, path, case.get("body") if case["method"] != "GET" else None)

    if case["status"] != 422:
        # Control cases: without a DB these can only be 503/500.
        if st == 422:
            over_strict.append(case["name"])
            check(case["name"], False, f"OVER-STRICT live 422 body={str(body)[:120]}")
        else:
            no_db += 1
        continue

    n422 += 1
    if st != 422:
        status_bad += 1
        check(case["name"], False, f"status {st} != 422 body={str(body)[:120]}")
        continue
    if not isinstance(body, dict) or body.get("code") != "VALIDATION_FAILED":
        missing_key += 1
        check(case["name"], False, f"envelope body={str(body)[:140]}")
        continue
    if norm(body) != norm(case["json"]):
        shape_bad += 1
        check(case["name"], False, f"shape live={json.dumps(body, ensure_ascii=False)[:180]} ref={json.dumps(case['json'], ensure_ascii=False)[:180]}")
        continue
    pass_n += 1

# Path-UUID 422 on the new customize-tasks + resource-task routes.
# rtask create bad type is an HTTPException, not the pydantic envelope.
uuid_cases = [
    ("customize list ok-no-db", "GET", "/v1/customize-tasks", None, 503),
    ("customize get bad uuid", "GET", "/v1/customize-tasks/not-a-uuid", None, 422),
    ("customize slides bad uuid", "GET", "/v1/customize-tasks/not-a-uuid/slides", None, 422),
    ("rtask get bad uuid", "GET", "/v1/learning-resource-tasks/not-a-uuid", None, 422),
    ("rtask cancel bad uuid", "POST", "/v1/learning-resource-tasks/not-a-uuid/cancel", None, 422),
    ("rtask restart bad uuid", "POST", "/v1/learning-resource-tasks/not-a-uuid/restart", None, 422),
    ("rtask create bad type", "POST", "/v1/learning-resource-tasks/nope", {"topic": "t"}, 422),
]
for name, method, path, body, want in uuid_cases:
    st, jb = req(method, path, body)
    ok = st == want
    extra = ""
    if name == "rtask create bad type":
        # Python HTTPException(422, detail="Invalid resource type") — NOT the envelope.
        ok = st == 422 and isinstance(jb, dict) and jb.get("detail") == "Invalid resource type"
        extra = str(jb)[:120]
    elif want == 422 and ok:
        d = (jb or {}).get("details") if isinstance(jb, dict) else None
        ok = (isinstance(jb, dict) and jb.get("code") == "VALIDATION_FAILED"
              and isinstance(d, list) and d and d[0].get("type") in
              ("uuid_parsing", "missing"))
        if isinstance(jb, dict) and jb.get("detail"):
            ok = False
            extra = "got detail-envelope " + str(jb)[:100]
        elif not ok:
            extra = str(jb)[:140]
    elif not ok:
        extra = str(jb)[:140]
    check(name, ok, f"{st} {extra}" if extra else f"{st}")

print()
print(f"=== 422-ONLY {pass_n}/{n422} exact | status_bad={status_bad} "
      f"envelope_bad={missing_key} shape_bad={shape_bad} unmapped={unmapped} ===")
print(f"=== OVER-STRICT (ref-200 live-422) {len(over_strict)}: {over_strict} ===")
print(f"=== NO-DB controls (non-422 ref, live not 422): {no_db} ===")
fails = [r for r in results if r[1] == "FAIL"]
print(f"=== TOTAL {len(results) - len(fails)}/{len(results)} ===")
sys.exit(1 if fails else 0)
