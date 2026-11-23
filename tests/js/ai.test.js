// AI turn plumbing: parsing untidy replies, and whole turns through the shared
// turn loop (turns.js) with scripted "copy/paste" answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProject, werewolfProject } from '../../static/js/model.js';
import { activePlayer, createGame } from '../../static/js/engine.js';
import { buildPrompt, parseResponse } from '../../static/js/ai.js';
import { takeAiTurn } from '../../static/js/turns.js';

test('parseResponse finds the turn inside prose, markup and repeated objects', () => {
  const prose = 'I hold a Werewolf.\n\n<invoke name="x">\n</invoke>\n\n{"actions":[{"type":"draw"}],"reasoning":"r","winConfidence":5,"experience":"","designerNotes":""}\n</invoke>\n{"error":"Invalid response format."}';
  assert.deepEqual(parseResponse(prose).actions, [{ type: 'draw' }]);
  const twice = '{"reasoning":"a","actions":[{"type":"endTurn"}]} Wait, here it is again: {"reasoning":"b","actions":[{"type":"draw"}],"winConfidence":1}';
  assert.equal(parseResponse(twice).reasoning, 'b');
  assert.deepEqual(parseResponse('<invoke name="move"></invoke>\n{"type":"draw"}').actions, [{ type: 'draw' }]);
  assert.equal(parseResponse('```json\n{"reasoning":"x } y","actions":[]}\n```').reasoning, 'x } y');
  assert.throws(() => parseResponse('<invoke name="move"></invoke>'), /No JSON/);
});

test('game-turn prompts ask hosted models for the turn format', () => {
  const p = normalizeProject(werewolfProject());
  const st = createGame(p, { players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], seed: 3 });
  assert.equal(buildPrompt(p, st, 'p1').format, 'turn');
});

test('set collection: an AI turn with prose and a score change, then the next AI plays too', async () => {
  const p = normalizeProject(werewolfProject());
  const players = [{ name: 'Me', controller: 'human' }, { name: 'Ava', controller: 'ai-manual' }, { name: 'Ben', controller: 'ai-manual' }];
  const st = createGame(p, { players, seed: 11 });
  st.turn.active = 1;
  const asks = [];
  const ui = {
    manual: async (prompt, seat) => {
      asks.push(seat.id);
      const hand = st.zones[`${seat.id}.hand`].cards;
      return `Let me think.\n<invoke name="x"></invoke>\n{"reasoning":"night","actions":[` +
        `{"type":"move","card":"${hand[0]}","to":"night","faceUp":false},` +
        `{"type":"counter","player":"${seat.id}","counter":"score","delta":8},` +
        `{"type":"move","card":"${hand[1]}","to":"night"},{"type":"endTurn"}],"winConfidence":30,"experience":"","designerNotes":""}`;
    },
  };
  await takeAiTurn(p, st, { ui });
  assert.equal(st.zones['p2.night'].cards.length, 2, 'both plays applied despite the score change');
  assert.equal(activePlayer(st).id, 'p3', 'the turn passed to the next AI');
  assert.ok(st.log.some((e) => /score change ignored/.test(e.text)));
  await takeAiTurn(p, st, { ui });
  assert.equal(st.zones['p3.night'].cards.length, 2, 'the second AI played its own turn');
  assert.equal(activePlayer(st).id, 'p1');
  assert.deepEqual(asks, ['p2', 'p3'], 'one question per AI turn');
});

test('an open page with older code refuses a game style it does not know', () => {
  const p = normalizeProject(werewolfProject());
  p.automation.style = 'from-the-future';
  assert.throws(() => createGame(p, { players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] }), /Reload the page/);
});
