import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  CheckCircle2,
  CircleDashed,
  Clock3,
  FileDown,
  Flame,
  History,
  Route,
  Sparkles,
  Target,
} from 'lucide-react';
import { toast } from 'sonner';
import PageBack from '@/components/PageBack';
import SectionHeader from '@/components/SectionHeader';
import { ReactECharts } from '@/components/ChartCard';
import { useProfile } from '@/context/ProfileContext';
import { useCourseLearning } from '@/hooks/useCourseLearning';
import { useLearningMap } from '@/hooks/useLearningMap';
import { api } from '@/lib/api';
import { CHAPTER_ABILITY_WEIGHTS, deriveAbilityScores } from '@/lib/abilityAdjust';
import type { AbilityDimension } from '@/lib/abilityAdjust';
import { cn } from '@/lib/utils';
import { learnMapPath } from '@/lib/learnNav';
import type { LearnerAnalyticsProfile, LearnerGrowth, LearningJournal, OnboardingKnowledgePoint } from '@/lib/api';

const resourceLabel = { lecture: '讲义', practice: '实操', quiz: '分阶题' } as const;

function localDateKey(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const evidenceMeta: Record<string, { label: string; cls: string }> = {
  focus: { label: '专注', cls: 'border-brand/30 bg-brand-tint text-brand' },
  resource: { label: '资源', cls: 'border-ochre/40 bg-ochre-tint text-ochre' },
  quiz: { label: '测评', cls: 'border-brand-amber/50 bg-brand-amber-tint text-ochre' },
  chat: { label: '导学', cls: 'border-brand/30 bg-brand-tint text-brand' },
  knowledge: { label: '画像', cls: 'border-hairline bg-paper-deep text-ink-muted' },
};

function evidenceTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/* 旧档案分 key → 当前六维 key 的兜底映射（与「我的画像」页一致） */
const LEGACY_KP_IDS: Record<string, string> = {
  'kp-ds': 'kp-plc',
  'kp-co': 'kp-kinematics',
  'kp-os': 'kp-sensor',
  'kp-network': 'kp-vision',
  'kp-db': 'kp-safety',
  'kp-agent': 'kp-diagnosis',
};

function displayMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function radarOption(kps: OnboardingKnowledgePoint[], scores: Record<string, number>) {
  return {
    animationDuration: 700,
    tooltip: { trigger: 'item' as const },
    radar: {
      indicator: kps.map((kp) => ({ name: kp.name, max: 100 })),
      radius: '65%',
      center: ['50%', '51%'] as [string, string],
      axisName: { color: '#5A6553', fontSize: 11 },
      splitLine: { lineStyle: { color: '#E9E3D4' } },
      splitArea: { areaStyle: { color: ['rgba(253,252,249,0)', 'rgba(240,235,224,0.45)'] } },
      axisLine: { lineStyle: { color: '#DCE6DE' } },
    },
    legend: { bottom: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8 },
    series: [{
      type: 'radar' as const,
      data: [
        {
          value: kps.map((kp) => scores[kp.id] ?? 50), name: '当前画像', symbolSize: 4,
          lineStyle: { color: '#4E7860', width: 2.5 },
          itemStyle: { color: '#4E7860' }, areaStyle: { color: 'rgba(78,120,96,0.22)' },
        },
      ],
    }],
  };
}

function weeklyOption(values: number[]) {
  const labels = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    return `${date.getMonth() + 1}/${date.getDate()}`;
  });
  return {
    animationDuration: 700,
    grid: { left: 36, right: 12, top: 24, bottom: 28 },
    tooltip: { trigger: 'axis' as const, formatter: (items: { axisValue: string; value: number }[]) => `${items[0]?.axisValue}<br/>学习 ${items[0]?.value ?? 0} 分钟` },
    xAxis: { type: 'category' as const, data: labels, axisLine: { lineStyle: { color: '#D8D1C1' } }, axisTick: { show: false }, axisLabel: { color: '#7B8475', fontSize: 10 } },
    yAxis: { type: 'value' as const, minInterval: 10, axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: '#EEE9DF' } }, axisLabel: { color: '#8B9387', fontSize: 10 } },
    series: [{
      type: 'bar' as const, data: values, barMaxWidth: 28,
      itemStyle: { color: '#4E7860', borderRadius: [6, 6, 0, 0] },
      showBackground: true, backgroundStyle: { color: 'rgba(78,120,96,0.07)', borderRadius: [6, 6, 0, 0] },
    }],
  };
}

export default function Report() {
  const navigate = useNavigate();
  const { currentLearner, domainKnowledgePoints } = useProfile();
  const { loading: courseLoading, course, resources, nextResource, nextChapter, learnedCount, totalCount, progress } = useCourseLearning();
  const learningMap = useLearningMap();
  const [analytics, setAnalytics] = useState<LearnerAnalyticsProfile | null>(null);
  const [journals, setJournals] = useState<LearningJournal[]>([]);
  const [growth, setGrowth] = useState<LearnerGrowth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summarizing, setSummarizing] = useState(false);

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const dates = Array.from({ length: 7 }, (_, index) => localDateKey(index));
      const [profile, learnerGrowth, ...recentJournals] = await Promise.all([
        api.getLearnerAnalyticsProfile(),
        isUuid(currentLearner.id) ? api.getLearnerGrowth(currentLearner.id) : Promise.resolve(null),
        ...dates.map((date) => api.getLearningJournal(date)),
      ]);
      setAnalytics(profile);
      setGrowth(learnerGrowth);
      setJournals(recentJournals);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '学情数据读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReport();
  }, [currentLearner.id, loadReport]);

  /* 六维能力 = 画像基线 + 学习证据（章节/知识点 进度×掌握度 加权），与「我的画像」页同口径 */
  const normalizedScores = useMemo(() => {
    const base = currentLearner.scores;
    return domainKnowledgePoints.reduce((acc, point) => {
      acc[point.id] = base[point.id] ?? base[LEGACY_KP_IDS[point.id] ?? ''] ?? 50;
      return acc;
    }, {} as Record<string, number>);
  }, [currentLearner, domainKnowledgePoints]);

  const abilityScores = useMemo(() => deriveAbilityScores(learningMap, normalizedScores), [learningMap, normalizedScores]);

  const abilities = useMemo(() => domainKnowledgePoints.map((point) => ({
    ...point,
    score: abilityScores[point.id] ?? 50,
  })).sort((left, right) => left.score - right.score), [abilityScores, domainKnowledgePoints]);

  const resourcesByChapter = useMemo(() => new Map((course?.chapters ?? []).map((chapter) => {
    const chapterResources = resources.filter((resource) => resource.chapterId === chapter.id);
    return [chapter.id, { total: chapterResources.length, learned: chapterResources.filter((resource) => resource.learned).length }];
  })), [course, resources]);

  const journalStats = useMemo(() => journals.reduce((sum, journal) => ({
    questions: sum.questions + journal.stats.questionCount,
    correct: sum.correct + journal.stats.correctCount,
    durationSeconds: sum.durationSeconds + journal.stats.totalDurationSeconds,
    resources: sum.resources + journal.stats.resourceCount,
  }), { questions: 0, correct: 0, durationSeconds: 0, resources: 0 }), [journals]);

  const accuracy = journalStats.questions ? Math.round(journalStats.correct / journalStats.questions * 100) : null;
  const overallMastery = Math.round((analytics?.mastery.overall ?? 0) * 100);
  /* 真实地图口径的最弱章节：优先有学习痕迹的，其次整体掌握度/进度最低 */
  const weakestChapter = useMemo(() => {
    const domains = learningMap.domains ?? [];
    if (!domains.length) return null;
    const active = domains.filter((domain) => (learningMap.mastery[domain.id] ?? 0) > 0 || (learningMap.chapterProgress[domain.id] ?? 0) > 0);
    const pool = active.length ? active : domains;
    return [...pool].sort((a, b) =>
      (learningMap.mastery[a.id] ?? 0) - (learningMap.mastery[b.id] ?? 0)
      || (learningMap.chapterProgress[a.id] ?? 0) - (learningMap.chapterProgress[b.id] ?? 0),
    )[0] ?? null;
  }, [learningMap]);

  /* 最弱章节主要锻炼的六维（章节→能力权重映射） */
  const weakestChapterDims = useMemo(() => {
    if (!weakestChapter) return '';
    const weights = CHAPTER_ABILITY_WEIGHTS[weakestChapter.id];
    if (!weights) return '';
    const names = (Object.entries(weights) as [AbilityDimension, number][])
      .sort((a, b) => b[1] - a[1])
      .map(([dim]) => domainKnowledgePoints.find((point) => point.id === dim)?.name ?? dim);
    return names.length ? `该方向主要锻炼六维中的「${names.join('、')}」。` : '';
  }, [weakestChapter, domainKnowledgePoints]);

  const recentEvidence = useMemo(() => {
    const journalEvidence = journals.flatMap((journal) => journal.timeline);
    const profileEvidence = (growth?.events ?? []).map((event, index) => ({
      id: `growth-${event.createdAt}-${index}`,
      occurredAt: event.createdAt,
      kind: 'knowledge',
      title: event.title,
      description: event.amount ? `成长能量 ${event.amount > 0 ? '+' : ''}${event.amount}` : '画像字段已保存到后端',
      durationSeconds: null,
      knowledgeName: null,
      correctCount: null,
      wrongCount: null,
    }));
    return [...journalEvidence, ...profileEvidence].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  }, [journals, growth]);

  const today = journals.find((journal) => journal.date === localDateKey(0)) ?? journals[0] ?? null;

  const generateSummary = async () => {
    if (summarizing) return;
    setSummarizing(true);
    try {
      const updated = await api.generateLearningJournalSummary(localDateKey(0));
      setJournals((previous) => [updated, ...previous.filter((journal) => journal.date !== updated.date)]);
      toast.success('今日学习总结已生成');
    } catch (reason) {
      toast.error('总结生成失败', { description: reason instanceof Error ? reason.message : '请稍后再试' });
    } finally {
      setSummarizing(false);
    }
  };

  if (loading || courseLoading) {
    return <div className="mx-auto max-w-[1100px] px-6 py-16 text-center text-[14px] text-ink-muted">正在汇总真实学习数据…</div>;
  }

  if (error && !analytics) {
    return (
      <div className="mx-auto max-w-[760px] px-6 py-16 text-center">
        <h1 className="text-[20px] font-semibold text-ink">学习报告暂时无法读取</h1>
        <p className="mt-2 text-[13px] text-brand-danger">{error}</p>
        <button type="button" onClick={() => void loadReport()} className="lf-btn-primary mt-5">重新读取</button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1180px] px-5 pb-24 pt-8 md:px-8">
      <PageBack parent={{ label: '我的学习', to: '/me' }} current="我的成长" />

      <motion.header initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="lf-mono-label mb-2">LEARNING EVIDENCE REPORT</div>
          <h1 className="font-serif text-[34px] font-bold text-ink">{currentLearner.name}的学习成长</h1>
          <p className="mt-2 max-w-[700px] text-[14px] leading-6 text-ink-muted">画像、测评、学习时长、课程进度与路径均来自后端已保存记录；没有证据的指标保持为空，不用演示曲线补位。</p>
        </div>
        <button type="button" onClick={() => window.print()} className="lf-btn-ghost !px-4 !py-2 text-[13px]">
          <FileDown size={15} /> 导出 / 打印报告
        </button>
      </motion.header>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { icon: Target, label: '实测综合掌握度', value: `${overallMastery}%`, note: analytics?.mastery.categories.length ? `${analytics.mastery.categories.length} 个章节形成证据` : '完成分阶题后开始累计', tone: 'text-brand' },
          { icon: Clock3, label: '累计学习投入', value: displayMinutes(analytics?.stats.totalStudyMinutes ?? 0), note: `${analytics?.stats.totalDays ?? 0} 个真实学习日`, tone: 'text-brand' },
          { icon: Flame, label: '连续学习', value: `${analytics?.stats.streakDays ?? 0} 天`, note: '按后端每日学习会话统计', tone: 'text-ochre' },
          { icon: BarChart3, label: '近 7 天测评正确率', value: accuracy == null ? '暂无' : `${accuracy}%`, note: accuracy == null ? '尚无真实测评提交' : `${journalStats.correct}/${journalStats.questions} 题答对`, tone: 'text-brand' },
        ].map((item, index) => {
          const Icon = item.icon;
          return (
            <motion.div key={item.label} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.06 }} className="lf-card p-5">
              <div className="flex items-center gap-2 text-[12px] text-ink-muted"><Icon size={15} className={item.tone} />{item.label}</div>
              <div className="mt-3 font-serif text-[28px] font-semibold text-ink">{item.value}</div>
              <div className="mt-2 border-t border-hairline pt-2 text-[11.5px] leading-5 text-ink-muted">{item.note}</div>
            </motion.div>
          );
        })}
      </section>

      <section className="mt-12">
        <SectionHeader en="DIAGNOSIS" title="六维能力画像" desc="能力分 = 画像基线 + 学习证据（章节进度×掌握度加权），只做展示，不设目标门槛。" />
        <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="lf-card p-5">
            {domainKnowledgePoints.length ? <ReactECharts option={radarOption(domainKnowledgePoints, abilityScores)} height={350} /> : <div className="py-20 text-center text-[13px] text-ink-muted">画像知识维度尚未建立</div>}
          </div>
          <div className="lf-card divide-y divide-hairline overflow-hidden">
            {abilities.map((ability, index) => (
              <div key={ability.id} className="px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-[14px] font-semibold text-ink"><span className="font-mono text-[10px] text-ink-muted">{String(index + 1).padStart(2, '0')}</span>{ability.name}</span>
                  <span className="font-mono text-[11px] text-ink-muted">当前 {ability.score} 分</span>
                </div>
                <div className="relative mt-3 h-2 overflow-hidden rounded-full bg-hairline">
                  <div className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${Math.min(100, ability.score)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-12">
        <SectionHeader en="GROWTH" title="近 7 天真实成长轨迹" desc="学习时长与测评记录来自每日学习会话，不再用固定 W1–W8 模拟增长。" />
        <div className="grid gap-5 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="lf-card p-5">
            <div className="mb-2 text-[14px] font-semibold text-ink">每日学习时长</div>
            <ReactECharts option={weeklyOption(analytics?.stats.weeklyMinutes ?? Array(7).fill(0))} height={270} />
          </div>
          <div className="lf-card p-5">
            <div className="flex items-center justify-between gap-3">
              <div><div className="text-[14px] font-semibold text-ink">今日学习小结</div><div className="mt-1 text-[11px] text-ink-muted">{today?.date ?? localDateKey(0)}</div></div>
              <button type="button" onClick={() => void generateSummary()} disabled={summarizing} className="lf-btn-ghost !px-3 !py-1.5 text-[11.5px]"><Sparkles size={13} />{summarizing ? '生成中…' : '生成总结'}</button>
            </div>
            {today?.summary ? (
              <p className="mt-5 rounded-[12px] border border-brand/20 bg-brand-tint/35 p-4 text-[13px] leading-6 text-ink-2">{today.summary.content}</p>
            ) : (
              <div className="mt-5 rounded-[12px] border border-dashed border-hairline p-5 text-[13px] leading-6 text-ink-muted">{today?.timeline.length ? `今天已有 ${today.timeline.length} 条学习记录，可以生成一份基于真实证据的日总结。` : '今天还没有形成学习轨迹。完成资源、练习或导学后再来生成总结。'}</div>
            )}
            <div className="mt-5 grid grid-cols-2 gap-3 text-center">
              <div className="rounded-[10px] bg-paper-deep p-3"><div className="font-mono text-[20px] font-semibold text-ink">{journalStats.resources}</div><div className="mt-1 text-[10.5px] text-ink-muted">近 7 天资源记录</div></div>
              <div className="rounded-[10px] bg-paper-deep p-3"><div className="font-mono text-[20px] font-semibold text-ink">{Math.round(journalStats.durationSeconds / 60)}</div><div className="mt-1 text-[10.5px] text-ink-muted">近 7 天记录分钟</div></div>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-12">
        <SectionHeader en="LEARNING PATH" title="真实课程学习路径" desc="章节状态由课程和资源完成记录计算；未生成资源的章节不会被标成已学完。" />
        {course && (
          <div className="lf-card overflow-hidden">
            <div className="flex flex-wrap items-center gap-4 border-b border-hairline bg-brand-tint/25 px-5 py-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand text-paper"><Route size={18} /></span>
              <div className="min-w-0 flex-1"><div className="text-[15px] font-semibold text-ink">{course.title}</div><div className="mt-1 text-[11.5px] text-ink-muted">{learnedCount}/{totalCount} 项资源已完成 · 总进度 {progress}%</div></div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-hairline sm:w-44"><div className="h-full rounded-full bg-brand" style={{ width: `${progress}%` }} /></div>
            </div>
            <div className="divide-y divide-hairline">
              {course.chapters.map((chapter) => {
                const count = resourcesByChapter.get(chapter.id) ?? { learned: 0, total: 0 };
                const done = count.total > 0 && count.learned === count.total;
                const active = nextChapter?.id === chapter.id;
                const mastery = Math.round(learningMap.mastery[chapter.id] ?? 0);
                const target = learningMap.nodeTargets?.[chapter.id]?.target ?? 0;
                return (
                  <div key={chapter.id} className={`flex items-start gap-3 px-5 py-4 ${active ? 'bg-brand-tint/20' : ''}`}>
                    {done ? <CheckCircle2 size={19} className="mt-0.5 shrink-0 text-brand" /> : <CircleDashed size={19} className={active ? 'mt-0.5 shrink-0 text-ochre' : 'mt-0.5 shrink-0 text-ink-muted'} />}
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-semibold text-ink">{chapter.index}. {chapter.title}{active && <span className="ml-2 rounded-md bg-brand-amber-tint px-1.5 py-0.5 text-[9.5px] text-ochre">正在这里</span>}</div>
                      <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">{chapter.summary}</p>
                      <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-hairline">
                        <div className="absolute inset-y-0 left-0 rounded-full bg-[#14B8A6]" style={{ width: `${Math.min(100, mastery)}%` }} />
                        {target > 0 && <div className="absolute inset-y-0 w-[3px] rounded-full bg-[#155E9A]" style={{ left: `${Math.min(100, target)}%` }} />}
                      </div>
                      <div className="mt-1 font-mono text-[10.5px] text-ink-muted">掌握度 {mastery}%{target > 0 ? ` · 目标门槛 ${target}%` : ''}</div>
                    </div>
                    <span className="shrink-0 font-mono text-[11px] text-ink-muted">{count.learned}/{count.total}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 近 7 天真实学习记录：与画像页同一套证据源（每日学习会话 + 成长事件） */}
        <div className="mt-4 lf-card p-5">
          <div className="mb-3 flex items-center gap-2">
            <History size={16} className="text-brand" />
            <span className="text-[15px] font-semibold text-ink">近 7 天真实学习记录</span>
          </div>
          {recentEvidence.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-ink-muted">近 7 天还没有学习记录。完成真实讲义、练习或导学后，记录会自动出现在这里。</p>
          ) : (
            <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
              {recentEvidence.slice(0, 12).map((ev) => {
                const meta = evidenceMeta[ev.kind] ?? evidenceMeta.knowledge;
                return (
                  <div key={ev.id} className="relative border-l-2 border-hairline pl-4">
                    <span className="absolute -left-[5px] top-1.5 h-2 w-2 rounded-full bg-brand" />
                    <div className="flex items-center gap-2">
                      <span className={cn('rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium', meta.cls)}>{meta.label}</span>
                      <span className="font-mono text-[10.5px] text-ink-muted">{evidenceTime(ev.occurredAt)}</span>
                    </div>
                    <div className="mt-1 text-[13.5px] font-medium text-ink">{ev.title}</div>
                    <div className="mt-0.5 text-[12px] leading-[18px] text-ink-muted">{ev.description}</div>
                    {(ev.knowledgeName || ev.correctCount != null) && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5 font-mono text-[10.5px] text-ink-muted">
                        {ev.knowledgeName && <span className="rounded-md bg-paper-deep px-1.5 py-0.5">{ev.knowledgeName}</span>}
                        {ev.correctCount != null && <span className="rounded-md bg-paper-deep px-1.5 py-0.5">答对 {ev.correctCount} · 答错 {ev.wrongCount ?? 0}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="mt-12">
        <SectionHeader en="NEXT ACTION" title="下一步建议" desc="主线按真实地图最弱章节给出；六维能力只作佐证，不设目标。" />
        <div className="rounded-[16px] border border-brand/25 bg-brand-tint/35 p-6">
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-paper"><Sparkles size={19} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold text-ink">{weakestChapter ? `优先补齐「${weakestChapter.name}」` : '先完成一次真实学习'}</div>
              <p className="mt-1 text-[13px] leading-6 text-ink-muted">{weakestChapter ? `当前最弱章节是「${weakestChapter.name}」（掌握度 ${Math.round(learningMap.mastery[weakestChapter.id] ?? 0)}% · 进度 ${Math.round(learningMap.chapterProgress[weakestChapter.id] ?? 0)}%）。${weakestChapterDims}${nextResource ? `建议继续“${nextChapter?.title ?? nextResource.topic}”中的${resourceLabel[nextResource.type]}，完成后再用测评校准掌握度。` : '先生成对应章节的讲义与分阶题，形成可验证的学习证据。'}` : '先完成一次真实学习，能力与画像数据会随证据累积。'}</p>
            </div>
            <button
              type="button"
              onClick={() => navigate(learnMapPath(currentLearner.id, nextResource?.kpId ?? weakestChapter?.id))}
              className="lf-btn-primary shrink-0 !px-4 !py-2 text-[12.5px]"
            >
              {nextResource ? '继续学习' : '进入课程'} <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </section>

      {analytics?.recentQuizzes.length ? (
        <section className="mt-12">
          <SectionHeader en="ASSESSMENTS" title="最近测评证据" />
          <div className="lf-card divide-y divide-hairline overflow-hidden">
            {analytics.recentQuizzes.slice(0, 6).map((quiz, index) => (
              <div key={`${quiz.createdAt}-${index}`} className="flex items-center gap-4 px-5 py-4">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-tint text-brand"><BookOpen size={16} /></span>
                <div className="min-w-0 flex-1"><div className="text-[13.5px] font-medium text-ink">{quiz.categoryName ?? '综合测评'}</div><div className="mt-1 font-mono text-[10.5px] text-ink-muted">{quiz.quizType} · {new Date(quiz.createdAt).toLocaleString('zh-CN', { hour12: false })}</div></div>
                <span className="font-mono text-[20px] font-semibold text-brand">{quiz.score == null ? '—' : `${Math.round(quiz.score)}分`}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
