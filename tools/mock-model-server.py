"""Local OpenAI-compatible mock for development verification only.

Serves /v1/embeddings and /v1/chat/completions so the knowledge base and the AI
tutor can be exercised end to end without a real provider key. Not part of the
application runtime; do not deploy.

    python tools/mock-model-server.py --port 8790
"""

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DIM = 64
ANSWER = "根据课程资料 [1]，这个概念的核心仍然是指针与下标的配合。先说结论：循环队列用取模把队尾绕回开头，代价是要额外记录元素个数。资料里提到，否则队空与队满的判定会变成同一个条件。"


def embed(text):
    vec = [0.0] * DIM
    data = text.encode("utf-8")
    for i in range(len(data) - 1):
        vec[(data[i] * 31 + data[i + 1]) % DIM] += 1.0
    if not any(vec):
        vec[0] = 1.0
    return vec


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path.endswith("/embeddings"):
            inputs = body.get("input") or []
            if isinstance(inputs, str):
                inputs = [inputs]
            self._json({
                "object": "list",
                "model": body.get("model", "mock-embed"),
                "data": [
                    {"object": "embedding", "index": index, "embedding": embed(text)}
                    for index, text in enumerate(inputs)
                ],
                "usage": {"prompt_tokens": 8, "total_tokens": 8},
            })
            return
        if self.path.endswith("/chat/completions"):
            if not body.get("stream"):
                self._json({
                    "id": "mock",
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": ANSWER}, "finish_reason": "stop"}],
                })
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            for start in range(0, len(ANSWER), 8):
                piece = ANSWER[start:start + 8]
                chunk = {"choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}]}
                self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode("utf-8"))
                self.wfile.flush()
                time.sleep(0.01)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return
        self.send_error(404)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8790)
    args = parser.parse_args()
    print(f"mock model server on http://127.0.0.1:{args.port}/v1", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
