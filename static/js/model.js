// Project data model: defaults, normalisation, and a sample game.
//
// A project is plain JSON so it can be stored on the server, in the browser,
// exported, diffed and handed to an AI. See docs/PLAN.md for the full schema.

export const SCHEMA = 1;

export function uid(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export const LAYOUTS = {
  stack: 'Pile (top card shows)',
  spread: 'Row (all cards show)',
  hand: 'Hand (fanned, private to owner)',
};

export const SETUP_OPS = {
  shuffle: 'Shuffle a zone',
  deal: 'Deal N cards to each player',
  move: 'Move N cards between zones',
  counter: 'Set a counter for every player',
};

export function defaultZones() {
  return [
    { id: 'deck', name: 'Draw pile', scope: 'shared', layout: 'stack', faceUp: false, visibility: 'public' },
    { id: 'discard', name: 'Discard pile', scope: 'shared', layout: 'stack', faceUp: true, visibility: 'public' },
    { id: 'table', name: 'Table', scope: 'shared', layout: 'spread', faceUp: true, visibility: 'public' },
    { id: 'hand', name: 'Hand', scope: 'player', layout: 'hand', faceUp: true, visibility: 'owner', builtin: true },
    { id: 'tableau', name: 'In front of player', scope: 'player', layout: 'spread', faceUp: true, visibility: 'public' },
  ];
}

export function blankProject(name = 'Untitled game') {
  const now = Date.now();
  return {
    schema: SCHEMA,
    id: uid('p_'),
    name,
    description: '',
    created: now,
    updated: now,
    players: { min: 2, max: 6, default: 4 },
    cardBack: { color: '#2d4f7c', image: null, label: '' },
    zones: defaultZones(),
    counters: [{ id: 'score', name: 'Score', start: 0 }],
    setup: [
      { op: 'shuffle', zone: 'deck' },
      { op: 'deal', from: 'deck', to: 'hand', count: 5 },
    ],
    turn: {
      phases: [
        { name: 'Draw', description: 'Draw a card.' },
        { name: 'Play', description: 'Play cards from your hand.' },
        { name: 'End', description: 'Tidy up and pass the turn.' },
      ],
      drawAtStart: { count: 1, from: 'deck' },
      firstPlayer: 'seat1',
      direction: 'clockwise',
    },
    rules: {
      overview: '',
      objective: '',
      turnRules: '',
      endGame: '',
      scoring: '',
      aiHints: '',
    },
    cards: [],
  };
}

export function blankCard(project) {
  return {
    id: uid('k_'),
    name: 'New card',
    description: '',
    rules: '',
    count: 1,
    startZone: project.zones.find((z) => z.scope === 'shared' && z.layout === 'stack')?.id || 'deck',
    color: '#f4efe3',
    image: null,
    imageMode: 'art',
    stats: {},
    tags: [],
  };
}

// Fill in anything missing so older/hand-edited projects keep working.
export function normalizeProject(p) {
  const base = blankProject(p.name || 'Untitled game');
  const out = { ...base, ...p };
  out.players = { ...base.players, ...(p.players || {}) };
  out.cardBack = { ...base.cardBack, ...(p.cardBack || {}) };
  out.turn = { ...base.turn, ...(p.turn || {}) };
  out.turn.drawAtStart = { ...base.turn.drawAtStart, ...(out.turn.drawAtStart || {}) };
  out.rules = { ...base.rules, ...(p.rules || {}) };
  out.zones = Array.isArray(p.zones) && p.zones.length ? p.zones : base.zones;
  if (!out.zones.some((z) => z.id === 'hand')) out.zones.push(defaultZones()[3]);
  out.counters = Array.isArray(p.counters) ? p.counters : base.counters;
  out.setup = Array.isArray(p.setup) ? p.setup : base.setup;
  out.cards = (p.cards || []).map((c) => ({ ...blankCard(out), ...c, stats: c.stats || {}, tags: c.tags || [] }));
  return out;
}

export function zoneDef(project, defId) {
  return project.zones.find((z) => z.id === defId);
}

export function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'zone';
}

// ------------------------------------------------------------------ sample
// An original small "capture" game so the harness has something to play
// straight away. It is deliberately simple and a bit flawed, so there is
// something for the playtest/analysis tools to find.
export function sampleProject() {
  const p = blankProject('Harbour Lights (sample)');
  p.description = 'A small capture game for 2-5 players, included to try out the test bench.';
  p.players = { min: 2, max: 5, default: 3 };
  p.cardBack = { color: '#1f3b57', image: null, label: 'HARBOUR LIGHTS' };
  p.zones = [
    { id: 'deck', name: 'Sea (draw pile)', scope: 'shared', layout: 'stack', faceUp: false, visibility: 'public' },
    { id: 'harbour', name: 'Harbour', scope: 'shared', layout: 'spread', faceUp: true, visibility: 'public' },
    { id: 'discard', name: 'Wreckage (discard)', scope: 'shared', layout: 'stack', faceUp: true, visibility: 'public' },
    { id: 'hand', name: 'Hand', scope: 'player', layout: 'hand', faceUp: true, visibility: 'owner', builtin: true },
    { id: 'haul', name: 'Haul', scope: 'player', layout: 'spread', faceUp: true, visibility: 'public' },
  ];
  p.counters = [{ id: 'score', name: 'Score', start: 0 }];
  p.setup = [
    { op: 'shuffle', zone: 'deck' },
    { op: 'deal', from: 'deck', to: 'hand', count: 4 },
    { op: 'move', from: 'deck', to: 'harbour', count: 4, faceUp: true },
  ];
  p.turn = {
    phases: [
      { name: 'Draw', description: 'Draw 1 card from the Sea (done automatically).' },
      { name: 'Sail', description: 'Play exactly one card from your hand.' },
    ],
    drawAtStart: { count: 1, from: 'deck' },
    firstPlayer: 'seat1',
    direction: 'clockwise',
  };
  p.rules = {
    overview: 'Players are harbour masters guiding boats in at night. Boats come in four colours, numbered 1-6.',
    objective: 'Have the highest Score when the game ends.',
    turnRules:
      'On your turn, after drawing, play exactly ONE card from your hand:\n' +
      '- CAPTURE: if your boat has the same number as a boat in the Harbour, move both cards to your Haul and add their two numbers to your Score.\n' +
      '- MOOR: otherwise place your card face up in the Harbour.\n' +
      '- Lighthouse cards capture any ONE Harbour boat of your choice (score that boat\'s number + 2).\n' +
      '- Storm cards send every card in the Harbour to the Wreckage; the player who plays a Storm scores 1.\n' +
      'Then end your turn.',
    endGame: 'When the Sea is empty and every hand is empty, the game ends.',
    scoring: 'Score is tracked with the Score counter. Highest Score wins; ties are shared.',
    aiHints: 'Capturing high numbers is strong. Avoid mooring a boat that the next player can easily capture.',
  };
  const colours = [
    ['Amber', '#f3c969'], ['Teal', '#7fd0c6'], ['Violet', '#b9a3e3'], ['Coral', '#f39a8b'],
  ];
  for (const [cname, col] of colours) {
    for (let v = 1; v <= 6; v++) {
      p.cards.push({
        ...blankCard(p), id: `k_${cname.toLowerCase()}${v}`, name: `${cname} ${v}`,
        description: `${cname} boat`, rules: '', count: 1, color: col,
        stats: { number: v, colour: cname }, tags: ['boat'],
      });
    }
  }
  p.cards.push({
    ...blankCard(p), id: 'k_lighthouse', name: 'Lighthouse', description: 'Special',
    rules: 'Capture any one boat in the Harbour. Score its number + 2.', count: 3, color: '#fff7d6',
    stats: {}, tags: ['special'],
  });
  p.cards.push({
    ...blankCard(p), id: 'k_storm', name: 'Storm', description: 'Special',
    rules: 'Every card in the Harbour goes to the Wreckage. Score 1.', count: 2, color: '#a9b4c2',
    stats: {}, tags: ['special'],
  });
  return p;
}
