import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  adminKnowledgeApi, type GapStatus, type KcCategoryNode, type KcCategoryTree,
  type KcClassificationAudit, type KcCoverage, type KcSearchResult,
} from '@/lib/adminKnowledgeApi';
import { cn } from '@/lib/utils';
import { api, type RagDomain } from '@/lib/api';

type Tab = 'search' | 'coverage' | 'tree' | 'audit';
const tabs: { id: Tab; label: string }[] = [
  { id: 'search', label: '检索验证' }, { id: 'coverage', label: '覆盖报告' },
  { id: 'tree', label: '目录覆盖树' }, { id: 'audit', label: '分类审计' },
];
const input = 'lf-input';
const button = 'lf-btn-primary lf-btn-sm';

function GapTag({ gap }: { gap: GapStatus }) {
  const map = {
    no_chunks: ['无切片', 'lf-pill lf-pill-danger'],
    below_threshold: ['不足阈值', 'lf-pill lf-pill-warn'],
    ok: ['充足', 'lf-pill lf-pill-ok'],
  } as const;
  return <span className={cn('lf-pill', map[gap][1])}>{map[gap][0]}</span>;
}

function SearchPanel({ domain, allDomains = [], initialPoint = '' }: { domain: string; allDomains?: string[]; initialPoint?: string }) {
  const [point, setPoint] = useState(initialPoint); const [categoryId, setCategoryId] = useState('');
  const [threshold, setThreshold] = useState(''); const [mode, setMode] = useState<'fixed' | 'auto'>('fixed');
  const [minConfidence, setMinConfidence] = useState(''); const [includeRag, setIncludeRag] = useState(true);
  const [includePrerequisites, setIncludePrerequisites] = useState(false); const [includeContrasts, setIncludeContrasts] = useState(false);
  const [expandContext, setExpandContext] = useState(false); const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<KcSearchResult | null>(null);
  const run = async () => {
    if (!point.trim() && !categoryId) return toast.error('请输入知识点名称或 category_id');
    if (!domain && !point.trim()) return toast.error('全库检索请输入知识点名称');
    setLoading(true);
    try {
      const base = {
        knowledgePoint: point.trim() || `category:${categoryId}`,
        categoryId: categoryId ? Number(categoryId) : undefined,
        threshold: threshold ? Number(threshold) : undefined,
        thresholdMode: mode,
        minConfidence: minConfidence ? Number(minConfidence) : undefined,
        includeRag, includePrerequisites, includeContrasts, expandContext,
      };
      if (domain) {
        setResult(await adminKnowledgeApi.search({ ...base, domain }));
      } else {
        /* 全库检索：按领域名称逐个检索后合并去重 */
        const results = await Promise.all(allDomains.map((name) =>
          adminKnowledgeApi.search({ ...base, domain: name }).catch(() => null)));
        const seen = new Set<number>();
        const chunks: KcSearchResult['chunks'] = [];
        for (const item of results) {
          if (!item) continue;
          for (const hit of item.chunks ?? []) {
            if (hit.chunk_id != null && seen.has(hit.chunk_id)) continue;
            if (hit.chunk_id != null) seen.add(hit.chunk_id);
            chunks.push(hit);
          }
        }
        const first = results.find((item) => item !== null) ?? null;
        setResult(first ? {
          ...first,
          domain_code: '全库',
          decision: chunks.length ? 'mysql' : 'empty',
          chunks,
          hit_chunks: chunks,
          via_parent: false,
          warning: chunks.length ? null : '全库范围内没有命中切片',
        } : null);
      }
    } catch (error) { toast.error(error instanceof Error ? error.message : '检索失败'); } finally { setLoading(false); }
  };
  const decision = { mysql: 'MySQL 精确命中', parent: '父级上卷', rag: 'RAG 兜底', empty: '无结果' };
  return <div className="space-y-4">
    <div className="lf-card rounded-2xl p-4">
      <div className="grid gap-3 md:grid-cols-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-ink-2">知识点名称</span>
          <input value={point} onChange={(e) => setPoint(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} placeholder="如：ReAct 范式" className={cn(input, 'w-full')} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-ink-2">category_id（可选）</span>
          <input value={categoryId} onChange={(e) => setCategoryId(e.target.value)} type="number" className={cn(input, 'w-full')} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-ink-2">切片阈值（可选）</span>
          <input value={threshold} onChange={(e) => setThreshold(e.target.value)} type="number" className={cn(input, 'w-full')} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-ink-2">阈值模式</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as 'fixed' | 'auto')} className={cn('lf-select', 'w-full')}>
            <option value="fixed">fixed（固定 3）</option>
            <option value="auto">auto（章节均值）</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-ink-2">最低分类置信度</span>
          <input value={minConfidence} onChange={(e) => setMinConfidence(e.target.value)} type="number" min="0" max="1" step="0.05" className={cn(input, 'w-full')} />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-2">
        {[[includeRag, setIncludeRag, '启用 RAG 兜底'], [includePrerequisites, setIncludePrerequisites, '附带先修链'], [includeContrasts, setIncludeContrasts, '附带易混淆点'], [expandContext, setExpandContext, '强制补充相邻块']].map(([checked, setter, label]) => (
          <label key={label as string} className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" className="accent-[#4E7860]" checked={checked as boolean} onChange={(e) => (setter as (value: boolean) => void)(e.target.checked)} />
            {label as string}
          </label>
        ))}
      </div>
      <button type="button" onClick={() => void run()} disabled={loading} className={cn(button, 'mt-4')}>{loading ? <Loader2 size={14} className="mx-auto animate-spin" /> : '检索切片'}</button>
    </div>
    {result && (
      <div className="lf-card rounded-2xl p-4">
        <h3 className="text-sm font-bold text-ink">检索结果</h3>
        <p className="mt-1 text-xs text-ink-muted">决策：{decision[result.decision] || result.decision} · 命中 {(result.chunks ?? result.hit_chunks ?? []).length} 条 · {result.warning ? `提示：${result.warning}` : result.via_parent ? '经父级上卷命中' : '直接命中'}</p>
        {(result.chunks ?? result.hit_chunks ?? []).map((item) => (
          <div key={item.chunk_id} className="mt-3 rounded-xl border border-white/70 bg-white/50 p-3.5">
            <p className="font-semibold text-ink">{item.section_title || item.title_path}</p>
            {item.content && <p className="mt-1 line-clamp-3 text-xs leading-5 text-ink-2">{item.content}</p>}
            <p className="mt-2 font-mono text-[10px] text-ink-muted">chunk #{item.chunk_id} · {item.source} · conf {item.confidence?.toFixed(2) ?? '—'}</p>
          </div>
        ))}
      </div>
    )}
  </div>;
}

function CoveragePanel({ domain, onSearch }: { domain: string; onSearch: (name: string) => void }) {
  const [mode, setMode] = useState<'fixed' | 'auto'>('fixed'); const [gap, setGap] = useState<'all' | GapStatus>('all');
  const [data, setData] = useState<KcCoverage | null>(null); const [loading, setLoading] = useState(false);
  const load = async () => { setLoading(true); try { setData(await adminKnowledgeApi.coverage(domain, mode)); } catch (e) { toast.error(e instanceof Error ? e.message : '覆盖报告读取失败'); } finally { setLoading(false); } };
  const items = data?.items.filter((item) => gap === 'all' || item.gap === gap) || [];
  return <div className="lf-table-card">
    <div className="flex flex-wrap items-center gap-3 border-b border-white/60 p-4">
      <select value={mode} onChange={(e) => setMode(e.target.value as 'fixed' | 'auto')} className="lf-select w-auto"><option value="fixed">fixed 阈值</option><option value="auto">auto 阈值</option></select>
      <button type="button" onClick={() => void load()} disabled={loading} className={button}>{loading ? '读取中…' : '加载覆盖报告'}</button>
      <div className="lf-seg">
        {(['all', 'no_chunks', 'below_threshold', 'ok'] as const).map((item) => (
          <button key={item} type="button" onClick={() => setGap(item)} className={cn('lf-seg-item', gap === item && 'lf-seg-item-active')}>
            {item === 'all' ? '全部' : item === 'no_chunks' ? '无切片' : item === 'below_threshold' ? '不足阈值' : '充足'}
          </button>
        ))}
      </div>
    </div>
    {data && (
      <>
        <div className="grid grid-cols-2 border-b border-white/60 bg-white/35 md:grid-cols-5">
          {[['知识节点', data.summary.total_nodes], ['切片合计', data.summary.total_chunks], ['无切片', data.summary.no_chunks], ['不足阈值', data.summary.below_threshold], ['覆盖充足', data.summary.ok]].map(([label, value]) => (
            <div key={label as string} className="p-4">
              <p className="lf-stat-label">{label as string}</p>
              <p className="lf-stat-value">{value}</p>
            </div>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead>
              <tr>
                <th className="px-4 py-3.5">节点</th>
                <th className="px-4 py-3.5">编码</th>
                <th className="px-4 py-3.5">层级</th>
                <th className="px-4 py-3.5 text-right">切片</th>
                <th className="px-4 py-3.5 text-right">阈值</th>
                <th className="px-4 py-3.5">状态</th>
                <th className="px-4 py-3.5"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.category_id}>
                  <td className="px-4 py-3.5 font-semibold text-ink">{item.name}</td>
                  <td className="px-4 py-3.5 font-mono text-xs text-ink-muted">{item.node_code}</td>
                  <td className="px-4 py-3.5 text-ink-2">L{item.level}</td>
                  <td className="px-4 py-3.5 text-right tabular-nums text-ink">{item.chunk_count}</td>
                  <td className="px-4 py-3.5 text-right tabular-nums text-ink-muted">{item.threshold}</td>
                  <td className="px-4 py-3.5"><GapTag gap={item.gap} /></td>
                  <td className="px-4 py-3.5 text-right">
                    <button type="button" onClick={() => onSearch(item.name)} className="lf-row-btn">检索</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    )}
  </div>;
}

function flattenTree(nodes: KcCategoryNode[], expanded: Set<number>, gap: 'all' | GapStatus, depth = 0): { node: KcCategoryNode; depth: number }[] {
  return nodes.flatMap((node) => { const own = gap === 'all' || node.gap === gap ? [{ node, depth }] : []; return [...own, ...(expanded.has(node.id) ? flattenTree(node.children, expanded, gap, depth + 1) : [])]; });
}

function TreePanel({ domain }: { domain: string }) {
  const [mode, setMode] = useState<'fixed' | 'auto'>('fixed'); const [gap, setGap] = useState<'all' | GapStatus>('all'); const [data, setData] = useState<KcCategoryTree | null>(null); const [expanded, setExpanded] = useState<Set<number>>(new Set()); const [loading, setLoading] = useState(false);
  const load = async () => { setLoading(true); try { setData(await adminKnowledgeApi.tree(domain, mode)); setExpanded(new Set()); } catch (e) { toast.error(e instanceof Error ? e.message : '目录树读取失败'); } finally { setLoading(false); } };
  const rows = data ? flattenTree(data.tree, expanded, gap) : [];
  return <div className="lf-table-card">
    <div className="flex flex-wrap items-center gap-3 border-b border-white/60 p-4">
      <select value={mode} onChange={(e) => setMode(e.target.value as 'fixed' | 'auto')} className="lf-select w-auto"><option value="fixed">fixed 阈值</option><option value="auto">auto 阈值</option></select>
      <button type="button" onClick={() => void load()} disabled={loading} className={button}>{loading ? '读取中…' : '加载目录树'}</button>
      <div className="lf-seg">
        {(['all', 'no_chunks', 'below_threshold', 'ok'] as const).map((item) => (
          <button key={item} type="button" onClick={() => setGap(item)} className={cn('lf-seg-item', gap === item && 'lf-seg-item-active')}>
            {item === 'all' ? '全部' : item === 'no_chunks' ? '无切片' : item === 'below_threshold' ? '不足' : '充足'}
          </button>
        ))}
      </div>
      {data && <span className="lf-pill lf-pill-null">共 {data.total} 个节点</span>}
    </div>
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="px-4 py-3.5">分类节点</th>
            <th className="hidden px-4 py-3.5 md:table-cell">编码</th>
            <th className="w-24 px-4 py-3.5 text-right">切片</th>
            <th className="w-24 px-4 py-3.5">状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ node, depth }) => (
            <tr key={node.id}>
              <td className="px-4 py-3.5">
                <div className="flex items-center" style={{ paddingLeft: Math.min(depth, 4) * 18 }}>
                  {node.children.length ? (
                    <button type="button" onClick={() => setExpanded((current) => { const next = new Set(current); next.has(node.id) ? next.delete(node.id) : next.add(node.id); return next; })} className="mr-1 rounded p-1 text-ink-muted hover:bg-brand-tint">
                      {expanded.has(node.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  ) : <span className="mr-1 w-[22px]" />}
                  <span className="font-semibold text-ink">{node.name}</span>
                </div>
              </td>
              <td className="hidden px-4 py-3.5 font-mono text-xs text-ink-muted md:table-cell">{node.node_code}</td>
              <td className="px-4 py-3.5 text-right tabular-nums text-ink">{node.chunk_count}</td>
              <td className="px-4 py-3.5"><GapTag gap={node.gap} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {!rows.length && <div className="lf-empty m-4 py-10 text-center text-sm">当前筛选下没有目录节点</div>}
  </div>;
}

function AuditPanel({ domain }: { domain: string }) {
  const [maxConfidence, setMaxConfidence] = useState(0.7); const [source, setSource] = useState(''); const [data, setData] = useState<KcClassificationAudit | null>(null); const [loading, setLoading] = useState(false);
  const load = async () => { setLoading(true); try { setData(await adminKnowledgeApi.classificationAudit({ domain, maxConfidence, source })); } catch (e) { toast.error(e instanceof Error ? e.message : '审计记录读取失败'); } finally { setLoading(false); } };
  const act = async (item: KcClassificationAudit['items'][number], action: 'move' | 'set_confidence' | 'delete') => {
    try {
      if (action === 'delete') { if (!window.confirm(`确认删除分类记录 #${item.classification_id}？`)) return; await adminKnowledgeApi.correctClassification({ action, classification_id: item.classification_id }); }
      if (action === 'set_confidence') { const raw = window.prompt('新的置信度（0～1）', String(item.confidence ?? 0.9)); if (raw == null) return; const value = Number(raw); if (!Number.isFinite(value) || value < 0 || value > 1) return toast.error('置信度必须在 0～1 之间'); await adminKnowledgeApi.correctClassification({ action, classification_id: item.classification_id, confidence: value }); }
      if (action === 'move') { const name = window.prompt('目标知识点名称'); if (!name?.trim()) return; const found = await adminKnowledgeApi.search({ knowledgePoint: name.trim(), domain, thresholdMode: 'fixed', includeRag: false, includePrerequisites: false, includeContrasts: false, expandContext: false }); if (!found.category_id) throw new Error(`未找到知识点：${name}`); await adminKnowledgeApi.correctClassification({ action, classification_id: item.classification_id, new_category_id: found.category_id }); }
      toast.success('分类记录已更新'); await load();
    } catch (e) { toast.error(e instanceof Error ? e.message : '操作失败'); }
  };
  return <div className="lf-table-card">
    <div className="flex flex-wrap items-end gap-3 border-b border-white/60 p-4">
      <label className="text-xs font-semibold text-ink-2">置信度 ≤
        <input value={maxConfidence} onChange={(e) => setMaxConfidence(Number(e.target.value))} type="number" min="0" max="1" step="0.05" className={cn('lf-input', 'ml-2 w-28')} />
      </label>
      <label className="text-xs font-semibold text-ink-2">来源
        <select value={source} onChange={(e) => setSource(e.target.value)} className={cn('lf-select w-auto', 'ml-2')}>
          <option value="">全部</option>
          <option value="llm">llm</option>
          <option value="manual">manual</option>
          <option value="agent">agent</option>
          <option value="rag_backfill">rag_backfill</option>
        </select>
      </label>
      <button type="button" onClick={() => void load()} disabled={loading} className={button}>{loading ? '读取中…' : '加载低置信度分类'}</button>
      {data && <span className="lf-pill lf-pill-null">{data.total} 条</span>}
    </div>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-sm">
        <thead>
          <tr>
            <th className="px-4 py-3.5">切片</th>
            <th className="px-4 py-3.5">当前知识点</th>
            <th className="px-4 py-3.5">关系</th>
            <th className="px-4 py-3.5">置信度</th>
            <th className="px-4 py-3.5">来源</th>
            <th className="px-4 py-3.5 text-right">纠错</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((item) => (
            <tr key={item.classification_id}>
              <td className="max-w-sm px-4 py-3.5">
                <div className="font-semibold text-ink">{item.chunk_code || `chunk #${item.chunk_id}`}</div>
                <div className="mt-1 truncate text-xs text-ink-muted">{item.content_preview}</div>
              </td>
              <td className="px-4 py-3.5">
                <div className="text-ink">{item.category_name}</div>
                <div className="font-mono text-xs text-ink-muted">{item.node_code} · ID {item.category_id}</div>
              </td>
              <td className="px-4 py-3.5 text-ink-2">{item.relation_type}</td>
              <td className="px-4 py-3.5 tabular-nums text-ink">{item.confidence?.toFixed(2) ?? '—'}</td>
              <td className="px-4 py-3.5 text-ink-2">{item.source}</td>
              <td className="px-4 py-3.5 text-right">
                <div className="flex justify-end gap-1.5">
                  <button type="button" onClick={() => void act(item, 'move')} className="lf-row-btn">移动</button>
                  <button type="button" onClick={() => void act(item, 'set_confidence')} className="lf-row-btn">调置信度</button>
                  <button type="button" onClick={() => void act(item, 'delete')} className="lf-row-btn lf-row-btn-danger">删除</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {data && !data.items.length && <div className="lf-empty m-4 py-10 text-center text-sm">没有符合条件的分类记录</div>}
  </div>;
}

export default function KnowledgeQuality() {
  const [tab, setTab] = useState<Tab>('search');
  const [domain, setDomain] = useState('');
  const [domains, setDomains] = useState<RagDomain[]>([]);
  const [searchPoint, setSearchPoint] = useState('');

  useEffect(() => {
    let alive = true;
    api.listRagDomains()
      .then((items) => {
        if (!alive) return;
        setDomains(items);
        setDomain((current) => current || items[0]?.name || '');
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : '领域列表读取失败'));
    return () => { alive = false; };
  }, []);

  const domainNames = useMemo(() => domains.map((item) => item.name), [domains]);
  const body = useMemo(() => {
    const needDomain = tab !== 'search' && !domain;
    if (needDomain) {
      return <div className="lf-empty rounded-2xl py-12 text-center text-sm text-ink-muted">该视图需要选择具体领域，请先在右上角切换领域。</div>;
    }
    return tab === 'search'
      ? <SearchPanel key={searchPoint} domain={domain} allDomains={domainNames} initialPoint={searchPoint} />
      : tab === 'coverage'
        ? <CoveragePanel domain={domain} onSearch={(name) => { setSearchPoint(name); setTab('search'); }} />
        : tab === 'tree' ? <TreePanel domain={domain} /> : <AuditPanel domain={domain} />;
  }, [tab, domain, searchPoint, domainNames]);
  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-ink">知识质量管理</h2>
          <p className="mt-1.5 text-sm text-ink-muted">交付包 KnowledgeCore：检索验证、覆盖缺口、目录覆盖和分类纠错。</p>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-ink-2">检索领域</span>
          <select value={domain} onChange={(e) => setDomain(e.target.value)} className={cn('lf-select', 'w-56')} aria-label="检索领域">
            <option value="">全库检索</option>
            {domains.map((item) => <option key={item.code} value={item.name}>{item.name}</option>)}
          </select>
        </label>
      </div>
      <div className="lf-seg mb-5">
        {tabs.map((item) => (
          <button key={item.id} type="button" onClick={() => setTab(item.id)} className={cn('lf-seg-item', tab === item.id && 'lf-seg-item-active')}>
            {item.label}
          </button>
        ))}
      </div>
      {body}
    </>
  );
}
