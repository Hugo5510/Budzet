// Cienka warstwa nad IndexedDB.
const DB_NAME = 'budzet-pwa';
const VERSION = 1;
export const STORES = ['entries', 'categories', 'subscriptions', 'debts', 'receipts', 'settings'];

let dbp;
export function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of STORES) {
        if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: s === 'settings' ? 'key' : 'id' });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function run(store, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const all = (store) => run(store, 'readonly', (s) => s.getAll());
export const get = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const put = (store, obj) => run(store, 'readwrite', (s) => s.put(obj));
export const del = (store, key) => run(store, 'readwrite', (s) => s.delete(key));
export const clear = (store) => run(store, 'readwrite', (s) => s.clear());
export const putMany = (store, arr) =>
  run(store, 'readwrite', (s) => {
    arr.forEach((o) => s.put(o));
  });
export const delMany = (store, keys) =>
  run(store, 'readwrite', (s) => {
    keys.forEach((k) => s.delete(k));
  });
