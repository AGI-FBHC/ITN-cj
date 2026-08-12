/**
 * KnowledgeGraph3D — Obsidian 风格 3D 知识图谱（智能展开版）
 * 子节点自动选择空旷方向展开，文字跟随方向
 */
import { useRef, useMemo, useState, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Text, Line, PerspectiveCamera, Billboard } from '@react-three/drei';
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
  onTopicClick?: (kpId: string, topicIndex: number, label: string) => void;
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

/** 边缘发光 Shader */
const glowVertexShader = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const innerGlowFragmentShader = `
  uniform vec3 color;
  uniform vec3 glowColor;
  uniform float intensity;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    float fresnel = pow(1.0 - abs(dot(vNormal, vViewDir)), 3.0);
    vec3 finalColor = mix(color, glowColor, fresnel * intensity);
    gl_FragColor = vec4(finalColor, fresnel * 0.6 * intensity);
  }
`;

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

/** 域节点固定布局 */
function useDomainLayout(nodes: GraphNode[], edges: GraphEdge[]) {
  return useMemo(() => {
    const positions = new Map<string, THREE.Vector3>();
    const domainNodes = nodes.filter((n) => n.kind === 'domain');

    domainNodes.forEach((node, i) => {
      const phi = Math.acos(1 - 2 * (i + 0.5) / domainNodes.length);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const r = 28 + (i * 13 % 8);
      positions.set(node.id, new THREE.Vector3(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi) * (0.7 + (i * 7 % 3) * 0.1),
      ));
    });

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

/** 计算最空旷的展开方向 */
function findBestDirection(
  parentPos: THREE.Vector3,
  allPositions: Map<string, THREE.Vector3>,
  expandedKpId: string,
): { direction: 'left' | 'right' | 'top' | 'bottom'; offset: THREE.Vector3 } {
  const directions = [
    { name: 'right' as const, offset: new THREE.Vector3(20, 0, 0) },
    { name: 'left' as const, offset: new THREE.Vector3(-20, 0, 0) },
    { name: 'top' as const, offset: new THREE.Vector3(0, 20, 0) },
    { name: 'bottom' as const, offset: new THREE.Vector3(0, -20, 0) },
  ];

  let bestDirection = directions[0];
  let minDensity = Infinity;

  directions.forEach((dir) => {
    const testPos = parentPos.clone().add(dir.offset);
    let density = 0;

    allPositions.forEach((pos, id) => {
      if (id === expandedKpId) return;
      const dist = testPos.distanceTo(pos);
      if (dist < 25) {
        density += 1 / Math.max(dist, 1);
      }
    });

    if (density < minDensity) {
      minDensity = density;
      bestDirection = dir;
    }
  });

  return { direction: bestDirection.name, offset: bestDirection.offset };
}

/** 3D 布局：固定域节点 + 智能子节点展开 */
function use3DLayout(nodes: GraphNode[], edges: GraphEdge[], expandedKpId: string | null) {
  const domainLayout = useDomainLayout(nodes, edges);

  return useMemo(() => {
    const positions = new Map(domainLayout);
    const childDirections = new Map<string, 'left' | 'right' | 'top' | 'bottom'>();

    if (expandedKpId) {
      const parentPos = positions.get(expandedKpId);
      if (parentPos) {
        const { direction, offset } = findBestDirection(parentPos, positions, expandedKpId);
        const children = nodes.filter((n) => n.kind === 'topic' && n.kpId === expandedKpId);
        
        // 根据方向计算子节点位置
        const isHorizontal = direction === 'left' || direction === 'right';
        const sign = direction === 'left' || direction === 'top' ? -1 : 1;
        
        children.forEach((node, i) => {
          const basePos = parentPos.clone().add(offset);
          let childPos: THREE.Vector3;
          
          if (isHorizontal) {
            // 水平展开：垂直排列
            childPos = new THREE.Vector3(
              basePos.x + (i % 2) * 8 * sign,
              basePos.y + (i - (children.length - 1) / 2) * 8,
              basePos.z + 2,
            );
          } else {
            // 垂直展开：水平排列
            childPos = new THREE.Vector3(
              basePos.x + (i - (children.length - 1) / 2) * 8,
              basePos.y + (i % 2) * 8 * sign,
              basePos.z + 2,
            );
          }
          
          positions.set(node.id, childPos);
          childDirections.set(node.id, direction);
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

    return { positions, childDirections };
  }, [nodes, expandedKpId, domainLayout]);
}

/** 方向指示小球 */
function DirectionMarker({ position, color, visible }: { position: THREE.Vector3; color: string; visible: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  
  useFrame((state) => {
    if (ref.current) {
      const scale = 0.3 + Math.sin(state.clock.elapsedTime * 3) * 0.1;
      ref.current.scale.setScalar(scale);
    }
  });
  
  if (!visible) return null;
  
  return (
    <mesh ref={ref} position={position}>
      <sphereGeometry args={[1, 16, 16]} />
      <meshBasicMaterial color={color} transparent opacity={0.8} />
    </mesh>
  );
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
  direction,
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
  direction?: 'left' | 'right' | 'top' | 'bottom';
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

  // 根据方向计算文字位置
  const getTextPosition = (): [number, number, number] => {
    if (isDomain) return [0, 0, 4];
    
    switch (direction) {
      case 'left': return [-3.5, 0, 3];
      case 'right': return [3.5, 0, 3];
      case 'top': return [0, 3.5, 3];
      case 'bottom': return [0, -3.5, 3];
      default: return [3.5, 0, 3];
    }
  };

  // 根据方向计算文字锚点
  const getTextAnchor = (): { x: 'left' | 'center' | 'right'; y: 'top' | 'middle' | 'bottom' } => {
    if (isDomain) return { x: 'center', y: 'middle' };
    
    switch (direction) {
      case 'left': return { x: 'right', y: 'middle' };
      case 'right': return { x: 'left', y: 'middle' };
      case 'top': return { x: 'center', y: 'bottom' };
      case 'bottom': return { x: 'center', y: 'top' };
      default: return { x: 'left', y: 'middle' };
    }
  };

  const textAnchor = getTextAnchor();

  return (
    <group
      position={position}
      onPointerEnter={(e) => {
        e.stopPropagation();
        onHover(node.id);
        document.body.style.cursor = 'pointer';
      }}
      onPointerLeave={() => {
        onHover(null);
        document.body.style.cursor = 'default';
      }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
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
      <mesh ref={meshRef}>
        <sphereGeometry args={[1, 64, 64]} />
        <meshBasicMaterial
          color={getColor()}
          transparent={dimmed}
          opacity={dimmed ? 0.2 : 1}
        />
      </mesh>

      {/* 内发光 */}
      <mesh scale={1.02}>
        <sphereGeometry args={[1, 64, 64]} />
        <shaderMaterial
          vertexShader={glowVertexShader}
          fragmentShader={innerGlowFragmentShader}
          uniforms={{
            color: { value: new THREE.Color(getColor()) },
            glowColor: { value: new THREE.Color(glowColor) },
            intensity: { value: dimmed ? 0.1 : hovered ? 1.5 : selected ? 1.2 : 0.8 },
          }}
          transparent
        />
      </mesh>

      {/* 进度描边 */}
      <ProgressRing radius={baseSize} progress={progress} hovered={hovered} selected={selected} />

      {/* 标签 */}
      <Billboard>
        <Text
          position={getTextPosition()}
          fontSize={isDomain ? 1.6 : 1.2}
          color={isDomain ? '#FFFFFF' : '#3D4A3A'}
          anchorX={textAnchor.x}
          anchorY={textAnchor.y}
          outlineWidth={0.1}
          outlineColor={isDomain ? '#000000' : '#FFFFFF'}
          outlineOpacity={0.3}
        >
          {node.label}
        </Text>
      </Billboard>
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
  const segments = useMemo(() => {
    const segs = [];
    const numSegs = 8;
    for (let i = 0; i < numSegs; i++) {
      const t1 = i / numSegs;
      const t2 = (i + 1) / numSegs;
      const p1 = fromPos.clone().lerp(toPos, t1);
      const p2 = fromPos.clone().lerp(toPos, t2);
      segs.push({ p1, p2, t: (t1 + t2) / 2 });
    }
    return segs;
  }, [fromPos, toPos]);

  const markerPos = useMemo(() => {
    const dir = toPos.clone().sub(fromPos).normalize();
    return toPos.clone().sub(dir.multiplyScalar(3));
  }, [fromPos, toPos]);

  return (
    <group>
      {segments.map((seg, i) => (
        <Line
          key={i}
          points={[seg.p1, seg.p2]}
          color={color}
          lineWidth={isChildLink ? 2 : hovered ? 3.5 : 2}
          transparent
          opacity={dimmed ? 0.06 : (hovered ? 0.9 : isChildLink ? 0.5 : 0.35) * (0.3 + seg.t * 0.7)}
          dashed={dashed}
          dashSize={1.5}
          gapSize={0.8}
        />
      ))}
      
      <DirectionMarker
        position={markerPos}
        color={color}
        visible={!dimmed && !isChildLink}
      />
    </group>
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
  mastery,
  topicMastery,
  topicProgress,
  onTopicClick,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layout: { positions: Map<string, THREE.Vector3>; childDirections: Map<string, 'left' | 'right' | 'top' | 'bottom'> };
  selectedKpId: string | null;
  expandedKpId: string | null;
  onSelectKp: (id: string | null) => void;
  onSelectTopic: (index: number | null) => void;
  onExpandedKpChange: (id: string | null) => void;
  learned: Set<string>;
  mastery: Record<string, number>;
  topicMastery: Record<string, number>;
  topicProgress: Record<string, number>;
  onTopicClick?: (kpId: string, topicIndex: number, label: string) => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      if (node.kind === 'domain') {
        onSelectKp(node.id);
        onExpandedKpChange(expandedKpId === node.id ? null : node.id);
      } else {
        onSelectTopic(node.topicIndex ?? null);
        onTopicClick?.(node.kpId, node.topicIndex ?? 0, node.label);
      }
    },
    [expandedKpId, onSelectKp, onSelectTopic, onExpandedKpChange, onTopicClick],
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
    const parentPos = layout.positions.get(expandedKpId);
    if (!parentPos) return [];
    return nodes
      .filter((n) => n.kind === 'topic' && n.kpId === expandedKpId)
      .map((n) => ({
        id: `${expandedKpId}-${n.id}`,
        from: parentPos,
        to: layout.positions.get(n.id),
      }))
      .filter((l) => l.to);
  }, [expandedKpId, nodes, layout.positions]);

  return (
    <>
      <ambientLight intensity={0.7} />
      <directionalLight position={[25, 25, 25]} intensity={0.6} />

      {/* 语义边 */}
      {edges.map((edge) => {
        const p1 = layout.positions.get(edge.from);
        const p2 = layout.positions.get(edge.to);
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
        const pos = layout.positions.get(node.id);
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
            direction={layout.childDirections.get(node.id)}
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
            onTopicClick={onTopicClick}
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
