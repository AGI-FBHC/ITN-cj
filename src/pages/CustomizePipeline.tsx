/**
 * CustomizePipeline — 用户端资源定制流水线页面
 *
 * 基于管理员母版资源的二次创作过程可视化：
 * 泳道式阶段展示（读取母版 → 内容定制 → 质量审核 → 完成），
 * 任务状态持久化，离开页面后可通过 URL 再进入恢复进度。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Circle, Loader2, Sparkles, X } from 'lucide-react';
import { api } from '@/lib/api';
import type { LearningResourceGenerationTask } from '@/lib/api';
import { cn } from '@/lib/utils';

/** 流水线四个阶段的静态定义（与后端 emit 的进度对齐） */
const STAGES = [
  { key: 'locate', label: '读取母版', at: 10 },
  { key: 'create', label: '内容定制', at: 35 },
  { key: 'review', label: '质量审核', at: 70 },
  { key: 'done', label: '完成', at: 100 },
] as const;

const RESOURCE_LABEL: Record<string, string> = {
  lecture: '定制讲义',
  practice: '实操指南',
  quiz: '分阶测试题',
};

export default function CustomizePipeline() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [task, setTask] = useState<LearningResourceGenerationTask | null>(null);
  const [notFound, setNotFound] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!taskId) return;
    try {
      const next = await api.getCustomizeTask(taskId);
      if (mounted.current) setTask(next);
    } catch {
      if (mounted.current) setNotFound(true);
    }
  }, [taskId]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);

  /* 进行中时每 2 秒轮询，完成后停止 */
  const busy = task != null && !['completed', 'failed', 'cancelled'].includes(task.status);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [busy, refresh]);

  if (notFound) {
    return (
      <div className="mx-auto max-w-[720px] px-4 pt-10">
        <div className="lf-card p-8 text-center">
          <p className="text-[14px] text-ink-muted">定制任务不存在或已被清理。</p>
          <button type="button" onClick={() => navigate('/learn')} className="lf-btn-primary mt-4 inline-flex">返回知识网络</button>
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="mx-auto max-w-[720px] px-4 pt-16 text-center text-[13px] text-ink-muted">
        <Loader2 size={18} className="mx-auto animate-spin text-brand" />
        <p className="mt-3">正在载入定制任务…</p>
      </div>
    );
  }

  const progress = task.progress ?? 0;
  const stageIndex = STAGES.reduce((last, stage, index) => (progress >= stage.at ? index : last), -1);
  const completed = task.status === 'completed';
  const failed = task.status === 'failed' || task.status === 'cancelled';

  return (
    <div className="mx-auto max-w-[860px] px-4 pb-24 pt-6">
      <div className="mb-5 flex items-center gap-2">
        <button type="button" onClick={() => navigate('/learn')} className="inline-flex items-center gap-1 text-[12px] text-ink-muted hover:text-brand">
          <ArrowLeft size={13} />返回知识网络
        </button>
      </div>

      {/* 标题区 */}
      <header className="rounded-[16px] border border-hairline bg-card-warm px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="lf-mono-label flex items-center gap-1.5"><Sparkles size={12} />资源定制 · {RESOURCE_LABEL[task.resourceType] ?? task.resourceType}</div>
            <h1 className="mt-1.5 truncate font-serif text-[19px] font-semibold text-ink">{task.title}</h1>
          </div>
          <span className={cn(
            'shrink-0 rounded-md border px-2 py-1 font-mono text-[11px]',
            completed ? 'border-brand/40 bg-brand-tint text-brand'
              : failed ? 'border-brand-danger/40 bg-brand-danger/10 text-brand-danger'
              : 'border-brand-amber/40 bg-brand-amber-tint text-ochre',
          )}>
            {completed ? '已完成' : failed ? '失败' : '进行中'}
          </span>
        </div>
      </header>

      {/* 泳道阶段 */}
      <section className="mt-5 rounded-[16px] border border-hairline bg-paper p-6">
        <div className="flex items-start justify-between gap-2">
          {STAGES.map((stage, index) => {
            const done = stageIndex > index || (completed && index === STAGES.length - 1);
            const active = !completed && !failed && stageIndex === index;
            const failedHere = failed && stageIndex === index;
            return (
              <div key={stage.key} className="flex min-w-0 flex-1 items-start">
                <div className="flex min-w-0 flex-col items-center gap-2">
                  <span className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border font-mono text-[11px]',
                    done ? 'border-brand bg-brand text-paper'
                      : active ? 'border-brand bg-brand-tint text-brand'
                      : failedHere ? 'border-brand-danger bg-brand-danger/10 text-brand-danger'
                      : 'border-hairline bg-card-warm text-ink-muted',
                  )}>
                    {done ? <Check size={15} /> : failedHere ? <X size={15} /> : active ? <Loader2 size={15} className="animate-spin" /> : <Circle size={15} className="opacity-40" />}
                  </span>
                  <span className={cn('text-center text-[11.5px] leading-4', done || active ? 'font-medium text-ink' : 'text-ink-muted')}>{stage.label}</span>
                </div>
                {index < STAGES.length - 1 && (
                  <div className={cn('mt-[18px] h-[2px] flex-1 rounded-full', stageIndex > index ? 'bg-brand' : 'bg-hairline')} />
                )}
              </div>
            );
          })}
        </div>

        {/* 进度条 */}
        <div className="mt-6">
          <div className="flex items-center justify-between text-[11px] text-ink-muted">
            <span>{task.stageMessage ?? (completed ? '定制完成' : '正在执行')}</span>
            <span className="font-mono text-brand">{progress}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-paper-deep">
            <div className={cn('h-full rounded-full transition-all duration-500', failed ? 'bg-brand-danger' : 'bg-brand')} style={{ width: `${progress}%` }} />
          </div>
        </div>
      </section>

      {/* 执行日志 */}
      <section className="mt-5 rounded-[16px] border border-hairline bg-card-warm p-5">
        <div className="lf-mono-label">执行记录</div>
        <div className="mt-3 space-y-2.5">
          {((task.events ?? []) as Array<{ seq: number; agent?: string; agentName?: string; status?: string; title?: string; detail?: string }>).map((event) => (
            <div key={event.seq} className="flex items-start gap-2.5 text-[12px]">
              <span className={cn(
                'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                event.status === 'completed' ? 'bg-brand' : event.status === 'failed' ? 'bg-brand-danger' : 'bg-brand-amber',
              )} />
              <span className="font-mono text-[10px] text-ink-muted">{event.agentName ?? event.agent}</span>
              <span className="min-w-0 flex-1 text-ink-2"><span className="font-medium text-ink">{event.title}</span>{event.detail ? ` · ${event.detail}` : ''}</span>
            </div>
          ))}
          {!(task.events ?? []).length && <p className="text-[12px] text-ink-muted">等待执行记录…</p>}
        </div>
      </section>

      {/* 完成操作 */}
      {completed && task.resourceId && (
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={() => navigate(`/learn/resource/${task.resourceId}`)}
            className="lf-btn-primary inline-flex items-center gap-1.5"
          >
            开始学习<ArrowRight size={14} />
          </button>
        </div>
      )}
      {failed && (
        <div className="mt-5 rounded-[12px] border border-brand-danger/30 bg-brand-danger/5 px-4 py-3 text-[12.5px] text-ink-2">
          {task.errorMessage ?? '定制过程出现异常，请稍后重试。'}
        </div>
      )}
    </div>
  );
}
