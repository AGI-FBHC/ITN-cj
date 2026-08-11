import { useEffect, useMemo, useState } from 'react';
import { useRef } from 'react';
import { useProfile } from '@/context/ProfileContext';
import { api } from '@/lib/api';
import type { LearnerAnalyticsProfile, LearningMapOverview, RagTree } from '@/lib/api';
import type { KnowledgePoint } from '@/data/knowledgePoints';
import {
} from '@/data/knowledgeGraph';
import type { GraphEdge, GraphNode } from '@/data/knowledgeGraph';
import type { PathNode } from '@/data/reportData';
import type { LearningResourceSummary } from '@/lib/api';
import type { GeneratedResource } from '@/data/resources';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// v3: 数据源切换到 knowledge_category，废弃仍包含旧六域的账号缓存。
const CACHE_PREFIX = 'lf.learningMapCache:v3:';

interface LearningMapCache {
  overview: LearningMapOverview;
  resources: LearningResourceSummary[];
  tree?: RagTree;
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

export interface LearningMapView {
  loading: boolean;
  domains: KnowledgePoint[];
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  path: PathNode[];
  mastery: Record<string, number>;
  confidence: Record<string, number>;
  learned: Set<string>;
  status: Record<string, string>;
  activeKp: string | null;
  resources: Record<string, Array<GeneratedResource & { id: string; learned?: boolean }>>;
  goalId: string | null;
}

export function useLearningMap(): LearningMapView {
  const { currentLearnerId, currentLearner } = useProfile();
  const [map, setMap] = useState<LearningMapOverview | null>(() => readLearningMapCache(currentLearnerId)?.overview ?? null);
  const [loading, setLoading] = useState(true);
  const [resources, setResources] = useState<LearningResourceSummary[]>(() => readLearningMapCache(currentLearnerId)?.resources ?? []);
  const [tree, setTree] = useState<RagTree | null>(() => readLearningMapCache(currentLearnerId)?.tree ?? null);
  const [analytics, setAnalytics] = useState<LearnerAnalyticsProfile | null>(null);
  const mapRef = useRef<LearningMapOverview | null>(map);
  mapRef.current = map;

  useEffect(() => {
    if (!UUID_PATTERN.test(currentLearnerId)) {
      setMap(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const cached = readLearningMapCache(currentLearnerId);
    if (cached) {
      setMap(cached.overview);
      setResources(cached.resources);
      setTree(cached.tree ?? null);
    }
    Promise.all([api.getLearningMap(currentLearnerId), api.getRagTree('agent'), api.getLearnerAnalyticsProfile().catch(() => null)])
      .then(async ([overview, latestTree, latestAnalytics]) => {
        if (!cancelled) setMap(overview);
        if (!cancelled) setTree(latestTree);
        if (!cancelled) setAnalytics(latestAnalytics);
        try {
          const listed = await api.listLearningResources();
          const latestResources = listed.resources ?? [];
          if (!cancelled) {
            setResources(latestResources);
            writeLearningMapCache(currentLearnerId, { overview, resources: latestResources, tree: latestTree });
          }
        } catch {
          if (!cancelled) {
            setResources([]);
            writeLearningMapCache(currentLearnerId, { overview, resources: [], tree: latestTree });
          }
        }
      })
      .catch(() => { if (!cancelled && !cached) setMap(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    // 后台课程/资源生成完成后自动刷新，避免用户停留在知识地图时看不到新资源
    const poll = window.setInterval(() => {
      api.listLearningResources()
        .then((listed) => {
          if (cancelled) return;
          const latestResources = listed.resources ?? [];
          setResources(latestResources);
          if (mapRef.current) {
            writeLearningMapCache(currentLearnerId, { overview: mapRef.current, resources: latestResources, tree: tree ?? undefined });
          }
        })
        .catch(() => undefined);
    }, 20_000);
    return () => { cancelled = true; window.clearInterval(poll); };
  }, [currentLearnerId]);

  return useMemo<LearningMapView>(() => {
    if (!map || !tree) {
      return {
        loading,
        domains: [],
        graphNodes: [],
        graphEdges: [],
        path: [],
        mastery: {},
        confidence: {},
        learned: new Set<string>(),
        status: {},
        activeKp: null,
        resources: {},
        goalId: null,
      };
    }

    // 一级目录仅用于数据库归档；知识地图从二级章节开始建图。
    const chapters = tree.nodes.flatMap((root) => root.level === 2 ? [root] : root.children.filter((node) => node.level === 2));
    const domains: KnowledgePoint[] = chapters.map((chapter) => ({
      id: chapter.nodeCode,
      name: chapter.name,
      en: chapter.nodeCode.toUpperCase(),
      weight: 1 / Math.max(1, chapters.length),
      targetLevel: 80,
      coverage: chapter.chunkCount ? 100 : 0,
      description: chapter.description ?? '',
      coreTopics: chapter.children.filter((node) => node.level === 3).map((node) => node.name),
    }));

    const mastery: Record<string, number> = {};
    const confidence: Record<string, number> = {};
    const status: Record<string, string> = {};
    const masteryByCategory = new Map((analytics?.mastery.categories ?? []).map((item) => [item.id, item]));
    chapters.forEach((chapter) => {
      const direct = masteryByCategory.get(chapter.id);
      const children = chapter.children.map((child) => masteryByCategory.get(child.id)).filter(Boolean);
      const samples = direct ? [direct] : children;
      const score = samples.length ? samples.reduce((sum, item) => sum + item!.score, 0) / samples.length : 0;
      const attempts = samples.reduce((sum, item) => sum + item!.attempts, 0);
      mastery[chapter.nodeCode] = Math.round(score * 100);
      confidence[chapter.nodeCode] = attempts > 0 ? Math.min(95, 40 + attempts * 5) : 0;
      status[chapter.nodeCode] = attempts > 0 ? 'active' : 'locked';
    });

    const learned = new Set(chapters.filter((chapter) => (mastery[chapter.nodeCode] ?? 0) > 0).map((chapter) => chapter.nodeCode));
    const path: PathNode[] = map.learningPath.map((item) => ({
      id: `${item.kpId}-path`,
      title: item.title,
      kpId: item.kpId,
      status: item.status as PathNode['status'],
      est: `${item.estimatedMinutes}分钟`,
      resourceRef: item.resourceRef,
    }));

    const graphNodes: GraphNode[] = chapters.map((chapter, index) => {
      const x = 100 + (index % 4) * 240;
      const y = 58 + Math.floor(index / 4) * 106;
      return { id: chapter.nodeCode, kpId: chapter.nodeCode, kind: 'domain', label: chapter.name, x, y, r: 30, labelX: x, labelY: y + 45, labelAnchor: 'middle' };
    });
    chapters.forEach((chapter) => {
      const parent = graphNodes.find((node) => node.id === chapter.nodeCode)!;
      const topics = chapter.children.filter((node) => node.level === 3);
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

    const resourceByKp: Record<string, Array<GeneratedResource & { id: string; learned?: boolean }>> = {};
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
      confidence,
      learned,
      status,
      activeKp: chapters.find((chapter) => status[chapter.nodeCode] === 'active')?.nodeCode ?? chapters[0]?.nodeCode ?? null,
      resources: resourceByKp,
      goalId: map.goalId ?? null,
    };
  }, [map, tree, analytics, loading, currentLearner, resources, currentLearnerId]);
}
