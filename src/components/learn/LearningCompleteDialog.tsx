import { Loader2, RotateCcw } from 'lucide-react';

interface LearningCompleteDialogProps {
  open: boolean;
  unassessedCount: number;
  confirming?: boolean;
  restarting?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onRestart: () => void;
}

export default function LearningCompleteDialog({
  open,
  unassessedCount,
  confirming = false,
  restarting = false,
  onClose,
  onConfirm,
  onRestart,
}: LearningCompleteDialogProps) {
  if (!open) return null;
  const pendingCount = Math.max(0, unassessedCount);
  const hasUnassessed = pendingCount > 0;
  return (
    <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm" onClick={onClose} role="dialog" aria-modal="true" aria-label="完成确认">
      <div className="w-full max-w-[420px] rounded-[18px] border border-brand/30 bg-card-warm p-6 shadow-warm-lg" onClick={(event) => event.stopPropagation()}>
        <h3 className="font-serif text-[18px] font-semibold text-ink">
          {hasUnassessed ? `还有 ${pendingCount} 段没选掌握程度` : '准备完成本项学习'}
        </h3>
        <p className="mt-1.5 text-[12.5px] leading-5 text-ink-muted">
          {hasUnassessed
            ? '未选择的段落将默认标记为「基本理解」（25% 掌握分），与你的选择一起计入掌握程度。确认后立即返回知识网络。'
            : '所有段落的掌握程度均已记录。确认后将保存本次学习结果并返回知识网络。'}
        </p>
        <div className="mt-5 flex gap-2">
          <button type="button" disabled={confirming || restarting} onClick={onClose} className="lf-btn-ghost flex-1 justify-center">再想想</button>
          <button type="button" disabled={confirming || restarting} onClick={onConfirm} className="lf-btn-primary flex-1 justify-center disabled:opacity-50">{confirming ? <Loader2 size={14} className="animate-spin" /> : null}确认完成并返回地图</button>
        </div>
        <button type="button" disabled={confirming || restarting} onClick={onRestart} className="lf-btn-ghost mt-2 w-full justify-center !py-2 text-brand-danger disabled:opacity-50">{restarting ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}重新练习 · 清空掌握度重测</button>
      </div>
    </div>
  );
}
