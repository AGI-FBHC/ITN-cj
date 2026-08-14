import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCitationMarks from '@/lib/remarkCitationMarks';
import {
  ArrowLeft, ArrowRight, BookOpen, Bot, Check, CheckCircle2, ChevronLeft,
  ChevronRight, Circle, Clock3, CloudRain, ExternalLink, FileText, Focus,
  Gauge, Headphones, ListChecks, Loader2, MessageCircleQuestion, NotebookPen,
  Pause, PenLine, Play, Presentation, Send, ShieldAlert, ShieldCheck, Sparkles,
  Star, Trees, TriangleAlert, Wrench, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, streamAssistantTts } from '@/lib/api';
import type {
  Course, CourseChapter, LearningResource, LearningResourceMessage,
  LearningResourceProgress, LearningResourceSummary, LearningResourceTrace, TtsSpeed,
} from '@/lib/api';
import { useGrowth } from '@/context/GrowthContext';
import { useAmbient } from '@/components/heal/useAmbient';
import { cn } from '@/lib/utils';
import { lectureMdComponents, slideMdComponents } from '@/components/resources/lecture-markdown';
import SourceCitationMarks from '@/components/resources/SourceCitationMarks';
import { refreshLearningMapResourceCache } from '@/hooks/useLearningMap';
import { useProfile } from '@/context/ProfileContext';

type ResourceKind = 'lecture' | 'practice' | 'quiz';
type BlockKind = 'intro' | 'lecture' | 'practice' | 'quiz' | 'review';

/** 资源播放页静态内容缓存：资源/章节资源短时缓存，减少重复网络请求 */
const RESOURCE_CACHE_PREFIX = 'lf.resourcePlayer:v1:';
const RESOURCE_CACHE_TTL_MS = 5 * 60 * 1000;

interface ResourcePlayerCache {
  resource: LearningResource;
  course: Course | null;
  chapterResources: LearningResourceSummary[];
  traces: LearningResourceTrace[];
  savedAt: number;
}

function readResourcePlayerCache(resourceId: string): ResourcePlayerCache | null {
  try {
    const raw = window.localStorage.getItem(`${RESOURCE_CACHE_PREFIX}${resourceId}`);
    if (!raw) return null;
    const cache = JSON.parse(raw) as ResourcePlayerCache;
    if (!cache.resource || Date.now() - cache.savedAt > RESOURCE_CACHE_TTL_MS) return null;
    return cache;
  } catch {
    return null;
  }
}

function writeResourcePlayerCache(resourceId: string, cache: Omit<ResourcePlayerCache, 'savedAt'>) {
  try {
    window.localStorage.setItem(`${RESOURCE_CACHE_PREFIX}${resourceId}`, JSON.stringify({ ...cache, savedAt: Date.now() }));
  } catch {
    /* ignore */
  }
}


interface LearningBlock {
  id: string;
  kind: BlockKind;
  eyebrow: string;
  title: string;
  body?: string;
  citations: number[];
  evidenceQuotes?: unknown;
  code?: string;
  expectedOutput?: string;
  safety?: 'safe' | 'caution' | 'danger';
  warning?: string;
  question?: Record<string, unknown>;
}

const resourceMeta: Record<ResourceKind, { label: string; Icon: typeof FileText }> = {
  lecture: { label: '领学讲义', Icon: FileText },
  practice: { label: '实操指南', Icon: ListChecks },
  quiz: { label: '分阶测试', Icon: PenLine },
};

const speedMeta: Record<TtsSpeed, { label: string; rate: number }> = {
  very_slow: { label: '0.8×', rate: 0.8 },
  slow: { label: '0.9×', rate: 0.9 },
  normal: { label: '1.0×', rate: 1 },
  fast: { label: '1.1×', rate: 1.1 },
  very_fast: { label: '1.2×', rate: 1.2 },
};
const speedOrder = Object.keys(speedMeta) as TtsSpeed[];

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const asRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.map(String).filter(Boolean) : [];
const asNumbers = (value: unknown): number[] => Array.isArray(value) ? [...new Set(value.map(Number).filter(Number.isFinite))] : [];
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const isUuid = (value?: string | null) => Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));

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
          evidenceQuotes: section.evidenceQuotes,
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
      safety: ['safe', 'caution', 'danger'].includes(String(step.safety)) ? String(step.safety) as LearningBlock['safety'] : 'safe',
      warning: step.warning ? String(step.warning) : undefined,
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

function narrationText(block: LearningBlock): string {
  return `${block.title}。${block.body ?? ''}`
    .replace(/```[\s\S]*?```/g, ' 代码示例请看屏幕。')
    .replace(/[#*_`>\-[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2900);
}

function useResourceNarration() {
  const [speaking, setSpeaking] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const timerRef = useRef<number | null>(null);
  const generationRef = useRef(0);

  const stop = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    sourcesRef.current.forEach((source) => { try { source.stop(); } catch { /* already ended */ } });
    sourcesRef.current.clear();
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  const browserFallback = useCallback((text: string, speed: TtsSpeed, generation: number) => {
    if (!('speechSynthesis' in window) || generation !== generationRef.current) {
      setSpeaking(false);
      toast.error('当前设备暂时无法播放语音');
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = speedMeta[speed].rate;
    utterance.onend = () => { if (generation === generationRef.current) setSpeaking(false); };
    utterance.onerror = () => { if (generation === generationRef.current) setSpeaking(false); };
    window.speechSynthesis.speak(utterance);
  }, []);

  const play = useCallback(async (text: string, speed: TtsSpeed) => {
    stop();
    if (!text) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setSpeaking(true);
    try {
      const response = await streamAssistantTts(text, speed, controller.signal);
      const reader = response.body!.getReader();
      const AudioContextCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) throw new Error('AudioContext unavailable');
      contextRef.current ??= new AudioContextCtor({ sampleRate: 24_000 });
      const context = contextRef.current;
      await context.resume();
      let nextStart = context.currentTime + 0.06;
      let pending = new Uint8Array();
      let scheduled = 0;
      const chunkBytes = 3_840;
      const initialBufferBytes = chunkBytes * 2;
      const schedule = (pcm: Uint8Array) => {
        const usable = pcm.length - (pcm.length % 2);
        if (!usable || generation !== generationRef.current) return;
        const samples = new Float32Array(usable / 2);
        const view = new DataView(pcm.buffer, pcm.byteOffset, usable);
        for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
        const buffer = context.createBuffer(1, samples.length, 24_000);
        buffer.copyToChannel(samples, 0);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        sourcesRef.current.add(source);
        source.onended = () => sourcesRef.current.delete(source);
        source.start(nextStart);
        nextStart += buffer.duration;
        scheduled += 1;
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (generation !== generationRef.current) { await reader.cancel(); return; }
        if (!value?.length) continue;
        const merged = new Uint8Array(pending.length + value.length);
        merged.set(pending); merged.set(value, pending.length);
        if (!scheduled && merged.length < initialBufferBytes) {
          pending = merged;
          continue;
        }
        let offset = 0;
        while (merged.length - offset >= chunkBytes) {
          schedule(merged.slice(offset, offset + chunkBytes));
          offset += chunkBytes;
        }
        pending = merged.slice(offset);
      }
      schedule(pending);
      if (!scheduled) throw new Error('empty audio stream');
      const remainingMs = Math.max(50, Math.ceil((nextStart - context.currentTime) * 1000) + 80);
      timerRef.current = window.setTimeout(() => {
        if (generation === generationRef.current) setSpeaking(false);
      }, remainingMs);
    } catch (reason) {
      if ((reason as Error).name === 'AbortError' || generation !== generationRef.current) return;
      browserFallback(text, speed, generation);
    }
  }, [browserFallback, stop]);

  useEffect(() => () => {
    stop();
    if (contextRef.current) void contextRef.current.close();
  }, [stop]);

  return { speaking, play, stop };
}

function QuizBlock({
  block, resource, onResourceState, onWritebackStatus,
}: {
  block: LearningBlock;
  resource: LearningResource;
  onResourceState: (state: Record<string, unknown>) => void;
  onWritebackStatus: (status: 'syncing' | 'synced' | 'failed') => void;
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
      const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt.current) / 1000));
      const request = {
        questionId: id, answer: String(optionIndex), durationSeconds: Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)),
      };
      const result = await api.gradeLearningQuiz(resource.id, request);
      setSelected(optionIndex);
      setFeedback(result);
      const optimisticState = {
        ...resource.state,
        answered: [...asRecords(resource.state.answered), {
          questionId: id, correct: Boolean(result.correct), selectedIndex: optionIndex, durationSeconds,
        }],
      };
      onResourceState(optimisticState);
      onWritebackStatus('syncing');
      void api.answerLearningQuiz(resource.id, request).then((synced) => {
        if (synced.state && typeof synced.state === 'object') onResourceState(synced.state as Record<string, unknown>);
        setFeedback(synced);
        onWritebackStatus('synced');
      }).catch((reason) => {
        onWritebackStatus('failed');
        toast.error(reason instanceof Error ? reason.message : '学习记录同步失败，请稍后重试');
      });
      if (isUuid(resource.learnerId)) {
        void api.recordLearnerGrowthEvent({
          learnerId: resource.learnerId!,
          eventType: result.correct ? 'quiz-answer-correct' : 'quiz-answer',
          title: result.correct ? '答对一题' : '完成一道测试题',
          amount: result.correct ? 5 : 1,
          metadata: { resourceId: resource.id, questionId: id },
        }).catch(() => undefined);
      }
      const point = asRecord(result.knowledgePoint);
      void api.recordLearningEvent({
        eventType: 'QUIZ_SUBMIT', sourceType: 'QUIZ', sourceId: resource.id,
        knowledgeCategoryId: Number(point.categoryId) || null,
        durationSeconds,
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

function InlineBlockCitations({ block, resource }: { block: LearningBlock; resource: LearningResource }) {
  return <SourceCitationMarks citations={block.citations} evidenceQuotes={block.evidenceQuotes ?? asRecord(block.question).answerEvidenceQuotes} resource={resource} className="mt-2" />;
}

function assessmentsOf(resource: LearningResource): Record<string, number> {
  const raw = asRecord(resource.state.selfAssessments);
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Math.max(0, Math.min(1, Number(value) || 0))]));
}

const difficultyMeta = {
  easy: { label: '基础', color: '#287a62', stars: 1 },
  medium: { label: '进阶', color: '#b17818', stars: 2 },
  hard: { label: '挑战', color: '#b94f45', stars: 3 },
} as const;

function DifficultyStars({ count, color }: { count: number; color: string }) {
  return <span className="flex gap-0.5">{[1, 2, 3].map((item) => <Star key={item} size={12} fill={item <= count ? color : 'transparent'} stroke={color} className={item <= count ? '' : 'opacity-30'} />)}</span>;
}

export default function CourseResourcePlayer() {
  const { currentLearnerId } = useProfile();
  const { resourceId = '' } = useParams();
  const navigate = useNavigate();
  const { focusMode, setFocusMode } = useGrowth();
  const narration = useResourceNarration();
  const ambient = useAmbient();
  const [resource, setResource] = useState<LearningResource | null>(null);
  const [writebackStatus, setWritebackStatus] = useState<'idle' | 'syncing' | 'synced' | 'failed'>('idle');
  const [course, setCourse] = useState<Course | null>(null);
  const [chapterResources, setChapterResources] = useState<LearningResourceSummary[]>([]);
  const [traces, setTraces] = useState<LearningResourceTrace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [currentBlockId, setCurrentBlockId] = useState('');
  const [visited, setVisited] = useState<string[]>([]);
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);
  const [safetyChecks, setSafetyChecks] = useState<string[]>([]);
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
  const [speechSpeed, setSpeechSpeed] = useState<TtsSpeed>('normal');
  const [slideMode, setSlideMode] = useState(false);

  useEffect(() => {
    if (writebackStatus !== 'synced') return undefined;
    const timer = window.setTimeout(() => setWritebackStatus('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [writebackStatus]);
  const [completing, setCompleting] = useState(false);
  const [completeConfirmOpen, setCompleteConfirmOpen] = useState(false);
  const blockRefs = useRef<Record<string, HTMLElement | null>>({});
  const saveTimer = useRef<number | null>(null);
  const sessionSecondsRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    const applyLoaded = (loaded: LearningResource, traceResult: LearningResourceTrace[], loadedCourse: Course | null, loadedResources: LearningResourceSummary[]) => {
      if (cancelled) return;
      setResource(loaded);
      setTraces(traceResult);
      setCourse(loadedCourse);
      setChapterResources(loadedResources);
      const progress = progressOf(loaded);
      const parsedBlocks = blocksOf(loaded);
      setCurrentBlockId(progress.currentBlockId && parsedBlocks.some((block) => block.id === progress.currentBlockId) ? progress.currentBlockId : parsedBlocks[0]?.id ?? '');
      setVisited(progress.visitedBlockIds);
      setCompletedSteps(progress.completedStepIds);
      setElapsedBase(progress.elapsedSeconds);
      setSessionSeconds(0);
      sessionSecondsRef.current = 0;
      setLoading(false);
    };

    const cached = readResourcePlayerCache(resourceId);
    if (cached) {
      applyLoaded(cached.resource, cached.traces, cached.course, cached.chapterResources);
      return () => { cancelled = true; };
    }

    Promise.all([api.getLearningResource(resourceId), api.getLearningResourceTraceability(resourceId).catch(() => ({ items: [] }))])
      .then(async ([loaded, traceResult]) => {
        if (cancelled) return;
        let loadedCourse: Course | null = null;
        let loadedResources: LearningResourceSummary[] = [];
        if (loaded.courseId && loaded.chapterId) {
          const [courseResult, listed] = await Promise.all([
            api.getCourse(loaded.courseId),
            api.listLearningResources({ courseId: loaded.courseId, chapterId: loaded.chapterId }),
          ]);
          loadedCourse = courseResult;
          loadedResources = listed.resources ?? [];
        }
        applyLoaded(loaded, traceResult.items, loadedCourse, loadedResources);
        writeResourcePlayerCache(resourceId, { resource: loaded, course: loadedCourse, chapterResources: loadedResources, traces: traceResult.items });
        void api.recordLearningEvent({ eventType: 'RESOURCE_VIEW', sourceType: 'RESOURCE', sourceId: loaded.id, metadata: JSON.stringify({ courseId: loaded.courseId, chapterId: loaded.chapterId, resourceType: loaded.type }) }).catch(() => undefined);
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : '学习资源加载失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [resourceId]);

  const blocks = useMemo(() => resource ? blocksOf(resource) : [], [resource]);
  const chapter = useMemo<CourseChapter | null>(() => course?.chapters.find((item) => item.id === resource?.chapterId) ?? null, [course, resource?.chapterId]);
  const currentIndex = Math.max(0, blocks.findIndex((block) => block.id === currentBlockId));
  const quizAnswers = useMemo(() => new Map(
    resource?.type === 'quiz'
      ? asRecords(resource.state.answered).map((item) => [String(item.questionId), Boolean(item.correct)] as const)
      : [],
  ), [resource]);
  const completedBlockCount = resource?.type === 'quiz' ? quizAnswers.size : unique(visited).length;
  const completionPercent = blocks.length ? Math.round((completedBlockCount / blocks.length) * 100) : 0;
  const displayedCompletionPercent = resource?.type === 'quiz' ? completionPercent : resource?.learned ? 100 : completionPercent;
  const displayedCompletedCount = resource?.type === 'quiz' ? completedBlockCount : resource?.learned ? blocks.length : completedBlockCount;
  const quizAllAnswered = resource?.type !== 'quiz' || (blocks.length > 0 && completedBlockCount === blocks.length);
  const safetyChecklist = resource?.type === 'practice' ? asStrings(resource.content.safetyChecklist) : [];
  const safetyReady = safetyChecklist.length === 0 || safetyChecklist.every((item) => safetyChecks.includes(item));
  const quizTiers = resource?.type === 'quiz' ? (['easy', 'medium', 'hard'] as const).map((difficulty) => {
    const tierBlocks = blocks.filter((block) => String(block.question?.difficulty ?? 'easy') === difficulty);
    return { difficulty, total: tierBlocks.length, done: tierBlocks.filter((block) => quizAnswers.has(block.id)).length };
  }) : [];

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

  const assessBlock = useCallback(async (blockId: string, value: number) => {
    if (!resource) return;
    try {
      const result = await api.updateLearningResourceProgress(resource.id, {
        currentBlockId: currentBlockId || blockId, visitedBlockIds: unique([...visited, blockId]),
        completedStepIds: completedSteps, elapsedSeconds: elapsedBase + sessionSecondsRef.current,
        selfAssessments: { [blockId]: value },
      });
      setResource(result.resource);
      setVisited((current) => unique([...current, blockId]));
      toast.success(value === 1 ? '已记录：完全掌握' : '掌握程度已更新');
    } catch { toast.error('掌握程度保存失败'); }
  }, [resource, currentBlockId, visited, completedSteps, elapsedBase]);

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
    narration.stop();
    setFocusMode(false);
  }, [narration.stop, setFocusMode]);

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
    if (!safetyReady && id === blocks.find((block) => block.kind === 'practice')?.id) {
      toast.warning('请先完成开始前确认', { description: '全部确认后，才可以打卡第一个实操步骤。' });
      return;
    }
    const next = completedSteps.includes(id) ? completedSteps.filter((item) => item !== id) : [...completedSteps, id];
    setCompletedSteps(next);
    setVisited((current) => {
      const nextVisited = unique([...current, id]);
      saveProgress(id, nextVisited, next, elapsedBase + sessionSecondsRef.current);
      return nextVisited;
    });
  };

  const speakCurrent = () => {
    if (narration.speaking) { narration.stop(); return; }
    const block = blocks[currentIndex];
    if (!block) return;
    void narration.play(narrationText(block), speechSpeed);
  };

  const cycleSpeed = () => {
    const index = speedOrder.indexOf(speechSpeed);
    const next = speedOrder[(index + 1) % speedOrder.length];
    setSpeechSpeed(next);
    if (narration.speaking) narration.stop();
  };

  const toggleFocus = () => {
    const next = !focusMode;
    setFocusMode(next);
    narration.stop();
    if (!next) ambient.setKind('off');
  };

  const cycleAmbient = () => {
    ambient.setKind(ambient.kind === 'off' ? 'rain' : ambient.kind === 'rain' ? 'forest' : 'off');
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

  const unassessedCount = resource && resource.type !== 'quiz'
    ? blocks.filter((block) => block.kind !== 'quiz' && assessmentsOf(resource)[block.id] == null).length
    : 0;

  const markComplete = () => {
    if (!resource || completing) return;
    if (unassessedCount > 0) {
      setCompleteConfirmOpen(true);
      return;
    }
    finishComplete({});
  };

  /** 确认完成：未选掌握程度的段落默认标记为「基本理解」（25% 掌握分） */
  const confirmComplete = () => {
    if (!resource) return;
    const extra: Record<string, number> = {};
    blocks.forEach((block) => {
      if (block.kind !== 'quiz' && assessmentsOf(resource)[block.id] == null) extra[block.id] = 0.25;
    });
    finishComplete(extra);
  };

  const finishComplete = (extraAssessments: Record<string, number>) => {
    if (!resource || completing) return;
    setCompleting(true);
    setCompleteConfirmOpen(false);
    toast.success('已标记完成，正在后台同步学习记录');
    navigate('/learn');
    /* 后台隐式同步：不阻塞跳转；组件卸载后不再 setState */
    void (async () => {
      try {
        await api.completeLearningResource(resource.id).catch(() => null);
        window.localStorage.removeItem(`${RESOURCE_CACHE_PREFIX}${resource.id}`);
        if (isUuid(resource.learnerId) && resource.type !== 'quiz') {
          const eventType = resource.type === 'practice' ? 'guide-complete' : 'lecture-read';
          const amount = resource.type === 'practice' ? 20 : 15;
          await api.recordLearnerGrowthEvent({
            learnerId: resource.learnerId!, eventType, title: `完成《${resource.title}》`, amount,
            metadata: { resourceId: resource.id, kpId: resource.kpId, resourceType: resource.type },
          }).catch(() => undefined);
        }
        await api.updateLearningResourceProgress(resource.id, {
          currentBlockId, visitedBlockIds: blocks.map((block) => block.id),
          completedStepIds: completedSteps, elapsedSeconds: elapsedBase + sessionSecondsRef.current,
          selfAssessments: { ...assessmentsOf(resource), ...extraAssessments },
        }).catch(() => undefined);
        void api.recordLearningEvent({ eventType: 'STUDY_END', sourceType: 'RESOURCE', sourceId: resource.id, durationSeconds: elapsedBase + sessionSecondsRef.current, metadata: JSON.stringify({ courseId: resource.courseId, chapterId: resource.chapterId, resourceType: resource.type, completed: true }) }).catch(() => undefined);
        const mapLearnerId = isUuid(resource.learnerId) ? resource.learnerId! : currentLearnerId;
        if (isUuid(mapLearnerId)) await refreshLearningMapResourceCache(mapLearnerId).catch(() => undefined);
      } catch { /* 后台失败静默，避免打扰已跳转用户 */ }
    })();
  };

  if (loading) return <div className="mx-auto flex min-h-[62vh] max-w-[980px] items-center justify-center gap-2 px-5 text-[13px] text-ink-muted"><Loader2 size={17} className="animate-spin" />正在恢复你的学习现场…</div>;
  if (error || !resource) return <div className="mx-auto max-w-[760px] px-5 py-20 text-center"><h1 className="font-serif text-[24px] font-semibold text-ink">这项学习资源暂时打不开</h1><p className="mt-2 text-[13px] text-brand-danger">{error || '资源不存在'}</p><Link to="/learn" className="lf-btn-primary mt-5 inline-flex">返回我的课程</Link></div>;

  const activeBlock = blocks[currentIndex];
  const sortedResources = [...chapterResources].sort((a, b) => ({ lecture: 0, practice: 1, quiz: 2 }[a.type] - ({ lecture: 0, practice: 1, quiz: 2 }[b.type])));
  const resourceIndex = sortedResources.findIndex((item) => item.id === resource.id);
  const nextResource = resourceIndex >= 0 ? sortedResources[resourceIndex + 1] : undefined;

  return <div className={cn('mx-auto max-w-[1260px] px-4 pb-40 pt-6 md:px-6', focusMode && 'max-w-[1040px]', (noteFor || chatOpen) && 'relative z-50')}>
    {!focusMode && <div className="mb-5 flex flex-wrap items-center gap-2 text-[12px] text-ink-muted"><button type="button" onClick={() => { try { window.sessionStorage.setItem(`lf.knowledgeGraph3dReturn:v1:${currentLearnerId}`, 'breadcrumb'); } catch { /* ignore */ } navigate('/learn'); }} className="inline-flex items-center gap-1 hover:text-brand"><ArrowLeft size={13} />我的课程</button><ChevronRight size={12} />{resource.courseId && resource.chapterId ? <Link to={`/resources?courseId=${encodeURIComponent(resource.courseId)}&chapterId=${encodeURIComponent(resource.chapterId)}`} className="hover:text-brand">{chapter?.title ?? '章节资源'}</Link> : <span className="max-w-[260px] truncate text-ink-2">{resource.topic || '学习资源'}</span>}{resource.courseId && resource.chapterId ? <><ChevronRight size={12} /><span className="truncate text-ink-2">{resourceMeta[resource.type].label}</span></> : null}</div>}

    <header className="relative overflow-hidden rounded-[20px] border border-brand/20 bg-gradient-to-br from-brand-tint/70 via-card-warm to-paper p-6 md:p-8">
      <div className="absolute -right-14 -top-16 h-44 w-44 rounded-full bg-brand/5 blur-2xl" />
      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-[800px]"><div className="lf-mono-label flex items-center gap-2"><BookOpen size={13} />{course?.title ?? '真实课程'} · {chapter ? `第 ${chapter.index} 章` : resourceMeta[resource.type].label}</div><h1 className="mt-2 font-serif text-[29px] font-semibold leading-tight text-ink md:text-[35px]">{resource.title}</h1><p className="mt-3 max-w-[720px] text-[13.5px] leading-6 text-ink-muted">{chapter?.summary || resource.topic}</p></div>
        <div className="min-w-[220px] rounded-[14px] border border-white/60 bg-paper/70 p-4 backdrop-blur"><div className="flex items-center justify-between text-[11px] text-ink-muted"><span>本资源学习进度</span><span className="font-mono text-brand">{displayedCompletionPercent}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-paper-deep"><motion.div className="h-full rounded-full bg-brand" animate={{ width: `${displayedCompletionPercent}%` }} /></div><div className="mt-3 flex items-center justify-between font-mono text-[10.5px] text-ink-muted"><span><Clock3 size={11} className="mr-1 inline" />{formatDuration(elapsedBase + sessionSeconds)}</span><span>{displayedCompletedCount}/{blocks.length} {resource.type === 'quiz' ? '题' : '段'}</span></div></div>
      </div>
    </header>

    {!focusMode && sortedResources.length > 1 && <nav className="mt-4 flex gap-2 overflow-x-auto pb-1">{sortedResources.map((item) => { const Meta = resourceMeta[item.type]; return <Link key={item.id} to={`/learn/resource/${item.id}`} className={cn('flex shrink-0 items-center gap-2 rounded-[11px] border px-3.5 py-2 text-[12.5px] transition', item.id === resource.id ? 'border-brand bg-brand text-paper' : 'border-hairline bg-card-warm text-ink-2 hover:border-brand/40')}><Meta.Icon size={13} />{Meta.label}{item.learned && <Check size={12} />}</Link>; })}</nav>}


    <div className="mt-7 grid gap-7 lg:grid-cols-[250px_minmax(0,1fr)]">
      {!focusMode && <aside className="min-w-0 self-start lg:sticky lg:top-[76px]"><div className="rounded-[16px] border border-hairline bg-card-warm p-3"><div className="px-2 pb-2"><div className="lf-mono-label">LEARNING PATH</div><div className="mt-1 text-[13px] font-semibold text-ink">本讲目录</div></div><div className="flex gap-1 overflow-x-auto pb-1 lg:block lg:max-h-[58vh] lg:space-y-1 lg:overflow-y-auto lg:pb-0">{blocks.map((block, index) => { const quizResult = resource.type === 'quiz' ? quizAnswers.get(block.id) : undefined; const done = resource.type === 'quiz' ? quizAnswers.has(block.id) : visited.includes(block.id) || resource.learned; const wrong = resource.type === 'quiz' && done && quizResult === false; return <button key={block.id} type="button" onClick={() => goBlock(block.id)} className={cn('flex w-[210px] shrink-0 items-start gap-2.5 rounded-[10px] px-2.5 py-2.5 text-left transition lg:w-full', block.id === currentBlockId ? 'bg-brand-tint text-brand' : 'text-ink-2 hover:bg-paper-deep')}><span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[9px]', wrong ? 'border-brand-danger bg-brand-danger text-paper' : done ? 'border-brand bg-brand text-paper' : 'border-hairline bg-paper text-ink-muted')}>{wrong ? <X size={10} /> : done ? <Check size={10} /> : index + 1}</span><span className="min-w-0"><span className="block text-[10px] opacity-65">{block.eyebrow}</span><span className="mt-0.5 block text-[12px] font-medium leading-[17px]">{block.title}</span></span></button>; })}</div></div>{progressOf(resource).lastOpenedAt && <p className="mt-3 hidden px-2 text-[10.5px] leading-5 text-ink-muted lg:block">已从后端恢复上次断点：{new Date(progressOf(resource).lastOpenedAt!).toLocaleString()}</p>}</aside>}

      <main className="min-w-0 space-y-6">
      {resource.type === 'practice' && <section className="rounded-[18px] border border-brand-amber/40 bg-brand-amber-tint p-5"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="flex items-center gap-2 text-[15px] font-semibold text-ochre"><ShieldAlert size={16} />开始前确认</h2><p className="mt-1 text-[11.5px] text-ochre/80">逐项确认后再开始操作；确认结果只用于本次学习进度。</p></div><span className="font-mono text-[11px] text-ochre">{safetyChecks.length}/{safetyChecklist.length} 已确认</span></div>{safetyChecklist.length ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{safetyChecklist.map((item) => { const checked = safetyChecks.includes(item); return <button key={item} type="button" onClick={() => setSafetyChecks((current) => checked ? current.filter((value) => value !== item) : [...current, item])} className={cn('flex items-center gap-2 rounded-[10px] border bg-card-warm px-3 py-2.5 text-left text-[12.5px]', checked ? 'border-brand/45 text-brand' : 'border-hairline text-ink-2')} >{checked ? <ShieldCheck size={15} /> : <Circle size={15} className="text-ink-muted" />}<span>{item}</span></button>; })}</div> : <p className="mt-3 text-[12.5px] text-ink-muted">本任务未识别到额外的确认项，请按步骤谨慎操作即可。</p>}{String(resource.content.safetyNotice ?? '') && <div className="mt-3 flex items-start gap-2 rounded-[10px] border border-brand-danger/25 bg-brand-danger/5 px-3 py-2.5 text-[12px] leading-5 text-ink-2"><TriangleAlert size={15} className="mt-0.5 shrink-0 text-brand-danger" />{String(resource.content.safetyNotice)}</div>}</section>}
      {resource.type === 'practice' && <section className="grid gap-3 sm:grid-cols-3"><div className="lf-card p-4"><Clock3 size={15} className="text-brand" /><div className="mt-2 text-[18px] font-semibold text-ink">{Number(resource.content.estimatedMinutes) || blocks.length * 10} 分钟</div><div className="text-[10.5px] text-ink-muted">预计完成时间</div></div><div className="lf-card p-4 sm:col-span-2"><div className="flex items-center gap-2 text-[12px] font-semibold text-ink"><Wrench size={14} className="text-brand" />环境与工具</div><div className="mt-2 flex flex-wrap gap-1.5">{asStrings(resource.content.environment).map((item) => <span key={item} className="rounded-md border border-hairline bg-paper px-2 py-1 text-[10.5px] text-ink-2">{item}</span>)}</div></div></section>}
      {resource.type === 'quiz' && <section className="grid gap-3 sm:grid-cols-3">{quizTiers.map((tier) => { const meta = difficultyMeta[tier.difficulty]; return <div key={tier.difficulty} className="lf-card p-4"><div className="flex items-center justify-between"><span className="text-[14px] font-semibold text-ink">{meta.label}</span><DifficultyStars count={meta.stars} color={meta.color} /></div><div className="mt-2 flex items-center justify-between font-mono text-[11px] text-ink-muted"><span>{tier.total} 题</span><span>{tier.done}/{tier.total} 已答</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-paper-deep"><div className="h-full rounded-full" style={{ width: `${tier.total ? tier.done / tier.total * 100 : 0}%`, backgroundColor: meta.color }} /></div></div>; })}</section>}
      {blocks.length === 0 ? <div className="rounded-[16px] border border-dashed border-hairline p-12 text-center"><p className="text-[14px] text-ink-muted">当前资源没有可学习的正文。</p><Link to={`/resources?courseId=${resource.courseId}&chapterId=${resource.chapterId}`} className="lf-btn-primary mt-4 inline-flex">重新生成资源</Link></div> : blocks.map((block, index) => <motion.section key={block.id} ref={(element) => { blockRefs.current[block.id] = element; }} data-block-id={block.id} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-80px' }} className={cn('scroll-mt-28 rounded-[18px] border bg-card-warm p-5 shadow-xs transition md:p-7', block.id === currentBlockId ? 'border-brand/35 shadow-warm' : 'border-hairline', block.safety === 'danger' && 'border-l-2 border-l-brand-danger/60')}>
        <div className="flex items-start gap-4"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-brand-tint font-mono text-[11px] font-semibold text-brand">{block.kind === 'practice' ? `S${index}` : String(index + 1).padStart(2, '0')}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><div className="lf-mono-label !text-[10px]">{block.eyebrow}</div>{block.kind === 'practice' && block.safety && <span className={cn('rounded-md border px-1.5 py-0.5 font-mono text-[9.5px]', block.safety === 'danger' ? 'border-brand-danger/35 bg-brand-danger/10 text-brand-danger' : block.safety === 'caution' ? 'border-brand-amber/40 bg-brand-amber-tint text-ochre' : 'border-brand/25 bg-brand-tint text-brand')}>{block.safety === 'danger' ? '高风险' : block.safety === 'caution' ? '需谨慎' : '常规操作'}</span>}{block.kind === 'quiz' && (() => { const meta = difficultyMeta[String(block.question?.difficulty ?? 'easy') as keyof typeof difficultyMeta] ?? difficultyMeta.easy; return <span className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[9.5px]" style={{ borderColor: `${meta.color}55`, color: meta.color }}><DifficultyStars count={meta.stars} color={meta.color} />{meta.label}</span>; })()}</div><h2 className="mt-1 font-serif text-[22px] font-semibold leading-tight text-ink md:text-[25px]">{block.title}</h2></div>{block.kind === 'practice' && <button type="button" onClick={() => toggleStep(block.id)} className={cn('flex shrink-0 items-center gap-1.5 rounded-[10px] border px-3 py-2 text-[11.5px]', completedSteps.includes(block.id) ? 'border-brand bg-brand text-paper' : !safetyReady && block.id === blocks.find((item) => item.kind === 'practice')?.id ? 'cursor-not-allowed border-hairline bg-paper-deep text-ink-muted' : 'border-hairline bg-paper text-ink-muted hover:border-brand/40')} >{completedSteps.includes(block.id) ? <CheckCircle2 size={14} /> : <Circle size={14} />}完成步骤</button>}</div>
        {block.body && <div className="mt-5 max-w-[760px]"><ReactMarkdown remarkPlugins={[remarkGfm, remarkCitationMarks]} components={lectureMdComponents}>{block.body}</ReactMarkdown></div>}
        {block.code && <pre className="mt-5 overflow-x-auto rounded-[12px] bg-ink px-4 py-4 text-[12px] leading-6 text-paper"><code>{block.code}</code></pre>}
        {block.expectedOutput && <div className="mt-4 rounded-[12px] border border-brand/20 bg-brand-tint/35 px-4 py-3 text-[13px] leading-6 text-ink-2"><strong className="text-brand">预期结果：</strong>{block.expectedOutput}</div>}
        {block.warning && <div className="mt-4 flex items-start gap-2 rounded-[12px] border border-brand-amber/40 bg-brand-amber-tint px-4 py-3 text-[12.5px] leading-5 text-ochre"><TriangleAlert size={15} className="mt-0.5 shrink-0" /><span><strong>操作提醒：</strong>{block.warning}</span></div>}
        {block.kind === 'quiz' && <QuizBlock block={block} resource={resource} onWritebackStatus={setWritebackStatus} onResourceState={(state) => setResource((current) => current ? { ...current, state, learned: Boolean(state.learned || state.completed) } : current)} />}
        <InlineBlockCitations block={block} resource={resource} />
        {resource.type !== 'quiz' && <div className="mt-5 rounded-[12px] border border-brand/20 bg-brand-tint/25 p-3.5"><div className="flex flex-wrap items-center justify-between gap-2"><div><div className="text-[12px] font-semibold text-ink">这一块你掌握得怎么样？</div><div className="mt-0.5 text-[10.5px] text-ink-muted">自评会和答题正确率一起计算掌握程度，可随时修改。</div></div><div className="flex flex-wrap gap-1.5">{([{ label: '还需学习', value: 0.2 }, { label: '基本理解', value: 0.55 }, { label: '大体掌握', value: 0.8 }, { label: '我已经完全掌握', value: 1 }] as const).map((option) => { const selected = assessmentsOf(resource)[block.id] === option.value; return <button key={option.value} type="button" onClick={() => void assessBlock(block.id, option.value)} className={cn('rounded-full border px-3 py-1.5 text-[11px] transition', selected ? 'border-brand bg-brand text-paper' : 'border-hairline bg-paper text-ink-2 hover:border-brand/45')}>{selected && <Check size={11} className="mr-1 inline" />}{option.label}</button>; })}</div></div></div>}
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-hairline/70 pt-4"><button type="button" onClick={() => { setNoteFor(block); setNoteText(''); }} className="lf-btn-ghost !px-3 !py-1.5 text-[11.5px]"><NotebookPen size={13} />记这一段</button><button type="button" onClick={() => { setCurrentBlockId(block.id); void openChat(); }} className="lf-btn-ghost !px-3 !py-1.5 text-[11.5px]"><MessageCircleQuestion size={13} />向导学老师提问</button>{index < blocks.length - 1 && <button type="button" onClick={() => goBlock(blocks[index + 1].id)} className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-brand hover:underline">下一段<ArrowRight size={12} /></button>}</div>
      </motion.section>)}</main>
    </div>

    {traces.length > 0 && !focusMode && <section className="mt-8 rounded-[18px] border border-hairline bg-card-warm p-5 md:p-7"><div className="flex items-center gap-2"><Sparkles size={16} className="text-brand" /><h2 className="font-serif text-[20px] font-semibold text-ink">真实来源与生成依据</h2></div><p className="mt-1 text-[12px] text-ink-muted">以下来源由知识库检索或 Web Search 提供，并与正文引用位置关联。</p><div className="mt-4 grid gap-3 md:grid-cols-2">{traces.map((trace, traceIndex) => <article key={`${String(trace.id ?? 'source')}-${trace.title}-${traceIndex}`} className="rounded-[12px] border border-hairline bg-paper p-4"><div className="flex items-start gap-3"><span className="rounded-md bg-brand-tint px-2 py-1 font-mono text-[10px] text-brand">{trace.credibility}%</span><div className="min-w-0"><h3 className="text-[13px] font-semibold text-ink">{trace.title}</h3><p className="mt-1 line-clamp-3 text-[11.5px] leading-5 text-ink-muted">{trace.excerpt}</p></div></div>{trace.positions.length > 0 && <div className="mt-3 flex flex-wrap gap-1">{trace.positions.slice(0, 5).map((position, positionIndex) => <span key={`${position}-${positionIndex}`} className="rounded bg-paper-deep px-1.5 py-1 text-[9.5px] text-ink-muted">{position}</span>)}</div>}{trace.url && <a href={trace.url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-[11px] text-brand hover:underline">查看来源<ExternalLink size={10} /></a>}</article>)}</div></section>}

    <footer className="mt-8 flex flex-col items-center justify-between gap-4 rounded-[18px] border border-brand/20 bg-brand-tint/30 p-5 sm:flex-row"><div><div className="text-[13px] font-semibold text-ink">{resource.learned ? '本项资源已经学完' : resource.type === 'quiz' && !quizAllAnswered ? '完成全部答题后即可结束测试' : '完成本项学习后，进度会写入画像与报告'}</div><p className="mt-1 text-[11.5px] text-ink-muted">{resource.type === 'quiz' ? '作答' : '阅读'} {displayedCompletedCount}/{blocks.length} {resource.type === 'quiz' ? '题' : '段'} · 学习 {formatDuration(elapsedBase + sessionSeconds)}</p></div><div className="flex gap-2">{nextResource && <Link to={`/learn/resource/${nextResource.id}`} className="lf-btn-ghost">下一项：{resourceMeta[nextResource.type].label}<ArrowRight size={14} /></Link>}<button type="button" disabled={resource.learned || completing || !quizAllAnswered} onClick={() => void markComplete()} className="lf-btn-primary">{completing ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}{resource.learned ? '已完成' : resource.type === 'quiz' && !quizAllAnswered ? '请先完成全部题目' : '完成本项学习'}</button></div></footer>

    <div className="fixed inset-x-0 bottom-[58px] z-40 mx-auto flex w-[min(920px,calc(100%-24px))] items-center gap-1.5 rounded-[17px] border border-hairline bg-paper/95 p-2.5 shadow-warm-lg backdrop-blur-md md:bottom-4 md:gap-2">
      <button type="button" onClick={speakCurrent} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-paper" title="播放这一段">{narration.speaking ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
      <div className="hidden min-w-0 flex-1 sm:block"><div className="truncate text-[12.5px] font-medium text-ink">{activeBlock?.title ?? resource.title}</div><div className="mt-0.5 flex items-center gap-2 font-mono text-[9.5px] text-ink-muted"><span><Headphones size={10} className="mr-1 inline" />{narration.speaking ? '正在讲播' : '点击播放当前段落'}</span><span>{currentIndex + 1}/{blocks.length}</span></div></div>
      <button type="button" onClick={cycleSpeed} className="flex h-9 shrink-0 items-center gap-1 rounded-[10px] border border-hairline px-2.5 text-[10.5px] text-ink-muted" title="切换语速"><Gauge size={13} /><span>{speedMeta[speechSpeed].label}</span></button>
      <button type="button" onClick={() => setSlideMode(true)} className="flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] border border-hairline px-2.5 text-[11px] text-ink-muted" title="幻灯模式：一段一页"><Presentation size={13} /><span className="hidden md:inline">幻灯</span></button>
      <button type="button" onClick={toggleFocus} aria-label={focusMode ? '退出专注' : '进入专注'} className={cn('flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] border px-2.5 text-[11px]', focusMode ? 'border-brand bg-brand-tint text-brand' : 'border-hairline text-ink-muted')}><Focus size={13} /><span className="hidden md:inline">{focusMode ? '退出专注' : '专注'}</span></button>
      {focusMode && ambient.supported && <button type="button" onClick={cycleAmbient} className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border', ambient.kind === 'off' ? 'border-hairline text-ink-muted' : 'border-brand bg-brand-tint text-brand')} title={ambient.kind === 'off' ? '开启细雨环境音' : ambient.kind === 'rain' ? '切换林间环境音' : '关闭环境音'}>{ambient.kind === 'forest' ? <Trees size={13} /> : <CloudRain size={13} />}</button>}
      <button type="button" onClick={() => void openChat()} aria-label="向章节导学老师提问" className="flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] border border-hairline px-2.5 text-[11px] text-ink-muted"><Bot size={13} /><span className="hidden lg:inline">提问</span></button>
      <button type="button" onClick={() => activeBlock && setNoteFor(activeBlock)} aria-label="记录当前段落笔记" className="flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] border border-hairline px-2.5 text-[11px] text-ink-muted"><NotebookPen size={13} /><span className="hidden lg:inline">笔记</span></button>
    </div>

    <AnimatePresence>{writebackStatus !== 'idle' && <motion.div initial={{ opacity: 0, y: -8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.96 }} className={cn('fixed right-4 top-4 z-[110] flex items-center gap-2 rounded-full border px-3.5 py-2 text-[11.5px] shadow-warm backdrop-blur-md', writebackStatus === 'failed' ? 'border-brand-danger/30 bg-paper/95 text-brand-danger' : 'border-brand/25 bg-paper/95 text-brand')}>
      {writebackStatus === 'syncing' ? <Loader2 size={13} className="animate-spin" /> : writebackStatus === 'synced' ? <Check size={13} /> : <X size={13} />}
      <span>{writebackStatus === 'syncing' ? '正在同步学习记录' : writebackStatus === 'synced' ? '学习记录已同步' : '学习记录同步失败'}</span>
      {writebackStatus !== 'syncing' && <button type="button" aria-label="关闭同步提示" onClick={() => setWritebackStatus('idle')} className="ml-0.5 opacity-60 hover:opacity-100"><X size={11} /></button>}
    </motion.div>}</AnimatePresence>

    {createPortal(<AnimatePresence>{slideMode && activeBlock && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[9999] flex flex-col bg-paper">
      <header className="flex items-center gap-3 border-b border-hairline bg-card-warm px-4 py-3 md:px-6"><Presentation size={17} className="text-brand" /><div className="min-w-0 flex-1"><div className="truncate text-[13px] font-semibold text-ink">幻灯模式 · {resource.title}</div><div className="font-mono text-[9.5px] text-ink-muted">真实课程内容 · 第 {currentIndex + 1}/{blocks.length} 段</div></div><button type="button" onClick={() => setSlideMode(false)} className="rounded-lg p-2 text-ink-muted hover:bg-paper-deep" title="退出幻灯"><X size={17} /></button></header>
      <main className="flex flex-1 items-center justify-center overflow-y-auto bg-gradient-to-br from-brand-tint/25 via-paper to-card-warm px-4 py-8 md:px-12"><motion.article key={activeBlock.id} initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} className="relative w-full max-w-[1040px] overflow-hidden rounded-[24px] border border-brand/20 bg-card-warm/95 p-6 shadow-warm-lg md:p-8 lg:p-10"><div className="absolute right-0 top-0 h-32 w-32 rounded-bl-full bg-brand/5" /><div className="relative mx-auto max-w-[800px]"><div className="inline-flex rounded-full border border-brand/20 bg-brand-tint px-3 py-1 font-mono text-[10px] tracking-[0.12em] text-brand">{activeBlock.eyebrow}</div><h2 className="mt-4 max-w-[780px] font-serif text-[27px] font-semibold leading-tight tracking-[-0.015em] text-ink md:text-[34px]">{activeBlock.title}</h2><div className="mt-5 h-1 w-14 rounded-full bg-brand" />{activeBlock.body && <div className="mt-7"><ReactMarkdown remarkPlugins={[remarkGfm, remarkCitationMarks]} components={slideMdComponents}>{activeBlock.body}</ReactMarkdown></div>}<InlineBlockCitations block={activeBlock} resource={resource} />{activeBlock.code && <pre className="mt-6 max-h-[42vh] overflow-auto rounded-[14px] bg-ink p-5 text-[14px] leading-6 text-paper md:text-[16px]"><code>{activeBlock.code}</code></pre>}{activeBlock.expectedOutput && <div className="mt-5 rounded-[14px] border border-brand/25 bg-brand-tint/55 p-4 text-[15px] leading-7 text-ink-2 md:text-[17px]"><strong className="text-brand">预期结果</strong><span className="mx-2 text-brand/40">/</span>{activeBlock.expectedOutput}</div>}{activeBlock.kind === 'quiz' && <QuizBlock block={activeBlock} resource={resource} onWritebackStatus={setWritebackStatus} onResourceState={(state) => setResource((current) => current ? { ...current, state, learned: Boolean(state.learned || state.completed) } : current)} />}</div></motion.article></main>
      <footer className="flex items-center justify-center gap-3 border-t border-hairline bg-card-warm px-4 py-3"><button type="button" disabled={currentIndex === 0} onClick={() => goBlock(blocks[currentIndex - 1].id)} className="flex h-10 w-10 items-center justify-center rounded-full border border-hairline text-ink-muted disabled:opacity-30" title="上一页"><ChevronLeft size={17} /></button><button type="button" onClick={speakCurrent} className="flex h-11 items-center gap-2 rounded-full bg-brand px-5 text-[12.5px] font-medium text-paper">{narration.speaking ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}{narration.speaking ? '暂停讲播' : '讲这一页'}</button><button type="button" onClick={cycleSpeed} className="h-10 rounded-full border border-hairline px-4 font-mono text-[11px] text-ink-muted">{speedMeta[speechSpeed].label}</button><button type="button" disabled={currentIndex >= blocks.length - 1} onClick={() => goBlock(blocks[currentIndex + 1].id)} className="flex h-10 w-10 items-center justify-center rounded-full border border-hairline text-ink-muted disabled:opacity-30" title="下一页"><ChevronRight size={17} /></button></footer>
    </motion.div>}</AnimatePresence>, document.body)}

    <AnimatePresence>{noteFor && <><motion.button type="button" aria-label="关闭笔记面板背景" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setNoteFor(null)} className="fixed inset-0 z-[70] bg-ink/20 backdrop-blur-[2px]" /><motion.aside initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} className="fixed inset-y-0 right-0 z-[80] flex w-full max-w-[460px] flex-col border-l border-hairline bg-paper shadow-2xl"><div className="flex items-start gap-3 border-b border-hairline p-5"><NotebookPen size={18} className="mt-1 text-brand" /><div className="min-w-0 flex-1"><div className="lf-mono-label">PERSONAL NOTE</div><h2 className="mt-1 truncate font-serif text-[20px] font-semibold text-ink">{noteFor.title}</h2></div><button type="button" aria-label="关闭笔记" onClick={() => setNoteFor(null)} className="rounded-lg p-2 text-ink-muted hover:bg-paper-deep"><X size={16} /></button></div><div className="flex-1 p-5"><p className="text-[12px] leading-5 text-ink-muted">笔记会关联当前课程、资源段落和引用来源，保存到“我的笔记”。</p><textarea autoFocus value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder="写下你的理解、疑问或总结…" className="mt-4 min-h-[260px] w-full resize-none rounded-[13px] border border-hairline bg-card-warm p-4 text-[13.5px] leading-6 text-ink outline-none focus:border-brand/45" /></div><div className="border-t border-hairline p-4"><button type="button" disabled={!noteText.trim() || savingNote} onClick={() => void saveNote()} className="lf-btn-primary w-full justify-center">{savingNote && <Loader2 size={14} className="animate-spin" />}保存到个人知识库</button></div></motion.aside></>}</AnimatePresence>

    <AnimatePresence>{chatOpen && <><motion.button type="button" aria-label="关闭提问面板背景" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setChatOpen(false)} className="fixed inset-0 z-[70] bg-ink/20 backdrop-blur-[2px]" /><motion.aside initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} className="fixed inset-y-0 right-0 z-[80] flex w-full max-w-[500px] flex-col border-l border-hairline bg-paper shadow-2xl"><div className="flex items-center gap-3 border-b border-hairline bg-card-warm p-4"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-paper"><Bot size={17} /></span><div className="min-w-0 flex-1"><h2 className="text-[14px] font-semibold text-ink">章节导学老师</h2><p className="truncate text-[10.5px] text-ink-muted">正在结合本资源正文、作答状态和真实来源回答</p></div><button type="button" aria-label="关闭提问" onClick={() => setChatOpen(false)} className="rounded-lg p-2 text-ink-muted hover:bg-paper-deep"><X size={16} /></button></div><div className="flex-1 space-y-3 overflow-y-auto p-4">{messages.length === 0 && <div className="rounded-[13px] border border-brand/20 bg-brand-tint/35 p-4 text-[12.5px] leading-6 text-ink-2">我已经读过这项资源和它引用的知识库、网页来源。你可以让我解释当前段落、检查理解，或根据作答记录生成巩固建议。</div>}{messages.map((message, index) => <div key={`${message.createdAt}-${index}`} className={cn('w-fit max-w-[90%] rounded-[13px] px-3.5 py-2.5 text-[12.5px] leading-6', message.role === 'user' ? 'ml-auto rounded-br-sm bg-brand text-paper' : 'rounded-tl-sm border border-hairline bg-card-warm text-ink-2')}><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>)}{asking && <div className="flex items-center gap-2 text-[11.5px] text-ink-muted"><Loader2 size={13} className="animate-spin" />正在结合内容与来源思考…</div>}{followUps.length > 0 && <div className="flex flex-wrap gap-1.5">{followUps.map((item) => <button key={item} type="button" onClick={() => void ask(item)} className="rounded-lg border border-hairline bg-card-warm px-2.5 py-1.5 text-left text-[10.5px] text-brand hover:border-brand/40">{item}</button>)}</div>}</div><div className="border-t border-hairline bg-card-warm p-3"><div className="flex items-end gap-2"><textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask(); } }} placeholder="问当前内容，Enter 发送…" className="max-h-28 min-h-10 flex-1 resize-none rounded-[11px] border border-hairline bg-paper px-3 py-2.5 text-[12.5px] outline-none focus:border-brand/45" /><button type="button" disabled={!question.trim() || asking} onClick={() => void ask()} className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-brand text-paper disabled:opacity-40"><Send size={15} /></button></div></div></motion.aside></>}</AnimatePresence>
  {completeConfirmOpen && (
      <div className="fixed inset-0 z-[110] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm" onClick={() => setCompleteConfirmOpen(false)} role="dialog" aria-modal="true" aria-label="完成确认">
        <div className="w-full max-w-[420px] rounded-[18px] border border-brand/30 bg-card-warm p-6 shadow-warm-lg" onClick={(event) => event.stopPropagation()}>
          <h3 className="font-serif text-[18px] font-semibold text-ink">还有 {unassessedCount} 段没选掌握程度</h3>
          <p className="mt-1.5 text-[12.5px] leading-5 text-ink-muted">未选择的段落将默认标记为「基本理解」（25% 掌握分），与你的选择一起计入掌握程度。确认后立即返回知识地图。</p>
          <div className="mt-5 flex gap-2">
            <button type="button" onClick={() => setCompleteConfirmOpen(false)} className="lf-btn-ghost flex-1 justify-center">再想想</button>
            <button type="button" onClick={confirmComplete} className="lf-btn-primary flex-1 justify-center">确认完成并返回地图</button>
          </div>
        </div>
      </div>
    )}
  </div>;
}
