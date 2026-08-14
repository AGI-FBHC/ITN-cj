/**
 * KnowledgeGraph — 知识图谱（学情可视化 + 自主选点入口）· 知识地图版
 * 布局：章节节点参与建图；点击章节后，前端就地展开其子知识点。
 * 场景驱动（scene prop，由页面级分段控件切换）：
 *   order   学习顺序（默认）—— 只画前置箭头；
 *   network 完整网络 —— 三种关系全开，图例即控件（线型样本 chip，可单独隐藏）；
 *   route   我的路线 —— 前置 + 学习路径叠加。
 * 渐进披露：默认展示章节图；点击章节后以 XMind 分支展开子知识点，其余章节保持可见。
 * 术语双标：先学它(prereq) / 互相印证(related) / 规范约束(applies)；边 hover 出玻璃浮层说明。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProfile } from '@/context/ProfileContext';
import { useNotes } from '@/context/NotesContext';
import { reportForLearner } from '@/data/reportBuilder';
import type { PathNode } from '@/data/reportData';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import {
  graphNodes,
  graphEdges,
  graphViewBox,
  learnedKpIds,
} from '@/data/knowledgeGraph';
import type { DomainEdge, EdgeKind, GraphEdge, GraphNode } from '@/data/knowledgeGraph';
import { speciesOf } from '@/data/garden';
import SpeciesPlant, { GardenDefs } from '@/components/heal/SpeciesPlant';

/** 术语双标：人话在前（label），行话在后（term，进 hover 提示） */
const EDGE_STYLE: Record<EdgeKind, { stroke: string; width: number; dash?: string; opacity: number; label: string; term: string; hint: string }> = {
  prereq: { stroke: '#5F8870', width: 1.55, opacity: 0.5, label: '先学它', term: 'prereq · 前置', hint: '箭头从 A 指向 B：先学 A 才好学 B' },
  related: { stroke: '#B77552', width: 1.4, dash: '5 4', opacity: 0.5, label: '互相印证', term: 'related · 相关', hint: '两个知识互补或方法同构，一起看更通' },
  applies: { stroke: '#66725E', width: 1.1, dash: '2 4', opacity: 0.45, label: '规范约束', term: 'applies · 应用', hint: '安全规范对实操动作的硬性约束' },
};


/** 生长阶段：0 种子 / 1 破土 / 2 长叶 / 3 花蕾 / 4 开花(达标) / 5 结果 */
function growthStage(mastery: number, target: number, learned: boolean): number {
  if (!learned) return 0;
  if (mastery >= 95) return 5;
  if (mastery >= target) return 4;
  const toTarget = mastery / Math.max(1, target);
  if (toTarget >= 0.8) return 3;
  if (toTarget >= 0.45) return 2;
  return 1;
}

/** 环形进度弧（保留精确掌握度） */
function arcPath(cx: number, cy: number, R: number, pct: number): string {
  const p = Math.max(0.001, Math.min(0.999, pct));
  const a = p * 2 * Math.PI;
  const x2 = cx + R * Math.sin(a);
  const y2 = cy - R * Math.cos(a);
  return `M ${cx} ${cy - R} A ${R} ${R} 0 ${a > Math.PI ? 1 : 0} 1 ${x2} ${y2}`;
}

/** 域节点：植物 + 进度弧 + 掌握度数字（植物隐喻只留在域上） */
function DomainNode({
  n,
  mastery,
  target,
  learned,
  recommended,
  dimmed,
  selected,
  expanded,
  highlightLearned,
}: {
  n: GraphNode;
  mastery: number;
  target: number;
  learned: boolean;
  recommended: boolean;
  dimmed: boolean;
  selected: boolean;
  expanded: boolean;
  /** 打开“我的已学路径”时高亮已学章节 */
  highlightLearned: boolean;
}) {
  const stage = growthStage(mastery, target, learned);
  const passed = learned && mastery >= target;
  const scale = (1.5 * n.r) / 56;
  const groundY = n.y + n.r * 0.42;
  const ringR = n.r - 3;
  const targetAngle = (target / 100) * 2 * Math.PI;

  return (
    <g
      className="cursor-pointer"
      opacity={dimmed ? 0.5 : 1}
      style={{ transition: 'opacity 0.25s, filter 0.25s', filter: dimmed ? 'blur(2px)' : 'none' }}
    >
      {recommended && (
        <circle cx={n.x} cy={n.y} r={n.r + 8} fill="none" stroke="#E7B45A" strokeWidth="2" opacity="0.7">
          <animate attributeName="r" values={`${n.r + 6};${n.r + 11};${n.r + 6}`} dur="2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.7;0.15;0.7" dur="2s" repeatCount="indefinite" />
        </circle>
      )}
      {selected && (
        <circle cx={n.x} cy={n.y} r={n.r + 5} fill="none" stroke="#4E7860" strokeWidth="2.5" strokeDasharray="4 3" opacity="0.85">
          <animateTransform attributeName="transform" type="rotate" from={`0 ${n.x} ${n.y}`} to={`360 ${n.x} ${n.y}`} dur="9s" repeatCount="indefinite" />
        </circle>
      )}
      {learned && highlightLearned && (
        <circle cx={n.x} cy={n.y} r={n.r + 8} fill="none" stroke="#4E7860" strokeWidth="2.5" opacity="0.9">
          <animate attributeName="r" values={`${n.r + 6};${n.r + 13};${n.r + 6}`} dur="2.2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.9;0.25;0.9" dur="2.2s" repeatCount="indefinite" />
        </circle>
      )}

      {/* 花坛 */}
      <circle
        cx={n.x}
        cy={n.y}
        r={n.r}
        fill={learned ? 'rgba(251,250,245,0.62)' : 'rgba(236,241,234,0.5)'}
        stroke={expanded ? '#4E7860' : passed ? '#E7B45A' : learned ? '#9BC5AC' : '#C4D3C8'}
        strokeWidth={expanded ? 2.4 : 1.6}
      />
      {learned ? (
        <>
          <path
            d={arcPath(n.x, n.y, ringR, mastery / 100)}
            fill="none"
            stroke={passed ? '#E7B45A' : '#7FB295'}
            strokeWidth="3.5"
            strokeLinecap="round"
            opacity="0.9"
          />
          {/* 目标刻度 */}
          <circle
            cx={n.x + ringR * Math.sin(targetAngle)}
            cy={n.y - ringR * Math.cos(targetAngle)}
            r="2.6"
            fill="#B0483B"
            opacity="0.85"
          />
        </>
      ) : (
        /* 未学：一圈淡虚线（替代旧版"幽灵植物"，视觉重量降级） */
        <circle cx={n.x} cy={n.y} r={ringR} fill="none" stroke="#C4D3C8" strokeWidth="1.2" strokeDasharray="3 4" opacity="0.7" />
      )}

      {/* 植物：一域一种（向日葵/鸢尾/松/牵牛/竹/薄荷），种子期也能靠幼苗轮廓区分 */}
      <g transform={`translate(${n.x} ${groundY}) scale(${scale})`} filter={stage >= 4 ? 'url(#g-glow)' : undefined} style={{ pointerEvents: 'none' }}>
        <SpeciesPlant species={speciesOf(n.kpId).key} stage={stage} />
      </g>

      {/* 掌握度数字 */}
      <text
        x={n.x}
        y={n.y + n.r - 7}
        textAnchor="middle"
        fontSize="12.5"
        fontWeight="700"
        fontFamily="'IBM Plex Mono', monospace"
        fill={learned ? '#3D4A3A' : '#66725E'}
        stroke="#FBFAF5"
        strokeWidth="2.6"
        strokeLinejoin="round"
        paintOrder="stroke"
        style={{ pointerEvents: 'none' }}
      >
        {learned ? mastery : '—'}
      </text>

      {/* 标签 */}
      <text
        x={n.labelX}
        y={n.labelY}
        textAnchor={n.labelAnchor}
        fontSize={n.r <= 25 ? '10.5' : '13'}
        fontWeight={600}
        fill={dimmed ? '#A9B6A0' : '#4A5244'}
        stroke="#FBFAF5"
        strokeWidth="3"
        strokeLinejoin="round"
        paintOrder="stroke"
        style={{ pointerEvents: 'none' }}
      >
        {n.label}
      </text>
    </g>
  );
}

/** 子知识点：圆形节点 + 右侧文字，保持与原知识图一致的节点语言。 */
function TopicBranchNode({ n, mastery, progress, target }: { n: GraphNode; mastery: number; progress: number; target?: number }) {
  const passed = progress >= 100;
  const labelWidth = Math.min(240, Math.max(50, n.label.length * 16));
  const hitX = n.labelAnchor === 'start' ? n.x - 17 : n.x - 24 - labelWidth;
  return (
    <g className="cursor-pointer">
      {/* 圆点、文字及中间空隙使用同一个命中面，点击文字同样选中该知识点。 */}
      <rect x={hitX} y={n.y - 19} width={labelWidth + 41} height="38" rx="7" fill="transparent" />
      <circle cx={n.x} cy={n.y} r="15" fill="#FBFAF5" stroke="#DCE6DE" strokeWidth="2.2" />
      {progress > 0 && <path d={arcPath(n.x, n.y, 15, progress / 100)} fill="none" stroke={passed ? '#D8A94E' : '#5F8870'} strokeWidth="3" strokeLinecap="round" />}
      {target != null && target > 0 && (
        <line
          x1={n.x}
          y1={n.y - 15}
          x2={n.x}
          y2={n.y - 21.5}
          stroke="#F5A623"
          strokeWidth="2.5"
          strokeLinecap="round"
          transform={`rotate(${target * 3.6} ${n.x} ${n.y})`}
        />
      )}
      <circle cx={n.x} cy={n.y} r="5.5" fill={passed ? '#D8A94E' : progress > 0 ? '#5F8870' : '#D5DFD7'} />
      <title>{`学习进度 ${progress}% · 实际掌握 ${mastery}%${target != null ? ` · 目标门槛 ${target}${mastery >= target ? '（已达标）' : ''}` : ''}`}</title>
      <text
        x={n.labelX}
        y={n.y + 5.3}
        textAnchor={n.labelAnchor}
        fontSize="15.5"
        fontWeight="600"
        fill="#5A6553"
        stroke="#FBFAF5"
        strokeWidth="2.5"
        paintOrder="stroke"
        style={{ pointerEvents: 'none' }}
      >
        {n.label}
      </text>
    </g>
  );
}

export default function KnowledgeGraph({
  onSelectKp,
  selectedKpId,
  nodes: nodesProp,
  edges: edgesProp,
  path: pathProp,
  mastery: masteryProp,
  topicMastery: topicMasteryProp,
  topicProgress: topicProgressProp,
  learned: learnedProp,
  activeKp: activeKpProp,
  onSelectTopic,
  expandedKpIds,
  onExpandedKpChange,
  showLearned = false,
  nodeTargets,
}: {
  /** 提供后：点节点 = 选中（联动右栏详情），不直接跳转 */
  onSelectKp?: (kpId: string | null) => void;
  /** 提供后：点击子知识点时回传其在所属领域内的索引（用于细化资源生成） */
  onSelectTopic?: (topicIndex: number) => void;
  selectedKpId?: string | null;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  path?: PathNode[];
  mastery?: Record<string, number>;
  topicMastery?: Record<string, number>;
  topicProgress?: Record<string, number>;
  learned?: Set<string>;
  activeKp?: string | null;
  /** 打开“我的已学路径”：高亮已学章节（不一定连续） */
  showLearned?: boolean;
  /** 目标岗位门槛：nodeCode → { target, name } */
  nodeTargets?: Record<string, { target: number; name?: string }>;
  /** 受控展开章节集合，用于与下方章节速览联动（2D 视图只展示最近展开的一个）。 */
  expandedKpIds?: Set<string>;
  onExpandedKpChange?: (kpId: string | null) => void;
} = {}) {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const { countByKp } = useNotes();
  const report = reportForLearner(currentLearner);
  /** 边 hover 玻璃浮层（替代浏览器原生 title） */
  const [edgeTip, setEdgeTip] = useState<{ x: number; y: number; kind: EdgeKind; notes: string[] } | null>(null);
  /** 渐进披露：当前展开的域（null = 只看 6 域全景） */
  const [internalExpandedKp, setInternalExpandedKp] = useState<string | null>(null);
  const expandedKp = expandedKpIds !== undefined ? (Array.from(expandedKpIds).at(-1) ?? null) : internalExpandedKp;
  const setExpandedKp = (kpId: string | null) => {
    if (expandedKpIds === undefined) setInternalExpandedKp(kpId);
    onExpandedKpChange?.(kpId);
  };

  /* 默认只展示“先学它”前置边，保持学习方向清晰 */
  const layerOn = (k: EdgeKind): boolean => k === 'prereq';

  const sourceNodes = nodesProp ?? graphNodes;
  const expandedSourceTopics = expandedKp ? sourceNodes.filter((node) => node.kind === 'topic' && node.kpId === expandedKp) : [];
  const longestTopicLabel = expandedSourceTopics.reduce((max, node) => Math.max(max, node.label.length), 0);
  const dataNodes = sourceNodes;
  const dataEdges = edgesProp ?? graphEdges;
  const reportPath = pathProp ?? report.path;
  const masteryMap = masteryProp ?? {};
  const topicMasteryMap = topicMasteryProp ?? {};
  const topicProgressMap = topicProgressProp ?? {};
  const learned = learnedProp ?? useMemo(() => {
    const pathDone = reportPath.filter((p) => p.status === 'done').map((p) => p.kpId);
    return learnedKpIds(currentLearner, pathDone);
  }, [currentLearner, reportPath]);
  const activeKp = activeKpProp ?? reportPath.find((p) => p.status === 'active')?.kpId ?? null;
  const sourceNodeById = useMemo(() => new Map(sourceNodes.map((node) => [node.id, node])), [sourceNodes]);
  const nodeById = useMemo(() => new Map(dataNodes.map((node) => [node.id, node])), [dataNodes]);
  const aggregatedEdges = useMemo(() => {
    const map = new Map<string, DomainEdge>();
    dataEdges.forEach((edge) => {
      const a = nodeById.get(edge.from);
      const b = nodeById.get(edge.to);
      if (!a || !b || a.kind !== 'domain' || b.kind !== 'domain') return;
      const key = `${edge.kind}:${a.kpId}>${b.kpId}`;
      const current = map.get(key);
      if (current) {
        current.count += 1;
        current.notes.push(edge.note ?? '');
      } else {
        map.set(key, { from: a.kpId, to: b.kpId, kind: edge.kind, count: 1, notes: edge.note ? [edge.note] : [] });
      }
    });
    return map;
  }, [dataEdges, nodeById]);
  const domainEdgesOf = (kind: EdgeKind) => [...aggregatedEdges.values()].filter((edge) => edge.kind === kind);
  const edgeRouting = useMemo(() => {
    const edges = [...aggregatedEdges.values()];
    const outgoingOrder = new Map<string, DomainEdge[]>();
    const incomingOrder = new Map<string, DomainEdge[]>();
    edges.forEach((edge) => {
      (outgoingOrder.get(edge.from) ?? outgoingOrder.set(edge.from, []).get(edge.from)!).push(edge);
      (incomingOrder.get(edge.to) ?? incomingOrder.set(edge.to, []).get(edge.to)!).push(edge);
    });
    const longEdges = edges
      .filter((edge) => {
        // 展开子树插入的临时间距不能把原本相邻层的边误判为跨层边。
        const from = sourceNodeById.get(edge.from), to = sourceNodeById.get(edge.to);
        return Boolean(from && to && to.x - from.x > 150);
      })
      .sort((a, b) => {
        const spanA = (nodeById.get(a.to)?.x ?? 0) - (nodeById.get(a.from)?.x ?? 0);
        const spanB = (nodeById.get(b.to)?.x ?? 0) - (nodeById.get(b.from)?.x ?? 0);
        return spanB - spanA;
      });
    const laneOf = new Map<string, { y: number; index: number }>(longEdges.map((edge, index) => [
      `${edge.kind}:${edge.from}>${edge.to}`,
      { y: 7 + index * 9, index },
    ] as const));
    const edgeKey = (edge: DomainEdge) => `${edge.kind}:${edge.from}>${edge.to}`;
    const selectedLaneOf = new Map<string, number>();
    longEdges.forEach((edge) => {
      const lane = laneOf.get(edgeKey(edge))!;
      // 车道选择也固定依据展开前的图，避免插入空间后跨层边突然从上绕改成下绕。
      const from = sourceNodeById.get(edge.from)!, to = sourceNodeById.get(edge.to)!;
      const x1 = from.x + from.r + 4, y1 = from.y;
      const x2 = to.x - to.r - 8, y2 = to.y;
      const shoulder = 10 + lane.index * 1.25;
      const obstacles = [...sourceNodeById.values()].filter((node) =>
        node.kind === 'domain' && node.id !== from.id && node.id !== to.id,
      );
      const collisionCount = (laneY: number) => {
        let collisions = 0;
        for (let step = 2; step < 39; step += 1) {
          const t = step / 40, u = 1 - t;
          const px = u ** 3 * x1 + 3 * u ** 2 * t * (x1 + shoulder) + 3 * u * t ** 2 * (x2 - shoulder) + t ** 3 * x2;
          const py = u ** 3 * y1 + 3 * u ** 2 * t * laneY + 3 * u * t ** 2 * laneY + t ** 3 * y2;
          if (obstacles.some((node) => Math.hypot(px - node.x, py - node.y) < node.r + 7)) collisions += 1;
        }
        return collisions;
      };
      const outerCandidates = [lane.y, graphViewBox.h - 7 - lane.index * 9];
      const selected = outerCandidates
        .map((value) => ({
          value,
          collisions: collisionCount(value),
          detour: Math.abs(value - y1) + Math.abs(value - y2),
        }))
        .sort((left, right) => left.collisions - right.collisions || left.detour - right.detour)[0];
      selectedLaneOf.set(edgeKey(edge), selected.value);
    });
    const departureY = (edge: DomainEdge) => selectedLaneOf.get(edgeKey(edge)) ?? nodeById.get(edge.to)?.y ?? 0;
    const approachY = (edge: DomainEdge) => selectedLaneOf.get(edgeKey(edge)) ?? nodeById.get(edge.from)?.y ?? 0;
    // 端口顺序跟随实际路由通道，而不是只看目标节点：上行线永远占上方端口。
    outgoingOrder.forEach((items) => items.sort((a, b) =>
      departureY(a) - departureY(b)
      || (nodeById.get(a.to)?.x ?? 0) - (nodeById.get(b.to)?.x ?? 0),
    ));
    incomingOrder.forEach((items) => items.sort((a, b) =>
      approachY(a) - approachY(b)
      || (nodeById.get(b.from)?.x ?? 0) - (nodeById.get(a.from)?.x ?? 0),
    ));

    return (edge: DomainEdge, a: GraphNode, b: GraphNode) => {
      const out = outgoingOrder.get(edge.from) ?? [edge];
      const incoming = incomingOrder.get(edge.to) ?? [edge];
      const angularOffset = (items: DomainEdge[], index: number) => {
        const step = items.length > 2 ? 0.62 : items.length === 2 ? 0.48 : 0;
        return (index - (items.length - 1) / 2) * step;
      };
      const sourceAngle = out.length > 1
        ? Math.max(-1.16, Math.min(1.16, angularOffset(out, out.indexOf(edge))))
        : Math.max(-1.0, Math.min(1.0, Math.atan2(b.y - a.y, b.x - a.x)));
      let targetAngle = Math.atan2(a.y - b.y, a.x - b.x);
      if (targetAngle < 0) targetAngle += Math.PI * 2;
      targetAngle = incoming.length > 1
        ? Math.PI - Math.max(-1.16, Math.min(1.16, angularOffset(incoming, incoming.indexOf(edge))))
        : Math.max(Math.PI - 1.0, Math.min(Math.PI + 1.0, targetAngle));
      const sourcePortRadius = a.r + (out.length > 2 ? 6 : 4);
      // 路径终点就是箭头尖端：贴近节点外缘，避免箭头悬浮在圆外。
      const targetPortRadius = b.r + 2;
      const x1 = a.x + Math.cos(sourceAngle) * sourcePortRadius;
      const y1 = a.y + Math.sin(sourceAngle) * sourcePortRadius;
      const x2 = b.x + Math.cos(targetAngle) * targetPortRadius;
      const y2 = b.y + Math.sin(targetAngle) * targetPortRadius;
      const lane = laneOf.get(edgeKey(edge));
      if (lane !== undefined) {
        // 控制点靠近端口，使跨层边快速进入独立车道，避开中间层节点。
        const shoulder = 10 + lane.index * 1.25;
        const laneY = selectedLaneOf.get(edgeKey(edge)) ?? lane.y;
        const sourceControlX = x1 + Math.cos(sourceAngle) * shoulder;
        const sourceControlY = y1 + Math.sin(sourceAngle) * shoulder;
        const targetControlX = x2 + Math.cos(targetAngle) * shoulder;
        const targetControlY = y2 + Math.sin(targetAngle) * shoulder;
        return {
          path: `M ${x1} ${y1} C ${sourceControlX} ${sourceControlY}, ${x1 + shoulder} ${laneY}, ${(x1 + x2) / 2} ${laneY} S ${targetControlX} ${targetControlY}, ${x2} ${y2}`,
          mx: (x1 + x2) / 2,
          my: laneY,
        };
      }
      // 相邻层使用短切线控制柄：只校正端点方向，不允许控制柄把整条曲线拉过相邻分支。
      const controlOffset = Math.min(11, Math.max(7, (x2 - x1) * 0.13));
      const targetHandle = 15;
      const sourceControlX = x1 + Math.cos(sourceAngle) * controlOffset;
      const sourceControlY = y1 + Math.sin(sourceAngle) * controlOffset;
      const targetControlX = x2 + Math.cos(targetAngle) * targetHandle;
      const targetControlY = y2 + Math.sin(targetAngle) * targetHandle;
      return {
        path: `M ${x1} ${y1} C ${sourceControlX} ${sourceControlY}, ${targetControlX} ${targetControlY}, ${x2} ${y2}`,
        mx: (x1 + x2) / 2,
        my: (y1 + y2) / 2,
      };
    };
  }, [aggregatedEdges, nodeById, sourceNodeById]);
  const domains = useMemo(() => dataNodes.filter((n) => n.kind === 'domain'), [dataNodes]);
  const expandedTopics = useMemo(
    () => (expandedKp ? dataNodes.filter((n) => n.kind === 'topic' && n.kpId === expandedKp) : []),
    [expandedKp, dataNodes],
  );
  const expandedTopicLayout = useMemo(() => {
    if (!expandedKp || expandedTopics.length === 0) return null;
    const parent = nodeById.get(expandedKp);
    if (!parent) return null;
    const spacing = expandedTopics.length > 1 ? Math.min(38, (graphViewBox.h - 44) / (expandedTopics.length - 1)) : 0;
    const contentHeight = (expandedTopics.length - 1) * spacing;
    const top = Math.max(22, Math.min(graphViewBox.h - contentHeight - 22, parent.y - contentHeight / 2));
    const estimatedLabelWidth = Math.min(210, longestTopicLabel * 9.5);
    const rightRequired = 104 + estimatedLabelWidth;
    const rightSpace = graphViewBox.w - parent.x;
    const leftSpace = parent.x;
    const direction = rightSpace >= rightRequired || rightSpace >= leftSpace ? 1 : -1;
    const childX = parent.x + direction * 82;
    const topics = expandedTopics.map((topic, index) => {
      const x = childX;
      const y = top + index * spacing;
      return {
        ...topic,
        x,
        y,
        labelX: x + direction * 24,
        labelY: y,
        labelAnchor: (direction > 0 ? 'start' : 'end') as 'start' | 'end',
      };
    });
    const rootX = parent.x + direction * (parent.r + 3);
    const rootY = parent.y;
    const trunkX = parent.x + direction * (parent.r + 32);
    return { parent, topics, rootX, rootY, trunkX, direction };
  }, [expandedKp, expandedTopics, nodeById, longestTopicLabel]);
  const currentViewBox = graphViewBox;


  /** 点域：展开/收拢 + 选中（右栏出详情）；点子节点：选中 */
  const clickNode = (n: GraphNode) => {
    if (n.kind === 'domain') setExpandedKp(expandedKp === n.kpId ? null : n.kpId);
    if (onSelectKp) onSelectKp(n.kpId);
    if (n.kind === 'topic' && onSelectTopic) onSelectTopic(n.topicIndex ?? 0);
  };

  const clearSelection = () => {
    setExpandedKp(null);
    setEdgeTip(null);
    onSelectKp?.(null);
  };

  /** 双击：子知识点按自身 topic id 进入独立课件，不再压缩到父领域前三块。 */
  const openUnit = (n: GraphNode) => {
    if (n.kind === 'domain') return;
    navigate(`/learn/${n.kpId}?unitTopic=${encodeURIComponent(n.id)}`);
  };

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${currentViewBox.w} ${currentViewBox.h}`} className="w-full">
        <GardenDefs />
        <defs>
          <marker id="kg-arrow" viewBox="-1 -5 10 10" refX="7" refY="0" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto" overflow="visible">
            <path d="M 0 -4 L 7 0 L 0 4 Z" fill="#FBFAF5" stroke="#5F8870" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
          </marker>
        </defs>
        <rect
          data-graph-background="true"
          x="0"
          y="0"
          width={currentViewBox.w}
          height={currentViewBox.h}
          fill="transparent"
          onClick={clearSelection}
        />

        {/* 域级聚合边（默认视图的全部边） */}
        {(Object.keys(EDGE_STYLE) as EdgeKind[]).map((kind) =>
          layerOn(kind)
            ? domainEdgesOf(kind).map((e) => {
                const a = nodeById.get(e.from)!;
                const b = nodeById.get(e.to)!;
                const st = EDGE_STYLE[kind];
                const route = edgeRouting(e, a, b);
                const edgePath = route.path;
                const mx = route.mx;
                const my = route.my;
                return (
                  <g
                    key={`${kind}-${e.from}-${e.to}`}
                    opacity={expandedKp ? 0.32 : 1}
                    style={{ transition: 'opacity 0.25s, filter 0.25s', filter: expandedKp ? 'blur(1.6px)' : 'none' }}
                    onMouseEnter={() => setEdgeTip({ x: mx, y: my, kind, notes: e.notes })}
                    onMouseLeave={() => setEdgeTip(null)}
                  >
                    {/* 加宽的透明命中区：细线也好 hover */}
                    <path d={edgePath} fill="none" stroke="transparent" strokeWidth="14" />
                    <path
                      data-edge-from={e.from}
                      data-edge-to={e.to}
                      d={edgePath}
                      fill="none"
                      stroke={st.stroke}
                      strokeWidth={st.width + (e.count - 1) * 1.1}
                      strokeDasharray={st.dash}
                      strokeLinecap="round"
                      opacity={st.opacity + 0.1}
                      markerEnd={kind === 'prereq' ? 'url(#kg-arrow)' : undefined}
                      style={{ pointerEvents: 'none' }}
                    />
                    {e.count > 1 && (
                      <>
                        <circle cx={mx} cy={my} r="8" fill="#FBFAF5" stroke="#DDDCCE" />
                        <text x={mx} y={my + 3.2} textAnchor="middle" fontSize="9" fontFamily="monospace" fill="#66725E">
                          ×{e.count}
                        </text>
                      </>
                    )}
                  </g>
                );
              })
            : null,
        )}


        {/* 域节点 */}
        {domains.map((n) => {
          const isLearned = learned.has(n.kpId);
          const kp = getKnowledgePoint(n.kpId);
          const mastery = masteryMap[n.kpId] ?? 50;
          const dimmed = expandedKp !== null && expandedKp !== n.kpId;
          return (
            <g
              key={n.id}
              data-graph-node-id={n.id}
              onClick={() => clickNode(n)}
              onDoubleClick={() => openUnit(n)}
            >
              <DomainNode
                n={n}
                mastery={mastery}
                target={kp.targetLevel}
                learned={isLearned}
                recommended={n.kpId === activeKp && !expandedKp}
                dimmed={dimmed}
                selected={selectedKpId === n.kpId}
                expanded={expandedKp === n.kpId}
                highlightLearned={showLearned}
              />
              {/* 笔记角标 */}
              {(countByKp[n.kpId] ?? 0) > 0 && !dimmed && (
                <g>
                  <circle cx={n.x - n.r + 4} cy={n.y - n.r + 4} r="8.5" fill="#B77552" />
                  <text x={n.x - n.r + 4} y={n.y - n.r + 7.5} textAnchor="middle" fontSize="9" fontWeight="700" fill="#FBFAF5" fontFamily="monospace">
                    {countByKp[n.kpId]}
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {/* 展开章节的子知识点：原图内 XMind 式主干 + 圆形分支。 */}
        {expandedTopicLayout && (
          <g fill="none" stroke="#83A58F" strokeWidth="1.35" strokeLinecap="round" opacity="0.9" style={{ pointerEvents: 'none' }}>
            <path d={`M ${expandedTopicLayout.rootX} ${expandedTopicLayout.rootY} C ${expandedTopicLayout.trunkX - expandedTopicLayout.direction * 12} ${expandedTopicLayout.rootY}, ${expandedTopicLayout.trunkX} ${expandedTopicLayout.rootY}, ${expandedTopicLayout.trunkX} ${expandedTopicLayout.rootY}`} />
            {expandedTopicLayout.topics.map((topic) => {
              const targetX = topic.x - expandedTopicLayout.direction * 15;
              return <path key={`branch-${topic.id}`} d={`M ${expandedTopicLayout.trunkX} ${expandedTopicLayout.rootY} C ${expandedTopicLayout.trunkX} ${topic.y}, ${expandedTopicLayout.trunkX + expandedTopicLayout.direction * 12} ${topic.y}, ${targetX} ${topic.y}`} />;
            })}
          </g>
        )}
        {expandedTopicLayout?.topics.map((n) => {
          return (
            <g
              key={n.id}
              onClick={() => clickNode(n)}
              onDoubleClick={() => openUnit(n)}
            >
              <TopicBranchNode n={n} mastery={topicMasteryMap[n.id] ?? 0} progress={topicProgressMap[n.id] ?? 0} target={nodeTargets?.[n.id]?.target} />
            </g>
          );
        })}
      </svg>


      {/* 边 hover 玻璃浮层（替代浏览器原生 title 黄框） */}
      {edgeTip && (
        <div
          className="lf-glass pointer-events-none absolute z-10 w-[230px] rounded-[12px] p-3"
          style={{
            left: `${Math.min(88, Math.max(8, (edgeTip.x / currentViewBox.w) * 100))}%`,
            top: `${Math.max(2, (edgeTip.y / currentViewBox.h) * 100 - 4)}%`,
            transform: 'translate(-50%, -100%)',
          }}
        >
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink">
            <svg width="20" height="8" viewBox="0 0 24 8" aria-hidden>
              <line x1="0" y1="4" x2={edgeTip.kind === 'prereq' ? 17 : 24} y2="4" stroke={EDGE_STYLE[edgeTip.kind].stroke} strokeWidth="2" strokeDasharray={EDGE_STYLE[edgeTip.kind].dash} />
              {edgeTip.kind === 'prereq' && <path d="M 17 0.5 L 24 4 L 17 7.5 Z" fill={EDGE_STYLE[edgeTip.kind].stroke} />}
            </svg>
            {EDGE_STYLE[edgeTip.kind].label}
            <span className="font-mono text-[9.5px] font-normal text-ink-muted">{EDGE_STYLE[edgeTip.kind].term}</span>
          </div>
          <div className="mt-1.5 space-y-1 text-[11.5px] leading-[17px] text-ink-2">
            {edgeTip.notes.map((t) => (
              <div key={t}>· {t}</div>
            ))}
          </div>
          {edgeTip.notes.length > 1 && (
            <div className="mt-1 text-[10px] text-ink-muted">共 {edgeTip.notes.length} 条关系 · 点开域看明细</div>
          )}
        </div>
      )}

    </div>
  );
}
