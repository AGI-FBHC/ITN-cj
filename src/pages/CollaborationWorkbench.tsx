import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, Sparkles, XCircle } from 'lucide-react';
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

function isLifecycleEvent(event: AdminGenerationEvent) {
  return event.agent === 'SYSTEM' || event.actorType === 'system' || event.eventType === 'task_lifecycle'
    || ['任务已创建', '任务取消', '生成完成', '任务已结束', '任务被取消'].includes(event.title);
}

function CollaborationRounds({ events, selectedSeq, selectedAgent, runningAgent, onSelect, onSelectAgent }: {
  events: AdminGenerationEvent[];
  selectedSeq: number | null;
  selectedAgent: string;
  runningAgent: string | null;
  onSelect: (event: AdminGenerationEvent) => void;
  onSelectAgent: (agentId: string) => void;
}) {
  const lifecycle = events.filter(isLifecycleEvent);
  const work = events.filter((event) => !isLifecycleEvent(event));
  const rows: Array<{ event: AdminGenerationEvent; round: number; isRoundStart: boolean; backward: boolean; jump: number }> = [];
  let round = 0;
  const visited = new Set<string>();
  let previousAgent = '';
  for (const event of work) {
    const lane = Math.max(0, agents.findIndex((item) => item.id === event.agent));
    const prevRow = rows.at(-1);
    const prevLane = prevRow ? Math.max(0, agents.findIndex((item) => item.id === prevRow.event.agent)) : lane;
    const reentry = event.agent !== previousAgent && visited.has(event.agent);
    const repairSignal = ['revising', 'debating'].includes(event.status) || ['revising', 'debating'].includes(event.phase);
    const isNewRound = (reentry || repairSignal) && prevRow !== undefined && prevRow.event.agent !== event.agent;
    if (isNewRound) round += 1;
    rows.push({ event, round, isRoundStart: isNewRound || rows.length === 0, backward: lane < prevLane, jump: Math.abs(lane - prevLane) });
    visited.add(event.agent);
    previousAgent = event.agent;
  }
  const laneLeft = (lane: number) => 'calc(' + Math.round(((lane + 0.5) / agents.length) * 100) + '% - 1px)';
  return (
    <div className="mt-3 overflow-x-auto">
      <div className="relative min-w-[880px] overflow-hidden rounded-2xl border border-white/70 bg-white/20 px-2 pb-2 pt-2">
        {/* 泳道底色（交替） */}
        <div className="pointer-events-none absolute inset-x-2 bottom-2 top-12">
          <div className="flex h-full gap-2">
            {agents.map((agent, index) => (<div key={agent.id} className={cn('flex-1 rounded-xl', index % 2 ? 'bg-white/5' : 'bg-white/20')} />))}
          </div>
        </div>
        {/* 列头 = AI 教研组成员，点击进入该成员 */}
        <div className="relative grid grid-cols-5 gap-2">
          {agents.map((agent) => {
            const own = events.filter((event) => event.agent === agent.id);
            const running = runningAgent === agent.id;
            const selected = selectedAgent === agent.id;
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => onSelectAgent(agent.id)}
                className={cn('flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border px-1.5 transition-all',
                  selected ? 'border-brand/50 bg-brand-tint/70 shadow-sm' : running ? 'border-brand/40 bg-white/75' : own.length ? 'border-white/80 bg-white/55 hover:border-brand/30' : 'border-dashed border-white/70 bg-white/30 hover:border-brand/25')}
                title={agent.duty}
              >
                <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full', running ? 'bg-brand text-paper' : own.length ? 'bg-emerald-100 text-emerald-600' : 'bg-white/85 text-ink-muted/60')}>
                  {running ? <Loader2 size={11} className="animate-spin" /> : own.length ? <CheckCircle2 size={11} /> : <span className="h-1.5 w-1.5 rounded-full bg-ink-muted/40" />}
                </span>
                <span className="truncate text-[10px] font-bold text-ink">{agent.name}</span>
              </button>
            );
          })}
        </div>
        {/* 生命周期事件：一行胶囊 */}
        {lifecycle.length > 0 && (
          <div className="relative mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[8px] font-bold uppercase tracking-wider text-ink-muted">生命周期</span>
            {lifecycle.map((event) => (
              <button
                key={event.seq}
                type="button"
                onClick={() => onSelect(event)}
                className={cn('flex items-center gap-1 rounded-full border px-2 py-0.5 text-[8.5px] font-semibold', event.seq === selectedSeq ? 'border-brand/45 bg-brand-tint/60 text-brand' : 'border-white/80 bg-white/65 text-ink-2 hover:border-brand/30')}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-brand/60" />
                {event.title}
              </button>
            ))}
          </div>
        )}
        {/* 事件序列：紧凑行，初始生成挂在首个事件（第一个 Agent），修复轮次挂在回退到达事件 */}
        <div className="relative py-1">
          {rows.map(({ event, round, isRoundStart, backward, jump }, index) => {
            const lane = Math.max(0, agents.findIndex((item) => item.id === event.agent));
            const prevRow = rows[index - 1];
            const prevLane = prevRow ? Math.max(0, agents.findIndex((item) => item.id === prevRow.event.agent)) : lane;
            const selected = event.seq === selectedSeq;
            return (
              <div key={event.seq}>
                {/* 轮次起始标签（初始生成 / 修复N） */}
                {isRoundStart && (
                  <div className="relative h-5">
                    <span className={cn('absolute left-1 top-0 rounded-full px-1.5 py-px text-[8px] font-bold', round === 0 ? 'bg-brand-tint text-brand' : 'bg-ochre/15 text-[#9A5B3C]')}>
                      {round === 0 ? '初始生成' : '修复 ' + round}
                    </span>
                  </div>
                )}
                {/* 跳线：向右=交接，向左=修复回退 */}
                {prevRow && prevLane !== lane && (
                  <div className="relative h-2.5">
                    <span className={cn('absolute top-1/2 h-0', backward ? 'border-t border-dashed border-ochre/70' : 'border-t border-brand/25')}
                      style={{ left: laneLeft(Math.min(lane, prevLane)), width: 'calc(' + (Math.abs(lane - prevLane) / agents.length) * 100 + '% - 16px)' }} />
                    {backward ? (
                      <span className="absolute -top-px rounded-full bg-ochre/15 px-1 text-[7.5px] font-bold text-[#9A5B3C]" style={{ left: laneLeft(lane) }}>{'↩' + jump + '级'}</span>
                    ) : (
                      <span className="absolute -top-1.5 text-[8px] text-brand/55" style={{ left: laneLeft(lane) }}>›</span>
                    )}
                  </div>
                )}
                {/* 事件行 */}
                <div className="relative h-6">
                  <button
                    type="button"
                    onClick={() => onSelect(event)}
                    className={cn('absolute top-0 flex h-6 max-w-[76%] items-center gap-1 rounded-md px-1.5 transition-colors', selected ? 'bg-brand-tint/80 ring-1 ring-brand/25' : 'hover:bg-white/70')}
                    style={{ left: laneLeft(lane) }}
                    title={event.detail || event.title}
                  >
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', selected ? 'bg-brand ring-2 ring-brand/25' : backward || round > 0 ? 'bg-ochre' : 'bg-brand/50')} />
                    <span className="truncate text-[9.5px] font-semibold text-ink">{event.title}</span>
                    <span className="shrink-0 font-mono text-[7.5px] tabular-nums text-ink-muted">{event.time ? new Date(event.time).toLocaleTimeString('zh-CN', { hour12: false }) : '#' + event.seq}</span>
                  </button>
                </div>
              </div>
            );
          })}
          {!rows.length && <p className="relative py-6 text-center text-xs text-ink-muted">等待第一条协同事件…</p>}
        </div>
      </div>
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

        {/* AI 教研组成员已并入下方泳道表列头：成员即列名，点击列头进入该成员 */}
        <section className="mt-4 rounded-2xl border border-white/70 bg-white/40 p-3">
          <div className="flex items-center justify-between px-1">
            <h4 className="text-sm font-bold text-ink">AI 教研组 · 协作轮次与交接</h4>
            <span className="text-[10px] text-ink-muted">列头即 AI 教研组成员；向右=交接，向左虚线=修复回退；点击事件查看详情</span>
          </div>
          <CollaborationRounds events={events} selectedSeq={selectedEvent?.seq ?? null} selectedAgent={effectiveAgent} runningAgent={active && latest ? latest.agent : null} onSelect={(event) => { if (!isLifecycleEvent(event)) setSelectedAgent(event.agent); setSelectedEventSeq(event.seq); }} onSelectAgent={(agentId) => { setSelectedAgent(agentId); setSelectedEventSeq(events.filter((event) => event.agent === agentId).at(-1)?.seq ?? null); }} />
        </section>

        <EvidenceDebateCourt events={events}/>
        {/* 执行详情：点泳道工作单元/成员节点回看具体事件（工作流列表已由泳道承载，此处仅保留详情） */}
        <section className="mt-4 rounded-2xl border border-white/75 bg-white/45 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-ink">执行详情</h3>
            {selectedEvent && <span className="lf-pill lf-pill-null">{selectedEvent.agentName || (agents.find((item) => item.id === selectedEvent.agent)?.name ?? selectedEvent.agent)}</span>}
          </div>
          <p className="mt-1 text-[10px] text-ink-muted">点击上方泳道中的工作单元或成员节点，回溯当时的操作、结果与依据（不展示模型思维链）</p>
          {selectedEvent ? (
            <div className="mt-3">
              <p className="text-sm font-semibold text-ink">{selectedEvent.title}</p>
              <p className="mt-1 text-xs leading-6 text-ink-muted">{selectedEvent.detail}</p>
              <div className="mt-3 grid gap-2 xl:grid-cols-2">
                {detailRows(selectedEvent.snapshot).map(([label, value]) => (
                  <div key={label} className="rounded-xl bg-white/65 px-3 py-2.5"><span className="text-[10px] font-semibold text-ink-muted">{label}</span><p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-ink-2">{value}</p></div>
                ))}
                {!Object.keys(selectedEvent.snapshot ?? {}).length && <p className="py-10 text-center text-xs text-ink-muted xl:col-span-2">该事件没有额外的结构化执行详情</p>}
              </div>
            </div>
          ) : (
            <div className="mt-3 rounded-xl border border-dashed border-white/80 bg-white/30 px-4 py-10 text-center text-xs text-ink-muted">
              尚未选择事件——点击泳道中的任意工作单元即可查看当时的执行细节
            </div>
          )}
        </section>
      </>}
    </main>
  </div>;
}
