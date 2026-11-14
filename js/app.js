import * as db from './db.js';
import {
  uid, esc, fmt, parseAmount, amountToInput, today, addDays, parseISO, isValidISO,
  getPeriod, dayHeader, fmtDate, MON_NOM, subscriptionDueDates, pctChange,
} from './util.js';
import { DEFAULT_CATEGORIES, makeDemo } from './demo.js';
import { resizeImage, scanReceipt, DEFAULT_MODEL } from './receipt.js';
import { donut, bars } from './charts.js';
import { mergeSnapshots, stable, core, pull, push, SyncError } from './sync.js';

const APP_VERSION = '1.2.0';

// ---------------------------------------------------------------- stan
const S = { entries: [], categories: [], subs: [], debts: [], settings: {} };
const UI = {
  tab: 'expenses',
  stats: { kind: 'month', offset: 0 },
  f: { q: '', cat: '', from: '', to: '', type: '' },
  showFilters: false,
  debtView: 'active',
  limit: 150,
};
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

async function upsert(store, arr, obj) {
  obj.updatedAt = Date.now(); // potrzebne do synchronizacji (nowsza wersja wygrywa)
  const i = arr.findIndex((x) => x.id === obj.id);
  if (i >= 0) arr[i] = obj;
  else arr.push(obj);
  await db.put(store, obj);
  scheduleSync();
}
async function removeFrom(store, arr, id) {
  const i = arr.findIndex((x) => x.id === id);
  if (i >= 0) arr.splice(i, 1);
  await db.del(store, id);
  await addTomb(store, id);
  scheduleSync();
}
async function addTomb(store, id) {
  await setSetting('tombs', { ...(S.settings.tombs || {}), [`${store}:${id}`]: Date.now() });
}
const saveEntry = (e) => upsert('entries', S.entries, e);
const saveDebt = (d) => upsert('debts', S.debts, d);
const saveSub = (s) => upsert('subscriptions', S.subs, s);
const saveCat = (c) => upsert('categories', S.categories, c);
async function setSetting(key, value) {
  S.settings[key] = value;
  await db.put('settings', { key, value });
}

const cats = () => [...S.categories].sort((a, b) => a.order - b.order);
const visibleCats = () => cats().filter((c) => !c.hidden);
const UNKNOWN = { id: '', name: 'Bez kategorii', icon: '❔', color: '#9ca3af', subs: [] };
const INCOME = { id: '', name: 'Przychód', icon: '💰', color: '#16a34a', subs: [] };
const cat = (id) => S.categories.find((c) => c.id === id) || UNKNOWN;
const sumAmt = (arr) => arr.reduce((s, e) => s + e.amount, 0);
const entriesIn = (p, type) => S.entries.filter((e) => e.type === type && e.date >= p.start && e.date <= p.end);
// Zwroty od osób za wydatki ("ktoś mi to odda") liczą się do bilansu w dniu spłaty
const refundsIn = (p) => S.debts
  .filter((d) => d.kind === 'expense' && d.dir === 'in')
  .reduce((s, d) => s + d.payments.filter((x) => x.date >= p.start && x.date <= p.end).reduce((a, x) => a + x.amount, 0), 0);
const paid = (d) => d.payments.reduce((s, p) => s + p.amount, 0);
const balance = (d) => d.amount - paid(d);
const subMonthly = (s) => (s.cycle === 'year' ? Math.round(s.amount / 12) : s.amount);
const byDateDesc = (a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0);
const people = () => [...new Set(S.debts.map((d) => d.person.trim()))].sort((a, b) => a.localeCompare(b, 'pl'));

// ---------------------------------------------------------------- start
async function load() {
  const [entries, categories, subs, debts, settings] = await Promise.all(
    ['entries', 'categories', 'subscriptions', 'debts', 'settings'].map((s) => db.all(s))
  );
  Object.assign(S, { entries, categories, subs, debts });
  S.settings = Object.fromEntries(settings.map((x) => [x.key, x.value]));
}

async function init() {
  try {
    await load();
    if (!S.settings.initialized) {
      await db.putMany('categories', DEFAULT_CATEGORIES);
      S.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
      await loadDemo(false);
      await setSetting('initialized', true);
    }
    await migrateTutoringIncome();
    await runSubscriptions();
  } catch (e) {
    console.error(e);
    toast('Błąd bazy danych: ' + e.message);
  }
  render();
  updateOnline();
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (await runSubscriptions()) render();
    scheduleSync(300);
  });
  scheduleSync(300);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW', e));
  }
}

// v1.0.1: spłaty korków to zwroty, nie przychody — usuń wcześniej utworzone wpisy przychodów
async function migrateTutoringIncome() {
  if (S.settings.migTutoring) return;
  const linked = S.entries.filter((e) => e.type === 'income' && e.debtId);
  for (const e of linked) await removeFrom('entries', S.entries, e.id);
  for (const d of S.debts) {
    if (d.payments.some((p) => p.entryId)) {
      d.payments.forEach((p) => delete p.entryId);
      await saveDebt(d);
    }
  }
  await setSetting('migTutoring', true);
}

async function runSubscriptions() {
  const t = today();
  let added = 0;
  for (const sub of S.subs) {
    if (!sub.active) continue;
    const dates = subscriptionDueDates(sub, t);
    for (const date of dates) {
      // stałe id: dwa urządzenia nie zdublują tego samego pobrania
      const id = `s_${sub.id}_${date}`;
      if (S.entries.some((e) => e.id === id) || (S.settings.tombs || {})[`entries:${id}`]) continue;
      await saveEntry({
        id, type: 'expense', amount: sub.amount, categoryId: sub.categoryId, date,
        desc: sub.name, sub: '', subscriptionId: sub.id, createdAt: Date.now(), demo: !!sub.demo,
      });
      added++;
    }
    if (sub.lastRun !== t) {
      sub.lastRun = t;
      await db.put('subscriptions', sub); // lokalnie, bez zmiany updatedAt
    }
  }
  return added;
}

async function loadDemo(rerender = true) {
  const d = makeDemo(today());
  await db.putMany('entries', d.entries);
  await db.putMany('subscriptions', d.subs);
  await db.putMany('debts', d.debts);
  S.entries.push(...d.entries);
  S.subs.push(...d.subs);
  S.debts.push(...d.debts);
  await setSetting('demoActive', true);
  await runSubscriptions();
  if (rerender) render();
}

async function clearDemo() {
  const e = S.entries.filter((x) => x.demo), s = S.subs.filter((x) => x.demo), d = S.debts.filter((x) => x.demo);
  await db.delMany('entries', e.map((x) => x.id));
  await db.delMany('subscriptions', s.map((x) => x.id));
  await db.delMany('debts', d.map((x) => x.id));
  S.entries = S.entries.filter((x) => !x.demo);
  S.subs = S.subs.filter((x) => !x.demo);
  S.debts = S.debts.filter((x) => !x.demo);
  await setSetting('demoActive', false);
}

// ---------------------------------------------------------------- Synchronizacja (GitHub)
// Ustawienia tylko lokalne (nie trafiają do kopii JSON ani na GitHub):
const EXPORT_SKIP = ['apiKey', 'ghToken', 'ghRepo', 'lastSync', 'syncError', 'tombs'];
const KEEP_LOCAL = [...EXPORT_SKIP, 'model', 'migTutoring'];
const syncOn = () => !!(S.settings.ghToken && S.settings.ghRepo);
let syncing = false, syncQueued = false, syncTimer;

function scheduleSync(delay = 2500) {
  if (!syncOn()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), delay);
}

function localSnapshot() {
  const stripLocal = ({ receiptId, ...rest }) => rest; // zdjęcia paragonów zostają na urządzeniu
  return {
    app: 'budzet-sync', v: 1,
    entries: S.entries.filter((x) => !x.demo).map(stripLocal),
    categories: S.categories,
    subscriptions: S.subs.filter((x) => !x.demo),
    debts: S.debts.filter((x) => !x.demo),
    tombs: S.settings.tombs || {},
  };
}

// Zapisuje wynik scalania w lokalnej bazie. Zwraca true, jeśli coś się zmieniło.
async function applyMerged(merged) {
  let changed = false;
  const stores = { entries: S.entries, categories: S.categories, subscriptions: S.subs, debts: S.debts };
  for (const [store, arr] of Object.entries(stores)) {
    const keep = new Set(merged[store].map((r) => r.id));
    const del = arr.filter((r) => !r.demo && !keep.has(r.id)).map((r) => r.id);
    const byId = new Map(arr.map((r) => [r.id, r]));
    const put = [];
    for (const r of merged[store]) {
      const cur = byId.get(r.id);
      const next = store === 'entries' && cur?.receiptId ? { ...r, receiptId: cur.receiptId } : r;
      if (!cur || stable(cur) !== stable(next)) put.push(next);
    }
    if (del.length) await db.delMany(store, del);
    if (put.length) await db.putMany(store, put);
    if (del.length || put.length) changed = true;
  }
  if (stable(merged.tombs) !== stable(S.settings.tombs || {})) await db.put('settings', { key: 'tombs', value: merged.tombs });
  if (changed) await load();
  else S.settings.tombs = merged.tombs;
  return changed;
}

function setSyncBadge(state) {
  const b = $('#sync-badge');
  if (!b) return;
  b.hidden = !state;
  b.className = 'badge sync' + (state === 'err' ? ' err' : '');
  b.textContent = state === 'err' ? 'błąd sync' : 'sync…';
}

function syncStatusHTML() {
  const st = S.settings;
  if (st.syncError) return `<div class="banner warn">⚠️ ${esc(st.syncError)}</div>`;
  if (st.lastSync) return `<div class="banner ok">✓ Ostatnia synchronizacja: ${esc(new Date(st.lastSync).toLocaleString('pl-PL'))}</div>`;
  return '<div class="banner">Jeszcze nie synchronizowano.</div>';
}

async function syncNow({ manual = false } = {}) {
  if (!syncOn()) return;
  if (syncing) { syncQueued = true; return; }
  if (!navigator.onLine) { if (manual) toast('Brak internetu — zsynchronizuję po powrocie sieci'); return; }
  syncing = true;
  setSyncBadge('sync');
  const cfg = { token: S.settings.ghToken, repo: S.settings.ghRepo };
  let changed = false, error = null;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await pull(cfg);
      const merged = mergeSnapshots(localSnapshot(), remote?.data || {});
      if (await applyMerged(merged)) changed = true;
      if (remote && stable(core(remote.data)) === stable(core(merged))) break;
      try {
        await push({ ...cfg, sha: remote?.sha, snapshot: { app: 'budzet-sync', v: 1, updatedAt: Date.now(), ...merged } });
        break;
      } catch (e) {
        if (e.code === 'conflict' && attempt < 3) continue;
        throw e;
      }
    }
    await setSetting('lastSync', Date.now());
    await setSetting('syncError', '');
  } catch (e) {
    error = e;
    if (e.code !== 'network') await setSetting('syncError', e.message || 'Błąd synchronizacji');
    console.warn('sync', e);
  } finally {
    syncing = false;
  }
  setSyncBadge(error && error.code !== 'network' ? 'err' : '');
  const el = $('#sync-status');
  if (el) el.innerHTML = syncStatusHTML();
  if (changed) render();
  if (manual) toast(error ? error.message : changed ? 'Zsynchronizowano — pobrano zmiany' : 'Zsynchronizowano');
  if (syncQueued) { syncQueued = false; scheduleSync(500); }
  return !error;
}

function syncCard() {
  const on = syncOn();
  return `<section class="card">
    <h3>☁️ Synchronizacja (GitHub)</h3>
    ${on ? `<div id="sync-status">${syncStatusHTML()}</div>` : '<p class="hint">Te same dane na telefonie i komputerze. Dane trafiają do Twojego <b>prywatnego</b> repozytorium na GitHubie. Zdjęcia paragonów zostają na urządzeniu, a odczytane z nich pozycje się synchronizują. Dane demo nie są synchronizowane.</p>'}
    <label>Repozytorium (login/nazwa)<input id="gh-repo" value="${esc(S.settings.ghRepo || '')}" placeholder="hugo5510/budzet-dane" autocapitalize="off" autocomplete="off" spellcheck="false"></label>
    <label>Token GitHub<div class="inline"><input type="password" id="gh-token" value="${esc(S.settings.ghToken || '')}" placeholder="github_pat_…" autocomplete="off" spellcheck="false"><button class="icon-btn" data-act="toggleGh" aria-label="Pokaż token">👁</button></div></label>
    <div class="row-btns">
      <button class="btn primary" data-act="saveSync">${on ? 'Zapisz i synchronizuj' : 'Połącz i synchronizuj'}</button>
      ${on ? '<button class="btn ghost" data-act="syncNow">Synchronizuj teraz</button>' : ''}
    </div>
    ${on ? '<button class="btn ghost wide" data-act="stopSync">Wyłącz synchronizację na tym urządzeniu</button>' : ''}
    <details class="more"><summary>Jak to skonfigurować</summary>
      <ol class="steps">
        <li>Na github.com utwórz <b>prywatne</b> repozytorium, np. <code>budzet-dane</code> (zaznacz „Add a README file”).</li>
        <li>Wejdź na github.com/settings/personal-access-tokens/new → <i>Repository access: Only select repositories</i> → wybierz to repo → <i>Permissions → Contents: Read and write</i> → utwórz token i skopiuj go.</li>
        <li>Wpisz tutaj nazwę repo i token. Powtórz na drugim urządzeniu (to samo repo, ten sam token).</li>
      </ol>
      <p class="hint">Token jest zapisany tylko na tym urządzeniu, tak jak klucz API. Nie trafia do kopii JSON. Jeśli wyciekł, usuń go w ustawieniach GitHuba.</p>
    </details>
  </section>`;
}

// ---------------------------------------------------------------- UI: wspólne
const TITLES = { expenses: 'Wydatki', stats: 'Statystyki', debts: 'Długi', settings: 'Ustawienia' };
function render() {
  $('#title').textContent = TITLES[UI.tab];
  $$('.tabbar [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === UI.tab));
  const views = { expenses: viewExpenses, stats: viewStats, debts: viewDebts, settings: viewSettings };
  $('#view').innerHTML = views[UI.tab]();
  if (UI.tab === 'expenses') renderList();
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

let sheetOpen = false, ignorePop = false;
function openSheet(html, { full = false } = {}) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="backdrop" data-act="closeSheet"></div>
    <div class="sheet ${full ? 'full' : ''}" role="dialog" aria-modal="true">
      <div class="sheet-head"><span class="grab"></span><button class="icon-btn close" data-act="closeSheet" aria-label="Zamknij">✕</button></div>
      <div class="sheet-body">${html}</div>
    </div>`;
  root.classList.add('open');
  document.body.classList.add('noscroll');
  if (!sheetOpen) {
    history.pushState({ sheet: true }, '');
    sheetOpen = true;
  }
  return root.querySelector('.sheet');
}
function hideSheet() {
  sheetOpen = false;
  const root = $('#sheet-root');
  root.classList.remove('open');
  root.innerHTML = '';
  document.body.classList.remove('noscroll');
}
function closeSheet() {
  if (!sheetOpen) return;
  hideSheet();
  if (history.state && history.state.sheet) {
    ignorePop = true;
    history.back();
  }
}
window.addEventListener('popstate', () => {
  if (ignorePop) { ignorePop = false; return; }
  if (sheetOpen) hideSheet();
});

function updateOnline() {
  $('#offline-badge').hidden = navigator.onLine;
}
window.addEventListener('online', () => { updateOnline(); scheduleSync(500); });
window.addEventListener('offline', updateOnline);

const catIcon = (c) => `<span class="ico" style="--c:${esc(c.color)}">${esc(c.icon)}</span>`;

function entryRow(e) {
  const inc = e.type === 'income';
  const c = inc ? INCOME : cat(e.categoryId);
  const meta = [inc ? 'Przychód' : c.name, e.sub, e.receiptId ? '🧾' : '', e.subscriptionId ? '🔁' : '', e.debtId ? '🎓' : '', e.owedDebtId ? '↩️ do zwrotu' : '']
    .filter(Boolean).join(' · ');
  return `<button class="row" data-act="editEntry" data-id="${e.id}">
    ${catIcon(c)}
    <span class="row-main"><span class="row-title">${esc(e.desc || c.name)}</span><span class="row-sub">${esc(meta)}</span></span>
    <span class="row-amt ${inc ? 'pos' : ''}">${inc ? '+' : '−'}${fmt(e.amount)}</span>
  </button>`;
}

function groupedList(list, ref = today()) {
  const groups = new Map();
  list.forEach((e) => {
    if (!groups.has(e.date)) groups.set(e.date, []);
    groups.get(e.date).push(e);
  });
  return [...groups]
    .map(([date, items]) => {
      const out = sumAmt(items.filter((x) => x.type === 'expense'));
      return `<div class="day"><div class="day-head"><span>${esc(dayHeader(date, ref))}</span><span>${out ? '−' + fmt(out) : ''}</span></div>
        <div class="card list-card">${items.map(entryRow).join('')}</div></div>`;
    })
    .join('');
}

// ---------------------------------------------------------------- Wydatki
function viewExpenses() {
  const m = getPeriod('month', 0);
  const out = sumAmt(entriesIn(m, 'expense')), inc = sumAmt(entriesIn(m, 'income')) + refundsIn(m);
  const bal = inc - out;
  const subsSum = S.subs.filter((s) => s.active).reduce((a, s) => a + subMonthly(s), 0);
  const f = UI.f;
  const fActive = f.cat || f.from || f.to || f.type;
  return `
    ${S.settings.demoActive ? `<div class="banner">Widzisz przykładowe dane demo. <button class="link" data-act="clearDemo">Wyczyść demo</button></div>` : ''}
    <section class="card summary">
      <div class="summary-title">${esc(m.label)}</div>
      <div class="grid3">
        <div><small>Wydatki</small><b>${fmt(out)}</b></div>
        <div><small>Przychody</small><b class="pos">${fmt(inc)}</b></div>
        <div><small>Bilans</small><b class="${bal >= 0 ? 'pos' : 'neg'}">${fmt(bal, { sign: true })}</b></div>
      </div>
    </section>
    <div class="chips">
      <button class="chip" data-act="openKorki">🎓 Korki</button>
      <button class="chip" data-act="openSubs">🔁 Subskrypcje · ${fmt(subsSum)}/mies.</button>
      <button class="chip" data-act="addIncome">💰 Przychód</button>
    </div>
    <div class="searchbar">
      <input type="search" id="q" placeholder="Szukaj w opisach, kategoriach, kwotach…" value="${esc(f.q)}" autocomplete="off">
      <button class="icon-btn ${UI.showFilters || fActive ? 'on' : ''}" data-act="toggleFilters" aria-label="Filtry">
        <svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 5h18l-7 8v6l-4 2v-8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
      </button>
    </div>
    ${UI.showFilters ? `<div class="card filters">
      <label>Kategoria<select id="f-cat"><option value="">Wszystkie</option>${cats().map((c) => `<option value="${c.id}" ${f.cat === c.id ? 'selected' : ''}>${esc(c.icon + ' ' + c.name)}</option>`).join('')}</select></label>
      <label>Typ<select id="f-type"><option value="">Wszystko</option><option value="expense" ${f.type === 'expense' ? 'selected' : ''}>Wydatki</option><option value="income" ${f.type === 'income' ? 'selected' : ''}>Przychody</option></select></label>
      <div class="two"><label>Od<input type="date" id="f-from" value="${f.from}"></label><label>Do<input type="date" id="f-to" value="${f.to}"></label></div>
      <button class="btn ghost" data-act="resetFilters">Wyczyść filtry</button>
    </div>` : ''}
    <div id="exp-list"></div>`;
}

function filtered() {
  const f = UI.f, q = f.q.trim().toLowerCase();
  return S.entries
    .filter((e) => {
      if (f.type && e.type !== f.type) return false;
      if (f.cat && e.categoryId !== f.cat) return false;
      if (f.from && e.date < f.from) return false;
      if (f.to && e.date > f.to) return false;
      if (q) {
        const c = e.type === 'income' ? INCOME : cat(e.categoryId);
        const hay = [e.desc, e.sub, c.name, amountToInput(e.amount), (e.items || []).map((i) => i.name).join(' ')].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort(byDateDesc);
}

function renderList() {
  const el = $('#exp-list');
  if (!el) return;
  const list = filtered();
  const f = UI.f;
  const active = f.q || f.cat || f.from || f.to || f.type;
  if (!list.length) {
    el.innerHTML = `<div class="empty">${active ? 'Brak wpisów dla wybranych filtrów.' : 'Brak wydatków. Dodaj pierwszy przyciskiem „+”.'}</div>`;
    return;
  }
  const head = active
    ? `<div class="found">Znaleziono: ${list.length} · wydatki ${fmt(sumAmt(list.filter((e) => e.type === 'expense')))}</div>`
    : '';
  el.innerHTML = head + groupedList(list.slice(0, UI.limit)) +
    (list.length > UI.limit ? `<button class="btn ghost wide" data-act="more">Pokaż więcej (${list.length - UI.limit})</button>` : '');
}

// ---- formularz wpisu (wydatek / przychód)
let pendingPhoto = null;
function openEntrySheet(entry = null, preset = {}, photoBlob = null) {
  pendingPhoto = photoBlob;
  const e = entry ? { ...entry } : { type: 'expense', amount: null, categoryId: '', date: today(), desc: '', sub: '', ...preset };
  const list = visibleCats();
  if (e.categoryId && !list.find((c) => c.id === e.categoryId) && S.categories.find((c) => c.id === e.categoryId)) list.push(cat(e.categoryId));
  const subs = cat(e.categoryId).subs || [];
  const linked = !!e.debtId;
  const debt = e.owedDebtId ? S.debts.find((d) => d.id === e.owedDebtId) : null;
  const sheet = openSheet(`
    <form data-form="entry" class="entry-form ${e.type === 'income' ? 'is-income' : ''}" novalidate>
      <input type="hidden" name="id" value="${e.id || ''}">
      <input type="hidden" name="categoryId" value="${e.categoryId || ''}">
      <div class="seg">
        <label><input type="radio" name="type" value="expense" ${e.type !== 'income' ? 'checked' : ''} ${linked ? 'disabled' : ''}><span>Wydatek</span></label>
        <label><input type="radio" name="type" value="income" ${e.type === 'income' ? 'checked' : ''} ${linked ? 'disabled' : ''}><span>Przychód</span></label>
      </div>
      <div class="amount-wrap"><input name="amount" class="amount-input" inputmode="decimal" enterkeyhint="done" autocomplete="off" placeholder="0,00" value="${amountToInput(e.amount)}" aria-label="Kwota" ${linked ? 'readonly' : ''}><span>zł</span></div>
      ${linked ? `<p class="hint">Wpis powiązany ze spłatą długu (${esc(e.desc)}). Kwotę zmienisz w zakładce Długi.</p>` : ''}
      <div class="cat-grid expense-only">
        ${list.map((c) => `<button type="button" class="cat-btn ${c.id === e.categoryId ? 'sel' : ''}" data-act="pickCat" data-id="${c.id}" style="--c:${esc(c.color)}"><span class="ico">${esc(c.icon)}</span><span class="cat-name">${esc(c.name)}</span></button>`).join('')}
      </div>
      <label class="check expense-only"><input type="checkbox" name="owed" ${debt ? 'checked' : ''}> ↩️ Ktoś mi to odda (dług)</label>
      <div class="owed-box expense-only" ${debt ? '' : 'hidden'}>
        <label>Kto jest winny<input name="owedPerson" list="people" value="${esc(debt?.person || '')}" autocomplete="off" placeholder="np. Kasia"></label>
        <datalist id="people">${people().map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
        <div class="two">
          <label>Kwota do zwrotu (zł)<input name="owedAmount" inputmode="decimal" value="${debt ? amountToInput(debt.amount) : ''}" placeholder="cała kwota" autocomplete="off"></label>
          <label>Termin (opcjonalnie)<input type="date" name="owedDue" value="${esc(debt?.due || '')}"></label>
        </div>
        <p class="hint">Cała kwota wydatku liczy się w statystykach. Zwrot od tej osoby nie jest przychodem.</p>
      </div>
      <details class="more" ${entry ? 'open' : ''}>
        <summary>Data, opis, podkategoria, zdjęcie</summary>
        <div class="two">
          <label>Data<input type="date" name="date" value="${e.date}" required></label>
          <label class="expense-only">Podkategoria<input name="sub" list="sublist" value="${esc(e.sub || '')}" autocomplete="off"></label>
        </div>
        <datalist id="sublist">${subs.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
        <label>Opis<input name="desc" value="${esc(e.desc || '')}" placeholder="${e.type === 'income' ? 'np. Wypłata' : 'np. Biedronka'}" autocomplete="off"></label>
        <label class="expense-only file-label">Zdjęcie paragonu<input type="file" name="photo" accept="image/*"></label>
        <div class="receipt-preview">${photoBlob ? '<p class="hint">📎 Zdjęcie paragonu zostanie zapisane z wydatkiem.</p>' : ''}</div>
        ${e.items?.length ? `<div class="items-ro"><b>Pozycje z paragonu</b>${e.items.map((i) => `<div><span>${esc(i.name)}</span><span>${fmt(i.price)}</span></div>`).join('')}</div>` : ''}
      </details>
      <div class="row-btns">
        ${entry ? `<button type="button" class="btn danger" data-act="deleteEntry" data-id="${e.id}">Usuń</button>` : ''}
        <button class="btn primary big" type="submit">Zapisz</button>
      </div>
    </form>`);
  const form = sheet.querySelector('form');
  form.addEventListener('change', (ev) => {
    if (ev.target.name === 'type') form.classList.toggle('is-income', ev.target.value === 'income');
    if (ev.target.name === 'owed') {
      form.querySelector('.owed-box').hidden = !ev.target.checked;
      if (ev.target.checked) form.owedPerson.focus();
    }
  });
  if (e.receiptId) showReceiptPreview(e.receiptId, sheet.querySelector('.receipt-preview'));
  if (!entry) form.amount.focus();
}

async function showReceiptPreview(id, el) {
  const r = await db.get('receipts', id);
  if (!r || !el) return;
  const url = URL.createObjectURL(r.blob);
  el.innerHTML = `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Zdjęcie paragonu" class="receipt-img"></a>`;
}

async function storeReceipt(blob, date) {
  const id = uid();
  await db.put('receipts', { id, blob, date, createdAt: Date.now() });
  return id;
}

async function maybeDeleteReceipt(receiptId) {
  if (receiptId && !S.entries.some((x) => x.receiptId === receiptId)) await db.del('receipts', receiptId);
}

const FORMS = {};
FORMS.entry = async (f) => {
  const id = f.id.value;
  const old = id ? S.entries.find((x) => x.id === id) : null;
  const type = old?.debtId ? 'income' : f.type.value;
  const amount = parseAmount(f.amount.value);
  if (!(amount > 0)) {
    f.amount.classList.add('err');
    f.amount.focus();
    return toast('Podaj kwotę większą od zera');
  }
  const categoryId = type === 'expense' ? f.categoryId.value : null;
  if (type === 'expense' && !categoryId) {
    f.querySelector('.cat-grid').classList.add('err');
    return toast('Wybierz kategorię');
  }
  const date = isValidISO(f.date.value) ? f.date.value : today();
  // dług powiązany z wydatkiem („ktoś mi to odda”)
  const owed = type === 'expense' && !!f.owed?.checked;
  const oldDebt = old?.owedDebtId ? S.debts.find((d) => d.id === old.owedDebtId) : null;
  let owedPerson = '', owedAmount = 0;
  if (owed) {
    owedPerson = f.owedPerson.value.trim();
    owedAmount = f.owedAmount.value.trim() ? parseAmount(f.owedAmount.value) : amount;
    if (!owedPerson) { f.owedPerson.classList.add('err'); f.owedPerson.focus(); return toast('Podaj, kto jest Ci winien'); }
    if (!(owedAmount > 0)) { f.owedAmount.classList.add('err'); return toast('Podaj poprawną kwotę do zwrotu'); }
    if (owedAmount > amount) { f.owedAmount.classList.add('err'); return toast('Kwota do zwrotu nie może być większa niż wydatek'); }
    if (oldDebt && owedAmount < paid(oldDebt)) return toast(`Kwota do zwrotu nie może być mniejsza niż już oddane (${fmt(paid(oldDebt))})`);
  } else if (oldDebt && oldDebt.payments.length && !confirm(`Usunąć powiązany dług (${oldDebt.person}) razem z historią spłat?`)) return;
  const e = {
    ...(old || { id: uid(), createdAt: Date.now() }),
    type, amount, categoryId, date,
    desc: f.desc.value.trim(),
    sub: type === 'expense' ? f.sub.value.trim() : '',
  };
  const file = f.photo?.files?.[0];
  let blob = pendingPhoto;
  if (file) blob = await resizeImage(file, 1600, 0.82);
  if (blob && type === 'expense') {
    const prev = e.receiptId;
    e.receiptId = await storeReceipt(blob, date);
    if (prev) { await saveEntry(e); await maybeDeleteReceipt(prev); }
  }
  if (owed) {
    const fields = { person: owedPerson, amount: owedAmount, date, desc: e.desc || cat(categoryId).name, due: isValidISO(f.owedDue.value) ? f.owedDue.value : '' };
    if (oldDebt) await saveDebt({ ...oldDebt, ...fields });
    else {
      const d = { id: uid(), dir: 'in', ...fields, payments: [], kind: 'expense', expenseId: e.id, createdAt: Date.now() };
      await saveDebt(d);
      e.owedDebtId = d.id;
    }
  } else {
    if (oldDebt) await removeFrom('debts', S.debts, oldDebt.id);
    delete e.owedDebtId;
  }
  pendingPhoto = null;
  await saveEntry(e);
  closeSheet();
  toast(old ? 'Zapisano zmiany' : type === 'income' ? 'Dodano przychód' : `Dodano: ${fmt(amount)}`);
  render();
};

// ---- Korki
function openKorki() {
  const last = [...S.debts].filter((d) => d.kind === 'tutoring').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  const sheet = openSheet(`
    <h2>🎓 Korepetycje</h2>
    <p class="hint">Tworzy dług „ta osoba jest mi winna”. Spłata to zwrot pieniędzy — nie liczy się jako przychód.</p>
    <form data-form="korki">
      <label>Osoba<input name="person" list="people" required autocomplete="off" value="${esc(last?.person || '')}"></label>
      <datalist id="people">${people().map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <div class="two">
        <label>Kwota (zł)<input name="amount" inputmode="decimal" required value="${amountToInput(last?.amount)}" autocomplete="off"></label>
        <label>Data<input type="date" name="date" value="${today()}"></label>
      </div>
      <label>Opis<input name="desc" value="${esc(last?.desc || 'Korepetycje')}"></label>
      <label class="check"><input type="checkbox" name="paid"> Już oddane (od razu jako spłacone)</label>
      <button class="btn primary big wide">Dodaj</button>
    </form>`);
  sheet.querySelector('[name=person]').focus();
}
FORMS.korki = async (f) => {
  const person = f.person.value.trim();
  const amount = parseAmount(f.amount.value);
  if (!person || !(amount > 0)) return toast('Podaj osobę i kwotę');
  const date = isValidISO(f.date.value) ? f.date.value : today();
  const d = { id: uid(), dir: 'in', person, amount, date, desc: f.desc.value.trim() || 'Korepetycje', due: '', payments: [], kind: 'tutoring', createdAt: Date.now() };
  await saveDebt(d);
  if (f.paid.checked) await addPayment(d, amount, date, '');
  closeSheet();
  toast(f.paid.checked ? `Korki ${fmt(amount)} — od razu spłacone` : `${person} jest Ci winna/winien ${fmt(amount)}`);
  render();
};

// ---- Subskrypcje
function openSubs() {
  const act = S.subs.filter((s) => s.active), inactive = S.subs.filter((s) => !s.active);
  const total = act.reduce((a, s) => a + subMonthly(s), 0);
  const row = (s) => `<button class="row" data-act="editSub" data-id="${s.id}">${catIcon(cat(s.categoryId))}
    <span class="row-main"><span class="row-title">${esc(s.name)}</span><span class="row-sub">${s.cycle === 'year' ? `co rok, ${s.day} ${['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'][(s.month || 1) - 1]}` : `co miesiąc, ${s.day}. dnia`}${s.active ? '' : ' · wstrzymana'}</span></span>
    <span class="row-amt">${fmt(s.amount)}</span></button>`;
  openSheet(`
    <h2>🔁 Subskrypcje</h2>
    <div class="card big-num"><small>Aktywne, miesięcznie (roczne / 12)</small><b>${fmt(total)}</b><small>${fmt(total * 12)} rocznie</small></div>
    ${act.length ? `<div class="card list-card">${act.map(row).join('')}</div>` : '<div class="empty">Brak aktywnych subskrypcji.</div>'}
    ${inactive.length ? `<h3>Wstrzymane</h3><div class="card list-card">${inactive.map(row).join('')}</div>` : ''}
    <button class="btn primary wide" data-act="editSub">+ Dodaj subskrypcję</button>`);
}

function openSubForm(s = null) {
  const v = s || { name: '', amount: null, categoryId: 'c_subskrypcje', cycle: 'month', day: parseISO(today()).getDate(), month: parseISO(today()).getMonth() + 1, start: today(), active: true };
  const sheet = openSheet(`
    <h2>${s ? 'Edytuj' : 'Nowa'} subskrypcja</h2>
    <form data-form="sub">
      <input type="hidden" name="id" value="${s?.id || ''}">
      <label>Nazwa<input name="name" required value="${esc(v.name)}" placeholder="np. Netflix"></label>
      <div class="two">
        <label>Kwota (zł)<input name="amount" inputmode="decimal" required value="${amountToInput(v.amount)}"></label>
        <label>Kategoria<select name="categoryId">${cats().map((c) => `<option value="${c.id}" ${c.id === v.categoryId ? 'selected' : ''}>${esc(c.icon + ' ' + c.name)}</option>`).join('')}</select></label>
      </div>
      <div class="two">
        <label>Cykl<select name="cycle"><option value="month" ${v.cycle === 'month' ? 'selected' : ''}>Co miesiąc</option><option value="year" ${v.cycle === 'year' ? 'selected' : ''}>Co rok</option></select></label>
        <label>Dzień pobrania<input name="day" type="number" min="1" max="31" required value="${v.day}"></label>
      </div>
      <label class="year-only" ${v.cycle === 'year' ? '' : 'hidden'}>Miesiąc pobrania<select name="month">${MON_NOM.map((m, i) => `<option value="${i + 1}" ${i + 1 === v.month ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label>Od daty<input type="date" name="start" value="${v.start}"></label>
      <p class="hint">Wydatek doda się automatycznie w dniu pobrania (przy otwarciu aplikacji). Zaległe terminy od daty startu zostaną uzupełnione.</p>
      <label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Aktywna</label>
      <div class="row-btns">
        ${s ? `<button type="button" class="btn danger" data-act="deleteSub" data-id="${s.id}">Usuń</button>` : ''}
        <button class="btn primary big">Zapisz</button>
      </div>
    </form>`);
  const f = sheet.querySelector('form');
  f.cycle.addEventListener('change', () => (f.querySelector('.year-only').hidden = f.cycle.value !== 'year'));
}
FORMS.sub = async (f) => {
  const amount = parseAmount(f.amount.value);
  const day = Math.min(31, Math.max(1, parseInt(f.day.value, 10) || 1));
  if (!f.name.value.trim() || !(amount > 0)) return toast('Podaj nazwę i kwotę');
  const old = S.subs.find((x) => x.id === f.id.value);
  const start = isValidISO(f.start.value) ? f.start.value : today();
  const s = {
    ...(old || { id: uid(), lastRun: '' }),
    name: f.name.value.trim(), amount, categoryId: f.categoryId.value, cycle: f.cycle.value,
    day, month: parseInt(f.month.value, 10) || 1, start, active: f.active.checked,
  };
  if (old && start < old.start) s.lastRun = ''; // przesunięto start wstecz
  if (old && !old.active && s.active) s.lastRun = today(); // wznowienie: bez dopisywania przerwy
  await saveSub(s);
  const n = await runSubscriptions();
  closeSheet();
  const next = s.active ? subscriptionDueDates({ ...s, lastRun: today() }, addDays(today(), 400))[0] : null;
  toast(n ? `Zapisano. Dodano ${n} wpis(y) z subskrypcji`
    : !s.active ? 'Zapisano — subskrypcja jest wstrzymana, nic się nie doda'
    : next ? `Zapisano. Pierwsze pobranie: ${fmtDate(next)}` : 'Zapisano subskrypcję');
  render();
};

// ---------------------------------------------------------------- Statystyki
function viewStats() {
  const { kind, offset } = UI.stats;
  const p = getPeriod(kind, offset), pp = getPeriod(kind, offset - 1);
  const ex = entriesIn(p, 'expense');
  const total = sumAmt(ex), prevTotal = sumAmt(entriesIn(pp, 'expense'));
  const refunds = refundsIn(p);
  const inc = sumAmt(entriesIn(p, 'income')) + refunds;
  const map = new Map();
  ex.forEach((e) => map.set(e.categoryId, (map.get(e.categoryId) || 0) + e.amount));
  const rows = [...map].map(([id, v]) => ({ id, c: cat(id), v })).sort((a, b) => b.v - a.v);
  const ch = pctChange(total, prevTotal);
  const cmp = ch === null
    ? `<span class="muted">${total ? 'brak wydatków w poprzednim okresie' : ''}</span>`
    : `<span class="${ch > 0 ? 'neg' : 'pos'}">${ch > 0 ? '▲ +' : ch < 0 ? '▼ ' : ''}${ch.toFixed(1).replace('.', ',')}%</span> <span class="muted">vs poprzedni okres (${fmt(prevTotal)})</span>`;
  const vals = p.buckets.map((b) => sumAmt(ex.filter((e) => e.date >= b.start && e.date <= b.end)));
  const labels = p.buckets.map((b, i) => (kind !== 'month' || i === 0 || (i + 1) % 5 === 0 ? b.label : ''));
  const t = today();
  const hi = p.buckets.findIndex((b) => t >= b.start && t <= b.end);
  const seg = (k, l) => `<button class="${kind === k ? 'on' : ''}" data-act="statsKind" data-kind="${k}">${l}</button>`;
  return `
    <div class="seg seg-btns">${seg('week', 'Tydzień')}${seg('month', 'Miesiąc')}${seg('year', 'Rok')}</div>
    <div class="period-nav">
      <button class="icon-btn" data-act="statsPrev" aria-label="Poprzedni okres">‹</button>
      <div class="period-label">${esc(p.label)}${offset === 0 ? ' <small>(bieżący)</small>' : ''}</div>
      <button class="icon-btn" data-act="statsNext" aria-label="Następny okres" ${offset >= 0 ? 'disabled' : ''}>›</button>
    </div>
    <section class="card">
      <small class="muted">Suma wydatków</small>
      <div class="total">${fmt(total)}</div>
      <div class="cmp">${cmp}</div>
      <div class="mini-row"><span>Przychody${refunds ? ' (w tym zwroty)' : ''} <b class="pos">${fmt(inc)}</b></span><span>Bilans <b class="${inc - total >= 0 ? 'pos' : 'neg'}">${fmt(inc - total, { sign: true })}</b></span></div>
    </section>
    <section class="card">
      <h3>Wg kategorii</h3>
      ${donut(rows.map((r) => ({ value: r.v, color: r.c.color })), rows.length ? fmt(total) : 'Brak', rows.length ? `${rows.length} kat.` : 'wydatków')}
      <div class="list-card cat-list">
        ${rows.map((r) => `<button class="row" data-act="catDetail" data-id="${r.id}">${catIcon(r.c)}
          <span class="row-main"><span class="row-title">${esc(r.c.name)}</span>
          <span class="bar-pct"><i style="width:${((r.v / total) * 100).toFixed(1)}%;background:${esc(r.c.color)}"></i></span></span>
          <span class="row-amt">${fmt(r.v)}<small>${((r.v / total) * 100).toFixed(1).replace('.', ',')}%</small></span></button>`).join('')}
      </div>
    </section>
    <section class="card">
      <h3>${kind === 'week' ? 'Dni tygodnia' : kind === 'month' ? 'Dni miesiąca' : 'Miesiące'}</h3>
      ${bars(vals, labels, { highlight: hi })}
    </section>`;
}

function openCatDetail(catId) {
  const p = getPeriod(UI.stats.kind, UI.stats.offset);
  const list = entriesIn(p, 'expense').filter((e) => (e.categoryId || '') === (catId || '')).sort(byDateDesc);
  const c = cat(catId);
  openSheet(`<h2>${esc(c.icon)} ${esc(c.name)}</h2>
    <p class="muted">${esc(p.label)} · ${list.length} wpis(ów) · <b>${fmt(sumAmt(list))}</b></p>
    ${list.length ? groupedList(list) : '<div class="empty">Brak wydatków.</div>'}`, { full: true });
}

// ---------------------------------------------------------------- Długi
function debtRow(d) {
  const b = balance(d), pd = paid(d);
  const overdue = d.due && b > 0 && d.due < today();
  return `<button class="row debt" data-act="openDebt" data-id="${d.id}">
    <span class="avatar ${d.dir}">${esc(d.person.trim()[0] || '?').toUpperCase()}</span>
    <span class="row-main"><span class="row-title">${esc(d.person)}${d.kind === 'tutoring' ? ' 🎓' : ''}</span>
      <span class="row-sub">${esc(d.desc || '')}${d.desc ? ' · ' : ''}${esc(fmtDate(d.date))}${d.due ? ` · <span class="${overdue ? 'neg' : ''}">termin ${esc(fmtDate(d.due))}${overdue ? ' (po terminie)' : ''}</span>` : ''}</span>
      ${pd && b > 0 ? `<span class="progress"><i style="width:${(pd / d.amount) * 100}%"></i></span>` : ''}
    </span>
    <span class="row-amt ${d.dir === 'in' ? 'pos' : 'neg'}">${fmt(b > 0 ? b : d.amount)}${pd && b > 0 ? `<small>z ${fmt(d.amount)}</small>` : ''}${b <= 0 ? '<small>spłacony</small>' : ''}</span>
  </button>`;
}

function viewDebts() {
  const act = S.debts.filter((d) => balance(d) > 0);
  const sIn = act.filter((d) => d.dir === 'in').reduce((a, d) => a + balance(d), 0);
  const sOut = act.filter((d) => d.dir === 'out').reduce((a, d) => a + balance(d), 0);
  const net = sIn - sOut;
  const v = UI.debtView;
  const seg = (k, l) => `<button class="${v === k ? 'on' : ''}" data-act="debtView" data-view="${k}">${l}</button>`;
  let body = '';
  if (v === 'active') {
    const sec = (dir, title, sum) => {
      const list = act.filter((d) => d.dir === dir).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || b.date.localeCompare(a.date));
      return `<h3 class="sec-head"><span>${title}</span><span class="${dir === 'in' ? 'pos' : 'neg'}">${fmt(sum)}</span></h3>
        ${list.length ? `<div class="card list-card">${list.map(debtRow).join('')}</div>` : '<div class="empty small">Brak.</div>'}`;
    };
    body = sec('in', 'Mi są winni', sIn) + sec('out', 'Ja jestem winny', sOut);
  } else if (v === 'people') {
    const map = new Map();
    S.debts.forEach((d) => {
      const k = d.person.trim();
      const o = map.get(k) || { name: k, net: 0, count: 0 };
      o.net += (d.dir === 'in' ? 1 : -1) * Math.max(balance(d), 0);
      o.count++;
      map.set(k, o);
    });
    const list = [...map.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.name.localeCompare(b.name, 'pl'));
    body = list.length ? `<div class="card list-card">${list.map((p) => `<button class="row" data-act="openPerson" data-name="${esc(p.name)}">
      <span class="avatar ${p.net >= 0 ? 'in' : 'out'}">${esc(p.name[0] || '?').toUpperCase()}</span>
      <span class="row-main"><span class="row-title">${esc(p.name)}</span><span class="row-sub">${p.count} wpis(ów) · ${p.net > 0 ? 'jest Ci winna/winien' : p.net < 0 ? 'jesteś winny' : 'rozliczeni'}</span></span>
      <span class="row-amt ${p.net > 0 ? 'pos' : p.net < 0 ? 'neg' : ''}">${fmt(p.net, { sign: true })}</span></button>`).join('')}</div>` : '<div class="empty">Brak osób.</div>';
  } else {
    const list = S.debts.filter((d) => balance(d) <= 0).sort(byDateDesc);
    body = list.length ? `<div class="card list-card">${list.map(debtRow).join('')}</div>` : '<div class="empty">Archiwum jest puste. Spłacone długi trafiają tutaj.</div>';
  }
  return `
    <section class="card summary">
      <div class="grid3">
        <div><small>Mi są winni</small><b class="pos">${fmt(sIn)}</b></div>
        <div><small>Ja jestem winny</small><b class="neg">${fmt(sOut)}</b></div>
        <div><small>Saldo netto</small><b class="${net >= 0 ? 'pos' : 'neg'}">${fmt(net, { sign: true })}</b></div>
      </div>
    </section>
    <div class="seg seg-btns">${seg('active', 'Aktywne')}${seg('people', 'Osoby')}${seg('archive', 'Archiwum')}</div>
    ${body}
    <button class="btn primary wide" data-act="addDebt">+ Dodaj dług</button>`;
}

function openDebtForm(d = null, dir = 'in') {
  const v = d || { dir, person: '', amount: null, date: today(), desc: '', due: '' };
  const sheet = openSheet(`
    <h2>${d ? 'Edytuj dług' : 'Nowy dług'}</h2>
    <form data-form="debt">
      <input type="hidden" name="id" value="${d?.id || ''}">
      <div class="seg">
        <label><input type="radio" name="dir" value="in" ${v.dir === 'in' ? 'checked' : ''}><span>Mi są winni</span></label>
        <label><input type="radio" name="dir" value="out" ${v.dir === 'out' ? 'checked' : ''}><span>Ja jestem winny</span></label>
      </div>
      <label>Osoba<input name="person" list="people" required value="${esc(v.person)}" autocomplete="off"></label>
      <datalist id="people">${people().map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <div class="two">
        <label>Kwota (zł)<input name="amount" inputmode="decimal" required value="${amountToInput(v.amount)}" autocomplete="off"></label>
        <label>Data<input type="date" name="date" value="${v.date}"></label>
      </div>
      <label>Opis<input name="desc" value="${esc(v.desc)}" placeholder="np. pożyczka na bilety"></label>
      <label>Termin spłaty (opcjonalnie)<input type="date" name="due" value="${v.due || ''}"></label>
      <button class="btn primary big wide">Zapisz</button>
    </form>`);
  if (!d) sheet.querySelector('[name=person]').focus();
}
FORMS.debt = async (f) => {
  const person = f.person.value.trim(), amount = parseAmount(f.amount.value);
  if (!person || !(amount > 0)) return toast('Podaj osobę i kwotę');
  const old = S.debts.find((x) => x.id === f.id.value);
  if (old && amount < paid(old)) return toast('Kwota nie może być mniejsza niż suma spłat');
  const d = {
    ...(old || { id: uid(), payments: [], kind: '', createdAt: Date.now() }),
    dir: f.dir.value, person, amount,
    date: isValidISO(f.date.value) ? f.date.value : today(),
    desc: f.desc.value.trim(), due: isValidISO(f.due.value) ? f.due.value : '',
  };
  await saveDebt(d);
  // zmiana osoby/kierunku w korkach — aktualizuj opisy przychodów
  if (old) for (const p of d.payments) {
    const e = S.entries.find((x) => x.id === p.entryId);
    if (e) { e.desc = `Korepetycje – ${d.person}`; await saveEntry(e); }
  }
  closeSheet();
  toast('Zapisano dług');
  render();
};

function openDebt(id) {
  const d = S.debts.find((x) => x.id === id);
  if (!d) return;
  const b = balance(d);
  const hist = [...d.payments].sort((a, c) => c.date.localeCompare(a.date));
  openSheet(`
    <div class="debt-head">
      <span class="avatar big ${d.dir}">${esc(d.person.trim()[0] || '?').toUpperCase()}</span>
      <div><h2>${esc(d.person)}</h2><div class="muted">${d.dir === 'in' ? 'jest Ci winna/winien' : 'jesteś winny'}${d.kind === 'tutoring' ? ' · korepetycje' : ''}</div></div>
    </div>
    <div class="card grid3">
      <div><small>Kwota</small><b>${fmt(d.amount)}</b></div>
      <div><small>Spłacono</small><b>${fmt(paid(d))}</b></div>
      <div><small>Pozostało</small><b class="${b > 0 ? (d.dir === 'in' ? 'pos' : 'neg') : ''}">${fmt(Math.max(b, 0))}</b></div>
    </div>
    <p class="muted">${esc(d.desc || '')}${d.desc ? ' · ' : ''}z dnia ${esc(fmtDate(d.date, { year: true }))}${d.due ? ` · termin ${esc(fmtDate(d.due, { year: true }))}` : ''}</p>
    ${d.expenseId ? '<p class="hint">↩️ Dług powstał z wydatku. Cała kwota wydatku liczy się w statystykach, a spłata to zwrot, nie przychód.</p>' : ''}
    ${b > 0 ? `<form data-form="payment" class="card pay-form">
      <input type="hidden" name="id" value="${d.id}">
      <b>Dodaj spłatę</b>
      <div class="two">
        <label>Kwota (zł)<input name="amount" inputmode="decimal" value="${amountToInput(b)}" autocomplete="off"></label>
        <label>Data<input type="date" name="date" value="${today()}"></label>
      </div>
      <label>Notatka<input name="note" placeholder="np. przelew, gotówka"></label>
      <div class="row-btns"><button class="btn primary">Zapisz spłatę</button></div>
    </form>` : '<div class="banner ok">✓ Spłacony w całości — w archiwum.</div>'}
    <h3>Historia</h3>
    <div class="card list-card">
      ${hist.map((p) => `<div class="row static"><span class="ico" style="--c:#16a34a">✓</span><span class="row-main"><span class="row-title">Spłata ${fmt(p.amount)}</span><span class="row-sub">${esc(fmtDate(p.date, { year: true }))}${p.note ? ' · ' + esc(p.note) : ''}</span></span>
        <button class="icon-btn" data-act="deletePayment" data-debt="${d.id}" data-id="${p.id}" aria-label="Usuń spłatę">🗑</button></div>`).join('')}
      <div class="row static"><span class="ico" style="--c:#64748b">＋</span><span class="row-main"><span class="row-title">Powstanie długu ${fmt(d.amount)}</span><span class="row-sub">${esc(fmtDate(d.date, { year: true }))}</span></span></div>
    </div>
    <div class="row-btns">
      <button class="btn danger" data-act="deleteDebt" data-id="${d.id}">Usuń dług</button>
      <button class="btn ghost" data-act="editDebt" data-id="${d.id}">Edytuj</button>
    </div>`);
}

async function addPayment(d, amount, date, note) {
  const p = { id: uid(), amount, date, note };
  d.payments.push(p); // spłata to zwrot pieniędzy, nie przychód
  await saveDebt(d);
}

FORMS.payment = async (f) => {
  const d = S.debts.find((x) => x.id === f.id.value);
  const amount = parseAmount(f.amount.value);
  const b = balance(d);
  if (!(amount > 0)) return toast('Podaj kwotę spłaty');
  if (amount > b) return toast(`Maksymalnie ${fmt(b)}`);
  await addPayment(d, amount, isValidISO(f.date.value) ? f.date.value : today(), f.note.value.trim());
  toast(balance(d) <= 0 ? 'Dług spłacony 🎉 — przeniesiono do archiwum' : `Spłata zapisana. Pozostało ${fmt(balance(d))}`);
  render();
  openDebt(d.id);
};

function openPerson(name) {
  const list = S.debts.filter((d) => d.person.trim() === name);
  const net = list.reduce((a, d) => a + (d.dir === 'in' ? 1 : -1) * Math.max(balance(d), 0), 0);
  const events = [];
  list.forEach((d) => {
    events.push({ date: d.date, t: `${d.dir === 'in' ? 'Pożyczył(a) / winien' : 'Ja winny'}: ${d.desc || 'dług'}`, a: d.amount, s: d.dir === 'in' ? 1 : -1, id: d.id });
    d.payments.forEach((p) => events.push({ date: p.date, t: `Spłata${p.note ? ' · ' + p.note : ''} (${d.desc || 'dług'})`, a: p.amount, s: d.dir === 'in' ? -1 : 1, id: d.id }));
  });
  events.sort((a, b) => b.date.localeCompare(a.date));
  openSheet(`
    <div class="debt-head"><span class="avatar big ${net >= 0 ? 'in' : 'out'}">${esc(name[0] || '?').toUpperCase()}</span>
      <div><h2>${esc(name)}</h2><div class="muted">${net > 0 ? 'jest Ci winna/winien' : net < 0 ? 'jesteś winny' : 'rozliczeni'}</div></div></div>
    <div class="card big-num"><small>Saldo łączne</small><b class="${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}">${fmt(net, { sign: true })}</b></div>
    <h3>Długi</h3>
    <div class="card list-card">${list.sort(byDateDesc).map(debtRow).join('')}</div>
    <h3>Historia</h3>
    <div class="card list-card">${events.map((e) => `<div class="row static"><span class="row-main"><span class="row-title">${esc(e.t)}</span><span class="row-sub">${esc(fmtDate(e.date, { year: true }))}</span></span>
      <span class="row-amt ${e.s > 0 ? 'pos' : 'neg'}">${e.s > 0 ? '+' : '−'}${fmt(e.a)}</span></div>`).join('')}</div>
    <p class="hint">„+” zwiększa to, co ${esc(name)} jest Ci winna/winien.</p>`, { full: true });
}

// ---------------------------------------------------------------- Skan paragonu
function openScan() {
  const noKey = !S.settings.apiKey, off = !navigator.onLine;
  const sheet = openSheet(`
    <h2>🧾 Skan paragonu</h2>
    ${noKey || off ? `<div class="banner warn">${noKey ? 'Brak klucza API Anthropic — skan nie zadziała. Dodaj klucz w Ustawieniach.' : 'Jesteś offline — odczyt paragonu wymaga internetu.'}
      Możesz dodać wydatek ręcznie${off && !noKey ? '' : ''}, a zdjęcie dołączyć jako załącznik.</div>` : '<p class="hint">Zrób zdjęcie całego paragonu na płasko, w dobrym świetle.</p>'}
    <div class="scan-btns">
      <label class="btn primary big">📷 Zrób zdjęcie<input type="file" accept="image/*" capture="environment" class="scan-input" hidden></label>
      <label class="btn ghost big">🖼️ Wybierz z galerii<input type="file" accept="image/*" class="scan-input" hidden></label>
    </div>
    <div class="row-btns">
      ${noKey ? '<button class="btn ghost" data-act="goSettings">Ustaw klucz API</button>' : ''}
      <button class="btn ghost" data-act="manualAdd">✍️ Dodaj ręcznie</button>
    </div>`);
  $$('.scan-input', sheet).forEach((inp) => inp.addEventListener('change', () => inp.files[0] && handleReceiptFile(inp.files[0])));
}

async function handleReceiptFile(file) {
  openSheet(`<div class="loading"><div class="spinner"></div><p>Przygotowuję zdjęcie…</p></div>`);
  let blob;
  try {
    blob = await resizeImage(file);
  } catch (e) {
    return scanError(e.message, null);
  }
  if (!S.settings.apiKey || !navigator.onLine) {
    return scanError(!S.settings.apiKey ? 'Brak klucza API — dodaj go w Ustawieniach.' : 'Brak internetu — nie można odczytać paragonu.', blob);
  }
  $('.loading p').textContent = 'Odczytuję paragon… (kilka–kilkanaście sekund)';
  try {
    const data = await scanReceipt({ blob, apiKey: S.settings.apiKey, model: S.settings.model || DEFAULT_MODEL, categories: visibleCats() });
    if (!sheetOpen) return;
    openVerify({ ...data, blob });
  } catch (e) {
    console.warn(e);
    if (sheetOpen) scanError(e.message, blob);
  }
}

let lastScanBlob = null;
function scanError(msg, blob) {
  lastScanBlob = blob;
  openSheet(`<h2>Nie udało się odczytać</h2>
    <div class="banner warn">${esc(msg)}</div>
    <p class="hint">Dodaj wydatek ręcznie${blob ? ' — zdjęcie zostanie dołączone' : ''}.</p>
    <div class="row-btns">
      <button class="btn ghost" data-act="openScan">Spróbuj ponownie</button>
      <button class="btn primary" data-act="manualFromScan">✍️ Dodaj ręcznie</button>
    </div>`);
}

let V = null;
function openVerify(data) {
  V = { ...data, items: data.items.map((i) => ({ ...i })), mode: 'single' };
  const counts = {};
  V.items.forEach((i) => (counts[i.categoryId] = (counts[i.categoryId] || 0) + i.price));
  V.singleCat = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'c_jedzenie';
  const catOpts = (sel) => visibleCats().map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.icon + ' ' + c.name)}</option>`).join('');
  const sheet = openSheet(`
    <h2>Sprawdź paragon</h2>
    <form data-form="verify" class="verify">
      <div class="two">
        <label>Sklep<input name="store" value="${esc(V.store)}"></label>
        <label>Data<input type="date" name="date" value="${V.date}"></label>
      </div>
      <label>Suma z paragonu (zł)<input name="total" inputmode="decimal" value="${amountToInput(V.total)}"></label>
      <div id="sum-warn"></div>
      <h3>Pozycje <small class="muted">(${V.items.length})</small></h3>
      <div id="v-items"></div>
      <button type="button" class="btn ghost wide" data-act="vAdd">+ Dodaj pozycję</button>
      <h3>Zapisz jako</h3>
      <div class="seg">
        <label><input type="radio" name="mode" value="single" checked><span>Jeden wydatek</span></label>
        <label><input type="radio" name="mode" value="split"><span>Po kategoriach</span></label>
      </div>
      <label class="single-only">Kategoria wydatku<select name="singleCat">${catOpts(V.singleCat)}</select></label>
      <div class="split-only" id="split-preview" hidden></div>
      <button class="btn primary big wide">Zapisz</button>
    </form>`, { full: true });
  V.catOpts = catOpts;
  renderVItems();
  const f = sheet.querySelector('form');
  f.addEventListener('input', (ev) => {
    const row = ev.target.closest('[data-i]');
    if (row) {
      const it = V.items[+row.dataset.i];
      if (ev.target.name === 'iname') it.name = ev.target.value;
      if (ev.target.name === 'iprice') it.price = parseAmount(ev.target.value) || 0;
    }
    updateVSum();
  });
  f.addEventListener('change', (ev) => {
    const row = ev.target.closest('[data-i]');
    if (row && ev.target.name === 'icat') V.items[+row.dataset.i].categoryId = ev.target.value;
    if (ev.target.name === 'mode') {
      V.mode = ev.target.value;
      f.querySelector('.single-only').hidden = V.mode !== 'single';
      f.querySelector('.split-only').hidden = V.mode !== 'split';
    }
    updateVSum();
  });
}
function renderVItems() {
  $('#v-items').innerHTML = V.items.map((it, i) => `<div class="v-item" data-i="${i}">
      <input name="iname" value="${esc(it.name)}" aria-label="Nazwa pozycji">
      <input name="iprice" inputmode="decimal" value="${amountToInput(it.price)}" aria-label="Cena" class="price">
      <select name="icat" aria-label="Kategoria">${V.catOpts(it.categoryId)}</select>
      <button type="button" class="icon-btn" data-act="vDel" data-i="${i}" aria-label="Usuń pozycję">✕</button>
    </div>`).join('') || '<div class="empty small">Brak pozycji — dodaj je lub zapisz jako jeden wydatek.</div>';
  updateVSum();
}
function updateVSum() {
  const f = $('form.verify');
  if (!f) return;
  const total = parseAmount(f.total.value) || 0;
  const sum = V.items.reduce((a, i) => a + (i.price || 0), 0);
  const diff = total - sum;
  $('#sum-warn').innerHTML = V.items.length && Math.abs(diff) >= 1
    ? `<div class="banner warn">⚠️ Suma pozycji ${fmt(sum)} ≠ suma z paragonu ${fmt(total)} (różnica ${fmt(diff, { sign: true })}). Sprawdź ceny i rabaty.</div>`
    : V.items.length ? `<div class="banner ok">✓ Suma pozycji zgadza się z paragonem (${fmt(sum)}).</div>` : '';
  const groups = {};
  V.items.forEach((i) => (groups[i.categoryId] = (groups[i.categoryId] || 0) + (i.price || 0)));
  const prev = $('#split-preview');
  if (prev) prev.innerHTML = Object.entries(groups).map(([id, v]) => `<div class="split-row">${catIcon(cat(id))}<span>${esc(cat(id).name)}</span><b>${fmt(v)}</b></div>`).join('');
}

FORMS.verify = async (f) => {
  const store = f.store.value.trim() || 'Paragon';
  const date = isValidISO(f.date.value) ? f.date.value : today();
  const total = parseAmount(f.total.value);
  const items = V.items.filter((i) => i.name.trim() || i.price);
  const receiptId = await storeReceipt(V.blob, date);
  const base = { type: 'expense', date, sub: '', receiptId, createdAt: Date.now() };
  const created = [];
  if (V.mode === 'single' || !items.length) {
    const amount = total > 0 ? total : items.reduce((a, i) => a + i.price, 0);
    if (!(amount > 0)) return toast('Podaj sumę paragonu');
    created.push({ ...base, id: uid(), amount, categoryId: f.singleCat.value, desc: store, items });
  } else {
    const groups = new Map();
    items.forEach((i) => {
      if (!groups.has(i.categoryId)) groups.set(i.categoryId, []);
      groups.get(i.categoryId).push(i);
    });
    for (const [categoryId, its] of groups) {
      const amount = its.reduce((a, i) => a + i.price, 0);
      if (amount <= 0) continue;
      let desc = `${store}: ${its.map((i) => i.name).join(', ')}`;
      if (desc.length > 90) desc = desc.slice(0, 87) + '…';
      created.push({ ...base, id: uid(), amount, categoryId, desc, items: its });
    }
  }
  for (const e of created) await saveEntry(e);
  V = null;
  closeSheet();
  toast(`Zapisano ${created.length} wydatek/ki: ${fmt(sumAmt(created))}`);
  UI.tab = 'expenses';
  render();
};

// ---------------------------------------------------------------- Ustawienia
function viewSettings() {
  const key = S.settings.apiKey || '';
  return `
    <section class="card">
      <h3>🧾 Skan paragonów (API Anthropic)</h3>
      <label>Klucz API<div class="inline"><input type="password" id="api-key" value="${esc(key)}" placeholder="sk-ant-…" autocomplete="off" spellcheck="false"><button class="icon-btn" data-act="toggleKey" aria-label="Pokaż klucz">👁</button></div></label>
      <label>Model<input id="api-model" value="${esc(S.settings.model || DEFAULT_MODEL)}" spellcheck="false" autocapitalize="off"></label>
      <p class="hint">Klucz jest zapisany tylko lokalnie na tym urządzeniu (IndexedDB) i wysyłany wyłącznie do api.anthropic.com przy skanie. Nie trafia do kopii zapasowej. Utwórz go w console.anthropic.com.</p>
      ${key ? '<button class="btn ghost" data-act="removeKey">Usuń klucz</button>' : ''}
    </section>
    <section class="card">
      <h3>🏷️ Kategorie</h3>
      <div class="list-card">${cats().map((c) => `<button class="row ${c.hidden ? 'dim' : ''}" data-act="editCat" data-id="${c.id}">${catIcon(c)}
        <span class="row-main"><span class="row-title">${esc(c.name)}</span><span class="row-sub">${c.hidden ? 'ukryta · ' : ''}${c.subs?.length ? esc(c.subs.join(', ')) : 'bez podkategorii'}</span></span><span class="chev">›</span></button>`).join('')}</div>
      <button class="btn ghost wide" data-act="editCat">+ Nowa kategoria</button>
    </section>
    <section class="card">
      <h3>🔁 Subskrypcje</h3>
      <button class="btn ghost wide" data-act="openSubs">Zarządzaj subskrypcjami (${S.subs.filter((s) => s.active).length} aktywne)</button>
    </section>
    ${syncCard()}
    <section class="card">
      <h3>💾 Dane i kopia zapasowa</h3>
      <div class="btn-col">
        <button class="btn ghost" data-act="exportJSON">⬇️ Eksportuj kopię (JSON)</button>
        <label class="btn ghost">⬆️ Importuj kopię (JSON)<input type="file" accept="application/json,.json" id="import-file" hidden></label>
        <button class="btn ghost" data-act="exportCSV">📄 Eksportuj wydatki (CSV)</button>
      </div>
      <p class="hint">Dane są tylko na tym urządzeniu. Rób kopię regularnie — usunięcie danych przeglądarki skasuje budżet.</p>
      <h3>Dane demo</h3>
      <div class="btn-col">
        ${S.settings.demoActive ? '<button class="btn ghost" data-act="clearDemo">🧹 Wyczyść dane demo</button>' : '<button class="btn ghost" data-act="loadDemo">✨ Wczytaj dane demo</button>'}
        <button class="btn danger" data-act="wipeAll">Usuń wszystkie dane</button>
      </div>
    </section>
    <section class="card about">
      <p><b>Budżet</b> v${APP_VERSION} · działa offline · ${S.entries.length} wpisów</p>
      <p class="hint">Dodaj do ekranu głównego: Android (Chrome) → menu ⋮ → „Zainstaluj aplikację”; iPhone (Safari) → Udostępnij → „Do ekranu początkowego”.</p>
    </section>`;
}

function openCatForm(c = null) {
  const v = c || { name: '', icon: '🏷️', color: '#0ea5e9', subs: [], hidden: false };
  openSheet(`
    <h2>${c ? 'Edytuj kategorię' : 'Nowa kategoria'}</h2>
    <form data-form="cat">
      <input type="hidden" name="id" value="${c?.id || ''}">
      <div class="cat-form-top">
        <label>Ikona<input name="icon" value="${esc(v.icon)}" maxlength="4" class="emoji-input"></label>
        <label>Kolor<input type="color" name="color" value="${esc(v.color)}"></label>
        <label class="grow">Nazwa<input name="name" required value="${esc(v.name)}"></label>
      </div>
      <label>Podkategorie (oddziel przecinkami)<input name="subs" value="${esc((v.subs || []).join(', '))}" placeholder="np. Kino, Gry"></label>
      <label class="check"><input type="checkbox" name="hidden" ${v.hidden ? 'checked' : ''}> Ukryj (nie pokazuj przy dodawaniu; historia zostaje)</label>
      <div class="row-btns">${c ? `<button type="button" class="btn ghost" data-act="moveCat" data-id="${c.id}" data-d="-1">↑</button><button type="button" class="btn ghost" data-act="moveCat" data-id="${c.id}" data-d="1">↓</button>` : ''}<button class="btn primary big">Zapisz</button></div>
    </form>`);
}
FORMS.cat = async (f) => {
  const name = f.name.value.trim();
  if (!name) return toast('Podaj nazwę');
  if (S.categories.some((c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== f.id.value)) return toast('Taka kategoria już istnieje');
  const old = S.categories.find((c) => c.id === f.id.value);
  const c = {
    ...(old || { id: 'c_' + uid(), order: Math.max(0, ...S.categories.map((x) => x.order)) + 1 }),
    name, icon: f.icon.value.trim() || '🏷️', color: f.color.value,
    subs: f.subs.value.split(',').map((s) => s.trim()).filter(Boolean), hidden: f.hidden.checked,
  };
  await saveCat(c);
  closeSheet();
  toast('Zapisano kategorię');
  render();
};

async function download(name, blob) {
  const file = new File([blob], name, { type: blob.type });
  const iOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (iOS && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
const blobToDataURL = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
function dataURLToBlob(u) {
  const [h, d] = u.split(',');
  const mime = /data:([^;]+)/.exec(h)?.[1] || 'image/jpeg';
  const bin = atob(d);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function exportJSON() {
  const receipts = await db.all('receipts');
  const settings = Object.fromEntries(Object.entries(S.settings).filter(([k]) => !EXPORT_SKIP.includes(k)));
  const data = {
    app: 'budzet-pwa', version: 1, exportedAt: new Date().toISOString(),
    entries: S.entries, categories: S.categories, subscriptions: S.subs, debts: S.debts, settings,
    receipts: await Promise.all(receipts.map(async (r) => ({ id: r.id, date: r.date, createdAt: r.createdAt, dataUrl: await blobToDataURL(r.blob) }))),
  };
  await download(`budzet-kopia-${today()}.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
}

async function importJSON(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('To nie jest poprawny plik JSON'); }
  if (data?.app !== 'budzet-pwa' || !Array.isArray(data.entries)) return toast('Nieprawidłowy plik kopii zapasowej');
  if (!confirm(`Zastąpić wszystkie obecne dane kopią z ${data.exportedAt ? new Date(data.exportedAt).toLocaleString('pl-PL') : 'pliku'}?\n(${data.entries.length} wpisów, ${data.debts?.length || 0} długów)`)) return;
  const now = Date.now();
  const stamp = (arr) => arr.map((r) => ({ ...r, updatedAt: now })); // import jest nadrzędny wobec synchronizacji
  // kopie z wersji 1.0.0 miały przychody z korków — to zwroty, więc je pomijamy
  const entries = stamp(data.entries.filter((e) => !(e.type === 'income' && e.debtId)));
  const debts = stamp((data.debts || []).map((d) => ({ ...d, payments: (d.payments || []).map(({ entryId, ...p }) => p) })));
  const categories = stamp(data.categories?.length ? data.categories : DEFAULT_CATEGORIES);
  const subs = stamp(data.subscriptions || []);
  const tombs = { ...(S.settings.tombs || {}) };
  const incoming = { entries, categories, subscriptions: subs, debts };
  const current = { entries: S.entries, categories: S.categories, subscriptions: S.subs, debts: S.debts };
  for (const [store, arr] of Object.entries(current)) {
    const ids = new Set(incoming[store].map((r) => r.id));
    arr.filter((r) => !r.demo && !ids.has(r.id)).forEach((r) => (tombs[`${store}:${r.id}`] = now));
  }
  const kept = Object.fromEntries(KEEP_LOCAL.filter((k) => S.settings[k] !== undefined).map((k) => [k, S.settings[k]]));
  for (const s of db.STORES) await db.clear(s);
  await db.putMany('entries', entries);
  await db.putMany('categories', categories);
  await db.putMany('subscriptions', subs);
  await db.putMany('debts', debts);
  await db.putMany('receipts', (data.receipts || []).map((r) => ({ id: r.id, date: r.date, createdAt: r.createdAt, blob: dataURLToBlob(r.dataUrl) })));
  const fileSettings = Object.fromEntries(Object.entries(data.settings || {}).filter(([k]) => !KEEP_LOCAL.includes(k)));
  await db.putMany('settings', Object.entries({ ...fileSettings, initialized: true, ...kept, tombs }).map(([key, value]) => ({ key, value })));
  await load();
  await runSubscriptions();
  render();
  scheduleSync(500);
  toast('Zaimportowano kopię zapasową');
}

function exportCSV() {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [['Data', 'Typ', 'Kwota', 'Kategoria', 'Podkategoria', 'Opis', 'Subskrypcja', 'Paragon'].join(';')];
  [...S.entries].sort((a, b) => a.date.localeCompare(b.date)).forEach((e) => {
    rows.push([e.date, e.type === 'income' ? 'przychód' : 'wydatek', amountToInput(e.amount), q(e.type === 'income' ? '' : cat(e.categoryId).name), q(e.sub), q(e.desc), e.subscriptionId ? 'tak' : '', e.receiptId ? 'tak' : ''].join(';'));
  });
  download(`budzet-wydatki-${today()}.csv`, new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
}

// ---------------------------------------------------------------- akcje (delegacja zdarzeń)
const ACT = {
  tab: (el) => { UI.tab = el.dataset.tab; window.scrollTo(0, 0); render(); },
  closeSheet: () => closeSheet(),
  addEntry: () => openEntrySheet(),
  addIncome: () => openEntrySheet(null, { type: 'income' }),
  manualAdd: () => openEntrySheet(),
  manualFromScan: () => openEntrySheet(null, {}, lastScanBlob),
  editEntry: (el) => {
    const e = S.entries.find((x) => x.id === el.dataset.id);
    if (e) openEntrySheet(e);
  },
  pickCat: (el) => {
    const f = el.closest('form');
    f.categoryId.value = el.dataset.id;
    $$('.cat-btn', f).forEach((b) => b.classList.toggle('sel', b === el));
    f.querySelector('.cat-grid').classList.remove('err');
    $('#sublist', f).innerHTML = (cat(el.dataset.id).subs || []).map((s) => `<option value="${esc(s)}">`).join('');
  },
  deleteEntry: async (el) => {
    const e = S.entries.find((x) => x.id === el.dataset.id);
    if (!e) return;
    const od = e.owedDebtId ? S.debts.find((d) => d.id === e.owedDebtId) : null;
    if (!confirm(e.debtId ? 'Usunąć ten przychód? Usunie to też powiązaną spłatę długu.' : `Usunąć wpis ${fmt(e.amount)}?${od ? `\nUsunie też powiązany dług (${od.person}, ${fmt(od.amount)}).` : ''}`)) return;
    if (od) await removeFrom('debts', S.debts, od.id);
    if (e.debtId) {
      const d = S.debts.find((x) => x.id === e.debtId);
      if (d) { d.payments = d.payments.filter((p) => p.id !== e.paymentId); await saveDebt(d); }
    }
    await removeFrom('entries', S.entries, e.id);
    await maybeDeleteReceipt(e.receiptId);
    closeSheet();
    toast('Usunięto');
    render();
  },
  toggleFilters: () => { UI.showFilters = !UI.showFilters; render(); },
  resetFilters: () => { UI.f = { q: UI.f.q, cat: '', from: '', to: '', type: '' }; render(); },
  more: () => { UI.limit += 200; renderList(); },
  openKorki: () => openKorki(),
  openSubs: () => openSubs(),
  editSub: (el) => openSubForm(S.subs.find((s) => s.id === el.dataset.id) || null),
  deleteSub: async (el) => {
    if (!confirm('Usunąć subskrypcję? Dodane już wydatki zostaną.')) return;
    await removeFrom('subscriptions', S.subs, el.dataset.id);
    closeSheet(); toast('Usunięto subskrypcję'); render();
  },
  statsKind: (el) => { UI.stats = { kind: el.dataset.kind, offset: 0 }; render(); },
  statsPrev: () => { UI.stats.offset--; render(); },
  statsNext: () => { if (UI.stats.offset < 0) UI.stats.offset++; render(); },
  catDetail: (el) => openCatDetail(el.dataset.id),
  debtView: (el) => { UI.debtView = el.dataset.view; render(); },
  addDebt: () => openDebtForm(),
  openDebt: (el) => openDebt(el.dataset.id),
  editDebt: (el) => openDebtForm(S.debts.find((d) => d.id === el.dataset.id)),
  openPerson: (el) => openPerson(el.dataset.name),
  deleteDebt: async (el) => {
    const d = S.debts.find((x) => x.id === el.dataset.id);
    const linked = S.entries.filter((e) => e.debtId === d.id);
    if (!confirm(`Usunąć dług ${d.person} (${fmt(d.amount)})?${linked.length ? `\nUsunie też ${linked.length} powiązany(e) przychód(y).` : ''}`)) return;
    for (const e of linked) await removeFrom('entries', S.entries, e.id);
    await removeFrom('debts', S.debts, d.id);
    closeSheet(); toast('Usunięto dług'); render();
  },
  deletePayment: async (el) => {
    const d = S.debts.find((x) => x.id === el.dataset.debt);
    const p = d.payments.find((x) => x.id === el.dataset.id);
    if (!confirm(`Usunąć spłatę ${fmt(p.amount)}?${p.entryId ? '\nUsunie też powiązany przychód.' : ''}`)) return;
    d.payments = d.payments.filter((x) => x.id !== p.id);
    if (p.entryId) await removeFrom('entries', S.entries, p.entryId);
    await saveDebt(d);
    render(); openDebt(d.id);
  },
  openScan: () => openScan(),
  goSettings: () => { closeSheet(); UI.tab = 'settings'; render(); setTimeout(() => $('#api-key')?.focus(), 50); },
  vAdd: () => { V.items.push({ name: '', price: 0, categoryId: V.singleCat }); renderVItems(); $$('.v-item input[name=iname]').pop()?.focus(); },
  vDel: (el) => { V.items.splice(+el.dataset.i, 1); renderVItems(); },
  toggleKey: () => { const i = $('#api-key'); i.type = i.type === 'password' ? 'text' : 'password'; },
  toggleGh: () => { const i = $('#gh-token'); i.type = i.type === 'password' ? 'text' : 'password'; },
  saveSync: async () => {
    const repo = $('#gh-repo').value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/$/, '');
    const token = $('#gh-token').value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return toast('Wpisz repozytorium w formie login/nazwa');
    if (!token) return toast('Wklej token GitHub');
    await setSetting('ghRepo', repo);
    await setSetting('ghToken', token);
    await setSetting('syncError', '');
    render();
    await syncNow({ manual: true });
    if (UI.tab === 'settings') render();
  },
  syncNow: async () => { await syncNow({ manual: true }); },
  stopSync: async () => {
    if (!confirm('Wyłączyć synchronizację na tym urządzeniu? Dane lokalne zostaną, a repozytorium na GitHubie nie zostanie usunięte.')) return;
    for (const k of ['ghToken', 'ghRepo', 'lastSync', 'syncError']) await db.del('settings', k), delete S.settings[k];
    clearTimeout(syncTimer); setSyncBadge('');
    render(); toast('Wyłączono synchronizację');
  },
  removeKey: async () => { if (confirm('Usunąć klucz API z tego urządzenia?')) { await setSetting('apiKey', ''); render(); toast('Usunięto klucz'); } },
  editCat: (el) => openCatForm(S.categories.find((c) => c.id === el.dataset.id) || null),
  moveCat: async (el) => {
    const list = cats();
    const i = list.findIndex((c) => c.id === el.dataset.id), j = i + +el.dataset.d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    for (let k = 0; k < list.length; k++) if (list[k].order !== k) { list[k].order = k; await saveCat(list[k]); }
    render(); toast('Zmieniono kolejność');
  },
  exportJSON: () => exportJSON().catch((e) => toast('Błąd eksportu: ' + e.message)),
  exportCSV: () => exportCSV(),
  loadDemo: async () => { await loadDemo(); toast('Wczytano dane demo'); },
  clearDemo: async () => {
    if (!confirm('Usunąć wszystkie przykładowe dane demo? Twoje własne wpisy zostaną.')) return;
    await clearDemo(); render(); toast('Wyczyszczono dane demo');
  },
  wipeAll: async () => {
    if (!confirm('Na pewno usunąć WSZYSTKIE dane (wydatki, długi, subskrypcje, paragony)? Tego nie da się cofnąć.')) return;
    const now = Date.now();
    const tombs = { ...(S.settings.tombs || {}) };
    for (const [store, arr] of Object.entries({ entries: S.entries, subscriptions: S.subs, debts: S.debts })) {
      arr.filter((r) => !r.demo).forEach((r) => (tombs[`${store}:${r.id}`] = now));
    }
    const kept = Object.fromEntries(KEEP_LOCAL.filter((k) => S.settings[k] !== undefined).map((k) => [k, S.settings[k]]));
    for (const s of db.STORES) await db.clear(s);
    await db.putMany('categories', DEFAULT_CATEGORIES);
    await db.putMany('settings', Object.entries({ ...kept, tombs, initialized: true }).map(([key, value]) => ({ key, value })));
    await load(); render(); scheduleSync(500); toast('Usunięto wszystkie dane');
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('submit', async (e) => {
  const fn = FORMS[e.target.dataset.form];
  if (!fn) return;
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit], button:not([type])');
  if (btn) btn.disabled = true;
  try { await fn(e.target); } catch (err) { console.error(err); toast('Błąd: ' + err.message); }
  finally { if (btn && btn.isConnected) btn.disabled = false; }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'q') { UI.f.q = e.target.value; UI.limit = 150; renderList(); }
  if (e.target.classList.contains('err')) e.target.classList.remove('err');
});
document.addEventListener('change', async (e) => {
  const id = e.target.id;
  if (id === 'f-cat') UI.f.cat = e.target.value;
  else if (id === 'f-type') UI.f.type = e.target.value;
  else if (id === 'f-from') UI.f.from = e.target.value;
  else if (id === 'f-to') UI.f.to = e.target.value;
  else if (id === 'api-key') { await setSetting('apiKey', e.target.value.trim()); toast(e.target.value.trim() ? 'Zapisano klucz API' : 'Usunięto klucz'); return render(); }
  else if (id === 'api-model') { await setSetting('model', e.target.value.trim() || DEFAULT_MODEL); return toast('Zapisano model'); }
  else if (id === 'import-file') { const f = e.target.files[0]; e.target.value = ''; if (f) importJSON(f); return; }
  else return;
  renderList();
});

// dla testów
window.__budzet = { S, UI, render, runSubscriptions, syncNow };

init();
