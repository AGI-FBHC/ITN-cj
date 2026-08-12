/**
 * KnowledgeGraph3D — Obsidian 风格 3D 知识图谱（力导向网络版）
 * 真正的 3D 空间分布，节点间引力/斥力自然形成网络
 */
import { useRef, useMemo, useState, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Html, Line, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import type { GraphNode, GraphEdge, EdgeKind } from '@/data/knowledgeGraph';

const EDGE_COLORS: Record<EdgeKind, string> = {
  prereq: '#4E7860',
  related: '#B77552',
  applies: '#66725E',
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

/** 3D 力导向布局：节点在三维空间中自然分布 */
function use3DLayout(nodes: GraphNode[], edges: GraphEdge[]) {
  return useMemo(() => {
    const positions = new Map<string, THREE.Vector3>();
    const domainNodes = nodes.filter((n) => n.kind === 'domain');

    // 初始化：域节点在球面上随机分布，避免平面感
    domainNodes.forEach((node, i) => {
      const phi = Math.acos(1 - 2 * (i + 0.5) / domainNodes.length);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const r = 30 + Math.random() * 10;
      positions.set(node.id, new THREE.Vector3(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi) * (0.6 + Math.random() * 0.4),
      ));
    });

    // 子节点在父节点附近随机偏移
    nodes.filter((n) => n.kind === 'topic').forEach((node) => {
      const parentPos = positions.get(node.kpId);
      if (!parentPos) return;
      const offset = new THREE.Vector3(
        (Math.random() - 0.5) * 25,
        (Math.random() - 0.5) * 25,
        (Math.random() - 0.5) * 15,
      );
      positions.set(node.id, parentPos.clone().add(offset));
    });

    // 简化的力导向迭代
    for (let iter = 0; iter < 50; iter++) {
      const forces = new Map<string, THREE.Vector3>();
      positions.forEach((_, id) => forces.set(id, new THREE.Vector3()));

      // 斥力：所有节点互相排斥
      const ids = Array.from(positions.keys());
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const p1 = positions.get(ids[i])!;
          const p2 = positions.get(ids[j])!;
          const diff = p1.clone().sub(p2);
          const dist = Math.max(diff.length(), 1);
          const force = diff.normalize().multiplyScalar(200 / (dist * dist));
          forces.get(ids[i])!.add(force);
          forces.get(ids[j])!.sub(force);
        }
      }

      // 引力：边连接的两端互相吸引
      edges.forEach((edge) => {
        const p1 = positions.get(edge.from);
        const p2 = positions.get(edge.to);
        if (!p1 || !p2) return;
        const diff = p2.clone().sub(p1);
        const dist = diff.length();
        const force = diff.normalize().multiplyScalar(dist * 0.05);
        forces.get(edge.from)!.add(force);
        forces.get(edge.to)!.sub(force);
      });

      // 应用力
      positions.forEach((pos, id) => {
        const force = forces.get(id)!;
        pos.add(force.multiplyScalar(0.5));
        // 限制范围
        const maxR = 50;
        if (pos.length() > maxR) pos.normalize().multiplyScalar(maxR);
      });
    }

    return positions;
  }, [nodes, edges]);
}

/** 3D 节点：发光球体 + 光晕 */
function Node3D({
  node,
  position,
  selected,
  hovered,
  dimmed,
  learned,
  onClick,
  onHover,
}: {
  node: GraphNode;
  position: THREE.Vector3;
  selected: boolean;
  hovered: boolean;
  dimmed: boolean;
  learned: boolean;
  onClick: () => void;
  onHover: (id: string | null) => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const isDomain = node.kind === 'domain';

  // 颜色逻辑
  const getColor = () => {
    if (selected) return '#4E7860';
    if (hovered) return '#E7B45A';
    if (learned) return '#6BA080';
    return isDomain ? '#83A58F' : '#B8D4C0';
  };

  const baseSize = isDomain ? 2.5 : 1.2;
  const targetScale = selected ? 1.4 : hovered ? 1.2 : 1;

  useFrame((state) => {
    if (!meshRef.current) return;
    // 呼吸动画
    const breathe = 1 + Math.sin(state.clock.elapsedTime * 1.5 + position.x * 0.1) * 0.05;
    const current = meshRef.current.scale.x;
    const target = baseSize * breathe * targetScale;
    meshRef.current.scale.setScalar(THREE.MathUtils.lerp(current, target, 0.1));

    // 光晕脉动
    if (glowRef.current) {
      const glowPulse = 1 + Math.sin(state.clock.elapsedTime * 2 + position.y) * 0.15;
      glowRef.current.scale.setScalar(baseSize * 1.8 * glowPulse);
      (glowRef.current.material as THREE.MeshBasicMaterial).opacity = 
        dimmed ? 0.05 : hovered ? 0.25 : selected ? 0.2 : 0.1;
    }
  });

  return (
    <group position={position}>
      {/* 光晕 */}
      <mesh ref={glowRef}>
        <sphereGeometry args={[1, 16, 16]} />
        <meshBasicMaterial
          color={getColor()}
          transparent
          opacity={0.1}
          side={THREE.BackSide}
          depthWrite={false}
        />
      </mesh>

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
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          onHover(null);
          document.body.style.cursor = 'default';
        }}
      >
        <sphereGeometry args={[1, 32, 32]} />
        <meshStandardMaterial
          color={getColor()}
          emissive={getColor()}
          emissiveIntensity={hovered ? 0.9 : selected ? 0.7 : 0.3}
          roughness={0.2}
          metalness={0.6}
          transparent
          opacity={dimmed ? 0.3 : 0.95}
        />
      </mesh>

      {/* 标签 */}
      <Html distanceFactor={15} center>
        <div
          className={`pointer-events-none select-none whitespace-nowrap text-center font-medium transition-all duration-200 ${
            dimmed ? 'opacity-20' : hovered || selected ? 'opacity-100 scale-110' : 'opacity-80'
          }`}
          style={{
            color: hovered || selected ? '#3D4A3A' : '#5A6553',
            fontSize: isDomain ? '14px' : '12px',
            textShadow: '0 1px 3px rgba(247,245,238,0.9), 0 0 12px rgba(247,245,238,0.7)',
          }}
        >
          {node.label}
        </div>
      </Html>
    </group>
  );
}

/** 3D 连线 */
function Edge3D({
  edge,
  fromPos,
  toPos,
  hovered,
  dimmed,
}: {
  edge: GraphEdge;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  hovered: boolean;
  dimmed: boolean;
}) {
  const points = useMemo(() => [fromPos, toPos], [fromPos, toPos]);
  const color = EDGE_COLORS[edge.kind];

  return (
    <Line
      points={points}
      color={color}
      lineWidth={hovered ? 3 : 1}
      transparent
      opacity={dimmed ? 0.1 : hovered ? 0.9 : 0.4}
      dashed={edge.kind === 'related'}
      dashSize={2}
      gapSize={1}
    />
  );
}

/** 场景 */
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
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layout: Map<string, THREE.Vector3>;
  selectedKpId: string | null;
  expandedKpId: string | null;
  onSelectKp: (id: string | null) => void;
  onSelectTopic: (index: number | null) => void;
  onExpandedKpChange: (id: string | null) => void;
  learned: Set<string>;
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

  // 与悬停节点相关的边
  const relatedEdges = useMemo(() => {
    if (!hoveredId) return new Set<string>();
    const set = new Set<string>();
    edges.forEach((e) => {
      if (e.from === hoveredId || e.to === hoveredId) set.add(`${e.from}-${e.to}`);
    });
    return set;
  }, [hoveredId, edges]);

  // 与悬停节点相关的节点
  const relatedNodes = useMemo(() => {
    if (!hoveredId) return new Set<string>();
    const set = new Set([hoveredId]);
    edges.forEach((e) => {
      if (e.from === hoveredId) set.add(e.to);
      if (e.to === hoveredId) set.add(e.from);
    });
    return set;
  }, [hoveredId, edges]);

  // 只显示展开的子节点
  const visibleNodes = useMemo(() => {
    return nodes.filter((n) => {
      if (n.kind === 'domain') return true;
      return expandedKpId === n.kpId;
    });
  }, [nodes, expandedKpId]);

  return (
    <>
      <ambientLight intensity={0.5} />
      <pointLight position={[30, 30, 30]} intensity={1} />
      <pointLight position={[-30, -30, 20]} intensity={0.5} color="#9BC5AC" />

      {/* 边 */}
      {edges.map((edge) => {
        const p1 = layout.get(edge.from);
        const p2 = layout.get(edge.to);
        if (!p1 || !p2) return null;
        const key = `${edge.from}-${edge.to}`;
        const isRelated = relatedEdges.has(key);
        const isDimmed = hoveredId && !isRelated;
        return (
          <Edge3D
            key={key}
            edge={edge}
            fromPos={p1}
            toPos={p2}
            hovered={isRelated}
            dimmed={!!isDimmed}
          />
        );
      })}

      {/* 节点 */}
      {visibleNodes.map((node) => {
        const pos = layout.get(node.id);
        if (!pos) return null;
        const isRelated = relatedNodes.has(node.id);
        const isDimmed = hoveredId && !isRelated;
        return (
          <Node3D
            key={node.id}
            node={node}
            position={pos}
            selected={selectedKpId === node.id || expandedKpId === node.id}
            hovered={hoveredId === node.id}
            dimmed={!!isDimmed}
            learned={learned.has(node.kpId)}
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
  className,
}: KnowledgeGraph3DProps) {
  const layout = use3DLayout(nodes, edges);

  return (
    <div className={`relative h-[600px] w-full overflow-hidden rounded-2xl border border-hairline bg-gradient-to-br from-paper via-[#F5F3EA] to-brand-tint/20 ${className}`}>
      <Canvas>
        <PerspectiveCamera makeDefault position={[0, 0, 80]} fov={45} />
        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          minDistance={20}
          maxDistance={150}
          autoRotate
          autoRotateSpeed={0.4}
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
        />
      </Canvas>

      {/* 提示 */}
      <div className="absolute bottom-4 left-4 rounded-lg bg-white/90 px-3 py-2 text-[11px] text-ink-muted backdrop-blur-sm border border-hairline/50">
        🖱️ 拖拽旋转 · 滚轮缩放 · 悬停查看关联 · 点击章节展开
      </div>

      {/* 图例 */}
      <div className="absolute right-4 top-4 flex flex-col gap-2 rounded-lg bg-white/90 p-3 backdrop-blur-sm border border-hairline/50">
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
