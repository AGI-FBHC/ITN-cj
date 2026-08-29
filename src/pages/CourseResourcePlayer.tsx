import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCitationMarks from '@/lib/remarkCitationMarks';
import { fullLearningResourcePath, markLearningMapReturn } from '@/lib/learningNavigation';
import {
  ArrowLeft, ArrowRight, BookOpen, Bot, Camera, Check, CheckCircle2, ChevronLeft,
  ChevronRight, Circle, Clock3, ExternalLink, FileText,
  Gauge, Headphones, ImagePlus, ListChecks, Loader2, MessageCircleQuestion, Mic, NotebookPen,
  Pause, PenLine, Play, Plus, Presentation, RotateCcw, Send, ShieldAlert, ShieldCheck, Sparkles,
  Star, Trash2, TriangleAlert, Volume1, Volume2, VolumeX, Wrench, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, streamAssistantTts } from '@/lib/api';
import { audioBus } from '@/lib/audioBus';
import type {
  Course, CourseChapter, LearningResource, LearningResourceMessage,
  LearningResourceProgress, LearningResourceSummary, LearningResourceTrace, TtsSpeed,
} from '@/lib/api';
import { useNotes } from '@/context/NotesContext';
import { createPresentationChatSession, deletePresentationChatSession, fetchChatAttachmentBlob, getPresentationChatMessages, listPresentationChatSessions, presentationApi, streamPresentationChatImage, streamPresentationChatText } from '@/lib/presentationApi';
import type { PresentationChatSession } from '@/lib/presentationApi';
import { cn } from '@/lib/utils';
import { lectureMdComponents, slideMdComponents } from '@/components/resources/lecture-markdown';
import SourceCitationMarks from '@/components/resources/SourceCitationMarks';
import { refreshLearningMapResourceCache } from '@/hooks/useLearningMap';
import { useProfile } from '@/context/ProfileContext';

/** 智能助教聊天消息：在基础文本之上携带多模态类型与附件信息 */
interface ChatMessage extends LearningResourceMessage {
  inputType?: 'text' | 'voice' | 'image';
  attachmentId?: string | null;
  photoUrl?: string;
}

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
const VOLUME_LEVELS = [1, 0.6, 0.3, 0] as const;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const asRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.map(String).filter(Boolean) : [];
const asNumbers = (value: unknown): number[] => Array.isArray(value) ? [...new Set(value.map(Number).filter(Number.isFinite))] : [];
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const isUuid = (value?: string | null) => Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));

/** 学习状态变化广播：答题/重置/完成后通知全局缓存失效（analytics、今日日记），保证返回地图/成长页即新鲜 */
function notifyLearningStateChanged(learnerId: string | null | undefined): void {
  if (!learnerId || !isUuid(learnerId)) return;
  try {
    window.dispatchEvent(new CustomEvent('lf:learning-state-changed', { detail: { learnerId } }));
  } catch {
    /* ignore */
  }
}

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

/* ---------- 语音识别（webkit 前缀非标准 API） ---------- */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRecognizer(): (new () => any) | null {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function narrationText(block: LearningBlock): string {
  return `${block.title}。${block.body ?? ''}`
    .replace(/```[\s\S]*?```/g, ' 代码示例请看屏幕。')
    .replace(/[#*_`>\-[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2900);
}

function useResourceNarration(onFinished?: () => void) {
  const [speaking, setSpeaking] = useState(false);
  const [volume, setVolumeState] = useState(1);
  const abortRef = useRef<AbortController | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const volumeRef = useRef(1);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const timerRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

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
    const finish = () => {
      if (generation !== generationRef.current) return;
      setSpeaking(false);
      onFinishedRef.current?.();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    window.speechSynthesis.speak(utterance);
  }, []);

  const setVolume = useCallback((value: number) => {
    volumeRef.current = Math.max(0, Math.min(1, value));
    setVolumeState(volumeRef.current);
    if (gainRef.current) gainRef.current.gain.value = volumeRef.current;
  }, []);

  const play = useCallback(async (text: string, speed: TtsSpeed) => {
    stop();
    if (!text) return;
    /* 全局单通道：开始讲播前停掉 PPT/Agent/字幕等其他通道 */
    audioBus.stopAll();
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
      gainRef.current ??= (() => {
        const gain = context.createGain();
        gain.gain.value = volumeRef.current;
        gain.connect(context.destination);
        return gain;
      })();
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
        source.connect(gainRef.current ?? context.destination);
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
        if (generation !== generationRef.current) return;
        setSpeaking(false);
        onFinishedRef.current?.();
      }, remainingMs);
    } catch (reason) {
      if ((reason as Error).name === 'AbortError' || generation !== generationRef.current) return;
      browserFallback(text, speed, generation);
    }
  }, [browserFallback, stop]);

  useEffect(() => {
    /* 与 PPT/Agent 等共用单音频通道：其他通道开播时自动停掉本通道 */
    const release = audioBus.register('lecture', () => stop());
    return () => {
      release();
      stop();
      if (contextRef.current) void contextRef.current.close();
    };
  }, [stop]);

  return { speaking, play, stop, volume, setVolume };
}

function QuizBlock({
  block, resource, learnerId, onResourceState, onWritebackStatus,
}: {
  block: LearningBlock;
  resource: LearningResource;
  /** 当前登录学习者（公共资源 resource.learnerId 可能为空，用于缓存失效广播兜底） */
  learnerId?: string | null;
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
        questionId: id, answer: String(optionIndex), durationSeconds,
      };
      /* 题目内容已预加载正确答案与解析：前端硬匹配即时判分，后台再异步落库 */
      const localCorrectIndex = Number(question.correctIndex);
      const localJudgable = Number.isInteger(localCorrectIndex)
        && Array.isArray(question.options)
        && localCorrectIndex >= 0
        && localCorrectIndex < question.options.length;
      const result = localJudgable
        ? { correct: optionIndex === localCorrectIndex, correctIndex: localCorrectIndex, explanation: String(question.explanation ?? '') }
        : await api.gradeLearningQuiz(resource.id, request);
      setSelected(optionIndex);
      setFeedback(result);
      notifyLearningStateChanged(learnerId ?? resource.learnerId);
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
        setFeedback((current) => ({ ...(current ?? {}), ...synced }));
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
  const [searchParams] = useSearchParams();
  const { addNote, notes } = useNotes();
  const narration = useResourceNarration(() => narrationFinishedRef.current());
  const narrationFinishedRef = useRef<() => void>(() => undefined);
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
  const [noteImg, setNoteImg] = useState<{ name: string; url: string } | null>(null);
  const noteImgInputRef = useRef<HTMLInputElement>(null);
  /** 语音转写目标：note=笔记（转写填入待编辑，不自动保存） */
  const [listening, setListening] = useState<null | 'note' | 'ask'>(null);
  const [interim, setInterim] = useState('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recRef = useRef<any>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [chatSessions, setChatSessions] = useState<PresentationChatSession[]>([]);
  const [chatSessionId, setChatSessionId] = useState('');
  const [chatPptTaskId, setChatPptTaskId] = useState<string | null>(null);
  /** 当前会话挂载的段落上下文：点击“向导学老师提问”时注入，展示在对话顶部并随首问发给 LLM */
  const [chatContext, setChatContext] = useState<{ blockTitle: string; content: string } | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const chatReadyRef = useRef(false);
  /** 会话任务 id 镜像：避免 state 闭包过期导致异步流程拿不到最新值 */
  const chatTaskIdRef = useRef<string | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const [asking, setAsking] = useState(false);
  const [askPhoto, setAskPhoto] = useState<{ name: string; url: string } | null>(null);
  const [previewPhoto, setPreviewPhoto] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [speechSpeed, setSpeechSpeed] = useState<TtsSpeed>('normal');
  /* 普通入口默认卡片播放；明确从“完整阅读”入口进入时不得再次覆盖一层幻灯。 */
  const requestedFullView = searchParams.get('view') === 'full';
  const [slideMode, setSlideMode] = useState(() => !requestedFullView);
  /* 自评乐观值：点击立即生效，后台防抖持久化，避免整页等待网络返回 */
  const [selfAssessments, setSelfAssessments] = useState<Record<string, number>>({});
  const pendingAssessRef = useRef<Record<string, number>>({});
  const assessTimer = useRef<number | null>(null);

  useEffect(() => {
    if (writebackStatus !== 'synced') return undefined;
    const timer = window.setTimeout(() => setWritebackStatus('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [writebackStatus]);
  const [completing, setCompleting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [completeConfirmOpen, setCompleteConfirmOpen] = useState(false);
  const blockRefs = useRef<Record<string, HTMLElement | null>>({});
  const slideViewportRef = useRef<HTMLElement | null>(null);
  const saveTimer = useRef<number | null>(null);
  const sessionSecondsRef = useRef(0);
  /* 预取下一个资源：进入本资源后后台拉取并写入缓存，切换时秒开 */
  const prefetchedRef = useRef<Set<string>>(new Set());
  /* 学习攒养分：打开资源 +3；每学一段 +1（每次会话上限 10 段） */
  const sectionRewardRef = useRef(0);
  const rewardedSectionRef = useRef<Set<string>>(new Set());
  /** 打开资源奖励：画像未就绪时先挂起，等 learnerId 可用再上报，避免竞态漏记 */
  const [pendingOpenReward, setPendingOpenReward] = useState<{ id: string; title: string } | null>(null);

  useEffect(() => {
    setSlideMode(!requestedFullView);
  }, [resourceId, requestedFullView]);

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
      /* 打开资源即攒养分（同一会话内每个资源只记一次）；
         画像可能尚未就绪，先标记、等 learnerId 可用再上报，避免直链进入时漏记 */
      try {
        const openKey = `lf.growthOpen:v1:${loaded.id}`;
        if (!window.sessionStorage.getItem(openKey)) {
          window.sessionStorage.setItem(openKey, '1');
          setPendingOpenReward({ id: loaded.id, title: loaded.title });
        }
      } catch { /* ignore */ }
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

  useEffect(() => {
    /* 预取下一个资源（按讲义/实操/测试顺序），后台拉取并写入缓存，切换时秒开 */
    const sorted = [...chapterResources].sort((a, b) =>
      ({ lecture: 0, practice: 1, quiz: 2 }[a.type] - ({ lecture: 0, practice: 1, quiz: 2 }[b.type])),
    );
    const index = sorted.findIndex((item) => item.id === resource?.id);
    const next = index >= 0 ? sorted[index + 1] : undefined;
    if (!resource || !next || next.id === resource.id) return;
    if (prefetchedRef.current.has(next.id)) return;
    prefetchedRef.current.add(next.id);
    void api.getLearningResource(next.id)
      .then((nextRes) => writeResourcePlayerCache(next.id, {
        resource: nextRes, course, chapterResources, traces,
      }))
      .catch(() => undefined);
  }, [resource, chapterResources, course, traces]);
  /* 渲染用自评值：乐观值叠加在服务端值之上，服务端回包后自动收敛 */
  const effectiveAssessments = useMemo(() => {
    if (!resource) return {};
    const base = assessmentsOf(resource);
    return Object.keys(selfAssessments).length ? { ...base, ...selfAssessments } : base;
  }, [resource, selfAssessments]);
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

  /* 前台展示优先：选中态立即生效，持久化在后台防抖执行，连点自动合并为一次请求 */
  const assessBlock = useCallback((blockId: string, value: number) => {
    if (!resource) return;
    pendingAssessRef.current[blockId] = value;
    setSelfAssessments({ ...pendingAssessRef.current });
    setVisited((current) => unique([...current, blockId]));
    if (assessTimer.current) window.clearTimeout(assessTimer.current);
    assessTimer.current = window.setTimeout(() => {
      const target = resource;
      const payload = { ...pendingAssessRef.current };
      if (!Object.keys(payload).length) return;
      void api.updateLearningResourceProgress(target.id, {
        currentBlockId: currentBlockId || blockId, visitedBlockIds: unique([...visited, ...Object.keys(payload)]),
        completedStepIds: completedSteps, elapsedSeconds: elapsedBase + sessionSecondsRef.current,
        selfAssessments: payload,
      }).then((result) => {
        Object.keys(payload).forEach((key) => { delete pendingAssessRef.current[key]; });
        setSelfAssessments({ ...pendingAssessRef.current });
        /* 只合并 state，避免整对象替换导致全部段落重渲染 */
        setResource((current) => current
          ? { ...current, state: result.resource.state, learned: Boolean(result.resource.state?.learned || result.resource.state?.completed) }
          : result.resource);
        toast.success(Object.values(payload).some((v) => v === 1) ? '已记录：完全掌握' : '掌握程度已更新');
      }).catch(() => {
        Object.keys(payload).forEach((key) => { delete pendingAssessRef.current[key]; });
        setSelfAssessments({ ...pendingAssessRef.current });
        toast.error('掌握程度保存失败');
      });
    }, 400);
  }, [resource, currentBlockId, visited, completedSteps, elapsedBase]);

  useEffect(() => {
    if (!blocks.length) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      const id = visible.target.getAttribute('data-block-id');
      if (!id) return;
      setCurrentBlockId(id);
      if (!rewardedSectionRef.current.has(id)) rewardSection(id);
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
    if (assessTimer.current) window.clearTimeout(assessTimer.current);
    narration.stop();
  }, [narration.stop]);

  /* 打开资源奖励：等画像 learnerId 就绪后补发（state 驱动，顺序无关） */
  useEffect(() => {
    const pending = pendingOpenReward;
    if (!pending || !currentLearnerId || !isUuid(currentLearnerId)) return;
    setPendingOpenReward(null);
    void api.recordLearnerGrowthEvent({
      learnerId: currentLearnerId, eventType: 'focus-bonus', title: `开始学习《${pending.title}》`, amount: 3,
      metadata: { resourceId: pending.id, source: 'resource-player' },
    }).catch(() => undefined);
    try { window.dispatchEvent(new CustomEvent('lf:growth-recorded', { detail: { learnerId: currentLearnerId } })); } catch { /* ignore */ }
  }, [currentLearnerId, pendingOpenReward]);

  const goBlock = (id: string, continueSpeaking = false) => {
    setCurrentBlockId(id);
    if (!rewardedSectionRef.current.has(id)) rewardSection(id);
    setVisited((current) => {
      const next = unique([...current, id]);
      saveProgress(id, next, completedSteps, elapsedBase + sessionSecondsRef.current);
      return next;
    });
    if (slideMode) {
      /* 幻灯切页只复位幻灯视口；不要滚动遮罩后的连续阅读页，
         否则其 IntersectionObserver 会反向抢写 currentBlockId。 */
      slideViewportRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    } else {
      blockRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (continueSpeaking) {
      const nextBlock = blocks.find((block) => block.id === id);
      if (nextBlock) void narration.play(narrationText(nextBlock), speechSpeed);
    } else {
      /* 手动跳段时停掉上一段讲播，避免声音与画面不同步 */
      narration.stop();
    }
  };
  /* 讲播自然结束后：幻灯模式自动续播下一页，形成连续讲解 */
  narrationFinishedRef.current = () => {
    if (slideMode && currentIndex < blocks.length - 1) goBlock(blocks[currentIndex + 1].id, true);
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
    const wasSpeaking = narration.speaking;
    setSpeechSpeed(next);
    if (wasSpeaking) {
      /* 讲播中切语速：立即按新语速重读当前段，不打断讲解节奏 */
      const block = blocks[currentIndex];
      if (block) void narration.play(narrationText(block), next);
    }
  };

  const cycleVolume = () => {
    const index = VOLUME_LEVELS.indexOf(narration.volume as (typeof VOLUME_LEVELS)[number]);
    const next = VOLUME_LEVELS[(index + 1) % VOLUME_LEVELS.length];
    narration.setVolume(next);
  };

  const srAvailable = getRecognizer() !== null;

  const stopNoteListening = () => {
    try { recRef.current?.abort(); } catch { /* ignore */ }
    recRef.current = null;
    setListening(null);
    setInterim('');
  };

  /** 语音输入：note=记笔记（转写填进草稿，不自动保存）；ask=提问（说完自动发送） */
  const startNoteListening = (target: 'note' | 'ask' = 'note') => {
    const SR = getRecognizer();
    if (!SR) {
      toast('这个浏览器不支持语音输入', { description: '换 Chrome / Edge 试试，或直接打字' });
      return;
    }
    /* 用 ref 判断是否正在听，不能用 state——闭包里的 state 是过期的 */
    if (recRef.current) { stopNoteListening(); return; }
    const rec = new SR();
    recRef.current = rec;
    rec.lang = 'zh-CN';
    rec.interimResults = true;   // 实时预览：说到哪看到哪
    rec.continuous = false;
    /** 已被取消或替换掉的识别器，其回调一律作废 */
    const isStale = () => recRef.current !== rec;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      if (isStale()) return;
      let finalText = '';
      let partial = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const seg = e.results[i];
        if (seg.isFinal) finalText += seg[0].transcript;
        else partial += seg[0].transcript;
      }
      setInterim(partial);
      if (!finalText) return;
      recRef.current = null;
      setListening(null);
      setInterim('');
      if (target === 'ask') void ask(finalText, null, true);
      else setNoteText((prev) => (prev ? `${prev} ${finalText}` : finalText));
    };
    rec.onerror = () => { if (!isStale()) stopNoteListening(); };
    rec.onend = () => {
      if (isStale()) return;
      recRef.current = null;
      setListening(null);
      setInterim('');
    };
    setListening(target);
    rec.start();
  };

  const closeNoteEditor = () => {
    stopNoteListening();
    setNoteFor(null);
    setNoteText('');
    setNoteImg(null);
  };

  const saveNoteFor = (block: LearningBlock) => {
    if (!resource || !noteText.trim()) return;
    stopNoteListening();
    addNote({
      kpId: chapter?.id ?? resource.chapterId ?? 'uncategorized',
      text: `${noteText.trim()}${noteImg ? `\n【图片 · ${noteImg.name}】` : ''}`.trim(),
      source: `${chapter?.title ?? resource.topic} · ${block.title}`,
      sourceKind: 'course',
      blockAnchor: `${resource.id}#${block.id}`,
      kbRefs: sourceIds(resource, block.citations),
    });
    setNoteFor(null);
    setNoteText('');
    setNoteImg(null);
  };

  /** 确保已解析本知识点对应的 PPT 任务（按标题匹配已完成课件）；返回任务 id，未找到返回 null */
  const ensureChatTask = async (): Promise<string | null> => {
    if (!resource) return null;
    if (chatPptTaskId) return chatPptTaskId;
    try {
      const listed = await presentationApi.listPresentationSummaries(50);
      const match = (listed.tasks ?? [])
        .filter((item) => item.status === 'completed' && (item.title === resource.topic || item.title.includes(resource.topic)))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.updatedAt).getTime())[0];
      if (match) {
        setChatPptTaskId(match.id);
        chatTaskIdRef.current = match.id;
        return match.id;
      }
    } catch { /* 会话初始化失败时退回传统问答 */ }
    chatTaskIdRef.current = null;
    return null;
  };

  const openChat = async () => {
    setChatOpen(true);
    if (!resource || chatReadyRef.current) return;
    setChatLoading(true);
    try {
      const taskId = await ensureChatTask();
      if (taskId) {
        const sessions = await listPresentationChatSessions(taskId);
        setChatSessions(sessions);
        const current = sessions.filter((item) => item.modelProvider === 'mimo')
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]
          ?? await createPresentationChatSession(taskId, 'mimo');
        setChatSessionId(current.id);
        setMessages(await loadChatHistory(taskId, current.id));
        chatReadyRef.current = true;
        return;
      }
      setChatPptTaskId(null);
      const result = await api.listLearningResourceMessages(resource.id).catch(() => ({ messages: [] }));
      setMessages(result.messages);
      chatReadyRef.current = true;
    } finally {
      setChatLoading(false);
    }
  };

  /** 点击具体段落的“向导学老师提问”：开一个新会话，并把该段内容作为上下文 */
  const askAboutBlock = async (block: LearningBlock) => {
    stopNoteListening();
    setCurrentBlockId(block.id);
    setChatOpen(true);
    setChatContext({
      blockTitle: block.title,
      content: [block.body ?? '', block.code ? `代码：
${block.code}` : ''].filter(Boolean).join('\n\n').slice(0, 3000),
    });
    setQuestion('');
    setAskPhoto(null);
    setMessages([]);
    setFollowUps([]);
    setChatLoading(true);
    try {
      const taskId = await ensureChatTask();
      if (taskId) {
        const created = await createPresentationChatSession(taskId, 'mimo');
        setChatSessionId(created.id);
        setChatSessions((current) => [...current.filter((item) => item.id !== created.id), created]);
      } else {
        setChatPptTaskId(null);
        chatTaskIdRef.current = null;
      }
      chatReadyRef.current = true;
    } catch { /* 保持回退模式 */ }
    finally { setChatLoading(false); }
  };

  const ask = async (text = question, photo?: { name: string; url: string } | null, fromVoice = false) => {
    const content = text.trim();
    if (!resource || (!content && !photo) || asking) return;
    const optimistic: ChatMessage = {
      role: 'user', content, createdAt: new Date().toISOString(),
      inputType: photo ? 'image' : fromVoice ? 'voice' : 'text',
      photoUrl: photo?.url,
    };
    setMessages((current) => [...current, optimistic]);
    setQuestion('');
    setAskPhoto(null);
    setAsking(true);
    /* 新会话首问挂载段落上下文：让 LLM 基于当前点击的模块内容回答 */
    const contextPrefix = chatContext && messages.length === 0
      ? `【当前段落】《${chatContext.blockTitle}》
${chatContext.content}

`
      : '';
    const currentTaskId = chatTaskIdRef.current ?? chatPptTaskId;
    /* 无课件任务：保留原有问答接口（图片退化为文本标记，不基于进度） */
    if (!currentTaskId) {
      const message = `${contextPrefix}${content}${photo ? (content ? '\n' : '') + '【图片 · ' + photo.name + '】' : ''}`;
      try {
        const result = await api.chatLearningResource(resource.id, {
          message,
          history: messages.slice(-12).map(({ role, content: itemContent }) => ({ role, content: itemContent })),
          currentQuestionId: null,
        });
        setMessages((current) => [...current, { role: 'assistant', content: result.reply, createdAt: new Date().toISOString() }]);
        setFollowUps(result.followUps ?? []);
        void api.recordLearningEvent({ eventType: 'CHAT_INTERACTION', sourceType: 'CHAT', sourceId: resource.id, metadata: JSON.stringify({ courseId: resource.courseId, chapterId: resource.chapterId }) }).catch(() => undefined);
      } catch (reason) { toast.error(reason instanceof Error ? reason.message : '提问失败'); }
      finally { setAsking(false); }
      return;
    }
    const taskId = currentTaskId;
    let sessionId = chatSessionId;
    const controller = new AbortController();
    chatAbortRef.current?.abort();
    chatAbortRef.current = controller;
    let reply = '';
    let failed = '';
    const appendAssistant = (piece: string) => {
      setMessages((current) => {
        const next = [...current];
        if (next.length && next[next.length - 1].role === 'assistant') {
          next[next.length - 1] = { ...next[next.length - 1], content: piece };
        } else {
          next.push({ role: 'assistant', content: piece, createdAt: new Date().toISOString() });
        }
        return next;
      });
    };
    try {
      if (!sessionId) {
        const created = await createPresentationChatSession(taskId, 'mimo');
        sessionId = created.id;
        setChatSessionId(created.id);
        setChatSessions((current) => [...current.filter((item) => item.id !== created.id), created]);
      }
      if (photo) {
        /* 图片提问：与交互导学 mimo 一致，走 image-stream，图片随会话落库并在历史中回显 */
        const imageBlob = await (await fetch(photo.url)).blob();
        await streamPresentationChatImage(taskId, imageBlob, 0, contextPrefix + content, sessionId, 'mimo', (event) => {
          if (event.type === 'phase') {
            appendAssistant(event.phase === 'understanding' ? '正在分析图片…' : '已理解图片，正在生成回复…');
          } else if (event.type === 'reply_delta' && event.content) {
            reply += event.content;
            appendAssistant(reply);
          } else if (event.type === 'result' && event.content) {
            reply = event.content;
            appendAssistant(reply);
          } else if (event.type === 'error') {
            failed = event.message || '图片问答失败，请稍后重试';
          }
        }, controller.signal);
      } else {
        await streamPresentationChatText(taskId, [{ role: 'user', content: contextPrefix + content }], 0, sessionId, 'mimo', (event) => {
          if (event.type === 'chat_delta' && event.content) {
            reply += event.content;
            appendAssistant(reply);
          } else if (event.type === 'refused') {
            reply = event.banner || '这个问题暂时无法回答。';
          } else if (event.type === 'chat_failed') {
            failed = event.message || '回答生成失败，请稍后重试';
          }
        }, controller.signal);
      }
      if (!reply && failed) setMessages((current) => [...current, { role: 'assistant', content: failed, createdAt: new Date().toISOString() }]);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '回答生成失败，请稍后重试';
      setMessages((current) => [...current, { role: 'assistant', content: message, createdAt: new Date().toISOString() }]);
    } finally {
      setAsking(false);
    }
  };

  /** 加载会话历史：图片消息拉取附件并生成本地预览地址，保证多模态记录可回显 */
  const loadChatHistory = async (taskId: string, sessionId: string): Promise<ChatMessage[]> => {
    const history = await getPresentationChatMessages(taskId, sessionId);
    const restored: ChatMessage[] = [];
    for (const item of history) {
      const entry: ChatMessage = {
        role: item.role, content: item.content, createdAt: item.createdAt,
        inputType: item.inputType, attachmentId: item.attachmentId ?? null,
      };
      if (item.role === 'user' && item.inputType === 'image' && item.attachmentId) {
        try {
          const blob = await fetchChatAttachmentBlob(item.attachmentId);
          entry.photoUrl = URL.createObjectURL(blob);
        } catch { /* 附件加载失败时仅显示文本 */ }
      }
      restored.push(entry);
    }
    return restored;
  };

  const selectChatSession = async (sessionId: string) => {
    if (!chatPptTaskId || !sessionId) return;
    setChatSessionId(sessionId);
    setChatContext(null);
    setChatLoading(true);
    try {
      setMessages(await loadChatHistory(chatPptTaskId, sessionId));
      setFollowUps([]);
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : '会话记录加载失败'); }
    finally { setChatLoading(false); }
  };

  const createChatSession = async () => {
    if (!chatPptTaskId || chatLoading) return;
    setChatLoading(true);
    try {
      const created = await createPresentationChatSession(chatPptTaskId, 'mimo');
      setChatSessions((current) => [...current, created]);
      setChatSessionId(created.id);
      setChatContext(null);
      setMessages([]);
      setFollowUps([]);
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : '新建会话失败'); }
    finally { setChatLoading(false); }
  };

  const deleteChatSession = async () => {
    if (!chatPptTaskId || !chatSessionId || chatLoading) return;
    setChatLoading(true);
    try {
      await deletePresentationChatSession(chatPptTaskId, chatSessionId);
      const remaining = chatSessions.filter((item) => item.id !== chatSessionId);
      setChatSessions(remaining);
      const next = remaining.filter((item) => item.modelProvider === 'mimo')
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
      if (next) {
        setChatSessionId(next.id);
        setChatContext(null);
        setMessages(await loadChatHistory(chatPptTaskId, next.id));
      } else {
        setChatSessionId('');
        setChatContext(null);
        setMessages([]);
      }
      setFollowUps([]);
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : '删除会话失败'); }
    finally { setChatLoading(false); }
  };

  const unassessedCount = resource && resource.type !== 'quiz'
    ? blocks.filter((block) => block.kind !== 'quiz' && effectiveAssessments[block.id] == null).length
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
      if (block.kind !== 'quiz' && effectiveAssessments[block.id] == null) extra[block.id] = 0.25;
    });
    finishComplete(extra);
  };

  const finishComplete = (extraAssessments: Record<string, number>) => {
    if (!resource || completing) return;
    setCompleting(true);
    setCompleteConfirmOpen(false);
    toast.success('已标记完成，正在后台同步学习记录');
    markLearningMapReturn(currentLearnerId);
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
          selfAssessments: { ...effectiveAssessments, ...extraAssessments },
        }).catch(() => undefined);
        void api.recordLearningEvent({ eventType: 'STUDY_END', sourceType: 'RESOURCE', sourceId: resource.id, durationSeconds: elapsedBase + sessionSecondsRef.current, metadata: JSON.stringify({ courseId: resource.courseId, chapterId: resource.chapterId, resourceType: resource.type, completed: true }) }).catch(() => undefined);
        const mapLearnerId = isUuid(resource.learnerId) ? resource.learnerId! : currentLearnerId;
        if (isUuid(mapLearnerId)) {
          await refreshLearningMapResourceCache(mapLearnerId).catch(() => undefined);
          notifyLearningStateChanged(mapLearnerId);
        }
      } catch { /* 后台失败静默，避免打扰已跳转用户 */ }
    })();
  };

  /** 重新练习：清空本人对该资源的进度/作答/自评/掌握度（后端重置 + 清错题），回到第一段重新测评 */
  /** 任何学习行为都攒养分（复用后端 focus-bonus 自定义奖励，≤25 分）并广播，园子即时刷新 */
  const rewardGrowth = (title: string, amount: number) => {
    const learnerId = resource?.learnerId ?? currentLearnerId;
    if (!learnerId || !isUuid(learnerId)) return;
    void api.recordLearnerGrowthEvent({
      learnerId, eventType: 'focus-bonus', title, amount,
      metadata: { resourceId: resource?.id, source: 'resource-player' },
    }).catch(() => undefined);
    try { window.dispatchEvent(new CustomEvent('lf:growth-recorded', { detail: { learnerId } })); } catch { /* ignore */ }
  };

  const rewardSection = (blockId: string) => {
    if (rewardedSectionRef.current.has(blockId) || sectionRewardRef.current >= 10) return;
    const block = blocks.find((item) => item.id === blockId);
    if (!block || (block.kind !== 'lecture' && block.kind !== 'practice' && block.kind !== 'quiz')) return;
    rewardedSectionRef.current.add(blockId);
    sectionRewardRef.current += 1;
    rewardGrowth(`学习了「${block.title}」`, 1);
  };

  const restartPractice = async () => {
    if (!resource || restarting) return;
    setRestarting(true);
    try {
      const { resource: fresh } = await api.resetLearningResource(resource.id);
      setResource(fresh);
      setVisited([]);
      setCompletedSteps([]);
      setSafetyChecks([]);
      setElapsedBase(0);
      setSessionSeconds(0);
      sessionSecondsRef.current = 0;
      setSelfAssessments({});
      pendingAssessRef.current = {};
      sectionRewardRef.current = 0;
      rewardedSectionRef.current.clear();
      try { window.sessionStorage.removeItem(`lf.growthOpen:v1:${resource.id}`); } catch { /* ignore */ }
      setWritebackStatus('idle');
      setCompleteConfirmOpen(false);
      const firstId = blocks[0]?.id ?? '';
      setCurrentBlockId(firstId);
      try { window.localStorage.removeItem(`${RESOURCE_CACHE_PREFIX}${resource.id}`); } catch { /* ignore */ }
      toast.success('已重新开始，进度与掌握度已清零');
      notifyLearningStateChanged(resource.learnerId);
      if (firstId) {
        requestAnimationFrame(() => blockRefs.current[firstId]?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      }
      if (isUuid(currentLearnerId)) void refreshLearningMapResourceCache(currentLearnerId).catch(() => undefined);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '重新练习失败，请稍后再试');
    } finally {
      setRestarting(false);
    }
  };

  if (loading) return <div className="mx-auto flex min-h-[62vh] max-w-[980px] items-center justify-center gap-2 px-5 text-[13px] text-ink-muted"><Loader2 size={17} className="animate-spin" />正在恢复你的学习现场…</div>;
  if (error || !resource) return <div className="mx-auto max-w-[760px] px-5 py-20 text-center"><h1 className="font-serif text-[24px] font-semibold text-ink">这项学习资源暂时打不开</h1><p className="mt-2 text-[13px] text-brand-danger">{error || '资源不存在'}</p><Link to="/learn" className="lf-btn-primary mt-5 inline-flex">返回我的课程</Link></div>;

  const activeBlock = blocks[currentIndex];
  const sortedResources = [...chapterResources].sort((a, b) => ({ lecture: 0, practice: 1, quiz: 2 }[a.type] - ({ lecture: 0, practice: 1, quiz: 2 }[b.type])));
  const resourceIndex = sortedResources.findIndex((item) => item.id === resource.id);
  const nextResource = resourceIndex >= 0 ? sortedResources[resourceIndex + 1] : undefined;
  const resourcePath = (id: string) => requestedFullView ? fullLearningResourcePath(id) : `/learn/resource/${id}`;
  const returnToKnowledgePoint = () => {
    markLearningMapReturn(currentLearnerId);
    navigate('/learn');
  };

  return <div className={cn('mx-auto max-w-[1260px] px-4 pb-40 pt-6 md:px-6', chatOpen && 'relative z-50')}>
    {<div className="mb-5 flex flex-wrap items-center gap-2 text-[12px] text-ink-muted"><button type="button" onClick={returnToKnowledgePoint} className="inline-flex items-center gap-1 hover:text-brand"><ArrowLeft size={13} />返回知识点</button><ChevronRight size={12} />{resource.courseId && resource.chapterId ? <Link to={`/resources?courseId=${encodeURIComponent(resource.courseId)}&chapterId=${encodeURIComponent(resource.chapterId)}`} className="hover:text-brand">{chapter?.title ?? '章节资源'}</Link> : <span className="max-w-[260px] truncate text-ink-2">{resource.topic || '学习资源'}</span>}{resource.courseId && resource.chapterId ? <><ChevronRight size={12} /><span className="truncate text-ink-2">{resourceMeta[resource.type].label}</span></> : null}</div>}

    <header className="flex items-center gap-4 rounded-[14px] border border-hairline bg-card-warm px-5 py-3">
      <h1 className="min-w-0 flex-1 truncate font-serif text-[18px] font-semibold text-ink">{resource.title}</h1>
      <div className="flex shrink-0 items-center gap-4 font-mono text-[11px] text-ink-muted">
        <span className="flex items-center gap-1"><Clock3 size={12} />{formatDuration(elapsedBase + sessionSeconds)}</span>
        <span>{displayedCompletedCount}/{blocks.length}{resource.type === 'quiz' ? '题' : '段'}</span>
        <span className="text-brand font-semibold">{displayedCompletionPercent}%</span>
      </div>
    </header>

    {sortedResources.length > 1 && <nav className="mt-4 flex gap-2 overflow-x-auto pb-1">{sortedResources.map((item) => { const Meta = resourceMeta[item.type]; return <Link key={item.id} to={resourcePath(item.id)} replace className={cn('flex shrink-0 items-center gap-2 rounded-[11px] border px-3.5 py-2 text-[12.5px] transition', item.id === resource.id ? 'border-brand bg-brand text-paper' : 'border-hairline bg-card-warm text-ink-2 hover:border-brand/40')}><Meta.Icon size={13} />{Meta.label}{item.learned && <Check size={12} />}</Link>; })}</nav>}


    <div className="mt-7 grid gap-7 lg:grid-cols-[250px_minmax(0,1fr)]">
      {<aside className="min-w-0 self-start lg:sticky lg:top-[76px]"><div className="rounded-[16px] border border-hairline bg-card-warm p-3"><div className="px-2 pb-2"><div className="lf-mono-label">LEARNING PATH</div><div className="mt-1 text-[13px] font-semibold text-ink">本讲目录</div></div><div className="flex gap-1 overflow-x-auto pb-1 lg:block lg:h-[min(68vh,calc(100dvh_-_190px))] lg:space-y-1 lg:overflow-y-auto lg:overscroll-contain lg:pb-0 lg:pr-1.5">{blocks.map((block, index) => { const quizResult = resource.type === 'quiz' ? quizAnswers.get(block.id) : undefined; const done = resource.type === 'quiz' ? quizAnswers.has(block.id) : visited.includes(block.id) || resource.learned; const wrong = resource.type === 'quiz' && done && quizResult === false; return <button key={block.id} type="button" onClick={() => goBlock(block.id)} className={cn('flex w-[210px] shrink-0 items-start gap-2.5 rounded-[10px] px-2.5 py-2.5 text-left transition lg:w-full', block.id === currentBlockId ? 'bg-brand-tint text-brand' : 'text-ink-2 hover:bg-paper-deep')}><span className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[9px]', wrong ? 'border-brand-danger bg-brand-danger text-paper' : done ? 'border-brand bg-brand text-paper' : 'border-hairline bg-paper text-ink-muted')}>{wrong ? <X size={10} /> : done ? <Check size={10} /> : index + 1}</span><span className="min-w-0"><span className="block text-[10px] opacity-65">{block.eyebrow}</span><span className="mt-0.5 block text-[12px] font-medium leading-[17px]">{block.title}</span></span></button>; })}</div></div>{progressOf(resource).lastOpenedAt && <p className="mt-3 hidden px-2 text-[10.5px] leading-5 text-ink-muted lg:block">已从后端恢复上次断点：{new Date(progressOf(resource).lastOpenedAt!).toLocaleString()}</p>}</aside>}

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
        {resource.type !== 'quiz' && <div className="mt-5 rounded-[12px] border border-brand/20 bg-brand-tint/25 p-3.5"><div className="flex flex-wrap items-center justify-between gap-2"><div><div className="text-[12px] font-semibold text-ink">这一块你掌握得怎么样？</div><div className="mt-0.5 text-[10.5px] text-ink-muted">自评会和答题正确率一起计算掌握程度，可随时修改。</div></div><div className="flex flex-wrap gap-1.5">{([{ label: '还需学习', value: 0.2 }, { label: '基本理解', value: 0.55 }, { label: '大体掌握', value: 0.8 }, { label: '我已经完全掌握', value: 1 }] as const).map((option) => { const selected = effectiveAssessments[block.id] === option.value; return <button key={option.value} type="button" onClick={() => void assessBlock(block.id, option.value)} className={cn('rounded-full border px-3 py-1.5 text-[11px] transition', selected ? 'border-brand bg-brand text-paper' : 'border-hairline bg-paper text-ink-2 hover:border-brand/45')}>{selected && <Check size={11} className="mr-1 inline" />}{option.label}</button>; })}</div></div></div>}
        <div className="mt-5 border-t border-hairline/70 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => { stopNoteListening(); setNoteFor(block); setNoteText(''); setNoteImg(null); }} className="lf-btn-ghost !px-3 !py-1.5 text-[11.5px]"><NotebookPen size={13} />记这一段</button>
            <button type="button" onClick={() => void askAboutBlock(block)} className="lf-btn-ghost !px-3 !py-1.5 text-[11.5px]"><MessageCircleQuestion size={13} />向导学老师提问</button>
            {index < blocks.length - 1 && <button type="button" onClick={() => goBlock(blocks[index + 1].id)} className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-brand hover:underline">下一段<ArrowRight size={12} /></button>}
          </div>
          {noteFor?.id === block.id ? (
            <div className="mt-3 rounded-[10px] border border-brand/30 bg-paper p-2.5">
              <textarea autoFocus value={noteText} onChange={(event) => setNoteText(event.target.value)} rows={2} placeholder="用自己的话记下这一段的要点…（也可以说，或拍张图）" className="w-full resize-none bg-transparent text-[13px] leading-[20px] text-ink outline-none placeholder:text-ink-muted/60" />
              {listening === 'note' && <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-brand-danger"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-brand-danger" />正在听…{interim || '（说完自动填进上面）'}</div>}
              {noteImg && <div className="mt-1.5 flex items-center gap-2 rounded-[8px] border border-hairline bg-card-warm p-1.5"><img src={noteImg.url} alt="" className="h-9 w-9 rounded-[6px] object-cover" /><span className="min-w-0 flex-1 truncate text-[11px] text-ink-2">{noteImg.name}</span><button type="button" onClick={() => setNoteImg(null)} aria-label="移除图片" className="text-ink-muted hover:text-brand-danger"><X size={12} /></button></div>}
              <div className="mt-1.5 flex items-center gap-2">
                <span className="flex shrink-0 items-center gap-1">
                  {srAvailable && <button type="button" onClick={() => (listening === 'note' ? stopNoteListening() : startNoteListening())} title={listening === 'note' ? '再点一次停止' : '说：语音转文字填进笔记'} aria-label="语音记笔记" className={cn('flex h-7 w-7 items-center justify-center rounded-full border transition-all', listening === 'note' ? 'animate-pulse border-brand-danger bg-brand-danger text-paper' : 'border-hairline bg-card-warm text-ink-2 hover:border-brand/40 hover:text-brand')}><Mic size={13} /></button>}
                  <input ref={noteImgInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => { const f = event.target.files?.[0]; if (f) setNoteImg({ name: f.name, url: URL.createObjectURL(f) }); event.target.value = ''; }} />
                  <button type="button" onClick={() => noteImgInputRef.current?.click()} title="拍：给这条笔记配张现场图" aria-label="给笔记配图" className="flex h-7 w-7 items-center justify-center rounded-full border border-hairline bg-card-warm text-ink-2 transition-all hover:border-brand/40 hover:text-brand"><Camera size={13} /></button>
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-muted">自动携带来源{noteFor.citations.length > 0 ? ' + KB 溯源' : ''} → 我的笔记</span>
                <span className="flex shrink-0 gap-1.5">
                  <button type="button" onClick={closeNoteEditor} className="rounded-md px-2 py-1 text-[12px] text-ink-muted hover:text-ink">取消</button>
                  <button type="button" disabled={!noteText.trim() && !noteImg} onClick={() => saveNoteFor(block)} className={cn('rounded-md px-2.5 py-1 text-[12px] font-medium', noteText.trim() || noteImg ? 'bg-brand text-paper' : 'bg-paper-deep text-ink-muted/50')}>存入笔记</button>
                </span>
              </div>
            </div>
          ) : notes.filter((note) => note.blockAnchor === `${resource.id}#${block.id}`).length > 0 ? (
            <span className="mt-3 inline-flex items-center gap-1.5 text-[11.5px] text-ink-muted"><PenLine size={11} className="text-brand/70" />这段记了 {notes.filter((note) => note.blockAnchor === `${resource.id}#${block.id}`).length} 条</span>
          ) : null}
        </div>
      </motion.section>)}</main>
    </div>

    {traces.length > 0 && <section className="mt-8 rounded-[18px] border border-hairline bg-card-warm p-5 md:p-7"><div className="flex items-center gap-2"><Sparkles size={16} className="text-brand" /><h2 className="font-serif text-[20px] font-semibold text-ink">真实来源与生成依据</h2></div><p className="mt-1 text-[12px] text-ink-muted">以下来源由知识库检索或 Web Search 提供，并与正文引用位置关联。</p><div className="mt-4 grid gap-3 md:grid-cols-2">{traces.map((trace, traceIndex) => <article key={`${String(trace.id ?? 'source')}-${trace.title}-${traceIndex}`} className="rounded-[12px] border border-hairline bg-paper p-4"><div className="flex items-start gap-3"><span className="rounded-md bg-brand-tint px-2 py-1 font-mono text-[10px] text-brand">{trace.credibility}%</span><div className="min-w-0"><h3 className="text-[13px] font-semibold text-ink">{trace.title}</h3><p className="mt-1 line-clamp-3 text-[11.5px] leading-5 text-ink-muted">{trace.excerpt}</p></div></div>{trace.positions.length > 0 && <div className="mt-3 flex flex-wrap gap-1">{trace.positions.slice(0, 5).map((position, positionIndex) => <span key={`${position}-${positionIndex}`} className="rounded bg-paper-deep px-1.5 py-1 text-[9.5px] text-ink-muted">{position}</span>)}</div>}{trace.url && <a href={trace.url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-[11px] text-brand hover:underline">查看来源<ExternalLink size={10} /></a>}</article>)}</div></section>}

    <footer className="mt-8 flex flex-col items-center justify-between gap-4 rounded-[18px] border border-brand/20 bg-brand-tint/30 p-5 sm:flex-row"><div><div className="text-[13px] font-semibold text-ink">{resource.learned ? '本项资源已经学完' : resource.type === 'quiz' && !quizAllAnswered ? '完成全部答题后即可结束测试' : '完成本项学习后，进度会写入画像与报告'}</div><p className="mt-1 text-[11.5px] text-ink-muted">{resource.type === 'quiz' ? '作答' : '阅读'} {displayedCompletedCount}/{blocks.length} {resource.type === 'quiz' ? '题' : '段'} · 学习 {formatDuration(elapsedBase + sessionSeconds)}</p></div><div className="flex gap-2">{nextResource && <Link to={resourcePath(nextResource.id)} replace className="lf-btn-ghost">下一项：{resourceMeta[nextResource.type].label}<ArrowRight size={14} /></Link>}{resource.learned && <button type="button" disabled={restarting} onClick={() => void restartPractice()} className="lf-btn-ghost">{restarting ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}重新练习</button>}<button type="button" disabled={completing || !quizAllAnswered} onClick={() => { if (resource.learned) { returnToKnowledgePoint(); return; } void markComplete(); }} className="lf-btn-primary">{completing ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}{resource.learned ? '返回地图' : resource.type === 'quiz' && !quizAllAnswered ? '请先完成全部题目' : '完成本项学习'}</button></div></footer>

    <div className="fixed inset-x-0 bottom-[58px] z-40 mx-auto flex w-[min(920px,calc(100%-24px))] items-center gap-1.5 rounded-[17px] border border-hairline bg-paper/95 p-2.5 shadow-warm-lg backdrop-blur-md md:bottom-4 md:gap-2">
      <button type="button" onClick={speakCurrent} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-paper" title="播放这一段">{narration.speaking ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
      <div className="hidden min-w-0 flex-1 sm:block"><div className="truncate text-[12.5px] font-medium text-ink">{activeBlock?.title ?? resource.title}</div><div className="mt-0.5 flex items-center gap-2 font-mono text-[9.5px] text-ink-muted"><span><Headphones size={10} className="mr-1 inline" />{narration.speaking ? '正在讲播' : '点击播放当前段落'}</span><span>{currentIndex + 1}/{blocks.length}</span></div></div>
      <button type="button" onClick={cycleSpeed} className="flex h-9 shrink-0 items-center gap-1 rounded-[10px] border border-hairline px-2.5 text-[10.5px] text-ink-muted" title="切换语速"><Gauge size={13} /><span>{speedMeta[speechSpeed].label}</span></button>
      <button type="button" onClick={cycleVolume} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-hairline text-ink-muted" title={narration.volume === 0 ? '恢复音量' : `音量 ${Math.round(narration.volume * 100)}%`}>{narration.volume === 0 ? <VolumeX size={13} /> : narration.volume < 0.6 ? <Volume1 size={13} /> : <Volume2 size={13} />}</button>
      <button type="button" onClick={() => setSlideMode(true)} className="flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] border border-hairline px-2.5 text-[11px] text-ink-muted" title="幻灯模式：一段一页"><Presentation size={13} /><span className="hidden md:inline">幻灯</span></button>
      <button type="button" onClick={() => void openChat()} aria-label="向智能助教提问" className="flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] border border-hairline px-2.5 text-[11px] text-ink-muted"><Bot size={13} /><span className="hidden lg:inline">提问</span></button>
      <button type="button" onClick={() => { stopNoteListening(); if (activeBlock) { setNoteFor(activeBlock); setNoteText(''); setNoteImg(null); } }} aria-label="记录当前段落笔记" className="flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] border border-hairline px-2.5 text-[11px] text-ink-muted"><NotebookPen size={13} /><span className="hidden lg:inline">笔记</span></button>
    </div>

    <AnimatePresence>{writebackStatus !== 'idle' && <motion.div initial={{ opacity: 0, y: -8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.96 }} className={cn('fixed right-4 top-4 z-[110] flex items-center gap-2 rounded-full border px-3.5 py-2 text-[11.5px] shadow-warm backdrop-blur-md', writebackStatus === 'failed' ? 'border-brand-danger/30 bg-paper/95 text-brand-danger' : 'border-brand/25 bg-paper/95 text-brand')}>
      {writebackStatus === 'syncing' ? <Loader2 size={13} className="animate-spin" /> : writebackStatus === 'synced' ? <Check size={13} /> : <X size={13} />}
      <span>{writebackStatus === 'syncing' ? '正在同步学习记录' : writebackStatus === 'synced' ? '学习记录已同步' : '学习记录同步失败'}</span>
      {writebackStatus !== 'syncing' && <button type="button" aria-label="关闭同步提示" onClick={() => setWritebackStatus('idle')} className="ml-0.5 opacity-60 hover:opacity-100"><X size={11} /></button>}
    </motion.div>}</AnimatePresence>

    {createPortal(<AnimatePresence>{slideMode && activeBlock && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[9999] flex flex-col bg-paper">
      <header className="flex items-center gap-3 border-b border-hairline bg-card-warm px-4 py-3 md:px-6"><Presentation size={17} className="text-brand" /><div className="min-w-0 flex-1"><div className="truncate text-[13px] font-semibold text-ink">幻灯模式 · {resource.title}</div><div className="font-mono text-[9.5px] text-ink-muted">真实课程内容 · 第 {currentIndex + 1}/{blocks.length} 段</div></div><button type="button" onClick={() => setSlideMode(false)} className="rounded-lg p-2 text-ink-muted hover:bg-paper-deep" title="退出幻灯"><X size={17} /></button></header>
      <main ref={slideViewportRef} className="flex flex-1 items-center justify-center overflow-x-hidden overflow-y-auto bg-gradient-to-br from-brand-tint/25 via-paper to-card-warm px-4 py-8 md:px-12"><article className="relative w-full max-w-[1040px] overflow-hidden rounded-[24px] border border-brand/20 bg-card-warm/95 p-6 shadow-warm-lg md:p-8 lg:p-10"><div className="absolute right-0 top-0 h-32 w-32 rounded-bl-full bg-brand/5" /><div className="relative mx-auto max-w-[800px]"><div className="inline-flex rounded-full border border-brand/20 bg-brand-tint px-3 py-1 font-mono text-[10px] tracking-[0.12em] text-brand">{activeBlock.eyebrow}</div><h2 className="mt-4 max-w-[780px] font-serif text-[27px] font-semibold leading-tight tracking-[-0.015em] text-ink md:text-[34px]">{activeBlock.title}</h2><div className="mt-5 h-1 w-14 rounded-full bg-brand" />{activeBlock.body && <div className="mt-7"><ReactMarkdown remarkPlugins={[remarkGfm, remarkCitationMarks]} components={slideMdComponents}>{activeBlock.body}</ReactMarkdown></div>}<InlineBlockCitations block={activeBlock} resource={resource} />{activeBlock.code && <pre className="mt-6 max-h-[42vh] overflow-auto rounded-[14px] bg-ink p-5 text-[14px] leading-6 text-paper md:text-[16px]"><code>{activeBlock.code}</code></pre>}{activeBlock.expectedOutput && <div className="mt-5 rounded-[14px] border border-brand/25 bg-brand-tint/55 p-4 text-[15px] leading-7 text-ink-2 md:text-[17px]"><strong className="text-brand">预期结果</strong><span className="mx-2 text-brand/40">/</span>{activeBlock.expectedOutput}</div>}{activeBlock.kind === 'quiz' && <QuizBlock block={activeBlock} resource={resource} learnerId={currentLearnerId} onWritebackStatus={setWritebackStatus} onResourceState={(state) => setResource((current) => current ? { ...current, state, learned: Boolean(state.learned || state.completed) } : current)} />}</div></article></main>
      <footer className="flex items-center justify-center gap-3 border-t border-hairline bg-card-warm px-4 py-3"><button type="button" disabled={currentIndex === 0} onClick={() => goBlock(blocks[currentIndex - 1].id, narration.speaking)} className="flex h-10 w-10 items-center justify-center rounded-full border border-hairline text-ink-muted disabled:opacity-30" title="上一页"><ChevronLeft size={17} /></button><button type="button" onClick={speakCurrent} className="flex h-11 items-center gap-2 rounded-full bg-brand px-5 text-[12.5px] font-medium text-paper">{narration.speaking ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}{narration.speaking ? '暂停讲播' : '讲这一页'}</button><button type="button" onClick={cycleSpeed} className="h-10 rounded-full border border-hairline px-4 font-mono text-[11px] text-ink-muted">{speedMeta[speechSpeed].label}</button><button type="button" onClick={cycleVolume} className="flex h-10 w-10 items-center justify-center rounded-full border border-hairline text-ink-muted" title={narration.volume === 0 ? '恢复音量' : `音量 ${Math.round(narration.volume * 100)}%`}>{narration.volume === 0 ? <VolumeX size={14} /> : narration.volume < 0.6 ? <Volume1 size={14} /> : <Volume2 size={14} />}</button><button type="button" disabled={currentIndex >= blocks.length - 1} onClick={() => goBlock(blocks[currentIndex + 1].id, narration.speaking)} className="flex h-10 w-10 items-center justify-center rounded-full border border-hairline text-ink-muted disabled:opacity-30" title="下一页"><ChevronRight size={17} /></button></footer>
    </motion.div>}</AnimatePresence>, document.body)}


    <AnimatePresence>{chatOpen && <><motion.button type="button" aria-label="关闭提问面板背景" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => { chatAbortRef.current?.abort(); setChatOpen(false); }} className="fixed inset-0 z-[70] bg-ink/20 backdrop-blur-[2px]" /><motion.aside initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} className="fixed bottom-0 right-0 top-14 z-[80] flex w-full max-w-[500px] flex-col border-l border-hairline bg-paper shadow-2xl"><div className="flex items-center gap-3 border-b border-hairline bg-card-warm p-4"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-paper"><Bot size={17} /></span><div className="min-w-0 flex-1"><h2 className="text-[14px] font-semibold text-ink">智能助教</h2><p className="truncate text-[10.5px] text-ink-muted">正在结合课件与真实来源回答，可随时提问</p></div><button type="button" aria-label="关闭提问" onClick={() => { chatAbortRef.current?.abort(); setChatOpen(false); }} className="rounded-lg p-2 text-ink-muted hover:bg-paper-deep"><X size={16} /></button></div>{chatPptTaskId && <div className="flex items-center gap-2 border-b border-hairline bg-paper px-4 py-2"><select value={chatSessionId} onChange={(event) => void selectChatSession(event.target.value)} className="min-w-0 flex-1 truncate bg-transparent text-[11px] text-ink-2 outline-none" aria-label="聊天会话">{chatSessions.filter((item) => item.modelProvider === 'mimo').map((session) => <option key={session.id} value={session.id}>{session.title || '会话'}</option>)}</select><button type="button" disabled={chatLoading} onClick={() => void createChatSession()} className="rounded-md px-1.5 py-1 font-mono text-[10px] text-ink-muted hover:bg-paper-deep hover:text-brand disabled:opacity-50" title="新建会话"><Plus size={11} className="mr-0.5 inline" />新建</button><button type="button" disabled={chatLoading || !chatSessionId} onClick={() => void deleteChatSession()} className="font-mono text-[10px] text-ink-muted hover:text-brand-danger disabled:opacity-40"><Trash2 size={11} className="mr-0.5 inline" />删除</button></div>}<div className="flex-1 space-y-3 overflow-y-auto p-4">{chatLoading && messages.length === 0 && <div className="flex items-center gap-2 text-[11.5px] text-ink-muted"><Loader2 size={13} className="animate-spin" />正在加载会话…</div>}{chatContext && <div className="rounded-[13px] border border-brand/25 bg-brand-tint/35 px-3.5 py-2.5 text-[12px] leading-5 text-ink-2"><div className="mb-1 flex items-center gap-1.5 font-medium text-brand"><BookOpen size={13} />当前段落 · {chatContext.blockTitle}</div><p className="line-clamp-3 whitespace-pre-wrap">{chatContext.content}</p></div>}{messages.length === 0 && !chatLoading && <div className="rounded-[13px] border border-brand/20 bg-brand-tint/35 p-4 text-[12.5px] leading-6 text-ink-2">{chatPptTaskId ? '可以问我这个知识点的内容，我会结合课件与真实来源回答。' : '我已经读过这项资源和它引用的知识库、网页来源。你可以让我解释当前段落、检查理解，或根据作答记录生成巩固建议。'}</div>}{messages.map((message, index) => <div key={`${message.createdAt}-${index}`} className={cn('flex max-w-[90%] flex-col gap-1.5', message.role === 'user' ? 'ml-auto items-end' : 'items-start')}>{message.role === 'user' && message.photoUrl && <button type="button" onClick={() => setPreviewPhoto(message.photoUrl!)} title="点击查看大图" className="block max-h-[140px] w-fit overflow-hidden rounded-[10px] border border-white/20"><img src={message.photoUrl} alt="提问附图" className="max-h-[140px] w-fit rounded-[10px] object-cover" /></button>}<div className={cn('rounded-[13px] px-3.5 py-2.5 text-[12.5px] leading-6', message.role === 'user' ? 'rounded-br-sm bg-brand text-paper' : 'rounded-tl-sm border border-hairline bg-card-warm text-ink-2')}>{message.role === 'user' && message.inputType === 'voice' && <Mic size={12} className="mr-1 inline" />}<ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content || (message.photoUrl ? '（图片）' : '')}</ReactMarkdown></div></div>)}{asking && <div className="flex items-center gap-2 text-[11.5px] text-ink-muted"><Loader2 size={13} className="animate-spin" />正在结合内容与来源思考…</div>}{!chatPptTaskId && followUps.length > 0 && <div className="flex flex-wrap gap-1.5">{followUps.map((item) => <button key={item} type="button" onClick={() => void ask(item)} className="rounded-lg border border-hairline bg-card-warm px-2.5 py-1.5 text-left text-[10.5px] text-brand hover:border-brand/40">{item}</button>)}</div>}</div><div className="border-t border-hairline bg-card-warm p-3">
    {listening === 'ask' && <div className="mb-2 flex items-center gap-1.5 text-[11.5px] text-brand-danger"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-brand-danger" />正在听…{interim || '（说完自动发送）'}</div>}
    {askPhoto && <div className="mb-2 flex items-center gap-2 rounded-[10px] border border-hairline bg-paper p-2"><img src={askPhoto.url} alt="" className="h-10 w-10 rounded-[8px] object-cover" /><span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-2">{askPhoto.name}</span><button type="button" onClick={() => setAskPhoto(null)} aria-label="移除图片" className="text-ink-muted hover:text-brand-danger"><X size={13} /></button></div>}
    <div className="flex items-end gap-2">
      <button type="button" disabled={asking} onClick={() => (listening === 'ask' ? stopNoteListening() : startNoteListening('ask'))} title={listening === 'ask' ? '再点一次取消（不发送）' : '语音提问 · 说完自动发送'} aria-label="语音提问" className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-all', listening === 'ask' ? 'animate-pulse border-brand-danger bg-brand-danger text-paper' : 'border-hairline bg-paper text-ink-2 hover:border-brand/40')}><Mic size={15} /></button>
      <input ref={photoInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => { const f = event.target.files?.[0]; if (f) setAskPhoto({ name: f.name, url: URL.createObjectURL(f) }); event.target.value = ''; }} />
      <button type="button" disabled={asking} onClick={() => photoInputRef.current?.click()} title="拍：上传图片提问" aria-label="图片提问" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-hairline bg-paper text-ink-2 transition-all hover:border-brand/40 hover:text-brand"><ImagePlus size={15} /></button>
      <textarea value={listening === 'ask' ? interim : question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask(question, askPhoto); } }} placeholder={listening === 'ask' ? '正在听…' : askPhoto ? '这张图想问什么？（可不填）' : '输入问题，或点麦克风说'} readOnly={listening === 'ask'} className="max-h-28 min-h-10 flex-1 resize-none rounded-[11px] border border-hairline bg-paper px-3 py-2.5 text-[12.5px] outline-none focus:border-brand/45" />
      <button type="button" disabled={(!question.trim() && !askPhoto) || asking} onClick={() => void ask(question, askPhoto)} className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-brand text-paper disabled:opacity-40"><Send size={15} /></button>
    </div>
  </div></motion.aside></>}</AnimatePresence>
  {previewPhoto && (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-ink/80 p-6 backdrop-blur-sm" onClick={() => setPreviewPhoto(null)} role="dialog" aria-modal="true" aria-label="提问图片预览">
        <img src={previewPhoto} alt="提问图片预览" className="max-h-[85vh] max-w-[90vw] rounded-[14px] object-contain shadow-2xl" />
        <button type="button" onClick={() => setPreviewPhoto(null)} className="absolute right-5 top-5 flex h-10 w-10 items-center justify-center rounded-full bg-paper/10 text-paper backdrop-blur transition hover:bg-paper/20" aria-label="关闭预览"><X size={18} /></button>
      </div>
    )}
  {completeConfirmOpen && (
      <div className="fixed inset-0 z-[110] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm" onClick={() => setCompleteConfirmOpen(false)} role="dialog" aria-modal="true" aria-label="完成确认">
        <div className="w-full max-w-[420px] rounded-[18px] border border-brand/30 bg-card-warm p-6 shadow-warm-lg" onClick={(event) => event.stopPropagation()}>
          <h3 className="font-serif text-[18px] font-semibold text-ink">还有 {unassessedCount} 段没选掌握程度</h3>
          <p className="mt-1.5 text-[12.5px] leading-5 text-ink-muted">未选择的段落将默认标记为「基本理解」（25% 掌握分），与你的选择一起计入掌握程度。确认后立即返回知识网络。</p>
          <div className="mt-5 flex gap-2">
            <button type="button" onClick={() => setCompleteConfirmOpen(false)} className="lf-btn-ghost flex-1 justify-center">再想想</button>
            <button type="button" onClick={confirmComplete} className="lf-btn-primary flex-1 justify-center">确认完成并返回地图</button>
          </div>
          <button type="button" disabled={restarting} onClick={() => void restartPractice()} className="lf-btn-ghost mt-2 w-full justify-center !py-2 text-brand-danger">{restarting ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}重新练习 · 清空掌握度重测</button>
        </div>
      </div>
    )}
  </div>;
}
