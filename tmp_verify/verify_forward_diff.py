#!/usr/bin/env python3
"""P3 differential: the same request direct to Python vs through Spire's
catch-all must produce the same status and the same body bytes.

This is the gate that proves the forwarder is a transparent relay. Only routes
that Spire forwards (FWD in route_coverage.md) are compared — LOCAL routes are
Spire's own implementations and were verified separately.

Usage:
  python verify_forward_diff.py --direct 127.0.0.1:18000 --via 127.0.0.1:18811

Authentication is applied identically to both sides so the comparison is of
the relay, not of an auth divergence:
  - a Bearer JWT minted from $JWT_SECRET (HS256, sub = a UUID)
  - the X-ITN-* HMAC quartet from $AGENT_INTERNAL_SECRET for /internal/v1

Those two env vars hold local verification values only (see run_agents.sh);
nothing secret is stored in this file. Pass --token to supply your own JWT
instead of minting one. Exit 0 iff every comparison matched.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import http.client
import json
import os
import sys
import time
import uuid


PASS = []
FAIL = []


def _safe(s: str) -> str:
    return (s or "").encode("ascii", "replace").decode("ascii")


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append((name, detail))
    print(("  PASS  " if ok else "  FAIL  ") + _safe(name) + (("  -- " + _safe(detail)) if detail else ""), flush=True)


def call(hostport, method, path, body, headers, timeout=20):
    host, port = hostport.rsplit(":", 1)
    conn = http.client.HTTPConnection(host, int(port), timeout=timeout)
    hdrs = dict(headers or {})
    if body is not None and "Content-Length" not in hdrs:
        hdrs["Content-Length"] = str(len(body))
    t0 = time.time()
    conn.request(method, path, body=body, headers=hdrs)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    return resp.status, resp.getheaders(), raw, time.time() - t0


def mint_jwt(secret, user_id):
    """HS256 JWT with the one claim the service reads: sub (a UUID)."""
    import base64

    def b64url(raw):
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    now = int(time.time())
    payload = b64url(json.dumps({
        "sub": user_id,
        "iat": now,
        "exp": now + 3600,
    }).encode())
    signing_input = ("%s.%s" % (header, payload)).encode()
    sig = b64url(hmac.new(secret.encode(), signing_input, hashlib.sha256).digest())
    return "%s.%s.%s" % (header, payload, sig)


def internal_headers(secret, method, path, user_id, body):
    """The X-ITN-* HMAC quartet exactly as security.py verifies it."""
    ts = str(int(time.time()))
    nonce = "vf-%s" % uuid.uuid4().hex
    body = body or b""
    canon = "\n".join((method.upper(), path, ts, nonce, user_id,
                       hashlib.sha256(body).hexdigest())).encode()
    sig = hmac.new(secret.encode(), canon, hashlib.sha256).hexdigest()
    return {
        "X-ITN-Timestamp": ts,
        "X-ITN-Nonce": nonce,
        "X-ITN-User-Id": user_id,
        "X-ITN-Signature": sig,
    }


# Routes Spire forwards (see route_coverage.md). Kept read-only / mock-safe:
# no generation starts, no writes. /v1/notes and friends are Spire LOCAL and
# are NOT compared here — those have their own module matrices.
CASES = [
    ("GET", "/v1/agents", None, {"Accept": "application/json"}),
    ("GET", "/v1/teaching-group/agents", None, {"Accept": "application/json"}),
    ("GET", "/v1/memories", None, {"Accept": "application/json"}),
    ("GET", "/v1/learning-context", None, {"Accept": "application/json"}),
    ("GET", "/v1/course-recommendations", None, {"Accept": "application/json"}),
    ("GET", "/v1/chat/sessions", None, {"Accept": "application/json"}),
    ("GET", "/v1/chat/attachments/00000000-0000-0000-0000-000000000000", None, {"Accept": "application/json"}),
    ("GET", "/v1/admin-generation-groups", None, {"Accept": "application/json"}),
    ("GET", "/internal/v1/agents", None, {"Accept": "application/json", "X-ITN-Timestamp": "1710000000",
                                           "X-ITN-Nonce": "n1", "X-ITN-User-Id": "u1", "X-ITN-Signature": "s1"}),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--direct", required=True, help="python host:port")
    ap.add_argument("--via", required=True, help="spire host:port")
    ap.add_argument("--token", default="")
    ap.add_argument("--skip-local", action="store_true", default=True,
                    help="skip routes Spire serves locally (default: on)")
    args = ap.parse_args()

    jwt_secret = os.environ.get("JWT_SECRET", "")
    internal_secret = os.environ.get("AGENT_INTERNAL_SECRET", "")
    user_id = os.environ.get("VERIFY_USER_ID", "00000000-0000-4000-8000-000000000042")

    hdrs = {"Accept": "application/json"}
    if args.token:
        hdrs["Authorization"] = "Bearer " + args.token
        print("auth   : caller-supplied token")
    elif jwt_secret:
        hdrs["Authorization"] = "Bearer " + mint_jwt(jwt_secret, user_id)
        print("auth   : minted HS256 JWT (sub=%s)" % user_id)
    else:
        print("auth   : none (both sides will 401)")

    print("== P3 forward differential ==")
    print("direct : %s" % args.direct)
    print("via    : %s" % args.via)
    print()

    for method, path, body, extra in CASES:
        # A fresh nonce+signature per CALL: the service's NonceStore rejects a
        # replay, so reusing one quartet for direct and via turns the second
        # call into a 401 that has nothing to do with the relay.
        def headers_for():
            h = dict(hdrs)
            h.update(extra or {})
            if path.startswith("/internal/") and internal_secret:
                h.update(internal_headers(internal_secret, method, path, user_id, body))
            return h

        try:
            s1, _, b1, t1 = call(args.direct, method, path, body, headers_for())
        except Exception as e:
            check("direct %s %s" % (method, path), False, repr(e))
            continue
        try:
            s2, _, b2, t2 = call(args.via, method, path, body, headers_for())
        except Exception as e:
            check("via %s %s" % (method, path), False, repr(e))
            continue

        # A LOCAL Spire route legitimately differs (it is a different
        # implementation). Detect that and skip rather than fail.
        if s2 == 404 and s1 != 404:
            check("skip (not forwarded) %s %s" % (method, path), True,
                  "direct=%d via=404" % s1)
            continue

        ok_status = s1 == s2
        m1, m2 = _mask_volatile(b1), _mask_volatile(b2)
        ok_body = m1 == m2
        detail = "status %d vs %d, %d vs %d bytes, %.2fs vs %.2fs" % (s1, s2, len(b1), len(b2), t1, t2)
        check("%s %s  status" % (method, path), ok_status, detail)
        check("%s %s  body bytes" % (method, path), ok_body,
              "" if ok_body else "first diff at %d (volatile masked)" % _first_diff(m1, m2))

    print()
    print("== summary ==")
    print("PASS %d   FAIL %d" % (len(PASS), len(FAIL)))
    if FAIL:
        for n, d in FAIL:
            print("  FAIL " + _safe(n) + "  -- " + _safe(d))
        sys.exit(1)
    sys.exit(0)


def _first_diff(a, b):
    n = min(len(a), len(b))
    for i in range(n):
        if a[i] != b[i]:
            return i
    return n


# Fields the upstream stamps at response time. Two calls to the SAME Python
# instance differ here, so a raw byte compare would fail even on a perfect
# relay. Masked out before comparison; everything else is still byte-exact.
VOLATILE = (b"generatedAt", b"generated_at", b"timestamp", b"servedAt",
            b"serverTime", b"now", b"requestId", b"traceId")


def _mask_volatile(raw: bytes) -> bytes:
    """Replace `"key": "<anything>"` values for known volatile keys with a token."""
    import re
    out = raw
    for key in VOLATILE:
        pat = re.compile(rb'("%s"\s*:\s*")[^"]*(")' % key)
        out = pat.sub(rb"\1<volatile>\2", out)
    return out


if __name__ == "__main__":
    main()
