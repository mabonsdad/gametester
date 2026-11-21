// Card designer: list of card types + editor with live preview.
import * as api from '../api.js';
import { blankCard, standardDeck, uid } from '../model.js';
import { cardBack, cardFace, confirmDialog, field, h, modal, readImageFile, toast } from '../ui.js';

export async function renderCards(root, ctx) {
  const project = ctx.project;
  let selectedId = project.cards[0]?.id || null;
  let filter = '';

  const listEl = h('div', { class: 'card-list' });
  const editorEl = h('div', { class: 'card-editor' });
  const totalEl = h('span', { class: 'muted' });
  const search = h('input', { type: 'search', placeholder: 'Filter cards…', oninput: () => { filter = search.value.toLowerCase(); drawList(); } });

  root.append(h('div', { class: 'designer' },
    h('section', { class: 'designer-list' },
      h('div', { class: 'list-head' },
        h('h2', {}, 'Cards'), totalEl,
        h('div', { class: 'row gap wrap' },
          h('button', { class: 'btn primary small', onclick: addCard }, '+ New card'),
          h('button', { class: 'btn small', onclick: quickAdd }, 'Quick add list…'),
          h('button', { class: 'btn small', onclick: addStandardDeck, title: '52 playing cards with suit and rank stats' }, 'Standard deck…'),
          h('button', { class: 'btn small', onclick: editBack }, 'Card back…'))),
      search,
      listEl),
    editorEl));

  const findCard = () => project.cards.find((c) => c.id === selectedId);

  function drawList() {
    const total = project.cards.reduce((n, c) => n + (parseInt(c.count, 10) || 0), 0);
    totalEl.textContent = `${project.cards.length} types · ${total} cards in the game`;
    listEl.replaceChildren();
    const shown = project.cards.filter((c) => !filter || `${c.name} ${c.description} ${c.rules} ${(c.tags || []).join(' ')}`.toLowerCase().includes(filter));
    if (!project.cards.length) listEl.append(h('p', { class: 'muted pad' }, 'No cards yet. Add one, or paste a list with "Quick add list".'));
    for (const c of shown) {
      listEl.append(h('button', {
        class: `card-thumb ${c.id === selectedId ? 'selected' : ''}`,
        onclick: () => { selectedId = c.id; drawList(); drawEditor(); },
      }, cardFace(c, { size: 92 }), h('span', { class: 'thumb-count' }, `×${c.count ?? 1}`)));
    }
  }

  function drawEditor() {
    const c = findCard();
    editorEl.replaceChildren();
    if (!c) {
      editorEl.append(h('div', { class: 'empty' }, h('p', {}, 'Select a card or create a new one.')));
      return;
    }
    const preview = h('div', { class: 'preview-box' });
    const redraw = () => {
      preview.replaceChildren(cardFace(c, { size: 240 }));
      const thumb = listEl.querySelector('.card-thumb.selected');
      if (thumb) thumb.replaceChildren(cardFace(c, { size: 92 }), h('span', { class: 'thumb-count' }, `×${c.count ?? 1}`));
    };
    const update = (fn) => (e) => { fn(e.target); redraw(); ctx.changed(); };

    const sharedZones = project.zones.filter((z) => z.scope === 'shared');
    const statsText = Object.entries(c.stats || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
    const imgInput = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    imgInput.onchange = async () => {
      const file = imgInput.files[0];
      if (!file) return;
      try {
        const dataUrl = await readImageFile(file);
        c.image = await api.uploadImage(project.id, dataUrl, file.name);
        redraw(); ctx.changed(); drawEditor();
      } catch (e) { toast('Image failed: ' + e.message, 'error'); }
    };

    editorEl.append(
      h('div', { class: 'editor-head' },
        h('h2', {}, 'Edit card'),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn small', onclick: () => duplicateCard(c) }, 'Duplicate'),
          h('button', { class: 'btn small danger', onclick: () => deleteCard(c) }, 'Delete'))),
      h('div', { class: 'editor-body' },
        h('div', { class: 'editor-form' },
          field('Title', h('input', { type: 'text', value: c.name, oninput: update((t) => { c.name = t.value; }) })),
          field('Description / type line', h('input', { type: 'text', value: c.description || '', placeholder: 'e.g. Creature - Dragon, or flavour text', oninput: update((t) => { c.description = t.value; }) })),
          field('Rules of play for this card', h('textarea', { rows: 5, value: c.rules || '', placeholder: 'What happens when this card is played, and any restrictions. Plain English: the AI players read this.', oninput: update((t) => { c.rules = t.value; }) })),
          h('div', { class: 'grid-2' },
            field('Copies in game', h('input', { type: 'number', min: 0, max: 200, value: c.count ?? 1, oninput: update((t) => { c.count = Math.max(0, parseInt(t.value, 10) || 0); }) })),
            field('Starts in', h('select', { value: c.startZone, onchange: update((t) => { c.startZone = t.value; }) },
              sharedZones.map((z) => h('option', { value: z.id }, z.name))))),
          h('div', { class: 'grid-2' },
            field('Card colour', h('input', { type: 'color', value: c.color || '#f4efe3', oninput: update((t) => { c.color = t.value; }) })),
            field('Tags', h('input', { type: 'text', value: (c.tags || []).join(', '), placeholder: 'comma separated', oninput: update((t) => { c.tags = t.value.split(',').map((s) => s.trim()).filter(Boolean); }) }))),
          field('Stats (one per line, name: value)', h('textarea', {
            rows: 3, value: statsText, placeholder: 'cost: 3\npower: 2',
            oninput: update((t) => {
              c.stats = {};
              for (const line of t.value.split('\n')) {
                const m = line.match(/^\s*([^:=]+?)\s*[:=]\s*(.+?)\s*$/);
                if (m) c.stats[m[1]] = isFinite(m[2]) ? Number(m[2]) : m[2];
              }
            }),
          })),
          h('fieldset', { class: 'image-set' },
            h('legend', {}, 'Image'),
            h('div', { class: 'row gap wrap' },
              h('button', { class: 'btn small', onclick: () => imgInput.click() }, c.image ? 'Replace image…' : 'Import image…'),
              c.image ? h('button', { class: 'btn small', onclick: () => { c.image = null; ctx.changed(); drawEditor(); redraw(); } }, 'Remove image') : null,
              imgInput),
            h('div', { class: 'radio-row' },
              ['art', 'full'].map((m) => h('label', {},
                h('input', { type: 'radio', name: 'imgmode', checked: (c.imageMode || 'art') === m, onchange: () => { c.imageMode = m; redraw(); ctx.changed(); } }),
                m === 'art' ? ' Picture in a frame, with title and text' : ' Image is the whole card face'))))),
        preview));
    redraw();
  }

  function addCard() {
    const c = blankCard(project);
    c.name = `Card ${project.cards.length + 1}`;
    project.cards.push(c);
    selectedId = c.id;
    ctx.changed(); drawList(); drawEditor();
    editorEl.querySelector('input')?.select();
  }

  function duplicateCard(c) {
    const copy = { ...structuredClone(c), id: uid('k_'), name: c.name + ' (copy)' };
    project.cards.splice(project.cards.indexOf(c) + 1, 0, copy);
    selectedId = copy.id;
    ctx.changed(); drawList(); drawEditor();
  }

  async function deleteCard(c) {
    if (!(await confirmDialog('Delete card', `Delete "${c.name}"?`, 'Delete'))) return;
    const i = project.cards.indexOf(c);
    project.cards.splice(i, 1);
    selectedId = project.cards[Math.min(i, project.cards.length - 1)]?.id || null;
    ctx.changed(); drawList(); drawEditor();
  }

  function quickAdd() {
    const ta = h('textarea', { rows: 10, placeholder: 'Fireball | 2 | Deal 3 damage to any player\nShield | 3 | Block the next attack against you\nGold coin | 10' });
    modal('Quick add cards', h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'One card per line: Title | copies | rules text | description. Only the title is required.'),
      ta), [
      { label: 'Cancel' },
      {
        label: 'Add cards', kind: 'primary', onClick: () => {
          let n = 0;
          for (const line of ta.value.split('\n')) {
            const [name, count, rules, description] = line.split('|').map((s) => s?.trim());
            if (!name) continue;
            const c = blankCard(project);
            Object.assign(c, { name, count: parseInt(count, 10) || 1, rules: rules || '', description: description || '' });
            project.cards.push(c);
            selectedId = c.id;
            n++;
          }
          if (n) { ctx.changed(); drawList(); drawEditor(); toast(`Added ${n} card type(s)`); }
        },
      },
    ]);
  }

  function addStandardDeck() {
    const aceLow = h('input', { type: 'checkbox' });
    const jokers = h('input', { type: 'number', min: 0, max: 4, value: 0 });
    modal('Add a standard deck', h('div', { class: 'stack' },
      h('p', { class: 'muted' }, '52 cards (A♠ … 2♣) with stats "suit" (Spades/Hearts/Diamonds/Clubs) and "rank" (2-14, ace high), ready for trick-taking rules.'),
      h('label', { class: 'inline' }, aceLow, ' Aces low (rank 1)'),
      field('Jokers', jokers)), [
      { label: 'Cancel' },
      {
        label: 'Add 52 cards', kind: 'primary', onClick: () => {
          const existing = new Set(project.cards.map((c) => c.id));
          const cards = standardDeck(project, { aceLow: aceLow.checked, jokers: parseInt(jokers.value, 10) || 0 })
            .map((c) => (existing.has(c.id) ? { ...c, id: uid('k_') } : c));
          project.cards.push(...cards);
          selectedId = cards[0]?.id || selectedId;
          ctx.changed(); drawList(); drawEditor();
          toast(`Added ${cards.length} card types`);
        },
      },
    ]);
  }

  function editBack() {
    const b = project.cardBack;
    const preview = h('div', { class: 'preview-box small' });
    const redraw = () => preview.replaceChildren(cardBack(project, { size: 150 }));
    const fileIn = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    fileIn.onchange = async () => {
      try {
        b.image = await api.uploadImage(project.id, await readImageFile(fileIn.files[0]), fileIn.files[0].name);
        redraw(); ctx.changed();
      } catch (e) { toast(e.message, 'error'); }
    };
    modal('Card back', h('div', { class: 'row gap top' },
      h('div', { class: 'stack grow' },
        field('Colour', h('input', { type: 'color', value: b.color, oninput: (e) => { b.color = e.target.value; redraw(); ctx.changed(); } })),
        field('Label', h('input', { type: 'text', value: b.label || '', placeholder: project.name, oninput: (e) => { b.label = e.target.value; redraw(); ctx.changed(); } })),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn small', onclick: () => fileIn.click() }, 'Image…'),
          h('button', { class: 'btn small', onclick: () => { b.image = null; redraw(); ctx.changed(); } }, 'No image'), fileIn)),
      preview), [{ label: 'Done', kind: 'primary' }]);
    redraw();
  }

  drawList();
  drawEditor();
}
