import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowUpRight,
  BadgeCheck,
  BookOpen,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  GraduationCap,
  History,
  RefreshCw,
  Sparkles,
  Target,
  UserRound,
} from 'lucide-react';
import AgentChip from '@/components/AgentChip';
import ChartCard, { ReactECharts } from '@/components/ChartCard';
import LiveDot from '@/components/LiveDot';
import SectionHeader from '@/components/SectionHeader';
import { useAuth } from '@/context/AuthContext';
import { useProfile } from '@/context/ProfileContext';
import type { Learner } from '@/data/learners';
import { api } from '@/lib/api';
import type {
  LearnerAnalyticsProfile,
  LearnerProfileData,
  OnboardingKnowledgePoint,
  WrongAnswerRecord,
} from '@/lib/api';
import { cn } from '@/lib/utils';

type LoadState = 'loading' | 'ready' | 'error';
type Severity = '高' | '中' | '低';

const profileColors = ['#4E7860', '#E7B45A', '#B77552', '#6686A5'];
const profileBands = ['目标驱动 · 持续更新', '精准诊断 · 多维画像', '自主建档 · 个性路径', '学习回写 · 动态演进'];

function scoreFor(learner: Learner, point: OnboardingKnowledgePoint) {
  return learner.scores[point.id] ?? 0;
}

function weightedScore(learner: Learner, points: OnboardingKnowledgePoint[]) {
  const totalWeight = points.reduce((sum, point) => sum + Math.max(0, point.weight), 0);
  if (!totalWeight) return 0;
  return Math.round(points.reduce((sum, point) => sum + scoreFor(learner, point) * Math.max(0, point.weight), 0) / totalWeight);
}

function confidencePercent(learner: Learner) {
  if (!learner.confidence) return null;
  return Math.round(learner.confidence.value <= 1 ? learner.confidence.value * 100 : learner.confidence.value);
}

function formatTime(value?: string | null) {
  if (!value) return '后端未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function severityOf(gap: number): Severity {
  if (gap >= 25) return '高';
  if (gap >= 12) return '中';
  return '低';
}

function statusOf(score: number, target: number) {
  const gap = target - score;
  if (gap <= 5) return { label: '接近目标', className: 'border-brand/30 bg-brand-tint text-brand' };
  if (gap <= 20) return { label: '待巩固', className: 'border-brand-amber/50 bg-brand-amber-tint text-ochre' };
  return { label: '重点盲区', className: 'border-brand-danger/40 bg-brand-danger/10 text-brand-danger' };
}

function ProfileCard({
  learner,
  points,
  index,
  current,
  selected,
  onSelect,
}: {
  learner: Learner;
  points: OnboardingKnowledgePoint[];
  index: number;
  current: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const color = profileColors[index % profileColors.length];
  const ordered = [...points]
    .map((point) => ({ point, score: scoreFor(learner, point) }))
    .sort((left, right) => right.score - left.score);
  const confidence = confidencePercent(learner);

  return (
    <motion.article
      initial={{ opacity: 0, y: 32 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.08, duration: 0.5 }}
      className={cn(
        'lf-card group relative flex cursor-pointer flex-col overflow-hidden transition-all hover:-translate-y-1 hover:shadow-warm',
        current ? 'border-2 border-brand shadow-warm' : selected ? 'border-brand/40' : 'hover:border-brand/30',
      )}
      onClick={onSelect}
    >
      {current && <span className="absolute left-0 top-0 z-10 rounded-br-[10px] bg-brand px-2 py-1 font-mono text-[9px] font-semibold tracking-[0.14em] text-paper">CURRENT</span>}
      <div className="px-5 py-2" style={{ backgroundColor: `${color}18`, color }}>
        <span className="font-mono text-[10.5px] font-semibold tracking-[0.12em]">{profileBands[index % profileBands.length]}</span>
      </div>
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-center gap-3.5">
          <img src={learner.avatar} alt={learner.name} className="h-16 w-16 rounded-full border border-hairline object-cover" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-serif text-[20px] font-bold text-ink">{learner.name}</h2>
            <p className="mt-1 truncate text-[12px] text-ink-muted">{learner.targetJob || learner.goal || '尚未设置目标'}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <span className="rounded-md border px-1.5 py-0.5 text-[10.5px]" style={{ borderColor: `${color}55`, color }}>{learner.confidence?.method === 'full' ? '精准定制' : learner.confidence?.method === 'quick' ? '精简建档' : '后端画像'}</span>
              {confidence != null && <span className="rounded-md bg-paper-deep px-1.5 py-0.5 font-mono text-[10.5px] text-ink-muted">置信度 {confidence}%</span>}
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-end justify-between border-t border-hairline pt-3">
          <div>
            <div className="lf-mono-label !text-[9.5px]">画像综合分</div>
            <span className="font-display text-[42px] font-semibold leading-[48px] text-ink">{weightedScore(learner, points)}</span>
            <span className="ml-1 text-[13px] text-ink-muted">/ 100</span>
          </div>
          <div className="w-[49%] space-y-1">
            {ordered.map(({ point, score }) => (
              <div key={point.id} className="flex items-center gap-1.5">
                <span className="w-[62px] truncate text-right text-[9.5px] text-ink-muted">{point.name}</span>
                <span className="h-[5px] flex-1 overflow-hidden rounded-full bg-paper-deep"><span className="block h-full rounded-full" style={{ width: `${score}%`, backgroundColor: color }} /></span>
                <span className="w-5 font-mono text-[9.5px] text-ink-2">{score}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">{learner.learningStyle.map((style) => <span key={style} className="lf-chip !px-2 !py-0.5 !text-[11px]">{style}</span>)}</div>
        <p className="mt-3 line-clamp-3 flex-1 text-[12.5px] italic leading-[21px] text-ink-muted">{learner.diagnosisSummary || 'DIA-01 尚未生成诊断摘要。'}</p>
        <div className={cn('mt-4 w-full rounded-[10px] py-2 text-center text-[13px] font-medium', current ? 'bg-brand-tint text-brand' : 'bg-paper-deep text-ink-muted')}>
          {current ? <><Check size={14} className="mr-1 inline" />当前画像</> : '画像详情'}
        </div>
      </div>
    </motion.article>
  );
}

function ProfileRadar({ learner, points }: { learner: Learner; points: OnboardingKnowledgePoint[] }) {
  const option = useMemo(() => ({
    animationDuration: 700,
    tooltip: { trigger: 'item' as const },
    legend: { bottom: 0, data: ['当前水平', '目标能力'] },
    radar: {
      indicator: points.map((point) => ({ name: point.name, max: 100 })),
      radius: '62%',
      center: ['50%', '47%'] as [string, string],
      axisName: { color: '#5A6553', fontSize: 11 },
    },
    series: [{
      type: 'radar' as const,
      symbolSize: 4,
      data: [
        { value: points.map((point) => scoreFor(learner, point)), name: '当前水平', lineStyle: { color: '#4E7860', width: 2.5 }, itemStyle: { color: '#4E7860' }, areaStyle: { color: 'rgba(78,120,96,.22)' } },
        { value: points.map((point) => point.targetLevel), name: '目标能力', lineStyle: { color: '#E7B45A', width: 2, type: 'dashed' as const }, itemStyle: { color: '#E7B45A' }, areaStyle: { color: 'transparent' } },
      ],
    }],
  }), [learner, points]);

  return <ChartCard title="知识雷达图" en={`KNOWLEDGE RADAR · ${points.length}-DIM`}><ReactECharts option={option} height={330} /></ChartCard>;
}

function BlindSpotWall({ learner, points, analytics }: { learner: Learner; points: OnboardingKnowledgePoint[]; analytics: LearnerAnalyticsProfile | null }) {
  const candidates = useMemo(() => {
    const explicit = new Set(learner.blindSpots.map((item) => item.trim()).filter(Boolean));
    const ranked = points
      .map((point) => ({ point, score: scoreFor(learner, point), gap: Math.max(0, point.targetLevel - scoreFor(learner, point)) }))
      .sort((left, right) => right.gap - left.gap);
    const selected = ranked.filter(({ point, gap }) => explicit.has(point.name) || gap >= 8).slice(0, 5);
    return selected.length ? selected : ranked.slice(0, Math.min(3, ranked.length));
  }, [learner, points]);

  const severityClass: Record<Severity, string> = {
    高: 'border-brand-danger/60 bg-brand-danger text-paper',
    中: 'border-brand-amber/50 bg-brand-amber-tint text-ochre',
    低: 'border-hairline bg-paper text-ink-muted',
  };

  return (
    <div className="lf-card p-5">
      <div className="lf-mono-label mb-1">BLIND-SPOT WALL</div>
      <h3 className="text-[16px] font-semibold text-ink">技能盲区与判定依据</h3>
      <div className="mt-4 space-y-2.5">
        {candidates.map(({ point, score, gap }, index) => {
          const severity = severityOf(gap);
          const quiz = analytics?.recentQuizzes.find((item) => item.categoryName === point.name && item.score != null);
          return <motion.div key={point.id} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: index * 0.05 }} className="rounded-[10px] border border-hairline bg-paper p-3">
            <div className="flex items-center justify-between gap-2"><span className="text-[13px] font-medium text-ink">{point.name}</span><span className={cn('rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium', severityClass[severity])}>{severity}风险</span></div>
            <p className="mt-1.5 text-[11.5px] leading-5 text-ink-muted">画像 {score} 分，目标 {point.targetLevel} 分，差距 {gap} 分{quiz ? `；最近测评 ${Math.round(quiz.score ?? 0)} 分` : '；暂无该维度的题级测评记录'}。</p>
          </motion.div>;
        })}
      </div>
      <p className="mt-3 text-[11.5px] leading-5 text-ink-muted">严重度由当前画像分与后端目标能力线的差距计算，不使用预设案例。</p>
    </div>
  );
}

function AssessmentDetail({ learner, points, analytics, wrongAnswers }: { learner: Learner; points: OnboardingKnowledgePoint[]; analytics: LearnerAnalyticsProfile | null; wrongAnswers: WrongAnswerRecord[] }) {
  const [mode, setMode] = useState<'dimension' | 'attempt'>('dimension');
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="lf-card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div><div className="lf-mono-label mb-1">ASSESSMENT DETAIL</div><h3 className="text-[16px] font-semibold text-ink">真实测评与画像依据</h3></div>
        <div className="flex rounded-[10px] border border-hairline bg-paper p-0.5">
          <button type="button" onClick={() => setMode('dimension')} className={cn('rounded-[8px] px-3.5 py-1.5 text-[12px] font-medium', mode === 'dimension' ? 'bg-brand text-paper' : 'text-ink-muted')}>按知识维度</button>
          <button type="button" onClick={() => setMode('attempt')} className={cn('rounded-[8px] px-3.5 py-1.5 text-[12px] font-medium', mode === 'attempt' ? 'bg-brand text-paper' : 'text-ink-muted')}>最近测评记录</button>
        </div>
      </div>

      {mode === 'dimension' ? <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left">
          <thead><tr className="border-b border-hairline font-mono text-[10.5px] uppercase tracking-[.08em] text-ink-muted"><th className="py-2.5 pr-4 font-medium">知识维度</th><th className="py-2.5 pr-4 font-medium">画像得分</th><th className="py-2.5 pr-4 font-medium">目标线</th><th className="py-2.5 pr-4 font-medium">判断</th><th className="py-2.5 pr-4 font-medium">真实测评</th><th /></tr></thead>
          <tbody>{points.map((point) => {
            const score = scoreFor(learner, point);
            const status = statusOf(score, point.targetLevel);
            const attempts = analytics?.recentQuizzes.filter((item) => item.categoryName === point.name) ?? [];
            const relatedWrong = wrongAnswers.filter((item) => item.knowledgeCategoryName === point.name);
            const open = expanded === point.id;
            return [<tr key={point.id} className="cursor-pointer border-b border-hairline/70 hover:bg-brand-tint/30" onClick={() => setExpanded(open ? null : point.id)}>
              <td className="py-3 pr-4 text-[13px] font-medium text-ink">{point.name}</td>
              <td className="py-3 pr-4"><div className="flex items-center gap-2"><span className="w-6 font-mono text-[13px] font-semibold">{score}</span><span className="h-1.5 w-24 overflow-hidden rounded-full bg-paper-deep"><span className="block h-full rounded-full bg-brand" style={{ width: `${score}%` }} /></span></div></td>
              <td className="py-3 pr-4 font-mono text-[12px] text-ink-2">{point.targetLevel}</td>
              <td className="py-3 pr-4"><span className={cn('rounded-md border px-1.5 py-0.5 text-[10.5px]', status.className)}>{status.label}</span></td>
              <td className="py-3 pr-4 text-[11.5px] text-ink-muted">{attempts.length ? `${attempts.length} 条记录` : '暂无题级记录'}</td>
              <td className="py-3"><ChevronDown size={14} className={cn('transition-transform', open && 'rotate-180')} /></td>
            </tr>, <tr key={`${point.id}-detail`}><td colSpan={6} className="p-0"><AnimatePresence initial={false}>{open && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden"><div className="grid gap-3 bg-paper px-4 py-3 text-[11.5px] text-ink-muted sm:grid-cols-3"><div><span className="font-medium text-ink">画像依据</span><br />当前分与目标线差距 {Math.max(0, point.targetLevel - score)} 分</div><div><span className="font-medium text-ink">最近测评</span><br />{attempts[0]?.score != null ? `${Math.round(attempts[0].score)} 分 · ${formatTime(attempts[0].createdAt)}` : '后端暂无该维度记录'}</div><div><span className="font-medium text-ink">待复习错题</span><br />{relatedWrong.length ? `${relatedWrong.length} 道已落库` : '当前没有关联错题'}</div></div></motion.div>}</AnimatePresence></td></tr>];
          })}</tbody>
        </table>
      </div> : <div>
        {analytics?.recentQuizzes.length ? <div className="overflow-x-auto"><table className="w-full min-w-[650px] text-left"><thead><tr className="border-b border-hairline font-mono text-[10.5px] text-ink-muted"><th className="py-2.5">类型</th><th>知识维度</th><th>得分</th><th>记录时间</th></tr></thead><tbody>{analytics.recentQuizzes.map((item, index) => <tr key={`${item.createdAt}-${index}`} className="border-b border-hairline/70 text-[12.5px]"><td className="py-3 text-ink">{item.quizType}</td><td className="text-ink-2">{item.categoryName || '未分类'}</td><td className="font-mono font-semibold text-brand">{item.score == null ? '—' : Math.round(item.score)}</td><td className="text-ink-muted">{formatTime(item.createdAt)}</td></tr>)}</tbody></table></div> : <EmptyEvidence title="暂无题级测评记录" detail="当前六维分数已由建档结果保存，但后端还没有可展示的测评尝试明细。后续答题会逐步沉淀在这里。" />}
      </div>}
    </div>
  );
}

function EmptyEvidence({ title, detail }: { title: string; detail: string }) {
  return <div className="rounded-[12px] border border-dashed border-hairline bg-paper px-5 py-8 text-center"><CircleAlert className="mx-auto text-ink-muted" size={22} /><div className="mt-2 text-[13px] font-medium text-ink">{title}</div><p className="mx-auto mt-1 max-w-xl text-[11.5px] leading-5 text-ink-muted">{detail}</p></div>;
}

function Comparison({ learners, points }: { learners: Learner[]; points: OnboardingKnowledgePoint[] }) {
  const [open, setOpen] = useState(false);
  const labels = useMemo(() => learners.map((learner, index) => `${learner.name} · ${learner.targetJob || `画像 ${index + 1}`}`), [learners]);
  const option = useMemo(() => ({
    tooltip: { trigger: 'item' as const },
    legend: { bottom: 0, data: labels },
    radar: { indicator: points.map((point) => ({ name: point.name, max: 100 })), radius: '62%', center: ['50%', '47%'] as [string, string] },
    series: [{ type: 'radar' as const, data: learners.map((learner, index) => ({ value: points.map((point) => scoreFor(learner, point)), name: labels[index], lineStyle: { color: profileColors[index % profileColors.length], width: 2.3 }, itemStyle: { color: profileColors[index % profileColors.length] }, areaStyle: { color: `${profileColors[index % profileColors.length]}18` } })) }],
  }), [labels, learners, points]);

  return <div className="lf-card p-5">
    <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center justify-between gap-3 text-left"><div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg border border-hairline bg-paper text-brand"><Target size={17} /></span><div><div className="lf-mono-label mb-0.5">PROFILE COMPARISON</div><h3 className="text-[16px] font-semibold text-ink">画像能力对比</h3></div></div><span className="text-[12px] text-ink-muted">{learners.length >= 2 ? `${learners.length} 份画像` : '等待第二份画像'} <ChevronDown size={14} className={cn('ml-1 inline transition-transform', open && 'rotate-180')} /></span></button>
    {open && <div className="pt-5">{learners.length >= 2 ? <ReactECharts option={option} height={350} /> : <EmptyEvidence title="当前账号只有一份真实画像" detail="原版对比功能已保留。创建第二份画像后，这里会自动叠加真实六维能力，不再展示三位预设学习者。" />}</div>}
  </div>;
}

export default function Profiles() {
  const { session } = useAuth();
  const { learners, currentLearnerId, domainKnowledgePoints } = useProfile();
  const [searchParams, setSearchParams] = useSearchParams();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [remoteProfiles, setRemoteProfiles] = useState<LearnerProfileData[]>([]);
  const [analytics, setAnalytics] = useState<LearnerAnalyticsProfile | null>(null);
  const [wrongAnswers, setWrongAnswers] = useState<WrongAnswerRecord[]>([]);
  const [selectedId, setSelectedId] = useState(searchParams.get('learner') || currentLearnerId);
  const detailRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    setLoadState('loading');
    try {
      const [profiles, analyticsResult, wrongResult] = await Promise.all([
        api.listLearners(),
        api.getLearnerAnalyticsProfile().catch(() => null),
        api.listWrongAnswers().catch(() => ({ items: [] })),
      ]);
      setRemoteProfiles(profiles);
      setAnalytics(analyticsResult);
      setWrongAnswers(wrongResult.items);
      setLoadState('ready');
    } catch {
      setLoadState('error');
    }
  };

  useEffect(() => { void load(); }, []);

  const remoteIds = useMemo(() => new Set(remoteProfiles.map((profile) => profile.id)), [remoteProfiles]);
  const realLearners = useMemo(() => learners.filter((learner) => remoteIds.has(learner.id)), [learners, remoteIds]);
  const selected = realLearners.find((learner) => learner.id === selectedId) ?? realLearners.find((learner) => learner.id === currentLearnerId) ?? realLearners[0];
  const remoteSelected = remoteProfiles.find((profile) => profile.id === selected?.id);
  const selectedAnalytics = selected?.id === session?.learnerId ? analytics : null;

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  const selectProfile = (id: string) => {
    setSelectedId(id);
    setSearchParams({ learner: id }, { replace: true });
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  if (loadState === 'loading' || (loadState === 'ready' && remoteProfiles.length > 0 && realLearners.length === 0)) {
    return <div className="mx-auto flex min-h-[55vh] max-w-[1180px] items-center justify-center px-6"><RefreshCw className="animate-spin text-brand" size={22} /><span className="ml-3 text-[13px] text-ink-muted">正在同步后端画像与测评证据…</span></div>;
  }

  if (loadState === 'error') {
    return <div className="mx-auto max-w-[760px] px-6 py-16"><EmptyEvidence title="画像数据暂时无法读取" detail="页面没有回退到预设学习者。请确认后端服务正常后重新加载。" /><button type="button" onClick={() => void load()} className="lf-btn-primary mx-auto mt-4"><RefreshCw size={14} />重新加载</button></div>;
  }

  if (!selected || remoteProfiles.length === 0) {
    return <div className="mx-auto max-w-[760px] px-6 py-16"><EmptyEvidence title="当前账号还没有画像" detail="先完成精简建档或精准定制，画像页会在真实数据写入后自动展开。" /><Link to="/welcome" className="lf-btn-primary mx-auto mt-4">开始建档 <ArrowUpRight size={14} /></Link></div>;
  }

  return (
    <div className="mx-auto max-w-[1320px] px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <header className="mb-9 flex flex-wrap items-end justify-between gap-5">
        <div className="max-w-[690px]">
          <div className="lf-mono-label mb-3 flex items-center gap-2"><span className="h-px w-6 bg-brand/40" />PERSISTED LEARNER PROFILES · {realLearners.length} REAL</div>
          <h1 className="font-serif text-[32px] font-bold leading-tight text-ink sm:text-[36px]">学情画像</h1>
          <p className="mt-3 text-[13.5px] leading-6 text-ink-muted">整合建档自评、真实测评与学习行为，形成可计算的能力向量。画像只展示当前账号后端数据，缺少的证据会明确标注。</p>
        </div>
        <div className="lf-card flex items-center gap-3 px-4 py-3">
          <img src={selected.avatar} alt={selected.name} className="h-11 w-11 rounded-full border border-hairline object-cover" />
          <div><div className="lf-mono-label !text-[9.5px]">当前驱动画像</div><div className="mt-0.5 text-[14px] font-semibold text-ink">{realLearners.find((learner) => learner.id === currentLearnerId)?.name || selected.name}</div><div className="text-[10.5px] text-ink-muted">{selected.targetJob || '尚未设置目标'}</div></div>
          <span className="ml-1 flex items-center gap-1.5 rounded-lg border border-brand/25 bg-brand-tint px-2 py-1"><LiveDot status="running" /><span className="font-mono text-[9.5px] text-brand">BACKEND</span></span>
        </div>
      </header>

      <div className={cn('grid gap-5', realLearners.length === 1 ? 'max-w-[430px]' : 'md:grid-cols-2 xl:grid-cols-3')}>
        {realLearners.map((learner, index) => <ProfileCard key={learner.id} learner={learner} points={domainKnowledgePoints} index={index} current={learner.id === currentLearnerId} selected={learner.id === selected.id} onSelect={() => selectProfile(learner.id)} />)}
      </div>

      <div ref={detailRef} className="mt-14 scroll-mt-20">
        <SectionHeader en="SELECTED PROFILE" title={`画像详情 · ${selected.name}`} desc="当前水平、目标能力、盲区和诊断均由真实画像计算；没有题级证据时保留明确空态。" actions={<Link to="/onboarding" className="lf-btn-ghost !px-3 !py-2 text-[12px]"><Sparkles size={14} />重新精准诊断</Link>} />
        <div className="grid gap-5 lg:grid-cols-12">
          <div className="space-y-5 lg:col-span-7">
            <ProfileRadar learner={selected} points={domainKnowledgePoints} />
            <div className="lf-card p-5">
              <div className="lf-mono-label mb-1">PRIOR-KNOWLEDGE ARCHIVE</div><h3 className="text-[16px] font-semibold text-ink">先验知识档案</h3>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {[
                  { icon: GraduationCap, label: '教育背景', value: selected.education || '后端未填写' },
                  { icon: Target, label: '目标岗位 / 目标', value: selected.targetJob || selected.goal || '后端未填写' },
                  { icon: Clock3, label: '每周学习投入', value: `${selected.weeklyHours} 小时` },
                  { icon: BookOpen, label: '偏好与学习风格', value: selected.learningStyle.join(' / ') || '后端未填写' },
                  { icon: BadgeCheck, label: '建档方式 / 置信度', value: `${selected.confidence?.method === 'full' ? '精准定制' : selected.confidence?.method === 'quick' ? '精简建档' : '未标注'}${confidencePercent(selected) == null ? '' : ` · ${confidencePercent(selected)}%`}` },
                  { icon: UserRound, label: '画像最近更新', value: formatTime(remoteSelected?.updatedAt) },
                ].map((item) => <div key={item.label} className="flex items-start gap-3 rounded-[10px] border border-hairline bg-paper p-3"><item.icon size={16} className="mt-0.5 shrink-0 text-brand" /><div className="min-w-0"><div className="font-mono text-[9.5px] uppercase tracking-[.08em] text-ink-muted">{item.label}</div><div className="mt-1 text-[12.5px] leading-5 text-ink">{item.value}</div></div></div>)}
              </div>
            </div>
          </div>
          <div className="space-y-5 lg:col-span-5">
            <BlindSpotWall learner={selected} points={domainKnowledgePoints} analytics={selectedAnalytics} />
            <div className="lf-card border-l-[3px] !border-l-brand p-5">
              <div className="flex items-center justify-between gap-3"><AgentChip agentId="DIA-01" showStatus={false} /><span className="font-mono text-[9.5px] text-ink-muted">画像更新 · {formatTime(remoteSelected?.updatedAt)}</span></div>
              <p className="mt-4 whitespace-pre-line text-[13px] leading-6 text-ink-2">{selected.diagnosisSummary || '后端尚未生成诊断摘要。'}</p>
              <div className="mt-4 border-t border-hairline pt-3"><div className="font-mono text-[9.5px] text-ink-muted">当前阶段目标</div><p className="mt-1 text-[12px] leading-5 text-ink">{selected.goal || selected.targetJob || '后端尚未填写目标'}</p><Link to="/report" className="mt-3 inline-flex items-center gap-1 text-[12px] font-medium text-brand">查看真实成长报告 <ArrowUpRight size={12} /></Link></div>
            </div>
            <div className="lf-card p-5"><div className="flex items-center gap-2"><History size={16} className="text-brand" /><h3 className="text-[14px] font-semibold text-ink">画像版本与变化</h3></div><div className="mt-3 border-l border-brand/25 pl-4"><div className="text-[12px] font-medium text-ink">当前持久化版本</div><div className="mt-1 text-[10.5px] text-ink-muted">创建于 {formatTime(remoteSelected?.createdAt)}<br />更新于 {formatTime(remoteSelected?.updatedAt)}</div></div><p className="mt-3 text-[11px] leading-5 text-ink-muted">后端目前只返回当前版本时间；原版变化时间线已保留位置，待画像版本快照接口接入后自动扩展。</p></div>
          </div>
        </div>
      </div>

      <div className="mt-12"><AssessmentDetail learner={selected} points={domainKnowledgePoints} analytics={selectedAnalytics} wrongAnswers={selected.id === session?.learnerId ? wrongAnswers : []} /></div>
      <div className="mt-12"><Comparison learners={realLearners} points={domainKnowledgePoints} /></div>
    </div>
  );
}
