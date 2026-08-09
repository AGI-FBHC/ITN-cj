/**
 * CourseRunView — 真实课程生成协同视图。
 * 替代 `/agents?run=course` 的 mock 泳道/消息流，数据来自后端课程对象。
 */
import { useMemo } from 'react';
import { BookOpen, CheckCircle2, Database, PenLine, ShieldCheck, Scale, Sparkles } from 'lucide-react';
import type { Course } from '@/lib/api';
import { agents } from '@/data/agents';
import LiveDot from '@/components/LiveDot';
import { cn } from '@/lib/utils';

const iconByAgent: Record<string, typeof BookOpen> = {
  'DIA-01': BookOpen,
  'RET-02': Database,
  'GEN-03': PenLine,
  'VER-04': ShieldCheck,
  'ARB-05': Scale,
};

export default function CourseRunView({
  course,
  learnerName,
}: {
  course: Course;
  learnerName: string;
}) {
  const events = course.events ?? [];
  const chapters = course.chapters ?? [];

  const statusByAgent = useMemo(() => {
    const statuses: Record<string, 'done' | 'running' | 'idle'> = {
      'DIA-01': 'idle',
      'RET-02': 'idle',
      'GEN-03': 'idle',
      'VER-04': 'idle',
      'ARB-05': 'idle',
    };
    for (const event of events) {
      const agent = String(event.agent ?? '');
      if (agent && statuses[agent] !== undefined) statuses[agent] = 'done';
    }
    if (chapters.some((chapter) => Object.values(chapter.resources ?? {}).some((r) => r.status === 'completed'))) {
      statuses['GEN-03'] = 'done';
      statuses['VER-04'] = 'done';
    }
    if (course.status === 'completed') statuses['ARB-05'] = 'done';
    if (course.status === 'planning' || course.status === 'generating') {
      statuses['ARB-05'] = 'running';
    }
    return statuses;
  }, [course, events, chapters]);

  const outputByAgent: Record<string, string> = {
    'DIA-01': String(events.find((event) => event.agent === 'DIA-01')?.detail ?? '已读取用户目标与画像'),
    'RET-02': String(events.find((event) => event.agent === 'RET-02')?.detail ?? '正在检索知识库证据'),
    'GEN-03': `已生成 ${chapters.length} 个动态章节，正文资源按需生成`,
    'VER-04': '章节资源生成后会执行溯源与质量审核',
    'ARB-05': course.stageMessage || course.status,
  };

  const timeline = useMemo(() => {
    const items = events.map((event, index) => ({
      id: `${event.time}-${index}`,
      agent: String(event.agent ?? 'GEN-03'),
      title: String(event.title ?? ''),
      detail: String(event.detail ?? ''),
      time: String(event.time ?? ''),
    }));
    chapters.forEach((chapter) => {
      items.push({
        id: `chapter-${chapter.id}`,
        agent: 'GEN-03',
        title: `第 ${chapter.index} 章 · ${chapter.title}`,
        detail: chapter.summary || '章节大纲已生成',
        time: chapter.updatedAt,
      });
    });
    return items;
  }, [events, chapters]);

  const completedResources = chapters.reduce(
    (count, chapter) => count + Object.values(chapter.resources ?? {}).filter((r) => r.status === 'completed').length,
    0,
  );
  const failedResources = chapters.reduce(
    (count, chapter) => count + Object.values(chapter.resources ?? {}).filter((r) => r.status === 'failed').length,
    0,
  );

  return (
    <div className="mx-auto max-w-[1320px] px-8 pb-16 pt-6">
      <div className="rounded-[14px] border border-brand/25 bg-brand-tint/40 p-5">
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex h-11 w-11 items-center justify-center rounded-[11px] bg-brand text-paper">
            <Sparkles size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="lf-mono-label !text-[10.5px]">REAL COURSE RUN</div>
            <h1 className="font-serif text-[22px] font-semibold text-ink">{course.title}</h1>
            <p className="mt-1 text-[13px] text-ink-muted">
              {learnerName} · 非演示脚本，课程与章节来自真实目标驱动生成
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-brand/40 bg-brand-tint px-2.5 py-1.5 font-mono text-[11px] text-brand">
            <LiveDot status={course.status === 'completed' ? 'running' : course.status === 'failed' ? 'error' : 'thinking'} />
            {course.stageMessage || course.status} · {course.progress}%
          </span>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <div className="lf-card overflow-hidden">
            <div className="border-b border-hairline px-5 py-3.5">
              <div className="lf-mono-label !text-[10.5px]">AGENT TOPOLOGY</div>
              <h3 className="mt-0.5 text-[16px] font-semibold text-ink">课程生成五体协同</h3>
            </div>
            <div className="divide-y divide-hairline">
              {agents.map((agent) => {
                const status = statusByAgent[agent.id] ?? 'idle';
                const Icon = iconByAgent[agent.id] ?? BookOpen;
                return (
                  <div
                    key={agent.id}
                    className={cn(
                      'flex items-start gap-3 px-5 py-4 transition-colors',
                      status === 'done' ? 'bg-brand-tint/20' : status === 'running' ? 'bg-brand-amber-tint/30' : 'bg-paper',
                    )}
                  >
                    <span
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border"
                      style={{ backgroundColor: `${agent.color}14`, borderColor: `${agent.color}45` }}
                    >
                      <Icon size={18} style={{ color: agent.color }} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[14px] font-semibold text-ink">{agent.name}</span>
                        <span className="font-mono text-[10.5px]" style={{ color: agent.color }}>{agent.code}</span>
                        <span className="ml-auto">
                          <LiveDot status={status === 'running' ? 'thinking' : status === 'done' ? 'running' : 'idle'} />
                        </span>
                      </div>
                      <p className="mt-1 text-[12.5px] leading-[19px] text-ink-2">{outputByAgent[agent.id] ?? agent.duty}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="lg:col-span-7">
          <div className="lf-card flex flex-col overflow-hidden">
            <div className="border-b border-hairline px-5 py-3.5">
              <div className="lf-mono-label !text-[10.5px]">REAL MESSAGE BUS</div>
              <h3 className="mt-0.5 text-[16px] font-semibold text-ink">课程生成消息流</h3>
            </div>
            <div className="max-h-[720px] space-y-2 overflow-y-auto px-4 py-3">
              {timeline.map((item) => (
                <div key={item.id} className="rounded-[10px] border border-hairline bg-card-warm px-3.5 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-brand-tint px-1.5 py-px font-mono text-[10px] font-semibold text-brand">
                      {item.agent}
                    </span>
                    <span className="text-[13px] font-medium text-ink">{item.title}</span>
                    <span className="ml-auto font-mono text-[10.5px] text-ink-muted">{item.time.slice(5, 16)}</span>
                  </div>
                  <p className="mt-1 text-[12px] leading-[18px] text-ink-muted">{item.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <div className="lf-card h-full p-5">
            <div className="lf-mono-label mb-2 !text-[10.5px]">CHAPTER PLAN</div>
            <div className="space-y-2">
              {chapters.map((chapter) => (
                <div key={chapter.id} className="flex items-center gap-2 rounded-[10px] border border-hairline bg-paper px-3 py-2">
                  <span className="font-mono text-[11px] font-semibold text-brand">{chapter.index}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{chapter.title}</span>
                  <CheckCircle2 size={14} className="text-brand" />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="lg:col-span-7">
          <div className="lf-card h-full p-5">
            <div className="lf-mono-label mb-2 !text-[10.5px]">COURSE METRICS</div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['章节', String(chapters.length)],
                ['完成资源', String(completedResources)],
                ['失败资源', String(failedResources)],
                ['进度', `${course.progress}%`],
              ].map(([label, value]) => (
                <div key={label} className="rounded-[10px] border border-hairline bg-card-warm px-3 py-2.5">
                  <div className="font-mono text-[16px] font-semibold text-ink">{value}</div>
                  <div className="font-mono text-[10px] text-ink-muted">{label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
