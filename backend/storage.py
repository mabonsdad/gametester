"""File-based storage for projects, images, play sessions and the AI bridge queue.

Everything lives under DATA_DIR (default: ./data, override with GAMETESTER_DATA):

    data/
      projects/<project_id>/project.json
      projects/<project_id>/images/<file>
      projects/<project_id>/sessions/<session_id>.json
      ai_queue/<request_id>.json
"""
import base64
import json
import os
import re
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("GAMETESTER_DATA", ROOT / "data")).resolve()
PROJECTS = DATA_DIR / "projects"
QUEUE = DATA_DIR / "ai_queue"

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}


class StorageError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def check_id(value):
    if not isinstance(value, str) or not ID_RE.match(value):
        raise StorageError(f"Invalid id: {value!r}")
    return value


def _read(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


def new_id(prefix=""):
    return prefix + uuid.uuid4().hex[:12]


# ---------------------------------------------------------------- projects

def list_projects():
    out = []
    if not PROJECTS.exists():
        return out
    for d in PROJECTS.iterdir():
        f = d / "project.json"
        if not f.exists():
            continue
        try:
            p = _read(f)
        except (OSError, json.JSONDecodeError):
            continue
        out.append({
            "id": p.get("id", d.name),
            "name": p.get("name", d.name),
            "description": p.get("description", ""),
            "updated": p.get("updated"),
            "cardCount": len(p.get("cards", [])),
            "players": p.get("players"),
        })
    out.sort(key=lambda p: p.get("updated") or 0, reverse=True)
    return out


def get_project(pid):
    f = PROJECTS / check_id(pid) / "project.json"
    if not f.exists():
        raise StorageError("Project not found", 404)
    return _read(f)


def save_project(project):
    pid = check_id(project.get("id") or new_id("p_"))
    project["id"] = pid
    project["updated"] = int(time.time() * 1000)
    _write(PROJECTS / pid / "project.json", project)
    return project


def delete_project(pid):
    d = PROJECTS / check_id(pid)
    if not d.exists():
        raise StorageError("Project not found", 404)
    # Move aside rather than hard delete, so mistakes are recoverable.
    trash = DATA_DIR / "trash"
    trash.mkdir(parents=True, exist_ok=True)
    os.replace(d, trash / f"{pid}-{int(time.time())}")


def save_image(pid, data_url, name=""):
    check_id(pid)
    m = re.match(r"^data:(image/[a-z+]+);base64,(.*)$", data_url or "", re.S)
    if not m or m.group(1) not in IMAGE_TYPES:
        raise StorageError("Expected a PNG, JPEG, WebP or GIF data URL")
    raw = base64.b64decode(m.group(2))
    if len(raw) > 8 * 1024 * 1024:
        raise StorageError("Image too large (8MB max)")
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", Path(name).stem)[:40].strip("-") or "img"
    fname = f"{stem}-{uuid.uuid4().hex[:8]}{IMAGE_TYPES[m.group(1)]}"
    path = PROJECTS / pid / "images" / fname
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return f"media/{pid}/{fname}"


def image_path(pid, fname):
    check_id(pid)
    if not re.match(r"^[A-Za-z0-9_.-]{1,80}$", fname) or ".." in fname:
        raise StorageError("Bad image name", 404)
    path = PROJECTS / pid / "images" / fname
    if not path.exists():
        raise StorageError("Image not found", 404)
    return path


# ---------------------------------------------------------------- sessions

def list_sessions(pid):
    d = PROJECTS / check_id(pid) / "sessions"
    out = []
    if d.exists():
        for f in d.glob("*.json"):
            try:
                s = _read(f)
            except (OSError, json.JSONDecodeError):
                continue
            st = s.get("state", {})
            out.append({
                "id": s.get("id", f.stem),
                "name": s.get("name", f.stem),
                "updated": s.get("updated"),
                "turn": st.get("turn", {}).get("number"),
                "players": [p.get("name") for p in st.get("players", [])],
                "status": st.get("status"),
            })
    out.sort(key=lambda s: s.get("updated") or 0, reverse=True)
    return out


def get_session(pid, sid):
    f = PROJECTS / check_id(pid) / "sessions" / f"{check_id(sid)}.json"
    if not f.exists():
        raise StorageError("Session not found", 404)
    return _read(f)


def save_session(pid, session):
    sid = check_id(session.get("id") or new_id("s_"))
    session["id"] = sid
    session["updated"] = int(time.time() * 1000)
    _write(PROJECTS / check_id(pid) / "sessions" / f"{sid}.json", session)
    return {"id": sid, "updated": session["updated"]}


def delete_session(pid, sid):
    f = PROJECTS / check_id(pid) / "sessions" / f"{check_id(sid)}.json"
    if f.exists():
        f.unlink()


# ---------------------------------------------------------------- AI bridge queue
# The browser posts a prompt here when an AI seat set to "Claude (chat bridge)"
# needs to move. An agent (e.g. Claude Code in the chat window) answers it with
# tools/ai_bridge.py, and the browser polls until the answer appears.

def queue_create(prompt, meta=None):
    rid = new_id("ai_")
    item = {
        "id": rid,
        "created": int(time.time() * 1000),
        "status": "pending",
        "meta": meta or {},
        "prompt": prompt,
        "response": None,
    }
    _write(QUEUE / f"{rid}.json", item)
    return item


def queue_get(rid):
    f = QUEUE / f"{check_id(rid)}.json"
    if not f.exists():
        raise StorageError("Request not found", 404)
    return _read(f)


def queue_list(status=None):
    out = []
    if QUEUE.exists():
        for f in QUEUE.glob("*.json"):
            try:
                item = _read(f)
            except (OSError, json.JSONDecodeError):
                continue
            if status and item.get("status") != status:
                continue
            out.append(item)
    out.sort(key=lambda i: i.get("created") or 0)
    return out


def queue_answer(rid, text):
    item = queue_get(rid)
    item["status"] = "answered"
    item["response"] = text
    item["answered"] = int(time.time() * 1000)
    _write(QUEUE / f"{rid}.json", item)
    return item


def queue_cancel(rid):
    item = queue_get(rid)
    item["status"] = "cancelled"
    _write(QUEUE / f"{rid}.json", item)
    return item
