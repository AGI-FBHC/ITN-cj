/**
 * ScoreBand — 报告页头综合评分带（report.md S1，4 格）
 * 综合适配评分（简洁环形 gauge）/ 知识覆盖率 / 盲区消解数 / 学习投入
 */
import { useMemo, useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import type { LearnerReport } from '@/data/reportData';
import { ReactECharts } from '@/components/ChartCard';
import { useCountUp, formatNum } from '@/components/profiles/CountUp';
import { useProfile } from '@/context/ProfileContext';
import { cn } from '@/lib/utils';

/** 学习投入（页面本地 Mock，数据层未覆盖） */
const investMap: Record<string, { total: number; note: string }> = {
  lin: { total: 26.5, note: '讲义 9h · 实操 6h · 测评 11.5h' },
  chen: { total: 31.0, note: '讲义 8h · 实操 15h · 测评 8h' },
  zhao: { total: 18.5, note: '讲义 7.5h · 实操 6h · 测评 5h' },
};

function StatCard({
  index,
  en,
  value,
  decimals = 0,
  suffix,
  name,
  note,
  badge,
  badgeTone = 'green',
}: {
  index: number;
  en: string;
  value: number;
  decimals?: number;
  suffix?: string;
  name: string;
  note: string;
  badge: string;
  badgeTone?: 'green' | 'amber' | 'gray';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.3 });
  const counted = useCountUp(value, inView, 1200);
  const { viewMode } = useProfile();
  const isLearner = viewMode === 'learner';

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 32 }}
      animate={inView ? { opacity: 1, y: 0 } : undefined}
      transition={{ delay: index * 0.08, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className="lf-card flex flex-col p-5"
    >
      <div className="mb-1 flex items-center justify-between gap-2 border-t-2 border-hairline pt-3">
        {isLearner ? (
          <span />
        ) : (
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-ink-muted">
            {en}
          </span>
        )}
        <motion.span
          initial={{ scale: 0.8, opacity: 0 }}
          animate={inView ? { scale: 1, opacity: 1 } : undefined}
          transition={{ delay: 0.4 + index * 0.08, type: 'spring', stiffness: 260, damping: 18 }}
          className={cn(
            'rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] font-medium',
            badgeTone === 'green' && 'border-brand/30 bg-brand-tint text-brand',
            badgeTone === 'amber' && 'border-brand-amber/50 bg-brand-amber-tint text-ochre',
            badgeTone === 'gray' && 'border-hairline bg-paper-deep text-ink-muted',
          )}
        >
          {badge}
        </motion.span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="font-display text-[42px] leading-[50px] font-semibold text-ink tabular">
          {formatNum(counted, decimals)}
        </span>
        {suffix && (
          <span className="font-display text-[18px] font-medium text-ink-muted">{suffix}</span>
        )}
      </div>
      <div className="text-[13px] font-medium text-ink-2">{name}</div>
      <div className="mt-auto pt-3">
        <div className="border-t border-hairline pt-2 text-[12px] leading-[18px] text-ink-muted">
          {note}
        </div>
      </div>
    </motion.div>
  );
}

export default function ScoreBand({ report }: { report: LearnerReport }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.3 });
  const { viewMode } = useProfile();
  const isLearner = viewMode === 'learner';

  const highCount = report.blindSpots.filter((b) => b.priority === '高').length;
  /* 自建画像：消解数/投入用现算报告的真数据；预设画像沿用 8 周静态叙事 */
  const baselineHigh = report.generated ? report.baselineHighSpots ?? highCount : 5;
  const resolved = report.generated ? report.resolvedSpots ?? 0 : Math.max(0, 5 - highCount);
  const invest = report.generated
    ? { total: report.investHours ?? 0, note: report.investNote ?? '建档后实时累计' }
    : investMap[report.learnerId] ?? investMap.lin;
  const coverage = report.knowledgeCoverage ?? 92.4;
  const coverageNote = report.knowledgeCoverageNote ?? '6 大知识点 · 岗位能力模型对齐';
  const coverageBadge = report.generated ? '真实学习' : '岗位对齐';
  const gaugeOption = useMemo(
    () => ({
      animationDuration: 1200,
      series: [
        {
          type: 'gauge' as const,
          startAngle: 210,
          endAngle: -30,
          min: 0,
          max: 100,
          splitNumber: 20,
          radius: '104%',
          center: ['50%', '66%'] as [string, string],
          progress: {
            show: true,
            width: 13,
            roundCap: true,
            itemStyle: { color: '#4E7860' },
          },
          axisLine: {
            roundCap: true,
            lineStyle: { width: 13, color: [[1, '#EDE7D9']] },
          },
          pointer: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
          detail: {
            valueAnimation: true,
            offsetCenter: ['0%', '-18%'],
            formatter: (v: number) => v.toFixed(1),
            color: '#3D4A3A',
            fontSize: 30,
            fontWeight: 600,
            fontFamily: 'Fraunces, "Noto Serif SC", serif',
          },
          data: [{ value: report.adaptScore }],
        },
      ],
    }),
    [report],
  );

  return (
    <div className={cn('grid gap-4', isLearner ? 'sm:grid-cols-2' : 'md:grid-cols-2 xl:grid-cols-4')}>
      {/* 综合适配评分 gauge */}
      <motion.div
        ref={ref}
        initial={{ opacity: 0, y: 32 }}
        animate={inView ? { opacity: 1, y: 0 } : undefined}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="lf-card flex flex-col p-5"
      >
        <div className="mb-1 flex items-center justify-between gap-2 border-t-2 border-hairline pt-3">
          {isLearner ? (
            <span />
          ) : (
            <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-ink-muted">
              ADAPTATION SCORE
            </span>
          )}
        </div>
        <ReactECharts option={gaugeOption} height={128} />
        <div className="-mt-3 text-center text-[13px] font-medium text-ink-2">综合适配评分</div>
        <div className="mt-2 border-t border-hairline pt-2 text-center text-[12px] leading-[18px] text-ink-muted">
          定制资源覆盖 × 学习证据
        </div>
      </motion.div>

      <StatCard
        index={1}
        en="COVERAGE"
        value={coverage}
        decimals={1}
        suffix="%"
        name="知识覆盖率"
        note={coverageNote}
        badge={coverageBadge}
        badgeTone="green"
      />
      <StatCard
        index={2}
        en="BLIND-SPOT RESOLVED"
        value={resolved}
        suffix={`/ ${baselineHigh}`}
        name="盲区消解数"
        note={
          report.generated
            ? `建档基线 ${baselineHigh} 个高优盲区，当前剩 ${highCount} 个`
            : `近 8 周高盲区由 5 降至 ${highCount}`
        }
        badge="推进中"
        badgeTone="amber"
      />
      <StatCard
        index={3}
        en="LEARNING EFFORT"
        value={invest.total}
        decimals={1}
        suffix="h"
        name="学习投入"
        note={invest.note}
        badge={report.generated ? '建档起算' : '近 8 周'}
        badgeTone="gray"
      />
    </div>
  );
}
