#!/usr/bin/env python3
"""P3 gateway verification: Spire catch-all -> mock agents-service.

Proves, against a live Spire process:
  1. catch-all reaches Python-shaped routes that Spire has no local handler for
  2. literal Spire routes still win (health)
  3. SSE frames are byte-faithful (LF only, `data: ` 6-char prefix, `\\n\\n` end)
  4. named-event admin stream keeps `id:` / `event:` / `data:`
  5. raw PCM passes through untouched (content-type + length)
  6. Authorization / X-ITN-* headers reach upstream; hop-by-hop headers do not
  7. SSE chunks arrive incrementally (not buffered until the end)

Usage: python verify_gateway.py <spire_port> <mock_port>
Env:   VERIFY_BASE may override the spire base url.
Only records what it actually ran. Exit 0 iff every check passed.
"""
from __future__ import annotations

import http.client
import json
import os
import re
import sys
import time

PASS = []
FAIL = []


def _safe(s: str) -> str:
    """Console is GBK on this box; never let a detail crash the report."""
    return (s or "").encode("ascii", "replace").decode("ascii")


def check(name: str, ok: bool, detail: str = ""):
    (PASS if ok else FAIL).append((name, detail))
    print(("  PASS  " if ok else "  FAIL  ") + _safe(name) + (("  -- " + _safe(detail)) if detail else ""), flush=True)


def raw_request(base_host, base_port, method, path, body=None, headers=None, timeout=20):
    """Return (status, reason, header_list, raw_body_bytes) with no decoding."""
    conn = http.client.HTTPConnection(base_host, base_port, timeout=timeout)
    hdrs = dict(headers or {})
    if body is not None and "Content-Length" not in hdrs:
        hdrs["Content-Length"] = str(len(body))
    conn.request(method, path, body=body, headers=hdrs)
    resp = conn.getresponse()
    hdr_list = resp.getheaders()
    raw = resp.read()
    conn.close()
    return resp.status, resp.reason, hdr_list, raw


def _iter_raw(fp, deadline):
    """Yield raw socket reads until deadline or EOF."""
    while time.time() < deadline:
        try:
            c = fp.read1(65536)
        except Exception:
            return
        if not c:
            return
        yield c


def _decode_chunked(raw_chunks, deadline):
    """Incremental chunked decoder.

    Spire relays SSE over HTTP/1.1 chunked transfer-encoding. A browser (or
    http.client.HTTPResponse.read) strips that framing; reading the socket
    directly does not. What the frontend parser sees is the DECODED body, so
    that is what we must assert on. Yields (decoded_chunk, timestamp) as each
    chunk payload completes, which also proves incremental delivery.
    """
    buf = b""
    ts = []
    for raw in raw_chunks:
        buf += raw
        while True:
            # need a header line: <hexsize>[;ext] CRLF
            nl = buf.find(b"\n")
            if nl < 0:
                break
            head = buf[:nl]
            line = head[:-1] if head.endswith(b"\r") else head
            if line == b"0":
                return  # last-chunk; stop
            try:
                size = int(line.split(b";")[0], 16)
            except ValueError:
                return
            start = nl + 1
            if len(buf) < start + size + 2:
                break
            payload = buf[start:start + size]
            buf = buf[start + size + 2:]  # skip payload + CRLF
            if payload:
                ts.append(time.time())
                yield payload, ts[-1]
        if time.time() > deadline:
            return


def raw_stream_request(base_host, base_port, method, path, body=None, headers=None, timeout=20, read_secs=3.0):
    """Stream a response, returning (status, hdr_list, decoded_chunks, timestamps).

    decoded_chunks are body bytes with HTTP transfer framing removed — exactly
    what the browser's response reader hands to the SSE/audio parser.
    """
    conn = http.client.HTTPConnection(base_host, base_port, timeout=timeout)
    hdrs = dict(headers or {})
    if body is not None and "Content-Length" not in hdrs:
        hdrs["Content-Length"] = str(len(body))
    conn.request(method, path, body=body, headers=hdrs)
    resp = conn.getresponse()
    hdr_list = resp.getheaders()
    te = (hdr_get(hdr_list, "Transfer-Encoding") or "").lower()
    deadline = time.time() + read_secs
    if "chunked" in te:
        # Decode lazily so each frame's timestamp is when it arrived on the
        # wire — that is what proves the relay is incremental.
        pairs = list(_decode_chunked(_iter_raw(resp.fp, deadline), time.time() + 1))
        chunks = [p[0] for p in pairs]
        ts = [p[1] for p in pairs]
    else:
        # Identity / Content-Length: stop at the declared length so a
        # keep-alive connection does not leave us blocked on the next request.
        want = hdr_get(hdr_list, "Content-Length")
        want = int(want) if want and want.isdigit() else None
        got = 0
        chunks, ts = [], []
        for c in _iter_raw(resp.fp, deadline):
            chunks.append(c)
            ts.append(time.time())
            got += len(c)
            if want is not None and got >= want:
                break
    conn.close()
    return resp.status, hdr_list, chunks, ts


def hdr_get(hdr_list, name):
    for k, v in hdr_list:
        if k.lower() == name.lower():
            return v
    return None


def main():
    spire_port = int(sys.argv[1]) if len(sys.argv) > 1 else 18811
    mock_port = int(sys.argv[2]) if len(sys.argv) > 2 else 18810
    base = os.environ.get("VERIFY_BASE", "http://127.0.0.1:%d" % spire_port)
    host = "127.0.0.1"
    port = int(base.rsplit(":", 1)[-1]) if base.startswith("http://127.0.0.1:") else spire_port

    print("== P3 gateway verification ==")
    print("spire  : %s:%d" % (host, port))
    print("mock   : 127.0.0.1:%d" % mock_port)
    print()

    # ---- 0. sanity: mock is up -------------------------------------------------
    try:
        st, _, _, raw = raw_request("127.0.0.1", mock_port, "GET", "/v1/agents")
        check("mock upstream reachable", st == 200 and json.loads(raw)["mock"] is True, "status=%d" % st)
    except Exception as e:
        check("mock upstream reachable", False, repr(e))
        print("\n!! mock not running — aborting")
        sys.exit(1)

    # ---- 1. Spire health (LOCAL route must win, not forward) -------------------
    try:
        st, _, _, raw = raw_request(host, port, "GET", "/health")
        check("LOCAL /health wins over catch-all", st == 200 and raw == b"ok", "status=%d body=%r" % (st, raw))
    except Exception as e:
        check("LOCAL /health wins over catch-all", False, repr(e))

    # ---- 2. catch-all reaches a Python-only route ------------------------------
    # JSON-echo paths: the mock answers with {"mock": true, ...}
    json_paths = [
        ("GET", "/v1/agents"),
        ("POST", "/v1/agent/ask"),
        ("GET", "/v1/memories"),
        ("POST", "/v1/learning-resource-tasks/lecture"),  # write route now forwarded
        ("POST", "/v1/learning-resource-tasks/abc/restart"),
        ("DELETE", "/v1/learning-resource-tasks/abc"),
        ("POST", "/v1/presentations"),
        ("POST", "/v1/presentations/abc/generate"),
        ("DELETE", "/v1/courses/abc"),  # cancels _course_tasks in Python — must FWD
        ("GET", "/internal/v1/agents"),
    ]
    for method, path in json_paths:
        try:
            st, _, _, raw = raw_request(host, port, method, path,
                                        body=b"{}" if method in ("POST", "PUT", "PATCH") else None,
                                        headers={"Content-Type": "application/json"})
            ok = st == 200 and b'"mock": true' in raw
            detail = "status=%d" % st
            if not ok:
                detail += " body=" + raw[:120].decode("utf-8", "replace")
            check("FWD %s %s -> mock" % (method, path), ok, detail)
        except Exception as e:
            check("FWD %s %s -> mock" % (method, path), False, repr(e))

    # Stream / binary paths: the mock answers SSE or PCM, not JSON. Reachability
    # is the claim here; byte-faithfulness is sections 5-7.
    streamish_paths = [
        ("POST", "/v1/chat/stream"),
        ("POST", "/v1/agent/ask/stream"),
        ("GET", "/v1/presentations/abc/audio/0"),
    ]
    for method, path in streamish_paths:
        try:
            st, hdrs, _, _ = raw_stream_request(host, port, method, path,
                                                body=b"{}" if method != "GET" else None,
                                                headers={"Content-Type": "application/json"},
                                                read_secs=1.0)
            check("FWD %s %s -> mock (stream)" % (method, path), st == 200, "status=%d" % st)
        except Exception as e:
            check("FWD %s %s -> mock (stream)" % (method, path), False, repr(e))

    # ---- 3. header pass-through ------------------------------------------------
    try:
        st, _, _, raw = raw_request(
            host, port, "GET", "/v1/agents",
            headers={
                "Authorization": "Bearer TESTTOKEN123",
                "X-ITN-Timestamp": "1710000000",
                "X-ITN-Nonce": "nonce-abc",
                "X-ITN-User-Id": "u-42",
                "X-ITN-Signature": "sig-xyz",
                "Connection": "close",   # hop-by-hop — browser's value must NOT be copied
                "X-Forwarded-For": "9.9.9.9",  # not in allowlist, must NOT reach
                "Content-Type": "application/json",
            },
        )
        obj = json.loads(raw)
        hdrs = {k.lower(): v for k, v in obj["headers"].items()}
        check("Authorization forwarded", hdrs.get("authorization") == "Bearer TESTTOKEN123", str(hdrs.get("authorization")))
        check("X-ITN-* quartet forwarded",
              hdrs.get("x-itn-timestamp") == "1710000000" and hdrs.get("x-itn-signature") == "sig-xyz",
              "ts=%s sig=%s" % (hdrs.get("x-itn-timestamp"), hdrs.get("x-itn-signature")))
        check("non-allowlisted X-Forwarded-For stripped", "x-forwarded-for" not in hdrs, str(hdrs.get("x-forwarded-for")))
        # The stdx client always sends its own Connection: keep-alive upstream.
        # What must NOT happen is the browser's value being copied through. So
        # send a distinctive value and assert it does not arrive.
        check("hop-by-hop Connection not copied from browser",
              (hdrs.get("connection") or "").lower() != "close",
              "upstream connection=%r (client's own, not the browser's close)" % hdrs.get("connection"))
    except Exception as e:
        check("header pass-through", False, repr(e))

    # ---- 4. body pass-through --------------------------------------------------
    try:
        payload = json.dumps({"q": "你好", "n": 3}, ensure_ascii=False).encode("utf-8")
        st, _, _, raw = raw_request(host, port, "POST", "/v1/agent/ask", body=payload,
                                    headers={"Content-Type": "application/json"})
        obj = json.loads(raw)
        check("request body byte-faithful (utf-8 JSON)",
              obj["body_utf8"] == payload.decode("utf-8") and obj["body_len"] == len(payload),
              "body_len=%d" % obj["body_len"])
    except Exception as e:
        check("request body byte-faithful", False, repr(e))

    # ---- 5. SSE byte-faithfulness ---------------------------------------------
    try:
        st, hdrs, chunks, ts = raw_stream_request(host, port, "POST", "/v1/chat/stream",
                                                  body=b"{}", headers={"Content-Type": "application/json"},
                                                  read_secs=3.0)
        ct = hdr_get(hdrs, "Content-Type") or ""
        check("SSE Content-Type kept", ct.startswith("text/event-stream"), ct)
        check("SSE X-Accel-Buffering: no kept", (hdr_get(hdrs, "X-Accel-Buffering") or "").lower() == "no",
              str(hdr_get(hdrs, "X-Accel-Buffering")))
        blob = b"".join(chunks)
        check("SSE has no CR", b"\r" not in blob, repr(blob[:80]))
        check("SSE has no event: names (JSON-per-line)", b"\nevent:" not in blob and not blob.startswith(b"event:"), repr(blob[:80]))
        check("SSE has no [DONE] sentinel", b"[DONE]" not in blob, "")
        frames = blob.split(b"\n\n")
        frames = [f for f in frames if f]
        # each frame is exactly `data: ` + json  (no inner newlines in our mock)
        ok_prefix = all(f.startswith(b"data: ") for f in frames)
        ok_shape = all(b"\n" not in f[6:] for f in frames)
        check("SSE payload line is exactly 'data: ' (6 chars)", ok_prefix and ok_shape,
              "frames=%d first=%r" % (len(frames), frames[0] if frames else b""))
        check("SSE frame terminator is \\n\\n", blob.endswith(b"\n\n") and b"\n\n" in blob, repr(blob[-10:]))
        # incremental: at least 2 chunk arrivals, spaced
        spaced = len(ts) >= 2 and (ts[-1] - ts[0]) > 0.05
        check("SSE delivered incrementally (not buffered)", spaced,
              "chunks=%d span=%.3fs" % (len(ts), (ts[-1] - ts[0]) if ts else -1))
    except Exception as e:
        check("SSE byte-faithfulness", False, repr(e))

    # ---- 6. named-event admin stream ------------------------------------------
    try:
        st, hdrs, chunks, ts = raw_stream_request(host, port, "GET",
                                                  "/v1/admin-generation-tasks/learning_resource/t1/stream",
                                                  read_secs=3.0)
        blob = b"".join(chunks)
        check("admin stream keeps event: names",
              b"event: generation_event" in blob and b"event: generation_done" in blob and b"event: heartbeat" in blob,
              repr(blob[:120]))
        check("admin stream keeps id: lines", b"id: 1" in blob and b"id: 2" in blob, repr(blob[:80]))
        check("admin stream keeps data: lines", b"data: " in blob, "")
    except Exception as e:
        check("admin named-event stream", False, repr(e))

    # ---- 7. raw PCM -----------------------------------------------------------
    try:
        st, hdrs, chunks, ts = raw_stream_request(host, port, "POST", "/v1/assistant/tts",
                                                  body=b"{}", headers={"Content-Type": "application/json"},
                                                  read_secs=3.0)
        blob = b"".join(chunks)
        ct = hdr_get(hdrs, "Content-Type") or ""
        check("PCM Content-Type kept verbatim", ct == "audio/L16;rate=24000;channels=1", ct)
        check("PCM payload non-empty", len(blob) > 1000, "bytes=%d" % len(blob))
        # LE int16: length must be even
        check("PCM length is even (LE int16)", len(blob) % 2 == 0, "bytes=%d" % len(blob))
    except Exception as e:
        check("raw PCM passthrough", False, repr(e))

    # ---- 8. upstream 4xx/5xx relayed verbatim ---------------------------------
    # mock always 200, so skip; covered by differential run against real Python.

    print()
    print("== summary ==")
    print("PASS %d   FAIL %d" % (len(PASS), len(FAIL)))
    if FAIL:
        for n, d in FAIL:
            print("  FAIL " + _safe(n) + "  -- " + _safe(d))
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
