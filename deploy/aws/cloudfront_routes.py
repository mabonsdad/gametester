#!/usr/bin/env python3
"""Add the gametester API routes to an existing CloudFront distribution.

Adds (or updates) one origin - the gametester Lambda Function URL, with the
X-Origin-Verify secret header - and two cache behaviours that send
<prefix>/api/* and <prefix>/media/* to it. Everything else in the
distribution is left untouched. New behaviours copy the settings of an
existing Lambda-backed behaviour (caching disabled, all viewer headers except
Host forwarded, all HTTP methods).

Dry run (prints the changes):
    python3 cloudfront_routes.py --distribution E3LS87IBDVMSCO \
        --function-url-domain xxxx.lambda-url.eu-west-2.on.aws \
        --secrets ~/.config/gametester/secrets.json
Apply:  add --apply
Uses the AWS CLI; standard library only.
"""
import argparse
import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ORIGIN_ID = "GametesterFunctionUrl"
CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"            # AWS managed cache policy
ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac"      # AWS managed origin request policy
ALL_METHODS = ["HEAD", "DELETE", "POST", "GET", "OPTIONS", "PUT", "PATCH"]


def aws(*args):
    out = subprocess.run(["aws", *args, "--output", "json"], check=True, capture_output=True, text=True)
    return json.loads(out.stdout) if out.stdout.strip() else None


def make_origin(domain, secret):
    return {
        "Id": ORIGIN_ID,
        "DomainName": domain,
        "OriginPath": "",
        "CustomHeaders": {"Quantity": 1, "Items": [{"HeaderName": "X-Origin-Verify", "HeaderValue": secret}]},
        "CustomOriginConfig": {
            "HTTPPort": 80,
            "HTTPSPort": 443,
            "OriginProtocolPolicy": "https-only",
            "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
            "OriginReadTimeout": 60,
            "OriginKeepaliveTimeout": 5,
        },
        "ConnectionAttempts": 3,
        "ConnectionTimeout": 10,
        "OriginShield": {"Enabled": False},
        "OriginAccessControlId": "",
    }


def make_behavior(template, pattern):
    b = copy.deepcopy(template) if template else {}
    b.update({
        "PathPattern": pattern,
        "TargetOriginId": ORIGIN_ID,
        "ViewerProtocolPolicy": "redirect-to-https",
        "CachePolicyId": CACHING_DISABLED,
        "OriginRequestPolicyId": ALL_VIEWER_EXCEPT_HOST,
        "Compress": True,
        "SmoothStreaming": False,
        "FieldLevelEncryptionId": "",
        "TrustedSigners": {"Enabled": False, "Quantity": 0},
        "TrustedKeyGroups": {"Enabled": False, "Quantity": 0},
        "LambdaFunctionAssociations": {"Quantity": 0},
        "FunctionAssociations": {"Quantity": 0},
        "AllowedMethods": {
            "Quantity": len(ALL_METHODS), "Items": ALL_METHODS,
            "CachedMethods": {"Quantity": 2, "Items": ["HEAD", "GET"]},
        },
    })
    for legacy in ("ForwardedValues", "MinTTL", "DefaultTTL", "MaxTTL", "ResponseHeadersPolicyId", "RealtimeLogConfigArn", "GrpcConfig"):
        b.pop(legacy, None)
    return b


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--distribution", required=True)
    ap.add_argument("--function-url-domain", required=True)
    ap.add_argument("--secrets", required=True, help="JSON file with OriginSecret")
    ap.add_argument("--prefix", default="/experiments/gametester")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    secret = json.loads(Path(args.secrets).expanduser().read_text())["OriginSecret"]
    res = aws("cloudfront", "get-distribution-config", "--id", args.distribution)
    etag, cfg = res["ETag"], res["DistributionConfig"]
    before = json.dumps(cfg, sort_keys=True)

    # Origin
    origins = cfg["Origins"]["Items"]
    new_origin = make_origin(args.function_url_domain, secret)
    idx = next((i for i, o in enumerate(origins) if o["Id"] == ORIGIN_ID), None)
    if idx is None:
        origins.append(new_origin)
        print(f"+ origin {ORIGIN_ID} -> {args.function_url_domain}")
    elif origins[idx] != new_origin:
        origins[idx] = new_origin
        print(f"~ origin {ORIGIN_ID} updated -> {args.function_url_domain}")
    cfg["Origins"]["Quantity"] = len(origins)

    # Behaviours
    cb = cfg.setdefault("CacheBehaviors", {"Quantity": 0})
    items = cb.setdefault("Items", [])
    template = next((b for b in items if b.get("CachePolicyId") == CACHING_DISABLED), None)
    for suffix in ("/api/*", "/media/*"):
        pattern = args.prefix.rstrip("/") + suffix
        new_b = make_behavior(template, pattern)
        idx = next((i for i, b in enumerate(items) if b["PathPattern"] == pattern), None)
        if idx is None:
            items.append(new_b)
            print(f"+ behaviour {pattern} -> {ORIGIN_ID}")
        elif items[idx] != new_b:
            items[idx] = new_b
            print(f"~ behaviour {pattern} updated")
    cb["Quantity"] = len(items)

    if json.dumps(cfg, sort_keys=True) == before:
        print("No changes needed.")
        return
    print("Other origins and behaviours are unchanged:",
          [o["Id"] for o in origins if o["Id"] != ORIGIN_ID],
          [b["PathPattern"] for b in items if b["TargetOriginId"] != ORIGIN_ID])
    if not args.apply:
        print("Dry run - re-run with --apply to update the distribution.")
        return
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(cfg, f)
    out = aws("cloudfront", "update-distribution", "--id", args.distribution,
              "--if-match", etag, "--distribution-config", f"file://{f.name}")
    Path(f.name).unlink()
    print("Updated. Status:", out["Distribution"]["Status"], "(deploys to edge locations in a few minutes)")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as e:
        sys.exit(f"AWS CLI failed: {e.stderr.strip()}")
