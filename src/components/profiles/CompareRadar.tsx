/**
 * CompareRadar — 画像对比视图（profiles.md S5，可折叠区块）
 * 单张 radar 叠加 3 条「当前水平」系列（墨绿/琥珀/暖赭），legend 可点选
 */
import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { GitCompare } from 'lucide-react';
import { knowledgePoints } from '@/data/knowledgePoints';
import { useProfile } from '@/context/ProfileContext';
import ChartCard, { ReactECharts } from '@/components/ChartCard';
import { Switch } from '@/components/ui/switch';
import { compareColors } from './profileMeta';
import { cn } from '@/lib/utils';

export default function CompareRadar() {
  const { learners } = useProfile();
  const [open, setOpen] = useState(false);

  const option = useMemo(
    () => ({
      animationDuration: 800,
      tooltip: { trigger: 'item' as const },
      legend: {
        bottom: 0,
        icon: 'roundRect',
        itemWidth: 12,
        itemHeight: 8,
        data: learners.map((l) => l.name),
      },
      radar: {
        indicator: knowledgePoints.map((kp) => ({ name: kp.name, max: 100 })),
        radius: '64%',
        center: ['50%', '48%'] as [string, string],
        axisName: { color: '#5A6553', fontSize: 12, fontFamily: '"Noto Sans SC", sans-serif' },
        splitLine: { lineStyle: { color: '#E9E3D4' } },
        splitArea: { areaStyle: { color: ['rgba(253,252,249,0)', 'rgba(240,235,224,0.5)'] } },
        axisLine: { lineStyle: { color: '#DCE6DE' } },
      },
      series: [
        {
          type: 'radar' as const,
          symbolSize: 4,
          data: learners.map((l, i) => ({
            value: knowledgePoints.map((kp) => l.scores[kp.id] ?? 0),
            name: l.name,
            lineStyle: { color: compareColors[l.id] ?? '#5A6553', width: 2.5 },
            itemStyle: { color: compareColors[l.id] ?? '#5A6553' },
            areaStyle: { color: `${compareColors[l.id] ?? '#5A6553'}14` },
            animationDelay: i * 200,
          })),
        },
      ],
    }),
    [learners],
  );

  return (
    <div className="lf-card p-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-hairline bg-paper text-brand">
            <GitCompare size={17} strokeWidth={1.75} />
          </span>
          <div>
            <div className="lf-mono-label mb-0.5">PROFILE COMPARISON</div>
            <h3 className="text-[16px] font-semibold leading-[24px] text-ink">对比三位学习者</h3>
          </div>
        </div>
        <Switch
          checked={open}
          onCheckedChange={setOpen}
          onClick={(e) => e.stopPropagation()}
          aria-label="展开对比视图"
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="grid gap-5 pt-5 lg:grid-cols-12">
              <div className="lg:col-span-8">
                <ChartCard title="六维能力叠加" en="OVERLAY RADAR · 3 LEARNERS" bodyClassName="-mt-1">
                  <ReactECharts option={option} height={340} />
                </ChartCard>
              </div>
              <div className="flex flex-col justify-center lg:col-span-4">
                <div className="space-y-2.5">
                  {learners.map((l) => (
                    <div key={l.id} className="flex items-center gap-2.5 text-[13px] text-ink-2">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: compareColors[l.id] ?? '#5A6553' }}
                      />
                      <span className="font-medium text-ink">{l.name}</span>
                      <span className="text-ink-muted">{l.tag}</span>
                    </div>
                  ))}
                </div>
                <p
                  className={cn(
                    'mt-5 border-l-[3px] border-l-brand-amber pl-3 text-[13px] italic leading-[22px] text-ink-muted',
                  )}
                >
                  同一目标要求，三条完全不同的路径——这正是个性化生成的意义。
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
