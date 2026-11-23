// Notices when a newer version of the app has been deployed while a page is
// open (the open page keeps running the code it loaded). The deploy writes
// version.json; locally there is none and nothing happens.
let loaded = null;
let lastCheck = 0;
let told = false;

async function current() {
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()).version || null;
  } catch {
    return null;
  }
}

export async function watchVersion(onNew) {
  loaded = await current();
  if (!loaded) return;
  const check = async () => {
    if (told || Date.now() - lastCheck < 60_000) return;
    lastCheck = Date.now();
    const v = await current();
    if (v && v !== loaded) { told = true; onNew(); }
  };
  setInterval(check, 5 * 60_000);
  window.addEventListener('hashchange', check);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
}

// A bar at the top of the page asking for a reload.
export function showReloadBar(text = 'A new version of the app is available.') {
  if (document.querySelector('.reload-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'reload-bar';
  bar.append(text + ' ');
  const btn = document.createElement('button');
  btn.className = 'btn small primary';
  btn.textContent = 'Reload now';
  btn.onclick = () => location.reload();
  bar.append(btn);
  document.body.prepend(bar);
}
