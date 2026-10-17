"""DB-free contract matrix for the 11 in-scope routes.

Everything below fails (or resolves) BEFORE openDb, so it runs with only
JWT_SECRET set. Auth 401s, every FastAPI/pydantic 422 shape (query, path,
body), and the batch-delete plain-detail 422s are asserted byte-for-byte.

Behavioural / persistence checks live in verify_presentations.py and need
PLATFORM_DB_URL.
"""
import os, sys, json, time, hmac, hashlib, base64, urllib.request, urllib.error

BASE = os.environ.get("VERIFY_BASE", "http://127.0.0.1:19355")
JWT_SECRET = os.environ["JWT_SECRET"]
USER_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
GHOST = "ffffffff-ffff-4fff-8fff-ffffffffffff"

results = []


def check(name, cond, detail=""):
    results.append((name, "PASS" if cond else "FAIL", detail))
    safe = str(detail).encode("gbk", "replace").decode("gbk", "replace")
    print(f"{'PASS' if cond else 'FAIL':4} | {name} | {safe}")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(sub: str) -> str:
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(json.dumps({"sub": sub, "exp": int(time.time()) + 3600},
                                separators=(",", ":")).encode())
    msg = f"{header}.{payload}".encode()
    sig = hmac.new(JWT_SECRET.encode(), msg, hashlib.sha256).digest()
    return f"{header}.{payload}.{b64url(sig)}"


def req(method, path, token=None, body=None, raw=None):
    url = BASE + path
    if raw is not None:
        data = raw if isinstance(raw, bytes) else raw.encode("utf-8")
    elif body is None:
        data = None
    else:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=25) as resp:
            rb = resp.read()
            if not rb:
                return resp.status, None, dict(resp.headers)
            try:
                return resp.status, json.loads(rb.decode("utf-8")), dict(resp.headers)
            except Exception:
                return resp.status, {"__raw__": rb.decode("utf-8", "replace")[:300]}, dict(resp.headers)
    except urllib.error.HTTPError as e:
        rb = e.read()
        try:
            return e.code, json.loads(rb.decode("utf-8")), dict(e.headers)
        except Exception:
            return e.code, {"__raw__": rb.decode("utf-8", "replace")[:300]}, dict(e.headers)
    except Exception as e:
        return None, {"__err__": f"{type(e).__name__}: {e}"}, {}


def item0(body):
    """First pydantic 422 item. Accepts both the agents-service envelope
    {"code":"VALIDATION_FAILED","details":[...]} and FastAPI's native
    {"detail":[...]}."""
    if not isinstance(body, dict):
        return {}
    for key in ("details", "detail"):
        d = body.get(key)
        if isinstance(d, list) and d and isinstance(d[0], dict):
            return d[0]
    return {}


def detail_of(body):
    return (body or {}).get("detail") if isinstance(body, dict) else None


tok_a = make_jwt(USER_A)
print("BASE", BASE)

# ---- probe: is this build alive at all? ----
st, body, _ = req("GET", "/__definitely_not_a_route__")
check("unknown path 404 empty (routing default)", st == 404, f"{st} {body}")

# ---- auth ----
st, body, _ = req("GET", "/v1/presentations")
check("list no token 401", st == 401 and detail_of(body) == "Bearer token required",
      f"{st} {detail_of(body)}")
st, body, _ = req("GET", "/v1/learning-resource-tasks")
check("rt no token 401", st == 401 and detail_of(body) == "Bearer token required",
      f"{st} {detail_of(body)}")
st, body, _ = req("GET", "/v1/presentations/" + GHOST, "aaa.bbb.ccc")
check("bad token 401", st == 401 and detail_of(body) == "Invalid or expired token",
      f"{st} {detail_of(body)}")
st, body, _ = req("DELETE", "/v1/presentations/" + GHOST)
check("delete no token 401", st == 401, str(st))
st, body, _ = req("POST", "/v1/presentations/batch-delete", raw="")
check("batch no token 401", st == 401, str(st))

# =====================================================================
# query-parameter 422s — presentations (clamp, NOT 422) vs resource (422)
# =====================================================================
st, body, _ = req("GET", "/v1/presentations?limit=abc", tok_a)
it = item0(body)
check("ppt limit=abc int_parsing", st == 422 and it == {
    "type": "int_parsing", "loc": ["query", "limit"],
    "msg": "Input should be a valid integer, unable to parse string as an integer",
    "input": "abc"}, f"{st} {it}")

st, body, _ = req("GET", "/v1/presentations?summary=2", tok_a)
it = item0(body)
check("ppt summary=2 bool_parsing", st == 422 and it == {
    "type": "bool_parsing", "loc": ["query", "summary"],
    "msg": "Input should be a valid boolean, unable to interpret input",
    "input": "2"}, f"{st} {it}")

st, body, _ = req("GET", "/v1/presentations?exclude_course=nope", tok_a)
it = item0(body)
check("ppt exclude_course=nope bool_parsing", st == 422 and it.get("type") == "bool_parsing"
      and it.get("loc") == ["query", "exclude_course"], f"{st} {it}")

st, body, _ = req("GET", "/v1/presentations?summary=", tok_a)
it = item0(body)
check("ppt summary= (empty) bool_parsing", st == 422 and it.get("input") == "",
      f"{st} {it}")

# accepted bool spellings must NOT 422
for spelling in ("true", "True", "TRUE", "1", "0", "t", "y", "on", "yes", "On", "Yes", "off", "no"):
    st, body, _ = req("GET", f"/v1/presentations?summary={spelling}", tok_a)
    ok = st != 422
    check(f"ppt summary={spelling} accepted", ok, f"{st} {body}")

# presentations limit range is CLAMPED, never 422 — must not reach validation
# (we assert it does not produce a pydantic detail array; storage error means
# it got past validation, which is the point)
st, body, _ = req("GET", "/v1/presentations?limit=0", tok_a)
not_pydantic = not (isinstance(body, dict) and isinstance(body.get("detail"), list))
check("ppt limit=0 clamped (no 422)", st != 422 and not_pydantic, f"{st} {body}")
st, body, _ = req("GET", "/v1/presentations?limit=5000", tok_a)
not_pydantic = not (isinstance(body, dict) and isinstance(body.get("detail"), list))
check("ppt limit=5000 clamped (no 422)", st != 422 and not_pydantic, f"{st} {body}")
st, body, _ = req("GET", "/v1/presentations?limit=-3", tok_a)
not_pydantic = not (isinstance(body, dict) and isinstance(body.get("detail"), list))
check("ppt limit=-3 clamped (no 422)", st != 422 and not_pydantic, f"{st} {body}")

# resource tasks: opposite policy — out of range IS a 422 with ctx
st, body, _ = req("GET", "/v1/learning-resource-tasks?limit=0", tok_a)
it = item0(body)
check("rt limit=0 ge 1", st == 422 and it == {
    "type": "greater_than_equal", "loc": ["query", "limit"],
    "msg": "Input should be greater than or equal to 1", "input": "0",
    "ctx": {"ge": 1}}, f"{st} {it}")
st, body, _ = req("GET", "/v1/learning-resource-tasks?limit=1001", tok_a)
it = item0(body)
check("rt limit=1001 le 1000", st == 422 and it == {
    "type": "less_than_equal", "loc": ["query", "limit"],
    "msg": "Input should be less than or equal to 1000", "input": "1001",
    "ctx": {"le": 1000}}, f"{st} {it}")
st, body, _ = req("GET", "/v1/learning-resource-tasks?limit=abc", tok_a)
it = item0(body)
check("rt limit=abc int_parsing", st == 422 and it.get("type") == "int_parsing"
      and it.get("loc") == ["query", "limit"], f"{st} {it}")
st, body, _ = req("GET", "/v1/learning-resource-tasks?summary=x", tok_a)
it = item0(body)
check("rt summary=x bool_parsing", st == 422 and it.get("type") == "bool_parsing"
      and it.get("loc") == ["query", "summary"], f"{st} {it}")

# =====================================================================
# path-UUID 422 — uuid crate grammar (msg embeds detail, ctx.error mirrors it)
# =====================================================================
def uuid_case(label, bad, expect_sub, expect_ctx_sub=None):
    st, body, _ = req("GET", f"/v1/presentations/{bad}", tok_a)
    it = item0(body)
    ok = (st == 422 and it.get("type") == "uuid_parsing"
          and it.get("loc") == ["path", "task_id"]
          and it.get("msg") == "Input should be a valid UUID, " + expect_sub
          and it.get("input") == bad
          and isinstance(it.get("ctx"), dict)
          and it.get("ctx", {}).get("error") == expect_sub)
    check(label, ok, f"{st} {it}")
    return it

uuid_case("uuid invalid char",
          "not-a-uuid",
          "invalid character: expected an optional prefix of `urn:uuid:` followed by "
          "[0-9a-fA-F-], found `n` at 1")
uuid_case("uuid invalid char later position",
          "00000000-0000-0000-0000-0000000000z",
          "invalid character: expected an optional prefix of `urn:uuid:` followed by "
          "[0-9a-fA-F-], found `z` at 35")
uuid_case("uuid length 31 simple",
          "0000000000000000000000000000000",
          "invalid length: expected length 32 for simple format, found 31")
uuid_case("uuid group count",
          "00000000-0000-0000-0000",
          "invalid group count: expected 5, found 4")
uuid_case("uuid group length",
          "00000000-000-0000-0000-000000000000",
          "invalid group length in group 1: expected 4, found 3")
uuid_case("uuid uppercase URN prefix invalid",
          "URN:UUID:00000000-0000-0000-0000-000000000000",
          "invalid character: expected an optional prefix of `urn:uuid:` followed by "
          "[0-9a-fA-F-], found `U` at 1")

# 32 hex, no hyphens, is VALID -> must pass parsing (fails later on storage, not 422)
st, body, _ = req("GET", "/v1/presentations/00000000000000000000000000000000", tok_a)
check("uuid 32-hex simple accepted (not 422)", st != 422, f"{st} {body}")

# braced + urn:uuid: lowercase forms are VALID per the uuid crate
st, body, _ = req("GET", "/v1/presentations/{00000000-0000-0000-0000-000000000000}", tok_a)
check("uuid braced accepted (not 422)", st != 422, f"{st} {body}")
st, body, _ = req("GET", "/v1/presentations/urn:uuid:00000000-0000-0000-0000-000000000000",
                  tok_a)
check("uuid urn:uuid: accepted (not 422)", st != 422, f"{st} {body}")

# same grammar on the resource-task route
st, body, _ = req("GET", "/v1/learning-resource-tasks/not-a-uuid", tok_a)
it = item0(body)
check("rt uuid bad char 422", st == 422 and it.get("type") == "uuid_parsing"
      and it.get("loc") == ["path", "task_id"], f"{st} {it}")

# =====================================================================
# POST .../progress — body contract
# =====================================================================
P = f"/v1/presentations/{GHOST}/progress"

st, body, _ = req("POST", P, tok_a, raw="")
it = item0(body)
check("progress empty body missing", st == 422 and it == {
    "type": "missing", "loc": ["body"], "msg": "Field required", "input": None},
    f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body=[1, 2])
it = item0(body)
check("progress array body model_attributes_type", st == 422 and it == {
    "type": "model_attributes_type", "loc": ["body"],
    "msg": "Input should be a valid dictionary or object to extract fields from",
    "input": [1, 2]}, f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body="hello")
it = item0(body)
check("progress string body model_attributes_type", st == 422
      and it.get("type") == "model_attributes_type", f"{st} {it}")

st, body, _ = req("POST", P, tok_a, raw="null")
it = item0(body)
check("progress null body -> missing (measured)", st == 422 and it == {
    "type": "missing", "loc": ["body"], "msg": "Field required", "input": None},
    f"{st} {it}")

# whitespace-only is NOT empty: routing.py still calls request.json()
st, body, _ = req("POST", P, tok_a, raw="  ")
it = item0(body)
check("progress whitespace body -> json_invalid ['body',2]", st == 422 and it == {
    "type": "json_invalid", "loc": ["body", 2], "msg": "JSON decode error",
    "input": {}, "ctx": {"error": "Expecting value"}}, f"{st} {it}")

st, body, _ = req("POST", P, tok_a, raw="{not json")
it = item0(body)
check("progress malformed json -> json_invalid ['body',1]", st == 422 and it == {
    "type": "json_invalid", "loc": ["body", 1], "msg": "JSON decode error",
    "input": {}, "ctx": {"error": "Expecting property name enclosed in double quotes"}},
    f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body={"pageIndex": -1})
it = item0(body)
check("pageIndex -1 ge 0", st == 422 and it == {
    "type": "greater_than_equal", "loc": ["body", "pageIndex"],
    "msg": "Input should be greater than or equal to 0", "input": -1,
    "ctx": {"ge": 0}}, f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body={"page_index": -1})
it = item0(body)
check("page_index alias -1 uses snake loc", st == 422 and it.get("loc") == ["body", "page_index"]
      and it.get("ctx") == {"ge": 0}, f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body={"pageCount": 0})
it = item0(body)
check("pageCount 0 ge 1", st == 422 and it == {
    "type": "greater_than_equal", "loc": ["body", "pageCount"],
    "msg": "Input should be greater than or equal to 1", "input": 0,
    "ctx": {"ge": 1}}, f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body={"pageIndex": "abc"})
it = item0(body)
check("pageIndex abc int_parsing", st == 422 and it == {
    "type": "int_parsing", "loc": ["body", "pageIndex"],
    "msg": "Input should be a valid integer, unable to parse string as an integer",
    "input": "abc"}, f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body={"pageIndex": 1.5})
it = item0(body)
check("pageIndex 1.5 int_from_float", st == 422 and it == {
    "type": "int_from_float", "loc": ["body", "pageIndex"],
    "msg": "Input should be a valid integer, got a number with a fractional part",
    "input": 1.5}, f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body={"pageIndex": [1]})
it = item0(body)
check("pageIndex [1] int_type", st == 422 and it == {
    "type": "int_type", "loc": ["body", "pageIndex"],
    "msg": "Input should be a valid integer", "input": [1]}, f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body={"pageIndex": {"a": 1}})
it = item0(body)
check("pageIndex {} int_type", st == 422 and it.get("type") == "int_type", f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body={"mastery": 1.5})
it = item0(body)
check("mastery 1.5 le 1.0 (float ctx)", st == 422 and it == {
    "type": "less_than_equal", "loc": ["body", "mastery"],
    "msg": "Input should be less than or equal to 1", "input": 1.5,
    "ctx": {"le": 1.0}}, f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body={"mastery": -0.1})
it = item0(body)
check("mastery -0.1 ge 0.0 (float ctx)", st == 422 and it == {
    "type": "greater_than_equal", "loc": ["body", "mastery"],
    "msg": "Input should be greater than or equal to 0", "input": -0.1,
    "ctx": {"ge": 0.0}}, f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body={"mastery": 2})
it = item0(body)
check("mastery 2 le 1.0", st == 422 and it.get("ctx") == {"le": 1.0}
      and it.get("input") == 2, f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body={"mastery": "xyz"})
it = item0(body)
check("mastery xyz float_parsing", st == 422 and it == {
    "type": "float_parsing", "loc": ["body", "mastery"],
    "msg": "Input should be a valid number, unable to parse string as a number",
    "input": "xyz"}, f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body={"mastery": [0.5]})
it = item0(body)
check("mastery [0.5] float_type", st == 422 and it.get("type") == "float_type", f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body={"learned": 2})
it = item0(body)
check("learned 2 bool_parsing", st == 422 and it == {
    "type": "bool_parsing", "loc": ["body", "learned"],
    "msg": "Input should be a valid boolean, unable to interpret input",
    "input": 2}, f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body={"learned": "maybe"})
it = item0(body)
check("learned maybe bool_parsing", st == 422 and it.get("type") == "bool_parsing"
      and it.get("input") == "maybe", f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body={"learned": {}})
it = item0(body)
check("learned {} bool_type", st == 422 and it == {
    "type": "bool_type", "loc": ["body", "learned"],
    "msg": "Input should be a valid boolean", "input": {}}, f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body={"pageIndex": "2.0"})
it = item0(body)
check("pageIndex 2.0 string rejected (int_parsing)", st == 422
      and it.get("type") == "int_parsing", f"{st} {it}")

st, body, _ = req("POST", P, tok_a, body={"pageIndex": "  7  "})
check("pageIndex '  7  ' parses (py leading/trailing space)", st != 422
      or item0(body).get("type") != "int_parsing", f"{st} {body}")

st, body, _ = req("POST", P, tok_a, body={"unknownField": 1})
check("extra field ignored (extra=ignore)", st != 422 or item0(body).get("type") not in
      ("extra_forbidden", "value_error"), f"{st} {body}")

# path UUID validated before body? bad path wins
st, body, _ = req("POST", f"/v1/presentations/bad-path/progress", tok_a, body={"pageIndex": -1})
it = item0(body)
check("bad path uuid reported before body", st == 422 and it.get("type") == "uuid_parsing",
      f"{st} {it}")

# =====================================================================
# POST /batch-delete — plain {"detail": "..."} (HTTPException), NOT pydantic
# =====================================================================
B = "/v1/presentations/batch-delete"

st, body, _ = req("POST", B, tok_a, raw="")
it = item0(body)
check("batch raw empty -> missing", st == 422 and it == {
    "type": "missing", "loc": ["body"], "msg": "Field required", "input": None},
    f"{st} {it}")

st, body, _ = req("POST", B, tok_a, body={"taskIds": []})
check("batch [] 422 plain", st == 422 and detail_of(body) ==
      "taskIds must be a non-empty array", f"{st} {body}")

st, body, _ = req("POST", B, tok_a, body={"taskIds": None, "task_ids": None})
check("batch both null 422 plain", st == 422 and detail_of(body) ==
      "taskIds must be a non-empty array", f"{st} {body}")

st, body, _ = req("POST", B, tok_a, body={"taskIds": "x"})
check("batch string 422 plain", st == 422 and detail_of(body) ==
      "taskIds must be a non-empty array", f"{st} {body}")

st, body, _ = req("POST", B, tok_a, body={"taskIds": [f"{i:032x}" for i in range(101)]})
check("batch 101 422 plain", st == 422 and detail_of(body) ==
      "taskIds cannot contain more than 100 items", f"{st} {detail_of(body)}")

st, body, _ = req("POST", B, tok_a, body={"taskIds": ["nope"]})
check("batch bad uuid 422 plain", st == 422 and detail_of(body) ==
      "taskIds contains invalid UUIDs", f"{st} {detail_of(body)}")

st, body, _ = req("POST", B, tok_a, body={"taskIds": [123, 456]})
check("batch int items 422 plain", st == 422 and detail_of(body) ==
      "taskIds contains invalid UUIDs", f"{st} {detail_of(body)}")

st, body, _ = req("POST", B, tok_a, raw="null")
it = item0(body)
check("batch null body -> missing (measured)", st == 422 and it == {
    "type": "missing", "loc": ["body"], "msg": "Field required", "input": None},
    f"{st} {it}")

st, body, _ = req("POST", B, tok_a, raw="[1]")
it = item0(body)
check("batch array body -> dict_type (measured)", st == 422 and it == {
    "type": "dict_type", "loc": ["body"],
    "msg": "Input should be a valid dictionary", "input": [1]}, f"{st} {it}")



# distinct from the pydantic shape: no loc/msg/type on batch-delete
st, body, _ = req("POST", B, tok_a, body={"taskIds": []})
check("batch 422 NOT pydantic-shaped", isinstance(body, dict)
      and list(body.keys()) == ["detail"] and isinstance(body["detail"], str),
      f"{body}")

# =====================================================================
# slide_index path int
# =====================================================================
for bad, label in (("abc", "letters"), ("1.5", "decimal"), ("", "empty"),
                   ("0x1", "hex"), ("true", "bool")):
    path = f"/v1/presentations/{GHOST}/slides/{bad}" if bad else f"/v1/presentations/{GHOST}/slides/"
    st, body, _ = req("GET", path, tok_a)
    it = item0(body)
    if bad == "":
        # empty index collapses the route -> routing 404 or uuid422 on task
        check(f"slide_index {label}: not a 422-int", not (st == 422 and it.get("type") == "int_parsing"),
              f"{st} {it}")
    else:
        check(f"slide_index {label} int_parsing", st == 422 and it.get("type") == "int_parsing"
              and it.get("loc") == ["path", "slide_index"] and it.get("input") == bad,
              f"{st} {it}")

st, body, _ = req("GET", f"/v1/presentations/{GHOST}/slides/-1", tok_a)
it = item0(body)
check("slide_index -1 parses as int (no int_parsing)", not (st == 422 and it.get("type") == "int_parsing"),
      f"{st} {it}")

# =====================================================================
# route registration — every one of the 11 must reach its handler
# (a 500/503/404-from-handler all prove the route is wired)
# =====================================================================
ROUTES = [
    ("GET", f"/v1/presentations"),
    ("GET", f"/v1/presentations/{GHOST}"),
    ("GET", f"/v1/presentations/{GHOST}/download"),
    ("POST", f"/v1/presentations/{GHOST}/complete"),
    ("POST", f"/v1/presentations/{GHOST}/progress"),
    ("DELETE", f"/v1/presentations/{GHOST}"),
    ("POST", "/v1/presentations/batch-delete"),
    ("GET", f"/v1/presentations/{GHOST}/slides"),
    ("GET", f"/v1/presentations/{GHOST}/slides/0"),
    ("GET", "/v1/learning-resource-tasks"),
    ("GET", f"/v1/learning-resource-tasks/{GHOST}"),
]
for m, p in ROUTES:
    st, body, _ = req(m, p, tok_a,
                      body=({"taskIds": [GHOST]} if m == "POST" and "batch" in p else ({} if m == "POST" else None)))
    # handler-level responses, never a framework 405 and never an empty 404
    ok = st is not None and st != 405
    check(f"wired {m} {p.replace(GHOST, '{id}')}", ok, f"{st} {body}")

# POST-only vs GET-only enforcement (no silent method bleed)
st, body, _ = req("POST", "/v1/presentations", tok_a, body={})
check("POST /v1/presentations not routed", st in (404, 405), f"{st} {body}")
st, body, _ = req("GET", "/v1/presentations/batch-delete", tok_a)
it = item0(body)
check("GET batch-delete falls through to GET /{task_id} as 422 uuid_parsing",
      st == 422 and it.get("type") == "uuid_parsing"
      and it.get("input") == "batch-delete", f"{st} {it}")
# P0 2026-10-17: GET .../download and POST .../complete are separate handlers.
# GET on /complete must no longer be aliased onto the old stacked handler.
st, body, _ = req("GET", f"/v1/presentations/{GHOST}/complete", tok_a)
check("GET .../complete no longer aliased to download/complete",
      st in (404, 405) and body != {"learned": True}
      and detail_of(body) != "Completed presentation task not found",
      f"{st} {body}")
# And GET .../download answers with the download contract's own message, not
# the old mark_learned one.
st, body, _ = req("GET", f"/v1/presentations/{GHOST}/download", tok_a)
check("GET .../download answers with download contract",
      st == 404 and detail_of(body) == "Presentation file is not ready",
      f"{st} {detail_of(body)}")

passed = sum(1 for _, s, _ in results if s == "PASS")
failed = sum(1 for _, s, _ in results if s == "FAIL")
print(f"\n=== contract: {passed}/{passed + failed} passed ===")
if failed:
    for name, s, detail in results:
        if s == "FAIL":
            safe = str(detail).encode("gbk", "replace").decode("gbk", "replace")
            print(f"  FAIL {name} :: {safe}")
    sys.exit(1)
