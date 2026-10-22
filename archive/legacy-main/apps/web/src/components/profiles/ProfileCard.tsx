/**
 * ProfileCard — 画像卡（profiles.md S2）
 * 标签带 + 头像 + 背景行 + 理论测试综合分(count-up) + 六维分布条 + 风格 tags + 诊断一句话 + CTA
 */
import { useMemo, useRef, useState } from 'react';
import { motion, useInView } from 'framer-motion';
import { Check } from 'lucide-react';
import type { Learner } from '@/data/learners';
import { knowledgePoints } from '@/data/knowledgePoints';
import { abilityName } from '@/data/abilityDimensions';
import { learnerUiMeta, weightedScore } from './profileMeta';
import { useCountUp, formatNum } from './CountUp';
import { cn } from '@/lib/utils';

export default function ProfileCard({
  learner,
  index,
  isCurrent,
  isSelected,
  onSelect,
  onSetCurrent,
}: {
  learner: Learner;
  index: number;
  isCurrent: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onSetCurrent: () => void;
}) {
  const meta = learnerUiMeta[learner.id];
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.25 });
  const [drawing, setDrawing] = useState(false);

  const overall = useMemo(() => weightedScore(learner), [learner]);
  const counted = useCountUp(overall, inView, 1000);

  const dist = useMemo(
    () =>
      knowledgePoints
        .map((kp) => ({ name: abilityName(kp.id, kp.name), score: learner.scores[kp.id] ?? 0 }))
        .sort((a, b) => b.score - a.score),
    [learner],
  );

  const oneLiner = useMemo(() => {
    const raw = learner.diagnosisSummary.replace(/^DIA-01 诊断：/, '');
    const first = raw.split('。')[0] ?? raw;
    return `“${first}。” — DIA-01`;
  }, [learner]);

  const handleSetCurrent = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isCurrent) return;
    setDrawing(true);
    onSetCurrent();
  };

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 40, scale: 0.97 }}
      animate={inView ? { opacity: 1, y: 0, scale: 1 } : undefined}
      transition={{ delay: index * 0.12, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect();
      }}
      className={cn(
        'lf-card group relative flex cursor-pointer flex-col overflow-hidden transition-all duration-200 ease-lf',
        'hover:-translate-y-1 hover:shadow-warm',
        isCurrent ? 'border-2 border-brand shadow-warm' : 'hover:border-brand/30',
        isSelected && !isCurrent && 'border-brand/40',
      )}
    >
      {/* 切换描边动画：墨绿描画一圈 500ms */}
      {drawing && (
        <svg
          className="pointer-events-none absolute inset-0 z-20 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <motion.rect
            x="0.6"
            y="0.6"
            width="98.8"
            height="98.8"
            rx="3"
            fill="none"
            stroke="#4E7860"
            strokeWidth="1.2"
            vectorEffect="non-scaling-stroke"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.5, ease: 'easeInOut' }}
            onAnimationComplete={() => setDrawing(false)}
          />
        </svg>
      )}

      {/* CURRENT 角标 */}
      {isCurrent && (
        <span className="absolute left-0 top-0 z-10 rounded-br-[10px] bg-brand px-2 py-1 font-mono text-[9.5px] font-semibold tracking-[0.14em] text-paper">
          CURRENT
        </span>
      )}

      {/* 标签带 */}
      <div
        className="px-5 py-2 transition-opacity duration-200 group-hover:opacity-100"
        style={{ backgroundColor: meta.bandBg }}
      >
        <span
          className="font-mono text-[11px] font-semibold tracking-[0.14em] opacity-80 transition-opacity duration-200 group-hover:opacity-100"
          style={{ color: meta.bandColor }}
        >
          {meta.bandLabel}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-5 pt-4">
        {/* 头像 + 姓名 */}
        <div className="flex items-center gap-3.5">
          <img
            src={learner.avatar}
            alt={learner.name}
            className="h-16 w-16 rounded-full border border-hairline object-cover"
          />
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="font-serif text-[20px] font-bold leading-[26px] text-ink">
                {learner.name}
              </span>
              <span className="text-[12px] text-ink-muted">{learner.age} 岁</span>
            </div>
            <span
              className="mt-1 inline-block rounded-md border px-1.5 py-px text-[11px] font-medium"
              style={{ color: meta.bandColor, borderColor: `${meta.bandColor}45`, backgroundColor: `${meta.bandColor}0D` }}
            >
              {learner.tag}
            </span>
          </div>
        </div>

        {/* 背景行 */}
        <p className="mt-3 text-[13px] leading-[20px] text-ink-muted">
          {learner.education} · {learner.school} · {meta.workExp}
        </p>

        {/* 理论测试综合分 */}
        <div className="mt-4 flex items-end justify-between border-t border-hairline pt-3">
          <div>
            <div className="lf-mono-label !text-[10px]">理论测试综合分</div>
            <div className="flex items-baseline gap-1">
              <span className="font-display text-[44px] leading-[50px] font-semibold text-ink tabular">
                {formatNum(Math.round(counted))}
              </span>
              <span className="font-display text-[16px] font-medium text-ink-muted">/ 100</span>
            </div>
          </div>
          {/* mini 分布条 */}
          <div className="w-[46%] space-y-1">
            {dist.map((d, i) => (
              <div key={d.name} className="flex items-center gap-1.5">
                <span className="w-[52px] shrink-0 truncate text-right text-[10px] leading-[14px] text-ink-muted">
                  {d.name}
                </span>
                <span className="relative h-[5px] flex-1 overflow-hidden rounded-full bg-paper-deep">
                  <motion.span
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{ backgroundColor: meta.bandColor }}
                    initial={{ width: 0 }}
                    animate={inView ? { width: `${d.score}%` } : undefined}
                    transition={{ delay: 0.3 + i * 0.05, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                  />
                </span>
                <span className="w-[18px] shrink-0 font-mono text-[10px] leading-[14px] text-ink-2 tabular">
                  {d.score}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* 学习风格 tags */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {learner.learningStyle.map((t) => (
            <span key={t} className="lf-chip !px-2 !py-0.5 !text-[12px]">
              {t}
            </span>
          ))}
        </div>

        {/* 诊断一句话 */}
        <p className="mt-3 flex-1 text-[13px] italic leading-[21px] text-ink-muted">{oneLiner}</p>

        {/* CTA */}
        <button
          type="button"
          onClick={handleSetCurrent}
          className={cn(
            'mt-4 w-full',
            isCurrent
              ? 'lf-btn-primary cursor-default !bg-brand'
              : 'lf-btn-ghost group-hover:border-brand/60 group-hover:bg-brand-tint',
          )}
        >
          {isCurrent ? (
            <>
              当前画像 <Check size={15} strokeWidth={2.4} />
            </>
          ) : (
            '设为当前画像'
          )}
        </button>
      </div>
    </motion.div>
  );
}
