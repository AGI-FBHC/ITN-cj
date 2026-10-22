/**
 * ChartCard — ECharts 容器卡：标题 + 右上角操作位 + 统一暖色图表主题
 * 同时导出轻量 ReactECharts 包装器（echarts 实例生命周期管理）
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import * as echarts from 'echarts';
import type { EChartsCoreOption } from 'echarts/core';
import { useProfile } from '@/context/ProfileContext';
import { cn } from '@/lib/utils';

/* 统一治愈系图表主题：去网格、圆头平滑曲线、柔光点位 */
echarts.registerTheme('learnforge', {
  color: ['#4E7860', '#B77552', '#E7B45A', '#B0483B', '#7FB295', '#6BA080'],
  textStyle: { fontFamily: '"Noto Sans SC", sans-serif', color: '#5A6553' },
  grid: { top: 32, left: 12, right: 12, bottom: 8, containLabel: true },
  categoryAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: '#66725E', fontSize: 11, fontFamily: '"IBM Plex Mono", monospace' },
    splitLine: { show: false },
  },
  valueAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: '#66725E', fontSize: 11, fontFamily: '"IBM Plex Mono", monospace' },
    /* 去掉硬网格，只留极淡的一层参考线 */
    splitLine: { lineStyle: { color: 'rgba(127,178,149,0.16)', type: 'solid', width: 1 } },
  },
  /* 折线：平滑 + 圆头 + 柔和点位 */
  line: {
    smooth: true,
    symbol: 'circle',
    symbolSize: 6,
    lineStyle: { width: 2.6, cap: 'round', join: 'round' },
    itemStyle: { borderWidth: 2, borderColor: '#FBFAF5' },
    emphasis: { scale: 1.4 },
  },
  bar: { itemStyle: { borderRadius: [8, 8, 8, 8] } },
  radar: {
    axisName: { color: '#5A6553', fontSize: 12 },
    splitLine: { lineStyle: { color: 'rgba(127,178,149,0.22)' } },
    splitArea: { areaStyle: { color: ['rgba(255,255,255,0)', 'rgba(223,237,228,0.35)'] } },
    axisLine: { lineStyle: { color: 'rgba(127,178,149,0.25)' } },
  },
  legend: { textStyle: { color: '#5A6553', fontSize: 12 }, icon: 'roundRect', itemWidth: 12, itemHeight: 8 },
  tooltip: {
    backgroundColor: 'rgba(251,250,245,0.92)',
    borderColor: 'rgba(155,197,172,0.5)',
    borderWidth: 1,
    borderRadius: 12,
    padding: [8, 12],
    extraCssText: 'backdrop-filter:blur(10px);box-shadow:0 12px 28px -14px rgba(70,100,80,0.35);',
    textStyle: { color: '#3D4A3A', fontSize: 12 },
  },
});

/** 水彩渐变面填充（自上而下由浓到透） */
export function washFill(hex: string, top = 0.30, bottom = 0.02) {
  return {
    type: 'linear' as const,
    x: 0, y: 0, x2: 0, y2: 1,
    colorStops: [
      { offset: 0, color: `${hex}${Math.round(top * 255).toString(16).padStart(2, '0')}` },
      { offset: 1, color: `${hex}${Math.round(bottom * 255).toString(16).padStart(2, '0')}` },
    ],
  };
}

export function ReactECharts({
  option,
  height = 280,
  className,
  onClick,
  onEvents,
}: {
  option: EChartsCoreOption;
  height?: number;
  className?: string;
  onClick?: (params: unknown) => void;
  /** 任意 echarts 事件名 → 回调（如 'click' / 'mouseover'），与 onClick 可并存 */
  onEvents?: Record<string, (params: unknown) => void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, 'learnforge');
    chartRef.current = chart;
    chart.setOption(option);
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(option)]);

  /* 事件绑定与图表实例生命周期解耦：上方 effect 重建 chart 后本 effect 紧随其后执行，
     绑定前先 off() 同名事件，避免 option 更新或回调引用变化时重复叠加监听 */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const handlers: Record<string, (params: unknown) => void> = { ...onEvents };
    if (onClick) handlers.click = onClick;
    const names = Object.keys(handlers);
    names.forEach((name) => {
      chart.off(name);
      chart.on(name, handlers[name]);
    });
    return () => {
      names.forEach((name) => chart.off(name));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(option), onClick, onEvents]);

  return <div ref={ref} className={className} style={{ height, width: '100%' }} />;
}

export default function ChartCard({
  title,
  en,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  en?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const { viewMode } = useProfile();
  const isLearner = viewMode === 'learner';
  return (
    <div className={cn('lf-card p-5', className)}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          {en && !isLearner && <div className="lf-mono-label mb-1">{en}</div>}
          <h3 className="text-[16px] font-semibold leading-[24px] text-ink">{title}</h3>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      <div className={bodyClassName}>{children}</div>
    </div>
  );
}
