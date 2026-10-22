/**
 * Discover `/discover` — 发现课程
 * 左侧预设分类，右侧默认展示「全部课程」并按分类分组；支持关键词检索；
 * 点击课程卡片进入课程介绍页。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Compass, Loader2, Search, X } from 'lucide-react';
import { api, type RagDomain } from '@/lib/api';
import { cn } from '@/lib/utils';

/** 领域类别：存于 knowledge_domain.category，由管理端「资源中心」维护（如 AI与大模型） */
const UNCATEGORIZED = '未分类';

function categoryOf(domain: RagDomain): string {
  return domain.category?.trim() || UNCATEGORIZED;
}

function CourseCover({ domain, cover }: { domain: RagDomain; cover?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative h-[96px] w-[72px] shrink-0 overflow-hidden rounded-[8px] bg-brand-tint">
      {cover && !failed ? (
        <img src={cover} alt={domain.name} onError={() => setFailed(true)} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full flex-col justify-between bg-gradient-to-br from-brand-tint to-brand-amber-tint p-2">
          <BookOpen size={14} className="text-brand" />
          <span className="font-serif text-[17px] font-semibold leading-none text-brand">{domain.name.slice(0, 2)}</span>
        </div>
      )}
    </div>
  );
}

function CourseCard({ domain, cover }: { domain: RagDomain; cover?: string }) {
  return (
    <Link
      to={`/discover/${encodeURIComponent(domain.code)}`}
      className="lf-card group flex gap-3.5 p-3.5 transition-colors hover:border-brand/45"
    >
      <CourseCover domain={domain} cover={cover} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded-md border border-brand/25 bg-brand-tint px-1.5 py-0.5 font-mono text-[10px] text-brand">
            {domain.domainType || '课程'}
          </span>
          <h3 className="truncate text-[14px] font-semibold text-ink transition-colors group-hover:text-brand">{domain.name}</h3>
        </div>
        <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-5 text-ink-muted">{domain.description || '暂无简介'}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-1.5 font-mono text-[10.5px] text-ink-muted">
          <span>{domain.knowledgePointCount} 知识点</span>
          <span>·</span>
          <span>{domain.categoryCount} 个分类</span>
          {domain.documentCount > 0 && <><span>·</span><span>{domain.documentCount} 篇文档</span></>}
        </div>
      </div>
    </Link>
  );
}

export default function Discover() {
  const [domains, setDomains] = useState<RagDomain[]>([]);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.listRagDomains()
      .then((list) => {
        if (cancelled) return;
        setDomains(list ?? []);
        setError('');
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : '课程列表读取失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  /* 封面按需单独拉取，失败就用占位封面，不影响列表 */
  useEffect(() => {
    const targets = domains.filter((domain) => domain.hasCover !== false);
    if (!targets.length) return;
    let cancelled = false;
    void Promise.all(targets.map(async (domain) => {
      try {
        const result = await api.getRagDomainCover(domain.code);
        return [domain.code, result.coverImage] as const;
      } catch {
        return null;
      }
    })).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      pairs.forEach((pair) => { if (pair?.[1]) next[pair[0]] = pair[1]; });
      setCovers(next);
    });
    return () => { cancelled = true; };
  }, [domains]);

  /* 分类 = 领域类别（管理端资源中心维护，可新建） */
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    domains.forEach((domain) => {
      const key = categoryOf(domain);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return Array.from(counts.entries())
      .filter(([key]) => key !== UNCATEGORIZED)
      .sort((left, right) => right[1] - left[1])
      .map(([key]) => key)
      .concat(counts.has(UNCATEGORIZED) ? [UNCATEGORIZED] : []);
  }, [domains]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    domains.forEach((domain) => {
      const key = categoryOf(domain);
      map[key] = (map[key] ?? 0) + 1;
    });
    return map;
  }, [domains]);

  const keyword = query.trim().toLowerCase();
  const filtered = useMemo(() => domains.filter((domain) => {
    if (category !== 'all' && categoryOf(domain) !== category) return false;
    if (!keyword) return true;
    return `${domain.name} ${domain.description ?? ''} ${domain.code}`.toLowerCase().includes(keyword);
  }), [domains, category, keyword]);

  /* 默认展示「全部」时按类别分组排列；选中某个类别时只展示该组 */
  const groups = useMemo(() => {
    const buckets = new Map<string, RagDomain[]>();
    filtered.forEach((domain) => {
      const key = categoryOf(domain);
      buckets.set(key, [...(buckets.get(key) ?? []), domain]);
    });
    return categories
      .filter((key) => buckets.has(key))
      .map((key) => ({ key, label: key, items: buckets.get(key) ?? [] }));
  }, [filtered, categories]);

  const sidebarItems = [
    { key: 'all', label: '全部课程', count: domains.length },
    ...categories.map((key) => ({ key, label: key, count: counts[key] ?? 0 })),
  ];

  return (
    <div className="mx-auto max-w-[1180px] px-5 pb-16 pt-8 md:px-8">
      <header>
        <div className="lf-mono-label flex items-center gap-2"><Compass size={13} />DISCOVER COURSES</div>
        <h1 className="mt-2 font-serif text-[30px] font-bold text-ink">发现课程</h1>
        <p className="mt-1.5 text-[12.5px] text-ink-muted">按分类浏览全部课程，也可以直接搜索书名或关键词；点课程卡片查看介绍。</p>
      </header>

      <div className="relative mt-5">
        <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索课程 / 书名 / 关键词…"
          aria-label="搜索课程"
          className="h-11 w-full rounded-[10px] border border-hairline bg-card-warm pl-10 pr-10 text-[13.5px] text-ink outline-none transition-colors placeholder:text-ink-muted/70 focus:border-brand/60"
        />
        {query && (
          <button type="button" onClick={() => setQuery('')} aria-label="清空搜索" className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink">
            <X size={15} />
          </button>
        )}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[190px_minmax(0,1fr)]">
        <aside>
          <div className="lf-mono-label mb-2 !text-[10.5px]">按分类浏览</div>
          <div className="space-y-1">
            {sidebarItems.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setCategory(item.key)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-[8px] px-3 py-2 text-left text-[13px] transition-colors',
                  category === item.key ? 'bg-brand-tint font-medium text-brand' : 'text-ink-2 hover:bg-paper-deep/70',
                )}
              >
                <span className="truncate">{item.label}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-ink-muted">{item.count}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="min-w-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 rounded-[10px] border border-hairline bg-card-warm py-16 text-[13px] text-ink-muted">
              <Loader2 size={16} className="animate-spin" />正在加载课程…
            </div>
          ) : error ? (
            <div className="rounded-[10px] border border-hairline bg-card-warm py-14 text-center">
              <p className="text-[13px] text-brand-danger">{error}</p>
              <button type="button" onClick={() => window.location.reload()} className="lf-btn-ghost mt-3">重新加载</button>
            </div>
          ) : !filtered.length ? (
            <div className="rounded-[10px] border border-hairline bg-card-warm py-14 text-center">
              <p className="text-[13px] text-ink-muted">{keyword ? `没有匹配「${query.trim()}」的课程` : '这个分类下还没有课程'}</p>
            </div>
          ) : (
            <div className="space-y-7">
              {groups.map((group) => (
                <section key={group.key}>
                  <div className="mb-2.5 flex items-baseline gap-2">
                    <h2 className="text-[15px] font-semibold text-ink">{group.label}</h2>
                    <span className="font-mono text-[10.5px] text-ink-muted">{group.items.length} 门</span>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    {group.items.map((domain) => (
                      <CourseCard key={domain.code} domain={domain} cover={covers[domain.code]} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
