#!/usr/bin/env python3
"""Card Game Test Bench - local / self-hosted web server.

Serves the front end from ./static and the JSON API (backend/app.py).
Standard library only; the optional `anthropic` package enables Claude API seats.

    python3 server.py                 # http://localhost:8000
    python3 server.py --port 8080 --host 0.0.0.0

For AWS (S3 + Lambda) see deploy/aws/SETUP.md. The front end also works from
any plain static host without this server (browser storage, offline AI only).
"""
import argparse
import mimetypes
import sys
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlparse

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from backend import app, storage  # noqa: E402

STATIC = ROOT / "static"


class Handler(SimpleHTTPRequestHandler):
    server_version = "CardGameTestBench/" + app.VERSION

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def log_message(self, fmt, *args):
        if "/api/ai/jobs/" in (self.path or "") and " 200 " in (fmt % args):
            return  # polling noise
        super().log_message(fmt, *args)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")  # avoid stale JS in development
        super().end_headers()

    def dispatch(self, method):
        url = urlparse(self.path)
        if not (url.path.startswith("/api/") or url.path.startswith("/media/")):
            if method == "GET":
                return super().do_GET()
            if method == "HEAD":
                return super().do_HEAD()
            return self.send_error(405)
        length = int(self.headers.get("Content-Length") or 0)
        if length > app.MAX_BODY:
            return self.send_error(413)
        jar = SimpleCookie(self.headers.get("Cookie") or "")
        req = app.Request(
            method=method,
            path=url.path,
            query=dict(parse_qsl(url.query)),
            headers={k.lower(): v for k, v in self.headers.items()},
            cookies={k: m.value for k, m in jar.items()},
            body=self.rfile.read(length) if length else b"",
        )
        res = app.handle(req)
        self.send_response(res.status)
        for k, v in res.headers.items():
            self.send_header(k, v)
        for c in res.cookies:
            self.send_header("Set-Cookie", c)
        self.send_header("Content-Length", str(len(res.body)))
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(res.body)

    def do_GET(self):
        self.dispatch("GET")

    def do_HEAD(self):
        self.dispatch("HEAD")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")


def main():
    ap = argparse.ArgumentParser(description="Card Game Test Bench server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    mimetypes.add_type("text/javascript", ".js")
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Card Game Test Bench on http://{args.host}:{args.port}  (data: {storage.store.describe()})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
