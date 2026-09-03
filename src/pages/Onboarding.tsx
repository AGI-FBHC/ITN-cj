/**
 * Onboarding `/onboarding` — 画像初诊向导（面谈式 · 五步）
 * ① 背景采集（选择即初始化先验，伴学助手出声解释）
 * ② 自我评估（六维五档快评 → 弱先验 + 元认知对照素材）
 * ③ 理论自测（置信度驱动的自适应加测 6~14 题：每题点评 / 「不确定」/ 答错归因追问）
 * ④ AI 诊断（流式结论 + 自评 vs 实测对照 + 置信度标注）→ 直接建档，后续由学习信号持续校准
 *
 * 测量思路：先验（背景+自评）+ 少量高信息量题目（似然）= 带置信度的后验；
 * 题量不足不靠堆题解决，靠"测到确信为止 + 建档后持续回写"。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { Check, ChevronRight, ChevronLeft, Sparkles, Brain, HelpCircle, PlusCircle } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import type { LearnerDraft } from '@/context/ProfileContext';
import { knowledgePoints as localKnowledgePoints, getKnowledgePoint as localGetKnowledgePoint } from '@/data/knowledgePoints';
import { quizByKp as localQuizByKp } from '@/data/quizBank';
import { ReactECharts } from '@/components/ChartCard';
import Typewriter from '@/components/profiles/Typewriter';
import ProfileForge from '@/components/profiles/ProfileForge';
import type { ForgeData } from '@/components/profiles/ProfileForge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

/* ================= 选项与先验（与 /welcome 精简建档共用一套模型） ================= */
import { AVATARS, TAGS, EDU, JOBS, STYLES, priorOf, priorLine } from '@/data/priors';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import type { OnboardingMeta, OnboardingQuestion, OnboardingAnswerInput } from '@/lib/api';
import { ABILITY_SELF_PROMPTS, abilityName, abilityOrderForTarget } from '@/data/abilityDimensions';

const knowledgePoints = localKnowledgePoints.map((kp) => ({ ...kp, name: abilityName(kp.id, kp.name) }));

/* ================= 自评五档 ================= */
const SELF_LEVELS = ['未接触', '需要指导', '可独立完成', '能处理复杂情况', '能指导他人'];
const selfScoreOf = (level: number) => 20 + level * 15; // 20/35/50/65/80

const clampScore = (n: number) => Math.max(20, Math.min(92, Math.round(n)));

type AnswerResult = 'correct' | 'wrong' | 'uncertain';
type Attribution = 'guess' | 'concept' | 'careless';

interface AnswerRecord {
  q: OnboardingQuestion;
  result: AnswerResult;
  attribution?: Attribution;
  extra?: boolean;
  reason?: string;
}

/* ================= 雷达 ================= */
function radarOption(estimates: Record<string, number>, confidence?: Record<string, number>) {
  return {
    animationDuration: 500,
    radar: {
      indicator: knowledgePoints.map((kp) => {
        const c = confidence?.[kp.id] ?? 100;
        return { name: kp.name, max: 100, color: `rgba(70, 100, 80,${(0.3 + 0.7 * (c / 100)).toFixed(2)})` };
      }),
      radius: '64%',
      center: ['50%', '54%'] as [string, string],
      axisName: { fontSize: 11, fontFamily: '"Noto Sans SC", sans-serif' },
      splitLine: { lineStyle: { color: '#E9E3D4' } },
      splitArea: { areaStyle: { color: ['rgba(253,252,249,0)', 'rgba(240,235,224,0.5)'] } },
      axisLine: { lineStyle: { color: '#DCE6DE' } },
    },
    legend: { bottom: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8, data: ['当前估计', '目标要求'] },
    series: [
      {
        type: 'radar' as const,
        data: [
          {
            value: knowledgePoints.map((kp) => kp.targetLevel),
            name: '目标要求',
            symbol: 'none',
            lineStyle: { color: '#E7B45A', width: 1.5, type: 'dashed' as const },
            itemStyle: { color: '#E7B45A' },
            areaStyle: { color: 'rgba(231, 180, 90,0)' },
          },
          {
            value: knowledgePoints.map((kp) => estimates[kp.id] ?? 50),
            name: '当前估计',
            symbolSize: 4,
            lineStyle: { color: '#4E7860', width: 2.5 },
            itemStyle: { color: '#4E7860' },
            areaStyle: { color: 'rgba(78, 120, 96,0.24)' },
          },
        ],
      },
    ],
  };
}

const STEPS = ['背景', '自评', '理论自测', 'AI 诊断'];

export default function Onboarding() {
  const navigate = useNavigate();
  const { createLearner } = useProfile();
  const { session, bindAccount } = useAuth();
  const [step, setStep] = useState(0);

  const [meta, setMeta] = useState<OnboardingMeta | null>(null);
  useEffect(() => {
    api.getOnboardingMeta().then(setMeta).catch(() => {});
  }, []);
  const knowledgePoints = (meta?.knowledgePoints ?? localKnowledgePoints)
    .map((kp) => ({ ...kp, name: abilityName(kp.id, kp.name) }));
  const tags = meta?.tags ?? TAGS;
  const edu = meta?.edu ?? EDU;
  const targetOptions = meta?.targetOptions ?? [];
  const backendJobs = targetOptions.map((option) => option.name).filter((name) => JOBS.includes(name));
  const jobs = backendJobs.length > 1 ? backendJobs : JOBS;
  const styleOptions = meta?.styles ?? STYLES;
  const getKnowledgePoint = useCallback(
    (id: string) => knowledgePoints.find((kp) => kp.id === id) ?? localGetKnowledgePoint(id),
    [knowledgePoints],
  );
  const quizByKp = useCallback(
    (id: string) => meta?.questions.filter((q) => q.kpId === id) ?? localQuizByKp(id),
    [meta],
  );

  /* ---- ① 背景 ---- */
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [tag, setTag] = useState(TAGS[0]);
  const [education, setEducation] = useState(EDU[0]);
  const [targetJob, setTargetJob] = useState(JOBS[0]);
  const [targetCategoryCode, setTargetCategoryCode] = useState('JOB');
  const [weeklyHours, setWeeklyHours] = useState(10);
  const [styles, setStyles] = useState<string[]>([STYLES[0]]);
  const [addingStyle, setAddingStyle] = useState(false);

  /* ---- ② 自评（默认"了解"） ---- */
  const [selfLevels, setSelfLevels] = useState<Record<string, number>>(() =>
    Object.fromEntries(knowledgePoints.map((kp) => [kp.id, 2])),
  );

  /* ---- ③ 自测：动态题目队列 ---- */
  const baseQueue = useMemo(
    () =>
      [...knowledgePoints]
        .sort((a, b) => abilityOrderForTarget(targetJob).indexOf(a.id) - abilityOrderForTarget(targetJob).indexOf(b.id))
        .map((kp) => quizByKp(kp.id).find((q) => q.level === 'basic') ?? quizByKp(kp.id)[0])
        .filter((q): q is OnboardingQuestion => Boolean(q)),
    [knowledgePoints, quizByKp, targetJob],
  );
  const [queue, setQueue] = useState<{ q: OnboardingQuestion; extra?: boolean; reason?: string }[]>(() =>
    baseQueue.map((q) => ({ q })),
  );
  const [answers, setAnswers] = useState<AnswerRecord[]>([]);

  useEffect(() => {
    if (!meta || answers.length > 0 || baseQueue.length === 0) return;
    setQueue(baseQueue.map((q) => ({ q })));
    setSelfLevels((prev) => Object.fromEntries(meta.knowledgePoints.map((kp) => [kp.id, prev[kp.id] ?? 2])));
  }, [meta, answers.length, baseQueue]);
  const [picked, setPicked] = useState<number | null>(null);
  /** 记录选中序号属于哪道题：切题后旧选中不残留到下一题 */
  const [pickedFor, setPickedFor] = useState<string | null>(null);
  /** 答错后待归因：记录挂起，归因（或跳过）后才正式提交，避免题卡提前跳题 */
  const [pendingWrong, setPendingWrong] = useState<AnswerRecord | null>(null);
  const pendingAttr = pendingWrong !== null;
  const [agentLine, setAgentLine] = useState<string | null>(null);

  const current = queue[answers.length];
  const quizDone = answers.length >= queue.length;

  /* ---- 估计与置信度（先验 + 自评 + 作答，由后端持续更新） ---- */
  const [estimates, setEstimates] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      knowledgePoints.map((kp) => [
        kp.id,
        clampScore(50 + (priorOf(tag, education)[kp.id] ?? 0) + (selfScoreOf(selfLevels[kp.id] ?? 2) - 50) * 0.4),
      ]),
    ),
  );
  const [confidence, setConfidence] = useState<Record<string, number>>(() =>
    Object.fromEntries(knowledgePoints.map((kp) => [kp.id, 33])),
  );
  const [avgConf, setAvgConf] = useState(33);

  useEffect(() => {
    if (answers.length > 0) return;
    const nextEstimates = Object.fromEntries(
      knowledgePoints.map((kp) => [
        kp.id,
        clampScore(50 + (priorOf(tag, education)[kp.id] ?? 0) + (selfScoreOf(selfLevels[kp.id] ?? 2) - 50) * 0.4),
      ]),
    );
    setEstimates(nextEstimates);
    setAvgConf(33);
    setConfidence(Object.fromEntries(knowledgePoints.map((kp) => [kp.id, 33])));
  }, [tag, education, selfLevels, answers.length, knowledgePoints]);

  /* ---- 作答处理 ---- */
  const toBackendAnswer = (a: AnswerRecord): OnboardingAnswerInput => ({
    questionId: a.q.id,
    result: a.result,
    attribution: a.attribution ?? null,
    extra: a.extra,
    reason: a.reason ?? null,
  });

  /** 正式提交一条作答：后端负责评分、加测与伴学助手点评 */
  const commitAnswer = async (rec: AnswerRecord) => {
    const nextAnswers = [...answers, rec];
    setAnswers(nextAnswers);
    // 立即切题并清空选中状态（不等网络返回），防止旧序号残留到下一题
    setPicked(null);
    setPickedFor(null);
    setPendingWrong(null);
    try {
      const response = await api.answerOnboarding({
        tag,
        education,
        targetJob,
        selfLevels,
        answers: nextAnswers.map(toBackendAnswer),
        queueIds: queue.map((item) => item.q.id),
      });
      setEstimates(response.estimates);
      setConfidence(response.confidence);
      setAvgConf(response.averageConfidence);
      setAgentLine(response.comment);
      if (response.nextQuestion) {
        setQueue((prev) => [...prev, { q: response.nextQuestion!, extra: true, reason: response.nextReason ?? '' }]);
      }
    } catch {
      setAgentLine('诊断服务暂不可用，请稍后重试');
    }
  };

  const answer = (optIndex: number | 'uncertain') => {
    if (!current || picked !== null || pendingAttr) return;
    const q = current.q;
    const result: AnswerResult =
      optIndex === 'uncertain' ? 'uncertain' : optIndex === q.answerIndex ? 'correct' : 'wrong';
    if (optIndex !== 'uncertain') {
      setPicked(optIndex as number);
      setPickedFor(q.id);
    }

    const rec: AnswerRecord = { q, result, extra: current.extra, reason: current.reason };
    if (result === 'wrong') {
      /* 答错 → 挂起，先归因追问（可跳过），期间题卡停在原题 */
      setTimeout(() => setPendingWrong(rec), 700);
    } else {
      setTimeout(() => commitAnswer(rec), optIndex === 'uncertain' ? 100 : 700);
    }
  };

  const attribute = (attr: Attribution | null) => {
    if (!pendingWrong) return;
    commitAnswer({ ...pendingWrong, attribution: attr ?? undefined });
  };

  const sorted = useMemo(
    () => knowledgePoints.map((kp) => ({ kp, s: estimates[kp.id] })).sort((a, b) => b.s - a.s),
    [estimates],
  );
  const strongest = sorted[0];
  const weakest = sorted[sorted.length - 1];

  /* 自评 vs 实测 最大偏差（诊断叙事用） */
  const biggestGap = useMemo(() => {
    let best: { kp: (typeof knowledgePoints)[0]; diff: number } | null = null;
    knowledgePoints.forEach((kp) => {
      const diff = selfScoreOf(selfLevels[kp.id] ?? 2) - (estimates[kp.id] ?? 50);
      if (!best || Math.abs(diff) > Math.abs(best.diff)) best = { kp, diff };
    });
    return best!;
  }, [selfLevels, estimates]);

  const diagnosis = useMemo(() => {
    const gapText =
      Math.abs(biggestGap.diff) >= 10
        ? biggestGap.diff > 0
          ? `值得注意：你在「${biggestGap.kp.name}」上自评比实测高约 ${Math.round(biggestGap.diff)} 分，存在高估——这类"以为会了"恰恰是最危险的盲区。`
          : `有个好消息：你在「${biggestGap.kp.name}」上比自己以为的强约 ${Math.round(-biggestGap.diff)} 分，可以更自信。`
        : '你的自评和实测基本一致，元认知很准。';
    return (
      `初诊完成。综合背景先验、自评与 ${answers.length} 题作答：最强「${strongest?.kp.name}」约 ${strongest?.s} 分，` +
      `最弱「${weakest?.kp.name}」约 ${weakest?.s} 分。${gapText}` +
      `本画像为初稿（平均置信度 ${avgConf}%），之后你每一次答题、阅读、实操，我都会继续校准它。`
    );
  }, [strongest, weakest, biggestGap, answers.length, avgConf]);

  const defaultBlindIds = useMemo(
    () => knowledgePoints.filter((kp) => estimates[kp.id] < kp.targetLevel - 8).map((kp) => kp.id),
    [estimates],
  );

  const pickTarget = (name: string) => {
    setTargetJob(name);
    const option = targetOptions.find((item) => item.name === name);
    if (option) setTargetCategoryCode(option.categoryCode);
  };

  const toggleStyle = (s: string) =>
    setStyles((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  /** 建档锻造特效：createLearner 之后先播生成过程，播完再进主页 */
  const [forge, setForge] = useState<ForgeData | null>(null);

  const submit = async () => {
    if (forge) return;
    try {
      const diag = await api.diagnoseOnboarding({
        tag,
        education,
        targetJob,
        targetCategoryCode,
        selfLevels,
        answers: answers.map(toBackendAnswer),
      });
      const scores = diag.scores;
      const finalGoal = diag.goal;
      const finalBlindSpots = diag.blindSpots.length
        ? diag.blindSpots
        : defaultBlindIds.map((id) => getKnowledgePoint(id).name);
      const draft: LearnerDraft = {
        name: name.trim() || '我',
        avatar,
        tag,
        role: `${education} · ${tag}`,
        education,
        targetJob,
        weeklyHours,
        learningStyle: styles,
        scores,
        blindSpots: finalBlindSpots,
        goal: finalGoal,
        diagnosisSummary: diag.diagnosisSummary,
      };
      let id: string;
      try {
        id = await createLearner(draft, { method: 'full', value: diag.averageConfidence });
        if (session) bindAccount(id);
      } catch {
        toast.error('建档失败', { description: '请稍后重试' });
        return;
      }
      void api.prewarmPersonalizedLearningUnits(id).catch(() => undefined);
      setForge({
        name: draft.name,
        avatar: draft.avatar,
        scores,
        confidence: diag.averageConfidence,
        method: 'full',
        evidence: [
          `身份「${tag}」· ${education}`,
          '六维自评完成',
          `理论自测 ${answers.length} 题`,
          `目标「${targetJob}」`,
        ],
      });
    } catch {
      toast.error('精准诊断失败', { description: '请稍后重试' });
    }
  };
  const forgeDone = () => {
    toast.success(`「${forge?.name}」初稿画像已建档`, {
      description: `平均置信度 ${avgConf}% · 伴学助手将随你的学习持续校准`,
    });
    navigate('/me');
  };

  const canNext =
    step === 0 ? name.trim().length > 0 && styles.length > 0 : step === 2 ? quizDone : true;

  return (
    <div className="mx-auto max-w-[920px] px-5 pb-24 pt-8 md:px-6">
      {forge && <ProfileForge data={forge} onDone={forgeDone} />}
      {/* 步骤条 */}
      <div className="mb-8 flex items-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s} className="flex flex-1 items-center gap-2">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 font-mono text-[12px] font-semibold transition-all',
                  i < step ? 'border-brand bg-brand text-paper' : i === step ? 'border-brand text-brand' : 'border-hairline text-ink-muted',
                )}
              >
                {i < step ? <Check size={13} /> : i + 1}
              </span>
              <span className={cn('hidden text-[13px] font-medium sm:inline', i === step ? 'text-ink' : 'text-ink-muted')}>{s}</span>
            </div>
            {i < STEPS.length - 1 && <span className={cn('h-px flex-1', i < step ? 'bg-brand' : 'bg-hairline')} />}
          </div>
        ))}
      </div>

      {/* 纯进场动画（无 exit）：避免快速连点步骤时 AnimatePresence mode="wait" 的挂起竞态 */}
      <motion.div
        key={step}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      >
          {/* ============ ① 背景 ============ */}
          {step === 0 && (
            <div className="space-y-6">
              <div>
                <h1 className="font-serif text-[24px] font-semibold text-ink">先认识一下你</h1>
                <p className="mt-1 text-[14px] text-ink-muted">你的背景就是第一份证据——选择会直接初始化你的画像起点。</p>
              </div>

              <div className="lf-card space-y-5 p-6">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex gap-2">
                    {AVATARS.map((a) => (
                      <button
                        key={a}
                        type="button"
                        onClick={() => setAvatar(a)}
                        className={cn('rounded-full border-2 p-0.5 transition-all', avatar === a ? 'border-brand' : 'border-transparent hover:border-hairline')}
                      >
                        <Avatar className="h-11 w-11">
                          <AvatarImage src={a} />
                          <AvatarFallback>·</AvatarFallback>
                        </Avatar>
                      </button>
                    ))}
                  </div>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="你的名字 / 昵称"
                    className="h-10 flex-1 rounded-[10px] border border-hairline bg-paper px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-muted/70 focus:border-brand/50"
                  />
                </div>

                <ChipRow label="身份" options={tags} value={tag} onPick={setTag} />
                <ChipRow label="学历" options={edu} value={education} onPick={setEducation} />
                <ChipRow label="Agent 目标方向" options={jobs} value={targetJob} onPick={pickTarget} />

                <div>
                  <div className="lf-mono-label mb-2 !text-[11px]">学习偏好（可多选）</div>
                  <div className="flex flex-wrap gap-2">
                    {styleOptions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => toggleStyle(s)}
                        className={cn(
                          'rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-all',
                          styles.includes(s) ? 'border-brand bg-brand-tint text-brand' : 'border-hairline bg-paper text-ink-2 hover:border-brand/40',
                        )}
                      >
                        {styles.includes(s) && <Check size={12} className="mr-1 inline" />}
                        {s}
                      </button>
                    ))}
                    {styles
                      .filter((s) => !styleOptions.includes(s))
                      .map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => toggleStyle(s)}
                          title="点击移除"
                          className="rounded-lg border border-brand bg-brand-tint px-3 py-1.5 text-[13px] font-medium text-brand"
                        >
                          <Check size={12} className="mr-1 inline" />
                          {s}
                        </button>
                      ))}
                    {addingStyle ? (
                      <CustomChipInput
                        placeholder="你的学习习惯…"
                        onConfirm={(v) => {
                          if (!styles.includes(v)) setStyles((prev) => [...prev, v]);
                          setAddingStyle(false);
                        }}
                        onCancel={() => setAddingStyle(false)}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setAddingStyle(true)}
                        className="rounded-lg border border-dashed border-ink-muted/40 px-3 py-1.5 text-[13px] font-medium text-ink-muted transition-all hover:border-brand/50 hover:text-brand"
                      >
                        + 自己输入
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="lf-mono-label !text-[11px]">每周可投入</span>
                    <span className="font-mono text-[13px] font-semibold text-brand">{weeklyHours} 小时</span>
                  </div>
                  <input type="range" min={2} max={30} value={weeklyHours} onChange={(e) => setWeeklyHours(Number(e.target.value))} className="w-full accent-brand" />
                </div>
              </div>

              <DiaLine key={tag + education} text={priorLine(tag)} />
            </div>
          )}

          {/* ============ ② 自评 ============ */}
          {step === 1 && (
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-5">
                <div>
                  <h1 className="font-serif text-[24px] font-semibold text-ink">下面这些情况，你通常能做到哪一步？</h1>
                  <p className="mt-1 text-[14px] text-ink-muted">
                    根据真实经历快速作答。随后会用跨领域情境题校准，并据此评估六维能力。
                  </p>
                </div>
                <div className="lf-card space-y-4 p-5">
                  {knowledgePoints.map((kp) => (
                    <div key={kp.id}>
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-[13.5px] font-medium text-ink">{kp.name}</span>
                        <span className="font-mono text-[11px] text-brand">{SELF_LEVELS[selfLevels[kp.id] ?? 2]}</span>
                      </div>
                      <p className="mb-2 text-[12px] leading-[18px] text-ink-muted">
                        {ABILITY_SELF_PROMPTS[kp.id]}
                      </p>
                      <div className="grid grid-cols-5 gap-1">
                        {SELF_LEVELS.map((lv, li) => (
                          <button
                            key={lv}
                            type="button"
                            onClick={() => setSelfLevels((prev) => ({ ...prev, [kp.id]: li }))}
                            className={cn(
                              'rounded-md border px-1 py-1.5 text-[11px] font-medium transition-all',
                              (selfLevels[kp.id] ?? 2) === li
                                ? 'border-brand bg-brand-tint text-brand'
                                : 'border-hairline bg-paper text-ink-muted hover:border-brand/35',
                            )}
                          >
                            {lv}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <DiaLine text="都记下了。接下来我出题验证——如果你对自己的判断很准，说明元认知不错；有偏差也没关系，那正是我要找的。" />
              </div>
              <div className="lf-card h-fit p-5">
                <div className="lf-mono-label mb-1 !text-[11px]">起点雷达 · 背景先验 + 自评</div>
                <ReactECharts option={radarOption(estimates, confidence)} height={330} />
                <p className="mt-1 border-t border-hairline pt-2 text-[11px] leading-[16px] text-ink-muted">
                  标签越淡表示伴学助手对该维越不确定——答题会让它们变实。
                </p>
              </div>
            </div>
          )}

          {/* ============ ③ 理论自测（自适应） ============ */}
          {step === 2 && (
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-4">
                <div>
                  <h1 className="font-serif text-[24px] font-semibold text-ink">能力情境自测</h1>
                  <p className="mt-1 text-[14px] text-ink-muted">
                    题目来自智能体、LLM、RAG、工具调用与工程实践等领域；哪一维证据不足，伴学助手就继续加测。
                  </p>
                </div>

                {current ? (
                  <div className="lf-card p-6">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span className="lf-chip !py-1 text-[12px]">{getKnowledgePoint(current.q.kpId).name}</span>
                      <span className="font-mono text-[11px] text-ink-muted">
                        第 {answers.length + 1} / {queue.length} 题（动态） ·{' '}
                        {current.q.level === 'basic' ? '基础' : current.q.level === 'advanced' ? '进阶' : '挑战'}
                      </span>
                      {current.extra && (
                        <span className="rounded-md border border-brand-amber/50 bg-brand-amber-tint px-1.5 py-0.5 font-mono text-[10px] font-medium text-ochre">
                          加测 · {current.reason}
                        </span>
                      )}
                    </div>
                    <p className="text-[15px] font-medium leading-[24px] text-ink">{current.q.stem}</p>
                    <div className="mt-4 space-y-2">
                      {current.q.options.map((opt, i) => {
                        const isPicked = picked === i && pickedFor === current.q.id;
                        const isAnswer = i === current.q.answerIndex;
                        const show = (picked !== null && pickedFor === current.q.id) || pendingAttr;
                        return (
                          <button
                            key={i}
                            type="button"
                            disabled={picked !== null || pendingAttr}
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
                      {/* 「不确定」诚实按钮 */}
                      {picked === null && !pendingAttr && (
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

                    {/* 答错归因追问 */}
                    <AnimatePresence>
                      {pendingAttr && (
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
                              ] as [Attribution, string][]).map(([k, label]) => (
                                <button
                                  key={k}
                                  type="button"
                                  onClick={() => attribute(k)}
                                  className="rounded-lg border border-ochre/40 bg-paper px-2.5 py-1 text-[12px] font-medium text-ochre transition-all hover:bg-ochre-tint"
                                >
                                  {label}
                                </button>
                              ))}
                              <button
                                type="button"
                                onClick={() => attribute(null)}
                                className="rounded-lg px-2.5 py-1 text-[12px] text-ink-muted hover:text-ink"
                              >
                                跳过
                              </button>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                ) : (
                  <div className="lf-card flex flex-col items-center gap-3 p-8 text-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-tint text-brand">
                      <Check size={22} />
                    </span>
                    <p className="text-[14px] text-ink-2">
                      {answers.length} 题测完，各维置信度已足够——不用再加测了。
                    </p>
                  </div>
                )}

                {/* 伴学助手每题点评 */}
                {agentLine && <DiaLine key={agentLine} text={agentLine} />}

                <div>
                  <div className="mb-1.5 flex items-center justify-between text-[12px]">
                    <span className="text-ink-muted">平均置信度（驱动题量）</span>
                    <span className="font-mono font-semibold text-brand">{avgConf}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-paper-deep">
                    <div className="h-full rounded-full bg-brand transition-all duration-500" style={{ width: `${avgConf}%` }} />
                  </div>
                </div>
              </div>

              {/* 活雷达 */}
              <div className="lf-card h-fit p-5">
                <div className="lf-mono-label mb-1 !text-[11px]">LIVE · 画像实时校准</div>
                <ReactECharts option={radarOption(estimates, confidence)} height={340} />
                <p className="mt-1 border-t border-hairline pt-2 text-[11px] leading-[16px] text-ink-muted">
                  每答一题，估计与置信度同步更新；标签变实 = 伴学助手越来越确定。
                </p>
              </div>
            </div>
          )}

          {/* ============ ④ AI 诊断 ============ */}
          {step === 3 && (
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-4">
                <div>
                  <h1 className="font-serif text-[24px] font-semibold text-ink">伴学助手的初诊结论</h1>
                  <p className="mt-1 text-[14px] text-ink-muted">先验 + 自评 + {answers.length} 题作答的综合判断。</p>
                </div>
                <div className="lf-card p-5">
                  <div className="mb-3 flex items-center gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-brand text-paper">
                      <Brain size={16} />
                    </span>
                    <div>
                      <div className="text-[13.5px] font-semibold text-ink">伴学助手</div>
                      <div className="font-mono text-[10px] text-ink-muted">DIA-01 学情诊断</div>
                    </div>
                  </div>
                  <Typewriter text={diagnosis} className="text-[14px] leading-[24px] text-ink-2" />
                </div>

                {/* 自评 vs 实测 对照 */}
                <div className="lf-card p-5">
                  <div className="lf-mono-label mb-3 !text-[11px]">自评 vs 实测 · 元认知对照</div>
                  <div className="space-y-2.5">
                    {knowledgePoints.map((kp) => {
                      const self = selfScoreOf(selfLevels[kp.id] ?? 2);
                      const est = estimates[kp.id] ?? 50;
                      const over = self - est;
                      return (
                        <div key={kp.id}>
                          <div className="mb-1 flex items-center justify-between text-[11.5px]">
                            <span className="text-ink-2">{kp.name}</span>
                            <span
                              className={cn(
                                'font-mono font-medium',
                                Math.abs(over) < 8 ? 'text-ink-muted' : over > 0 ? 'text-brand-danger' : 'text-brand-success',
                              )}
                            >
                              {Math.abs(over) < 8 ? '基本一致' : over > 0 ? `高估 ${Math.round(over)}` : `低估 ${Math.round(-over)}`}
                            </span>
                          </div>
                          <div className="relative h-3 rounded-full bg-paper-deep">
                            <div className="absolute inset-y-0 left-0 rounded-full bg-brand/25" style={{ width: `${self}%` }} title={`自评 ${self}`} />
                            <div className="absolute inset-y-[3px] left-0 rounded-full bg-brand" style={{ width: `${est}%` }} title={`实测 ${est}`} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-2.5 flex items-center gap-4 border-t border-hairline pt-2 font-mono text-[10px] text-ink-muted">
                    <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-full bg-brand/25" />自评</span>
                    <span className="flex items-center gap-1.5"><span className="h-1.5 w-4 rounded-full bg-brand" />实测估计</span>
                  </div>
                </div>

              </div>
              <div className="lf-card h-fit p-5">
                <div className="lf-mono-label mb-1 !text-[11px]">初稿画像 · 平均置信度 {avgConf}%</div>
                <ReactECharts option={radarOption(estimates, confidence)} height={340} />
                <p className="mt-1 border-t border-hairline pt-2 text-[11px] leading-[16px] text-ink-muted">
                  这是初稿，不是判决——建档后每一次学习行为都会继续校准它。
                </p>
              </div>
            </div>
          )}

      </motion.div>

      {/* 底部导航 */}
      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={() => (step === 0 ? navigate('/me') : setStep((s) => s - 1))}
          className="lf-btn-ghost !px-4 !py-2 text-[13.5px]"
        >
          <ChevronLeft size={15} />
          {step === 0 ? '返回' : '上一步'}
        </button>

        {step < 3 ? (
          <button
            type="button"
            disabled={!canNext}
            onClick={() => setStep((s) => s + 1)}
            className={cn('lf-btn-primary', !canNext && 'cursor-not-allowed opacity-50')}
          >
            {step === 0 ? '去自评' : step === 1 ? '开始自测' : '生成诊断'}
            <ChevronRight size={15} />
          </button>
        ) : (
          <button type="button" onClick={submit} className="lf-btn-primary">
            <Sparkles size={15} />
            完成建档
          </button>
        )}
      </div>

      {/* 已有画像入口 */}
      {step === 0 && (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => navigate('/me/profile')}
            className="inline-flex items-center gap-1 text-[12.5px] text-ink-muted transition-colors hover:text-brand"
          >
            <PlusCircle size={13} />
            已经建过档？去「我的画像」查看
          </button>
        </div>
      )}
    </div>
  );
}

/* ---- 小组件 ---- */

/** 行内自定义输入（chip 组的兜底） */
function CustomChipInput({
  placeholder,
  onConfirm,
  onCancel,
}: {
  placeholder: string;
  onConfirm: (v: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const submit = async () => {
    const v = text.trim();
    if (v) onConfirm(v);
    else onCancel();
  };
  return (
    <span className="inline-flex items-center gap-1 rounded-lg border border-brand/45 bg-paper pl-2">
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onCancel();
        }}
        placeholder={placeholder}
        className="w-[150px] bg-transparent py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-muted/60"
      />
      <button
        type="button"
        onClick={submit}
        className="rounded-r-[7px] bg-brand px-2 py-1.5 text-[12px] font-medium text-paper hover:bg-brand-hover"
      >
        确定
      </button>
    </span>
  );
}

function ChipRow({
  label,
  options,
  value,
  onPick,
  customPlaceholder = '自己输入…',
}: {
  label: string;
  options: string[];
  value: string;
  onPick: (v: string) => void;
  customPlaceholder?: string;
}) {
  const [adding, setAdding] = useState(false);
  const customValue = value && !options.includes(value) ? value : null;
  return (
    <div>
      <div className="lf-mono-label mb-2 !text-[11px]">{label}</div>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onPick(o)}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-all',
              value === o ? 'border-brand bg-brand-tint text-brand' : 'border-hairline bg-paper text-ink-2 hover:border-brand/40',
            )}
          >
            {o}
          </button>
        ))}
        {customValue && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            title="点击重新输入"
            className="rounded-lg border border-brand bg-brand-tint px-3 py-1.5 text-[13px] font-medium text-brand"
          >
            <Check size={12} className="mr-1 inline" />
            {customValue}
          </button>
        )}
        {adding ? (
          <CustomChipInput
            placeholder={customPlaceholder}
            onConfirm={(v) => {
              onPick(v);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          !customValue && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="rounded-lg border border-dashed border-ink-muted/40 px-3 py-1.5 text-[13px] font-medium text-ink-muted transition-all hover:border-brand/50 hover:text-brand"
            >
              + 自己输入
            </button>
          )
        )}
      </div>
    </div>
  );
}

function DiaLine({ text }: { text: string }) {
  return (
    <div className="lf-anim-in-up flex items-start gap-3 rounded-[12px] border border-brand/20 bg-brand-tint/40 p-4">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-brand text-paper">
        <Brain size={16} />
      </span>
      <div>
        <div className="lf-mono-label !text-[10px]">伴学助手</div>
        <p className="mt-0.5 text-[13.5px] leading-[21px] text-ink-2">{text}</p>
      </div>
    </div>
  );
}
