// Rules & setup editor: players, zones, counters, setup steps, turn
// structure, and the free-text rulebook that the AI players read.
import { buildSystemPrompt } from '../ai.js';
import { FORMULA_HELP, describeAutomation } from '../engine.js';
import { check } from '../expr.js';
import { parsePattern } from '../sets.js';
import {
  END_AT, ENFORCE, LAYOUTS, MISSED, SCORE_EVENTS, SCORE_WHO, SETS_END, SETUP_OPS, STACKING, STYLES, blankAnnouncement, blankVariant, formatSetLines,
  getPath, parseSetLines, slug,
} from '../model.js';
import { field, h, modal } from '../ui.js';
import { THEMES } from '../themes.js';

export async function renderRules(root, ctx) {
  const project = ctx.project;
  const page = h('div', { class: 'page rules-page' });
  root.append(page);

  const num = (obj, key, attrs = {}) => h('input', {
    type: 'number', value: obj[key] ?? 0, ...attrs,
    oninput: (e) => { obj[key] = parseInt(e.target.value, 10) || 0; ctx.changed(); },
  });
  const text = (obj, key, attrs = {}) => h('input', {
    type: 'text', value: obj[key] ?? '', ...attrs,
    oninput: (e) => { obj[key] = e.target.value; ctx.changed(); attrs.after?.(); },
  });
  const area = (obj, key, rows, placeholder) => h('textarea', {
    rows, placeholder, value: obj[key] || '',
    oninput: (e) => { obj[key] = e.target.value; ctx.changed(); },
  });
  const select = (obj, key, options, after) => h('select', {
    value: obj[key],
    onchange: (e) => { obj[key] = e.target.value; ctx.changed(); after?.(); },
  }, Object.entries(options).map(([v, l]) => h('option', { value: v }, l)));
  const rowButtons = (arr, i, redraw) => h('div', { class: 'row-btns' },
    h('button', { class: 'icon-btn', title: 'Move up', disabled: i === 0, onclick: () => { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; ctx.changed(); redraw(); } }, '↑'),
    h('button', { class: 'icon-btn', title: 'Move down', disabled: i === arr.length - 1, onclick: () => { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; ctx.changed(); redraw(); } }, '↓'),
    h('button', { class: 'icon-btn danger', title: 'Remove', onclick: () => { arr.splice(i, 1); ctx.changed(); redraw(); } }, '✕'));

  const zoneOptions = (filterFn = () => true) =>
    Object.fromEntries(project.zones.filter(filterFn).map((z) => [z.id, `${z.name}${z.scope === 'player' ? ' (each player)' : ''}`]));

  function section(title, intro, body) {
    return h('section', { class: 'panel' }, h('h2', {}, title), intro ? h('p', { class: 'muted' }, intro) : null, body);
  }

  function draw() {
    page.replaceChildren(
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, 'Rules & setup'),
          h('p', { class: 'muted' }, 'The structure here drives the table (zones, dealing, turn order). The rulebook text is what human testers and AI players follow - the harness does not enforce it.')),
        h('button', { class: 'btn', onclick: showPrompt }, 'Preview AI rulebook prompt')),

      section('Game', null, h('div', { class: 'stack' },
        field('Name', text(project, 'name', { after: () => { document.querySelector('.proj-name').textContent = project.name; } })),
        field('Description', area(project, 'description', 2)),
        h('div', { class: 'grid-3' },
          field('Min players', num(project.players, 'min', { min: 1, max: 6 })),
          field('Max players', num(project.players, 'max', { min: 1, max: 6 })),
          field('Default players', num(project.players, 'default', { min: 1, max: 6 }))),
        field('Player view look', h('select', {
          value: project.theme || '',
          onchange: (e) => { project.theme = e.target.value; ctx.changed(); },
        }, Object.entries(THEMES).map(([id, t]) => h('option', { value: id, selected: (project.theme || '') === id }, t.label))),
        'How the game looks in the player view and share links: colours, card frames, opponents and wording.'))),

      section('Zones', 'Places cards can be. Shared zones sit in the middle of the table; per-player zones appear at each seat. Every player has a Hand.', zonesTable()),

      section('Counters', 'Numbers tracked for each player - score, health, coins…', countersTable()),

      section('Setup', 'Run in order when a new game starts. Cards first go to their "Starts in" zone (set per card).', setupList()),

      section('Turn structure', null, turnEditor()),

      section('Player options', 'Choices offered to players before a game in the player view (and share links) - e.g. game length or a house rule. Each choice changes project settings, written as "path = value" lines.', variantsEditor()),

      section('Automation: legal moves & scoring', 'Optional. Let the test bench check which moves are allowed, keep the score and end the game, so testers and AI players can concentrate on playing.', automationEditor()),

      section('Rulebook', 'Write it as you would for a new player. AI seats receive all of this plus the card list.', h('div', { class: 'stack' },
        field('Overview / theme', area(project.rules, 'overview', 3, 'What is the game about?')),
        field('Objective', area(project.rules, 'objective', 2, 'How do you win?')),
        field('What you can do on your turn', area(project.rules, 'turnRules', 7, 'The core rules of play, step by step.')),
        field('When the game ends', area(project.rules, 'endGame', 2, 'e.g. When the draw pile runs out…')),
        field('Scoring', area(project.rules, 'scoring', 3, 'How points are counted, tie-breaks…')),
        field('Strategy hints for AI players (optional)', area(project.rules, 'aiHints', 3, 'Nudges to make AI play more like your target players.')))),
    );
  }

  function zonesTable() {
    const wrap = h('div', {});
    const redraw = () => wrap.replaceChildren(build());
    const build = () => h('div', {},
      h('table', { class: 'edit-table' },
        h('thead', {}, h('tr', {}, ['Name', 'Id', 'Where', 'Layout', 'Cards arrive', 'Who can see', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, project.zones.map((z, i) => h('tr', {},
          h('td', {}, text(z, 'name')),
          h('td', {}, z.builtin ? h('code', {}, z.id) : h('input', {
            type: 'text', value: z.id, class: 'mono', size: 10,
            onchange: (e) => {
              const id = slug(e.target.value);
              if (!id || project.zones.some((o) => o !== z && o.id === id)) { e.target.value = z.id; return; }
              const old = z.id;
              z.id = id;
              for (const c of project.cards) if (c.startZone === old) c.startZone = id;
              for (const s of project.setup) for (const k of ['zone', 'from', 'to']) if (s[k] === old) s[k] = id;
              if (project.turn.drawAtStart.from === old) project.turn.drawAtStart.from = id;
              ctx.changed(); redraw();
            },
          })),
          h('td', {}, z.builtin ? 'Each player' : select(z, 'scope', { shared: 'Shared (table)', player: 'Each player' })),
          h('td', {}, z.builtin ? 'Hand' : select(z, 'layout', { stack: LAYOUTS.stack, spread: LAYOUTS.spread })),
          h('td', {}, h('select', { value: String(!!z.faceUp), onchange: (e) => { z.faceUp = e.target.value === 'true'; ctx.changed(); } },
            h('option', { value: 'true' }, 'Face up'), h('option', { value: 'false' }, 'Face down'))),
          h('td', {}, select(z, 'visibility', { public: 'Everyone (if face up)', owner: 'Owner only' })),
          h('td', {}, z.builtin ? '' : rowButtons(project.zones, i, () => { redraw(); }))),
        ))),
      h('button', {
        class: 'btn small', onclick: () => {
          let id = 'zone'; let n = 1;
          while (project.zones.some((z) => z.id === id)) id = `zone${++n}`;
          project.zones.push({ id, name: 'New zone', scope: 'shared', layout: 'spread', faceUp: true, visibility: 'public' });
          ctx.changed(); redraw();
        },
      }, '+ Add zone'));
    redraw();
    return wrap;
  }

  function countersTable() {
    const wrap = h('div', {});
    const redraw = () => wrap.replaceChildren(
      h('table', { class: 'edit-table' },
        h('thead', {}, h('tr', {}, ['Name', 'Id', 'Starts at', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, project.counters.map((c, i) => h('tr', {},
          h('td', {}, text(c, 'name')),
          h('td', {}, h('input', { type: 'text', class: 'mono', size: 10, value: c.id, onchange: (e) => { c.id = slug(e.target.value); e.target.value = c.id; ctx.changed(); } })),
          h('td', {}, num(c, 'start')),
          h('td', {}, rowButtons(project.counters, i, () => redraw())))))),
      h('button', { class: 'btn small', onclick: () => { project.counters.push({ id: `counter${project.counters.length + 1}`, name: 'Counter', start: 0 }); ctx.changed(); redraw(); } }, '+ Add counter'));
    redraw();
    return wrap;
  }

  function setupList() {
    const wrap = h('div', {});
    const redraw = () => wrap.replaceChildren(
      h('ol', { class: 'setup-list' }, project.setup.map((s, i) => h('li', {},
        select(s, 'op', SETUP_OPS, redraw),
        ...stepFields(s),
        rowButtons(project.setup, i, redraw)))),
      h('button', { class: 'btn small', onclick: () => { project.setup.push({ op: 'move', from: 'deck', to: 'table', count: 1, faceUp: true }); ctx.changed(); redraw(); } }, '+ Add step'));
    const stepFields = (s) => {
      if (s.op === 'shuffle') return [h('span', {}, 'zone'), select(s, 'zone', zoneOptions())];
      if (s.op === 'counter') return [select(s, 'counter', Object.fromEntries(project.counters.map((c) => [c.id, c.name]))), h('span', {}, 'to'), num(s, 'value')];
      return [
        num(s, 'count', { min: 0, class: 'narrow' }),
        h('span', {}, 'card(s) from'), select(s, 'from', zoneOptions((z) => z.scope === 'shared')),
        h('span', {}, 'to'), select(s, 'to', zoneOptions(s.op === 'deal' ? (z) => z.scope === 'player' : () => true)),
        s.op === 'move' ? h('select', { value: String(s.faceUp ?? ''), onchange: (e) => { s.faceUp = e.target.value === '' ? undefined : e.target.value === 'true'; ctx.changed(); } },
          h('option', { value: '' }, 'zone default'), h('option', { value: 'true' }, 'face up'), h('option', { value: 'false' }, 'face down')) : null,
      ];
    };
    redraw();
    return wrap;
  }

  function turnEditor() {
    const t = project.turn;
    const phasesWrap = h('div', {});
    const redrawPhases = () => phasesWrap.replaceChildren(
      h('ol', { class: 'setup-list' }, t.phases.map((p, i) => h('li', {},
        h('input', { type: 'text', value: p.name, size: 12, oninput: (e) => { p.name = e.target.value; ctx.changed(); } }),
        h('input', { type: 'text', class: 'grow', value: p.description || '', placeholder: 'What happens in this phase', oninput: (e) => { p.description = e.target.value; ctx.changed(); } }),
        rowButtons(t.phases, i, redrawPhases)))),
      h('button', { class: 'btn small', onclick: () => { t.phases.push({ name: 'Phase', description: '' }); ctx.changed(); redrawPhases(); } }, '+ Add phase'));
    redrawPhases();
    return h('div', { class: 'stack' },
      h('div', { class: 'grid-3' },
        field('First player', select(t, 'firstPlayer', { seat1: 'Seat 1', random: 'Random (seeded)' })),
        field('Turn order', select(t, 'direction', { clockwise: 'Clockwise', counterclockwise: 'Anticlockwise' })),
        field('Auto-draw at start of turn', h('div', { class: 'row gap' },
          num(t.drawAtStart, 'count', { min: 0, class: 'narrow' }),
          h('span', {}, 'from'),
          select(t.drawAtStart, 'from', zoneOptions((z) => z.scope === 'shared')))),
      ),
      h('div', {}, h('span', { class: 'field-label' }, 'Phases'), phasesWrap));
  }

  function automationEditor() {
    const A = project.automation;
    const T = A.tricks;
    const S = A.shedding;
    const Z = A.sets;
    const wrap = h('div', {});
    const summary = h('ul', { class: 'auto-list' });
    const refreshSummary = () => summary.replaceChildren(...describeAutomation(project).map((l) => h('li', { class: l.startsWith('  ') ? 'sub' : '' }, l.trim())));
    const changed = () => { ctx.changed(); refreshSummary(); };
    const sel = (obj, key, options, after) => h('select', {
      value: obj[key] ?? '',
      onchange: (e) => { obj[key] = e.target.value; changed(); after?.(); },
    }, Object.entries(options).map(([v, l]) => h('option', { value: v }, l)));
    const txt = (obj, key, attrs = {}) => h('input', { type: 'text', value: obj[key] ?? '', ...attrs, oninput: (e) => { obj[key] = e.target.value; changed(); } });
    const box = (obj, key, label) => h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; changed(); } }), ' ', label);
    const formula = (obj, key, placeholder) => {
      const err = h('small', { class: 'formula-err' }, obj[key] ? check(obj[key]) : '');
      return h('div', { class: 'formula' },
        h('input', { type: 'text', class: 'mono', value: obj[key] || '', placeholder, oninput: (e) => { obj[key] = e.target.value; err.textContent = e.target.value.trim() ? check(e.target.value) : ''; changed(); } }),
        err);
    };
    const counters = () => Object.fromEntries(project.counters.map((c) => [c.id, c.name]));
    const remove = (arr, i) => h('button', { class: 'icon-btn danger', title: 'Remove', onclick: () => { arr.splice(i, 1); changed(); redraw(); } }, '✕');
    const shared = Object.fromEntries(project.zones.filter((z) => z.scope === 'shared').map((z) => [z.id, z.name]));
    const perPlayer = { '': '(back to the pack)', ...Object.fromEntries(project.zones.filter((z) => z.scope === 'player' && z.id !== 'hand').map((z) => [z.id, z.name])) };

    function setsEditor() {
      const num = (obj, key, min, max) => h('input', { type: 'number', min, max, class: 'narrow', value: obj[key] ?? 0, oninput: (e) => { obj[key] = Number(e.target.value) || 0; changed(); } });
      const playerZones = Object.fromEntries(project.zones.filter((z) => z.scope === 'player' && z.id !== 'hand').map((z) => [z.id, z.name]));
      const patternCell = (cb) => {
        const err = h('small', { class: 'formula-err' }, cb.pattern ? parsePattern(cb.pattern, project.cards).error : '');
        return h('div', { class: 'formula' },
          h('input', { type: 'text', class: 'mono', value: cb.pattern || '', placeholder: 'e.g. werewolf + villager', size: 26,
            oninput: (e) => { cb.pattern = e.target.value; err.textContent = e.target.value.trim() ? parsePattern(e.target.value, project.cards).error : ''; changed(); } }), err);
      };
      const noValue = project.cards.filter((c) => c.stats?.[Z.valueStat] == null);
      return h('fieldset', { class: 'image-set' }, h('legend', {}, 'Set collection'),
        h('div', { class: 'grid-3' },
          field('Draw pile', sel(Z, 'drawZone', shared)),
          field('Face-up cards to swap with', sel(Z, 'marketZone', { '': '(none)', ...shared })),
          field('Discard pile', sel(Z, 'discardZone', shared))),
        h('div', { class: 'grid-3' },
          field('Actions per turn', num(Z, 'actions', 1, 10)),
          field('Hand limit at the end of a turn (0 = none)', num(Z, 'handLimit', 0, 50)),
          field('Value = card stat', txt(Z, 'valueStat', { class: 'mono' }))),
        h('div', { class: 'grid-3' },
          field("Complete a trick in another player's", sel(Z, 'giveZone', { '': '(not allowed)', ...playerZones })),
          field('…and take it to your', sel(Z, 'captureZone', playerZones)),
          field('Score counter', sel(Z, 'counter', counters()))),
        h('div', { class: 'grid-3' }, field('Game end', sel(Z, 'endWhenEmpty', SETS_END)), h('span'), h('span')),
        h('span', { class: 'field-label' }, 'Scoring zones (per player)'),
        h('table', { class: 'edit-table' },
          h('thead', {}, h('tr', {}, ['Zone', 'Multiplier', 'Secret until the end', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, Z.zones.map((zr, i) => h('tr', {},
            h('td', {}, sel(zr, 'zone', playerZones)),
            h('td', {}, num(zr, 'multiplier', 0, 10)),
            h('td', {}, h('input', { type: 'checkbox', checked: !!zr.secret, onchange: (e) => { zr.secret = e.target.checked; changed(); } })),
            h('td', {}, remove(Z.zones, i)))))),
        h('button', { class: 'btn small', onclick: () => { Z.zones.push({ zone: Object.keys(playerZones)[0] || '', multiplier: 1, secret: false }); changed(); redraw(); } }, '+ Add scoring zone'),
        h('span', { class: 'field-label' }, 'Tricks (sets that score)'),
        h('p', { class: 'muted small' }, 'Write each trick as cards joined by "+": a number, then a card name (plural is fine), several names separated by "/", "tag:name", or "any". Add "distinct" for cards that must all be different. Examples: "5 villagers", "werewolf + villager", "seer + 3 any distinct", "defender + villager/seer/witch". A trick scores the sum of its cards\' values unless you give a formula using sum and count (e.g. "sum * 2"). The app always uses the best way to split a zone\'s cards into tricks.'),
        h('table', { class: 'edit-table' },
          h('thead', {}, h('tr', {}, ['Name', 'Cards', 'Points (blank = sum of values)', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, Z.combos.map((cb, i) => h('tr', {},
            h('td', {}, txt(cb, 'label', { size: 10 })),
            h('td', {}, patternCell(cb)),
            h('td', {}, formula(cb, 'points', 'e.g. sum * 2')),
            h('td', {}, remove(Z.combos, i)))))),
        h('button', { class: 'btn small', onclick: () => { Z.combos.push({ id: `combo${Date.now().toString(36)}`, label: 'New trick', pattern: '', points: '' }); changed(); redraw(); } }, '+ Add trick'),
        noValue.length ? h('p', { class: 'warn-box small' }, `${noValue.length} card type(s) have no "${Z.valueStat}" stat (e.g. ${noValue.slice(0, 3).map((c) => c.name).join(', ')}); they count as 0.`) : null);
    }

    function build() {
      const tricks = A.style === 'tricks';
      const missing = tricks ? project.cards.filter((c) => c.stats?.[T.suitStat] == null || c.stats?.[T.rankStat] == null) : [];
      return h('div', { class: 'stack' },
        h('div', { class: 'grid-3' },
          field('Play style', sel(A, 'style', STYLES, redraw)),
          field('Legal-move checking', sel(A, 'enforce', ENFORCE)),
          field('Teams', sel(A, 'teams', { none: 'No teams', partners: 'Partners sit opposite (4 or 6 players)' }))),
        box(A, 'autoScore', 'Automatic scoring - apply the scoring rules below (untick to show them as guidance only and score by hand)'),
        tricks ? h('fieldset', { class: 'image-set' }, h('legend', {}, 'Trick-taking'),
          h('div', { class: 'grid-3' },
            field('Cards are played to', sel(T, 'zone', shared)),
            field('Won tricks go to', sel(T, 'wonZone', perPlayer)),
            field('First lead each hand', sel(T, 'firstLead', { leftOfDealer: "Player to the dealer's left", dealer: 'The dealer' }))),
          h('div', { class: 'grid-3' },
            field('Suit = card stat', txt(T, 'suitStat', { class: 'mono' })),
            field('Rank = card stat (higher wins)', txt(T, 'rankStat', { class: 'mono' })),
            field('Trumps', sel(T, 'trump', { none: 'No trumps', fixed: 'A fixed suit', lastDealt: "Last card dealt (dealer's) is turned up" }, redraw))),
          h('div', { class: 'grid-3' },
            T.trump === 'fixed' ? field('Trump suit', txt(T, 'trumpSuit', { placeholder: 'e.g. Spades' })) : h('span'),
            box(T, 'followSuit', 'Must follow suit if able'),
            box(T, 'redeal', 'Re-deal and score each hand (otherwise the game ends when hands are empty)')),
          missing.length ? h('p', { class: 'warn-box small' }, `${missing.length} card type(s) have no "${T.suitStat}" and "${T.rankStat}" stats (e.g. ${missing.slice(0, 3).map((c) => c.name).join(', ')}). Add them in the Cards tab - or use "Standard deck" there.`) : null,
          h('p', { class: 'muted small' }, 'Setup steps (apart from counter steps) run again at the start of every hand, after all cards are gathered back into the pack.')) : null,
        A.style === 'shedding' ? h('fieldset', { class: 'image-set' }, h('legend', {}, 'Shedding (match & discard)'),
          h('div', { class: 'grid-3' },
            field('Draw pile', sel(S, 'drawZone', shared)),
            field('Discard pile', sel(S, 'discardZone', shared)),
            box(S, 'playDrawn', 'A drawn card may be played straight away')),
          h('div', { class: 'grid-3' },
            field('Colour = card stat', txt(S, 'colourStat', { class: 'mono' })),
            field('Value = card stat', txt(S, 'valueStat', { class: 'mono' })),
            field('Effect = card stat', txt(S, 'effectStat', { class: 'mono' }))),
          h('div', { class: 'grid-3' },
            field('Colour of wild cards', txt(S, 'wildColour', { placeholder: 'e.g. Wild' })),
            field('Stacking draw cards', sel(S, 'stackDraws', STACKING)), h('span')),
          h('p', { class: 'muted small' }, 'Effects are words in the effect stat, separated by spaces: skip, reverse, wild, draw:N (e.g. "wild draw:4"). Cards whose colour is the wild colour are wild too. Setup steps (apart from counter steps) re-run every round; put a "move 1 card to the discard pile" step after dealing to turn up the starting card.'),
          (() => {
            const missing = project.cards.filter((c) => c.stats?.[S.colourStat] == null || c.stats?.[S.valueStat] == null);
            return missing.length ? h('p', { class: 'warn-box small' }, `${missing.length} card type(s) have no "${S.colourStat}" or "${S.valueStat}" stat (e.g. ${missing.slice(0, 3).map((c) => c.name).join(', ')}).`) : null;
          })()) : null,
        A.style === 'sets' ? setsEditor() : null,

        h('div', {},
          h('span', { class: 'field-label' }, 'Announcements'),
          h('p', { class: 'muted small' }, 'Things a player must say around playing a card, like "Last card!". The player clicks an announce button (AI players add "announce" to their move). Every announcement made, missed or caught is counted per player; scoring rules can use the "announcement" and "penalty" events and the announced()/missed()/caught()/catches() formulas.'),
          A.announcements.length ? h('table', { class: 'edit-table' },
            h('thead', {}, h('tr', {}, ['Says', 'Id', 'Checked', 'Required when (formula)', 'If forgotten', 'Penalty: draw', 'Penalty: counter', 'amount (formula)', 'AI catch %', 'Remind', ''].map((t) => h('th', {}, t)))),
            h('tbody', {}, A.announcements.map((r, i) => h('tr', {},
              h('td', {}, txt(r, 'label', { size: 10 })),
              h('td', {}, txt(r, 'id', { class: 'mono', size: 8 })),
              h('td', {}, sel(r, 'check', { afterPlay: 'after the play', beforePlay: 'before the play' })),
              h('td', {}, formula(r, 'when', 'e.g. cardsInHand == 1')),
              h('td', {}, sel(r, 'ifMissed', MISSED)),
              h('td', {}, h('input', { type: 'number', min: 0, max: 20, class: 'narrow', value: r.penaltyDraw ?? 0, oninput: (e) => { r.penaltyDraw = parseInt(e.target.value, 10) || 0; changed(); } })),
              h('td', {}, sel(r, 'penaltyCounter', { '': '(none)', ...counters() })),
              h('td', {}, formula(r, 'penaltyAmount', 'e.g. -10')),
              h('td', {}, h('input', { type: 'number', min: 0, max: 100, class: 'narrow', value: r.aiCatch ?? 70, oninput: (e) => { r.aiCatch = parseInt(e.target.value, 10) || 0; changed(); } })),
              h('td', {}, h('input', { type: 'checkbox', checked: !!r.remind, title: 'Show players a reminder when a card they select would need this announcement', onchange: (e) => { r.remind = e.target.checked; changed(); } })),
              h('td', {}, remove(A.announcements, i)))))) : null,
          h('button', {
            class: 'btn small', onclick: () => {
              const a = blankAnnouncement(project);
              let n = 1;
              while (A.announcements.some((x) => x.id === a.id)) a.id = `announce${++n}`;
              A.announcements.push(a); changed(); redraw();
            },
          }, '+ Add announcement')),

        h('div', {},
          h('span', { class: 'field-label' }, 'Scoring rules'),
          h('table', { class: 'edit-table' },
            h('thead', {}, h('tr', {}, ['When', 'Who', 'Counter', 'Add (formula)', 'Only if (optional)', 'Note', ''].map((t) => h('th', {}, t)))),
            h('tbody', {}, A.scoring.map((r, i) => h('tr', {},
              h('td', {}, sel(r, 'event', SCORE_EVENTS)),
              h('td', {}, sel(r, 'who', SCORE_WHO)),
              h('td', {}, sel(r, 'counter', counters())),
              h('td', {}, formula(r, 'expr', 'e.g. max(0, teamTricks - 6)')),
              h('td', {}, formula(r, 'when', 'e.g. tricks == 0')),
              h('td', {}, txt(r, 'label', { placeholder: 'shown in the log' })),
              h('td', {}, remove(A.scoring, i)))))),
          h('button', { class: 'btn small', onclick: () => { A.scoring.push({ event: tricks ? 'handEnd' : 'turnEnd', who: 'each', counter: project.counters[0]?.id || '', expr: '', when: '', label: '' }); changed(); redraw(); } }, '+ Add scoring rule')),

        h('div', {},
          h('span', { class: 'field-label' }, 'Game end'),
          h('table', { class: 'edit-table' },
            h('thead', {}, h('tr', {}, ['Check after', 'Game ends when (formula, any player)', 'Winner', 'Note', ''].map((t) => h('th', {}, t)))),
            h('tbody', {}, A.endWhen.map((r, i) => h('tr', {},
              h('td', {}, sel(r, 'at', END_AT)),
              h('td', {}, formula(r, 'expr', 'e.g. score >= 5')),
              h('td', {}, sel(r, 'winner', { '': 'Players for whom it is true', ...Object.fromEntries(project.counters.map((c) => [c.id, `Highest ${c.name}`])) })),
              h('td', {}, txt(r, 'label', { placeholder: 'e.g. First to 5 points' })),
              h('td', {}, remove(A.endWhen, i)))))),
          h('button', { class: 'btn small', onclick: () => { A.endWhen.push({ at: tricks ? 'handEnd' : 'turnEnd', expr: '', winner: '', label: '' }); changed(); redraw(); } }, '+ Add end condition')),

        h('details', {}, h('summary', {}, 'Formula help'),
          h('table', { class: 'mini-table' }, h('tbody', {}, FORMULA_HELP.map(([a, b]) => h('tr', {}, h('td', {}, h('code', {}, a)), h('td', {}, b)))))),

        h('div', { class: 'auto-summary' }, h('span', { class: 'field-label' }, 'How the test bench will run this game (AI players read this too)'), summary));
    }
    function redraw() { wrap.replaceChildren(build()); refreshSummary(); }
    redraw();
    return wrap;
  }

  function variantsEditor() {
    const wrap = h('div', {});
    const redraw = () => wrap.replaceChildren(build());
    const build = () => h('div', { class: 'stack' },
      project.variants.length ? null : h('p', { class: 'muted small' }, 'No player options yet. Example: an option "Game length" with choices "Quick" (automation.endWhen.0.expr = score >= 100) and "Long" (automation.endWhen.0.expr = score >= 250).'),
      project.variants.map((v, vi) => h('fieldset', { class: 'image-set' },
        h('legend', {}, v.label || 'Option'),
        h('div', { class: 'grid-3' },
          field('Option name', h('input', { type: 'text', value: v.label, oninput: (e) => { v.label = e.target.value; ctx.changed(); } })),
          field('Explanation for players', h('input', { type: 'text', value: v.description || '', oninput: (e) => { v.description = e.target.value; ctx.changed(); } })),
          field('Default choice', h('select', { value: String(v.default || 0), onchange: (e) => { v.default = parseInt(e.target.value, 10); ctx.changed(); } },
            v.choices.map((c, ci) => h('option', { value: String(ci) }, c.label || `Choice ${ci + 1}`))))),
        h('table', { class: 'edit-table' },
          h('thead', {}, h('tr', {}, ['Choice', 'Settings it changes (path = value, one per line)', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, v.choices.map((c, ci) => {
            const check = h('small', { class: 'muted' });
            const showCheck = () => {
              const bad = Object.keys(c.set || {}).filter((k) => getPath(project, k) === undefined);
              check.textContent = bad.length ? `Not found in this project (will be created): ${bad.join(', ')}` : '';
            };
            showCheck();
            return h('tr', {},
              h('td', {}, h('input', { type: 'text', value: c.label, size: 18, oninput: (e) => { c.label = e.target.value; ctx.changed(); } })),
              h('td', {}, h('textarea', { rows: Math.max(2, Object.keys(c.set || {}).length), class: 'mono', value: formatSetLines(c.set), placeholder: 'automation.endWhen.0.expr = score >= 100', oninput: (e) => { c.set = parseSetLines(e.target.value); showCheck(); ctx.changed(); } }), check),
              h('td', {}, h('button', { class: 'icon-btn danger', title: 'Remove choice', disabled: v.choices.length < 2, onclick: () => { v.choices.splice(ci, 1); v.default = Math.min(v.default || 0, v.choices.length - 1); ctx.changed(); redraw(); } }, '✕')));
          }))),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn small', onclick: () => { v.choices.push({ label: `Choice ${v.choices.length + 1}`, set: {} }); ctx.changed(); redraw(); } }, '+ Add choice'),
          h('button', { class: 'btn small danger', onclick: () => { project.variants.splice(vi, 1); ctx.changed(); redraw(); } }, 'Remove option')))),
      h('button', { class: 'btn small', onclick: () => { project.variants.push(blankVariant()); ctx.changed(); redraw(); } }, '+ Add player option'));
    redraw();
    return wrap;
  }

  function showPrompt() {
    modal('AI rulebook prompt', h('pre', { class: 'prompt-preview' }, buildSystemPrompt(project)), [{ label: 'Close' }], { wide: true });
  }

  draw();
}
