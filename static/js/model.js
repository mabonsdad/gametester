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
  shedding: 'Shedding: match the colour or value of the top card; first to empty their hand wins',
  sets: 'Set collection: lay sets in front of you; a few actions per turn; best combination scores',
};
export const SETS_END = {
  round: 'When the draw pile runs out, finish the round (equal turns), then end',
  now: 'When the draw pile runs out, end after that turn',
  off: 'Only by the end conditions below',
};
export const ENFORCE = {
  off: 'Off - no checks',
  warn: 'Warn - allow, but log a warning',
  strict: 'Strict - block illegal moves',
};
export const SCORE_EVENTS = {
  trickWon: 'a trick is won', handEnd: 'a hand / round ends', turnEnd: 'a turn ends',
  announcement: 'a required announcement is made', penalty: 'a player is penalised for a missed announcement',
};
export const SCORE_WHO = {
  each: 'each player', team: 'each team',
  winner: 'the winner (of the trick, who went out, or who made the catch)', winnerTeam: "the winner's team",
  active: 'the player concerned (whose turn ended / who announced / who was penalised)',
};
export const MISSED = { catch: 'Other players can catch them', auto: 'Penalty applied automatically', none: 'Only recorded' };
export const STACKING = { off: 'No stacking', same: 'Same draw card only (+2 on +2, +4 on +4)', any: 'Any draw card on any draw card' };
export const END_AT = { handEnd: 'each hand / round', trickWon: 'each trick', turnEnd: 'each turn' };

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
    shedding: {
      drawZone: 'deck',
      discardZone: 'discard',
      colourStat: 'colour',
      valueStat: 'value',
      effectStat: 'effect',
      wildColour: 'Wild',
      playDrawn: true,
      stackDraws: 'off',
    },
    sets: {
      drawZone: 'deck',
      marketZone: 'market', // face-up cards that can be swapped ('' = none)
      discardZone: 'discard',
      actions: 2, // actions per turn
      handLimit: 6, // discard down to this at the end of a turn (0 = no limit)
      valueStat: 'value',
      zones: [ // per-player zones that score: { zone, multiplier, secret (scored only at the end) }
        { zone: 'day', multiplier: 2, secret: false },
        { zone: 'night', multiplier: 1, secret: true },
      ],
      giveZone: 'day', // other players' zone you can complete a trick in ('' = not allowed)
      captureZone: 'night', // where a trick you complete there goes
      giveNeedsTrick: true,
      counter: 'score',
      combos: [], // { id, label, pattern: 'werewolf + villager', points: '' (sum of values) | formula using sum, count }
      endWhenEmpty: 'round', // round | now | off
      arrange: 'manual', // stackable zones: 'auto' groups tricks automatically, 'manual' = players stack them
    },
    announcements: [], // { id, label, check, when, ifMissed, penaltyDraw, penaltyCounter, penaltyAmount, aiCatch, remind }
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
    theme: '', // the player view's look (see themes.js)
    variants: [], // player options: { id, label, description, default, choices: [{ label, set: { 'path.to.setting': value } }] }
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
    icon: '', // an emoji shown as the card's picture when it has no image
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
    shedding: { ...base.automation.shedding, ...(A.shedding || {}) },
    sets: { ...base.automation.sets, ...(A.sets || {}) },
    scoring: Array.isArray(A.scoring) ? A.scoring : [],
    endWhen: Array.isArray(A.endWhen) ? A.endWhen : [],
    announcements: Array.isArray(A.announcements) ? A.announcements : [],
  };
  out.zones = Array.isArray(p.zones) && p.zones.length ? p.zones : base.zones;
  if (!out.zones.some((z) => z.id === 'hand')) out.zones.push(defaultZones()[3]);
  out.counters = Array.isArray(p.counters) ? p.counters : base.counters;
  out.variants = Array.isArray(p.variants) ? p.variants : [];
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
  p.variants = [
    { id: 'length', label: 'Game length', description: 'Points a partnership needs to win.', default: 0, choices: [
      { label: 'Short (5 points)', set: { 'automation.endWhen.0.expr': 'score >= 5', 'automation.endWhen.0.label': 'First partnership to 5 points' } },
      { label: 'Long (7 points)', set: { 'automation.endWhen.0.expr': 'score >= 7', 'automation.endWhen.0.label': 'First partnership to 7 points' } },
    ] },
    { id: 'trumps', label: 'Trumps', description: 'How the trump suit is chosen each hand.', default: 0, choices: [
      { label: 'Turn up the last card dealt', set: { 'automation.tricks.trump': 'lastDealt' } },
      { label: 'No trumps', set: { 'automation.tricks.trump': 'none' } },
    ] },
  ];
  p.cards = standardDeck(p);
  return p;
}

// ------------------------------------------------------------------ shedding sample
// An original match-and-shed game (same family as Crazy Eights), included to
// exercise the shedding rules, card effects and round scoring.
export function blankAnnouncement(project) {
  return {
    id: 'lastCard', label: 'Last card!', check: 'afterPlay', when: 'cardsInHand == 1', ifMissed: 'catch',
    penaltyDraw: 2, penaltyCounter: '', penaltyAmount: '', aiCatch: 70, remind: false,
  };
}

export function switchbackProject() {
  const p = blankProject('Switchback (shedding sample)');
  p.description = 'Match the colour or value of the top card and be first to empty your hand. Action cards skip, reverse and make others draw. Included to show shedding rules, card effects and round scoring.';
  p.players = { min: 2, max: 6, default: 4 };
  p.cardBack = { color: '#23324a', image: null, label: 'SWITCHBACK' };
  p.zones = [
    { id: 'deck', name: 'Draw pile', scope: 'shared', layout: 'stack', faceUp: false, visibility: 'public' },
    { id: 'discard', name: 'Discard pile', scope: 'shared', layout: 'stack', faceUp: true, visibility: 'public' },
    { id: 'hand', name: 'Hand', scope: 'player', layout: 'hand', faceUp: true, visibility: 'owner', builtin: true },
  ];
  p.counters = [{ id: 'score', name: 'Points', start: 0 }, { id: 'catches', name: 'Catches', start: 0 }];
  p.setup = [
    { op: 'shuffle', zone: 'deck' },
    { op: 'deal', from: 'deck', to: 'hand', count: 7 },
    { op: 'move', from: 'deck', to: 'discard', count: 1, faceUp: true },
  ];
  p.turn = { phases: [], drawAtStart: { count: 0, from: 'deck' }, firstPlayer: 'seat1', direction: 'clockwise' };
  p.automation = {
    ...defaultAutomation(),
    style: 'shedding',
    enforce: 'strict',
    autoScore: true,
    shedding: { ...defaultAutomation().shedding, stackDraws: 'same' },
    announcements: [
      { ...blankAnnouncement(), id: 'lastCard', label: 'Last card!', when: 'cardsInHand == 1', ifMissed: 'catch', penaltyDraw: 2, aiCatch: 70 },
    ],
    scoring: [
      { event: 'handEnd', who: 'winner', counter: 'score', expr: 'othersHandSum("points")', when: '', label: "Points left in everyone else's hands" },
      { event: 'penalty', who: 'winner', counter: 'catches', expr: '1', when: '', label: 'Caught someone who forgot "Last card!"' },
    ],
    endWhen: [
      { at: 'handEnd', expr: 'score >= 150', winner: '', label: 'First to 150 points' },
    ],
  };
  p.rules = {
    overview: 'A fast matching game. Everyone starts with 7 cards; one card is turned up to start the discard pile.',
    objective: 'Be first to empty your hand in each round, and first to 150 points overall.',
    turnRules:
      'On your turn play ONE card that matches the top card of the discard pile by colour or by value (number or symbol), or play a Prism (wild).\n' +
      'If you cannot (or choose not to) play, draw one card. If that card can be played you may play it straight away; otherwise your turn ends.\n' +
      'Sidestep: the next player misses their turn.\n' +
      'Switchback: reverse the direction of play (with two players it works like Sidestep).\n' +
      '+2: the next player draws two cards and misses their turn.\n' +
      'Prism: play on anything and name the colour to follow. Prism +4: as Prism, and the next player draws four cards and misses their turn.\n' +
      'Stacking: if a +2 is played on you, you may play your own +2 instead of drawing; the next player then faces +4, and so on. Prism +4 stacks only on Prism +4. If you cannot (or choose not to) stack, take all the waiting cards and miss your turn.\n' +
      'Last card: when you play your second-to-last card you must say "Last card!" as you play it. If you forget, any other player can catch you before the next player acts, and you draw 2 cards.',
    endGame: 'A round ends as soon as someone plays their last card (any effect on that card still happens). Rounds continue until a player reaches 150 points.',
    scoring: 'The player who goes out scores the points left in everyone else\'s hands: number cards at face value, Sidestep / Switchback / +2 cards 20, Prism cards 50.',
    aiHints: 'Hold on to Prism cards for when you are stuck. Use +2 and Sidestep on a player who is close to going out. Change colour to one you hold many of. Keep a +2 back to defend against stacked draws. Remember to say "Last card!".',
  };
  const colours = [['Ember', '#e0643f'], ['Lagoon', '#2a95ab'], ['Moss', '#5f9e45'], ['Plum', '#8b5aa6']];
  const start = 'deck';
  const card = (id, name, description, colour, colourHex, value, effect, points, count) => ({
    ...blankCard(p), id, name, description, count, startZone: start, color: colourHex,
    stats: { colour, value, ...(effect ? { effect } : {}), points }, tags: ['colour-card'],
  });
  for (const [c, hex] of colours) {
    const k = c.toLowerCase();
    for (let v = 1; v <= 9; v++) p.cards.push(card(`k_${k}${v}`, `${c} ${v}`, `${c} number card`, c, hex, String(v), '', v, 2));
    p.cards.push(card(`k_${k}_skip`, `${c} Sidestep`, 'Next player misses a turn', c, hex, 'skip', 'skip', 20, 2));
    p.cards.push(card(`k_${k}_rev`, `${c} Switchback`, 'Reverse the direction of play', c, hex, 'reverse', 'reverse', 20, 2));
    p.cards.push(card(`k_${k}_d2`, `${c} +2`, 'Next player draws 2 and misses a turn', c, hex, '+2', 'draw:2', 20, 2));
  }
  p.variants = [
    { id: 'length', label: 'Game length', description: 'Points needed to win.', default: 1, choices: [
      { label: 'Quick (100 points)', set: { 'automation.endWhen.0.expr': 'score >= 100', 'automation.endWhen.0.label': 'First to 100 points' } },
      { label: 'Standard (150 points)', set: { 'automation.endWhen.0.expr': 'score >= 150', 'automation.endWhen.0.label': 'First to 150 points' } },
      { label: 'Long (250 points)', set: { 'automation.endWhen.0.expr': 'score >= 250', 'automation.endWhen.0.label': 'First to 250 points' } },
    ] },
    { id: 'stacking', label: 'Stacking draw cards', description: 'Can a +2 or +4 be passed on with another draw card?', default: 0, choices: [
      { label: 'Same card only (+2 on +2, +4 on +4)', set: { 'automation.shedding.stackDraws': 'same' } },
      { label: 'Any draw card on any draw card', set: { 'automation.shedding.stackDraws': 'any' } },
      { label: 'No stacking', set: { 'automation.shedding.stackDraws': 'off' } },
    ] },
    { id: 'lastcard', label: '"Last card!" rule', description: 'Must you announce your last card?', default: 0, choices: [
      { label: 'Yes - +2 cards if you are caught', set: { 'automation.announcements.0.ifMissed': 'catch' } },
      { label: 'No - the rule is off', set: { 'automation.announcements': [] } },
    ] },
  ];
  p.cards.push(card('k_prism', 'Prism', 'Wild: play on anything, choose the colour', 'Wild', '#2b2b33', 'wild', 'wild', 50, 4));
  p.cards.push(card('k_prism4', 'Prism +4', 'Wild: choose the colour; next player draws 4 and misses a turn', 'Wild', '#2b2b33', 'wild+4', 'wild draw:4', 50, 2));
  return p;
}


// ------------------------------------------------------------------ Weirdwolves
// Set collection with a werewolf theme: lay sets face up (Day, more points,
// but others can finish lone cards and take them) or face down (Night, safe
// and secret). Two scoring systems, chosen before a game (WEREWOLF_SCORING).

// Night characters (a moon on the card); every other role is a Day character.
const NIGHT_ROLES = ['seer', 'witch', 'werewolf', 'vampire', 'alpha-wolf'];

// The two ways to score Weirdwolves. value: card values; combos: [pattern,
// points] by set id; text: each card's rule line.
export const WEREWOLF_SCORING = {
  sets: {
    label: 'Sets score (add up your sets)',
    cardsScore: false,
    dayMultiplier: 2,
    value: { villager: 1, seer: 1, werewolf: 2, witch: 3, cupid: -1, 'alpha-wolf': 4, defender: 'same', vampire: 5, sister: 3, hunter: 2, cannibal: 6 },
    combos: {
      mob: ['5 villagers', ''], vision: ['seer + 3 tag:night distinct', ''], hunt: ['werewolf + villager', ''], potion: ['witch + villager + werewolf', ''],
      lovers: ['cupid + 2 any', ''], pack: ['alpha wolf + 3 werewolves', ''], guard: ['defender + villager/seer/witch/sister/hunter', ''],
      feast: ['vampire + 3 villagers', ''], sisters: ['2 sisters', ''], bullet: ['hunter + werewolf', ''], banquet: ['cannibal + 5 tag:day', ''],
    },
    text: {
      villager: 'Mob: 5 Villagers.', seer: 'Vision: a Seer + 3 different Night characters (moon cards).', werewolf: 'Dinner: a Werewolf + a Villager.',
      witch: 'Potions: Witch + Villager (saved) + Werewolf (poisoned).', cupid: 'Lovers: Cupid + any 2 cards.', 'alpha-wolf': 'Pack: Alpha Wolf + 3 Werewolves.',
      defender: 'Defend: a Defender + a Villager, Seer, Witch, Sister or Hunter.', vampire: 'Feast: a Vampire + 3 Villagers.', sister: 'Sisters: a pair of Sisters.',
      hunter: 'Hunt: a Hunter + a Werewolf.', cannibal: 'Banquet: a Cannibal + 5 Day characters (no moon).',
    },
    scoring:
      "Only cards in a set score. A set is worth the sum of its cards' values - doubled in your Day sets, single in your Night sets. Each card counts in one set only. Night sets are arranged for the most points; Day sets for the fewest lone cards.\n" +
      'Night characters have a moon on the card: Seer, Witch, Werewolf, Vampire and Alpha Wolf. All the others are Day characters.\n' +
      'Mob: 5 Villagers (5).\n' +
      'Vision: a Seer + 3 different Night characters, e.g. Seer, Witch, Werewolf, Vampire (11) or Seer, Seer, Werewolf, Witch (7).\n' +
      'Dinner: a Werewolf + a Villager (3).\n' +
      'Potions: a Witch + a Villager + a Werewolf (6).\n' +
      "Lovers: Cupid + any 2 cards (the two cards' values, less 1 for Cupid).\n" +
      'Pack: the Alpha Wolf + 3 Werewolves (10).\n' +
      'Defend: a Defender + a Villager, Seer, Witch, Sister or Hunter (2 to 6). The Defender is wild: it is worth as much as the card it is with.\n' +
      'Feast: a Vampire + 3 Villagers (8).\n' +
      'Sisters: a pair of Sisters (6).\n' +
      'Hunt: a Hunter + a Werewolf (4).\n' +
      'Banquet: a Cannibal + 5 Day characters (Villager, Cupid, Defender, Sister, Hunter or Cannibal), e.g. with 5 Villagers (11).',
  },
  every: {
    label: 'Every card scores (+ set bonuses)',
    cardsScore: true,
    dayMultiplier: 3,
    value: { villager: 0, seer: 1, werewolf: 2, witch: 2, cupid: 0, 'alpha-wolf': 3, defender: 'same', vampire: 4, sister: 1, hunter: 2, cannibal: 4 },
    combos: {
      mob: ['5 villagers', '8'], vision: ['seer + 3 tag:night distinct', '3'], hunt: ['werewolf + villager', '1'], potion: ['witch + villager + werewolf', '2'],
      lovers: ['cupid + 2 any', '2'], pack: ['alpha wolf + 2 werewolves', '3'], guard: ['defender + villager/seer/witch/sister/hunter', '2'],
      feast: ['vampire + 3 villagers', '4'], sisters: ['2 sisters', '2'], bullet: ['hunter + werewolf', '2'], banquet: ['cannibal + 5 villagers', '10'],
    },
    text: {
      villager: 'Mob: 5 Villagers (+8).', seer: 'Vision: a Seer + 3 different Night characters (+3).', werewolf: 'Dinner: a Werewolf + a Villager (+1).',
      witch: 'Potions: Witch + Villager + Werewolf (+2).', cupid: 'Lovers: Cupid + any 2 cards (+2).', 'alpha-wolf': 'Pack: Alpha Wolf + 2 Werewolves (+3).',
      defender: 'Defend: a Defender + a Villager, Seer, Witch, Sister or Hunter (+2).', vampire: 'Feast: a Vampire + 3 Villagers (+4).', sister: 'Sisters: a pair of Sisters (+2).',
      hunter: 'Hunt: a Hunter + a Werewolf (+2).', cannibal: 'Banquet: a Cannibal + 5 Villagers (+10).',
    },
    scoring:
      'Every card scores its value, in a set or not: triple in your Day sets, single in your Night sets. A set adds its bonus on top (multiplied the same way). Each card counts in one set only.\n' +
      'A lone Day card still scores, but another player can use it to complete a set and take it.\n' +
      'Night characters have a moon on the card: Seer, Witch, Werewolf, Vampire and Alpha Wolf. All the others are Day characters.\n' +
      'Card values: Villager 0, Cupid 0, Seer 1, Sister 1, Witch 2, Werewolf 2, Hunter 2, Alpha Wolf 3, Vampire 4, Cannibal 4; the Defender is worth the best card in its set (nothing alone).\n' +
      'Set bonuses: Mob (5 Villagers) +8; Vision (a Seer + 3 different Night characters) +3; Dinner (Werewolf + Villager) +1; Potions (Witch + Villager + Werewolf) +2; Lovers (Cupid + any 2 cards) +2; Pack (Alpha Wolf + 2 Werewolves) +3; Defend (Defender + Villager, Seer, Witch, Sister or Hunter) +2; Feast (Vampire + 3 Villagers) +4; Sisters (2 Sisters) +2; Hunt (Hunter + Werewolf) +2; Banquet (Cannibal + 5 Villagers) +10.',
  },
};

const WEREWOLF_TURN = {
  pick:
    'Setup: everyone gets 3 cards. Four cards are turned face up as the Day cards; the rest form the Night pile.\n' +
    'On your turn take two actions (the same one twice is fine):\n' +
    '1. Take one of the four Day cards into your hand - or, as the same action, play it straight to your Night sets (face down). The gap is refilled from the Night pile.\n' +
    '2. Play a card from your hand face up to your Day sets.\n' +
    '3. Play a card from your hand face down to your Night sets.\n' +
    "4. Steal: put cards from your hand into another player's Day sets so that, together with their lone cards, they complete a set - you take that whole set, face down, to your Night sets. Each card you put down is one action.\n" +
    'You never draw blind from the Night pile, and there is no swapping.\n' +
    'Your Day cards are grouped into sets automatically, leaving as few cards alone as possible (and, if there is a choice, the least valuable ones). Grouped sets are safe.\n' +
    'At the end of your turn you may hold at most 6 cards: discard any extra.',
  draw:
    'Setup: everyone gets 3 cards. Four cards are turned face up as the Day cards; the rest form the Night pile.\n' +
    'On your turn take two actions (the same one twice is fine):\n' +
    '1. Draw a card from the Night pile.\n' +
    '2. Swap a card from your hand for one of the Day cards (yours takes its place).\n' +
    '3. Play a card face up to your Day sets.\n' +
    '4. Play a card face down to your Night sets.\n' +
    "5. Steal: put cards from your hand into another player's Day sets so that, together with their lone cards, they complete a set - you take that whole set, face down, to your Night sets. Each card you put down is one action.\n" +
    'Your Day cards are grouped into sets automatically, leaving as few cards alone as possible (and, if there is a choice, the least valuable ones). Grouped sets are safe.\n' +
    'At the end of your turn you may hold at most 6 cards: discard any extra.',
};

const WEREWOLF_COMBOS = [
  ['mob', 'Mob'], ['vision', 'Vision'], ['hunt', 'Dinner'], ['potion', 'Potions'], ['lovers', 'Lovers'], ['pack', 'Pack'],
  ['guard', 'Defend'], ['feast', 'Feast'], ['sisters', 'Sisters'], ['bullet', 'Hunt'], ['banquet', 'Banquet'],
];

// The settings a scoring system changes, as variant paths for project p.
function werewolfScoringSet(p, sys) {
  const S = WEREWOLF_SCORING[sys];
  const set = {
    'automation.sets.cardsScore': S.cardsScore,
    'automation.sets.zones.0.multiplier': S.dayMultiplier,
    'rules.scoring': S.scoring,
  };
  p.cards.forEach((c, i) => {
    if (!(c.id in S.value)) return;
    set[`cards.${i}.stats.value`] = S.value[c.id];
    set[`cards.${i}.description`] = S.value[c.id] === 'same' ? 'Wild: worth the best card it is with' : `Value ${S.value[c.id]}`;
    set[`cards.${i}.rules`] = S.text[c.id];
  });
  p.automation.sets.combos.forEach((c, i) => {
    if (!S.combos[c.id]) return;
    set[`automation.sets.combos.${i}.pattern`] = S.combos[c.id][0];
    set[`automation.sets.combos.${i}.points`] = S.combos[c.id][1];
  });
  return set;
}

export function werewolfProject() {
  const p = blankProject('Weirdwolves');
  p.theme = 'werewolf';
  p.description = 'Pick village and werewolf cards from the four face-up Day cards and lay them as sets: face up by Day for more points (but others can finish lone cards and take them), or face down by Night, safe and secret. Two actions a turn; most points when the Night pile runs out wins.';
  p.players = { min: 3, max: 4, default: 4 };
  p.cardBack = { color: '#1f2540', image: 'img/weirdwolves/back.webp', label: 'NIGHT' };
  p.zones = [
    { id: 'nightpile', name: 'Night pile', scope: 'shared', layout: 'stack', faceUp: false, visibility: 'public' },
    { id: 'dayrow', name: 'Day cards', scope: 'shared', layout: 'spread', faceUp: true, visibility: 'public' },
    { id: 'discard', name: 'Discard pile', scope: 'shared', layout: 'stack', faceUp: true, visibility: 'public' },
    { id: 'hand', name: 'Hand', scope: 'player', layout: 'hand', faceUp: true, visibility: 'owner', builtin: true },
    { id: 'day', name: 'Day sets', scope: 'player', layout: 'spread', faceUp: true, visibility: 'public' },
    { id: 'night', name: 'Night sets', scope: 'player', layout: 'spread', faceUp: false, visibility: 'owner' },
  ];
  p.counters = [{ id: 'score', name: 'Points', start: 0 }];
  p.setup = [
    { op: 'shuffle', zone: 'nightpile' },
    { op: 'deal', from: 'nightpile', to: 'hand', count: 3 },
    { op: 'move', from: 'nightpile', to: 'dayrow', count: 4, faceUp: true },
  ];
  p.turn = { phases: [], drawAtStart: { count: 0, from: 'nightpile' }, firstPlayer: 'seat1', direction: 'clockwise' };
  p.automation = {
    ...defaultAutomation(),
    style: 'sets',
    enforce: 'strict',
    autoScore: true,
    sets: {
      ...defaultAutomation().sets,
      drawZone: 'nightpile',
      marketZone: 'dayrow',
      discardZone: 'discard',
      actions: 2,
      handLimit: 6,
      zones: [{ zone: 'day', multiplier: 2, secret: false }, { zone: 'night', multiplier: 1, secret: true }],
      giveZone: 'day',
      captureZone: 'night',
      combos: WEREWOLF_COMBOS.map(([id, label]) => ({ id, label, pattern: '', points: '' })),
      endWhenEmpty: 'round',
      arrange: 'auto',
      // Cards are picked only from the four face-up Day cards: into the hand,
      // or straight to the Night sets as the same action.
      draw: false,
      swap: false,
      takeTo: ['hand', 'night'],
    },
  };
  p.rules = {
    overview: 'A village by Day, a hunt by Night. Pick cards from the four face-up Day cards and lay them in front of you as sets: groups of cards that match the rule printed on a card.\nDay sets are laid face up and score more. Your Day cards group themselves into sets; finished sets are safe, but a card left on its own can be used by another player to complete a set - which they then take.\nNight sets are laid face down: they are safe, score single points and stay secret until the end.',
    objective: 'Have the most points when the Night pile runs out.',
    turnRules: WEREWOLF_TURN.pick,
    endGame: 'The Night pile refills the Day cards. When it runs out, play continues until everyone has had the same number of turns. Then the Night sets are revealed, and the highest total wins.',
    scoring: '',
    aiHints: 'A Day card left on its own can be taken by another player; a set you finish within one turn is never at risk - for example play a Werewolf and a Villager. Taking a Day card straight to your Night is safe and costs only one action. Look for steals that use two of your cards. Build big sets (Mob, Pack, Banquet) where they are safe. Watch other players\' lone Day cards for sets you can complete and take.',
  };
  const card = (id, name, icon, count, color) => ({
    ...blankCard(p), id, name, icon, count, color, description: '', rules: '', startZone: 'nightpile', stats: { value: 0 },
    tags: ['werewolf-sets', NIGHT_ROLES.includes(id) ? 'night' : 'day'],
  });
  p.cards = [
    card('villager', 'Villager', '🧑‍🌾', 34, '#efe4c8'),
    card('seer', 'Seer', '🔮', 5, '#c9b8ee'),
    card('werewolf', 'Werewolf', '🐺', 20, '#b08a6e'),
    card('witch', 'Witch', '🧙', 3, '#9cc58c'),
    card('cupid', 'Cupid', '💘', 3, '#f6c2d6'),
    card('alpha-wolf', 'Alpha Wolf', '🌕', 2, '#8c7a9e'),
    card('defender', 'Defender', '🛡️', 3, '#a9c7e3'),
    card('vampire', 'Vampire', '🧛', 4, '#d27a86'),
    card('sister', 'Sister', '👭', 4, '#f1c9a5'),
    card('hunter', 'Hunter', '🏹', 2, '#a9bf86'),
    card('cannibal', 'Cannibal', '🍖', 2, '#c98a5a'),
  ];
  // Finished card art (name, value and text are in the picture). The Cannibal has none yet.
  for (const id of ['villager', 'seer', 'werewolf', 'witch', 'cupid', 'alpha-wolf', 'defender', 'vampire', 'sister', 'hunter']) {
    const c = p.cards.find((x) => x.id === id);
    c.image = `img/weirdwolves/${id}.webp`;
    c.imageMode = 'card';
  }
  // The standard scoring, then the choices players get before a game.
  const scoring = { sets: werewolfScoringSet(p, 'sets'), every: werewolfScoringSet(p, 'every') };
  for (const [path, value] of Object.entries(scoring.sets)) setPath(p, path, value);
  p.variants = [
    { id: 'scoring', label: 'Scoring', description: 'Sets score: only sets count, so it is about making them safely (and easy to add up). Every card scores: lone cards count too, sets add a bonus.', default: 0, choices: [
      { label: WEREWOLF_SCORING.sets.label, set: scoring.sets },
      { label: WEREWOLF_SCORING.every.label, set: scoring.every },
    ] },
    { id: 'pickup', label: 'Picking up cards', description: 'Where your cards come from.', default: 0, choices: [
      { label: 'From the four Day cards (into your hand, or straight to Night)', set: { 'automation.sets.draw': false, 'automation.sets.swap': false, 'automation.sets.takeTo': ['hand', 'night'], 'rules.turnRules': WEREWOLF_TURN.pick } },
      { label: 'Draw from the Night pile, or swap with a Day card (old rules)', set: { 'automation.sets.draw': true, 'automation.sets.swap': true, 'automation.sets.takeTo': [], 'rules.turnRules': WEREWOLF_TURN.draw } },
    ] },
    { id: 'actions', label: 'Actions per turn', description: 'How many actions each player takes on their turn.', default: 0, choices: [
      { label: '2 actions (standard)', set: { 'automation.sets.actions': 2 } },
      { label: '3 actions (faster game)', set: { 'automation.sets.actions': 3 } },
    ] },
    { id: 'arrange', label: 'Day sets', description: 'How your face-up cards become sets.', default: 0, choices: [
      { label: 'Grouped automatically (fewest lone cards)', set: { 'automation.sets.arrange': 'auto' } },
      { label: 'Stack them yourself', set: { 'automation.sets.arrange': 'manual' } },
    ] },
    { id: 'end', label: 'When the Night pile runs out', description: 'How the game ends.', default: 0, choices: [
      { label: 'Finish the round (everyone gets equal turns)', set: { 'automation.sets.endWhenEmpty': 'round' } },
      { label: 'Stop after that turn', set: { 'automation.sets.endWhenEmpty': 'now' } },
    ] },
  ];
  return p;
}

// ------------------------------------------------------------------ player options (variants)
// A project can offer choices to players before a game, e.g. game length or a
// house rule. Each choice sets project settings by path, so any setting can be
// varied without code: 'automation.endWhen.0.expr': 'score >= 100'.

export function blankVariant() {
  return { id: uid('v'), label: 'New option', description: '', default: 0, choices: [{ label: 'Standard', set: {} }, { label: 'Alternative', set: {} }] };
}

function setPath(obj, path, value) {
  const keys = String(path).split('.').filter(Boolean);
  let o = obj;
  for (const [i, k] of keys.entries()) {
    const key = /^\d+$/.test(k) ? Number(k) : k;
    if (i === keys.length - 1) { o[key] = value; return; }
    if (o[key] == null || typeof o[key] !== 'object') o[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[key];
  }
}

export function getPath(obj, path) {
  return String(path).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[/^\d+$/.test(k) ? Number(k) : k]), obj);
}

// The project with the chosen options applied. picks: { variantId: choiceIndex }
export function applyVariants(project, picks = {}) {
  const p = JSON.parse(JSON.stringify(project));
  for (const v of project.variants || []) {
    const idx = Number.isInteger(picks[v.id]) ? picks[v.id] : (v.default || 0);
    const choice = v.choices?.[idx];
    for (const [path, value] of Object.entries(choice?.set || {})) setPath(p, path, value);
  }
  return p;
}

// "path = value" lines <-> { path: value } (values parsed as JSON when possible).
export function parseSetLines(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    try { v = JSON.parse(v); } catch { /* plain text */ }
    out[m[1]] = v;
  }
  return out;
}
export const formatSetLines = (set) => Object.entries(set || {}).map(([k, v]) => `${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
