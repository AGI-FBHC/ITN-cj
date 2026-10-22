/**
 * AgentChip — Agent 头像块：专属色方块图标 + 代号 mono + 中文名 + 状态点
 * 全站统一（design.md §5.2）
 */
import { Brain, Database, PenLine, ShieldCheck, Scale } from 'lucide-react';
import type { AgentDef, AgentId } from '@/data/agents';
import { getAgent } from '@/data/agents';
import LiveDot from './LiveDot';
import { cn } from '@/lib/utils';

export const agentIconMap = {
  Brain,
  Database,
  PenLine,
  ShieldCheck,
  Scale,
} as const;

export function AgentIcon({
  agent,
  size = 18,
  className,
}: {
  agent: AgentDef;
  size?: number;
  className?: string;
}) {
  const Icon = agentIconMap[agent.icon];
  return <Icon size={size} strokeWidth={1.75} className={className} style={{ color: agent.color }} />;
}

export default function AgentChip({
  agentId,
  size = 'md',
  showStatus = true,
  className,
  onClick,
}: {
  agentId: AgentId;
  size?: 'sm' | 'md' | 'lg';
  showStatus?: boolean;
  className?: string;
  onClick?: () => void;
}) {
  const agent = getAgent(agentId);
  const box =
    size === 'lg' ? 'h-11 w-11 rounded-[10px]' : size === 'sm' ? 'h-6 w-6 rounded-md' : 'h-8 w-8 rounded-lg';
  const iconSize = size === 'lg' ? 22 : size === 'sm' ? 13 : 16;
  return (
    <span
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2.5',
        onClick && 'cursor-pointer',
        className,
      )}
    >
      <span
        className={cn('flex shrink-0 items-center justify-center border', box)}
        style={{ backgroundColor: `${agent.color}14`, borderColor: `${agent.color}45` }}
      >
        <AgentIcon agent={agent} size={iconSize} />
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="font-mono text-[11px] font-medium tracking-wide" style={{ color: agent.color }}>
          {agent.code}
        </span>
        {size !== 'sm' && (
          <span className={cn('truncate font-medium text-ink', size === 'lg' ? 'text-[15px]' : 'text-[13px]')}>
            {agent.name}
          </span>
        )}
      </span>
      {showStatus && size !== 'sm' && <LiveDot status="running" className="ml-1" />}
    </span>
  );
}
