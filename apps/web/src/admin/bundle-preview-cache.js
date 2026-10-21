const DB_NAME = 'zhixun-bundle-previews-v1';
const STORE = 'previews';
let database;

function openDatabase() {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const opening = indexedDB.open(DB_NAME, 1);
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      opening.onsuccess = () => {
        opening.result.onversionchange = () => { opening.result.close(); database = undefined; };
        resolve(opening.result);
      };
      opening.onerror = () => reject(opening.error);
      opening.onblocked = () => reject(new Error('Preview cache unavailable'));
    }).catch((error) => { database = undefined; throw error; });
  }
  return database;
}

async function transaction(mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let result;
    action(tx.objectStore(STORE), (value) => { result = value; });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Preview cache aborted'));
  });
}

const persistentStorage = {
  read: (id) => transaction('readonly', (store, done) => {
    const request = store.get(id);
    request.onsuccess = () => done(request.result?.value);
  }),
  write: (entry) => transaction('readwrite', (store) => { store.put(entry); }),
  bundleIds: (scope) => transaction('readonly', (store, done) => {
    const ids = new Set();
    const cursor = store.openKeyCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) { done([...ids]); return; }
      const [entryScope, bundleId] = JSON.parse(row.key);
      if (entryScope === scope) ids.add(bundleId);
      row.continue();
    };
  }),
  removeBundle: (scope, bundleId) => transaction('readwrite', (store) => {
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      if (row.value.scope === scope && row.value.bundleId === bundleId) row.delete();
      row.continue();
    };
  }),
};

// Storage failures must never prevent reading the original source from the API.
export function createPreviewCache(storage = persistentStorage) {
  const memory = new Map();
  const pending = new Map();
  const versions = new Map();
  const removals = new Map();
  const bundleKey = (scope, bundleId) => JSON.stringify([scope, bundleId]);
  const deleted = () => Object.assign(new Error('知识库预览已失效，请重新选择知识库'), { status: 404 });

  async function read(scope, bundleId, resource, loader, cacheable = () => true) {
    const group = bundleKey(scope, bundleId);
    await removals.get(group);
    const id = JSON.stringify([scope, bundleId, resource]);
    if (memory.has(id)) return memory.get(id);
    if (pending.has(id)) return pending.get(id);
    const version = versions.get(group) || 0;
    const current = () => (versions.get(group) || 0) === version;
    const work = (async () => {
      let cached;
      try { cached = await storage.read(id); } catch { /* Fetch normally when storage is unavailable. */ }
      if (!current()) throw deleted();
      const value = cached === undefined ? await loader() : cached;
      if (!current()) throw deleted();
      if (cached !== undefined || cacheable(value)) {
        // Keep only a small working set in RAM; IndexedDB retains visited chapters.
        if (memory.size >= 64) memory.delete(memory.keys().next().value);
        memory.set(id, value);
        if (cached === undefined) {
          try { await storage.write({ id, scope, bundleId, value }); } catch { /* Memory cache remains usable. */ }
        }
      }
      return value;
    })();
    pending.set(id, work);
    try { return await work; }
    finally { if (pending.get(id) === work) pending.delete(id); }
  }

  async function remove(scope, bundleId) {
    const group = bundleKey(scope, bundleId);
    versions.set(group, (versions.get(group) || 0) + 1);
    for (const id of memory.keys()) {
      const [entryScope, entryBundle] = JSON.parse(id);
      if (entryScope === scope && entryBundle === bundleId) memory.delete(id);
    }
    for (const id of pending.keys()) {
      const [entryScope, entryBundle] = JSON.parse(id);
      if (entryScope === scope && entryBundle === bundleId) pending.delete(id);
    }
    const removal = (removals.get(group) || Promise.resolve())
      .then(() => storage.removeBundle(scope, bundleId)).catch(() => {});
    removals.set(group, removal);
    await removal;
    if (removals.get(group) === removal) removals.delete(group);
  }

  async function reconcile(scope, liveIds) {
    const live = new Set(liveIds);
    const known = new Set();
    for (const id of [...memory.keys(), ...pending.keys()]) {
      const [entryScope, bundleId] = JSON.parse(id);
      if (entryScope === scope) known.add(bundleId);
    }
    try { for (const id of await storage.bundleIds(scope)) known.add(id); } catch { /* Optional storage. */ }
    await Promise.all([...known].filter((id) => !live.has(id)).map((id) => remove(scope, id)));
  }

  return { read, remove, reconcile };
}

export const bundlePreviewCache = createPreviewCache();
