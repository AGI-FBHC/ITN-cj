/**
 * SectionHeader — H2 serif + 英文 mono 小标 + 右侧操作位（design.md §5.2）
 */
import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

export default function SectionHeader({
  en,
  title,
  desc,
  actions,
  className,
}: {
  en?: string;
  title: string;
  desc?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.4 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className={cn('mb-8 flex flex-wrap items-end justify-between gap-4', className)}
    >
      <div>
        {en && (
          <div className="lf-mono-label mb-2 flex items-center gap-2">
            <span className="inline-block h-px w-6 bg-brand/40" />
            {en}
          </div>
        )}
        <h2 className="font-serif text-[26px] leading-[34px] font-semibold text-ink">{title}</h2>
        {desc && <p className="mt-2 max-w-[560px] text-[14px] leading-[22px] text-ink-muted">{desc}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </motion.div>
  );
}
