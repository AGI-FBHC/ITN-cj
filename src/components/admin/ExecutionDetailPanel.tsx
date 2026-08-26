import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { AdminGenerationEvent } from '@/lib/api';

function JsonTree({ value }: { value: unknown }) {
  if (value == null) return <span className="jz">—</span>;
  if (typeof value === 'boolean') return <span className="jb">{String(value)}</span>;
  if (typeof value === 'number') return <span className="jn">{String(value)}</span>;
  if (typeof value === 'string') return <span className="js">{JSON.stringify(value)}</span>;
  if (Array.isArray(value)) {
    return (
      <>
        <span className="jp">[</span>
        {value.map((item, index) => (
          <div key={index} className="pl-4">
            <JsonTree value={item} />
            {index < value.length - 1 && <span className="jp">,</span>}
          </div>
        ))}
        <span className="jp">]</span>
      </>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <>
        <span className="jp">{'{'}</span>
        {entries.map(([key, val], index) => (
          <div key={key} className="pl-4">
            <span className="jk">"{key}"</span><span className="jp">: </span>
            <JsonTree value={val} />
            {index < entries.length - 1 && <span className="jp">,</span>}
          </div>
        ))}
        <span className="jp">{'}'}</span>
      </>
    );
  }
  return <span className="jz">—</span>;
}

export default function ExecutionDetailPanel({
  event,
  title,
  taskType,
  taskId,
}: {
  event: AdminGenerationEvent;
  title: string;
  taskType: 'resource' | 'ppt';
  taskId: string;
}) {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fallback, setFallback] = useState(false);
  const snapshot = event.snapshot ?? {};

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSummary(null);
    setFallback(false);
    api.summarizeAdminGenerationEvent(taskType, taskId, event.seq)
      .then((result) => {
        if (cancelled) return;
        setSummary(result.summary);
        setFallback(result.llmFallback);
      })
      .catch(() => {
        if (cancelled) return;
        setSummary(`这个事件已完成：${event.detail || event.title}`);
        setFallback(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [taskType, taskId, event.seq, event.detail, event.title]);

  return (
    <div className="space-y-3">
      <header className="rounded-2xl border border-white/85 bg-white/70 p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-sm font-bold text-ink">{title}</h3>
          <span className="lf-pill lf-pill-null">{event.phase || event.status}</span>
          <span className="ml-auto text-[9px] font-mono text-ink-muted">{event.time ? new Date(event.time).toLocaleString('zh-CN', { hour12: false }) : `记录 #${event.seq}`}</span>
        </div>
        <p className="mt-1.5 text-[10px] font-semibold text-ink-muted">{event.agentName || event.agent}</p>
      </header>

      <section className="rounded-2xl border border-white/80 bg-white/55 p-3">
        <div className="flex items-center justify-between border-b border-white/70 pb-2">
          <h4 className="text-[11px] font-bold text-ink">执行摘要</h4>
          <span className="text-[9px] text-ink-muted">mimo-v2.5 · opencode</span>
        </div>
        <div className="mt-3">
          {loading ? (
            <div className="flex items-center gap-2 rounded-lg bg-white/70 px-3 py-4 text-[10.5px] text-ink-muted">
              <Loader2 size={13} className="animate-spin text-brand" />
              正在生成执行摘要…
            </div>
          ) : (
            <p className="whitespace-pre-wrap rounded-lg bg-white/70 px-3 py-3 text-[11px] leading-6 text-ink-2">
              {summary || '暂时没有可展示的执行摘要。'}
            </p>
          )}
          {!loading && fallback && (
            <p className="mt-2 rounded-lg bg-amber-50/80 px-3 py-2 text-[9px] leading-4 text-amber-800">
              当前为本地兜底说明，生成模型暂不可用；下方原始 JSON 仍保留完整事件数据。
            </p>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-white/80 bg-white/55 p-3">
        <h4 className="border-b border-white/70 pb-2 text-[11px] font-bold text-ink">原始 JSON</h4>
        <div className="lf-json mt-3 p-3 text-[10.5px] leading-5">
          <JsonTree value={{ seq: event.seq, time: event.time, agent: event.agent, agentName: event.agentName, phase: event.phase, status: event.status, title: event.title, detail: event.detail, snapshot }} />
        </div>
      </section>
    </div>
  );
}
