/**
 * CustomizeTeam — 定制教研组工作台
 *
 * 三栏布局：
 * - 左栏：领域内知识点选择器（可滚动，当前高亮，每项显示 4 类资源定制状态微标）
 * - 中栏：当前知识点 4 类资源定制状态卡片 + 一键定制 + 泳道
 * - 右栏：执行详情
 *
 * 路由：/learn/customize-team/:kpId
 * 知识点切换用本地 state，不触发路由变更，SSE 不断开。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, ClipboardCheck, Loader2, Presentation, Wand2, Wrench } from 'lucide-react';
import { api, type AdminGenerationEvent, type LearningResourceGenerationTask, type LearningTemplateResourceItem } from '@/lib/api';
import { CollaborationRounds, AgentWorkflowSummary, agents, eventDisplayTitle, isLifecycleEvent } from '@/pages/CollaborationWorkbench';
import ExecutionDetailPanel from '@/components/admin/ExecutionDetailPanel';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const activeStatuses = new Set(['queued', 'running', 'retrieving', 'debating', 'planning', 'analyzing', 'generating', 'verifying', 'reviewing', 'revising', 'judging', 'outline_review']);

type ResType = 'lecture' | 'practice' | 'quiz' | 'ppt';
const RES_META: Array<{ type: ResType; label: string; icon: typeof BookOpen }> = [
  { type: 'lecture', label: '讲义', icon: BookOpen },
  { type: 'practice', label: '实操指南', icon: Wrench },
  { type: 'quiz', label: '分阶测试题', icon: ClipboardCheck },
  { type: 'ppt', label: '交互课件', icon: Presentation },
];

interface TopicOption { id: string; label: string; chapterId: string; chapterName: string }

export default function CustomizeTeam() {
  const { kpId: routeKpId } = useParams<{ kpId: string }>();
  const navigate = useNavigate();

  /* 当前选中的知识点（本地 state，切换不触发路由变更） */
  const [activeKpId, setActiveKpId] = useState(routeKpId ?? '');
  /* 领域内全部知识点 */
  const [topics, setTopics] = useState<TopicOption[]>([]);
  /* 当前知识点的母版模板 */
  const [templates, setTemplates] = useState<LearningTemplateResourceItem[]>([]);
  /* 当前用户全部定制任务（按母版 ID 精确归属） */
  const [tasks, setTasks] = useState<LearningResourceGenerationTask[]>([]);
  /* 泳道当前展示的任务 ID */
  const [shownTaskId, setShownTaskId] = useState<string | null>(null);
  /* SSE 事件 */
  const [events, setEvents] = useState<AdminGenerationEvent[]>([]);
  const [selectedEventSeq, setSelectedEventSeq] = useState<number | null>(null);
  const [selectedAgent, setSelectedAgent] = useState('');
  const creatingRef = useRef(false);
  const [confirmTarget, setConfirmTarget] = useState<{ type: ResType; templateId: string; label: string } | null>(null);

  /* 加载领域内知识点列表（一次性） */
  useEffect(() => {
    let alive = true;
    void api.getRagTree('agent').then((tree) => {
      if (!alive) return;
      const options: TopicOption[] = [];
      const walk = (nodes: Array<Record<string, unknown>>, chapterId: string, chapterName: string) => {
        for (const node of nodes) {
          const level = Number(node.level);
          const code = String(node.nodeCode ?? '');
          const children = (node.children ?? []) as Array<Record<string, unknown>>;
          if (level === 2) {
            walk(children, code, String(node.name ?? code));
          } else if (level === 3) {
            options.push({ id: code, label: String(node.name ?? ''), chapterId, chapterName });
          } else if (children.length) {
            walk(children, chapterId, chapterName);
          }
        }
      };
      walk((tree.nodes ?? []) as unknown as Array<Record<string, unknown>>, '', '');
      setTopics(options);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  /* 加载当前知识点的母版 + 全部定制任务（轮询） */
  useEffect(() => {
    if (!activeKpId) return;
    let alive = true;
    const load = async () => {
      try {
        const [listed, taskList] = await Promise.all([
          api.listLearningTemplateResources('agent'),
          api.listCustomizeTasks(),
        ]);
        if (!alive) return;
        setTemplates((listed.items ?? []).filter((item) => item.nodeCode === activeKpId));
        setTasks(taskList.tasks ?? []);
      } catch { /* 保留现状 */ }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 3000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [activeKpId]);

  /* 每类资源的行数据（母版 ID 精确匹配） */
  const rows = useMemo(() => RES_META.map(({ type, label, icon }) => {
    const template = templates.find((item) => item.type === type);
    const matched = template ? tasks.find((t) => t.resourceType === type && t.request?.adminResourceId === template.id) : undefined;
    const busy = Boolean(matched && activeStatuses.has(matched.status));
    const customized = Boolean(matched?.status === 'completed' && matched.resourceId);
    return { type, label, icon, template, task: matched, busy, customized };
  }), [templates, tasks]);

  /* 泳道展示的任务：手动选择优先，否则最新进行中，否则最新完成 */
  const effectiveTaskId = useMemo(() => {
    if (shownTaskId) return shownTaskId;
    const running = rows.map((r) => r.task).filter((t): t is LearningResourceGenerationTask => Boolean(t && activeStatuses.has(t.status)));
    return running[0]?.id ?? rows.find((r) => r.task?.status === 'completed')?.task?.id ?? null;
  }, [shownTaskId, rows]);

  const [fullTask, setFullTask] = useState<LearningResourceGenerationTask | null>(null);
  const shownTask = fullTask ?? (tasks.find((t) => t.id === effectiveTaskId) ?? null);
  const active = Boolean(shownTask && activeStatuses.has(shownTask.status));

  /* 拉取任务详情（含完整 events），进行中时轮询 */
  useEffect(() => {
    if (!effectiveTaskId) { setFullTask(null); setEvents([]); return; }
    let alive = true;
    const load = async () => {
      try {
        const detail = await api.getCustomizeTask(effectiveTaskId);
        if (!alive) return;
        setFullTask(detail);
        setEvents((detail.events ?? []) as unknown as AdminGenerationEvent[]);
      } catch { /* 保留现状 */ }
    };
    void load();
    const busy = shownTask ? activeStatuses.has(shownTask.status) : false;
    const timer = busy ? window.setInterval(() => { void load(); }, 2000) : 0;
    return () => { alive = false; if (timer) window.clearInterval(timer); };
  }, [effectiveTaskId]);

  /* 完成时广播刷新 */
  useEffect(() => {
    if (shownTask?.status === 'completed') {
      window.dispatchEvent(new CustomEvent('lf:customize-completed', { detail: { taskId: shownTask.id } }));
    }
  }, [shownTask?.status, shownTask?.id]);

  const latest = events.at(-1);
  const effectiveAgent = selectedAgent || latest?.agent || agents[0].id;
  const agentEvents = useMemo(() => events.filter((e) => e.agent === effectiveAgent), [events, effectiveAgent]);
  const selectedEvent = events.find((e) => e.seq === selectedEventSeq) ?? agentEvents.at(-1);
  const selectedEventIsRunning = Boolean(active && latest && selectedEvent && selectedEvent.seq === latest.seq);

  /* 动作 */
  const startOne = async (type: ResType, templateId: string) => {
    try {
      const created = await api.createCustomizeTask({ adminResourceId: templateId, kpId: activeKpId, resourceType: type });
      setShownTaskId(created.id);
      setSelectedEventSeq(null);
      setSelectedAgent('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '发起定制失败');
    }
  };

  const customizeAll = async () => {
    if (creatingRef.current) return;
    const pending = rows.filter((r) => r.template?.id && !r.busy && !r.customized);
    if (!pending.length) { toast.info('该知识点的资源均已定制'); return; }
    creatingRef.current = true;
    let firstId: string | null = null;
    for (const r of pending) {
      if (!r.template?.id) continue;
      try {
        const created = await api.createCustomizeTask({ adminResourceId: r.template.id, kpId: activeKpId, resourceType: r.type });
        firstId ??= created.id;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '发起定制失败');
      }
    }
    creatingRef.current = false;
    if (firstId) { setShownTaskId(firstId); setSelectedEventSeq(null); setSelectedAgent(''); }
  };

  const switchTopic = (id: string) => {
    setActiveKpId(id);
    setShownTaskId(null);
    setSelectedEventSeq(null);
    setSelectedAgent('');
    setEvents([]);
  };

  const activeKpLabel = topics.find((t) => t.id === activeKpId)?.label ?? activeKpId;
  const completed = shownTask?.status === 'completed';
  const failed = shownTask?.status === 'failed' || shownTask?.status === 'cancelled';

  /* 左栏：每个知识点的定制状态微标颜色 */
  const topicStatus = (topicId: string) => {
    const topicTemplates = templates.filter((item) => item.nodeCode === topicId);
    return RES_META.map(({ type }) => {
      const tpl = topicTemplates.find((item) => item.type === type);
      if (!tpl) return '#D8DDD6'; // 暂无母版
      const task = tasks.find((t) => t.resourceType === type && t.request?.adminResourceId === tpl.id);
      if (task && activeStatuses.has(task.status)) return '#D89238'; // 定制中
      if (task?.status === 'completed' && task.resourceId) return '#4E7860'; // 已定制
      return '#8FA796'; // 未定制
    });
  };

  return (
    <div className="mx-auto flex h-[calc(100dvh-120px)] max-w-[1400px] flex-col px-4 pb-8 pt-4">
      {/* 顶部 */}
      <header className="flex shrink-0 items-center justify-between gap-3 pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" onClick={() => navigate('/learn')} className="lf-row-btn inline-flex items-center gap-1.5 !px-3 !py-1.5 text-[12px]">
            <ArrowLeft size={14} />返回知识网络
          </button>
          <div className="min-w-0">
            <h1 className="truncate font-serif text-[17px] font-semibold text-ink">定制教研组</h1>
            <p className="text-[10px] text-ink-muted">{activeKpLabel} · 基于管理员母版进行个性化定制</p>
          </div>
        </div>
        {rows.some((r) => r.template?.id && !r.busy && !r.customized) && (
          <button type="button" onClick={() => void customizeAll()} className="lf-btn-primary inline-flex shrink-0 items-center gap-1.5 text-[12px]">
            <Wand2 size={13} />一键定制
          </button>
        )}
      </header>

      {/* 三栏 */}
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[220px_minmax(0,1fr)_340px]">

        {/* 左栏：知识点选择器 */}
        <aside className="hidden min-w-0 flex-col overflow-hidden rounded-2xl border border-white/70 bg-white/45 lg:flex">
          <div className="shrink-0 border-b border-white/70 px-3 py-2.5">
            <h3 className="text-[12px] font-bold text-ink">知识点</h3>
            <p className="text-[9px] text-ink-muted">点击切换，查看或发起定制</p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {(() => {
              /* 按章节分组 */
              const chapters = new Map<string, TopicOption[]>();
              for (const topic of topics) {
                const key = topic.chapterId || 'other';
                if (!chapters.has(key)) chapters.set(key, []);
                chapters.get(key)!.push(topic);
              }
              return Array.from(chapters.entries()).map(([chapterId, chapterTopics]) => (
                <div key={chapterId} className="mb-1">
                  <div className="px-2 py-1 text-[9.5px] font-semibold text-ink-muted">{chapterTopics[0]?.chapterName || chapterId}</div>
                  {chapterTopics.map((topic) => {
                    const isActive = topic.id === activeKpId;
                    const colors = topicStatus(topic.id);
                    return (
                      <button
                        key={topic.id}
                        type="button"
                        onClick={() => switchTopic(topic.id)}
                        className={cn(
                          'mb-0.5 w-full rounded-[8px] border px-2.5 py-1.5 text-left transition-all',
                          isActive ? 'border-brand/40 bg-brand-tint/50' : 'border-transparent hover:border-hairline hover:bg-brand-tint/20',
                        )}
                      >
                        <span className="block truncate text-[11.5px] font-medium text-ink">{topic.label}</span>
                        <span className="mt-0.5 flex items-center gap-0.5">
                          {colors.map((color, i) => <i key={i} className="h-1 w-3.5 rounded-full" style={{ backgroundColor: color }} />)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ));
            })()}
          </div>
        </aside>

        {/* 中栏：资源状态卡片 + 泳道 */}
        <main className="flex min-w-0 flex-col gap-2.5 overflow-hidden">
          {/* 资源状态卡片 */}
          <div className="shrink-0 rounded-2xl border border-white/70 bg-white/45 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-medium text-ink-2">{activeKpLabel} · 资源定制状态</span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {rows.map(({ type, label, icon: Icon, template, task: matched, busy, customized }) => (
                <button
                  key={type}
                  type="button"
                  disabled={!template}
                  onClick={() => {
                    if (matched) { setShownTaskId(matched.id); setSelectedEventSeq(null); setSelectedAgent(''); return; }
                    if (template?.id) setConfirmTarget({ type, templateId: template.id, label });
                  }}
                  className={cn(
                    'rounded-[12px] border px-3 py-2 text-left transition-all',
                    !template ? 'cursor-not-allowed border-dashed border-hairline bg-paper/60'
                      : busy ? 'border-brand-amber/50 bg-brand-amber-tint/50'
                      : customized ? 'border-brand/45 bg-brand-tint/40 hover:border-brand/60'
                      : 'border-hairline bg-paper hover:border-brand/50 hover:bg-brand-tint/30',
                    effectiveTaskId === matched?.id && 'ring-2 ring-brand/25',
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

          {/* 泳道 */}
          <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-white/70 bg-[#f7f5ee]/75">
            <div className="flex shrink-0 items-center justify-between border-b border-white/70 px-4 py-2.5">
              <h3 className="text-sm font-bold text-ink">AI 教研组定制泳道</h3>
              <span className="text-[10px] text-ink-muted">
                {shownTask ? (active ? '实时协同中' : completed ? '已通过' : failed ? '未通过' : shownTask.status) : '选择资源查看流程'}
              </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
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
                    onSelectAgent={(agentId) => { setSelectedAgent(agentId); setSelectedEventSeq(events.filter((e) => e.agent === agentId).at(-1)?.seq ?? null); }}
                  />
                </>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <p className="text-[12px] text-ink-muted">该知识点还没有定制任务</p>
                  <button
                    type="button"
                    onClick={() => void customizeAll()}
                    className="lf-btn-primary inline-flex items-center gap-1.5 text-[12px]"
                  >
                    <Wand2 size={13} />一键定制全部资源
                  </button>
                  <p className="text-[10px] text-ink-muted">或点击上方资源卡片逐个发起定制</p>
                </div>
              )}
            </div>
          </div>
        </main>

        {/* 右栏：执行详情 */}
        <aside className="hidden min-w-0 flex-col rounded-2xl border border-white/70 bg-white/45 lg:flex">
          <div className="flex shrink-0 items-center justify-between border-b border-white/70 px-4 py-3">
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-ink">执行详情</h3>
              <p className="mt-0.5 text-[10px] text-ink-muted">操作、结论、依据与下一步</p>
            </div>
            {selectedEvent && <span className="lf-pill lf-pill-null shrink-0">{selectedEvent.agentName || (agents.find((a) => a.id === selectedEvent.agent)?.name ?? selectedEvent.agent)}</span>}
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

      {/* 底部 */}
      <footer className="flex shrink-0 items-center justify-between gap-3 pt-3">
        <p className="text-[11px] text-ink-muted">
          {completed ? '定制资源已就绪，可开始学习。' : failed ? '定制过程出现异常，可重新发起定制。' : '定制基于管理员母版进行个性化二次创作，每个资源仅可定制一次。'}
        </p>

      </footer>

      {/* 确认定制弹窗 */}
      {confirmTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm" onClick={() => setConfirmTarget(null)}>
          <div className="lf-card max-w-sm rounded-2xl p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold text-ink">确认定制</h3>
            <p className="mt-2 text-[12px] text-ink-muted">
              将基于管理员母版为「{confirmTarget.label}」生成个性化定制资源，此操作每个资源仅可执行一次。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmTarget(null)} className="lf-row-btn !px-3 !py-1.5 text-[12px]">取消</button>
              <button
                type="button"
                onClick={() => {
                  const target = confirmTarget;
                  setConfirmTarget(null);
                  if (target) void startOne(target.type, target.templateId);
                }}
                className="lf-btn-primary !px-3 !py-1.5 text-[12px]"
              >
                确认定制
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
