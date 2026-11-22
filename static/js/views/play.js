// Playtest table: top-down view of the shared zones with 1-6 seats around
// the edge, turn controls, AI seats, log and insights.
import * as api from '../api.js';
import { CONTROLLERS, checkAction as aiCheck, isAI, parseResponse, requestTurn } from '../ai.js';
import {
  activePlayer, apply, automation, cardDef, checkAction as ruleCheck, clone, competitorName, competitors, createGame,
  announcementRules, announcementsDue, cardEffects, describeAutomation, isAutomated, isShedding, isTricks, leadStats, legalMoves,
  player, shedColours, shedTop, teamOf,
} from '../engine.js';
import { SUITS, uid, zoneDef } from '../model.js';
import { cardBack, cardFace, confirmDialog, debounce, download, field, fmtTime, h, modal, toast } from '../ui.js';

// Seat positions by player count. Numbers are positions clockwise from the
// viewer's seat (0 = bottom). Rows are listed left-to-right on screen.
const LAYOUT = {
  1: { bottom: [0] },
  2: { bottom: [0], top: [1] },
  3: { bottom: [0], top: [1, 2] },
  4: { bottom: [0], left: [1], top: [2], right: [3] },
  5: { bottom: [0], left: [1], top: [2, 3], right: [4] },
  6: { bottom: [0, 5], left: [1], top: [2, 3], right: [4] },
};

const VIEW_KEY = 'cgtb.playview';
const loadView = () => {
  try { return { mode: 'overhead', seat: 'p1', rotate: true, size: 78, auto: false, ...JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') }; } catch { return { mode: 'overhead', seat: 'p1', rotate: true, size: 78, auto: false }; }
};

export async function renderPlay(root, ctx, args) {
  const project = ctx.project;
  const view = loadView();
  const saveView = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* ignore */ } };
  let session = null;
  let st = null;
  let history = [];
  let selected = null;
  let sideTab = 'card';
  let aiBusy = null;
  let autoTimer = null;
  let disposed = false;

  const persist = debounce(async () => {
    if (!session || disposed) return;
    session.state = st;
    try { await api.saveSession(project.id, session); } catch (e) { toast('Session save failed: ' + e.message, 'error'); }
  }, 500);

  const tableEl = h('div', { class: 'table-wrap' });
  const sideEl = h('aside', { class: 'play-side' });
  const toolbarEl = h('div', { class: 'play-toolbar' });

  if (args[0]) {
    try {
      session = await api.getSession(project.id, args[0]);
      st = session.state;
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  if (!st) await drawSetup(); else drawGame();

  // ================================================================ setup screen
  async function drawSetup() {
    root.replaceChildren();
    const sessions = await api.listSessions(project.id).catch(() => []);
    const counts = [];
    for (let n = Math.max(1, project.players.min); n <= Math.min(6, project.players.max); n++) counts.push(n);
    let count = Math.min(Math.max(project.players.default || counts[0], counts[0]), counts[counts.length - 1]);
    const seats = [];
    const seatsWrap = h('div', { class: 'seat-config' });
    const serverMode = api.getMode() === 'server';
    const drawSeats = () => {
      while (seats.length < count) {
        const i = seats.length;
        seats.push({ name: `Player ${i + 1}`, controller: i === 0 ? 'human' : 'ai-random' });
      }
      seatsWrap.replaceChildren(...seats.slice(0, count).map((s, i) => h('div', { class: 'seat-row' },
        h('span', { class: 'seat-num' }, i + 1),
        h('input', { type: 'text', value: s.name, oninput: (e) => { s.name = e.target.value; } }),
        h('select', { value: s.controller, onchange: (e) => { s.controller = e.target.value; } },
          Object.entries(CONTROLLERS).map(([id, c]) => h('option', { value: id, disabled: c.server && !serverMode }, c.label + (c.server && !serverMode ? ' (needs server)' : '')))))));
    };
    drawSeats();
    const seedIn = h('input', { type: 'text', placeholder: 'random', size: 12 });
    const options = { pauseTricks: true, pauseHands: true };
    const optBox = (key, label) => h('label', { class: 'inline' },
      h('input', { type: 'checkbox', checked: options[key], onchange: (e) => { options[key] = e.target.checked; } }), ' ', label);
    const totalCards = project.cards.reduce((n, c) => n + (parseInt(c.count, 10) || 0), 0);
    const aiInfo = api.serverInfo()?.ai;

    root.append(h('div', { class: 'page' },
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Playtest'), h('p', { class: 'muted' }, 'Set up a table and play it turn by turn. Mix human and AI seats.'))),
      h('div', { class: 'setup-grid' },
        h('section', { class: 'panel' },
          h('h2', {}, 'New game'),
          totalCards ? null : h('p', { class: 'warn-box' }, 'This project has no cards yet. Add some in the Cards tab first.'),
          field('Players', h('select', { value: String(count), onchange: (e) => { count = parseInt(e.target.value, 10); drawSeats(); } },
            counts.map((n) => h('option', { value: String(n) }, `${n} players`)))),
          h('span', { class: 'field-label' }, 'Seats (clockwise)'),
          seatsWrap,
          h('div', { class: 'row gap wrap' },
            h('button', { class: 'btn small', onclick: () => { seats.forEach((s) => { s.controller = 'human'; }); drawSeats(); } }, 'All human'),
            h('button', { class: 'btn small', onclick: () => { seats.forEach((s, i) => { s.controller = i === 0 ? 'human' : 'ai-random'; }); drawSeats(); } }, 'Me + random bots'),
            serverMode ? h('button', { class: 'btn small', onclick: () => { seats.forEach((s, i) => { s.controller = i === 0 ? 'human' : 'ai-bridge'; }); drawSeats(); } }, 'Me + Claude (chat)') : null),
          isAutomated(project) ? h('div', { class: 'stack' },
            h('span', { class: 'field-label' }, 'Pauses'),
            isTricks(project) ? optBox('pauseTricks', 'Pause after each trick, so everyone can see who won it') : null,
            optBox('pauseHands', `Pause at the end of each ${isShedding(project) ? 'round' : 'hand'} to show the scores`)) : null,
          field('Random seed', seedIn, 'Same seed + same actions = same game. Leave blank for a new shuffle.'),
          h('p', { class: 'muted small' }, aiProviderNote(serverMode, aiInfo)),
          h('button', {
            class: 'btn primary', disabled: !totalCards, onclick: async () => {
              const seedRaw = seedIn.value.trim();
              const seed = seedRaw ? (/^\d+$/.test(seedRaw) ? parseInt(seedRaw, 10) : hashString(seedRaw)) : undefined;
              view.seat = 'p1';
              await startGame(seats.slice(0, count), options, seed);
            },
          }, 'Start game')),
        h('section', { class: 'panel' },
          h('h2', {}, 'Saved sessions'),
          sessions.length ? h('ul', { class: 'session-list' }, sessions.map((s) => h('li', {},
            h('div', {},
              h('strong', {}, s.name),
              h('div', { class: 'muted small' }, `${(s.players || []).join(', ')} · turn ${s.turn ?? '?'} · ${s.status === 'ended' ? 'finished' : 'in progress'} · ${fmtTime(s.updated)}`)),
            h('div', { class: 'row gap' },
              h('a', { class: 'btn small primary', href: `#/p/${project.id}/play/${s.id}` }, 'Resume'),
              h('button', {
                class: 'btn small danger', onclick: async () => {
                  if (await confirmDialog('Delete session', `Delete "${s.name}"?`, 'Delete')) { await api.deleteSession(project.id, s.id); drawSetup(); }
                },
              }, 'Delete'))))) : h('p', { class: 'muted' }, 'No saved sessions yet. Every game is saved automatically as you play.')))));
  }

  async function startGame(players, options, seed) {
    try {
      st = createGame(project, { players, seed, options });
    } catch (e) { toast(e.message, 'error'); return; }
    session = { id: uid('s_'), name: `${project.name} - ${new Date().toLocaleString()}`, projectId: project.id, created: Date.now(), state: st };
    history = [];
    selected = null;
    await api.saveSession(project.id, session).catch((e) => toast(e.message, 'error'));
    history_replace(session.id);
    drawGame();
  }

  // Same seats, controllers and pause settings; a new shuffle.
  async function playAgain() {
    await persist.flush();
    await startGame(st.players.map((p) => ({ name: p.name, controller: p.controller })), { ...st.options }, undefined);
    toast('New game started with the same seats.');
  }

  function backToSetup() {
    persist.flush();
    session = null; st = null;
    drawSetup();
    window.history.replaceState(null, '', `#/p/${project.id}/play`);
  }

  function continuePlay() {
    commit({ type: 'continue', actor: 'designer' });
  }

  function history_replace(sid) {
    // Update the URL without re-rendering the route.
    window.history.replaceState(null, '', `#/p/${project.id}/play/${sid}`);
  }

  // ================================================================ game

  function drawGame() {
    root.replaceChildren(h('div', { class: 'play' }, toolbarEl, h('div', { class: 'play-body' }, tableEl, sideEl)));
    render();
  }

  function viewer() {
    if (view.mode === 'seat') return player(st, view.seat) ? view.seat : st.players[0].id;
    if (view.mode === 'hotseat') return activePlayer(st).id;
    return null; // overhead: designer sees every hand
  }

  function canSeeFace(cuid) {
    const c = st.cards[cuid];
    const z = st.zones[c.zone];
    const def = zoneDef(project, z.defId) || {};
    if (def.visibility === 'owner') return view.mode === 'overhead' || z.owner === viewer();
    return !!c.faceUp;
  }

  function render() {
    if (disposed) return;
    drawToolbar();
    drawTable();
    drawSide();
    maybeAiCatch();
    scheduleAuto();
  }

  // When someone forgets an announcement, AI opponents may catch them (each
  // missed announcement gets one roll against the rule's AI catch chance).
  function maybeAiCatch() {
    const C = st?.catchable;
    if (!C || C.aiRolled || st.status !== 'playing') return;
    C.aiRolled = true;
    const ais = st.players.filter((p) => p.id !== C.pid && isAI(p.controller));
    const rule = announcementRules(project).find((r) => r.id === C.id);
    if (!ais.length || Math.random() * 100 >= Number(rule?.aiCatch ?? 70)) return;
    const catcher = ais[Math.floor(Math.random() * ais.length)];
    setTimeout(() => {
      if (!disposed && st.catchable && st.catchable.pid === C.pid && st.catchable.id === C.id) commit({ type: 'catch', actor: catcher.id });
    }, 400);
  }

  // ------------------------------------------------------------ actions
  function commit(action, { quiet = false } = {}) {
    if (st.status !== 'playing' && !['note', 'counter', 'move', 'flip'].includes(action.type)) {
      toast('The game has ended.', 'warn');
      return false;
    }
    const full = { actor: activePlayer(st).id, ...action };
    const why = ruleCheck(project, st, full);
    if (why && automation(project).enforce === 'strict') {
      if (!quiet) toast(`Not allowed: ${why}`, 'warn', 5000);
      return false;
    }
    const snapshot = clone(st);
    try {
      apply(project, st, full);
      if (why) apply(project, st, { type: 'note', actor: 'system', text: `Rule warning (${player(st, full.actor)?.name || full.actor}): ${why}` });
    } catch (e) {
      if (!quiet) toast(e.message, 'error');
      return false;
    }
    history.push(snapshot);
    if (history.length > 300) history.shift();
    render();
    persist();
    return true;
  }

  function undo() {
    if (aiBusy) return toast('Wait for the AI turn to finish (or cancel it).', 'warn');
    const prev = history.pop();
    if (!prev) return toast('Nothing to undo', 'warn');
    st = prev;
    render();
    persist();
  }

  // ------------------------------------------------------------ AI
  function scheduleAuto() {
    clearTimeout(autoTimer);
    if (!view.auto || aiBusy || st.status !== 'playing' || st.pending) return;
    if (!isAI(activePlayer(st).controller)) return;
    if (activePlayer(st).controller === 'ai-manual') return; // needs a human anyway
    autoTimer = setTimeout(() => runAiTurn(), st.catchable ? 1100 : 700);
  }

  async function runAiTurn() {
    if (aiBusy || st.status !== 'playing') return;
    if (st.pending) return toast('The game is paused - press Next first.', 'warn');
    const p = activePlayer(st);
    if (!isAI(p.controller)) return toast(`${p.name} is a human seat.`, 'warn');
    const turnAtStart = st.turn.number;
    const tricks = isTricks(project);
    const shedding = isShedding(project);
    const automated = tricks || shedding;
    const maxAsks = shedding ? 3 : tricks ? 2 : 1;
    const strict = automation(project).enforce === 'strict';
    const act = (a) => apply(project, st, { ...a, actor: a.actor || p.id });
    const myTurn = () => st.status === 'playing' && activePlayer(st).id === p.id && st.turn.number === turnAtStart;
    aiBusy = { message: `${p.name} is thinking…`, cancel: null };
    drawSide();
    try {
      let feedback = '';
      let parsed = null;
      let endRequested = false;
      let snapshotTaken = false;
      // Automated games ask again (with the reason) if the move was not legal,
      // and shedding games ask again after a draw (play the drawn card or pass).
      for (let attempt = 0; attempt < maxAsks; attempt++) {
        const res = await requestTurn(project, st, {
          manual: manualPrompt,
          waiting: (message, cancel) => { aiBusy = { message, cancel }; drawSide(); },
        }, feedback);
        if (disposed) return;
        if (!myTurn()) throw new Error('The table changed while the AI was thinking; its answer was discarded.');
        parsed = res.parsed || parseResponse(res.text);
        if (!snapshotTaken) { history.push(clone(st)); snapshotTaken = true; }
        if (parsed.reasoning) act({ type: 'note', text: parsed.reasoning, private: true, kind: 'reasoning' });
        const rejected = [];
        for (const raw of parsed.actions) {
          if (!myTurn()) break;
          if (!raw || typeof raw !== 'object') continue;
          const a = { ...raw, actor: p.id };
          if (a.type === 'endTurn' && !automated) { endRequested = true; break; } // applied after the assessment
          const blocked = aiCheck(project, st, p.id, a);
          const broken = ruleCheck(project, st, a);
          if (blocked || (broken && strict)) {
            rejected.push(blocked || broken);
            act({ type: 'note', actor: 'system', text: `${p.name}'s action rejected: ${blocked || broken}` });
            continue;
          }
          try {
            act(a);
            if (broken) act({ type: 'note', actor: 'system', text: `Rule warning (${p.name}): ${broken}` });
          } catch (e) {
            act({ type: 'note', actor: 'system', text: `${p.name}'s action ${JSON.stringify(raw)} failed: ${e.message}` });
          }
          if (a.type === 'endGame') break;
        }
        if (automated && myTurn() && attempt < maxAsks - 1) {
          const drew = shedding && st.hand.drew && !rejected.length;
          feedback = rejected.length ? rejected.join(' ')
            : drew ? `You drew ${cardDef(project, st, st.hand.drawn)?.name} (${st.hand.drawn}). Play it now, or pass with {"type":"endTurn"}.`
              : 'You did not make a legal move.';
          aiBusy = { message: drew ? `${p.name} drew a card - asking whether to play it…` : `${p.name}'s move was not legal - asking again…`, cancel: null };
          drawSide();
          continue;
        }
        break;
      }
      act({ type: 'assess', winConfidence: numOrNull(parsed.winConfidence), experience: parsed.experience || '' });
      if (parsed.designerNotes) act({ type: 'note', text: `Designer feedback: ${parsed.designerNotes}`, kind: 'feedback' });
      if (shedding) {
        if (myTurn() && legalMoves(project, st, p.id).canDraw) {
          act({ type: 'note', actor: 'system', text: `${p.name} did not make a legal move; the harness draws a card for them.` });
          act({ type: 'draw' });
        }
        if (myTurn() && legalMoves(project, st, p.id).canPass) {
          act({ type: 'note', actor: 'system', text: `${p.name} passes (harness).` });
          act({ type: 'endTurn' });
        }
      } else if (tricks) {
        if (myTurn()) {
          const lm = legalMoves(project, st, p.id);
          const card = lm.legal[Math.floor(Math.random() * lm.legal.length)];
          act({ type: 'note', actor: 'system', text: `${p.name} did not make a legal play; the harness played ${cardDef(project, st, card)?.name} for them.` });
          act({ type: 'move', card, to: lm.target });
        }
      } else if (st.status === 'playing' && activePlayer(st).id === p.id) {
        if (!endRequested) act({ type: 'note', actor: 'system', text: `${p.name} did not end their turn; ending it.` });
        act({ type: 'endTurn' });
      }
      persist();
    } catch (e) {
      if (e.message !== 'Cancelled') toast(e.message, 'error', 7000);
      if (view.auto && e.message !== 'Cancelled') { view.auto = false; saveView(); }
    } finally {
      aiBusy = null;
      render();
    }
  }

  function manualPrompt(prompt, p) {
    return new Promise((resolve, reject) => {
      const full = `${prompt.system}\n\n---\n\n${prompt.user}`;
      const out = h('textarea', { rows: 8, placeholder: 'Paste the AI\'s JSON reply here' });
      modal(`Prompt for ${p.name}`, h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'Copy this into any chatbot (e.g. Claude.ai), then paste its JSON reply below.'),
        h('textarea', { rows: 12, readonly: true, class: 'mono', value: full }),
        h('button', { class: 'btn small', onclick: () => navigator.clipboard.writeText(full).then(() => toast('Copied')) }, 'Copy prompt'),
        out), [
        { label: 'Cancel', onClick: () => reject(new Error('Cancelled')) },
        { label: 'Apply reply', kind: 'primary', onClick: () => { if (!out.value.trim()) return false; resolve(out.value); return true; } },
      ], { wide: true });
    });
  }

  // ------------------------------------------------------------ toolbar
  function drawToolbar() {
    toolbarEl.replaceChildren(
      h('div', { class: 'row gap wrap' },
        h('a', { class: 'btn small', href: `#/p/${project.id}/play`, onclick: async (e) => { e.preventDefault(); await persist.flush(); session = null; st = null; drawSetup(); window.history.replaceState(null, '', `#/p/${project.id}/play`); } }, '← Sessions'),
        h('label', { class: 'inline' }, 'View ',
          h('select', { value: view.mode, onchange: (e) => { view.mode = e.target.value; saveView(); render(); } },
            h('option', { value: 'overhead' }, 'Overhead: all hands visible'),
            h('option', { value: 'hotseat' }, 'Hotseat: active player\'s hand only'),
            h('option', { value: 'seat' }, 'Single seat: one player\'s view'))),
        view.mode === 'seat' ? h('select', { value: viewer(), onchange: (e) => { view.seat = e.target.value; saveView(); render(); } },
          st.players.map((p) => h('option', { value: p.id }, p.name))) : null,
        h('label', { class: 'inline', title: 'Put the viewing seat at the bottom of the screen' },
          h('input', { type: 'checkbox', checked: view.rotate, onchange: (e) => { view.rotate = e.target.checked; saveView(); render(); } }), ' Viewer at bottom'),
        isAutomated(project) ? h('span', { class: 'inline small pause-opts', title: 'Pause points: the game waits for Next' }, 'Pause after: ',
          isTricks(project) ? h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: !!st.options?.pauseTricks, onchange: (e) => { st.options.pauseTricks = e.target.checked; persist(); } }), ' tricks ') : null,
          h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: !!st.options?.pauseHands, onchange: (e) => { st.options.pauseHands = e.target.checked; persist(); } }), isShedding(project) ? ' rounds' : ' hands')) : null,
        h('label', { class: 'inline' }, 'Card size ',
          h('input', { type: 'range', min: 50, max: 130, value: view.size, oninput: (e) => { view.size = +e.target.value; saveView(); tableEl.style.setProperty('--cw', view.size + 'px'); } }))),
      h('div', { class: 'row gap' },
        h('span', { class: 'muted small' }, `Seed ${st.seed}`),
        h('button', { class: 'btn small', onclick: () => download(`${project.name.replace(/[^\w-]+/g, '_')}-session.json`, JSON.stringify({ project, session: { ...session, state: st } }, null, 1)) }, 'Export session'),
        h('button', { class: 'btn small', onclick: () => { persist.flush(); toast('Saved'); } }, 'Save')));
  }

  // ------------------------------------------------------------ table
  function drawTable() {
    tableEl.style.setProperty('--cw', view.size + 'px');
    const n = st.players.length;
    const layout = LAYOUT[n] || LAYOUT[6];
    const base = view.rotate ? (viewer() ? player(st, viewer()).seat : 0) : 0;
    const seatAt = (k) => st.players[(base + k) % n];
    const seatsFor = (side) => (layout[side] || []).map((k) => seatEl(seatAt(k), side));
    const shared = st.zoneOrder.filter((z) => !st.zones[z].owner);
    tableEl.replaceChildren(
      h('div', { class: 'table-row top' }, seatsFor('top')),
      h('div', { class: 'table-row mid' },
        layout.left ? h('div', { class: 'table-side' }, seatsFor('left')) : null,
        h('div', { class: 'felt' }, shared.map((zid) => zoneEl(zid)), feltBanner()),
        layout.right ? h('div', { class: 'table-side' }, seatsFor('right')) : null),
      h('div', { class: 'table-row bottom' }, seatsFor('bottom')));
  }

  // Pause and game-over messages shown in the middle of the table.
  function feltBanner() {
    const cname = (u) => cardDef(project, st, u)?.name || u;
    if (st.status === 'ended') {
      const names = (st.result?.winners || []).map((w) => player(st, w)?.name);
      const team = names.length && teamOf(st, st.result.winners[0]);
      const rows = competitors(st).map((c) => ({ c, counters: player(st, c.rep).counters }))
        .sort((a, b) => (b.counters[project.counters[0]?.id] ?? 0) - (a.counters[project.counters[0]?.id] ?? 0));
      return h('div', { class: 'felt-banner gameover' },
        h('h2', {}, 'Game over'),
        h('p', { class: 'big' }, names.length ? `${team ? team.name.split(' (')[0] + ' - ' : ''}${names.join(' & ')} win${names.length > 1 ? '' : 's'}!` : 'No winner recorded'),
        st.result?.reason ? h('p', { class: 'muted' }, st.result.reason) : null,
        h('table', { class: 'mini-table standings' },
          h('thead', {}, h('tr', {}, h('th', {}, st.teams.length ? 'Team' : 'Player'), project.counters.map((c) => h('th', {}, c.name)))),
          h('tbody', {}, rows.map(({ c, counters }) => h('tr', { class: st.result?.winners?.includes(c.rep) ? 'win' : '' },
            h('td', {}, c.name), project.counters.map((k) => h('td', {}, counters[k.id] ?? 0)))))),
        h('p', { class: 'muted small' }, `${st.handsPlayed ? `${st.handsPlayed} ${isShedding(project) ? 'round' : 'hand'}(s), ` : ''}${st.turn.number} turns.`),
        h('div', { class: 'row gap wrap center' },
          h('button', { class: 'btn primary', onclick: playAgain }, 'Play again ▶'),
          h('button', { class: 'btn', onclick: backToSetup }, 'Change players…'),
          h('button', { class: 'btn', onclick: () => { sideTab = 'insights'; drawSide(); } }, 'See insights')));
    }
    const P = st.pending;
    if (!P) return null;
    if (P.type === 'trick') {
      return h('div', { class: 'felt-banner low' },
        h('p', { class: 'big' }, `Trick ${P.number}: ${player(st, P.winner).name} wins with ${cname(P.winningCard)}`),
        teamOf(st, P.winner) ? h('p', { class: 'muted small' }, `${teamOf(st, P.winner).name.split(' (')[0]} takes the trick.`) : null,
        h('button', { class: 'btn primary', onclick: continuePlay }, 'Next trick ▶'));
    }
    const L = st.lastHand;
    const noun = isShedding(project) ? 'round' : 'hand';
    return h('div', { class: 'felt-banner' },
      h('p', { class: 'big' }, isShedding(project) && L?.winner ? `Round ${L.number}: ${player(st, L.winner).name} went out!` : `End of ${noun} ${L?.number ?? ''}`),
      L ? h('table', { class: 'mini-table standings' },
        h('thead', {}, h('tr', {}, h('th', {}, st.teams.length ? 'Team' : 'Player'), L.tricks ? h('th', {}, 'Tricks') : null,
          project.counters.map((c) => h('th', {}, `${c.name} (+)`)))),
        h('tbody', {}, L.changes.map((ch) => h('tr', {},
          h('td', {}, ch.name), L.tricks ? h('td', {}, L.tricks[ch.id]) : null,
          project.counters.map((c) => h('td', {}, `${ch.totals[c.id] ?? 0}`, ch.deltas[c.id] ? h('span', { class: 'delta' }, ` (+${ch.deltas[c.id]})`) : null)))))) : null,
      L?.scoreLines?.length ? h('ul', { class: 'score-why' }, L.scoreLines.map((t) => h('li', {}, t.replace(/^Score: /, '')))) : h('p', { class: 'muted small' }, 'No points scored this time.'),
      h('button', { class: 'btn primary', onclick: continuePlay }, `Deal next ${noun} ▶`));
  }

  function colourHex(colour) {
    const S = project.automation.shedding;
    return project.cards.find((c) => String(c.stats?.[S.colourStat]) === colour)?.color || '#888';
  }

  function seatEl(p, side) {
    const active = activePlayer(st).id === p.id;
    const zones = st.zoneOrder.filter((z) => st.zones[z].owner === p.id);
    const hand = zones.find((z) => st.zones[z].defId === 'hand');
    const others = zones.filter((z) => z !== hand);
    const winner = st.result?.winners?.includes(p.id);
    const team = teamOf(st, p.id);
    const auto = automation(project).autoScore && automation(project).scoring.length;
    return h('div', { class: `seat side-${side} ${active ? 'active' : ''} ${winner ? 'winner' : ''}` },
      h('div', { class: 'seat-head' },
        h('span', { class: 'seat-name' }, active ? '▶ ' : '', p.name, winner ? ' 🏆' : ''),
        st.hand && st.dealer === p.seat ? h('span', { class: 'dealer-chip', title: 'Dealer' }, 'Dealer') : null,
        isShedding(project) && st.status === 'playing' && st.zones[`${p.id}.hand`]?.cards.length === 1 ? h('span', { class: 'lastcard-chip' }, 'Last card!') : null,
        st.announce?.pid === p.id ? h('span', { class: 'announce-chip', title: 'Announced this turn' }, `📣 ${st.announce.ids.map((id) => announcementRules(project).find((r) => r.id === id)?.label || id).join(', ')}`) : null,
        st.catchable?.pid === p.id ? h('span', { class: 'missed-chip', title: 'Forgot to announce - can be caught' }, `⚠ didn't say "${st.catchable.label}"`) : null,
        team ? h('span', { class: `team-chip ${team.id}`, title: team.name }, team.name.split(' (')[0]) : null,
        h('span', { class: `ctrl ${isAI(p.controller) ? 'ai' : 'human'}`, title: CONTROLLERS[p.controller]?.label }, isAI(p.controller) ? 'AI' : 'Human'),
        h('span', { class: 'counters' },
          st.hand && isTricks(project) ? h('span', { class: 'counter', title: 'Tricks won this hand' }, 'Tricks ', h('b', {}, st.hand.tricksWon[p.id] || 0)) : null,
          project.counters.map((c) => h('span', { class: 'counter' },
            auto ? null : h('button', { class: 'mini', title: `-1 ${c.name}`, onclick: () => commit({ type: 'counter', player: p.id, counter: c.id, delta: -1, actor: 'designer' }) }, '−'),
            h('span', { title: auto ? `${c.name} (scored automatically)` : c.name }, `${c.name} `, h('b', {}, p.counters[c.id] ?? 0)),
            auto ? null : h('button', { class: 'mini', title: `+1 ${c.name}`, onclick: () => commit({ type: 'counter', player: p.id, counter: c.id, delta: 1, actor: 'designer' }) }, '+'))))),
      h('div', { class: 'seat-zones' }, hand ? zoneEl(hand, true) : null, others.map((z) => zoneEl(z, true))));
  }

  function zoneEl(zid, inSeat = false) {
    const z = st.zones[zid];
    const def = zoneDef(project, z.defId) || {};
    const layout = def.layout || 'spread';
    const label = inSeat ? def.name : z.name;
    const el = h('div', {
      class: `zone layout-${layout} ${inSeat ? 'in-seat' : ''}`,
      dataset: { zone: zid },
      ondragover: (e) => { e.preventDefault(); el.classList.add('drop'); },
      ondragleave: () => el.classList.remove('drop'),
      ondrop: (e) => {
        e.preventDefault();
        el.classList.remove('drop');
        const card = e.dataTransfer.getData('text/card');
        const lm = legalNow();
        if (card && lm && zid === lm.target && st.cards[card]?.zone === `${lm.pid}.hand`) playCard(card);
        else if (card && st.cards[card]?.zone !== zid) commit({ type: 'move', card, to: zid });
      },
    });
    const head = h('div', { class: 'zone-head' }, h('span', {}, label), h('span', { class: 'count' }, z.cards.length));
    const tricks = isTricks(project);
    if (tricks && st.hand && z.defId === automation(project).tricks.zone) {
      const who = Object.fromEntries(st.hand.trick.map((t) => [t.card, player(st, t.pid).name]));
      el.classList.add('trick-zone');
      el.append(head, h('div', { class: 'cards' }, z.cards.length
        ? z.cards.map((c) => h('div', { class: `trick-play ${st.pending?.type === 'trick' && st.pending.winningCard === c ? 'winning' : ''}` }, cardEl(c), h('span', { class: 'trick-who' }, who[c] || '')))
        : h('div', { class: 'empty-hint' }, st.status === 'playing' ? `${activePlayer(st).name} to lead` : 'empty')));
      return el;
    }
    const automated = isAutomated(project);
    if (layout === 'stack' && !automated) {
      head.append(
        h('button', { class: 'mini', title: `Active player draws 1 from ${z.name}`, disabled: !z.cards.length, onclick: () => commit({ type: 'draw', from: zid, count: 1 }) }, 'Draw'),
        h('button', { class: 'mini', title: 'Shuffle', disabled: z.cards.length < 2, onclick: () => commit({ type: 'shuffle', zone: zid }) }, '⤮'));
      const top = z.cards[z.cards.length - 1];
      el.append(head, h('div', { class: 'cards' },
        top ? h('div', { class: 'pile', style: { '--depth': Math.min(6, Math.ceil(z.cards.length / 6)) } }, cardEl(top)) : h('div', { class: 'card empty-slot' })));
    } else if (layout === 'stack') {
      const top = z.cards[z.cards.length - 1];
      const isDiscard = isShedding(project) && st.hand && zid === project.automation.shedding.discardZone;
      el.append(head, h('div', { class: 'cards' },
        top ? h('div', { class: 'pile', style: { '--depth': Math.min(6, Math.ceil(z.cards.length / 6)) } }, cardEl(top)) : h('div', { class: 'card empty-slot' })));
      if (isDiscard && st.hand.colour) el.append(h('div', { class: 'colour-chip', style: { background: colourHex(st.hand.colour) } }, `Colour: ${st.hand.colour}`));
    } else {
      const cards = layout === 'hand' && automated ? sortHand(z.cards) : z.cards;
      el.append(head, h('div', { class: `cards ${layout === 'hand' && cards.length > 8 ? 'many' : ''}` }, cards.length ? cards.map((c) => cardEl(c)) : h('div', { class: 'empty-hint' }, 'empty')));
    }
    return el;
  }

  // Display order for automated games' hands: by suit/colour, then rank/value.
  function sortHand(cards) {
    const A = automation(project);
    const shed = isShedding(project);
    const groupStat = shed ? A.shedding.colourStat : A.tricks.suitStat;
    const valueStat = shed ? A.shedding.valueStat : A.tricks.rankStat;
    const order = shed ? shedColours(project) : SUITS.map((x) => x.name);
    const key = (u) => {
      const stats = cardDef(project, st, u)?.stats || {};
      const si = order.indexOf(String(stats[groupStat]));
      const v = Number(stats[valueStat]);
      return [si < 0 ? 99 : si, String(stats[groupStat] ?? ''), shed ? (Number.isFinite(v) ? v : 50) : -(v || 0)];
    };
    return cards.slice().sort((a, b) => {
      const ka = key(a); const kb = key(b);
      return ka[0] - kb[0] || ka[1].localeCompare(kb[1]) || ka[2] - kb[2];
    });
  }

  function legalNow() {
    return st.status === 'playing' ? legalMoves(project, st, activePlayer(st).id) : null;
  }

  function playCard(cuid) {
    const lm = legalNow();
    if (!lm) return;
    const actor = activePlayer(st);
    if (isShedding(project) && cardEffects(project, st, cuid).wild && !lm.cards[cuid] && !isAI(actor.controller)) {
      // Ask which colour to follow.
      const dlg = modal('Choose a colour', h('div', { class: 'colour-picker' }, lm.colours.map((c) => h('button', {
        class: 'btn colour-btn', style: { background: colourHex(c) },
        onclick: () => { dlg.close(); commit({ type: 'move', card: cuid, to: lm.target, choose: c }); },
      }, c))), [{ label: 'Cancel' }]);
      return;
    }
    commit({ type: 'move', card: cuid, to: lm.target });
  }

  function cardEl(cuid) {
    const def = cardDef(project, st, cuid);
    const face = canSeeFace(cuid) && def;
    const el = face ? cardFace(def) : cardBack(project);
    el.classList.add('table-card');
    if (selected === cuid) el.classList.add('selected');
    el.draggable = true;
    el.dataset.card = cuid;
    const lm = legalNow();
    const inActiveHand = lm && st.cards[cuid].zone === `${lm.pid}.hand`;
    if (inActiveHand && face && automation(project).enforce !== 'off') {
      const why = lm.cards[cuid];
      el.classList.add(why ? 'illegal' : 'legal');
      el.title = why || 'Legal play - double-click to play it';
    }
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/card', cuid); e.dataTransfer.effectAllowed = 'move'; });
    el.addEventListener('click', (e) => { e.stopPropagation(); selected = cuid; sideTab = 'card'; drawTable(); drawSide(); });
    el.addEventListener('dblclick', () => (inActiveHand ? playCard(cuid) : commit({ type: 'flip', card: cuid })));
    return el;
  }

  // ------------------------------------------------------------ sidebar
  function drawSide() {
    const tabs = [['card', 'Card'], ['log', 'Log'], ['insights', 'Insights'], ['rules', 'Rules']];
    const body = { card: inspector, log: logPanel, insights: insightsPanel, rules: rulesPanel }[sideTab]();
    sideEl.replaceChildren(turnPanel(),
      h('div', { class: 'side-tabs' }, tabs.map(([id, l]) => h('button', { class: sideTab === id ? 'active' : '', onclick: () => { sideTab = id; drawSide(); } }, l))),
      h('div', { class: 'side-body' }, body));
  }

  function turnPanel() {
    const p = activePlayer(st);
    const phases = project.turn.phases || [];
    if (st.status === 'ended') {
      const names = (st.result?.winners || []).map((w) => player(st, w)?.name).join(' & ') || 'no winner recorded';
      return h('div', { class: 'turn-panel ended' },
        h('h3', {}, 'Game over'),
        h('p', {}, `Winner: ${names}`), st.result?.reason ? h('p', { class: 'muted' }, st.result.reason) : null,
        h('div', { class: 'row gap wrap' },
          h('button', { class: 'btn small primary', onclick: playAgain }, 'Play again'),
          h('button', { class: 'btn small', onclick: undo }, 'Undo'),
          h('button', { class: 'btn small', onclick: () => { sideTab = 'insights'; drawSide(); } }, 'See insights'),
          h('button', { class: 'btn small', onclick: backToSetup }, 'Change players…')));
    }
    if (st.pending) {
      const trick = st.pending.type === 'trick';
      return h('div', { class: 'turn-panel paused' },
        h('div', { class: 'turn-line' }, h('strong', {}, 'Paused'),
          h('span', { class: 'muted small' }, trick ? 'The trick stays on the table until you continue.' : `Scores for the last ${isShedding(project) ? 'round' : 'hand'} are shown on the table.`)),
        h('div', { class: 'row gap wrap' },
          h('button', { class: 'btn primary', onclick: continuePlay, title: 'Enter' }, trick ? 'Next trick ▶' : `Deal next ${isShedding(project) ? 'round' : 'hand'} ▶`),
          h('button', { class: 'btn', onclick: undo, title: 'Ctrl+Z' }, 'Undo')));
    }
    const ai = isAI(p.controller);
    const tricks = isTricks(project) && st.hand;
    const shedding = isShedding(project) && st.hand;
    const automated = tricks || shedding;
    const lm = legalNow();
    const H = st.hand;
    const sym = (suit) => SUITS.find((x) => x.name === suit)?.symbol || '';
    const cname = (u) => cardDef(project, st, u)?.name || u;
    return h('div', { class: 'turn-panel' },
      h('div', { class: 'turn-line' }, h('span', { class: 'muted' }, tricks
        ? `Hand ${H.number} · trick ${H.tricksPlayed + 1}`
        : shedding ? `Round ${H.number} · turn ${st.turn.number}`
          : `Turn ${st.turn.number} · round ${Math.floor((st.turn.number - 1) / st.players.length) + 1}`),
        h('strong', {}, p.name), h('span', { class: `ctrl ${ai ? 'ai' : 'human'}` }, CONTROLLERS[p.controller]?.label || p.controller)),
      tricks ? h('div', { class: 'trick-facts' },
        h('span', { class: `trump ${['Hearts', 'Diamonds'].includes(H.trump) ? 'red' : ''}` }, H.trump ? `Trumps ${sym(H.trump)} ${H.trump}` : 'No trumps'),
        H.trumpCard ? h('span', { class: 'muted small' }, `(${cname(H.trumpCard)} turned up)`) : null,
        h('span', { class: 'muted small' }, `Dealer: ${st.players[st.dealer].name}`),
        H.led ? h('span', { class: 'muted small' }, `Led: ${sym(H.led)} ${H.led}`) : null) : null,
      shedding ? h('div', { class: 'trick-facts' },
        h('span', { class: 'colour-chip inline-chip', style: { background: colourHex(H.colour) } }, `Colour: ${H.colour}`),
        shedTop(project, st) ? h('span', { class: 'muted small' }, `Top: ${cname(shedTop(project, st))}`) : null,
        h('span', { class: 'muted small' }, st.dir === 1 ? 'Direction: ⟳ normal' : 'Direction: ⟲ reversed'),
        h('span', { class: 'muted small' }, `Draw pile: ${st.zones[project.automation.shedding.drawZone]?.cards.length ?? 0}`)) : null,
      lm ? h('div', { class: 'you-can' }, h('b', {}, `${p.name}: `), lm.summary,
        ai ? null : h('span', { class: 'muted small' }, ' Legal cards are outlined in green - double-click one, or select it and press Play.')) : null,
      tricks && st.lastTrick ? h('div', { class: 'last-trick small' },
        `Last trick: ${player(st, st.lastTrick.winner).name} won with ${cname(st.lastTrick.winningCard)} - `,
        st.lastTrick.plays.map((t) => `${player(st, t.pid).name} ${cname(t.card)}`).join(', ')) : null,
      phases.length ? h('div', { class: 'phases' }, phases.map((ph, i) => h('span', { class: `phase ${i === st.turn.phase ? 'current' : i < st.turn.phase ? 'done' : ''}`, title: ph.description }, ph.name))) : null,
      catchBox(),
      aiBusy ? h('div', { class: 'ai-busy' }, h('span', { class: 'spinner' }), h('span', {}, aiBusy.message),
        aiBusy.cancel ? h('button', { class: 'btn small', onclick: () => aiBusy.cancel() }, 'Cancel') : null) : null,
      h('div', { class: 'row gap wrap' },
        ai ? h('button', { class: 'btn primary', disabled: !!aiBusy, onclick: runAiTurn }, `▶ Play ${p.name}'s turn`) : null,
        phases.length > 1 && !automated ? h('button', { class: 'btn', disabled: !!aiBusy || st.turn.phase >= phases.length - 1, onclick: () => commit({ type: 'phase' }) }, 'Next phase') : null,
        shedding && !ai && lm?.canDraw ? h('button', { class: `btn ${lm.legal.length ? '' : 'primary'}`, onclick: () => commit({ type: 'draw' }) }, lm.takeCount ? `Take ${lm.takeCount} cards` : 'Draw a card') : null,
        !ai && st.status === 'playing' ? announcementRules(project).map((r) => {
          const said = st.announce?.pid === p.id && st.announce.ids.includes(r.id);
          return h('button', {
            class: `btn announce-btn ${said ? 'said' : ''}`, disabled: said,
            title: said ? 'Announced - it counts for your next play' : `Say "${r.label}" (counts for your next play this turn)`,
            onclick: () => commit({ type: 'announce', id: r.id }),
          }, said ? `📣 "${r.label}" ✓` : `📣 Say "${r.label}"`);
        }) : null,
        shedding && !ai && lm?.canPass ? h('button', { class: 'btn', onclick: () => commit({ type: 'endTurn' }) }, 'Pass') : null,
        automated ? null : h('button', { class: `btn ${ai ? '' : 'primary'}`, disabled: !!aiBusy, onclick: () => commit({ type: 'endTurn' }) }, 'End turn ⏎'),
        h('button', { class: 'btn', disabled: !!aiBusy, onclick: undo, title: 'Ctrl+Z' }, 'Undo'),
        h('button', { class: 'btn', disabled: !!aiBusy, onclick: endGameDialog, title: 'End the game now (as the referee)' }, 'End game…')),
      h('label', { class: 'inline small' },
        h('input', { type: 'checkbox', checked: view.auto, onchange: (e) => { view.auto = e.target.checked; saveView(); scheduleAuto(); } }),
        ' Auto-play AI seats (stops at human seats)'));
  }

  function catchBox() {
    const C = st.catchable;
    if (!C || st.status !== 'playing') return null;
    const target = player(st, C.pid);
    const humans = st.players.filter((x) => x.id !== C.pid && !isAI(x.controller));
    const rule = announcementRules(project).find((r) => r.id === C.id);
    const pen = rule && parseInt(rule.penaltyDraw, 10) > 0 ? ` (+${rule.penaltyDraw} cards)` : '';
    return h('div', { class: 'catch-box' },
      h('b', {}, `⚠ ${target.name} didn't say "${C.label}"!`),
      h('span', { class: 'muted small' }, ' Catch them before the next player acts.'),
      h('div', { class: 'row gap wrap' },
        humans.length
          ? humans.map((x) => h('button', { class: 'btn small catch-btn', onclick: () => commit({ type: 'catch', actor: x.id }) }, `Catch!${pen} - as ${x.name}`))
          : h('button', { class: 'btn small catch-btn', onclick: () => commit({ type: 'catch', actor: 'designer' }) }, `Catch${pen} (referee)`)));
  }

  function inspector() {
    if (!selected || !st.cards[selected]) return h('p', { class: 'muted pad' }, 'Click a card to inspect it. Drag cards between zones to move them; double-click to flip. Actions are taken as the active player.');
    const c = st.cards[selected];
    const def = cardDef(project, st, selected);
    const visible = canSeeFace(selected);
    const z = st.zones[c.zone];
    const me = activePlayer(st);
    const target = h('select', {}, st.zoneOrder.map((zid) => h('option', { value: zid, selected: false }, st.zones[zid].name)));
    const quick = [
      [`${me.name}'s hand`, `${me.id}.hand`],
      ...st.zoneOrder.filter((zid) => !st.zones[zid].owner).map((zid) => [st.zones[zid].name, zid]),
    ].filter(([, zid]) => st.zones[zid] && zid !== c.zone);
    const lm = legalNow();
    const playable = lm && c.zone === `${lm.pid}.hand` && visible;
    const why = playable ? lm.cards[selected] : '';
    const strict = automation(project).enforce === 'strict';
    const playBox = playable ? h('div', { class: 'play-box' },
      h('button', { class: 'btn primary', disabled: !!why && strict, onclick: () => playCard(selected) }, `Play ${def.name} ▶`),
      why ? h('p', { class: 'warn-box small' }, `Not allowed: ${why}`) : h('p', { class: 'muted small' }, 'This is a legal play.'),
      ...announcementsDue(project, st, lm.pid, selected).map((id) => announcementRules(project).find((r) => r.id === id))
        .filter((r) => r?.remind).map((r) => h('p', { class: 'small announce-hint' }, `📣 Playing this means you must say "${r.label}" first.`))) : null;
    const tools = h('div', { class: 'stack' },
      h('span', { class: 'field-label' }, `Move (as ${me.name})`),
      h('div', { class: 'row gap wrap' }, quick.map(([label, zid]) => h('button', { class: 'btn small', onclick: () => commit({ type: 'move', card: selected, to: zid }) }, '→ ' + label))),
      h('div', { class: 'row gap' }, target, h('button', { class: 'btn small', onclick: () => commit({ type: 'move', card: selected, to: target.value }) }, 'Move')),
      h('button', { class: 'btn small', onclick: () => commit({ type: 'flip', card: selected }) }, 'Flip'));
    return h('div', { class: 'inspector' },
      h('div', { class: 'inspect-card' }, visible ? cardFace(def, { size: 200 }) : cardBack(project, { size: 200 })),
      playBox,
      visible ? h('div', { class: 'card-details' },
        h('h3', {}, def.name),
        def.description ? h('p', { class: 'muted' }, def.description) : null,
        def.rules ? h('p', {}, def.rules) : null,
        Object.keys(def.stats || {}).length ? h('p', { class: 'small' }, Object.entries(def.stats).map(([k, v]) => `${k}: ${v}`).join(' · ')) : null)
        : h('p', { class: 'muted' }, 'Face down / hidden from this view.'),
      h('p', { class: 'small muted' }, `${selected} · in ${z.name} · ${c.faceUp ? 'face up' : 'face down'}`),
      isAutomated(project) ? h('details', { class: 'referee' }, h('summary', {}, 'Referee tools (move or flip any card)'), tools) : tools);
  }

  function logPanel() {
    const note = h('input', { type: 'text', placeholder: 'Add a playtest note (what you noticed right now)…' });
    const addNote = () => { if (note.value.trim()) { commit({ type: 'note', actor: 'designer', text: note.value.trim() }); } };
    note.addEventListener('keydown', (e) => { if (e.key === 'Enter') addNote(); });
    const full = view.mode === 'overhead';
    return h('div', { class: 'log' },
      h('div', { class: 'row gap' }, note, h('button', { class: 'btn small', onclick: addNote }, 'Note')),
      full ? null : h('p', { class: 'muted small' }, 'Showing the public log for this view (hidden information redacted).'),
      h('ol', { class: 'log-list', reversed: true }, st.log.slice().reverse().map((e) => h('li', { class: `log-${e.type} ${e.data?.kind ? 'kind-' + e.data.kind : ''} actor-${e.actor}` },
        h('span', { class: 'log-turn' }, `t${e.turn}`), full ? e.text : e.publicText))));
  }

  function insightsPanel() {
    const out = h('div', { class: 'insights' });
    if (!st.timeline.length) out.append(h('p', { class: 'muted' }, 'Insights appear after the first turn ends.'));
    for (const c of project.counters) {
      const stats = leadStats(st, c.id);
      out.append(h('h3', {}, c.name), lineChart(c.id),
        h('ul', { class: 'facts' },
          h('li', {}, `Lead changes: `, h('b', {}, stats.changes)),
          stats.leader ? h('li', {}, `Current leader: `, h('b', {}, competitorName(st, stats.leader)), stats.lastChangeTurn ? ` (since turn ${stats.lastChangeTurn})` : '') : null));
    }
    if (st.assessments.length) {
      out.append(h('h3', {}, 'AI seats: how they feel'),
        h('table', { class: 'mini-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Turn'), h('th', {}, 'Seat'), h('th', {}, 'Win %'), h('th', {}, 'Experience'))),
          h('tbody', {}, st.assessments.slice(-12).reverse().map((a) => h('tr', {},
            h('td', {}, a.turn), h('td', {}, player(st, a.player)?.name), h('td', {}, a.winConfidence ?? '-'), h('td', {}, a.experience))))));
      const lost = st.players.map((p) => ({ p, low: st.assessments.filter((a) => a.player === p.id && a.winConfidence != null && a.winConfidence <= 10).length }))
        .filter((x) => x.low >= 3);
      if (lost.length) out.append(h('p', { class: 'warn-box' }, `Possible "known loser" problem: ${lost.map((x) => `${x.p.name} rated their chances at 10% or less on ${x.low} turns`).join('; ')}.`));
    }
    const rules = announcementRules(project);
    if (rules.length) {
      out.append(h('h3', {}, 'Announcements'),
        h('table', { class: 'mini-table' },
          h('thead', {}, h('tr', {}, ['Player', 'Said', 'Missed', 'Caught', 'Catches', 'Unneeded'].map((t) => h('th', {}, t)))),
          h('tbody', {}, rules.flatMap((r) => st.players.map((x) => {
            const a = st.annStats?.[x.id]?.[r.id] || {};
            return h('tr', {}, h('td', {}, rules.length > 1 ? `${x.name} - ${r.label}` : x.name),
              ['made', 'missed', 'caught', 'catches', 'unnecessary'].map((k) => h('td', {}, a[k] || 0)));
          })))));
    }
    const feedback = st.log.filter((e) => e.data?.kind === 'feedback' || e.actor === 'designer');
    if (feedback.length) out.append(h('h3', {}, 'Notes & feedback'), h('ul', { class: 'facts' }, feedback.map((e) => h('li', {}, h('span', { class: 'log-turn' }, `t${e.turn}`), e.text))));
    return out;
  }

  function lineChart(counterId) {
    const pts = st.timeline;
    if (pts.length < 1) return h('div');
    const W = 300; const H = 120; const pad = 22;
    const vals = pts.flatMap((t) => Object.values(t.counters).map((c) => c[counterId] ?? 0));
    const min = Math.min(0, ...vals); const max = Math.max(1, ...vals);
    const x = (i) => pad + (pts.length === 1 ? 0 : (i * (W - pad - 6)) / (pts.length - 1));
    const y = (v) => H - pad - ((v - min) * (H - pad - 8)) / (max - min || 1);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'chart');
    const add = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; svg.append(e); return e; };
    add('line', { x1: pad, y1: H - pad, x2: W - 4, y2: H - pad, class: 'axis' });
    add('text', { x: 2, y: y(max) + 4, class: 'tick' }, max);
    add('text', { x: 2, y: H - pad + 4, class: 'tick' }, min);
    add('text', { x: W - 4, y: H - 6, class: 'tick', 'text-anchor': 'end' }, `turn ${pts[pts.length - 1].turn}`);
    const legend = h('div', { class: 'legend' });
    competitors(st).forEach((c, i) => {
      const color = `var(--series-${(i % 6) + 1})`;
      const d = pts.map((t, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)},${y(t.counters[c.rep]?.[counterId] ?? 0).toFixed(1)}`).join(' ');
      add('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' });
      legend.append(h('span', {}, h('i', { style: { background: color } }), c.name));
    });
    return h('div', { class: 'chart-wrap' }, svg, legend);
  }

  function rulesPanel() {
    const r = project.rules;
    const sec = (t, b) => (b ? [h('h4', {}, t), h('p', { class: 'pre' }, b)] : null);
    const autoLines = describeAutomation(project);
    return h('div', { class: 'rules-ref' },
      h('h4', {}, 'Automated by the test bench'),
      h('ul', { class: 'auto-list' }, autoLines.map((l) => h('li', { class: l.startsWith('  ') ? 'sub' : '' }, l.trim()))),
      sec('Objective', r.objective),
      project.turn.phases.length ? [h('h4', {}, 'Phases'), h('ol', {}, project.turn.phases.map((p) => h('li', {}, h('b', {}, p.name), p.description ? ` - ${p.description}` : '')))] : null,
      sec('On your turn', r.turnRules), sec('End of game', r.endGame), sec('Scoring', r.scoring),
      !r.objective && !r.turnRules ? h('p', { class: 'muted' }, 'No rulebook text yet - add it in Rules & setup.') : null);
  }

  function endGameDialog() {
    const boxes = st.players.map((p) => ({ p, box: h('input', { type: 'checkbox' }) }));
    const reason = h('input', { type: 'text', placeholder: 'e.g. Draw pile ran out; highest score' });
    modal('End game', h('div', { class: 'stack' },
      h('span', { class: 'field-label' }, 'Winner(s)'),
      boxes.map(({ p, box }) => h('label', { class: 'inline' }, box, ` ${p.name} (${Object.entries(p.counters).map(([k, v]) => `${k} ${v}`).join(', ')})`)),
      field('Reason', reason)), [
      { label: 'Cancel' },
      { label: 'End game', kind: 'primary', onClick: () => { commit({ type: 'endGame', winner: boxes.filter((b) => b.box.checked).map((b) => b.p.id), reason: reason.value }); } },
    ]);
  }

  // ------------------------------------------------------------ keyboard
  const onKey = (e) => {
    if (!st || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.querySelector('.modal-overlay')) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    else if (e.key === 'Enter' && st.pending) continuePlay();
    else if (e.key === 'Enter' && !aiBusy && st.status === 'playing' && !isAI(activePlayer(st).controller) && !isAutomated(project)) commit({ type: 'endTurn' });
    else if (e.key === 'Escape') { selected = null; drawTable(); drawSide(); }
  };
  document.addEventListener('keydown', onKey);
  const onHide = () => persist.flush();
  window.addEventListener('pagehide', onHide);

  return () => {
    disposed = true;
    clearTimeout(autoTimer);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('pagehide', onHide);
    aiBusy?.cancel?.();
    persist.flush();
  };
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

function hashString(s) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return x >>> 0;
}

function aiProviderNote(serverMode, info) {
  if (!serverMode) return 'No server: AI seats can use the random bot or copy/paste prompts. Run server.py for the Claude chat bridge and API providers.';
  const bits = ['Claude (chat bridge): Claude Code in your chat window answers each AI turn.'];
  bits.push(info?.anthropic?.sdkInstalled && info?.anthropic?.keySet ? `Claude API ready (${info.anthropic.model}).` : 'Claude API: needs `pip install anthropic` and ANTHROPIC_API_KEY on the server.');
  bits.push(info?.openai?.keySet && info?.openai?.model ? `OpenAI ready (${info.openai.model}).` : 'OpenAI: needs OPENAI_API_KEY and OPENAI_MODEL.');
  return bits.join(' ');
}
