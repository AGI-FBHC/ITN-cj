/**
 * ConfidenceBadge — 画像置信度徽标
 * 精简建档：低置信「校准中」（琥珀），随学习动作缓慢上涨；
 * 精准定制：高置信「已测准」（品牌绿）。预设画像无档案，不渲染。
 */
import { Gauge } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { cn } from '@/lib/utils';

export default function ConfidenceBadge({ learnerId, className }: { learnerId: string; className?: string }) {
  const { learners } = useProfile();
  const learner = learners.find((l) => l.id === learnerId);
  const conf = learner?.confidence;
  if (!conf) return null;
  const calibrating = conf.value < 70;
  return (
    <span
      title={
        calibrating
          ? '精简建档只用了背景先验——前两讲我会多问几个检查点，边学边把画像测准'
          : '经过自评与自适应测题，画像已充分校准'
      }
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium',
        calibrating ? 'border-brand-amber/40 bg-brand-amber-tint/60 text-ochre' : 'border-brand/30 bg-brand-tint text-brand',
        className,
      )}
    >
      <Gauge size={10} />
      画像置信度 {conf.value}%{calibrating ? ' · 校准中' : ' · 已测准'}
    </span>
  );
}
