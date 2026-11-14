// Skan paragonu: zmniejszenie zdjęcia + odczyt przez API Anthropic (wywołanie bezpośrednio z przeglądarki).
import { isValidISO, today } from './util.js';

export const DEFAULT_MODEL = 'claude-haiku-5-5';

export class ScanError extends Error {
  constructor(message, code = '') {
    super(message);
    this.code = code;
  }
}

// Zmniejsza zdjęcie (dłuższy bok <= max px) i zwraca JPEG Blob.
export async function resizeImage(file, max = 1568, quality = 0.85) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new ScanError('Nie udało się wczytać zdjęcia.'));
      i.src = url;
    });
    const w = img.naturalWidth, h = img.naturalHeight;
    const s = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

function buildPrompt(catNames) {
  return `Odczytaj ten polski paragon fiskalny i wywołaj narzędzie zapisz_paragon.

Zasady:
- "sklep": nazwa sklepu/firmy z nagłówka (krótko, np. "Biedronka", "Lidl", "Rossmann").
- "data": data sprzedaży w formacie RRRR-MM-DD; pusty tekst, jeśli nieczytelna.
- "suma": kwota z linii "SUMA PLN" (lub "SUMA", "DO ZAPŁATY") – to, co faktycznie zapłacono.
- "pozycje": każda kupiona pozycja osobno, "cena" = łączna kwota za tę pozycję po rabatach, w złotych (liczba, kropka dziesiętna).
  * Pozycje wielosztukowe/wagowe, np. "2 x 3,49 = 6,98" lub "0,550 kg x 12,99": jedna pozycja, cena = wartość łączna (6,98), "ilosc" = liczba sztuk lub kg.
  * Rabaty, opusty, promocje ("Rabat", "Opust", "Upust", "Promocja", "-2,00", "Lidl Plus"): odejmij od pozycji, której dotyczą (zwykle linia bezpośrednio powyżej). Nie twórz osobnych pozycji z rabatów.
  * Kaucję za opakowania wpisz jako osobną pozycję.
  * Pomiń linie podatkowe (PTU, VAT, "Sprzedaż opodatkowana"), formę płatności, resztę, NIP, numery kas i paragonów.
- "kategoria": najlepiej pasująca z listy: ${catNames.join(', ')}. Jedzenie i napoje → Jedzenie, chemia/kosmetyki → Inne lub Zdrowie, leki → Zdrowie.
- Nazwy pozycji przepisz czytelnie (rozwiń oczywiste skróty, bez kodów PTU typu "A"/"B" na końcu).
Suma cen pozycji powinna być równa "suma"; jeśli coś jest nieczytelne, podaj najlepsze przybliżenie.`;
}

export async function scanReceipt({ blob, apiKey, model, categories, timeoutMs = 90000 }) {
  if (!apiKey) throw new ScanError('Brak klucza API. Dodaj go w Ustawieniach.', 'nokey');
  if (!navigator.onLine) throw new ScanError('Brak połączenia z internetem.', 'offline');
  const catNames = categories.map((c) => c.name);
  const data = await blobToBase64(blob);
  const body = {
    model: model || DEFAULT_MODEL,
    max_tokens: 4096,
    tools: [
      {
        name: 'zapisz_paragon',
        description: 'Zapisuje odczytane dane z paragonu.',
        input_schema: {
          type: 'object',
          properties: {
            sklep: { type: 'string' },
            data: { type: 'string', description: 'RRRR-MM-DD lub pusty tekst' },
            suma: { type: 'number', description: 'Kwota z linii SUMA PLN' },
            pozycje: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  nazwa: { type: 'string' },
                  ilosc: { type: 'number' },
                  cena: { type: 'number', description: 'Łączna cena pozycji po rabatach (PLN)' },
                  kategoria: { type: 'string', enum: catNames },
                },
                required: ['nazwa', 'cena', 'kategoria'],
              },
            },
          },
          required: ['sklep', 'suma', 'pozycje'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'zapisz_paragon' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: buildPrompt(catNames) },
        ],
      },
    ],
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new ScanError('Przekroczono czas oczekiwania na odpowiedź.', 'timeout');
    throw new ScanError('Brak połączenia z API Anthropic. Sprawdź internet.', 'network');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let msg = '';
    try {
      msg = (await res.json())?.error?.message || '';
    } catch {}
    const map = {
      401: 'Nieprawidłowy klucz API. Sprawdź go w Ustawieniach.',
      403: 'Klucz API nie ma uprawnień do tego modelu.',
      404: 'Nie znaleziono modelu. Sprawdź nazwę modelu w Ustawieniach.',
      429: 'Przekroczono limit zapytań lub środków na koncie API. Spróbuj później.',
      529: 'Serwery Anthropic są przeciążone. Spróbuj za chwilę.',
    };
    throw new ScanError(map[res.status] || `Błąd API (${res.status})${msg ? ': ' + msg : ''}`, 'http' + res.status);
  }
  const json = await res.json();
  const tool = (json.content || []).find((c) => c.type === 'tool_use');
  if (!tool) throw new ScanError('Model nie zwrócił danych paragonu.', 'parse');
  return normalize(tool.input, categories);
}

export function normalize(input, categories) {
  const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
  const fallback = categories.find((c) => c.id === 'c_inne')?.id || categories[categories.length - 1]?.id || null;
  const toGr = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.'));
    return isFinite(n) ? Math.round(n * 100) : 0;
  };
  const items = (Array.isArray(input?.pozycje) ? input.pozycje : []).map((p) => ({
    name: String(p.nazwa || '').trim() || 'Pozycja',
    qty: p.ilosc || null,
    price: toGr(p.cena),
    categoryId: byName.get(String(p.kategoria || '').toLowerCase()) || fallback,
  }));
  return {
    store: String(input?.sklep || '').trim(),
    date: isValidISO(input?.data) ? input.data : today(),
    total: toGr(input?.suma),
    items,
  };
}
