/**
 * KBDetailDrawer — 切片详情抽屉（knowledge.md S5）
 * 复用 scaffold KBDrawer 的结构与视觉（Sheet 右侧滑入），并在此基础上：
 *  · 溯源链卡条目可点击 → 深链跳转到引用该切片的页面/形态
 *  · 关联知识点 chips → 点击回填列表过滤
 *  · 底部 CTA「引用此切片生成内容」
 * （共享 KBDrawer 不允许修改，故此增强版放在 knowledge 页面域内；
 *   TraceBadge 全局点击仍使用共享 KBDrawer。）
 */
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  BookOpen,
  FileText,
  Landmark,
  Newspaper,
  FlaskConical,
  ListChecks,
  Quote,
  Link2,
  ArrowUpRight,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import type { KBSlice, KBType } from '@/data/kbSlices';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import { getLearner } from '@/data/learners';
import type { ResourceForm } from '@/data/resources';
import { useProfile } from '@/context/ProfileContext';
import { kbTypeColor, resourceHref, referencingResources, resourceFormLabel } from './kb-utils';
import { cn } from '@/lib/utils';

const typeIcon: Record<KBType, typeof Landmark> = {
  国标: Landmark,
  行标: FileText,
  教材: BookOpen,
  企业案例: Newspaper,
  论文: FlaskConical,
};

const resourceFormIcon: Record<ResourceForm, typeof BookOpen> = {
  lecture: BookOpen,
  guide: FileText,
  quiz: ListChecks,
};

export default function KBDetailDrawer({
  slice,
  open,
  onOpenChange,
  onFilterKp,
}: {
  slice: KBSlice | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFilterKp: (kpId: string) => void;
}) {
  const navigate = useNavigate();
  const { currentLearnerId, setCurrentLearnerId } = useProfile();
  if (!slice) return null;
  const TypeIcon = typeIcon[slice.type];
  const tone = kbTypeColor[slice.type];
  const kp = getKnowledgePoint(slice.kpId);
  /* 真实被引资源：遍历 resources.kbRefs，取代 slice.citedCount 这个可能过期的 mock 数字 */
  const citedBy = referencingResources(slice.id);

  const goToResource = (r: (typeof citedBy)[number]) => {
    if (r.learnerId !== currentLearnerId) {
      setCurrentLearnerId(r.learnerId);
      toast.success(`已切换画像至 ${getLearner(r.learnerId).name}`);
    }
    onOpenChange(false);
    navigate(`/resources?tab=${r.form}`);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[480px] max-w-[94vw] border-l border-hairline bg-paper p-0 sm:max-w-[480px]"
      >
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
                <span
                  className="rounded-md border px-1.5 py-0.5 font-mono text-[11px]"
                  style={{ color: tone, borderColor: `${tone}55`, backgroundColor: `${tone}0D` }}
                >
                  {slice.type}
                </span>
                {slice.type === '国标' && (
                  <span className="flex items-center gap-1.5 rounded-md border border-brand-danger/30 bg-brand-danger/5 px-1.5 py-0.5 text-[11px] font-medium text-brand-danger">
                    <img src="/seal-standard.svg" alt="" className="h-4 w-4" />
                    权威标准
                  </span>
                )}
              </div>
              <div className="font-mono text-[13px] font-medium tracking-wide text-brand">
                {slice.id}
              </div>
              <SheetTitle className="font-serif text-[20px] leading-[28px] text-ink">
                {slice.title}
              </SheetTitle>
              <SheetDescription className="sr-only">知识切片详情</SheetDescription>
            </SheetHeader>

            <div className="mt-5 space-y-4">
              {/* 元信息网格 */}
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35 }}
                className="grid grid-cols-2 gap-2.5"
              >
                {[
                  { label: '来源 SOURCE', value: slice.source },
                  { label: '标准号 STD NO.', value: slice.standardNo ?? '—' },
                  { label: '类型 TYPE', value: slice.type },
                  { label: '年份 YEAR', value: String(slice.year) },
                  { label: '被引 CITED', value: `${citedBy.length} 次` },
                  { label: '知识点 KP', value: kp.name },
                ].map((m) => (
                  <div key={m.label} className="rounded-[10px] border border-hairline bg-card-warm p-3">
                    <div className="lf-mono-label !text-[9.5px]">{m.label}</div>
                    <div className="mt-1 truncate text-[13px] font-medium text-ink-2" title={m.value}>
                      {m.value}
                    </div>
                  </div>
                ))}
              </motion.div>

              {/* 可信度 */}
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.06, duration: 0.35 }}
                className="rounded-[10px] border border-hairline bg-card-warm p-3.5"
              >
                <div className="flex items-center justify-between">
                  <span className="lf-mono-label !text-[10px]">CREDIBILITY · 可信度</span>
                  <span className="font-display text-[20px] font-semibold text-brand tabular">
                    {(slice.credibility * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-paper-deep">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${slice.credibility * 100}%` }}
                    transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                    className="h-full rounded-full bg-brand"
                  />
                </div>
                <p className="mt-2 text-[12px] leading-[19px] text-ink-muted">{slice.summary}</p>
              </motion.div>

              {/* 正文节选 */}
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.12, duration: 0.35 }}
                className="rounded-[10px] border border-brand/20 bg-brand-tint/50 p-4"
              >
                <div className="lf-mono-label mb-2 flex items-center gap-1.5 !text-brand">
                  <Quote size={12} /> EXCERPT · 正文节选
                </div>
                <p className="text-[13px] leading-[22px] text-ink-2">{slice.excerpt}</p>
              </motion.div>

              {/* 溯源链卡（灵魂）：可点击 back-links */}
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.18, duration: 0.35 }}
                className="rounded-[10px] border border-brand/25 bg-brand-tint/40 p-4"
              >
                <div className="lf-mono-label mb-1 flex items-center gap-1.5 !text-brand">
                  <Link2 size={12} /> TRACE CHAIN · 溯源链
                </div>
                <p className="text-[12px] text-ink-muted">这条切片支撑了以下内容 →</p>
                <ul className="mt-2.5 space-y-2">
                  {slice.relatedResources.map((r, i) => (
                    <motion.li
                      key={r}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.22 + i * 0.06 }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onOpenChange(false);
                          navigate(resourceHref(r));
                        }}
                        className="group flex w-full items-center gap-2.5 rounded-lg border border-hairline bg-card-warm px-3 py-2.5 text-left transition-all duration-200 hover:border-brand/45 hover:shadow-warm"
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-amber" />
                        <span className="flex-1 text-[13px] font-medium text-ink-2">{r}</span>
                        <ArrowUpRight
                          size={14}
                          className="shrink-0 text-brand transition-transform duration-200 group-hover:translate-x-[3px]"
                        />
                      </button>
                    </motion.li>
                  ))}
                </ul>
                <p className="mt-2.5 font-mono text-[10px] leading-[16px] text-ink-muted">
                  点击条目跳转到引用该切片的资源 / 协同记录
                </p>
              </motion.div>

              {/* 被引资源（反向溯源，真实计数）：遍历 resources.kbRefs 得到，与上方 TRACE CHAIN 的
                  示意条目不同，这里每条都对应一个真实学习者 + 真实生成资源 */}
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.22, duration: 0.35 }}
                className="rounded-[10px] border border-hairline bg-card-warm p-4"
              >
                <div className="lf-mono-label mb-1 flex items-center gap-1.5">
                  <Link2 size={12} /> CITED BY · 被引资源
                </div>
                {citedBy.length === 0 ? (
                  <p className="mt-2 text-[12.5px] leading-[19px] text-ink-muted">
                    暂未被引用 · 检索候选池中
                  </p>
                ) : (
                  <>
                    <p className="text-[12px] text-ink-muted">
                      以下学习者的生成资源真实引用了这条切片 →
                    </p>
                    <ul className="mt-2.5 space-y-2">
                      {citedBy.map((r, i) => {
                        const FormIcon = resourceFormIcon[r.form];
                        return (
                          <motion.li
                            key={`${r.learnerId}-${r.title}`}
                            initial={{ opacity: 0, x: -8 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: 0.26 + i * 0.06 }}
                          >
                            <button
                              type="button"
                              onClick={() => goToResource(r)}
                              className="group flex w-full items-center gap-2.5 rounded-lg border border-hairline bg-paper px-3 py-2.5 text-left transition-all duration-200 hover:border-brand/45 hover:shadow-warm"
                            >
                              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-brand/30 bg-brand-tint text-brand">
                                <FormIcon size={12} />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] font-medium text-ink-2">{r.title}</span>
                                <span className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-muted">
                                  {resourceFormLabel[r.form]} · {getLearner(r.learnerId).name}
                                </span>
                              </span>
                              <ArrowUpRight
                                size={14}
                                className="shrink-0 text-brand transition-transform duration-200 group-hover:translate-x-[3px]"
                              />
                            </button>
                          </motion.li>
                        );
                      })}
                    </ul>
                    <p className="mt-2.5 font-mono text-[10px] leading-[16px] text-ink-muted">
                      点击条目将画像切至对应学习者并跳转到该形态资源
                    </p>
                  </>
                )}
              </motion.div>

              {/* 关联知识点 */}
              <div>
                <div className="lf-mono-label mb-2">RELATED · 关联知识点</div>
                <div className="flex flex-wrap gap-2">
                  {[kp.name, ...kp.coreTopics.slice(0, 2)].map((t, i) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => {
                        onFilterKp(slice.kpId);
                        onOpenChange(false);
                      }}
                      className={cn(
                        'lf-chip transition-all duration-200 hover:-translate-y-[1px] hover:border-brand/45 hover:text-brand',
                        i === 0 && 'border-brand/40 bg-brand-tint text-brand',
                      )}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <Separator className="bg-hairline" />

              {/* CTA */}
              <button
                type="button"
                onClick={() =>
                  toast.success('已提交 GEN-03（演示）', {
                    description: `${slice.id} 将进入下一轮约束生成的检索上下文`,
                  })
                }
                className="lf-btn-primary w-full"
              >
                <Sparkles size={15} /> 引用此切片生成内容
              </button>

              <div className="rounded-[10px] bg-paper-deep p-3 font-mono text-[11px] leading-[18px] text-ink-muted">
                TRACE CHAIN · 该切片由 RET-02 于知识库 2,356 条切片中命中，经 VER-04 交叉验证后进入生成链路。
              </div>
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
