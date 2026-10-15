"""会调用工具的假模型（SSE 流式，OpenAI 兼容）：离线验证 lumin 的"动态步骤 + 工具 + 审批"。

用法：python server.py [port]
行为（看请求里有没有标记）：
  1) 提问里带 @@TARGET:<相对路径>@@ → 回一个原生 tool_call：write({path, content})；
  2) 其它提问 → 回一个原生 tool_call：kb_search({query})；
  3) 请求里已经有工具结果 → 回一段正文收尾（带 [1] 引用，方便验引用自检）。
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
        tool = "write" if m else "kb_search"
        if already:
            chunks = [{"choices": [{"delta": {"reasoning_content": "工具结果回来了：按资料里的说法收尾，并带上引用编号。"}}]},
                      {"choices": [{"delta": {"content": "资料里是这么说的 [1]。"}}]},
                      {"choices": [{"delta": {}, "finish_reason": "stop"}]}]
        else:
            if tool == "write":
                args = json.dumps({"path": m.group(1).strip(), "content": "这是 lumin 写进去的内容。"}, ensure_ascii=False)
            else:
                args = json.dumps({"query": "提示词", "top_k": 3}, ensure_ascii=False)
            half = len(args) // 2
            chunks = [
                {"choices": [{"delta": {"reasoning_content": "先想一下：用户问的是资料里的说法，应该先检索知识库。"}}]},
                {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                              "function": {"name": tool, "arguments": args[:half]}}]}}]},
                {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": args[half:]}}]}}]},
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