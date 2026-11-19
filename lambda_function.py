"""AWS Lambda entry point (handler: lambda_function.handler).

Receives requests from a Lambda Function URL (payload format 2.0), normally
via CloudFront at https://<site>/<BASE_PATH>/api/... and .../media/...
Also receives {"gametester_job": id} async self-invocations that run AI jobs.

Environment: GAMETESTER_S3_BUCKET, GAMETESTER_S3_PREFIX, BASE_PATH,
APP_PASSWORD, SESSION_SECRET, API_TOKEN, ORIGIN_SECRET, ANTHROPIC_API_KEY,
CLAUDE_MODEL, CLAUDE_EFFORT, OPENAI_API_KEY, OPENAI_MODEL (see deploy/aws/SETUP.md).
"""
import base64
import os
from urllib.parse import parse_qsl

from backend import app, jobs

TEXT_TYPES = ("application/json", "text/")


def handler(event, context):
    if isinstance(event, dict) and "gametester_job" in event:
        jobs.run(event["gametester_job"])
        return {"ok": True}

    http = event.get("requestContext", {}).get("http", {})
    path = event.get("rawPath") or http.get("path") or "/"
    base = (os.environ.get("BASE_PATH") or "").rstrip("/")
    if base and (path == base or path.startswith(base + "/")):
        path = path[len(base):] or "/"

    body = event.get("body") or ""
    body = base64.b64decode(body) if event.get("isBase64Encoded") else body.encode("utf-8")
    cookies = {}
    for c in event.get("cookies") or []:
        name, _, value = c.partition("=")
        cookies[name.strip()] = value.strip()

    req = app.Request(
        method=http.get("method", "GET").upper(),
        path=path,
        query=dict(parse_qsl(event.get("rawQueryString") or "")),
        headers={k.lower(): v for k, v in (event.get("headers") or {}).items()},
        cookies=cookies,
        body=body,
    )
    res = app.handle(req)
    ctype = res.headers.get("Content-Type", "")
    is_text = ctype.startswith(TEXT_TYPES)
    out = {
        "statusCode": res.status,
        "headers": res.headers,
        "body": res.body.decode("utf-8") if is_text else base64.b64encode(res.body).decode("ascii"),
        "isBase64Encoded": not is_text,
    }
    if res.cookies:
        out["cookies"] = res.cookies
    return out
