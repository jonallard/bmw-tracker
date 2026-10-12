// Tiny promise wrapper around IndexedDB. Everything stays on the phone.
const NAME = 'bmw-care';
const VERSION = 1;
export const STORES = ['meta', 'items', 'history', 'mileage'];

let dbPromise = null;

export function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('meta', { keyPath: 'key' });
        db.createObjectStore('items', { keyPath: 'id' });
        const h = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
        h.createIndex('itemId', 'itemId');
        db.createObjectStore('mileage', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export async function getAll(store) {
  const db = await open();
  return wrap(db.transaction(store).objectStore(store).getAll());
}

export async function put(store, value) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  const req = tx.objectStore(store).put(value);
  await done(tx);
  return req.result;
}

export async function remove(store, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}

// Several writes in one all-or-nothing transaction.
// ops: [{ store, put: value } | { store, del: key }]
export async function batch(ops) {
  const db = await open();
  const names = [...new Set(ops.map((o) => o.store))];
  const tx = db.transaction(names, 'readwrite');
  for (const op of ops) {
    const s = tx.objectStore(op.store);
    if ('put' in op) s.put(op.put);
    else s.delete(op.del);
  }
  await done(tx);
}

export async function dumpAll() {
  const out = {};
  for (const s of STORES) out[s] = await getAll(s);
  return out;
}

// Replace everything with the given dump (or with nothing, to wipe).
export async function replaceAll(dump = {}) {
  const db = await open();
  const tx = db.transaction(STORES, 'readwrite');
  for (const s of STORES) {
    const store = tx.objectStore(s);
    store.clear();
    for (const row of dump[s] || []) store.put(row);
  }
  await done(tx);
}
