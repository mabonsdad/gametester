// AI seats: prompt building, response parsing, and providers.
//
// The prompt shows the AI only what its seat could see at a real table
// (its own hand, public zones, card counts) plus the full rulebook and card
// list. The AI answers with a JSON list of primitive engine actions.

import * as api from './api.js';
import {
  activePlayer, announcementRules, announcementsDue, automation, cardDef, cardEffects, describeAutomation, isSets, isShedding, isTricks,
  isVisibleTo, legalMoves, player, resolveZone, setsBotTurn, setsBreakdown, setsCfg, shedTop, teamOf,
} from './engine.js';
import { zoneDef } from './model.js';

export const CONTROLLERS = {
  human: { label: 'Human', ai: false },
  'ai-random': { label: 'AI: random bot (smoke test)', ai: true },
  'ai-manual': { label: 'AI: copy/paste prompt (any chatbot)', ai: true },
  'ai-bridge': { label: 'AI: Claude in chat (bridge)', ai: true, server: true },
  'ai-anthropic': { label: 'AI: Claude API', ai: true, server: true },
  'ai-openai': { label: 'AI: OpenAI API', ai: true, server: true },
};

export const isAI = (controller) => !!CONTROLLERS[controller]?.ai;

const ACTION_DOC = `Action objects (use ids exactly as shown in the state):
  {"type":"move","card":"c12","to":"discard"}        move a card you can see, or the top card of a pile, to a zone. Optional: "faceUp": true|false, "position": "top"|"bottom"
  {"type":"draw","from":"deck","count":1}            draw from a pile into your hand (optional "to": another zone id)
  {"type":"flip","card":"c12"}                        turn a card over
  {"type":"shuffle","zone":"deck"}
  {"type":"counter","player":"p2","counter":"score","delta":3}   change a counter (or "value": N to set it)
  {"type":"phase"}                                    advance to the next phase of the turn
  {"type":"endGame","winner":["p2"],"reason":"..."}   ONLY when the rules say the game is over
  {"type":"endTurn"}                                  must be the last action of your turn`;

function cardLine(c) {
  const stats = Object.entries(c.stats || {}).map(([k, v]) => `${k}=${v}`).join(', ');
  return `- "${c.name}" ×${c.count ?? 1}${c.description ? ` (${c.description})` : ''}${stats ? ` [${stats}]` : ''}${c.rules ? ` - ${c.rules}` : ''}`;
}

export function buildSystemPrompt(project) {
  const r = project.rules || {};
  const t = project.turn || {};
  const sec = (title, body) => (body && String(body).trim() ? `\n## ${title}\n${String(body).trim()}\n` : '');
  const phases = (t.phases || []).map((p, i) => `${i + 1}. ${p.name}${p.description ? ': ' + p.description : ''}`).join('\n');
  const auto = t.drawAtStart?.count > 0 ? `At the start of each turn the harness automatically draws ${t.drawAtStart.count} card(s) from "${t.drawAtStart.from}" for the active player (already done when you are asked to act).` : '';
  const zones = project.zones.map((z) => `- ${z.id}: ${z.name} (${z.scope === 'player' ? 'one per player' : 'shared'}, ${z.layout}${z.visibility === 'owner' ? ', private to its owner' : ''})`).join('\n');
  const counters = project.counters.map((c) => `- ${c.id}: ${c.name} (starts at ${c.start})`).join('\n');
  const A = automation(project);
  const tricks = isTricks(project);
  const shedding = isShedding(project);
  const sets = isSets(project);
  const S = sets ? setsCfg(project) : null;
  const harness = sets
    ? 'The harness runs the mechanics listed under "Automated by the harness": it checks that each action is legal, works out the best arrangement of every zone into tricks, keeps the score, passes the turn after your actions and ends the game. You only choose your actions.'
    : shedding
    ? 'The harness runs the mechanics listed under "Automated by the harness": it checks that your move is legal, applies card effects, passes the turn, deals new rounds' + (A.autoScore ? ', keeps the score' : '') + ' and ends the game. You only choose what to play (or to draw).'
    : tricks
    ? 'The harness runs the mechanics listed under "Automated by the harness": it checks that your card is legal, passes the turn, decides who wins each trick, deals new hands' + (A.autoScore ? ', keeps the score' : '') + ' and ends the game. You only choose which card to play.'
    : A.autoScore && A.scoring.length
      ? 'The harness keeps the score using the rules under "Automated by the harness" - do not change those counters yourself. Apply all other rules yourself.'
      : 'The harness does NOT enforce rules. You must apply them yourself, including scoring by changing counters and ending the game when the rules say so.';
  const respond = sets
    ? `Reply with ONE JSON object and nothing else:
{
  "reasoning": "1-3 sentences: your plan for this turn",
  "actions": [ up to ${S.actions} of these, in order:
     {"type":"draw"}                                          draw from the ${S.drawZone}
     {"type":"swap","card":"<your hand card id>","with":"<face-up card id in ${S.marketZone}>"}
     {"type":"move","card":"<your hand card id>","to":"<one of your scoring zones, e.g. ${(S.zones || []).map((z) => z.zone).join(' or ')}>"}
     {"type":"move","card":"<your hand card id>","to":"<another player's zone, e.g. p2.${S.giveZone}>"}   only when it completes a trick there (listed in the state)
     {"type":"move","card":"<your hand card id>","to":"${S.discardZone}"}      only when you are told to discard
     {"type":"endTurn"}                                       to stop before using all your actions
  ],
  "winConfidence": 0-100,   // honest estimate that you will win the game from here
  "experience": "one sentence on how this turn felt from your seat (interesting choice? stuck? clever steal?)",
  "designerNotes": "rule ambiguities or design problems you noticed, or empty string"
}
The turn passes automatically after your last action. If you draw a card you will be asked again for the rest of your turn (you will then see the card), so put a draw last in your list.`
    : shedding
    ? `Reply with ONE JSON object and nothing else:
{
  "reasoning": "1-3 sentences: why this move",
  "actions": [ ONE of:
     {"type":"move","card":"<one of your LEGAL card ids>","to":"${A.shedding?.discardZone || 'discard'}","choose":"<colour - only for wild cards>"}
     {"type":"draw"}        // when you cannot or do not want to play (only if drawing is allowed)
     {"type":"endTurn"}     // pass - only allowed after you have drawn this turn
  ],
  "winConfidence": 0-100,   // honest estimate that you will win the game from here
  "experience": "one sentence on how this turn felt from your seat (interesting choice? forced? hopeless?)",
  "designerNotes": "rule ambiguities or design problems you noticed, or empty string"
}
Send exactly one action. If you draw, you will be asked again whether to play the drawn card.`
    : tricks
    ? `Reply with ONE JSON object and nothing else:
{
  "reasoning": "1-3 sentences: why this card",
  "actions": [ {"type":"move","card":"<one of your LEGAL card ids>","to":"${A.tricks.zone}"} ],
  "winConfidence": 0-100,   // honest estimate that you (your partnership, if any) will win the game from here
  "experience": "one sentence on how this turn felt from your seat (interesting choice? forced? already lost?)",
  "designerNotes": "rule ambiguities or design problems you noticed, or empty string"
}
Play exactly one card, chosen from the "Legal cards" list in the state. Do not send endTurn, draw or counter actions.`
    : `Reply with ONE JSON object and nothing else:
{
  "reasoning": "1-3 sentences: what you are doing this turn and why",
  "actions": [ ...action objects, ending with {"type":"endTurn"} unless you ended the game... ],
  "winConfidence": 0-100,   // honest estimate of your chance of winning from here
  "experience": "one sentence on how this turn felt from your seat (interesting choice? stuck? already lost?)",
  "designerNotes": "rule ambiguities or design problems you noticed, or empty string"
}
${ACTION_DOC}
You may only move cards you can see (your own private zones, face-up public cards) or the top card of a pile.`;
  const automated = describeAutomation(project).join('\n');
  const anns = announcementRules(project);
  const annDoc = anns.length
    ? `\nAnnouncements: to say one, add "announce" to your move action, e.g. {"type":"move","card":"c12","to":"${tricks ? A.tricks.zone : A.shedding?.discardZone || 'discard'}","announce":["${anns[0].id}"]}. Ids: ${anns.map((r) => `${r.id} = "${r.label}" (required when ${r.when}, checked ${r.check === 'beforePlay' ? 'before' : 'after'} your play)`).join('; ')}. Nobody will remind you - forgetting can be penalised.`
    : '';
  return `You are an AI play-tester controlling one seat in a prototype card game running in a test harness.
Play to win according to the rules, the way a thoughtful human player would. The rules may be incomplete or ambiguous: choose a sensible interpretation, keep playing, and mention the problem in "designerNotes".
${harness}

# Game: ${project.name}
${project.description || ''}
${sec('Automated by the harness', automated)}${sec('Overview', r.overview)}${sec('Objective', r.objective)}${sec('Turn structure', [phases, auto].filter(Boolean).join('\n'))}${sec('Turn rules', r.turnRules)}${sec('End of game', r.endGame)}${sec('Scoring', r.scoring)}${sec('Strategy hints', r.aiHints)}
## Zones
${zones}
${counters ? `\n## Counters (per player)\n${counters}\n` : ''}
## Card list (every card type in the game)
${project.cards.map(cardLine).join('\n') || '(no cards defined)'}

# How to respond
${respond}${annDoc}`;
}

function describeZone(project, st, zid, viewer) {
  const z = st.zones[zid];
  const def = zoneDef(project, z.defId) || {};
  const n = z.cards.length;
  const name = (uid) => {
    const d = cardDef(project, st, uid);
    return `${uid} "${d?.name}"`;
  };
  if (def.visibility === 'owner' && z.owner !== viewer) return `${zid} (${z.name}): ${n} card(s), hidden`;
  if (isTricks(project) && z.defId === automation(project).tricks.wonZone && z.owner) {
    const tricks = Math.round(n / st.players.length);
    return `${zid} (${z.name}): ${tricks} trick(s) won this hand (${n} cards, face down)`;
  }
  if (def.layout === 'stack') {
    const top = z.cards[n - 1];
    const topText = top ? (isVisibleTo(project, st, top, viewer) ? `top card ${name(top)}` : 'top card face down') : 'empty';
    return `${zid} (${z.name}): pile of ${n}, ${topText}`;
  }
  const cards = z.cards.map((u) => (isVisibleTo(project, st, u, viewer) ? name(u) : `${u} (face down)`));
  return `${zid} (${z.name}): ${n ? cards.join(', ') : 'empty'}`;
}

export function buildUserPrompt(project, st, pid) {
  const me = player(st, pid);
  const phases = project.turn.phases || [];
  const order = st.players.map((p) => `${p.id} ${p.name}${p.id === pid ? ' (YOU)' : ''}: ${Object.entries(p.counters).map(([k, v]) => `${k}=${v}`).join(', ') || 'no counters'}`).join('\n');
  const shared = st.zoneOrder.filter((z) => !st.zones[z].owner);
  const mine = st.zoneOrder.filter((z) => st.zones[z].owner === pid);
  const others = st.zoneOrder.filter((z) => st.zones[z].owner && st.zones[z].owner !== pid);
  const recent = st.log.slice(-25).map((e) => `[t${e.turn}] ${e.publicText}`).join('\n');
  const nm = (u) => `${u} "${cardDef(project, st, u)?.name}"`;
  let trickInfo = '';
  if (isShedding(project) && st.hand) {
    const H = st.hand;
    const lm = legalMoves(project, st, pid);
    const top = shedTop(project, st);
    const n = st.players.length;
    const step = (project.turn.direction === 'counterclockwise' ? -1 : 1) * (st.dir || 1);
    const next = st.players[(((me.seat + step) % n) + n) % n];
    const wilds = lm.legal.filter((u) => cardEffects(project, st, u).wild);
    trickInfo = `
Round ${H.number}. Top of the discard pile: ${top ? nm(top) : 'none'}. Colour to match: ${H.colour}; value to match: ${H.value}.
Direction of play: ${st.dir === 1 ? 'normal' : 'reversed'}; the next player is ${next.name}.
Cards in each hand: ${st.players.map((p) => `${p.name} ${st.zones[`${p.id}.hand`]?.cards.length ?? 0}${p.id === pid ? ' (you)' : ''}`).join(', ')}.
${H.drew ? `You have drawn ${nm(H.drawn)} this turn.\n` : ''}
${lm.summary}
Legal cards: ${lm.legal.length ? lm.legal.map(nm).join(', ') : 'none'}
Other options: ${[lm.canDraw ? (lm.takeCount ? `take the ${lm.takeCount} waiting card(s) and miss your turn ({"type":"draw"})` : 'draw a card ({"type":"draw"})') : '', lm.canPass ? 'pass ({"type":"endTurn"})' : ''].filter(Boolean).join('; ') || 'none'}
${wilds.length ? `For a wild card, add "choose" with one of: ${lm.colours.join(', ')}.\n` : ''}`;
  } else if (isSets(project) && st.hand) {
    const S = setsCfg(project);
    const lm = legalMoves(project, st, pid);
    const nmList = (uids) => uids.length ? uids.map(nm).join(', ') : 'none';
    const zoneText = (pidZ, z, mineView) => {
      const tricks = z.tricks.map((t) => `${t.label} [${t.cards.map((u) => u).join(' ')}] = ${t.points}`).join('; ') || 'no tricks';
      return `${z.name} (×${z.multiplier}${z.secret ? ', face down' : ''}): ${tricks}; loose: ${nmList(z.loose)}${!z.secret && z.loose.length ? (mineView ? ' (at risk - others can complete tricks with these)' : ' (you may be able to complete a trick with these)') : ''} → ${z.points} points`;
    };
    const mine = setsBreakdown(project, st, pid);
    const others = st.players.filter((o) => o.id !== pid).map((o) => {
      const b = setsBreakdown(project, st, o.id);
      return `${o.id} ${o.name}: ${b.zones.map((z) => (z.secret ? `${z.name}: ${st.zones[z.zid]?.cards.length ?? 0} card(s) face down` : zoneText(o.id, z, false))).join(' | ')}`;
    }).join('\n');
    const hits = (lm.options || []).filter((o) => o.gain > 0).map((o) => `- ${JSON.stringify(o.action)}: ${o.label.replace(/^Play/, `play ${nm(o.card)}`)}`);
    const deck = st.zones[S.drawZone];
    trickInfo = `
Actions left this turn: ${lm.actionsLeft ?? 0} of ${S.actions}. ${deck?.name || 'Draw pile'}: ${deck?.cards.length ?? 0} card(s) left.${st.hand.lastSeat != null ? ` The draw pile is empty: the game ends after ${st.players[st.hand.lastSeat].name}'s turn.` : ''}
${lm.summary}
Your hand (${(st.zones[`${pid}.hand`]?.cards || []).length}, limit ${S.handLimit || 'none'}): ${nmList(st.zones[`${pid}.hand`]?.cards || [])}
Face-up cards you can swap with (${st.zones[S.marketZone]?.name || S.marketZone}): ${nmList(st.zones[S.marketZone]?.cards || [])}
Your tricks (the best arrangement, worked out by the harness):
${mine.zones.map((z) => '- ' + zoneText(pid, z, true)).join('\n')}
Your points: ${mine.public} showing${mine.hidden ? ` + ${mine.hidden} hidden in face-down zones` : ''} = ${mine.total}.
Other players' tricks:
${others}
${hits.length ? `Moves that score straight away:\n${hits.join('\n')}\n` : 'No single move scores straight away.\n'}`;
  } else if (isTricks(project) && st.hand) {
    const H = st.hand;
    const lm = legalMoves(project, st, pid);
    const team = teamOf(st, pid);
    const tally = st.players.map((p) => `${p.name} ${H.tricksWon[p.id] || 0}`).join(', ');
    trickInfo = `
Hand ${H.number}. Dealer: ${st.players[st.dealer].name}. Trumps: ${H.trump || 'none'}${H.trumpCard ? ` (turned-up card ${nm(H.trumpCard)}, held by the dealer)` : ''}.
${team ? `Your partnership: ${team.name}.\n` : ''}Tricks won this hand: ${tally}${st.teams.length ? ` | ${st.teams.map((t) => `${t.name}: ${t.players.reduce((a, id) => a + (H.tricksWon[id] || 0), 0)}`).join(', ')}` : ''}.
Cards left in hand: ${st.players.map((p) => `${p.name} ${st.zones[`${p.id}.hand`]?.cards.length ?? 0}${H.trick.some((t) => t.pid === p.id) ? ' (has played to this trick)' : ''}`).join(', ')}.
Current trick${H.led ? ` (${H.led} led)` : ''}: ${H.trick.length ? H.trick.map((t) => `${player(st, t.pid).name} played ${nm(t.card)}`).join('; ') : 'empty - you are leading'}.
${st.lastTrick ? `Last trick: won by ${player(st, st.lastTrick.winner).name} (${st.lastTrick.plays.map((t) => `${player(st, t.pid).name} ${nm(t.card)}`).join(', ')}).\n` : ''}
${lm.summary}
Legal cards (choose one): ${lm.legal.map(nm).join(', ')}
`;
  }
  return `You are ${pid} "${me.name}". It is turn ${st.turn.number}, your turn. Current phase: ${phases[st.turn.phase]?.name || '(none)'}.
${trickInfo}
Players in turn order:
${order}

Shared zones:
${shared.map((z) => '- ' + describeZone(project, st, z, pid)).join('\n') || '- none'}

Your zones:
${mine.map((z) => '- ' + describeZone(project, st, z, pid)).join('\n')}

Other players' zones:
${others.map((z) => '- ' + describeZone(project, st, z, pid)).join('\n') || '- none'}

Recent events:
${recent}

Decide your whole turn now and reply with the JSON object.`;
}

export function buildPrompt(project, st, pid, feedback = '') {
  const user = buildUserPrompt(project, st, pid) + (feedback ? `\n\nIMPORTANT - your previous answer was rejected: ${feedback}\nChoose again, following the rules.` : '');
  // format 'turn': hosted models are asked to reply in the turn JSON format only.
  return { system: buildSystemPrompt(project), user, format: 'turn' };
}

// --------------------------------------------------------------- parsing
// Models sometimes wrap the JSON in prose, code fences or stray markup, or
// send more than one object ("that was malformed, here it is again"). Use the
// last complete object that has an "actions" list.
export function parseResponse(text) {
  const s = String(text || '').trim();
  const asTurn = (obj) => {
    if (Array.isArray(obj)) return { actions: obj };
    if (obj && Array.isArray(obj.actions)) return obj;
    if (obj && typeof obj.type === 'string') return { actions: [obj] }; // a single bare action
    return null;
  };
  try {
    const whole = asTurn(JSON.parse(s));
    if (whole) return whole;
  } catch { /* look inside the text */ }
  const found = [];
  for (const chunk of jsonChunks(s)) {
    try {
      const t = asTurn(JSON.parse(chunk));
      if (t) found.push(t);
    } catch { /* not JSON after all */ }
  }
  const best = found.filter((t) => t.reasoning !== undefined || t.winConfidence !== undefined).pop() || found.pop();
  if (!best) throw new Error(/[{[]/.test(s) ? 'The AI reply contained no complete turn (JSON with an "actions" list).' : 'No JSON object found in the AI response.');
  return best;
}

// Top-level {...} and [...] spans in a text, skipping brackets inside strings.
function jsonChunks(s) {
  const out = [];
  let depth = 0; let start = -1; let inStr = false; let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"' && depth > 0) inStr = true;
    else if (ch === '{' || ch === '[') { if (depth === 0) start = i; depth++; }
    else if ((ch === '}' || ch === ']') && depth > 0) {
      depth--;
      if (depth === 0) out.push(s.slice(start, i + 1));
    }
  }
  return out;
}

// Reject moves of cards the seat could not legitimately touch.
export function checkAction(project, st, pid, a) {
  if (a.type === 'move' || a.type === 'flip') {
    const c = st.cards[a.card];
    if (!c) return `unknown card ${a.card}`;
    const z = st.zones[c.zone];
    const isTop = z.cards[z.cards.length - 1] === a.card;
    if (!(z.owner === pid || isVisibleTo(project, st, a.card, pid) || isTop)) return `${a.card} is not visible to ${pid}`;
  }
  if (a.type === 'move' && !resolveZone(st, a.to, pid)) return `unknown zone ${a.to}`;
  return null;
}

// --------------------------------------------------------------- random bot
// Not a real player: it just exercises the plumbing. Plays a random hand card
// to a random shared spread zone (or discard), otherwise draws.
export function randomBot(project, st, pid) {
  const lm = legalMoves(project, st, pid);
  // Random bots say required announcements only 60% of the time, so penalties get exercised.
  const say = (card) => announcementsDue(project, st, pid, card).filter(() => Math.random() < 0.6);
  if (lm && isSets(project)) {
    return { reasoning: 'Quick bot: simple set-collection strategy.', actions: setsBotTurn(project, st, pid), winConfidence: null, experience: '', designerNotes: '' };
  }
  if (lm && isShedding(project)) {
    const card = lm.legal[Math.floor(Math.random() * lm.legal.length)];
    const actions = card
      ? [{ type: 'move', card, to: lm.target, choose: lm.colours[Math.floor(Math.random() * lm.colours.length)], announce: say(card) }]
      : lm.canDraw ? [{ type: 'draw' }] : [{ type: 'endTurn' }];
    return { reasoning: 'Random legal move (smoke test).', actions, winConfidence: null, experience: '', designerNotes: '' };
  }
  if (lm) {
    const card = lm.legal[Math.floor(Math.random() * lm.legal.length)];
    return { reasoning: 'Random legal card (smoke test).', actions: card ? [{ type: 'move', card, to: lm.target, announce: say(card) }] : [], winConfidence: null, experience: '', designerNotes: '' };
  }
  const hand = st.zones[`${pid}.hand`]?.cards || [];
  const targets = st.zoneOrder.filter((z) => !st.zones[z].owner && zoneDef(project, st.zones[z].defId)?.layout === 'spread');
  const discard = st.zoneOrder.find((z) => !st.zones[z].owner && zoneDef(project, st.zones[z].defId)?.faceUp && zoneDef(project, st.zones[z].defId)?.layout === 'stack');
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const actions = [];
  const to = targets.length ? pick(targets) : discard;
  if (hand.length && to) actions.push({ type: 'move', card: pick(hand), to });
  else {
    const pile = st.zoneOrder.find((z) => !st.zones[z].owner && st.zones[z].cards.length && zoneDef(project, st.zones[z].defId)?.layout === 'stack');
    if (pile) actions.push({ type: 'draw', from: pile, count: 1 });
  }
  actions.push({ type: 'endTurn' });
  return { reasoning: 'Random legal-looking move (smoke test).', actions, winConfidence: null, experience: '', designerNotes: '' };
}

// --------------------------------------------------------------- providers
// Returns raw text (or an object for the random bot). `ui` supplies hooks for
// the interactive providers: ui.manual(prompt) -> Promise<text>,
// ui.waiting(message, cancelFn), and a `signal` {cancelled}.
export async function requestTurn(project, st, ui, feedback = '') {
  const p = activePlayer(st);
  const prompt = buildPrompt(project, st, p.id, feedback);
  switch (p.controller) {
    case 'ai-random':
      return { parsed: randomBot(project, st, p.id), prompt };
    case 'ai-manual':
      return { text: await ui.manual(prompt, p), prompt };
    case 'ai-anthropic':
    case 'ai-openai':
    case 'ai-bridge': {
      const provider = { 'ai-anthropic': 'anthropic', 'ai-openai': 'openai', 'ai-bridge': 'bridge' }[p.controller];
      const job = await api.jobCreate(provider, prompt, { project: project.name, turn: st.turn.number, player: `${p.id} ${p.name}` });
      const signal = { cancelled: false };
      const message = provider === 'bridge'
        ? `Waiting for Claude in the chat window to play ${p.name} (request ${job.id}). Ask Claude: "take the pending AI turn".`
        : `Asking ${provider === 'anthropic' ? 'Claude' : 'OpenAI'} to play ${p.name}'s turn…`;
      ui.waiting?.(message, () => {
        signal.cancelled = true;
        api.jobCancel(job.id).catch(() => {});
      });
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        if (signal.cancelled) throw new Error('Cancelled');
        const s = await api.jobGet(job.id);
        if (s.status === 'answered') return { text: s.response, prompt };
        if (s.status === 'error') throw new Error(s.error || 'The AI request failed.');
        if (s.status === 'cancelled') throw new Error('Request cancelled');
      }
    }
    default:
      throw new Error(`${p.name} is not an AI seat.`);
  }
}
