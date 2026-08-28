/**
 * CustomizePipeline — 用户端资源定制流水线页面
 *
 * 两种模式：
 * - 任务模式 /learn/customize/:taskId：聚焦单个定制任务（原逻辑）
 * - 教研组模式 /learn/customize-team/:kpId：以知识点为单位的工作台，
 *   顶部展示该知识点 4 类资源定制状态行（可发起定制/查看/打开），
 *   并支持在领域内跨知识点切换；泳道与执行详情复用协作工作台组件。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, CheckCircle2, ClipboardCheck, Loader2, Presentation, Wand2, Wrench, XCircle } from 'lucide-react';
import { api, streamAdminGenerationTask, type AdminGenerationEvent, type LearningResourceGenerationTask, type LearningTemplateResourceItem } from '@/lib/api';
import { CollaborationRounds, AgentWorkflowSummary, agents, eventDisplayTitle, isLifecycleEvent } from '@/pages/CollaborationWorkbench';
import ExecutionDetailPanel from '@/components/admin/ExecutionDetailPanel';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const activeStatuses = new Set(['queued', 'running', 'retrieving', 'debating', 'planning', 'analyzing', 'generating', 'verifying', 'reviewing', 'revising', 'judging', 'outline_review']);

const RESOURCE_LABEL: Record<string, string> = {
  lecture: '定制讲义',
  practice: '实操指南',
  quiz: '分阶测试题',
};

type TeamResourceType = 'lecture' | 'practice' | 'quiz' | 'ppt';
const TEAM_META: Array<{ type: TeamResourceType; label: string; icon: typeof BookOpen }> = [
  { type: 'lecture', label: '讲义', icon: BookOpen },
  { type: 'practice', label: '实操指南', icon: Wrench },
  { type: 'quiz', label: '分阶测试题', icon: ClipboardCheck },
  { type: 'ppt', label: '交互课件', icon: Presentation },
];

interface TopicOption { id: string; label: string }

export default function CustomizePipeline() {
  const { taskId, kpId: routeKpId } = useParams<{ taskId?: string; kpId?: string }>();
  const navigate = useNavigate();
  /* 教研组模式：路由带 kpId 且无 taskId */
  const teamMode = !taskId && Boolean(routeKpId);

  const [task, setTask] = useState<LearningResourceGenerationTask | null>(null);
  const [events, setEvents] = useState<AdminGenerationEvent[]>([]);
  const [selectedEventSeq, setSelectedEventSeq] = useState<number | null>(null);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [notFound, setNotFound] = useState(false);
  const doneRef = useRef(false);

  /* ===== 教研组模式状态 ===== */
  const [topics, setTopics] = useState<TopicOption[]>([]);
  const [templates, setTemplates] = useState<LearningTemplateResourceItem[]>([]);
  const [tasks, setTasks] = useState<LearningResourceGenerationTask[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const creatingRef = useRef(false);

  /* 任务模式：轮询单个任务 */
  useEffect(() => {
    if (teamMode || !taskId) return;
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
  }, [taskId, teamMode]);

  /* 教研组模式：领域内知识点列表（跨知识点切换） */
  useEffect(() => {
    if (!teamMode) return;
    let alive = true;
    void api.getRagTree('agent').then((tree) => {
      if (!alive) return;
      const options: TopicOption[] = [];
      const walk = (nodes: Array<Record<string, unknown>>) => {
        for (const node of nodes) {
          const level = Number(node.level);
          const children = (node.children ?? []) as Array<Record<string, unknown>>;
          if (level === 2) {
            for (const child of children) {
              if (Number(child.level) === 3) {
                options.push({ id: String(child.nodeCode), label: String(child.name ?? '') });
              }
            }
          } else if (children.length) walk(children);
        }
      };
      walk((tree.nodes ?? []) as unknown as Array<Record<string, unknown>>);
      setTopics(options);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [teamMode]);

  /* 教研组模式：当前知识点母版目录 + 全部定制任务（按母版 ID 精确归属） */
  useEffect(() => {
    if (!teamMode || !routeKpId) return;
    let alive = true;
    const load = async () => {
      try {
        const [listed, taskList] = await Promise.all([
          api.listLearningTemplateResources('agent'),
          api.listCustomizeTasks(),
        ]);
        if (!alive) return;
        setTemplates((listed.items ?? []).filter((item) => item.nodeCode === routeKpId));
        setTasks(taskList.tasks ?? []);
      } catch { /* 拉取失败保留现状 */ }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 2500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [teamMode, routeKpId]);

  /* 教研组模式：每类资源的任务（母版 ID 精确匹配） */
  const rows = useMemo(() => TEAM_META.map(({ type, label, icon }) => {
    const template = templates.find((item) => item.type === type);
    const matched = template ? tasks.find((item) => item.resourceType === type && item.request?.adminResourceId === template.id) : undefined;
    const busy = Boolean(matched && activeStatuses.has(matched.status));
    const customized = Boolean(matched?.status === 'completed' && matched.resourceId);
    return { type, label, icon, template, task: matched, busy, customized };
  }), [templates, tasks]);

  /* 教研组模式：泳道展示的任务（手动选择优先，否则最新进行中，否则最新完成） */
  const teamTaskId = useMemo(() => {
    if (activeTaskId) return activeTaskId;
    const running = rows.map((row) => row.task).filter((item): item is LearningResourceGenerationTask => Boolean(item && activeStatuses.has(item.status)));
    return running[0]?.id ?? rows.find((row) => row.task?.status === 'completed')?.task?.id ?? null;
  }, [activeTaskId, rows]);

  /* 统一：当前展示的任务（任务模式 = task；教研组模式 = teamTaskId 对应任务） */
  const shownTask = teamMode ? (tasks.find((item) => item.id === teamTaskId) ?? null) : task;
  const shownTaskId = teamMode ? teamTaskId : taskId ?? null;
  const active = Boolean(shownTask && activeStatuses.has(shownTask.status));

  /* SSE 流式读取执行事件（两种模式同源） */
  useEffect(() => {
    if (!shownTaskId) { setEvents([]); return; }
    const controller = new AbortController();
    const queueEvent = (event: AdminGenerationEvent) => {
      setEvents((current) => {
        const bySeq = new Map(current.map((item) => [item.seq, item]));
        bySeq.set(event.seq, event);
        return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      });
    };
    void streamAdminGenerationTask('resource', shownTaskId, queueEvent, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [shownTaskId]);

  /* 完成时广播刷新事件 */
  useEffect(() => {
    if (shownTask?.status === 'completed' && !doneRef.current) {
      doneRef.current = true;
      window.dispatchEvent(new CustomEvent('lf:customize-completed', { detail: { taskId: shownTask.id } }));
    }
  }, [shownTask?.status, shownTask?.id]);

  const latest = events.at(-1);
  const effectiveAgent = selectedAgent || latest?.agent || agents[0].id;
  const agentEvents = useMemo(() => events.filter((event) => event.agent === effectiveAgent), [events, effectiveAgent]);
  const selectedEvent = events.find((event) => event.seq === selectedEventSeq) ?? agentEvents.at(-1);
  const selectedEventIsRunning = Boolean(active && latest && selectedEvent && selectedEvent.seq === latest.seq);

  const handleBack = () => navigate('/learn');

  /* ===== 教研组模式动作 ===== */
  const startOne = async (type: TeamResourceType, templateId: string) => {
    try {
      const created = await api.createCustomizeTask({ adminResourceId: templateId, kpId: routeKpId!, resourceType: type });
      setActiveTaskId(created.id);
      setSelectedEventSeq(null);
      setSelectedAgent('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '发起定制失败');
    }
  };

  const customizeAll = async () => {
    if (creatingRef.current) return;
    const pending = rows.filter((row) => row.template?.id && !row.busy && !row.customized);
    if (!pending.length) { toast.info('该知识点的资源均已定制'); return; }
    creatingRef.current = true;
    let firstTaskId: string | null = null;
    for (const row of pending) {
      if (!row.template?.id) continue;
      try {
        const created = await api.createCustomizeTask({ adminResourceId: row.template.id, kpId: routeKpId!, resourceType: row.type });
        firstTaskId ??= created.id;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '发起定制失败');
      }
    }
    creatingRef.current = false;
    if (firstTaskId) { setActiveTaskId(firstTaskId); setSelectedEventSeq(null); setSelectedAgent(''); }
  };

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

  if (!teamMode && !task) {
    return (
      <div className="mx-auto max-w-[720px] px-4 pt-16 text-center text-[13px] text-ink-muted">
        <Loader2 size={18} className="mx-auto animate-spin text-brand" />
        <p className="mt-3">正在载入定制任务…</p>
      </div>
    );
  }

  const completed = shownTask?.status === 'completed';
  const failed = shownTask?.status === 'failed' || shownTask?.status === 'cancelled';
  const progress = shownTask?.progress ?? 0;
  const activeKpLabel = topics.find((topic) => topic.id === routeKpId)?.label ?? routeKpId ?? '';

  return (
    <div className="mx-auto flex h-[calc(100dvh-120px)] max-w-[1400px] flex-col px-4 pb-10 pt-4">
      {/* 顶部：返回 + 标题 + 状态 */}
      <header className="flex shrink-0 items-center justify-between gap-3 pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" onClick={handleBack} className="lf-row-btn inline-flex items-center gap-1.5 !px-3 !py-1.5 text-[12px]">
            <ArrowLeft size={14} />返回知识网络
          </button>
          <div className="min-w-0">
            <h1 className="truncate font-serif text-[17px] font-semibold text-ink">{teamMode ? '定制教研组' : shownTask?.title}</h1>
            <p className="text-[10px] text-ink-muted">
              {teamMode
                ? `${activeKpLabel} · 查看各资源的定制流程，或在其他知识点上发起新的定制`
                : `资源定制 · ${RESOURCE_LABEL[shownTask!.resourceType] ?? shownTask!.resourceType} · 基于管理员母版二次创作`}
            </p>
          </div>
        </div>
        {!teamMode && shownTask && (
          <span className={cn(
            'shrink-0 rounded-md border px-2 py-1 font-mono text-[11px]',
            completed ? 'border-brand/40 bg-brand-tint text-brand'
              : failed ? 'border-brand-danger/40 bg-brand-danger/10 text-brand-danger'
              : 'border-brand-amber/40 bg-brand-amber-tint text-ochre',
          )}>
            {completed ? '定制完成' : failed ? '定制失败' : `定制中 ${progress}%`}
          </span>
        )}
      </header>

      {/* 教研组模式：知识点 4 类资源状态行 */}
      {teamMode && (
        <div className="mb-3 shrink-0 rounded-2xl border border-white/70 bg-white/45 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-ink-2">{activeKpLabel} · 资源定制状态</span>
            {rows.some((row) => row.template?.id && !row.busy && !row.customized) && (
              <button type="button" onClick={() => void customizeAll()} className="lf-row-btn inline-flex items-center gap-1.5 !px-2.5 !py-1.5 text-[11px] text-brand">
                <Wand2 size={12} />一键定制
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {rows.map(({ type, label, icon: Icon, template, task: matched, busy, customized }) => (
              <button
                key={type}
                type="button"
                disabled={!template}
                onClick={() => {
                  if (busy && matched) { setActiveTaskId(matched.id); setSelectedEventSeq(null); setSelectedAgent(''); return; }
                  if (customized && matched?.resourceId) { navigate(`/learn/resource/${matched.resourceId}`); return; }
                  if (template?.id) void startOne(type, template.id);
                }}
                className={cn(
                  'rounded-[12px] border px-3 py-2 text-left transition-all',
                  !template ? 'cursor-not-allowed border-dashed border-hairline bg-paper/60'
                    : busy ? 'border-brand-amber/50 bg-brand-amber-tint/50'
                    : customized ? 'border-brand/45 bg-brand-tint/40 hover:border-brand/60'
                    : 'border-hairline bg-paper hover:border-brand/50 hover:bg-brand-tint/30',
                  teamTaskId === matched?.id && 'ring-2 ring-brand/25',
                )}
              >
                <span className="flex items-center justify-between">
                  <span className={cn('flex h-6 w-6 items-center justify-center rounded-md', template ? 'bg-brand-tint text-brand' : 'bg-paper-deep text-ink-muted')}>
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />}
                  </span>
                  <span className={cn('text-[10px] font-medium', busy ? 'text-ochre' : customized ? 'text-brand' : template ? 'text-ink-2' : 'text-ink-muted')}>
                    {!template ? '暂无母版' : busy ? '定制中' : customized ? '已定制' : '未定制'}
                  </span>
                </span>
                <strong className="mt-1 block truncate text-[12px] font-semibold text-ink">{label}</strong>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 三列布局：成员摘要 | 泳道 | 执行详情（与协作工作台一致） */}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* 泳道主体 */}
        <main className="flex min-w-0 flex-col rounded-2xl border border-white/70 bg-[#f7f5ee]/75">
          <div className="flex items-center justify-between border-b border-white/70 px-4 py-2.5">
            <h3 className="text-sm font-bold text-ink">AI 教研组定制泳道</h3>
            <span className="text-[10px] text-ink-muted">
              {shownTask ? (active ? '实时协同中' : completed ? '已通过' : failed ? '未通过' : shownTask.status) : '选择上方资源查看流程'}
            </span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            {shownTask ? (
              <>
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
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-[12px] text-ink-muted">
                该知识点还没有定制任务。点击上方资源发起定制，或使用「一键定制」。
              </div>
            )}
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

      {/* 教研组模式：领域内知识点切换 */}
      {teamMode && topics.length > 0 && (
        <div className="mt-3 shrink-0 rounded-2xl border border-white/70 bg-white/45 px-3 py-2.5">
          <p className="mb-1.5 text-[10px] font-medium text-ink-2">在领域内选择其他知识点发起定制</p>
          <div className="flex flex-wrap gap-1.5">
            {topics.map((topic) => (
              <button
                key={topic.id}
                type="button"
                onClick={() => navigate(`/learn/customize-team/${topic.id}`)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[11px] transition-all',
                  topic.id === routeKpId ? 'border-brand/50 bg-brand-tint/60 font-medium text-brand' : 'border-hairline bg-paper text-ink-2 hover:border-brand/40 hover:bg-brand-tint/30',
                )}
              >
                {topic.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 底部操作条 */}
      <footer className="flex shrink-0 items-center justify-between gap-3 pt-3">
        <p className="text-[11px] text-ink-muted">
          {teamMode
            ? '定制基于管理员母版进行个性化二次创作，每个资源仅可定制一次。'
            : failed ? (shownTask?.errorMessage ?? '定制过程出现异常，请稍后重试。')
            : completed ? '定制资源已就绪，可开始学习。'
            : '定制基于管理员母版进行个性化二次创作，完成后即可学习。'}
        </p>
        {completed && shownTask?.resourceId && (
          <button type="button" onClick={() => navigate(`/learn/resource/${shownTask.resourceId}`)} className="lf-btn-primary inline-flex items-center gap-1.5">
            <CheckCircle2 size={14} />开始学习
          </button>
        )}
        {failed && !teamMode && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-brand-danger"><XCircle size={14} />可稍后在知识网络中重新发起定制</span>
        )}
      </footer>
    </div>
  );
}
