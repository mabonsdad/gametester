# Hosting on AWS (shwsh.co.uk/experiments/gametester)

```
browser ── https://shwsh.co.uk/experiments/gametester/...
             │  CloudFront distribution E3LS87IBDVMSCO
             ├── /experiments/gametester/api/*   ─┐  origin GametesterFunctionUrl
             ├── /experiments/gametester/media/* ─┴─▶ Lambda gametester-api (eu-west-2)
             │                                         adds X-Origin-Verify header ──▶ checked by the Lambda
             │                                         data ──▶ private S3 bucket gametester-databucket-*
             └── everything else (default) ──────────▶ S3 website bucket shwsh.co.uk
                                                       /experiments/gametester/ (static/ folder)
```

| Piece | Where |
|---|---|
| Static front end | `s3://shwsh.co.uk/experiments/gametester/` (public website bucket) |
| API | Lambda `gametester-api`, python3.12 arm64, eu-west-2 |
| Data (projects, sessions, images, AI jobs) | private bucket from the `gametester` stack (versioned) |
| Infrastructure | CloudFormation stack `gametester` (eu-west-2), from `template.yaml` |
| CloudFront routes | added by `cloudfront_routes.py` (not managed by the stack) |
| Deploys | `.github/workflows/deploy.yml` on every push to `main` |
| GitHub access to AWS | role `GitHubActionsGametesterDeployRole` (OIDC; `main` branch of this repo only) |
| Secrets | `~/.config/gametester/secrets.json` on the owner's Mac (mode 600), also in the Lambda's environment |

## Day to day

Merge to `main` → GitHub Actions runs the tests, then:
1. builds the Lambda zip (`build_lambda.sh`) and uploads it,
2. syncs `static/` to the site bucket (only under `experiments/gametester/`),
3. invalidates `/experiments/gametester/*` in CloudFront,
4. checks `/api/health`.

The deploy role can only touch those three things.

## One-time setup (already done on 19 Nov 2026)

Run from a machine with the AWS CLI logged in to account 528323923790:

```bash
# 1. Secrets (once): AppPassword, SessionSecret, ApiToken, OriginSecret
#    -> ~/.config/gametester/secrets.json (mode 600)
# 2. Stack
aws cloudformation deploy --region eu-west-2 --stack-name gametester \
  --template-file deploy/aws/template.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides file://$HOME/.config/gametester/params.json   # ["Key=Value", ...]
# 3. CloudFront routes (dry run first, then --apply)
python3 deploy/aws/cloudfront_routes.py --distribution E3LS87IBDVMSCO \
  --function-url-domain <FunctionUrlDomain output> \
  --secrets ~/.config/gametester/secrets.json [--apply]
# 4. Merge to main (or run the Deploy workflow) to upload the code.
```

## Changing settings

Re-run the stack deploy with only the parameters you change; the others keep
their values:

```bash
# e.g. add or rotate the Claude API key
aws cloudformation deploy --region eu-west-2 --stack-name gametester \
  --template-file deploy/aws/template.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides AnthropicApiKey=sk-ant-... \
  AppPassword=<same> SessionSecret=<same> ApiToken=<same> OriginSecret=<same>
```
(`NoEcho` parameters must be passed again, or use `UsePreviousValue` with
`aws cloudformation update-stack`.) Changing `AppPassword` logs everyone out
only if `SessionSecret` also changes.

Stack updates do not replace the deployed code (the template's inline code
is only a placeholder), but if the function is ever recreated, re-run the
Deploy workflow.

## Answering AI turns from Claude in chat (bridge)

`tools/ai_bridge.py --url https://shwsh.co.uk/experiments/gametester` with
`GAMETESTER_TOKEN` set to the ApiToken (or a proxy that adds
`Authorization: Bearer <ApiToken>` for that host).

## Removing it

1. Remove the two `/experiments/gametester/*` behaviours and the
   `GametesterFunctionUrl` origin from the distribution.
2. `aws cloudformation delete-stack --region eu-west-2 --stack-name gametester`
   (the data bucket is retained; empty and delete it by hand if wanted).
3. `aws s3 rm --recursive s3://shwsh.co.uk/experiments/gametester/`
