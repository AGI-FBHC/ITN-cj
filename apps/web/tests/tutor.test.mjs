import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { askTutor, askTutorStream, createTutorConversation, updateTutorConversation, deleteTutorConversation, getTutorConversations, getTutorHistory, tutorHistory } from '../src/tutor.js';

const originalFetch = globalThis.fetch;
const originalStorage = globalThis.localStorage;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; });

test('history sends only recent completed messages in chronological order', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: String(index) }));
  messages.push({ role: 'system', text: 'never forward system content' });
  messages.push({ role: 'assistant', text: 'loading', pending: true });
  messages.push({ role: 'assistant', text: 'welcome', greeting: true });
  messages.push({ role: 'user', text: 'failed', error: true });
  assert.deepEqual(tutorHistory(messages), messages.slice(8, 20).map(({ role, text }) => ({ role, content: text })));
});

test('Chinese history stays within the server UTF-8 byte budget', () => {
  const messages = Array.from({ length: 8 }, () => ({ role: 'user', text: '中'.repeat(4000) }));
  const history = tutorHistory(messages);
  assert.equal(history.length, 2);
  assert.equal(Buffer.byteLength(history.map((item) => item.content).join(''), 'utf8'), 24000);
  assert.equal(Array.from(tutorHistory([{ role: 'user', text: '😀'.repeat(5000) }])[0].content).length, 4000);
});

test('multimodal request preserves image-only input, auth and bounded history', async () => {
  let observed;
  globalThis.localStorage = { getItem: () => 'test-session-token' };
  globalThis.fetch = async (url, options) => {
    observed = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ answer: '**看到了**', model: 'configured-chat-model' }), { status: 200 });
  };
  const result = await askTutor({ courseId: 'course-a', lessonIndex: 3, attachments: [{ id: 'client-only', type: 'image', name: 'question.webp', mimeType: 'image/webp', dataUrl: 'data:image/webp;base64,YQ==' }], history: [{ role: 'assistant', text: '上一轮回答' }] });
  assert.equal(observed.url, '/api/tutor/chat');
  assert.equal(observed.options.headers.Authorization, 'Bearer test-session-token');
  assert.equal(observed.body.message, '');
  assert.equal(observed.body.attachments.length, 1);
  assert.equal(observed.body.attachments[0].id, undefined);
  assert.deepEqual(observed.body.history, [{ role: 'assistant', content: '上一轮回答' }]);
  assert.equal(result.model, 'configured-chat-model');
});

test('history is requested with an explicit course/chapter scope', async () => {
  globalThis.localStorage = { getItem: () => '' };
  let url;
  globalThis.fetch = async (path) => {
    url = path;
    return new Response(JSON.stringify({ messages: [{ role: 'user', content: '问题' }, { role: 'assistant', content: '回答' }] }));
  };
  const history = await getTutorHistory({ courseId: 'a/b', lessonIndex: 2 });
  assert.equal(url, '/api/tutor/history?courseId=a%2Fb&lessonIndex=2');
  assert.equal(history.length, 2);
});

test('unsupported images and model failures remain explicit', async () => {
  await assert.rejects(askTutor({ attachments: [{ mimeType: 'image/gif' }] }), /PNG/);
  globalThis.localStorage = { getItem: () => '' };
  globalThis.fetch = async () => new Response(JSON.stringify({ message: '当前对话模型不支持图片' }), { status: 400 });
  await assert.rejects(askTutor({ message: '看图', attachments: [{ type: 'image', name: 'a.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,YQ==' }] }), /不支持图片/);
});

test('conversation management uses authenticated owner-scoped endpoints', async () => {
  globalThis.localStorage = { getItem: () => 'learner-session' };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method, headers: options.headers, body: options.body && JSON.parse(options.body) });
    return new Response(JSON.stringify({ conversationId: 'agent-a', items: [] }));
  };
  await createTutorConversation();
  await updateTutorConversation('lesson:a:0', { title: '网络分层' });
  await updateTutorConversation('lesson:a:0', { archived: true });
  await getTutorConversations({ archived: true });
  await deleteTutorConversation('lesson:a:0');
  assert.deepEqual(calls.map(({ url, method }) => [url, method]), [
    ['/api/tutor/conversations', 'POST'],
    ['/api/tutor/conversations/lesson%3Aa%3A0', 'PUT'],
    ['/api/tutor/conversations/lesson%3Aa%3A0', 'PUT'],
    ['/api/tutor/conversations?archived=true', 'GET'],
    ['/api/tutor/conversations/lesson%3Aa%3A0', 'DELETE'],
  ]);
  assert.ok(calls.every(({ headers }) => headers.Authorization === 'Bearer learner-session'));
  assert.equal(calls[1].body.title, '网络分层');
});

test('disabled context reaches SSE while interrupted messages stay out of model history', async () => {
  globalThis.localStorage = { getItem: () => 'learner-session' };
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response('data: {"type":"delta","text":"回答"}\n\ndata: {"type":"done","answer":"回答"}\n\n');
  };
  const result = await askTutorStream({ message: '解释', useContext: false, history: [
    { role: 'assistant', text: '部分输出', interrupted: true },
    { role: 'assistant', text: '尚未完成', streaming: true },
    { role: 'user', text: '此前问题' },
  ] });
  assert.equal(body.useContext, false);
  assert.deepEqual(body.history, [{ role: 'user', content: '此前问题' }]);
  assert.equal(result.answer, '回答');
  globalThis.fetch = async () => new Response('data: {"type":"delta","text":"未完成"}\n\n');
  await assert.rejects(askTutorStream({ message: '再试' }), /连接中断/);
});
