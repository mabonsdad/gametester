// AI seats: prompt building, response parsing, and providers.
//
// The prompt shows the AI only what its seat could see at a real table
// (its own hand, public zones, card counts) plus the full rulebook and card
// list. The AI answers with a JSON list of primitive engine actions.

import * as api from './api.js';
import { activePlayer, cardDef, isVisibleTo, player, resolveZone } from './engine.js';
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
  return `You are an AI play-tester controlling one seat in a prototype card game running in a test harness.
Play to win according to the rules, the way a thoughtful human player would. The rules may be incomplete or ambiguous: choose a sensible interpretation, keep playing, and mention the problem in "designerNotes".
The harness does NOT enforce rules. You must apply them yourself, including scoring by changing counters and ending the game when the rules say so.

# Game: ${project.name}
${project.description || ''}
${sec('Overview', r.overview)}${sec('Objective', r.objective)}${sec('Turn structure', [phases, auto].filter(Boolean).join('\n'))}${sec('Turn rules', r.turnRules)}${sec('End of game', r.endGame)}${sec('Scoring', r.scoring)}${sec('Strategy hints', r.aiHints)}
## Zones
${zones}
${counters ? `\n## Counters (per player)\n${counters}\n` : ''}
## Card list (every card type in the game)
${project.cards.map(cardLine).join('\n') || '(no cards defined)'}

# How to respond
Reply with ONE JSON object and nothing else:
{
  "reasoning": "1-3 sentences: what you are doing this turn and why",
  "actions": [ ...action objects, ending with {"type":"endTurn"} unless you ended the game... ],
  "winConfidence": 0-100,   // honest estimate of your chance of winning from here
  "experience": "one sentence on how this turn felt from your seat (interesting choice? stuck? already lost?)",
  "designerNotes": "rule ambiguities or design problems you noticed, or empty string"
}
${ACTION_DOC}
You may only move cards you can see (your own private zones, face-up public cards) or the top card of a pile.`;
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
  return `You are ${pid} "${me.name}". It is turn ${st.turn.number}, your turn. Current phase: ${phases[st.turn.phase]?.name || '(none)'}.

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

export function buildPrompt(project, st, pid) {
  return { system: buildSystemPrompt(project), user: buildUserPrompt(project, st, pid) };
}

// --------------------------------------------------------------- parsing
export function parseResponse(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  let obj;
  try { obj = JSON.parse(s); } catch {
    const a = s.indexOf('{'); const b = s.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('No JSON object found in the AI response.');
    obj = JSON.parse(s.slice(a, b + 1));
  }
  if (Array.isArray(obj)) obj = { actions: obj };
  if (!Array.isArray(obj.actions)) throw new Error('AI response has no "actions" list.');
  return obj;
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
export async function requestTurn(project, st, ui) {
  const p = activePlayer(st);
  const prompt = buildPrompt(project, st, p.id);
  switch (p.controller) {
    case 'ai-random':
      return { parsed: randomBot(project, st, p.id), prompt };
    case 'ai-manual':
      return { text: await ui.manual(prompt, p), prompt };
    case 'ai-anthropic':
      ui.waiting?.(`Asking Claude for ${p.name}'s turn…`);
      return { text: (await api.aiComplete('anthropic', prompt)).text, prompt };
    case 'ai-openai':
      ui.waiting?.(`Asking OpenAI for ${p.name}'s turn…`);
      return { text: (await api.aiComplete('openai', prompt)).text, prompt };
    case 'ai-bridge': {
      const req = await api.bridgeCreate(prompt, { project: project.name, turn: st.turn.number, player: `${p.id} ${p.name}` });
      const signal = { cancelled: false };
      ui.waiting?.(`Waiting for Claude in the chat window to play ${p.name} (request ${req.id}). Ask Claude: "take the pending AI turn".`, () => {
        signal.cancelled = true;
        api.bridgeCancel(req.id).catch(() => {});
      });
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        if (signal.cancelled) throw new Error('Cancelled');
        const s = await api.bridgeGet(req.id);
        if (s.status === 'answered') return { text: s.response, prompt };
        if (s.status === 'cancelled') throw new Error('Request cancelled');
      }
    }
    default:
      throw new Error(`${p.name} is not an AI seat.`);
  }
}
