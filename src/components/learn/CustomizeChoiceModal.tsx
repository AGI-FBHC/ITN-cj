import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Loader2, Network, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

type ResourceType = 'lecture' | 'practice' | 'quiz' | 'ppt';

interface CustomizeChoiceModalProps {
  open: boolean;
  onClose: () => void;
  adminResourceId: string;
  kpId: string;
  resourceType: ResourceType;
  resourceLabel: string;
}

export default function CustomizeChoiceModal({
  open, onClose, adminResourceId, kpId, resourceType, resourceLabel,
}: CustomizeChoiceModalProps) {
  const navigate = useNavigate();
  const [pending, setPending] = useState<'learn' | 'team' | null>(null);

  useEffect(() => {
    if (!open) setPending(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !pending) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, pending]);

  if (!open) return null;

  const start = async (destination: 'learn' | 'team') => {
    setPending(destination);
    try {
      const task = await api.createCustomizeTask({ adminResourceId, kpId, resourceType });
      onClose();
      if (destination === 'team') {
        navigate(`/learn/customize-team/${encodeURIComponent(kpId)}?taskId=${encodeURIComponent(task.id)}`);
      } else if (resourceType === 'ppt') {
        navigate(`/learn/customize/${task.id}`);
      } else {
        navigate(`/learn/slide/${task.id}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '暂时无法开始定制');
      setPending(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-ink/35 px-4 backdrop-blur-[3px]" role="dialog" aria-modal="true" aria-labelledby="customize-choice-title" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
      <section className="w-full max-w-[560px] overflow-hidden rounded-[22px] border border-brand/20 bg-paper shadow-2xl">
        <header className="flex items-start justify-between border-b border-hairline bg-card-warm px-6 py-5">
          <div>
            <p className="font-mono text-[10px] tracking-[0.16em] text-brand">个性化学习资源</p>
            <h2 id="customize-choice-title" className="mt-1.5 font-serif text-[22px] font-semibold text-ink">准备学习{resourceLabel}</h2>
            <p className="mt-1 text-[12px] leading-5 text-ink-muted">选择直接开始学习，或前往教研组查看生成过程。</p>
          </div>
          <button type="button" aria-label="关闭" disabled={Boolean(pending)} onClick={onClose} className="rounded-lg p-2 text-ink-muted hover:bg-paper-deep hover:text-ink disabled:opacity-40"><X size={17} /></button>
        </header>
        <div className="grid gap-3 p-6 sm:grid-cols-2">
          <button type="button" disabled={Boolean(pending)} onClick={() => void start('learn')} className="group rounded-[16px] border border-brand/35 bg-brand-tint/45 p-4 text-left hover:border-brand hover:bg-brand-tint disabled:opacity-60">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-paper">{pending === 'learn' ? <Loader2 size={17} className="animate-spin" /> : <BookOpen size={17} />}</span>
            <strong className="mt-3 block text-[15px] text-ink">进入学习</strong>
            <span className="mt-1 block text-[11.5px] leading-5 text-ink-muted">首张卡片准备好即可开始，后续内容继续生成。</span>
          </button>
          <button type="button" disabled={Boolean(pending)} onClick={() => void start('team')} className="group rounded-[16px] border border-hairline bg-card-warm p-4 text-left hover:border-brand/50 hover:bg-paper disabled:opacity-60">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-paper-deep text-brand">{pending === 'team' ? <Loader2 size={17} className="animate-spin" /> : <Network size={17} />}</span>
            <strong className="mt-3 block text-[15px] text-ink">进入教研组</strong>
            <span className="mt-1 block text-[11.5px] leading-5 text-ink-muted">查看各 Agent 如何分析、生成与核验这项资源。</span>
          </button>
        </div>
        <footer className="border-t border-hairline px-6 py-4 text-right">
          <button type="button" disabled={Boolean(pending)} onClick={onClose} className="text-[12px] text-ink-muted hover:text-ink disabled:opacity-40">暂不定制</button>
        </footer>
      </section>
    </div>
  );
}
