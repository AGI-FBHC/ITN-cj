import { useEffect, useMemo, useState } from 'react';
import { useProfile } from '@/context/ProfileContext';
import { api } from '@/lib/api';
import type { Course, CourseChapter, LearningResourceSummary } from '@/lib/api';

const typeOrder = { lecture: 0, practice: 1, quiz: 2 } as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function learningResourcePath(resource: LearningResourceSummary): string {
  return `/learn/resource/${encodeURIComponent(resource.id)}`;
}

/* ------------------------------------------------------------------
 * 共享 store：同一学习者的所有消费组件共用一次加载与单一 20s 轮询，
 * 页面隐藏时暂停轮询、恢复可见立即校准，减少重复网络请求。
 * ------------------------------------------------------------------ */
interface CourseSnapshot {
  loading: boolean;
  course: Course | null;
  resources: LearningResourceSummary[];
  updatedAt: number;
}

const EMPTY_LOADING: CourseSnapshot = { loading: true, course: null, resources: [], updatedAt: 0 };
const snapshots = new Map<string, CourseSnapshot>();
const listeners = new Map<string, Set<() => void>>();
const timers = new Map<string, number>();
const visibleHandlers = new Map<string, () => void>();
const inFlight = new Map<string, Promise<void>>();

async function fetchCourseData(learnerId: string): Promise<CourseSnapshot> {
  try {
    const { courses } = await api.listCourses(learnerId);
    const latest = courses?.[0] ?? null;
    /*
     * 没有课程行 ≠ 没有学习资源。
     *
     * 后端 /learning-resources 不带 courseId 时返回的是"当前学习者的全部资源"（含按知识点定制的
     * 讲义/实操/分阶题），而课程表是另一张表：演示画像与只做定制、没建课程的学习者，
     * /v1/courses 会是空数组。以前这里直接给 resources: []，于是首页一边显示"已学 1/119 个知识点"，
     * 一边说"为你做好的资料 0 份"——数据明明在，页面却说没有。
     */
    const listed = latest
      ? await api.listLearningResources({ courseId: latest.id })
      : await api.listLearningResources();
    return { loading: false, course: latest, resources: listed.resources ?? [], updatedAt: Date.now() };
  } catch {
    return { loading: false, course: null, resources: [], updatedAt: Date.now() };
  }
}

function notify(learnerId: string): void {
  listeners.get(learnerId)?.forEach((fn) => fn());
}

function loadOnce(learnerId: string): void {
  if (inFlight.has(learnerId)) return;
  const promise = fetchCourseData(learnerId)
    .then((snapshot) => {
      snapshots.set(learnerId, snapshot);
      notify(learnerId);
    })
    .finally(() => inFlight.delete(learnerId));
  inFlight.set(learnerId, promise);
}

function ensurePolling(learnerId: string): void {
  if (timers.has(learnerId)) return;
  timers.set(learnerId, window.setInterval(() => {
    if (document.hidden) return;
    loadOnce(learnerId);
  }, 20_000));
  const onVisible = () => {
    if (!document.hidden) loadOnce(learnerId);
  };
  document.addEventListener('visibilitychange', onVisible);
  visibleHandlers.set(learnerId, onVisible);
}

function stopPolling(learnerId: string): void {
  const timer = timers.get(learnerId);
  if (timer !== undefined) window.clearInterval(timer);
  timers.delete(learnerId);
  const onVisible = visibleHandlers.get(learnerId);
  if (onVisible) document.removeEventListener('visibilitychange', onVisible);
  visibleHandlers.delete(learnerId);
}

export function useCourseLearning() {
  const { currentLearnerId } = useProfile();
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!UUID_PATTERN.test(currentLearnerId)) {
      snapshots.set(currentLearnerId, { loading: true, course: null, resources: [], updatedAt: 0 });
      forceRender((n) => n + 1);
      return;
    }
    const existing = snapshots.get(currentLearnerId);
    if (!existing) {
      snapshots.set(currentLearnerId, { ...EMPTY_LOADING, updatedAt: 0 });
      loadOnce(currentLearnerId);
    } else if (Date.now() - existing.updatedAt > 15_000) {
      /* 数据偏旧（如刚回到页面）→ 后台校准一次，保持实时性 */
      loadOnce(currentLearnerId);
    }
    const onUpdate = () => forceRender((n) => n + 1);
    const set = listeners.get(currentLearnerId) ?? new Set<() => void>();
    set.add(onUpdate);
    listeners.set(currentLearnerId, set);
    ensurePolling(currentLearnerId);
    return () => {
      set.delete(onUpdate);
      if (set.size === 0) {
        listeners.delete(currentLearnerId);
        stopPolling(currentLearnerId);
      }
    };
  }, [currentLearnerId]);

  const snapshot = snapshots.get(currentLearnerId) ?? EMPTY_LOADING;
  const { loading, course, resources } = snapshot;

  return useMemo(() => {
    const chapterOrder = new Map((course?.chapters ?? []).map((chapter, index) => [chapter.id, index]));
    const ordered = [...resources].sort((left, right) => {
      const chapterDiff = (chapterOrder.get(left.chapterId ?? '') ?? 999) - (chapterOrder.get(right.chapterId ?? '') ?? 999);
      return chapterDiff || (typeOrder[left.type] ?? 9) - (typeOrder[right.type] ?? 9);
    });
    const nextResource = ordered.find((resource) => !resource.learned) ?? ordered[ordered.length - 1] ?? null;
    const nextChapter: CourseChapter | null = nextResource
      ? course?.chapters.find((chapter) => chapter.id === nextResource.chapterId) ?? null
      : course?.chapters[0] ?? null;
    const learnedCount = ordered.filter((resource) => resource.learned).length;
    return {
      loading, course, resources: ordered, nextResource, nextChapter,
      learnedCount, totalCount: ordered.length,
      progress: ordered.length ? Math.round(learnedCount / ordered.length * 100) : 0,
    };
  }, [course, resources, loading]);
}