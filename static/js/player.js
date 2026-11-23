// Player view: a polished "you against the AI" version of any project.
//
// Opened from the test bench (play.html#p=<projectId>, uses the tester login)
// or from a share link (play.html#s=<token>, no login: the link gives access to
// that one game). Everything works from the project definition, so new games
// need no code. Every game is saved as a normal session - with what the player
// chose, how long their moves took, and when they opened the rules - so it can
// be opened in the test bench's log and insights.
import * as api from './api.js';
import { isAI, randomBot } from './ai.js';
import {
  activePlayer, announcementRules, apply, automation, cardDef, cardEffects, checkAction, competitors, createGame,
  describeAutomation, isAutomated, isSets, isShedding, isTricks, isVisibleTo, legalMoves, player, setsBreakdown, setsCfg, shedColours, shedTop,
  teamOf, zoneTricks,
} from './engine.js';
import { SUITS, applyVariants, normalizeProject, uid, zoneDef } from './model.js';
import { finishTurn, rollAiCatch, takeAiTurn } from './turns.js';
import { cardBack, cardFace, h, modal, toast } from './ui.js';
import { showReloadBar, watchVersion } from './version.js';

const app = document.getElementById('app');
const HUMAN = 'p1';
const OPPONENTS = [['Ava', '🦊'], ['Ben', '🐻'], ['Cai', '🦉'], ['Dot', '🐢'], ['Eli', '🐙']];
const PROVIDERS = {
  random: { label: 'Quick bots', note: 'instant moves, simple tactics' },
  anthropic: { label: 'Claude', note: 'thinks for a few seconds each turn' },
  openai: { label: 'ChatGPT', note: 'thinks for a few seconds each turn' },
};
const CONTROLLER = { random: 'ai-random', anthropic: 'ai-anthropic', openai: 'ai-openai' };
const PREFS_KEY = 'cgtb.player';

let base = null; // the project as defined
let game = null; // the project with the player's options applied
let st = null;
let session = null;
let shareInfo = null; // { label, providers } in share-link mode
let providers = ['random'];
let choices = null; // last welcome-screen choices, for "Play again"
let avatars = {}; // pid -> emoji
let bubbles = {}; // pid -> last action text (shown as a speech bubble)
let feed = []; // recent public events
let thinking = null; // pid of the AI currently thinking
let running = false;
let turnStartedAt = Date.now();
let lastHandSeen = 0;
let saveTimer = null;
let saveFailed = false;
let sel = null; // set-collection games: the hand card the player has picked up

// "&fast=1" in the address shortens the pauses between AI moves (for testing).
const SPEED = /(?:^|[#&])fast=1/.test(location.hash) ? 0.12 : 1;
const wait = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));
const prefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ } };
const me = () => player(st, HUMAN);
const myTurn = () => st.status === 'playing' && !st.pending && activePlayer(st).id === HUMAN;
const isMate = (pid) => pid === HUMAN || (teamOf(st, HUMAN)?.players || []).includes(pid);
const cname = (u) => cardDef(game, st, u)?.name || u;

// ================================================================ boot
async function boot() {
  const hash = location.hash.replace(/^#/, '');
  const token = (hash.match(/(?:^|&)s=([\w-]+)/) || [])[1];
  const pid = (hash.match(/(?:^|&)p=([\w-]+)/) || [])[1];
  await api.init();
  try {
    if (token) {
      api.useShare(token);
      const r = await api.getSharedGame();
      base = normalizeProject(r.project);
      shareInfo = r.share;
      providers = r.share.providers?.length ? r.share.providers : ['random'];
      // Card images come through the link's own media route.
      const fix = (u) => (u && u.startsWith('media/') ? `api/play/${token}/media/${u.split('/').pop()}` : u);
      base.cards.forEach((c) => { c.image = fix(c.image); });
      base.cardBack.image = fix(base.cardBack.image);
    } else if (pid) {
      if (api.needsLogin()) return message('Please log in to the test bench first', h('a', { class: 'btn primary', href: './' }, 'Go to the test bench'));
      base = normalizeProject(await api.getProject(pid));
      const ai = api.serverInfo()?.ai || {};
      providers = ['random', ai.anthropic?.keySet && ai.anthropic?.sdkInstalled ? 'anthropic' : null, ai.openai?.keySet && ai.openai?.model ? 'openai' : null].filter(Boolean);
    } else {
      return message('No game selected', h('p', {}, 'Open this page from a project in the test bench, or from a share link.'));
    }
  } catch (e) {
    return message('This game is not available', h('p', {}, e.message));
  }
  document.title = base.name;
  welcome();
}

function message(title, body) {
  app.replaceChildren(h('div', { class: 'pv-welcome' }, h('div', { class: 'pv-panel' }, h('h1', {}, title), body)));
}

// ================================================================ welcome & options
function welcome() {
  const p = prefs();
  const minP = Math.max(2, base.players.min || 2);
  const maxP = Math.max(minP, Math.min(6, base.players.max || 6));
  const counts = [];
  for (let n = minP; n <= maxP; n++) counts.push(n);
  const defCount = choices?.count || Math.min(Math.max(base.players.default || minP, minP), maxP);
  const nameIn = h('input', { type: 'text', value: choices?.name || p.name || '', placeholder: 'Your name', maxlength: 20 });
  const countSel = counts.length > 1 ? h('select', {}, counts.map((n) => h('option', { value: String(n), selected: n === defCount }, `${n - 1} AI opponent${n > 2 ? 's' : ''}`))) : null;
  const variantSels = (base.variants || []).map((v) => {
    const sel = h('select', {}, v.choices.map((c, i) => h('option', { value: String(i), selected: i === (choices?.picks?.[v.id] ?? v.default ?? 0) }, c.label)));
    return { v, sel };
  });
  const provider = { value: choices?.provider || (providers.includes(p.provider) ? p.provider : providers[0]) };
  const provBox = h('div', { class: 'pv-choices' }, providers.map((id) => h('label', { class: `pv-choice ${provider.value === id ? 'on' : ''}` },
    h('input', { type: 'radio', name: 'prov', checked: provider.value === id, onchange: () => { provider.value = id; provBox.querySelectorAll('.pv-choice').forEach((n) => n.classList.toggle('on', n.querySelector('input').checked)); } }),
    h('b', {}, PROVIDERS[id]?.label || id), h('span', {}, PROVIDERS[id]?.note || ''))));
  const teams = automation(base).teams === 'partners';
  app.replaceChildren(h('div', { class: 'pv-welcome' },
    h('div', { class: 'pv-panel' },
      h('div', { class: 'pv-title' }, h('span', { class: 'pv-logo' }, '🂡'), h('div', {}, h('h1', {}, base.name), base.description ? h('p', { class: 'muted' }, base.description) : null)),
      h('details', { class: 'pv-howto', open: true }, h('summary', {}, 'How to play'), rulesContent(base, true)),
      h('div', { class: 'pv-form' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Your name'), nameIn),
        countSel ? h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Opponents'), countSel) : h('p', { class: 'muted small' }, `${defCount} players: you and ${defCount - 1} AI opponents${teams ? ' (you are partnered with the player opposite you)' : ''}.`),
        variantSels.map(({ v, sel }) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, v.label), sel, v.description ? h('small', { class: 'hint' }, v.description) : null)),
        providers.length > 1 ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Who are you playing against?'), provBox) : null,
        h('button', {
          class: 'btn primary pv-start',
          onclick: () => {
            choices = {
              name: nameIn.value.trim() || 'You',
              count: countSel ? parseInt(countSel.value, 10) : defCount,
              picks: Object.fromEntries(variantSels.map(({ v, sel }) => [v.id, parseInt(sel.value, 10)])),
              provider: provider.value,
            };
            savePrefs({ name: choices.name === 'You' ? '' : choices.name, provider: choices.provider });
            start();
          },
        }, 'Start game ▶')),
      shareInfo ? h('p', { class: 'muted small pv-fine' }, 'Games are recorded to help improve this game while it is being designed.') : null)));
  nameIn.focus();
}

// The rulebook as written by the designer. The welcome screen shows the
// essentials; the in-game pop-up adds the rest and, folded away, the exact
// automated rules (formulas and all) the app uses.
function rulesContent(project, brief = false) {
  const r = project.rules || {};
  const sec = (title, text) => (text && String(text).trim() ? [h('h4', {}, title), h('p', { class: 'pre' }, text)] : null);
  const auto = describeAutomation(project).filter((l) => !/^Legal-move checking/.test(l));
  const any = ['overview', 'objective', 'turnRules', 'endGame', 'scoring'].some((k) => r[k]?.trim());
  return h('div', { class: `pv-rules ${brief ? 'brief' : ''}` },
    sec('The game', r.overview), sec('How to win', r.objective), sec('On your turn', r.turnRules),
    [sec('End of the game', r.endGame), sec('Scoring', r.scoring)],
    !any ? h('p', { class: 'muted' }, 'This game has no written rules yet.') : null,
    !brief && auto.length ? h('details', { class: 'pv-exact' }, h('summary', {}, 'Exact rules the app uses'),
      h('ul', {}, auto.map((l) => h('li', { class: l.startsWith('  ') ? 'sub' : '' }, l.trim())))) : null);
}

// ================================================================ start / save
function start() {
  game = applyVariants(base, choices.picks);
  const n = choices.count;
  const opp = OPPONENTS.slice(0, n - 1);
  avatars = { [HUMAN]: '🙂' };
  const players = [{ name: choices.name, controller: 'human' }];
  opp.forEach(([name, emoji], i) => { players.push({ name, controller: CONTROLLER[choices.provider] || 'ai-random' }); avatars[`p${i + 2}`] = emoji; });
  try {
    st = createGame(game, { players, options: { pauseTricks: isTricks(game), pauseHands: true } });
  } catch (e) {
    return message('This game cannot start yet', h('p', {}, e.message));
  }
  bubbles = {}; feed = []; thinking = null; lastHandSeen = 0; saveFailed = false; sel = null;
  const picksText = Object.fromEntries((base.variants || []).map((v) => [v.label, v.choices[choices.picks[v.id] ?? v.default ?? 0]?.label]));
  session = {
    id: uid('v_'),
    name: `Player view: ${choices.name} - ${new Date().toLocaleString()}`,
    projectId: base.id,
    created: Date.now(),
    source: { kind: shareInfo ? 'share' : 'player', via: shareInfo?.label || 'test bench', playerName: choices.name },
    options: { opponents: n - 1, ai: choices.provider, choices: picksText },
    telemetry: [],
    state: st,
  };
  tele('start', { opponents: n - 1, ai: choices.provider, choices: picksText, viewport: `${innerWidth}x${innerHeight}` });
  pushFeed({ text: `New game: ${choices.name} against ${opp.map((o) => o[0]).join(', ')}.`, kind: 'sys' });
  catchUp(0, true);
  save(true);
  render();
  advance();
}

function tele(type, data = {}) {
  session?.telemetry.push({ t: Date.now(), turn: st?.turn.number, type, ...data });
}

function save(now = false) {
  clearTimeout(saveTimer);
  const go = async () => {
    session.state = st;
    try { await api.saveSession(base.id, session); } catch (e) {
      if (!saveFailed) toast(`Could not save this game: ${e.message}`, 'warn', 6000);
      saveFailed = true;
    }
  };
  if (now) go(); else saveTimer = setTimeout(go, 700);
}

// ================================================================ events -> feed, bubbles, celebrations
function pushFeed(item) {
  feed.unshift({ ...item, t: Date.now() });
  feed = feed.slice(0, 60);
}

// Turn new public log entries into feed lines and speech bubbles.
function catchUp(from, quiet = false) {
  for (const e of st.log.slice(from)) {
    if (e.type === 'assess' || e.data?.kind === 'reasoning' || e.data?.kind === 'feedback') continue;
    if (e.type === 'setup' || e.type === 'shuffle' || e.type === 'pause') continue;
    if (e.actor === 'system' && e.type === 'note') continue; // harness warnings stay in the test bench log
    const text = e.actor === HUMAN ? e.text : e.publicText; // your own moves in full
    const kind = ['trick', 'hand', 'endGame', 'trump', 'score', 'steal'].includes(e.type) ? 'big' : ['penalty', 'announce', 'final'].includes(e.type) ? 'alert' : e.actor === HUMAN ? 'me' : 'play';
    pushFeed({ text, kind, actor: e.actor });
    if (player(st, e.actor) && ['play', 'draw', 'pass', 'announce', 'move', 'endTurn', 'swap', 'steal', 'give', 'discard'].includes(e.type)) bubbles[e.actor] = text.replace(new RegExp(`^${escapeRe(player(st, e.actor).name)}:?\\s*`), '');
    if (!quiet && e.type === 'steal' && e.actor === HUMAN) toast(`🎉 You completed ${player(st, e.data.victim).name}'s ${e.data.combo} and took it!${e.data.gain ? ` +${e.data.gain}` : ''}`, 'win', 3500);
    else if (!quiet && e.type === 'steal' && e.data?.victim === HUMAN) toast(`😱 ${player(st, e.actor).name} completed your ${e.data.combo} and took it!`, 'warn', 4000);
    else if (!quiet && e.type === 'play' && e.actor === HUMAN && e.data?.gain > 0) toast(e.data.combo ? `🎉 ${e.data.combo} complete! +${e.data.gain}` : `🎉 Your tricks improved: +${e.data.gain}`, 'win', 3000);
    else if (!quiet && e.type === 'final') toast(e.text, 'info', 4500);
  }
  if (!quiet) celebrate();
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Congratulations for hands / rounds (tricks are celebrated on the pause banner).
function celebrate() {
  if (st.handsPlayed !== lastHandSeen && st.lastHand) {
    lastHandSeen = st.handsPlayed;
    const mine = st.lastHand.changes.find((c) => c.id === HUMAN || c.id === teamOf(st, HUMAN)?.id);
    const gained = mine ? Object.values(mine.deltas).reduce((a, b) => a + Math.max(0, b), 0) : 0;
    if (st.lastHand.winner === HUMAN) toast(`🎉 You went out first!${gained ? ` +${gained} points` : ''}`, 'win', 3500);
    else if (gained) toast(`🎉 ${teamOf(st, HUMAN) ? 'Your team scores' : 'You score'} ${gained} point${gained > 1 ? 's' : ''}!`, 'win', 3500);
  }
}

// ================================================================ the loop
async function advance() {
  if (running) return;
  running = true;
  try {
    while (st.status === 'playing' && !st.pending) {
      const p = activePlayer(st);
      if (!isAI(p.controller)) break;
      // Give the human a moment to catch an AI who forgot an announcement.
      await wait(st.catchable && st.catchable.pid !== HUMAN ? 2400 : 650);
      if (st.status !== 'playing' || st.pending || activePlayer(st).id !== p.id) continue;
      thinking = p.id;
      delete bubbles[p.id];
      render();
      const from = st.log.length;
      const t0 = Date.now();
      try {
        await takeAiTurn(game, st, { ui: {} });
      } catch (e) {
        // Keep the game going: a quick bot plays this turn instead.
        tele('aiError', { player: p.name, error: e.message });
        pushFeed({ text: `${p.name}'s AI could not answer (${e.message}) - a quick bot played this turn.`, kind: 'alert' });
        if (st.status === 'playing' && activePlayer(st).id === p.id) {
          for (const a of randomBot(game, st, p.id).actions) { try { apply(game, st, { ...a, actor: p.id }); } catch { /* ignore */ } }
          finishTurn(game, st, p);
        }
      }
      tele('aiTurn', { player: p.name, ms: Date.now() - t0 });
      thinking = null;
      catchUp(from);
      save();
      render();
      if (st.catchable?.pid === HUMAN) await aiMayCatchHuman();
      await wait(250);
    }
  } finally {
    running = false;
  }
  turnStartedAt = Date.now();
  render();
  if (st.status === 'ended') gameOver();
}

async function aiMayCatchHuman() {
  const C = st.catchable;
  const catcher = rollAiCatch(game, st);
  if (!catcher) return;
  await wait(900);
  if (st.catchable && st.catchable.pid === C.pid && st.catchable.id === C.id) {
    const from = st.log.length;
    apply(game, st, { type: 'catch', actor: catcher });
    catchUp(from);
    toast(`😬 ${player(st, catcher).name} caught you - you didn't say "${C.label}"!`, 'warn', 4000);
    save();
    render();
  }
}

// A move by the human. Returns false if it was not allowed.
async function act(action) {
  const full = { actor: HUMAN, ...action };
  const why = checkAction(game, st, full);
  if (why && automation(game).enforce === 'strict') {
    toast(`Not allowed: ${why}`, 'warn', 4000);
    tele('blocked', { action: action.type, reason: why });
    return false;
  }
  const from = st.log.length;
  try {
    apply(game, st, full);
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
  sel = null;
  tele('move', { action: action.type, card: action.card ? cname(action.card) : undefined, to: action.to, ms: Date.now() - turnStartedAt });
  catchUp(from);
  save();
  render();
  if (st.catchable?.pid === HUMAN) await aiMayCatchHuman();
  if (st.status === 'ended') return gameOver();
  turnStartedAt = Date.now();
  advance();
  return true;
}

function continuePlay() {
  if (!st.pending) return;
  const from = st.log.length;
  tele('continue', { after: st.pending.type });
  apply(game, st, { type: 'continue', actor: 'designer' });
  catchUp(from);
  save();
  render();
  advance();
}

// ================================================================ human actions
function playCard(u) {
  const lm = legalMoves(game, st, HUMAN);
  if (!lm) return freeFormMenu(u);
  if (lm.options) {
    // Set collection: discard straight away when a discard is due; otherwise pick the card up.
    if (lm.discarding) return act(lm.options.find((o) => o.card === u)?.action);
    if (lm.cards[u]) { shake(u); return toast(lm.cards[u], 'warn', 3000); }
    sel = sel === u ? null : u;
    return render();
  }
  if (lm.cards[u]) {
    tele('illegalClick', { card: cname(u), reason: lm.cards[u] });
    shake(u);
    return toast(lm.cards[u], 'warn', 3000);
  }
  if (isShedding(game) && cardEffects(game, st, u).wild) {
    const dlg = modal('Choose the next colour', h('div', { class: 'colour-picker' }, lm.colours.map((c) => h('button', {
      class: 'btn colour-btn', style: { background: colourHex(c) },
      onclick: () => { dlg.close(); act({ type: 'move', card: u, to: lm.target, choose: c }); },
    }, c))), [{ label: 'Cancel' }]);
    return;
  }
  act({ type: 'move', card: u, to: lm.target });
}

// Free-form games: the player chooses where the card goes.
function freeFormMenu(u) {
  const targets = st.zoneOrder.filter((z) => z !== st.cards[u].zone && (!st.zones[z].owner || st.zones[z].owner === HUMAN) && zoneDef(game, st.zones[z].defId)?.layout !== 'hand');
  const dlg = modal(cname(u), h('div', { class: 'stack' },
    h('div', { class: 'pv-menu-card' }, cardFace(cardDef(game, st, u), { size: 150 })),
    targets.map((z) => h('button', { class: 'btn', onclick: () => { dlg.close(); act({ type: 'move', card: u, to: z }); } }, `Put on ${st.zones[z].owner ? 'your ' + zoneDef(game, st.zones[z].defId).name : st.zones[z].name}`))),
  [{ label: 'Cancel' }]);
}

function shake(u) {
  const el = app.querySelector(`.pv-hand [data-card="${u}"]`);
  if (!el) return;
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}

function colourHex(colour) {
  const S = game.automation.shedding;
  return game.cards.find((c) => String(c.stats?.[S.colourStat]) === colour)?.color || '#888';
}

// ================================================================ rendering
function render() {
  if (!st) return;
  const winners = st.result?.winners || [];
  app.replaceChildren(h('div', { class: 'pv' },
    topBar(),
    h('div', { class: 'pv-main' },
      h('div', { class: 'pv-opps' }, st.players.filter((p) => p.id !== HUMAN).map((p) => opponent(p, winners))),
      tableArea(),
      myArea()),
    feedPanel()));
}

function topBar() {
  const H = st.hand;
  const where = isTricks(game) && H ? `Hand ${H.number} · trick ${Math.min(13, H.tricksPlayed + 1)}` : isShedding(game) && H ? `Round ${H.number}`
    : isSets(game) && H ? `Turn ${st.turn.number} · ${st.zones[setsCfg(game).drawZone]?.name || 'draw pile'}: ${st.zones[setsCfg(game).drawZone]?.cards.length ?? 0} left` : `Turn ${st.turn.number}`;
  const c0 = game.counters[0];
  const scores = c0 ? competitors(st).map((c) => {
    const mine = c.id === HUMAN || c.id === teamOf(st, HUMAN)?.id;
    const label = mine ? (teamOf(st, HUMAN) ? 'Your team' : 'You') : c.name.split(' (')[0];
    return h('span', { class: `pv-score ${mine ? 'mine' : ''}`, title: `${c.name}: ${game.counters.map((k) => `${k.name} ${player(st, c.rep).counters[k.id]}`).join(', ')}` }, label, ' ', h('b', {}, player(st, c.rep).counters[c0.id]));
  }) : null;
  return h('header', { class: 'pv-top' },
    h('div', { class: 'pv-top-title' }, h('b', {}, game.name), h('span', { class: 'muted' }, where)),
    h('div', { class: 'pv-scores', title: c0?.name }, c0 ? h('span', { class: 'muted small' }, `${c0.name}:`) : null, scores),
    h('div', { class: 'pv-top-btns' },
      h('button', { class: 'btn small', onclick: showRules, title: 'Rules' }, '? Rules'),
      h('button', { class: 'btn small', onclick: menu, title: 'Menu' }, '☰')));
}

function opponent(p, winners) {
  const n = st.zones[`${p.id}.hand`]?.cards.length ?? 0;
  const active = st.status === 'playing' && !st.pending && activePlayer(st).id === p.id;
  const team = teamOf(st, p.id);
  const partner = team && isMate(p.id);
  const chips = [];
  if (st.hand && st.dealer === p.seat && !isSets(game)) chips.push(h('span', { class: 'pv-chip' }, 'Dealer'));
  if (isTricks(game) && st.hand) chips.push(h('span', { class: 'pv-chip' }, `Tricks ${st.hand.tricksWon[p.id] || 0}`));
  if (isShedding(game) && n === 1 && st.status === 'playing') chips.push(h('span', { class: 'pv-chip red' }, 'Last card!'));
  if (st.catchable?.pid === p.id) chips.push(h('span', { class: 'pv-chip red' }, `didn't say "${st.catchable.label}"`));
  if (winners.includes(p.id)) chips.push(h('span', { class: 'pv-chip gold' }, 'Winner'));
  const fan = Math.min(n, 10);
  return h('div', { class: `pv-opp ${active ? 'turn' : ''} ${thinking === p.id ? 'thinking' : ''} ${partner ? 'partner' : ''}` },
    bubbles[p.id] ? h('div', { class: 'pv-bubble' }, bubbles[p.id]) : null,
    h('div', { class: 'pv-avatar', style: { '--hue': (p.seat * 67) % 360 } }, avatars[p.id] || '🙂'),
    h('div', { class: 'pv-opp-name' }, p.name, partner ? h('span', { class: 'muted small' }, ' (partner)') : null),
    h('div', { class: 'pv-opp-hand', title: `${n} card${n === 1 ? '' : 's'}` },
      Array.from({ length: fan }, (_, i) => h('span', { class: 'pv-mini', style: { '--i': i, '--n': fan, background: game.cardBack.color } })),
      h('span', { class: 'pv-count' }, n)),
    game.counters.length ? h('div', { class: 'pv-opp-score small' }, game.counters.map((c) => `${c.name} ${p.counters[c.id]}`).join(' · ')) : null,
    chips.length ? h('div', { class: 'pv-chips' }, chips) : null,
    isSets(game) && st.hand ? oppSets(p) : null,
    thinking === p.id ? h('div', { class: 'pv-dots' }, h('span'), h('span'), h('span')) : null);
}

// ---------------------------------------------------------------- set collection
const scoreZoneCfg = (zid) => setsCfg(game).zones.find((z) => z.zone === st.zones[zid]?.defId);
const selOptions = () => (sel && myTurn() ? (legalMoves(game, st, HUMAN)?.options || []).filter((o) => o.card === sel) : []);

// A compact card: the icon (or initial) on the card's colour.
function chipCard(u) {
  const d = cardDef(game, st, u);
  if (!isVisibleTo(game, st, u, HUMAN) || !d) return h('span', { class: 'pv-chipcard back', style: { background: game.cardBack.color } });
  return h('span', { class: 'pv-chipcard', style: { background: d.color }, title: `${d.name}${d.rules ? ' - ' + d.rules : ''}` }, d.icon || d.name.slice(0, 2));
}

// A scoring zone as groups of tricks plus the loose cards.
function trickGroups(zid, { compact = false } = {}) {
  const z = st.zones[zid];
  const cfg = scoreZoneCfg(zid);
  const m = Number(cfg?.multiplier) || 1;
  const r = zoneTricks(game, st, zid);
  const own = z.owner === HUMAN;
  const card = (u) => {
    if (compact) return chipCard(u);
    const d = cardDef(game, st, u);
    const el = isVisibleTo(game, st, u, HUMAN) && d ? cardFace(d) : cardBack(game);
    if (!st.cards[u].faceUp && own) el.classList.add('pv-facedown');
    return el;
  };
  return h('div', { class: `pv-sets ${compact ? 'compact' : ''}` },
    r.tricks.map((t) => h('div', { class: 'pv-tg' }, h('div', { class: 'pv-tg-cards' }, t.cards.map(card)),
      h('div', { class: 'pv-tg-label' }, `${t.label} ${t.points}${m !== 1 ? ` ×${m} = ${t.points * m}` : ''}`))),
    r.loose.length ? h('div', { class: `pv-tg loose ${cfg?.secret ? '' : 'risk'}` }, h('div', { class: 'pv-tg-cards' }, r.loose.map(card)),
      h('div', { class: 'pv-tg-label' }, cfg?.secret ? 'not in a trick yet' : own ? 'loose - others can complete these' : 'loose')) : null,
    !z.cards.length ? h('div', { class: 'pv-empty' }, compact ? '-' : 'empty') : null);
}

function oppSets(p) {
  const opts = selOptions().filter((o) => o.kind === 'give' && o.victim === p.id);
  return h('div', { class: 'pv-opp-sets' }, setsCfg(game).zones.filter((z) => st.zones[`${p.id}.${z.zone}`]).map((z) => {
    const zid = `${p.id}.${z.zone}`;
    const name = zoneDef(game, z.zone).name;
    if (z.secret && !st.revealed) {
      const n = st.zones[zid].cards.length;
      return h('div', { class: 'pv-opp-zone' }, h('span', { class: 'pv-zone-label' }, `${name}: ${n} card${n === 1 ? '' : 's'} face down`));
    }
    const o = opts.find((x) => x.to === zid);
    return h('div', {
      class: `pv-opp-zone ${o ? 'pv-target' : ''}`, title: o ? o.label : '',
      onclick: o ? () => act(o.action) : null,
    }, h('span', { class: 'pv-zone-label' }, name, o ? h('b', { class: 'pv-target-hint' }, ` ← ${o.label}`) : null), trickGroups(zid, { compact: true }));
  }));
}

function mySets() {
  const opts = selOptions();
  return h('div', { class: 'pv-my-sets' }, setsCfg(game).zones.filter((z) => st.zones[`${HUMAN}.${z.zone}`]).map((z) => {
    const zid = `${HUMAN}.${z.zone}`;
    const o = opts.find((x) => x.kind === 'play' && x.to === zid);
    const def = zoneDef(game, z.zone);
    const points = zoneTricks(game, st, zid).total * (Number(z.multiplier) || 1);
    return h('div', { class: `pv-my-zone ${o ? 'pv-target' : ''} ${o?.gain > 0 ? 'scores' : ''}`, onclick: o ? () => act(o.action) : null, title: o ? o.label : '' },
      h('div', { class: 'pv-zone-label' }, h('b', {}, def.name), ` ×${Number(z.multiplier) || 1}${def.faceUp === false ? ' · face down, secret until the end' : ' · face up'} · ${points} pts`,
        o ? h('b', { class: 'pv-target-hint' }, o.gain > 0 ? ` ← tap to play: +${o.gain}` : ' ← tap to play here') : null),
      trickGroups(zid));
  }));
}

function zoneView(zid) {
  const z = st.zones[zid];
  const def = zoneDef(game, z.defId) || {};
  const H = st.hand;
  const trickZone = isTricks(game) && H && z.defId === automation(game).tricks.zone;
  const lm = myTurn() ? legalMoves(game, st, HUMAN) : null;
  const drawPile = (isShedding(game) && zid === automation(game).shedding.drawZone) || (isSets(game) && zid === setsCfg(game).drawZone);
  const market = isSets(game) && zid === setsCfg(game).marketZone;
  const cardEl = (u) => {
    const d = cardDef(game, st, u);
    return isVisibleTo(game, st, u, HUMAN) && d ? cardFace(d) : cardBack(game);
  };
  let body;
  if (trickZone) {
    const who = Object.fromEntries(H.trick.map((t) => [t.card, t.pid]));
    body = z.cards.length
      ? z.cards.map((u) => h('div', { class: `pv-trick-play ${st.pending?.type === 'trick' && st.pending.winningCard === u ? 'win' : ''}` }, cardEl(u), h('span', {}, who[u] === HUMAN ? 'You' : player(st, who[u])?.name)))
      : h('div', { class: 'pv-empty' }, st.status === 'playing' ? `${activePlayer(st).id === HUMAN ? 'You lead' : activePlayer(st).name + ' leads'}` : '');
  } else if (def.layout === 'stack') {
    const top = z.cards[z.cards.length - 1];
    const canDraw = (drawPile && lm?.canDraw) || (!isAutomated(game) && myTurn() && top);
    const el = top ? cardEl(top) : h('div', { class: 'card empty-slot' });
    if (canDraw && top) {
      el.classList.add('pv-drawable');
      el.title = lm?.takeCount ? `Take ${lm.takeCount} cards` : 'Draw a card';
      el.addEventListener('click', () => (isAutomated(game) ? act({ type: 'draw' }) : act({ type: 'draw', from: zid })));
    }
    body = h('div', { class: 'pv-pile', style: { '--depth': Math.min(6, Math.ceil(z.cards.length / 8)) } }, el);
  } else if (market) {
    const swaps = selOptions().filter((o) => o.kind === 'swap');
    body = z.cards.length ? z.cards.map((u) => {
      const el = cardEl(u);
      const o = swaps.find((x) => x.with === u);
      if (o) { el.classList.add('pv-drawable'); el.title = `Swap your ${cname(sel)} for ${cname(u)}`; el.addEventListener('click', () => act(o.action)); }
      else if (myTurn()) el.title = 'To swap: tap a card in your hand, then tap this card';
      return el;
    }) : h('div', { class: 'pv-empty' }, 'empty');
  } else {
    body = z.cards.length ? z.cards.map(cardEl) : h('div', { class: 'pv-empty' }, 'empty');
  }
  const extra = isShedding(game) && H && zid === automation(game).shedding.discardZone && H.colour
    ? h('div', { class: 'colour-chip', style: { background: colourHex(H.colour) } }, `Colour: ${H.colour}`) : null;
  return h('div', { class: `pv-zone layout-${def.layout || 'spread'} ${trickZone ? 'trick' : ''}` },
    h('div', { class: 'pv-zone-label' }, z.name, def.layout === 'stack' ? h('span', { class: 'pv-count' }, z.cards.length) : null),
    h('div', { class: 'pv-zone-cards' }, body), extra);
}

function statusLine() {
  const H = st.hand;
  const bits = [];
  if (isTricks(game) && H) {
    const sym = SUITS.find((x) => x.name === H.trump)?.symbol || '';
    bits.push(h('span', { class: `pv-trump ${['Hearts', 'Diamonds'].includes(H.trump) ? 'red' : ''}` }, H.trump ? `Trumps ${sym} ${H.trump}` : 'No trumps'));
    if (H.led) bits.push(h('span', { class: 'muted' }, `${SUITS.find((x) => x.name === H.led)?.symbol || ''} ${H.led} led`));
  }
  if (isShedding(game) && H) bits.push(h('span', { class: 'muted' }, st.dir === 1 ? '⟳ play goes clockwise' : '⟲ play is reversed'));
  if (st.status === 'playing' && !st.pending) {
    const a = activePlayer(st);
    bits.unshift(h('span', { class: `pv-whose ${a.id === HUMAN ? 'me' : ''}` }, a.id === HUMAN ? 'Your turn' : thinking ? `${a.name} is thinking…` : `${a.name}'s turn`));
  }
  return h('div', { class: 'pv-status' }, bits);
}

function tableArea() {
  const shared = st.zoneOrder.filter((z) => !st.zones[z].owner);
  return h('section', { class: 'pv-table' },
    statusLine(),
    h('div', { class: 'pv-zones' }, shared.map(zoneView)),
    pauseBanner());
}

function pauseBanner() {
  const P = st.pending;
  if (!P) return null;
  if (P.type === 'trick') {
    const w = P.winner;
    const msg = w === HUMAN ? '🎉 You win the trick!' : isMate(w) ? `👏 Your partner ${player(st, w).name} wins the trick` : `${player(st, w).name} wins the trick`;
    return h('div', { class: 'pv-banner' }, h('p', { class: 'big' }, msg), h('p', { class: 'muted small' }, `with ${cname(P.winningCard)}`),
      h('button', { class: 'btn primary', onclick: continuePlay, autofocus: true }, 'Next trick ▶'));
  }
  const L = st.lastHand;
  const noun = isShedding(game) ? 'round' : 'hand';
  const head = isShedding(game) && L?.winner ? (L.winner === HUMAN ? '🎉 You went out first!' : `${player(st, L.winner).name} went out first`) : `End of ${noun} ${L?.number ?? ''}`;
  return h('div', { class: 'pv-banner wide' },
    h('p', { class: 'big' }, head),
    L ? standings(L) : null,
    L?.scoreLines?.length ? h('ul', { class: 'score-why' }, L.scoreLines.map((t) => h('li', {}, t.replace(/^Score: /, '')))) : null,
    h('button', { class: 'btn primary', onclick: continuePlay }, `Deal the next ${noun} ▶`));
}

function standings(L) {
  return h('table', { class: 'mini-table standings' },
    h('thead', {}, h('tr', {}, h('th', {}, ''), L?.tricks ? h('th', {}, 'Tricks') : null, game.counters.map((c) => h('th', {}, c.name)))),
    h('tbody', {}, competitors(st).map((c) => {
      const ch = L?.changes?.find((x) => x.id === c.id);
      const mine = c.id === HUMAN || c.id === teamOf(st, HUMAN)?.id;
      return h('tr', { class: mine ? 'mine' : '' },
        h('td', {}, mine ? (teamOf(st, HUMAN) ? `Your team (${c.name.split('(')[1]?.replace(')', '') || ''})` : 'You') : c.name),
        L?.tricks ? h('td', {}, L.tricks[c.id]) : null,
        game.counters.map((k) => h('td', {}, player(st, c.rep).counters[k.id], ch?.deltas?.[k.id] ? h('span', { class: 'delta' }, ` +${ch.deltas[k.id]}`) : null)));
    })));
}

function myArea() {
  const p = me();
  const lm = myTurn() ? legalMoves(game, st, HUMAN) : null;
  const handZ = `${HUMAN}.hand`;
  const cards = sortHand(st.zones[handZ]?.cards || []);
  const wonZone = isTricks(game) ? `${HUMAN}.${automation(game).tricks.wonZone}` : null;
  const sets = isSets(game) && st.hand;
  const setZones = sets ? setsCfg(game).zones.map((z) => `${HUMAN}.${z.zone}`) : [];
  const others = st.zoneOrder.filter((z) => st.zones[z].owner === HUMAN && z !== handZ && z !== wonZone && !setZones.includes(z));
  const actions = [];
  if (myTurn() && sets && lm?.options) {
    if (!lm.discarding) {
      for (const o of selOptions().filter((x) => x.kind !== 'swap')) {
        actions.push(h('button', { class: `btn ${o.gain > 0 ? 'primary' : ''}`, onclick: () => act(o.action) }, o.kind === 'give' ? `🗡 ${o.label}` : o.label));
      }
      if (sel && selOptions().some((x) => x.kind === 'swap')) actions.push(h('span', { class: 'pv-hint' }, `…or tap one of the ${st.zones[setsCfg(game).marketZone]?.name || 'face-up cards'} to swap`));
      if (sel) actions.push(h('button', { class: 'btn small', onclick: () => { sel = null; render(); } }, 'Cancel'));
      if (!sel && lm.canDraw) actions.push(h('button', { class: 'btn', onclick: () => act({ type: 'draw' }) }, `Draw from the ${st.zones[setsCfg(game).drawZone]?.name || 'pile'}`));
      if (!sel) actions.push(h('button', { class: `btn ${lm.actionsLeft ? '' : 'primary'}`, onclick: () => act({ type: 'endTurn' }) }, lm.actionsLeft ? 'End turn early' : 'End turn'));
    }
  } else if (myTurn()) {
    if (lm?.canDraw && isShedding(game)) actions.push(h('button', { class: `btn ${lm.legal.length ? '' : 'primary'}`, onclick: () => act({ type: 'draw' }) }, lm.takeCount ? `Take ${lm.takeCount} cards` : 'Draw a card'));
    if (lm?.canPass) actions.push(h('button', { class: 'btn', onclick: () => act({ type: 'endTurn' }) }, 'Pass'));
    for (const r of announcementRules(game)) {
      const said = st.announce?.pid === HUMAN && st.announce.ids.includes(r.id);
      actions.push(h('button', { class: `btn announce-btn ${said ? 'said' : ''}`, disabled: said, onclick: () => act({ type: 'announce', id: r.id }) }, said ? `📣 "${r.label}" ✓` : `📣 Say "${r.label}"`));
    }
    if (!isAutomated(game)) actions.push(h('button', { class: 'btn primary', onclick: () => act({ type: 'endTurn' }) }, 'End my turn'));
  }
  if (st.catchable && st.catchable.pid !== HUMAN && st.status === 'playing') {
    actions.unshift(h('button', { class: 'btn catch-btn pv-catch', onclick: () => act({ type: 'catch' }) }, `Catch ${player(st, st.catchable.pid).name}! (didn't say "${st.catchable.label}")`));
  }
  const tip = st.status !== 'playing' ? '' : st.pending ? '' : myTurn()
    ? (sets && lm?.options ? (lm.discarding ? `${lm.summary} Tap the cards to discard.` : sel ? `${cname(sel)}: choose where it goes - one of your zones, a highlighted opponent, or a face-up card to swap.` : `${lm.summary} Tap a card in your hand to use it, or draw.`)
      : lm ? `${lm.summary}${lm.legal.length ? ' Tap a highlighted card to play it.' : ''}` : 'Tap a card to play it, or draw from a pile; then end your turn.')
    : 'Waiting for the other players…';
  const chips = [];
  if (st.hand && st.dealer === p.seat && !isSets(game)) chips.push(h('span', { class: 'pv-chip' }, 'Dealer'));
  if (isTricks(game) && st.hand) chips.push(h('span', { class: 'pv-chip' }, `Tricks ${st.hand.tricksWon[HUMAN] || 0}`));
  if (sets && myTurn() && lm?.options) chips.push(h('span', { class: 'pv-chip gold' }, lm.discarding ? 'Discard' : `Actions left: ${lm.actionsLeft} of ${lm.actionsPerTurn}`));
  if (sets && !st.revealed) {
    const b = setsBreakdown(game, st, HUMAN);
    if (b.hidden) chips.push(h('span', { class: 'pv-chip', title: 'Points in your face-down zones: only you know about them until the end' }, `+${b.hidden} hidden`));
  }
  const manualScore = !(automation(game).autoScore && automation(game).scoring.length);
  return h('section', { class: `pv-me ${myTurn() ? 'turn' : ''}` },
    h('div', { class: 'pv-me-head' },
      h('span', { class: 'pv-avatar small', style: { '--hue': 140 } }, avatars[HUMAN]),
      h('b', {}, p.name),
      game.counters.map((c) => h('span', { class: 'pv-chip' }, `${c.name} ${p.counters[c.id]}`,
        manualScore && !isAutomated(game) ? [h('button', { class: 'mini', onclick: () => act({ type: 'counter', player: HUMAN, counter: c.id, delta: -1 }) }, '−'), h('button', { class: 'mini', onclick: () => act({ type: 'counter', player: HUMAN, counter: c.id, delta: 1 }) }, '+')] : null)),
      chips,
      others.map((z) => h('span', { class: 'pv-chip', title: st.zones[z].name }, `${zoneDef(game, st.zones[z].defId).name}: ${st.zones[z].cards.length} card${st.zones[z].cards.length === 1 ? '' : 's'}`))),
    sets ? mySets() : null,
    tip ? h('p', { class: 'pv-tip' }, tip) : null,
    actions.length ? h('div', { class: 'pv-actions' }, actions) : null,
    h('div', { class: `pv-hand ${cards.length > 9 ? 'many' : ''}` }, cards.map((u) => {
      const d = cardDef(game, st, u);
      const el = cardFace(d);
      el.dataset.card = u;
      el.classList.add('pv-card');
      if (sel === u) el.classList.add('picked');
      if (lm) {
        if (lm.cards[u]) { el.classList.add('no'); el.title = lm.cards[u]; } else { el.classList.add('ok'); el.title = lm.discarding ? 'Tap to discard' : lm.options ? 'Tap to pick up' : 'Tap to play'; }
      } else if (myTurn()) {
        el.classList.add('ok');
      }
      if (myTurn()) el.addEventListener('click', () => playCard(u));
      return el;
    })));
}

function sortHand(cards) {
  if (!isAutomated(game)) return cards;
  if (isSets(game)) {
    const order = game.cards.map((c) => c.id);
    return cards.slice().sort((a, b) => order.indexOf(st.cards[a].defId) - order.indexOf(st.cards[b].defId));
  }
  const A = automation(game);
  const shed = isShedding(game);
  const g = shed ? A.shedding.colourStat : A.tricks.suitStat;
  const v = shed ? A.shedding.valueStat : A.tricks.rankStat;
  const order = shed ? shedColours(game) : SUITS.map((x) => x.name);
  const key = (u) => {
    const s = cardDef(game, st, u)?.stats || {};
    const i = order.indexOf(String(s[g]));
    const n = Number(s[v]);
    return [i < 0 ? 99 : i, shed ? (Number.isFinite(n) ? n : 50) : -(n || 0)];
  };
  return cards.slice().sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1]);
}

function feedPanel() {
  return h('aside', { class: 'pv-feed' },
    h('h3', {}, 'What happened'),
    h('ol', {}, feed.slice(0, 30).map((f) => h('li', { class: `pv-f-${f.kind}` }, f.text))));
}

// ================================================================ dialogs
function showRules() {
  tele('rulesOpened');
  const cardTypes = game.cards.filter((c) => c.rules || c.stats?.effect);
  modal(`${game.name}: rules`, h('div', {},
    rulesContent(game),
    session?.options?.choices && Object.keys(session.options.choices).length ? [h('h4', {}, 'Options in this game'), h('ul', {}, Object.entries(session.options.choices).map(([k, v]) => h('li', {}, `${k}: ${v}`)))] : null,
    cardTypes.length ? [h('h4', {}, 'Special cards'), h('div', { class: 'pv-cardlist' }, cardTypes.map((c) => h('div', { class: 'pv-cardrow' }, cardFace(c, { size: 64 }), h('div', {}, h('b', {}, c.name), h('p', { class: 'small' }, c.rules || c.description)))))] : null),
  [{ label: 'Back to the game', kind: 'primary' }], { wide: true });
}

function menu() {
  modal('Menu', h('div', { class: 'stack' },
    h('button', { class: 'btn', onclick: () => { document.querySelector('.modal-overlay')?.remove(); showRules(); } }, 'Rules'),
    h('button', { class: 'btn', onclick: () => { document.querySelector('.modal-overlay')?.remove(); tele('restart'); save(true); start(); } }, 'Restart with the same options'),
    h('button', { class: 'btn', onclick: () => { document.querySelector('.modal-overlay')?.remove(); tele('quit'); save(true); st = null; welcome(); } }, 'Change options / quit')),
  [{ label: 'Close' }]);
}

function gameOver() {
  if (document.querySelector('.pv-results')) return;
  const winners = st.result?.winners || [];
  const iWon = winners.some((w) => isMate(w));
  tele('gameEnd', { winners: winners.map((w) => player(st, w)?.name), iWon, turns: st.turn.number, hands: st.handsPlayed });
  save(true);
  if (iWon) confetti();
  const names = winners.map((w) => (w === HUMAN ? 'You' : player(st, w).name));
  const dlg = modal(iWon ? '🏆 You win!' : 'Game over', h('div', { class: 'stack pv-results' },
    h('p', { class: 'big' }, iWon ? (winners.length > 1 ? `Well played - ${names.join(' & ')} win the game!` : 'Congratulations - you won the game!') : `${names.join(' & ') || 'Nobody'} won the game.`),
    st.result?.reason ? h('p', { class: 'muted small' }, st.result.reason.replace(/ \([^)]*[<>=][^)]*\)$/, '')) : null,
    standings(st.lastHand),
    isSets(game) && st.lastHand?.scoreLines?.length ? h('ul', { class: 'score-why small' }, st.lastHand.scoreLines.map((t) => h('li', {}, t))) : null,
    h('p', { class: 'muted small' }, `${st.handsPlayed ? `${st.handsPlayed} ${isShedding(game) ? 'round' : 'hand'}${st.handsPlayed > 1 ? 's' : ''} · ` : ''}${st.turn.number} turns`)),
  [
    { label: 'Change options', onClick: () => { st = null; welcome(); } },
    { label: 'Play again ▶', kind: 'primary', onClick: () => { tele('playAgain'); start(); } },
  ]);
  dlg.el.classList.add('pv-modal');
}

function confetti() {
  const box = h('div', { class: 'pv-confetti' });
  for (let i = 0; i < 90; i++) {
    box.append(h('i', { style: { left: `${Math.random() * 100}%`, animationDelay: `${Math.random() * 0.8}s`, background: `hsl(${Math.random() * 360} 80% 60%)`, '--x': `${(Math.random() - 0.5) * 200}px` } }));
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 4200);
}

// ================================================================ keyboard
document.addEventListener('keydown', (e) => {
  if (!st || document.querySelector('.modal-overlay')) return;
  if ((e.key === 'Enter' || e.key === ' ') && st.pending) { e.preventDefault(); continuePlay(); }
});

boot();
watchVersion(() => showReloadBar('A new version of this game has been published - reload to use it.'));
