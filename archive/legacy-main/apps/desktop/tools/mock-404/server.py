"""只回 404 + 一页 HTML 的假端点。

用途：验证"向量服务不提供 /embeddings"时的体验。旧版会把上游那页 HTML
原样拼进错误里，用户看到的是 `<html><center>openresty</center>`；
现在内核把它折成一句"服务返回的是网页，说明这个地址没有模型接口"。

用法：python server.py [port]
"""
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

BODY = (
    b"<html>\r\n<head><title>404 Not Found</title></head>\r\n"
    b"<body>\r\n<center><h1>404 Not Found</h1></center>\r\n"
    b"<hr><center>openresty</center>\r\n</body>\r\n</html>\r\n"
)


class Handler(BaseHTTPRequestHandler):
    def _reply(self):
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

    do_GET = _reply
    do_POST = _reply

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8199
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
