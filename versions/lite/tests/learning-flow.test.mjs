import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

// Run only against the isolated learning-v2 development API. Creates two fresh
// visitor accounts per run; never reads credentials or connects to MySQL itself.
// ZHIXUN_TEST_API=http://127.0.0.1:8312/api node --test tests/learning-flow.test.mjs
const api = (process.env.ZHIXUN_TEST_API || 'http://127.0.0.1:8312/api').replace(/\/$/, '');

async function request(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const raw = await response.text();
  let json;
  try { json = JSON.parse(raw); }
  catch { assert.fail(`${method} ${path}: expected JSON, received HTTP ${response.status}: ${raw.slice(0, 200)}`); }
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}, ${JSON.stringify(json)}`);
  return json;
}

function assertNoAnswers(value, location = 'questions') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!/^(correct|answer|correctIndex|correctAnswer|answerIndex)$/i.test(key),
      `Standard answer leaked at ${location}.${key}`);
    assertNoAnswers(child, `${location}.${key}`);
  }
}

function lessonPath(courseId, index) {
  return `/courses/${encodeURIComponent(courseId)}/lessons/${index}`;
}

// 课程现在由管理端上传知识库后发布生成；没有已发布课程时本用例没有可跑的内容。
const catalogReady = await (async () => {
  try {
    const session = await request('/session', { method: 'POST', body: {} });
    const catalog = await request('/courses', { token: session.token });
    return Array.isArray(catalog.courses) && catalog.courses.length > 0;
  } catch {
    return false;
  }
})();

test('visitor learning flow persists and isolates server-owned learning state', {
  timeout: 120000,
  skip: catalogReady ? false : '没有已发布课程：请先在管理端上传知识库并发布课程',
}, async (t) => {
  await request('/health');
  const first = await request('/session', { method: 'POST', body: {} });
  const second = await request('/session', { method: 'POST', body: {} });
  for (const session of [first, second]) {
    assert.equal(typeof session.token, 'string');
    assert.ok(session.token.length > 0);
    assert.equal(typeof session.userId, 'string');
    assert.ok(session.userId.length > 0);
  }
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.userId, second.userId);
  const token = first.token;
  const bootstrap = await request('/bootstrap', { token });
  assert.ok(Array.isArray(bootstrap.courses) && bootstrap.courses.length > 0, 'Seeded catalog must be available');
  assert.equal(bootstrap.profile, null, 'A fresh visitor must not inherit another profile');

  await t.test('profile is saved and recovered with the same session only', async () => {
    const profile = {
      name: `integration-${randomUUID().slice(0, 8)}`,
      education: '本科', field: '计算机', goal: '学习课程',
      interests: ['编程'], learningStyle: '实践', dailyTime: 30,
    };
    await request('/profile', { token, method: 'PUT', body: profile });
    assert.deepEqual((await request('/bootstrap', { token })).profile, profile);
    assert.equal((await request('/bootstrap', { token: second.token })).profile, null);
  });

  const catalog = await request('/courses', { token });
  assert.ok(Array.isArray(catalog.courses) && catalog.courses.length > 0);
  assertNoAnswers(catalog.courses, 'courses');
  let chosen;
  for (const course of catalog.courses) {
    assert.ok(Array.isArray(course.chapters), `Course ${course.id} needs chapter metadata`);
    for (let index = 0; index < course.chapters.length; index++) {
      const path = lessonPath(course.id, index);
      const lesson = await request(path, { token });
      assertNoAnswers(lesson.questions);
      if (Array.isArray(lesson.questions) && lesson.questions.length > 0 &&
          lesson.questions.every(q => q.id && Array.isArray(q.options) && q.options.length >= 2)) {
        chosen = { course, index, path, lesson };
        break;
      }
    }
    if (chosen) break;
  }
  assert.ok(chosen, 'Catalog needs at least one real lesson with answerable questions');
  const { course, index, path, lesson } = chosen;
  const questions = lesson.questions;
  assert.ok(lesson.content && (typeof lesson.content !== 'object' || Object.keys(lesson.content).length), 'Lesson content must be available');

  await t.test('reading progress persists but client cannot grant completion or score', async () => {
    await request(`${path}/progress`, {
      token, method: 'PUT', body: { read: true, score: 100, completed: true },
    });
    const restored = (await request(path, { token })).progress;
    assert.ok(restored?.read === true || restored?.isRead === true || restored?.is_read === true,
      'A new lesson request must recover read progress');
    assert.ok(!restored.completed, 'Reading alone must not complete the quiz');
    assert.ok(restored.score == null || restored.score === 0, 'Client score must be ignored');
    const other = (await request(path, { token: second.token })).progress;
    assert.ok(!other?.read && !other?.isRead && !other?.is_read && !other?.completed,
      'Another visitor must not inherit read progress');
  });

  const correctAnswers = [];
  await t.test('individual answers are graded by the server', async () => {
    for (const question of questions) {
      const result = await request(`${path}/answer`, {
        token, method: 'POST', body: { questionId: question.id, choice: 0, correct: true },
      });
      assert.ok(Number.isInteger(result.correctIndex));
      assert.ok(result.correctIndex >= 0 && result.correctIndex < question.options.length);
      assert.equal(result.correct, result.correctIndex === 0);
      assert.equal(typeof result.explanation, 'string');
      const wrongChoice = (result.correctIndex + 1) % question.options.length;
      const wrong = await request(`${path}/answer`, {
        token, method: 'POST', body: { questionId: question.id, choice: wrongChoice, correct: true },
      });
      assert.equal(wrong.correct, false, 'Client-provided correctness must not override grading');
      correctAnswers.push({ questionId: question.id, choice: result.correctIndex });
    }
    assertNoAnswers((await request(path, { token })).questions);
  });
  assert.equal(correctAnswers.length, questions.length, 'Cannot test scoring without valid server answers');
  const wrongAnswers = correctAnswers.map((answer, i) => ({
    questionId: answer.questionId,
    choice: (answer.choice + 1) % questions[i].options.length,
  }));

  await t.test('quiz ignores fabricated score and persists a failed attempt', async () => {
    const failed = await request(`${path}/quiz`, {
      token, method: 'POST', body: {
        attemptId: randomUUID(), answers: wrongAnswers, durationSeconds: 12,
        score: 100, correctCount: questions.length, completed: true,
      },
    });
    assert.equal(failed.score, 0);
    assert.equal(failed.correctCount, 0);
    assert.equal(failed.total, questions.length);
    assert.equal(failed.completed, false);
    const restored = (await request(path, { token })).progress;
    assert.equal(restored.score, 0);
    assert.ok(!restored.completed);
  });

  await t.test('successful quiz persists and repeated attemptId cannot duplicate or rewrite it', async () => {
    const attemptId = randomUUID();
    const passed = await request(`${path}/quiz`, {
      token, method: 'POST', body: { attemptId, answers: correctAnswers, durationSeconds: 20, score: 0 },
    });
    assert.equal(passed.score, 100);
    assert.equal(passed.correctCount, questions.length);
    assert.equal(passed.total, questions.length);
    assert.equal(passed.completed, true);
    const before = await request('/bootstrap', { token });
    const retry = await request(`${path}/quiz`, {
      token, method: 'POST', body: { attemptId, answers: wrongAnswers, durationSeconds: 9999, score: 0 },
    });
    for (const key of ['score', 'correctCount', 'total', 'completed']) assert.equal(retry[key], passed[key]);
    const after = await request('/bootstrap', { token });
    assert.deepEqual(after.stats, before.stats, 'Replaying one attempt must not increment aggregate stats');
    const restored = (await request(path, { token })).progress;
    assert.equal(restored.score, 100);
    assert.ok(restored.completed);
    const refreshed = (await request('/courses', { token })).courses.find(item => item.id === course.id);
    assert.ok(refreshed.chapters[index].done, 'Course list must recover completed chapter state');
    const other = (await request(path, { token: second.token })).progress;
    assert.ok(!other?.completed && (other?.score == null || other?.score === 0), 'Quiz results must be user scoped');
  });

  await t.test('favorites and bookmarks survive refresh without leaking across users', async () => {
    const bookmark = { id: randomUUID(), courseId: course.id, lessonIndex: index, title: lesson.title, text: 'Integration reading bookmark' };
    const state = { favorites: [course.id], bookmarks: [bookmark] };
    await request('/state', { token, method: 'PUT', body: state });
    const restored = await request('/bootstrap', { token });
    assert.deepEqual(restored.favorites, state.favorites);
    assert.deepEqual(restored.bookmarks, state.bookmarks);
    const other = await request('/bootstrap', { token: second.token });
    assert.deepEqual(other.favorites, []);
    assert.deepEqual(other.bookmarks, []);
    await request('/state', { token: second.token, method: 'PUT', body: { favorites: [], bookmarks: [] } });
    assert.deepEqual((await request('/bootstrap', { token })).bookmarks, state.bookmarks);
    await request('/state', { token, method: 'PUT', body: { favorites: [], bookmarks: [] } });
    const cleared = await request('/bootstrap', { token });
    assert.deepEqual(cleared.favorites, []);
    assert.deepEqual(cleared.bookmarks, []);
  });
});
