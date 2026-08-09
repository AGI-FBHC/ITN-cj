/**
 * RealTeachingRunView — 真实 AI 教研组运行的协同页视图。
 * 替代 `/agents` 的 mock 脚本视图：泳道、消息流、仲裁结论全部来自本次 SSE 事件。
 */
import { useMemo, useState } from 'react';
import { BadgeCheck, Database, ShieldAlert, Sparkles } from 'lucide-react';
import type { AgentId } from '@/data/agents';
import { agents } from '@/data/agents';
import type { CollabEvent, CollabEventType, CollabScript } from '@/data/collabScript';
import type { TeachingGroupRunPayload } from '@/lib/api';
import type { TimelineFilter } from '@/components/agents/MessageTimeline';
import MessageTimeline from '@/components/agents/MessageTimeline';
import { AgentIcon } from '@/components/AgentChip';
import LiveDot from '@/components/LiveDot';
import TraceBadge from '@/components/TraceBadge';
import { cn } from '@/lib/utils';

const NEXT_AGENT: Record<string, AgentId | 'ALL'> = {
  'DIA-01': 'ARB-05',
  'RET-02': 'ARB-05',
  'GEN-03': 'VER-04',
  'VER-04': 'ARB-05',
  'ARB-05': 'ALL',
};

const EVENT_TYPE: Record<string, CollabEventType> = {
  'DIA-01': 'message',
  'RET-02': 'message',
  'GEN-03': 'revision',
  'VER-04': 'verdict',
  'ARB-05': 'decision',
};

function textOf(agentId: string, data: Record<string, unknown>): string {
  if (agentId === 'DIA-01') {
    return `${String(data.focus ?? '')}：${String(data.reason ?? '')}`;
  }
  if (agentId === 'RET-02') {
    const evidence = (data.evidence ?? []) as unknown[];
    return `检索「${String(data.query ?? '')}」 · 命中 ${evidence.length} 条知识库依据`;
  }
  if (agentId === 'GEN-03') {
    return `${String(data.title ?? '')}：${String(data.summary ?? '')}`;
  }
  if (agentId === 'VER-04') {
    const defects = (data.defects ?? []) as unknown[];
    return defects.length
      ? `发现 ${defects.length} 项审核问题：${String((defects[0] as { message?: string })?.message ?? '')}`
      : '审核通过，无关键缺陷';
  }
  if (agentId === 'ARB-05') {
    return `${String(data.decision ?? '')}：${String(data.nextAction ?? '')}`;
  }
  return JSON.stringify(data);
}

function kbRefsOf(agentId: string, data: Record<string, unknown>): string[] {
  if (agentId === 'RET-02') {
    const evidence = (data.evidence ?? []) as { kbId?: string }[];
    return evidence.slice(0, 5).map((item) => item.kbId ?? '').filter(Boolean);
  }
  if (agentId === 'GEN-03') {
    const citations = (data.citations ?? []) as { kbId?: string }[];
    return citations.slice(0, 5).map((item) => item.kbId ?? '').filter(Boolean);
  }
  return [];
}

function buildRealScript(run: TeachingGroupRunPayload, learnerName: string): CollabScript {
  const events: CollabEvent[] = [];
  let t = 0;
  for (const event of run.events) {
    if (event.type !== 'agent_output' || !event.agent) continue;
    const agentId = event.agent as AgentId;
    events.push({
      t,
      from: agentId,
      to: NEXT_AGENT[agentId] ?? 'ALL',
      type: EVENT_TYPE[agentId] ?? 'message',
      content: textOf(agentId, event.data),
      payload: JSON.stringify(event.data).slice(0, 260),
      kbRefs: kbRefsOf(agentId, event.data),
    });
    t += 1.4;
  }
  const decision = run.result?.decision as Record<string, unknown> | undefined;
  if (decision) {
    events.push({
      t,
      from: 'ARB-05',
      to: 'ALL',
      type: 'decision',
      content: `最终决议：${String(decision.nextAction ?? '')} · ${String(decision.reason ?? '')}`,
      payload: JSON.stringify(decision).slice(0, 260),
    });
  }
  const focus = String(
    (run.result?.diagnosis as Record<string, unknown> | undefined)?.focus ?? '当前知识点',
  );
  return {
    topic: 'AI 教研组真实协同',
    learnerId: learnerName,
    kpId: 'kp-ds',
    kpName: focus,
    resourceTitle: '教研组实时备课方案',
    events,
  };
}

export default function RealTeachingRunView({
  run,
  learnerName,
}: {
  run: TeachingGroupRunPayload;
  learnerName: string;
}) {
  const [filter, setFilter] = useState<TimelineFilter>('ALL');
  const [autoScroll, setAutoScroll] = useState(false);
  const script = useMemo(() => buildRealScript(run, learnerName), [run, learnerName]);

  const statusByAgent = useMemo(() => {
    const statuses: Record<string, 'done' | 'failed'> = {};
    for (const event of run.events) {
      if (!event.agent) continue;
      if (event.type === 'agent_completed' && event.success !== false) statuses[event.agent] = 'done';
      if (event.type === 'agent_failed') statuses[event.agent] = 'failed';
    }
    return statuses;
  }, [run.events]);

  const outputByAgent = useMemo(() => {
    const outputs: Record<string, string> = {};
    for (const event of run.events) {
      if (event.type === 'agent_output' && event.agent) {
        outputs[event.agent] = textOf(event.agent, event.data);
      }
    }
    return outputs;
  }, [run.events]);

  const decision = run.result?.decision as Record<string, unknown> | undefined;
  const review = run.result?.review as Record<string, unknown> | undefined;
  const evidence = (run.result?.evidence ?? []) as { kbId?: string; title?: string }[];
  const plan = run.result?.plan as Record<string, unknown> | undefined;

  return (
    <div className="mx-auto max-w-[1320px] px-8 pb-16 pt-6">
      <div className="rounded-[14px] border border-brand/25 bg-brand-tint/40 p-5">
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex h-11 w-11 items-center justify-center rounded-[11px] bg-brand text-paper">
            <Sparkles size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="lf-mono-label !text-[10.5px]">REAL TEACHING RUN</div>
            <h1 className="font-serif text-[22px] font-semibold text-ink">AI 教研组真实协同</h1>
            <p className="mt-1 text-[13px] text-ink-muted">
              {learnerName} · {script.kpName} · 非演示脚本，数据来自本次教研组 SSE 运行
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-brand/40 bg-brand-tint px-2.5 py-1.5 font-mono text-[11px] text-brand">
            <LiveDot status="running" />
            真实运行已收敛
          </span>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <div className="lf-card overflow-hidden">
            <div className="border-b border-hairline px-5 py-3.5">
              <div className="lf-mono-label !text-[10.5px]">AGENT TOPOLOGY</div>
              <h3 className="mt-0.5 text-[16px] font-semibold text-ink">五体协同泳道 · 真实输出</h3>
            </div>
            <div className="divide-y divide-hairline">
              {agents.map((agent) => {
                const status = statusByAgent[agent.id];
                const output = outputByAgent[agent.id];
                return (
                  <div
                    key={agent.id}
                    className={cn(
                      'flex items-start gap-3 px-5 py-4 transition-colors',
                      status === 'done' ? 'bg-brand-tint/20' : 'bg-paper',
                    )}
                  >
                    <span
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border"
                      style={{ backgroundColor: `${agent.color}14`, borderColor: `${agent.color}45` }}
                    >
                      <AgentIcon agent={agent} size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[14px] font-semibold text-ink">{agent.name}</span>
                        <span className="font-mono text-[10.5px] font-medium" style={{ color: agent.color }}>
                          {agent.code}
                        </span>
                        <span className="ml-auto">
                          <LiveDot status={status === 'failed' ? 'error' : status === 'done' ? 'running' : 'idle'} />
                        </span>
                      </div>
                      <p className="mt-1 text-[12.5px] leading-[19px] text-ink-2">{output ?? agent.duty}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="lg:col-span-5">
          <MessageTimeline
            events={script.events}
            cursor={script.events.length}
            base={Date.now()}
            filter={filter}
            onFilterChange={setFilter}
            autoScroll={autoScroll}
            onAutoScrollChange={setAutoScroll}
            stepMode={false}
            status="done"
            onStep={() => undefined}
          />
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <div className="lf-card h-full p-5">
            <div className="lf-mono-label mb-2 !text-[10.5px]">ARB-05 DECISION</div>
            <div className="flex items-start gap-2.5">
              <BadgeCheck size={18} className="mt-0.5 shrink-0 text-brand" />
              <div>
                <p className="text-[15px] font-semibold leading-[23px] text-ink">
                  {String(decision?.nextAction ?? '')}
                </p>
                <p className="mt-1 text-[13px] leading-[20px] text-ink-2">
                  {String(decision?.reason ?? '')}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-4">
          <div className="lf-card h-full p-5">
            <div className="lf-mono-label mb-2 !text-[10.5px]">VERIFICATION</div>
            <div className="flex items-center gap-2.5">
              <ShieldAlert size={18} className="shrink-0 text-ochre" />
              <div className="text-[13px] leading-[20px] text-ink-2">
                {review?.passed === false || decision?.decision === 'reject'
                  ? '审核发现风险，方案已退回修订'
                  : '审核通过 · 无关键缺陷'}
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-3">
          <div className="lf-card h-full p-5">
            <div className="lf-mono-label mb-2 !text-[10.5px]">EVIDENCE</div>
            <div className="flex items-center gap-2.5">
              <Database size={18} className="shrink-0 text-brand" />
              <span className="text-[13px] text-ink-2">命中 {evidence.length} 条知识库依据</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {evidence.slice(0, 5).map((item) => (
                <TraceBadge key={item.kbId ?? item.title} kbId={item.kbId ?? item.title ?? ''} />
              ))}
            </div>
            {plan && (
              <p className="mt-3 border-t border-hairline pt-3 text-[12px] leading-[18px] text-ink-muted">
                {String(plan.title ?? '')}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
