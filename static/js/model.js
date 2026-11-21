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

// Optional rules automation. 'free' style = sandbox table (the original
// behaviour); 'tricks' = trick-taking engine (follow suit, trumps, tricks).
// Scoring rules and end conditions use formulas (see expr.js) and work in
// either style.
export const STYLES = {
  free: 'Free-form: any card can go anywhere; players apply the rules',
  tricks: 'Trick-taking: play one card to a trick; highest wins (Whist, Hearts, Spades…)',
};
export const ENFORCE = {
  off: 'Off - no checks',
  warn: 'Warn - allow, but log a warning',
  strict: 'Strict - block illegal moves',
};
export const SCORE_EVENTS = { trickWon: 'a trick is won', handEnd: 'a hand ends', turnEnd: 'a turn ends' };
export const SCORE_WHO = { each: 'each player', team: 'each team', winner: 'the trick winner', winnerTeam: "the trick winner's team", active: 'the player whose turn ended' };
export const END_AT = { handEnd: 'each hand', trickWon: 'each trick', turnEnd: 'each turn' };

export function defaultAutomation() {
  return {
    style: 'free',
    enforce: 'warn',
    autoScore: true,
    teams: 'none',
    tricks: {
      zone: 'trick',
      wonZone: 'won',
      suitStat: 'suit',
      rankStat: 'rank',
      followSuit: true,
      trump: 'none', // none | fixed | lastDealt
      trumpSuit: '',
      firstLead: 'leftOfDealer', // leftOfDealer | dealer
      redeal: true,
    },
    scoring: [], // { event, who, counter, expr, when, label }
    endWhen: [], // { at, expr, winner: '' (players matching) | counter id (highest) , label }
  };
}

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
    automation: defaultAutomation(),
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
  const A = p.automation || {};
  out.automation = {
    ...base.automation, ...A,
    tricks: { ...base.automation.tricks, ...(A.tricks || {}) },
    scoring: Array.isArray(A.scoring) ? A.scoring : [],
    endWhen: Array.isArray(A.endWhen) ? A.endWhen : [],
  };
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

// ------------------------------------------------------------------ playing cards
export const SUITS = [
  { name: 'Spades', symbol: '♠', red: false },
  { name: 'Hearts', symbol: '♥', red: true },
  { name: 'Diamonds', symbol: '♦', red: true },
  { name: 'Clubs', symbol: '♣', red: false },
];
const RANK_NAMES = { 11: ['J', 'Jack'], 12: ['Q', 'Queen'], 13: ['K', 'King'], 14: ['A', 'Ace'], 1: ['A', 'Ace'] };

// A standard deck as card definitions with stats { suit, rank } (rank 2-14,
// ace high unless aceLow). Tagged 'playing-card' for the classic card face.
export function standardDeck(project, { aceLow = false, jokers = 0 } = {}) {
  const cards = [];
  const start = project.zones.find((z) => z.scope === 'shared' && z.layout === 'stack')?.id || 'deck';
  for (const s of SUITS) {
    for (let r = 2; r <= 14; r++) {
      const rank = aceLow && r === 14 ? 1 : r;
      const [short, long] = RANK_NAMES[rank] || [String(rank), String(rank)];
      cards.push({
        ...blankCard(project), id: `k_${short.toLowerCase()}${s.name[0].toLowerCase()}`,
        name: `${short}${s.symbol}`, description: `${long} of ${s.name}`, count: 1, startZone: start,
        color: '#fdfcf8', stats: { suit: s.name, rank }, tags: ['playing-card'],
      });
    }
  }
  if (jokers > 0) {
    cards.push({ ...blankCard(project), id: 'k_joker', name: 'Joker', description: 'Joker', count: jokers, startZone: start, color: '#fdfcf8', stats: { suit: 'Joker', rank: 15 }, tags: ['playing-card'] });
  }
  return cards;
}

export function whistProject() {
  const p = blankProject('Whist (classic)');
  p.description = 'Classic short whist for four players in two partnerships. Included to show legal-move checking and automatic scoring.';
  p.players = { min: 4, max: 4, default: 4 };
  p.cardBack = { color: '#7a2531', image: null, label: 'WHIST' };
  p.zones = [
    { id: 'deck', name: 'Pack', scope: 'shared', layout: 'stack', faceUp: false, visibility: 'public' },
    { id: 'trick', name: 'Trick', scope: 'shared', layout: 'spread', faceUp: true, visibility: 'public' },
    { id: 'hand', name: 'Hand', scope: 'player', layout: 'hand', faceUp: true, visibility: 'owner', builtin: true },
    { id: 'won', name: 'Tricks won', scope: 'player', layout: 'stack', faceUp: false, visibility: 'public' },
  ];
  p.counters = [{ id: 'score', name: 'Points', start: 0 }];
  p.setup = [
    { op: 'shuffle', zone: 'deck' },
    { op: 'deal', from: 'deck', to: 'hand', count: 13 },
  ];
  p.turn = { phases: [], drawAtStart: { count: 0, from: 'deck' }, firstPlayer: 'seat1', direction: 'clockwise' };
  p.automation = {
    ...defaultAutomation(),
    style: 'tricks',
    enforce: 'strict',
    autoScore: true,
    teams: 'partners',
    tricks: { ...defaultAutomation().tricks, trump: 'lastDealt', firstLead: 'leftOfDealer', redeal: true },
    scoring: [
      { event: 'handEnd', who: 'team', counter: 'score', expr: 'max(0, teamTricks - 6)', when: '', label: 'One point per trick over six' },
    ],
    endWhen: [
      { at: 'handEnd', expr: 'score >= 5', winner: '', label: 'First partnership to 5 points' },
    ],
  };
  p.rules = {
    overview: 'Four players in two partnerships; partners sit opposite each other (seats 1 & 3 against seats 2 & 4). All 52 cards are dealt, 13 each.',
    objective: 'Be the first partnership to score 5 points.',
    turnRules:
      'Trumps: the last card dealt (it goes to the dealer) is shown to everyone; its suit is trumps for the hand.\n' +
      'The player to the dealer\'s left leads to the first trick. Each player in turn, clockwise, plays one card.\n' +
      'You MUST follow the suit that was led if you can. If you cannot, you may play any card, including a trump.\n' +
      'The trick is won by the highest trump played, or if no trump was played, the highest card of the suit led. Aces are high.\n' +
      'The winner of a trick leads to the next one.',
    endGame: 'After all 13 tricks the hand is scored. The deal passes to the left and a new hand is dealt. The game ends when a partnership reaches 5 points.',
    scoring: 'Each partnership scores 1 point for every trick it wins beyond six (the first six tricks are the "book"). Honours are not scored in this version.',
    aiHints: 'Track which cards have been played. Lead from long suits; avoid wasting high cards when your partner is already winning the trick.',
  };
  p.cards = standardDeck(p);
  return p;
}
