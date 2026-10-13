/**
 * DemoTour — 评委一键导览
 * 5 分钟自动串场模式：把五步闭环叙事（拆成 7 个落点）喂到评委嘴边。
 * 固定挂载在 AppShell（Router 内部），跨路由不卸载；由三处入口触发：
 *   1) AppShell 侧栏「评委导览」按钮
 *   2) Home.tsx HeroSection「评委 5 分钟导览」CTA
 *   3) Login.tsx「评委 / 访客演示通道」
 * 三处入口统一调用本文件导出的 startDemoTour()：
 *   - 若 DemoTour 已挂载（同一次会话内，如从 Home 点按钮）→ 触发 window 事件即时响应；
 *   - 若尚未挂载（如 Login 页面全新导航）→ 写 sessionStorage 待启动标记，DemoTour 挂载后读取并自启。
 * 进度（active / 当前步 / 是否收起）持久化到 sessionStorage，刷新不丢。
 */
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Clock3, Compass, Minimize2, X } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { tourSteps, TOUR_STORAGE_KEY } from './tourSteps';
import type { TourDimension } from './tourSteps';
import { cn } from '@/lib/utils';

/** 跨组件即时触发（DemoTour 已挂载时，如 Home 内点按钮） */
const TOUR_START_EVENT = 'lf-demo-tour:start';
/** 冷启动待办标记（DemoTour 尚未挂载时，如从 /login 全新导航过来） */
const TOUR_PENDING_KEY = 'lf-demo-tour-pending';

/** 三处入口统一调用：启动 / 重启导览（从第 1 步开始） */
export function startDemoTour() {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(TOUR_PENDING_KEY, '1');
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(TOUR_START_EVENT));
}

interface TourState {
  active: boolean;
  stepIndex: number;
  minimized: boolean;
}

const DEFAULT_STATE: TourState = { active: false, stepIndex: 0, minimized: false };

function readState(): TourState {
  if (typeof window === 'undefined') return DEFAULT_STATE;
  try {
    const raw = window.sessionStorage.getItem(TOUR_STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<TourState>;
    return {
      active: Boolean(parsed.active),
      stepIndex: Math.min(Math.max(0, Number(parsed.stepIndex) || 0), tourSteps.length - 1),
      minimized: Boolean(parsed.minimized),
    };
  } catch {
    return DEFAULT_STATE;
  }
}

const dimensionStyle: Record<TourDimension, string> = {
  完整性: 'border-brand/40 bg-brand-tint text-brand',
  创新性: 'border-brand-amber/45 bg-brand-amber-tint text-brand-amber',
  体验: 'border-ochre/40 bg-ochre-tint text-ochre',
  实用价值: 'border-brand-success/40 bg-brand-success/10 text-brand-success',
};

export default function DemoTour() {
  const [state, setState] = useState<TourState>(readState);
  const { setViewMode } = useProfile();
  const navigate = useNavigate();
  const location = useLocation();
  const reduceMotion = useReducedMotion();

  const step = tourSteps[state.stepIndex];
  const isFirst = state.stepIndex === 0;
  const isLast = state.stepIndex === tourSteps.length - 1;

  /* 进度持久化：刷新不丢 */
  useEffect(() => {
    try {
      window.sessionStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state]);

  /* 启动导览（切到系统透视，从第 1 步开始） */
  const handleStart = useCallback(() => {
    setViewMode('expert');
    setState({ active: true, stepIndex: 0, minimized: false });
  }, [setViewMode]);

  /* 冷启动待办标记 + 热启动事件：两处入口的落地点 */
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(TOUR_PENDING_KEY) === '1') {
        window.sessionStorage.removeItem(TOUR_PENDING_KEY);
        handleStart();
      }
    } catch {
      /* ignore */
    }
    const onEvent = () => handleStart();
    window.addEventListener(TOUR_START_EVENT, onEvent);
    return () => window.removeEventListener(TOUR_START_EVENT, onEvent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 步骤切换 → 跟随 navigate + 回到顶部（仅由本组件触发的状态变化驱动，不劫持用户手动跳转） */
  useEffect(() => {
    if (!state.active || state.minimized) return;
    const target = tourSteps[state.stepIndex].route;
    /* 必须连 query 一起比：只比 pathname 时 /resources?tab=lecture → ?tab=guide 不会跳转，
       第 3、4 步会停在同一个页面（BUG-033 复核发现）。 */
    if (location.pathname + location.search !== target) {
      navigate(target);
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.active, state.stepIndex, state.minimized]);

  const goToStep = (index: number) => {
    const clamped = Math.max(0, Math.min(tourSteps.length - 1, index));
    if (clamped === state.stepIndex && state.active && !state.minimized) return;
    setState((prev) => ({ ...prev, active: true, minimized: false, stepIndex: clamped }));
  };

  const handleMinimize = () => setState((prev) => ({ ...prev, minimized: true }));
  const handleExpand = () => setState((prev) => ({ ...prev, minimized: false }));
  const handleExit = () => {
    setState({ active: false, stepIndex: 0, minimized: false });
    try {
      window.sessionStorage.removeItem(TOUR_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  const enterMotion = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.12 } }
    : {
        initial: { opacity: 0, y: 16 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: 16 },
        transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] as const },
      };
  const stepMotion = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.12 } }
    : {
        initial: { opacity: 0, y: 10 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -10 },
        transition: { duration: 0.26, ease: [0.22, 1, 0.36, 1] as const },
      };

  if (!state.active) return null;

  return (
    <AnimatePresence>
      {state.minimized ? (
        /* ============ 收起态：右下角圆钮（不遮挡伴学助手 Dock，堆叠在其上方） ============ */
        <motion.button
          key="demo-tour-mini"
          type="button"
          onClick={handleExpand}
          title={`评委导览 · STEP ${state.stepIndex + 1}/${tourSteps.length} · 点击继续`}
          {...enterMotion}
          className="fixed bottom-40 right-4 z-50 flex h-14 w-14 items-center justify-center rounded-full border-2 border-brand/30 bg-brand text-paper shadow-warm-lg transition-transform duration-200 hover:scale-105 md:bottom-24 md:right-6"
        >
          <Compass size={22} />
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-amber px-1 font-mono text-[10px] font-bold text-ink">
            {state.stepIndex + 1}
          </span>
        </motion.button>
      ) : (
        /* ============ 展开态：导览卡（移动端底部横条 / 桌面右下角浮卡） ============ */
        <motion.div
          key="demo-tour-card"
          {...enterMotion}
          className="lf-card fixed inset-x-0 bottom-0 z-50 flex max-h-[70dvh] w-full flex-col overflow-hidden rounded-t-[20px] rounded-b-none lg:inset-x-auto lg:bottom-24 lg:right-6 lg:max-h-[min(560px,calc(100dvh-160px))] lg:w-[300px] lg:rounded-[20px]"
        >
          {/* 头 */}
          <div className="flex items-center justify-between gap-2 border-b border-hairline bg-card-warm px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-brand text-paper">
                <Compass size={16} />
              </span>
              <div className="min-w-0">
                <div className="lf-mono-label !text-[9.5px]">JUDGE TOUR · 评委导览</div>
                <div className="truncate text-[13px] font-semibold text-ink">
                  STEP {state.stepIndex + 1}/{tourSteps.length} · {step.title}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={handleExit}
              title="退出导览（清除进度）"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-ink-muted transition-colors hover:bg-paper-deep hover:text-ink"
            >
              <X size={15} />
            </button>
          </div>

          {/* 解说正文（切步交叉淡入） */}
          <div className="flex-1 overflow-y-auto px-4 py-4">
            <AnimatePresence mode="wait">
              <motion.div key={step.key} {...stepMotion}>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold',
                    dimensionStyle[step.badge],
                  )}
                >
                  {step.badge}
                </span>

                <p className="mt-2.5 text-[13px] leading-[21px] text-ink-2">{step.narration}</p>

                <ul className="mt-3 space-y-1.5">
                  {step.highlights.map((h) => (
                    <li key={h} className="flex gap-1.5 text-[12px] leading-[18px] text-ink-muted">
                      <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-brand" />
                      {h}
                    </li>
                  ))}
                </ul>

                {step.note && (
                  <div className="mt-3 flex items-start gap-1.5 rounded-[10px] border border-brand-amber/40 bg-brand-amber-tint px-2.5 py-2 text-[11.5px] leading-[17px] text-ochre">
                    <Clock3 size={13} className="mt-[1px] shrink-0" />
                    {step.note}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* 进度点（可点击跳步） */}
          <div className="flex items-center justify-center gap-1.5 px-4 py-2">
            {tourSteps.map((s, i) => {
              const isCurrent = i === state.stepIndex;
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => goToStep(i)}
                  title={`${i + 1}. ${s.title}`}
                  className={cn(
                    'h-1.5 rounded-full transition-all duration-300',
                    isCurrent ? 'w-6 bg-brand' : i < state.stepIndex ? 'w-1.5 bg-brand/45' : 'w-1.5 bg-hairline hover:bg-brand/30',
                  )}
                />
              );
            })}
          </div>

          {/* 上一步 / 下一步 */}
          <div className="flex items-center gap-2 border-t border-hairline bg-card-warm px-4 py-3">
            <button
              type="button"
              disabled={isFirst}
              onClick={() => goToStep(state.stepIndex - 1)}
              className="lf-btn-ghost flex-1 !py-2 text-[12.5px] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft size={14} />
              上一步
            </button>
            <button
              type="button"
              disabled={isLast}
              onClick={() => goToStep(state.stepIndex + 1)}
              className="lf-btn-primary flex-1 !py-2 text-[12.5px] disabled:cursor-not-allowed disabled:opacity-40"
            >
              下一步
              <ChevronRight size={14} />
            </button>
          </div>

          {/* 结束导览（收起为圆钮，保留进度；真正退出用右上角 ×） */}
          <button
            type="button"
            onClick={handleMinimize}
            className="flex items-center justify-center gap-1.5 border-t border-hairline py-2 text-[11.5px] font-medium text-ink-muted transition-colors hover:bg-paper-deep hover:text-ink"
          >
            <Minimize2 size={12} />
            结束导览
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
