import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Sparkles, X } from 'lucide-react';
import { streamAdminGenerationTask, type AdminGenerationEvent, type LearningResourceGenerationTask } from '@/lib/api';
import { cn } from '@/lib/utils';

const agents = [
  ['DIA-01', '教学策划', '分析学习目标并安排内容结构'],
  ['RET-02', '知识检索', '查找并整理可核验的知识依据'],
  ['GEN-03', '内容生成', '依据教学蓝图生成完整资源'],
  ['VER-04', '质量核验', '检查结构、引用和答案一致性'],
  ['ARB-05', '发布仲裁', '决定通过、返工或终止'],
] as const;
const activeStatuses = new Set(['queued', 'retrieving', 'planning', 'generating', 'verifying', 'reviewing', 'revising', 'judging']);

function snapshotRows(snapshot: Record<string, unknown>) {
  const labels: Record<string, string> = { activity: '当前动作', topic: '学习主题', query: '知识范围', ragCount: '知识库资料', webCount: '补充资料', sourceTitles: '知识来源', coverage: '内容覆盖', acceptanceRubric: '验收标准', resourceType: '资源类型', chapterCount: '章节数', stepCount: '步骤数', questionCount: '题目数', sourceCount: '引用来源', citationVerified: '引用核验', issueCount: '发现问题', issues: '复核提示', decision: '知识依据结论', highFidelityScore: '知识依据充分度', fallbackUsed: '资料补充情况', knowledgeCoreCount: '结构化知识依据' };
  const hidden = new Set(['requestId', 'traceId', 'promptVersion', 'model']);
  return Object.entries(snapshot).filter(([key]) => !hidden.has(key)).map(([key, value]) => {
    let shown = Array.isArray(value) ? value.map(String).join('、') : typeof value === 'boolean' ? (value ? '是' : '否') : String(value ?? '—');
    if (key === 'highFidelityScore' && Number.isFinite(Number(value))) shown = `${Math.round(Number(value) * 100)} 分`;
    if (key === 'fallbackUsed') shown = value ? '已补充更多资料' : '现有知识依据充足';
    if (key === 'decision') shown = ({ allow: '可继续生成', permit: '依据充分', restrict: '需谨慎使用', block: '依据不足', deny: '依据不足', eligible: '可继续生成', ineligible: '依据不足' } as Record<string, string>)[String(value)] ?? shown;
    return [labels[key] ?? key, shown] as const;
  });
}

export default function GenerationProcessViewer({ task, onClose }: { task: LearningResourceGenerationTask | null; onClose: () => void }) {
  const [events, setEvents] = useState<AdminGenerationEvent[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!task) return;
    setEvents([]); setError('');
    const controller = new AbortController();
    void streamAdminGenerationTask('resource', task.id, (event) => setEvents((current) => current.some((item) => item.seq === event.seq) ? current : [...current, event].sort((a, b) => a.seq - b.seq)), controller.signal)
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '教研过程连接暂时中断'); });
    return () => controller.abort();
  }, [task]);
  if (!task) return null;
  const latest = events.at(-1); const active = activeStatuses.has(task.status);
  return <div className="fixed inset-0 z-[110] flex items-center justify-center bg-ink/35 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-white/80 bg-[#f7f5ee] shadow-2xl">
      <header className="flex items-start gap-3 border-b border-white/75 bg-white/35 px-6 py-5"><div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand text-white"><Sparkles size={20}/></div><div className="min-w-0 flex-1"><h3 className="text-lg font-bold text-ink">AI 教研组 · 完整协同过程</h3><p className="mt-1 truncate text-xs text-ink-muted">{task.title} · 知识依据、内容生成与质量复核同步展示</p></div>{active && <span className="mt-2 text-[11px] font-semibold text-brand">● 进行中</span>}<button onClick={onClose} className="lf-row-btn !p-2"><X size={16}/></button></header>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="grid gap-2 md:grid-cols-5">{agents.map(([id, name, duty]) => { const seen = events.some((item) => item.agent === id); const running = active && latest?.agent === id; return <div key={id} className={cn('rounded-2xl border p-3', running ? 'border-brand/50 bg-brand-tint/70' : seen ? 'border-emerald-200 bg-emerald-50/60' : 'border-white/80 bg-white/45')}><div className="flex items-center gap-2">{running ? <Loader2 size={14} className="animate-spin text-brand"/> : seen ? <CheckCircle2 size={14} className="text-emerald-600"/> : <span className="h-2 w-2 rounded-full bg-ink-muted/30"/>}<span className="text-[10px] font-bold text-ink-muted">{id}</span></div><p className="mt-2 text-xs font-bold text-ink">{name}</p><p className="mt-1 text-[10px] leading-4 text-ink-muted">{running ? String(latest?.snapshot.activity || latest?.title) : duty}</p></div>; })}</div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <section className="rounded-2xl border border-white/80 bg-white/50 p-4"><h4 className="text-sm font-bold text-ink">当前工作快照</h4>{latest ? <><p className="mt-3 text-sm font-semibold text-ink">{latest.agentName} · {latest.title}</p><p className="mt-1 text-xs leading-5 text-ink-muted">{latest.detail}</p><div className="mt-3 space-y-2">{snapshotRows(latest.snapshot).map(([label, value]) => <div key={label} className="rounded-xl bg-white/70 px-3 py-2"><span className="text-[10px] font-semibold text-ink-muted">{label}</span><p className="mt-0.5 text-xs leading-5 text-ink-2">{value}</p></div>)}</div></> : <p className="py-16 text-center text-xs text-ink-muted">正在读取教研过程…</p>}</section>
          <section className="rounded-2xl border border-white/80 bg-white/50 p-4"><div className="flex justify-between"><h4 className="text-sm font-bold text-ink">协同记录</h4><span className="text-[10px] text-ink-muted">{events.length} 条</span></div><div className="mt-3 max-h-[420px] space-y-1 overflow-y-auto">{events.map((event) => <div key={event.seq} className={cn('rounded-xl px-3 py-2.5', event.seq === latest?.seq ? 'bg-brand-tint/60' : 'hover:bg-white/60')}><div className="flex gap-2"><span className="lf-pill lf-pill-null !px-1.5 text-[9px]">{event.agent}</span><span className="text-[11px] font-bold text-ink">{event.title}</span></div><p className="mt-1 text-[11px] leading-5 text-ink-muted">{event.detail}</p></div>)}</div>{error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-[11px] text-red-600">{error}</p>}</section>
        </div>
      </div>
    </div>
  </div>;
}
