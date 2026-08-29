/**
 * QuizTab — 分阶测试题（resources.md TAB 3）
 * 基础 / 进阶 / 挑战 三阶 · 题卡内联判分（对错着色 + 解析卡 + KB 溯源）
 * sticky 结算条（正确率 + ARB-05 决策提示 + 去导学 CTA）
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Star, Lock, Check, X, ArrowRight, ChevronDown, Scale, BookX, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import TraceBadge from '@/components/TraceBadge';
import type { GeneratedResource } from '@/data/resources';
import { getQuizByIds, quizLevelMeta } from '@/data/quizBank';
import type { QuizLevel, QuizQuestion } from '@/data/quizBank';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import { useAgent } from '@/context/AgentContext';
import { useWrongBook } from '@/context/WrongBookContext';
import { useProfile, dataIdOf } from '@/context/ProfileContext';
import { bumpConfidence } from '@/data/confidence';
import { cn } from '@/lib/utils';

/** 答题进度持久化 key（按画像的资料底座 id 区分，隐私模式下读写失败静默兜底） */
const answersKey = (dataId: string) => `lf-quiz-answers:${dataId}`;

function readStoredAnswers(dataId: string): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(answersKey(dataId));
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeStoredAnswers(dataId: string, answers: Record<string, number>) {
  try {
    window.localStorage.setItem(answersKey(dataId), JSON.stringify(answers));
  } catch {
    /* 隐私模式等场景静默失败，不影响当次答题体验 */
  }
}

const letters = ['A', 'B', 'C', 'D'];
const tierOrder: QuizLevel[] = ['basic', 'advanced', 'challenge'];

/** 三阶难度分（演示口径，不代表真实心理测量学标定） */
const levelDifficulty: Record<QuizLevel, number> = { basic: 40, advanced: 65, challenge: 85 };

/** 「为什么考」——按掌握度与目标水平的差距生成一句话理由 */
function whyTested(score: number, target: number): string {
  if (score < target - 25) return '盲区补强';
  if (score >= target - 10) return '优势保持';
  return '巩固提升';
}

/** 适配度判定（演示口径）：题目难度分与该知识点掌握度的差值，粗略衡量这题对当前学习者难不难 */
function judgeFit(level: QuizLevel, score: number): { label: string; tone: 'fit' | 'hard' | 'easy' } {
  const diff = levelDifficulty[level] - score;
  if (Math.abs(diff) <= 15) return { label: '适配 ✓', tone: 'fit' };
  if (diff > 15) return { label: '偏难 ↑ 值得挑战', tone: 'hard' };
  return { label: '偏易 ↓ 可跳过', tone: 'easy' };
}

const fitTone: Record<'fit' | 'hard' | 'easy', string> = {
  fit: 'bg-brand/10 text-brand border-brand/30',
  hard: 'bg-brand-amber/15 text-ochre border-brand-amber/40',
  easy: 'bg-paper-deep text-ink-muted border-hairline',
};

function Stars({ n, color }: { n: number; color: string }) {
  return (
    <span className="flex items-center gap-0.5">
      {[1, 2, 3].map((i) => (
        <Star
          key={i}
          size={12}
          strokeWidth={0}
          fill={i <= n ? color : 'transparent'}
          stroke={color}
          className={i <= n ? '' : 'opacity-30'}
          style={{ stroke: color, strokeWidth: i <= n ? 0 : 1.5 }}
        />
      ))}
    </span>
  );
}

/** 单题卡 */
function QuestionCard({
  q,
  index,
  expanded,
  selected,
  learnerScore,
  onToggle,
  onAnswer,
  onNext,
  hasNext,
}: {
  q: QuizQuestion;
  index: number;
  expanded: boolean;
  selected: number | undefined;
  /** 该题所属知识点上，当前学习者的掌握度 0-100 */
  learnerScore: number;
  onToggle: () => void;
  onAnswer: (idx: number) => void;
  onNext: () => void;
  hasNext: boolean;
}) {
  const answered = selected !== undefined;
  const correct = answered && selected === q.answerIndex;
  const meta = quizLevelMeta[q.level];
  const kp = getKnowledgePoint(q.kpId);
  const fit = judgeFit(q.level, learnerScore);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 * index, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        'lf-card overflow-hidden transition-colors',
        answered && (correct ? 'border-brand/40' : 'border-brand-danger/40'),
      )}
    >
      {/* 题头 */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-5 py-4 text-left"
      >
        <span
          className={cn(
            'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg font-mono text-[11.5px] font-semibold',
            answered
              ? correct
                ? 'bg-brand text-paper'
                : 'bg-brand-danger text-paper'
              : 'bg-paper-deep text-ink-2',
          )}
        >
          {answered ? (correct ? <Check size={14} /> : <X size={14} />) : index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span
              className="rounded-md border px-1.5 py-px font-mono text-[10px] font-medium"
              style={{ color: meta.color, borderColor: `${meta.color}55`, backgroundColor: `${meta.color}0D` }}
            >
              {meta.label}
            </span>
            <Stars n={q.stars} color={meta.color} />
            <span className="font-mono text-[10.5px] text-ink-muted">{q.id}</span>
          </span>
          <span className="mt-1.5 block text-[14.5px] font-medium leading-[23px] text-ink">
            {q.stem}
          </span>
        </span>
        <ChevronDown
          size={16}
          className={cn('mt-1 shrink-0 text-ink-muted transition-transform duration-200', expanded && 'rotate-180')}
        />
      </button>

      {/* 展开：选项 + 解析 */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-2 px-5 pb-4">
              {/* 知识点映射条：这题为什么考、考的是哪个知识点、你现在什么水平 */}
              <div className="mb-1 flex flex-wrap items-center gap-1.5 rounded-[8px] bg-paper-deep/70 px-3 py-2 text-[12px] text-ink-2">
                <span className="font-medium text-brand">{kp.name}</span>
                <span className="text-ink-muted">·</span>
                <span>
                  你的掌握度 <span className="font-mono font-semibold text-ink tabular">{learnerScore}%</span>
                </span>
                <span className="text-ink-muted">·</span>
                <span className="text-ink-muted">{whyTested(learnerScore, kp.targetLevel)}</span>
              </div>
              {q.options.map((opt, oi) => {
                const isAnswer = oi === q.answerIndex;
                const isSelected = oi === selected;
                return (
                  <motion.button
                    key={oi}
                    type="button"
                    disabled={answered}
                    onClick={() => onAnswer(oi)}
                    whileTap={!answered ? { scale: 0.985 } : undefined}
                    animate={
                      answered && isSelected && !correct ? { x: [0, -3, 3, -2, 0] } : { x: 0 }
                    }
                    transition={{ duration: 0.35 }}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-[10px] border px-3.5 py-2.5 text-left text-[13.5px] transition-all duration-200',
                      !answered && 'border-hairline bg-paper hover:border-brand/45 hover:bg-brand-tint/40 cursor-pointer',
                      answered && isAnswer && 'border-brand bg-brand text-paper',
                      answered && isSelected && !isAnswer && 'border-brand-danger bg-brand-danger text-paper',
                      answered && !isAnswer && !isSelected && 'border-hairline bg-paper opacity-55',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] font-semibold transition-colors',
                        answered && (isAnswer || isSelected)
                          ? 'border-paper/60 text-paper'
                          : 'border-hairline text-ink-2',
                      )}
                    >
                      {letters[oi]}
                    </span>
                    <span className="flex-1 leading-[20px]">{opt}</span>
                    {answered && isAnswer && (
                      <motion.svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0">
                        <motion.path
                          d="M3 8.5 L6.5 12 L13 4.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          initial={{ pathLength: 0 }}
                          animate={{ pathLength: 1 }}
                          transition={{ duration: 0.3, delay: 0.1 }}
                        />
                      </motion.svg>
                    )}
                    {answered && isSelected && !isAnswer && <X size={15} className="shrink-0" />}
                  </motion.button>
                );
              })}

              {/* 判定 + 解析卡 */}
              <AnimatePresence>
                {answered && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 200, damping: 24 }}
                    className="overflow-hidden"
                  >
                    <div
                      className={cn(
                        'mt-2 rounded-[10px] border p-3.5',
                        correct ? 'border-brand/35 bg-brand-tint/60' : 'border-brand-danger/30 bg-brand-danger/[0.05]',
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={cn(
                            'rounded-md px-2 py-0.5 text-[12px] font-semibold',
                            correct ? 'bg-brand text-paper' : 'bg-brand-danger text-paper',
                          )}
                        >
                          {correct ? '回答正确' : '回答错误'}
                        </span>
                        <span className="rounded-md border border-hairline bg-paper px-1.5 py-0.5 font-mono text-[10.5px] text-ink-muted">
                          考点 · {getKnowledgePoint(q.kpId).name}
                        </span>
                        {q.kbRefs.map((id) => (
                          <TraceBadge key={id} kbId={id} />
                        ))}
                        {/* 适配度：这题难度分与你掌握度的差值判定，纯演示口径 */}
                        <span
                          className={cn(
                            'rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] font-medium',
                            fitTone[fit.tone],
                          )}
                        >
                          适配度 · {fit.label}
                        </span>
                        {!correct && (
                          <>
                            <span className="inline-flex items-center gap-1 rounded-md border border-brand-danger/30 bg-brand-danger/10 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-brand-danger">
                              <BookX size={11} /> 已存入错题本
                            </span>
                            <Link
                              to="/me/wrong"
                              className="font-mono text-[10.5px] font-medium text-brand hover:underline"
                            >
                              去错题本 →
                            </Link>
                          </>
                        )}
                      </div>
                      <p className="mt-2 text-[13px] leading-[21px] text-ink-2">{q.analysis}</p>
                      {hasNext && (
                        <button
                          type="button"
                          onClick={onNext}
                          className="mt-2.5 inline-flex items-center gap-1 text-[12.5px] font-medium text-brand hover:underline"
                        >
                          下一题 <ArrowRight size={13} />
                        </button>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default function QuizTab({
  resource,
  focusQid,
}: {
  resource: GeneratedResource;
  /** 深链聚焦题目 id（如错题本重练跳转 /resources?tab=quiz&focus=q-03），进页只生效一次 */
  focusQid?: string;
}) {
  const questions = useMemo(() => getQuizByIds(resource.quizIds ?? []), [resource.quizIds]);
  const { pushSignal } = useAgent();
  const { addWrong } = useWrongBook();
  const { currentLearner } = useProfile();
  const dataId = dataIdOf(currentLearner);

  const [answers, setAnswers] = useState<Record<string, number>>(() => readStoredAnswers(dataId));
  const [expandedId, setExpandedId] = useState<string | null>(() => {
    if (focusQid && questions.some((q) => q.id === focusQid)) return focusQid;
    return questions[0]?.id ?? null;
  });

  /* 画像（资料底座 id）变化 → 渲染期比对重置，改读新画像对应的持久化答题记录
     （参考 usePlayback 的 prevEvents 派生重置写法；QuizTab 目前随 currentLearner.id 整体 remount，
     这里额外兜底，防止未来去掉外层 key 后仍需正确随 dataId 切换） */
  const [prevDataId, setPrevDataId] = useState(dataId);
  if (prevDataId !== dataId) {
    setPrevDataId(dataId);
    setAnswers(readStoredAnswers(dataId));
  }

  /* 深链聚焦：进页只执行一次滚动定位（已展开态由上面的初始化函数处理） */
  useEffect(() => {
    if (!focusQid) return;
    if (!questions.some((q) => q.id === focusQid)) return;
    requestAnimationFrame(() => {
      document.getElementById(`quiz-${focusQid}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const answeredCount = Object.keys(answers).length;
  const correctCount = questions.filter((q) => answers[q.id] === q.answerIndex).length;
  const accuracy = answeredCount > 0 ? Math.round((correctCount / answeredCount) * 100) : 0;

  const tiers = useMemo(
    () =>
      tierOrder.map((level) => {
        const qs = questions.filter((q) => q.level === level);
        const done = qs.filter((q) => answers[q.id] !== undefined);
        const right = qs.filter((q) => answers[q.id] === q.answerIndex);
        return { level, qs, done: done.length, right: right.length };
      }),
    [questions, answers],
  );

  const answer = (q: QuizQuestion, idx: number) => {
    if (answers[q.id] !== undefined) return;
    const next = { ...answers, [q.id]: idx };
    setAnswers(next);
    writeStoredAnswers(dataId, next);
    const correct = idx === q.answerIndex;
    /* 上报伴学助手：每题即时进入信号流，3 题一结算 */
    pushSignal({ type: 'quiz-answer', kpId: q.kpId, level: q.level, correct });
    /* 每答一题都是一次画像校准证据（精简建档的低置信画像靠这个涨） */
    bumpConfidence(currentLearner.id);
    /* 答错入错题本（题面从 quizBank 取，这里只存 id） */
    if (!correct) addWrong({ qid: q.id, kpId: q.kpId, from: 'quiz', pick: idx });
  };

  const goNext = (q: QuizQuestion) => {
    const idx = questions.findIndex((x) => x.id === q.id);
    const next = questions[idx + 1];
    if (next) {
      setExpandedId(next.id);
      requestAnimationFrame(() => {
        document.getElementById(`quiz-${next.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  };

  const clearAnswers = () => {
    setAnswers({});
    try {
      window.localStorage.removeItem(answersKey(dataId));
    } catch {
      /* 隐私模式等场景静默失败 */
    }
    toast.success('已清空本轮答题记录', { description: '可以重新挑战了' });
  };

  return (
    <div className="pb-24">
      {/* 三阶概览 */}
      <div className="grid gap-3 sm:grid-cols-3">
        {tiers.map((t, i) => {
          const meta = quizLevelMeta[t.level];
          const complete = t.qs.length > 0 && t.done === t.qs.length;
          return (
            <motion.div
              key={t.level}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 * i, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              className="lf-card p-4"
            >
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-[14.5px] font-semibold text-ink">
                  {meta.label}阶
                  {t.level === 'challenge' && (
                    <span title="基础阶正确率 ≥ 60% 解锁（演示环境已解锁）">
                      <Lock size={13} className="text-ink-muted" />
                    </span>
                  )}
                </span>
                <Stars n={i + 1} color={meta.color} />
              </div>
              <div className="mt-1.5 flex items-center justify-between">
                <span className="font-mono text-[11.5px] text-ink-muted">{t.qs.length} 题</span>
                {complete ? (
                  <motion.span
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="rounded-md border border-brand/30 bg-brand-tint px-2 py-0.5 font-mono text-[11px] font-semibold text-brand tabular"
                  >
                    得分 {t.right}/{t.qs.length}
                  </motion.span>
                ) : (
                  <span className="font-mono text-[11px] text-ink-muted tabular">
                    {t.done}/{t.qs.length} 已答
                  </span>
                )}
              </div>
              {t.level === 'challenge' && (
                <p className="mt-2 border-t border-hairline pt-2 font-mono text-[10px] leading-[15px] text-ink-muted">
                  基础阶正确率 ≥ 60% 解锁（演示环境已解锁）
                </p>
              )}
            </motion.div>
          );
        })}
      </div>

      {/* 题目列表 */}
      <div className="mt-4 space-y-3">
        {questions.map((q, i) => (
          <div key={q.id} id={`quiz-${q.id}`} className="scroll-mt-24">
            <QuestionCard
              q={q}
              index={i}
              expanded={expandedId === q.id}
              selected={answers[q.id]}
              learnerScore={currentLearner.scores[q.kpId] ?? 50}
              onToggle={() => setExpandedId((v) => (v === q.id ? null : q.id))}
              onAnswer={(idx) => answer(q, idx)}
              onNext={() => goNext(q)}
              hasNext={i < questions.length - 1}
            />
          </div>
        ))}
      </div>

      {/* 结算条 */}
      <AnimatePresence>
        {answeredCount > 0 && (
          <motion.div
            initial={{ y: 90, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 90, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 200, damping: 24 }}
            className="sticky bottom-4 z-20 mt-6 rounded-[14px] border border-hairline bg-card-warm/95 p-4 shadow-warm-lg backdrop-blur"
          >
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <div className="font-mono text-[13px] text-ink-2 tabular">
                本轮 {answeredCount}/{questions.length} · 正确 {correctCount} · 正确率{' '}
                <span className={cn('font-semibold', accuracy >= 60 ? 'text-brand' : 'text-brand-danger')}>
                  {accuracy}%
                </span>
              </div>
              <div className="flex items-center gap-1.5 rounded-lg border border-hairline bg-paper px-2.5 py-1.5 text-[12px] text-ink-2">
                <Scale size={13} className="text-agent-arb" />
                <span>
                  <span className="font-mono text-[11px] text-agent-arb">ARB-05 建议：</span>
                  {accuracy >= 60
                    ? `正确率 ${accuracy}% ≥ 60% → 解锁「进阶挑战」`
                    : `正确率 ${accuracy}% < 60% → 建议降维复习讲义后重测`}
                </span>
              </div>
              <button
                type="button"
                onClick={clearAnswers}
                className="ml-auto inline-flex items-center gap-1.5 rounded-[10px] border border-hairline bg-paper px-3 py-2 text-[12.5px] font-medium text-ink-muted transition-colors hover:border-brand-danger/40 hover:text-brand-danger"
              >
                <RotateCcw size={13} /> 清空重做
              </button>
              <Link
                to="/tutoring"
                className="inline-flex items-center gap-1.5 rounded-[10px] bg-brand px-4 py-2 text-[13px] font-medium text-paper transition-colors hover:bg-brand-hover"
              >
                去导学巩固 <ArrowRight size={14} />
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
