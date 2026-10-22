/**
 * PathProgressBar — 学习路径进度条（贯穿「学」流程）
 * 横向 stepper 展示 report.path 六阶段：状态色（已完成/进行中/待学/未解锁）+ 整体进度百分比。
 * 点任一阶段 → resolveLearnTarget 跳到对应资源或现场课件（未解锁不可点）。
 * full：/learn 顶部；compact：/learn/:kpId 顶部（高亮当前知识点，指示"我在整条路径的哪")。
 */
import { useNavigate } from 'react-router-dom';
import { Check, Lock } from 'lucide-react';
import { useProfile, dataIdOf } from '@/context/ProfileContext';
import { reportForLearner } from '@/data/reportBuilder';
import type { PathNodeStatus } from '@/data/reportData';
import { resolveLearnTarget } from '@/data/resources';
import { cn } from '@/lib/utils';

const NODE_STYLE: Record<PathNodeStatus, { dot: string; text: string }> = {
  done: { dot: 'border-brand bg-brand text-paper', text: 'text-ink-2' },
  active: { dot: 'border-brand-amber bg-brand-amber-tint text-ochre ring-2 ring-brand-amber/40', text: 'text-ochre font-semibold' },
  todo: { dot: 'border-hairline bg-paper text-ink-muted', text: 'text-ink-muted' },
  locked: { dot: 'border-hairline bg-paper-deep text-ink-muted/50', text: 'text-ink-muted/60' },
};

export default function PathProgressBar({
  currentKpId,
  compact = false,
}: {
  currentKpId?: string;
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const dataId = dataIdOf(currentLearner);
  const report = reportForLearner(currentLearner);
  const path = report.path;
  const doneCount = path.filter((n) => n.status === 'done').length;
  const pct = Math.round((doneCount / path.length) * 100);

  const jump = (kpId: string, status: PathNodeStatus) => {
    if (status === 'locked') return;
    navigate(resolveLearnTarget(dataId, kpId).to);
  };

  return (
    <div className="lf-card p-4">
      {/* 头部：标题 + 整体进度 */}
      <div className="mb-3 flex items-center justify-between gap-3">
        {/* 学习者页面不出现内部 Agent 代号（ARB-05 等属于系统透视的架构展示） */}
        <div className="text-[12px] text-ink-2">
          <span className="font-medium text-ink">学习路线</span>
          <span className="text-ink-muted"> · 已学完 {doneCount}/{path.length} 步</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-paper-deep">
            <div
              className="h-full rounded-full bg-brand transition-all duration-700"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="font-display text-[13px] font-semibold text-brand tabular">{pct}%</span>
        </div>
      </div>

      {/* stepper */}
      <div className="flex items-start gap-0 overflow-x-auto pb-1">
        {path.map((n, i) => {
          const st = NODE_STYLE[n.status];
          const isCurrent = currentKpId != null && n.kpId === currentKpId;
          const clickable = n.status !== 'locked';
          return (
            <div key={n.id} className="flex min-w-0 flex-1 items-start" style={{ minWidth: compact ? 76 : 92 }}>
              {/* 节点列 */}
              <div className="flex min-w-0 flex-1 flex-col items-center">
                <button
                  type="button"
                  disabled={!clickable}
                  onClick={() => jump(n.kpId, n.status)}
                  title={clickable ? `${n.title} · ${n.est}` : `${n.title}（${n.est}）`}
                  className={cn(
                    'relative flex items-center justify-center rounded-full border-2 font-mono text-[11px] font-semibold transition-all',
                    compact ? 'h-7 w-7' : 'h-8 w-8',
                    st.dot,
                    clickable && 'cursor-pointer hover:scale-110',
                    isCurrent && 'shadow-warm ring-2 ring-brand/50 ring-offset-1 ring-offset-paper',
                  )}
                >
                  {n.status === 'done' ? (
                    <Check size={compact ? 13 : 15} strokeWidth={2.5} />
                  ) : n.status === 'locked' ? (
                    <Lock size={compact ? 11 : 12} />
                  ) : (
                    i + 1
                  )}
                  {/* 当前位置小圆点 */}
                  {isCurrent && (
                    <span className="absolute -bottom-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-brand" />
                  )}
                </button>
                <div
                  className={cn(
                    'px-1 text-center',
                    compact
                      ? 'mt-1.5 line-clamp-1 text-[9.5px] leading-[13px]'
                      : 'mt-2 line-clamp-2 text-[10.5px] leading-[14px]',
                    st.text,
                  )}
                >
                  {n.title}
                </div>
                {!compact && (
                  <div className="mt-0.5 font-mono text-[9px] text-ink-muted/70">{n.est}</div>
                )}
              </div>
              {/* 连接线 */}
              {i < path.length - 1 && (
                <div
                  className={cn(
                    'mt-[13px] h-[2px] flex-1 rounded-full',
                    compact ? 'mt-[13px]' : 'mt-[15px]',
                    n.status === 'done' ? 'bg-brand/50' : 'bg-hairline',
                  )}
                  style={{ minWidth: 12 }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
