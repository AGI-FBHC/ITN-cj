import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createPortal } from 'react-dom';
import { ExternalLink, FileText, Loader2, X } from 'lucide-react';
import { lectureMdComponents, secureImageSrc } from '@/components/resources/lecture-markdown';
import { api } from '@/lib/api';
import { readableSourceTitle } from '@/lib/sourceLabel';
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

interface EvidenceAnchor {
  sourceId: number;
  quote: string;
  claim?: string;
}

function evidenceAnchors(value: unknown, fallbackSourceId?: number): EvidenceAnchor[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((raw) => {
    const item = asRecord(raw);
    const sourceId = Number(item.sourceId ?? item.chunk_id ?? item.citationId ?? fallbackSourceId);
    const quote = String(item.quote ?? item.sourcePassage ?? item.evidenceQuote ?? '').trim();
    if (!Number.isFinite(sourceId) || sourceId <= 0 || !quote) return [];
    const key = `${sourceId}:${quote}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ sourceId, quote, claim: String(item.claim ?? '').trim() || undefined }];
  });
}

const plainEvidenceText = (value: string) => value
  .replace(/<[^>]+>/g, ' ')
  .replace(/[`*_>#\[\]()\\]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

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
      /* 实时原文不存在时直接展示来源快照，不打断阅读。 */
    } finally {
      setLoading(false);
    }
  };


  return (
    <span className={cn('ml-1 inline-flex flex-wrap items-center gap-1 align-baseline', className)} aria-label="本段引用来源">
      {matched.map(({ id, source }) => {
        const title = readableSourceTitle(source, id);
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
              <div className="min-w-0 flex-1"><div className="font-mono text-[10px] text-brand">{String(opened.source.sourceType) === 'web' ? (opened.source.debateVerified === true ? '多源辩论通过' : '补充资料') : '知识库依据'} · [{opened.id}]</div><h2 className="mt-1 text-[15px] font-semibold text-ink">{chunk?.document.title ?? readableSourceTitle(opened.source, opened.id)}</h2>{chunk?.titlePath && <p className="mt-1 text-[11px] text-ink-muted">{chunk.titlePath}</p>}</div>
              <button type="button" aria-label="关闭原文" onClick={() => setOpened(null)} className="rounded-lg p-2 text-ink-muted hover:bg-paper-deep"><X size={17} /></button>
            </header>
            <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain p-5">
              {loading ? <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-muted"><Loader2 size={16} className="animate-spin" />正在读取向量知识库原始切片…</div> : <>
                {
                  (() => {
                    const rawContent = chunk?.content ?? String(opened.source.content ?? '没有可显示的原文内容。');
                    const anchors = [
                      ...evidenceAnchors(evidenceQuotes, opened.id),
                      ...evidenceAnchors(opened.source.evidenceAnchors, opened.id),
                    ].filter((anchor, index, all) => all.findIndex((item) => item.sourceId === anchor.sourceId && item.quote === anchor.quote) === index)
                      .filter((anchor) => anchor.sourceId === opened.id);
                    const plainContent = plainEvidenceText(rawContent);
                    const markdownContent = rawContent
                      // 历史切片会把成对强调标记保存为 \*\*文本\*\*；仅恢复完整配对，避免误改普通转义字符。
                      .replace(/\\\*\\\*([^\n]+?)\\\*\\\*/g, '**$1**')
                      .replace(/<img\b([^>]*)>/gi, (_tag, attrs: string) => {
                        const src = attrs.match(/src\s*=\s*["']([^"']+)["']/i)?.[1];
                        if (!src) return '';
                        const alt = attrs.match(/alt\s*=\s*["']([^"']*)["']/i)?.[1] || '切片图片';
                        return `\n\n![${alt.replace(/[\[\]]/g, '')}](${src})\n\n`;
                      })
                      .replace(/<\/?(?:div|p|center|figure|figcaption)\b[^>]*>/gi, '\n');
                    return (
                      <div className="space-y-4">
                        {anchors.length > 0 && <section className="rounded-[14px] border border-brand-amber/40 bg-brand-amber-tint/35 p-4">
                          <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-[12px] font-semibold text-ink">支撑当前内容的事实原文</h3><span className="font-mono text-[9.5px] text-ochre">{anchors.length} 处依据</span></div>
                          <div className="space-y-3">
                            {anchors.map((anchor, index) => {
                              const located = plainContent.includes(plainEvidenceText(anchor.quote));
                              return <div key={`${anchor.sourceId}-${index}`} className="rounded-xl border border-brand-amber/30 bg-paper/85 px-3.5 py-3">
                                {anchor.claim && <p className="mb-2 text-[11px] leading-5 text-ink-muted">对应结论：{anchor.claim}</p>}
                                <mark className="box-decoration-clone rounded bg-[#FFE58A]/75 px-1 py-0.5 text-[13.5px] leading-7 text-ink decoration-clone">
                                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkCitationMarks]} components={lectureMdComponents}>{anchor.quote}</ReactMarkdown>
                                </mark>
                                <p className="mt-2 font-mono text-[9.5px] text-ochre">{located ? '已在实时切片原文中定位' : '生成时保存的事实原文'}</p>
                              </div>;
                            })}
                          </div>
                        </section>}
                        <section className="rounded-[14px] border border-hairline bg-card-warm p-4 text-[13.5px] leading-7 text-ink-2">
                          {anchors.length > 0 && <p className="mb-3 border-b border-hairline pb-2 font-mono text-[9.5px] tracking-[0.08em] text-ink-muted">完整切片原文</p>}
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkCitationMarks]}
                            components={{
                              ...lectureMdComponents,
                              img: ({ src, alt }) => src ? <img src={secureImageSrc(src)} alt={alt || '切片图片'} className="my-3 block max-w-full rounded-lg border border-hairline" loading="lazy" /> : null,
                            }}
                          >
                            {markdownContent}
                          </ReactMarkdown>
                        </section>
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
