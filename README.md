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
* **Insights**: score chart, lead changes, each AI seat's win confidence and
  how its turn felt, plus your notes.

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

## AI players

Pick a controller for each seat when you start a game:

| Controller | Setup |
|---|---|
| Random bot | none. Smoke-tests setup and turn flow; it does not follow the rules |
| Copy/paste prompt | none. Paste the prompt into any chatbot and paste the JSON reply back |
| Claude in chat (bridge) | Server running. When the seat's turn comes, ask Claude Code in your chat: *"take the pending AI turn"* (it uses `tools/ai_bridge.py`) |
| Claude API | `pip install anthropic` and `export ANTHROPIC_API_KEY=...`. Optional: `CLAUDE_MODEL` (default `claude-opus-5-5`), `CLAUDE_EFFORT` (default `medium`) |
| OpenAI API | `export OPENAI_API_KEY=... OPENAI_MODEL=...` |

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
server.py            web server + JSON API (stdlib)
backend/storage.py   projects, images, sessions, AI queue (JSON files)
backend/ai.py        Claude / OpenAI relay
tools/ai_bridge.py   CLI to answer queued AI turns
static/              the app (vanilla JS modules, no build step)
  js/engine.js       table state, actions, log, seeded RNG
  js/ai.js           prompts, response parsing, AI controllers
  js/views/          projects, cards, rules, play
docs/PLAN.md         design, research and roadmap
```
