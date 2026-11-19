#!/usr/bin/env python3
"""Card Game Test Bench - web server.

Serves the static front end from ./static and a small JSON API under /api.
Standard library only (the optional `anthropic` package enables the Claude API
seat provider).

    python3 server.py                 # http://localhost:8000
    python3 server.py --port 8080 --host 0.0.0.0

The front end also works from any plain static host (without this server);
it then stores projects in the browser and offers only the offline AI modes.
"""
import argparse
import json
import mimetypes
import re
import sys
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from backend import ai, storage  # noqa: E402

STATIC = ROOT / "static"
MAX_BODY = 25 * 1024 * 1024
VERSION = "0.1.0"


class Handler(SimpleHTTPRequestHandler):
    server_version = "CardGameTestBench/" + VERSION

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def log_message(self, fmt, *args):
        if "/api/ai/bridge/" in (self.path or "") and " 200 " in (fmt % args):
            return  # polling noise
        super().log_message(fmt, *args)

    # ------------------------------------------------------------ helpers
    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise storage.StorageError("Request body too large", 413)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            raise storage.StorageError("Body is not valid JSON")

    def end_headers(self):
        # Static files: avoid stale JS during development.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # ------------------------------------------------------------ routing
    ROUTES = [
        ("GET", r"/api/health$", "health"),
        ("GET", r"/api/projects$", "projects_list"),
        ("POST", r"/api/projects$", "project_save"),
        ("GET", r"/api/projects/([\w-]+)$", "project_get"),
        ("PUT", r"/api/projects/([\w-]+)$", "project_save"),
        ("DELETE", r"/api/projects/([\w-]+)$", "project_delete"),
        ("POST", r"/api/projects/([\w-]+)/images$", "image_upload"),
        ("GET", r"/api/projects/([\w-]+)/sessions$", "sessions_list"),
        ("POST", r"/api/projects/([\w-]+)/sessions$", "session_save"),
        ("GET", r"/api/projects/([\w-]+)/sessions/([\w-]+)$", "session_get"),
        ("PUT", r"/api/projects/([\w-]+)/sessions/([\w-]+)$", "session_save"),
        ("DELETE", r"/api/projects/([\w-]+)/sessions/([\w-]+)$", "session_delete"),
        ("POST", r"/api/ai/complete$", "ai_complete"),
        ("GET", r"/api/ai/bridge$", "bridge_list"),
        ("POST", r"/api/ai/bridge$", "bridge_create"),
        ("GET", r"/api/ai/bridge/([\w-]+)$", "bridge_get"),
        ("DELETE", r"/api/ai/bridge/([\w-]+)$", "bridge_cancel"),
    ]

    def route(self, method):
        path = urlparse(self.path).path
        if path.startswith("/media/"):
            if method != "GET":
                return self.send_json({"error": "Method not allowed"}, 405)
            return self.serve_media(path)
        if not path.startswith("/api/"):
            if method in ("GET", "HEAD"):
                return super().do_GET() if method == "GET" else super().do_HEAD()
            return self.send_json({"error": "Method not allowed"}, 405)
        for m, pattern, name in self.ROUTES:
            if m != method:
                continue
            match = re.match(pattern, path)
            if match:
                try:
                    return getattr(self, "api_" + name)(*match.groups())
                except (storage.StorageError, ai.AIError) as e:
                    return self.send_json({"error": str(e)}, e.status)
                except Exception as e:  # keep the server alive
                    self.log_error("Unhandled error: %r", e)
                    return self.send_json({"error": f"Server error: {e}"}, 500)
        return self.send_json({"error": "Not found"}, 404)

    def do_GET(self):
        self.route("GET")

    def do_HEAD(self):
        self.route("HEAD")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def serve_media(self, path):
        parts = path.split("/")
        if len(parts) != 4:
            return self.send_json({"error": "Not found"}, 404)
        try:
            f = storage.image_path(parts[2], parts[3])
        except storage.StorageError as e:
            return self.send_json({"error": str(e)}, e.status)
        data = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(f.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    # ------------------------------------------------------------ API
    def api_health(self):
        self.send_json({"ok": True, "version": VERSION, "ai": ai.status()})

    def api_projects_list(self):
        self.send_json(storage.list_projects())

    def api_project_get(self, pid):
        self.send_json(storage.get_project(pid))

    def api_project_save(self, pid=None):
        project = self.read_json()
        if pid:
            project["id"] = pid
        self.send_json(storage.save_project(project))

    def api_project_delete(self, pid):
        storage.delete_project(pid)
        self.send_json({"ok": True})

    def api_image_upload(self, pid):
        body = self.read_json()
        self.send_json({"url": storage.save_image(pid, body.get("dataUrl"), body.get("name", ""))})

    def api_sessions_list(self, pid):
        self.send_json(storage.list_sessions(pid))

    def api_session_get(self, pid, sid):
        self.send_json(storage.get_session(pid, sid))

    def api_session_save(self, pid, sid=None):
        session = self.read_json()
        if sid:
            session["id"] = sid
        self.send_json(storage.save_session(pid, session))

    def api_session_delete(self, pid, sid):
        storage.delete_session(pid, sid)
        self.send_json({"ok": True})

    def api_ai_complete(self):
        body = self.read_json()
        self.send_json(ai.complete(body.get("provider"), body.get("system", ""), body.get("user", ""), body.get("options")))

    def api_bridge_list(self):
        items = storage.queue_list("pending")
        self.send_json([{k: i[k] for k in ("id", "created", "meta")} for i in items])

    def api_bridge_create(self):
        body = self.read_json()
        item = storage.queue_create(body.get("prompt") or {}, body.get("meta") or {})
        self.send_json({"id": item["id"], "status": item["status"]})

    def api_bridge_get(self, rid):
        item = storage.queue_get(rid)
        self.send_json({"id": item["id"], "status": item["status"], "response": item.get("response")})

    def api_bridge_cancel(self, rid):
        storage.queue_cancel(rid)
        self.send_json({"ok": True})


def main():
    ap = argparse.ArgumentParser(description="Card Game Test Bench server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    mimetypes.add_type("text/javascript", ".js")
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Card Game Test Bench on http://{args.host}:{args.port}  (data: {storage.DATA_DIR})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
