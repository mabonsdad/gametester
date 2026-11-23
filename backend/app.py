"""The JSON API, independent of how it is hosted.

server.py (local / any server) and lambda_function.py (AWS Lambda) both turn
their requests into a Request, call handle(), and send back the Response.
Paths here are relative to the app root: '/api/...' and '/media/...'.
"""
import json
import os
import re
import time
from dataclasses import dataclass, field

from . import ai, auth, jobs, storage

VERSION = "0.2.0"
MAX_BODY = 8 * 1024 * 1024


@dataclass
class Request:
    method: str
    path: str
    query: dict = field(default_factory=dict)
    headers: dict = field(default_factory=dict)  # lower-case names
    cookies: dict = field(default_factory=dict)
    body: bytes = b""

    def json(self):
        if len(self.body) > MAX_BODY:
            raise storage.StorageError("Request body too large", 413)
        if not self.body:
            return {}
        try:
            return json.loads(self.body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise storage.StorageError("Body is not valid JSON")


@dataclass
class Response:
    status: int = 200
    headers: dict = field(default_factory=dict)
    body: bytes = b""
    cookies: list = field(default_factory=list)  # full Set-Cookie values


def json_response(data, status=200, cookies=None):
    return Response(
        status=status,
        headers={"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"},
        body=json.dumps(data, ensure_ascii=False).encode("utf-8"),
        cookies=cookies or [],
    )


def cookie_path():
    return (os.environ.get("BASE_PATH") or "").rstrip("/") + "/"


# ------------------------------------------------------------------ handlers

def health(req):
    authed = auth.is_authed(req.headers, req.cookies)
    data = {"ok": True, "version": VERSION, "storage": storage.store.kind,
            "authRequired": auth.required(), "authed": authed}
    if authed:
        data["ai"] = ai.status()
    return json_response(data)


def login(req):
    if not auth.required():
        return json_response({"ok": True})
    if not auth.check_password(req.json().get("password")):
        time.sleep(1)  # slow down guessing
        return json_response({"error": "Wrong password"}, 401)
    return json_response({"ok": True}, cookies=[auth.make_cookie(cookie_path())])


def logout(req):
    return json_response({"ok": True}, cookies=[auth.clear_cookie(cookie_path())])


def projects_list(req):
    return json_response(storage.list_projects())


def project_get(req, pid):
    return json_response(storage.get_project(pid))


def project_save(req, pid=None):
    project = req.json()
    if pid:
        project["id"] = pid
    return json_response(storage.save_project(project))


def project_delete(req, pid):
    storage.delete_project(pid)
    return json_response({"ok": True})


def image_upload(req, pid):
    body = req.json()
    return json_response({"url": storage.save_image(pid, body.get("dataUrl"), body.get("name", ""))})


def media_get(req, pid, fname):
    data, ctype = storage.get_image(pid, fname)
    return Response(200, {"Content-Type": ctype, "Cache-Control": "private, max-age=86400"}, data)


def sessions_list(req, pid):
    return json_response(storage.list_sessions(pid))


def session_get(req, pid, sid):
    return json_response(storage.get_session(pid, sid))


def session_save(req, pid, sid=None):
    session = req.json()
    if sid:
        session["id"] = sid
    return json_response(storage.save_session(pid, session))


def session_delete(req, pid, sid):
    storage.delete_session(pid, sid)
    return json_response({"ok": True})


def job_summary(job, full=False):
    if full:
        return job
    return {k: job.get(k) for k in ("id", "provider", "status", "created", "meta", "response", "error", "model")}


def jobs_create(req):
    body = req.json()
    provider = body.get("provider")
    if provider not in jobs.HOSTED_PROVIDERS | {"bridge"}:
        raise storage.StorageError(f"Unknown AI provider {provider!r}")
    prompt = body.get("prompt") or {}
    if not isinstance(prompt, dict) or not prompt.get("user"):
        raise storage.StorageError("Missing prompt")
    job = storage.job_create(provider, prompt, body.get("meta"))
    if provider in jobs.HOSTED_PROVIDERS:
        jobs.start(job["id"])
    return json_response(job_summary(job))


def jobs_list(req):
    items = storage.job_list(req.query.get("status"), req.query.get("provider"))
    return json_response([job_summary(j) for j in items])


def job_get(req, jid):
    return json_response(job_summary(storage.job_get(jid), full=req.query.get("full") == "1"))


def job_answer(req, jid):
    text = req.json().get("text")
    if not isinstance(text, str) or not text.strip():
        raise storage.StorageError("Missing answer text")
    job = storage.job_get(jid)
    if job.get("status") != "pending":
        raise storage.StorageError(f"Job is {job.get('status')}, not pending", 409)
    return json_response(job_summary(storage.job_update(jid, status="answered", response=text)))


def job_cancel(req, jid):
    storage.job_update(jid, status="cancelled")
    return json_response({"ok": True})


# ------------------------------------------------------------------ share links (tester side)

def shares_list(req, pid):
    return json_response(storage.share_list(pid))


def share_create(req, pid):
    body = req.json()
    return json_response(storage.share_create(pid, body.get("label"), body.get("providers"), body.get("dailyLimit", 300)))


def share_revoke(req, pid, token):
    return json_response(storage.share_revoke(pid, token))


# ------------------------------------------------------------------ player view via a share link (no login)

def _share_providers(rec):
    st = ai.status()
    ok = {"random": True, "anthropic": st["anthropic"]["sdkInstalled"] and st["anthropic"]["keySet"], "openai": st["openai"]["keySet"] and bool(st["openai"]["model"])}
    return [p for p in rec.get("providers", ["random"]) if ok.get(p)]


def play_project(req, token):
    rec = storage.share_get(token)
    project = storage.get_project(rec["projectId"])
    return json_response({"project": project, "share": {"label": rec.get("label"), "providers": _share_providers(rec)}})


def play_session_save(req, token, sid):
    rec = storage.share_get(token)
    if not sid.startswith("v_"):
        raise storage.StorageError("Bad session id")
    session = req.json()
    try:
        existing = storage.get_session(rec["projectId"], sid)
    except storage.StorageError:
        existing = None
        storage.share_count_play(rec)
    if existing and (existing.get("source") or {}).get("token") != token:
        raise storage.StorageError("Not your session", 403)
    session["id"] = sid
    session["source"] = {**(session.get("source") or {}), "kind": "share", "token": token, "via": rec.get("label")}
    return json_response(storage.save_session(rec["projectId"], session))


def play_job_create(req, token):
    rec = storage.share_get(token)
    body = req.json()
    provider = body.get("provider")
    if provider not in jobs.HOSTED_PROVIDERS or provider not in _share_providers(rec):
        raise storage.StorageError("That AI is not available for this link.", 403)
    prompt = body.get("prompt") or {}
    if not isinstance(prompt, dict) or not prompt.get("user"):
        raise storage.StorageError("Missing prompt")
    storage.share_count_ai_turn(rec)
    job = storage.job_create(provider, prompt, {**(body.get("meta") or {}), "share": token})
    jobs.start(job["id"])
    return json_response(job_summary(job))


def _share_job(token, jid):
    storage.share_get(token)
    job = storage.job_get(jid)
    if (job.get("meta") or {}).get("share") != token:
        raise storage.StorageError("Job not found", 404)
    return job


def play_job_get(req, token, jid):
    return json_response(job_summary(_share_job(token, jid)))


def play_job_cancel(req, token, jid):
    _share_job(token, jid)
    storage.job_update(jid, status="cancelled")
    return json_response({"ok": True})


def play_media(req, token, fname):
    rec = storage.share_get(token)
    data, ctype = storage.get_image(rec["projectId"], fname)
    return Response(200, {"Content-Type": ctype, "Cache-Control": "private, max-age=86400"}, data)


ID = r"([\w-]+)"
ROUTES = [
    ("GET", r"/api/health", health, False),
    ("POST", r"/api/login", login, False),
    ("POST", r"/api/logout", logout, False),
    ("GET", r"/api/projects", projects_list, True),
    ("POST", r"/api/projects", project_save, True),
    ("GET", rf"/api/projects/{ID}", project_get, True),
    ("PUT", rf"/api/projects/{ID}", project_save, True),
    ("DELETE", rf"/api/projects/{ID}", project_delete, True),
    ("POST", rf"/api/projects/{ID}/images", image_upload, True),
    ("GET", rf"/api/projects/{ID}/sessions", sessions_list, True),
    ("POST", rf"/api/projects/{ID}/sessions", session_save, True),
    ("GET", rf"/api/projects/{ID}/sessions/{ID}", session_get, True),
    ("PUT", rf"/api/projects/{ID}/sessions/{ID}", session_save, True),
    ("DELETE", rf"/api/projects/{ID}/sessions/{ID}", session_delete, True),
    ("GET", r"/api/ai/jobs", jobs_list, True),
    ("POST", r"/api/ai/jobs", jobs_create, True),
    ("GET", rf"/api/ai/jobs/{ID}", job_get, True),
    ("POST", rf"/api/ai/jobs/{ID}/answer", job_answer, True),
    ("DELETE", rf"/api/ai/jobs/{ID}", job_cancel, True),
    ("GET", rf"/media/{ID}/([\w.-]+)", media_get, True),
    ("GET", rf"/api/projects/{ID}/shares", shares_list, True),
    ("POST", rf"/api/projects/{ID}/shares", share_create, True),
    ("DELETE", rf"/api/projects/{ID}/shares/{ID}", share_revoke, True),
    # Share links: no login, the token is checked by each handler.
    ("GET", rf"/api/play/{ID}", play_project, False),
    ("PUT", rf"/api/play/{ID}/sessions/{ID}", play_session_save, False),
    ("POST", rf"/api/play/{ID}/ai/jobs", play_job_create, False),
    ("GET", rf"/api/play/{ID}/ai/jobs/{ID}", play_job_get, False),
    ("DELETE", rf"/api/play/{ID}/ai/jobs/{ID}", play_job_cancel, False),
    ("GET", rf"/api/play/{ID}/media/([\w.-]+)", play_media, False),
]


def handle(req):
    if not auth.origin_ok(req.headers):
        return json_response({"error": "Forbidden"}, 403)
    path_known = False
    for method, pattern, fn, needs_auth in ROUTES:
        m = re.fullmatch(pattern, req.path)
        if not m:
            continue
        path_known = True
        if method != req.method:
            continue
        if needs_auth and not auth.is_authed(req.headers, req.cookies):
            return json_response({"error": "Login required"}, 401)
        try:
            return fn(req, *m.groups())
        except (storage.StorageError, ai.AIError) as e:
            return json_response({"error": str(e)}, e.status)
        except Exception as e:  # keep serving; report the problem
            print(f"Unhandled error on {req.method} {req.path}: {e!r}")
            return json_response({"error": f"Server error: {type(e).__name__}"}, 500)
    return json_response({"error": "Method not allowed" if path_known else "Not found"}, 405 if path_known else 404)
