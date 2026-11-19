"""Access control for the hosted app.

Configured with environment variables (all optional; with none set, as for
local development, everything is open):

  APP_PASSWORD    shared password for the web app (signed-cookie login)
  SESSION_SECRET  key for signing login cookies (defaults to APP_PASSWORD)
  API_TOKEN       bearer token for scripts such as tools/ai_bridge.py
  ORIGIN_SECRET   if set, every request must carry the header
                  X-Origin-Verify with this value (CloudFront adds it), so the
                  Lambda URL cannot be used directly to bypass CloudFront.
"""
import hashlib
import hmac
import os
import time

COOKIE = "gt_auth"
COOKIE_DAYS = 30


def _env(name):
    return os.environ.get(name) or ""


def required():
    return bool(_env("APP_PASSWORD") or _env("API_TOKEN"))


def _sign(text):
    secret = (_env("SESSION_SECRET") or _env("APP_PASSWORD")).encode()
    return hmac.new(secret, text.encode(), hashlib.sha256).hexdigest()


def check_password(password):
    expected = _env("APP_PASSWORD")
    if not expected or not isinstance(password, str):
        return False
    return hmac.compare_digest(password.encode(), expected.encode())


def make_cookie(path="/"):
    exp = int(time.time()) + COOKIE_DAYS * 86400
    value = f"{exp}.{_sign(str(exp))}"
    return f"{COOKIE}={value}; Path={path}; Max-Age={COOKIE_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax"


def clear_cookie(path="/"):
    return f"{COOKIE}=; Path={path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax"


def _cookie_ok(value):
    if not value or "." not in value or not _env("APP_PASSWORD"):
        return False
    exp, sig = value.split(".", 1)
    if not exp.isdigit() or int(exp) < time.time():
        return False
    return hmac.compare_digest(sig, _sign(exp))


def is_authed(headers, cookies):
    if not required():
        return True
    token = _env("API_TOKEN")
    auth = headers.get("authorization", "")
    if token and auth.lower().startswith("bearer ") and hmac.compare_digest(auth[7:].strip().encode(), token.encode()):
        return True
    return _cookie_ok(cookies.get(COOKIE))


def origin_ok(headers):
    secret = _env("ORIGIN_SECRET")
    return not secret or hmac.compare_digest(headers.get("x-origin-verify", "").encode(), secret.encode())
