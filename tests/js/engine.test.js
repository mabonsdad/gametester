// Engine tests (node --test tests/js/). Plays whole games with random legal
// moves and checks the automated rules hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProject, whistProject, sampleProject } from '../../static/js/model.js';
import {
  activePlayer, apply, checkAction, createGame, describeAutomation, legalMoves, teamOf, trickWinner, clone,
} from '../../static/js/engine.js';
import { check, run } from '../../static/js/expr.js';

function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x ^ (x >>> 15), 2246822519) + 0x9e3779b9) >>> 0) / 4294967296);
}

const players4 = ['North', 'East', 'South', 'West'].map((name) => ({ name, controller: 'ai-random' }));

test('formulas', () => {
  assert.equal(run('max(0, teamTricks - 6)', { teamTricks: 9 }), 3);
  assert.equal(run('max(0, teamTricks - 6)', { teamTricks: 4 }), 0);
  assert.equal(run('score >= 5 && hand > 1', { score: 5, hand: 2 }), true);
  assert.equal(run('tricks == 0 ? 10 : -tricks', { tricks: 0 }), 10);
  assert.equal(run('wonCount("suit", "Hearts") * 2', { wonCount: (s, v) => (s === 'suit' && v === 'Hearts' ? 4 : 0) }), 8);
  assert.equal(run('(1 + 2) * 3 % 4', {}), 1);
  assert.match(check('max(0, '), /Expected|Unexpected/);
  assert.match(check('a.b'), /Unexpected/);
  assert.throws(() => run('nope + 1', {}), /Unknown name/);
  assert.equal(check('score >= 5'), '');
});

test('trick winner: trumps beat the led suit; off-suit cards never win', () => {
  const p = normalizeProject(whistProject());
  const st = createGame(p, { players: players4, seed: 1 });
  const id = (name) => Object.values(st.cards).find((c) => p.cards.find((d) => d.id === c.defId).name === name).uid;
  const plays = (names) => names.map((n, i) => ({ pid: `p${i + 1}`, card: id(n) }));
  assert.equal(trickWinner(p, st, plays(['5♥', 'K♥', 'A♠', '2♥']), 'Clubs').pid, 'p2');    // A♠ is off-suit
  assert.equal(trickWinner(p, st, plays(['5♥', 'K♥', '2♣', 'A♥']), 'Clubs').pid, 'p3');    // lowest trump wins
  assert.equal(trickWinner(p, st, plays(['5♥', '3♣', '9♣', 'A♥']), 'Clubs').pid, 'p3');    // higher trump
  assert.equal(trickWinner(p, st, plays(['5♥', 'K♥', 'A♠', 'A♥']), null).pid, 'p4');       // no trumps
});

test('whist plays to a finish with legal moves, correct scoring and partnerships', () => {
  const p = normalizeProject(whistProject());
  for (let seed = 1; seed <= 15; seed++) {
    const st = createGame(p, { players: players4, seed });
    const r = rng(seed);
    assert.equal(st.teams.length, 2);
    assert.deepEqual(st.teams[0].players, ['p1', 'p3']);
    assert.ok(st.hand.trump, 'trump chosen');
    let handNo = st.hand.number;
    let safety = 0;
    let lastHandTricks = null;
    while (st.status === 'playing' && safety++ < 5000) {
      const pid = activePlayer(st).id;
      const lm = legalMoves(p, st, pid);
      assert.ok(lm.legal.length > 0, 'always a legal card');
      // an illegal card (if any) must be rejected with a reason
      const illegal = Object.entries(lm.cards).find(([, why]) => why);
      if (illegal) assert.match(checkAction(p, st, { type: 'move', card: illegal[0], to: 'trick', actor: pid }), /follow suit/);
      // every legal card follows suit when following is possible
      if (st.hand.led) {
        const hand = st.zones[`${pid}.hand`].cards;
        const suit = (u) => p.cards.find((d) => d.id === st.cards[u].defId).stats.suit;
        if (hand.some((u) => suit(u) === st.hand.led)) assert.ok(lm.legal.every((u) => suit(u) === st.hand.led));
      }
      const card = lm.legal[Math.floor(r() * lm.legal.length)];
      assert.equal(checkAction(p, st, { type: 'move', card, to: 'trick', actor: pid }), null);
      const before = clone(st.hand);
      apply(p, st, { type: 'move', card, to: 'trick', actor: pid });
      if (st.status === 'playing' && st.hand.number !== handNo) {
        lastHandTricks = before; // hand just finished
        handNo = st.hand.number;
      }
      // partners always share a score
      for (const t of st.teams) {
        const [a, b] = t.players.map((id) => st.players.find((x) => x.id === id).counters.score);
        assert.equal(a, b);
      }
    }
    assert.equal(st.status, 'ended', `seed ${seed} finished`);
    const winners = st.result.winners;
    assert.equal(winners.length, 2, 'a partnership wins');
    assert.ok(st.players.find((x) => x.id === winners[0]).counters.score >= 5);
    assert.equal(teamOf(st, winners[0]), teamOf(st, winners[1]));
    // every completed hand had 13 tricks, and scores only change by tricks over six
    const handLogs = st.log.filter((e) => e.type === 'hand' && /over - tricks/.test(e.text));
    assert.ok(handLogs.length >= 1);
    for (const e of handLogs) {
      const nums = [...e.text.matchAll(/\) (\d+)/g)].map((m) => Number(m[1]));
      assert.equal(nums.reduce((a, b) => a + b, 0), 13, e.text);
    }
    for (const e of st.log.filter((x) => x.type === 'score')) {
      assert.ok(e.data.amount >= 1 && e.data.amount <= 7, e.text);
    }
  }
});

test('strict mode blocks non-play actions in trick games; designer actions are not checked', () => {
  const p = normalizeProject(whistProject());
  const st = createGame(p, { players: players4, seed: 3 });
  const pid = activePlayer(st).id;
  assert.match(checkAction(p, st, { type: 'endTurn', actor: pid }), /automatically/);
  assert.match(checkAction(p, st, { type: 'draw', from: 'deck', actor: pid }), /not part of this game/);
  assert.match(checkAction(p, st, { type: 'counter', player: pid, counter: 'score', delta: 1, actor: pid }), /automatic/);
  assert.equal(checkAction(p, st, { type: 'counter', player: pid, counter: 'score', delta: 1, actor: 'designer' }), null);
  const other = st.players.find((x) => x.id !== pid).id;
  const otherCard = st.zones[`${other}.hand`].cards[0];
  assert.match(checkAction(p, st, { type: 'move', card: otherCard, to: 'trick', actor: other }), /turn/);
  assert.ok(describeAutomation(p).some((l) => l.includes('max(0, teamTricks - 6)')));
});

test('free-form projects are unchanged: no restrictions, turn-end scoring works', () => {
  const p = normalizeProject(sampleProject());
  p.automation.scoring = [{ event: 'turnEnd', who: 'active', counter: 'score', expr: 'cardsInHand', when: '', label: 'test' }];
  const st = createGame(p, { players: players4.slice(0, 3), seed: 2 });
  assert.equal(legalMoves(p, st, 'p1'), null);
  assert.equal(checkAction(p, st, { type: 'endTurn', actor: 'p1' }), null);
  const n = st.zones['p1.hand'].cards.length;
  apply(p, st, { type: 'endTurn', actor: 'p1' });
  assert.equal(st.players[0].counters.score, n);
  assert.equal(activePlayer(st).id, 'p2');
});

// ------------------------------------------------------------------ shedding + pauses
import { switchbackProject } from '../../static/js/model.js';
import { announcementsDue, cardEffects, shedColours, shedTop } from '../../static/js/engine.js';

function playShedTurn(p, st, r) {
  const pid = activePlayer(st).id;
  const lm = legalMoves(p, st, pid);
  const stat = (u, k) => p.cards.find((d) => d.id === st.cards[u].defId).stats[k];
  if (lm.legal.length && r() < 0.85) {
    const card = lm.legal[Math.floor(r() * lm.legal.length)];
    // legal means: matches colour or value, or is wild
    const fx = cardEffects(p, st, card);
    assert.ok(fx.wild || String(stat(card, 'colour')) === st.hand.colour || String(stat(card, 'value')) === st.hand.value);
    const colours = shedColours(p);
    const choose = colours[Math.floor(r() * colours.length)];
    // say "Last card!" when due, but forget sometimes
    const due = announcementsDue(p, st, pid, card);
    const announce = due.filter(() => r() < 0.6);
    assert.equal(checkAction(p, st, { type: 'move', card, to: 'discard', actor: pid, choose, announce }), null);
    const nextBefore = st.players[(st.players.findIndex((x) => x.id === pid) + st.dir + st.players.length) % st.players.length];
    const nextHand = st.zones[`${nextBefore.id}.hand`].cards.length;
    const dirBefore = st.dir;
    const roundBefore = st.hand.number;
    const pendingBefore = st.hand.pendingDraw;
    apply(p, st, { type: 'move', card, to: 'discard', actor: pid, choose, announce });
    const sameRound = st.status === 'playing' && st.hand.number === roundBefore;
    if (!sameRound) return; // went out: the next round has been dealt
    assert.equal(shedTop(p, st), card);
    if (fx.wild) assert.equal(st.hand.colour, choose);
    else assert.equal(st.hand.colour, String(stat(card, 'colour')));
    if (fx.reverse) assert.equal(st.dir, -dirBefore);
    if (fx.draw) {
      // stacking: nothing drawn yet; the next player faces the running total
      assert.equal(st.hand.pendingDraw, pendingBefore + fx.draw);
      assert.equal(activePlayer(st).id, nextBefore.id);
    } else if (fx.skip || (fx.reverse && st.players.length === 2)) {
      assert.notEqual(activePlayer(st).id, nextBefore.id, 'victim misses a turn');
    }
    // a missed "Last card!" can be caught by someone else, sometimes
    if (st.catchable && r() < 0.5) {
      const catcher = st.players.find((x) => x.id !== st.catchable.pid).id;
      const target = st.catchable.pid;
      const before = st.zones[`${target}.hand`].cards.length;
      apply(p, st, { type: 'catch', actor: catcher });
      assert.equal(st.zones[`${target}.hand`].cards.length, before + 2, 'caught player draws 2');
    }
    return;
  }
  if (lm.canDraw) {
    assert.equal(checkAction(p, st, { type: 'draw', actor: pid }), null);
    const n = st.hand.pendingDraw;
    const before = st.zones[`${pid}.hand`].cards.length;
    apply(p, st, { type: 'draw', actor: pid });
    if (n) {
      assert.equal(st.zones[`${pid}.hand`].cards.length, before + n, 'took the stacked cards');
      assert.notEqual(activePlayer(st).id, pid, 'and missed the turn');
      assert.equal(st.hand.pendingDraw, 0);
    }
    return;
  }
  assert.ok(lm.canPass);
  apply(p, st, { type: 'endTurn', actor: pid });
}

test('shedding (Switchback): legal plays, effects, round scoring, game end', () => {
  const p = normalizeProject(switchbackProject());
  const total = p.cards.reduce((n, c) => n + c.count, 0);
  for (let seed = 1; seed <= 12; seed++) {
    const n = 2 + (seed % 5);
    const st = createGame(p, { players: players4.concat(players4).slice(0, n), seed });
    const r = rng(seed * 7);
    // starting card is never an action or wild
    const fx0 = cardEffects(p, st, shedTop(p, st));
    assert.ok(!(fx0.wild || fx0.skip || fx0.reverse || fx0.draw));
    let safety = 0;
    let lastScores = st.players.map((x) => x.counters.score);
    let rounds = 0;
    while (st.status === 'playing' && safety++ < 20000) {
      const handNo = st.hand.number;
      playShedTurn(p, st, r);
      // cards are conserved
      assert.equal(Object.values(st.zones).reduce((a, z) => a + z.cards.length, 0), total);
      if (st.hand.number !== handNo || st.status === 'ended') {
        rounds++;
        // exactly one player (the one who went out) gained points: those left in other hands
        const now = st.players.map((x) => x.counters.score);
        const gained = now.map((v, i) => v - lastScores[i]).filter((d) => d !== 0);
        assert.ok(gained.length <= 1, 'only the round winner scores');
        lastScores = now;
      }
    }
    assert.equal(st.status, 'ended', `seed ${seed} finished (${rounds} rounds)`);
    assert.equal(st.result.winners.length, 1);
    assert.ok(st.players.find((x) => x.id === st.result.winners[0]).counters.score >= 150);
  }
});

test('shedding: draw rules - only the drawn card or pass after drawing', () => {
  const p = normalizeProject(switchbackProject());
  const st = createGame(p, { players: players4, seed: 4 });
  const pid = activePlayer(st).id;
  assert.match(checkAction(p, st, { type: 'endTurn', actor: pid }), /play a card or draw/);
  const handBefore = st.zones[`${pid}.hand`].cards.length;
  apply(p, st, { type: 'draw', actor: pid });
  if (activePlayer(st).id === pid) {
    // drawn card is playable: only it is legal, pass allowed, second draw not
    const lm = legalMoves(p, st, pid);
    assert.deepEqual(lm.legal, [st.hand.drawn]);
    assert.ok(lm.canPass && !lm.canDraw);
    assert.match(checkAction(p, st, { type: 'draw', actor: pid }), /already drawn/);
    apply(p, st, { type: 'endTurn', actor: pid });
  }
  assert.notEqual(activePlayer(st).id, pid);
  assert.equal(st.zones[`${pid}.hand`].cards.length, handBefore + 1);
  const other = st.players.find((x) => x.id !== activePlayer(st).id).id;
  assert.match(checkAction(p, st, { type: 'draw', actor: other }), /turn/);
});

test('pauses: after each trick and each hand, until "continue"', () => {
  const p = normalizeProject(whistProject());
  const st = createGame(p, { players: players4, seed: 5, options: { pauseTricks: true, pauseHands: true } });
  for (let i = 0; i < 4; i++) {
    const lm = legalMoves(p, st, activePlayer(st).id);
    apply(p, st, { type: 'move', card: lm.legal[0], to: 'trick', actor: lm.pid });
  }
  assert.equal(st.pending?.type, 'trick');
  assert.equal(st.zones.trick.cards.length, 4, 'trick stays on the table while paused');
  const pid = activePlayer(st).id;
  assert.equal(legalMoves(p, st, pid).legal.length, 0);
  assert.match(checkAction(p, st, { type: 'move', card: st.zones[`${pid}.hand`].cards[0], to: 'trick', actor: pid }), /paused/);
  apply(p, st, { type: 'continue', actor: 'designer' });
  assert.equal(st.pending, null);
  assert.equal(st.zones.trick.cards.length, 0);
  assert.equal(st.hand.tricksPlayed, 1);
  // play out the hand: it should pause after the 13th trick, before re-dealing
  let guard = 0;
  while (st.hand.number === 1 && guard++ < 200) {
    if (st.pending?.type === 'hand') break;
    if (st.pending) { apply(p, st, { type: 'continue', actor: 'designer' }); continue; }
    const lm = legalMoves(p, st, activePlayer(st).id);
    apply(p, st, { type: 'move', card: lm.legal[0], to: 'trick', actor: lm.pid });
  }
  assert.equal(st.pending?.type, 'hand');
  assert.ok(st.lastHand && st.lastHand.changes.length === 2);
  assert.equal(Object.values(st.lastHand.tricks).reduce((a, b) => a + b, 0), 13);
  apply(p, st, { type: 'continue', actor: 'designer' });
  assert.equal(st.hand.number, 2);
  assert.equal(st.zones['p1.hand'].cards.length, 13);
});

// ------------------------------------------------------------------ stacking + announcements
function setHand(p, st, pid, names) {
  // put all of pid's cards back in the draw pile, then give them the named cards
  for (const u of [...st.zones[`${pid}.hand`].cards]) apply(p, st, { type: 'move', card: u, to: 'deck', actor: 'designer' });
  for (const name of names) {
    const top = shedTop(p, st);
    const u = Object.values(st.cards).find((c) => c.zone !== `${pid}.hand` && c.uid !== top && p.cards.find((d) => d.id === c.defId).name === name).uid;
    apply(p, st, { type: 'move', card: u, to: `${pid}.hand`, actor: 'designer' });
  }
}
const uidOf = (p, st, pid, name) => st.zones[`${pid}.hand`].cards.find((u) => p.cards.find((d) => d.id === st.cards[u].defId).name === name);

test('stacking draw cards (same size only)', () => {
  const p = normalizeProject(switchbackProject());
  const st = createGame(p, { players: players4, seed: 8 });
  const [a, b, c, d] = ['p1', 'p2', 'p3', 'p4'];
  st.turn.active = 0; st.hand.colour = 'Ember'; st.hand.value = '3';
  setHand(p, st, a, ['Ember +2', 'Ember 5', 'Ember 6']);
  setHand(p, st, b, ['Lagoon +2', 'Prism +4', 'Moss 1']);
  setHand(p, st, c, ['Plum 2', 'Plum 3']);
  apply(p, st, { type: 'move', card: uidOf(p, st, a, 'Ember +2'), to: 'discard', actor: a });
  assert.equal(activePlayer(st).id, b);
  assert.equal(st.hand.pendingDraw, 2);
  const lm = legalMoves(p, st, b);
  assert.deepEqual(lm.legal, [uidOf(p, st, b, 'Lagoon +2')], 'only the same-size draw card can be stacked');
  assert.equal(lm.takeCount, 2);
  assert.match(checkAction(p, st, { type: 'endTurn', actor: b }), /Stack a draw card or take/);
  assert.match(checkAction(p, st, { type: 'move', card: uidOf(p, st, b, 'Prism +4'), to: 'discard', actor: b }), /stack another draw-2/);
  apply(p, st, { type: 'move', card: uidOf(p, st, b, 'Lagoon +2'), to: 'discard', actor: b });
  assert.equal(st.hand.pendingDraw, 4);
  assert.equal(activePlayer(st).id, c);
  apply(p, st, { type: 'draw', actor: c });
  assert.equal(st.zones[`${c}.hand`].cards.length, 6, 'took 4');
  assert.equal(activePlayer(st).id, d, 'and missed the turn');

  // "any" mode lets a +4 go on a +2
  p.automation.shedding.stackDraws = 'any';
  const st2 = createGame(p, { players: players4, seed: 8 });
  st2.turn.active = 0; st2.hand.colour = 'Ember'; st2.hand.value = '3';
  setHand(p, st2, a, ['Ember +2', 'Ember 5']);
  setHand(p, st2, b, ['Prism +4', 'Moss 1']);
  apply(p, st2, { type: 'move', card: uidOf(p, st2, a, 'Ember +2'), to: 'discard', actor: a });
  assert.deepEqual(legalMoves(p, st2, b).legal, [uidOf(p, st2, b, 'Prism +4')]);
});

test('announcements: say it in time, get caught, automatic penalty, tracked in scoring', () => {
  const p = normalizeProject(switchbackProject());
  const st = createGame(p, { players: players4, seed: 9 });
  const [a, b, c] = ['p1', 'p2', 'p3'];
  st.turn.active = 0; st.hand.colour = 'Ember'; st.hand.value = '3';
  setHand(p, st, a, ['Ember 5', 'Ember 6']);
  assert.deepEqual(announcementsDue(p, st, a, uidOf(p, st, a, 'Ember 5')), ['lastCard']);
  // 1. said in time (separate announce action, then the play)
  assert.equal(checkAction(p, st, { type: 'announce', id: 'lastCard', actor: b }), 'You can only make an announcement on your own turn.');
  apply(p, st, { type: 'announce', id: 'lastCard', actor: a });
  apply(p, st, { type: 'move', card: uidOf(p, st, a, 'Ember 5'), to: 'discard', actor: a });
  assert.equal(st.catchable, null);
  assert.equal(st.annStats[a].lastCard.made, 1);

  // 2. forgotten and caught: the catcher's "Catches" counter goes up (scoring rule on the penalty event)
  st.turn.active = 0; st.hand.colour = 'Ember'; st.hand.value = '3';
  setHand(p, st, a, ['Ember 7', 'Ember 8']);
  apply(p, st, { type: 'move', card: uidOf(p, st, a, 'Ember 7'), to: 'discard', actor: a });
  assert.equal(st.catchable?.pid, a);
  assert.match(checkAction(p, st, { type: 'catch', actor: a }), /yourself/);
  apply(p, st, { type: 'catch', actor: c });
  assert.equal(st.zones[`${a}.hand`].cards.length, 3, '1 + 2 penalty cards');
  assert.equal(st.annStats[a].lastCard.missed, 1);
  assert.equal(st.annStats[a].lastCard.caught, 1);
  assert.equal(st.annStats[c].lastCard.catches, 1);
  assert.equal(st.players[2].counters.catches, 1);

  // 3. forgotten, nobody catches before the next player acts: the window closes
  st.turn.active = 0; st.hand.colour = 'Ember'; st.hand.value = '3';
  setHand(p, st, a, ['Ember 9', 'Ember 4']);
  apply(p, st, { type: 'move', card: uidOf(p, st, a, 'Ember 9'), to: 'discard', actor: a });
  assert.ok(st.catchable);
  apply(p, st, { type: 'draw', actor: activePlayer(st).id });
  assert.equal(st.catchable, null);
  assert.match(st.log.map((e) => e.text).join('\n'), /Nobody caught North in time/);

  // 4. automatic penalty mode, and a points penalty instead of cards
  p.automation.announcements[0] = { ...p.automation.announcements[0], ifMissed: 'auto', penaltyDraw: 0, penaltyCounter: 'score', penaltyAmount: '-10' };
  st.turn.active = 0; st.hand.colour = 'Ember'; st.hand.value = '3';
  setHand(p, st, a, ['Ember 1', 'Ember 2']);
  apply(p, st, { type: 'move', card: uidOf(p, st, a, 'Ember 1'), to: 'discard', actor: a });
  assert.equal(st.catchable, null);
  assert.equal(st.players[0].counters.score, -10);
  assert.equal(st.annStats[a].lastCard.missed, 3);
  assert.ok(describeAutomation(p).some((l) => l.includes('Announcement "Last card!"')));
});

// ------------------------------------------------------------------ set collection (Weirdwolves)
import { applyVariants, werewolfProject } from '../../static/js/model.js';
import { setsBotTurn, setsBreakdown, zoneTricks } from '../../static/js/engine.js';
import { bestTricks, compileSets, parsePattern } from '../../static/js/sets.js';

test('set collection: patterns and the best split into tricks', () => {
  const p = normalizeProject(werewolfProject());
  const C = compileSets(p, p.automation.sets);
  assert.deepEqual(C.errors, []);
  const score = (names) => bestTricks(C, names.map((n) => p.cards.find((c) => c.name === n).id)).total;
  assert.equal(score(Array(5).fill('Villager')), 5, 'Mob');
  assert.equal(score(Array(4).fill('Villager')), 0, 'four villagers are not a set');
  assert.equal(score(['Seer', 'Witch', 'Werewolf', 'Vampire']), 11, 'Vision: 3 different Night characters');
  assert.equal(score(['Seer', 'Seer', 'Werewolf', 'Witch']), 7, 'Vision with a second Seer');
  assert.equal(score(['Seer', 'Sister', 'Hunter', 'Cupid']), 4, 'Day characters do not count for a Seer: only Lovers (3 + 2 - 1)');
  assert.equal(score(['Seer', 'Witch', 'Villager', 'Werewolf']), 6, 'a Villager is not a Night character: Potions instead');
  assert.equal(score(['Sister', 'Sister']), 6, 'Sisters');
  assert.equal(score(['Hunter', 'Werewolf']), 4, 'Hunt');
  assert.equal(score(['Defender', 'Sister']), 6, 'a Defender can guard a Sister');
  assert.equal(score(['Defender', 'Hunter']), 4, 'and a Hunter');
  assert.equal(score(['Sister']), 0, 'one Sister alone is not a set');
  assert.equal(score(['Werewolf', 'Villager']), 3, 'Dinner');
  assert.equal(score(['Witch', 'Villager', 'Werewolf']), 6, 'Potions');
  assert.equal(score(['Alpha Wolf', 'Werewolf', 'Werewolf', 'Werewolf']), 10, 'Pack: 3 Werewolves');
  assert.equal(score(['Alpha Wolf', 'Werewolf', 'Werewolf']), 0, 'two Werewolves are not a Pack');
  assert.equal(score(['Defender', 'Villager']), 2, 'Defend = 2 x the guarded card');
  assert.equal(score(['Defender', 'Witch']), 6);
  assert.equal(score(['Vampire', 'Villager', 'Villager', 'Villager']), 8, 'Feast');
  assert.equal(score(['Cupid', 'Vampire', 'Vampire']), 9, 'Lovers: the two cards, less 1 for Cupid');
  assert.equal(score(['Cannibal', ...Array(5).fill('Villager')]), 11, 'Banquet beats a Mob');
  assert.equal(score(['Cannibal', 'Sister', 'Sister', 'Hunter', 'Villager', 'Villager']), 16, 'Banquet: any 5 Day characters');
  assert.equal(score(['Cannibal', 'Werewolf', 'Villager', 'Villager', 'Villager', 'Villager']), 3, 'a Werewolf is not a Day character: only a Dinner');
  // Each card counts once, and the best arrangement wins: Feast + Dinner beats Mob.
  assert.equal(score(['Vampire', 'Werewolf', ...Array(5).fill('Villager')]), 11);
  assert.match(parsePattern('dragon + villager', p.cards).error, /No card is called "dragon"/);
  // The other scoring: every card scores, sets add a bonus (Day x3).
  const q = normalizeProject(applyVariants(werewolfProject(), { scoring: 1 }));
  const st = createGame(q, { players: players4.slice(0, 3), seed: 2 });
  const put = (name, zone) => {
    const u = Object.values(st.cards).find((c) => q.cards.find((d) => d.id === c.defId).name === name && c.zone === 'nightpile').uid;
    const from = st.zones.nightpile.cards;
    from.splice(from.indexOf(u), 1);
    st.zones[zone].cards.push(u);
    st.cards[u].zone = zone;
  };
  for (const n of ['Werewolf', 'Villager', 'Vampire']) put(n, 'p1.night');
  assert.equal(zoneTricks(q, st, 'p1.night').total, 2 + 0 + 1 + 4, 'Dinner (2 + 0 + bonus 1) and a lone Vampire (4)');
  for (let i = 0; i < 5; i++) put('Villager', 'p2.day');
  put('Cannibal', 'p2.day');
  assert.equal(setsBreakdown(q, st, 'p2').zones[0].points, (4 + 10) * 3, 'Banquet in the Day: (4 + bonus 10) x 3');
});

test('set collection: actions, swaps, steals, hand limit and the end of the game', () => {
  const p = normalizeProject(applyVariants(werewolfProject(), { pickup: 1 })); // draw and swap

  p.automation.sets.arrange = 'manual';
  const st = createGame(p, { players: players4.slice(0, 3), seed: 5 });
  const [a, b] = ['p1', 'p2'];
  assert.equal(st.zones['p1.hand'].cards.length, 3);
  assert.equal(st.zones.dayrow.cards.length, 4);
  const card = (name, zone) => {
    const u = Object.values(st.cards).find((c) => p.cards.find((d) => d.id === c.defId).name === name && c.zone !== `${a}.day` && c.zone !== `${b}.day` && c.zone !== zone).uid;
    const from = st.zones[st.cards[u].zone].cards;
    from.splice(from.indexOf(u), 1);
    st.zones[zone].cards.push(u);
    st.cards[u].zone = zone;
    return u;
  };
  // B has a loose Werewolf in their Day tricks; A completes the Hunt with a Villager and takes it.
  const wolf = card('Werewolf', `${b}.day`);
  const vil = card('Villager', `${a}.hand`);
  assert.equal(zoneTricks(p, st, `${b}.day`).loose.length, 1);
  assert.ok(legalMoves(p, st, a).options.some((o) => o.kind === 'give' && o.card === vil && o.victim === b));
  apply(p, st, { type: 'move', card: vil, to: `${b}.day`, actor: a });
  assert.equal(st.cards[wolf].zone, `${a}.night`);
  assert.equal(st.cards[vil].zone, `${a}.night`);
  assert.equal(setsBreakdown(p, st, a).hidden, 3);
  assert.equal(st.players[0].counters.score, 0, 'night points stay hidden until the end');
  // A card that completes nothing cannot be put in someone else's zone.
  const lone = card('Seer', `${a}.hand`);
  assert.match(checkAction(p, st, { type: 'move', card: lone, to: `${b}.day`, actor: a }), /does not complete a set/);
  // Swap with a face-up Day card: it takes the card's place.
  const market = st.zones.dayrow.cards[1];
  apply(p, st, { type: 'swap', card: lone, with: market, actor: a });
  assert.equal(st.zones.dayrow.cards[1], lone);
  assert.equal(st.cards[market].zone, `${a}.hand`);
  assert.equal(activePlayer(st).id, b, 'two actions used: the turn passes');
  // Day tricks score double and count straight away; finished tricks are safe.
  const w2 = card('Werewolf', `${b}.hand`);
  const v2 = card('Villager', `${b}.hand`);
  apply(p, st, { type: 'move', card: w2, to: 'day', actor: b });
  apply(p, st, { type: 'move', card: v2, to: 'day', actor: b });
  assert.equal(st.players[1].counters.score, 6);
  const v3 = card('Villager', 'p3.hand');
  // An unstacked trick can still be used: p3 completes a Hunt with B's Werewolf.
  assert.ok(legalMoves(p, st, 'p3').options.some((o) => o.kind === 'give' && o.card === v3 && o.victim === b), 'unstacked cards can be taken');
  // Hand limit: discard down to 6 before the turn passes.
  for (let i = 0; i < 6; i++) card('Villager', 'p3.hand');
  apply(p, st, { type: 'draw', actor: 'p3' });
  apply(p, st, { type: 'draw', actor: 'p3' });
  assert.equal(activePlayer(st).id, 'p3');
  assert.ok(legalMoves(p, st, 'p3').discarding);
  assert.match(checkAction(p, st, { type: 'draw', actor: 'p3' }), /Discard/);
  while (legalMoves(p, st, 'p3').discarding) apply(p, st, { type: 'move', card: st.zones['p3.hand'].cards[0], to: 'discard', actor: 'p3' });
  assert.equal(st.zones['p3.hand'].cards.length, 6);
  assert.equal(activePlayer(st).id, a);
});

test('set collection: whole bot games keep every card and end with equal turns', () => {
  const p = normalizeProject(werewolfProject());
  for (const n of [3, 4]) {
    for (let seed = 1; seed <= 6; seed++) {
      const st = createGame(p, { players: players4.slice(0, n), seed });
      const turns = Object.fromEntries(st.players.map((x) => [x.id, 0]));
      let guard = 0;
      while (st.status === 'playing' && guard++ < 2000) {
        const pid = activePlayer(st).id;
        const turn = st.turn.number;
        for (const a of setsBotTurn(p, st, pid)) {
          assert.equal(checkAction(p, st, { ...a, actor: pid }), null, JSON.stringify(a));
          apply(p, st, { ...a, actor: pid });
          if (st.status !== 'playing' || activePlayer(st).id !== pid) break;
        }
        if (st.status === 'playing' && activePlayer(st).id === pid && st.turn.number === turn) continue;
        turns[pid]++;
      }
      assert.equal(st.status, 'ended');
      assert.equal(Object.values(st.zones).reduce((s, z) => s + z.cards.length, 0), 82);
      assert.equal(st.zones.nightpile.cards.length, 0);
      assert.equal(new Set(Object.values(turns)).size, 1, `equal turns: ${JSON.stringify(turns)}`);
      for (const x of st.players) assert.equal(x.counters.score, setsBreakdown(p, st, x.id).total);
      assert.ok(st.result.winners.length >= 1);
    }
  }
});

test('set collection: stacking protects a trick and fixes how it scores', () => {
  const p = normalizeProject(werewolfProject());
  p.automation.sets.arrange = 'manual';
  const st = createGame(p, { players: players4.slice(0, 3), seed: 9 });
  const put = (name, zone) => {
    const u = Object.values(st.cards).find((c) => p.cards.find((d) => d.id === c.defId).name === name && !c.zone.includes('.day') && c.zone !== zone && !c.zone.includes('.hand')).uid;
    const from = st.zones[st.cards[u].zone].cards;
    from.splice(from.indexOf(u), 1);
    st.zones[zone].cards.push(u);
    st.cards[u].zone = zone;
    return u;
  };
  // p1 plays a Werewolf and then a Villager with "stack": the Hunt is stacked and safe.
  const w = put('Werewolf', 'p1.hand');
  const v = put('Villager', 'p1.hand');
  apply(p, st, { type: 'move', card: w, to: 'day', actor: 'p1' });
  const lm = legalMoves(p, st, 'p1');
  assert.ok(lm.options.some((o) => o.kind === 'play' && o.card === v && o.stack && o.gain === 6));
  apply(p, st, { type: 'move', card: v, to: 'day', stack: true, actor: 'p1' });
  assert.deepEqual(st.stacks['p1.day'], [[v, w]]);
  assert.equal(st.players[0].counters.score, 6);
  // A Villager from p2 no longer completes anything with p1's cards.
  const v2 = put('Villager', 'p2.hand');
  assert.ok(!legalMoves(p, st, 'p2').options.some((o) => o.kind === 'give' && o.card === v2 && o.victim === 'p1'));
  assert.match(checkAction(p, st, { type: 'move', card: v2, to: 'p1.day', actor: 'p2' }), /stacked sets are safe/);
  // Stacking is free and checked: p2 lays a Defender and a Witch unstacked...
  const d = put('Defender', 'p2.day');
  const wi = put('Witch', 'p2.day');
  const lm2 = legalMoves(p, st, 'p2');
  const opt = lm2.options.find((o) => o.kind === 'stack');
  assert.ok(opt, 'a stack option for the unstacked Guard');
  assert.match(checkAction(p, st, { type: 'stack', cards: [d], actor: 'p2' }), /is not a set/);
  const before = st.hand.actionsUsed;
  apply(p, st, { ...opt.action, actor: 'p2' });
  assert.equal(st.hand.actionsUsed, before, 'stacking does not use an action');
  assert.equal(st.players[1].counters.score, 12, 'Guard with a Witch: Defender worth 3, (3 + 3) x 2');
  assert.match(checkAction(p, st, { type: 'stack', cards: [d, wi], actor: 'p2' }), /already in a stack/);
  // A stacked Guard keeps its Defender even if a better arrangement would use it elsewhere.
  put('Cupid', 'p2.day');
  put('Vampire', 'p2.day');
  assert.equal(zoneTricks(p, st, 'p2.day').total, 6, 'the Cupid has only the Vampire: no Lovers');
});

test('set collection: Day tricks group themselves; steals can use several cards', () => {
  const p = normalizeProject(werewolfProject());
  assert.equal(p.automation.sets.arrange, 'auto');
  const st = createGame(p, { players: players4.slice(0, 3), seed: 21 });
  const put = (name, zone) => {
    const u = Object.values(st.cards).find((c) => p.cards.find((d) => d.id === c.defId).name === name && c.zone === 'nightpile').uid;
    const from = st.zones.nightpile.cards;
    from.splice(from.indexOf(u), 1);
    st.zones[zone].cards.push(u);
    st.cards[u].zone = zone;
    return u;
  };
  // A Dinner, then a Seer, a Witch and a Vampire: they regroup into a Vision, leaving only the Villager alone.
  put('Werewolf', 'p2.day'); put('Villager', 'p2.day');
  assert.deepEqual(zoneTricks(p, st, 'p2.day').tricks.map((t) => t.label), ['Dinner']);
  put('Seer', 'p2.day'); put('Witch', 'p2.day'); put('Vampire', 'p2.day');
  let t = zoneTricks(p, st, 'p2.day');
  assert.deepEqual(t.tricks.map((x) => x.label), ['Vision']);
  assert.deepEqual(t.lone.map((u) => st.cards[u].defId), ['villager']);
  // Fewest lone cards, and the least valuable left alone: Werewolf + 2 Villagers -> Hunt, lone Villager.
  put('Werewolf', 'p3.day'); put('Villager', 'p3.day'); put('Villager', 'p3.day');
  t = zoneTricks(p, st, 'p3.day');
  assert.equal(t.lone.length, 1);
  assert.equal(st.cards[t.lone[0]].defId, 'villager');
  // p1 holds two Villagers; p3 now has a Vampire and the lone Villager: two cards complete a Feast.
  const vamp = put('Vampire', 'p3.day');
  t = zoneTricks(p, st, 'p3.day');
  assert.equal(t.lone.length, 2, 'Vampire + lone Villager');
  const a = put('Villager', 'p1.hand');
  const b = put('Villager', 'p1.hand');
  const lm = legalMoves(p, st, 'p1');
  const steal = lm.options.find((o) => o.kind === 'steal' && o.victim === 'p3');
  assert.ok(steal, 'a two-card steal is offered');
  assert.deepEqual(steal.cards.map((u) => st.cards[u].defId), ['villager', 'villager']);
  assert.ok(a && b);
  apply(p, st, { ...steal.action, actor: 'p1' });
  assert.equal(st.cards[vamp].zone, 'p1.night');
  assert.equal(st.zones['p1.night'].cards.length, 4, 'Vampire + 3 Villagers taken');
  assert.equal(activePlayer(st).id, 'p2', 'two cards = two actions: the turn passed');
  assert.match(checkAction(p, st, { type: 'steal', cards: [put('Seer', 'p2.hand')], to: 'p3.day', actor: 'p2' }), /do not complete a set/);
  // A steal must use at least one of the other player's cards: a Hunter and a Werewolf of your own are not a steal.
  put('Werewolf', 'p3.day');
  const own = [put('Hunter', 'p2.hand'), put('Werewolf', 'p2.hand')];
  assert.match(checkAction(p, st, { type: 'steal', cards: own, to: 'p3.day', actor: 'p2' }), /do not complete a set/);
  assert.ok(!legalMoves(p, st, 'p2').options.some((o) => o.kind === 'steal' && o.cards.length === 2 && o.cards.every((u) => own.includes(u))));
});

test('Weirdwolves: named sets, and "sets" (not "tricks") in what players read', () => {
  const p = normalizeProject(werewolfProject());
  assert.equal(p.name, 'Weirdwolves');
  const labels = p.automation.sets.combos.map((c) => c.label);
  assert.ok(labels.includes('Dinner') && labels.includes('Hunt') && !labels.includes('Silver Bullet'));
  assert.equal(p.automation.sets.combos.find((c) => c.label === 'Hunt').pattern, 'hunter + werewolf');
  const text = [describeAutomation(p).join(' '), Object.values(p.rules).join(' '), p.zones.map((z) => z.name).join(' '), p.cards.map((c) => c.rules).join(' ')].join(' ');
  assert.doesNotMatch(text, /\btricks?\b/i);
  const st = createGame(p, { players: players4.slice(0, 3), seed: 4 });
  const lm = legalMoves(p, st, activePlayer(st).id);
  assert.doesNotMatch([lm.summary, ...lm.options.map((o) => o.label)].join(' '), /\btricks?\b/i);
});

test('set collection rule options: sets that lock, a per-turn zone limit, sets that move, the village vote', () => {
  const p = normalizeProject(werewolfProject());
  const S = p.automation.sets;
  S.arrange = 'lock';
  S.zoneLimits = { day: 1 };
  S.combos.find((c) => c.id === 'lovers').moveTo = 'night';
  S.vote = 'night';
  const st = createGame(p, { players: players4.slice(0, 3), seed: 5 });
  const put = (name, zone) => {
    const u = Object.values(st.cards).find((c) => p.cards.find((d) => d.id === c.defId).name === name && c.zone === 'nightpile').uid;
    const from = st.zones.nightpile.cards;
    from.splice(from.indexOf(u), 1);
    st.zones[zone].cards.push(u);
    st.cards[u].zone = zone;
    return u;
  };
  const turnOf = (pid) => { while (activePlayer(st).id !== pid) apply(p, st, { type: 'endTurn', actor: activePlayer(st).id }); };
  turnOf('p1');
  // One card a turn to the Day sets.
  const w = put('Werewolf', 'p1.hand');
  const v = put('Villager', 'p1.hand');
  apply(p, st, { type: 'move', card: w, to: 'day', actor: 'p1' });
  assert.ok(!legalMoves(p, st, 'p1').options.some((o) => o.kind === 'play' && o.to === 'p1.day'), 'no second Day play');
  assert.match(checkAction(p, st, { type: 'move', card: v, to: 'day', actor: 'p1' }), /only 1 card a turn/);
  apply(p, st, { type: 'move', card: v, to: 'night', actor: 'p1' });
  // Next turn the Villager completes a Dinner, which locks.
  turnOf('p1');
  const v2 = put('Villager', 'p1.hand');
  apply(p, st, { type: 'move', card: v2, to: 'day', actor: 'p1' });
  assert.deepEqual(st.stacks['p1.day'].map((g) => g.length), [2]);
  // A locked set is not regrouped: a Seer, Witch and Hunter added later cannot take the Werewolf into a Vision.
  for (const n of ['Seer', 'Witch', 'Hunter']) put(n, 'p1.day');
  const t = zoneTricks(p, st, 'p1.day');
  assert.ok(t.tricks.some((x) => x.label === 'Dinner' && x.stacked));
  assert.equal(t.lone.length, 3);
  // Lovers "go to sleep": made in the Day, they move to the Night sets.
  apply(p, st, { type: 'endTurn', actor: 'p1' });
  const cupid = put('Cupid', 'p2.hand');
  put('Sister', 'p2.day'); put('Hunter', 'p2.day');
  apply(p, st, { type: 'move', card: cupid, to: 'day', actor: 'p2' });
  assert.equal(st.cards[cupid].zone, 'p2.night');
  assert.equal(st.zones['p2.day'].cards.length, 0);
  assert.ok(st.log.some((e) => e.type === 'nightfall' && /Lovers/.test(e.text)));
  // The village vote at the end of the round: p1 leads the Day, so their Dinner moves to their Night.
  apply(p, st, { type: 'endTurn', actor: 'p2' });
  apply(p, st, { type: 'endTurn', actor: 'p3' });
  assert.equal(activePlayer(st).id, 'p1');
  assert.equal(st.cards[w].zone, 'p1.night');
  assert.ok(st.log.some((e) => e.type === 'nightfall' && e.data?.vote));
});

test('set collection: a set limit moves a set of the player\'s choice to the Night at the end of their turn', () => {
  const p = normalizeProject(werewolfProject());
  p.automation.sets.setLimits = { day: 3 };
  const st = createGame(p, { players: players4.slice(0, 3), seed: 8 });
  const put = (name, zone) => {
    const u = Object.values(st.cards).find((c) => p.cards.find((d) => d.id === c.defId).name === name && c.zone === 'nightpile').uid;
    const from = st.zones.nightpile.cards;
    from.splice(from.indexOf(u), 1);
    st.zones[zone].cards.push(u);
    st.cards[u].zone = zone;
    return u;
  };
  while (activePlayer(st).id !== 'p1') apply(p, st, { type: 'endTurn', actor: activePlayer(st).id });
  put('Sister', 'p1.day'); put('Sister', 'p1.day');
  put('Hunter', 'p1.day'); put('Werewolf', 'p1.day');
  put('Werewolf', 'p1.day'); put('Villager', 'p1.day');
  const w = put('Werewolf', 'p1.hand');
  const v = put('Villager', 'p1.hand');
  apply(p, st, { type: 'move', card: w, to: 'day', actor: 'p1' });
  apply(p, st, { type: 'move', card: v, to: 'day', actor: 'p1' });
  assert.equal(zoneTricks(p, st, 'p1.day').tricks.length, 4);
  assert.equal(activePlayer(st).id, 'p1', 'the turn waits for a set to move');
  const lm = legalMoves(p, st, 'p1');
  assert.deepEqual(lm.options.map((o) => o.kind), ['retire', 'retire', 'retire', 'retire']);
  assert.match(checkAction(p, st, { type: 'endTurn', actor: 'p1' }), /Move one of your sets/);
  const sisters = lm.options.find((o) => o.combo === 'Sisters');
  apply(p, st, { ...sisters.action, actor: 'p1' });
  assert.equal(zoneTricks(p, st, 'p1.day').tricks.length, 3);
  assert.equal(zoneTricks(p, st, 'p1.night').tricks.find((t) => t.label === 'Sisters').points, 6);
  assert.equal(activePlayer(st).id, 'p2');
});

test('set collection: cards that always score, and Day cards swapped into the Day or taken into the Night', () => {
  const p = normalizeProject(werewolfProject());
  const S = p.automation.sets;
  S.cardsScore = true;
  S.swap = true;
  S.swapTo = ['day'];
  S.takeTo = ['night'];
  for (const c of S.combos) c.points = { hunt: '1', guard: '2' }[c.id] || '3';
  const st = createGame(p, { players: players4.slice(0, 3), seed: 4 });
  const put = (name, zone) => {
    const u = Object.values(st.cards).find((c) => p.cards.find((d) => d.id === c.defId).name === name && c.zone === 'nightpile').uid;
    const from = st.zones.nightpile.cards;
    from.splice(from.indexOf(u), 1);
    st.zones[zone].cards.push(u);
    st.cards[u].zone = zone;
    return u;
  };
  // A lone Werewolf scores its 2; with a Villager it is a Dinner: 2 + 1 + bonus 1.
  put('Werewolf', 'p2.day');
  assert.equal(zoneTricks(p, st, 'p2.day').total, 2);
  put('Villager', 'p2.day');
  assert.equal(zoneTricks(p, st, 'p2.day').total, 4);
  // A Defender is worth the best card in its set, and nothing alone.
  put('Defender', 'p3.night');
  assert.equal(zoneTricks(p, st, 'p3.night').total, 0);
  put('Witch', 'p3.night');
  assert.equal(zoneTricks(p, st, 'p3.night').total, 3 + 3 + 2);
  while (activePlayer(st).id !== 'p1') apply(p, st, { type: 'endTurn', actor: activePlayer(st).id });
  const market = st.zones.dayrow.cards.slice();
  const mine = put('Seer', 'p1.hand');
  // Swap straight into the Day: one action, the hand card takes its place in the Day cards.
  const lm = legalMoves(p, st, 'p1');
  assert.ok(lm.options.some((o) => o.kind === 'swap' && o.to === 'p1.day'));
  assert.ok(lm.options.some((o) => o.kind === 'take' && o.to === 'p1.night'));
  assert.ok(!lm.options.some((o) => o.kind === 'take' && o.to === 'p1.day'), 'no take into the Day');
  apply(p, st, { type: 'swap', card: mine, with: market[0], to: 'day', actor: 'p1' });
  assert.equal(st.cards[market[0]].zone, 'p1.day');
  assert.equal(st.cards[mine].zone, 'dayrow');
  assert.equal(st.hand.actionsUsed, 1);
  // Take into the Night: no swap, refilled from the Night pile.
  const pile = st.zones.nightpile.cards.length;
  apply(p, st, { type: 'take', with: market[1], to: 'night', actor: 'p1' });
  assert.equal(st.cards[market[1]].zone, 'p1.night');
  assert.equal(st.zones.dayrow.cards.length, 4);
  assert.equal(st.zones.nightpile.cards.length, pile - 1);
  assert.equal(activePlayer(st).id, 'p2', 'two actions used');
  assert.match(checkAction(p, st, { type: 'take', with: st.zones.dayrow.cards[0], to: 'day', actor: 'p2' }), /only into your Night sets/);
});

test('set collection: picking only from the face-up cards (no blind draws, no swaps)', () => {
  const p = normalizeProject(werewolfProject());
  Object.assign(p.automation.sets, { draw: false, swap: false, takeTo: ['hand', 'night'] });
  const st = createGame(p, { players: players4.slice(0, 3), seed: 6 });
  const pid = activePlayer(st).id;
  const lm = legalMoves(p, st, pid);
  assert.ok(!lm.canDraw && !lm.options.some((o) => o.kind === 'draw' || o.kind === 'swap'));
  assert.equal(lm.options.filter((o) => o.kind === 'take').length, 8, '4 Day cards x (hand, Night)');
  assert.match(checkAction(p, st, { type: 'draw', actor: pid }), /face-up cards instead/);
  const [a, b] = st.zones.dayrow.cards;
  const pile = st.zones.nightpile.cards.length;
  apply(p, st, { type: 'take', with: a, to: 'hand', actor: pid });
  assert.equal(st.cards[a].zone, `${pid}.hand`);
  apply(p, st, { type: 'take', with: b, to: 'night', actor: pid });
  assert.equal(st.cards[b].zone, `${pid}.night`);
  assert.equal(st.zones.dayrow.cards.length, 4);
  assert.equal(st.zones.nightpile.cards.length, pile - 2);
  assert.notEqual(activePlayer(st).id, pid, 'one action each');
});
