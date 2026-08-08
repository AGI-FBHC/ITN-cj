/**
 * 学情报告 `/report`（report.md）
 * S1 页面头 + 综合评分带 / S2 知识盲区定位（雷达+排序）/ S3 资源难度匹配曲线
 * S4 学习路径规划图（SVG 路线图）/ S5 成长曲线+ARB 建议 / S6 报告导出条
 * 全页数据随 ProfileContext 当前画像切换（getReportFor(currentLearner.id)）
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import { FileDown, Share2, Route, ArrowRight, ChevronDown, BarChart3 } from 'lucide-react';
import { useProfile, dataIdOf } from '@/context/ProfileContext';
import { activePathNode } from '@/data/reportData';
import { reportForLearner } from '@/data/reportBuilder';
import PageBack from '@/components/PageBack';
import { resolveLearnTarget } from '@/data/resources';
import { BlossomBranch, Succulent } from '@/components/heal/Flora';
import SectionHeader from '@/components/SectionHeader';
import LiveDot from '@/components/LiveDot';
import ScoreBand from '@/components/report/ScoreBand';
import GapSection from '@/components/report/GapSection';
import DifficultyMatch from '@/components/report/DifficultyMatch';
import PathRoadmap from '@/components/report/PathRoadmap';
import GrowthSection from '@/components/report/GrowthSection';
import { cn } from '@/lib/utils';

export default function Report() {
  const navigate = useNavigate();
  const { currentLearner, viewMode } = useProfile();
  const isLearner = viewMode === 'learner';
  const dataId = dataIdOf(currentLearner);
  const report = useMemo(() => reportForLearner(currentLearner), [currentLearner]);
  const nextNode = activePathNode(report);
  const pageTitle = isLearner ? '我的成长' : '学情报告';
  /* 学习者视角：图表分析默认折叠，首屏只留「结论 + 盲区 + 路径」 */
  const [analysisOpen, setAnalysisOpen] = useState(false);

  /* 导出完整报告 → 真实打印：若图表分析仍折叠先展开，等渲染完再唤起打印 */
  const exportReport = () => {
    if (!analysisOpen) setAnalysisOpen(true);
    setTimeout(() => window.print(), 300);
  };

  return (
    <div className={`mx-auto ${isLearner ? 'max-w-[920px] px-5 md:px-6' : 'max-w-[1320px] px-8'} py-10`}>
      {isLearner && <PageBack parent={{ label: '我的学习', to: '/me' }} current="我的成长" />}

      {/* ============ S1 页面头 ============ */}
      <div className="relative mb-8 flex flex-wrap items-end justify-between gap-6">
        {/* 成长页植物：花枝（成果绽放） */}
        {isLearner && (
          <BlossomBranch className="pointer-events-none absolute -top-6 right-0 hidden h-[72px] w-[110px] opacity-90 lg:block print:hidden" />
        )}
        <div className="max-w-[640px]">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
            className="lf-mono-label mb-3 flex items-center gap-2"
          >
            <span className="inline-block h-px w-6 bg-brand/40" />
            {isLearner ? '我的成长 · 看进步' : 'LEARNING ANALYTICS'}
          </motion.div>
          <h1 className="font-serif text-[36px] font-bold leading-[44px] text-ink">
            {pageTitle.split('').map((ch, i) => (
              <motion.span
                key={i}
                className="inline-block"
                initial={{ opacity: 0, y: 28 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              >
                {ch}
              </motion.span>
            ))}
          </h1>
          <motion.p
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15, duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            className="mt-3 text-[14.5px] leading-[24px] text-ink-muted"
          >
            {isLearner
              ? '这是你近 8 周的进步记录：哪些盲区在收窄、学习路径走到哪、下一步该攻克什么，AI 都替你标好了。'
              : '由学情诊断 Agent 持续维护，决策仲裁 Agent 据此刻意调度。报告周期：近 8 周。'}
          </motion.p>
        </div>

        {/* 当前画像 chip — 报告数据随其切换 */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          className="lf-card flex items-center gap-3 px-4 py-3"
        >
          <img
            src={currentLearner.avatar}
            alt={currentLearner.name}
            className="h-10 w-10 rounded-full border border-hairline object-cover"
          />
          <div className="leading-tight">
            <div className="lf-mono-label !text-[10px]">{isLearner ? '这份报告属于' : '报告对象'}</div>
            <div className="mt-0.5 text-[14.5px] font-semibold text-ink">{currentLearner.name}</div>
          </div>
          <LiveDot status="running" className="ml-1" />
        </motion.div>
      </div>

      {/* 继续学习路径 — 把成长页接回学习闭环的主 CTA */}
      {isLearner && nextNode && (
        <motion.button
          type="button"
          onClick={() => navigate(resolveLearnTarget(dataId, nextNode.kpId, nextNode.title).to)}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="lf-glow-card group relative mb-8 flex w-full items-center gap-4 rounded-[14px] bg-brand-tint/50 px-5 py-4 text-left transition-all hover:bg-brand-tint print:hidden"
        >
          {/* 多肉点缀 */}
          <Succulent className="pointer-events-none absolute -top-4 right-6 hidden h-[52px] w-[44px] sm:block print:hidden" />
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-paper shadow-warm">
            <Route size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="text-[11px] font-semibold tracking-wide text-ochre">下一步 · 已为你排好</span>
            <span className="mt-0.5 block truncate text-[15.5px] font-semibold text-ink">
              继续学习路径：{nextNode.title}
            </span>
            <span className="mt-0.5 block truncate text-[12.5px] text-ink-muted">
              {nextNode.est} · {nextNode.resourceRef}
            </span>
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-[10px] bg-brand px-3.5 py-2 text-[13.5px] font-medium text-paper transition-transform group-hover:translate-x-0.5">
            去学 <ArrowRight size={14} />
          </span>
        </motion.button>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={currentLearner.id}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        >
          {/* 综合评分带 */}
          <div className="print:break-inside-avoid">
            <ScoreBand report={report} />
          </div>

          {/* ============ S2 知识盲区定位 ============ */}
          <div className="mt-16 print:break-inside-avoid">
            <SectionHeader
              en={isLearner ? undefined : 'BLIND-SPOT LOCALIZATION'}
              title={isLearner ? '我的知识盲区' : '知识盲区定位'}
              desc={isLearner ? undefined : '当前能力与目标要求的六维缺口：雷达缺口区域砖红强调，右侧按缺口降序给出消解计划。'}
            />
            <GapSection learner={currentLearner} report={report} />
          </div>

          {/* S3 资源难度匹配曲线 —— 图表分析，学习者视角折叠 */}
          {!isLearner && (
            <div className="mt-16 print:break-inside-avoid">
              <DifficultyMatch learner={currentLearner} report={report} />
            </div>
          )}

          {/* ============ S4 学习路径规划图 ============ */}
          <div className="mt-16 print:break-inside-avoid">
            <PathRoadmap learner={currentLearner} report={report} />
          </div>

          {/* S5 成长曲线 + 建议 —— 图表分析，学习者视角折叠 */}
          {!isLearner && (
            <div className="mt-16 print:break-inside-avoid">
              <SectionHeader
                en="GROWTH × ARBITRATION"
                title="能力成长与 Agent 介入"
                desc="每一次曲线抬升背后都有一次可溯源的多智能体决策——介入点即协同证据。"
              />
              <GrowthSection learner={currentLearner} report={report} />
            </div>
          )}

          {/* 学习者视角：把两块图表分析收进一个折叠区，首屏不超载 */}
          {isLearner && (
            <div className="mt-10">
              <button
                type="button"
                onClick={() => setAnalysisOpen((v) => !v)}
                className="flex w-full items-center gap-3 rounded-[14px] border border-hairline bg-card-warm/70 px-4 py-3 text-left transition-all hover:border-brand/40 print:hidden"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-tint text-brand">
                  <BarChart3 size={17} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium text-ink">想看更细的分析？</span>
                  <span className="block text-[12px] text-ink-muted">难度匹配曲线 · 能力成长走势（可选）</span>
                </span>
                <ChevronDown size={16} className={cn('shrink-0 text-ink-muted transition-transform', analysisOpen && 'rotate-180')} />
              </button>

              {analysisOpen && (
                <div className="lf-anim-in-up mt-5 space-y-16">
                  <div className="print:break-inside-avoid">
                    <DifficultyMatch learner={currentLearner} report={report} />
                  </div>
                  <div className="print:break-inside-avoid">
                    <SectionHeader title="我的能力成长" />
                    <GrowthSection learner={currentLearner} report={report} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ============ S6 报告导出条（学习者视角隐藏，属导师/系统功能） ============ */}
          {!isLearner && (
          <div className="mt-14 flex flex-wrap items-center justify-between gap-4 border-t border-hairline pt-5 print:hidden">
            <span className="font-mono text-[11.5px] tracking-wide text-ink-muted">
              REPORT ID · LF-RPT-2025-1204 · {currentLearner.name} · 周期 W44-W51
            </span>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={exportReport}
                className="lf-btn-primary !px-4 !py-2 !text-[13.5px]"
              >
                <FileDown size={15} strokeWidth={1.75} />
                导出完整报告
              </button>
              <button
                type="button"
                onClick={() =>
                  toast.success('分享链接已复制（演示）', {
                    description: '导师可通过链接查看只读报告',
                  })
                }
                className="lf-btn-ghost !px-4 !py-2 !text-[13.5px]"
              >
                <Share2 size={15} strokeWidth={1.75} />
                分享给导师
              </button>
            </div>
          </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
