/**
 * LearnUnit `/learn/:kpId` — 交互课件播放器（视听双通道讲播）
 * - Cue 引擎：讲稿逐句朗读，每句触发视觉动作（演播元素点亮 / 溯源发光 / 演示导览步进）
 * - 演播块(stage)：黑板式教具（图示/要点/公式/大数字/溯源卡）随语音逐件出现
 * - 演示导览：语音讲第几步，模拟器/坐标演示自己演到第几步，讲完交还给学习者
 * - 字幕条 + 音效（对/错/换块）+ 语速切换 + 说话脉冲；无 TTS 自动降级"默片+字幕"
 * - 检查点答错 → ARB-05 插降维块；作答/完课回写阿诊信号
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  ArrowRight,
  Play,
  Pause,
  Hand,
  Mic,
  Send,
  Volume2,
  VolumeX,
  Scale,
  Check,
  X,
  Sparkles,
  PenLine,
  NotebookPen,
  Focus,
  Droplets,
  Route,
  CloudRain,
  Headphones,
  Trees,
  Shuffle,
  RotateCcw,
  Zap,
  Bookmark,
  AlignLeft,
  LayoutGrid,
  ListChecks,
  Presentation,
  Brain,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { useProfile, dataIdOf } from '@/context/ProfileContext';
import { useAgent } from '@/context/AgentContext';
import { useNotes } from '@/context/NotesContext';
import { useGrowth } from '@/context/GrowthContext';
import { useReview } from '@/context/ReviewContext';
import { useWrongBook } from '@/context/WrongBookContext';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import { nextPathNodeAfter } from '@/data/reportData';
import { reportForLearner } from '@/data/reportBuilder';
import { resolveLearnTarget } from '@/data/resources';
import { buildUnit, remedialBlockOf, variantBlockOf, drawQuestions, matchQA, fallbackAnswer, cuesOf, STYLE_LABELS } from '@/data/courseware';
import type { CourseBlock, StageItem, StyleLabel } from '@/data/courseware';
import TraceBadge from '@/components/TraceBadge';
import CalibrationSim from '@/components/learn/CalibrationSim';
import FrameDemo from '@/components/learn/FrameDemo';
import PlcLadderDemo from '@/components/learn/PlcLadderDemo';
import SafetyLoopDemo from '@/components/learn/SafetyLoopDemo';
import VisionGuideDemo from '@/components/learn/VisionGuideDemo';
import FaultTreeDemo from '@/components/learn/FaultTreeDemo';
import PathProgressBar from '@/components/learn/PathProgressBar';
import { GrassTuft, Sprout } from '@/components/heal/Flora';
import PageTip from '@/components/heal/PageTip';
import { useAmbient } from '@/components/heal/useAmbient';
import { cn } from '@/lib/utils';

const letters = ['A', 'B', 'C', 'D'];
const RATES = [0.85, 1.05, 1.3] as const;

/* ---------- TTS（带看门狗：utterance 卡死/静音环境下超时强制推进，保证讲播永不挂起） ---------- */
function useTts() {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const speak = (text: string, rate: number, onEnd: () => void) => {
    /* 估算朗读时长：中文 ~0.28s/字，随语速缩放 */
    const est = Math.min(20000, Math.max(1600, (text.length * 280) / rate));
    if (!supported) {
      const t = setTimeout(onEnd, Math.min(9000, est * 0.6));
      return () => clearTimeout(t);
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      onEnd();
    };
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const zh = window.speechSynthesis.getVoices().find((v) => v.lang.startsWith('zh'));
    if (zh) u.voice = zh;
    u.lang = 'zh-CN';
    u.rate = rate;
    let started = false;
    u.onstart = () => { started = true; };
    u.onend = finish;
    u.onerror = finish;
    window.speechSynthesis.resume();
    window.speechSynthesis.speak(u);
    /* 双看门狗：2.5s 没真正发声 = 静音环境 → 提前推进；发声后按估时 ×1.6 兜底 */
    const startGuard = setTimeout(() => { if (!started) finish(); }, 2500);
    const guard = setTimeout(finish, est * 1.6 + 1500);
    return () => {
      settled = true;
      clearTimeout(startGuard);
      clearTimeout(guard);
      window.speechSynthesis.cancel();
    };
  };
  const stop = () => { if (supported) window.speechSynthesis.cancel(); };
  return { supported, speak, stop };
}

/* ---------- 课堂音效（WebAudio 振荡器，无素材依赖） ---------- */
function useClassroomSound() {
  const ctxRef = useRef<AudioContext | null>(null);
  const tone = (freq: number, dur: number, delay = 0, gain = 0.045) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const AC = (window as any).AudioContext ?? (window as any).webkitAudioContext;
      if (!AC) return;
      ctxRef.current ??= new AC();
      const ctx = ctxRef.current!;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, ctx.currentTime + delay);
      g.gain.linearRampToValueAtTime(gain, ctx.currentTime + delay + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + dur + 0.05);
    } catch { /* ignore */ }
  };
  return {
    ding: () => { tone(880, 0.12); tone(1320, 0.16, 0.09); },
    dong: () => tone(196, 0.28),
    chime: () => tone(660, 0.08),
  };
}

/* ---------- 语音识别（webkit 前缀非标准 API） ---------- */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRecognizer(): (new () => any) | null {
  if (typeof window === 'undefined') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/* ---------- 演播小图 ---------- */
function Figure({ figure }: { figure: 'deviation' | 'chain' }) {
  if (figure === 'deviation') {
    return (
      <svg viewBox="0 0 260 96" className="w-full max-w-[300px]">
        <circle cx="70" cy="48" r="6" fill="#6BA080" />
        <text x="70" y="30" fontSize="11" textAnchor="middle" fill="#6BA080" fontFamily="monospace">A（以为）</text>
        <circle cx="185" cy="62" r="6" fill="#B0483B" />
        <text x="185" y="88" fontSize="11" textAnchor="middle" fill="#B0483B" fontFamily="monospace">A′（真实）</text>
        <line x1="78" y1="49" x2="176" y2="61" stroke="#B0483B" strokeWidth="2" strokeDasharray="5 4" />
        <text x="128" y="44" fontSize="10.5" textAnchor="middle" fill="#B77552" fontFamily="monospace">偏差 = 要标定掉的</text>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 260 76" className="w-full max-w-[300px]">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <g key={i}>
          <circle cx={26 + i * 42} cy="38" r="8" fill="none" stroke="#4E7860" strokeWidth="2" />
          <text x={26 + i * 42} y="42" fontSize="9" textAnchor="middle" fill="#4E7860" fontFamily="monospace">J{i + 1}</text>
          {i < 5 && <line x1={34 + i * 42} y1="38" x2={60 + i * 42} y2="38" stroke="#B77552" strokeWidth="2.5" />}
        </g>
      ))}
      <text x="130" y="66" fontSize="10" textAnchor="middle" fill="#66725E" fontFamily="monospace">关节角 θ₁…θ₆ ⇄ 末端位姿 T</text>
    </svg>
  );
}

/* ---------- 演播元素 ---------- */
function StageItemView({ item, visible, current }: { item: StageItem; visible: boolean; current: boolean }) {
  /* 明暗用 CSS transition（rAF 不可用时也能应用终值），弹跳交给 transform */
  return (
    <div
      className={cn(
        'rounded-[10px] border p-3 transition-all duration-500 ease-lf',
        visible ? 'translate-y-0 opacity-100' : 'translate-y-1.5 opacity-[0.07]',
        current ? 'scale-[1.02] border-brand-amber bg-brand-amber-tint/60 shadow-warm' : 'scale-100 border-hairline bg-paper',
      )}
    >
      {item.type === 'bullet' && (
        <div className="flex items-start gap-2 text-[13.5px] leading-[21px] text-ink-2">
          <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
          {item.text}
        </div>
      )}
      {item.type === 'formula' && (
        <div className="text-center">
          <div className="font-mono text-[19px] font-semibold text-brand">{item.text}</div>
          {item.note && <div className="mt-1 font-mono text-[10.5px] text-ink-muted">{item.note}</div>}
        </div>
      )}
      {item.type === 'bignum' && (
        <div className="text-center">
          <div className="font-display text-[30px] font-semibold leading-[36px] text-ochre">{item.value}</div>
          <div className="mt-0.5 text-[11.5px] text-ink-muted">{item.label}</div>
        </div>
      )}
      {item.type === 'kb' && (
        <div className="flex items-center justify-center gap-2 py-1 text-[12.5px] text-ink-2">
          出处 <TraceBadge kbId={item.kbId} />
        </div>
      )}
      {item.type === 'figure' && (
        <div className="flex justify-center py-1">
          <Figure figure={item.figure} />
        </div>
      )}
    </div>
  );
}

/* ---------- 技术亮点导览（系统透视专属）：6 大核心 Feature 随操作实时点亮 ---------- */
interface SpotFlags {
  gen: boolean;
  av: boolean;
  trace: boolean;
  arb: boolean;
  agency: boolean;
  modal: boolean;
}

const SPOT_DEFS: { key: keyof SpotFlags; icon: typeof Sparkles; name: string; desc: string; how: string }[] = [
  { key: 'gen', icon: Sparkles, name: '画像驱动现做', desc: '难度 × 风格 × KB 切片拼装', how: '进入本页即触发' },
  { key: 'av', icon: Volume2, name: '视听双通道', desc: '语音讲到哪，画面亮到哪', how: '点播放 / 讲这一段' },
  { key: 'trace', icon: ShieldCheck, name: '零幻觉溯源', desc: '论断挂 KB 角标，讲到出处会发光', how: '播到引用句自动触发' },
  { key: 'arb', icon: Scale, name: '动态决策 ARB-05', desc: '答错降维 / 进阶挑战 / 两错接回', how: '答错检查点试试' },
  { key: 'agency', icon: Hand, name: '学习者主权', desc: '签到自选 / 换讲法 / 越权协商', how: '点「这段感觉如何」' },
  { key: 'modal', icon: LayoutGrid, name: '多模态学习', desc: '读 / 图卡 / 听 / 幻灯 / 交互演示', how: '切模态或开幻灯' },
];

function FeatureSpotlight({ flags }: { flags: SpotFlags }) {
  const [open, setOpen] = useState(true);
  const hitCount = SPOT_DEFS.filter((d) => flags[d.key]).length;
  return (
    <div className="fixed right-4 top-24 z-30 hidden w-[228px] xl:block">
      <div className="rounded-[14px] border border-hairline bg-paper/92 shadow-warm backdrop-blur">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
        >
          <Sparkles size={13} className="text-brand" />
          <span className="text-[12.5px] font-semibold text-ink">技术亮点 · 边用边看</span>
          <span className="ml-auto rounded-md bg-brand-tint px-1.5 py-0.5 font-mono text-[10px] font-semibold text-brand">
            {hitCount}/{SPOT_DEFS.length}
          </span>
        </button>
        {open && (
          <div className="space-y-1 border-t border-hairline/70 px-2.5 py-2">
            {SPOT_DEFS.map((d) => {
              const hit = flags[d.key];
              return (
                <div
                  key={d.key}
                  className={cn(
                    'rounded-[10px] px-2 py-1.5 transition-all',
                    hit ? 'bg-brand-tint/50' : 'opacity-70',
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                        hit ? 'bg-brand text-paper' : 'border border-hairline bg-paper text-ink-muted',
                      )}
                    >
                      {hit ? <Check size={10} /> : <d.icon size={10} />}
                    </span>
                    <span className={cn('text-[12px] font-medium', hit ? 'text-brand' : 'text-ink-2')}>{d.name}</span>
                    {hit && (
                      <motion.span
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        className="ml-auto font-mono text-[9px] font-semibold text-brand"
                      >
                        已演示
                      </motion.span>
                    )}
                  </div>
                  <div className="ml-[26px] mt-0.5 text-[10.5px] leading-[15px] text-ink-muted">
                    {hit ? d.desc : `${d.desc} — ${d.how}`}
                  </div>
                </div>
              );
            })}
            <div className="px-2 pb-1 pt-1.5 font-mono text-[9.5px] leading-[14px] text-ink-muted/80">
              LIVE CHECKLIST · 你的每步操作会实时点亮对应机制
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- 调整过程流水线（内容"现做"时的可视化：信号 → 裁定 → 生成中） ---------- */
function AdjustPipeline({ steps }: { steps: [string, string, string] }) {
  const icons = [Zap, Scale, PenLine] as const;
  return (
    <div className="py-1">
      <div className="mb-2 flex items-center gap-1.5 font-mono text-[10.5px] tracking-wide text-ochre">
        <motion.span
          animate={{ opacity: [0.35, 1, 0.35] }}
          transition={{ repeat: Infinity, duration: 1.2 }}
          className="h-1.5 w-1.5 rounded-full bg-brand-amber"
        />
        LIVE · 教学内容动态调整中
      </div>
      <div className="space-y-2">
        {steps.map((s, i) => {
          const Icon = icons[i];
          return (
            <motion.div
              key={s}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.45, duration: 0.35 }}
              className="flex items-center gap-2 text-[13px] text-ink-2"
            >
              <span
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                  i === 2 ? 'bg-brand-amber-tint text-ochre' : 'bg-brand-tint text-brand',
                )}
              >
                <Icon size={12} />
              </span>
              {s}
              {i === 2 && (
                <motion.span
                  animate={{ opacity: [0.2, 1, 0.2] }}
                  transition={{ repeat: Infinity, duration: 0.9 }}
                  className="font-mono text-[13px] text-brand"
                >
                  ▋
                </motion.span>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- 开讲适配横幅：把"这讲是按你现做的"直接说出来（检测 → 定制 → 核验 逐步点亮） ---------- */
function AdaptiveBanner({
  kpName,
  score,
  target,
  isWeakest,
  difficulty,
  styleLabel,
  expert,
}: {
  kpName: string;
  score: number;
  target: number;
  isWeakest: boolean;
  difficulty: string;
  styleLabel: string;
  expert: boolean;
}) {
  const gap = Math.max(0, target - score);
  const weak = difficulty === '零基础' || gap >= 25;
  const adjustLine =
    difficulty === '零基础'
      ? '已切到零基础版：术语先解释、节奏放慢、检查点加密'
      : difficulty === '进阶'
        ? '已切到进阶版：基础快速带过，直上工程判据与易错边界'
        : '按标准版拼装：概念与应用并重';
  const steps = [
    {
      icon: Brain,
      label: expert ? 'DIA-01 检测' : 'AI 检测',
      text: `「${kpName}」当前 ${score} 分 / 目标 ${target}${isWeakest ? ' · 六维最弱' : gap >= 15 ? ` · 缺口 ${gap} 分` : ' · 基础扎实'}`,
      tone: weak ? 'amber' : 'green',
    },
    {
      icon: PenLine,
      label: expert ? 'GEN-03 生成' : 'AI 定制',
      text: `${adjustLine} · 讲法「${styleLabel}」`,
      tone: 'green',
    },
    {
      icon: ShieldCheck,
      label: expert ? 'VER-04 核验' : '已核验',
      text: '每个论断都挂 KB 溯源角标——没有出处的内容发不出来',
      tone: 'green',
    },
  ] as const;

  return (
    <div
      className={cn(
        'mt-4 rounded-[14px] border p-4',
        weak ? 'border-brand-amber/45 bg-brand-amber-tint/30' : 'border-brand/25 bg-brand-tint/25',
      )}
    >
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="font-mono text-[10.5px] tracking-wide text-ink-muted">
          {weak ? 'ADAPTIVE · 检测到薄弱维，本讲已为你调整' : 'ADAPTIVE · 本讲按你的画像现做'}
        </span>
        <span className="rounded-md border border-hairline bg-paper px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
          换个人打开，这一讲长得不一样
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {steps.map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 + i * 0.4, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="flex items-start gap-2 rounded-[10px] border border-hairline/70 bg-paper/70 p-2.5"
          >
            <span
              className={cn(
                'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                s.tone === 'amber' ? 'bg-brand-amber-tint text-ochre' : 'bg-brand-tint text-brand',
              )}
            >
              <s.icon size={12} />
            </span>
            <span className="min-w-0">
              <span className={cn('block font-mono text-[10px] font-semibold', s.tone === 'amber' ? 'text-ochre' : 'text-brand')}>
                {s.label}
              </span>
              <span className="mt-0.5 block text-[12px] leading-[18px] text-ink-2">{s.text}</span>
            </span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

export default function LearnUnit() {
  const { kpId = 'kp-sensor' } = useParams();
  const navigate = useNavigate();
  const { currentLearner, viewMode, weakestKp, bumpConfidence } = useProfile();
  const { pushSignal } = useAgent();
  const { markStudied, markDoubt } = useReview();
  const { addWrong } = useWrongBook();
  const kp = getKnowledgePoint(kpId);
  const dataId = dataIdOf(currentLearner);
  const nextNode = nextPathNodeAfter(reportForLearner(currentLearner), kpId);

  /* 「换个角度再学一遍」：强制换风格重拼本讲（GEN-03 现场重新生成） */
  const [styleOverride, setStyleOverride] = useState<StyleLabel | null>(null);
  const unit = useMemo(() => buildUnit(kpId, currentLearner, styleOverride ?? undefined), [kpId, currentLearner, styleOverride]);
  const [blocks, setBlocks] = useState<CourseBlock[]>(unit.blocks);
  useEffect(() => setBlocks(unit.blocks), [unit]);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  /* ---- 技术亮点导览（系统透视专属）：操作到哪，对应 Feature 点亮到哪 ---- */
  const [spotFlags, setSpotFlags] = useState<SpotFlags>({
    gen: false,
    av: false,
    trace: false,
    arb: false,
    agency: false,
    modal: false,
  });
  const hitSpot = (key: keyof SpotFlags) =>
    setSpotFlags((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  /* 画像驱动现做：进页即触发（本讲已按画像拼装完成） */
  useEffect(() => hitSpot('gen'), []);

  /* 图谱深链：?block=cN → 定位并闪烁对应概念块 */
  const [searchParams] = useSearchParams();
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    const target = searchParams.get('block');
    if (!target) return;
    const id = `${kpId}-${target}`;
    const idx = unit.blocks.findIndex((bb) => bb.id === id);
    if (idx < 0) return;
    const t = setTimeout(() => {
      blockRefs.current[idx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashId(id);
      setTimeout(() => setFlashId(null), 2200);
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kpId, searchParams, unit]);

  /* ---- 播放引擎（cue 级） ---- */
  const tts = useTts();
  const snd = useClassroomSound();
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  const [cursor, setCursor] = useState(0);
  const [subtitle, setSubtitle] = useState<string | null>(null);
  const [kbGlow, setKbGlow] = useState(false);
  const [rateIdx, setRateIdx] = useState(1);
  /** 每块已点亮的演播元素 */
  const [reveals, setReveals] = useState<Record<string, number[]>>({});
  const cancelRef = useRef<(() => void) | null>(null);
  const posRef = useRef<{ b: number; c: number }>({ b: 0, c: 0 });
  const blockRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const [cpPicks, setCpPicks] = useState<Record<string, number>>({});
  /** 答对庆祝：叶子飘落挂在该检查点块上 */
  const [leafFallFor, setLeafFallFor] = useState<string | null>(null);
  /* 记笔记：正在编辑的块 + 草稿 */
  const { addNote, notes } = useNotes();
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');

  /**
   * 播放条全局记笔记 —— 现在是唯一入口，所以必须挂到「用户正在看的那一段」。
   * 取视口中心最近的块（而非播放光标所在块：不播放时两者常常不是同一段，
   * 那样会把笔记记到用户没在看的内容上）。
   */
  const openNoteHere = () => {
    const bl = blocksRef.current;
    const mid = window.innerHeight / 2;
    let best = cursor;
    let bestD = Infinity;
    Object.entries(blockRefs.current).forEach(([idx, el]) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const d = Math.abs(r.top + r.height / 2 - mid);
      if (d < bestD) { bestD = d; best = Number(idx); }
    });
    /* 检查点不支持记笔记，往前找最近一个可记的块 */
    let i = best;
    while (i >= 0 && bl[i]?.kind === 'checkpoint') i--;
    if (i < 0) i = 0;
    setNoteFor(bl[i].id);
    setNoteText('');
    scrollToBlock(i);
  };
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const [qaLog, setQaLog] = useState<{ q: string; a: string; kbRef?: string }[]>([]);
  const [listening, setListening] = useState(false);
  const [finished, setFinished] = useState(false);
  const finishedSignalRef = useRef(false);

  /* ---- 动态调整可视化：新块先播"信号→裁定→生成中"流水线再浮现 ---- */
  const [materializing, setMaterializing] = useState<Record<string, [string, string, string]>>({});
  const materialize = (block: CourseBlock, steps: [string, string, string]) => {
    setMaterializing((prev) => ({ ...prev, [block.id]: steps }));
    setTimeout(() => {
      setMaterializing((prev) => {
        const next = { ...prev };
        delete next[block.id];
        return next;
      });
    }, 1800);
  };

  /* ---- 幻灯模式（PPT 视图）：一段一页放大讲，随语音翻页 ---- */
  const [slideMode, setSlideMode] = useState(false);
  const [slideIdx, setSlideIdx] = useState(0);

  /* ---- 学习者主权：段落签到 / 强化菜单 / 进阶协商 / 模态切换 ---- */
  /** 每块的签到结果（签过就不再出条） */
  const [selfCheck, setSelfCheck] = useState<Record<string, 'ok' | 'variant' | 'quiz'>>({});
  /** 概念块的呈现模态：读(默认) / 看(图卡) / 听(跟读) */
  const [blockMode, setBlockMode] = useState<Record<string, 'read' | 'cards' | 'listen'>>({});
  /** 进阶协商面板是否展开（分数不够时点进阶挑战触发） */
  const [negotiating, setNegotiating] = useState(false);
  const variantSeq = useRef(0);
  const relearnSeq = useRef(0);
  /** 已用过的题（本讲检查点 + 插入题），抽题时排除 */
  const usedQuizIds = () => {
    const ids = new Set<string>();
    blocksRef.current.forEach((b) => { if (b.kind === 'checkpoint') ids.add(b.q.id); });
    return [...ids];
  };
  /** 进阶挑战护栏：挑战题 id + 错题计数，两错 ARB-05 接回 */
  const challengeIdsRef = useRef<Set<string>>(new Set());
  const challengeWrongRef = useRef(0);

  const insertBlocksAfter = (idx: number, ...bs: CourseBlock[]) => {
    setBlocks((prev) => {
      const next = [...prev];
      next.splice(idx + 1, 0, ...bs);
      return next;
    });
  };

  /* ---- 专注模式：全屏 + 收 chrome + 聚光灯 + 计时 → 退出结算能量 ---- */
  const { focusMode, setFocusMode, earn } = useGrowth();
  const ambient = useAmbient();
  /** 通勤模式：只听不看——放大字幕、隐藏正文，适合走路/坐车/实训间隙 */
  const [audioMode, setAudioMode] = useState(false);

  /* 幻灯翻页：讲播时跟着光标走；手动翻页时若在播则从新页接着讲 */
  useEffect(() => {
    if (slideMode && playing) setSlideIdx(cursor);
  }, [slideMode, playing, cursor]);
  const openSlides = () => {
    hitSpot('modal');
    setAudioMode(false);
    setSlideIdx(playing ? cursor : posRef.current.b);
    setSlideMode(true);
  };
  const slideGo = (d: 1 | -1) => {
    const n = Math.min(blocksRef.current.length - 1, Math.max(0, slideIdx + d));
    if (n === slideIdx) return;
    setSlideIdx(n);
    if (playingRef.current) {
      stopPlayback();
      startPlay(n, 0);
    } else {
      posRef.current = { b: n, c: 0 };
      setCursor(n);
    }
  };
  const focusStartRef = useRef<number | null>(null);
  const focusFromBlockRef = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  const [settlement, setSettlement] = useState<{ mins: string; blocks: number; bonus: number } | null>(null);

  useEffect(() => {
    if (!focusMode) return;
    const t = setInterval(() => {
      if (focusStartRef.current) setElapsed(Math.floor((Date.now() - focusStartRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [focusMode]);

  const enterFocus = () => {
    focusStartRef.current = Date.now();
    focusFromBlockRef.current = cursor;
    setElapsed(0);
    setFocusMode(true);
    document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  const exitFocus = () => {
    const sec = focusStartRef.current ? Math.floor((Date.now() - focusStartRef.current) / 1000) : 0;
    focusStartRef.current = null;
    setFocusMode(false);
    ambient.setKind('off');
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => undefined);
    const mins = `${Math.floor(sec / 60)}分${(sec % 60).toString().padStart(2, '0')}秒`;
    const blocksHeard = Math.max(0, cursor - focusFromBlockRef.current);
    /* 专注加成：每 30 秒 1 能量 × 1.2，最少 3、封顶 60（演示数值） */
    const bonus = Math.min(60, Math.max(3, Math.round((sec / 30) * 1.2)));
    earn(bonus, `专注学习 ${mins}（×1.2 加成）`);
    setSettlement({ mins, blocks: blocksHeard, bonus });
  };

  /* 用户按 Esc 退出全屏 = 退出专注 */
  useEffect(() => {
    if (!focusMode) return;
    const onFs = () => { if (!document.fullscreenElement) exitFocus(); };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMode, cursor]);

  const scrollToBlock = (i: number) =>
    blockRefs.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const stopPlayback = () => {
    cancelRef.current?.();
    tts.stop();
    playingRef.current = false;
    setPlaying(false);
    setKbGlow(false);
  };

  const finish = () => {
    setFinished(true);
    /* 完课信号只发一次（重学/微测再次播到尾不重复回写） */
    if (finishedSignalRef.current) return;
    finishedSignalRef.current = true;
    pushSignal({ type: 'lecture-read', kpId, title: `${kp.name} · 交互课件（${unit.difficulty}版）` });
    /* 遗忘曲线：这一株刚浇过水，重置保持率并 +1 次复习 */
    markStudied(kpId);
    toast.success(`《${kp.name}》学完 · 阿诊已回写画像`, {
      description: nextNode ? `学习路径推进 → 下一步《${nextNode.title}》` : '本条学习路径已全部完成 🎉',
    });
  };

  /** 讲播一个 cue，讲完自动推进 */
  const playCue = (b: number, c: number) => {
    const bl = blocksRef.current;
    if (b >= bl.length) {
      stopPlayback();
      setSubtitle(null);
      finish();
      return;
    }
    const block = bl[b];
    const cues = cuesOf(block);
    if (c >= cues.length) {
      /* 本块讲完：检查点未作答则停下等人，否则去下一块 */
      if (block.kind === 'checkpoint' && cpPicksRef.current[block.id] === undefined) {
        playingRef.current = false;
        setPlaying(false);
        setSubtitle('（等你作答——答完自动继续）');
        return;
      }
      snd.chime();
      playCue(b + 1, 0);
      return;
    }
    posRef.current = { b, c };
    setCursor(b);
    if (c === 0) scrollToBlock(b);
    const cue = cues[c];
    setSubtitle(cue.say);
    setKbGlow(Boolean(cue.kbFlash));
    if (cue.kbFlash) hitSpot('trace');
    if (cue.reveal) {
      setReveals((prev) => {
        const cur = new Set(prev[block.id] ?? []);
        cue.reveal!.forEach((r) => cur.add(r));
        return { ...prev, [block.id]: [...cur] };
      });
    }
    cancelRef.current = tts.speak(cue.say, RATES[rateIdx], () => {
      if (playingRef.current) playCue(b, c + 1);
    });
  };

  const cpPicksRef = useRef(cpPicks);
  cpPicksRef.current = cpPicks;

  const startPlay = (b: number, c: number) => {
    hitSpot('av');
    playingRef.current = true;
    setPlaying(true);
    /* 从块头播时清掉该块已点亮状态，重新演一遍 */
    if (c === 0) {
      const id = blocksRef.current[b]?.id;
      if (id) setReveals((prev) => ({ ...prev, [id]: [] }));
    }
    playCue(b, c);
  };

  const togglePlay = () => {
    if (playing) stopPlayback();
    else startPlay(posRef.current.b, posRef.current.c);
  };

  useEffect(() => () => { cancelRef.current?.(); tts.stop(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- 检查点 ---- */
  const answerCheckpoint = (b: Extract<CourseBlock, { kind: 'checkpoint' }>, idx: number, optIndex: number) => {
    if (cpPicks[b.id] !== undefined) return;
    const correct = optIndex === b.q.answerIndex;
    setCpPicks((prev) => ({ ...prev, [b.id]: optIndex }));
    if (correct) {
      snd.ding();
      setLeafFallFor(b.id);
      setTimeout(() => setLeafFallFor(null), 1700);
    } else {
      snd.dong();
      hitSpot('arb');
      /* 课件检查点不在 quizBank 里，题面随记录一起存 */
      addWrong({
        qid: b.id,
        kpId: b.q.kpId,
        from: 'checkpoint',
        pick: optIndex,
        inline: {
          stem: b.q.stem,
          options: b.q.options,
          answerIndex: b.q.answerIndex,
          analysis: b.q.analysis,
        },
      });
    }
    pushSignal({ type: 'quiz-answer', kpId: b.q.kpId, level: b.q.level, correct });
    /* 每答一题都是一次画像校准证据（精简建档的低置信画像靠这个涨） */
    void bumpConfidence(currentLearner.id);
    /* 进阶挑战护栏：学习者越权上调时约定"两错接回"——ARB-05 兑现承诺 */
    if (challengeIdsRef.current.has(b.id) && !correct) {
      challengeWrongRef.current += 1;
      if (challengeWrongRef.current >= 2) {
        const pending = new Set(challengeIdsRef.current);
        pending.delete(b.id); // 当前这道保留（刚作答完要显示解析）
        challengeIdsRef.current.clear();
        const rb = remedialBlockOf(kpId);
        materialize(rb, ['信号：进阶挑战两错', 'ARB-05 兑现承诺：接你回来', 'GEN-03 正在生成降维讲解…']);
        setBlocks((prev) => {
          /* 撤掉还没做的挑战题，插入降维块 */
          const next = prev.filter((x) => !(x.kind === 'checkpoint' && pending.has(x.id)));
          const at = next.findIndex((x) => x.id === b.id);
          next.splice((at < 0 ? idx : at) + 1, 0, rb);
          return next;
        });
        toast('ARB-05：说好的，两错接你回来', {
          description: '挑战先到这——退一步把地基补牢，随时可以再来。',
        });
        setTimeout(() => scrollToBlock(idx + 1), 250);
        return;
      }
    }
    if (!correct) {
      const rb = remedialBlockOf(kpId);
      materialize(rb, ['信号：检查点答错', 'ARB-05 裁定：降维换讲法', 'GEN-03 正在按你的水平重讲…']);
      setBlocks((prev) => {
        const next = [...prev];
        next.splice(idx + 1, 0, rb);
        return next;
      });
    }
    /* 讲播中断在检查点 → 作答后续播（答错时给"生成中"动画留足时间） */
    setTimeout(() => {
      if (!playingRef.current && subtitle === '（等你作答——答完自动继续）') startPlay(idx + 1, 0);
      else if (playingRef.current) startPlay(idx + 1, 0);
    }, correct ? 900 : 2100);
  };

  /* ---- 举手提问 ---- */
  const raiseHand = () => {
    stopPlayback();
    setAsking(true);
  };

  const submitQuestion = () => {
    const q = question.trim();
    if (!q) return;
    const hit = matchQA(kpId, q);
    const a = hit ? hit.a : fallbackAnswer;
    setQaLog((prev) => [...prev, { q, a, kbRef: hit?.kbRef }]);
    setQuestion('');
    tts.speak(a, RATES[rateIdx], () => undefined);
    /* 提问沉淀进个人知识库：你问过什么本身就是学情，问完就丢太可惜 */
    addNote({
      kpId,
      text: `问：${q}\n答：${a}`,
      source: `${kp.name} · 课堂提问`,
      sourceKind: 'qa',
      kbRefs: hit?.kbRef ? [hit.kbRef] : [],
    });
  };

  const startListening = () => {
    const SR = getRecognizer();
    if (!SR) return;
    const rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => { setQuestion(e.results[0][0].transcript); setListening(false); };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    setListening(true);
    rec.start();
  };
  const srAvailable = getRecognizer() !== null;

  /* 演示导览：正在讲播该块时，最后点亮的下标即导览步 */
  const tourStepOf = (b: CourseBlock, i: number): number | null => {
    if (!playing || cursor !== i) return null;
    const arr = reveals[b.id];
    if (!arr || arr.length === 0) return null;
    return Math.max(...arr);
  };

  /* ---- 段落签到：学习者按状态自选下一步 ---- */
  const checkInOk = (b: CourseBlock) => {
    hitSpot('agency');
    setSelfCheck((prev) => ({ ...prev, [b.id]: 'ok' }));
    snd.chime();
    pushSignal({ type: 'self-report', kpId, feel: 'ok' });
  };
  const checkInVariant = (b: CourseBlock, i: number) => {
    hitSpot('agency');
    setSelfCheck((prev) => ({ ...prev, [b.id]: 'variant' }));
    pushSignal({ type: 'self-report', kpId, feel: 'unsure' });
    stopPlayback();
    const vb = variantBlockOf(kpId, variantSeq.current++);
    materialize(vb, ['信号：你签到「这段还虚」', 'ARB-05 裁定：换讲法', 'GEN-03 正在换问答体重讲…']);
    insertBlocksAfter(i, vb);
    setTimeout(() => scrollToBlock(i + 1), 250);
  };
  const checkInQuiz = (b: CourseBlock, i: number) => {
    const [q] = drawQuestions(kpId, 1, { excludeIds: usedQuizIds() });
    if (!q) { toast('这一讲的题都被你做完了', { description: '去「练」里有整套分阶题' }); return; }
    hitSpot('agency');
    setSelfCheck((prev) => ({ ...prev, [b.id]: 'quiz' }));
    stopPlayback();
    insertBlocksAfter(i, { kind: 'checkpoint', id: `${kpId}-extra-${q.id}`, q, script: '来，小试一道。' });
    setTimeout(() => scrollToBlock(i + 1), 250);
  };

  /* ---- 讲末强化菜单 ---- */
  const relearnRestyled = () => {
    stopPlayback();
    const options = STYLE_LABELS.filter((s) => s !== unit.styleLabel);
    const next = options[relearnSeq.current++ % options.length];
    setStyleOverride(next);
    setCpPicks({});
    setReveals({});
    setSelfCheck({});
    setFinished(false);
    posRef.current = { b: 0, c: 0 };
    setCursor(0);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('GEN-03 正在重新拼装本讲', { description: `换成「${next}」风格——同样的知识点，另一种讲法` });
  };
  const startMiniTest = () => {
    const levels = unit.difficulty === '进阶' ? undefined : (['basic', 'advanced'] as const);
    const qs = drawQuestions(kpId, 3, { excludeIds: usedQuizIds(), levels: levels ? [...levels] : undefined });
    if (qs.length === 0) { toast('题库里没有新题了', { description: '去「练」里做整套分阶题吧' }); return; }
    stopPlayback();
    setFinished(false);
    const startIdx = blocksRef.current.length - 1;
    setBlocks((prev) => [
      ...prev,
      ...qs.map((q, qi) => ({ kind: 'checkpoint' as const, id: `${kpId}-mini-${q.id}`, q, script: qi === 0 ? '微测开始，三道题看看整体掌握。' : '下一道。' })),
    ]);
    toast(`微测 ${qs.length} 题已就位`, { description: '做完自动回到完课结算' });
    setTimeout(() => scrollToBlock(startIdx + 1), 250);
  };
  const startChallenge = () => {
    const qs = drawQuestions(kpId, 2, { excludeIds: usedQuizIds(), levels: ['advanced', 'challenge'] });
    if (qs.length === 0) { toast('没有更难的题了', { description: '这一讲的进阶题你都见过了' }); return; }
    setNegotiating(false);
    stopPlayback();
    setFinished(false);
    challengeWrongRef.current = 0;
    challengeIdsRef.current = new Set(qs.map((q) => `${kpId}-chal-${q.id}`));
    const startIdx = blocksRef.current.length - 1;
    setBlocks((prev) => [
      ...prev,
      ...qs.map((q, qi) => ({ kind: 'checkpoint' as const, id: `${kpId}-chal-${q.id}`, q, script: qi === 0 ? '进阶挑战，上强度了。' : '再来。' })),
    ]);
    setTimeout(() => scrollToBlock(startIdx + 1), 250);
  };
  const markDoubtHere = () => {
    markDoubt(kpId);
    toast('已标记存疑', { description: `园子里的「${kp.name}」会提前"口渴"，提醒你回来再过一遍` });
  };
  const kpScore = currentLearner.scores[kpId] ?? 50;
  const challengeReady = kpScore >= 66;

  return (
    <div className="mx-auto max-w-[860px] px-5 pb-48 pt-6 md:px-6">
      {/* 技术亮点导览：仅系统透视视角渲染，学习者视角不打扰 */}
      {viewMode !== 'learner' && <FeatureSpotlight flags={spotFlags} />}

      {/* 页头 */}
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/learn" className="inline-flex items-center gap-1 text-[13px] text-ink-muted hover:text-brand">
          <ArrowLeft size={14} /> 课程目录
        </Link>
        <span className="text-hairline">/</span>
        <h1 className="font-serif text-[20px] font-semibold text-ink">{kp.name}</h1>
        <span className="ml-auto flex items-center gap-2">
          <Link
            to="/me/notes"
            title="个人知识库"
            className="inline-flex items-center gap-1 rounded-md border border-hairline bg-card-warm px-2 py-0.5 font-mono text-[10.5px] text-ink-2 transition-colors hover:border-brand/40 hover:text-brand"
          >
            <NotebookPen size={11} />
            笔记 {notes.filter((nt) => nt.kpId === kpId).length}
          </Link>
          <span className="rounded-md border border-brand/30 bg-brand-tint px-2 py-0.5 font-mono text-[10.5px] font-medium text-brand">
            <Sparkles size={10} className="mr-0.5 inline" />
            AI 现做 · {unit.difficulty}版 · {unit.styleLabel}
          </span>
        </span>
      </div>

      {/* 首次进课件：把不在明面上的能力说一句 */}
      <PageTip id="learn-unit" className="mt-4">
        听不懂随时点<span className="font-medium text-ink">举手提问</span>，AI 会停下来答；
        还能调<span className="font-medium text-ink">语速</span>、开<span className="font-medium text-ink">专注模式</span>（带雨声/林间白噪）。
        正文里的 <span className="font-mono text-brand">[KB-xxx]</span> 点开能看出处。
      </PageTip>

      {/* 路径进度（当前单元在整条学习路径的位置） */}
      <div className="mt-3">
        <PathProgressBar currentKpId={kpId} compact />
      </div>

      {/* 开讲适配横幅：把"检测到薄弱 → 内容已调整"直接亮给学习者看 */}
      <AdaptiveBanner
        kpName={kp.name}
        score={currentLearner.scores[kpId] ?? 50}
        target={kp.targetLevel}
        isWeakest={weakestKp.id === kpId}
        difficulty={unit.difficulty}
        styleLabel={unit.styleLabel}
        expert={viewMode === 'expert'}
      />

      {/* block 流 */}
      <div className="mt-6 space-y-4">
        {blocks.map((b, i) => {
          const active = i === cursor && playing;
          const wrapCls = cn(
            'relative overflow-hidden rounded-[14px] border p-5 transition-all duration-300',
            active ? 'border-brand/50 bg-brand-tint/30 shadow-warm' : 'border-hairline bg-card-warm',
            b.kind === 'remedial' && 'border-brand-amber/50 bg-brand-amber-tint/40',
            flashId === b.id && 'border-brand-amber ring-2 ring-brand-amber/60 shadow-warm-lg',
            /* 专注聚光灯：非当前块调暗 */
            focusMode && i !== cursor && 'opacity-30',
          );
          const glowBadges = active && kbGlow;
          return (
            <div key={b.id} ref={(el) => { blockRefs.current[i] = el; }} className={wrapCls}>
              {materializing[b.id] ? (
                <AdjustPipeline steps={materializing[b.id]} />
              ) : (
              <>
              {(b.kind === 'concept' || b.kind === 'remedial' || b.kind === 'summary') && (
                <>
                  {b.kind === 'remedial' && (
                    <div className="mb-2 inline-flex items-center gap-1.5 rounded-md border border-brand-amber/60 bg-paper px-2 py-1 font-mono text-[10.5px] font-medium text-ochre">
                      <Scale size={11} />
                      ARB-05 决策：检查点未通过 → 降维换讲法
                    </div>
                  )}
                  <div className="flex items-start justify-between gap-2">
                    {'title' in b && b.title ? <h3 className="text-[16px] font-semibold text-ink">{b.title}</h3> : <span />}
                    {/* 模态切换：同一段内容，用你喜欢的方式学（读/看/听） */}
                    {b.kind === 'concept' && (
                      <span className="flex shrink-0 gap-0.5 rounded-[9px] border border-hairline bg-paper p-0.5">
                        {([
                          { m: 'read', icon: AlignLeft, label: '读' },
                          { m: 'cards', icon: LayoutGrid, label: '看' },
                          { m: 'listen', icon: Headphones, label: '听' },
                        ] as const).map(({ m, icon: MIcon, label }) => {
                          const cur = blockMode[b.id] ?? 'read';
                          return (
                            <button
                              key={m}
                              type="button"
                              title={`用「${label}」的方式学这段`}
                              onClick={() => {
                                if (cur === m) return;
                                hitSpot('modal');
                                setBlockMode((prev) => ({ ...prev, [b.id]: m }));
                                pushSignal({ type: 'modality-switch', kpId, mode: m });
                              }}
                              className={cn(
                                'flex items-center gap-1 rounded-[7px] px-1.5 py-0.5 text-[10.5px] font-medium transition-all',
                                cur === m ? 'bg-brand text-paper' : 'text-ink-muted hover:text-ink',
                              )}
                            >
                              <MIcon size={11} />
                              {label}
                            </button>
                          );
                        })}
                      </span>
                    )}
                  </div>
                  {(b.kind !== 'concept' || (blockMode[b.id] ?? 'read') === 'read') && (
                    <p className="mt-2 whitespace-pre-line text-[14px] leading-[25px] text-ink-2">{b.text}</p>
                  )}
                  {b.kind === 'concept' && blockMode[b.id] === 'cards' && (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {b.text
                        .split(/\n+/)
                        .flatMap((p) => p.split(/(?<=[。！？])/))
                        .map((t) => t.trim())
                        .filter((t) => t.length > 3)
                        .slice(0, 8)
                        .map((t, ti) => (
                          <div key={ti} className="flex items-start gap-2 rounded-[10px] border border-hairline bg-paper p-3 text-[13px] leading-[21px] text-ink-2">
                            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                            {t}
                          </div>
                        ))}
                    </div>
                  )}
                  {b.kind === 'concept' && blockMode[b.id] === 'listen' && (
                    <div className="mt-3 flex flex-col items-center gap-3 rounded-[10px] border border-hairline bg-paper py-6">
                      <Headphones size={20} className="text-brand" />
                      {playing && cursor === i ? (
                        <p className="max-w-[540px] px-4 text-center font-serif text-[17px] leading-[30px] text-ink">{subtitle ?? '…'}</p>
                      ) : (
                        <button
                          type="button"
                          onClick={() => { stopPlayback(); startPlay(i, 0); }}
                          className="lf-btn-primary !py-2 text-[13px]"
                        >
                          <Play size={13} fill="currentColor" /> 听这一段
                        </button>
                      )}
                      <span className="text-[11px] text-ink-muted">只用耳朵学这一段——正文已折叠，切回「读」随时展开</span>
                    </div>
                  )}
                  {'kbRefs' in b && b.kbRefs.length > 0 && (
                    <div className={cn('mt-3 flex flex-wrap gap-1.5 border-t border-hairline pt-2.5 transition-all', glowBadges && 'animate-pulse')}>
                      {b.kbRefs.map((id) => (
                        <span key={id} className={cn(glowBadges && 'rounded-md ring-2 ring-brand-amber/70')}>
                          <TraceBadge kbId={id} />
                        </span>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* 演播块：黑板教具随语音点亮 */}
              {b.kind === 'stage' && (
                <>
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h3 className="text-[16px] font-semibold text-ink">{b.title}</h3>
                    <button
                      type="button"
                      onClick={() => { stopPlayback(); startPlay(i, 0); }}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-brand/35 bg-paper px-2 py-1 text-[11.5px] font-medium text-brand hover:bg-brand-tint"
                    >
                      <Play size={11} fill="currentColor" /> 讲这一段
                    </button>
                  </div>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {b.items.map((item, ii) => {
                      const arr = reveals[b.id];
                      const narrating = playing && cursor === i;
                      const visible = narrating ? (arr ?? []).includes(ii) : true;
                      const current = narrating && arr && arr.length > 0 && Math.max(...arr) === ii;
                      return (
                        <div key={ii} className={cn(item.type === 'figure' && 'sm:col-span-2')}>
                          <StageItemView item={item} visible={visible} current={Boolean(current)} />
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {/* 演示块：导览 → 自己动手 */}
              {b.kind === 'demo' && (
                <>
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h3 className="text-[16px] font-semibold text-ink">{b.title}</h3>
                    {b.cues && (
                      <button
                        type="button"
                        onClick={() => { stopPlayback(); startPlay(i, 0); }}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-brand-amber/50 bg-brand-amber-tint px-2 py-1 text-[11.5px] font-medium text-ochre hover:border-brand-amber"
                      >
                        <Play size={11} fill="currentColor" /> 跟我看一遍
                      </button>
                    )}
                  </div>
                  {b.demo === 'calibration' && <CalibrationSim tourStep={tourStepOf(b, i)} />}
                  {b.demo === 'frame' && <FrameDemo tourStage={tourStepOf(b, i)} />}
                  {b.demo === 'plc' && <PlcLadderDemo tourStep={tourStepOf(b, i)} />}
                  {b.demo === 'safety' && <SafetyLoopDemo tourStep={tourStepOf(b, i)} />}
                  {b.demo === 'vision' && <VisionGuideDemo tourStep={tourStepOf(b, i)} />}
                  {b.demo === 'fault' && <FaultTreeDemo tourStep={tourStepOf(b, i)} />}
                </>
              )}

              {/* 检查点 */}
              {b.kind === 'checkpoint' && (
                <>
                  {/* 答对庆祝：叶子飘落 */}
                  {leafFallFor === b.id && (
                    <div className="pointer-events-none absolute inset-x-0 top-0 h-full overflow-hidden" aria-hidden>
                      {[
                        { l: '18%', d: '0s', x: '18px', s: '150deg' },
                        { l: '38%', d: '0.14s', x: '-14px', s: '-130deg' },
                        { l: '58%', d: '0.07s', x: '22px', s: '190deg' },
                        { l: '78%', d: '0.21s', x: '-20px', s: '-160deg' },
                      ].map((f, i) => (
                        <span
                          key={i}
                          className="lf-leaf-fall absolute"
                          style={{ left: f.l, top: 8, animationDelay: f.d, ['--lf-drift' as string]: f.x, ['--lf-spin' as string]: f.s }}
                        >
                          <svg width="16" height="10" viewBox="0 0 16 10">
                            <ellipse cx="8" cy="5" rx="7.5" ry="3.6" fill="#9BC5AC" opacity="0.9" />
                            <ellipse cx="6" cy="4" rx="2.4" ry="1.3" fill="#FFFFFF" opacity="0.45" />
                          </svg>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mb-2 inline-flex items-center gap-1.5 rounded-md border border-brand/35 bg-paper px-2 py-1 font-mono text-[10.5px] font-medium text-brand">
                    检查点 · 答对继续，答错我换讲法
                  </div>
                  <p className="text-[14.5px] font-medium leading-[23px] text-ink">{b.q.stem}</p>
                  <div className="mt-3 space-y-2">
                    {b.q.options.map((opt, oi) => {
                      const pickedIdx = cpPicks[b.id];
                      const show = pickedIdx !== undefined;
                      const isAnswer = oi === b.q.answerIndex;
                      const isPicked = pickedIdx === oi;
                      return (
                        <button
                          key={oi}
                          type="button"
                          disabled={show}
                          onClick={() => answerCheckpoint(b, i, oi)}
                          className={cn(
                            'flex w-full items-center gap-2.5 rounded-[10px] border px-3.5 py-2.5 text-left text-[13.5px] transition-all',
                            !show && 'border-hairline bg-paper text-ink-2 hover:border-brand/40 hover:bg-brand-tint/40',
                            show && isAnswer && 'border-brand-success/60 bg-brand-success/10 text-ink',
                            show && isPicked && !isAnswer && 'border-brand-danger/60 bg-brand-danger/10 text-ink',
                            show && !isAnswer && !isPicked && 'border-hairline bg-paper text-ink-muted opacity-60',
                          )}
                        >
                          <span className="font-mono text-[12px] text-ink-muted">{letters[oi]}</span>
                          {opt}
                          {show && isAnswer && <Check size={14} className="ml-auto shrink-0 text-brand-success" />}
                          {show && isPicked && !isAnswer && <X size={14} className="ml-auto shrink-0 text-brand-danger" />}
                        </button>
                      );
                    })}
                  </div>
                  {cpPicks[b.id] !== undefined && (
                    <p className="mt-2.5 rounded-[8px] bg-paper px-3 py-2 text-[12.5px] leading-[19px] text-ink-muted">{b.q.analysis}</p>
                  )}
                </>
              )}

              {/* 段落签到：学习者按自己的状态选下一步——很稳 / 换讲法 / 出道题 */}
              {(b.kind === 'concept' || b.kind === 'stage' || b.kind === 'demo') &&
                !b.id.endsWith('-intro') &&
                !b.id.includes('-variant-') &&
                !selfCheck[b.id] && (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-hairline/60 pt-2.5">
                    <span className="mr-1 text-[11.5px] text-ink-muted">这段感觉如何？</span>
                    <button
                      type="button"
                      onClick={() => checkInOk(b)}
                      className="inline-flex items-center gap-1 rounded-md border border-brand/30 bg-brand-tint/50 px-2 py-1 text-[11.5px] font-medium text-brand transition-all hover:bg-brand-tint"
                    >
                      <Check size={11} /> 很稳，继续
                    </button>
                    <button
                      type="button"
                      onClick={() => checkInVariant(b, i)}
                      className="inline-flex items-center gap-1 rounded-md border border-hairline bg-paper px-2 py-1 text-[11.5px] font-medium text-ink-2 transition-all hover:border-brand-amber/60 hover:text-ochre"
                    >
                      <Shuffle size={11} /> 有点虚，换个讲法
                    </button>
                    <button
                      type="button"
                      onClick={() => checkInQuiz(b, i)}
                      className="inline-flex items-center gap-1 rounded-md border border-hairline bg-paper px-2 py-1 text-[11.5px] font-medium text-ink-2 transition-all hover:border-brand/40 hover:text-brand"
                    >
                      <PenLine size={11} /> 出道题试试
                    </button>
                  </div>
                )}
              {selfCheck[b.id] === 'ok' && (
                <div className="mt-3 border-t border-hairline/60 pt-2 text-[11px] text-ink-muted">
                  <Check size={10} className="mr-1 inline text-brand" />
                  已签到「很稳」——阿诊记下了这条元认知证据
                </div>
              )}

              {/* 记笔记：不再每块一个按钮（7 个重复入口），统一由播放条上的「记笔记」触发；
                  这里只在「正在编辑」或「本段已有笔记」时出现 */}
              {b.kind !== 'checkpoint' && (noteFor === b.id || notes.some((nt) => nt.blockAnchor === b.id)) && (
                <div className="mt-3 border-t border-hairline/60 pt-2">
                  {noteFor === b.id ? (
                    <div className="rounded-[10px] border border-brand/30 bg-paper p-2.5">
                      <textarea
                        autoFocus
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        rows={2}
                        placeholder="用自己的话记下这一段的要点…"
                        className="w-full resize-none bg-transparent text-[13px] leading-[20px] text-ink outline-none placeholder:text-ink-muted/60"
                      />
                      <div className="mt-1.5 flex items-center justify-between">
                        <span className="font-mono text-[10px] text-ink-muted">
                          自动携带来源{'kbRefs' in b && b.kbRefs.length > 0 ? ' + KB 溯源' : ''} → 个人知识库
                        </span>
                        <span className="flex gap-1.5">
                          <button type="button" onClick={() => { setNoteFor(null); setNoteText(''); }} className="rounded-md px-2 py-1 text-[12px] text-ink-muted hover:text-ink">取消</button>
                          <button
                            type="button"
                            disabled={!noteText.trim()}
                            onClick={() => {
                              addNote({
                                kpId,
                                text: noteText.trim(),
                                source: `${kp.name} · ${'title' in b && b.title ? b.title : b.kind === 'summary' ? '本讲小结' : '课件'}`,
                                sourceKind: 'course',
                                blockAnchor: b.id,
                                kbRefs: 'kbRefs' in b ? b.kbRefs : [],
                              });
                              setNoteFor(null);
                              setNoteText('');
                            }}
                            className={cn('rounded-md px-2.5 py-1 text-[12px] font-medium', noteText.trim() ? 'bg-brand text-paper' : 'bg-paper-deep text-ink-muted/50')}
                          >
                            存入知识库
                          </button>
                        </span>
                      </div>
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-muted">
                      <PenLine size={11} className="text-brand/70" />
                      这段记了 {notes.filter((nt) => nt.blockAnchor === b.id).length} 条
                    </span>
                  )}
                </div>
              )}
              </>
              )}
            </div>
          );
        })}

        <AnimatePresence>
          {finished && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              className="relative rounded-[14px] border border-brand/35 bg-brand-tint/50 p-5 text-center"
            >
              {/* 完成卡草丛 */}
              <GrassTuft className="pointer-events-none absolute bottom-1 left-4 h-[40px] w-[56px] opacity-60" />
              <GrassTuft className="pointer-events-none absolute bottom-1 right-4 h-[40px] w-[56px] scale-x-[-1] opacity-50" />
              {/* 「灵光一闪」金色发光球绽放 */}
              <div className="lf-bloom relative mx-auto mb-3 h-16 w-16">
                <span className="lf-orb absolute inset-0" />
                <span className="absolute inset-0 flex items-center justify-center">
                  <Check size={28} strokeWidth={2.5} className="text-paper drop-shadow" />
                </span>
              </div>
              <div className="text-[15px] font-semibold text-brand">本讲完成 · 阿诊已记录，画像已微调</div>
              {nextNode && (
                <div className="mt-2 text-[12.5px] text-ink-muted">
                  学习路径推进 → 下一步《{nextNode.title}》 · {nextNode.est}
                </div>
              )}
              <div className="mt-3 flex flex-wrap justify-center gap-2.5">
                {nextNode && (
                  <button
                    type="button"
                    onClick={() => navigate(resolveLearnTarget(dataId, nextNode.kpId, nextNode.title).to)}
                    className="lf-btn-primary !py-2 text-[13.5px]"
                  >
                    <Route size={14} /> 继续路径 · 《{nextNode.title}》
                  </button>
                )}
                <button type="button" onClick={() => navigate('/tutoring')} className="lf-btn-ghost !py-2 text-[13.5px]">
                  去练一节巩固 <ArrowRight size={14} />
                </button>
                <Link to="/report" className="lf-btn-ghost !py-2 text-[13.5px]">看我的成长</Link>
                <Link to="/learn" className="lf-btn-ghost !py-2 text-[13.5px]">回课程目录</Link>
              </div>

              {/* ---- 强化菜单：学习者自己决定"这一讲够不够" ---- */}
              <div className="mt-4 border-t border-brand/20 pt-3.5">
                <div className="mb-2 text-[12px] font-medium text-ink-2">觉得还不够稳？这一讲还可以：</div>
                <div className="flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={relearnRestyled}
                    className="inline-flex items-center gap-1.5 rounded-[10px] border border-hairline bg-paper px-3 py-1.5 text-[12.5px] font-medium text-ink-2 transition-all hover:border-brand/40 hover:text-brand"
                  >
                    <RotateCcw size={13} /> 换个角度再学一遍
                  </button>
                  <button
                    type="button"
                    onClick={startMiniTest}
                    className="inline-flex items-center gap-1.5 rounded-[10px] border border-hairline bg-paper px-3 py-1.5 text-[12.5px] font-medium text-ink-2 transition-all hover:border-brand/40 hover:text-brand"
                  >
                    <ListChecks size={13} /> 微测 3 题
                  </button>
                  <button
                    type="button"
                    onClick={() => (challengeReady ? startChallenge() : setNegotiating(true))}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-[10px] border px-3 py-1.5 text-[12.5px] font-medium transition-all',
                      challengeReady
                        ? 'border-brand-amber/60 bg-brand-amber-tint/60 text-ochre hover:border-brand-amber'
                        : 'border-hairline bg-paper text-ink-2 hover:border-brand-amber/50 hover:text-ochre',
                    )}
                  >
                    <Zap size={13} /> 进阶挑战{!challengeReady && ' · 需协商'}
                  </button>
                  <button
                    type="button"
                    onClick={markDoubtHere}
                    className="inline-flex items-center gap-1.5 rounded-[10px] border border-hairline bg-paper px-3 py-1.5 text-[12.5px] font-medium text-ink-2 transition-all hover:border-brand/40 hover:text-brand"
                  >
                    <Bookmark size={13} /> 存疑，改天再来
                  </button>
                </div>

                {/* 主权协商：分数不到进阶线，ARB-05 不硬拦但立规矩 */}
                <AnimatePresence>
                  {negotiating && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className="mx-auto mt-3 max-w-[500px] rounded-[12px] border border-brand-amber/50 bg-brand-amber-tint/50 p-3.5 text-left"
                    >
                      <div className="flex items-center gap-1.5 font-mono text-[10.5px] font-medium text-ochre">
                        <Scale size={11} /> ARB-05 · 调度协商
                      </div>
                      <p className="mt-1.5 text-[13px] leading-[21px] text-ink-2">
                        你的「{kp.name}」当前 {kpScore} 分，还没到进阶线（66）。想试可以——但我盯着：
                        <span className="font-semibold text-ink">两错就接你回来</span>，先补降维讲解再说。
                      </p>
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        <button type="button" onClick={startChallenge} className="lf-btn-primary !px-3.5 !py-1.5 !text-[12.5px]">
                          <Zap size={12} /> 就要试试
                        </button>
                        <button
                          type="button"
                          onClick={() => { setNegotiating(false); startMiniTest(); }}
                          className="lf-btn-ghost !px-3.5 !py-1.5 !text-[12.5px]"
                        >
                          听你的，先微测巩固
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ============ 字幕条 + 播放条 ============ */}
      {/* 通勤模式：只听不看（盖住正文，字幕放大）
          用条件渲染 + CSS transition，不用 AnimatePresence——后者靠 rAF 完成 exit 才卸载，
          页面在后台(document.hidden)时 rAF 停摆会导致遮罩关不掉。CSS 过渡无此依赖。 */}
      {audioMode && (
          <div
            className="lf-fade-in fixed inset-0 z-30 flex flex-col items-center justify-center px-6"
            style={{ background: 'linear-gradient(165deg,#F8F6EF 0%,#EFF4EC 52%,#E9F1EA 100%)' }}
          >
            <GrassTuft className="pointer-events-none absolute bottom-24 left-8 h-[52px] w-[72px] opacity-50" />
            <GrassTuft className="pointer-events-none absolute bottom-24 right-8 h-[44px] w-[62px] scale-x-[-1] opacity-40" />
            <div className="mb-6 flex items-center gap-2 text-[12.5px] text-ink-muted">
              <Headphones size={14} className="text-brand" />
              只听不看 · 适合走路或坐车时听
            </div>
            <p className="max-w-[620px] text-center font-serif text-[26px] font-semibold leading-[42px] text-ink">
              {subtitle ?? (playing ? '…' : '点下面的播放键开始听')}
            </p>
            <div className="mt-8 font-mono text-[12px] text-ink-muted">
              第 {cursor + 1} / {blocks.length} 段 · {kp.name}
            </div>
            <button
              type="button"
              onClick={() => setAudioMode(false)}
              className="mt-6 rounded-[10px] border border-hairline bg-card-warm px-4 py-2 text-[13px] font-medium text-ink-2 transition-all hover:border-brand/40 hover:text-brand"
            >
              退出只听模式，回到课件
            </button>
          </div>
      )}

      {/* ============ 幻灯模式（PPT 视图）：一段一页放大讲，随语音翻页 ============ */}
      {slideMode && (() => {
        const sb = blocks[Math.min(slideIdx, blocks.length - 1)];
        return (
          <div
            className="lf-fade-in fixed inset-0 z-30 flex flex-col"
            style={{ background: 'linear-gradient(165deg,#F8F6EF 0%,#F1F3EA 55%,#EAF0E8 100%)' }}
          >
            {/* 顶栏 */}
            <div className="flex items-center gap-3 border-b border-hairline/70 bg-paper/70 px-5 py-3 backdrop-blur">
              <Presentation size={15} className="text-brand" />
              <span className="text-[13.5px] font-semibold text-ink">幻灯模式 · {kp.name}</span>
              <span className="font-mono text-[11px] text-ink-muted">第 {slideIdx + 1} / {blocks.length} 页</span>
              <button
                type="button"
                onClick={() => setSlideMode(false)}
                className="ml-auto rounded-[10px] border border-hairline bg-card-warm px-3 py-1.5 text-[12.5px] font-medium text-ink-2 transition-all hover:border-brand/40 hover:text-brand"
              >
                <X size={13} className="mr-1 inline" />
                退出幻灯
              </button>
            </div>

            {/* 幻灯主体 */}
            <div className="flex min-h-0 flex-1 items-stretch gap-2 px-4 pb-36 pt-5 md:px-8">
              <button type="button" onClick={() => slideGo(-1)} disabled={slideIdx === 0} title="上一页"
                className="hidden shrink-0 items-center rounded-[12px] px-2 text-ink-muted transition-colors hover:text-brand disabled:opacity-25 sm:flex">
                <ChevronLeft size={26} />
              </button>
              <div key={sb.id} className="lf-anim-in-up mx-auto min-h-0 w-full max-w-[920px] overflow-y-auto rounded-[18px] border border-hairline bg-paper p-7 shadow-warm-lg md:p-10">
                {(sb.kind === 'concept' || sb.kind === 'remedial' || sb.kind === 'summary') && (
                  <>
                    {sb.kind === 'remedial' && (
                      <div className="mb-3 inline-flex items-center gap-1.5 rounded-md border border-brand-amber/60 bg-brand-amber-tint px-2 py-1 font-mono text-[11px] font-medium text-ochre">
                        <Scale size={12} /> ARB-05 决策：降维换讲法
                      </div>
                    )}
                    <h2 className="font-serif text-[26px] font-bold leading-[36px] text-ink md:text-[30px] md:leading-[42px]">
                      {'title' in sb && sb.title ? sb.title : '本讲小结'}
                    </h2>
                    <p className="mt-5 whitespace-pre-line text-[16.5px] leading-[32px] text-ink-2">{sb.text}</p>
                    {'kbRefs' in sb && sb.kbRefs.length > 0 && (
                      <div className="mt-6 flex flex-wrap gap-2 border-t border-hairline pt-4">
                        {sb.kbRefs.map((id) => <TraceBadge key={id} kbId={id} />)}
                      </div>
                    )}
                  </>
                )}
                {sb.kind === 'stage' && (
                  <>
                    <h2 className="font-serif text-[24px] font-bold leading-[34px] text-ink">{sb.title}</h2>
                    <div className="mt-5 grid gap-3 sm:grid-cols-2">
                      {sb.items.map((item, ii) => (
                        <div key={ii} className={cn(item.type === 'figure' && 'sm:col-span-2')}>
                          <StageItemView item={item} visible current={false} />
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {sb.kind === 'demo' && (
                  <>
                    <h2 className="font-serif text-[22px] font-bold leading-[32px] text-ink">{sb.title}</h2>
                    <div className="mt-4">
                      {sb.demo === 'calibration' && <CalibrationSim tourStep={tourStepOf(sb, slideIdx)} />}
                      {sb.demo === 'frame' && <FrameDemo tourStage={tourStepOf(sb, slideIdx)} />}
                      {sb.demo === 'plc' && <PlcLadderDemo tourStep={tourStepOf(sb, slideIdx)} />}
                      {sb.demo === 'safety' && <SafetyLoopDemo tourStep={tourStepOf(sb, slideIdx)} />}
                      {sb.demo === 'vision' && <VisionGuideDemo tourStep={tourStepOf(sb, slideIdx)} />}
                      {sb.demo === 'fault' && <FaultTreeDemo tourStep={tourStepOf(sb, slideIdx)} />}
                    </div>
                  </>
                )}
                {sb.kind === 'checkpoint' && (
                  <>
                    <div className="mb-3 inline-flex items-center gap-1.5 rounded-md border border-brand/35 bg-brand-tint px-2 py-1 font-mono text-[11px] font-medium text-brand">
                      检查点 · 答对继续，答错我换讲法
                    </div>
                    <h2 className="font-serif text-[21px] font-semibold leading-[32px] text-ink">{sb.q.stem}</h2>
                    <div className="mt-5 space-y-2.5">
                      {sb.q.options.map((opt, oi) => {
                        const pickedIdx = cpPicks[sb.id];
                        const show = pickedIdx !== undefined;
                        const isAnswer = oi === sb.q.answerIndex;
                        const isPicked = pickedIdx === oi;
                        return (
                          <button
                            key={oi}
                            type="button"
                            disabled={show}
                            onClick={() => answerCheckpoint(sb, slideIdx, oi)}
                            className={cn(
                              'flex w-full items-center gap-3 rounded-[12px] border px-4 py-3 text-left text-[15px] transition-all',
                              !show && 'border-hairline bg-paper text-ink-2 hover:border-brand/40 hover:bg-brand-tint/40',
                              show && isAnswer && 'border-brand-success/60 bg-brand-success/10 text-ink',
                              show && isPicked && !isAnswer && 'border-brand-danger/60 bg-brand-danger/10 text-ink',
                              show && !isAnswer && !isPicked && 'border-hairline bg-paper text-ink-muted opacity-60',
                            )}
                          >
                            <span className="font-mono text-[13px] text-ink-muted">{letters[oi]}</span>
                            {opt}
                            {show && isAnswer && <Check size={15} className="ml-auto shrink-0 text-brand-success" />}
                            {show && isPicked && !isAnswer && <X size={15} className="ml-auto shrink-0 text-brand-danger" />}
                          </button>
                        );
                      })}
                    </div>
                    {cpPicks[sb.id] !== undefined && (
                      <p className="mt-4 rounded-[10px] bg-card-warm px-4 py-3 text-[13.5px] leading-[22px] text-ink-muted">{sb.q.analysis}</p>
                    )}
                  </>
                )}
              </div>
              <button type="button" onClick={() => slideGo(1)} disabled={slideIdx >= blocks.length - 1} title="下一页"
                className="hidden shrink-0 items-center rounded-[12px] px-2 text-ink-muted transition-colors hover:text-brand disabled:opacity-25 sm:flex">
                <ChevronRight size={26} />
              </button>
            </div>
          </div>
        );
      })()}

      <div className="fixed inset-x-0 bottom-16 z-40 md:bottom-0">
        <div className="mx-auto max-w-[860px] px-5 pb-3 md:px-6">
          {/* 字幕（通勤模式下已在上方大字显示，这里不再重复） */}
          <AnimatePresence>
            {subtitle && !audioMode && (
              <motion.div
                key={subtitle}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="mb-2 rounded-[12px] border border-hairline bg-ink/90 px-4 py-2.5 text-center text-[14px] font-medium leading-[22px] text-paper backdrop-blur"
              >
                {subtitle}
              </motion.div>
            )}
          </AnimatePresence>

          <div className="lf-glass flex items-center gap-3 rounded-[16px] px-4 py-3">
            <button
              type="button"
              onClick={togglePlay}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-paper transition-transform hover:scale-105"
              title={playing ? '暂停' : '语音授课'}
            >
              {playing ? <Pause size={17} /> : <Play size={17} fill="currentColor" />}
            </button>

            {/* 说话脉冲 */}
            {playing && (
              <span className="flex items-end gap-[3px]" aria-hidden>
                {[0, 1, 2].map((k) => (
                  <span
                    key={k}
                    className="w-[3px] animate-breathe rounded-full bg-brand"
                    style={{ height: 14, animationDelay: `${k * 0.18}s` }}
                  />
                ))}
              </span>
            )}

            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-ink">
                {playing ? '正在讲播' : `${kp.name} · 交互课件`}
              </div>
              <div className="flex items-center gap-2 font-mono text-[10px] text-ink-muted">
                {tts.supported ? <Volume2 size={10} /> : <VolumeX size={10} />}
                {tts.supported ? '语音授课' : '默片模式（字幕+视觉照常）'}
              </div>
            </div>

            {/* 语速 */}
            <button
              type="button"
              onClick={() => setRateIdx((r) => (r + 1) % RATES.length)}
              className="shrink-0 rounded-md border border-hairline bg-paper px-2 py-1 font-mono text-[11px] text-ink-2 hover:border-brand/40"
              title="语速"
            >
              {RATES[rateIdx].toFixed(2).replace(/0$/, '')}×
            </button>

            {/* 进度条：一条可点击跳转的轨道（原来是 7 个小圆点） */}
            <div className="hidden min-w-[110px] flex-1 items-center gap-2 sm:flex">
              <div
                role="slider"
                tabIndex={0}
                aria-label="讲解进度"
                aria-valuemin={1}
                aria-valuemax={blocks.length}
                aria-valuenow={cursor + 1}
                title={`第 ${cursor + 1} / ${blocks.length} 段 · 点击跳转`}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  const i = Math.min(blocks.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * blocks.length)));
                  stopPlayback();
                  posRef.current = { b: i, c: 0 };
                  setCursor(i);
                  scrollToBlock(i);
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                  const i = Math.min(blocks.length - 1, Math.max(0, cursor + (e.key === 'ArrowRight' ? 1 : -1)));
                  stopPlayback();
                  posRef.current = { b: i, c: 0 };
                  setCursor(i);
                  scrollToBlock(i);
                }}
                className="group relative h-4 flex-1 cursor-pointer"
              >
                <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-hairline">
                  <div
                    className="h-full rounded-full bg-brand transition-all duration-300"
                    style={{ width: `${((cursor + 1) / blocks.length) * 100}%` }}
                  />
                </div>
                <span
                  className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-paper bg-brand shadow-warm transition-transform group-hover:scale-125"
                  style={{ left: `${((cursor + 1) / blocks.length) * 100}%` }}
                />
              </div>
              <span className="shrink-0 font-mono text-[10.5px] text-ink-muted tabular">
                {cursor + 1}/{blocks.length}
              </span>
            </div>

            {/* 记笔记：全页唯一入口，做成醒目主按钮，自动挂到你正在看的那一段 */}
            <button
              type="button"
              onClick={openNoteHere}
              title="记笔记（自动关联你正在看的那一段）"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-[10px] bg-brand px-3.5 py-2 text-[13px] font-semibold text-paper shadow-warm transition-all hover:bg-brand-hover hover:shadow-warm-lg"
            >
              <PenLine size={14} />
              记笔记
            </button>

            <button
              type="button"
              onClick={raiseHand}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-[10px] border border-brand-amber/50 bg-brand-amber-tint px-3 py-2 text-[13px] font-medium text-ochre transition-all hover:border-brand-amber"
            >
              <Hand size={14} />
              <span className="hidden sm:inline">举手提问</span>
            </button>

            {/* 幻灯模式：PPT 视图 */}
            {!focusMode && (
              <button
                type="button"
                onClick={() => (slideMode ? setSlideMode(false) : openSlides())}
                title="幻灯模式：一段一页放大讲，随语音翻页"
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-[10px] border px-3 py-2 text-[13px] font-medium transition-all',
                  slideMode
                    ? 'border-brand/45 bg-brand-tint text-brand'
                    : 'border-hairline bg-paper text-ink-2 hover:border-brand/40 hover:text-brand',
                )}
              >
                <Presentation size={14} />
                <span className="hidden sm:inline">幻灯</span>
              </button>
            )}

            {/* 专注模式 */}
            {/* 通勤模式：只听不看 */}
            {!focusMode && (
              <button
                type="button"
                onClick={() => { setSlideMode(false); setAudioMode((v) => !v); if (!playing) startPlay(posRef.current.b, posRef.current.c); }}
                title="只听不看（走路/坐车时用）"
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-[10px] border px-3 py-2 text-[13px] font-medium transition-all',
                  audioMode
                    ? 'border-brand/45 bg-brand-tint text-brand'
                    : 'border-hairline bg-paper text-ink-2 hover:border-brand/40 hover:text-brand',
                )}
              >
                <Headphones size={14} />
                <span className="hidden sm:inline">只听</span>
              </button>
            )}

            {focusMode ? (
              <>
                {/* 环境音：静音 → 细雨 → 林间 */}
                {ambient.supported && (
                  <button
                    type="button"
                    onClick={() => ambient.setKind(ambient.kind === 'off' ? 'rain' : ambient.kind === 'rain' ? 'forest' : 'off')}
                    title={`环境音：${ambient.kind === 'off' ? '关闭（点击开细雨）' : ambient.kind === 'rain' ? '细雨（点击换林间）' : '林间（点击关闭）'}`}
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1.5 rounded-[10px] border px-2.5 py-2 text-[12.5px] font-medium transition-all',
                      ambient.kind === 'off'
                        ? 'border-hairline bg-paper text-ink-muted hover:text-brand'
                        : 'border-brand/45 bg-brand-tint text-brand',
                    )}
                  >
                    {ambient.kind === 'off' ? <VolumeX size={14} /> : ambient.kind === 'rain' ? <CloudRain size={14} /> : <Trees size={14} />}
                    <span className="hidden lg:inline">
                      {ambient.kind === 'off' ? '环境音' : ambient.kind === 'rain' ? '细雨' : '林间'}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={exitFocus}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-[10px] bg-ink px-3 py-2 font-mono text-[12px] font-medium text-paper transition-all hover:bg-ink-2"
                  title="退出专注（Esc）"
                >
                  <Focus size={13} />
                  {Math.floor(elapsed / 60)}:{(elapsed % 60).toString().padStart(2, '0')}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={enterFocus}
                title="专注模式：全屏、收起干扰、结算能量加成"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-[10px] border border-hairline bg-paper px-3 py-2 text-[13px] font-medium text-ink-2 transition-all hover:border-brand/40 hover:text-brand"
              >
                <Focus size={14} />
                <span className="hidden sm:inline">专注</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ============ 专注结算卡 ============ */}
      <AnimatePresence>
        {settlement && (
          <motion.div
            key="focus-settlement"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm"
            onClick={() => setSettlement(null)}
          >
            <motion.div
              initial={{ scale: 0.92, y: 16 }}
              animate={{ scale: 1, y: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="w-[min(360px,90vw)] rounded-[18px] border border-hairline bg-paper p-6 text-center shadow-warm-lg"
            >
              {/* 花园叙事：这段专注让你的园子长高了一点 */}
              <div className="lf-bloom relative mx-auto h-[86px] w-[130px]">
                <Sprout className="absolute bottom-0 left-1/2 h-[80px] w-[80px] -translate-x-1/2" />
                <GrassTuft className="absolute bottom-0 left-0 h-[34px] w-[48px] opacity-70" />
                <GrassTuft className="absolute bottom-0 right-0 h-[30px] w-[42px] scale-x-[-1] opacity-55" />
              </div>
              <h3 className="mt-2 font-serif text-[18px] font-semibold text-ink">这段安静，让园子长高了一点</h3>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {[
                  ['时长', settlement.mins],
                  ['听完', `${settlement.blocks} 块`],
                  ['能量', `+${settlement.bonus}`],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-[10px] border border-hairline bg-card-warm py-2.5">
                    <div className="font-mono text-[15px] font-semibold text-brand">{v}</div>
                    <div className="mt-0.5 text-[10.5px] text-ink-muted">{k}</div>
                  </div>
                ))}
              </div>
              <p className="mt-3 flex items-center justify-center gap-1 text-[12px] text-ink-muted">
                <Droplets size={12} className="text-brand" />
                专注能量（×1.2 加成）已进能量球，可回「我的学习」浇树
              </p>
              <div className="mt-4 flex gap-2.5">
                <button type="button" onClick={() => setSettlement(null)} className="lf-btn-ghost flex-1 !py-2 text-[13.5px]">
                  继续本讲
                </button>
                <button type="button" onClick={() => navigate('/me')} className="lf-btn-primary flex-1 !py-2 text-[13.5px]">
                  去浇水 <Droplets size={14} />
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ============ 提问面板 ============ */}
      <AnimatePresence>
        {asking && (
          <motion.div
            key="ask-panel"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 24 }}
            className="fixed bottom-36 right-4 z-50 flex max-h-[min(480px,60dvh)] w-[min(380px,calc(100vw-32px))] flex-col overflow-hidden rounded-[16px] border border-hairline bg-paper shadow-warm-lg md:bottom-24 md:right-[max(16px,calc(50vw-430px))]"
          >
            <div className="flex items-center gap-2 border-b border-hairline bg-card-warm px-4 py-2.5">
              <Hand size={14} className="text-ochre" />
              <span className="text-[13.5px] font-semibold text-ink">课堂提问 · 已暂停授课</span>
              <button type="button" onClick={() => setAsking(false)} className="ml-auto text-ink-muted hover:text-ink">
                <X size={15} />
              </button>
            </div>
            <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
              {qaLog.length === 0 && (
                <p className="py-3 text-center text-[12px] text-ink-muted">问本讲相关的问题，比如"{qaBankHint(kpId)}"</p>
              )}
              {qaLog.map((qa, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="ml-auto w-fit max-w-[90%] rounded-[12px] rounded-br-[4px] bg-brand px-3 py-1.5 text-[12.5px] text-paper">{qa.q}</div>
                  <div className="w-fit max-w-[92%] rounded-[12px] rounded-tl-[4px] border border-hairline bg-card-warm px-3 py-2 text-[12.5px] leading-[19px] text-ink-2">
                    {qa.a}
                    {qa.kbRef && <span className="ml-1.5"><TraceBadge kbId={qa.kbRef} /></span>}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 border-t border-hairline bg-card-warm px-3 py-2.5">
              {srAvailable && (
                <button
                  type="button"
                  onClick={startListening}
                  title="语音提问"
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-all',
                    listening ? 'animate-pulse border-brand-danger bg-brand-danger text-paper' : 'border-hairline bg-paper text-ink-2 hover:border-brand/40',
                  )}
                >
                  <Mic size={15} />
                </button>
              )}
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitQuestion(); }}
                placeholder={listening ? '正在听…' : '输入问题，或点麦克风说'}
                className="h-9 min-w-0 flex-1 rounded-[10px] border border-hairline bg-paper px-3 text-[13px] text-ink outline-none focus:border-brand/50"
              />
              <button
                type="button"
                onClick={submitQuestion}
                disabled={!question.trim()}
                className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]', question.trim() ? 'bg-brand text-paper' : 'bg-paper-deep text-ink-muted/50')}
              >
                <Send size={14} />
              </button>
            </div>
            <button
              type="button"
              onClick={() => { setAsking(false); startPlay(posRef.current.b, posRef.current.c); }}
              className="border-t border-hairline bg-brand-tint/60 py-2 text-[12.5px] font-medium text-brand transition-colors hover:bg-brand-tint"
            >
              ▶ 继续上课（从断点续播）
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** 提问面板占位示例问题 */
function qaBankHint(kpId: string): string {
  const hints: Record<string, string> = {
    'kp-plc': '常开和常闭有什么区别？',
    'kp-kinematics': '正解和逆解的区别？',
    'kp-sensor': '温度漂移怎么补偿？',
    'kp-vision': 'AX=XB 是怎么回事？',
    'kp-safety': '为什么示教限速 250mm/s？',
    'kp-diagnosis': '看到报警第一步做什么？',
  };
  return hints[kpId] ?? '这一讲的重点是什么？';
}
