/**
 * MyGarden `/me/garden` — 我的园子（独立页）
 * 顶栏养分入口点进来看到完整园子：树的长势 / 养分 / 该复习的 / 记忆曲线 / 全部养分明细。
 * 养分获取规则与 GrowthContext 的计分逻辑共用一份数据，避免两处对不上。
 */
import { Sun } from 'lucide-react';
import GardenCard from '@/components/heal/GardenCard';
import { NUTRIENT_RULES, TREE_STAGES, useGrowth } from '@/context/GrowthContext';

export default function MyGarden() {
  const { orb, watered, stage } = useGrowth();

  return (
    <div className="mx-auto max-w-[860px] px-5 pb-12 pt-8 md:px-6">
      <div className="flex flex-wrap items-center gap-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-[12px] border border-brand-amber/40 bg-brand-amber-tint">
          <Sun size={22} className="text-ochre" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="font-serif text-[24px] font-semibold text-ink">我的园子</h1>
          <p className="mt-0.5 text-[13px] text-ink-muted">
            当前养分 {orb} · 已滋养 {watered} · {TREE_STAGES[stage].name}
          </p>
        </div>
      </div>

      <div className="mt-5">
        <GardenCard />
      </div>

      <section className="lf-card mt-4 p-5">
        <h2 className="font-serif text-[16.5px] font-semibold text-ink">养分获取规则</h2>
        <p className="mt-1 text-[12px] leading-[19px] text-ink-muted">
          只有真实的学习行为才攒养分，攒下的养分可以用来滋养园子，让它长到下一阶。
        </p>
        <div className="mt-3 divide-y divide-hairline/60">
          {NUTRIENT_RULES.map((rule) => (
            <div key={rule.action} className="flex items-center justify-between gap-3 py-2">
              <span className="text-[13px] text-ink-2">{rule.action}</span>
              <span className="shrink-0 font-mono text-[12px] font-semibold text-brand">{rule.amount}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
