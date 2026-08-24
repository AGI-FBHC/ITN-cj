import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArchiveRestore, BookOpen, ChevronDown, ChevronRight, ClipboardList, Eye, FileText, FolderTree, Loader2, MonitorPlay, Plus, RotateCcw, Search, ShieldCheck, Trash2, Wrench, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, type AdminResourceDetail, type AdminResourceItem, type AdminResourceStats, type RagDomain, type RagTree, type RagTreeNode } from '@/lib/api';
import QuestionBankAdmin from './QuestionBankAdmin';
import { cn } from '@/lib/utils';

type ResourceKind = 'lecture' | 'practice' | 'questions' | 'ppt';
type View = 'library' | 'review' | 'recycle';
const typeText: Record<string, string> = { lecture: '讲义', practice: '实操指南', quiz: '题库', ppt: 'PPT' };
const reviewText: Record<string, string> = { DRAFT: '草稿', PENDING: '待审核', APPROVED: '已通过', REJECTED: '已驳回', PUBLISHED: '已发布', DEPRECATED: '已下架' };
const kinds: [ResourceKind, string, string, typeof FileText][] = [
  ['lecture', '讲义', '知识讲解', BookOpen],
  ['practice', '实操指南', '步骤与任务', Wrench],
  ['questions', '题库', '逐题管理', ClipboardList],
  ['ppt', 'PPT', '演示课件', MonitorPlay],
];

function flatten(nodes: RagTreeNode[], expanded: Set<number>, depth = 0): { node: RagTreeNode; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...(node.children?.length && expanded.has(node.id) ? flatten(node.children, expanded, depth + 1) : [])]);
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="lf-empty px-6 py-14 text-center text-sm">{children}</div>;
}

export default function ResourceCenterAdmin() {
  const [domains, setDomains] = useState<RagDomain[]>([]);
  const [domain, setDomain] = useState<RagDomain | { code: '__unassigned__'; name: string; description: string } | null>(null);
  const [tree, setTree] = useState<RagTree | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [node, setNode] = useState<RagTreeNode | null>(null);
  const [kind, setKind] = useState<ResourceKind>('lecture');
  const [view, setView] = useState<View>('library');
  const [stats, setStats] = useState<AdminResourceStats>({ library: 0, pending: 0, published: 0, recycle: 0 });
  const [items, setItems] = useState<AdminResourceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [detail, setDetail] = useState<AdminResourceDetail | null>(null);

  useEffect(() => {
    api.listRagDomains().then(setDomains).catch((e) => toast.error(e.message));
    api.getAdminResourceStats().then(setStats).catch(() => undefined);
  }, []);

  const openDomain = async (next: RagDomain | { code: '__unassigned__'; name: string; description: string }) => {
    setDomain(next);
    setNode(null);
    setKind('lecture');
    setKeyword('');
    setTree(null);
    if (next.code === '__unassigned__') {
      setView('recycle');
      return;
    }
    setTreeLoading(true);
    try {
      const value = await api.getRagTree(next.code);
      setTree(value);
      setExpanded(new Set(value.nodes.map((n) => n.id)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '目录树读取失败');
    } finally {
      setTreeLoading(false);
    }
  };

  const resourceType = kind === 'questions' ? 'quiz' : kind;

  const load = useCallback(async () => {
    if (!domain || kind === 'questions') return;
    setLoading(true);
    try {
      const listed = await api.listAdminResources({ view, type: resourceType, keyword, domainCode: domain.code, nodeCode: node?.nodeCode });
      setItems(listed.items);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '资源读取失败');
    } finally {
      setLoading(false);
    }
  }, [domain, kind, keyword, node?.nodeCode, resourceType, view]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => flatten(tree?.nodes || [], expanded), [tree, expanded]);

  const act = async (item: AdminResourceItem, action: string) => {
    try {
      if (action === 'restore') await api.restoreAdminResource(item.id);
      else if (action === 'candidate') await api.makeAdminResourceCandidate(item.id);
      else if (action === 'archive') await api.archiveAdminResource(item.id);
      else await api.reviewAdminResource(item.id, action as 'submit' | 'approve' | 'reject' | 'publish' | 'deprecate');
      toast.success(action === 'candidate' ? '已复制为通用资源草稿' : '资源状态已更新');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    }
  };

  const preview = async (item: AdminResourceItem) => {
    try {
      setDetail(await api.getAdminResource(item.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '资源预览失败');
    }
  };

  if (!domain)
    return (
      <div className="lf-anim-in-up">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-ink">资源中心</h2>
            <p className="mt-1.5 text-sm text-ink-muted">先选择领域，再沿知识目录管理四类学习资源。</p>
          </div>
          <div className="lf-seg">
            <button onClick={() => setView('review')} className={cn('lf-seg-item', view === 'review' && 'lf-seg-item-active')}>
              <ShieldCheck size={13} />
              审核中心
              <span className={cn('rounded-full px-1.5 text-[10px]', view === 'review' ? 'bg-white/60' : 'bg-white/70')}>{stats.pending}</span>
            </button>
            <button onClick={() => setView('recycle')} className={cn('lf-seg-item', view === 'recycle' && 'lf-seg-item-active')}>
              <Trash2 size={13} />
              回收站
              <span className={cn('rounded-full px-1.5 text-[10px]', view === 'recycle' ? 'bg-white/60' : 'bg-white/70')}>{stats.recycle}</span>
            </button>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {domains.map((item) => (
            <button
              key={item.code}
              onClick={() => void openDomain(item)}
              className="lf-card lf-card-hover rounded-2xl p-6 text-left"
            >
              <span className="flex items-start justify-between">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-tint text-brand">
                  <FolderTree size={20} />
                </span>
                <ChevronRight size={16} className="mt-1 text-ink-muted/60" />
              </span>
              <h3 className="mt-4 text-base font-bold text-ink">{item.name}</h3>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-ink-muted">{item.description || '暂无领域说明'}</p>
              <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl bg-white/50 p-2.5 text-center text-[11px] text-ink-muted">
                <span>
                  <b className="block text-base font-bold tabular-nums text-ink">{item.categoryCount}</b>
                  目录
                </span>
                <span>
                  <b className="block text-base font-bold tabular-nums text-ink">{item.knowledgePointCount}</b>
                  知识点
                </span>
                <span>
                  <b className="block text-base font-bold tabular-nums text-ink">{item.chunkCount}</b>
                  切片
                </span>
              </div>
            </button>
          ))}
          <button
            onClick={() => void openDomain({ code: '__unassigned__', name: '未识别归属', description: '旧资源中无法可靠映射到领域目录的内容' })}
            className="lf-card lf-card-hover rounded-2xl border-dashed border-ochre/40 bg-ochre-tint/40 p-6 text-left"
          >
            <span className="flex items-start justify-between">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/70 text-ochre">
                <FolderTree size={20} />
              </span>
              <span className="lf-pill lf-pill-warn">{stats.recycle} 项</span>
            </span>
            <h3 className="mt-4 text-base font-bold text-ink">未识别归属</h3>
            <p className="mt-1 text-xs leading-5 text-ink-muted">安全收纳尚未建立稳定领域和知识点映射的历史资源。</p>
          </button>
        </div>
      </div>
    );

  return (
    <div className="lf-anim-in-up">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <nav className="flex items-center gap-1.5 text-xs text-ink-muted">
            <button onClick={() => { setDomain(null); setTree(null); setNode(null); }} className="lf-row-btn !px-2.5 !py-1 text-brand">
              资源中心
            </button>
            <span>/</span>
            <span className="font-semibold text-ink">{domain.name}</span>
          </nav>
          <h2 className="mt-2 text-xl font-bold tracking-tight text-ink">{node?.name || domain.name} · 资源管理</h2>
        </div>
        <div className="flex gap-2">
          <button disabled className="lf-row-btn cursor-not-allowed opacity-50">
            <Plus size={13} />
            预生成（待开放）
          </button>
          <button onClick={() => setView(view === 'recycle' ? 'library' : 'recycle')} className={cn('lf-row-btn', view === 'recycle' && 'lf-row-btn-primary')}>
            {view === 'recycle' ? <RotateCcw size={13} /> : <Trash2 size={13} />}
            {view === 'recycle' ? '返回资源库' : '回收站'}
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <aside className="lf-card overflow-hidden rounded-2xl">
          <div className="border-b border-white/60 px-4 py-3.5">
            <p className="text-sm font-bold text-ink">{domain.name}</p>
            <p className="mt-0.5 text-[11px] text-ink-muted">知识目录</p>
          </div>
          <button
            onClick={() => setNode(null)}
            className={cn('w-full border-b border-white/50 px-4 py-3 text-left text-xs font-semibold transition-colors', !node ? 'lf-tree-active' : 'text-ink-2 hover:bg-brand-tint/60')}
          >
            领域全部资源
          </button>
          {domain.code === '__unassigned__' ? (
            <div className="lf-empty m-3 rounded-xl p-4 text-xs leading-5">这些资源缺少可靠目录映射。可预览后恢复，或在后续人工绑定到领域知识点。</div>
          ) : treeLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="animate-spin" size={17} />
            </div>
          ) : (
            <div className="max-h-[640px] overflow-y-auto py-1.5">
              {rows.map(({ node: itemNode, depth }) => (
                <div
                  key={itemNode.id}
                  className={cn('flex items-center pr-2 text-xs transition-colors', node?.id === itemNode.id ? 'lf-tree-active rounded-lg' : 'text-ink-2 hover:bg-brand-tint/50')}
                  style={{ paddingLeft: 6 + depth * 14 }}
                >
                  {itemNode.children?.length ? (
                    <button
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          next.has(itemNode.id) ? next.delete(itemNode.id) : next.add(itemNode.id);
                          return next;
                        })
                      }
                      className="p-2 text-ink-muted"
                    >
                      {expanded.has(itemNode.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                  ) : (
                    <span className="w-7" />
                  )}
                  <button onClick={() => setNode(itemNode)} className="min-w-0 flex-1 truncate py-2.5 text-left">
                    {itemNode.name}
                  </button>
                  <span className="text-[10px] text-ink-muted/70">{itemNode.chunkCount || 0}</span>
                </div>
              ))}
            </div>
          )}
        </aside>

        <section>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            {kinds.map(([id, label, note, Icon]) => (
              <button
                key={id}
                onClick={() => setKind(id)}
                className={cn(
                  'lf-card rounded-2xl p-3.5 text-left transition-all',
                  kind === id ? 'ring-2 ring-brand/50 border-brand/40 bg-brand-tint/40' : 'hover:-translate-y-0.5'
                )}
              >
                <Icon size={17} className={kind === id ? 'text-brand' : 'text-ink-muted'} />
                <p className="mt-2 text-sm font-bold text-ink">{label}</p>
                <p className="mt-0.5 text-[11px] text-ink-muted">{note}</p>
              </button>
            ))}
          </div>

          {kind === 'questions' ? (
            domain.code === '__unassigned__' ? (
              <EmptyState>题库题目必须绑定知识目录，不提供未识别归属列表。</EmptyState>
            ) : !node ? (
              <EmptyState>请先从左侧目录树选择一个目录或知识点，再管理对应题目。</EmptyState>
            ) : (
              <QuestionBankAdmin categoryId={node.id} scopeLabel={node.name} />
            )
          ) : (
            <>
              <div className="lf-card mb-4 flex flex-wrap items-center gap-3 rounded-2xl p-3">
                <div className="lf-seg">
                  {([['library', '资源库'], ['review', '待审核'], ['recycle', '回收站']] as [View, string][]).map(([id, label]) => (
                    <button key={id} onClick={() => setView(id)} className={cn('lf-seg-item', view === id && 'lf-seg-item-active')}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="relative min-w-52 flex-1">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
                  <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索当前目录资源" className="lf-input pl-8" />
                </div>
              </div>
              <ResourceTable items={items} loading={loading} view={view} onPreview={preview} onAction={act} />
            </>
          )}
        </section>
      </div>

      {detail && <DetailModal detail={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function ResourceTable({ items, loading, view, onPreview, onAction }: { items: AdminResourceItem[]; loading: boolean; view: View; onPreview: (i: AdminResourceItem) => void; onAction: (i: AdminResourceItem, a: string) => Promise<void> }) {
  return (
    <div className="lf-table-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr>
              <th className="px-4 py-3.5">资源</th>
              <th className="px-4 py-3.5">状态</th>
              <th className="px-4 py-3.5">更新时间</th>
              <th className="px-4 py-3.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td className="max-w-lg px-4 py-3.5">
                  <p className="line-clamp-1 font-semibold text-ink">{item.title}</p>
                  <p className="mt-1 line-clamp-1 text-[11px] text-ink-muted">{item.topic}</p>
                </td>
                <td className="px-4 py-3.5">
                  {item.archivedAt ? (
                    <span className="lf-pill lf-pill-warn">已归档</span>
                  ) : item.reviewStatus ? (
                    <span className={cn('lf-pill', item.reviewStatus === 'PUBLISHED' ? 'lf-pill-ok' : item.reviewStatus === 'REJECTED' || item.reviewStatus === 'DEPRECATED' ? 'lf-pill-danger' : item.reviewStatus === 'PENDING' ? 'lf-pill-warn' : 'lf-pill-null')}>
                      {reviewText[item.reviewStatus] || item.reviewStatus}
                    </span>
                  ) : (
                    <span className="lf-pill lf-pill-null">用户历史版本</span>
                  )}
                  <p className="mt-1 text-[11px] text-ink-muted">v{item.revision}</p>
                </td>
                <td className="px-4 py-3.5 text-xs text-ink-muted">{new Date(item.archivedAt || item.updatedAt).toLocaleString('zh-CN')}</td>
                <td className="px-4 py-3.5 text-right">
                  <div className="flex justify-end gap-1.5">
                    <button onClick={() => onPreview(item)} className="lf-row-btn">
                      <Eye size={11} />
                      预览
                    </button>
                    {view === 'recycle' ? (
                      <>
                        <button onClick={() => void onAction(item, 'restore')} className="lf-row-btn lf-row-btn-primary">
                          <ArchiveRestore size={11} />
                          恢复
                        </button>
                        <button onClick={() => void onAction(item, 'candidate')} className="lf-row-btn">
                          转通用候选
                        </button>
                      </>
                    ) : (
                      <button onClick={() => void onAction(item, 'archive')} className="lf-row-btn text-ink-muted">
                        归档
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && (
        <div className="flex justify-center py-12 text-sm text-ink-muted">
          <Loader2 className="mr-2 animate-spin" size={16} />
          加载中…
        </div>
      )}
      {!loading && !items.length && <EmptyState>当前范围暂无资源</EmptyState>}
    </div>
  );
}

function DetailModal({ detail, onClose }: { detail: AdminResourceDetail; onClose: () => void }) {
  return (
    <div className="lf-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="lf-glass flex max-h-[88vh] w-full max-w-4xl flex-col rounded-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-white/60 px-5 py-4">
          <div>
            <h3 className="font-bold text-ink">{detail.title}</h3>
            <p className="mt-0.5 text-xs text-ink-muted">
              {typeText[detail.type] || detail.type} · v{detail.revision}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-ink-muted hover:bg-white/60">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto p-5">
          <p className="text-sm leading-6 text-ink-2">{detail.topic}</p>
          <pre className="mt-4 max-h-[440px] overflow-auto whitespace-pre-wrap rounded-xl bg-[#2C3A30] p-4 text-xs leading-5 text-emerald-50/90">
            {typeof detail.content === 'string' ? detail.content : JSON.stringify(detail.content, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}
