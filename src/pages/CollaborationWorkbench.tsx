import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, Loader2, RefreshCw, Sparkles, XCircle } from 'lucide-react';
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
  const rows: Array<{ event: AdminGenerationEvent; round: number; isRoundStart: boolean }> = [];
  let round = 0;
  const visited = new Set<string>();
  let previousAgent = '';
  for (const event of work) {
    const prevRow = rows.at(-1);
    const reentry = event.agent !== previousAgent && visited.has(event.agent);
    const repairSignal = ['revising', 'debating'].includes(event.status) || ['revising', 'debating'].includes(event.phase);
    const isNewRound = (reentry || repairSignal) && prevRow !== undefined && prevRow.event.agent !== event.agent;
    if (isNewRound) round += 1;
    rows.push({ event, round, isRoundStart: isNewRound || rows.length === 0 });
    visited.add(event.agent);
    previousAgent = event.agent;
  }

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
        {/* 事件序列：与列头同一 grid-cols-5 对齐；初始生成挂在首个事件，修复轮次挂在回退到达事件 */}
        <div className="relative py-1">
          {rows.map(({ event, round, isRoundStart }) => {
            const lane = Math.max(0, agents.findIndex((item) => item.id === event.agent));
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
                {/* 事件行（与列头同 grid 对齐） */}
                <div className="grid h-6 grid-cols-5 gap-2">
                  <button
                    type="button"
                    onClick={() => onSelect(event)}
                    style={{ gridColumnStart: lane + 1, gridRowStart: 1 }}
                    className={cn('flex items-center gap-1 overflow-hidden rounded-md px-1.5 transition-colors', selected ? 'bg-brand-tint/80 ring-1 ring-brand/25' : 'hover:bg-white/70')}
                    title={event.detail || event.title}
                  >
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', selected ? 'bg-brand ring-2 ring-brand/25' : round > 0 ? 'bg-ochre' : 'bg-brand/50')} />
                    <span className="truncate text-[9.5px] font-semibold text-ink">{event.title}</span>
                    <span className="ml-auto shrink-0 font-mono text-[7.5px] tabular-nums text-ink-muted">{event.time ? new Date(event.time).toLocaleTimeString('zh-CN', { hour12: false }) : '#' + event.seq}</span>
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

function AgentWorkflowSummary({ events, running }: { events: AdminGenerationEvent[]; running: boolean }) {
  const path = events.filter((event) => !isLifecycleEvent(event)).reduce<string[]>((result, event) => {
    if (result.at(-1) !== event.agent) result.push(event.agent);
    return result;
  }, []);
  if (!path.length) return null;
  return (
    <section className="mt-4 rounded-2xl border border-white/75 bg-white/45 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[10px] font-bold text-ink-muted">本次协同路径</span>
        {path.map((agentId, index) => {
          const agent = agents.find((item) => item.id === agentId);
          const repeated = path.indexOf(agentId) !== index;
          const current = running && index === path.length - 1;
          return (
            <span key={`${agentId}-${index}`} className="contents">
              {index > 0 && <span className="text-[10px] text-ink-muted/55">→</span>}
              <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold', current ? 'border-brand/40 bg-brand-tint text-brand' : repeated ? 'border-ochre/30 bg-ochre/10 text-[#9A5B3C]' : 'border-white/85 bg-white/70 text-ink-2')}>
                {current && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />}
                {agent?.name ?? agentId}
                {repeated && <span className="text-[8px] font-bold">再次进入</span>}
              </span>
            </span>
          );
        })}
      </div>
    </section>
  );
}

function contextOf(task: WorkbenchTask): Record<string, unknown> {
  if (task.taskKind === 'ppt') return task.request?.generationContext ?? {};
  const request = task.request as (typeof task.request & { generation_context?: Record<string, unknown> }) | undefined;
  return request?.generationContext ?? request?.generation_context ?? {};
}

function taskKey(task: WorkbenchTask) { return `${task.taskKind}-${task.id}`; }

/** 任务项：状态/类型/进度 + 充电涌动进度条；选中与运行有对比度区分 */
function WorkbenchTaskItem({ item, selected, onClick }: { item: WorkbenchTask; selected: boolean; onClick: () => void }) {
  const active = activeStatuses.has(item.status);
  const failed = item.status === 'failed' || item.status === 'cancelled';
  const context = contextOf(item);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('w-full overflow-hidden rounded-xl border text-left transition-all',
        selected ? 'border-brand/60 bg-brand-tint/70 shadow-[0_2px_10px_rgba(78,120,96,0.16)] ring-1 ring-brand/20' :
        active ? 'border-white/85 bg-white/60 hover:border-brand/35' :
        failed ? 'border-rose-200/80 bg-rose-50/50 hover:border-brand/25' :
        'border-white/75 bg-white/40 hover:border-brand/25')}
    >
      <div className="flex items-center gap-1.5 px-3 pt-2.5">
        {active ? <Loader2 size={12} className="shrink-0 animate-spin text-brand" /> : failed ? <XCircle size={12} className="shrink-0 text-red-500" /> : <CheckCircle2 size={12} className="shrink-0 text-emerald-600" />}
        <span className="lf-pill lf-pill-null !px-1.5 !py-0.5 text-[9px]">{typeText[item.resourceType]}</span>
        <span className="ml-auto font-mono text-[9px] tabular-nums text-ink-muted">{item.progress}%</span>
      </div>
      <p className="mt-1.5 truncate px-3 text-xs font-bold text-ink">{String(context.topicName || item.title)}</p>
      <p className="mt-0.5 line-clamp-1 px-3 text-[9.5px] leading-4 text-ink-muted">{item.stageMessage}</p>
      <div className="px-3 pb-3 pt-2">
        <div className="lf-charge h-1.5 overflow-hidden rounded-full bg-white/75">
          <div className={cn('relative h-full rounded-full', failed ? 'bg-red-400' : 'bg-brand')} style={{ width: Math.max(3, item.progress) + '%' }}>
            {active && <><span className="surge" /><span className="grain" /></>}
          </div>
        </div>
      </div>
    </button>
  );
}

/** 递归 JSON 树（深色开发者面板）：key 绿 / 字符串琥珀 / 数字蓝 / 布尔紫 / null 灰 */
function JsonTree({ value }: { value: unknown }) {
  if (value === null) return <span className="jz">null</span>;
  if (typeof value === 'string') return <span className="js">"{value}"</span>;
  if (typeof value === 'number') return <span className="jn">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="jb">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="jp">[]</span>;
    return (
      <>
        <span className="jp">[</span>
        {value.map((item, index) => (
          <div key={index} className="pl-4"><JsonTree value={item} />{index < value.length - 1 && <span className="jp">,</span>}</div>
        ))}
        <span className="jp">]</span>
      </>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return <span className="jp">{"{}"}</span>;
    return (
      <>
        <span className="jp">{"{}"}</span>
        {entries.map(([key, val], index) => (
          <div key={key} className="pl-4">
            <span className="jk">"{key}"</span><span className="jp">: </span>
            <JsonTree value={val} />
            {index < entries.length - 1 && <span className="jp">,</span>}
          </div>
        ))}
        <span className="jp">{"}"}</span>
      </>
    );
  }
  return <span className="jz">—</span>;
}

export default function CollaborationWorkbench() {
  const { session } = useAuth();
  const isAdmin = session?.roles?.includes('admin') === true;
  const [params, setParams] = useSearchParams();
  const [tasks, setTasks] = useState<WorkbenchTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<AdminGenerationEvent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [selectedEventSeq, setSelectedEventSeq] = useState<number | null>(null);
  const [taskTab, setTaskTab] = useState('active');
  const [tasksCollapsed, setTasksCollapsed] = useState(false);
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
  const grouped = useMemo(() => ({ active: tasks.filter((item) => activeStatuses.has(item.status)), finished: tasks.filter((item) => !activeStatuses.has(item.status)) }), [tasks]);


  return (
    <div className="lf-anim-in-up flex h-full min-h-0 flex-col gap-4 lg:flex-row">
      {/* 第一列：AI 教研任务（可折叠） */}
      <aside className={cn('flex w-full shrink-0 flex-col rounded-2xl border border-white/70 bg-white/45 transition-all duration-300 lg:w-[290px]', tasksCollapsed && 'lg:w-0 lg:min-w-0 lg:overflow-hidden lg:border-none lg:bg-transparent lg:p-0 lg:gap-0')}>
        <div className="flex items-center gap-2 border-b border-white/70 p-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-paper"><Sparkles size={15} /></span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-ink">AI 教研任务</h3>
            <p className="mt-0.5 truncate text-[9.5px] text-ink-muted">{grouped.active.length + grouped.finished.length} 项 · 3s 自动刷新</p>
          </div>
          <button onClick={() => void load()} className="lf-row-btn !p-1.5" aria-label="刷新任务"><RefreshCw size={12} className={loading ? 'animate-spin' : ''} /></button>
        </div>
        {/* 进行中 / 已完成 切换 */}
        <div className="border-b border-white/70 p-2.5">
          <div className="flex gap-1 rounded-xl bg-white/55 p-1">
            <button onClick={() => setTaskTab('active')} className={cn('flex-1 rounded-lg px-2 py-1.5 text-[11px] font-bold transition-colors', taskTab === 'active' ? 'bg-brand text-paper shadow-sm' : 'text-ink-muted hover:text-ink')}>进行中 {grouped.active.length}</button>
            <button onClick={() => setTaskTab('finished')} className={cn('flex-1 rounded-lg px-2 py-1.5 text-[11px] font-bold transition-colors', taskTab === 'finished' ? 'bg-brand text-paper shadow-sm' : 'text-ink-muted hover:text-ink')}>已完成 {grouped.finished.length}</button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          <div className="space-y-2">
            {(taskTab === 'active' ? grouped.active : grouped.finished).map((item) => (
              <WorkbenchTaskItem key={taskKey(item)} item={item} selected={taskKey(item) === selectedKey} onClick={() => setParams({ task: taskKey(item) })} />
            ))}
            {(taskTab === 'active' ? grouped.active : grouped.finished).length === 0 && (
              <div className="lf-empty rounded-xl p-6 text-xs">{taskTab === 'active' ? '暂无进行中的任务' : '暂无已完成任务'}</div>
            )}
          </div>
        </div>
      </aside>

      {/* 第二列：Agents 教研组协作泳道（主体，占最多空间） */}
      <main className="flex min-w-0 flex-1 flex-col rounded-2xl border border-white/70 bg-[#f7f5ee]/75">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/70 px-4 py-3">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setTasksCollapsed((collapsed) => !collapsed)} className="lf-row-btn !p-1.5" title={tasksCollapsed ? '展开任务栏' : '收起任务栏'}>
              {tasksCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            </button>
            <div>
              <h3 className="text-sm font-bold text-ink">Agents 教研组协作泳道</h3>
              {task && <p className="mt-0.5 truncate text-[9.5px] text-ink-muted">{task.title} · {active ? '实时协同中' : task.status === 'completed' ? '已通过' : task.status === 'failed' ? '未通过' : task.status}</p>}
            </div>
          </div>
          <span className="text-[10px] text-ink-muted">列头即成员 · 时间自上而下</span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!task ? (
            <div className="flex h-full items-center justify-center text-sm text-ink-muted">{loading ? '正在读取教研任务…' : '还没有可以查看的教研任务'}</div>
          ) : (
            <>
              <CollaborationRounds events={events} selectedSeq={selectedEvent?.seq ?? null} selectedAgent={effectiveAgent} runningAgent={active && latest ? latest.agent : null} onSelect={(event) => { if (!isLifecycleEvent(event)) setSelectedAgent(event.agent); setSelectedEventSeq(event.seq); }} onSelectAgent={(agentId) => { setSelectedAgent(agentId); setSelectedEventSeq(events.filter((event) => event.agent === agentId).at(-1)?.seq ?? null); }} />
              <AgentWorkflowSummary events={events} running={active} />
              <EvidenceDebateCourt events={events} hideIdle />
            </>
          )}
        </div>
      </main>

      {/* 第三列：执行详情（JSON 视图，专业开发者面板） */}
      <aside className="flex w-full shrink-0 flex-col rounded-2xl border border-white/70 bg-white/45 lg:w-[350px]">
        <div className="flex items-center justify-between gap-2 border-b border-white/70 px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-ink">执行详情</h3>
            <p className="mt-0.5 text-[10px] text-ink-muted">选中事件的结构化执行记录（JSON）</p>
          </div>
          {selectedEvent && <span className="lf-pill lf-pill-null shrink-0">{selectedEvent.agentName || (agents.find((item) => item.id === selectedEvent.agent)?.name ?? selectedEvent.agent)}</span>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {selectedEvent ? (
            <div className="lf-json p-3.5 text-[11px] leading-[1.65]">
              <JsonTree value={{
                seq: selectedEvent.seq,
                agent: selectedEvent.agentName || selectedEvent.agent,
                stage: selectedEvent.phase || selectedEvent.status,
                time: selectedEvent.time,
                title: selectedEvent.title,
                detail: selectedEvent.detail,
                snapshot: selectedEvent.snapshot ?? {},
              }} />
            </div>
          ) : (
            <div className="mt-6 rounded-xl border border-dashed border-white/80 bg-white/30 px-4 py-10 text-center text-xs leading-6 text-ink-muted">
              尚未选择事件
              <br />点击泳道中的工作单元或成员节点查看执行细节
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
