/**
 * GrowthSection — 能力成长曲线 + Agent 介入点（report.md S5，双栏 7:5）
 * 左：近 8 周测评分趋势（墨绿线 + 面积渐变 + 3 个 Agent 介入标注）
 * 右：ARB-05 本周调度建议
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, ChevronDown, Loader2, Wrench, ClipboardCheck, BookOpen } from 'lucide-react';
import type { Learner } from '@/data/learners';
import type { LearnerReport } from '@/data/reportData';
import type { GraphNode } from '@/data/knowledgeGraph';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import ChartCard, { ReactECharts } from '@/components/ChartCard';
import AgentChip from '@/components/AgentChip';
import { useProfile } from '@/context/ProfileContext';
import { api, type LearningResourceSummary } from '@/lib/api';
import type { Severity } from '@/components/profiles/profileMeta';
import { cn } from '@/lib/utils';
import { learnMapPath } from '@/lib/learnNav';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const easeLf: [number, number, number, number] = [0.22, 1, 0.36, 1];

/** 建议优先级徽标色调：高危砖红 / 中等琥珀 / 低优先灰调（与 GapSection priorityTone 同源） */
const priorityBadge: Record<Severity, string> = {
  高: 'border-brand-danger/40 bg-brand-danger/10 text-brand-danger',
  中: 'border-brand-amber/50 bg-brand-amber-tint text-ochre',
  低: 'border-hairline bg-paper-deep text-ink-muted',
};

interface Intervention {
  week: string;
  title: string;
  desc: string;
  color: string;
}

/** 预设画像的静态介入点；自建画像用报告自带的真实写回事件（report.interventions） */
const staticInterventions: Intervention[] = [
  { week: 'W3', title: '降维解释介入', desc: '正确率 52% → 次周 71%', color: '#4E7860' },
  { week: 'W5', title: '进阶挑战下发', desc: '正确率 84% 触发挑战题组', color: '#E7B45A' },
  { week: 'W7', title: '资源难度回调 +8%', desc: 'ARB-05 依据近 3 次测评动态调整', color: '#B77552' },
];

function GrowthChart({ report }: { report: LearnerReport }) {
  const interventions = useMemo<Intervention[]>(
    () =>
      (report.generated ? report.interventions ?? [] : staticInterventions).filter((it) =>
        report.weeks.includes(it.week),
      ),
    [report],
  );
  const option = useMemo(() => {
    const idxOf = (w: string) => report.weeks.indexOf(w);
    return {
      animationDuration: 1000,
      tooltip: {
        trigger: 'axis' as const,
        formatter: (params: unknown) => {
          const list = params as { axisValue: string; value: number }[];
          const p = list[0];
          if (!p) return '';
          const hit = interventions.find((it) => it.week === p.axisValue);
          return [
            `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:#66725E;margin-bottom:4px">${p.axisValue}${report.generated ? '' : ' · 近 8 周'}</div>`,
            `<div style="font-size:12px;line-height:20px">综合测评分 <b>${p.value}</b></div>`,
            hit
              ? `<div style="font-size:12px;line-height:18px;margin-top:4px;padding-top:4px;border-top:1px dashed #DCE6DE;color:${hit.color};font-weight:600">${hit.title}<br/><span style="color:#5A6553;font-weight:400">${hit.desc}</span></div>`
              : '',
          ].join('');
        },
      },
      grid: { top: 44, left: 16, right: 24, bottom: 8, containLabel: true },
      xAxis: { type: 'category' as const, data: report.weeks, boundaryGap: false },
      yAxis: { type: 'value' as const, min: 40, max: 100 },
      series: [
        {
          name: '综合测评分',
          type: 'line' as const,
          data: report.adaptTrend,
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          lineStyle: { color: '#4E7860', width: 2.8, cap: 'round' as const, join: 'round' as const },
          itemStyle: { color: '#4E7860', borderColor: '#FBFAF5', borderWidth: 2 },
          areaStyle: {
            /* 水彩：柔绿→透明，中段带一点暖光 */
            color: {
              type: 'linear' as const,
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(155,197,172,0.42)' },
                { offset: 0.55, color: 'rgba(155,197,172,0.16)' },
                { offset: 1, color: 'rgba(231,180,90,0.04)' },
              ],
            },
          },
          markPoint: {
            symbol: 'circle',
            symbolSize: 10,
            label: { show: false },
            data: interventions.map((it, i) => ({
              coord: [idxOf(it.week), report.adaptTrend[idxOf(it.week)]],
              itemStyle: { color: it.color, borderColor: '#FBFAF5', borderWidth: 2 },
              animationDelay: 600 + i * 150,
            })),
          },
          markLine: {
            silent: true,
            symbol: 'none',
            animationDuration: 500,
            data: interventions.map((it) => ({
              xAxis: it.week,
              lineStyle: { color: it.color, type: 'dashed' as const, width: 1 },
              label: {
                formatter: it.title,
                position: 'insideEndTop' as const,
                fontSize: 10,
                fontFamily: '"IBM Plex Mono", monospace',
                color: it.color,
              },
            })),
          },
        },
      ],
    };
  }, [report]);

  return (
    <ChartCard
      title="能力成长曲线"
      en={report.generated ? 'GROWTH × LIVE WRITEBACKS' : '8-WEEK GROWTH × AGENT INTERVENTIONS'}
    >
      <ReactECharts option={option} height={300} />
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-hairline pt-2.5">
        {interventions.map((it) => (
          <span key={it.week} className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-2">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: it.color }} />
            <span className="font-mono text-[10.5px]">{it.week}</span>
            {it.title}
          </span>
        ))}
        {report.generated && report.adaptTrend.length <= 1 && (
          <span className="text-[11.5px] text-ink-muted">
            暂无测评记录，当前只展示真实能力分；完成分阶题后会按真实测评点生成曲线。
          </span>
        )}
      </div>
    </ChartCard>
  );
}

interface AdviceItem {
  icon: typeof Wrench;
  text: string;
  cta: string;
  href: string;
  kpId?: string;
  priority: Severity;
  evidence: string;
}

function resourceTargetFor(
  resources: LearningResourceSummary[],
  hint: string,
  fallback: string,
): string {
  const lower = `${hint}`.toLowerCase();
  const typeHint = /测|quiz/.test(lower) ? 'quiz' : /实操|guide|practice/.test(lower) ? 'practice' : undefined;
  const pooled = resources.filter((resource) => !resource.learned && (!typeHint || resource.type === typeHint));
  const target = pooled[0] ?? resources.find((resource) => !resource.learned) ?? resources[0];
  return target ? `/learn/resource/${encodeURIComponent(target.id)}` : fallback;
}

interface AdviceMapTarget {
  chapterId: string | null;
  topicId: string | null;
}

function adviceTargetFor(
  learnerId: string,
  nodes: GraphNode[],
  kpId: string | undefined,
  hint: string,
  fallback: AdviceMapTarget,
): string {
  const normalizedKpId = kpId?.trim()
    || hint.match(/\b(?:kp-\d+-\d+|ch\d+[\w-]*|kp-[a-z0-9-]+)\b/)?.[0]
    || '';
  if (normalizedKpId) {
    const node = nodes.find((item) => item.id === normalizedKpId || item.kpId === normalizedKpId);
    if (node?.kind === 'domain') return learnMapPath(learnerId, node.id);
    if (node?.kind === 'topic') {
      const parent = nodes.find((item) => item.kind === 'domain' && item.id === node.kpId);
      return learnMapPath(learnerId, parent?.id ?? node.kpId, node.id);
    }
  }
  return fallback.chapterId
    ? learnMapPath(learnerId, fallback.chapterId, fallback.topicId)
    : learnMapPath(learnerId);
}

/** 建议卡：点击整行直达对应资源；右下箭头仅用于展开/收起「决策依据」 */
function AdviceRow({
  advice,
  index,
  navigate,
}: {
  advice: AdviceItem;
  index: number;
  navigate: (href: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const Icon = advice.icon;
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.4 }}
      transition={{ delay: index * 0.08, duration: 0.5, ease: easeLf }}
      className="rounded-[10px] border border-hairline bg-paper transition-all duration-200 hover:border-brand/30 hover:shadow-warm"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => navigate(advice.href)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') navigate(advice.href);
        }}
        className="group flex w-full cursor-pointer items-start gap-3 p-3.5 text-left"
      >
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hairline bg-card-warm text-ink-2">
          <Icon size={15} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1 text-[13px] leading-[21px] text-ink-2">
          <span className="mr-1.5 inline-flex items-center gap-1.5">
            <span className="font-mono text-[11px] font-semibold text-brand">
              {['①', '②', '③'][index]}
            </span>
            <span className={cn('rounded-md border px-1.5 py-px text-[10px] font-medium', priorityBadge[advice.priority])}>
              {advice.priority}优先
            </span>
          </span>
          {advice.text}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            navigate(advice.href);
          }}
          className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-brand transition-colors hover:text-brand/80"
        >
          {advice.cta}
          <ArrowRight
            size={13}
            className="transition-transform duration-200 group-hover:translate-x-[3px]"
          />
        </button>
        <button
          type="button"
          aria-label="查看建议依据"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          className="mt-0.5 shrink-0 rounded-md p-0.5 text-ink-muted hover:bg-paper-deep hover:text-brand"
        >
          <ChevronDown
            size={14}
            className={cn('transition-transform duration-200', open && 'rotate-180')}
          />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: easeLf }}
            className="overflow-hidden"
          >
            <div className="border-t border-hairline py-2.5 pl-[52px] pr-3.5 font-mono text-[11px] leading-[17px] text-ink-muted">
              {advice.evidence}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function GrowthTrendChart({ report }: { report: LearnerReport }) {
  return <GrowthChart report={report} />;
}

export function WeeklyAdviceCard({
  learner,
  report,
  resources,
  nodes = [],
  fallbackTarget,
  className,
}: {
  learner: Learner;
  report: LearnerReport;
  resources: LearningResourceSummary[];
  nodes?: GraphNode[];
  fallbackTarget?: AdviceMapTarget;
  className?: string;
}) {
  const navigate = useNavigate();
  const { viewMode, currentLearner } = useProfile();
  const isLearner = viewMode === 'learner';
  const [advisorAdvice, setAdvisorAdvice] = useState<AdviceItem[] | null>(null);
  const [advisorLoading, setAdvisorLoading] = useState(false);

  const fallbackAdvice = useMemo<AdviceItem[]>(() => {
    const sorted = [...report.blindSpots].sort((a, b) => b.gap - a.gap);
    const top = sorted[0];
    const second = sorted[1] ?? sorted[0];
    const topKp = getKnowledgePoint(top.kpId);
    const secondKp = getKnowledgePoint(second.kpId);
    const strongest = Object.entries(learner.scores).sort((a, b) => b[1] - a[1])[0];
    const strongestKp = getKnowledgePoint(strongest[0]);
    /* 近 N 周综合分提升（用于决策依据展示，自建画像沿用真实建档→当前的差值） */
    const growth = Math.round(
      (report.adaptTrend[report.adaptTrend.length - 1] ?? 0) - (report.adaptTrend[0] ?? 0),
    );
    const weekSpan = report.weeks.length > 1 ? report.weeks.length - 1 : 0;
    return [
      {
        icon: Wrench,
        text: `${topKp.name}仍为最大盲区（Δ -${top.gap}），建议本周完成已配案例与实操指南`,
        cta: '去实操',
        href: resourceTargetFor(resources, '实操', '/resources'),
        priority: top.priority as Severity,
        evidence: `依据：当前能力与目标相差 ${top.gap} 分 · 近 ${weekSpan} 周变化 ${growth >= 0 ? '+' : ''}${growth} 分`,
      },
      {
        icon: ClipboardCheck,
        text: `${strongestKp.name}目前 ${strongest[1]} 分，可以做几道题巩固`,
        cta: '去测评',
        href: resourceTargetFor(resources, '测评', '/resources'),
        priority: '中' as Severity,
        evidence: `依据：${strongestKp.name} 当前 ${strongest[1]} 分`,
      },
      {
        icon: BookOpen,
        text: `${secondKp.name}可以先看讲义，再做分阶练习`,
        cta: '查看',
        href: resourceTargetFor(resources, '讲义', '/resources'),
        priority: second.priority as Severity,
        evidence: `依据：当前能力与目标相差 ${second.gap} 分`,
      },
    ];
  }, [learner, report, resources]);

  const advisorKpId = report.blindSpots[0]?.kpId;
  /* 跳转地址在渲染时统一按最新知识网络节点解析，避免接口返回时节点还没加载完而退化成 /resources */
  const advice = useMemo(() => {
    const source = advisorAdvice ?? fallbackAdvice;
    const learnerId = currentLearner.id || learner.id;
    return source.map((item) => ({
      ...item,
      href: adviceTargetFor(learnerId, nodes, item.kpId, `${item.cta} ${item.text}`, fallbackTarget ?? { chapterId: null, topicId: null }),
    }));
  }, [advisorAdvice, currentLearner.id, fallbackAdvice, fallbackTarget, learner.id, nodes]);

  useEffect(() => {
    if (!UUID_PATTERN.test(learner.id)) {
      setAdvisorLoading(false);
      return;
    }
    let cancelled = false;
    setAdvisorLoading(true);
    const timeout = window.setTimeout(() => {
      if (!cancelled) setAdvisorLoading(false);
    }, 15_000);
    void api.askAgentWeeklyPlan(currentLearner.id || learner.id, advisorKpId)
      .then((result) => {
        if (cancelled) return;
        const iconPool = [Wrench, ClipboardCheck, BookOpen];
        const mapped: AdviceItem[] = (result?.suggestions ?? []).map((item, index) => ({
          icon: iconPool[index % iconPool.length],
          text: item.text,
          cta: item.cta || '去看看',
          href: '',
          kpId: item.kpId,
          priority: item.priority,
          evidence: item.evidence || '基于你的真实学情生成本周建议',
        }));
        if (mapped.length > 0) setAdvisorAdvice(mapped);
      })
      .catch(() => undefined)
      .finally(() => {
        window.clearTimeout(timeout);
        if (!cancelled) setAdvisorLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [advisorKpId, currentLearner.id, learner.id]);

  return (
    <div className={cn('lf-card h-full border-t-[3px] !border-t-[#5A6553] p-5', className)}>
      <div className="mb-4 flex items-center justify-between gap-2">
        {isLearner
          ? <span className="font-serif text-[15px] font-semibold text-ink">这周建议你做的</span>
          : <AgentChip agentId="ARB-05" />}
        {advisorLoading && !advisorAdvice ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-ink-muted">
            <Loader2 size={12} className="animate-spin text-brand" />
            生成中…
          </span>
        ) : (
          <span className="font-mono text-[11px] text-ink-muted">{advisorAdvice ? '已基于学情生成' : '本周调度建议'}</span>
        )}
      </div>
      <div className="space-y-2">
        {advice.map((a, i) => (
          <AdviceRow key={a.cta} advice={a} index={i} navigate={navigate} />
        ))}
      </div>
      <p className="mt-4 border-t border-hairline pt-3 font-mono text-[11px] leading-[18px] text-ink-muted">
        下次路径重排：完成标定测评后自动触发
      </p>
    </div>
  );
}

export default function GrowthSection({
  learner,
  report,
  resources,
  nodes = [],
}: {
  learner: Learner;
  report: LearnerReport;
  resources: LearningResourceSummary[];
  nodes?: GraphNode[];
}) {
  return (
    <div className="grid gap-5 lg:grid-cols-12">
      <div className="lg:col-span-7">
        <GrowthTrendChart report={report} />
      </div>
      <div className="lg:col-span-5">
        <WeeklyAdviceCard learner={learner} report={report} resources={resources} nodes={nodes} />
      </div>
    </div>
  );
}
