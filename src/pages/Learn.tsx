/**
 * Learn `/learn` — 动态课程目录。
 * 课程不再固定为六个知识点，而是根据用户目标由后端生成章节；
 * 建档后首次进入会自动创建课程大纲，正文资源按章节按需生成。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { BookOpen, Check, Loader2, Pencil, Play, RefreshCw, Sparkles, X } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { api } from '@/lib/api';
import type { Course, CourseChapter } from '@/lib/api';
import PageBack from '@/components/PageBack';
import { cn } from '@/lib/utils';

const resourceLabels: Record<string, string> = {
  lecture: '讲义',
  practice: '实操',
  quiz: '分阶题',
  ppt: 'PPT',
};

function ChapterCard({
  courseId,
  chapter,
  onRename,
}: {
  courseId: string;
  chapter: CourseChapter;
  onRename: (chapterId: string, title: string) => Promise<boolean>;
}) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(chapter.title);
  const [saving, setSaving] = useState(false);
  const resourceKinds = Object.keys(chapter.resources ?? {});
  const done = resourceKinds.filter((kind) => chapter.resources[kind]?.status === 'completed');
  const firstResourceId = ['lecture', 'practice', 'quiz']
    .map((kind) => chapter.resources[kind])
    .find((item) => item?.status === 'completed' && item.id)?.id;
  const chapterTarget = firstResourceId
    ? `/learn/resource/${encodeURIComponent(firstResourceId)}`
    : `/resources?courseId=${encodeURIComponent(courseId)}&chapterId=${encodeURIComponent(chapter.id)}`;

  const cancelEditing = () => {
    setDraftTitle(chapter.title);
    setEditing(false);
  };

  const saveTitle = async () => {
    const title = draftTitle.trim();
    if (!title || saving) return;
    if (title === chapter.title) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      if (await onRename(chapter.id, title)) setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: chapter.index * 0.05 }}
      onClick={() => {
        if (!editing) navigate(chapterTarget);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || editing || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        navigate(chapterTarget);
      }}
      role="link"
      tabIndex={editing ? -1 : 0}
      className={cn(
        'group flex w-full items-start gap-4 rounded-[14px] border border-hairline bg-card-warm p-5 text-left transition-all hover:border-brand/40 hover:shadow-warm',
        editing ? 'cursor-default' : 'cursor-pointer',
      )}
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-brand-tint font-mono text-[14px] font-semibold text-brand">
        {chapter.index}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          {editing ? (
            <span className="flex min-w-[240px] flex-1 items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
              <input
                value={draftTitle}
                maxLength={200}
                autoFocus
                onChange={(event) => setDraftTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveTitle();
                  if (event.key === 'Escape') cancelEditing();
                }}
                className="min-w-0 flex-1 rounded-lg border border-brand/40 bg-paper px-2.5 py-1.5 text-[14px] font-semibold text-ink outline-none focus:ring-2 focus:ring-brand/20"
                aria-label={`编辑第 ${chapter.index} 章标题`}
              />
              <button type="button" disabled={!draftTitle.trim() || saving} onClick={() => void saveTitle()} className="rounded-md p-1.5 text-brand hover:bg-brand-tint disabled:opacity-40" aria-label="保存章节标题">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              </button>
              <button type="button" disabled={saving} onClick={cancelEditing} className="rounded-md p-1.5 text-ink-muted hover:bg-paper" aria-label="取消编辑">
                <X size={14} />
              </button>
            </span>
          ) : (
            <span className="text-[15px] font-semibold text-ink">{chapter.title}</span>
          )}
          <span
            className={cn(
              'rounded-md border px-1.5 py-px font-mono text-[10px] font-medium',
              chapter.status === 'completed'
                ? 'border-brand/40 bg-brand-tint text-brand'
                : chapter.status === 'queued'
                  ? 'border-hairline bg-paper text-ink-muted'
                  : 'border-brand-amber/50 bg-brand-amber-tint text-ochre',
            )}
          >
            {chapter.status === 'completed' ? '已生成' : chapter.status === 'queued' ? '待生成' : `生成中 ${chapter.progress}%`}
          </span>
        </span>
        {chapter.summary && <span className="mt-1 block text-[12.5px] leading-[19px] text-ink-muted">{chapter.summary}</span>}
        <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {resourceKinds.length ? (
            resourceKinds.map((kind) => (
              <span
                key={kind}
                className={cn(
                  'rounded-md border px-1.5 py-0.5 font-mono text-[10px]',
                  done.includes(kind)
                    ? 'border-brand/30 bg-brand-tint text-brand'
                    : 'border-hairline bg-paper text-ink-muted',
                )}
              >
                {resourceLabels[kind] ?? kind}
              </span>
            ))
          ) : (
            <span className="font-mono text-[10px] text-ink-muted">大纲已生成，正文资源待生成</span>
          )}
        </span>
      </span>
      {!editing && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setDraftTitle(chapter.title);
            setEditing(true);
          }}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-hairline text-ink-muted opacity-60 transition-all hover:border-brand/40 hover:text-brand md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
          aria-label={`编辑第 ${chapter.index} 章标题`}
        >
          <Pencil size={14} />
        </button>
      )}
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-hairline text-ink-muted transition-colors group-hover:border-brand/40 group-hover:text-brand">
        <Play size={15} />
      </span>
    </motion.div>
  );
}

export default function Learn() {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingCourseTitle, setEditingCourseTitle] = useState(false);
  const [courseTitleDraft, setCourseTitleDraft] = useState('');
  const [savingCourseTitle, setSavingCourseTitle] = useState(false);
  const [loadedLearnerId, setLoadedLearnerId] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);
  const autoCreateForRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const learnerId = currentLearner.id;
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    try {
      const result = await api.listCourses(learnerId);
      if (sequence !== loadSequenceRef.current) return;
      setCourses(result.courses ?? []);
      setError(null);
    } catch (err) {
      if (sequence !== loadSequenceRef.current) return;
      setError(err instanceof Error ? err.message : '课程加载失败');
    } finally {
      if (sequence === loadSequenceRef.current) {
        setLoadedLearnerId(learnerId);
        setLoading(false);
      }
    }
  }, [currentLearner.id]);

  const createOutline = useCallback(async () => {
    if (!currentLearner.custom || !currentLearner.id || autoCreateForRef.current === currentLearner.id) return;
    autoCreateForRef.current = currentLearner.id;
    setCreating(true);
    try {
      const prompt = [
        `学习者：${currentLearner.name}`,
        `目标：${currentLearner.targetJob || '未填写'}`,
        `画像目标：${currentLearner.goal || ''}`,
        `画像盲区：${currentLearner.blindSpots.slice(0, 4).join('、') || '暂无'}`,
        `请根据学习目标生成课程大纲与章节，不要使用固定六知识点模板。`,
      ].filter(Boolean).join('\n');
      await api.createCourse({
        learnerId: currentLearner.id,
        prompt,
        resourceTypes: ['lecture', 'practice', 'quiz'],
        depth: 'systematic',
        scale: 'standard',
        courseStyle: 'none',
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '课程大纲生成失败');
    } finally {
      setCreating(false);
    }
  }, [currentLearner, refresh]);

  useEffect(() => {
    setCourses([]);
    setLoadedLearnerId(null);
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (loading || loadedLearnerId !== currentLearner.id || courses.length > 0 || !currentLearner.custom) return;
    const timer = window.setTimeout(() => void createOutline(), 0);
    return () => window.clearTimeout(timer);
  }, [loading, loadedLearnerId, courses.length, currentLearner.id, currentLearner.custom, createOutline]);

  useEffect(() => {
    const active = courses.find((course) => course.status === 'planning' || course.status === 'generating');
    if (!active) return undefined;
    const timer = window.setInterval(() => {
      api.getCourse(active.id).then((course) => {
        setCourses((prev) => prev.map((item) => (item.id === course.id ? course : item)));
      }).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [courses]);

  const course = courses[0];

  const replaceCourse = useCallback((updated: Course) => {
    setCourses((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
  }, []);

  const saveCourseTitle = async () => {
    if (!course || savingCourseTitle) return;
    const title = courseTitleDraft.trim();
    if (!title) return;
    if (title === course.title) {
      setEditingCourseTitle(false);
      return;
    }
    setSavingCourseTitle(true);
    try {
      replaceCourse(await api.updateCourse(course.id, { title }));
      setEditingCourseTitle(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '课程标题保存失败');
    } finally {
      setSavingCourseTitle(false);
    }
  };

  const renameChapter = async (chapterId: string, title: string) => {
    if (!course) return false;
    try {
      replaceCourse(await api.updateCourseChapter(course.id, chapterId, { title }));
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : '章节标题保存失败');
      return false;
    }
  };

  const regenerateCourse = async () => {
    if (!course || !currentLearner.id || regenerating) return;
    if (!window.confirm('将保留当前课程，并重新生成一套大纲、讲义、实操和分阶题。是否继续？')) return;
    setRegenerating(true);
    try {
      const replacement = await api.regenerateCourse(course.id, {
        learnerId: currentLearner.id,
        resourceTypes: ['lecture', 'practice', 'quiz'],
      });
      setCourses((prev) => [replacement, ...prev.filter((item) => item.id !== replacement.id)]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '课程重新生成失败');
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div className="mx-auto max-w-[980px] px-5 pb-24 pt-8 md:px-6">
      <PageBack parent={{ label: '我的学习', to: '/me' }} current="我的课程" />

      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="lf-mono-label flex items-center gap-2">
            <BookOpen size={13} />
            DYNAMIC COURSE
          </div>
          <h1 className="mt-1 font-serif text-[28px] font-semibold text-ink">我的课程</h1>
          <p className="mt-1.5 max-w-[680px] text-[13.5px] leading-[21px] text-ink-muted">
            课程会根据你的目标动态生成章节，不再是固定六个知识点模板。
          </p>
        </div>
        {course && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={regenerating || course.status === 'planning' || course.status === 'generating'}
              onClick={() => void regenerateCourse()}
              className="lf-btn-ghost !px-4 !py-2 text-[13px] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {regenerating ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              重新生成课程
            </button>
            <button
              type="button"
              onClick={() => navigate('/agents?run=course')}
              className="lf-btn-ghost !px-4 !py-2 text-[13px]"
            >
              <Sparkles size={14} />
              看 AI 如何生成这门课
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-5 rounded-[12px] border border-brand-danger/40 bg-brand-danger/10 px-4 py-3 text-[13px] text-brand-danger">
          {error}
        </div>
      )}

      {loading && (
        <div className="mt-8 flex items-center justify-center gap-2 rounded-[14px] border border-hairline bg-card-warm py-12 text-[13.5px] text-ink-muted">
          <Loader2 size={16} className="animate-spin" />
          正在读取你的课程…
        </div>
      )}

      {!loading && !course && currentLearner.custom && (
        <div className="mt-8 flex flex-col items-center gap-3 rounded-[14px] border border-brand/25 bg-brand-tint/40 px-6 py-12 text-center">
          <Loader2 size={22} className={cn('text-brand', creating ? 'animate-spin' : 'opacity-0')} />
          <p className="text-[15px] font-semibold text-ink">正在根据你的目标生成课程大纲</p>
          <p className="max-w-[520px] text-[13px] leading-[20px] text-ink-muted">
            后端正在规划课程标题、章节、学习目标和章节小节。
          </p>
        </div>
      )}

      {!loading && !course && !currentLearner.custom && (
        <div className="mt-8 rounded-[14px] border border-hairline bg-card-warm px-6 py-10 text-center text-[13.5px] text-ink-muted">
          演示画像暂不生成动态课程，请使用自建画像体验。
        </div>
      )}

      {course && (
        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mt-6 space-y-4"
        >
          <div className="rounded-[16px] border border-brand/25 bg-brand-tint/40 p-6">
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-[12px] bg-brand text-paper">
                <BookOpen size={20} />
              </span>
              <div className="min-w-0 flex-1">
                {editingCourseTitle ? (
                  <div className="flex max-w-[620px] items-center gap-2">
                    <input
                      value={courseTitleDraft}
                      maxLength={160}
                      autoFocus
                      onChange={(event) => setCourseTitleDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void saveCourseTitle();
                        if (event.key === 'Escape' && !savingCourseTitle) setEditingCourseTitle(false);
                      }}
                      className="min-w-0 flex-1 rounded-lg border border-brand/40 bg-paper px-3 py-1.5 font-serif text-[20px] font-semibold text-ink outline-none focus:ring-2 focus:ring-brand/20"
                      aria-label="编辑课程标题"
                    />
                    <button type="button" disabled={!courseTitleDraft.trim() || savingCourseTitle} onClick={() => void saveCourseTitle()} className="rounded-lg p-2 text-brand hover:bg-brand-tint disabled:opacity-40" aria-label="保存课程标题">
                      {savingCourseTitle ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                    </button>
                    <button type="button" disabled={savingCourseTitle} onClick={() => setEditingCourseTitle(false)} className="rounded-lg p-2 text-ink-muted hover:bg-paper" aria-label="取消编辑">
                      <X size={16} />
                    </button>
                  </div>
                ) : (
                  <div className="group/title flex items-center gap-2">
                    <h2 className="font-serif text-[22px] font-semibold text-ink">{course.title}</h2>
                    <button
                      type="button"
                      onClick={() => {
                        setCourseTitleDraft(course.title);
                        setEditingCourseTitle(true);
                      }}
                      className="rounded-lg p-1.5 text-ink-muted opacity-60 transition-all hover:bg-paper hover:text-brand md:opacity-0 md:group-hover/title:opacity-100 md:focus:opacity-100"
                      aria-label="编辑课程标题"
                    >
                      <Pencil size={14} />
                    </button>
                  </div>
                )}
                {course.description && (
                  <p className="mt-1 text-[13px] leading-[20px] text-ink-muted">{course.description}</p>
                )}
              </div>
              <span className="flex items-center gap-2 rounded-lg border border-brand/40 bg-brand-tint px-2.5 py-1.5 font-mono text-[11px] text-brand">
                <RefreshCw size={12} className={course.status === 'generating' || course.status === 'planning' ? 'animate-spin' : undefined} />
                {course.stageMessage || course.status} · {course.progress}%
              </span>
            </div>
          </div>

          {course.chapters.length > 0 && (
            <div className="space-y-3">
              <div className="lf-mono-label !text-[10.5px]">课程章节</div>
              {course.chapters.map((chapter) => (
                <ChapterCard key={chapter.id} courseId={course.id} chapter={chapter} onRename={renameChapter} />
              ))}
            </div>
          )}
        </motion.section>
      )}
    </div>
  );
}
