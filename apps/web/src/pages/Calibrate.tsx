/**
 * 画像校准 `/me/calibrate` — 用建档时的例题重新评估六维能力。
 * 复用 onboarding 的题目库与诊断接口：取出画像建立时的例题让用户重做，
 * 完成后 diagnose → 回写六维分数 / 盲区 / 目标描述，并提升画像置信度。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import { ArrowLeft, Brain, Check, HelpCircle, Loader2, Sparkles } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { api } from '@/lib/api';
import type { OnboardingMeta, OnboardingQuestion, OnboardingAnswerInput, OnboardingDiagnoseResponse } from '@/lib/api';
import { abilityName, abilityOrderForTarget } from '@/data/abilityDimensions';
import { cn } from '@/lib/utils';

type AnswerResult = 'correct' | 'wrong' | 'uncertain';
type Attribution = 'guess' | 'concept' | 'careless';

interface AnswerRecord {
  q: OnboardingQuestion;
  result: AnswerResult;
  attribution?: Attribution;
  reason?: string;
}

const clampScore = (n: number) => Math.max(20, Math.min(92, Math.round(n)));

/** 当前画像分数 → 五档自评（与建档 selfScoreOf 互逆：20/35/50/65/80） */
function levelFromScore(score: number | undefined): number {
  return Math.max(0, Math.min(4, Math.round(((score ?? 50) - 20) / 15)));
}

export default function Calibrate() {
  const navigate = useNavigate();
  const { currentLearner, patchLearner } = useProfile();
  const [meta, setMeta] = useState<OnboardingMeta | null>(null);
  const [targetOptions, setTargetOptions] = useState<{ name: string; categoryCode: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [queue, setQueue] = useState<{ q: OnboardingQuestion }[]>([]);
  const [answers, setAnswers] = useState<AnswerRecord[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  const [pickedFor, setPickedFor] = useState<string | null>(null);
  const [pendingWrong, setPendingWrong] = useState<AnswerRecord | null>(null);
  const [agentLine, setAgentLine] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<OnboardingDiagnoseResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getOnboardingMeta(), api.listTargetOptions()])
      .then(([loadedMeta, options]) => {
        if (cancelled) return;
        setMeta(loadedMeta);
        setTargetOptions(options.map((option) => ({ name: option.name, categoryCode: option.categoryCode })));
        /* 与建档一致：每个维度取一道基础例题，按目标岗位优先级排序 */
        const ordered = [...loadedMeta.knowledgePoints]
          .sort(
            (a, b) =>
              abilityOrderForTarget(currentLearner.targetJob || 'Agent工程师').indexOf(a.id) -
              abilityOrderForTarget(currentLearner.targetJob || 'Agent工程师').indexOf(b.id),
          );
        const baseQueue = ordered
          .map((kp) => loadedMeta.questions.filter((q) => q.kpId === kp.id).find((q) => q.level === 'basic')
            ?? loadedMeta.questions.filter((q) => q.kpId === kp.id)[0])
          .filter((q): q is OnboardingQuestion => Boolean(q));
        setQueue(baseQueue.map((q) => ({ q })));
        setLoading(false);
      })
      .catch((reason) => {
        if (cancelled) return;
        setLoadError(reason instanceof Error ? reason.message : '题目加载失败');
        setLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 画像当前分数作为自评先验（建档后画像未保存自评档位，用分数反推五档） */
  const selfLevels = useMemo(() => {
    const out: Record<string, number> = {};
    (meta?.knowledgePoints ?? []).forEach((kp) => {
      out[kp.id] = levelFromScore(currentLearner.scores[kp.id]);
    });
    return out;
  }, [meta, currentLearner.scores]);

  const current = queue[answers.length];

  const toBackendAnswer = (a: AnswerRecord): OnboardingAnswerInput => ({
    questionId: a.q.id,
    result: a.result,
    attribution: a.attribution ?? null,
    reason: a.reason ?? null,
  });

  const commitAnswer = async (rec: AnswerRecord) => {
    const nextAnswers = [...answers, rec];
    setAnswers(nextAnswers);
    setPicked(null);
    setPickedFor(null);
    setPendingWrong(null);
    try {
      const response = await api.answerOnboarding({
        tag: currentLearner.tag,
        education: currentLearner.education || '在校学生',
        targetJob: currentLearner.targetJob || '',
        selfLevels,
        answers: nextAnswers.map(toBackendAnswer),
        queueIds: queue.map((item) => item.q.id),
      });
      setAgentLine(response.comment);
    } catch {
      setAgentLine('诊断服务暂不可用，答案已记录，仍可继续完成校准');
    }
  };

  const answer = (optIndex: number | 'uncertain') => {
    if (!current || picked !== null || pendingWrong) return;
    const q = current.q;
    const record: AnswerRecord = {
      q,
      result: optIndex === 'uncertain' ? 'uncertain' : optIndex === q.answerIndex ? 'correct' : 'wrong',
      reason: undefined,
    };
    if (optIndex !== 'uncertain') {
      setPicked(optIndex as number);
      setPickedFor(q.id);
      if (record.result === 'wrong') {
        /* 答错 → 先归因追问（可跳过），再提交 */
        setTimeout(() => setPendingWrong(record), 700);
      } else {
        setTimeout(() => void commitAnswer(record), 700);
      }
    } else {
      setTimeout(() => void commitAnswer(record), 100);
    }
  };

  const attribute = (attr: Attribution | null) => {
    if (!pendingWrong) return;
    void commitAnswer({ ...pendingWrong, attribution: attr ?? undefined });
  };

  const runDiagnose = async () => {
    if (!meta || !currentLearner.id || submitting) return;
    setSubmitting(true);
    try {
      const option = targetOptions.find((item) => item.name === currentLearner.targetJob);
      const diag = await api.diagnoseOnboarding({
        tag: currentLearner.tag,
        education: currentLearner.education || '在校学生',
        targetJob: currentLearner.targetJob || '',
        targetCategoryCode: option?.categoryCode ?? 'JOB',
        selfLevels,
        answers: answers.map(toBackendAnswer),
      });
      try {
        await patchLearner(
          currentLearner.id,
          {
            scores: diag.scores,
            goal: diag.goal || currentLearner.goal,
            blindSpots: diag.blindSpots.length ? diag.blindSpots : currentLearner.blindSpots,
          },
          {
            week: '校准',
            kind: 'writeback',
            title: '真实练习校准画像',
            detail: `重做 ${answers.length} 道画像例题后更新六维能力`,
          },
        );
      } catch {
        toast.error('画像写入失败', { description: '测评已完成，但画像更新时出错，请稍后重试。' });
      }
      setResult(diag);
    } catch {
      toast.error('校准测评失败', { description: '请稍后重试' });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-[760px] items-center justify-center px-5">
        <div className="flex items-center gap-2 text-[13px] text-ink-muted">
          <Loader2 size={17} className="animate-spin" />正在取出画像例题…
        </div>
      </div>
    );
  }

  if (loadError || !meta) {
    return (
      <div className="mx-auto max-w-[760px] px-5 py-16 text-center">
        <h1 className="font-serif text-[22px] font-semibold text-ink">校准题目暂时加载失败</h1>
        <p className="mt-2 text-[13px] text-brand-danger">{loadError || '未知错误'}</p>
        <Link to="/me/profile" className="lf-btn-primary mt-5 inline-flex">返回我的画像</Link>
      </div>
    );
  }

  if (result) {
    const dims = meta.knowledgePoints.map((kp) => ({
      id: kp.id,
      name: abilityName(kp.id, kp.name),
      score: clampScore(result.scores[kp.id] ?? 50),
      before: clampScore(currentLearner.scores[kp.id] ?? 50),
    }));
    return (
      <div className="mx-auto max-w-[760px] px-5 pb-24 pt-8 md:px-6">
        <Link to="/me/profile" className="inline-flex items-center gap-1 text-[13px] text-ink-muted hover:text-brand">
          <ArrowLeft size={14} />返回我的画像
        </Link>
        <div className="lf-card mt-4 p-6 md:p-8">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-tint text-brand"><Sparkles size={20} /></span>
            <div className="min-w-0 flex-1">
              <div className="lf-mono-label">CALIBRATION DONE</div>
              <h1 className="mt-1 font-serif text-[24px] font-semibold text-ink">校准完成，六维能力已更新</h1>
              <p className="mt-1.5 text-[13px] leading-6 text-ink-muted">{result.diagnosisSummary || '已按本次作答重新评估你的六维能力。'}</p>
            </div>
          </div>
          <div className="mt-6 grid gap-2.5">
            {dims.map((dim) => {
              const delta = dim.score - dim.before;
              return (
                <div key={dim.id} className="flex items-center gap-3 rounded-[12px] border border-hairline bg-paper px-4 py-3">
                  <span className="w-20 shrink-0 text-[13px] font-medium text-ink">{dim.name}</span>
                  <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-paper-deep">
                    <div className="h-full rounded-full bg-brand transition-all duration-700" style={{ width: `${dim.score}%` }} />
                  </div>
                  <span className="w-24 shrink-0 text-right font-mono text-[12px] text-ink-2">
                    {dim.before} → <strong className="text-brand">{dim.score}</strong>
                  </span>
                  {delta !== 0 && (
                    <span className={cn('w-12 shrink-0 text-right font-mono text-[11px]', delta > 0 ? 'text-brand-success' : 'text-brand-danger')}>
                      {delta > 0 ? `+${delta}` : delta}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-5 flex items-center justify-between rounded-[12px] border border-brand/20 bg-brand-tint/40 px-4 py-3">
            <span className="text-[12.5px] text-ink-2">本次测评平均置信度</span>
            <span className="font-mono text-[14px] font-semibold text-brand">{Math.round(result.averageConfidence)}%</span>
          </div>
          <div className="mt-6 flex flex-wrap gap-2.5">
            <button type="button" onClick={() => navigate('/me/profile')} className="lf-btn-primary !py-2.5">查看更新后的画像</button>
            <Link to="/me" className="lf-btn-ghost !py-2.5">回到我的学习</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[760px] px-5 pb-24 pt-8 md:px-6">
      <Link to="/me/profile" className="inline-flex items-center gap-1 text-[13px] text-ink-muted hover:text-brand">
        <ArrowLeft size={14} />返回我的画像
      </Link>
      <div className="mt-4 flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-tint text-brand"><Brain size={20} /></span>
        <div className="min-w-0 flex-1">
          <div className="lf-mono-label">PROFILE CALIBRATION</div>
          <h1 className="mt-1 font-serif text-[24px] font-semibold text-ink">用真实练习校准画像</h1>
          <p className="mt-1 text-[13px] leading-6 text-ink-muted">
            这些是建档时出过的例题，共 {queue.length} 道。按真实水平作答，完成后会用结果重新评估六维能力并更新画像。
          </p>
        </div>
      </div>

      {current ? (
        <div className="lf-card mt-6 p-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="lf-chip !py-1 text-[12px]">
              {abilityName(current.q.kpId, meta.knowledgePoints.find((kp) => kp.id === current.q.kpId)?.name ?? '综合能力')}
            </span>
            <span className="font-mono text-[11px] text-ink-muted">
              第 {answers.length + 1} / {queue.length} 题 · {current.q.level === 'basic' ? '基础' : current.q.level === 'advanced' ? '进阶' : '挑战'}
            </span>
          </div>
          <p className="text-[15px] font-medium leading-[24px] text-ink">{current.q.stem}</p>
          <div className="mt-4 space-y-2">
            {current.q.options.map((opt, i) => {
              const isPicked = picked === i && pickedFor === current.q.id;
              const isAnswer = i === current.q.answerIndex;
              const show = (picked !== null && pickedFor === current.q.id) || pendingWrong !== null;
              return (
                <button
                  key={i}
                  type="button"
                  disabled={picked !== null || pendingWrong !== null}
                  onClick={() => answer(i)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-[10px] border px-3.5 py-2.5 text-left text-[13.5px] transition-all',
                    show && isAnswer && 'border-brand-success/60 bg-brand-success/10 text-ink',
                    show && isPicked && !isAnswer && 'border-brand-danger/60 bg-brand-danger/10 text-ink',
                    !show && 'border-hairline bg-paper text-ink-2 hover:border-brand/40 hover:bg-brand-tint/40',
                    show && !isAnswer && !isPicked && 'border-hairline bg-paper text-ink-muted',
                  )}
                >
                  <span className="font-mono text-[12px] text-ink-muted">{String.fromCharCode(65 + i)}</span>
                  {opt}
                </button>
              );
            })}
            {picked === null && pendingWrong === null && (
              <button
                type="button"
                onClick={() => answer('uncertain')}
                className="flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-ink-muted/40 px-3.5 py-2 text-[12.5px] font-medium text-ink-muted transition-all hover:border-brand-amber/60 hover:text-ochre"
              >
                <HelpCircle size={13} />
                不确定，跳过这题（诚实也是有效信号）
              </button>
            )}
          </div>

          <AnimatePresence>
            {pendingWrong && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="mt-3 rounded-[10px] border border-brand-amber/40 bg-brand-amber-tint/60 p-3">
                  <div className="text-[12.5px] font-medium text-ink">伴学助手追问：这道为什么错？（帮我判断更准）</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {([
                      ['guess', '我是猜的'],
                      ['concept', '概念混了'],
                      ['careless', '粗心看错'],
                    ] as [Attribution, string][]).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => attribute(key)}
                        className="rounded-lg border border-ochre/40 bg-paper px-2.5 py-1 text-[12px] font-medium text-ochre transition-all hover:bg-ochre-tint"
                      >
                        {label}
                      </button>
                    ))}
                    <button type="button" onClick={() => attribute(null)} className="rounded-lg px-2.5 py-1 text-[12px] text-ink-muted hover:text-ink">
                      跳过
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {agentLine && (
            <div className="mt-4 rounded-[12px] border border-brand/20 bg-brand-tint/40 px-4 py-3 text-[12.5px] leading-6 text-ink-2">
              {agentLine}
            </div>
          )}
        </div>
      ) : (
        <div className="lf-card mt-6 flex flex-col items-center gap-3 p-8 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-tint text-brand"><Check size={22} /></span>
          <p className="text-[14px] text-ink-2">{answers.length} 题已答完，可以出结果了。</p>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void runDiagnose()}
            className="lf-btn-primary !py-2.5 disabled:opacity-60"
          >
            {submitting ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {submitting ? '正在重新评估六维能力…' : '完成校准并更新画像'}
          </button>
        </div>
      )}

      <div className="mt-5">
        <div className="mb-1.5 flex items-center justify-between text-[12px]">
          <span className="text-ink-muted">进度</span>
          <span className="font-mono font-semibold text-brand">{answers.length} / {queue.length}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-paper-deep">
          <div className="h-full rounded-full bg-brand transition-all duration-500" style={{ width: `${queue.length ? (answers.length / queue.length) * 100 : 0}%` }} />
        </div>
      </div>
    </div>
  );
}
