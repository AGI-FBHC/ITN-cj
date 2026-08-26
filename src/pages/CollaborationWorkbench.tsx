import { CheckCircle2, ChevronLeft, ChevronRight, Eye, Loader2, MonitorPlay, Plus, ScrollText, Sparkles, Trash2, X, XCircle } from 'lucide-react';
import { api, streamAdminGenerationTask, type AdminGenerationEvent, type AdminResourceDetail, type LearningResourceGenerationTask, type RagDomain, type RagTree, type RagTreeNode } from '@/lib/api';
import { loadAdminEventCache, saveAdminEventCache } from '@/lib/adminEventCache';
import { useSearchParams } from 'react-router-dom';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { presentationApi, type PresentationRequest, type PresentationTaskSummary } from '@/lib/presentationApi';
import { useAuth } from '@/context/AuthContext';
import { toast } from 'sonner';
import ResourcePreview from '@/components/admin/ResourcePreview';
import ExecutionDetailPanel from '@/components/admin/ExecutionDetailPanel';
import { cn } from '@/lib/utils';
import planningAgentIcon from '@/assets/agents/planning.svg';
import retrievalAgentIcon from '@/assets/agents/retrieval.svg';
import generationAgentIcon from '@/assets/agents/generation.svg';
import reviewAgentIcon from '@/assets/agents/review.svg';
import arbitrationAgentIcon from '@/assets/agents/arbitration.svg';

type WorkbenchTask =
  | ({ taskKind: 'resource' } & LearningResourceGenerationTask)
  | ({ taskKind: 'ppt'; resourceType: 'ppt' } & PresentationTaskSummary);

const agents = [
  { id: 'DIA-01', name: '教学策划 Agent', duty: '目标、画像与教学蓝图', icon: planningAgentIcon },
  { id: 'RET-02', name: '知识检索 Agent', duty: '知识切片、补充资料与证据', icon: retrievalAgentIcon },
  { id: 'GEN-03', name: '内容生成 Agent', duty: '初稿生成与定向修订', icon: generationAgentIcon },
  { id: 'VER-04', name: '质量核验 Agent', duty: '结构、引用与内容一致性', icon: reviewAgentIcon },
  { id: 'ARB-05', name: '发布仲裁 Agent', duty: '通过、返工或终止', icon: arbitrationAgentIcon },
] as const;
const activeStatuses = new Set(['queued', 'retrieving', 'debating', 'planning', 'analyzing', 'generating', 'verifying', 'reviewing', 'revising', 'judging', 'outline_review']);
const typeText: Record<string, string> = { lecture: '讲义', practice: '实操指南', quiz: '题库', ppt: '交互课件' };

function eventDisplayTitle(event: AdminGenerationEvent) {
  if (event.title === '内容—证据一致性辩论完成') return '一致性辩论组';
  return event.title.replace('轻量质量检查', '质量检查').replace('轻量检查', '质量检查');
}

function isLifecycleEvent(event: AdminGenerationEvent) {
  return event.agent === 'SYSTEM' || event.actorType === 'system' || event.eventType === 'task_lifecycle'
    || ['任务已创建', '任务取消', '生成完成', '任务已结束', '任务被取消'].includes(event.title);
}


const quizMetricLabels: Record<string, string> = {
  grounding: '证据支撑', answerConfidence: '答案可信', clarity: '题意清晰',
  distractorQuality: '干扰项质量', difficultyMatch: '难度匹配',
  explanationQuality: '解析完整', overall: '综合评分',
};
const reviewModeLabels: Record<string, string> = {
  full: '完整审核', full_or_closure: '完整审核 + 定向复核', closure_only: '定向复核',
  score_only: '换题后评分', duplicate_check: '重复性检查',
};

interface QuizQuestionReviewSummary {
  number: number;
  question?: Record<string, unknown>;
  audit?: Record<string, unknown>;
  attempts: number;
  passed: boolean;
  reviewed: boolean;
  generationEvents: AdminGenerationEvent[];
  reviewEvents: AdminGenerationEvent[];
  lastEvent?: AdminGenerationEvent;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function summarizeQuizQuestions(events: AdminGenerationEvent[]): QuizQuestionReviewSummary[] {
  const grouped = new Map<number, QuizQuestionReviewSummary>();
  for (const event of events) {
    const snapshot = event.snapshot ?? {};
    const questionNumber = Number(snapshot.questionNumber ?? 0);
    if (!Number.isInteger(questionNumber) || questionNumber <= 0) continue;
    const current = grouped.get(questionNumber) ?? {
      number: questionNumber, attempts: 1, passed: false, reviewed: false,
      generationEvents: [], reviewEvents: [],
    };
    current.attempts = Math.max(current.attempts, Math.max(1, Number(snapshot.attempt) || 1));
    if (snapshot.question && typeof snapshot.question === 'object') current.question = snapshot.question as Record<string, unknown>;
    if (snapshot.questionAudit && typeof snapshot.questionAudit === 'object') current.audit = snapshot.questionAudit as Record<string, unknown>;
    if (/生成第 \d+ 题|第 \d+ 题第一版已生成/.test(event.title)) current.generationEvents.push(event);
    if (event.title.includes('核验')) current.reviewEvents.push(event);
    grouped.set(questionNumber, current);
  }
  const questions = [...grouped.values()].sort((a, b) => a.number - b.number);
  for (const question of questions) {
    const auditEvents = question.reviewEvents.filter((event) => event.snapshot?.questionAudit && typeof event.snapshot.questionAudit === 'object');
    const passedEvent = [...auditEvents].reverse().find((event) => {
      const audit = event.snapshot.questionAudit as Record<string, unknown>;
      return audit.passed === true;
    });
    question.reviewed = question.reviewEvents.length > 0;
    question.passed = question.passed || Boolean(passedEvent);
    const lastReview = question.reviewEvents.at(-1);
    const lastGenerated = [...question.generationEvents].reverse().find((event) => event.snapshot?.question && typeof event.snapshot.question === 'object');
    question.lastEvent = passedEvent ?? lastReview ?? lastGenerated;
  }
  return questions;
}

function questionDifficultyLabel(question: QuizQuestionReviewSummary): string {
  const direct = question.question?.difficultyLevel ?? question.question?.difficulty;
  if (direct != null) return String(direct);
  const fromEvent = question.generationEvents.at(-1)?.snapshot?.questionDifficulty;
  return fromEvent != null ? String(fromEvent) : '—';
}

function QuizQuestionReviewNavigator({ events, selectedSeq, onSelect }: {
  events: AdminGenerationEvent[];
  selectedSeq: number | null;
  onSelect: (event: AdminGenerationEvent) => void;
}) {
  const questions = useMemo(() => summarizeQuizQuestions(events), [events]);
  if (!questions.length) return null;
  const reviewed = questions.filter((question) => question.reviewed).length;
  const passed = questions.filter((question) => question.passed).length;
  const revised = questions.filter((question) => question.attempts > 1).length;
  return (
    <section className='mb-3 rounded-2xl border border-white/80 bg-white/55 p-3'>
      <div className='flex items-center gap-2'><h4 className='text-xs font-bold text-ink'>题库逐题审核</h4><span className='ml-auto text-[9px] font-semibold text-brand'>{questions.length} 题</span></div>
      <div className='mt-2 grid grid-cols-3 gap-1.5'>
        <div className='rounded-lg bg-white/70 px-2 py-1.5'><p className='text-[8.5px] text-ink-muted'>已核验</p><p className='mt-0.5 text-[11px] font-bold text-ink'>{reviewed}</p></div>
        <div className='rounded-lg bg-emerald-50/70 px-2 py-1.5'><p className='text-[8.5px] text-emerald-700/80'>通过</p><p className='mt-0.5 text-[11px] font-bold text-emerald-700'>{passed}</p></div>
        <div className='rounded-lg bg-ochre/5 px-2 py-1.5'><p className='text-[8.5px] text-ochre/70'>多轮处理</p><p className='mt-0.5 text-[11px] font-bold text-ochre'>{revised}</p></div>
      </div>
      <div className='mt-3 max-h-[420px] space-y-1.5 overflow-y-auto pr-1'>
        {questions.map((question) => {
          const selected = question.generationEvents.some((event) => event.seq === selectedSeq) || question.reviewEvents.some((event) => event.seq === selectedSeq);
          const lastEvent = question.lastEvent;
          const stateLabel = question.passed ? '已通过' : question.reviewed ? '待复核' : '生成中';
          return (
            <button key={question.number} type='button' disabled={!lastEvent} onClick={() => lastEvent && onSelect(lastEvent)} className={cn('block w-full rounded-xl border px-2.5 py-2 text-left transition disabled:opacity-60', selected ? 'border-brand/45 bg-brand-tint/65' : 'border-white/80 bg-white/65 hover:border-brand/30')}>
              <div className='flex items-center gap-2'><span className='flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-brand-tint font-mono text-[9px] font-bold text-brand'>{question.number}</span><span className={cn('min-w-0 flex-1 truncate text-[9.5px] font-semibold', question.passed ? 'text-emerald-700' : question.reviewed ? 'text-ochre' : 'text-ink-muted')}>{stateLabel}</span><span className='text-[8.5px] text-ink-muted'>难度 {questionDifficultyLabel(question)}</span>{question.attempts > 1 && <span className='rounded-md bg-ochre/10 px-1.5 py-0.5 text-[8px] font-bold text-ochre'>轮次 {question.attempts}</span>}<ChevronRight size={10} className='shrink-0 text-ink-muted' /></div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** 板块间弧线数据流：像素级对齐列心（测量 grid 布局含 gap），三次贝塞尔弧形过渡，流光沿弧自上而下流动 */
function FlowLink({ fromCol, toCol }: { fromCol: number; toCol: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [geom, setGeom] = useState<{ w: number; h: number; x1: number; x2: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const pad = 8;
    const gap = 8;
    const laneCount = agents.length;
    const colW = (w - pad * 2 - gap * (laneCount - 1)) / laneCount;
    const colX = (col: number) => pad + col * (colW + gap) + colW / 2;
    setGeom({ w, h, x1: colX(fromCol), x2: colX(toCol) });
  }, [fromCol, toCol]);
  const x1 = geom ? geom.x1 : 50;
  const x2 = geom ? geom.x2 : 50;
  const h = geom ? geom.h : 40;
  const path = Math.abs(x1 - x2) < 0.5
    ? 'M ' + x1 + ' 2 L ' + x1 + ' ' + (h - 2)
    : 'M ' + x1 + ' 2 C ' + x1 + ' ' + (h * 0.62) + ', ' + x2 + ' ' + (h * 0.38) + ', ' + x2 + ' ' + (h - 2);
  return (
    <div ref={ref} className="flow-enter relative h-10 w-full" aria-hidden>
      <span className="absolute -top-1 h-2 w-2 -translate-x-1/2 rounded-full bg-brand/90 shadow-[0_0_6px_rgba(78,120,96,0.9)]" style={{ left: x1 + 'px' }} />
      {geom && (
        <svg viewBox={"0 0 " + geom.w + " " + geom.h} className="absolute inset-0 block h-full w-full">
          <path d={path} fill="none" stroke="rgba(78,120,96,0.45)" strokeWidth="2.5" strokeDasharray="7 6" strokeLinecap="round" />
          <path d={path} fill="none" stroke="rgba(170, 232, 196, 0.95)" strokeWidth="3.5" className="lf-flow-glow" strokeLinecap="round" />
        </svg>
      )}
      <span className="absolute bottom-0 h-2 w-2 -translate-x-1/2 rounded-full bg-brand/90 shadow-[0_0_6px_rgba(78,120,96,0.9)]" style={{ left: x2 + 'px' }} />
    </div>
  );
}

function CollaborationRounds({ events, selectedSeq, selectedAgent, runningAgent, running, onSelect, onSelectAgent }: {
  events: AdminGenerationEvent[];
  selectedSeq: number | null;
  selectedAgent: string;
  runningAgent: string | null;
  running: boolean;
  onSelect: (event: AdminGenerationEvent) => void;
  onSelectAgent: (agentId: string) => void;
}) {
  const lifecycle = events.filter(isLifecycleEvent);
  const work = events.filter((event) => !isLifecycleEvent(event));
  const units: Array<{ agent: string; events: AdminGenerationEvent[]; round: number; isRoundStart: boolean }> = [];
  let round = 0;
  for (const event of work) {
    const previousUnit = units.at(-1);
    const repairSignal = ['revising', 'debating'].includes(event.status) || ['revising', 'debating'].includes(event.phase);
    const retryAttempt = Number(event.snapshot?.attempt ?? 1) > 1;
    const isNewRound = (repairSignal || retryAttempt) && previousUnit !== undefined && previousUnit.agent !== event.agent;
    if (isNewRound) round += 1;
    const currentUnit = units.at(-1);
    if (currentUnit?.agent === event.agent && currentUnit.round === round) currentUnit.events.push(event);
    else units.push({ agent: event.agent, events: [event], round, isRoundStart: isNewRound || units.length === 0 });
  }

  const blocks: Array<{ key: string; kind: "life" | "unit"; event?: AdminGenerationEvent; unit?: { agent: string; events: AdminGenerationEvent[]; round: number; isRoundStart: boolean } }> = [];
  if (lifecycle[0]) blocks.push({ key: "life-" + lifecycle[0].seq, kind: "life", event: lifecycle[0] });
  units.forEach((unit) => blocks.push({ key: "unit-" + unit.round + "-" + unit.agent + "-" + unit.events[0].seq, kind: "unit", unit }));
  return (
    <div className="h-full overflow-x-auto">
      <div className="relative min-w-[880px] h-full min-h-[420px] overflow-y-auto rounded-2xl border border-white/90 bg-white/40 px-2 pb-2 pt-0 shadow-[0_8px_28px_rgba(48,74,60,0.10)] backdrop-blur-xl">
        <div className="relative">
        {/* 泳道背景：内容 wrapper 内 inset-0，覆盖全部滚动内容高度 */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute inset-0 grid grid-cols-5">
            {agents.map((agent, index) => (<div key={agent.id} className={cn(index % 2 ? 'bg-[#E7F0E9]/90' : 'bg-[#F8EFDD]/95')} />))}
          </div>
          {[1, 2, 3, 4].map((i) => (<span key={i} className="absolute top-0 bottom-0 w-px bg-ink-muted/20" style={{ left: (i * 20) + '%', transform: 'translateX(-50%)' }} />))}
        </div>
        {/* 列头 = AI 教研组成员，点击进入该成员（sticky 固定顶部，仅下方流程滚动） */}
        <div className="sticky top-0 z-20 -mx-2 mb-1 border-b border-white/70 bg-[#F2EEE2]/95 px-2 pb-2 pt-2 backdrop-blur-xl shadow-[0_2px_10px_rgba(48,74,60,0.08)]">
        <div className="relative grid grid-cols-5 gap-2">
          {agents.map((agent) => {
            const own = events.some((event) => event.agent === agent.id);
            const running = runningAgent === agent.id;
            const selected = selectedAgent === agent.id;
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => onSelectAgent(agent.id)}
                className={cn('flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border backdrop-blur-md transition-all',
                  running ? 'border-brand/75 bg-brand/10 shadow-[0_4px_16px_rgba(78,120,96,0.28)]' : selected ? 'border-brand/70 bg-brand-tint/85 shadow-[0_3px_12px_rgba(78,120,96,0.25)] ring-1 ring-brand/25' : own ? 'border-emerald-200/80 bg-emerald-50/70 hover:border-brand/40 hover:bg-white/85' : 'border-dashed border-white/80 bg-white/40 hover:border-brand/30')}
                title={agent.duty}
              >
                <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-all', running ? 'border-brand/60 bg-white/95 lf-agent-live' : own ? 'border-brand/20 bg-brand-tint' : 'border-white/80 bg-white/45')}>
                  <img src={agent.icon} alt="" className={cn('h-5 w-5 object-contain transition-all', !running && !own && 'opacity-35 grayscale')} />
                </span>
                <span className={cn('truncate text-[10px] font-bold', running ? 'text-brand' : own ? 'text-ink' : 'text-ink-muted/75')}>{agent.name}</span>
              </button>
            );
          })}
        </div>
        </div>
        {/* 系统起点 + Agent 阶段板块 + 系统终点：板块间以自上而下闪烁的虚线连接（上板块底部点 → 下板块顶部点） */}
        <div className="relative pt-2">
          {blocks.map((block, index) => {
            const prevBlock = blocks[index - 1];
            const prevCol = prevBlock ? (prevBlock.kind === "life" ? (prevBlock.event === lifecycle[0] ? 0 : 4) : Math.max(0, agents.findIndex((agent) => agent.id === (prevBlock.unit ? prevBlock.unit.agent : "")))) : 0;
            const curCol = block.kind === "life" ? (block.event === lifecycle[0] ? 0 : 4) : Math.max(0, agents.findIndex((agent) => agent.id === (block.unit ? block.unit.agent : "")));
            const isLatestLive = running && runningAgent !== null && block.kind === "unit" && block.unit !== undefined && block.unit.agent === runningAgent;
            return (
              <div key={block.key} className="board-enter">
                {index > 0 && (
                  <FlowLink fromCol={prevCol} toCol={curCol} />
                )}
                {block.kind === "life" && block.event ? (
                  (function () {
                    const lifeEvent = block.event;
                    const isStart = lifeEvent === lifecycle[0];
                    return (
                      <div className="grid grid-cols-5 gap-2">
                        <button type="button" onClick={() => onSelect(lifeEvent)} className={cn("flex items-center gap-1.5 self-start rounded-lg border px-2 py-1.5 text-left", isLatestLive && "lf-block-live-card", isStart ? "col-start-1" : "col-start-5", lifeEvent.seq === selectedSeq ? "border-brand/55 bg-brand-tint/70" : "border-white/85 bg-white/70 hover:border-brand/35")}>
                          <span className={cn("h-2 w-2 shrink-0 rounded-full", isStart ? "bg-brand" : "bg-emerald-500")} />
                          <span className="truncate text-[9px] font-bold text-ink">{lifeEvent.title}</span>
                        </button>
                      </div>
                    );
                  })()
                ) : block.kind === "unit" && block.unit ? (
                  (function () {
                    const unit = block.unit;
                    const lane = Math.max(0, agents.findIndex((agent) => agent.id === unit.agent));
                    const selected = unit.events.some((event) => event.seq === selectedSeq);
                    return (
                      <div>
                        <div className="grid grid-cols-5 gap-2">
                          <div style={{ gridColumnStart: lane + 1 }} className={cn("overflow-hidden rounded-lg border p-1 shadow-[0_4px_14px_rgba(48,74,60,0.14)] backdrop-blur-md", isLatestLive && "lf-block-live-card", selected ? "border-brand/70 bg-white/95 ring-1 ring-brand/25" : "border-white/90 bg-white/75")}>
                            {unit.isRoundStart && unit.round > 0 && (
                              <div className="px-1 pt-1"><span className="rounded-full bg-ochre/15 px-1.5 py-px text-[7.5px] font-bold text-[#9A5B3C]">{'修复 ' + unit.round}</span></div>
                            )}
                            {unit.events.map((event) => {
                              const isConsistencyDebate = event.title === "内容—证据一致性辩论完成";
                              return (
                                <button key={event.seq} type="button" onClick={() => onSelect(event)} title={event.detail || event.title} className={cn("flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors", event.seq === selectedSeq ? "bg-brand-tint/80" : "hover:bg-white/70")}>
                                  <span className={cn("h-2 w-2 shrink-0 rounded-full", isConsistencyDebate ? "bg-[#6D63A8] ring-2 ring-[#6D63A8]/25" : event.seq === selectedSeq ? "bg-brand ring-2 ring-brand/25" : "bg-brand/50")} />
                                  <span className={cn("truncate text-[9.5px] font-semibold", isConsistencyDebate ? "text-[#51477F]" : "text-ink")}>{eventDisplayTitle(event)}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })()
                ) : null}
              </div>
            );
          })}
          {!units.length && lifecycle.length < 1 && <p className="relative py-6 text-center text-xs text-ink-muted">等待第一条协同事件…</p>}
        </div>
        </div>
      </div>
    </div>
  );
}

function AgentWorkflowSummary({ events, running }: { events: AdminGenerationEvent[]; running: boolean }) {
  const path = events.filter((event) => !isLifecycleEvent(event)).reduce<string[]>((result, event) => {
    if (result.at(-1) !== event.agent) result.push(event.agent);
    return result;
  }, []);
  if (!path.length) return null;
  return (
    <section className="rounded-2xl border border-white/75 bg-white/45 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[10px] font-bold text-ink-muted">本次协同路径</span>
        {path.map((agentId, index) => {
          const agent = agents.find((item) => item.id === agentId);
          const repeated = path.indexOf(agentId) !== index;
          const current = running && index === path.length - 1;
          return (
            <span key={`${agentId}-${index}`} className="contents">
              {index > 0 && <span className="text-[10px] text-ink-muted/55">→</span>}
              <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold', current ? 'border-brand/40 bg-brand-tint text-brand' : repeated ? 'border-ochre/30 bg-ochre/10 text-[#9A5B3C]' : 'border-white/85 bg-white/70 text-ink-2')}>
                {current && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />}
                {agent?.name ?? agentId}
                {repeated && <span className="text-[8px] font-bold">再次进入</span>}
              </span>
            </span>
          );
        })}
      </div>
    </section>
  );
}

function contextOf(task: WorkbenchTask): Record<string, unknown> {
  if (task.taskKind === 'ppt') return task.request?.generationContext ?? {};
  const request = task.request as (typeof task.request & { generation_context?: Record<string, unknown> }) | undefined;
  return request?.generationContext ?? request?.generation_context ?? {};
}

function taskKey(task: WorkbenchTask) { return `${task.taskKind}-${task.id}`; }

type GenKind = 'lecture' | 'practice' | 'quiz' | 'ppt';
const genKinds: [GenKind, string, string][] = [
  ['lecture', '讲义', '知识讲解'],
  ['practice', '实操指南', '步骤与任务'],
  ['quiz', '题库', '分阶测试资源'],
  ['ppt', '交互课件', '可播放的教学课件'],
];

/** 新建任务弹窗：领域 → 章节 → 知识点 级联选择，多选资源类型后创建生成任务 */

type TaskTreeNode = {
  key: string;
  label: string;
  count: number;
  tasks: WorkbenchTask[];
  children: TaskTreeNode[];
};

const taskDomainLabels: Record<string, string> = {
  agent: '智能体', mcp: 'MCP 规范', 'cs-base': '计算机基础', hello_agents: '智能体',
};

function taskTreeContext(task: WorkbenchTask) {
  const ctx = contextOf(task);
  const domainCode = String(ctx.domainCode || '未分类');
  const nodeCode = String(ctx.nodeCode || ctx.kpId || '未分组知识节点');
  const topicName = String(ctx.topicName || nodeCode);
  const groupName = String(ctx.groupName || '默认分组');
  const domainLabel = taskDomainLabels[domainCode] || domainCode;
  return { domainCode, domainLabel, nodeCode, topicName, groupName };
}

function taskTreePathKeys(task: WorkbenchTask): string[] {
  const ctx = taskTreeContext(task);
  const domainKey = `d:${ctx.domainCode}`;
  const nodeKey = `${domainKey}/n:${ctx.nodeCode}`;
  const groupKey = `${nodeKey}/g:${ctx.groupName}`;
  return [domainKey, nodeKey, groupKey];
}

function buildTaskTree(items: WorkbenchTask[]): TaskTreeNode[] {
  const roots: TaskTreeNode[] = [];
  const domains = new Map<string, TaskTreeNode>();
  const find = (map: Map<string, TaskTreeNode>, key: string, label: string, parent: TaskTreeNode | null): TaskTreeNode => {
    let node = map.get(key);
    if (!node) {
      node = { key, label, count: 0, tasks: [], children: [] };
      map.set(key, node);
      if (parent) parent.children.push(node); else roots.push(node);
    }
    return node;
  };
  items.forEach((task) => {
    const ctx = taskTreeContext(task);
    const domain = find(domains, `d:${ctx.domainCode}`, ctx.domainLabel, null);
    domain.count += 1;
    const nodeMap = new Map(domain.children.map((child) => [child.key, child]));
    const node = find(nodeMap, `${domain.key}/n:${ctx.nodeCode}`, ctx.topicName, domain);
    node.count += 1;
    const groupMap = new Map(node.children.map((child) => [child.key, child]));
    const group = find(groupMap, `${node.key}/g:${ctx.groupName}`, ctx.groupName, node);
    group.count += 1;
    group.tasks.push(task);
  });
  return roots;
}

function TaskDirectoryTree({
  nodes, level = 0, expanded, selectedKey, onToggle, renderLeaf,
}: {
  nodes: TaskTreeNode[];
  level?: number;
  expanded: Set<string>;
  selectedKey: string | null;
  onToggle: (key: string) => void;
  renderLeaf: (task: WorkbenchTask) => ReactNode;
}) {
  return <>{nodes.map((node) => {
    const isOpen = expanded.has(node.key);
    if (node.tasks.length > 0) {
      return <div key={node.key} style={{ marginLeft: level * 8 }} className="space-y-1.5"><button type="button" onClick={() => onToggle(node.key)} className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-white/60"><ChevronRight size={12} className={cn('text-ink-muted transition-transform', isOpen && 'rotate-90')} /><span className="min-w-0 flex-1 truncate text-[10.5px] font-bold text-ink">{node.label}</span><span className="rounded-full bg-brand-tint px-1.5 py-0.5 text-[8.5px] font-bold text-brand">{node.count}</span></button>{isOpen && <div className="space-y-1.5">{node.tasks.map((task) => <div key={taskKey(task)}>{renderLeaf(task)}</div>)}</div>}</div>;
    }
    return <div key={node.key} style={{ marginLeft: level * 8 }} className="space-y-1.5"><button type="button" onClick={() => onToggle(node.key)} className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-white/60"><ChevronRight size={12} className={cn('text-ink-muted transition-transform', isOpen && 'rotate-90')} /><span className="min-w-0 flex-1 truncate text-[10.5px] font-bold text-ink">{node.label}</span><span className="text-[8.5px] text-ink-muted">{node.count}</span></button>{isOpen && <TaskDirectoryTree nodes={node.children} level={level + 1} expanded={expanded} selectedKey={selectedKey} onToggle={onToggle} renderLeaf={renderLeaf} />}</div>;
  })}</>;
}
function NewTaskModal({ open, onClose, onCreate, busy }: { open: boolean; onClose: () => void; onCreate: (targets: GenKind[], ctx: { domainCode: string; nodeCode: string; topicName: string; groupName: string }) => void; busy: boolean }) {
  const [domains, setDomains] = useState<RagDomain[]>([]);
  const [domainCode, setDomainCode] = useState('');
  const [tree, setTree] = useState<RagTree | null>(null);
  const [chapterCode, setChapterCode] = useState('');
  const [kpCode, setKpCode] = useState('');
  const [selected, setSelected] = useState<Set<GenKind>>(new Set(['lecture', 'practice', 'quiz', 'ppt']));
  const [groupMode, setGroupMode] = useState<'existing' | 'new'>('existing');
  const [existingGroups, setExistingGroups] = useState<Array<{ groupName: string; types: string[] }>>([]);
  const [existingGroupName, setExistingGroupName] = useState('默认分组');
  const [newGroupName, setNewGroupName] = useState('');
  useEffect(() => {
    if (!open) return;
    void api.listRagDomains().then((items) => { setDomains(items); if (items[0]?.code) setDomainCode(items[0].code); }).catch(() => setDomains([]));
  }, [open]);
  useEffect(() => {
    if (!domainCode) { setTree(null); return; }
    setTree(null); setChapterCode(''); setKpCode('');
    void api.getRagTree(domainCode).then(setTree).catch(() => setTree(null));
  }, [domainCode]);
  useEffect(() => {
    if (!domainCode || !kpCode) { setExistingGroups([]); setExistingGroupName('默认分组'); setNewGroupName(''); return; }
    let cancelled = false;
    api.getAdminGenerationGroups(domainCode, kpCode)
      .then((result) => { if (cancelled) return; setExistingGroups(result.groups); setExistingGroupName(result.groups.some((group) => group.groupName === '默认分组') ? '默认分组' : result.groups[0]?.groupName ?? '默认分组'); })
      .catch(() => { if (!cancelled) { setExistingGroups([]); setExistingGroupName('默认分组'); } });
    return () => { cancelled = true; };
  }, [domainCode, kpCode]);
  // 章节 = 一级节点（根分类的 children；无 children 时根即章节）
  const chapters = useMemo(() => {
    const out: Array<{ node: RagTreeNode; path: string }> = [];
    for (const root of tree?.nodes ?? []) {
      if (root.children?.length) root.children.forEach((child) => out.push({ node: child, path: root.name + ' / ' + child.name }));
      else out.push({ node: root, path: root.name });
    }
    return out;
  }, [tree]);
  const chapter = chapters.find((item) => item.node.nodeCode === chapterCode) ?? null;
  const kps: RagTreeNode[] = chapter && chapter.node.children?.length ? chapter.node.children : chapter ? [chapter.node] : [];
  const kp = kps.find((item) => item.nodeCode === kpCode) ?? null;
  const effectiveGroupName = groupMode === 'new' ? (newGroupName.trim() || '默认分组') : (existingGroupName || '默认分组');
  const selectedGroup = useMemo(() => existingGroups.find((group) => group.groupName === effectiveGroupName), [existingGroups, effectiveGroupName]);
  const groupTypes = useMemo(() => new Set(selectedGroup?.types ?? []), [selectedGroup]);
  const pptReady = groupMode === 'existing' && ['lecture', 'practice', 'quiz'].every((type) => groupTypes.has(type));
  const existingGroupNames = useMemo(() => Array.from(new Set(['默认分组', ...existingGroups.map((group) => group.groupName)])), [existingGroups]);
  useEffect(() => {
    if (!kpCode) return;
    const base: GenKind[] = ['lecture', 'practice', 'quiz'];
    if (pptReady) base.push('ppt');
    setSelected(new Set(base));
  }, [kpCode, pptReady, groupMode, effectiveGroupName]);
  if (!open) return null;
  const validSelected = [...selected].filter((kind) => kind !== 'ppt' || pptReady);
  const canCreate = Boolean(kp && effectiveGroupName && validSelected.length && !busy);
  const selectCls = 'lf-select w-full';
  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-ink/35 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="lf-card w-full max-w-2xl rounded-3xl p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-tint text-brand"><Plus size={20} /></div>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-bold text-ink">新建教研任务</h3>
            <p className="mt-1 text-xs text-ink-muted">选择生成位置（领域 → 章节 → 知识点）与资源类型，结果进入机构资源库</p>
          </div>
          <button disabled={busy} onClick={onClose} className="lf-row-btn !p-2" aria-label="关闭"><X size={15} /></button>
        </div>
        <div className="mt-5 space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-ink-2">领域</span>
              <select value={domainCode} onChange={(e) => setDomainCode(e.target.value)} className={selectCls}>
                {domains.map((domain) => <option key={domain.code} value={domain.code}>{domain.name}（{domain.code}）</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-ink-2">章节</span>
              <select value={chapterCode} onChange={(e) => { setChapterCode(e.target.value); setKpCode(''); }} className={selectCls} disabled={!chapters.length}>
                <option value="">{chapters.length ? '请选择章节' : '该领域暂无章节'}</option>
                {chapters.map((item) => <option key={item.node.nodeCode} value={item.node.nodeCode}>{item.path}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-ink-2">知识点</span>
              <select value={kpCode} onChange={(e) => setKpCode(e.target.value)} className={selectCls} disabled={!kps.length}>
                <option value="">{kps.length ? '请选择知识点' : '请先选择章节'}</option>
                {kps.map((item) => <option key={item.nodeCode} value={item.nodeCode}>{item.name}</option>)}
              </select>
            </label>
          </div>
          <div>
            <p className="mb-2 text-sm font-bold text-ink">资源分组</p>
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <button type="button" disabled={!kp} onClick={() => setGroupMode('existing')} className={cn('lf-row-btn', groupMode === 'existing' && 'bg-brand text-paper border-brand')}>选择已有</button>
              <button type="button" disabled={!kp} onClick={() => setGroupMode('new')} className={cn('lf-row-btn', groupMode === 'new' && 'bg-brand text-paper border-brand')}>新建分组</button>
              {groupMode === 'existing' ? (
                <select value={existingGroupName} onChange={(e) => setExistingGroupName(e.target.value)} className="lf-select min-w-44 flex-1" disabled={!kp}>
                  {existingGroupNames.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              ) : (
                <input value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} placeholder="不输入则为默认分组" className="lf-input min-w-44 flex-1" disabled={!kp} />
              )}
            </div>
            <p className="mb-2 text-sm font-bold text-ink">资源类型</p>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {genKinds.map(([id, label, note]) => {
                const disabled = id === 'ppt' && !pptReady;
                return <button key={id} type="button" disabled={disabled} onClick={() => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} className={cn('rounded-2xl border p-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-45', selected.has(id) && !disabled ? 'border-brand/50 bg-brand-tint/70 ring-1 ring-brand/30' : 'border-white/80 bg-white/45 hover:bg-white/70')}>
                  <p className="text-sm font-bold text-ink">{label}</p>
                  <p className="mt-0.5 text-[10px] text-ink-muted">{disabled ? '需先生成讲义、实操、题库' : note}</p>
                </button>;
              })}
            </div>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2 border-t border-white/70 pt-4">
          <button disabled={busy} onClick={onClose} className="lf-row-btn">取消</button>
          <button disabled={!canCreate} onClick={() => kp && onCreate(validSelected, { domainCode, nodeCode: kp.nodeCode, topicName: kp.name, groupName: effectiveGroupName })} className="lf-row-btn lf-row-btn-primary min-w-28 justify-center disabled:opacity-50">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            创建{validSelected.length ? '（' + validSelected.length + '项）' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkbenchTaskItem({ item, selected, bulkMode, checked, onPreview, onCancel, onDelete, onClick }: { item: WorkbenchTask; selected: boolean; bulkMode: boolean; checked: boolean; onPreview?: (item: WorkbenchTask) => void; onCancel?: (item: WorkbenchTask) => void; onDelete?: (item: WorkbenchTask) => void; onClick: () => void }) {
  const active = activeStatuses.has(item.status);
  const failed = item.status === 'failed' || item.status === 'cancelled';
  const context = contextOf(item);
  const done = item.status === 'completed';
  const fillPct = done ? 100 : Math.max(3, item.progress);
  const formatTime = (iso?: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p2 = (n: number) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  };
  const timeLine = active
    ? (item.createdAt ? '开始 ' + formatTime(item.createdAt) : '')
    : (item.updatedAt ? (done ? '完成 ' : '结束 ') + formatTime(item.updatedAt) : '');
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('relative w-full overflow-hidden rounded-xl border text-left transition-all',
        selected ? 'border-brand/70 bg-white/95 shadow-[0_4px_16px_rgba(78,120,96,0.18)] ring-2 ring-brand/25' :
        failed ? 'border-rose-200/80 bg-white/70 hover:border-brand/35' :
        'border-white/80 bg-white/60 hover:border-brand/40')}
    >
      {/* 轨道：整卡底层（奶油浅色，贴合系统主题） */}
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/75 to-[#F1ECDE]/85" />
      {/* 进度填充：品牌绿半透明渐变直接铺在卡片背景上，宽度 = 进度 */}
      <span className={cn('pointer-events-none absolute inset-y-0 left-0 overflow-hidden rounded-r-xl',
        failed ? 'bg-gradient-to-r from-[#E08080]/45 to-[#F2B3A9]/40' :
        item.status === 'completed' ? 'bg-gradient-to-r from-[#5FAF7C]/50 to-[#8FD3A7]/60' :
        'bg-gradient-to-r from-[#4E7860]/40 to-[#7FB596]/50')} style={{ width: fillPct + '%' }}>
        {active && <><span className="surge" /><span className="head" /></>}
      </span>
      {/* 内容：深色文字，浅色背景上清晰可读 */}
      <span className="relative z-10 block space-y-1 p-3">
        <span className="flex items-center gap-1.5">
          {active ? <Loader2 size={12} className="shrink-0 animate-spin text-brand" /> : failed ? <XCircle size={12} className="shrink-0 text-red-500" /> : <CheckCircle2 size={12} className="shrink-0 text-emerald-600" />}
          <span className="rounded-md border border-brand/25 bg-white/70 px-1.5 py-0.5 text-[9px] font-bold text-brand">{typeText[item.resourceType]}</span>
          <span className="ml-auto text-[10px] font-bold tabular-nums text-ink">{failed ? item.progress : fillPct}%</span>
        </span>
        <span className="block truncate text-xs font-bold text-ink">{String(context.topicName || item.title)}</span>
        <span className="block line-clamp-1 text-[9.5px] leading-4 text-ink-muted">{item.stageMessage}</span>
        {timeLine && <span className="block pt-0.5 text-[9px] font-semibold tabular-nums text-ink-muted/80">{timeLine}</span>}
        {(item.status === 'completed') && (
          <span className="flex justify-end gap-1.5 pt-1">
            {bulkMode && (
              <span role="checkbox" aria-checked={checked} tabIndex={0} onClick={(event) => { event.stopPropagation(); onClick(); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); onClick(); } }} className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[9px] font-bold', checked ? 'border-brand/50 bg-brand-tint text-brand' : 'border-white/80 bg-white/80 text-ink-muted')}>
                <span className={cn('flex h-3 w-3 items-center justify-center rounded border', checked ? 'border-brand bg-brand text-paper' : 'border-ink-muted/40 bg-white')}>{checked ? '✓' : ''}</span>
                已选
              </span>
            )}
            {item.status === 'completed' && onPreview && (
              <span role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); onPreview(item); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); onPreview(item); } }} className="inline-flex items-center gap-1 rounded-md border border-brand/30 bg-white/80 px-2 py-1 text-[9px] font-bold text-brand transition-colors hover:bg-brand-tint">
                <Eye size={11} /> 预览
              </span>
            )}
            {onDelete && (
              <span role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); onDelete(item); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); onDelete(item); } }} className="inline-flex items-center gap-1 rounded-md border border-white/80 bg-white/80 px-2 py-1 text-[9px] font-bold text-ink-muted transition-colors hover:border-red-300 hover:text-red-500">
                <Trash2 size={11} /> 删除
              </span>
            )}
          </span>
        )}
        {active && onCancel && (
          <span className="flex justify-end pt-1">
            <span role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); onCancel(item); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); onCancel(item); } }} className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50/80 px-2 py-1 text-[9px] font-bold text-red-600 transition-colors hover:border-red-300 hover:bg-rose-100">
              <XCircle size={11} /> 取消任务
            </span>
          </span>
        )}
      </span>
    </button>
  );
}

/** 递归 JSON 树（深色开发者面板）：key 绿 / 字符串琥珀 / 数字蓝 / 布尔紫 / null 灰 */
function JsonTree({ value }: { value: unknown }) {
  if (value === null) return <span className="jz">null</span>;
  if (typeof value === 'string') return <span className="js">"{value}"</span>;
  if (typeof value === 'number') return <span className="jn">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="jb">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="jp">[]</span>;
    return (
      <>
        <span className="jp">[</span>
        {value.map((item, index) => (
          <div key={index} className="pl-4"><JsonTree value={item} />{index < value.length - 1 && <span className="jp">,</span>}</div>
        ))}
        <span className="jp">]</span>
      </>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return <span className="jp">{"{}"}</span>;
    return (
      <>
        <span className="jp">{'{'}</span>
        {entries.map(([key, val], index) => (
          <div key={key} className="pl-4">
            <span className="jk">"{key}"</span><span className="jp">: </span>
            <JsonTree value={val} />
            {index < entries.length - 1 && <span className="jp">,</span>}
          </div>
        ))}
        <span className="jp">{'}'}</span>
      </>
    );
  }
  return <span className="jz">—</span>;
}

const snapshotLabels: Record<string, string> = {
  activity: '正在执行', topic: '学习主题', query: '检索范围', ragCount: '知识库依据', webCount: '补充资料',
  sourceTitles: '采用的资料', coverage: '内容覆盖', acceptanceRubric: '验收标准', resourceType: '资源类型',
  chapterCount: '章节数量', stepCount: '实操步骤', questionCount: '题目数量', sourceCount: '引用来源',
  citationVerified: '引用核验', issueCount: '发现问题', issues: '问题摘要', decision: '处理决定',
  highFidelityScore: '依据充分度', fallbackUsed: '是否补充资料', knowledgeCoreCount: '知识库切片',
  debateStage: '辩论阶段', candidateSourceCount: '候选资料', contradictionCount: '矛盾数量',
  repairDirectives: '返修要求', repairSource: '返修来源', contradictions: '矛盾明细',
  questionNumber: '题目序号', questionDifficulty: '难度等级', attempt: '生成轮次',
  ruleMode: '规范应用方式', ruleCount: '生成规范', failedRuleCount: '未满足规范',
};

function readableValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.map((item) => typeof item === 'object' ? JSON.stringify(item) : String(item)).join('；') || '无';
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '—');
}

function ArtifactContentViewer({ title, kind, content, onClose }: { title: string; kind: string; content: Record<string, unknown>; onClose: () => void }) {
  const isBlueprint = kind === 'blueprint';
  const strings = (key: string) => Array.isArray(content[key]) ? (content[key] as unknown[]).map(String).filter(Boolean) : [];
  const objectives = strings('learningObjectives');
  const coverage = strings('coverage');
  const competitionFit = strings('competitionFit');
  const rubric = strings('acceptanceRubric');
  const structures = Array.isArray(content.contentStructure) ? content.contentStructure.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  const sourcePlan = Array.isArray(content.sourcePlan) ? content.sourcePlan.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  const chapters = Array.isArray(content.chapters) ? content.chapters.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  const steps = Array.isArray(content.steps) ? content.steps.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  const questions = Array.isArray(content.questions) ? content.questions.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  return <div className="fixed inset-0 z-[120] flex items-center justify-center bg-ink/25 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-[24px] border border-white/90 bg-[#F7F7F2] shadow-2xl">
      <header className="flex items-center gap-3 border-b border-ink/8 bg-white/75 px-6 py-4"><div><p className="text-[10px] font-semibold text-brand">阶段成果快照</p><h3 className="mt-1 text-base font-bold text-ink">{title}</h3></div><button type="button" onClick={onClose} className="ml-auto rounded-full bg-white p-2 text-ink-muted shadow-sm hover:text-ink"><X size={16}/></button></header>
      <div className="space-y-4 overflow-y-auto p-6">
        {isBlueprint && <><section className="rounded-2xl border border-brand/15 bg-brand-tint/35 p-5"><h4 className="text-xs font-bold text-ink">通用教学设计</h4><p className="mt-2 text-[11px] leading-6 text-ink-2">{String(content.audienceDesign ?? content.audienceGap ?? '面向机构通用学习资源组织内容')}</p></section>
        {objectives.length > 0 && <section className="rounded-2xl border border-white bg-white/75 p-5"><h4 className="text-xs font-bold text-ink">学习目标</h4><div className="mt-3 grid gap-2 sm:grid-cols-2">{objectives.map((item, index) => <div key={index} className="flex gap-2 rounded-xl bg-[#F3F5F0] p-3"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand text-[9px] font-bold text-white">{index + 1}</span><p className="text-[10.5px] leading-5 text-ink-2">{item}</p></div>)}</div></section>}
        {structures.length > 0 && <section className="rounded-2xl border border-white bg-white/75 p-5"><h4 className="text-xs font-bold text-ink">内容结构</h4><div className="mt-3 space-y-2">{structures.map((item, index) => <article key={index} className="rounded-xl bg-[#F3F5F0] p-4"><div className="flex items-center gap-2"><span className="font-mono text-[9px] font-bold text-brand">{String(index + 1).padStart(2, '0')}</span><h5 className="text-[11px] font-bold text-ink">{String(item.title ?? coverage[index] ?? `内容板块 ${index + 1}`)}</h5></div><p className="mt-2 text-[10px] leading-5 text-ink-2"><span className="font-semibold text-ink-muted">教学重点：</span>{String(item.focus ?? '围绕主题组织事实、机制和应用')}</p><p className="mt-1 text-[10px] leading-5 text-ink-2"><span className="font-semibold text-ink-muted">预期成果：</span>{String(item.expectedOutcome ?? '形成可检查的学习成果')}</p></article>)}</div></section>}
        {coverage.length > 0 && <section className="rounded-2xl border border-white bg-white/75 p-5"><h4 className="text-xs font-bold text-ink">覆盖范围</h4><div className="mt-3 flex flex-wrap gap-2">{coverage.map((item, index) => <span key={index} className="rounded-full border border-brand/15 bg-brand-tint/45 px-3 py-1.5 text-[10px] text-ink-2">{item}</span>)}</div></section>}
        {rubric.length > 0 && <section className="rounded-2xl border border-white bg-white/75 p-5"><h4 className="text-xs font-bold text-ink">验收标准</h4><div className="mt-3 space-y-2">{rubric.map((item, index) => <div key={index} className="flex items-start gap-2 rounded-xl bg-white px-3 py-2.5"><CheckCircle2 size={13} className="mt-0.5 shrink-0 text-brand"/><div><p className="text-[10.5px] font-semibold text-ink">{item}</p><p className="mt-1 text-[9.5px] leading-5 text-ink-muted">核验对应内容、证据或可观察结果是否满足该标准</p></div></div>)}</div></section>}
        {sourcePlan.length > 0 && <section className="rounded-2xl border border-white bg-white/75 p-5"><h4 className="text-xs font-bold text-ink">资料使用计划</h4><div className="mt-3 space-y-2">{sourcePlan.map((item, index) => <article key={index} className="rounded-xl bg-[#F3F5F0] p-3"><div className="flex items-center gap-2"><span className="rounded-md bg-brand-tint px-2 py-1 font-mono text-[8px] font-bold text-brand">{String(item.chunkId || item.sourceId || index + 1)}</span><p className="text-[10.5px] font-bold text-ink">{String(item.sourceTitle ?? '检索资料')}</p></div><p className="mt-2 text-[10px] leading-5 text-ink-2"><span className="font-semibold text-ink-muted">用途：</span>{String(item.purpose ?? '作为事实依据')}</p></article>)}</div></section>}
        {competitionFit.length > 0 && <section className="rounded-2xl border border-white bg-white/75 p-5"><h4 className="text-xs font-bold text-ink">应用与评价要求</h4><ul className="mt-3 space-y-2">{competitionFit.map((item, index) => <li key={index} className="flex gap-2 text-[10.5px] leading-5 text-ink-2"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand"/>{item}</li>)}</ul></section>}</>}
        {chapters.map((chapter, chapterIndex) => <section key={chapterIndex} className="rounded-2xl border border-white bg-white/75 p-5"><h4 className="text-sm font-bold text-ink">{String(chapter.title ?? `第 ${chapterIndex + 1} 章`)}</h4>{Array.isArray(chapter.sections) && <div className="mt-3 space-y-3">{chapter.sections.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')).map((section, sectionIndex) => <article key={sectionIndex} className="rounded-xl bg-[#F3F5F0] p-4"><h5 className="text-xs font-bold text-ink">{String(section.title ?? `内容 ${sectionIndex + 1}`)}</h5><p className="mt-2 whitespace-pre-wrap text-[11px] leading-6 text-ink-2">{String(section.content ?? section.summary ?? '')}</p></article>)}</div>}</section>)}
        {steps.map((step, index) => <section key={index} className="rounded-2xl border border-white bg-white/75 p-5"><div className="flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-white">{index + 1}</span><h4 className="text-sm font-bold text-ink">{String(step.title ?? `步骤 ${index + 1}`)}</h4></div><p className="mt-3 whitespace-pre-wrap text-[11px] leading-6 text-ink-2">{String(step.instruction ?? '')}</p>{Boolean(step.expectedOutput) && <div className="mt-3 rounded-xl bg-brand-tint/55 p-3"><p className="text-[9px] font-semibold text-brand">预期结果</p><p className="mt-1 text-[10.5px] leading-5 text-ink-2">{String(step.expectedOutput)}</p></div>}</section>)}
        {questions.map((question, index) => <section key={index} className="rounded-2xl border border-white bg-white/75 p-5"><h4 className="text-sm font-bold text-ink">{index + 1}. {String(question.stem ?? '')}</h4>{Array.isArray(question.options) && <div className="mt-3 grid gap-2 sm:grid-cols-2">{question.options.map((option, optionIndex) => <div key={optionIndex} className="rounded-xl bg-[#F3F5F0] px-3 py-2 text-[10.5px] text-ink-2">{String.fromCharCode(65 + optionIndex)}. {String(option)}</div>)}</div>}</section>)}
        {!isBlueprint && !chapters.length && !steps.length && !questions.length && <pre className="whitespace-pre-wrap rounded-2xl bg-white/75 p-5 text-[11px] leading-6 text-ink-2">{JSON.stringify(content, null, 2)}</pre>}
      </div>
    </section>
  </div>;
}

function InspectionModal({ title, record, onClose }: { title: string; record: Record<string, unknown>; onClose: () => void }) {
  const labels: Record<string, string> = { id: '编号', title: '标题', section: '章节', excerpt: '正文摘要', similarity: '相关度', sourceType: '来源类型', blockType: '对象类型', blockIndex: '序号', blockTitle: '对象名称', stepIndex: '步骤序号', stepTitle: '步骤名称', sourceId: '来源编号', sourceTitle: '来源名称', claim: '被核查内容', evidence: '对应依据', analysis: '分析结论', finding: '具体发现', label: '检查项目', passed: '检查结果', risk: '潜在风险', issue: '争议项', decision: '裁决', reason: '原因', requiredAction: '处理要求', repairInstruction: '返修要求', selected: '是否选中', rule_code: '规范编号', type: '规范类型', name: '规范名称', confidence: '可信度', sourceText: '来源原文', sourceSection: '来源章节', sourceDocumentId: '来源文档', sourceChunkId: '来源切片', status: '核验结果' };
  /* 短字段：徽章/进度条/编号等用两列网格紧凑展示 */
  const shortKeys = new Set(['id', 'blockIndex', 'stepIndex', 'sourceId', 'similarity', 'sourceType', 'selected', 'blockType', 'stepTitle', 'passed', 'label', 'decision', 'nodeType', 'level', 'relationType', 'role']);
  /* 长文本字段：独占整行，保持可读 */
  const textKeys = new Set(['excerpt', 'title', 'blockTitle', 'section', 'claim', 'evidence', 'analysis', 'finding', 'risk', 'issue', 'reason', 'requiredAction', 'repairInstruction', 'content', 'quote', 'problem', 'solution', 'detail']);
  const entries = Object.entries(record).filter(([, value]) => value != null && value !== '');
  const pct = (value: unknown) => Number.isFinite(Number(value)) ? Math.min(100, Math.max(0, Math.round(Number(value) * 100))) : null;
  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-ink/25 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-[24px] border border-white/90 bg-[#F7F7F2] shadow-2xl">
        <header className="flex shrink-0 items-center gap-3 border-b border-ink/8 bg-white/75 px-6 py-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-tint text-brand"><ScrollText size={16} /></span>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold text-brand">可核查记录</p>
            <h3 className="mt-0.5 truncate text-base font-bold text-ink">{title}</h3>
          </div>
          <button type="button" onClick={onClose} className="ml-auto rounded-full bg-white p-2 text-ink-muted shadow-sm hover:text-ink"><X size={16} /></button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6">
          {/* 短字段：两列网格 */}
          <div className="grid gap-3 md:grid-cols-2">
            {entries.filter(([key]) => shortKeys.has(key)).map(([key, value]) => (
              <div key={key} className="rounded-2xl border border-white bg-white/75 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[9px] font-semibold text-ink-muted">{labels[key] ?? key}</p>
                  {key === 'similarity' && pct(value) != null && (
                    <span className="rounded-full bg-brand-tint px-1.5 py-0.5 text-[9px] font-bold text-brand">{pct(value)}%</span>
                  )}
                </div>
                {key === 'similarity' && pct(value) != null ? (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white"><div className="h-full rounded-full bg-brand" style={{ width: pct(value) + '%' }} /></div>
                ) : key === 'selected' ? (
                  <span className={cn('mt-2 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-bold', value ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-white bg-white/80 text-ink-muted')}>{value ? '✓ 已采纳' : '✗ 未采纳'}</span>
                ) : key === 'passed' ? (
                  <span className={cn('mt-2 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-bold', String(value).toLowerCase().includes('pass') || value === true ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-red-600')}>{String(value)}</span>
                ) : key === 'sourceType' ? (
                  <span className="mt-2 inline-flex items-center rounded-md border border-brand/25 bg-brand-tint/50 px-2 py-0.5 text-[10px] font-bold text-brand">{readableValue(value)}</span>
                ) : (
                  <p className="mt-1 break-words font-mono text-[11px] leading-6 text-ink-2">{readableValue(value)}</p>
                )}
              </div>
            ))}
          </div>
          {/* 长文本字段：独占整行 */}
          {entries.filter(([key]) => textKeys.has(key)).map(([key, value]) => (
            <div key={key} className="rounded-2xl border border-white bg-white/75 px-4 py-3">
              <p className="text-[9px] font-semibold text-ink-muted">{labels[key] ?? key}</p>
              <p className="mt-1.5 whitespace-pre-wrap break-words text-[11.5px] leading-6 text-ink-2">{readableValue(value)}</p>
            </div>
          ))}
          {/* 未分类残留字段 */}
          {entries.filter(([key]) => !shortKeys.has(key) && !textKeys.has(key)).map(([key, value]) => (
            <div key={key} className="rounded-2xl border border-white bg-white/75 px-4 py-3">
              <p className="text-[9px] font-semibold text-ink-muted">{labels[key] ?? key}</p>
              <p className="mt-1 break-words whitespace-pre-wrap text-[11px] leading-6 text-ink-2">{readableValue(value)}</p>
            </div>
          ))}
          {!entries.length && <div className="lf-empty rounded-2xl p-8 text-center text-xs text-ink-muted">该记录没有可展示字段</div>}
        </div>
      </section>
    </div>
  );
}

export function EventDetailPanel({ event }: { event: AdminGenerationEvent }) {

  const [rawOpen, setRawOpen] = useState(false);
  const [artifactOpen, setArtifactOpen] = useState(false);
  const [inspection, setInspection] = useState<{ title: string; record: Record<string, unknown> } | null>(null);
  const snapshot = event.snapshot ?? {};
  const display = snapshot.display && typeof snapshot.display === 'object' ? snapshot.display as Record<string, unknown> : {};
  const displayRows = (key: string) => Array.isArray(display[key]) ? (display[key] as unknown[]).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  const inputs = displayRows('inputs');
  const outputs = displayRows('outputs');
  const evidence = displayRows('evidence');
  const checks = displayRows('checks');
  const actions = Array.isArray(display.actions) ? display.actions.map(String) : [];
  const artifact = display.artifact && typeof display.artifact === 'object' ? display.artifact as Record<string, unknown> : null;
  const artifactContent = snapshot.artifactContent && typeof snapshot.artifactContent === 'object' ? snapshot.artifactContent as Record<string, unknown> : null;
  const issueDetails = Array.isArray(snapshot.issueDetails) ? snapshot.issueDetails.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  const artifactItems = artifact && Array.isArray(artifact.items) ? artifact.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  const hasDisplay = Object.keys(display).length > 0;
  const debateGroup = snapshot.debateGroup && typeof snapshot.debateGroup === 'object' ? snapshot.debateGroup as Record<string, unknown> : null;
  const contradictions = Array.isArray(snapshot.contradictions) ? snapshot.contradictions.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  const supportingFindings = Array.isArray(snapshot.supportingFindings) ? snapshot.supportingFindings.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  const challengeFindings = Array.isArray(snapshot.challengeFindings) ? snapshot.challengeFindings.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  const arbitrationItems = Array.isArray(snapshot.arbitrationItems) ? snapshot.arbitrationItems.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  const question = snapshot.question && typeof snapshot.question === 'object' ? snapshot.question as Record<string, unknown> : null;
  const questionAudit = snapshot.questionAudit && typeof snapshot.questionAudit === 'object' ? snapshot.questionAudit as Record<string, unknown> : null;
  const reviewResolutions = questionAudit && Array.isArray(questionAudit.resolutions) ? questionAudit.resolutions.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  const ruleConstraints = Array.isArray(snapshot.ruleConstraints) ? snapshot.ruleConstraints.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  const ruleCheckResults = Array.isArray(snapshot.ruleCheckResults) ? snapshot.ruleCheckResults.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  const scoreRecords = questionAudit && typeof questionAudit.scores === 'object' ? questionAudit.scores as Record<string, unknown> : null;
  const scoreEntries = scoreRecords ? Object.entries(scoreRecords).filter(([, value]) => Number.isFinite(Number(value))) : [];
  const auditIssues = stringArray(questionAudit?.issues);
  const auditRiskLabels = stringArray(questionAudit?.riskLabels);
  const hardErrorRecords = recordArray(questionAudit?.hardErrors);
  const hardErrorStrings = stringArray(questionAudit?.hardErrors);
  const repairRecords = recordArray(questionAudit?.repairSuggestions);
  const repairStrings = stringArray(questionAudit?.repairSuggestions);
  const reviewMode = String(questionAudit?.reviewMode ?? snapshot.reviewMode ?? '');
  const reviewModeLabel = reviewModeLabels[reviewMode] ?? reviewMode;
  const hidden = new Set(['requestId', 'traceId', 'promptVersion', 'model', 'display', 'debateGroup', 'contradictions', 'debateTriggered', 'debateType']);
  const facts = hasDisplay ? [] : Object.entries(snapshot).filter(([key]) => !hidden.has(key));
  const decision = String(snapshot.decision ?? '');
  const decisionLabel = ({ repair: '退回定向修订', pass: '本关通过', blocked: '阻止发布' } as Record<string, string>)[String(display.decision ?? decision)] ?? readableValue(display.decision ?? decision);
  const nextStep = decision === 'repair' || snapshot.repairSource ? '交给内容生成 Agent 定向返修，完成后重新核验。'
    : decision === 'pass' ? '本关已通过，继续进入后续生成流程。' : '';
  return (
    <div className="space-y-3">
      <section className="rounded-2xl border border-white/85 bg-white/70 p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2"><span className="lf-pill lf-pill-null">{event.phase || event.status}</span><span className="ml-auto font-mono text-[9px] text-ink-muted">{event.time ? new Date(event.time).toLocaleString('zh-CN', { hour12: false }) : `记录 #${event.seq}`}</span></div>
        <h4 className="mt-3 text-sm font-bold leading-5 text-ink">{eventDisplayTitle(event)}</h4>
        {(display.summary || event.detail) && <p className="mt-2 text-[11px] leading-5 text-ink-2">{String(display.summary || event.detail)}</p>}
      </section>
      {inputs.length > 0 && <section className="rounded-2xl border border-white/80 bg-white/55 p-3"><h4 className="text-xs font-bold text-ink">收到的任务信息</h4><div className="mt-2 space-y-2">{inputs.map((item, index) => <div key={index} className="flex items-start gap-3 rounded-xl bg-white/65 px-3 py-2"><span className="shrink-0 text-[9px] font-semibold text-ink-muted">{String(item.label ?? '输入')}</span><span className="ml-auto text-right text-[10.5px] leading-5 text-ink-2">{readableValue(item.value)}</span></div>)}</div></section>}
      {actions.length > 0 && <section className="rounded-2xl border border-white/80 bg-white/55 p-3"><h4 className="text-xs font-bold text-ink">后台执行过程</h4><div className="mt-2 space-y-1.5">{actions.map((action, index) => <div key={index} className="flex items-start gap-2 text-[10.5px] leading-5 text-ink-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand"/><span>{action}</span></div>)}</div></section>}
      {evidence.length > 0 && <section className="space-y-2"><div className="flex items-center justify-between px-1"><h4 className="text-xs font-bold text-ink">取得的知识依据</h4><span className="text-[9px] text-ink-muted">采用 {evidence.length} 项</span></div>{evidence.map((item, index) => <button type="button" onClick={() => setInspection({ title: String(item.title ?? `知识依据 ${index + 1}`), record: item })} key={index} className="block w-full rounded-2xl border border-white/80 bg-white/60 p-3 text-left transition hover:border-brand/30 hover:bg-white/80"><div className="flex items-center gap-2"><span className="rounded-md bg-brand-tint px-1.5 py-0.5 font-mono text-[8px] font-bold text-brand">{String(item.id ?? index + 1)}</span><p className="min-w-0 flex-1 truncate text-[10.5px] font-bold text-ink">{String(item.title ?? '知识依据')}</p>{Number.isFinite(Number(item.similarity)) && <span className="text-[8.5px] text-ink-muted">相关度 {Math.round(Number(item.similarity) * 100)}%</span>}<ChevronRight size={11} className="text-ink-muted"/></div>{Boolean(item.section) && <p className="mt-1 text-[9px] text-ink-muted">{String(item.section)}</p>}{Boolean(item.excerpt) && <p className="mt-2 line-clamp-4 text-[10px] leading-5 text-ink-2">{String(item.excerpt)}</p>}</button>)}</section>}
      {artifact && <section className="rounded-2xl border border-brand/15 bg-brand-tint/30 p-3"><div className="flex items-center justify-between"><h4 className="text-xs font-bold text-ink">生成的数据</h4>{artifact.count != null && <span className="text-[9px] font-semibold text-brand">{String(artifact.countLabel ?? '内容')} {String(artifact.count)}</span>}</div>{Boolean(artifact.title) && <p className="mt-2 text-[11px] font-bold text-ink">{String(artifact.title)}</p>}{artifactItems.length > 0 && <div className="mt-2 space-y-2">{artifactItems.map((item, index) => <div key={index} className="rounded-xl bg-white/70 px-3 py-2"><p className="text-[10px] font-bold text-ink">{String(item.title ?? `内容 ${index + 1}`)}</p>{Boolean(item.preview) && <p className="mt-1 line-clamp-3 text-[9.5px] leading-5 text-ink-2">{String(item.preview)}</p>}</div>)}</div>}{artifactContent && <button type="button" onClick={() => setArtifactOpen(true)} className="mt-3 w-full rounded-xl border border-brand/20 bg-white/80 px-3 py-2 text-[10px] font-bold text-brand hover:border-brand/40">打开查看完整{artifact.kind === 'blueprint' ? '教学蓝图' : '阶段版本'}</button>}</section>}
      {question && <section className="rounded-2xl border border-brand/20 bg-white/70 p-4">
        <div className="flex items-center gap-2"><span className="rounded-full bg-brand-tint px-2 py-1 text-[9px] font-bold text-brand">第 {String(snapshot.questionNumber ?? '')} 题</span><span className="text-[9px] text-ink-muted">难度 {String(question.difficultyLevel ?? question.difficulty ?? '')}</span>{Boolean(question.cognitiveLevel) && <span className="text-[9px] text-ink-muted">{String(question.cognitiveLevel)}</span>}</div>
        <h4 className="mt-3 text-[12px] font-bold leading-6 text-ink">{String(question.stem ?? '')}</h4>
        {Array.isArray(question.options) && <div className="mt-3 grid gap-2">{question.options.map((option, index) => <div key={index} className={cn('rounded-xl px-3 py-2 text-[10.5px] leading-5', Number(question.correctIndex) === index ? 'bg-emerald-50 font-semibold text-emerald-800 ring-1 ring-emerald-200' : 'bg-[#F3F5F0] text-ink-2')}><span className="mr-2 font-bold">{String.fromCharCode(65 + index)}.</span>{String(option)}</div>)}</div>}
        {Boolean(question.explanation) && <div className="mt-3 rounded-xl bg-brand-tint/45 px-3 py-2"><p className="text-[9px] font-semibold text-brand">答案解析</p><p className="mt-1 text-[10.5px] leading-5 text-ink-2">{String(question.explanation)}</p></div>}
        {Array.isArray(question.answerEvidenceQuotes) && question.answerEvidenceQuotes.length > 0 && <div className="mt-3 space-y-2"><p className="text-[9px] font-semibold text-ink-muted">答案依据</p>{question.answerEvidenceQuotes.map((item, index) => { const quote = item && typeof item === 'object' ? item as Record<string, unknown> : {}; return <button type="button" key={index} onClick={() => setInspection({ title: `答案依据 ${index + 1}`, record: quote })} className="block w-full rounded-xl bg-white px-3 py-2 text-left text-[10px] leading-5 text-ink-2 hover:ring-1 hover:ring-brand/25">{String(quote.quote ?? '')}<ChevronRight size={11} className="ml-auto inline text-brand"/></button>; })}</div>}
        {(scoreEntries.length > 0 || auditRiskLabels.length > 0 || auditIssues.length > 0 || hardErrorRecords.length > 0 || hardErrorStrings.length > 0 || repairRecords.length > 0 || repairStrings.length > 0) && <div className="mt-3 rounded-xl border border-white/80 bg-white/60 p-3">
          <div className="flex flex-wrap items-center gap-2"><h4 className="text-[10px] font-bold text-ink">审核评分与风险</h4>{reviewMode && <span className="rounded-full bg-brand-tint px-2 py-0.5 text-[8px] font-bold text-brand">{reviewModeLabel}</span>}</div>
          {scoreEntries.length > 0 && <div className="mt-2 grid grid-cols-2 gap-1.5">{scoreEntries.map(([key, value]) => <div key={key} className="rounded-lg bg-[#F3F5F0] px-2 py-1.5"><p className="text-[8px] text-ink-muted">{quizMetricLabels[key] ?? key}</p><p className="mt-0.5 text-[10px] font-bold text-ink">{Math.round(Number(value))} 分</p></div>)}</div>}
          {auditRiskLabels.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{auditRiskLabels.map((label) => <span key={label} className="rounded-md bg-amber-50 px-2 py-0.5 text-[8px] font-bold text-amber-700">{label}</span>)}</div>}
          {auditIssues.length > 0 && <div className="mt-2 space-y-1">{auditIssues.map((issue) => <p key={issue} className="rounded-lg bg-ochre/10 px-2 py-1.5 text-[9px] leading-4 text-ochre">{issue}</p>)}</div>}
          {hardErrorStrings.length > 0 && <div className="mt-2 space-y-1">{hardErrorStrings.map((item) => <p key={item} className="rounded-lg bg-rose-50 px-2 py-1.5 text-[9px] leading-4 text-red-700">硬错误：{item}</p>)}</div>}
          {repairStrings.length > 0 && <div className="mt-2 space-y-1">{repairStrings.map((item) => <p key={item} className="rounded-lg bg-amber-50/80 px-2 py-1.5 text-[9px] leading-4 text-amber-800">返修建议：{item}</p>)}</div>}
          {hardErrorRecords.length > 0 && <div className="mt-2 space-y-1">{hardErrorRecords.map((item, index) => <button type="button" key={index} onClick={() => setInspection({ title: '硬错误 ' + (index + 1), record: item })} className="block w-full rounded-lg bg-rose-50 px-2 py-1.5 text-left text-[9px] leading-4 text-red-700 hover:ring-1 hover:ring-rose-200">{String(item.issue ?? item.finding ?? item.requiredAction ?? JSON.stringify(item))}<ChevronRight size={10} className="ml-auto inline" /></button>)}</div>}
          {repairRecords.length > 0 && <div className="mt-2 space-y-1">{repairRecords.map((item, index) => <button type="button" key={index} onClick={() => setInspection({ title: '返修建议 ' + (index + 1), record: item })} className="block w-full rounded-lg bg-amber-50/80 px-2 py-1.5 text-left text-[9px] leading-4 text-amber-800 hover:ring-1 hover:ring-amber-200">{String(item.suggestion ?? item.instruction ?? item.issue ?? JSON.stringify(item))}<ChevronRight size={10} className="ml-auto inline" /></button>)}</div>}
        </div>}
      </section>}
      {questionAudit && Array.isArray(questionAudit.checks) && questionAudit.checks.length > 0 && <section className="space-y-2"><div className="flex items-center justify-between px-1"><h4 className="text-xs font-bold text-ink">逐题核验记录</h4><span className={cn('text-[9px] font-bold', questionAudit.passed ? 'text-emerald-700' : 'text-ochre')}>{questionAudit.passed ? '本题通过' : '本题需返修'}</span></div>{questionAudit.checks.map((item, index) => { const check = item && typeof item === 'object' ? item as Record<string, unknown> : {}; return <button type="button" key={index} onClick={() => setInspection({ title: String(check.label ?? `核验项 ${index + 1}`), record: check })} className="block w-full rounded-2xl border border-white/80 bg-white/60 p-3 text-left transition hover:border-brand/30"><div className="flex items-center gap-2"><span className={cn('h-2 w-2 rounded-full', check.passed === false ? 'bg-ochre' : 'bg-emerald-500')}/><span className="min-w-0 flex-1 text-[10.5px] font-bold text-ink">{String(check.label ?? `核验项 ${index + 1}`)}</span><span className="text-[9px] font-semibold text-ink-muted">{check.passed === false ? '需要处理' : '通过'}</span><ChevronRight size={11} className="text-ink-muted"/></div>{Boolean(check.finding) && <p className="mt-2 line-clamp-2 text-[10px] leading-5 text-ink-2">{String(check.finding)}</p>}</button>; })}</section>}
      {reviewResolutions.length > 0 && <section className="space-y-2"><h4 className="px-1 text-xs font-bold text-ink">上一轮问题复核</h4>{reviewResolutions.map((item, index) => <button type="button" key={index} onClick={() => setInspection({ title: `原问题复核 ${index + 1}`, record: item })} className="block w-full rounded-2xl border border-white/80 bg-white/60 p-3 text-left"><div className="flex items-center gap-2"><span className={cn('h-2 w-2 rounded-full', item.resolved === false ? 'bg-ochre' : 'bg-emerald-500')}/><span className="min-w-0 flex-1 text-[10px] font-semibold text-ink">{String(item.previousIssue ?? `原问题 ${index + 1}`)}</span><span className="text-[9px] text-ink-muted">{item.resolved === false ? '仍未解决' : '已解决'}</span></div>{Boolean(item.finding) && <p className="mt-2 text-[10px] leading-5 text-ink-2">{String(item.finding)}</p>}</button>)}</section>}
      {ruleConstraints.length > 0 && <section className="space-y-2"><div className="flex items-center justify-between px-1"><h4 className="text-xs font-bold text-ink">本次采用的生成规范</h4><span className="text-[9px] text-ink-muted">任务开始时已固定 · {ruleConstraints.length} 条</span></div>{ruleConstraints.map((item, index) => <button type="button" key={index} onClick={() => setInspection({ title: String(item.name ?? item.rule_code ?? `生成规范 ${index + 1}`), record: item })} className="block w-full rounded-2xl border border-brand/15 bg-brand-tint/25 p-3 text-left transition hover:border-brand/35"><div className="flex items-center gap-2"><span className={cn('rounded-md px-2 py-0.5 text-[8px] font-bold', item.type === 'MUST_NOT' ? 'bg-rose-50 text-red-600' : item.type === 'MUST' ? 'bg-brand text-white' : 'bg-white text-brand')}>{String(item.type ?? '规范')}</span><p className="min-w-0 flex-1 text-[10.5px] font-bold text-ink">{String(item.content ?? item.name ?? '生成要求')}</p><ChevronRight size={11} className="text-brand"/></div>{Boolean(item.sourceSection ?? item.source) && <p className="mt-2 text-[9px] text-ink-muted">来源：{String(item.sourceSection ?? item.source)}</p>}</button>)}</section>}
      {ruleCheckResults.length > 0 && <section className="space-y-2"><div className="flex items-center justify-between px-1"><h4 className="text-xs font-bold text-ink">生成规范核验</h4><span className="text-[9px] text-ink-muted">逐条核对</span></div>{ruleCheckResults.map((item, index) => { const passed = item.status === 'PASS'; return <button type="button" key={index} onClick={() => setInspection({ title: String(item.rule_code ?? `规范核验 ${index + 1}`), record: { ...item, passed } })} className="block w-full rounded-2xl border border-white/80 bg-white/60 p-3 text-left transition hover:border-brand/30"><div className="flex items-center gap-2"><span className={cn('h-2 w-2 rounded-full', passed ? 'bg-emerald-500' : 'bg-ochre')}/><span className="min-w-0 flex-1 font-mono text-[10px] font-bold text-ink">{String(item.rule_code ?? `规范 ${index + 1}`)}</span><span className={cn('text-[9px] font-semibold', passed ? 'text-emerald-700' : 'text-ochre')}>{passed ? '已满足' : '需要关注'}</span><ChevronRight size={11} className="text-ink-muted"/></div><p className="mt-2 line-clamp-2 text-[10px] leading-5 text-ink-2">{String(item.evidence ?? item.reason ?? '等待具体核验结论')}</p></button>; })}</section>}
      {issueDetails.length > 0 && <section className="space-y-2"><div className="flex items-center justify-between px-1"><h4 className="text-xs font-bold text-ink">具体问题项</h4><span className="text-[9px] font-semibold text-ochre">共 {issueDetails.length} 项</span></div>{issueDetails.map((item, index) => { const objectType = String(item.blockType ?? '步骤'); const objectIndex = String(item.blockIndex ?? item.stepIndex ?? index + 1); const objectTitle = String(item.blockTitle ?? item.stepTitle ?? `${objectType} ${objectIndex}`); return <button type="button" onClick={() => setInspection({ title: `${objectType} ${objectIndex}：${objectTitle}`, record: item })} key={index} className="block w-full rounded-2xl border border-ochre/20 bg-ochre/5 p-3 text-left transition hover:border-ochre/40 hover:bg-ochre/10"><div className="flex items-center gap-2"><span className="rounded-full bg-ochre/15 px-2 py-0.5 text-[8px] font-bold text-ochre">{objectType} {objectIndex}</span><h5 className="min-w-0 flex-1 truncate text-[10.5px] font-bold text-ink">{objectTitle}</h5><ChevronRight size={11} className="text-ochre"/></div>{Boolean(item.excerpt ?? item.claim) && <p className="mt-2 line-clamp-2 text-[10px] leading-5 text-ink-2">{String(item.excerpt ?? item.claim)}</p>}<p className="mt-1 text-[10px] leading-5 text-ochre"><span className="font-semibold">问题：</span>{String(item.reason ?? '缺少可核查依据')}</p></button>; })}</section>}
      {outputs.length > 0 && <section className="rounded-2xl border border-white/80 bg-white/55 p-3"><h4 className="text-xs font-bold text-ink">本次产出</h4><div className="mt-2 space-y-2">{outputs.map((item, index) => artifactContent ? <button type="button" onClick={() => setArtifactOpen(true)} key={index} className="block w-full rounded-xl bg-white/65 px-3 py-2 text-left transition hover:bg-white/90"><div className="flex items-center gap-2"><p className="text-[9px] font-semibold text-ink-muted">{String(item.label ?? '产出')}</p><ChevronRight size={11} className="ml-auto text-ink-muted"/></div><p className="mt-1 line-clamp-3 text-[10.5px] leading-5 text-ink-2">{readableValue(item.value)}</p></button> : <div key={index} className="rounded-xl bg-white/65 px-3 py-2"><p className="text-[9px] font-semibold text-ink-muted">{String(item.label ?? '产出')}</p><p className="mt-1 text-[10.5px] leading-5 text-ink-2">{readableValue(item.value)}</p></div>)}</div></section>}
      {debateGroup && <section className="rounded-2xl border border-[#6D63A8]/20 bg-[#F2F0FF]/70 p-4">
        <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#6D63A8]"/><h4 className="text-xs font-bold text-[#51477F]">一致性评议记录</h4><span className="ml-auto rounded-full bg-white/80 px-2 py-1 text-[9px] font-semibold text-[#51477F]">{debateGroup.status === 'running' ? '核对中' : '已裁决'}</span></div>
        <div className="mt-3 grid grid-cols-2 gap-2"><div className="rounded-xl bg-white/65 px-3 py-2"><p className="text-[9px] text-ink-muted">仲裁结果</p><p className="mt-1 text-[11px] font-bold text-ink">{decision === 'repair' ? '发现矛盾，需要返修' : decision === 'pass' ? '未发现直接矛盾' : event.detail || '等待裁决'}</p></div><div className="rounded-xl bg-white/65 px-3 py-2"><p className="text-[9px] text-ink-muted">矛盾数量</p><p className="mt-1 text-[11px] font-bold text-ink">{Number(snapshot.contradictionCount ?? contradictions.length)} 处</p></div></div>
        {(supportingFindings.length > 0 || challengeFindings.length > 0 || arbitrationItems.length > 0) && <div className="mt-3 space-y-2">{[
          ['已核实内容', supportingFindings, 'text-emerald-700', 'bg-emerald-50'], ['质疑与风险', challengeFindings, 'text-ochre', 'bg-ochre/5'], ['逐项裁决', arbitrationItems, 'text-[#51477F]', 'bg-white/65'],
        ].map(([label, records, color, background]) => (records as Record<string, unknown>[]).length > 0 && <div key={String(label)}><p className={cn('mb-1.5 text-[9px] font-bold', color as string)}>{String(label)} · {(records as Record<string, unknown>[]).length} 项</p><div className="space-y-1.5">{(records as Record<string, unknown>[]).map((item, index) => <button type="button" key={index} onClick={() => setInspection({ title: `${String(label)} ${index + 1}`, record: item })} className={cn('flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition hover:ring-1 hover:ring-[#6D63A8]/25', background as string)}><span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-ink">{String(item.claim ?? item.issue ?? item.analysis ?? `${String(label)} ${index + 1}`)}</span><span className="text-[8px] text-ink-muted">查看依据</span><ChevronRight size={11} className="text-[#51477F]"/></button>)}</div></div>)}</div>}
        {nextStep && <div className="mt-2 rounded-xl bg-white/65 px-3 py-2"><p className="text-[9px] text-ink-muted">下一步</p><p className="mt-1 text-[11px] leading-5 text-ink-2">{nextStep}</p></div>}
      </section>}
      {contradictions.length > 0 && <section className="space-y-2"><h4 className="px-1 text-xs font-bold text-ink">需要返修的矛盾</h4>{contradictions.map((item, index) => <button type="button" onClick={() => setInspection({ title: `矛盾项 ${index + 1}`, record: item })} key={index} className="block w-full rounded-2xl border border-ochre/20 bg-ochre/5 p-3 text-left transition hover:border-ochre/40"><div className="flex items-center gap-2"><p className="min-w-0 flex-1 text-[10px] font-bold text-ink">{index + 1}. {String(item.claim ?? '待修正表述')}</p><ChevronRight size={11} className="text-ochre"/></div>{Boolean(item.reason) && <p className="mt-1 line-clamp-2 text-[10px] leading-5 text-ink-2">{String(item.reason)}</p>}</button>)}</section>}
      {(checks.length > 0 || Boolean(display.decision) || Boolean(display.nextStep)) && <section className="rounded-2xl border border-white/80 bg-white/55 p-3"><h4 className="text-xs font-bold text-ink">检查结论与下一步</h4>{checks.length > 0 && <div className="mt-2 space-y-1.5">{checks.map((item, index) => <div key={index} className="flex items-center gap-2 text-[10px] text-ink-2"><span className={cn('h-2 w-2 rounded-full', item.passed === false ? 'bg-ochre' : 'bg-emerald-500')}/><span>{String(item.label ?? '检查项')}</span><span className="ml-auto text-[9px] font-semibold text-ink-muted">{item.passed === false ? '需要处理' : '通过'}</span></div>)}</div>}{Boolean(display.decision) && <div className="mt-2 rounded-xl bg-white/65 px-3 py-2"><p className="text-[9px] text-ink-muted">处理决定</p><p className="mt-1 text-[10.5px] font-semibold text-ink">{decisionLabel}</p></div>}{Boolean(display.nextStep) && <div className="mt-2 rounded-xl bg-brand-tint/50 px-3 py-2"><p className="text-[9px] text-ink-muted">下一步</p><p className="mt-1 text-[10.5px] leading-5 text-ink-2">{String(display.nextStep)}</p></div>}</section>}
      {facts.length > 0 && <section className="space-y-2"><h4 className="px-1 text-xs font-bold text-ink">本次执行记录</h4>{facts.map(([key, value]) => <div key={key} className="rounded-xl border border-white/70 bg-white/55 px-3 py-2.5"><p className="text-[9px] font-semibold text-ink-muted">{snapshotLabels[key] ?? key}</p><p className="mt-1 whitespace-pre-wrap break-words text-[10.5px] leading-5 text-ink-2">{readableValue(value)}</p></div>)}</section>}
      <button type="button" onClick={() => setRawOpen((open) => !open)} className="flex w-full items-center justify-between rounded-xl border border-white/70 bg-white/35 px-3 py-2.5 text-[10px] font-semibold text-ink-muted hover:bg-white/55"><span>原始执行记录</span><ChevronRight size={12} className={cn('transition-transform', rawOpen && 'rotate-90')} /></button>
      {rawOpen && <div className="lf-json p-3.5 text-[11px] leading-[1.65]"><JsonTree value={{ seq: event.seq, agent: event.agentName || event.agent, stage: event.phase || event.status, time: event.time, title: event.title, detail: event.detail, snapshot }} /></div>}
      {artifactOpen && artifactContent && <ArtifactContentViewer title={String(artifact?.title ?? eventDisplayTitle(event))} kind={String(artifact?.kind ?? snapshot.resourceType ?? '')} content={artifactContent} onClose={() => setArtifactOpen(false)} />}
      {inspection && <InspectionModal title={inspection.title} record={inspection.record} onClose={() => setInspection(null)} />}
    </div>
  );
}

export default function CollaborationWorkbench() {
  const { session } = useAuth();
  const isAdmin = session?.roles?.includes('admin') === true;
  const [params, setParams] = useSearchParams();
  const [tasks, setTasks] = useState<WorkbenchTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<AdminGenerationEvent[]>([]);
  const prevTaskStatusRef = useRef<Map<string, string>>(new Map());
  const [selectedAgent, setSelectedAgent] = useState('');
  const [selectedEventSeq, setSelectedEventSeq] = useState<number | null>(null);
  const [summaryLoadingSeq, setSummaryLoadingSeq] = useState<number | null>(null);
  const [taskTab, setTaskTab] = useState('active');
  const [tasksCollapsed, setTasksCollapsed] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskBusy, setNewTaskBusy] = useState(false);
  const [deletedKeys, setDeletedKeys] = useState<string[]>(() => { try { const raw = localStorage.getItem('wb.deletedTasks'); return raw ? JSON.parse(raw) as string[] : []; } catch { return []; } });
  const deletedKeysRef = useRef(deletedKeys);
  deletedKeysRef.current = deletedKeys;
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [expandedTaskKeys, setExpandedTaskKeys] = useState<Set<string>>(new Set());
  const previousTaskKeysRef = useRef<Set<string>>(new Set());
  const [previewDetail, setPreviewDetail] = useState<AdminResourceDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const selectedKey = params.get('task');
  const loadInFlightRef = useRef(false);
  const streamBufferRef = useRef<AdminGenerationEvent[]>([]);
  const streamFlushTimerRef = useRef<number | null>(null);
  const backfillTriggeredRef = useRef<Set<string>>(new Set());

  const load = async () => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    try {
    const resources = await api.listLearningResourceTasks(100, true);
    const resourceTasks: WorkbenchTask[] = resources.tasks
      .filter((task) => !isAdmin || contextOf({ ...task, taskKind: 'resource' }).adminGeneration === true)
      .map((task) => ({ ...task, taskKind: 'resource' as const }));
    let pptTasks: WorkbenchTask[] = [];
    if (isAdmin) {
      const presentations = await presentationApi.listPresentationSummariesFresh(100, true);
      pptTasks = presentations.tasks.filter((task) => task.request?.generationContext?.adminGeneration === true)
        .map((task) => ({ ...task, taskKind: 'ppt' as const, resourceType: 'ppt' as const }));
    }
    const next = [...resourceTasks, ...pptTasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const visible = next.filter((item) => !deletedKeysRef.current.includes(taskKey(item)));
    setTasks(visible);
    /* 新建任务后自动切换到最新任务泳道：列表最上方出现此前未见过的任务即为新增 */
    const newest = visible[0];
    const newestKey = newest ? taskKey(newest) : null;
    if (newestKey && !previousTaskKeysRef.current.has(newestKey) && !(newestKey === selectedKey)) {
      setParams({ task: newestKey });
    } else if (newestKey && !selectedKey) {
      setParams({ task: newestKey }, { replace: true });
    }
    visible.forEach((item) => {
      const key = taskKey(item);
      const prev = prevTaskStatusRef.current.get(key);
      if (prev && activeStatuses.has(prev) && (item.status === 'failed' || item.status === 'cancelled')) {
        toast.error((String(contextOf(item).topicName || item.title).slice(0, 40)) + ' 生成' + (item.status === 'cancelled' ? '已取消' : '失败') + '，详见该任务详情');
      }
      prevTaskStatusRef.current.set(key, item.status);
    });
    previousTaskKeysRef.current = new Set(visible.map((item) => taskKey(item)));
    setLoading(false);
    } finally {
      loadInFlightRef.current = false;
    }
  };

  /** 新建任务：按知识目标创建多类资源生成任务 */
  const createGeneration = async (targets: GenKind[], ctx: { domainCode: string; nodeCode: string; topicName: string; groupName: string }) => {
    setNewTaskBusy(true);
    try {
      const results = await Promise.allSettled(targets.map(async (target) => {
        if (target === 'ppt') {
          const request: PresentationRequest = {
            requirement: '围绕“' + ctx.topicName + '”生成一份面向学习者的完整交互课件，内容准确、结构清晰，并适合课堂讲解与自主学习。',
            title: ctx.topicName, audience: 'students', purpose: 'courseware', style: 'education', backgroundStyle: 'blue-white-minimal',
            language: 'zh-CN', slideCount: 0, aspectRatio: '16:9', detailLevel: 'detailed', includeSpeakerNotes: true,
            modelProvider: 'mimo', generationMode: 'template',
            generationContext: { adminGeneration: true, domainCode: ctx.domainCode, nodeCode: ctx.nodeCode, kpId: ctx.nodeCode, topicName: ctx.topicName, groupName: ctx.groupName },
          };
          const task = await presentationApi.createPresentation(request);
          return { ...task, taskKind: 'ppt' as const, resourceType: 'ppt' as const } as WorkbenchTask;
        } else {
          const task = await api.startLearningResourceTask(target, {
            topic: ctx.topicName, title: ctx.topicName + ' · ' + typeText[target], kpId: ctx.nodeCode, detailLevel: 'detailed',
            questionCount: target === 'quiz' ? 12 : undefined,
            generationContext: { adminGeneration: true, domainCode: ctx.domainCode, nodeCode: ctx.nodeCode, kpId: ctx.nodeCode, topicName: ctx.topicName, groupName: ctx.groupName },
          });
          return { ...task, taskKind: 'resource' as const } as WorkbenchTask;
        }
      }));
      const failed = results.filter((result) => result.status === 'rejected').length;
      const created = results
        .filter((result): result is PromiseFulfilledResult<WorkbenchTask> => result.status === 'fulfilled')
        .map((result) => result.value);
      const createdKeys = new Set(created.map(taskKey));
      if (createdKeys.size) {
        setDeletedKeys((current) => {
          const next = current.filter((key) => !createdKeys.has(key));
          try { localStorage.setItem('wb.deletedTasks', JSON.stringify(next)); } catch { /* ignore */ }
          return next;
        });
        // POST 已经返回了完整任务，先即时展示；后台列表同步只负责校准状态。
        setTasks((current) => {
          const byKey = new Map(current.map((item) => [taskKey(item), item]));
          created.forEach((item) => byKey.set(taskKey(item), item));
          return [...byKey.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        });
        const newest = created.at(-1);
        if (newest) setParams({ task: taskKey(newest) });
      }
      if (failed) toast.error(failed + ' 项任务创建失败');
      if (failed < results.length) toast.success('已创建 ' + (results.length - failed) + ' 项生成任务');
      setNewTaskOpen(false);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '任务创建失败');
    } finally {
      setNewTaskBusy(false);
    }
  };

  /** 从列表移除任务记录（仅清空列表，不删除资源）：本地持久化删除标记 */
  const removeTask = (keys: string[]) => {
    setDeletedKeys((current) => {
      const next = Array.from(new Set([...current, ...keys]));
      try { localStorage.setItem('wb.deletedTasks', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    setTasks((current) => current.filter((item) => !keys.includes(taskKey(item))));
    toast.success(keys.length + ' 条任务记录已从列表移除');
  };
  const deleteTask = async (item: WorkbenchTask) => {
    const finished = item.status === 'completed';
    const msg = finished
      ? '确定将该任务从列表中移除吗？\n（已完成任务仅移出列表，不影响已生成的资源）'
      : '确定永久删除该未完成任务吗？\n（将终止执行并删除其对应的所有任务数据）';
    if (!window.confirm(msg)) return;
    if (!finished) {
      try {
        if (item.taskKind === 'ppt') await presentationApi.deletePresentation(item.id);
        else await api.deleteLearningResourceTask(item.id);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '任务数据删除失败');
        return;
      }
      toast.success('任务及其数据已删除');
    }
    removeTask([taskKey(item)]);
  };
  const bulkDelete = () => {
    if (!bulkSelected.size) return;
    if (!window.confirm('确定将选中的 ' + bulkSelected.size + ' 条任务记录从列表移除吗？\n（仅移除记录，不影响已生成的资源）')) return;
    removeTask([...bulkSelected]);
    setBulkSelected(new Set());
    setBulkMode(false);
  };
  /** 取消正在进行的任务 */
  const cancelTask = async (item: WorkbenchTask) => {
    if (!window.confirm('确定取消该任务吗？')) return;
    try {
      if (item.taskKind === 'ppt') await presentationApi.cancelPresentation(item.id);
      else await api.cancelLearningResourceTask(item.id);
      toast.success('已取消生成任务');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '取消失败');
    }
  };

  /** 已完成任务：预览已生成内容（学习资源按 resourceId，课件拉 outline 构造） */
  const openPreview = async (item: WorkbenchTask) => {
    setPreviewLoading(true);
    setPreviewDetail(null);
    try {
      if (item.taskKind === 'resource' && item.resourceId) {
        setPreviewDetail(await api.getAdminGenerationResource(item.resourceId));
      } else if (item.taskKind === 'ppt') {
        const detail = await presentationApi.getPresentation(item.id);
        setPreviewDetail({
          id: item.id, type: 'ppt', title: detail.title || item.title, topic: '', scope: 'ORGANIZATION',
          reviewStatus: 'PUBLISHED', revision: 1, domainCode: '', nodeCode: '', baseResourceId: null,
          learnerId: null, kpId: null, createdAt: detail.createdAt, updatedAt: detail.updatedAt,
          groupName: null,
          archivedAt: null, archiveReason: null, ownerAccount: null,
          content: detail.request ?? {}, sources: [], decision: detail.outline ?? null,
        } as unknown as AdminResourceDetail);
      } else {
        toast.info('该任务还没有关联的已生成资源');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '预览失败');
    } finally {
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    void load().catch(() => setLoading(false));
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void load().catch(() => undefined);
    }, 6000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const task = tasks.find((item) => taskKey(item) === selectedKey) ?? null;
  useEffect(() => {
    if (!selectedKey) return;
    const selected = tasks.find((item) => taskKey(item) === selectedKey);
    if (!selected) return;
    setExpandedTaskKeys((current) => new Set([...current, ...taskTreePathKeys(selected)]));
  }, [selectedKey, tasks]);
  useEffect(() => {
    if (!task) return;
    setEvents([]); setSelectedAgent(''); setSelectedEventSeq(null);
    const controller = new AbortController();
    const taskKind = task.taskKind;
    const taskId = task.id;
    let disposed = false;
    void loadAdminEventCache(taskKind, taskId).then((cached) => {
      if (disposed || !cached.length) return;
      setEvents((current) => {
        const bySeq = new Map(current.map((item) => [item.seq, item]));
        cached.forEach((item) => bySeq.set(item.seq, item));
        return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      });
    }).catch(() => undefined);
    const flush = () => {
      streamFlushTimerRef.current = null;
      const buffered = streamBufferRef.current;
      streamBufferRef.current = [];
      if (!buffered.length) return;
      setEvents((current) => {
        const bySeq = new Map(current.map((item) => [item.seq, item]));
        buffered.forEach((item) => bySeq.set(item.seq, item));
        const next = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
        void saveAdminEventCache(taskKind, taskId, next).catch(() => undefined);
        return next;
      });
    };
    const queueEvent = (event: AdminGenerationEvent) => {
      streamBufferRef.current.push(event);
      if (streamFlushTimerRef.current !== null) return;
      streamFlushTimerRef.current = window.setTimeout(flush, 160);
    };
    void streamAdminGenerationTask(taskKind, taskId, queueEvent, controller.signal)
      .finally(flush)
      .catch(() => undefined);
    return () => {
      disposed = true;
      controller.abort();
      if (streamFlushTimerRef.current !== null) {
        window.clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
      streamBufferRef.current = [];
    };
  }, [task?.id, task?.taskKind]);
  useEffect(() => {
    if (!task) return;
    const key = `s:${task.taskKind}:${task.id}`;
    if (backfillTriggeredRef.current.has(key)) return;
    backfillTriggeredRef.current.add(key);
    void api.backfillAdminGenerationEventSummaries(task.taskKind, task.id).catch(() => undefined);
  }, [task?.id, task?.taskKind]);
  useEffect(() => {
    if (!task || !['completed', 'failed', 'cancelled'].includes(task.status)) return;
    const key = `t:${task.taskKind}:${task.id}`;
    if (backfillTriggeredRef.current.has(key)) return;
    backfillTriggeredRef.current.add(key);
    void api.backfillAdminGenerationEventSummaries(task.taskKind, task.id).catch(() => undefined);
  }, [task?.id, task?.status]);
  const quizQuestions = useMemo(() => summarizeQuizQuestions(events), [events]);
  const isQuizTask = task?.taskKind === 'resource' && task.resourceType === 'quiz';

  const latest = events.at(-1);
  const effectiveAgent = selectedAgent || latest?.agent || agents[0].id;
  const agentEvents = events.filter((event) => event.agent === effectiveAgent);
  const active = Boolean(task && activeStatuses.has(task.status) && (!latest || activeStatuses.has(latest.status)));
  const selectedEvent = events.find((event) => event.seq === selectedEventSeq) ?? (isQuizTask && !selectedAgent ? quizQuestions[0]?.lastEvent ?? agentEvents.at(-1) : agentEvents.at(-1));
  const selectedEventIsRunning = Boolean(task && active && latest && selectedEvent && selectedEvent.seq === latest.seq);
  const selectGenerationEvent = async (event: AdminGenerationEvent, keepAgent = false) => {
    setSelectedEventSeq(event.seq);
    if (!keepAgent) setSelectedAgent(event.agent);
    const needsQuizRefresh = Boolean(event.snapshot?.questionAudit && event.executionSummary && /(上一节点|下一节点)/.test(event.executionSummary));
    if (!task || summaryLoadingSeq === event.seq) return;
    if (!event.executionSummary || needsQuizRefresh) {
      setSummaryLoadingSeq(event.seq);
      try {
        const result = await api.summarizeAdminGenerationEvent(task.taskKind, task.id, event.seq, needsQuizRefresh);
        setEvents((current) => {
          const next = current.map((item) => item.seq === event.seq ? { ...item, executionSummary: result.summary } : item);
          void saveAdminEventCache(task.taskKind, task.id, next).catch(() => undefined);
          return next;
        });
      } catch {
        // 摘要生成失败时保留已有事件，用户仍可查看原始 JSON。
      } finally {
        setSummaryLoadingSeq(null);
      }
    }
  };
  const grouped = useMemo(() => ({ active: tasks.filter((item) => activeStatuses.has(item.status)), finished: tasks.filter((item) => !activeStatuses.has(item.status)) }), [tasks]);
  const currentTasks = taskTab === 'active' ? grouped.active : grouped.finished;
  const taskTree = useMemo(() => buildTaskTree(currentTasks), [currentTasks]);


  return (
    <div className="lf-anim-in-up flex h-full min-h-0 flex-col gap-4 lg:flex-row">
      {/* 第一列：AI 教研任务（可折叠） */}
      <aside className={cn('flex w-full shrink-0 flex-col rounded-2xl border border-white/70 bg-white/45 transition-all duration-300 lg:w-[290px]', tasksCollapsed && 'lg:w-0 lg:min-w-0 lg:overflow-hidden lg:border-none lg:bg-transparent lg:p-0 lg:gap-0')}>
        <div className="flex items-center gap-2 border-b border-white/70 p-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-paper"><Sparkles size={15} /></span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-ink">AI 教研任务</h3>
            <p className="mt-0.5 truncate text-[9.5px] text-ink-muted">{grouped.active.length + grouped.finished.length} 项 · 自动同步</p>
          </div>
          <button onClick={() => setNewTaskOpen(true)} className="lf-row-btn lf-row-btn-primary !px-2.5 !py-1.5"><Plus size={12} />新建任务</button>
        </div>
        {/* 进行中 / 已完成 切换 */}
        <div className="border-b border-white/70 p-2.5">
          <div className="flex gap-1 rounded-xl bg-white/55 p-1">
            <button onClick={() => setTaskTab('active')} className={cn('flex-1 rounded-lg px-2 py-1.5 text-[11px] font-bold transition-colors', taskTab === 'active' ? 'bg-brand text-paper shadow-sm' : 'text-ink-muted hover:text-ink')}>进行中 {grouped.active.length}</button>
            <button onClick={() => setTaskTab('finished')} className={cn('flex-1 rounded-lg px-2 py-1.5 text-[11px] font-bold transition-colors', taskTab === 'finished' ? 'bg-brand text-paper shadow-sm' : 'text-ink-muted hover:text-ink')}>已完成 {grouped.finished.length}</button>
          </div>
        </div>
        {/* 批量操作：已完成 tab 下可删除多条记录 */}
        {taskTab === 'finished' && grouped.finished.length > 0 && (
          <div className="flex items-center justify-between border-b border-white/70 px-3 py-2">
            {!bulkMode ? (
              <button onClick={() => setBulkMode(true)} className="lf-row-btn !px-2.5 !py-1.5" title="删除多条已完成任务记录（仅列表，不影响资源）">
                <Trash2 size={12} /> 批量删除
              </button>
            ) : (
              <div className="flex w-full items-center gap-2">
                <button onClick={() => { setBulkSelected(bulkSelected.size === grouped.finished.length ? new Set() : new Set(grouped.finished.map((item) => taskKey(item)))); }} className="lf-row-btn !px-2.5 !py-1.5">
                  {bulkSelected.size === grouped.finished.length ? '取消全选' : '全选'}
                </button>
                <button onClick={() => bulkDelete()} disabled={!bulkSelected.size} className="lf-row-btn lf-row-btn-primary !px-2.5 !py-1.5 disabled:opacity-50">
                  <Trash2 size={12} /> 删除所选（{bulkSelected.size}）
                </button>
                <button onClick={() => { setBulkMode(false); setBulkSelected(new Set()); }} className="lf-row-btn !px-2.5 !py-1.5 text-ink-muted">退出</button>
              </div>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          <div className="space-y-2">
            <TaskDirectoryTree nodes={taskTree} expanded={expandedTaskKeys} selectedKey={selectedKey} onToggle={(key) => setExpandedTaskKeys((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} renderLeaf={(item) => <WorkbenchTaskItem key={taskKey(item)} item={item} selected={taskKey(item) === selectedKey} bulkMode={bulkMode && taskTab === 'finished'} checked={bulkSelected.has(taskKey(item))} onPreview={(task) => void openPreview(task)} onCancel={(task) => void cancelTask(task)} onDelete={(task) => deleteTask(task)} onClick={() => { if (bulkMode && taskTab === 'finished') { setBulkSelected((current) => { const next = new Set(current); if (next.has(taskKey(item))) next.delete(taskKey(item)); else next.add(taskKey(item)); return next; }); } else { setParams({ task: taskKey(item) }); } }} />} />
            {currentTasks.length === 0 && (
              <div className="lf-empty rounded-xl p-6 text-xs">{taskTab === 'active' ? '暂无进行中的任务' : '暂无已完成任务'}</div>
            )}
          </div>
        </div>
      </aside>

      {/* 第二列：Agents 教研组协作泳道（主体，占最多空间） */}
      <main className="flex min-w-0 flex-1 flex-col rounded-2xl border border-white/70 bg-[#f7f5ee]/75">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/70 px-4 py-3">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setTasksCollapsed((collapsed) => !collapsed)} className="lf-row-btn !p-1.5" title={tasksCollapsed ? '展开任务栏' : '收起任务栏'}>
              {tasksCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            </button>
            <div>
              <h3 className="text-sm font-bold text-ink">Agents 教研组协作泳道</h3>
              {task && <p className="mt-0.5 truncate text-[9.5px] text-ink-muted">{task.title} · {active ? '实时协同中' : task.status === 'completed' ? '已通过' : task.status === 'failed' ? '未通过' : task.status}</p>}
            </div>
          </div>
          <span className="text-[10px] text-ink-muted">列头即成员 · 时间自上而下</span>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          {!task ? (
            <div className="flex h-full items-center justify-center text-sm text-ink-muted">{loading ? '正在读取教研任务…' : tasks.length ? '\u8bf7\u9009\u62e9\u4f60\u8981\u67e5\u770b\u7684\u4efb\u52a1\uff0c\u70b9\u51fb\u5de6\u4fa7\u5217\u8868\u4e2d\u7684\u4efb\u52a1\u5373\u53ef\u5728\u6b64\u67e5\u770b\u6d01\u9053\u4e0e\u6267\u884c\u8be6\u60c5' : '还没有可以查看的教研任务'}</div>
          ) : (
            <>
              <AgentWorkflowSummary events={events} running={active} />
              <div className="min-h-0 flex-1">
              </div>
              <CollaborationRounds events={events} selectedSeq={selectedEvent?.seq ?? null} selectedAgent={effectiveAgent} runningAgent={active && latest ? latest.agent : null} running={active} onSelect={(event) => void selectGenerationEvent(event, isLifecycleEvent(event))} onSelectAgent={(agentId) => { setSelectedAgent(agentId); setSelectedEventSeq(events.filter((event) => event.agent === agentId).at(-1)?.seq ?? null); }} />
            </>
          )}
        </div>
      </main>

      {/* 第三列：面向管理员的执行详情；原始记录按需展开 */}
      <aside className="flex w-full shrink-0 flex-col rounded-2xl border border-white/70 bg-white/45 lg:w-[350px]">
        <div className="flex items-center justify-between gap-2 border-b border-white/70 px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-ink">执行详情</h3>
            <p className="mt-0.5 text-[10px] text-ink-muted">操作、结论、依据与下一步</p>
          </div>
          {selectedEvent && <span className="lf-pill lf-pill-null shrink-0">{selectedEvent.agentName || (agents.find((item) => item.id === selectedEvent.agent)?.name ?? selectedEvent.agent)}</span>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {isQuizTask && <QuizQuestionReviewNavigator events={events} selectedSeq={selectedEvent?.seq ?? null} onSelect={selectGenerationEvent} />}
          {selectedEvent ? (
            <ExecutionDetailPanel key={selectedEvent.seq} event={selectedEvent} title={eventDisplayTitle(selectedEvent)} running={selectedEventIsRunning} summaryLoading={summaryLoadingSeq === selectedEvent.seq} />
          ) : (
            <div className="mt-6 rounded-xl border border-dashed border-white/80 bg-white/30 px-4 py-10 text-center text-xs leading-6 text-ink-muted">
              尚未选择事件
              <br />点击泳道中的工作单元或成员节点查看执行细节
            </div>
          )}
        </div>
      </aside>
      {previewDetail && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-ink/35 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewDetail(null); }}>
          <div className="lf-card flex h-[min(86vh,760px)] w-full max-w-3xl flex-col overflow-hidden rounded-3xl shadow-2xl">
            <div className="flex shrink-0 items-center justify-between border-b border-white/70 px-5 py-4">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-bold text-ink">{previewDetail.title}</h3>
                <p className="mt-0.5 text-[11px] text-ink-muted">{typeText[previewDetail.type] || previewDetail.type} · 已生成内容预览</p>
              </div>
              {previewDetail.type === 'ppt' && <a href={`/learn/ppt-preview/${previewDetail.id}`} target="_blank" rel="noreferrer" className="lf-row-btn lf-row-btn-primary"><MonitorPlay size={12} />完整课件预览</a>}
              <button onClick={() => setPreviewDetail(null)} className="lf-row-btn !p-2" aria-label="关闭"><X size={15} /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <ResourcePreview detail={previewDetail} />
            </div>
          </div>
        </div>
      )}
      {previewLoading && (
        <div className="fixed inset-0 z-[94] flex items-center justify-center bg-ink/20 backdrop-blur-[2px]">
          <div className="lf-card flex items-center gap-2 rounded-2xl px-5 py-4 text-sm text-ink-muted">
            <Loader2 size={16} className="animate-spin" />
            正在加载已生成内容…
          </div>
        </div>
      )}
      <NewTaskModal
        open={newTaskOpen}
        busy={newTaskBusy}
        onClose={() => { if (!newTaskBusy) setNewTaskOpen(false); }}
        onCreate={(targets, ctx) => void createGeneration(targets, ctx)}
      />
    </div>
  );
}
