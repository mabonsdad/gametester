// Playtest table: top-down view of the shared zones with 1-6 seats around
// the edge, turn controls, AI seats, log and insights.
import * as api from '../api.js';
import { CONTROLLERS, checkAction, isAI, parseResponse, requestTurn } from '../ai.js';
import { activePlayer, apply, cardDef, clone, createGame, leadStats, player } from '../engine.js';
import { uid, zoneDef } from '../model.js';
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
          field('Random seed', seedIn, 'Same seed + same actions = same game. Leave blank for a new shuffle.'),
          h('p', { class: 'muted small' }, aiProviderNote(serverMode, aiInfo)),
          h('button', {
            class: 'btn primary', disabled: !totalCards, onclick: async () => {
              const seedRaw = seedIn.value.trim();
              const seed = seedRaw ? (/^\d+$/.test(seedRaw) ? parseInt(seedRaw, 10) : hashString(seedRaw)) : undefined;
              try {
                st = createGame(project, { players: seats.slice(0, count), seed });
              } catch (e) { toast(e.message, 'error'); return; }
              session = { id: uid('s_'), name: `${project.name} - ${new Date().toLocaleString()}`, projectId: project.id, created: Date.now(), state: st };
              history = [];
              view.seat = 'p1';
              await api.saveSession(project.id, session).catch((e) => toast(e.message, 'error'));
              history_replace(session.id);
              drawGame();
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
    scheduleAuto();
  }

  // ------------------------------------------------------------ actions
  function commit(action, { quiet = false } = {}) {
    if (st.status !== 'playing' && !['note', 'counter', 'move', 'flip'].includes(action.type)) {
      toast('The game has ended.', 'warn');
      return false;
    }
    const snapshot = clone(st);
    try {
      apply(project, st, { actor: activePlayer(st).id, ...action });
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
    if (!view.auto || aiBusy || st.status !== 'playing') return;
    if (!isAI(activePlayer(st).controller)) return;
    if (activePlayer(st).controller === 'ai-manual') return; // needs a human anyway
    autoTimer = setTimeout(() => runAiTurn(), 700);
  }

  async function runAiTurn() {
    if (aiBusy || st.status !== 'playing') return;
    const p = activePlayer(st);
    if (!isAI(p.controller)) return toast(`${p.name} is a human seat.`, 'warn');
    const turnAtStart = st.turn.number;
    aiBusy = { message: `${p.name} is thinking…`, cancel: null };
    drawSide();
    try {
      const res = await requestTurn(project, st, {
        manual: manualPrompt,
        waiting: (message, cancel) => { aiBusy = { message, cancel }; drawSide(); },
      });
      if (disposed) return;
      if (st.turn.number !== turnAtStart || activePlayer(st).id !== p.id) throw new Error('The table changed while the AI was thinking; its answer was discarded.');
      const parsed = res.parsed || parseResponse(res.text);
      history.push(clone(st));
      const act = (a) => apply(project, st, { ...a, actor: a.actor || p.id });
      if (parsed.reasoning) act({ type: 'note', text: parsed.reasoning, private: true, kind: 'reasoning' });
      let ended = false;
      for (const raw of parsed.actions) {
        if (!raw || typeof raw !== 'object') continue;
        const a = { ...raw, actor: p.id };
        if (a.type === 'endTurn' || a.type === 'endGame') {
          ended = true;
          if (a.type === 'endTurn') break; // assessment is recorded before passing the turn
        }
        const problem = checkAction(project, st, p.id, a);
        if (problem) { act({ type: 'note', actor: 'system', text: `${p.name}'s action rejected: ${problem}` }); continue; }
        try { act(a); } catch (e) { act({ type: 'note', actor: 'system', text: `${p.name}'s action ${JSON.stringify(raw)} failed: ${e.message}` }); }
        if (a.type === 'endGame') break;
      }
      act({ type: 'assess', winConfidence: numOrNull(parsed.winConfidence), experience: parsed.experience || '' });
      if (parsed.designerNotes) act({ type: 'note', text: `Designer feedback: ${parsed.designerNotes}`, kind: 'feedback' });
      if (st.status === 'playing') {
        if (!ended) act({ type: 'note', actor: 'system', text: `${p.name} did not end their turn; ending it.` });
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
        h('div', { class: 'felt' }, shared.map((zid) => zoneEl(zid))),
        layout.right ? h('div', { class: 'table-side' }, seatsFor('right')) : null),
      h('div', { class: 'table-row bottom' }, seatsFor('bottom')));
  }

  function seatEl(p, side) {
    const active = activePlayer(st).id === p.id;
    const zones = st.zoneOrder.filter((z) => st.zones[z].owner === p.id);
    const hand = zones.find((z) => st.zones[z].defId === 'hand');
    const others = zones.filter((z) => z !== hand);
    const winner = st.result?.winners?.includes(p.id);
    return h('div', { class: `seat side-${side} ${active ? 'active' : ''} ${winner ? 'winner' : ''}` },
      h('div', { class: 'seat-head' },
        h('span', { class: 'seat-name' }, active ? '▶ ' : '', p.name, winner ? ' 🏆' : ''),
        h('span', { class: `ctrl ${isAI(p.controller) ? 'ai' : 'human'}`, title: CONTROLLERS[p.controller]?.label }, isAI(p.controller) ? 'AI' : 'Human'),
        h('span', { class: 'counters' }, project.counters.map((c) => h('span', { class: 'counter' },
          h('button', { class: 'mini', title: `-1 ${c.name}`, onclick: () => commit({ type: 'counter', player: p.id, counter: c.id, delta: -1 }) }, '−'),
          h('span', { title: c.name }, `${c.name} `, h('b', {}, p.counters[c.id] ?? 0)),
          h('button', { class: 'mini', title: `+1 ${c.name}`, onclick: () => commit({ type: 'counter', player: p.id, counter: c.id, delta: 1 }) }, '+'))))),
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
        if (card && st.cards[card]?.zone !== zid) commit({ type: 'move', card, to: zid });
      },
    });
    const head = h('div', { class: 'zone-head' }, h('span', {}, label), h('span', { class: 'count' }, z.cards.length));
    if (layout === 'stack') {
      head.append(
        h('button', { class: 'mini', title: `Active player draws 1 from ${z.name}`, disabled: !z.cards.length, onclick: () => commit({ type: 'draw', from: zid, count: 1 }) }, 'Draw'),
        h('button', { class: 'mini', title: 'Shuffle', disabled: z.cards.length < 2, onclick: () => commit({ type: 'shuffle', zone: zid }) }, '⤮'));
      const top = z.cards[z.cards.length - 1];
      el.append(head, h('div', { class: 'cards' },
        top ? h('div', { class: 'pile', style: { '--depth': Math.min(6, Math.ceil(z.cards.length / 6)) } }, cardEl(top)) : h('div', { class: 'card empty-slot' })));
    } else {
      el.append(head, h('div', { class: 'cards' }, z.cards.length ? z.cards.map((c) => cardEl(c)) : h('div', { class: 'empty-hint' }, 'empty')));
    }
    return el;
  }

  function cardEl(cuid) {
    const def = cardDef(project, st, cuid);
    const face = canSeeFace(cuid) && def;
    const el = face ? cardFace(def) : cardBack(project);
    el.classList.add('table-card');
    if (selected === cuid) el.classList.add('selected');
    el.draggable = true;
    el.dataset.card = cuid;
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/card', cuid); e.dataTransfer.effectAllowed = 'move'; });
    el.addEventListener('click', (e) => { e.stopPropagation(); selected = cuid; sideTab = 'card'; drawTable(); drawSide(); });
    el.addEventListener('dblclick', () => commit({ type: 'flip', card: cuid }));
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
          h('button', { class: 'btn small', onclick: undo }, 'Undo'),
          h('button', { class: 'btn small', onclick: () => { sideTab = 'insights'; drawSide(); } }, 'See insights'),
          h('button', { class: 'btn small primary', onclick: () => { session = null; st = null; drawSetup(); window.history.replaceState(null, '', `#/p/${project.id}/play`); } }, 'New game')));
    }
    const ai = isAI(p.controller);
    return h('div', { class: 'turn-panel' },
      h('div', { class: 'turn-line' }, h('span', { class: 'muted' }, `Turn ${st.turn.number} · round ${Math.floor((st.turn.number - 1) / st.players.length) + 1}`),
        h('strong', {}, p.name), h('span', { class: `ctrl ${ai ? 'ai' : 'human'}` }, CONTROLLERS[p.controller]?.label || p.controller)),
      phases.length ? h('div', { class: 'phases' }, phases.map((ph, i) => h('span', { class: `phase ${i === st.turn.phase ? 'current' : i < st.turn.phase ? 'done' : ''}`, title: ph.description }, ph.name))) : null,
      aiBusy ? h('div', { class: 'ai-busy' }, h('span', { class: 'spinner' }), h('span', {}, aiBusy.message),
        aiBusy.cancel ? h('button', { class: 'btn small', onclick: () => aiBusy.cancel() }, 'Cancel') : null) : null,
      h('div', { class: 'row gap wrap' },
        ai ? h('button', { class: 'btn primary', disabled: !!aiBusy, onclick: runAiTurn }, `▶ Play ${p.name}'s turn`) : null,
        phases.length > 1 ? h('button', { class: 'btn', disabled: !!aiBusy || st.turn.phase >= phases.length - 1, onclick: () => commit({ type: 'phase' }) }, 'Next phase') : null,
        h('button', { class: `btn ${ai ? '' : 'primary'}`, disabled: !!aiBusy, onclick: () => commit({ type: 'endTurn' }) }, 'End turn ⏎'),
        h('button', { class: 'btn', disabled: !!aiBusy, onclick: undo, title: 'Ctrl+Z' }, 'Undo'),
        h('button', { class: 'btn', disabled: !!aiBusy, onclick: endGameDialog }, 'End game…')),
      h('label', { class: 'inline small' },
        h('input', { type: 'checkbox', checked: view.auto, onchange: (e) => { view.auto = e.target.checked; saveView(); scheduleAuto(); } }),
        ' Auto-play AI seats (stops at human seats)'));
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
    return h('div', { class: 'inspector' },
      h('div', { class: 'inspect-card' }, visible ? cardFace(def, { size: 200 }) : cardBack(project, { size: 200 })),
      visible ? h('div', { class: 'card-details' },
        h('h3', {}, def.name),
        def.description ? h('p', { class: 'muted' }, def.description) : null,
        def.rules ? h('p', {}, def.rules) : null,
        Object.keys(def.stats || {}).length ? h('p', { class: 'small' }, Object.entries(def.stats).map(([k, v]) => `${k}: ${v}`).join(' · ')) : null)
        : h('p', { class: 'muted' }, 'Face down / hidden from this view.'),
      h('p', { class: 'small muted' }, `${selected} · in ${z.name} · ${c.faceUp ? 'face up' : 'face down'}`),
      h('div', { class: 'stack' },
        h('span', { class: 'field-label' }, `Move (as ${me.name})`),
        h('div', { class: 'row gap wrap' }, quick.map(([label, zid]) => h('button', { class: 'btn small', onclick: () => commit({ type: 'move', card: selected, to: zid }) }, '→ ' + label))),
        h('div', { class: 'row gap' }, target, h('button', { class: 'btn small', onclick: () => commit({ type: 'move', card: selected, to: target.value }) }, 'Move')),
        h('button', { class: 'btn small', onclick: () => commit({ type: 'flip', card: selected }) }, 'Flip')));
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
          stats.leader ? h('li', {}, `Current leader: `, h('b', {}, player(st, stats.leader)?.name), stats.lastChangeTurn ? ` (since turn ${stats.lastChangeTurn})` : '') : null));
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
    st.players.forEach((p, i) => {
      const color = `var(--series-${(i % 6) + 1})`;
      const d = pts.map((t, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)},${y(t.counters[p.id]?.[counterId] ?? 0).toFixed(1)}`).join(' ');
      add('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' });
      legend.append(h('span', {}, h('i', { style: { background: color } }), p.name));
    });
    return h('div', { class: 'chart-wrap' }, svg, legend);
  }

  function rulesPanel() {
    const r = project.rules;
    const sec = (t, b) => (b ? [h('h4', {}, t), h('p', { class: 'pre' }, b)] : null);
    return h('div', { class: 'rules-ref' },
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
    else if (e.key === 'Enter' && !aiBusy && st.status === 'playing' && !isAI(activePlayer(st).controller)) commit({ type: 'endTurn' });
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
