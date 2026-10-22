/**
 * SummaryCard — 课后小结（tutoring.md S5）
 * 本节收获数据带 + 掌握度评估（更新后细环）+ ARB-05 总结语 + 下一步建议（优先级列表）+ 双 CTA（分阶题 / 画像）
 * 完成「交互反馈 → 动态决策更新」闭环最后一环
 */
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  BadgeCheck,
  BarChart3,
  ChevronDown,
  ListChecks,
  Route,
  Scale,
  TrendingUp,
} from 'lucide-react';
import type { Learner } from '@/data/learners';
import type { TutoringScript } from '@/data/tutoringScript';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import { dataIdOf } from '@/context/ProfileContext';
import { nextPathNodeAfter } from '@/data/reportData';
import { reportForLearner } from '@/data/reportBuilder';
import { resolveLearnTarget } from '@/data/resources';
import { cn } from '@/lib/utils';
import { MasteryRing } from './SidePanel';
import type { KpTopic } from './SidePanel';

/** 统一缓动曲线（design.md 动效规范） */
const easeLf = [0.22, 1, 0.36, 1] as [number, number, number, number];

/** 优先级 → 徽标色（高=砖红 / 中=琥珀 / 低=灰） */
const priorityTone: Record<'高' | '中' | '低', string> = {
  高: 'text-brand-danger border-brand-danger/40 bg-brand-danger/10',
  中: 'text-brand-amber border-brand-amber/40 bg-brand-amber/10',
  低: 'text-ink-muted border-hairline bg-paper-deep/60',
};

export default function SummaryCard({
  learner,
  script,
  topics,
  asked,
  correct,
  isLearner,
  decisionCount,
}: {
  learner: Learner;
  script: TutoringScript;
  topics: KpTopic[];
  asked: number;
  correct: number;
  isLearner: boolean;
  /** 本轮触发的决策次数（含降维解释/进阶挑战），供「本节收获」数据带展示；未传显示 -- */
  decisionCount?: number;
}) {
  const navigate = useNavigate();
  const kp = getKnowledgePoint(script.kpId);
  const score = learner.scores[script.kpId] ?? 50;
  const dataId = dataIdOf(learner);
  const report = reportForLearner(learner);
  const nextNode = nextPathNodeAfter(report, script.kpId);
  const acc = asked > 0 ? Math.round((correct / asked) * 100) : 0;

  /* 「本节收获」三格数据 */
  const gainStats = [
    { label: '掌握度 Δ', value: `${score} → ${score + 6}`, icon: TrendingUp, tone: 'text-brand-success' },
    { label: '本轮答题', value: `${correct}/${asked}`, icon: ListChecks, tone: 'text-ink-2' },
    {
      label: '触发决策',
      value: decisionCount !== undefined ? `${decisionCount} 次` : '--',
      icon: Scale,
      tone: 'text-agent-arb',
    },
  ];

  /* 「下一步建议」三条：本节盲区（画像层）/ 强项巩固（进阶）/ 路径下一节点，均可导航 */
  const weakestSpot = report.blindSpots[0];
  const weakestKp = weakestSpot ? getKnowledgePoint(weakestSpot.kpId) : kp;
  const suggestions: {
    id: string;
    priority: '高' | '中' | '低';
    title: string;
    desc: string;
    evidence: string;
    to: string;
  }[] = [
    {
      id: 'gap',
      priority: '高',
      title: `优先攻克盲区 ·「${weakestKp.name}」`,
      desc: '画像上排序最靠前的短板，建议先去实操指南补齐。',
      evidence: `依据：本轮正确率 ${acc}% · 画像盲区排序 Top1（缺口 ${weakestSpot?.gap ?? 0} 分）`,
      to: resolveLearnTarget(dataId, weakestKp.id, '实操指南').to,
    },
    {
      id: 'strength',
      priority: '中',
      title: '保持强项 · 挑战进阶分阶题',
      desc: `「${kp.name}」本轮表现稳定，可挑战更高难度题巩固。`,
      evidence: `依据：本轮正确率 ${acc}% · 进入进阶区间`,
      to: '/resources?tab=quiz',
    },
    {
      id: 'next',
      priority: '低',
      title: nextNode ? `预习下一节 ·《${nextNode.title}》` : '巩固当前节点',
      desc: nextNode ? '学习路径的下一步，提前预习能衔接得更顺。' : '暂无下一节点，继续巩固当前内容即可。',
      evidence: '依据：学习路径节点排序 · 按缺口降序',
      to: nextNode ? resolveLearnTarget(dataId, nextNode.kpId, nextNode.title).to : '/report',
    },
  ];
  const [expandedTip, setExpandedTip] = useState<string | null>(null);

  return (
    <motion.div
      initial={{ opacity: 0, y: 18, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden rounded-[14px] border border-brand/30 bg-card-warm"
    >
      <div className="h-1 w-full bg-gradient-to-r from-brand via-brand-amber to-ochre" />
      <div className="p-5">
        {/* 「灵光一闪」金色发光球绽放 */}
        <div className="lf-bloom relative mx-auto mb-3 h-14 w-14">
          <span className="lf-orb absolute inset-0" />
          <span className="absolute inset-0 flex items-center justify-center">
            <BadgeCheck size={24} strokeWidth={2.2} className="text-paper" />
          </span>
        </div>
        <div className="text-center font-serif text-[16px] font-semibold text-ink">本节小结 · 导学闭环完成</div>

        {/* 本节收获：三格数据带（stagger 进场） */}
        <motion.div
          initial="hidden"
          animate="show"
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.08 } } }}
          className="mt-4 grid grid-cols-3 gap-2.5"
        >
          {gainStats.map((s) => (
            <motion.div
              key={s.label}
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
              transition={{ duration: 0.35, ease: easeLf }}
              className="rounded-[10px] border border-hairline bg-paper p-2.5 text-center"
            >
              <div className="flex items-center justify-center gap-1 font-mono text-[9.5px] text-ink-muted">
                <s.icon size={10} /> {s.label}
              </div>
              <div className={cn('mt-1 font-mono text-[13px] font-semibold tabular', s.tone)}>{s.value}</div>
            </motion.div>
          ))}
        </motion.div>

        {/* 掌握度评估 */}
        <div className="mt-4 grid gap-2.5 sm:grid-cols-3">
          {topics.map((t) => (
            <div
              key={t.topic}
              className="flex items-center gap-2.5 rounded-[10px] border border-hairline bg-paper p-3"
            >
              <MasteryRing value={Math.min(98, t.mastery + 6)} size={36} />
              <div className="min-w-0">
                <div className="truncate text-[12.5px] font-semibold text-ink">{t.topic}</div>
                <div className="font-mono text-[10px] text-brand-success tabular">
                  +6 ↑ 已回写
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* ARB-05 总结 */}
        <div className="mt-3.5 rounded-[10px] border border-hairline bg-paper-deep/70 p-3.5">
          <div className="flex items-center gap-1.5 font-mono text-[10.5px] font-medium text-agent-arb">
            <Scale size={11} /> ARB-05 · 仲裁总结
          </div>
          <p className="mt-1.5 text-[13px] leading-[21px] text-ink-2">
            本轮作答 {asked} 题、命中 {correct} 题；{learner.name} 在「{kp.name}」的因果链已闭合。
            画像向量 {score} → {score + 6} 已回写，下一步建议用分阶题巩固，并复查更新后的画像雷达。
          </p>
        </div>

        {/* 下一步建议：ARB-05 署名，按优先级排序，点行展开决策依据，右侧箭头直达 */}
        <div className="mt-3.5 rounded-[10px] border border-hairline bg-paper p-3.5">
          <div className="flex items-center gap-1.5 font-mono text-[10.5px] font-medium text-agent-arb">
            <Scale size={11} /> ARB-05 · 下一步建议
          </div>
          <ul className="mt-2 space-y-1.5">
            {suggestions.map((s) => {
              const isOpen = expandedTip === s.id;
              return (
                <li
                  key={s.id}
                  className={cn(
                    'overflow-hidden rounded-[10px] border transition-colors duration-200',
                    isOpen ? 'border-brand/30 bg-brand-tint/25' : 'border-hairline bg-card-warm',
                  )}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setExpandedTip(isOpen ? null : s.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') setExpandedTip(isOpen ? null : s.id);
                    }}
                    aria-expanded={isOpen}
                    className="flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left"
                  >
                    <span
                      className={cn(
                        'shrink-0 rounded-md border px-1.5 py-px font-mono text-[10px] font-semibold',
                        priorityTone[s.priority],
                      )}
                    >
                      {s.priority}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-medium text-ink">{s.title}</div>
                      <div className="truncate text-[11px] text-ink-muted">{s.desc}</div>
                    </div>
                    <motion.span
                      animate={{ rotate: isOpen ? 180 : 0 }}
                      transition={{ duration: 0.25, ease: easeLf }}
                      className="shrink-0 text-ink-muted"
                    >
                      <ChevronDown size={13} />
                    </motion.span>
                    {/* 导航箭头：单独可点区域，直达对应资源，不触发展开 */}
                    <button
                      type="button"
                      title="去这里看看"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(s.to);
                      }}
                      className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-hairline bg-paper text-brand transition-all duration-200 hover:-translate-y-px hover:border-brand/40 hover:shadow-warm"
                    >
                      <ArrowRight size={12} />
                    </button>
                  </div>
                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        key="evidence"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.28, ease: easeLf }}
                        className="overflow-hidden"
                      >
                        <p className="border-t border-hairline px-2.5 py-2 font-mono text-[10.5px] text-ink-muted">
                          {s.evidence}
                        </p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </li>
              );
            })}
          </ul>
        </div>

        {/* 出口 CTA — 把练习接回学习闭环：继续路径 / 巩固 / 看进步 */}
        <div className="mt-4 space-y-2.5">
          {nextNode && (
            <button
              type="button"
              onClick={() => navigate(resolveLearnTarget(dataId, nextNode.kpId, nextNode.title).to)}
              className="lf-btn-primary group w-full !justify-start !py-2.5 text-[13.5px]"
            >
              <Route size={15} />
              继续学习路径 · 下一步《{nextNode.title}》
              <ArrowRight size={14} className="ml-auto transition-transform group-hover:translate-x-0.5" />
            </button>
          )}
          <div className="flex flex-wrap gap-2.5">
            <Link to="/resources?tab=quiz" className="lf-btn-ghost flex-1 !py-2.5 text-[13.5px]">
              <ListChecks size={14} /> 去做分阶题巩固
            </Link>
            <Link
              to={isLearner ? '/report' : '/profiles'}
              className="lf-btn-ghost flex-1 !py-2.5 text-[13.5px]"
            >
              <BarChart3 size={14} /> {isLearner ? '去我的成长看变化' : '查看更新后的画像'}
            </Link>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
