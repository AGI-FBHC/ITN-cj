/**
 * usePlayback — 协同演示播放引擎（agents.md S1）
 * 驱动 collabScript 的 16 条带时间偏移事件：
 *  - 模拟时钟 50ms tick × 倍速推进，事件按 t 偏移依次派发
 *  - 播放 / 暂停 / 重置 / 倍速 1x·2x·4x / 单步模式（逐条手动推进）
 *  - events 身份变化（切换画像重排脚本）时渲染期比对自动重置回待命态
 * 实现约定：引擎状态 {clock, cursor} 全部经由纯 updater 推进；status 为派生态。
 */
import { useEffect, useState } from 'react';
import type { CollabEvent } from '@/data/collabScript';

export type PlayStatus = 'idle' | 'running' | 'paused' | 'done';
export type PlaySpeed = 1 | 2 | 4;
type PlayState = 'idle' | 'running' | 'paused';

export interface Playback {
  status: PlayStatus;
  speed: PlaySpeed;
  stepMode: boolean;
  /** 下一条待派发事件下标（== 已派发条数） */
  cursor: number;
  /** 模拟时钟（秒，封顶最后一条事件 t） */
  clock: number;
  /** 脚本总时长（秒） */
  totalT: number;
  /** 首次播放的真实时间戳（用于把事件 t 映射为 mono 墙钟时间） */
  playStartedAt: number | null;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  reset: () => void;
  setSpeed: (s: PlaySpeed) => void;
  setStepMode: (v: boolean) => void;
  stepOnce: () => void;
}

const TICK_MS = 50;

interface Engine {
  clock: number;
  cursor: number;
}

const IDLE_ENGINE: Engine = { clock: 0, cursor: 0 };

export function usePlayback(events: CollabEvent[]): Playback {
  const [playState, setPlayState] = useState<PlayState>('idle');
  const [engine, setEngine] = useState<Engine>(IDLE_ENGINE);
  const [speed, setSpeed] = useState<PlaySpeed>(2);
  const [stepMode, setStepMode] = useState(false);
  const [playStartedAt, setPlayStartedAt] = useState<number | null>(null);

  const totalT = events.length > 0 ? events[events.length - 1].t : 0;
  const isDone = events.length > 0 && engine.cursor >= events.length;
  const status: PlayStatus = isDone ? 'done' : playState;

  /* 脚本身份变化（切换画像）→ 渲染期比对重置（React 官方 derived-reset 模式） */
  const [prevEvents, setPrevEvents] = useState(events);
  if (prevEvents !== events) {
    setPrevEvents(events);
    setEngine(IDLE_ENGINE);
    setPlayState('idle');
    setPlayStartedAt(null);
  }

  /* 自动推进循环：纯 updater，速度/脚本变化时重建 */
  useEffect(() => {
    if (status !== 'running' || stepMode) return undefined;
    const iv = window.setInterval(() => {
      setEngine((prev) => {
        if (prev.cursor >= events.length) return prev;
        const clock = prev.clock + (TICK_MS / 1000) * speed;
        let cursor = prev.cursor;
        while (cursor < events.length && events[cursor].t <= clock + 1e-9) cursor += 1;
        const total = events.length > 0 ? events[events.length - 1].t : 0;
        return { clock: Math.min(clock, total), cursor };
      });
    }, TICK_MS);
    return () => window.clearInterval(iv);
  }, [status, stepMode, events, speed]);

  const play = () => {
    /* 不基于渲染期 isDone 早退：reset()+play() 同批调用时需能启动 */
    setPlayState('running');
    setPlayStartedAt((p) => p ?? Date.now());
  };

  const pause = () => {
    setPlayState((p) => (p === 'running' ? 'paused' : p));
  };

  const toggle = () => {
    if (isDone) return;
    setPlayState((p) => (p === 'running' ? 'paused' : 'running'));
    setPlayStartedAt((p) => p ?? Date.now());
  };

  const reset = () => {
    setEngine(IDLE_ENGINE);
    setPlayState('idle');
    setPlayStartedAt(null);
  };

  /** 单步推进：时钟直接跳到下一条事件的 t 并派发之 */
  const stepOnce = () => {
    if (isDone) return;
    setPlayStartedAt((p) => p ?? Date.now());
    setEngine((prev) => {
      if (prev.cursor >= events.length) return prev;
      const t = events[prev.cursor].t;
      return { clock: Math.max(prev.clock, t), cursor: prev.cursor + 1 };
    });
    setPlayState((p) => (p === 'idle' ? 'paused' : p));
  };

  return {
    status,
    speed,
    stepMode,
    cursor: engine.cursor,
    clock: engine.clock,
    totalT,
    playStartedAt,
    play,
    pause,
    toggle,
    reset,
    setSpeed,
    setStepMode,
    stepOnce,
  };
}

/** 把事件相对偏移映射为 mono 墙钟时间 HH:MM:SS.mmm（无基准时返回占位） */
export function formatWallTime(base: number | null, t: number): string {
  if (base === null) return '--:--:--.---';
  const d = new Date(base + t * 1000);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export const reducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
