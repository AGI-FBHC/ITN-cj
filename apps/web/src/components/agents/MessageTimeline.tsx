/**
 * MessageTimeline — S3 实时消息流时间线（主体右栏 5/12）
 * MESSAGE BUS · 过滤 chips（全部/5 Agent）· 自动滚动 switch · 560px 内部滚动
 * 条目用共享 TimelineItem，并传入前后已派发事件摘要（context）呈现协同链路；
 * 单步模式下底部出现「下一条 →」推进条
 */
import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, RadioTower, ListFilter, CheckCircle2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import type { AgentId } from '@/data/agents';
import { agents, getAgent } from '@/data/agents';
import type { CollabEvent } from '@/data/collabScript';
import TimelineItem from '@/components/TimelineItem';
import type { PlayStatus } from './usePlayback';
import { formatWallTime } from './usePlayback';
import { cn } from '@/lib/utils';

const easeLf = [0.22, 1, 0.36, 1] as [number, number, number, number];

export type TimelineFilter = AgentId | 'ALL';

/** 截断摘要至 n 字（超出以省略号收尾），供上文/下文链路展示 */
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export default function MessageTimeline({
  events,
  cursor,
  base,
  filter,
  onFilterChange,
  autoScroll,
  onAutoScrollChange,
  stepMode,
  status,
  onStep,
}: {
  events: CollabEvent[];
  cursor: number;
  base: number | null;
  filter: TimelineFilter;
  onFilterChange: (f: TimelineFilter) => void;
  autoScroll: boolean;
  onAutoScrollChange: (v: boolean) => void;
  stepMode: boolean;
  status: PlayStatus;
  onStep: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const hoveredRef = useRef(false);

  /* 保留事件在完整脚本中的原始下标，用于取「上文/下文」链路摘要 */
  const dispatched = events.slice(0, cursor).map((e, i) => ({ e, i }));
  const visible =
    filter === 'ALL'
      ? dispatched
      : dispatched.filter(({ e }) => e.from === filter || e.to === filter);
  const next = cursor < events.length ? events[cursor] : null;

  /* 自动滚至最新（hover 暂停） */
  useEffect(() => {
    if (!autoScroll || hoveredRef.current) return;
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [cursor, autoScroll, filter]);

  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: easeLf, delay: 0.16 }}
      className="lf-card flex flex-col overflow-hidden"
      aria-label="协同消息流"
    >
      <div className="border-b border-hairline px-5 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="lf-mono-label !text-[10.5px]">MESSAGE BUS</div>
            <h3 className="mt-0.5 flex items-center gap-2 text-[16px] font-semibold text-ink">
              协同消息流
              <span className="font-mono text-[11px] font-normal text-ink-muted tabular">
                {cursor}/{events.length}
              </span>
            </h3>
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-muted">
            <RadioTower size={12} />
            自动滚动
            <Switch checked={autoScroll} onCheckedChange={onAutoScrollChange} aria-label="自动滚动" />
          </label>
        </div>

        {/* 过滤 chips */}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <ListFilter size={12} className="text-ink-muted" />
          <button
            type="button"
            onClick={() => onFilterChange('ALL')}
            className={cn(
              'rounded-[8px] border px-2 py-0.5 font-mono text-[10.5px] transition-colors duration-150',
              filter === 'ALL'
                ? 'border-brand bg-brand text-paper'
                : 'border-hairline bg-paper text-ink-muted hover:text-ink',
            )}
          >
            全部
          </button>
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onFilterChange(filter === a.id ? 'ALL' : a.id)}
              className={cn(
                'flex items-center gap-1 rounded-[8px] border px-2 py-0.5 font-mono text-[10.5px] transition-colors duration-150',
                filter === a.id
                  ? 'text-paper'
                  : 'border-hairline bg-paper text-ink-muted hover:text-ink',
              )}
              style={
                filter === a.id
                  ? { backgroundColor: a.color, borderColor: a.color }
                  : undefined
              }
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: filter === a.id ? '#F7F5EE' : a.color }}
              />
              {a.code}
            </button>
          ))}
        </div>
      </div>

      {/* 消息列表 */}
      <div
        ref={listRef}
        onMouseEnter={() => {
          hoveredRef.current = true;
        }}
        onMouseLeave={() => {
          hoveredRef.current = false;
        }}
        className="h-[560px] space-y-2 overflow-y-auto px-4 py-3"
      >
        {cursor === 0 && (
          <div className="flex h-[120px] flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-hairline bg-paper-deep/40 text-center">
            <RadioTower size={18} className="text-ink-muted" />
            <p className="px-6 text-[13px] leading-[20px] text-ink-muted">
              点击「运行协同演示」观看五体协同全流程
              {stepMode && '，或使用底部「下一条」逐条推进'}
            </p>
          </div>
        )}
        {cursor > 0 && visible.length === 0 && (
          <div className="flex h-[80px] items-center justify-center rounded-[10px] border border-dashed border-hairline text-[12.5px] text-ink-muted">
            {getAgent(filter as AgentId).code} 暂无已派发消息
          </div>
        )}
        {visible.map(({ e, i }) => (
          <TimelineItem
            key={`${e.t}-${e.from}-${e.to}`}
            time={formatWallTime(base, e.t)}
            from={e.from}
            to={e.to}
            type={e.type}
            content={e.content}
            payload={e.payload}
            kbRefs={e.kbRefs}
            context={{
              prev: i > 0 ? truncate(events[i - 1].content, 40) : undefined,
              next: i + 1 < cursor ? truncate(events[i + 1].content, 40) : undefined,
            }}
          />
        ))}
        {status === 'done' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center justify-center gap-1.5 rounded-[10px] bg-brand-tint/60 py-2 font-mono text-[11px] text-brand"
          >
            <CheckCircle2 size={13} />
            本轮 {events.length} 条消息全部派发完毕 · 已收敛
          </motion.div>
        )}
      </div>

      {/* 单步推进条 */}
      {stepMode && status !== 'done' && next && (
        <div className="flex items-center justify-between gap-3 border-t border-hairline bg-paper-deep/50 px-4 py-2.5">
          <span className="min-w-0 truncate font-mono text-[11px] text-ink-muted">
            NEXT · {next.from} → {next.to === 'ALL' ? '全体' : next.to} · T+{next.t.toFixed(1)}s
          </span>
          <button
            type="button"
            onClick={onStep}
            className="inline-flex shrink-0 items-center gap-1 rounded-[8px] bg-brand px-3 py-1.5 text-[12.5px] font-medium text-paper transition-colors duration-150 hover:bg-brand-hover"
          >
            下一条
            <ArrowRight size={13} />
          </button>
        </div>
      )}
    </motion.section>
  );
}
