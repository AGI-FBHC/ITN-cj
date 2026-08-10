/**
 * SpeciesPlant — 知识花园的六个品种（一域一种，确定性映射见 data/garden.ts）
 * 单位空间：地面 y=0，向上生长至约 -46；stage 0 种子 / 1 破土 / 2 长叶 / 3 花蕾 / 4 开花 / 5 结果。
 * 图谱节点与「我的成长」温室共用同一套绘制，保证"图上那株"和"温室里那株"是同一株。
 */
import type { Species } from '@/data/garden';

/** 花园共享渐变/滤镜（一个文档里渲染一次即可） */
export function GardenDefs() {
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

const SOIL = <ellipse cx="0" cy="0" rx="14" ry="3.4" fill="url(#g-soil)" />;

/** 茎：随阶段长高 */
function stem(top: number, w = 2.6, color = 'url(#g-stem)') {
  return <path d={`M 0 -1 C -1.5 ${top * 0.4} 1.5 ${top * 0.7} 0 ${top}`} stroke={color} strokeWidth={w} strokeLinecap="round" fill="none" />;
}

function leaf(cx: number, cy: number, rx: number, ry: number, rot: number, alt = false) {
  return (
    <g transform={`rotate(${rot} ${cx} ${cy})`}>
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={`url(#g-leaf${alt ? '2' : ''})`} />
      <ellipse cx={cx - rx * 0.28} cy={cy - ry * 0.34} rx={rx * 0.32} ry={ry * 0.26} fill="#FFFFFF" opacity="0.38" />
    </g>
  );
}

/** 种子期：各品种的幼苗轮廓不同——没学过也能认出"这里将来长什么" */
function seedOf(species: Species) {
  const hint = (d: string) => <path d={d} stroke="#9BB9A6" strokeWidth="1.4" fill="none" strokeLinecap="round" opacity="0.55" />;
  return (
    <g>
      {species === 'pine' && hint('M 0 -3 L -4 -11 M 0 -3 L 4 -11 M 0 -3 L 0 -13')}
      {species === 'bamboo' && hint('M -2 -3 L -2 -13 M 2.5 -3 L 2.5 -10')}
      {species === 'iris' && hint('M -2 -3 L -4 -13 M 2 -3 L 4 -13')}
      {species === 'sunflower' && hint('M 0 -3 L 0 -12 M -3.5 -12 A 3.5 3.5 0 0 1 3.5 -12')}
      {species === 'morningGlory' && hint('M 0 -3 C 5 -7 -5 -10 0 -13')}
      {species === 'mint' && hint('M 0 -3 L 0 -12 M -4 -8 L 4 -8')}
      {SOIL}
      <ellipse cx="0" cy="-3.5" rx="4.6" ry="3.6" fill="#C09A78" opacity="0.92" />
      <ellipse cx="-1.2" cy="-4.8" rx="1.7" ry="1.2" fill="#FFFFFF" opacity="0.45" />
    </g>
  );
}

export default function SpeciesPlant({ species, stage }: { species: Species; stage: number }) {
  if (stage === 0) return seedOf(species);

  /* ---------- 向日葵：直茎 + 大圆叶 + 金色花盘 ---------- */
  if (species === 'sunflower') {
    const top = [0, -20, -32, -40, -45, -45][stage];
    return (
      <g>
        {SOIL}
        {stem(top, 3)}
        {stage >= 1 && leaf(-9, -14, 8.5, 5.5, -18)}
        {stage >= 2 && leaf(9.5, -22, 9, 5.8, 16, true)}
        {stage >= 3 && leaf(-10, -30, 8, 5, -14, true)}
        {stage === 3 && <circle cx="0" cy={top - 4} r="5" fill="#B8C9A8" />}
        {stage >= 4 && (
          <g transform={`translate(0 ${top - 6})`}>
            <g fill="url(#g-gold)">
              {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
                <ellipse key={a} rx="5.6" ry="2.4" transform={`rotate(${a}) translate(7.4 0)`} />
              ))}
            </g>
            <circle r="4.2" fill="#7A5B33" />
            <circle r="2.2" fill="#9A7442" opacity="0.7" />
          </g>
        )}
        {stage === 5 && (
          <g>
            <circle cx="-8" cy="-24" r="2.6" fill="url(#g-gold)" />
            <circle cx="8" cy="-16" r="2.2" fill="url(#g-gold)" />
          </g>
        )}
      </g>
    );
  }

  /* ---------- 鸢尾：剑形直立叶 + 三瓣紫花 ---------- */
  if (species === 'iris') {
    const h = [0, 20, 30, 38, 42, 42][stage];
    const blade = (x: number, tilt: number, len: number) => (
      <path
        d={`M ${x} 0 Q ${x + tilt * 0.5} ${-len * 0.6} ${x + tilt} ${-len}`}
        stroke="#7FB295"
        strokeWidth="3.4"
        strokeLinecap="round"
        fill="none"
      />
    );
    return (
      <g>
        {SOIL}
        {blade(-3.5, -5, h)}
        {blade(3.5, 5, h * 0.9)}
        {stage >= 2 && blade(0, 0, h * 1.05)}
        {stage >= 3 && stem(-h * 0.9, 2)}
        {stage === 3 && <ellipse cx="0" cy={-h * 0.95} rx="3" ry="5" fill="#A797C4" />}
        {stage >= 4 && (
          <g transform={`translate(0 ${-h - 3})`}>
            {/* 三片下垂瓣 + 三片立瓣 */}
            <path d="M 0 0 C -7 3 -8 9 -4 10 C -1 10.5 -0.5 5 0 0" fill="#9C8AB8" />
            <path d="M 0 0 C 7 3 8 9 4 10 C 1 10.5 0.5 5 0 0" fill="#9C8AB8" />
            <path d="M 0 1 C -2 7 2 7 0 12" fill="#8878A8" />
            <ellipse cx="-3.4" cy="-3.4" rx="3.4" ry="4.6" transform="rotate(-28 -3.4 -3.4)" fill="#B7A8CE" />
            <ellipse cx="3.4" cy="-3.4" rx="3.4" ry="4.6" transform="rotate(28 3.4 -3.4)" fill="#B7A8CE" />
            <circle r="1.8" fill="url(#g-gold)" />
          </g>
        )}
        {stage === 5 && <circle cx="7" cy="-14" r="2.6" fill="url(#g-gold)" />}
      </g>
    );
  }

  /* ---------- 松：三层针叶塔 + 松果（常青，不开"花"） ---------- */
  if (species === 'pine') {
    const tiers = stage >= 4 ? 3 : stage >= 2 ? 2 : 1;
    const trunkTop = [0, -14, -26, -34, -40, -40][stage];
    return (
      <g>
        {SOIL}
        <path d={`M 0 -1 L 0 ${trunkTop}`} stroke="#8A6F52" strokeWidth="3" strokeLinecap="round" />
        {Array.from({ length: tiers }).map((_, i) => {
          const y = trunkTop + i * (Math.abs(trunkTop) / (tiers + 0.6));
          const w = 8 + i * 4.5;
          return (
            <path
              key={i}
              d={`M 0 ${y - 6} L ${-w} ${y + 5} Q 0 ${y + 1.5} ${w} ${y + 5} Z`}
              fill={i % 2 === 0 ? 'url(#g-leaf)' : 'url(#g-leaf2)'}
              stroke="#4E7860"
              strokeWidth="0.6"
              strokeOpacity="0.35"
            />
          );
        })}
        {stage >= 4 && <ellipse cx="8" cy={trunkTop + 14} rx="2.8" ry="4.2" fill="#9A7442" />}
        {stage === 5 && <ellipse cx="-8" cy={trunkTop + 20} rx="2.8" ry="4.2" fill="url(#g-gold)" />}
      </g>
    );
  }

  /* ---------- 牵牛花：沿支架缠绕的藤 + 喇叭花 ---------- */
  if (species === 'morningGlory') {
    const top = [0, -18, -30, -38, -44, -44][stage];
    return (
      <g>
        {SOIL}
        {/* 支架（梯形图的架子） */}
        <path d={`M 0 -2 L 0 ${top - 2}`} stroke="#C4B49A" strokeWidth="1.6" strokeLinecap="round" />
        <path d={`M -5 ${top * 0.45} L 5 ${top * 0.45}`} stroke="#C4B49A" strokeWidth="1.2" />
        <path d={`M -5 ${top * 0.8} L 5 ${top * 0.8}`} stroke="#C4B49A" strokeWidth="1.2" />
        {/* 缠绕的藤 */}
        <path
          d={`M 0 -2 C 7 ${top * 0.22} -7 ${top * 0.42} 0 ${top * 0.55} C 7 ${top * 0.7} -6 ${top * 0.86} 0 ${top}`}
          stroke="#6FA98A"
          strokeWidth="2.2"
          fill="none"
          strokeLinecap="round"
        />
        {stage >= 1 && leaf(-8, top * 0.35, 6.5, 4.6, -30)}
        {stage >= 2 && leaf(8, top * 0.62, 7, 4.8, 28, true)}
        {stage >= 3 && leaf(-8.5, top * 0.85, 6, 4.2, -24, true)}
        {stage === 3 && <ellipse cx="4" cy={top - 1} rx="2.6" ry="4.4" transform={`rotate(24 4 ${top - 1})`} fill="#A9BEDB" />}
        {stage >= 4 && (
          <g transform={`translate(2 ${top - 4})`}>
            <path d="M 0 6 L -6.5 -2.5 A 6.5 6.5 0 0 1 6.5 -2.5 Z" fill="#8FA8C9" />
            <ellipse cx="0" cy="-2.5" rx="6.5" ry="2.2" fill="#A9BEDB" />
            <circle cx="0" cy="-2" r="1.6" fill="#FFF6F0" opacity="0.9" />
          </g>
        )}
        {stage === 5 && <circle cx="-7" cy={top * 0.5} r="2.6" fill="url(#g-gold)" />}
      </g>
    );
  }

  /* ---------- 竹：分节竹竿 + 细长叶 ---------- */
  if (species === 'bamboo') {
    const h = [0, 20, 32, 40, 46, 46][stage];
    const culm = (x: number, height: number, w: number) => (
      <g>
        <path d={`M ${x} 0 L ${x} ${-height}`} stroke="#7FB295" strokeWidth={w} strokeLinecap="round" />
        {[0.3, 0.58, 0.82].map((p) =>
          height * p > 6 ? (
            <line key={p} x1={x - w / 2} y1={-height * p} x2={x + w / 2} y2={-height * p} stroke="#4E7860" strokeWidth="1" opacity="0.55" />
          ) : null,
        )}
      </g>
    );
    const blade = (x: number, y: number, rot: number) => (
      <path d={`M ${x} ${y} Q ${x + 9} ${y - 4} ${x + 16} ${y - 1}`} transform={`rotate(${rot} ${x} ${y})`} stroke="#84BC9C" strokeWidth="2.6" strokeLinecap="round" fill="none" />
    );
    return (
      <g>
        {SOIL}
        {culm(-3.5, h, 3.4)}
        {stage >= 2 && culm(4, h * 0.78, 2.8)}
        {stage >= 4 && culm(9, h * 0.5, 2.2)}
        {stage >= 1 && blade(-3.5, -h + 2, -18)}
        {stage >= 2 && blade(-3.5, -h + 8, 14)}
        {stage >= 3 && blade(4, -h * 0.78 + 2, 22)}
        {stage >= 4 && blade(-3.5, -h + 14, -8)}
        {stage === 5 && <circle cx="10" cy={-h * 0.55} r="2.8" fill="url(#g-gold)" />}
      </g>
    );
  }

  /* ---------- 薄荷：对生锯齿叶 + 顶端花穗 ---------- */
  const top = [0, -16, -26, -34, -40, -40][stage];
  const pair = (y: number, size: number) => (
    <g>
      <path d={`M 0 ${y} C -4 ${y - 4} -9 ${y - 3} -10 ${y + 1} C -8 ${y + 4} -3 ${y + 3} 0 ${y}`} fill="url(#g-leaf)" transform={`scale(${size} ${size})`} />
      <path d={`M 0 ${y} C 4 ${y - 4} 9 ${y - 3} 10 ${y + 1} C 8 ${y + 4} 3 ${y + 3} 0 ${y}`} fill="url(#g-leaf2)" transform={`scale(${size} ${size})`} />
    </g>
  );
  return (
    <g>
      {SOIL}
      {stem(top, 2.2)}
      {stage >= 1 && pair(top * 0.35, 1)}
      {stage >= 2 && pair(top * 0.62, 0.92)}
      {stage >= 3 && pair(top * 0.85, 0.8)}
      {stage >= 4 && (
        <g transform={`translate(0 ${top - 3})`}>
          {[0, 3.4, 6.8].map((dy, i) => (
            <ellipse key={dy} cx={i % 2 ? 1.6 : -1.6} cy={-dy} rx="2.6" ry="1.9" fill="#C9BBD8" />
          ))}
        </g>
      )}
      {stage === 5 && <circle cx="8" cy={top * 0.5} r="2.6" fill="url(#g-gold)" />}
    </g>
  );
}

/** 盆栽形态（温室陈列用）：自带 viewBox 与土盆 */
export function PottedSpecies({
  species,
  stage,
  className = '',
}: {
  species: Species;
  stage: number;
  className?: string;
}) {
  return (
    <svg viewBox="-32 -62 64 76" className={className} aria-hidden>
      <GardenDefs />
      {/* 盆 */}
      <path d="M -13 2 L 13 2 L 10 13 L -10 13 Z" fill="#C9A588" opacity="0.85" />
      <rect x="-14.5" y="-0.6" width="29" height="3.6" rx="1.6" fill="#B9906F" opacity="0.9" />
      <g filter={stage >= 4 ? 'url(#g-glow)' : undefined}>
        <SpeciesPlant species={species} stage={stage} />
      </g>
    </svg>
  );
}
