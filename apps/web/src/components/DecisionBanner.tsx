/**
 * DecisionBanner — 动态决策横幅：「降维解释」(墨绿) / 「进阶挑战」(琥珀)
 * 弹簧入场（scale 0.92→1，design.md §4.5 / §5.2）
 */
import { motion } from 'framer-motion';
import { ArrowDownWideNarrow, Rocket, Scale } from 'lucide-react';
import type { DecisionType } from '@/data/tutoringScript';
import { cn } from '@/lib/utils';

const meta: Record<
  DecisionType,
  { label: string; en: string; color: string; tint: string; Icon: typeof Rocket }
> = {
  simplify: {
    label: '降维解释',
    en: 'SIMPLIFY',
    color: '#4E7860',
    tint: '#DFEDE4',
    Icon: ArrowDownWideNarrow,
  },
  challenge: {
    label: '进阶挑战',
    en: 'CHALLENGE',
    color: '#B77552',
    tint: '#F8ECD2',
    Icon: Rocket,
  },
};

export default function DecisionBanner({
  type,
  reason,
  className,
}: {
  type: DecisionType;
  reason?: string;
  className?: string;
}) {
  const m = meta[type];
  const { Icon } = m;
  return (
    <motion.div
      initial={{ scale: 0.92, opacity: 0, y: 10 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ scale: 0.95, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 20 }}
      className={cn('flex items-start gap-3 rounded-[14px] border p-4', className)}
      style={{ borderColor: `${m.color}40`, backgroundColor: m.tint }}
      role="status"
    >
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] text-paper"
        style={{ backgroundColor: m.color }}
      >
        <Icon size={19} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold" style={{ color: m.color }}>
            决策仲裁：{m.label}
          </span>
          <span
            className="rounded-md border px-1.5 py-px font-mono text-[10px] font-semibold tracking-wider"
            style={{ color: m.color, borderColor: `${m.color}50` }}
          >
            {m.en} · ARB-05
          </span>
        </div>
        {reason && <p className="mt-1 text-[13px] leading-[20px] text-ink-2">{reason}</p>}
        <p className="mt-1.5 flex items-center gap-1 font-mono text-[11px] text-ink-muted">
          <Scale size={11} /> 由 ARB-05 依据实时交互正确率动态下发，画像已同步更新
        </p>
      </div>
    </motion.div>
  );
}
