/**
 * GardenCard — 「我的园子」（合并原 TreeCard + ReviewCard）
 *
 * 解决"三套隐喻打架"：过去 知识树(浇灌/能量球) / 记忆水分(浇水) / 知识花园(长势)
 * 是三个互不相干的系统，还有两个不同含义的「浇水」。现在合成一条因果链：
 *
 *     学习 → 攒下养分 → 滋养园子（长大结果）
 *                    └→ 有的植物会渴 → 去复习给它补水
 *
 * 用词约定（全站统一）：
 *   养分 = 学习攒来的资源（原「能量球」）
 *   滋养 = 花掉养分让园子长一阶（原「浇水」）
 *   渴了/补水 = 记忆变淡了，需要复习（原「记忆水分/浇水」）
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Sun, Droplets, ChevronDown, ArrowRight } from 'lucide-react';
import { useGrowth, TREE_STAGES } from '@/context/GrowthContext';

import { useLearningMap } from '@/hooks/useLearningMap';
import { learnMapPath } from '@/lib/learnNav';
import { useProfile, dataIdOf } from '@/context/ProfileContext';
import { useReview } from '@/context/ReviewContext';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import { resolveLearnTarget } from '@/data/resources';
import {
  MOIST_META, RETENTION_FLOOR, humanAgo, moistLevel, retentionCurve, type ReviewItem,
} from '@/data/forgetting';
import KnowledgeTree from '@/components/growth/KnowledgeTree';
import { ReactECharts } from '@/components/ChartCard';
import { LeafSmall } from '@/components/heal/Flora';
import { cn } from '@/lib/utils';

/** 记忆水分环 */
function MoistRing({ r, size = 38 }: { r: number; size?: number }) {
  const meta = MOIST_META[moistLevel(r)];
  const stroke = 4;
  const rad = (size - stroke) / 2;
  const c = 2 * Math.PI * rad;
  return (
    <svg width={size} height={size} className="shrink-0" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={rad} fill="none" stroke="rgba(127,178,149,0.18)" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={rad} fill="none"
        stroke={meta.ring} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - r)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset .8s cubic-bezier(.22,1,.36,1)' }}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle"
        fontSize="10.5" fontWeight="700" fontFamily="'IBM Plex Mono',monospace" fill={meta.tone}>
        {Math.round(r * 100)}
      </text>
    </svg>
  );
}

export default function GardenCard() {
  const navigate = useNavigate();
  const { orb, watered, stage, log, water } = useGrowth();

  const { currentLearner } = useProfile();

  const learningMap = useLearningMap();
  const { items, due } = useReview();
  const dataId = dataIdOf(currentLearner);

  // 园子与学习进度关联：果实 = 当前知识地图中「掌握度达标或四类资源学完」的知识点

  const mapTopics = learningMap.graphNodes.filter((n) => n.kind === 'topic');

  const fruits = mapTopics.length

    ? mapTopics

        .filter((t) => (learningMap.topicMastery[t.id] ?? 0) >= 80 || (learningMap.topicProgress[t.id] ?? 0) >= 100)

        .map((t) => ({ kpId: t.id, name: t.label }))

    : [];

  const fruitTotal = mapTopics.length || 6;
  const [drop, setDrop] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  const next = TREE_STAGES[Math.min(stage + 1, TREE_STAGES.length - 1)];
  const isMax = stage >= TREE_STAGES.length - 1;
  const toNext = isMax ? 0 : Math.max(0, next.at - watered);
  const prevAt = TREE_STAGES[stage].at;
  const pct = isMax ? 100 : Math.min(100, Math.round(((watered - prevAt) / (next.at - prevAt)) * 100));

  const doNourish = () => {
    if (orb <= 0) return;
    setDrop(true);
    setTimeout(() => setDrop(false), 900);
    water();
  };

  const goReview = (it: ReviewItem) => {
    const kp = getKnowledgePoint(it.kpId);
    navigate(resolveLearnTarget(dataId, it.kpId, kp.name).to);
  };

  /* 遗忘曲线（折叠区内） */
  const curveOption = useMemo(() => {
    const picks = items.slice(0, 3);
    const now = Date.now();
    const palette = ['#4E7860', '#B77552', '#E7B45A'];
    return {
      animationDuration: 700,
      tooltip: { trigger: 'axis' as const, valueFormatter: (v: number) => `${Math.round(v)}%` },
      legend: { bottom: 0, data: picks.map((p) => getKnowledgePoint(p.kpId).name) },
      grid: { top: 16, left: 8, right: 14, bottom: 32, containLabel: true },
      xAxis: {
        type: 'category' as const, boundaryGap: false,
        data: Array.from({ length: 31 }, (_, i) => (i === 0 ? '今天' : `${i}天`)),
        axisLabel: { interval: 6 },
      },
      yAxis: { type: 'value' as const, min: 0, max: 100, axisLabel: { formatter: '{value}%' } },
      series: picks.map((p, i) => ({
        name: getKnowledgePoint(p.kpId).name,
        type: 'line' as const,
        showSymbol: false,
        data: retentionCurve({ lastAt: p.lastAt, reps: p.reps }, p.mastery, now, 30).map((s) => s.retention * 100),
        lineStyle: { color: palette[i], width: 2.6, cap: 'round' as const },
        itemStyle: { color: palette[i] },
        areaStyle: i === 0 ? {
          color: {
            type: 'linear' as const, x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(155,197,172,0.36)' },
              { offset: 1, color: 'rgba(155,197,172,0.02)' },
            ],
          },
        } : undefined,
        markLine: i === 0 ? {
          silent: true, symbol: 'none',
          lineStyle: { color: '#B77552', type: 'dashed' as const, width: 1.4 },
          label: { formatter: '该补水了', position: 'insideEndTop' as const, color: '#B77552', fontSize: 10 },
          data: [{ yAxis: RETENTION_FLOOR * 100 }],
        } : undefined,
      })),
    };
  }, [items]);

  const thirsty = due.length > 0 ? due : [];

  return (
    <div className="lf-card lf-glow-card relative p-5">
      <LeafSmall className="pointer-events-none absolute -top-3.5 right-8 h-[28px] w-[42px]" />

      {/* 标题 + 一句话解释这张卡在讲什么 */}
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h3 className="font-serif text-[16.5px] font-semibold text-ink">我的园子</h3>
        <span className="font-mono text-[10.5px] text-ink-muted">结果 {fruits.length}/{fruitTotal} 个知识点</span>
      </div>
      <p className="mb-3 text-[12px] leading-[19px] text-ink-muted">
        学习会攒下<span className="font-medium text-ochre">养分</span>，用养分<span className="font-medium text-brand">滋养园子</span>让它长大；
        隔久没碰的知识会<span className="font-medium text-ochre">变淡</span>，回去复习一遍就能补回来。
      </p>

      <div className="grid items-center gap-4 sm:grid-cols-2">
        {/* 园子全景 */}
        <div className="relative">
          <div className={drop ? 'lf-grow-pop' : undefined}>
            <KnowledgeTree stage={stage} fruits={fruits} size={180} />
          </div>
          {drop && (
            <div className="pointer-events-none absolute inset-0" aria-hidden>
              <span className="lf-nourish-ring" />
              {[[-42, -52], [52, -38], [-30, -62], [46, -26], [-54, -40], [30, -18]].map(([dx, dy], i) => (
                <span key={i} className="lf-sparkle" style={{ '--dx': `${dx}px`, '--dy': `${dy}px`, animationDelay: `${i * 0.08}s` } as React.CSSProperties} />
              ))}
              {[{ l: '38%', d: '0s' }, { l: '48%', d: '.09s' }, { l: '58%', d: '.05s' }, { l: '44%', d: '.18s' }].map((s, i) => (
                <span key={i} className="lf-drop" style={{ left: s.l, top: '14%', animationDelay: s.d }} />
              ))}
            </div>
          )}
        </div>

        {/* 养分 + 滋养 */}
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div
              role="button"
              tabIndex={orb > 0 ? 0 : -1}
              onClick={orb > 0 ? doNourish : undefined}
              onKeyDown={orb > 0 ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doNourish(); } } : undefined}
              title={orb > 0 ? '点击滋养园子' : '攒够养分后可点击滋养'}
              className={cn(
                'relative flex h-14 w-14 items-center justify-center rounded-full border-2 transition',
                orb > 0 ? 'cursor-pointer border-brand-amber bg-brand-amber-tint hover:scale-105' : 'border-hairline bg-paper',
              )}
            >
              <Sun size={15} className={cn('absolute top-1.5', orb > 0 ? 'text-ochre/70' : 'text-ink-muted/50')} />
              <span className={cn('mt-3 font-display text-[18px] font-semibold', orb > 0 ? 'text-ochre' : 'text-ink-muted')}>{orb}</span>
              {orb > 0 && <span className="absolute inset-0 animate-pulse-ring rounded-full text-brand-amber" />}
            </div>
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium text-ink">养分 {orb}</div>
              <div className="text-[11.5px] leading-[16px] text-ink-muted">读讲义、做题、实操、记笔记都会攒</div>
            </div>
          </div>

          {orb > 0 ? (
            <button type="button" onClick={doNourish} className="lf-btn-primary w-full !py-2 text-[13.5px]">
              <Droplets size={15} /> 用 {orb} 养分滋养园子
            </button>
          ) : (
            <button type="button" onClick={() => navigate(learnMapPath(currentLearner.id, learningMap.activeKp ?? undefined))} className="lf-btn-ghost w-full !py-2 text-[13.5px]">
              去学习攒养分 <ArrowRight size={14} />
            </button>
          )}

          <div>
            <div className="mb-1 flex justify-between text-[11px] text-ink-muted">
              <span>{TREE_STAGES[stage].name}{isMax ? ' · 已满级' : ` → ${next.name}`}</span>
              <span className="font-mono">{isMax ? 'MAX' : `还差 ${toNext}`}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-paper-deep">
              <div className="h-full rounded-full bg-brand transition-all duration-700" style={{ width: `${pct}%` }} />
            </div>
          </div>
        </div>
      </div>

      {/* 渴了的植物 = 该复习的知识点 */}
      {thirsty.length > 0 && (
        <div className="mt-4 rounded-[14px] border border-brand-amber/40 bg-brand-amber-tint/40 p-3">
          <div className="mb-2 text-[12.5px] font-medium text-ochre">
            有 {thirsty.length} 个知识点记忆变淡了，回去过一遍就能补回来
          </div>
          <div className="space-y-1.5">
            {thirsty.slice(0, 3).map((it) => {
              const kp = getKnowledgePoint(it.kpId);
              return (
                <div key={it.kpId} className="flex items-center gap-2.5 rounded-[11px] bg-paper/70 px-2.5 py-2">
                  <MoistRing r={it.retention} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-ink">{kp.name}</div>
                    <div className="font-mono text-[10.5px] text-ink-muted">
                      上次学习 {humanAgo(Date.now() - it.lastAt)} · 记得约 {Math.round(it.retention * 100)}%
                    </div>
                  </div>
                  <button type="button" onClick={() => goReview(it)}
                    className="lf-btn-primary shrink-0 !rounded-[11px] !px-3 !py-1.5 !text-[12.5px]">
                    去复习
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {thirsty.length === 0 && items.length > 0 && (
        <p className="mt-3 rounded-[12px] bg-paper/60 px-3 py-2 text-[12px] text-ink-muted">
          这些知识都还记得牢，不用急着复习。淡了我会提醒你。
        </p>
      )}

      {/* 折叠：记忆变淡曲线 + 养分明细 */}
      <button
        type="button"
        onClick={() => setDetailOpen((v) => !v)}
        className="mt-3 flex w-full items-center justify-between border-t border-hairline/60 pt-2 text-[11.5px] text-ink-muted transition-colors hover:text-ink"
      >
        看细节：记忆怎么变淡的 · 养分从哪来
        <ChevronDown size={13} className={cn('transition-transform', detailOpen && 'rotate-180')} />
      </button>
      <AnimatePresence>
        {detailOpen && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="pt-3">
              {items.length > 0 && (
                <>
                  <div className="mb-1 text-[12px] font-medium text-ink-2">未来 30 天，记忆会怎么变淡</div>
                  <ReactECharts option={curveOption} height={210} />
                  <p className="mb-3 mt-1 text-[11px] leading-[17px] text-ink-muted">
                    这条线来自心理学的「遗忘曲线」：刚学完记得最牢，之后慢慢变淡；
                    每复习一次，就重新记牢一段更长的时间。
                  </p>
                </>
              )}
              <div className="mb-1 text-[12px] font-medium text-ink-2">养分从哪来（最近 {Math.min(log.length, 6)} 条）</div>
              {log.length === 0 && <p className="text-[11.5px] text-ink-muted">还没有记录——学习行为会自动攒养分。</p>}
              <div className="space-y-1">
                {log.slice(0, 6).map((e, i) => (
                  <div key={i} className="flex items-center gap-2 font-mono text-[11px] text-ink-2">
                    <span className="text-ink-muted">{e.time}</span>
                    <span className="min-w-0 flex-1 truncate">{e.text}</span>
                    <span className={cn('font-semibold', e.amt > 0 ? 'text-brand-success' : 'text-ochre')}>
                      {e.amt > 0 ? `+${e.amt}` : `${e.amt} → 园子`}
                    </span>
                  </div>
                ))}
              </div>
              {log.length > 6 && (
                <div className="mt-1.5 flex justify-end">
                  <button
                    type="button"
                    onClick={() => navigate('/report#learning-path')}
                    className="inline-flex items-center gap-0.5 text-[11px] font-medium text-brand transition-colors hover:underline"
                  >
                    显示更多 <ArrowRight size={11} />
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
