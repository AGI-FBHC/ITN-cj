import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Circle, Loader2, RefreshCw, Sparkles, XCircle } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { api, streamAdminGenerationTask, type AdminGenerationEvent, type LearningResourceGenerationTask } from '@/lib/api';
import { presentationApi, type PresentationTaskSummary } from '@/lib/presentationApi';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/lib/utils';
import EvidenceDebateCourt from '@/components/resources/EvidenceDebateCourt';

type WorkbenchTask =
  | ({ taskKind: 'resource' } & LearningResourceGenerationTask)
  | ({ taskKind: 'ppt'; resourceType: 'ppt' } & PresentationTaskSummary);

const agents = [
  { id: 'DIA-01', name: '教学策划 Agent', duty: '目标、画像与教学蓝图' },
  { id: 'RET-02', name: '知识检索 Agent', duty: '知识切片、补充资料与证据' },
  { id: 'GEN-03', name: '内容生成 Agent', duty: '初稿生成与定向修订' },
  { id: 'VER-04', name: '质量核验 Agent', duty: '结构、引用与内容一致性' },
  { id: 'ARB-05', name: '发布仲裁 Agent', duty: '通过、返工或终止' },
] as const;
const activeStatuses = new Set(['queued', 'retrieving', 'debating', 'planning', 'analyzing', 'generating', 'verifying', 'reviewing', 'revising', 'judging', 'outline_review']);
const typeText: Record<string, string> = { lecture: '讲义', practice: '实操指南', quiz: '题库', ppt: '交互课件' };

type CollaborationRound = { index: number; label: string; trigger?: AdminGenerationEvent; units: Array<{ agent: string; events: AdminGenerationEvent[] }> };

function isLifecycleEvent(event: AdminGenerationEvent) {
  return event.agent === 'SYSTEM' || event.actorType === 'system' || event.eventType === 'task_lifecycle'
    || ['任务已创建', '任务取消', '生成完成', '任务已结束', '任务被取消'].includes(event.title);
}

function buildRounds(events: AdminGenerationEvent[]): CollaborationRound[] {
  const workEvents = events.filter((event) => !isLifecycleEvent(event));
  const rounds: CollaborationRound[] = [{ index: 0, label: '初始生成', units: [] }];
  let current = rounds[0];
  const visited = new Set<string>();
  let previousAgent = '';
  for (const event of workEvents) {
    const reentry = event.agent !== previousAgent && visited.has(event.agent);
    const repairSignal = ['revising', 'debating'].includes(event.status) || ['revising', 'debating'].includes(event.phase);
    if ((reentry || repairSignal) && current.units.length && current.units.at(-1)?.agent !== event.agent) {
      current = { index: rounds.length, label: `自主修复第 ${rounds.length} 轮`, trigger: event, units: [] };
      rounds.push(current);
    }
    const last = current.units.at(-1);
    if (last?.agent === event.agent) last.events.push(event);
    else current.units.push({ agent: event.agent, events: [event] });
    visited.add(event.agent);
    previousAgent = event.agent;
  }
  return rounds.filter((round) => round.units.length);
}

function CollaborationRounds({ events, selectedSeq, onSelect }: {
  events: AdminGenerationEvent[];
  selectedSeq: number | null;
  onSelect: (event: AdminGenerationEvent) => void;
}) {
  const lifecycle = events.filter(isLifecycleEvent);
  const rounds = buildRounds(events);
  return (
    <div className="mt-3 space-y-3">
      {lifecycle[0] && <button type="button" onClick={() => onSelect(lifecycle[0])} className={cn('flex w-full items-center gap-2 rounded-xl border border-dashed px-3 py-2 text-left', lifecycle[0].seq === selectedSeq ? 'border-brand/40 bg-brand-tint/50' : 'border-white/80 bg-white/35')}><span className="h-2 w-2 rounded-full bg-ink-muted"/><span className="text-[10px] font-bold text-ink">{lifecycle[0].title}</span><span className="text-[9px] text-ink-muted">系统生命周期 · 不属于任何 Agent</span></button>}
      {rounds.map((round) => <section key={round.index} className="rounded-xl border border-white/75 bg-white/35 p-3"><div className="flex flex-wrap items-center gap-2"><h5 className="text-xs font-bold text-ink">{round.label}</h5>{round.index > 0 && <span className="lf-pill lf-pill-warn">返工轮次</span>}<span className="ml-auto text-[9px] text-ink-muted">{round.units.reduce((sum, unit) => sum + unit.events.length, 0)} 条记录</span></div>{round.trigger && <p className="mt-1 text-[10px] text-ochre">触发：{round.trigger.title}</p>}<div className="mt-3 flex min-w-max items-stretch gap-2 overflow-x-auto pb-1">{round.units.map((unit, index) => { const event = unit.events.at(-1)!; const agent = agents.find((item) => item.id === unit.agent); const selected = unit.events.some((item) => item.seq === selectedSeq); return <div key={`${round.index}-${index}-${unit.agent}`} className="flex items-center gap-2">{index > 0 && <span className={cn('text-sm', round.index > 0 && index === 1 ? 'text-ochre' : 'text-ink-muted')}>{round.index > 0 && index === 1 ? '⇢' : '→'}</span>}<button type="button" onClick={() => onSelect(event)} className={cn('w-36 rounded-xl border px-3 py-2.5 text-left', selected ? 'border-brand/45 bg-brand-tint/70' : 'border-white/80 bg-white/60')}><span className="block text-[9px] font-semibold text-brand">{agent?.name ?? unit.agent}</span><span className="mt-1 block truncate text-[10px] font-bold text-ink">{event.title}</span><span className="mt-1 block text-[9px] text-ink-muted">{unit.events.length} 条过程记录</span></button></div>; })}</div></section>)}
      {lifecycle.slice(1).map((event) => <button key={event.seq} type="button" onClick={() => onSelect(event)} className={cn('flex w-full items-center gap-2 rounded-xl border border-dashed px-3 py-2 text-left', event.seq === selectedSeq ? 'border-brand/40 bg-brand-tint/50' : 'border-white/80 bg-white/35')}><span className="h-2 w-2 rounded-full bg-brand"/><span className="text-[10px] font-bold text-ink">{event.title}</span><span className="text-[9px] text-ink-muted">系统生命周期</span></button>)}
      {!events.length && <p className="py-8 text-center text-xs text-ink-muted">等待第一条协同事件…</p>}
    </div>
  );
}

function contextOf(task: WorkbenchTask): Record<string, unknown> {
  if (task.taskKind === 'ppt') return task.request?.generationContext ?? {};
  const request = task.request as (typeof task.request & { generation_context?: Record<string, unknown> }) | undefined;
  return request?.generationContext ?? request?.generation_context ?? {};
}

function detailRows(snapshot: Record<string, unknown>) {
  const labels: Record<string, string> = {
    activity: '具体操作', topic: '学习主题', query: '知识范围', ragCount: '知识库切片', webCount: '补充资料',
    sourceTitles: '命中切片', coverage: '内容覆盖', acceptanceRubric: '验收标准', resourceType: '资源类型',
    chapterCount: '章节数', stepCount: '步骤数', questionCount: '题目数', sourceCount: '引用来源',
    citationVerified: '引用核验', issueCount: '发现问题', issues: '问题摘要', decision: '知识依据结论',
    highFidelityScore: '知识依据充分度', fallbackUsed: '资料补充情况', knowledgeCoreCount: '结构化知识切片',
    debateStage: '辩论阶段', candidateSourceCount: '候选资料', debateScorecard: '仲裁成绩单', debateClaims: '裁决观点',
  };
  const hidden = new Set(['requestId', 'traceId', 'promptVersion', 'model']);
  return Object.entries(snapshot ?? {}).filter(([key]) => !hidden.has(key)).map(([key, value]) => {
    let shown = Array.isArray(value) ? value.map((item) => typeof item === 'object' ? JSON.stringify(item, null, 2) : String(item)).join('\n')
      : value && typeof value === 'object' ? JSON.stringify(value, null, 2)
      : typeof value === 'boolean' ? (value ? '是' : '否') : String(value ?? '—');
    if (key === 'highFidelityScore' && Number.isFinite(Number(value))) shown = `${Math.round(Number(value) * 100)} 分`;
    return [labels[key] ?? key, shown] as const;
  });
}

function taskKey(task: WorkbenchTask) { return `${task.taskKind}-${task.id}`; }

export default function CollaborationWorkbench() {
  const { session } = useAuth();
  const isAdmin = session?.roles?.includes('admin') === true;
  const [params, setParams] = useSearchParams();
  const [tasks, setTasks] = useState<WorkbenchTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<AdminGenerationEvent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [selectedEventSeq, setSelectedEventSeq] = useState<number | null>(null);
  const selectedKey = params.get('task');

  const load = async () => {
    const resources = await api.listLearningResourceTasks(100);
    const resourceTasks: WorkbenchTask[] = resources.tasks
      .filter((task) => !isAdmin || contextOf({ ...task, taskKind: 'resource' }).adminGeneration === true)
      .map((task) => ({ ...task, taskKind: 'resource' as const }));
    let pptTasks: WorkbenchTask[] = [];
    if (isAdmin) {
      const presentations = await presentationApi.listPresentationSummariesFresh(100, true);
      pptTasks = presentations.tasks.filter((task) => task.request?.generationContext?.adminGeneration === true)
        .map((task) => ({ ...task, taskKind: 'ppt' as const, resourceType: 'ppt' as const }));
    }
    const next = [...resourceTasks, ...pptTasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    setTasks(next);
    if (!selectedKey && next[0]) setParams({ task: taskKey(next[0]) }, { replace: true });
    setLoading(false);
  };

  useEffect(() => {
    void load().catch(() => setLoading(false));
    const timer = window.setInterval(() => void load().catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const task = tasks.find((item) => taskKey(item) === selectedKey) ?? null;
  useEffect(() => {
    if (!task) return;
    setEvents([]); setSelectedAgent(''); setSelectedEventSeq(null);
    const controller = new AbortController();
    void streamAdminGenerationTask(task.taskKind, task.id, (event) => setEvents((current) => current.some((item) => item.seq === event.seq) ? current : [...current, event].sort((a, b) => a.seq - b.seq)), controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [task?.id, task?.taskKind]);

  const latest = events.at(-1);
  const effectiveAgent = selectedAgent || latest?.agent || agents[0].id;
  const agentEvents = events.filter((event) => event.agent === effectiveAgent);
  const selectedEvent = events.find((event) => event.seq === selectedEventSeq) ?? agentEvents.at(-1);
  const active = Boolean(task && activeStatuses.has(task.status) && (!latest || activeStatuses.has(latest.status)));
  const agentOnlyEvents = useMemo(() => events.filter((event) => !isLifecycleEvent(event)), [events]);
  const transitions = useMemo(() => agentOnlyEvents.slice(1).filter((event, index) => event.agent !== agentOnlyEvents[index].agent).length, [agentOnlyEvents]);
  const returns = useMemo(() => {
    const seen = new Set<string>(); let count = 0; let prior = '';
    for (const event of agentOnlyEvents) { if (event.agent !== prior && seen.has(event.agent)) count += 1; seen.add(event.agent); prior = event.agent; }
    return count;
  }, [agentOnlyEvents]);
  const grouped = useMemo(() => ({ active: tasks.filter((item) => activeStatuses.has(item.status)), finished: tasks.filter((item) => !activeStatuses.has(item.status)) }), [tasks]);

  return <div className="lf-anim-in-up flex min-h-[680px] flex-col gap-4 lg:h-full lg:min-h-0 lg:flex-row">
    <aside className="flex w-full shrink-0 flex-col rounded-2xl border border-white/70 bg-white/45 lg:w-[300px]">
      <div className="flex items-center gap-3 border-b border-white/70 p-4"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-paper"><Sparkles size={17}/></span><div><h2 className="text-sm font-bold text-ink">AI 教研任务</h2><p className="mt-0.5 text-[10px] text-ink-muted">选择任务查看完整协同过程</p></div><button onClick={() => void load()} className="lf-row-btn ml-auto !p-2" aria-label="刷新任务"><RefreshCw size={13} className={loading ? 'animate-spin' : ''}/></button></div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {(['active', 'finished'] as const).map((group) => <section key={group} className="mb-4"><p className="mb-2 px-1 text-[10px] font-bold tracking-wide text-ink-muted">{group === 'active' ? `进行中 · ${grouped.active.length}` : `已完成 / 已结束 · ${grouped.finished.length}`}</p><div className="space-y-2">{grouped[group].map((item) => { const selected = taskKey(item) === selectedKey; return <button key={taskKey(item)} onClick={() => setParams({ task: taskKey(item) })} className={cn('w-full rounded-xl border px-3 py-3 text-left transition-all', selected ? 'border-brand/45 bg-brand-tint/60 shadow-sm' : 'border-white/70 bg-white/45 hover:border-brand/25')}><div className="flex items-center gap-2">{activeStatuses.has(item.status) ? <Loader2 size={12} className="animate-spin text-brand"/> : item.status === 'completed' ? <CheckCircle2 size={12} className="text-emerald-600"/> : <XCircle size={12} className="text-red-500"/>}<span className="lf-pill lf-pill-null !px-1.5 text-[9px]">{typeText[item.resourceType]}</span><span className="ml-auto text-[9px] text-ink-muted">{item.progress}%</span></div><p className="mt-2 line-clamp-2 text-xs font-bold leading-5 text-ink">{String(contextOf(item).topicName || item.title)}</p><p className="mt-1 truncate text-[10px] text-ink-muted">{item.stageMessage}</p></button>; })}{!grouped[group].length && <p className="rounded-xl border border-dashed border-white/80 px-3 py-5 text-center text-[10px] text-ink-muted">暂无任务</p>}</div></section>)}
      </div>
    </aside>

    <main className="min-w-0 flex-1 overflow-y-auto rounded-2xl border border-white/70 bg-[#f7f5ee]/75 p-5">
      {!task ? <div className="flex h-full items-center justify-center text-sm text-ink-muted">{loading ? '正在读取教研任务…' : '还没有可以查看的教研任务'}</div> : <>
        <header className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-bold text-ink">{String(contextOf(task).topicName || task.title)}</h2><span className="lf-pill lf-pill-null">{typeText[task.resourceType]}</span>{active && <span className="text-[11px] font-semibold text-brand">● 实时协同中</span>}</div><p className="mt-1 text-xs text-ink-muted">{task.title} · 所有 Agent、历史事件与执行详情统一回溯</p></div></header>
        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4"><div className="rounded-xl bg-white/55 px-3 py-2.5"><p className="text-[10px] text-ink-muted">Agent 工作事件</p><p className="mt-1 text-base font-bold text-ink">{agentOnlyEvents.length}</p></div><div className="rounded-xl bg-white/55 px-3 py-2.5"><p className="text-[10px] text-ink-muted">Agent 交接</p><p className="mt-1 text-base font-bold text-ink">{transitions}</p></div><div className="rounded-xl bg-white/55 px-3 py-2.5"><p className="text-[10px] text-ink-muted">回退 / 再进入</p><p className="mt-1 text-base font-bold text-ochre">{returns}</p></div><div className="rounded-xl bg-white/55 px-3 py-2.5"><p className="text-[10px] text-ink-muted">任务状态</p><p className="mt-1 text-sm font-bold text-ink">{active ? '自主协同中' : task.status === 'completed' ? '已通过' : task.status === 'failed' ? '未通过' : task.status}</p></div></div>

        <section className="relative mt-4 rounded-2xl border border-white/70 bg-white/45 px-3 pb-4 pt-4">
          <div className="mb-3 flex items-center justify-between"><h4 className="text-sm font-bold text-ink">AI 教研组成员</h4><span className="text-[10px] text-ink-muted">成员筛选，不代表固定执行顺序</span></div>
          <div className="grid gap-2 md:grid-cols-5">
            {agents.map((agent) => {
              const own = events.filter((event) => event.agent === agent.id);
              const running = active && latest?.agent === agent.id;
              const selected = effectiveAgent === agent.id;
              return (
                  <button key={agent.id}
                    type="button"
                    onClick={() => { setSelectedAgent(agent.id); setSelectedEventSeq(own.at(-1)?.seq ?? null); }}
                    className={cn('group flex min-h-[112px] flex-col items-center rounded-xl border px-2 py-3 text-center transition-all', selected ? 'border-brand/45 bg-brand-tint/60' : 'border-white/75 bg-white/40')}
                    title={agent.duty}
                  >
                    <span className={cn(
                      'flex h-12 w-12 items-center justify-center rounded-full border-2 transition-all',
                      running ? 'border-brand bg-brand text-paper shadow-[0_0_0_6px_rgba(78,120,96,0.16)]' :
                      selected ? 'border-brand bg-brand-tint text-brand' :
                      own.length ? 'border-emerald-300 bg-emerald-50 text-emerald-600' : 'border-white/80 bg-white/75 text-ink-muted',
                    )}>
                      {running ? <Loader2 size={16} className="animate-spin" /> : own.length ? <CheckCircle2 size={16} /> : <Circle size={13} />}
                    </span>
                    <span className={cn("text-center text-[11px] font-bold leading-4", selected || running ? "text-brand" : "text-ink")}>{agent.name}</span>
                    <span className="text-center text-[9px] leading-3.5 text-ink-muted">{agent.duty}</span>
                  </button>
              );
            })}
          </div>
        </section>

        <section className="mt-4 rounded-2xl border border-white/70 bg-white/40 p-3">
          <div className="flex items-center justify-between px-1">
            <h4 className="text-sm font-bold text-ink">协作轮次与交接</h4>
            <span className="text-[10px] text-ink-muted">系统生命周期与 Agent 工作分开；点击工作单元查看详情</span>
          </div>
          <CollaborationRounds events={events} selectedSeq={selectedEvent?.seq ?? null} onSelect={(event) => { if (!isLifecycleEvent(event)) setSelectedAgent(event.agent); setSelectedEventSeq(event.seq); }} />
        </section>

        <EvidenceDebateCourt events={events}/>
        <section className="mt-4 grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-2xl border border-white/75 bg-white/45 p-4"><div className="flex justify-between"><h3 className="text-sm font-bold text-ink">{agents.find((item) => item.id === effectiveAgent)?.name} · 工作流</h3><span className="text-[10px] text-ink-muted">{agentEvents.length} 项</span></div><div className="mt-3 max-h-[440px] space-y-1 overflow-y-auto">{agentEvents.map((event) => <button key={event.seq} onClick={() => setSelectedEventSeq(event.seq)} className={cn('block w-full rounded-xl px-3 py-2.5 text-left', event.seq === selectedEvent?.seq ? 'bg-brand-tint/70 ring-1 ring-brand/20' : 'hover:bg-white/60')}><div className="flex gap-2"><span className="font-mono text-[9px] text-ink-muted">{event.time ? new Date(event.time).toLocaleTimeString('zh-CN', { hour12: false }) : `#${event.seq}`}</span><span className="text-[11px] font-bold text-ink">{event.title}</span></div><p className="mt-1 line-clamp-2 text-[10px] leading-5 text-ink-muted">{event.detail}</p></button>)}{!agentEvents.length && <p className="py-16 text-center text-xs text-ink-muted">该 Agent 暂无执行记录</p>}</div></div>
          <div className="rounded-2xl border border-white/75 bg-white/45 p-4"><h3 className="text-sm font-bold text-ink">执行详情</h3><p className="mt-1 text-[10px] text-ink-muted">展示所选事件当时的操作、结果与依据，不展示模型思维链</p>{selectedEvent ? <><p className="mt-3 text-sm font-semibold text-ink">{selectedEvent.agentName} · {selectedEvent.title}</p><p className="mt-1 text-xs leading-6 text-ink-muted">{selectedEvent.detail}</p><div className="mt-3 grid gap-2">{detailRows(selectedEvent.snapshot).map(([label, value]) => <div key={label} className="rounded-xl bg-white/65 px-3 py-2.5"><span className="text-[10px] font-semibold text-ink-muted">{label}</span><p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-ink-2">{value}</p></div>)}{!Object.keys(selectedEvent.snapshot ?? {}).length && <p className="py-10 text-center text-xs text-ink-muted">该事件没有额外的结构化执行详情</p>}</div></> : <p className="py-16 text-center text-xs text-ink-muted">请选择 Agent 和具体事件</p>}</div>
        </section>
      </>}
    </main>
  </div>;
}
