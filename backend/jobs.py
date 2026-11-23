"""Background execution of AI jobs.

Model calls can take longer than a web request should (CloudFront gives up
after 30s by default), so the API creates a job and returns at once; the
browser polls for the answer.

* Locally the job runs in a thread.
* On AWS Lambda the function invokes itself asynchronously with
  {"gametester_job": id}; lambda_function.handler routes that to run().
"""
import json
import os
import threading

from . import ai, storage

HOSTED_PROVIDERS = {"anthropic", "openai"}


def run(jid):
    job = storage.job_get(jid)
    if job.get("status") != "pending":
        return
    storage.job_update(jid, status="running")
    prompt = job.get("prompt") or {}
    try:
        options = dict(job.get("options") or {})
        if prompt.get("format") == "turn":
            options["format"] = "turn"
        res = ai.complete(job["provider"], prompt.get("system", ""), prompt.get("user", ""), options)
        fields = dict(status="answered", response=res["text"], model=res.get("model"))
    except ai.AIError as e:
        fields = dict(status="error", error=str(e))
    except Exception as e:  # report anything else to the browser too
        fields = dict(status="error", error=f"{type(e).__name__}: {e}")
    if storage.job_get(jid).get("status") == "running":  # not cancelled meanwhile
        storage.job_update(jid, **fields)


def start(jid):
    fn = os.environ.get("AWS_LAMBDA_FUNCTION_NAME")
    if fn:
        import boto3

        boto3.client("lambda").invoke(
            FunctionName=fn, InvocationType="Event", Payload=json.dumps({"gametester_job": jid}).encode()
        )
    else:
        threading.Thread(target=run, args=(jid,), daemon=True).start()
