import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createPortal } from 'react-dom';
import { ExternalLink, FileText, Loader2, X } from 'lucide-react';
import { lectureMdComponents } from '@/components/resources/lecture-markdown';
import { api } from '@/lib/api';
import remarkCitationMarks from '@/lib/remarkCitationMarks';
import type { LearningResource, RagChunkDetail } from '@/lib/api';
import { cn } from '@/lib/utils';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function citationNumbers(value: unknown): number[] {
  return Array.isArray(value)
    ? [...new Set(value.map(Number).filter((item) => Number.isFinite(item) && item > 0))]
    : [];
}

/**
 * Render resource-owned citations at the exact content block that declared them.
 * Unknown ids are intentionally omitted: showing an unresolvable badge implies
 * evidence exists when the stored resource has no matching source.
 */
export default function SourceCitationMarks({
  citations,

  resource,
  sources,
  className,
  compact = false,
}: {
  citations: unknown;
  evidenceQuotes?: unknown;
  resource?: LearningResource;
  sources?: Record<string, unknown>[];
  className?: string;
  compact?: boolean;
}) {
  const [opened, setOpened] = useState<{ id: number; source: Record<string, unknown> } | null>(null);
  const [chunk, setChunk] = useState<RagChunkDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  useEffect(() => {
    if (!opened) return undefined;
    const body = document.body;
    const previousOverflow = body.style.overflow;
    const previousPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpened(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPaddingRight;
    };
  }, [opened]);
  const sourceById = new Map<number, Record<string, unknown>>();
  (resource?.sources ?? sources ?? []).forEach((raw, index) => {
    const source = asRecord(raw);
    const id = Number(source.id ?? index + 1);
    if (Number.isFinite(id)) sourceById.set(id, source);
  });
  const matched = citationNumbers(citations)
    .map((id) => ({ id, source: sourceById.get(id) }))
    .filter((item): item is { id: number; source: Record<string, unknown> } => Boolean(item.source));
  if (!matched.length) return null;


  const openSource = async (id: number, source: Record<string, unknown>) => {
    setOpened({ id, source });
    setChunk(null);
    setLiveError(null);
    const chunkId = String(source.chunkId ?? '').trim();
    setLoading(true);
    try {
      const stableId = Number(source.knowledgeChunkId);
      if (Number.isFinite(stableId) && stableId > 0) {
        setChunk(await api.getRagChunk(stableId));
        return;
      }
      if (chunkId) {
        try {
          setChunk(await api.getRagflowChunk(chunkId));
          return;
        } catch { /* 历史数据的 RAGFlow ID 可能尚未回填到 MySQL */ }
      }
      const raw = String(source.content ?? '');
      const plain = raw.replace(/[`*_>#\[\]()]/g, ' ');
      const all = plain.split(/[。！？!?\r\n]+/)
        .map((item) => item.replace(/\s+/g, ' ').trim())
        .filter((item) => item.length >= 18 && item.length <= 180)
        .sort((a, b) => b.length - a.length)
        .map((item) => item.slice(0, 72));
      // Prefer tail half (RAGFlow prepends summary not in MySQL)
      const half = Math.floor(all.length / 2);
      const phrases = [...all.slice(half), ...all.slice(0, half)].slice(0, 8);
      for (const query of phrases) {
        const page = await api.searchRagChunks(query, 0, 5);
        if (page.items.length) {
          setChunk(await api.getRagChunk(page.items[0].id));
          return;
        }
      }
      throw new Error('MySQL 中未找到与来源快照匹配的知识切片');
    } catch {
      setLiveError('MySQL 中暂未找到对应知识切片，以下展示生成时保存的来源快照。');
    } finally {
      setLoading(false);
    }
  };

  return (
    <span className={cn('ml-1 inline-flex flex-wrap items-center gap-1 align-baseline', className)} aria-label="本段引用来源">
      {matched.map(({ id, source }) => {
        const title = String(source.document ?? source.title ?? `来源 ${id}`);
        const url = typeof source.url === 'string' ? source.url : null;
        const style = cn(
          'inline-flex items-center gap-1 rounded-md border border-brand/35 bg-brand-tint/55 font-mono font-medium text-brand transition-colors hover:border-brand hover:bg-brand-tint',
          compact ? 'px-1.5 py-px text-[10px] leading-4' : 'px-2 py-0.5 text-[10.5px] leading-[18px]',
        );
        const debated = source.debateVerified === true;
        const label = <><span>[{id}]</span>{debated && <span className="rounded bg-[#51477F] px-1 font-sans text-[8px] text-white">辩论通过</span>}{!compact && <span className="max-w-[180px] truncate font-sans font-normal">{title}</span>}{url && <ExternalLink size={9} />}</>;
        return <button key={id} type="button" onClick={() => void openSource(id, source)} title={`查看引用原文 [${id}]：${title}`} className={style}>{label}</button>;
      })}
      {opened && createPortal(
        <div className="fixed inset-0 z-[120] flex touch-none items-center justify-center overflow-hidden bg-ink/30 p-4 backdrop-blur-sm" onClick={() => setOpened(null)} onWheel={(event) => event.stopPropagation()}>
          <section role="dialog" aria-modal="true" aria-label={`引用 ${opened.id} 原文`} onClick={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} onTouchMove={(event) => event.stopPropagation()} className="flex max-h-[82vh] w-full max-w-[720px] flex-col overflow-hidden rounded-[22px] border border-white/70 bg-paper shadow-2xl">
            <header className="flex items-start gap-3 border-b border-hairline bg-card-warm px-5 py-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-tint text-brand"><FileText size={17} /></span>
              <div className="min-w-0 flex-1"><div className="font-mono text-[10px] text-brand">{String(opened.source.sourceType) === 'web' ? (opened.source.debateVerified === true ? '多源辩论通过' : '补充资料') : '知识库依据'} · [{opened.id}]</div><h2 className="mt-1 text-[15px] font-semibold text-ink">{chunk?.document.title ?? String(opened.source.document ?? opened.source.title ?? `来源 ${opened.id}`)}</h2>{chunk?.titlePath && <p className="mt-1 text-[11px] text-ink-muted">{chunk.titlePath}</p>}</div>
              <button type="button" aria-label="关闭原文" onClick={() => setOpened(null)} className="rounded-lg p-2 text-ink-muted hover:bg-paper-deep"><X size={17} /></button>
            </header>
            <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain p-5">
              {loading ? <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-muted"><Loader2 size={16} className="animate-spin" />正在读取向量知识库原始切片…</div> : <>
                {liveError && <div className="mb-3 rounded-xl border border-brand-amber/35 bg-brand-amber-tint px-3 py-2 text-[11.5px] text-ochre">实时原文读取失败，以下显示生成时保存的来源快照：{liveError}</div>}
                {
                  (() => {
                    const rawContent = chunk?.content ?? String(opened.source.content ?? '没有可显示的原文内容。');
                    const markdownContent = rawContent
                      .replace(/<img\b([^>]*)>/gi, (_tag, attrs: string) => {
                        const src = attrs.match(/src\s*=\s*["']([^"']+)["']/i)?.[1];
                        if (!src) return '';
                        const alt = attrs.match(/alt\s*=\s*["']([^"']*)["']/i)?.[1] || '切片图片';
                        return `\n\n![${alt.replace(/[\[\]]/g, '')}](${src})\n\n`;
                      })
                      .replace(/<\/?(?:div|p|center|figure|figcaption)\b[^>]*>/gi, '\n');
                    return (
                      <div className="rounded-[14px] border border-hairline bg-card-warm p-4 text-[13.5px] leading-7 text-ink-2">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm, remarkCitationMarks]}
                          components={{
                            ...lectureMdComponents,
                            img: ({ src, alt }) => src ? <img src={src} alt={alt || '切片图片'} className="my-3 block max-w-full rounded-lg border border-hairline" loading="lazy" /> : null,
                          }}
                        >
                          {markdownContent}
                        </ReactMarkdown>
                      </div>
                    );
                  })()}
                </>
              }
            </div>
          </section>
        </div>, document.body,
      )}
    </span>
  );
}
