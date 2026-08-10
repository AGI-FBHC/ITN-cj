/**
 * 领域知识库 `/knowledge`（knowledge.md）
 * S1 页头 + 统计带（count-up）
 * S2 国标精选带（seal-standard.svg 印章水印，点击过滤）
 * S3 sticky 检索过滤工具条（搜索高亮 / 类型 chips / 知识点多选 / 可信度 slider / 排序 / 视图切换）
 * S4 网格 / 表格双视图切片列表
 * S5 详情抽屉（溯源链 back-links）
 * S6 底部承诺条
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  LayoutGrid,
  Table2,
  X,
  SearchX,
  ChevronDown,
  Landmark,
  FileText,
  BookOpen,
  Newspaper,
  FlaskConical,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { kbSlices, getKBSlice } from '@/data/kbSlices';
import type { KBSlice, KBType } from '@/data/kbSlices';
import { knowledgePoints, getKnowledgePoint } from '@/data/knowledgePoints';
import { globalStats } from '@/data/metrics';
import CountUp from '@/components/knowledge/CountUp';
import StandardShowcase from '@/components/knowledge/StandardShowcase';
import KBDetailDrawer from '@/components/knowledge/KBDetailDrawer';
import { kbTypeColor, referencingResources } from '@/components/knowledge/kb-utils';
import { cn } from '@/lib/utils';

/**
 * 真实被引次数：遍历 resources.kbRefs 计数，替代 kbSlices 里写死的 mock citedCount 字段
 * （两者若不一致，页面展示统一以这里为准，避免自相矛盾）
 */
const citedCountOf = (kbId: string) => referencingResources(kbId).length;

const typeIcon: Record<KBType, typeof Landmark> = {
  国标: Landmark,
  行标: FileText,
  教材: BookOpen,
  企业案例: Newspaper,
  论文: FlaskConical,
};
const allTypes = Object.keys(typeIcon) as KBType[];

type SortKey = 'cited' | 'year' | 'cred';

/** 关键词高亮 */
function highlight(text: string, q: string): ReactNode {
  if (!q.trim()) return text;
  const idx = text.toLowerCase().indexOf(q.trim().toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-[3px] bg-brand-amber-tint px-0.5 text-ochre">
        {text.slice(idx, idx + q.trim().length)}
      </mark>
      {highlight(text.slice(idx + q.trim().length), q)}
    </>
  );
}

function TypeBadge({ type, className }: { type: KBType; className?: string }) {
  const tone = kbTypeColor[type];
  const Icon = typeIcon[type];
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[11px] font-medium', className)}
      style={{ color: tone, borderColor: `${tone}55`, backgroundColor: `${tone}0D` }}
    >
      <Icon size={11} /> {type}
    </span>
  );
}

export default function Knowledge() {
  const [query, setQuery] = useState('');
  const [types, setTypes] = useState<KBType[]>([]);
  const [kps, setKps] = useState<string[]>([]);
  const [minCred, setMinCred] = useState(0.8);
  const [sort, setSort] = useState<SortKey>('cited');
  const [view, setView] = useState<'grid' | 'table'>('grid');
  const [standard, setStandard] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const openDetail = (id: string) => {
    setDetailId(id);
    setDrawerOpen(true);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = kbSlices.filter((s) => {
      if (standard && s.standardNo !== standard) return false;
      if (types.length && !types.includes(s.type)) return false;
      if (kps.length && !kps.includes(s.kpId)) return false;
      if (s.credibility < minCred) return false;
      if (q) {
        const hay = `${s.id} ${s.title} ${s.standardNo ?? ''} ${s.source} ${s.summary}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    list = [...list].sort((a, b) =>
      sort === 'cited' ? citedCountOf(b.id) - citedCountOf(a.id) : sort === 'year' ? b.year - a.year : b.credibility - a.credibility,
    );
    return list;
  }, [query, types, kps, minCred, sort, standard]);

  const toggleType = (t: KBType) =>
    setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  const toggleKp = (id: string) =>
    setKps((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const hasFilter = Boolean(query.trim()) || types.length > 0 || kps.length > 0 || minCred > 0.8 || standard;
  const clearAll = () => {
    setQuery('');
    setTypes([]);
    setKps([]);
    setMinCred(0.8);
    setStandard(null);
  };

  return (
    <div className="mx-auto max-w-[1320px] px-8 py-10">
      {/* ---------- S1 页头 ---------- */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="lf-mono-label flex items-center gap-2">
          <span className="inline-block h-px w-6 bg-brand/40" />
          KNOWLEDGE BASE · 工业机器人运维
        </div>
        <h1 className="mt-2 font-serif text-[36px] font-bold leading-[44px] text-ink">领域知识库</h1>
        <p className="mt-2 max-w-[680px] text-[14.5px] leading-[24px] text-ink-muted">
          每一条生成内容的背后，都是一条可核验的切片。无溯源，不生成。
        </p>
      </motion.div>

      {/* ---------- S1 统计带 ---------- */}
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { en: 'KB SLICES', name: '知识切片', value: globalStats.kbSlicesTotal, decimals: 0, suffix: '' },
          { en: 'STANDARDS', name: '收录标准', value: 47, decimals: 0, suffix: '' },
          { en: 'AVG CREDIBILITY', name: '平均可信度', value: 96.2, decimals: 1, suffix: '%' },
          { en: 'UPDATED THIS WEEK', name: '本周更新', value: 12, decimals: 0, suffix: '' },
        ].map((s, i) => (
          <motion.div
            key={s.en}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 * i, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="lf-card p-4"
          >
            <div className="lf-mono-label !text-[10px]">{s.en}</div>
            <CountUp
              to={s.value}
              decimals={s.decimals}
              suffix={s.suffix}
              className="mt-1.5 block font-display text-[30px] font-semibold leading-none text-ink tabular"
            />
            <div className="mt-1.5 text-[12.5px] text-ink-muted">{s.name}</div>
          </motion.div>
        ))}
      </div>

      {/* ---------- S2 国标精选带 ---------- */}
      <div className="mt-8">
        <StandardShowcase
          activeStandard={standard}
          onFilter={(std) => setStandard((v) => (v === std ? null : std))}
          onPreview={openDetail}
        />
      </div>

      {/* ---------- S3 检索过滤工具条 ---------- */}
      <div className="sticky top-[72px] z-30 mt-8 rounded-[14px] border border-hairline bg-paper/90 p-3.5 shadow-xs backdrop-blur">
        <div className="flex flex-wrap items-center gap-2.5">
          {/* 搜索 */}
          <div className="relative min-w-[220px] flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='检索标题 / 标准号 / 关键词，如"重复定位精度"'
              className="h-10 w-full rounded-[10px] border border-hairline bg-card-warm pl-9 pr-8 text-[13.5px] text-ink outline-none transition-colors placeholder:text-ink-muted/70 focus:border-brand/50"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink"
                aria-label="清除搜索"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* 排序 */}
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="h-10 w-[136px] border-hairline bg-card-warm text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-hairline bg-card-warm">
              <SelectItem value="cited">被引次数 ↓</SelectItem>
              <SelectItem value="year">更新时间</SelectItem>
              <SelectItem value="cred">可信度</SelectItem>
            </SelectContent>
          </Select>

          {/* 视图切换 */}
          <div className="flex rounded-[10px] border border-hairline bg-card-warm p-0.5">
            {(
              [
                { v: 'grid', icon: LayoutGrid, label: '网格' },
                { v: 'table', icon: Table2, label: '表格' },
              ] as const
            ).map((o) => (
              <button
                key={o.v}
                type="button"
                onClick={() => setView(o.v)}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors',
                  view === o.v ? 'bg-brand text-paper' : 'text-ink-muted hover:text-ink',
                )}
              >
                <o.icon size={13} /> {o.label}
              </button>
            ))}
          </div>

          <span className="font-mono text-[12px] text-ink-muted tabular">共 {filtered.length} 条</span>
        </div>

        {/* 过滤器组 */}
        <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-hairline/70 pt-2.5">
          <span className="lf-mono-label !text-[10px]">类型</span>
          {allTypes.map((t) => {
            const on = types.includes(t);
            const tone = kbTypeColor[t];
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleType(t)}
                className={cn('rounded-lg border px-2.5 py-1 text-[12px] font-medium transition-all duration-150')}
                style={{
                  color: on ? '#F7F5EE' : tone,
                  borderColor: `${tone}55`,
                  backgroundColor: on ? tone : `${tone}0D`,
                }}
              >
                {t}
              </button>
            );
          })}

          <span className="lf-mono-label ml-2 !text-[10px]">知识点</span>
          <Popover>
            <PopoverTrigger className="flex items-center gap-1.5 rounded-lg border border-hairline bg-card-warm px-2.5 py-1 text-[12px] font-medium text-ink-2 transition-colors hover:border-brand/40">
              {kps.length ? `已选 ${kps.length} 个` : '全部知识点'}
              <ChevronDown size={12} className="text-ink-muted" />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[200px] border-hairline bg-card-warm p-2">
              {knowledgePoints.map((kp) => (
                <label
                  key={kp.id}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] text-ink-2 hover:bg-paper-deep"
                >
                  <Checkbox
                    checked={kps.includes(kp.id)}
                    onCheckedChange={() => toggleKp(kp.id)}
                  />
                  {kp.name}
                </label>
              ))}
            </PopoverContent>
          </Popover>

          <span className="lf-mono-label ml-2 !text-[10px]">可信度 ≥</span>
          <div className="flex w-[140px] items-center gap-2">
            <Slider
              value={[minCred]}
              min={0.8}
              max={1}
              step={0.01}
              onValueChange={(v) => setMinCred(v[0])}
              className="flex-1"
            />
            <span className="w-8 font-mono text-[11.5px] text-brand tabular">{minCred.toFixed(2)}</span>
          </div>

          {standard && (
            <button
              type="button"
              onClick={() => setStandard(null)}
              className="flex items-center gap-1.5 rounded-lg border border-brand-danger/40 bg-brand-danger/5 px-2.5 py-1 font-mono text-[11.5px] font-medium text-brand-danger transition-colors hover:bg-brand-danger/10"
            >
              {standard} <X size={12} />
            </button>
          )}
          {hasFilter && (
            <button
              type="button"
              onClick={clearAll}
              className="ml-auto text-[12px] font-medium text-ink-muted underline-offset-2 hover:text-brand hover:underline"
            >
              清除全部过滤
            </button>
          )}
        </div>
      </div>

      {/* ---------- S4 切片列表 ---------- */}
      <div className="mt-6 min-h-[300px]">
        <AnimatePresence mode="wait">
          {filtered.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center rounded-[14px] border border-dashed border-hairline py-20 text-center"
            >
              <SearchX size={36} strokeWidth={1.5} className="text-ink-muted" />
              <p className="mt-3 text-[15px] font-medium text-ink">未命中切片 · 换个关键词试试</p>
              <p className="mt-1 font-mono text-[11.5px] text-ink-muted">
                当前过滤结果 0 条 · 可清除过滤或降低可信度阈值
              </p>
              <button type="button" onClick={clearAll} className="lf-btn-ghost mt-4 !px-4 !py-2 text-[13px]">
                清除全部过滤
              </button>
            </motion.div>
          ) : view === 'grid' ? (
            <motion.div
              key="grid"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
            >
              {filtered.map((s, i) => (
                <SliceCard
                  key={s.id}
                  slice={s}
                  index={i}
                  query={query}
                  onOpen={() => openDetail(s.id)}
                  onFilterKp={(kpId) => setKps((p) => (p.includes(kpId) ? p : [...p, kpId]))}
                />
              ))}
            </motion.div>
          ) : (
            <motion.div
              key="table"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="overflow-hidden rounded-[14px] border border-hairline bg-card-warm"
            >
              <Table>
                <TableHeader>
                  <TableRow className="border-hairline bg-paper-deep/60 hover:bg-paper-deep/60">
                    <TableHead className="w-[90px] font-mono text-[11px]">KB 编号</TableHead>
                    <TableHead className="w-[86px]">类型</TableHead>
                    <TableHead>标题</TableHead>
                    <TableHead className="w-[180px]">来源 / 标准号</TableHead>
                    <TableHead className="w-[110px]">知识点</TableHead>
                    <TableHead className="w-[90px] text-right">可信度</TableHead>
                    <TableHead className="w-[80px] text-right">被引</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((s) => (
                    <TableRow
                      key={s.id}
                      onClick={() => openDetail(s.id)}
                      className="cursor-pointer border-hairline transition-colors hover:bg-brand-tint/40"
                    >
                      <TableCell className="font-mono text-[12px] font-medium text-brand">
                        {s.id}
                      </TableCell>
                      <TableCell>
                        <TypeBadge type={s.type} />
                      </TableCell>
                      <TableCell className="max-w-[320px]">
                        <span className="line-clamp-1 text-[13px] font-medium text-ink">
                          {highlight(s.title, query)}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-ink-muted">
                        {s.standardNo ?? s.source.slice(0, 14)}
                      </TableCell>
                      <TableCell className="text-[12px] text-ink-2">
                        {getKnowledgePoint(s.kpId).name}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[12px] text-brand tabular">
                        {(s.credibility * 100).toFixed(0)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[12px] text-ochre tabular">
                        {citedCountOf(s.id) > 0 ? citedCountOf(s.id) : (
                          <span className="text-ink-muted" title="暂未被引用 · 检索候选池中">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ---------- S6 底部承诺条 ---------- */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        className="mt-16 text-center"
      >
        <p className="font-serif text-[18px] italic leading-[28px] text-ink-2">
          “知识的每一条来路，都应该被看见。”
        </p>
        <p className="mt-2 font-mono text-[11.5px] tracking-wide text-ink-muted">
          高保真约束生成 · 全程可溯源 · 幻觉率 3.2%
        </p>
      </motion.div>

      {/* ---------- S5 详情抽屉 ---------- */}
      <KBDetailDrawer
        slice={detailId ? getKBSlice(detailId) ?? null : null}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onFilterKp={(kpId) => setKps([kpId])}
      />
    </div>
  );
}

/** 网格切片卡（S4） */
function SliceCard({
  slice,
  index,
  query,
  onOpen,
  onFilterKp,
}: {
  slice: KBSlice;
  index: number;
  query: string;
  onOpen: () => void;
  onFilterKp: (kpId: string) => void;
}) {
  const kp = getKnowledgePoint(slice.kpId);
  return (
    <motion.button
      type="button"
      layout
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{
        duration: 0.45,
        delay: Math.min(index, 8) * 0.05,
        ease: [0.22, 1, 0.36, 1],
        layout: { duration: 0.3 },
      }}
      onClick={onOpen}
      className="group flex flex-col rounded-[14px] border border-hairline bg-card-warm p-4 text-left transition-all duration-200 ease-lf hover:-translate-y-[3px] hover:border-brand/30 hover:shadow-warm"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[12.5px] font-semibold tracking-wide text-brand transition-colors group-hover:text-brand-hover">
          {slice.id}
        </span>
        <TypeBadge type={slice.type} />
      </div>
      <h4 className="mt-2 line-clamp-2 min-h-[42px] text-[14.5px] font-semibold leading-[21px] text-ink">
        {highlight(slice.title, query)}
      </h4>
      <div className="mt-1 truncate font-mono text-[11px] text-ink-muted">
        {slice.standardNo ?? slice.source}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onFilterKp(slice.kpId);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.stopPropagation();
              onFilterKp(slice.kpId);
            }
          }}
          className="rounded-md border border-hairline bg-paper px-1.5 py-px text-[11px] text-ink-2 transition-colors hover:border-brand/45 hover:text-brand"
        >
          {kp.name}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-hairline/70 pt-2.5">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-paper-deep">
          <div className="h-full rounded-full bg-brand" style={{ width: `${slice.credibility * 100}%` }} />
        </div>
        <span className="font-mono text-[10.5px] text-ink-muted tabular">
          {(slice.credibility * 100).toFixed(0)}
        </span>
        {(() => {
          const refs = referencingResources(slice.id);
          if (refs.length === 0) {
            return (
              <span className="ml-auto font-mono text-[10.5px] text-ink-muted tabular">
                暂未被引用 · 检索候选池中
              </span>
            );
          }
          return (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    onClick={(e) => e.stopPropagation()}
                    className="ml-auto cursor-help font-mono text-[10.5px] text-ochre tabular underline decoration-dotted underline-offset-2"
                  >
                    被引 {refs.length} 次
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] border-hairline bg-card-warm text-ink-2 shadow-warm">
                  <div className="lf-mono-label !text-[9.5px]">被引资源 TOP {Math.min(3, refs.length)}</div>
                  <ul className="mt-1 space-y-1">
                    {refs.slice(0, 3).map((r) => (
                      <li key={`${r.learnerId}-${r.title}`} className="text-[11.5px] leading-[17px]">· {r.title}</li>
                    ))}
                  </ul>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        })()}
        <span className="font-mono text-[10.5px] text-ink-muted tabular">{slice.year}</span>
      </div>
    </motion.button>
  );
}
