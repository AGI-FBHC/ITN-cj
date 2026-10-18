/**
 * FrameDemo — 坐标变换交互演示（课件 demo block）
 * 拖滑块平移/旋转工具坐标系，SVG 实时重绘，右侧齐次变换矩阵同步变化。
 */
import { useEffect, useState } from 'react';
import TraceBadge from '@/components/TraceBadge';

export default function FrameDemo({ tourStage = null }: { tourStage?: number | null }) {
  const [tx, setTx] = useState(60);
  const [ty, setTy] = useState(-40);
  const [deg, setDeg] = useState(30);

  /* 导览：语音讲到哪个自由度，哪个滑块自己动（0=X 平移 1=Y 平移 2=旋转） */
  useEffect(() => {
    if (tourStage === null) return;
    if (tourStage === 0) { setTx(100); setTy(-40); setDeg(0); }
    else if (tourStage === 1) { setTy(-75); }
    else if (tourStage === 2) { setDeg(55); }
  }, [tourStage]);

  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const fmt = (n: number) => (n >= 0 ? ' ' : '') + n.toFixed(2);

  /* SVG 坐标：原点(60,140)，y 向上为负 */
  const ox = 60, oy = 140;
  const px = ox + tx, py = oy + ty;
  const axis = 34;

  return (
    <div className="rounded-[12px] border border-brand/25 bg-paper p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10.5px] tracking-wide text-ink-muted">
          INTERACTIVE · 拖动滑块，看矩阵怎么变
        </span>
        <TraceBadge kbId="KB-002" />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* 画布 */}
        <svg viewBox="0 0 240 170" className="w-full rounded-[8px] border border-hairline bg-card-warm">
          {/* 基座标系 */}
          <line x1={ox} y1={oy} x2={ox + axis} y2={oy} stroke="#5A6553" strokeWidth="2" />
          <line x1={ox} y1={oy} x2={ox} y2={oy - axis} stroke="#5A6553" strokeWidth="2" />
          <text x={ox + axis + 3} y={oy + 4} fontSize="9" fill="#5A6553" fontFamily="monospace">X₀</text>
          <text x={ox - 4} y={oy - axis - 4} fontSize="9" fill="#5A6553" fontFamily="monospace">Y₀</text>
          <text x={ox - 14} y={oy + 12} fontSize="8" fill="#66725E" fontFamily="monospace">基座标</text>
          {/* 连线 */}
          <line x1={ox} y1={oy} x2={px} y2={py} stroke="#E7B45A" strokeWidth="1.2" strokeDasharray="4 3" />
          {/* 工具坐标系（旋转后） */}
          <line x1={px} y1={py} x2={px + axis * c} y2={py - axis * s} stroke="#4E7860" strokeWidth="2.4" />
          <line x1={px} y1={py} x2={px - axis * s} y2={py - axis * c} stroke="#B77552" strokeWidth="2.4" />
          <circle cx={px} cy={py} r="3.5" fill="#4E7860" />
          <text x={px + axis * c + 3} y={py - axis * s + 3} fontSize="9" fill="#4E7860" fontFamily="monospace">Xt</text>
          <text x={px - axis * s - 12} y={py - axis * c - 3} fontSize="9" fill="#B77552" fontFamily="monospace">Yt</text>
          <text x={px + 6} y={py + 12} fontSize="8" fill="#66725E" fontFamily="monospace">TCP</text>
        </svg>

        {/* 矩阵 + 滑块 */}
        <div className="space-y-3">
          <div className="rounded-[8px] border border-hairline bg-card-warm p-3 font-mono text-[11.5px] leading-[19px] text-ink-2">
            <div className="mb-1 text-[10px] text-ink-muted">T = [ R | t ]（齐次变换）</div>
            <div>⎡ {fmt(c)}  {fmt(-s)}  <span className="text-ochre">{fmt(tx / 10)}</span> ⎤</div>
            <div>⎢ {fmt(s)}  {fmt(c)}  <span className="text-ochre">{fmt(-ty / 10)}</span> ⎥</div>
            <div>⎣  0.00   0.00   1.00 ⎦</div>
            <div className="mt-1 text-[10px] text-ink-muted">
              旋转 R 在左上 2×2，平移 t 在<span className="text-ochre">最后一列</span>
            </div>
          </div>
          {[
            { label: 'X 平移', v: tx, set: setTx, min: -80, max: 120, unit: `${(tx / 10).toFixed(1)} cm` },
            { label: 'Y 平移', v: ty, set: setTy, min: -90, max: 20, unit: `${(-ty / 10).toFixed(1)} cm` },
            { label: '旋转 θ', v: deg, set: setDeg, min: -90, max: 90, unit: `${deg}°` },
          ].map((r) => (
            <div key={r.label}>
              <div className="mb-0.5 flex justify-between text-[11.5px]">
                <span className="text-ink-2">{r.label}</span>
                <span className="font-mono text-brand">{r.unit}</span>
              </div>
              <input
                type="range"
                min={r.min}
                max={r.max}
                value={r.v}
                onChange={(e) => r.set(Number(e.target.value))}
                className="w-full accent-brand"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
