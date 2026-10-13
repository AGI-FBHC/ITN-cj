import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { AlertTriangle, BookOpen, CheckCircle2, Clock3, History, Loader2, Sparkles } from 'lucide-react';
import CourseRunView from '@/components/agents/CourseRunView';
import { AgentIcon } from '@/components/AgentChip';
import { agents } from '@/data/agents';
import RealTeachingRunView from '@/components/agents/RealTeachingRunView';
import { useProfile } from '@/context/ProfileContext';
import { api } from '@/lib/api';
import type { Course, TeachingGroupRunPayload, TeachingGroupRunRecord, TeachingGroupRunSummary } from '@/lib/api';
import { cn } from '@/lib/utils';

function formatTime(value?: string) {
  if (!value) return '刚刚';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function statusText(status: TeachingGroupRunSummary['status']) {
  if (status === 'completed') return '已收敛';
  if (status === 'failed') return '运行失败';
  if (status === 'interrupted') return '连接中断';
  return '运行中';
}

function RunArchive({
  runs,
  activeId,
  loadingId,
  onSelect,
  course,
}: {
  runs: TeachingGroupRunSummary[];
  activeId?: string;
  loadingId?: string;
  onSelect: (run: TeachingGroupRunSummary) => void;
  course: Course | null;
}) {
  return (
    <section className="mx-auto max-w-[1320px] px-4 pt-6 sm:px-8">
      <div className="lf-card overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-hairline px-5 py-3.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-brand-tint text-brand"><History size={16} /></span>
          <div className="min-w-0 flex-1">
            <div className="lf-mono-label !text-[10px]">PERSISTED RUN ARCHIVE</div>
            <h2 className="text-[15px] font-semibold text-ink">真实协同运行档案</h2>
          </div>
          <span className="text-[12px] text-ink-muted">共 {runs.length} 次</span>
          {course && <Link to="/agents?run=course" className="lf-btn-ghost !px-3 !py-1.5 !text-[12px]">课程生成记录</Link>}
        </div>
        <div className="flex gap-2.5 overflow-x-auto px-4 py-3 scrollbar-thin">
          {runs.map((run) => {
            const active = run.id === activeId;
            const failed = run.status === 'failed' || run.status === 'interrupted';
            return (
              <button
                key={run.id}
                type="button"
                onClick={() => onSelect(run)}
                className={cn(
                  'w-[230px] shrink-0 rounded-[11px] border px-3.5 py-3 text-left transition-all',
                  active ? 'border-brand bg-brand-tint/55 shadow-sm' : 'border-hairline bg-paper hover:border-brand/35 hover:bg-brand-tint/20',
                )}
              >
                <div className="flex items-center gap-2">
                  {loadingId === run.id
                    ? <Loader2 size={14} className="animate-spin text-brand" />
                    : failed
                      ? <AlertTriangle size={14} className="text-rust" />
                      : <CheckCircle2 size={14} className="text-brand" />}
                  <span className={cn('font-mono text-[10px] font-semibold', failed ? 'text-rust' : 'text-brand')}>{statusText(run.status)}</span>
                  <span className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-ink-muted"><Clock3 size={11} />{formatTime(run.createdAt)}</span>
                </div>
                <div className="mt-2 truncate text-[13px] font-semibold text-ink">{run.focus || run.knowledgePointId || '教研组协同'}</div>
                <p className="mt-1 line-clamp-2 min-h-[34px] text-[11.5px] leading-[17px] text-ink-muted">
                  {run.nextAction || (failed ? `错误：${run.errorCode || '运行未完成'}` : `${run.eventCount} 条真实事件`)}
                </p>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export default function Agents() {
  const { currentLearner } = useProfile();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const navigationRun = (location.state as { teachingRun?: TeachingGroupRunPayload } | null)?.teachingRun;
  const mode = searchParams.get('run');
  const requestedRunId = searchParams.get('runId');
  const wantsCourse = mode === 'course';
  const wantsTeachingRun = mode === 'real';
  const [course, setCourse] = useState<Course | null>(null);
  const [runs, setRuns] = useState<TeachingGroupRunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<TeachingGroupRunRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingId, setLoadingId] = useState('');
  const [error, setError] = useState('');

  const navigationRunId = useMemo(
    () => navigationRun?.events.find((event) => event.runId)?.runId,
    [navigationRun],
  );

  const selectRun = useCallback(async (run: TeachingGroupRunSummary) => {
    setLoadingId(run.id);
    try {
      const detail = await api.getTeachingGroupRun(run.id);
      setSelectedRun(detail);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '运行记录读取失败');
    } finally {
      setLoadingId('');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.allSettled([
      api.listCourses(currentLearner.id),
      api.listTeachingGroupRuns(30, currentLearner.id),
    ])
      .then(async ([courseResult, runResult]) => {
        if (cancelled) return;
        if (courseResult.status === 'fulfilled') setCourse(courseResult.value.courses?.[0] ?? null);
        if (runResult.status === 'rejected') {
          setError(runResult.reason instanceof Error ? runResult.reason.message : '协同运行记录读取失败');
          return;
        }
        const history = runResult.value.runs ?? [];
        setRuns(history);
        if (navigationRun?.events.length) return;
        const target = history.find((item) => item.id === requestedRunId) ?? history[0];
        if (target) await selectRun(target);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentLearner.id, navigationRun, requestedRunId, selectRun]);

  const activeRun = navigationRun?.events.length ? navigationRun : selectedRun;
  const activeId = navigationRunId || selectedRun?.id;

  if (loading && !activeRun && !wantsCourse) {
    return <div className="mx-auto max-w-[980px] px-6 py-16 text-center text-[14px] text-ink-muted">正在读取真实 Agent 运行档案…</div>;
  }

  if (wantsCourse && course) return <CourseRunView course={course} learnerName={currentLearner.name} />;

  if (activeRun?.events.length) {
    return (
      <>
        {runs.length > 0 && (
          <RunArchive runs={runs} activeId={activeId} loadingId={loadingId} onSelect={(run) => void selectRun(run)} course={course} />
        )}
        <RealTeachingRunView run={activeRun} learnerName={currentLearner.name} />
      </>
    );
  }

  if (wantsTeachingRun || runs.length === 0) {
    return (
      <div className="mx-auto max-w-[860px] px-6 py-14">
        <div className="text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-tint text-brand"><Sparkles size={21} /></span>
          <h1 className="mt-4 text-[20px] font-semibold text-ink">{error ? '读取运行档案失败' : '还没有生成记录'}</h1>
          <p className="mt-2 text-[13px] leading-6 text-ink-muted">{error || '生成一份课程后，可以在这里查看进度和结果；下面是参与协同的五个 Agent。'}</p>
          <div className="mt-5 flex justify-center gap-3">
            <Link to="/me" className="lf-btn-primary">生成课程</Link>
            {course && <Link to="/agents?run=course" className="lf-btn-ghost">查看课程生成记录</Link>}
            <Link to="/collaboration" className="lf-btn-ghost">看教研组协作泳道</Link>
          </div>
        </div>

        {/* 没有运行记录时也把“五个 Agent 是谁”讲清楚，避免入口点进来是死胡同（BUG-032 后续） */}
        <div className="mt-8 grid gap-3 md:grid-cols-2">
          {agents.map((a) => (
            <div key={a.id} className="lf-card flex gap-3 rounded-2xl p-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]" style={{ backgroundColor: `${a.color}1f`, color: a.color }}>
                <AgentIcon agent={a} size={16} />
              </span>
              <span className="min-w-0">
                <span className="flex items-baseline gap-2">
                  <span className="text-[13.5px] font-semibold text-ink">{a.name}</span>
                  <span className="font-mono text-[10px] tracking-wide text-ink-muted">{a.code} · {a.en}</span>
                </span>
                <span className="mt-1 block text-[12px] leading-5 text-ink-2">{a.duty}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[760px] px-6 py-16 text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-tint text-brand"><BookOpen size={21} /></span>
      <h1 className="mt-4 text-[20px] font-semibold text-ink">还没有真实课程生成记录</h1>
      <p className="mt-2 text-[13px] text-ink-muted">{error || '先根据当前账号的学习目标生成课程。'}</p>
      <Link to="/learn" className="lf-btn-primary mt-5 inline-flex">去生成我的课程</Link>
    </div>
  );
}
