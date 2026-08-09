/**
 * TeachingGroup — 「AI 教研组」按需浮层（透明层）
 * P0：5 位 Agent 不再是静态文案，而是基于当前画像调用 FastAPI 真实教研链路。
 * 无服务时不伪造输出，显示失败状态。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, ArrowRight, ShieldCheck, Database, ChevronRight, Play, AlertCircle, Loader2 } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { agents } from '@/data/agents';
import { api } from '@/lib/api';
import type { TeachingGroupEvent } from '@/lib/api';
import { useProfile } from '@/context/ProfileContext';
import { AgentIcon } from '@/components/AgentChip';
import LiveDot from '@/components/LiveDot';
import { cn } from '@/lib/utils';

type AgentStatus = 'idle' | 'running' | 'done' | 'failed';

function summarizeOutput(agentId: string, data: Record<string, unknown>): string {
  if (agentId === 'DIA-01') {
    const focus = String(data.focus ?? '');
    const reason = String(data.reason ?? '');
    return focus ? `${focus}：${reason}` : '诊断完成';
  }
  if (agentId === 'RET-02') {
    const evidence = (data.evidence ?? []) as unknown[];
    return evidence.length ? `命中 ${evidence.length} 条知识库依据` : '未检索到足够依据';
  }
  if (agentId === 'GEN-03') {
    const title = String(data.title ?? '');
    const summary = String(data.summary ?? '');
    return title ? `${title}：${summary}` : '备课方案已生成';
  }
  if (agentId === 'VER-04') {
    const defects = (data.defects ?? []) as unknown[];
    return defects.length ? `发现 ${defects.length} 项问题` : '审核通过，无关键缺陷';
  }
  if (agentId === 'ARB-05') {
    const decision = String(data.decision ?? '');
    const next = String(data.nextAction ?? '');
    return `${decision === 'accept' ? '通过' : '退回'}：${next}`;
  }
  return JSON.stringify(data);
}

export default function TeachingGroup({
  variant = 'pill',
  collapsed = false,
}: {
  variant?: 'sidebar' | 'pill' | 'compact';
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { currentLearner, domainKnowledgePoints } = useProfile();
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const [finalResult, setFinalResult] = useState<Record<string, unknown> | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const weakest = useMemo(() => {
    if (!currentLearner.custom || domainKnowledgePoints.length === 0) return null;
    return [...domainKnowledgePoints].sort(
      (a, b) =>
        (b.targetLevel - (currentLearner.scores[b.id] ?? 50)) -
        (a.targetLevel - (currentLearner.scores[a.id] ?? 50)),
    )[0];
  }, [currentLearner, domainKnowledgePoints]);

  const canRun = Boolean(currentLearner.custom && currentLearner.id && weakest);

  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  const handleEvent = (event: TeachingGroupEvent) => {
    if (event.type === 'run_started') {
      setRunning(true);
      setError(null);
      setFinalResult(null);
      setStatuses({});
      setOutputs({});
      return;
    }
    if (event.type === 'agent_started' && event.agent) {
      setStatuses((prev) => ({ ...prev, [event.agent!]: 'running' }));
      return;
    }
    if (event.type === 'agent_output' && event.agent) {
      setStatuses((prev) => ({ ...prev, [event.agent!]: 'running' }));
      setOutputs((prev) => ({ ...prev, [event.agent!]: summarizeOutput(event.agent!, event.data) }));
      return;
    }
    if (event.type === 'agent_completed' && event.agent) {
      setStatuses((prev) => ({ ...prev, [event.agent!]: 'done' }));
      return;
    }
    if (event.type === 'agent_failed' && event.agent) {
      setStatuses((prev) => ({ ...prev, [event.agent!]: 'failed' }));
      return;
    }
    if (event.type === 'run_completed') {
      setRunning(false);
      setFinalResult(event.data);
      return;
    }
    if (event.type === 'run_failed') {
      setRunning(false);
      const code = String(event.data?.code ?? 'TEACHING_GROUP_FAILED');
      setError(code === 'LEARNER_NOT_FOUND' ? '未找到当前学习者画像' : '教研组服务暂时不可用，请稍后重试');
    }
  };

  const run = async () => {
    if (!currentLearner.custom || !currentLearner.id || !weakest) return;
    setError(null);
    try {
      await api.runTeachingGroupStream(
        {
          learnerId: currentLearner.id,
          knowledgePointId: weakest.id,
          mode: 'prepare_next',
        },
        handleEvent,
      );
    } catch (err) {
      setRunning(false);
      setError(err instanceof Error ? err.message : '教研组服务连接失败');
    }
  };

  const review = finalResult?.review as Record<string, unknown> | undefined;
  const evidence = (finalResult?.evidence ?? []) as unknown[];
  const decision = finalResult?.decision as Record<string, unknown> | undefined;

  return (
    <>
      {/* ===== 触发器 ===== */}
      {variant === 'sidebar' ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="AI 教研组"
          className={cn(
            'group flex w-full items-center gap-3 rounded-[12px] border border-brand/25 bg-brand-tint/60 px-3 py-2.5 text-left transition-all duration-200 ease-lf hover:border-brand/45 hover:bg-brand-tint',
            collapsed && 'justify-center px-0',
          )}
        >
          <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-brand text-paper">
            <Sparkles size={16} />
            <span className="absolute -right-0.5 -top-0.5">
              <LiveDot status={running ? 'running' : 'idle'} />
            </span>
          </span>
          {!collapsed && (
            <span className="min-w-0">
              <span className="block text-[13.5px] font-semibold text-brand">AI 教研组</span>
              <span className="block truncate text-[11px] text-ink-muted">
                {running ? '真实教研链路运行中' : '5 位智能体协同备课'}
              </span>
            </span>
          )}
        </button>
      ) : variant === 'compact' ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="AI 教研组"
          className="inline-flex items-center gap-1.5 rounded-[10px] border border-brand/30 bg-brand-tint/60 px-2.5 py-1.5 text-[13px] font-medium text-brand transition-all duration-200 hover:border-brand/55 hover:bg-brand-tint"
        >
          <Sparkles size={14} />
          <span className="hidden lg:inline">AI 教研组</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 rounded-[10px] border border-brand/30 bg-brand-tint/60 px-3 py-1.5 text-[13px] font-medium text-brand transition-all duration-200 hover:border-brand/55 hover:bg-brand-tint"
        >
          <Sparkles size={14} />
          看 AI 如何为我备课
        </button>
      )}

      {/* ===== 浮层 ===== */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-full gap-0 border-hairline bg-paper p-0 sm:max-w-md"
        >
          <SheetHeader className="border-b border-hairline bg-card-warm px-5 py-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-brand text-paper">
                <Sparkles size={18} />
              </span>
              <div>
                <SheetTitle className="font-serif text-[17px] text-ink">AI 教研组</SheetTitle>
                <SheetDescription className="text-[12px] text-ink-muted">
                  {currentLearner.custom
                    ? `为 ${currentLearner.name} 真实备课 · ${weakest?.name ?? '定位中'}`
                    : '演示画像暂不运行教研组，请使用自建画像'}
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>

          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {/* 运行按钮 */}
            <button
              type="button"
              onClick={run}
              disabled={!canRun || running}
              className={cn(
                'lf-btn-primary w-full !py-2.5 text-[14px]',
                (!canRun || running) && 'cursor-not-allowed opacity-60',
              )}
            >
              {running ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  教研组正在备课…
                </>
              ) : (
                <>
                  <Play size={15} />
                  让教研组为下一步备课
                </>
              )}
            </button>

            {error && (
              <div className="flex items-start gap-2.5 rounded-[12px] border border-brand-danger/40 bg-brand-danger/10 px-3.5 py-3 text-[12.5px] leading-[19px] text-brand-danger">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                {error}
              </div>
            )}

            {/* 真实审核结果 */}
            {finalResult && (
              <div className="flex items-start gap-3 rounded-[12px] border border-brand-amber/40 bg-brand-amber-tint/60 px-4 py-3">
                <ShieldCheck size={20} className="shrink-0 text-ochre" />
                <p className="text-[12.5px] leading-[19px] text-ink-2">
                  {review?.passed === false
                    ? '审核未通过：教研方案需要补充依据或修正内容。'
                    : `审核通过 · 本次命中 ${evidence.length} 条知识库依据。`}
                </p>
              </div>
            )}

            {/* 5 Agent 真实输出 */}
            <div>
              <div className="lf-mono-label mb-2.5">
                {running ? '真实教研链路运行中' : 'AI 教研组 Agent'}
              </div>
              <div className="space-y-2">
                {agents.map((a, i) => {
                  const status = statuses[a.id] ?? 'idle';
                  const output = outputs[a.id];
                  return (
                    <div
                      key={a.id}
                      className={cn(
                        'lf-anim-in-up flex items-start gap-3 rounded-[12px] border bg-card-warm p-3 transition-colors',
                        status === 'running' ? 'border-brand/40' : 'border-hairline',
                      )}
                      style={{ animationDelay: `${i * 60}ms` }}
                    >
                      <span
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border"
                        style={{ backgroundColor: `${a.color}14`, borderColor: `${a.color}45` }}
                      >
                        <AgentIcon agent={a} size={18} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold text-ink">{a.name}</span>
                          <span className="font-mono text-[10px] font-medium" style={{ color: a.color }}>
                            {a.code}
                          </span>
                          <LiveDot
                            status={status === 'failed' ? 'error' : status === 'running' ? 'running' : 'idle'}
                            className="ml-auto"
                          />
                        </div>
                        <p className="mt-0.5 text-[12px] leading-[18px] text-ink-muted">
                          {output ?? a.duty}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 最终建议 */}
            {finalResult && decision && (
              <div className="rounded-[14px] border border-brand/25 bg-brand-tint/40 p-4">
                <div className="lf-mono-label mb-1.5">ARB-05 最终建议</div>
                <p className="text-[14px] font-semibold leading-[22px] text-ink">
                  {String(decision.nextAction ?? '')}
                </p>
                <p className="mt-1 text-[12.5px] leading-[19px] text-ink-2">
                  {String(decision.reason ?? '')}
                </p>
              </div>
            )}
          </div>

          {/* 底部：深入入口 */}
          <div className="space-y-2 border-t border-hairline bg-card-warm px-5 py-4">
            <button
              type="button"
              onClick={() => go('/agents?autoplay=1')}
              className="lf-btn-primary w-full !py-2.5 text-[14px]"
            >
              看 AI 完整协同与辩论过程
              <ArrowRight size={15} />
            </button>
            <button
              type="button"
              onClick={() => go('/knowledge')}
              className="flex w-full items-center justify-center gap-2 rounded-[10px] px-4 py-2 text-[13px] font-medium text-ink-2 transition-colors hover:bg-paper-deep hover:text-ink"
            >
              <Database size={14} />
              浏览它引用的知识库
              <ChevronRight size={14} className="text-ink-muted" />
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
