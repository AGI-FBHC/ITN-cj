/**
 * KnowledgeGraph3D — Obsidian 风格 3D 知识图谱（智能展开版）
 * 子节点自动选择空旷方向展开，文字跟随方向
 */
import { useRef, useMemo, useState, useCallback, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Text, Line, PerspectiveCamera, Billboard } from '@react-three/drei';
import { BookOpen, ClipboardCheck, Presentation, Wrench, X } from 'lucide-react';
import * as THREE from 'three';
import type { GraphNode, GraphEdge, EdgeKind } from '@/data/knowledgeGraph';
import type { ResourceForm, GeneratedResource } from '@/data/resources';
import type { PresentationTaskSummary } from '@/lib/presentationApi';
import { FUNCTION_META, useTopicResourceActions } from '@/hooks/useTopicResourceActions';
import cjkFontUrl from '@/assets/fonts/noto-sans-cjk-sc-gb2312.otf';

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
  low: '#19A7CE',
  mid: '#F59E0B',
  high: '#16A34A',
};

interface KnowledgeGraph3DProps {
  onTopicClick?: (kpId: string, topicIndex: number, label: string) => void;
  persistenceKey?: string;
  restorePersistedCamera?: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedKpId: string | null;
  expandedKpIds: Set<string>;
  onSelectKp: (id: string | null) => void;
  onSelectTopic: (index: number | null) => void;
  onExpandedKpChange: (id: string) => void;
  learned: Set<string>;
  mastery: Record<string, number>;
  chapterProgress: Record<string, number>;
  topicMastery: Record<string, number>;
  topicProgress: Record<string, number>;
  /** 请求把某个域节点转到视野正前方（at 变化即重新触发） */
  focusTarget?: { id: string; at: number } | null;
  /** 打开“我的已学路径”：高亮已学章节/子知识点 */
  showLearned?: boolean;
  /** 各章节已有资源（kpId → resources），功能节点据此显示“打开/生成” */
  resources?: Record<string, Array<GeneratedResource & { id?: string; learned?: boolean; started?: boolean }>>;
  /** 课件任务列表，用于功能节点判断“交互课件”是否已生成 */
  presentations?: PresentationTaskSummary[];
  /** 生成资源时的学习目标 */
  goalId?: string | null;
  className?: string;
}

interface CameraViewState {
  position: [number, number, number];
  target: [number, number, number];
}

function PersistedCamera({ storageKey, restore = false }: { storageKey?: string; restore?: boolean }) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as {
    target: THREE.Vector3;
    update: () => void;
    addEventListener: (type: string, callback: () => void) => void;
    removeEventListener: (type: string, callback: () => void) => void;
  } | null;

  useEffect(() => {
    if (!storageKey || !controls) return;
    const key = `lf.knowledgeGraph3dCamera:v1:${storageKey}`;
    try {
      const saved = restore ? JSON.parse(window.sessionStorage.getItem(key) ?? 'null') as CameraViewState | null : null;
      if (saved?.position?.length === 3 && saved?.target?.length === 3) {
        camera.position.fromArray(saved.position);
        controls.target.fromArray(saved.target);
        controls.update();
      }
    } catch { /* 无效缓存回退默认相机 */ }
    const save = () => {
      try {
        window.sessionStorage.setItem(key, JSON.stringify({
          position: camera.position.toArray(),
          target: controls.target.toArray(),
        } satisfies CameraViewState));
      } catch { /* ignore */ }
    };
    controls.addEventListener('end', save);
    return () => {
      save();
      controls.removeEventListener('end', save);
    };
  }, [camera, controls, storageKey]);
  return null;
}

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
  mastery,
  variant = 'topic',
  hovered,
  selected,
}: {
  radius: number;
  progress: number;
  mastery: number;
  variant?: 'chapter' | 'topic';
  hovered: boolean;
  selected: boolean;
}) {
  const chapterColors = { low: '#4F9D8A', mid: '#3F8F78', high: '#26715D' };
  const palette = variant === 'chapter' ? chapterColors : PROGRESS_COLORS;
  const color = progress >= 80 ? palette.high : progress >= 50 ? palette.mid : palette.low;
  const trackColor = variant === 'chapter' ? '#71877D' : '#7B8780';
  const masteryColor = variant === 'chapter' ? '#174E43' : '#155E9A';
  const arcLength = (Math.max(0, Math.min(100, progress)) / 100) * Math.PI * 2;
  const masteryLength = arcLength * Math.max(0, Math.min(100, mastery)) / 100;
  const inner = radius + 0.3;
  const outer = radius + 0.68;
  const progressMid = (inner + outer) / 2;
  const progressCapRadius = (outer - inner) / 2;
  const masteryInner = inner + 0.09;
  const masteryOuter = outer - 0.09;
  const masteryMid = (masteryInner + masteryOuter) / 2;
  const masteryCapRadius = (masteryOuter - masteryInner) / 2;
  const capPosition = (mid: number, angle: number, z: number): [number, number, number] => [
    Math.cos(angle - Math.PI / 2) * mid,
    Math.sin(angle - Math.PI / 2) * mid,
    z,
  ];

  return (
    <Billboard>
      <mesh raycast={() => null} renderOrder={3} position={[0, 0, 0.08]} rotation={[0, 0, -Math.PI / 2]}>
        <ringGeometry args={[inner, outer, 96]} />
        <meshBasicMaterial color={trackColor} transparent opacity={hovered || selected ? 0.72 : 0.48} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {arcLength > 0 && <mesh raycast={() => null} renderOrder={3} position={[0, 0, 0.09]} rotation={[0, 0, -Math.PI / 2]}>
        <ringGeometry args={[inner - 0.08, outer + 0.08, 96, 1, 0, arcLength]} />
        <meshBasicMaterial color={color} transparent opacity={hovered || selected ? 0.34 : 0.22} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>}
      {arcLength > 0 && <mesh raycast={() => null} renderOrder={4} position={[0, 0, 0.1]} rotation={[0, 0, -Math.PI / 2]}>
        <ringGeometry args={[inner, outer, 96, 1, 0, arcLength]} />
        <meshBasicMaterial color={color} transparent opacity={1} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>}
      {arcLength > 0 && arcLength < Math.PI * 2 - 0.001 && <>
        {[0, arcLength].map((angle) => <mesh key={`progress-cap-${angle}`} raycast={() => null} renderOrder={4} position={capPosition(progressMid, angle, 0.105)}>
          <circleGeometry args={[progressCapRadius, 24]} />
          <meshBasicMaterial color={color} transparent opacity={1} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>)}
      </>}
      {masteryLength > 0 && <mesh raycast={() => null} renderOrder={5} position={[0, 0, 0.12]} rotation={[0, 0, -Math.PI / 2]}>
        <ringGeometry args={[masteryInner, masteryOuter, 96, 1, 0, masteryLength]} />
        <meshBasicMaterial color={masteryColor} transparent opacity={1} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>}
      {masteryLength > 0 && masteryLength < Math.PI * 2 - 0.001 && <>
        {[0, masteryLength].map((angle) => <mesh key={`mastery-cap-${angle}`} raycast={() => null} renderOrder={5} position={capPosition(masteryMid, angle, 0.125)}>
          <circleGeometry args={[masteryCapRadius, 24]} />
          <meshBasicMaterial color={masteryColor} transparent opacity={1} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>)}
      </>}
    </Billboard>
  );
}

function HoverCardTracker({ object, cardRef }: {
  object: THREE.Object3D;
  cardRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const { camera, size } = useThree();
  const projected = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const card = cardRef.current;
    if (!card) return;
    object.getWorldPosition(projected);
    projected.project(camera);
    card.style.left = `${(projected.x * 0.5 + 0.5) * size.width}px`;
    card.style.top = `${Math.max(105, Math.min(size.height - 105, (-projected.y * 0.5 + 0.5) * size.height))}px`;
    card.style.visibility = projected.z > 1 ? 'hidden' : 'visible';
  });
  return null;
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

/** 页面级知识点操作弹窗：脱离 3D 世界坐标，确保尺寸与交互始终稳定。 */
const STATUS_META: Record<'missing' | 'unlearned' | 'incomplete' | 'learned', { label: string; color: string }> = {
  missing: { label: '未生成', color: '#9AA19A' },
  unlearned: { label: '未学习', color: '#D89238' },
  incomplete: { label: '未学完', color: '#4B82B8' },
  learned: { label: '已学习', color: '#2F8F5B' },
};

/** 统一 3D 中文标签标点，避免半角窄标点在远景 SDF 采样中丢失。 */
function format3DLabel(label: string): string {
  return label
    .trim()
    .replace(/([\u3400-\u9fff]):(?=[\u3400-\u9fffA-Za-z0-9])/g, '$1：')
    .replace(/([\u3400-\u9fff]);(?=[\u3400-\u9fffA-Za-z0-9])/g, '$1；')
    .replace(/\s*([，。！？])\s*/g, '$1')
    .replace(/\s*([：；])\s*/g, '$1 ');
}

const FUNCTION_ICON = {
  lecture: BookOpen,
  guide: Wrench,
  quiz: ClipboardCheck,
  ppt: Presentation,
};

function TopicActionModal({
  node,
  resources,
  presentations,
  goalId,
  learned,
  progress,
  mastery,
  onClose,
}: {
  node: GraphNode;
  resources?: Array<GeneratedResource & { id?: string; learned?: boolean; started?: boolean }>;
  presentations?: PresentationTaskSummary[];
  goalId?: string | null;
  learned: Set<string>;
  progress: number;
  mastery: number;
  onClose: () => void;
}) {
  const overallMastery = Math.round(progress * mastery) / 100;
  const dialogRef = useRef<HTMLElement>(null);
  const { existingFor, openOrGenerate, openOrCreatePpt, generating, checkingPpt } = useTopicResourceActions({
    kpId: node.kpId,
    label: node.label,
    goalId,
    existing: resources ?? [],
  });
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapFocus);
    return () => {
      document.removeEventListener('keydown', trapFocus);
      previousFocus?.focus();
    };
  }, []);
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#17231E]/20 p-5 backdrop-blur-[3px]" onClick={onClose}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="topic-action-title"
        className="h-[510px] w-full max-w-[560px] overflow-hidden rounded-[28px] border border-white/80 bg-[#FCFDF9]/95 shadow-[0_28px_80px_rgba(28,45,36,0.24)] backdrop-blur-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b border-[#E7EAE4] px-6 pb-4 pt-5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#E8F0EA] text-[#426A54]">
            <BookOpen size={21} strokeWidth={1.8} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-[11px] font-semibold tracking-[0.16em] text-[#7A877F]">知识点学习</p>
            <h2 id="topic-action-title" className="break-words text-[21px] font-semibold leading-snug tracking-[-0.02em] text-[#24332B]">{node.label.trim()}</h2>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#748078] transition hover:bg-[#EDF0EB] hover:text-[#24332B]">
            <X size={18} />
          </button>
        </header>

        <div className="mx-5 mt-4 grid min-h-[104px] grid-cols-[1fr_auto] items-center gap-5 rounded-[18px] border border-[#DCE7E1] bg-[#F3F8F5] px-5 py-4"><div className="min-w-0"><div className="flex items-center justify-between text-[12px]"><span className="font-medium text-[#344A3E]">学习进度</span><span className="font-mono text-[13px] font-semibold text-[#287EA8]">{progress}%</span></div><div className="relative mt-3 h-3 overflow-hidden rounded-full bg-[#D7DDD9]"><div className="absolute inset-y-0 left-0 rounded-full bg-[#55B9DC]" style={{ width: `${progress}%` }} /><div className="absolute inset-y-[1.5px] left-0 rounded-full bg-[#155E9A]" style={{ width: `${overallMastery}%` }} /></div><div className="mt-2 flex gap-4 text-[10px] text-[#78847C]"><span>浅蓝 · 已学习</span><span>深蓝 · 已掌握</span></div></div><div className="flex items-center gap-3 border-l border-[#D8E4DD] pl-5"><span className="text-right text-[10px] leading-4 text-[#607168]">当前掌握<br />全部内容</span><div className="relative h-16 w-16"><svg viewBox="0 0 48 48" className="h-full w-full -rotate-90"><circle cx="24" cy="24" r="19" fill="none" stroke="#D8E5EF" strokeWidth="5" /><circle cx="24" cy="24" r="19" fill="none" stroke="#155E9A" strokeWidth="5" strokeLinecap="round" pathLength="100" strokeDasharray={`${overallMastery} 100`} /></svg><span className="absolute inset-0 flex items-center justify-center font-mono text-[12px] font-semibold text-[#155E9A]">{overallMastery}%</span></div></div></div>

        <div className="grid grid-cols-2 gap-3 p-5 pt-4 sm:px-6 sm:pb-5">
          {FUNCTION_META.map((fn) => {
        const res = fn.form !== 'ppt' ? existingFor(fn.form as ResourceForm) : undefined;
        const pptTask = fn.form === 'ppt'
          ? (presentations ?? [])
              .filter((task) => !['failed', 'cancelled'].includes(task.status))
              .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
              .find((task) => {
                const taskTitle = task.title.replace(/\s*[·・]\s*交互课件\s*$/, '').trim();
                const nodeTitle = node.label.trim();
                return taskTitle === nodeTitle || task.title.includes(nodeTitle) || nodeTitle.includes(taskTitle);
              })
          : undefined;
        const exists = fn.form === 'ppt' ? Boolean(pptTask && pptTask.status === 'completed') : Boolean(res?.id);
        const busy = fn.form === 'ppt' ? checkingPpt : generating.has(fn.form);
        const status: 'missing' | 'unlearned' | 'incomplete' | 'learned' = !exists
          ? 'missing'
          : fn.form === 'ppt'
            ? (pptTask?.learned ? 'learned' : 'unlearned')
            : (res?.learned ?? learned.has(node.kpId))
              ? 'learned'
              : res?.started
                ? 'incomplete'
                : 'unlearned';
        const Icon = FUNCTION_ICON[fn.form];
        const tag = STATUS_META[status];
        return (
          <button
            key={fn.form}
            type="button"
            disabled={busy}
            className="group h-[88px] rounded-[16px] border border-[#E1E6DF] bg-white/75 px-3.5 py-3 text-left shadow-[0_8px_22px_rgba(41,63,51,0.06)] transition duration-200 hover:-translate-y-0.5 hover:border-[#AFC3B5] hover:bg-white hover:shadow-[0_14px_32px_rgba(41,63,51,0.12)] disabled:cursor-progress disabled:opacity-60"
            onClick={() => {
              if (fn.form === 'ppt') void openOrCreatePpt();
              else void openOrGenerate(fn.form as ResourceForm);
            }}
          >
            <span className="mb-2 flex items-center justify-between">
              <span className="flex h-8 w-8 items-center justify-center rounded-[11px] bg-[#EDF3EE] text-[#466C56] transition group-hover:bg-[#E2ECE5]">
                <Icon size={17} strokeWidth={1.8} />
              </span>
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-[#6C7971]">
                <i className="h-2 w-2 rounded-full" style={{ backgroundColor: busy ? '#D89238' : tag.color }} />
                {busy ? '处理中' : tag.label}
              </span>
            </span>
            <strong className="block text-[15px] font-semibold text-[#26352D]">{fn.label}</strong>
          </button>
        );
          })}
        </div>
      </section>
    </div>
  );
}


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
  onNodeHover: (id: string | null, clientX?: number, clientY?: number, object?: THREE.Object3D) => void;
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
    const orderedChildren = [...children].sort((left, right) =>
      (left.topicIndex ?? Number.MAX_SAFE_INTEGER) - (right.topicIndex ?? Number.MAX_SAFE_INTEGER),
    );
    return orderedChildren.map((node, i) => {
      const direction = layout.childDirections.get(node.id) || 'right';
      const sign = direction === 'left' ? -1 : 1;
      const relPos: [number, number, number] = [
        15 * sign + (i % 2) * 6 * sign,
        ((orderedChildren.length - 1) / 2 - i) * 8,
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
          const mastery = topicMastery[node.id] ?? 0;
          
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
              mastery={mastery}
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
  mastery,
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
  mastery: number;
  onClick: () => void;
  onHover: (id: string | null, clientX?: number, clientY?: number, object?: THREE.Object3D) => void;
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
  // 放大幅度受进度环内径约束，避免节点穿入环内形成额外深色圈。
  const targetScale = selected ? 1.1 : hovered ? 1.07 : 1;

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
        onHover(node.id, e.clientX, e.clientY, e.eventObject);
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
      {/* 节点视觉始终正对相机，避免透视边缘把圆球拉成椭圆 */}
      <Billboard>
      <mesh ref={meshRef}>
        <circleGeometry args={[1, 64]} />
        <meshBasicMaterial color={getColor()} transparent={false} />

        {/* 内描边：球面边缘的亮环 */}
        <mesh scale={1.015} position={[0, 0, 0.012]} raycast={() => null} renderOrder={1}>
          <ringGeometry args={[0.9, 1, 64]} />
          <meshBasicMaterial color={TOPIC_STROKE_COLORS.inner} transparent opacity={0.34} depthWrite={false} />
        </mesh>

        {/* 外描边：紧贴球体轮廓外的蓝色发光，向外渐隐 */}
        <mesh scale={1.16} position={[0, 0, 0.008]} raycast={() => null} renderOrder={1}>
          <ringGeometry args={[0.86, 1, 64]} />
          <meshBasicMaterial color={TOPIC_STROKE_COLORS.outer} transparent opacity={hovered ? 0.46 : selected ? 0.4 : 0.32} depthWrite={false} />
        </mesh>
      </mesh>
      </Billboard>

      {/* 进度环 */}
      <ProgressRing radius={baseSize} progress={progress} mastery={mastery} variant="topic" hovered={hovered} selected={selected} />

      {/* 文字短线 */}
      <Line
        raycast={() => null}
        points={[
          new THREE.Vector3(direction === 'left' ? -2.38 : 2.38, 0, 1),
          new THREE.Vector3(direction === 'left' ? -3.2 : 3.2, 0, 1),
        ]}
        color="#4A90D9"
        lineWidth={2}
        transparent
        opacity={0.85}
      />

      {learned && showLearned && <LearnedHighlightRing radius={baseSize} />}

      {/* 文字 */}
      <Text
        font={cjkFontUrl}
        sdfGlyphSize={128}
        raycast={() => null}
        renderOrder={2}
        position={getTextPosition()}
        fontSize={1.32}
        maxWidth={14}
        lineHeight={1.28}
        letterSpacing={0.025}
        textAlign={direction === 'left' ? 'right' : 'left'}
        color="#3D4A3A"
        anchorX={textAnchor.x}
        anchorY={textAnchor.y}
        outlineWidth={0.025}
        outlineColor="#FFFFFF"
        outlineOpacity={0.82}
      >
        {format3DLabel(node.label)}
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
  mastery,
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
  mastery: number;
  onClick: () => void;
  onHover: (id: string | null, clientX?: number, clientY?: number, object?: THREE.Object3D) => void;
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
  const innerStrokeRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const outerStrokeRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const isDomain = node.kind === 'domain';
  const colors = isDomain ? NODE_COLORS.domain : NODE_COLORS.topic;

  const getColor = () => {
    if (selected) return colors.selected;
    if (hovered) return colors.hover;
    if (learned) return colors.learned;
    return colors.base;
  };

  const baseSize = isDomain ? 3 : 1.5;
  // 章节环内径仅比节点大 0.3，选中态只做轻微放大，视觉强调交给颜色与描边。
  const targetScale = selected ? (isDomain ? 1.06 : 1.1) : hovered ? (isDomain ? 1.04 : 1.07) : 1;

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
      innerStrokeRef.current.opacity =
        (dimmed ? 0.12 : hovered ? 0.52 : selected ? 0.46 : 0.34) * focusFade;
    }
    if (outerStrokeRef.current) {
      outerStrokeRef.current.opacity =
        (dimmed ? 0.08 : hovered ? 0.4 : selected ? 0.36 : 0.26) * focusFade;
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
        onHover(node.id, e.clientX, e.clientY, e.eventObject);
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
      {/* 节点视觉始终正对相机，避免透视边缘把圆球拉成椭圆 */}
      <Billboard>
      <mesh ref={meshRef}>
        <circleGeometry args={[1, 64]} />
        <meshBasicMaterial color={getColor()} transparent opacity={1} />

        {/* 内描边：球面边缘的亮环 */}
        <mesh scale={1.015} position={[0, 0, 0.012]} raycast={() => null} renderOrder={1}>
          <ringGeometry args={[0.9, 1, 64]} />
          <meshBasicMaterial ref={innerStrokeRef} color={isDomain ? STROKE_COLORS.inner : TOPIC_STROKE_COLORS.inner} transparent opacity={hovered ? 0.52 : selected ? 0.46 : 0.34} depthWrite={false} />
        </mesh>

        {/* 外描边：紧贴球体轮廓外的蓝色发光，向外渐隐 */}
        <mesh scale={1.16} position={[0, 0, 0.008]} raycast={() => null} renderOrder={1}>
          <ringGeometry args={[0.86, 1, 64]} />
          <meshBasicMaterial ref={outerStrokeRef} color={isDomain ? STROKE_COLORS.outer : TOPIC_STROKE_COLORS.outer} transparent opacity={hovered ? 0.4 : selected ? 0.36 : 0.26} depthWrite={false} />
        </mesh>
      </mesh>
      </Billboard>

      {/* 进度描边 */}
      <ProgressRing radius={baseSize} progress={progress} mastery={mastery} variant={isDomain ? 'chapter' : 'topic'} hovered={hovered} selected={selected} />

      {/* 标签 */}
      <Billboard>
        <Text
          font={cjkFontUrl}
          sdfGlyphSize={128}
          ref={textRef}
          raycast={() => null}
          renderOrder={2}
          position={getTextPosition()}
          fontSize={isDomain ? 1.6 : 1.2}
          maxWidth={isDomain ? 12 : 14}
          lineHeight={1.28}
          letterSpacing={0.025}
          textAlign={isDomain ? 'center' : direction === 'left' ? 'right' : 'left'}
          color={isDomain ? '#FFFFFF' : '#3D4A3A'}
          anchorX={textAnchor.x}
          anchorY={textAnchor.y}
          outlineWidth={isDomain ? 0.04 : 0.02}
          outlineColor={isDomain ? '#000000' : '#FFFFFF'}
          outlineOpacity={0.5}
        >
          {format3DLabel(node.label)}
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
  chapterProgress,
  topicMastery,
  topicProgress,
  expandedTopicId,
  onExpandedTopicChange,
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
  chapterProgress: Record<string, number>;
  topicMastery: Record<string, number>;
  topicProgress: Record<string, number>;
  expandedTopicId: string | null;
  onExpandedTopicChange: (id: string | null) => void;
  hoveredId: string | null;
  onHoverNode: (id: string | null, clientX?: number, clientY?: number, object?: THREE.Object3D) => void;
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
        onExpandedTopicChange(expandedTopicId === node.id ? null : node.id);
      }
    },
    [onSelectKp, onSelectTopic, onExpandedKpChange, expandedTopicId, onExpandedTopicChange],
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
        let nodeMastery = 0;
        if (node.kind === 'domain') {
          progress = chapterProgress[node.kpId] ?? 0;
          nodeMastery = mastery[node.kpId] ?? 0;
        } else {
          progress = topicProgress[node.id] ?? topicMastery[node.id] ?? 0;
          nodeMastery = topicMastery[node.id] ?? 0;
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
            mastery={nodeMastery}
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
  nodes,
  edges,
  selectedKpId,
  expandedKpIds,
  onSelectKp,
  onSelectTopic,
  onExpandedKpChange,
  learned,
  mastery,
  chapterProgress,
  topicMastery,
  topicProgress,
  focusTarget,
  className,
  showLearned = false,
  resources = {},
  presentations = [],
  goalId = null,
  persistenceKey,
  restorePersistedCamera = false,
}: KnowledgeGraph3DProps) {
  /** 当前展开“功能节点层”（定制讲义/实操指南/分阶测试题/交互课件）的子知识点，与章节展开互不干扰 */
  const topicStorageKey = persistenceKey ? `lf.knowledgeGraph3dTopic:v1:${persistenceKey}` : null;
  const [expandedTopicId, setExpandedTopicId] = useState<string | null>(() => {
    if (!topicStorageKey) return null;
    try { return window.sessionStorage.getItem(topicStorageKey); } catch { return null; }
  });
  useEffect(() => {
    if (!topicStorageKey) return;
    try {
      if (expandedTopicId) window.sessionStorage.setItem(topicStorageKey, expandedTopicId);
      else window.sessionStorage.removeItem(topicStorageKey);
    } catch { /* ignore */ }
  }, [expandedTopicId, topicStorageKey]);
  const actionTopic = useMemo(
    () => nodes.find((node) => node.kind === 'topic' && node.id === expandedTopicId) ?? null,
    [nodes, expandedTopicId],
  );
  useEffect(() => {
    if (!actionTopic) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpandedTopicId(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [actionTopic]);
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hoverCardRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [hoveredNode, setHoveredNode] = useState<{ id: string; x: number; y: number; object: THREE.Object3D } | null>(null);
  const hoveredNodeId = hoveredNode?.id ?? null;
  const handleHoverNode = useCallback((id: string | null, clientX?: number, clientY?: number, object?: THREE.Object3D) => {
    if (draggingRef.current) return;
    if (!id) { setHoveredNode(null); return; }
    if (!object) return;
    const rect = containerRef.current?.getBoundingClientRect();
    setHoveredNode({ id, x: (clientX ?? 0) - (rect?.left ?? 0), y: (clientY ?? 0) - (rect?.top ?? 0), object });
  }, []);
  const hoveredGraphNode = useMemo(() => nodes.find((node) => node.id === hoveredNodeId) ?? null, [nodes, hoveredNodeId]);
  const hoveredMetrics = useMemo(() => {
    if (!hoveredGraphNode) return null;
    if (expandedKpIds.size > 0) {
      const activeExpandedChapter = selectedKpId && expandedKpIds.has(selectedKpId)
        ? selectedKpId
        : Array.from(expandedKpIds).at(-1);
      const belongsToExpandedChapter = hoveredGraphNode.kind === 'domain'
        ? hoveredGraphNode.id === activeExpandedChapter
        : hoveredGraphNode.kpId === activeExpandedChapter;
      if (!belongsToExpandedChapter) return null;
    }
    if (expandedTopicId && hoveredGraphNode.kind === 'domain') return null;
    const metrics = hoveredGraphNode.kind === 'domain'
      ? { progress: chapterProgress[hoveredGraphNode.kpId] ?? 0, mastery: mastery[hoveredGraphNode.kpId] ?? 0 }
      : { progress: topicProgress[hoveredGraphNode.id] ?? 0, mastery: topicMastery[hoveredGraphNode.id] ?? 0 };
    return { ...metrics, overallMastery: Math.round(metrics.progress * metrics.mastery) / 100 };
  }, [hoveredGraphNode, expandedKpIds, selectedKpId, expandedTopicId, chapterProgress, mastery, topicProgress, topicMastery]);

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
      ref={containerRef}
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
          onStart={() => {
            draggingRef.current = true;
            setHoveredNode(null);
            document.body.style.cursor = 'grabbing';
          }}
          onEnd={() => {
            draggingRef.current = false;
            document.body.style.cursor = 'default';
          }}
        />
        <PersistedCamera storageKey={persistenceKey} restore={restorePersistedCamera} />
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
            chapterProgress={chapterProgress}
            topicMastery={topicMastery}
            topicProgress={topicProgress}
            expandedTopicId={expandedTopicId}
            onExpandedTopicChange={setExpandedTopicId}
            animRef={blendRef}
            focusId={dimAnchorId}
            hoveredId={hoveredNodeId}
            onHoverNode={handleHoverNode}
            showLearned={showLearned}
          />
        </RotatingScene>
        <CameraFocus focusTarget={focusTarget} layout={layout} sceneRef={sceneRef} blendRef={blendRef} topicCountByKp={topicCountByKp} />
        {hoveredNode && <HoverCardTracker object={hoveredNode.object} cardRef={hoverCardRef} />}
      </Canvas>

      {actionTopic && (
        <TopicActionModal
          node={actionTopic}
          resources={resources[actionTopic.kpId] ?? []}
          presentations={presentations}
          goalId={goalId}
          learned={learned}
          progress={topicProgress[actionTopic.id] ?? 0}
          mastery={topicMastery[actionTopic.id] ?? 0}
          onClose={() => setExpandedTopicId(null)}
        />
      )}

      {hoveredNode && hoveredGraphNode && hoveredMetrics && <div ref={hoverCardRef} className="pointer-events-none absolute z-20 w-[230px] -translate-y-1/2 rounded-[16px] border border-white/70 bg-white/92 p-4 shadow-warm-lg backdrop-blur-md" style={{ left: hoveredNode.x, top: hoveredNode.y, transform: hoveredGraphNode.kind === 'domain'
        ? 'translate(calc(-100% - 92px), calc(-50% + 54px))'
        : `translate(${layout.childDirections.get(hoveredGraphNode.id) === 'left' ? '52px' : 'calc(-100% - 52px)'}, -50%)` }}>
        <div className="font-mono text-[9.5px] tracking-[0.14em] text-brand">{hoveredGraphNode.kind === 'domain' ? '章节概览' : '知识点概览'}</div>
        <div className="mt-1 line-clamp-2 font-serif text-[15px] font-semibold leading-5 text-ink">{hoveredGraphNode.label}</div>
        <div className="mt-4 space-y-3">
          <div><div className="mb-1.5 flex items-center justify-between text-[11px]"><span className="text-ink-2">学习进度</span><span className="font-mono font-semibold text-brand">{hoveredMetrics.progress}%</span></div><div className="relative h-2 overflow-hidden rounded-full bg-[#D7DDD9]"><div className="absolute inset-y-0 left-0 rounded-full bg-[#55B9DC] transition-[width]" style={{ width: `${hoveredMetrics.progress}%` }} /><div className="absolute inset-y-[1px] left-0 rounded-full bg-[#155E9A] transition-[width]" style={{ width: `${hoveredMetrics.overallMastery}%` }} /></div><div className="mt-1.5 flex items-center gap-3 text-[9px] text-ink-muted"><span><i className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[#55B9DC]" />已学习</span><span><i className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[#155E9A]" />进度内已掌握</span></div></div>
          <div className="flex items-center justify-between gap-3 rounded-[10px] border border-[#155E9A]/20 bg-[#155E9A]/5 px-3 py-2.5"><div><div className="text-[11px] font-medium text-ink-2">{hoveredGraphNode.kind === 'domain' ? '当前章节掌握程度' : '当前知识点掌握程度'}</div><div className="mt-0.5 text-[9px] text-ink-muted">按全部内容范围计算</div></div><div className="relative h-12 w-12 shrink-0"><svg viewBox="0 0 48 48" className="h-full w-full -rotate-90" aria-hidden="true"><circle cx="24" cy="24" r="19" fill="none" stroke="#D8E5EF" strokeWidth="5" /><circle cx="24" cy="24" r="19" fill="none" stroke="#155E9A" strokeWidth="5" strokeLinecap="round" pathLength="100" strokeDasharray={`${hoveredMetrics.overallMastery} 100`} /></svg><span className="absolute inset-0 flex items-center justify-center font-mono text-[11px] font-semibold text-[#155E9A]">{hoveredMetrics.overallMastery}%</span></div></div>
        </div>
        <p className="mt-3 text-[9.5px] leading-4 text-ink-muted">深蓝部分由已学习范围内的自评与答题正确率计算，不会超过学习进度。</p>
      </div>}

      {/* 提示 */}
      <div className="absolute bottom-4 left-4 rounded-lg bg-white/90 px-3 py-2 text-[11px] text-ink-muted backdrop-blur-sm border border-hairline/50">
        🖱️ 拖拽旋转 · 滚轮缩放 · 悬停查看关联 · 点击章节展开
      </div>

    </div>
  );
}
