/**
 * TraceRail — 本资源溯源面板（resources.md S3）
 * 讲义 Tab 为右侧 sticky 栏；其余 Tab 以抽屉承载同一内容
 * 每条：TraceBadge + 切片标题 + 标准号 mono + 可信度细条 + 被引位置 + 「有疑问？」反馈入口
 * 顶部可切换排序：按可信度（默认）/ 按出现顺序
 */
import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { ShieldCheck, HelpCircle, ArrowDownWideNarrow, ListOrdered } from 'lucide-react';
import { toast } from 'sonner';
import TraceBadge from '@/components/TraceBadge';
import { getKBSlice } from '@/data/kbSlices';
import { cn } from '@/lib/utils';

export interface TraceEntry {
  kbId: string;
  /** 被引位置，如 §2 */
  section?: string | null;
}

type SortMode = 'credibility' | 'order';

export default function TraceRail({
  entries,
  className,
  compact = false,
}: {
  entries: TraceEntry[];
  className?: string;
  compact?: boolean;
}) {
  const [sortMode, setSortMode] = useState<SortMode>('credibility');
  const reduced = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  const unique = entries.filter(
    (e, i) => entries.findIndex((x) => x.kbId === e.kbId) === i,
  );

  /* 按可信度降序 or 保留原出现顺序 */
  const sorted = useMemo(() => {
    if (sortMode === 'order') return unique;
    return [...unique].sort((a, b) => {
      const ca = getKBSlice(a.kbId)?.credibility ?? 0;
      const cb = getKBSlice(b.kbId)?.credibility ?? 0;
      return cb - ca;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unique, sortMode]);

  /* 汇总：平均可信度 / 最低可信度（用于底部一行小字） */
  const credList = unique
    .map((e) => getKBSlice(e.kbId)?.credibility)
    .filter((c): c is number => typeof c === 'number');
  const avgCred = credList.length
    ? Math.round((credList.reduce((a, b) => a + b, 0) / credList.length) * 100)
    : 0;
  const minCred = credList.length ? Math.round(Math.min(...credList) * 100) : 0;

  const feedback = () => {
    toast.info('已记录你的疑问，审核裁判 Agent 将复核该引用（演示环境）');
  };

  return (
    <div className={cn('lf-card p-5', className)}>
      <div className="lf-mono-label flex items-center gap-2">
        <span className="inline-block h-px w-5 bg-brand/40" />
        TRACEABILITY
      </div>
      <h4 className="mt-2 flex items-center gap-2 text-[15px] font-semibold text-ink">
        本资源溯源
        <span className="rounded-md border border-brand/30 bg-brand-tint px-1.5 py-px font-mono text-[10px] font-medium text-brand">
          {unique.length} 处引用 · 全部可溯
        </span>
      </h4>

      {/* 排序切换：按可信度（默认）/ 按出现顺序 */}
      <div className="mt-3 inline-flex items-center gap-0.5 rounded-md border border-hairline bg-paper p-0.5">
        <button
          type="button"
          onClick={() => setSortMode('credibility')}
          className={cn(
            'inline-flex items-center gap-1 rounded-[5px] px-2 py-1 text-[10.5px] font-medium transition-colors',
            sortMode === 'credibility' ? 'bg-brand text-paper' : 'text-ink-muted hover:text-ink',
          )}
        >
          <ArrowDownWideNarrow size={11} /> 按可信度
        </button>
        <button
          type="button"
          onClick={() => setSortMode('order')}
          className={cn(
            'inline-flex items-center gap-1 rounded-[5px] px-2 py-1 text-[10.5px] font-medium transition-colors',
            sortMode === 'order' ? 'bg-brand text-paper' : 'text-ink-muted hover:text-ink',
          )}
        >
          <ListOrdered size={11} /> 按出现顺序
        </button>
      </div>

      <ul className={cn('mt-3 space-y-2.5', compact && 'space-y-2')}>
        {sorted.map((e, i) => {
          const slice = getKBSlice(e.kbId);
          if (!slice) return null;
          return (
            <motion.li
              key={e.kbId}
              layout={!reduced}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: reduced ? 0 : 0.05 * i, duration: reduced ? 0 : 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="rounded-[10px] border border-hairline bg-paper p-3"
            >
              <div className="flex items-center gap-2">
                <TraceBadge kbId={e.kbId} />
                <span className="truncate text-[12.5px] font-medium text-ink">{slice.title}</span>
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[10.5px] text-ink-muted">
                <span className="truncate">{slice.standardNo ?? slice.type}</span>
                {e.section && <span className="shrink-0 text-brand/80">被引位置 {e.section}</span>}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-paper-deep">
                  <div
                    className="h-full rounded-full bg-brand"
                    style={{ width: `${slice.credibility * 100}%` }}
                  />
                </div>
                <span className="font-mono text-[10.5px] text-ink-muted tabular">
                  {(slice.credibility * 100).toFixed(0)}
                </span>
              </div>
              <div className="mt-1.5 flex justify-end">
                <button
                  type="button"
                  onClick={feedback}
                  className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-ink-muted transition-colors hover:text-brand-danger"
                >
                  <HelpCircle size={10} /> 有疑问？
                </button>
              </div>
            </motion.li>
          );
        })}
      </ul>

      {credList.length > 0 && (
        <div className="mt-4 border-t border-hairline pt-3 font-mono text-[10.5px] text-ink-muted">
          平均可信度 <span className="font-semibold text-ink">{avgCred}%</span> · 最低{' '}
          <span className="font-semibold text-ink">{minCred}%</span>
        </div>
      )}

      <div className={cn('flex items-center gap-1.5 pt-3 font-mono text-[11px] text-ink-muted', credList.length === 0 && 'mt-4 border-t border-hairline')}>
        <ShieldCheck size={12} className="text-brand" />
        高保真承诺：无溯源，不生成。
      </div>
    </div>
  );
}
