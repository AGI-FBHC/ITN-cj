import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, Database, Network, UserRound } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { learningResourcePath, useCourseLearning } from '@/hooks/useCourseLearning';
import { api } from '@/lib/api';
import type { RagDomain } from '@/lib/api';

export default function Home() {
  const { currentLearner, domainKnowledgePoints } = useProfile();
  const learning = useCourseLearning();
  const [domains, setDomains] = useState<RagDomain[]>([]);

  useEffect(() => {
    api.listRagDomains().then(setDomains).catch(() => setDomains([]));
  }, []);

  const ragStats = domains.reduce((totals, domain) => ({
    documents: totals.documents + domain.documentCount,
    chunks: totals.chunks + domain.chunkCount,
    points: totals.points + domain.knowledgePointCount,
  }), { documents: 0, chunks: 0, points: 0 });

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-10">
      <div className="mb-8">
        <div className="lf-mono-label mb-2">SYSTEM OVERVIEW · REAL DATA</div>
        <h1 className="font-serif text-[34px] font-bold text-ink">系统透视</h1>
        <p className="mt-2 text-[14px] leading-6 text-ink-muted">当前页只汇总后端已保存的画像、课程、资源与 RAG 知识库状态，不展示模拟协同指标。</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          [UserRound, '画像知识维度', domainKnowledgePoints.length],
          [BookOpen, '当前课程章节', learning.course?.chapters.length ?? 0],
          [Database, 'RAG 文档 / 切片', `${ragStats.documents} / ${ragStats.chunks}`],
          [Network, '已生成课程资源', learning.totalCount],
        ].map(([Icon, label, value]) => {
          const IconView = Icon as typeof BookOpen;
          return <div key={String(label)} className="lf-card flex items-center gap-4 p-5"><span className="flex h-11 w-11 items-center justify-center rounded-[10px] bg-brand-tint text-brand"><IconView size={19} /></span><div><div className="font-mono text-[22px] font-semibold text-ink">{String(value)}</div><div className="mt-0.5 text-[11.5px] text-ink-muted">{String(label)}</div></div></div>;
        })}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-12">
        <section className="lf-card p-6 lg:col-span-7">
          <div className="flex items-start justify-between gap-4"><div><div className="lf-mono-label mb-1">CURRENT COURSE</div><h2 className="text-[19px] font-semibold text-ink">{learning.course?.title ?? '尚未生成课程'}</h2><p className="mt-1 text-[13px] text-ink-muted">{currentLearner.name} · {currentLearner.targetJob || currentLearner.goal || '尚未设置目标'}</p></div>{learning.course && <span className="rounded bg-brand-tint px-2 py-1 font-mono text-[11px] text-brand">生成 {learning.course.progress}%</span>}</div>
          {learning.course ? <>
            <div className="mt-5 space-y-2">{learning.course.chapters.map((chapter) => <div key={chapter.id} className="flex items-center gap-3 rounded-[9px] bg-card-warm px-3 py-2"><span className="font-mono text-[11px] text-brand">{chapter.index}</span><span className="min-w-0 flex-1 truncate text-[13px] text-ink">{chapter.title}</span><span className="font-mono text-[10px] text-ink-muted">{chapter.status}</span></div>)}</div>
            <div className="mt-5 flex flex-wrap gap-2"><Link to="/learn" className="lf-btn-primary">管理课程 <ArrowRight size={14} /></Link><Link to="/agents" className="lf-btn-ghost">查看真实 Agent 记录</Link></div>
          </> : <Link to="/learn" className="lf-btn-primary mt-5 inline-flex">生成课程</Link>}
        </section>

        <section className="lf-card p-6 lg:col-span-5">
          <div className="lf-mono-label mb-1">LEARNING WRITEBACK</div><h2 className="text-[19px] font-semibold text-ink">真实学习进度</h2>
          <div className="mt-5 flex items-end gap-2"><span className="font-mono text-[34px] font-semibold text-brand">{learning.progress}%</span><span className="pb-1.5 text-[12px] text-ink-muted">{learning.learnedCount}/{learning.totalCount} 项资源</span></div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-hairline"><div className="h-full rounded-full bg-brand" style={{ width: `${learning.progress}%` }} /></div>
          {learning.nextResource && <Link to={learningResourcePath(learning.nextResource)} className="group mt-5 block rounded-[11px] border border-hairline bg-card-warm p-4 hover:border-brand/40"><div className="text-[11px] text-ink-muted">下一学习项</div><div className="mt-1 flex items-center gap-2 text-[13.5px] font-medium text-ink"><span className="min-w-0 flex-1 truncate">{learning.nextResource.title}</span><ArrowRight size={14} className="text-brand transition group-hover:translate-x-0.5" /></div></Link>}
          <div className="mt-5 border-t border-hairline pt-4"><div className="text-[12px] text-ink-muted">RAG 领域</div><div className="mt-2 flex flex-wrap gap-1.5">{domains.map((domain) => <Link key={domain.code} to="/knowledge" className="rounded-full border border-hairline px-2.5 py-1 text-[11px] text-ink-2 hover:border-brand/40">{domain.name} · {domain.chunkCount} 切片</Link>)}</div></div>
        </section>
      </div>
    </div>
  );
}
