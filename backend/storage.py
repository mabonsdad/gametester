"""Projects, images, play sessions and AI jobs, stored as JSON blobs.

Key layout (in ./data locally, or in the S3 data bucket on AWS):

    projects/<project_id>/project.json
    projects/<project_id>/images/<file>
    projects/<project_id>/sessions/<session_id>.json
    jobs/<job_id>.json
    trash/<project_id>-<time>/...       (deleted projects, recoverable)
"""
import base64
import json
import re
import time
import uuid
from pathlib import PurePosixPath

from . import store as store_mod

store = store_mod.from_env()

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}
EXT_TYPES = {v: k for k, v in IMAGE_TYPES.items()}


class StorageError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def check_id(value):
    if not isinstance(value, str) or not ID_RE.match(value):
        raise StorageError(f"Invalid id: {value!r}")
    return value


def now_ms():
    return int(time.time() * 1000)


def new_id(prefix=""):
    return prefix + uuid.uuid4().hex[:12]


def _get(key):
    raw = store.get(key)
    if raw is None:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def _put(key, data):
    store.put(key, json.dumps(data, indent=1, ensure_ascii=False).encode("utf-8"), "application/json")


# ---------------------------------------------------------------- projects

def list_projects():
    out = []
    for key in store.list("projects/"):
        parts = key.split("/")
        if len(parts) != 3 or parts[2] != "project.json":
            continue
        p = _get(key)
        if not p:
            continue
        out.append({
            "id": p.get("id", parts[1]),
            "name": p.get("name", parts[1]),
            "description": p.get("description", ""),
            "updated": p.get("updated"),
            "cardCount": len(p.get("cards", [])),
            "players": p.get("players"),
        })
    out.sort(key=lambda p: p.get("updated") or 0, reverse=True)
    return out


def get_project(pid):
    p = _get(f"projects/{check_id(pid)}/project.json")
    if p is None:
        raise StorageError("Project not found", 404)
    return p


def save_project(project):
    pid = check_id(project.get("id") or new_id("p_"))
    project["id"] = pid
    project["updated"] = now_ms()
    _put(f"projects/{pid}/project.json", project)
    return project


def delete_project(pid):
    prefix = f"projects/{check_id(pid)}/"
    keys = store.list(prefix)
    if not keys:
        raise StorageError("Project not found", 404)
    trash = f"trash/{pid}-{int(time.time())}/"
    for key in keys:  # move aside rather than hard delete, so mistakes are recoverable
        store.put(trash + key[len(prefix):], store.get(key))
        store.delete(key)


def save_image(pid, data_url, name=""):
    check_id(pid)
    m = re.match(r"^data:(image/[a-z+]+);base64,(.*)$", data_url or "", re.S)
    if not m or m.group(1) not in IMAGE_TYPES:
        raise StorageError("Expected a PNG, JPEG, WebP or GIF data URL")
    raw = base64.b64decode(m.group(2))
    if len(raw) > 4 * 1024 * 1024:
        raise StorageError("Image too large (4MB max)")
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", PurePosixPath(name).stem)[:40].strip("-") or "img"
    fname = f"{stem}-{uuid.uuid4().hex[:8]}{IMAGE_TYPES[m.group(1)]}"
    store.put(f"projects/{pid}/images/{fname}", raw, m.group(1))
    return f"media/{pid}/{fname}"


def get_image(pid, fname):
    """Returns (bytes, content_type)."""
    check_id(pid)
    if not re.match(r"^[A-Za-z0-9_-]{1,60}\.(png|jpg|webp|gif)$", fname):
        raise StorageError("Image not found", 404)
    data = store.get(f"projects/{pid}/images/{fname}")
    if data is None:
        raise StorageError("Image not found", 404)
    return data, EXT_TYPES.get("." + fname.rsplit(".", 1)[1], "application/octet-stream")


# ---------------------------------------------------------------- sessions

def list_sessions(pid):
    out = []
    for key in store.list(f"projects/{check_id(pid)}/sessions/"):
        s = _get(key) if key.endswith(".json") else None
        if not s:
            continue
        st = s.get("state", {})
        out.append({
            "id": s.get("id", PurePosixPath(key).stem),
            "name": s.get("name", ""),
            "updated": s.get("updated"),
            "turn": st.get("turn", {}).get("number"),
            "players": [p.get("name") for p in st.get("players", [])],
            "status": st.get("status"),
        })
    out.sort(key=lambda s: s.get("updated") or 0, reverse=True)
    return out


def get_session(pid, sid):
    s = _get(f"projects/{check_id(pid)}/sessions/{check_id(sid)}.json")
    if s is None:
        raise StorageError("Session not found", 404)
    return s


def save_session(pid, session):
    sid = check_id(session.get("id") or new_id("s_"))
    session["id"] = sid
    session["updated"] = now_ms()
    _put(f"projects/{check_id(pid)}/sessions/{sid}.json", session)
    return {"id": sid, "updated": session["updated"]}


def delete_session(pid, sid):
    store.delete(f"projects/{check_id(pid)}/sessions/{check_id(sid)}.json")


# ---------------------------------------------------------------- AI jobs
# One job per AI turn. Hosted providers (anthropic/openai) are run by a
# background worker; "bridge" jobs wait for an agent such as Claude Code to
# answer them with tools/ai_bridge.py. The browser polls until the job is
# answered.

JOB_TTL_MS = 7 * 24 * 3600 * 1000


def job_create(provider, prompt, meta=None):
    jid = new_id("ai_")
    job = {
        "id": jid,
        "provider": provider,
        "created": now_ms(),
        "status": "pending",
        "meta": meta or {},
        "prompt": prompt,
        "response": None,
        "error": None,
    }
    _put(f"jobs/{jid}.json", job)
    return job


def job_get(jid):
    job = _get(f"jobs/{check_id(jid)}.json")
    if job is None:
        raise StorageError("Job not found", 404)
    return job


def job_update(jid, **fields):
    job = job_get(jid)
    job.update(fields)
    job["updated"] = now_ms()
    _put(f"jobs/{jid}.json", job)
    return job


def job_list(status=None, provider=None):
    out = []
    cutoff = now_ms() - JOB_TTL_MS
    for key in store.list("jobs/"):
        job = _get(key)
        if not job:
            continue
        if (job.get("created") or 0) < cutoff:
            store.delete(key)  # tidy up old jobs
            continue
        if status and job.get("status") != status:
            continue
        if provider and job.get("provider") != provider:
            continue
        out.append(job)
    out.sort(key=lambda j: j.get("created") or 0)
    return out
