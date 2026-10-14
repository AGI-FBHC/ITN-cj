/**
 * LearnerHome `/me` — 学习者视角首页「我的学习」（单列聚焦版）
 * 顶部导航外壳下的单列内容：问候 → 继续学习(焦点) → 进度条 → 接下来先补两块 → 学习资源列表
 * 窄栏 + 大留白 + 一行一件事，去掉与导航/侧栏重复的板块。
 */
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import { History, Play, ArrowRight, BookOpen, Target, PenLine, ListChecks, UserRoundCog, NotebookPen, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useProfile, dataIdOf } from '@/context/ProfileContext';
import { reportForLearner } from '@/data/reportBuilder';
import { learningResourcePath, useCourseLearning } from '@/hooks/useCourseLearning';
import { learnMapPath } from '@/lib/learnNav';
import { useLearningMap } from '@/hooks/useLearningMap';
import { getResourcesFor } from '@/data/resources';
import type { GeneratedResource } from '@/data/resources';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import TraceBadge from '@/components/TraceBadge';
import { SprigTop, PottedPlant, LeafDivider } from '@/components/heal/Flora';
import GardenCard from '@/components/heal/GardenCard';
import { useWrongBook } from '@/context/WrongBookContext';
import { api } from '@/lib/api';
import type { LearnerGrowth } from '@/lib/api';
import WeekReview from '@/components/heal/WeekReview';

const fadeUp = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.2 },
  transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] as const },
};

const formMeta = {
  lecture: { label: '讲义', Icon: BookOpen, color: '#4E7860' },
  guide: { label: '实操指南', Icon: ListChecks, color: '#B77552' },
  quiz: { label: '分阶题', Icon: PenLine, color: '#E7B45A' },
} as const;

/** 进度环 */
function ProgressRing({ value, size = 60 }: { value: number; size?: number }) {
  const stroke = 6;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - value / 100);
  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#DCE6DE" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#4E7860"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={off}
        style={{ transition: 'stroke-dashoffset 0.9s cubic-bezier(0.22,1,0.36,1)' }}
      />
    </svg>
  );
}

export default function LearnerHome() {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();

  const learning = useCourseLearning();
  const learningMap = useLearningMap();

  /*
   * 知识网络首屏并行读 5 个接口（rag/tree、analytics、模板目录、本人资源、PPT 进度），慢的时候要好几秒。
   * 这段时间若直接按“没有章节”渲染，页面就会说“还没有学习记录”“0 块”“0 份”——那是假话：
   * 学习者其实已经有章节进度和定制资源。所以加载期只说“正在读”，读完再下结论。
   */
  const mapLoading = learningMap.loading && learningMap.path.length === 0;
  const isPreset = !currentLearner.custom;
  const report = isPreset ? reportForLearner(currentLearner) : null;
  const resources = isPreset ? getResourcesFor(dataIdOf(currentLearner)) : learning.resources;

  /* 真实用户：路径/进度/盲区全部来自知识网络真实数据；预设画像保留原演示报告 */
  const path = isPreset ? report!.path : learningMap.path;
  const doneCount = isPreset ? path.filter((p) => p.status === 'done').length : learningMap.learned.size;
  const activeNode = isPreset
    ? path.find((p) => p.status === 'active') ?? path.find((p) => p.status === 'todo')
    : path.find((p) => p.status === 'active') ?? path[0] ?? null;
  const pathPct = path.length ? Math.round((doneCount / path.length) * 100) : 0;
  const mapActive = learningMap.activeKp ? learningMap.domains.find((domain) => domain.id === learningMap.activeKp) : null;
  // 与当前知识网络对齐：最近学习章节优先，否则取掌握度最低的章节作为推荐入口
  const weakestChapter = [...learningMap.domains].sort(
    (a, b) => (learningMap.mastery[a.id] ?? 0) - (learningMap.mastery[b.id] ?? 0),
  )[0];
  const todayChapter = mapActive ?? weakestChapter ?? null;
  // 学情描述：基于该章节与其内部知识点的真实统计动态生成，不写死固定话术
  const todayDiagnosis = (() => {
    if (!todayChapter) {
      if (isPreset) return currentLearner.diagnosisSummary.replace(/^DIA-01 诊断：/, '');
      return mapLoading ? '正在读取你的学习进度…' : '还没有学习记录，从知识网络选一个章节开始你的第一课。';
    }
    const chapterId = todayChapter.id;
    const progress = learningMap.chapterProgress[chapterId] ?? 0;
    const mastery = learningMap.mastery[chapterId] ?? 0;
    const topics = learningMap.graphNodes.filter((n) => n.kind === 'topic' && n.kpId === chapterId);
    const topicStats = topics.map((t) => ({
      name: t.label,
      mastery: learningMap.topicMastery[t.id] ?? 0,
      progress: learningMap.topicProgress[t.id] ?? 0,
    }));
    const started = topicStats.filter((t) => t.progress > 0 || t.mastery > 0).length;
    if (progress <= 0 && mastery <= 0 && started === 0) {
      return `本章「${todayChapter.name}」还没有学习记录，建议从这里开始第一课，用分阶题巩固掌握。`;
    }
    const strongest = [...topicStats].sort((a, b) => b.mastery - a.mastery || b.progress - a.progress)[0];
    const weakest = [...topicStats].sort((a, b) => a.mastery - b.mastery || a.progress - b.progress)[0];
    const parts = [`本章学习进度 ${Math.round(progress)}%，掌握度 ${Math.round(mastery)}%。`];
    if (topicStats.length) parts.push(`已覆盖 ${started}/${topicStats.length} 个知识点。`);
    if (strongest && weakest && strongest.name !== weakest.name) {
      parts.push(`其中「${strongest.name}」掌握最好，「${weakest.name}」还需要加强，建议从「${weakest.name}」继续，用分阶题巩固。`);
    } else if (strongest) {
      parts.push(`当前可从「${strongest.name}」继续，用分阶题巩固掌握。`);
    }
    return parts.join(' ');
  })();
  const primaryLoading = learning.loading && !learning.course && learningMap.loading && !learningMap.activeKp;

  const todayTopics = todayChapter
    ? learningMap.graphNodes
        .filter((node) => node.kind === 'topic' && node.kpId === todayChapter.id)
        .sort((left, right) => (left.topicIndex ?? 99) - (right.topicIndex ?? 99))
    : [];
  const continueTopic = todayTopics.find((topic) => (learningMap.topicProgress[topic.id] ?? 0) < 100) ?? todayTopics[0] ?? null;
  const activeTitle = primaryLoading || mapLoading ? '正在加载学习进度…' : todayChapter ? todayChapter.name : learning.nextChapter ? `第 ${learning.nextChapter.index} 章 · ${learning.nextChapter.title}` : activeNode?.title ?? '开启你的第一课';
  const activePath = primaryLoading ? '/me' : todayChapter ? learnMapPath(currentLearner.id, todayChapter.id, continueTopic?.id) : learning.nextResource ? learningResourcePath(learning.nextResource) : activeNode ? `/learn/${activeNode.kpId}` : '/learn';
  const activeButton = primaryLoading || mapLoading ? '加载中…' : todayChapter ? (continueTopic ? `继续：${continueTopic.label}` : `继续：${todayChapter.name}`) : learning.nextResource ? `继续：${learning.nextResource.title}` : activeNode ? `继续：${activeNode.resourceRef ?? activeNode.title}` : '开始学习';
  const goActive = () => {
    if (isPreset) { navigate(activePath); return; }
    if (todayChapter) { navigate(learnMapPath(currentLearner.id, todayChapter.id, continueTopic?.id)); return; }
    if (learning.nextResource) { navigate(learningResourcePath(learning.nextResource)); return; }
    navigate(learnMapPath(currentLearner.id));
  };
  const activeEst = todayChapter ? undefined : (learning.nextResource ? undefined : activeNode?.est);

  /* 真实用户：推荐 = 知识点级，按目标门槛与当前掌握度的差距取最需加强的两个子知识点 */
  type TopicGap = {
    kpId: string;
    topicId: string;
    topicIndex: number;
    name: string;
    chapterName: string;
    score: number;
    progress: number;
    target: number;
    gap: number;
    priority: string;
    suggestion: string;
  };
  const topGaps: TopicGap[] = isPreset
    ? report!.blindSpots
        .filter((b) => b.priority === '高')
        .slice(0, 2)
        .map((b) => ({
          kpId: b.kpId,
          topicId: b.kpId,
          topicIndex: 0,
          name: getKnowledgePoint(b.kpId).name,
          chapterName: '',
          score: b.score,
          progress: 0,
          target: b.target,
          gap: b.gap,
          priority: b.priority,
          suggestion: b.suggestion,
        }))
    : learningMap.graphNodes
        .filter((n) => n.kind === 'topic')
        .map((n) => {
          const chapter = learningMap.domains.find((d) => d.id === n.kpId);
          const score = learningMap.topicMastery[n.id] ?? 0;
          const progress = learningMap.topicProgress[n.id] ?? 0;
          const target = learningMap.nodeTargets[n.id]?.target
            ?? learningMap.nodeTargets[n.kpId]?.target
            ?? 80;
          return {
            kpId: n.kpId,
            topicId: n.id,
            topicIndex: n.topicIndex ?? 0,
            name: n.label,
            chapterName: chapter?.name ?? n.kpId,
            score,
            progress,
            target,
            gap: target - score,
            priority: '高' as const,
            suggestion: progress > 0 || score > 0
              ? `已学部分内容，掌握度 ${Math.round(score)}%，建议继续巩固到目标 ${target}%。`
              : '还没开始，建议从这里开始第一课。',
          };
        })
        .filter((g) => g.gap > 0)
        .sort((a, b) => b.gap - a.gap)
        .slice(0, 2);
  /*
   * 最近学习轨迹（W2）：来源就是 /learner-profile/growth 的成长事件 —— 真实记录，不是编的。
   * 原始事件里同一个知识点会反复出现（每答一题一条），所以先按天、按动作归类再计数：
   * 页面上一行说清「哪天做了什么」，细节留给「我的成长」里的完整轨迹。
   */
  const [growth, setGrowth] = useState<LearnerGrowth | null>(null);
  const growthLearnerId = currentLearner.custom && /^[0-9a-f]{8}-/i.test(currentLearner.id) ? currentLearner.id : '';
  useEffect(() => {
    if (!growthLearnerId) { setGrowth(null); return undefined; }
    let cancelled = false;
    api.getLearnerGrowth(growthLearnerId)
      .then((data) => { if (!cancelled) setGrowth(data); })
      .catch(() => { if (!cancelled) setGrowth(null); });
    return () => { cancelled = true; };
  }, [growthLearnerId]);
  const trackDays = (() => {
    const events = growth?.events ?? [];
    if (!events.length) return [];
    const actionOf = (eventType: string, title: string) => {
      if (eventType === 'note-taken' || title.indexOf('笔记') >= 0) return '记笔记';
      if (eventType === 'nourish') return '滋养园子';
      if (eventType === 'focus-bonus' || title.indexOf('学习了') >= 0) return '答题学习';
      if (title.indexOf('画像') >= 0) return '画像更新';
      return '其他';
    };
    const pad = (value: number) => String(value).padStart(2, '0');
    const dayKey = (value: string | Date) => {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    };
    const byDay = new Map<string, Map<string, number>>();
    for (const event of events) {
      const key = dayKey(event.createdAt);
      if (!key) continue;
      const action = actionOf(event.eventType, event.title);
      if (!byDay.has(key)) byDay.set(key, new Map());
      const bucket = byDay.get(key)!;
      bucket.set(action, (bucket.get(action) ?? 0) + 1);
    }
    const todayKey = dayKey(new Date());
    return Array.from(byDay.entries())
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, 4)
      .map(([key, bucket]) => {
        const parts = key.split('-');
        const label = key === todayKey ? '今天' : (Number(parts[1]) + ' 月 ' + Number(parts[2]) + ' 日');
        const summary = Array.from(bucket.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([action, count]) => action + ' × ' + count)
          .join(' · ');
        return { key, label, summary };
      });
  })();

  /* 更多进展默认折叠：首屏只回答「现在做什么」 */
  const [moreOpen, setMoreOpen] = useState(false);
  const { items: wrongItems } = useWrongBook();
  const wrongCount = wrongItems.length;

  return (
    <div className="mx-auto max-w-[840px] px-5 pb-24 pt-8 md:px-6">
      {/* ============ 问候 ============ */}
      <motion.section {...fadeUp} className="flex flex-wrap items-center gap-4">
        <Avatar className="h-14 w-14 border border-hairline shadow-warm">
          <AvatarImage src={currentLearner.avatar} alt={currentLearner.name} />
          <AvatarFallback className="bg-brand-tint text-brand">
            {currentLearner.name.slice(0, 1)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <h1 className="font-serif text-[26px] font-semibold leading-[32px] text-ink">
            你好，{currentLearner.name}
          </h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-ink-muted">
            <span>{currentLearner.tag} · {currentLearner.targetJob} · 每周可投入 {currentLearner.weeklyHours}h</span>
          </p>
        </div>
        <span className="ml-auto flex items-center gap-2">
          <Link
            to="/me/wrong"
            className="inline-flex items-center gap-1.5 rounded-[10px] border border-hairline bg-card-warm px-3 py-1.5 text-[13px] font-medium text-ink-2 transition-all hover:border-brand/35 hover:text-brand"
          >
            <X size={15} className={wrongCount > 0 ? 'text-brand-danger' : undefined} />
            错题本
            {wrongCount > 0 && (
              <span className="rounded bg-brand-danger/12 px-1.5 font-mono text-[11px] font-semibold text-brand-danger">
                {wrongCount}
              </span>
            )}
          </Link>
          <Link
            to="/me/notes"
            className="inline-flex items-center gap-1.5 rounded-[10px] border border-hairline bg-card-warm px-3 py-1.5 text-[13px] font-medium text-ink-2 transition-all hover:border-brand/35 hover:text-brand"
          >
            <NotebookPen size={15} />
            我的笔记
          </Link>
          <Link
            to="/me/profile"
            className="inline-flex items-center gap-1.5 rounded-[10px] border border-hairline bg-card-warm px-3 py-1.5 text-[13px] font-medium text-ink-2 transition-all hover:border-brand/35 hover:text-brand"
          >
            <UserRoundCog size={15} />
            我的画像
          </Link>
        </span>
      </motion.section>

      {/* 首次使用引导：这是什么 / 你在哪 / 先做哪一步 */}

      {/* ============ 今天就学这一件（唯一焦点） ============ */}
      <motion.section {...fadeUp} className="relative mt-8">
        {/* 破框植物：叶 + 浆果 + 金蕊小花 */}
        <SprigTop className="absolute -top-11 right-7 z-10 h-[78px] w-[132px]" />
        <div className="lf-card lf-glow-card relative p-7">
          {/* 小盆栽（右下角，暖陶盆） */}
          <PottedPlant className="absolute -bottom-1.5 right-8 hidden h-[66px] w-[56px] sm:block" />
          <div className="relative">
            <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-brand-tint px-2.5 py-1 text-[11.5px] font-semibold text-brand">
              <span className="h-1.5 w-1.5 rounded-full bg-brand" />
              今天就学这一件
            </div>
            <h2 className="font-serif text-[24px] font-semibold leading-[32px] text-ink">
              {activeTitle}
            </h2>
            <p className="mt-2.5 text-[14.5px] leading-[24px] text-ink-2">
              {todayDiagnosis}
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={goActive}
                className="lf-btn-primary group"
              >
                <Play size={15} fill="currentColor" className="transition-transform group-hover:translate-x-[3px]" />
                {activeButton}
              </button>
              {activeEst && (
                <span className="lf-chip !py-1 font-mono text-[12px] text-ink-muted">
                  {activeEst}
                </span>
              )}
            </div>
          </div>
        </div>
      </motion.section>

      {/* ============ 我的园子（树 + 养分 + 该复习的，合为一条因果链） ============ */}
      <motion.section {...fadeUp} className="mt-5">
        <GardenCard />
      </motion.section>

      {/* ============ 本周回顾（去焦虑：只讲长进，不算欠账） ============ */}
      <motion.section {...fadeUp} className="mt-4">
        <WeekReview />

      {/* ============ 最近学习轨迹（W2）：真实成长事件，按天归类 ============ */}
      {trackDays.length > 0 && (
        <motion.section {...fadeUp} className="mt-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <History size={16} className="text-brand" />
              <h3 className="font-serif text-[17px] font-semibold text-ink">最近学习轨迹</h3>
            </div>
            <Link to="/report" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-brand hover:underline">
              看完整报告
              <ArrowRight size={13} />
            </Link>
          </div>
          <div className="lf-card divide-y divide-hairline overflow-hidden">
            {trackDays.map((day) => (
              <div key={day.key} className="flex items-baseline gap-3 px-5 py-3">
                <span className="w-[72px] shrink-0 font-mono text-[11.5px] text-ink-muted">{day.label}</span>
                <span className="text-[13px] leading-[20px] text-ink-2">{day.summary}</span>
              </div>
            ))}
          </div>
        </motion.section>
      )}
      </motion.section>

      {/* 叶形分割线 */}
      <LeafDivider className="mt-8" />

      {/* ============ 更多进展（默认折叠：少即是清楚） ============ */}
      <motion.section {...fadeUp} className="mt-5">
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          className="flex w-full items-center gap-3 rounded-[14px] border border-hairline bg-card-warm/70 px-4 py-3 text-left transition-all hover:border-brand/40"
        >
          <span className="relative shrink-0">
            <ProgressRing value={pathPct} size={40} />
            <span className="absolute inset-0 flex items-center justify-center font-mono text-[11px] font-semibold text-ink tabular">
              {pathPct}%
            </span>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium text-ink">
            {path.length > 0
              ? `更多进展：整体走到 ${doneCount}/${path.length} 阶段`
              : mapLoading ? '更多进展：正在读取学习进度…' : '更多进展：还没有学习记录'}
            </span>
            <span className="block text-[12px] text-ink-muted">
              {/* 资料数只在拉到之后才说：加载期报 0 与页面下方列出的资料自相矛盾 */}
              还需加强的 {topGaps.length} 块 · {learning.loading && resources.length === 0 ? '正在汇总资料…' : `可学资料 ${resources.length} 份`}
            </span>
          </span>
          <ChevronDown size={16} className={cn('shrink-0 text-ink-muted transition-transform', moreOpen && 'rotate-180')} />
        </button>
      </motion.section>

      {!moreOpen ? null : (
      <>
      {/* ============ 还需加强 ============ */}
      <motion.section {...fadeUp} className="mt-5">
        <div className="mb-3 flex items-center gap-2">
          <Target size={17} className="text-ochre" />
          <h3 className="font-serif text-[17px] font-semibold text-ink">还需加强的两块</h3>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {topGaps.map((g) => {
            const kpName = isPreset
              ? getKnowledgePoint(g.kpId).name
              : `${g.chapterName} · ${g.name}`;
            const pct = g.target > 0 ? Math.round((g.score / g.target) * 100) : 0;
            return (
              <div key={g.topicId ?? g.kpId} className="lf-card p-5">
                <div className="flex items-center justify-between">
                  <span className="text-[15px] font-semibold text-ink">{kpName}</span>
                  {!isPreset && (
                    <span className="rounded-md bg-brand-tint/70 px-2 py-0.5 font-mono text-[11px] font-medium text-brand">
                      目标 {Math.round(g.target)}%
                    </span>
                  )}
                </div>
                <div className="mt-3 flex items-center gap-2 font-mono text-[11.5px] text-ink-muted">
                  <span>掌握度 {Math.round(g.score)}%</span>
                  <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-paper-deep">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-ochre"
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                  <span>进度 {Math.round(g.progress)}%</span>
                </div>
                <p className="mt-3 text-[13px] leading-[20px] text-ink-2">
                  {isPreset ? g.suggestion : g.suggestion}
                </p>
                <button
                  type="button"
                  onClick={() => navigate(isPreset ? `/learn/${g.kpId}` : learnMapPath(currentLearner.id, g.kpId, g.topicId))}
                  className="lf-btn-ghost mt-4 !px-4 !py-1.5 text-[13px]"
                >
                  去学这块
                  <ArrowRight size={13} />
                </button>
              </div>
            );
          })}
        </div>
      </motion.section>

      {/* ============ 学习资源（列表式） ============ */}
      <motion.section {...fadeUp} className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-serif text-[17px] font-semibold text-ink">学习资料</h3>
          <Link
            to="/resources"
            className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline"
          >
            看全部
            <ArrowRight size={13} />
          </Link>
        </div>
        <div className="space-y-2.5">
          {resources.slice(0, 3).map((r, index) => {
            const real = r as import('@/lib/api').LearningResourceSummary;
            const form = isPreset ? (r as GeneratedResource).form : (real.type === 'practice' ? 'guide' : real.type);
            const meta = formMeta[form];
            const title = isPreset ? (r as GeneratedResource).title : real.title;
            const kpName = isPreset
              ? getKnowledgePoint((r as GeneratedResource).kpId).name
              : (learningMap.domains.find((d) => d.id === real.kpId)?.name ?? real.topic);
            const to = isPreset
              ? `/resources?tab=${form}`
              : learningResourcePath(real);
            return (
              <div
                key={`${form}-${title}-${index}`}
                role="button"
                tabIndex={0}
                onClick={() => navigate(to)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') navigate(to);
                }}
                className="lf-card lf-card-hover group flex items-center gap-4 p-4 text-left"
              >
                <span
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[11px] border"
                  style={{ color: meta.color, borderColor: `${meta.color}45`, backgroundColor: `${meta.color}0D` }}
                >
                  <meta.Icon size={19} strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <h4 className="truncate text-[14.5px] font-semibold text-ink">{title}</h4>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-muted">
                    <span
                      className="font-medium"
                      style={{ color: meta.color }}
                    >
                      {meta.label}
                    </span>
                    · {kpName}
                    {!isPreset && (
                      <span className="rounded bg-brand-tint/60 px-1.5 py-0.5 font-mono text-[10.5px] text-brand">
                        {real.learned ? '已学' : real.started ? '学习中' : '未学'}
                      </span>
                    )}
                    <span className="flex gap-1">
                      {!isPreset ? null : (r as GeneratedResource).kbRefs.slice(0, 2).map((id) => (
                        <TraceBadge key={id} kbId={id} />
                      ))}
                    </span>
                  </p>
                </div>
                <ArrowRight
                  size={15}
                  className="shrink-0 text-ink-muted transition-transform duration-200 group-hover:translate-x-1 group-hover:text-brand"
                />
              </div>
            );
          })}
        </div>
      </motion.section>
      </>
      )}
    </div>
  );
}
