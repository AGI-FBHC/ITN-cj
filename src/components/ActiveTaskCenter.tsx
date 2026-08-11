import { useEffect, useState } from 'react';
import { Activity, ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react';
import { api, type Course, type LearningResourceGenerationTask, type TeachingGroupEvent } from '@/lib/api';
import { presentationApi, type PresentationTask } from '@/lib/presentationApi';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import LiveDot from '@/components/LiveDot';

type TaskEvent = { time?: string; title: string; detail?: string; agent?: string };
type ActiveTask = {
  id: string;
  kind: 'course' | 'presentation' | 'teaching' | 'resource';
  title: string;
  progress: number;
  stage: string;
  updatedAt?: string;
  events: TaskEvent[];
};

const ACTIVE_PRESENTATION = new Set(['queued', 'analyzing', 'outline_review', 'generating', 'reviewing']);
const ACTIVE_COURSE = new Set(['planning', 'generating']);

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function eventOf(raw: Record<string, unknown>): TaskEvent {
  const data = raw.data && typeof raw.data === 'object' ? raw.data as Record<string, unknown> : {};
  return {
    time: textOf(raw.time) ?? textOf(raw.timestamp) ?? textOf(raw.createdAt),
    title: textOf(raw.title) ?? textOf(raw.type) ?? textOf(raw.phase) ?? textOf(raw.agent) ?? '任务更新',
    detail: textOf(raw.detail) ?? textOf(raw.message) ?? textOf(data.detail) ?? textOf(data.message) ?? textOf(data.output),
    agent: textOf(raw.agent) ?? textOf(data.agent),
  };
}

function teachingEventOf(event: TeachingGroupEvent): TaskEvent {
  return eventOf(event as unknown as Record<string, unknown>);
}

function courseTask(course: Course): ActiveTask {
  return {
    id: course.id,
    kind: 'course',
    title: course.title || '课程资源生成',
    progress: course.progress ?? 0,
    stage: course.stageMessage || 'Agent 正在生成课程资源',
    updatedAt: course.updatedAt,
    events: (course.events ?? []).map((item) => eventOf(item)),
  };
}

function presentationTask(task: PresentationTask): ActiveTask {
  return {
    id: task.id,
    kind: 'presentation',
    title: task.title || '交互课件生成',
    progress: task.progress ?? 0,
    stage: task.stageMessage || 'PPT Agent 正在执行',
    updatedAt: task.updatedAt,
    events: (task.events ?? []).map((item) => eventOf(item)),
  };
}

function resourceTask(task: LearningResourceGenerationTask): ActiveTask {
  return { id: task.id, kind: 'resource', title: task.title, progress: task.progress, stage: task.stageMessage, updatedAt: task.updatedAt, events: task.events.map(eventOf) };
}

export default function ActiveTaskCenter({ learnerId }: { learnerId: string | null }) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<ActiveTask[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const [courseResult, presentationResult, teachingResult, resourceResult] = await Promise.allSettled([
          api.listCourses(learnerId),
          presentationApi.listPresentationSummaries(30),
          api.listTeachingGroupRuns(20, learnerId),
          api.listLearningResourceTasks(40),
        ]);
        const courses = courseResult.status === 'fulfilled'
          ? courseResult.value.courses.filter((course) => ACTIVE_COURSE.has(course.status)).map(courseTask)
          : [];
        const summaries = presentationResult.status === 'fulfilled'
          ? presentationResult.value.tasks.filter((task) => ACTIVE_PRESENTATION.has(task.status))
          : [];
        const presentations = await Promise.all(summaries.map(async (summary) => {
          try { return presentationTask(await presentationApi.getPresentation(summary.id)); }
          catch { return presentationTask({ ...summary, events: [] } as PresentationTask); }
        }));
        const teachingRuns = teachingResult.status === 'fulfilled'
          ? teachingResult.value.runs.filter((run) => run.status === 'running')
          : [];
        const teaching = await Promise.all(teachingRuns.map(async (summary): Promise<ActiveTask> => {
          let run = summary;
          try { run = await api.getTeachingGroupRun(summary.id); } catch { /* summary still shows the current stage */ }
          return {
            id: run.id,
            kind: 'teaching',
            title: run.focus || run.prompt || 'AI 教研组协同',
            progress: 0,
            stage: run.nextAction || '多 Agent 正在协同处理',
            updatedAt: run.updatedAt,
            events: (run.events ?? []).map(teachingEventOf),
          };
        }));
        const resources = resourceResult.status === 'fulfilled'
          ? resourceResult.value.tasks.filter((task) => !['completed', 'failed', 'cancelled'].includes(task.status)).map(resourceTask)
          : [];
        if (!disposed) setTasks([...courses, ...presentations, ...teaching, ...resources].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')));
      } finally {
        if (!disposed) timer = window.setTimeout(load, 1800);
      }
    };
    void load();
    return () => { disposed = true; if (timer) window.clearTimeout(timer); };
  }, [learnerId, open]);

  const latest = tasks[0];
  const label = tasks.length > 0 ? `${tasks.length} 个任务执行中` : '正在执行';
  const kindLabel = (kind: ActiveTask['kind']) => kind === 'course' ? '课程资源' : kind === 'presentation' ? '交互课件' : kind === 'resource' ? '个性资源' : '教研协同';
  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button type="button" className="hidden h-9 items-center gap-2 rounded-[10px] border border-hairline bg-card-warm px-3 text-[12.5px] font-medium text-ink-2 transition-colors hover:border-brand/35 hover:text-ink lg:flex" title={latest?.stage ?? '查看正在执行的任务'}>
          {tasks.length > 0 ? <LiveDot status="thinking" /> : <Activity size={14} className="text-ink-muted" />}
          <span>{label}</span>
          {tasks.length > 0 && <span className="rounded-full bg-brand-amber-tint px-1.5 py-0.5 font-mono text-[10px] text-ochre">{tasks.length}</span>}
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[min(440px,94vw)] overflow-y-auto bg-paper p-0 sm:max-w-[440px]">
        <SheetHeader className="border-b border-hairline px-5 py-4 text-left">
          <SheetTitle className="flex items-center gap-2 font-serif text-[18px] text-ink"><LoaderCircle size={17} className={tasks.length ? 'animate-spin text-brand' : 'text-ink-muted'} />正在执行</SheetTitle>
          <SheetDescription>实时读取后端任务阶段；展开任务后查看完整 Agent 执行日志。</SheetDescription>
        </SheetHeader>
        <div className="space-y-3 p-4">
          {tasks.length === 0 && <div className="rounded-[12px] border border-hairline bg-card-warm px-4 py-8 text-center text-[13px] text-ink-muted">当前没有正在执行的任务</div>}
          {tasks.map((task) => {
            const isExpanded = expanded.has(task.id);
            const latestEvent = task.events[task.events.length - 1];
            return (
              <section key={`${task.kind}-${task.id}`} className="overflow-hidden rounded-[13px] border border-hairline bg-card-warm">
                <button type="button" onClick={() => toggle(task.id)} className="w-full px-4 py-3.5 text-left">
                  <div className="flex items-start gap-2.5">
                    <LiveDot status="thinking" className="mt-1" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><span className="rounded bg-paper-deep px-1.5 py-0.5 text-[10px] text-ink-muted">{kindLabel(task.kind)}</span><span className="truncate text-[13px] font-semibold text-ink">{task.title}</span></div>
                      <p className="mt-1.5 text-[12px] leading-5 text-ink-2">{latestEvent?.detail || latestEvent?.title || task.stage}</p>
                      {task.kind !== 'teaching' && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-paper-deep"><div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${Math.max(3, task.progress)}%` }} /></div>}
                      <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-ink-muted"><span>{task.stage}</span><span>{task.kind === 'teaching' ? `${task.events.length} 条事件` : `${task.progress}%`}</span></div>
                    </div>
                    {isExpanded ? <ChevronDown size={15} className="mt-1 text-ink-muted" /> : <ChevronRight size={15} className="mt-1 text-ink-muted" />}
                  </div>
                </button>
                {isExpanded && (
                  <div className="border-t border-hairline bg-paper/65 px-4 py-3">
                    <div className="space-y-3 border-l border-brand/25 pl-3">
                      {task.events.length === 0 && <p className="text-[11.5px] text-ink-muted">后端暂未写入更细的执行事件，正在等待下一次更新。</p>}
                      {task.events.map((event, index) => (
                        <div key={`${event.time ?? ''}-${index}`} className="relative">
                          <span className="absolute -left-[16.5px] top-1.5 h-1.5 w-1.5 rounded-full bg-brand" />
                          <div className="flex items-center gap-2 text-[11px]"><span className="font-semibold text-ink">{event.title}</span>{event.agent && <span className="font-mono text-[9.5px] text-brand">{event.agent}</span>}</div>
                          {event.detail && <p className="mt-0.5 whitespace-pre-wrap text-[11.5px] leading-[18px] text-ink-2">{event.detail}</p>}
                          {event.time && <div className="mt-0.5 font-mono text-[9px] text-ink-muted">{event.time}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
