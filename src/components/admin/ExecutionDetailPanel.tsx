import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2 } from 'lucide-react';
import { lectureMdComponents } from '@/components/resources/lecture-markdown';
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
  running = false,
  summaryLoading = false,
}: {
  event: AdminGenerationEvent;
  title: string;
  running?: boolean;
  summaryLoading?: boolean;
}) {

  const snapshot = event.snapshot ?? {};
  const rawSummary = typeof event.executionSummary === 'string' ? event.executionSummary.trim() : '';
  const summary = rawSummary || (typeof event.detail === 'string' ? event.detail.trim() : '');

  return (
    <div className="space-y-3">
      <header className="min-h-[76px] rounded-2xl border border-white/85 bg-white/70 p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-sm font-bold text-ink">{event.agentName || event.agent}</h3>
          <span className="ml-auto text-[9px] font-mono text-ink-muted">{event.time ? new Date(event.time).toLocaleString('zh-CN', { hour12: false }) : `记录 #${event.seq}`}</span>
        </div>
        <p className="mt-1.5 text-[10px] font-semibold text-ink-muted">{title}</p>
      </header>

      <section className="rounded-2xl border border-white/80 bg-white/55 p-3">
        <div className="flex items-center justify-between border-b border-white/70 pb-2">
          <h4 className="text-[11px] font-bold text-ink">执行摘要</h4>
        </div>
        <div className="mt-3 min-h-[240px] overflow-y-auto">
          {summary ? (
            <div className="rounded-lg bg-white/70 px-3 py-3 text-[11px] leading-6 text-ink-2">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={lectureMdComponents}>{summary}</ReactMarkdown>
            </div>
          ) : summaryLoading ? (
            <div className="flex items-center gap-2 rounded-lg bg-white/70 px-3 py-4 text-[10.5px] text-ink-muted"><Loader2 size={13} className="animate-spin text-brand" />正在生成执行摘要…</div>
          ) : running ? (
            <div className="flex items-center gap-2 rounded-lg bg-white/70 px-3 py-4 text-[10.5px] text-ink-muted"><Loader2 size={13} className="animate-spin text-brand" />正在执行…</div>
          ) : (
            <div className="rounded-lg bg-white/70 px-3 py-4 text-[10.5px] text-ink-muted">暂无执行摘要。</div>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-white/80 bg-white/55 p-3">
        <h4 className="border-b border-white/70 pb-2 text-[11px] font-bold text-ink">原始 JSON</h4>
        <div className="lf-json mt-3 min-h-[280px] max-h-[380px] overflow-y-auto p-3 text-[10.5px] leading-5">
          <JsonTree value={{ seq: event.seq, time: event.time, agent: event.agent, agentName: event.agentName, phase: event.phase, status: event.status, title: event.title, detail: event.detail, executionSummary: summary || null, snapshot }} />
        </div>
      </section>
    </div>
  );
}
