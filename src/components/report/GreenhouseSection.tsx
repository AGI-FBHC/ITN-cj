/**
 * GreenhouseSection — 我的温室（收获陈列）
 * 「我的学习」的园子是现在时（浇水、该复习哪株），这里是过去时：
 * 六个域各自的品种、当前长势，以及已经收获过什么（开花 = 过目标线，金果 = 达 95）。
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { Learner } from '@/data/learners';
import { knowledgePoints } from '@/data/knowledgePoints';
import { speciesOf, harvestsOf } from '@/data/garden';
import { PottedSpecies } from '@/components/heal/SpeciesPlant';
import { cn } from '@/lib/utils';

/** 与图谱同一套生长阶段口径 */
function growthStage(mastery: number, target: number, learned: boolean): number {
  if (!learned) return 0;
  if (mastery >= 95) return 5;
  if (mastery >= target) return 4;
  const r = mastery / Math.max(1, target);
  return r >= 0.8 ? 3 : r >= 0.45 ? 2 : 1;
}

export default function GreenhouseSection({ learner }: { learner: Learner }) {
  const harvests = useMemo(() => harvestsOf(learner.id), [learner.id]);

  const pots = knowledgePoints.map((kp) => {
    const score = learner.scores[kp.id] ?? 50;
    const learned = score >= 55;
    const stage = growthStage(score, kp.targetLevel, learned);
    return { kp, score, stage, sp: speciesOf(kp.id), harvest: harvests[kp.id] };
  });
  /* 收获是"曾经达成"：分数后来因遗忘掉回目标线以下，收过的果依然算数 */
  const harvested = pots.filter((p) => p.stage >= 4 || p.harvest).length;

  return (
    <div className="rounded-[16px] border border-hairline bg-card-warm p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="font-serif text-[19px] font-semibold text-ink">我的温室</h3>
          <p className="mt-1 text-[12.5px] text-ink-muted">
            一门课一种植物。学到目标线它就开花，学到 95 分结出金果——这里存着你收过的果。
          </p>
        </div>
        <span
          className={cn(
            'rounded-md border px-2 py-1 font-mono text-[11px] font-semibold',
            harvested > 0 ? 'border-brand-amber/50 bg-brand-amber-tint text-ochre' : 'border-hairline bg-paper text-ink-muted',
          )}
        >
          已收获 {harvested} / {pots.length}
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {pots.map(({ kp, score, stage, sp, harvest }) => {
          /* 收过果但当前分数掉回线下 = 曾开花（遗忘曲线的可视化，不抹掉历史） */
          const past = !!harvest && stage < 4;
          const state =
            stage >= 5 ? '已结果' : stage >= 4 ? '已开花' : past ? '曾开花' : stage === 0 ? '还没播种' : '生长中';
          return (
            <div
              key={kp.id}
              className={cn(
                'flex gap-3 rounded-[12px] border p-3',
                stage >= 4
                  ? 'border-brand-amber/40 bg-brand-amber-tint/25'
                  : past
                    ? 'border-brand-amber/25 bg-paper'
                    : 'border-hairline bg-paper',
              )}
            >
              <PottedSpecies species={sp.key} stage={stage} className="h-[76px] w-[64px] shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="truncate text-[13.5px] font-semibold text-ink">{sp.name}</span>
                  <span className="truncate font-mono text-[10px] text-ink-muted">{kp.name}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 font-mono text-[10px] font-medium',
                      stage >= 4
                        ? 'bg-brand-amber-tint text-ochre'
                        : past
                          ? 'bg-brand-amber-tint/50 text-ochre'
                          : stage === 0
                            ? 'bg-paper-deep text-ink-muted'
                            : 'bg-brand-tint text-brand',
                    )}
                  >
                    {state}
                  </span>
                  <span className="font-mono text-[10.5px] text-ink-muted tabular-nums">
                    {stage === 0 ? '—' : `${score} / ${kp.targetLevel}`}
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] leading-[16px] text-ink-muted">
                  {harvest
                    ? `${harvest.date} ${harvest.stage === 'fruit' ? '结果' : '开花'}（当时 ${harvest.score} 分）${past ? ' · 回落了，浇浇水' : ''}`
                    : sp.why}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {harvested < pots.length && (
        <Link
          to="/learn"
          className="mt-3.5 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-brand transition-colors hover:text-brand-hover"
        >
          去园子里接着种 <ArrowRight size={13} />
        </Link>
      )}
    </div>
  );
}
