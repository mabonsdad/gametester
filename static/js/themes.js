// Looks for the player view. A project picks one with project.theme (an id
// below); everything else about the game still comes from the project, so a
// theme only changes the presentation: a stylesheet (css/themes/<id>.css),
// opponent names and a few words.

export const THEMES = {
  '': {
    label: 'Classic (green felt)',
    logo: '🂡',
    opponents: [['Ava', '🦊'], ['Ben', '🐻'], ['Cai', '🦉'], ['Dot', '🐢'], ['Eli', '🐙']],
    feedTitle: 'What happened',
    start: 'Start game ▶',
    tagline: '',
    yourTurn: 'Your turn',
  },
  werewolf: {
    label: 'Werewolf village (moonlit night)',
    logo: '🐺',
    opponents: [['Old Mara', '🧓'], ['Tobin', '🧔'], ['Elsie', '👩‍🌾'], ['Constable Vey', '💂'], ['Brother Ash', '🧙‍♂️']],
    feedTitle: 'Village chronicle',
    start: 'Enter the village 🌕',
    tagline: 'The moon is rising over the village. Gather your folk by Day, hunt by Night - and keep what is yours.',
    yourTurn: 'Your move',
  },
};

export const themeOf = (project) => THEMES[project?.theme] ? { id: project.theme, ...THEMES[project.theme] } : { id: '', ...THEMES[''] };

// Load the theme's stylesheet and mark the page with it.
export function applyTheme(project) {
  const t = themeOf(project);
  document.body.classList.forEach((c) => { if (c.startsWith('theme-')) document.body.classList.remove(c); });
  document.getElementById('pv-theme-css')?.remove();
  if (t.id) {
    document.body.classList.add(`theme-${t.id}`);
    const link = document.createElement('link');
    link.id = 'pv-theme-css';
    link.rel = 'stylesheet';
    link.href = `css/themes/${t.id}.css`;
    document.head.append(link);
  }
  return t;
}
