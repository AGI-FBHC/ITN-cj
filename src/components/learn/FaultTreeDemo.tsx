/**
 * FaultTreeDemo — 故障树排查交互演示（课件 demo block）
 * 顶事件 → 三个第一层分支 → 叶子节点；点叶子看检查方法 + 现场读数，
 * 用读数证据定位根因（编码器电池失效），其余叶子自动标注「已排除」。
 */
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, RotateCcw, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import TraceBadge from '@/components/TraceBadge';
import { cn } from '@/lib/utils';

type LeafId = 'battery' | 'cable' | 'reducer' | 'brake' | 'zero';
type BranchId = 'electrical' | 'mechanical' | 'parameter';

const BRANCHES: { id: BranchId; label: string; leaves: LeafId[] }[] = [
  { id: 'electrical', label: '电气类', leaves: ['battery', 'cable'] },
  { id: 'mechanical', label: '机械类', leaves: ['reducer', 'brake'] },
  { id: 'parameter', label: '参数类', leaves: ['zero'] },
];

const LEAVES: Record<LeafId, { label: string; reading: string; isRoot?: boolean }> = {
  battery: { label: '编码器电池失效', reading: '测量电池电压：2.9V < 3.0V 阈值 ✗', isRoot: true },
  cable: { label: '编码器线缆断线', reading: '万用表测通断：导通正常，无断路 ✓' },
  reducer: { label: '减速器卡死', reading: '手动盘车：可正常转动，无卡滞 ✓' },
  brake: { label: '抱闸未打开', reading: '抱闸线圈电压：24V 正常，已释放 ✓' },
  zero: { label: '零点数据丢失', reading: '零点数据比对：与备份一致，无丢失 ✓' },
};

export default function FaultTreeDemo({ tourStep = null }: { tourStep?: number | null }) {
  const [expanded, setExpanded] = useState<Set<BranchId>>(new Set());
  const [selectedLeaf, setSelectedLeaf] = useState<LeafId | null>(null);
  const [rootFound, setRootFound] = useState(false);
  const touring = tourStep !== null;

  /* 导览：0=高亮顶事件；1=展开三分支并高亮；2=展开电气支路并高亮；3=定位编码器电池，标红根因 */
  useEffect(() => {
    if (tourStep === null) return;
    if (tourStep === 0) {
      setExpanded(new Set());
      setSelectedLeaf(null);
      setRootFound(false);
    } else if (tourStep === 1) {
      setExpanded(new Set());
    } else if (tourStep === 2) {
      setExpanded(new Set(['electrical']));
    } else if (tourStep === 3) {
      setExpanded(new Set(['electrical']));
      setSelectedLeaf('battery');
      setRootFound(true);
    }
  }, [tourStep]);

  const reset = () => {
    setExpanded(new Set());
    setSelectedLeaf(null);
    setRootFound(false);
  };

  const toggleBranch = (id: BranchId) => {
    if (touring) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectLeaf = (id: LeafId) => {
    if (touring) return;
    setSelectedLeaf(id);
    if (LEAVES[id].isRoot) setRootFound(true);
  };

  const detail = selectedLeaf ? LEAVES[selectedLeaf] : null;

  return (
    <div className="rounded-[12px] border border-brand/25 bg-paper p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10.5px] tracking-wide text-ink-muted">
          INTERACTIVE · 点分支展开，点叶子看读数，找到根因
        </span>
        <span className="flex items-center gap-2">
          <TraceBadge kbId="KB-020" />
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1 rounded-md border border-hairline bg-card-warm px-2 py-1 text-[11px] text-ink-muted hover:text-ink"
          >
            <RotateCcw size={11} /> 重新排查
          </button>
        </span>
      </div>

      <div className="flex flex-col items-center gap-0">
        {/* 顶事件 */}
        <div
          className={cn(
            'w-full max-w-[300px] rounded-[10px] border px-4 py-2.5 text-center text-[13px] font-semibold transition-colors',
            tourStep === 0 ? 'border-brand-amber bg-brand-amber-tint text-ochre' : 'border-brand/40 bg-brand-tint text-brand',
          )}
        >
          <div className="flex items-center justify-center gap-1.5">
            <AlertTriangle size={14} /> J3 轴不动 · 报警 SRVO-062
          </div>
        </div>
        <div className="h-3 w-px bg-hairline" />
      </div>

      {/* 第一层分支 */}
      <div className="grid grid-cols-1 gap-2 border-t border-hairline pt-3 sm:grid-cols-3">
        {BRANCHES.map((b) => {
          const isExpanded = expanded.has(b.id);
          const branchToured = tourStep === 1 || (tourStep === 2 && b.id === 'electrical');
          return (
            <div key={b.id} className="flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={() => toggleBranch(b.id)}
                disabled={touring}
                className={cn(
                  'w-full rounded-[10px] border px-3 py-2 text-[12.5px] font-medium transition-colors disabled:cursor-default',
                  branchToured && 'border-brand-amber bg-brand-amber-tint text-ochre',
                  !branchToured && isExpanded && 'border-brand bg-brand-tint text-brand',
                  !branchToured && !isExpanded && 'border-hairline bg-card-warm text-ink-2 hover:border-brand/40',
                )}
              >
                <span className="flex items-center justify-center gap-1">
                  {b.label}
                  {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </span>
              </button>

              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="flex w-full flex-col gap-1.5 overflow-hidden border-t border-hairline pt-2"
                  >
                    {b.leaves.map((leafId) => {
                      const leaf = LEAVES[leafId];
                      const isSelected = selectedLeaf === leafId;
                      const isRootHit = rootFound && leaf.isRoot;
                      const excluded = rootFound && !leaf.isRoot;
                      return (
                        <button
                          key={leafId}
                          type="button"
                          onClick={() => selectLeaf(leafId)}
                          disabled={touring}
                          className={cn(
                            'rounded-md border px-2 py-1.5 text-left text-[11.5px] transition-colors disabled:cursor-default',
                            isRootHit && 'border-brand-danger bg-brand-danger text-paper font-semibold',
                            excluded && 'border-hairline bg-paper-deep text-ink-muted opacity-60',
                            !rootFound && isSelected && 'border-brand bg-brand-tint text-brand',
                            !rootFound && !isSelected && 'border-hairline bg-paper text-ink-2 hover:border-brand/40',
                          )}
                        >
                          {leaf.label}
                          {isRootHit && <span className="ml-1.5 text-[10px]">· 根因命中</span>}
                          {excluded && <span className="ml-1.5 text-[10px]">· 已排除</span>}
                        </button>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {/* 检查详情 */}
      <AnimatePresence mode="wait">
        {detail && (
          <motion.div
            key={selectedLeaf}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={cn(
              'mt-3 rounded-md border p-3 text-[12px]',
              detail.isRoot ? 'border-brand-danger/40 bg-brand-danger/10 text-brand-danger' : 'border-brand/30 bg-brand-tint/60 text-ink-2',
            )}
          >
            <div className="flex items-center gap-1.5 font-medium">
              {detail.isRoot ? <AlertTriangle size={13} /> : <Check size={13} />}
              {detail.label}
            </div>
            <div className="mt-1 font-mono text-[11px]">{detail.reading}</div>
            {detail.isRoot && <div className="mt-1 text-[11.5px] font-semibold">根因命中</div>}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {rootFound && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mt-2.5 flex items-center gap-1.5 rounded-md border border-brand/40 bg-brand-tint px-2.5 py-1.5 text-[12px] font-medium text-brand"
          >
            <Check size={13} />
            排故三步：读懂报警 → 沿故障树分层排查 → 用读数证据定位根因，再动手更换。
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
