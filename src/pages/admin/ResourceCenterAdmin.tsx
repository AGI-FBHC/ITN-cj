import { useEffect, useState } from 'react';
import {
  ArchiveRestore, ArrowLeft, Ban, BookOpen, CheckCircle2, ChevronDown, ChevronRight, ClipboardList,
  Eye, FileText, FolderTree, LayoutTemplate, Loader2, MonitorPlay, Plus, RefreshCw, Trash2, Wrench, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, type AdminResourceDetail, type AdminResourceItem, type AdminResourceStats, type LearningResourceGenerateInput, type LearningResourceGenerationTask, type RagDomain, type RagTree, type RagTreeNode } from '@/lib/api';
import { presentationApi, type PresentationRequest, type PresentationTaskSummary } from '@/lib/presentationApi';
import { useCachedData } from '@/hooks/useCachedData';
import { clearCacheStartsWith } from '@/lib/swrCache';
import ResourcePreview from '@/components/admin/ResourcePreview';
import { cn } from '@/lib/utils';

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

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="lf-empty px-6 py-14 text-center text-sm">{children}</div>;
}

export default function ResourceCenterAdmin() {
  const [domain, setDomain] = useState<RagDomain | { code: '__unassigned__'; name: string; description: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [node, setNode] = useState<RagTreeNode | null>(null);
  const [kind, setKind] = useState<ResourceKind>('lecture');
  const [view, setView] = useState<View>('library');
  const [keyword, setKeyword] = useState('');
  const [detail, setDetail] = useState<AdminResourceDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [generationOpen, setGenerationOpen] = useState(false);
  const [generationTasks, setGenerationTasks] = useState<GenerationTask[]>([]);
  const [generationBusy, setGenerationBusy] = useState(false);

  /* ---- SWR 缓存：先展示缓存，后台异步更新 ---- */
  const domainsQ = useCachedData<RagDomain[]>('admin:rag-domains', () => api.listRagDomains(), { ttlMs: 30_000 });
  const statsQ = useCachedData<AdminResourceStats>('admin:res:stats', () => api.getAdminResourceStats(), { ttlMs: 10_000 });
  const treeQ = useCachedData<RagTree>(
    domain && domain.code !== '__unassigned__' ? `admin:rag-tree:${domain.code}` : null,
    () => api.getRagTree((domain as RagDomain).code),
    { ttlMs: 60_000 },
  );
  const resourceType = kind;
  const listQ = useCachedData<{ items: AdminResourceItem[]; total: number }>(
    domain ? `admin:res:${view}:${resourceType}:${domain.code}:${node?.nodeCode ?? ''}:${keyword}` : null,
    () => api.listAdminResources({ view, type: resourceType, keyword, domainCode: (domain as { code: string }).code, nodeCode: node?.nodeCode }),
    { ttlMs: 15_000 },
  );

  useEffect(() => {
    if (!treeQ.data) return;
    const timer = window.setTimeout(() => setExpanded(new Set(treeQ.data?.nodes.map((n) => n.id) ?? [])), 0);
    return () => window.clearTimeout(timer);
  }, [treeQ.data]);
  useEffect(() => {
    const message = domainsQ.error?.message ?? statsQ.error?.message ?? treeQ.error?.message ?? listQ.error?.message;
    if (message) toast.error(message);
  }, [domainsQ.error, statsQ.error, treeQ.error, listQ.error]);

  const loadGenerationTasks = async () => {
    if (!domain || domain.code === '__unassigned__' || !node) {
      setGenerationTasks([]);
      return;
    }
    const [resources, presentations] = await Promise.all([
      api.listLearningResourceTasks(100),
      presentationApi.listPresentationSummaries(100, true),
    ]);
    const belongsHere = (context: Record<string, unknown> | undefined) =>
      context?.adminGeneration === true && context.domainCode === domain.code && context.nodeCode === node.nodeCode;
    const textTasks: GenerationTask[] = resources.tasks
      .filter((task) => belongsHere(task.request?.generationContext))
      .map((task) => ({ ...task, taskKind: 'resource' as const }));
    const pptTasks: GenerationTask[] = presentations.tasks
      .filter((task) => belongsHere(task.request?.generationContext))
      .map((task) => ({ ...task, taskKind: 'ppt' as const }));
    setGenerationTasks([...textTasks, ...pptTasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
  };

  useEffect(() => {
    if (!node || domain?.code === '__unassigned__') return;
    const initial = window.setTimeout(
      () => void loadGenerationTasks().catch((error) => toast.error(error instanceof Error ? error.message : '生成任务读取失败')),
      0,
    );
    const timer = window.setInterval(() => void loadGenerationTasks().catch(() => undefined), 2500);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain?.code, node?.nodeCode]);

  const generationContext = () => ({
    adminGeneration: true,
    domainCode: domain?.code,
    nodeCode: node?.nodeCode,
    topicName: node?.name,
    kpId: node?.nodeCode,
  });

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
      await presentationApi.createPresentation(request);
    } else {
      const request: LearningResourceGenerateInput = {
        topic: node.name,
        title: `${node.name} · ${typeText[target]}`,
        kpId: node.nodeCode,
        detailLevel: 'detailed',
        questionCount: target === 'quiz' ? 12 : undefined,
        generationContext: generationContext(),
      };
      await api.startLearningResourceTask(target, request);
    }
  };

  const startSelected = async (targets: ResourceKind[]) => {
    setGenerationBusy(true);
    try {
      const results = await Promise.allSettled(targets.map(startGeneration));
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length) toast.error(`${failed.length} 项生成任务未能启动`);
      if (failed.length < results.length) toast.success(`已启动 ${results.length - failed.length} 项生成任务`);
      setGenerationOpen(true);
      await loadGenerationTasks();
    } finally {
      setGenerationBusy(false);
    }
  };

  const cancelGeneration = async (task: GenerationTask) => {
    try {
      if (task.taskKind === 'ppt') await presentationApi.cancelPresentation(task.id);
      else await api.cancelLearningResourceTask(task.id);
      toast.success('已取消生成任务');
      await loadGenerationTasks();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '取消失败');
    }
  };

  const retryGeneration = async (task: GenerationTask) => {
    setGenerationBusy(true);
    try {
      if (task.taskKind === 'ppt' && task.request) await presentationApi.createPresentation(task.request);
      else if (task.taskKind === 'resource' && task.request) await api.startLearningResourceTask(task.resourceType, task.request);
      else throw new Error('该任务缺少原始生成参数');
      toast.success('已重新发起生成');
      await loadGenerationTasks();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重试失败');
    } finally {
      setGenerationBusy(false);
    }
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
    await Promise.all([listQ.refresh(true), statsQ.refresh(true)]);
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
          </nav>
          <h2 className="mt-2 text-xl font-bold tracking-tight text-ink">{node?.name || domain.name} · 资源管理</h2>
        </div>
        <div className="flex gap-2">
          <button
            disabled={!node || domain.code === '__unassigned__'}
            onClick={() => setGenerationOpen((current) => !current)}
            className="lf-row-btn lf-row-btn-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={13} />
            预生成资源
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
                      <button onClick={() => { setNode(itemNode); setDetail(null); }} className="min-w-0 flex-1 truncate py-2.5 text-left">
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
              {generationOpen && node && domain.code !== '__unassigned__' && (
                <GenerationManager
                  tasks={generationTasks}
                  busy={generationBusy}
                  currentKind={kind}
                  onStartCurrent={() => void startSelected([kind])}
                  onStartAll={() => void startSelected(['lecture', 'practice', 'quiz', 'ppt'])}
                  onCancel={(task) => void cancelGeneration(task)}
                  onRetry={(task) => void retryGeneration(task)}
                />
              )}
              <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                {kinds.map(([id, label, note, Icon]) => (
                  <button
                    key={id}
                    onClick={() => { setKind(id); setDetail(null); }}
                    className={cn('lf-card rounded-2xl p-3.5 text-left transition-all', kind === id ? 'ring-2 ring-brand/50 border-brand/40 bg-brand-tint/40' : 'hover:-translate-y-0.5')}
                  >
                    <Icon size={17} className={kind === id ? 'text-brand' : 'text-ink-muted'} />
                    <p className="mt-2 text-sm font-bold text-ink">{label}</p>
                    <p className="mt-0.5 text-[11px] text-ink-muted">{note}</p>
                  </button>
                ))}
              </div>

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
              <ResourceTable items={listQ.data?.items ?? []} loading={listQ.loading} view={view} onPreview={preview} onAction={act} />
            </>
          )}
        </section>
      </div>


    </div>
  );
}

const activeGenerationStatuses = new Set(['queued', 'retrieving', 'planning', 'analyzing', 'generating', 'verifying', 'reviewing', 'revising', 'judging', 'outline_review']);

function GenerationManager({ tasks, busy, currentKind, onStartCurrent, onStartAll, onCancel, onRetry }: {
  tasks: GenerationTask[];
  busy: boolean;
  currentKind: ResourceKind;
  onStartCurrent: () => void;
  onStartAll: () => void;
  onCancel: (task: GenerationTask) => void;
  onRetry: (task: GenerationTask) => void;
}) {
  return (
    <div className="lf-card mb-4 rounded-2xl p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h3 className="text-sm font-bold text-ink">通用资源预生成</h3>
          <p className="mt-1 text-[11px] text-ink-muted">生成结果直接进入当前知识点的机构资源库，不绑定学习者。</p>
        </div>
        <button disabled={busy} onClick={onStartCurrent} className="lf-row-btn disabled:opacity-50">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          生成当前类型（{typeText[currentKind]}）
        </button>
        <button disabled={busy} onClick={onStartAll} className="lf-row-btn lf-row-btn-primary disabled:opacity-50">
          <Plus size={12} />
          一键生成四类
        </button>
      </div>
      <div className="mt-4 space-y-2">
        {tasks.slice(0, 12).map((task) => {
          const active = activeGenerationStatuses.has(task.status);
          const completed = task.status === 'completed';
          const failed = task.status === 'failed' || task.status === 'cancelled';
          const label = task.taskKind === 'ppt' ? '交互课件' : typeText[task.resourceType];
          return (
            <div key={`${task.taskKind}-${task.id}`} className="rounded-xl border border-white/70 bg-white/45 px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                {active ? <Loader2 size={14} className="animate-spin text-brand" /> : completed ? <CheckCircle2 size={14} className="text-emerald-600" /> : <XCircle size={14} className="text-red-500" />}
                <span className="lf-pill lf-pill-null">{label}</span>
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{task.stageMessage}</span>
                <span className="text-[11px] tabular-nums text-ink-muted">{task.progress}%</span>
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
            </div>
          );
        })}
        {!tasks.length && <div className="lf-empty rounded-xl p-5 text-xs">当前知识点还没有生成任务</div>}
      </div>
    </div>
  );
}

function ResourceTable({ items, loading, view, onPreview, onAction }: { items: AdminResourceItem[]; loading: boolean; view: View; onPreview: (i: AdminResourceItem) => void; onAction: (i: AdminResourceItem, a: string) => Promise<void> }) {
  return (
    <div className="lf-table-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr>
              <th className="px-4 py-3.5">资源</th>
              <th className="px-4 py-3.5">状态</th>
              <th className="px-4 py-3.5">更新时间</th>
              <th className="px-4 py-3.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td className="max-w-lg px-4 py-3.5">
                  <p className="line-clamp-1 font-semibold text-ink">{item.title}</p>
                  <p className="mt-1 line-clamp-1 text-[11px] text-ink-muted">{item.topic}</p>
                </td>
                <td className="px-4 py-3.5">
                  {item.archivedAt ? (
                    <span className="lf-pill lf-pill-warn">已归档</span>
                  ) : item.reviewStatus ? (
                    <span className={cn('lf-pill', item.reviewStatus === 'PUBLISHED' ? 'lf-pill-ok' : item.reviewStatus === 'REJECTED' || item.reviewStatus === 'DEPRECATED' ? 'lf-pill-danger' : item.reviewStatus === 'PENDING' ? 'lf-pill-warn' : 'lf-pill-null')}>
                      {item.reviewStatus}
                    </span>
                  ) : (
                    <span className="lf-pill lf-pill-null">用户历史版本</span>
                  )}
                  <p className="mt-1 text-[11px] text-ink-muted">v{item.revision}</p>
                </td>
                <td className="px-4 py-3.5 text-xs text-ink-muted">{new Date(item.archivedAt || item.updatedAt).toLocaleString('zh-CN')}</td>
                <td className="px-4 py-3.5 text-right">
                  <div className="flex justify-end gap-1.5">
                    <button onClick={() => onPreview(item)} className="lf-row-btn">
                      <Eye size={11} />
                      预览
                    </button>
                    {view === 'archive' ? (
                      <>
                        <button onClick={() => void onAction(item, 'restore')} className="lf-row-btn lf-row-btn-primary">
                          <ArchiveRestore size={11} />
                          恢复
                        </button>
                        <button onClick={() => void onAction(item, 'delete')} className="lf-row-btn text-red-600">
                          <Trash2 size={11} />
                          彻底删除
                        </button>
                      </>
                    ) : (
                      <>
                        <button disabled={item.template} onClick={() => void onAction(item, 'template')} className="lf-row-btn lf-row-btn-primary disabled:cursor-default disabled:opacity-70">
                          <LayoutTemplate size={11} />
                          {item.template ? '当前母版' : '设为母版'}
                        </button>
                        <button onClick={() => void onAction(item, 'archive')} className="lf-row-btn text-ink-muted">归档</button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && (
        <div className="flex justify-center py-12 text-sm text-ink-muted">
          <Loader2 className="mr-2 animate-spin" size={16} />
          加载中…
        </div>
      )}
      {!loading && !items.length && <EmptyState>当前范围暂无资源</EmptyState>}
    </div>
  );
}
