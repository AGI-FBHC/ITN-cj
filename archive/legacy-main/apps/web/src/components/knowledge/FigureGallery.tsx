import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ExternalLink, ImageOff, Loader2, Search, X } from 'lucide-react';
import { api } from '@/lib/api';
import type { RagFigureSummary } from '@/lib/api';

/*
 * 知识配图（W3）：把后端 /api/v1/rag/figures 的 200 多张图 + VLM 描述拿出来看。
 *
 * 旧版（src/frontend/agent-demo 的 RagKnowledgeBase）就有「切片 / 图示」两条路，网页版只剩切片。
 *
 * 两个刻意的设计：
 *  1. 一次性把全部配图读进来（每页 50，207 张约 5 个请求）。「按文档筛选」如果只筛当前这一页，
 *     筛出来的结果是假的 —— 用户会以为某文档没有图。图片另说（见下）。
 *  2. 图片先探一张：本机没有图片文件时（后端 asset-dir 是空的，实测 404），
 *     全部走「没有文件」的占位，而不是给每张卡挂一个必然 404 的 <img> ——
 *     那样控制台会被 404 刷屏，用户看到的是 24 个破图图标。描述和图注照常可读，
 *     大图里再给出原始出处链接（网络可达时点开就是原图）。
 */

const PAGE_SIZE = 50;
const PAGE_CAP = 12; // 兜底上限（600 张），避免后端数据异常时无限翻页
const COLUMNS_STEP = 24;

type ImageMode = 'probing' | 'ok' | 'missing';

export default function FigureGallery({ initialQuery = '' }: { initialQuery?: string }) {
  const [items, setItems] = useState<RagFigureSummary[]>([]);
  const [stats, setStats] = useState<{ total: number; described: number; pending: number; failed: number } | null>(null);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [docFilter, setDocFilter] = useState('all');
  const [text, setText] = useState(initialQuery);
  const [visible, setVisible] = useState(COLUMNS_STEP);
  const [zoom, setZoom] = useState<RagFigureSummary | null>(null);
  const [zoomSource, setZoomSource] = useState<{ sourceUrl: string | null; storageKey: string | null } | null>(null);
  const [imageMode, setImageMode] = useState<ImageMode>('probing');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      const collected: RagFigureSummary[] = [];
      try {
        for (let page = 0; page < PAGE_CAP; page += 1) {
          const result = await api.listRagFigures({ page, size: PAGE_SIZE });
          if (cancelled) return;
          collected.push(...result.items);
          setProgress({ loaded: collected.length, total: result.total });
          setItems([...collected]);
          setStats(result.stats);
          if (result.items.length === 0 || collected.length >= result.total) break;
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '配图读取失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /* 探第一张图：决定"本机有没有图片文件"，避免给每张卡挂必然失败的 img（控制台会被 404 刷屏） */
  const firstImageUrl = items.find((figure) => figure.imageUrl)?.imageUrl ?? '';
  useEffect(() => {
    if (!firstImageUrl) { setImageMode('missing'); return undefined; }
    let cancelled = false;
    const probe = async () => {
      try {
        const head = await fetch(firstImageUrl, { method: 'HEAD' });
        if (!cancelled) setImageMode(head.ok ? 'ok' : 'missing');
      } catch {
        if (!cancelled) setImageMode('missing');
      }
    };
    void probe();
    return () => { cancelled = true; };
  }, [firstImageUrl]);

  useEffect(() => {
    if (!zoom) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setZoom(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  /* 大图里补一次详情：summary 不带 sourceUrl / storageKey，打开时按需取（一次请求） */
  useEffect(() => {
    if (!zoom) { setZoomSource(null); return undefined; }
    let cancelled = false;
    api.getRagFigure(zoom.id)
      .then((detail) => { if (!cancelled) setZoomSource({ sourceUrl: detail.sourceUrl ?? null, storageKey: detail.storageKey ?? null }); })
      .catch(() => { if (!cancelled) setZoomSource(null); });
    return () => { cancelled = true; };
  }, [zoom]);

  const docNameOf = (figure: RagFigureSummary) => figure.documentTitle ?? '（未标注文档）';
  const docOptions = useMemo(() => Array.from(new Set(items.map(docNameOf))).sort(), [items]);

  const filtered = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return items.filter((figure) => {
      if (docFilter !== 'all' && docNameOf(figure) !== docFilter) return false;
      if (!needle) return true;
      const haystack = [figure.caption, figure.altText, figure.vlmDescription, figure.documentTitle, figure.figureLabel]
        .filter(Boolean).join(' ').toLowerCase();
      return haystack.indexOf(needle) >= 0;
    });
  }, [items, docFilter, text]);

  const shown = filtered.slice(0, visible);
  const showImage = imageMode === 'ok';

  const placeholder = (compact: boolean) => (
    <span className={compact ? 'flex flex-col items-center gap-1.5 px-4 text-center' : 'flex flex-col items-center gap-2 px-6 text-center'}>
      <ImageOff size={compact ? 18 : 26} className="text-ink-muted/70" />
      <span className="text-[11.5px] leading-[18px] text-ink-muted">
        图片文件不在本机
        <br />
        <span className="text-ink-muted/80">（描述与图注照常可读）</span>
      </span>
    </span>
  );

  return (
    <div>
      {/* 工具条：搜图注/描述 + 按文档筛 */}
      <div className="flex flex-wrap items-center gap-2.5">
        <label className="flex min-w-[240px] flex-1 items-center gap-2 rounded-[10px] border border-hairline bg-card-warm px-3 py-2">
          <Search size={14} className="shrink-0 text-ink-muted" />
          <input
            value={text}
            onChange={(event) => { setText(event.target.value); setVisible(COLUMNS_STEP); }}
            placeholder="搜图注、图片描述、文档标题"
            aria-label="搜索知识配图"
            className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-muted/70"
          />
          {text && (
            <button type="button" onClick={() => setText('')} aria-label="清空搜索" className="shrink-0 text-ink-muted hover:text-ink">
              <X size={13} />
            </button>
          )}
        </label>
        <select
          value={docFilter}
          onChange={(event) => { setDocFilter(event.target.value); setVisible(COLUMNS_STEP); }}
          aria-label="按文档筛选配图"
          className="max-w-[320px] rounded-[10px] border border-hairline bg-card-warm px-3 py-2 text-[13px] text-ink-2"
        >
          <option value="all">全部文档（{docOptions.length}）</option>
          {docOptions.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-ink-muted">
        {stats && (
          <span>
            共 {stats.total} 张 · 已写描述 {stats.described}
            {stats.pending ? ' · 待补 ' + stats.pending : ''}
            {stats.failed ? ' · 失败 ' + stats.failed : ''}
          </span>
        )}
        {loading && <span className="flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" />正在读取配图 {progress.loaded}/{progress.total || '…'}</span>}
        {!loading && <span>当前列出 {filtered.length} 张</span>}
        {!loading && imageMode === 'missing' && <span>图片文件未随库部署到本机，看的是图注与 VLM 描述</span>}
      </div>

      {error && <div className="mt-4 rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{error}</div>}

      {shown.length > 0 && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((figure) => (
            <button
              key={figure.id}
              type="button"
              onClick={() => setZoom(figure)}
              className="lf-card lf-card-hover flex flex-col overflow-hidden p-0 text-left"
            >
              <span className="flex h-[168px] w-full items-center justify-center overflow-hidden border-b border-hairline bg-paper-deep">
                {showImage && figure.imageUrl
                  ? <img src={figure.imageUrl} alt={figure.altText || figure.caption || '知识配图'} loading="lazy" className="max-h-[168px] w-full object-contain" />
                  : placeholder(true)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col p-4">
                <span className="flex items-center gap-2">
                  {figure.figureLabel && <span className="shrink-0 rounded bg-brand-tint/70 px-1.5 py-0.5 font-mono text-[10.5px] text-brand">{figure.figureLabel}</span>}
                  <span className="truncate text-[11.5px] text-ink-muted">{docNameOf(figure)}</span>
                </span>
                <span className="mt-2 line-clamp-2 text-[13.5px] font-medium leading-[20px] text-ink">{figure.caption || figure.altText || '（没有图注）'}</span>
                <span className="mt-1.5 line-clamp-2 text-[12px] leading-[18px] text-ink-muted">{figure.vlmDescription || '这张图还没有生成描述'}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {!loading && shown.length === 0 && (
        <div className="lf-card mt-4 p-10 text-center text-[13px] text-ink-muted">
          {items.length === 0 ? '这个领域还没有配图。' : '没有匹配的配图：换个词，或者把文档筛选清掉。'}
        </div>
      )}

      {visible < filtered.length && (
        <div className="mt-5 text-center">
          <button type="button" onClick={() => setVisible((value) => value + COLUMNS_STEP)} className="lf-btn-ghost !px-4 !py-2 text-[13px]">
            再看 {Math.min(COLUMNS_STEP, filtered.length - visible)} 张（还有 {filtered.length - visible} 张）
          </button>
        </div>
      )}

      <AnimatePresence>
        {zoom && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4"
            onClick={() => setZoom(null)}
            role="dialog"
            aria-modal="true"
            aria-label="查看知识配图"
          >
            <motion.div
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
              className="flex max-h-[92vh] w-full max-w-[1040px] flex-col overflow-hidden rounded-[16px] border border-hairline bg-paper shadow-warm-lg"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-3">
                <div className="min-w-0">
                  <div className="truncate text-[13.5px] font-semibold text-ink">{zoom.caption || zoom.altText || '（没有图注）'}</div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-ink-muted">
                    {[zoom.figureLabel, zoom.documentTitle, zoom.width && zoom.height ? zoom.width + '×' + zoom.height : null].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <button type="button" onClick={() => setZoom(null)} aria-label="关闭大图" className="shrink-0 rounded-lg border border-hairline p-1.5 text-ink-muted hover:text-ink">
                  <X size={15} />
                </button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto bg-paper-deep/40 p-5 lg:flex-row">
                <div className="flex min-w-0 flex-1 items-center justify-center rounded-[10px] bg-card-warm/60 py-6">
                  {showImage && zoom.imageUrl
                    ? <img src={zoom.imageUrl} alt={zoom.altText || zoom.caption || '知识配图'} className="max-h-[62vh] w-full object-contain" />
                    : placeholder(false)}
                </div>
                <div className="w-full shrink-0 lg:w-[330px]">
                  <div className="lf-mono-label">VLM DESCRIPTION · 图片描述</div>
                  <p className="mt-2 text-[12.5px] leading-[20px] text-ink-2">
                    {zoom.vlmDescription || '这张图还没有生成描述（后台补描述后会出现在这里）。'}
                  </p>
                  {zoomSource?.sourceUrl && (
                    <a
                      href={zoomSource.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-brand hover:underline"
                    >
                      原始出处
                      <ExternalLink size={12} />
                    </a>
                  )}
                  {zoomSource?.storageKey && (
                    <p className="mt-2 break-all font-mono text-[10.5px] leading-[16px] text-ink-muted">库内路径 {zoomSource.storageKey}</p>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
