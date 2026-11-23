// Set collection ("tricks" laid in front of a player): pattern parsing and
// best-combination scoring. Pure functions, used by the engine and the editor.
//
// A combo (trick type) is written as card slots joined by "+":
//   "5 villager"                  five Villagers
//   "werewolf + villager"         a Werewolf and exactly one Villager
//   "seer + 3 any distinct"       a Seer and three cards of different types
//   "defender + villager/seer"    a Defender and one Villager or Seer
//   "cupid + 2 any"               a Cupid and any two cards
// A slot names a card (by name or id, plural allowed), several alternatives
// separated by "/", "tag:<tag>", or "any". "distinct" (or "different") means
// the cards in that slot must all be different card types.
// A combo scores the sum of its cards' value stat, or a formula using
// `sum` and `count` (e.g. "sum * 2").
//
// The cards in a zone are scored as the best way of splitting them into
// combos: each card belongs to at most one combo, cards in no combo score
// nothing.

import { run as runExpr } from './expr.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function matchCards(token, cards) {
  const byTag = (t) => cards.filter((c) => (c.tags || []).some((x) => norm(x) === t)).map((c) => c.id);
  if (/^tag:/i.test(token)) return byTag(norm(token.slice(4)));
  const n = norm(token);
  const tries = [n, n.replace(/ves$/, 'f'), n.replace(/es$/, ''), n.replace(/s$/, '')];
  for (const t of tries) {
    const found = cards.filter((c) => norm(c.id) === t || norm(c.name) === t);
    if (found.length) return found.map((c) => c.id);
  }
  for (const t of tries) {
    const found = byTag(t);
    if (found.length) return found;
  }
  return [];
}

// "3 any distinct" -> { count: 3, ids: null, distinct: true }
export function parsePattern(pattern, cards) {
  const parts = String(pattern || '').split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { slots: [], error: 'The pattern is empty.' };
  const slots = [];
  for (const part of parts) {
    let rest = part;
    let count = 1;
    const m = rest.match(/^(\d+)\s*(?:x\s+|×\s*)?(.*)$/i);
    if (m) { count = Number(m[1]); rest = m[2].trim(); }
    let distinct = false;
    rest = rest.replace(/\b(distinct|different)\b/gi, () => { distinct = true; return ''; }).replace(/\s+/g, ' ').trim();
    if (!rest || /^(any|cards?|other|others)$/i.test(rest)) rest = 'any';
    if (count < 1 || count > 20) return { slots: [], error: `"${part}": the number of cards must be 1-20.` };
    let ids = null;
    if (rest !== 'any') {
      ids = new Set();
      for (const alt of rest.split('/').map((s) => s.trim()).filter(Boolean)) {
        const found = matchCards(alt, cards);
        if (!found.length) return { slots: [], error: `No card is called "${alt}" (use a card name, "tag:..." or "any").` };
        found.forEach((id) => ids.add(id));
      }
    }
    slots.push({ count, ids, distinct, text: part });
  }
  return { slots, error: '' };
}

// Compiled combos for a project, cached by their definition.
const compiled = new Map();
export function compileSets(project, cfg) {
  const valueStat = cfg.valueStat || 'value';
  const sig = JSON.stringify([valueStat, cfg.combos, project.cards.map((c) => [c.id, c.name, c.tags, c.stats?.[valueStat]])]);
  if (compiled.has(sig)) return compiled.get(sig);
  const values = Object.fromEntries(project.cards.map((c) => [c.id, Number(c.stats?.[valueStat]) || 0]));
  const combos = [];
  const errors = [];
  for (const [i, cb] of (cfg.combos || []).entries()) {
    const { slots, error } = parsePattern(cb.pattern, project.cards);
    if (error) { errors.push(`${cb.label || `Trick ${i + 1}`}: ${error}`); continue; }
    combos.push({ id: cb.id || `combo${i + 1}`, label: cb.label || cb.pattern, points: String(cb.points || '').trim(), slots });
  }
  const C = { combos, errors, values, cache: new Map(), ptsCache: new Map() };
  C.pointsOf = (cb, defIds) => {
    const key = cb.id + '|' + defIds.slice().sort().join(',');
    if (C.ptsCache.has(key)) return C.ptsCache.get(key);
    const sum = defIds.reduce((s, d) => s + (values[d] || 0), 0);
    let pts = sum;
    if (cb.points && cb.points !== 'sum') {
      try { pts = Number(runExpr(cb.points, { sum, count: defIds.length })) || 0; } catch { pts = 0; }
    }
    C.ptsCache.set(key, pts);
    return pts;
  };
  if (compiled.size > 50) compiled.clear();
  compiled.set(sig, C);
  return C;
}

// Every way to fill the combo's slots from the counts `c` (indices into
// types) that uses at least one card of type `must`. While `cb` runs, `c`
// has the chosen cards taken out.
function forEachFill(slots, c, must, cb) {
  const chosen = [];
  const rec = (si) => {
    if (si === slots.length) {
      if (must < 0 || chosen.includes(must)) cb(chosen);
      return;
    }
    const s = slots[si];
    const pick = (k, from) => {
      if (k === s.count) { rec(si + 1); return; }
      for (let p = from; p < s.allowed.length; p++) {
        const i = s.allowed[p];
        if (c[i] <= 0) continue;
        c[i]--; chosen.push(i);
        pick(k + 1, s.distinct ? p + 1 : p);
        chosen.pop(); c[i]++;
      }
    };
    pick(0, 0);
  };
  rec(0);
}

function prepare(C, defIds) {
  const types = [...new Set(defIds)].sort();
  const idx = new Map(types.map((t, i) => [t, i]));
  const counts = types.map(() => 0);
  for (const d of defIds) counts[idx.get(d)]++;
  const combos = C.combos.map((cb) => ({
    cb,
    slots: cb.slots.map((s) => ({ count: s.count, distinct: s.distinct, allowed: types.map((_, i) => i).filter((i) => !s.ids || s.ids.has(types[i])) })),
  })).filter((x) => x.slots.every((s) => s.allowed.length >= (s.distinct ? s.count : 1)));
  return { types, idx, counts, combos };
}

// The best split of a multiset of card types into combos.
// -> { total, tricks: [{ id, label, defIds, points }], loose: [defIds] }
export function bestTricks(C, defIds) {
  const key = defIds.slice().sort().join(',');
  if (C.cache.has(key)) return C.cache.get(key);
  const { types, counts, combos } = prepare(C, defIds);
  const memo = new Map();
  const best = (c) => {
    const k = c.join(',');
    if (memo.has(k)) return memo.get(k);
    const t0 = c.findIndex((x) => x > 0);
    let res = { v: 0, pick: null, skip: -1 };
    if (t0 >= 0) {
      c[t0]--;
      res = { v: best(c).v, pick: null, skip: t0 };
      c[t0]++;
      for (const x of combos) {
        forEachFill(x.slots, c, t0, (chosen) => {
          const pts = C.pointsOf(x.cb, chosen.map((i) => types[i]));
          if (pts <= 0) return;
          const v = pts + best(c).v;
          if (v > res.v) res = { v, pick: { cb: x.cb, chosen: chosen.slice(), pts }, skip: -1 };
        });
      }
    }
    memo.set(k, res);
    return res;
  };
  const c = counts.slice();
  const total = best(c).v;
  const tricks = [];
  const loose = [];
  for (let guard = 0; guard < 500; guard++) {
    const r = memo.get(c.join(','));
    if (!r || (r.skip < 0 && !r.pick)) break;
    if (r.pick) {
      for (const i of r.pick.chosen) c[i]--;
      tricks.push({ id: r.pick.cb.id, label: r.pick.cb.label, defIds: r.pick.chosen.map((i) => types[i]), points: r.pick.pts });
    } else {
      c[r.skip]--;
      loose.push(types[r.skip]);
    }
  }
  const out = { total, tricks, loose };
  if (C.cache.size > 5000) C.cache.clear();
  C.cache.set(key, out);
  return out;
}

// The most valuable single combo that uses `extra` together with some of
// `pool` (e.g. a card given to another player plus their loose cards).
// -> { id, label, defIds, points } or null
export function bestTrickWith(C, pool, extra) {
  const all = [...pool, extra];
  const { types, idx, counts, combos } = prepare(C, all);
  const must = idx.get(extra);
  let best = null;
  for (const x of combos) {
    forEachFill(x.slots, counts, must, (chosen) => {
      const defIds = chosen.map((i) => types[i]);
      const pts = C.pointsOf(x.cb, defIds);
      if (pts > 0 && (!best || pts > best.points)) best = { id: x.cb.id, label: x.cb.label, defIds, points: pts };
    });
  }
  return best;
}

// Give each trick real cards: `uids` are the zone's cards, defOf(uid) -> type.
export function assignCards(result, uids, defOf) {
  const left = uids.slice();
  const take = (d) => {
    const i = left.findIndex((u) => defOf(u) === d);
    return i < 0 ? null : left.splice(i, 1)[0];
  };
  const tricks = result.tricks.map((t) => ({ ...t, cards: t.defIds.map(take).filter(Boolean) }));
  return { total: result.total, tricks, loose: left };
}
