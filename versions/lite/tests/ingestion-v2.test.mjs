import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ingestionFixture } from './helpers/ingestion-fixture.mjs';

// Opt-in real integration only. No saved model settings are written and no model
// endpoint is replaced. Run separately after the native backend has been built:
//   $env:ZHIXUN_TEST_REAL_MODEL='1'; $env:ZHIXUN_ADMIN_PASSWORD='<password>'
//   node --test --test-concurrency=1 tests/ingestion-v2.test.mjs
// Optional: ZHIXUN_ADMIN_TOKEN, ZHIXUN_ADMIN_ACCOUNT, ZHIXUN_TEST_API,
// ZHIXUN_TEST_IMAGE (actual PNG), ZHIXUN_TEST_INGEST_TIMEOUT_MS.
// ZHIXUN_TEST_KEEP_ON_FAILURE=1 preserves only this test's bundle for diagnosis;
// ZHIXUN_TEST_BUNDLE_ID resumes a preserved 完整入库验收-{UUID}.zip bundle.
const enabled = process.env.ZHIXUN_TEST_REAL_MODEL === '1';
const api = (process.env.ZHIXUN_TEST_API || 'http://127.0.0.1:8312/api').replace(/\/$/, '');
const phaseTimeout = Number(process.env.ZHIXUN_TEST_INGEST_TIMEOUT_MS || 720000);
const hash = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const active = new Set(['queued', 'running', 'pending']);
const denied = response => assert.ok([401, 403, 404].includes(response.status), `Private resource returned HTTP ${response.status}`);
const dimension = chunk => chunk.embeddingDim ?? chunk.vectorDim ?? chunk.dimensions ?? chunk.dim;
const space = chunk => chunk.spaceKey ?? chunk.vectorSpaceKey ?? chunk.embeddingSpaceKey;
const canonical = text => text.replace(/\/api\/(?:admin\/)?kb\/bundles\/[^/]+\/assets\/[^\s)"<>]+/g, 'FIXTURE_IMAGE')
  .replaceAll('../images/课程原图.png', 'FIXTURE_IMAGE').replace(/\s+/g, '');
const fingerprint = chunks => hash(JSON.stringify(chunks.map(chunk => ({
  id: chunk.id, documentId: chunk.documentId, text: chunk.text, summary: chunk.summary,
  keywords: chunk.keywords, start: chunk.startOffset ?? chunk.sourceStart,
  end: chunk.endOffset ?? chunk.sourceEnd, dim: dimension(chunk), space: space(chunk),
}))));

async function request(route, { method = 'GET', token, body, bytes, name } = {}) {
  return fetch(`${api}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(bytes ? { 'Content-Type': 'application/zip' } : {}),
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

async function poll(load, done, label, record) {
  const deadline = Date.now() + phaseTimeout;
  let last = '';
  while (Date.now() < deadline) {
    const data = await load();
    const snapshot = JSON.stringify(data.bundle?.pipeline || { status: data.status });
    if (snapshot !== last) { record(label, JSON.parse(snapshot)); last = snapshot; }
    if (done(data)) return data;
    await pause(1000);
  }
  assert.fail(`${label} exceeded ZHIXUN_TEST_INGEST_TIMEOUT_MS`);
}

async function allChunks(bundleId, token) {
  const chunks = [];
  let total;
  for (let offset = 0; total === undefined || offset < total; offset += 2) {
    const page = await ok(`/admin/kb/bundles/${bundleId}/chunks?offset=${offset}&limit=2`, { token });
    assert.equal(page.offset, offset);
    assert.equal(page.limit, 2);
    total ??= page.total;
    assert.equal(page.total, total, 'A completed build must have stable pagination totals');
    assert.ok(page.chunks.length <= 2);
    assert.ok(page.chunks.length > 0 || offset >= total, 'Pagination stopped before reaching its total');
    chunks.push(...page.chunks);
  }
  assert.equal(chunks.length, total);
  assert.equal(new Set(chunks.map(chunk => chunk.id)).size, total, 'Pagination duplicated a chunk');
  return chunks;
}

function assertLogo(generation) {
  assert.ok(['ready', 'done', 'completed'].includes(generation.status), 'Real logo generation must finish');
  assert.equal(generation.variants.length, 3);
  assert.deepEqual(generation.variants.map(variant => variant.style).sort(), ['flat', 'geometric', 'line']);
  assert.equal(new Set(generation.variants.map(variant => variant.id)).size, 3);
  for (const variant of generation.variants) {
    assert.match(variant.svg, /<svg\b/i);
    assert.doesNotMatch(variant.svg, /<script\b|<foreignObject\b|\son\w+\s*=|javascript:/i);
  }
}

test('real ingestion preserves source, completes metadata/vectors, retries idempotently and publishes without overlap', {
  skip: enabled ? false : 'Set ZHIXUN_TEST_REAL_MODEL=1 to call the saved real chat and embedding models',
  timeout: phaseTimeout * 4 + 180000,
}, async t => {
  const runId = randomUUID();
  const logPath = fileURLToPath(new URL(`./ingestion-v2-${runId}.log`, import.meta.url));
  const events = [];
  const secrets = Object.entries(process.env).filter(([key, value]) => value && /PASSWORD|TOKEN|API_KEY/.test(key)).map(([, value]) => value);
  const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(value)).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
  const sanitize = value => typeof value === 'string' ? redact(value)
    : Array.isArray(value) ? value.map(sanitize)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitize(child)])) : value;
  const record = (phase, data) => {
    const event = { at: new Date().toISOString(), phase, data: sanitize(data) };
    events.push(event);
    appendFileSync(logPath, `${JSON.stringify(event)}\n`, 'utf8');
  };
  const phase = async (name, body) => {
    let failed;
    await t.test(name, async () => { try { await body(); } catch (error) { failed = error; throw error; } });
    if (failed) throw failed;
  };
  let token = process.env.ZHIXUN_ADMIN_TOKEN;
  let bundleId;
  let settingsHash;
  let previousBundles = [];
  let assetRoute;
  let learnerAssetRoute;
  let courseId;
  let failureDetected = false;
  const generationIds = new Set();
  try {
    if (!token) {
      assert.ok(process.env.ZHIXUN_ADMIN_PASSWORD, 'Provide ZHIXUN_ADMIN_PASSWORD or ZHIXUN_ADMIN_TOKEN');
      token = (await ok('/admin/login', { method: 'POST', body: {
        account: process.env.ZHIXUN_ADMIN_ACCOUNT || 'admin', password: process.env.ZHIXUN_ADMIN_PASSWORD,
      } })).token;
    }
    const settings = (await ok('/admin/kb', { token })).settings;
    assert.ok(settings?.chat?.configured && settings.chat.keyConfigured, 'Configure a real chat model before opting in');
    assert.ok(settings?.embedding?.keyConfigured || settings?.keyConfigured, 'Configure a real embedding model before opting in');
    settingsHash = hash(JSON.stringify(settings));
    const resumeId = process.env.ZHIXUN_TEST_BUNDLE_ID;
    previousBundles = (await ok('/admin/kb/bundles', { token })).bundles.map(bundle => bundle.id).filter(id => id !== resumeId);
    let marker = runId;
    if (resumeId) {
      const resume = await ok(`/admin/kb/bundles/${resumeId}`, { token });
      const owned = /^完整入库验收-([a-f\d-]{36})\.zip$/i.exec(resume.bundle.name);
      assert.ok(owned, 'Only a preserved ingestion-v2 test fixture may be resumed');
      marker = owned[1];
      bundleId = resumeId;
      record('resuming-test-fixture', { bundleId, marker });
    }
    const input = await ingestionFixture(marker);
    const visitor = await ok('/session', { method: 'POST', body: {} });
    if (!bundleId) {
      const uploaded = await ok('/admin/kb/bundles', { method: 'POST', token, bytes: input.bytes, name: `完整入库验收-${runId}.zip` });
      bundleId = uploaded.id;
    }
    assert.equal(typeof bundleId, 'string');
    record('uploaded', { bundleId, bytes: input.bytes.length });
    const load = () => ok(`/admin/kb/bundles/${bundleId}`, { token });
    const original = await poll(load, data => data.docs?.length >= 2 || data.bundle.status === 'failed', 'original-readable', record);
    assert.equal(original.docs.length, 2, 'Both structured and unheaded documents must be saved');
    if (original.bundle.logo?.generationId) generationIds.add(original.bundle.logo.generationId);
    const image = original.docs.map(doc => doc.content).join('\n').match(/\/api\/admin\/kb\/bundles\/[^/]+\/assets\/[^\s)"<>]+/);
    assert.ok(image, 'Original image must resolve to a persistent authenticated asset');
    assetRoute = image[0].slice('/api'.length);
    learnerAssetRoute = assetRoute.replace('/admin/kb/', '/kb/');

    await phase('private image bytes survive, and are hidden until publication', async () => {
      const response = await request(assetRoute, { token });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /^image\/png/i);
      assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(input.image));
      denied(await request(assetRoute));
      denied(await request(assetRoute, { token: visitor.token }));
      denied(await request(learnerAssetRoute));
      denied(await request(learnerAssetRoute, { token: visitor.token }));
    });

    const ready = await poll(load, data => ['ready', 'partial', 'failed'].includes(data.bundle.pipeline?.status), 'complete-ingestion', record);
    assert.equal(ready.bundle.pipeline.status, 'ready', 'Real summaries and embeddings must both complete; see the retained trace on failure');
    const chunks = await allChunks(bundleId, token);
    const pipeline = ready.bundle.pipeline;
    assert.equal(pipeline.documents, 2);
    assert.equal(pipeline.totalChunks, chunks.length);
    assert.equal(pipeline.summarizedChunks, chunks.length);
    assert.equal(pipeline.embeddedChunks, chunks.length);
    assert.equal(pipeline.failedChunks, 0);
    assert.equal(pipeline.pendingChunks, 0);

    await phase('UTF-8 source offsets cover every original byte and protect semantic blocks', () => {
      const byDocument = new Map();
      for (const doc of ready.docs) {
        assert.ok(input.documents.has(doc.sourcePath));
        assert.equal(hash(canonical(doc.content)), hash(canonical(input.documents.get(doc.sourcePath))), 'Original content was rewritten during organization');
        byDocument.set(doc.documentId, { source: Buffer.from(doc.content), chunks: [] });
      }
      for (const chunk of chunks) {
        const owner = byDocument.get(chunk.documentId);
        assert.ok(owner, 'Chunk must refer to a source document');
        const start = chunk.startOffset ?? chunk.sourceStart;
        const end = chunk.endOffset ?? chunk.sourceEnd;
        assert.ok(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= owner.source.length);
        assert.ok(owner.source.subarray(start, end).equals(Buffer.from(chunk.text)), `Offset range ${start}–${end} must reproduce exact source bytes`);
        owner.chunks.push({ start, end });
        assert.equal(chunk.summaryStatus, 'ready');
        assert.ok(chunk.summary?.trim(), 'Every chunk needs a real AI summary');
        assert.ok(Array.isArray(chunk.keywords) && chunk.keywords.length > 0 && chunk.keywords.every(word => typeof word === 'string' && word.trim()));
        assert.equal(chunk.hasVector, true);
        assert.equal(dimension(chunk), 1024, 'Persist the real 1024-dimensional model result');
        assert.match(space(chunk) || '', /^[a-f\d]{64}$/i, 'Every embedding needs a recorded vector-space key');
      }
      assert.equal(new Set(chunks.map(space)).size, 1, 'One model/configuration must use a single vector space');
      for (const owner of byDocument.values()) {
        let covered = 0;
        for (const range of owner.chunks.sort((left, right) => left.start - right.start)) {
          assert.ok(range.start <= covered && range.end > covered, 'Source coverage has a gap or duplicate range');
          covered = range.end;
        }
        assert.equal(covered, owner.source.length, 'Source coverage lost the document ending');
      }
      for (const block of input.protectedBlocks) assert.ok(chunks.some(chunk => chunk.text.includes(block)), 'Code, formula or table was split internally');
      assert.ok(chunks.some(chunk => chunk.text.includes(input.caption) && chunk.text.includes('![验收原图]')), 'A figure caption must stay with its image');
    });

    const stable = fingerprint(chunks);
    await phase('retry preserves completed chunks, summaries and vector metadata', async () => {
      await ok(`/admin/kb/bundles/${bundleId}/retry`, { method: 'POST', token, body: { stage: 'all' } });
      await pause(1200);
      const retried = await poll(load, data => data.bundle.pipeline?.status === 'ready', 'idempotent-retry', record);
      assert.equal(retried.bundle.pipeline.totalChunks, chunks.length);
      assert.equal(fingerprint(await allChunks(bundleId, token)), stable, 'A completed build must not be replaced or summarized again');
    });

    const waitLogo = id => poll(() => ok(`/admin/logos/${id}`, { token }), data => !active.has(data.status), 'logo-generation', record);
    await phase('independent three-style logo generation, selection and regeneration keep ingestion readable', async () => {
      let generationId = (await load()).bundle.logo?.generationId;
      if (!generationId) generationId = (await ok('/admin/logos/generate', { method: 'POST', token, body: { title: '智能体学习完整性验收', resourceType: 'kb_bundle', resourceId: bundleId } })).generationId;
      generationIds.add(generationId);
      const first = await waitLogo(generationId);
      assertLogo(first);
      await ok(`/admin/logos/${generationId}/select`, { method: 'POST', token, body: { variantId: first.variants[1].id } });
      assert.equal((await ok(`/admin/logos/${generationId}`, { token })).selectedVariantId, first.variants[1].id);
      assert.equal(hash((await load()).bundle.logo.svg), hash(first.variants[1].svg));
      const next = await ok('/admin/logos/generate', { method: 'POST', token, body: { title: '智能体学习完整性验收', resourceType: 'kb_bundle', resourceId: bundleId } });
      assert.notEqual(next.generationId, generationId);
      generationIds.add(next.generationId);
      const started = Date.now();
      await Promise.all([load(), allChunks(bundleId, token)]);
      assert.ok(Date.now() - started < 20000, 'Logo generation blocked original/chunk reads');
      const second = await waitLogo(next.generationId);
      assertLogo(second);
      await ok(`/admin/logos/${next.generationId}/select`, { method: 'POST', token, body: { variantId: second.variants[2].id } });
      assert.equal(hash((await load()).bundle.logo.svg), hash(second.variants[2].svg));
      assert.equal(fingerprint(await allChunks(bundleId, token)), stable, 'Logo regeneration must not rebuild ingestion');
    });

    await phase('published lessons use full original text and learner images respect visibility', async () => {
      const published = await ok(`/admin/kb/bundles/${bundleId}/publish`, { method: 'POST', token, body: {} });
      courseId = published.courseId;
      const catalog = await ok('/courses', { token: visitor.token });
      const course = catalog.courses.find(item => item.id === published.courseId);
      assert.ok(course);
      assert.equal(course.chapters.length, published.lessonCount);
      const texts = [];
      for (let index = 0; index < published.lessonCount; index += 1) {
        const lesson = await ok(`/courses/${published.courseId}/lessons/${index}`, { token: visitor.token });
        texts.push(...lesson.content.sections.map(section => section.text));
      }
      assert.equal(hash(canonical(texts.join(''))), hash(canonical(ready.docs.map(doc => doc.content).join(''))), 'Lessons must retain full sources without overlapping chunk duplication');
      const publishedImage = await request(learnerAssetRoute, { token: visitor.token });
      assert.equal(publishedImage.status, 200);
      assert.equal(hash(Buffer.from(await publishedImage.arrayBuffer())), hash(input.image));
      denied(await request(learnerAssetRoute));
      const logo = await request(`/kb/bundles/${bundleId}/logo`);
      assert.equal(logo.status, 200);
      assert.match(logo.headers.get('content-type') || '', /^image\/svg\+xml/i);
      await ok(`/admin/kb/bundles/${bundleId}/unpublish`, { method: 'POST', token, body: {} });
      denied(await request(learnerAssetRoute, { token: visitor.token }));
      denied(await request(`/kb/bundles/${bundleId}/logo`));
    });
  } catch (error) {
    failureDetected = true;
    record('failure', { name: error.name, message: error.message });
    throw error;
  } finally {
    try {
      const preserve = failureDetected && process.env.ZHIXUN_TEST_KEEP_ON_FAILURE === '1';
      if (bundleId && !preserve) {
        const deleted = await request(`/admin/kb/bundles/${bundleId}`, { method: 'DELETE', token });
        assert.ok(deleted.ok || deleted.status === 404, 'Only the new test bundle must be removed');
        assert.equal((await request(`/admin/kb/bundles/${bundleId}`, { token })).status, 404);
        if (assetRoute) assert.equal((await request(assetRoute, { token })).status, 404);
        for (const id of generationIds) assert.equal((await request(`/admin/logos/${id}`, { token })).status, 404, 'Bundle deletion must remove its test logo jobs');
        if (courseId) {
          const deletedCourse = await request(`/admin/courses/${courseId}`, { method: 'DELETE', token });
          assert.ok(deletedCourse.ok || deletedCourse.status === 404, 'Only the test-created course must be cleaned up');
        }
      }
      if (settingsHash) {
        assert.equal(hash(JSON.stringify((await ok('/admin/kb', { token })).settings)), settingsHash, 'The test must never change saved model settings');
        const surviving = (await ok('/admin/kb/bundles', { token })).bundles.map(bundle => bundle.id);
        for (const id of previousBundles) assert.ok(surviving.includes(id), 'A pre-existing bundle was removed');
      }
      record(preserve ? 'preserved-on-failure' : 'cleanup', { bundleId, removed: !preserve, generationIds: [...generationIds] });
    } finally {
      await writeFile(logPath, JSON.stringify(events, null, 2), 'utf8');
      t.diagnostic(`Sanitized ingestion trace: ${logPath}`);
    }
  }
});
