/**
 * SummaryBanner — S6 本轮协同小结（底部横幅卡）
 * 墨绿 5% 染色横幅：耗时 / 消息 / 幻觉拦截 / 产出 四个 mono 统计（收敛后 count-up）
 * 右侧 CTA：查看生成资源 → /resources · 进入交互导学 → /tutoring
 */
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence, animate } from 'framer-motion';
import { ArrowRight, Timer, MessagesSquare, ShieldAlert, PackageCheck } from 'lucide-react';
import type { PlayStatus } from './usePlayback';
import { reducedMotion } from './usePlayback';
import { cn } from '@/lib/utils';

function CountUp({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (reducedMotion()) {
      if (ref.current) ref.current.textContent = value.toFixed(decimals);
      return undefined;
    }
    const controls = animate(0, value, {
      duration: 1.2,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => {
        if (ref.current) ref.current.textContent = v.toFixed(decimals);
      },
    });
    return () => controls.stop();
  }, [value, decimals]);
  return <span ref={ref}>0</span>;
}

export default function SummaryBanner({
  status,
  totalT,
  msgCount,
  blockedCount,
  scenarioLabel,
}: {
  status: PlayStatus;
  totalT: number;
  msgCount: number;
  blockedCount: number;
  scenarioLabel: string;
}) {
  const done = status === 'done';
  const stats = [
    { icon: Timer, label: '耗时', value: totalT, decimals: 1, suffix: 's' },
    { icon: MessagesSquare, label: '消息', value: msgCount, decimals: 0, suffix: ' 条' },
    { icon: ShieldAlert, label: '幻觉拦截', value: blockedCount, decimals: 0, suffix: ' 处' },
    { icon: PackageCheck, label: '产出', value: 3, decimals: 0, suffix: ' 件' },
  ];

  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="mt-14 rounded-[14px] border border-brand/25 bg-brand/[0.05] p-5"
      aria-label="本轮协同小结"
    >
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
        <div className="min-w-[150px]">
          <div className="lf-mono-label !text-[10.5px]">COLLAB SUMMARY</div>
          <div className="mt-1 flex items-center gap-2 font-serif text-[18px] font-semibold text-ink">
            本轮协同小结
            <span
              className={cn(
                'rounded-md border px-1.5 py-px font-mono text-[10px] font-semibold',
                done
                  ? 'border-brand/50 bg-brand-tint text-brand'
                  : 'border-hairline bg-paper text-ink-muted',
              )}
            >
              {done ? '已收敛' : '待收敛'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-7 gap-y-3">
          {stats.map((s) => (
            <div key={s.label} className="flex items-center gap-2">
              <s.icon size={15} className={done ? 'text-brand' : 'text-ink-muted'} />
              <div className="leading-tight">
                <div className="font-mono text-[17px] font-semibold text-ink tabular">
                  {done ? <CountUp value={s.value} decimals={s.decimals} /> : '--'}
                  <span className="text-[11px] font-normal text-ink-muted">{s.suffix}</span>
                </div>
                <div className="font-mono text-[10px] text-ink-muted">{s.label}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Link to="/resources" className="lf-btn-primary !px-4 !py-2 !text-[13.5px]">
            查看生成资源
            <ArrowRight size={14} />
          </Link>
          <Link to="/tutoring" className="lf-btn-ghost !px-4 !py-2 !text-[13.5px]">
            进入交互导学
            <ArrowRight size={14} />
          </Link>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {done && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 160, damping: 22 }}
            className="overflow-hidden"
          >
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-brand/15 pt-4">
              <span className="font-mono text-[10.5px] tracking-[0.12em] text-ink-muted">
                产出物已入库 · 当前场景：{scenarioLabel}
              </span>
              {['定制讲义', '实操指南', '分阶测试题'].map((f) => (
                <span
                  key={f}
                  className={cn(
                    'rounded-[8px] border px-2 py-0.5 text-[11.5px] font-medium',
                    f === scenarioLabel
                      ? 'border-brand-amber/60 bg-brand-amber-tint text-brand-amber'
                      : 'border-brand/30 bg-brand-tint/70 text-brand',
                  )}
                >
                  {f}
                </span>
              ))}
              <span className="font-mono text-[10.5px] text-ink-muted">
                · 画像已回写 · 追踪埋点待首测回流
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}
