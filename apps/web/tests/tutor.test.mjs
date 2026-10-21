import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { askTutor, getTutorHistory, tutorHistory } from '../src/tutor.js';

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
