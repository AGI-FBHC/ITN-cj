"""Replay every 4xx case in fastapi_ref_presentations.json against Spire.

Expectations come from measurement, never from memory: this script only reads
tmp_verify/fastapi_ref_presentations.json (produced by fastapi_ref_presentations.py
against FastAPI 0.115.6 / pydantic 2.10.4) and compares status + full body.

Rules:
  * ref 4xx  -> Spire must match status AND body exactly.
  * ref 2xx  -> Spire may answer 503/404/200 (no DB in this run) but must NOT
                answer 422: reaching the handler is what "passed validation"
                means without a database.
  * ref 405 -> Spire must match 405 (or, for the decorator-bug rows, whatever
                the reference itself recorded).

Documented divergences are listed in DIVERGENT below and reported separately
rather than counted as failures.

Run:  JWT_SECRET=... VERIFY_BASE=http://127.0.0.1:19401 \
      PYTHONIOENCODING=utf-8 python -u tmp_verify/diff_presentations.py
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("VERIFY_BASE", "http://127.0.0.1:19401")
JWT_SECRET = os.environ["JWT_SECRET"]
GHOST = "11111111-2222-4333-8444-555555555555"   # matches the reference file

REF_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "fastapi_ref_presentations.json")

# Cases where Spire is *known and documented* to answer differently from
# FastAPI. Each entry: (section, label-substring, reason).
DIVERGENT = [
    ("method_collision", "DELETE batch-delete",
     "the reference app registers no DELETE route at all, so every DELETE is "
     "405 there; real public.py has DELETE /v1/presentations/{task_id} and "
     "Spire correctly answers 422 uuid_parsing for task_id=batch-delete"),
]


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(sub: str) -> str:
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"},
                               separators=(",", ":")).encode())
    payload = b64url(json.dumps({"sub": sub, "exp": int(time.time()) + 3600},
                                separators=(",", ":")).encode())
    msg = f"{header}.{payload}".encode()
    sig = hmac.new(JWT_SECRET.encode(), msg, hashlib.sha256).digest()
    return f"{header}.{payload}.{b64url(sig)}"


def req(method, path, token=None, raw=None, ctype=True):
    url = BASE + path
    data = raw if isinstance(raw, bytes) else (raw.encode("utf-8") if raw is not None else None)
    r = urllib.request.Request(url, data=data, method=method)
    if ctype:
        r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=25) as resp:
            rb = resp.read()
            if not rb:
                return resp.status, None
            try:
                return resp.status, json.loads(rb.decode("utf-8"))
            except Exception:
                return resp.status, {"__raw__": rb.decode("utf-8", "replace")[:300]}
    except urllib.error.HTTPError as e:
        rb = e.read()
        try:
            return e.code, json.loads(rb.decode("utf-8"))
        except Exception:
            return e.code, {"__raw__": rb.decode("utf-8", "replace")[:300]}
    except Exception as e:
        return None, {"__err__": f"{type(e).__name__}: {e}"}


def norm(obj):
    """Canonical text for comparison (dict key order must not matter)."""
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def is_divergent(section, label):
    for sec, sub, _ in DIVERGENT:
        if sec == section and sub in label:
            return True
    return False


_NAN_RE = __import__("re").compile(r"(?<![0-9A-Za-z_])(NaN|Infinity|-Infinity)(?![0-9A-Za-z_])")


def _has_nan_const(text: str) -> bool:
    """True when the body carries a bare NaN/Infinity constant anywhere
    (top-level, inside an array, inside an object — CPython accepts all)."""
    return bool(_NAN_RE.search(text))


def main() -> int:
    ref = json.load(io.open(REF_PATH, encoding="utf-8"))
    tok = make_jwt("11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa")

    # probe: is this Spire actually up (and not a Clash TUN phantom)?
    st, body = req("GET", "/__definitely_not_a_route__")
    if st != 404:
        print(f"ABORT: probe returned {st} {body} — not a live Spire on {BASE}")
        return 2

    passed = failed = skipped = 0
    rows = []

    def record(ok, name, detail, bucket="fail"):
        nonlocal passed, failed
        if ok:
            passed += 1
            rows.append(("PASS", name, ""))
        else:
            failed += 1
            rows.append((bucket.upper(), name, detail))

    # ---------------- progress bodies ----------------
    # The reference file stores label+status+body but not the request body, so
    # rebuild the body texts from the generator's own BODIES tables by
    # re-importing them (no re-measurement, just the input strings).
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import fastapi_ref_presentations as gen  # noqa: E402

    def replay(section, entries, method, path_fn, token=tok, ctype=True):
        nonlocal passed, failed, skipped
        src = dict(gen.BODIES.get(section, {})) if section in gen.BODIES else None
        for case in entries:
            label = case["label"]
            name = f"{section} {label}"
            if is_divergent(section, label):
                skipped += 1
                rows.append(("DIV", name, "documented divergence"))
                continue
            if section == "progress":
                body_txt = dict(gen.BODIES["progress"])[label.split("body:", 1)[1]]
                st, got = req(method, path_fn(), token, raw=body_txt, ctype=ctype)
            elif section == "batch":
                body_txt = dict(gen.BODIES["batch"])[label.split("body:", 1)[1]]
                st, got = req(method, path_fn(), token, raw=body_txt, ctype=ctype)
            elif section == "batch_noct":
                key = label.split("nc:", 1)[1]
                # `nc:ok` is inline in the generator, not a BODIES key
                body_txt = ('{"taskIds": []}' if key == "ok"
                            else dict(gen.BODIES["batch"])[key])
                st, got = req(method, path_fn(), token, raw=body_txt, ctype=False)
            elif section in ("uuid_path", "uuid_rt"):
                u = label.split("uuid:", 1)[1]
                # labels are truncated to 40 chars, so prefer an exact hit
                # (a 37-char uuid is a prefix of a valid 38-char braced one)
                # and only then fall back to prefix matching.
                if u in gen.UUIDS:
                    full = u
                else:
                    full = next((x for x in gen.UUIDS if x.startswith(u)), None)
                if full is None:
                    skipped += 1
                    rows.append(("SKIP", name, "cannot recover uuid"))
                    continue
                # `{`/`}` are illegal raw in a request target; Spire's HTTP
                # layer 400s them before routing, Starlette's test transport
                # does not. Encode so both sides reach the handler.
                tail = full.replace("{", "%7B").replace("}", "%7D")
                st, got = req(method, path_fn(tail), token, ctype=True)
            elif section == "query_rt":
                q = {"rt limit abc": "limit=abc", "rt limit 0": "limit=0",
                     "rt limit 1001": "limit=1001", "rt summary bogus": "summary=bogus",
                     "rt summary 1": "summary=1"}[label]
                st, got = req(method, path_fn(q), token, ctype=True)
            elif section == "method_collision":
                st, got = req("GET" if label.startswith("GET") else "DELETE",
                              "/v1/presentations/batch-delete", token, ctype=True)
            else:
                skipped += 1
                rows.append(("SKIP", name, "no replay rule"))
                continue

            ref_status, ref_body = case["status"], case["body"]
            if ref_status >= 400:
                ok = (st == ref_status and norm(got) == norm(ref_body))
                detail = f"ref={ref_status} {norm(ref_body)[:240]}\n      got={st} {norm(got)[:240]}"
            else:
                # ref reached the handler; Spire must at least not 422
                ok = (st is not None and st != 422)
                detail = f"ref={ref_status} got={st} {norm(got)[:240]}"
            record(ok, name, detail)

    replay("progress", ref["progress"], "POST",
           lambda: f"/v1/presentations/{GHOST}/progress")
    replay("batch", ref["batch"], "POST", lambda: "/v1/presentations/batch-delete")
    replay("batch_noct", ref["batch_noct"], "POST",
           lambda: "/v1/presentations/batch-delete")
    replay("uuid_path", ref["uuid_path"], "GET",
           lambda u: f"/v1/presentations/{u}")
    replay("uuid_rt", ref["uuid_rt"], "GET",
           lambda u: f"/v1/learning-resource-tasks/{u}")
    replay("query_rt", ref["query_rt"], "GET", lambda q: f"/v1/learning-resource-tasks?{q}")
    replay("method_collision", ref["method_collision"], "GET", lambda: None)

    # ---------------- json decode oracle (104 bodies x 2 routes) --------------
    for case in ref["json_errors"]:
        text = case["in"]
        label = (text[:28] + "…") if len(text) > 28 else text
        if case["ok"]:
            # json.loads accepted it -> Spire must not answer json_invalid.
            # NaN/Infinity are accepted by Python but are not JSON to Spire;
            # that is a documented divergence (Python 500s on them downstream).
            for route in ("progress", "batch"):
                p = (f"/v1/presentations/{GHOST}/progress" if route == "progress"
                     else "/v1/presentations/batch-delete")
                st, got = req("POST", p, tok, raw=text)
                j = got.get("detail") if isinstance(got, dict) else None
                is_ji = isinstance(j, list) and j and isinstance(j[0], dict) and \
                    j[0].get("type") == "json_invalid"
                if _has_nan_const(text):
                    # CPython json.loads takes NaN/Infinity/-Infinity as
                    # parse_constant values; Spire's scanner is strict JSON.
                    # Measured on FastAPI 0.115.6: `[NaN]`/`NaN`/`[Infinity]`
                    # -> 500 (pydantic/JSONResponse chokes on the float),
                    # `{"a": NaN}` -> 200 (extra field, never rendered).
                    # Spire answers 422 json_invalid for all of them instead —
                    # reproducing Python would mean returning a 500.
                    skipped += 1
                    rows.append(("DIV", f"json[{route}] {label!r}",
                                 "CPython accepts NaN/Infinity constants; "
                                 "FastAPI then 500s or 200s, Spire 422s"))
                    continue
                record(not is_ji, f"json[{route}] {label!r} accepted by decode",
                       f"{st} {norm(got)[:200]}")
            continue
        if case["in"] == "":
            # routing.py only calls request.json() when body_bytes is truthy,
            # so the 0-byte body never raises and falls out as `missing`.
            expect = {"detail": [{"type": "missing", "loc": ["body"],
                                  "msg": "Field required", "input": None}]}
        else:
            expect = {"detail": [{
                "type": "json_invalid", "loc": ["body", case["pos"]],
                "msg": "JSON decode error", "input": {},
                "ctx": {"error": case["msg"]}}]}
        for route in ("progress", "batch"):
            p = (f"/v1/presentations/{GHOST}/progress" if route == "progress"
                 else "/v1/presentations/batch-delete")
            st, got = req("POST", p, tok, raw=text)
            ok = (st == 422 and norm(got) == norm(expect))
            record(ok, f"json[{route}] {label!r}",
                   f"expect 422 {norm(expect)}\n      got={st} {norm(got)[:240]}")

    # ---------------- transport: raw '{' in the request target ---------------
    # Spire's HTTP parser rejects it before routing; Starlette's in-process
    # transport does not. Handler parity for these inputs is covered above
    # via %7B..%7D.
    for u in ("{00000000-0000-0000-0000-000000000000}",
              "{00000000-0000-0000-0000-00000000000}"):
        st, got = req("GET", f"/v1/presentations/{u}", tok)
        skipped += 1
        rows.append(("DIV", f"raw-brace target {u!r}",
                     f"Spire {st} {norm(got)[:120]} — HTTP layer, not the handler"))

    # ---------------- report -------------------------------------------------
    for status, name, detail in rows:
        if status == "PASS":
            continue
        safe = f"{name} :: {detail}".encode("gbk", "replace").decode("gbk", "replace")
        print(f"{status} | {safe}")
    print(f"\n=== differential: {passed} matched, {failed} mismatched, "
          f"{skipped} documented-divergence ===")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
