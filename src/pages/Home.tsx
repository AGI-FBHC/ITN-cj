import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Activity, ArrowRight, BookOpen, Check, CheckCircle2, ChevronRight, Circle,
  Compass, Database, FileText, GraduationCap, ListChecks, Loader2, MessagesSquare,
  Network, PenLine, Play, RefreshCw, Scale, Target,
  TimerReset, UserSearch,
} from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { learningResourcePath, useCourseLearning } from '@/hooks/useCourseLearning';
import { api } from '@/lib/api';
import type {
  LearnerAnalyticsProfile, RagDomain, TeachingGroupAgentDef, TeachingGroupEvent,
  TeachingGroupRunRecord, TeachingGroupRunSummary,
} from '@/lib/api';
import { getAgent } from '@/data/agents';
import type { AgentId } from '@/data/agents';
import { AgentIcon } from '@/components/AgentChip';
import LiveDot from '@/components/LiveDot';
import SectionHeader from '@/components/SectionHeader';
import { startDemoTour } from '@/components/tour/DemoTour';
import { cn } from '@/lib/utils';

const HeroScene = lazy(() => import('@/components/home/HeroScene'));

const agentDutyFallback: Record<AgentId, string> = {
  'DIA-01': '读取目标、画像与学习证据，定位当前最需要解决的问题。',
  'RET-02': '优先检索结构化知识库，资料不足时调用 WebSearch 补足依据。',
  'GEN-03': '依据学习目标与来源生成课程讲义、实操指南和分阶题。',
  'VER-04': '核对内容、引用与题目质量，拦截不完整或不可靠的生成结果。',
  'ARB-05': '汇总诊断、检索、生成和审核结果，给出最终发布与调整决策。',
};

const eventLabel: Record<TeachingGroupEvent['type'], string> = {
  run_started: '协同开始',
  agent_started: '开始工作',
  agent_output: '输出结果',
  agent_completed: '完成',
  agent_failed: '执行失败',
  run_completed: '协同完成',
  run_failed: '协同失败',
};

function eventSummary(event: TeachingGroupEvent): string {
  const data = event.data ?? {};
  if (event.agent === 'DIA-01') return `${String(data.focus ?? '学习重点')}：${String(data.reason ?? '已完成诊断')}`;
  if (event.agent === 'RET-02') {
    const evidence = Array.isArray(data.evidence) ? data.evidence : [];
    return `检索「${String(data.query ?? '当前主题')}」并获得 ${evidence.length} 条依据`;
  }
  if (event.agent === 'GEN-03') return `${String(data.title ?? '内容方案')}：${String(data.summary ?? '已生成结构化内容')}`;
  if (event.agent === 'VER-04') {
    const defects = Array.isArray(data.defects) ? data.defects : [];
    return defects.length ? `发现 ${defects.length} 项需要修订的问题` : '内容与引用审核通过';
  }
  if (event.agent === 'ARB-05') return `${String(data.decision ?? '仲裁完成')}：${String(data.nextAction ?? '')}`;
  return eventLabel[event.type];
}

function formatTime(value?: string | null) {
  if (!value) return '尚无记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function statusOfAgent(run: TeachingGroupRunRecord | null, id: AgentId): 'idle' | 'running' | 'done' | 'failed' {
  if (!run) return 'idle';
  let status: 'idle' | 'running' | 'done' | 'failed' = 'idle';
  for (const event of run.events) {
    if (event.agent !== id) continue;
    if (event.type === 'agent_started') status = 'running';
    if (event.type === 'agent_completed') status = 'done';
    if (event.type === 'agent_failed') status = 'failed';
  }
  return status;
}

function statusText(status: ReturnType<typeof statusOfAgent>) {
  return status === 'done' ? '已完成' : status === 'running' ? '运行中' : status === 'failed' ? '失败' : '待运行';
}

function statusClass(status: ReturnType<typeof statusOfAgent>) {
  if (status === 'done') return 'border-brand/30 bg-brand-tint text-brand';
  if (status === 'running') return 'border-brand-amber/40 bg-brand-amber-tint text-ochre';
  if (status === 'failed') return 'border-brand-danger/35 bg-brand-danger/10 text-brand-danger';
  return 'border-hairline bg-paper-deep text-ink-muted';
}

interface HomeSnapshot {
  domains: RagDomain[];
  agentDefs: TeachingGroupAgentDef[];
  runs: TeachingGroupRunSummary[];
  latestRun: TeachingGroupRunRecord | null;
  analytics: LearnerAnalyticsProfile | null;
  loading: boolean;
}

function useHomeSnapshot(learnerId: string): HomeSnapshot {
  const [snapshot, setSnapshot] = useState<HomeSnapshot>({ domains: [], agentDefs: [], runs: [], latestRun: null, analytics: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listRagDomains().catch(() => []),
      api.listTeachingGroupAgents().then((result) => result.agents).catch(() => []),
      api.listTeachingGroupRuns(12, learnerId).then((result) => result.runs).catch(() => []),
      api.getLearnerAnalyticsProfile().catch(() => null),
    ]).then(async ([domains, agentDefs, runs, analytics]) => {
      const latestRun = runs[0] ? await api.getTeachingGroupRun(runs[0].id).catch(() => null) : null;
      if (!cancelled) setSnapshot({ domains, agentDefs, runs, latestRun, analytics, loading: false });
    }).catch(() => {
      if (!cancelled) setSnapshot((current) => ({ ...current, loading: false }));
    });
    return () => { cancelled = true; };
  }, [learnerId]);

  return snapshot;
}

function HeroSection({
  learnerName, target, courseTitle, courseProgress, nextPath, ragChunks, latestRun,
}: {
  learnerName: string;
  target: string;
  courseTitle: string | null;
  courseProgress: number;
  nextPath: string;
  ragChunks: number;
  latestRun: TeachingGroupRunRecord | null;
}) {
  const navigate = useNavigate();
  return <section className="relative overflow-hidden rounded-b-[28px]">
    <div className="lf-blueprint-bg absolute inset-0 opacity-45" aria-hidden />
    <div className="relative mx-auto grid max-w-[1320px] items-center gap-8 px-5 pb-14 pt-10 md:px-8 lg:min-h-[720px] lg:grid-cols-12 lg:pb-10 lg:pt-4">
      <motion.div initial={{ opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.7 }} className="lg:col-span-5">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-brand/35 bg-card-warm/80 px-3.5 py-1.5 font-mono text-[11px] tracking-wide text-brand">
          <LiveDot status={latestRun?.status === 'running' ? 'running' : 'idle'} />
          真实学习闭环 · {learnerName}
        </div>
        <h1 className="font-serif text-[38px] font-bold leading-[1.2] tracking-[0.01em] text-ink md:text-[48px] xl:text-[56px]">
          <span className="block">让每一次学习</span>
          <span className="block">都真正因你而变</span>
        </h1>
        <p className="mt-4 font-display text-[17px] italic leading-6 text-ochre md:text-[19px]">智训云枢 · Multi-Agent Personalized Learning Engine</p>
        <p className="mt-5 max-w-[520px] text-[14.5px] leading-7 text-ink-2">围绕“{target}”组织真实动态课程。诊断、检索、生成、审核和仲裁五个 Agent 共同工作，知识库不足时由 WebSearch 兜底，学习行为继续回写画像与报告。</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link to={nextPath} className="lf-btn-primary group"><Play size={15} fill="currentColor" />{courseTitle ? '继续当前学习' : '生成我的课程'}<ArrowRight size={14} className="transition group-hover:translate-x-0.5" /></Link>
          <button type="button" onClick={() => navigate('/agents')} className="lf-btn-ghost"><Network size={15} />查看真实协同</button>
          <button type="button" onClick={() => startDemoTour()} className="lf-btn-ghost" title="沿真实页面完成五步产品导览"><Compass size={15} />评委导览</button>
        </div>
        <Link to="/knowledge" className="mt-4 inline-flex items-center gap-1.5 font-mono text-[11.5px] text-ink-muted hover:text-brand">浏览真实知识库 {ragChunks.toLocaleString()} 条切片<ArrowRight size={13} /></Link>
      </motion.div>

      <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.9, delay: 0.15 }} className="relative h-[410px] overflow-hidden rounded-[22px] border border-white/50 bg-card-warm/45 shadow-warm lg:col-span-7 lg:h-[590px]">
        <Suspense fallback={<img src="/hero-network.png" alt="五 Agent 协同网络" className="h-full w-full object-cover" />}><HeroScene /></Suspense>
        <div className="pointer-events-none absolute inset-x-4 bottom-4 grid gap-2 sm:grid-cols-3">
          <div className="rounded-[11px] border border-white/60 bg-paper/85 p-3 backdrop-blur"><div className="font-mono text-[9.5px] text-ink-muted">CURRENT COURSE</div><div className="mt-1 truncate text-[12px] font-medium text-ink">{courseTitle ?? '等待生成课程'}</div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hairline"><div className="h-full rounded-full bg-brand" style={{ width: `${courseProgress}%` }} /></div></div>
          <div className="rounded-[11px] border border-white/60 bg-paper/85 p-3 backdrop-blur"><div className="font-mono text-[9.5px] text-ink-muted">LATEST RUN</div><div className="mt-1 text-[12px] font-medium text-ink">{latestRun ? `${latestRun.eventCount} 条真实事件` : '尚无协同档案'}</div><div className="mt-1 text-[10px] text-ink-muted">{formatTime(latestRun?.updatedAt)}</div></div>
          <div className="rounded-[11px] border border-white/60 bg-paper/85 p-3 backdrop-blur"><div className="font-mono text-[9.5px] text-ink-muted">RAG + WEB</div><div className="mt-1 text-[12px] font-medium text-ink">{ragChunks.toLocaleString()} 条知识切片</div><div className="mt-1 text-[10px] text-ink-muted">不足时自动启用 WebSearch</div></div>
        </div>
      </motion.div>
    </div>
  </section>;
}

function MetricsSection({
  profileDimensions, chapters, resources, ragDocuments, ragChunks, studyMinutes,
}: {
  profileDimensions: number; chapters: number; resources: number; ragDocuments: number; ragChunks: number; studyMinutes: number;
}) {
  const metrics = [
    { Icon: Target, value: profileDimensions, label: '画像知识维度', detail: '来自当前后端画像' },
    { Icon: BookOpen, value: chapters, label: '动态课程章节', detail: '由用户目标生成' },
    { Icon: FileText, value: resources, label: '已生成学习资源', detail: '讲义 / 实操 / 分阶题' },
    { Icon: Database, value: ragChunks, label: 'RAG 知识切片', detail: `${ragDocuments} 份真实文档` },
    { Icon: TimerReset, value: `${studyMinutes}m`, label: '累计学习时长', detail: '来自真实学习事件' },
  ];
  return <section className="mx-auto max-w-[1320px] px-5 py-14 md:px-8"><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">{metrics.map(({ Icon, value, label, detail }, index) => <motion.article key={label} initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: index * 0.06 }} className="lf-card p-5"><span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-brand-tint text-brand"><Icon size={18} /></span><div className="mt-4 font-mono text-[25px] font-semibold text-ink">{value}</div><div className="mt-1 text-[12.5px] font-medium text-ink-2">{label}</div><div className="mt-1 text-[10.5px] text-ink-muted">{detail}</div></motion.article>)}</div></section>;
}

type LoopStatus = 'done' | 'active' | 'waiting';

function ClosedLoopSection({
  profileReady, runReady, resourcesReady, feedbackReady, decisionReady,
}: {
  profileReady: boolean; runReady: boolean; resourcesReady: boolean; feedbackReady: boolean; decisionReady: boolean;
}) {
  const steps = [
    { Icon: UserSearch, en: 'PROFILE', name: '学情画像构建', desc: '目标、背景、自评和测评形成可持久化画像。', href: '/profiles', done: profileReady },
    { Icon: Network, en: 'COLLABORATION', name: '多智能体协同', desc: '诊断、检索、生成、审核与仲裁留下真实运行档案。', href: '/agents', done: runReady },
    { Icon: PenLine, en: 'GENERATION', name: '个性化内容生成', desc: '按章节生成讲义、实操和分阶题，知识不足时联网兜底。', href: '/resources', done: resourcesReady },
    { Icon: MessagesSquare, en: 'FEEDBACK', name: '学习交互反馈', desc: '阅读、实操、答题、笔记和提问都写回后端。', href: '/me', done: feedbackReady },
    { Icon: RefreshCw, en: 'DECISION', name: '画像与路径更新', desc: '报告使用真实学习证据计算下一步建议。', href: '/report', done: decisionReady },
  ];
  const firstWaiting = steps.findIndex((step) => !step.done);
  const stateOf = (index: number): LoopStatus => steps[index].done ? 'done' : index === firstWaiting ? 'active' : 'waiting';

  return <section className="relative overflow-hidden bg-paper-deep/55 py-16"><div className="lf-blueprint-bg absolute inset-0 opacity-35" aria-hidden /><div className="relative mx-auto max-w-[1320px] px-5 md:px-8"><SectionHeader en="CLOSED LOOP" title="五步真实闭环：从画像到决策更新" desc="绿色表示已有后端证据；当前步骤不是演示进度，而是由账号真实数据计算。" />
    <div className="relative grid gap-3 lg:grid-cols-5"><div className="absolute left-[10%] right-[10%] top-6 hidden h-px bg-hairline lg:block" />{steps.map((step, index) => { const status = stateOf(index); return <Link key={step.name} to={step.href} className={cn('group relative rounded-[15px] border p-5 transition hover:-translate-y-1 hover:shadow-warm', status === 'done' ? 'border-brand/25 bg-paper' : status === 'active' ? 'border-brand-amber/40 bg-brand-amber-tint/45' : 'border-hairline bg-card-warm')}><div className="flex items-center gap-3 lg:flex-col lg:text-center"><span className={cn('relative z-10 flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2', status === 'done' ? 'border-brand bg-brand text-paper' : status === 'active' ? 'border-brand-amber bg-paper text-ochre' : 'border-hairline bg-paper text-ink-muted')}>{status === 'done' ? <Check size={18} /> : <step.Icon size={18} />}</span><div className="min-w-0 lg:mt-2"><div className="font-mono text-[9.5px] tracking-[0.14em] text-ink-muted">{String(index + 1).padStart(2, '0')} · {step.en}</div><h3 className="mt-1 text-[14px] font-semibold text-ink">{step.name}</h3></div></div><p className="mt-3 text-[11.5px] leading-5 text-ink-muted lg:text-center">{step.desc}</p><div className={cn('mt-4 flex items-center justify-center gap-1 rounded-md py-1.5 font-mono text-[10px]', status === 'done' ? 'bg-brand-tint text-brand' : status === 'active' ? 'bg-paper text-ochre' : 'bg-paper-deep text-ink-muted')}>{status === 'done' ? <CheckCircle2 size={11} /> : status === 'active' ? <Activity size={11} /> : <Circle size={10} />}{status === 'done' ? '已有真实证据' : status === 'active' ? '当前待完成' : '等待前序数据'}</div></Link>; })}</div>
    <div className="mt-5 flex items-center justify-center gap-2 font-mono text-[10px] text-ink-muted"><RefreshCw size={12} className="text-ochre" />学习证据持续回流画像，闭环会随真实状态变化</div>
  </div></section>;
}

const topoNodes: { id: AgentId; x: number; y: number; big?: boolean }[] = [
  { id: 'DIA-01', x: 50, y: 11 }, { id: 'RET-02', x: 87, y: 49 }, { id: 'GEN-03', x: 50, y: 88 }, { id: 'VER-04', x: 13, y: 49 }, { id: 'ARB-05', x: 50, y: 50, big: true },
];

function AgentTopologySection({ agentDefs, latestRun, loading }: { agentDefs: TeachingGroupAgentDef[]; latestRun: TeachingGroupRunRecord | null; loading: boolean }) {
  const [selected, setSelected] = useState<AgentId>('ARB-05');
  const selectedMeta = getAgent(selected);
  const selectedBackend = agentDefs.find((item) => item.id === selected);
  const selectedStatus = statusOfAgent(latestRun, selected);
  const latestOutputs = useMemo(() => (latestRun?.events ?? []).filter((event) => event.type === 'agent_output' && event.agent).slice(-6).reverse(), [latestRun]);
  const selectedOutput = latestOutputs.find((event) => event.agent === selected);

  return <section className="mx-auto max-w-[1320px] px-5 py-16 md:px-8"><SectionHeader en="MULTI-AGENT ARCHITECTURE" title="五个 Agent，一条可信链路" desc="节点状态和右侧消息均来自最近一次持久化协同运行；没有运行记录时保持待运行，不播放脚本。" actions={<Link to="/agents" className="lf-btn-ghost !py-2 text-[12px]">查看全部运行档案<ArrowRight size={13} /></Link>} />
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_430px]">
      <div className="lf-card relative min-h-[500px] overflow-hidden p-5 md:p-7"><div className="absolute inset-0 lf-blueprint-bg opacity-35" /><svg viewBox="0 0 500 420" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden><g fill="none" stroke="#A9B7B0" strokeWidth="1.4" strokeDasharray="5 5" opacity="0.65"><path d="M250 95 L250 180" /><path d="M405 210 L290 210" /><path d="M250 250 L250 335" /><path d="M222 350 C150 330 95 285 78 230" /><path d="M105 200 L210 210" /></g></svg>
        {topoNodes.map((node) => { const meta = getAgent(node.id); const status = statusOfAgent(latestRun, node.id); return <button key={node.id} type="button" onClick={() => setSelected(node.id)} style={{ left: `${node.x}%`, top: `${node.y}%`, transform: 'translate(-50%, -50%)' }} className={cn('absolute z-10 flex flex-col items-center rounded-[14px] border bg-paper/95 px-4 py-3 text-center shadow-xs backdrop-blur transition hover:-translate-y-[55%] hover:shadow-warm', node.big ? 'min-w-[170px]' : 'min-w-[145px]', selected === node.id ? 'border-brand shadow-warm' : 'border-hairline')}><span className={cn('flex items-center justify-center rounded-[11px] border', node.big ? 'h-12 w-12' : 'h-10 w-10')} style={{ backgroundColor: `${meta.color}14`, borderColor: `${meta.color}45` }}><AgentIcon agent={meta} size={node.big ? 23 : 19} /></span><span className="mt-2 font-mono text-[10.5px] font-semibold" style={{ color: meta.color }}>{meta.code}</span><span className="mt-0.5 text-[11.5px] font-medium text-ink">{meta.name.replace(' Agent', '')}</span><span className={cn('mt-2 rounded-full border px-2 py-0.5 font-mono text-[9px]', statusClass(status))}>{statusText(status)}</span></button>; })}
        {loading && <div className="absolute inset-0 z-20 flex items-center justify-center bg-paper/50 text-[12px] text-ink-muted backdrop-blur-sm"><Loader2 size={15} className="mr-2 animate-spin" />读取真实运行状态…</div>}
      </div>

      <div className="space-y-4"><motion.article key={selected} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} className="lf-card p-5"><div className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-[11px] border" style={{ backgroundColor: `${selectedMeta.color}14`, borderColor: `${selectedMeta.color}45` }}><AgentIcon agent={selectedMeta} size={21} /></span><div className="min-w-0 flex-1"><div className="font-mono text-[11px] font-semibold" style={{ color: selectedMeta.color }}>{selectedMeta.code} · {selectedMeta.en}</div><h3 className="mt-0.5 text-[15px] font-semibold text-ink">{selectedMeta.name}</h3></div><span className={cn('rounded-full border px-2.5 py-1 font-mono text-[9.5px]', statusClass(selectedStatus))}>{statusText(selectedStatus)}</span></div><p className="mt-4 text-[12.5px] leading-6 text-ink-2">{selectedBackend?.duty || agentDutyFallback[selected]}</p><div className="mt-4 rounded-[10px] bg-card-warm p-3"><div className="font-mono text-[9.5px] text-ink-muted">最近真实输出</div><p className="mt-1.5 text-[11.5px] leading-5 text-ink-2">{selectedOutput ? eventSummary(selectedOutput) : '当前账号还没有该 Agent 的真实输出。'}</p></div></motion.article>
        <article className="lf-card p-5"><div className="flex items-center justify-between"><div><div className="lf-mono-label">LIVE EVENT FEED</div><h3 className="mt-1 text-[14px] font-semibold text-ink">最近协同消息</h3></div>{latestRun && <span className="font-mono text-[9.5px] text-ink-muted">{latestRun.eventCount} EVENTS</span>}</div><div className="mt-4 space-y-2">{latestOutputs.length ? latestOutputs.map((event, index) => { const id = event.agent as AgentId; const meta = getAgent(id); return <div key={`${event.agent}-${index}`} className="flex gap-2.5 rounded-[9px] border border-hairline bg-card-warm p-3"><span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} /><div className="min-w-0"><div className="font-mono text-[9.5px] font-semibold" style={{ color: meta.color }}>{id} · {eventLabel[event.type]}</div><p className="mt-1 line-clamp-2 text-[10.5px] leading-[17px] text-ink-muted">{eventSummary(event)}</p></div></div>; }) : <div className="rounded-[10px] border border-dashed border-hairline p-5 text-center text-[11px] text-ink-muted">尚无真实协同消息。生成课程或运行 AI 教研组后，这里会自动出现记录。</div>}</div></article></div>
    </div>
  </section>;
}

function OutputsSection({
  courseTitle, courseDescription, nextResourceTitle, nextPath, ragDocuments, ragChunks, latestRun,
}: {
  courseTitle: string | null; courseDescription: string | null; nextResourceTitle: string | null; nextPath: string; ragDocuments: number; ragChunks: number; latestRun: TeachingGroupRunRecord | null;
}) {
  const cards = [
    { Icon: GraduationCap, en: 'DYNAMIC COURSE', title: courseTitle ?? '尚未生成动态课程', desc: courseDescription ?? '完成画像后，按目标生成真实课程与章节。', href: '/learn', action: courseTitle ? '查看我的课程' : '生成课程' },
    { Icon: ListChecks, en: 'LEARNING RESOURCE', title: nextResourceTitle ?? '当前没有待学资源', desc: '讲义、实操指南和分阶题共用真实来源、学习断点与反馈记录。', href: nextPath, action: nextResourceTitle ? '继续学习' : '进入课程' },
    { Icon: Database, en: 'KNOWLEDGE & TRACE', title: `${ragDocuments} 份文档 · ${ragChunks} 条切片`, desc: '课程内容优先使用结构化知识库；覆盖不足时 WebSearch 提供可追踪兜底。', href: '/knowledge', action: '浏览知识库' },
    { Icon: Scale, en: 'AGENT DECISION', title: latestRun?.nextAction || '等待真实仲裁记录', desc: latestRun ? `最近运行于 ${formatTime(latestRun.updatedAt)}，共保存 ${latestRun.eventCount} 条事件。` : '运行 AI 教研组后，审核与仲裁结果会持久化在此。', href: '/agents', action: '查看协同档案' },
  ];
  return <section className="bg-paper-deep/45 py-16"><div className="mx-auto max-w-[1320px] px-5 md:px-8"><SectionHeader en="REAL OUTPUTS" title="一次协同，持续沉淀四类真实产出" desc="不是预置样例：课程、资源、知识来源与决策记录均来自当前账号。" /><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{cards.map(({ Icon, en, title, desc, href, action }, index) => <motion.article key={en} initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: index * 0.06 }} className="lf-card flex min-h-[260px] flex-col p-5"><span className="flex h-11 w-11 items-center justify-center rounded-[11px] bg-brand-tint text-brand"><Icon size={20} /></span><div className="mt-4 font-mono text-[9.5px] tracking-[0.14em] text-ink-muted">{en}</div><h3 className="mt-2 line-clamp-2 text-[15px] font-semibold leading-6 text-ink">{title}</h3><p className="mt-2 flex-1 text-[11.5px] leading-5 text-ink-muted">{desc}</p><Link to={href} className="mt-5 inline-flex items-center gap-1 text-[11.5px] font-medium text-brand hover:underline">{action}<ChevronRight size={12} /></Link></motion.article>)}</div></div></section>;
}

export default function Home() {
  const { currentLearner, domainKnowledgePoints } = useProfile();
  const learning = useCourseLearning();
  const snapshot = useHomeSnapshot(currentLearner.id);

  const ragStats = useMemo(() => snapshot.domains.reduce((totals, domain) => ({ documents: totals.documents + domain.documentCount, chunks: totals.chunks + domain.chunkCount }), { documents: 0, chunks: 0 }), [snapshot.domains]);
  const studyMinutes = snapshot.analytics?.stats.totalStudyMinutes ?? 0;
  const eventCount = Object.values(snapshot.analytics?.stats.eventDistribution ?? {}).reduce((sum, value) => sum + Number(value || 0), 0);
  const nextPath = learning.nextResource ? learningResourcePath(learning.nextResource) : '/learn';
  const target = currentLearner.targetJob || currentLearner.goal || '你的学习目标';
  const decisionReady = Boolean(snapshot.analytics && (eventCount > 0 || snapshot.analytics.recentQuizzes.length > 0));

  return <div className="pb-12">
    <HeroSection learnerName={currentLearner.name} target={target} courseTitle={learning.course?.title ?? null} courseProgress={learning.progress} nextPath={nextPath} ragChunks={ragStats.chunks} latestRun={snapshot.latestRun} />
    <MetricsSection profileDimensions={domainKnowledgePoints.length} chapters={learning.course?.chapters.length ?? 0} resources={learning.totalCount} ragDocuments={ragStats.documents} ragChunks={ragStats.chunks} studyMinutes={studyMinutes} />
    <ClosedLoopSection profileReady={domainKnowledgePoints.length > 0} runReady={Boolean(snapshot.latestRun?.status === 'completed')} resourcesReady={learning.totalCount > 0} feedbackReady={learning.learnedCount > 0 || eventCount > 0} decisionReady={decisionReady} />
    <AgentTopologySection agentDefs={snapshot.agentDefs} latestRun={snapshot.latestRun} loading={snapshot.loading} />
    <OutputsSection courseTitle={learning.course?.title ?? null} courseDescription={learning.course?.description ?? null} nextResourceTitle={learning.nextResource?.title ?? null} nextPath={nextPath} ragDocuments={ragStats.documents} ragChunks={ragStats.chunks} latestRun={snapshot.latestRun} />
    <footer className="mx-auto flex max-w-[1320px] flex-col items-start justify-between gap-4 px-5 py-12 md:flex-row md:items-center md:px-8"><div><div className="font-serif text-[20px] font-semibold text-ink">从真实目标开始，让每一次学习留下证据。</div><p className="mt-1 text-[12px] text-ink-muted">当前账号：{currentLearner.name} · {target}</p></div><div className="flex flex-wrap gap-2"><Link to={nextPath} className="lf-btn-primary">继续学习<ArrowRight size={14} /></Link><Link to="/report" className="lf-btn-ghost">查看真实成长报告</Link></div></footer>
  </div>;
}
