import { useEffect, useMemo, useState } from 'react';
import {
  ArchiveRestore, ArrowLeft, Ban, BookOpen, CheckCircle2, ChevronDown, ChevronRight, ClipboardList,
  Eye, FileText, FolderTree, LayoutTemplate, ListChecks, Loader2, MonitorPlay, Plus, Radio, RefreshCw, Sparkles, Trash2, Wrench, X, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { api, streamAdminGenerationTask, type AdminGenerationEvent, type AdminResourceDetail, type AdminResourceItem, type AdminResourceStats, type LearningResourceGenerateInput, type LearningResourceGenerationTask, type RagDomain, type RagTree, type RagTreeNode } from '@/lib/api';
import { presentationApi, type PresentationRequest, type PresentationTaskSummary } from '@/lib/presentationApi';
import { useCachedData } from '@/hooks/useCachedData';
import { clearCacheStartsWith } from '@/lib/swrCache';
import ResourcePreview from '@/components/admin/ResourcePreview';
import ExecutionDetailPanel from '@/components/admin/ExecutionDetailPanel';
import { cn } from '@/lib/utils';
import { agents as generationAgents, CollaborationRounds, AgentWorkflowSummary, eventDisplayTitle, isLifecycleEvent } from '@/pages/CollaborationWorkbench';

type ResourceKind = 'lecture' | 'practice' | 'quiz' | 'ppt';
type View = 'library' | 'archive';
type GenerationTask =
  | ({ taskKind: 'resource' } & LearningResourceGenerationTask)
  | ({ taskKind: 'ppt' } & PresentationTaskSummary);
const typeText: Record<string, string> = { lecture: '讲义', practice: '实操指南', quiz: '题库', ppt: '交互课件' };
const kinds: [ResourceKind, string, string, typeof FileText][] = [
  ['lecture', '讲义', '知识讲解', BookOpen],
  ['practice', '实操指南', '步骤与任务', Wrench],
  ['quiz', '题库', '分阶测试资源', ClipboardList],
  ['ppt', '交互课件', '可播放的教学课件', MonitorPlay],
];

function flatten(nodes: RagTreeNode[], expanded: Set<number>, depth = 0): { node: RagTreeNode; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...(node.children?.length && expanded.has(node.id) ? flatten(node.children, expanded, depth + 1) : [])]);
}

export default function ResourceCenterAdmin() {
  const navigate = useNavigate();
  const [domain, setDomain] = useState<RagDomain | { code: '__unassigned__'; name: string; description: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [node, setNode] = useState<RagTreeNode | null>(null);
  const [kind, setKind] = useState<ResourceKind>('lecture');
  const [view, setView] = useState<View>('library');
  const [keyword, setKeyword] = useState('');
  const [detail, setDetail] = useState<AdminResourceDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [focusTask, setFocusTask] = useState<string | null>(null);
  const [processTask, setProcessTask] = useState<GenerationTask | null>(null);
  const [generationTasks, setGenerationTasks] = useState<GenerationTask[]>([]);
  const [generationModalOpen, setGenerationModalOpen] = useState(false);
  const [selectedKinds, setSelectedKinds] = useState<Set<ResourceKind>>(new Set(['lecture', 'practice', 'quiz', 'ppt']));
  const [generationBusy, setGenerationBusy] = useState(false);
  const [groupResources, setGroupResources] = useState<AdminResourceItem[]>([]);
  const [selectedGroupName, setSelectedGroupName] = useState('默认分组');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['默认分组']));

  /* ---- SWR 缓存：先展示缓存，后台异步更新 ---- */
  const domainsQ = useCachedData<RagDomain[]>('admin:rag-domains', () => api.listRagDomains(), { ttlMs: 30_000 });
  const statsQ = useCachedData<AdminResourceStats>('admin:res:stats', () => api.getAdminResourceStats(), { ttlMs: 10_000 });
  const treeQ = useCachedData<RagTree>(
    domain && domain.code !== '__unassigned__' ? `admin:rag-tree:${domain.code}` : null,
    () => api.getRagTree((domain as RagDomain).code),
    { ttlMs: 60_000 },
  );
  const listQ = useCachedData<{ items: AdminResourceItem[]; total: number }>(
    domain ? `admin:res:${view}:${domain.code}:${node?.nodeCode ?? ''}:${keyword}` : null,
    () => api.listAdminResources({ view, keyword, domainCode: (domain as { code: string }).code, nodeCode: node?.nodeCode }),
    { ttlMs: 15_000 },
  );
  const pptQ = useCachedData<{ items: AdminResourceItem[]; total: number }>(
    domain ? `admin:ppt:${view}:${domain.code}:${node?.nodeCode ?? ''}:${keyword}` : null,
    () => api.listAdminResources({ view, type: 'ppt', keyword, domainCode: (domain as { code: string }).code, nodeCode: node?.nodeCode }),
    { ttlMs: 15_000 },
  );

  useEffect(() => {
    if (!treeQ.data) return;
    const timer = window.setTimeout(() => setExpanded(new Set(treeQ.data?.nodes.map((n) => n.id) ?? [])), 0);
    return () => window.clearTimeout(timer);
  }, [treeQ.data]);
  useEffect(() => {
    if (!node || !domain || domain.code === '__unassigned__') { setGroupResources([]); return; }
    let cancelled = false;
    api.listAdminResources({ view: 'library', domainCode: domain.code, nodeCode: node.nodeCode })
      .then((result) => { if (!cancelled) setGroupResources(result.items); })
      .catch(() => { if (!cancelled) setGroupResources([]); });
    return () => { cancelled = true; };
  }, [node?.id, node?.nodeCode, domain?.code]);
  useEffect(() => {
    const message = domainsQ.error?.message ?? statsQ.error?.message ?? treeQ.error?.message ?? listQ.error?.message;
    if (message) toast.error(message);
  }, [domainsQ.error, statsQ.error, treeQ.error, listQ.error]);

  const loadGenerationTasks = async () => {
    const [resources, presentations] = await Promise.all([
      api.listLearningResourceTasks(100),
      presentationApi.listPresentationSummariesFresh(100, true),
    ]);
    const textContext = (task: LearningResourceGenerationTask) => {
      const request = task.request as (LearningResourceGenerateInput & { generation_context?: Record<string, unknown> }) | undefined;
      return request?.generationContext ?? request?.generation_context;
    };
    const textTasks: GenerationTask[] = resources.tasks
      .filter((task) => textContext(task)?.adminGeneration === true)
      .map((task) => ({ ...task, taskKind: 'resource' as const }));
    const pptTasks: GenerationTask[] = presentations.tasks
      .filter((task) => task.request?.generationContext?.adminGeneration === true)
      .map((task) => ({ ...task, taskKind: 'ppt' as const }));
    setGenerationTasks([...textTasks, ...pptTasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
  };

  useEffect(() => {
    const initial = window.setTimeout(
      () => void loadGenerationTasks().catch((error) => toast.error(error instanceof Error ? error.message : '生成任务读取失败')),
      0,
    );
    const timer = window.setInterval(() => void loadGenerationTasks().catch(() => undefined), 2500);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, []);

  const generationContext = () => ({
    adminGeneration: true,
    domainCode: domain?.code,
    nodeCode: node?.nodeCode,
    topicName: node?.name,
    kpId: node?.nodeCode,
    groupName: selectedGroupName,
  });
  const groupTypeMap = useMemo(() => {
    const map = new Map<string, Set<ResourceKind>>();
    const addType = (group: string, type: ResourceKind) => {
      if (!kinds.some(([id]) => id === type)) return;
      const set = map.get(group) ?? new Set<ResourceKind>();
      set.add(type);
      map.set(group, set);
    };
    groupResources.forEach((item) => { if (!item.archivedAt) addType(item.groupName || '默认分组', item.type as ResourceKind); });
    generationTasks.forEach((task) => {
      const ctx = taskContext(task);
      if (task.status === 'completed' && ctx.domainCode === domain?.code && ctx.nodeCode === node?.nodeCode) {
        addType(String(ctx.groupName || '默认分组'), task.taskKind === 'ppt' ? 'ppt' : task.resourceType);
      }
    });
    return map;
  }, [groupResources, generationTasks, domain?.code, node?.nodeCode]);
  const groupNames = useMemo(() => Array.from(new Set(['默认分组', ...groupTypeMap.keys()])), [groupTypeMap]);
  useEffect(() => { if (!groupNames.includes(selectedGroupName)) setSelectedGroupName('默认分组'); }, [groupNames, selectedGroupName]);
  const completedTypes = groupTypeMap.get(selectedGroupName) ?? new Set<ResourceKind>();
  const groupedEntries = useMemo(() => {
    const map = new Map<string, Map<ResourceKind, AdminResourceItem>>();
    const ensure = (g: string) => { if (!map.has(g)) map.set(g, new Map()); return map.get(g)!; };
    [...(listQ.data?.items ?? []), ...(pptQ.data?.items ?? [])].forEach((item) => { ensure(item.groupName || '默认分组').set(item.type as ResourceKind, item); });
    generationTasks.forEach((task) => {
      const ctx = taskContext(task);
      if (task.status === 'completed' && ctx.domainCode === domain?.code && ctx.nodeCode === node?.nodeCode) ensure(String(ctx.groupName || '默认分组'));
    });
    ensure('默认分组');
    return [...map.entries()].sort(([a], [b]) => a === '默认分组' ? -1 : b === '默认分组' ? 1 : a.localeCompare(b));
  }, [listQ.data?.items, pptQ.data?.items, generationTasks, domain?.code, node?.nodeCode]);
  const pptReady = ['lecture', 'practice', 'quiz'].every((type) => completedTypes.has(type as ResourceKind));

  const startGeneration = async (target: ResourceKind) => {
    if (!node || !domain || domain.code === '__unassigned__') throw new Error('请先选择一个具体知识点');
    if (target === 'ppt') {
      const request: PresentationRequest = {
        requirement: `围绕“${node.name}”生成一份面向学习者的完整交互课件，内容准确、结构清晰，并适合课堂讲解与自主学习。`,
        title: node.name,
        audience: 'students', purpose: 'courseware', style: 'education', backgroundStyle: 'blue-white-minimal',
        language: 'zh-CN', slideCount: 0, aspectRatio: '16:9', detailLevel: 'detailed',
        includeSpeakerNotes: true, modelProvider: 'mimo', generationMode: 'template', generationContext: generationContext(),
      };
      const task = await presentationApi.createPresentation(request);
      return { taskKind: 'ppt' as const, id: task.id };
    }
    const request: LearningResourceGenerateInput = {
      topic: node.name,
      title: `${node.name} · ${typeText[target]}`,
      kpId: node.nodeCode,
      detailLevel: 'detailed',
      questionCount: target === 'quiz' ? 15 : undefined,
      generationContext: generationContext(),
    };
    const task = await api.startLearningResourceTask(target, request);
    return { taskKind: 'resource' as const, id: task.id };
  };

  const startSelected = async () => {
    const targets = [...selectedKinds].filter((kind) => kind !== 'ppt' || pptReady);
    if (!targets.length) return;
    setGenerationBusy(true);
    try {
      const results = await Promise.allSettled(targets.map(startGeneration));
      const successful = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      const failedCount = results.length - successful.length;
      if (failedCount) toast.error(`${failedCount} 项生成任务未能启动`);
      if (!successful.length) return;
      toast.success(`已启动 ${successful.length} 项生成任务`);
      setGenerationModalOpen(false);
      await loadGenerationTasks();
      const first = successful[0];
      navigate(`/admin/workbench?task=${first.taskKind}-${first.id}`);
    } finally {
      setGenerationBusy(false);
    }
  };





  /** 资源 → 生成任务追溯：资源任务按 resourceId 精确匹配，课件按标题匹配 */
  const taskLogForResource = (item: AdminResourceItem): GenerationTask | null => {
    const byId = generationTasks.find((t) => t.taskKind === 'resource' && t.resourceId === item.id);
    if (byId) return byId;
    return generationTasks.find((t) => t.taskKind === 'ppt' && t.title === item.title) ?? null;
  };

  const openResourceLog = (item: AdminResourceItem) => {
    const task = taskLogForResource(item);
    if (!task) {
      toast.info('该资源没有管理员生成日志（可能为历史资源或非预生成来源）');
      return;
    }
    setProcessTask(task);
  };

  const openDomain = (next: RagDomain | { code: '__unassigned__'; name: string; description: string }) => {
    setDomain(next);
    setNode(null);
    setKind('lecture');
    setKeyword('');
    setDetail(null);
    if (next.code === '__unassigned__') setView('archive');
  };

  /** 写操作后失效：清空资源相关缓存并强制刷新当前列表与统计 */
  const invalidateResources = async () => {
    clearCacheStartsWith('admin:res');
    await Promise.all([listQ.refresh(true), pptQ.refresh(true), statsQ.refresh(true)]);
  };

  const act = async (item: AdminResourceItem, action: string) => {
    try {
      if (action === 'restore') await api.restoreAdminResource(item.id);
      else if (action === 'archive') await api.archiveAdminResource(item.id);
      else if (action === 'template') await api.setAdminResourceTemplate(item.id);
      else if (action === 'delete') {
        if (!window.confirm(`确定彻底删除“${item.title}”吗？\n\n此操作不可恢复，相关内容${item.type === 'ppt' ? '和课件文件' : ''}将被永久删除。`)) return;
        await api.deleteAdminResourcePermanently(item.id);
      }
      else await api.reviewAdminResource(item.id, action as 'submit' | 'approve' | 'reject' | 'publish' | 'deprecate');
      toast.success(action === 'template' ? '已设为母版' : action === 'delete' ? '资源已彻底删除' : action === 'restore' ? '已恢复到机构资源库草稿' : '资源状态已更新');
      await invalidateResources();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    }
  };

  const preview = async (item: AdminResourceItem) => {
    setPreviewLoading(true);
    setDetail(null);
    try {
      setDetail(await api.getAdminResource(item.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '资源预览失败');
    } finally {
      setPreviewLoading(false);
    }
  };

  const closePreview = () => setDetail(null);

  if (!domain)
    return (
      <div className="lf-anim-in-up">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-ink">资源中心</h2>
            <p className="mt-1.5 text-sm text-ink-muted">先选择领域，再沿知识目录管理四类学习资源。</p>
          </div>
          <div className="flex items-center gap-2">
            {statsQ.refreshing && <span className="text-[11px] text-ink-muted">统计更新中…</span>}
            <button onClick={() => navigate('/admin/workbench')} className="lf-row-btn">
              <Sparkles size={13} />
              AI 教研工作台
            </button>
            <div className="lf-seg">
              <button onClick={() => setView('archive')} className={cn('lf-seg-item', view === 'archive' && 'lf-seg-item-active')}>
                <Trash2 size={13} />
                归档
                <span className={cn('rounded-full px-1.5 text-[10px]', view === 'archive' ? 'bg-white/60' : 'bg-white/70')}>{statsQ.data?.recycle ?? 0}</span>
              </button>
            </div>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(domainsQ.data ?? []).map((item) => (
            <button key={item.code} onClick={() => openDomain(item)} className="lf-card lf-card-hover rounded-2xl p-6 text-left">
              <span className="flex items-start justify-between">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-tint text-brand">
                  <FolderTree size={20} />
                </span>
                <ChevronRight size={16} className="mt-1 text-ink-muted/60" />
              </span>
              <h3 className="mt-4 text-base font-bold text-ink">{item.name}</h3>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-ink-muted">{item.description || '暂无领域说明'}</p>
              <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl bg-white/50 p-2.5 text-center text-[11px] text-ink-muted">
                <span>
                  <b className="block text-base font-bold tabular-nums text-ink">{item.categoryCount}</b>
                  目录
                </span>
                <span>
                  <b className="block text-base font-bold tabular-nums text-ink">{item.knowledgePointCount}</b>
                  知识点
                </span>
                <span>
                  <b className="block text-base font-bold tabular-nums text-ink">{item.chunkCount}</b>
                  切片
                </span>
              </div>
            </button>
          ))}
          <button
            onClick={() => void openDomain({ code: '__unassigned__', name: '未识别归属', description: '旧资源中无法可靠映射到领域目录的内容' })}
            className="lf-card lf-card-hover rounded-2xl border-dashed border-ochre/40 bg-ochre-tint/40 p-6 text-left"
          >
            <span className="flex items-start justify-between">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/70 text-ochre">
                <FolderTree size={20} />
              </span>
              <span className="lf-pill lf-pill-warn">{statsQ.data?.recycle ?? 0} 项</span>
            </span>
            <h3 className="mt-4 text-base font-bold text-ink">未识别归属</h3>
            <p className="mt-1 text-xs leading-5 text-ink-muted">安全收纳尚未建立稳定领域和知识点映射的历史资源。</p>
          </button>
        </div>
        {domainsQ.loading && !domainsQ.data && (
          <div className="flex justify-center py-10 text-sm text-ink-muted">
            <Loader2 className="mr-2 animate-spin" size={16} />
            正在读取领域…
          </div>
        )}
        <TaskDrawer open={taskDrawerOpen} tasks={generationTasks} busy={generationBusy} focusTaskId={focusTask} onClose={() => { setTaskDrawerOpen(false); setFocusTask(null); }} onCancel={() => undefined} onRetry={() => undefined} onInspect={setProcessTask} />
        <GenerationProcessModal task={processTask} onClose={() => setProcessTask(null)} />
      </div>
    );

  const tree = treeQ.data;

  return (
    <div className="lf-anim-in-up flex flex-col lg:h-full lg:min-h-0 lg:overflow-hidden">
      <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div>
          <nav className="flex items-center gap-1.5 text-xs text-ink-muted">
            <button onClick={() => { setDomain(null); setNode(null); setDetail(null); }} className="lf-row-btn !px-2.5 !py-1 text-brand">
              资源中心
            </button>
            <span>/</span>
            <span className="font-semibold text-ink">{domain.name}</span>
            {node && (<><span>/</span><span className="font-semibold text-ink">{node.name}</span></>)}
            <span className="font-bold text-ink-muted">· 资源管理</span>
          </nav>
        </div>
        <div className="flex gap-2">
          <button onClick={() => navigate('/admin/workbench')} className="lf-row-btn">
            <Sparkles size={13} />
            AI 教研工作台
          </button>
          <button
            disabled={!node || domain.code === '__unassigned__'}
            onClick={() => { setSelectedKinds(new Set([kind === 'ppt' && !pptReady ? 'lecture' : kind])); setGenerationModalOpen(true); }}
            className="lf-row-btn lf-row-btn-primary disabled:cursor-not-allowed disabled:opacity-50"
            title={!node ? '请先从左侧选择具体知识点' : undefined}
          >
            <Plus size={13} />
            生成资源
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[280px_1fr] lg:grid-rows-[minmax(0,1fr)]">
        <aside className="lf-card flex flex-col overflow-hidden rounded-2xl">
          <div className="border-b border-white/60 px-4 py-3.5">
            <p className="text-sm font-bold text-ink">{domain.name}</p>
            <p className="mt-0.5 text-[11px] text-ink-muted">知识目录</p>
          </div>
          <button
            onClick={() => { setNode(null); setDetail(null); }}
            className={cn('w-full border-b border-white/50 px-4 py-3 text-left text-xs font-semibold transition-colors', !node ? 'lf-tree-active' : 'text-ink-2 hover:bg-brand-tint/60')}
          >
            领域全部资源
          </button>
          {domain.code === '__unassigned__' ? (
            <div className="lf-empty m-3 rounded-xl p-4 text-xs leading-5">这些资源缺少可靠目录映射。可预览后恢复，或在后续人工绑定到领域知识点。</div>
          ) : treeQ.loading && !treeQ.data ? (
            <div className="flex justify-center py-10">
              <Loader2 className="animate-spin" size={17} />
            </div>
          ) : (
            <div className="max-h-[640px] overflow-y-auto py-1.5 lg:max-h-none lg:min-h-0 lg:flex-1">
              {flatten(tree?.nodes ?? [], expanded).map(({ node: itemNode, depth }) => {
                const hasChildren = Boolean(itemNode.children?.length);
                const isActive = !hasChildren && node?.id === itemNode.id;
                return (
                  <div
                    key={itemNode.id}
                    className={cn('flex items-center rounded-lg pr-2 text-xs transition-colors', isActive ? 'lf-tree-active' : 'text-ink-2 hover:bg-brand-tint/40')}
                    style={{ paddingLeft: 6 + depth * 14 }}
                  >
                    {hasChildren ? (
                      /* 分类 / 章节节点：整行点击仅展开或收起，不可进入 */
                      <button
                        onClick={() =>
                          setExpanded((current) => {
                            const next = new Set(current);
                            if (next.has(itemNode.id)) next.delete(itemNode.id);
                            else next.add(itemNode.id);
                            return next;
                          })
                        }
                        title={expanded.has(itemNode.id) ? '收起' : '展开'}
                        className="flex min-w-0 flex-1 items-center gap-1 truncate py-2.5 text-left font-semibold"
                      >
                        {expanded.has(itemNode.id) ? (
                          <ChevronDown size={12} className="shrink-0 text-brand/70" />
                        ) : (
                          <ChevronRight size={12} className="shrink-0 text-ink-muted/70" />
                        )}
                        <span className="truncate">{itemNode.name}</span>
                      </button>
                    ) : (
                      /* 知识点（叶子）节点：点击进入该知识点 */
                      <button onClick={() => { setNode(itemNode); setSelectedGroupName('默认分组'); setDetail(null); }} className="min-w-0 flex-1 truncate py-2.5 text-left">
                        {itemNode.name}
                      </button>
                    )}
                    <span className="text-[10px] text-ink-muted/70">{itemNode.chunkCount || 0}</span>
                  </div>
                );
              })}
            </div>
          )}
        </aside>

        <section className="lg:min-h-0 lg:overflow-y-auto">
          {detail ? (
            /* ---- 资源预览子页面：占据右侧列表区域，非弹窗 ---- */
            <div className="lf-anim-in-up">
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <button onClick={closePreview} className="lf-row-btn">
                  <ArrowLeft size={13} />
                  返回资源列表
                </button>
                <nav className="flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
                  <span>{domain.name}</span>
                  {node && (
                    <>
                      <span>/</span>
                      <span>{node.name}</span>
                    </>
                  )}
                  <span>/</span>
                  <span className="truncate font-semibold text-ink">{detail.title}</span>
                </nav>
              </div>
              <div className="lf-card rounded-2xl p-6">
                <div className="flex flex-wrap items-center gap-2 border-b border-white/60 pb-4">
                  <h3 className="mr-auto text-lg font-bold text-ink">{detail.title}</h3>
                  {detail.type === 'ppt' && <a href={`/learn/ppt-preview/${detail.id}`} target="_blank" rel="noreferrer" className="lf-row-btn lf-row-btn-primary"><MonitorPlay size={12} />完整课件预览</a>}
                  <span className="lf-pill lf-pill-null">{typeText[detail.type] || detail.type}</span>
                  <span className="lf-pill lf-pill-null">v{detail.revision}</span>
                  {detail.archivedAt ? (
                    <span className="lf-pill lf-pill-warn">已归档</span>
                  ) : detail.reviewStatus ? (
                    <span
                      className={cn(
                        'lf-pill',
                        detail.reviewStatus === 'PUBLISHED'
                          ? 'lf-pill-ok'
                          : detail.reviewStatus === 'REJECTED' || detail.reviewStatus === 'DEPRECATED'
                            ? 'lf-pill-danger'
                            : detail.reviewStatus === 'PENDING'
                              ? 'lf-pill-warn'
                              : 'lf-pill-null',
                      )}
                    >
                      {detail.reviewStatus}
                    </span>
                  ) : (
                    <span className="lf-pill lf-pill-null">用户历史版本</span>
                  )}
                </div>
                <p className="mt-3 text-xs text-ink-muted">
                  {detail.topic ? ['主题：', detail.topic, ' · '].join('') : ''}
                  更新于 {new Date(detail.updatedAt).toLocaleString('zh-CN')}
                </p>
                <div className="mt-4">
                  <ResourcePreview detail={detail} />
                </div>
              </div>
            </div>
          ) : previewLoading ? (
            <div className="lf-card flex items-center justify-center rounded-2xl py-20 text-sm text-ink-muted">
              <Loader2 className="mr-2 animate-spin" size={18} />
              正在加载资源预览…
            </div>
          ) : (
            <>
              {!node ? (
                <div className="lf-card mb-4 flex items-center gap-3 rounded-2xl p-5">
                  <FolderTree size={18} className="text-ink-muted" />
                  <p className="text-sm font-semibold text-ink">请先选择左侧知识点，再查看和管理该知识点下的资源分组。</p>
                </div>
              ) : null}

              <div className="lf-card mb-4 flex flex-wrap items-center gap-3 rounded-2xl p-3">
                <div className="lf-seg">
                  {([['library', '资源库'], ['archive', '归档']] as [View, string][]).map(([id, label]) => (
                    <button key={id} onClick={() => { setView(id); setDetail(null); }} className={cn('lf-seg-item', view === id && 'lf-seg-item-active')}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="min-w-52 flex-1">
                  <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索当前目录资源" className="lf-input" />
                </div>
                {listQ.refreshing && (
                  <span className="flex items-center gap-1 text-[11px] text-ink-muted">
                    <Loader2 size={11} className="animate-spin" />
                    后台更新中
                  </span>
                )}
              </div>

              {node && (listQ.loading && !listQ.data ? (
                <div className="lf-card flex items-center justify-center rounded-2xl py-20 text-sm text-ink-muted">
                  <Loader2 className="mr-2 animate-spin" size={18} />
                  正在加载资源…
                </div>
              ) : groupedEntries.length === 0 ? (
                <div className="lf-card rounded-2xl py-12 text-center text-sm text-ink-muted">当前范围暂无资源</div>
              ) : (
                groupedEntries.map(([groupName, typeMap]) => {
                  const isTemplate = [...typeMap.values()].some((item) => item.template);
                  const firstItem = [...typeMap.values()][0];
                  const isExpanded = expandedGroups.has(groupName);
                  const matchKeyword = (item?: AdminResourceItem) => {
                    if (!keyword || !item) return !keyword;
                    const q = keyword.toLowerCase();
                    return item.title.toLowerCase().includes(q) || (item.topic ?? '').toLowerCase().includes(q);
                  };
                  const visibleKinds = kinds.filter(([type]) => { const item = typeMap.get(type); return matchKeyword(item) || (!item && !keyword); });
                  if (keyword && visibleKinds.length === 0) return null;
                  return (
                    <div key={groupName} className="lf-card mb-3 overflow-hidden rounded-2xl">
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-brand-tint/30"
                        onClick={() => setExpandedGroups((prev) => { const next = new Set(prev); if (next.has(groupName)) next.delete(groupName); else next.add(groupName); return next; })}
                      >
                        {isExpanded ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
                        <span className="text-sm font-bold text-ink">{groupName}</span>
                        {isTemplate && <span className="lf-pill lf-pill-ok">母版</span>}
                        <span className="ml-1 text-[10px] text-ink-muted">({typeMap.size}/4)</span>
                        <span className="ml-auto" />
                        {view === 'library' && (
                          <button
                            disabled={isTemplate || !firstItem}
                            onClick={(e) => { e.stopPropagation(); firstItem && void act(firstItem, 'template'); }}
                            className="lf-row-btn lf-row-btn-primary disabled:cursor-default disabled:opacity-70"
                          >
                            <LayoutTemplate size={11} />
                            {isTemplate ? '当前母版' : '设为母版'}
                          </button>
                        )}
                      </button>
                      {isExpanded && (
                        <div className="border-t border-white/60 px-4 py-1">
                          {kinds.map(([type, label, _desc, Icon]) => {
                            const item = typeMap.get(type);
                            if (keyword) {
                              const q = keyword.toLowerCase();
                              if (item && !item.title.toLowerCase().includes(q) && !(item.topic ?? '').toLowerCase().includes(q)) return null;
                              if (!item) return null;
                            }
                            return (
                              <div key={type} className="flex items-center gap-3 rounded-lg px-2 py-2.5 text-xs hover:bg-brand-tint/30">
                                <Icon size={14} className="shrink-0 text-ink-muted" />
                                <span className="w-16 shrink-0 font-semibold text-ink-2">{label}</span>
                                {item ? (
                                  <>
                                    <span className="min-w-0 flex-1 truncate font-semibold text-ink" title={item.title}>{item.title}</span>
                                    {item.archivedAt ? <span className="lf-pill lf-pill-warn">已归档</span> : null}
                                    <button onClick={() => preview(item)} className="lf-row-btn"><Eye size={11} />预览</button>
                                    {openResourceLog && <button onClick={() => openResourceLog(item)} className="lf-row-btn" title="生成日志"><FileText size={11} /></button>}
                                    {view === 'archive' ? (
                                      <>
                                        <button onClick={() => void act(item, 'restore')} className="lf-row-btn lf-row-btn-primary"><ArchiveRestore size={11} />恢复</button>
                                        <button onClick={() => void act(item, 'delete')} className="lf-row-btn text-red-600"><Trash2 size={11} /></button>
                                      </>
                                    ) : (
                                      <button onClick={() => void act(item, 'archive')} className="lf-row-btn text-ink-muted">归档</button>
                                    )}
                                  </>
                                ) : (
                                  <span className="text-ink-muted">未生成</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              ))}
            </>
          )}
        </section>
      </div>
      <PreGenerationModal
        open={generationModalOpen}
        domainName={domain.name}
        nodeName={node?.name ?? ''}
        groupName={selectedGroupName}
        selected={selectedKinds}
        busy={generationBusy}
        onClose={() => setGenerationModalOpen(false)}
        onToggle={(target) => setSelectedKinds((current) => {
          const next = new Set(current);
          if (next.has(target)) next.delete(target); else next.add(target);
          return next;
        })}
        pptDisabled={!pptReady}
        onSelectAll={() => setSelectedKinds(new Set(pptReady ? ['lecture', 'practice', 'quiz', 'ppt'] : ['lecture', 'practice', 'quiz']))}
        onSubmit={() => void startSelected()}
      />
      <TaskDrawer open={taskDrawerOpen} tasks={generationTasks} busy={generationBusy} focusTaskId={focusTask} onClose={() => { setTaskDrawerOpen(false); setFocusTask(null); }} onCancel={() => undefined} onRetry={() => undefined} onInspect={setProcessTask} />
      <GenerationProcessModal task={processTask} onClose={() => setProcessTask(null)} />
    </div>
  );
}

const activeGenerationStatuses = new Set(['queued', 'retrieving', 'planning', 'analyzing', 'generating', 'verifying', 'reviewing', 'revising', 'judging', 'outline_review']);

function PreGenerationModal({ open, domainName, nodeName, groupName, selected, busy, pptDisabled, onClose, onToggle, onSelectAll, onSubmit }: {

  open: boolean;
  domainName: string;
  nodeName: string;
  groupName: string;
  selected: Set<ResourceKind>;
  busy: boolean;
  pptDisabled: boolean;
  onClose: () => void;
  onToggle: (kind: ResourceKind) => void;
  onSelectAll: () => void;
  onSubmit: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/25 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="lf-card w-full max-w-2xl rounded-3xl p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-tint text-brand"><Plus size={20} /></div>
          <div className="min-w-0 flex-1"><h3 className="text-lg font-bold text-ink">生成机构通用资源</h3><p className="mt-1 text-xs text-ink-muted">生成结果进入机构资源库，不直接绑定学习者。</p></div>
          <button disabled={busy} onClick={onClose} className="lf-row-btn !p-2" aria-label="关闭"><X size={15} /></button>
        </div>
        <div className="mt-5 rounded-2xl bg-white/55 px-4 py-3"><p className="text-[11px] text-ink-muted">生成位置</p><p className="mt-1 text-sm font-semibold text-ink">{domainName}<span className="mx-1 text-ink-muted">/</span>{nodeName}<span className="mx-1 text-ink-muted">/</span>{groupName}</p></div>
        <div className="mt-5 flex items-center justify-between"><p className="text-sm font-bold text-ink">选择资源类型</p><button type="button" onClick={onSelectAll} className="text-xs font-semibold text-brand">选择全部</button></div>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          {kinds.map(([id, label, note, Icon]) => {
            const disabled = id === 'ppt' && pptDisabled;
            return <button type="button" key={id} disabled={disabled} onClick={() => !disabled && onToggle(id)} className={cn('rounded-2xl border p-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-45', selected.has(id) && !disabled ? 'border-brand/50 bg-brand-tint/70 ring-1 ring-brand/30' : 'border-white/80 bg-white/45 hover:bg-white/70')}><div className="flex items-center justify-between"><Icon size={17} className={selected.has(id) && !disabled ? 'text-brand' : 'text-ink-muted'} />{selected.has(id) && !disabled && <CheckCircle2 size={15} className="text-brand" />}</div><p className="mt-3 text-sm font-bold text-ink">{label}</p><p className="mt-1 text-[10px] text-ink-muted">{disabled ? '需先生成讲义、实操、题库' : note}</p></button>;
          })}
        </div>
        <div className="mt-6 flex justify-end gap-2 border-t border-white/70 pt-4"><button disabled={busy} onClick={onClose} className="lf-row-btn">取消</button><button disabled={busy || selected.size === 0} onClick={onSubmit} className="lf-row-btn lf-row-btn-primary min-w-28 justify-center disabled:opacity-50">{busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}开始生成{selected.size ? `（${selected.size}项）` : ''}</button></div>
      </div>
    </div>
  );
}



function taskContext(task: GenerationTask): Record<string, unknown> {
  if (task.taskKind === 'ppt') return task.request?.generationContext ?? {};
  const request = task.request as (LearningResourceGenerateInput & { generation_context?: Record<string, unknown> }) | undefined;
  return request?.generationContext ?? request?.generation_context ?? {};
}

function TaskDrawer({ open, tasks, busy, focusTaskId, onClose, onCancel, onRetry, onInspect }: {
  open: boolean;
  tasks: GenerationTask[];
  busy: boolean;
  focusTaskId: string | null;
  onClose: () => void;
  onCancel: (task: GenerationTask) => void;
  onRetry: (task: GenerationTask) => void;
  onInspect: (task: GenerationTask) => void;
}) {
  const [tab, setTab] = useState<'active' | 'finished'>('active');
  const taskKey = (task: GenerationTask) => `${task.taskKind}-${task.id}`;
  const activeTasks = tasks.filter((task) => activeGenerationStatuses.has(task.status));
  const finishedTasks = tasks.filter((task) => !activeGenerationStatuses.has(task.status));
  // 打开抽屉时初始化默认板块（有进行中则看进行中，否则看已完成）；手动切换不受后续任务状态变化影响
  useEffect(() => {
    if (open) setTab(activeTasks.length ? 'active' : 'finished');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const eventsOf = (task: GenerationTask) => task.taskKind === 'ppt' ? [] : (task as LearningResourceGenerationTask).events;

  // 抽屉打开且带定位任务：自动切到对应板块并滚动到该任务
  useEffect(() => {
    if (!open || !focusTaskId) return;
    const focused = tasks.find((t) => taskKey(t) === focusTaskId);
    if (focused) setTab(activeGenerationStatuses.has(focused.status) ? 'active' : 'finished');
    const timer = window.setTimeout(() => {
      document.getElementById(`gen-task-${focusTaskId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [open, focusTaskId, tasks, taskKey]);

  if (!open) return null;
  const renderTask = (task: GenerationTask) => {
    const key = taskKey(task);
    const active = activeGenerationStatuses.has(task.status);
    const completed = task.status === 'completed';
    const failed = task.status === 'failed' || task.status === 'cancelled';
    const label = task.taskKind === 'ppt' ? '交互课件' : typeText[task.resourceType];
    const context = taskContext(task);
    const events = eventsOf(task);
    return (
      <div key={key} id={`gen-task-${key}`} className="rounded-2xl border border-white/80 bg-white/55 px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          {active ? <Loader2 size={14} className="animate-spin text-brand" /> : completed ? <CheckCircle2 size={14} className="text-emerald-600" /> : <XCircle size={14} className="text-red-500" />}
          <span className="lf-pill lf-pill-null">{label}</span>
          <span className="ml-auto text-[11px] tabular-nums text-ink-muted">{task.progress}%</span>
        </div>
        <p className="mt-3 truncate text-sm font-bold text-ink">{String(context.topicName || task.title)}</p>
        <p className="mt-1 truncate text-[11px] text-ink-muted">{String(context.domainCode || '机构资源')} · {String(context.nodeCode || '')}</p>
        <div className="mt-3 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-ink-2">{task.stageMessage}</span>
          {active && (
            <button onClick={() => onCancel(task)} className="lf-row-btn text-red-600"><Ban size={11} />取消</button>
          )}
          {failed && (
            <button disabled={busy} onClick={() => onRetry(task)} className="lf-row-btn"><RefreshCw size={11} />重新生成</button>
          )}
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/80">
          <div className={cn('h-full rounded-full transition-all', failed ? 'bg-red-400' : completed ? 'bg-emerald-500' : 'bg-brand')} style={{ width: `${Math.max(3, task.progress)}%` }} />
        </div>
        {task.errorMessage && <p className="mt-2 line-clamp-2 text-[11px] text-red-600">{task.errorMessage}</p>}

        {/* 生成日志：进行中实时展示（默认展开），结束后可展开回看 */}
        <div className="mt-3 rounded-xl border border-white/70 bg-white/40">
          <button
            type="button"
            onClick={() => onInspect(task)}
            className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
          >
            <Radio size={13} className={cn('shrink-0', active ? 'text-brand' : 'text-ink-muted')} />
            <span className="text-[11.5px] font-bold text-ink">查看实时协同过程</span>
            <span className="lf-pill lf-pill-null !px-1.5 text-[9px]">{events.length ? `${events.length} 条记录` : '只读快照'}</span>
            <ChevronRight size={13} className="ml-auto text-ink-muted" />
          </button>
        </div>
      </div>
    );
  };
  return (
    <div className="fixed inset-0 z-[75] bg-ink/20 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="ml-auto flex h-full w-full max-w-md flex-col border-l border-white/70 bg-[#f7f5ee]/95 shadow-2xl backdrop-blur-2xl">
        <div className="flex items-start gap-3 border-b border-white/70 px-5 py-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-brand-tint text-brand"><ListChecks size={18} /></div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-ink">资源生成任务</h3>
            <p className="mt-1 text-[11px] text-ink-muted">{activeTasks.length ? `${activeTasks.length} 项正在进行` : '当前没有进行中的任务'}</p>
          </div>
          <button onClick={onClose} className="lf-row-btn !p-2" aria-label="关闭"><X size={15} /></button>
        </div>
        {/* 板块切换：进行中 / 已完成 */}
        <div className="flex gap-1.5 border-b border-white/70 px-4 py-2.5">
          <button
            type="button"
            onClick={() => setTab('active')}
            className={cn('flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-bold transition-colors', tab === 'active' ? 'bg-brand text-paper shadow-sm' : 'text-ink-2 hover:bg-white/70')}
          >
            进行中
            <span className={cn('rounded-full px-1.5 text-[10px] tabular-nums', tab === 'active' ? 'bg-white/25 text-paper' : 'bg-brand-tint text-brand')}>{activeTasks.length}</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('finished')}
            className={cn('flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-bold transition-colors', tab === 'finished' ? 'bg-ink text-paper shadow-sm' : 'text-ink-2 hover:bg-white/70')}
          >
            已完成 / 已结束
            <span className={cn('rounded-full px-1.5 text-[10px] tabular-nums', tab === 'finished' ? 'bg-white/25 text-paper' : 'bg-ink-tint text-ink')}>{finishedTasks.length}</span>
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {tab === 'active' ? (
            activeTasks.length ? activeTasks.map(renderTask) : !tasks.length ? <div className="lf-empty rounded-2xl p-8 text-xs">还没有管理员预生成任务。请先进入某个知识点发起生成。</div> : <div className="lf-empty rounded-2xl p-8 text-xs">当前没有进行中的任务，可切换到「已完成」查看历史。</div>
          ) : (
            finishedTasks.length ? finishedTasks.map(renderTask) : <div className="lf-empty rounded-2xl p-8 text-xs">还没有已结束的生成任务</div>
          )}
        </div>
      </aside>
    </div>
  );
}



function GenerationProcessModal({ task, onClose }: { task: GenerationTask | null; onClose: () => void }) {
  const [events, setEvents] = useState<AdminGenerationEvent[]>([]);
  const [streamError, setStreamError] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [selectedEventSeq, setSelectedEventSeq] = useState<number | null>(null);
  useEffect(() => {
    if (!task) return;
    setEvents([]); setStreamError(''); setSelectedAgent(''); setSelectedEventSeq(null);
    const controller = new AbortController();
    void streamAdminGenerationTask(task.taskKind, task.id, (event) => {
      setEvents((current) => current.some((item) => item.seq === event.seq) ? current : [...current, event].sort((a, b) => a.seq - b.seq));
    }, controller.signal).catch((error) => {
      if (!controller.signal.aborted) setStreamError(error instanceof Error ? error.message : '协同过程连接中断');
    });
    return () => controller.abort();
  }, [task]);
  if (!task) return null;
  const latest = events.at(-1);
  const active = activeGenerationStatuses.has(task.status) && (!latest || activeGenerationStatuses.has(latest.status));
  const effectiveAgent = selectedAgent || latest?.agent || generationAgents[0].id;
  const selectedEvent = events.find((event) => event.seq === selectedEventSeq) ?? events.filter((event) => event.agent === effectiveAgent).at(-1);
  const selectGenerationEvent = (event: AdminGenerationEvent, _lifecycle?: boolean) => {
    setSelectedEventSeq(event.seq);
    if (!isLifecycleEvent(event)) setSelectedAgent(event.agent);
  };
  const selectAgent = (id: string) => {
    setSelectedAgent(id);
    setSelectedEventSeq(events.filter((event) => event.agent === id).at(-1)?.seq ?? null);
  };
  const context = taskContext(task);
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-ink/35 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="flex h-[min(85vh,900px)] w-full max-w-[1200px] flex-col overflow-hidden rounded-3xl border border-white/80 bg-[#f7f5ee] shadow-2xl">
        <header className="flex shrink-0 items-start gap-3 border-b border-white/75 bg-white/35 px-6 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-brand text-paper"><Sparkles size={18} /></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-bold text-ink">AI 教研组 · 协同过程</h3>
              <span className="lf-pill lf-pill-null">只读</span>
              {active && <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-brand"><span className="h-2 w-2 animate-pulse rounded-full bg-brand" />进行中</span>}
            </div>
            <p className="mt-0.5 truncate text-xs text-ink-muted">{String(context.topicName || task.title)} · {task.taskKind === 'ppt' ? '交互课件' : typeText[task.resourceType]}</p>
          </div>
          <button onClick={onClose} className="lf-row-btn !p-2" aria-label="关闭"><X size={16} /></button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <AgentWorkflowSummary events={events} running={active} />

          <div className="flex min-h-0 flex-1 gap-3">
            {/* 泳道 */}
            <div className="flex min-w-0 flex-1 flex-col rounded-2xl border border-white/70 bg-[#f7f5ee]/75">
              <div className="flex shrink-0 items-center gap-2 border-b border-white/70 px-3 py-2">
                <h3 className="text-sm font-bold text-ink">协作泳道</h3>
                <span className="text-[10px] text-ink-muted">列头即成员 · 时间自上而下</span>
              </div>
              <div className="min-h-0 flex-1 p-3">
                {events.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-xs text-ink-muted">{streamError || '等待第一条协同事件…'}</div>
                ) : (
                  <CollaborationRounds events={events} selectedSeq={selectedEvent?.seq ?? null} selectedAgent={effectiveAgent} runningAgent={active && latest ? latest.agent : null} running={active} onSelect={(event) => void selectGenerationEvent(event, isLifecycleEvent(event))} onSelectAgent={selectAgent} />
                )}
              </div>
            </div>

            {/* 执行详情 */}
            <aside className="flex w-full shrink-0 flex-col rounded-2xl border border-white/70 bg-white/45 lg:w-[340px]">
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/70 px-4 py-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-ink">执行详情</h3>
                  <p className="mt-0.5 text-[10px] text-ink-muted">操作、结论、依据与下一步</p>
                </div>
                {selectedEvent && <span className="lf-pill lf-pill-null shrink-0">{selectedEvent.agentName || (generationAgents.find((item) => item.id === selectedEvent.agent)?.name ?? selectedEvent.agent)}</span>}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {selectedEvent ? (
                  <ExecutionDetailPanel key={selectedEvent.seq} event={selectedEvent} title={eventDisplayTitle(selectedEvent)} running={active && selectedEvent.seq === latest?.seq} summaryLoading={false} />
                ) : (
                  <div className="mt-6 rounded-xl border border-dashed border-white/80 bg-white/30 px-4 py-10 text-center text-xs leading-6 text-ink-muted">
                    尚未选择事件
                    <br />点击泳道中的工作单元查看执行细节
                  </div>
                )}
              </div>
            </aside>
          </div>

          {streamError && <p className="shrink-0 rounded-xl bg-red-50 px-3 py-2 text-[11px] text-red-600">{streamError}</p>}
        </div>
      </div>
    </div>
  );
}
