/**
 * ProfileForge — 画像建档生成过场（全屏覆盖，约 5s，可跳过）
 * 精简建档（/welcome）与精准定制（/onboarding）共用。
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Brain, Check, Crosshair, Gauge, Sparkles } from 'lucide-react';
import { knowledgePoints } from '@/data/knowledgePoints';
import { abilityName } from '@/data/abilityDimensions';
import type { ProfileForgeStep } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface ForgeData {
  name: string;
  avatar: string;
  scores: Record<string, number>;
  /** 目标置信度（精简 33 / 精准为实测均值） */
  confidence: number;
  method: 'quick' | 'full';
  /** 证据行（如：身份「转岗工程师」/ 理论自测 9 题） */
  evidence: string[];
  steps?: ProfileForgeStep[];
  blindSpots?: string[];
}

const CX = 180;
const CY = 150;
const R = 86;

function pt(i: number, v: number, radius = R): [number, number] {
  const a = ((-90 + i * 60) * Math.PI) / 180;
  const r = (radius * v) / 100;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

function labelPosition(i: number) {
  /* 标签半径刻意小于 viewBox 边缘，最长的「机器人运动学」也不会被裁切 */
  const [x, y] = pt(i, 100, 110);
  const anchor: 'start' | 'middle' | 'end' = i === 0 || i === 3 ? 'middle' : i === 1 || i === 2 ? 'start' : 'end';
  return { x, y: y + (i === 0 ? -3 : i === 3 ? 6 : 4), anchor };
}

export default function ProfileForge({ data, onDone }: { data: ForgeData; onDone: () => void }) {
  /** 0 证据 → 1 雷达 → 2 盲区 → 3 置信度 → 4 完成 */
  const [phase, setPhase] = useState(0);
  const [conf, setConf] = useState(0);

  const weakest = useMemo(() => {
    return [...knowledgePoints]
      .sort((a, b) => (data.scores[a.id] ?? 50) - (data.scores[b.id] ?? 50))
      .slice(0, 2)
      .map((kp) => kp.id);
  }, [data.scores]);

  const weakestNames = useMemo(
    () => data.blindSpots?.length
      ? data.blindSpots.join('、')
      : weakest.map((id) => knowledgePoints.find((kp) => kp.id === id)?.name).filter(Boolean).join('、'),
    [data.blindSpots, weakest],
  );

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 900),
      setTimeout(() => setPhase(2), 2400),
      setTimeout(() => setPhase(3), 3200),
      setTimeout(() => setPhase(4), 4200),
      /* 完成态多停留一会，让用户能看清结果，也给较矮视口留出滚动时间 */
      setTimeout(onDone, 6200),
    ];
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    /* 只在进入置信度阶段时执行一次；phase=4 时不能从 0 重新滚动 */
    if (phase !== 3) return;
    const start = Date.now();
    const timer = setInterval(() => {
      const progress = Math.min(1, (Date.now() - start) / 700);
      setConf(Math.round(data.confidence * (1 - (1 - progress) ** 3)));
      if (progress >= 1) clearInterval(timer);
    }, 40);
    return () => clearInterval(timer);
  }, [phase, data.confidence]);

  const stepIcons = [Brain, Sparkles, Crosshair, Gauge];
  const stepLines = data.steps && data.steps.length
    ? data.steps.map((step, index) => ({
        icon: stepIcons[index] ?? Gauge,
        text: step.text,
        detail: step.detail,
        at: index,
      }))
    : [
        { icon: Brain, text: '汇总建档信息', detail: '构建学习背景先验', at: 0 },
        { icon: Sparkles, text: '生成能力向量', detail: '计算六维能力起点', at: 1 },
        { icon: Crosshair, text: '定位提升重点', detail: '安排优先学习路径', at: 2 },
        { icon: Gauge, text: '评估画像置信度', detail: '设置后续校准节奏', at: 3 },
      ];

  const phaseText = phase === 4 ? '画像已准备好' : stepLines[Math.min(phase, 3)].detail;
  const progress = phase === 4 ? 100 : [18, 42, 68, 86][phase];

  return createPortal(
    <div
      className="lf-fade-in fixed inset-0 z-50 overflow-y-auto px-4 py-3 sm:px-6 sm:py-4"
      style={{ background: 'linear-gradient(155deg, #F7F6EF 0%, #F1F4ED 52%, #EDF3EE 100%)' }}
    >
      <div aria-hidden className="pointer-events-none fixed -left-28 -top-32 h-80 w-80 rounded-full bg-brand-tint/70 blur-3xl" />
      <div aria-hidden className="pointer-events-none fixed -bottom-36 -right-20 h-96 w-96 rounded-full bg-ochre-tint/45 blur-3xl" />

      <main className="relative mx-auto flex min-h-full w-full max-w-[920px] flex-col justify-center">
        <div className="mb-2 flex items-center justify-between px-1 sm:px-2">
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="" className="h-7 w-7" />
            <span className="font-serif text-[17px] font-semibold tracking-wide text-ink">智训云枢</span>
          </div>
          <span className="rounded-full border border-white/80 bg-white/45 px-3 py-1 text-[11px] font-medium text-ink-muted shadow-xs backdrop-blur">
            个性化学习计划生成中
          </span>
        </div>

        <section className="lf-card flex w-full flex-col overflow-hidden !rounded-[24px] md:max-h-[calc(100dvh-76px)]">
          <header className="relative shrink-0 border-b border-hairline/80 px-5 py-4 sm:px-7">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand/35 to-transparent" />
            <div className="flex items-center gap-3.5">
              <div className="relative shrink-0">
                <span className="absolute -inset-1 rounded-full bg-brand-tint" />
                <img src={data.avatar} alt={data.name} className="relative h-11 w-11 rounded-full border-2 border-white object-cover shadow-xs" />
                {phase >= 4 && (
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-card-warm bg-brand text-paper"
                  >
                    <Check size={10} strokeWidth={3} />
                  </motion.span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="font-serif text-[20px] font-semibold leading-tight text-ink sm:text-[22px]">
                  {phase < 4 ? '正在生成你的学情画像' : `建档完成，欢迎 ${data.name}`}
                </h1>
                <p className="mt-1 text-[12px] text-ink-muted">{phaseText}</p>
              </div>
              <div className="hidden text-right sm:block">
                <div className="font-mono text-[11px] font-medium tracking-wide text-brand">{progress}%</div>
                <div className="mt-0.5 text-[10.5px] text-ink-muted">{data.method === 'quick' ? '背景先验起档' : '完整测评建档'}</div>
              </div>
            </div>
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-paper-deep">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-brand/75 via-brand to-brand-success"
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
              />
            </div>
          </header>

          <div className="grid min-h-0 flex-1 overflow-y-auto overscroll-contain md:grid-cols-[minmax(0,0.9fr)_minmax(380px,1.1fr)]">
            <div className="min-w-0 px-5 py-4 sm:px-7 sm:py-5">
              <div className="lf-mono-label !text-[10px]">建档依据 · {data.evidence.length} 项</div>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {data.evidence.map((e, i) => (
                  <motion.span
                    key={e}
                    initial={{ opacity: 0, y: 8, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ delay: 0.12 + i * 0.14, type: 'spring', stiffness: 260, damping: 22 }}
                    className="max-w-full rounded-full border border-hairline bg-white/55 px-3 py-1.5 text-[11.5px] font-medium leading-[17px] text-ink-2 shadow-xs"
                  >
                    {e}
                  </motion.span>
                ))}
              </div>

              <div className="mt-4 space-y-1">
                {stepLines.map((step, index) => {
                  const active = phase === step.at;
                  const done = phase > step.at;
                  return (
                    <motion.div
                      key={step.text}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: phase >= step.at ? 1 : 0.42, x: 0 }}
                      transition={{ duration: 0.35 }}
                      className="relative flex min-h-[40px] items-center gap-3"
                    >
                      {index < stepLines.length - 1 && (
                        <span className={cn('absolute left-[15px] top-[30px] h-[16px] w-px', done ? 'bg-brand/45' : 'bg-hairline')} />
                      )}
                      <span
                        className={cn(
                          'relative z-10 flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border transition-colors',
                          done
                            ? 'border-brand bg-brand text-paper'
                            : active
                              ? 'border-brand-amber/60 bg-brand-amber-tint text-ochre shadow-[0_0_0_4px_rgba(246,231,198,0.45)]'
                              : 'border-hairline bg-paper text-ink-muted',
                        )}
                      >
                        {done ? <Check size={13} strokeWidth={2.5} /> : <step.icon size={13} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className={cn('text-[13px]', active ? 'font-semibold text-ink' : done ? 'font-medium text-ink-2' : 'text-ink-muted')}>
                          {step.text}
                        </div>
                        {active && <div className="mt-0.5 text-[10.5px] text-ink-muted">{step.detail}</div>}
                      </div>
                      {active && (
                        <motion.span
                          animate={{ opacity: [0.25, 1, 0.25] }}
                          transition={{ repeat: Infinity, duration: 1.1 }}
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand"
                        />
                      )}
                    </motion.div>
                  );
                })}
              </div>

              <div className="mt-3 min-h-[110px] space-y-2.5">
                <AnimatePresence>
                  {phase >= 2 && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex items-start gap-2.5 rounded-[12px] border border-brand-amber/45 bg-brand-amber-tint/35 px-3 py-2.5"
                    >
                      <Crosshair size={15} className="mt-0.5 shrink-0 text-ochre" />
                      <div className="min-w-0 text-[12px] leading-[19px] text-ink-2">
                        <span className="font-semibold text-ink">优先提升：{weakestNames}</span>
                        <span className="block text-ink-muted">学习路径会从这两项开始安排</span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <AnimatePresence>
                  {phase >= 3 && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex items-start gap-2.5 rounded-[12px] border border-brand/30 bg-brand-tint/45 px-3 py-2.5"
                    >
                      <Gauge size={15} className="mt-0.5 shrink-0 text-brand" />
                      <div className="min-w-0 flex-1 text-[12px] leading-[19px] text-ink-2">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="font-semibold text-ink">画像置信度</span>
                          <span className="font-display text-[18px] font-semibold text-brand tabular">{conf}%</span>
                          <span className="rounded-full bg-white/60 px-2 py-0.5 text-[10px] font-semibold text-brand">
                            {data.method === 'quick' ? '校准中' : '已测准'}
                          </span>
                        </div>
                        <p className="mt-0.5 text-ink-muted">
                          {data.method === 'quick' ? '前两讲会增加少量检查点，边学边把画像测准。' : '画像已完成测准，首日推荐将直接按此生成。'}
                        </p>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            <div className="flex min-w-0 flex-col border-t border-hairline/70 bg-gradient-to-br from-white/35 to-brand-tint/30 px-3 py-4 md:border-l md:border-t-0 sm:px-5">
              <div className="flex items-center justify-between px-2">
                <div>
                  <div className="text-[13px] font-semibold text-ink">六维能力起点</div>
                  <div className="mt-0.5 text-[10.5px] text-ink-muted">基于当前信息推算，后续学习将持续校准</div>
                </div>
                <span className="rounded-full border border-brand/20 bg-white/50 px-2.5 py-1 font-mono text-[9.5px] tracking-wide text-brand">
                  LIVE PROFILE
                </span>
              </div>

              <div className="relative mx-auto mt-1 w-full max-w-[420px] flex-1">
                <svg viewBox="0 0 360 300" className="block h-auto w-full" role="img" aria-label="六维能力雷达图">
                  {[0.33, 0.66, 1].map((grid) => (
                    <polygon
                      key={grid}
                      points={knowledgePoints.map((_, i) => pt(i, grid * 100).join(',')).join(' ')}
                      fill={grid === 0.66 ? 'rgba(233,242,236,0.22)' : 'none'}
                      stroke="#DDDCCF"
                      strokeWidth="1"
                    />
                  ))}
                  {knowledgePoints.map((kp, i) => {
                    const [x, y] = pt(i, 100);
                    return <line key={kp.id} x1={CX} y1={CY} x2={x} y2={y} stroke="#DCE6DE" strokeWidth="1" />;
                  })}

                  {phase >= 2 && (
                    <motion.polygon
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 0.2 }}
                      transition={{ duration: 0.55 }}
                      points={knowledgePoints.map((kp, i) => pt(i, data.scores[kp.id] ?? 50).join(',')).join(' ')}
                      fill="#4E7860"
                    />
                  )}

                  {phase >= 1 && knowledgePoints.map((kp, i) => {
                    const value = data.scores[kp.id] ?? 50;
                    const [x, y] = pt(i, value);
                    const label = labelPosition(i);
                    const isWeak = phase >= 2 && weakest.includes(kp.id);
                    return (
                      <g key={kp.id}>
                        <motion.line
                          x1={CX}
                          y1={CY}
                          initial={{ x2: CX, y2: CY }}
                          animate={{ x2: x, y2: y }}
                          transition={{ delay: i * 0.16, duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
                          stroke={isWeak ? '#D89C3D' : '#4E7860'}
                          strokeWidth="2.2"
                          strokeLinecap="round"
                        />
                        <motion.circle
                          initial={{ cx: CX, cy: CY, opacity: 0 }}
                          animate={{ cx: x, cy: y, opacity: 1, scale: isWeak ? [1, 1.35, 1] : 1 }}
                          transition={{ delay: i * 0.16, duration: 0.48, scale: { repeat: isWeak ? Infinity : 0, duration: 1.25 } }}
                          r="4.5"
                          fill={isWeak ? '#D89C3D' : '#4E7860'}
                          stroke="#FBFAF5"
                          strokeWidth="2"
                        />
                        <motion.text
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: 0.2 + i * 0.16 }}
                          x={label.x}
                          y={label.y}
                          textAnchor={label.anchor}
                          fontSize="10.5"
                          fontWeight={isWeak ? 600 : 500}
                          fill={isWeak ? '#B77552' : '#5A6553'}
                          fontFamily='"Noto Sans SC", sans-serif'
                        >
                          {abilityName(kp.id, kp.name)} {value}
                        </motion.text>
                      </g>
                    );
                  })}
                  <circle cx={CX} cy={CY} r="3" fill="#FBFAF5" stroke="#4E7860" strokeWidth="1.5" />
                </svg>

                <AnimatePresence>
                  {phase >= 4 && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.85 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ type: 'spring', stiffness: 220, damping: 18 }}
                      className="absolute inset-x-10 bottom-3 flex items-center justify-center gap-2 rounded-full border border-white/80 bg-white/75 px-4 py-2 text-[12px] font-semibold text-brand shadow-warm backdrop-blur"
                    >
                      <span className="lf-orb flex h-5 w-5 items-center justify-center">
                        <Check size={11} strokeWidth={3} className="text-paper" />
                      </span>
                      个性化学习计划已就绪
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>

          <footer className="flex shrink-0 items-center justify-between border-t border-hairline/70 bg-white/25 px-5 py-3 sm:px-7">
            <p className="text-[10.5px] text-ink-muted">预计用时约 6 秒 · 完成后自动进入学习空间</p>
            <button
              type="button"
              onClick={onDone}
              className="rounded-full px-3 py-1.5 text-[11.5px] font-medium text-ink-muted transition-colors hover:bg-white/55 hover:text-brand"
            >
              跳过动画 →
            </button>
          </footer>
        </section>
      </main>
    </div>,
    document.body,
  );
}
