import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Opt-in integration test: uses the administrator's SAVED real chat model.
// No model settings are written and no external image is downloaded.
// PowerShell 7:
//   $env:ZHIXUN_TEST_REAL_MODEL = '1'
//   $env:ZHIXUN_ADMIN_PASSWORD = '<administrator password>'
//   node --test --test-concurrency=1 tests/bundle-images.test.mjs
// Optional: ZHIXUN_ADMIN_TOKEN instead of a password, ZHIXUN_TEST_API,
// ZHIXUN_TEST_HELLO_AGENTS_DOCS, ZHIXUN_TEST_WORK_ROOT, ZHIXUN_TEST_BUNDLE_TIMEOUT_MS.
const api = (process.env.ZHIXUN_TEST_API || 'http://127.0.0.1:8312/api').replace(/\/$/, '');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = process.env.ZHIXUN_TEST_HELLO_AGENTS_DOCS
  || 'D:\\Desktop\\Projects\\resource\\hello-agents\\docs';
const enabled = process.env.ZHIXUN_TEST_REAL_MODEL === '1';
const timeout = Number(process.env.ZHIXUN_TEST_BUNDLE_TIMEOUT_MS || 480000);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(route, { method = 'GET', token, body, bytes, name } = {}) {
  return fetch(`${api}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(bytes === undefined ? {} : { 'Content-Type': 'application/zip' }),
      ...(name ? { 'X-Bundle-Name': encodeURIComponent(name) } : {}),
    },
    body: bytes ?? (body === undefined ? undefined : JSON.stringify(body)),
    signal: AbortSignal.timeout(30000),
  });
}

async function ok(route, options) {
  const response = await request(route, options);
  assert.ok(response.ok, `${options?.method || 'GET'} ${route}: HTTP ${response.status}`);
  return response.json();
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Dependency-free UTF-8 ZIP with stored entries. The API also supports deflate;
// stored entries keep the fixture reproducible on machines without archivers.
function zip(entries) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const [relative, input] of entries) {
    const name = Buffer.from(relative, 'utf8');
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    parts.push(header, name, bytes);
    const item = Buffer.alloc(46);
    item.writeUInt32LE(0x02014b50, 0);
    item.writeUInt16LE(20, 4);
    item.writeUInt16LE(20, 6);
    item.writeUInt16LE(0x800, 8);
    item.writeUInt32LE(crc, 16);
    item.writeUInt32LE(bytes.length, 20);
    item.writeUInt32LE(bytes.length, 24);
    item.writeUInt16LE(name.length, 28);
    item.writeUInt32LE(offset, 42);
    directory.push(item, name);
    offset += header.length + name.length + bytes.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

async function fixture() {
  const preface = await readFile(path.join(docsRoot, '前言.md'), 'utf8');
  const original = await readFile(path.join(docsRoot, 'images', '3-figures', '1757249275674-0.png'));
  const chineseSpace = await readFile(path.join(docsRoot, 'images', '16-figures', '16-2.png'));
  const reference = await readFile(path.join(docsRoot, 'images', '4-figures', '4-1.png'));
  const boundary = `# 图片引用与原文保留验收

这一段必须逐字保留：先观察，再行动；不要把“组织章节”改成“总结内容”。
数字与英文也必须保留：Agent v1.2，2026-10-20，73.25%，O(n log n)。

## 原文中的图片

![普通相对图](../images/原文图.png)
![中文空格图](<../images/中文 图片.png> "保留图片标题")
![百分号编码图](../images/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png)
![引用式图][课程配图]
![折叠图][]
![快捷图]
<img src="../images/中文 图片.png" alt="HTML图片" width="320" />

[课程配图]: ../images/引用图.png "原始引用标题"
[折叠图]: ../images/原文图.png
[快捷图]: ../images/原文图.png

## 网页图片

![网页原图](https://example.org/static/original.png?raw=1&kind=agent)
<img alt="网页HTML原图" src="https://example.org/static/web%20image.png" width="80%" />

## 代码示例

\`\`\`markdown
![代码示例不能替换](../images/code-example.png)
\`\`\`

结尾验收句：所有说明文字都来自原文，排版调整后也不能消失。
`;
  const entries = [
    ['01-前言.md', preface],
    ['chapters/02-图片引用边界.md', boundary],
    ['images/原文图.png', original],
    ['images/中文 图片.png', chineseSpace],
    ['images/引用图.png', reference],
  ];
  return {
    bytes: zip(entries), preface, boundary,
    originals: new Map([
      ['普通相对图', sha256(original)], ['中文空格图', sha256(chineseSpace)],
      ['百分号编码图', sha256(chineseSpace)], ['引用式图', sha256(reference)],
      ['折叠图', sha256(original)], ['快捷图', sha256(original)], ['HTML图片', sha256(chineseSpace)],
    ]),
  };
}

// Resolve the Markdown/HTML image forms used by the fixture. Fenced examples are
// excluded so an example image cannot mask a lost real image.
function imageReferences(content) {
  const text = content.replace(/```[^\n]*\n[\s\S]*?```/g, '');
  const references = new Map();
  for (const match of text.matchAll(/^\s{0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|(\S+))/gm)) {
    references.set(match[1].trim().toLocaleLowerCase(), match[2] ?? match[3]);
  }
  const images = [];
  for (const match of text.matchAll(/!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))[^\n)]*\)/g)) {
    images.push({ alt: match[1], url: match[2] ?? match[3] });
  }
  for (const match of text.matchAll(/!\[([^\]\n]+)\](?:\[([^\]\n]*)\])?(?!\()/g)) {
    const url = references.get((match[2] || match[1]).trim().toLocaleLowerCase());
    if (url) images.push({ alt: match[1], url });
  }
  for (const match of text.matchAll(/<img\b[^>]*>/gi)) {
    const attributes = new Map([...match[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
      .map(attribute => [attribute[1].toLowerCase(), attribute[2] ?? attribute[3]]));
    if (attributes.has('src')) images.push({ alt: attributes.get('alt') || '', url: attributes.get('src') });
  }
  return images;
}

async function exists(filename) {
  try { await access(filename); return true; } catch { return false; }
}

async function waitForResult(id, token) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const detail = await ok(`/admin/kb/bundles/${id}`, { token });
    if (['ready', 'failed'].includes(detail.bundle.status)) return detail;
    await delay(1000);
  }
  assert.fail('Real-model bundle processing exceeded ZHIXUN_TEST_BUNDLE_TIMEOUT_MS');
}

async function assertWorkspaceRemoved(id) {
  const configured = process.env.ZHIXUN_TEST_WORK_ROOT || process.env.ZHIXUN_WORK_ROOT;
  const roots = configured ? [path.resolve(configured)] : [
    path.join(projectRoot, 'data', 'kb_work'),
    path.join(projectRoot, 'services', 'learning', 'data', 'kb_work'),
  ];
  // The status write precedes the worker's finally block; allow it to finish.
  for (let attempt = 0; attempt < 50; attempt++) {
    const retained = await Promise.all(roots.flatMap(root => [
      exists(path.join(root, id)), exists(path.join(root, `${id}.zip`)),
    ]));
    if (!retained.some(Boolean)) return;
    await delay(100);
  }
  assert.fail('The completed test bundle still has its temporary workspace or ZIP');
}

test('ZIP agent preserves source text and authenticated image assets after workspace cleanup', {
  timeout: timeout + 120000,
  skip: enabled ? false : 'Set ZHIXUN_TEST_REAL_MODEL=1 to use the saved real model',
}, async t => {
  let token = process.env.ZHIXUN_ADMIN_TOKEN;
  if (!token) {
    assert.ok(process.env.ZHIXUN_ADMIN_PASSWORD, 'Provide ZHIXUN_ADMIN_PASSWORD or ZHIXUN_ADMIN_TOKEN');
    const login = await ok('/admin/login', { method: 'POST', body: {
      account: process.env.ZHIXUN_ADMIN_ACCOUNT || 'admin', password: process.env.ZHIXUN_ADMIN_PASSWORD,
    } });
    token = login.token;
  }
  assert.equal(typeof token, 'string');
  const saved = await ok('/admin/kb', { token });
  assert.ok(saved.settings?.chat?.configured && saved.settings.chat.keyConfigured,
    'A real chat model must already be configured by the administrator');
  const settingsHash = sha256(JSON.stringify(saved.settings));
  const previousBundles = (await ok('/admin/kb/bundles', { token })).bundles.map(bundle => bundle.id);
  const input = await fixture();
  const visitor = await ok('/session', { method: 'POST', body: {} });
  let bundleId;
  let deleted = false;
  let assetRoutes = [];
  try {
    const uploaded = await ok('/admin/kb/bundles', {
      method: 'POST', token, bytes: input.bytes, name: `验收图片-${randomUUID()}.zip`,
    });
    bundleId = uploaded.id;
    assert.match(bundleId, /^[a-f\d-]{36}$/i);
    const detail = await waitForResult(bundleId, token);
    assert.equal(detail.bundle.status, 'ready', 'The real-model bundle must finish successfully');
    assert.equal(detail.bundle.model, saved.settings.chat.model, 'The bundle must use the saved chat model');
    assert.ok(Array.isArray(detail.docs) && detail.docs.length >= 2);
    const contents = detail.docs.map(doc => doc.content).join('\n\n');
    const compact = value => value.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\s+/g, '');

    await t.test('complete original prose and source provenance survive organization', () => {
      assert.ok(detail.docs.some(doc => doc.sourcePath?.replaceAll('\\', '/').endsWith('01-前言.md')),
        'Original file provenance must be available for the complete preface');
      assert.ok(detail.docs.some(doc => doc.sourcePath?.replaceAll('\\', '/').endsWith('chapters/02-图片引用边界.md')),
        'Original file provenance must be available for nested Markdown');
      for (const paragraph of input.preface.split(/\r?\n\s*\r?\n/).filter(value => value.trim())) {
        assert.ok(compact(contents).includes(compact(paragraph)), 'A complete original preface paragraph was lost or rewritten');
      }
      for (const line of input.boundary.split('\n').filter(value => /^(这一段|数字与英文|结尾验收句)/.test(value))) {
        assert.ok(contents.includes(line), 'The agent rewrote or omitted the original fixture wording');
      }
      assert.ok(contents.includes('![代码示例不能替换](../images/code-example.png)'),
        'Image syntax inside fenced source examples must remain literal');
    });

    const images = imageReferences(contents);
    const prefix = `/api/admin/kb/bundles/${bundleId}/assets/`;
    await t.test('all relative, encoded, reference and HTML images are persistent exact bytes', async () => {
      await assertWorkspaceRemoved(bundleId);
      const checked = new Set();
      for (const [alt, expectedHash] of input.originals) {
        const image = images.find(item => item.alt === alt);
        assert.ok(image, `Image alt text was lost: ${alt}`);
        assert.ok(image.url.startsWith(prefix), `Local image does not resolve to a persistent bundle asset: ${alt}`);
        const route = image.url.slice('/api'.length);
        if (!checked.has(route)) {
          const response = await request(route, { token });
          assert.equal(response.status, 200, `Persistent image fetch failed: ${alt}`);
          assert.match(response.headers.get('content-type') || '', /^image\//i);
          assert.equal(sha256(Buffer.from(await response.arrayBuffer())), expectedHash,
            `Persisted image bytes differ from the source: ${alt}`);
          checked.add(route);
        }
      }
      assetRoutes = [...checked];
      if ('assetCount' in detail.bundle) assert.ok(detail.bundle.assetCount >= 3);
      for (const [alt, url] of [
        ['网页原图', 'https://example.org/static/original.png?raw=1&kind=agent'],
        ['网页HTML原图', 'https://example.org/static/web%20image.png'],
      ]) {
        assert.ok(images.some(image => image.alt === alt && image.url === url),
          `External image URL or alt was rewritten: ${alt}`);
      }
    });

    await t.test('anonymous callers and learners cannot fetch administrator image assets', async () => {
      assert.ok(assetRoutes.length >= 3, 'Expected three distinct source images');
      for (const route of assetRoutes) {
        assert.equal((await request(route)).status, 401);
        assert.equal((await request(route, { token: visitor.token })).status, 403);
      }
      assert.equal((await request(`/admin/kb/bundles/${bundleId}`)).status, 401);
      assert.equal((await request(`/admin/kb/bundles/${bundleId}`, { token: visitor.token })).status, 403);
    });

    await t.test('deleting this test bundle invalidates every associated asset', async () => {
      const result = await ok(`/admin/kb/bundles/${bundleId}`, { method: 'DELETE', token });
      assert.equal(result.deleted, true);
      deleted = true;
      assert.equal((await request(`/admin/kb/bundles/${bundleId}`, { token })).status, 404);
      for (const route of assetRoutes) assert.equal((await request(route, { token })).status, 404);
      await assertWorkspaceRemoved(bundleId);
    });
  } finally {
    if (bundleId && !deleted) {
      const response = await request(`/admin/kb/bundles/${bundleId}`, { method: 'DELETE', token });
      assert.ok(response.ok || response.status === 404, 'The newly created test bundle could not be cleaned up');
    }
    const after = await ok('/admin/kb', { token });
    // Hashing avoids revealing even masked key hints in assertion diagnostics.
    assert.equal(sha256(JSON.stringify(after.settings)), settingsHash, 'Saved model settings changed during the test');
    const surviving = (await ok('/admin/kb/bundles', { token })).bundles.map(bundle => bundle.id);
    for (const id of previousBundles) assert.ok(surviving.includes(id), 'A pre-existing bundle was removed during the test');
  }
});
