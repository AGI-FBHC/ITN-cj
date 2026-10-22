import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivityGrid, popularResourceTarget, rankPopularResources, validateDashboardInsights } from '../src/dashboard-insights.js';

const activity = { today: '2026-10-22', startDate: '2026-06-05', endDate: '2026-10-22', learningDays: 2,
  days: [{ date: '2026-10-21', count: 1 }, { date: '2026-10-22', count: 3 }] };

test('activity cells use server calendar dates and never invent future activity', () => {
  const cells = buildActivityGrid(activity);
  assert.equal(cells.length, 140);
  assert.equal(cells.find((cell) => cell.date === '2026-10-22').count, 3);
  assert.equal(cells.find((cell) => cell.date === '2026-10-21').level, 1);
  assert.ok(cells.filter((cell) => cell.date > activity.today).every((cell) => cell.count === null));
  assert.ok(cells.filter((cell) => cell.date < '2026-10-21').every((cell) => cell.count === 0 || cell.count === null));
});

test('ranking uses learner totals and keeps the input list unchanged', () => {
  const input = [{ id: 'a', learnerCount: 1 }, { id: 'b', learnerCount: 9 }, { id: 'c', learnerCount: 4 }];
  assert.deepEqual(rankPopularResources(input).map((item) => item.id), ['b', 'c', 'a']);
  assert.deepEqual(input.map((item) => item.id), ['a', 'b', 'c']);
});

test('ranked resources navigate only to accessible chapters with the right resource mode', () => {
  const course = { id: 'course-a', chapters: [{ title: 'chapter', resourceTypes: ['lecture', 'slides', 'bank'] }] };
  for (const [kind, mode] of [['lecture', 'lecture'], ['slides', 'presentation'], ['bank', 'quiz']]) {
    assert.equal(popularResourceTarget({ courseId: course.id, lessonIndex: 0, kind }, [course]).mode, mode);
  }
  assert.equal(popularResourceTarget({ courseId: 'missing', lessonIndex: 0, kind: 'lecture' }, [course]), null);
  assert.equal(popularResourceTarget({ courseId: course.id, lessonIndex: 1, kind: 'lecture' }, [course]), null);
  assert.equal(popularResourceTarget({ courseId: course.id, lessonIndex: 0, kind: 'guide' }, [course]), null);
});

test('invalid calendar/count payloads produce explicit errors', () => {
  assert.equal(validateDashboardInsights({ activity, popularResources: [] }).activity.learningDays, 2);
  assert.throws(() => validateDashboardInsights({ activity: { ...activity, today: '2026-02-30' }, popularResources: [] }));
  assert.throws(() => validateDashboardInsights({ activity, popularResources: [{ learnerCount: -1 }] }));
});
