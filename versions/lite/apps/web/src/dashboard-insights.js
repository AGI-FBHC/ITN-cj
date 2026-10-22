const DAY_MS = 86400000;
const RESOURCE_MODES = {
  lecture: { mode: 'lecture', type: 'lecture', label: '讲义' },
  slides: { mode: 'presentation', type: 'slides', label: '幻灯片' },
  presentation: { mode: 'presentation', type: 'slides', label: '幻灯片' },
  bank: { mode: 'quiz', type: 'bank', label: '测验' },
  quiz: { mode: 'quiz', type: 'bank', label: '测验' },
};

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

export function validateDashboardInsights(data) {
  const activity = data?.activity;
  if (!activity || calendarDate(activity.today) === null || calendarDate(activity.startDate) === null
    || calendarDate(activity.endDate) === null || activity.startDate > activity.endDate
    || !Number.isInteger(activity.learningDays) || activity.learningDays < 0 || !Array.isArray(activity.days)
    || !Array.isArray(data.popularResources)
    || activity.days.some((day) => calendarDate(day?.date) === null || !Number.isInteger(day.count) || day.count < 0)
    || data.popularResources.some((item) => !item || !Number.isInteger(item.learnerCount) || item.learnerCount < 0)) {
    throw new Error('学习活跃与热门资源数据格式异常，请重试');
  }
  return data;
}

export function activityLevel(count) {
  if (!count) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  return count < 5 ? 3 : 4;
}

export function buildActivityGrid(activity) {
  if (!activity) return [];
  const today = calendarDate(activity.today);
  if (today === null) return [];
  // Use the server's calendar date, independent of the browser's time zone and DST.
  const weekday = (new Date(today).getUTCDay() + 6) % 7;
  const start = today - (19 * 7 + weekday) * DAY_MS;
  const counts = new Map(activity.days.map((day) => [day.date, day.count]));
  return Array.from({ length: 140 }, (_, index) => {
    const date = new Date(start + index * DAY_MS).toISOString().slice(0, 10);
    const available = date <= activity.today && date >= activity.startDate && date <= activity.endDate;
    const count = available ? counts.get(date) ?? 0 : null;
    return { date, count, level: activityLevel(count), future: date > activity.today };
  });
}

export function rankPopularResources(items = []) {
  return [...items].sort((a, b) => b.learnerCount - a.learnerCount);
}

export function popularResourceTarget(item, catalog = []) {
  const resource = RESOURCE_MODES[item?.kind];
  const course = catalog.find((entry) => entry.id === item?.courseId);
  if (!resource || !course || !Number.isInteger(item.lessonIndex) || item.lessonIndex < 0) return null;
  const lesson = course.chapters?.[item.lessonIndex];
  if (!lesson || (Array.isArray(lesson.resourceTypes) && !lesson.resourceTypes.includes(resource.type))) return null;
  return { course, lessonIndex: item.lessonIndex, mode: resource.mode };
}

export function popularResourceLabel(kind) {
  return RESOURCE_MODES[kind]?.label || '学习资源';
}
