import { useEffect, useMemo, useState } from 'react';
import { useProfile } from '@/context/ProfileContext';
import { api } from '@/lib/api';
import type { Course, CourseChapter, LearningResourceSummary } from '@/lib/api';

const typeOrder = { lecture: 0, practice: 1, quiz: 2 } as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function learningResourcePath(resource: LearningResourceSummary): string {
  return `/learn/resource/${encodeURIComponent(resource.id)}`;
}

export function useCourseLearning() {
  const { currentLearnerId } = useProfile();
  const [course, setCourse] = useState<Course | null>(null);
  const [resources, setResources] = useState<LearningResourceSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!UUID_PATTERN.test(currentLearnerId)) {
      setLoading(true);
      setCourse(null);
      setResources([]);
      return;
    }
    let cancelled = false;
    api.listCourses(currentLearnerId)
      .then(async ({ courses }) => {
        const latest = courses?.[0] ?? null;
        if (!latest) return { latest, resources: [] as LearningResourceSummary[] };
        const listed = await api.listLearningResources({ courseId: latest.id });
        return { latest, resources: listed.resources ?? [] };
      })
      .then((result) => {
        if (cancelled) return;
        setCourse(result.latest);
        setResources(result.resources);
      })
      .catch(() => {
        if (!cancelled) { setCourse(null); setResources([]); }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentLearnerId]);

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
