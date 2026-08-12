/**
 * KnowledgeGraph3D — Obsidian 风格 3D 知识图谱（边缘发光版）
 * 球体边缘贴边发光，菲涅尔效应
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

const glowFragmentShader = `
  uniform vec3 color;
  uniform vec3 glowColor;
  uniform float opacity;
  uniform float glowIntensity;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    float fresnel = pow(1.0 - abs(dot(vNormal, vViewDir)), 2.0);
    vec3 finalColor = mix(color, glowColor, fresnel * glowIntensity);
    float alpha = opacity + fresnel * glowIntensity * 0.5;
    gl_FragColor = vec4(finalColor, alpha);
  }
`;

/** 3D 力导向布局 */
function use3DLayout(nodes: GraphNode[], edges: GraphEdge[]) {
  return useMemo(() => {
    const positions = new Map<string, THREE.Vector3>();
    const domainNodes = nodes.filter((n) => n.kind === 'domain');

    domainNodes.forEach((node, i) => {
      const phi = Math.acos(1 - 2 * (i + 0.5) / domainNodes.length);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const r = 28 + Math.random() * 8;
      positions.set(node.id, new THREE.Vector3(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi) * (0.7 + Math.random() * 0.3),
      ));
    });

    nodes.filter((n) => n.kind === 'topic').forEach((node) => {
      const parentPos = positions.get(node.kpId);
      if (!parentPos) return;
      const angle = (node.topicIndex ?? 0) * (Math.PI * 2 / 4) + Math.random() * 0.5;
      const dist = 14 + Math.random() * 4;
      positions.set(node.id, new THREE.Vector3(
        parentPos.x + Math.cos(angle) * dist,
        parentPos.y + Math.sin(angle) * dist,
        parentPos.z + (Math.random() - 0.5) * 6,
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

/** 3D 节点：边缘发光球体 */
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
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const isDomain = node.kind === 'domain';
  const colors = isDomain ? NODE_COLORS.domain : NODE_COLORS.topic;

  const getColor = () => {
    if (selected) return colors.selected;
    if (hovered) return colors.hover;
    if (learned) return colors.learned;
    return colors.base;
  };

  const baseSize = isDomain ? 3 : 0.9;
  const targetScale = selected ? 1.3 : hovered ? 1.15 : 1;
  const glowColor = GLOW_COLORS[node.kind];

  useFrame((state) => {
    if (!meshRef.current) return;
    const breathe = 1 + Math.sin(state.clock.elapsedTime * 1.5 + position.x * 0.1) * 0.02;
    const current = meshRef.current.scale.x;
    const target = baseSize * breathe * targetScale;
    meshRef.current.scale.setScalar(THREE.MathUtils.lerp(current, target, 0.1));

    // 更新 shader uniform
    if (materialRef.current) {
      materialRef.current.uniforms.glowIntensity.value =
        dimmed ? 0.1 : hovered ? 1.5 : selected ? 1.2 : 0.6;
      materialRef.current.uniforms.opacity.value = dimmed ? 0.2 : 0.9;
    }
  });

  const uniforms = useMemo(
    () => ({
      color: { value: new THREE.Color(getColor()) },
      glowColor: { value: new THREE.Color(glowColor) },
      opacity: { value: 0.9 },
      glowIntensity: { value: 0.6 },
    }),
    [getColor(), glowColor],
  );

  return (
    <group position={position}>
      {/* 边缘发光球体 */}
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
        <shaderMaterial
          ref={materialRef}
          vertexShader={glowVertexShader}
          fragmentShader={glowFragmentShader}
          uniforms={uniforms}
          transparent
        />
      </mesh>

      {/* 进度描边 */}
      <ProgressRing radius={baseSize} progress={progress} hovered={hovered} selected={selected} />

      {/* 标签 */}
      <Html distanceFactor={16} center>
        <div
          className={`pointer-events-none select-none whitespace-nowrap text-center font-semibold transition-all duration-200 ${
            dimmed ? 'opacity-10' : hovered || selected ? 'opacity-100 scale-110' : 'opacity-90'
          }`}
          style={{
            color: '#3D4A3A',
            fontSize: isDomain ? '18px' : '13px',
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
  const layout = use3DLayout(nodes, edges);

  return (
    <div className={`relative h-[600px] w-full overflow-hidden rounded-2xl border border-hairline bg-gradient-to-br from-paper via-[#F5F3EA] to-brand-tint/20 ${className}`}>
      <Canvas>
        <PerspectiveCamera makeDefault position={[0, 0, 75]} fov={45} />
        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          minDistance={20}
          maxDistance={130}
          autoRotate
          autoRotateSpeed={0.35}
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
          topicMastery={topicMastery}
          topicProgress={topicProgress}
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

