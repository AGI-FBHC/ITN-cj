/**
 * Welcome `/welcome` — 登录后分流
 * 老用户（账号已绑画像）：欢迎回来卡（雷达缩略 + 上次学到哪 + 继续学习）
 * 新用户：建档方式二选一
 *   ⚡ 精简建档（约 30 秒）：称呼/身份 → 学历 → 目标方向，只用背景先验 → 置信度低，边学边校准
 *   🎯 精准定制（约 5 分钟）：跳转 /onboarding 五步初诊（自评 + 自适应测题）→ 建档即高置信
 */
import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  ArrowRight,
  Check,
  ChevronLeft,
  Gauge,
  Route,
  Sparkles,
  Target,
  UserRound,
  Zap,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useProfile } from '@/context/ProfileContext';
import { api } from '@/lib/api';
import type { OnboardingTargetCategory, OnboardingTargetOption } from '@/lib/api';
import type { LearnerDraft } from '@/context/ProfileContext';
import { knowledgePoints, getKnowledgePoint } from '@/data/knowledgePoints';
import { activePathNode } from '@/data/reportData';
import { reportForLearner } from '@/data/reportBuilder';
import { AVATARS, TAGS, EDU, JOBS, priorOf, priorLine } from '@/data/priors';
import { ReactECharts } from '@/components/ChartCard';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Sprout } from '@/components/heal/Flora';
import ProfileForge from '@/components/profiles/ProfileForge';
import type { ForgeData } from '@/components/profiles/ProfileForge';
import { cn } from '@/lib/utils';

const clampScore = (n: number) => Math.max(20, Math.min(92, Math.round(n)));

function miniRadar(scores: Record<string, number>) {
  return {
    animationDuration: 500,
    radar: {
      indicator: knowledgePoints.map((kp) => ({ name: kp.name, max: 100 })),
      radius: '62%',
      center: ['50%', '52%'] as [string, string],
      axisName: { fontSize: 10, color: '#8A8474', fontFamily: '"Noto Sans SC", sans-serif' },
      splitLine: { lineStyle: { color: '#E9E3D4' } },
      splitArea: { areaStyle: { color: ['rgba(253,252,249,0)', 'rgba(240,235,224,0.5)'] } },
      axisLine: { lineStyle: { color: '#DCE6DE' } },
    },
    series: [
      {
        type: 'radar' as const,
        data: [
          {
            value: knowledgePoints.map((kp) => scores[kp.id] ?? 50),
            symbolSize: 3,
            lineStyle: { color: '#4E7860', width: 2 },
            itemStyle: { color: '#4E7860' },
            areaStyle: { color: 'rgba(78, 120, 96,0.22)' },
          },
        ],
      },
    ],
  };
}

/* ================= 精简建档三步 ================= */
const QUICK_STEPS = ['我是谁', '什么学历', '想做什么'];

function QuickWizard({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  const { bindAccount, session } = useAuth();
  const { createLearner } = useProfile();
  const [step, setStep] = useState(0);
  const [targetCategories, setTargetCategories] = useState<OnboardingTargetCategory[]>([]);
  const [targetOptions, setTargetOptions] = useState<OnboardingTargetOption[]>([]);
  const [targetCategoryCode, setTargetCategoryCode] = useState('JOB');
  const [jobOptions, setJobOptions] = useState<string[]>(JOBS);

  useEffect(() => {
    Promise.all([api.listTargetCategories(), api.listTargetOptions()])
      .then(([categories, options]) => {
        setTargetCategories(categories);
        setTargetOptions(options);
        setJobOptions(options.map((option) => option.name));
      })
      .catch(() => {});
  }, []);
  const [name, setName] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [edu, setEdu] = useState<string | null>(null);
  const [job, setJob] = useState<string | null>(null);
  /** 建档锻造特效：createLearner 之后先播生成过程，播完再进主页 */
  const [forge, setForge] = useState<ForgeData | null>(null);

  const visibleTargetOptions = targetCategoryCode && targetOptions.length
    ? targetOptions.filter((option) => option.categoryCode === targetCategoryCode)
    : [];
  const visibleTargetNames = visibleTargetOptions.length ? visibleTargetOptions.map((option) => option.name) : jobOptions;

  const pickTargetCategory = (categoryCode: string) => {
    setTargetCategoryCode(categoryCode);
    const first = targetOptions.find((option) => option.categoryCode === categoryCode);
    if (first) setJob(first.name);
  };

  const pickTarget = (name: string) => {
    setJob(name);
    const option = targetOptions.find((item) => item.name === name);
    if (option) setTargetCategoryCode(option.categoryCode);
  };

  const canNext = step === 0 ? name.trim().length > 0 && tag !== null : step === 1 ? edu !== null : job !== null;

  const finish = async () => {
    if (!tag || !edu || !job || forge) return;
    const prior = priorOf(tag, edu);
    const scores: Record<string, number> = {};
    knowledgePoints.forEach((kp) => { scores[kp.id] = clampScore(50 + (prior[kp.id] ?? 0)); });
    const blind = [...knowledgePoints]
      .sort((a, b) => (scores[a.id] ?? 50) - (scores[b.id] ?? 50))
      .slice(0, 2)
      .map((kp) => getKnowledgePoint(kp.id).name);
    const draft: LearnerDraft = {
      name: name.trim(),
      avatar: AVATARS[name.trim().length % AVATARS.length],
      tag,
      role: `${tag} · 精简建档`,
      education: edu,
      targetJob: job,
      weeklyHours: 8,
      learningStyle: [],
      scores,
      blindSpots: blind,
      goal: `拿下「${job}」${targetCategoryCode === 'EXAM' ? '考试科目' : targetCategoryCode === 'CERT' ? '证书考核' : '岗位'}所需的核心技能——画像先按背景估，边学边测准。`,
    };
    let id: string;
    try {
      id = await createLearner(draft, { method: 'quick', value: 33 });
      if (session) bindAccount(id);
    } catch {
      toast.error('建档失败', { description: '请稍后重试' });
      return;
    }
    /* 先锻造，后进门 */
    setForge({
      name: draft.name,
      avatar: draft.avatar,
      scores,
      confidence: 33,
      method: 'quick',
      evidence: [`身份「${tag}」`, `学历「${edu}」`, `目标「${job}」`, '背景先验 → 六维起点'],
    });
  };

  const forgeDone = () => {
    toast.success(`「${forge?.name}」画像已按背景先验建档`, {
      description: '置信度 33% · 前两讲我会多问几个检查点，边学边把画像测准',
    });
    navigate('/me');
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="lf-card relative w-full max-w-[660px] overflow-hidden !rounded-[24px]"
    >
      {forge && <ProfileForge data={forge} onDone={forgeDone} />}

      <div className="relative border-b border-hairline/70 bg-gradient-to-br from-white/35 via-transparent to-brand-tint/35 px-5 pb-4 pt-5 sm:px-7">
        <div aria-hidden className="absolute -right-10 -top-14 h-36 w-36 rounded-full bg-brand-tint/55 blur-2xl" />
        <div className="relative flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] border border-white/80 bg-brand-amber-tint/75 text-ochre shadow-xs">
              <Zap size={17} />
            </span>
            <div className="min-w-0">
              <h1 className="text-[15px] font-semibold text-ink">精简建档</h1>
              <p className="mt-0.5 text-[10.5px] text-ink-muted">只需回答 3 个问题，约 30 秒</p>
            </div>
          </div>
          <span className="shrink-0 rounded-full border border-brand/15 bg-white/50 px-2.5 py-1 font-mono text-[10px] font-medium text-brand">
            {step + 1} / {QUICK_STEPS.length}
          </span>
        </div>

        <div className="relative mt-4 grid grid-cols-3 gap-2">
          <span aria-hidden className="absolute left-[16.5%] right-[16.5%] top-[13px] h-px bg-hairline" />
          <span
            aria-hidden
            className="absolute left-[16.5%] top-[13px] h-px bg-brand transition-[width] duration-500 ease-lf"
            style={{ width: `${step * 33.5}%` }}
          />
          {QUICK_STEPS.map((label, index) => {
            const active = index === step;
            const done = index < step;
            return (
              <div key={label} className="relative z-10 flex flex-col items-center gap-1.5">
                <span
                  className={cn(
                    'flex h-[27px] w-[27px] items-center justify-center rounded-full border text-[10.5px] font-semibold transition-all',
                    done
                      ? 'border-brand bg-brand text-paper'
                      : active
                        ? 'border-brand bg-card-warm text-brand shadow-[0_0_0_4px_rgba(233,242,236,0.8)]'
                        : 'border-hairline bg-card-warm text-ink-muted',
                  )}
                >
                  {done ? <Check size={12} strokeWidth={2.5} /> : index + 1}
                </span>
                <span className={cn('text-[10.5px] font-medium', active || done ? 'text-ink-2' : 'text-ink-muted')}>{label}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="min-h-[265px] px-5 py-5 sm:px-7 sm:py-6">
        <AnimatePresence mode="wait" initial={false}>
          {step === 0 && (
            <motion.div
              key="identity"
              initial={{ opacity: 0, x: 18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -18 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            >
              <div>
                <div className="flex items-end justify-between gap-3">
                  <label htmlFor="quick-name" className="text-[13px] font-semibold text-ink">怎么称呼你？</label>
                  <span className="text-[10.5px] text-ink-muted">名字或昵称都可以</span>
                </div>
                <input
                  id="quick-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：小智"
                  autoFocus
                  className="mt-2.5 w-full rounded-[12px] border border-hairline bg-white/45 px-4 py-3 text-[14px] text-ink shadow-xs outline-none transition-all placeholder:text-ink-muted/55 focus:border-brand/55 focus:bg-white/70 focus:shadow-[0_0_0_3px_rgba(78,120,96,0.08)]"
                />
              </div>

              <div className="mt-5">
                <div className="text-[13px] font-semibold text-ink">你目前更接近哪种状态？</div>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {TAGS.map((item) => (
                    <button
                      key={item}
                      type="button"
                      aria-pressed={tag === item}
                      onClick={() => setTag(item)}
                      className={cn(
                        'rounded-full border px-3.5 py-2 text-[12.5px] font-medium transition-all',
                        tag === item
                          ? 'border-brand bg-brand-tint text-brand shadow-[0_3px_10px_rgba(78,120,96,0.1)]'
                          : 'border-hairline bg-white/35 text-ink-2 hover:-translate-y-0.5 hover:border-brand/35 hover:bg-white/60',
                      )}
                    >
                      {tag === item && <Check size={12} className="mr-1 inline" />}
                      {item}
                    </button>
                  ))}
                </div>
              </div>

              <AnimatePresence>
                {tag && (
                  <motion.p
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-4 flex items-start gap-2 rounded-[12px] border border-brand/10 bg-brand-tint/45 px-3.5 py-2.5 text-[12px] leading-[19px] text-ink-2"
                  >
                    <Sparkles size={13} className="mt-0.5 shrink-0 text-brand" />
                    <span>{priorLine(tag)}</span>
                  </motion.p>
                )}
              </AnimatePresence>
            </motion.div>
          )}

          {step === 1 && (
            <motion.div
              key="education"
              initial={{ opacity: 0, x: 18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -18 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="text-center sm:text-left">
                <h2 className="font-serif text-[20px] font-semibold text-ink">你的最高学历是？</h2>
                <p className="mt-1 text-[11.5px] leading-[18px] text-ink-muted">用于估算理论知识的起点，不影响后续学习内容。</p>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {EDU.map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={edu === item}
                    onClick={() => setEdu(item)}
                    className={cn(
                      'relative rounded-[13px] border px-3 py-3.5 text-center text-[13px] font-medium transition-all',
                      edu === item
                        ? 'border-brand bg-brand-tint text-brand shadow-[0_5px_14px_rgba(78,120,96,0.1)]'
                        : 'border-hairline bg-white/35 text-ink-2 hover:-translate-y-0.5 hover:border-brand/35 hover:bg-white/60',
                    )}
                  >
                    {edu === item && <Check size={13} className="absolute right-2.5 top-2.5" />}
                    {item}
                  </button>
                ))}
              </div>
            </motion.div>
          )}

          {step === 2 && (
            <motion.div
              key="goal"
              initial={{ opacity: 0, x: 18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -18 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="text-center sm:text-left">
                <h2 className="font-serif text-[20px] font-semibold text-ink">你的主要学习目标是什么？</h2>
                <p className="mt-1 text-[11.5px] leading-[18px] text-ink-muted">先选目标类型，再选具体方向；我们会按对应要求安排学习内容。</p>
              </div>
              {targetCategories.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {targetCategories.map((category) => (
                    <button
                      key={category.code}
                      type="button"
                      aria-pressed={targetCategoryCode === category.code}
                      onClick={() => pickTargetCategory(category.code)}
                      className={cn(
                        'rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-all',
                        targetCategoryCode === category.code
                          ? 'border-brand bg-brand-tint text-brand'
                          : 'border-hairline bg-white/45 text-ink-2 hover:border-brand/35',
                      )}
                    >
                      {category.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {visibleTargetNames.map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={job === item}
                    onClick={() => pickTarget(item)}
                    className={cn(
                      'flex items-center justify-between rounded-[12px] border px-3.5 py-2.5 text-left text-[12.5px] font-medium transition-all',
                      job === item
                        ? 'border-brand bg-brand-tint text-brand shadow-[0_4px_12px_rgba(78,120,96,0.1)]'
                        : 'border-hairline bg-white/35 text-ink-2 hover:border-brand/35 hover:bg-white/60',
                    )}
                  >
                    {item}
                    <span className={cn('flex h-5 w-5 items-center justify-center rounded-full border', job === item ? 'border-brand bg-brand text-paper' : 'border-hairline')}>
                      {job === item && <Check size={11} strokeWidth={2.5} />}
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-3 flex items-start gap-2 text-[11px] leading-[17px] text-ink-muted">
                <Gauge size={12} className="mt-0.5 shrink-0 text-ochre" />
                精简建档会先生成一份「校准中」画像，前两讲通过少量检查点边学边测准。
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex items-center justify-between border-t border-hairline/70 bg-white/20 px-5 py-4 sm:px-7">
        <button
          type="button"
          onClick={() => (step === 0 ? onBack() : setStep((current) => current - 1))}
          className="lf-btn-ghost !rounded-full !px-4 !py-2 text-[12.5px]"
        >
          <ChevronLeft size={14} />
          {step === 0 ? '换个方式' : '上一步'}
        </button>
        <button
          type="button"
          disabled={!canNext}
          onClick={() => (step === 2 ? finish() : setStep((current) => current + 1))}
          className={cn('lf-btn-primary !rounded-full !px-5 !py-2 text-[13px]', !canNext && 'pointer-events-none opacity-40 grayscale-[0.25]')}
        >
          {step === 2 ? '生成学习计划' : '下一步'}
          <ArrowRight size={14} />
        </button>
      </div>
    </motion.div>
  );
}

export default function Welcome() {
  const navigate = useNavigate();
  const { session, knownOf, logout } = useAuth();
  const { learners } = useProfile();
  const [mode, setMode] = useState<'auto' | 'choice' | 'quick'>('auto');

  const knownLearner = useMemo(() => {
    if (!session) return null;
    const rec = knownOf(session.account);
    if (!rec) return null;
    return learners.find((l) => l.id === rec.learnerId) ?? null;
  }, [session, knownOf, learners]);

  if (!session) return <Navigate to="/login" replace />;

  const isBack = mode === 'auto' && knownLearner !== null;
  const report = knownLearner ? reportForLearner(knownLearner) : null;
  const nextNode = report ? activePathNode(report) : null;

  return (
    <div className="lf-learner flex min-h-[100dvh] flex-col items-center justify-center px-5 py-12">
      {/* 顶部品牌 */}
      <div className="mb-8 flex items-center gap-2.5">
        <img src="/logo.svg" alt="智训云枢" className="h-8 w-8" />
        <span className="font-serif text-[18px] font-bold text-ink">智训云枢</span>
      </div>

      {/* ============ 老用户：欢迎回来 ============ */}
      {isBack && knownLearner && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }} className="lf-card w-full max-w-[560px] p-6">
          <div className="flex items-center gap-4">
            <Avatar className="h-14 w-14 border border-hairline shadow-warm">
              <AvatarImage src={knownLearner.avatar} alt={knownLearner.name} />
              <AvatarFallback className="bg-brand-tint text-brand">{knownLearner.name.slice(0, 1)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <h1 className="font-sans text-[22px] font-bold tracking-[-0.02em] text-ink">欢迎回来，{knownLearner.name}</h1>
              <p className="mt-0.5 text-[12.5px] text-ink-muted">{knownLearner.tag} · {knownLearner.targetJob}</p>
            </div>
            <Sprout className="hidden h-9 w-9 sm:block" />
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-[190px_1fr]">
            <div>
              <ReactECharts option={miniRadar(knownLearner.scores)} height={170} />
            </div>
            <div className="flex flex-col justify-center gap-2.5">
              {nextNode && (
                <div className="rounded-[12px] border border-hairline bg-card-warm/70 px-3.5 py-3">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-ochre">
                    <Route size={12} />
                    {report?.path.some((n) => n.status === 'done') ? '上次学到' : '从这里开始'}
                  </div>
                  <div className="mt-1 text-[14px] font-medium leading-[21px] text-ink">{nextNode.title}</div>
                  <div className="mt-0.5 text-[11.5px] text-ink-muted">{nextNode.est} · {nextNode.resourceRef}</div>
                </div>
              )}
              <p className="text-[12px] leading-[19px] text-ink-muted">
                画像和进度都替你存着——不用重新建档，接着上次的节奏走就行。
              </p>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            <button type="button" onClick={() => navigate('/me')} className="lf-btn-primary flex-1 justify-center !py-2.5">
              继续学习
              <ArrowRight size={15} />
            </button>
            <button type="button" onClick={() => navigate('/me/profile')} className="lf-btn-ghost !px-4 !py-2.5 text-[13.5px]">
              <UserRound size={14} />
              看看我的画像
            </button>
          </div>
          <div className="mt-3 text-center">
            <button type="button" onClick={() => setMode('choice')} className="text-[11.5px] text-ink-muted transition-colors hover:text-brand">
              不是你？重新建一份画像
            </button>
          </div>
        </motion.div>
      )}

      {/* ============ 新用户：建档方式二选一 ============ */}
      {!isBack && mode !== 'quick' && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }} className="w-full max-w-[720px]">
          <div className="text-center">
            <h1 className="font-serif text-[26px] font-semibold text-ink">先建一份你的学情画像</h1>
            <p className="mt-2 text-[13.5px] leading-[22px] text-ink-muted">
              之后的讲义、练习、路径全由它驱动。两种方式，测得越准、首日推荐越准。
            </p>
          </div>

          <div className="mt-7 grid gap-4 sm:grid-cols-2">
            {/* 精简 */}
            <button
              type="button"
              onClick={() => setMode('quick')}
              className="lf-card group flex flex-col p-5 text-left transition-all hover:border-brand/45"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-[11px] bg-brand-amber-tint text-ochre">
                <Zap size={19} />
              </span>
              <span className="mt-3 text-[16px] font-semibold text-ink">精简建档</span>
              <span className="mt-0.5 font-mono text-[10.5px] tracking-wide text-ink-muted">约 30 秒 · 3 步选择</span>
              <span className="mt-2.5 text-[12.5px] leading-[20px] text-ink-2">
                只答"我是谁 / 什么学历 / 想做什么"，按背景先验起一份画像，马上开学。
              </span>
              <span className="mt-3 flex items-center gap-1.5 rounded-[9px] bg-paper-deep px-2.5 py-1.5 text-[11.5px] text-ink-muted">
                <Gauge size={12} className="text-ochre" />
                画像置信度低 → 前两讲多问几个检查点，边学边测准
              </span>
              <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-brand transition-transform group-hover:translate-x-0.5">
                快速开始 <ArrowRight size={13} />
              </span>
            </button>

            {/* 精准 */}
            <button
              type="button"
              onClick={() => navigate('/onboarding')}
              className="lf-card group relative flex flex-col border-brand/35 p-5 text-left transition-all hover:border-brand/60"
            >
              <span className="absolute right-4 top-4 rounded-md bg-brand px-1.5 py-0.5 text-[10px] font-semibold text-paper">推荐</span>
              <span className="flex h-10 w-10 items-center justify-center rounded-[11px] bg-brand-tint text-brand">
                <Target size={19} />
              </span>
              <span className="mt-3 text-[16px] font-semibold text-ink">精准定制</span>
              <span className="mt-0.5 font-mono text-[10.5px] tracking-wide text-ink-muted">约 5 分钟 · 自评 + 自适应测题</span>
              <span className="mt-2.5 text-[12.5px] leading-[20px] text-ink-2">
                走一遍五步初诊：背景、六维自评、6~14 道自适应题，AI 边测边诊断。
              </span>
              <span className="mt-3 flex items-center gap-1.5 rounded-[9px] bg-brand-tint/60 px-2.5 py-1.5 text-[11.5px] text-ink-2">
                <Gauge size={12} className="text-brand" />
                建档即高置信 → 首日推荐就精准
              </span>
              <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-brand transition-transform group-hover:translate-x-0.5">
                认真测一次 <ArrowRight size={13} />
              </span>
            </button>
          </div>

          {knownLearner && (
            <div className="mt-4 text-center">
              <button type="button" onClick={() => setMode('auto')} className="text-[12px] text-ink-muted transition-colors hover:text-brand">
                ← 回到「欢迎回来」
              </button>
            </div>
          )}
        </motion.div>
      )}

      {/* ============ 精简建档向导 ============ */}
      {mode === 'quick' && <QuickWizard onBack={() => setMode('choice')} />}

      {/* 底部：换账号 */}
      <button
        type="button"
        onClick={() => { logout(); navigate('/login'); }}
        className="mt-6 text-[11.5px] text-ink-muted/80 transition-colors hover:text-brand"
      >
        换个账号登录
      </button>
    </div>
  );
}
