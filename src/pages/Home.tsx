/**
 * 总览 Dashboard `/` — home.md 实现
 * S1 Hero(3D) → S2 指标看板 → S3 五步闭环(GSAP 钉住) → S4 Agent 拓扑
 * → S5 实时动态+领域场景 → S6 资源速览 → S7 页脚
 *
 * 动效隔离约定：S1/S3 为 GSAP 专区（不使用 framer-motion）；
 * 其余区块使用 framer-motion whileInView。
 */
import { Component, Suspense, lazy, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';
import { useGSAP } from '@gsap/react';
import {
  Play,
  ArrowRight,
  ChevronDown,
  UserSearch,
  Network,
  PenLine,
  MessagesSquare,
  RefreshCw,
  Check,
  Star,
  Pause,
  Scale,
  Compass,
} from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { startDemoTour } from '@/components/tour/DemoTour';
import { coreMetrics, globalStats } from '@/data/metrics';
import { agents } from '@/data/agents';
import type { AgentId } from '@/data/agents';
import { knowledgePoints } from '@/data/knowledgePoints';
import { liveFeedSamples } from '@/data/collabScript';
import type { LiveFeedSample } from '@/data/collabScript';
import { getResourcesFor } from '@/data/resources';
import { getQuizByIds, quizLevelMeta } from '@/data/quizBank';
import MetricCard from '@/components/MetricCard';
import SectionHeader from '@/components/SectionHeader';
import AgentChip, { AgentIcon } from '@/components/AgentChip';
import LiveDot from '@/components/LiveDot';
import TraceBadge from '@/components/TraceBadge';
import TimelineItem from '@/components/TimelineItem';
import { cn } from '@/lib/utils';

gsap.registerPlugin(ScrollTrigger, SplitText);

const KnowledgeMap3DPanel = lazy(() => import('@/components/learn/KnowledgeMap3DPanel'));

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* WebGL 不可用时回退静态图 */
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="relative h-full w-full overflow-hidden rounded-[16px]">
          <img src="/hero-network.png" alt="多智能体网络拓扑" className="h-full w-full object-cover" />
          <div className="absolute inset-0 animate-glow-breathe bg-brand-amber/10" />
        </div>
      );
    }
    return this.props.children;
  }
}

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

/* ================= S1 Hero ================= */
function HeroSection() {
  const rootRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const navigate = useNavigate();
  const [can3d] = useState(() => webglAvailable() && !reducedMotion());

  useGSAP(
    () => {
      const q = gsap.utils.selector(rootRef);
      if (reducedMotion()) {
        gsap.set(q('[data-hero]'), { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' });
        return;
      }
      const split = new SplitText(titleRef.current!, { type: 'chars' });
      const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
      tl.fromTo(
        q('[data-hero="eyebrow"]'),
        { opacity: 0, y: 12 },
        { opacity: 1, y: 0, duration: 0.3 },
      )
        .fromTo(
          split.chars,
          { opacity: 0, y: 40, rotate: 4 },
          { opacity: 1, y: 0, rotate: 0, duration: 0.75, stagger: 0.045 },
          '-=0.05',
        )
        .fromTo(
          q('[data-hero="en"]'),
          { opacity: 0, filter: 'blur(6px)' },
          { opacity: 1, filter: 'blur(0px)', duration: 0.6 },
          '-=0.35',
        )
        .fromTo(
          q('[data-hero="sub"]'),
          { opacity: 0, y: 24 },
          { opacity: 1, y: 0, duration: 0.6 },
          '-=0.35',
        )
        .fromTo(
          q('[data-hero="cta"]'),
          { opacity: 0, scale: 0.94, y: 10 },
          { opacity: 1, scale: 1, y: 0, duration: 0.5, stagger: 0.1, ease: 'back.out(1.7)' },
          '-=0.3',
        )
        .fromTo(
          q('[data-hero="scene"]'),
          { opacity: 0, scale: 0.96 },
          { opacity: 1, scale: 1, duration: 1.2 },
          0.4,
        )
        .fromTo(
          q('[data-hero="scrollhint"]'),
          { opacity: 0 },
          { opacity: 1, duration: 0.5 },
          '-=0.6',
        );
      return () => split.revert();
    },
    { scope: rootRef },
  );

  return (
    <section ref={rootRef} className="relative overflow-hidden">
      <div className="lf-blueprint-bg absolute inset-0 opacity-40" aria-hidden />
      <div className="relative mx-auto grid max-w-[1320px] grid-cols-1 items-center gap-8 px-8 pb-16 pt-10 lg:min-h-[calc(100dvh-64px)] lg:grid-cols-12 lg:pb-10 lg:pt-0">
        {/* 左：文案 */}
        <div className="flex flex-col justify-center lg:col-span-5">
          <div
            data-hero="eyebrow"
            className="mb-6 inline-flex w-fit items-center gap-2 rounded-full border border-brand/40 bg-card-warm/80 px-3.5 py-1.5 font-mono text-[12px] tracking-wide text-brand"
          >
            <LiveDot status="running" />
            挑战杯·揭榜挂帅 XH-202630 · 上海云之脑智能科技有限公司
          </div>

          <h1
            ref={titleRef}
            className="font-serif text-[40px] leading-[1.18] font-bold tracking-[0.01em] text-ink xl:text-[56px]"
          >
            <span className="block whitespace-nowrap">让每一次技能培训</span>
            <span className="block whitespace-nowrap">都被精确地个性化</span>
          </h1>

          <p data-hero="en" className="mt-4 font-display text-[19px] italic leading-[26px] text-ochre">
            智训云枢 · Multi-Agent Personalized Training Engine
          </p>

          <p data-hero="sub" className="mt-5 max-w-[480px] text-[15px] leading-[26px] text-ink-2">
            以五个分工明确的智能体取代单体大模型：学情诊断锚定盲区，知识检索锁定权威标准，内容生成严格溯源，审核裁判交叉验证，决策仲裁动态调度。面向智能体工程与复杂能力训练场景。
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              data-hero="cta"
              type="button"
              onClick={() => navigate('/agents?autoplay=1')}
              className="lf-btn-primary group"
            >
              <Play size={15} className="transition-transform duration-200 group-hover:translate-x-[3px]" fill="currentColor" />
              开始协同演示
            </button>
            <button
              data-hero="cta"
              type="button"
              onClick={() => navigate('/profiles')}
              className="lf-btn-ghost"
            >
              查看学情画像
            </button>
            <button
              data-hero="cta"
              type="button"
              onClick={() => startDemoTour()}
              title="面向评委的 5 分钟自动串场：五步闭环，逐站讲解"
              className="lf-btn-ghost group"
            >
              <Compass size={15} className="transition-transform duration-200 group-hover:rotate-45" />
              评委 5 分钟导览
            </button>
          </div>
          <Link
            data-hero="cta"
            to="/knowledge"
            className="mt-4 inline-flex w-fit items-center gap-1.5 font-mono text-[12.5px] text-ink-muted transition-colors hover:text-brand"
          >
            浏览知识库 {globalStats.kbSlicesTotal.toLocaleString()} 条切片
            <ArrowRight size={13} />
          </Link>
        </div>

        {/* 右：3D 画布 */}
        <div data-hero="scene" className="relative h-[420px] lg:col-span-7 lg:h-[calc(100dvh-160px)] lg:min-h-[480px]">
          <SceneBoundary>
            {can3d ? (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <img
                      src="/hero-network.png"
                      alt="多智能体网络拓扑"
                      className="h-full w-full rounded-[16px] object-cover"
                    />
                  </div>
                }
              >
                <KnowledgeMap3DPanel className="!h-full" />
              </Suspense>
            ) : (
              <div className="relative h-full w-full overflow-hidden rounded-[16px]">
                <img src="/hero-network.png" alt="多智能体网络拓扑" className="h-full w-full object-cover" />
                <div className="absolute inset-0 animate-glow-breathe bg-brand-amber/10" />
              </div>
            )}
          </SceneBoundary>
          {/* 坐标彩蛋 */}
          <div className="pointer-events-none absolute bottom-3 right-1 font-mono text-[11px] tracking-[0.14em] text-ink-muted/80">
            31.2304°N, 121.4737°E · SHANGHAI
          </div>
        </div>
      </div>

      {/* 滚动提示 */}
      <div
        data-hero="scrollhint"
        className="pointer-events-none absolute bottom-5 left-1/2 hidden -translate-x-1/2 flex-col items-center gap-1.5 lg:flex"
      >
        <span className="h-8 w-px origin-top animate-breathe bg-ink-muted/70" />
        <ChevronDown size={13} className="text-ink-muted" />
        <span className="font-mono text-[10px] tracking-[0.2em] text-ink-muted">SCROLL · 探索闭环</span>
      </div>
    </section>
  );
}

/* ================= S2 指标看板 ================= */
function MetricsSection() {
  return (
    <section className="relative mx-auto max-w-[1320px] px-8 py-14">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {coreMetrics.map((m) => (
          <MetricCard key={m.id} metric={m} />
        ))}
      </div>
    </section>
  );
}

/* ================= S3 五步闭环（GSAP 钉住叙事） ================= */
const loopSteps = [
  {
    icon: UserSearch,
    name: '学情画像构建',
    en: 'PROFILE',
    desc: '整合学历背景与理论测试，锚定理论强项与技能盲区，输出六维画像向量。',
    detail: 'DIA-01 汇聚 6 维理论测试、学习行为与岗位目标，生成可追溯的画像向量 —— 这是一切个性化的输入。',
    href: '/profiles',
  },
  {
    icon: Network,
    name: '多智能体协同调度',
    en: 'COLLABORATION',
    desc: '诊断/检索/生成/审核/仲裁五体协同，消息实时流转，辩论消除幻觉。',
    detail: 'ARB-05 统一调度：任务拆解、泳道分发、分歧仲裁。2 轮辩论 + 交叉验证，把幻觉率压到 3.2%。',
    href: '/agents',
  },
  {
    icon: PenLine,
    name: '领域知识个性化生成',
    en: 'GENERATION',
    desc: '讲义、实操指南、分阶题目三种形态，逐条溯源零幻觉。',
    detail: 'GEN-03 基于 KB 切片约束生成：每个论断强制挂接 [KB-xxx] 溯源角标，不过审不发布。',
    href: '/resources',
  },
  {
    icon: MessagesSquare,
    name: '交互反馈',
    en: 'FEEDBACK',
    desc: '苏格拉底启发式追问与答题交互，正确率实时回流。',
    detail: '导学 Agent 三阶追问（引导→追问→确认），每一次作答都成为画像更新的证据。',
    href: '/tutoring',
  },
  {
    icon: RefreshCw,
    name: '动态决策更新',
    en: 'DECISION',
    desc: '仲裁 Agent 依据反馈下发降维解释或进阶挑战，画像随之更新。',
    detail: '正确率 < 60% 触发「降维解释」，≥ 85% 触发「进阶挑战」—— 画像回流第 1 步，闭环成环。',
    href: '/report',
  },
];

function ClosedLoopSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const axisRef = useRef<HTMLDivElement>(null);
  const arcRef = useRef<SVGPathElement>(null);
  const [active, setActive] = useState(0);
  const [arcVisible, setArcVisible] = useState(false);
  const stateRef = useRef({ active: 0, arc: false });
  const navigate = useNavigate();

  useGSAP(
    () => {
      const reduced = reducedMotion();
      const arc = arcRef.current;
      const arcLen = arc ? arc.getTotalLength() : 0;
      if (arc) {
        arc.style.strokeDasharray = `${arcLen}`;
        arc.style.strokeDashoffset = `${arcLen}`;
      }
      if (reduced) {
        setActive(4);
        if (axisRef.current) axisRef.current.style.transform = 'scaleX(1)';
        if (arc) arc.style.strokeDashoffset = '0';
        setArcVisible(true);
        return;
      }
      const st = ScrollTrigger.create({
        trigger: sectionRef.current,
        start: 'top top',
        end: '+=200%',
        pin: true,
        scrub: 0.6,
        onUpdate: (self) => {
          const p = self.progress;
          if (axisRef.current) {
            axisRef.current.style.transform = `scaleX(${Math.min(1, p * 1.06)})`;
          }
          const seg = Math.min(4, Math.floor(p * 5));
          if (seg !== stateRef.current.active) {
            stateRef.current.active = seg;
            setActive(seg);
          }
          const arcP = Math.min(1, Math.max(0, p * 5 - 4));
          if (arc) arc.style.strokeDashoffset = `${arcLen * (1 - arcP)}`;
          const show = arcP > 0.5;
          if (show !== stateRef.current.arc) {
            stateRef.current.arc = show;
            setArcVisible(show);
          }
        },
      });
      return () => st.kill();
    },
    { scope: sectionRef },
  );

  const step = loopSteps[active];

  return (
    <section ref={sectionRef} className="relative overflow-hidden bg-paper-deep/60">
      <div className="lf-blueprint-bg absolute inset-0 opacity-40" aria-hidden />
      <div className="relative mx-auto flex min-h-[100dvh] max-w-[1320px] flex-col justify-center px-8 py-16">
        {/* 段头（GSAP 专区，静态呈现） */}
        <div className="mb-10">
          <div className="lf-mono-label mb-2 flex items-center gap-2">
            <span className="inline-block h-px w-6 bg-brand/40" />
            CLOSED LOOP
          </div>
          <h2 className="font-serif text-[26px] leading-[34px] font-semibold text-ink">
            五步闭环：从画像到决策更新
          </h2>
        </div>

        {/* 主轴线 + 节点 */}
        <div className="relative">
          {/* 回流弧（步骤5激活时描画） */}
          <svg
            viewBox="0 0 1100 96"
            className="pointer-events-none absolute -top-[74px] left-0 h-[96px] w-full"
            fill="none"
            aria-hidden
          >
            <path
              ref={arcRef}
              d="M 1020 92 C 1020 8, 80 8, 80 88"
              stroke="#E7B45A"
              strokeWidth="2"
              strokeDasharray="6 5"
              strokeLinecap="round"
            />
            <path d="M 74 80 L 80 92 L 90 84" stroke="#E7B45A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div
            className={cn(
              'absolute -top-[92px] left-1/2 -translate-x-1/2 rounded-md border border-brand-amber/50 bg-brand-amber-tint px-2 py-0.5 font-mono text-[10px] font-semibold tracking-[0.16em] text-ochre transition-opacity duration-500',
              arcVisible ? 'opacity-100' : 'opacity-0',
            )}
          >
            FEEDBACK LOOP
          </div>

          <div className="relative h-[3px] rounded-full bg-hairline">
            <div
              ref={axisRef}
              className="absolute inset-0 origin-left rounded-full bg-brand"
              style={{ transform: 'scaleX(0)' }}
            />
          </div>

          <div className="relative mt-[-14px] grid grid-cols-5">
            {loopSteps.map((s, i) => {
              const reached = i <= active;
              const isCurrent = i === active;
              return (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => navigate(s.href)}
                  title={`进入：${s.name}`}
                  className="group flex flex-col items-center gap-2 text-center"
                >
                  <span
                    className={cn(
                      'relative flex h-[26px] w-[26px] items-center justify-center rounded-full border-2 bg-paper font-mono text-[10px] font-semibold transition-all duration-500',
                      reached ? 'border-brand bg-brand text-paper' : 'border-hairline text-ink-muted',
                      'group-hover:scale-[1.15]',
                    )}
                  >
                    {isCurrent && (
                      <span className="absolute inset-0 animate-pulse-ring rounded-full text-brand" />
                    )}
                    {i + 1}
                  </span>
                  <s.icon
                    size={17}
                    strokeWidth={1.75}
                    className={cn('transition-colors duration-300', reached ? 'text-brand' : 'text-ink-muted')}
                  />
                  <span
                    className={cn(
                      'max-w-[150px] text-[12.5px] font-medium leading-[17px] transition-all duration-300',
                      isCurrent ? '-translate-y-[2px] text-ink' : reached ? 'text-ink-2' : 'text-ink-muted',
                    )}
                  >
                    {s.name}
                  </span>
                  <span className="font-mono text-[9.5px] tracking-[0.14em] text-ink-muted/80">{s.en}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 激活步骤详情卡（CSS 交叉淡入） */}
        <div className="mt-10 grid gap-4">
          <div key={active} className="lf-anim-in-up lf-card grid gap-6 p-7 md:grid-cols-2">
            <div>
              <div className="lf-mono-label mb-2">STEP {String(active + 1).padStart(2, '0')} / 05</div>
              <h3 className="font-serif text-[22px] font-semibold text-ink">{step.name}</h3>
              <p className="mt-2 text-[15px] leading-[26px] text-ink-2">{step.desc}</p>
              <p className="mt-3 text-[13.5px] leading-[23px] text-ink-muted">{step.detail}</p>
              <button
                type="button"
                onClick={() => navigate(step.href)}
                className="lf-btn-ghost mt-5 !px-4 !py-2 text-[13.5px]"
              >
                进入页面
                <ArrowRight size={14} />
              </button>
            </div>
            <div className="flex items-center justify-center rounded-[12px] border border-hairline bg-paper p-6">
              <div className="text-center">
                <span className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-[16px] border border-brand/25 bg-brand-tint">
                  <step.icon size={30} strokeWidth={1.5} className="text-brand" />
                </span>
                <div className="font-mono text-[11px] tracking-[0.16em] text-ink-muted">{step.en}</div>
                <div className="mt-2 flex items-center justify-center gap-1.5">
                  {loopSteps.map((_, i) => (
                    <span
                      key={i}
                      className={cn(
                        'h-1.5 rounded-full transition-all duration-300',
                        i === active ? 'w-6 bg-brand' : i < active ? 'w-1.5 bg-brand/45' : 'w-1.5 bg-hairline',
                      )}
                    />
                  ))}
                </div>
                {active === 4 && (
                  <div className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-brand-amber-tint px-2 py-1 font-mono text-[10.5px] font-medium text-ochre">
                    <RefreshCw size={11} />
                    画像回流 · 闭环成环
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ================= S4 多 Agent 架构拓扑 ================= */
const topoNodes: { id: AgentId; x: number; y: number; big?: boolean }[] = [
  { id: 'DIA-01', x: 50, y: 13 },
  { id: 'RET-02', x: 85, y: 50 },
  { id: 'GEN-03', x: 50, y: 87 },
  { id: 'VER-04', x: 15, y: 50 },
  { id: 'ARB-05', x: 50, y: 50, big: true },
];

const topoEdges: { d: string; label: string; lx: number; ly: number; agents: AgentId[] }[] = [
  { d: 'M250 88 L250 174', label: '画像向量', lx: 262, ly: 132, agents: ['DIA-01', 'ARB-05'] },
  { d: 'M392 210 L288 210', label: 'KB 切片', lx: 318, ly: 198, agents: ['RET-02', 'ARB-05'] },
  { d: 'M250 246 L250 332', label: '仲裁决议', lx: 262, ly: 292, agents: ['ARB-05', 'GEN-03'] },
  { d: 'M226 348 C 150 330 96 290 84 238', label: '草稿', lx: 118, ly: 322, agents: ['GEN-03', 'VER-04'] },
  { d: 'M108 196 L214 206', label: '审核意见', lx: 122, ly: 182, agents: ['VER-04', 'ARB-05'] },
];

function TopologySection() {
  const [hoverAgent, setHoverAgent] = useState<AgentId | null>(null);
  const navigate = useNavigate();

  return (
    <section className="mx-auto max-w-[1320px] px-8 py-20">
      <SectionHeader
        en="MULTI-AGENT TOPOLOGY"
        title="五个 Agent，一条可信链路"
        desc="分工明确的诊断 / 检索 / 生成 / 审核 / 仲裁：每个论断从切片到成稿全程留痕。"
        actions={
          <button type="button" onClick={() => navigate('/agents')} className="lf-btn-ghost !px-4 !py-2 text-[13.5px]">
            进入协同调度
            <ArrowRight size={14} />
          </button>
        }
      />
      <div className="grid items-stretch gap-6 lg:grid-cols-12">
        {/* 拓扑画布 */}
        <motion.div
          initial={{ opacity: 0, y: 32 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="lf-card relative p-4 lg:col-span-7"
        >
          <div className="relative aspect-[500/420] w-full">
            <svg viewBox="0 0 500 420" className="absolute inset-0 h-full w-full" fill="none">
              {topoEdges.map((e, i) => {
                const activeEdge = hoverAgent !== null && e.agents.includes(hoverAgent);
                return (
                  <g key={i}>
                    <path
                      id={`topo-edge-${i}`}
                      d={e.d}
                      stroke={activeEdge ? '#E7B45A' : '#C9C2B0'}
                      strokeWidth={activeEdge ? 2.2 : 1.5}
                      strokeDasharray="5 5"
                      className="transition-all duration-200"
                    />
                    <text
                      x={e.lx}
                      y={e.ly}
                      className="fill-ink-muted"
                      fontSize="11"
                      fontFamily="'IBM Plex Mono', monospace"
                    >
                      {e.label}
                    </text>
                    {/* 琥珀脉冲沿边流动 */}
                    <circle r="4" fill="#E7B45A">
                      <animateMotion dur="1.6s" begin={`${i * -0.32}s`} repeatCount="indefinite">
                        <mpath href={`#topo-edge-${i}`} />
                      </animateMotion>
                    </circle>
                    <circle r="7.5" fill="#E7B45A" opacity="0.22">
                      <animateMotion dur="1.6s" begin={`${i * -0.32}s`} repeatCount="indefinite">
                        <mpath href={`#topo-edge-${i}`} />
                      </animateMotion>
                    </circle>
                  </g>
                );
              })}
            </svg>
            {topoNodes.map((n, i) => {
              const agent = agents.find((a) => a.id === n.id)!;
              const isHover = hoverAgent === n.id;
              return (
                <motion.button
                  key={n.id}
                  type="button"
                  /* 居中位移交给 framer 的 x/y —— motion 的内联 transform 会覆盖 Tailwind 的 -translate 类 */
                  initial={{ scale: 0.8, opacity: 0, x: '-50%', y: '-50%' }}
                  whileInView={{ scale: 1, opacity: 1, x: '-50%', y: '-50%' }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.1, type: 'spring', stiffness: 260, damping: 20 }}
                  onMouseEnter={() => setHoverAgent(n.id)}
                  onMouseLeave={() => setHoverAgent(null)}
                  onClick={() => navigate(`/agents?agent=${n.id}`)}
                  className="group absolute"
                  style={{ left: `${n.x}%`, top: `${n.y}%` }}
                >
                  <span
                    className={cn(
                      'relative flex items-center justify-center rounded-full border-2 bg-card-warm transition-all duration-200 group-hover:scale-110',
                      n.big ? 'h-[68px] w-[68px]' : 'h-[52px] w-[52px]',
                      isHover && 'shadow-warm',
                    )}
                    style={{
                      borderColor: agent.color,
                      backgroundColor: `${agent.color}0F`,
                      boxShadow: isHover ? `0 0 0 8px ${agent.color}18` : undefined,
                    }}
                  >
                    <AgentIcon agent={agent} size={n.big ? 28 : 21} />
                    <span className="absolute -top-0.5 -right-0.5">
                      <LiveDot status="running" />
                    </span>
                  </span>
                  <span
                    className="absolute left-1/2 top-full mt-1.5 -translate-x-1/2 whitespace-nowrap font-mono text-[10.5px] font-semibold"
                    style={{ color: agent.color }}
                  >
                    {n.id}
                  </span>
                  {/* hover tooltip */}
                  <span className="pointer-events-none absolute left-1/2 top-[-8px] z-10 w-48 -translate-x-1/2 -translate-y-full rounded-[10px] border border-hairline bg-card-warm p-2.5 text-left opacity-0 shadow-warm transition-opacity duration-150 group-hover:opacity-100">
                    <span className="block text-[12.5px] font-semibold text-ink">{agent.name}</span>
                    <span className="mt-0.5 block text-[11.5px] leading-[17px] text-ink-muted">{agent.duty}</span>
                    <span className="mt-1 block font-mono text-[10px] text-ink-muted">
                      今日处理 {agent.todayCount} 次 · 均耗 {agent.avgLatency}
                    </span>
                  </span>
                </motion.button>
              );
            })}
          </div>
        </motion.div>

        {/* Agent 清单 */}
        <div className="flex flex-col gap-3 lg:col-span-5">
          {agents.map((a, i) => (
            <motion.button
              key={a.id}
              type="button"
              initial={{ opacity: 0, x: 24 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ delay: i * 0.08, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              onMouseEnter={() => setHoverAgent(a.id)}
              onMouseLeave={() => setHoverAgent(null)}
              onClick={() => navigate(`/agents?agent=${a.id}`)}
              className={cn(
                'lf-card lf-card-hover group flex items-center gap-3 p-4 text-left',
                hoverAgent === a.id && 'border-brand/35 shadow-warm',
              )}
            >
              <AgentChip agentId={a.id} size="md" showStatus={false} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] leading-[19px] text-ink-2 transition-colors group-hover:text-ink">
                  {a.duty}
                </span>
                <span className="mt-0.5 block font-mono text-[10.5px] text-ink-muted">
                  今日处理 {a.todayCount} 次 · 均耗 {a.avgLatency}
                </span>
              </span>
              <ArrowRight size={14} className="shrink-0 text-ink-muted transition-transform duration-200 group-hover:translate-x-1 group-hover:text-brand" />
            </motion.button>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ================= S5 实时协同动态 + 领域场景 ================= */
interface FeedItem extends LiveFeedSample {
  key: number;
  time: string;
}

function LiveFeedCard() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [filter, setFilter] = useState<AgentId | 'ALL'>('ALL');
  const [paused, setPaused] = useState(false);
  const cursorRef = useRef(0);
  const keyRef = useRef(0);

  useEffect(() => {
    const push = () => {
      const sample = liveFeedSamples[cursorRef.current % liveFeedSamples.length];
      cursorRef.current += 1;
      keyRef.current += 1;
      const item: FeedItem = {
        ...sample,
        key: keyRef.current,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      };
      setItems((prev) => [item, ...prev].slice(0, 9));
    };
    push();
    push();
    push();
    push();
    const timer = setInterval(() => {
      if (!paused) push();
    }, 2200);
    return () => clearInterval(timer);
  }, [paused]);

  const filtered = filter === 'ALL' ? items : items.filter((it) => it.agent === filter);

  return (
    <div
      className="lf-card flex h-full flex-col p-5"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div>
          <div className="lf-mono-label">LIVE FEED</div>
          <h3 className="text-[17px] font-semibold text-ink">协同引擎实时动态</h3>
        </div>
        <span className="ml-auto flex items-center gap-2">
          {paused ? (
            <span className="lf-chip !py-0.5 font-mono text-[11px] text-ochre">
              <Pause size={11} /> 已暂停
            </span>
          ) : (
            <LiveDot status="running" showLabel />
          )}
        </span>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {(['ALL', 'DIA-01', 'RET-02', 'GEN-03', 'VER-04', 'ARB-05'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-lg border px-2 py-1 font-mono text-[11px] font-medium transition-all duration-150',
              filter === f
                ? 'border-brand bg-brand-tint text-brand'
                : 'border-hairline bg-paper text-ink-muted hover:text-ink',
            )}
          >
            {f === 'ALL' ? '全部' : f.slice(0, 3)}
          </button>
        ))}
      </div>
      <div className="h-[380px] space-y-2 overflow-hidden">
        <AnimatePresence initial={false}>
          {filtered.map((it) => (
            <TimelineItem
              key={it.key}
              time={it.time}
              from={it.agent}
              to="ALL"
              type="message"
              content={it.content}
              payload={it.payload}
              kbRefs={it.kbRef ? [it.kbRef] : undefined}
            />
          ))}
        </AnimatePresence>
        {filtered.length === 0 && (
          <div className="flex h-24 items-center justify-center text-[13px] text-ink-muted">
            该 Agent 暂无新动态
          </div>
        )}
      </div>
      <div className="mt-3 border-t border-hairline pt-2.5 font-mono text-[11px] text-ink-muted">
        模拟数据流 · 演示环境 · 每 2.2s 推送
      </div>
    </div>
  );
}

function DomainCard() {
  const navigate = useNavigate();
  return (
    <div className="lf-card h-full overflow-hidden p-5">
      <div className="relative overflow-hidden rounded-[14px] border border-hairline">
        <img
          src="/hero-network.png"
          alt="多智能体学习网络"
          className="aspect-[4/3] w-full object-cover transition-transform duration-500 ease-lf hover:scale-[1.02]"
        />
        {/* clip 揭示：遮罩面板滑出 */}
        <motion.div
          initial={{ y: 0 }}
          whileInView={{ y: '-101%' }}
          viewport={{ once: true, amount: 0.25 }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="absolute inset-0 border-b border-hairline bg-paper"
          aria-hidden
        />
      </div>
      <h3 className="mt-4 font-serif text-[19px] font-semibold text-ink">
        Agent 工程 · 全流程能力训练
      </h3>
      <div className="mt-3 grid grid-cols-2 gap-2.5">
        {knowledgePoints.map((kp, i) => (
          <motion.div
            key={kp.id}
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.06, duration: 0.4 }}
            className="rounded-[10px] border border-hairline bg-paper px-3 py-2"
          >
            <div className="flex items-center justify-between text-[12.5px] font-medium text-ink-2">
              {kp.name}
              <span className="font-mono text-[11px] text-brand tabular">{kp.coverage}%</span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-paper-deep">
              <motion.div
                initial={{ width: 0 }}
                whileInView={{ width: `${kp.coverage}%` }}
                viewport={{ once: true }}
                transition={{ delay: 0.2 + i * 0.06, duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                className="h-full rounded-full bg-brand"
              />
            </div>
          </motion.div>
        ))}
      </div>
      <p className="mt-3 text-[13px] leading-[20px] text-ink-muted">
        对接智能体与大模型方向的能力模型 · 覆盖概念理解到工程交付
      </p>
      <button type="button" onClick={() => navigate('/knowledge')} className="lf-btn-ghost mt-3 w-full !py-2 text-[13.5px]">
        进入知识库
        <ArrowRight size={14} />
      </button>
    </div>
  );
}

/* ================= S6 精选资源速览 ================= */
const formMeta = {
  lecture: { label: '讲义', color: '#4E7860', Icon: PenLine },
  guide: { label: '实操指南', color: '#B77552', Icon: Check },
  quiz: { label: '分阶题', color: '#E7B45A', Icon: Star },
} as const;

function stripMd(md: string, lines = 2): string {
  return md
    .split('\n')
    .map((l) => l.replace(/^[#>\s\d.\\-]+/, '').replace(/[*\\[\]()]/g, '').trim())
    .filter((l) => l.length > 12)
    .slice(0, lines)
    .join(' ');
}

function ResourcesSection() {
  const { currentLearner } = useProfile();
  const navigate = useNavigate();
  const list = getResourcesFor(currentLearner.id);

  return (
    <section className="mx-auto max-w-[1320px] px-8 py-20">
      <SectionHeader
        en="SAMPLE OUTPUTS"
        title="一次协同的三件产出"
        actions={
          <span className="lf-chip">
            当前画像：<span className="font-semibold text-brand">{currentLearner.name}</span>
          </span>
        }
      />
      <div className="grid gap-4 md:grid-cols-3">
        {list.map((r, i) => {
          const meta = formMeta[r.form];
          return (
            <motion.div
              key={r.form}
              role="button"
              tabIndex={0}
              initial={{ opacity: 0, y: 32 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.2 }}
              transition={{ delay: i * 0.1, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              onClick={() => navigate(`/resources?tab=${r.form}`)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') navigate(`/resources?tab=${r.form}`);
              }}
              className="lf-card lf-card-hover group flex flex-col p-5 text-left"
            >
              <div className="mb-3 flex items-center justify-between">
                <span
                  className="inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px] font-semibold transition-colors"
                  style={{ color: meta.color, borderColor: `${meta.color}45`, backgroundColor: `${meta.color}0D` }}
                >
                  <meta.Icon size={13} strokeWidth={1.75} />
                  {meta.label}
                </span>
                <span className="font-mono text-[10.5px] text-ink-muted">{r.version}</span>
              </div>
              <h4 className="text-[15.5px] font-semibold leading-[23px] text-ink">{r.title}</h4>

              {/* 内容预览 */}
              <div className="mt-3 flex-1">
                {r.form === 'lecture' && r.markdown && (
                  <div>
                    <p className="line-clamp-2 text-[13px] leading-[21px] text-ink-2">{stripMd(r.markdown)}</p>
                    <div className="mt-2 rounded-lg border border-hairline bg-paper px-3 py-2 font-mono text-[12px] text-ink-muted">
                      Δθ = k(T − T₀) · k = 0.021°/10℃
                    </div>
                  </div>
                )}
                {r.form === 'guide' && r.steps && (
                  <div className="space-y-1.5">
                    {r.steps.slice(0, 3).map((s, si) => (
                      <div key={si} className="flex items-center gap-2 text-[13px] text-ink-2">
                        <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-brand-tint text-brand">
                          <Check size={10} strokeWidth={2.5} />
                        </span>
                        {s.title}
                      </div>
                    ))}
                    {r.safetyNotice && (
                      <div className="mt-2 rounded-lg border border-brand-amber/40 bg-brand-amber-tint px-2.5 py-1.5 text-[11.5px] leading-[17px] text-ochre">
                        {r.safetyNotice}
                      </div>
                    )}
                  </div>
                )}
                {r.form === 'quiz' && r.quizIds && (
                  <div>
                    <p className="line-clamp-2 text-[13px] leading-[21px] text-ink-2">
                      {getQuizByIds(r.quizIds)[0]?.stem}
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      {r.quizSummary &&
                        (Object.entries(r.quizSummary) as [keyof typeof r.quizSummary, number][]).map(
                          ([lv, n]) => (
                            <span
                              key={lv}
                              className="rounded-md px-1.5 py-0.5 font-mono text-[10.5px] font-medium"
                              style={{ color: quizLevelMeta[lv].color, backgroundColor: `${quizLevelMeta[lv].color}14` }}
                            >
                              {quizLevelMeta[lv].label} ×{n}
                            </span>
                          ),
                        )}
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-hairline pt-3">
                <span className="flex flex-wrap gap-1">
                  {r.kbRefs.map((id) => (
                    <TraceBadge key={id} kbId={id} />
                  ))}
                </span>
                <span className="inline-flex items-center gap-1 text-[12.5px] font-medium text-brand">
                  {r.form === 'lecture' ? '阅读讲义' : r.form === 'guide' ? '查看指南' : '开始作答'}
                  <ArrowRight size={13} className="transition-transform duration-200 group-hover:translate-x-1" />
                </span>
              </div>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}

/* ================= S7 页脚 ================= */
function FooterSection() {
  const nav = [
    { to: '/', label: '总览' },
    { to: '/profiles', label: '学情画像' },
    { to: '/agents', label: '协同调度' },
    { to: '/resources', label: '资源生成' },
    { to: '/report', label: '学情报告' },
    { to: '/tutoring', label: '交互导学' },
    { to: '/knowledge', label: '知识库' },
  ];
  return (
    <motion.footer
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.4 }}
      className="border-t border-hairline"
    >
      <div className="mx-auto grid max-w-[1320px] gap-8 px-8 py-10 md:grid-cols-3">
        <div>
          <div className="flex items-center gap-2.5">
            <img src="/logo.png" alt="智训云枢" className="h-8 w-8" />
            <span className="font-serif text-[16px] font-bold text-ink">智训云枢</span>
          </div>
          <p className="mt-3 font-mono text-[11.5px] leading-[18px] text-ink-muted">
            XH-202630 · 上海云之脑智能科技有限公司
          </p>
          <p className="mt-1 flex items-center gap-1.5 font-mono text-[11.5px] text-ink-muted">
            <Scale size={11} />
            领域知识个性化生成与多智能体协同决策系统
          </p>
        </div>
        <div className="flex flex-wrap content-start gap-x-5 gap-y-2 md:justify-center">
          {nav.map((n) => (
            <Link key={n.to} to={n.to} className="text-[13px] text-ink-2 transition-colors hover:text-brand">
              {n.label}
            </Link>
          ))}
        </div>
        <div className="md:text-right">
          <p className="font-mono text-[11.5px] leading-[19px] text-ink-muted">
            前端演示环境 · 全量模拟数据
            <br />
            React 19 + Tailwind
            <br />© 2025 智训云枢
          </p>
        </div>
      </div>
    </motion.footer>
  );
}

/* ================= 页面装配 ================= */
export default function Home() {
  return (
    <div>
      <HeroSection />
      <MetricsSection />
      <ClosedLoopSection />
      <TopologySection />
      <section className="mx-auto max-w-[1320px] px-8 py-4 pb-20">
        <div className="grid gap-6 lg:grid-cols-12">
          <motion.div
            initial={{ opacity: 0, y: 32 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.15 }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            className="lg:col-span-7"
          >
            <LiveFeedCard />
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 32 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.15 }}
            transition={{ duration: 0.6, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
            className="lg:col-span-5"
          >
            <DomainCard />
          </motion.div>
        </div>
      </section>
      <ResourcesSection />
      <FooterSection />
    </div>
  );
}
