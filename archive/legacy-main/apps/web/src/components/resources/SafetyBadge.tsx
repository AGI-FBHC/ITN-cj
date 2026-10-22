/**
 * SafetyBadge — 安全等级小胶囊（resources.md「安全可信」证据）
 * safe：常规操作（墨绿）· caution：注意事项（琥珀）· danger：高危步骤（砖红）
 * 样式与 lf-chip 一致，仅换配色与图标
 */
import { Check, AlertTriangle, OctagonAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SafetyLevel = 'safe' | 'caution' | 'danger';

const levelConfig: Record<
  SafetyLevel,
  { icon: typeof Check; label: string; className: string }
> = {
  safe: {
    icon: Check,
    label: '常规操作',
    className: 'border-brand/35 bg-brand-tint/70 text-brand',
  },
  caution: {
    icon: AlertTriangle,
    label: '注意事项',
    className: 'border-brand-amber/50 bg-brand-amber-tint/70 text-ochre',
  },
  danger: {
    icon: OctagonAlert,
    label: '高危步骤',
    className: 'border-brand-danger/45 bg-brand-danger/[0.08] text-brand-danger',
  },
};

export default function SafetyBadge({
  level,
  className,
}: {
  level: SafetyLevel;
  className?: string;
}) {
  const { icon: Icon, label, className: toneClass } = levelConfig[level];
  return (
    <span
      className={cn(
        'lf-chip gap-1 px-1.5 py-px text-[11px] font-medium',
        toneClass,
        className,
      )}
    >
      <Icon size={11} />
      {label}
    </span>
  );
}
