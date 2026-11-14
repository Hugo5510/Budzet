// Narzędzia: kwoty (w groszach), daty (lokalne 'YYYY-MM-DD'), okresy statystyk.

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 123456 -> "1 234,56 zł" (zawsze z separatorem tysięcy, także dla 4 cyfr)
export function fmt(g, { sign = false, cur = true } = {}) {
  const n = Math.round(Number(g) || 0);
  const neg = n < 0;
  const a = Math.abs(n);
  const zl = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const gr = String(a % 100).padStart(2, '0');
  const prefix = neg ? '−' : sign && n > 0 ? '+' : '';
  return `${prefix}${zl},${gr}${cur ? ' zł' : ''}`;
}

// "12,5" / "12.50" / "1 234,56 zł" -> grosze (int) lub NaN
export function parseAmount(v) {
  if (typeof v === 'number') return Math.round(v * 100);
  const s = String(v ?? '').replace(/[\s ]|zł|pln/gi, '').replace(',', '.');
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}

export const amountToInput = (g) => (g == null || isNaN(g) ? '' : (g / 100).toFixed(2).replace('.', ','));

export const pad = (n) => String(n).padStart(2, '0');
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export const today = () => iso(new Date());
export function addDays(s, n) {
  const d = parseISO(s);
  d.setDate(d.getDate() + n);
  return iso(d);
}
export const dim = (y, m0) => new Date(y, m0 + 1, 0).getDate();
// Poniedziałek tygodnia zawierającego datę
export function mondayOf(s) {
  const d = parseISO(s);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return iso(d);
}
export const isValidISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(parseISO(s));

export const MON_NOM = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
export const MON_GEN = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
export const MON_SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
export const WD_SHORT = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'];
export const WD_LONG = ['poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota', 'niedziela'];

export function fmtDate(s, { year = 'auto' } = {}) {
  const d = parseISO(s);
  const showY = year === true || (year === 'auto' && d.getFullYear() !== new Date().getFullYear());
  return `${d.getDate()} ${MON_GEN[d.getMonth()]}${showY ? ' ' + d.getFullYear() : ''}`;
}

export function dayHeader(s, ref = today()) {
  if (s === ref) return 'Dziś';
  if (s === addDays(ref, -1)) return 'Wczoraj';
  const d = parseISO(s);
  return `${WD_LONG[(d.getDay() + 6) % 7]}, ${fmtDate(s)}`;
}

function rangeLabel(a, b) {
  const da = parseISO(a), db = parseISO(b);
  if (da.getFullYear() !== db.getFullYear())
    return `${da.getDate()} ${MON_SHORT[da.getMonth()]} ${da.getFullYear()} – ${db.getDate()} ${MON_SHORT[db.getMonth()]} ${db.getFullYear()}`;
  if (da.getMonth() !== db.getMonth())
    return `${da.getDate()} ${MON_SHORT[da.getMonth()]} – ${db.getDate()} ${MON_SHORT[db.getMonth()]} ${db.getFullYear()}`;
  return `${da.getDate()}–${db.getDate()} ${MON_SHORT[da.getMonth()]} ${da.getFullYear()}`;
}

// kind: 'week' | 'month' | 'year'; offset: 0 = bieżący, -1 = poprzedni...
export function getPeriod(kind, offset = 0, ref = today()) {
  const r = parseISO(ref);
  if (kind === 'week') {
    const start = addDays(mondayOf(ref), offset * 7);
    const end = addDays(start, 6);
    const buckets = WD_SHORT.map((label, i) => {
      const d = addDays(start, i);
      return { start: d, end: d, label };
    });
    return { kind, offset, start, end, label: rangeLabel(start, end), buckets };
  }
  if (kind === 'month') {
    const d = new Date(r.getFullYear(), r.getMonth() + offset, 1);
    const y = d.getFullYear(), m = d.getMonth();
    const n = dim(y, m);
    const buckets = Array.from({ length: n }, (_, i) => {
      const s = `${y}-${pad(m + 1)}-${pad(i + 1)}`;
      return { start: s, end: s, label: String(i + 1) };
    });
    return { kind, offset, start: buckets[0].start, end: buckets[n - 1].end, label: `${MON_NOM[m]} ${y}`, buckets };
  }
  const y = r.getFullYear() + offset;
  const buckets = MON_SHORT.map((label, m) => ({ start: `${y}-${pad(m + 1)}-01`, end: `${y}-${pad(m + 1)}-${pad(dim(y, m))}`, label }));
  return { kind: 'year', offset, start: `${y}-01-01`, end: `${y}-12-31`, label: String(y), buckets };
}

// Terminy pobrań subskrypcji: daty > lastRun (lub >= start), <= upto
export function subscriptionDueDates(sub, upto) {
  const out = [];
  if (!sub.start || !isValidISO(upto)) return out;
  const st = parseISO(sub.start), end = parseISO(upto);
  const ok = (d) => d >= sub.start && (!sub.lastRun || d > sub.lastRun) && d <= upto;
  if (sub.cycle === 'year') {
    const m = (sub.month || 1) - 1;
    for (let y = st.getFullYear(); y <= end.getFullYear(); y++) {
      const d = iso(new Date(y, m, Math.min(sub.day, dim(y, m))));
      if (ok(d)) out.push(d);
    }
  } else {
    let y = st.getFullYear(), m = st.getMonth();
    while (y < end.getFullYear() || (y === end.getFullYear() && m <= end.getMonth())) {
      const d = iso(new Date(y, m, Math.min(sub.day, dim(y, m))));
      if (ok(d)) out.push(d);
      if (++m > 11) { m = 0; y++; }
    }
  }
  return out;
}

export function pctChange(cur, prev) {
  if (!prev) return null;
  return ((cur - prev) / prev) * 100;
}
