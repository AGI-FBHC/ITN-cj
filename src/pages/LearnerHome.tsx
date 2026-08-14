/**
 * LearnerHome `/me` — 学习者视角首页「我的学习」（单列聚焦版）
 * 顶部导航外壳下的单列内容：问候 → 继续学习(焦点) → 进度条 → 接下来先补两块 → 学习资源列表
 * 窄栏 + 大留白 + 一行一件事，去掉与导航/侧栏重复的板块。
 */
import { useState } from 'react';
import { motion } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import { Play, ArrowRight, BookOpen, Target, PenLine, ListChecks, UserRoundCog, NotebookPen, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useProfile, dataIdOf } from '@/context/ProfileContext';
import { reportForLearner } from '@/data/reportBuilder';
import { learningResourcePath, useCourseLearning } from '@/hooks/useCourseLearning';
import { useLearningMap } from '@/hooks/useLearningMap';
import { getResourcesFor } from '@/data/resources';
import type { GeneratedResource } from '@/data/resources';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import TraceBadge from '@/components/TraceBadge';
import { SprigTop, PottedPlant, LeafDivider } from '@/components/heal/Flora';
import GardenCard from '@/components/heal/GardenCard';
import { useWrongBook } from '@/context/WrongBookContext';
import FirstRunGuide from '@/components/heal/FirstRunGuide';
import WeekReview from '@/components/heal/WeekReview';
import ConfidenceBadge from '@/components/ConfidenceBadge';

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
  const dataId = dataIdOf(currentLearner);
  const report = reportForLearner(currentLearner);
  const resources = getResourcesFor(dataId);

  const path = report.path;
  const doneCount = path.filter((p) => p.status === 'done').length;
  const activeNode = path.find((p) => p.status === 'active') ?? path.find((p) => p.status === 'todo');
  const pathPct = Math.round((doneCount / path.length) * 100);
  const learning = useCourseLearning();
  const learningMap = useLearningMap();
  const mapActive = learningMap.activeKp ? learningMap.domains.find((domain) => domain.id === learningMap.activeKp) : null;
  // 与当前知识地图对齐：最近学习章节优先，否则取掌握度最低的章节作为推荐入口
  const weakestChapter = [...learningMap.domains].sort(
    (a, b) => (learningMap.mastery[a.id] ?? 0) - (learningMap.mastery[b.id] ?? 0),
  )[0];
  const todayChapter = mapActive ?? weakestChapter ?? null;
  const todayDiagnosis = (() => {
    if (!learningMap.domains.length) return currentLearner.diagnosisSummary.replace(/^DIA-01 诊断：/, '');
    const scored = learningMap.domains.map((c) => ({ name: c.name, score: learningMap.mastery[c.id] ?? 0 }));
    const strongest = scored.reduce((a, b) => (b.score > a.score ? b : a));
    const weakest = scored.reduce((a, b) => (b.score < a.score ? b : a));
    return `你在「${strongest.name}」上掌握得最扎实，「${weakest.name}」还需要加强。建议从「${weakest.name}」继续，用分阶题巩固优势维度。`;
  })();
  const primaryLoading = learning.loading && !learning.course && learningMap.loading && !learningMap.activeKp;
  const activeTitle = primaryLoading ? '正在读取真实学习进度…' : todayChapter ? todayChapter.name : learning.nextChapter ? `第 ${learning.nextChapter.index} 章 · ${learning.nextChapter.title}` : activeNode?.title ?? '开启你的第一课';
  const activePath = primaryLoading ? '/me' : todayChapter ? `/learn?kp=${todayChapter.id}` : learning.nextResource ? learningResourcePath(learning.nextResource) : activeNode ? `/learn/${activeNode.kpId}` : '/learn';
  const activeButton = primaryLoading ? '加载中…' : todayChapter ? `继续：${todayChapter.name}` : learning.nextResource ? `继续：${learning.nextResource.title}` : activeNode ? `继续：${activeNode.resourceRef ?? activeNode.title}` : '开始学习';
  const activeEst = todayChapter ? undefined : (learning.nextResource ? undefined : activeNode?.est);

  const topGaps = report.blindSpots.filter((b) => b.priority === '高').slice(0, 2);
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
            <ConfidenceBadge learnerId={currentLearner.id} />
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
            个人知识库
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
      <FirstRunGuide />

      {/* 诗意标语（治愈 · 去焦虑） */}
      <motion.p {...fadeUp} className="mt-5 px-0.5 text-[14px] leading-relaxed text-ink-2">
        <span className="mr-0.5 align-[-2px] text-[20px] text-ochre">「</span>
        每学一点，都是给未来的自己，浇一次水。
        <span className="ml-0.5 align-[-2px] text-[20px] text-ochre">」</span>
      </motion.p>

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
                onClick={() => navigate(activePath)}
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
              更多进展：整体走到 {doneCount}/{path.length} 阶段
            </span>
            <span className="block text-[12px] text-ink-muted">
              还需加强的 {topGaps.length} 块 · 为你做好的资料 {resources.length} 份
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
            const kp = getKnowledgePoint(g.kpId);
            const pct = Math.round((g.score / g.target) * 100);
            return (
              <div key={g.kpId} className="lf-card p-5">
                <div className="flex items-center justify-between">
                  <span className="text-[15px] font-semibold text-ink">{kp.name}</span>
                  <span className="rounded-md bg-brand-danger/10 px-2 py-0.5 font-mono text-[11px] font-medium text-brand-danger">
                    优先级 {g.priority}
                  </span>
                </div>
                <div className="mt-3 flex items-center gap-2 font-mono text-[11.5px] text-ink-muted">
                  <span>现在 {g.score}</span>
                  <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-paper-deep">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-ochre"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span>要到 {g.target}</span>
                </div>
                <p className="mt-3 text-[13px] leading-[20px] text-ink-2">{g.suggestion}</p>
                <button
                  type="button"
                  onClick={() => navigate(`/learn/${g.kpId}`)}
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
          <h3 className="font-serif text-[17px] font-semibold text-ink">AI 给你做好的资料</h3>
          <Link
            to="/resources"
            className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline"
          >
            看全部
            <ArrowRight size={13} />
          </Link>
        </div>
        <div className="space-y-2.5">
          {resources.slice(0, 3).map((r: GeneratedResource) => {
            const meta = formMeta[r.form];
            const kp = getKnowledgePoint(r.kpId);
            return (
              <div
                key={`${r.form}-${r.title}`}
                role="button"
                tabIndex={0}
                /* 带上点的是哪一份，否则落地页会显示另一份资料 */
                onClick={() => navigate(`/resources?tab=${r.form}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') navigate(`/resources?tab=${r.form}`);
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
                  <h4 className="truncate text-[14.5px] font-semibold text-ink">{r.title}</h4>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-muted">
                    <span
                      className="font-medium"
                      style={{ color: meta.color }}
                    >
                      {meta.label}
                    </span>
                    · {kp.name} · {r.levelTag}
                    <span className="flex gap-1">
                      {r.kbRefs.slice(0, 2).map((id) => (
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
