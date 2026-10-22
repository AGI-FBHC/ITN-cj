/**
 * HeroScene — 总览 Hero 3D 画布（全站唯一 3D 场景）
 * 5 个发光节点（Agent 五色）缓慢漂移 + 细线相连 + 琥珀脉冲沿边流动
 * 鼠标视差 ±6°，节点 hover 浮现 Agent 名 tooltip
 */
import { useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import { agents } from '@/data/agents';

/* 节点基础位置（五边形布局，中心 ARB） */
const NODE_POS: [number, number, number][] = [
  [-2.1, 0.9, 0.2],   // DIA
  [2.0, 1.15, -0.4],  // RET
  [-1.5, -1.35, 0.5], // GEN
  [2.15, -1.05, 0.3], // VER
  [0, 0.05, 0],       // ARB
];
const EDGES: [number, number][] = [
  [4, 0], [4, 1], [4, 2], [4, 3], [0, 2], [1, 3],
];

function useDrift(index: number) {
  return useMemo(
    () => ({
      base: new THREE.Vector3(...NODE_POS[index]),
      phase: index * 1.7,
      speed: 0.32 + (index % 3) * 0.07,
      amp: 0.1 + (index % 2) * 0.05,
    }),
    [index],
  );
}

function AgentNode({ index }: { index: number }) {
  const agent = agents[index];
  const drift = useDrift(index);
  const group = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const g = group.current;
    if (!g) return;
    g.position.set(
      drift.base.x + Math.sin(t * drift.speed + drift.phase) * drift.amp,
      drift.base.y + Math.cos(t * drift.speed * 0.8 + drift.phase) * drift.amp,
      drift.base.z + Math.sin(t * drift.speed * 0.6 + drift.phase * 2) * drift.amp * 0.6,
    );
    const s = THREE.MathUtils.lerp(g.scale.x, hovered ? 1.35 : 1, 0.12);
    g.scale.setScalar(s);
  });

  const isArb = index === 4;
  return (
    <group ref={group} position={NODE_POS[index]}>
      {/* 光晕 */}
      <mesh>
        <sphereGeometry args={[isArb ? 0.62 : 0.5, 24, 24]} />
        <meshBasicMaterial color={agent.color} transparent opacity={0.14} depthWrite={false} />
      </mesh>
      <mesh>
        <sphereGeometry args={[isArb ? 0.4 : 0.32, 24, 24]} />
        <meshBasicMaterial color={agent.color} transparent opacity={0.3} depthWrite={false} />
      </mesh>
      {/* 核心 */}
      <mesh
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = 'auto';
        }}
      >
        <sphereGeometry args={[isArb ? 0.19 : 0.14, 32, 32]} />
        <meshStandardMaterial
          color={agent.color}
          emissive={agent.color}
          emissiveIntensity={1.6}
          roughness={0.35}
        />
      </mesh>
      {hovered && (
        <Html center distanceFactor={8} position={[0, 0.55, 0]}>
          <div className="pointer-events-none rounded-lg border border-hairline bg-card-warm px-3 py-1.5 whitespace-nowrap shadow-warm">
            <div className="font-mono text-[11px] font-semibold" style={{ color: agent.color }}>
              {agent.code}
            </div>
            <div className="text-[12px] font-medium text-ink">{agent.name}</div>
          </div>
        </Html>
      )}
    </group>
  );
}

function EdgePulse({ from, to, offset }: { from: number; to: number; offset: number }) {
  const driftA = useDrift(from);
  const driftB = useDrift(to);
  const mesh = useRef<THREE.Mesh>(null);
  const a = useRef(new THREE.Vector3());
  const b = useRef(new THREE.Vector3());

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    a.current.set(
      driftA.base.x + Math.sin(t * driftA.speed + driftA.phase) * driftA.amp,
      driftA.base.y + Math.cos(t * driftA.speed * 0.8 + driftA.phase) * driftA.amp,
      driftA.base.z + Math.sin(t * driftA.speed * 0.6 + driftA.phase * 2) * driftA.amp * 0.6,
    );
    b.current.set(
      driftB.base.x + Math.sin(t * driftB.speed + driftB.phase) * driftB.amp,
      driftB.base.y + Math.cos(t * driftB.speed * 0.8 + driftB.phase) * driftB.amp,
      driftB.base.z + Math.sin(t * driftB.speed * 0.6 + driftB.phase * 2) * driftB.amp * 0.6,
    );
    const p = (t / 1.6 + offset) % 1;
    mesh.current?.position.lerpVectors(a.current, b.current, p);
  });

  return (
    <mesh ref={mesh}>
      <sphereGeometry args={[0.045, 12, 12]} />
      <meshBasicMaterial color="#E5A94B" />
    </mesh>
  );
}

function EdgeLines() {
  /* 静态细线（基于基准位置，漂移幅度小可接受） */
  return (
    <>
      {EDGES.map(([a, b], i) => (
        <Line
          key={i}
          points={[NODE_POS[a], NODE_POS[b]]}
          color="#8FA39B"
          lineWidth={1}
          transparent
          opacity={0.45}
        />
      ))}
      {EDGES.map(([a, b], i) => (
        <EdgePulse key={`p${i}`} from={a} to={b} offset={i * 0.17} />
      ))}
    </>
  );
}

function ParallaxRig({ children }: { children: React.ReactNode }) {
  const group = useRef<THREE.Group>(null);
  useFrame(({ pointer }) => {
    if (!group.current) return;
    /* 鼠标视差 ±6° */
    group.current.rotation.y = THREE.MathUtils.lerp(group.current.rotation.y, pointer.x * 0.105, 0.05);
    group.current.rotation.x = THREE.MathUtils.lerp(group.current.rotation.x, -pointer.y * 0.105, 0.05);
  });
  return <group ref={group}>{children}</group>;
}

export default function HeroScene() {
  return (
    <Canvas
      camera={{ position: [0, 0, 7.2], fov: 42 }}
      dpr={[1, 1.8]}
      gl={{ antialias: true, alpha: true }}
      style={{ background: 'transparent' }}
    >
      <ambientLight intensity={0.85} />
      <pointLight position={[6, 6, 8]} intensity={60} color="#F4E7DC" />
      <ParallaxRig>
        <EdgeLines />
        {agents.map((_, i) => (
          <AgentNode key={i} index={i} />
        ))}
      </ParallaxRig>
    </Canvas>
  );
}
