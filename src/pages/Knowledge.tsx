import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Database, FileText, Layers3, Search } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import type { RagChunkSummary, RagDomain, RagTree, RagTreeNode } from '@/lib/api';

function flattenTree(nodes: RagTreeNode[], depth = 0): { node: RagTreeNode; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...flattenTree(node.children ?? [], depth + 1)]);
}

export default function Knowledge() {
  const [searchParams] = useSearchParams();
  const initialQuery = searchParams.get('q') ?? '';
  const [domains, setDomains] = useState<RagDomain[]>([]);
  const [domainCode, setDomainCode] = useState('');
  const [tree, setTree] = useState<RagTree | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<RagChunkSummary[] | null>(null);
  const [resultTotal, setResultTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.listRagDomains()
      .then((items) => {
        if (cancelled) return;
        setDomains(items);
        setDomainCode((current) => current || items[0]?.code || '');
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : '知识库读取失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!domainCode) return;
    let cancelled = false;
    setLoading(true);
    api.getRagTree(domainCode)
      .then((value) => { if (!cancelled) { setTree(value); setError(''); } })
      .catch((reason) => { if (!cancelled) { setTree(null); setError(reason instanceof Error ? reason.message : '知识树读取失败'); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [domainCode]);

  useEffect(() => {
    if (!initialQuery) return;
    api.searchRagChunks(initialQuery).then((page) => { setResults(page.items); setResultTotal(page.total); }).catch(() => undefined);
  }, [initialQuery]);

  const flatNodes = useMemo(() => flattenTree(tree?.nodes ?? []), [tree]);
  const selectedDomain = domains.find((domain) => domain.code === domainCode) ?? null;

  const submitSearch = async (event: FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (!text) { setResults(null); setResultTotal(0); return; }
    setLoading(true);
    try {
      const page = await api.searchRagChunks(text);
      setResults(page.items);
      setResultTotal(page.total);
      setError('');
    } catch (reason) {
      setResults([]);
      setResultTotal(0);
      setError(reason instanceof Error ? reason.message : '切片搜索失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-10 md:px-8">
      <div className="mb-7">
        <div className="lf-mono-label mb-2">RAG KNOWLEDGE BASE</div>
        <h1 className="font-serif text-[34px] font-bold text-ink">知识库</h1>
        <p className="mt-2 text-[14px] leading-6 text-ink-muted">领域、知识树、文档与切片统计均直接来自 MySQL 中同步的 RAG 知识库。</p>
      </div>

      <form onSubmit={submitSearch} className="flex gap-2">
        <label className="relative min-w-0 flex-1">
          <Search size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索真实知识切片" className="h-11 w-full rounded-[11px] border border-hairline bg-paper pl-10 pr-4 text-[14px] outline-none transition focus:border-brand" />
        </label>
        <button type="submit" className="lf-btn-primary">搜索</button>
        {results !== null && <button type="button" className="lf-btn-ghost" onClick={() => { setQuery(''); setResults(null); setResultTotal(0); }}>返回知识树</button>}
      </form>

      {error && <div className="mt-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{error}</div>}

      {results === null && (
        <>
          <div className="mt-7 flex gap-2 overflow-x-auto pb-1">
            {domains.map((domain) => <button key={domain.code} type="button" onClick={() => setDomainCode(domain.code)} className={`shrink-0 rounded-[10px] border px-4 py-2 text-[13px] transition ${domain.code === domainCode ? 'border-brand bg-brand-tint font-medium text-brand' : 'border-hairline bg-paper text-ink-muted hover:border-brand/40'}`}>{domain.name}</button>)}
          </div>

          {selectedDomain && <div className="mt-5 grid gap-3 sm:grid-cols-4">
            {[
              [Layers3, '知识节点', selectedDomain.knowledgePointCount],
              [FileText, '文档', selectedDomain.documentCount],
              [Database, '切片', selectedDomain.chunkCount],
              [FileText, '图像', selectedDomain.figureCount],
            ].map(([Icon, label, value]) => {
              const IconView = Icon as typeof Database;
              return <div key={String(label)} className="lf-card flex items-center gap-3 p-4"><span className="flex h-9 w-9 items-center justify-center rounded-[9px] bg-brand-tint text-brand"><IconView size={17} /></span><div><div className="font-mono text-[19px] font-semibold text-ink">{String(value)}</div><div className="text-[11px] text-ink-muted">{String(label)}</div></div></div>;
            })}
          </div>}

          <div className="mt-7 lf-card overflow-hidden">
            <div className="border-b border-hairline px-5 py-4"><h2 className="text-[16px] font-semibold text-ink">{tree?.domain.name ?? '领域'}知识树</h2><p className="mt-1 text-[12px] text-ink-muted">{tree?.domain.description || '后端尚未填写领域说明'}</p></div>
            {loading ? <div className="p-8 text-center text-[13px] text-ink-muted">正在读取知识树…</div> : flatNodes.length ? <div className="divide-y divide-hairline">
              {flatNodes.map(({ node, depth }) => <div key={node.id} className="flex items-start gap-3 px-5 py-3" style={{ paddingLeft: `${20 + depth * 22}px` }}><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand/60" /><div className="min-w-0 flex-1"><div className="text-[13.5px] font-medium text-ink">{node.name}</div>{node.description && <p className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-ink-muted">{node.description}</p>}</div><span className="shrink-0 font-mono text-[10.5px] text-ink-muted">{node.chunkCount ?? 0} 切片</span></div>)}
            </div> : <div className="p-8 text-center text-[13px] text-ink-muted">该领域还没有知识节点。</div>}
          </div>
        </>
      )}

      {results !== null && <section className="mt-7"><div className="mb-3 text-[13px] text-ink-muted">后端共匹配 {resultTotal} 个切片，当前显示 {results.length} 个</div>{loading ? <div className="lf-card p-8 text-center text-[13px] text-ink-muted">正在搜索…</div> : results.length ? <div className="space-y-3">{results.map((item) => <article key={item.id} className="lf-card p-5"><div className="flex flex-wrap items-center gap-2"><span className="rounded bg-brand-tint px-2 py-0.5 font-mono text-[10px] text-brand">{item.documentCode}</span><h2 className="text-[14.5px] font-semibold text-ink">{item.sectionTitle || item.titlePath || item.documentTitle}</h2></div><p className="mt-2 text-[13px] leading-6 text-ink-2">{item.summary || '该切片尚无摘要，可通过资源生成流程检索正文。'}</p><div className="mt-3 flex flex-wrap gap-1.5">{item.categories.map((tag) => <span key={tag.id} className="rounded-full border border-hairline px-2 py-0.5 text-[10.5px] text-ink-muted">{tag.fullPath || tag.name}</span>)}</div><div className="mt-3 font-mono text-[10.5px] text-ink-muted">来源：{item.documentTitle}{item.documentSourceName ? ` · ${item.documentSourceName}` : ''}{item.pageStart != null ? ` · 第 ${item.pageStart}${item.pageEnd && item.pageEnd !== item.pageStart ? `-${item.pageEnd}` : ''} 页` : ''}</div></article>)}</div> : <div className="lf-card p-8 text-center text-[13px] text-ink-muted">知识库中没有匹配切片。</div>}</section>}
    </div>
  );
}
