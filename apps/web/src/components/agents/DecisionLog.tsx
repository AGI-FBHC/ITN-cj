/**
 * DecisionLog — S5 仲裁决策日志（全宽表格卡）
 * 随消息流实时追加：时间 | 决策者 | 决策 | 依据 | 置信度（细进度条）
 * 行点击展开「决策上下文」（关联消息 + 画像快照）；导出为模拟 toast
 */
import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, ScrollText, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Learner } from '@/data/learners';
import type { CollabScript } from '@/data/collabScript';
import type { CollabEvent } from '@/data/collabScript';
import { knowledgePoints } from '@/data/knowledgePoints';
import AgentChip from '@/components/AgentChip';
import { collabTypeMeta } from '@/components/TimelineItem';
import { formatWallTime } from './usePlayback';
import { cn } from '@/lib/utils';

interface LogRow {
  event: CollabEvent;
  index: number;
  label: string;
  basis: string;
  confidence: number;
}

function confidenceOf(e: CollabEvent): number {
  const m = (e.payload ?? '').match(/confidence\s*=\s*([\d.]+)/);
  if (m) return Number(m[1]);
  if (e.type === 'verdict') return 0.99;
  return 0.9;
}

export default function DecisionLog({
  script,
  cursor,
  base,
  learner,
}: {
  script: CollabScript;
  cursor: number;
  base: number | null;
  learner: Learner;
}) {
  const [openRow, setOpenRow] = useState<number | null>(null);

  const rows = useMemo<LogRow[]>(() => {
    const out: LogRow[] = [];
    script.events.forEach((e, i) => {
      if (i >= cursor) return;
      if (e.type !== 'decision' && e.type !== 'verdict') return;
      out.push({
        event: e,
        index: i,
        label: e.content.split(/，|。/)[0],
        basis: e.payload ?? e.content,
        confidence: confidenceOf(e),
      });
    });
    return out;
  }, [script.events, cursor]);

  return (
    <section className="mt-14" aria-label="仲裁决策日志">
      <div className="lf-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-3.5">
          <div>
            <div className="lf-mono-label !text-[10.5px]">DECISION LOG</div>
            <h3 className="mt-0.5 text-[16px] font-semibold text-ink">仲裁决策日志</h3>
          </div>
          <button
            type="button"
            onClick={() =>
              toast.success('演示环境已生成模拟导出', {
                description: `decision_log_${learner.name}_${rows.length}rows.json · 含置信度与溯源链`,
              })
            }
            className="inline-flex items-center gap-1.5 rounded-[10px] border border-brand/35 px-3 py-1.5 text-[12.5px] font-medium text-brand transition-all duration-200 ease-lf hover:bg-brand-tint"
          >
            <Download size={13} />
            导出
          </button>
        </div>

        {rows.length === 0 ? (
          <div className="flex h-[120px] flex-col items-center justify-center gap-2 text-center">
            <ScrollText size={18} className="text-ink-muted" />
            <p className="text-[13px] text-ink-muted">运行演示后，ARB-05 的仲裁决策将实时记录于此</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-hairline hover:bg-transparent">
                <TableHead className="w-[130px] font-mono text-[11px] text-ink-muted">时间</TableHead>
                <TableHead className="w-[150px] font-mono text-[11px] text-ink-muted">决策者</TableHead>
                <TableHead className="font-mono text-[11px] text-ink-muted">决策</TableHead>
                <TableHead className="font-mono text-[11px] text-ink-muted">依据</TableHead>
                <TableHead className="w-[150px] font-mono text-[11px] text-ink-muted">置信度</TableHead>
                <TableHead className="w-[32px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, ri) => {
                const open = openRow === row.index;
                const related = script.events.slice(
                  Math.max(0, row.index - 1),
                  Math.min(script.events.length, row.index + 2),
                );
                return [
                  <TableRow
                    key={`row-${row.index}`}
                    onClick={() => setOpenRow(open ? null : row.index)}
                    className={cn(
                      'cursor-pointer border-hairline transition-colors',
                      open ? 'bg-brand-tint/40' : 'hover:bg-paper-deep/50',
                    )}
                  >
                    <TableCell className="font-mono text-[11.5px] text-ink-muted tabular">
                      {formatWallTime(base, row.event.t)}
                    </TableCell>
                    <TableCell>
                      <AgentChip agentId={row.event.from} size="sm" showStatus={false} />
                    </TableCell>
                    <TableCell className="max-w-[260px]">
                      <motion.span
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3, delay: ri * 0.07 }}
                        className="block truncate text-[13px] text-ink-2"
                        title={row.event.content}
                      >
                        {row.label}
                      </motion.span>
                    </TableCell>
                    <TableCell className="max-w-[240px]">
                      <span className="block truncate font-mono text-[11px] text-ink-muted" title={row.basis}>
                        {row.basis}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="h-[5px] w-16 overflow-hidden rounded-full bg-paper-deep">
                          <motion.div
                            className="h-full rounded-full"
                            style={{ backgroundColor: row.confidence >= 0.95 ? '#4E7860' : '#E7B45A' }}
                            initial={{ width: 0 }}
                            animate={{ width: `${row.confidence * 100}%` }}
                            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                          />
                        </div>
                        <span className="font-mono text-[11.5px] text-ink-2 tabular">
                          {row.confidence.toFixed(2)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <ChevronDown
                        size={14}
                        className={cn('text-ink-muted transition-transform duration-200', open && 'rotate-180')}
                      />
                    </TableCell>
                  </TableRow>,
                  ...(open
                    ? [
                        <TableRow key={`ctx-${row.index}`} className="border-hairline hover:bg-transparent">
                          <TableCell colSpan={6} className="bg-paper-deep/40 p-0">
                            <AnimatePresence initial>
                              <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                                className="overflow-hidden"
                              >
                                <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
                                  <div>
                                    <div className="lf-mono-label mb-2 !text-[10px]">关联消息</div>
                                    <div className="space-y-1.5">
                                      {related.map((e) => (
                                        <div
                                          key={`${e.t}-${e.from}`}
                                          className="flex items-center gap-2 rounded-lg border border-hairline bg-card-warm px-2.5 py-1.5"
                                        >
                                          <span
                                            className="rounded px-1 font-mono text-[10px] font-semibold"
                                            style={{
                                              color: collabTypeMeta[e.type].color,
                                              backgroundColor: `${collabTypeMeta[e.type].color}14`,
                                            }}
                                          >
                                            {collabTypeMeta[e.type].label}
                                          </span>
                                          <span className="truncate font-mono text-[11px] text-ink-2">
                                            {e.from} → {e.to === 'ALL' ? '全体' : e.to}
                                          </span>
                                          <span className="truncate text-[11.5px] text-ink-muted">
                                            {e.content}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="lf-mono-label mb-2 !text-[10px]">
                                      画像快照 · {learner.name}
                                    </div>
                                    <div className="grid grid-cols-2 gap-1.5">
                                      {knowledgePoints.map((kp) => (
                                        <div
                                          key={kp.id}
                                          className={cn(
                                            'flex items-center justify-between rounded-lg border px-2.5 py-1.5',
                                            kp.id === script.kpId
                                              ? 'border-brand-amber/50 bg-brand-amber-tint'
                                              : 'border-hairline bg-card-warm',
                                          )}
                                        >
                                          <span className="text-[11.5px] text-ink-2">{kp.name}</span>
                                          <span className="font-mono text-[11.5px] font-medium text-ink tabular">
                                            {learner.scores[kp.id]}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                              </motion.div>
                            </AnimatePresence>
                          </TableCell>
                        </TableRow>,
                      ]
                    : []),
                ];
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}
