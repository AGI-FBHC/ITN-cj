/**
 * DebateBubble — 辩论气泡：左侧 GEN 琥珀 / 右侧 VER 砖红，含轮次徽标 R1-R3
 * （design.md §5.2，协同页「辩论与交叉验证」面板）
 */
import { motion } from 'framer-motion';
import type { AgentId } from '@/data/agents';
import { getAgent } from '@/data/agents';
import AgentChip from './AgentChip';
import TraceBadge from './TraceBadge';
import { cn } from '@/lib/utils';

export default function DebateBubble({
  agentId,
  round,
  content,
  kbRefs,
  revision,
  className,
}: {
  agentId: AgentId;
  round?: 1 | 2 | 3;
  content: string;
  kbRefs?: string[];
  /** 修订 diff 行（可选，绿色新增/砖红删除） */
  revision?: { added?: string[]; removed?: string[] };
  className?: string;
}) {
  const agent = getAgent(agentId);
  const isGen = agentId === 'GEN-03';
  const tone = isGen ? '#E7B45A' : '#B0483B';

  return (
    <motion.div
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className={cn('flex w-full', isGen ? 'justify-start' : 'justify-end', className)}
    >
      <div
        className={cn('max-w-[78%] rounded-[14px] border bg-card-warm p-4', isGen ? 'rounded-tl-sm' : 'rounded-tr-sm')}
        style={{ borderColor: `${tone}45`, borderLeftWidth: isGen ? 3 : 1, borderRightWidth: isGen ? 1 : 3, borderLeftColor: isGen ? tone : undefined, borderRightColor: isGen ? undefined : tone }}
      >
        <div className={cn('mb-2 flex items-center gap-2', !isGen && 'flex-row-reverse')}>
          <AgentChip agentId={agentId} size="sm" showStatus={false} />
          <span className="text-[13px] font-medium text-ink">{agent.name}</span>
          {round && (
            <span
              className="rounded-md border px-1.5 py-px font-mono text-[10.5px] font-semibold"
              style={{ color: tone, borderColor: `${tone}55`, backgroundColor: `${tone}0F` }}
            >
              R{round}
            </span>
          )}
        </div>
        <p className="text-[13.5px] leading-[22px] text-ink-2">{content}</p>
        {revision && (
          <div className="mt-2 space-y-1 rounded-lg bg-paper-deep/70 p-2.5 font-mono text-[12px] leading-[19px]">
            {revision.removed?.map((line, i) => (
              <div key={`r${i}`} className="text-brand-danger line-through opacity-80">- {line}</div>
            ))}
            {revision.added?.map((line, i) => (
              <div key={`a${i}`} className="text-brand-success">+ {line}</div>
            ))}
          </div>
        )}
        {kbRefs && kbRefs.length > 0 && (
          <div className={cn('mt-2 flex flex-wrap gap-1', !isGen && 'justify-end')}>
            {kbRefs.map((id) => (
              <TraceBadge key={id} kbId={id} />
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}
