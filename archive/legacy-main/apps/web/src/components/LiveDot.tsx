/**
 * LiveDot — 呼吸状态点（design.md §4.4：8px 圆点 + 呼吸光环）
 * running=绿 / thinking=琥珀 / idle=灰 / error=砖红
 */
import { cn } from '@/lib/utils';

export type LiveDotStatus = 'running' | 'thinking' | 'idle' | 'error';

const toneMap: Record<LiveDotStatus, { dot: string; label: string }> = {
  running: { dot: '#6BA080', label: '运行中' },
  thinking: { dot: '#E7B45A', label: '思考中' },
  idle: { dot: '#9AA39B', label: '待命' },
  error: { dot: '#B0483B', label: '异常' },
};

export default function LiveDot({
  status = 'running',
  showLabel = false,
  className,
}: {
  status?: LiveDotStatus;
  showLabel?: boolean;
  className?: string;
}) {
  const tone = toneMap[status];
  const breathing = status === 'running' || status === 'thinking';
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className="relative inline-flex h-2 w-2">
        {breathing && (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-50"
            style={{ backgroundColor: tone.dot }}
          />
        )}
        <span
          className="relative inline-flex h-2 w-2 rounded-full"
          style={{ backgroundColor: tone.dot }}
        />
      </span>
      {showLabel && (
        <span className="font-mono text-[11px] tracking-wide" style={{ color: tone.dot }}>
          {tone.label}
        </span>
      )}
    </span>
  );
}
