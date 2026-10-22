/**
 * TimelineItem — 消息流条目：时间戳 mono + 发送方→接收方 + 类型徽标 + 可展开详情
 * 展开面板：PAYLOAD · 来源（发送方职责）· 上文/下文链路（可选 context，向后兼容）
 * （design.md §5.2，协同页泳道 / 总览实时动态共用）
 */
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import type { AgentId } from '@/data/agents';
import { getAgent } from '@/data/agents';
import type { CollabEventType } from '@/data/collabScript';
import TraceBadge from './TraceBadge';
import { cn } from '@/lib/utils';

export const collabTypeMeta: Record<CollabEventType, { label: string; color: string }> = {
  message: { label: '消息', color: '#66725E' },
  handoff: { label: '交接', color: '#4E7860' },
  debate: { label: '辩论', color: '#B0483B' },
  revision: { label: '修订', color: '#E7B45A' },
  verdict: { label: '裁定', color: '#6BA080' },
  decision: { label: '决议', color: '#5A6553' },
};

export default function TimelineItem({
  time,
  from,
  to,
  type,
  content,
  payload,
  kbRefs,
  defaultExpanded = false,
  className,
  context,
}: {
  time: string;
  from: AgentId;
  to: AgentId | 'ALL';
  type: CollabEventType;
  content: string;
  payload?: string;
  kbRefs?: string[];
  defaultExpanded?: boolean;
  className?: string;
  /** 前后事件的内容摘要（不传则展开区完全不显示，Home.tsx 不受影响） */
  context?: { prev?: string; next?: string };
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const fromAgent = getAgent(from);
  const meta = collabTypeMeta[type];
  const toLabel = to === 'ALL' ? '全体' : getAgent(to).code;

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: -16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className={cn('group rounded-[10px] border border-hairline bg-card-warm px-3.5 py-2.5', className)}
    >
      <div
        role={payload ? 'button' : undefined}
        tabIndex={payload ? 0 : undefined}
        onClick={() => payload && setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (payload && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        className={cn('flex w-full items-start gap-3 text-left', payload && 'cursor-pointer')}
      >
        <span className="mt-0.5 shrink-0 font-mono text-[11.5px] leading-[18px] text-ink-muted tabular">
          {time}
        </span>
        <span
          className="mt-0.5 shrink-0 rounded-[6px] px-1.5 py-px font-mono text-[10.5px] font-semibold"
          style={{ color: fromAgent.color, backgroundColor: `${fromAgent.color}14` }}
        >
          {fromAgent.code}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] leading-[20px] text-ink-2">
            <span className="mr-1.5 font-mono text-[11px] text-ink-muted">→ {toLabel}</span>
            <span
              className="mr-1.5 rounded-[5px] border px-1 py-px font-mono text-[10px] font-medium"
              style={{ color: meta.color, borderColor: `${meta.color}50`, backgroundColor: `${meta.color}0D` }}
            >
              {meta.label}
            </span>
            {content}
          </span>
          {kbRefs && kbRefs.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1">
              {kbRefs.map((id) => (
                <TraceBadge key={id} kbId={id} />
              ))}
            </span>
          )}
        </span>
        {payload && (
          <ChevronDown
            size={14}
            className={cn('mt-1 shrink-0 text-ink-muted transition-transform duration-200', expanded && 'rotate-180')}
          />
        )}
      </div>
      <AnimatePresence initial={false}>
        {expanded && payload && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-2 space-y-1.5">
              <div className="rounded-lg border border-hairline bg-paper-deep/60 px-3 py-2 font-mono text-[11.5px] leading-[18px] text-ink-2">
                <span className="mr-2 text-ink-muted">PAYLOAD</span>
                {payload}
              </div>
              <div className="rounded-lg border border-hairline bg-paper-deep/40 px-3 py-2 text-[11.5px] leading-[18px]">
                <span className="mr-2 font-mono text-ink-muted">来源</span>
                <span className="font-medium" style={{ color: fromAgent.color }}>
                  {fromAgent.name}
                </span>
                <span className="ml-1.5 text-ink-muted">· {fromAgent.duty}</span>
              </div>
              {context && (context.prev || context.next) && (
                <div className="space-y-1 rounded-lg border border-hairline bg-paper-deep/30 px-3 py-2 text-[11px] leading-[17px] text-ink-muted">
                  {context.prev && (
                    <div>
                      <span className="mr-1.5 font-mono text-ink-muted/80">上文</span>
                      {context.prev}
                    </div>
                  )}
                  {context.next && (
                    <div>
                      <span className="mr-1.5 font-mono text-ink-muted/80">下文</span>
                      {context.next}
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
