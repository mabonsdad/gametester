// App shell: hash router, header, and project loading/saving.
import * as api from './api.js';
import { normalizeProject } from './model.js';
import { clear, debounce, h, toast } from './ui.js';
import { renderProjects } from './views/projects.js';
import { renderCards } from './views/cards.js';
import { renderRules } from './views/rules.js';
import { renderPlay } from './views/play.js';
import { showReloadBar, watchVersion } from './version.js';

const root = document.getElementById('app');
const header = document.getElementById('header');
let project = null;
let dispose = null;
let saveState = 'saved';

const saveNow = async () => {
  const p = project; // the user may navigate away while this is saving
  if (!p) return;
  setSaveState('saving');
  try {
    const saved = await api.saveProject(p);
    p.updated = saved?.updated ?? p.updated;
    setSaveState('saved');
  } catch (e) {
    setSaveState('error');
    toast('Save failed: ' + e.message, 'error', 6000);
  }
};
const saveSoon = debounce(saveNow, 600);

function setSaveState(s) {
  saveState = s;
  const el = document.getElementById('save-state');
  if (el) {
    el.textContent = { saved: 'Saved', saving: 'Saving…', pending: 'Unsaved changes', error: 'Save failed' }[s];
    el.className = `save-state ${s}`;
  }
}

const ctx = {
  get project() { return project; },
  // Views call this after mutating ctx.project.
  changed() { setSaveState('pending'); saveSoon(); },
  saveNow: () => saveSoon.flush(),
  navigate(hash) { location.hash = hash; },
};

window.addEventListener('beforeunload', (e) => {
  if (saveState === 'pending' || saveState === 'saving') { saveSoon.flush(); e.preventDefault(); }
});

function renderHeader(tab) {
  clear(header);
  const modeBadge = api.getMode() === 'server'
    ? h('span', { class: 'badge ok', title: 'Projects are saved on the server' }, 'Server storage')
    : h('span', { class: 'badge warn', title: 'No server found: projects are saved in this browser only. Run server.py for shared storage and AI APIs.' }, 'Browser storage');
  header.append(
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, '♠'), 'Card Game Test Bench'),
    project ? h('nav', { class: 'tabs' },
      h('span', { class: 'proj-name', title: project.name }, project.name),
      [['cards', 'Cards'], ['rules', 'Rules & setup'], ['play', 'Playtest']].map(([id, label]) =>
        h('a', { href: `#/p/${project.id}/${id}`, class: tab === id ? 'active' : '' }, label)),
      h('a', { href: `play.html#p=${project.id}`, target: '_blank', rel: 'noopener', class: 'player-link', title: 'Play this game as a player would (opens a new tab). Games are saved as sessions.' }, 'Player view ↗'),
    ) : h('nav', { class: 'tabs' }),
    h('div', { class: 'header-right' },
      project ? h('span', { id: 'save-state', class: `save-state ${saveState}` }, 'Saved') : null,
      modeBadge,
      api.canLogout() ? h('button', { class: 'btn small', onclick: async () => { await api.logout(); project = null; route(); } }, 'Log out') : null),
  );
}

async function route() {
  if (dispose) { try { dispose(); } catch { /* ignore */ } dispose = null; }
  saveSoon.flush();
  if (api.needsLogin()) return renderLogin();
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    if (parts[0] === 'p' && parts[1]) {
      if (!project || project.id !== parts[1]) {
        project = normalizeProject(await api.getProject(parts[1]));
        saveState = 'saved';
      }
      const tab = parts[2] || 'cards';
      renderHeader(tab);
      clear(root);
      const view = { cards: renderCards, rules: renderRules, play: renderPlay }[tab] || renderCards;
      dispose = await view(root, ctx, parts.slice(3));
    } else {
      project = null;
      renderHeader();
      clear(root);
      dispose = await renderProjects(root, ctx);
    }
  } catch (e) {
    console.error(e);
    clear(root).append(h('div', { class: 'empty' }, h('h2', {}, 'Something went wrong'), h('p', {}, e.message), h('a', { class: 'btn', href: '#/' }, 'Back to projects')));
  }
}

function renderLogin() {
  project = null;
  renderHeader();
  const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password' });
  const msg = h('p', { class: 'muted small' });
  const submit = async (e) => {
    e.preventDefault();
    msg.textContent = 'Checking…';
    try {
      if (await api.login(pw.value)) route();
      else msg.textContent = 'Login failed.';
    } catch (err) { msg.textContent = err.message; pw.select(); }
  };
  clear(root).append(h('div', { class: 'page' },
    h('form', { class: 'panel login-box', onsubmit: submit },
      h('h1', {}, 'Card Game Test Bench'),
      h('p', { class: 'muted' }, 'This test bench is private. Enter the password to continue.'),
      pw,
      h('button', { class: 'btn primary', type: 'submit' }, 'Log in'),
      msg)));
  pw.focus();
}

window.addEventListener('gt-login-required', () => { if (api.needsLogin()) renderLogin(); });
window.addEventListener('hashchange', route);
await api.init();
route();
watchVersion(() => showReloadBar('A new version of the test bench has been published - reload to use it (your work is saved).'));
