import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewCache } from '../apps/web/src/admin/bundle-preview-cache.js';

function storageFixture() {
  const disk = new Map();
  return {
    read: async (id) => structuredClone(disk.get(id)?.value),
    write: async (entry) => { disk.set(entry.id, structuredClone(entry)); },
    bundleIds: async (scope) => [...new Set([...disk.values()]
      .filter((entry) => entry.scope === scope).map((entry) => entry.bundleId))],
    removeBundle: async (scope, bundleId) => {
      for (const [id, entry] of disk) {
        if (entry.scope === scope && entry.bundleId === bundleId) disk.delete(id);
      }
    },
  };
}

test('visited chapters survive a fresh cache instance and remain isolated by session', async () => {
  const storage = storageFixture();
  let calls = 0;
  const load = async () => ({ doc: { content: `source ${++calls}` } });
  const first = createPreviewCache(storage);
  await first.read('admin-a', 'book', 'doc:one', load);
  await first.read('admin-a', 'book', 'doc:one', load);
  const afterReload = createPreviewCache(storage);
  assert.equal((await afterReload.read('admin-a', 'book', 'doc:one', load)).doc.content, 'source 1');
  assert.equal(calls, 1);
  await afterReload.read('admin-b', 'book', 'doc:one', load);
  assert.equal(calls, 2);
});

test('concurrent reads coalesce, failures retry, incomplete directories are not saved', async () => {
  const cache = createPreviewCache(storageFixture());
  let calls = 0;
  const load = async () => { calls++; return { ready: false, docs: [] }; };
  await Promise.all(Array.from({ length: 5 }, () => cache.read('a', 'book', 'directory', load, (v) => v.ready)));
  assert.equal(calls, 1);
  await cache.read('a', 'book', 'directory', load, (v) => v.ready);
  assert.equal(calls, 2);
  await assert.rejects(cache.read('a', 'book', 'doc', async () => { throw new Error('network'); }));
  assert.equal(await cache.read('a', 'book', 'doc', async () => 'retry succeeded'), 'retry succeeded');
});

test('deleting a bundle removes both tiers and cannot be undone by an in-flight response', async () => {
  const storage = storageFixture();
  const cache = createPreviewCache(storage);
  await cache.read('a', 'book', 'directory', async () => ['one']);
  await cache.read('a', 'other', 'doc', async () => 'keep');
  let finish;
  let started;
  const loading = new Promise((resolve) => { started = resolve; });
  const inFlight = cache.read('a', 'book', 'doc', () => {
    started();
    return new Promise((resolve) => { finish = resolve; });
  });
  await loading;
  const rejected = assert.rejects(inFlight, (error) => error.status === 404);
  await cache.remove('a', 'book');
  finish('stale');
  await rejected;
  assert.deepEqual(await storage.bundleIds('a'), ['other']);
  const freshCache = createPreviewCache(storage);
  assert.equal(await freshCache.read('a', 'book', 'doc', async () => 'new'), 'new');
  assert.equal(await freshCache.read('a', 'other', 'doc', async () => 'wrong'), 'keep');
});

test('server list reconciliation clears remotely deleted bundles only', async () => {
  const storage = storageFixture();
  const cache = createPreviewCache(storage);
  await cache.read('a', 'deleted', 'doc', async () => 'remove');
  await cache.read('a', 'live', 'doc', async () => 'keep');
  await cache.read('b', 'deleted', 'doc', async () => 'another account');
  await createPreviewCache(storage).reconcile('a', ['live']);
  assert.deepEqual(await storage.bundleIds('a'), ['live']);
  assert.deepEqual(await storage.bundleIds('b'), ['deleted']);
});

test('blocked storage still allows the API and memory cache to work', async () => {
  const fail = async () => { throw new Error('quota or blocked storage'); };
  const cache = createPreviewCache({ read: fail, write: fail, removeBundle: fail, bundleIds: fail });
  assert.equal(await cache.read('a', 'book', 'doc', async () => 'source'), 'source');
  assert.equal(await cache.read('a', 'book', 'doc', async () => 'unexpected'), 'source');
  await cache.remove('a', 'book');
  assert.equal(await cache.read('a', 'book', 'doc', async () => 'new source'), 'new source');
});
