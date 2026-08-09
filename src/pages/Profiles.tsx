import { useMemo, useState } from 'react';
import { Check, Target, UserRound } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';

export default function Profiles() {
  const { learners, currentLearnerId, setCurrentLearnerId, domainKnowledgePoints } = useProfile();
  const [selectedId, setSelectedId] = useState(currentLearnerId);
  const selected = learners.find((learner) => learner.id === selectedId) ?? learners[0];

  const orderedScores = useMemo(() => domainKnowledgePoints.map((point) => ({
    ...point,
    score: selected?.scores[point.id] ?? 0,
  })).sort((left, right) => right.score - left.score), [domainKnowledgePoints, selected]);

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-10">
      <div className="mb-8"><div className="lf-mono-label mb-2">PERSISTED LEARNER PROFILES</div><h1 className="font-serif text-[34px] font-bold text-ink">学情画像</h1><p className="mt-2 text-[14px] text-ink-muted">当前账号在后端保存了 {learners.length} 份画像；分数与诊断均来自建档接口。</p></div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{learners.map((learner) => {
        const isCurrent = learner.id === currentLearnerId;
        return <button key={learner.id} type="button" onClick={() => setSelectedId(learner.id)} className={`lf-card p-5 text-left transition ${selected?.id === learner.id ? 'border-brand shadow-warm' : 'hover:border-brand/35'}`}>
          <div className="flex items-center gap-3"><img src={learner.avatar} alt={learner.name} className="h-12 w-12 rounded-full border border-hairline object-cover" /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="text-[16px] font-semibold text-ink">{learner.name}</span>{isCurrent && <span className="rounded bg-brand px-1.5 py-0.5 font-mono text-[9px] text-paper">CURRENT</span>}</div><div className="mt-0.5 truncate text-[12px] text-ink-muted">{learner.targetJob || learner.goal || '尚未设置目标'}</div></div></div>
          <div className="mt-4 grid grid-cols-3 gap-2"><div className="rounded bg-card-warm p-2"><div className="font-mono text-[14px] text-ink">{learner.confidence ? `${Math.round(learner.confidence.value * (learner.confidence.value <= 1 ? 100 : 1))}%` : '—'}</div><div className="text-[9.5px] text-ink-muted">置信度</div></div><div className="rounded bg-card-warm p-2"><div className="font-mono text-[14px] text-ink">{Object.keys(learner.scores).length}</div><div className="text-[9.5px] text-ink-muted">评分维度</div></div><div className="rounded bg-card-warm p-2"><div className="font-mono text-[14px] text-ink">{learner.weeklyHours}h</div><div className="text-[9.5px] text-ink-muted">每周学习</div></div></div>
        </button>;
      })}</div>

      {selected && <div className="mt-8 grid gap-6 lg:grid-cols-12">
        <section className="lf-card p-6 lg:col-span-5"><div className="flex items-center gap-2"><UserRound size={18} className="text-brand" /><h2 className="text-[18px] font-semibold text-ink">{selected.name} · 后端档案</h2></div><dl className="mt-5 space-y-3 text-[13px]">{[['目标岗位', selected.targetJob], ['教育背景', selected.education], ['学习风格', selected.learningStyle.join(' / ')], ['每周投入', `${selected.weeklyHours} 小时`], ['目标描述', selected.goal]].map(([label, value]) => <div key={label} className="flex gap-4 border-b border-hairline pb-3"><dt className="w-20 shrink-0 text-ink-muted">{label}</dt><dd className="text-ink-2">{value || '后端未填写'}</dd></div>)}</dl><div className="mt-5 rounded-[10px] bg-card-warm p-4"><div className="text-[11px] font-medium text-brand">DIA-01 诊断摘要</div><p className="mt-1 text-[12.5px] leading-6 text-ink-2">{selected.diagnosisSummary || '后端尚未生成诊断摘要'}</p></div>{selected.id !== currentLearnerId && <button type="button" onClick={() => setCurrentLearnerId(selected.id)} className="lf-btn-primary mt-5 w-full">设为当前画像</button>}{selected.id === currentLearnerId && <div className="mt-5 flex items-center justify-center gap-1.5 text-[12px] text-brand"><Check size={14} />正在驱动当前页面</div>}</section>

        <section className="lf-card p-6 lg:col-span-7"><div className="flex items-center gap-2"><Target size={18} className="text-brand" /><h2 className="text-[18px] font-semibold text-ink">六维评分与目标线</h2></div><div className="mt-5 space-y-4">{orderedScores.map((point) => <div key={point.id}><div className="flex items-center justify-between text-[12.5px]"><span className="font-medium text-ink">{point.name}</span><span className="font-mono text-ink-muted">当前 {point.score} · 目标 {point.targetLevel}</span></div><div className="relative mt-1.5 h-2 overflow-hidden rounded-full bg-hairline"><div className="absolute inset-y-0 left-0 rounded-full bg-brand/25" style={{ width: `${Math.min(100, point.targetLevel)}%` }} /><div className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${Math.min(100, point.score)}%` }} /></div></div>)}</div></section>
      </div>}
    </div>
  );
}
