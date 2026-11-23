"""Backend tests: run the API through the Lambda entry point with file storage.

    python3 -m unittest discover -s tests -v

If `moto` is installed, the S3 storage backend is tested too.
"""
import base64
import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

ENV = {
    "BASE_PATH": "/experiments/gametester",
    "APP_PASSWORD": "correct horse",
    "SESSION_SECRET": "s" * 40,
    "API_TOKEN": "t" * 40,
    "ORIGIN_SECRET": "o" * 40,
}


def load_modules():
    """(Re)import the backend so it picks up the current environment."""
    import backend.store
    import backend.storage
    import backend.app
    import lambda_function

    for m in (backend.store, backend.storage, backend.app, lambda_function):
        importlib.reload(m)
    return lambda_function


def event(method, path, body=None, headers=None, cookies=None, query=""):
    h = {"x-origin-verify": ENV["ORIGIN_SECRET"], "content-type": "application/json"}
    h.update(headers or {})
    return {
        "rawPath": ENV["BASE_PATH"] + path,
        "rawQueryString": query,
        "headers": h,
        "cookies": cookies or [],
        "requestContext": {"http": {"method": method, "path": ENV["BASE_PATH"] + path}},
        "body": json.dumps(body) if body is not None else None,
        "isBase64Encoded": False,
    }


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_env = dict(os.environ)
        os.environ.pop("GAMETESTER_S3_BUCKET", None)
        os.environ.pop("AWS_LAMBDA_FUNCTION_NAME", None)
        os.environ.update(ENV, GAMETESTER_DATA=self.tmp.name)
        self.lf = load_modules()
        self.cookie = None

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old_env)
        self.tmp.cleanup()

    def call(self, method, path, body=None, auth=True, **kw):
        cookies = [self.cookie] if (auth and self.cookie) else []
        res = self.lf.handler(event(method, path, body, cookies=cookies, **kw), None)
        data = res["body"]
        if not res["isBase64Encoded"]:
            data = json.loads(data) if data else None
        return res["statusCode"], data, res

    def login(self):
        status, _, res = self.call("POST", "/api/login", {"password": ENV["APP_PASSWORD"]})
        self.assertEqual(status, 200)
        self.cookie = res["cookies"][0].split(";")[0]

    def test_origin_secret_required(self):
        res = self.lf.handler(event("GET", "/api/health", headers={"x-origin-verify": "nope"}), None)
        self.assertEqual(res["statusCode"], 403)

    def test_login_flow(self):
        status, data, _ = self.call("GET", "/api/health")
        self.assertEqual((status, data["authRequired"], data["authed"]), (200, True, False))
        self.assertEqual(self.call("GET", "/api/projects")[0], 401)
        self.assertEqual(self.call("POST", "/api/login", {"password": "wrong"})[0], 401)
        self.login()
        self.assertIn("Path=/experiments/gametester/", self.lf.app.auth.make_cookie("/experiments/gametester/"))
        status, data, _ = self.call("GET", "/api/health")
        self.assertTrue(data["authed"])
        self.assertEqual(self.call("GET", "/api/projects")[:2], (200, []))

    def test_bearer_token(self):
        status, data, _ = self.call("GET", "/api/projects", headers={"authorization": "Bearer " + ENV["API_TOKEN"]})
        self.assertEqual(status, 200)

    def test_projects_sessions_images(self):
        self.login()
        status, p, _ = self.call("POST", "/api/projects", {"name": "Test game", "cards": [{"id": "k1"}]})
        self.assertEqual(status, 200)
        pid = p["id"]
        self.assertEqual(self.call("GET", "/api/projects")[1][0]["cardCount"], 1)
        self.assertEqual(self.call("GET", f"/api/projects/{pid}")[1]["name"], "Test game")
        # session
        status, s, _ = self.call("PUT", f"/api/projects/{pid}/sessions/s_1", {"name": "S", "state": {"turn": {"number": 3}}})
        self.assertEqual(status, 200)
        self.assertEqual(self.call("GET", f"/api/projects/{pid}/sessions")[1][0]["turn"], 3)
        # image round trip (1x1 PNG)
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC")
        status, img, _ = self.call("POST", f"/api/projects/{pid}/images",
                                   {"dataUrl": "data:image/png;base64," + base64.b64encode(png).decode(), "name": "a.png"})
        self.assertEqual(status, 200)
        status, body, res = self.call("GET", "/" + img["url"])
        self.assertEqual(status, 200)
        self.assertEqual(base64.b64decode(body), png)
        self.assertEqual(res["headers"]["Content-Type"], "image/png")
        # media needs login too
        self.assertEqual(self.call("GET", "/" + img["url"], auth=False)[0], 401)
        # bad ids / traversal
        self.assertEqual(self.call("GET", "/api/projects/..%2Fx")[0], 404)
        self.assertEqual(self.call("GET", f"/media/{pid}/..%2Fproject.json")[0], 404)
        # delete moves to trash
        self.assertEqual(self.call("DELETE", f"/api/projects/{pid}")[0], 200)
        self.assertEqual(self.call("GET", f"/api/projects/{pid}")[0], 404)

    def test_bridge_job(self):
        self.login()
        status, job, _ = self.call("POST", "/api/ai/jobs", {"provider": "bridge", "prompt": {"system": "s", "user": "u"}})
        self.assertEqual((status, job["status"]), (200, "pending"))
        status, items, _ = self.call("GET", "/api/ai/jobs", query="status=pending&provider=bridge")
        self.assertEqual([i["id"] for i in items], [job["id"]])
        status, full, _ = self.call("GET", f"/api/ai/jobs/{job['id']}", query="full=1")
        self.assertEqual(full["prompt"]["user"], "u")
        self.assertEqual(self.call("POST", f"/api/ai/jobs/{job['id']}/answer", {"text": "{}"})[0], 200)
        self.assertEqual(self.call("GET", f"/api/ai/jobs/{job['id']}")[1]["status"], "answered")
        self.assertEqual(self.call("POST", f"/api/ai/jobs/{job['id']}/answer", {"text": "{}"})[0], 409)

    def test_hosted_job_runs_async_and_reports_errors(self):
        self.login()
        os.environ["ANTHROPIC_API_KEY"] = ""
        calls = []
        original = self.lf.jobs.start
        self.addCleanup(setattr, self.lf.jobs, "start", original)
        self.lf.jobs.start = lambda jid: calls.append(jid)  # don't spawn; run inline below
        status, job, _ = self.call("POST", "/api/ai/jobs", {"provider": "anthropic", "prompt": {"system": "s", "user": "u"}})
        self.assertEqual(calls, [job["id"]])
        self.lf.handler({"gametester_job": job["id"]}, None)  # what the async self-invocation does
        status, j, _ = self.call("GET", f"/api/ai/jobs/{job['id']}")
        self.assertEqual(j["status"], "error")  # no SDK/key in the test environment
        self.assertTrue(j["error"])

    def test_share_links(self):
        self.login()
        _, p, _ = self.call("POST", "/api/projects", {"name": "Shared game", "cards": []})
        pid = p["id"]
        png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
        _, img, _ = self.call("POST", f"/api/projects/{pid}/images", {"dataUrl": "data:image/png;base64," + png, "name": "a.png"})
        status, share, _ = self.call("POST", f"/api/projects/{pid}/shares", {"label": "Friends", "providers": ["random", "anthropic"], "dailyLimit": 1})
        self.assertEqual(status, 200)
        tok = share["token"]
        self.assertEqual(self.call("GET", f"/api/projects/{pid}/shares")[1][0]["token"], tok)
        # Creating links needs the tester login
        self.assertEqual(self.call("POST", f"/api/projects/{pid}/shares", {}, auth=False)[0], 401)
        # The link works without logging in, for that project only
        status, data, _ = self.call("GET", f"/api/play/{tok}", auth=False)
        self.assertEqual((status, data["project"]["id"], data["share"]["label"]), (200, pid, "Friends"))
        self.assertEqual(data["share"]["providers"], ["random"], "Claude is not configured in tests, so only quick bots")
        self.assertEqual(self.call("GET", "/api/projects", auth=False)[0], 401)
        self.assertEqual(self.call("GET", "/api/play/not-a-real-token-123", auth=False)[0], 404)
        # Images through the link
        fname = img["url"].split("/")[-1]
        self.assertEqual(self.call("GET", f"/api/play/{tok}/media/{fname}", auth=False)[0], 200)
        # Sessions: saved with the link as their source; ids must start v_; another link cannot overwrite
        status, saved, _ = self.call("PUT", f"/api/play/{tok}/sessions/v_one", {"name": "P", "state": {}}, auth=False)
        self.assertEqual(status, 200)
        self.assertEqual(self.call("PUT", f"/api/play/{tok}/sessions/s_x", {"state": {}}, auth=False)[0], 400)
        got = self.call("GET", f"/api/projects/{pid}/sessions/v_one")[1]
        self.assertEqual((got["source"]["kind"], got["source"]["via"]), ("share", "Friends"))
        _, other, _ = self.call("POST", f"/api/projects/{pid}/shares", {"label": "Other"})
        self.assertEqual(self.call("PUT", f"/api/play/{other['token']}/sessions/v_one", {"state": {}}, auth=False)[0], 403)
        # AI jobs: only providers allowed and configured for the link
        self.assertEqual(self.call("POST", f"/api/play/{tok}/ai/jobs", {"provider": "anthropic", "prompt": {"user": "u"}}, auth=False)[0], 403)
        # Revoking stops the link
        self.assertEqual(self.call("DELETE", f"/api/projects/{pid}/shares/{tok}")[0], 200)
        self.assertEqual(self.call("GET", f"/api/play/{tok}", auth=False)[0], 404)

    def test_share_ai_turn_limit(self):
        self.login()
        _, p, _ = self.call("POST", "/api/projects", {"name": "G", "cards": []})
        storage = self.lf.app.storage
        rec = storage.share_create(p["id"], "Cap", ["random"], daily_limit=2)
        storage.share_count_ai_turn(rec)
        storage.share_count_ai_turn(rec)
        with self.assertRaises(storage.StorageError) as cm:
            storage.share_count_ai_turn(rec)
        self.assertEqual(cm.exception.status, 429)

    def test_unknown_routes(self):
        self.assertEqual(self.call("GET", "/api/nope")[0], 404)
        self.assertEqual(self.call("PATCH", "/api/projects")[0], 405)


try:
    import moto  # noqa: F401
    HAVE_MOTO = True
except ImportError:
    HAVE_MOTO = False


class ClaudeRequestTests(unittest.TestCase):
    """The shape of the Claude request, with a stand-in for the anthropic SDK."""

    def fake_sdk(self, reject_format=False):
        import types
        calls = []

        class BadRequestError(Exception):
            pass

        class Block:
            type = "text"
            text = '{"reasoning":"","actions":[],"winConfidence":1,"experience":"","designerNotes":""}'

        class Resp:
            stop_reason = "end_turn"
            content = [Block()]
            model = "m"

        def create(**kw):
            calls.append(kw)
            if reject_format and "format" in kw.get("output_config", {}):
                raise BadRequestError("schema not supported")
            return Resp()

        msgs = types.SimpleNamespace(create=create)
        client = types.SimpleNamespace(messages=msgs, beta=types.SimpleNamespace(messages=msgs))
        mod = types.ModuleType("anthropic")
        mod.Anthropic = lambda: client
        mod.BadRequestError = BadRequestError
        for name in ("AuthenticationError", "RateLimitError", "APIStatusError", "APIConnectionError"):
            setattr(mod, name, type(name, (Exception,), {}))
        return mod, calls

    def run_with(self, mod, options):
        from backend import ai
        saved = sys.modules.get("anthropic")
        sys.modules["anthropic"] = mod
        try:
            return ai.complete("anthropic", "sys", "user", options)
        finally:
            if saved is None:
                sys.modules.pop("anthropic", None)
            else:
                sys.modules["anthropic"] = saved

    def test_turn_format_requested(self):
        mod, calls = self.fake_sdk()
        self.run_with(mod, {"format": "turn"})
        fmt = calls[0]["output_config"]["format"]
        self.assertEqual(fmt["type"], "json_schema")
        self.assertIn("actions", fmt["schema"]["properties"])
        self.run_with(mod, {})
        self.assertNotIn("format", calls[1]["output_config"])

    def test_schema_rejected_falls_back(self):
        mod, calls = self.fake_sdk(reject_format=True)
        res = self.run_with(mod, {"format": "turn"})
        self.assertEqual(len(calls), 2)
        self.assertNotIn("format", calls[1]["output_config"])
        self.assertIn("actions", res["text"])


@unittest.skipUnless(HAVE_MOTO, "moto not installed")
class S3StoreTests(unittest.TestCase):
    def test_s3_store(self):
        import boto3
        from moto import mock_aws

        with mock_aws():
            os.environ.update(AWS_DEFAULT_REGION="eu-west-2", AWS_ACCESS_KEY_ID="x", AWS_SECRET_ACCESS_KEY="x")
            boto3.client("s3", region_name="eu-west-2").create_bucket(
                Bucket="data", CreateBucketConfiguration={"LocationConstraint": "eu-west-2"})
            from backend.store import S3Store

            s = S3Store("data", "app")
            self.assertIsNone(s.get("projects/x/project.json"))
            s.put("projects/x/project.json", b"{}", "application/json")
            s.put("projects/x/sessions/a.json", b"1")
            self.assertEqual(s.get("projects/x/project.json"), b"{}")
            self.assertEqual(s.list("projects/x/"), ["projects/x/project.json", "projects/x/sessions/a.json"])
            s.delete("projects/x/sessions/a.json")
            self.assertEqual(s.list("projects/"), ["projects/x/project.json"])
            with self.assertRaises(ValueError):
                s.get("../secret")


if __name__ == "__main__":
    unittest.main()
