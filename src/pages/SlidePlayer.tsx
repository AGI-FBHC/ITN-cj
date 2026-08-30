import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, BookOpen, Check, ChevronLeft, ChevronRight, CircleAlert, ExternalLink, Loader2 } from 'lucide-react';
import { api, type CustomizeSlide, type CustomizeSlidesResponse } from '@/lib/api';
import SourceCitationMarks from '@/components/resources/SourceCitationMarks';
import { slideMdComponents } from '@/components/resources/lecture-markdown';
import remarkCitationMarks from '@/lib/remarkCitationMarks';
import { cn } from '@/lib/utils';
import { useProfile } from '@/context/ProfileContext';
import { fullLearningResourcePath, markLearningMapReturn } from '@/lib/learningNavigation';

type QuizValue = string | number;

function QuizCard({ slide }: { slide: CustomizeSlide }) {
  const question = slide.content as Record<string, unknown>;
  const rawOptions = Array.isArray(question.options) ? question.options : [];
  const options = rawOptions.map((option, index) => {
    if (typeof option === 'string') return { label: option, value: index };
    const item = option as Record<string, unknown>;
    return { label: String(item.text ?? item.label ?? item.content ?? ''), value: (item.value ?? item.id ?? index) as QuizValue };
  });
  const [picked, setPicked] = useState<QuizValue | null>(null);
  const correct = (question.correctAnswer ?? question.answer ?? question.correctIndex) as QuizValue | undefined;
  const correctIndex = typeof correct === 'string' && /^[A-Za-z]$/.test(correct)
    ? correct.toUpperCase().charCodeAt(0) - 65 : Number(correct);
  const pickedIndex = options.findIndex((option) => picked !== null && String(option.value) === String(picked));
  const isCorrect = picked !== null && (String(picked) === String(correct) || pickedIndex === correctIndex);
  return (
    <div className="mt-7">
      <h2 className="font-serif text-[25px] font-semibold leading-[1.45] text-ink md:text-[30px]">{String(question.stem ?? question.question ?? question.title ?? slide.title)}</h2>
      <div className="mt-6 grid gap-3">
        {options.map((option, index) => {
          const selected = picked !== null && String(picked) === String(option.value);
          const correctOption = picked !== null && (String(option.value) === String(correct) || index === correctIndex);
          return <button key={`${option.value}-${index}`} type="button" disabled={picked !== null} onClick={() => setPicked(option.value)} className={cn('flex items-start gap-3 rounded-[14px] border px-4 py-3.5 text-left text-[14px] leading-6', picked === null && 'border-hairline bg-paper hover:border-brand/45 hover:bg-brand-tint/30', selected && !isCorrect && 'border-brand-danger/40 bg-red-50', correctOption && 'border-brand/45 bg-brand-tint')}><span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-current font-mono text-[11px]">{String.fromCharCode(65 + index)}</span><span>{option.label}</span>{correctOption && <Check size={16} className="ml-auto mt-1 text-brand" />}</button>;
        })}
      </div>
      {picked !== null && <div className={cn('mt-5 rounded-[14px] border p-4 text-[13px] leading-6', isCorrect ? 'border-brand/30 bg-brand-tint/45 text-ink' : 'border-brand-amber/35 bg-brand-amber-tint/45 text-ink')}><strong>{isCorrect ? '回答正确' : '再看一下解析'}</strong>{question.explanation || question.analysis ? <p className="mt-1 text-ink-2">{String(question.explanation ?? question.analysis)}</p> : null}</div>}
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

export default function SlidePlayer() {
  const { taskId = '' } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { currentLearner } = useProfile();
  const [data, setData] = useState<CustomizeSlidesResponse | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [error, setError] = useState('');
  const [resourceSources, setResourceSources] = useState<Array<Record<string, unknown>>>([]);
  const cardScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
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
  }, [taskId]);

  const slides = data?.slides ?? [];
  useEffect(() => { if (slides.length && currentIndex >= slides.length) setCurrentIndex(slides.length - 1); }, [slides.length, currentIndex]);
  const slide = slides[currentIndex];
  useEffect(() => { cardScrollRef.current?.scrollTo({ top: 0 }); }, [currentIndex, slide?.index]);
  const readyNext = currentIndex + 1 < slides.length;
  const complete = data?.status === 'completed';
  const expected = useMemo(() => Math.max(data?.total ?? 0, slides.length), [data?.total, slides.length]);
  const returnResourceId = searchParams.get('returnResource');
  const leaveSlides = () => {
    if (returnResourceId) {
      navigate(fullLearningResourcePath(returnResourceId), { replace: true });
      return;
    }
    markLearningMapReturn(currentLearner.id);
    navigate('/learn');
  };
  useEffect(() => {
    if (!data?.resourceId) return;
    let alive = true;
    void api.getLearningResource(data.resourceId).then((resource) => {
      if (alive) setResourceSources((resource.sources ?? []) as Array<Record<string, unknown>>);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [data?.resourceId]);
  const pageSources = useMemo(() => {
    if (slide?.sources?.length) return slide.sources;
    const ids = citedSourceIds(slide);
    return ids.size
      ? resourceSources.filter((source, index) => ids.has(Number(source.id ?? index + 1)))
      : [];
  }, [slide, resourceSources]);

  return (
    <main className="mx-auto flex h-[calc(100dvh-72px)] min-h-0 w-full max-w-[1180px] flex-col overflow-hidden px-4 py-4 md:px-7 md:py-5">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-hairline pb-4">
        <button type="button" onClick={leaveSlides} className="inline-flex items-center gap-2 text-[12px] text-ink-muted hover:text-brand"><ArrowLeft size={15} />{returnResourceId ? '返回完整阅读' : '返回知识点'}</button>
        <div className="min-w-0 flex-1 text-center"><p className="truncate text-[13px] font-medium text-ink">{data?.title ?? '正在准备个性化学习内容'}</p><p className="mt-0.5 font-mono text-[10px] text-ink-muted">{slides.length ? `第 ${currentIndex + 1} 张 · 已就绪 ${slides.length}${expected ? ` / 预计 ${expected}` : ''}` : '等待首张卡片'}</p></div>
        <div className="flex min-w-[78px] justify-end">{complete && data?.resourceId && <button type="button" title="完整阅读模式" onClick={() => navigate(fullLearningResourcePath(data.resourceId), { replace: true })} className="rounded-lg border border-hairline p-2 text-ink-muted hover:border-brand/40 hover:text-brand"><ExternalLink size={15} /></button>}</div>
      </header>

      <section className="flex min-h-0 flex-1 items-stretch justify-center py-4 md:py-5">
        {!slide ? <div className="flex h-full w-full max-w-[880px] flex-col items-center justify-center rounded-[24px] border border-dashed border-brand/30 bg-card-warm px-6 text-center"><Loader2 size={25} className="animate-spin text-brand" /><h1 className="mt-4 font-serif text-[23px] font-semibold text-ink">正在准备第一张学习卡片</h1><p className="mt-2 max-w-md text-[12.5px] leading-6 text-ink-muted">第一章或第一个步骤完成后会立即显示，不必等待整项资源生成。</p>{error && <p className="mt-4 flex items-center gap-1.5 text-[11px] text-brand-danger"><CircleAlert size={13} />{error}</p>}</div>
          : <article className="flex h-full min-h-0 w-full max-w-[920px] flex-col overflow-hidden rounded-[24px] border border-brand/20 bg-card-warm shadow-warm-lg">
              <div className="flex shrink-0 items-center justify-between gap-4 border-b border-hairline/70 bg-paper/55 px-6 py-3.5 md:px-9"><span className="inline-flex rounded-full border border-brand/20 bg-brand-tint px-3 py-1 font-mono text-[10px] tracking-[0.1em] text-brand">{slide.type === 'question' ? '分阶练习' : slide.type === 'step' ? '实操步骤' : '领学章节'}</span>{data?.status === 'generating' && <span className="inline-flex items-center gap-1.5 text-[10.5px] text-ink-muted"><Loader2 size={12} className="animate-spin" />后续卡片生成中</span>}</div>
              <div ref={cardScrollRef} className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-6 pb-8 pt-5 [scrollbar-gutter:stable] md:px-9 md:pb-9 md:pt-6">
                {slide.type === 'question' ? <QuizCard key={slide.index} slide={slide} /> : <><h1 className="font-serif text-[28px] font-semibold leading-tight text-ink md:text-[34px]">{slide.title}</h1><div className="mt-6 h-1 w-14 rounded-full bg-brand" /><div className="mt-7 max-w-none text-ink-2"><ReactMarkdown remarkPlugins={[remarkGfm, remarkCitationMarks]} components={slideMdComponents}>{String(slide.content ?? '')}</ReactMarkdown></div></>}
                <SourceList sources={pageSources} evidenceQuotes={slide.evidenceQuotes} />
              </div>
            </article>}
      </section>

      <footer className="flex shrink-0 items-center justify-center gap-4 pb-2">
        <button type="button" disabled={currentIndex === 0} onClick={() => setCurrentIndex((value) => Math.max(0, value - 1))} className="inline-flex h-10 items-center gap-2 rounded-xl border border-hairline bg-paper px-4 text-[12px] text-ink disabled:cursor-not-allowed disabled:opacity-35"><ChevronLeft size={16} />上一张</button>
        <span className="min-w-[120px] text-center font-mono text-[10.5px] text-ink-muted">{slide ? `${currentIndex + 1} / ${slides.length}` : '0 / 0'}</span>
        <button type="button" disabled={!readyNext} onClick={() => setCurrentIndex((value) => Math.min(slides.length - 1, value + 1))} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand px-4 text-[12px] text-paper disabled:cursor-not-allowed disabled:bg-paper-deep disabled:text-ink-muted">{readyNext ? '下一张' : complete ? '已到最后' : '生成中'}<ChevronRight size={16} /></button>
      </footer>
      {complete && data?.resourceId && <div className="shrink-0 pb-1 pt-1 text-center"><button type="button" onClick={() => navigate(fullLearningResourcePath(data.resourceId), { replace: true })} className="inline-flex items-center gap-2 text-[12px] font-medium text-brand hover:underline"><BookOpen size={14} />切换为完整阅读模式</button></div>}
    </main>
  );
}
