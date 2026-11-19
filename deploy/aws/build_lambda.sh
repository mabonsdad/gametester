#!/usr/bin/env bash
# Build the Lambda deployment zip (python3.12, arm64).
#   deploy/aws/build_lambda.sh [output.zip]     (default: build/lambda.zip)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/build/lambda.zip}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

python3 -m pip install --quiet --disable-pip-version-check --target "$WORK" \
  --platform manylinux2014_aarch64 --implementation cp --python-version 3.12 \
  --only-binary=:all: -r "$ROOT/deploy/aws/lambda-requirements.txt"

cp -R "$ROOT/backend" "$WORK/"
cp "$ROOT/lambda_function.py" "$WORK/"
# The function's handler is index.handler (matches the CloudFormation placeholder).
printf 'from lambda_function import handler  # noqa: F401\n' > "$WORK/index.py"
find "$WORK" -name __pycache__ -prune -exec rm -rf {} +

mkdir -p "$(dirname "$OUT")"
OUT_ABS="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
rm -f "$OUT_ABS"
(cd "$WORK" && zip -qr9 "$OUT_ABS" .)
echo "Built $OUT_ABS ($(du -h "$OUT_ABS" | cut -f1))"
