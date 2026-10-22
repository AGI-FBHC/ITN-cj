/**
 * StepCard — 闭环/指南步骤卡：序号圆 + 图标 + 标题 + 描述 + 状态
 * （design.md §5.2，五步闭环 / 实操指南步骤共用）
 */
import { motion } from 'framer-motion';
import { Check, ArrowUpRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import TraceBadge from './TraceBadge';
import { cn } from '@/lib/utils';

export type StepStatus = 'done' | 'active' | 'todo';

export default function StepCard({
  index,
  icon: Icon,
  title,
  desc,
  status = 'todo',
  kbRefs,
  warning,
  onClick,
  linkLabel,
  className,
}: {
  index: number;
  icon?: LucideIcon;
  title: string;
  desc: string;
  status?: StepStatus;
  kbRefs?: string[];
  warning?: string;
  onClick?: () => void;
  linkLabel?: string;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      onClick={onClick}
      className={cn(
        'lf-card relative p-5',
        onClick && 'lf-card-hover',
        status === 'active' && 'border-brand/45 shadow-warm',
        className,
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <span
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-full border font-mono text-[13px] font-semibold',
            status === 'done' && 'border-brand bg-brand text-paper',
            status === 'active' && 'border-brand/60 bg-brand-tint text-brand',
            status === 'todo' && 'border-hairline bg-paper-deep text-ink-muted',
          )}
        >
          {status === 'done' ? <Check size={16} strokeWidth={2.2} /> : String(index).padStart(2, '0')}
        </span>
        {Icon && (
          <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-hairline bg-paper text-brand">
            <Icon size={17} strokeWidth={1.75} />
          </span>
        )}
      </div>
      <h4 className="text-[15px] font-semibold leading-[22px] text-ink">{title}</h4>
      <p className="mt-1.5 text-[13px] leading-[21px] text-ink-2">{desc}</p>
      {warning && (
        <p className="mt-2 rounded-lg border border-brand-amber/40 bg-brand-amber-tint px-2.5 py-1.5 text-[12px] leading-[18px] text-ochre">
          {warning}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-1">
        {kbRefs?.map((id) => <TraceBadge key={id} kbId={id} />)}
        {linkLabel && (
          <span className="ml-auto inline-flex items-center gap-0.5 text-[12.5px] font-medium text-brand">
            {linkLabel}
            <ArrowUpRight size={13} />
          </span>
        )}
      </div>
    </motion.div>
  );
}
