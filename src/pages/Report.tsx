import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, BookOpen, CheckCircle2, CircleDashed, Target } from 'lucide-react';
import PageBack from '@/components/PageBack';
import { useProfile } from '@/context/ProfileContext';
import { learningResourcePath, useCourseLearning } from '@/hooks/useCourseLearning';

const resourceLabel = { lecture: '讲义', practice: '实操', quiz: '分阶题' } as const;

export default function Report() {
  const { currentLearner, domainKnowledgePoints } = useProfile();
  const { loading, course, resources, nextResource, nextChapter, learnedCount, totalCount, progress } = useCourseLearning();

  const abilities = useMemo(() => domainKnowledgePoints.map((point) => {
    const score = currentLearner.scores[point.id] ?? 0;
    return { ...point, score, gap: Math.max(0, point.targetLevel - score) };
  }).sort((left, right) => right.gap - left.gap), [currentLearner.scores, domainKnowledgePoints]);

  const resourcesByChapter = useMemo(() => new Map((course?.chapters ?? []).map((chapter) => {
    const chapterResources = resources.filter((resource) => resource.chapterId === chapter.id);
    return [chapter.id, {
      total: chapterResources.length,
      learned: chapterResources.filter((resource) => resource.learned).length,
    }];
  })), [course, resources]);

  if (loading) {
    return <div className="mx-auto max-w-[980px] px-6 py-16 text-center text-[14px] text-ink-muted">正在读取真实学习数据…</div>;
  }

  return (
    <div className="mx-auto max-w-[1040px] px-5 py-10 md:px-8">
      <PageBack parent={{ label: '我的学习', to: '/me' }} current="学习报告" />

      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
        <div className="lf-mono-label mb-2">REAL LEARNING SNAPSHOT</div>
        <h1 className="font-serif text-[34px] font-bold text-ink">学习报告</h1>
        <p className="mt-2 max-w-[720px] text-[14px] leading-6 text-ink-muted">
          只展示后端已经保存的画像、课程和学习回写。当前尚未积累连续测评记录，因此不生成虚假的周趋势和成长曲线。
        </p>
      </motion.div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="lf-card p-5">
          <div className="text-[12px] text-ink-muted">当前课程</div>
          <div className="mt-2 line-clamp-2 text-[17px] font-semibold text-ink">{course?.title ?? '尚未生成'}</div>
          <div className="mt-3 text-[12px] text-ink-muted">{course ? `${course.chapters.length} 个章节` : '进入“学”页创建课程'}</div>
        </div>
        <div className="lf-card p-5">
          <div className="text-[12px] text-ink-muted">资源学习进度</div>
          <div className="mt-2 font-mono text-[28px] font-semibold text-brand">{learnedCount}/{totalCount}</div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-hairline"><div className="h-full rounded-full bg-brand" style={{ width: `${progress}%` }} /></div>
        </div>
        <div className="lf-card p-5">
          <div className="text-[12px] text-ink-muted">画像诊断置信度</div>
          <div className="mt-2 font-mono text-[28px] font-semibold text-ink">
            {currentLearner.confidence ? `${Math.round(currentLearner.confidence.value * (currentLearner.confidence.value <= 1 ? 100 : 1))}%` : '暂无'}
          </div>
          <div className="mt-3 text-[12px] text-ink-muted">{currentLearner.confidence?.method === 'full' ? '精准定制' : currentLearner.confidence ? '精简建档' : '后端尚未记录'}</div>
        </div>
      </div>

      {nextResource && (
        <Link to={learningResourcePath(nextResource)} className="group mt-6 flex items-center gap-4 rounded-[14px] border border-brand/25 bg-brand-tint/45 p-5 transition hover:bg-brand-tint">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-paper"><BookOpen size={20} /></span>
          <span className="min-w-0 flex-1">
            <span className="text-[11px] font-semibold text-ochre">下一学习项 · {resourceLabel[nextResource.type]}</span>
            <span className="mt-0.5 block truncate text-[15px] font-semibold text-ink">{nextChapter?.title ?? nextResource.topic} · {nextResource.title}</span>
          </span>
          <span className="inline-flex items-center gap-1 text-[13px] font-medium text-brand">继续学习 <ArrowRight size={15} className="transition group-hover:translate-x-0.5" /></span>
        </Link>
      )}

      <section className="mt-10">
        <div className="mb-4 flex items-center gap-2"><Target size={18} className="text-brand" /><h2 className="text-[19px] font-semibold text-ink">画像能力与目标差距</h2></div>
        {abilities.length ? (
          <div className="grid gap-3 md:grid-cols-2">
            {abilities.map((ability) => (
              <div key={ability.id} className="lf-card p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[14px] font-medium text-ink">{ability.name}</span>
                  <span className="font-mono text-[11px] text-ink-muted">当前 {ability.score} · 目标 {ability.targetLevel}</span>
                </div>
                <div className="relative mt-3 h-2 overflow-hidden rounded-full bg-hairline">
                  <div className="absolute inset-y-0 left-0 rounded-full bg-brand/30" style={{ width: `${Math.min(100, ability.targetLevel)}%` }} />
                  <div className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${Math.min(100, ability.score)}%` }} />
                </div>
                <p className="mt-2 text-[12px] text-ink-muted">{ability.gap ? `距离目标还差 ${ability.gap} 分` : '当前评分已达到目标线'}</p>
              </div>
            ))}
          </div>
        ) : <div className="lf-card p-6 text-[13px] text-ink-muted">后端尚未返回画像知识维度。</div>}
      </section>

      <section className="mt-10">
        <div className="mb-4 flex items-center gap-2"><BookOpen size={18} className="text-brand" /><h2 className="text-[19px] font-semibold text-ink">真实课程章节</h2></div>
        {course ? (
          <div className="lf-card divide-y divide-hairline overflow-hidden">
            {course.chapters.map((chapter) => {
              const count = resourcesByChapter.get(chapter.id) ?? { learned: 0, total: 0 };
              const done = count.total > 0 && count.learned === count.total;
              return (
                <div key={chapter.id} className="flex items-start gap-3 px-5 py-4">
                  {done ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-brand" /> : <CircleDashed size={18} className="mt-0.5 shrink-0 text-ink-muted" />}
                  <div className="min-w-0 flex-1"><div className="text-[14px] font-semibold text-ink">{chapter.index}. {chapter.title}</div><p className="mt-1 text-[12.5px] leading-5 text-ink-muted">{chapter.summary}</p></div>
                  <span className="shrink-0 font-mono text-[11px] text-ink-muted">{count.learned}/{count.total}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="lf-card p-7 text-center"><p className="text-[14px] text-ink-muted">当前账号还没有真实课程。</p><Link to="/learn" className="lf-btn-primary mt-4 inline-flex">去生成课程</Link></div>
        )}
      </section>
    </div>
  );
}
