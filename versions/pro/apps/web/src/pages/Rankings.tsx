/**
 * 持续热学榜 `/rankings`
 *
 * 首页右侧榜单的完整版：所有课程 / 专题按「正在学习的人数」降序排列，
 * 底部提供页码 + 上一页 / 下一页切换。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Flame } from 'lucide-react';
import PageBack from '@/components/PageBack';
import { api } from '@/lib/api';
import type { RagDomain } from '@/lib/api';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 6;

type RankRow = {
  code: string;
  name: string;
  description: string;
  type: string;
  chapters: number;
  points: number;
  documents: number;
  learners: number;
};

export default function Rankings() {
  const [rows, setRows] = useState<RankRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.listRagDomains().catch(() => [] as RagDomain[]),
      api.getDomainPopularity().catch(() => ({ items: [] as Array<{ code: string; learners: number }> })),
    ]).then(([domains, popularity]) => {
      if (cancelled) return;
      const learnersByCode = new Map(popularity.items.map((item) => [item.code, item.learners]));
      const next = domains.map((domain) => ({
        code: domain.code,
        name: domain.name,
        description: domain.description,
        type: domain.domainType || '课程',
        chapters: domain.categoryCount || 0,
        points: domain.knowledgePointCount || 0,
        documents: domain.documentCount || 0,
        learners: learnersByCode.get(domain.code) ?? 0,
      }));
      next.sort((left, right) => (
        right.learners - left.learners
        || right.documents - left.documents
        || right.points - left.points
      ));
      setRows(next);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageIndex = Math.min(page, pageCount - 1);
  const pageRows = useMemo(
    () => rows.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE),
    [rows, pageIndex],
  );

  const goPage = (next: number) => {
    setPage(Math.max(0, Math.min(pageCount - 1, next)));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="mx-auto max-w-[1120px] px-5 pb-12 pt-8 md:px-6">
      <PageBack parent={{ label: '我的学习', to: '/me' }} current="持续热学榜" />
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-[22px] font-semibold text-ink">
            <Flame size={18} className="text-[#C2410C]" />
            持续热学榜
          </h1>
          <p className="mt-1 text-[12px] text-ink-muted">按正在学习的人数排序，覆盖全部课程与专题</p>
        </div>
        <span className="text-[11.5px] text-ink-muted">共 {rows.length} 个领域</span>
      </div>

      <div className="mt-5 overflow-hidden rounded-[8px] border border-hairline bg-paper/60">
        {loading ? (
          <div className="px-4 py-16 text-center text-[12.5px] text-ink-muted">正在加载排行榜…</div>
        ) : pageRows.length === 0 ? (
          <div className="px-4 py-16 text-center text-[12.5px] text-ink-muted">暂无课程数据</div>
        ) : (
          pageRows.map((item, index) => {
            const rank = pageIndex * PAGE_SIZE + index + 1;
            return (
              <Link
                key={item.code}
                to={`/discover/${encodeURIComponent(item.code)}`}
                className="group flex items-center gap-4 border-b border-hairline px-4 py-3.5 last:border-b-0 transition-colors hover:bg-paper-deep/30"
              >
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold',
                    rank === 1 && 'bg-brand text-white',
                    rank === 2 && 'bg-[#E7B45A] text-white',
                    rank === 3 && 'bg-[#D9C7A8] text-white',
                    rank > 3 && 'bg-[#EFE7DA] text-[#8A7A63]',
                  )}
                >
                  {rank}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    {rank <= 3 && (
                      <span className="shrink-0 rounded bg-[#FDE2C8] px-1 py-0.5 text-[9px] font-semibold text-[#B45309]">热门</span>
                    )}
                    <span className="truncate text-[14px] font-medium text-ink group-hover:text-brand">{item.name}</span>
                    <span className="shrink-0 rounded bg-paper-deep/70 px-1.5 py-0.5 text-[10px] text-ink-muted">{item.type}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-ink-muted">
                    共 {item.chapters} 个章节 · {item.points} 个知识点 · {item.documents} 份入库文档
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-mono text-[16px] font-semibold text-brand">{item.learners}</span>
                  <span className="block text-[10px] text-ink-muted">人在学</span>
                </span>
                <ChevronRight size={14} className="shrink-0 text-ink-muted group-hover:text-brand" />
              </Link>
            );
          })
        )}
      </div>

      {pageCount > 0 && (
        <div className="mt-5 flex items-center justify-center gap-1.5">
          <button
            type="button"
            onClick={() => goPage(pageIndex - 1)}
            disabled={pageIndex === 0}
            className="inline-flex h-8 items-center gap-1 rounded-[6px] border border-hairline px-2.5 text-[12px] text-ink-muted transition-colors hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft size={13} />
            上一页
          </button>
          {Array.from({ length: pageCount }, (_, index) => index).map((index) => (
            <button
              key={index}
              type="button"
              aria-current={index === pageIndex ? 'page' : undefined}
              onClick={() => goPage(index)}
              className={cn(
                'h-8 min-w-8 rounded-[6px] border px-2 text-[12px] transition-colors',
                index === pageIndex
                  ? 'border-brand bg-brand text-white'
                  : 'border-hairline text-ink-muted hover:text-brand',
              )}
            >
              {index + 1}
            </button>
          ))}
          <button
            type="button"
            onClick={() => goPage(pageIndex + 1)}
            disabled={pageIndex >= pageCount - 1}
            className="inline-flex h-8 items-center gap-1 rounded-[6px] border border-hairline px-2.5 text-[12px] text-ink-muted transition-colors hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
          >
            下一页
            <ChevronRight size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
