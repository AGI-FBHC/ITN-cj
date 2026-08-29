/**
 * 导学对话气泡体系（tutoring.md S2）
 * TutorBubble：DIA-01 头像 + 阶段徽标 + 流式打字（14ms tick）+ 光标
 * LearnerBubble：右对齐，当前画像头像
 * BackstageCard：多智能体幕后协商折叠卡（mono，虚线边）
 * ArbitrateRow：ARB-05 决策仲裁 loading 行
 */
import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Settings2, ListChecks } from 'lucide-react';
import { AgentIcon } from '@/components/AgentChip';
import TraceBadge, { withTraceBadges } from '@/components/TraceBadge';
import { getAgent } from '@/data/agents';
import { useProfile } from '@/context/ProfileContext';
import type { BackstageNote, TutorOption, TutorStage } from '@/data/tutoringScript';
import { cn } from '@/lib/utils';

/** 三阶追问进度点颜色（与旧单徽标 stageTone 同色系） */
const stageDotColor: Record<TutorStage, string> = {
  引导: 'bg-brand',
  追问: 'bg-brand-amber',
  确认: 'bg-brand-success',
};
const stageOrder: TutorStage[] = ['引导', '追问', '确认'];

/** 三阶迷你进度点：引导→追问→确认，走过的阶段沿用各自的色，hover 显示当前阶段文字 */
function StageProgress({ stage }: { stage: TutorStage }) {
  const idx = stageOrder.indexOf(stage);
  return (
    <span className="flex items-center gap-1" title={stage}>
      {stageOrder.map((s, i) => (
        <span
          key={s}
          className={cn('h-1.5 w-1.5 rounded-full transition-colors', i <= idx ? stageDotColor[s] : 'bg-hairline/70')}
        />
      ))}
    </span>
  );
}

/** 置信度三格指示（●●●，实心格数 = round(confidence*3)），仅非 learner 视角显示 */
function ConfidenceMeter({ value, className }: { value: number; className?: string }) {
  const filled = Math.round(value * 3);
  return (
    <span className={cn('flex items-center gap-0.5', className)} title={`置信度 ${value.toFixed(2)}`}>
      {[0, 1, 2].map((i) => (
        <span key={i} className={cn('h-1.5 w-1.5 rounded-full', i < filled ? 'bg-brand' : 'bg-hairline')} />
      ))}
    </span>
  );
}

/** 导师头像块（DIA-01 墨绿） */
export function TutorAvatar() {
  const dia = getAgent('DIA-01');
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-brand/35 bg-brand-tint">
      <AgentIcon agent={dia} size={17} />
    </span>
  );
}

export function TypingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="flex items-start gap-3"
    >
      <TutorAvatar />
      <div className="flex items-center gap-1.5 rounded-[14px] rounded-tl-[4px] border border-hairline bg-brand-tint/40 px-4 py-3.5">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-brand"
            animate={{ opacity: [0.25, 1, 0.25], y: [0, -3, 0] }}
            transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }}
          />
        ))}
      </div>
    </motion.div>
  );
}

export function TutorBubble({
  id,
  text,
  stage,
  kbRefs,
  confidence,
  onStreamDone,
}: {
  id: string;
  text: string;
  stage?: TutorStage;
  kbRefs?: string[];
  /** 0-1，仅非 learner 视角渲染为三格置信度指示（演示值） */
  confidence?: number;
  onStreamDone: (id: string) => void;
}) {
  const { viewMode } = useProfile();
  const isLearner = viewMode === 'learner';
  const dia = getAgent('DIA-01');
  const reduced = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  const [n, setN] = useState(() => (reduced ? text.length : 0));

  /* 流式打字：14ms tick，每 tick 2 字符 */
  useEffect(() => {
    if (reduced) {
      const t = setTimeout(() => onStreamDone(id), 0);
      return () => clearTimeout(t);
    }
    const timer = setInterval(() => {
      setN((s) => {
        const next = s + 2;
        if (next >= text.length) {
          clearInterval(timer);
          onStreamDone(id);
          return text.length;
        }
        return next;
      });
    }, 14);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const streaming = n < text.length;

  /** 流式中点击 / Enter 跳过打字：立即补满文本并通知引擎（notifyStreamDone 幂等，安全重复调用） */
  const skipTyping = () => {
    if (!streaming) return;
    setN(text.length);
    onStreamDone(id);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="flex items-start gap-3"
    >
      <TutorAvatar />
      <div className="min-w-0 max-w-[86%]">
        <div className="mb-1 flex items-center gap-2">
          {/* 学习者只需要知道「这是老师在说话」，内部代号留给系统透视 */}
          <span className="text-[11.5px] font-semibold text-brand">
            {isLearner ? '伴学助手老师' : 'DIA-01 · 导师'}
          </span>
          {stage && <StageProgress stage={stage} />}
          {!isLearner && confidence !== undefined && (
            <ConfidenceMeter value={confidence} className="ml-auto" />
          )}
        </div>
        {/* Agent 身份透视行：仅非 learner 视角显示 */}
        {!isLearner && (
          <div className="mb-1 -mt-0.5 font-mono text-[9.5px] text-ink-muted">
            {dia.code} · {dia.name}
          </div>
        )}
        <div
          className={cn(
            'relative rounded-[14px] rounded-tl-[4px] border border-hairline bg-brand-tint/40 px-4 py-3',
            streaming && 'cursor-pointer',
          )}
          onClick={skipTyping}
          {...(streaming
            ? {
                role: 'button' as const,
                tabIndex: 0,
                title: '点击跳过打字',
                onKeyDown: (e: KeyboardEvent) => {
                  if (e.key === 'Enter') skipTyping();
                },
              }
            : {})}
        >
          <p className="text-[14px] leading-[24px] text-ink-2">
            {withTraceBadges(text.slice(0, n))}
            {streaming && <span className="animate-caret-blink font-mono text-brand">▍</span>}
          </p>
          {!streaming && kbRefs && kbRefs.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1 border-t border-brand/15 pt-2">
              {kbRefs.map((id) => (
                <TraceBadge key={id} kbId={id} />
              ))}
            </div>
          )}
          {streaming && (
            <span className="pointer-events-none absolute bottom-1 right-2 font-mono text-[10px] text-ink-muted/70">
              跳过 ▸
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}

export function LearnerBubble({
  text,
  avatar,
  name,
}: {
  text: string;
  avatar: string;
  name: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="flex items-start justify-end gap-3"
    >
      <div className="min-w-0 max-w-[80%]">
        <div className="mb-1 text-right font-mono text-[10.5px] text-ink-muted">{name} · 学习者</div>
        <div className="rounded-[14px] rounded-tr-[4px] border border-hairline bg-paper-deep px-4 py-3">
          <p className="text-[14px] leading-[23px] text-ink">{text}</p>
        </div>
      </div>
      <img
        src={avatar}
        alt={name}
        className="h-9 w-9 shrink-0 rounded-full border border-hairline object-cover"
      />
    </motion.div>
  );
}

/** 答题反馈条：居中窄条卡片，correct 墨绿 ✓ / wrong 砖红 ✗，温和不批判 */
export function FeedbackBubble({ verdict, text }: { verdict: 'correct' | 'wrong'; text: string }) {
  const reduced = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  const isCorrect = verdict === 'correct';
  const tone = isCorrect
    ? 'border-brand/35 bg-brand-tint text-brand'
    : 'border-brand-danger/35 bg-brand-danger/10 text-brand-danger';
  const badgeTone = isCorrect ? 'bg-brand' : 'bg-brand-danger';

  if (reduced) {
    return (
      <div className={cn('mx-auto flex w-fit max-w-[86%] items-center gap-2 rounded-full border px-4 py-2 text-[13px] font-medium', tone)}>
        <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-paper', badgeTone)}>
          {isCorrect ? '✓' : '✗'}
        </span>
        {text}
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{
        opacity: 1,
        scale: 1,
        rotate: isCorrect ? [0, 2, -2, 0] : 0,
        x: isCorrect ? 0 : [0, -4, 4, -2, 0],
      }}
      transition={{
        scale: { type: 'spring', stiffness: 320, damping: 18 },
        opacity: { duration: 0.22 },
        rotate: { duration: 0.42, ease: 'easeInOut' },
        x: { duration: 0.42, ease: 'easeInOut' },
      }}
      className={cn('mx-auto flex w-fit max-w-[86%] items-center gap-2 rounded-full border px-4 py-2 text-[13px] font-medium', tone)}
    >
      <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-paper', badgeTone)}>
        {isCorrect ? '✓' : '✗'}
      </span>
      {text}
    </motion.div>
  );
}

/** 幕后协商折叠卡 */
export function BackstageCard({ notes }: { notes: BackstageNote[] }) {
  const [open, setOpen] = useState(false);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="mx-auto w-full max-w-[520px]"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-center gap-2 rounded-[10px] border border-dashed border-hairline bg-paper-deep/70 px-3 py-2 font-mono text-[11px] text-ink-muted transition-colors hover:border-brand/40 hover:text-brand"
      >
        <Settings2 size={12} className={cn('transition-transform duration-300', open && 'rotate-90')} />
        ⚙ 多智能体幕后协商 · {notes.length} 条消息
        <ChevronDown size={12} className={cn('transition-transform duration-200', open && 'rotate-180')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-1.5 space-y-1.5 rounded-[10px] border border-dashed border-hairline bg-paper-deep/70 p-3">
              {notes.map((note, i) => {
                const agent = getAgent(note.agent);
                return (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.1 * i }}
                    className="flex items-start gap-2 font-mono text-[11.5px] leading-[18px]"
                  >
                    <span
                      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: agent.color }}
                    />
                    <span className="shrink-0 font-medium" style={{ color: agent.color }}>
                      {note.agent}：
                    </span>
                    <span className="text-ink-2">{withTraceBadges(note.content)}</span>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

const letters = ['A', 'B', 'C', 'D'];

/** 答题卡气泡：跟随当前问题出现在对话流末尾（作答后消失） */
export function AnswerCard({
  options,
  onPick,
}: {
  options: TutorOption[];
  onPick: (o: TutorOption) => void;
}) {
  return (
    <motion.div
      initial={{ scale: 0.96, opacity: 0, y: 10 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ type: 'spring', stiffness: 260, damping: 22 }}
      className="ml-12 max-w-[86%] rounded-[14px] border border-brand/25 bg-card-warm p-4 shadow-xs"
    >
      <div className="lf-mono-label flex items-center gap-1.5 !text-[10px]">
        <ListChecks size={12} className="text-brand" /> 选择你的回答 · QUICK REPLY
      </div>
      <div className="mt-2.5 space-y-2">
        {options.map((o, i) => (
          <motion.button
            key={o.label}
            type="button"
            whileTap={{ scale: 0.985 }}
            onClick={() => onPick(o)}
            className="group flex w-full items-center gap-3 rounded-[10px] border border-hairline bg-paper px-3.5 py-2.5 text-left text-[13.5px] text-ink-2 transition-all duration-200 hover:border-brand/50 hover:bg-brand-tint/40 hover:text-ink"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-hairline font-mono text-[11px] font-semibold text-brand transition-colors group-hover:border-brand group-hover:bg-brand group-hover:text-paper">
              {letters[i]}
            </span>
            <span className="flex-1 leading-[20px]">{o.label}</span>
          </motion.button>
        ))}
      </div>
      <p className="mt-2 font-mono text-[10px] text-ink-muted">也可在下方输入框自由作答</p>
    </motion.div>
  );
}

/** ARB-05 决策仲裁 loading 行 */
export function ArbitrateRow() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex items-center justify-center gap-2 font-mono text-[11.5px] text-agent-arb"
    >
      <motion.span
        className="h-2 w-2 rounded-full bg-agent-arb"
        animate={{ scale: [1, 1.4, 1], opacity: [0.5, 1, 0.5] }}
        transition={{ duration: 0.8, repeat: Infinity }}
      />
      ARB-05 决策仲裁中…
    </motion.div>
  );
}
