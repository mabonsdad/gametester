#!/usr/bin/env python3
"""Answer AI-seat turns by hand or from an agent such as Claude Code.

When a seat's controller is "Claude (chat bridge)", the browser posts the
seat's prompt to the server queue and waits. This script lets whoever is at
the terminal (you, or Claude in the chat window) read the prompt and post the
JSON answer back.

    python3 tools/ai_bridge.py list            # pending requests
    python3 tools/ai_bridge.py show [ID|next]  # print prompt for a request
    python3 tools/ai_bridge.py answer ID FILE  # answer from a file ('-' = stdin)
    python3 tools/ai_bridge.py cancel ID
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend import storage  # noqa: E402


def pick(arg):
    if arg in (None, "next"):
        pending = storage.queue_list("pending")
        if not pending:
            sys.exit("No pending AI requests.")
        return pending[0]
    return storage.queue_get(arg)


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return
    cmd, rest = argv[0], argv[1:]
    if cmd == "list":
        items = storage.queue_list("pending")
        if not items:
            print("No pending AI requests.")
        for i in items:
            m = i.get("meta", {})
            print(f"{i['id']}  {m.get('project', '?')}  turn {m.get('turn', '?')}  seat {m.get('player', '?')}")
    elif cmd == "show":
        item = pick(rest[0] if rest else None)
        p = item.get("prompt", {})
        print(f"# Request {item['id']}  status={item['status']}  meta={json.dumps(item.get('meta', {}))}\n")
        print("## SYSTEM\n" + p.get("system", "") + "\n")
        print("## USER\n" + p.get("user", ""))
    elif cmd == "answer":
        if len(rest) < 2:
            sys.exit("usage: answer ID FILE|-")
        text = sys.stdin.read() if rest[1] == "-" else Path(rest[1]).read_text(encoding="utf-8")
        item = pick(rest[0])
        storage.queue_answer(item["id"], text)
        print(f"Answered {item['id']}.")
    elif cmd == "cancel":
        storage.queue_cancel(pick(rest[0] if rest else None)["id"])
        print("Cancelled.")
    else:
        sys.exit(f"Unknown command {cmd!r}. Try --help.")


if __name__ == "__main__":
    main(sys.argv[1:])
