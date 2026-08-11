/**
 * PptPlayer - PPT content renderer with audio playback and page navigation.
 * The LearnUnit page provides the bottom player bar for appearance;
 * this component provides the actual slide content and playback controls.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { BookOpenCheck, Check, FileText, Lightbulb, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { fetchSlideAsset, presentationApi } from '@/lib/presentationApi';
import type { PresentationSlideshow, PresentationTask, PresentationTeachingMoment } from '@/lib/presentationApi';
import { cn } from '@/lib/utils';

export interface PptPlayerRef {
  current: number;
  slideCount: number;
  audioPlaying: boolean;
  goNext: () => void;
  goPrev: () => void;
  goTo: (index: number) => void;
  togglePlay: () => void;
  play: () => void;
  pause: () => void;
}

const PROGRESS_LABEL: Record<PresentationTask['status'], string> = {
  queued: '排队中',
  analyzing: '正在分析主题',
  outline_review: '提纲已生成',
  generating: '正在生成 PPT',
  reviewing: '正在质量审核',
  completed: '已完成',
  failed: '生成失败',
  cancelled: '已取消',
};

const PptPlayer = forwardRef<PptPlayerRef, { taskId: string; wideMode?: boolean; onPlaybackChange?: (playing: boolean) => void; onSlideChange?: (current: number, count: number) => void; onRequestNote?: () => void }>(function PptPlayer({ taskId, wideMode = true, onPlaybackChange, onSlideChange, onRequestNote }, ref) {
  const [task, setTask] = useState<PresentationTask | null>(null);
  const [slides, setSlides] = useState<PresentationSlideshow | null>(null);
  const [current, setCurrent] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [slideSrc, setSlideSrc] = useState('');
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioSrc, setAudioSrc] = useState('');
  const [noteRevealCount, setNoteRevealCount] = useState<number | null>(null);
  const [activeMoment, setActiveMoment] = useState<PresentationTeachingMoment | null>(null);
  const [quizPick, setQuizPick] = useState<number | null>(null);
  const [mascotFrame, setMascotFrame] = useState('idle');
  const outlineConfirmedRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentRef = useRef(0);
  const audioSrcRef = useRef('');
  const switchingSlideRef = useRef(false);
  const noteScrollRef = useRef<HTMLParagraphElement | null>(null);
  const triggeredMomentsRef = useRef(new Set<string>());
  currentRef.current = current;
  audioSrcRef.current = audioSrc;

  const slideCount = slides?.slideCount ?? 0;

  useEffect(() => { triggeredMomentsRef.current.clear(); }, [taskId]);

  useEffect(() => onSlideChange?.(current, slideCount), [current, slideCount, onSlideChange]);

  const playAudio = async (index: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      if (!audioSrcRef.current) {
        const blob = await fetchSlideAsset(taskId, index, 'audio');
        const url = URL.createObjectURL(blob);
        setAudioSrc(url);
        audioSrcRef.current = url;
        audio.src = url;
      }
      await audio.play();
      switchingSlideRef.current = false;
      if (audio.currentTime < 0.1) setNoteRevealCount(0);
      setAudioPlaying(true);
      onPlaybackChange?.(true);
    } catch (reason) {
      switchingSlideRef.current = false;
      setAudioPlaying(false);
      onPlaybackChange?.(false);
      setError(reason instanceof Error ? `音频加载失败：${reason.message}` : '音频暂不可用');
    }
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audioPlaying) { audio.pause(); setAudioPlaying(false); onPlaybackChange?.(false); }
    else void playAudio(currentRef.current);
  };

  const goTo = (index: number, continuePlaying = false) => {
    if (index < 0 || index >= slideCount) return;
    if (index === currentRef.current) { if (continuePlaying) void playAudio(index); return; }
    switchingSlideRef.current = continuePlaying;
    setCurrent(index);
    if (continuePlaying) window.setTimeout(() => void playAudio(index), 700);
  };

  const goNext = () => goTo(currentRef.current + 1, audioPlaying);
  const goPrev = () => goTo(currentRef.current - 1, audioPlaying);

  useImperativeHandle(ref, () => ({
    get current() { return currentRef.current; },
    get slideCount() { return slideCount; },
    get audioPlaying() { return audioPlaying; },
    goNext,
    goPrev,
    goTo,
    togglePlay,
    play: () => { if (!audioPlaying) void playAudio(currentRef.current); },
    pause: () => { if (audioPlaying) togglePlay(); },
  }), [slideCount, audioPlaying]);

  const loadTask = useCallback(async () => {
    try {
      const next = await presentationApi.getPresentation(taskId);
      setTask(next);
      if (next.status === 'outline_review' && !outlineConfirmedRef.current) {
        outlineConfirmedRef.current = true;
        try { await presentationApi.startPresentationGeneration(taskId); } catch { /* ignore */ }
        setLoading(true);
      }
      if (next.status === 'completed') {
        const meta = await presentationApi.getSlideshowSlides(taskId);
        setSlides(meta);
        setCurrent(0);
        setLoading(false);
      } else if (next.status === 'failed' || next.status === 'cancelled') {
        setError(next.errorMessage || PROGRESS_LABEL[next.status]);
        setLoading(false);
      } else {
        setLoading(true);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'PPT 任务读取失败');
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      const next = await presentationApi.getPresentation(taskId);
      if (cancelled) return;
      setTask(next);
      if (next.status === 'outline_review' && !outlineConfirmedRef.current) {
        outlineConfirmedRef.current = true;
        try { await presentationApi.startPresentationGeneration(taskId); } catch { /* ignore */ }
      }
      if (next.status === 'completed') {
        try {
          const meta = await presentationApi.getSlideshowSlides(taskId);
          if (!cancelled) { setSlides(meta); setCurrent(0); setLoading(false); }
        } catch { if (!cancelled) { setError('幻灯片读取失败'); setLoading(false); } }
        return;
      }
      if (next.status === 'failed' || next.status === 'cancelled') {
        if (!cancelled) { setError(next.errorMessage || PROGRESS_LABEL[next.status]); setLoading(false); }
        return;
      }
      if (!cancelled) setLoading(true);
      timer = window.setTimeout(poll, 3000);
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [taskId]);

  const handleAudioEnded = () => {
    setNoteRevealCount(note.length);
    if (currentRef.current < slideCount - 1) goTo(currentRef.current + 1, true);
    else { setAudioPlaying(false); onPlaybackChange?.(false); }
  };

  const syncNoteToAudio = () => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0 || !note) return;
    const progress = Math.min(1, Math.max(0, audio.currentTime / audio.duration));
    setNoteRevealCount(Math.min(note.length, Math.ceil(note.length * progress)));
    const moments = slides?.teachingMoments?.[currentRef.current] ?? [];
    const momentIndex = moments.findIndex((moment) => (
      !triggeredMomentsRef.current.has(moment.momentId) && progress >= moment.anchorRatio
    ));
    if (momentIndex >= 0) {
      const moment = moments[momentIndex];
      triggeredMomentsRef.current.add(moment.momentId);
      switchingSlideRef.current = false;
      audio.pause();
      setAudioPlaying(false);
      onPlaybackChange?.(false);
      setQuizPick(null);
      setActiveMoment(moment);
    }
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    if (!switchingSlideRef.current) setAudioPlaying(false);
    setNoteRevealCount(0);
    setActiveMoment(null);
    setQuizPick(null);
    if (!switchingSlideRef.current) onPlaybackChange?.(false);
    setAudioSrc((prev) => { if (prev) URL.revokeObjectURL(prev); return ''; });
    audioSrcRef.current = '';
  }, [current]);

  useEffect(() => {
    if (!slides || slides.slideCount === 0) return;
    let cancelled = false;
    let objectUrl = '';
    fetchSlideAsset(taskId, current, 'slides')
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSlideSrc((prev) => { if (prev) URL.revokeObjectURL(prev); return objectUrl; });
      })
      .catch(() => { if (!cancelled) setError('幻灯片图片加载失败'); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [taskId, current, slides]);
  const note = slides?.speakerNotes[current] ?? '';
  const visibleNote = note.slice(0, noteRevealCount ?? 0);

  useEffect(() => {
    const frames = audioPlaying ? ['speak-1', 'speak-2'] : ['idle', 'breathe', 'idle'];
    let index = 0;
    setMascotFrame(frames[0]);
    const timer = window.setInterval(() => { index = (index + 1) % frames.length; setMascotFrame(frames[index]); }, audioPlaying ? 300 : 900);
    return () => window.clearInterval(timer);
  }, [audioPlaying]);

  const continueMoment = () => {
    setActiveMoment(null);
    setQuizPick(null);
    void playAudio(currentRef.current);
  };

  const answerMoment = (index: number) => {
    if (!activeMoment || activeMoment.type !== 'quiz' || quizPick !== null) return;
    setQuizPick(index);
    window.setTimeout(continueMoment, 1100);
  };

  useEffect(() => {
    if (!audioPlaying || noteRevealCount === null) return;
    const frame = window.requestAnimationFrame(() => {
      const element = noteScrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [audioPlaying, noteRevealCount]);

  if (!task && loading) {
    return (
      <div className="mt-4 flex flex-col items-center justify-center py-12 text-center">
        <Loader2 size={24} className="animate-spin text-brand" />
        <p className="mt-3 text-[13px] text-ink-muted">正在读取 PPT 任务…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-4 rounded-[14px] border border-red-200 bg-red-50 px-5 py-4 text-[13.5px] text-red-700">
        <p className="font-medium">PPT 生成暂时不可用</p>
        <p className="mt-1">{error}</p>
        <button type="button" onClick={() => { setError(''); setLoading(true); void loadTask(); }} className="lf-btn-primary mt-3 !py-2">
          <RefreshCw size={13} /> 重试
        </button>
      </div>
    );
  }

  if (!slides || slideCount === 0) {
    if (task && task.status !== 'completed') {
      return (
        <div className="mt-4 flex flex-col items-center justify-center py-12 text-center">
          <Loader2 size={24} className="animate-spin text-brand" />
          <p className="mt-3 text-[13.5px] font-medium text-ink">{task.stageMessage || 'PPT 正在后台生成'}</p>
          <p className="mt-1 text-[12px] text-ink-muted">生成完成后会自动进入播放页</p>
          <div className="mt-3 flex items-center gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <span key={i} className={cn('h-1.5 w-10 rounded-full', (task.progress ?? 0) >= (i + 1) * 20 ? 'bg-brand' : 'bg-paper-deep')} />
            ))}
          </div>
        </div>
      );
    }
    return <div className="mt-4 py-10 text-center text-[13px] text-ink-muted">这份 PPT 暂时没有可播放的页面。</div>;
  }

  return (
    <div className="space-y-3">
      <div className={cn(
        'lf-anim-in-up grid items-stretch gap-3',
        wideMode ? 'xl:grid-cols-[220px_minmax(0,1fr)_240px]' : 'grid-cols-1',
      )}>
        <aside className={cn(
          'order-2 flex min-h-[190px] flex-col overflow-hidden rounded-[20px] border border-white/55 bg-card-warm/45 p-4 shadow-[0_18px_54px_rgba(44,63,52,0.09)] backdrop-blur-xl xl:order-1',
          !wideMode && 'mx-auto w-full max-w-[760px]',
        )}>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand/10 text-brand"><Sparkles size={13} /></span>
            <div><div className="text-[12.5px] font-semibold text-ink">AI 导师</div><div className="font-mono text-[9px] text-ink-muted">LIVE NARRATION</div></div>
          </div>
          <div ref={noteScrollRef} className="mt-3 max-h-[min(58vh,560px)] flex-1 overflow-y-auto pr-1 text-[13.5px] leading-6 text-ink-2" aria-live="off">
            {visibleNote ? <p className="whitespace-pre-wrap">{visibleNote}<span className={cn('ml-0.5 inline-block h-[1em] w-[2px] align-[-0.12em] bg-brand', audioPlaying && 'animate-pulse')} aria-hidden /></p> : (
              <div className="flex h-full min-h-[130px] flex-col items-center justify-center text-center text-ink-muted/70">
                <FileText size={18} /><span className="mt-2 text-[11.5px]">开始播放后，导师讲到哪里<br />文字就出现到哪里</span>
              </div>
            )}
          </div>
        </aside>

        <div className={cn(
          'order-1 flex items-center justify-center rounded-[18px] border border-hairline bg-paper shadow-warm-lg xl:order-2',
          wideMode ? 'p-2' : 'mx-auto w-full max-w-[760px] p-3 md:p-4',
        )}>
          {slideSrc ? (
            <img
              src={slideSrc}
              alt={`第 ${current + 1} 页`}
              className={cn(
                'w-auto max-w-full rounded-md object-contain shadow-sm transition-[max-height] duration-300',
                wideMode ? 'max-h-[min(68vh,calc(100dvh-220px))]' : 'max-h-[52vh]',
              )}
            />
          ) : (
            <div className="flex min-h-[34vh] items-center justify-center"><Loader2 size={22} className="animate-spin text-brand" /></div>
          )}
        </div>

        <aside className={cn(
          'order-3 flex min-h-[190px] overflow-hidden rounded-[20px] border border-white/55 bg-card-warm/48 p-4 shadow-[0_18px_54px_rgba(44,63,52,0.09)] backdrop-blur-xl',
          !wideMode && 'mx-auto w-full max-w-[760px]',
        )}>
          {activeMoment?.type === 'quiz' ? (
            <div className="w-full">
              <div className="flex items-center gap-2 text-brand"><BookOpenCheck size={15} /><span className="font-mono text-[9.5px] tracking-wide">课堂检查点</span></div>
              <h3 className="mt-2 text-[14px] font-semibold leading-5 text-ink">{activeMoment.title}</h3>
              <p className="mt-2 text-[12px] leading-5 text-ink-2">{activeMoment.prompt}</p>
              <div className="mt-3 space-y-1.5">
                {(activeMoment.options ?? []).map((option, index) => {
                  const correct = index === activeMoment.answerIndex;
                  const picked = quizPick === index;
                  return <button key={option} type="button" disabled={quizPick !== null} onClick={() => answerMoment(index)} className={cn('flex w-full items-start gap-2 rounded-[10px] border px-2.5 py-2 text-left text-[11.5px] leading-4 transition active:scale-[0.98]', quizPick === null && 'border-hairline bg-paper/75 hover:border-brand/40', quizPick !== null && correct && 'border-brand/45 bg-brand-tint text-brand', picked && !correct && 'border-brand-danger/40 bg-brand-danger/5 text-brand-danger')}><span className="font-mono">{String.fromCharCode(65 + index)}</span><span>{option}</span>{quizPick !== null && correct && <Check size={12} className="ml-auto mt-0.5 shrink-0" />}</button>;
                })}
              </div>
              {quizPick !== null && <p className="mt-2 text-[10.5px] leading-4 text-ink-muted">{quizPick === activeMoment.answerIndex ? '回答正确。' : '这里容易混淆。'}{activeMoment.explanation}</p>}
            </div>
          ) : activeMoment?.type === 'summary' ? (
            <div className="flex w-full flex-col">
              <div className="flex items-center gap-2 text-brand"><Lightbulb size={15} /><span className="font-mono text-[9.5px] tracking-wide">AI 总结</span></div>
              <h3 className="mt-2 text-[14px] font-semibold leading-5 text-ink">{activeMoment.title}</h3>
              <ul className="mt-3 space-y-2 text-[12px] leading-5 text-ink-2">{(activeMoment.points ?? []).map((point) => <li key={point} className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />{point}</li>)}</ul>
              <div className="mt-auto pt-4"><p className="text-[10.5px] leading-4 text-ink-muted">{activeMoment.notePrompt || '需要把这一节的关键点记下来吗？'}</p><div className="mt-2 flex gap-2"><button type="button" onClick={onRequestNote} className="flex-1 rounded-[9px] bg-brand px-2 py-2 text-[11.5px] font-medium text-paper active:scale-[0.98]">记个笔记</button><button type="button" onClick={continueMoment} className="rounded-[9px] border border-hairline bg-paper/75 px-3 py-2 text-[11.5px] text-ink-2 active:scale-[0.98]">继续</button></div></div>
            </div>
          ) : (
            <div className="flex w-full flex-col items-center justify-center text-center">
              <img src={`/mascot/xiaoyuanlong-${mascotFrame}.png`} alt="正在陪你上课的小鼋龙" className="max-h-[190px] w-full object-contain drop-shadow-[0_12px_22px_rgba(44,63,52,0.14)]" />
              <p className="mt-1 text-[11.5px] font-medium text-ink-2">{audioPlaying ? '小鼋龙正在陪 AI 导师讲课' : '准备好了，随时可以开始'}</p>
            </div>
          )}
        </aside>
      </div>
      <audio ref={audioRef} onPlay={() => { switchingSlideRef.current = false; setAudioPlaying(true); onPlaybackChange?.(true); }} onPause={() => { if (!switchingSlideRef.current) { setAudioPlaying(false); onPlaybackChange?.(false); } }} onTimeUpdate={syncNoteToAudio} onEnded={handleAudioEnded} className="hidden" preload="none" />
    </div>
  );
});

export default PptPlayer;
