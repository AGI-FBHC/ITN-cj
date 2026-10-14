"""会调用工具的假模型（SSE 流式，OpenAI 兼容）：离线验证"lumin 动手 + 审批"。

用法：python server.py [port]
行为：
  1) 请求里还没有工具结果 → 回一个原生 tool_call：write({"path": <由提示词里的目标决定>, "content": ...})
     目标是"工作区内"还是"工作区外"由提示词里的路径决定（测试脚本会写清）。
  2) 请求里已有工具结果 → 回一段正文收尾。
"""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


def body_of(raw):
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return {}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(n)
        req = body_of(raw)
        msgs = req.get("messages") or []
        already = any((m.get("role") == "tool") for m in msgs)
        text_all = json.dumps(msgs, ensure_ascii=False)
        m = re.search(r"@@TARGET:([^@]+)@@", text_all)
        target = m.group(1).strip() if m else "notes.md"
        if already:
            chunks = [{"choices": [{"delta": {"content": "写好了"}}]},
                      {"choices": [{"delta": {}, "finish_reason": "stop"}]}]
        else:
            args = json.dumps({"path": target, "content": "这是 lumin 写进去的内容。"}, ensure_ascii=False)
            chunks = [
                {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                              "function": {"name": "write", "arguments": args[: len(args) // 2]}}]}}]},
                {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": args[len(args) // 2:]}}]}}]},
                {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
            ]
        body = ""
        for c in chunks:
            body += "data: " + json.dumps(c, ensure_ascii=False) + "\n\n"
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
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8197
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()