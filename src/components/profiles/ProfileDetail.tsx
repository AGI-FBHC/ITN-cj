/**
 * ProfileDetail — 选中画像详情区（profiles.md S3，双栏 7:5）
 * 左：知识雷达（当前水平 vs 岗位目标）+ 先验知识档案
 * 右：技能盲区标签墙 + DIA-01 诊断报告摘要（打字机）
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { GraduationCap, BookOpen, Briefcase, BadgeCheck, ArrowUpRight } from 'lucide-react';
import type { Learner } from '@/data/learners';
import { knowledgePoints } from '@/data/knowledgePoints';
import { abilityName } from '@/data/abilityDimensions';
import ChartCard, { ReactECharts } from '@/components/ChartCard';
import AgentChip from '@/components/AgentChip';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { Severity } from './profileMeta';
import { learnerUiMeta } from './profileMeta';
import Typewriter from './Typewriter';
import { cn } from '@/lib/utils';

const severityClass: Record<Severity, string> = {
  高: 'border-brand-danger/60 bg-brand-danger text-paper',
  中: 'border-brand-amber/50 bg-brand-amber-tint text-ochre',
  低: 'border-hairline bg-paper text-ink-muted',
};

function BlindWall({ learner }: { learner: Learner }) {
  const meta = learnerUiMeta[learner.id];
  return (
    <div className="lf-card p-5">
      <div className="lf-mono-label mb-1">BLIND-SPOT WALL</div>
      <h3 className="mb-3 text-[16px] font-semibold leading-[24px] text-ink">技能盲区标签墙</h3>
      <div className="flex flex-wrap gap-2">
        <TooltipProvider delayDuration={200}>
          {meta.blindWall.map((b, i) => (
            <Tooltip key={b.label}>
              <TooltipTrigger asChild>
                <motion.span
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ delay: 0.1 + i * 0.05, type: 'spring', stiffness: 260, damping: 18 }}
                  className={cn(
                    'inline-flex cursor-default items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] font-medium',
                    severityClass[b.severity],
                  )}
                >
                  {b.label}
                  <span
                    className={cn(
                      'rounded px-1 font-mono text-[10px] font-semibold',
                      b.severity === '高' && 'bg-paper/25 text-paper',
                      b.severity === '中' && 'bg-brand-amber/20 text-ochre',
                      b.severity === '低' && 'bg-paper-deep text-ink-muted',
                    )}
                  >
                    {b.severity}
                  </span>
                </motion.span>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="max-w-[280px] border-hairline bg-card-warm font-mono text-[11.5px] leading-[17px] text-ink-2 shadow-warm"
              >
                {b.evidence}
              </TooltipContent>
            </Tooltip>
          ))}
        </TooltipProvider>
      </div>
      <p className="mt-3 text-[12px] leading-[18px] text-ink-muted">
        严重度由 DIA-01 依据理论测试与近 3 次交互练习正确率联合判定。
      </p>
    </div>
  );
}

function DiagnosisCard({ learner }: { learner: Learner }) {
  const navigate = useNavigate();
  const meta = learnerUiMeta[learner.id];
  const text = useMemo(
    () => `${learner.diagnosisSummary.replace(/^DIA-01 诊断：/, '')}\n阶段目标：${learner.goal}`,
    [learner],
  );
  return (
    <div className="lf-card border-l-[3px] !border-l-brand p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <AgentChip agentId="DIA-01" />
        <span className="font-mono text-[11px] text-ink-muted">诊断报告 · 生成于 10:41:44</span>
      </div>
      <Typewriter
        key={learner.id}
        text={text}
        speed={16}
        className="min-h-[96px] text-[13.5px] leading-[23px] text-ink-2"
      />
      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-hairline pt-3">
        <span className="mr-1 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-muted">
          推荐路径
        </span>
        {meta.pathChips.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => navigate('/report')}
            className="group inline-flex items-center gap-1 rounded-lg border border-brand/35 bg-transparent px-2.5 py-1 text-[12.5px] font-medium text-brand transition-all duration-200 hover:border-brand/60 hover:bg-brand-tint"
          >
            {c}
            <ArrowUpRight size={12} className="transition-transform duration-200 group-hover:translate-x-0.5" />
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ProfileDetail({ learner }: { learner: Learner }) {
  const meta = learnerUiMeta[learner.id];

  const radarOption = useMemo(() => {
    const scores = knowledgePoints.map((kp) => learner.scores[kp.id] ?? 0);
    const targets = knowledgePoints.map((kp) => kp.targetLevel);
    return {
      animationDuration: 800,
      animationDelay: (idx: number) => idx * 40,
      tooltip: { trigger: 'item' as const },
      legend: {
        bottom: 0,
        icon: 'roundRect',
        itemWidth: 12,
        itemHeight: 8,
        data: ['当前水平', '岗位目标'],
      },
      radar: {
        indicator: knowledgePoints.map((kp) => ({ name: abilityName(kp.id, kp.name), max: 100 })),
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
          data: [
            {
              value: scores,
              name: '当前水平',
              lineStyle: { color: '#4E7860', width: 2.5 },
              itemStyle: { color: '#4E7860' },
              areaStyle: { color: 'rgba(78, 120, 96,0.22)' },
            },
            {
              value: targets,
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

  const [eduLevel, major] = useMemo(() => learner.education.split(' · '), [learner]);
  const archiveItems = [
    { icon: GraduationCap, label: '学历 / 院校', value: `${eduLevel} · ${learner.school}` },
    { icon: BookOpen, label: '专业', value: major ?? learner.role },
    { icon: Briefcase, label: '工龄 / 实训', value: meta.workExp },
    { icon: BadgeCheck, label: '持证', value: meta.certificate },
  ];

  return (
    <div className="grid gap-5 lg:grid-cols-12">
      {/* 左栏 7 */}
      <div className="space-y-5 lg:col-span-7">
        <ChartCard title="知识雷达图" en="KNOWLEDGE RADAR · 6-DIM">
          <ReactECharts option={radarOption} height={320} />
        </ChartCard>

        <div className="lf-card p-5">
          <div className="lf-mono-label mb-1">PRIOR-KNOWLEDGE ARCHIVE</div>
          <h3 className="mb-4 text-[16px] font-semibold leading-[24px] text-ink">先验知识档案</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {archiveItems.map((it) => (
              <div
                key={it.label}
                className="flex items-start gap-3 rounded-[10px] border border-hairline bg-paper px-3.5 py-3"
              >
                <it.icon size={17} strokeWidth={1.75} className="mt-0.5 shrink-0 text-brand" />
                <div className="min-w-0">
                  <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-muted">
                    {it.label}
                  </div>
                  <div className="mt-0.5 truncate text-[13.5px] font-medium leading-[20px] text-ink">
                    {it.value}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 border-t border-hairline pt-3 font-mono text-[11.5px] leading-[18px] text-ink-muted">
            理论测试卷 A · 2025-11-28 导入 · 成绩已校验
          </div>
        </div>
      </div>

      {/* 右栏 5 */}
      <div className="space-y-5 lg:col-span-5">
        <BlindWall learner={learner} />
        <DiagnosisCard learner={learner} />
      </div>
    </div>
  );
}
