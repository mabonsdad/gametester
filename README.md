# Card Game Test Bench

Design prototype card games and playtest them turn by turn in the browser,
with any mix of human and AI players.

* **Projects**: one per game. Create from blank or from the included sample.
* **Card designer**: title, description, rules text, copies, colour, stats,
  and an imported image (framed or full-card).
* **Rules & setup**: zones (piles, rows, hands), counters, setup steps, turn
  phases, and the rulebook that testers and AI players follow.
* **Playtest table**: top-down view with 1-6 seats around the edge. You can
  see every hand, only the active hand, or one seat's view. Drag cards, flip,
  draw, score, undo, and step through turns. AI seats can be played one at a
  time or automatically.
* **Automation (optional)**:
  * trick-taking play: follow suit, trumps, partnerships, re-dealing;
  * shedding play: match colour or value, draw, card effects (skip,
    reverse, draw:N, wild), optional stacking of draw cards, rounds;
  * announcements such as "Last card!": required when a formula is true
    before or after a play; forgetting can be caught by other players or
    penalised automatically; every one made, missed or caught is counted and
    can be used in scoring;
  * set collection: a few actions per turn (draw, swap with a face-up
    market, play to your own zones, or complete and take another player's
    trick), with tricks written as simple patterns such as
    `alpha wolf + 2 werewolves` or `seer + 3 any distinct`; each zone scores
    the best way of splitting its cards into tricks, with a multiplier per
    zone, and face-down zones stay secret until the end; players can stack
    a finished face-up trick (free) so it is safe and always scores as that
    trick, and wild cards (value "same") are worth what they are with;
  * legal-move checking (off / warn / strict), with legal cards highlighted;
  * scoring rules and end conditions written as simple formulas, e.g.
    `max(0, teamTricks - 6)` or `othersHandSum("points")`.

  See the Whist, Switchback and werewolf_tricks samples.
* **Pauses**: optionally stop after each trick and after each hand or round,
  so the result can be read; the game-over screen shows the final standings
  and has a "Play again" button.
* **Insights**: score chart, lead changes, each AI seat's win confidence and
  how its turn felt, plus your notes.
* **Player view** (`play.html`): the selected game as a finished-looking
  game for one human against AI opponents. It starts with the rulebook and
  any choices (number of opponents, player options, which AI plays), then
  keeps the focus on your hand and the table, shows each opponent's move,
  pauses between tricks and hands, and ends with the scores. Open it from
  the "Player view ↗" link in a project's header. Every game is saved as a
  session, with timings, so it can be reviewed in Playtest.
* **Share links**: on the Playtest page, "Share as a game" makes a link that
  opens only that game's player view, with no password. Each link can be
  switched off, and has a daily cap on AI turns if Claude or ChatGPT
  opponents are allowed (quick bots cost nothing).
* **Player options**: rule variations a player can pick before a game, such
  as game length or a house rule. Each choice sets one or more project
  fields (`automation.shedding.stackDraws = "any"`). They are edited under
  Rules & setup.

See [docs/PLAN.md](docs/PLAN.md) for the design, the data model, the
playtesting research and the roadmap.

## Run it

```bash
python3 server.py            # http://localhost:8000
python3 server.py --host 0.0.0.0 --port 8080
```

Python 3.9+ standard library only. Data is saved under `data/` (set
`GAMETESTER_DATA` to move it).

Static hosting also works: serve the `static/` folder with any web server.
Without `server.py`, projects are saved in the browser, and AI seats can use
only the random bot or copy/paste prompts.

Set `APP_PASSWORD` (and optionally `API_TOKEN`) to require a login.

## Live site

https://shwsh.co.uk/experiments/gametester/ runs on AWS: static files on S3,
the API on Lambda, data in a private S3 bucket, all behind CloudFront.
Every push to `main` is tested and deployed by GitHub Actions
(`.github/workflows/deploy.yml`). Details: [deploy/aws/SETUP.md](deploy/aws/SETUP.md).

Tests: `python3 -m unittest discover -s tests` and `npm test` (engine, Node 20+)

## AI players

Pick a controller for each seat when you start a game:

| Controller | Setup |
|---|---|
| Random bot | none. Smoke-tests setup and turn flow; it does not follow the rules |
| Copy/paste prompt | none. Paste the prompt into any chatbot and paste the JSON reply back |
| Claude in chat (bridge) | Server running (local or hosted). When the seat's turn comes, ask Claude Code in your chat: *"take the pending AI turn"* (it uses `tools/ai_bridge.py`) |
| Claude API | `pip install anthropic` and `export ANTHROPIC_API_KEY=...`. Optional: `CLAUDE_MODEL` (default `claude-sonnet-5-5`, a thinking model at half Opus's price), `CLAUDE_EFFORT` (default `medium`) |
| OpenAI API | `export OPENAI_API_KEY=... OPENAI_MODEL=...` (the live site uses `gpt-6-sol`) |

Each AI seat sees only what that player could see at a real table, plus the
rulebook and the card list. It replies with actions and also reports its
estimated chance of winning, how the turn felt, and any rule ambiguities.

### Answering bridge turns by hand

```bash
python3 tools/ai_bridge.py list
python3 tools/ai_bridge.py show next        # prints the prompt
python3 tools/ai_bridge.py answer next reply.json
```

## Layout

```
server.py            local web server (stdlib): static files + API
lambda_function.py   AWS Lambda entry point for the same API
backend/app.py       the JSON API (routes, login, AI jobs)
backend/storage.py   projects, images, sessions, AI jobs
backend/store.py     file or S3 storage
backend/ai.py        Claude / OpenAI calls
tools/ai_bridge.py   CLI to answer "Claude in chat" AI turns (local or hosted)
deploy/aws/          CloudFormation template, Lambda build, CloudFront routes
tests/               backend tests
static/              the app (vanilla JS modules, no build step)
  js/engine.js       table state, actions, log, seeded RNG
  js/ai.js           prompts, response parsing, AI controllers
  js/sets.js         set-collection patterns and best-combination scoring
  js/turns.js        one AI turn with retries and fallbacks (shared)
  js/player.js       the player view (play.html)
  js/views/          projects, cards, rules, play
docs/PLAN.md         design, research and roadmap
```
