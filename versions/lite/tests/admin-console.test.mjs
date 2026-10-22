import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

// Admin console contract tests. They run against the isolated learning-v2 API and
// clean up the course they create. Provide credentials through the environment:
//   ZHIXUN_ADMIN_PASSWORD=... ZHIXUN_TEST_API=http://127.0.0.1:8312/api node --test tests/admin-console.test.mjs
const api = (process.env.ZHIXUN_TEST_API || 'http://127.0.0.1:8312/api').replace(/\/$/, '');
const account = process.env.ZHIXUN_ADMIN_ACCOUNT || 'admin';
const password = process.env.ZHIXUN_ADMIN_PASSWORD || '';

async function call(path, { token, method = 'GET', body, expect } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const raw = await response.text();
  let json;
  try { json = raw ? JSON.parse(raw) : {}; }
  catch { assert.fail(`${method} ${path}: expected JSON, received HTTP ${response.status}: ${raw.slice(0, 200)}`); }
  if (expect === undefined) {
    assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}, ${JSON.stringify(json)}`);
  } else {
    assert.equal(response.status, expect, `${method} ${path}: expected HTTP ${expect}, received ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

const lessonPath = (courseId, index) => `/courses/${encodeURIComponent(courseId)}/lessons/${index}`;

test('admin console manages course content and keeps learners isolated from drafts', { timeout: 180000, skip: password === '' ? 'ZHIXUN_ADMIN_PASSWORD is not set' : false }, async (t) => {
  const login = await call('/admin/login', { method: 'POST', body: { account, password } });
  assert.equal(typeof login.token, 'string');
  assert.equal(login.role, 'admin');
  const token = login.token;

  await call('/admin/login', { method: 'POST', body: { account, password: `${password}-wrong` }, expect: 401 });
  await call('/admin/overview', { expect: 401 });
  await call('/admin/overview', { token: 'x'.repeat(40), expect: 401 });

  await t.test('a learner account cannot reach the admin API', async () => {
    const visitor = await call('/session', { method: 'POST', body: {} });
    await call('/admin/overview', { token: visitor.token, expect: 403 });
  });

  const overview = await call('/admin/overview', { token });
  for (const group of ['users', 'courses', 'lessons', 'quiz', 'learning']) {
    assert.ok(overview[group] && typeof overview[group] === 'object', `Overview needs ${group}`);
  }
  assert.equal(typeof overview.courses.total, 'number');
  assert.equal(typeof overview.lessons.total, 'number');

  const courseId = `adm-${randomUUID().slice(0, 8)}`;
  const created = await call('/admin/courses', {
    token, method: 'POST',
    body: {
      id: courseId, name: '管理端联调课程', description: '由自动化测试创建的课程',
      level: '入门', duration: 60, sourceLabel: '自动化测试', icon: '',
    },
  });
  assert.equal(created.course.id, courseId);
  assert.equal(created.course.status, 'draft', 'A new course must start as a draft');
  assert.deepEqual(created.lessons, []);
  assert.equal(created.course.name, '管理端联调课程');

  await call('/admin/courses', { token, method: 'POST', body: { id: courseId, name: '重复编号' }, expect: 409 });
  await call('/admin/courses', { token, method: 'POST', body: { id: 'Invalid Id!', name: '非法编号' }, expect: 400 });

  const visitor = await call('/session', { method: 'POST', body: {} });
  const draftCatalog = await call('/courses', { token: visitor.token });
  assert.ok(!draftCatalog.courses.some(course => course.id === courseId), 'Drafts must not appear in the learner catalog');
  await call(lessonPath(courseId, 0), { token: visitor.token, expect: 404 });

  await t.test('publishing exposes the course and lessons to learners', async () => {
    const published = await call(`/admin/courses/${courseId}/status`, { token, method: 'POST', body: { status: 'published' } });
    assert.equal(published.course.status, 'published');
    const catalog = await call('/courses', { token: visitor.token });
    assert.ok(catalog.courses.some(course => course.id === courseId));
  });

  await t.test('lessons keep learner-facing answers hidden', async () => {
    const appended = await call(`/admin/courses/${courseId}/lessons`, { token, method: 'POST', body: {} });
    assert.equal(appended.index, 0);
    const content = {
      sections: [{ id: 'section-0', eyebrow: '核心概念', heading: '第一课', text: '管理端写入的讲义正文，用于验证结构化编辑与保存。' }],
      slides: [{ title: '第一课', subtitle: '要点', bullets: ['管理端写入'], notes: '备注' }],
      sourceLabel: '自动化测试',
    };
    const quiz = [{
      id: 'question-0', question: '这道题来自管理端吗？', options: ['是', '不是'],
      correct: 0, explanation: '由管理端保存。', theoryTitle: '管理端',
    }];
    const saved = await call(`/admin/courses/${courseId}/lessons/0`, {
      token, method: 'PUT',
      body: {
        title: '第一课：管理端讲义',
        contentJson: JSON.stringify(content),
        quizJson: JSON.stringify(quiz),
        sourcesJson: '[]',
      },
    });
    assert.equal(saved.title, '第一课：管理端讲义');
    assert.deepEqual(JSON.parse(saved.contentJson), content);
    assert.deepEqual(JSON.parse(saved.quizJson), quiz);

    const lesson = await call(lessonPath(courseId, 0), { token: visitor.token });
    assert.equal(lesson.title, '第一课：管理端讲义');
    assert.equal(lesson.questions.length, 1);
    assert.equal(lesson.questions[0].question, '这道题来自管理端吗？');
    for (const key of ['correct', 'answer', 'correctIndex', 'explanation']) {
      assert.ok(!(key in lesson.questions[0]), `Learner payload must not expose ${key}`);
    }
    const graded = await call(`${lessonPath(courseId, 0)}/answer`, {
      token: visitor.token, method: 'POST', body: { questionId: 'question-0', choice: 0 },
    });
    assert.equal(graded.correct, true);
    assert.equal(graded.correctIndex, 0);

    const detail = await call(`/admin/courses/${courseId}`, { token });
    assert.equal(detail.course.lessonCount, 1);
    assert.equal(detail.lessons[0].sectionCount, 1);
    assert.equal(detail.lessons[0].questionCount, 1);
  });

  await t.test('invalid lesson payloads are rejected with a readable reason', async () => {
    const base = { title: '无效课时', contentJson: '{}', quizJson: '[]', sourcesJson: '[]' };
    const cases = [
      [{ ...base, title: '' }, '课时标题'],
      [{ ...base, contentJson: 'not json' }, '讲义内容'],
      [{ ...base, contentJson: '[]' }, '讲义内容'],
      [{ ...base, quizJson: '[{"question":"缺选项","options":[],"correct":0}]' }, '两个选项'],
      [{ ...base, quizJson: '[{"question":"答案越界","options":["A","B"],"correct":5}]' }, '超出选项范围'],
      [{ ...base, quizJson: '[{"options":["A","B"],"correct":0}]' }, '缺少题干'],
    ];
    for (const [body, expected] of cases) {
      const response = await rawRequest(`/admin/courses/${courseId}/lessons/0`, { token, method: 'PUT', body });
      assert.equal(response.status, 400, `Expected 400 for ${JSON.stringify(body).slice(0, 60)}`);
      assert.ok(response.json.message.includes(expected), `Message should mention ${expected}: ${response.json.message}`);
    }
    const unchanged = await call(`/admin/courses/${courseId}/lessons/0`, { token });
    assert.equal(unchanged.title, '第一课：管理端讲义', 'Rejected writes must not change stored content');
  });

  await t.test('only the last lesson can be deleted', async () => {
    const second = await call(`/admin/courses/${courseId}/lessons`, { token, method: 'POST', body: {} });
    assert.equal(second.index, 1);
    await call(`/admin/courses/${courseId}/lessons/0`, { token, method: 'DELETE', expect: 409 });
    await call(`/admin/courses/${courseId}/lessons/1`, { token, method: 'DELETE' });
    const detail = await call(`/admin/courses/${courseId}`, { token });
    assert.equal(detail.lessons.length, 1);
    assert.equal(detail.course.lessonCount, 1);
  });

  await t.test('unpublishing hides the course and its lessons again', async () => {
    await call(`/admin/courses/${courseId}/status`, { token, method: 'POST', body: { status: 'draft' } });
    const catalog = await call('/courses', { token: visitor.token });
    assert.ok(!catalog.courses.some(course => course.id === courseId));
    await call(lessonPath(courseId, 0), { token: visitor.token, expect: 404 });
    await call(`/admin/courses/${courseId}/status`, { token, method: 'POST', body: { status: 'weird' }, expect: 400 });
  });

  await t.test('learner list includes visitors and their progress counters', async () => {
    const users = await call('/admin/users', { token });
    const row = users.users.find(item => item.id === visitor.userId);
    assert.ok(row, 'The visitor must appear in the admin user list');
    assert.equal(row.profiled, false, 'A visitor without onboarding has no profile');
    assert.equal(typeof row.progressCount, 'number');
    assert.equal(typeof row.completedCount, 'number');
    assert.ok(!users.users.some(item => item.account === account), 'Admin accounts stay out of the learner list');
  });

  await t.test('an unused course can be deleted and leaves the admin list', async () => {
    const deleted = await call(`/admin/courses/${courseId}`, { token, method: 'DELETE' });
    assert.equal(deleted.deleted, true);
    const courses = await call('/admin/courses', { token });
    assert.ok(!courses.courses.some(course => course.id === courseId));
    await call(`/admin/courses/${courseId}`, { token, expect: 404 });
  });
});

async function rawRequest(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const raw = await response.text();
  let json = {};
  try { json = raw ? JSON.parse(raw) : {}; } catch { json = { message: raw }; }
  return { status: response.status, json };
}
