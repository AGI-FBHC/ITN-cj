/**
 * PptPlayer - PPT content renderer with audio playback and page navigation.
 * The LearnUnit page provides the bottom player bar for appearance;
 * this component provides the actual slide content and playback controls.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { BookOpenCheck, Check, Lightbulb, Loader2, RefreshCw, X } from 'lucide-react';
import { fetchSlideAsset, presentationApi } from '@/lib/presentationApi';
import type { PresentationSlideshow, PresentationTask, PresentationTeachingMoment } from '@/lib/presentationApi';
import type { TtsSpeed } from '@/lib/api';
import { cn } from '@/lib/utils';
import { audioBus } from '@/lib/audioBus';

const SPEED_RATE: Record<TtsSpeed, number> = {
  very_slow: 0.75,
  slow: 0.85,
  normal: 1,
  fast: 1.15,
  very_fast: 1.3,
};

export interface PptPlayerRef {
  current: number;
  slideCount: number;
  audioPlaying: boolean;
  readonly audioLoaded: boolean;
  readonly audioLoading: boolean;
  goNext: () => void;
  goPrev: () => void;
  goTo: (index: number) => void;
  togglePlay: () => void;
  play: () => void;
  pause: () => void;
  restartPageAudio: () => void;
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

const PptPlayer = forwardRef<PptPlayerRef, { taskId: string; wideMode?: boolean; speed?: TtsSpeed; volume?: number; modelProvider?: 'mimo' | 'qwen'; qwenVoice?: string; onPlaybackChange?: (playing: boolean) => void;
  onLoadingChange?: (loading: boolean) => void; onSlideChange?: (current: number, count: number) => void; onRequestNote?: () => void }>(function PptPlayer({ taskId, speed = 'normal', volume = 1, modelProvider = 'mimo', qwenVoice = '', onPlaybackChange, onLoadingChange, onSlideChange, onRequestNote }, ref) {
  const [task, setTask] = useState<PresentationTask | null>(null);
  const [slides, setSlides] = useState<PresentationSlideshow | null>(null);
  const [current, setCurrent] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [slideSrc, setSlideSrc] = useState('');
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioSrc, setAudioSrc] = useState('');
  const [noteRevealCount, setNoteRevealCount] = useState<number | null>(null);
  const [activeMoment, setActiveMoment] = useState<PresentationTeachingMoment | null>(null);
  const [quizPick, setQuizPick] = useState<number | null>(null);
  const [mascotFrame, setMascotFrame] = useState('idle');
  const outlineConfirmedRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentRef = useRef(0);
  const audioSrcRef = useRef('');
  const audioLoadingRef = useRef<number | null>(null);
  const switchingSlideRef = useRef(false);
  const noteScrollRef = useRef<HTMLParagraphElement | null>(null);
  const triggeredMomentsRef = useRef(new Set<string>());
  currentRef.current = current;
  audioSrcRef.current = audioSrc;

  const slideCount = slides?.slideCount ?? 0;

  useEffect(() => { triggeredMomentsRef.current.clear(); }, [taskId]);

  useEffect(() => {
    // 音频正在加载/播放时，不打断当前页；仅切页/重开时才真正清空
    if (audioLoadingRef.current !== null) return;
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    if (audioSrcRef.current) URL.revokeObjectURL(audioSrcRef.current);
    audioSrcRef.current = '';
    setAudioSrc('');
    setAudioPlaying(false);
    onPlaybackChange?.(false);
  }, [modelProvider, qwenVoice, onPlaybackChange]);

  useEffect(() => onSlideChange?.(current, slideCount), [current, slideCount, onSlideChange]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.playbackRate = SPEED_RATE[speed];
  }, [speed]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.volume = volume;
  }, [volume]);

  const playAudio = async (index: number, retried = false) => {
    const audio = audioRef.current;
    if (!audio) return;
    // 防抖：同一页音频已在加载/播放中，忽略重复触发，避免重复请求
    if (audioLoadingRef.current === index && !retried) {
      return;
    }
    audioLoadingRef.current = index;
    setAudioLoading(true);
    onLoadingChange?.(true);
    try {
      if (!audioSrcRef.current) {
        const blob = await fetchSlideAsset(taskId, index, 'audio', modelProvider, qwenVoice);
        const url = URL.createObjectURL(blob);
        setAudioSrc(url);
        audioSrcRef.current = url;
        audio.src = url;
      }
      audioBus.stopAll();
      audio.playbackRate = SPEED_RATE[speed];
      audio.volume = volume;
      await audio.play();
      switchingSlideRef.current = false;
      if (audio.currentTime < 0.1) setNoteRevealCount(0);
      setAudioPlaying(true);
      onPlaybackChange?.(true);
    } catch (reason) {
      // 首次 play() 常因元素被清理/中断失败（AbortError），自动重试一次
      if (!retried && reason instanceof DOMException && reason.name === 'AbortError') {
        try {
          await audio.play();
          switchingSlideRef.current = false;
          setAudioPlaying(true);
          onPlaybackChange?.(true);
          return;
        } catch (retryReason) {
          switchingSlideRef.current = false;
          setAudioPlaying(false);
          onPlaybackChange?.(false);
          setError(retryReason instanceof Error ? `音频加载失败：${retryReason.message}` : '音频暂不可用');
          return;
        }
      }
      switchingSlideRef.current = false;
      setAudioPlaying(false);
      onPlaybackChange?.(false);
      setError(reason instanceof Error ? `音频加载失败：${reason.message}` : '音频暂不可用');
    } finally {
      audioLoadingRef.current = null;
      setAudioLoading(false);
      onLoadingChange?.(false);
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
  };

  const goNext = () => goTo(currentRef.current + 1, audioPlaying);
  const goPrev = () => goTo(currentRef.current - 1, audioPlaying);

  const restartPageAudio = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    if (audioSrcRef.current) {
      URL.revokeObjectURL(audioSrcRef.current);
      audioSrcRef.current = '';
      setAudioSrc('');
    }
    audio.removeAttribute('src');
    audio.load();
    void playAudio(currentRef.current);
  };

  useEffect(() => {
    const release = audioBus.register('lecture', () => {
      const audio = audioRef.current;
      if (audio && !audio.paused) audio.pause();
      setAudioPlaying(false);
      onPlaybackChange?.(false);
    });
    return release;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    get current() { return currentRef.current; },
    get slideCount() { return slideCount; },
    get audioPlaying() { return audioPlaying; },
    get audioLoaded() { return Boolean(audioSrcRef.current); },
    get audioLoading() { return audioLoading; },
    goNext,
    goPrev,
    goTo,
    togglePlay,
    play: () => { if (!audioPlaying) void playAudio(currentRef.current); },
    pause: () => { if (audioPlaying) togglePlay(); },
    restartPageAudio,
  }), [slideCount, audioPlaying, audioLoading, speed, volume]);

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
    let consecutiveErrors = 0;
    const poll = async () => {
      let next;
      try {
        next = await presentationApi.getPresentation(taskId);
        consecutiveErrors = 0;
      } catch (reason) {
        // 网络抖动/服务暂不可用时不清 loading、不中断轮询，退避重试
        if (cancelled) return;
        consecutiveErrors += 1;
        if (consecutiveErrors >= 5) {
          if (!cancelled) { setError(reason instanceof Error ? reason.message : 'PPT 任务读取失败'); setLoading(false); }
          return;
        }
        timer = window.setTimeout(poll, Math.min(3000 * consecutiveErrors, 12000));
        return;
      }
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
    if (audioLoadingRef.current !== null) return;
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    if (!switchingSlideRef.current) setAudioPlaying(false);
    setNoteRevealCount(0);
    setActiveMoment(null);
    setQuizPick(null);
    if (!switchingSlideRef.current) onPlaybackChange?.(false);
    setAudioSrc((prev) => { if (prev) URL.revokeObjectURL(prev); return ''; });
    audioSrcRef.current = '';
    // Start the next narration as soon as React has committed the new page.
    // This removes the old fixed 700 ms pause while keeping the playing state
    // stable, so the global control does not flash from pause to play.
    if (switchingSlideRef.current) void playAudio(current);
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

  // 讲稿字幕实时滚动：可见文本每次变化都滚到最新处（含首次展开整页讲稿）
  useEffect(() => {
    if (noteRevealCount === null) return;
    const frame = window.requestAnimationFrame(() => {
      const element = noteScrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [noteRevealCount, visibleNote]);

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
    const inProgress = Boolean(task && task.status !== 'completed');
    const slidesLoading = Boolean(loading && !inProgress);
    if (inProgress || slidesLoading) {
      return (
        <div className="mt-4 flex flex-col items-center justify-center py-12 text-center">
          <Loader2 size={24} className="animate-spin text-brand" />
          <p className="mt-3 text-[13.5px] font-medium text-ink">{slidesLoading ? '正在加载幻灯片…' : (task?.stageMessage || 'PPT 正在后台生成')}</p>
          <p className="mt-1 text-[12px] text-ink-muted">{slidesLoading ? '页面马上就好' : '生成完成后会自动进入播放页'}</p>
          {inProgress && (
            <div className="mt-3 flex items-center gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <span key={i} className={cn('h-1.5 w-10 rounded-full', (task?.progress ?? 0) >= (i + 1) * 20 ? 'bg-brand' : 'bg-paper-deep')} />
              ))}
            </div>
          )}
        </div>
      );
    }
    return <div className="mt-4 py-10 text-center text-[13px] text-ink-muted">这份 PPT 暂时没有可播放的页面。</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center">
      <div className="lf-anim-in-up mx-auto w-full max-w-[min(100%,calc((100dvh-420px)*16/9),1080px)] overflow-hidden rounded-[22px] border border-hairline bg-paper shadow-[0_24px_70px_rgba(35,52,43,0.13)] md:w-[min(100%,calc((100dvh-420px)*16/9))]">
        <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden p-2 md:p-3">
          {slideSrc ? (
            <img
              src={slideSrc}
              alt={`第 ${current + 1} 页`}
              className={cn(
                'w-auto max-w-full rounded-md object-contain shadow-sm transition-[max-height] duration-300',
                'h-full max-h-full',
              )}
            />
          ) : (
            <div className="flex min-h-[34vh] items-center justify-center"><Loader2 size={22} className="animate-spin text-brand" /></div>
          )}
        </div>

                <aside className="flex h-[132px] min-h-[132px] w-full items-center overflow-hidden border-t border-hairline bg-card-warm/45 p-4 backdrop-blur-xl md:px-5">
          <div className="flex w-full items-start gap-4">
            <div className="flex w-[88px] shrink-0 flex-col items-center border-r border-hairline/70 pr-4">
              <img src={`/mascot/xiaoyuanlong-${mascotFrame}.png`} alt="正在讲解的伴学助手" className="h-16 w-16 -scale-x-100 object-contain drop-shadow-[0_8px_14px_rgba(44,63,52,0.16)]" />
              <span className="mt-1 whitespace-nowrap text-[10px] font-medium text-ink-muted">{audioPlaying ? '正在讲解' : '准备开讲'}</span>
            </div>
            <div ref={noteScrollRef} className="min-w-0 flex-1 overflow-y-auto pr-2 text-[13.5px] leading-6 text-ink-2" aria-live="off">{visibleNote ? <p className="whitespace-pre-wrap">{visibleNote}<span className={cn('ml-0.5 inline-block h-[1em] w-[2px] align-[-0.12em] bg-brand', audioPlaying && 'animate-pulse')} aria-hidden /></p> : <p className="pt-5 text-ink-muted">准备开始</p>}</div>
          </div>
        </aside>

      </div>

      {/* 课堂检查点 / AI 总结：居中弹窗，不占用底部讲稿栏 */}
      {activeMoment && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[#17231E]/35 p-5 backdrop-blur-[3px]" onClick={activeMoment.type === 'summary' ? continueMoment : undefined}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="moment-title"
            className="w-full max-w-[440px] overflow-hidden rounded-[24px] border border-white/80 bg-[#FCFDF9]/95 shadow-[0_28px_80px_rgba(28,45,36,0.24)] backdrop-blur-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex items-start gap-3 border-b border-[#E7EAE4] px-5 pb-3.5 pt-5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#E8F0EA] text-[#426A54]">
                {activeMoment.type === 'quiz' ? <BookOpenCheck size={19} /> : <Lightbulb size={19} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="mb-0.5 font-mono text-[10px] font-semibold tracking-[0.16em] text-[#7A877F]">
                  {activeMoment.type === 'quiz' ? '课堂检查点' : 'AI 总结'}
                </p>
                <h3 id="moment-title" className="text-[17px] font-semibold leading-snug text-[#24332B]">{activeMoment.title}</h3>
              </div>
              {activeMoment.type === 'summary' && (
                <button type="button" onClick={continueMoment} aria-label="关闭" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#748078] transition hover:bg-[#EDF0EB] hover:text-[#24332B]">
                  <X size={16} />
                </button>
              )}
            </header>

            <div className="max-h-[50dvh] overflow-y-auto px-5 py-4">
              {activeMoment.type === 'quiz' ? (
                <>
                  <p className="text-[13px] leading-5 text-[#3D4E44]">{activeMoment.prompt}</p>
                  <div className="mt-3 space-y-2">
                    {(activeMoment.options ?? []).map((option, index) => {
                      const correct = index === activeMoment.answerIndex;
                      const picked = quizPick === index;
                      return (
                        <button key={option} type="button" disabled={quizPick !== null} onClick={() => answerMoment(index)} className={cn('flex w-full items-start gap-2.5 rounded-[12px] border px-3 py-2.5 text-left text-[13px] leading-5 transition active:scale-[0.98]', quizPick === null && 'border-[#DDE4DC] bg-white hover:border-[#AFC3B5]', quizPick !== null && correct && 'border-[#4E7860]/50 bg-[#4E7860]/10 text-[#2D5A3D]', picked && !correct && 'border-[#B0483B]/40 bg-[#B0483B]/5 text-[#B0483B]')}>
                          <span className="font-mono text-[12px] text-[#7A877F]">{String.fromCharCode(65 + index)}</span>
                          <span className="min-w-0 flex-1">{option}</span>
                          {quizPick !== null && correct && <Check size={14} className="mt-0.5 shrink-0 text-[#4E7860]" />}
                        </button>
                      );
                    })}
                  </div>
                  {quizPick !== null && (
                    <p className="mt-3 rounded-[10px] bg-[#F3F8F5] px-3 py-2 text-[12px] leading-5 text-[#4E7860]">
                      {quizPick === activeMoment.answerIndex ? '回答正确。' : '这里容易混淆。'}{activeMoment.explanation}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <ul className="space-y-2.5 text-[13px] leading-6 text-[#3D4E44]">
                    {(activeMoment.points ?? []).map((point) => (
                      <li key={point} className="flex gap-2.5"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#4E7860]" />{point}</li>
                    ))}
                  </ul>
                  <p className="mt-4 text-[12px] leading-5 text-[#7A877F]">{activeMoment.notePrompt || '需要把这一节的关键点记下来吗？'}</p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" onClick={onRequestNote} className="flex-1 rounded-[10px] bg-[#426A54] px-3 py-2 text-[12.5px] font-medium text-white transition active:scale-[0.98]">记个笔记</button>
                    <button type="button" onClick={continueMoment} className="rounded-[10px] border border-[#DDE4DC] bg-white px-4 py-2 text-[12.5px] text-[#3D4E44] transition active:scale-[0.98]">继续</button>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      )}

      <audio ref={audioRef} onPlay={() => { switchingSlideRef.current = false; setAudioPlaying(true); onPlaybackChange?.(true); }} onPause={() => { if (!switchingSlideRef.current) { setAudioPlaying(false); onPlaybackChange?.(false); } }} onTimeUpdate={syncNoteToAudio} onEnded={handleAudioEnded} className="hidden" preload="none" />
    </div>
  );
});

export default PptPlayer;
