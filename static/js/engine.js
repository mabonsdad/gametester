// Game engine: a rules-agnostic "card table" with an event log.
//
// The engine does not enforce game rules (those are free text written by the
// designer and interpreted by humans or AI). It provides:
//   * zones (shared or per player) holding ordered cards (last = top)
//   * primitive actions: move, draw, flip, shuffle, counter, phase, endTurn, endGame, note
//   * a seeded RNG so a game can be replayed exactly from its seed + actions
//   * a log of every action (with a redacted public text for hidden info)
//   * a per-turn timeline of counters, used by the Insights panel and later analysis
//
// State is plain JSON; callers keep snapshots for undo.

import { zoneDef } from './model.js';

// ------------------------------------------------------------------ RNG
function rand(st) {
  let t = (st.rng = (st.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function shuffleArray(st, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand(st) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ------------------------------------------------------------------ helpers
export const clone = (x) => JSON.parse(JSON.stringify(x));

export function player(st, pid) {
  return st.players.find((p) => p.id === pid);
}

export function activePlayer(st) {
  return st.players[st.turn.active];
}

export function cardDef(project, st, uid) {
  const c = st.cards[uid];
  return c && project.cards.find((d) => d.id === c.defId);
}

export function zoneOf(st, uid) {
  const c = st.cards[uid];
  return c && st.zones[c.zone];
}

// Resolve a zone reference: an instance id ("deck", "p2.hand") or a
// per-player zone definition id ("hand") meaning that player's own zone.
export function resolveZone(st, ref, pid) {
  if (!ref) return null;
  if (st.zones[ref]) return ref;
  if (pid && st.zones[`${pid}.${ref}`]) return `${pid}.${ref}`;
  return null;
}

// Is this card's face visible to player `pid`? (pid null = public / everyone)
export function isVisibleTo(project, st, uid, pid) {
  const c = st.cards[uid];
  const z = st.zones[c.zone];
  const def = zoneDef(project, z.defId) || {};
  if (def.visibility === 'owner') return !!pid && z.owner === pid;
  if (!c.faceUp) return false;
  if (def.layout === 'stack') return z.cards[z.cards.length - 1] === uid; // only the top of a pile
  return true;
}

function isPublic(project, st, uid) {
  return isVisibleTo(project, st, uid, null);
}

function cardName(project, st, uid) {
  return cardDef(project, st, uid)?.name || uid;
}

function zoneLabel(st, zid) {
  return st.zones[zid]?.name || zid;
}

function log(st, actor, type, text, extra = {}) {
  st.log.push({
    i: st.log.length,
    turn: st.turn.number,
    phase: st.turn.phase,
    actor,
    type,
    text,
    publicText: extra.publicText ?? text,
    data: extra.data,
    t: Date.now(),
  });
}

function addZone(st, def, owner) {
  const id = owner ? `${owner}.${def.id}` : def.id;
  const ownerName = owner ? player(st, owner).name : null;
  st.zones[id] = { id, defId: def.id, owner, name: owner ? `${ownerName}: ${def.name}` : def.name, cards: [] };
  st.zoneOrder.push(id);
}

function zonesFor(st, project, ref) {
  // A setup reference to a per-player zone def means "every player's".
  const def = zoneDef(project, ref);
  if (def?.scope === 'player') return st.players.map((p) => `${p.id}.${ref}`);
  return st.zones[ref] ? [ref] : [];
}

function placeCard(project, st, uid, toZid, { faceUp, position } = {}) {
  const c = st.cards[uid];
  const from = st.zones[c.zone];
  from.cards.splice(from.cards.indexOf(uid), 1);
  const to = st.zones[toZid];
  const def = zoneDef(project, to.defId) || {};
  c.zone = toZid;
  c.faceUp = faceUp ?? def.faceUp ?? true;
  if (position === 'bottom') to.cards.unshift(uid);
  else to.cards.push(uid);
}

// ------------------------------------------------------------------ create
export function createGame(project, { players, seed } = {}) {
  seed = Number.isFinite(seed) ? seed >>> 0 : Math.floor(Math.random() * 2 ** 31);
  const st = {
    v: 1,
    projectId: project.id,
    seed,
    rng: seed,
    players: [],
    zones: {},
    zoneOrder: [],
    cards: {},
    turn: { number: 1, active: 0, phase: 0 },
    status: 'playing',
    result: null,
    log: [],
    timeline: [],
    assessments: [],
    created: Date.now(),
  };
  players.forEach((p, i) => {
    st.players.push({
      id: 'p' + (i + 1),
      seat: i,
      name: p.name || `Player ${i + 1}`,
      controller: p.controller || 'human',
      counters: Object.fromEntries(project.counters.map((c) => [c.id, Number(c.start) || 0])),
    });
  });
  for (const def of project.zones) {
    if (def.scope === 'player') st.players.forEach((p) => addZone(st, def, p.id));
    else addZone(st, def, null);
  }
  const fallback = project.zones.find((z) => z.scope === 'shared' && z.layout === 'stack')?.id
    || project.zones.find((z) => z.scope === 'shared')?.id;
  if (!fallback) throw new Error('The project needs at least one shared zone (e.g. a draw pile).');
  let n = 0;
  for (const def of project.cards) {
    const copies = Math.max(0, parseInt(def.count ?? 1, 10) || 0);
    const zid = st.zones[def.startZone] ? def.startZone : fallback;
    const zdef = zoneDef(project, st.zones[zid].defId);
    for (let i = 0; i < copies; i++) {
      const id = 'c' + ++n;
      st.cards[id] = { uid: id, defId: def.id, zone: zid, faceUp: !!zdef.faceUp };
      st.zones[zid].cards.push(id);
    }
  }
  log(st, 'system', 'setup', `New game: ${players.length} players, ${n} cards, seed ${seed}.`);
  for (const step of project.setup || []) {
    try {
      runSetupStep(project, st, step);
    } catch (e) {
      log(st, 'system', 'warning', `Setup step "${step.op}" failed: ${e.message}`);
    }
  }
  if (project.turn.firstPlayer === 'random') st.turn.active = Math.floor(rand(st) * st.players.length);
  startTurn(project, st);
  return st;
}

function runSetupStep(project, st, step) {
  const count = Math.max(0, parseInt(step.count ?? 1, 10) || 0);
  if (step.op === 'shuffle') {
    for (const zid of zonesFor(st, project, step.zone)) shuffleArray(st, st.zones[zid].cards);
    log(st, 'system', 'setup', `Shuffled ${zoneLabel(st, step.zone) || step.zone}.`);
  } else if (step.op === 'deal' || step.op === 'move') {
    const from = st.zones[step.from];
    if (!from) throw new Error(`no zone "${step.from}"`);
    const targets = zonesFor(st, project, step.to);
    if (!targets.length) throw new Error(`no zone "${step.to}"`);
    // Deal round-robin starting with the first player, one card at a time.
    for (let k = 0; k < count; k++) {
      for (const zid of targets) {
        const top = from.cards[from.cards.length - 1];
        if (!top) break;
        placeCard(project, st, top, zid, { faceUp: step.faceUp });
      }
    }
    log(st, 'system', 'setup', `${step.op === 'deal' ? 'Dealt' : 'Moved'} ${count} card(s) from ${from.name} to ${targets.length > 1 ? 'each player\'s ' + (zoneDef(project, step.to)?.name || step.to) : zoneLabel(st, targets[0])}.`);
  } else if (step.op === 'counter') {
    for (const p of st.players) p.counters[step.counter] = Number(step.value) || 0;
    log(st, 'system', 'setup', `Set ${step.counter} to ${step.value} for everyone.`);
  }
}

function startTurn(project, st) {
  const p = activePlayer(st);
  log(st, 'system', 'turn', `Turn ${st.turn.number}: ${p.name}`);
  const d = project.turn.drawAtStart || {};
  const count = parseInt(d.count, 10) || 0;
  if (count > 0 && st.status === 'playing') {
    const from = resolveZone(st, d.from, p.id);
    const to = resolveZone(st, 'hand', p.id);
    if (from && to) doDraw(project, st, p.id, from, to, count, true);
  }
}

function doDraw(project, st, actor, fromZid, toZid, count, auto = false) {
  const from = st.zones[fromZid];
  let drawn = 0;
  const names = [];
  for (let k = 0; k < count; k++) {
    const top = from.cards[from.cards.length - 1];
    if (!top) break;
    placeCard(project, st, top, toZid);
    names.push(cardName(project, st, top));
    drawn++;
  }
  const who = player(st, actor)?.name || actor;
  const pub = isPublicZone(project, st, toZid);
  const base = `${who} ${auto ? 'drew (start of turn)' : 'drew'} ${drawn} card(s) from ${from.name} to ${zoneLabel(st, toZid)}`;
  log(st, actor, 'draw', `${base}: ${names.join(', ') || 'none - empty'}`, {
    publicText: pub ? `${base}: ${names.join(', ')}` : `${base}.`,
    data: { from: fromZid, to: toZid, count: drawn },
  });
  return drawn;
}

function isPublicZone(project, st, zid) {
  const def = zoneDef(project, st.zones[zid].defId) || {};
  return def.visibility !== 'owner' && def.faceUp !== false;
}

function snapshotTimeline(st) {
  st.timeline.push({
    turn: st.turn.number,
    player: activePlayer(st).id,
    counters: Object.fromEntries(st.players.map((p) => [p.id, { ...p.counters }])),
  });
}

// ------------------------------------------------------------------ actions
// apply() mutates `st` in place and throws on an invalid action.
export function apply(project, st, action) {
  const a = action || {};
  const actor = a.actor || activePlayer(st).id;
  const who = player(st, actor)?.name || actor;
  switch (a.type) {
    case 'move': {
      const c = st.cards[a.card];
      if (!c) throw new Error(`no card "${a.card}"`);
      const to = resolveZone(st, a.to, actor);
      if (!to) throw new Error(`no zone "${a.to}"`);
      const fromZid = c.zone;
      const wasPublic = isPublic(project, st, a.card);
      placeCard(project, st, a.card, to, { faceUp: a.faceUp, position: a.position });
      const nowPublic = isPublic(project, st, a.card);
      const name = cardName(project, st, a.card);
      const text = `${who} moved ${name} from ${zoneLabel(st, fromZid)} to ${zoneLabel(st, to)}`;
      log(st, actor, 'move', text, {
        publicText: wasPublic || nowPublic ? text : `${who} moved a card from ${zoneLabel(st, fromZid)} to ${zoneLabel(st, to)}`,
        data: { card: a.card, from: fromZid, to },
      });
      break;
    }
    case 'draw': {
      const from = resolveZone(st, a.from || 'deck', actor);
      if (!from) throw new Error(`no zone "${a.from}"`);
      const to = resolveZone(st, a.to || 'hand', actor);
      if (!to) throw new Error(`no zone "${a.to}"`);
      doDraw(project, st, actor, from, to, Math.max(1, parseInt(a.count ?? 1, 10) || 1));
      break;
    }
    case 'flip': {
      const c = st.cards[a.card];
      if (!c) throw new Error(`no card "${a.card}"`);
      c.faceUp = !c.faceUp;
      const text = `${who} flipped ${cardName(project, st, a.card)} face ${c.faceUp ? 'up' : 'down'}`;
      log(st, actor, 'flip', text, { publicText: c.faceUp ? text : `${who} flipped a card face down`, data: { card: a.card } });
      break;
    }
    case 'shuffle': {
      const zid = resolveZone(st, a.zone, actor);
      if (!zid) throw new Error(`no zone "${a.zone}"`);
      shuffleArray(st, st.zones[zid].cards);
      log(st, actor, 'shuffle', `${who} shuffled ${zoneLabel(st, zid)}`, { data: { zone: zid } });
      break;
    }
    case 'counter': {
      const p = player(st, a.player || actor);
      if (!p) throw new Error(`no player "${a.player}"`);
      if (!(a.counter in p.counters)) throw new Error(`no counter "${a.counter}"`);
      const before = p.counters[a.counter];
      p.counters[a.counter] = a.value !== undefined ? Number(a.value) : before + (Number(a.delta) || 0);
      log(st, actor, 'counter', `${p.name} ${a.counter}: ${before} → ${p.counters[a.counter]}${actor !== p.id ? ` (by ${who})` : ''}`, {
        data: { player: p.id, counter: a.counter, before, after: p.counters[a.counter] },
      });
      break;
    }
    case 'phase': {
      const phases = project.turn.phases || [];
      if (st.turn.phase < phases.length - 1) st.turn.phase++;
      log(st, actor, 'phase', `Phase: ${phases[st.turn.phase]?.name || st.turn.phase + 1}`);
      break;
    }
    case 'endTurn': {
      if (st.status !== 'playing') throw new Error('the game has ended');
      log(st, actor, 'endTurn', `${who} ended their turn`);
      snapshotTimeline(st);
      const n = st.players.length;
      const step = project.turn.direction === 'counterclockwise' ? -1 : 1;
      st.turn.active = (st.turn.active + step + n) % n;
      st.turn.number++;
      st.turn.phase = 0;
      startTurn(project, st);
      break;
    }
    case 'endGame': {
      snapshotTimeline(st);
      st.status = 'ended';
      const winners = [].concat(a.winner || []).filter((w) => player(st, w));
      st.result = { winners, reason: a.reason || '', by: actor, turn: st.turn.number };
      const names = winners.map((w) => player(st, w).name).join(' & ') || 'no winner recorded';
      log(st, actor, 'endGame', `Game over (${who}): ${names}${a.reason ? ' - ' + a.reason : ''}`);
      break;
    }
    case 'note': {
      // actor 'designer' = playtester observation; 'system' = harness warning.
      const label = actor === 'designer' ? 'Designer note: ' : actor === 'system' ? '⚠ ' : `${who}: `;
      log(st, actor, 'note', label + (a.text || ''), {
        publicText: a.private ? `${who} (private reasoning hidden)` : undefined,
        data: a.kind ? { kind: a.kind } : undefined,
      });
      break;
    }
    case 'assess': {
      // AI self-assessment for analysis: how a seat feels about its chances.
      st.assessments.push({ turn: st.turn.number, player: actor, winConfidence: a.winConfidence, experience: a.experience || '' });
      break;
    }
    default:
      throw new Error(`unknown action type "${a.type}"`);
  }
  return st;
}

// ------------------------------------------------------------------ analysis helpers
// Leader per timeline entry by a counter, and number of lead changes.
export function leadStats(st, counterId) {
  const points = st.timeline.map((t) => {
    let best = null; let bestV = -Infinity; let tie = false;
    for (const [pid, c] of Object.entries(t.counters)) {
      const v = c[counterId] ?? 0;
      if (v > bestV) { best = pid; bestV = v; tie = false; } else if (v === bestV) tie = true;
    }
    return { turn: t.turn, leader: tie ? null : best, value: bestV };
  });
  let changes = 0; let last = null; let lastChangeTurn = null;
  for (const p of points) {
    if (p.leader && p.leader !== last) {
      if (last) changes++;
      last = p.leader;
      lastChangeTurn = p.turn;
    }
  }
  return { points, changes, leader: last, lastChangeTurn };
}
