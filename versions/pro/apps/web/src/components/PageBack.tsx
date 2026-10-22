/**
 * PageBack — 深层页面的统一返回页头
 *
 * 两件事互补，都不撒谎：
 *   ← 返回    走浏览器历史，回到你真正来的地方；没有历史（直接输 URL/新标签打开）时回 fallback
 *   面包屑    结构位置「学 / AI 给我做的资料」，告诉你此刻身在何处，点上一级可跳
 *
 * 只在学习者视角显示——系统透视有侧栏 + 页头面包屑，不需要重复。
 */
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { cn } from '@/lib/utils';

export default function PageBack({
  parent,
  current,
  fallback,
  className,
}: {
  /** 上一级（结构上的父级） */
  parent: { label: string; to: string };
  /** 当前页名称 */
  current: string;
  /** 兼容旧调用：返回按钮已移除，该参数不再使用 */
  fallback?: string;
  className?: string;
}) {
  const { viewMode } = useProfile();
  if (viewMode !== 'learner') return null;

  return (
    <div className={cn('mb-4 flex flex-wrap items-center gap-x-3 gap-y-2', className)}>
      <nav aria-label="面包屑" className="flex min-w-0 items-center gap-1 text-[12.5px]">
        <Link to={parent.to} className="shrink-0 text-ink-muted transition-colors hover:text-brand hover:underline">
          {parent.label}
        </Link>
        <ChevronRight size={13} className="shrink-0 text-ink-muted/60" />
        <span className="truncate font-medium text-ink-2">{current}</span>
      </nav>
    </div>
  );
}
