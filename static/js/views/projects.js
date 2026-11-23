// Project list: create, open, duplicate, import/export, delete.
import * as api from '../api.js';
import { blankProject, normalizeProject, sampleProject, switchbackProject, uid, werewolfProject, whistProject } from '../model.js';
import { confirmDialog, download, field, fmtTime, h, modal, toast } from '../ui.js';

export async function renderProjects(root, ctx) {
  const list = h('div', { class: 'project-grid' });
  const page = h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, 'Projects'),
        h('p', { class: 'muted' }, 'Each project is one card game: its cards, its rules and setup, and its playtest sessions.')),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn', onclick: importProject }, 'Import JSON…'),
        h('button', { class: 'btn primary', onclick: newProject }, '+ New project'))),
    list);
  root.append(page);

  async function refresh() {
    const projects = await api.listProjects();
    list.replaceChildren();
    if (!projects.length) {
      list.append(h('div', { class: 'empty-card' },
        h('h3', {}, 'No projects yet'),
        h('p', {}, 'Start a blank game, or load a sample to see how the test bench works.'),
        h('div', { class: 'row gap wrap' },
          h('button', { class: 'btn', onclick: () => create(sampleProject()) }, 'Sample: Harbour Lights (free-form)'),
          h('button', { class: 'btn', onclick: () => create(whistProject()) }, 'Sample: Whist (automated rules)'),
          h('button', { class: 'btn', onclick: () => create(switchbackProject()) }, 'Sample: Switchback (shedding)'),
          h('button', { class: 'btn', onclick: () => create(werewolfProject()) }, 'Sample: werewolf_tricks (set collection)'),
          h('button', { class: 'btn primary', onclick: newProject }, '+ New project'))));
      return;
    }
    for (const p of projects) {
      list.append(h('article', { class: 'project-card' },
        h('a', { class: 'project-open', href: `#/p/${p.id}/cards` },
          h('h3', {}, p.name),
          h('p', { class: 'muted clamp' }, p.description || 'No description'),
          h('div', { class: 'meta' },
            h('span', {}, `${p.cardCount} card types`),
            p.players ? h('span', {}, `${p.players.min}-${p.players.max} players`) : null,
            h('span', {}, fmtTime(p.updated)))),
        h('div', { class: 'project-actions' },
          h('a', { class: 'btn small primary', href: `#/p/${p.id}/play` }, 'Playtest'),
          h('button', { class: 'btn small', onclick: () => duplicate(p.id) }, 'Duplicate'),
          h('button', { class: 'btn small', onclick: () => exportProject(p.id) }, 'Export'),
          h('button', { class: 'btn small danger', onclick: () => remove(p) }, 'Delete'))));
    }
  }

  async function create(project) {
    await api.saveProject(project);
    ctx.navigate(`#/p/${project.id}/cards`);
  }

  function newProject() {
    const name = h('input', { type: 'text', placeholder: 'e.g. Dragon Market', value: '' });
    const desc = h('textarea', { rows: 3, placeholder: 'One or two lines about the game idea' });
    const template = h('select', {},
      h('option', { value: 'blank' }, 'Blank: draw pile, discard, table, hands and a score counter'),
      h('option', { value: 'sample' }, 'Copy of the sample game (Harbour Lights)'),
      h('option', { value: 'whist' }, 'Classic Whist (trick-taking, legal moves and scoring automated)'),
      h('option', { value: 'switchback' }, 'Switchback (shedding: match colour or value, action cards, round scoring)'),
      h('option', { value: 'werewolf' }, 'werewolf_tricks (set collection: actions per turn, face-up market, best-combination scoring)'));
    modal('New project', h('div', { class: 'stack' },
      field('Name', name),
      field('Description', desc),
      field('Start from', template)), [
      { label: 'Cancel' },
      {
        label: 'Create', kind: 'primary', onClick: async () => {
          const p = { sample: sampleProject, whist: whistProject, switchback: switchbackProject, werewolf: werewolfProject }[template.value]?.() || blankProject();
          p.name = name.value.trim() || (template.value === 'blank' ? 'Untitled game' : p.name);
          if (desc.value.trim()) p.description = desc.value.trim();
          await create(p);
        },
      },
    ]);
  }

  async function duplicate(id) {
    const p = normalizeProject(await api.getProject(id));
    p.id = uid('p_');
    p.name += ' (copy)';
    p.created = Date.now();
    await api.saveProject(p);
    toast('Duplicated');
    refresh();
  }

  async function exportProject(id) {
    const p = await api.getProject(id);
    download(`${p.name.replace(/[^\w-]+/g, '_')}.cardgame.json`, JSON.stringify(p, null, 2));
  }

  function importProject() {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.onchange = async () => {
      try {
        const data = JSON.parse(await input.files[0].text());
        const p = normalizeProject(data);
        p.id = uid('p_');
        await api.saveProject(p);
        toast(`Imported "${p.name}"`);
        refresh();
      } catch (e) {
        toast('Import failed: ' + e.message, 'error');
      }
    };
    input.click();
  }

  async function remove(p) {
    if (!(await confirmDialog('Delete project', `Delete "${p.name}" and its saved sessions?`, 'Delete'))) return;
    await api.deleteProject(p.id);
    refresh();
  }

  await refresh();
}
