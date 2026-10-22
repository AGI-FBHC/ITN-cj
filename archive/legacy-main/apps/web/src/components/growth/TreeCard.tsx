/**
 * TreeCard — 「我的知识树」卡（/me）
 * 能量球（待浇）+ 一键浇水 + 树阶进度 + 果实说明 + 能量明细（可展开）
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Droplets, ChevronDown, Sprout, ArrowRight } from 'lucide-react';
import { useGrowth, TREE_STAGES } from '@/context/GrowthContext';
import { useProfile } from '@/context/ProfileContext';
import { useLearningMap } from '@/hooks/useLearningMap';
import { learnMapPath } from '@/lib/learnNav';
import KnowledgeTree from './KnowledgeTree';
import { GrassTuft, LeafSmall } from '@/components/heal/Flora';
import { cn } from '@/lib/utils';

export default function TreeCard() {
  const { currentLearner } = useProfile();
  const learningMap = useLearningMap();
  const { orb, watered, stage, log, fruits, water } = useGrowth();
  const navigate = useNavigate();
  const [logOpen, setLogOpen] = useState(false);
  const [drop, setDrop] = useState(false);

  const next = TREE_STAGES[Math.min(stage + 1, TREE_STAGES.length - 1)];
  const isMax = stage >= TREE_STAGES.length - 1;
  const toNext = isMax ? 0 : Math.max(0, next.at - watered);
  const prevAt = TREE_STAGES[stage].at;
  const pct = isMax ? 100 : Math.min(100, Math.round(((watered - prevAt) / (next.at - prevAt)) * 100));

  const doWater = () => {
    if (orb <= 0) return;
    setDrop(true);
    setTimeout(() => setDrop(false), 900);
    water();
  };

  return (
    <div className="lf-card lf-glow-card relative p-5">
      {/* 树旁草丛 + 破框小叶 */}
      <LeafSmall className="pointer-events-none absolute -top-3.5 left-6 h-[28px] w-[42px]" />
      <GrassTuft className="pointer-events-none absolute bottom-1 left-3 h-[40px] w-[56px] opacity-70" />
      <div className="flex items-center justify-between">
        <div className="lf-mono-label flex items-center gap-1.5 !text-[10.5px]">
          <Sprout size={12} className="text-brand" />
          我的知识树 · 学习能量浇灌
        </div>
        <span className="font-mono text-[10.5px] text-ink-muted">果实 = 已掌握知识点（{fruits.length}/6）</span>
      </div>

      <div className="mt-2 grid items-center gap-4 sm:grid-cols-2">
        {/* 树 */}
        <div className="relative">
          <div className={drop ? 'lf-shake-soft' : undefined}>
            <KnowledgeTree stage={stage} fruits={fruits} size={190} />
          </div>
          {/* 浇水：多滴水珠错峰洒落 */}
          {drop && (
            <div className="pointer-events-none absolute inset-0" aria-hidden>
              {[
                { l: '38%', d: '0s' }, { l: '48%', d: '0.09s' }, { l: '58%', d: '0.05s' },
                { l: '44%', d: '0.18s' }, { l: '54%', d: '0.24s' },
              ].map((s, i) => (
                <span key={i} className="lf-drop" style={{ left: s.l, top: '14%', animationDelay: s.d }} />
              ))}
            </div>
          )}
        </div>

        {/* 能量与操作 */}
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            {/* 能量球 */}
            <div className={cn('relative flex h-16 w-16 items-center justify-center rounded-full border-2', orb > 0 ? 'border-brand-amber bg-brand-amber-tint' : 'border-hairline bg-paper')}>
              <span className={cn('font-display text-[20px] font-semibold', orb > 0 ? 'text-ochre' : 'text-ink-muted')}>{orb}</span>
              {orb > 0 && <span className="absolute inset-0 animate-pulse-ring rounded-full text-brand-amber" />}
            </div>
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium text-ink">能量球</div>
              <div className="text-[11.5px] leading-[16px] text-ink-muted">答题/读讲义/实操/笔记都会产能量</div>
            </div>
          </div>

          {orb > 0 ? (
            <button type="button" onClick={doWater} className="lf-btn-primary w-full !py-2 text-[13.5px]">
              <Droplets size={15} />
              一键浇水（{orb} 能量）
            </button>
          ) : (
            <button
              type="button"
              onClick={() => navigate(learnMapPath(currentLearner.id, learningMap.activeKp ?? undefined))}
              className="lf-btn-ghost w-full !py-2 text-[13.5px]"
            >
              先去学习攒能量
              <ArrowRight size={14} />
            </button>
          )}

          {/* 阶段进度 */}
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

      {/* 能量明细 */}
      <button
        type="button"
        onClick={() => setLogOpen((v) => !v)}
        className="mt-3 flex w-full items-center justify-between border-t border-hairline/60 pt-2 text-[11.5px] text-ink-muted hover:text-ink"
      >
        能量明细（最近 {Math.min(log.length, 6)} 条）
        <ChevronDown size={13} className={cn('transition-transform', logOpen && 'rotate-180')} />
      </button>
      <AnimatePresence>
        {logOpen && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="space-y-1 pt-2">
              {log.length === 0 && <p className="text-[11.5px] text-ink-muted">还没有记录——学习行为会自动产能量。</p>}
              {log.slice(0, 6).map((e, i) => (
                <div key={i} className="flex items-center gap-2 font-mono text-[11px] text-ink-2">
                  <span className="text-ink-muted">{e.time}</span>
                  <span className="min-w-0 flex-1 truncate">{e.text}</span>
                  <span className={cn('font-semibold', e.amt > 0 ? 'text-brand-success' : 'text-ochre')}>
                    {e.amt > 0 ? `+${e.amt}` : `${e.amt} → 树`}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
