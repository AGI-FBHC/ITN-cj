/**
 * useAmbient — 专注模式环境音（WebAudio 合成，零素材依赖）
 * rain：滤波白噪 + 缓慢起伏，像窗外细雨
 * forest：更低沉的风声 + 偶发鸟鸣泛音
 * 全程音量极低（0.02~0.05），可随时停止；浏览器不支持时静默降级。
 */
import { useEffect, useRef, useState } from 'react';

export type AmbientKind = 'off' | 'rain' | 'forest';

interface Nodes {
  ctx: AudioContext;
  master: GainNode;
  stop: () => void;
}

/** 生成 2 秒循环白噪 buffer */
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    /* 棕噪：比纯白噪更柔和、更像自然声 */
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.2;
  }
  return buf;
}

function build(ctx: AudioContext, kind: 'rain' | 'forest'): Nodes {
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);

  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;

  const filter = ctx.createBiquadFilter();
  if (kind === 'rain') {
    filter.type = 'bandpass';
    filter.frequency.value = 1500;
    filter.Q.value = 0.6;
  } else {
    filter.type = 'lowpass';
    filter.frequency.value = 520;
    filter.Q.value = 0.4;
  }

  /* 缓慢起伏：LFO 调制音量，模拟雨势/风势变化 */
  const swell = ctx.createGain();
  swell.gain.value = 1;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = kind === 'rain' ? 0.07 : 0.045;
  const lfoAmt = ctx.createGain();
  lfoAmt.gain.value = 0.35;
  lfo.connect(lfoAmt).connect(swell.gain);
  lfo.start();

  src.connect(filter).connect(swell).connect(master);
  src.start();

  /* forest：偶发鸟鸣（轻柔正弦滑音） */
  let birdTimer: ReturnType<typeof setInterval> | null = null;
  if (kind === 'forest') {
    birdTimer = setInterval(() => {
      if (Math.random() > 0.55) return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const base = 1700 + Math.random() * 900;
      osc.frequency.setValueAtTime(base, t);
      osc.frequency.exponentialRampToValueAtTime(base * 1.35, t + 0.08);
      osc.frequency.exponentialRampToValueAtTime(base * 0.9, t + 0.22);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.014, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + 0.35);
    }, 5200);
  }

  /* 淡入 */
  const target = kind === 'rain' ? 0.05 : 0.042;
  master.gain.linearRampToValueAtTime(target, ctx.currentTime + 2.2);

  const stop = () => {
    if (birdTimer) clearInterval(birdTimer);
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + 0.9);
    setTimeout(() => {
      try { src.stop(); lfo.stop(); } catch { /* already stopped */ }
      try { master.disconnect(); } catch { /* noop */ }
    }, 1100);
  };

  return { ctx, master, stop };
}

export function useAmbient() {
  const [kind, setKind] = useState<AmbientKind>('off');
  const nodesRef = useRef<Nodes | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    /* 先拆掉旧的 */
    nodesRef.current?.stop();
    nodesRef.current = null;
    if (kind === 'off') return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const AC = (window as any).AudioContext ?? (window as any).webkitAudioContext;
      if (!AC) return;
      ctxRef.current ??= new AC();
      const ctx = ctxRef.current!;
      void ctx.resume();
      nodesRef.current = build(ctx, kind);
    } catch { /* 静默降级 */ }
    return () => {
      nodesRef.current?.stop();
      nodesRef.current = null;
    };
  }, [kind]);

  /* 组件卸载时兜底停止 */
  useEffect(() => () => { nodesRef.current?.stop(); }, []);

  const supported = typeof window !== 'undefined'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    && !!((window as any).AudioContext ?? (window as any).webkitAudioContext);

  return { kind, setKind, supported };
}
