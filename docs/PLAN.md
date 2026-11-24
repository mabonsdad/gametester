# Card Game Test Bench: plan

A web toolkit for designing prototype card games and playtesting them turn by
turn, with any mix of human and AI seats, and (later) automated analysis of
whether a game is fair, tense and satisfying.

## 1. Goals

1. **Flexible enough for any card game.** No rules are hard-coded: a project
   describes its zones, setup, turn structure and a plain-English rulebook.
2. **A real table view.** Top-down "camera above the table" view with the
   shared play area in the middle and 2-6 seats around the edge.
3. **Switchable perspectives.** See every hand (designer / god view), only the
   active player's hand (pass-and-play), or one seat's view while AI plays
   the other seats.
4. **Step-by-step control.** Advance one action, phase or turn at a time; undo;
   auto-run AI seats until a human seat comes up.
5. **AI players that read the rulebook** and report on their experience,
   feeding a later analysis layer.
6. **Simple hosting.** Static HTML/CSS/JS plus an optional standard-library
   Python server. No build step and no database.

## 2. Architecture

```
browser (static/)                               server.py (optional, stdlib)
┌───────────────────────────────────────┐       ┌──────────────────────────────┐
│ app.js       router + header          │ JSON  │ /api/projects  CRUD          │
│ views/       projects, cards, rules,  │──────▶│ /api/.../images  uploads     │
│              play (table)             │       │ /api/.../sessions  saves     │
│ engine.js    zones, actions, log, RNG │       │ /api/ai/complete  Claude API │
│ ai.js        prompts, parsing, bots   │       │                   / OpenAI   │
│ api.js       server OR localStorage   │       │ /api/ai/bridge  queue for    │
└───────────────────────────────────────┘       │   Claude-in-chat answers     │
                                                └──────────────┬───────────────┘
                                                               │ data/ (JSON files)
                                         tools/ai_bridge.py ───┘ (CLI used by Claude Code)
```

* The **engine runs in the browser**, so turns are instant and the app also
  works on a plain static host (it then saves to localStorage and offers the
  random bot and copy/paste AI).
* The **server** adds file storage, image uploads, the Claude/OpenAI relay
  (API keys stay on the server) and the chat-bridge queue.
* The **engine is a "smart table", not a rules engine.** It knows where cards
  are, who can see them and whose turn it is. Humans and AIs apply the rules.
  This keeps it general. Optional rule automation is a later phase (§8).

## 3. Data model

### Project (`data/projects/<id>/project.json`)

| Field | Purpose |
|---|---|
| `players {min,max,default}` | Seat count range (1-6) |
| `zones[]` | `{id, name, scope: shared\|player, layout: stack\|spread\|hand, faceUp, visibility: public\|owner}` |
| `counters[]` | Per-player numbers (score, health, coins…) with start values |
| `setup[]` | Ordered steps: `shuffle`, `deal` (N to each player), `move` (N between zones), `counter` |
| `turn` | `phases[]`, `drawAtStart {count, from}`, `firstPlayer`, `direction` |
| `rules` | Free text: overview, objective, turn rules, end of game, scoring, AI hints |
| `cards[]` | `{id, name, description, rules, count, startZone, color, image, imageMode, stats{}, tags[]}` |
| `automation` | `style` (free \| tricks \| shedding), `enforce` (off \| warn \| strict), `autoScore`, `teams`, `tricks{zone, wonZone, suitStat, rankStat, followSuit, trump, trumpSuit, firstLead, redeal}`, `shedding{drawZone, discardZone, colourStat, valueStat, effectStat, wildColour, playDrawn, stackDraws}`, `announcements[]{id, label, check, when, ifMissed, penaltyDraw, penaltyCounter, penaltyAmount, aiCatch, remind}`, `scoring[]{event, who, counter, expr, when, label}`, `endWhen[]{at, expr, winner, label}` |
| `cardBack` | Colour / image / label |

### Game state (inside a session file)

* `players[]`: id (`p1`…), name, controller, counters
* `zones{}`: instances (`deck`, `p2.hand`…), each an ordered list of card uids (last = top)
* `cards{}`: uid → `{defId, zone, faceUp}`
* `turn {number, active, phase}`, `status`, `result`
* `seed` + `rng`: seeded shuffles, so a game is reproducible
* `log[]`: every action, with `text` (full) and `publicText` (hidden info redacted)
* `timeline[]`: counters snapshot at each end of turn, used for lead and comeback analysis
* `assessments[]`: AI seats' win-confidence and "how did this turn feel"

### Actions (the only way state changes)

`move`, `draw`, `flip`, `shuffle`, `counter`, `phase`, `endTurn`, `endGame`,
`note`, `assess`. Humans produce them by dragging and clicking; AIs produce them
as JSON. Undo restores a snapshot. Because the log plus the seed describe the
whole game, a later replay viewer and a batch simulator can reuse the engine
unchanged.

## 4. Screens

1. **Projects**: list, new (blank or sample), duplicate, import/export JSON, delete.
2. **Cards**: grid of card types with live preview. Title, type line, rules
   text, copies, starting zone, colour, tags, stats and image (framed or
   full-bleed). Quick-add from a pasted list, and a card-back designer.
3. **Rules & setup**: game info, zones table, counters, setup steps, turn
   structure (phases, auto-draw, first player, direction), the rulebook, and a
   preview of the exact prompt the AI receives.
4. **Playtest**
   * Setup: player count, seat names, controller per seat, seed, saved sessions.
   * Table: shared zones on the felt; seats around the edge (layouts for 1-6
     players, clockwise, with the viewer's seat rotated to the bottom). Drag cards
     between zones, double-click to flip, +/- counters.
   * Views: **Overhead** (all hands), **Hotseat** (active hand only),
     **Single seat** (one player's view).
   * Sidebar: turn and phase controls, *Play AI turn*, auto-play, undo, end
     game; tabs for Card inspector, Log (with designer notes), Insights, and
     Rules reference.
5. **Player view** (`play.html#p=<project>` or `play.html#s=<share token>`)
   * Welcome: rulebook, name, number of opponents, player options, AI choice.
   * Play: one human (bottom) against AI opponents shown as avatars with card
     fans, counters and speech bubbles; AI turns follow on automatically with
     a short pause; tricks and hands pause until the player clicks Next.
   * Rules pop-up, a feed of what happened, and a results screen (with
     confetti for a win).
   * It drives the same engine and saves a normal session (`v_` ids) with
     telemetry: move times, blocked and illegal clicks, AI turn times and
     errors, rules opened, restarts.
   * Share links (`shares/<token>.json`) give anonymous access to one
     project's player view through `/api/play/<token>/...`, with a per-link
     daily AI-turn cap; they can be revoked.

## 5. AI seats

Every provider gets the same prompt:

* **System**: the full rulebook, zones, counters, every card type, and the
  response contract.
* **User**: only what that seat can see (its hand, public cards, pile sizes,
  opponents' hand sizes) and the recent public log. Hidden information is
  never leaked.

The AI must reply with:
```json
{"reasoning": "...", "actions": [{"type":"move","card":"c12","to":"harbour"}, {"type":"endTurn"}],
 "winConfidence": 40, "experience": "one sentence", "designerNotes": "ambiguities"}
```
The harness checks each action. For example, an AI may not move a card it
cannot see. Rejected actions are logged as warnings. `winConfidence` and
`experience` feed the Insights tab now and the analysis layer later.
`designerNotes` turns every AI seat into a blind playtester for rules clarity.

| Controller | Needs | Use |
|---|---|---|
| Random bot | nothing | Smoke-test setup, zones and turn flow |
| Copy/paste prompt | nothing | Paste into Claude.ai or any chatbot |
| Claude in chat (bridge) | server | Claude Code in the chat window answers via `tools/ai_bridge.py` |
| Claude API | server, `pip install anthropic`, `ANTHROPIC_API_KEY` | Unattended play; default model `claude-opus-5-5` |
| OpenAI API | server, `OPENAI_API_KEY`, `OPENAI_MODEL` | Alternative provider |

## 6. Playtesting best practice, and how it maps to the tool

| Practice (source) | In the tool |
|---|---|
| Decide which numbers you will measure *before* testing: win rate by seat, game length, score ratios ([MEQA framework](https://neutronium-landing.pages.dev/blog/meqa-game-balance-framework), [playtesting guide](https://neutronium-landing.pages.dev/blog/board-game-playtesting-guide)) | Counters + per-turn timeline now; seat win rates and length distributions in the batch phase |
| Runaway leader: does the leader ever lose after a certain point? ([BGDF](https://www.bgdf.com/forum/game-creation/design-theory/runaway-leader), [Inside Up](https://insideupgames.com/?p=12842)) | Lead-change count and "leader since turn N" in Insights |
| Catch-up mechanics and positional balance ([Games Precipice](https://www.gamesprecipice.com/positional-balance)) | Seat rotation and first-player settings; per-seat stats planned |
| Uncertainty: a reason to play well, and a real chance to come back ([Gelman on Costikyan](https://statmodeling.stat.columbia.edu/2024/02/15/uncertainty-in-games-how-to-get-that-balance-so-that-theres-a-motivation-to-play-well-but-you-can-still-have-a-chance-to-come-back-from-behind/)) | AI `winConfidence` per turn; a "known loser" warning when a seat believes it has lost for several turns |
| Self-play simulation reveals seat advantage and strategy diversity, but random agents are weak stand-ins ([AI playtesting write-up](https://bennycheung.github.io/ai-playtesting-when-your-game-tests-itself)) | Random bot only for smoke tests; rulebook-reading LLM seats for real tests; humans stay in the loop |
| Blind playtests check that the rules can be understood without the designer present ([Board Game Design Lab](https://boardgamedesignlab.com/playtest-like-a-boss/)) | AI seats only see the written rulebook and report ambiguities in `designerNotes` |
| Record observations in the moment, not afterwards | Designer notes in the log, timestamped to the turn |
| Reproducibility, logs and time travel (the [boardgame.io](https://boardgame.io/) model: pure moves, phases, logs) | Seeded RNG, action log, undo; replay viewer planned |

## 7. What makes the ending satisfying (for the analysis layer)

Signals we can compute from `timeline`, `assessments` and the log:

* **Decisiveness turn**: the first turn after which the final winner always led.
  Bad if it comes early, because everyone else knows they have lost.
* **Lead changes and comeback rate**: how often a trailing player wins.
* **Drama**: how close the top two were in the final third.
* **Perceived hope**: for each seat, the turns with `winConfidence` at or below
  10. Long stretches mean a disengaged player.
* **Kingmaking**: late turns where a seat that cannot win picks the winner.
* **Downtime and agency**: actions per turn, and turns where a seat had one or
  no real option (from AI `experience`).
* **Seat and first-player advantage**: win rate by seat over many games.

## 8. Roadmap

**Phase 1: test environment (this release)**
Projects, card designer, rules and setup editor, table with 1-6 seats and three
view modes, step-by-step turns, undo, sessions, five AI controllers, basic
insights (score chart, lead changes, AI feelings, notes).

**Phase 2: better table and rules assistance**
* Done:
  * Rules automation (`project.automation`, `static/js/engine.js`):
    * trick-taking play: follow suit, trumps, partnerships, dealer rotation,
      re-dealing each hand;
    * legal-move checking (off / warn / strict) with legal cards highlighted
      for humans and listed for AI seats;
    * scoring rules and end conditions written as safe formulas (`static/js/expr.js`).
  * A plain-English summary of the automated rules, shown in the editor and
    the play view and sent to AI seats.
  * Standard 52-card deck generator; Whist sample project.
  * Shedding style (match colour or value, draw, card effects
    `skip / reverse / draw:N / wild`, rounds scored from the cards left in other
    hands); Switchback sample, an original game in the Crazy Eights family.
  * Optional pauses after each trick and each hand or round; a game-over screen
    with standings and "Play again".
  * Stacking draw cards (off / same size / any).
  * Player view and share links for testing with real players.
  * Set-collection style (`automation.sets`, `static/js/sets.js`) and the
    Weirdwolves sample:
    * N actions per turn: draw, swap with a face-up market card, play to one
      of your own scoring zones, or complete a trick with another player's
      loose cards and take it; a hand limit with discards at the end of a turn.
    * Tricks are patterns (`5 villagers`, `seer + 3 any distinct`,
      `defender + villager/seer/witch` with points `sum * 2`).
    * Each zone scores its best split into tricks (each card counts once) ×
      the zone's multiplier. Secret zones are revealed and added at the end.
    * The game ends when the draw pile runs out (after an equal number of
      turns, or straight away).
    * The quick bot plays a simple strategy: steal or finish a trick, start a
      trick it can finish this turn face up, build face down, swap, draw.
    * The card editor has an optional emoji icon for cards without an image.
    * Stacking (`st.stacks`, `sets.stackZones`, default the give zone): a
      free `stack` action, or `"stack": true` on a play, groups cards that
      form a trick. A stack scores as that trick and cannot be used by other
      players; unstacked cards still score in their best arrangement but can
      be completed and taken. Wild values ("same") take the value of the best
      other card in the trick.
    * `sets.arrange: 'auto'` (Weirdwolves' default): face-up zones group
      themselves for the fewest lone cards (then the least valuable lone
      cards, then points); every trick is safe.
    * A `steal` action puts several hand cards into another player's zone to
      complete a trick with their lone cards (one action per card); the player
      view shows each possible steal as a button on that player's panel.
  * Player options (`project.variants`): named choices that set project
    fields, picked on the player view's welcome screen.
  * Announcements: a general "say something around a play" mechanic.
    * Rule fields: label, a formula for when it is required, checked before
      or after the play, and what happens if it is forgotten (others can
      catch the player until the next player acts / automatic penalty /
      only recorded). Penalties are draw N and/or a counter change.
    * Interface: an announce button for players; AI players add `announce` to
      their move.
    * Tracking: per-player counts of announcements made, missed, caught,
      catches and unneeded, shown in Insights. Scoring can use the
      `announcement` and `penalty` events and the announced() / missed() /
      caught() / catches() formulas.
* Next:
  * Free-form legality rules, e.g. "play cards matching colour or number", a
    hand limit, or one play per turn. These would reuse the same check/highlight path.
  * Bidding/contract phases (Oh Hell, Spades) as an optional step before the
    first trick of a hand.
  * More shedding options: challenging a draw-four, jump-in.
  * Announcements by players who are not on turn, e.g. "jump in" or
    "challenge". A wider "reactions" mechanic could reuse the catch window.
  * Hotseat "pass the device" screen; touch drag for tablets.
  * Card templates (layout per card type), CSV import, print-and-play PDF sheets.
  * Optional structured effects per card (e.g. `draw 2`, `+3 score`) that the
    engine can apply.
  * Replay viewer: scrub through a saved session's log.

**Phase 3: batch simulation**
* Headless runner (Node or Python port of `engine.js`) that plays N games with
  AI seats, using the Claude API with Batches for cost
* Dashboard: win rate by seat, game length, decisiveness turn, lead changes,
  card usage (dead cards and dominant cards)
* A/B testing of rule variants: duplicate a project, change one rule, compare

**Phase 4: analysis layer**
* AI reviewer with the omniscient log: per-seat narrative of how the game felt,
  turning points, and "was the finale satisfying?"
* Automatic flags: early decisiveness, known losers, kingmaking, runaway leader
* Suggested rule tweaks, each tested in Phase 3 before it is recommended

**Phase 5: sharing**
Multi-device online play (each tester on their own device), playtest
questionnaires, and exporting reports.
