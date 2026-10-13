"""本地 OpenAI 兼容 mock 服务，仅用于开发自测，不接入任何真实模型。

用法：python server.py [port]
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        body = json.loads(raw) if raw else {}

        if self.path.endswith("/chat/completions"):
            messages = body.get("messages") or []
            last = messages[-1].get("content") if messages else ""
            if isinstance(last, list):
                # 视觉请求：content 是分段数组
                has_image = any(part.get("type") == "image_url" for part in last if isinstance(part, dict))
                last = "MOCK_VISION_CAPTION:看到一张图片" if has_image else "MOCK_VISION_NONE"
            out = {
                "id": "mock-chat",
                "object": "chat.completion",
                "model": body.get("model", "mock"),
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": "MOCK_REPLY:" + str(last)[:80]},
                    "finish_reason": "stop",
                }],
            }
        elif self.path.endswith("/embeddings"):
            items = body.get("input")
            if isinstance(items, str):
                items = [items]
            items = items or []
            out = {
                "object": "list",
                "model": body.get("model", "mock-embed"),
                "data": [
                    {"object": "embedding", "index": i, "embedding": [float((len(t) + i) % 7) / 7.0, 0.5, 0.25]}
                    for i, t in enumerate(items)
                ],
            }
        else:
            self.send_response(404)
            self.end_headers()
            return

        payload = json.dumps(out).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
