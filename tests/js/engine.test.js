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
