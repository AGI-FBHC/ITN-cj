import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, BookOpen, CheckCircle2, ListChecks, Loader2, NotebookPen, PenLine, Play, Target, UserRoundCog, X } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import ConfidenceBadge from '@/components/ConfidenceBadge';
import { useProfile } from '@/context/ProfileContext';
import { learningResourcePath, useCourseLearning } from '@/hooks/useCourseLearning';
import { cn } from '@/lib/utils';
import FirstRunGuide from '@/components/heal/FirstRunGuide';
import GardenCard from '@/components/heal/GardenCard';
import WeekReview from '@/components/heal/WeekReview';
import { LeafDivider } from '@/components/heal/Flora';

const resourceMeta = {
  lecture: { label: '讲义', Icon: BookOpen },
  practice: { label: '实操', Icon: ListChecks },
  quiz: { label: '分阶题', Icon: PenLine },
} as const;

function ProgressRing({ value }: { value: number }) {
  const radius = 25;
  const circumference = 2 * Math.PI * radius;
  return <svg width="58" height="58" className="-rotate-90"><circle cx="29" cy="29" r={radius} fill="none" stroke="#DCE6DE" strokeWidth="6" /><circle cx="29" cy="29" r={radius} fill="none" stroke="#4E7860" strokeWidth="6" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - value / 100)} /></svg>;
}

export default function LearnerHome() {
  const { currentLearner, domainKnowledgePoints } = useProfile();
  const learning = useCourseLearning();
  const gaps = [...domainKnowledgePoints]
    .map((point) => ({ ...point, score: currentLearner.scores[point.id] ?? 50, gap: point.targetLevel - (currentLearner.scores[point.id] ?? 50) }))
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 2);

  return (
    <div className="mx-auto max-w-[900px] px-5 pb-24 pt-8 md:px-6">
      <section className="flex flex-wrap items-center gap-4">
        <Avatar className="h-14 w-14 border border-hairline shadow-warm"><AvatarImage src={currentLearner.avatar} alt={currentLearner.name} /><AvatarFallback className="bg-brand-tint text-brand">{currentLearner.name.slice(0, 1)}</AvatarFallback></Avatar>
        <div className="min-w-0"><h1 className="font-serif text-[26px] font-semibold text-ink">你好，{currentLearner.name}</h1><p className="mt-0.5 flex flex-wrap items-center gap-2 text-[13px] text-ink-muted"><span>{currentLearner.targetJob} · 每周 {currentLearner.weeklyHours}h</span><ConfidenceBadge learnerId={currentLearner.id} /></p></div>
        <div className="ml-auto flex flex-wrap gap-2"><Link to="/me/wrong" className="lf-btn-ghost !px-3 !py-1.5 text-[12px]"><X size={14} />错题本</Link><Link to="/me/notes" className="lf-btn-ghost !px-3 !py-1.5 text-[12px]"><NotebookPen size={14} />个人知识库</Link><Link to="/me/profile" className="lf-btn-ghost !px-3 !py-1.5 text-[12px]"><UserRoundCog size={14} />我的画像</Link></div>
      </section>

      <FirstRunGuide />
      <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-5 px-0.5 text-[14px] leading-relaxed text-ink-2">
        <span className="mr-0.5 align-[-2px] text-[20px] text-ochre">「</span>
        每学一点，都是给未来的自己，浇一次水。
        <span className="ml-0.5 align-[-2px] text-[20px] text-ochre">」</span>
      </motion.p>

      {learning.loading && <div className="mt-8 flex items-center justify-center gap-2 rounded-[14px] border border-hairline bg-card-warm py-14 text-[13px] text-ink-muted"><Loader2 size={16} className="animate-spin" />正在读取真实学习进度…</div>}

      {!learning.loading && !learning.course && <section className="mt-8 rounded-[16px] border border-brand/20 bg-brand-tint/30 p-8 text-center"><h2 className="font-serif text-[21px] font-semibold text-ink">还没有属于你的课程</h2><p className="mt-2 text-[13px] text-ink-muted">完成画像后，让 AI 根据你的目标生成课程和章节资源。</p><Link to="/learn" className="lf-btn-primary mt-5 inline-flex">生成我的课程<ArrowRight size={14} /></Link></section>}

      {!learning.loading && learning.course && <>
        <motion.section initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="mt-8 rounded-[18px] border border-brand/25 bg-brand-tint/35 p-6 md:p-7">
          <div className="flex items-start gap-4">
            <div className="relative shrink-0"><ProgressRing value={learning.progress} /><span className="absolute inset-0 flex items-center justify-center font-mono text-[11px] font-semibold text-brand">{learning.progress}%</span></div>
            <div className="min-w-0 flex-1"><div className="lf-mono-label">真实课程进度 · {learning.learnedCount}/{learning.totalCount} 项资源</div><h2 className="mt-1 font-serif text-[23px] font-semibold text-ink">{learning.course.title}</h2><p className="mt-1 text-[13px] leading-5 text-ink-muted">{learning.course.description}</p></div>
          </div>
          {learning.nextResource && learning.nextChapter ? <div className="mt-6 rounded-[13px] border border-hairline bg-card-warm p-5"><span className="text-[11px] font-medium text-brand">接下来学习</span><h3 className="mt-1 text-[16px] font-semibold text-ink">第 {learning.nextChapter.index} 章 · {learning.nextChapter.title}</h3><p className="mt-1 text-[13px] text-ink-muted">{resourceMeta[learning.nextResource.type].label}：{learning.nextResource.title}</p><Link to={learningResourcePath(learning.nextResource)} className="lf-btn-primary mt-4 inline-flex"><Play size={14} fill="currentColor" />继续学习</Link></div> : <div className="mt-5 flex items-center gap-2 rounded-[12px] bg-card-warm p-4 text-[13px] text-brand"><CheckCircle2 size={17} />当前课程资源已经全部学完</div>}
        </motion.section>

        <motion.section initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="mt-5">
          <GardenCard course={learning.course} resources={learning.resources} />
        </motion.section>
        <section className="mt-4"><WeekReview /></section>
        <LeafDivider className="mt-8" />

        <section className="mt-7"><div className="mb-3 flex items-center gap-2"><Target size={16} className="text-ochre" /><h3 className="font-serif text-[18px] font-semibold text-ink">画像中的优先补强方向</h3></div><div className="grid gap-3 sm:grid-cols-2">{gaps.map((gap) => <div key={gap.id} className="rounded-[14px] border border-hairline bg-card-warm p-5"><div className="flex items-center justify-between"><span className="font-semibold text-ink">{gap.name}</span><span className={cn('font-mono text-[11px]', gap.gap > 20 ? 'text-brand-danger' : 'text-ochre')}>差距 {Math.max(0, gap.gap)}</span></div><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-paper-deep"><div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(0, Math.min(100, gap.score))}%` }} /></div><p className="mt-2 text-[12px] text-ink-muted">当前 {gap.score} · 目标 {gap.targetLevel}</p></div>)}</div></section>

        <section className="mt-8"><div className="mb-3 flex items-center justify-between"><h3 className="font-serif text-[18px] font-semibold text-ink">最近的真实学习资源</h3><Link to="/resources" className="inline-flex items-center gap-1 text-[12px] text-brand hover:underline">查看全部<ArrowRight size={12} /></Link></div><div className="space-y-2.5">{learning.resources.slice(0, 5).map((resource) => { const Meta = resourceMeta[resource.type]; return <Link key={resource.id} to={learningResourcePath(resource)} className="group flex items-center gap-3 rounded-[13px] border border-hairline bg-card-warm p-4 transition-colors hover:border-brand/40"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-tint text-brand"><Meta.Icon size={16} /></span><span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium text-ink">{resource.title}</span><span className="mt-0.5 block text-[11px] text-ink-muted">{Meta.label} · {resource.learned ? '已学完' : '待学习'}</span></span><ArrowRight size={14} className="text-ink-muted transition-transform group-hover:translate-x-1" /></Link>; })}</div></section>
      </>}
    </div>
  );
}
