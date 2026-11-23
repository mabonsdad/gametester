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
import { assignCards, bestTrickWith, bestTricks, compileSets } from './sets.js';

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
  if (def.visibility === 'owner') return (!!pid && z.owner === pid) || (!!st.revealed?.includes(z.defId) && def.layout !== 'hand');
  if (!c.faceUp) return st.revealed?.includes(z.defId) || false;
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
const KNOWN_STYLES = ['free', 'tricks', 'shedding', 'sets'];

export function createGame(project, { players, seed, options } = {}) {
  const style = project.automation?.style;
  if (style && !KNOWN_STYLES.includes(style)) {
    // An open page running older code than the project needs: playing on would ignore the rules.
    throw new Error(`This game uses rules ("${style}") that this copy of the app does not know yet. Reload the page to get the latest version.`);
  }
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
    announce: null, // announcements made this turn, before playing: { pid, ids }
    catchable: null, // a missed announcement that other players can still catch
    annStats: {}, // per player, per announcement: made / missed / caught / catches / unnecessary
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
  if (isSets(project) && st.hand && st.status === 'playing' && player(st, actor) && ['move', 'draw', 'swap', 'endTurn'].includes(a.type)) {
    setsApply(project, st, a, actor);
    return st;
  }
  if (st.catchable && ['move', 'draw', 'endTurn'].includes(a.type) && player(st, actor)) {
    log(st, 'system', 'announce', `Nobody caught ${player(st, st.catchable.pid).name} in time.`);
    st.catchable = null;
  }
  switch (a.type) {
    case 'move': {
      const c = st.cards[a.card];
      if (!c) throw new Error(`no card "${a.card}"`);
      const to = resolveZone(st, a.to, actor);
      if (!to) throw new Error(`no zone "${a.to}"`);
      const fromZid = c.zone;
      if (isShedPlay(project, st, fromZid, to) || isTrickPlay(project, st, fromZid, to)) {
        const owner = st.zones[fromZid].owner;
        const said = announcedIds(st, owner, a.announce);
        const before = requiredAnnouncements(project, st, owner, 'beforePlay');
        placeCard(project, st, a.card, to, { faceUp: true });
        const after = requiredAnnouncements(project, st, owner, 'afterPlay');
        const handNo = st.hand.number;
        if (isShedding(project)) {
          playShed(project, st, owner, a.card, a.choose);
        } else {
          log(st, owner, 'play', `${player(st, owner).name} played ${cardName(project, st, a.card)}`, { data: { card: a.card, from: fromZid, to } });
          playToTrick(project, st, owner, a.card);
        }
        // Announcements are settled after the play, unless the hand/round just ended.
        if (st.status === 'playing' && st.hand?.number === handNo) settleAnnouncements(project, st, owner, { ...before, ...after }, said);
        if (st.announce?.pid === owner) st.announce = null;
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
    case 'swap': {
      // Exchange two cards' places (zone and position).
      const x = st.cards[a.card];
      const y = st.cards[a.with];
      if (!x || !y) throw new Error(`no card "${x ? a.with : a.card}"`);
      swapCards(project, st, a.card, a.with);
      log(st, actor, 'swap', `${who} swapped ${cardName(project, st, a.card)} and ${cardName(project, st, a.with)}`, { data: { card: a.card, with: a.with } });
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
    case 'announce': {
      const rule = announcementRules(project).find((r) => r.id === a.id);
      if (!rule) throw new Error(`no announcement "${a.id}"`);
      if (!st.announce || st.announce.pid !== actor) st.announce = { pid: actor, ids: [] };
      if (!st.announce.ids.includes(a.id)) st.announce.ids.push(a.id);
      log(st, actor, 'announce', `${who}: "${rule.label}"`, { data: { id: a.id } });
      break;
    }
    case 'catch': {
      const C = st.catchable;
      if (!C) throw new Error('there is nobody to catch');
      if (actor === C.pid) throw new Error('you cannot catch yourself');
      st.catchable = null;
      const rule = announcementRules(project).find((r) => r.id === C.id);
      applyPenalty(project, st, C.pid, rule, player(st, actor) ? actor : null, true);
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
      if (announcementRules(project).length) {
        const pid = activePlayer(st).id;
        settleAnnouncements(project, st, pid, requiredAnnouncements(project, st, pid, 'afterPlay'), announcedIds(st, pid, a.announce));
        st.announce = null;
      }
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
  if (isSets(project) && st.hand && st.status === 'playing' && ['move', 'swap', 'flip'].includes(a.type)) setsRescore(project, st);
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
export const isSets = (project) => automation(project).style === 'sets';
export const isAutomated = (project) => isTricks(project) || isShedding(project) || isSets(project);

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
    pendingDraw: 0, // shedding with stacking: cards waiting for the next player
    pendingDrawSize: 0,
  };
  st.lastTrick = null;
  st.announce = null;
  st.catchable = null;
  if (!isSets(project)) log(st, 'system', 'hand', `${isShedding(project) ? 'Round' : 'Hand'} ${st.hand.number}: ${st.players[st.dealer].name} deals.`);
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
  if (isSets(project)) {
    startSets(project, st);
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
    announced: (id) => st.annStats?.[pid]?.[id]?.made || 0,
    missed: (id) => st.annStats?.[pid]?.[id]?.missed || 0,
    caught: (id) => st.annStats?.[pid]?.[id]?.caught || 0,
    catches: (id) => st.annStats?.[pid]?.[id]?.catches || 0,
    zoneCount: (zone, stat, value) => zoneCards(zone).filter((u) => matches(u, stat, value)).length,
    setPoints: (zone) => {
      const zid = resolveZone(st, zone, pid);
      return zid && isSets(project) ? zoneTricks(project, st, zid).total : 0;
    },
    pileLeft: isSets(project) ? (st.zones[setsCfg(project).drawZone]?.cards.length ?? 0) : (st.zones[packZone(project, st)]?.cards.length ?? 0),
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
  ['announced("lastCard"), missed("lastCard")', 'times the player made / missed a required announcement (whole game)'],
  ['caught("lastCard"), catches("lastCard")', 'times the player was caught / caught someone else'],
  ['any counter id (e.g. score)', "that player's counter"],
  ['wonCount("suit","Hearts")', 'cards in their tricks-won zone (optionally matching a stat)'],
  ['wonSum("points")', 'sum of a stat over their tricks-won zone'],
  ['zoneCount("haul"), zoneSum("haul","number")', 'the same for any zone'],
  ['setPoints("day")', 'set-collection games: the best score of the tricks in one of their zones (before any multiplier)'],
  ['pileLeft', 'cards left in the draw pile'],
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

const SHED_DEFAULTS = { drawZone: 'deck', discardZone: 'discard', colourStat: 'colour', valueStat: 'value', effectStat: 'effect', wildColour: 'Wild', playDrawn: true, stackDraws: 'off' };
const stacking = (project) => ['same', 'any'].includes(shedCfg(project).stackDraws);
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
  if (st.announce?.pid === pid) st.announce = null;
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
  const out = !st.zones[`${pid}.hand`].cards.length;
  if (fx.draw && stacking(project)) {
    H.pendingDraw = (H.pendingDraw || 0) + fx.draw;
    H.pendingDrawSize = fx.draw;
    if (out) {
      // Going out ends the round: the waiting cards are drawn now.
      const got = drawCards(project, st, victim.id, H.pendingDraw);
      log(st, 'system', 'effect', `${victim.name} draws ${got.length}.`);
      H.pendingDraw = 0;
    } else {
      log(st, 'system', 'effect', `${victim.name} must stack a draw card or take ${H.pendingDraw} card(s).`);
    }
  } else if (fx.draw) {
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
  if (H.pendingDraw > 0) {
    const n = H.pendingDraw;
    H.pendingDraw = 0;
    H.pendingDrawSize = 0;
    const got = drawCards(project, st, pid, n);
    log(st, pid, 'draw', `${who} takes ${got.length} card(s) and misses the turn: ${got.map((u) => cardName(project, st, u)).join(', ')}.`,
      { publicText: `${who} takes ${got.length} card(s) and misses the turn.` });
    shedAdvance(project, st, pid, 0);
    return;
  }
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
  if (H.pendingDraw > 0) {
    const any = shedCfg(project).stackDraws === 'any';
    for (const u of hand) {
      const d = cardEffects(project, st, u).draw;
      const ok = d > 0 && (any || d === H.pendingDrawSize);
      out.cards[u] = ok ? '' : `${H.pendingDraw} card(s) are waiting for you: stack ${any ? 'a draw card' : `another draw-${H.pendingDrawSize} card`} or take them.`;
      if (ok) out.legal.push(u);
    }
    out.canDraw = true;
    out.takeCount = H.pendingDraw;
    out.summary = out.legal.length
      ? `Stack a draw card to pass the penalty on, or take ${H.pendingDraw} card(s) and miss your turn.`
      : `Take ${H.pendingDraw} card(s) - you have no draw card to stack.`;
    return out;
  }
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

// ------------------------------------------------------------------ set collection
// Players take a few actions per turn (draw, swap with a face-up market card,
// play a card to one of their own scoring zones, or use a card to complete a
// trick in another player's zone and take that trick). Each scoring zone is
// worth the best split of its cards into combos (see sets.js) times the
// zone's multiplier. Secret zones (face down) are only added to the score
// when the game ends.

const SETS_DEFAULTS = {
  drawZone: 'deck', marketZone: 'market', discardZone: 'discard', actions: 2, handLimit: 6, valueStat: 'value',
  zones: [{ zone: 'day', multiplier: 2, secret: false }, { zone: 'night', multiplier: 1, secret: true }],
  giveZone: 'day', captureZone: 'night', giveNeedsTrick: true, counter: 'score', combos: [], endWhenEmpty: 'round',
};
export const setsCfg = (project) => ({ ...SETS_DEFAULTS, ...(automation(project).sets || {}) });
const setsC = (project) => compileSets(project, setsCfg(project));
export const setsCompiled = setsC;
const scoreZones = (project) => (setsCfg(project).zones || []).filter((z) => zoneDef(project, z.zone));
const mult = (z) => Number(z?.multiplier) || 1;

function scoreZoneOf(project, st, zid) {
  const z = st.zones[zid];
  return z?.owner ? scoreZones(project).find((s) => s.zone === z.defId) : null;
}

// The tricks in one zone: { total, tricks: [{ id, label, cards, points }], loose: [uids] }
export function zoneTricks(project, st, zid) {
  const uids = st.zones[zid]?.cards || [];
  const defOf = (u) => st.cards[u]?.defId;
  return assignCards(bestTricks(setsC(project), uids.map(defOf)), uids, defOf);
}

// Every scoring zone of a player, with tricks and points.
export function setsBreakdown(project, st, pid) {
  const zones = scoreZones(project).map((s) => {
    const zid = `${pid}.${s.zone}`;
    const r = zoneTricks(project, st, zid);
    return { zid, defId: s.zone, name: zoneDef(project, s.zone).name, multiplier: mult(s), secret: !!s.secret, raw: r.total, points: r.total * mult(s), tricks: r.tricks, loose: r.loose };
  });
  const pub = zones.filter((z) => !z.secret).reduce((a, z) => a + z.points, 0);
  const hidden = zones.filter((z) => z.secret).reduce((a, z) => a + z.points, 0);
  return { zones, public: pub, hidden, total: pub + hidden };
}

function setsRescore(project, st) {
  const S = setsCfg(project);
  if (!automation(project).autoScore) return;
  for (const p of st.players) {
    if (!(S.counter in p.counters)) continue;
    const b = setsBreakdown(project, st, p.id);
    p.counters[S.counter] = st.revealed ? b.total : b.public;
  }
}

function swapCards(project, st, a, b) {
  const ca = st.cards[a];
  const cb = st.cards[b];
  const za = st.zones[ca.zone];
  const zb = st.zones[cb.zone];
  const ia = za.cards.indexOf(a);
  const ib = zb.cards.indexOf(b);
  za.cards[ia] = b;
  zb.cards[ib] = a;
  [ca.zone, cb.zone] = [cb.zone, ca.zone];
  ca.faceUp = zoneDef(project, zb.defId)?.faceUp ?? true;
  cb.faceUp = zoneDef(project, za.defId)?.faceUp ?? true;
}

function startSets(project, st) {
  const H = st.hand;
  H.actionsUsed = 0;
  H.discarding = false;
  H.lastSeat = null;
  st.turn.active = nextSeat(project, st, st.dealer);
  st.turn.phase = 0;
  H.firstSeat = st.turn.active;
  setsRescore(project, st);
  log(st, 'system', 'turn', `Turn 1: ${activePlayer(st).name}.`);
}

function setsApply(project, st, a, actor) {
  const S = setsCfg(project);
  const H = st.hand;
  const who = player(st, actor).name;
  if (activePlayer(st).id !== actor) throw new Error(`It is ${activePlayer(st).name}'s turn.`);
  const handZ = `${actor}.hand`;
  const limit = Number(S.handLimit) || 0;
  const handCount = () => st.zones[handZ].cards.length;
  const discardZ = resolveZone(st, S.discardZone, actor);
  if (a.type === 'endTurn') {
    if (limit && handCount() > limit) {
      H.discarding = true;
      log(st, actor, 'turn', `${who} has ${handCount()} cards and must discard down to ${limit}.`);
      return;
    }
    log(st, actor, 'endTurn', `${who} ended their turn${H.actionsUsed < S.actions ? ` after ${H.actionsUsed} action${H.actionsUsed === 1 ? '' : 's'}` : ''}.`);
    setsAdvance(project, st);
    return;
  }
  const to = a.type === 'move' ? resolveZone(st, a.to, actor) : null;
  if (H.discarding && !(a.type === 'move' && to && to === discardZ)) throw new Error(`Discard down to ${limit} cards first.`);
  if (!H.discarding && H.actionsUsed >= S.actions) throw new Error('You have no actions left this turn.');
  if (a.type === 'draw') {
    const deck = st.zones[S.drawZone];
    const top = deck?.cards[deck.cards.length - 1];
    if (!top) throw new Error(`The ${deck?.name || 'draw pile'} is empty.`);
    placeCard(project, st, top, handZ);
    log(st, actor, 'draw', `${who} drew ${cardName(project, st, top)} from the ${deck.name}.`,
      { publicText: `${who} drew a card from the ${deck.name}.`, data: { from: deck.id, to: handZ, count: 1 } });
    setsUsed(project, st, actor);
    return;
  }
  if (a.type === 'swap') {
    const mine = st.cards[a.card];
    const theirs = st.cards[a.with];
    const market = st.zones[S.marketZone];
    if (!mine || mine.zone !== handZ) throw new Error('Swap a card from your own hand.');
    if (!theirs || theirs.zone !== S.marketZone) throw new Error(`Swap it for one of the face-up cards in the ${market?.name || 'market'}.`);
    const mineName = cardName(project, st, a.card);
    swapCards(project, st, a.card, a.with);
    log(st, actor, 'swap', `${who} swapped ${mineName} from their hand for ${cardName(project, st, a.with)} from the ${market.name}.`, { data: { card: a.card, with: a.with } });
    setsUsed(project, st, actor);
    return;
  }
  const c = st.cards[a.card];
  if (!c) throw new Error(`no card "${a.card}"`);
  if (c.zone !== handZ) throw new Error('Play cards from your own hand.');
  if (!to) throw new Error(`no zone "${a.to}"`);
  const name = cardName(project, st, a.card);
  const zone = st.zones[to];
  const zname = zoneDef(project, zone.defId)?.name || zone.name;
  if (to === discardZ) {
    if (!H.discarding) throw new Error(`You only discard when you have more than ${limit} cards at the end of your turn.`);
    placeCard(project, st, a.card, to, { faceUp: true });
    log(st, actor, 'discard', `${who} discarded ${name}.`, { data: { card: a.card, to } });
    if (handCount() <= limit) {
      H.discarding = false;
      setsAdvance(project, st);
    }
    return;
  }
  const sz = scoreZoneOf(project, st, to);
  if (zone.owner === actor && sz) {
    const before = zoneTricks(project, st, to);
    placeCard(project, st, a.card, to);
    const after = zoneTricks(project, st, to);
    const gain = (after.total - before.total) * mult(sz);
    const made = after.tricks.find((t) => t.cards.includes(a.card));
    const done = gain > 0 ? ` - ${made ? `completes a ${made.label}` : 'improves their tricks'}: +${gain}` : '';
    const faceUp = isPublicZone(project, st, to);
    const text = `${who} played ${name}${faceUp ? '' : ' face down'} to their ${zname}${done}.`;
    log(st, actor, 'play', text, { publicText: faceUp ? text : `${who} played a card face down to their ${zname}.`, data: { card: a.card, to, gain, combo: gain > 0 ? made?.label : undefined } });
    setsUsed(project, st, actor);
    return;
  }
  if (zone.owner && zone.owner !== actor && zone.defId === S.giveZone) {
    const C = setsC(project);
    const loose = zoneTricks(project, st, to).loose;
    const best = bestTrickWith(C, loose.map((u) => st.cards[u].defId), c.defId);
    const victim = player(st, zone.owner).name;
    if (!best && S.giveNeedsTrick !== false) throw new Error(`${name} does not complete a trick in ${victim}'s ${zname} (cards already in a finished trick cannot be used).`);
    placeCard(project, st, a.card, to, { faceUp: true });
    if (!best) {
      log(st, actor, 'give', `${who} gave ${name} to ${victim}'s ${zname}.`, { data: { card: a.card, to } });
    } else {
      const pool = loose.slice();
      const taken = [a.card];
      const need = best.defIds.slice();
      need.splice(need.indexOf(c.defId), 1);
      for (const d of need) taken.push(pool.splice(pool.findIndex((u) => st.cards[u].defId === d), 1)[0]);
      const dest = st.zones[`${actor}.${S.captureZone}`] ? `${actor}.${S.captureZone}` : handZ;
      const capZ = scoreZoneOf(project, st, dest);
      const before = capZ ? zoneTricks(project, st, dest).total : 0;
      for (const u of taken) placeCard(project, st, u, dest);
      const gain = capZ ? (zoneTricks(project, st, dest).total - before) * mult(capZ) : 0;
      const destName = zoneDef(project, st.zones[dest].defId)?.name || 'hand';
      log(st, actor, 'steal', `${who} put ${name} into ${victim}'s ${zname}, completing a ${best.label} (${taken.map((u) => cardName(project, st, u)).join(', ')}) - and took it to their ${destName}${gain > 0 ? `: +${gain}` : ''}!`,
        { data: { card: a.card, to, victim: zone.owner, cards: taken, combo: best.label, gain } });
    }
    setsUsed(project, st, actor);
    return;
  }
  const mine = scoreZones(project).map((z) => zoneDef(project, z.zone).name).join(' or ');
  throw new Error(`A card from your hand goes to your ${mine}${S.giveZone ? `, or into another player's ${zoneDef(project, S.giveZone)?.name} to complete a trick` : ''}.`);
}

function setsUsed(project, st, actor) {
  const S = setsCfg(project);
  const H = st.hand;
  H.actionsUsed++;
  setsRescore(project, st);
  noteEmptyPile(project, st);
  if (H.actionsUsed < S.actions) return;
  const limit = Number(S.handLimit) || 0;
  const n = st.zones[`${actor}.hand`].cards.length;
  if (limit && n > limit) {
    H.discarding = true;
    log(st, actor, 'turn', `${player(st, actor).name} has ${n} cards and must discard ${n - limit}.`);
    return;
  }
  setsAdvance(project, st);
}

function noteEmptyPile(project, st) {
  const S = setsCfg(project);
  const H = st.hand;
  const deck = st.zones[S.drawZone];
  if (!deck || deck.cards.length || H.lastSeat != null || S.endWhenEmpty === 'off') return;
  if (S.endWhenEmpty === 'now') {
    H.lastSeat = st.turn.active;
    log(st, 'system', 'final', `The ${deck.name} is empty: the game ends after this turn.`);
    return;
  }
  H.lastSeat = nextSeat(project, st, H.firstSeat, -1);
  const last = st.players[H.lastSeat];
  log(st, 'system', 'final', `The ${deck.name} is empty! ${last.id === activePlayer(st).id ? 'This is the last turn' : `Play goes on until ${last.name} has had a turn`}, so everyone has the same number of turns.`);
}

function setsAdvance(project, st) {
  const H = st.hand;
  snapshotTimeline(st);
  if (H.lastSeat != null && st.turn.active === H.lastSeat) {
    setsFinish(project, st, `the ${st.zones[setsCfg(project).drawZone]?.name || 'draw pile'} ran out`);
    return;
  }
  for (const r of automation(project).endWhen || []) {
    if (r.at !== 'turnEnd' || !r.expr) continue;
    const hit = st.players.some((p) => { try { return runExpr(r.expr, formulaScope(project, st, p.id)); } catch { return false; } });
    if (hit) { setsFinish(project, st, r.label || r.expr); return; }
  }
  H.actionsUsed = 0;
  H.discarding = false;
  st.turn.active = nextSeat(project, st, st.turn.active);
  st.turn.number++;
  log(st, 'system', 'turn', `Turn ${st.turn.number}: ${activePlayer(st).name}.`);
}

function setsFinish(project, st, reason) {
  const S = setsCfg(project);
  const secret = scoreZones(project).filter((z) => z.secret).map((z) => z.zone);
  st.revealed = secret;
  for (const c of Object.values(st.cards)) if (secret.includes(st.zones[c.zone].defId)) c.faceUp = true;
  const before = Object.fromEntries(st.players.map((p) => [p.id, { ...p.counters }]));
  setsRescore(project, st);
  if (secret.length) log(st, 'system', 'hand', `Dawn breaks: the face-down ${secret.map((z) => zoneDef(project, z).name).join(' and ')} are revealed.`);
  const scoreLines = st.players.map((p) => {
    const b = setsBreakdown(project, st, p.id);
    const parts = b.zones.map((z) => `${z.name} ${z.raw}${z.multiplier !== 1 ? ` ×${z.multiplier} = ${z.points}` : ''}${z.tricks.length ? ` (${z.tricks.map((t) => t.label).join(', ')})` : ''}`);
    const line = `${p.name}: ${parts.join('; ')} → ${b.total} points.`;
    log(st, 'system', 'score', line);
    return line;
  });
  const c = S.counter;
  const best = Math.max(...st.players.map((p) => p.counters[c] ?? 0));
  const winners = st.players.filter((p) => (p.counters[c] ?? 0) === best).map((p) => p.id);
  st.lastHand = {
    number: 1,
    summary: `Game over - ${reason}.`,
    winner: null,
    scoreLines,
    tricks: null,
    changes: st.players.map((p) => ({ id: p.id, name: p.name, deltas: Object.fromEntries(Object.keys(p.counters).map((k) => [k, p.counters[k] - (before[p.id][k] ?? 0)])), totals: { ...p.counters } })),
  };
  snapshotTimeline(st);
  finishGame(st, winners, reason.charAt(0).toUpperCase() + reason.slice(1), 'system');
}

function setsLegal(project, st, pid, out) {
  const S = setsCfg(project);
  const H = st.hand;
  const C = setsC(project);
  const hand = st.zones[`${pid}.hand`]?.cards || [];
  const limit = Number(S.handLimit) || 0;
  const nm = (u) => cardName(project, st, u);
  const discardZ = resolveZone(st, S.discardZone, pid);
  out.options = [];
  out.actionsLeft = Math.max(0, S.actions - H.actionsUsed);
  out.actionsPerTurn = S.actions;
  out.discarding = !!H.discarding;
  out.handLimit = limit;
  out.target = null;
  if (H.discarding) {
    for (const u of hand) {
      out.cards[u] = '';
      out.legal.push(u);
      out.options.push({ kind: 'discard', card: u, to: discardZ, label: `Discard ${nm(u)}`, action: { type: 'move', card: u, to: discardZ } });
    }
    out.summary = `You have ${hand.length} cards: discard ${hand.length - limit} to get down to ${limit}.`;
    return out;
  }
  out.canPass = true;
  if (!out.actionsLeft) {
    for (const u of hand) out.cards[u] = 'No actions left this turn.';
    out.options.push({ kind: 'end', label: 'End your turn', action: { type: 'endTurn' } });
    out.summary = 'No actions left: end your turn.';
    return out;
  }
  const deck = st.zones[S.drawZone];
  out.canDraw = !!deck?.cards.length;
  if (out.canDraw) out.options.push({ kind: 'draw', label: `Draw a card from the ${deck.name}`, action: { type: 'draw' }, gain: 0 });
  const market = st.zones[S.marketZone]?.cards || [];
  const marketName = st.zones[S.marketZone]?.name || 'market';
  const defs = (zid) => (st.zones[zid]?.cards || []).map((u) => st.cards[u].defId);
  const own = scoreZones(project).map((s) => ({ s, zid: `${pid}.${s.zone}` })).filter((x) => st.zones[x.zid]);
  const ownBase = own.map((x) => bestTricks(C, defs(x.zid)).total);
  const giveName = zoneDef(project, S.giveZone)?.name || '';
  const capZ = scoreZones(project).find((z) => z.zone === S.captureZone);
  const opps = S.giveZone ? st.players.filter((o) => o.id !== pid).map((o) => ({ o, zid: `${o.id}.${S.giveZone}` })).filter((x) => st.zones[x.zid]) : [];
  const oppLoose = opps.map((x) => zoneTricks(project, st, x.zid).loose.map((u) => st.cards[u].defId));
  for (const u of hand) {
    out.cards[u] = '';
    out.legal.push(u);
    const d = st.cards[u].defId;
    own.forEach((x, i) => {
      const gain = (bestTricks(C, [...defs(x.zid), d]).total - ownBase[i]) * mult(x.s);
      const zname = zoneDef(project, x.s.zone).name;
      const up = isPublicZone(project, st, x.zid);
      out.options.push({ kind: 'play', card: u, to: x.zid, gain, label: `Play to your ${zname}${up ? '' : ' (face down)'}${gain > 0 ? ` - completes a trick: +${gain}` : ''}`, action: { type: 'move', card: u, to: x.zid } });
    });
    opps.forEach((x, i) => {
      const best = bestTrickWith(C, oppLoose[i], d);
      if (!best && S.giveNeedsTrick !== false) return;
      out.options.push({
        kind: 'give', card: u, to: x.zid, victim: x.o.id, gain: best ? best.points * mult(capZ) : 0,
        label: best ? `Complete ${x.o.name}'s ${best.label} and take it (+${best.points * mult(capZ)})` : `Give to ${x.o.name}'s ${giveName}`,
        action: { type: 'move', card: u, to: x.zid },
      });
    });
    for (const m of market) out.options.push({ kind: 'swap', card: u, with: m, gain: 0, label: `Swap for ${nm(m)} (${marketName})`, action: { type: 'swap', card: u, with: m } });
  }
  out.options.push({ kind: 'end', label: 'End your turn now', action: { type: 'endTurn' } });
  const can = [out.canDraw ? 'draw a card' : '', market.length ? `swap a card with one of the ${marketName}` : '', 'play a card to your tricks',
    out.options.some((o) => o.kind === 'give') ? "complete a trick in another player's zone" : ''].filter(Boolean);
  out.summary = `${out.actionsLeft} action${out.actionsLeft === 1 ? '' : 's'} left: ${can.join(', ')}.`;
  return out;
}

function checkSets(project, st, action, actor) {
  const S = setsCfg(project);
  const active = activePlayer(st);
  if (['move', 'draw', 'swap', 'endTurn'].includes(action.type) && actor !== active.id) return `It is ${active.name}'s turn, not ${player(st, actor).name}'s.`;
  const lm = legalMoves(project, st, actor);
  switch (action.type) {
    case 'draw':
      return lm.discarding ? `Discard down to ${lm.handLimit} cards first.` : !lm.actionsLeft ? 'You have no actions left - end your turn.' : !lm.canDraw ? 'The draw pile is empty.' : null;
    case 'swap':
    case 'move': {
      const to = action.type === 'move' ? resolveZone(st, action.to, actor) : null;
      const ok = lm.options.some((o) => o.action.type === action.type && o.action.card === action.card && (action.type === 'swap' ? o.action.with === action.with : o.action.to === to));
      if (ok) return null;
      if (lm.discarding) return `Discard down to ${lm.handLimit} cards first: move a card from your hand to the ${st.zones[S.discardZone]?.name || 'discard pile'}.`;
      if (!lm.actionsLeft) return 'You have no actions left - end your turn.';
      const c = st.cards[action.card];
      if (!c || c.zone !== `${actor}.hand`) return 'Use a card from your own hand.';
      if (action.type === 'swap') return `Swap it for one of the face-up cards in the ${st.zones[S.marketZone]?.name || 'market'}.`;
      const z = to && st.zones[to];
      if (z?.owner && z.owner !== actor && z.defId === S.giveZone) return `${cardName(project, st, action.card)} does not complete a trick in ${player(st, z.owner).name}'s ${zoneDef(project, z.defId).name} (cards already in a finished trick cannot be used).`;
      if (to === resolveZone(st, S.discardZone, actor)) return `You only discard when you have more than ${lm.handLimit} cards at the end of your turn.`;
      return `Play it to your own ${scoreZones(project).map((x) => zoneDef(project, x.zone).name).join(' or ')}, swap it, or use it to complete a trick in another player's ${zoneDef(project, S.giveZone)?.name || 'zone'}.`;
    }
    case 'endTurn': return null;
    case 'flip': case 'shuffle': case 'phase': return `"${action.type}" is not part of this game.`;
    case 'counter': return automation(project).autoScore ? 'Scoring is automatic in this game.' : null;
    default: return null;
  }
}

// A simple heuristic player for set-collection games (the "quick bot").
// Returns the actions for the rest of the turn, stopping after a draw (the
// drawn card is not known until it is drawn).
export function setsBotTurn(project, st, pid) {
  const sim = clone({ ...st, log: [], timeline: [] });
  const out = [];
  for (let k = 0; k < 12; k++) {
    if (sim.status !== 'playing' || activePlayer(sim).id !== pid) break;
    const a = setsBotChoice(project, sim, pid);
    if (!a) break;
    out.push(a);
    try { apply(project, sim, { ...a, actor: pid }); } catch { break; }
    if (a.type === 'draw' || a.type === 'endTurn') break;
  }
  return out;
}

function setsBotChoice(project, st, pid) {
  const S = setsCfg(project);
  const C = setsC(project);
  const lm = legalMoves(project, st, pid);
  if (!lm) return null;
  const def = (u) => st.cards[u].defId;
  const hand = st.zones[`${pid}.hand`].cards;
  const handDefs = hand.map(def);
  const zones = scoreZones(project);
  const safe = zones.find((z) => z.secret) || zones.slice().sort((a, b) => mult(a) - mult(b))[0];
  const safeZ = safe ? `${pid}.${safe.zone}` : null;
  const safeLoose = safeZ && st.zones[safeZ] ? zoneTricks(project, st, safeZ).loose.map(def) : [];
  const plan = (cards) => bestTricks(C, [...cards, ...safeLoose]).total;
  const find = (pred) => lm.options.find(pred)?.action || null;
  if (lm.discarding) {
    let pick = null; let bestLeft = -1;
    for (const [i, u] of hand.entries()) {
      const left = plan(handDefs.filter((_, j) => j !== i)) * 100 - (C.values[def(u)] || 0);
      if (left > bestLeft) { bestLeft = left; pick = u; }
    }
    return find((o) => o.kind === 'discard' && o.card === pick);
  }
  if (!lm.actionsLeft) return { type: 'endTurn' };
  // 1. Take a trick from someone, or finish one of my own.
  const now = lm.options.filter((o) => (o.kind === 'give' || o.kind === 'play') && o.gain > 0).sort((a, b) => b.gain - a.gain)[0];
  if (now) return now.action;
  // 2. A trick I can finish this turn in a face-up (multiplied) zone: start it now.
  const left = lm.actionsLeft;
  let start = null;
  for (const z of zones.filter((x) => !x.secret)) {
    const zid = `${pid}.${z.zone}`;
    const loose = zoneTricks(project, st, zid).loose.map(def);
    for (const t of bestTricks(C, [...loose, ...handDefs]).tricks) {
      const pool = loose.slice();
      const fromHand = t.defIds.filter((d) => { const i = pool.indexOf(d); if (i >= 0) { pool.splice(i, 1); return false; } return true; });
      if (!fromHand.length || fromHand.length > left) continue;
      const value = t.points * mult(z);
      if (!start || value > start.value) start = { value, zid, card: hand[handDefs.indexOf(fromHand[0])] };
    }
  }
  if (start && (!safe || start.value > 0)) return find((o) => o.kind === 'play' && o.card === start.card && o.to === start.zid);
  // 3. Build a trick in the safe (face-down) zone.
  if (safeZ) {
    const r = bestTricks(C, [...safeLoose, ...handDefs]);
    const pool = safeLoose.slice();
    const candidates = r.tricks.map((t) => {
      const p = pool.slice();
      const fromHand = t.defIds.filter((d) => { const i = p.indexOf(d); if (i >= 0) { p.splice(i, 1); return false; } return true; });
      return { t, fromHand };
    }).filter((x) => x.fromHand.length).sort((a, b) => a.fromHand.length - b.fromHand.length || b.t.points - a.t.points);
    if (candidates.length) {
      const card = hand[handDefs.indexOf(candidates[0].fromHand[0])];
      const a = find((o) => o.kind === 'play' && o.card === card && o.to === safeZ);
      if (a) return a;
    }
  }
  // 4. Swap for a face-up card that makes a new trick possible.
  const base = plan(handDefs);
  let swap = null;
  for (const o of lm.options.filter((x) => x.kind === 'swap')) {
    const i = hand.indexOf(o.card);
    const gain = plan([...handDefs.filter((_, j) => j !== i), def(o.with)]) - base;
    if (gain > 0 && (!swap || gain > swap.gain)) swap = { gain, a: o.action };
  }
  if (swap) return swap.a;
  // 5. Draw while there is room in the hand.
  const limit = lm.handLimit || 99;
  if (lm.canDraw && hand.length < limit) return { type: 'draw' };
  // 6. A full hand: commit the most common card type towards a future trick.
  if (safeZ && hand.length) {
    const count = (d) => handDefs.filter((x) => x === d).length + safeLoose.filter((x) => x === d).length;
    const card = hand.slice().sort((a, b) => count(def(b)) - count(def(a)))[0];
    const a = find((o) => o.kind === 'play' && o.card === card && o.to === safeZ);
    if (a && count(def(card)) > 1) return a;
  }
  if (lm.canDraw) return { type: 'draw' };
  return { type: 'endTurn' };
}

// ------------------------------------------------------------------ announcements
// Things a player must say around playing a card ("Last card!"). Each rule:
//   { id, label, check: 'afterPlay' | 'beforePlay', when: formula,
//     ifMissed: 'catch' | 'auto' | 'none', penaltyDraw, penaltyCounter,
//     penaltyAmount: formula, aiCatch: % chance an AI opponent catches, remind }
// 'when' is evaluated for the player who plays, before or after the card
// leaves their hand. Free-form games check 'afterPlay' rules at end of turn.

export const announcementRules = (project) => (automation(project).announcements || []).filter((r) => r.id && r.label);

function annStat(st, pid, id) {
  st.annStats ||= {};
  st.annStats[pid] ||= {};
  return (st.annStats[pid][id] ||= { made: 0, missed: 0, caught: 0, catches: 0, unnecessary: 0 });
}

function announcedIds(st, pid, extra) {
  const ids = st.announce?.pid === pid ? [...st.announce.ids] : [];
  for (const id of [].concat(extra || [])) if (!ids.includes(id)) ids.push(id);
  return ids;
}

function requiredAnnouncements(project, st, pid, check) {
  const out = {};
  for (const r of announcementRules(project)) {
    if ((r.check || 'afterPlay') !== check || !r.when) continue;
    try {
      out[r.id] = !!runExpr(r.when, formulaScope(project, st, pid));
    } catch (e) {
      log(st, 'system', 'note', `⚠ Announcement "${r.label}" condition failed: ${e.message}`);
    }
  }
  return out;
}

// Which announcements playing `uid` now would require of pid (for bots and reminders).
export function announcementsDue(project, st, pid, uid) {
  const rules = announcementRules(project);
  if (!rules.length || !st.hand) return [];
  const before = requiredAnnouncements(project, st, pid, 'beforePlay');
  const sim = clone(st);
  sim.log = [];
  const target = isShedding(project) ? shedCfg(project).discardZone : resolveZone(sim, automation(project).tricks.zone, pid);
  if (!target || !sim.cards[uid]) return [];
  placeCard(project, sim, uid, target, { faceUp: true });
  const after = requiredAnnouncements(project, sim, pid, 'afterPlay');
  return rules.filter((r) => before[r.id] || after[r.id]).map((r) => r.id);
}

function settleAnnouncements(project, st, pid, required, said) {
  const name = player(st, pid).name;
  for (const r of announcementRules(project)) {
    const need = !!required[r.id];
    const made = said.includes(r.id);
    const s = annStat(st, pid, r.id);
    if (need && made) {
      s.made++;
      log(st, 'system', 'announce', `${name} said "${r.label}" in time.`);
      fireScoring(project, st, 'announcement', { actor: pid });
    } else if (need && !made) {
      s.missed++;
      if (r.ifMissed === 'auto') {
        applyPenalty(project, st, pid, r, null);
      } else if (r.ifMissed === 'none') {
        log(st, 'system', 'announce', `${name} did not say "${r.label}" (no penalty in this game).`);
      } else {
        st.catchable = { pid, id: r.id, label: r.label };
        log(st, 'system', 'announce', `${name} did not say "${r.label}"! Any other player can catch them until the next player acts.`);
      }
    } else if (made) {
      s.unnecessary++;
      log(st, 'system', 'announce', `${name} said "${r.label}" but did not need to.`);
    }
  }
}

function applyPenalty(project, st, pid, rule, catcher, viaCatch = false) {
  const name = player(st, pid).name;
  const parts = [];
  const n = parseInt(rule?.penaltyDraw, 10) || 0;
  if (n > 0 && isShedding(project) && st.hand) {
    const got = drawCards(project, st, pid, n);
    parts.push(`draws ${got.length} card(s)`);
  }
  if (rule?.penaltyCounter && rule.penaltyAmount) {
    try {
      const amount = Number(runExpr(rule.penaltyAmount, formulaScope(project, st, pid))) || 0;
      const p = player(st, pid);
      if (rule.penaltyCounter in p.counters && amount) {
        p.counters[rule.penaltyCounter] += amount;
        parts.push(`${amount > 0 ? '+' : ''}${amount} ${project.counters.find((c) => c.id === rule.penaltyCounter)?.name || rule.penaltyCounter}`);
      }
    } catch (e) {
      log(st, 'system', 'note', `⚠ Penalty for "${rule.label}" failed: ${e.message}`);
    }
  }
  if (viaCatch) annStat(st, pid, rule.id).caught++;
  if (catcher) annStat(st, catcher, rule.id).catches++;
  const how = catcher ? `was caught by ${player(st, catcher).name}` : viaCatch ? 'was caught by the referee' : 'forgot';
  log(st, 'system', 'penalty', `${name} ${how}: "${rule?.label}" was not said - ${parts.join(', ') || 'no penalty'}.`,
    { data: { player: pid, catcher, id: rule?.id } });
  fireScoring(project, st, 'penalty', { actor: pid, winner: catcher || undefined });
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
  if (isSets(project)) return setsLegal(project, st, pid, out);
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
  if (action.type === 'announce') {
    if (!announcementRules(project).some((r) => r.id === action.id)) return `There is no announcement "${action.id}" in this game.`;
    return actor !== activePlayer(st).id ? 'You can only make an announcement on your own turn.' : null;
  }
  if (action.type === 'catch') {
    if (!st.catchable) return 'There is nobody to catch.';
    return st.catchable.pid === actor ? 'You cannot catch yourself.' : null;
  }
  if (isShedding(project)) return checkShed(project, st, action, actor);
  if (isSets(project)) return checkSets(project, st, action, actor);
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
    case 'endTurn': return turnMsg || (st.hand.pendingDraw ? `Stack a draw card or take the ${st.hand.pendingDraw} waiting card(s).` : st.hand.drew ? null : 'You must play a card or draw before you can pass.');
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
    if (S.stackDraws === 'same' || S.stackDraws === 'any') {
      lines.push(`Stacking: when a draw card is played on you, you may play ${S.stackDraws === 'same' ? 'another draw card of the same size (+2 on +2, +4 on +4)' : 'any draw card'} to pass the total on to the next player; otherwise you take all the waiting cards and miss your turn.`);
    }
    lines.push('The starting card is never an action or wild card. When the draw pile runs out, the discard pile (except its top card) is shuffled to form a new one.');
    lines.push((A.endWhen || []).length ? 'The first player to empty their hand wins the round; rounds are scored and a new round is dealt until the game ends.' : 'The first player to empty their hand wins the game.');
  } else if (A.style === 'sets') {
    const S = setsCfg(project);
    const zn = (id) => zoneDef(project, id)?.name || id;
    const zs = scoreZones(project);
    lines.push(`Set collection: on your turn take up to ${S.actions} action${S.actions === 1 ? '' : 's'} (the same one more than once is fine): draw a card from the ${zn(S.drawZone)}; ${zoneDef(project, S.marketZone) ? `swap a card from your hand for a face-up card in the ${zn(S.marketZone)} (it takes that card's place); ` : ''}play a card from your hand to your ${zs.map((z) => `${zn(z.zone)}${zoneDef(project, z.zone)?.faceUp === false ? ' (face down)' : ' (face up)'}`).join(' or ')}${zoneDef(project, S.giveZone) ? `; or put a card into another player's ${zn(S.giveZone)}${S.giveNeedsTrick !== false ? ' when it completes a trick there' : ''} - you then take the whole trick to your ${zn(S.captureZone)}` : ''}.`);
    lines.push(`Scoring: each zone scores the best way of splitting its cards into the tricks below - each card counts in at most one trick, and cards in no trick score nothing. A trick is worth the sum of its cards' "${S.valueStat}" stat unless noted, times the zone's multiplier: ${zs.map((z) => `${zn(z.zone)} ×${mult(z)}${z.secret ? ' (kept secret until the end of the game)' : ''}`).join(', ')}.`);
    if (zoneDef(project, S.giveZone)) lines.push(`Cards that are already part of a finished trick are safe: only a player's loose cards can be used to complete a trick in their ${zn(S.giveZone)}.`);
    if (Number(S.handLimit)) lines.push(`Hand limit: at the end of your turn you must discard down to ${S.handLimit} cards.`);
    lines.push('Tricks:');
    const C = setsC(project);
    for (const cb of C.combos) lines.push(`  • ${cb.label}: ${cb.slots.map((s) => s.text).join(' + ')}${cb.points && cb.points !== 'sum' ? ` - scores ${cb.points} (sum = the cards' values)` : ''}`);
    for (const e of C.errors) lines.push(`  ⚠ ${e}`);
    lines.push({
      round: `When the ${zn(S.drawZone)} runs out, play continues until everyone has had the same number of turns; then the game ends${zs.some((z) => z.secret) ? ', secret zones are revealed and scored,' : ''} and the highest score wins.`,
      now: `When the ${zn(S.drawZone)} runs out the game ends after that turn${zs.some((z) => z.secret) ? '; secret zones are revealed and scored' : ''}, and the highest score wins.`,
      off: 'The game ends only by the end conditions below.',
    }[S.endWhenEmpty] || '');
  } else {
    lines.push('Free-form: players (or AI seats) move cards and apply the rules themselves.');
  }
  for (const r of announcementRules(project)) {
    const missed = {
      catch: 'any other player may catch them until the next player acts',
      auto: 'the penalty is applied automatically',
      none: 'nothing happens (it is only recorded)',
    }[r.ifMissed || 'catch'];
    const pen = [parseInt(r.penaltyDraw, 10) > 0 && isShedding(project) ? `draw ${r.penaltyDraw} card(s)` : '',
      r.penaltyCounter && r.penaltyAmount ? `${r.penaltyAmount} to ${cname(r.penaltyCounter)}` : ''].filter(Boolean).join(' and ');
    lines.push(`Announcement "${r.label}" (id ${r.id}): must be said ${r.check === 'beforePlay' ? 'before' : 'when'} playing a card if ${r.when} ${r.check === 'beforePlay' ? 'before' : 'after'} the play. If a player forgets, ${missed}${pen && r.ifMissed !== 'none' ? `; penalty: ${pen}` : ''}.`);
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
