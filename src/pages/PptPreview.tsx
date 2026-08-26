import { useEffect, useState } from 'react';
import { ArrowLeft, MonitorPlay } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import PptPlayer from '@/components/learn/PptPlayer';
import { presentationApi, type PresentationTask } from '@/lib/presentationApi';

export default function PptPreview() {
  const navigate = useNavigate();
  const { taskId = '' } = useParams();
  const [task, setTask] = useState<PresentationTask | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    presentationApi.getPresentation(taskId)
      .then((detail) => { if (!cancelled) setTask(detail); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : '课件读取失败'); });
    return () => { cancelled = true; };
  }, [taskId]);

  return (
    <div className="min-h-screen bg-[#f7f5ee]">
      <header className="sticky top-0 z-30 border-b border-white/70 bg-white/75 px-5 py-3 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1440px] items-center gap-3">
          <button type="button" onClick={() => navigate(-1)} className="lf-row-btn">
            <ArrowLeft size={14} />
            返回
          </button>
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-tint text-brand">
            <MonitorPlay size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-bold text-ink">{task?.title || '交互课件完整预览'}</h1>
            <p className="mt-0.5 text-[10px] text-ink-muted">管理员完整页面预览 · 保留后台简易预览入口</p>
          </div>
          {task && <span className="lf-pill lf-pill-null">{task.status}</span>}
        </div>
      </header>
      <main className="mx-auto max-w-[1440px] px-4 py-5">
        {error ? (
          <div className="lf-empty rounded-2xl p-12 text-sm">{error}</div>
        ) : (
          <PptPlayer taskId={taskId} wideMode speed="normal" volume={1} modelProvider="mimo" />
        )}
      </main>
    </div>
  );
}
