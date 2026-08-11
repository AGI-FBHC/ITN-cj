/**
 * PptPlayer - PPT content renderer with audio playback and page navigation.
 * The LearnUnit page provides the bottom player bar for appearance;
 * this component provides the actual slide content and playback controls.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { FileText, Loader2, RefreshCw } from 'lucide-react';
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

const PptPlayer = forwardRef<PptPlayerRef, { taskId: string; wideMode?: boolean; onPlaybackChange?: (playing: boolean) => void; onSlideChange?: (current: number, count: number) => void }>(function PptPlayer({ taskId, wideMode = true, onPlaybackChange, onSlideChange }, ref) {
  const [task, setTask] = useState<PresentationTask | null>(null);
  const [slides, setSlides] = useState<PresentationSlideshow | null>(null);
  const [current, setCurrent] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [slideSrc, setSlideSrc] = useState('');
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioSrc, setAudioSrc] = useState('');
  const [noteRevealCount, setNoteRevealCount] = useState<number | null>(null);
  const outlineConfirmedRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentRef = useRef(0);
  const audioSrcRef = useRef('');
  const switchingSlideRef = useRef(false);
  const noteScrollRef = useRef<HTMLParagraphElement | null>(null);
  currentRef.current = current;
  audioSrcRef.current = audioSrc;

  const slideCount = slides?.slideCount ?? 0;

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
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    if (!switchingSlideRef.current) setAudioPlaying(false);
    setNoteRevealCount(null);
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
  const visibleNote = noteRevealCount === null ? note : note.slice(0, noteRevealCount);

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
    <div className="space-y-4">
      <div className={cn('lf-anim-in-up rounded-[16px] border border-hairline bg-paper shadow-warm-lg', wideMode ? 'p-3 md:p-4' : 'p-4 md:p-5')}>
        <div className="flex items-center justify-center">
          {slideSrc ? (
            <img
              src={slideSrc}
              alt={`第 ${current + 1} 页`}
              className={cn(
                'w-auto max-w-full rounded-md object-contain shadow-sm transition-[max-height] duration-300',
                wideMode ? 'max-h-[min(56vh,calc(100dvh-320px))]' : 'max-h-[48vh]',
              )}
            />
          ) : (
            <div className="flex min-h-[34vh] items-center justify-center"><Loader2 size={22} className="animate-spin text-brand" /></div>
          )}
        </div>
        {note && (
          <div className="mt-3 border-t border-hairline pt-3">
            <div className="flex items-center gap-2">
              <FileText size={14} className="text-brand" />
              <span className="lf-mono-label !text-[10px]">本页讲稿</span>
            </div>
            <p ref={noteScrollRef} className="mt-2 h-[120px] overflow-y-auto whitespace-pre-wrap pr-2 text-[14px] leading-[24px] text-ink-2" aria-live="off">
              {visibleNote}
              {audioPlaying && noteRevealCount !== null && noteRevealCount < note.length && (
                <span className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse align-[-0.12em] bg-brand" aria-hidden />
              )}
            </p>
          </div>
        )}
      </div>
      <audio ref={audioRef} onPlay={() => { switchingSlideRef.current = false; setAudioPlaying(true); onPlaybackChange?.(true); }} onPause={() => { if (!switchingSlideRef.current) { setAudioPlaying(false); onPlaybackChange?.(false); } }} onTimeUpdate={syncNoteToAudio} onEnded={handleAudioEnded} className="hidden" preload="none" />
    </div>
  );
});

export default PptPlayer;
