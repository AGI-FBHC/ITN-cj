/**
 * ControlBar — S1 协同控制台（sticky 工具条）
 * 场景选择器 · 运行/暂停/重置 · 倍速 1x/2x/4x · 单步开关
 * 5 段阶段 stepper（active 脉冲圆环强调 + 阶段内事件派发进度）+ 状态徽标 + 模拟计时器 T+00.0s
 */
import { motion } from 'framer-motion';
import { Play, Pause, RotateCcw, Check, StepForward } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import LiveDot from '@/components/LiveDot';
import type { Playback, PlaySpeed } from './usePlayback';
import type { StageDef } from './scriptModel';
import { stageState, scenarioMeta } from './scriptModel';
import type { Scenario } from './scriptModel';
import { cn } from '@/lib/utils';

const easeLf = [0.22, 1, 0.36, 1] as [number, number, number, number];

const statusMeta = {
  idle: { label: '待命', cls: 'border-hairline bg-paper-deep/70 text-ink-muted', dot: 'idle' as const },
  running: { label: '协同中', cls: 'border-brand-amber/50 bg-brand-amber-tint text-brand-amber', dot: 'thinking' as const },
  paused: { label: '已暂停', cls: 'border-ochre/40 bg-ochre-tint text-ochre', dot: 'idle' as const },
  done: { label: '已收敛', cls: 'border-brand/40 bg-brand-tint text-brand', dot: 'running' as const },
};

function StageStepper({ stages, cursor }: { stages: StageDef[]; cursor: number }) {
  return (
    <div className="hidden items-center gap-1 xl:flex" aria-label="协同阶段">
      {stages.map((s, i) => {
        const st = stageState(s, cursor);
        /* 该阶段事件派发进度：已越过的下标数 / 总下标数，active 时展示 */
        const dispatched = s.idxs.filter((idx) => idx < cursor).length;
        return (
          <div key={s.key} className="flex items-center gap-1">
            {i > 0 && <span className={cn('h-px w-3', st === 'upcoming' ? 'bg-hairline' : 'bg-brand/50')} />}
            <span
              className={cn(
                'relative flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10.5px] transition-colors duration-300',
                st === 'done' && 'border-brand bg-brand text-paper',
                st === 'active' && 'border-brand-amber/60 bg-brand-amber-tint text-brand-amber animate-pulse-ring',
                st === 'upcoming' && 'border-hairline bg-paper text-ink-muted',
              )}
            >
              {st === 'done' ? (
                <motion.span
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 18 }}
                  className="flex"
                >
                  <Check size={10} strokeWidth={3} />
                </motion.span>
              ) : (
                <span
                  className={cn(
                    'h-1 w-1 rounded-full',
                    st === 'active' ? 'animate-pulse bg-brand-amber' : 'bg-ink-muted/50',
                  )}
                />
              )}
              {s.label}
              {st === 'active' && s.idxs.length > 0 && (
                <span className="font-mono text-[9.5px] font-normal text-brand-amber/80 tabular">
                  {dispatched}/{s.idxs.length}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function ControlBar({
  learnerName,
  kpName,
  scenario,
  onScenarioChange,
  playback,
  stages,
}: {
  learnerName: string;
  kpName: string;
  scenario: Scenario;
  onScenarioChange: (s: Scenario) => void;
  playback: Playback;
  stages: StageDef[];
}) {
  const { status, speed, stepMode, cursor, clock } = playback;
  const sm = statusMeta[status];
  const running = status === 'running';

  return (
    <motion.div
      initial={{ opacity: 0, y: -16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: easeLf }}
      className="sticky top-20 z-20 rounded-[14px] border border-hairline bg-card-warm/95 px-4 py-3 shadow-warm backdrop-blur-md"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {/* 场景选择器 */}
        <Select value={scenario} onValueChange={(v) => onScenarioChange(v as Scenario)}>
          <SelectTrigger
            className="h-9 w-[272px] border-hairline bg-paper text-[13px] text-ink-2"
            aria-label="协同场景"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-hairline bg-card-warm">
            {(Object.keys(scenarioMeta) as Scenario[]).map((key) => (
              <SelectItem key={key} value={key} className="text-[13px]">
                为 {learnerName} 生成 · 《{kpName}》{scenarioMeta[key].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* 主控按钮组 */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (status === 'done') {
                playback.reset();
                playback.play();
              } else {
                playback.toggle();
              }
            }}
            className="inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-brand px-4 text-[13.5px] font-medium text-paper transition-all duration-200 ease-lf hover:bg-brand-hover hover:shadow-warm"
          >
            {running ? <Pause size={15} /> : <Play size={15} />}
            {running ? '暂停' : status === 'paused' ? '继续' : status === 'done' ? '重新播放' : '运行协同演示'}
          </button>
          <button
            type="button"
            onClick={playback.reset}
            disabled={status === 'idle'}
            className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-brand/35 px-3 text-[13px] font-medium text-brand transition-all duration-200 ease-lf hover:bg-brand-tint disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw size={14} />
            重置
          </button>
        </div>

        {/* 倍速 segmented */}
        <div className="flex items-center rounded-[10px] border border-hairline bg-paper p-0.5" aria-label="倍速">
          {([1, 2, 4] as PlaySpeed[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => playback.setSpeed(s)}
              className={cn(
                'rounded-[8px] px-2.5 py-1 font-mono text-[12px] transition-colors duration-150',
                speed === s ? 'bg-brand text-paper' : 'text-ink-muted hover:text-ink',
              )}
            >
              {s}x
            </button>
          ))}
        </div>

        {/* 单步开关 */}
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
          <Switch checked={stepMode} onCheckedChange={playback.setStepMode} aria-label="单步模式" />
          <StepForward size={14} className="text-ink-muted" />
          单步
        </label>

        {/* 右侧状态区 */}
        <div className="ml-auto flex items-center gap-3">
          <StageStepper stages={stages} cursor={cursor} />
          <span className={cn('flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-medium', sm.cls)}>
            <LiveDot status={sm.dot} />
            {sm.label}
          </span>
          <span className="font-mono text-[13px] font-medium text-ink-2 tabular">
            T+{clock.toFixed(1)}s
          </span>
        </div>
      </div>
    </motion.div>
  );
}
