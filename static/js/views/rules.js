// Rules & setup editor: players, zones, counters, setup steps, turn
// structure, and the free-text rulebook that the AI players read.
import { buildSystemPrompt } from '../ai.js';
import { LAYOUTS, SETUP_OPS, slug } from '../model.js';
import { field, h, modal } from '../ui.js';

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
          field('Default players', num(project.players, 'default', { min: 1, max: 6 }))))),

      section('Zones', 'Places cards can be. Shared zones sit in the middle of the table; per-player zones appear at each seat. Every player has a Hand.', zonesTable()),

      section('Counters', 'Numbers tracked for each player - score, health, coins…', countersTable()),

      section('Setup', 'Run in order when a new game starts. Cards first go to their "Starts in" zone (set per card).', setupList()),

      section('Turn structure', null, turnEditor()),

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

  function showPrompt() {
    modal('AI rulebook prompt', h('pre', { class: 'prompt-preview' }, buildSystemPrompt(project)), [{ label: 'Close' }], { wide: true });
  }

  draw();
}
