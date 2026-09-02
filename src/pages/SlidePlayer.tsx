import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, Check, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, Loader2, NotebookPen, Pause, Play, Presentation, Volume1, Volume2, VolumeX, X } from 'lucide-react';
import { api, type CustomizeSlide, type CustomizeSlidesResponse, type LearningResource, type TtsSpeed } from '@/lib/api';
import SourceCitationMarks from '@/components/resources/SourceCitationMarks';
import { slideMdComponents } from '@/components/resources/lecture-markdown';
import remarkCitationMarks from '@/lib/remarkCitationMarks';
import { cn } from '@/lib/utils';
import { useProfile } from '@/context/ProfileContext';
import { markLearningMapReturn } from '@/lib/learningNavigation';
import LearningCompleteDialog from '@/components/learn/LearningCompleteDialog';
import { useNotes } from '@/context/NotesContext';
import { narrationSpeeds, useStreamingNarration } from '@/hooks/useStreamingNarration';
import { useAgent } from '@/context/AgentContext';
import { fetchSlideAsset, presentationApi, updatePptLearningProgress } from '@/lib/presentationApi';
import { toast } from 'sonner';
import { buildQuizFollowUpPrompt } from '@/lib/assistantPrompts';

type QuizValue = string | number;

function assessmentLabel(score: number | null | undefined) {
  if (score == null) return undefined;
  if (score === 0) return '还需学习';
  if (score === 0.25) return '基本理解';
  if (score === 0.5) return '大体掌握';
  return '完全掌握';
}

const quizDifficultyMeta = {
  easy: { label: '基础', color: '#287a62' },
  medium: { label: '进阶', color: '#b17818' },
  hard: { label: '挑战', color: '#b94f45' },
} as const;

function quizDifficultyOf(question: Record<string, unknown>) {
  const raw = String(question.difficulty ?? question.difficultyLevel ?? '').toLowerCase();
  const byLabel = quizDifficultyMeta[raw as keyof typeof quizDifficultyMeta];
  if (byLabel) return byLabel;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    if (numeric <= 2) return quizDifficultyMeta.easy;
    if (numeric === 3) return quizDifficultyMeta.medium;
    return quizDifficultyMeta.hard;
  }
  return { label: '自适应', color: '#6b7280' };
}

function DifficultyBadge({ question }: { question: Record<string, unknown> }) {
  const meta = quizDifficultyOf(question);
  return (
    <span className="inline-flex rounded-full border px-3 py-1 font-mono text-[10px] tracking-[0.1em]" style={{ borderColor: `${meta.color}55`, color: meta.color, backgroundColor: `${meta.color}14` }}>
      {meta.label}
    </span>
  );
}
function quizInitialState(slide: CustomizeSlide, resourceState?: Record<string, unknown> | null) {
  const question = slide.content as Record<string, unknown>;
  const questionId = String(question.id ?? question.questionId ?? slide.id ?? '');
  const answered = Array.isArray(resourceState?.answered) ? resourceState.answered : [];
  const record = answered.find((item: Record<string, unknown>) => String(item.questionId) === questionId) as Record<string, unknown> | undefined;
  if (!record) return { picked: null, feedback: null };
  const selected = Number(record.selectedIndex ?? record.selectedAnswer ?? NaN);
  return {
    picked: Number.isFinite(selected) ? selected : null,
    feedback: {
      correct: Boolean(record.correct),
      correctIndex: typeof question.correctIndex === 'number' ? question.correctIndex : undefined,
      explanation: String(question.explanation ?? question.analysis ?? '') || undefined,
    },
  };
}

function QuizCard({ slide, onInteractionChange, resourceId, initialPicked = null, initialFeedback = null }: { slide: CustomizeSlide; onInteractionChange: (state: { submitted: boolean; selectedAnswer?: string; correct?: boolean }) => void; resourceId?: string | null; initialPicked?: QuizValue | null; initialFeedback?: { correct: boolean; correctIndex?: number; explanation?: string } | null }) {
  const question = slide.content as Record<string, unknown>;
  const rawOptions = Array.isArray(question.options) ? question.options : [];
  const options = rawOptions.map((option, index) => {
    if (typeof option === 'string') return { label: option, value: index };
    const item = option as Record<string, unknown>;
    return { label: String(item.text ?? item.label ?? item.content ?? ''), value: (item.value ?? item.id ?? index) as QuizValue };
  });
  const [picked, setPicked] = useState<QuizValue | null>(initialPicked);
  const [feedback, setFeedback] = useState<{ correct: boolean; correctIndex?: number; explanation?: string } | null>(initialFeedback);
  const proactiveSentRef = useRef(false);
  const { askFree, askSimilarQuiz, setOpen } = useAgent();
  const correct = (question.correctAnswer ?? question.answer ?? question.correctIndex) as QuizValue | undefined;
  const localCorrectIndex = typeof correct === 'string' && /^[A-Za-z]$/.test(correct)
    ? correct.toUpperCase().charCodeAt(0) - 65 : Number(correct);
  const pickedIndex = options.findIndex((option) => picked !== null && String(option.value) === String(picked));
  const localIsCorrect = picked !== null && (String(picked) === String(correct) || pickedIndex === localCorrectIndex);
  const isCorrect = feedback?.correct ?? localIsCorrect;
  const displayCorrectIndex = feedback?.correctIndex ?? localCorrectIndex;
  useEffect(() => {
    onInteractionChange({ submitted: picked !== null, ...(picked !== null ? { selectedAnswer: String(picked), correct: isCorrect } : {}) });
  }, [onInteractionChange, picked]);

  const choose = async (option: QuizValue, index: number, resourceId?: string | null) => {
    if (picked !== null) return;
    setPicked(option);
    if (!proactiveSentRef.current) {
      proactiveSentRef.current = true;
      const optionLabels = options.map((item) => item.label);
      setOpen(true);
      const selectedCorrect = String(option) === String(correct) || index === localCorrectIndex;
      askFree(buildQuizFollowUpPrompt({
        title: slide.title,
        stem: String(question.stem ?? question.question ?? question.title ?? slide.title),
        options: optionLabels,
        selectedIndex: index,
        correct: selectedCorrect,
        correctIndex: Number.isFinite(localCorrectIndex) ? localCorrectIndex : null,
        explanation: String(question.explanation ?? question.analysis ?? ''),
      }));
      if (!selectedCorrect) {
        void askSimilarQuiz();
      }
    }
    const questionId = String(question.id ?? question.questionId ?? slide.id ?? '');
    const fallback = {
      correct: picked !== null ? false : (String(option) === String(correct) || index === localCorrectIndex),
      correctIndex: Number.isFinite(localCorrectIndex) ? localCorrectIndex : undefined,
      explanation: String(question.explanation ?? question.analysis ?? '') || undefined,
    };
    if (!resourceId || !questionId) {
      setFeedback(fallback);
      return;
    }
    try {
      const result = await api.answerLearningQuiz(resourceId, {
        questionId,
        answer: String(option),
        durationSeconds: 1,
      }) as { correct?: unknown; correctIndex?: unknown; explanation?: unknown; analysis?: unknown };
      setFeedback({
        correct: Boolean(result.correct),
        correctIndex: Number(result.correctIndex ?? localCorrectIndex),
        explanation: String(result.explanation ?? result.analysis ?? question.explanation ?? question.analysis ?? '') || undefined,
      });
    } catch {
      setFeedback(fallback);
    }
  };

  return (
    <div className="mt-7">
      <h2 className="font-serif text-[25px] font-semibold leading-[1.45] text-ink md:text-[30px]">{String(question.stem ?? question.question ?? question.title ?? slide.title)}</h2>
      <div className="mt-6 grid gap-3">
        {options.map((option, index) => {
          const selected = picked !== null && String(picked) === String(option.value);
          const correctOption = picked !== null && (String(option.value) === String(correct) || index === displayCorrectIndex);
          return <button key={`${option.value}-${index}`} type="button" disabled={picked !== null} onClick={() => void choose(option.value, index, resourceId)} className={cn('flex items-start gap-3 rounded-[14px] border px-4 py-3.5 text-left text-[14px] leading-6', picked === null && 'border-hairline bg-paper hover:border-brand/45 hover:bg-brand-tint/30', selected && !isCorrect && 'border-brand-danger/40 bg-red-50', correctOption && 'border-emerald-500/70 bg-emerald-50 text-emerald-900')}><span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-current font-mono text-[11px]">{String.fromCharCode(65 + index)}</span><span>{option.label}</span>{correctOption && <Check size={16} className="ml-auto mt-1 text-emerald-600" />}</button>;
        })}
      </div>
      {picked !== null && <div className={cn('mt-5 rounded-[14px] border p-4 text-[13px] leading-6', isCorrect ? 'border-brand/30 bg-brand-tint/45 text-ink' : 'border-brand-amber/35 bg-brand-amber-tint/45 text-ink')}><strong>{isCorrect ? '回答正确' : '解析'}</strong>{(feedback?.explanation || question.explanation || question.analysis) ? <p className="mt-1 text-ink-2">{String(feedback?.explanation ?? question.explanation ?? question.analysis)}</p> : null}</div>}
    </div>
  );
}

function SourceList({ sources, evidenceQuotes }: { sources?: Array<Record<string, unknown>>; evidenceQuotes?: Array<Record<string, unknown>> }) {
  if (!sources?.length) return null;
  const citations = sources.map((source, index) => Number(source.id ?? index + 1)).filter(Number.isFinite);
  return <div className="mt-7 border-t border-hairline pt-4"><p className="font-mono text-[10px] tracking-[0.12em] text-ink-muted">本页依据</p><div className="mt-2"><SourceCitationMarks citations={citations} evidenceQuotes={evidenceQuotes} sources={sources} /></div></div>;
}

const citedSourceIds = (slide?: CustomizeSlide): Set<number> => {
  if (!slide) return new Set();
  const text = typeof slide.content === 'string' ? slide.content : JSON.stringify(slide.content ?? {});
  return new Set([...text.matchAll(/(?<!\!)\[(\d+)\](?!\s*\()/g)].map((match) => Number(match[1])));
};

/** 后端按完整章节生成；前端收到章节后一次拆出其中全部小节卡片。 */
function expandReadySlides(rawSlides: CustomizeSlide[]): CustomizeSlide[] {
  const expanded: CustomizeSlide[] = [];
  rawSlides.forEach((rawSlide) => {
    if (rawSlide.type !== 'chapter' || typeof rawSlide.content !== 'string') {
      expanded.push({ ...rawSlide, index: expanded.length });
      return;
    }
    const content = rawSlide.content;
    const heading = /^###\s+(.+?)\s*$/gm;
    const matches = [...content.matchAll(heading)];
    if (!matches.length) {
      expanded.push({ ...rawSlide, index: expanded.length });
      return;
    }
    matches.forEach((match, partIndex) => {
      const bodyStart = (match.index ?? 0) + match[0].length;
      const bodyEnd = matches[partIndex + 1]?.index ?? content.length;
      expanded.push({
        ...rawSlide,
        index: expanded.length,
        partIndex,
        partCount: matches.length,
        title: match[1].trim(),
        content: content.slice(bodyStart, bodyEnd).trim(),
      });
    });
  });
  return expanded;
}

function contentSlidesOf(resource: LearningResource): CustomizeSlide[] {
  const content = resource.content as Record<string, unknown>;
  const slides: CustomizeSlide[] = [];

  if (resource.type === 'lecture') {
    const objectives = Array.isArray(content.learningObjectives)
      ? content.learningObjectives.map(String).filter(Boolean)
      : [];
    const summary = String(content.summary ?? '').trim();
    if (summary || objectives.length) {
      slides.push({
        index: slides.length, unitIndex: 0, totalUnits: 0, type: 'intro' as const,
        title: String(content.introTitle ?? '学习目标与内容概览'),
        content: [
          summary,
          objectives.length ? `**完成本讲后，你将能够：**\n${objectives.map((item) => `- ${item}`).join('\n')}` : '',
        ].filter(Boolean).join('\n\n'),
        sources: [], evidenceQuotes: [],
      });
    }
    const chapters = Array.isArray(content.chapters) ? content.chapters as Record<string, unknown>[] : [];
    chapters.forEach((ch, ci) => {
      const sections = Array.isArray(ch.sections) ? ch.sections as Record<string, unknown>[] : [];
      if (!sections.length) {
        slides.push({
          index: slides.length, unitIndex: ci, totalUnits: 0, type: 'chapter' as const,
          title: String(ch.title ?? ''), content: String(ch.content ?? ''),
          sources: [], evidenceQuotes: [],
        });
      } else {
        sections.forEach((sec) => {
          slides.push({
            index: slides.length, unitIndex: ci, totalUnits: 0, type: 'chapter' as const,
            title: String(sec.title ?? ch.title ?? ''), content: String(sec.content ?? sec.body ?? ''),
            sources: [], evidenceQuotes: [],
          });
        });
      }
    });
    const review = Array.isArray(content.reviewQuestions) ? content.reviewQuestions.map(String).filter(Boolean) : [];
    if (review.length) {
      slides.push({
        index: slides.length, unitIndex: chapters.length, totalUnits: 0, type: 'chapter' as const,
        title: '带着问题检查理解', content: review.map((item, index) => `${index + 1}. ${item}`).join('\n\n'),
        sources: [], evidenceQuotes: [],
      });
    }
  } else if (resource.type === 'practice') {
    const prerequisites = Array.isArray(content.prerequisites) ? content.prerequisites.map(String) : [];
    const environment = Array.isArray(content.environment) ? content.environment.map(String) : [];
    slides.push({
      index: slides.length, unitIndex: 0, totalUnits: 0, type: 'intro' as const,
      title: String(content.title ?? resource.title),
      content: [
        String(content.objective ?? ''),
        prerequisites.length ? `\n\n**前置条件**\n${prerequisites.map((item) => `- ${item}`).join('\n')}` : '',
        environment.length ? `\n\n**环境与工具**\n${environment.map((item) => `- ${item}`).join('\n')}` : '',
      ].filter(Boolean).join('\n'),
      sources: [], evidenceQuotes: [],
    });
    const steps = Array.isArray(content.steps) ? content.steps as Record<string, unknown>[] : [];
    steps.forEach((step, si) => {
      slides.push({
        index: slides.length, unitIndex: si, totalUnits: 0, type: 'step' as const,
        title: String(step.title ?? `步骤 ${si + 1}`),
        content: String(step.instruction ?? step.content ?? step.description ?? ''),
        sources: [], evidenceQuotes: [],
      });
    });
    const criteria = Array.isArray(content.acceptanceCriteria) ? content.acceptanceCriteria.map(String).filter(Boolean) : [];
    if (criteria.length) {
      slides.push({
        index: slides.length, unitIndex: steps.length, totalUnits: 0, type: 'step' as const,
        title: '用结果判断是否真正完成', content: criteria.map((item) => `- ${item}`).join('\n'),
        sources: [], evidenceQuotes: [],
      });
    }
  } else if (resource.type === 'quiz') {
    const questions = Array.isArray(content.questions) ? content.questions as Record<string, unknown>[] : [];
    questions.forEach((q, qi) => {
      slides.push({
        index: slides.length, unitIndex: qi, totalUnits: 0, type: 'question' as const,
        title: `题目 ${qi + 1}`, content: q,
        sources: [], evidenceQuotes: [],
      });
    });
  }

  slides.forEach((slide, index) => {
    slide.index = index;
    slide.totalUnits = slides.length;
  });
  return slides;
}

export default function SlidePlayer() {
  const { taskId: rawTaskId = '', resourceId: rawResourceId = '' } = useParams<{ taskId: string; resourceId: string }>();
  const taskId = rawTaskId;
  const resourceId = rawResourceId;
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const { addNote } = useNotes();
  const { open: assistantOpen, setOpen: setAssistantOpen } = useAgent();
  const [data, setData] = useState<CustomizeSlidesResponse | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [error, setError] = useState('');
  const [resourceSources, setResourceSources] = useState<Array<Record<string, unknown>>>([]);
  const [completedResource, setCompletedResource] = useState<LearningResource | null>(null);
  const [speechSpeed, setSpeechSpeed] = useState<TtsSpeed>('normal');
  const narration = useStreamingNarration();
  const cardScrollRef = useRef<HTMLDivElement>(null);
  const [completing, setCompleting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [completeConfirmOpen, setCompleteConfirmOpen] = useState(false);
  const [slideAssessments, setSlideAssessments] = useState<Record<number, number>>({});
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [quizInteraction, setQuizInteraction] = useState<{ submitted: boolean; selectedAnswer?: string; correct?: boolean }>({ submitted: false });
  const [presentationImage, setPresentationImage] = useState('');
  const quizAssistantOpenedRef = useRef(false);
  const volumeLevels = [1, 0.6, 0.3, 0] as const;

  useEffect(() => {
    if (resourceId) {
      let alive = true;
      void api.getLearningResource(resourceId).then((resource) => {
        if (!alive) return;
        setCompletedResource(resource);
        setResourceSources((resource.sources ?? []) as Array<Record<string, unknown>>);
        const builtSlides = contentSlidesOf(resource);
        setData({ slides: builtSlides, total: builtSlides.length, completed: builtSlides.length, status: 'completed' as const, resourceId: resource.id, resourceType: resource.type, title: resource.title, stageMessage: '', kpId: resource.kpId ?? null });
      }).catch(() => { if (alive) setError('无法加载资源'); });
      return () => { alive = false; };
    }
    if (!taskId) return;
    let alive = true;
    let timer = 0;
    const load = async () => {
      try {
        const next = await api.getCustomizeSlides(taskId);
        if (!alive) return;
        setData(next);
        setError('');
        if (next.status === 'generating') timer = window.setTimeout(() => void load(), 1200);
      } catch (reason) {
        if (!alive) return;
        setError(reason instanceof Error ? reason.message : '暂时无法读取学习卡片');
        timer = window.setTimeout(() => void load(), 2500);
      }
    };
    void load();
    return () => { alive = false; if (timer) window.clearTimeout(timer); };
  }, [taskId, resourceId]);

  const slides = useMemo(() => {
    const ready = expandReadySlides(data?.slides ?? []);
    if (ready.some((item) => item.type === 'intro') || data?.resourceType !== 'lecture' || !completedResource) return ready;
    const objectives = Array.isArray(completedResource.content.learningObjectives)
      ? completedResource.content.learningObjectives.map(String).filter(Boolean)
      : [];
    const summary = String(completedResource.content.summary ?? '').trim();
    if (!summary && !objectives.length) return ready;
    const body = [
      summary,
      objectives.length ? `**完成本讲后，你将能够：**\n${objectives.map((item) => `- ${item}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    return [{
      index: 0, unitIndex: 0, totalUnits: ready.length, type: 'intro' as const,
      title: String(completedResource.content.introTitle ?? '学习目标与内容概览'), content: body,
    }, ...ready.map((item, index) => ({ ...item, index: index + 1 }))];
  }, [data?.slides, data?.resourceType, completedResource]);
  useEffect(() => { if (slides.length && currentIndex >= slides.length) setCurrentIndex(slides.length - 1); }, [slides.length, currentIndex]);
  const slide = slides[currentIndex];
  useEffect(() => {
    if (slide?.type !== 'presentation' || !slide.presentationId) {
      setPresentationImage('');
      return;
    }
    let alive = true;
    let objectUrl = '';
    void fetchSlideAsset(slide.presentationId, slide.unitIndex, 'slides').then((blob) => {
      if (!alive) return;
      objectUrl = URL.createObjectURL(blob);
      setPresentationImage(objectUrl);
    }).catch(() => { if (alive) setPresentationImage(''); });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [slide?.type, slide?.presentationId, slide?.unitIndex]);
  const isQuiz = data?.resourceType === 'quiz' || slide?.type === 'question';
  useEffect(() => {
    if (!isQuiz || quizAssistantOpenedRef.current) return;
    quizAssistantOpenedRef.current = true;
    setAssistantOpen(true);
  }, [isQuiz, setAssistantOpen]);
  useEffect(() => { setQuizInteraction({ submitted: false }); }, [currentIndex, slide?.index]);
  useEffect(() => { cardScrollRef.current?.scrollTo({ top: 0 }); }, [currentIndex, slide?.index]);
  const readyNext = currentIndex + 1 < slides.length;
  const isLastSlide = slides.length > 0 && currentIndex === slides.length - 1;
  const expected = useMemo(() => Math.max(data?.total ?? 0, slides.length), [data?.total, slides.length]);
  useEffect(() => {
    if (!data?.resourceId) return;
    let alive = true;
    void api.getLearningResource(data.resourceId).then((resource) => {
      if (alive) {
        setCompletedResource(resource);
        setResourceSources((resource.sources ?? []) as Array<Record<string, unknown>>);
        if (data?.status !== 'generating' && resource.type !== 'ppt') {
          const builtSlides = contentSlidesOf(resource);
          setData((prev) => prev ? { ...prev, slides: builtSlides, total: builtSlides.length, completed: builtSlides.length, status: 'completed' as const } : prev);
        }
      }
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [data?.resourceId, data?.status]);
  const pageSources = useMemo(() => {
    if (slide?.sources?.length) return slide.sources;
    const ids = citedSourceIds(slide);
    return ids.size
      ? resourceSources.filter((source, index) => ids.has(Number(source.id ?? index + 1)))
      : [];
  }, [slide, resourceSources]);

  const currentNarrationText = () => {
    if (!slide) return '';
    const raw = typeof slide.content === 'string'
      ? `${slide.title}。${slide.content}`
      : `${slide.title}。${String(slide.content.stem ?? slide.content.question ?? '')}`;
    return raw
      .replace(/```[\s\S]*?```/g, ' 代码示例请看屏幕。')
      .replace(/[#*_`>\-[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2900);
  };
  const speakCurrent = () => {
    if (narration.speaking) { narration.stop(); return; }
    const text = currentNarrationText();
    if (text) void narration.play(text, speechSpeed);
  };
  useEffect(() => { narration.stop(); }, [currentIndex]);

  const cycleSpeed = () => {
    const index = narrationSpeeds.findIndex((item) => item.value === speechSpeed);
    const next = narrationSpeeds[(index + 1) % narrationSpeeds.length].value;
    const wasSpeaking = narration.speaking;
    setSpeechSpeed(next);
    if (wasSpeaking) {
      const text = currentNarrationText();
      if (text) void narration.play(text, next);
    }
  };

  const cycleVolume = () => {
    const index = volumeLevels.indexOf(narration.volume as (typeof volumeLevels)[number]);
    narration.setVolume(volumeLevels[(index + 1) % volumeLevels.length]);
  };

  const assessableSlides = slides
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => item.type !== 'question' && item.type !== 'intro' && index > 0 && index < slides.length - 1);
  const unassessedCount = assessableSlides.filter(({ index }) => slideAssessments[index] == null).length;

  const assessmentKey = (item: CustomizeSlide, index: number) => {
    if (item.type === 'intro') return 'lecture-intro';
    if (item.type === 'chapter') return `lecture-${item.unitIndex + 1}-${(item.partIndex ?? 0) + 1}`;
    if (item.type === 'step') return `practice-step-${item.unitIndex + 1}`;
    return `slide-${index + 1}`;
  };

  const handleComplete = async () => {
    if (!data?.resourceId || completing) return;
    setCompleting(true);
    try {
      const assessments: Record<string, number> = {};
      assessableSlides.forEach(({ item, index }) => {
        assessments[assessmentKey(item, index)] = slideAssessments[index] ?? 0.25;
      });
      if (Object.keys(assessments).length) {
        await api.updateLearningResourceProgress(data.resourceId, {
          currentBlockId: assessmentKey(slide!, currentIndex),
          visitedBlockIds: assessableSlides.map(({ item, index }) => assessmentKey(item, index)),
          selfAssessments: assessments,
        });
      }
      if (data.resourceType === 'ppt') await presentationApi.completePresentation(data.resourceId);
      else await api.completeLearningResource(data.resourceId);
      setCompleteConfirmOpen(false);
      window.dispatchEvent(new CustomEvent('lf:learning-state-changed', { detail: { learnerId: currentLearner.id } })); markLearningMapReturn(currentLearner.id);
      navigate('/learn');
    } catch {
      setError('学习记录保存失败，请稍后重试');
      setCompleting(false);
    }
  };

  const handleRestart = async () => {
    if (!data?.resourceId || restarting) return;
    setRestarting(true);
    try {
      if (data.resourceType === 'ppt') {
        await updatePptLearningProgress(data.resourceId, { learned: false, pageIndex: 0, pageCount: slides.length });
      } else {
        const result = await api.resetLearningResource(data.resourceId);
        setCompletedResource(result.resource);
      }
      setSlideAssessments({});
      setCurrentIndex(0);
      setCompleteConfirmOpen(false);
      setError('');
    } catch {
      setError('学习记录重置失败，请稍后重试');
    } finally {
      setRestarting(false);
    }
  };

  const saveCurrentNote = () => {
    if (!slide || !noteText.trim()) return;
    const kbRefs = pageSources
      .map((source) => String(source.chunkId ?? source.id ?? ''))
      .filter(Boolean);
    addNote({
      kpId: data?.kpId ?? completedResource?.kpId ?? 'uncategorized',
      text: noteText.trim(),
      source: `${data?.title ?? '学习资源'} · ${slide.title}`,
      sourceKind: 'course',
      blockAnchor: data?.resourceId ? `${data.resourceId}#slide-${currentIndex + 1}` : undefined,
      kbRefs,
    });
    setNoteText('');
    setNoteOpen(false);
  };

  const needsAssessment = slide && slide.type !== "question" && slide.type !== "intro" && currentIndex > 0 && !isLastSlide;
  const goNext = () => {
    if (needsAssessment && slideAssessments[currentIndex] == null) {
      setSlideAssessments((prev) => ({ ...prev, [currentIndex]: 0.25 }));
      toast('未选择掌握程度，已默认标记为「基本理解」', { description: '返回上一页可随时调整自评档位' });
    }
    setCurrentIndex((v) => Math.min(slides.length - 1, v + 1));
  };
  return (
    <main className="fixed inset-0 z-[9999] flex min-h-0 flex-col overflow-hidden bg-paper">
      <header className="flex shrink-0 items-center gap-3 border-b border-hairline bg-card-warm px-4 py-3 md:px-6">
        <Presentation size={17} className="text-brand" />
        <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-semibold text-ink">幻灯模式 · {data?.title ?? '正在准备个性化学习内容'}</div><div className="font-mono text-[9.5px] text-ink-muted">个性化内容生成中 · 第 {slides.length ? currentIndex + 1 : 0}/{expected || slides.length || 0} 页</div></div>
        {data?.resourceId && <button type="button" onClick={() => { narration.stop(); navigate(data.resourceType === 'ppt' ? `/learn/${encodeURIComponent(data.kpId ?? '')}?ppt=${encodeURIComponent(data.resourceId!)}` : `/learn/resource/${encodeURIComponent(data.resourceId!)}?view=full`); }} className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-hairline bg-paper px-3 text-[11px] font-medium text-ink-2 hover:border-brand/35 hover:text-brand"><BookOpen size={13} />完整阅读</button>}
        <button type="button" onClick={() => { narration.stop(); window.dispatchEvent(new CustomEvent('lf:learning-state-changed', { detail: { learnerId: currentLearner.id } })); markLearningMapReturn(currentLearner.id); navigate('/learn'); }} className="rounded-lg p-2 text-ink-muted hover:bg-paper-deep" title="退出幻灯"><X size={17} /></button>
      </header>

      <section className={cn('flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-gradient-to-br from-brand-tint/25 via-paper to-card-warm px-4 py-8 md:px-12', isQuiz && assistantOpen && 'lg:pr-[var(--lf-slide-assistant-width)]')}>
        {!slide ? <div className="flex h-full w-full max-w-[880px] flex-col items-center justify-center rounded-[24px] border border-dashed border-brand/30 bg-card-warm px-6 text-center">{data?.status === 'failed' || data?.status === 'cancelled' ? <><CircleAlert size={25} className="text-brand-danger" /><h1 className="mt-4 font-serif text-[23px] font-semibold text-ink">本次定制没有生成可学习页面</h1><p className="mt-2 max-w-md text-[12.5px] leading-6 text-ink-muted">返回知识网络后重新选择该资源，即可按新的逐页流程生成。</p><button type="button" onClick={() => navigate('/learn')} className="lf-btn-primary mt-5">返回知识网络</button></> : <><Loader2 size={25} className="animate-spin text-brand" /><h1 className="mt-4 font-serif text-[23px] font-semibold text-ink">正在准备第一张学习卡片</h1><p className="mt-2 max-w-md text-[12.5px] leading-6 text-ink-muted">第一页完成后会立即显示，不必等待整项资源生成。</p>{error && <p className="mt-4 flex items-center gap-1.5 text-[11px] text-brand-danger"><CircleAlert size={13} />{error}</p>}</>}</div>
          : <article className="relative flex h-full min-h-0 w-full max-w-[1040px] flex-col overflow-hidden rounded-[24px] border border-brand/20 bg-card-warm/95 shadow-warm-lg" data-assistant-context data-assistant-focus="true" data-context-kind={slide.type === 'question' ? '当前题目' : slide.type === 'step' ? '当前实操步骤' : '当前学习卡片'} data-context-title={slide.title} data-context-index={currentIndex + 1} data-context-total={expected || slides.length} data-context-current-page={currentIndex + 1} data-context-total-pages={expected || slides.length} data-context-assessed={slideAssessments[currentIndex] != null ? 'true' : undefined} data-context-assessment={assessmentLabel(slideAssessments[currentIndex])} data-context-resource-id={data?.resourceId ?? ''} data-context-knowledge-point-id={data?.kpId ?? completedResource?.kpId ?? ''} data-context-quiz-submitted={slide.type === 'question' ? String(quizInteraction.submitted) : undefined} data-context-selected-answer={slide.type === 'question' ? quizInteraction.selectedAnswer : undefined} data-context-quiz-correct={slide.type === 'question' && quizInteraction.correct !== undefined ? String(quizInteraction.correct) : undefined}>
              <div className="flex shrink-0 items-center justify-between gap-4 border-b border-hairline/70 bg-paper/55 px-6 py-3.5 md:px-9">{slide.type === 'question' ? <DifficultyBadge question={slide.content as Record<string, unknown>} /> : <span className="inline-flex rounded-full border border-brand/20 bg-brand-tint px-3 py-1 font-mono text-[10px] tracking-[0.1em] text-brand">{slide.type === 'step' ? '实操步骤' : slide.type === 'intro' ? '本讲导览' : slide.type === 'presentation' ? '交互课件' : '领学章节'}</span>}{data?.status === 'generating' && <span className="inline-flex items-center gap-1.5 text-[10.5px] text-ink-muted"><Loader2 size={12} className="animate-spin" />后续页面讲解生成中</span>}</div>
              <div ref={cardScrollRef} className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-6 pb-8 pt-5 [scrollbar-gutter:stable] md:px-9 md:pb-9 md:pt-6">
                {slide.type === 'question' ? <QuizCard key={slide.index} slide={slide} resourceId={data?.resourceId} onInteractionChange={setQuizInteraction} initialPicked={quizInitialState(slide, completedResource?.state).picked} initialFeedback={quizInitialState(slide, completedResource?.state).feedback} /> : slide.type === 'presentation' ? <div className="mx-auto flex h-full max-w-[980px] flex-col"><h1 className="shrink-0 font-serif text-[22px] font-semibold text-ink">{slide.title}</h1><div className="mt-4 flex min-h-[320px] flex-1 items-center justify-center overflow-hidden rounded-[16px] border border-hairline bg-ink/5">{presentationImage ? <img src={presentationImage} alt={`第 ${slide.unitIndex + 1} 页 · ${slide.title}`} className="max-h-full max-w-full object-contain" /> : <Loader2 size={22} className="animate-spin text-brand" />}</div><div className="mt-4 rounded-xl border border-brand/15 bg-brand-tint/25 px-4 py-3 text-[12.5px] leading-6 text-ink-2"><span className="mr-2 font-medium text-brand">本页讲解</span>{String(slide.content ?? '')}</div></div> : <><h1 className="font-serif text-[28px] font-semibold leading-tight text-ink md:text-[34px]">{slide.title}</h1><div className="mt-6 h-1 w-14 rounded-full bg-brand" /><div className="mt-7 max-w-none text-ink-2"><ReactMarkdown remarkPlugins={[remarkGfm, remarkCitationMarks]} components={slideMdComponents}>{String(slide.content ?? '')}</ReactMarkdown></div></>}
                <SourceList sources={pageSources} evidenceQuotes={slide.evidenceQuotes} />
              </div>
            </article>}
      </section>

      <footer className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 overflow-x-auto border-t border-hairline bg-card-warm px-4 py-2.5 md:px-6">
        <div aria-hidden="true" />
        <div className="flex shrink-0 items-center justify-self-center gap-3">
          <button type="button" disabled={currentIndex === 0} onClick={() => setCurrentIndex((value) => Math.max(0, value - 1))} className="flex h-10 w-10 items-center justify-center rounded-full border border-hairline text-ink-muted disabled:opacity-30" title="上一页"><ChevronLeft size={17} /></button>
          <button type="button" onClick={speakCurrent} className="flex h-11 items-center gap-2 rounded-full bg-brand px-5 text-[12.5px] font-medium text-paper">{narration.speaking ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}{narration.speaking ? '暂停讲播' : '讲这一页'}</button>
          <button type="button" onClick={cycleSpeed} className="h-10 rounded-full border border-hairline px-4 font-mono text-[11px] text-ink-muted">{narrationSpeeds.find((item) => item.value === speechSpeed)?.label ?? '1.0×'}</button>
          <button type="button" onClick={cycleVolume} className="flex h-10 w-10 items-center justify-center rounded-full border border-hairline text-ink-muted" title={narration.volume === 0 ? '恢复音量' : `音量 ${Math.round(narration.volume * 100)}%`}>{narration.volume === 0 ? <VolumeX size={14} /> : narration.volume < 0.6 ? <Volume1 size={14} /> : <Volume2 size={14} />}</button>
          <button type="button" disabled={!slide} onClick={() => { setNoteText(''); setNoteOpen(true); }} className="flex h-10 items-center gap-1.5 rounded-full border border-hairline px-3 text-[11px] text-ink-muted hover:border-brand/40 hover:text-brand disabled:opacity-30" title="记录当前卡片笔记"><NotebookPen size={14} />笔记</button>
          {isLastSlide && data?.resourceId ? (
            <button type="button" disabled={completing} onClick={() => setCompleteConfirmOpen(true)} className="flex h-10 items-center gap-1.5 rounded-full bg-brand px-5 text-[12px] font-medium text-paper disabled:opacity-50">{completing ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}完成学习</button>
          ) : (
            <button type="button" disabled={!readyNext} onClick={goNext} className="flex h-10 w-10 items-center justify-center rounded-full border border-hairline text-ink-muted disabled:opacity-30" title="下一页"><ChevronRight size={17} /></button>
          )}
        </div>
        {needsAssessment && (
          <div className="flex shrink-0 items-center gap-3 rounded-xl border border-hairline/60 bg-paper/60 px-3.5 py-2 backdrop-blur-sm transition-shadow duration-500">
            <div className="flex items-center gap-0.5">
              {[0, 0.25, 0.5, 1].map((score, i) => {
                const active = slideAssessments[currentIndex] != null && slideAssessments[currentIndex] >= score;
                const colors = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6'];
                return (
                  <button key={score} type="button" onClick={() => setSlideAssessments((prev) => ({ ...prev, [currentIndex]: score }))} className="group relative flex items-center justify-center" title={['还需学习', '基本理解', '大体掌握', '完全掌握'][i]}>
                    <div className={`h-3.5 w-5 transition-all duration-200 ${i === 0 ? 'rounded-l-full' : i === 3 ? 'rounded-r-full' : ''} ${active ? 'shadow-sm' : 'bg-ink-muted/15 hover:bg-ink-muted/25'}`} style={active ? { backgroundColor: colors[i] } : undefined} />
                  </button>
                );
              })}
            </div>
            <span className="text-[10px] font-medium text-ink-muted">
              {slideAssessments[currentIndex] == null ? '点击自评' : slideAssessments[currentIndex] === 0 ? '还需学习' : slideAssessments[currentIndex] === 0.25 ? '基本理解' : slideAssessments[currentIndex] === 0.5 ? '大体掌握' : '完全掌握'}
            </span>
          </div>
        )}
      </footer>
      <LearningCompleteDialog open={completeConfirmOpen} unassessedCount={unassessedCount} confirming={completing} restarting={restarting} onClose={() => setCompleteConfirmOpen(false)} onConfirm={() => void handleComplete()} onRestart={() => void handleRestart()} />
      {noteOpen && slide && (
        <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm" onClick={() => setNoteOpen(false)} role="dialog" aria-modal="true" aria-label="记录学习笔记">
          <div className="w-full max-w-[520px] rounded-[18px] border border-brand/30 bg-card-warm p-6 shadow-warm-lg" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-brand-tint text-brand"><NotebookPen size={17} /></span><div className="min-w-0"><h3 className="font-serif text-[18px] font-semibold text-ink">记录当前卡片</h3><p className="mt-0.5 truncate text-[11px] text-ink-muted">{slide.title}</p></div></div>
            <textarea autoFocus value={noteText} onChange={(event) => setNoteText(event.target.value)} rows={6} placeholder="用自己的话记下这一张卡片的要点……" className="mt-5 w-full resize-none rounded-[13px] border border-hairline bg-paper px-4 py-3 text-[13px] leading-6 text-ink outline-none placeholder:text-ink-muted/60 focus:border-brand/45" />
            <p className="mt-2 text-[10.5px] text-ink-muted">保存时会自动关联当前资源、卡片位置和本页引用。</p>
            <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setNoteOpen(false)} className="lf-btn-ghost">取消</button><button type="button" disabled={!noteText.trim()} onClick={saveCurrentNote} className="lf-btn-primary disabled:opacity-40">存入我的笔记</button></div>
          </div>
        </div>
      )}
    </main>
  );
}





