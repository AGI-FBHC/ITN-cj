import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/chunkRecovery.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { installChunkRecovery, isChunkLoadError } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

function browser(storage = new Map()) {
  const target = new EventTarget();
  let reloads = 0;
  Object.assign(target, {
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    location: { reload: () => reloads++ },
  });
  globalThis.window = target;
  installChunkRecovery();
  return {
    target,
    get reloads() { return reloads; },
    fail(error = new TypeError('Failed to fetch dynamically imported module: /assets/missing.js')) {
      const event = new Event('vite:preloadError', { cancelable: true });
      event.payload = error;
      target.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false, 'Vite must keep rejecting the original error');
      assert.equal(isChunkLoadError(error), true);
    },
  };
}

test('a first failure reloads once and persistent failures stay bounded across documents', () => {
  const storage = new Map();
  const first = browser(storage);
  first.fail();
  assert.equal(first.reloads, 1);
  const nextDocument = browser(storage);
  nextDocument.fail();
  nextDocument.fail();
  assert.equal(nextDocument.reloads, 0);
});

test('a recent or old attempt does not cause another automatic refresh', () => {
  for (const timestamp of [String(Date.now()), String(Date.now() - 60_000)]) {
    const app = browser(new Map([['lf.chunkReloadAt', timestamp]]));
    app.fail();
    assert.equal(app.reloads, 0);
  }
});

test('unavailable storage never causes an unbounded reload', () => {
  for (const operation of ['getItem', 'setItem']) {
    const app = browser();
    app.target.sessionStorage[operation] = () => { throw new Error('Storage unavailable'); };
    app.fail();
    app.fail();
    assert.equal(app.reloads, 0);
  }
});

test('preload payloads and browser-specific errors are recognized without hiding unrelated errors', () => {
  browser().fail(new Error('A browser-specific preload failure'));
  for (const message of [
    'Importing a module script failed.',
    'error loading dynamically imported module: /assets/missing.js',
    'Unable to preload CSS for /assets/missing.css',
    'Loading chunk 3 failed.',
  ]) assert.equal(isChunkLoadError(new Error(message)), true);
  assert.equal(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'default')")), false);
  assert.equal(isChunkLoadError(new Error('Invalid local data')), false);
});
