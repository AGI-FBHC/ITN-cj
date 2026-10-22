/**
 * MetricsBar — 本轮协同实时指标条（ControlBar 之下 · S2/S3 泳道拓扑与消息流之上）
 * 4 格：幻觉拦截 · 溯源引用 · 辩论轮次 · 协同进度，全部按 cursor 已派发事件实时统计
 * idle（cursor === 0，尚未派发任何事件）态显示占位 '--'
 */
import { motion } from 'framer-motion';
import { ShieldAlert, Link2, MessagesSquare, Activity } from 'lucide-react';
import type { CollabScript } from '@/data/collabScript';
import { reducedMotion } from './usePlayback';

const easeLf = [0.22, 1, 0.36, 1] as [number, number, number, number];

function MetricCell({
  icon: Icon,
  label,
  value,
  suffix,
}: {
  icon: typeof ShieldAlert;
  label: string;
  value: string;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-3">
      <Icon size={16} className="shrink-0 text-ink-muted" />
      <div className="leading-tight">
        <div className="font-mono text-[16px] font-semibold text-ink tabular">
          <motion.span
            key={value}
            initial={reducedMotion() ? undefined : { scale: 0.72, opacity: 0.4 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 320, damping: 20 }}
            className="inline-block"
          >
            {value}
          </motion.span>
          {suffix && <span className="ml-0.5 text-[11px] font-normal text-ink-muted">{suffix}</span>}
        </div>
        <div className="mt-0.5 font-mono text-[10px] text-ink-muted">{label}</div>
      </div>
    </div>
  );
}

export default function MetricsBar({
  script,
  cursor,
}: {
  script: CollabScript;
  cursor: number;
}) {
  const idle = cursor === 0;
  const dispatched = script.events.slice(0, cursor);

  /* 幻觉拦截：content 含"幻觉拦截" 或 payload 含 hallucination_blocked 的已派发条数 */
  const blockedCount = dispatched.filter(
    (e) => e.content.includes('幻觉拦截') || (e.payload ?? '').includes('hallucination_blocked'),
  ).length;

  /* 溯源引用：已派发事件 kbRefs 去重计数 */
  const kbSet = new Set<string>();
  dispatched.forEach((e) => e.kbRefs?.forEach((id) => kbSet.add(id)));

  /* 辩论轮次：已派发 debate 事件的 round 去重计数 */
  const roundSet = new Set<number>();
  dispatched.forEach((e) => {
    if (e.type === 'debate' && e.round) roundSet.add(e.round);
  });

  /* 协同进度：cursor / 事件总数 百分比 */
  const progressPct = script.events.length > 0 ? Math.round((cursor / script.events.length) * 100) : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: easeLf, delay: 0.05 }}
      className="lf-card mt-4 grid grid-cols-2 divide-y divide-hairline sm:grid-cols-4 sm:divide-x sm:divide-y-0"
      aria-label="本轮协同实时指标"
    >
      <MetricCell
        icon={ShieldAlert}
        label="幻觉拦截"
        value={idle ? '--' : String(blockedCount)}
        suffix={idle ? undefined : '处'}
      />
      <MetricCell
        icon={Link2}
        label="溯源引用"
        value={idle ? '--' : String(kbSet.size)}
        suffix={idle ? undefined : '条'}
      />
      <MetricCell
        icon={MessagesSquare}
        label="辩论轮次"
        value={idle ? '--' : String(roundSet.size)}
        suffix={idle ? undefined : '轮'}
      />
      <MetricCell
        icon={Activity}
        label="协同进度"
        value={idle ? '--' : String(progressPct)}
        suffix={idle ? undefined : '%'}
      />
    </motion.div>
  );
}
