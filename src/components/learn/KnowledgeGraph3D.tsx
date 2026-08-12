/**
 * KnowledgeGraph3D — Obsidian 风格 3D 知识图谱（主题适配版）
 * 特性：
 * - 奶油色背景，适配柔绿治愈系主题
 * - 发光节点 + 直线连接，简洁不杂乱
 * - 大号文字直接显示，无背景框
 * - 交互：旋转、缩放、悬停高亮、点击展开
 */
import { useRef, useMemo, useState, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Html, Line, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import type { GraphNode, GraphEdge, EdgeKind } from '@/data/knowledgeGraph';
import { cn } from '@/lib/utils';

const EDGE_COLORS: Record<EdgeKind, string> = {
  prereq: '#4E7860',
  related: '#B77552',
  applies: '#66725E',
};

const NODE_COLORS = {
  domain: {
    base: '#9BC5AC',
    hover: '#E7B45A',
    selected: '#4E7860',
    learned: '#6BA080',
  },
  topic: {
    base: '#B8D4C0',
    hover: '#D4A373',
    selected: '#83A58F',
    learned: '#9BC5AC',
  },
};

interface KnowledgeGraph3DProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedKpId: string | null;
  expandedKpId: string | null;
  onSelectKp: (id: string | null) => void;
  onSelectTopic: (index: number | null) => void;
  onExpandedKpChange: (id: string | null) => void;
  learned: Set<string>;
  mastery: Record<string, number>;
  className?: string;
}

/** 3D 布局：域节点环形分布，子节点围绕父域 */
function use3DLayout(nodes: GraphNode[], expandedKpId: string | null) {
  return useMemo(() => {
    const layout = new Map<string, { x: number; y: number; z: number }>();
    const domainNodes = nodes.filter((n) => n.kind === 'domain');
    const topicNodes = nodes.filter((n) => n.kind === 'topic');

    // 域节点环形分布
    const radius = 35;
    domainNodes.forEach((node, i) => {
      const angle = (i / domainNodes.length) * Math.PI * 2;
      layout.set(node.id, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        z: 0,
      });
    });

    // 只显示展开域的子节点
    if (expandedKpId) {
      const parentPos = layout.get(expandedKpId);
      const children = topicNodes.filter((n) => n.kpId === expandedKpId);
      children.forEach((node, i) => {
        if (!parentPos) return;
        const angle = (i / children.length) * Math.PI * 2;
        const dist = 18;
        layout.set(node.id, {
          x: parentPos.x + Math.cos(angle) * dist,
          y: parentPos.y + Math.sin(angle) * dist,
          z: parentPos.z + 5,
        });
      });
    }

    return layout;
  }, [nodes, expandedKpId]);
}

/** 3D 节点组件 */
function Node3D({
  node,
  position,
  selected,
  hovered,
  learned,
  mastery,
  onClick,
  onHover,
}: {
  node: GraphNode;
  position: { x: number; y: number; z: number };
  selected: boolean;
  hovered: boolean;
  learned: boolean;
  mastery: number;
  onClick: () => void;
  onHover: (id: string | null) => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const isDomain = node.kind === 'domain';
  const colors = isDomain ? NODE_COLORS.domain : NODE_COLORS.topic;

  const color = selected ? colors.selected : hovered ? colors.hover : learned ? colors.learned : colors.base;
  const baseScale = isDomain ? 1.5 : 0.8;
  const pulseScale = selected ? 1.2 : hovered ? 1.1 : 1;

  useFrame((state) => {
    if (!meshRef.current) return;
    const breathe = 1 + Math.sin(state.clock.elapsedTime * 2 + position.x) * 0.03;
    meshRef.current.scale.setScalar(baseScale * breathe * pulseScale);
  });

  return (
    <group position={[position.x, position.y, position.z]}>
      {/* 主球体 */}
      <mesh
        ref={meshRef}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          onHover(node.id);
        }}
        onPointerOut={() => onHover(null)}
      >
        <sphereGeometry args={[node.r * 0.06, 32, 32]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={hovered ? 0.8 : selected ? 0.6 : 0.3}
          roughness={0.3}
          metalness={0.2}
        />
      </mesh>

      {/* 选中光环 */}
      {selected && (
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -0.5]}>
          <ringGeometry args={[node.r * 0.08, node.r * 0.1, 32]} />
          <meshBasicMaterial color="#E7B45A" transparent opacity={0.6} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* 标签：大号文字，无背景框，深色高对比 */}
      <Html distanceFactor={20} center>
        <div
          className={cn(
            'pointer-events-none select-none whitespace-nowrap text-center font-semibold transition-all duration-200',
            hovered || selected ? 'text-[16px] text-ink scale-110' : 'text-[13px] text-ink-2',
          )}
          style={{ 
            fontFamily: 'DM Sans, sans-serif',
            textShadow: '0 1px 2px rgba(247, 245, 238, 0.8), 0 0 8px rgba(247, 245, 238, 0.6)',
          }}
        >
          {node.label}
          {isDomain && mastery > 0 && (
            <div className="text-[11px] font-normal text-ink-muted">{mastery}%</div>
          )}
        </div>
      </Html>
    </group>
  );
}

/** 3D 连线组件（直线） */
function Edge3D({
  edge,
  fromPos,
  toPos,
  hovered,
}: {
  edge: GraphEdge;
  fromPos: { x: number; y: number; z: number };
  toPos: { x: number; y: number; z: number };
  hovered: boolean;
}) {
  const color = EDGE_COLORS[edge.kind];
  const points = useMemo(() => [
    new THREE.Vector3(fromPos.x, fromPos.y, fromPos.z),
    new THREE.Vector3(toPos.x, toPos.y, toPos.z),
  ], [fromPos, toPos]);

  return (
    <Line
      points={points}
      color={color}
      lineWidth={hovered ? 2.5 : 1.5}
      transparent
      opacity={hovered ? 0.9 : 0.5}
      dashed={edge.kind === 'related'}
      dashSize={1.5}
      gapSize={0.8}
    />
  );
}

/** 场景内容 */
function SceneContent({
  nodes,
  edges,
  layout,
  selectedKpId,
  expandedKpId,
  onSelectKp,
  onSelectTopic,
  onExpandedKpChange,
  learned,
  mastery,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layout: Map<string, { x: number; y: number; z: number }>;
  selectedKpId: string | null;
  expandedKpId: string | null;
  onSelectKp: (id: string | null) => void;
  onSelectTopic: (index: number | null) => void;
  onExpandedKpChange: (id: string | null) => void;
  learned: Set<string>;
  mastery: Record<string, number>;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      if (node.kind === 'domain') {
        onSelectKp(node.id);
        onExpandedKpChange(expandedKpId === node.id ? null : node.id);
      } else {
        onSelectTopic(node.topicIndex ?? null);
      }
    },
    [expandedKpId, onSelectKp, onSelectTopic, onExpandedKpChange],
  );

  const connectedEdges = useMemo(() => {
    if (!hoveredId) return new Set<string>();
    const related = new Set<string>();
    edges.forEach((edge) => {
      if (edge.from === hoveredId || edge.to === hoveredId) {
        related.add(`${edge.from}-${edge.to}`);
      }
    });
    return related;
  }, [hoveredId, edges]);

  // 只渲染有位置的节点（展开的子节点）
  const visibleNodes = useMemo(() => {
    return nodes.filter((node) => layout.has(node.id));
  }, [nodes, layout]);

  return (
    <>
      {/* 环境光 */}
      <ambientLight intensity={0.6} />
      <directionalLight position={[20, 20, 20]} intensity={0.8} />
      <directionalLight position={[-20, -20, 10]} intensity={0.4} color="#9BC5AC" />

      {/* 渲染边 */}
      {edges.map((edge) => {
        const fromPos = layout.get(edge.from);
        const toPos = layout.get(edge.to);
        if (!fromPos || !toPos) return null;
        const edgeKey = `${edge.from}-${edge.to}`;
        return (
          <Edge3D
            key={edgeKey}
            edge={edge}
            fromPos={fromPos}
            toPos={toPos}
            hovered={connectedEdges.has(edgeKey)}
          />
        );
      })}

      {/* 渲染节点 */}
      {visibleNodes.map((node) => {
        const position = layout.get(node.id);
        if (!position) return null;
        return (
          <Node3D
            key={node.id}
            node={node}
            position={position}
            selected={selectedKpId === node.id || expandedKpId === node.id}
            hovered={hoveredId === node.id}
            learned={learned.has(node.kpId)}
            mastery={mastery[node.kpId] ?? 0}
            onClick={() => handleNodeClick(node)}
            onHover={setHoveredId}
          />
        );
      })}
    </>
  );
}

export default function KnowledgeGraph3D({
  nodes,
  edges,
  selectedKpId,
  expandedKpId,
  onSelectKp,
  onSelectTopic,
  onExpandedKpChange,
  learned,
  mastery,
  className,
}: KnowledgeGraph3DProps) {
  const layout = use3DLayout(nodes, expandedKpId);

  return (
    <div className={cn('relative h-[600px] w-full overflow-hidden rounded-2xl border border-hairline bg-gradient-to-br from-paper via-paper-deep to-brand-tint/30', className)}>
      <Canvas>
        <PerspectiveCamera makeDefault position={[0, 0, 70]} fov={50} />
        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          minDistance={30}
          maxDistance={120}
          autoRotate
          autoRotateSpeed={0.3}
        />
        <SceneContent
          nodes={nodes}
          edges={edges}
          layout={layout}
          selectedKpId={selectedKpId}
          expandedKpId={expandedKpId}
          onSelectKp={onSelectKp}
          onSelectTopic={onSelectTopic}
          onExpandedKpChange={onExpandedKpChange}
          learned={learned}
          mastery={mastery}
        />
      </Canvas>

      {/* 操作提示 */}
      <div className="absolute bottom-4 left-4 rounded-lg bg-white/80 px-3 py-2 text-[11px] text-ink-muted backdrop-blur-sm border border-hairline/50">
        <div>🖱️ 拖拽旋转 · 滚轮缩放 · 点击章节展开子知识点</div>
      </div>

      {/* 图例 */}
      <div className="absolute right-4 top-4 flex flex-col gap-2 rounded-lg bg-white/80 p-3 backdrop-blur-sm border border-hairline/50">
        {(Object.keys(EDGE_COLORS) as EdgeKind[]).map((kind) => (
          <div key={kind} className="flex items-center gap-2 text-[11px] text-ink-2">
            <div className="h-0.5 w-6 rounded-full" style={{ backgroundColor: EDGE_COLORS[kind] }} />
            <span>{kind === 'prereq' ? '先学它' : kind === 'related' ? '互相印证' : '规范约束'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
