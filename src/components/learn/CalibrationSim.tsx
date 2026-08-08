/**
 * CalibrationSim — 零点标定五步交互模拟器（课件 demo block）
 * 按正确顺序点击五步：每步有仪表反馈；顺序错 → 抖动 + 提示；五步完成 → 达标动画。
 */
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, RotateCcw, AlertTriangle } from 'lucide-react';
import TraceBadge from '@/components/TraceBadge';
import { cn } from '@/lib/utils';

const STEPS = [
  { name: '回零准备', reading: '卸载工装 · T1 模式', detail: '各轴点动至机械零位刻线附近' },
  { name: '粗对零', reading: '刻线错位 ≤ 1 格', detail: '目视对齐零点刻线，J1→J6 逐轴' },
  { name: '精对零', reading: '百分表 0.018 mm ✓', detail: 'J2/J3 百分表找正，波动 ≤ 0.02 mm' },
  { name: '写入零点', reading: '编码器值已记录', detail: '示教器写入，拍照存档' },
  { name: '复测验证', reading: 'TCP 偏移 0.32 mm ✓', detail: '10 教学点复测 < 0.5 mm 合格' },
];

export default function CalibrationSim({ tourStep = null }: { tourStep?: number | null }) {
  const [done, setDone] = useState<number>(0); // 已完成步数
  const [wrongAt, setWrongAt] = useState<number | null>(null);
  const complete = done >= STEPS.length;
  const touring = tourStep !== null;

  const click = (idx: number) => {
    if (complete || touring) return;
    if (idx === done) {
      setDone(idx + 1);
      setWrongAt(null);
    } else if (idx > done) {
      setWrongAt(idx);
      setTimeout(() => setWrongAt(null), 900);
    }
  };

  return (
    <div className="rounded-[12px] border border-brand/25 bg-paper p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10.5px] tracking-wide text-ink-muted">
          INTERACTIVE · 按正确顺序点击五步
        </span>
        <span className="flex items-center gap-2">
          <TraceBadge kbId="KB-018" />
          <button
            type="button"
            onClick={() => { setDone(0); setWrongAt(null); }}
            className="inline-flex items-center gap-1 rounded-md border border-hairline bg-card-warm px-2 py-1 text-[11px] text-ink-muted hover:text-ink"
          >
            <RotateCcw size={11} /> 重来
          </button>
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-5">
        {STEPS.map((s, i) => {
          const isDone = i < done;
          /* 导览模式：语音讲到第几步，第几步就亮（琥珀高亮 + 展示读数） */
          const isToured = touring && tourStep !== null && i <= tourStep;
          const isTourCurrent = touring && i === tourStep;
          const isNextHint = !touring && i === done && !complete;
          const isWrong = wrongAt === i;
          return (
            <motion.button
              key={s.name}
              type="button"
              onClick={() => click(i)}
              animate={isWrong ? { x: [0, -4, 4, -3, 0] } : isTourCurrent ? { scale: [1, 1.05, 1] } : { x: 0 }}
              transition={{ duration: 0.35 }}
              className={cn(
                'rounded-[10px] border p-2.5 text-left transition-all',
                isDone && !touring && 'border-brand bg-brand-tint',
                isToured && 'border-brand-amber bg-brand-amber-tint',
                isWrong && 'border-brand-danger bg-brand-danger/10',
                !isDone && !isWrong && !isToured && 'border-hairline bg-card-warm hover:border-brand/40',
              )}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-semibold',
                    isDone && !touring ? 'bg-brand text-paper' : isToured ? 'bg-brand-amber text-paper' : 'bg-paper-deep text-ink-muted',
                  )}
                >
                  {isDone && !touring ? <Check size={11} /> : i + 1}
                </span>
                <span className={cn('text-[12px] font-semibold', isDone && !touring ? 'text-brand' : isToured ? 'text-ochre' : 'text-ink')}>{s.name}</span>
              </div>
              <div className="mt-1.5 font-mono text-[10px] leading-[14px] text-ink-muted">
                {isDone || isToured ? s.reading : s.detail}
              </div>
              {isNextHint && <div className="mt-1 h-[2px] animate-pulse rounded-full bg-brand-amber" />}
            </motion.button>
          );
        })}
      </div>

      <AnimatePresence>
        {wrongAt !== null && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-2.5 flex items-center gap-1.5 rounded-md border border-brand-danger/40 bg-brand-danger/10 px-2.5 py-1.5 text-[12px] text-brand-danger"
          >
            <AlertTriangle size={13} />
            顺序不对：{STEPS[wrongAt].name}要等前面的步骤完成——超差返工只能回到上一步，不能跳步。
          </motion.div>
        )}
        {complete && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mt-2.5 flex items-center gap-1.5 rounded-md border border-brand/40 bg-brand-tint px-2.5 py-1.5 text-[12px] font-medium text-brand"
          >
            <Check size={13} />
            标定完成：复测 TCP 偏移 0.32 mm &lt; 0.5 mm，验收合格（JB/T 8896）。
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
