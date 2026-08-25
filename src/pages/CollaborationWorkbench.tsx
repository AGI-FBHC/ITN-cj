import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, Loader2, Plus, Sparkles, X, XCircle } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { api, streamAdminGenerationTask, type AdminGenerationEvent, type LearningResourceGenerationTask, type RagDomain, type RagTree, type RagTreeNode } from '@/lib/api';
import { presentationApi, type PresentationRequest, type PresentationTaskSummary } from '@/lib/presentationApi';
import { useAuth } from '@/context/AuthContext';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

type WorkbenchTask =
  | ({ taskKind: 'resource' } & LearningResourceGenerationTask)
  | ({ taskKind: 'ppt'; resourceType: 'ppt' } & PresentationTaskSummary);

const agents = [
  { id: 'DIA-01', name: '教学策划 Agent', duty: '目标、画像与教学蓝图' },
  { id: 'RET-02', name: '知识检索 Agent', duty: '知识切片、补充资料与证据' },
  { id: 'GEN-03', name: '内容生成 Agent', duty: '初稿生成与定向修订' },
  { id: 'VER-04', name: '质量核验 Agent', duty: '结构、引用与内容一致性' },
  { id: 'ARB-05', name: '发布仲裁 Agent', duty: '通过、返工或终止' },
] as const;
const activeStatuses = new Set(['queued', 'retrieving', 'debating', 'planning', 'analyzing', 'generating', 'verifying', 'reviewing', 'revising', 'judging', 'outline_review']);
/** 执行阶段 → 进度上限：缓冲推进绝不超过当前阶段目标，避免'才到拆解就 96%' */
const STAGE_CAPS: Record<string, number> = {
  queued: 2, retrieving: 12, planning: 28, analyzing: 28, outline_review: 40,
  generating: 55, verifying: 68, reviewing: 76, revising: 80, debating: 74, judging: 88,
  completed: 100,
};
const typeText: Record<string, string> = { lecture: '讲义', practice: '实操指南', quiz: '题库', ppt: '交互课件' };
const debateGroupNames: Record<string, string> = {
  'DIA-01': '教学方案辩论组', 'RET-02': '证据辩论组', 'GEN-03': '内容表达辩论组',
  'VER-04': '一致性辩论组', 'ARB-05': '发布决策辩论组',
};

function isLifecycleEvent(event: AdminGenerationEvent) {
  return event.agent === 'SYSTEM' || event.actorType === 'system' || event.eventType === 'task_lifecycle'
    || ['任务已创建', '任务取消', '生成完成', '任务已结束', '任务被取消'].includes(event.title);
}

function CollaborationRounds({ events, selectedSeq, selectedAgent, runningAgent, onSelect, onSelectAgent }: {
  events: AdminGenerationEvent[];
  selectedSeq: number | null;
  selectedAgent: string;
  runningAgent: string | null;
  onSelect: (event: AdminGenerationEvent) => void;
  onSelectAgent: (agentId: string) => void;
}) {
  const lifecycle = events.filter(isLifecycleEvent);
  const work = events.filter((event) => !isLifecycleEvent(event));
  const units: Array<{ agent: string; events: AdminGenerationEvent[]; round: number; isRoundStart: boolean }> = [];
  let round = 0;
  const visited = new Set<string>();
  let previousAgent = '';
  for (const event of work) {
    const previousUnit = units.at(-1);
    const reentry = event.agent !== previousAgent && visited.has(event.agent);
    const repairSignal = ['revising', 'debating'].includes(event.status) || ['revising', 'debating'].includes(event.phase);
    const isNewRound = (reentry || repairSignal) && previousUnit !== undefined && previousUnit.agent !== event.agent;
    if (isNewRound) round += 1;
    const currentUnit = units.at(-1);
    if (currentUnit?.agent === event.agent && currentUnit.round === round) currentUnit.events.push(event);
    else units.push({ agent: event.agent, events: [event], round, isRoundStart: isNewRound || units.length === 0 });
    visited.add(event.agent);
    previousAgent = event.agent;
  }
  return (
    <div className="mt-3 overflow-x-auto">
      <div className="relative min-w-[880px] overflow-hidden rounded-2xl border border-white/90 bg-white/40 px-2 pb-2 pt-2 shadow-[0_8px_28px_rgba(48,74,60,0.10)] backdrop-blur-xl">
        {/* 泳道背景：整板（含列头区域）无缝交替着色 + 四根贯穿竖线分隔五列 */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute inset-0 grid grid-cols-5">
            {agents.map((agent, index) => (<div key={agent.id} className={cn(index % 2 ? 'bg-[#E7F0E9]/90' : 'bg-[#F8EFDD]/95')} />))}
          </div>
          {[1, 2, 3, 4].map((i) => (<span key={i} className="absolute top-0 bottom-0 w-px bg-ink-muted/20" style={{ left: (i * 20) + '%', transform: 'translateX(-50%)' }} />))}
        </div>
        {/* 列头 = AI 教研组成员，点击进入该成员 */}
        <div className="relative grid grid-cols-5 gap-2">
          {agents.map((agent) => {
            const own = events.filter((event) => event.agent === agent.id);
            const running = runningAgent === agent.id;
            const selected = selectedAgent === agent.id;
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => onSelectAgent(agent.id)}
                className={cn('flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border backdrop-blur-md transition-all',
                  selected ? 'border-brand/70 bg-brand-tint/85 shadow-[0_3px_12px_rgba(78,120,96,0.25)] ring-1 ring-brand/25' : running ? 'border-brand/50 bg-white/90 shadow-sm' : own.length ? 'border-white/85 bg-white/70 hover:border-brand/40 shadow-sm' : 'border-dashed border-white/80 bg-white/40 hover:border-brand/30')}
                title={agent.duty}
              >
                <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full', running ? 'bg-brand text-paper' : own.length ? 'bg-emerald-100 text-emerald-600' : 'bg-white/85 text-ink-muted/60')}>
                  {running ? <Loader2 size={11} className="animate-spin" /> : own.length ? <CheckCircle2 size={11} /> : <span className="h-1.5 w-1.5 rounded-full bg-ink-muted/40" />}
                </span>
                <span className="truncate text-[10px] font-bold text-ink">{agent.name}</span>
              </button>
            );
          })}
        </div>
        {/* 系统起点 + Agent 阶段块 + 系统终点：无回环时自然形成左上到右下的阶梯 */}
        <div className="relative pt-2">
          {lifecycle[0] && (
            <div className="grid min-h-9 grid-cols-5 gap-2">
              <button type="button" onClick={() => onSelect(lifecycle[0])} className={cn('col-start-1 flex items-center gap-1.5 self-start rounded-lg border px-2 py-1.5 text-left', lifecycle[0].seq === selectedSeq ? 'border-brand/45 bg-brand-tint/70' : 'border-white/85 bg-white/65 hover:border-brand/30')}>
                <span className="h-2 w-2 shrink-0 rounded-full bg-brand" /><span className="truncate text-[9px] font-bold text-ink">{lifecycle[0].title}</span><span className="ml-auto text-[7.5px] text-ink-muted">系统</span>
              </button>
            </div>
          )}
          {units.map((unit) => {
            const lane = Math.max(0, agents.findIndex((item) => item.id === unit.agent));
            const selected = unit.events.some((event) => event.seq === selectedSeq);
            const debateEvents = unit.events.filter((event) => event.snapshot?.debateTriggered === true);
            const debateGroup = [...debateEvents].reverse().map((event) => event.snapshot?.debateGroup).find((value) => value && typeof value === 'object') as { roles?: unknown; status?: unknown } | undefined;
            const debateRoles = Array.isArray(debateGroup?.roles) ? debateGroup.roles.map(String) : unit.agent === 'RET-02' && debateEvents.length ? ['多源调查 Agent', '质疑审查 Agent', '证据仲裁 Agent'] : [];
            return (
              <div key={`${unit.round}-${unit.agent}-${unit.events[0].seq}`}>
                {/* 轮次起始标签（初始生成 / 修复N） */}
                {unit.isRoundStart && (
                  <div className="relative h-5">
                    <span className={cn('absolute left-1 top-0 rounded-full px-1.5 py-px text-[8px] font-bold', unit.round === 0 ? 'bg-brand-tint text-brand' : 'bg-ochre/15 text-[#9A5B3C]')}>
                      {unit.round === 0 ? '主流程' : '自主修复第 ' + unit.round + ' 轮'}
                    </span>
                  </div>
                )}
                <div className="grid min-h-9 grid-cols-5 gap-2 pb-2">
                  <div style={{ gridColumnStart: lane + 1 }} className={cn('overflow-hidden rounded-lg border p-1 shadow-[0_4px_14px_rgba(48,74,60,0.14)] backdrop-blur-md', selected ? 'border-brand/45 bg-brand-tint/65 ring-1 ring-brand/15' : unit.round > 0 ? 'border-ochre/25 bg-white/70' : 'border-white/85 bg-white/70')}>
                    {unit.events.map((event) => (
                      <button key={event.seq} type="button" onClick={() => onSelect(event)} title={event.detail || event.title} className={cn('flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left transition-colors', event.seq === selectedSeq ? 'bg-white/85' : 'hover:bg-white/65')}>
                        <span className={cn('h-2 w-2 shrink-0 rounded-full', event.seq === selectedSeq ? 'bg-brand ring-2 ring-brand/20' : unit.round > 0 ? 'bg-ochre' : 'bg-brand/50')} />
                        <span className="truncate text-[9.5px] font-semibold text-ink">{event.title}</span>
                      </button>
                    ))}
                    {debateEvents.length > 0 && (
                      <button type="button" onClick={() => onSelect(debateEvents.at(-1)!)} className="m-1 mt-1.5 block w-[calc(100%_-_0.5rem)] rounded-lg border border-[#6D63A8]/25 bg-[#F2F0FF]/80 px-2 py-2 text-left transition-colors hover:border-[#6D63A8]/45 hover:bg-[#ECE9FF]">
                        <div className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-[#6D63A8]"/><span className="text-[8.5px] font-bold text-[#51477F]">{debateGroupNames[unit.agent] ?? '专业辩论组'}</span><span className="ml-auto rounded-full bg-white/80 px-1.5 py-0.5 text-[7.5px] font-semibold text-[#51477F]/70">{debateGroup?.status === 'running' ? '进行中' : '已执行'}</span></div>
                        {debateRoles.length > 0 && <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[7.5px] font-semibold text-ink-2">{debateRoles.map((role, roleIndex) => <span key={`${role}-${roleIndex}`} className="contents">{roleIndex > 0 && <span className="text-[#51477F]/40">→</span>}<span>{role.replace(' Agent', '')}</span></span>)}</div>}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {lifecycle.slice(1).map((event) => (
            <div key={event.seq} className="grid min-h-9 grid-cols-5 gap-2">
              <button type="button" onClick={() => onSelect(event)} className={cn('col-start-5 flex items-center gap-1.5 self-start rounded-lg border px-2 py-1.5 text-left', event.seq === selectedSeq ? 'border-brand/45 bg-brand-tint/70' : 'border-white/85 bg-white/65 hover:border-brand/30')}>
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" /><span className="truncate text-[9px] font-bold text-ink">{event.title}</span><span className="ml-auto text-[7.5px] text-ink-muted">系统</span>
              </button>
            </div>
          ))}
          {!units.length && lifecycle.length < 1 && <p className="relative py-6 text-center text-xs text-ink-muted">等待第一条协同事件…</p>}
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
    <section className="mt-4 rounded-2xl border border-white/75 bg-white/45 px-4 py-3">
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
function NewTaskModal({ open, onClose, onCreate, busy }: { open: boolean; onClose: () => void; onCreate: (targets: GenKind[], ctx: { domainCode: string; nodeCode: string; topicName: string }) => void; busy: boolean }) {
  const [domains, setDomains] = useState<RagDomain[]>([]);
  const [domainCode, setDomainCode] = useState('');
  const [tree, setTree] = useState<RagTree | null>(null);
  const [chapterCode, setChapterCode] = useState('');
  const [kpCode, setKpCode] = useState('');
  const [selected, setSelected] = useState<Set<GenKind>>(new Set(['lecture', 'practice', 'quiz', 'ppt']));
  useEffect(() => {
    if (!open) return;
    void api.listRagDomains().then((items) => { setDomains(items); if (items[0]?.code) setDomainCode(items[0].code); }).catch(() => setDomains([]));
  }, [open]);
  useEffect(() => {
    if (!domainCode) { setTree(null); return; }
    setTree(null); setChapterCode(''); setKpCode('');
    void api.getRagTree(domainCode).then(setTree).catch(() => setTree(null));
  }, [domainCode]);
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
  const canCreate = Boolean(kp && selected.size && !busy);
  if (!open) return null;
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
            <p className="mb-2 text-sm font-bold text-ink">资源类型</p>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {genKinds.map(([id, label, note]) => (
                <button key={id} type="button" onClick={() => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} className={cn('rounded-2xl border p-3 text-left transition-all', selected.has(id) ? 'border-brand/50 bg-brand-tint/70 ring-1 ring-brand/30' : 'border-white/80 bg-white/45 hover:bg-white/70')}>
                  <p className="text-sm font-bold text-ink">{label}</p>
                  <p className="mt-0.5 text-[10px] text-ink-muted">{note}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2 border-t border-white/70 pt-4">
          <button disabled={busy} onClick={onClose} className="lf-row-btn">取消</button>
          <button disabled={!canCreate} onClick={() => kp && onCreate([...selected], { domainCode, nodeCode: kp.nodeCode, topicName: kp.name })} className="lf-row-btn lf-row-btn-primary min-w-28 justify-center disabled:opacity-50">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            创建{selected.size ? '（' + selected.size + '项）' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

function useSmoothProgress(real: number, cap: number, animating: boolean) {
  const [shown, setShown] = useState(Math.min(real, cap));
  const realRef = { current: real };
  const capRef = { current: cap };
  realRef.current = real;
  capRef.current = cap;
  useEffect(() => {
    if (!animating) { setShown(realRef.current); return; }
    const id = window.setInterval(() => {
      setShown((current) => {
        const target = Math.min(realRef.current, capRef.current);
        if (current >= target - 0.05 && current >= capRef.current) return Math.min(capRef.current, current);
        const gap = target - current;
        if (gap > 0.05) return Math.min(capRef.current, current + Math.max(0.3, gap * 0.28));
        /* 真实值已到阶段目标：在阶段帽内缓慢微推，模拟'正在当前环节推进' */
        return Math.min(capRef.current, current + 0.22);
      });
    }, 300);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animating]);
  return shown;
}

function WorkbenchTaskItem({ item, selected, onClick }: { item: WorkbenchTask; selected: boolean; onClick: () => void }) {
  const active = activeStatuses.has(item.status);
  const failed = item.status === 'failed' || item.status === 'cancelled';
  const context = contextOf(item);
  const done = item.status === 'completed';
  const stageCap = failed ? Math.max(item.progress, 4) : (STAGE_CAPS[item.status] ?? 90);
  const shown = useSmoothProgress(done ? 100 : item.progress, failed ? stageCap : (done ? 100 : stageCap), active);
  const fillPct = done || failed || !active ? Math.max(4, done ? 100 : item.progress) : Math.max(4, Math.round(shown));
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('relative w-full overflow-hidden rounded-xl border text-left transition-all',
        selected ? 'border-brand/90 shadow-[0_4px_18px_rgba(78,120,96,0.35)] ring-2 ring-brand/30' :
        active ? 'border-white/40 hover:border-brand/50' :
        failed ? 'border-white/40 hover:border-brand/40' :
        'border-white/30 hover:border-brand/50')}
    >
      {/* 轨道：整卡底层（深色充电底座） */}
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#1D2E24] to-[#2A3D31]" />
      {/* 进度填充：直接作为卡片背景，宽度 = 进度；含呼吸高光与前沿光点 */}
      <span className={cn('pointer-events-none absolute inset-y-0 left-0 overflow-hidden rounded-r-xl',
        failed ? 'bg-gradient-to-r from-[#8C3A3A]/95 to-[#C96A5A]/80' :
        item.status === 'completed' ? 'bg-gradient-to-r from-[#1F7A44]/95 to-[#3AAE68]/85' :
        'bg-gradient-to-r from-[#2E6B53]/95 to-[#4DA97F]/85')} style={{ width: fillPct + '%' }}>
        {active && <><span className="surge" /><span className="head" /></>}
      </span>
      {/* 内容：文字叠在进度背景之上 */}
      <span className="relative z-10 block space-y-1 p-3">
        <span className="flex items-center gap-1.5">
          {active ? <Loader2 size={12} className="shrink-0 animate-spin text-emerald-300" /> : failed ? <XCircle size={12} className="shrink-0 text-red-400" /> : <CheckCircle2 size={12} className="shrink-0 text-emerald-300" />}
          <span className="rounded-md border border-white/25 bg-white/10 px-1.5 py-0.5 text-[9px] font-bold text-white/90">{typeText[item.resourceType]}</span>
          <span className="ml-auto text-[10px] font-bold tabular-nums text-white drop-shadow-sm">{failed ? item.progress : fillPct}%</span>
        </span>
        <span className="block truncate text-xs font-bold text-white">{String(context.topicName || item.title)}</span>
        <span className="block line-clamp-1 text-[9.5px] leading-4 text-white/75">{item.stageMessage}</span>
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
};

function readableValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.map((item) => typeof item === 'object' ? JSON.stringify(item) : String(item)).join('；') || '无';
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '—');
}

function EventDetailPanel({ event }: { event: AdminGenerationEvent }) {
  const [rawOpen, setRawOpen] = useState(false);
  const snapshot = event.snapshot ?? {};
  const debateGroup = snapshot.debateGroup && typeof snapshot.debateGroup === 'object' ? snapshot.debateGroup as Record<string, unknown> : null;
  const roles = Array.isArray(debateGroup?.roles) ? debateGroup.roles.map(String) : [];
  const contradictions = Array.isArray(snapshot.contradictions) ? snapshot.contradictions.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')) : [];
  const hidden = new Set(['requestId', 'traceId', 'promptVersion', 'model', 'debateGroup', 'contradictions', 'debateTriggered', 'debateType']);
  const facts = Object.entries(snapshot).filter(([key]) => !hidden.has(key));
  const decision = String(snapshot.decision ?? '');
  const nextStep = decision === 'repair' || snapshot.repairSource ? '交给内容生成 Agent 定向返修，完成后重新核验。'
    : decision === 'pass' ? '本关已通过，继续进入后续生成流程。' : '';
  return (
    <div className="space-y-3">
      <section className="rounded-2xl border border-white/85 bg-white/70 p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2"><span className="lf-pill lf-pill-null">{event.phase || event.status}</span><span className="ml-auto font-mono text-[9px] text-ink-muted">{event.time ? new Date(event.time).toLocaleString('zh-CN', { hour12: false }) : `记录 #${event.seq}`}</span></div>
        <h4 className="mt-3 text-sm font-bold leading-5 text-ink">{event.title}</h4>
        {event.detail && <p className="mt-2 text-[11px] leading-5 text-ink-2">{event.detail}</p>}
      </section>
      {debateGroup && <section className="rounded-2xl border border-[#6D63A8]/20 bg-[#F2F0FF]/70 p-4">
        <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#6D63A8]"/><h4 className="text-xs font-bold text-[#51477F]">{debateGroupNames[event.agent] ?? '专业辩论组'}</h4><span className="ml-auto rounded-full bg-white/80 px-2 py-1 text-[9px] font-semibold text-[#51477F]">{debateGroup.status === 'running' ? '进行中' : '已完成'}</span></div>
        {roles.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-1.5">{roles.map((role, index) => <span key={`${role}-${index}`} className="contents">{index > 0 && <span className="text-[9px] text-[#51477F]/40">→</span>}<span className="rounded-full bg-white/80 px-2 py-1 text-[9px] font-semibold text-ink-2">{role}</span></span>)}</div>}
        <div className="mt-3 grid grid-cols-2 gap-2"><div className="rounded-xl bg-white/65 px-3 py-2"><p className="text-[9px] text-ink-muted">仲裁结果</p><p className="mt-1 text-[11px] font-bold text-ink">{decision === 'repair' ? '发现矛盾，需要返修' : decision === 'pass' ? '未发现直接矛盾' : event.detail || '等待裁决'}</p></div><div className="rounded-xl bg-white/65 px-3 py-2"><p className="text-[9px] text-ink-muted">矛盾数量</p><p className="mt-1 text-[11px] font-bold text-ink">{Number(snapshot.contradictionCount ?? contradictions.length)} 处</p></div></div>
        {nextStep && <div className="mt-2 rounded-xl bg-white/65 px-3 py-2"><p className="text-[9px] text-ink-muted">下一步</p><p className="mt-1 text-[11px] leading-5 text-ink-2">{nextStep}</p></div>}
      </section>}
      {contradictions.length > 0 && <section className="space-y-2"><h4 className="px-1 text-xs font-bold text-ink">需要返修的矛盾</h4>{contradictions.map((item, index) => <article key={index} className="rounded-2xl border border-ochre/20 bg-ochre/5 p-3"><p className="text-[10px] font-bold text-ink">{index + 1}. {String(item.claim ?? '待修正表述')}</p>{Boolean(item.evidence) && <p className="mt-2 text-[10px] leading-5 text-ink-2"><span className="font-semibold text-ink-muted">依据：</span>{String(item.evidence)}</p>}{Boolean(item.reason) && <p className="mt-1 text-[10px] leading-5 text-ink-2"><span className="font-semibold text-ink-muted">矛盾：</span>{String(item.reason)}</p>}{Boolean(item.repairInstruction) && <p className="mt-1 text-[10px] leading-5 text-ochre"><span className="font-semibold">返修：</span>{String(item.repairInstruction)}</p>}</article>)}</section>}
      {facts.length > 0 && <section className="space-y-2"><h4 className="px-1 text-xs font-bold text-ink">本次执行记录</h4>{facts.map(([key, value]) => <div key={key} className="rounded-xl border border-white/70 bg-white/55 px-3 py-2.5"><p className="text-[9px] font-semibold text-ink-muted">{snapshotLabels[key] ?? key}</p><p className="mt-1 whitespace-pre-wrap break-words text-[10.5px] leading-5 text-ink-2">{readableValue(value)}</p></div>)}</section>}
      <button type="button" onClick={() => setRawOpen((open) => !open)} className="flex w-full items-center justify-between rounded-xl border border-white/70 bg-white/35 px-3 py-2.5 text-[10px] font-semibold text-ink-muted hover:bg-white/55"><span>原始执行记录</span><ChevronRight size={12} className={cn('transition-transform', rawOpen && 'rotate-90')} /></button>
      {rawOpen && <div className="lf-json p-3.5 text-[11px] leading-[1.65]"><JsonTree value={{ seq: event.seq, agent: event.agentName || event.agent, stage: event.phase || event.status, time: event.time, title: event.title, detail: event.detail, snapshot }} /></div>}
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
  const [selectedAgent, setSelectedAgent] = useState('');
  const [selectedEventSeq, setSelectedEventSeq] = useState<number | null>(null);
  const [taskTab, setTaskTab] = useState('active');
  const [tasksCollapsed, setTasksCollapsed] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskBusy, setNewTaskBusy] = useState(false);
  const selectedKey = params.get('task');

  const load = async () => {
    const resources = await api.listLearningResourceTasks(100);
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
    setTasks(next);
    if (!selectedKey && next[0]) setParams({ task: taskKey(next[0]) }, { replace: true });
    setLoading(false);
  };

  /** 新建任务：按知识目标创建多类资源生成任务 */
  const createGeneration = async (targets: GenKind[], ctx: { domainCode: string; nodeCode: string; topicName: string }) => {
    setNewTaskBusy(true);
    try {
      const results = await Promise.allSettled(targets.map(async (target) => {
        if (target === 'ppt') {
          const request: PresentationRequest = {
            requirement: '围绕“' + ctx.topicName + '”生成一份面向学习者的完整交互课件，内容准确、结构清晰，并适合课堂讲解与自主学习。',
            title: ctx.topicName, audience: 'students', purpose: 'courseware', style: 'education', backgroundStyle: 'blue-white-minimal',
            language: 'zh-CN', slideCount: 0, aspectRatio: '16:9', detailLevel: 'detailed', includeSpeakerNotes: true,
            modelProvider: 'mimo', generationMode: 'template',
            generationContext: { adminGeneration: true, domainCode: ctx.domainCode, nodeCode: ctx.nodeCode, kpId: ctx.nodeCode, topicName: ctx.topicName },
          };
          await presentationApi.createPresentation(request);
        } else {
          await api.startLearningResourceTask(target, {
            topic: ctx.topicName, title: ctx.topicName + ' · ' + typeText[target], kpId: ctx.nodeCode, detailLevel: 'detailed',
            questionCount: target === 'quiz' ? 12 : undefined,
            generationContext: { adminGeneration: true, domainCode: ctx.domainCode, nodeCode: ctx.nodeCode, kpId: ctx.nodeCode, topicName: ctx.topicName },
          });
        }
      }));
      const failed = results.filter((result) => result.status === 'rejected').length;
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

  useEffect(() => {
    void load().catch(() => setLoading(false));
    const timer = window.setInterval(() => void load().catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const task = tasks.find((item) => taskKey(item) === selectedKey) ?? null;
  useEffect(() => {
    if (!task) return;
    setEvents([]); setSelectedAgent(''); setSelectedEventSeq(null);
    const controller = new AbortController();
    void streamAdminGenerationTask(task.taskKind, task.id, (event) => setEvents((current) => current.some((item) => item.seq === event.seq) ? current : [...current, event].sort((a, b) => a.seq - b.seq)), controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [task?.id, task?.taskKind]);

  const latest = events.at(-1);
  const effectiveAgent = selectedAgent || latest?.agent || agents[0].id;
  const agentEvents = events.filter((event) => event.agent === effectiveAgent);
  const selectedEvent = events.find((event) => event.seq === selectedEventSeq) ?? agentEvents.at(-1);
  const active = Boolean(task && activeStatuses.has(task.status) && (!latest || activeStatuses.has(latest.status)));
  const grouped = useMemo(() => ({ active: tasks.filter((item) => activeStatuses.has(item.status)), finished: tasks.filter((item) => !activeStatuses.has(item.status)) }), [tasks]);


  return (
    <div className="lf-anim-in-up flex h-full min-h-0 flex-col gap-4 lg:flex-row">
      {/* 第一列：AI 教研任务（可折叠） */}
      <aside className={cn('flex w-full shrink-0 flex-col rounded-2xl border border-white/70 bg-white/45 transition-all duration-300 lg:w-[290px]', tasksCollapsed && 'lg:w-0 lg:min-w-0 lg:overflow-hidden lg:border-none lg:bg-transparent lg:p-0 lg:gap-0')}>
        <div className="flex items-center gap-2 border-b border-white/70 p-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-paper"><Sparkles size={15} /></span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-ink">AI 教研任务</h3>
            <p className="mt-0.5 truncate text-[9.5px] text-ink-muted">{grouped.active.length + grouped.finished.length} 项 · 3s 自动刷新</p>
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
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          <div className="space-y-2">
            {(taskTab === 'active' ? grouped.active : grouped.finished).map((item) => (
              <WorkbenchTaskItem key={taskKey(item)} item={item} selected={taskKey(item) === selectedKey} onClick={() => setParams({ task: taskKey(item) })} />
            ))}
            {(taskTab === 'active' ? grouped.active : grouped.finished).length === 0 && (
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
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!task ? (
            <div className="flex h-full items-center justify-center text-sm text-ink-muted">{loading ? '正在读取教研任务…' : '还没有可以查看的教研任务'}</div>
          ) : (
            <>
              <CollaborationRounds events={events} selectedSeq={selectedEvent?.seq ?? null} selectedAgent={effectiveAgent} runningAgent={active && latest ? latest.agent : null} onSelect={(event) => { if (!isLifecycleEvent(event)) setSelectedAgent(event.agent); setSelectedEventSeq(event.seq); }} onSelectAgent={(agentId) => { setSelectedAgent(agentId); setSelectedEventSeq(events.filter((event) => event.agent === agentId).at(-1)?.seq ?? null); }} />
              <AgentWorkflowSummary events={events} running={active} />
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
          {selectedEvent ? (
            <EventDetailPanel key={selectedEvent.seq} event={selectedEvent} />
          ) : (
            <div className="mt-6 rounded-xl border border-dashed border-white/80 bg-white/30 px-4 py-10 text-center text-xs leading-6 text-ink-muted">
              尚未选择事件
              <br />点击泳道中的工作单元或成员节点查看执行细节
            </div>
          )}
        </div>
      </aside>
      <NewTaskModal
        open={newTaskOpen}
        busy={newTaskBusy}
        onClose={() => { if (!newTaskBusy) setNewTaskOpen(false); }}
        onCreate={(targets, ctx) => void createGeneration(targets, ctx)}
      />
    </div>
  );
}
