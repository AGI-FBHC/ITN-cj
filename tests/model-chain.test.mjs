import assert from 'node:assert/strict';
import test from 'node:test';

// Opt-in end-to-end check of the model chain (embeddings + chat). It talks to a
// local OpenAI-compatible mock instead of a real provider:
//   python tools/mock-model-server.py --port 8790
//   ZHIXUN_MODEL_API_KEY=mock ZHIXUN_MOCK_MODEL_URL=http://127.0.0.1:8790/v1 \
//   ZHIXUN_ADMIN_PASSWORD=... node --test --test-concurrency=1 tests/model-chain.test.mjs
// Restarts the backend with ZHIXUN_MODEL_API_KEY set so the service can see a key.
const api = (process.env.ZHIXUN_TEST_API || 'http://127.0.0.1:8312/api').replace(/\/$/, '');
const account = process.env.ZHIXUN_ADMIN_ACCOUNT || 'admin';
const password = process.env.ZHIXUN_ADMIN_PASSWORD || '';
const modelUrl = process.env.ZHIXUN_MOCK_MODEL_URL || '';

async function raw(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90000),
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

test('model chain embeds, retrieves and answers through a real HTTP endpoint', {
  timeout: 240000,
  skip: !modelUrl ? 'ZHIXUN_MOCK_MODEL_URL is not set' : (password === '' ? 'ZHIXUN_ADMIN_PASSWORD is not set' : false),
}, async (t) => {
  const login = await ok('/admin/login', { method: 'POST', body: { account, password } });
  const token = login.token;
  const before = await ok('/admin/kb', { token });
  assert.equal(before.settings.keyConfigured, true, 'start the backend with ZHIXUN_MODEL_API_KEY set');

  const settings = {
    baseUrl: modelUrl,
    embeddingModel: 'mock-embed',
    chatModel: 'mock-chat',
    embeddingDim: 64,
    batchSize: 8,
    chunkSize: 400,
    chunkOverlap: 60,
    topK: 4,
  };
  await ok('/admin/kb/settings', { token, method: 'PUT', body: settings });
  let documentId = '';
  try {
    await t.test('the embedding endpoint is reachable and reports a dimension', async () => {
      const connection = await ok('/admin/kb/test', { token, method: 'POST', body: {} });
      assert.equal(connection.ok, true);
      assert.ok(connection.dim > 0);
    });

    await t.test('ingest stores quantised vectors for every chunk', async () => {
      const created = await ok('/admin/kb/documents', {
        token, method: 'POST',
        body: {
          title: '模型联调文档',
          content: '# 栈与队列\n\n## 循环队列\n\n循环队列用取模把队尾绕回数组开头，需要额外记录元素个数，否则队空与队满判定相同。\n\n## 顺序栈\n\n顺序栈用连续空间保存元素，出栈前要先判断是否为空栈。\n',
        },
      });
      documentId = created.document.id;
      assert.ok(created.chunkCount > 0);
      assert.equal(created.embeddedCount, created.chunkCount, 'every chunk should get a vector');
      assert.equal(created.note, '');
      const detail = await ok(`/admin/kb/documents/${documentId}`, { token });
      assert.ok(detail.chunks.every((chunk) => chunk.hasVector));
    });

    await t.test('retrieval reports vector + keyword fusion', async () => {
      const result = await ok('/admin/kb/search', { token, method: 'POST', body: { query: '循环队列 队满 判定', topK: 3 } });
      assert.equal(result.degraded, false);
      assert.ok(result.mode.includes('向量'), result.mode);
      assert.ok(result.hits.length > 0);
      assert.ok(result.hits[0].headingPath.includes('循环队列'), result.hits[0].headingPath);
    });

    await t.test('the tutor answers with citations from the knowledge base', async () => {
      const visitor = await ok('/session', { method: 'POST', body: {} });
      const answer = await ok('/tutor/chat', {
        token: visitor.token, method: 'POST',
        body: { message: '循环队列怎么判断队满？', courseId: 'ds', lessonIndex: 1, lessonTitle: '栈与队列' },
      });
      assert.ok(answer.answer.length > 10, 'answer must not be empty');
      assert.ok(Array.isArray(answer.citations) && answer.citations.length > 0, 'citations must be returned');
      assert.ok(answer.citations[0].documentTitle.includes('模型联调'));
      const history = await ok('/tutor/history', { token: visitor.token });
      assert.ok(history.messages.length >= 2, 'the exchange should be persisted');
      assert.equal(history.messages[history.messages.length - 1].role, 'assistant');
    });
  } finally {
    if (documentId) await raw(`/admin/kb/documents/${documentId}`, { token, method: 'DELETE' });
    await raw('/admin/kb/settings', {
      token, method: 'PUT',
      body: { ...before.settings, baseUrl: '', embeddingModel: '', chatModel: '' },
    });
  }
});
