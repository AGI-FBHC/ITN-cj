/**
 * KBDrawer — 右侧 Sheet 抽屉：知识切片详情
 * 来源 / 标准号 / 类型 / 可信度 / 被引资源 / 摘要 / 正文节选（design.md §5.2）
 * 全站复用：TraceBadge 点击即打开
 */
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { BookOpen, FileText, Landmark, Newspaper, FlaskConical, Quote, Link2, ShieldCheck } from 'lucide-react';
import type { KBType } from '@/data/kbSlices';
import { getKBSlice } from '@/data/kbSlices';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import { getLearner } from '@/data/learners';
import { referencingResources, resourceFormLabel } from '@/components/knowledge/kb-utils';

const typeIcon: Record<KBType, typeof Landmark> = {
  国标: Landmark,
  行标: FileText,
  教材: BookOpen,
  企业案例: Newspaper,
  论文: FlaskConical,
};

const typeTone: Record<KBType, string> = {
  国标: '#B0483B',
  行标: '#B77552',
  教材: '#4E7860',
  企业案例: '#5A6553',
  论文: '#66725E',
};

export default function KBDrawer({
  sliceId,
  open,
  onOpenChange,
}: {
  sliceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const slice = sliceId ? getKBSlice(sliceId) : undefined;
  const TypeIcon = slice ? typeIcon[slice.type] : FileText;
  const tone = slice ? typeTone[slice.type] : '#66725E';
  const kp = slice ? getKnowledgePoint(slice.kpId) : undefined;
  /* 被引口径统一：与知识库页一致，用 resources.ts 真实反向索引（kbSlices.citedCount 为 mock，弃用） */
  const cited = slice ? referencingResources(slice.id) : [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[420px] max-w-[92vw] border-l border-hairline bg-paper p-0 sm:max-w-[420px]"
      >
        {slice && (
          <ScrollArea className="h-full">
            <div className="p-6">
              <SheetHeader className="text-left">
                <div className="mb-3 flex items-center gap-2">
                  <span
                    className="flex h-9 w-9 items-center justify-center rounded-lg border"
                    style={{ backgroundColor: `${tone}12`, borderColor: `${tone}40` }}
                  >
                    <TypeIcon size={17} strokeWidth={1.75} style={{ color: tone }} />
                  </span>
                  <Badge
                    variant="outline"
                    className="rounded-md border font-mono text-[11px]"
                    style={{ color: tone, borderColor: `${tone}55`, backgroundColor: `${tone}0D` }}
                  >
                    {slice.type}
                  </Badge>
                  {slice.type === '国标' && (
                    <img src="/seal-standard.svg" alt="权威标准" className="h-8 w-8" />
                  )}
                </div>
                <div className="font-mono text-[13px] font-medium tracking-wide text-brand">{slice.id}</div>
                <SheetTitle className="font-serif text-[19px] leading-[26px] text-ink">
                  {slice.title}
                </SheetTitle>
                <SheetDescription className="sr-only">知识切片详情</SheetDescription>
              </SheetHeader>

              <div className="mt-5 space-y-4">
                <div className="rounded-[10px] border border-hairline bg-card-warm p-4">
                  <div className="lf-mono-label mb-2">SOURCE · 来源</div>
                  <div className="text-[14px] leading-[22px] text-ink-2">{slice.source}</div>
                  {slice.standardNo && (
                    <div className="mt-2 inline-flex items-center gap-2 rounded-md bg-brand-tint px-2 py-1 font-mono text-[13px] font-medium text-brand">
                      <ShieldCheck size={13} strokeWidth={1.75} />
                      {slice.standardNo}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-[10px] border border-hairline bg-card-warm p-3">
                    <div className="lf-mono-label mb-1 text-[10px]">可信度</div>
                    <div className="font-display text-[20px] font-semibold text-brand tabular">
                      {(slice.credibility * 100).toFixed(0)}
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-paper-deep">
                      <div
                        className="h-full rounded-full bg-brand"
                        style={{ width: `${slice.credibility * 100}%` }}
                      />
                    </div>
                  </div>
                  <div className="rounded-[10px] border border-hairline bg-card-warm p-3">
                    <div className="lf-mono-label mb-1 text-[10px]">被引次数</div>
                    <div className="font-display text-[20px] font-semibold text-ochre tabular">
                      {cited.length}
                    </div>
                    <div className="mt-1 text-[11px] text-ink-muted">次资源引用</div>
                  </div>
                  <div className="rounded-[10px] border border-hairline bg-card-warm p-3">
                    <div className="lf-mono-label mb-1 text-[10px]">年份</div>
                    <div className="font-display text-[20px] font-semibold text-ink tabular">{slice.year}</div>
                    <div className="mt-1 text-[11px] text-ink-muted">发布/归档</div>
                  </div>
                </div>

                <div>
                  <div className="lf-mono-label mb-2">KNOWLEDGE POINT · 所属知识点</div>
                  <span className="lf-chip">{kp?.name}</span>
                </div>

                <Separator className="bg-hairline" />

                <div>
                  <div className="lf-mono-label mb-2 flex items-center gap-1.5">
                    <FileText size={12} /> SUMMARY · 摘要
                  </div>
                  <p className="text-[14px] leading-[23px] text-ink-2">{slice.summary}</p>
                </div>

                <div className="rounded-[10px] border border-brand/20 bg-brand-tint/50 p-4">
                  <div className="lf-mono-label mb-2 flex items-center gap-1.5 !text-brand">
                    <Quote size={12} /> EXCERPT · 正文节选
                  </div>
                  <p className="text-[14px] leading-[24px] text-ink-2">{slice.excerpt}</p>
                </div>

                <div>
                  <div className="lf-mono-label mb-2 flex items-center gap-1.5">
                    <Link2 size={12} /> CITED BY · 被引资源
                  </div>
                  {cited.length > 0 ? (
                    <ul className="space-y-2">
                      {cited.map((r) => (
                        <li
                          key={`${r.learnerId}-${r.form}`}
                          className="flex items-center gap-2 rounded-lg border border-hairline bg-card-warm px-3 py-2 text-[13px] text-ink-2"
                        >
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-amber" />
                          <span className="min-w-0 flex-1 truncate">{r.title}</span>
                          <span className="shrink-0 rounded-md border border-hairline bg-paper px-1.5 py-px font-mono text-[10px] text-ink-muted">
                            {resourceFormLabel[r.form]} · {getLearner(r.learnerId).name}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="rounded-lg border border-dashed border-hairline px-3 py-2 text-[12.5px] text-ink-muted">
                      暂未被引用 · 检索候选池中
                    </p>
                  )}
                </div>

                <div className="rounded-[10px] bg-paper-deep p-3 font-mono text-[11px] leading-[18px] text-ink-muted">
                  TRACE CHAIN · 该切片由 RET-02 于知识库 2,356 条切片中命中，经 VER-04 交叉验证后进入生成链路。
                </div>
              </div>
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}
