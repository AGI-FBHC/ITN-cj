import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { BookOpen, Sparkles } from 'lucide-react';
import CourseRunView from '@/components/agents/CourseRunView';
import RealTeachingRunView from '@/components/agents/RealTeachingRunView';
import { useProfile } from '@/context/ProfileContext';
import { api } from '@/lib/api';
import type { Course, TeachingGroupRunPayload } from '@/lib/api';

export default function Agents() {
  const { currentLearner } = useProfile();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const teachingRun = (location.state as { teachingRun?: TeachingGroupRunPayload } | null)?.teachingRun;
  const wantsTeachingRun = searchParams.get('run') === 'real';
  const [course, setCourse] = useState<Course | null>(null);
  const [loading, setLoading] = useState(!teachingRun);
  const [error, setError] = useState('');

  useEffect(() => {
    if (teachingRun) return;
    let cancelled = false;
    setLoading(true);
    api.listCourses()
      .then(({ courses }) => {
        if (!cancelled) setCourse(courses?.[0] ?? null);
      })
      .catch((reason) => {
        if (!cancelled) {
          setCourse(null);
          setError(reason instanceof Error ? reason.message : '课程记录读取失败');
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [teachingRun]);

  if (teachingRun?.events.length) {
    return <RealTeachingRunView run={teachingRun} learnerName={currentLearner.name} />;
  }

  if (loading) {
    return <div className="mx-auto max-w-[980px] px-6 py-16 text-center text-[14px] text-ink-muted">正在读取真实 Agent 运行记录…</div>;
  }

  if (wantsTeachingRun && !teachingRun) {
    return (
      <div className="mx-auto max-w-[760px] px-6 py-16 text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-tint text-brand"><Sparkles size={21} /></span>
        <h1 className="mt-4 text-[20px] font-semibold text-ink">这次实时协同没有可回放记录</h1>
        <p className="mt-2 text-[13px] leading-6 text-ink-muted">实时教研组事件目前只随本次页面跳转传递，后端尚未提供运行历史查询接口，因此这里不会用演示脚本补位。</p>
        <div className="mt-5 flex justify-center gap-3">
          <Link to="/me" className="lf-btn-primary">发起真实协同</Link>
          {course && <Link to="/agents?run=course" className="lf-btn-ghost">查看课程生成记录</Link>}
        </div>
      </div>
    );
  }

  if (course) {
    return <CourseRunView course={course} learnerName={currentLearner.name} />;
  }

  return (
    <div className="mx-auto max-w-[760px] px-6 py-16 text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-tint text-brand"><BookOpen size={21} /></span>
      <h1 className="mt-4 text-[20px] font-semibold text-ink">还没有真实课程生成记录</h1>
      <p className="mt-2 text-[13px] text-ink-muted">{error || '先根据当前账号的学习目标生成课程，五个 Agent 的后端事件会显示在这里。'}</p>
      <Link to="/learn" className="lf-btn-primary mt-5 inline-flex">去生成我的课程</Link>
    </div>
  );
}
