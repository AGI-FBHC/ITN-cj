import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BookOpen, ChevronRight, Database, FileText, Landmark, LayoutGrid, Search, SearchX, Table2, X } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import CountUp from '@/components/knowledge/CountUp';
import { api } from '@/lib/api';
import type { RagChunkDetail, RagChunkSummary, RagDomain, RagTree, RagTreeNode } from '@/lib/api';
import { cn } from '@/lib/utils';

type SortKey = 'reliability' | 'year' | 'page';

function flattenTree(nodes: RagTreeNode[], depth = 0): { node: RagTreeNode; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...flattenTree(node.children ?? [], depth + 1)]);
}

function highlight(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const index = text.toLowerCase().indexOf(q.toLowerCase());
  if (index < 0) return text;
  return <>{text.slice(0, index)}<mark className="rounded bg-brand-amber-tint px-0.5 text-ochre">{text.slice(index, index + q.length)}</mark>{text.slice(index + q.length)}</>;
}

function typeLabel(type: string | null) {
  const value = (type || '文档').toLowerCase();
  if (value === 'course_markdown' || value.includes('course')) return '课程资料';
  if (value.includes('standard') || value.includes('标准')) return '标准';
  if (value.includes('paper') || value.includes('论文')) return '论文';
  if (value.includes('book') || value.includes('教材')) return '教材';
  if (value.includes('case') || value.includes('案例')) return '案例';
  return type || '文档';
}

function ChunkCard({ item, index, query, onOpen, onCategory }: { item: RagChunkSummary; index: number; query: string; onOpen: () => void; onCategory: (id: number) => void }) {
  const reliability = Math.round((item.reliabilityScore ?? 0) * 100);
  return <motion.button type="button" layout initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index, 8) * 0.04 }} onClick={onOpen} className="group flex flex-col rounded-[14px] border border-hairline bg-card-warm p-4 text-left transition-all hover:-translate-y-0.5 hover:border-brand/35 hover:shadow-warm">
    <div className="flex items-center justify-between gap-2"><span className="font-mono text-[11.5px] font-semibold text-brand">{item.chunkCode}</span><span className="rounded-md border border-brand/25 bg-brand-tint px-1.5 py-px text-[10.5px] text-brand">{typeLabel(item.documentType)}</span></div>
    <h3 className="mt-2 line-clamp-2 min-h-[42px] text-[14.5px] font-semibold leading-[21px] text-ink">{highlight(item.sectionTitle || item.titlePath || item.documentTitle, query)}</h3>
    <p className="mt-1 line-clamp-3 min-h-[57px] text-[12.5px] leading-[19px] text-ink-muted">{item.summary || '该切片暂无摘要，打开后可查看知识库正文。'}</p>
    <div className="mt-3 flex flex-wrap gap-1.5">{item.categories.slice(0, 3).map((tag) => <span key={tag.id} role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); onCategory(tag.id); }} className="rounded-md border border-hairline bg-paper px-1.5 py-px text-[10.5px] text-ink-2 hover:border-brand/40 hover:text-brand">{tag.name}</span>)}</div>
    <div className="mt-auto flex items-center gap-2 border-t border-hairline/70 pt-3"><div className="h-1 flex-1 overflow-hidden rounded-full bg-paper-deep"><div className="h-full rounded-full bg-brand" style={{ width: `${reliability}%` }} /></div><span className="font-mono text-[10.5px] text-ink-muted">可信度 {reliability || '—'}</span><span className="ml-auto font-mono text-[10.5px] text-ink-muted">{item.pageStart != null ? `P.${item.pageStart}` : `${item.tokenCount ?? 0} tokens`}</span></div>
  </motion.button>;
}

function DetailDrawer({ detail, open, onClose }: { detail: RagChunkDetail | null; open: boolean; onClose: () => void }) {
  return <AnimatePresence>{open && <><motion.button type="button" aria-label="关闭详情遮罩" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 z-[80] bg-ink/20 backdrop-blur-[2px]" /><motion.aside initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }} className="fixed inset-y-0 right-0 z-[90] w-full max-w-[620px] overflow-y-auto border-l border-hairline bg-paper p-6 shadow-2xl">
    <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="lf-mono-label">KNOWLEDGE TRACE · {detail?.chunkCode || '加载中'}</div><h2 className="mt-2 font-serif text-[24px] font-semibold text-ink">{detail?.sectionTitle || detail?.titlePath || '知识切片详情'}</h2></div><button type="button" aria-label="关闭知识切片" onClick={onClose} className="rounded-lg border border-hairline p-2 text-ink-muted hover:text-ink"><X size={17} /></button></div>
    {!detail ? <div className="py-20 text-center text-[13px] text-ink-muted">正在读取切片正文…</div> : <>
      <div className="mt-5 flex flex-wrap gap-2">{detail.categories.map((tag) => <span key={tag.id} className="rounded-full border border-brand/25 bg-brand-tint px-2.5 py-1 text-[11px] text-brand">{tag.fullPath || tag.name}</span>)}</div>
      <div className="mt-5 rounded-[12px] border border-hairline bg-card-warm p-4"><div className="text-[13px] font-semibold text-ink">{detail.document.title}</div><div className="mt-1 font-mono text-[10.5px] leading-5 text-ink-muted">{detail.document.standardNumber || detail.document.documentCode}{detail.document.publisher ? ` · ${detail.document.publisher}` : ''}{detail.document.publishYear ? ` · ${detail.document.publishYear}` : ''}</div><div className="mt-2 flex gap-4 text-[11.5px] text-ink-muted"><span>可信度 {Math.round((detail.document.reliabilityScore ?? 0) * 100) || '—'}</span><span>{detail.document.chunkCount} 个切片</span><span>{detail.document.figureCount} 幅图</span></div></div>
      <div className="mt-5"><div className="lf-mono-label">ORIGINAL CONTENT · 原始正文</div><div className="mt-3 whitespace-pre-wrap rounded-[12px] border border-hairline bg-white/60 p-5 text-[13.5px] leading-7 text-ink-2">{detail.content}</div></div>
      <div className="mt-5 flex flex-wrap gap-2 text-[11px] text-ink-muted"><span>字符 {detail.charStart ?? '—'}–{detail.charEnd ?? '—'}</span><span>·</span><span>{detail.tokenCount ?? 0} tokens</span>{detail.pageStart != null && <><span>·</span><span>第 {detail.pageStart}{detail.pageEnd && detail.pageEnd !== detail.pageStart ? `–${detail.pageEnd}` : ''} 页</span></>}</div>
    </>}
  </motion.aside></>}</AnimatePresence>;
}

export default function Knowledge() {
  const [searchParams] = useSearchParams();
  const initialQuery = searchParams.get('q') ?? '';
  const [domains, setDomains] = useState<RagDomain[]>([]);
  const [domainCode, setDomainCode] = useState('');
  const [tree, setTree] = useState<RagTree | null>(null);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [items, setItems] = useState<RagChunkSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /* 后端知识树为逐节点查询，实测 13~23 秒；超过 8 秒仍无结果显示慢提示与重试入口（BUG-006）。 */
  const [slow, setSlow] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [view, setView] = useState<'grid' | 'table'>('grid');
  const [types, setTypes] = useState<string[]>([]);
  const [standard, setStandard] = useState<string | null>(null);
  const [minReliability, setMinReliability] = useState(0);
  const [sort, setSort] = useState<SortKey>('reliability');
  const [detail, setDetail] = useState<RagChunkDetail | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    api.listRagDomains().then((result) => {
      setDomains(result);
      setDomainCode(result[0]?.code || '');
      if (!result.length) { setError('暂无可用知识领域'); setLoading(false); }
    }).catch((reason) => { setError(reason instanceof Error ? reason.message : '知识库读取失败'); setLoading(false); });
  }, []);

  useEffect(() => {
    if (!domainCode) return;
    setLoading(true);
    setSlow(false);
    api.getRagTree(domainCode).then((result) => {
      const available = flattenTree(result.nodes).filter(({ node }) => (node.chunkCount ?? 0) > 0).sort((a, b) => (b.node.chunkCount ?? 0) - (a.node.chunkCount ?? 0));
      setTree(result);
      setItems([]);
      setTotal(0);
      setCategoryId(available[0]?.node.id ?? null);
      setError('');
    }).catch((reason) => setError(reason instanceof Error ? reason.message : '知识树读取失败')).finally(() => setLoading(false));
  }, [domainCode, reloadKey]);

  /* 加载超过 8 秒仍未返回 → 显示"较慢/可重试"提示（不打断请求，只补反馈）。 */
  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, [loading, reloadKey]);

  useEffect(() => {
    if (!categoryId || initialQuery) return;
    setLoading(true);
    api.listRagChunksByCategory(categoryId).then((page) => { setItems(page.items); setTotal(page.total); }).catch((reason) => setError(reason instanceof Error ? reason.message : '知识切片读取失败')).finally(() => setLoading(false));
  }, [categoryId, initialQuery]);

  useEffect(() => {
    if (!initialQuery) return;
    api.searchRagChunks(initialQuery).then((page) => { setItems(page.items); setTotal(page.total); }).catch(() => undefined).finally(() => setLoading(false));
  }, [initialQuery]);

  const flatNodes = useMemo(() => flattenTree(tree?.nodes ?? []), [tree]);
  const selectedDomain = domains.find((domain) => domain.code === domainCode) ?? null;
  const actualTypes = useMemo(() => [...new Set(items.map((item) => typeLabel(item.documentType)))], [items]);
  const standards = useMemo(() => [...new Set(items.map((item) => item.standardNumber).filter((value): value is string => Boolean(value)))].slice(0, 6), [items]);
  const filtered = useMemo(() => [...items].filter((item) => (!types.length || types.includes(typeLabel(item.documentType))) && (!standard || item.standardNumber === standard) && (item.reliabilityScore ?? 0) >= minReliability).sort((a, b) => sort === 'year' ? (b.publishYear ?? 0) - (a.publishYear ?? 0) : sort === 'page' ? (a.pageStart ?? 99999) - (b.pageStart ?? 99999) : (b.reliabilityScore ?? 0) - (a.reliabilityScore ?? 0)), [items, minReliability, sort, standard, types]);

  const selectCategory = (id: number) => { setQuery(''); setStandard(null); setTypes([]); setCategoryId(id); };
  const submitSearch = async (event: FormEvent) => { event.preventDefault(); const text = query.trim(); if (!text) { if (categoryId) selectCategory(categoryId); return; } setLoading(true); try { const page = await api.searchRagChunks(text); setItems(page.items); setTotal(page.total); setError(''); } catch (reason) { setError(reason instanceof Error ? reason.message : '知识检索失败'); } finally { setLoading(false); } };
  const openDetail = async (id: number) => { setDetail(null); setDrawerOpen(true); try { setDetail(await api.getRagChunk(id)); } catch (reason) { setDrawerOpen(false); setError(reason instanceof Error ? reason.message : '切片详情读取失败'); } };

  return <div className="mx-auto max-w-[1320px] px-5 py-10 md:px-8">
    <motion.header initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}><div className="lf-mono-label flex items-center gap-2"><span className="h-px w-6 bg-brand/40" />RAG KNOWLEDGE BASE</div><h1 className="mt-2 font-serif text-[36px] font-bold text-ink">领域知识库</h1></motion.header>

    {/* 统计口径：这四个数字来自 RAGFlow 知识索引，与平台学习资源库的切片数不是同一口径（BUG-010）。 */}
    <p className="mt-3 text-[11.5px] leading-5 text-ink-muted">以上统计来自 <span className="font-mono">RAGFlow</span> 知识索引（领域知识库）；平台侧的学习资源/切片数量是另一套口径，两者不直接可比。</p>

    <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">{[[Database, '知识节点', selectedDomain?.knowledgePointCount ?? 0], [FileText, '来源文档', selectedDomain?.documentCount ?? 0], [BookOpen, '知识切片', selectedDomain?.chunkCount ?? 0], [Landmark, '知识配图', selectedDomain?.figureCount ?? 0]].map(([Icon, label, value], index) => { const C = Icon as typeof Database; return <motion.div key={String(label)} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.06 }} className="lf-card p-4"><div className="flex items-center gap-2 text-brand"><C size={16} /><span className="lf-mono-label !text-[10px]">LIVE DATA</span></div><CountUp to={Number(value)} className="mt-2 block font-display text-[30px] font-semibold leading-none text-ink" /><div className="mt-1.5 text-[12.5px] text-ink-muted">{String(label)}</div></motion.div>; })}</div>

    <div className="mt-7 flex gap-2 overflow-x-auto pb-1">{domains.map((domain) => <button key={domain.code} type="button" onClick={() => { setQuery(''); setTypes([]); setStandard(null); setMinReliability(0); setDomainCode(domain.code); }} className={cn('shrink-0 rounded-[10px] border px-4 py-2 text-[13px] transition', domain.code === domainCode ? 'border-brand bg-brand text-paper' : 'border-hairline bg-card-warm text-ink-muted hover:border-brand/40')}>{domain.name}<span className="ml-2 font-mono text-[10px] opacity-70">{domain.chunkCount}</span></button>)}</div>

    {!!standards.length && <section className="mt-7 rounded-[14px] border border-hairline bg-card-warm p-4"><div className="lf-mono-label">VERIFIABLE SOURCES · 可信来源精选</div><div className="mt-3 flex flex-wrap gap-2">{standards.map((number) => <button key={number} type="button" onClick={() => setStandard((current) => current === number ? null : number)} className={cn('rounded-[10px] border px-3 py-2 font-mono text-[12px]', standard === number ? 'border-ochre bg-brand-amber-tint text-ochre' : 'border-hairline bg-paper text-ink-2 hover:border-ochre/40')}><Landmark size={13} className="mr-1.5 inline" />{number}</button>)}</div></section>}

    <div className="sticky top-[72px] z-30 mt-7 rounded-[14px] border border-hairline bg-paper/90 p-3.5 shadow-xs backdrop-blur"><form onSubmit={submitSearch} className="flex flex-wrap items-center gap-2.5"><label className="relative min-w-[240px] flex-1"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="检索标题、标准号或正文关键词" className="h-10 w-full rounded-[10px] border border-hairline bg-card-warm pl-9 pr-8 text-[13.5px] outline-none focus:border-brand/50" />{query && <button type="button" onClick={() => setQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted"><X size={14} /></button>}</label><button type="submit" className="lf-btn-primary !h-10">检索</button><select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} className="h-10 rounded-[10px] border border-hairline bg-card-warm px-3 text-[12.5px] text-ink-2"><option value="reliability">可信度排序</option><option value="year">年份排序</option><option value="page">页码排序</option></select><div className="flex rounded-[10px] border border-hairline bg-card-warm p-0.5"><button type="button" onClick={() => setView('grid')} className={cn('rounded-lg px-3 py-2', view === 'grid' ? 'bg-brand text-paper' : 'text-ink-muted')}><LayoutGrid size={14} /></button><button type="button" onClick={() => setView('table')} className={cn('rounded-lg px-3 py-2', view === 'table' ? 'bg-brand text-paper' : 'text-ink-muted')}><Table2 size={14} /></button></div><span className="font-mono text-[11px] text-ink-muted">显示 {filtered.length} / {total}</span></form>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-hairline/70 pt-2.5"><span className="lf-mono-label !text-[10px]">类型</span>{actualTypes.map((type) => <button key={type} type="button" onClick={() => setTypes((current) => current.includes(type) ? current.filter((item) => item !== type) : [...current, type])} className={cn('rounded-lg border px-2.5 py-1 text-[11.5px]', types.includes(type) ? 'border-brand bg-brand text-paper' : 'border-hairline bg-card-warm text-ink-muted')}>{type}</button>)}<span className="lf-mono-label ml-2 !text-[10px]">可信度 ≥ {Math.round(minReliability * 100)}</span><input aria-label="最低可信度" type="range" min="0" max="1" step="0.05" value={minReliability} onChange={(event) => setMinReliability(Number(event.target.value))} className="w-[130px] accent-[#4E7860]" />{(types.length > 0 || standard || minReliability > 0) && <button type="button" onClick={() => { setTypes([]); setStandard(null); setMinReliability(0); }} className="ml-auto text-[11.5px] text-ink-muted hover:text-brand">清除过滤</button>}</div>
    </div>

    {error && <div className="mt-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{error}</div>}
    <div className="mt-6 grid gap-5 lg:grid-cols-[250px_minmax(0,1fr)]"><aside className="self-start rounded-[14px] border border-hairline bg-card-warm p-3 lg:sticky lg:top-[190px]"><div className="px-2 pb-2"><div className="lf-mono-label">KNOWLEDGE TREE</div><div className="mt-1 text-[13px] font-semibold text-ink">{tree?.domain.name || '知识分类'}</div></div><div className="max-h-[560px] overflow-y-auto">{flatNodes.map(({ node, depth }) => <button key={node.id} type="button" onClick={() => selectCategory(node.id)} className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[12px] transition', categoryId === node.id ? 'bg-brand-tint font-medium text-brand' : 'text-ink-2 hover:bg-paper-deep')} style={{ paddingLeft: 8 + depth * 13 }}><ChevronRight size={11} className="shrink-0 opacity-50" /><span className="min-w-0 flex-1 truncate">{node.name}</span><span className="font-mono text-[9.5px] text-ink-muted">{node.chunkCount ?? 0}</span></button>)}</div></aside>
      <main className="min-h-[360px]">{loading ? <div className="lf-card p-12 text-center text-[13px] text-ink-muted"><p>正在读取知识切片…</p>{slow && <><p className="mt-2 text-[11.5px] text-ink-muted">知识树按目录逐节点查询，较慢时可能需要 10~30 秒；如果一直无响应可重试。</p><button type="button" onClick={() => { setSlow(false); setReloadKey((value) => value + 1); }} className="lf-btn-ghost mt-4">重新读取</button></>}</div> : !flatNodes.length ? <div className="flex flex-col items-center rounded-[14px] border border-dashed border-hairline py-20 text-center"><Database size={34} className="text-ink-muted" /><p className="mt-3 text-[14px] font-medium text-ink">该领域尚未建立知识分类</p><p className="mt-1 max-w-[440px] text-[12px] leading-5 text-ink-muted">暂没有关联的知识节点与切片。</p>{domains.some((domain) => domain.chunkCount > 0) && <button type="button" onClick={() => setDomainCode(domains.find((domain) => domain.chunkCount > 0)!.code)} className="lf-btn-ghost mt-4">查看已有知识内容</button>}</div> : !filtered.length ? <div className="flex flex-col items-center rounded-[14px] border border-dashed border-hairline py-20 text-center"><SearchX size={34} className="text-ink-muted" /><p className="mt-3 text-[14px] font-medium text-ink">当前条件没有匹配切片</p><button type="button" onClick={() => { setTypes([]); setStandard(null); setMinReliability(0); }} className="lf-btn-ghost mt-4">清除过滤</button></div> : view === 'grid' ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{filtered.map((item, index) => <ChunkCard key={item.id} item={item} index={index} query={query} onOpen={() => void openDetail(item.id)} onCategory={selectCategory} />)}</div> : <div className="overflow-x-auto rounded-[14px] border border-hairline bg-card-warm"><table className="w-full text-left"><thead className="bg-paper-deep/70 text-[11px] text-ink-muted"><tr><th className="px-4 py-3">切片</th><th className="px-4 py-3">标题</th><th className="px-4 py-3">来源</th><th className="px-4 py-3">知识点</th><th className="px-4 py-3 text-right">可信度</th></tr></thead><tbody>{filtered.map((item) => <tr key={item.id} onClick={() => void openDetail(item.id)} className="cursor-pointer border-t border-hairline text-[12.5px] hover:bg-brand-tint/35"><td className="px-4 py-3 font-mono text-brand">{item.chunkCode}</td><td className="max-w-[340px] px-4 py-3 font-medium text-ink">{item.sectionTitle || item.titlePath}</td><td className="px-4 py-3 text-ink-muted">{item.standardNumber || item.documentTitle}</td><td className="px-4 py-3 text-ink-2">{item.categories[0]?.name || '—'}</td><td className="px-4 py-3 text-right font-mono text-brand">{Math.round((item.reliabilityScore ?? 0) * 100) || '—'}</td></tr>)}</tbody></table></div>}</main></div>

    <div className="mt-14 text-center"><p className="font-serif text-[18px] italic text-ink-2">“知识的每一条来路，都应该被看见。”</p><p className="mt-2 font-mono text-[11px] text-ink-muted">分类 · 原文切片 · 文档级可信度 · 可核验溯源</p></div>
    <DetailDrawer detail={detail} open={drawerOpen} onClose={() => setDrawerOpen(false)} />
  </div>;
}
