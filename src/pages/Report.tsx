import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
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
  Route,
  Sparkles,
  Target,
} from 'lucide-react';
import { toast } from 'sonner';
import PageBack from '@/components/PageBack';
import SectionHeader from '@/components/SectionHeader';
import { ReactECharts } from '@/components/ChartCard';
import { useProfile } from '@/context/ProfileContext';
import { learningResourcePath, useCourseLearning } from '@/hooks/useCourseLearning';
import { api } from '@/lib/api';
import type { LearnerAnalyticsProfile, LearningJournal, OnboardingKnowledgePoint } from '@/lib/api';

const resourceLabel = { lecture: '讲义', practice: '实操', quiz: '分阶题' } as const;

function localDateKey(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

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
  const { currentLearner, domainKnowledgePoints } = useProfile();
  const { loading: courseLoading, course, resources, nextResource, nextChapter, learnedCount, totalCount, progress } = useCourseLearning();
  const [analytics, setAnalytics] = useState<LearnerAnalyticsProfile | null>(null);
  const [journals, setJournals] = useState<LearningJournal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summarizing, setSummarizing] = useState(false);

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const dates = Array.from({ length: 7 }, (_, index) => localDateKey(index));
      const [profile, ...recentJournals] = await Promise.all([
        api.getLearnerAnalyticsProfile(),
        ...dates.map((date) => api.getLearningJournal(date)),
      ]);
      setAnalytics(profile);
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

  const abilities = useMemo(() => domainKnowledgePoints.map((point) => {
    const score = currentLearner.scores[point.id] ?? 50;
    return { ...point, score };
  }).sort((left, right) => left.score - right.score), [currentLearner.scores, domainKnowledgePoints]);

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
  const weakest = abilities[0] ?? null;
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
          { icon: Target, label: '实测综合掌握度', value: `${overallMastery}%`, note: analytics?.mastery.categories.length ? `${analytics.mastery.categories.length} 个知识分类形成证据` : '完成分阶题后开始累计', tone: 'text-brand' },
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
        <SectionHeader en="DIAGNOSIS" title="六维能力画像" desc="能力分来自后端画像，只做展示，不设目标门槛。" />
        <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="lf-card p-5">
            {domainKnowledgePoints.length ? <ReactECharts option={radarOption(domainKnowledgePoints, currentLearner.scores)} height={350} /> : <div className="py-20 text-center text-[13px] text-ink-muted">画像知识维度尚未建立</div>}
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
        {course ? (
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
                return (
                  <div key={chapter.id} className={`flex items-start gap-3 px-5 py-4 ${active ? 'bg-brand-tint/20' : ''}`}>
                    {done ? <CheckCircle2 size={19} className="mt-0.5 shrink-0 text-brand" /> : <CircleDashed size={19} className={active ? 'mt-0.5 shrink-0 text-ochre' : 'mt-0.5 shrink-0 text-ink-muted'} />}
                    <div className="min-w-0 flex-1"><div className="text-[14px] font-semibold text-ink">{chapter.index}. {chapter.title}{active && <span className="ml-2 rounded-md bg-brand-amber-tint px-1.5 py-0.5 text-[9.5px] text-ochre">正在这里</span>}</div><p className="mt-1 text-[12.5px] leading-5 text-ink-muted">{chapter.summary}</p></div>
                    <span className="shrink-0 font-mono text-[11px] text-ink-muted">{count.learned}/{count.total}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : <div className="lf-card p-7 text-center"><p className="text-[14px] text-ink-muted">当前账号还没有真实课程。</p><Link to="/learn" className="lf-btn-primary mt-4 inline-flex">去生成课程</Link></div>}
      </section>

      <section className="mt-12">
        <SectionHeader en="NEXT ACTION" title="下一步建议" desc="这不是预置 Agent 台词，而是根据当前最大能力差距和未完成资源即时计算。" />
        <div className="rounded-[16px] border border-brand/25 bg-brand-tint/35 p-6">
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-paper"><Sparkles size={19} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold text-ink">{weakest ? `优先补齐「${weakest.name}」` : '先完成一次真实学习'}</div>
              <p className="mt-1 text-[13px] leading-6 text-ink-muted">{weakest ? `当前最弱的是「${weakest.name}」（${weakest.score} 分）。${nextResource ? `建议继续“${nextChapter?.title ?? nextResource.topic}”中的${resourceLabel[nextResource.type]}，完成后再用测评校准掌握度。` : '先生成对应章节的讲义与分阶题，形成可验证的学习证据。'}` : '画像维度尚未建立，先完成建档与课程生成。'}</p>
            </div>
            {nextResource ? <Link to={learningResourcePath(nextResource)} className="lf-btn-primary shrink-0 !px-4 !py-2 text-[12.5px]">继续学习 <ArrowRight size={14} /></Link> : <Link to="/learn" className="lf-btn-primary shrink-0 !px-4 !py-2 text-[12.5px]">进入课程 <ArrowRight size={14} /></Link>}
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
