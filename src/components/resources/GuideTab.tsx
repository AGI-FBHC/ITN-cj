/**
 * GuideTab — 实操指南（resources.md TAB 2）
 * 五步安全检查清单：LOTO 安全门控（4 项 toggle 全部确认前 S1 不可勾选）
 * 进度条生长 · 勾选描画 · 全部完成撒花 + toast · 右栏要点/失误/CTA
 */
import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ShieldAlert,
  ShieldCheck,
  Clock3,
  Wrench,
  Lock,
  ArrowRight,
  PartyPopper,
} from 'lucide-react';
import { toast } from 'sonner';
import TraceBadge, { withTraceBadges } from '@/components/TraceBadge';
import SafetyBadge from '@/components/resources/SafetyBadge';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { GeneratedResource } from '@/data/resources';
import type { Learner } from '@/data/learners';
import { getKBSlice } from '@/data/kbSlices';
import { useAgent } from '@/context/AgentContext';
import { cn } from '@/lib/utils';

const safetyToggles = ['急停已测试', '围栏已闭合', 'PPE 已穿戴', '能量源已隔离（LOTO）'];

const stepMinutes = [8, 6, 7, 9, 5];

/** 常见失误 TOP3（page-local，按画像差异化） */
const topMistakes: Record<string, string[]> = {
  lin: [
    '刻线错位超过一格仍强行写入零点',
    '跳过预热直接在冷机状态标定',
    '复测只跑 1 个教学点就判定合格',
  ],
  chen: [
    '为赶进度短接围栏门联锁',
    '未卸载工装直接回零',
    '忘记互检签字就上电运行',
  ],
  zhao: [
    '凭经验跳过 JHA 风险评估表',
    '温度补偿系数直接抄手册默认值',
    '标定数据未归档至设备台账',
  ],
};

/** 实操要点（page-local） */
const keyPoints: Record<string, string[]> = {
  lin: [
    '先理解「以为 vs 真实」再动手：每步都要说出判据',
    '百分表读数波动 ≤ 0.02 mm 才算精对零到位',
    '超差不返工重来，回到第 2 步逐级排查',
  ],
  chen: [
    '安全确认不走过场：联锁、急停、互检一个不少',
    '刻线对齐后让同伴互检，养成双人确认习惯',
    '记录本同步登记编码器值与室温',
  ],
  zhao: [
    '把 JHA 表当作电气作业票来执行',
    '低于 10 ℃ 先执行 10 min 低速预热程序',
    'k 值按五点恒温实验拟合，不抄默认值',
  ],
};

const tools = ['标定靶', '千分表', '扭矩扳手', '示教器'];

/** 确定性伪随机（避免渲染期调用 Math.random） */
const seeded = (i: number, salt: number) => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** 纸屑粒子（12 枚暖色，1.2s） */
function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => ({
        x: (i - 5.5) * 26 + (seeded(i, 1) - 0.5) * 20,
        y: -(40 + seeded(i, 2) * 70),
        rotate: seeded(i, 3) * 360,
        color: ['#4E7860', '#B77552', '#E7B45A', '#6BA080'][i % 4],
        delay: seeded(i, 4) * 0.15,
      })),
    [],
  );
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
      {pieces.map((p, i) => (
        <motion.span
          key={i}
          initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 1 }}
          animate={{ x: p.x, y: [0, p.y, 90], opacity: [1, 1, 0], rotate: p.rotate, scale: [1, 1, 0.6] }}
          transition={{ duration: 1.2, delay: p.delay, ease: [0.22, 1, 0.36, 1] }}
          className="absolute h-2 w-3 rounded-[2px]"
          style={{ backgroundColor: p.color }}
        />
      ))}
    </div>
  );
}

export default function GuideTab({
  resource,
  learner,
  onGotoQuiz,
}: {
  resource: GeneratedResource;
  learner: Learner;
  onGotoQuiz: () => void;
}) {
  const steps = resource.steps ?? [];
  const [checked, setChecked] = useState<boolean[]>(() => steps.map(() => false));
  const [safety, setSafety] = useState<boolean[]>(() => safetyToggles.map(() => false));
  const [celebrated, setCelebrated] = useState(false);
  const { pushSignal } = useAgent();

  const safetyAll = safety.every(Boolean);
  const doneCount = checked.filter(Boolean).length;
  const allDone = doneCount === steps.length && steps.length > 0;
  const dangerCount = steps.filter((s) => s.safety === 'danger').length;

  const toggleStep = (idx: number) => {
    if (idx === 0 && !safetyAll) {
      toast.warning('请先完成安全检查清单', {
        description: '急停 / 围栏 / PPE / 能量隔离（LOTO）四项全部确认后，S1 才能打卡。',
      });
      return;
    }
    setChecked((prev) => {
      const next = prev.map((v, i) => (i === idx ? !v : v));
      if (next.every(Boolean) && !celebrated) {
        setCelebrated(true);
        toast.success('实操已打卡，已同步至学情报告', {
          description: `${learner.name} · ${resource.title} · 完成度 5/5`,
        });
        /* 上报阿诊：实操打卡是硬证据 */
        pushSignal({ type: 'guide-complete', kpId: resource.kpId, title: resource.title });
      }
      if (!next.every(Boolean)) setCelebrated(false);
      return next;
    });
  };

  return (
    <div className="grid grid-cols-12 gap-6">
      {/* ---------- 左：步骤主列 ---------- */}
      <div className="col-span-12 lg:col-span-8">
        {/* 进度卡 */}
        <div className="lf-card relative p-5">
          <AnimatePresence>{allDone && <Confetti />}</AnimatePresence>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-serif text-[19px] font-semibold leading-[27px] text-ink">
                {resource.title}
              </h3>
              <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[11.5px] text-ink-muted">
                <span className="flex items-center gap-1">
                  <Clock3 size={12} /> 预计 35 分钟
                </span>
                <span className="flex items-center gap-1">
                  <Wrench size={12} /> 所需工具
                </span>
                {tools.map((t) => (
                  <span
                    key={t}
                    className="rounded-md border border-hairline bg-paper px-1.5 py-px text-[11px] text-ink-2"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
            <div className="text-right">
              <div className="font-display text-[26px] font-semibold leading-none text-brand tabular">
                {doneCount}
                <span className="text-[15px] text-ink-muted">/{steps.length}</span>
              </div>
              <div className="mt-1 font-mono text-[10.5px] text-ink-muted">完成度</div>
            </div>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-paper-deep">
            <motion.div
              className="h-full rounded-full bg-brand"
              initial={false}
              animate={{ width: `${(doneCount / Math.max(1, steps.length)) * 100}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
            />
          </div>
          {allDone && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-3 flex items-center gap-2 rounded-lg border border-brand/30 bg-brand-tint px-3 py-2 text-[13px] font-medium text-brand"
            >
              <PartyPopper size={15} /> 五步全部完成 · 实操打卡成功
            </motion.div>
          )}
        </div>

        {/* 步骤卡 */}
        <div className="mt-4 space-y-3">
          {steps.map((step, i) => {
            const locked = i === 0 && !safetyAll;
            const isDone = checked[i];
            /* 「依据」小字：该步骤 kbRefs 第一条的标准号+标题，无 kbRefs 则不取 */
            const evidenceSlice = step.kbRefs?.[0] ? getKBSlice(step.kbRefs[0]) : undefined;
            return (
              <motion.div
                key={step.title}
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.08 * i, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                className={cn(
                  'lf-card group flex items-start gap-4 p-5 transition-all duration-200 ease-lf',
                  isDone && 'border-brand/40 bg-brand-tint/30',
                  step.safety === 'danger' && 'border-l-2 border-l-brand-danger/40',
                )}
              >
                {/* 序号圆 */}
                <span
                  className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-full border font-mono text-[13px] font-semibold transition-colors duration-300',
                    isDone
                      ? 'border-brand bg-brand text-paper'
                      : 'border-hairline bg-paper text-ink-2',
                  )}
                >
                  {isDone ? (
                    <motion.svg
                      viewBox="0 0 16 16"
                      className="h-4 w-4"
                      initial={false}
                    >
                      <motion.path
                        d="M3 8.5 L6.5 12 L13 4.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        initial={{ pathLength: 0 }}
                        animate={{ pathLength: 1 }}
                        transition={{ duration: 0.3 }}
                      />
                    </motion.svg>
                  ) : (
                    `S${i + 1}`
                  )}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-[15.5px] font-semibold text-ink">{step.title}</h4>
                    {i === 0 && (
                      <span className="inline-flex items-center gap-1 rounded-md border border-brand-amber/50 bg-brand-amber-tint px-1.5 py-px text-[11px] font-medium text-ochre">
                        <ShieldAlert size={11} /> 安全步骤
                      </span>
                    )}
                    {step.safety && <SafetyBadge level={step.safety} />}
                    <span className="rounded-md bg-paper-deep px-1.5 py-px font-mono text-[10.5px] text-ink-muted">
                      ~{stepMinutes[i] ?? 6} min
                    </span>
                  </div>
                  <p className="mt-1.5 text-[13.5px] leading-[22px] text-ink-2">{step.desc}</p>
                  {step.warning && (
                    <p className="mt-2 rounded-lg border border-brand-amber/40 bg-brand-amber-tint px-2.5 py-1.5 text-[12px] leading-[18px] text-ochre">
                      {withTraceBadges(step.warning)}
                    </p>
                  )}
                  <div className="mt-2.5 flex flex-wrap gap-1">
                    {step.kbRefs?.map((id) => <TraceBadge key={id} kbId={id} />)}
                  </div>
                  {evidenceSlice && (
                    <p className="mt-1.5 max-h-0 overflow-hidden font-mono text-[10.5px] text-ink-muted opacity-0 transition-all duration-200 ease-lf group-hover:max-h-6 group-hover:opacity-100">
                      依据：{evidenceSlice.standardNo ?? evidenceSlice.source} · {evidenceSlice.title}
                    </p>
                  )}
                </div>

                {/* 大 checkbox（S1 受 LOTO 门控） */}
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => toggleStep(i)}
                        aria-label={`完成步骤 S${i + 1}`}
                        className={cn(
                          'flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border-2 transition-all duration-200 ease-lf',
                          isDone
                            ? 'border-brand bg-brand text-paper'
                            : locked
                              ? 'cursor-not-allowed border-hairline bg-paper-deep text-ink-muted/50'
                              : 'border-hairline bg-paper text-transparent hover:border-brand/50',
                        )}
                      >
                        {locked ? <Lock size={15} /> : (
                          <svg viewBox="0 0 16 16" className="h-4 w-4">
                            <motion.path
                              d="M3 8.5 L6.5 12 L13 4.5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.4"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              initial={false}
                              animate={{ pathLength: isDone ? 1 : 0 }}
                              transition={{ duration: 0.3 }}
                            />
                          </svg>
                        )}
                      </button>
                    </TooltipTrigger>
                    {locked && (
                      <TooltipContent className="max-w-[240px] border-hairline bg-card-warm text-ink-2 shadow-warm">
                        完成下方「安全检查清单」4 项确认后解锁
                      </TooltipContent>
                    )}
                  </Tooltip>
                </TooltipProvider>
              </motion.div>
            );
          })}
        </div>

        {/* 安全统计：本指南高危步骤一览，呼应「安全可信」证据 */}
        <div className="mt-4 flex items-center gap-1.5 font-mono text-[11px] text-ink-muted">
          <ShieldCheck size={12} className="text-brand" />
          本指南 {dangerCount} 个高危步骤 · 全部持牌可溯
        </div>

        {/* 安全检查清单（LOTO 门控） */}
        <div className="mt-2 rounded-[14px] border border-brand-amber/40 bg-brand-amber-tint p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="flex items-center gap-2 text-[15px] font-semibold text-ochre">
              <ShieldAlert size={16} /> 安全检查清单 · 能量隔离（LOTO）
            </h4>
            <span className="font-mono text-[11px] text-ochre">
              {safety.filter(Boolean).length}/4 已确认
            </span>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {safetyToggles.map((label, i) => (
              <label
                key={label}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-3 rounded-[10px] border bg-card-warm px-3.5 py-2.5 transition-colors',
                  safety[i] ? 'border-brand/50' : 'border-hairline',
                )}
              >
                <span className="flex items-center gap-2 text-[13.5px] font-medium text-ink-2">
                  {safety[i] ? (
                    <ShieldCheck size={15} className="text-brand" />
                  ) : (
                    <ShieldAlert size={15} className="text-ink-muted" />
                  )}
                  {label}
                </span>
                <Switch
                  checked={safety[i]}
                  onCheckedChange={(v) =>
                    setSafety((prev) => prev.map((x, j) => (j === i ? v : x)))
                  }
                />
              </label>
            ))}
          </div>
          <p className="mt-3 font-mono text-[11px] leading-[17px] text-ochre">
            四项全部确认后 S1「{steps[0]?.title ?? '作业安全确认'}」方可打卡 —— 安全规范是运维第一课。
          </p>
        </div>

        {/* 风险警示 */}
        {resource.safetyNotice && (
          <div className="mt-4 rounded-[14px] border border-brand-danger/35 bg-brand-danger/5 p-5">
            <div className="flex items-start gap-3">
              <ShieldAlert size={18} className="mt-0.5 shrink-0 text-brand-danger" />
              <p className="text-[13.5px] leading-[22px] text-ink-2">
                <span className="mr-2 font-semibold text-brand-danger">风险警示</span>
                {withTraceBadges(resource.safetyNotice)}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ---------- 右栏 ---------- */}
      <aside className="col-span-12 space-y-4 lg:col-span-4">
        <div className="lf-card overflow-hidden">
          <div className="relative h-[120px] overflow-hidden border-b border-hairline">
            <img
              src="/robot-arm.png"
              alt="机械臂标定示意"
              className="h-full w-full object-cover"
            />
            <span className="absolute bottom-2 left-3 rounded-md bg-paper/90 px-2 py-0.5 font-mono text-[10px] tracking-wide text-brand backdrop-blur">
              KEY POINTS · 实操要点
            </span>
          </div>
          <ul className="space-y-2.5 p-5">
            {(keyPoints[learner.id] ?? keyPoints.lin).map((k, i) => (
              <li key={k} className="flex items-start gap-2.5 text-[13px] leading-[21px] text-ink-2">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-brand-tint font-mono text-[10.5px] font-semibold text-brand">
                  {i + 1}
                </span>
                {k}
              </li>
            ))}
          </ul>
        </div>

        <div className="lf-card p-5">
          <div className="lf-mono-label">TOP 3 · 常见失误</div>
          <ul className="mt-3 space-y-2.5">
            {(topMistakes[learner.id] ?? topMistakes.lin).map((m, i) => (
              <li
                key={m}
                className="flex items-start gap-2.5 rounded-[10px] border border-brand-danger/20 bg-brand-danger/[0.04] px-3 py-2 text-[12.5px] leading-[20px] text-ink-2"
              >
                <span className="mt-0.5 font-mono text-[11px] font-semibold text-brand-danger">
                  {String(i + 1).padStart(2, '0')}
                </span>
                {m}
              </li>
            ))}
          </ul>
        </div>

        <div className="lf-card p-5">
          <div className="lf-mono-label">NEXT · 完成后</div>
          <p className="mt-2 text-[13px] leading-[21px] text-ink-2">
            实操打卡后建议立即用分阶题巩固，系统会把错题回写画像并推送导学。
          </p>
          <button type="button" onClick={onGotoQuiz} className="lf-btn-primary mt-3 w-full">
            去做分阶题巩固 <ArrowRight size={15} />
          </button>
        </div>
      </aside>
    </div>
  );
}
