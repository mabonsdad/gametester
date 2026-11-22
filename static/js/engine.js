// Game engine: a rules-agnostic "card table" with an event log.
//
// By default the engine does not enforce game rules (those are free text
// written by the designer and interpreted by humans or AI). Projects can opt in
// to automation (project.automation): trick-taking play, legal-move checks,
// formula-based scoring and end conditions - see the "automation" section.
// It provides:
//   * zones (shared or per player) holding ordered cards (last = top)
//   * primitive actions: move, draw, flip, shuffle, counter, phase, endTurn, endGame, note
//   * a seeded RNG so a game can be replayed exactly from its seed + actions
//   * a log of every action (with a redacted public text for hidden info)
//   * a per-turn timeline of counters, used by the Insights panel and later analysis
//
// State is plain JSON; callers keep snapshots for undo.

import { END_AT, ENFORCE, SCORE_EVENTS, SCORE_WHO, zoneDef } from './model.js';
import { run as runExpr } from './expr.js';

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
export function createGame(project, { players, seed, options } = {}) {
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
    teams: [],
    dealer: 0,
    hand: null,
    handsPlayed: 0,
    lastTrick: null,
    lastHand: null,
    pending: null, // a pause waiting for 'continue' (see options)
    dir: 1, // 1 = the project's turn direction, -1 = reversed
    options: { pauseTricks: false, pauseHands: false, ...(options || {}) },
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
  st.teams = makeTeams(project, st);
  if (st.teams.length) log(st, 'system', 'setup', `Teams: ${st.teams.map((t) => t.name).join(' vs ')}.`);
  if (isAutomated(project)) {
    st.dealer = project.turn.firstPlayer === 'random'
      ? Math.floor(rand(st) * st.players.length)
      : (st.players.length - 1); // so seat 1 (left of the dealer) leads first
    startHand(project, st, true);
    return st;
  }
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
    // Deal round-robin one card at a time: from seat 1, or (trick games) from
    // the player to the dealer's left, so the last card goes to the dealer.
    if (isAutomated(project) && targets.length === st.players.length) {
      const start = nextSeat(project, st, st.dealer);
      for (let r = 0; r < start; r++) targets.push(targets.shift());
    }
    for (let k = 0; k < count; k++) {
      for (const zid of targets) {
        const top = from.cards[from.cards.length - 1];
        if (!top) break;
        placeCard(project, st, top, zid, { faceUp: step.faceUp });
        if (st.hand) st.hand.lastDealt = top;
      }
    }
    log(st, 'system', 'setup', `${step.op === 'deal' ? 'Dealt' : 'Moved'} ${count} card(s) from ${from.name} to ${targets.length > 1 ? 'each player\'s ' + (zoneDef(project, step.to)?.name || step.to) : zoneLabel(st, targets[0])}.`);
  } else if (step.op === 'counter') {
    for (const p of st.players) p.counters[step.counter] = Number(step.value) || 0;
    log(st, 'system', 'setup', `Set ${step.counter} to ${step.value} for everyone.`);
  }
}

function startTurn(project, st) {
  if (isAutomated(project)) return; // automated games advance by themselves
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
      if (isShedPlay(project, st, fromZid, to)) {
        const owner = st.zones[fromZid].owner;
        placeCard(project, st, a.card, to, { faceUp: true });
        playShed(project, st, owner, a.card, a.choose);
        break;
      }
      if (isTrickPlay(project, st, fromZid, to)) {
        const owner = st.zones[fromZid].owner;
        placeCard(project, st, a.card, to, { faceUp: true });
        log(st, owner, 'play', `${player(st, owner).name} played ${cardName(project, st, a.card)}`, { data: { card: a.card, from: fromZid, to } });
        playToTrick(project, st, owner, a.card);
        break;
      }
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
      if (isShedding(project) && st.hand && st.status === 'playing' && player(st, actor)) {
        shedDraw(project, st, actor);
        break;
      }
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
    case 'continue': {
      const pause = st.pending;
      if (!pause) break;
      st.pending = null;
      if (pause.type === 'trick') resolveTrick(project, st);
      else if (pause.type === 'hand') startHand(project, st, false);
      break;
    }
    case 'endTurn': {
      if (st.status !== 'playing') throw new Error('the game has ended');
      if (isShedding(project) && st.hand) {
        const p = activePlayer(st);
        log(st, p.id, 'pass', `${p.name} ${st.hand.drew ? 'keeps the drawn card and passes' : 'passes'}.`);
        shedAdvance(project, st, p.id, 0);
        break;
      }
      log(st, actor, 'endTurn', `${who} ended their turn`);
      fireScoring(project, st, 'turnEnd', { actor: activePlayer(st).id });
      snapshotTimeline(st);
      if (checkEnd(project, st, 'turnEnd')) break;
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
      finishGame(st, [].concat(a.winner || []), a.reason || '', actor);
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
// Competitors are teams when the game has partnerships, otherwise players.
export function competitors(st) {
  return st.teams?.length
    ? st.teams.map((t) => ({ id: t.id, name: t.name, rep: t.players[0] }))
    : st.players.map((p) => ({ id: p.id, name: p.name, rep: p.id }));
}

export function competitorName(st, id) {
  return st.teams?.find((t) => t.id === id)?.name || player(st, id)?.name || id;
}

// Leader per timeline entry by a counter, and number of lead changes.
export function leadStats(st, counterId) {
  const comps = competitors(st);
  const points = st.timeline.map((t) => {
    let best = null; let bestV = -Infinity; let tie = false;
    for (const c of comps) {
      const v = t.counters[c.rep]?.[counterId] ?? 0;
      if (v > bestV) { best = c.id; bestV = v; tie = false; } else if (v === bestV) tie = true;
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

// ================================================================== automation
// Optional, per project (project.automation). Free-form projects only use the
// scoring rules / end conditions on 'turnEnd'; trick-taking projects get the
// full flow: deal, trumps, follow suit, trick resolution, hand scoring, redeal.

const NO_AUTOMATION = { style: 'free', enforce: 'off', autoScore: false, teams: 'none', scoring: [], endWhen: [], tricks: {} };
export const automation = (project) => project.automation || NO_AUTOMATION;
export const isTricks = (project) => automation(project).style === 'tricks';
export const isShedding = (project) => automation(project).style === 'shedding';
export const isAutomated = (project) => isTricks(project) || isShedding(project);

function statOf(project, st, uid, stat) {
  return cardDef(project, st, uid)?.stats?.[stat];
}

function nextSeat(project, st, seat, from = 1) {
  const n = st.players.length;
  const step = (project.turn.direction === 'counterclockwise' ? -1 : 1) * (st.dir || 1);
  return (((seat + step * from) % n) + n) % n;
}

export function teamOf(st, pid) {
  return st.teams?.find((t) => t.players.includes(pid)) || null;
}

function makeTeams(project, st) {
  const n = st.players.length;
  if (automation(project).teams !== 'partners' || n < 4 || n % 2) return [];
  const k = n / 2;
  const letters = 'ABC';
  return Array.from({ length: k }, (_, i) => {
    const members = [st.players[i], st.players[i + k]];
    return { id: `t${i + 1}`, name: `Team ${letters[i]} (${members.map((p) => p.name).join(' & ')})`, players: members.map((p) => p.id) };
  });
}

function packZone(project, st) {
  const deal = (project.setup || []).find((s) => s.op === 'deal' && st.zones[s.from]);
  if (deal) return deal.from;
  return st.zoneOrder.find((z) => !st.zones[z].owner && zoneDef(project, st.zones[z].defId)?.layout === 'stack') || st.zoneOrder[0];
}

function isTrickPlay(project, st, fromZid, toZid) {
  if (!isTricks(project) || st.status !== 'playing' || !st.hand) return false;
  const from = st.zones[fromZid];
  const to = st.zones[toZid];
  return from?.defId === 'hand' && !!from.owner && to?.defId === automation(project).tricks.zone && !to.owner;
}

function startHand(project, st, first) {
  const T = automation(project).tricks;
  st.dir = 1;
  if (!first) {
    const pack = packZone(project, st);
    for (const uid of Object.keys(st.cards)) {
      if (st.cards[uid].zone !== pack) placeCard(project, st, uid, pack, { faceUp: false });
    }
    st.dealer = nextSeat(project, st, st.dealer);
  }
  st.hand = {
    number: (st.hand?.number || 0) + 1,
    trick: [],
    led: null,
    trump: null,
    trumpCard: null,
    tricksWon: Object.fromEntries(st.players.map((p) => [p.id, 0])),
    tricksPlayed: 0,
    lastDealt: null,
    colour: null, // shedding: colour and value to match
    value: null,
    drew: false,
    drawn: null,
  };
  st.lastTrick = null;
  log(st, 'system', 'hand', `${isShedding(project) ? 'Round' : 'Hand'} ${st.hand.number}: ${st.players[st.dealer].name} deals.`);
  for (const step of project.setup || []) {
    if (!first && step.op === 'counter') continue; // keep scores between hands
    try {
      runSetupStep(project, st, step);
    } catch (e) {
      log(st, 'system', 'warning', `Setup step "${step.op}" failed: ${e.message}`);
    }
  }
  if (isShedding(project)) {
    startShedRound(project, st);
    return;
  }
  if (T.trump === 'fixed' && T.trumpSuit) {
    st.hand.trump = T.trumpSuit;
    log(st, 'system', 'trump', `Trumps: ${T.trumpSuit}.`);
  } else if (T.trump === 'lastDealt' && st.hand.lastDealt) {
    const uid = st.hand.lastDealt;
    st.hand.trump = statOf(project, st, uid, T.suitStat) ?? null;
    st.hand.trumpCard = uid;
    log(st, 'system', 'trump', `Trumps: ${st.hand.trump} - the last card dealt, ${cardName(project, st, uid)}, is turned up (it belongs to ${st.players[st.dealer].name}).`);
  } else {
    log(st, 'system', 'trump', 'No trumps this hand.');
  }
  st.turn.active = T.firstLead === 'dealer' ? st.dealer : nextSeat(project, st, st.dealer);
  st.turn.phase = 0;
  log(st, 'system', 'turn', `${activePlayer(st).name} leads.`);
}

function playToTrick(project, st, pid, uid) {
  const H = st.hand;
  const T = automation(project).tricks;
  if (!H.trick.length) H.led = statOf(project, st, uid, T.suitStat) ?? null;
  H.trick.push({ pid, card: uid });
  st.turn.number++;
  if (H.trick.length < st.players.length) {
    st.turn.active = nextSeat(project, st, player(st, pid).seat);
    return;
  }
  if (st.options?.pauseTricks) {
    const best = trickWinner(project, st, H.trick, H.trump);
    st.pending = { type: 'trick', number: H.tricksPlayed + 1, winner: best.pid, winningCard: best.card };
    log(st, 'system', 'pause', `Trick ${H.tricksPlayed + 1} complete: ${player(st, best.pid).name} wins with ${cardName(project, st, best.card)}. Paused - press Next.`);
    return;
  }
  resolveTrick(project, st);
}

export function trickWinner(project, st, plays, trump) {
  const T = automation(project).tricks;
  const suit = (u) => statOf(project, st, u, T.suitStat);
  const rank = (u) => Number(statOf(project, st, u, T.rankStat)) || 0;
  let best = plays[0];
  for (const play of plays.slice(1)) {
    const bestTrump = !!trump && suit(best.card) === trump;
    const thisTrump = !!trump && suit(play.card) === trump;
    if (thisTrump && !bestTrump) best = play;
    else if (thisTrump === bestTrump && suit(play.card) === suit(best.card) && rank(play.card) > rank(best.card)) best = play;
  }
  return best;
}

function resolveTrick(project, st) {
  const H = st.hand;
  const T = automation(project).tricks;
  const best = trickWinner(project, st, H.trick, H.trump);
  const winner = best.pid;
  H.tricksWon[winner] = (H.tricksWon[winner] || 0) + 1;
  H.tricksPlayed++;
  const dest = resolveZone(st, T.wonZone, winner) || packZone(project, st);
  for (const play of H.trick) placeCard(project, st, play.card, dest, { faceUp: false });
  st.lastTrick = { number: H.tricksPlayed, plays: H.trick, winner, winningCard: best.card, led: H.led };
  const team = teamOf(st, winner);
  log(st, 'system', 'trick', `Trick ${H.tricksPlayed} won by ${player(st, winner).name} with ${cardName(project, st, best.card)}${team ? ` - ${team.name}` : ''} (${H.trick.map((p) => cardName(project, st, p.card)).join(', ')}).`);
  H.trick = [];
  H.led = null;
  fireScoring(project, st, 'trickWon', { winner });
  snapshotTimeline(st);
  if (checkEnd(project, st, 'trickWon')) return;
  const handsEmpty = st.players.every((p) => !(st.zones[`${p.id}.hand`]?.cards.length));
  if (handsEmpty) {
    endHand(project, st);
    return;
  }
  st.turn.active = player(st, winner).seat;
  log(st, 'system', 'turn', `${player(st, winner).name} leads trick ${H.tricksPlayed + 1}.`);
}

function endHand(project, st, ctx = {}) {
  const H = st.hand;
  const comps = competitors(st);
  const membersOf = (c) => teamOf(st, c.rep)?.players || [c.rep];
  let summary;
  if (isShedding(project)) {
    const left = st.players.filter((p) => p.id !== ctx.winner)
      .map((p) => `${p.name} ${st.zones[`${p.id}.hand`]?.cards.length ?? 0}`);
    summary = `Round ${H.number} over - ${player(st, ctx.winner)?.name} went out. Cards left: ${left.join(', ')}.`;
  } else {
    summary = `Hand ${H.number} over - tricks: ${comps.map((c) => `${c.name} ${membersOf(c).reduce((s, m) => s + (H.tricksWon[m] || 0), 0)}`).join(', ')}.`;
  }
  log(st, 'system', 'hand', summary);
  st.handsPlayed++;
  const before = Object.fromEntries(comps.map((c) => [c.id, { ...player(st, c.rep).counters }]));
  const logMark = st.log.length;
  fireScoring(project, st, 'handEnd', ctx);
  const scoreLines = st.log.slice(logMark).filter((e) => e.type === 'score' || e.type === 'note').map((e) => e.text);
  snapshotTimeline(st);
  st.lastHand = {
    number: H.number,
    summary,
    winner: ctx.winner || null,
    scoreLines,
    tricks: isTricks(project) ? Object.fromEntries(comps.map((c) => [c.id, membersOf(c).reduce((s, m) => s + (H.tricksWon[m] || 0), 0)])) : null,
    changes: comps.map((c) => {
      const now = player(st, c.rep).counters;
      return { id: c.id, name: c.name, deltas: Object.fromEntries(Object.keys(now).map((k) => [k, now[k] - (before[c.id][k] ?? 0)])), totals: { ...now } };
    }),
  };
  if (checkEnd(project, st, 'handEnd')) return;
  const again = isShedding(project) ? (automation(project).endWhen || []).length > 0 : automation(project).tricks.redeal;
  if (again) {
    if (st.options?.pauseHands) {
      st.pending = { type: 'hand', number: H.number };
      log(st, 'system', 'pause', `Paused after ${isShedding(project) ? 'round' : 'hand'} ${H.number} - press Deal to continue.`);
      return;
    }
    startHand(project, st, false);
  } else if (isShedding(project)) {
    finishGame(st, [ctx.winner], `${player(st, ctx.winner)?.name} went out`, 'system');
  } else {
    const c = project.counters[0]?.id;
    const best = c ? Math.max(...st.players.map((p) => p.counters[c] ?? 0)) : 0;
    finishGame(st, c ? st.players.filter((p) => (p.counters[c] ?? 0) === best).map((p) => p.id) : [], 'All cards played', 'system');
  }
}

function finishGame(st, winners, reason, by) {
  st.status = 'ended';
  winners = winners.filter((w) => player(st, w));
  st.result = { winners, reason, by, turn: st.turn.number };
  const names = winners.map((w) => player(st, w).name).join(' & ') || 'no winner recorded';
  log(st, by, 'endGame', `Game over: ${names}${reason ? ' - ' + reason : ''}`);
}

// Variables and functions available to scoring/end formulas, from pid's view.
export function formulaScope(project, st, pid, ctx = {}) {
  const p = player(st, pid);
  const H = st.hand;
  const mates = teamOf(st, pid)?.players || [pid];
  const tricksOf = (id) => H?.tricksWon?.[id] ?? 0;
  const zoneCards = (ref) => {
    const zid = resolveZone(st, ref, pid);
    return zid ? st.zones[zid].cards : [];
  };
  const matches = (uid, stat, value) => stat == null || (value === undefined
    ? statOf(project, st, uid, stat) != null
    : String(statOf(project, st, uid, stat)) === String(value));
  const T = automation(project).tricks;
  return {
    ...p.counters,
    tricks: tricksOf(pid),
    teamTricks: mates.reduce((s, m) => s + tricksOf(m), 0),
    handTricks: H?.tricksPlayed ?? 0,
    hand: H?.number ?? 0,
    handsPlayed: st.handsPlayed || 0,
    players: st.players.length,
    seat: p.seat + 1,
    turn: st.turn.number,
    cardsInHand: st.zones[`${pid}.hand`]?.cards.length ?? 0,
    isWinner: ctx.winner === pid ? 1 : 0,
    wentOut: ctx.winner === pid ? 1 : 0,
    handSum: (stat) => zoneCards('hand').reduce((s, u) => s + (Number(statOf(project, st, u, stat)) || 0), 0),
    othersHandSum: (stat) => st.players.filter((o) => o.id !== pid)
      .reduce((s, o) => s + (st.zones[`${o.id}.hand`]?.cards || []).reduce((t, u) => t + (Number(statOf(project, st, u, stat)) || 0), 0), 0),
    othersCardsInHand: st.players.filter((o) => o.id !== pid).reduce((s, o) => s + (st.zones[`${o.id}.hand`]?.cards.length || 0), 0),
    zoneCount: (zone, stat, value) => zoneCards(zone).filter((u) => matches(u, stat, value)).length,
    zoneSum: (zone, stat) => zoneCards(zone).reduce((s, u) => s + (Number(statOf(project, st, u, stat)) || 0), 0),
    wonCount: (stat, value) => zoneCards(T.wonZone).filter((u) => matches(u, stat, value)).length,
    wonSum: (stat) => zoneCards(T.wonZone).reduce((s, u) => s + (Number(statOf(project, st, u, stat)) || 0), 0),
  };
}

export const FORMULA_HELP = [
  ['tricks / teamTricks', 'tricks won this hand by the player / their team'],
  ['handTricks', 'tricks played so far this hand'],
  ['hand, handsPlayed', 'current hand number / hands finished'],
  ['cardsInHand, players, seat, turn', 'as named'],
  ['wentOut', '1 for the player who emptied their hand this round (shedding games), else 0'],
  ['handSum("points"), othersHandSum("points")', 'sum of a stat over their own hand / everyone else\'s hands'],
  ['othersCardsInHand', "number of cards in everyone else's hands"],
  ['any counter id (e.g. score)', "that player's counter"],
  ['wonCount("suit","Hearts")', 'cards in their tricks-won zone (optionally matching a stat)'],
  ['wonSum("points")', 'sum of a stat over their tricks-won zone'],
  ['zoneCount("haul"), zoneSum("haul","number")', 'the same for any zone'],
  ['max, min, abs, floor, ceil, round', 'functions'],
  ['+ - * / %   < <= > >= == !=   && || !   a ? b : c', 'operators'],
];

function fireScoring(project, st, event, ctx) {
  const A = automation(project);
  if (!A.autoScore) return;
  for (const rule of A.scoring || []) {
    if (rule.event !== event || !rule.counter || !rule.expr) continue;
    let groups;
    if (rule.who === 'winner') groups = ctx.winner ? [[ctx.winner]] : [];
    else if (rule.who === 'winnerTeam') groups = ctx.winner ? [teamOf(st, ctx.winner)?.players || [ctx.winner]] : [];
    else if (rule.who === 'active') groups = [[ctx.actor || activePlayer(st).id]];
    else if (rule.who === 'team') groups = st.teams.length ? st.teams.map((t) => t.players) : st.players.map((p) => [p.id]);
    else groups = st.players.map((p) => [p.id]);
    for (const g of groups) {
      try {
        const vars = formulaScope(project, st, g[0], ctx);
        if (rule.when && !runExpr(rule.when, vars)) continue;
        const amount = Number(runExpr(rule.expr, vars)) || 0;
        if (!amount) continue;
        let after;
        for (const pid of g) {
          const p = player(st, pid);
          if (!(rule.counter in p.counters)) throw new Error(`no counter "${rule.counter}"`);
          p.counters[rule.counter] += amount;
          after = p.counters[rule.counter];
        }
        const label = g.length > 1 ? teamOf(st, g[0])?.name : player(st, g[0]).name;
        const cname = project.counters.find((c) => c.id === rule.counter)?.name || rule.counter;
        log(st, 'system', 'score', `Score: ${label} ${amount > 0 ? '+' : ''}${amount} ${cname} (${rule.label || rule.expr}) - now ${after}.`,
          { data: { players: g, counter: rule.counter, amount } });
      } catch (e) {
        log(st, 'system', 'note', `⚠ Scoring rule "${rule.label || rule.expr}" failed: ${e.message}`);
      }
    }
  }
}

function checkEnd(project, st, at) {
  for (const rule of automation(project).endWhen || []) {
    if (rule.at !== at || !rule.expr || st.status !== 'playing') continue;
    let matching;
    try {
      matching = st.players.filter((p) => runExpr(rule.expr, formulaScope(project, st, p.id)));
    } catch (e) {
      log(st, 'system', 'note', `⚠ End condition "${rule.label || rule.expr}" failed: ${e.message}`);
      continue;
    }
    if (!matching.length) continue;
    let winners = matching.map((p) => p.id);
    if (rule.winner) {
      const best = Math.max(...st.players.map((p) => p.counters[rule.winner] ?? 0));
      winners = st.players.filter((p) => (p.counters[rule.winner] ?? 0) === best).map((p) => p.id);
    }
    finishGame(st, winners, rule.label ? `${rule.label} (${rule.expr})` : rule.expr, 'system');
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ shedding (match & discard)
// Play a card matching the current colour or value of the top discard (or a
// wild). Otherwise draw one; the drawn card may be played straight away
// (playDrawn) or the turn passes. Effects come from a card stat (default
// "effect"), as space-separated words: skip, reverse, wild, draw:N.

const SHED_DEFAULTS = { drawZone: 'deck', discardZone: 'discard', colourStat: 'colour', valueStat: 'value', effectStat: 'effect', wildColour: 'Wild', playDrawn: true };
const shedCfg = (project) => ({ ...SHED_DEFAULTS, ...(automation(project).shedding || {}) });

export function cardEffects(project, st, uid) {
  const S = shedCfg(project);
  const fx = { skip: false, reverse: false, wild: false, draw: 0 };
  const raw = String(statOf(project, st, uid, S.effectStat) ?? '').toLowerCase();
  for (const tok of raw.split(/[\s,]+/).filter(Boolean)) {
    if (tok === 'skip') fx.skip = true;
    else if (tok === 'reverse') fx.reverse = true;
    else if (tok === 'wild') fx.wild = true;
    else {
      const m = tok.match(/^(?:draw|\+):?(\d+)$/);
      if (m) fx.draw = Number(m[1]);
    }
  }
  if (S.wildColour && String(statOf(project, st, uid, S.colourStat)) === S.wildColour) fx.wild = true;
  return fx;
}

// Colours a wild card can name: every colour on a non-wild card.
export function shedColours(project) {
  const S = shedCfg(project);
  const out = [];
  for (const c of project.cards) {
    const v = c.stats?.[S.colourStat];
    if (v != null && String(v) !== S.wildColour && !out.includes(String(v))) out.push(String(v));
  }
  return out;
}

export function shedTop(project, st) {
  const z = st.zones[shedCfg(project).discardZone];
  return z?.cards[z.cards.length - 1] || null;
}

function canPlayOn(project, st, uid) {
  const S = shedCfg(project);
  const H = st.hand;
  if (cardEffects(project, st, uid).wild) return true;
  return String(statOf(project, st, uid, S.colourStat)) === H.colour
    || (H.value != null && String(statOf(project, st, uid, S.valueStat)) === H.value);
}

function isShedPlay(project, st, fromZid, toZid) {
  if (!isShedding(project) || st.status !== 'playing' || !st.hand) return false;
  const from = st.zones[fromZid];
  const to = st.zones[toZid];
  return from?.defId === 'hand' && !!from.owner && to?.id === shedCfg(project).discardZone;
}

function shedReshuffle(project, st) {
  const S = shedCfg(project);
  const discard = st.zones[S.discardZone];
  const deck = st.zones[S.drawZone];
  if (!discard || discard.cards.length < 2) return;
  const keep = discard.cards[discard.cards.length - 1];
  for (const u of discard.cards.slice(0, -1)) placeCard(project, st, u, deck.id, { faceUp: false });
  discard.cards = [keep];
  shuffleArray(st, deck.cards);
  log(st, 'system', 'shuffle', `The ${discard.name} (except its top card) is shuffled to make a new ${deck.name}.`);
}

function drawCards(project, st, pid, n) {
  const S = shedCfg(project);
  const deck = st.zones[S.drawZone];
  const got = [];
  for (let k = 0; k < n; k++) {
    if (!deck.cards.length) shedReshuffle(project, st);
    const top = deck.cards[deck.cards.length - 1];
    if (!top) break;
    placeCard(project, st, top, `${pid}.hand`);
    got.push(top);
  }
  return got;
}

function startShedRound(project, st) {
  const S = shedCfg(project);
  const deck = st.zones[S.drawZone];
  const discard = st.zones[S.discardZone];
  if (!deck || !discard) {
    log(st, 'system', 'note', `⚠ Shedding needs zones "${S.drawZone}" and "${S.discardZone}".`);
    return;
  }
  if (!discard.cards.length && deck.cards.length) placeCard(project, st, deck.cards[deck.cards.length - 1], discard.id, { faceUp: true });
  // The starting card must be a plain card: action and wild cards go back under the pile.
  for (let i = 0; i < deck.cards.length + 1; i++) {
    const top = shedTop(project, st);
    const fx = top && cardEffects(project, st, top);
    if (!top || !(fx.wild || fx.skip || fx.reverse || fx.draw) || !deck.cards.length) break;
    placeCard(project, st, top, deck.id, { faceUp: false, position: 'bottom' });
    placeCard(project, st, deck.cards[deck.cards.length - 1], discard.id, { faceUp: true });
  }
  const top = shedTop(project, st);
  st.hand.colour = top ? String(statOf(project, st, top, S.colourStat)) : null;
  st.hand.value = top ? String(statOf(project, st, top, S.valueStat)) : null;
  st.turn.active = nextSeat(project, st, st.dealer);
  st.turn.phase = 0;
  log(st, 'system', 'turn', `Starting card: ${top ? cardName(project, st, top) : 'none'}. ${activePlayer(st).name} plays first.`);
}

function shedAdvance(project, st, pid, skip) {
  st.hand.drew = false;
  st.hand.drawn = null;
  st.turn.active = nextSeat(project, st, player(st, pid).seat, 1 + skip);
  st.turn.number++;
}

function favouriteColour(project, st, pid) {
  const S = shedCfg(project);
  const counts = {};
  for (const u of st.zones[`${pid}.hand`]?.cards || []) {
    const c = String(statOf(project, st, u, S.colourStat));
    if (c !== S.wildColour) counts[c] = (counts[c] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || shedColours(project)[0] || null;
}

function playShed(project, st, pid, uid, choose) {
  const S = shedCfg(project);
  const H = st.hand;
  const fx = cardEffects(project, st, uid);
  const who = player(st, pid).name;
  H.value = String(statOf(project, st, uid, S.valueStat));
  if (fx.wild) {
    const colours = shedColours(project);
    H.colour = colours.includes(choose) ? choose : favouriteColour(project, st, pid);
  } else {
    H.colour = String(statOf(project, st, uid, S.colourStat));
  }
  log(st, pid, 'play', `${who} played ${cardName(project, st, uid)}${fx.wild ? ` and chose ${H.colour}` : ''}.`, { data: { card: uid, choose: fx.wild ? H.colour : undefined } });
  let skip = 0;
  if (fx.reverse) {
    st.dir = -(st.dir || 1);
    log(st, 'system', 'effect', `Direction of play reversed.`);
    if (st.players.length === 2) skip = 1;
  }
  const victim = st.players[nextSeat(project, st, player(st, pid).seat)];
  if (fx.draw) {
    const got = drawCards(project, st, victim.id, fx.draw);
    log(st, 'system', 'effect', `${victim.name} draws ${got.length} and misses a turn: ${got.map((u) => cardName(project, st, u)).join(', ')}.`,
      { publicText: `${victim.name} draws ${got.length} and misses a turn.` });
    skip = 1;
  } else if (fx.skip) {
    log(st, 'system', 'effect', `${victim.name} misses a turn.`);
    skip = 1;
  }
  if (!st.zones[`${pid}.hand`].cards.length) {
    st.turn.number++;
    endHand(project, st, { winner: pid });
    return;
  }
  if (st.zones[`${pid}.hand`].cards.length === 1) log(st, 'system', 'effect', `${who} has one card left!`);
  shedAdvance(project, st, pid, skip);
}

function shedDraw(project, st, pid) {
  const S = shedCfg(project);
  const H = st.hand;
  const who = player(st, pid).name;
  const got = drawCards(project, st, pid, 1);
  H.drew = true;
  H.drawn = got[0] || null;
  if (!got.length) {
    log(st, pid, 'draw', `${who} cannot draw - no cards left. The turn passes.`);
    shedAdvance(project, st, pid, 0);
    return;
  }
  const playable = S.playDrawn && canPlayOn(project, st, got[0]);
  log(st, pid, 'draw', `${who} drew ${cardName(project, st, got[0])}${playable ? ' - it can be played' : ''}.`, { publicText: `${who} drew a card.` });
  if (!playable) {
    log(st, 'system', 'turn', `${who} cannot play the drawn card; the turn passes.`, { publicText: `${who} could not play; the turn passes.` });
    shedAdvance(project, st, pid, 0);
  }
}

function shedLegal(project, st, pid, out) {
  const S = shedCfg(project);
  const H = st.hand;
  const hand = st.zones[`${pid}.hand`]?.cards || [];
  out.target = S.discardZone;
  out.colours = shedColours(project);
  const need = `${H.colour}${H.value != null ? ` or a ${H.value}` : ''}`;
  if (H.drew) {
    for (const u of hand) {
      const ok = u === H.drawn && canPlayOn(project, st, u);
      out.cards[u] = ok ? '' : u === H.drawn ? `It does not match ${need}.` : 'After drawing you may only play the card you drew - or pass.';
      if (ok) out.legal.push(u);
    }
    out.canPass = true;
    out.summary = out.legal.length ? `You drew ${cardName(project, st, H.drawn)}: play it, or pass to keep it.` : 'Pass.';
    return out;
  }
  for (const u of hand) {
    const ok = canPlayOn(project, st, u);
    out.cards[u] = ok ? '' : `It must match ${need}, or be a wild card.`;
    if (ok) out.legal.push(u);
  }
  out.canDraw = true;
  out.summary = out.legal.length ? `Play a ${need} card (or a wild), or draw a card.` : `No card matches ${need}: draw a card.`;
  return out;
}

// ------------------------------------------------------------------ legal moves
// For automated games: which cards in pid's hand may be played now (and why
// not), plus whether drawing or passing is allowed. Returns null when the
// project has no move restrictions (free-form).
export function legalMoves(project, st, pid) {
  if (!isAutomated(project) || st.status !== 'playing' || !st.hand) return null;
  const T = automation(project).tricks;
  const active = activePlayer(st);
  const hand = st.zones[`${pid}.hand`]?.cards || [];
  const out = { pid, target: resolveZone(st, T.zone, pid), cards: {}, legal: [], summary: '', canDraw: false, canPass: false };
  if (st.pending) {
    for (const u of hand) out.cards[u] = 'Paused - press Next to continue.';
    out.summary = st.pending.type === 'trick' ? 'Trick complete - press Next trick.' : 'Hand over - press Deal next hand.';
    out.paused = true;
    return out;
  }
  if (pid !== active.id) {
    for (const u of hand) out.cards[u] = `Wait - it is ${active.name}'s turn.`;
    out.summary = `Waiting for ${active.name}.`;
    return out;
  }
  if (isShedding(project)) return shedLegal(project, st, pid, out);
  const led = st.hand.led;
  const suit = (u) => statOf(project, st, u, T.suitStat);
  const canFollow = T.followSuit && led != null && hand.some((u) => suit(u) === led);
  for (const u of hand) {
    const ok = !canFollow || suit(u) === led;
    out.cards[u] = ok ? '' : `You must follow suit: play a ${led} card.`;
    if (ok) out.legal.push(u);
  }
  const trumpNote = st.hand.trump ? ` (a ${st.hand.trump} card would trump it)` : '';
  out.summary = led == null
    ? 'Lead any card to start the trick.'
    : canFollow ? `Follow suit: play a ${led} card.` : `You have no ${led}: play any card${trumpNote}.`;
  return out;
}

// Why an action breaks the automated rules, or null if it is fine.
// Only actions by players are checked; 'designer' and 'system' never are.
export function checkAction(project, st, action) {
  const A = automation(project);
  if (A.enforce === 'off' || st.status !== 'playing') return null;
  const actor = action.actor || activePlayer(st).id;
  if (!player(st, actor)) return null;
  if (!isAutomated(project)) return null;
  if (st.pending && action.type !== 'note') return 'The game is paused - press Next to continue first.';
  if (isShedding(project)) return checkShed(project, st, action, actor);
  const T = A.tricks;
  const trickName = zoneDef(project, T.zone)?.name || 'trick';
  switch (action.type) {
    case 'move': {
      const c = st.cards[action.card];
      if (!c) return null;
      const from = st.zones[c.zone];
      const to = resolveZone(st, action.to, actor);
      if (!(from.defId === 'hand' && to && st.zones[to].defId === T.zone)) {
        return `In this game you only play cards from your hand to the ${trickName}; everything else is automatic.`;
      }
      if (from.owner !== actor) return `That card is in ${player(st, from.owner)?.name}'s hand, not ${player(st, actor).name}'s.`;
      return legalMoves(project, st, actor).cards[action.card] || null;
    }
    case 'endTurn': return 'No need: the turn passes automatically when a card is played.';
    case 'draw': case 'flip': case 'shuffle': case 'phase':
      return `"${action.type}" is not part of this game - play a card to the ${trickName}.`;
    case 'counter': return A.autoScore ? 'Scoring is automatic in this game.' : null;
    default: return null;
  }
}

function checkShed(project, st, action, actor) {
  const A = automation(project);
  const S = shedCfg(project);
  const active = activePlayer(st);
  const pileName = st.zones[S.discardZone]?.name || 'discard pile';
  const turnMsg = actor !== active.id ? `It is ${active.name}'s turn, not ${player(st, actor).name}'s.` : null;
  switch (action.type) {
    case 'move': {
      const c = st.cards[action.card];
      if (!c) return null;
      const from = st.zones[c.zone];
      const to = resolveZone(st, action.to, actor);
      if (!(from.defId === 'hand' && to === S.discardZone)) return `In this game you play cards from your hand onto the ${pileName}, or draw a card; everything else is automatic.`;
      if (from.owner !== actor) return `That card is in ${player(st, from.owner)?.name}'s hand.`;
      return turnMsg || legalMoves(project, st, actor).cards[action.card] || null;
    }
    case 'draw': return turnMsg || (st.hand.drew ? 'You have already drawn this turn - play the drawn card or pass.' : null);
    case 'endTurn': return turnMsg || (st.hand.drew ? null : 'You must play a card or draw before you can pass.');
    case 'flip': case 'shuffle': case 'phase': return `"${action.type}" is not part of this game - play a card or draw.`;
    case 'counter': return A.autoScore ? 'Scoring is automatic in this game.' : null;
    default: return null;
  }
}

// ------------------------------------------------------------------ plain-English summary
export function describeAutomation(project) {
  const A = automation(project);
  const T = A.tricks || {};
  const zname = (id) => zoneDef(project, id)?.name || id;
  const cname = (id) => project.counters.find((c) => c.id === id)?.name || id;
  const lines = [];
  if (A.style === 'tricks') {
    lines.push(`Trick-taking: on your turn, play one card from your hand to the ${zname(T.zone)}. When everyone has played, the trick is won by the highest card${T.wonZone ? ` and goes face down to the winner's "${zname(T.wonZone)}"` : ''}. The winner leads the next trick.`);
    lines.push(T.followSuit
      ? `Follow suit: you must play the suit that was led if you can (suit = card stat "${T.suitStat}"; higher "${T.rankStat}" wins).`
      : `Any card may be played (suit = card stat "${T.suitStat}"; higher "${T.rankStat}" wins).`);
    lines.push({
      none: 'No trumps.',
      fixed: `${T.trumpSuit || '(no suit set)'} are trumps: a trump beats any card of another suit.`,
      lastDealt: 'Trumps: the last card dealt (to the dealer) is turned up; its suit is trumps for that hand. A trump beats any card of another suit.',
    }[T.trump] || 'No trumps.');
    lines.push(T.firstLead === 'dealer' ? 'The dealer leads the first trick of each hand.' : "The player to the dealer's left leads the first trick of each hand.");
    lines.push(T.redeal ? 'When the hands are empty the hand is scored, the deal passes to the left and the cards are re-dealt.' : 'When the hands are empty the game ends.');
  } else if (A.style === 'shedding') {
    const S = shedCfg(project);
    lines.push(`Shedding: on your turn, play one card from your hand onto the ${zname(S.discardZone)} if it matches the current colour (card stat "${S.colourStat}") or value (stat "${S.valueStat}") of the top card, or is a wild card.`);
    lines.push(`If you cannot or do not want to play, draw one card from the ${zname(S.drawZone)}. ${S.playDrawn ? 'If the drawn card can be played you may play it straight away, or pass and keep it; if not, the turn passes.' : 'Your turn then ends.'}`);
    lines.push(`Card effects (card stat "${S.effectStat}"): skip - the next player misses a turn; reverse - the direction of play changes (with 2 players it acts as skip); draw:N - the next player draws N cards and misses their turn; wild - play it on anything and choose the colour to follow${S.wildColour ? ` (cards whose colour is "${S.wildColour}" are wild)` : ''}.`);
    lines.push('The starting card is never an action or wild card. When the draw pile runs out, the discard pile (except its top card) is shuffled to form a new one.');
    lines.push((A.endWhen || []).length ? 'The first player to empty their hand wins the round; rounds are scored and a new round is dealt until the game ends.' : 'The first player to empty their hand wins the game.');
  } else {
    lines.push('Free-form: players (or AI seats) move cards and apply the rules themselves.');
  }
  if (A.teams === 'partners') lines.push('Partnerships: players sitting opposite each other are a team (with 4 players, seats 1 & 3 against seats 2 & 4).');
  lines.push(`Legal-move checking: ${ENFORCE[A.enforce] || A.enforce}${A.style === 'free' ? ' (free-form games have no move restrictions)' : ''}.`);
  if (A.scoring?.length) {
    lines.push(A.autoScore ? 'Scoring is automatic:' : 'Scoring rules (NOT automated - update counters by hand):');
    for (const r of A.scoring) {
      lines.push(`  • When ${SCORE_EVENTS[r.event] || r.event}, ${SCORE_WHO[r.who] || r.who} adds ${r.expr} to ${cname(r.counter)}${r.when ? ` if ${r.when}` : ''}${r.label ? ` - "${r.label}"` : ''}.`);
    }
  }
  for (const r of A.endWhen || []) {
    lines.push(`Game end: checked after ${END_AT[r.at] || r.at}; ends when ${r.expr} is true for any player. ${r.winner ? `The highest ${cname(r.winner)} wins.` : 'Those players win.'}${r.label ? ` ("${r.label}")` : ''}`);
  }
  return lines;
}
