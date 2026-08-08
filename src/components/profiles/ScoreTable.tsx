/**
 * ScoreTable — 理论测试成绩明细（profiles.md S4，全宽表格卡）
 * 按知识点 / 按试卷 双视图；行可展开错题摘要（附 KB 溯源）
 */
import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import type { Learner } from '@/data/learners';
import { knowledgePoints } from '@/data/knowledgePoints';
import { kbSlicesByKp } from '@/data/kbSlices';
import TraceBadge from '@/components/TraceBadge';
import { wrongNotesByKp, weightedScore } from './profileMeta';
import { cn } from '@/lib/utils';

type Status = '优势' | '待巩固' | '盲区';

const statusClass: Record<Status, string> = {
  优势: 'border-brand/30 bg-brand-tint text-brand',
  待巩固: 'border-brand-amber/50 bg-brand-amber-tint text-ochre',
  盲区: 'border-brand-danger/40 bg-brand-danger/10 text-brand-danger',
};

const barColor: Record<Status, string> = {
  优势: '#4E7860',
  待巩固: '#E7B45A',
  盲区: '#B0483B',
};

function statusOf(score: number, target: number): Status {
  const gap = target - score;
  if (gap <= 5) return '优势';
  if (gap <= 20) return '待巩固';
  return '盲区';
}

/** 班级分位（由得分确定性推导） */
function percentileOf(score: number): number {
  return Math.max(5, Math.min(97, Math.round(100 - (100 - score) * 0.8)));
}

export default function ScoreTable({ learner }: { learner: Learner }) {
  const [mode, setMode] = useState<'kp' | 'paper'>('kp');
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      knowledgePoints.map((kp) => {
        const score = learner.scores[kp.id] ?? 0;
        const status = statusOf(score, kp.targetLevel);
        return {
          kp,
          score,
          status,
          percentile: percentileOf(score),
          slices: kbSlicesByKp(kp.id),
          notes: wrongNotesByKp[kp.id] ?? [],
        };
      }),
    [learner],
  );

  return (
    <div className="lf-card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="lf-mono-label mb-1">ASSESSMENT DETAIL</div>
          <h3 className="text-[16px] font-semibold leading-[24px] text-ink">理论测试成绩明细</h3>
        </div>
        {/* segmented 切换 */}
        <div className="flex rounded-[10px] border border-hairline bg-paper p-0.5">
          {(
            [
              { key: 'kp', label: '按知识点' },
              { key: 'paper', label: '按试卷' },
            ] as const
          ).map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMode(m.key)}
              className={cn(
                'rounded-[8px] px-3.5 py-1.5 text-[13px] font-medium transition-all duration-200',
                mode === m.key ? 'bg-brand text-paper shadow-xs' : 'text-ink-muted hover:text-ink',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {mode === 'kp' ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead>
              <tr className="border-b border-hairline font-mono text-[11px] uppercase tracking-[0.1em] text-ink-muted">
                <th className="py-2.5 pr-4 font-medium">知识点</th>
                <th className="py-2.5 pr-4 font-medium">得分</th>
                <th className="py-2.5 pr-4 font-medium">班级分位</th>
                <th className="py-2.5 pr-4 font-medium">状态</th>
                <th className="py-2.5 pr-4 font-medium">关联切片</th>
                <th className="w-[32px] py-2.5 font-medium" aria-label="展开" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const open = expanded === r.kp.id;
                return [
                  <motion.tr
                    key={r.kp.id}
                    initial={{ opacity: 0, y: 12 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, amount: 0.4 }}
                    transition={{ delay: i * 0.06, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                    onClick={() => setExpanded(open ? null : r.kp.id)}
                    className={cn(
                      'cursor-pointer border-b border-hairline/70 transition-colors duration-150 hover:bg-brand-tint/40',
                      open && 'bg-brand-tint/30',
                    )}
                  >
                    <td className="py-3 pr-4">
                      <span className="text-[14px] font-medium text-ink">{r.kp.name}</span>
                      <span className="ml-2 font-mono text-[10.5px] text-ink-muted">
                        目标 {r.kp.targetLevel}
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2.5">
                        <span className="w-[26px] font-mono text-[14px] font-semibold text-ink tabular">
                          {r.score}
                        </span>
                        <span className="relative h-[5px] w-[120px] overflow-hidden rounded-full bg-paper-deep">
                          <motion.span
                            className="absolute inset-y-0 left-0 rounded-full"
                            style={{ backgroundColor: barColor[r.status] }}
                            initial={{ width: 0 }}
                            whileInView={{ width: `${r.score}%` }}
                            viewport={{ once: true }}
                            transition={{ delay: 0.15 + i * 0.06, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                          />
                        </span>
                      </div>
                    </td>
                    <td className="py-3 pr-4 font-mono text-[13px] text-ink-2 tabular">
                      P{r.percentile}
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={cn(
                          'inline-block rounded-md border px-1.5 py-0.5 text-[11.5px] font-medium',
                          statusClass[r.status],
                        )}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      {r.slices[0] && <TraceBadge kbId={r.slices[0].id} />}
                    </td>
                    <td className="py-3 text-ink-muted">
                      <ChevronDown
                        size={15}
                        className={cn('transition-transform duration-200', open && 'rotate-180')}
                      />
                    </td>
                  </motion.tr>,
                  <tr key={`${r.kp.id}-detail`} className="border-b border-hairline/70">
                    <td colSpan={6} className="p-0">
                      <AnimatePresence initial={false}>
                        {open && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                            className="overflow-hidden"
                          >
                            <div className="space-y-2 bg-paper px-4 py-3.5">
                              <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-muted">
                                错题摘要 · 附 KB 溯源
                              </div>
                              {r.notes.map((note, ni) => (
                                <div
                                  key={ni}
                                  className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[20px] text-ink-2"
                                >
                                  <span className="font-mono text-[11px] text-brand">
                                    {['①', '②', '③'][ni]}
                                  </span>
                                  <span>{note}</span>
                                  {r.slices[ni] && <TraceBadge kbId={r.slices[ni].id} />}
                                </div>
                              ))}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </td>
                  </tr>,
                ];
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] border-collapse text-left">
            <thead>
              <tr className="border-b border-hairline font-mono text-[11px] uppercase tracking-[0.1em] text-ink-muted">
                <th className="py-2.5 pr-4 font-medium">试卷</th>
                <th className="py-2.5 pr-4 font-medium">导入日期</th>
                <th className="py-2.5 pr-4 font-medium">覆盖维度</th>
                <th className="py-2.5 pr-4 font-medium">加权综合分</th>
                <th className="py-2.5 pr-4 font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-hairline/70">
                <td className="py-3.5 pr-4 text-[14px] font-medium text-ink">理论测试卷 A（目标能力模型对齐）</td>
                <td className="py-3.5 pr-4 font-mono text-[13px] text-ink-2">2025-11-28</td>
                <td className="py-3.5 pr-4 text-[13px] text-ink-2">6 大知识点 · 36 题</td>
                <td className="py-3.5 pr-4 font-mono text-[14px] font-semibold text-brand tabular">
                  {weightedScore(learner)}
                </td>
                <td className="py-3.5 pr-4">
                  <span className="inline-block rounded-md border border-brand/30 bg-brand-tint px-1.5 py-0.5 text-[11.5px] font-medium text-brand">
                    成绩已校验
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="mt-3 text-[12.5px] leading-[20px] text-ink-muted">
            仅一次正式理论测试已导入；随堂测验与交互练习数据由 DIA-01 持续采集并折算入画像向量。
          </p>
        </div>
      )}
    </div>
  );
}
