/**
 * PptPlayer — 交互课件里的真实 PPT 播放器
 * 读取 agents /v1/presentations 后台任务，完成后按页展示渲染图片与讲稿。
 * 底部采用原版新前端风格的悬浮控制窗：进度条 + 页码 + 翻页 + 播放/暂停 + 完成学习 + 退出。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, FileText, Loader2, Pause, Play, RefreshCw, X,
} from 'lucide-react';
import { fetchSlideAsset, presentationApi } from '@/lib/presentationApi';
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
  const [completing, setCompleting] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [slideSrc, setSlideSrc] = useState('');
  const [audioSrc, setAudioSrc] = useState('');
  const outlineConfirmedRef = useRef(false);
  const currentRef = useRef(0);
  const audioSrcRef = useRef('');
  currentRef.current = current;
  audioSrcRef.current = audioSrc;

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
      setError(reason instanceof Error ? `音频加载失败：${reason.message}` : '音频暂不可用，请稍后重试');
    }
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audioPlaying) {
      audio.pause();
      setAudioPlaying(false);
      return;
    }
    void playAudio(currentRef.current);
  };

  const goTo = (index: number, continuePlaying = false) => {
    if (index < 0 || index >= slideCount) return;
    if (index === currentRef.current) {
      if (continuePlaying) void playAudio(index);
      return;
    }
    setCurrent(index);
    if (continuePlaying) window.setTimeout(() => void playAudio(index), 700);
  };

  const handleAudioEnded = () => {
    if (currentRef.current < slideCount - 1) {
      goTo(currentRef.current + 1, true);
    } else {
      setAudioPlaying(false);
    }
  };

  const markLearned = async () => {
    if (completing) return;
    setCompleting(true);
    try {
      await presentationApi.completePresentation(taskId);
      toast.success('已标记为完成学习');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '标记完成失败');
    } finally {
      setCompleting(false);
    }
  };

  /* 页面切换时停止上一页语音并释放 blob URL */
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    setAudioPlaying(false);
    setAudioSrc((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return '';
    });
    audioSrcRef.current = '';
  }, [current]);

  /* 当前页 PPT 图片需要通过带 JWT 的 fetch 拉取为 blob，<img> 无法带 Authorization */
  useEffect(() => {
    if (!slides || slides.slideCount === 0) return;
    let cancelled = false;
    let objectUrl = '';
    fetchSlideAsset(taskId, current, 'slides')
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSlideSrc((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return objectUrl;
        });
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? `幻灯片图片加载失败：${reason.message}` : '幻灯片图片加载失败'); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [taskId, current, slides]);
  const note = slides?.speakerNotes[current] ?? '';

  return (
    <div className="mx-auto min-h-[calc(100dvh-64px)] max-w-[1280px] px-5 pb-36 pt-6 md:px-6">
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

      {/* 播放器主体 */}
      {slides && slideCount > 0 && (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="relative flex min-h-[58vh] items-center justify-center overflow-hidden rounded-[18px] border border-hairline bg-ink/95 p-4 shadow-warm">
            {slideSrc ? (
              <img
                src={slideSrc}
                alt={`第 ${current + 1} 页`}
                className="max-h-[72vh] w-auto max-w-full rounded-md object-contain"
              />
            ) : (
              <Loader2 size={22} className="animate-spin text-paper/60" />
            )}
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
              <div className="text-[12.5px] font-medium text-ink">自动连播</div>
              <p className="mt-1 text-[11.5px] leading-5 text-ink-muted">点击底部播放按钮，会按页自动播放语音并翻页。</p>
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

      {/* 底部悬浮控制窗（原版新前端风格） */}
      {slides && slideCount > 0 && (
        <div className="fixed inset-x-0 bottom-[58px] z-40 mx-auto flex w-[min(920px,calc(100%-24px))] flex-col gap-2 rounded-[17px] border border-hairline bg-paper/95 p-2.5 shadow-warm-lg backdrop-blur-md md:bottom-4">
          <input
            aria-label="幻灯片进度"
            type="range"
            min="0"
            max={Math.max(0, slideCount - 1)}
            value={current}
            onChange={(event) => goTo(Number(event.target.value))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-hairline accent-brand"
          />
          <div className="flex items-center gap-1.5 md:gap-2">
            <button type="button" onClick={togglePlay} title={audioPlaying ? '暂停' : '播放'} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-paper">
              {audioPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
            </button>
            <div className="hidden min-w-0 flex-1 sm:block">
              <div className="truncate text-[12.5px] font-medium text-ink">{task?.title || '交互课件 · PPT'}</div>
              <div className="mt-0.5 flex items-center gap-2 font-mono text-[9.5px] text-ink-muted">
                <span>{audioPlaying ? '正在连播' : 'PPT 交互课件'}</span>
                <span>{current + 1}/{slideCount}</span>
              </div>
            </div>
            <button type="button" disabled={current <= 0} onClick={() => goTo(current - 1)} title="上一页" className="flex h-9 shrink-0 items-center justify-center rounded-[10px] border border-hairline px-2.5 text-ink-muted disabled:opacity-30">
              <ChevronLeft size={15} />
            </button>
            <button type="button" disabled={current >= slideCount - 1} onClick={() => goTo(current + 1)} title="下一页" className="flex h-9 shrink-0 items-center justify-center rounded-[10px] border border-hairline px-2.5 text-ink-muted disabled:opacity-30">
              <ChevronRight size={15} />
            </button>
            <button type="button" title="完成学习" disabled={completing} onClick={() => void markLearned()} className="flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] border px-2.5 text-[11px] text-brand hover:border-brand/40">
              {completing ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
              <span className="hidden lg:inline">完成学习</span>
            </button>
            <button type="button" title="退出演示" onClick={onBack} className="flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] border border-hairline px-2.5 text-[11px] text-ink-muted hover:border-brand/40 hover:text-brand">
              <X size={14} />
              <span className="hidden lg:inline">退出</span>
            </button>
          </div>
        </div>
      )}

      <audio
        ref={audioRef}
        onPlay={() => setAudioPlaying(true)}
        onPause={() => setAudioPlaying(false)}
        onEnded={handleAudioEnded}
        className="hidden"
        preload="none"
      />
    </div>
  );
}
