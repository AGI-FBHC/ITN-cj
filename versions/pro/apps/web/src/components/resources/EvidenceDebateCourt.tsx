import { CheckCircle2, Gavel, Scale, SearchCheck, ShieldQuestion } from 'lucide-react';
import { cn } from '@/lib/utils';

type EventLike = { snapshot?: Record<string, unknown> };

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const verdictMeta: Record<string, { label: string; cls: string }> = {
  accepted: { label: '通过', cls: 'bg-emerald-100 text-emerald-700' },
  qualified: { label: '限定条件后通过', cls: 'bg-blue-100 text-blue-700' },
  disputed: { label: '存在争议', cls: 'bg-amber-100 text-amber-800' },
  rejected: { label: '不采用', cls: 'bg-rose-100 text-rose-700' },
};

export default function EvidenceDebateCourt({ events, archive, hideIdle = false }: { events?: EventLike[]; archive?: Record<string, unknown> | null; hideIdle?: boolean }) {
  const snapshots = (events ?? []).map((item) => item.snapshot ?? {});
  const triggeredSnapshot = [...snapshots].reverse().find((item) => item.debateTriggered === true);
  const noNeed = snapshots.some((item) => item.debateTriggered === false);
  const triggered = archive?.triggered === true || Boolean(triggeredSnapshot);
  if (!triggered && !noNeed) return null;
  if (!triggered && hideIdle) return null;
  if (!triggered) return <div className="mt-4 flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/70 px-4 py-3"><CheckCircle2 size={17} className="text-emerald-650"/><div><p className="text-xs font-bold text-emerald-800">知识库依据充分</p><p className="mt-0.5 text-[11px] text-emerald-700/80">本次无需启动多源证据辩论庭。</p></div></div>;
  const scorecard = asRecord(archive?.scorecard ?? triggeredSnapshot?.debateScorecard);
  const claimsRaw = Array.isArray(archive?.claims) ? archive?.claims : Array.isArray(triggeredSnapshot?.debateClaims) ? triggeredSnapshot?.debateClaims : [];
  const claims = claimsRaw.map(asRecord);
  const stats: Array<[string, unknown]> = [
    ['待验证主张', scorecard.claimCount ?? claims.length], ['检索页面', scorecard.pageCount ?? '—'],
    ['独立来源', scorecard.independentSourceCount ?? '—'], ['进入生成', scorecard.admittedSourceCount ?? '—'],
  ];
  return <section className="mt-4 overflow-hidden rounded-3xl border border-[#6D63A8]/25 bg-gradient-to-br from-[#F2F0FF] via-white/75 to-[#EEF5FF] shadow-[0_18px_50px_rgba(74,65,128,0.10)]">
    <header className="flex flex-wrap items-center gap-3 border-b border-[#786DB2]/15 bg-[#51477F] px-5 py-4 text-white"><span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/15"><Gavel size={19}/></span><div className="min-w-0 flex-1"><p className="text-[10px] font-semibold tracking-[.18em] text-white/65">EVIDENCE DEBATE AGENTS</p><h4 className="mt-0.5 text-base font-bold">证据辩论 Agents</h4><p className="mt-1 text-[11px] text-white/70">知识检索 Agent 的证据增强协作组 · 只有通过仲裁的内容才能进入生成</p></div><span className="rounded-full border border-white/20 bg-white/10 px-3 py-1 text-[10px] font-semibold">两轮辩论已完成</span></header>
    <div className="p-5">
      <div className="grid gap-2 sm:grid-cols-4">{stats.map(([label, value]) => <div key={label} className="rounded-2xl border border-white/80 bg-white/70 px-3 py-3"><p className="text-[10px] font-semibold text-ink-muted">{label}</p><p className="mt-1 text-lg font-bold text-[#51477F]">{String(value)}</p></div>)}</div>
      <div className="mt-4 grid gap-2 md:grid-cols-3"><div className="rounded-2xl border border-blue-100 bg-blue-50/60 p-3"><SearchCheck size={15} className="text-blue-650"/><p className="mt-2 text-xs font-bold text-ink">多源调查 Agent</p><p className="mt-1 text-[10px] leading-4 text-ink-muted">归并重复页面，识别真正独立的来源。</p></div><div className="rounded-2xl border border-amber-100 bg-amber-50/60 p-3"><ShieldQuestion size={15} className="text-amber-700"/><p className="mt-2 text-xs font-bold text-ink">质疑审查 Agent</p><p className="mt-1 text-[10px] leading-4 text-ink-muted">检查断章取义、适用范围和相反证据。</p></div><div className="rounded-2xl border border-violet-100 bg-violet-50/60 p-3"><Scale size={15} className="text-violet-700"/><p className="mt-2 text-xs font-bold text-ink">证据仲裁 Agent</p><p className="mt-1 text-[10px] leading-4 text-ink-muted">按权威性、直接性和来源独立性加权裁决。</p></div></div>
      <div className="mt-4 space-y-3">{claims.map((claim, index) => { const verdict = verdictMeta[String(claim.verdict)] ?? verdictMeta.rejected; const confidence = Number(claim.confidence); const revised = typeof claim.revisedClaim === 'string' ? claim.revisedClaim : ''; return <article key={index} className="rounded-2xl border border-white/90 bg-white/75 p-4"><div className="flex flex-wrap items-start gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#51477F]/10 text-[10px] font-bold text-[#51477F]">{index + 1}</span><div className="min-w-0 flex-1"><p className="text-xs font-bold leading-5 text-ink">{String(claim.claim ?? '待验证知识主张')}</p>{revised && revised !== claim.claim && <div className="mt-2 rounded-xl bg-blue-50 px-3 py-2"><p className="text-[9px] font-semibold text-blue-600">仲裁后的可用表述</p><p className="mt-1 text-[11px] leading-5 text-blue-900">{revised}</p></div>}</div><span className={cn('rounded-full px-2.5 py-1 text-[10px] font-bold', verdict.cls)}>{verdict.label}{Number.isFinite(confidence) ? ` · ${Math.round(confidence * 100)}%` : ''}</span></div><div className="mt-3 grid gap-2 md:grid-cols-2"><div className="rounded-xl bg-emerald-50/70 px-3 py-2"><p className="text-[9px] font-semibold text-emerald-700">支持方</p><p className="mt-1 text-[10px] leading-4 text-ink-2">{String(claim.supportSummary ?? '已汇总支持证据')}</p></div><div className="rounded-xl bg-amber-50/70 px-3 py-2"><p className="text-[9px] font-semibold text-amber-750">质疑方</p><p className="mt-1 text-[10px] leading-4 text-ink-2">{String(claim.challengeSummary ?? '已检查适用范围与反向证据')}</p></div></div>{Array.isArray(claim.conditions) && claim.conditions.length > 0 && <p className="mt-2 text-[10px] leading-4 text-ink-muted">采用条件：{claim.conditions.map(String).join('；')}</p>}</article>; })}</div>
    </div>
  </section>;
}
