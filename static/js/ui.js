// Small DOM helpers and the shared card renderer.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
      }
    } else if (k === 'value') value = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  if (value !== undefined) el.value = value;
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function debounce(fn, ms = 400) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.flush = (...args) => { clearTimeout(t); return fn(...args); };
  return d;
}

export function toast(msg, kind = 'info', ms = 3200) {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}` }, msg);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

// Modal dialog. buttons: [{label, kind, onClick(close) -> false to keep open}]
export function modal(title, body, buttons = [{ label: 'Close' }], { wide = false } = {}) {
  const close = () => overlay.remove();
  const overlay = h('div', { class: 'modal-overlay', onmousedown: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-label': title },
      h('header', {}, h('h2', {}, title), h('button', { class: 'icon-btn', title: 'Close', onclick: close }, '✕')),
      h('div', { class: 'modal-body' }, body),
      h('footer', {}, buttons.map((b) => h('button', {
        class: `btn ${b.kind || ''}`,
        onclick: async () => { if ((await b.onClick?.(close)) !== false) close(); },
      }, b.label))),
    ));
  document.body.append(overlay);
  overlay.querySelector('input,textarea,select')?.focus();
  return { close, el: overlay };
}

export function confirmDialog(title, text, okLabel = 'OK') {
  return new Promise((resolve) => {
    modal(title, h('p', {}, text), [
      { label: 'Cancel', onClick: () => resolve(false) },
      { label: okLabel, kind: 'primary', onClick: () => resolve(true) },
    ]);
  });
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
}

export function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// Downscale an image file and return a data URL (keeps projects small).
export function readImageFile(file, maxSide = 700) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Not an image'));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const png = file.type === 'image/png' || file.type === 'image/gif';
        resolve(c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.86));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export function download(filename, text, type = 'application/json') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Pick a readable text colour for a background.
function inkFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#1d1d1d';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.55 ? '#1d1d1d' : '#fbfbf8';
}

const cssUrl = (u) => `url("${String(u).replace(/"/g, '%22')}")`;

// Render a card face from its definition.
export function cardFace(def, { size, extraClass = '' } = {}) {
  const style = { '--card-bg': def.color || '#f4efe3', '--card-ink': inkFor(def.color) };
  if (size) style['--cw'] = size + 'px';
  if (def.image && def.imageMode === 'full') {
    return h('div', { class: `card face full-art ${extraClass}`, style: { ...style, backgroundImage: cssUrl(def.image) }, title: def.name },
      h('div', { class: 'card-title overlay' }, def.name));
  }
  if ((def.tags || []).includes('playing-card') && !def.image) {
    const suit = def.stats?.suit;
    const red = suit === 'Hearts' || suit === 'Diamonds';
    const symbol = { Spades: '♠', Hearts: '♥', Diamonds: '♦', Clubs: '♣' }[suit] || '★';
    const index = def.name.replace(/[♠♥♦♣]/g, '');
    return h('div', { class: `card face playing ${red ? 'red' : ''} ${extraClass}`, style, title: def.description || def.name },
      h('div', { class: 'pc-corner' }, h('b', {}, index), h('span', {}, symbol)),
      h('div', { class: 'pc-pip' }, symbol),
      h('div', { class: 'pc-corner bottom' }, h('b', {}, index), h('span', {}, symbol)));
  }
  if ((def.tags || []).includes('colour-card') && !def.image) {
    const v = String(def.stats?.value ?? def.name);
    const big = { skip: '⊘', reverse: '⇄', wild: '★', 'wild+4': '+4' }[v] || v;
    const wild = String(def.stats?.colour) === 'Wild';
    return h('div', { class: `card face colourcard ${wild ? 'wild' : ''} ${extraClass}`, style, title: `${def.name} - ${def.description || ''}` },
      h('div', { class: 'cc-corner' }, big),
      h('div', { class: 'cc-oval' }, big),
      h('div', { class: 'cc-name' }, def.name),
      h('div', { class: 'cc-corner bottom' }, big));
  }
  const stats = Object.entries(def.stats || {});
  return h('div', { class: `card face ${extraClass}`, style, title: def.name },
    h('div', { class: 'card-title' }, def.name || 'Untitled'),
    def.image ? h('div', { class: 'card-art', style: { backgroundImage: cssUrl(def.image) } }) : def.icon ? h('div', { class: 'card-icon' }, def.icon) : null,
    def.description ? h('div', { class: 'card-sub' }, def.description) : null,
    def.rules ? h('div', { class: 'card-rules' }, def.rules) : null,
    stats.length ? h('div', { class: 'card-stats' }, stats.map(([k, v]) => h('span', {}, h('b', { title: /^(same|wild|copy|match)$/i.test(String(v)) ? 'wild: worth the best card it is with' : null }, /^(same|wild|copy|match)$/i.test(String(v)) ? '★' : v), ' ', k))) : null,
  );
}

export function cardBack(project, { size, extraClass = '' } = {}) {
  const b = project.cardBack || {};
  const style = { '--back': b.color || '#2d4f7c', '--card-ink': inkFor(b.color) };
  if (size) style['--cw'] = size + 'px';
  if (b.image) style.backgroundImage = cssUrl(b.image);
  return h('div', { class: `card back ${b.image ? 'has-image' : ''} ${extraClass}`, style },
    !b.image ? h('div', { class: 'back-label' }, b.label || project.name || '') : null);
}
