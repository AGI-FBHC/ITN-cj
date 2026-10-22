/**
 * MetricCard — 指标卡：大数字 count-up + 名称 + 达标 chip + 迷你 sparkline + 阈值参考线
 * （design.md §5.2 / home.md S2）
 */
import { useEffect, useRef, useState } from 'react';
import { motion, useInView } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { CoreMetric } from '@/data/metrics';
import { ReactECharts } from './ChartCard';
import { cn } from '@/lib/utils';

const badgeToneClass: Record<CoreMetric['badgeTone'], string> = {
  amber: 'border-brand-amber/50 bg-brand-amber-tint text-ochre',
  green: 'border-brand/30 bg-brand-tint text-brand',
  gray: 'border-hairline bg-paper-deep text-ink-muted',
};

/** easeOutQuart count-up */
function useCountUp(target: number, from: number, start: boolean, duration = 1200) {
  const [value, setValue] = useState(from);
  const rafRef = useRef<number>(0);
  useEffect(() => {
    if (!start) return;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 4);
      setValue(from + (target - from) * eased);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [start, target, from, duration]);
  return value;
}

export default function MetricCard({
  metric,
  className,
}: {
  metric: CoreMetric;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.3 });
  const navigate = useNavigate();
  const raw = useCountUp(metric.value, metric.fromValue, inView);
  const display = raw.toLocaleString('en-US', {
    minimumFractionDigits: metric.decimals,
    maximumFractionDigits: metric.decimals,
  });

  const sparkOption = {
    animationDuration: 900,
    grid: { top: 6, left: 2, right: 2, bottom: 2 },
    xAxis: { type: 'category' as const, show: false, data: metric.spark.map((_, i) => i) },
    yAxis: {
      type: 'value' as const,
      show: false,
      min: Math.min(...metric.spark, metric.thresholdLine ?? Infinity) * 0.96,
      max: Math.max(...metric.spark, metric.thresholdLine ?? -Infinity) * 1.04,
    },
    series: [
      {
        type: 'line' as const,
        data: metric.spark,
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2, color: metric.badgeTone === 'amber' ? '#E7B45A' : '#4E7860' },
        areaStyle: {
          color: {
            type: 'linear' as const, x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: metric.badgeTone === 'amber' ? 'rgba(231, 180, 90,0.22)' : 'rgba(78, 120, 96,0.18)' },
              { offset: 1, color: 'rgba(255,255,255,0)' },
            ],
          },
        },
        markLine: metric.thresholdLine
          ? {
              silent: true,
              symbol: 'none',
              lineStyle: { color: '#B0483B', type: 'dashed' as const, width: 1 },
              label: { show: false },
              data: [{ yAxis: metric.thresholdLine }],
            }
          : undefined,
      },
    ],
  };

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <motion.div
            ref={ref}
            initial={{ opacity: 0, y: 32 }}
            animate={inView ? { opacity: 1, y: 0 } : undefined}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            onClick={() => navigate(metric.href)}
            className={cn('lf-card lf-card-hover p-5 text-left', className)}
          >
            <div className="mb-1 flex items-center justify-between gap-2 border-t-2 border-hairline pt-3">
              <span className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-ink-muted">
                {metric.en}
              </span>
              <motion.span
                initial={{ scale: 0.8, opacity: 0 }}
                animate={inView ? { scale: 1, opacity: 1 } : undefined}
                transition={{ delay: 0.4, type: 'spring', stiffness: 260, damping: 18 }}
                className={cn(
                  'rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] font-medium',
                  badgeToneClass[metric.badgeTone],
                )}
              >
                {metric.thresholdText}
              </motion.span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="font-display text-[42px] leading-[50px] font-semibold text-ink tabular">
                {display}
              </span>
              {metric.suffix && (
                <span className="font-display text-[18px] font-medium text-ink-muted">{metric.suffix}</span>
              )}
            </div>
            <div className="text-[13px] font-medium text-ink-2">{metric.name}</div>
            <div className="mt-3 -mb-1">
              <ReactECharts option={sparkOption} height={44} />
            </div>
            <div className="mt-2 border-t border-hairline pt-2 text-[12px] leading-[18px] text-ink-muted">
              {metric.note}
            </div>
          </motion.div>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-[300px] border-hairline bg-card-warm font-mono text-[11.5px] leading-[17px] text-ink-2 shadow-warm"
        >
          {metric.tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
