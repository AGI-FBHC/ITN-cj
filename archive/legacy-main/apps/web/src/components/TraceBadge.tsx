/**
 * TraceBadge — 溯源角标 [KB-xxx]（design.md §4.4）
 * 上标样式 mono 胶囊，hover 显示来源摘要，点击打开 KBDrawer
 * 全站任何生成内容都必须携带
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { getKBSlice } from '@/data/kbSlices';
import KBDrawer from './KBDrawer';
import { cn } from '@/lib/utils';

export default function TraceBadge({
  kbId,
  className,
  rich = false,
}: {
  kbId: string;
  className?: string;
  /** 富信息卡：标准号 + 来源类型 + 可信度迷你进度条 + 「点击查看原文」提示行。默认关闭，行为与旧版一致 */
  rich?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const slice = getKBSlice(kbId);
  if (!slice) return null;

  return (
    <>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              /* 原生 title：即使 Radix tooltip 未触发（触屏/键盘）也能知道这是可点的 */
              title="点开看这句话的出处"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(true);
              }}
              className={cn(
                'inline-flex translate-y-[-1px] cursor-pointer items-center gap-0.5 rounded-[6px] border border-brand/40 bg-brand-tint/60 px-1.5 py-px align-super font-mono text-[10.5px] font-medium leading-[16px] tracking-wide text-brand',
                /* 虚线下划线 + hover 抬起：静止时就暗示「这是可点的引用」 */
                'underline decoration-brand/40 decoration-dotted underline-offset-2',
                'transition-all duration-150 hover:-translate-y-[3px] hover:border-brand hover:bg-brand-tint hover:decoration-brand hover:shadow-warm',
                className,
              )}
            >
              [{kbId}]
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            className="max-w-[280px] border-hairline bg-card-warm text-ink-2 shadow-warm"
          >
            <div className="font-mono text-[11px] font-medium text-brand">
              {slice.id} · {slice.type}
              {slice.standardNo ? ` · ${slice.standardNo}` : ''}
            </div>
            <div className="mt-1 line-clamp-2 text-[12px] leading-[18px]">{slice.title}</div>
            {rich ? (
              <>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-paper-deep">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${slice.credibility * 100}%`,
                        backgroundColor: slice.credibility >= 0.9 ? '#4E7860' : '#E7B45A',
                      }}
                    />
                  </div>
                  <span className="font-mono text-[10.5px] tabular text-ink-muted">
                    {(slice.credibility * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-ink-muted">点击查看原文</div>
              </>
            ) : (
              <div className="mt-1 text-[11px] text-ink-muted">点开看完整出处</div>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <KBDrawer sliceId={kbId} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** 解析文本中的 [KB-xxx] 标记并替换为 TraceBadge（用于 markdown 之外的纯文本）
 *  rich：透传给 TraceBadge 的富信息卡开关，默认关闭，不影响既有调用方 */
export function withTraceBadges(text: string, rich = false): (string | ReactElement)[] {
  const parts = text.split(/(\[KB-\d{3}\])/g);
  return parts.map((part, i) => {
    const m = part.match(/^\[(KB-\d{3})\]$/);
    if (m) return <TraceBadge key={`${m[1]}-${i}`} kbId={m[1]} rich={rich} />;
    return part;
  });
}
