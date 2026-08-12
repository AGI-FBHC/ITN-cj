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

// “我的已学路径”高亮环配色（醒目翠绿，与已学色区分）
const LEARNED_HIGHLIGHT = '#2FBF71';

// 描边发光配色：与节点同色系，最里面颜色最深，由内而向外淡出
// 域节点（绿球）发翡翠绿光
const STROKE_COLORS = {
  inner: '#2F6B4F',
  outer: '#8FD3AE',
};

// 子节点（蓝球）发天蓝光
const TOPIC_STROKE_COLORS = {
  inner: '#2E6BA8',
  outer: '#8FC3F2',
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
  /** 打开“我的已学路径”：高亮已学章节/子知识点 */
  showLearned?: boolean;
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

// 内描边：球面边缘一条清晰的高对比亮环
const innerStrokeFragmentShader = `
  uniform vec3 glowColor;
  uniform float intensity;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    float f = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewDir))), 6.0);
    float band = smoothstep(0.3, 0.7, f);
    gl_FragColor = vec4(glowColor, min(band * intensity, 1.0));
  }
`;

// 外描边：紧贴球体轮廓外侧的蓝色发光，内侧最亮、向外渐隐（无硬边外圈）
const outerStrokeFragmentShader = `
  uniform vec3 glowColor;
  uniform float intensity;
  uniform float innerF;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    float f = 1.0 - abs(dot(normalize(vNormal), normalize(vViewDir)));
    // t: 0 = 贴近球面（最亮），1 = 光晕外缘（完全透明）
    float t = clamp((f - innerF) / (1.0 - innerF), 0.0, 1.0);
    float alpha = pow(1.0 - t, 1.8) * intensity;
    gl_FragColor = vec4(glowColor, min(alpha, 1.0));
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

/** 聚焦动画的共享进度（ref 驱动，不触发 React 重渲染，避免逐帧卡顿） */
type BlendRef = React.MutableRefObject<{ blend: number }>;

/** 聚焦拉出动画驱动：逐帧推进 blend，0 = 原始布局，1 = 聚焦布局 */
function FocusDriver({ focusId, blendRef }: { focusId: string | null; blendRef: BlendRef }) {
  useFrame(() => {
    const target = focusId ? 1 : 0;
    const cur = blendRef.current.blend;
    if (cur === target) return;
    const next = cur + (target - cur) * 0.09;
    blendRef.current.blend = Math.abs(next - target) < 0.005 ? target : next;
  });
  return null;
}

/** 相机聚焦：把指定域节点平滑带到视野正前方 */
function CameraFocus({
  focusTarget,
  layout,
  sceneRef,
  blendRef,
  topicCountByKp,
}: {
  focusTarget?: { id: string; at: number } | null;
  layout: { positions: Map<string, THREE.Vector3>; focusOffsets: Map<string, THREE.Vector3> };
  sceneRef: React.MutableRefObject<THREE.Group | null>;
  blendRef: BlendRef;
  topicCountByKp: Map<string, number>;
}) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target: THREE.Vector3; update: () => void; addEventListener: (t: string, cb: () => void) => void; removeEventListener: (t: string, cb: () => void) => void } | null;
  const animRef = useRef<{
    t: number;
    fromPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    nodeId: string;
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
      if (layout.positions.has(focusTarget.id) && controls) {
        animRef.current = {
          t: 0,
          fromPos: camera.position.clone(),
          fromTarget: controls.target.clone(),
          nodeId: focusTarget.id,
        };
      }
    }

    const anim = animRef.current;
    if (!anim || !controls) return;
    anim.t = Math.min(anim.t + delta / 0.8, 1);
    const ease = anim.t * anim.t * (3 - 2 * anim.t);

    // 节点世界坐标（节点可能正在被拉出，逐帧按 blend 计算最新位置）
    const nodeLocal = layout.positions.get(anim.nodeId);
    if (!nodeLocal) { animRef.current = null; return; }
    const world = nodeLocal.clone();
    const focusOff = layout.focusOffsets.get(anim.nodeId);
    if (focusOff) world.addScaledVector(focusOff, blendRef.current.blend);
    if (sceneRef.current) world.applyMatrix4(sceneRef.current.matrixWorld);
    // 距离随子节点数量自适应：子节点多就拉远一些，少就靠近一些
    const childCount = topicCountByKp.get(anim.nodeId) ?? 0;
    const dist = THREE.MathUtils.clamp(30 + childCount * 8, 46, 100);
    const camPos = world.clone().normalize().multiplyScalar(world.length() + dist);

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
function use3DLayout(nodes: GraphNode[], edges: GraphEdge[], expandedKpIds: Set<string>, focusId: string | null) {
  const domainLayout = useDomainLayout(nodes, edges);

  return useMemo(() => {
    const positions = new Map(domainLayout);
    const childDirections = new Map<string, 'left' | 'right'>();
    const focusOffsets = new Map<string, THREE.Vector3>();

    // 聚焦布局：目标节点沿径向多拉出，其余域节点向最终视角的左侧让位
    // （相机最终沿径向从外侧看向节点，此时视角的“左” = nodeDir x 世界上方向）
    if (focusId) {
      const p = positions.get(focusId);
      if (p) {
        const nodeDir = p.clone().normalize();
        focusOffsets.set(focusId, nodeDir.clone().multiplyScalar(18));
        let leftDir = new THREE.Vector3().crossVectors(nodeDir, new THREE.Vector3(0, 1, 0));
        if (leftDir.lengthSq() < 1e-4) leftDir = new THREE.Vector3(1, 0, 0);
        leftDir.normalize();
        positions.forEach((_, id) => {
          if (id !== focusId) focusOffsets.set(id, leftDir.clone().multiplyScalar(10));
        });
      }
    }

    // 支持多个章节同时展开；聚焦章节的子节点固定从右侧展开，其余按密度选侧
    expandedKpIds.forEach((kpId) => {
      const parentPos = positions.get(kpId);
      if (!parentPos) return;
      let direction: 'left' | 'right';
      let offset: THREE.Vector3;
      if (kpId === focusId) {
        direction = 'right';
        offset = new THREE.Vector3(20, 0, 0);
      } else {
        const found = findBestDirection(parentPos, positions, kpId);
        direction = found.direction;
        offset = found.offset;
      }
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

    return { positions, childDirections, focusOffsets };
  }, [nodes, expandedKpIds, domainLayout, focusId]);
}

/** 有向边末端的静态圆锥箭头：尖端指向目标节点 */
function EdgeArrow({
  fromPos,
  toPos,
  color,
  dimmed = false,
  hovered = false,
  fromOffset,
  toOffset,
  animRef,
  fadeOnFocus,
  targetId,
  nodeScaleRef,
}: {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  color: string;
  dimmed?: boolean;
  hovered?: boolean;
  fromOffset?: THREE.Vector3;
  toOffset?: THREE.Vector3;
  animRef: BlendRef;
  fadeOnFocus?: boolean;
  targetId?: string;
  nodeScaleRef?: React.MutableRefObject<Map<string, number>>;
}) {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const curFrom = useRef(fromPos.clone());
  const curTo = useRef(toPos.clone());
  const upAxis = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // 聚焦动画期间逐帧弹性跟随端点
    const b = animRef.current.blend;
    const tf = fromPos.clone();
    if (fromOffset) tf.addScaledVector(fromOffset, b);
    const tt = toPos.clone();
    if (toOffset) tt.addScaledVector(toOffset, b);
    curFrom.current.lerp(tf, 0.18);
    curTo.current.lerp(tt, 0.18);

    const dir = curTo.current.clone().sub(curFrom.current);
    const len = Math.max(dir.length(), 0.001);
    dir.normalize();
    // 箭头尖端贴着目标节点的实时表面（节点选中放大时自动让开），普通节点不留大缝
    const targetScale = (targetId && nodeScaleRef?.current.get(targetId)) || 1;
    const pad = Math.min(3 * targetScale + 0.85, len * 0.45);
    mesh.position.copy(curTo.current).addScaledVector(dir, -pad);
    // 圆锥默认沿 +Y 指向尖端，旋转到边的方向
    mesh.quaternion.setFromUnitVectors(upAxis, dir);
    const focusFade = fadeOnFocus ? 1 - 0.65 * b : 1;
    (mesh.material as THREE.MeshBasicMaterial).opacity = (dimmed ? 0.12 : hovered ? 1 : 0.9) * focusFade;
    mesh.scale.setScalar(hovered ? 1.2 : 1);
  });

  return (
    <mesh ref={meshRef}>
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
    <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -0.3]} raycast={() => null} renderOrder={1}>
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

/** “我的已学路径”高亮环：始终面向相机，环绕已学节点 */
function LearnedHighlightRing({ radius }: { radius: number }) {
  return (
    <Billboard>
      <mesh raycast={() => null} renderOrder={3} position={[0, 0, 0.02]}>
        <ringGeometry args={[radius + 0.28, radius + 0.52, 64]} />
        <meshBasicMaterial color={LEARNED_HIGHLIGHT} transparent opacity={0.95} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </Billboard>
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
  parentOffset,
  animRef,
  showLearned,
}: {
  parentPos: THREE.Vector3;
  children: GraphNode[];
  layout: { positions: Map<string, THREE.Vector3>; childDirections: Map<string, 'left' | 'right'>; focusOffsets: Map<string, THREE.Vector3> };
  hoveredId: string | null;
  selectedKpId: string | null;
  learned: Set<string>;
  topicMastery: Record<string, number>;
  topicProgress: Record<string, number>;
  onNodeClick: (node: GraphNode) => void;
  onNodeHover: (id: string | null) => void;
  parentOffset?: THREE.Vector3;
  animRef: BlendRef;
  showLearned?: boolean;
}) {
  const billboardRef = useRef<THREE.Group | null>(null);

  // 聚焦动画期间子节点平面跟随父节点
  useFrame(() => {
    if (!billboardRef.current) return;
    billboardRef.current.position.copy(parentPos);
    if (parentOffset) billboardRef.current.position.addScaledVector(parentOffset, animRef.current.blend);
  });
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
    <Billboard ref={billboardRef} position={parentPos}>
      <group>
        {/* 连线：从父节点球面到子节点球面（不穿入球体内部，避免半透明时闪烁） */}
        {childData.map(({ node, relPos }) => {
          const end = new THREE.Vector3(...relPos);
          const dir = end.clone().normalize();
          const start = dir.clone().multiplyScalar(3.7);
          const endTrim = end.clone().addScaledVector(dir, -1.95);
          return (
            <Line
              key={`line-${node.id}`}
              renderOrder={-1}
              points={[start, endTrim]}
              color="#4E7860"
              lineWidth={3}
              transparent
              opacity={0.6}
            />
          );
        })}
        
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
              showLearned={showLearned}
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
  showLearned,
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
  showLearned?: boolean;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const colors = NODE_COLORS.topic;

  const getColor = () => {
    if (selected) return colors.selected;
    if (hovered) return colors.hover;
    if (learned) return colors.learned;
    return colors.base;
  };

  const baseSize = 1.5;
  const targetScale = selected ? 1.3 : hovered ? 1.15 : 1;

  useFrame(() => {
    if (!meshRef.current) return;
    const current = meshRef.current.scale.x;
    meshRef.current.scale.setScalar(THREE.MathUtils.lerp(current, baseSize * targetScale, 0.1));
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
      {/* 主球体 + 描边式内外发光（跟随球体缩放） */}
      <mesh ref={meshRef}>
        <sphereGeometry args={[1, 64, 64]} />
        <meshBasicMaterial color={getColor()} transparent={false} />

        {/* 内描边：球面边缘的亮环 */}
        <mesh scale={1.015} raycast={() => null} renderOrder={1}>
          <sphereGeometry args={[1, 64, 64]} />
          <shaderMaterial
            vertexShader={glowVertexShader}
            fragmentShader={innerStrokeFragmentShader}
            uniforms={{
              glowColor: { value: new THREE.Color(TOPIC_STROKE_COLORS.inner) },
              intensity: { value: hovered ? 1.3 : selected ? 1.15 : 1.0 },
            }}
            transparent
            depthWrite={false}
          />
        </mesh>

        {/* 外描边：紧贴球体轮廓外的蓝色发光，向外渐隐 */}
        <mesh scale={1.16} raycast={() => null} renderOrder={1}>
          <sphereGeometry args={[1, 48, 48]} />
          <shaderMaterial
            vertexShader={glowVertexShader}
            fragmentShader={outerStrokeFragmentShader}
            uniforms={{
              glowColor: { value: new THREE.Color(TOPIC_STROKE_COLORS.outer) },
              intensity: { value: hovered ? 1.3 : selected ? 1.15 : 1.0 },
              innerF: { value: 0.49 },
            }}
            transparent
            side={THREE.BackSide}
            depthWrite={false}
          />
        </mesh>
      </mesh>

      {/* 进度环 */}
      <ProgressRing radius={baseSize} progress={progress} hovered={hovered} selected={selected} />

      {/* 文字短线 */}
      <Line
        raycast={() => null}
        points={[
          new THREE.Vector3(0, 0, 0.5),
          new THREE.Vector3(direction === 'left' ? -2 : 2, 0, 1),
        ]}
        color="#4A90D9"
        lineWidth={2}
        transparent
        opacity={0.85}
      />

      {learned && showLearned && <LearnedHighlightRing radius={baseSize} />}

      {/* 文字 */}
      <Text
        raycast={() => null}
        renderOrder={2}
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
  focusOffset,
  animRef,
  fadeOnFocus,
  nodeScaleRef,
  showLearned,
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
  focusOffset?: THREE.Vector3;
  animRef: BlendRef;
  /** 聚焦其他节点时，本节点提高透明度退到背景 */
  fadeOnFocus?: boolean;
  /** 共享的节点实时缩放表，供箭头/连线按实际球体大小定位 */
  nodeScaleRef?: React.MutableRefObject<Map<string, number>>;
  showLearned?: boolean;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const textRef = useRef<THREE.Mesh | null>(null);
  const innerStrokeRef = useRef<THREE.ShaderMaterial | null>(null);
  const outerStrokeRef = useRef<THREE.ShaderMaterial | null>(null);
  // uniforms 对象保持引用稳定，亮度只由 useFrame 逐帧写入，避免重渲染时闪烁
  const innerUniforms = useMemo(() => ({
    glowColor: { value: new THREE.Color(STROKE_COLORS.inner) },
    intensity: { value: 1 },
  }), []);
  const outerUniforms = useMemo(() => ({
    glowColor: { value: new THREE.Color(STROKE_COLORS.outer) },
    intensity: { value: 1 },
    innerF: { value: 0.49 },
  }), []);
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

  useFrame(() => {
    if (groupRef.current) {
      groupRef.current.position.copy(position);
      if (focusOffset) groupRef.current.position.addScaledVector(focusOffset, animRef.current.blend);
    }
    const mesh = meshRef.current;
    if (!mesh) return;
    const current = mesh.scale.x;
    mesh.scale.setScalar(THREE.MathUtils.lerp(current, baseSize * targetScale, 0.1));
    nodeScaleRef?.current.set(node.id, mesh.scale.x / baseSize);

    // 聚焦时远处节点提高透明度退到背景，突出聚焦节点
    const focusFade = fadeOnFocus ? 1 - 0.72 * animRef.current.blend : 1;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.transparent = true;
    mat.opacity = (dimmed ? 0.2 : 1) * focusFade;

    if (innerStrokeRef.current) {
      innerStrokeRef.current.uniforms.intensity.value =
        (dimmed ? 0.2 : hovered ? 1.3 : selected ? 1.15 : 1.0) * focusFade;
    }
    if (outerStrokeRef.current) {
      outerStrokeRef.current.uniforms.intensity.value =
        (dimmed ? 0.15 : hovered ? 1.3 : selected ? 1.15 : 1.0) * focusFade;
    }
    const text = textRef.current;
    if (text && (text.material as any).opacity !== undefined) {
      (text.material as any).transparent = true;
      (text.material as any).opacity = focusFade;
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
    <group
      ref={groupRef}
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
      {/* 主球体 + 描边式内外发光（跟随球体缩放） */}
      <mesh ref={meshRef}>
        <sphereGeometry args={[1, 64, 64]} />
        <meshBasicMaterial color={getColor()} transparent opacity={1} />

        {/* 内描边：球面边缘的亮环 */}
        <mesh scale={1.015} raycast={() => null} renderOrder={1}>
          <sphereGeometry args={[1, 64, 64]} />
          <shaderMaterial
            ref={innerStrokeRef}
            vertexShader={glowVertexShader}
            fragmentShader={innerStrokeFragmentShader}
            uniforms={innerUniforms}
            transparent
            depthWrite={false}
          />
        </mesh>

        {/* 外描边：紧贴球体轮廓外的蓝色发光，向外渐隐 */}
        <mesh scale={1.16} raycast={() => null} renderOrder={1}>
          <sphereGeometry args={[1, 48, 48]} />
          <shaderMaterial
            ref={outerStrokeRef}
            vertexShader={glowVertexShader}
            fragmentShader={outerStrokeFragmentShader}
            uniforms={outerUniforms}
            transparent
            side={THREE.BackSide}
            depthWrite={false}
          />
        </mesh>
      </mesh>

      {/* 进度描边 */}
      <ProgressRing radius={baseSize} progress={progress} hovered={hovered} selected={selected} />

      {/* 标签 */}
      <Billboard>
        <Text
          ref={textRef}
          raycast={() => null}
          renderOrder={2}
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

      {learned && showLearned && <LearnedHighlightRing radius={baseSize} />}
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
  fromOffset,
  toOffset,
  animRef,
  fadeOnFocus,
  sourceId,
  targetId,
  nodeScaleRef,
}: {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  color: string;
  hovered: boolean;
  dimmed: boolean;
  dashed?: boolean;
  isChildLink?: boolean;
  fromOffset?: THREE.Vector3;
  toOffset?: THREE.Vector3;
  animRef: BlendRef;
  fadeOnFocus?: boolean;
  sourceId?: string;
  targetId?: string;
  nodeScaleRef?: React.MutableRefObject<Map<string, number>>;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lineRef = useRef<any>(null);
  const curFrom = useRef(fromPos.clone());
  const curTo = useRef(toPos.clone());

  // 聚焦动画期间逐帧弹性跟随（lerp 产生橡皮筋效果），不触发 React 重渲染
  useFrame(() => {
    const b = animRef.current.blend;
    const tf = fromPos.clone();
    if (fromOffset) tf.addScaledVector(fromOffset, b);
    const tt = toPos.clone();
    if (toOffset) tt.addScaledVector(toOffset, b);
    curFrom.current.lerp(tf, 0.18);
    curTo.current.lerp(tt, 0.18);
    const line = lineRef.current;
    if (line) {
      // 线段裁剪到球体表面：不穿入节点内部，节点半透明时也不会看到线穿过球体；
      // 两端裁剪距离跟随节点实时缩放（选中放大时自动让开）
      const dir = curTo.current.clone().sub(curFrom.current);
      const len = Math.max(dir.length(), 0.001);
      dir.normalize();
      const sFrom = (sourceId && nodeScaleRef?.current.get(sourceId)) || 1;
      const sTo = (targetId && nodeScaleRef?.current.get(targetId)) || 1;
      const startPad = Math.min(3 * sFrom + 0.7, len * 0.4);
      const endPad = Math.min(3 * sTo + 1.0, len * 0.5);
      const start = curFrom.current.clone().addScaledVector(dir, startPad);
      const end = curTo.current.clone().addScaledVector(dir, -endPad);
      line.geometry.setPositions([start.x, start.y, start.z, end.x, end.y, end.z]);
      if (dashed) line.computeLineDistances();
      // 聚焦时无关连线同步淡出
      const focusFade = fadeOnFocus ? 1 - 0.65 * b : 1;
      line.material.opacity = (dimmed ? 0.06 : hovered ? 0.9 : isChildLink ? 0.5 : 0.5) * focusFade;
    }
  });

  return (
    <group>
      {/* 单条连续直线，避免分段渲染产生接缝 */}
      <Line
        ref={lineRef}
        renderOrder={-1}
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
        fromOffset={fromOffset}
        toOffset={toOffset}
        animRef={animRef}
        fadeOnFocus={fadeOnFocus}
        targetId={targetId}
        nodeScaleRef={nodeScaleRef}
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
  animRef,
  focusId,
  hoveredId,
  onHoverNode,
  showLearned,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layout: { positions: Map<string, THREE.Vector3>; childDirections: Map<string, 'left' | 'right'>; focusOffsets: Map<string, THREE.Vector3> };
  selectedKpId: string | null;
  expandedKpIds: Set<string>;
  animRef: BlendRef;
  focusId: string | null;
  onSelectKp: (id: string | null) => void;
  onSelectTopic: (index: number | null) => void;
  onExpandedKpChange: (id: string) => void;
  learned: Set<string>;
  mastery: Record<string, number>;
  topicMastery: Record<string, number>;
  topicProgress: Record<string, number>;
  onTopicClick?: (kpId: string, topicIndex: number, label: string) => void;
  hoveredId: string | null;
  onHoverNode: (id: string | null) => void;
  showLearned?: boolean;
}) {
  const nodeScaleRef = useRef(new Map<string, number>());

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
            fromOffset={layout.focusOffsets.get(edge.from)}
            toOffset={layout.focusOffsets.get(edge.to)}
            animRef={animRef}
            fadeOnFocus={focusId !== null && edge.from !== focusId && edge.to !== focusId}
            sourceId={edge.from}
            targetId={edge.to}
            nodeScaleRef={nodeScaleRef}
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
            onNodeHover={onHoverNode}
            parentOffset={layout.focusOffsets.get(kpId)}
            animRef={animRef}
            showLearned={showLearned}
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
            onHover={onHoverNode}
            focusOffset={layout.focusOffsets.get(node.id)}
            animRef={animRef}
            fadeOnFocus={focusId !== null && node.id !== focusId}
            nodeScaleRef={nodeScaleRef}
            showLearned={showLearned}
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
  showLearned = false,
}: KnowledgeGraph3DProps) {
  // 聚焦的域节点（需仍处于展开状态才拉出）；同时展开多个章节时聚焦规则不生效
  const focusedId = focusTarget && expandedKpIds.has(focusTarget.id) ? focusTarget.id : null;
  const focusId = expandedKpIds.size > 1 ? null : focusedId;
  // 淡化锚点：快速列表聚焦的章节，或唯一展开的章节；同时展开多个时不淡化
  const dimAnchorId = focusId ?? (expandedKpIds.size === 1 ? Array.from(expandedKpIds)[0] : null);
  // 聚焦动画进度用 ref 驱动（逐帧更新但不触发 React 重渲染，避免卡顿）
  const blendRef = useRef({ blend: 0 });
  // 切换聚焦目标时从头开始拉出
  useEffect(() => { blendRef.current.blend = 0; }, [focusId]);

  const layout = use3DLayout(nodes, edges, expandedKpIds, focusId);
  const sceneRef = useRef<THREE.Group | null>(null);
  // 悬停时暂停自动旋转，避免节点在光标下移动导致悬停闪烁
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // 每个章节的子节点数量（用于聚焦时自适应相机距离）
  const topicCountByKp = useMemo(() => {
    const counts = new Map<string, number>();
    nodes.forEach((n) => {
      if (n.kind === 'topic') counts.set(n.kpId, (counts.get(n.kpId) ?? 0) + 1);
    });
    return counts;
  }, [nodes]);

  return (
    <div
      className={`relative h-[600px] w-full overflow-hidden rounded-2xl border border-hairline bg-gradient-to-br from-paper via-[#F5F3EA] to-brand-tint/20 ${className}`}
      onWheel={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
    >
      <Canvas>
        <PerspectiveCamera makeDefault position={[0, 0, 75]} fov={45} />
        <OrbitControls
          makeDefault
          enablePan
          enableZoom
          enableRotate
          minDistance={20}
          maxDistance={130}
          autoRotate={false}
        />
        <FocusDriver focusId={dimAnchorId} blendRef={blendRef} />
        <RotatingScene shouldRotate={expandedKpIds.size === 0 && !hoveredNodeId} outerRef={sceneRef}>
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
            animRef={blendRef}
            focusId={dimAnchorId}
            hoveredId={hoveredNodeId}
            onHoverNode={setHoveredNodeId}
            showLearned={showLearned}
          />
        </RotatingScene>
        <CameraFocus focusTarget={focusTarget} layout={layout} sceneRef={sceneRef} blendRef={blendRef} topicCountByKp={topicCountByKp} />
      </Canvas>

      {/* 提示 */}
      <div className="absolute bottom-4 left-4 rounded-lg bg-white/90 px-3 py-2 text-[11px] text-ink-muted backdrop-blur-sm border border-hairline/50">
        🖱️ 拖拽旋转 · 滚轮缩放 · 悬停查看关联 · 点击章节展开
      </div>

    </div>
  );
}
