import { useEffect, useMemo, useState } from 'react';
import { useProfile } from '@/context/ProfileContext';
import { api } from '@/lib/api';
import { presentationApi } from '@/lib/presentationApi';
import type { LearnerAnalyticsProfile, JobTargetLevel, RagTree } from '@/lib/api';
import type { KnowledgePoint } from '@/data/knowledgePoints';
import {
} from '@/data/knowledgeGraph';
import type { GraphEdge, GraphNode } from '@/data/knowledgeGraph';
import type { PathNode } from '@/data/reportData';
import type { LearningResourceSummary, LearningTemplateResourceItem } from '@/lib/api';
import type { GeneratedResource } from '@/data/resources';
import {
  readLearnerAnalytics,
  writeLearnerAnalytics,
  bustLearnerAnalytics,
} from '@/lib/dataCache';

/* analytics 共享刷新：多实例只发一次请求（模块级防抖 + 飞行中合并），完成后广播给所有实例 */
const ANALYTICS_REFRESHED_EVENT = 'lf:analytics-refreshed';
let analyticsRefreshTimer: number | null = null;
let analyticsRefreshInFlight = false;

function scheduleAnalyticsRefresh(learnerId: string): void {
  if (analyticsRefreshTimer !== null) window.clearTimeout(analyticsRefreshTimer);
  analyticsRefreshTimer = window.setTimeout(() => {
    analyticsRefreshTimer = null;
    if (analyticsRefreshInFlight) return;
    analyticsRefreshInFlight = true;
    void api.getLearnerAnalyticsProfile()
      .then((fresh) => {
        writeLearnerAnalytics(learnerId, fresh);
        try {
          window.dispatchEvent(new CustomEvent(ANALYTICS_REFRESHED_EVENT, { detail: { learnerId, analytics: fresh } }));
        } catch {
          /* ignore */
        }
      })
      .catch(() => undefined)
      .finally(() => { analyticsRefreshInFlight = false; });
  }, 1500);
}
import type { PresentationTaskSummary } from '@/lib/presentationApi';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// v6: 缓存只允许保存当前机构母版资源；v5 可能被个人资源刷新事件污染。
const CACHE_PREFIX = 'lf.learningMapCache:v7:';
const RESOURCE_CACHE_UPDATED_EVENT = 'lf:learning-map-resources-updated';
const PRESENTATION_CACHE_UPDATED_EVENT = 'lf:learning-map-presentations-updated';
const PPT_PROGRESS_CACHE_UPDATED_EVENT = 'lf:learning-map-ppt-progress-updated';

interface LearningMapCache {
  resources: LearningResourceSummary[];
  tree: RagTree;
  presentations?: PresentationTaskSummary[];
  pptProgress?: Record<string, number>;
}

function readLearningMapCache(learnerId: string): LearningMapCache | null {
  try {
    const raw = window.localStorage.getItem(`${CACHE_PREFIX}${learnerId}`);
    return raw ? JSON.parse(raw) as LearningMapCache : null;
  } catch {
    return null;
  }
}

function writeLearningMapCache(learnerId: string, cache: LearningMapCache) {
  try {
    window.localStorage.setItem(`${CACHE_PREFIX}${learnerId}`, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
}

function toTemplateResource(item: LearningTemplateResourceItem): LearningResourceSummary {
  return {
    id: item.id,
    type: item.type as LearningResourceSummary['type'],
    title: item.title,
    topic: item.topic,
    courseId: null,
    chapterId: null,
    sources: [],
    learnerId: null,
    kpId: item.nodeCode,
    learned: false,
    started: false,
    progressRatio: 0,
    masteryRatio: 0,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function toTemplatePresentation(item: LearningTemplateResourceItem): PresentationTaskSummary {
  return {
    id: item.id,
    status: 'completed',
    progress: 100,
    stageMessage: '机构母版课件',
    title: item.title,
    request: {
      requirement: item.topic,
      title: item.title,
      audience: 'students',
      purpose: 'courseware',
      style: 'education',
      backgroundStyle: 'clean-minimal',
      language: 'zh-CN',
      slideCount: 0,
      aspectRatio: '16:9',
      detailLevel: 'detailed',
      includeSpeakerNotes: true,
      modelProvider: 'mimo',
      generationContext: { kpId: item.nodeCode, topicName: item.topic, groupName: item.groupName },
    },
    learned: false,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

type UserPptLike = PresentationTaskSummary & {
  learnedMeta?: {
    learned?: boolean;
    maxPageViewed?: number;
    pageCount?: number;
    learnedAt?: string;
    updatedAt?: string;
  };
};

async function fetchPptProgressByKp(): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  try {
    const result = await presentationApi.listPresentationSummariesFresh(300, true);
    for (const raw of result.tasks ?? []) {
      const task = raw as UserPptLike;
      if (task.status !== 'completed') continue;
      const kpId = String(task.request?.generationContext?.kpId ?? '');
      if (!kpId) continue;
      const meta = task.learnedMeta ?? {};
      const pageCount = Number(meta.pageCount ?? 0);
      const maxPageViewed = Number(meta.maxPageViewed ?? 0);
      const ratio = task.learned || meta.learned || (pageCount > 0 && maxPageViewed >= pageCount)
        ? 1
        : pageCount > 0
          ? Math.min(1, maxPageViewed / pageCount)
          : 0;
      map[kpId] = Math.max(map[kpId] ?? 0, ratio);
    }
  } catch {
    /* 拉取不到个人 PPT 进度时不阻塞知识网络 */
  }
  return map;
}

async function fetchLearningTemplateCatalog(): Promise<{
  resources: LearningResourceSummary[];
  presentations: PresentationTaskSummary[];
}> {
  const listed = await api.listLearningTemplateResources('agent');
  const items = (listed.items ?? []).filter((item) => item.nodeCode);
  return {
    resources: items.filter((item) => item.type !== 'ppt').map(toTemplateResource),
    presentations: items.filter((item) => item.type === 'ppt').map(toTemplatePresentation),
  };
}

/** 母版发生变化后刷新知识网络目录；个人资源绝不写入该缓存。 */
export async function refreshLearningMapResourceCache(learnerId: string): Promise<void> {
  const cache = readLearningMapCache(learnerId);
  try {
    const [catalog, tree, pptProgress] = await Promise.all([
      fetchLearningTemplateCatalog(),
      cache?.tree ? Promise.resolve(cache.tree) : api.getRagTree('agent'),
      fetchPptProgressByKp(),
    ]);
    writeLearningMapCache(learnerId, { ...catalog, tree, pptProgress });
    window.dispatchEvent(new CustomEvent(RESOURCE_CACHE_UPDATED_EVENT, { detail: { learnerId, resources: catalog.resources } }));
    window.dispatchEvent(new CustomEvent(PRESENTATION_CACHE_UPDATED_EVENT, { detail: { learnerId, presentations: catalog.presentations } }));
    window.dispatchEvent(new CustomEvent(PPT_PROGRESS_CACHE_UPDATED_EVENT, { detail: { learnerId, pptProgress } }));
  } catch {
    /* 刷新失败时保留原缓存 */
  }
}

/** 课件母版变化与学习资源母版使用同一只读目录，避免个人 PPT 污染知识网络。 */
export async function refreshLearningMapPresentationCache(learnerId: string): Promise<void> {
  await refreshLearningMapResourceCache(learnerId);
}


export interface LearningMapView {
  loading: boolean;
  domains: KnowledgePoint[];
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  path: PathNode[];
  mastery: Record<string, number>;
  chapterProgress: Record<string, number>;
  confidence: Record<string, number>;
  topicMastery: Record<string, number>;
  /** 已学掌握率（未乘进度），用于目标门槛判断 */
  topicMasteryRaw: Record<string, number>;
  topicProgress: Record<string, number>;
  learned: Set<string>;
  status: Record<string, string>;
  activeKp: string | null;
  resources: Record<string, Array<GeneratedResource & { id: string; learned?: boolean; started?: boolean; progressRatio?: number; masteryRatio?: number }>>;
  presentations: PresentationTaskSummary[];
  goalId: string | null;
  /** 目标岗位门槛：nodeCode → { target, name }（知识点继承所属章节） */
  nodeTargets: Record<string, { target: number; name?: string }>;
  jobName?: string;
}

/**
 * 按最长前置路径给 DAG 分层，再用相邻层重心调整同层顺序。
 * 目标是让先修关系整体从左向右流动，并减少同层节点造成的交叉边。
 */
function layoutChapterDag(chapters: RagTree['nodes'][number][], edges: RagTree['edges']): Map<string, { x: number; y: number }> {
  const codes = new Set(chapters.map((chapter) => chapter.nodeCode));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  chapters.forEach((chapter) => {
    incoming.set(chapter.nodeCode, []);
    outgoing.set(chapter.nodeCode, []);
  });
  edges.forEach((edge) => {
    if (!codes.has(edge.from) || !codes.has(edge.to)) return;
    outgoing.get(edge.from)!.push(edge.to);
    incoming.get(edge.to)!.push(edge.from);
  });

  const layer = new Map<string, number>();
  const indegree = new Map(chapters.map((chapter) => [chapter.nodeCode, incoming.get(chapter.nodeCode)!.length]));
  const queue = chapters.filter((chapter) => indegree.get(chapter.nodeCode) === 0).map((chapter) => chapter.nodeCode);
  queue.forEach((code) => layer.set(code, 0));
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const from = queue[cursor];
    outgoing.get(from)!.forEach((to) => {
      layer.set(to, Math.max(layer.get(to) ?? 0, (layer.get(from) ?? 0) + 1));
      indegree.set(to, (indegree.get(to) ?? 1) - 1);
      if (indegree.get(to) === 0) queue.push(to);
    });
  }
  // 防御异常数据：若出现环，未参与拓扑排序的节点放到最后一层。
  const resolvedMax = Math.max(0, ...layer.values());
  chapters.forEach((chapter) => {
    if (!layer.has(chapter.nodeCode)) layer.set(chapter.nodeCode, resolvedMax + 1);
  });

  const maxLayer = Math.max(0, ...layer.values());
  const groups = Array.from({ length: maxLayer + 1 }, () => [] as string[]);
  chapters.forEach((chapter) => groups[layer.get(chapter.nodeCode)!].push(chapter.nodeCode));
  const order = new Map<string, number>();
  const sourceIndex = new Map(chapters.map((chapter, index) => [chapter.nodeCode, index]));
  const resetOrder = () => groups.forEach((group) => group.forEach((code, index) => order.set(code, index)));
  const sortByNeighbours = (group: string[], neighboursOf: (code: string) => string[]) => {
    group.sort((a, b) => {
      const barycenter = (code: string) => {
        const neighbours = neighboursOf(code).filter((item) => order.has(item));
        return neighbours.length
          ? neighbours.reduce((sum, item) => sum + order.get(item)!, 0) / neighbours.length
          : sourceIndex.get(code) ?? 0;
      };
      return barycenter(a) - barycenter(b) || (sourceIndex.get(a) ?? 0) - (sourceIndex.get(b) ?? 0);
    });
  };
  resetOrder();
  // Sugiyama 风格的多轮重心扫描：正向贴近前置节点，反向贴近后继节点。
  for (let sweep = 0; sweep < 6; sweep += 1) {
    for (let level = 1; level < groups.length; level += 1) {
      sortByNeighbours(groups[level], (code) => incoming.get(code) ?? []);
      resetOrder();
    }
    for (let level = groups.length - 2; level >= 0; level -= 1) {
      sortByNeighbours(groups[level], (code) => outgoing.get(code) ?? []);
      resetOrder();
    }
  }

  const positions = new Map<string, { x: number; y: number }>();
  groups.forEach((group, level) => {
    const x = maxLayer === 0 ? 460 : 65 + (level * 790) / maxLayer;
    group.forEach((code, index) => {
      // 各层从顶部开始排列，主学习链稳定贴近左上角，分支向下展开。
      const spacing = group.length <= 1 ? 0 : Math.min(112, 330 / (group.length - 1));
      const y = 62 + index * spacing;
      positions.set(code, { x, y });
    });
  });
  return positions;
}

function shortChapterLabel(name: string): string {
  return name
    .replace(/^第[一二三四五六七八九十]+章\s*/, '')
    .replace('智能体经典范式构建', '经典范式构建')
    .replace('低代码平台智能体搭建', '低代码平台搭建')
    .replace('主流Agent框架实践', 'Agent框架实践')
    .replace('自建HelloAgents框架', '自建Agents框架')
    .replace('HelloAgents', '自建Agents')
    .replace('智能体通信协议', '通信协议')
    .replace('智能体性能评估', '性能评估')
    .replace('自动化深度研究智能体', '深度研究智能体');
}

export function useLearningMap(options?: { deferNetwork?: boolean }): LearningMapView {
  const { currentLearnerId, currentLearner } = useProfile();
  const deferNetwork = options?.deferNetwork === true;
  const [loading, setLoading] = useState(true);
  const [resources, setResources] = useState<LearningResourceSummary[]>(() => readLearningMapCache(currentLearnerId)?.resources ?? []);
  const [tree, setTree] = useState<RagTree | null>(() => readLearningMapCache(currentLearnerId)?.tree ?? null);
  const [analytics, setAnalytics] = useState<LearnerAnalyticsProfile | null>(null);
  const [presentations, setPresentations] = useState<PresentationTaskSummary[]>(
    () => readLearningMapCache(currentLearnerId)?.presentations ?? [],
  );
  const [pptProgressByKp, setPptProgressByKp] = useState<Record<string, number>>(
    () => readLearningMapCache(currentLearnerId)?.pptProgress ?? {},
  );
  const [jobTargets, setJobTargets] = useState<JobTargetLevel[]>([]);

  /* 目标岗位门槛：随画像目标岗位加载（岗位名 → target_options 的 code） */
  useEffect(() => {
    const job = currentLearner.targetJob;
    if (!job) { setJobTargets([]); return; }
    let cancelled = false;
    void (async () => {
      let jobCode = job;
      if (!job.startsWith('job-')) {
        try {
          const meta = await api.getOnboardingMeta();
          const option = meta.targetOptions.find((o) => o.name === job);
          jobCode = option?.code ?? job;
        } catch { /* 保留名称原样 */ }
      }
      const list = await api.getJobTargets(jobCode).catch(() => []);
      if (!cancelled) setJobTargets(list);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLearner.targetJob]);

  useEffect(() => {
    const syncResources = (event: Event) => {
      const detail = (event as CustomEvent<{ learnerId?: string; resources?: LearningResourceSummary[] }>).detail;
      if (detail?.learnerId === currentLearnerId && Array.isArray(detail.resources)) {
        setResources(detail.resources);
      }
    };
    window.addEventListener(RESOURCE_CACHE_UPDATED_EVENT, syncResources);
    return () => window.removeEventListener(RESOURCE_CACHE_UPDATED_EVENT, syncResources);
  }, [currentLearnerId]);

  useEffect(() => {
    const syncPresentations = (event: Event) => {
      const detail = (event as CustomEvent<{ learnerId?: string; presentations?: PresentationTaskSummary[] }>).detail;
      if (detail?.learnerId === currentLearnerId && Array.isArray(detail.presentations)) setPresentations(detail.presentations);
    };
    window.addEventListener(PRESENTATION_CACHE_UPDATED_EVENT, syncPresentations);
    return () => window.removeEventListener(PRESENTATION_CACHE_UPDATED_EVENT, syncPresentations);
  }, [currentLearnerId]);

  useEffect(() => {
    const syncPptProgress = (event: Event) => {
      const detail = (event as CustomEvent<{ learnerId?: string; pptProgress?: Record<string, number> }>).detail;
      if (detail?.learnerId === currentLearnerId && detail.pptProgress) setPptProgressByKp(detail.pptProgress);
    };
    window.addEventListener(PPT_PROGRESS_CACHE_UPDATED_EVENT, syncPptProgress);
    return () => window.removeEventListener(PPT_PROGRESS_CACHE_UPDATED_EVENT, syncPptProgress);
  }, [currentLearnerId]);

  useEffect(() => {
    // 共用资源与知识网络不依赖 learner：游客/新账号尚未建档时也要能加载。
    // 仅当没有 learnerId 时跳过个人 analytics 与缓存（那些按 learner 隔离）。
    const hasLearner = UUID_PATTERN.test(currentLearnerId);
    let cancelled = false;
    setLoading(true);
    const cached = hasLearner ? readLearningMapCache(currentLearnerId) : null;
    if (cached) {
      setResources(cached.resources);
      setTree(cached.tree);
      if (cached.presentations) setPresentations(cached.presentations);
      if (cached.pptProgress) setPptProgressByKp(cached.pptProgress);
    }
    /* analytics 缓存优先：新鲜（≤3min）直接首屏回显并跳过重复请求 */
    const cachedAnalytics = hasLearner ? readLearnerAnalytics(currentLearnerId) : null;
    if (cachedAnalytics) setAnalytics(cachedAnalytics);
    if (deferNetwork) {
      /* 全局轻量场景（伴学助手等）：只回显缓存、不触发任何网络校准；进入地图/首页等页面会正常校准 */
      setLoading(false);
      return () => { cancelled = true; };
    }
    // 知识网络只校准当前机构母版目录；接口失败时仅保留 v6 母版缓存，绝不回退个人资源。
    const templateCatalogPromise = fetchLearningTemplateCatalog().catch(() => ({
      resources: cached?.resources ?? [],
      presentations: cached?.presentations ?? [],
    }));
    const userResourcesPromise = hasLearner
      ? api.listLearningResources().catch(() => ({ resources: [] }))
      : Promise.resolve({ resources: [] });
    const pptProgressPromise = hasLearner
      ? fetchPptProgressByKp()
      : Promise.resolve({});
    /* 学习行为（lf-signal）会置脏并防抖刷新，保证实时性 */
    const analyticsPromise = hasLearner
      ? (cachedAnalytics ? Promise.resolve(null) : api.getLearnerAnalyticsProfile().catch(() => null))
      : Promise.resolve(null);
    Promise.all([api.getRagTree('agent'), analyticsPromise, templateCatalogPromise, userResourcesPromise, pptProgressPromise])
      .then(([latestTree, latestAnalytics, templateCatalog, userRes, pptProgress]) => {
        if (!cancelled) setTree(latestTree);
        if (!cancelled) setAnalytics(latestAnalytics ?? cachedAnalytics);
        if (!cancelled) setPresentations(templateCatalog.presentations);
        if (!cancelled) setPptProgressByKp(pptProgress);
        // Merge user customized copy state into template resources
        const userStateMap = new Map<string, { learned: boolean; started: boolean; progressRatio: number; masteryRatio: number }>();
        for (const ur of (userRes.resources ?? [])) {
          if (!ur.kpId || !ur.type) continue;
          const key = `${ur.kpId}::${ur.type}`;
          const prev = userStateMap.get(key);
          if (!prev || (ur.learned ? 1 : 0) > (prev.learned ? 1 : 0)) {
            userStateMap.set(key, { learned: ur.learned ?? false, started: ur.started ?? false, progressRatio: ur.progressRatio ?? (ur.learned ? 1 : 0), masteryRatio: ur.masteryRatio ?? 0 });
          }
        }
        const mergedResources = templateCatalog.resources.map((tr) => {
          const userState = tr.kpId ? userStateMap.get(`${tr.kpId}::${tr.type}`) : undefined;
          return userState ? { ...tr, ...userState } : tr;
        });
        if (!cancelled) setResources(mergedResources);
        if (hasLearner && !cancelled) {
          writeLearningMapCache(currentLearnerId, { resources: mergedResources, presentations: templateCatalog.presentations, tree: latestTree, pptProgress });
          if (latestAnalytics) writeLearnerAnalytics(currentLearnerId, latestAnalytics);
        }
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentLearnerId, deferNetwork]);

  /* 学习行为实时失效：信号/资源变更/资源播放器状态变更 → analytics 置脏 + 共享防抖刷新；
     刷新完成后广播，本页所有实例同步更新 */
  useEffect(() => {
    const learnerId = currentLearnerId;
    const valid = Boolean(learnerId && UUID_PATTERN.test(learnerId));
    const onDirty = () => {
      if (!valid) return;
      bustLearnerAnalytics(learnerId);
      scheduleAnalyticsRefresh(learnerId);
    };
    const onRefreshed = (event: Event) => {
      const detail = (event as CustomEvent<{ learnerId: string; analytics: LearnerAnalyticsProfile }>).detail;
      if (detail && detail.learnerId === learnerId && detail.analytics) setAnalytics(detail.analytics);
    };
    window.addEventListener('lf-signal', onDirty);
    window.addEventListener('lf:learning-state-changed', onDirty);
    window.addEventListener(RESOURCE_CACHE_UPDATED_EVENT, onDirty);
    window.addEventListener(ANALYTICS_REFRESHED_EVENT, onRefreshed);
    return () => {
      window.removeEventListener('lf-signal', onDirty);
      window.removeEventListener('lf:learning-state-changed', onDirty);
      window.removeEventListener(RESOURCE_CACHE_UPDATED_EVENT, onDirty);
      window.removeEventListener(ANALYTICS_REFRESHED_EVENT, onRefreshed);
    };
  }, [currentLearnerId]);

  /* 定制任务完成 → 立即重新校准知识网络（资源状态从"未定制"变为"打开"） */
  useEffect(() => {
    if (deferNetwork) return;
    let cancelled = false;
    const refreshCatalog = async () => {
      try {
        const [templateCatalog, pptProgress] = await Promise.all([
          fetchLearningTemplateCatalog(),
          fetchPptProgressByKp(),
        ]);
        if (cancelled) return;
        setResources(templateCatalog.resources);
        setPresentations(templateCatalog.presentations);
        setPptProgressByKp(pptProgress);
        if (UUID_PATTERN.test(currentLearnerId) && tree) {
          writeLearningMapCache(currentLearnerId, { ...templateCatalog, tree, pptProgress });
        }
      } catch { /* 校准失败保留现状 */ }
    };
    window.addEventListener('lf:customize-completed', refreshCatalog);
    return () => { cancelled = true; window.removeEventListener('lf:customize-completed', refreshCatalog); };
  }, [currentLearnerId, deferNetwork, tree]);

  return useMemo<LearningMapView>(() => {
    if (!tree) {
      return {
        loading,
        domains: [],
        graphNodes: [],
        graphEdges: [],
        path: [],
        mastery: {},
        chapterProgress: {},
        confidence: {},
        topicMastery: {},
        topicMasteryRaw: {},
        topicProgress: {},
        learned: new Set<string>(),
        status: {},
        activeKp: null,
        resources: {},
        presentations: [],
        goalId: null,
        nodeTargets: {},
        jobName: currentLearner.targetJob || undefined,
      };
    }

    // 一级目录仅用于数据库归档；知识网络从二级章节开始建图。
    const byDatabaseOrder = <T extends { sortOrder: number; id: number }>(items: T[]) =>
      [...items].sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id);
    // L2 章节 → L1 父节点名称映射
    const parentNameMap = new Map<string, string>();
    for (const root of byDatabaseOrder(tree.nodes)) {
      if (root.level !== 1) continue;
      for (const child of byDatabaseOrder(root.children)) {
        if (child.level === 2) parentNameMap.set(child.nodeCode, root.name);
      }
    }
    const chapters = byDatabaseOrder(tree.nodes).flatMap((root) =>
      root.level === 2 ? [root] : byDatabaseOrder(root.children.filter((node) => node.level === 2)),
    );
    const domains: KnowledgePoint[] = chapters.map((chapter) => ({
      id: chapter.nodeCode,
      name: chapter.name,
      en: chapter.nodeCode.toUpperCase(),
      parentName: parentNameMap.get(chapter.nodeCode),
      weight: 1 / Math.max(1, chapters.length),
      targetLevel: 80,
      coverage: chapter.chunkCount ? 100 : 0,
      description: chapter.description ?? '',
      coreTopics: byDatabaseOrder(chapter.children.filter((node) => node.level === 3)).map((node) => node.name),
    }));

    const mastery: Record<string, number> = {};
    const chapterProgress: Record<string, number> = {};
    const confidence: Record<string, number> = {};
    const topicMastery: Record<string, number> = {};
    const topicMasteryRaw: Record<string, number> = {};
    const topicProgress: Record<string, number> = {};
    const status: Record<string, string> = {};
    const masteryByCategory = new Map((analytics?.mastery.categories ?? []).map((item) => [String(item.id), item]));
    chapters.forEach((chapter) => {
      const direct = masteryByCategory.get(String(chapter.id));
      const children = chapter.children.map((child) => masteryByCategory.get(String(child.id))).filter(Boolean);
      const samples = direct ? [direct] : children;
      const score = samples.length ? samples.reduce((sum, item) => sum + item!.score, 0) / samples.length : 0;
      const attempts = samples.reduce((sum, item) => sum + item!.attempts, 0);
      mastery[chapter.nodeCode] = Math.round(score * 100);
      confidence[chapter.nodeCode] = attempts > 0 ? Math.min(95, 40 + attempts * 5) : 0;
      status[chapter.nodeCode] = attempts > 0 ? 'active' : 'locked';
      byDatabaseOrder(chapter.children.filter((child) => child.level === 3)).forEach((child) => {
        const category = masteryByCategory.get(String(child.id));
        const childResources = resources.filter((resource) => resource.kpId === child.nodeCode);
        const progressByForm = new Map(childResources.map((resource) => [resource.type, resource.progressRatio ?? (resource.learned ? 1 : 0)]));
        const pptProgressRatio = pptProgressByKp[child.nodeCode] ?? 0;
        topicProgress[child.nodeCode] = Math.round((
          (progressByForm.get('lecture') ?? 0)
          + (progressByForm.get('practice') ?? 0)
          + (progressByForm.get('quiz') ?? 0)
          + pptProgressRatio
        ) / 4 * 100);
        const selfEvidence = childResources.filter((resource) => resource.type !== 'quiz' && resource.masteryRatio > 0);
        const quizEvidence = childResources.filter((resource) => resource.type === 'quiz' && resource.masteryRatio > 0);
        const weightedEvidence = [
          ...selfEvidence.map((resource) => ({ score: resource.masteryRatio, weight: resource.type === 'practice' ? 0.2 : 0.15 })),
          ...(pptProgressRatio > 0 ? [{ score: Math.min(1, pptProgressRatio), weight: 0.2 }] : []),
          ...quizEvidence.map((resource) => ({ score: resource.masteryRatio, weight: 0.45 })),
          ...(category && category.attempts > 0 ? [{ score: category.score, weight: 0.2 }] : []),
        ];
        const evidenceWeight = weightedEvidence.reduce((sum, item) => sum + item.weight, 0);
        const rawMastery = evidenceWeight
          ? Math.round(weightedEvidence.reduce((sum, item) => sum + item.score * item.weight, 0) / evidenceWeight * 100)
          : 0;
        topicMasteryRaw[child.nodeCode] = rawMastery;
        // 知识点展示掌握 = 进度 × 已学掌握率（保证掌握 ≤ 进度）
        topicMastery[child.nodeCode] = Math.round((topicProgress[child.nodeCode] ?? 0) / 100 * rawMastery);
      });
      const topicScores = chapter.children
        .filter((child) => child.level === 3)
        .map((child) => topicProgress[child.nodeCode] ?? 0);
      chapterProgress[chapter.nodeCode] = topicScores.length
        ? Math.round(topicScores.reduce((sum, value) => sum + value, 0) / topicScores.length)
        : 0;
      // 章节掌握 = 各知识点(进度 × 已学掌握率)之和 ÷ 全部知识点数；未学的计 0 但占分母，
      // 保证掌握 ≤ 进度，学完且全对才填满当前进度。
      const chapterTopics = chapter.children.filter((child) => child.level === 3);
      const topicFill = chapterTopics.map((child) =>
        (topicProgress[child.nodeCode] ?? 0) / 100 * (topicMasteryRaw[child.nodeCode] ?? 0) / 100);
      mastery[chapter.nodeCode] = topicFill.length
        ? Math.round(topicFill.reduce((sum, value) => sum + value, 0) / topicFill.length * 100)
        : 0;
    });

    const learned = new Set(chapters.filter((chapter) => (mastery[chapter.nodeCode] ?? 0) > 0).map((chapter) => chapter.nodeCode));
    const path: PathNode[] = chapters.map((chapter, index) => ({
      id: `${chapter.nodeCode}-path`,
      title: chapter.name,
      kpId: chapter.nodeCode,
      status: (status[chapter.nodeCode] === 'active' ? 'active' : index === 0 ? 'active' : 'locked') as PathNode['status'],
      est: `${Math.max(30, chapter.children.filter((child) => child.level === 3).length * 20)}分钟`,
      resourceRef: chapter.name,
    }));

    const chapterPositions = layoutChapterDag(chapters, tree.edges);
    const graphNodes: GraphNode[] = chapters.map((chapter) => {
      const { x, y } = chapterPositions.get(chapter.nodeCode) ?? { x: 460, y: 220 };
      return { id: chapter.nodeCode, kpId: chapter.nodeCode, kind: 'domain', label: shortChapterLabel(chapter.name), x, y, r: 25, labelX: x, labelY: y + 37, labelAnchor: 'middle' };
    });
    chapters.forEach((chapter) => {
      const parent = graphNodes.find((node) => node.id === chapter.nodeCode)!;
      const topics = byDatabaseOrder(chapter.children.filter((node) => node.level === 3));
      topics.forEach((topic, topicIndex) => {
        const angle = -Math.PI / 2 + (2 * Math.PI * topicIndex) / Math.max(1, topics.length);
        const tx = parent.x + Math.cos(angle) * 64;
        const ty = parent.y + Math.sin(angle) * 64;
        graphNodes.push({
          id: topic.nodeCode,
          kpId: chapter.nodeCode,
          kind: 'topic',
          label: topic.name,
          topicIndex,
          x: tx,
          y: ty,
          r: 10,
          labelX: tx,
          labelY: ty + (Math.sin(angle) >= 0 ? 22 : -16),
          labelAnchor: 'middle',
        });
      });
    });

    const graphEdges: GraphEdge[] = tree.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      note: edge.note ?? '',
    }));

    const resourceByKp: Record<string, Array<GeneratedResource & { id: string; learned?: boolean; started?: boolean; progressRatio?: number; masteryRatio?: number }>> = {};
    resources.forEach((resource) => {
      if (!resource.kpId) return;
      const list = resourceByKp[resource.kpId] ??= [];
      list.push({
        id: resource.id,
        learnerId: currentLearnerId,
        form: resource.type === 'practice' ? 'guide' : resource.type,
        title: resource.title,
        levelTag: resource.topic,
        kpId: resource.kpId,
        version: '',
        updatedAt: resource.updatedAt,
        learned: resource.learned,
        started: resource.started,
        progressRatio: resource.progressRatio,
        masteryRatio: resource.masteryRatio,
        kbRefs: [],
      });
    });

    const targetByCode = new Map(jobTargets.map((item) => [item.nodeCode, item]));
    const nodeTargets: Record<string, { target: number; name?: string }> = {};
    graphNodes.forEach((node) => {
      if (node.kind === 'domain') {
        // 章节门槛 = 该章全部知识点门槛的平均（与章节掌握同口径）
        const topicNodes = graphNodes.filter((n) => n.kind === 'topic' && n.kpId === node.id);
        const targets = topicNodes
          .map((n) => targetByCode.get(n.id)?.targetMastery)
          .filter((t): t is number => typeof t === 'number');
        const chapterHit = targetByCode.get(node.id);
        if (targets.length) {
          nodeTargets[node.id] = {
            target: Math.round(targets.reduce((sum, t) => sum + t, 0) / targets.length),
            name: chapterHit?.nodeName ?? undefined,
          };
        } else if (chapterHit) {
          nodeTargets[node.id] = { target: chapterHit.targetMastery, name: chapterHit.nodeName ?? undefined };
        }
      } else if (node.kind === 'topic') {
        // 知识点门槛 = 该知识点独立预设（job_target_levels 中的 kp-x 行）
        const hit = targetByCode.get(node.id);
        if (hit) nodeTargets[node.id] = { target: hit.targetMastery, name: hit.nodeName ?? undefined };
      }
    });

    return {
      loading,
      domains,
      graphNodes,
      graphEdges,
      path,
      mastery,
      chapterProgress,
      confidence,
      topicMastery,
      topicMasteryRaw,
      topicProgress,
      learned,
      status,
      activeKp: chapters.find((chapter) => status[chapter.nodeCode] === 'active')?.nodeCode ?? chapters[0]?.nodeCode ?? null,
      resources: resourceByKp,
      presentations,
      goalId: null,
      nodeTargets,
      jobName: currentLearner.targetJob || undefined,
    };
  }, [tree, analytics, presentations, pptProgressByKp, loading, currentLearner, resources, currentLearnerId, jobTargets]);
}
