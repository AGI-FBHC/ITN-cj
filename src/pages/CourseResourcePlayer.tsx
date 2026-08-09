import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft, ArrowRight, BookOpen, Bot, Check, CheckCircle2, ChevronRight,
  Circle, Clock3, ExternalLink, FileText, Focus, Headphones, ListChecks,
  Loader2, MessageCircleQuestion, NotebookPen, Pause, PenLine, Play, Send,
  Sparkles, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type {
  Course, CourseChapter, LearningResource, LearningResourceMessage,
  LearningResourceProgress, LearningResourceSummary, LearningResourceTrace,
} from '@/lib/api';
import { useGrowth } from '@/context/GrowthContext';
import { cn } from '@/lib/utils';

type ResourceKind = 'lecture' | 'practice' | 'quiz';
type BlockKind = 'intro' | 'lecture' | 'practice' | 'quiz' | 'review';

interface LearningBlock {
  id: string;
  kind: BlockKind;
  eyebrow: string;
  title: string;
  body?: string;
  citations: number[];
  code?: string;
  expectedOutput?: string;
  question?: Record<string, unknown>;
}

const resourceMeta: Record<ResourceKind, { label: string; Icon: typeof FileText }> = {
  lecture: { label: '定制讲义', Icon: FileText },
  practice: { label: '实操指南', Icon: ListChecks },
  quiz: { label: '分阶测试', Icon: PenLine },
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const asRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.map(String).filter(Boolean) : [];
const asNumbers = (value: unknown): number[] => Array.isArray(value) ? [...new Set(value.map(Number).filter(Number.isFinite))] : [];
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

function progressOf(resource: LearningResource): LearningResourceProgress {
  const raw = asRecord(resource.state.progress);
  return {
    currentBlockId: typeof raw.currentBlockId === 'string' ? raw.currentBlockId : null,
    visitedBlockIds: asStrings(raw.visitedBlockIds),
    completedStepIds: asStrings(raw.completedStepIds),
    elapsedSeconds: Math.max(0, Number(raw.elapsedSeconds) || 0),
    lastOpenedAt: typeof raw.lastOpenedAt === 'string' ? raw.lastOpenedAt : null,
  };
}

function blocksOf(resource: LearningResource): LearningBlock[] {
  const content = resource.content;
  if (resource.type === 'lecture') {
    const blocks: LearningBlock[] = [];
    const objectives = asStrings(content.learningObjectives);
    if (content.summary || objectives.length) {
      blocks.push({
        id: 'lecture-intro', kind: 'intro', eyebrow: '本讲导览', title: '学习目标与内容概览',
        body: [String(content.summary ?? ''), objectives.length ? `\n\n**完成本讲后，你将能够：**\n${objectives.map((item) => `- ${item}`).join('\n')}` : ''].join(''),
        citations: [],
      });
    }
    asRecords(content.chapters).forEach((chapter, chapterIndex) => {
      asRecords(chapter.sections).forEach((section, sectionIndex) => {
        blocks.push({
          id: `lecture-${chapterIndex + 1}-${sectionIndex + 1}`,
          kind: 'lecture',
          eyebrow: String(chapter.title ?? `第 ${chapterIndex + 1} 单元`),
          title: String(section.title ?? `第 ${sectionIndex + 1} 节`),
          body: String(section.content ?? ''),
          citations: asNumbers(section.citations),
        });
      });
    });
    const questions = asStrings(content.reviewQuestions);
    if (questions.length) {
      blocks.push({ id: 'lecture-review', kind: 'review', eyebrow: '回顾与迁移', title: '带着问题检查理解', body: questions.map((item, index) => `${index + 1}. ${item}`).join('\n\n'), citations: [] });
    }
    return blocks;
  }
  if (resource.type === 'practice') {
    const blocks: LearningBlock[] = [];
    const prerequisites = asStrings(content.prerequisites);
    const environment = asStrings(content.environment);
    blocks.push({
      id: 'practice-intro', kind: 'intro', eyebrow: '开始前准备', title: String(content.title ?? resource.title),
      body: [String(content.objective ?? ''), prerequisites.length ? `\n\n**前置条件**\n${prerequisites.map((item) => `- ${item}`).join('\n')}` : '', environment.length ? `\n\n**环境与工具**\n${environment.map((item) => `- ${item}`).join('\n')}` : ''].join(''),
      citations: [],
    });
    asRecords(content.steps).forEach((step, index) => blocks.push({
      id: `practice-step-${index + 1}`, kind: 'practice', eyebrow: `实操步骤 ${index + 1}`, title: String(step.title ?? `步骤 ${index + 1}`),
      body: String(step.instruction ?? ''), citations: asNumbers(step.citations), code: step.code ? String(step.code) : undefined,
      expectedOutput: step.expectedOutput ? String(step.expectedOutput) : undefined,
    }));
    const criteria = asStrings(content.acceptanceCriteria);
    if (criteria.length) blocks.push({ id: 'practice-review', kind: 'review', eyebrow: '完成验收', title: '用结果判断是否真正完成', body: criteria.map((item) => `- ${item}`).join('\n'), citations: [] });
    return blocks;
  }
  return asRecords(content.questions).map((question, index) => ({
    id: String(question.id ?? `question-${index + 1}`), kind: 'quiz', eyebrow: `${String(question.difficulty ?? 'adaptive').toUpperCase()} · 第 ${index + 1} 题`,
    title: String(question.stem ?? `第 ${index + 1} 题`), citations: asNumbers(question.citations), question,
  }));
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes} 分 ${String(rest).padStart(2, '0')} 秒` : `${rest} 秒`;
}

function sourceIds(resource: LearningResource, citations: number[]) {
  const map = new Map<number, string>();
  resource.sources.forEach((raw, index) => {
    const source = asRecord(raw);
    map.set(Number(source.id ?? index + 1), String(source.id ?? index + 1));
  });
  return citations.map((id) => map.get(id)).filter((value): value is string => Boolean(value));
}

function BlockSources({ citations, resource }: { citations: number[]; resource: LearningResource }) {
  if (!citations.length) return null;
  return <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-hairline/70 pt-4"><span className="font-mono text-[10px] text-ink-muted">本段依据</span>{citations.map((citation) => {
    const raw = resource.sources.find((item, index) => Number(asRecord(item).id ?? index + 1) === citation);
    const source = asRecord(raw);
    const url = typeof source.url === 'string' ? source.url : null;
    const chip = <span className="inline-flex items-center gap-1 rounded-md border border-hairline bg-paper px-2 py-1 text-[10.5px] text-brand">[{citation}] {String(source.document ?? '来源')}</span>;
    return url ? <a key={citation} href={url} target="_blank" rel="noreferrer" className="hover:underline">{chip}</a> : <span key={citation}>{chip}</span>;
  })}</div>;
}

function QuizBlock({
  block, resource, onResourceState,
}: {
  block: LearningBlock;
  resource: LearningResource;
  onResourceState: (state: Record<string, unknown>) => void;
}) {
  const question = block.question ?? {};
  const id = block.id;
  const persisted = asRecords(resource.state.answered).find((item) => String(item.questionId) === id);
  const [selected, setSelected] = useState<number | null>(persisted ? Number(persisted.selectedIndex) : null);
  const [feedback, setFeedback] = useState<Record<string, unknown> | null>(persisted ? { correct: Boolean(persisted.correct) } : null);
  const [submitting, setSubmitting] = useState(false);
  const startedAt = useRef(Date.now());

  const answer = async (optionIndex: number) => {
    if (selected !== null || submitting) return;
    setSubmitting(true);
    try {
      const result = await api.answerLearningQuiz(resource.id, {
        questionId: id, answer: String(optionIndex), durationSeconds: Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)),
      });
      setSelected(optionIndex);
      setFeedback(result);
      if (result.state && typeof result.state === 'object') onResourceState(result.state as Record<string, unknown>);
      const point = asRecord(result.knowledgePoint);
      void api.recordLearningEvent({
        eventType: 'QUIZ_SUBMIT', sourceType: 'QUIZ', sourceId: resource.id,
        knowledgeCategoryId: Number(point.categoryId) || null,
        durationSeconds: Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)),
        metadata: JSON.stringify({ questionId: id, correct: Boolean(result.correct), courseId: resource.courseId, chapterId: resource.chapterId }),
      }).catch(() => undefined);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '提交答案失败');
    } finally {
      setSubmitting(false);
    }
  };

  const correctIndex = feedback && typeof feedback.correctIndex === 'number' ? feedback.correctIndex : null;
  return <div className="mt-5 grid gap-2.5">{asStrings(question.options).map((option, index) => {
    const chosen = selected === index;
    const correct = correctIndex === index;
    return <button key={`${id}-${index}`} type="button" disabled={selected !== null || submitting} onClick={() => void answer(index)} className={cn('flex items-start gap-3 rounded-[12px] border px-4 py-3.5 text-left text-[13.5px] leading-6 transition-all', selected === null && 'border-hairline bg-paper hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-xs', chosen && Boolean(feedback?.correct) && 'border-brand bg-brand-tint text-brand', chosen && Boolean(feedback) && !Boolean(feedback?.correct) && 'border-brand-danger bg-brand-danger/10 text-brand-danger', correct && selected !== null && 'border-brand bg-brand-tint text-brand')}><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-current/20 font-mono text-[11px]">{String.fromCharCode(65 + index)}</span><span>{option}</span></button>;
  })}{submitting && <p className="flex items-center gap-2 text-[12px] text-ink-muted"><Loader2 size={13} className="animate-spin" />正在判分并更新学习记录…</p>}{feedback && <div className={cn('rounded-[12px] px-4 py-3 text-[13px] leading-6', feedback.correct ? 'bg-brand-tint text-brand' : 'bg-brand-danger/10 text-ink-2')}><strong>{feedback.correct ? '回答正确。' : '这次还没有答对。'}</strong>{feedback.explanation ? <span className="ml-1">{String(feedback.explanation)}</span> : persisted ? <span className="ml-1 text-ink-muted">作答结果已保存。</span> : null}{typeof feedback.masteryDelta === 'number' && <div className="mt-1 font-mono text-[10.5px] opacity-75">掌握度变化 {Number(feedback.masteryDelta) >= 0 ? '+' : ''}{Number(feedback.masteryDelta).toFixed(1)}%</div>}</div>}</div>;
}

export default function CourseResourcePlayer() {
  const { resourceId = '' } = useParams();
  const navigate = useNavigate();
  const { focusMode, setFocusMode } = useGrowth();
  const [resource, setResource] = useState<LearningResource | null>(null);
  const [course, setCourse] = useState<Course | null>(null);
  const [chapterResources, setChapterResources] = useState<LearningResourceSummary[]>([]);
  const [traces, setTraces] = useState<LearningResourceTrace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [currentBlockId, setCurrentBlockId] = useState('');
  const [visited, setVisited] = useState<string[]>([]);
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);
  const [elapsedBase, setElapsedBase] = useState(0);
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [noteFor, setNoteFor] = useState<LearningBlock | null>(null);
  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState<LearningResourceMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [asking, setAsking] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [completing, setCompleting] = useState(false);
  const blockRefs = useRef<Record<string, HTMLElement | null>>({});
  const saveTimer = useRef<number | null>(null);
  const sessionSecondsRef = useRef(0);
  const speechRef = useRef<SpeechSynthesisUtterance | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([api.getLearningResource(resourceId), api.getLearningResourceTraceability(resourceId).catch(() => ({ items: [] }))])
      .then(async ([loaded, traceResult]) => {
        if (cancelled) return;
        setResource(loaded);
        setTraces(traceResult.items);
        const progress = progressOf(loaded);
        const parsedBlocks = blocksOf(loaded);
        setCurrentBlockId(progress.currentBlockId && parsedBlocks.some((block) => block.id === progress.currentBlockId) ? progress.currentBlockId : parsedBlocks[0]?.id ?? '');
        setVisited(progress.visitedBlockIds);
        setCompletedSteps(progress.completedStepIds);
        setElapsedBase(progress.elapsedSeconds);
        setSessionSeconds(0);
        sessionSecondsRef.current = 0;
        if (loaded.courseId && loaded.chapterId) {
          const [loadedCourse, listed] = await Promise.all([
            api.getCourse(loaded.courseId),
            api.listLearningResources({ courseId: loaded.courseId, chapterId: loaded.chapterId }),
          ]);
          if (!cancelled) { setCourse(loadedCourse); setChapterResources(listed.resources ?? []); }
        } else if (!cancelled) { setCourse(null); setChapterResources([]); }
        void api.recordLearningEvent({ eventType: 'RESOURCE_VIEW', sourceType: 'RESOURCE', sourceId: loaded.id, metadata: JSON.stringify({ courseId: loaded.courseId, chapterId: loaded.chapterId, resourceType: loaded.type }) }).catch(() => undefined);
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : '学习资源加载失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [resourceId]);

  const blocks = useMemo(() => resource ? blocksOf(resource) : [], [resource]);
  const chapter = useMemo<CourseChapter | null>(() => course?.chapters.find((item) => item.id === resource?.chapterId) ?? null, [course, resource?.chapterId]);
  const currentIndex = Math.max(0, blocks.findIndex((block) => block.id === currentBlockId));
  const completionPercent = blocks.length ? Math.round((unique(visited).length / blocks.length) * 100) : 0;

  useEffect(() => {
    if (!resource) return;
    const id = window.setInterval(() => setSessionSeconds((value) => {
      const next = value + 1;
      sessionSecondsRef.current = next;
      return next;
    }), 1000);
    return () => window.clearInterval(id);
  }, [resource?.id]);

  const saveProgress = useCallback((nextCurrent: string, nextVisited: string[], nextSteps: string[], elapsed: number) => {
    if (!resource) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void api.updateLearningResourceProgress(resource.id, {
        currentBlockId: nextCurrent, visitedBlockIds: unique(nextVisited), completedStepIds: unique(nextSteps), elapsedSeconds: elapsed,
      }).catch(() => undefined);
    }, 650);
  }, [resource]);

  useEffect(() => {
    if (!blocks.length) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      const id = visible.target.getAttribute('data-block-id');
      if (!id) return;
      setCurrentBlockId(id);
      setVisited((current) => {
        const next = unique([...current, id]);
        saveProgress(id, next, completedSteps, elapsedBase + sessionSecondsRef.current);
        return next;
      });
    }, { rootMargin: '-18% 0px -58% 0px', threshold: [0.1, 0.35, 0.65] });
    Object.values(blockRefs.current).forEach((element) => { if (element) observer.observe(element); });
    return () => observer.disconnect();
  }, [blocks, completedSteps, elapsedBase, saveProgress]);

  useEffect(() => () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    window.speechSynthesis?.cancel();
    setFocusMode(false);
  }, [setFocusMode]);

  const goBlock = (id: string) => {
    setCurrentBlockId(id);
    setVisited((current) => {
      const next = unique([...current, id]);
      saveProgress(id, next, completedSteps, elapsedBase + sessionSecondsRef.current);
      return next;
    });
    blockRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const toggleStep = (id: string) => {
    const next = completedSteps.includes(id) ? completedSteps.filter((item) => item !== id) : [...completedSteps, id];
    setCompletedSteps(next);
    setVisited((current) => {
      const nextVisited = unique([...current, id]);
      saveProgress(id, nextVisited, next, elapsedBase + sessionSecondsRef.current);
      return nextVisited;
    });
  };

  const speakCurrent = () => {
    if (!('speechSynthesis' in window)) { toast.error('当前浏览器不支持语音讲播'); return; }
    if (speaking) { window.speechSynthesis.cancel(); setSpeaking(false); return; }
    const block = blocks[currentIndex];
    if (!block) return;
    const utterance = new SpeechSynthesisUtterance(`${block.title}。${block.body ?? ''}`.replace(/[#*_`>\-[\]]/g, ' '));
    utterance.lang = 'zh-CN'; utterance.rate = 0.92;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    speechRef.current = utterance;
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  };

  const saveNote = async () => {
    if (!resource || !noteFor || !noteText.trim()) return;
    setSavingNote(true);
    try {
      await api.createNote({
        title: noteFor.title.slice(0, 160), content: noteText.trim(), kpId: chapter?.id ?? resource.chapterId ?? undefined,
        sourceKind: 'course', sourceType: 'course', sourceRef: `${resource.id}#${noteFor.id}`,
        sourceContext: `${chapter?.title ?? resource.topic} · ${noteFor.title}`, kbRefs: sourceIds(resource, noteFor.citations),
      });
      toast.success('笔记已写入个人知识库');
      setNoteFor(null); setNoteText('');
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : '笔记保存失败'); }
    finally { setSavingNote(false); }
  };

  const openChat = async () => {
    setChatOpen(true);
    if (!resource || messages.length) return;
    const result = await api.listLearningResourceMessages(resource.id).catch(() => ({ messages: [] }));
    setMessages(result.messages);
  };

  const ask = async (text = question) => {
    const content = text.trim();
    if (!resource || !content || asking) return;
    const optimistic: LearningResourceMessage = { role: 'user', content, createdAt: new Date().toISOString() };
    setMessages((current) => [...current, optimistic]); setQuestion(''); setAsking(true);
    try {
      const result = await api.chatLearningResource(resource.id, {
        message: content,
        history: messages.slice(-12).map(({ role, content: itemContent }) => ({ role, content: itemContent })),
        currentQuestionId: blocks[currentIndex]?.kind === 'quiz' ? blocks[currentIndex].id : null,
      });
      setMessages((current) => [...current, { role: 'assistant', content: result.reply, createdAt: new Date().toISOString() }]);
      setFollowUps(result.followUps ?? []);
      void api.recordLearningEvent({ eventType: 'CHAT_INTERACTION', sourceType: 'CHAT', sourceId: resource.id, metadata: JSON.stringify({ courseId: resource.courseId, chapterId: resource.chapterId }) }).catch(() => undefined);
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : '提问失败'); }
    finally { setAsking(false); }
  };

  const markComplete = async () => {
    if (!resource || completing) return;
    setCompleting(true);
    try {
      const result = await api.completeLearningResource(resource.id);
      setResource(result.resource);
      await api.updateLearningResourceProgress(resource.id, { currentBlockId, visitedBlockIds: blocks.map((block) => block.id), completedStepIds: completedSteps, elapsedSeconds: elapsedBase + sessionSecondsRef.current });
      void api.recordLearningEvent({ eventType: 'STUDY_END', sourceType: 'RESOURCE', sourceId: resource.id, durationSeconds: elapsedBase + sessionSecondsRef.current, metadata: JSON.stringify({ courseId: resource.courseId, chapterId: resource.chapterId, resourceType: resource.type, completed: true }) }).catch(() => undefined);
      setVisited(blocks.map((block) => block.id));
      toast.success('学习进度已保存', { description: '画像、报告和继续学习会使用这次真实记录。' });
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : '完成状态保存失败'); }
    finally { setCompleting(false); }
  };

  if (loading) return <div className="mx-auto flex min-h-[62vh] max-w-[980px] items-center justify-center gap-2 px-5 text-[13px] text-ink-muted"><Loader2 size={17} className="animate-spin" />正在恢复你的学习现场…</div>;
  if (error || !resource) return <div className="mx-auto max-w-[760px] px-5 py-20 text-center"><h1 className="font-serif text-[24px] font-semibold text-ink">这项学习资源暂时打不开</h1><p className="mt-2 text-[13px] text-brand-danger">{error || '资源不存在'}</p><Link to="/learn" className="lf-btn-primary mt-5 inline-flex">返回我的课程</Link></div>;

  const activeBlock = blocks[currentIndex];
  const sortedResources = [...chapterResources].sort((a, b) => ({ lecture: 0, practice: 1, quiz: 2 }[a.type] - ({ lecture: 0, practice: 1, quiz: 2 }[b.type])));
  const resourceIndex = sortedResources.findIndex((item) => item.id === resource.id);
  const nextResource = resourceIndex >= 0 ? sortedResources[resourceIndex + 1] : undefined;

  return <div className={cn('mx-auto max-w-[1260px] px-4 pb-40 pt-6 md:px-6', focusMode && 'max-w-[1040px]')}>
    {!focusMode && <div className="mb-5 flex flex-wrap items-center gap-2 text-[12px] text-ink-muted"><button type="button" onClick={() => navigate('/learn')} className="inline-flex items-center gap-1 hover:text-brand"><ArrowLeft size={13} />我的课程</button><ChevronRight size={12} /><Link to={`/resources?courseId=${encodeURIComponent(resource.courseId ?? '')}&chapterId=${encodeURIComponent(resource.chapterId ?? '')}`} className="hover:text-brand">{chapter?.title ?? '章节资源'}</Link><ChevronRight size={12} /><span className="truncate text-ink-2">{resourceMeta[resource.type].label}</span></div>}

    <header className="relative overflow-hidden rounded-[20px] border border-brand/20 bg-gradient-to-br from-brand-tint/70 via-card-warm to-paper p-6 md:p-8">
      <div className="absolute -right-14 -top-16 h-44 w-44 rounded-full bg-brand/5 blur-2xl" />
      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-[800px]"><div className="lf-mono-label flex items-center gap-2"><BookOpen size={13} />{course?.title ?? '真实课程'} · {chapter ? `第 ${chapter.index} 章` : resourceMeta[resource.type].label}</div><h1 className="mt-2 font-serif text-[29px] font-semibold leading-tight text-ink md:text-[35px]">{resource.title}</h1><p className="mt-3 max-w-[720px] text-[13.5px] leading-6 text-ink-muted">{chapter?.summary || resource.topic}</p></div>
        <div className="min-w-[220px] rounded-[14px] border border-white/60 bg-paper/70 p-4 backdrop-blur"><div className="flex items-center justify-between text-[11px] text-ink-muted"><span>本资源学习进度</span><span className="font-mono text-brand">{resource.learned ? 100 : completionPercent}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-paper-deep"><motion.div className="h-full rounded-full bg-brand" animate={{ width: `${resource.learned ? 100 : completionPercent}%` }} /></div><div className="mt-3 flex items-center justify-between font-mono text-[10.5px] text-ink-muted"><span><Clock3 size={11} className="mr-1 inline" />{formatDuration(elapsedBase + sessionSeconds)}</span><span>{resource.learned ? blocks.length : unique(visited).length}/{blocks.length} 段</span></div></div>
      </div>
    </header>

    {!focusMode && sortedResources.length > 1 && <nav className="mt-4 flex gap-2 overflow-x-auto pb-1">{sortedResources.map((item) => { const Meta = resourceMeta[item.type]; return <Link key={item.id} to={`/learn/resource/${item.id}`} className={cn('flex shrink-0 items-center gap-2 rounded-[11px] border px-3.5 py-2 text-[12.5px] transition', item.id === resource.id ? 'border-brand bg-brand text-paper' : 'border-hairline bg-card-warm text-ink-2 hover:border-brand/40')}><Meta.Icon size={13} />{Meta.label}{item.learned && <Check size={12} />}</Link>; })}</nav>}

    <div className="mt-7 grid gap-7 lg:grid-cols-[250px_minmax(0,1fr)]">
      {!focusMode && <aside className="self-start lg:sticky lg:top-[76px]"><div className="rounded-[16px] border border-hairline bg-card-warm p-3"><div className="px-2 pb-2"><div className="lf-mono-label">LEARNING PATH</div><div className="mt-1 text-[13px] font-semibold text-ink">本讲目录</div></div><div className="max-h-[58vh] space-y-1 overflow-y-auto">{blocks.map((block, index) => { const done = visited.includes(block.id) || resource.learned; return <button key={block.id} type="button" onClick={() => goBlock(block.id)} className={cn('flex w-full items-start gap-2.5 rounded-[10px] px-2.5 py-2.5 text-left transition', block.id === currentBlockId ? 'bg-brand-tint text-brand' : 'text-ink-2 hover:bg-paper-deep')}><span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[9px]', done ? 'border-brand bg-brand text-paper' : 'border-hairline bg-paper text-ink-muted')}>{done ? <Check size={10} /> : index + 1}</span><span className="min-w-0"><span className="block text-[10px] opacity-65">{block.eyebrow}</span><span className="mt-0.5 block text-[12px] font-medium leading-[17px]">{block.title}</span></span></button>; })}</div></div>{progressOf(resource).lastOpenedAt && <p className="mt-3 px-2 text-[10.5px] leading-5 text-ink-muted">已从后端恢复上次断点：{new Date(progressOf(resource).lastOpenedAt!).toLocaleString()}</p>}</aside>}

      <main className="min-w-0 space-y-6">{blocks.length === 0 ? <div className="rounded-[16px] border border-dashed border-hairline p-12 text-center"><p className="text-[14px] text-ink-muted">当前资源没有可学习的正文。</p><Link to={`/resources?courseId=${resource.courseId}&chapterId=${resource.chapterId}`} className="lf-btn-primary mt-4 inline-flex">重新生成资源</Link></div> : blocks.map((block, index) => <motion.section key={block.id} ref={(element) => { blockRefs.current[block.id] = element; }} data-block-id={block.id} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-80px' }} className={cn('scroll-mt-28 rounded-[18px] border bg-card-warm p-5 shadow-xs transition md:p-7', block.id === currentBlockId ? 'border-brand/35 shadow-warm' : 'border-hairline')}>
        <div className="flex items-start gap-4"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-brand-tint font-mono text-[11px] font-semibold text-brand">{String(index + 1).padStart(2, '0')}</span><div className="min-w-0 flex-1"><div className="lf-mono-label !text-[10px]">{block.eyebrow}</div><h2 className="mt-1 font-serif text-[22px] font-semibold leading-tight text-ink md:text-[25px]">{block.title}</h2></div>{block.kind === 'practice' && <button type="button" onClick={() => toggleStep(block.id)} className={cn('flex shrink-0 items-center gap-1.5 rounded-[10px] border px-3 py-2 text-[11.5px]', completedSteps.includes(block.id) ? 'border-brand bg-brand text-paper' : 'border-hairline bg-paper text-ink-muted hover:border-brand/40')} >{completedSteps.includes(block.id) ? <CheckCircle2 size={14} /> : <Circle size={14} />}完成步骤</button>}</div>
        {block.body && <div className="prose prose-sm mt-5 max-w-none text-[14px] leading-7 text-ink-2 prose-headings:font-serif prose-headings:text-ink prose-a:text-brand prose-code:text-brand prose-li:my-1"><ReactMarkdown remarkPlugins={[remarkGfm]}>{block.body}</ReactMarkdown></div>}
        {block.code && <pre className="mt-5 overflow-x-auto rounded-[12px] bg-ink px-4 py-4 text-[12px] leading-6 text-paper"><code>{block.code}</code></pre>}
        {block.expectedOutput && <div className="mt-4 rounded-[12px] border border-brand/20 bg-brand-tint/35 px-4 py-3 text-[13px] leading-6 text-ink-2"><strong className="text-brand">预期结果：</strong>{block.expectedOutput}</div>}
        {block.kind === 'quiz' && <QuizBlock block={block} resource={resource} onResourceState={(state) => setResource((current) => current ? { ...current, state, learned: Boolean(state.learned || state.completed) } : current)} />}
        <BlockSources citations={block.citations} resource={resource} />
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-hairline/70 pt-4"><button type="button" onClick={() => { setNoteFor(block); setNoteText(''); }} className="lf-btn-ghost !px-3 !py-1.5 text-[11.5px]"><NotebookPen size={13} />记这一段</button><button type="button" onClick={() => { setCurrentBlockId(block.id); void openChat(); }} className="lf-btn-ghost !px-3 !py-1.5 text-[11.5px]"><MessageCircleQuestion size={13} />向导学老师提问</button>{index < blocks.length - 1 && <button type="button" onClick={() => goBlock(blocks[index + 1].id)} className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-brand hover:underline">下一段<ArrowRight size={12} /></button>}</div>
      </motion.section>)}</main>
    </div>

    {traces.length > 0 && !focusMode && <section className="mt-8 rounded-[18px] border border-hairline bg-card-warm p-5 md:p-7"><div className="flex items-center gap-2"><Sparkles size={16} className="text-brand" /><h2 className="font-serif text-[20px] font-semibold text-ink">真实来源与生成依据</h2></div><p className="mt-1 text-[12px] text-ink-muted">以下来源由知识库检索或 Web Search 提供，并与正文引用位置关联。</p><div className="mt-4 grid gap-3 md:grid-cols-2">{traces.map((trace, traceIndex) => <article key={`${String(trace.id ?? 'source')}-${trace.title}-${traceIndex}`} className="rounded-[12px] border border-hairline bg-paper p-4"><div className="flex items-start gap-3"><span className="rounded-md bg-brand-tint px-2 py-1 font-mono text-[10px] text-brand">{trace.credibility}%</span><div className="min-w-0"><h3 className="text-[13px] font-semibold text-ink">{trace.title}</h3><p className="mt-1 line-clamp-3 text-[11.5px] leading-5 text-ink-muted">{trace.excerpt}</p></div></div>{trace.positions.length > 0 && <div className="mt-3 flex flex-wrap gap-1">{trace.positions.slice(0, 5).map((position, positionIndex) => <span key={`${position}-${positionIndex}`} className="rounded bg-paper-deep px-1.5 py-1 text-[9.5px] text-ink-muted">{position}</span>)}</div>}{trace.url && <a href={trace.url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-[11px] text-brand hover:underline">查看来源<ExternalLink size={10} /></a>}</article>)}</div></section>}

    <footer className="mt-8 flex flex-col items-center justify-between gap-4 rounded-[18px] border border-brand/20 bg-brand-tint/30 p-5 sm:flex-row"><div><div className="text-[13px] font-semibold text-ink">{resource.learned ? '本项资源已经学完' : '完成本项学习后，进度会写入画像与报告'}</div><p className="mt-1 text-[11.5px] text-ink-muted">阅读 {resource.learned ? blocks.length : unique(visited).length}/{blocks.length} 段 · 学习 {formatDuration(elapsedBase + sessionSeconds)}</p></div><div className="flex gap-2">{nextResource && <Link to={`/learn/resource/${nextResource.id}`} className="lf-btn-ghost">下一项：{resourceMeta[nextResource.type].label}<ArrowRight size={14} /></Link>}<button type="button" disabled={resource.learned || completing} onClick={() => void markComplete()} className="lf-btn-primary">{completing ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}{resource.learned ? '已完成' : '完成本项学习'}</button></div></footer>

    <div className="fixed inset-x-0 bottom-[58px] z-40 mx-auto flex w-[min(760px,calc(100%-24px))] items-center gap-2 rounded-[17px] border border-hairline bg-paper/95 p-2.5 shadow-warm-lg backdrop-blur-md md:bottom-4"><button type="button" onClick={speakCurrent} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-paper" title="讲这一段">{speaking ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button><div className="min-w-0 flex-1"><div className="truncate text-[12.5px] font-medium text-ink">{activeBlock?.title ?? resource.title}</div><div className="mt-0.5 flex items-center gap-2 font-mono text-[9.5px] text-ink-muted"><span><Headphones size={10} className="mr-1 inline" />{speaking ? '正在讲播' : '点击播放当前段落'}</span><span>{currentIndex + 1}/{blocks.length}</span></div></div><button type="button" onClick={() => { setFocusMode(!focusMode); if (speaking) { window.speechSynthesis.cancel(); setSpeaking(false); } }} className={cn('flex h-9 items-center gap-1.5 rounded-[10px] border px-3 text-[11px]', focusMode ? 'border-brand bg-brand-tint text-brand' : 'border-hairline text-ink-muted')}><Focus size={13} /><span className="hidden sm:inline">{focusMode ? '退出专注' : '专注'}</span></button><button type="button" onClick={() => void openChat()} className="flex h-9 items-center gap-1.5 rounded-[10px] border border-hairline px-3 text-[11px] text-ink-muted"><Bot size={13} /><span className="hidden sm:inline">提问</span></button><button type="button" onClick={() => activeBlock && setNoteFor(activeBlock)} className="flex h-9 items-center gap-1.5 rounded-[10px] border border-hairline px-3 text-[11px] text-ink-muted"><NotebookPen size={13} /><span className="hidden sm:inline">笔记</span></button></div>

    <AnimatePresence>{noteFor && <><motion.button type="button" aria-label="关闭笔记" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setNoteFor(null)} className="fixed inset-0 z-[70] bg-ink/20 backdrop-blur-[2px]" /><motion.aside initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} className="fixed inset-y-0 right-0 z-[80] flex w-full max-w-[460px] flex-col border-l border-hairline bg-paper shadow-2xl"><div className="flex items-start gap-3 border-b border-hairline p-5"><NotebookPen size={18} className="mt-1 text-brand" /><div className="min-w-0 flex-1"><div className="lf-mono-label">PERSONAL NOTE</div><h2 className="mt-1 truncate font-serif text-[20px] font-semibold text-ink">{noteFor.title}</h2></div><button type="button" onClick={() => setNoteFor(null)} className="rounded-lg p-2 text-ink-muted hover:bg-paper-deep"><X size={16} /></button></div><div className="flex-1 p-5"><p className="text-[12px] leading-5 text-ink-muted">笔记会关联当前课程、资源段落和引用来源，保存到“我的笔记”。</p><textarea autoFocus value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder="写下你的理解、疑问或总结…" className="mt-4 min-h-[260px] w-full resize-none rounded-[13px] border border-hairline bg-card-warm p-4 text-[13.5px] leading-6 text-ink outline-none focus:border-brand/45" /></div><div className="border-t border-hairline p-4"><button type="button" disabled={!noteText.trim() || savingNote} onClick={() => void saveNote()} className="lf-btn-primary w-full justify-center">{savingNote && <Loader2 size={14} className="animate-spin" />}保存到个人知识库</button></div></motion.aside></>}</AnimatePresence>

    <AnimatePresence>{chatOpen && <><motion.button type="button" aria-label="关闭提问" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setChatOpen(false)} className="fixed inset-0 z-[70] bg-ink/20 backdrop-blur-[2px]" /><motion.aside initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} className="fixed inset-y-0 right-0 z-[80] flex w-full max-w-[500px] flex-col border-l border-hairline bg-paper shadow-2xl"><div className="flex items-center gap-3 border-b border-hairline bg-card-warm p-4"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-paper"><Bot size={17} /></span><div className="min-w-0 flex-1"><h2 className="text-[14px] font-semibold text-ink">章节导学老师</h2><p className="truncate text-[10.5px] text-ink-muted">正在结合本资源正文、作答状态和真实来源回答</p></div><button type="button" onClick={() => setChatOpen(false)} className="rounded-lg p-2 text-ink-muted hover:bg-paper-deep"><X size={16} /></button></div><div className="flex-1 space-y-3 overflow-y-auto p-4">{messages.length === 0 && <div className="rounded-[13px] border border-brand/20 bg-brand-tint/35 p-4 text-[12.5px] leading-6 text-ink-2">我已经读过这项资源和它引用的知识库、网页来源。你可以让我解释当前段落、检查理解，或根据作答记录生成巩固建议。</div>}{messages.map((message, index) => <div key={`${message.createdAt}-${index}`} className={cn('w-fit max-w-[90%] rounded-[13px] px-3.5 py-2.5 text-[12.5px] leading-6', message.role === 'user' ? 'ml-auto rounded-br-sm bg-brand text-paper' : 'rounded-tl-sm border border-hairline bg-card-warm text-ink-2')}><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>)}{asking && <div className="flex items-center gap-2 text-[11.5px] text-ink-muted"><Loader2 size={13} className="animate-spin" />正在结合内容与来源思考…</div>}{followUps.length > 0 && <div className="flex flex-wrap gap-1.5">{followUps.map((item) => <button key={item} type="button" onClick={() => void ask(item)} className="rounded-lg border border-hairline bg-card-warm px-2.5 py-1.5 text-left text-[10.5px] text-brand hover:border-brand/40">{item}</button>)}</div>}</div><div className="border-t border-hairline bg-card-warm p-3"><div className="flex items-end gap-2"><textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask(); } }} placeholder="问当前内容，Enter 发送…" className="max-h-28 min-h-10 flex-1 resize-none rounded-[11px] border border-hairline bg-paper px-3 py-2.5 text-[12.5px] outline-none focus:border-brand/45" /><button type="button" disabled={!question.trim() || asking} onClick={() => void ask()} className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-brand text-paper disabled:opacity-40"><Send size={15} /></button></div></div></motion.aside></>}</AnimatePresence>
  </div>;
}
