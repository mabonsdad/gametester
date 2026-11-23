// One AI seat's turn, shared by the test bench (views/play.js) and the player
// view (player.js): ask the seat's AI for a move, check and apply it, ask again
// when needed (illegal move, or a shedding draw), and fall back to a legal move
// so the game never stalls.
import { checkAction as aiCheck, isAI, parseResponse, requestTurn } from './ai.js';
import {
  activePlayer, announcementRules, apply, automation, cardDef, checkAction as ruleCheck, isSets, isShedding, isTricks, legalMoves,
  setsBotTurn,
} from './engine.js';

export function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

// ui: { manual(prompt, player), waiting(message, cancel) } as used by requestTurn
// onStatus(message): progress text for the caller to show
// beforeChange(): called once, just before the first change to the state (for undo)
// isDisposed(): true if the caller has gone away; the answer is then ignored
export async function takeAiTurn(project, st, { ui = {}, onStatus = () => {}, beforeChange = () => {}, isDisposed = () => false } = {}) {
  const p = activePlayer(st);
  if (!isAI(p.controller)) throw new Error(`${p.name} is a human seat.`);
  const turnAtStart = st.turn.number;
  const tricks = isTricks(project);
  const shedding = isShedding(project);
  const sets = isSets(project);
  const automated = tricks || shedding || sets;
  // Set-collection turns come in parts: after a draw (or when a discard is due) the seat is asked again.
  const maxAsks = sets ? (p.controller === 'ai-random' ? 10 : 4) : shedding ? 3 : tricks ? 2 : 1;
  const strict = automation(project).enforce === 'strict';
  const act = (a) => apply(project, st, { ...a, actor: a.actor || p.id });
  const myTurn = () => st.status === 'playing' && activePlayer(st).id === p.id && st.turn.number === turnAtStart;
  let feedback = '';
  let parsed = null;
  let endRequested = false;
  let changed = false;
  for (let attempt = 0; attempt < maxAsks; attempt++) {
    const res = await requestTurn(project, st, ui, feedback);
    if (isDisposed()) return { player: p, parsed: null, disposed: true };
    if (!myTurn()) throw new Error('The table changed while the AI was thinking; its answer was discarded.');
    parsed = res.parsed || parseResponse(res.text);
    if (!changed) { beforeChange(); changed = true; }
    if (parsed.reasoning) act({ type: 'note', text: parsed.reasoning, private: true, kind: 'reasoning' });
    const rejected = [];
    let drew = false;
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
      if (a.type === 'draw') drew = true;
      if (sets && drew && myTurn()) break; // the rest of the turn is chosen after seeing the card
    }
    if (sets && myTurn() && attempt < maxAsks - 1) {
      const lm = legalMoves(project, st, p.id);
      const again = rejected.length || lm.discarding || (drew && lm.actionsLeft > 0);
      if (again) {
        feedback = rejected.length ? rejected.join(' ')
          : lm.discarding ? lm.summary
            : `You drew ${cardDef(project, st, st.zones[`${p.id}.hand`].cards.at(-1))?.name} (${st.zones[`${p.id}.hand`].cards.at(-1)}). You have ${lm.actionsLeft} action(s) left.`;
        onStatus(`${p.name} is thinking about the rest of their turn…`);
        continue;
      }
      break;
    }
    if (automated && myTurn() && attempt < maxAsks - 1) {
      const drew = shedding && st.hand.drew && !rejected.length;
      feedback = rejected.length ? rejected.join(' ')
        : drew ? `You drew ${cardDef(project, st, st.hand.drawn)?.name} (${st.hand.drawn}). Play it now, or pass with {"type":"endTurn"}.`
          : 'You did not make a legal move.';
      onStatus(drew ? `${p.name} drew a card - asking whether to play it…` : `${p.name}'s move was not legal - asking again…`);
      continue;
    }
    break;
  }
  act({ type: 'assess', winConfidence: numOrNull(parsed.winConfidence), experience: parsed.experience || '' });
  if (parsed.designerNotes) act({ type: 'note', text: `Designer feedback: ${parsed.designerNotes}`, kind: 'feedback' });
  finishTurn(project, st, p, myTurn, endRequested);
  return { player: p, parsed };
}

// Make sure the AI's turn ends with a legal move (used after an AI answer, or
// on its own when the AI could not be reached).
export function finishTurn(project, st, p, myTurn = () => st.status === 'playing' && activePlayer(st).id === p.id, endRequested = false) {
  const act = (a) => apply(project, st, { ...a, actor: a.actor || p.id });
  if (isSets(project)) {
    for (let k = 0; k < 12 && myTurn(); k++) {
      const lm = legalMoves(project, st, p.id);
      if (lm.discarding) {
        const a = setsBotTurn(project, st, p.id)[0];
        act({ type: 'note', actor: 'system', text: `${p.name} must discard; the harness discards for them.` });
        act(a || { type: 'move', card: st.zones[`${p.id}.hand`].cards[0], to: lm.options[0]?.action.to });
      } else {
        act({ type: 'endTurn' });
      }
    }
  } else if (isShedding(project)) {
    if (myTurn() && legalMoves(project, st, p.id).canDraw) {
      act({ type: 'note', actor: 'system', text: `${p.name} did not make a legal move; the harness draws a card for them.` });
      act({ type: 'draw' });
    }
    if (myTurn() && legalMoves(project, st, p.id).canPass) {
      act({ type: 'note', actor: 'system', text: `${p.name} passes (harness).` });
      act({ type: 'endTurn' });
    }
  } else if (isTricks(project)) {
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
}

// When someone forgets an announcement, AI opponents may catch them: one roll
// per missed announcement against the rule's AI catch chance. Returns the
// catching AI seat's id, or null.
export function rollAiCatch(project, st) {
  const C = st?.catchable;
  if (!C || C.aiRolled || st.status !== 'playing') return null;
  C.aiRolled = true;
  const ais = st.players.filter((p) => p.id !== C.pid && isAI(p.controller));
  const rule = announcementRules(project).find((r) => r.id === C.id);
  if (!ais.length || Math.random() * 100 >= Number(rule?.aiCatch ?? 70)) return null;
  return ais[Math.floor(Math.random() * ais.length)].id;
}
