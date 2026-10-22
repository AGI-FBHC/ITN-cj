# -*- coding: utf-8 -*-
"""给 web_fetch 用的本地迷你网站（零依赖，只用标准库）。

为什么需要它：联网抓取必须能离线自测。这里刻意提供三个"坑"：
- /big.html   中文正文 > 8KB —— 用来验证响应体不是按 8KB 分片各自解码（那样中文会被切断）
- /redirect   302 到 /big.html —— 验证跳转
- /binary.bin 带 NUL 的二进制 —— 验证"读不了就如实说"，而不是塞一堆乱码进知识库
"""
import http.server
import socketserver
import sys

SENTINEL = "中文分片边界哨兵"
HEAD_SENTINEL = "中文开头哨兵"
FILL = "提示词工程的关键是任务、约束与输出格式写清楚，模型的表现才会稳定。" * 400


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, ctype, body: bytes, extra=None):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/big.html"):
            html = ("<!doctype html><html><head><title>提示词工程讲义</title></head><body>"
                    "<h1>提示词工程</h1><h2>基本概念</h2><p>" + HEAD_SENTINEL + FILL + "</p>"
                    "<h2>常见手法</h2><p>" + SENTINEL + "</p>"
                    "<script>var x = '这段脚本不该进正文';</script>"
                    "</body></html>")
            self._send("text/html; charset=utf-8", html.encode("utf-8"))
        elif self.path.startswith("/plain.txt"):
            self._send("text/plain; charset=utf-8", ("纯文本页面。" + SENTINEL).encode("utf-8"))
        elif self.path.startswith("/redirect"):
            self.send_response(302)
            self.send_header("Location", "/big.html")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif self.path.startswith("/binary.bin"):
            self._send("application/octet-stream", b"\x00\x01\x02PK\x03\x04" * 100)
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    with socketserver.TCPServer(("127.0.0.1", port), Handler) as httpd:
        print(httpd.server_address[1], flush=True)
        httpd.serve_forever()
