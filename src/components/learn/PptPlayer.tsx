/**
 * PptPlayer - PPT content renderer with audio playback and page navigation.
 * The LearnUnit page provides the bottom player bar for appearance;
 * this component provides the actual slide content and playback controls.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileText, Loader2, Pause, Play, RefreshCw } from 'lucide-react';
import { fetchSlideAsset, presentationApi } from '@/lib/presentationApi';
import type { PresentationSlideshow, PresentationTask } from '@/lib/presentationApi';
import { cn } from '@/lib/utils';

export interface PptPlayerRef {
  current: number;
  slideCount: number;
  audioPlaying: boolean;
  goNext: () => void;
  goPrev: () => void;
  goTo: (index: number) => void;
  togglePlay: () => void;
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

const PptPlayer = forwardRef<PptPlayerRef, { taskId: string }>(function PptPlayer({ taskId }, ref) {
  const [task, setTask] = useState<PresentationTask | null>(null);
  const [slides, setSlides] = useState<PresentationSlideshow | null>(null);
  const [current, setCurrent] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [slideSrc, setSlideSrc] = useState('');
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioSrc, setAudioSrc] = useState('');
  const outlineConfirmedRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentRef = useRef(0);
  const audioSrcRef = useRef('');
  currentRef.current = current;
  audioSrcRef.current = audioSrc;

  const slideCount = slides?.slideCount ?? 0;

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
      setAudioPlaying(true);
    } catch (reason) {
      setError(reason instanceof Error ? `音频加载失败：${reason.message}` : '音频暂不可用');
    }
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audioPlaying) { audio.pause(); setAudioPlaying(false); }
    else void playAudio(currentRef.current);
  };

  const goTo = (index: number, continuePlaying = false) => {
    if (index < 0 || index >= slideCount) return;
    if (index === currentRef.current) { if (continuePlaying) void playAudio(index); return; }
    setCurrent(index);
    if (continuePlaying) window.setTimeout(() => void playAudio(index), 700);
  };

  const goNext = () => goTo(currentRef.current + 1);
  const goPrev = () => goTo(currentRef.current - 1);

  useImperativeHandle(ref, () => ({
    get current() { return currentRef.current; },
    get slideCount() { return slideCount; },
    get audioPlaying() { return audioPlaying; },
    goNext,
    goPrev,
    goTo,
    togglePlay,
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
    if (currentRef.current < slideCount - 1) goTo(currentRef.current + 1, true);
    else setAudioPlaying(false);
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    setAudioPlaying(false);
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
    <div className="space-y-4">
      <div className="lf-anim-in-up rounded-[18px] border border-hairline bg-paper p-7 shadow-warm-lg md:p-10">
        <div className="flex items-center justify-center gap-4">
          <button type="button" disabled={current <= 0} onClick={goPrev} className="flex h-9 w-9 items-center justify-center rounded-full border border-hairline text-ink-muted transition hover:border-brand/40 hover:text-brand disabled:opacity-25" title="上一页"><ChevronLeft size={18} /></button>
          {slideSrc ? (
            <img src={slideSrc} alt={`第 ${current + 1} 页`} className="max-h-[58vh] w-auto max-w-full rounded-md object-contain shadow-sm" />
          ) : (
            <div className="flex min-h-[40vh] items-center justify-center"><Loader2 size={22} className="animate-spin text-brand" /></div>
          )}
          <button type="button" disabled={current >= slideCount - 1} onClick={goNext} className="flex h-9 w-9 items-center justify-center rounded-full border border-hairline text-ink-muted transition hover:border-brand/40 hover:text-brand disabled:opacity-25" title="下一页"><ChevronRight size={18} /></button>
        </div>
        {slideCount > 1 && (
          <div className="mt-3 flex items-center justify-center gap-3">
            <button type="button" onClick={togglePlay} className="flex h-9 items-center gap-1.5 rounded-full bg-brand px-5 text-[12.5px] font-medium text-paper transition hover:bg-brand-hover" title={audioPlaying ? '暂停' : '语音授课'}>
              {audioPlaying ? <Pause size={14} /> : <Play size={14} fill="currentColor" />}
              {audioPlaying ? '暂停' : '语音授课'}
            </button>
            <span className="font-mono text-[11px] text-ink-muted">{current + 1} / {slideCount}</span>
          </div>
        )}
        {note && (
          <div className="mt-6 border-t border-hairline pt-5">
            <div className="flex items-center gap-2">
              <FileText size={14} className="text-brand" />
              <span className="lf-mono-label !text-[10px]">本页讲稿</span>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-[15px] leading-[28px] text-ink-2">{note}</p>
          </div>
        )}
      </div>
      <audio ref={audioRef} onPlay={() => setAudioPlaying(true)} onPause={() => setAudioPlaying(false)} onEnded={handleAudioEnded} className="hidden" preload="none" />
    </div>
  );
});

export default PptPlayer;
