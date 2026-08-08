/**
 * Onboarding `/onboarding` — 画像初诊向导（面谈式 · 五步）
 * ① 背景采集（选择即初始化先验，阿诊出声解释）
 * ② 自我评估（六维五档快评 → 弱先验 + 元认知对照素材）
 * ③ 理论自测（置信度驱动的自适应加测 6~14 题：每题点评 / 「不确定」/ 答错归因追问）
 * ④ AI 诊断（流式结论 + 自评 vs 实测对照 + 置信度标注）
 * ⑤ 确认建档（可微调，越权上调触发协商话术）→ 初稿画像，后续由学习信号持续校准
 *
 * 测量思路：先验（背景+自评）+ 少量高信息量题目（似然）= 带置信度的后验；
 * 题量不足不靠堆题解决，靠"测到确信为止 + 建档后持续回写"。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { Check, ChevronRight, ChevronLeft, Sparkles, Brain, Target, HelpCircle, PlusCircle } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import type { LearnerDraft } from '@/context/ProfileContext';
import { knowledgePoints, getKnowledgePoint } from '@/data/knowledgePoints';
import { quizByKp } from '@/data/quizBank';
import type { QuizLevel, QuizQuestion } from '@/data/quizBank';
import { ReactECharts } from '@/components/ChartCard';
import Typewriter from '@/components/profiles/Typewriter';
import ProfileForge from '@/components/profiles/ProfileForge';
import type { ForgeData } from '@/components/profiles/ProfileForge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

/* ================= 选项与先验（与 /welcome 精简建档共用一套模型） ================= */
import { AVATARS, TAGS, EDU, JOBS, STYLES, priorOf, priorLine } from '@/data/priors';
import { useAuth } from '@/context/AuthContext';

/* ================= 自评五档 ================= */
const SELF_LEVELS = ['完全不会', '听说过', '了解', '熟练', '精通'];
const selfScoreOf = (level: number) => 20 + level * 15; // 20/35/50/65/80

/* ================= 测量模型 ================= */
const clampScore = (n: number) => Math.max(20, Math.min(92, Math.round(n)));
const MAX_TOTAL = 14;
const MAX_EXTRA_PER_KP = 2;

type AnswerResult = 'correct' | 'wrong' | 'uncertain';
type Attribution = 'guess' | 'concept' | 'careless';

interface AnswerRecord {
  q: QuizQuestion;
  result: AnswerResult;
  attribution?: Attribution;
  /** 是否是加测题 */
  extra?: boolean;
  reason?: string;
}

function answerDelta(a: AnswerRecord): number {
  let d = 0;
  if (a.result === 'correct') d = a.q.level === 'basic' ? 10 : a.q.level === 'advanced' ? 14 : 18;
  else if (a.result === 'wrong') d = a.q.level === 'basic' ? -10 : -6;
  else d = -6; // uncertain
  if (a.attribution === 'concept') d -= 3;
  if (a.attribution === 'careless') d += 5;
  return d;
}

function confDelta(a: AnswerRecord): number {
  let c = a.result === 'uncertain' ? 8 : a.q.level === 'basic' ? 18 : 22;
  if (a.attribution) c += 4;
  return c;
}

/** 每题作答后阿诊的点评 */
function commentOf(a: AnswerRecord, est: number): string {
  const kp = getKnowledgePoint(a.q.kpId).name;
  const lv = a.q.level === 'basic' ? '基础' : a.q.level === 'advanced' ? '进阶' : '挑战';
  if (a.result === 'uncertain') return `诚实比蒙对更有用——「${kp}」我先按偏弱记，之后再核。`;
  if (a.result === 'correct')
    return a.q.level === 'basic'
      ? `「${kp}」基础题稳稳拿下，先标到 ${est}。`
      : `${lv}题也接住了，「${kp}」上调到 ${est}——不是新手水平。`;
  return a.attribution === 'careless'
    ? `粗心不算不会，「${kp}」我只轻微下调。`
    : a.attribution === 'concept'
      ? `概念混了是真盲区，「${kp}」标到 ${est}，讲义我会重点讲这块。`
      : `这道错得很典型，「${kp}」先标 ${est}——疑似盲区。`;
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
    legend: { bottom: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8, data: ['当前估计', '岗位目标'] },
    series: [
      {
        type: 'radar' as const,
        data: [
          {
            value: knowledgePoints.map((kp) => kp.targetLevel),
            name: '岗位目标',
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

const STEPS = ['背景', '自评', '理论自测', 'AI 诊断', '确认建档'];

export default function Onboarding() {
  const navigate = useNavigate();
  const { createLearner } = useProfile();
  const { session, bindAccount } = useAuth();
  const [step, setStep] = useState(0);

  /* ---- ① 背景 ---- */
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [tag, setTag] = useState(TAGS[0]);
  const [education, setEducation] = useState(EDU[0]);
  const [targetJob, setTargetJob] = useState(JOBS[0]);
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
      knowledgePoints
        .map((kp) => quizByKp(kp.id).find((q) => q.level === 'basic') ?? quizByKp(kp.id)[0])
        .filter((q): q is QuizQuestion => Boolean(q)),
    [],
  );
  const [queue, setQueue] = useState<{ q: QuizQuestion; extra?: boolean; reason?: string }[]>(() =>
    baseQueue.map((q) => ({ q })),
  );
  const [answers, setAnswers] = useState<AnswerRecord[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  /** 答错后待归因：记录挂起，归因（或跳过）后才正式提交，避免题卡提前跳题 */
  const [pendingWrong, setPendingWrong] = useState<AnswerRecord | null>(null);
  const pendingAttr = pendingWrong !== null;
  const [agentLine, setAgentLine] = useState<string | null>(null);

  const current = queue[answers.length];
  const quizDone = answers.length >= queue.length;

  /* ---- 估计与置信度（先验 + 自评 + 作答） ---- */
  const prior = useMemo(() => priorOf(tag, education), [tag, education]);

  const estimates = useMemo(() => {
    const e: Record<string, number> = {};
    knowledgePoints.forEach((kp) => {
      const self = (selfScoreOf(selfLevels[kp.id] ?? 2) - 50) * 0.4;
      e[kp.id] = clampScore(50 + (prior[kp.id] ?? 0) + self);
    });
    answers.forEach((a) => {
      e[a.q.kpId] = clampScore(e[a.q.kpId] + answerDelta(a));
    });
    return e;
  }, [prior, selfLevels, answers]);

  const confidence = useMemo(() => {
    const c: Record<string, number> = {};
    knowledgePoints.forEach((kp) => (c[kp.id] = 25 + 8)); // 背景 25 + 自评 8
    answers.forEach((a) => {
      c[a.q.kpId] = Math.min(92, (c[a.q.kpId] ?? 33) + confDelta(a));
    });
    return c;
  }, [answers]);

  const avgConf = Math.round(knowledgePoints.reduce((s, kp) => s + (confidence[kp.id] ?? 33), 0) / knowledgePoints.length);

  /* ---- 自适应加测决策 ---- */
  const maybeEnqueue = (a: AnswerRecord, curQueue: typeof queue): typeof queue => {
    if (curQueue.length >= MAX_TOTAL) return curQueue;
    const kpId = a.q.kpId;
    const extraCount = curQueue.filter((i) => i.extra && i.q.kpId === kpId).length;
    if (extraCount >= MAX_EXTRA_PER_KP) return curQueue;
    const used = new Set(curQueue.map((i) => i.q.id));
    const pool = quizByKp(kpId).filter((q) => !used.has(q.id));
    const pick = (lv: QuizLevel) => pool.find((q) => q.level === lv) ?? pool[0];
    const kp = getKnowledgePoint(kpId);

    let q: QuizQuestion | undefined;
    let reason = '';
    if (a.result === 'wrong' && !a.extra) {
      q = pick('basic');
      reason = `「${kp.name}」答错了，我再确认一道`;
    } else if (a.result === 'uncertain') {
      q = pick('basic');
      reason = `不确定没关系，「${kp.name}」换道题再试`;
    } else if (a.result === 'correct' && (selfLevels[kpId] ?? 2) >= 3 && !a.extra) {
      q = pick('advanced');
      reason = `你自评「${SELF_LEVELS[selfLevels[kpId]]}」，上道进阶题验证`;
    } else if (a.result === 'correct' && kp.weight >= 0.17 && !a.extra) {
      q = pick('advanced');
      reason = `这维对「${targetJob}」很重要，多测一题`;
    }
    if (!q) return curQueue;
    return [...curQueue, { q, extra: true, reason }];
  };

  /* ---- 作答处理 ---- */
  /** 正式提交一条作答：入列 + 决定加测 + 阿诊点评 */
  const commitAnswer = (rec: AnswerRecord) => {
    const estAfter = clampScore((estimates[rec.q.kpId] ?? 50) + answerDelta(rec));
    setAnswers((prev) => [...prev, rec]);
    setQueue((prevQ) => maybeEnqueue(rec, prevQ));
    setAgentLine(commentOf(rec, estAfter));
    setPicked(null);
    setPendingWrong(null);
  };

  const answer = (optIndex: number | 'uncertain') => {
    if (!current || picked !== null || pendingAttr) return;
    const q = current.q;
    const result: AnswerResult =
      optIndex === 'uncertain' ? 'uncertain' : optIndex === q.answerIndex ? 'correct' : 'wrong';
    if (optIndex !== 'uncertain') setPicked(optIndex as number);

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

  /* ---- ⑤ 微调 ---- */
  const [editScores, setEditScores] = useState<Record<string, number> | null>(null);
  const [blindIds, setBlindIds] = useState<string[] | null>(null);
  const [goal, setGoal] = useState('');

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

  /* 微调越权协商 */
  const negotiation = useMemo(() => {
    if (!editScores) return null;
    let worst: { kp: (typeof knowledgePoints)[0]; over: number } | null = null;
    knowledgePoints.forEach((kp) => {
      const over = (editScores[kp.id] ?? 50) - (estimates[kp.id] ?? 50);
      if (over > 8 && (!worst || over > worst.over)) worst = { kp, over };
    });
    if (!worst) return null;
    const w = worst as { kp: (typeof knowledgePoints)[0]; over: number };
    return `「${w.kp.name}」你调得比我测到的高 ${Math.round(w.over)} 分——先按你说的建档，但之后我会用两道题核实，谈不拢再谈。`;
  }, [editScores, estimates]);

  const toggleStyle = (s: string) =>
    setStyles((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const enterConfirm = () => {
    setEditScores({ ...estimates });
    setBlindIds([...defaultBlindIds]);
    setGoal(`3 个月内补齐「${weakest?.kp.name}」等短板，向「${targetJob}」岗位能力对齐。`);
    setStep(4);
  };

  /** 建档锻造特效：createLearner 之后先播生成过程，播完再进主页 */
  const [forge, setForge] = useState<ForgeData | null>(null);

  const submit = async () => {
    if (forge) return;
    const scores = editScores ?? estimates;
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
      blindSpots: (blindIds ?? defaultBlindIds).map((id) => getKnowledgePoint(id).name),
      goal,
    };
    let id: string;
    try {
      id = await createLearner(draft, { method: 'full', value: avgConf });
      if (session) bindAccount(id);
    } catch {
      toast.error('建档失败', { description: '请稍后重试' });
      return;
    }
    setForge({
      name: draft.name,
      avatar: draft.avatar,
      scores,
      confidence: avgConf,
      method: 'full',
      evidence: [
        `身份「${tag}」· ${education}`,
        '六维自评完成',
        `理论自测 ${answers.length} 题`,
        `目标「${targetJob}」`,
      ],
    });
  };

  const forgeDone = () => {
    toast.success(`「${forge?.name}」初稿画像已建档`, {
      description: `平均置信度 ${avgConf}% · 阿诊将随你的学习持续校准`,
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

                <ChipRow label="身份" options={TAGS} value={tag} onPick={setTag} />
                <ChipRow label="学历" options={EDU} value={education} onPick={setEducation} />
                <ChipRow label="目标岗位" options={JOBS} value={targetJob} onPick={setTargetJob} />

                <div>
                  <div className="lf-mono-label mb-2 !text-[11px]">学习偏好（可多选）</div>
                  <div className="flex flex-wrap gap-2">
                    {STYLES.map((s) => (
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
                      .filter((s) => !STYLES.includes(s))
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
                  <h1 className="font-serif text-[24px] font-semibold text-ink">你觉得自己什么水平？</h1>
                  <p className="mt-1 text-[14px] text-ink-muted">
                    30 秒快评。别担心不准——待会儿的题目会校准它，而且"自评 vs 实测"的差值本身就是重要诊断。
                  </p>
                </div>
                <div className="lf-card space-y-4 p-5">
                  {knowledgePoints.map((kp) => (
                    <div key={kp.id}>
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-[13.5px] font-medium text-ink">{kp.name}</span>
                        <span className="font-mono text-[11px] text-brand">{SELF_LEVELS[selfLevels[kp.id] ?? 2]}</span>
                      </div>
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
                  标签越淡表示阿诊对该维越不确定——答题会让它们变实。
                </p>
              </div>
            </div>
          )}

          {/* ============ ③ 理论自测（自适应） ============ */}
          {step === 2 && (
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-4">
                <div>
                  <h1 className="font-serif text-[24px] font-semibold text-ink">理论自测</h1>
                  <p className="mt-1 text-[14px] text-ink-muted">
                    题量不固定（6~{MAX_TOTAL} 题）：哪一维不确定，阿诊就在哪一维加测——测到确信为止。
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
                        const isPicked = picked === i;
                        const isAnswer = i === current.q.answerIndex;
                        const show = picked !== null || pendingAttr;
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
                            <div className="text-[12.5px] font-medium text-ink">阿诊追问：这道为什么错？（帮我判断更准）</div>
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
                      {answers.length} 题测完，各维置信度已达标——不用再加测了。
                    </p>
                  </div>
                )}

                {/* 阿诊每题点评 */}
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
                  每答一题，估计与置信度同步更新；标签变实 = 阿诊越来越确定。
                </p>
              </div>
            </div>
          )}

          {/* ============ ④ AI 诊断 ============ */}
          {step === 3 && (
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-4">
                <div>
                  <h1 className="font-serif text-[24px] font-semibold text-ink">阿诊的初诊结论</h1>
                  <p className="mt-1 text-[14px] text-ink-muted">先验 + 自评 + {answers.length} 题作答的综合判断。</p>
                </div>
                <div className="lf-card p-5">
                  <div className="mb-3 flex items-center gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-brand text-paper">
                      <Brain size={16} />
                    </span>
                    <div>
                      <div className="text-[13.5px] font-semibold text-ink">阿诊</div>
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

                <div className="lf-card p-5">
                  <div className="mb-2 flex items-center gap-2">
                    <Target size={15} className="text-ochre" />
                    <span className="text-[14px] font-semibold text-ink">锁定的优先盲区</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {defaultBlindIds.length ? (
                      defaultBlindIds.map((id) => (
                        <span key={id} className="rounded-lg border border-brand-danger/40 bg-brand-danger/10 px-2.5 py-1 text-[12.5px] font-medium text-brand-danger">
                          {getKnowledgePoint(id).name}
                        </span>
                      ))
                    ) : (
                      <span className="text-[13px] text-ink-muted">各维均接近目标，暂无高优先盲区。</span>
                    )}
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

          {/* ============ ⑤ 确认建档 ============ */}
          {step === 4 && editScores && blindIds && (
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-5">
                <div>
                  <h1 className="font-serif text-[24px] font-semibold text-ink">确认并微调</h1>
                  <p className="mt-1 text-[14px] text-ink-muted">你可以调整任一维度、增删盲区、修改目标，再建档。</p>
                </div>

                <div className="lf-card space-y-3 p-5">
                  <div className="lf-mono-label !text-[11px]">六维能力（可调 · 实测参考已标注）</div>
                  {knowledgePoints.map((kp) => (
                    <div key={kp.id}>
                      <div className="mb-1 flex items-center justify-between text-[12.5px]">
                        <span className="text-ink-2">{kp.name}</span>
                        <span className="font-mono">
                          <span className="font-semibold text-brand">{editScores[kp.id]}</span>
                          <span className="text-ink-muted"> / 实测 {estimates[kp.id]}</span>
                        </span>
                      </div>
                      <input
                        type="range"
                        min={20}
                        max={92}
                        value={editScores[kp.id]}
                        onChange={(e) => setEditScores((prev) => ({ ...prev!, [kp.id]: Number(e.target.value) }))}
                        className="w-full accent-brand"
                      />
                    </div>
                  ))}
                </div>

                {/* 越权协商 */}
                <AnimatePresence>
                  {negotiation && (
                    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                      <DiaLine text={negotiation} />
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="lf-card p-5">
                  <div className="lf-mono-label mb-2 !text-[11px]">盲区标签（点选增删）</div>
                  <div className="flex flex-wrap gap-2">
                    {knowledgePoints.map((kp) => {
                      const on = blindIds.includes(kp.id);
                      return (
                        <button
                          key={kp.id}
                          type="button"
                          onClick={() => setBlindIds((prev) => (prev!.includes(kp.id) ? prev!.filter((x) => x !== kp.id) : [...prev!, kp.id]))}
                          className={cn(
                            'rounded-lg border px-2.5 py-1 text-[12.5px] font-medium transition-all',
                            on ? 'border-brand-danger/50 bg-brand-danger/10 text-brand-danger' : 'border-hairline bg-paper text-ink-muted hover:border-brand/40',
                          )}
                        >
                          {kp.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="lf-card p-5">
                  <div className="lf-mono-label mb-2 !text-[11px]">学习目标</div>
                  <textarea
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    rows={3}
                    className="w-full resize-none rounded-[10px] border border-hairline bg-paper px-3 py-2 text-[13.5px] leading-[21px] text-ink outline-none focus:border-brand/50"
                  />
                </div>
              </div>

              <div className="lf-card h-fit p-5 lg:sticky lg:top-20">
                <div className="lf-mono-label mb-1 !text-[11px]">画像预览 · 初稿</div>
                <ReactECharts option={radarOption(editScores, confidence)} height={320} />
                <div className="mt-3 flex items-center gap-3 border-t border-hairline pt-3">
                  <Avatar className="h-10 w-10 border border-hairline">
                    <AvatarImage src={avatar} />
                    <AvatarFallback className="bg-brand-tint text-brand">{(name || '我').slice(0, 1)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="text-[14.5px] font-semibold text-ink">{name || '我'}</div>
                    <div className="truncate text-[12px] text-ink-muted">{tag} · {targetJob}</div>
                  </div>
                  <span className="ml-auto rounded-md border border-brand/30 bg-brand-tint px-1.5 py-0.5 font-mono text-[10px] text-brand">
                    置信 {avgConf}%
                  </span>
                </div>
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

        {step < 4 ? (
          <button
            type="button"
            disabled={!canNext}
            onClick={() => (step === 3 ? enterConfirm() : setStep((s) => s + 1))}
            className={cn('lf-btn-primary', !canNext && 'cursor-not-allowed opacity-50')}
          >
            {step === 0 ? '去自评' : step === 1 ? '开始自测' : step === 2 ? '生成诊断' : '去确认'}
            <ChevronRight size={15} />
          </button>
        ) : (
          <button type="button" onClick={submit} className="lf-btn-primary">
            <Sparkles size={15} />
            确认建档
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
        <div className="lf-mono-label !text-[10px]">阿诊 · DIA-01 学情诊断</div>
        <p className="mt-0.5 text-[13.5px] leading-[21px] text-ink-2">{text}</p>
      </div>
    </div>
  );
}
