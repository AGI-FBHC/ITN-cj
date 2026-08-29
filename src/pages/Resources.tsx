import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { lectureMdComponents } from '@/components/resources/lecture-markdown';
import SourceCitationMarks from '@/components/resources/SourceCitationMarks';
import { Check, CheckCircle2, ExternalLink, FileText, Flag, Link2, ListChecks, Loader2, PenLine, PlayCircle, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Course, CourseChapter, LearningResource } from '@/lib/api';
import PageBack from '@/components/PageBack';
import PageTip from '@/components/heal/PageTip';
import { useProfile } from '@/context/ProfileContext';
import { cn } from '@/lib/utils';

type ResourceType = 'lecture' | 'practice' | 'quiz';

const resourceMeta: Record<ResourceType, { label: string; Icon: typeof FileText }> = {
  lecture: { label: '领学讲义', Icon: FileText },
  practice: { label: '实操指南', Icon: ListChecks },
  quiz: { label: '分阶测试题', Icon: PenLine },
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const asRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
const sourceConfidence = (source: Record<string, unknown>): number => {
  const raw = Number(source.confidence ?? source.similarity ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(1, raw > 1 ? raw / 100 : raw);
};
const isWebSource = (source: Record<string, unknown>): boolean => {
  const kind = String(source.sourceType ?? source.type ?? '').toLowerCase();
  return kind === 'web' || kind === 'websearch' || kind === 'web_search';
};
const sourceAnchorId = (resourceId: string, sourceId: string | number) =>
  `resource-${resourceId}-source-${String(sourceId).replace(/[^a-zA-Z0-9_-]/g, '-')}`;

function Sources({ resource }: { resource: LearningResource }) {
  const [reporting, setReporting] = useState('');
  const [reported, setReported] = useState<Set<string>>(() => new Set());
  if (!resource.sources.length) return null;
  const report = async (sourceId: string, title: string) => {
    if (reporting || reported.has(sourceId)) return;
    setReporting(sourceId);
    try {
      await api.submitLearningResourceSourceFeedback(resource.id, {
        sourceId,
        issueType: 'needs_review',
        note: `请 VER-04 复核来源「${title}」与当前资源内容的一致性。`,
      });
      setReported((current) => new Set(current).add(sourceId));
      toast.success('已提交引用复核', { description: '反馈已写入后端，等待审核裁判 Agent 处理。' });
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '引用反馈提交失败');
    } finally {
      setReporting('');
    }
  };
  return (
    <aside className="rounded-[14px] border border-hairline bg-paper p-5 xl:sticky xl:top-24">
      <div className="lf-mono-label !text-[10px]">TRACEABILITY</div>
      <h3 className="mt-1 text-[14px] font-semibold text-ink">本资源使用的真实来源</h3>
      <div className="mt-3 space-y-2">
        {resource.sources.map((raw, index) => {
          const source = asRecord(raw);
          const url = typeof source.url === 'string' ? source.url : null;
          const sourceId = String(source.id ?? source.kbId ?? `SOURCE-${index + 1}`);
          const title = String(source.document ?? source.title ?? `来源 ${index + 1}`);
          const confidence = sourceConfidence(source);
          return (
            <div id={sourceAnchorId(resource.id, sourceId)} key={`${sourceId}-${title}`} className="scroll-mt-24 rounded-lg border border-hairline bg-card-warm px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="line-clamp-2 font-medium text-ink">{title}</span>
                <span className="rounded bg-brand-tint px-1.5 py-0.5 font-mono text-[10px] text-brand">
                  {isWebSource(source) ? 'WEB SEARCH' : 'KNOWLEDGE BASE'}
                </span>
                {confidence > 0 && <span className="font-mono text-[10px] text-ink-muted">置信度 {Math.round(confidence * 100)}%</span>}
                {url && <a href={url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-brand hover:underline"><ExternalLink size={11} />查看</a>}
              </div>
              {source.content ? <p className="mt-1 line-clamp-2 text-[11.5px] leading-[18px] text-ink-muted">{String(source.content)}</p> : null}
              <button
                type="button"
                disabled={reporting === sourceId || reported.has(sourceId)}
                onClick={() => void report(sourceId, title)}
                className="mt-2 inline-flex items-center gap-1 text-[11px] text-ink-muted transition-colors hover:text-rust disabled:text-brand"
              >
                {reporting === sourceId ? <Loader2 size={11} className="animate-spin" /> : reported.has(sourceId) ? <Check size={11} /> : <Flag size={11} />}
                {reported.has(sourceId) ? '已提交复核' : '引用有问题？提交复核'}
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function LectureContent({ resource }: { resource: LearningResource }) {
  const content = resource.content;
  const chapters = asRecords(content.chapters);
  return (
    <article className="space-y-6">
      {content.summary ? <p className="rounded-[12px] border border-brand/20 bg-brand-tint/40 p-4 text-[14px] leading-7 text-ink-2">{String(content.summary)}</p> : null}
      {asStrings(content.learningObjectives).length > 0 && (
        <section><h3 className="font-serif text-[19px] font-semibold text-ink">学习目标</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-[13.5px] leading-6 text-ink-2">{asStrings(content.learningObjectives).map((item) => <li key={item}>{item}</li>)}</ul></section>
      )}
      {chapters.map((chapter, chapterIndex) => (
        <section key={`${String(chapter.title)}-${chapterIndex}`} className="rounded-[14px] border border-hairline bg-card-warm p-5 md:p-6">
          <h3 className="font-serif text-[20px] font-semibold text-ink">{String(chapter.title ?? `第 ${chapterIndex + 1} 单元`)}</h3>
          {chapter.overview ? <p className="mt-1 text-[13px] text-ink-muted">{String(chapter.overview)}</p> : null}
          <div className="mt-4 space-y-5">
            {asRecords(chapter.sections).map((section, sectionIndex) => (
              <div key={`${String(section.title)}-${sectionIndex}`}>
                <h4 className="text-[15px] font-semibold text-ink">{String(section.title ?? `第 ${sectionIndex + 1} 节`)}</h4>
                <div className="mt-2 max-w-[760px]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={lectureMdComponents}>{String(section.content ?? '')}</ReactMarkdown>
                  <SourceCitationMarks citations={section.citations} evidenceQuotes={section.evidenceQuotes ?? section.evidenceMatches} resource={resource} />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </article>
  );
}

function PracticeContent({ resource }: { resource: LearningResource }) {
  const content = resource.content;
  return (
    <div className="space-y-5">
      {content.objective ? <p className="rounded-[12px] border border-brand/20 bg-brand-tint/40 p-4 text-[14px] leading-7 text-ink-2">{String(content.objective)}</p> : null}
      {(asStrings(content.prerequisites).length > 0 || asStrings(content.environment).length > 0) && (
        <div className="grid gap-3 md:grid-cols-2">
          {[['开始前准备', asStrings(content.prerequisites)], ['环境与工具', asStrings(content.environment)]].map(([title, items]) => (
            <section key={title as string} className="rounded-[12px] border border-hairline bg-paper p-4"><h3 className="text-[14px] font-semibold text-ink">{title as string}</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-[12.5px] leading-5 text-ink-2">{(items as string[]).map((item) => <li key={item}>{item}</li>)}</ul></section>
          ))}
        </div>
      )}
      <div className="space-y-3">
        {asRecords(content.steps).map((step, index) => (
          <section key={`${String(step.title)}-${index}`} className="rounded-[14px] border border-hairline bg-card-warm p-5">
            <div className="flex items-start gap-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-paper font-mono text-[12px]">{index + 1}</span><div className="min-w-0 flex-1"><h3 className="text-[15px] font-semibold text-ink">{String(step.title ?? `步骤 ${index + 1}`)}</h3><div className="mt-1"><ReactMarkdown remarkPlugins={[remarkGfm]} components={lectureMdComponents}>{String(step.instruction ?? '')}</ReactMarkdown><SourceCitationMarks citations={step.citations} evidenceQuotes={step.evidenceQuotes ?? step.evidenceMatches} resource={resource} /></div></div></div>
            {step.code ? <pre className="mt-4 overflow-x-auto rounded-lg bg-ink px-4 py-3 text-[12px] leading-5 text-paper"><code>{String(step.code)}</code></pre> : null}
            {step.expectedOutput ? <div className="mt-3 rounded-lg border border-brand/20 bg-brand-tint/40 px-3 py-2 text-[12.5px] text-ink-2"><span className="font-semibold text-brand">预期结果：</span>{String(step.expectedOutput)}</div> : null}
          </section>
        ))}
      </div>
      {asStrings(content.acceptanceCriteria).length > 0 && <section className="rounded-[14px] border border-brand/25 bg-brand-tint/30 p-5"><h3 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><CheckCircle2 size={16} className="text-brand" />验收标准</h3><ul className="mt-2 space-y-1.5 text-[13px] text-ink-2">{asStrings(content.acceptanceCriteria).map((item) => <li key={item}>✓ {item}</li>)}</ul></section>}
    </div>
  );
}

function QuizContent({ resource, onStateChange }: { resource: LearningResource; onStateChange: (state: Record<string, unknown>) => void }) {
  const questions = asRecords(resource.content.questions);
  const answeredRows = asRecords(resource.state.answered);
  const initialAnswers = Object.fromEntries(answeredRows.map((row) => [String(row.questionId), Number(row.selectedIndex)]));
  const [answers, setAnswers] = useState<Record<string, number>>(initialAnswers);
  const [feedback, setFeedback] = useState<Record<string, Record<string, unknown>>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);

  const answer = async (questionId: string, optionIndex: number) => {
    if (answers[questionId] !== undefined || submitting) return;
    setSubmitting(questionId);
    try {
      const result = await api.answerLearningQuiz(resource.id, { questionId, answer: String(optionIndex) });
      setAnswers((prev) => ({ ...prev, [questionId]: optionIndex }));
      setFeedback((prev) => ({ ...prev, [questionId]: result }));
      if (result.state && typeof result.state === 'object') onStateChange(result.state as Record<string, unknown>);
    } finally {
      setSubmitting(null);
    }
  };

  return <div className="space-y-4">{questions.map((question, index) => {
    const id = String(question.id);
    const selected = answers[id];
    const result = feedback[id];
    const correctIndex = typeof result?.correctIndex === 'number' ? result.correctIndex : undefined;
    return (
      <section key={id} className="rounded-[14px] border border-hairline bg-card-warm p-5">
        <div className="flex items-start gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-paper-deep font-mono text-[11px] text-ink-2">{index + 1}</span><div className="min-w-0 flex-1"><p className="text-[14px] font-medium leading-6 text-ink">{String(question.stem)} <SourceCitationMarks citations={question.citations} evidenceQuotes={question.answerEvidenceQuotes ?? question.evidenceQuotes} resource={resource} compact /></p><span className="mt-1 inline-block rounded bg-brand-tint px-1.5 py-0.5 font-mono text-[10px] text-brand">{String(question.difficulty ?? 'adaptive')}</span></div></div>
        <div className="mt-4 grid gap-2">
          {asStrings(question.options).map((option, optionIndex) => (
            <button key={`${id}-${optionIndex}`} type="button" disabled={selected !== undefined || submitting === id} onClick={() => void answer(id, optionIndex)} className={cn('rounded-[10px] border px-4 py-3 text-left text-[13px] transition-colors', selected === undefined && 'border-hairline hover:border-brand/40', selected === optionIndex && (result?.correct ? 'border-brand bg-brand-tint text-brand' : 'border-brand-danger bg-brand-danger/10 text-brand-danger'), correctIndex === optionIndex && selected !== undefined && 'border-brand bg-brand-tint text-brand')}>
              <span className="mr-2 font-mono text-[11px]">{String.fromCharCode(65 + optionIndex)}.</span>{option}
            </button>
          ))}
        </div>
        {submitting === id && <p className="mt-3 flex items-center gap-2 text-[12px] text-ink-muted"><Loader2 size={13} className="animate-spin" />正在判分并回写画像…</p>}
        {result && <div className="mt-3 rounded-lg bg-paper px-3 py-2.5 text-[12.5px] leading-5 text-ink-2"><span className="font-semibold">{result.correct ? '回答正确。' : '回答错误。'}</span>{String(result.explanation ?? '')}</div>}
      </section>
    );
  })}</div>;
}

export default function Resources() {
  const { currentLearner, viewMode } = useProfile();
  const isLearner = viewMode === 'learner';
  const [searchParams, setSearchParams] = useSearchParams();
  const courseId = searchParams.get('courseId');
  const chapterId = searchParams.get('chapterId');
  const requestedType = searchParams.get('tab') as ResourceType | null;
  const [course, setCourse] = useState<Course | null>(null);
  const [resources, setResources] = useState<LearningResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState<ResourceType | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let selectedCourseId = courseId;
      let selectedChapterId = chapterId;
      if (!selectedCourseId || !selectedChapterId) {
        const listed = await api.listCourses(currentLearner.id);
        const latest = listed.courses?.[0];
        const firstChapter = latest?.chapters?.[0];
        if (!latest || !firstChapter) { setCourse(latest ?? null); setResources([]); return; }
        selectedCourseId = latest.id;
        selectedChapterId = firstChapter.id;
        setSearchParams({ courseId: selectedCourseId, chapterId: selectedChapterId }, { replace: true });
      }
      const [selectedCourse, listed] = await Promise.all([
        api.getCourse(selectedCourseId),
        api.listLearningResources({ courseId: selectedCourseId, chapterId: selectedChapterId }),
      ]);
      if (selectedCourse.learnerId && selectedCourse.learnerId !== currentLearner.id) {
        const listedCourses = await api.listCourses(currentLearner.id);
        const latest = listedCourses.courses?.[0];
        const firstChapter = latest?.chapters?.[0];
        if (!latest || !firstChapter) {
          setCourse(null);
          setResources([]);
          setSearchParams({}, { replace: true });
          return;
        }
        setSearchParams({ courseId: latest.id, chapterId: firstChapter.id }, { replace: true });
        return;
      }
      const full = await Promise.all((listed.resources ?? []).map((item) => api.getLearningResource(String(item.id))));
      setCourse(selectedCourse);
      setResources(full);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '章节资源加载失败');
    } finally {
      setLoading(false);
    }
  }, [courseId, chapterId, currentLearner.id, setSearchParams]);

  useEffect(() => { void load(); }, [load]);

  const chapter = course?.chapters.find((item) => item.id === chapterId) ?? course?.chapters[0];
  const byType = useMemo(() => Object.fromEntries(resources.map((item) => [item.type, item])) as Partial<Record<ResourceType, LearningResource>>, [resources]);
  const availableTypes = (['lecture', 'practice', 'quiz'] as ResourceType[]).filter((type) => byType[type]);
  const activeType = requestedType && byType[requestedType] ? requestedType : availableTypes[0] ?? 'lecture';
  const active = byType[activeType];
  const sourceQuality = useMemo(() => {
    const sources = active?.sources.map(asRecord) ?? [];
    const scores = sources
      .map(sourceConfidence)
      .filter((value) => Number.isFinite(value) && value > 0);
    return {
      count: sources.length,
      average: scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length * 100) : 0,
      web: sources.filter(isWebSource).length,
    };
  }, [active]);

  const selectChapter = (next: CourseChapter) => {
    if (!course) return;
    setSearchParams({ courseId: course.id, chapterId: next.id }, { replace: true });
  };
  const selectType = (type: ResourceType) => {
    if (!course || !chapter) return;
    setSearchParams({ courseId: course.id, chapterId: chapter.id, tab: type }, { replace: true });
  };
  const regenerate = async (type: ResourceType) => {
    if (!course || !chapter || regenerating) return;
    setRegenerating(type);
    try {
      await api.generateChapterResource(course.id, chapter.id, type);
      window.setTimeout(() => void load(), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '资源重新生成失败');
    } finally {
      setRegenerating(null);
    }
  };
  const markLearned = async () => {
    if (!active) return;
    const result = await api.completeLearningResource(active.id);
    setResources((prev) => prev.map((item) => item.id === active.id ? result.resource : item));
  };

  return (
    <div className={cn('mx-auto pb-24 pt-8', isLearner ? 'max-w-[1080px] px-5 md:px-6' : 'max-w-[1320px] px-5 md:px-8')}>
      <PageBack parent={{ label: '我的课程', to: '/learn' }} current={chapter?.title ?? '章节资源'} />
      {isLearner && (
        <PageTip id="real-course-resources" className="mb-4">
          这里是 AI 按你的目标生成的真实资源。每条来源都可以打开核对；发现不一致时，可直接提交给审核裁判 Agent 复核。
        </PageTip>
      )}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <div className="lf-mono-label flex items-center gap-2"><span className="inline-block h-px w-6 bg-brand/40" />{isLearner ? '我的学习资源 · 学' : 'CONSTRAINED GENERATION'}</div>
        <h1 className="mt-2 font-serif text-[32px] font-bold leading-[40px] text-ink md:text-[36px]">
          {isLearner ? '为你定制的学习资源' : '个性化资源生成'}
        </h1>
        <p className="mt-2 max-w-[760px] text-[14px] leading-6 text-ink-muted">
          讲义、实操指南与分阶题均来自当前课程目标，并由真实知识库检索与 WebSearch 兜底提供依据。
        </p>
      </motion.div>
      {loading && <div className="mt-8 flex items-center justify-center gap-2 rounded-[14px] border border-hairline bg-card-warm py-14 text-[13.5px] text-ink-muted"><Loader2 size={16} className="animate-spin" />正在读取真实课程资源…</div>}
      {!loading && !course && <div className="mt-8 rounded-[14px] border border-hairline bg-card-warm p-8 text-center"><p className="text-ink-muted">还没有可学习的真实课程。</p><Link to="/learn" className="lf-btn-primary mt-4 inline-flex">去生成课程</Link></div>}
      {error && <div className="mt-5 rounded-[12px] border border-brand-danger/40 bg-brand-danger/10 px-4 py-3 text-[13px] text-brand-danger">{error}</div>}
      {!loading && course && chapter && <>
        <motion.header initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="lf-card mt-6 p-4 md:p-5">
          <div className="flex flex-wrap items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[11px] bg-brand-tint text-brand"><Sparkles size={19} /></span>
            <div className="min-w-[220px] flex-1">
              <div className="lf-mono-label !text-[10px]">{course.title} · 第 {chapter.index} 章</div>
              <h2 className="mt-1 font-serif text-[23px] font-semibold text-ink">{chapter.title}</h2>
              {chapter.summary && <p className="mt-1 max-w-[760px] text-[13px] leading-5 text-ink-muted">{chapter.summary}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-brand/30 bg-brand-tint px-2.5 py-1.5 text-[11.5px] font-medium text-brand"><Link2 size={12} />{sourceQuality.count} 条依据{sourceQuality.average ? ` · 平均 ${sourceQuality.average}%` : ''}</span>
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-brand/30 bg-brand-tint px-2.5 py-1.5 text-[11.5px] font-medium text-brand"><ShieldCheck size={12} />可核验 · 可反馈</span>
              {sourceQuality.web > 0 && <span className="inline-flex items-center gap-1.5 rounded-lg border border-brand-amber/50 bg-brand-amber-tint px-2.5 py-1.5 text-[11.5px] font-medium text-ochre">WebSearch 兜底 {sourceQuality.web} 条</span>}
            </div>
          </div>
          <div className="mt-4 border-t border-hairline pt-3">
            <div className="lf-mono-label mb-2 !text-[9.5px]">切换课程章节</div>
            <div className="flex gap-2 overflow-x-auto pb-1">{course.chapters.map((item) => <button key={item.id} type="button" onClick={() => selectChapter(item)} className={cn('shrink-0 rounded-lg border px-3 py-1.5 text-[12px]', item.id === chapter.id ? 'border-brand bg-brand text-paper' : 'border-hairline bg-card-warm text-ink-2 hover:border-brand/40')}>{item.index}. {item.title}</button>)}</div>
          </div>
        </motion.header>
        {resources.length === 0 ? <div className="mt-6 rounded-[14px] border border-hairline bg-card-warm p-8 text-center"><p className="text-[13.5px] text-ink-muted">本章还没有正文资源。</p><div className="mt-4 flex justify-center gap-2">{(['lecture', 'practice', 'quiz'] as ResourceType[]).map((type) => <button key={type} type="button" disabled={Boolean(regenerating)} onClick={() => void regenerate(type)} className="lf-btn-ghost !px-3 !py-2 text-[12px]">{regenerating === type ? <Loader2 size={13} className="animate-spin" /> : null}生成{resourceMeta[type].label}</button>)}</div></div> : <>
          <div className="mt-7 flex flex-wrap items-end justify-between gap-3 border-b border-hairline">
            <div className="flex max-w-full gap-1 overflow-x-auto">{availableTypes.map((type) => { const Meta = resourceMeta[type]; return <button key={type} type="button" onClick={() => selectType(type)} className={cn('flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 pb-3 pt-2 text-[14px] font-medium md:px-4', activeType === type ? 'border-brand text-brand' : 'border-transparent text-ink-muted hover:text-ink')}><Meta.Icon size={14} />{Meta.label}</button>; })}</div>
            <div className="flex flex-wrap items-center gap-2 pb-2">
              <button type="button" disabled={Boolean(regenerating)} onClick={() => void regenerate(activeType)} className="lf-btn-ghost !px-3 !py-1.5 text-[12px]">{regenerating === activeType ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}重新生成当前资源</button>
              {active && <Link to={`/learn/resource/${encodeURIComponent(active.id)}`} className="lf-btn-primary !px-3 !py-1.5 text-[12px]"><PlayCircle size={13} />进入学习</Link>}
              {active && !active.state.learned && <button type="button" onClick={() => void markLearned()} className="lf-btn-ghost !px-3 !py-1.5 text-[12px]"><Check size={13} />标记学完</button>}
            </div>
          </div>
          {active && <div className="mt-6 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px]"><main><div className="mb-5"><h2 className="font-serif text-[23px] font-semibold text-ink">{active.title}</h2><p className="mt-1 font-mono text-[10.5px] text-ink-muted">真实资源 · 更新于 {new Date(active.updatedAt).toLocaleString()} · {currentLearner.name}</p></div>{active.type === 'lecture' && <LectureContent resource={active} />}{active.type === 'practice' && <PracticeContent resource={active} />}{active.type === 'quiz' && <QuizContent resource={active} onStateChange={(state) => setResources((prev) => prev.map((item) => item.id === active.id ? { ...item, state } : item))} />}</main><Sources resource={active} /></div>}
        </>}
      </>}
    </div>
  );
}
