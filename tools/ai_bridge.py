#!/usr/bin/env python3
"""Answer AI-seat turns by hand or from an agent such as Claude Code.

When a seat's controller is "Claude in chat (bridge)", the browser creates a
bridge job and waits. This script reads the prompt and posts the JSON answer.

Local data (default, same machine as server.py):
    python3 tools/ai_bridge.py list
    python3 tools/ai_bridge.py show [ID|next]
    python3 tools/ai_bridge.py answer ID|next FILE      (FILE '-' = stdin)
    python3 tools/ai_bridge.py cancel ID|next

Hosted app (e.g. on AWS): add --url, or set GAMETESTER_URL, e.g.
    GAMETESTER_URL=https://example.com/experiments/gametester \\
    GAMETESTER_TOKEN=... python3 tools/ai_bridge.py list
GAMETESTER_TOKEN is the server's API_TOKEN; it can be left unset when a
proxy adds the Authorization header for you.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


class Local:
    def __init__(self):
        from backend import storage

        self.s = storage

    def pending(self):
        return self.s.job_list("pending", "bridge")

    def get(self, jid):
        return self.s.job_get(jid)

    def answer(self, jid, text):
        job = self.s.job_get(jid)
        if job.get("status") != "pending":
            sys.exit(f"Job {jid} is {job.get('status')}, not pending.")
        self.s.job_update(jid, status="answered", response=text)

    def cancel(self, jid):
        self.s.job_update(jid, status="cancelled")


class Remote:
    def __init__(self, url, token):
        self.base = url.rstrip("/")
        self.token = token

    def call(self, method, path, body=None):
        req = urllib.request.Request(
            self.base + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json", "User-Agent": "gametester-ai-bridge"},
        )
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            sys.exit(f"{method} {path} failed: {e.code} {e.read().decode(errors='replace')[:300]}")

    def pending(self):
        return self.call("GET", "/api/ai/jobs?status=pending&provider=bridge")

    def get(self, jid):
        return self.call("GET", f"/api/ai/jobs/{jid}?full=1")

    def answer(self, jid, text):
        self.call("POST", f"/api/ai/jobs/{jid}/answer", {"text": text})

    def cancel(self, jid):
        self.call("DELETE", f"/api/ai/jobs/{jid}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=os.environ.get("GAMETESTER_URL"), help="hosted app URL (default: local data)")
    ap.add_argument("command", choices=["list", "show", "answer", "cancel"])
    ap.add_argument("id", nargs="?", default="next")
    ap.add_argument("file", nargs="?")
    args = ap.parse_args()
    src = Remote(args.url, os.environ.get("GAMETESTER_TOKEN")) if args.url else Local()

    def pick(jid):
        if jid == "next":
            pending = src.pending()
            if not pending:
                sys.exit("No pending AI requests.")
            jid = pending[0]["id"]
        return jid

    if args.command == "list":
        items = src.pending()
        if not items:
            print("No pending AI requests.")
        for i in items:
            m = i.get("meta") or {}
            print(f"{i['id']}  {m.get('project', '?')}  turn {m.get('turn', '?')}  seat {m.get('player', '?')}")
    elif args.command == "show":
        job = src.get(pick(args.id))
        p = job.get("prompt") or {}
        print(f"# Request {job['id']}  status={job['status']}  meta={json.dumps(job.get('meta') or {})}\n")
        print("## SYSTEM\n" + p.get("system", "") + "\n")
        print("## USER\n" + p.get("user", ""))
    elif args.command == "answer":
        if not args.file:
            sys.exit("usage: answer ID|next FILE|-")
        text = sys.stdin.read() if args.file == "-" else Path(args.file).read_text(encoding="utf-8")
        jid = pick(args.id)
        src.answer(jid, text)
        print(f"Answered {jid}.")
    elif args.command == "cancel":
        jid = pick(args.id)
        src.cancel(jid)
        print(f"Cancelled {jid}.")


if __name__ == "__main__":
    main()
