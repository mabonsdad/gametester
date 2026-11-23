// Storage + server access. Uses the Python server when it is reachable,
// otherwise falls back to the browser's localStorage (static hosting mode).

let mode = null;
let info = null;
// Share-link mode (player view opened from a link): calls go to the link's
// own restricted routes under api/play/<token>/ and need no login.
let share = null;
export const useShare = (token) => { share = token; };
export const shareToken = () => share;
const enc = encodeURIComponent;

export async function init() {
  try {
    const r = await fetch('api/health', { cache: 'no-store', credentials: 'same-origin' });
    const ctype = r.headers.get('Content-Type') || '';
    if (r.ok && ctype.includes('json')) {
      info = await r.json();
      if (info.ok) return (mode = 'server');
    }
  } catch { /* no server */ }
  return (mode = 'local');
}

export const getMode = () => mode;
export const serverInfo = () => info;
// True when the hosted app is password protected and this browser is not logged in.
export const needsLogin = () => mode === 'server' && info?.authRequired && !info?.authed;
export const canLogout = () => mode === 'server' && info?.authRequired && info?.authed;

async function call(method, url, body) {
  const r = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (r.status === 401 && !url.endsWith('api/login') && !share) {
    if (info) info.authed = false;
    window.dispatchEvent(new Event('gt-login-required'));
  }
  if (!r.ok) throw new Error(data?.error || `${method} ${url} failed (${r.status})`);
  return data;
}

export async function login(password) {
  await call('POST', 'api/login', { password });
  await init();
  return !needsLogin();
}

export async function logout() {
  await call('POST', 'api/logout', {});
  await init();
}

// ----------------------------------------------------------- localStorage
const LS = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {
      throw new Error('Browser storage is full or unavailable. Run the Python server for larger projects. (' + e.message + ')');
    }
  },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};
const pKey = (id) => `cgtb.project.${id}`;
const sIndexKey = (pid) => `cgtb.sessions.${pid}`;
const sKey = (pid, sid) => `cgtb.session.${pid}.${sid}`;

// ----------------------------------------------------------- projects
export async function listProjects() {
  if (mode === 'server') return call('GET', 'api/projects');
  return (LS.get('cgtb.projects', [])).map((id) => LS.get(pKey(id))).filter(Boolean).map((p) => ({
    id: p.id, name: p.name, description: p.description, updated: p.updated, cardCount: p.cards?.length || 0, players: p.players,
  })).sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

// Share mode: returns { project, share: { label, providers } }.
export async function getSharedGame() {
  return call('GET', `api/play/${enc(share)}`);
}

export async function getProject(id) {
  if (mode === 'server') return call('GET', `api/projects/${encodeURIComponent(id)}`);
  const p = LS.get(pKey(id));
  if (!p) throw new Error('Project not found');
  return p;
}

export async function saveProject(project) {
  if (mode === 'server') return call('PUT', `api/projects/${encodeURIComponent(project.id)}`, project);
  project.updated = Date.now();
  LS.set(pKey(project.id), project);
  const idx = LS.get('cgtb.projects', []);
  if (!idx.includes(project.id)) { idx.push(project.id); LS.set('cgtb.projects', idx); }
  return project;
}

export async function deleteProject(id) {
  if (mode === 'server') return call('DELETE', `api/projects/${encodeURIComponent(id)}`);
  LS.del(pKey(id));
  LS.set('cgtb.projects', LS.get('cgtb.projects', []).filter((x) => x !== id));
  for (const s of LS.get(sIndexKey(id), [])) LS.del(sKey(id, s));
  LS.del(sIndexKey(id));
}

// Returns a URL to use as the card image. With the server the file is
// stored on disk; without it the (already downscaled) data URL is used.
export async function uploadImage(projectId, dataUrl, name) {
  if (mode === 'server') return (await call('POST', `api/projects/${encodeURIComponent(projectId)}/images`, { dataUrl, name })).url;
  return dataUrl;
}

// ----------------------------------------------------------- sessions
export async function listSessions(pid) {
  if (mode === 'server') return call('GET', `api/projects/${encodeURIComponent(pid)}/sessions`);
  return LS.get(sIndexKey(pid), []).map((sid) => LS.get(sKey(pid, sid))).filter(Boolean).map((s) => ({
    id: s.id, name: s.name, updated: s.updated, turn: s.state?.turn?.number,
    players: s.state?.players?.map((p) => p.name), status: s.state?.status,
  })).sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

export async function getSession(pid, sid) {
  if (mode === 'server') return call('GET', `api/projects/${encodeURIComponent(pid)}/sessions/${encodeURIComponent(sid)}`);
  const s = LS.get(sKey(pid, sid));
  if (!s) throw new Error('Session not found');
  return s;
}

export async function saveSession(pid, session) {
  if (share) return call('PUT', `api/play/${enc(share)}/sessions/${enc(session.id)}`, session);
  if (mode === 'server') return call('PUT', `api/projects/${encodeURIComponent(pid)}/sessions/${encodeURIComponent(session.id)}`, session);
  session.updated = Date.now();
  LS.set(sKey(pid, session.id), session);
  const idx = LS.get(sIndexKey(pid), []);
  if (!idx.includes(session.id)) { idx.push(session.id); LS.set(sIndexKey(pid), idx); }
  return { id: session.id, updated: session.updated };
}

export async function deleteSession(pid, sid) {
  if (mode === 'server') return call('DELETE', `api/projects/${encodeURIComponent(pid)}/sessions/${encodeURIComponent(sid)}`);
  LS.del(sKey(pid, sid));
  LS.set(sIndexKey(pid), LS.get(sIndexKey(pid), []).filter((x) => x !== sid));
}

// ----------------------------------------------------------- AI jobs
// provider: 'anthropic' | 'openai' | 'bridge'. The server answers at once
// with a job id; poll jobGet() until status is answered / error / cancelled.
export async function jobCreate(provider, prompt, meta) {
  if (mode !== 'server') throw new Error('Hosted AI seats need the server (python3 server.py, or the AWS deployment).');
  return call('POST', share ? `api/play/${enc(share)}/ai/jobs` : 'api/ai/jobs', { provider, prompt, meta });
}

export const jobGet = (id) => call('GET', share ? `api/play/${enc(share)}/ai/jobs/${enc(id)}` : `api/ai/jobs/${enc(id)}`);
export const jobCancel = (id) => call('DELETE', share ? `api/play/${enc(share)}/ai/jobs/${enc(id)}` : `api/ai/jobs/${enc(id)}`);

// ----------------------------------------------------------- share links (tester)
export const listShares = (pid) => call('GET', `api/projects/${enc(pid)}/shares`);
export const createShare = (pid, body) => call('POST', `api/projects/${enc(pid)}/shares`, body);
export const revokeShare = (pid, token) => call('DELETE', `api/projects/${enc(pid)}/shares/${enc(token)}`);
