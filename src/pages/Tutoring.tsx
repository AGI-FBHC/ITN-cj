import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, CircleDashed, Dumbbell } from 'lucide-react';
import PageBack from '@/components/PageBack';
import { learningResourcePath, useCourseLearning } from '@/hooks/useCourseLearning';

export default function Tutoring() {
  const { loading, course, resources } = useCourseLearning();
  const quizzes = resources.filter((resource) => resource.type === 'quiz');
  const nextQuiz = quizzes.find((resource) => !resource.learned) ?? quizzes[0] ?? null;
  const learnedCount = quizzes.filter((resource) => resource.learned).length;

  if (loading) {
    return <div className="mx-auto max-w-[920px] px-6 py-16 text-center text-[14px] text-ink-muted">正在读取真实练习…</div>;
  }

  return (
    <div className="mx-auto max-w-[960px] px-5 py-10 md:px-8">
      <PageBack parent={{ label: '我的学习', to: '/me' }} current="练习中心" />
      <div className="mb-8">
        <div className="lf-mono-label mb-2">COURSE PRACTICE</div>
        <h1 className="font-serif text-[34px] font-bold text-ink">练习中心</h1>
        <p className="mt-2 text-[14px] leading-6 text-ink-muted">题目来自当前课程的后端生成资源，作答结果会写回服务器。这里不再播放前端预设的导学脚本。</p>
      </div>

      {course && nextQuiz ? (
        <>
          <Link to={learningResourcePath(nextQuiz)} className="group flex items-center gap-4 rounded-[14px] border border-brand/25 bg-brand-tint/45 p-5 transition hover:bg-brand-tint">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand text-paper"><Dumbbell size={21} /></span>
            <span className="min-w-0 flex-1">
              <span className="text-[11px] font-semibold text-ochre">下一组真实题目</span>
              <span className="mt-0.5 block truncate text-[16px] font-semibold text-ink">{nextQuiz.title}</span>
              <span className="mt-1 block text-[12px] text-ink-muted">{course.title} · 已完成 {learnedCount}/{quizzes.length} 组</span>
            </span>
            <span className="inline-flex items-center gap-1 text-[13px] font-medium text-brand">开始作答 <ArrowRight size={15} className="transition group-hover:translate-x-0.5" /></span>
          </Link>

          <section className="mt-8">
            <h2 className="mb-3 text-[17px] font-semibold text-ink">按章节练习</h2>
            <div className="lf-card divide-y divide-hairline overflow-hidden">
              {course.chapters.map((chapter) => {
                const quiz = quizzes.find((resource) => resource.chapterId === chapter.id);
                return (
                  <div key={chapter.id} className="flex items-center gap-3 px-5 py-4">
                    {quiz?.learned ? <CheckCircle2 size={18} className="shrink-0 text-brand" /> : <CircleDashed size={18} className="shrink-0 text-ink-muted" />}
                    <div className="min-w-0 flex-1"><div className="text-[14px] font-medium text-ink">{chapter.index}. {chapter.title}</div><div className="mt-0.5 text-[12px] text-ink-muted">{quiz ? (quiz.learned ? '已完成并写回' : '题目已生成，等待作答') : '后端尚未生成分阶题'}</div></div>
                    {quiz ? <Link to={learningResourcePath(quiz)} className="lf-btn-ghost !px-3 !py-1.5 !text-[12px]">{quiz.learned ? '再次练习' : '去作答'}</Link> : <Link to={`/resources?courseId=${encodeURIComponent(course.id)}&chapterId=${encodeURIComponent(chapter.id)}&tab=quiz`} className="lf-btn-ghost !px-3 !py-1.5 !text-[12px]">生成题目</Link>}
                  </div>
                );
              })}
            </div>
          </section>
        </>
      ) : (
        <div className="lf-card p-8 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-tint text-brand"><Dumbbell size={21} /></span>
          <h2 className="mt-4 text-[18px] font-semibold text-ink">还没有可练习的真实题目</h2>
          <p className="mt-2 text-[13px] text-ink-muted">请先生成课程，并在章节资源中生成分阶题。</p>
          <Link to="/learn" className="lf-btn-primary mt-5 inline-flex">进入我的课程</Link>
        </div>
      )}
    </div>
  );
}
