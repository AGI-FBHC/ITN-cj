/**
 * KnowledgeGraph3D — Obsidian 风格 3D 知识图谱
 * 特性：
 * - 发光节点（球体）与发光连线（贝塞尔曲线）
 * - 力导向 3D 布局（节点自动分布）
 * - 鼠标交互：拖拽旋转、滚轮缩放、悬停高亮、点击选中
 * - 粒子星空背景
 * - 动态脉冲与呼吸动画
 */
import { useRef, useMemo, useState, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Html, Line, Stars, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import type { GraphNode, GraphEdge, EdgeKind } from '@/data/knowledgeGraph';
import { cn } from '@/lib/utils';

const EDGE_COLORS: Record<EdgeKind, string> = {
  prereq: '#5F8870',
  related: '#B77552',
  applies: '#66725E',
};

const NODE_COLORS = {
  domain: {
    base: '#4E7860',
    hover: '#E7B45A',
    selected: '#2D5A3D',
    learned: '#9BC5AC',
  },
  topic: {
    base: '#83A58F',
    hover: '#D4A373',
    selected: '#5F8870',
    learned: '#B8D4C0',
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

/** 将 2D 图谱坐标转换为 3D 球面分布 */
function use3DLayout(nodes: GraphNode[]) {
  return useMemo(() => {
    const layout = new Map<string, { x: number; y: number; z: number }>();
    const domainNodes = nodes.filter((n) => n.kind === 'domain');
    const topicNodes = nodes.filter((n) => n.kind === 'topic');

    // 域节点分布在球面上
    const radius = 40;
    domainNodes.forEach((node, i) => {
      const phi = Math.acos(-1 + (2 * i) / Math.max(1, domainNodes.length - 1));
      const theta = Math.sqrt(domainNodes.length * Math.PI) * phi;
      layout.set(node.id, {
        x: radius * Math.cos(theta) * Math.sin(phi),
        y: radius * Math.sin(theta) * Math.sin(phi),
        z: radius * Math.cos(phi),
      });
    });

    // 子节点围绕父域节点
    topicNodes.forEach((node) => {
      const parentPos = layout.get(node.kpId);
      if (!parentPos) return;
      const angle = (node.topicIndex ?? 0) * Math.PI * 0.5;
      const dist = 15;
      layout.set(node.id, {
        x: parentPos.x + Math.cos(angle) * dist,
        y: parentPos.y + Math.sin(angle) * dist,
        z: parentPos.z + (Math.random() - 0.5) * 10,
      });
    });

    return layout;
  }, [nodes]);
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
  const glowRef = useRef<THREE.Mesh>(null);
  const isDomain = node.kind === 'domain';
  const colors = isDomain ? NODE_COLORS.domain : NODE_COLORS.topic;

  const color = selected ? colors.selected : hovered ? colors.hover : learned ? colors.learned : colors.base;
  const scale = isDomain ? 1.2 : 0.6;
  const pulseScale = selected ? 1.3 : hovered ? 1.15 : 1;

  useFrame((state) => {
    if (!meshRef.current) return;
    // 呼吸动画
    const breathe = 1 + Math.sin(state.clock.elapsedTime * 2 + position.x) * 0.03;
    meshRef.current.scale.setScalar(scale * breathe * pulseScale);
    
    // 光晕旋转
    if (glowRef.current) {
      glowRef.current.rotation.z = state.clock.elapsedTime * 0.5;
    }
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
        <sphereGeometry args={[node.r * 0.08, 32, 32]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={hovered ? 1.2 : selected ? 0.9 : 0.5}
          roughness={0.15}
          metalness={0.9}
          transparent
          opacity={0.95}
        />
      </mesh>

      {/* 光晕层 */}
      <mesh ref={glowRef} scale={1.4}>
        <sphereGeometry args={[node.r * 0.08, 16, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={hovered ? 0.3 : selected ? 0.25 : 0.12}
          side={THREE.BackSide}
        />
      </mesh>

      {/* 选中脉冲环 */}
      {selected && (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[node.r * 0.12, node.r * 0.15, 32]} />
          <meshBasicMaterial color="#E7B45A" transparent opacity={0.6} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* 标签 */}
      <Html distanceFactor={25} center>
        <div
          className={cn(
            'pointer-events-none select-none whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-medium transition-all duration-200',
            hovered || selected
              ? 'bg-white/95 text-ink shadow-lg scale-110'
              : 'bg-white/70 text-ink-2 shadow-sm',
          )}
          style={{ fontFamily: 'DM Sans, sans-serif' }}
        >
          {node.label}
          {isDomain && mastery > 0 && (
            <span className="ml-1 text-[9px] opacity-70">{mastery}%</span>
          )}
        </div>
      </Html>
    </group>
  );
}

/** 3D 连线组件 */
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
  const points = useMemo(() => {
    const start = new THREE.Vector3(fromPos.x, fromPos.y, fromPos.z);
    const end = new THREE.Vector3(toPos.x, toPos.y, toPos.z);
    const mid = start.clone().lerp(end, 0.5);
    
    // 向外弯曲，避免穿过节点
    const dist = start.distanceTo(end);
    mid.normalize().multiplyScalar(dist * 0.15);
    
    const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
    return curve.getPoints(32);
  }, [fromPos, toPos]);

  const color = EDGE_COLORS[edge.kind];

  return (
    <group>
      <Line
        points={points}
        color={color}
        lineWidth={hovered ? 3 : 1.5}
        transparent
        opacity={hovered ? 0.9 : 0.4}
        dashed={edge.kind === 'related'}
        dashSize={2}
        gapSize={1}
      />
      {/* 发光效果 */}
      {hovered && (
        <Line
          points={points}
          color={color}
          lineWidth={6}
          transparent
          opacity={0.2}
        />
      )}
    </group>
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

  // 找到与悬停节点相关的边
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

  return (
    <>
      {/* 环境光 */}
      <ambientLight intensity={0.4} />
      <pointLight position={[50, 50, 50]} intensity={1} />
      <pointLight position={[-50, -50, -50]} intensity={0.5} color="#9BC5AC" />

      {/* 星空背景 */}
      <Stars radius={100} depth={50} count={3000} factor={4} saturation={0} fade speed={1} />

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
      {nodes.map((node) => {
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
  const layout = use3DLayout(nodes);

  return (
    <div className={cn('relative h-[600px] w-full overflow-hidden rounded-2xl bg-gradient-to-br from-[#0a0f0d] to-[#1a231f]', className)}>
      <Canvas>
        <PerspectiveCamera makeDefault position={[0, 0, 80]} fov={60} />
        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          minDistance={30}
          maxDistance={150}
          autoRotate
          autoRotateSpeed={0.5}
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
      <div className="absolute bottom-4 left-4 rounded-lg bg-black/50 px-3 py-2 text-[11px] text-white/80 backdrop-blur-sm">
        <div>🖱️ 拖拽旋转 · 滚轮缩放 · 点击节点展开</div>
      </div>

      {/* 图例 */}
      <div className="absolute right-4 top-4 flex flex-col gap-2 rounded-lg bg-black/50 p-3 backdrop-blur-sm">
        {(Object.keys(EDGE_COLORS) as EdgeKind[]).map((kind) => (
          <div key={kind} className="flex items-center gap-2 text-[11px] text-white/90">
            <div className="h-0.5 w-6 rounded-full" style={{ backgroundColor: EDGE_COLORS[kind] }} />
            <span>{kind === 'prereq' ? '先学它' : kind === 'related' ? '互相印证' : '规范约束'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
