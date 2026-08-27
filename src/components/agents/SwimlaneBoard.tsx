/**
 * SwimlaneBoard — S2 Agent 泳道拓扑（主体左栏 7/12）
 * 5 条水平泳道：AgentChip + LiveDot + 实时状态徽标/里程碑进度 · 当前动作（打字机）· 条纹进度 · 产出物 chips
 * 跨泳道消息：SVG 曲线 + 琥珀脉冲点（SMIL animateMotion），到达时接收方图标光环扩散
 * hover AgentChip → 职责 tooltip；点击 → 过滤右侧时间线；产出 chip → 草稿预览 / KB 抽屉
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { FileText, ListChecks, ClipboardList, Package, Check } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { AgentId } from '@/data/agents';
import { agents, getAgent } from '@/data/agents';
import type { Learner } from '@/data/learners';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import type { CollabScript } from '@/data/collabScript';
import AgentChip from '@/components/AgentChip';
import LiveDot from '@/components/LiveDot';
import TraceBadge from '@/components/TraceBadge';
import type { PlayStatus } from './usePlayback';
import { reducedMotion } from './usePlayback';
import { getScriptIndices } from './scriptModel';
import type { ScriptIndices } from './scriptModel';
import { cn } from '@/lib/utils';

const easeLf = [0.22, 1, 0.36, 1] as [number, number, number, number];

/* ---------------- 泳道演出模型 ---------------- */

type DraftKey = 'v1' | 'v2' | 'guide' | 'quiz';

interface ChipDef {
  label: string;
  tone: 'kb' | 'amber' | 'brand' | 'success' | 'plain';
  kbId?: string;
  draft?: DraftKey;
}

interface Milestone {
  at: number;
  label: string;
  chips: ChipDef[];
}

function buildLaneMilestones(
  script: CollabScript,
  learner: Learner,
  idx: ScriptIndices,
): Record<AgentId, Milestone[]> {
  const score = learner.scores[script.kpId];
  const target = getKnowledgePoint(script.kpId).targetLevel;
  const kpShort = `${script.kpName}（${score} 分 / 目标 ${target}）`;
  const kb = (id: string): ChipDef => ({ label: id, tone: 'kb', kbId: id });
  const m: Record<AgentId, Milestone[]> = {
    'DIA-01': [
      {
        at: idx.diaReport,
        label: `读取画像向量… 盲区定位：${kpShort}`,
        chips: [{ label: '画像向量 v3', tone: 'brand' }],
      },
      {
        at: idx.tracking,
        label: '布设追踪埋点 · 正确率实时回流',
        chips: [{ label: '追踪埋点', tone: 'plain' }],
      },
    ],
    'RET-02': [
      { at: idx.retCmd, label: '检索知识库 2,356 切片…', chips: [] },
      {
        at: idx.retHit,
        label: '命中 23 条 · 采纳可信度 Top-6',
        chips: [kb('KB-007'), kb('KB-014'), kb('KB-021'), kb('KB-002'), kb('KB-018'), kb('KB-010')],
      },
    ],
    'GEN-03': [
      { at: idx.genCmd, label: `约束生成${script.resourceTitle} v1…`, chips: [] },
      {
        at: idx.draftV1,
        label: '草稿 v1 送审 · 溯源 14 处',
        chips: [{ label: '草稿 v1 · 14 溯源', tone: 'amber', draft: 'v1' }],
      },
      { at: idx.r1Answer, label: '应答质询 · 补充试验条件限定', chips: [] },
      {
        at: idx.revision,
        label: '修订生成 v2 · 溯源增至 15 处',
        chips: [{ label: '草稿 v2 · 15 溯源', tone: 'amber', draft: 'v2' }],
      },
      {
        at: idx.guide,
        label: '产出实操指南 5 步 · 分阶题 15 题',
        chips: [
          { label: '实操指南 5 步', tone: 'plain', draft: 'guide' },
          { label: '分阶题 15 题', tone: 'plain', draft: 'quiz' },
        ],
      },
    ],
    'VER-04': [
      {
        at: idx.r1Challenge,
        label: '交叉验证 14 处事实… R1 质询',
        chips: [{ label: '审核意见 R1', tone: 'plain' }],
      },
      {
        at: idx.r2Challenge,
        label: 'R2 质询 · 线性模型适用区间',
        chips: [{ label: '审核意见 R2', tone: 'plain' }],
      },
      {
        at: idx.verdict,
        label: '复核通过 ✓ 幻觉风险 0',
        chips: [{ label: '审核通过', tone: 'success' }],
      },
    ],
    'ARB-05': [
      {
        at: idx.kickoff,
        label: '立项 · 资源包任务下发',
        chips: [{ label: '任务 T-0047', tone: 'brand' }],
      },
      {
        at: idx.adopt,
        label: '裁定采纳 v2 · 置信度 0.96',
        chips: [{ label: '决议 · 采纳 v2', tone: 'brand' }],
      },
      {
        at: idx.closed,
        label: '闭环确认 · 资源包已发布',
        chips: [{ label: '资源包发布', tone: 'success' }],
      },
    ],
  };
  return m;
}

/* ---------------- 打字机 ---------------- */

function TypeText({ text, className }: { text: string; className?: string }) {
  const [n, setN] = useState(text.length);
  /* 文本变化 → 渲染期比对归零重打（reduced-motion 直接呈现终态） */
  const [prevText, setPrevText] = useState(text);
  if (prevText !== text) {
    setPrevText(text);
    setN(reducedMotion() ? text.length : 0);
  }
  const typing = n < text.length;
  useEffect(() => {
    if (typing) {
      const iv = window.setInterval(() => {
        setN((v) => Math.min(v + 1, text.length));
      }, 12);
      return () => window.clearInterval(iv);
    }
    return undefined;
  }, [typing, text.length]);
  return (
    <span className={className}>
      {text.slice(0, n)}
      {typing && <span className="ml-0.5 inline-block h-[12px] w-[5px] animate-caret-blink bg-ink-muted align-[-1px]" />}
    </span>
  );
}

/* ---------------- 条纹进度条（条纹流动） ---------------- */

function StripedProgress({ color }: { color: string }) {
  return (
    <div className="h-[5px] w-36 overflow-hidden rounded-full bg-paper-deep">
      <motion.div
        className="h-full rounded-full"
        style={{
          width: 'calc(100% + 16px)',
          backgroundImage: `repeating-linear-gradient(90deg, ${color} 0 8px, ${color}55 8px 16px)`,
        }}
        animate={reducedMotion() ? undefined : { x: [0, -16] }}
        transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}
      />
    </div>
  );
}

/* ---------------- 消息脉冲 ---------------- */

interface Pulse {
  id: string;
  path: string;
  color: string;
}

/* ---------------- 草稿预览弹层 ---------------- */

function DraftDialog({
  draft,
  script,
  open,
  onOpenChange,
}: {
  draft: DraftKey | null;
  script: CollabScript;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const meta: Record<DraftKey, { title: string; desc: string; body: string[]; kbs: string[] }> = {
    v1: {
      title: `${script.resourceTitle} · 草稿 v1`,
      desc: 'GEN-03 约束生成 · 3,842 字 · 溯源 14 处 · 已送审 VER-04',
      body: ['§1 标定原理：位姿准确度与重复定位精度（GB/T 12642-2013）', '§2 零点标定五步法：机械零点 → 零点复归 → 负载补偿', '§3 温度补偿：Δθ=k(T−T₀) 线性修正模型'],
      kbs: ['KB-007', 'KB-014', 'KB-021'],
    },
    v2: {
      title: `${script.resourceTitle} · 草稿 v2（采纳版）`,
      desc: '2 处修订 · 溯源 15 处 · VER-04 复核通过 · 幻觉风险 0',
      body: ['§2.3 重复定位精度 ±0.02 mm 补充试验条件：额定负载 · 最大速度 50%', '§3 增加线性补偿适用区间 10–35℃，超出需五点恒温实验重新拟合', '新增脚注：温度补偿系数 k=0.021°/10℃'],
      kbs: ['KB-007', 'KB-014', 'KB-021'],
    },
    guide: {
      title: '实操指南 · 5 步',
      desc: 'GEN-03 生成 · VER-04 快速复核 PASS · 安全警示引 KB-005',
      body: ['① 断电挂牌与安全确认（250mm/s 限速）', '② 机械零点目视对齐', '③ 示教器零点标定程序执行', '④ 激光跟踪仪比对复测', '⑤ 标定报告归档与画像回写'],
      kbs: ['KB-018', 'KB-005'],
    },
    quiz: {
      title: '分阶测试题 · 15 题',
      desc: '基础 4 / 进阶 5 / 挑战 3 · 解析全部可回溯',
      body: ['基础：位姿准确度与重复定位精度概念辨析', '进阶：GB/T 12642 试验条件下的标定流程排序', '挑战：温度漂移场景下的补偿参数计算'],
      kbs: ['KB-009', 'KB-022'],
    },
  };
  const d = draft ? meta[draft] : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-hairline bg-card-warm sm:max-w-[520px]">
        {d && (
          <>
            <DialogHeader>
              <DialogTitle className="font-serif text-[17px] text-ink">{d.title}</DialogTitle>
              <DialogDescription className="font-mono text-[11.5px] text-ink-muted">
                {d.desc}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              {d.body.map((line) => (
                <div
                  key={line}
                  className="rounded-lg border border-hairline bg-paper px-3 py-2 text-[13px] leading-[20px] text-ink-2"
                >
                  {line}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="lf-mono-label !text-[10px]">溯源引用</span>
              {d.kbs.map((id) => (
                <TraceBadge key={id} kbId={id} />
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- 主组件 ---------------- */

const chipTone: Record<ChipDef['tone'], string> = {
  kb: '',
  amber: 'border-brand-amber/50 bg-brand-amber-tint text-brand-amber',
  brand: 'border-brand/40 bg-brand-tint text-brand',
  success: 'border-brand-success/40 bg-brand-success/10 text-brand-success',
  plain: 'border-hairline bg-paper text-ink-2',
};

const draftIcon: Record<DraftKey, typeof FileText> = {
  v1: FileText,
  v2: FileText,
  guide: ListChecks,
  quiz: ClipboardList,
};

function DraftChipIcon({ draft }: { draft: DraftKey }) {
  const Icon = draftIcon[draft];
  return <Icon size={11} />;
}

/* ---------------- 泳道状态徽标 + 进度指示 ---------------- */

type LaneStatus = 'processing' | 'done' | 'idle';

const laneStatusMeta: Record<LaneStatus, { label: string; cls: string }> = {
  processing: { label: '处理中', cls: 'border-brand-amber/50 bg-brand-amber-tint text-brand-amber' },
  done: { label: '已完成', cls: 'border-brand/40 bg-brand-tint text-brand' },
  idle: { label: '待命', cls: 'border-hairline bg-paper text-ink-muted' },
};

function LaneStatusBadge({ status }: { status: LaneStatus }) {
  const m = laneStatusMeta[status];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px font-mono text-[9.5px] font-medium leading-[14px]',
        m.cls,
      )}
    >
      {status === 'processing' && (
        <motion.span
          className="h-1 w-1 rounded-full bg-brand-amber"
          animate={reducedMotion() ? undefined : { scale: [1, 1.8, 1], opacity: [1, 0.35, 1] }}
          transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      {status === 'done' && <Check size={9} strokeWidth={3} />}
      {status === 'idle' && <span className="h-1 w-1 rounded-full bg-ink-muted/40" />}
      {m.label}
    </span>
  );
}

/** 极简进度指示：已完成 milestone 数 / 总数，颜色取 Agent 专属色 */
function LaneProgress({ done, total, color }: { done: number; total: number; color: string }) {
  if (total === 0) return null;
  return (
    <span className="shrink-0 font-mono text-[9.5px] font-medium tabular" style={{ color }}>
      {done}/{total}
    </span>
  );
}

export default function SwimlaneBoard({
  script,
  learner,
  cursor,
  status,
  focusAgent,
  onSelectAgent,
}: {
  script: CollabScript;
  learner: Learner;
  cursor: number;
  status: PlayStatus;
  focusAgent: AgentId | null;
  onSelectAgent: (id: AgentId) => void;
}) {
  const idx = useMemo(() => getScriptIndices(script.events), [script.events]);
  const milestones = useMemo(
    () => buildLaneMilestones(script, learner, idx),
    [script, learner, idx],
  );
  const [draftView, setDraftView] = useState<DraftKey | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const laneRefs = useRef<(HTMLDivElement | null)[]>([]);
  const focusedRef = useRef(false);

  const latest = cursor > 0 ? script.events[cursor - 1] : null;
  const running = status === 'running';

  /* 消息脉冲：由最近派发的事件派生（泳道固定高 88px，中心可算），
     SMIL animateMotion 飞行 500ms + 到达后淡出，随 cursor 推进自然替换 */
  const pulses: Pulse[] = [];
  if (!reducedMotion() && cursor > 0) {
    const LANE_H = 88;
    const centerY = (i: number) => i * LANE_H + LANE_H / 2;
    const recentFrom = Math.max(0, cursor - 2);
    script.events.slice(recentFrom, cursor).forEach((e, j) => {
      const evIndex = recentFrom + j;
      const fromI = agents.findIndex((a) => a.id === e.from);
      if (fromI < 0) return;
      const toIds: AgentId[] =
        e.to === 'ALL' ? agents.filter((a) => a.id !== e.from).map((a) => a.id) : [e.to];
      toIds.forEach((toId) => {
        const toI = agents.findIndex((a) => a.id === toId);
        if (toI < 0 || toI === fromI) return;
        const fromY = centerY(fromI);
        const toY = centerY(toI);
        const d = toY - fromY;
        const x = 252;
        const bend = 56;
        pulses.push({
          id: `${evIndex}-${toId}`,
          path: `M ${x} ${fromY} C ${x - bend} ${fromY + d * 0.35}, ${x - bend} ${toY - d * 0.35}, ${x} ${toY}`,
          color: getAgent(e.from).color,
        });
      });
    });
  }

  /* ?agent= 深链：滚动定位 */
  useEffect(() => {
    if (!focusAgent || focusedRef.current) return;
    focusedRef.current = true;
    const i = agents.findIndex((a) => a.id === focusAgent);
    const el = laneRefs.current[i];
    if (el) {
      const t = window.setTimeout(
        () => el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' }),
        350,
      );
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [focusAgent]);

  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: easeLf, delay: 0.08 }}
      className="lf-card overflow-hidden"
      aria-label="Agent 泳道拓扑"
    >
      <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
        <div>
          <div className="lf-mono-label !text-[10.5px]">AGENT TOPOLOGY</div>
          <h3 className="mt-0.5 text-[16px] font-semibold text-ink">五体协同泳道</h3>
        </div>
        <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-ink-muted">
          <Package size={12} />
          {script.kpName} · {learner.name}
        </span>
      </div>

      <div ref={boardRef} className="relative">
        {/* 脉冲 SVG 覆盖层 */}
        <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full" aria-hidden>
          {pulses.map((p) => (
            <g key={p.id}>
              <animate attributeName="opacity" values="1;1;0" keyTimes="0;0.55;1" dur="0.9s" fill="freeze" />
              <path d={p.path} fill="none" stroke={p.color} strokeOpacity="0.35" strokeWidth="1.2" strokeDasharray="3 5" />
              <circle r="8" fill="#E7B45A" opacity="0.25">
                <animateMotion dur="0.5s" fill="freeze" path={p.path} />
              </circle>
              <circle r="4" fill="#E7B45A">
                <animateMotion dur="0.5s" fill="freeze" path={p.path} />
              </circle>
            </g>
          ))}
        </svg>

        {agents.map((agent, i) => {
          const allMs = (milestones[agent.id] ?? []).filter((m) => m.at >= 0);
          const ms = allMs.filter((m) => m.at < cursor);
          const current = ms.length > 0 ? ms[ms.length - 1] : null;
          const involved =
            latest !== null && (latest.from === agent.id || latest.to === agent.id || latest.to === 'ALL');
          const active = involved && (running || status === 'paused');
          const focused = focusAgent === agent.id;
          const dotStatus = active ? 'thinking' : ms.length > 0 ? 'running' : 'idle';
          /* 泳道状态徽标：全部里程碑已达成 → 已完成；latest 派发方为本 Agent 且正在协同中 → 处理中；否则待命 */
          const laneStatus: LaneStatus =
            allMs.length > 0 && ms.length === allMs.length
              ? 'done'
              : latest !== null && latest.from === agent.id && running
                ? 'processing'
                : 'idle';
          return (
            <motion.div
              key={agent.id}
              ref={(el) => {
                laneRefs.current[i] = el;
              }}
              initial={{ opacity: 0, x: -24 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.45, ease: easeLf, delay: 0.12 + i * 0.08 }}
              className={cn(
                'relative flex h-[88px] items-stretch transition-colors duration-300',
                i > 0 && 'border-t border-hairline',
                focused && 'z-[5] ring-2 ring-inset ring-brand-amber/70',
              )}
              style={active ? { backgroundColor: `${agent.color}0D` } : undefined}
            >
              {/* 激活色条 */}
              <span
                className="absolute left-0 top-0 h-full w-[3px] origin-top transition-transform duration-200"
                style={{
                  backgroundColor: agent.color,
                  transform: active || focused ? 'scaleY(1)' : 'scaleY(0)',
                }}
              />

              {/* AgentChip + tooltip + 状态徽标/进度（同列两行，泳道高度不变） */}
              <div className="flex w-[236px] shrink-0 flex-col justify-center gap-1.5 pl-4">
                <div className="flex items-center gap-2">
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>
                          <AgentChip
                            agentId={agent.id}
                            size="md"
                            showStatus={false}
                            onClick={() => onSelectAgent(agent.id)}
                          />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent
                        side="right"
                        className="max-w-[280px] border-hairline bg-card-warm text-ink-2 shadow-warm"
                      >
                        <div className="font-mono text-[11px] font-medium" style={{ color: agent.color }}>
                          {agent.code} · {agent.en}
                        </div>
                        <div className="mt-1 text-[12px] leading-[18px]">{agent.detail}</div>
                        <div className="mt-1 font-mono text-[10.5px] text-ink-muted">
                          今日处理 {agent.todayCount} 次 · 均耗 {agent.avgLatency}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <span className="relative">
                    <LiveDot status={dotStatus} />
                    {involved && cursor > 0 && (
                      <motion.span
                        key={cursor}
                        className="absolute -inset-1.5 rounded-full border-2"
                        style={{ borderColor: agent.color }}
                        initial={{ opacity: 0.7, scale: 0.6 }}
                        animate={{ opacity: 0, scale: 1.7 }}
                        transition={{ duration: 0.8, ease: 'easeOut' }}
                      />
                    )}
                  </span>
                </div>
                {/* 实时状态徽标 + 里程碑进度 */}
                <div className="flex items-center gap-1.5 pl-[42px]">
                  <LaneStatusBadge status={laneStatus} />
                  <LaneProgress done={ms.length} total={allMs.length} color={agent.color} />
                </div>
              </div>

              {/* 工作区 */}
              <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5 px-4 py-2">
                <div className="flex items-center gap-3">
                  <TypeText
                    text={current ? current.label : '等待任务下发…'}
                    className={cn(
                      'truncate text-[13px] leading-[20px]',
                      current ? 'text-ink-2' : 'italic text-ink-muted',
                    )}
                  />
                  {active && running && <StripedProgress color={agent.color} />}
                </div>
                {ms.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {ms.flatMap((m) =>
                      m.chips.map((chip, ci) =>
                        chip.tone === 'kb' && chip.kbId ? (
                          <TraceBadge key={`${m.at}-${ci}`} kbId={chip.kbId} />
                        ) : (
                          <motion.button
                            key={`${m.at}-${ci}`}
                            type="button"
                            initial={{ scale: 0.7, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{ type: 'spring', stiffness: 260, damping: 20 }}
                            onClick={chip.draft ? () => setDraftView(chip.draft ?? null) : undefined}
                            className={cn(
                              'inline-flex items-center gap-1 rounded-[8px] border px-2 py-0.5 font-mono text-[10.5px] font-medium',
                              chipTone[chip.tone],
                              chip.draft && 'cursor-pointer transition-transform duration-150 hover:-translate-y-px',
                            )}
                          >
                            {chip.draft && <DraftChipIcon draft={chip.draft} />}
                            {chip.label}
                          </motion.button>
                        ),
                      ),
                    )}
                  </div>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>

      <DraftDialog draft={draftView} script={script} open={draftView !== null} onOpenChange={(v) => !v && setDraftView(null)} />
    </motion.section>
  );
}
