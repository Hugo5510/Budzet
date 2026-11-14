// Synchronizacja między urządzeniami przez prywatne repozytorium GitHub (Contents API).
// Brak serwera: aplikacja sama czyta/zapisuje jeden plik JSON w Twoim repo.
export const SYNC_STORES = ['entries', 'categories', 'subscriptions', 'debts'];
export const FILE = 'budzet-dane.json';
const API = 'https://api.github.com';
const TOMB_KEEP_MS = 180 * 24 * 3600 * 1000;

export class SyncError extends Error {
  constructor(message, code = '') {
    super(message);
    this.code = code;
  }
}

// JSON z posortowanymi kluczami — do porównywania zawartości niezależnie od kolejności pól.
export function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export const tkey = (store, id) => `${store}:${id}`;

// Scalanie dwóch migawek: nowszy updatedAt wygrywa, kasowania (tombstones) mają pierwszeństwo
// nad starszymi wersjami rekordu. Wynik nie zależy od kolejności argumentów.
export function mergeSnapshots(a = {}, b = {}, now = Date.now()) {
  const tombs = {};
  for (const src of [a.tombs || {}, b.tombs || {}]) {
    for (const [k, ts] of Object.entries(src)) tombs[k] = Math.max(tombs[k] || 0, ts);
  }
  for (const [k, ts] of Object.entries(tombs)) if (now - ts > TOMB_KEEP_MS) delete tombs[k];
  const out = { tombs };
  for (const store of SYNC_STORES) {
    const map = new Map();
    for (const rec of [...(a[store] || []), ...(b[store] || [])]) {
      const cur = map.get(rec.id);
      if (!cur) { map.set(rec.id, rec); continue; }
      const ua = cur.updatedAt || 0, ub = rec.updatedAt || 0;
      let win = ub > ua ? rec : ua > ub ? cur : stable(rec) > stable(cur) ? rec : cur;
      if (store === 'subscriptions') {
        const lastRun = [cur.lastRun, rec.lastRun].filter(Boolean).sort().pop() || '';
        win = { ...win, lastRun };
      }
      map.set(rec.id, win);
    }
    out[store] = [...map.values()]
      .filter((r) => {
        const t = tombs[tkey(store, r.id)];
        return !(t && t >= (r.updatedAt || 0));
      })
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  }
  return out;
}

export const core = (s = {}) => ({
  tombs: s.tombs || {},
  ...Object.fromEntries(SYNC_STORES.map((k) => [k, s[k] || []])),
});

// ---------------------------------------------------------------- GitHub API
export function b64enc(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function b64dec(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function gh(token, path, opts = {}) {
  try {
    return await fetch(API + path, {
      ...opts,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
    });
  } catch {
    throw new SyncError('Brak połączenia z GitHubem.', 'network');
  }
}

function fail(res) {
  if (res.status === 401) throw new SyncError('Token jest nieprawidłowy lub wygasł. Utwórz nowy i wklej go w Ustawieniach.', 'auth');
  if (res.status === 403) throw new SyncError('Brak uprawnień lub limit zapytań. Token musi mieć dostęp „Contents: Read and write” do tego repozytorium.', 'forbidden');
  throw new SyncError(`Błąd GitHuba (${res.status}).`, 'http' + res.status);
}

// Zwraca { sha, data } albo null, gdy pliku jeszcze nie ma w repo.
export async function pull({ token, repo }) {
  const res = await gh(token, `/repos/${repo}/contents/${FILE}`);
  if (res.status === 404) {
    const r2 = await gh(token, `/repos/${repo}`);
    if (r2.ok) return null;
    if (r2.status === 401) fail(r2);
    throw new SyncError(`Nie znaleziono repozytorium „${repo}” albo token nie ma do niego dostępu. Sprawdź nazwę (login/repo) i uprawnienia tokena.`, 'norepo');
  }
  if (!res.ok) fail(res);
  const j = await res.json();
  let text;
  if (j.encoding === 'base64' && j.content) text = b64dec(j.content);
  else {
    const raw = await gh(token, `/repos/${repo}/contents/${FILE}`, { headers: { Accept: 'application/vnd.github.raw+json' } });
    if (!raw.ok) fail(raw);
    text = await raw.text();
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new SyncError('Plik danych w repozytorium jest uszkodzony.', 'corrupt'); }
  if (data?.app !== 'budzet-sync') throw new SyncError('Plik budzet-dane.json w repozytorium nie jest z tej aplikacji.', 'corrupt');
  return { sha: j.sha, data };
}

export async function push({ token, repo, sha, snapshot }) {
  const body = {
    message: `Synchronizacja ${new Date().toISOString()}`,
    content: b64enc(JSON.stringify(snapshot)),
    ...(sha ? { sha } : {}),
  };
  const res = await gh(token, `/repos/${repo}/contents/${FILE}`, { method: 'PUT', body: JSON.stringify(body) });
  if (res.status === 409 || res.status === 422) throw new SyncError('Konflikt zapisu, ponawiam.', 'conflict');
  if (!res.ok) fail(res);
  return (await res.json())?.content?.sha;
}
