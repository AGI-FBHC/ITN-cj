/**
 * Resources `/resources` — 我的资源
 *
 * 展示当前学习者所有定制资源（讲义 / 实操 / 分阶题 / 交互课件 / 上传文档），
 * 按知识领域分组；点卡片进入资源播放器。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, ChevronDown, ClipboardCheck, FileText, Loader2, Presentation, Search, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import type { LearningResourceSummary, RagDomain } from '@/lib/api';
import { cn } from '@/lib/utils';

type ResourceKind = 'lecture' | 'practice' | 'quiz' | 'ppt' | 'file';

const KIND_META: Record<ResourceKind, { label: string; Icon: typeof BookOpen; color: string }> = {
  lecture: { label: '讲义', Icon: BookOpen, color: '#4E7860' },
  practice: { label: '实操', Icon: Wrench, color: '#B77552' },
  quiz: { label: '分阶题', Icon: ClipboardCheck, color: '#7A6BA8' },
  ppt: { label: '交互课件', Icon: Presentation, color: '#3B82F6' },
  file: { label: '文档', Icon: FileText, color: '#8A7A63' },
};

const kindOf = (type: string): ResourceKind =>
  (['lecture', 'practice', 'quiz', 'ppt', 'file'] as ResourceKind[]).includes(type as ResourceKind)
    ? (type as ResourceKind)
    : 'lecture';

/** 每个领域内固定按这四类展示 */
const KIND_ORDER: ResourceKind[] = ['lecture', 'practice', 'quiz', 'ppt'];

function ResourceCard({ resource }: { resource: LearningResourceSummary }) {
  const meta = KIND_META[kindOf(resource.type)];
  const status = resource.learned ? '已学完' : resource.started ? '学习中' : '未开始';
  return (
    <Link
      to={`/learn/resource/${encodeURIComponent(resource.id)}`}
      className="lf-card group flex items-start gap-3 rounded-[8px] p-3.5 transition-colors hover:border-brand/45"
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border"
        style={{ color: meta.color, borderColor: `${meta.color}40`, backgroundColor: `${meta.color}0D` }}
      >
        <meta.Icon size={16} strokeWidth={1.8} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[13.5px] font-medium leading-5 text-ink group-hover:text-brand">
          {resource.title}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 text-[10.5px] text-ink-muted">
          <span>{meta.label}</span>
          {resource.topic ? <span className="truncate">· {resource.topic}</span> : null}
        </span>
        <span className={cn(
          'mt-1.5 inline-flex items-center gap-1 text-[10.5px]',
          resource.learned ? 'text-brand' : resource.started ? 'text-ochre' : 'text-ink-muted',
        )}>
          {status}
          {!resource.learned && (resource.progressRatio ?? 0) > 0
            ? ` · ${Math.round((resource.progressRatio ?? 0) * 100)}%`
            : ''}
        </span>
      </span>
    </Link>
  );
}

export default function Resources() {
  const [domains, setDomains] = useState<RagDomain[]>([]);
  const [index, setIndex] = useState<Array<{ domainCode: string; domainName: string; nodeCode: string; name: string; level: number }>>([]);
  const [resources, setResources] = useState<LearningResourceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  /** 收起的领域（默认全部展开） */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleGroup = (code: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.listRagDomains().catch(() => [] as RagDomain[]),
      api.getCategoryIndex().catch(() => []),
      api.listLearningResources({ scope: 'own' }).catch(() => ({ resources: [] as LearningResourceSummary[] })),
    ]).then(([domainList, nodeList, listed]) => {
      if (cancelled) return;
      setDomains(domainList);
      setIndex(nodeList);
      setResources(listed.resources ?? []);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  /* 知识点编码 → 所属领域 */
  const domainByNode = useMemo(() => {
    const map = new Map<string, { code: string; name: string }>();
    index.forEach((node) => map.set(node.nodeCode, { code: node.domainCode, name: node.domainName }));
    return map;
  }, [index]);

  /* 搜索过滤：标题 + 知识点 */
  const keyword = query.trim().toLowerCase();
  const visibleResources = useMemo(() => (
    keyword
      ? resources.filter((resource) => `${resource.title} ${resource.topic ?? ''}`.toLowerCase().includes(keyword))
      : resources
  ), [resources, keyword]);

  const groups = useMemo(() => {
    const order = new Map(domains.map((domain, position) => [domain.code, position]));
    const nameOf = new Map(domains.map((domain) => [domain.code, domain.name]));
    const grouped = new Map<string, { code: string; name: string; items: LearningResourceSummary[] }>();
    visibleResources.forEach((resource) => {
      const hit = resource.kpId ? domainByNode.get(resource.kpId) : undefined;
      const code = hit?.code ?? '__other__';
      const name = hit?.name ?? nameOf.get(code) ?? '未归类资源';
      const bucket = grouped.get(code) ?? { code, name, items: [] };
      bucket.items.push(resource);
      grouped.set(code, bucket);
    });
    return [...grouped.values()]
      .map((group) => ({
        ...group,
        items: [...group.items].sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')),
      }))
      .sort((left, right) => (
        (order.get(left.code) ?? 999) - (order.get(right.code) ?? 999)
        || right.items.length - left.items.length
      ));
  }, [visibleResources, domains, domainByNode]);

  return (
    <div className="mx-auto max-w-[1120px] px-5 pb-12 pt-8 md:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索我的资源：标题、知识点…"
            aria-label="搜索我的资源"
            className="h-10 w-full rounded-[10px] border border-hairline bg-card-warm pl-9 pr-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-muted/70 focus:border-brand/60"
          />
        </div>
        <span className="shrink-0 text-[11.5px] text-ink-muted">
          {loading ? '正在汇总…' : keyword ? `${visibleResources.length} / ${resources.length} 份` : `共 ${resources.length} 份`}
        </span>
      </div>

      {loading ? (
        <div className="mt-8 flex items-center justify-center gap-2 rounded-[10px] border border-hairline bg-card-warm py-14 text-[13.5px] text-ink-muted">
          <Loader2 size={16} className="animate-spin" />
          正在读取我的资源…
        </div>
      ) : resources.length === 0 ? (
        <div className="mt-8 rounded-[10px] border border-hairline bg-card-warm p-8 text-center">
          <p className="text-[13.5px] text-ink-muted">还没有定制资源。</p>
          <p className="mt-1 text-[12px] text-ink-muted">进入任意知识点，点「一键定制」即可生成属于你的讲义 / 实操 / 分阶题。</p>
          <Link to="/learn" className="lf-btn-ghost mt-4 inline-flex">去我的学习</Link>
        </div>
      ) : groups.length === 0 ? (
        <div className="mt-8 rounded-[10px] border border-hairline bg-card-warm p-8 text-center">
          <p className="text-[13.5px] text-ink-muted">没有匹配「{query.trim()}」的资源。</p>
          <button type="button" onClick={() => setQuery('')} className="lf-btn-ghost mt-4 inline-flex">清空搜索</button>
        </div>
      ) : (
        groups.map((group) => {
          const isCollapsed = !keyword && collapsed.has(group.code);
          return (
            <section key={group.code} className="mt-6">
              <button
                type="button"
                onClick={() => toggleGroup(group.code)}
                aria-expanded={!isCollapsed}
                className="flex w-full items-center justify-between gap-3 rounded-[8px] border border-transparent px-1 py-1.5 text-left transition-colors hover:bg-brand-tint/40"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ChevronDown
                    size={16}
                    className={cn('shrink-0 text-ink-muted transition-transform duration-200', isCollapsed && '-rotate-90')}
                  />
                  <h2 className="truncate font-serif text-[18px] font-semibold text-ink">{group.name}</h2>
                </span>
                <span className="shrink-0 text-[11.5px] text-ink-muted">{group.items.length} 份</span>
              </button>

              {!isCollapsed && (
                <div className="mt-2 space-y-4">
                  {KIND_ORDER.map((kind) => {
                    const meta = KIND_META[kind];
                    const items = group.items.filter((resource) => kindOf(resource.type) === kind);
                    return (
                      <div key={kind}>
                        <div className="flex items-center gap-1.5 px-1 text-[11.5px] text-ink-muted">
                          <meta.Icon size={13} style={{ color: meta.color }} />
                          <span className="font-medium text-ink-2">{meta.label}</span>
                          <span className="font-mono">· {items.length}</span>
                        </div>
                        {items.length > 0 ? (
                          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                            {items.map((resource) => <ResourceCard key={resource.id} resource={resource} />)}
                          </div>
                        ) : (
                          <p className="mt-1 px-1 text-[11px] text-ink-muted/70">暂无{meta.label}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
