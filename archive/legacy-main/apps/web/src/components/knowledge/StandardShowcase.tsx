/**
 * StandardShowcase — 国标精选带（knowledge.md S2）
 * 3 张「权威标准」卡：seal-standard.svg 印章水印 · hover 抬起 ·
 * 点击卡片 → 列表按该标准号过滤；「查看切片 →」→ 打开详情抽屉
 */
import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { getKBSlice } from '@/data/kbSlices';

const showcase: { kbId: string; usage: string }[] = [
  { kbId: 'KB-007', usage: '位姿准确度 / 重复定位精度基准' },
  { kbId: 'KB-005', usage: '安全围栏 / 急停 / 限速强制条款' },
  { kbId: 'KB-012', usage: '风险评估与风险减小方法论' },
];

export default function StandardShowcase({
  activeStandard,
  onFilter,
  onPreview,
}: {
  activeStandard: string | null;
  onFilter: (standardNo: string) => void;
  onPreview: (kbId: string) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {showcase.map((s, i) => {
        const slice = getKBSlice(s.kbId);
        if (!slice) return null;
        const active = activeStandard === slice.standardNo;
        return (
          <motion.button
            key={s.kbId}
            type="button"
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ delay: i * 0.1, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            onClick={() => slice.standardNo && onFilter(slice.standardNo)}
            className={`group relative overflow-hidden rounded-[14px] border p-5 text-left transition-all duration-200 ease-lf hover:-translate-y-[3px] hover:shadow-warm ${
              active
                ? 'border-brand-danger/50 bg-brand-danger/[0.06]'
                : 'border-hairline bg-brand-danger/[0.03] hover:border-brand-danger/35'
            }`}
          >
            {/* 印章水印 */}
            <motion.img
              src="/seal-standard.svg"
              alt=""
              aria-hidden
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 0.08 }}
              viewport={{ once: true }}
              transition={{ delay: 0.3 + i * 0.1, duration: 0.6 }}
              className="pointer-events-none absolute -bottom-2 -right-2 h-[72px] w-[72px] transition-opacity duration-300 group-hover:!opacity-20"
            />
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-brand-danger">
              权威标准 · NATIONAL STANDARD
            </div>
            <div className="mt-2 font-display text-[20px] font-semibold leading-[26px] text-ink">
              {slice.standardNo}
            </div>
            <div className="mt-1 line-clamp-2 text-[13.5px] font-medium leading-[21px] text-ink-2">
              {slice.title}
            </div>
            <div className="mt-2 text-[12.5px] text-ink-muted">{s.usage}</div>
            <div className="mt-3 flex items-center justify-between border-t border-hairline/70 pt-2.5">
              <span className="font-mono text-[11px] text-ink-muted tabular">
                被引 {slice.citedCount} 次
              </span>
              <span
                role="link"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onPreview(s.kbId);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.stopPropagation();
                    onPreview(s.kbId);
                  }
                }}
                className="inline-flex items-center gap-1 text-[12.5px] font-medium text-brand transition-transform duration-200 hover:translate-x-[2px]"
              >
                查看切片 <ArrowRight size={13} />
              </span>
            </div>
            {active && (
              <span className="absolute right-3 top-3 rounded-md bg-brand-danger px-1.5 py-0.5 font-mono text-[9.5px] font-medium text-paper">
                过滤中
              </span>
            )}
          </motion.button>
        );
      })}
    </div>
  );
}
