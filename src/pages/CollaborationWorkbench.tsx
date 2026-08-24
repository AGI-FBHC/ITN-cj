import { Fragment, useEffect, useMemo, useState } from 'react';
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

/**
 * 泳道时序图（方案 B）：五列 Agent 泳道，时间自上而下推进。
 * 相邻事件切换 Agent 时画横向连线：向右 = 正序流转（品牌色实线），向左 = 回退（橙色虚线，
 * 线长即跨度，标注 ↩N 级）；事件落点可点击联动右侧执行详情。
 */
function AgentLaneTimeline({ events, selectedSeq, onSelect }: {
  events: AdminGenerationEvent[];
  selectedSeq: number | null;
  onSelect: (event: AdminGenerationEvent) => void;
}) {
  const laneLeft = (col: number) => 'calc(' + Math.round((col / agents.length) * 100) + '% + 8px)';
  return (
    <div className="relative mt-2">
      {/* 泳道背景列（交替深浅） */}
      <div className="absolute inset-0 flex">
        {agents.map((agent, index) => (
          <div key={agent.id} className={cn('mx-1 flex-1 rounded-xl', index % 2 ? 'bg-white/20' : 'bg-white/40')} />
        ))}
      </div>
      {/* 列头：五个 Agent 泳道名 */}
      <div className="relative flex pb-1">
        {agents.map((agent) => (
          <div key={agent.id} className="mx-1 flex-1 truncate rounded-lg bg-brand-tint/50 px-1 py-1.5 text-center text-[10px] font-bold text-brand">
            {agent.name}
          </div>
        ))}
      </div>
      {/* 事件序列：自上而下 */}
      <div className="relative space-y-0">
        {events.map((event, index) => {
          const col = Math.max(0, agents.findIndex((agent) => agent.id === event.agent));
          const next = events[index + 1];
          const nextCol = next ? Math.max(0, agents.findIndex((agent) => agent.id === next.agent)) : null;
          const backward = next !== undefined && nextCol !== null && nextCol < col;
          const selected = event.seq === selectedSeq;
          return (
            <div key={event.seq}>
              {/* 事件落点行 */}
              <div className="relative h-8 py-0.5">
                <button
                  type="button"
                  onClick={() => onSelect(event)}
                  className={cn('absolute top-0.5 flex h-7 max-w-[75%] items-center gap-1.5 rounded-lg px-1.5 pr-2 text-left transition-colors',
                    selected ? 'bg-brand-tint/80 ring-1 ring-brand/25' : 'hover:bg-white/75')}
                  style={{ left: laneLeft(col) }}
                  title={event.detail}
                >
                  <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', selected ? 'bg-brand ring-2 ring-brand/30' : backward ? 'bg-ochre' : 'bg-brand/50')} />
                  <span className="truncate text-[10px] font-semibold text-ink">{event.title}</span>
                  <span className="shrink-0 font-mono text-[8.5px] text-ink-muted">
                    {event.time ? new Date(event.time).toLocaleTimeString('zh-CN', { hour12: false }) : '#' + event.seq}
                  </span>
                </button>
              </div>
              {/* 过渡连线：向右=正序、向左=回退（跨度=级数） */}
              {next && nextCol !== null && (
                <div className="relative h-3.5">
                  <div
                    className={cn('absolute top-1/2 h-0', backward ? 'border-t-2 border-dashed border-ochre/70' : 'border-t border-brand/30')}
                    style={{
                      left: laneLeft(Math.min(col, nextCol)),
                      width: 'calc(' + (Math.abs(nextCol - col) / agents.length) * 100 + '% - 16px)',
                    }}
                  />
                  {backward && (
                    <span className="absolute -top-1 rounded-full bg-ochre/15 px-1 py-px text-[8.5px] font-bold text-[#9A5B3C]" style={{ left: laneLeft(nextCol) }}>
                      {'↩' + (col - nextCol) + '级'}
                    </span>
                  )}
                  {!backward && nextCol > col && (
                    <span className="absolute -top-1.5 rounded bg-brand/10 px-0.5 text-[8px] text-brand" style={{ left: laneLeft(nextCol) }}>›</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!events.length && <p className="relative py-8 text-center text-xs text-ink-muted">等待第一条协同事件…</p>}
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
  const selectedEvent = agentEvents.find((event) => event.seq === selectedEventSeq) ?? agentEvents.at(-1);
  const active = Boolean(task && activeStatuses.has(task.status) && (!latest || activeStatuses.has(latest.status)));
  const transitions = useMemo(() => events.slice(1).filter((event, index) => event.agent !== events[index].agent).length, [events]);
  const returns = useMemo(() => {
    const seen = new Set<string>(); let count = 0; let prior = '';
    for (const event of events) { if (event.agent !== prior && seen.has(event.agent)) count += 1; seen.add(event.agent); prior = event.agent; }
    return count;
  }, [events]);
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
        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4"><div className="rounded-xl bg-white/55 px-3 py-2.5"><p className="text-[10px] text-ink-muted">协作事件</p><p className="mt-1 text-base font-bold text-ink">{events.length}</p></div><div className="rounded-xl bg-white/55 px-3 py-2.5"><p className="text-[10px] text-ink-muted">Agent 交接</p><p className="mt-1 text-base font-bold text-ink">{transitions}</p></div><div className="rounded-xl bg-white/55 px-3 py-2.5"><p className="text-[10px] text-ink-muted">回退 / 再进入</p><p className="mt-1 text-base font-bold text-ochre">{returns}</p></div><div className="rounded-xl bg-white/55 px-3 py-2.5"><p className="text-[10px] text-ink-muted">任务状态</p><p className="mt-1 text-sm font-bold text-ink">{active ? '自主协同中' : task.status === 'completed' ? '已通过' : task.status === 'failed' ? '未通过' : task.status}</p></div></div>

        <section className="relative mt-4 rounded-2xl border border-white/70 bg-white/45 px-2 pb-4 pt-5">
          {/* 五个 Agent 以节点串联：文字写在节点外（下方名称 + 职责），回退槽位显示弧形回流线 ↩N */}
          <div className="flex items-center">
            {agents.map((agent, index) => {
              const own = events.filter((event) => event.agent === agent.id);
              const running = active && latest?.agent === agent.id;
              const selected = effectiveAgent === agent.id;
              return (
                <Fragment key={agent.id}>
                  <button
                    type="button"
                    onClick={() => { setSelectedAgent(agent.id); setSelectedEventSeq(own.at(-1)?.seq ?? null); }}
                    className="group flex w-[118px] shrink-0 flex-col items-center gap-1.5"
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
                  {index < agents.length - 1 && (
                    /* 链路连线：直线 + 箭头（回退过程以下方泳道时序图呈现） */
                    <div className="relative mx-1 h-8 min-w-6 flex-1">
                      <div className="absolute inset-x-0 top-1/2 h-px bg-ink-muted/25" />
                      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[10px] text-ink-muted/60">→</span>
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        </section>

        <section className="mt-4 rounded-2xl border border-white/70 bg-white/40 p-3">
          <div className="flex items-center justify-between px-1">
            <h4 className="text-sm font-bold text-ink">协同泳道时序</h4>
            <span className="text-[10px] text-ink-muted">向左连线 = 回退（跨度即级数），点击落点查看执行详情</span>
          </div>
          <AgentLaneTimeline events={events} selectedSeq={selectedEvent?.seq ?? null} onSelect={(event) => { setSelectedAgent(event.agent); setSelectedEventSeq(event.seq); }} />
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
