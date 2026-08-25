import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, FileText, Loader2, X } from 'lucide-react';
import { api } from '@/lib/api';
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
  evidenceQuotes,
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

  const highlightQuotes = (sourceId: number) => (Array.isArray(evidenceQuotes) ? evidenceQuotes : [])
    .map(asRecord)
    .filter((item) => Number(item.sourceId ?? item.chunk_id ?? item.chunkId) === sourceId)
    .map((item) => String(item.quote ?? '').trim())
    .filter(Boolean);

  const highlightedContent = (content: string, sourceId: number) => {
    const quotes = highlightQuotes(sourceId).sort((a, b) => b.length - a.length);
    if (!quotes.length) return content;
    const parts: Array<{ text: string; marked: boolean }> = [{ text: content, marked: false }];
    quotes.forEach((quote) => {
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        const part = parts[index];
        if (part.marked) continue;
        const offset = part.text.indexOf(quote);
        if (offset < 0) continue;
        parts.splice(index, 1,
          { text: part.text.slice(0, offset), marked: false },
          { text: quote, marked: true },
          { text: part.text.slice(offset + quote.length), marked: false },
        );
      }
    });
    return parts.filter((part) => part.text).map((part, index) => part.marked
      ? <mark key={index} className="rounded bg-brand-amber/25 px-0.5 text-ink ring-1 ring-brand-amber/35">{part.text}</mark>
      : <span key={index}>{part.text}</span>);
  };

  const openSource = async (id: number, source: Record<string, unknown>) => {
    setOpened({ id, source });
    setChunk(null);
    setLiveError(null);
    const chunkId = String(source.chunkId ?? '').trim();
    if (!chunkId) return;
    setLoading(true);
    try {
      setChunk(await api.getRagflowChunk(chunkId));
    } catch {
      /* RAGFlow id 在 MySQL 反查失败：快照中存的可能是 knowledge_chunk.id（数字），直接按 MySQL 切片 id 取原文 */
      const numeric = Number(chunkId);
      if (Number.isFinite(numeric) && numeric > 0) {
        try {
          setChunk(await api.getRagChunk(numeric));
        } catch (reason2) {
          setLiveError(reason2 instanceof Error ? reason2.message : '暂时无法读取切片原文（MySQL 未命中）');
        }
      } else {
        /* RAGFlow hash（非数字）：MySQL 的 ragflow_chunk_id 未回填，历史资源此路径不可回溯——已展示生成时快照，无需重新生成 */
        setLiveError('该引用保存于历史版本，切片标识 ' + chunkId.slice(0, 20) + '… 未关联当前知识库（ragflow_chunk_id 未回填），以下展示生成时保存的来源快照。');
      }
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
                    /* 魔改 HTML <img>（含 data-figure-id/data-vlm-description 等）或 markdown 图片：只取 src 加载显示 */
                    if (/<img\b|!\[[^\]]*\]\([^)]+\)/i.test(rawContent)) {
                      const parts = rawContent.split(/(<img\b[^>]*>|!\[[^\]]*\]\([^)]+\))/gi);
                      return (
                        <div className="whitespace-pre-wrap rounded-[14px] border border-hairline bg-card-warm p-4 text-[13.5px] leading-7 text-ink-2">
                          {parts.map((part, index) => {
                            const imgTag = part.match(/^<img\b([^>]*)>$/i);
                            const mdImg = !imgTag ? part.match(/^!\[[^\]]*\]\(([^)\s"']+)["']?[^)]*\)$/) : null;
                            if (imgTag) {
                              const srcMatch = imgTag[1].match(/src\s*=\s*["']([^"']+)["']/i);
                              const altMatch = imgTag[1].match(/alt\s*=\s*["']([^"']*)["']/i);
                              if (!srcMatch) return <span key={index}>{part}</span>;
                              return <img key={index} src={srcMatch[1]} alt={altMatch && altMatch[1] ? altMatch[1] : '切片图片'} className="my-2 block max-w-full rounded-lg border border-hairline" loading="lazy" />;
                            }
                            if (mdImg) {
                              return <img key={index} src={mdImg[1]} alt="切片图片" className="my-2 block max-w-full rounded-lg border border-hairline" loading="lazy" />;
                            }
                            return <span key={index}>{part}</span>;
                          })}
                        </div>
                      );
                    }
                    return <div className="whitespace-pre-wrap rounded-[14px] border border-hairline bg-card-warm p-4 text-[13.5px] leading-7 text-ink-2">{highlightedContent(rawContent, opened.id)}</div>;
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
