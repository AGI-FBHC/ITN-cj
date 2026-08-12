/**
 * KnowledgeGraph3D — Obsidian 风格 3D 知识图谱（XMind 分支版）
 * 子节点并列展开，文字在圆圈外部
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

const NODE_COLORS = {
  domain: {
    base: '#4E7860',
    hover: '#E7B45A',
    selected: '#2D5A3D',
    learned: '#6BA080',
  },
  topic: {
    base: '#D4E4D8',
    hover: '#E8C9A0',
    selected: '#9BC5AC',
    learned: '#B8D4C0',
  },
};

const GLOW_COLORS = {
  domain: '#E7B45A',
  topic: '#9BC5AC',
};

const PROGRESS_COLORS = {
  low: '#B8D4C0',
  mid: '#E7B45A',
  high: '#6BA080',
};

interface KnowledgeGraph3DProps {
  onTopicClick?: (kpId: string, topicIndex: number) => void;
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedKpId: string | null;
  expandedKpId: string | null;
  onSelectKp: (id: string | null) => void;
  onSelectTopic: (index: number | null) => void;
  onExpandedKpChange: (id: string | null) => void;
  learned: Set<string>;
  mastery: Record<string, number>;
  topicMastery: Record<string, number>;
  topicProgress: Record<string, number>;
  className?: string;
}

/** 多轴随机缓慢旋转的场景容器 */
function RotatingScene({ children, shouldRotate }: { children: React.ReactNode; shouldRotate: boolean }) {
  const groupRef = useRef<THREE.Group>(null);

  useFrame((state) => {
    if (!groupRef.current || !shouldRotate) return;
    const time = state.clock.elapsedTime * 0.05;
    groupRef.current.rotation.x = Math.sin(time * 0.7) * 0.15;
    groupRef.current.rotation.y = time * 0.3 + Math.sin(time * 0.5) * 0.1;
    groupRef.current.rotation.z = Math.cos(time * 0.6) * 0.08;
  });

  return <group ref={groupRef}>{children}</group>;
}

/** 域节点固定布局（只计算一次） */
function useDomainLayout(nodes: GraphNode[], edges: GraphEdge[]) {
  return useMemo(() => {
    const positions = new Map<string, THREE.Vector3>();
    const domainNodes = nodes.filter((n) => n.kind === 'domain');

    domainNodes.forEach((node, i) => {
      const phi = Math.acos(1 - 2 * (i + 0.5) / domainNodes.length);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const r = 28 + (i * 13 % 8); // 用固定值代替随机数
      positions.set(node.id, new THREE.Vector3(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi) * (0.7 + (i * 7 % 3) * 0.1), // 固定值
      ));
    });

    // 力导向迭代（只影响域节点）
    for (let iter = 0; iter < 80; iter++) {
      const forces = new Map<string, THREE.Vector3>();
      positions.forEach((_, id) => forces.set(id, new THREE.Vector3()));

      const ids = Array.from(positions.keys());
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const p1 = positions.get(ids[i])!;
          const p2 = positions.get(ids[j])!;
          const diff = p1.clone().sub(p2);
          const dist = Math.max(diff.length(), 0.5);
          const force = diff.normalize().multiplyScalar(300 / (dist * dist));
          forces.get(ids[i])!.add(force);
          forces.get(ids[j])!.sub(force);
        }
      }

      edges.forEach((edge) => {
        const p1 = positions.get(edge.from);
        const p2 = positions.get(edge.to);
        if (!p1 || !p2) return;
        const node1 = nodes.find((n) => n.id === edge.from);
        const node2 = nodes.find((n) => n.id === edge.to);
        if (node1?.kind !== 'domain' || node2?.kind !== 'domain') return;
        const diff = p2.clone().sub(p1);
        const dist = diff.length();
        const force = diff.normalize().multiplyScalar(dist * 0.08);
        forces.get(edge.from)!.add(force);
        forces.get(edge.to)!.sub(force);
      });

      positions.forEach((pos, id) => {
        const force = forces.get(id)!;
        pos.add(force.multiplyScalar(0.4));
        const maxR = 45;
        if (pos.length() > maxR) pos.normalize().multiplyScalar(maxR);
      });
    }

    return positions;
  }, [nodes, edges]);
}

/** 3D 布局：固定域节点 + 动态子节点 */
function use3DLayout(nodes: GraphNode[], edges: GraphEdge[], expandedKpId: string | null) {
  const domainLayout = useDomainLayout(nodes, edges);

  return useMemo(() => {
    const positions = new Map(domainLayout);

    // 子节点：XMind 分支式排列
    if (expandedKpId) {
      const parentPos = positions.get(expandedKpId);
      if (parentPos) {
        const children = nodes.filter((n) => n.kind === 'topic' && n.kpId === expandedKpId);
        const startX = parentPos.x + 18;
        const startY = parentPos.y - (children.length - 1) * 4;
        children.forEach((node, i) => {
          positions.set(node.id, new THREE.Vector3(
            startX + (i % 2) * 8,
            startY + i * 8,
            parentPos.z + 2,
          ));
        });
      }
    }

    // 未展开的子节点放在父节点附近但不显示
    nodes.filter((n) => n.kind === 'topic' && n.kpId !== expandedKpId).forEach((node) => {
      const parentPos = positions.get(node.kpId);
      if (!parentPos) return;
      positions.set(node.id, new THREE.Vector3(
        parentPos.x + 10,
        parentPos.y,
        parentPos.z,
      ));
    });

    return positions;
  }, [nodes, expandedKpId, domainLayout]);
}
/** 进度环 */
function ProgressRing({
  radius,
  progress,
  hovered,
  selected,
}: {
  radius: number;
  progress: number;
  hovered: boolean;
  selected: boolean;
}) {
  const ringRef = useRef<THREE.Mesh>(null);
  const color = progress >= 80 ? PROGRESS_COLORS.high : progress >= 50 ? PROGRESS_COLORS.mid : PROGRESS_COLORS.low;

  useFrame(() => {
    if (ringRef.current) {
      ringRef.current.rotation.z = -Math.PI / 2;
    }
  });

  if (progress <= 0) return null;

  const arcLength = (progress / 100) * Math.PI * 2;

  return (
    <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -0.3]}>
      <ringGeometry args={[radius + 0.4, radius + 0.7, 32, 1, 0, arcLength]} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={hovered || selected ? 0.9 : 0.7}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

/** 3D 节点 */
function Node3D({
  node,
  position,
  selected,
  hovered,
  dimmed,
  learned,
  progress,
  onClick,
  onHover,
}: {
  node: GraphNode;
  position: THREE.Vector3;
  selected: boolean;
  hovered: boolean;
  dimmed: boolean;
  learned: boolean;
  progress: number;
  onClick: () => void;
  onHover: (id: string | null) => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const glow1Ref = useRef<THREE.Mesh>(null);
  const glow2Ref = useRef<THREE.Mesh>(null);
  const glow3Ref = useRef<THREE.Mesh>(null);
  const isDomain = node.kind === 'domain';
  const colors = isDomain ? NODE_COLORS.domain : NODE_COLORS.topic;

  const getColor = () => {
    if (selected) return colors.selected;
    if (hovered) return colors.hover;
    if (learned) return colors.learned;
    return colors.base;
  };

  // 子节点圆圈增大
  const baseSize = isDomain ? 3 : 1.5;
  const targetScale = selected ? 1.3 : hovered ? 1.15 : 1;
  const glowColor = GLOW_COLORS[node.kind];

  useFrame((state) => {
    if (!meshRef.current) return;
    const time = state.clock.elapsedTime;
    const breathe = 1 + Math.sin(time * 1.5 + position.x * 0.1) * 0.02;
    const current = meshRef.current.scale.x;
    const target = baseSize * breathe * targetScale;
    meshRef.current.scale.setScalar(THREE.MathUtils.lerp(current, target, 0.1));

    const glowIntensity = dimmed ? 0.1 : hovered ? 1 : selected ? 0.9 : 0.5;
    const pulse = 1 + Math.sin(time * 2 + position.y) * 0.05;

    if (glow1Ref.current) {
      glow1Ref.current.scale.setScalar(baseSize * 1.15 * pulse);
      (glow1Ref.current.material as THREE.MeshBasicMaterial).opacity = 0.3 * glowIntensity;
    }
    if (glow2Ref.current) {
      glow2Ref.current.scale.setScalar(baseSize * 1.35 * pulse);
      (glow2Ref.current.material as THREE.MeshBasicMaterial).opacity = 0.15 * glowIntensity;
    }
    if (glow3Ref.current) {
      glow3Ref.current.scale.setScalar(baseSize * 1.6 * pulse);
      (glow3Ref.current.material as THREE.MeshBasicMaterial).opacity = 0.08 * glowIntensity;
    }
  });

  return (
    <group position={position}>
      {/* 外发光层 */}
      <mesh ref={glow1Ref}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshBasicMaterial color={glowColor} transparent opacity={0.3} depthWrite={false} />
      </mesh>
      <mesh ref={glow2Ref}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshBasicMaterial color={glowColor} transparent opacity={0.15} depthWrite={false} />
      </mesh>
      <mesh ref={glow3Ref}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshBasicMaterial color={glowColor} transparent opacity={0.08} depthWrite={false} />
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
        <sphereGeometry args={[1, 64, 64]} />
        <meshBasicMaterial
          color={getColor()}
          transparent
          opacity={dimmed ? 0.2 : 0.95}
        />
      </mesh>

      {/* 进度描边 */}
      <ProgressRing radius={baseSize} progress={progress} hovered={hovered} selected={selected} />

      {/* 标签：子节点文字放在圆圈外部（右侧），像 XMind */}
      <Html
        distanceFactor={16}
        position={isDomain ? [0, 0, 0] : [2.5, 0, 0]} // 子节点文字在右侧
        center={isDomain}
      >
        <div
          className={`pointer-events-none select-none whitespace-nowrap font-semibold transition-all duration-200 ${
            dimmed ? 'opacity-10' : hovered || selected ? 'opacity-100 scale-110' : 'opacity-90'
          } ${isDomain ? 'text-center' : 'text-left'}`}
          style={{
            color: '#3D4A3A',
            fontSize: isDomain ? '18px' : '14px',
            textShadow: '0 1px 2px rgba(247,245,238,0.8), 0 0 6px rgba(247,245,238,0.5)',
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
  fromPos,
  toPos,
  color,
  hovered,
  dimmed,
  dashed,
  isChildLink,
}: {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  color: string;
  hovered: boolean;
  dimmed: boolean;
  dashed?: boolean;
  isChildLink?: boolean;
}) {
  const points = useMemo(() => [fromPos, toPos], [fromPos, toPos]);
  return (
    <Line
      points={points}
      color={color}
      lineWidth={isChildLink ? 2 : hovered ? 3.5 : 2}
      transparent
      opacity={dimmed ? 0.06 : hovered ? 0.9 : isChildLink ? 0.5 : 0.35}
      dashed={dashed}
      dashSize={1.5}
      gapSize={0.8}
    />
  );
}

/** 场景 */
function SceneContent({
  onTopicClick,
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
  topicMastery,
  topicProgress,
}: {
  onTopicClick?: (kpId: string, topicIndex: number) => void;
  nodes: GraphNode[];
  edges: GraphEdge[];
  layout: Map<string, THREE.Vector3>;
  selectedKpId: string | null;
  expandedKpId: string | null;
  onSelectKp: (id: string | null) => void;
  onSelectTopic: (index: number | null) => void;
  onExpandedKpChange: (id: string | null) => void;
  learned: Set<string>;
  mastery: Record<string, number>;
  topicMastery: Record<string, number>;
  topicProgress: Record<string, number>;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      if (node.kind === 'domain') {
        onSelectKp(node.id);
        onExpandedKpChange(expandedKpId === node.id ? null : node.id);
      } else {
        onSelectTopic(node.topicIndex ?? null);
        onTopicClick?.(node.kpId, node.topicIndex ?? 0);
      }
    },
    [expandedKpId, onSelectKp, onSelectTopic, onExpandedKpChange],
  );

  const relatedEdges = useMemo(() => {
    if (!hoveredId) return new Set<string>();
    const set = new Set<string>();
    edges.forEach((e) => {
      if (e.from === hoveredId || e.to === hoveredId) set.add(`${e.from}-${e.to}`);
    });
    return set;
  }, [hoveredId, edges]);

  const relatedNodes = useMemo(() => {
    if (!hoveredId) return new Set<string>();
    const set = new Set([hoveredId]);
    edges.forEach((e) => {
      if (e.from === hoveredId) set.add(e.to);
      if (e.to === hoveredId) set.add(e.from);
    });
    return set;
  }, [hoveredId, edges]);

  const visibleNodes = useMemo(() => {
    return nodes.filter((n) => {
      if (n.kind === 'domain') return true;
      return expandedKpId === n.kpId;
    });
  }, [nodes, expandedKpId]);

  const childLinks = useMemo(() => {
    if (!expandedKpId) return [];
    const parentPos = layout.get(expandedKpId);
    if (!parentPos) return [];
    return nodes
      .filter((n) => n.kind === 'topic' && n.kpId === expandedKpId)
      .map((n) => ({
        id: `${expandedKpId}-${n.id}`,
        from: parentPos,
        to: layout.get(n.id),
      }))
      .filter((l) => l.to);
  }, [expandedKpId, nodes, layout]);

  return (
    <>
      <ambientLight intensity={0.7} />
      <directionalLight position={[25, 25, 25]} intensity={0.6} />

      {/* 语义边 */}
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
            fromPos={p1}
            toPos={p2}
            color={EDGE_COLORS[edge.kind]}
            hovered={isRelated}
            dimmed={!!isDimmed}
            dashed={edge.kind === 'related'}
          />
        );
      })}

      {/* 子节点到父节点的连线 */}
      {childLinks.map((link) => (
        <Edge3D
          key={link.id}
          fromPos={link.from}
          toPos={link.to!}
          color="#83A58F"
          hovered={false}
          dimmed={false}
          isChildLink
        />
      ))}

      {/* 节点 */}
      {visibleNodes.map((node) => {
        const pos = layout.get(node.id);
        if (!pos) return null;
        const isRelated = relatedNodes.has(node.id);
        const isDimmed = hoveredId && !isRelated;
        
        let progress = 0;
        if (node.kind === 'domain') {
          progress = mastery[node.kpId] ?? 0;
        } else {
          progress = topicProgress[node.id] ?? topicMastery[node.id] ?? 0;
        }
        
        return (
          <Node3D
            key={node.id}
            node={node}
            position={pos}
            selected={selectedKpId === node.id || expandedKpId === node.id}
            hovered={hoveredId === node.id}
            dimmed={!!isDimmed}
            learned={learned.has(node.kpId)}
            progress={progress}
            onClick={() => handleNodeClick(node)}
            onHover={setHoveredId}
          />
        );
      })}
    </>
  );
}

export default function KnowledgeGraph3D({
  onTopicClick,
  nodes,
  edges,
  selectedKpId,
  expandedKpId,
  onSelectKp,
  onSelectTopic,
  onExpandedKpChange,
  learned,
  mastery,
  topicMastery,
  topicProgress,
  className,
}: KnowledgeGraph3DProps) {
  const layout = use3DLayout(nodes, edges, expandedKpId);

  return (
    <div
      className={`relative h-[600px] w-full overflow-hidden rounded-2xl border border-hairline bg-gradient-to-br from-paper via-[#F5F3EA] to-brand-tint/20 ${className}`}
      onWheel={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
    >
      <Canvas>
        <PerspectiveCamera makeDefault position={[0, 0, 75]} fov={45} />
        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          minDistance={20}
          maxDistance={130}
          autoRotate={false}
        />
        <RotatingScene shouldRotate={!expandedKpId}>
          <SceneContent
            onTopicClick={onTopicClick}
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
            topicMastery={topicMastery}
            topicProgress={topicProgress}
          />
        </RotatingScene>
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



