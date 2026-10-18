/**
 * GardenEmpty — 治愈系空态：小花园插画 + 一句温柔引导 + 单一行动
 * 用于「还没有笔记 / 能量为 0 / 还没有资源」等空场景，替代冷冰冰的「暂无数据」。
 * Skeleton — 与布局同形的骨架屏，替代转圈 spinner。
 */
import type { ReactNode } from 'react';
import { Sprout, GrassTuft, Succulent, LeafSmall } from './Flora';
import { cn } from '@/lib/utils';

type Scene = 'sprout' | 'plot' | 'pot';

/** 空态插画：一小片待耕耘的花园 */
function EmptyScene({ scene }: { scene: Scene }) {
  return (
    <div aria-hidden className="relative mx-auto mb-4 h-[104px] w-[190px]">
      {/* 柔光地面 */}
      <div
        className="absolute bottom-3 left-1/2 h-6 w-[150px] -translate-x-1/2 rounded-full blur-md"
        style={{ background: 'radial-gradient(ellipse at center, rgba(155,197,172,0.45), transparent 70%)' }}
      />
      {scene === 'sprout' && (
        <>
          <Sprout className="absolute bottom-2 left-1/2 h-[74px] w-[74px] -translate-x-1/2" />
          <GrassTuft className="absolute bottom-2 left-3 h-[34px] w-[48px] opacity-70" />
          <GrassTuft className="absolute bottom-2 right-3 h-[30px] w-[42px] scale-x-[-1] opacity-55" />
        </>
      )}
      {scene === 'plot' && (
        <>
          <GrassTuft className="absolute bottom-2 left-1/2 h-[46px] w-[64px] -translate-x-1/2" />
          <LeafSmall className="absolute bottom-8 left-4 h-[24px] w-[36px] opacity-75" />
          <LeafSmall className="absolute bottom-9 right-4 h-[22px] w-[34px] scale-x-[-1] opacity-60" />
        </>
      )}
      {scene === 'pot' && (
        <>
          <Succulent className="absolute bottom-2 left-1/2 h-[66px] w-[56px] -translate-x-1/2" />
          <GrassTuft className="absolute bottom-2 left-5 h-[28px] w-[40px] opacity-60" />
        </>
      )}
    </div>
  );
}

export default function GardenEmpty({
  scene = 'sprout',
  title,
  hint,
  action,
  className,
}: {
  scene?: Scene;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-10 text-center', className)}>
      <EmptyScene scene={scene} />
      <p className="font-serif text-[16px] text-ink">{title}</p>
      {hint && <p className="mt-1.5 max-w-[300px] text-[12.5px] leading-[20px] text-ink-muted">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** 骨架屏：与内容同形的柔和占位（呼吸微光） */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('lf-skeleton rounded-[10px]', className)} aria-hidden />;
}

/** 卡片骨架：标题 + 两行正文 + 条 */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn('lf-card p-5', className)} aria-hidden>
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="mt-3 h-3 w-full" />
      <Skeleton className="mt-2 h-3 w-4/5" />
      <Skeleton className="mt-4 h-1.5 w-full" />
    </div>
  );
}
