/**
 * PptPlayer — 交互课件里的真实 PPT 播放器
 * 读取 agents /v1/presentations 后台任务，完成后按页展示渲染图片与讲稿。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight,
  FileText, Loader2, Play, RefreshCw, Volume2, VolumeX,
} from 'lucide-react';
import { presentationApi, slideAudioUrl, slideImageUrl } from '@/lib/presentationApi';
import type { PresentationSlideshow, PresentationTask } from '@/lib/presentationApi';
import { cn } from '@/lib/utils';

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

export default function PptPlayer({
  taskId,
  onBack,
}: {
  taskId: string;
  onBack?: () => void;
}) {
  const [task, setTask] = useState<PresentationTask | null>(null);
  const [slides, setSlides] = useState<PresentationSlideshow | null>(null);
  const [current, setCurrent] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [audioPlaying, setAudioPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const outlineConfirmedRef = useRef(false);

  const loadTask = useCallback(async () => {
    try {
      const next = await presentationApi.getPresentation(taskId);
      setTask(next);
      if (next.status === 'outline_review' && !outlineConfirmedRef.current) {
        outlineConfirmedRef.current = true;
        try {
          await presentationApi.startPresentationGeneration(taskId);
          setTask((prev) => prev ? { ...prev, status: 'generating', progress: 40, stageMessage: '提纲已确认，正在设计幻灯片' } : prev);
          setLoading(true);
        } catch { /* 忽略并发确认 */ }
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
        try {
          await presentationApi.startPresentationGeneration(taskId);
          if (!cancelled) {
            setTask((prev) => prev ? { ...prev, status: 'generating', progress: 40, stageMessage: '提纲已确认，正在设计幻灯片' } : prev);
            setLoading(true);
          }
        } catch { /* 其他请求已确认或状态已变化时忽略 */ }
      }
      if (next.status === 'completed') {
        try {
          const meta = await presentationApi.getSlideshowSlides(taskId);
          if (!cancelled) {
            setSlides(meta);
            setCurrent(0);
            setLoading(false);
          }
        } catch {
          if (!cancelled) {
            setError('幻灯片读取失败');
            setLoading(false);
          }
        }
        return;
      }
      if (next.status === 'failed' || next.status === 'cancelled') {
        if (!cancelled) {
          setError(next.errorMessage || PROGRESS_LABEL[next.status]);
          setLoading(false);
        }
        return;
      }
      if (!cancelled) setLoading(true);
      timer = window.setTimeout(poll, 3000);
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [taskId]);

  const toggleAudio = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audioPlaying) {
      audio.pause();
      setAudioPlaying(false);
    } else {
      void audio.play().catch(() => setError('音频暂不可用，请稍后重试'));
      setAudioPlaying(true);
    }
  };

  const slideCount = slides?.slideCount ?? 0;
  const currentImage = slideCount > 0 ? slideImageUrl(taskId, current) : '';
  const currentAudio = slideCount > 0 ? slideAudioUrl(taskId, current) : '';
  const note = slides?.speakerNotes[current] ?? '';

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-120px)] max-w-[1280px] flex-col px-5 pb-10 pt-6 md:px-6">
      {/* 顶栏 */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onBack} className="lf-btn-ghost !px-3 !py-2 text-[12.5px]">
          <ArrowLeft size={14} />
          返回知识地图
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-serif text-[22px] font-semibold text-ink">{task?.title || '交互课件 · PPT'}</h1>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            {task ? `${PROGRESS_LABEL[task.status]} · ${task.progress}%` : '正在读取任务'}
          </p>
        </div>
        <button type="button" onClick={() => void loadTask()} className="lf-btn-ghost !px-3 !py-2 text-[12px]" title="刷新状态">
          <RefreshCw size={13} />
          刷新
        </button>
      </motion.div>

      {/* 生成中 */}
      {loading && !slides && !error && (
        <div className="mt-8 flex flex-col items-center justify-center rounded-[18px] border border-hairline bg-card-warm py-16 text-center">
          <Loader2 size={30} className="animate-spin text-brand" />
          <p className="mt-4 text-[14.5px] font-medium text-ink">{task?.stageMessage || 'PPT 正在后台生成'}</p>
          <p className="mt-1 text-[12px] text-ink-muted">生成完成后会自动进入播放页，无需刷新页面</p>
          <div className="mt-4 flex items-center gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <span key={i} className={cn('h-1.5 w-10 rounded-full', (task?.progress ?? 0) >= (i + 1) * 20 ? 'bg-brand' : 'bg-paper-deep')} />
            ))}
          </div>
        </div>
      )}

      {/* 错误 */}
      {error && (
        <div className="mt-8 rounded-[14px] border border-red-200 bg-red-50 px-5 py-4 text-[13.5px] text-red-700">
          <p className="font-medium">PPT 生成暂时不可用</p>
          <p className="mt-1">{error}</p>
          <button type="button" onClick={() => { setError(''); setLoading(true); void loadTask(); }} className="lf-btn-primary mt-3 !py-2">
            <RefreshCw size={13} />
            重试
          </button>
        </div>
      )}

      {/* 播放器 */}
      {slides && slideCount > 0 && (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="mt-6 flex flex-1 flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="relative flex min-h-[420px] items-center justify-center overflow-hidden rounded-[18px] border border-hairline bg-ink/95 p-3 shadow-warm">
            <button
              type="button"
              disabled={current <= 0}
              onClick={() => { setCurrent((v) => Math.max(0, v - 1)); setAudioPlaying(false); }}
              className="absolute left-3 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-white/10 text-paper backdrop-blur disabled:opacity-25"
              title="上一页"
            >
              <ChevronLeft size={18} />
            </button>
            <img
              src={currentImage}
              alt={`第 ${current + 1} 页`}
              className="max-h-[68vh] w-auto max-w-full rounded-md object-contain"
            />
            <button
              type="button"
              disabled={current >= slideCount - 1}
              onClick={() => { setCurrent((v) => Math.min(slideCount - 1, v + 1)); setAudioPlaying(false); }}
              className="absolute right-3 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-white/10 text-paper backdrop-blur disabled:opacity-25"
              title="下一页"
            >
              <ChevronRight size={18} />
            </button>
            <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 font-mono text-[11px] text-paper">
              {current + 1} / {slideCount}
            </span>
          </div>

          <aside className="flex flex-col gap-3">
            <div className="rounded-[16px] border border-hairline bg-card-warm p-4">
              <div className="flex items-center gap-2">
                <FileText size={15} className="text-brand" />
                <span className="lf-mono-label !text-[10px]">SPEAKER NOTES · 本页讲稿</span>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-[13.5px] leading-6 text-ink-2">{note || '本页暂无讲稿。'}</p>
            </div>
            <div className="rounded-[16px] border border-hairline bg-card-warm p-4">
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
                {audioPlaying ? <Volume2 size={14} className="text-brand" /> : <VolumeX size={14} className="text-ink-muted" />}
                本页语音讲解
              </div>
              <audio
                ref={audioRef}
                src={currentAudio}
                onPlay={() => setAudioPlaying(true)}
                onPause={() => setAudioPlaying(false)}
                onEnded={() => setAudioPlaying(false)}
                className="hidden"
                preload="none"
              />
              <button type="button" onClick={toggleAudio} className={cn('lf-btn-primary mt-3 w-full justify-center !py-2.5', !slides.audioAvailable[current] && 'opacity-45')}>
                {audioPlaying ? <VolumeX size={14} /> : <Play size={14} fill="currentColor" />}
                {audioPlaying ? '暂停讲解' : '播放本页讲解'}
              </button>
            </div>
            <div className="flex items-center gap-2 rounded-[16px] border border-hairline bg-card-warm p-4">
              <CheckCircle2 size={15} className="text-brand" />
              <span className="text-[12.5px] text-ink-2">PPT 已生成并保存到后端，可随时回来继续播放。</span>
            </div>
          </aside>
        </motion.div>
      )}

      {slides && slideCount === 0 && !loading && !error && (
        <div className="mt-8 rounded-[14px] border border-hairline bg-card-warm px-6 py-10 text-center text-[13px] text-ink-muted">
          这份 PPT 暂时没有可播放的页面，请尝试重新生成。
        </div>
      )}
    </div>
  );
}
