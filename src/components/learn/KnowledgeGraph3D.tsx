/**
 * KnowledgeGraph3D — Obsidian 风格 3D 知识图谱（智能展开版）
 * 子节点自动选择空旷方向展开，文字跟随方向
 */
import { useRef, useMemo, useState, useCallback, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
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
    hover: '#F0B35A',
    selected: '#2D5A3D',
    learned: '#6BA080',
  },
  topic: {
    base: '#4A90D9',
    hover: '#F0B35A',
    selected: '#2E6BA8',
    learned: '#5BA3E8',
  },
};

const GLOW_COLORS = {
  domain: '#E7B45A',
  topic: '#5BA3E8',
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
  expandedKpIds: Set<string>;
  onSelectKp: (id: string | null) => void;
  onSelectTopic: (index: number | null) => void;
  onExpandedKpChange: (id: string) => void;
  learned: Set<string>;
  mastery: Record<string, number>;
  topicMastery: Record<string, number>;
  topicProgress: Record<string, number>;
  /** 请求把某个域节点转到视野正前方（at 变化即重新触发） */
  focusTarget?: { id: string; at: number } | null;
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
function RotatingScene({
  children,
  shouldRotate,
  outerRef,
}: {
  children: React.ReactNode;
  shouldRotate: boolean;
  outerRef?: React.MutableRefObject<THREE.Group | null>;
}) {
  const groupRef = useRef<THREE.Group | null>(null);

  useFrame((state) => {
    if (!groupRef.current || !shouldRotate) return;
    const time = state.clock.elapsedTime * 0.05;
    groupRef.current.rotation.x = Math.sin(time * 0.7) * 0.15;
    groupRef.current.rotation.y = time * 0.3 + Math.sin(time * 0.5) * 0.1;
    groupRef.current.rotation.z = Math.cos(time * 0.6) * 0.08;
  });

  return (
    <group
      ref={(g) => {
        groupRef.current = g;
        if (outerRef) outerRef.current = g;
      }}
    >
      {children}
    </group>
  );
}

/** 相机聚焦：把指定域节点平滑带到视野正前方 */
function CameraFocus({
  focusTarget,
  layout,
  sceneRef,
}: {
  focusTarget?: { id: string; at: number } | null;
  layout: { positions: Map<string, THREE.Vector3> };
  sceneRef: React.MutableRefObject<THREE.Group | null>;
}) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target: THREE.Vector3; update: () => void; addEventListener: (t: string, cb: () => void) => void; removeEventListener: (t: string, cb: () => void) => void } | null;
  const animRef = useRef<{
    t: number;
    fromPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    nodeLocal: THREE.Vector3;
  } | null>(null);
  const lastAtRef = useRef(0);

  // 用户手动拖拽时立即取消聚焦动画
  useEffect(() => {
    if (!controls) return;
    const cancel = () => { animRef.current = null; };
    controls.addEventListener('start', cancel);
    return () => controls.removeEventListener('start', cancel);
  }, [controls]);

  useFrame((_, delta) => {
    if (focusTarget && focusTarget.at !== lastAtRef.current) {
      lastAtRef.current = focusTarget.at;
      const nodeLocal = layout.positions.get(focusTarget.id);
      if (nodeLocal && controls) {
        animRef.current = {
          t: 0,
          fromPos: camera.position.clone(),
          fromTarget: controls.target.clone(),
          nodeLocal: nodeLocal.clone(),
        };
      }
    }

    const anim = animRef.current;
    if (!anim || !controls) return;
    anim.t = Math.min(anim.t + delta / 0.8, 1);
    const ease = anim.t * anim.t * (3 - 2 * anim.t);

    // 节点世界坐标（旋转组刚停下，逐帧读取矩阵更稳妥）
    const world = anim.nodeLocal.clone();
    if (sceneRef.current) world.applyMatrix4(sceneRef.current.matrixWorld);
    const camPos = world.clone().normalize().multiplyScalar(world.length() + 38);

    camera.position.lerpVectors(anim.fromPos, camPos, ease);
    controls.target.lerpVectors(anim.fromTarget, world, ease);
    controls.update();

    if (anim.t >= 1) animRef.current = null;
  });

  return null;
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
): { direction: 'left' | 'right'; offset: THREE.Vector3 } {
  // 只向左右两侧展开，避免上下遮挡其他域节点
  const directions = [
    { name: 'right' as const, offset: new THREE.Vector3(20, 0, 0) },
    { name: 'left' as const, offset: new THREE.Vector3(-20, 0, 0) },
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
function use3DLayout(nodes: GraphNode[], edges: GraphEdge[], expandedKpIds: Set<string>) {
  const domainLayout = useDomainLayout(nodes, edges);

  return useMemo(() => {
    const positions = new Map(domainLayout);
    const childDirections = new Map<string, 'left' | 'right'>();

    // 支持多个章节同时展开；每个章节基于当前密度独立选择左/右空旷侧
    expandedKpIds.forEach((kpId) => {
      const parentPos = positions.get(kpId);
      if (!parentPos) return;
      const { direction, offset } = findBestDirection(parentPos, positions, kpId);
      const children = nodes.filter((n) => n.kind === 'topic' && n.kpId === kpId);
      const sign = direction === 'left' ? -1 : 1;

      children.forEach((node, i) => {
        const basePos = parentPos.clone().add(offset);
        // 水平展开：垂直排列
        const childPos = new THREE.Vector3(
          basePos.x + (i % 2) * 8 * sign,
          basePos.y + (i - (children.length - 1) / 2) * 8,
          basePos.z + 2,
        );
        positions.set(node.id, childPos);
        childDirections.set(node.id, direction);
      });
    });

    // 未展开的子节点放在父节点附近但不显示
    nodes.filter((n) => n.kind === 'topic' && !expandedKpIds.has(n.kpId)).forEach((node) => {
      const parentPos = positions.get(node.kpId);
      if (!parentPos) return;
      positions.set(node.id, new THREE.Vector3(
        parentPos.x + 10,
        parentPos.y,
        parentPos.z,
      ));
    });

    return { positions, childDirections };
  }, [nodes, expandedKpIds, domainLayout]);
}

/** 有向边末端的静态圆锥箭头：尖端指向目标节点 */
function EdgeArrow({
  fromPos,
  toPos,
  color,
  dimmed = false,
  hovered = false,
}: {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  color: string;
  dimmed?: boolean;
  hovered?: boolean;
}) {
  const meshRef = useRef<THREE.Mesh | null>(null);

  // 圆锥位置与朝向：沿边方向放置，尖端指向目标节点，不随相机变化
  const { position, quaternion } = useMemo(() => {
    const dir = toPos.clone().sub(fromPos).normalize();
    const pad = Math.min(4.2, Math.max(toPos.distanceTo(fromPos), 0.001) * 0.2);
    return {
      position: toPos.clone().sub(dir.clone().multiplyScalar(pad)),
      // 圆锥默认沿 +Y 指向尖端，旋转到边的方向
      quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir),
    };
  }, [fromPos, toPos]);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    (mesh.material as THREE.MeshBasicMaterial).opacity = dimmed ? 0.12 : hovered ? 1 : 0.9;
    mesh.scale.setScalar(hovered ? 1.2 : 1);
  });

  return (
    <mesh ref={meshRef} position={position} quaternion={quaternion}>
      <coneGeometry args={[0.38, 1.0, 16]} />
      <meshBasicMaterial color={color} transparent depthWrite={false} />
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

/** 子节点平面：面向用户的纸面效果 */
function ChildPlane({
  parentPos,
  children,
  layout,
  hoveredId,
  selectedKpId,
  learned,
  topicMastery,
  topicProgress,
  onNodeClick,
  onNodeHover,
}: {
  parentPos: THREE.Vector3;
  children: GraphNode[];
  layout: { positions: Map<string, THREE.Vector3>; childDirections: Map<string, 'left' | 'right'> };
  hoveredId: string | null;
  selectedKpId: string | null;
  learned: Set<string>;
  topicMastery: Record<string, number>;
  topicProgress: Record<string, number>;
  onNodeClick: (node: GraphNode) => void;
  onNodeHover: (id: string | null) => void;
}) {
  // 计算子节点在平面上的相对位置
  const childData = useMemo(() => {
    return children.map((node, i) => {
      const direction = layout.childDirections.get(node.id) || 'right';
      const sign = direction === 'left' ? -1 : 1;
      const relPos: [number, number, number] = [
        15 * sign + (i % 2) * 6 * sign,
        (i - (children.length - 1) / 2) * 8,
        0,
      ];
      return { node, relPos, direction };
    });
  }, [children, layout.childDirections]);

  return (
    <Billboard position={parentPos}>
      <group>
        {/* 连线：从原点到各子节点（静态，不添加方向动效） */}
        {childData.map(({ node, relPos }) => (
          <Line
            key={`line-${node.id}`}
            points={[
              new THREE.Vector3(0, 0, 0),
              new THREE.Vector3(...relPos),
            ]}
            color="#4E7860"
            lineWidth={3}
            transparent
            opacity={0.6}
          />
        ))}
        
        {/* 子节点 */}
        {childData.map(({ node, relPos, direction }) => {
          const isHovered = hoveredId === node.id;
          const isSelected = selectedKpId === node.id;
          const progress = topicProgress[node.id] ?? topicMastery[node.id] ?? 0;
          
          return (
            <ChildNode
              key={node.id}
              node={node}
              position={relPos}
              direction={direction}
              selected={isSelected}
              hovered={isHovered}
              learned={learned.has(node.kpId)}
              progress={progress}
              onClick={() => onNodeClick(node)}
              onHover={onNodeHover}
            />
          );
        })}
      </group>
    </Billboard>
  );
}

/** 子节点（平面内） */
function ChildNode({
  node,
  position,
  direction,
  selected,
  hovered,
  learned,
  progress,
  onClick,
  onHover,
}: {
  node: GraphNode;
  position: [number, number, number];
  direction: 'left' | 'right';
  selected: boolean;
  hovered: boolean;
  learned: boolean;
  progress: number;
  onClick: () => void;
  onHover: (id: string | null) => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const glow1Ref = useRef<THREE.Mesh>(null);
  const glow2Ref = useRef<THREE.Mesh>(null);
  const glow3Ref = useRef<THREE.Mesh>(null);
  const colors = NODE_COLORS.topic;

  const getColor = () => {
    if (selected) return colors.selected;
    if (hovered) return colors.hover;
    if (learned) return colors.learned;
    return colors.base;
  };

  const baseSize = 1.5;
  const targetScale = selected ? 1.3 : hovered ? 1.15 : 1;
  const glowColor = GLOW_COLORS.topic;

  useFrame((state) => {
    if (!meshRef.current) return;
    const time = state.clock.elapsedTime;
    const breathe = 1 + Math.sin(time * 1.5 + position[0] * 0.1) * 0.02;
    const current = meshRef.current.scale.x;
    const target = baseSize * breathe * targetScale;
    meshRef.current.scale.setScalar(THREE.MathUtils.lerp(current, target, 0.1));

    const glowIntensity = hovered ? 1 : selected ? 0.9 : 0.5;
    const pulse = 1 + Math.sin(time * 2 + position[1]) * 0.05;

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

  // 文字位置（仅左右展开）
  const getTextPosition = (): [number, number, number] => {
    return direction === 'left' ? [-3.5, 0, 1] : [3.5, 0, 1];
  };

  const getTextAnchor = (): { x: 'left' | 'center' | 'right'; y: 'top' | 'middle' | 'bottom' } => {
    return direction === 'left' ? { x: 'right', y: 'middle' } : { x: 'left', y: 'middle' };
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
      {/* 外发光 */}
      <mesh ref={glow1Ref}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshBasicMaterial color={glowColor} transparent opacity={0.5} depthWrite={false} />
      </mesh>
      <mesh ref={glow2Ref}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshBasicMaterial color={glowColor} transparent opacity={0.25} depthWrite={false} />
      </mesh>
      <mesh ref={glow3Ref}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshBasicMaterial color={glowColor} transparent opacity={0.12} depthWrite={false} />
      </mesh>

      {/* 主球体 */}
      <mesh ref={meshRef}>
        <sphereGeometry args={[1, 64, 64]} />
        <meshBasicMaterial color={getColor()} transparent={false} />
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
            intensity: { value: hovered ? 1.5 : selected ? 1.2 : 0.8 },
          }}
          transparent
        />
      </mesh>

      {/* 进度环 */}
      <ProgressRing radius={baseSize} progress={progress} hovered={hovered} selected={selected} />

      {/* 文字短线 */}
      <Line
        points={[
          new THREE.Vector3(0, 0, 0.5),
          new THREE.Vector3(direction === 'left' ? -2 : 2, 0, 1),
        ]}
        color="#4A90D9"
        lineWidth={2}
        transparent
        opacity={0.85}
      />

      {/* 文字 */}
      <Text
        position={getTextPosition()}
        fontSize={1.2}
        color="#3D4A3A"
        anchorX={textAnchor.x}
        anchorY={textAnchor.y}
        outlineWidth={0.1}
        outlineColor="#FFFFFF"
        outlineOpacity={0.5}
      >
        {node.label}
      </Text>
    </group>
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
  direction?: 'left' | 'right';
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

  // 根据方向计算文字位置（子节点仅左右展开）
  const getTextPosition = (): [number, number, number] => {
    if (isDomain) return [0, 0, 4];
    return direction === 'left' ? [-3.5, 0, 3] : [3.5, 0, 3];
  };

  // 根据方向计算文字锚点
  const getTextAnchor = (): { x: 'left' | 'center' | 'right'; y: 'top' | 'middle' | 'bottom' } => {
    if (isDomain) return { x: 'center', y: 'middle' };
    return direction === 'left' ? { x: 'right', y: 'middle' } : { x: 'left', y: 'middle' };
  };

  const textAnchor = getTextAnchor();

  return (
    <group position={position}
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
        <meshBasicMaterial color={glowColor} transparent opacity={0.5} depthWrite={false} />
      </mesh>
      <mesh ref={glow2Ref}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshBasicMaterial color={glowColor} transparent opacity={0.25} depthWrite={false} />
      </mesh>
      <mesh ref={glow3Ref}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshBasicMaterial color={glowColor} transparent opacity={0.12} depthWrite={false} />
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
            intensity: { value: dimmed ? 0.2 : hovered ? 2.0 : selected ? 1.6 : 1.0 },
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
          outlineOpacity={0.5}
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
  return (
    <group>
      {/* 单条连续直线，避免分段渲染产生接缝 */}
      <Line
        points={[fromPos, toPos]}
        color={color}
        lineWidth={isChildLink ? 3 : hovered ? 4.5 : 3}
        transparent
        opacity={dimmed ? 0.06 : hovered ? 0.9 : isChildLink ? 0.5 : 0.5}
        dashed={dashed}
        dashSize={1.5}
        gapSize={0.8}
      />

      {/* 末端静态箭头：指向目标节点 */}
      <EdgeArrow
        fromPos={fromPos}
        toPos={toPos}
        color={color}
        dimmed={dimmed}
        hovered={hovered}
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
  expandedKpIds,
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
  layout: { positions: Map<string, THREE.Vector3>; childDirections: Map<string, 'left' | 'right'> };
  selectedKpId: string | null;
  expandedKpIds: Set<string>;
  onSelectKp: (id: string | null) => void;
  onSelectTopic: (index: number | null) => void;
  onExpandedKpChange: (id: string) => void;
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
        onExpandedKpChange(node.id);
      } else {
        onSelectTopic(node.topicIndex ?? null);
        onTopicClick?.(node.kpId, node.topicIndex ?? 0, node.label);
      }
    },
    [onSelectKp, onSelectTopic, onExpandedKpChange, onTopicClick],
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
    return nodes.filter((n) => n.kind === 'domain');
  }, [nodes]);

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

      {/* 子节点平面（支持多个章节同时展开） */}
      {Array.from(expandedKpIds).map((kpId) => {
        const parentPos = layout.positions.get(kpId);
        if (!parentPos) return null;
        return (
          <ChildPlane
            key={kpId}
            parentPos={parentPos}
            children={nodes.filter((n) => n.kind === 'topic' && n.kpId === kpId)}
            layout={layout}
            hoveredId={hoveredId}
            selectedKpId={selectedKpId}
            learned={learned}
            topicMastery={topicMastery}
            topicProgress={topicProgress}
            onNodeClick={handleNodeClick}
            onNodeHover={setHoveredId}
          />
        );
      })}

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
            selected={selectedKpId === node.id || expandedKpIds.has(node.id)}
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
  expandedKpIds,
  onSelectKp,
  onSelectTopic,
  onExpandedKpChange,
  learned,
  mastery,
  topicMastery,
  topicProgress,
  focusTarget,
  className,
}: KnowledgeGraph3DProps) {
  const layout = use3DLayout(nodes, edges, expandedKpIds);
  const sceneRef = useRef<THREE.Group | null>(null);

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
        <RotatingScene shouldRotate={expandedKpIds.size === 0} outerRef={sceneRef}>
          <SceneContent
            nodes={nodes}
            edges={edges}
            layout={layout}
            selectedKpId={selectedKpId}
            expandedKpIds={expandedKpIds}
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
        <CameraFocus focusTarget={focusTarget} layout={layout} sceneRef={sceneRef} />
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











