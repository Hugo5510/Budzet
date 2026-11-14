// Kategorie domyślne i przykładowe dane demo (oznaczone demo: true).
import { uid, addDays, today, parseISO, iso } from './util.js';

export const DEFAULT_CATEGORIES = [
  { id: 'c_sprzet', name: 'Sprzęt', icon: '💻', color: '#6366f1', subs: ['Komputer', 'Telefon', 'Akcesoria'] },
  { id: 'c_jedzenie', name: 'Jedzenie', icon: '🍔', color: '#f59e0b', subs: ['Zakupy spożywcze', 'Restauracje', 'Kawa'] },
  { id: 'c_rozrywka', name: 'Rozrywka', icon: '🎮', color: '#ec4899', subs: ['Kino', 'Gry', 'Wyjścia'] },
  { id: 'c_subskrypcje', name: 'Subskrypcje', icon: '🔁', color: '#8b5cf6', subs: [] },
  { id: 'c_nauka', name: 'Nauka', icon: '📚', color: '#0ea5e9', subs: ['Korepetycje', 'Kursy', 'Książki'] },
  { id: 'c_inwestycje', name: 'Inwestycje', icon: '📈', color: '#10b981', subs: ['ETF', 'Obligacje', 'Akcje'] },
  { id: 'c_transport', name: 'Transport', icon: '🚗', color: '#f97316', subs: ['Paliwo', 'Komunikacja', 'Taxi'] },
  { id: 'c_mieszkanie', name: 'Mieszkanie i rachunki', icon: '🏠', color: '#64748b', subs: ['Czynsz', 'Prąd', 'Internet', 'Telefon'] },
  { id: 'c_zdrowie', name: 'Zdrowie', icon: '💊', color: '#ef4444', subs: ['Apteka', 'Lekarz', 'Sport'] },
  { id: 'c_ubrania', name: 'Ubrania', icon: '👕', color: '#14b8a6', subs: [] },
  { id: 'c_prezenty', name: 'Prezenty', icon: '🎁', color: '#d946ef', subs: [] },
  { id: 'c_inne', name: 'Inne', icon: '📦', color: '#94a3b8', subs: [] },
].map((c, i) => ({ ...c, order: i, hidden: false }));

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const TEMPLATES = [
  // [kategoria, opis, podkategoria, min zł, max zł, prawdopodobieństwo dziennie]
  ['c_jedzenie', 'Biedronka', 'Zakupy spożywcze', 25, 140, 0.45],
  ['c_jedzenie', 'Żabka', 'Zakupy spożywcze', 8, 35, 0.3],
  ['c_jedzenie', 'Kawa na mieście', 'Kawa', 12, 22, 0.2],
  ['c_jedzenie', 'Pizza z kolegami', 'Restauracje', 45, 110, 0.06],
  ['c_transport', 'Orlen', 'Paliwo', 150, 280, 0.06],
  ['c_transport', 'Bilet MPK', 'Komunikacja', 4, 6, 0.15],
  ['c_rozrywka', 'Kino', 'Kino', 28, 60, 0.04],
  ['c_rozrywka', 'Steam', 'Gry', 30, 160, 0.03],
  ['c_zdrowie', 'Apteka', 'Apteka', 15, 70, 0.04],
  ['c_ubrania', 'Zalando', '', 90, 320, 0.025],
  ['c_nauka', 'Książka', 'Książki', 35, 80, 0.03],
  ['c_sprzet', 'Akcesoria do komputera', 'Akcesoria', 40, 250, 0.015],
  ['c_prezenty', 'Prezent', '', 50, 200, 0.015],
  ['c_inne', 'Drobne', '', 5, 40, 0.04],
];

export function makeDemo(ref = today()) {
  const r = rng(42);
  const entries = [];
  const now = Date.now();
  const mk = (o) => ({ id: uid() + entries.length, sub: '', desc: '', createdAt: now - entries.length, demo: true, ...o });
  const DAYS = 80;
  for (let i = 0; i < DAYS; i++) {
    const date = addDays(ref, -i);
    for (const [categoryId, desc, sub, min, max, p] of TEMPLATES) {
      if (r() < p) {
        const amount = Math.round((min + r() * (max - min)) * 100);
        entries.push(mk({ type: 'expense', amount, categoryId, desc, sub, date }));
      }
    }
  }
  // Stałe miesięczne: czynsz, prąd, internet, wypłata, ETF
  const rd = parseISO(ref);
  for (let k = 0; k < 3; k++) {
    const y = rd.getFullYear(), m = rd.getMonth() - k;
    const d = (day) => iso(new Date(y, m, day));
    const push = (o, day) => { if (d(day) <= ref) entries.push(mk({ ...o, date: d(day) })); };
    push({ type: 'expense', amount: 180000, categoryId: 'c_mieszkanie', desc: 'Czynsz', sub: 'Czynsz' }, 10);
    push({ type: 'expense', amount: 16000 + k * 1200, categoryId: 'c_mieszkanie', desc: 'Prąd', sub: 'Prąd' }, 15);
    push({ type: 'expense', amount: 6999, categoryId: 'c_mieszkanie', desc: 'Internet światłowód', sub: 'Internet' }, 12);
    push({ type: 'expense', amount: 50000, categoryId: 'c_inwestycje', desc: 'ETF na IKE', sub: 'ETF' }, 11);
    push({ type: 'income', amount: 620000, categoryId: null, desc: 'Wypłata' }, 10);
  }

  const start3m = iso(new Date(rd.getFullYear(), rd.getMonth() - 2, 1));
  const subs = [
    { id: 'demo_netflix', name: 'Netflix', amount: 4900, categoryId: 'c_subskrypcje', cycle: 'month', day: 5, month: 1, start: start3m, active: true, lastRun: '', demo: true },
    { id: 'demo_spotify', name: 'Spotify', amount: 2399, categoryId: 'c_subskrypcje', cycle: 'month', day: 18, month: 1, start: start3m, active: true, lastRun: '', demo: true },
    { id: 'demo_icloud', name: 'iCloud+ 200 GB', amount: 1499, categoryId: 'c_subskrypcje', cycle: 'month', day: 27, month: 1, start: start3m, active: true, lastRun: '', demo: true },
    { id: 'demo_domena', name: 'Domena + hosting', amount: 24900, categoryId: 'c_subskrypcje', cycle: 'year', day: 3, month: rd.getMonth() + 1 > 1 ? rd.getMonth() : 12, start: start3m, active: true, lastRun: '', demo: true },
  ];

  const debts = [];
  const debt = (o) => {
    const d = { id: uid() + debts.length, due: '', desc: '', payments: [], kind: '', createdAt: now - debts.length, demo: true, ...o };
    debts.push(d);
    return d;
  };
  const pay = (d, amount, date, note = '') => {
    const p = { id: uid() + d.payments.length, amount, date, note };
    d.payments.push(p);
    if (d.dir === 'in' && d.kind === 'tutoring') {
      const e = mk({ type: 'income', amount, date, categoryId: null, desc: `Korepetycje – ${d.person}`, debtId: d.id, paymentId: p.id });
      p.entryId = e.id;
      entries.push(e);
    }
  };
  const t1 = debt({ dir: 'in', person: 'Ania', amount: 8000, date: addDays(ref, -16), desc: 'Korepetycje – matematyka', kind: 'tutoring' });
  pay(t1, 8000, addDays(ref, -14));
  const t2 = debt({ dir: 'in', person: 'Ania', amount: 8000, date: addDays(ref, -9), desc: 'Korepetycje – matematyka', kind: 'tutoring' });
  pay(t2, 4000, addDays(ref, -7), 'połowa gotówką');
  debt({ dir: 'in', person: 'Ania', amount: 8000, date: addDays(ref, -2), desc: 'Korepetycje – matematyka', kind: 'tutoring' });
  debt({ dir: 'in', person: 'Tomek', amount: 10000, date: addDays(ref, -5), desc: 'Korepetycje – fizyka', kind: 'tutoring' });
  const m = debt({ dir: 'in', person: 'Marek', amount: 15000, date: addDays(ref, -20), desc: 'Pożyczka na bilety', due: addDays(ref, -3) });
  pay(m, 5000, addDays(ref, -10));
  debt({ dir: 'out', person: 'Kasia', amount: 6000, date: addDays(ref, -4), desc: 'Bilety na koncert', due: addDays(ref, 10) });
  const old = debt({ dir: 'out', person: 'Marek', amount: 3500, date: addDays(ref, -40), desc: 'Pizza' });
  pay(old, 3500, addDays(ref, -35));

  return { entries, subs, debts };
}
