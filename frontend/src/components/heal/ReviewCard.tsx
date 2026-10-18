/**
 * ReviewCard — 遗忘曲线复习提醒卡（花园隐喻：记忆水分 / 该浇水了）
 * 上：该浇水清单（按最渴优先），每项显示记忆水分环 + 上次学习 + 去复习
 * 下：遗忘曲线图（未来 30 天保持率衰减，含 70% 到期线与「复习后回满」示意）
 * 去焦虑：只说「有点渴了」，不做倒计时/断签/红叉。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Droplets, ChevronDown, ArrowRight } from 'lucide-react';
import { useProfile, dataIdOf } from '@/context/ProfileContext';
import { useReview } from '@/context/ReviewContext';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import { resolveLearnTarget } from '@/data/resources';
import {
  MOIST_META,
  RETENTION_FLOOR,
  humanAgo,
  humanUntil,
  moistLevel,
  retentionCurve,
  type ReviewItem,
} from '@/data/forgetting';
import { ReactECharts } from '@/components/ChartCard';
import GardenEmpty from '@/components/heal/GardenEmpty';
import { LeafSmall } from '@/components/heal/Flora';
import { cn } from '@/lib/utils';

/** 记忆水分环 */
function MoistRing({ r, size = 42 }: { r: number; size?: number }) {
  const meta = MOIST_META[moistLevel(r)];
  const stroke = 4.5;
  const rad = (size - stroke) / 2;
  const c = 2 * Math.PI * rad;
  return (
    <svg width={size} height={size} className="shrink-0" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={rad} fill="none" stroke="rgba(127,178,149,0.18)" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={rad}
        fill="none" stroke={meta.ring} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - r)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.22,1,0.36,1)' }}
      />
      <text
        x="50%" y="50%" dominantBaseline="central" textAnchor="middle"
        fontSize="11" fontWeight="700" fontFamily="'IBM Plex Mono', monospace" fill={meta.tone}
      >
        {Math.round(r * 100)}
      </text>
    </svg>
  );
}

function ReviewRow({ item, onGo }: { item: ReviewItem; onGo: (kpId: string, title: string) => void }) {
  const kp = getKnowledgePoint(item.kpId);
  const meta = MOIST_META[moistLevel(item.retention)];
  return (
    <div className="flex items-center gap-3 rounded-[14px] border border-hairline/70 bg-paper/50 px-3 py-2.5">
      <MoistRing r={item.retention} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-ink">{kp.name}</span>
          <span
            className="shrink-0 rounded-full px-2 py-px text-[10.5px] font-medium"
            style={{ color: meta.tone, background: `${meta.ring}2E` }}
          >
            {meta.label}
          </span>
        </div>
        <div className="mt-0.5 font-mono text-[10.5px] text-ink-muted">
          上次学习 {humanAgo(Date.now() - item.lastAt)} · 已复习 {item.reps} 次
          {!item.due && ` · ${humanUntil(item.dueAt - Date.now())}到期`}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onGo(item.kpId, kp.name)}
        className="lf-btn-primary shrink-0 !rounded-[12px] !px-3 !py-1.5 !text-[12.5px]"
      >
        <Droplets size={13} /> 浇水
      </button>
    </div>
  );
}

export default function ReviewCard() {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const { items, due } = useReview();
  const dataId = dataIdOf(currentLearner);
  const [curveOpen, setCurveOpen] = useState(false);

  const onGo = (kpId: string, title: string) => {
    navigate(resolveLearnTarget(dataId, kpId, title).to);
  };

  /* 遗忘曲线：取最渴的 3 株，画未来 30 天保持率 */
  const curveOption = useMemo(() => {
    const picks = items.slice(0, 3);
    const now = Date.now();
    const days = Array.from({ length: 31 }, (_, i) => i);
    const palette = ['#4E7860', '#B77552', '#E7B45A'];
    return {
      animationDuration: 700,
      tooltip: {
        trigger: 'axis' as const,
        valueFormatter: (v: number) => `${Math.round(v)}%`,
      },
      legend: { bottom: 0, data: picks.map((p) => getKnowledgePoint(p.kpId).name) },
      grid: { top: 18, left: 8, right: 14, bottom: 34, containLabel: true },
      xAxis: {
        type: 'category' as const,
        boundaryGap: false,
        data: days.map((d) => (d === 0 ? '今天' : `${d}天`)),
        axisLabel: { interval: 6 },
      },
      yAxis: {
        type: 'value' as const,
        min: 0,
        max: 100,
        axisLabel: { formatter: '{value}%' },
      },
      series: picks.map((p, i) => ({
        name: getKnowledgePoint(p.kpId).name,
        type: 'line' as const,
        showSymbol: false,
        data: retentionCurve({ lastAt: p.lastAt, reps: p.reps }, p.mastery, now, 30).map((s) => s.retention * 100),
        lineStyle: { color: palette[i], width: 2.6, cap: 'round' as const },
        itemStyle: { color: palette[i] },
        areaStyle: i === 0
          ? {
              color: {
                type: 'linear' as const, x: 0, y: 0, x2: 0, y2: 1,
                colorStops: [
                  { offset: 0, color: 'rgba(155,197,172,0.36)' },
                  { offset: 1, color: 'rgba(155,197,172,0.02)' },
                ],
              },
            }
          : undefined,
        /* 70% 到期参考线 */
        markLine: i === 0
          ? {
              silent: true,
              symbol: 'none',
              lineStyle: { color: '#B77552', type: 'dashed' as const, width: 1.4 },
              label: {
                formatter: '该浇水线 70%',
                position: 'insideEndTop' as const,
                color: '#B77552',
                fontSize: 10,
                fontFamily: '"IBM Plex Mono", monospace',
              },
              data: [{ yAxis: RETENTION_FLOOR * 100 }],
            }
          : undefined,
      })),
    };
  }, [items]);

  return (
    <div className="lf-card relative p-5">
      <LeafSmall className="pointer-events-none absolute -top-3.5 right-7 h-[28px] w-[42px]" />

      <div className="flex items-center justify-between gap-3">
        <div className="lf-mono-label flex items-center gap-1.5 !text-[10.5px]">
          <Droplets size={12} className="text-brand" />
          记忆水分 · 艾宾浩斯遗忘曲线
        </div>
        <span className="font-mono text-[10.5px] text-ink-muted">
          {due.length > 0 ? `${due.length} 株该浇水` : '都还滋润'}
        </span>
      </div>

      {items.length === 0 ? (
        <GardenEmpty
          scene="sprout"
          title="还没有需要照看的记忆"
          hint="学完第一讲后，这里会按遗忘曲线提醒你什么时候回来浇一次水。"
          className="!py-6"
        />
      ) : (
        <>
          {/* 该浇水清单（到期优先，没到期则显示最渴的两株） */}
          <div className="mt-3 space-y-2">
            {(due.length > 0 ? due : items.slice(0, 2)).slice(0, 4).map((it) => (
              <ReviewRow key={it.kpId} item={it} onGo={onGo} />
            ))}
          </div>

          {due.length === 0 && (
            <p className="mt-2.5 text-[12px] leading-[19px] text-ink-muted">
              这几株水分都还够，不急。到期我会轻声提醒你。
            </p>
          )}

          {/* 遗忘曲线（可折叠） */}
          <button
            type="button"
            onClick={() => setCurveOpen((v) => !v)}
            className="mt-3 flex w-full items-center justify-between rounded-[12px] border border-hairline/70 bg-paper/40 px-3 py-2 text-[12.5px] font-medium text-ink-2 transition-colors hover:border-brand/40 hover:text-brand"
          >
            <span className="inline-flex items-center gap-1.5">
              看遗忘曲线 · 未来 30 天怎么衰减
            </span>
            <ChevronDown size={14} className={cn('transition-transform', curveOpen && 'rotate-180')} />
          </button>
          {curveOpen && (
            <div className="lf-anim-in-up mt-2">
              <ReactECharts option={curveOption} height={232} />
              <p className="mt-1 px-1 text-[11.5px] leading-[18px] text-ink-muted">
                曲线按 <span className="font-mono">R = e^(−t/S)</span> 计算：复习次数越多、掌握度越高，稳定度 S 越大、衰减越慢。
                每复习一次，水分回满、曲线重新变平缓。
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={() => navigate('/report')}
            className="mt-3 inline-flex items-center gap-1 text-[12.5px] font-medium text-brand hover:underline"
          >
            看完整学习节奏 <ArrowRight size={13} />
          </button>
        </>
      )}
    </div>
  );
}
