"""AI providers for controlling seats.

The browser builds the prompt (system + user text) so that the same prompt can
be used by every provider, including the copy/paste "manual" mode that needs no
server. This module only relays prompts to hosted models.

Providers:
  anthropic  - Claude via the official `anthropic` SDK (pip install anthropic).
               Credentials: ANTHROPIC_API_KEY (or an `ant auth login` profile).
               Optional: CLAUDE_MODEL (default claude-sonnet-5-5), CLAUDE_EFFORT
               (low|medium|high|xhigh|max, default medium).
  openai     - OpenAI Chat Completions over plain HTTPS.
               Needs OPENAI_API_KEY and OPENAI_MODEL.
"""
import json
import os
import urllib.error
import urllib.request

DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5"
# Models that accept server-side fallbacks when a safety classifier declines.
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-fable-5-2", "claude-sonnet-5-5"}


class AIError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def status():
    """Which providers look configured (does not make any network calls)."""
    try:
        import anthropic  # noqa: F401
        sdk = True
    except ImportError:
        sdk = False
    return {
        "anthropic": {
            "sdkInstalled": sdk,
            "keySet": bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")),
            "model": os.environ.get("CLAUDE_MODEL", DEFAULT_CLAUDE_MODEL),
        },
        "openai": {
            "keySet": bool(os.environ.get("OPENAI_API_KEY")),
            "model": os.environ.get("OPENAI_MODEL") or None,
        },
    }


def complete(provider, system, user, options=None):
    options = options or {}
    if provider == "anthropic":
        return _anthropic(system, user, options)
    if provider == "openai":
        return _openai(system, user, options)
    raise AIError(f"Unknown provider {provider!r}", 400)


def _anthropic(system, user, options):
    try:
        import anthropic
    except ImportError:
        raise AIError("The anthropic package is not installed on the server. Run: pip install anthropic", 501)

    model = options.get("model") or os.environ.get("CLAUDE_MODEL", DEFAULT_CLAUDE_MODEL)
    effort = options.get("effort") or os.environ.get("CLAUDE_EFFORT", "medium")
    client = anthropic.Anthropic()
    kwargs = dict(
        model=model,
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": user}],
        output_config={"effort": effort},
    )
    try:
        if model in FALLBACK_MODELS:
            # If a safety classifier declines, let the API retry on a suitable model.
            resp = client.beta.messages.create(
                betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs
            )
        else:
            resp = client.messages.create(**kwargs)
    except anthropic.AuthenticationError:
        raise AIError("Claude API rejected the credentials. Set ANTHROPIC_API_KEY on the server.", 401)
    except anthropic.RateLimitError:
        raise AIError("Claude API rate limit hit - wait a moment and retry.", 429)
    except anthropic.BadRequestError as e:
        raise AIError(f"Claude API rejected the request: {e}", 400)
    except anthropic.APIStatusError as e:
        raise AIError(f"Claude API error {e.status_code}: {e}", 502)
    except anthropic.APIConnectionError as e:
        raise AIError(f"Could not reach the Claude API: {e}", 502)

    if resp.stop_reason == "refusal":
        raise AIError("Claude declined this request (refusal).", 502)
    text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
    if not text.strip():
        raise AIError(f"Claude returned no text (stop_reason={resp.stop_reason}).", 502)
    return {"text": text, "model": getattr(resp, "model", model)}


def _openai(system, user, options):
    key = os.environ.get("OPENAI_API_KEY")
    model = options.get("model") or os.environ.get("OPENAI_MODEL")
    if not key or not model:
        raise AIError("Set OPENAI_API_KEY and OPENAI_MODEL on the server to use the OpenAI provider.", 501)
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        raise AIError(f"OpenAI API error {e.code}: {e.read().decode(errors='replace')[:500]}", 502)
    except urllib.error.URLError as e:
        raise AIError(f"Could not reach the OpenAI API: {e}", 502)
    try:
        return {"text": data["choices"][0]["message"]["content"], "model": data.get("model", model)}
    except (KeyError, IndexError, TypeError):
        raise AIError("Unexpected OpenAI response shape", 502)
