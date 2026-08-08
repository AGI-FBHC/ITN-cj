/**
 * VisionGuideDemo — 视觉引导抓取交互演示（课件 demo block）
 * 左：相机视野像素坐标 (u,v)；右：机器人工作台毫米坐标 (X,Y)；
 * 中间换算式按固定手眼标定系数实时代入。拖滑块移动工件，点击「拍照→抓取」完成一次闭环。
 */
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Camera, Crosshair, Check } from 'lucide-react';
import TraceBadge from '@/components/TraceBadge';
import { cn } from '@/lib/utils';

/* 手眼标定系数（固定）：X = A·u + B，Y = C·v + D（单位：mm） */
const A = 0.22;
const B = 0;
const C = -0.2;
const D = 96;

export default function VisionGuideDemo({ tourStep = null }: { tourStep?: number | null }) {
  const [u, setU] = useState(200);
  const [v, setV] = useState(300);
  const [moved, setMoved] = useState(false);
  const [grabbed, setGrabbed] = useState<{ u: number; v: number } | null>(null);
  const [achieved, setAchieved] = useState(false);
  const [flash, setFlash] = useState(false);
  const touring = tourStep !== null;

  /* 导览：0=移动工件到新位置并高亮相机视野；1=高亮换算式；2=高亮抓取点并自动执行一次抓取 */
  useEffect(() => {
    if (tourStep === null) return;
    if (tourStep === 0) {
      setU(460);
      setV(150);
      setMoved(true);
      setGrabbed(null);
    } else if (tourStep === 2) {
      setGrabbed({ u, v });
      setAchieved(true);
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 700);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourStep]);

  const doGrab = () => {
    if (touring) return;
    setGrabbed({ u, v });
    setFlash(true);
    setTimeout(() => setFlash(false), 700);
    if (moved) setAchieved(true);
  };

  /* 相机视野：像素空间 640×480 → SVG 200×150 */
  const camScale = 200 / 640;
  const wpSize = 70 * camScale;
  const wpX = u * camScale - wpSize / 2;
  const wpY = v * camScale - wpSize / 2;

  /* 手眼换算：像素 (u,v) → 机器人毫米坐标 (X,Y) */
  const gx = A * u + B;
  const gy = C * v + D;

  /* 工作台 SVG：原点 (ox,oy)，X 向右，Y 向上 */
  const ox = 28, oy = 128;
  const px = ox + gx, py = oy - gy;
  const gpx = grabbed !== null ? ox + (A * grabbed.u + B) : null;
  const gpy = grabbed !== null ? oy - (C * grabbed.v + D) : null;

  return (
    <div className="rounded-[12px] border border-brand/25 bg-paper p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10.5px] tracking-wide text-ink-muted">
          INTERACTIVE · 拖滑块移动工件，点「拍照→抓取」看坐标换算
        </span>
        <TraceBadge kbId="KB-011" />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {/* 左：相机视野 */}
        <div
          className={cn(
            'rounded-[8px] border p-2 transition-colors',
            tourStep === 0 ? 'border-brand-amber bg-brand-amber-tint' : 'border-hairline bg-card-warm',
          )}
        >
          <div className="mb-1 flex items-center gap-1 text-[10.5px] text-ink-muted">
            <Camera size={11} /> 相机视野 · 像素坐标
          </div>
          <svg viewBox="0 0 200 150" className="w-full rounded-[6px] bg-paper">
            {Array.from({ length: 9 }).map((_, i) => (
              <line key={`gx${i}`} x1={i * 25} y1={0} x2={i * 25} y2={150} stroke="#E5E3D7" strokeWidth="1" />
            ))}
            {Array.from({ length: 7 }).map((_, i) => (
              <line key={`gy${i}`} x1={0} y1={i * 25} x2={200} y2={i * 25} stroke="#E5E3D7" strokeWidth="1" />
            ))}
            <rect x={wpX} y={wpY} width={wpSize} height={wpSize} rx="2" fill="#B77552" opacity="0.85" />
            <circle cx={u * camScale} cy={v * camScale} r="2" fill="#4E7860" />
            <text x={u * camScale + 5} y={v * camScale - 6} fontSize="9" fill="#5A6553" fontFamily="monospace">
              ({u}, {v})
            </text>
          </svg>
        </div>

        {/* 右：机器人工作台 */}
        <div
          className={cn(
            'rounded-[8px] border p-2 transition-colors',
            tourStep === 2 ? 'border-brand-amber bg-brand-amber-tint' : 'border-hairline bg-card-warm',
          )}
        >
          <div className="mb-1 flex items-center gap-1 text-[10.5px] text-ink-muted">
            <Crosshair size={11} /> 机器人工作台 · 毫米坐标
          </div>
          <svg viewBox="0 0 200 150" className="w-full rounded-[6px] bg-paper">
            <rect x={ox - 10} y={oy - 6} width="20" height="14" rx="2" fill="#5A6553" />
            <line x1={ox} y1={oy} x2={ox + 150} y2={oy} stroke="#5A6553" strokeWidth="1.4" />
            <line x1={ox} y1={oy} x2={ox} y2={oy - 110} stroke="#5A6553" strokeWidth="1.4" />
            <text x={ox + 152} y={oy + 3} fontSize="9" fill="#5A6553" fontFamily="monospace">X</text>
            <text x={ox - 4} y={oy - 112} fontSize="9" fill="#5A6553" fontFamily="monospace">Y</text>

            {gpx !== null && gpy !== null && (
              <line x1={ox} y1={oy} x2={gpx} y2={gpy} stroke="#E7B45A" strokeWidth="1.2" strokeDasharray="4 3" />
            )}

            <line x1={px - 6} y1={py} x2={px + 6} y2={py} stroke="#4E7860" strokeWidth="2" />
            <line x1={px} y1={py - 6} x2={px} y2={py + 6} stroke="#4E7860" strokeWidth="2" />
            <motion.circle
              cx={px}
              cy={py}
              r={8}
              fill="none"
              stroke="#4E7860"
              strokeWidth="1.4"
              animate={flash ? { r: [8, 16, 8], opacity: [0.9, 0.15, 0.9] } : { r: 8, opacity: 0.6 }}
              transition={{ duration: 0.6 }}
            />
            <text x={px + 8} y={py + 4} fontSize="9" fill="#4E7860" fontFamily="monospace">
              ({gx.toFixed(1)}, {gy.toFixed(1)})
            </text>
          </svg>
        </div>
      </div>

      {/* 换算式 */}
      <div
        className={cn(
          'mt-3 rounded-[8px] border p-3 font-mono text-[11.5px] leading-[19px] text-ink-2 transition-colors',
          tourStep === 1 ? 'border-brand-amber bg-brand-amber-tint' : 'border-hairline bg-card-warm',
        )}
      >
        <div className="mb-1 text-[10px] text-ink-muted">手眼标定换算（像素 → 毫米）</div>
        <div>
          X = <span className={cn('text-brand-amber', tourStep === 1 && 'animate-pulse')}>{A}</span> × u +{' '}
          <span className={cn('text-brand-amber', tourStep === 1 && 'animate-pulse')}>{B}</span> = {gx.toFixed(1)} mm
        </div>
        <div>
          Y = <span className={cn('text-brand-amber', tourStep === 1 && 'animate-pulse')}>{C}</span> × v +{' '}
          <span className={cn('text-brand-amber', tourStep === 1 && 'animate-pulse')}>{D}</span> = {gy.toFixed(1)} mm
        </div>
      </div>

      {/* 滑块 + 拍照按钮 */}
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div>
          <div className="mb-0.5 flex justify-between text-[11.5px]">
            <span className="text-ink-2">像素 u</span>
            <span className="font-mono text-brand">{u}px</span>
          </div>
          <input
            type="range"
            min={0}
            max={640}
            value={u}
            disabled={touring}
            onChange={(e) => {
              setU(Number(e.target.value));
              setMoved(true);
            }}
            className="w-full accent-brand disabled:opacity-50"
          />
        </div>
        <div>
          <div className="mb-0.5 flex justify-between text-[11.5px]">
            <span className="text-ink-2">像素 v</span>
            <span className="font-mono text-brand">{v}px</span>
          </div>
          <input
            type="range"
            min={0}
            max={480}
            value={v}
            disabled={touring}
            onChange={(e) => {
              setV(Number(e.target.value));
              setMoved(true);
            }}
            className="w-full accent-brand disabled:opacity-50"
          />
        </div>
        <button
          type="button"
          onClick={doGrab}
          disabled={touring}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-brand/40 bg-brand-tint px-3 py-1.5 text-[12px] font-medium text-brand transition-colors hover:bg-brand/15 disabled:opacity-50"
        >
          <Camera size={13} /> 拍照 → 抓取
        </button>
      </div>

      <AnimatePresence>
        {grabbed !== null && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-2.5 flex items-center gap-1.5 rounded-md border border-brand/40 bg-brand-tint px-2.5 py-1.5 text-[12px] text-brand"
          >
            <Check size={13} /> 定位完成 · 偏差 0.4mm ✓
          </motion.div>
        )}
        {achieved && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mt-2.5 flex items-center gap-1.5 rounded-md border border-brand/40 bg-brand-tint px-2.5 py-1.5 text-[12px] font-medium text-brand"
          >
            <Check size={13} />
            像素坐标经手眼矩阵翻译成机器人坐标——这就是视觉引导抓取的最短闭环。
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
