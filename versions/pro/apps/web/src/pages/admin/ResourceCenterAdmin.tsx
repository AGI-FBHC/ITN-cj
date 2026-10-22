import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, Ban, BookOpen, CheckCircle2, ChevronDown, ChevronRight, ClipboardList,
  Eye, FileText, FolderTree, ImagePlus, LayoutTemplate, ListChecks, Loader2, MonitorPlay, Pencil, Plus, Radio, RefreshCw, Search, Sparkles, Trash2, Upload, Wrench, X, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { api, streamAdminGenerationTask, type AdminGenerationEvent, type AdminResourceDetail, type AdminResourceItem, type AdminResourceStats, type CatalogChapterSuggestion, type CatalogRoot, type LearningResourceGenerateInput, type LearningResourceGenerationTask, type RagDomain, type RagTree, type RagTreeNode } from '@/lib/api';
import { presentationApi, type PresentationRequest, type PresentationTaskSummary } from '@/lib/presentationApi';
import { useCachedData } from '@/hooks/useCachedData';
import { clearCacheStartsWith } from '@/lib/swrCache';
import ResourcePreview from '@/components/admin/ResourcePreview';
import ExecutionDetailPanel from '@/components/admin/ExecutionDetailPanel';
import { cn } from '@/lib/utils';
import { agents as generationAgents, CollaborationRounds, AgentWorkflowSummary, eventDisplayTitle, isLifecycleEvent, PptModalPreview } from '@/pages/CollaborationWorkbench';

type ResourceKind = 'lecture' | 'practice' | 'quiz' | 'ppt';
type GenerationTask =
  | ({ taskKind: 'resource' } & LearningResourceGenerationTask)
  | ({ taskKind: 'ppt' } & PresentationTaskSummary);
/* 新建资源：解析后可编辑的目录草案（enabled 控制是否写入） */
type ImportPointDraft = { name: string; description: string; enabled: boolean };
type ImportChapterDraft = { name: string; description: string; enabled: boolean; points: ImportPointDraft[] };
type ImportMode = 'domain' | 'chapters';
const typeText: Record<string, string> = { lecture: '讲义', practice: '实操指南', quiz: '题库', ppt: '交互课件', file: '文档' };
const kinds: [ResourceKind, string, string, typeof FileText][] = [
  ['lecture', '讲义', '知识讲解', BookOpen],
  ['practice', '实操指南', '步骤与任务', Wrench],
  ['quiz', '题库', '分阶测试资源', ClipboardList],
  ['ppt', '交互课件', '可播放的教学课件', MonitorPlay],
];

/* 节点 id 超过 JS 安全整数（会四舍五入导致不同节点撞值），展开/选中一律用 nodeCode */
function flatten(nodes: RagTreeNode[], expanded: Set<string>, depth = 0): { node: RagTreeNode; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...(node.children?.length && expanded.has(node.nodeCode) ? flatten(node.children, expanded, depth + 1) : [])]);
}

export default function ResourceCenterAdmin() {
  const navigate = useNavigate();
  const [domain, setDomain] = useState<RagDomain | { code: '__unassigned__'; name: string; description: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [node, setNode] = useState<RagTreeNode | null>(null);
  const [, setKind] = useState<ResourceKind>('lecture');
  const [keyword, setKeyword] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const [detail, setDetail] = useState<AdminResourceDetail | null>(null);
  const [pptPreviewOpen, setPptPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [focusTask, setFocusTask] = useState<string | null>(null);
  const [processTask, setProcessTask] = useState<GenerationTask | null>(null);
  const [generationTasks, setGenerationTasks] = useState<GenerationTask[]>([]);
  const [generationModalOpen, setGenerationModalOpen] = useState(false);
  const [selectedKinds, setSelectedKinds] = useState<Set<ResourceKind>>(new Set(['lecture', 'practice', 'quiz', 'ppt']));
  const [generationBusy, setGenerationBusy] = useState(false);
  const [selectedGroupName, setSelectedGroupName] = useState('默认分组');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['默认分组']));

  /* ---- 新建资源：上传文档 → 自动转成教材结构 ---- */
  const [importOpen, setImportOpen] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>('domain');
  /* 新建领域：只填名称，落到 knowledge_domain */
  const [domainCreateOpen, setDomainCreateOpen] = useState(false);
  /* 正在删除的领域编码，用于按钮 loading 与防重复提交 */
  const [deletingDomain, setDeletingDomain] = useState<string | null>(null);
  /* 资源中心按领域类型筛选 */
  const [domainTypeFilter, setDomainTypeFilter] = useState<string>('全部');
  /* 资源中心检索：领域名称 / 编码 / 说明 */
  const [domainQuery, setDomainQuery] = useState('');
  const [editingDomain, setEditingDomain] = useState<RagDomain | null>(null);
  /* 章节 / 知识点内补充内容 */
  const [contentNode, setContentNode] = useState<RagTreeNode | null>(null);
  /* 目录节点插入 / 修改 */
  const [categoryTarget, setCategoryTarget] = useState<{ node: RagTreeNode; mode: 'insert' | 'edit' } | null>(null);

  const openImportDialog = (mode: ImportMode) => {
    setImportMode(mode);
    setImportOpen(true);
  };

  const handleImported = () => {
    clearCacheStartsWith('admin:rag-domains');
    clearCacheStartsWith('admin:rag-tree');
    void domainsQ.refresh(true);
    void statsQ.refresh(true);
    void treeQ.refresh(true);
  };

  /* ---- SWR 缓存：先展示缓存，后台异步更新 ---- */
  const domainsQ = useCachedData<RagDomain[]>('admin:rag-domains', () => api.listRagDomains(), { ttlMs: 30_000 });
  /* 列表接口只返回 hasCover，封面正文按需单独拉，避免几 MB 的 base64 拖慢首屏 */
  const [domainCovers, setDomainCovers] = useState<Record<string, string>>({});
  useEffect(() => {
    const targets = (domainsQ.data ?? []).filter((item) => item.hasCover && !domainCovers[item.code]);
    if (targets.length === 0) return undefined;
    let cancelled = false;
    void Promise.all(targets.map((item) =>
      api.getRagDomainCover(item.code)
        .then((result) => [item.code, result.coverImage] as const)
        .catch(() => null),
    )).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      pairs.forEach((pair) => { if (pair && pair[1]) next[pair[0]] = pair[1]; });
      if (Object.keys(next).length > 0) setDomainCovers((prev) => ({ ...prev, ...next }));
    });
    return () => { cancelled = true; };
  }, [domainsQ.data, domainCovers]);
  const statsQ = useCachedData<AdminResourceStats>('admin:res:stats', () => api.getAdminResourceStats(), { ttlMs: 10_000 });
  const treeQ = useCachedData<RagTree>(
    domain && domain.code !== '__unassigned__' ? `admin:rag-tree:${domain.code}` : null,
    () => api.getRagTree((domain as RagDomain).code),
    { ttlMs: 60_000 },
  );
  const listQ = useCachedData<{ items: AdminResourceItem[]; total: number }>(
    domain ? `admin:res:library:${domain.code}:${node?.nodeCode ?? ''}:${debouncedKeyword}` : null,
    () => api.listAdminResources({ view: 'library', keyword: debouncedKeyword, domainCode: (domain as { code: string }).code, nodeCode: node?.nodeCode }),
    { ttlMs: 15_000 },
  );
  const pptQ = useCachedData<{ items: AdminResourceItem[]; total: number }>(
    domain ? `admin:ppt:library:${domain.code}:${node?.nodeCode ?? ''}:${debouncedKeyword}` : null,
    () => api.listAdminResources({ view: 'library', type: 'ppt', keyword: debouncedKeyword, domainCode: (domain as { code: string }).code, nodeCode: node?.nodeCode }),
    { ttlMs: 15_000 },
  );
  const groupQ = useCachedData<{ items: AdminResourceItem[]; total: number }>(
    node && domain && domain.code !== '__unassigned__'
      ? `admin:group-resources:${domain.code}:${node.nodeCode}`
      : null,
    () => api.listAdminResources({ view: 'library', domainCode: (domain as { code: string }).code, nodeCode: node?.nodeCode }),
    { ttlMs: 15_000 },
  );
  const groupResources = useMemo(() => {
    if (!node || !domain || domain.code === '__unassigned__') return [];
    return (groupQ.data?.items ?? []).filter((item) => item.type !== 'ppt' || item.status === 'completed');
  }, [groupQ.data?.items, node, domain]);
  const completedPptItems = useMemo(
    () => (pptQ.data?.items ?? []).filter((item) => item.status === 'completed'),
    [pptQ.data?.items],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedKeyword(keyword.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  /* 只在首次加载 / 切换领域时初始化展开状态：删除节点后目录树会刷新，
     这里若跟着重置会把用户展开的章全部收起 */
  const expandedDomainRef = useRef<string | null>(null);
  useEffect(() => {
    if (!treeQ.data) return;
    const code = treeQ.data.domain.code;
    if (expandedDomainRef.current === code) return;
    expandedDomainRef.current = code;
    const timer = window.setTimeout(() => setExpanded(new Set(treeQ.data?.nodes.map((n) => n.nodeCode) ?? [])), 0);
    return () => window.clearTimeout(timer);
  }, [treeQ.data]);
  useEffect(() => {
    const message = domainsQ.error?.message ?? statsQ.error?.message ?? treeQ.error?.message ?? listQ.error?.message;
    if (message) toast.error(message);
  }, [domainsQ.error, statsQ.error, treeQ.error, listQ.error]);

  const loadGenerationTasks = async () => {
    if (generationLoadInFlightRef.current) return;
    generationLoadInFlightRef.current = true;
    try {
      const [resources, presentations] = await Promise.all([
        api.listLearningResourceTasks(1000, true),
        presentationApi.listPresentationSummariesFresh(1000, true),
      ]);
      const textTasks: GenerationTask[] = resources.tasks.map((task) => ({ ...task, taskKind: 'resource' as const }));
      const pptTasks: GenerationTask[] = presentations.tasks.map((task) => ({ ...task, taskKind: 'ppt' as const }));
      const next = [...textTasks, ...pptTasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const signature = next.map((item) => `${item.taskKind}:${item.id}:${item.status}:${item.progress}:${item.updatedAt}`).join('|');
      if (signature !== generationTasksSignatureRef.current) {
        generationTasksSignatureRef.current = signature;
        setGenerationTasks(next);
      }
    } finally {
      generationLoadInFlightRef.current = false;
    }
  };
  const generationLoadInFlightRef = useRef(false);
  const generationTasksSignatureRef = useRef('');

  useEffect(() => {
    const initial = window.setTimeout(
      () => void loadGenerationTasks().catch((error) => toast.error(error instanceof Error ? error.message : '生成任务读取失败')),
      0,
    );
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadGenerationTasks().catch(() => undefined);
    }, 20000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadGenerationTasks().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const generationContext = (extra: Record<string, unknown> = {}, groupOverride?: string) => ({
    adminGeneration: true,
    domainCode: domain?.code,
    nodeCode: node?.nodeCode,
    topicName: node?.name,
    kpId: node?.nodeCode,
    groupName: groupOverride ?? selectedGroupName,
    ...extra,
  });
  const groupTypeMap = useMemo(() => {
    const map = new Map<string, Set<ResourceKind>>();
    const addType = (group: string, type: ResourceKind) => {
      if (!kinds.some(([id]) => id === type)) return;
      const set = map.get(group) ?? new Set<ResourceKind>();
      set.add(type);
      map.set(group, set);
    };
    /* 主列表与分组接口可能一先一后返回，取并集避免误判“前三项缺失”。 */
    const source = new Map<string, AdminResourceItem>();
    [...(listQ.data?.items ?? []), ...groupResources].forEach((item) => source.set(item.id, item));
    source.forEach((item) => { if (!item.archivedAt) addType(item.groupName || '默认分组', item.type as ResourceKind); });
    generationTasks.forEach((task) => {
      const ctx = taskContext(task);
      if (task.status === 'completed' && ctx.domainCode === domain?.code && ctx.nodeCode === node?.nodeCode) {
        addType(String(ctx.groupName || '默认分组'), task.taskKind === 'ppt' ? 'ppt' : task.resourceType);
      }
    });
    return map;
  }, [listQ.data?.items, groupResources, generationTasks, domain?.code, node?.nodeCode]);
  const groupNames = useMemo(() => Array.from(new Set(['默认分组', ...groupTypeMap.keys()])), [groupTypeMap]);
  const missingPptDependencies = (groupName?: string): ResourceKind[] => {
    const group = groupName ?? selectedGroupName;
    const available = groupTypeMap.get(group) ?? new Set<ResourceKind>();
    return (['lecture', 'practice', 'quiz'] as ResourceKind[]).filter((kind) => !available.has(kind));
  };
  useEffect(() => { if (!groupNames.includes(selectedGroupName)) setSelectedGroupName('默认分组'); }, [groupNames, selectedGroupName]);
  const groupTypeTasks = useMemo(() => {
    const map = new Map<string, Record<ResourceKind, GenerationTask>>();
    for (const task of generationTasks) {
      const ctx = taskContext(task);
      if (ctx.domainCode !== domain?.code || ctx.nodeCode !== node?.nodeCode) continue;
      const group = String(ctx.groupName || '默认分组');
      const type = (task.taskKind === 'ppt' ? 'ppt' : task.resourceType) as ResourceKind;
      const entry = map.get(group) ?? {} as Record<ResourceKind, GenerationTask>;
      if (!entry[type]) entry[type] = task;
      map.set(group, entry);
    }
    return map;
  }, [generationTasks, domain?.code, node?.nodeCode]);
  const groupedEntries = useMemo(() => {
    const map = new Map<string, Map<ResourceKind, AdminResourceItem>>();
    const ensure = (g: string) => { if (!map.has(g)) map.set(g, new Map()); return map.get(g)!; };
    [...(listQ.data?.items ?? []), ...completedPptItems].filter((item) => item.type !== 'file').forEach((item) => { ensure(item.groupName || '默认分组').set(item.type as ResourceKind, item); });
    generationTasks.forEach((task) => {
      const ctx = taskContext(task);
      if (task.status === 'completed' && ctx.domainCode === domain?.code && ctx.nodeCode === node?.nodeCode) ensure(String(ctx.groupName || '默认分组'));
    });
    ensure('默认分组');
    return [...map.entries()].sort(([a], [b]) => a === '默认分组' ? -1 : b === '默认分组' ? 1 : a.localeCompare(b));
  }, [listQ.data?.items, completedPptItems, generationTasks, domain?.code, node?.nodeCode]);

  const startGeneration = async (target: ResourceKind, regenerate = false, groupName?: string) => {
    if (!node || !domain || domain.code === '__unassigned__') throw new Error('请先选择一个具体知识点');
    if (target === 'ppt') {
      const missing = missingPptDependencies(groupName);
      if (missing.length) {
        throw new Error(`请先生成${missing.map((kind) => typeText[kind]).join('、')}，再生成交互课件`);
      }
    }
    if (target === 'ppt') {
      const request: PresentationRequest = {
        requirement: `围绕“${node.name}”生成一份面向学习者的完整交互课件，内容准确、结构清晰，并适合课堂讲解与自主学习。`,
        title: node.name,
        audience: 'students', purpose: 'courseware', style: 'education', backgroundStyle: 'blue-white-minimal',
        language: 'zh-CN', slideCount: 0, aspectRatio: '16:9', detailLevel: 'detailed',
        includeSpeakerNotes: true, modelProvider: 'mimo', generationMode: 'template', generationContext: generationContext({ waitForDependencies: true, ...(regenerate ? { regenerate: true } : {}) }, groupName),
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
      generationContext: generationContext(regenerate ? { regenerate: true } : {}, groupName),
    };
    const task = await api.startLearningResourceTask(target, request);
    return { taskKind: 'resource' as const, id: task.id };
  };

  const launchGeneration = (target: ResourceKind, regenerate = false, groupName?: string) => {
    void startGeneration(target, regenerate, groupName)
      .then((result) => {
        void loadGenerationTasks();
        navigate(`/admin/workbench?task=${result.taskKind}-${result.id}`);
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : '生成任务启动失败'));
  };

  const startSelected = async () => {
    let targets = [...selectedKinds];
    if (!targets.length) return;
    if (targets.includes('ppt')) {
      const missing = missingPptDependencies();
      if (missing.length) {
        targets = targets.filter((kind) => kind !== 'ppt');
        toast.info(`交互课件需先生成${missing.map((kind) => typeText[kind]).join('、')}；本次先启动其余资源`);
      }
    }
    if (!targets.length) return;
    setGenerationBusy(true);
    try {
      const results = await Promise.allSettled(targets.map((target) => startGeneration(target)));
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





  /** 资源 → 生成任务追溯：资源任务按 resourceId，课件先按任务 id 再按标题匹配 */
  const taskLogForResource = (item: AdminResourceItem): GenerationTask | null => {
    const byId = generationTasks.find((t) => t.taskKind === 'resource' && t.resourceId === item.id)
      ?? generationTasks.find((t) => t.taskKind === 'ppt' && t.id === item.id);
    if (byId) return byId;
    if (item.type === 'ppt') return generationTasks.find((t) => t.taskKind === 'ppt' && t.title === item.title) ?? null;
    return null;
  };

  const openResourceLog = async (item: AdminResourceItem) => {
    const task = taskLogForResource(item);
    if (!task) {
      toast.info('该资源没有管理员生成日志（可能为历史资源或非预生成来源）');
      return;
    }
    if (task.taskKind === 'resource') {
      try {
        const full = await api.getLearningResourceTask(task.id);
        setProcessTask({ ...full, taskKind: 'resource' });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '生成日志读取失败');
      }
      return;
    }
    setProcessTask(task);
  };

  const openDomain = (next: RagDomain | { code: '__unassigned__'; name: string; description: string }) => {
    setDomain(next);
    setNode(null);
    setKind('lecture');
    setKeyword('');
    setDebouncedKeyword('');
    setDetail(null);
  };

  /** 写操作后失效：清空资源相关缓存并强制刷新当前列表与统计 */
  const invalidateResources = async () => {
    clearCacheStartsWith('admin:res');
    await Promise.all([listQ.refresh(true), pptQ.refresh(true), statsQ.refresh(true)]);
  };

  const act = async (item: AdminResourceItem, action: string) => {
    try {
      if (action === 'template') await api.setAdminResourceTemplate(item.id);
      else if (action === 'delete') {
        if (!window.confirm(`确定彻底删除“${item.title}”吗？\n\n此操作不可恢复，相关内容${item.type === 'ppt' ? '和课件文件' : ''}将被永久删除。`)) return;
        await api.deleteAdminResourcePermanently(item.id);
      }
      else await api.reviewAdminResource(item.id, action as 'submit' | 'approve' | 'reject' | 'publish' | 'deprecate');
      toast.success(action === 'template' ? '已设为母版' : action === 'delete' ? '资源已彻底删除' : '资源状态已更新');
      await invalidateResources();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    }
  };

  /** 删除领域：连同目录、切片绑定与已生成资源一起删，需二次确认 */
  const removeDomain = async (item: RagDomain) => {
    if (!window.confirm(`确定删除领域「${item.name}」吗？\n\n该领域下的章、知识点、切片绑定和已生成资源都会一并删除，且不可恢复。`)) return;
    setDeletingDomain(item.code);
    try {
      await api.deleteKnowledgeDomain(item.code);
      toast.success(`领域「${item.name}」已删除`);
      clearCacheStartsWith('admin:rag-domains');
      void domainsQ.refresh(true);
      void statsQ.refresh(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '领域删除失败');
    } finally {
      setDeletingDomain(null);
    }
  };

  /** 删除目录节点（章 / 知识点）及其子树 */
  const removeCategory = async (itemNode: RagTreeNode) => {
    if (!domain || domain.code === '__unassigned__') return;
    if (!window.confirm(`确定删除「${itemNode.name}」吗？\n\n它下面的子目录、内容切片和已生成资源都会一并删除，且不可恢复。`)) return;
    try {
      const result = await api.deleteKnowledgeCategory(domain.code, itemNode.nodeCode);
      toast.success(result.deleted > 1
        ? `已删除「${result.name}」及 ${result.deleted - 1} 个子节点`
        : `已删除「${result.name}」`);
      if (node?.nodeCode === itemNode.nodeCode) { setNode(null); setDetail(null); }
      clearCacheStartsWith('admin:rag-tree');
      void treeQ.refresh(true);
      void listQ.refresh(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '目录节点删除失败');
    }
  };

  const deleteGroup = async (groupName: string) => {
    if (!domain || !node || domain.code === '__unassigned__' || groupName === '默认分组') return;
    if (!window.confirm(`确定彻底删除“${groupName}”吗？\n\n该知识点分组下的已生成/待生成资源与任务会被一并删除，且不可恢复。`)) return;
    try {
      await api.deleteAdminResourceGroup(domain.code, node.nodeCode, groupName);
      toast.success('分组已彻底删除');
      await invalidateResources();
      if (selectedGroupName === groupName) setSelectedGroupName('默认分组');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '分组删除失败');
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

  if (!domain) {
    const allDomains = domainsQ.data ?? [];
    const presentTypes = Array.from(new Set(allDomains.map((item) => item.domainType || '课程')));
    const presentCategories = Array.from(new Set(allDomains.map((item) => (item.category ?? '').trim()).filter(Boolean)));
    const keyword = domainQuery.trim().toLowerCase();
    const visibleDomains = allDomains.filter((item) => {
      if (domainTypeFilter !== '全部' && (item.domainType || '课程') !== domainTypeFilter) return false;
      if (!keyword) return true;
      return `${item.name} ${item.code} ${item.description ?? ''}`.toLowerCase().includes(keyword);
    });
    return (
      <div className="lf-anim-in-up">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-ink">资源中心</h2>
            <p className="mt-1.5 text-sm text-ink-muted">先选择领域，再沿知识目录管理四类学习资源。</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setDomainCreateOpen(true)} className="lf-row-btn lf-row-btn-primary">
              <Plus size={13} />
              新建领域
            </button>
            <button onClick={() => navigate('/admin/workbench')} className="lf-row-btn">
              <Sparkles size={13} />
              AI 教研工作台
            </button>
          </div>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2.5">
          <label className="relative min-w-[240px] flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
            <input
              value={domainQuery}
              onChange={(event) => setDomainQuery(event.target.value)}
              placeholder="检索领域：名称 / 编码 / 说明"
              aria-label="检索领域"
              className="lf-input !h-9 !py-0 !pl-9 !pr-8 text-[12.5px]"
            />
            {domainQuery && (
              <button type="button" onClick={() => setDomainQuery('')} aria-label="清空检索" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink">
                <X size={13} />
              </button>
            )}
          </label>
          <span className="font-mono text-[11px] text-ink-muted">共 {visibleDomains.length} 个领域</span>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {['全部', ...presentTypes].map((option) => (
            <button
              key={option}
              onClick={() => setDomainTypeFilter(option)}
              className={cn(
                'rounded-full border px-3 py-1 text-[11.5px] transition-colors',
                domainTypeFilter === option
                  ? 'border-brand bg-brand text-paper'
                  : 'border-hairline bg-paper text-ink-2 hover:border-brand/50',
              )}
            >
              {option}
              <span className="ml-1 opacity-60">
                {option === '全部' ? allDomains.length : allDomains.filter((item) => (item.domainType || '课程') === option).length}
              </span>
            </button>
          ))}
        </div>
        {visibleDomains.length === 0 && (
          <div className="lf-card px-6 py-14 text-center text-[12.5px] text-ink-muted">
            没有匹配的领域{domainQuery.trim() ? `「${domainQuery.trim()}」` : ''}
          </div>
        )}
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {visibleDomains.map((item) => (
            <div
              key={item.code}
              role="button"
              tabIndex={0}
              onClick={() => openDomain(item)}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') openDomain(item); }}
              className="lf-card lf-card-hover group relative cursor-pointer overflow-hidden rounded-2xl text-left"
            >
              {domainCovers[item.code] ? (
                <img src={domainCovers[item.code]} alt={`${item.name} 封面`} className="aspect-video w-full object-cover" />
              ) : (
                <div className="flex aspect-video w-full items-center justify-center bg-gradient-to-br from-brand-tint to-paper">
                  <FolderTree size={34} className="text-brand/60 transition-transform duration-300 group-hover:scale-110" />
                </div>
              )}
              <div className="absolute right-3 top-3 flex items-center gap-1">
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); setEditingDomain({ ...item, coverImage: domainCovers[item.code] ?? '' }); }}
                  title={`修改领域「${item.name}」`}
                  aria-label={`修改领域 ${item.name}`}
                  className="rounded-full bg-paper/90 p-1.5 text-ink-muted shadow-sm backdrop-blur transition-colors hover:text-brand"
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); void removeDomain(item); }}
                  disabled={deletingDomain === item.code}
                  title={`删除领域「${item.name}」`}
                  aria-label={`删除领域 ${item.name}`}
                  className="rounded-full bg-paper/90 p-1.5 text-ink-muted shadow-sm backdrop-blur transition-colors hover:text-red-600 disabled:opacity-50"
                >
                  {deletingDomain === item.code
                    ? <Loader2 className="animate-spin" size={14} />
                    : <Trash2 size={14} />}
                </button>
              </div>
              <div className="p-4">
                <div className="flex items-center gap-2">
                  <h3 className="text-[15px] font-bold text-ink">{item.name}</h3>
                  <span className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                    (item.domainType || '课程') === '专题' ? 'bg-amber-100 text-amber-700'
                      : (item.domainType || '课程') === '书籍' ? 'bg-sky-100 text-sky-700'
                        : (item.domainType || '课程') === '其他' ? 'bg-ink/8 text-ink-muted'
                          : 'bg-brand-tint text-brand',
                  )}>
                    {item.domainType || '课程'}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11.5px] leading-5 text-ink-muted">{item.description || '暂无领域说明'}</p>
              </div>
            </div>
          ))}
        </div>
        {domainsQ.loading && !domainsQ.data && (
          <div className="flex justify-center py-10 text-sm text-ink-muted">
            <Loader2 className="mr-2 animate-spin" size={16} />
            正在读取领域…
          </div>
        )}
        <TaskDrawer open={taskDrawerOpen} tasks={generationTasks} busy={generationBusy} focusTaskId={focusTask} onClose={() => { setTaskDrawerOpen(false); setFocusTask(null); }} onCancel={() => undefined} onRetry={() => undefined} onInspect={setProcessTask} />
        <GenerationProcessModal task={processTask} onClose={() => setProcessTask(null)} />
        <KnowledgeImportModal
          open={importOpen}
          initialMode={importMode}
          onClose={() => setImportOpen(false)}
          onImported={handleImported}
        />
        <CreateDomainModal
          open={domainCreateOpen}
          onClose={() => setDomainCreateOpen(false)}
          onCreated={handleImported}
          onImport={() => { setDomainCreateOpen(false); openImportDialog('domain'); }}
          types={presentTypes}
          categories={presentCategories}
        />
        <EditDomainModal
          domain={editingDomain}
          onClose={() => setEditingDomain(null)}
          onSaved={(patch) => {
            if (editingDomain) {
              setDomainCovers((prev) => {
                const next = { ...prev };
                if (patch.coverImage) next[editingDomain.code] = patch.coverImage;
                else delete next[editingDomain.code];
                return next;
              });
            }
            clearCacheStartsWith('admin:rag-domains');
            void domainsQ.refresh(true);
          }}
          types={presentTypes}
          categories={presentCategories}
        />
      </div>
    );
  }

  const tree = treeQ.data;
  /* L1 根节点只是容器：直接展示它下面的章，空领域就没有任何行 */
  const visibleTreeNodes = (tree?.nodes ?? []).flatMap((item) => (item.level === 1 ? item.children ?? [] : [item]));

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
      </div>

      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[280px_1fr] lg:grid-rows-[minmax(0,1fr)]">
        <aside className="lf-card flex flex-col overflow-hidden rounded-2xl">
          <div className="flex items-start justify-between gap-2 border-b border-white/60 px-4 py-3.5">
            <div>
              <p className="text-sm font-bold text-ink">{domain.name}</p>
              <p className="mt-0.5 text-[11px] text-ink-muted">知识目录</p>
            </div>
            {domain.code !== '__unassigned__' && (
              <button
                type="button"
                onClick={() => {
                  const rootNode = tree?.nodes.find((item) => item.level === 1);
                  if (!rootNode) { toast.error('该领域缺少根节点，请先重建领域'); return; }
                  setCategoryTarget({ node: rootNode, mode: 'insert' });
                }}
                className="lf-row-btn !px-1.5"
                title="新增章"
              >
                <Plus size={12} />
              </button>
            )}
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
              {/* 领域根节点（L1）只是树的容器，不占一行；章直接作为顶层展示 */}
              {visibleTreeNodes.length === 0 && (
                <p className="px-4 py-6 text-[11.5px] leading-5 text-ink-muted">
                  还没有章节，点右上角「+」新增第一章。
                </p>
              )}
              {flatten(visibleTreeNodes, expanded).map(({ node: itemNode, depth }) => {
                const hasChildren = Boolean(itemNode.children?.length);
                const isActive = !hasChildren && node?.nodeCode === itemNode.nodeCode;
                return (
                  <div
                    key={itemNode.nodeCode}
                    className={cn('flex items-center rounded-lg pr-2 text-xs transition-colors', isActive ? 'lf-tree-active' : 'text-ink-2 hover:bg-brand-tint/40')}
                    style={{ paddingLeft: 6 + depth * 14 }}
                  >
                    {hasChildren ? (
                      /* 分类 / 章节节点：整行点击仅展开或收起，不可进入 */
                      <button
                        onClick={() =>
                          setExpanded((current) => {
                            const next = new Set(current);
                            if (next.has(itemNode.nodeCode)) next.delete(itemNode.nodeCode);
                            else next.add(itemNode.nodeCode);
                            return next;
                          })
                        }
                        title={expanded.has(itemNode.nodeCode) ? '收起' : '展开'}
                        className="flex min-w-0 flex-1 items-center gap-1 truncate py-2.5 text-left font-semibold"
                      >
                        {expanded.has(itemNode.nodeCode) ? (
                          <ChevronDown size={12} className="shrink-0 text-brand/70" />
                        ) : (
                          <ChevronRight size={12} className="shrink-0 text-ink-muted/70" />
                        )}
                        <span className="truncate">{itemNode.name}</span>
                        {itemNode.level === 2 && (
                          <span className="shrink-0 rounded bg-brand-tint px-1 py-0.5 text-[9.5px] font-semibold text-brand">章</span>
                        )}
                      </button>
                    ) : (
                      /* 知识点（叶子）节点：点击进入该知识点 */
                      <button onClick={() => { setNode(itemNode); setSelectedGroupName('默认分组'); setDetail(null); }} className="min-w-0 flex-1 truncate py-2.5 text-left">
                        {itemNode.name}
                      </button>
                    )}
                    {/* 节点操作：插入 / 修改 / 补充内容 / 删除 */}
                    <span className="flex shrink-0 items-center">
                      {/* 插入只对章开放：知识点是叶子，下面不能再挂章或知识点 */}
                      {itemNode.level < 3 && (
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); setCategoryTarget({ node: itemNode, mode: 'insert' }); }}
                          className="lf-row-btn !px-1"
                          title={`在「${itemNode.name}」下插入章或知识点`}
                        >
                          <Plus size={11} />
                        </button>
                      )}
                      {itemNode.level > 1 && (
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); setCategoryTarget({ node: itemNode, mode: 'edit' }); }}
                          className="lf-row-btn !px-1"
                          title={`修改「${itemNode.name}」`}
                        >
                          <Pencil size={11} />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); setContentNode(itemNode); }}
                        className="lf-row-btn !px-1"
                        title={`上传内容到「${itemNode.name}」`}
                      >
                        <Upload size={11} />
                      </button>
                      {itemNode.level > 1 && (
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); void removeCategory(itemNode); }}
                          className="lf-row-btn !px-1 text-ink-muted hover:text-red-600"
                          title={`删除「${itemNode.name}」`}
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </span>
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
                  {detail.type === 'ppt' && <button type="button" onClick={() => setPptPreviewOpen(true)} className="lf-row-btn lf-row-btn-primary"><MonitorPlay size={12} />完整课件预览</button>}
                  <span className="lf-pill lf-pill-null">{typeText[detail.type] || detail.type}</span>
                  <span className="lf-pill lf-pill-null">v{detail.revision}</span>
                  {detail.reviewStatus ? (
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
                <div className="min-w-52 flex-1">
                  <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索当前目录资源" className="lf-input" />
                </div>
                {node && (
                  <button type="button" onClick={() => setContentNode(node)} className="lf-row-btn">
                    <Upload size={11} />上传到「{node.name}」
                  </button>
                )}
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
                  const activeTypeTasks = groupTypeTasks.get(groupName);
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
                        <span className="ml-auto" />
                        <button
                          disabled={isTemplate || !firstItem}
                          onClick={(e) => { e.stopPropagation(); firstItem && void act(firstItem, 'template'); }}
                          className="lf-row-btn lf-row-btn-primary disabled:cursor-default disabled:opacity-70"
                        >
                          <LayoutTemplate size={11} />
                          {isTemplate ? '当前母版' : '设为母版'}
                        </button>
                        {groupName !== '默认分组' && (
                          <button
                            onClick={(e) => { e.stopPropagation(); void deleteGroup(groupName); }}
                            className="lf-row-btn text-red-600"
                            title="彻底删除该分组"
                          >
                            <Trash2 size={11} />
                            删除分组
                          </button>
                        )}
                      </button>
                      {isExpanded && (
                        <div className="border-t border-white/60 px-4 py-1">
                          {kinds.map(([type, label, _desc, Icon]) => {
                            const item = typeMap.get(type);
                            const task = activeTypeTasks?.[type] ?? null;
                            const active = task ? activeGenerationStatuses.has(task.status) : false;
                            const runningTask = active ? task : null;
                            const hasPriorState = Boolean(item) || task !== null;
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
                                    {active ? (
                                      <span className="lf-pill lf-pill-warn"><Loader2 size={11} className="animate-spin" />生成中 {runningTask?.progress}%</span>
                                    ) : (
                                      <button onClick={() => launchGeneration(type, true, groupName)} className="lf-row-btn text-ink-muted" title="重新生成"><RefreshCw size={11} />重新生成</button>
                                    )}
                                    <button onClick={() => preview(item)} className="lf-row-btn"><Eye size={11} />预览</button>
                                    {openResourceLog && <button onClick={() => void openResourceLog(item)} className="lf-row-btn" title="打开生成日志"><FileText size={11} />日志</button>}
                                  </>
                                ) : active ? (
                                  <>
                                    <span className="min-w-0 flex-1 truncate font-semibold text-brand">
                                      <span className="inline-flex items-center gap-1.5"><Loader2 size={11} className="animate-spin" />生成中 {runningTask?.progress}% · {runningTask?.stageMessage || '任务进行中'}</span>
                                    </span>
                                    <button onClick={() => runningTask && navigate(`/admin/workbench?task=${runningTask.taskKind}-${runningTask.id}`)} className="lf-row-btn">查看任务</button>
                                  </>
                                ) : (
                                  <button onClick={() => launchGeneration(type, hasPriorState, groupName)} className="lf-row-btn lf-row-btn-primary"><Plus size={11} />生成</button>
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
      {pptPreviewOpen && detail?.type === 'ppt' && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-ink/35 p-4 backdrop-blur-sm">
          <div className="lf-card flex h-[min(90vh,820px)] w-full max-w-6xl flex-col overflow-hidden rounded-3xl shadow-2xl">
            <div className="flex shrink-0 items-center justify-between border-b border-white/70 px-5 py-4">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-bold text-ink">{detail.title}</h3>
                <p className="mt-0.5 text-[11px] text-ink-muted">{typeText[detail.type] || detail.type} · 已生成内容预览</p>
              </div>
              <button onClick={() => setPptPreviewOpen(false)} className="lf-row-btn !p-2" aria-label="关闭"><X size={15} /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.8fr)]">
              <div className="flex min-h-0 flex-col overflow-y-auto border-b border-white/70 p-4 lg:border-b-0 lg:border-r">
                <PptModalPreview taskId={detail.id} />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                <ResourcePreview detail={detail} />
              </div>
            </div>
          </div>
        </div>
      )}
      <KnowledgeImportModal
        open={importOpen}
        initialMode={importMode}
        onClose={() => setImportOpen(false)}
        onImported={handleImported}
      />
      <EditDomainModal
        domain={editingDomain}
        onClose={() => setEditingDomain(null)}
        onSaved={(patch) => {
          if (domain && domain.code === editingDomain?.code) {
            setDomain({ ...(domain as RagDomain), ...patch });
          }
          if (editingDomain) {
            setDomainCovers((prev) => {
              const next = { ...prev };
              if (patch.coverImage) next[editingDomain.code] = patch.coverImage;
              else delete next[editingDomain.code];
              return next;
            });
          }
          clearCacheStartsWith('admin:rag-domains');
          void domainsQ.refresh(true);
        }}
      />
      <CategoryEditorModal
        target={categoryTarget}
        domainCode={domain?.code ?? ''}
        onClose={() => setCategoryTarget(null)}
        onDone={() => { setCategoryTarget(null); handleImported(); }}
      />
      <NodeContentUploadModal
        node={contentNode}
        domainCode={domain?.code ?? ''}
        onClose={() => setContentNode(null)}
        onDone={() => { setContentNode(null); handleImported(); }}
      />
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
        onSelectAll={() => setSelectedKinds(new Set(['lecture', 'practice', 'quiz', 'ppt']))}
        onSubmit={() => void startSelected()}
      />
      <TaskDrawer open={taskDrawerOpen} tasks={generationTasks} busy={generationBusy} focusTaskId={focusTask} onClose={() => { setTaskDrawerOpen(false); setFocusTask(null); }} onCancel={() => undefined} onRetry={() => undefined} onInspect={setProcessTask} />
      <GenerationProcessModal task={processTask} onClose={() => setProcessTask(null)} />
    </div>
  );
}

/** 新建领域：只要求领域名称，写入 knowledge_domain 并建同名一级根 */
const DOMAIN_TYPES = ['课程', '专题', '书籍', '其他'] as const;

/** 领域类型选择：可选已有类型，也可现场新建一个类型 */
function DomainTypePicker({ value, onChange, types }: { value: string; onChange: (value: string) => void; types: string[] }) {
  const [creating, setCreating] = useState(false);
  const [custom, setCustom] = useState('');
  const options = useMemo(
    () => Array.from(new Set([...DOMAIN_TYPES, ...types, value].filter(Boolean))),
    [types, value],
  );
  const confirmCustom = () => {
    const next = custom.trim();
    if (!next) {
      setCreating(false);
      return;
    }
    onChange(next);
    setCustom('');
    setCreating(false);
  };
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={cn(
              'rounded-full border px-3 py-1 text-[11.5px] transition-colors',
              value === option
                ? 'border-brand bg-brand text-paper'
                : 'border-hairline bg-paper text-ink-2 hover:border-brand/50',
            )}
          >
            {option}
          </button>
        ))}
        {creating ? (
          <span className="flex items-center gap-1">
            <input
              autoFocus
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); confirmCustom(); }
                if (event.key === 'Escape') { setCreating(false); setCustom(''); }
              }}
              placeholder="新类型名称"
              aria-label="新类型名称"
              className="h-[26px] w-[104px] rounded-full border border-brand/50 bg-paper px-3 text-[11.5px] outline-none"
            />
            <button type="button" onClick={confirmCustom} className="rounded-full bg-brand px-2.5 py-1 text-[11px] font-medium text-paper">确定</button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-full border border-dashed border-hairline px-3 py-1 text-[11.5px] text-ink-muted transition-colors hover:border-brand/50 hover:text-brand"
          >
            + 新建类型
          </button>
        )}
      </div>
      <p className="mt-1 text-[10.5px] text-ink-muted">用来在资源中心按类型筛选，之后还能改。</p>
    </div>
  );
}

/** 领域类别（如「AI与大模型」）：可选已有类别，也可现场新建；空字符串表示未分类 */
function DomainCategoryPicker({ value, onChange, categories }: { value: string; onChange: (value: string) => void; categories: string[] }) {
  const [creating, setCreating] = useState(false);
  const [custom, setCustom] = useState('');
  const options = Array.from(new Set(categories.filter(Boolean)));
  const confirmCustom = () => {
    const next = custom.trim();
    if (!next) {
      setCreating(false);
      return;
    }
    onChange(next);
    setCustom('');
    setCreating(false);
  };
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onChange('')}
          className={cn(
            'rounded-full border px-3 py-1 text-[11.5px] transition-colors',
            value === '' ? 'border-brand bg-brand text-paper' : 'border-hairline bg-paper text-ink-2 hover:border-brand/50',
          )}
        >
          未分类
        </button>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={cn(
              'rounded-full border px-3 py-1 text-[11.5px] transition-colors',
              value === option ? 'border-brand bg-brand text-paper' : 'border-hairline bg-paper text-ink-2 hover:border-brand/50',
            )}
          >
            {option}
          </button>
        ))}
        {creating ? (
          <span className="flex items-center gap-1">
            <input
              autoFocus
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); confirmCustom(); }
                if (event.key === 'Escape') { setCreating(false); setCustom(''); }
              }}
              placeholder="新类别名称"
              aria-label="新类别名称"
              className="h-[26px] w-[104px] rounded-full border border-brand/50 bg-paper px-3 text-[11.5px] outline-none"
            />
            <button type="button" onClick={confirmCustom} className="rounded-full bg-brand px-2.5 py-1 text-[11px] font-medium text-paper">确定</button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-full border border-dashed border-hairline px-3 py-1 text-[11.5px] text-ink-muted transition-colors hover:border-brand/50 hover:text-brand"
          >
            + 新建类别
          </button>
        )}
      </div>
      <p className="mt-1 text-[10.5px] text-ink-muted">用户端「发现课程」按这个类别分组，例如 AI与大模型、数据分析。</p>
    </div>
  );
}

function CreateDomainModal({ open, onClose, onCreated, onImport, types, categories }: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  onImport: () => void;
  types: string[];
  categories: string[];
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('课程');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName('');
    setType('课程');
    setCategory('');
    setBusy(false);
    setError('');
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    const value = name.trim();
    if (!value) {
      setError('请填写领域名称');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.importKnowledgeDocument({ mode: 'domain', domainName: value, domainType: type, category, chapters: [], skipIngest: true });
      toast.success(`领域「${value}」已创建`);
      onCreated();
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : '领域创建失败';
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-ink/40 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-3xl border border-hairline bg-paper shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-hairline px-6 py-4">
          <div>
            <h3 className="text-sm font-bold text-ink">新建领域</h3>
            <p className="mt-0.5 text-[11px] text-ink-muted">填写领域名称即可，章、知识点和资源可以之后再补。</p>
          </div>
          <button onClick={onClose} className="lf-row-btn !p-2" aria-label="关闭">
            <X size={15} />
          </button>
        </div>
        <div className="px-6 py-4">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-ink-2">领域名称</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => { setName(event.target.value); if (error) setError(''); }}
              onKeyDown={(event) => { if (event.key === 'Enter' && !busy) void submit(); }}
              placeholder="例如：大模型应用开发"
              className="lf-input"
            />
          </label>
          <div className="mt-3">
            <span className="mb-1 block text-[11px] font-semibold text-ink-2">领域类型</span>
            <DomainTypePicker value={type} onChange={setType} types={types} />
          </div>
          <div className="mt-3">
            <span className="mb-1 block text-[11px] font-semibold text-ink-2">领域类别</span>
            <DomainCategoryPicker value={category} onChange={setCategory} categories={categories} />
          </div>
          {error && <p className="mt-1.5 text-[11px] text-brand-danger">{error}</p>}
          <button type="button" onClick={onImport} className="mt-3 text-[11px] font-medium text-brand hover:underline">
            或从文档创建领域（自动生成章和知识点）→
          </button>
        </div>
        <div className="flex justify-end gap-2 border-t border-hairline px-6 py-3.5">
          <button onClick={onClose} className="lf-row-btn">取消</button>
          <button onClick={() => void submit()} disabled={busy || !name.trim()} className="lf-row-btn lf-row-btn-primary disabled:opacity-50">
            {busy ? <Loader2 className="animate-spin" size={13} /> : <Plus size={13} />}
            {busy ? '创建中…' : '创建领域'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 压缩封面：等比缩到最长边 1280px，转 JPEG 并逐级降质，直到 data URL 小于 1.2MB。
 * 服务端请求体上限约 2MB（超出直接 413），所以不能原样上传大图。
 */
async function compressCover(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('图片解析失败'));
      element.src = objectUrl;
    });
    const maxSide = 1280;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持图片处理');
    /* 透明图转 JPEG 会变黑，先铺白底 */
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    let quality = 0.86;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (dataUrl.length > 1200000 && quality > 0.4) {
      quality -= 0.08;
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** 修改领域资料：名称 / 说明 / 类型 / 类别 / 封面图 */
function EditDomainModal({ domain, onClose, onSaved, types, categories }: {
  domain: RagDomain | null;
  onClose: () => void;
  onSaved: (patch: { name: string; description: string; domainType: string; category: string; coverImage: string }) => void;
  types: string[];
  categories: string[];
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<string>('课程');
  const [category, setCategory] = useState('');
  const [cover, setCover] = useState('');
  const [busy, setBusy] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!domain) return;
    setName(domain.name);
    setDescription(domain.description ?? '');
    setType(domain.domainType || '课程');
    setCategory(domain.category ?? '');
    setCover(domain.coverImage ?? '');
    setBusy(false);
    setError('');
  }, [domain]);

  if (!domain) return null;

  const pickCover = async (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('请选择图片文件（png / jpg / webp）');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError('封面图请控制在 8MB 以内');
      return;
    }
    setCompressing(true);
    try {
      const dataUrl = await compressCover(file);
      setCover(dataUrl);
      setError('');
    } catch {
      setError('封面处理失败，请换一张图片重试');
    } finally {
      setCompressing(false);
    }
  };

  const submit = async () => {
    const value = name.trim();
    if (!value || busy) return;
    setBusy(true);
    setError('');
    const patch = { name: value, description: description.trim(), domainType: type, category, coverImage: cover };
    try {
      await api.updateKnowledgeDomain(domain.code, patch);
      toast.success('领域资料已更新');
      onSaved(patch);
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : '领域资料保存失败';
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-ink/40 p-4">
      <div className="w-full max-w-lg overflow-hidden rounded-3xl border border-hairline bg-paper shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-hairline px-6 py-4">
          <div>
            <h3 className="text-sm font-bold text-ink">修改领域</h3>
            <p className="mt-0.5 text-[11px] text-ink-muted">可改名称、说明、类型和封面图。</p>
          </div>
          <button onClick={onClose} className="lf-row-btn !p-2" aria-label="关闭">
            <X size={15} />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-6 py-4">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-ink-2">领域名称</span>
            <input
              value={name}
              onChange={(event) => { setName(event.target.value); if (error) setError(''); }}
              className="lf-input"
            />
          </label>
          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] font-semibold text-ink-2">领域说明</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              placeholder="一句话说明这个领域讲什么"
              className="lf-input min-h-[76px] resize-y"
            />
          </label>
          <div className="mt-3">
            <span className="mb-1 block text-[11px] font-semibold text-ink-2">领域类型</span>
            <DomainTypePicker value={type} onChange={setType} types={types} />
          </div>
          <div className="mt-3">
            <span className="mb-1 block text-[11px] font-semibold text-ink-2">领域类别</span>
            <DomainCategoryPicker value={category} onChange={setCategory} categories={categories} />
          </div>
          <div className="mt-3">
            <span className="mb-1 block text-[11px] font-semibold text-ink-2">封面图</span>
            <div className="flex items-center gap-3">
              {cover ? (
                <img src={cover} alt="领域封面" className="aspect-video w-40 rounded-xl border border-hairline object-cover" />
              ) : (
                <div className="flex aspect-video w-40 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-hairline text-ink-muted">
                  <ImagePlus size={18} />
                  <span className="text-[10px]">暂无封面</span>
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={(event) => { void pickCover(event.target.files?.[0] ?? null); event.target.value = ''; }}
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={compressing}
                  className="lf-row-btn disabled:opacity-50"
                >
                  {compressing ? <Loader2 className="animate-spin" size={12} /> : <Upload size={12} />}
                  {compressing ? '压缩中…' : '上传封面'}
                </button>
                {cover && (
                  <button type="button" onClick={() => setCover('')} className="lf-row-btn text-ink-muted">
                    <X size={12} />
                    清除封面
                  </button>
                )}
                <span className="text-[10px] text-ink-muted">建议 16:9 横图，8MB 以内，自动压缩</span>
              </div>
            </div>
          </div>
          {error && <p className="mt-2 text-[11px] text-brand-danger">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-hairline px-6 py-3.5">
          <button onClick={onClose} className="lf-row-btn">取消</button>
          <button onClick={() => void submit()} disabled={busy || !name.trim()} className="lf-row-btn lf-row-btn-primary disabled:opacity-50">
            {busy ? <Loader2 className="animate-spin" size={13} /> : <Pencil size={13} />}
            {busy ? '保存中…' : '保存修改'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function KnowledgeImportModal({ open, initialMode, onClose, onImported }: {
  open: boolean;
  initialMode: ImportMode;
  onClose: () => void;
  onImported: () => void;
}) {
  const [mode, setMode] = useState<ImportMode>(initialMode);
  const [domainName, setDomainName] = useState('');
  const [parentId, setParentId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [parsed, setParsed] = useState(false);
  const [chapters, setChapters] = useState<ImportChapterDraft[]>([]);
  const [roots, setRoots] = useState<CatalogRoot[]>([]);
  const [structureOnly, setStructureOnly] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setDomainName('');
    setFile(null);
    setParsed(false);
    setChapters([]);
    setTitle('');
    setStructureOnly(false);
    if (fileRef.current) fileRef.current.value = '';
    let alive = true;
    api.listCatalogDomains()
      .then((items) => {
        if (!alive) return;
        setRoots(items);
        setParentId((current) => (current && items.some((root) => root.id === current) ? current : (items[0]?.id ?? '')));
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : '大章节列表加载失败'));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialMode]);

  const switchMode = (next: ImportMode) => {
    setMode(next);
    setParsed(false);
    setChapters([]);
  };

  const toggleStructureOnly = (next: boolean) => {
    setStructureOnly(next);
    if (next) {
      setParsed(true);
      setChapters((current) => (current.length ? current : [{ name: '', description: '', enabled: true, points: [] }]));
    } else {
      setParsed(false);
      setChapters([]);
    }
  };

  const addChapter = () => {
    setStructureOnly(true);
    setParsed(true);
    setChapters((current) => [...current, { name: '', description: '', enabled: true, points: [] }]);
  };

  const addPoint = (chapterIndex: number) => {
    setChapters((current) => current.map((chapter, index) => (
      index === chapterIndex
        ? { ...chapter, points: [...chapter.points, { name: '', description: '', enabled: true }] }
        : chapter
    )));
  };

  const removeChapter = (chapterIndex: number) => {
    setChapters((current) => current.filter((_, index) => index !== chapterIndex));
  };

  const removePoint = (chapterIndex: number, pointIndex: number) => {
    setChapters((current) => current.map((chapter, index) => (
      index === chapterIndex
        ? { ...chapter, points: chapter.points.filter((_, pi) => pi !== pointIndex) }
        : chapter
    )));
  };

  const parseFile = async () => {
    if (!file) {
      toast.error('请先选择文件');
      return;
    }
    setBusy(true);
    try {
      const outline = await api.parseKnowledgeDocument({ fileName: file.name, dataBase64: await fileToBase64(file) });
      const fallbackTitle = file.name.replace(/\.[^.]+$/, '');
      setTitle(outline.title || fallbackTitle);
      if (mode === 'chapters') {
        // 单章内容：H1 作为章，H2/H3 拍平成知识点
        const points: ImportPointDraft[] = [];
        outline.chapters.forEach((chapter) => {
          points.push({ name: chapter.name, description: chapter.description, enabled: true });
          chapter.points.forEach((point) => {
            points.push({ name: point.name, description: point.description, enabled: true });
          });
        });
        setChapters([{ name: outline.title || fallbackTitle, description: '', enabled: true, points }]);
      } else {
        setChapters(outline.chapters.map((chapter) => ({
          name: chapter.name,
          description: chapter.description,
          enabled: true,
          points: chapter.points.map((point) => ({ ...point, enabled: true })),
        })));
      }
      setParsed(true);
      if (!outline.chapters.length) {
        toast.error('没有从文档中解析出章节结构，请检查标题层级');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '文档解析失败');
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!structureOnly && !file) {
      toast.error('请选择文件，或勾选「只建结构」');
      return;
    }
    let payloadChapters: CatalogChapterSuggestion[] = [];
    payloadChapters = chapters
      .filter((chapter) => chapter.enabled && chapter.name.trim())
      .map((chapter) => ({
        name: chapter.name.trim(),
        description: chapter.description,
        points: chapter.points
          .filter((point) => point.enabled && point.name.trim())
          .map((point) => ({ name: point.name.trim(), description: point.description })),
      }));
    if (!payloadChapters.length) {
      // 只建结构时允许先建一个空的容器；从文档入库则必须有结构
      if (!structureOnly) {
        toast.error('请至少保留一个章');
        return;
      }
      if (mode === 'chapters') {
        toast.error('请填写章名');
        return;
      }
    }
    if (mode === 'domain' && !domainName.trim()) {
      toast.error('请填写大章节名称');
      return;
    }
    if (mode === 'chapters' && !parentId) {
      toast.error('请选择要挂载的大章节');
      return;
    }

    setBusy(true);
    try {
      const result = await api.importKnowledgeDocument({
        mode,
        domainName: mode === 'domain' ? domainName.trim() : undefined,
        parentId: mode === 'chapters' ? parentId : undefined,
        fileName: structureOnly ? undefined : file?.name,
        dataBase64: structureOnly || !file ? undefined : await fileToBase64(file),
        chapters: payloadChapters,
        skipIngest: structureOnly,
      });
      toast.success(structureOnly
        ? `结构已创建：${result.chapters} 个章 / ${result.points} 个知识点`
        : `已入库：${result.chapters} 个章 / ${result.points} 个知识点 / ${result.boundChunks} 条切片`);
      onImported();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : (structureOnly ? '结构创建失败' : '文档入库失败'));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[120] overflow-y-auto bg-ink/40">
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-hairline bg-paper shadow-2xl">
          <div className="flex items-start justify-between gap-3 border-b border-hairline px-6 py-4">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-tint text-brand">
                <Plus size={16} />
              </span>
              <div>
                <h3 className="text-sm font-bold text-ink">新建资源</h3>
                <p className="mt-0.5 text-[11px] text-ink-muted">
                  上传文档自动切章 / 知识点并切片入库，也可以只建结构
                </p>
              </div>
            </div>
            <button onClick={onClose} className="lf-row-btn !p-2" aria-label="关闭">
              <X size={15} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">

        <div className="inline-flex rounded-xl bg-brand-tint/40 p-1">
          {([
            ['domain', '从文档建领域'],
            ['chapters', '新增章'],
          ] as [ImportMode, string][]).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => switchMode(value)}
              className={cn('rounded-lg px-4 py-1.5 text-xs font-bold transition-colors',
                mode === value ? 'bg-paper text-brand shadow-sm' : 'text-ink-2 hover:text-ink')}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[10.5px] text-ink-muted">
          {mode === 'domain'
            ? '从文档新建一个和「智能体」并列的领域，文档的章会成为它下面的二级目录。'
            : '在当前领域下新增一章，章内标题会成为知识点。'}
        </p>

        <label className="mt-3 flex items-center gap-2 rounded-xl bg-brand-tint/30 px-3 py-2 text-[11.5px] text-ink-2">
          <input type="checkbox" checked={structureOnly} onChange={(event) => toggleStructureOnly(event.target.checked)} />
          只建结构，不上传文档（建好后可在章节/知识点里再补充内容）
        </label>

        <div className="mt-3 space-y-2">
          {mode === 'domain' && (
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-ink-2">领域名称（新建后与「智能体」并列）</span>
              <input value={domainName} onChange={(event) => setDomainName(event.target.value)}
                placeholder="例如：大模型应用开发" className="lf-input" />
            </label>
          )}
          {mode === 'chapters' && (
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-ink-2">挂载到已有领域</span>
              <select value={parentId} onChange={(event) => setParentId(event.target.value)} className="lf-input">
                {roots.map((root) => (
                  <option key={root.id} value={root.id}>
                    {root.domainName && root.domainName !== root.name ? `${root.domainName} / ` : ''}{root.name}（{root.chapterCount} 章）
                  </option>
                ))}
              </select>
            </label>
          )}
          {!structureOnly && (
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-ink-2">文档（可选：从文档自动生成结构）</span>
              <input
                ref={fileRef}
                type="file"
                accept=".md,.markdown,.docx,.pptx"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setParsed(false);
                  setChapters([]);
                }}
                className="block w-full text-xs text-ink-muted file:mr-3 file:rounded-lg file:border-0 file:bg-brand-tint file:px-3 file:py-1.5 file:text-[11px] file:font-semibold file:text-brand"
              />
              <span className="mt-1 block text-[10.5px] text-ink-muted">
                支持 Markdown / Word(.docx) / PPT(.pptx)，单文件 ≤ 12MB；PDF 暂不支持
              </span>
            </label>
          )}
        </div>

        <div className="mt-3">
          {!parsed ? (
            <p className="rounded-xl bg-brand-tint/40 px-3 py-3 text-[11.5px] leading-5 text-ink-muted">
              {mode === 'domain'
                ? '建议上传「目录/大纲」：一级标题作为章、二级标题作为知识点。解析后可勾选、改名再入库。'
                : '建议上传「单章内容」：一级标题作为章名，下面的二三级标题作为知识点。解析后可勾选、改名再入库。'}
            </p>
          ) : chapters.length === 0 ? (
            <p className="rounded-xl bg-brand-tint/40 px-3 py-3 text-[11.5px] text-ink-muted">
              {structureOnly
                ? '还没有章。可以点右上角「添加章」开始搭建，也可以直接保存一个空的领域。'
                : '没有解析出章节结构，请确认文档标题使用了 Markdown 的 # / ## / ### 层级。'}
            </p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-ink-muted">
                  {structureOnly ? '手动结构' : title} · {chapters.filter((chapter) => chapter.enabled).length} 章 ·{' '}
                  {chapters.reduce((sum, chapter) => sum + (chapter.enabled ? chapter.points.filter((point) => point.enabled).length : 0), 0)} 个知识点
                </p>
                <button type="button" onClick={addChapter} className="lf-row-btn shrink-0">
                  <Plus size={11} />添加章
                </button>
              </div>
              {chapters.map((chapter, chapterIndex) => (
                <div key={chapterIndex} className="rounded-xl border border-white/70 bg-white/45 p-2.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={chapter.enabled}
                      onChange={(event) => setChapters((current) => current.map((item, index) => (
                        index === chapterIndex ? { ...item, enabled: event.target.checked } : item
                      )))}
                    />
                    <span className="shrink-0 rounded bg-brand-tint px-1.5 py-0.5 text-[10px] font-semibold text-brand">章</span>
                    <input
                      value={chapter.name}
                      onChange={(event) => setChapters((current) => current.map((item, index) => (
                        index === chapterIndex ? { ...item, name: event.target.value } : item
                      )))}
                      className="min-w-0 flex-1 rounded-md border border-hairline bg-white/70 px-2 py-1 text-xs font-semibold text-ink outline-none focus:border-brand/60"
                    />
                    <span className="shrink-0 text-[10.5px] text-ink-muted">{chapter.points.length} 点</span>
                    <button type="button" onClick={() => removeChapter(chapterIndex)} className="lf-row-btn !px-1.5 text-red-600" title="删除该章">
                      <Trash2 size={11} />
                    </button>
                  </div>
                  <div className="mt-1.5 space-y-1 pl-7">
                    {chapter.points.map((point, pointIndex) => (
                      <div key={pointIndex} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={point.enabled}
                            onChange={(event) => setChapters((current) => current.map((item, index) => (
                              index === chapterIndex
                                ? { ...item, points: item.points.map((p, pi) => (pi === pointIndex ? { ...p, enabled: event.target.checked } : p)) }
                                : item
                            )))}
                          />
                          <input
                            value={point.name}
                            onChange={(event) => setChapters((current) => current.map((item, index) => (
                              index === chapterIndex
                                ? { ...item, points: item.points.map((p, pi) => (pi === pointIndex ? { ...p, name: event.target.value } : p)) }
                                : item
                            )))}
                            className="min-w-0 flex-1 rounded-md border border-hairline bg-white/60 px-2 py-1 text-[11.5px] text-ink-2 outline-none focus:border-brand/60"
                          />
                          <button type="button" onClick={() => removePoint(chapterIndex, pointIndex)} className="lf-row-btn !px-1.5 text-red-600" title="删除该知识点">
                            <X size={11} />
                          </button>
                        </div>
                      ))}
                      <button type="button" onClick={() => addPoint(chapterIndex)} className="lf-row-btn">
                        <Plus size={10} />添加知识点
                      </button>
                    </div>
                </div>
              ))}
            </div>
          )}
        </div>

          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline px-6 py-4">
          {!structureOnly && (
            <button type="button" disabled={busy || !file} onClick={() => void parseFile()} className="lf-row-btn">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {parsed ? '重新解析' : '解析文档'}
            </button>
          )}
          <button type="button" onClick={onClose} className="lf-row-btn">取消</button>
          <button
            type="button"
            disabled={busy || (!structureOnly && (!file || !parsed))}
            onClick={() => void submit()}
            className="lf-row-btn lf-row-btn-primary"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            {busy ? '处理中…' : (structureOnly ? '创建结构' : '确认入库')}
          </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 目录节点编辑器。
 * 插入：在目标节点下新增「下一章」或「下一个知识点」。
 * 修改：改名称 / 类型；知识点还可以直接粘贴 Markdown 作为内容（切片后挂到该节点）。
 */
function CategoryEditorModal({ target, domainCode, onClose, onDone }: {
  target: { node: RagTreeNode; mode: 'insert' | 'edit' } | null;
  domainCode: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [nodeType, setNodeType] = useState<'chapter' | 'point'>('point');
  const [name, setName] = useState('');
  const [md, setMd] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!target) return;
    const defaultType = target.mode === 'edit'
      ? (target.node.level < 3 ? 'chapter' : 'point')
      : (target.node.level <= 1 ? 'chapter' : 'point');
    setNodeType(defaultType);
    setName(target.mode === 'edit' ? target.node.name : '');
    setMd('');
    setFile(null);
    setBusy(false);
    setError('');
  }, [target]);

  if (!target) return null;

  const isEdit = target.mode === 'edit';
  const levelText = target.node.level === 2 ? '章' : target.node.level >= 3 ? '知识点' : '领域';

  const submit = async () => {
    const value = name.trim();
    if (!value || busy) return;
    setBusy(true);
    setError('');
    try {
      let nodeCode = target.node.nodeCode;
      if (isEdit) {
        await api.updateKnowledgeCategory(domainCode, target.node.nodeCode, { name: value, nodeType });
      } else {
        const created = await api.createKnowledgeCategory(domainCode, {
          parentNodeCode: target.node.nodeCode,
          name: value,
          nodeType,
        });
        nodeCode = created.nodeCode;
      }
      /* 知识点内容：粘贴的 Markdown 优先，其次才是选择的文件 */
      if (nodeType === 'point') {
        if (md.trim().length > 0) {
          await api.importKnowledgeDocument({
            mode: 'point',
            domainCode,
            nodeCode,
            fileName: `${value.replace(/[\\/:*?"<>|]/g, '_')}.md`,
            dataBase64: textToBase64(md),
          });
        } else if (file) {
          await api.importKnowledgeDocument({
            mode: 'point',
            domainCode,
            nodeCode,
            fileName: file.name,
            dataBase64: await fileToBase64(file),
          });
        }
      }
      toast.success(isEdit
        ? '已保存修改'
        : `已新增${nodeType === 'chapter' ? '章' : '知识点'}「${value}」`);
      onDone();
    } catch (e) {
      const message = e instanceof Error ? e.message : '保存失败，请重试';
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-ink/40 p-4">
      <div className="w-full max-w-lg overflow-hidden rounded-3xl border border-hairline bg-paper shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-hairline px-6 py-4">
          <div>
            <h3 className="text-sm font-bold text-ink">
              {isEdit ? '修改目录节点' : '插入目录节点'}
            </h3>
            <p className="mt-0.5 text-[11px] text-ink-muted">
              {isEdit ? `当前：${levelText}「${target.node.name}」` : `在${levelText}「${target.node.name}」下新增`}
            </p>
          </div>
          <button onClick={onClose} className="lf-row-btn !p-2" aria-label="关闭">
            <X size={15} />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-6 py-4">
          <span className="mb-1 block text-[11px] font-semibold text-ink-2">类型</span>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setNodeType('chapter')}
              className={cn(
                'rounded-full border px-3 py-1 text-[11.5px] transition-colors',
                nodeType === 'chapter' ? 'border-brand bg-brand text-paper' : 'border-hairline bg-paper text-ink-2 hover:border-brand/50',
              )}
            >
              章
            </button>
            <button
              type="button"
              onClick={() => setNodeType('point')}
              className={cn(
                'rounded-full border px-3 py-1 text-[11.5px] transition-colors',
                nodeType === 'point' ? 'border-brand bg-brand text-paper' : 'border-hairline bg-paper text-ink-2 hover:border-brand/50',
              )}
            >
              知识点
            </button>
          </div>
          <p className="mt-1.5 text-[10.5px] leading-4 text-ink-muted">
            {nodeType === 'chapter'
              ? '章会作为同级下一章，挂在领域根下。'
              : isEdit ? '知识点挂在所属章下。' : '知识点会挂到当前章下；从知识点插入时作为同级下一个知识点。'}
          </p>
          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] font-semibold text-ink-2">名称</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => { setName(event.target.value); if (error) setError(''); }}
              onKeyDown={(event) => { if (event.key === 'Enter' && nodeType === 'chapter') void submit(); }}
              placeholder={nodeType === 'chapter' ? '例如：Agent 进阶' : '例如：Agent 的记忆机制'}
              className="lf-input"
            />
          </label>
          {nodeType === 'point' && (
            <>
              <label className="mt-3 block">
                <span className="mb-1 block text-[11px] font-semibold text-ink-2">知识点内容（Markdown，可选）</span>
                <textarea
                  value={md}
                  onChange={(event) => { setMd(event.target.value); if (file) setFile(null); }}
                  rows={6}
                  placeholder={'# 标题\n\n直接粘贴 Markdown，保存后会自动切片并挂到该知识点。'}
                  className="lf-input min-h-[140px] resize-y font-mono text-[11.5px]"
                />
              </label>
              <label className="mt-3 block">
                <span className="mb-1 block text-[11px] font-semibold text-ink-2">或上传文件</span>
                <input
                  type="file"
                  accept=".md,.markdown,.docx,.pptx"
                  onChange={(event) => { setFile(event.target.files?.[0] ?? null); if (event.target.files?.[0]) setMd(''); }}
                  className="block w-full text-xs text-ink-muted file:mr-3 file:rounded-lg file:border-0 file:bg-brand-tint file:px-3 file:py-1.5 file:text-[11px] file:font-semibold file:text-brand"
                />
                <span className="mt-1 block text-[10.5px] text-ink-muted">支持 Markdown / Word(.docx) / PPT(.pptx)，单文件 ≤ 12MB</span>
              </label>
            </>
          )}
          {error && <p className="mt-2 text-[11px] text-brand-danger">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-hairline px-6 py-3.5">
          <button onClick={onClose} className="lf-row-btn">取消</button>
          <button onClick={() => void submit()} disabled={busy || !name.trim()} className="lf-row-btn lf-row-btn-primary disabled:opacity-50">
            {busy ? <Loader2 className="animate-spin" size={13} /> : isEdit ? <Pencil size={13} /> : <Plus size={13} />}
            {busy ? '保存中…' : isEdit ? '保存修改' : '插入'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 章节 / 知识点内补充内容：整份文档切片后全部挂到该节点 */
function NodeContentUploadModal({ node, domainCode, onClose, onDone }: {
  node: RagTreeNode | null;
  domainCode: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<'idle' | 'parsing' | 'uploading'>('idle');

  useEffect(() => {
    setFile(null);
    setBusy(false);
    setStage('idle');
  }, [node?.nodeCode]);

  if (!node) return null;

  /* 章节点上传时先自动解析出知识点，避免“只挂文件、没有知识点目录” */
  const canParse = node.level === 2;
  const existingNames = new Set((node.children ?? []).map((child) => child.name.trim()));

  const parsePoints = async (dataBase64: string, fileName: string) => {
    const outline = await api.parseKnowledgeDocument({ fileName, dataBase64, scope: 'points' });
    const points: Array<{ name: string; description: string }> = [];
    const seen = new Set<string>();
    const push = (name: string, description: string) => {
      const value = (name || '').trim();
      if (!value || seen.has(value) || existingNames.has(value)) return;
      seen.add(value);
      points.push({ name: value.slice(0, 120), description: description || '' });
    };
    if (outline.chapters.length) {
      outline.chapters.forEach((chapter) => {
        push(chapter.name, chapter.description);
        chapter.points.forEach((point) => push(point.name, point.description));
      });
    } else {
      push(outline.title || fileName.replace(/\.[^.]+$/, ''), '');
    }
    return points;
  };

  const submit = async () => {
    if (!file) {
      toast.error('请选择文件');
      return;
    }
    setBusy(true);
    try {
      const dataBase64 = await fileToBase64(file);
      let points: Array<{ name: string; description: string }> = [];
      if (canParse) {
        setStage('parsing');
        try {
          points = await parsePoints(dataBase64, file.name);
        } catch {
          toast.warning('自动解析失败，将按整篇挂到当前章节');
        }
      }
      setStage('uploading');
      if (canParse && points.length) {
        const result = await api.importKnowledgeDocument({
          mode: 'points',
          domainCode,
          nodeCode: node.nodeCode,
          fileName: file.name,
          dataBase64,
          chapters: [{ name: node.name, description: '', points }],
        });
        toast.success(`已生成 ${points.length} 个知识点，挂载 ${result.chunkCount} 条切片`);
      } else {
        const result = await api.importKnowledgeDocument({
          mode: 'point',
          domainCode,
          nodeCode: node.nodeCode,
          fileName: file.name,
          dataBase64,
        });
        toast.success(`已补充：${result.chunkCount} 条切片，绑定 ${result.boundChunks} 条`);
        if (canParse) toast.warning('未解析出新的知识点，已按整篇挂到当前章节');
      }
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '内容入库失败');
    } finally {
      setBusy(false);
      setStage('idle');
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-ink/40 p-4">
      <div className="w-full max-w-lg overflow-hidden rounded-3xl border border-hairline bg-paper shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-hairline px-6 py-4">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-tint text-brand">
              <Upload size={16} />
            </span>
            <div>
              <h3 className="text-sm font-bold text-ink">上传内容到「{node.name}」</h3>
              <p className="mt-0.5 text-[11px] text-ink-muted">
                {canParse
                  ? '上传后会自动解析文档并生成知识点，再整篇挂到当前章节'
                  : `文档会规范化并切片，全部挂到当前${node.level === 3 ? '知识点' : '章节'}下`}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="lf-row-btn !p-2" aria-label="关闭">
            <X size={15} />
          </button>
        </div>
        <label className="block px-6 py-4">
          <span className="mb-1 block text-[11px] font-semibold text-ink-2">文档</span>
          <input
            type="file"
            accept=".md,.markdown,.docx,.pptx"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="block w-full text-xs text-ink-muted file:mr-3 file:rounded-lg file:border-0 file:bg-brand-tint file:px-3 file:py-1.5 file:text-[11px] file:font-semibold file:text-brand"
          />
          <span className="mt-1 block text-[10.5px] text-ink-muted">
            支持 Markdown / Word(.docx) / PPT(.pptx)，单文件 ≤ 12MB；PDF 暂不支持
          </span>
        </label>
        <div className="flex justify-end gap-2 border-t border-hairline px-6 py-4">
          <button type="button" onClick={onClose} className="lf-row-btn">取消</button>
          <button type="button" disabled={busy || !file} onClick={() => void submit()} className="lf-row-btn lf-row-btn-primary">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
            {busy ? (stage === 'parsing' ? '解析中…' : '入库中…') : (canParse ? '上传并生成知识点' : '上传并挂载')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 文本 → base64（UTF-8，分段转换避免超长参数） */
function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 本地文件 → base64（去掉 data URL 前缀） */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

const activeGenerationStatuses = new Set(['queued', 'retrieving', 'planning', 'analyzing', 'generating', 'verifying', 'reviewing', 'revising', 'judging', 'outline_review']);

function PreGenerationModal({ open, domainName, nodeName, groupName, selected, busy, onClose, onToggle, onSelectAll, onSubmit }: {

  open: boolean;
  domainName: string;
  nodeName: string;
  groupName: string;
  selected: Set<ResourceKind>;
  busy: boolean;
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
            return <button type="button" key={id} onClick={() => onToggle(id)} className={cn('rounded-2xl border p-3 text-left transition-all', selected.has(id) ? 'border-brand/50 bg-brand-tint/70 ring-1 ring-brand/30' : 'border-white/80 bg-white/45 hover:bg-white/70')}><div className="flex items-center justify-between"><Icon size={17} className={selected.has(id) ? 'text-brand' : 'text-ink-muted'} />{selected.has(id) && <CheckCircle2 size={15} className="text-brand" />}</div><p className="mt-3 text-sm font-bold text-ink">{label}</p><p className="mt-1 text-[10px] text-ink-muted">{note}</p></button>;
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
          </button>
          <button
            type="button"
            onClick={() => setTab('finished')}
            className={cn('flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-bold transition-colors', tab === 'finished' ? 'bg-ink text-paper shadow-sm' : 'text-ink-2 hover:bg-white/70')}
          >
             已完成 / 已结束
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
