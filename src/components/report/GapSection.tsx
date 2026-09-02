/**
 * GapSection — 知识盲区定位（report.md S2，双栏 7:5）
 * 左：盲区雷达（当前能力 vs 岗位目标，缺口区域砖红强调 + 最大盲区角标）
 * 右：盲区排序列表（按严重度降序，可展开消解计划）
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, CalendarClock, ListChecks } from 'lucide-react';
import type { Learner } from '@/data/learners';
import type { BlindSpot, LearnerReport } from '@/data/reportData';
import { knowledgePoints, getKnowledgePoint } from '@/data/knowledgePoints';
import { getResourcesFor } from '@/data/resources';
import { useProfile } from '@/context/ProfileContext';
import ChartCard, { ReactECharts } from '@/components/ChartCard';
import { reducedMotion } from '@/components/agents/usePlayback';
import type { Severity } from '@/components/profiles/profileMeta';
import { cn } from '@/lib/utils';

const priorityTone: Record<Severity, { bar: string; chip: string }> = {
  高: { bar: '#B0483B', chip: 'border-brand-danger/40 bg-brand-danger/10 text-brand-danger' },
  中: { bar: '#E7B45A', chip: 'border-brand-amber/50 bg-brand-amber-tint text-ochre' },
  低: { bar: '#CFC8B8', chip: 'border-hairline bg-paper-deep text-ink-muted' },
};

/* 未在盲区列表中的达标维度色调（chip 用） */
const okTone = { bar: '#7FB295', chip: 'border-brand/30 bg-brand-tint/60 text-brand' };

/* ---------------- 左：盲区雷达 ---------------- */
function GapRadar({
  learner,
  spots,
  onSelect,
}: {
  learner: Learner;
  spots: BlindSpot[];
  onSelect: (kpId: string) => void;
}) {
  const option = useMemo(() => {
    const current = knowledgePoints.map((kp) => learner.scores[kp.id] ?? 0);
    const target = knowledgePoints.map((kp) => kp.targetLevel);
    let maxGapIdx = 0;
    let maxGap = -Infinity;
    target.forEach((t, i) => {
      const g = t - current[i];
      if (g > maxGap) {
        maxGap = g;
        maxGapIdx = i;
      }
    });
    return {
      animationDuration: 800,
      tooltip: { trigger: 'item' as const },
      legend: {
        bottom: 0,
        icon: 'roundRect',
        itemWidth: 12,
        itemHeight: 8,
        data: ['当前能力', '岗位目标'],
      },
      radar: {
        indicator: knowledgePoints.map((kp) => ({ name: kp.name, max: 100 })),
        radius: '64%',
        center: ['50%', '48%'] as [string, string],
        /* 维度名标签可点击：触发 'click' 事件，targetType 'axisName' + name = 知识点名 */
        triggerEvent: true,
        axisName: {
          color: '#5A6553',
          fontSize: 12,
          fontFamily: '"Noto Sans SC", sans-serif',
        },
        splitLine: { lineStyle: { color: 'rgba(127,178,149,0.20)' } },
        splitArea: { areaStyle: { color: ['rgba(255,255,255,0)', 'rgba(223,237,228,0.32)'] } },
        axisLine: { lineStyle: { color: 'rgba(127,178,149,0.24)' } },
      },
      series: [
        {
          type: 'radar' as const,
          symbol: 'circle',
          symbolSize: 5,
          itemStyle: { borderWidth: 2, borderColor: '#FBFAF5' },
          data: [
            {
              /* 缺口强调层：目标多边形以砖红淡填，当前能力覆盖后仅缺口可见 */
              value: target,
              name: '缺口强调',
              silent: true,
              symbol: 'none',
              lineStyle: { opacity: 0 },
              itemStyle: { opacity: 0 },
              areaStyle: { color: 'rgba(176,72,59,0.10)' },
              animationDelay: 400,
            },
            {
              value: current,
              name: '当前能力',
              lineStyle: { color: '#4E7860', width: 2.6, cap: 'round' as const, join: 'round' as const },
              itemStyle: { color: '#4E7860', borderWidth: 2, borderColor: '#FBFAF5' },
              /* 水彩渐变填充 */
              areaStyle: {
                color: {
                  type: 'radial' as const, x: 0.5, y: 0.5, r: 0.8,
                  colorStops: [
                    { offset: 0, color: 'rgba(155,197,172,0.42)' },
                    { offset: 1, color: 'rgba(78,120,96,0.16)' },
                  ],
                },
              },
              markPoint: {
                symbol: 'circle',
                symbolSize: 1,
                itemStyle: { color: 'transparent' },
                label: {
                  show: true,
                  formatter: '最大盲区',
                  fontSize: 10,
                  fontFamily: '"IBM Plex Mono", monospace',
                  color: '#FBFAF5',
                  backgroundColor: '#B0483B',
                  borderRadius: 4,
                  padding: [3, 6] as [number, number],
                },
                data: [{ coord: [maxGapIdx, current[maxGapIdx]] }],
              },
            },
            {
              value: target,
              name: '岗位目标',
              lineStyle: { color: '#E7B45A', width: 2, type: 'dashed' as const },
              itemStyle: { color: '#E7B45A' },
              areaStyle: { color: 'rgba(231, 180, 90,0)' },
              animationDelay: 300,
            },
          ],
        },
      ],
    };
  }, [learner]);

  const handleChartClick = (params: unknown) => {
    const p = params as { componentType?: string; targetType?: string; name?: string };
    if (p.componentType !== 'radar' || p.targetType !== 'axisName' || !p.name) return;
    const kp = knowledgePoints.find((k) => k.name === p.name);
    if (kp) onSelect(kp.id);
  };

  /* 雷达下方 6 个知识点 chip：可靠的联动退化方案（维度轴标签点击生效则为加成） */
  const chips = useMemo(
    () =>
      knowledgePoints.map((kp) => {
        const spot = spots.find((s) => s.kpId === kp.id);
        const tone = spot ? priorityTone[spot.priority] : okTone;
        return { kp, spot, tone };
      }),
    [spots],
  );

  return (
    <ChartCard title="知识盲区定位雷达" en="GAP RADAR · CURRENT VS TARGET">
      <ReactECharts option={option} height={330} onClick={handleChartClick} />
      <div className="mt-1 flex flex-wrap items-center justify-center gap-1.5 border-t border-hairline pt-3">
        {chips.map(({ kp, spot, tone }) => (
          <button
            key={kp.id}
            type="button"
            onClick={() => onSelect(kp.id)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-transform duration-150 hover:-translate-y-[1px]',
              tone.chip,
            )}
          >
            <span className="h-[7px] w-[7px] rounded-full" style={{ backgroundColor: tone.bar }} />
            {kp.name}
            <span className="font-mono text-[10.5px] tabular">
              {spot ? `Δ-${spot.gap}` : '状态良好'}
            </span>
          </button>
        ))}
      </div>
    </ChartCard>
  );
}

/* ---------------- 右：盲区排序列表 ---------------- */
function BlindSpotRow({
  spot,
  index,
  learnerId,
  isLearner,
  activeKpId,
  pulse,
}: {
  spot: BlindSpot;
  index: number;
  learnerId: string;
  isLearner: boolean;
  /** 雷达/chip 当前选中的知识点 id：命中时自动展开 + 定位 + 高亮闪烁 */
  activeKpId: string | null;
  /** 每次选中自增的 nonce：即使重复选中同一维度也能重新触发闪烁 */
  pulse: number;
}) {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const [seenPulse, setSeenPulse] = useState(0);
  const rowRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const kp = getKnowledgePoint(spot.kpId);

  /* 渲染期比对：命中新一次选中（pulse 变化）即展开+标记闪烁，即使重复选中同一维度 */
  if (activeKpId === spot.kpId && pulse !== seenPulse) {
    setSeenPulse(pulse);
    setOpen(true);
    setFlash(true);
  }

  /* 闪烁期间的副作用：定位滚动 + 到时熄灭，均在回调中调用 setState，不在 effect 体内直接调用 */
  useEffect(() => {
    if (!flash) return undefined;
    const t1 = window.setTimeout(() => {
      rowRef.current?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
    }, 60);
    const t2 = window.setTimeout(() => setFlash(false), 900);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [flash]);
  const tone = priorityTone[spot.priority];
  const matched = getResourcesFor(learnerId).filter((r) => r.kpId === spot.kpId);
  const weeks = Math.max(1, Math.ceil(spot.gap / 7));
  const pct = Math.min(100, Math.round((spot.score / spot.target) * 100));

  return (
    <motion.div
      ref={rowRef}
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ delay: index * 0.07, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        'group relative rounded-[10px] border border-transparent py-3 pl-4 pr-3 transition-colors duration-500',
        'hover:border-hairline hover:bg-paper',
        open && 'border-hairline bg-paper',
        flash && '!bg-brand-amber-tint/70 !border-brand-amber/40',
      )}
    >
      {/* 严重度色块 */}
      <span
        className="absolute left-0 top-1/2 h-[34px] w-[4px] -translate-y-1/2 rounded-r-full transition-all duration-150 group-hover:w-[6px]"
        style={{ backgroundColor: tone.bar }}
      />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 text-left"
      >
        <span className="w-[18px] shrink-0 font-mono text-[13px] font-semibold text-ink-muted tabular">
          {index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium text-ink">{kp.name}</span>
            <span
              className={cn(
                'rounded-md border px-1.5 py-px text-[10.5px] font-medium',
                tone.chip,
              )}
            >
              {spot.priority}盲区
            </span>
          </span>
          {/* 当前/目标双段进度 */}
          <span className="mt-1.5 flex items-center gap-2">
            <span className="relative h-[5px] w-full max-w-[220px] overflow-hidden rounded-full bg-paper-deep">
              <motion.span
                className="absolute inset-y-0 left-0 rounded-full"
                style={{ backgroundColor: tone.bar }}
                initial={{ width: 0 }}
                whileInView={{ width: `${pct}%` }}
                viewport={{ once: true }}
                transition={{ delay: 0.15 + index * 0.07, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
              />
            </span>
            <span className="font-mono text-[10.5px] text-ink-muted tabular">
              {spot.score} → {spot.target}
            </span>
          </span>
        </span>
        <span className="shrink-0 font-mono text-[13px] font-semibold text-brand-danger tabular">
          Δ -{spot.gap}
        </span>
        <ChevronDown
          size={15}
          className={cn('shrink-0 text-ink-muted transition-transform duration-200', open && 'rotate-180')}
        />
      </button>

      {/* 已配资源 chips：学习者视角一律指向永远可用的课件单元，而非只覆盖 3 组预写内容的 /resources */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[30px]">
        {matched.length > 0 ? (
          matched.map((r) => (
            <span
              key={r.form}
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                navigate(isLearner ? `/learn/${spot.kpId}` : '/resources');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') navigate(isLearner ? `/learn/${spot.kpId}` : '/resources');
              }}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-brand/30 bg-brand-tint/60 px-2 py-0.5 text-[11.5px] font-medium text-brand transition-colors hover:bg-brand-tint"
            >
              已配：{r.title}
            </span>
          ))
        ) : spot.priority === '低' ? (
          <span className="inline-flex items-center rounded-md border border-hairline bg-paper-deep px-2 py-0.5 text-[11.5px] font-medium text-ink-muted">
            观察中
          </span>
        ) : isLearner ? (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/learn/${spot.kpId}`);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigate(`/learn/${spot.kpId}`);
            }}
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-brand-amber/50 bg-brand-amber-tint px-2 py-0.5 text-[11.5px] font-medium text-ochre transition-colors hover:bg-brand-amber/20"
          >
            现在就去学 →
          </span>
        ) : (
          <span className="inline-flex items-center rounded-md border border-brand-amber/50 bg-brand-amber-tint px-2 py-0.5 text-[11.5px] font-medium text-ochre">
            资源排队中 · GEN-03 待生成
          </span>
        )}
      </div>

      {/* 消解计划 */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="ml-[30px] mt-3 space-y-2 rounded-[10px] border border-hairline bg-card-warm p-3.5">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-muted">
                {isLearner ? '怎么补上这块' : '消解计划 · DIA-01 生成'}
              </div>
              <p className="text-[13px] leading-[21px] text-ink-2">{spot.suggestion}</p>
              <div className="flex flex-wrap gap-x-5 gap-y-1.5 pt-1 text-[12px] text-ink-muted">
                <span className="inline-flex items-center gap-1.5">
                  <CalendarClock size={13} className="text-brand" />
                  预计 {weeks} 周消解 · 下次测评 W9 周五 14:00
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <ListChecks size={13} className="text-brand" />
                  资源清单 {matched.length > 0 ? `${matched.length} 项已就位` : '待生成'}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default function GapSection({
  learner,
  report,
}: {
  learner: Learner;
  report: LearnerReport;
}) {
  const { viewMode } = useProfile();
  const isLearner = viewMode === 'learner';
  const sorted = useMemo(
    () => [...report.blindSpots].sort((a, b) => b.gap - a.gap),
    [report],
  );
  /* 雷达维度点击 / chip 点击 → 联动右侧列表展开+定位+高亮 */
  const [activeKpId, setActiveKpId] = useState<string | null>(null);
  const [pulse, setPulse] = useState(0);
  const selectKp = (kpId: string) => {
    if (!sorted.some((s) => s.kpId === kpId)) {
      toast.info(`${getKnowledgePoint(kpId).name}状态良好`, { description: '当前表现良好，继续保持即可' });
      return;
    }
    setActiveKpId(kpId);
    setPulse((p) => p + 1);
  };

  return (
    <div className="grid gap-5 lg:grid-cols-12">
      <div className="lg:col-span-7">
        <GapRadar learner={learner} spots={report.blindSpots} onSelect={selectKp} />
      </div>
      <div className="lg:col-span-5">
        <div className="lf-card h-full p-5">
          {!isLearner && <div className="lf-mono-label mb-1">RANKED BLIND SPOTS</div>}
          <h3 className="mb-2 text-[16px] font-semibold leading-[24px] text-ink">
            盲区排序 · 按缺口降序
          </h3>
          <div className="divide-y divide-hairline/60">
            {sorted.map((s, i) => (
              <BlindSpotRow
                key={s.kpId}
                spot={s}
                index={i}
                learnerId={learner.id}
                isLearner={isLearner}
                activeKpId={activeKpId}
                pulse={pulse}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
