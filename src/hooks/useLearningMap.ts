import { useEffect, useMemo, useState } from 'react';
import { useProfile } from '@/context/ProfileContext';
import { api } from '@/lib/api';
import type { LearningMapOverview } from '@/lib/api';
import type { LearningMapNode } from '@/lib/api';
import type { KnowledgePoint } from '@/data/knowledgePoints';
import { knowledgePoints as fallbackPoints } from '@/data/knowledgePoints';
import {
  graphNodes as fallbackGraphNodes,
  graphEdges as fallbackGraphEdges,
  graphColumns as fallbackGraphColumns,
} from '@/data/knowledgeGraph';
import type { GraphEdge, GraphNode } from '@/data/knowledgeGraph';
import type { PathNode } from '@/data/reportData';
import type { LearningResourceSummary } from '@/lib/api';
import type { GeneratedResource } from '@/data/resources';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const COLUMN_X: Record<number, number> = { 1: 150, 2: 448, 3: 748 };
const COLUMN_LABELS: Record<number, string> = { 1: '基础层', 2: '核心方法', 3: '应用与进阶' };

export interface LearningMapView {
  loading: boolean;
  domains: KnowledgePoint[];
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  graphColumns: typeof fallbackGraphColumns;
  path: PathNode[];
  mastery: Record<string, number>;
  confidence: Record<string, number>;
  learned: Set<string>;
  status: Record<string, string>;
  activeKp: string | null;
  resources: Record<string, Array<GeneratedResource & { id: string }>>;
}

export function useLearningMap(): LearningMapView {
  const { currentLearnerId, currentLearner } = useProfile();
  const [map, setMap] = useState<LearningMapOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [resources, setResources] = useState<LearningResourceSummary[]>([]);

  useEffect(() => {
    if (!UUID_PATTERN.test(currentLearnerId)) {
      setMap(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.getLearningMap(currentLearnerId)
      .then(async (overview) => {
        if (!cancelled) setMap(overview);
        try {
          const listed = await api.listLearningResources();
          if (!cancelled) setResources(listed.resources ?? []);
        } catch {
          if (!cancelled) setResources([]);
        }
      })
      .catch(() => { if (!cancelled) setMap(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentLearnerId]);

  return useMemo<LearningMapView>(() => {
    if (!map || map.domains.length === 0) {
      const fallbackStatus: Record<string, string> = {};
      fallbackPoints.forEach((kp) => {
        const score = currentLearner.scores[kp.id] ?? 50;
        fallbackStatus[kp.id] = score >= kp.targetLevel ? 'done' : score >= 60 ? 'learning' : 'todo';
      });
      const fallbackPath: PathNode[] = fallbackPoints.map((kp, index) => ({
        id: `${kp.id}-path`,
        title: kp.name,
        kpId: kp.id,
        status: fallbackStatus[kp.id] === 'done' ? 'done' : index === 0 ? 'active' : 'todo',
        est: `${Math.max(30, kp.targetLevel * 2)}分钟`,
        resourceRef: `第${index + 1}章 · ${kp.name}`,
      }));
      return {
        loading,
        domains: fallbackPoints,
        graphNodes: fallbackGraphNodes,
        graphEdges: fallbackGraphEdges,
        graphColumns: fallbackGraphColumns,
        path: fallbackPath,
        mastery: Object.fromEntries(fallbackPoints.map((kp) => [kp.id, currentLearner.scores[kp.id] ?? 50])),
        confidence: Object.fromEntries(fallbackPoints.map((kp) => [kp.id, 40])),
        learned: new Set(fallbackPoints.filter((kp) => (currentLearner.scores[kp.id] ?? 0) >= 60).map((kp) => kp.id)),
        status: fallbackStatus,
        activeKp: fallbackPath.find((node) => node.status === 'active')?.kpId ?? fallbackPoints[0]?.id ?? null,
        resources: {},
      };
    }

    const domains: KnowledgePoint[] = map.domains.map((domain) => ({
      id: domain.code,
      name: domain.name,
      en: domain.en ?? domain.code.toUpperCase(),
      weight: domain.weight,
      targetLevel: domain.targetLevel,
      coverage: domain.coverage,
      description: domain.description ?? '',
      coreTopics: domain.topics.map((topic) => topic.name),
    }));

    const mastery: Record<string, number> = {};
    const confidence: Record<string, number> = {};
    const status: Record<string, string> = {};
    map.domains.forEach((domain) => {
      mastery[domain.code] = domain.state.mastery;
      confidence[domain.code] = domain.state.confidence;
      status[domain.code] = domain.state.status;
    });

    const learned = new Set(map.domains.filter((domain) => domain.state.learned).map((domain) => domain.code));
    const path: PathNode[] = map.learningPath.map((item) => ({
      id: `${item.kpId}-path`,
      title: item.title,
      kpId: item.kpId,
      status: item.status as PathNode['status'],
      est: `${item.estimatedMinutes}分钟`,
      resourceRef: item.resourceRef,
    }));

    const positionFor = (node: LearningMapNode, topicIndex?: number): GraphNode => {
      const dx = COLUMN_X[node.column] ?? 460;
      const orderIndex = node.order - 1;
      const dy = orderIndex % 2 === 0 ? 148 : 345;
      if (node.kind === 'domain') {
        return {
          id: node.kpId,
          kpId: node.kpId,
          kind: 'domain',
          label: map.domains.find((d) => d.code === node.kpId)?.name ?? node.kpId,
          x: dx,
          y: dy,
          r: 46,
          labelX: dx,
          labelY: dy + 65,
          labelAnchor: 'middle',
        };
      }
      const dir = dy < 250 ? 1 : -1;
      const tx = dx - 99 + (topicIndex ?? 0) * 66;
      const ty = dy + dir * 102;
      return {
        id: node.id,
        kpId: node.kpId,
        kind: 'topic',
        label: map.domains.find((d) => d.code === node.kpId)?.topics[topicIndex ?? 0]?.name ?? node.label,
        topicIndex,
        x: tx,
        y: ty,
        r: 13,
        labelX: tx,
        labelY: dir === 1 ? ty + 27 : ty - 21,
        labelAnchor: 'middle',
      };
    };

    const graphNodes: GraphNode[] = [];
    map.graph.nodes.forEach((node) => {
      graphNodes.push(positionFor(node, node.kind === 'topic' ? node.order - 1 : undefined));
    });

    const graphEdges: GraphEdge[] = map.graph.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      note: edge.note ?? '',
    }));

    const graphColumns = map.graph.columns
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((column) => ({ label: column.label || COLUMN_LABELS[column.order] || `第${column.order}列`, x: COLUMN_X[column.order] ?? 150 }));
    const resourceByKp: Record<string, Array<GeneratedResource & { id: string }>> = {};
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
        kbRefs: [],
      });
    });

    return {
      loading,
      domains,
      graphNodes: graphNodes.length ? graphNodes : fallbackGraphNodes,
      graphEdges: graphEdges.length ? graphEdges : fallbackGraphEdges,
      graphColumns: graphColumns.length ? graphColumns : fallbackGraphColumns,
      path,
      mastery,
      confidence,
      learned,
      status,
      activeKp: path.find((node) => node.status === 'active')?.kpId ?? map.domains[0]?.code ?? null,
      resources: resourceByKp,
    };
  }, [map, loading, currentLearner, resources, currentLearnerId]);
}
