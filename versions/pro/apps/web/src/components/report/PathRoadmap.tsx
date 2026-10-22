/**
 * PathRoadmap — 学习路径规划图（report.md S4，全宽横向 SVG 路线图）
 * 4 阶段节点群（done/active/todo/locked）+ 贝塞尔主路径描线 + 「我在这」旗标 + 阶段详情抽屉
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { BookOpen, Crosshair, Wrench, Award, Check, Lock, SlidersHorizontal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Learner } from '@/data/learners';
import type { LearnerReport, PathNodeStatus } from '@/data/reportData';
import type { RagTree } from '@/lib/api';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import { getResourcesFor } from '@/data/resources';
import { useProfile } from '@/context/ProfileContext';
import { reducedMotion } from '@/components/agents/usePlayback';
import TraceBadge from '@/components/TraceBadge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

const VB_W = 1120;
const VB_H = 320;

interface Stage {
  key: string;
  num: string;
  name: string;
  icon: LucideIcon;
  status: PathNodeStatus;
  x: number;
  y: number;
}

const STAGE_DEFS: Stage[] = [
  { key: 's1', num: '①', name: '基础巩固', icon: BookOpen, status: 'done', x: 110, y: 110 },
  { key: 's2', num: '②', name: '专项突破', icon: Crosshair, status: 'active', x: 410, y: 168 },
  { key: 's3', num: '③', name: '实操演练', icon: Wrench, status: 'todo', x: 710, y: 110 },
  { key: 's4', num: '④', name: '综合考核', icon: Award, status: 'locked', x: 1010, y: 168 },
];

const statusText: Record<PathNodeStatus, string> = {
  done: '已完成 ✓',
  active: '进行中 ◐',
  todo: '待解锁 ○',
  locked: '待解锁 ○',
};

const standardText: Record<PathNodeStatus, string> = {
  done: '已完成阶段测评与配套资源，资源完成度 100%。',
  active: '完成全部已配资源学习与阶段测评后自动推进。',
  todo: '完成前置阶段后解锁，资源由 GEN-03 预生成排队中。',
  locked: '完成综合测评并通过企业导师线上评审后解锁。',
};

const pct = (v: number, base: number) => `${(v / base) * 100}%`;
const STAGE_NUMS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
const ICON_POOL: LucideIcon[] = [BookOpen, Crosshair, Wrench, Award, BookOpen, Crosshair, Wrench, Award];

function topTreeStages(tree?: RagTree | null): Stage[] {
  const roots = (tree?.nodes ?? [])
    .filter((node) => node.level === 1)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  if (!roots.length) return [];
  const left = 120;
  const right = VB_W - 120;
  return roots.map((root, index) => ({
    key: root.nodeCode || `root-${root.id}`,
    num: STAGE_NUMS[index] ?? String(index + 1),
    name: root.name,
    icon: ICON_POOL[index % ICON_POOL.length],
    status: 'todo',
    x: roots.length === 1 ? VB_W / 2 : Math.round(left + ((right - left) * index) / Math.max(1, roots.length - 1)),
    y: index % 2 === 0 ? 112 : 172,
  }));
}

export default function PathRoadmap({
  learner,
  report,
  tree,
}: {
  learner: Learner;
  report: LearnerReport;
  tree?: RagTree | null;
}) {
  const [selected, setSelected] = useState<Stage | null>(null);
  const { viewMode } = useProfile();
  const isLearner = viewMode === 'learner';
  const navigate = useNavigate();

  /* 预设画像：沿用静态 4 阶段叙事（①已完成…）；
     自建画像：阶段状态由真实完成度推导——刚建档 = ①进行中、②③待学、④锁定 */
  const stages = useMemo<Stage[]>(() => {
    if (!report.generated) return STAGE_DEFS;
    const total = report.path.length || 1;
    const frac = report.path.filter((n) => n.status === 'done').length / total;
    const treeStages = topTreeStages(tree);
    const defs = treeStages.length ? treeStages : STAGE_DEFS;
    const last = defs.length - 1;
    return defs.map((s, i) => {
      let status: PathNodeStatus;
      if (i === last) status = frac >= 1 ? 'done' : 'locked';
      else if (frac >= (i + 1) / Math.max(1, last)) status = 'done';
      else if (frac >= i / Math.max(1, last)) status = 'active';
      else status = 'todo';
      return { ...s, status };
    });
  }, [report, tree]);

  const stageNodes = useMemo(() => {
    const map = new Map<string, typeof report.path>();
    if (report.generated) {
      /* 自建：路径节点按顺序均分进各顶层目录 */
      const chunk = Math.ceil(report.path.length / stages.length) || 1;
      stages.forEach((s, i) => map.set(s.key, report.path.slice(i * chunk, (i + 1) * chunk)));
    } else {
      stages.forEach((s) => map.set(s.key, report.path.filter((n) => n.status === s.status)));
    }
    return map;
  }, [report, stages]);

  const connectorPaths = useMemo(
    () => stages.slice(0, -1).map((stage, index) => {
      const next = stages[index + 1];
      const midX = Math.round((stage.x + next.x) / 2);
      return `M${stage.x},${stage.y} C${midX},${stage.y} ${midX},${next.y} ${next.x},${next.y}`;
    }),
    [stages],
  );

  const kbOfStage = (stage: Stage): string[] => {
    const nodes = stageNodes.get(stage.key) ?? [];
    const ids = new Set<string>();
    nodes.forEach((n) => {
      getResourcesFor(learner.id)
        .filter((r) => r.kpId === n.kpId)
        .forEach((r) => r.kbRefs.slice(0, 2).forEach((id) => ids.add(id)));
    });
    return [...ids].slice(0, 3);
  };

  return (
    <div className="lf-card p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          {!isLearner && <div className="lf-mono-label mb-1">LEARNING PATH · {stages.length} STAGES</div>}
          <h3 className="text-[16px] font-semibold leading-[24px] text-ink">学习路径规划图</h3>
        </div>
        <button
          type="button"
          onClick={() => toast.info(
            isLearner ? '已提交调整申请' : '已提交 ARB-05 重排',
            { description: '路径调整将在当前阶段测评完成后生效' },
          )}
          className="lf-btn-ghost !px-3.5 !py-1.5 !text-[13px]"
        >
          <SlidersHorizontal size={14} strokeWidth={1.75} />
          调整路径
        </button>
      </div>

      <div className="overflow-x-auto">
        <div className="relative min-w-[960px]" style={{ aspectRatio: `${VB_W} / ${VB_H}` }}>
          {/* SVG 主路径：段样式随左端阶段状态（done 墨绿实线 / active 琥珀流动 / 其余纸灰虚线） */}
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="none"
            aria-hidden
          >
            {connectorPaths.map((d, i) => {
              const st = stages[i].status;
              const pathId = `lf-roadmap-path-${i}`;
              if (st === 'done') {
                return (
                  <g key={d}>
                    <motion.path
                      id={pathId}
                      d={d}
                      stroke="#4E7860"
                      strokeWidth={3}
                      fill="none"
                      strokeLinecap="round"
                      initial={{ pathLength: 0 }}
                      whileInView={{ pathLength: 1 }}
                      viewport={{ once: true, amount: 0.4 }}
                      transition={{ duration: 1.4, ease: 'easeInOut' }}
                    />
                    {/* 已完成段：沿路径流动的墨绿小圆点，呼应首页拓扑图的琥珀脉冲写法 */}
                    {!reducedMotion() && (
                      <g>
                        <circle r="7" fill="#4E7860" opacity="0.22">
                          <animateMotion dur="2.2s" begin={`${i * -0.5}s`} repeatCount="indefinite">
                            <mpath href={`#${pathId}`} />
                          </animateMotion>
                        </circle>
                        <circle r="3.5" fill="#4E7860">
                          <animateMotion dur="2.2s" begin={`${i * -0.5}s`} repeatCount="indefinite">
                            <mpath href={`#${pathId}`} />
                          </animateMotion>
                        </circle>
                      </g>
                    )}
                  </g>
                );
              }
              if (st === 'active') {
                return (
                  <motion.path
                    key={d}
                    d={d}
                    stroke="#E7B45A"
                    strokeWidth={3}
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray="6 6"
                    className="animate-dash-flow"
                    initial={{ opacity: 0 }}
                    whileInView={{ opacity: 1 }}
                    viewport={{ once: true, amount: 0.4 }}
                    transition={{ duration: 0.6, delay: 0.7 }}
                  />
                );
              }
              return (
                <motion.path
                  key={d}
                  d={d}
                  stroke="#CFC8B8"
                  strokeWidth={3}
                  fill="none"
                  strokeLinecap="round"
                  strokeDasharray="3 8"
                  initial={{ opacity: 0 }}
                  whileInView={{ opacity: 1 }}
                  viewport={{ once: true, amount: 0.4 }}
                  transition={{ duration: 0.6, delay: 1.1 }}
                />
              );
            })}
          </svg>

          {/* 阶段节点 */}
          {stages.map((s, i) => {
            const nodes = stageNodes.get(s.key) ?? [];
            const doneN = nodes.filter((n) => n.status === 'done').length;
            const Icon = s.icon;
            return (
              <div key={s.key}>
                {/* 大圆节点 */}
                <motion.button
                  type="button"
                  onClick={() => setSelected(s)}
                  /* 居中位移交给 framer 的 x/y —— motion 的内联 transform 会覆盖 Tailwind 的 -translate 类 */
                  initial={{ scale: 0.8, opacity: 0, x: '-50%', y: '-50%' }}
                  whileInView={{ scale: 1, opacity: 1, x: '-50%', y: '-50%' }}
                  viewport={{ once: true, amount: 0.4 }}
                  transition={{ delay: 0.2 + i * 0.12, type: 'spring', stiffness: 260, damping: 18 }}
                  className="absolute z-10 cursor-pointer"
                  style={{ left: pct(s.x, VB_W), top: pct(s.y, VB_H) }}
                  aria-label={`阶段 ${s.num} ${s.name} 详情`}
                >
                  <span className="relative flex h-14 w-14 items-center justify-center">
                    {s.status === 'active' && (
                      <span className="absolute inset-0 animate-ping rounded-full bg-brand-amber/30" />
                    )}
                    <span
                      className={cn(
                        'relative flex h-14 w-14 items-center justify-center rounded-full transition-transform duration-200 hover:scale-105',
                        s.status === 'done' && 'border-2 border-brand bg-brand text-paper shadow-warm',
                        s.status === 'active' &&
                          'border-2 border-brand-amber bg-brand-amber-tint text-ochre shadow-warm',
                        s.status === 'todo' && 'border border-hairline bg-paper-deep text-ink-muted',
                        s.status === 'locked' &&
                          'border border-dashed border-hairline bg-paper-deep text-ink-muted',
                      )}
                    >
                      {s.status === 'done' ? (
                        <Check size={24} strokeWidth={2.2} />
                      ) : s.status === 'locked' ? (
                        <Lock size={20} strokeWidth={1.75} />
                      ) : (
                        <Icon size={22} strokeWidth={1.75} />
                      )}
                    </span>
                    {/* 阶段完成度徽标：该阶段路径节点 done 数 / 总数 */}
                    {nodes.length > 0 && (
                      <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-hairline bg-card-warm px-1 font-mono text-[9.5px] font-semibold text-ink-2 shadow-warm">
                        {doneN}/{nodes.length}
                      </span>
                    )}
                  </span>
                </motion.button>

                {/* 阶段标签（圆下方） */}
                <motion.div
                  /* 水平居中交给 framer 的 x —— motion 的内联 transform 会覆盖 Tailwind 的 -translate 类 */
                  initial={{ opacity: 0, y: 12, x: '-50%' }}
                  whileInView={{ opacity: 1, y: 0, x: '-50%' }}
                  viewport={{ once: true, amount: 0.4 }}
                  transition={{ delay: 0.3 + i * 0.12, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                  className="absolute w-[230px] text-center"
                  /* 边缘阶段（①/④）的标签钳制在容器内，不悬出路线图 */
                  style={{
                    left: `clamp(115px, ${pct(s.x, VB_W)}, calc(100% - 115px))`,
                    top: `calc(${pct(s.y, VB_H)} + 38px)`,
                  }}
                >
                  <div className="text-[14px] font-semibold text-ink">
                    {s.num} {s.name}
                  </div>
                  <div
                    className={cn(
                      'mt-0.5 font-mono text-[10.5px] tracking-wide',
                      s.status === 'done' && 'text-brand',
                      s.status === 'active' && 'text-ochre',
                      (s.status === 'todo' || s.status === 'locked') && 'text-ink-muted',
                    )}
                  >
                    {statusText[s.status]}
                  </div>
                  <div className="mt-1.5 flex flex-wrap justify-center gap-1">
                    {nodes.map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        onClick={() => setSelected(s)}
                        className="rounded-md border border-hairline bg-card-warm px-1.5 py-px text-[10.5px] leading-[16px] text-ink-2 transition-colors hover:border-brand/40 hover:bg-brand-tint/60"
                      >
                        {n.title}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-ink-muted">
                    {nodes.map((n) => n.est).join(' · ')}
                  </div>
                </motion.div>
              </div>
            );
          })}

          {/* 「我在这」小旗标（当前节点上方，弹跳） */}
          {(() => {
            const active = stages.find((s) => s.status === 'active') ?? stages[0];
            return (
              <div
                className="pointer-events-none absolute z-20 -translate-x-1/2"
                style={{ left: pct(active.x, VB_W), top: `calc(${pct(active.y, VB_H)} - 76px)` }}
              >
                <motion.div
                  animate={{ y: [0, -6, 0] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
                  className="flex flex-col items-center"
                >
                  <span className="flex items-center gap-1.5 rounded-full border border-brand-amber/60 bg-card-warm px-2 py-1 shadow-warm">
                    <img
                      src={learner.avatar}
                      alt={learner.name}
                      className="h-5 w-5 rounded-full border border-hairline object-cover"
                    />
                    <span className="font-mono text-[10px] font-semibold text-ochre">我在这</span>
                  </span>
                  <span className="h-0 w-0 border-x-[5px] border-t-[6px] border-x-transparent border-t-brand-amber/70" />
                </motion.div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* 阶段详情抽屉 */}
      <Sheet open={selected !== null} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent side="right" className="w-[420px] border-hairline bg-paper sm:max-w-[420px]">
          {selected && (
            <>
              <SheetHeader>
                {!isLearner && <div className="lf-mono-label mb-1">STAGE DETAIL</div>}
                <SheetTitle className="font-serif text-[20px] text-ink">
                  阶段 {selected.num} · {selected.name}
                </SheetTitle>
                <SheetDescription className="font-mono text-[11.5px] text-ink-muted">
                  {statusText[selected.status]} · {learner.name}
                  {isLearner ? '' : ' · 路径由 ARB-05 编排'}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-4">
                {(() => {
                  const stageNodesSel = stageNodes.get(selected.key) ?? [];
                  const doneNSel = stageNodesSel.filter((n) => n.status === 'done').length;
                  const totalNSel = stageNodesSel.length;
                  const pctSel = totalNSel > 0 ? Math.round((doneNSel / totalNSel) * 100) : 0;
                  return (
                    <div>
                      <div className="mb-2 flex items-center justify-between font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-muted">
                        <span>本阶段完成度</span>
                        <span className="text-ink-2 tabular">{doneNSel}/{totalNSel || '—'}</span>
                      </div>
                      <div className="h-[6px] w-full overflow-hidden rounded-full bg-paper-deep">
                        <motion.div
                          className="h-full rounded-full bg-brand"
                          initial={{ width: 0 }}
                          animate={{ width: `${pctSel}%` }}
                          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                        />
                      </div>
                    </div>
                  );
                })()}
                <div>
                  <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-muted">
                    阶段资源
                  </div>
                  <div className="space-y-2.5">
                    {(stageNodes.get(selected.key) ?? []).map((n) => (
                      <div
                        key={n.id}
                        role={isLearner ? 'button' : undefined}
                        tabIndex={isLearner ? 0 : undefined}
                        onClick={isLearner ? () => navigate(`/learn/${n.kpId}`) : undefined}
                        onKeyDown={isLearner ? (e) => { if (e.key === 'Enter') navigate(`/learn/${n.kpId}`); } : undefined}
                        className={cn(
                          'rounded-[10px] border border-hairline bg-card-warm p-3.5 transition-colors',
                          isLearner && 'cursor-pointer hover:border-brand/40 hover:bg-brand-tint/30',
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[14px] font-medium text-ink">{n.title}</span>
                          <span className="font-mono text-[10.5px] text-ink-muted">{n.est}</span>
                        </div>
                        <div className="mt-1 text-[12.5px] leading-[19px] text-ink-2">
                          {getKnowledgePoint(n.kpId).name} · {n.resourceRef}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-1">
                          {getResourcesFor(learner.id)
                            .filter((r) => r.kpId === n.kpId)
                            .slice(0, 1)
                            .flatMap((r) => r.kbRefs.slice(0, 2))
                            .map((id) => (
                              <TraceBadge key={id} kbId={id} />
                            ))}
                          {isLearner && (
                            <span className="ml-auto text-[11px] font-medium text-brand">去学 →</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-muted">
                    完成标准
                  </div>
                  <p className="rounded-[10px] border border-hairline bg-card-warm p-3.5 text-[13px] leading-[21px] text-ink-2">
                    {standardText[selected.status]}
                  </p>
                </div>

                <div>
                  <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-muted">
                    本阶段 KB 溯源
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {kbOfStage(selected).map((id) => (
                      <TraceBadge key={id} kbId={id} />
                    ))}
                  </div>
                </div>

                <p className="border-t border-hairline pt-3 font-mono text-[11px] leading-[18px] text-ink-muted">
                  {isLearner
                    ? '完成当前阶段的测评后，会自动进入下一阶段'
                    : '完成当前阶段测评后自动推进 · 重排请求由 ARB-05 仲裁'}
                </p>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
