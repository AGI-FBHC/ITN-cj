#!/usr/bin/env python3
"""Mock Python agents-service for P3 gateway verification.

Stdlib only. Speaks just enough of the real service's wire shape to prove the
Spire catch-all relays bytes faithfully:

  * JSON echo for ordinary /v1 routes  (method, path, headers, body)
  * SSE frames for */stream paths      (LF `data: {json}\\n\\n`, no `event:`)
  * named-event SSE for admin-generation-tasks/*/stream
    (`id:` + `event: generation_event|generation_done|heartbeat` + `data:`)
  * raw PCM for */audio* and */tts* paths (LE Int16 @ 24 kHz shape)

No secrets. Binds 127.0.0.1 only. Usage: python mock_agents.py <port>
"""
from __future__ import annotations

import json
import re
import struct
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ADMIN_STREAM = re.compile(r"^/v1/admin-generation-tasks/[^/]+/[^/]+/stream$")
STREAMISH = re.compile(r"(stream|asr)$|/stream$|/audio-stream$|/image-stream$|/plan-stream$")
AUDIOISH = re.compile(r"(/tts|/audio)")


def _int16_pcm(seconds: float, hz: int = 24000, freq: float = 440.0) -> bytes:
    import math

    n = int(seconds * hz)
    return b"".join(struct.pack("<h", int(3000 * math.sin(2 * math.pi * freq * i / hz))) for i in range(n))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "mock-agents/1.0"

    def log_message(self, fmt, *args):  # quiet
        sys.stderr.write("mock %s\n" % (fmt % args))

    def _read_body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n > 0 else b""

    def _hdrs(self):
        return {k: v for k, v in self.headers.items()}

    def _send_json(self, obj, status=200):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _send_sse(self, frames, named: bool = False):
        """frames: list of (event_name_or_None, payload_dict_or_str)."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            for i, (ev, payload) in enumerate(frames):
                if isinstance(payload, str):
                    data = payload
                else:
                    data = json.dumps(payload, ensure_ascii=False)
                buf = []
                if named and ev:
                    buf.append("id: %d" % (i + 1))
                    buf.append("event: %s" % ev)
                buf.append("data: %s" % data)
                chunk = ("\n".join(buf) + "\n\n").encode("utf-8")  # LF only
                self.wfile.write(chunk)
                self.wfile.flush()
                time.sleep(0.15)
        except Exception as e:
            sys.stderr.write("mock SSE frame error: %r\n" % (e,))
        self.close_connection = True

    def _send_pcm(self, seconds: float):
        raw = _int16_pcm(seconds)
        self.send_response(200)
        self.send_header("Content-Type", "audio/L16;rate=24000;channels=1")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _dispatch(self, method: str):
        path = self.path
        body = self._read_body()

        # 1) admin named-event stream
        if ADMIN_STREAM.match(path.split("?")[0]):
            self._send_sse(
                [
                    ("generation_event", {"type": "generation_event", "step": 1, "ok": True}),
                    ("generation_event", {"type": "generation_event", "step": 2, "ok": True}),
                    ("heartbeat", {"type": "heartbeat", "ts": 1}),
                    ("generation_done", {"type": "generation_done", "ok": True}),
                ],
                named=True,
            )
            return

        # 2) PCM
        if AUDIOISH.search(path) and "stream" not in path:
            self._send_pcm(0.2)
            return

        # 3) generic SSE
        if STREAMISH.search(path) or "/chat/stream" in path or path.endswith("/stream"):
            self._send_sse(
                [
                    (None, {"type": "start", "ok": True}),
                    (None, {"type": "delta", "text": "hello"}),
                    (None, {"type": "delta", "text": "world"}),
                    (None, {"type": "done", "ok": True}),
                ],
                named=False,
            )
            return

        # 4) JSON echo
        self._send_json(
            {
                "mock": True,
                "method": method,
                "path": path,
                "headers": self._hdrs(),
                "body_len": len(body),
                "body_utf8": body.decode("utf-8", "replace")[:4000],
            }
        )

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_OPTIONS(self):
        self._dispatch("OPTIONS")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18810
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("mock-agents on 127.0.0.1:%d" % port, flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
