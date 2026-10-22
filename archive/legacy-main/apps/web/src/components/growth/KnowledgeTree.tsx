/**
 * KnowledgeTree — 五阶段程序化 SVG 知识树
 * 种子→发芽→幼苗→小树→大树；果实 = 达标知识点（琥珀果，title 提示）。
 * 走暖色工程质感（非卡通）：墨绿冠、赭色干、琥珀果。
 */
import { TREE_STAGES } from '@/context/GrowthContext';

const TRUNK = '#8A6238';
const LEAF = '#3E6650';
const LEAF_LIGHT = '#6BA080';
const FRUIT = '#E7B45A';

export default function KnowledgeTree({
  stage,
  fruits,
  size = 200,
}: {
  stage: number;
  fruits: { kpId: string; name: string }[];
  size?: number;
}) {
  /* 画布 200x200，地面 y=170 */
  const fruitPos = [
    [78, 62], [122, 55], [100, 80], [65, 90], [135, 88], [100, 42],
  ];
  return (
    <svg viewBox="0 0 200 200" width={size} height={size} className="mx-auto block">
      {/* 地面 */}
      <ellipse cx="100" cy="172" rx="56" ry="10" fill="#DCE6DE" opacity="0.8" />

      {/* 阶段 0：种子 */}
      {stage === 0 && (
        <g className="kt-sway kt-seed">
          <ellipse cx="100" cy="166" rx="18" ry="8" fill="#C9B99A" />
          <ellipse cx="100" cy="162" rx="7" ry="9" fill={TRUNK} />
          <path d="M100 155 q3 -6 0 -10" stroke={LEAF_LIGHT} strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </g>
      )}

      {/* 阶段 1：发芽 */}
      {stage === 1 && (
        <g className="kt-sway">
          <path d="M100 170 q-1 -14 0 -22" stroke={LEAF_LIGHT} strokeWidth="3" fill="none" strokeLinecap="round" />
          <path d="M100 150 q-12 -8 -16 -2 q6 8 16 4 z" fill={LEAF} />
          <path d="M100 148 q12 -10 17 -3 q-6 9 -17 5 z" fill={LEAF_LIGHT} />
        </g>
      )}

      {/* 阶段 2：幼苗 */}
      {stage === 2 && (
        <g className="kt-sway">
          <path d="M100 170 q-2 -26 0 -40" stroke={TRUNK} strokeWidth="4" fill="none" strokeLinecap="round" />
          <path d="M100 150 q-14 -6 -20 0 q8 9 20 3 z" fill={LEAF} />
          <path d="M100 142 q14 -8 20 -1 q-8 9 -20 4 z" fill={LEAF_LIGHT} />
          <path d="M100 130 q-10 -10 -6 -16 q9 2 9 14 z" fill={LEAF} />
          <circle cx="100" cy="122" r="9" fill={LEAF_LIGHT} />
        </g>
      )}

      {/* 阶段 3：小树 */}
      {stage === 3 && (
        <g className="kt-sway">
          <path d="M100 170 q-2 -30 0 -48" stroke={TRUNK} strokeWidth="6" fill="none" strokeLinecap="round" />
          <path d="M100 140 q-12 -6 -20 -14" stroke={TRUNK} strokeWidth="3.5" fill="none" strokeLinecap="round" />
          <path d="M100 132 q12 -8 20 -16" stroke={TRUNK} strokeWidth="3.5" fill="none" strokeLinecap="round" />
          <circle cx="78" cy="118" r="15" fill={LEAF} />
          <circle cx="122" cy="108" r="16" fill={LEAF_LIGHT} />
          <circle cx="100" cy="102" r="18" fill={LEAF} />
          {fruits.slice(0, 2).map((f, i) => (
            <circle key={f.kpId} className="kt-fruit" style={{ animationDelay: `${i * 0.22}s` }} cx={fruitPos[i][0] + 10} cy={fruitPos[i][1] + 46} r="4.5" fill={FRUIT} stroke="#CE9C45" strokeWidth="1">
              <title>已掌握：{f.name}</title>
            </circle>
          ))}
        </g>
      )}

      {/* 阶段 4：大树 + 果实 */}
      {stage >= 4 && (
        <g className="kt-sway">
          <path d="M100 170 q-3 -34 0 -60" stroke={TRUNK} strokeWidth="8" fill="none" strokeLinecap="round" />
          <path d="M100 136 q-16 -8 -26 -20" stroke={TRUNK} strokeWidth="4.5" fill="none" strokeLinecap="round" />
          <path d="M100 126 q16 -10 26 -22" stroke={TRUNK} strokeWidth="4.5" fill="none" strokeLinecap="round" />
          <circle cx="70" cy="92" r="22" fill={LEAF} />
          <circle cx="130" cy="86" r="23" fill={LEAF_LIGHT} />
          <circle cx="100" cy="66" r="26" fill={LEAF} />
          <circle cx="86" cy="100" r="18" fill={LEAF_LIGHT} />
          <circle cx="116" cy="102" r="17" fill={LEAF} />
          {fruits.slice(0, 6).map((f, i) => (
            <g key={f.kpId}>
              <circle className="kt-fruit" style={{ animationDelay: `${i * 0.18}s` }} cx={fruitPos[i][0]} cy={fruitPos[i][1]} r="5.5" fill={FRUIT} stroke="#CE9C45" strokeWidth="1.2">
                <title>已掌握：{f.name}</title>
              </circle>
              <path d={`M${fruitPos[i][0]} ${fruitPos[i][1] - 5} q2 -3 4 -4`} stroke={TRUNK} strokeWidth="1" fill="none" />
            </g>
          ))}
        </g>
      )}

      {/* 阶段名 */}
      <text x="100" y="192" textAnchor="middle" fontSize="10" fill="#66725E" fontFamily="'IBM Plex Mono', monospace">
        {TREE_STAGES[Math.min(stage, TREE_STAGES.length - 1)].name}
      </text>
    </svg>
  );
}
