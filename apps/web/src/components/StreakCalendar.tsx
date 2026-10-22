import { useMemo } from 'react';
import { CalendarDays, Flame } from 'lucide-react';
import { cn } from '@/lib/utils';

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export default function StreakCalendar({
  streakDays,
  studyDates,
  totalDays,
  className,
}: {
  streakDays: number;
  studyDates: string[];
  totalDays?: number;
  className?: string;
}) {
  const studied = useMemo(() => new Set(studyDates), [studyDates]);
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => new Date(year, month, index + 1)),
  ];
  const weekLabels = ['日', '一', '二', '三', '四', '五', '六'];

  return (
    <div className={cn('lf-card p-6', className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2 text-[12px] text-ink-muted">
          <CalendarDays size={15} className="text-brand" />
          学习日历
        </div>
        <div className="flex items-center gap-1.5 rounded-lg border border-brand-amber/35 bg-brand-amber-tint px-2.5 py-1.5 text-ochre">
          <Flame size={14} />
          <span className="text-[12px] font-semibold">已连续学习 {streakDays} 天</span>
        </div>
      </div>
      <p className="mt-1 text-[11.5px] text-ink-muted">
        按后端每日学习会话统计{totalDays != null ? ` · 累计学习 ${totalDays} 天` : ''}
      </p>

      <div className="mt-5 grid grid-cols-7 gap-2">
        {weekLabels.map((label) => (
          <div key={label} className="pb-1 text-center font-mono text-[11px] text-ink-muted">{label}</div>
        ))}
        {cells.map((date, index) => {
          if (!date) return <span key={`empty-${index}`} />;
          const key = dateKey(date);
          const learned = studied.has(key);
          const isToday = key === dateKey(today);
          return (
            <div key={key} className="flex items-center justify-center">
              <span
                className={cn(
                  'relative flex h-10 w-10 items-center justify-center rounded-full font-mono text-[13px] transition-colors',
                  learned ? 'bg-brand font-semibold text-paper' : 'text-ink-2',
                  isToday && 'ring-2 ring-brand/50',
                )}
              >
                {date.getDate()}
                {learned && <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-paper/90" />}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
