/**
 * CustomizePipeline — 用户端资源定制流水线页面
 *
 * 复用协作工作台（CollaborationWorkbench）的泳道与执行详情组件：
 * CollaborationRounds（泳道）+ AgentWorkflowSummary（成员摘要）+ ExecutionDetailPanel（执行详情）。
 * 定制任务复用 learning_resource_generation_tasks 存储，SSE 流式读取事件。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { api, streamAdminGenerationTask, type AdminGenerationEvent, type LearningResourceGenerationTask } from '@/lib/api';
import { CollaborationRounds, AgentWorkflowSummary, agents, eventDisplayTitle, isLifecycleEvent } from '@/pages/CollaborationWorkbench';
import ExecutionDetailPanel from '@/components/admin/ExecutionDetailPanel';
import { cn } from '@/lib/utils';

const activeStatuses = new Set(['queued', 'running', 'retrieving', 'debating', 'planning', 'analyzing', 'generating', 'verifying', 'reviewing', 'revising', 'judging', 'outline_review']);

const RESOURCE_LABEL: Record<string, string> = {
  lecture: '定制讲义',
  practice: '实操指南',
  quiz: '分阶测试题',
};

export default function CustomizePipeline() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [task, setTask] = useState<LearningResourceGenerationTask | null>(null);
  const [events, setEvents] = useState<AdminGenerationEvent[]>([]);
  const [selectedEventSeq, setSelectedEventSeq] = useState<number | null>(null);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [notFound, setNotFound] = useState(false);
  const doneRef = useRef(false);

  const active = Boolean(task && activeStatuses.has(task.status));

  /* 轮询任务状态 */
  useEffect(() => {
    if (!taskId) return;
    let alive = true;
    const load = async () => {
      try {
        const next = await api.getCustomizeTask(taskId);
        if (!alive) return;
        setTask(next);
        setNotFound(false);
      } catch {
        if (alive) setNotFound(true);
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 2500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [taskId]);

  /* SSE 流式读取执行事件（与工作台同源） */
  useEffect(() => {
    if (!taskId) return;
    const controller = new AbortController();
    const queueEvent = (event: AdminGenerationEvent) => {
      setEvents((current) => {
        const bySeq = new Map(current.map((item) => [item.seq, item]));
        bySeq.set(event.seq, event);
        return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      });
    };
    void streamAdminGenerationTask('resource', taskId, queueEvent, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [taskId]);

  /* 完成时广播刷新事件 */
  useEffect(() => {
    if (task?.status === 'completed' && !doneRef.current) {
      doneRef.current = true;
      window.dispatchEvent(new CustomEvent('lf:customize-completed', { detail: { taskId: task.id } }));
    }
  }, [task?.status, task?.id]);

  const latest = events.at(-1);
  const effectiveAgent = selectedAgent || latest?.agent || agents[0].id;
  const agentEvents = useMemo(() => events.filter((event) => event.agent === effectiveAgent), [events, effectiveAgent]);
  const selectedEvent = events.find((event) => event.seq === selectedEventSeq) ?? agentEvents.at(-1);
  const selectedEventIsRunning = Boolean(active && latest && selectedEvent && selectedEvent.seq === latest.seq);

  const handleBack = () => navigate('/learn');

  if (notFound) {
    return (
      <div className="mx-auto max-w-[720px] px-4 pt-10">
        <div className="lf-card p-8 text-center">
          <p className="text-[14px] text-ink-muted">定制任务不存在或已被清理。</p>
          <button type="button" onClick={handleBack} className="lf-btn-primary mt-4 inline-flex">返回知识网络</button>
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="mx-auto max-w-[720px] px-4 pt-16 text-center text-[13px] text-ink-muted">
        <Loader2 size={18} className="mx-auto animate-spin text-brand" />
        <p className="mt-3">正在载入定制任务…</p>
      </div>
    );
  }

  const completed = task.status === 'completed';
  const failed = task.status === 'failed' || task.status === 'cancelled';
  const progress = task.progress ?? 0;

  return (
    <div className="mx-auto flex h-[calc(100dvh-120px)] max-w-[1400px] flex-col px-4 pb-10 pt-4">
      {/* 顶部：返回 + 标题 + 状态 */}
      <header className="flex shrink-0 items-center justify-between gap-3 pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" onClick={handleBack} className="lf-row-btn inline-flex items-center gap-1.5 !px-3 !py-1.5 text-[12px]">
            <ArrowLeft size={14} />返回知识网络
          </button>
          <div className="min-w-0">
            <h1 className="truncate font-serif text-[17px] font-semibold text-ink">{task.title}</h1>
            <p className="text-[10px] text-ink-muted">资源定制 · {RESOURCE_LABEL[task.resourceType] ?? task.resourceType} · 基于管理员母版二次创作</p>
          </div>
        </div>
        <span className={cn(
          'shrink-0 rounded-md border px-2 py-1 font-mono text-[11px]',
          completed ? 'border-brand/40 bg-brand-tint text-brand'
            : failed ? 'border-brand-danger/40 bg-brand-danger/10 text-brand-danger'
            : 'border-brand-amber/40 bg-brand-amber-tint text-ochre',
        )}>
          {completed ? '定制完成' : failed ? '定制失败' : `定制中 ${progress}%`}
        </span>
      </header>

      {/* 三列布局：成员摘要 | 泳道 | 执行详情（与协作工作台一致） */}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* 泳道主体 */}
        <main className="flex min-w-0 flex-col rounded-2xl border border-white/70 bg-[#f7f5ee]/75">
          <div className="flex items-center justify-between border-b border-white/70 px-4 py-2.5">
            <h3 className="text-sm font-bold text-ink">AI 教研组定制泳道</h3>
            <span className="text-[10px] text-ink-muted">{active ? '实时协同中' : completed ? '已通过' : failed ? '未通过' : task.status}</span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
            <AgentWorkflowSummary events={events} running={active} />
            <CollaborationRounds
              events={events}
              selectedSeq={selectedEvent?.seq ?? null}
              selectedAgent={effectiveAgent}
              runningAgent={active && latest ? latest.agent : null}
              running={active}
              onSelect={(event) => { setSelectedEventSeq(event.seq); if (!isLifecycleEvent(event)) setSelectedAgent(event.agent); }}
              onSelectAgent={(agentId) => { setSelectedAgent(agentId); setSelectedEventSeq(events.filter((event) => event.agent === agentId).at(-1)?.seq ?? null); }}
            />
          </div>
        </main>

        {/* 执行详情侧栏 */}
        <aside className="hidden min-w-0 flex-col rounded-2xl border border-white/70 bg-white/45 lg:flex">
          <div className="flex items-center justify-between border-b border-white/70 px-4 py-3">
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-ink">执行详情</h3>
              <p className="mt-0.5 text-[10px] text-ink-muted">操作、结论、依据与下一步</p>
            </div>
            {selectedEvent && <span className="lf-pill lf-pill-null shrink-0">{selectedEvent.agentName || (agents.find((item) => item.id === selectedEvent.agent)?.name ?? selectedEvent.agent)}</span>}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {selectedEvent ? (
              <ExecutionDetailPanel key={selectedEvent.seq} event={selectedEvent} title={eventDisplayTitle(selectedEvent)} running={selectedEventIsRunning} />
            ) : (
              <div className="mt-6 rounded-xl border border-dashed border-white/80 bg-white/30 px-4 py-10 text-center text-xs leading-6 text-ink-muted">
                尚未选择事件
                <br />点击泳道中的工作单元或成员节点查看执行细节
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* 底部操作条 */}
      <footer className="flex shrink-0 items-center justify-between gap-3 pt-3">
        <p className="text-[11px] text-ink-muted">
          {failed ? (task.errorMessage ?? '定制过程出现异常，请稍后重试。') : completed ? '定制资源已就绪，可开始学习。' : '定制基于管理员母版进行个性化二次创作，完成后即可学习。'}
        </p>
        {completed && task.resourceId && (
          <button type="button" onClick={() => navigate(`/learn/resource/${task.resourceId}`)} className="lf-btn-primary inline-flex items-center gap-1.5">
            <CheckCircle2 size={14} />开始学习
          </button>
        )}
        {failed && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-brand-danger"><XCircle size={14} />可稍后在知识网络中重新发起定制</span>
        )}
      </footer>
    </div>
  );
}
