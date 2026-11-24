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
  sets: 'Set collection: lay sets ("tricks") in front of you; a few actions per turn; best combination scores',
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


// ------------------------------------------------------------------ werewolf_tricks
// Set collection with a werewolf theme: lay tricks face up (Day, double
// points, but others can finish them and take them) or face down (Night,
// safe and secret).
export function werewolfProject() {
  const p = blankProject('werewolf_tricks');
  p.theme = 'werewolf';
  p.description = 'Collect village and werewolf cards and lay them as tricks: face up by Day for double points (but others can finish and steal them), or face down by Night, safe and secret. Two actions a turn; most points when the Night pile runs out wins.';
  p.players = { min: 3, max: 4, default: 4 };
  p.cardBack = { color: '#1f2540', image: null, label: 'NIGHT' };
  p.zones = [
    { id: 'nightpile', name: 'Night pile', scope: 'shared', layout: 'stack', faceUp: false, visibility: 'public' },
    { id: 'dayrow', name: 'Day cards', scope: 'shared', layout: 'spread', faceUp: true, visibility: 'public' },
    { id: 'discard', name: 'Discard pile', scope: 'shared', layout: 'stack', faceUp: true, visibility: 'public' },
    { id: 'hand', name: 'Hand', scope: 'player', layout: 'hand', faceUp: true, visibility: 'owner', builtin: true },
    { id: 'day', name: 'Day tricks', scope: 'player', layout: 'spread', faceUp: true, visibility: 'public' },
    { id: 'night', name: 'Night tricks', scope: 'player', layout: 'spread', faceUp: false, visibility: 'owner' },
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
      combos: [
        { id: 'mob', label: 'Mob', pattern: '5 villagers', points: '' },
        { id: 'vision', label: 'Vision', pattern: 'seer + 3 any distinct', points: '' },
        { id: 'hunt', label: 'Hunt', pattern: 'werewolf + villager', points: '' },
        { id: 'potion', label: 'Potion', pattern: 'witch + villager + werewolf', points: '' },
        { id: 'lovers', label: 'Lovers', pattern: 'cupid + 2 any', points: '' },
        { id: 'pack', label: 'Pack', pattern: 'alpha wolf + 2 werewolves', points: '' },
        { id: 'guard', label: 'Guard', pattern: 'defender + villager/seer/witch', points: '' },
        { id: 'feast', label: 'Feast', pattern: 'vampire + 3 villagers', points: '' },
      ],
      endWhenEmpty: 'round',
      arrange: 'auto',
    },
  };
  p.rules = {
    overview: 'A village by Day, a hunt by Night. Collect cards and lay them in front of you as tricks: sets that match the rule printed on a card.\nDay tricks are laid face up and score double. Your Day cards group themselves into tricks; finished tricks are safe, but a card left on its own can be used by another player to complete a trick - which they then take.\nNight tricks are laid face down: they are safe, score single points and stay secret until the end.',
    objective: 'Have the most points when the Night pile runs out.',
    turnRules:
      'Setup: everyone gets 3 cards. Four cards are turned face up as the Day cards; the rest form the Night pile.\n' +
      'On your turn take two actions (the same one twice is fine):\n' +
      '1. Draw a card from the Night pile.\n' +
      '2. Swap a card from your hand for one of the Day cards (yours takes its place).\n' +
      '3. Play a card face up to your Day tricks.\n' +
      '4. Play a card face down to your Night tricks.\n' +
      "5. Steal: put cards from your hand into another player's Day tricks so that, together with their lone cards, they complete a trick - you take that whole trick, face down, to your Night tricks. Each card you put down is one action (e.g. two Villagers next to their Vampire and Villager make a Feast: two actions).\n" +
      'Your Day cards are grouped into tricks automatically, leaving as few cards alone as possible (and, if there is a choice, the least valuable ones). Grouped tricks are safe.\n' +
      'At the end of your turn you may hold at most 6 cards: discard any extra.',
    endGame: 'When the Night pile runs out, play continues until everyone has had the same number of turns. Then the Night tricks are revealed, and the highest total wins.',
    scoring:
      "Only cards in a trick score. A trick is worth the sum of its cards' values - doubled in your Day tricks, single in your Night tricks. Each card counts in one trick only. Night tricks are arranged for the most points; Day tricks for the fewest lone cards.\n" +
      'Mob: 5 Villagers (5).\n' +
      'Vision: a Seer + 3 different cards, e.g. Seer, Witch, Villager, Werewolf (9) or Seer, Seer, Werewolf, Cupid (7).\n' +
      'Hunt: a Werewolf + 1 Villager (4).\n' +
      'Potion: a Witch + a Villager + a Werewolf (7).\n' +
      'Lovers: Cupid + any 2 cards (the two cards\' values).\n' +
      'Pack: the Alpha Wolf + 2 Werewolves (10).\n' +
      'Guard: a Defender + a Villager, Seer or Witch (2, 4 or 6).\n' +
      'The Defender is wild: in any trick it is worth as much as the most valuable other card it is with, so its worth depends on what it is grouped with.\n' +
      'Feast: a Vampire + 3 Villagers (8).',
    aiHints: 'A Day card left on its own can be stolen; a trick you finish within one turn is never at risk and scores double - for example play a Werewolf and a Villager. Look for steals that use two of your cards. Build big tricks (Mob, Feast) face down in the Night. Watch other players\' loose Day cards for tricks you can complete and take. Swap for Day cards that complete a trick.',
  };
  const card = (id, name, icon, value, count, color, description, rules) => ({
    ...blankCard(p), id, name, icon, count, color, description, rules, startZone: 'nightpile', stats: { value }, tags: ['werewolf-tricks'],
  });
  p.cards = [
    card('villager', 'Villager', '🧑‍🌾', 1, 48, '#efe4c8', 'Value 1', 'Mob: 5 Villagers.'),
    card('seer', 'Seer', '🔮', 2, 3, '#c9b8ee', 'Value 2', 'Vision: a Seer + 3 different cards.'),
    card('werewolf', 'Werewolf', '🐺', 3, 16, '#b08a6e', 'Value 3', 'Hunt: a Werewolf + 1 lone Villager.'),
    card('witch', 'Witch', '🧙', 3, 3, '#9cc58c', 'Value 3', 'Potion: Witch + Villager (saved) + Werewolf (killed).'),
    card('cupid', 'Cupid', '💘', 0, 3, '#f6c2d6', 'Value 0', 'Lovers: Cupid + any 2 cards.'),
    card('alpha-wolf', 'Alpha Wolf', '🌕', 4, 1, '#8c7a9e', 'Value 4', 'Pack: Alpha Wolf + 2 Werewolves.'),
    card('defender', 'Defender', '🛡️', 'same', 3, '#a9c7e3', 'Wild: worth the best card it is with', 'Guard: a Defender + a Villager, Seer or Witch.'),
    card('vampire', 'Vampire', '🧛', 5, 4, '#d27a86', 'Value 5', 'Feast: a Vampire + 3 Villagers.'),
  ];
  p.variants = [
    { id: 'actions', label: 'Actions per turn', description: 'How many actions each player takes on their turn.', default: 0, choices: [
      { label: '2 actions (standard)', set: { 'automation.sets.actions': 2 } },
      { label: '3 actions (faster game)', set: { 'automation.sets.actions': 3 } },
    ] },
    { id: 'daymult', label: 'Day tricks score', description: 'The reward for risking a face-up trick.', default: 0, choices: [
      { label: 'Double', set: { 'automation.sets.zones.0.multiplier': 2 } },
      { label: 'Triple', set: { 'automation.sets.zones.0.multiplier': 3 } },
    ] },
    { id: 'arrange', label: 'Day tricks', description: 'How your face-up cards become tricks.', default: 0, choices: [
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
