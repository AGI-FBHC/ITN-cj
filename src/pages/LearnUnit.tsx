/**
 * LearnUnit `/learn/:kpId` — 交互课件播放器（视听双通道讲播）
 * - Cue 引擎：讲稿逐句朗读，每句触发视觉动作（演播元素点亮 / 溯源发光 / 演示导览步进）
 * - 演播块(stage)：黑板式教具（图示/要点/公式/大数字/溯源卡）随语音逐件出现
 * - 演示导览：语音讲第几步，模拟器/坐标演示自己演到第几步，讲完交还给学习者
 * - 字幕条 + 音效（对/错/换块）+ 语速切换 + 说话脉冲；无 TTS 自动降级"默片+字幕"
 * - 检查点答错 → ARB-05 插降维块；作答/完课回写阿诊信号
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Presentation,
  Brain,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  GraduationCap,
  ImagePlus,
  Camera,
  MessageSquare,
  MoreHorizontal,
  Maximize2,
  Minimize2,
  FileText,
  Loader2,
  Lightbulb,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { toast } from 'sonner';
import { useProfile, dataIdOf } from '@/context/ProfileContext';
import { bumpConfidence } from '@/data/confidence';
import { useAgent } from '@/context/AgentContext';
import { useNotes } from '@/context/NotesContext';
import { useGrowth } from '@/context/GrowthContext';
import { useReview } from '@/context/ReviewContext';
import { useWrongBook } from '@/context/WrongBookContext';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import { nextPathNodeAfter } from '@/data/reportData';
import { reportForLearner } from '@/data/reportBuilder';
import { resolveLearnTarget } from '@/data/resources';
import { loadProgress, saveProgress, clearProgress } from '@/data/learnProgress';
import { recordHarvest, speciesOf } from '@/data/garden';
import { buildUnit, remedialBlockOf, variantBlockOf, drawQuestions, matchQA, fallbackAnswer, cuesOf, qaBank, STYLE_LABELS } from '@/data/courseware';
import type { CourseBlock, PresetQA, StageItem, StyleLabel } from '@/data/courseware';
import { canStartChallenge, CHALLENGE_THRESHOLD, CHALLENGE_MAX_WRONG } from '@/agent/arbiter';
import TraceBadge from '@/components/TraceBadge';
import InlineTutor from '@/components/learn/InlineTutor';
import type { TutorMsg } from '@/components/learn/InlineTutor';
import CalibrationSim from '@/components/learn/CalibrationSim';
import FrameDemo from '@/components/learn/FrameDemo';
import PlcLadderDemo from '@/components/learn/PlcLadderDemo';
import SafetyLoopDemo from '@/components/learn/SafetyLoopDemo';
import VisionGuideDemo from '@/components/learn/VisionGuideDemo';
import FaultTreeDemo from '@/components/learn/FaultTreeDemo';
import PptPlayer from '@/components/learn/PptPlayer';
import type { PptPlayerRef } from '@/components/learn/PptPlayer';
import { startWavRecording } from '@/lib/voiceRecorder';
import { audioBus } from '@/lib/audioBus';
import type { WavRecorder } from '@/lib/voiceRecorder';
import { createPresentationChatSession, deletePresentationChatSession, getPresentationChatMessages, listPresentationChatSessions, draftPresentationNote, streamPresentationChatAudio, streamPresentationChatImage, streamPresentationChatText, streamPresentationChatTts } from '@/lib/presentationApi';
import type { PresentationAudioEvent, PresentationChatSession } from '@/lib/presentationApi';
import PathProgressBar from '@/components/learn/PathProgressBar';
import { GrassTuft, Sprout } from '@/components/heal/Flora';
import { useAmbient } from '@/components/heal/useAmbient';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { PersonalizedLearningUnit, TtsSpeed, UserProfileSettings } from '@/lib/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCitationMarks from '@/lib/remarkCitationMarks';
import { lectureMdComponents } from '@/components/resources/lecture-markdown';
import SourceCitationMarks from '@/components/resources/SourceCitationMarks';

const letters = ['A', 'B', 'C', 'D'];
const RATES = [0.75, 0.85, 1.05, 1.3, 1.5] as const;

/** 语音风格预设：音高 + 语速微调（浏览器 TTS 可控维度内做出可感知差异） */
const VOICE_STYLES = [
  { key: 'steady', label: '沉稳讲解', desc: '低音沉着 · 系统学习', pitch: 0.85, rateScale: 0.95 },
  { key: 'standard', label: '标准播报', desc: '默认音色 · 均衡', pitch: 1, rateScale: 1 },
  { key: 'lively', label: '亲切活泼', desc: '音调明快 · 提神醒脑', pitch: 1.2, rateScale: 1.08 },
] as const;
const MIMO_VOICES = ['冰糖', '茉莉', '苏打', '白桦'] as const;
const QWEN_VOICES = [
  { value: 'longanlingxi', label: '龙安灵希' },
  { value: 'longanxiaoxin', label: '龙安小昕' },
] as const;
const MIMO_SPEEDS: Array<{ value: TtsSpeed; label: string }> = [
  { value: 'very_slow', label: '超慢' },
  { value: 'slow', label: '慢' },
  { value: 'normal', label: '正常' },
  { value: 'fast', label: '快' },
  { value: 'very_fast', label: '极速' },
];

/* ---------- TTS（带看门狗：utterance 卡死/静音环境下超时强制推进，保证讲播永不挂起） ---------- */
const stripControlMarkers = (text: string) => text.replace(/\[\[[^\]]*\]\]/g, '').trim();

function useTts() {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const speak = (text: string, rate: number, onEnd: () => void, pitch = 1) => {
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
    u.pitch = pitch;
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
      <svg viewBox="0 0 260 96" className="max-h-[30vh] w-full max-w-[440px]">
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
    <svg viewBox="0 0 260 76" className="max-h-[30vh] w-full max-w-[440px]">
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
        'rounded-[10px] border px-3 py-2.5 transition-all duration-500 ease-lf',
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
  const [open, setOpen] = useState(false);
  const hitCount = SPOT_DEFS.filter((d) => flags[d.key]).length;
  /* 悬浮球形态：不再常驻侧栏——收起时只是右下角一枚计数球，点开才展开清单。
     bottom-44：给下方的阿诊 FAB（bottom-6）和演示导览 FAB（md:bottom-24）让位，右下角三层不打架 */
  return (
    <div className="fixed bottom-44 right-5 z-30 hidden w-[240px] lg:block">
      <div className={cn(!open && 'flex justify-end')}>
      <div className={cn(open ? 'rounded-[14px] border border-hairline bg-paper/95 shadow-warm-lg backdrop-blur' : 'inline-block')}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title="技术亮点 · 边用边看（实时点亮已演示的机制）"
          className={cn(
            'flex items-center gap-2 text-left',
            open
              ? 'w-full px-3.5 py-2.5'
              : 'rounded-full border border-hairline bg-paper/95 px-3 py-2 shadow-warm backdrop-blur transition-all hover:border-brand/40',
          )}
        >
          <Sparkles size={13} className="text-brand" />
          {open && <span className="text-[12.5px] font-semibold text-ink">技术亮点 · 边用边看</span>}
          <span className={cn('rounded-md bg-brand-tint px-1.5 py-0.5 font-mono text-[10px] font-semibold text-brand', open && 'ml-auto')}>
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

/* ---------- 开讲适配横幅（可交互）：检测 → 定制 → 核验，三张卡都点得开 ----------
 * 点「检测」看缺口从哪来；点「定制」当场换讲法（GEN-03 现场重拼）；点「核验」看溯源覆盖 */
function AdaptiveBanner({
  kpName,
  score,
  target,
  isWeakest,
  difficulty,
  styleLabel,
  expert,
  kbCount,
  onPickStyle,
}: {
  kpName: string;
  score: number;
  target: number;
  isWeakest: boolean;
  difficulty: string;
  styleLabel: StyleLabel;
  expert: boolean;
  /** 本讲挂了多少处 KB 溯源角标 */
  kbCount: number;
  /** 当场切换讲法（GEN-03 重新拼装本讲） */
  onPickStyle: (s: StyleLabel) => void;
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
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
          <motion.button
            key={s.label}
            type="button"
            onClick={() => setOpenIdx((v) => (v === i ? null : i))}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 + i * 0.4, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              'flex items-start gap-2 rounded-[10px] border p-2.5 text-left transition-all',
              openIdx === i ? 'border-brand/45 bg-paper shadow-warm' : 'border-hairline/70 bg-paper/70 hover:border-brand/30',
            )}
            title={i === 0 ? '点开看：缺口从哪来' : i === 1 ? '点开换讲法：本讲当场重拼' : '点开看：溯源覆盖情况'}
          >
            <span
              className={cn(
                'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                s.tone === 'amber' ? 'bg-brand-amber-tint text-ochre' : 'bg-brand-tint text-brand',
              )}
            >
              <s.icon size={12} />
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn('block font-mono text-[10px] font-semibold', s.tone === 'amber' ? 'text-ochre' : 'text-brand')}>
                {s.label}
              </span>
              <span className="mt-0.5 block text-[12px] leading-[18px] text-ink-2">{s.text}</span>
            </span>
            <ChevronDown
              size={12}
              className={cn('mt-1 shrink-0 text-ink-muted transition-transform', openIdx === i && 'rotate-180')}
            />
          </motion.button>
        ))}
      </div>

      {/* 展开详情：不再只是"陈述给你看"，而是能看证据、能动手改 */}
      <AnimatePresence>
        {openIdx !== null && (
          <motion.div
            key={openIdx}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-2 rounded-[10px] border border-hairline/70 bg-paper p-3">
              {openIdx === 0 && (
                <div className="space-y-1.5 text-[12.5px] leading-[19px] text-ink-2">
                  <div className="font-mono text-[10px] font-semibold text-ink-muted">缺口 {gap} 分是这样算出来的</div>
                  <div>· 画像基线：入学测评 + 历次答题回写 → 「{kpName}」当前 <span className="font-semibold text-ink">{score} 分</span></div>
                  <div>· 岗位目标线：<span className="font-semibold text-ink">{target} 分</span>{isWeakest && '（这是你六维雷达的最弱项）'}</div>
                  <div>· 本讲对策：检查点按"讲一段练一题"加密，答错就地补讲——右侧掌握度条实时看涨跌</div>
                </div>
              )}
              {openIdx === 1 && (
                <div>
                  <div className="font-mono text-[10px] font-semibold text-ink-muted">
                    讲法不合口味？点一个当场重拼（难度保持「{difficulty}」）
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {STYLE_LABELS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => onPickStyle(s)}
                        disabled={s === styleLabel}
                        className={cn(
                          'rounded-[9px] border px-2.5 py-1.5 text-[12px] font-medium transition-all',
                          s === styleLabel
                            ? 'border-brand bg-brand text-paper'
                            : 'border-hairline bg-paper text-ink-2 hover:border-brand/45 hover:text-brand',
                        )}
                      >
                        {s}
                        {s === styleLabel && ' · 当前'}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {openIdx === 2 && (
                <div className="text-[12.5px] leading-[19px] text-ink-2">
                  <div className="font-mono text-[10px] font-semibold text-ink-muted">零幻觉核验</div>
                  <div className="mt-1">
                    本讲共 <span className="font-semibold text-brand">{kbCount}</span> 处论断挂了 KB 溯源角标——正文里的{' '}
                    <span className="font-mono text-brand">[KB-xxx]</span> 点开可看原文出处；语音讲到引用句时角标会发光。
                    没有出处的内容，生成阶段就发不出来。
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function LearnUnit() {
  const { kpId = 'kp-sensor' } = useParams();
  const navigate = useNavigate();
  const { currentLearner, viewMode, weakestKp } = useProfile();
  const { pushSignal } = useAgent();
  const { markStudied, markDoubt } = useReview();
  const { addWrong } = useWrongBook();
  const kp = getKnowledgePoint(kpId);
  const dataId = dataIdOf(currentLearner);
  const nextNode = nextPathNodeAfter(reportForLearner(currentLearner), kpId);
  const [searchParams] = useSearchParams();
  /* `topic` 是 PPT 子章节标题；`unitTopic` 才是知识地图小圆的后台 topic id。 */
  const topicId = searchParams.get('unitTopic');
  const [generatedUnit, setGeneratedUnit] = useState<PersonalizedLearningUnit | null>(null);
  const [unitLoading, setUnitLoading] = useState(Boolean(topicId));
  const [unitError, setUnitError] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!topicId) {
      setGeneratedUnit(null);
      setUnitLoading(false);
      return;
    }
    setUnitLoading(true);
    setUnitError('');
    api.getPersonalizedLearningUnit(kpId, topicId, dataId)
      .then((result) => { if (!cancelled) setGeneratedUnit(result); })
      .catch((reason) => { if (!cancelled) setUnitError(reason instanceof Error ? reason.message : '个性化课件生成失败'); })
      .finally(() => { if (!cancelled) setUnitLoading(false); });
    return () => { cancelled = true; };
  }, [dataId, kpId, topicId]);

  /* 「换个角度再学一遍」：强制换风格重拼本讲（GEN-03 现场重新生成） */
  const [styleOverride, setStyleOverride] = useState<StyleLabel | null>(null);
  const unit = useMemo(() => generatedUnit ? {
    kpId: generatedUnit.kpId,
    difficulty: generatedUnit.difficulty,
    styleLabel: generatedUnit.styleLabel,
    blocks: generatedUnit.blocks as unknown as CourseBlock[],
  } : buildUnit(kpId, currentLearner, styleOverride ?? undefined), [generatedUnit, kpId, currentLearner, styleOverride]);
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
  const pptTaskId = searchParams.get('ppt');
  const pptTopic = searchParams.get('topic');
  const pptRef = useRef<PptPlayerRef>(null);
  const [pptSlide, setPptSlide] = useState({ current: 0, count: 0 });
  const [pptWideMode, setPptWideMode] = useState(true);
  const syncPptSlide = useCallback((current: number, count: number) => setPptSlide((previous) => (
    previous.current === current && previous.count === count ? previous : { current, count }
  )), []);
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    const target = searchParams.get('block');
    if (!target) return;
    const id = `${kpId}-${target}`;
    const idx = unit.blocks.findIndex((bb) => bb.id === id);
    if (idx < 0) return;
    /* 深链目标可能还没解锁（课堂推进模式）：按用户意图直接解锁到该块 */
    setUnlocked((u) => Math.max(u, idx + 1));
    const t = setTimeout(() => {
      blockRefs.current[idx]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  /** 播放条展开/收起：默认收起，仅由明确的播放/暂停等用户动作驱动，换页不改变 */
  const [barExpanded, setBarExpanded] = useState(false);
  const playingRef = useRef(false);
  const [cursor, setCursor] = useState(0);
  /** 当前正在讲的句子下标（块内"跟读流"用：语音讲到哪，文稿高亮到哪） */
  const [cueIdx, setCueIdx] = useState(0);
  const [subtitle, setSubtitle] = useState<string | null>(null);
  const [kbGlow, setKbGlow] = useState(false);
  const [rateIdx, setRateIdx] = useState(2);
  const [voiceIdx, setVoiceIdx] = useState(1);
  const [pptVoice, setPptVoice] = useState('苏打');
  const [pptSpeed, setPptSpeed] = useState<TtsSpeed>('normal');
  const [pptVoiceSaving, setPptVoiceSaving] = useState(false);
  const [pptVolume, setPptVolume] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem('lf.pptVolume'));
      return Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved : 1;
    } catch {
      return 1;
    }
  });
  const [voiceRestart, setVoiceRestart] = useState<'answer' | 'slide' | null>(null);
  const voiceStyle = VOICE_STYLES[voiceIdx];
  /** 实际朗读速率 = 档位语速 × 风格微调 */
  const speechRate = RATES[rateIdx] * voiceStyle.rateScale;
  /** 每块已点亮的演播元素 */
  const [reveals, setReveals] = useState<Record<string, number[]>>({});
  const cancelRef = useRef<(() => void) | null>(null);
  const posRef = useRef<{ b: number; c: number }>({ b: 0, c: 0 });
  const blockRefs = useRef<Record<number, HTMLDivElement | null>>({});
  /** 跟读流里"正在讲的那句"的 DOM，长文稿时把它带进视野 */
  const cueRefs = useRef<Record<string, HTMLElement | null>>({});

  const [cpPicks, setCpPicks] = useState<Record<string, number>>({});
  /** 答对庆祝：叶子飘落挂在该检查点块上 */
  const [leafFallFor, setLeafFallFor] = useState<string | null>(null);
  /* 记笔记：正在编辑的块 + 草稿 */
  const { addNote, notes } = useNotes();
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [pptNoteOpen, setPptNoteOpen] = useState(false);
  const [pptNoteTitle, setPptNoteTitle] = useState('');
  const [pptNoteLoading, setPptNoteLoading] = useState(false);
  const [pptNoteMode, setPptNoteMode] = useState<'source' | 'preview' | 'pages'>('source');
  const pptNoteDraftsRef = useRef(new Map<number, Promise<{ title: string; content: string }>>());

  const preparePptNoteDraft = (slideIndex: number) => {
    if (!pptTaskId) return null;
    const cached = pptNoteDraftsRef.current.get(slideIndex);
    if (cached) return cached;
    const pending = draftPresentationNote(pptTaskId, slideIndex, '请根据当前幻灯片和演讲稿整理学习笔记，突出核心概念、关键结论和实践提醒。')
      .then(({ title, content }) => ({ title, content }));
    pptNoteDraftsRef.current.set(slideIndex, pending);
    pending.catch(() => pptNoteDraftsRef.current.delete(slideIndex));
    return pending;
  };

  /**
   * 播放条全局记笔记 —— 现在是唯一入口，所以必须挂到「用户正在看的那一段」。
   * 取视口中心最近的块（而非播放光标所在块：不播放时两者常常不是同一段，
   * 那样会把笔记记到用户没在看的内容上）。
   */
  const openNoteHere = () => {
    if (pptTaskId) {
      setPptNoteOpen(true);
      setPptNoteLoading(false);
      setPptNoteTitle(`第 ${pptSlide.current + 1} 页笔记`);
      setNoteText('');
      void preparePptNoteDraft(pptSlide.current);
      return;
    }
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
    /* 目标块若已折叠成摘要行（课堂推进模式），先展开回看再挂笔记编辑器 */
    setReviewOpen((prev) => ({ ...prev, [bl[i].id]: true }));
    scrollToBlock(i);
  };
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  /** 提问附图：车间里真实的问法是"我们这台报这个警（拍张照）怎么回事" */
  const [askPhoto, setAskPhoto] = useState<{ name: string; url: string } | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const askInputRef = useRef<HTMLInputElement>(null);
  interface QaEntry {
    q: string;
    a: string;
    kbRef?: string;
    photo?: string;
    voice?: boolean;
    transcript?: string;
    duration?: number;
    converting?: boolean;
    audioUrl?: string;
    id?: string;
  }
  const [qaLog, setQaLog] = useState<QaEntry[]>([]);
  const [pptAudioModel, setPptAudioModel] = useState<'mimo' | 'qwen'>('mimo');
  const [qwenVoice, setQwenVoice] = useState<(typeof QWEN_VOICES)[number]['value']>('longanxiaoxin');
  const [pptChatSessions, setPptChatSessions] = useState<PresentationChatSession[]>([]);
  const qaScrollRef = useRef<HTMLDivElement>(null);
  const pptChatSessionRefs = useRef<Record<'mimo' | 'qwen', string>>({ mimo: '', qwen: '' });
  const pptAskAbortRef = useRef<AbortController | null>(null);
  const pptWasPlayingRef = useRef(false);
  const answerAudioRef = useRef<{ context: AudioContext; sources: Set<AudioBufferSourceNode>; gain?: GainNode } | null>(null);
  /** 语音输入目标：ask=提问（说完自动发送）/ note=笔记（转写填入待编辑） */
  const [listening, setListening] = useState<null | 'ask' | 'note'>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceTranscriptOpen, setVoiceTranscriptOpen] = useState<Record<string, boolean>>({});
  /** 实时转写预览：说到哪看到哪，用户才敢让它自动发 */
  const [interim, setInterim] = useState('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recRef = useRef<any>(null);
  const voiceBusyRef = useRef(false);
  const voiceSeqRef = useRef(0);
  const pptVoiceRef = useRef<WavRecorder | null>(null);
  const voiceAudioUrlsRef = useRef(new Set<string>());
  const userAudioRef = useRef<HTMLAudioElement | null>(null);

  const stopAnswerAudio = () => {
    const active = answerAudioRef.current;
    answerAudioRef.current = null;
    active?.sources.forEach((source) => { try { source.stop(); } catch { /* already stopped */ } });
    void active?.context.close();
  };
  const stopAnswerAudioRef = useRef<() => void>(() => {});
  stopAnswerAudioRef.current = stopAnswerAudio;
  useEffect(() => audioBus.register('agent', () => stopAnswerAudioRef.current()), []);

  const changePptVolume = (value: number) => {
    const next = Math.min(1, Math.max(0, value));
    setPptVolume(next);
    try { window.localStorage.setItem('lf.pptVolume', String(next)); } catch { /* ignore */ }
    const active = answerAudioRef.current;
    if (active?.gain) active.gain.gain.value = next;
  };

  const restorePptChatSession = async (sessionId: string) => {
    if (!pptTaskId || !sessionId) { setQaLog([]); return; }
    const history = await getPresentationChatMessages(pptTaskId, sessionId);
    const restored: QaEntry[] = [];
    for (const item of history) {
      if (item.role === 'user') restored.push({ id: item.id, q: item.content, a: '', voice: item.inputType === 'voice', transcript: item.content });
      else if (restored.length) restored[restored.length - 1].a = item.content;
    }
    setQaLog(restored);
  };

  const ensurePptChatSession = async (model: 'mimo' | 'qwen' = pptAudioModel) => {
    if (!pptTaskId) return '';
    if (pptChatSessionRefs.current[model]) return pptChatSessionRefs.current[model];
    const sessions = await listPresentationChatSessions(pptTaskId);
    setPptChatSessions(sessions);
    const session = sessions.find((item) => item.modelProvider === model) ?? await createPresentationChatSession(pptTaskId, model);
    pptChatSessionRefs.current[model] = session.id;
    if (!sessions.some((item) => item.id === session.id)) setPptChatSessions((prev) => [session, ...prev]);
    return session.id;
  };

  const selectPptChatSession = async (sessionId: string) => {
    pptAskAbortRef.current?.abort();
    stopAnswerAudio();
    pptChatSessionRefs.current[pptAudioModel] = sessionId;
    await restorePptChatSession(sessionId);
  };

  const createFreshPptChatSession = async () => {
    if (!pptTaskId || voiceBusy) return;
    const session = await createPresentationChatSession(pptTaskId, pptAudioModel);
    pptChatSessionRefs.current[pptAudioModel] = session.id;
    setPptChatSessions((prev) => [session, ...prev]);
    setQaLog([]);
  };

  const removeCurrentPptChatSession = async () => {
    if (!pptTaskId || voiceBusy) return;
    const sessionId = pptChatSessionRefs.current[pptAudioModel];
    if (!sessionId) return;
    await deletePresentationChatSession(pptTaskId, sessionId);
    const remaining = pptChatSessions.filter((item) => item.id !== sessionId);
    setPptChatSessions(remaining);
    const next = remaining.find((item) => item.modelProvider === pptAudioModel);
    pptChatSessionRefs.current[pptAudioModel] = next?.id ?? '';
    if (next) await restorePptChatSession(next.id); else setQaLog([]);
  };

  const switchPptAudioModel = async (model: 'mimo' | 'qwen') => {
    if (model === pptAudioModel || voiceBusy) return;
    pptAskAbortRef.current?.abort();
    stopAnswerAudio();
    setPptAudioModel(model);
    setQaLog([]);
    try {
      const sessionId = await ensurePptChatSession(model);
      await restorePptChatSession(sessionId);
    } catch { /* session creation is retried on the first question */ }
  };

  const requestPptAnswerAudio = (text: string, signal?: AbortSignal) => {
    if (!pptTaskId || !text.trim()) return Promise.reject(new Error('没有可合成的回答'));
    return streamPresentationChatTts(pptTaskId, text, pptVoice, pptSpeed, signal);
  };

  const playPptAnswerResponse = async (responsePromise: Promise<Response>, signal?: AbortSignal) => {
    audioBus.stopAll();
    stopAnswerAudio();
    const response = await responsePromise;
    const context = new AudioContext({ sampleRate: 24_000 });
    await context.resume();
    const sources = new Set<AudioBufferSourceNode>();
    const gain = context.createGain();
    gain.gain.value = pptVolume;
    gain.connect(context.destination);
    answerAudioRef.current = { context, sources, gain };
    const reader = response.body!.getReader();
    let pending = new Uint8Array(0);
    let nextTime = context.currentTime + 0.08;
    const schedule = (pcm: Uint8Array) => {
      const usable = pcm.length - (pcm.length % 2);
      if (!usable || signal?.aborted) return;
      const samples = new Float32Array(usable / 2);
      const view = new DataView(pcm.buffer, pcm.byteOffset, usable);
      for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / 32768;
      const buffer = context.createBuffer(1, samples.length, 24_000);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      sources.add(source);
      source.onended = () => sources.delete(source);
      source.start(Math.max(context.currentTime + 0.02, nextTime));
      nextTime = Math.max(context.currentTime + 0.02, nextTime) + buffer.duration;
    };
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      const combined = new Uint8Array(pending.length + (value?.length ?? 0));
      combined.set(pending); if (value) combined.set(value, pending.length);
      let offset = 0;
      while (combined.length - offset >= 3840) { schedule(combined.slice(offset, offset + 3840)); offset += 3840; }
      pending = combined.slice(offset);
    }
    schedule(pending);
    const remainingMs = Math.max(0, (nextTime - context.currentTime) * 1000);
    if (remainingMs) await new Promise<void>((resolve) => window.setTimeout(resolve, remainingMs));
  };

  const speakPptAnswer = async (text: string, signal?: AbortSignal) => {
    await playPptAnswerResponse(requestPptAnswerAudio(text, signal), signal);
  };

  useEffect(() => {
    pptAskAbortRef.current?.abort();
    stopAnswerAudio();
    pptChatSessionRefs.current = { mimo: '', qwen: '' };
    setPptChatSessions([]);
    queueMicrotask(() => setQaLog([]));
    if (!pptTaskId) return;
    void ensurePptChatSession(pptAudioModel).then(restorePptChatSession).catch(() => { /* retried on first question */ });
    return () => {
      pptAskAbortRef.current?.abort();
      stopAnswerAudio();
      voiceAudioUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      voiceAudioUrlsRef.current.clear();
    };
    // Each model owns an independent conversation within the opened PPT task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pptTaskId]);

  useEffect(() => {
    if (!pptTaskId) return;
    void api.getUserProfile().then((profile) => {
      if (MIMO_VOICES.includes(profile.ttsVoice as typeof MIMO_VOICES[number])) setPptVoice(profile.ttsVoice);
      if (MIMO_SPEEDS.some((item) => item.value === profile.ttsSpeed)) setPptSpeed(profile.ttsSpeed);
    }).catch(() => undefined);
  }, [pptTaskId]);

  const savePptVoiceSetting = async (next: { voice?: string; speed?: TtsSpeed }) => {
    const voice = next.voice ?? pptVoice;
    const speed = next.speed ?? pptSpeed;
    setPptVoice(voice);
    setPptSpeed(speed);
    setPptVoiceSaving(true);
    try {
      let payload: Record<string, unknown>;
      try {
        const profile = await api.getUserProfile();
        payload = { ...profile, profileCompleted: profile.profileCompleted, ttsVoice: voice, ttsSpeed: speed };
        delete payload.userId;
        delete payload.currentGoalId;
        delete payload.createdAt;
        delete payload.updatedAt;
      } catch {
        // 画像尚未创建（老前端先 GET 再 PUT 的流程对未建档账号不适用）：用最小 payload 走 PUT upsert，由后端自动创建画像行。
        payload = { profileCompleted: false, ttsVoice: voice, ttsSpeed: speed };
      }
      await api.updateUserProfile(payload as UserProfileSettings);
      const answerActive = Boolean(answerAudioRef.current);
      const slideActive = Boolean(pptRef.current?.audioLoaded || playing);
      // 语速通过 playbackRate 实时生效，无需重读；只有音色切换才需要从当前页/当前回答重新合成。
      if (next.voice !== undefined && (answerActive || slideActive)) setVoiceRestart(answerActive ? 'answer' : 'slide');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '音色设置保存失败');
    } finally {
      setPptVoiceSaving(false);
    }
  };

  const restartVoicePlayback = () => {
    if (!voiceRestart) return;
    pptAskAbortRef.current?.abort();
    stopAnswerAudio();
    if (voiceRestart === 'answer') {
      const lastReply = [...qaLog].reverse().find((qa) => qa.a)?.a;
      if (lastReply) {
        const controller = new AbortController();
        pptAskAbortRef.current = controller;
        void speakPptAnswer(lastReply, controller.signal).catch(() => undefined);
      }
    } else {
      pptRef.current?.restartPageAudio();
    }
    setVoiceRestart(null);
  };

  useEffect(() => {
    qaScrollRef.current?.scrollTo({ top: qaScrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [qaLog, voiceBusy]);
  /** 笔记附图（纯演示：正文里留文本标记，不把 base64 塞进 localStorage） */
  const [noteImg, setNoteImg] = useState<{ name: string; url: string } | null>(null);
  const noteImgInputRef = useRef<HTMLInputElement>(null);
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

  /* ---- 本节掌握度（学练一体的实时反馈）：微练答对 +3 答错 −1，追问过关 +2 ---- */
  const [sessionDelta, setSessionDelta] = useState(0);
  /** 涨分飘字：反馈发生在动作发生的块上（blockId + 增量），1.4s 后自动消失 */
  const [masteryFloat, setMasteryFloat] = useState<{ blockId: string; delta: number; seq: number } | null>(null);
  const floatSeq = useRef(0);
  const floatMastery = (blockId: string, delta: number) => {
    setMasteryFloat({ blockId, delta, seq: floatSeq.current++ });
    setTimeout(() => setMasteryFloat((cur) => (cur?.blockId === blockId ? null : cur)), 1400);
  };

  /* ---- 本讲情报条（路线 + ADAPTIVE 收进一行，点开才展开）---- */
  const [briefOpen, setBriefOpen] = useState(false);

  /* ---- 课堂推进模式：讲到哪开到哪，不一次摊开整讲 ----
     unlocked = 已解锁块数：前面的块折叠成摘要行，当前块完整渲染，后面的块不渲染。
     推进触发：签到 / 答完微练 / 点「下一段」/ 讲播播到。freeBrowse = 自由浏览（复习用，全展开）。 */
  const [freeBrowse, setFreeBrowse] = useState(false);
  const [unlocked, setUnlocked] = useState(1);
  /** 已完成块的手动回看展开 */
  const [reviewOpen, setReviewOpen] = useState<Record<string, boolean>>({});
  /** 换讲法/换人重拼后回到第一段（续学恢复由下方 effect 负责，restoringRef 防止被这里清掉） */
  const restoringRef = useRef(false);
  useEffect(() => {
    if (restoringRef.current) { restoringRef.current = false; return; }
    setUnlocked(1);
    setReviewOpen({});
  }, [unit]);
  const advanceTo = (next: number) => {
    setUnlocked((u) => Math.max(u, next + 1));
    /* 同步播放光标：否则手动推进后，分段进度条高亮停在旧段、专注聚光灯调暗当前块、
       此时点播放会从旧块开始讲（定位类 bug，与"块顶对齐"同族） */
    if (!playingRef.current) {
      posRef.current = { b: next, c: 0 };
      setCursor(next);
    }
    setTimeout(() => scrollToBlock(next), 250);
  };

  /* ---- 块内追问「跟老师过一遍」：把独立练页的苏格拉底对话，降级成课件现场的 2~3 轮追问 ---- */
  const [tutorFor, setTutorFor] = useState<{ blockId: string; topic: string } | null>(null);
  const [tutorMsgs, setTutorMsgs] = useState<TutorMsg[]>([]);
  const [tutorStep, setTutorStep] = useState<'ask' | 'done'>('ask');
  const tutorQaRef = useRef<PresetQA | null>(null);
  const tutorSeqRef = useRef(0);

  const nextTutorQa = (): PresetQA | null => {
    const pool = qaBank[kpId] ?? [];
    if (pool.length === 0) return null;
    return pool[tutorSeqRef.current++ % pool.length];
  };

  const openTutor = (b: CourseBlock) => {
    stopPlayback();
    hitSpot('agency');
    const qa = nextTutorQa();
    tutorQaRef.current = qa;
    const topic = 'title' in b && b.title ? b.title : kp.name;
    setTutorFor({ blockId: b.id, topic });
    setTutorMsgs([
      {
        role: 'tutor',
        text: qa
          ? `我们把这段就地过一遍，不用跳页。先考考你：${qa.q}`
          : `我们把这段就地过一遍：用一句话说说，「${topic}」的关键是什么？`,
      },
    ]);
    setTutorStep('ask');
  };

  const tutorAnswer = (text: string) => {
    const qa = tutorQaRef.current;
    setTutorMsgs((prev) => [...prev, { role: 'me', text }]);
    const hit = qa ? qa.keywords.some((k) => text.toLowerCase().includes(k.toLowerCase())) : false;
    const reply = qa
      ? hit
        ? `说到点子上了！完整版是：${qa.a}`
        : `接近了，我补全一下：${qa.a}`
      : '嗯，思路对——再对照上面这段的小结自查一遍。';
    setTutorMsgs((prev) => [...prev, { role: 'tutor', text: reply, kbRef: qa?.kbRef }]);
    setTutorStep('done');
    setSessionDelta((v) => v + (hit ? 2 : 1));
    if (tutorFor) floatMastery(tutorFor.blockId, hit ? 2 : 1);
    if (hit) pushSignal({ type: 'self-report', kpId, feel: 'ok' });
  };

  const tutorReveal = () => {
    const qa = tutorQaRef.current;
    setTutorMsgs((prev) => [
      ...prev,
      { role: 'me', text: '不太会，直接讲吧' },
      { role: 'tutor', text: qa ? `没关系，直接讲：${qa.a}` : '没关系——回头把这段正文再读一遍，重点看小结。', kbRef: qa?.kbRef },
    ]);
    setTutorStep('done');
    pushSignal({ type: 'self-report', kpId, feel: 'unsure' });
  };

  const tutorMore = () => {
    const qa = nextTutorQa();
    tutorQaRef.current = qa;
    setTutorMsgs((prev) => [
      ...prev,
      { role: 'tutor', text: qa ? `再来一轮：${qa.q}` : '这一节的追问题被你问完了——去讲末「再练 3 题」上强度。' },
    ]);
    setTutorStep(qa ? 'ask' : 'done');
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

  const exitFocus = () => {
    if (!playing) setBarExpanded(false);
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

  /* 定位限定：块顶对齐（配合块上的 scroll-mt 给导航留位）。
     居中对齐对高块（演播块 ~800px）意味着头尾都在屏幕外，学习者永远从"半截"开始看。 */
  const scrollToBlock = (i: number) =>
    blockRefs.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const stopPlayback = () => {
    setBarExpanded(false);
    if (pptTaskId && pptRef.current?.audioPlaying) pptRef.current.togglePlay();
    cancelRef.current?.();
    tts.stop();
    playingRef.current = false;
    setPlaying(false);
    setKbGlow(false);
    /* 暂停即清残留字幕——否则胶囊播放条因"有字幕"一直缩不回去 */
    setSubtitle(null);
  };

  const finish = () => {
    setFinished(true);
    /* 完课信号只发一次（重学/微测再次播到尾不重复回写） */
    if (finishedSignalRef.current) return;
    finishedSignalRef.current = true;
    pushSignal({ type: 'lecture-read', kpId, title: `${kp.name} · 交互课件（${unit.difficulty}版）`, value: 100 });
    /* 遗忘曲线：这一株刚浇过水，重置保持率并 +1 次复习 */
    markStudied(kpId);
    /* 学完即结课：断点清除，下次进来是新的一讲 */
    clearProgress(currentLearner.id, kpId);
    /* 园子：这一讲的分数过了目标线 → 记一次收获，陈列进「我的成长」的温室 */
    const finalScore = Math.min(99, Math.max(0, (currentLearner.scores[kpId] ?? 50) + sessionDelta));
    const rec = recordHarvest(currentLearner.id, kpId, finalScore, kp.targetLevel);
    if (rec) {
      const sp = speciesOf(kpId);
      toast.success(rec.stage === 'fruit' ? `${sp.name}结果了！` : `${sp.name}开花了！`, {
        description: `「${kp.name}」到 ${finalScore} 分 · 已收进「我的成长」的温室`,
      });
    }
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
    setCueIdx(c);   // 块内跟读流要知道"正在讲第几句"
    /* 讲播推进 = 课堂推进：播到哪块解锁哪块（块刚解锁时 ref 尚未挂载，延迟滚动） */
    setUnlocked((u) => Math.max(u, b + 1));
    if (c === 0) setTimeout(() => scrollToBlock(b), 180);
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
    audioBus.stopAll();
    cancelRef.current = tts.speak(cue.say, speechRate, () => {
      if (playingRef.current) playCue(b, c + 1);
    }, voiceStyle.pitch);
  };

  const cpPicksRef = useRef(cpPicks);
  cpPicksRef.current = cpPicks;

  const startPlay = (b: number, c: number) => {
    setBarExpanded(true);
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
    if (pptTaskId) {
      const willPause = Boolean(pptRef.current?.audioPlaying);
      pptRef.current?.togglePlay();
      setBarExpanded(!willPause);
      return;
    }
    if (playing) stopPlayback();
    else startPlay(posRef.current.b, posRef.current.c);
  };

  useEffect(() => () => { cancelRef.current?.(); tts.stop(); userAudioRef.current?.pause(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- 检查点 ---- */
  const answerCheckpoint = (b: Extract<CourseBlock, { kind: 'checkpoint' }>, idx: number, optIndex: number) => {
    if (cpPicks[b.id] !== undefined) return;
    const correct = optIndex === b.q.answerIndex;
    setCpPicks((prev) => ({ ...prev, [b.id]: optIndex }));
    /* 掌握度实时涨跌：练是涨分最快的路；飘字落在答题的块上 */
    setSessionDelta((v) => v + (correct ? 3 : -1));
    floatMastery(b.id, correct ? 3 : -1);
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
    pushSignal({ type: 'quiz-answer', kpId: b.q.kpId, level: b.q.level, correct, value: correct ? ({ basic: 40, advanced: 70, challenge: 100 } as Record<string, number>)[b.q.level] ?? 40 : 8 });
    /* 每答一题都是一次画像校准证据（精简建档的低置信画像靠这个涨） */
    bumpConfidence(currentLearner.id);
    /* 课堂推进：答完即解锁下一段（答错时下一段正是插入的补讲块） */
    setTimeout(() => advanceTo(idx + 1), correct ? 700 : 1900);
    /* 进阶挑战护栏：学习者越权上调时约定"两错接回"——ARB-05 兑现承诺 */
    if (challengeIdsRef.current.has(b.id) && !correct) {
      challengeWrongRef.current += 1;
      if (challengeWrongRef.current >= CHALLENGE_MAX_WRONG) {
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


  /** PPT 模式下「说」：WAV 录音 -> MiMo audio-stream -> 转写+回答，说完自动发送 */
  const startPptVoiceAsk = async () => {
    if (pptVoiceRef.current) {
      await pptVoiceRef.current.cancel().catch(() => { /* ignore */ });
      pptVoiceRef.current = null;
      setListening(null);
      return;
    }
    setAsking(true);
    pptWasPlayingRef.current = Boolean(pptRef.current?.audioPlaying);
    audioBus.stopAll();
    stopPlayback();
    stopAnswerAudio();
    hitSpot('modal');
    setListening('ask');
    voiceBusyRef.current = true;
    setVoiceBusy(true);
    try {
      const recorder = await startWavRecording({
        silenceMs: 1050,
        maxDurationMs: 15000,
        onSilence: () => { if (pptVoiceRef.current) void finishPptVoiceAsk(); },
      });
      pptVoiceRef.current = recorder;
    } catch (reason) {
      setListening(null);
      voiceBusyRef.current = false;
      setVoiceBusy(false);
      toast(reason instanceof Error ? reason.message : '无法开始录音');
    }
  };

  const finishPptVoiceAsk = async () => {
    const recorder = pptVoiceRef.current;
    if (!recorder) return;
    pptVoiceRef.current = null;
    setListening(null);
    let audio: Blob;
    try {
      audio = await recorder.stop();
    } catch (reason) {
      voiceBusyRef.current = false;
      setVoiceBusy(false);
      toast(reason instanceof Error ? reason.message : '没有检测到有效语音');
      return;
    }
    const entryId = `voice-${voiceSeqRef.current++}`;
    const durationSec = Math.max(1, Math.round(audio.size / 32000));
    const audioUrl = URL.createObjectURL(audio);
    voiceAudioUrlsRef.current.add(audioUrl);
    setQaLog((prev) => [...prev, {
      id: entryId, q: '', a: '', voice: true, transcript: '', duration: durationSec, converting: true, audioUrl,
    }]);
    let transcript = '';
    let reply = '';
    let streamError = '';
    let finalAction: NonNullable<PresentationAudioEvent['action']> | string = 'none';
    let finalPage: number | null = null;
    let finalResume = false;
    let spokenLength = 0;
    let speechChain = Promise.resolve();
    let qwenNextAudioTime = 0;
    const playQwenAudioDelta = (encoded: string, sampleRate = 24000) => {
      let active = answerAudioRef.current;
      if (!active) {
        audioBus.stopAll();
        const context = new AudioContext({ sampleRate });
        const gain = context.createGain();
        const sources = new Set<AudioBufferSourceNode>();
        gain.gain.value = pptVolume;
        gain.connect(context.destination);
        active = { context, sources, gain };
        answerAudioRef.current = active;
        qwenNextAudioTime = context.currentTime + 0.06;
        void context.resume();
      }
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const usable = bytes.length - (bytes.length % 2);
      if (!usable) return;
      const samples = new Float32Array(usable / 2);
      const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
      for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / 32768;
      const buffer = active.context.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = active.context.createBufferSource();
      source.buffer = buffer;
      const gain = active.gain;
      if (!gain) return;
      source.connect(gain);
      active.sources.add(source);
      source.onended = () => active?.sources.delete(source);
      source.start(Math.max(active.context.currentTime + 0.015, qwenNextAudioTime));
      qwenNextAudioTime = Math.max(active.context.currentTime + 0.015, qwenNextAudioTime) + buffer.duration;
    };
    const queueSentenceAudio = (sentence: string) => {
      // Start synthesis immediately. Playback remains ordered, so later sentences
      // are usually ready by the time the previous sentence finishes.
      const prepared = requestPptAnswerAudio(sentence, controller.signal);
      void prepared.catch(() => undefined);
      speechChain = speechChain.then(() => playPptAnswerResponse(prepared, controller.signal));
    };
    const queueReadySentences = (flush = false) => {
      const pending = reply.slice(spokenLength);
      if (!pending.trim()) return;
      let consumed = 0;
      const punctuation = /[，,：:。！？!?；;]/g;
      for (const match of pending.matchAll(punctuation)) {
        const end = (match.index ?? 0) + match[0].length;
        const sentence = pending.slice(consumed, end).trim();
        const isStrongBoundary = /[。！？!?；;]$/.test(sentence);
        // Commas/colons lower time-to-first-speech, but very short fragments are
        // retained until the next boundary so prosody does not become choppy.
        if (sentence.length >= 6 || isStrongBoundary) {
          queueSentenceAudio(sentence);
          consumed = end;
        }
      }
      if (flush) {
        const tail = pending.slice(consumed).trim();
        if (tail) {
          consumed = pending.length;
          queueSentenceAudio(tail);
        }
      }
      spokenLength += consumed;
    };
    const controller = new AbortController();
    pptAskAbortRef.current?.abort();
    pptAskAbortRef.current = controller;
    try {
      await streamPresentationChatAudio(
        pptTaskId ?? '',
        audio,
        pptRef.current?.current ?? 0,
        pptChatSessionRefs.current[pptAudioModel],
        pptAudioModel,
        qwenVoice,
        (event) => {
          if (event.type === 'phase') {
            setQaLog((prev) => prev.map((qa) => qa.id === entryId ? { ...qa, converting: true } : qa));
          } else if (event.type === 'transcript' && event.transcript) {
            transcript = event.transcript;
            setVoiceTranscriptOpen((prev) => ({ ...prev, [entryId]: true }));
            setQaLog((prev) => prev.map((qa) => qa.id === entryId ? { ...qa, transcript, q: transcript, converting: false } : qa));
          } else if (event.type === 'control' && event.action && event.action !== 'none') {
            if (pptAudioModel === 'qwen') stopAnswerAudio();
            if (event.action === 'next') pptRef.current?.goNext();
            else if (event.action === 'previous') pptRef.current?.goPrev();
            else if (event.action === 'goto' && event.page) pptRef.current?.goTo(event.page - 1);
            else if (event.action === 'play' || event.action === 'restart') { setBarExpanded(true); pptRef.current?.play(); }
            else if (event.action === 'pause') pptRef.current?.pause();
          } else if (event.type === 'reply_delta' && event.content) {
            reply += event.content;
            setQaLog((prev) => prev.map((qa) => qa.id === entryId ? { ...qa, a: reply } : qa));
            if (pptAudioModel === 'mimo') queueReadySentences();
          } else if (event.type === 'audio_delta' && event.audio) {
            playQwenAudioDelta(event.audio, event.sampleRate);
          } else if (event.type === 'result') {
            transcript = event.transcript || transcript;
            if (event.content) reply = event.content;
            finalAction = event.action ?? 'none';
            finalPage = event.page ?? null;
            finalResume = Boolean(event.resume);
            if (event.sessionId) {
              pptChatSessionRefs.current[pptAudioModel] = event.sessionId;
              void listPresentationChatSessions(pptTaskId ?? '').then(setPptChatSessions).catch(() => undefined);
            }
            setQaLog((prev) => prev.map((qa) => qa.id === entryId ? { ...qa, transcript, converting: false, q: transcript, a: reply } : qa));
          } else if (event.type === 'error') {
            streamError = event.message || '语音理解失败';
          }
        }, controller.signal,
      );
    } catch (reason) {
      streamError = reason instanceof Error ? reason.message : '语音理解失败';
    } finally {
      voiceBusyRef.current = false;
      setVoiceBusy(false);
    }
    if (!transcript) {
      setQaLog((prev) => prev.map((qa) => qa.id === entryId ? { ...qa, converting: false, transcript: '', q: streamError || '没有识别到有效语音' } : qa));
      toast(streamError || '没有识别到有效语音');
      return;
    }
    const finalReply = stripControlMarkers(reply) || '我听到了你的问题，但暂未返回可展示回答，请稍后重试。';
    setQaLog((prev) => prev.map((qa) => qa.id === entryId ? { ...qa, a: finalReply } : qa));
    setQuestion('');
    if (pptAudioModel === 'mimo') {
      queueReadySentences(true);
      await speechChain.catch(() => undefined);
    }
    if (finalAction === 'goto' && finalPage) pptRef.current?.goTo(finalPage - 1);
    if (finalResume || (finalAction === 'none' && pptWasPlayingRef.current)) { setBarExpanded(true); pptRef.current?.play(); }
  };;

  const submitQuestion = async (override?: string) => {
    const q = (override ?? question).trim();
    if (!q && !askPhoto) return;
    if (pptTaskId && q && !askPhoto) {
      if (pptAudioModel === 'qwen') {
        toast('当前伴学方案仅支持语音提问；如需文字提问，请切换另一方案。');
        return;
      }
      const entryId = `text-${voiceSeqRef.current++}`;
      setQaLog((prev) => [...prev, { id: entryId, q, a: '正在结合当前幻灯片回答…' }]);
      setQuestion('');
      setVoiceBusy(true);
      pptWasPlayingRef.current = Boolean(pptRef.current?.audioPlaying);
      pptRef.current?.pause();
      stopAnswerAudio();
      let reply = '';
      let failed = '';
      const controller = new AbortController();
      pptAskAbortRef.current?.abort();
      pptAskAbortRef.current = controller;
      try {
        const sessionId = await ensurePptChatSession();
        const messages = [{ role: 'user' as const, content: q }];
        await streamPresentationChatText(pptTaskId, messages, pptRef.current?.current ?? 0, sessionId, (event) => {
          if (event.type === 'control' && event.action && event.action !== 'none') {
            if (event.action === 'next') pptRef.current?.goNext();
            else if (event.action === 'previous') pptRef.current?.goPrev();
            else if (event.action === 'goto' && event.page) pptRef.current?.goTo(event.page - 1);
            else if (event.action === 'play') { setBarExpanded(true); pptRef.current?.play(); }
            else if (event.action === 'pause') pptRef.current?.pause();
          } else if (event.type === 'chat_delta' && event.content) {
            reply += event.content;
            setQaLog((prev) => prev.map((qa) => qa.id === entryId ? { ...qa, a: reply } : qa));
          } else if (event.type === 'refused') {
            reply = event.banner || '这个问题暂时无法回答。';
            setQaLog((prev) => prev.map((qa) => qa.id === entryId ? { ...qa, a: reply } : qa));
          } else if (event.type === 'chat_failed') {
            failed = event.message || '回答生成失败，请稍后重试';
          }
        }, controller.signal);
      } catch (reason) {
        failed = reason instanceof Error ? reason.message : '回答生成失败，请稍后重试';
      } finally {
        setVoiceBusy(false);
      }
      if (failed && !reply) {
        setQaLog((prev) => prev.map((qa) => qa.id === entryId ? { ...qa, a: failed } : qa));
        toast.error(failed);
        return;
      }
      if (reply.trim()) {
        const cleanReply = stripControlMarkers(reply);
        setQaLog((prev) => prev.map((qa) => qa.id === entryId ? { ...qa, a: cleanReply } : qa));
        await speakPptAnswer(cleanReply, controller.signal).catch(() => undefined);
        if (pptWasPlayingRef.current) { setBarExpanded(true); pptRef.current?.play(); }
      }
      return;
    }
    if (pptTaskId && askPhoto) {
      const entryId = `photo-${voiceSeqRef.current++}`;
      setQaLog((prev) => [...prev, { id: entryId, q: q || '（看看这张图）', a: '正在结合图片与当前页回答…', photo: askPhoto.url }]);
      const photoUrl = askPhoto.url;
      setQuestion('');
      setAskPhoto(null);
      setVoiceBusy(true);
      pptWasPlayingRef.current = Boolean(pptRef.current?.audioPlaying);
      pptRef.current?.pause();
      stopAnswerAudio();
      let reply = '';
      let failed = '';
      const controller = new AbortController();
      pptAskAbortRef.current?.abort();
      pptAskAbortRef.current = controller;
      try {
        const sessionId = await ensurePptChatSession();
        const imageBlob = await (await fetch(photoUrl)).blob();
        await streamPresentationChatImage(pptTaskId, imageBlob, pptRef.current?.current ?? 0, q, sessionId, (event) => {
          if (event.type === 'control' && event.action && event.action !== 'none') {
            if (event.action === 'next') pptRef.current?.goNext();
            else if (event.action === 'previous') pptRef.current?.goPrev();
            else if (event.action === 'goto' && event.page) pptRef.current?.goTo(event.page - 1);
            else if (event.action === 'play') { setBarExpanded(true); pptRef.current?.play(); }
            else if (event.action === 'pause') pptRef.current?.pause();
          } else if (event.type === 'reply_delta' && event.content) {
            reply += event.content;
            setQaLog((prev) => prev.map((qa) => qa.id === entryId ? { ...qa, a: reply } : qa));
          } else if (event.type === 'result' && event.content) {
            reply = event.content;
            setQaLog((prev) => prev.map((qa) => qa.id === entryId ? { ...qa, a: reply } : qa));
          } else if (event.type === 'error') {
            failed = event.message || '图片问答失败，请稍后重试';
          }
        }, controller.signal);
      } catch (reason) {
        failed = reason instanceof Error ? reason.message : '图片问答失败，请稍后重试';
      } finally {
        setVoiceBusy(false);
      }
      if (failed && !reply) {
        setQaLog((prev) => prev.map((qa) => qa.id === entryId ? { ...qa, a: failed } : qa));
        toast.error(failed);
        return;
      }
      if (reply.trim()) {
        const cleanReply = stripControlMarkers(reply);
        setQaLog((prev) => prev.map((qa) => qa.id === entryId ? { ...qa, a: cleanReply } : qa));
        await speakPptAnswer(cleanReply, controller.signal).catch(() => undefined);
        if (pptWasPlayingRef.current) { setBarExpanded(true); pptRef.current?.play(); }
      }
      return;
    }
    const hit = q ? matchQA(kpId, q) : null;
    /* 带图但没匹配到预置 QA：按"看图答疑"给一句可信的兜底（真实版由多模态模型接管） */
    const a = hit
      ? hit.a
      : askPhoto
        ? `收到你的现场照片《${askPhoto.name}》。当前演示环境只做关键词答疑，看图诊断要接多模态模型；先按本讲的判据自查，也可以把报警号或读数打出来我再答。`
        : fallbackAnswer;
    setQaLog((prev) => [...prev, { q: q || '（看看这张图）', a, kbRef: hit?.kbRef, photo: askPhoto?.url }]);
    setQuestion('');
    setAskPhoto(null);
    audioBus.stopAll();
    tts.speak(a, speechRate, () => undefined, voiceStyle.pitch);
  };

  const pickPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setAskPhoto({ name: f.name, url: URL.createObjectURL(f) });
    e.target.value = '';
  };

  /** 停止/取消录音（听的过程中再点一次麦克风 = 撤回，不发送） */
  const playUserAudio = (url: string) => {
    audioBus.stopAll();
    const el = new Audio(url);
    userAudioRef.current?.pause();
    userAudioRef.current = el;
    const release = audioBus.register('user', () => { try { el.pause(); } catch { /* ignore */ } });
    el.onended = () => release();
    void el.play();
  };

  const stopListening = () => {
    if (pptVoiceRef.current) {
      void pptVoiceRef.current.cancel().catch(() => { /* ignore */ });
      pptVoiceRef.current = null;
    }
    try { recRef.current?.abort(); } catch { /* ignore */ }
    recRef.current = null;
    setVoiceBusy(false);
    setListening(null);
    setInterim('');
  };

  /**
   * 语音输入。两个目标的语义不同：
   * - ask：说完（识别到 final）**自动发送**——语音的价值就在手不空的场景（车间/戴手套/边操作边问），
   *   还要再点一次发送等于废掉一半；实时转写预览 + 再点一次可取消，兜住误识别。
   * - note：转写填进笔记草稿，不自动保存——笔记要归档，得让人改完再存。
   */
  const startListening = (target: 'ask' | 'note') => {
    const SR = getRecognizer();
    if (!SR) {
      toast('这个浏览器不支持语音输入', { description: '换 Chrome / Edge 试试，或直接打字' });
      return;
    }
    /* 用 ref 判断"是否正在听"，不能用 state——本函数常在 setTimeout 里跑，闭包里的 state 是过期的 */
    if (recRef.current) { stopListening(); return; }
    const rec = new SR();
    recRef.current = rec;
    rec.lang = 'zh-CN';
    rec.interimResults = true;   // 实时预览：说到哪看到哪
    rec.continuous = false;
    /** 已被取消或替换掉的识别器，其回调一律作废——否则孤立的识别器会在稍后偷偷发出一次提问 */
    const isStale = () => recRef.current !== rec;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      if (isStale()) return;
      let finalText = '';
      let partial = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const seg = e.results[i];
        if (seg.isFinal) finalText += seg[0].transcript;
        else partial += seg[0].transcript;
      }
      setInterim(partial);
      if (!finalText) return;
      recRef.current = null;
      setListening(null);
      setInterim('');
      if (target === 'ask') submitQuestion(finalText);
      else setNoteText((prev) => (prev ? `${prev} ${finalText}` : finalText));
    };
    rec.onerror = () => { if (!isStale()) stopListening(); };
    rec.onend = () => {
      if (isStale()) return;
      recRef.current = null;
      setListening(null);
      setInterim('');
    };
    setListening(target);
    rec.start();
  };
  const srAvailable = getRecognizer() !== null;

  /** 三大模态提问入口（直接挂在播放条上，不藏进二级面板） */
  const askBy = (mode: 'voice' | 'photo' | 'text') => {
    /* 正在听时再点「说」= 取消，立即生效（不要排进 setTimeout，否则连点会叠出两个识别器） */
    if (mode === 'voice' && (recRef.current || pptVoiceRef.current)) { stopListening(); return; }
    stopPlayback();
    setAsking(true);
    hitSpot('modal');
    setTimeout(() => {
      if (mode === 'voice') {
        if (pptTaskId) void startPptVoiceAsk();
        else startListening('ask');
      } else if (mode === 'photo') photoInputRef.current?.click();
      else askInputRef.current?.focus();
    }, 260);
  };

  /* 演示导览：正在讲播该块时，最后点亮的下标即导览步 */
  const tourStepOf = (b: CourseBlock, i: number): number | null => {
    if (!playing || cursor !== i) return null;
    const arr = reveals[b.id];
    if (!arr || arr.length === 0) return null;
    return Math.max(...arr);
  };

  /* ---- 段落签到：学习者按状态自选下一步 ---- */
  const checkInOk = (b: CourseBlock, i: number) => {
    hitSpot('agency');
    setSelfCheck((prev) => ({ ...prev, [b.id]: 'ok' }));
    snd.chime();
    pushSignal({ type: 'self-report', kpId, feel: 'ok' });
    advanceTo(i + 1);
  };
  const checkInVariant = (b: CourseBlock, i: number) => {
    hitSpot('agency');
    setSelfCheck((prev) => ({ ...prev, [b.id]: 'variant' }));
    pushSignal({ type: 'self-report', kpId, feel: 'unsure' });
    stopPlayback();
    const vb = variantBlockOf(kpId, variantSeq.current++);
    materialize(vb, ['信号：你签到「这段还虚」', 'ARB-05 裁定：换讲法', 'GEN-03 正在换问答体重讲…']);
    insertBlocksAfter(i, vb);
    advanceTo(i + 1);
  };
  const checkInQuiz = (b: CourseBlock, i: number) => {
    const [q] = drawQuestions(kpId, 1, { excludeIds: usedQuizIds() });
    if (!q) { toast('这一讲的题都被你做完了', { description: '试试块头上的「问一问」，换对话的方式再过一遍' }); return; }
    hitSpot('agency');
    setSelfCheck((prev) => ({ ...prev, [b.id]: 'quiz' }));
    stopPlayback();
    insertBlocksAfter(i, { kind: 'checkpoint', id: `${kpId}-extra-${q.id}`, q, script: '来，小试一道。' });
    advanceTo(i + 1);
  };

  /* ---- 换讲法重拼（讲末菜单 + 适配横幅「AI 定制」卡都走这里）---- */
  const restyleTo = (next: StyleLabel) => {
    if (next === unit.styleLabel) return;
    stopPlayback();
    setStyleOverride(next);
    setCpPicks({});
    setReveals({});
    setSelfCheck({});
    setFinished(false);
    setTutorFor(null);
    posRef.current = { b: 0, c: 0 };
    setCursor(0);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('GEN-03 正在重新拼装本讲', { description: `换成「${next}」风格——同样的知识点，另一种讲法` });
  };
  const relearnRestyled = () => {
    const options = STYLE_LABELS.filter((s) => s !== unit.styleLabel);
    restyleTo(options[relearnSeq.current++ % options.length]);
  };
  const startMiniTest = () => {
    const levels = unit.difficulty === '进阶' ? undefined : (['basic', 'advanced'] as const);
    const qs = drawQuestions(kpId, 3, { excludeIds: usedQuizIds(), levels: levels ? [...levels] : undefined });
    if (qs.length === 0) { toast('题库里没有新题了', { description: '这一讲的题都被你练完了——试试「问一问」追问对话' }); return; }
    stopPlayback();
    setFinished(false);
    const startIdx = blocksRef.current.length - 1;
    setBlocks((prev) => [
      ...prev,
      ...qs.map((q, qi) => ({ kind: 'checkpoint' as const, id: `${kpId}-mini-${q.id}`, q, script: qi === 0 ? '微测开始，三道题看看整体掌握。' : '下一道。' })),
    ]);
    toast(`微测 ${qs.length} 题已就位`, { description: '做完自动回到完课结算' });
    advanceTo(startIdx + 1);
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
    advanceTo(startIdx + 1);
  };
  const markDoubtHere = () => {
    markDoubt(kpId);
    toast('已标记存疑', { description: `园子里的「${kp.name}」会提前"口渴"，提醒你回来再过一遍` });
  };
  const kpScore = currentLearner.scores[kpId] ?? 50;
  const challengeReady = canStartChallenge(kpScore);

  /* 跟读流：正在讲的那句若滑出视野（长文稿 / 用户手动滚动过），把它轻轻带回来 */
  useEffect(() => {
    if (!playing) return;
    const el = cueRefs.current[blocksRef.current[cursor]?.id ?? ''];
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 88 || r.bottom > window.innerHeight - 130) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [cueIdx, cursor, playing]);

  /* ---- 断点续学：进课件时恢复上次学到的位置与本节涨跌；推进时随手存；完课清除 ---- */
  const resumedRef = useRef<string | null>(null);
  useEffect(() => {
    const sig = `${currentLearner.id}:${kpId}`;
    if (resumedRef.current === sig) return;
    resumedRef.current = sig;
    const p = loadProgress(currentLearner.id, kpId);
    if (!p) return;
    /* 上次换过讲法：先恢复同一版本的课件，unit 变化时不要把进度重置掉 */
    if (p.style && p.style !== unit.styleLabel && (STYLE_LABELS as string[]).includes(p.style)) {
      restoringRef.current = true;
      setStyleOverride(p.style as StyleLabel);
    }
    setUnlocked(p.unlocked);
    setSessionDelta(p.delta);
    const at = Math.max(0, p.unlocked - 1);
    posRef.current = { b: at, c: 0 };
    setCursor(at);
    setTimeout(() => scrollToBlock(at), 420);
    toast('接着上次学', {
      description: `从第 ${p.unlocked} 段继续${p.delta !== 0 ? ` · 本节已 ${p.delta > 0 ? '+' : ''}${p.delta} 掌握` : ''}`,
      action: {
        label: '从头学',
        onClick: () => {
          clearProgress(currentLearner.id, kpId);
          setUnlocked(1);
          setSessionDelta(0);
          setCpPicks({});
          posRef.current = { b: 0, c: 0 };
          setCursor(0);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        },
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLearner.id, kpId]);

  /** 推进/涨分即存断点（完课后不再存——finish 已清） */
  useEffect(() => {
    if (finished) return;
    saveProgress(currentLearner.id, kpId, { unlocked, delta: sessionDelta, style: unit.styleLabel });
  }, [unlocked, sessionDelta, finished, currentLearner.id, kpId, unit.styleLabel]);

  /* ---- 学练一体入口：?drill=1（原独立「练」页重定向到这里，就地开题） ---- */
  const drillDoneRef = useRef(false);
  useEffect(() => {
    if (drillDoneRef.current || searchParams.get('drill') !== '1') return;
    drillDoneRef.current = true;
    const t = setTimeout(() => {
      startMiniTest();
      toast('学和练已经合并在这一页', { description: '已按你的画像就地开出一组分阶题——练完直接回到讲解' });
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);


  /* 本讲 KB 溯源角标总数（适配横幅「已核验」卡展开用） */
  const kbCount = useMemo(
    () => blocks.reduce((n, b) => n + ('kbRefs' in b ? b.kbRefs.length : 0), 0),
    [blocks],
  );
  const mastery = Math.min(99, Math.max(0, kpScore + sessionDelta));

  /** 本讲答错的题（完课时就地复盘——错题本在 /me/wrong 太远，趁热过一遍价值最高） */
  const wrongThisLesson = useMemo(
    () =>
      blocks.filter(
        (b): b is Extract<CourseBlock, { kind: 'checkpoint' }> =>
          b.kind === 'checkpoint' && cpPicks[b.id] !== undefined && cpPicks[b.id] !== b.q.answerIndex,
      ),
    [blocks, cpPicks],
  );

  /* ---- 播放条「下一段」：当前块是未作答检查点时不放行（练是必经的） ---- */
  const curIdx = Math.min(unlocked, blocks.length) - 1;
  const curBlk = blocks[curIdx];
  const canAdvance =
    !freeBrowse && curIdx < blocks.length - 1 && !(curBlk?.kind === 'checkpoint' && cpPicks[curBlk.id] === undefined);
  /* 播放条两态：进入页面默认收起；播放/进入只听/进入专注时展开，主动暂停时收回，换页不改变 */

  /* ---- 键盘：空格 播放/暂停 · → 下一段（输入框内不劫持） ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowRight') {
        if (canAdvance) { e.preventDefault(); advanceTo(curIdx + 1); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAdvance, curIdx, playing]);

  if (topicId && unitLoading) {
    return <div className="mx-auto flex min-h-[58vh] max-w-[760px] items-center justify-center px-5"><div className="lf-card flex max-w-[460px] items-center gap-3 p-6"><Loader2 size={20} className="animate-spin text-brand" /><div><h1 className="text-[15px] font-semibold text-ink">正在准备这个最小知识点</h1><p className="mt-1 text-[12.5px] leading-5 text-ink-muted">后台正在结合你的画像、当前掌握度与真实来源生成独立学习内容。</p></div></div></div>;
  }
  if (topicId && unitError) {
    return <div className="mx-auto flex min-h-[58vh] max-w-[760px] items-center justify-center px-5"><div className="lf-card max-w-[460px] p-6"><h1 className="text-[15px] font-semibold text-ink">这个知识点暂时没有生成成功</h1><p className="mt-2 text-[12.5px] leading-5 text-ink-muted">{unitError}</p><button type="button" onClick={() => window.location.reload()} className="lf-btn-primary mt-4">重新生成</button></div></div>;
  }

  return (
    <div className={cn('mx-auto px-5 transition-[max-width] duration-300 md:px-6', pptTaskId ? (pptWideMode ? 'max-w-[1500px] pb-40 pt-5' : 'max-w-[900px] pb-40 pt-6') : 'max-w-[760px] pb-48 pt-6')}>
      {/* 技术亮点（系统透视）：右下角悬浮球，点开才展开 */}
      {viewMode !== 'learner' && <FeatureSpotlight flags={spotFlags} />}

      {/* 页头 */}
      <div className={cn('flex flex-wrap items-center gap-3', pptTaskId && 'mb-5')}>
        <Link to="/learn" className="inline-flex items-center gap-1 text-[13px] text-ink-muted hover:text-brand">
          <ArrowLeft size={14} /> 课程目录
        </Link>
        <span className="text-hairline">/</span>
        <h1 className="font-serif text-[20px] font-semibold text-ink">{pptTopic || generatedUnit?.topicName || kp.name}</h1>
        {pptTaskId && (
          <div className="ml-auto flex items-center gap-2" aria-label="Model">
            <span className="font-mono text-[12px] font-semibold text-ink-muted">Model:</span>
            <div className="flex rounded-full border border-hairline bg-card-warm p-1 shadow-sm">
              {(['mimo', 'qwen'] as const).map((model) => (
                <button
                  key={model}
                  type="button"
                  disabled={voiceBusy}
                  onClick={() => void switchPptAudioModel(model)}
                  className={cn(
                    'rounded-full px-4 py-1.5 font-mono text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    pptAudioModel === model ? 'bg-brand text-paper shadow-sm' : 'text-ink-muted hover:text-ink',
                  )}
                  title={model === 'mimo' ? 'MiMo 版本' : 'Qwen 版本'}
                >
                  {model === 'mimo' ? 'MiMo' : 'Qwen'}
                </button>
              ))}
            </div>
          </div>
        )}
        <span className="flex items-center gap-2">
          {/* 掌握度小徽标（伴学栏收起时也看得到，移动端唯一入口） */}
          <span
            title="本节掌握度：微练答对 +3、答错 −1，追问过关 +2"
            className={cn(
              'rounded-md border px-2 py-0.5 font-mono text-[10.5px] font-medium',
              mastery >= kp.targetLevel ? 'border-brand/40 bg-brand-tint text-brand' : 'border-hairline bg-card-warm text-ink-2',
            )}
          >
            掌握 {mastery}/{kp.targetLevel}
            {sessionDelta !== 0 && (
              <span className={sessionDelta > 0 ? 'ml-1 text-brand' : 'ml-1 text-brand-danger'}>
                {sessionDelta > 0 ? `+${sessionDelta}` : sessionDelta}
              </span>
            )}
          </span>
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

      {/* ============ 本讲情报条：路线 + 检测/定制/核验 收进一行，点开才展开——第一屏让给正文 ============ */}
      {!pptTaskId && <div className="mt-4 rounded-[12px] border border-hairline bg-card-warm">
        <button
          type="button"
          onClick={() => setBriefOpen((v) => !v)}
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2 text-left"
          title={briefOpen ? '收起本讲情报' : '展开：学习路线 + 检测/定制/核验详情'}
        >
          <span className="flex items-center gap-1.5 font-mono text-[10.5px] font-semibold tracking-wide text-brand">
            <Brain size={11} />
            ADAPTIVE
          </span>
          <span className="text-[12px] text-ink-2">
            {Math.max(0, kp.targetLevel - kpScore) > 0
              ? `缺口 ${Math.max(0, kp.targetLevel - kpScore)} 分 · 检查点已加密`
              : '已过目标线'}
          </span>
          <span className="hidden text-[12px] text-ink-muted sm:inline">讲法「{unit.styleLabel}」· {unit.difficulty}版</span>
          <span className="hidden text-[12px] text-ink-muted md:inline">溯源 {kbCount} 处</span>
          <ChevronDown size={13} className={cn('ml-auto shrink-0 text-ink-muted transition-transform', briefOpen && 'rotate-180')} />
        </button>
        {briefOpen && (
          <div className="border-t border-hairline/60 px-3.5 pb-4">
            <div className="mt-3">
              <PathProgressBar currentKpId={kpId} compact />
            </div>
            <AdaptiveBanner
              kpName={kp.name}
              score={currentLearner.scores[kpId] ?? 50}
              target={kp.targetLevel}
              isWeakest={weakestKp.id === kpId}
              difficulty={unit.difficulty}
              styleLabel={unit.styleLabel}
              expert={viewMode === 'expert'}
              kbCount={kbCount}
              onPickStyle={restyleTo}
            />
          </div>
        )}
      </div>}

      {/* ============ 课堂单列：舞台化——阅读列收窄，当前块即舞台 ============ */}
      <div className={cn('space-y-4', pptTaskId ? 'mt-0' : 'mt-5')}>
        {/* 课堂推进 / 自由浏览 模式条 */}
        {!pptTaskId && <div className="flex items-center justify-between gap-2">
          <span className="text-[11.5px] text-ink-muted">
            {freeBrowse
              ? '自由浏览 · 整讲展开，适合复习'
              : `课堂推进 · 讲到哪开到哪（${Math.min(unlocked, blocks.length)}/${blocks.length} 段）`}
          </span>
          <button
            type="button"
            aria-pressed={freeBrowse}
            onClick={() => setFreeBrowse((v) => !v)}
            title={freeBrowse ? '回到课堂推进：只看讲到的段落' : '自由浏览：展开整讲（复习用）'}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] font-medium transition-all',
              freeBrowse
                ? 'border-brand/45 bg-brand-tint text-brand'
                : 'border-hairline bg-paper text-ink-muted hover:border-brand/40 hover:text-brand',
            )}
          >
            <AlignLeft size={11} />
            {freeBrowse ? '回到课堂推进' : '自由浏览'}
          </button>
        </div>}
        {(pptTaskId) ? <PptPlayer taskId={pptTaskId} wideMode={pptWideMode} speed={pptSpeed} volume={pptVolume} modelProvider={pptAudioModel} qwenVoice={qwenVoice} ref={pptRef} onPlaybackChange={setPlaying} onSlideChange={syncPptSlide} onRequestNote={openNoteHere} /> : (blocks.map((b, i) => {
          const active = i === cursor && playing;
          /* ---- 课堂推进三态：完整（当前/回看/自由浏览）· 摘要行（已完成）· 不渲染（未解锁） ---- */
          const effUnlocked = Math.min(unlocked, blocks.length);
          const isCurrent = i === effUnlocked - 1;
          const isCompleted = !freeBrowse && i < effUnlocked - 1;
          /* 正在讲播的块永远完整展开——否则回听旧段时只剩一行摘要，声音在响却什么都看不到 */
          const isNarrating = playing && cursor === i;
          if (!freeBrowse && i >= effUnlocked) return null;
          if (isCompleted && !reviewOpen[b.id] && !isNarrating) {
            const pick = b.kind === 'checkpoint' ? cpPicks[b.id] : undefined;
            const answered = pick !== undefined;
            const wasCorrect = b.kind === 'checkpoint' && answered && pick === b.q.answerIndex;
            const rowTitle =
              'title' in b && b.title
                ? b.title.replace(/^跟我看一遍，再自己动手 · /, '')
                : b.kind === 'checkpoint'
                  ? `微练 · ${b.q.stem.slice(0, 24)}${b.q.stem.length > 24 ? '…' : ''}`
                  : '本讲小结';
            return (
              <div
                key={b.id}
                ref={(el) => { blockRefs.current[i] = el; }}
                className="flex scroll-mt-[88px] items-center gap-2.5 rounded-[12px] border border-hairline/70 bg-card-warm/60 px-4 py-2"
              >
                <span
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                    b.kind === 'checkpoint'
                      ? wasCorrect
                        ? 'bg-brand-success/15 text-brand-success'
                        : 'bg-brand-danger/10 text-brand-danger'
                      : 'bg-brand-tint text-brand',
                  )}
                >
                  {b.kind === 'checkpoint' ? (wasCorrect ? <Check size={11} /> : <X size={11} />) : <Check size={11} />}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">{rowTitle}</span>
                <button
                  type="button"
                  onClick={() => setReviewOpen((prev) => ({ ...prev, [b.id]: true }))}
                  className="shrink-0 text-[11.5px] font-medium text-ink-muted transition-colors hover:text-brand"
                >
                  展开回看
                </button>
              </div>
            );
          }
          const wrapCls = cn(
            'relative scroll-mt-[88px] overflow-hidden rounded-[14px] border p-5 transition-all duration-300',
            active ? 'border-brand/50 bg-brand-tint/30 shadow-warm' : 'border-hairline bg-card-warm',
            /* 文窄图宽：演播/交互演示是宽内容，破格出窄阅读列消化宽屏空白（文本块保持窄列行长） */
            (b.kind === 'stage' || b.kind === 'demo') && 'lg:-mx-16 xl:-mx-24',
            b.kind === 'remedial' && 'border-brand-amber/50 bg-brand-amber-tint/40',
            flashId === b.id && 'border-brand-amber ring-2 ring-brand-amber/60 shadow-warm-lg',
            /* 专注聚光灯：非当前块调暗 */
            focusMode && i !== cursor && 'opacity-30',
          );
          const glowBadges = active && kbGlow;
          /* 签到行是否在场：在场时它就是推进动作，不再叠加"下一段"行 */
          const signInVisible =
            (b.kind === 'concept' || b.kind === 'stage' || b.kind === 'demo') &&
            !b.id.endsWith('-intro') &&
            !b.id.includes('-variant-') &&
            !selfCheck[b.id];
          return (
            <div key={b.id} ref={(el) => { blockRefs.current[i] = el; }} className={wrapCls}>
              {/* 涨分飘字：反馈落在动作发生的块上 */}
              <AnimatePresence>
                {masteryFloat?.blockId === b.id && (
                  <motion.span
                    key={masteryFloat.seq}
                    initial={{ opacity: 0, y: 8, scale: 0.85 }}
                    animate={{ opacity: 1, y: -10, scale: 1 }}
                    exit={{ opacity: 0, y: -22 }}
                    transition={{ duration: 0.7, ease: 'easeOut' }}
                    className={cn(
                      'pointer-events-none absolute right-4 top-4 z-10 font-mono text-[16px] font-bold',
                      masteryFloat.delta > 0 ? 'text-brand' : 'text-brand-danger',
                    )}
                  >
                    {masteryFloat.delta > 0 ? `+${masteryFloat.delta}` : masteryFloat.delta} 掌握
                  </motion.span>
                )}
              </AnimatePresence>
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
                      <span className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => openTutor(b)}
                        title="跟老师过一遍：就地展开追问对话，不用跳页"
                        className="inline-flex items-center gap-1 rounded-md border border-brand/35 bg-paper px-1.5 py-1 text-[10.5px] font-medium text-brand transition-colors hover:bg-brand-tint"
                      >
                        <GraduationCap size={11} /> 问一问
                      </button>
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
                      </span>
                    )}
                  </div>
                  {(b.kind !== 'concept' || (blockMode[b.id] ?? 'read') === 'read') && (
                    <div className="mt-2 text-[15px] leading-[28px] text-ink-2">
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkCitationMarks]} components={lectureMdComponents}>{b.text}</ReactMarkdown>
                      {/* 溯源内联：角标贴着论断走，不再沉到块底 */}
                      {'kbRefs' in b &&
                        b.kbRefs.map((id) => (
                          <span
                            key={id}
                            className={cn(
                              'ml-1.5 inline-flex -translate-y-[2px] align-middle',
                              glowBadges && 'animate-pulse rounded-md ring-2 ring-brand-amber/70',
                            )}
                          >
                            <TraceBadge kbId={id} />
                          </span>
                        ))}
                      {'citations' in b && generatedUnit && <SourceCitationMarks citations={b.citations} sources={generatedUnit.sources} />}
                    </div>
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
                </>
              )}

              {/* 演播块：黑板教具随语音点亮 */}
              {b.kind === 'stage' && (
                <>
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h3 className="text-[16px] font-semibold text-ink">{b.title}</h3>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => openTutor(b)}
                        title="跟老师过一遍：就地展开追问对话，不用跳页"
                        className="inline-flex items-center gap-1 rounded-md border border-brand/35 bg-paper px-1.5 py-1 text-[10.5px] font-medium text-brand transition-colors hover:bg-brand-tint"
                      >
                        <GraduationCap size={11} /> 问一问
                      </button>
                      <button
                        type="button"
                        onClick={() => { stopPlayback(); startPlay(i, 0); }}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-brand/35 bg-paper px-2 py-1 text-[11.5px] font-medium text-brand hover:bg-brand-tint"
                      >
                        <Play size={11} fill="currentColor" /> 讲这一段
                      </button>
                    </span>
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
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => openTutor(b)}
                        title="跟老师过一遍：就地展开追问对话，不用跳页"
                        className="inline-flex items-center gap-1 rounded-md border border-brand/35 bg-paper px-1.5 py-1 text-[10.5px] font-medium text-brand transition-colors hover:bg-brand-tint"
                      >
                        <GraduationCap size={11} /> 问一问
                      </button>
                      {b.cues && (
                        <button
                          type="button"
                          onClick={() => { stopPlayback(); startPlay(i, 0); }}
                          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-brand-amber/50 bg-brand-amber-tint px-2 py-1 text-[11.5px] font-medium text-ochre hover:border-brand-amber"
                        >
                          <Play size={11} fill="currentColor" /> 跟我看一遍
                        </button>
                      )}
                    </span>
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

              {/* ---- 讲播跟读流：语音讲到哪，文稿高亮到哪（音频对应的文本流，不再只有底部一行字幕）
                      整段句子一次性铺出（布局稳定、能前后回看），已讲过转淡、正在讲高亮、未讲到更淡 ---- */}
              {playing && cursor === i && !audioMode && (() => {
                const cues = cuesOf(b);
                if (cues.length === 0) return null;
                return (
                  <div className="mt-3.5 rounded-[10px] border border-brand/25 bg-paper/70 p-3">
                    <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] tracking-wide text-ink-muted">
                      <Volume2 size={10} className="text-brand" />
                      讲播文稿 · 第 {Math.min(cueIdx + 1, cues.length)}/{cues.length} 句
                      <span className="ml-auto flex items-end gap-[2px]" aria-hidden>
                        {[0, 1, 2].map((k) => (
                          <span key={k} className="w-[2px] animate-breathe rounded-full bg-brand" style={{ height: 9, animationDelay: `${k * 0.18}s` }} />
                        ))}
                      </span>
                    </div>
                    <div className="space-y-1">
                      {cues.map((c, ci) => (
                        <p
                          key={ci}
                          ref={(el) => { if (ci === cueIdx && el) cueRefs.current[b.id] = el; }}
                          className={cn(
                            'text-[13.5px] leading-[22px] transition-colors duration-300',
                            ci === cueIdx
                              ? 'font-medium text-ink'
                              : ci < cueIdx
                                ? 'text-ink-muted/70'
                                : 'text-ink-muted/35',
                          )}
                        >
                          {c.say}
                        </p>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* 块内追问「问一问」：就地展开在这段正下方，聊完收起，人还在原地 */}
              {tutorFor?.blockId === b.id && (
                <div className="mt-3.5">
                  <InlineTutor
                    topic={tutorFor.topic}
                    msgs={tutorMsgs}
                    step={tutorStep}
                    onAnswer={tutorAnswer}
                    onReveal={tutorReveal}
                    onMore={tutorMore}
                    onClose={() => setTutorFor(null)}
                  />
                </div>
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
                      onClick={() => checkInOk(b, i)}
                      className="inline-flex items-center gap-1 rounded-md border border-brand/35 bg-brand px-2.5 py-1 text-[11.5px] font-semibold text-paper shadow-warm transition-all hover:bg-brand-hover"
                    >
                      <Check size={11} /> 很稳，下一段
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
                        placeholder="用自己的话记下这一段的要点…（也可以说，或拍张图）"
                        className="w-full resize-none bg-transparent text-[13px] leading-[20px] text-ink outline-none placeholder:text-ink-muted/60"
                      />

                      {/* 语音实时转写预览：笔记不自动保存——要归档的东西得让人改完再存 */}
                      {listening === 'note' && (
                        <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-brand-danger">
                          <span className="h-1.5 w-1.5 animate-ping rounded-full bg-brand-danger" />
                          正在听…{interim || '（说完自动填进上面）'}
                        </div>
                      )}
                      {/* 笔记附图缩略图 */}
                      {noteImg && (
                        <div className="mt-1.5 flex items-center gap-2 rounded-[8px] border border-hairline bg-card-warm p-1.5">
                          <img src={noteImg.url} alt="" className="h-9 w-9 rounded-[6px] object-cover" />
                          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-2">{noteImg.name}</span>
                          <button type="button" onClick={() => setNoteImg(null)} aria-label="移除图片" className="text-ink-muted hover:text-brand-danger">
                            <X size={12} />
                          </button>
                        </div>
                      )}

                      <div className="mt-1.5 flex items-center gap-2">
                        {/* 三大模态：说 / 拍 / 写（写 = 上面的文本域本身） */}
                        <span className="flex shrink-0 items-center gap-1">
                          {srAvailable && (
                            <button
                              type="button"
                              onClick={() => (listening === 'note' ? stopListening() : startListening('note'))}
                              title={listening === 'note' ? '再点一次停止' : '说：语音转文字填进笔记'}
                              aria-label="语音记笔记"
                              className={cn(
                                'flex h-7 w-7 items-center justify-center rounded-full border transition-all',
                                listening === 'note'
                                  ? 'animate-pulse border-brand-danger bg-brand-danger text-paper'
                                  : 'border-hairline bg-card-warm text-ink-2 hover:border-brand/40 hover:text-brand',
                              )}
                            >
                              <Mic size={13} />
                            </button>
                          )}
                          <input
                            ref={noteImgInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) setNoteImg({ name: f.name, url: URL.createObjectURL(f) });
                              e.target.value = '';
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => noteImgInputRef.current?.click()}
                            title="拍：给这条笔记配张现场图"
                            aria-label="给笔记配图"
                            className="flex h-7 w-7 items-center justify-center rounded-full border border-hairline bg-card-warm text-ink-2 transition-all hover:border-brand/40 hover:text-brand"
                          >
                            <Camera size={13} />
                          </button>
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-muted">
                          自动携带来源{'kbRefs' in b && b.kbRefs.length > 0 ? ' + KB 溯源' : ''} → 个人知识库
                        </span>
                        <span className="flex shrink-0 gap-1.5">
                          <button type="button" onClick={() => { stopListening(); setNoteFor(null); setNoteText(''); setNoteImg(null); }} className="rounded-md px-2 py-1 text-[12px] text-ink-muted hover:text-ink">取消</button>
                          <button
                            type="button"
                            disabled={!noteText.trim() && !noteImg}
                            onClick={() => {
                              stopListening();
                              addNote({
                                kpId,
                                text: `${noteText.trim()}${noteImg ? `\n【图片 · ${noteImg.name}】` : ''}`.trim(),
                                source: `${kp.name} · ${'title' in b && b.title ? b.title : b.kind === 'summary' ? '本讲小结' : '课件'}`,
                                sourceKind: 'course',
                                blockAnchor: b.id,
                                kbRefs: 'kbRefs' in b ? b.kbRefs : [],
                              });
                              setNoteFor(null);
                              setNoteText('');
                              setNoteImg(null);
                            }}
                            className={cn('rounded-md px-2.5 py-1 text-[12px] font-medium', noteText.trim() || noteImg ? 'bg-brand text-paper' : 'bg-paper-deep text-ink-muted/50')}
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

              {/* 课堂推进兜底：签到行不在场的块（开场/变式/补讲/已签到）才出现"下一段"；
                  签到在场时它就是推进动作，一个块结尾只问一次话 */}
              {!freeBrowse && isCurrent && !signInVisible && (b.kind !== 'checkpoint' || cpPicks[b.id] !== undefined) && (
                <div className="mt-4 flex justify-end border-t border-hairline/60 pt-2.5">
                  {i < blocks.length - 1 ? (
                    <button
                      type="button"
                      onClick={() => advanceTo(i + 1)}
                      className="inline-flex items-center gap-1.5 rounded-[10px] bg-brand px-3.5 py-1.5 text-[12.5px] font-semibold text-paper shadow-warm transition-all hover:bg-brand-hover"
                    >
                      继续 · 下一段 <ArrowRight size={13} />
                    </button>
                  ) : (
                    !finished && (
                      <button
                        type="button"
                        onClick={finish}
                        className="inline-flex items-center gap-1.5 rounded-[10px] bg-brand px-3.5 py-1.5 text-[12.5px] font-semibold text-paper shadow-warm transition-all hover:bg-brand-hover"
                      >
                        完课结算 <Check size={13} />
                      </button>
                    )
                  )}
                </div>
              )}

              {/* 已完成块的回看态：可收起 */}
              {isCompleted && reviewOpen[b.id] && (
                <div className="mt-3 flex justify-end border-t border-hairline/60 pt-2">
                  <button
                    type="button"
                    onClick={() => setReviewOpen((prev) => ({ ...prev, [b.id]: false }))}
                    className="text-[11.5px] font-medium text-ink-muted transition-colors hover:text-brand"
                  >
                    收起回看
                  </button>
                </div>
              )}
              </>
              )}
            </div>
          );
        }))}

        <AnimatePresence>
          {finished && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[80] flex items-center justify-center p-4 sm:p-6"
            >
              <button
                type="button"
                aria-label="关闭完课结算"
                onClick={() => setFinished(false)}
                className="absolute inset-0 cursor-default bg-ink/20 backdrop-blur-[6px]"
              />
              <motion.div
                role="dialog"
                aria-modal="true"
                aria-labelledby="lesson-complete-title"
                initial={{ opacity: 0, y: 18, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.98 }}
                transition={{ type: 'spring', stiffness: 360, damping: 30 }}
                onClick={(event) => event.stopPropagation()}
                className="relative max-h-[min(82vh,720px)] w-full max-w-[680px] overflow-y-auto rounded-[20px] border border-brand/35 bg-card-warm p-5 text-center shadow-[0_24px_80px_rgba(44,63,52,0.24)] sm:p-6"
              >
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setFinished(false)}
                className="absolute right-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-full border border-hairline bg-paper/80 text-ink-muted transition-colors hover:border-brand/40 hover:text-brand"
              >
                <X size={15} />
              </button>
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
              <div id="lesson-complete-title" className="text-[15px] font-semibold text-brand">本讲完成 · 阿诊已记录，画像已微调</div>
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
                <button type="button" onClick={startMiniTest} className="lf-btn-ghost !py-2 text-[13.5px]">
                  就地再练 3 题巩固 <ArrowRight size={14} />
                </button>
                <Link to="/report" className="lf-btn-ghost !py-2 text-[13.5px]">看我的成长</Link>
                <Link to="/learn" className="lf-btn-ghost !py-2 text-[13.5px]">回课程目录</Link>
              </div>

              {/* ---- 本讲错题即时复盘：趁热把错的那一两道带解析再过一遍 ---- */}
              {wrongThisLesson.length > 0 && (
                <div className="mt-4 border-t border-brand/20 pt-3.5 text-left">
                  <div className="mb-2 flex items-center gap-1.5">
                    <Bookmark size={12} className="text-brand-danger" />
                    <span className="text-[12.5px] font-medium text-ink-2">
                      这一讲你错了 {wrongThisLesson.length} 道，趁热再看一眼
                    </span>
                    <Link to="/me/wrong" className="ml-auto text-[11.5px] text-ink-muted transition-colors hover:text-brand">
                      错题本 →
                    </Link>
                  </div>
                  <div className="space-y-2">
                    {wrongThisLesson.map((wb) => (
                      <div key={wb.id} className="rounded-[10px] border border-hairline bg-paper p-3">
                        <p className="text-[12.5px] font-medium leading-[19px] text-ink">{wb.q.stem}</p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
                          <span className="text-brand-danger">
                            你选了 {letters[cpPicks[wb.id]]}· {wb.q.options[cpPicks[wb.id]]}
                          </span>
                          <span className="text-brand-success">
                            正确 {letters[wb.q.answerIndex]}· {wb.q.options[wb.q.answerIndex]}
                          </span>
                        </div>
                        <p className="mt-1.5 border-t border-hairline/70 pt-1.5 text-[11.5px] leading-[17px] text-ink-muted">
                          {wb.q.analysis}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

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
                        你的「{kp.name}」当前 {kpScore} 分，还没到进阶线（{CHALLENGE_THRESHOLD}）。想试可以——但我盯着：
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
            </motion.div>
          )}
        </AnimatePresence>

        {/* 课堂推进模式的尾部滚动空间：当前块永远是最后一块，没有这段留白它就无法"块顶对齐"到视口上沿 */}
        {!pptTaskId && !freeBrowse && <div aria-hidden className="h-[32vh]" />}
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
              <span className="text-[13.5px] font-semibold text-ink">幻灯模式 · {pptTopic || kp.name}</span>
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

      {/* 播放条两态：闲时收成居中小胶囊（屏幕还给内容），讲播中才展开完整控制台。
          字幕不再是独立悬浮黑条，而是贴合在控制台顶部的一体化条（悬浮层 2→1）。 */}
      {/* 外层全宽容器不吃点击（否则胶囊态时两侧空白区会挡住其后内容的按钮），只有控制台本体可交互 */}
      <div className="pointer-events-none fixed inset-x-0 bottom-16 z-40 md:bottom-0">
        <div className={cn('mx-auto px-5 pb-3 md:px-6', barExpanded ? 'max-w-[760px]' : 'flex justify-center')}>
          <div className={cn('lf-glass pointer-events-auto overflow-hidden', barExpanded ? 'rounded-[16px]' : 'rounded-full shadow-warm-lg')}>
          {/* 字幕（一体化顶条；通勤模式下已在上方大字显示，这里不再重复）。
              条件渲染而非 AnimatePresence：后者靠 rAF 完成 exit 才卸载，页面在后台时会卡住不消失 */}
          {/* 注意：bg-ink/90 里的透明度只能取 Tailwind 刻度上的值（5 的倍数）。
              曾写成 bg-ink/88 —— 类名压根不会生成，背景透明 + 近白文字 = 字幕彻底隐形。 */}
          {subtitle && !audioMode && barExpanded && (
            <div className="lf-fade-in border-b border-ink/20 bg-ink/90 px-4 py-2.5 text-center text-[14px] font-medium leading-[22px] text-paper">
              {subtitle}
            </div>
          )}

          <div className={cn('flex items-center', barExpanded ? 'flex-wrap gap-x-2 gap-y-1.5 px-4 py-2.5' : 'gap-1.5 px-3 py-2')}>
            {pptTaskId && (
              <button
                type="button"
                disabled={pptSlide.current <= 0}
                onClick={() => pptRef.current?.goPrev()}
                title="上一页"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-hairline bg-paper text-brand transition-all hover:bg-brand-tint disabled:cursor-not-allowed disabled:text-ink-muted/35"
              >
                <ChevronLeft size={16} />
              </button>
            )}
            <button
              type="button"
              onClick={togglePlay}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-paper transition-transform hover:scale-105"
              title={playing ? '暂停' : '语音授课'}
            >
              {playing ? <Pause size={17} /> : <Play size={17} fill="currentColor" />}
            </button>

            {pptTaskId && (
              <button
                type="button"
                disabled={pptSlide.current >= pptSlide.count - 1}
                onClick={() => pptRef.current?.goNext()}
                title="下一页"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-hairline bg-paper text-brand transition-all hover:bg-brand-tint disabled:cursor-not-allowed disabled:text-ink-muted/35"
              >
                <ChevronRight size={16} />
              </button>
            )}

            {/* 课堂节拍器：下一段（当前块是未作答检查点时禁用——练是必经的） */}
            {!pptTaskId && !freeBrowse && (
              <button
                type="button"
                disabled={!canAdvance}
                onClick={() => canAdvance && advanceTo(curIdx + 1)}
                title={canAdvance ? '下一段' : curBlk?.kind === 'checkpoint' ? '先答完这道微练' : '已是最后一段'}
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-all',
                  canAdvance
                    ? 'border-brand/40 bg-paper text-brand hover:bg-brand-tint'
                    : 'cursor-not-allowed border-hairline bg-paper text-ink-muted/40',
                )}
              >
                <ArrowRight size={15} />
              </button>
            )}

            {/* 说话脉冲 */}
            {playing && barExpanded && (
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

            {/* 标题独立一行，避免与右侧操作按钮互相挤压 */}
            {barExpanded && (
              <div className="order-first flex w-full items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate whitespace-nowrap text-[13px] font-medium text-ink">
                    {playing ? '正在讲播' : pptTaskId ? `${pptTopic || kp.name} · ${pptSlide.current + 1}/${Math.max(1, pptSlide.count)} 页` : `${kp.name} · 交互课件`}
                  </div>
                  <div className="flex min-w-0 items-center gap-2 whitespace-nowrap font-mono text-[10px] text-ink-muted">
                    <span className="shrink-0">{tts.supported ? <Volume2 size={10} /> : <VolumeX size={10} />}</span>
                    <span className="truncate">
                      {pptTaskId
                        ? `音色 ${pptAudioModel === 'qwen' ? QWEN_VOICES.find((item) => item.value === qwenVoice)?.label : pptVoice} · 语速 ${MIMO_SPEEDS.find((item) => item.value === pptSpeed)?.label ?? pptSpeed}`
                        : tts.supported
                          ? `语音授课 · ${voiceStyle.label} · ${RATES[rateIdx].toFixed(2).replace(/0$/, '')}×`
                          : '默片模式（字幕+视觉照常）'}
                    </span>
                  </div>
                </div>
              </div>
            )}


            {/* 音量：静音切换 + 滑杆（同时作用于幻灯片语音与 AI 回答） */}
            {pptTaskId && (
              <div className="flex shrink-0 items-center gap-1.5" title="播放音量">
                <button
                  type="button"
                  onClick={() => changePptVolume(pptVolume === 0 ? 1 : 0)}
                  aria-label={pptVolume === 0 ? '取消静音' : '静音'}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-hairline bg-paper text-ink-2 transition-colors hover:text-brand"
                >
                  {pptVolume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
                </button>
                {barExpanded && (
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={pptVolume}
                    onChange={(event) => changePptVolume(Number(event.target.value))}
                    className="h-1 w-16 cursor-pointer accent-brand"
                    aria-label="播放音量"
                  />
                )}
              </div>
            )}

            {pptTaskId && (
              <button
                type="button"
                onClick={() => setPptWideMode((wide) => !wide)}
                title={pptWideMode ? '切换为窄屏' : '切换为宽屏'}
                aria-label={pptWideMode ? '切换为窄屏' : '切换为宽屏'}
                aria-pressed={pptWideMode}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 border border-hairline bg-paper text-ink-2 transition-all hover:border-brand/40 hover:text-brand',
                  barExpanded ? 'rounded-[10px] px-3 py-2 text-[13px] font-medium' : 'rounded-full p-2.5',
                )}
              >
                {pptWideMode ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                {barExpanded && (pptWideMode ? '窄屏' : '宽屏')}
              </button>
            )}

            {/* 记笔记：全页唯一入口，自动挂到你正在看的那一段（胶囊态只留图标） */}
            <button
              type="button"
              onClick={openNoteHere}
              title="记笔记（自动关联你正在看的那一段）"
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-[10px] bg-brand text-paper shadow-warm transition-all hover:bg-brand-hover hover:shadow-warm-lg',
                barExpanded ? 'px-3.5 py-2 text-[13px] font-semibold' : 'rounded-full p-2.5',
              )}
            >
              <PenLine size={14} />
              {barExpanded && '记笔记'}
            </button>

            {/* ---- 举手提问的三大模态：说 / 拍 / 写 直接摆在条上（不藏进二级面板） ---- */}
            <span
              className={cn(
                'flex shrink-0 items-center gap-0.5 border border-brand-amber/50 bg-brand-amber-tint p-0.5',
                barExpanded ? 'rounded-[11px]' : 'rounded-full',
              )}
            >
              {([
                { m: 'voice', icon: Mic, label: '说', tip: '说：语音提问 · 说完自动发送，再点一次可取消' },
                { m: 'photo', icon: Camera, label: '拍', tip: '拍：拍张现场照片一起问' },
                { m: 'text', icon: MessageSquare, label: '写', tip: '写：打字提问' },
              ] as const).map(({ m, icon: MIcon, label, tip }) => {
                const live = m === 'voice' && listening === 'ask';
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => (live ? stopListening() : askBy(m))}
                    title={tip}
                    aria-label={tip}
                    className={cn(
                      'inline-flex items-center gap-1 font-medium transition-all',
                      barExpanded ? 'rounded-[9px] px-2 py-1.5 text-[12.5px]' : 'rounded-full p-2',
                      live ? 'animate-pulse bg-brand-danger text-paper' : 'text-ochre hover:bg-brand-amber/25',
                    )}
                  >
                    <MIcon size={14} />
                    {barExpanded && label}
                  </button>
                );
              })}
            </span>

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
              /* 更多：次要模式与语音设置收进一个菜单——常驻只留 播放/下一段/记笔记/举手 */
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    title="更多：幻灯 / 只听 / 专注 / 语音设置"
                    aria-label="更多学习方式与语音设置"
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1.5 border border-hairline bg-paper text-ink-2 transition-all hover:border-brand/40 hover:text-brand',
                      barExpanded ? 'rounded-[10px] px-3 py-2 text-[13px] font-medium' : 'rounded-full p-2.5',
                    )}
                  >
                    <MoreHorizontal size={15} />
                  </button>
                </PopoverTrigger>
                <PopoverContent side="top" align="end" className="w-72 border-hairline bg-card-warm p-4">
                  <div className="lf-mono-label !text-[10px]">VOICE · {pptTaskId ? '音色' : '语音风格'}</div>
                  <div className={cn('mt-2', pptTaskId ? 'grid grid-cols-2 gap-1.5' : 'space-y-1.5')}>
                    {pptTaskId && pptAudioModel === 'mimo' ? MIMO_VOICES.map((voice) => (
                      <button
                        key={voice}
                        type="button"
                        disabled={pptVoiceSaving}
                        onClick={() => void savePptVoiceSetting({ voice })}
                        aria-pressed={voice === pptVoice}
                        className={cn(
                          'flex w-full items-center justify-between rounded-[9px] border px-3 py-1.5 text-left transition-all duration-200 disabled:opacity-60',
                          voice === pptVoice ? 'border-brand/45 bg-brand-tint text-brand' : 'border-hairline bg-paper text-ink-2 hover:border-brand/30',
                        )}
                      >
                        <span className="text-[12px] font-medium">{voice}</span>
                        {voice === pptVoice && <Check size={13} className="shrink-0" />}
                      </button>
                    )) : pptTaskId ? QWEN_VOICES.map((voice) => (
                      <button
                        key={voice.value}
                        type="button"
                        disabled={voiceBusy}
                        onClick={() => setQwenVoice(voice.value)}
                        aria-pressed={voice.value === qwenVoice}
                        className={cn(
                          'flex w-full items-center justify-between rounded-[9px] border px-3 py-1.5 text-left transition-all duration-200 disabled:opacity-60',
                          voice.value === qwenVoice ? 'border-brand/45 bg-brand-tint text-brand' : 'border-hairline bg-paper text-ink-2 hover:border-brand/30',
                        )}
                      >
                        <span className="text-[12px] font-medium">{voice.label}</span>
                        {voice.value === qwenVoice && <Check size={13} className="shrink-0" />}
                      </button>
                    )) : VOICE_STYLES.map((s, i) => (
                      <button
                        key={s.key}
                        type="button"
                        onClick={() => setVoiceIdx(i)}
                        aria-pressed={i === voiceIdx}
                        className={cn(
                          'flex w-full items-center justify-between rounded-[9px] border px-3 py-1.5 text-left transition-all duration-200',
                          i === voiceIdx
                            ? 'border-brand/45 bg-brand-tint text-brand'
                            : 'border-hairline bg-paper text-ink-2 hover:border-brand/30',
                        )}
                      >
                        <span className="text-[12px] font-medium">{s.label}</span>
                        {i === voiceIdx && <Check size={13} className="shrink-0" />}
                      </button>
                    ))}
                  </div>

                  <div className="lf-mono-label mt-3 !text-[10px]">RATE · 语速</div>
                  <div className="mt-2 flex gap-1">
                    {pptTaskId ? MIMO_SPEEDS.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        disabled={pptVoiceSaving}
                        onClick={() => void savePptVoiceSetting({ speed: item.value })}
                        aria-pressed={item.value === pptSpeed}
                        className={cn(
                          'flex-1 rounded-[8px] border px-1 py-1.5 font-mono text-[11px] transition-all duration-200 disabled:opacity-60',
                          item.value === pptSpeed ? 'border-brand bg-brand text-paper' : 'border-hairline bg-paper text-ink-2 hover:border-brand/40',
                        )}
                      >
                        {item.label}
                      </button>
                    )) : RATES.map((r, i) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setRateIdx(i)}
                        aria-pressed={i === rateIdx}
                        className={cn(
                          'flex-1 rounded-[8px] border px-1 py-1.5 font-mono text-[11px] transition-all duration-200',
                          i === rateIdx
                            ? 'border-brand bg-brand text-paper'
                            : 'border-hairline bg-paper text-ink-2 hover:border-brand/40',
                        )}
                      >
                        {r.toFixed(2).replace(/0$/, '')}×
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
          </div>
        </div>
      </div>

      {/* ============ 专注结算卡 ============ */}

      {/* 音色/语速切换：当前讲解仍用旧设置时，确认是否从当前页/当前回答重新朗读 */}
      {voiceRestart && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm" onClick={() => setVoiceRestart(null)}>
          <div className="w-full max-w-sm rounded-[16px] border border-hairline bg-card-warm p-5 shadow-warm-lg" onClick={(event) => event.stopPropagation()}>
            <h3 className="font-serif text-[16px] font-semibold text-ink">音色 / 语速已切换</h3>
            <p className="mt-2 text-[12.5px] leading-5 text-ink-2">
              当前讲解仍在使用旧设置朗读。是否从{voiceRestart === 'answer' ? '当前回答' : '当前页'}开头重新朗读？
            </p>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={restartVoicePlayback} className="lf-btn-primary flex-1 !py-2 text-[13px]">重新朗读</button>
              <button type="button" onClick={() => setVoiceRestart(null)} className="lf-btn-ghost flex-1 !py-2 text-[13px]">仅下次生效</button>
            </div>
          </div>
        </div>
      )}
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

      {/* PPT 当前页笔记：Markdown 编辑并保存到“我的笔记”。 */}
      <AnimatePresence>
        {pptTaskId && pptNoteOpen && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/25 p-4 backdrop-blur-sm"
            onClick={() => setPptNoteOpen(false)}
          >
            <motion.div
              role="dialog" aria-modal="true" aria-labelledby="ppt-note-title"
              initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
              onClick={(event) => event.stopPropagation()}
              className="flex max-h-[82vh] w-full max-w-[760px] flex-col overflow-hidden rounded-[20px] border border-hairline bg-paper shadow-warm-lg"
            >
              <div className="flex items-center gap-2 border-b border-hairline px-5 py-4">
                <PenLine size={15} className="text-brand" />
                <h3 id="ppt-note-title" className="text-[15px] font-semibold text-ink">当前页笔记</h3>
                <span className="font-mono text-[10.5px] text-ink-muted">第 {pptSlide.current + 1} 页</span>
                <button type="button" onClick={() => setPptNoteOpen(false)} className="ml-auto text-ink-muted hover:text-ink" aria-label="关闭笔记">
                  <X size={16} />
                </button>
              </div>
              <div className="flex items-center gap-1 border-b border-hairline bg-card-warm/55 px-5 py-2">
                {([['source', '源码'], ['preview', '预览'], ['pages', '分页']] as const).map(([mode, label]) => <button key={mode} type="button" onClick={() => setPptNoteMode(mode)} className={cn('rounded-full px-3 py-1.5 text-[11.5px] font-medium', pptNoteMode === mode ? 'bg-ink text-paper' : 'text-ink-muted hover:bg-paper-deep')}>{label}</button>)}
                <button type="button" disabled={pptNoteLoading} onClick={() => {
                  const pending = preparePptNoteDraft(pptSlide.current);
                  if (!pending) return;
                  setPptNoteLoading(true);
                  void pending.then((draft) => { setPptNoteTitle(draft.title); setNoteText(draft.content); })
                    .catch((reason) => toast.error(reason instanceof Error ? reason.message : '笔记草稿生成失败'))
                    .finally(() => setPptNoteLoading(false));
                }} className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-brand/25 bg-brand-tint px-3 py-1.5 text-[11.5px] font-medium text-brand hover:border-brand/45 disabled:opacity-60"><Lightbulb size={13} />{pptNoteLoading ? '整理中' : '灵感总结'}</button>
                <Link to="/me/notes" className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] text-ink-2 hover:bg-paper-deep"><NotebookPen size={13} />打开笔记本</Link>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-4">
              <input
                value={pptNoteTitle}
                onChange={(event) => setPptNoteTitle(event.target.value)}
                className="mt-4 h-10 w-full rounded-[10px] border border-hairline bg-card-warm px-3 text-[13.5px] font-medium text-ink outline-none focus:border-brand/50"
                placeholder="笔记标题"
              />
              {pptNoteMode === 'source' && <textarea
                value={noteText}
                onChange={(event) => setNoteText(event.target.value)}
                className="mt-2 min-h-[240px] w-full resize-y rounded-[10px] border border-hairline bg-card-warm p-3 text-[13px] leading-6 text-ink outline-none focus:border-brand/50 disabled:opacity-60"
                placeholder="从这里开始记录你的想法…"
              />}
              {pptNoteMode === 'preview' && <article className="mt-2 min-h-[260px] rounded-[12px] border border-hairline bg-card-warm p-5"><ReactMarkdown remarkPlugins={[remarkGfm]} components={lectureMdComponents}>{noteText || '*还没有内容*'}</ReactMarkdown></article>}
              {pptNoteMode === 'pages' && <div className="mt-2 grid min-h-[260px] gap-3 md:grid-cols-2">{noteText.split(/\n(?=#{1,3}\s)/).filter(Boolean).map((page, index) => <article key={`${index}-${page.slice(0, 12)}`} className="rounded-[12px] border border-hairline bg-card-warm p-4 shadow-sm"><div className="mb-3 font-mono text-[9px] text-ink-muted">PAGE {String(index + 1).padStart(2, '0')}</div><ReactMarkdown remarkPlugins={[remarkGfm]} components={lectureMdComponents}>{page}</ReactMarkdown></article>)}</div>}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3">
                <button type="button" onClick={() => setPptNoteOpen(false)} className="lf-btn-ghost !py-2 text-[13px]">取消</button>
                <button
                  type="button"
                  disabled={!noteText.trim()}
                  onClick={() => {
                    addNote({
                      kpId, text: noteText.trim(), source: `${pptNoteTitle || `第 ${pptSlide.current + 1} 页笔记`} · ${pptTopic || kp.name}`,
                      sourceKind: 'course', blockAnchor: `${pptTaskId}:slide:${pptSlide.current}`, kbRefs: [],
                    });
                    setPptNoteOpen(false);
                  }}
                  className="lf-btn-primary !py-2 text-[13px] disabled:opacity-50"
                >
                  <Check size={13} /> 保存到我的笔记
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
            className="fixed bottom-36 right-4 z-50 flex max-h-[min(480px,60dvh)] w-[min(380px,calc(100vw-32px))] flex-col overflow-hidden rounded-[16px] border border-hairline bg-paper shadow-warm-lg md:bottom-24 md:right-[max(16px,calc(50vw-380px))]"
          >
            <div className="flex items-center gap-2 border-b border-hairline bg-card-warm px-4 py-2.5">
              <Hand size={14} className="text-ochre" />
              <span className="text-[13.5px] font-semibold text-ink">课堂提问 · 已暂停授课</span>
              <span className="rounded-full bg-paper px-2 py-0.5 font-mono text-[9px] text-ink-muted">{pptAudioModel === 'mimo' ? '经典' : '实时'}</span>
              <button type="button" disabled={voiceBusy} onClick={() => void createFreshPptChatSession()} className="ml-auto rounded-md px-1.5 py-1 font-mono text-[10px] text-ink-muted hover:bg-paper hover:text-brand disabled:opacity-50" title="新建会话">新建</button>
              <button type="button" onClick={() => { pptAskAbortRef.current?.abort(); stopAnswerAudio(); setAsking(false); }} className="text-ink-muted hover:text-ink">
                <X size={15} />
              </button>
            </div>
            <div className="flex items-center gap-2 border-b border-hairline bg-paper px-4 py-2">
              <select
                value={pptChatSessionRefs.current[pptAudioModel]}
                onChange={(event) => void selectPptChatSession(event.target.value)}
                disabled={voiceBusy}
                className="min-w-0 flex-1 truncate bg-transparent text-[11px] text-ink-2 outline-none disabled:opacity-50"
                aria-label="课堂提问会话"
              >
                {pptChatSessions.filter((item) => item.modelProvider === pptAudioModel).map((session) => (
                  <option key={session.id} value={session.id}>{session.title || '新课堂会话'}</option>
                ))}
              </select>
              <button type="button" disabled={voiceBusy || !pptChatSessionRefs.current[pptAudioModel]} onClick={() => void removeCurrentPptChatSession()} className="font-mono text-[10px] text-ink-muted hover:text-brand-danger disabled:opacity-40">删除</button>
            </div>
            <div ref={qaScrollRef} className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
              {qaLog.length === 0 && (
                <p className="py-3 text-center text-[12px] text-ink-muted">问本讲相关的问题，比如"{qaBankHint(kpId)}"</p>
              )}
              {qaLog.map((qa, i) => (
                <div key={qa.id ?? i} className="space-y-1.5">
                  {qa.photo && (
                    <img
                      src={qa.photo}
                      alt="提问附图"
                      className="ml-auto block max-h-[120px] w-fit rounded-[10px] border border-hairline object-cover"
                    />
                  )}
                  {qa.voice ? (
                    <div className="ml-auto w-fit max-w-[90%]">
                      <div className="flex items-center gap-2 rounded-[12px] rounded-br-[4px] bg-brand px-3 py-2 text-paper">
                        <button type="button" disabled={!qa.audioUrl} onClick={() => { if (qa.audioUrl) void playUserAudio(qa.audioUrl); }} className="flex h-5 w-5 items-center justify-center rounded-full bg-paper/20 disabled:opacity-60" title="播放我的语音"><Play size={11} fill="currentColor" /></button>
                        <span className="font-mono text-[11.5px]">{qa.duration ?? 1}″</span>
                        {qa.converting ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : qa.transcript ? (
                          <button
                            type="button"
                            onClick={() => { if (qa.id) setVoiceTranscriptOpen((prev) => ({ ...prev, [String(qa.id)]: !prev[String(qa.id)] })); }}
                            title="转文字"
                            aria-label="转文字"
                            className="ml-1 flex h-5 w-5 items-center justify-center rounded-full bg-paper/20 transition hover:bg-paper/30"
                          >
                            <FileText size={12} />
                          </button>
                        ) : null}
                      </div>
                      {qa.transcript && qa.id && voiceTranscriptOpen[qa.id] && (
                        <div className="mt-1 ml-auto w-fit max-w-[92%] rounded-[10px] bg-paper px-3 py-1.5 text-[12px] leading-5 text-ink">
                          {qa.transcript}
                        </div>
                      )}
                    </div>
                  ) : (
                    qa.q && <div className="ml-auto w-fit max-w-[90%] rounded-[12px] rounded-br-[4px] bg-brand px-3 py-1.5 text-[12.5px] text-paper">{qa.q}</div>
                  )}
                  <div className="w-fit max-w-[92%] rounded-[12px] rounded-tl-[4px] border border-hairline bg-card-warm px-3 py-2 text-[12.5px] leading-[19px] text-ink-2">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{qa.a || (qa.voice ? (qa.converting ? '正在识别语音…' : '已识别，正在回答…') : '')}</ReactMarkdown>
                    {qa.kbRef && <span className="ml-1.5"><TraceBadge kbId={qa.kbRef} /></span>}
                  </div>
                </div>
              ))}
            </div>
            {/* 待发送的现场照片 */}
            {askPhoto && (
              <div className="flex items-center gap-2 border-t border-hairline bg-card-warm px-3 pt-2.5">
                <img src={askPhoto.url} alt="" className="h-10 w-10 rounded-[8px] border border-hairline object-cover" />
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-2">{askPhoto.name}</span>
                <button
                  type="button"
                  onClick={() => setAskPhoto(null)}
                  aria-label="移除照片"
                  className="text-ink-muted transition-colors hover:text-brand-danger"
                >
                  <X size={13} />
                </button>
              </div>
            )}

            <div className="flex items-center gap-2 border-t border-hairline bg-card-warm px-3 py-2.5">
              {/* 拍照/传图提问：车间场景的主力问法 */}
              <input ref={photoInputRef} type="file" accept="image/*" className="hidden" onChange={pickPhoto} />
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                title="拍张现场照片一起问"
                aria-label="上传现场照片"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-hairline bg-paper text-ink-2 transition-all hover:border-brand/40 hover:text-brand"
              >
                <ImagePlus size={15} />
              </button>
              <button
                type="button"
                disabled={voiceBusy}
                onClick={() => {
                  if (listening === 'ask' || pptVoiceRef.current) stopListening();
                  else if (pptTaskId) void startPptVoiceAsk();
                  else if (getRecognizer()) startListening('ask');
                }}
                title={voiceBusy ? '正在识别并回答，请稍候' : listening === 'ask' ? '再点一次取消（不发送）' : '语音提问 · 说完自动发送'}
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-all',
                  voiceBusy ? 'cursor-not-allowed opacity-40' : listening === 'ask' ? 'animate-pulse border-brand-danger bg-brand-danger text-paper' : 'border-hairline bg-paper text-ink-2 hover:border-brand/40',
                )}
              >
                <Mic size={15} />
              </button>
              <input
                ref={askInputRef}
                value={listening === 'ask' ? interim : question}
                onChange={(e) => setQuestion(e.target.value)}
                readOnly={listening === 'ask' || voiceBusy}
                disabled={voiceBusy}
                onKeyDown={(e) => { if (e.key === 'Enter') submitQuestion(); }}
                placeholder={
                  voiceBusy
                    ? '正在识别并回答，暂时不能输入'
                    : listening === 'ask'
                      ? '正在听…说完自动发送'
                      : askPhoto
                        ? '这张图想问什么？（可不填）'
                        : '输入问题，或点麦克风说'
                }
                className={cn(
                  'h-9 min-w-0 flex-1 rounded-[10px] border bg-paper px-3 text-[13px] outline-none focus:border-brand/50',
                  listening === 'ask' ? 'border-brand-danger/50 text-ink-muted' : 'border-hairline text-ink',
                )}
              />
              <button
                type="button"
                onClick={() => submitQuestion()}
                disabled={voiceBusy || (!question.trim() && !askPhoto)}
                className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]', question.trim() || askPhoto ? 'bg-brand text-paper' : 'bg-paper-deep text-ink-muted/50')}
              >
                <Send size={14} />
              </button>
            </div>
            <button
              type="button"
              onClick={() => { pptAskAbortRef.current?.abort(); stopAnswerAudio(); setAsking(false); if (pptTaskId) { setBarExpanded(true); pptRef.current?.play(); } else startPlay(posRef.current.b, posRef.current.c); }}
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
