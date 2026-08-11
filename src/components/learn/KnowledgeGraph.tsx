/**
 * KnowledgeGraph — 知识图谱（学情可视化 + 自主选点入口）· 知识地图版
 * 布局：章节节点参与建图；点击章节后，前端就地展开其子知识点。
 * 场景驱动（scene prop，由页面级分段控件切换）：
 *   order   学习顺序（默认）—— 只画前置箭头；
 *   network 完整网络 —— 三种关系全开，图例即控件（线型样本 chip，可单独隐藏）；
 *   route   我的路线 —— 前置 + 学习路径叠加。
 * 渐进披露：默认 6 域 + 域级聚合边；点域就地展开子知识点，其余域退为背景。
 * 术语双标：先学它(prereq) / 互相印证(related) / 规范约束(applies)；边 hover 出玻璃浮层说明。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Info } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { useAgent } from '@/context/AgentContext';
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
import { cn } from '@/lib/utils';

/** 术语双标：人话在前（label），行话在后（term，进 hover 提示） */
const EDGE_STYLE: Record<EdgeKind, { stroke: string; width: number; dash?: string; opacity: number; label: string; term: string; hint: string }> = {
  prereq: { stroke: '#5F8870', width: 1.55, opacity: 0.5, label: '先学它', term: 'prereq · 前置', hint: '箭头从 A 指向 B：先学 A 才好学 B' },
  related: { stroke: '#B77552', width: 1.4, dash: '5 4', opacity: 0.5, label: '互相印证', term: 'related · 相关', hint: '两个知识互补或方法同构，一起看更通' },
  applies: { stroke: '#66725E', width: 1.1, dash: '2 4', opacity: 0.45, label: '规范约束', term: 'applies · 应用', hint: '安全规范对实操动作的硬性约束' },
};

export type GraphScene = 'order' | 'network' | 'route';

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
}: {
  n: GraphNode;
  mastery: number;
  target: number;
  learned: boolean;
  recommended: boolean;
  dimmed: boolean;
  selected: boolean;
  expanded: boolean;
}) {
  const stage = growthStage(mastery, target, learned);
  const passed = learned && mastery >= target;
  const scale = (1.5 * n.r) / 56;
  const groundY = n.y + n.r * 0.42;
  const ringR = n.r - 3;
  const targetAngle = (target / 100) * 2 * Math.PI;

  return (
    <g className="cursor-pointer" opacity={dimmed ? 0.28 : 1} style={{ transition: 'opacity 0.25s' }}>
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

/** 子知识点：进度点（不再是迷你植物） */
function TopicDot({ n, mastery, target, learned }: { n: GraphNode; mastery: number; target: number; learned: boolean }) {
  const passed = learned && mastery >= target;
  return (
    <g className="cursor-pointer">
      <circle cx={n.x} cy={n.y} r={n.r} fill="#FBFAF5" stroke={learned ? '#9BC5AC' : '#C4D3C8'} strokeWidth="1.4" />
      {learned ? (
        <path
          d={arcPath(n.x, n.y, n.r - 3.5, mastery / 100)}
          fill="none"
          stroke={passed ? '#E7B45A' : '#4E7860'}
          strokeWidth="5"
          strokeLinecap="round"
          opacity="0.85"
        />
      ) : (
        <circle cx={n.x} cy={n.y} r={n.r - 4} fill="none" stroke="#C4D3C8" strokeWidth="1" strokeDasharray="2 3" opacity="0.8" />
      )}
      <text
        x={n.labelX}
        y={n.labelY}
        textAnchor={n.labelAnchor}
        fontSize="10.5"
        fill="#5A6553"
        stroke="#FBFAF5"
        strokeWidth="2.6"
        strokeLinejoin="round"
        paintOrder="stroke"
        style={{ pointerEvents: 'none' }}
      >
        {n.label}
      </text>
    </g>
  );
}

export default function KnowledgeGraph({
  scene = 'order',
  onSelectKp,
  selectedKpId,
  nodes: nodesProp,
  edges: edgesProp,
  path: pathProp,
  mastery: masteryProp,
  confidence: confidenceProp,
  learned: learnedProp,
  activeKp: activeKpProp,
  onSelectTopic,
}: {
  /** 场景（由页面级分段控件切换）：order 学习顺序 / network 完整网络 / route 我的路线 */
  scene?: GraphScene;
  /** 提供后：点节点 = 选中（联动右栏详情），不直接跳转 */
  onSelectKp?: (kpId: string) => void;
  /** 提供后：点击子知识点时回传其在所属领域内的索引（用于细化资源生成） */
  onSelectTopic?: (topicIndex: number) => void;
  selectedKpId?: string | null;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  path?: PathNode[];
  mastery?: Record<string, number>;
  confidence?: Record<string, number>;
  learned?: Set<string>;
  activeKp?: string | null;
} = {}) {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const { confidence } = useAgent();
  const { countByKp } = useNotes();
  const report = reportForLearner(currentLearner);
  const [hover, setHover] = useState<GraphNode | null>(null);
  /** 边 hover 玻璃浮层（替代浏览器原生 title） */
  const [edgeTip, setEdgeTip] = useState<{ x: number; y: number; kind: EdgeKind; notes: string[] } | null>(null);
  /** 渐进披露：当前展开的域（null = 只看 6 域全景） */
  const [expandedKp, setExpandedKp] = useState<string | null>(null);
  /** 完整网络场景下被临时隐藏的关系类型（图例即控件） */
  const [hiddenKinds, setHiddenKinds] = useState<Set<EdgeKind>>(new Set());
  useEffect(() => { setHiddenKinds(new Set()); setEdgeTip(null); }, [scene]);

  /* 场景 → 边图层 / 路径叠加 */
  const layerOn = (k: EdgeKind): boolean =>
    scene === 'network' ? !hiddenKinds.has(k) : k === 'prereq';
  const showPath = scene === 'route';

  const dataNodes = nodesProp ?? graphNodes;
  const dataEdges = edgesProp ?? graphEdges;
  const reportPath = pathProp ?? report.path;
  const masteryMap = masteryProp ?? {};
  const confMap = confidenceProp ?? confidence;
  const learned = learnedProp ?? useMemo(() => {
    const pathDone = reportPath.filter((p) => p.status === 'done').map((p) => p.kpId);
    return learnedKpIds(currentLearner, pathDone);
  }, [currentLearner, reportPath]);
  const activeKp = activeKpProp ?? reportPath.find((p) => p.status === 'active')?.kpId ?? null;
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
        const from = nodeById.get(edge.from), to = nodeById.get(edge.to);
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
    const departureY = (edge: DomainEdge) => laneOf.get(edgeKey(edge))?.y ?? nodeById.get(edge.to)?.y ?? 0;
    const approachY = (edge: DomainEdge) => laneOf.get(edgeKey(edge))?.y ?? nodeById.get(edge.from)?.y ?? 0;
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
      const targetPortRadius = b.r + (incoming.length > 2 ? 11 : 8);
      const x1 = a.x + Math.cos(sourceAngle) * sourcePortRadius;
      const y1 = a.y + Math.sin(sourceAngle) * sourcePortRadius;
      const x2 = b.x + Math.cos(targetAngle) * targetPortRadius;
      const y2 = b.y + Math.sin(targetAngle) * targetPortRadius;
      const lane = laneOf.get(edgeKey(edge));
      if (lane !== undefined) {
        // 控制点靠近端口，使跨层边快速进入独立车道，避开中间层节点。
        const shoulder = 10 + lane.index * 1.25;
        const obstacleNodes = [...nodeById.values()].filter((node) =>
          node.kind === 'domain' && node.id !== a.id && node.id !== b.id,
        );
        const collisionCount = (laneY: number) => {
          let collisions = 0;
          for (let step = 2; step < 39; step += 1) {
            const t = step / 40, u = 1 - t;
            const px = u ** 3 * x1 + 3 * u ** 2 * t * (x1 + shoulder) + 3 * u * t ** 2 * (x2 - shoulder) + t ** 3 * x2;
            const py = u ** 3 * y1 + 3 * u ** 2 * t * laneY + 3 * u * t ** 2 * laneY + t ** 3 * y2;
            if (obstacleNodes.some((node) => Math.hypot(px - node.x, py - node.y) < node.r + 5)) collisions += 1;
          }
          return collisions;
        };
        const candidates = [lane.y, 112 + lane.index * 7, 224 + lane.index * 7, 336 + lane.index * 7]
          .filter((value) => value > 2 && value < graphViewBox.h - 2);
        const laneY = candidates
          .map((value) => ({ value, collisions: collisionCount(value) }))
          .sort((left, right) => left.collisions - right.collisions || left.value - right.value)[0].value;
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
      const controlOffset = Math.max(24, (x2 - x1) * 0.46);
      return {
        path: `M ${x1} ${y1} C ${x1 + controlOffset} ${y1}, ${x2 - controlOffset} ${y2}, ${x2} ${y2}`,
        mx: (x1 + x2) / 2,
        my: (y1 + y2) / 2,
      };
    };
  }, [aggregatedEdges, nodeById]);
  const prereqOf = (nodeId: string) => dataEdges
    .filter((edge) => edge.kind === 'prereq' && edge.to === nodeId)
    .map((edge) => ({ node: nodeById.get(edge.from)!, note: edge.note ?? '' }))
    .filter((item) => Boolean(item.node));
  const domains = useMemo(() => dataNodes.filter((n) => n.kind === 'domain'), [dataNodes]);
  const expandedTopics = useMemo(
    () => (expandedKp ? dataNodes.filter((n) => n.kind === 'topic' && n.kpId === expandedKp) : []),
    [expandedKp, dataNodes],
  );

  /* 路径叠加：按路径顺序连接域节点（去重保序） */
  const pathChain = useMemo(() => {
    const seq: string[] = [];
    reportPath.forEach((p) => {
      if (!seq.includes(p.kpId)) seq.push(p.kpId);
    });
    return seq.map((id) => nodeById.get(id)!).filter(Boolean);
  }, [reportPath, nodeById]);

  /** 点域：展开/收拢 + 选中（右栏出详情）；点子节点：选中 */
  const clickNode = (n: GraphNode) => {
    if (n.kind === 'domain') setExpandedKp((cur) => (cur === n.kpId ? null : n.kpId));
    if (onSelectKp) onSelectKp(n.kpId);
    if (n.kind === 'topic' && onSelectTopic) onSelectTopic(n.topicIndex ?? 0);
  };

  /** 双击：子知识点按自身 topic id 进入独立课件，不再压缩到父领域前三块。 */
  const openUnit = (n: GraphNode) => {
    if (n.kind === 'domain') return;
    navigate(`/learn/${n.kpId}?unitTopic=${encodeURIComponent(n.id)}`);
  };

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${graphViewBox.w} ${graphViewBox.h}`} className="w-full">
        <GardenDefs />
        <defs>
          <marker id="kg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="#4E7860" opacity="0.65" />
          </marker>
          <marker id="kg-arrow-active" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="#D99B31" opacity="0.9" />
          </marker>
        </defs>

        {/* 域级聚合边（默认视图的全部边） */}
        {(Object.keys(EDGE_STYLE) as EdgeKind[]).map((kind) =>
          layerOn(kind)
            ? domainEdgesOf(kind).map((e) => {
                const a = nodeById.get(e.from)!;
                const b = nodeById.get(e.to)!;
                const st = EDGE_STYLE[kind];
                const route = edgeRouting(e, a, b);
                const edgePath = route.path;
                const highlighted = expandedKp !== null && (e.from === expandedKp || e.to === expandedKp);
                const dim = expandedKp !== null && e.from !== expandedKp && e.to !== expandedKp;
                const mx = route.mx;
                const my = route.my;
                return (
                  <g
                    key={`${kind}-${e.from}-${e.to}`}
                    opacity={dim ? 0.12 : 1}
                    style={{ transition: 'opacity 0.25s' }}
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
                      stroke={highlighted ? '#D99B31' : st.stroke}
                      strokeWidth={st.width + (e.count - 1) * 1.1 + (highlighted ? 0.45 : 0)}
                      strokeDasharray={st.dash}
                      strokeLinecap="round"
                      opacity={highlighted ? 0.9 : st.opacity + 0.1}
                      markerEnd={kind === 'prereq' ? `url(#${highlighted ? 'kg-arrow-active' : 'kg-arrow'})` : undefined}
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

        {/* 路径叠加 */}
        {showPath && pathChain.length > 1 && (
          <g>
            <polyline
              points={pathChain.map((n) => `${n.x},${n.y}`).join(' ')}
              fill="none"
              stroke="#E7B45A"
              strokeWidth="3.5"
              strokeLinejoin="round"
              strokeDasharray="10 7"
              opacity="0.6"
            >
              <animate attributeName="stroke-dashoffset" values="0;-34" dur="1.6s" repeatCount="indefinite" />
            </polyline>
            {pathChain.map((n, i) => (
              <g key={n.id}>
                <circle cx={n.x + n.r - 4} cy={n.y - n.r + 2} r="9" fill="#E7B45A" />
                <text x={n.x + n.r - 4} y={n.y - n.r + 5.5} textAnchor="middle" fontSize="10" fontWeight="700" fill="#FBFAF5" fontFamily="monospace">{i + 1}</text>
              </g>
            ))}
          </g>
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
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(null)}
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

        {/* 展开域的子知识点（进度点） */}
        {expandedTopics.map((n) => {
          const isLearned = learned.has(n.kpId);
          const kp = getKnowledgePoint(n.kpId);
          return (
            <g
              key={n.id}
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(null)}
              onClick={() => clickNode(n)}
              onDoubleClick={() => openUnit(n)}
            >
              <TopicDot n={n} mastery={masteryMap[n.kpId] ?? 50} target={kp.targetLevel} learned={isLearned} />
            </g>
          );
        })}
      </svg>

      {/* 图例即控件：只在「完整网络」出现——chip 长成它控制的线的样子，点击隐藏该类 */}
      {scene === 'network' && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 px-1">
          {(Object.keys(EDGE_STYLE) as EdgeKind[]).map((k) => {
            const st = EDGE_STYLE[k];
            const on = !hiddenKinds.has(k);
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setHiddenKinds((prev) => {
                    const next = new Set(prev);
                    if (next.has(k)) next.delete(k);
                    else next.add(k);
                    return next;
                  })
                }
                title={`${st.hint}（${st.term}）· 点击${on ? '隐藏' : '显示'}这类线`}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-all',
                  on ? 'border-hairline bg-paper text-ink-2' : 'border-hairline/60 bg-paper-deep/40 text-ink-muted/60 line-through',
                )}
              >
                <svg width="24" height="8" viewBox="0 0 24 8" aria-hidden>
                  <line x1="0" y1="4" x2={k === 'prereq' ? 17 : 24} y2="4" stroke={st.stroke} strokeWidth={st.width + 0.6} strokeDasharray={st.dash} strokeLinecap="round" opacity={on ? 1 : 0.4} />
                  {k === 'prereq' && <path d="M 17 0.5 L 24 4 L 17 7.5 Z" fill={st.stroke} opacity={on ? 1 : 0.4} />}
                </svg>
                {st.label}
              </button>
            );
          })}
          <span className="text-[10.5px] text-ink-muted">点线看关系说明 · 点开域看明细</span>
        </div>
      )}

      {/* 边 hover 玻璃浮层（替代浏览器原生 title 黄框） */}
      {edgeTip && (
        <div
          className="lf-glass pointer-events-none absolute z-10 w-[230px] rounded-[12px] p-3"
          style={{
            left: `${Math.min(88, Math.max(8, (edgeTip.x / graphViewBox.w) * 100))}%`,
            top: `${Math.max(2, (edgeTip.y / graphViewBox.h) * 100 - 4)}%`,
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

      {/* hover tooltip */}
      {hover && (
        <div
          className="lf-glass pointer-events-none absolute z-10 w-[240px] rounded-[12px] p-3"
          style={{
            left: `${Math.min(88, Math.max(6, (hover.x / graphViewBox.w) * 100))}%`,
            top: `${Math.max(2, ((hover.y - hover.r) / graphViewBox.h) * 100 - 6)}%`,
            transform: 'translate(-50%, -100%)',
          }}
        >
          <div className="text-[13px] font-semibold text-ink">
            {hover.kind === 'topic' ? getKnowledgePoint(hover.kpId).coreTopics[hover.topicIndex ?? 0] : hover.label}
          </div>
          <div className="mt-1 font-mono text-[10.5px] text-ink-muted">
            {learned.has(hover.kpId)
              ? `掌握 ${masteryMap[hover.kpId] ?? 50} / 目标 ${getKnowledgePoint(hover.kpId).targetLevel} · 置信 ${confMap[hover.kpId] ?? 40}%${hover.kind === 'domain' && (countByKp[hover.kpId] ?? 0) > 0 ? ` · 笔记 ${countByKp[hover.kpId]} 条` : ''}`
              : '尚未学习 · 点击开始'}
          </div>
          {hover.kind === 'topic' && prereqOf(hover.id).length > 0 && (
            <div className="mt-1.5 border-t border-hairline pt-1.5">
              <div className="flex items-center gap-1 text-[10.5px] font-medium text-ochre">
                <Info size={10} />
                建议先过：{prereqOf(hover.id).map((p) => p.node.label).join('、')}
              </div>
            </div>
          )}
          <div className="mt-1 text-[10.5px] text-brand">
            {hover.kind === 'domain'
              ? `点一下 → ${expandedKp === hover.kpId ? '收起子知识点' : '展开子知识点'} · 请选择小圆进入学习`
              : '点一下 → 右边看详情 · 双击 → 直接学习这个最小知识点'}
          </div>
        </div>
      )}
    </div>
  );
}
