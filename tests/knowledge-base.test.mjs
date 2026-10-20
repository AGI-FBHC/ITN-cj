import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

// Knowledge base contract tests. They run against the isolated learning-v2 API and
// clean up after themselves. Vector search is only exercised when a model endpoint
// is configured; without one the pipeline must degrade to keyword retrieval.
//   ZHIXUN_ADMIN_PASSWORD=... node --test --test-concurrency=1 tests/knowledge-base.test.mjs
const api = (process.env.ZHIXUN_TEST_API || 'http://127.0.0.1:8312/api').replace(/\/$/, '');
const account = process.env.ZHIXUN_ADMIN_ACCOUNT || 'admin';
const password = process.env.ZHIXUN_ADMIN_PASSWORD || '';
// 共享开发库里可能已经有别的文档，用随机标记保证排序断言只对本轮文档生效。
const MARK = randomUUID().slice(0, 8);

async function raw(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text.slice(0, 200) }; }
  return { status: response.status, json };
}

async function ok(path, options = {}) {
  const response = await raw(path, options);
  assert.ok(response.status < 400, `${options.method || 'GET'} ${path}: HTTP ${response.status} ${JSON.stringify(response.json)}`);
  return response.json;
}

const DOC_A = `# 栈与队列

## 顺序栈

顺序栈用一段连续空间保存元素，栈顶指针指向下一个空位。入栈时先写入再移动指针，
出栈时需要先判断是否为空栈，否则会读到未定义的数据。

## 循环队列

循环队列用取模运算把队尾绕回数组开头，代价是需要额外记录当前元素个数，
否则队空与队满的判定会变成同一个条件。校验标记 ${MARK}。

# 复杂度

栈与队列的入队出队操作都是 O(1)，这是它们相比有序数组的主要优势。
`;

const DOC_B = `# 图的最短路径

## Dijkstra 算法

Dijkstra 算法适用于边权非负的图，每次从未确定的顶点里取距离最小的一个做松弛，
时间复杂度在使用二叉堆时是 O((V+E) log V)。

## Bellman-Ford

Bellman-Ford 允许负权边，代价是要做 V-1 轮松弛，因此更慢但更通用。校验标记 ${MARK}。
`;

test('knowledge base ingests, chunks and retrieves documents', { timeout: 180000, skip: password === '' ? 'ZHIXUN_ADMIN_PASSWORD is not set' : false }, async (t) => {
  const login = await ok('/admin/login', { method: 'POST', body: { account, password } });
  const token = login.token;
  const created = [];

  await t.test('learners cannot reach the knowledge base', async () => {
    const visitor = await ok('/session', { method: 'POST', body: {} });
    const response = await raw('/admin/kb', { token: visitor.token });
    assert.equal(response.status, 403);
    assert.equal((await raw('/admin/kb', {})).status, 401);
  });

  const overview = await ok('/admin/kb', { token });
  assert.ok(Array.isArray(overview.documents));
  assert.ok(overview.settings && typeof overview.settings === 'object');
  assert.equal(typeof overview.settings.chunkSize, 'number');
  assert.equal(typeof overview.settings.keyConfigured, 'boolean');
  const vectorReady = overview.settings.keyConfigured && overview.settings.embeddingModel !== '';

  await t.test('uploading markdown produces heading-aware chunks', async () => {
    const response = await ok('/admin/kb/documents', {
      token, method: 'POST', body: { title: '数据结构精讲', content: DOC_A, sourceName: 'stack.md', sourceType: 'upload' },
    });
    created.push(response.document.id);
    assert.equal(response.document.title, '数据结构精讲');
    assert.equal(response.document.status, 'ready');
    assert.ok(response.chunkCount >= 2, `expected multiple chunks, got ${response.chunkCount}`);
    assert.equal(response.document.chunkCount, response.chunkCount);
    assert.equal(response.document.embeddingModel !== '', response.embeddedCount > 0);

    const detail = await ok(`/admin/kb/documents/${response.document.id}`, { token });
    assert.equal(detail.chunks.length, response.chunkCount);
    const paths = detail.chunks.map((chunk) => chunk.headingPath);
    assert.ok(paths.some((path) => path.includes('顺序栈')), `heading path missing: ${paths.join(' | ')}`);
    assert.ok(paths.some((path) => path.includes('循环队列')), `heading path missing: ${paths.join(' | ')}`);
    assert.ok(paths.some((path) => path.includes('数据结构精讲')), 'document title should be the root of the path');
    for (const chunk of detail.chunks) {
      assert.ok(chunk.text.length > 0);
      assert.ok(chunk.charCount > 0);
      assert.equal(chunk.hasVector, response.embeddedCount > 0);
    }
  });

  const second = await ok('/admin/kb/documents', {
    token, method: 'POST', body: { title: '图算法笔记', content: DOC_B, sourceName: 'graph.md' },
  });
  created.push(second.document.id);

  await t.test('search ranks the matching document first', async () => {
    const result = await ok('/admin/kb/search', { token, method: 'POST', body: { query: `循环队列取模绕回 ${MARK}`, topK: 4 } });
    assert.ok(result.hits.length > 0, 'search must return hits');
    assert.equal(result.hits[0].documentTitle, '数据结构精讲');
    assert.ok(result.hits[0].text.includes('循环队列') || result.hits[0].headingPath.includes('循环队列'));
    assert.equal(typeof result.mode, 'string');
    assert.ok(result.mode.includes('关键词'), `mode should mention keyword retrieval: ${result.mode}`);

    const graph = await ok('/admin/kb/search', { token, method: 'POST', body: { query: `Bellman-Ford 负权边 ${MARK}`, topK: 4 } });
    assert.ok(graph.hits.length > 0);
    assert.equal(graph.hits[0].documentTitle, '图算法笔记');

    if (vectorReady) {
      assert.equal(result.degraded, false, `vector search should be active: ${result.note}`);
      assert.ok(result.mode.includes('向量'), `mode should mention vectors: ${result.mode}`);
    } else {
      assert.equal(result.degraded, true);
      assert.ok(result.note.includes('向量模型'), `note should explain degradation: ${result.note}`);
    }
  });

  await t.test('empty or unknown queries and documents are rejected politely', async () => {
    assert.equal((await raw('/admin/kb/search', { token, method: 'POST', body: { query: '   ' } })).status, 400);
    assert.equal((await raw('/admin/kb/documents/not-exist', { token })).status, 404);
    assert.equal((await raw('/admin/kb/documents', { token, method: 'POST', body: { title: '', content: '内容' } })).status, 400);
    assert.equal((await raw('/admin/kb/documents', { token, method: 'POST', body: { title: '空文档', content: '   ' } })).status, 400);
  });

  await t.test('settings stay validated and reindexing is idempotent', async () => {
    const before = await ok('/admin/kb', { token });
    const bad = await raw('/admin/kb/settings', {
      token, method: 'PUT',
      body: { ...before.settings, chunkSize: 100, chunkOverlap: 60 },
    });
    assert.equal(bad.status, 400, 'chunk size below 200 must be rejected');
    const badOverlap = await raw('/admin/kb/settings', {
      token, method: 'PUT',
      body: { ...before.settings, chunkSize: 600, chunkOverlap: 400 },
    });
    assert.equal(badOverlap.status, 400, 'overlap above half the chunk size must be rejected');
    const saved = await ok('/admin/kb/settings', { token, method: 'PUT', body: before.settings });
    assert.equal(saved.settings.chunkSize, before.settings.chunkSize);

    const reindexed = await ok(`/admin/kb/documents/${created[0]}/reindex`, { token, method: 'POST', body: {} });
    assert.ok(reindexed.chunkCount >= 2);
    const detail = await ok(`/admin/kb/documents/${created[0]}`, { token });
    assert.equal(detail.chunks.length, reindexed.chunkCount);
  });

  await t.test('model connection test explains a missing configuration', async () => {
    if (vectorReady) {
      const response = await raw('/admin/kb/test', { token, method: 'POST', body: {} });
      assert.ok(response.status === 200 || response.status === 502, `unexpected status ${response.status}`);
      return;
    }
    const response = await raw('/admin/kb/test', { token, method: 'POST', body: {} });
    assert.equal(response.status, 400);
    assert.ok(response.json.message.includes('ZHIXUN_MODEL_API_KEY'), response.json.message);
  });

  await t.test('the tutor refuses politely when no chat model is configured', async () => {
    const visitor = await ok('/session', { method: 'POST', body: {} });
    const current = (await ok('/admin/kb', { token })).settings;
    if (current.chatModel !== '' && current.keyConfigured) {
      // 配了真实模型时不打真实网络，只验证接口存在且鉴权正常。
      const response = await raw('/tutor/history', { token: visitor.token });
      assert.equal(response.status, 200);
      return;
    }
    const response = await raw('/tutor/chat', {
      token: visitor.token, method: 'POST',
      body: { message: '循环队列怎么判断队满？', courseId: 'ds', lessonIndex: 1 },
    });
    assert.equal(response.status, 503);
    assert.ok(response.json.message.includes('AI 导师还没有接入模型'), response.json.message);
    const empty = await raw('/tutor/chat', { token: visitor.token, method: 'POST', body: { message: '   ' } });
    assert.equal(empty.status, 400);
  });
  await t.test('deleting a document removes it from retrieval', async () => {
    const removed = await ok(`/admin/kb/documents/${created[1]}`, { token, method: 'DELETE' });
    assert.equal(removed.deleted, true);
    const result = await ok('/admin/kb/search', { token, method: 'POST', body: { query: `Bellman-Ford 负权边 ${MARK}`, topK: 4 } });
    assert.ok(!result.hits.some((hit) => hit.documentTitle === '图算法笔记'), 'deleted document must not be retrieved');
    assert.equal((await raw(`/admin/kb/documents/${created[1]}`, { token })).status, 404);
    created.pop();
  });

  for (const id of created) {
    await ok(`/admin/kb/documents/${id}`, { token, method: 'DELETE' });
  }
  const after = await ok('/admin/kb', { token });
  assert.ok(!after.documents.some((doc) => created.includes(doc.id)), 'test documents must be cleaned up');
});
