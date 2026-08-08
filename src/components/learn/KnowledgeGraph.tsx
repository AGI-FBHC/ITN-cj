/**
 * KnowledgeGraph — 知识图谱（学情可视化 + 自主选点入口）
 * 液面填充球：学过的按掌握度充液（达标转琥珀金），没学过灰色空球；
 * 目标水位刻线；置信度 = 描边实度；阿诊推荐节点呼吸光圈；
 * 语义边三态（前置实线箭头/相关虚线/应用细线）；hover 高亮前置链；
 * 路径叠加开关：ARB-05 学习路径在图上连成发光链。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Route, Info } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { useAgent } from '@/context/AgentContext';
import { useNotes } from '@/context/NotesContext';
import { reportForLearner } from '@/data/reportBuilder';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import {
  graphNodes,
  graphEdges,
  graphViewBox,
  getNode,
  prereqOf,
  learnedKpIds,
  topicMastery,
} from '@/data/knowledgeGraph';
import type { GraphNode } from '@/data/knowledgeGraph';
import { cn } from '@/lib/utils';

const EDGE_STYLE = {
  prereq: { stroke: '#4E7860', width: 1.8, dash: undefined as string | undefined, opacity: 0.55 },
  related: { stroke: '#B77552', width: 1.3, dash: '5 4', opacity: 0.45 },
  applies: { stroke: '#66725E', width: 1, dash: '2 4', opacity: 0.4 },
};

/** 花园共享渐变/滤镜（整张图只定义一次） */
function GardenDefs() {
  return (
    <defs>
      <linearGradient id="g-leaf" x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0%" stopColor="#E3F4EA" stopOpacity="0.95" />
        <stop offset="45%" stopColor="#A8D4BA" stopOpacity="0.9" />
        <stop offset="100%" stopColor="#6FA98A" stopOpacity="0.8" />
      </linearGradient>
      <linearGradient id="g-leaf2" x1="0.2" y1="0" x2="0.8" y2="1">
        <stop offset="0%" stopColor="#F0FAF3" stopOpacity="0.92" />
        <stop offset="50%" stopColor="#BADEC8" stopOpacity="0.86" />
        <stop offset="100%" stopColor="#84BC9C" stopOpacity="0.76" />
      </linearGradient>
      <radialGradient id="g-petal" cx="0.38" cy="0.32" r="0.8">
        <stop offset="0%" stopColor="#FFF6F8" stopOpacity="0.98" />
        <stop offset="55%" stopColor="#F2CBD6" stopOpacity="0.9" />
        <stop offset="100%" stopColor="#E0A8BB" stopOpacity="0.76" />
      </radialGradient>
      <radialGradient id="g-gold" cx="0.38" cy="0.32" r="0.85">
        <stop offset="0%" stopColor="#FFF3D0" />
        <stop offset="60%" stopColor="#EFC169" />
        <stop offset="100%" stopColor="#D9A247" />
      </radialGradient>
      <linearGradient id="g-stem" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stopColor="#5E9377" stopOpacity="0.9" />
        <stop offset="100%" stopColor="#9CC9AE" stopOpacity="0.8" />
      </linearGradient>
      <radialGradient id="g-soil" cx="0.5" cy="0.3" r="0.8">
        <stop offset="0%" stopColor="#D8BFA4" stopOpacity="0.7" />
        <stop offset="100%" stopColor="#B99372" stopOpacity="0.55" />
      </radialGradient>
      <filter id="g-glow" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="2.6" result="b" />
        <feComponentTransfer in="b" result="s">
          <feFuncA type="linear" slope="0.7" />
        </feComponentTransfer>
        <feMerge>
          <feMergeNode in="s" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

/** 生长阶段：0 种子 / 1 破土 / 2 长叶 / 3 花蕾 / 4 开花(达标) / 5 结果 */
function growthStage(mastery: number, target: number, learned: boolean): number {
  if (!learned) return 0;
  if (mastery >= 95) return 5;
  if (mastery >= target) return 4;
  const toTarget = mastery / Math.max(1, target);
  if (toTarget >= 0.8) return 3;
  if (toTarget >= 0.45) return 2;
  return 1;
}

/** 一株植物（单位空间：地面 y=0，向上生长至 -56） */
function Plant({ stage }: { stage: number }) {
  const leaf = (cx: number, cy: number, rx: number, ry: number, rot: number, alt = false) => (
    <g transform={`rotate(${rot} ${cx} ${cy})`}>
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={`url(#g-leaf${alt ? '2' : ''})`} />
      <ellipse cx={cx - rx * 0.28} cy={cy - ry * 0.34} rx={rx * 0.32} ry={ry * 0.26} fill="#FFFFFF" opacity="0.38" />
    </g>
  );

  /* 土壤 */
  const soil = <ellipse cx="0" cy="0" rx="14" ry="3.4" fill="url(#g-soil)" />;

  if (stage === 0) {
    /* 未学：一粒种子 + 「将来能长成什么」的虚影轮廓。
       否则 2/3 的节点只是个小土堆，花园看起来是空的、也看不出这里有东西可学。 */
    return (
      <g>
        <g opacity="0.22">
          <path d="M 0 -2 C -1.6 -11 1.6 -21 0 -30" stroke="#7FB295" strokeWidth="2" fill="none"
            strokeDasharray="3 3.5" strokeLinecap="round" />
          <ellipse cx="-8" cy="-13" rx="8.5" ry="4.2" transform="rotate(-28 -8 -13)"
            fill="none" stroke="#7FB295" strokeWidth="1.5" strokeDasharray="2.5 2.5" />
          <ellipse cx="8" cy="-16" rx="8.5" ry="4.2" transform="rotate(26 8 -16)"
            fill="none" stroke="#7FB295" strokeWidth="1.5" strokeDasharray="2.5 2.5" />
          <circle cx="0" cy="-32" r="3" fill="none" stroke="#E7B45A" strokeWidth="1.5" strokeDasharray="2 2" />
        </g>
        {soil}
        <ellipse cx="0" cy="-3.5" rx="4.6" ry="3.6" fill="#C09A78" opacity="0.92" />
        <ellipse cx="-1.2" cy="-4.8" rx="1.7" ry="1.2" fill="#FFFFFF" opacity="0.45" />
      </g>
    );
  }

  const stemTop = [0, -18, -30, -38, -43, -43][stage];
  return (
    <g>
      {soil}
      <path d={`M 0 -1 C -1.5 ${stemTop * 0.4} 1.5 ${stemTop * 0.7} 0 ${stemTop}`} stroke="url(#g-stem)" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      {/* 叶片：随阶段增多 */}
      {stage >= 1 && leaf(-8, -12, 8, 4, -28)}
      {stage >= 1 && leaf(8, -14, 8, 4, 26, true)}
      {stage >= 2 && leaf(-10, -23, 9.5, 4.6, -24, true)}
      {stage >= 2 && leaf(10, -25, 9.5, 4.6, 22)}
      {stage >= 3 && leaf(-8, -33, 7.5, 3.6, -20)}
      {stage >= 3 && leaf(8, -34, 7.5, 3.6, 18, true)}
      {/* 花蕾 */}
      {stage === 3 && (
        <g>
          <ellipse cx="0" cy="-42" rx="4.2" ry="6" fill="url(#g-petal)" />
          <ellipse cx="-1.2" cy="-44" rx="1.4" ry="2" fill="#FFFFFF" opacity="0.45" />
        </g>
      )}
      {/* 开花（达标） */}
      {stage >= 4 && (
        <g transform="translate(0 -46)">
          <g fill="url(#g-petal)">
            {[0, 72, 144, 216, 288].map((a) => (
              <ellipse key={a} rx="5.2" ry="2.8" transform={`rotate(${a}) translate(7 0)`} />
            ))}
          </g>
          <circle r="3.4" fill="url(#g-gold)" />
        </g>
      )}
      {/* 结果 */}
      {stage === 5 && (
        <g>
          <circle cx="-9" cy="-30" r="3.4" fill="url(#g-gold)" />
          <circle cx="9.5" cy="-19" r="3" fill="url(#g-gold)" />
        </g>
      )}
    </g>
  );
}

/** 环形进度弧（保留精确掌握度） */
function arcPath(cx: number, cy: number, R: number, pct: number): string {
  const p = Math.max(0.001, Math.min(0.999, pct));
  const a = p * 2 * Math.PI;
  const x2 = cx + R * Math.sin(a);
  const y2 = cy - R * Math.cos(a);
  return `M ${cx} ${cy - R} A ${R} ${R} 0 ${a > Math.PI ? 1 : 0} 1 ${x2} ${y2}`;
}

/** 花坛节点：植物按掌握度生长 + 环形进度 + 目标刻度 */
function PlantNode({
  n,
  mastery,
  target,
  learned,
  conf,
  highlight,
  recommended,
  dimmed,
  selected,
}: {
  n: GraphNode;
  mastery: number;
  target: number;
  learned: boolean;
  conf: number;
  highlight: boolean;
  recommended: boolean;
  dimmed: boolean;
  selected: boolean;
}) {
  const stage = growthStage(mastery, target, learned);
  const passed = learned && mastery >= target;
  const isDomain = n.kind === 'domain';
  /* 植物放大到略微探出花坛（破框感），小节点给更大的相对倍率才看得清长势 */
  const scale = ((isDomain ? 1.85 : 2.4) * n.r) / 56;
  const groundY = n.y + n.r * 0.5;
  const ringR = n.r - 2;
  const targetAngle = (target / 100) * 360 - 90;
  const tx = n.x + ringR * Math.cos((targetAngle * Math.PI) / 180);
  const ty = n.y + ringR * Math.sin((targetAngle * Math.PI) / 180);
  const plotOp = 0.35 + 0.5 * (conf / 100);

  return (
    <g className="cursor-pointer" opacity={dimmed ? 0.25 : 1} style={{ transition: 'opacity 0.25s' }}>
      {/* 阿诊推荐：呼吸光圈 */}
      {recommended && (
        <circle cx={n.x} cy={n.y} r={n.r + 7} fill="none" stroke="#E7B45A" strokeWidth="2" opacity="0.7">
          <animate attributeName="r" values={`${n.r + 5};${n.r + 10};${n.r + 5}`} dur="2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.7;0.15;0.7" dur="2s" repeatCount="indefinite" />
        </circle>
      )}
      {/* 选中：旋转虚线环 */}
      {selected && (
        <circle cx={n.x} cy={n.y} r={n.r + 5} fill="none" stroke="#4E7860" strokeWidth="2.5" strokeDasharray="4 3" opacity="0.85">
          <animateTransform attributeName="transform" type="rotate" from={`0 ${n.x} ${n.y}`} to={`360 ${n.x} ${n.y}`} dur="9s" repeatCount="indefinite" />
        </circle>
      )}
      {/* hover 前置链高亮 */}
      {highlight && <circle cx={n.x} cy={n.y} r={n.r + 4} fill="none" stroke="#E7B45A" strokeWidth="2.5" opacity="0.9" />}

      {/* 花坛（玻璃圆盘） */}
      <circle
        cx={n.x}
        cy={n.y}
        r={n.r}
        fill={learned ? 'rgba(251,250,245,0.62)' : 'rgba(236,241,234,0.5)'}
        stroke={passed ? '#E7B45A' : learned ? '#9BC5AC' : '#C4D3C8'}
        strokeWidth={isDomain ? 1.6 : 1.2}
        strokeOpacity={plotOp}
      />
      {/* 掌握度进度弧 + 目标刻度（域节点） */}
      {isDomain && learned && (
        <>
          <path
            d={arcPath(n.x, n.y, ringR, mastery / 100)}
            fill="none"
            stroke={passed ? '#E7B45A' : '#7FB295'}
            strokeWidth="3"
            strokeLinecap="round"
            opacity="0.85"
            style={{ transition: 'd 0.8s cubic-bezier(0.22,1,0.36,1)' }}
          />
          <circle cx={tx} cy={ty} r="2.4" fill="#B0483B" opacity="0.85" />
        </>
      )}

      {/* 植物 */}
      <g
        transform={`translate(${n.x} ${groundY}) scale(${scale})`}
        filter={stage >= 4 ? 'url(#g-glow)' : undefined}
        style={{ pointerEvents: 'none' }}
      >
        <Plant stage={stage} />
      </g>

      {/* 掌握度数字（域节点，落在花坛底部） */}
      {isDomain && (
        <text
          x={n.x}
          y={n.y + n.r - 5}
          textAnchor="middle"
          fontSize="11.5"
          fontWeight="700"
          fontFamily="'IBM Plex Mono', monospace"
          fill={learned ? '#3D4A3A' : '#66725E'}
          stroke="#FBFAF5"
          strokeWidth="2.6"
          strokeLinejoin="round"
          paintOrder="stroke"
          style={{ pointerEvents: 'none' }}
        >
          {learned ? mastery : '—'}
        </text>
      )}

      {/* 标签 - 域节点居中于下方；子节点沿径向朝外，避免互相重叠 */}
      <text
        x={n.labelX}
        y={n.labelY}
        textAnchor={n.labelAnchor}
        fontSize={n.kind === 'domain' ? 12.5 : 9.5}
        fontWeight={n.kind === 'domain' ? 600 : 400}
        fill={dimmed ? '#A9B6A0' : '#5A6553'}
        stroke="#FBFAF5"
        strokeWidth={n.kind === 'domain' ? 3 : 2.4}
        strokeLinejoin="round"
        paintOrder="stroke"
        style={{ pointerEvents: 'none' }}
      >
        {n.label}
      </text>
    </g>
  );
}

export default function KnowledgeGraph({
  onSelectKp,
  selectedKpId,
}: {
  /** 提供后：点节点 = 选中（联动右栏详情），不直接跳转 */
  onSelectKp?: (kpId: string) => void;
  selectedKpId?: string | null;
} = {}) {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const { confidence } = useAgent();
  const { countByKp } = useNotes();
  const report = reportForLearner(currentLearner);
  const [hover, setHover] = useState<GraphNode | null>(null);
  const [showPath, setShowPath] = useState(false);

  const pathDone = report.path.filter((p) => p.status === 'done').map((p) => p.kpId);
  const learned = useMemo(() => learnedKpIds(currentLearner, pathDone), [currentLearner, pathDone]);
  const activeKp = report.path.find((p) => p.status === 'active')?.kpId ?? null;

  /* hover 前置链：来源节点 + 相连边 */
  const chain = useMemo(() => {
    if (!hover) return { nodes: new Set<string>(), edges: new Set<number>() };
    const nodes = new Set<string>([hover.id]);
    const edges = new Set<number>();
    graphEdges.forEach((e, i) => {
      if (e.to === hover.id || e.from === hover.id) {
        edges.add(i);
        nodes.add(e.from);
        nodes.add(e.to);
      }
    });
    return { nodes, edges };
  }, [hover]);

  const prereqs = hover ? prereqOf(hover.id) : [];

  /* 路径叠加：按路径顺序连接域节点（去重保序） */
  const pathChain = useMemo(() => {
    const seq: string[] = [];
    report.path.forEach((p) => {
      if (!seq.includes(p.kpId)) seq.push(p.kpId);
    });
    return seq.map((id) => getNode(id)!).filter(Boolean);
  }, [report]);

  /** 单击：选中（右栏出详情）。无右栏时直接进课件 */
  const go = (n: GraphNode) => {
    if (onSelectKp) {
      onSelectKp(n.kpId);
      return;
    }
    openUnit(n);
  };

  /** 双击：跳过选择，直接进交互课件 —— 兑现「点一株即学」 */
  const openUnit = (n: GraphNode) => {
    if (n.kind === 'domain') navigate(`/learn/${n.kpId}`);
    else navigate(`/learn/${n.kpId}?block=c${Math.min(n.topicIndex ?? 0, 2)}`);
  };

  return (
    <div className="lf-card relative overflow-hidden p-4">
      {/* 工具条 */}
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="text-[12px] text-ink-2">
          <span className="font-medium text-ink">我的知识花园</span>
          <span className="text-ink-muted"> · 植物长得越大 = 学得越好；点一株 → 右边选怎么学（双击直接进课件）</span>
        </div>
        <button
          type="button"
          onClick={() => setShowPath((v) => !v)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] font-medium transition-all',
            showPath ? 'border-brand-amber bg-brand-amber-tint text-ochre' : 'border-hairline bg-paper text-ink-muted hover:border-brand/40',
          )}
        >
          <Route size={12} />
          学习路径叠加
        </button>
      </div>

      <svg viewBox={`0 0 ${graphViewBox.w} ${graphViewBox.h}`} className="w-full">
        {/* 花园渐变/滤镜 */}
        <GardenDefs />
        <defs>
          <marker id="kg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="#4E7860" opacity="0.6" />
          </marker>
        </defs>
        {/* 边 = 藤蔓（弧线 + 中点小叶） */}
        {graphEdges.map((e, i) => {
          const a = getNode(e.from)!;
          const b = getNode(e.to)!;
          const st = EDGE_STYLE[e.kind];
          const hot = chain.edges.has(i);
          const dx = b.x - a.x, dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const x1 = a.x + (dx / len) * (a.r + 3), y1 = a.y + (dy / len) * (a.r + 3);
          const x2 = b.x - (dx / len) * (b.r + 5), y2 = b.y - (dy / len) * (b.r + 5);
          /* 藤蔓弯曲：沿垂直方向拱起 */
          const bow = Math.min(26, len * 0.16);
          const qx = (x1 + x2) / 2 + (-dy / len) * bow;
          const qy = (y1 + y2) / 2 + (dx / len) * bow;
          /* 弧线中点（t=0.5 的二次贝塞尔点），放一片小叶 */
          const mx = 0.25 * x1 + 0.5 * qx + 0.25 * x2;
          const my = 0.25 * y1 + 0.5 * qy + 0.25 * y2;
          const leafRot = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
          const op = hover && !hot ? 0.12 : hot ? 0.95 : st.opacity;
          return (
            <g key={i} style={{ transition: 'opacity 0.25s' }} opacity={op}>
              <path
                d={`M ${x1} ${y1} Q ${qx} ${qy} ${x2} ${y2}`}
                fill="none"
                stroke={hot ? '#E7B45A' : st.stroke}
                strokeWidth={hot ? st.width + 1 : st.width}
                strokeDasharray={st.dash}
                strokeLinecap="round"
                markerEnd={e.kind === 'prereq' ? 'url(#kg-arrow)' : undefined}
              />
              {e.kind === 'prereq' && (
                <g transform={`rotate(${leafRot} ${mx} ${my})`}>
                  <ellipse cx={mx} cy={my - 2.6} rx="5" ry="2.4" fill="url(#g-leaf)" opacity={hot ? 1 : 0.75} />
                </g>
              )}
            </g>
          );
        })}

        {/* 路径叠加 */}
        {showPath && pathChain.length > 1 && (
          <g>
            <polyline
              points={pathChain.map((n) => `${n.x},${n.y}`).join(' ')}
              fill="none"
              stroke="#E7B45A"
              strokeWidth="3.5"
              strokeLinejoin="round"
              strokeDasharray="10 7"
              opacity="0.65"
            >
              <animate attributeName="stroke-dashoffset" values="0;-34" dur="1.6s" repeatCount="indefinite" />
            </polyline>
            {pathChain.map((n, i) => (
              <g key={n.id}>
                <circle cx={n.x + n.r - 4} cy={n.y - n.r + 2} r="9" fill="#E7B45A" />
                <text x={n.x + n.r - 4} y={n.y - n.r + 5.5} textAnchor="middle" fontSize="10" fontWeight="700" fill="#FBFAF5" fontFamily="monospace">{i + 1}</text>
              </g>
            ))}
          </g>
        )}

        {/* 节点 */}
        {graphNodes.map((n) => {
          const isLearned = learned.has(n.kpId);
          const kp = getKnowledgePoint(n.kpId);
          const mastery = n.kind === 'domain' ? currentLearner.scores[n.kpId] ?? 50 : topicMastery(currentLearner, n.kpId, n.topicIndex ?? 0);
          return (
            <g
              key={n.id}
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(null)}
              onClick={() => go(n)}
              onDoubleClick={() => openUnit(n)}
            >
              <PlantNode
                n={n}
                mastery={mastery}
                target={kp.targetLevel}
                learned={isLearned}
                conf={confidence[n.kpId] ?? 40}
                highlight={chain.nodes.has(n.id) && hover?.id !== n.id}
                recommended={n.kind === 'domain' && n.kpId === activeKp}
                dimmed={hover !== null && !chain.nodes.has(n.id)}
                selected={n.kind === 'domain' && selectedKpId === n.kpId}
              />
              {/* 笔记角标（个人知识库） */}
              {n.kind === 'domain' && (countByKp[n.kpId] ?? 0) > 0 && (
                <g opacity={hover !== null && !chain.nodes.has(n.id) ? 0.25 : 1}>
                  <circle cx={n.x - n.r + 3} cy={n.y - n.r + 3} r="8.5" fill="#B77552" />
                  <text x={n.x - n.r + 3} y={n.y - n.r + 6.5} textAnchor="middle" fontSize="9" fontWeight="700" fill="#FBFAF5" fontFamily="monospace">
                    {countByKp[n.kpId]}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>

      {/* 图例 */}
      <div className="pointer-events-none absolute bottom-3 left-4 rounded-[10px] border border-hairline bg-paper/90 px-3 py-2 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[10.5px] text-ink-muted">
          {/* 生长阶段图例 */}
          <span className="flex items-center gap-1.5">
            <svg width="14" height="16" viewBox="-20 -56 40 60">
              <g opacity=".3"><path d="M0 -2 L0 -28" stroke="#7FB295" strokeWidth="2" strokeDasharray="3 3.5" /><ellipse cx="-8" cy="-13" rx="8.5" ry="4.2" transform="rotate(-28 -8 -13)" fill="none" stroke="#7FB295" strokeWidth="1.5" strokeDasharray="2.5 2.5" /></g>
              <ellipse cx="0" cy="0" rx="14" ry="3.4" fill="#C09A78" opacity=".6" /><ellipse cx="0" cy="-3.5" rx="4.6" ry="3.6" fill="#C09A78" />
            </svg>
            种子·还没学（虚线=能长成的样子）
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="14" height="16" viewBox="-20 -56 40 60"><path d="M0 -1 L0 -26" stroke="#7FB295" strokeWidth="2.6" strokeLinecap="round" /><ellipse cx="-8" cy="-14" rx="8" ry="4" transform="rotate(-28 -8 -14)" fill="#9BC5AC" /><ellipse cx="8" cy="-18" rx="8" ry="4" transform="rotate(26 8 -18)" fill="#B4D6C1" /></svg>
            长叶·在学
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="14" height="18" viewBox="-20 -56 40 60"><path d="M0 -1 L0 -40" stroke="#7FB295" strokeWidth="2.6" strokeLinecap="round" /><ellipse cx="-8" cy="-16" rx="8" ry="4" transform="rotate(-28 -8 -16)" fill="#9BC5AC" /><g transform="translate(0 -44)"><g fill="#F2CBD6">{[0, 72, 144, 216, 288].map((a) => <ellipse key={a} rx="5.2" ry="2.8" transform={`rotate(${a}) translate(7 0)`} />)}</g><circle r="3.4" fill="#EFC169" /></g></svg>
            开花·达标
          </span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-5 rounded-full border-t-2 border-brand" />前置藤</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-5 border-t-2 border-dashed border-ochre" />相关</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 animate-pulse rounded-full border-2 border-brand-amber" />阿诊推荐</span>
        </div>
      </div>

      {/* hover tooltip */}
      {hover && (
        <div
          className="lf-glass pointer-events-none absolute z-10 w-[240px] rounded-[12px] p-3"
          style={{
            left: `${Math.min(92, Math.max(2, (hover.x / graphViewBox.w) * 100))}%`,
            top: `${Math.max(2, ((hover.y - hover.r) / graphViewBox.h) * 100 - 6)}%`,
            transform: 'translate(-50%, -100%)',
          }}
        >
          <div className="text-[13px] font-semibold text-ink">
            {hover.kind === 'topic' ? getKnowledgePoint(hover.kpId).coreTopics[hover.topicIndex ?? 0] : hover.label}
          </div>
          <div className="mt-1 font-mono text-[10.5px] text-ink-muted">
            {learned.has(hover.kpId)
              ? `掌握 ${hover.kind === 'domain' ? currentLearner.scores[hover.kpId] ?? 50 : topicMastery(currentLearner, hover.kpId, hover.topicIndex ?? 0)} / 目标 ${getKnowledgePoint(hover.kpId).targetLevel} · 置信 ${confidence[hover.kpId] ?? 40}%`
              : '尚未学习 · 点击开始'}
          </div>
          {prereqs.length > 0 && (
            <div className="mt-1.5 border-t border-hairline pt-1.5">
              <div className="flex items-center gap-1 text-[10.5px] font-medium text-ochre">
                <Info size={10} />
                建议先过：{prereqs.map((p) => p.node.label).join('、')}
              </div>
            </div>
          )}
          <div className="mt-1 text-[10.5px] text-brand">
            点一下 → 右边选怎么学 · 双击 → 直接进课件{hover.kind === 'topic' ? '并定位到这个概念' : ''}
          </div>
        </div>
      )}
    </div>
  );
}
