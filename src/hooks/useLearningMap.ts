import { useEffect, useMemo, useState } from 'react';
import { useProfile } from '@/context/ProfileContext';
import { api } from '@/lib/api';
import type { LearnerAnalyticsProfile, RagTree } from '@/lib/api';
import type { KnowledgePoint } from '@/data/knowledgePoints';
import {
} from '@/data/knowledgeGraph';
import type { GraphEdge, GraphNode } from '@/data/knowledgeGraph';
import type { PathNode } from '@/data/reportData';
import type { LearningResourceSummary } from '@/lib/api';
import type { GeneratedResource } from '@/data/resources';
import { presentationApi } from '@/lib/presentationApi';
import type { PresentationTaskSummary } from '@/lib/presentationApi';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// v4: 地图结构完全来自 RAG knowledge_category，旧版 overview 不再参与缓存。
const CACHE_PREFIX = 'lf.learningMapCache:v4:';
const RESOURCE_CACHE_UPDATED_EVENT = 'lf:learning-map-resources-updated';
const PRESENTATION_CACHE_UPDATED_EVENT = 'lf:learning-map-presentations-updated';

interface LearningMapCache {
  resources: LearningResourceSummary[];
  tree: RagTree;
  presentations?: PresentationTaskSummary[];
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

/** 生成完成后刷新资源缓存：仅请求一次资源列表并写回，下次打开地图直接命中缓存、不再请求后端 */
export async function refreshLearningMapResourceCache(learnerId: string): Promise<void> {
  const cache = readLearningMapCache(learnerId);
  try {
    const [listed, tree] = await Promise.all([
      api.listLearningResources(),
      cache?.tree ? Promise.resolve(cache.tree) : api.getRagTree('agent'),
    ]);
    const resources = listed.resources ?? [];
    writeLearningMapCache(learnerId, { resources, tree, presentations: cache?.presentations });
    window.dispatchEvent(new CustomEvent(RESOURCE_CACHE_UPDATED_EVENT, { detail: { learnerId, resources } }));
  } catch {
    /* 刷新失败时保留原缓存 */
  }
}

/** PPT 生成后刷新课件缓存：请求一次课件任务列表并写回，供下次打开地图直接命中 */
export async function refreshLearningMapPresentationCache(learnerId: string): Promise<void> {
  const cache = readLearningMapCache(learnerId);
  if (!cache) return;
  try {
    const listed = await presentationApi.listPresentationSummaries(100);
    const presentations = listed.tasks ?? [];
    writeLearningMapCache(learnerId, { resources: cache.resources, tree: cache.tree, presentations });
    window.dispatchEvent(new CustomEvent(PRESENTATION_CACHE_UPDATED_EVENT, { detail: { learnerId, presentations } }));
  } catch {
    /* 刷新失败时保留原缓存 */
  }
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
  topicProgress: Record<string, number>;
  learned: Set<string>;
  status: Record<string, string>;
  activeKp: string | null;
  resources: Record<string, Array<GeneratedResource & { id: string; learned?: boolean; started?: boolean }>>;
  presentations: PresentationTaskSummary[];
  goalId: string | null;
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
    .replace('自建HelloAgents框架', 'HelloAgents框架')
    .replace('智能体通信协议', '通信协议')
    .replace('智能体性能评估', '性能评估')
    .replace('自动化深度研究智能体', '深度研究智能体');
}

export function useLearningMap(): LearningMapView {
  const { currentLearnerId, currentLearner } = useProfile();
  const [loading, setLoading] = useState(true);
  const [resources, setResources] = useState<LearningResourceSummary[]>(() => readLearningMapCache(currentLearnerId)?.resources ?? []);
  const [tree, setTree] = useState<RagTree | null>(() => readLearningMapCache(currentLearnerId)?.tree ?? null);
  const [analytics, setAnalytics] = useState<LearnerAnalyticsProfile | null>(null);
  const [presentations, setPresentations] = useState<PresentationTaskSummary[]>([]);

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
    if (!UUID_PATTERN.test(currentLearnerId)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const cached = readLearningMapCache(currentLearnerId);
    if (cached) {
      setResources(cached.resources);
      setTree(cached.tree);
    }
    // 缓存只用于首屏快速回显；资源可能在其他页面或后台被删除，必须始终用服务端列表校准。
    // 若校准失败才保留旧缓存，避免把已经删除的 resourceId 永久“复活”。
    const resourcesPromise = api.listLearningResources()
      .then((listed) => listed.resources ?? [])
      .catch(() => cached?.resources ?? [] as LearningResourceSummary[]);
    // Presentation generation completes outside this page. Always reconcile
    // against the server so historical completed tasks cannot stay "missing"
    // forever because an older cache predates their completion.
    const presentationsPromise = presentationApi.listPresentationSummaries(100)
      .then((listed) => listed.tasks ?? [])
      .catch(() => cached?.presentations ?? [] as PresentationTaskSummary[]);
    Promise.all([api.getRagTree('agent'), api.getLearnerAnalyticsProfile().catch(() => null), presentationsPromise, resourcesPromise])
      .then(([latestTree, latestAnalytics, latestPresentations, latestResources]) => {
        if (!cancelled) setTree(latestTree);
        if (!cancelled) setAnalytics(latestAnalytics);
        if (!cancelled) setPresentations(latestPresentations);
        if (!cancelled) setResources(latestResources);
        if (!cancelled) writeLearningMapCache(currentLearnerId, { resources: latestResources, tree: latestTree, presentations: latestPresentations });
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentLearnerId]);

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
        topicProgress: {},
        learned: new Set<string>(),
        status: {},
        activeKp: null,
        resources: {},
        presentations: [],
        goalId: null,
      };
    }

    // 一级目录仅用于数据库归档；知识地图从二级章节开始建图。
    const byDatabaseOrder = <T extends { sortOrder: number; id: number }>(items: T[]) =>
      [...items].sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id);
    const chapters = byDatabaseOrder(tree.nodes).flatMap((root) =>
      root.level === 2 ? [root] : byDatabaseOrder(root.children.filter((node) => node.level === 2)),
    );
    const domains: KnowledgePoint[] = chapters.map((chapter) => ({
      id: chapter.nodeCode,
      name: chapter.name,
      en: chapter.nodeCode.toUpperCase(),
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
        const childResources = resources.filter((resource) => resource.kpId === chapter.nodeCode && resource.topic === child.name);
        const progressByForm = new Map(childResources.map((resource) => [resource.type, resource.progressRatio ?? (resource.learned ? 1 : 0)]));
        const pptLearned = presentations.some((task) => task.learned && task.title.includes(child.name));
        topicProgress[child.nodeCode] = Math.round((
          (progressByForm.get('lecture') ?? 0)
          + (progressByForm.get('practice') ?? 0)
          + (progressByForm.get('quiz') ?? 0)
          + (pptLearned ? 1 : 0)
        ) / 4 * 100);
        const selfEvidence = childResources.filter((resource) => resource.type !== 'quiz' && resource.masteryRatio > 0);
        const quizEvidence = childResources.filter((resource) => resource.type === 'quiz' && resource.masteryRatio > 0);
        const weightedEvidence = [
          ...selfEvidence.map((resource) => ({ score: resource.masteryRatio, weight: resource.type === 'practice' ? 0.2 : 0.15 })),
          ...quizEvidence.map((resource) => ({ score: resource.masteryRatio, weight: 0.45 })),
          ...(category && category.attempts > 0 ? [{ score: category.score, weight: 0.2 }] : []),
        ];
        const evidenceWeight = weightedEvidence.reduce((sum, item) => sum + item.weight, 0);
        topicMastery[child.nodeCode] = evidenceWeight
          ? Math.round(weightedEvidence.reduce((sum, item) => sum + item.score * item.weight, 0) / evidenceWeight * 100)
          : 0;
      });
      const topicScores = chapter.children
        .filter((child) => child.level === 3)
        .map((child) => topicProgress[child.nodeCode] ?? 0);
      chapterProgress[chapter.nodeCode] = topicScores.length
        ? Math.round(topicScores.reduce((sum, value) => sum + value, 0) / topicScores.length)
        : 0;
      const topicFill = chapter.children.filter((child) => child.level === 3).map((child) =>
        (topicProgress[child.nodeCode] ?? 0) / 100 * (topicMastery[child.nodeCode] ?? 0) / 100);
      const progressFraction = (chapterProgress[chapter.nodeCode] ?? 0) / 100;
      mastery[chapter.nodeCode] = progressFraction > 0 && topicFill.length
        ? Math.round(topicFill.reduce((sum, value) => sum + value, 0) / topicFill.length / progressFraction * 100)
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

    const resourceByKp: Record<string, Array<GeneratedResource & { id: string; learned?: boolean; started?: boolean }>> = {};
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
        kbRefs: [],
      });
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
      topicProgress,
      learned,
      status,
      activeKp: chapters.find((chapter) => status[chapter.nodeCode] === 'active')?.nodeCode ?? chapters[0]?.nodeCode ?? null,
      resources: resourceByKp,
      presentations,
      goalId: null,
    };
  }, [tree, analytics, presentations, loading, currentLearner, resources, currentLearnerId]);
}
