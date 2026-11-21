# Card Game Test Bench: notes for Claude

Vanilla JS front end (`static/`, ES modules, no build step) plus a stdlib
Python server (`server.py`, `backend/`). The design and roadmap are in
`docs/PLAN.md`.

## Taking AI turns through the chat bridge

When the user asks you to "take the pending AI turn" (or similar):

1. `python3 tools/ai_bridge.py show next` prints the system prompt (rules,
   cards, response format) and the user prompt (that seat's view).
2. Decide the turn as a fair player. Use only what that seat can see; do not
   read other hands from `data/` files.
3. Write the JSON reply (`reasoning`, `actions` ending in `endTurn`,
   `winConfidence`, `experience`, `designerNotes`) to a scratch file and run
   `python3 tools/ai_bridge.py answer next <file>`.
4. Repeat while `python3 tools/ai_bridge.py list` shows pending requests, if
   the user asked for several turns.

Apply the game's rules yourself, including counter changes for scoring. The
harness does not enforce rules.

For the live site add `--url https://shwsh.co.uk/experiments/gametester`
(needs the API token; see deploy/aws/SETUP.md).

## Deploying

The live site (shwsh.co.uk/experiments/gametester) deploys from `main` via
`.github/workflows/deploy.yml`. Work on a branch and open a PR; the owner has
said Claude may merge its own PRs once the PR's test job passes (merging
deploys to the live site). AWS infrastructure details are in `deploy/aws/SETUP.md`. Never
put data under the public site bucket: it is world-readable.

## Checks

* `python3 -m unittest discover -s tests` and `node --test tests/js/*.test.js`
* `node --check static/js/**/*.js` for syntax
* Run `python3 server.py` and drive it with Playwright (Chromium is preinstalled)
