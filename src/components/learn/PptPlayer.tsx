/**
 * PptPlayer - PPT content renderer (image + notes) only.
 * All player bars, note editors, and raise-hand panels are provided by LearnUnit.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, FileText } from 'lucide-react';
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

export default function PptPlayer({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<PresentationTask | null>(null);
  const [slides, setSlides] = useState<PresentationSlideshow | null>(null);
  const [current, setCurrent] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [slideSrc, setSlideSrc] = useState('');
  const outlineConfirmedRef = useRef(false);

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

  const slideCount = slides?.slideCount ?? 0;

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
        {slideSrc ? (
          <img src={slideSrc} alt={`第 ${current + 1} 页`} className="mx-auto max-h-[58vh] w-auto max-w-full rounded-md object-contain shadow-sm" />
        ) : (
          <div className="flex min-h-[40vh] items-center justify-center"><Loader2 size={22} className="animate-spin text-brand" /></div>
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
    </div>
  );
}
