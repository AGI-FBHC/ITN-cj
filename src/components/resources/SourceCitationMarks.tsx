import { ExternalLink } from 'lucide-react';
import type { LearningResource } from '@/lib/api';
import { cn } from '@/lib/utils';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function citationNumbers(value: unknown): number[] {
  return Array.isArray(value)
    ? [...new Set(value.map(Number).filter((item) => Number.isFinite(item) && item > 0))]
    : [];
}

function sourceAnchorId(resourceId: string, sourceId: string | number) {
  return `resource-${resourceId}-source-${String(sourceId).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

/**
 * Render resource-owned citations at the exact content block that declared them.
 * Unknown ids are intentionally omitted: showing an unresolvable badge implies
 * evidence exists when the stored resource has no matching source.
 */
export default function SourceCitationMarks({
  citations,
  resource,
  className,
  compact = false,
}: {
  citations: unknown;
  resource: LearningResource;
  className?: string;
  compact?: boolean;
}) {
  const sourceById = new Map<number, Record<string, unknown>>();
  resource.sources.forEach((raw, index) => {
    const source = asRecord(raw);
    const id = Number(source.id ?? index + 1);
    if (Number.isFinite(id)) sourceById.set(id, source);
  });
  const matched = citationNumbers(citations)
    .map((id) => ({ id, source: sourceById.get(id) }))
    .filter((item): item is { id: number; source: Record<string, unknown> } => Boolean(item.source));
  if (!matched.length) return null;

  return (
    <span className={cn('ml-1 inline-flex flex-wrap items-center gap-1 align-baseline', className)} aria-label="本段引用来源">
      {matched.map(({ id, source }) => {
        const title = String(source.document ?? source.title ?? `来源 ${id}`);
        const url = typeof source.url === 'string' ? source.url : null;
        const style = cn(
          'inline-flex items-center gap-1 rounded-md border border-brand/35 bg-brand-tint/55 font-mono font-medium text-brand transition-colors hover:border-brand hover:bg-brand-tint',
          compact ? 'px-1.5 py-px text-[10px] leading-4' : 'px-2 py-0.5 text-[10.5px] leading-[18px]',
        );
        const label = <><span>[{id}]</span>{!compact && <span className="max-w-[180px] truncate font-sans font-normal">{title}</span>}{url && <ExternalLink size={9} />}</>;
        return url ? (
          <a key={id} href={url} target="_blank" rel="noreferrer" title={`来源 [${id}]：${title}`} className={style}>{label}</a>
        ) : (
          <a key={id} href={`#${sourceAnchorId(resource.id, id)}`} title={`来源 [${id}]：${title}`} className={style}>{label}</a>
        );
      })}
    </span>
  );
}
