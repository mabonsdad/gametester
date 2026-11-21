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
