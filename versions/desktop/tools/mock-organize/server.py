"""只回一份固定"教学目录"的假模型（SSE 流式，OpenAI 兼容）：离线验证 /api/kb/organize。

用法：python server.py [port]
内核的对话调用走 SSE（data: {...} 行），所以这里按流式回；内容里第二条路径是编造的，
用来验证内核"不轻信模型"（会把编造的路径丢掉）。
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

OUTLINE = {
    "note": "按入场到出场的顺序把这份资料排成两章。",
    "chapters": [
        {"name": "第一章 入场", "docs": ["01.md", "编造的文件.md"]},
        {"name": "第二章 出场", "docs": ["02.md"]},
    ],
}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        _ = self.rfile.read(n)
        text = json.dumps(OUTLINE, ensure_ascii=False)
        half = len(text) // 2
        pieces = [text[:half], text[half:]]
        body = ""
        for p in pieces:
            body += "data: " + json.dumps({"choices": [{"delta": {"content": p}}]}, ensure_ascii=False) + "\n\n"
        body += "data: " + json.dumps({"choices": [{"delta": {}, "finish_reason": "stop"}]}) + "\n\n"
        body += "data: [DONE]\n\n"
        data = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8198
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()