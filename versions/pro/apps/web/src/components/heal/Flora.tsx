/**
 * Flora — 治愈系植物插画（「清透」画法，对齐 前端组件/tip1-3 参考）
 * 手法要点（照参考图）：
 *  - 半透明渐变填充，而非扁平纯色
 *  - 叶片带内发光高光 + 柔和边缘（feGaussianBlur 光晕层）
 *  - 多层叠加制造体积与通透感
 * 全部 pointer-events:none，仅装饰不承载信息。
 *
 * 注意：这些插画内部带 SVG 高斯模糊光晕（feGaussianBlur）。之前给它们加了 lf-sway 摇摆动画，
 * 等于每帧重新栅格化一次模糊滤镜，远程桌面/无 GPU 加速的 Edge 上会持续闪烁，故改为静态。
 */

/** 共享渐变/滤镜定义（每个 svg 内联一份，id 带前缀避免冲突） */
function FloraDefs({ id }: { id: string }) {
  return (
    <defs>
      {/* 清透叶片渐变：顶部亮、底部沉，半透明 */}
      <linearGradient id={`${id}-leaf`} x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0%" stopColor="#E3F4EA" stopOpacity="0.95" />
        <stop offset="45%" stopColor="#A8D4BA" stopOpacity="0.85" />
        <stop offset="100%" stopColor="#6FA98A" stopOpacity="0.72" />
      </linearGradient>
      <linearGradient id={`${id}-leaf2`} x1="0.2" y1="0" x2="0.8" y2="1">
        <stop offset="0%" stopColor="#F0FAF3" stopOpacity="0.92" />
        <stop offset="50%" stopColor="#BADEC8" stopOpacity="0.8" />
        <stop offset="100%" stopColor="#84BC9C" stopOpacity="0.68" />
      </linearGradient>
      {/* 花瓣：柔粉清透 */}
      <radialGradient id={`${id}-petal`} cx="0.38" cy="0.32" r="0.8">
        <stop offset="0%" stopColor="#FFF6F8" stopOpacity="0.98" />
        <stop offset="55%" stopColor="#F2CBD6" stopOpacity="0.88" />
        <stop offset="100%" stopColor="#E0A8BB" stopOpacity="0.7" />
      </radialGradient>
      {/* 金蕊 / 果实 */}
      <radialGradient id={`${id}-gold`} cx="0.38" cy="0.32" r="0.85">
        <stop offset="0%" stopColor="#FFF3D0" />
        <stop offset="60%" stopColor="#EFC169" />
        <stop offset="100%" stopColor="#D9A247" stopOpacity="0.9" />
      </radialGradient>
      <radialGradient id={`${id}-berry`} cx="0.36" cy="0.3" r="0.85">
        <stop offset="0%" stopColor="#FBE0D2" />
        <stop offset="55%" stopColor="#DFA184" />
        <stop offset="100%" stopColor="#C07B5E" stopOpacity="0.92" />
      </radialGradient>
      {/* 暖陶盆：清透陶土 */}
      <linearGradient id={`${id}-pot`} x1="0.1" y1="0" x2="0.9" y2="1">
        <stop offset="0%" stopColor="#F0CDB6" stopOpacity="0.95" />
        <stop offset="55%" stopColor="#D79B7C" stopOpacity="0.9" />
        <stop offset="100%" stopColor="#B06E51" stopOpacity="0.88" />
      </linearGradient>
      {/* 茎 */}
      <linearGradient id={`${id}-stem`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stopColor="#9CC9AE" stopOpacity="0.5" />
        <stop offset="50%" stopColor="#7FB295" stopOpacity="0.9" />
        <stop offset="100%" stopColor="#5E9377" stopOpacity="0.6" />
      </linearGradient>
      {/* 柔光晕（参考图的发光边缘） */}
      <filter id={`${id}-glow`} x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3.2" result="b" />
        <feComponentTransfer in="b" result="s">
          <feFuncA type="linear" slope="0.55" />
        </feComponentTransfer>
        <feMerge>
          <feMergeNode in="s" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

/** 清透叶片（带高光的单叶） */
function Leaf({
  cx, cy, rx, ry, rot, id, alt = false,
}: { cx: number; cy: number; rx: number; ry: number; rot: number; id: string; alt?: boolean }) {
  return (
    <g transform={`rotate(${rot} ${cx} ${cy})`}>
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={`url(#${id}-${alt ? 'leaf2' : 'leaf'})`} />
      {/* 中脉 */}
      <path
        d={`M ${cx - rx * 0.82} ${cy} Q ${cx} ${cy - ry * 0.32} ${cx + rx * 0.82} ${cy}`}
        stroke="#FFFFFF" strokeOpacity="0.5" strokeWidth={Math.max(0.6, ry * 0.13)} fill="none" strokeLinecap="round"
      />
      {/* 高光 */}
      <ellipse cx={cx - rx * 0.28} cy={cy - ry * 0.34} rx={rx * 0.34} ry={ry * 0.28} fill="#FFFFFF" opacity="0.4" />
    </g>
  );
}

export function SprigTop({ className = '' }: { className?: string }) {
  const id = 'sprig';
  return (
    <svg viewBox="0 0 132 78" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden className={`pointer-events-none ${className}`}>
      <FloraDefs id={id} />
      <g filter={`url(#${id}-glow)`}>
        <path d="M66 78 C64 54 60 34 68 10" stroke={`url(#${id}-stem)`} strokeWidth="2.4" strokeLinecap="round" />
        <path d="M66 60 C52 54 44 46 40 40" stroke={`url(#${id}-stem)`} strokeWidth="1.8" strokeLinecap="round" />
        <path d="M66 44 C80 40 90 34 96 30" stroke={`url(#${id}-stem)`} strokeWidth="1.8" strokeLinecap="round" />
        <Leaf cx={34} cy={38} rx={16} ry={8} rot={-30} id={id} />
        <Leaf cx={98} cy={28} rx={16} ry={8} rot={28} id={id} alt />
        <Leaf cx={50} cy={20} rx={12} ry={6} rot={-22} id={id} alt />
        <Leaf cx={82} cy={16} rx={12} ry={6} rot={24} id={id} />
        <circle cx="56" cy="34" r="3.6" fill={`url(#${id}-berry)`} />
        <circle cx="62" cy="40" r="3.1" fill={`url(#${id}-berry)`} />
        <g transform="translate(68 9)">
          <g fill={`url(#${id}-petal)`}>
            {[0, 72, 144, 216, 288].map((a) => (
              <ellipse key={a} rx="5" ry="2.7" transform={`rotate(${a}) translate(7 0)`} />
            ))}
          </g>
          <circle r="3.4" fill={`url(#${id}-gold)`} />
        </g>
      </g>
    </svg>
  );
}

export function PottedPlant({ className = '' }: { className?: string }) {
  const id = 'pot1';
  return (
    <svg viewBox="0 0 56 66" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden className={`pointer-events-none ${className}`}>
      <FloraDefs id={id} />
      <g filter={`url(#${id}-glow)`}>
        <path d="M28 42 C28 30 26 20 22 12" stroke={`url(#${id}-stem)`} strokeWidth="2" strokeLinecap="round" />
        <path d="M28 36 C35 28 41 24 45 22" stroke={`url(#${id}-stem)`} strokeWidth="1.7" strokeLinecap="round" />
        <Leaf cx={17} cy={15} rx={9.5} ry={4.8} rot={-34} id={id} />
        <Leaf cx={45} cy={22} rx={9.5} ry={4.8} rot={30} id={id} alt />
        <Leaf cx={30} cy={9} rx={7.5} ry={3.8} rot={-6} id={id} alt />
        <circle cx="34" cy="16" r="2.8" fill={`url(#${id}-gold)`} />
        {/* 清透陶盆 */}
        <path d="M15 42 H41 L37 63 H19 Z" fill={`url(#${id}-pot)`} />
        <path d="M18 45 L20 60" stroke="#FFFFFF" strokeOpacity="0.35" strokeWidth="2.4" strokeLinecap="round" />
        <rect x="12.5" y="39" width="31" height="7" rx="3" fill={`url(#${id}-pot)`} />
        <rect x="14" y="40.4" width="16" height="1.8" rx="0.9" fill="#FFFFFF" opacity="0.4" />
      </g>
    </svg>
  );
}

export function Sprout({ className = '' }: { className?: string }) {
  const id = 'spr';
  return (
    <svg viewBox="0 0 58 58" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden className={`pointer-events-none ${className}`}>
      <FloraDefs id={id} />
      <g filter={`url(#${id}-glow)`}>
        <path d="M29 54 L29 28" stroke={`url(#${id}-stem)`} strokeWidth="2.6" strokeLinecap="round" />
        <path d="M29 40 C18 38 12 30 11 22 C22 22 29 30 29 40Z" fill={`url(#${id}-leaf)`} />
        <path d="M29 34 C40 32 46 24 47 16 C36 16 29 24 29 34Z" fill={`url(#${id}-leaf2)`} />
        <path d="M16 24 Q22 28 27 36" stroke="#FFFFFF" strokeOpacity="0.45" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        <path d="M42 19 Q35 23 31 31" stroke="#FFFFFF" strokeOpacity="0.45" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        <ellipse cx="29" cy="55" rx="13" ry="2.6" fill="#7FB295" opacity="0.2" />
        <circle cx="29" cy="13" r="3.4" fill={`url(#${id}-gold)`} />
      </g>
    </svg>
  );
}

export function LeafSmall({ className = '' }: { className?: string }) {
  const id = 'lsm';
  return (
    <svg viewBox="0 0 42 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden className={`pointer-events-none ${className}`}>
      <FloraDefs id={id} />
      <g filter={`url(#${id}-glow)`}>
        <path d="M8 26 C10 16 16 10 24 6" stroke={`url(#${id}-stem)`} strokeWidth="1.7" strokeLinecap="round" />
        <Leaf cx={14} cy={17} rx={10} ry={5} rot={-26} id={id} />
        <Leaf cx={28} cy={12} rx={10} ry={5} rot={22} id={id} alt />
      </g>
    </svg>
  );
}

export function LeafDivider({ className = '' }: { className?: string }) {
  const id = 'ldv';
  return (
    <div aria-hidden className={`pointer-events-none flex items-center gap-2.5 ${className}`}>
      <span className="h-px flex-1 bg-gradient-to-r from-transparent via-[#7FB295]/45 to-transparent" />
      <svg width="24" height="16" viewBox="0 0 24 16" fill="none">
        <FloraDefs id={id} />
        <g filter={`url(#${id}-glow)`}>
          <Leaf cx={8} cy={9} rx={6.5} ry={3.2} rot={-24} id={id} />
          <Leaf cx={16} cy={7} rx={6.5} ry={3.2} rot={22} id={id} alt />
        </g>
      </svg>
      <span className="h-px flex-1 bg-gradient-to-r from-transparent via-[#7FB295]/45 to-transparent" />
    </div>
  );
}

/** 蕨类：羽状清透小蕨 */
export function Fern({ className = '' }: { className?: string }) {
  const id = 'fern';
  return (
    <svg viewBox="0 0 60 84" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden className={`pointer-events-none ${className}`}>
      <FloraDefs id={id} />
      <g filter={`url(#${id}-glow)`}>
        <path d="M30 84 C28 60 26 34 34 8" stroke={`url(#${id}-stem)`} strokeWidth="2.2" strokeLinecap="round" />
        {[[30, 66, -38], [34, 52, -34], [37, 38, -30], [39, 26, -26]].map(([x, y, r], i) => (
          <Leaf key={`l${i}`} cx={x - 12} cy={y} rx={11 - i} ry={4.6 - i * 0.4} rot={r} id={id} alt={i % 2 === 1} />
        ))}
        {[[32, 62, 36], [36, 48, 32], [39, 34, 28], [41, 22, 24]].map(([x, y, r], i) => (
          <Leaf key={`r${i}`} cx={x + 12} cy={y} rx={11 - i} ry={4.6 - i * 0.4} rot={r} id={id} alt={i % 2 === 0} />
        ))}
        <circle cx="35" cy="7" r="2.8" fill={`url(#${id}-leaf2)`} />
      </g>
    </svg>
  );
}

/** 垂藤：心形叶藤蔓（清透） */
export function Vine({ className = '' }: { className?: string }) {
  const id = 'vine';
  const hearts: [number, number, number, boolean][] = [
    [24, 16, -14, false], [25, 32, 16, true], [23, 50, -12, false], [25, 68, 14, true], [23, 86, -10, false],
  ];
  return (
    <svg viewBox="0 0 48 96" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden className={`pointer-events-none ${className}`} style={{ transformOrigin: '50% 0%' }}>
      <FloraDefs id={id} />
      <g filter={`url(#${id}-glow)`}>
        <path d="M24 0 C20 22 30 34 24 52 C19 68 28 80 24 94" stroke={`url(#${id}-stem)`} strokeWidth="2" strokeLinecap="round" />
        {hearts.map(([x, y, rot, alt], i) => (
          <g key={i} transform={`rotate(${rot} ${x} ${y})`}>
            <path
              d={`M ${x} ${y + 6} C ${x - 11} ${y - 1} ${x - 7} ${y - 9} ${x} ${y - 3} C ${x + 7} ${y - 9} ${x + 11} ${y - 1} ${x} ${y + 6} Z`}
              fill={`url(#${id}-${alt ? 'leaf2' : 'leaf'})`}
            />
            <ellipse cx={x - 2.6} cy={y - 1.5} rx="2.6" ry="1.7" fill="#FFFFFF" opacity="0.42" />
          </g>
        ))}
        <circle cx="30" cy="42" r="2.7" fill={`url(#${id}-berry)`} />
      </g>
    </svg>
  );
}

/** 花枝：清透花瓣 + 金蕊 */
export function BlossomBranch({ className = '' }: { className?: string }) {
  const id = 'blos';
  return (
    <svg viewBox="0 0 110 72" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden className={`pointer-events-none ${className}`}>
      <FloraDefs id={id} />
      <g filter={`url(#${id}-glow)`}>
        <path d="M4 68 C34 56 60 42 102 12" stroke="#C89478" strokeOpacity="0.75" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M46 46 C54 40 58 34 60 26" stroke="#C89478" strokeOpacity="0.65" strokeWidth="1.9" strokeLinecap="round" />
        {([[62, 22, 1], [88, 16, 0.85], [34, 52, 0.8]] as const).map(([x, y, s], i) => (
          <g key={i} transform={`translate(${x} ${y}) scale(${s})`}>
            <g fill={`url(#${id}-petal)`}>
              {[[0, -6.8], [6.4, -2.1], [4, 5.6], [-4, 5.6], [-6.4, -2.1]].map(([cx, cy], j) => (
                <circle key={j} cx={cx} cy={cy} r="4.8" />
              ))}
            </g>
            <circle cx="-1.6" cy="-7.4" r="1.7" fill="#FFFFFF" opacity="0.55" />
            <circle r="3.2" fill={`url(#${id}-gold)`} />
          </g>
        ))}
        <circle cx="74" cy="30" r="2.8" fill={`url(#${id}-petal)`} />
        <Leaf cx={52} cy={38} rx={7.5} ry={3.6} rot={-24} id={id} />
      </g>
    </svg>
  );
}

/** 草丛：清透草叶 + 小野花 */
export function GrassTuft({ className = '' }: { className?: string }) {
  const id = 'grass';
  return (
    <svg viewBox="0 0 56 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden className={`pointer-events-none ${className}`}>
      <FloraDefs id={id} />
      <g filter={`url(#${id}-glow)`}>
        <path d="M12 40 C12 28 8 20 4 14" stroke={`url(#${id}-stem)`} strokeWidth="2.6" strokeLinecap="round" />
        <path d="M20 40 C20 24 22 16 26 8" stroke={`url(#${id}-stem)`} strokeWidth="2.6" strokeLinecap="round" />
        <path d="M30 40 C32 30 36 24 42 20" stroke={`url(#${id}-stem)`} strokeWidth="2.3" strokeLinecap="round" />
        <path d="M40 40 C42 32 46 28 52 26" stroke={`url(#${id}-stem)`} strokeWidth="2.1" strokeLinecap="round" />
        <g transform="translate(27 6)">
          <g fill={`url(#${id}-petal)`}>
            {[[0, -3.8], [3.6, -1.2], [2.2, 3.1], [-2.2, 3.1], [-3.6, -1.2]].map(([cx, cy], j) => (
              <circle key={j} cx={cx} cy={cy} r="2.6" />
            ))}
          </g>
          <circle r="1.9" fill={`url(#${id}-gold)`} />
        </g>
      </g>
    </svg>
  );
}

/** 多肉：清透莲座 + 暖陶盆 */
export function Succulent({ className = '' }: { className?: string }) {
  const id = 'succ';
  return (
    <svg viewBox="0 0 44 52" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden className={`pointer-events-none ${className}`}>
      <FloraDefs id={id} />
      <g filter={`url(#${id}-glow)`}>
        {[0, 45, 90, 135, 180, 225, 270, 315].map((r, i) => (
          <ellipse key={`o${i}`} cx="22" cy="20" rx="4.8" ry="11" transform={`rotate(${r} 22 20)`} fill={`url(#${id}-${i % 2 ? 'leaf' : 'leaf2'})`} />
        ))}
        {[22, 112, 202, 292].map((r, i) => (
          <ellipse key={`n${i}`} cx="22" cy="20" rx="3.5" ry="7.6" transform={`rotate(${r} 22 20)`} fill={`url(#${id}-leaf2)`} />
        ))}
        <circle cx="22" cy="20" r="3.4" fill="#EAF7EF" opacity="0.9" />
        <circle cx="22" cy="20" r="1.7" fill={`url(#${id}-gold)`} />
        <path d="M10 34 H34 L31 50 H13 Z" fill={`url(#${id}-pot)`} />
        <path d="M13.5 37 L15 47" stroke="#FFFFFF" strokeOpacity="0.35" strokeWidth="2.2" strokeLinecap="round" />
        <rect x="8" y="31.5" width="28" height="5.8" rx="2.4" fill={`url(#${id}-pot)`} />
        <rect x="9.5" y="32.7" width="14" height="1.6" rx="0.8" fill="#FFFFFF" opacity="0.42" />
      </g>
    </svg>
  );
}

/** 全局漂浮微光（固定定位，学习者视角挂载一次） */
const SPARKS = Array.from({ length: 12 }, (_, i) => ({
  size: 3 + ((i * 37) % 6),
  left: (i * 8.3 + 4) % 100,
  top: 55 + ((i * 13) % 40),
  dur: 7 + ((i * 29) % 70) / 10,
  delay: -((i * 17) % 90) / 10,
}));

export function SparkField() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      {SPARKS.map((s, i) => (
        <span
          key={i}
          className="lf-spark"
          style={{
            width: s.size,
            height: s.size,
            left: `${s.left}vw`,
            top: `${s.top}vh`,
            animationDuration: `${s.dur}s`,
            animationDelay: `${s.delay}s`,
          }}
        />
      ))}
    </div>
  );
}
