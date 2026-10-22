"""Serve the downloaded deployment with the original Nginx SPA routes."""

import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


DEPLOYED = Path(__file__).resolve().parent / "deployed"


class PreviewHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DEPLOYED), **kwargs)

    def _route(self):
        path = urlsplit(self.path).path
        target = Path(self.translate_path(self.path))
        if path in ("/courses", "/courses/"):
            self.path = "/index.html"
        elif not target.is_file() and not path.startswith("/assets/"):
            self.path = "/index.html"

    def do_GET(self):
        self._route()
        super().do_GET()

    def do_HEAD(self):
        self._route()
        super().do_HEAD()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3005)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), PreviewHandler)
    print(f"Preview: http://localhost:{args.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
