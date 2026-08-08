/**
 * FirstRunGuide — 首次使用引导（轻量，非全屏）
 * 只回答三个问题：这是什么 / 你现在在哪 / 先做哪一步。
 * 关闭后写入 localStorage 不再出现；可从「我的画像」再次唤起（预留）。
 */
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Sparkles, MapPin, Play } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { activePathNode } from '@/data/reportData';
import { reportForLearner } from '@/data/reportBuilder';
import { Sprout } from '@/components/heal/Flora';

const K_SEEN = 'lf.guideSeen';

/** 按学习者记录「已看过」——每个新建档的用户都应该看到一次引导 */
function readSeen(): Record<string, 1> {
  try {
    const raw = window.localStorage.getItem(K_SEEN);
    if (!raw || raw === '1') return {}; // '1' 是旧全局格式，弃用（引导会再各出现一次）
    return JSON.parse(raw) as Record<string, 1>;
  } catch {
    return {};
  }
}

export default function FirstRunGuide() {
  const { currentLearner } = useProfile();
  const [seenMap, setSeenMap] = useState<Record<string, 1>>(readSeen);
  const open = !seenMap[currentLearner.id];

  const report = reportForLearner(currentLearner);
  const done = report.path.filter((p) => p.status === 'done').length;
  const node = activePathNode(report);

  const close = () => {
    const next: Record<string, 1> = { ...seenMap, [currentLearner.id]: 1 };
    setSeenMap(next);
    try { window.localStorage.setItem(K_SEEN, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const steps = [
    {
      icon: Sparkles,
      title: '这是什么',
      text: '一个会按你的水平「现做」教材的学习系统——同一个知识点，给你的讲法和给别人的不一样。',
    },
    {
      icon: MapPin,
      title: '你现在在哪',
      text: `一共 6 个知识点、${report.path.length} 个阶段，你已经完成 ${done} 个。系统按你的强弱排好了先后顺序。`,
    },
    {
      icon: Play,
      title: '先做哪一步',
      text: node
        ? `就从下面那张卡开始：《${node.title}》，大约 ${node.est}。其余的先别管。`
        : '点下面那张卡，开始你的第一课。其余的先别管。',
    },
  ];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: -8, height: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto' }}
          exit={{ opacity: 0, y: -8, height: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          <div className="lf-glass relative mt-5 rounded-[18px] p-5">
            <button
              type="button"
              onClick={close}
              aria-label="关闭引导"
              className="absolute right-3 top-3 rounded-lg p-1 text-ink-muted transition-colors hover:bg-paper-deep hover:text-ink"
            >
              <X size={15} />
            </button>

            <div className="flex items-center gap-2.5">
              <Sprout className="h-8 w-8 shrink-0" />
              <h2 className="font-serif text-[17px] font-semibold text-ink">先花 20 秒，看懂这里怎么用</h2>
            </div>

            <div className="mt-3.5 grid gap-3 sm:grid-cols-3">
              {steps.map((s, i) => (
                <div key={s.title} className="rounded-[13px] border border-hairline/70 bg-paper/55 p-3">
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand text-[10.5px] font-bold text-paper">
                      {i + 1}
                    </span>
                    <s.icon size={13} className="text-brand" />
                    <span className="text-[13px] font-semibold text-ink">{s.title}</span>
                  </div>
                  <p className="text-[12px] leading-[19px] text-ink-2">{s.text}</p>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={close}
              className="mt-3.5 text-[12.5px] font-medium text-brand hover:underline"
            >
              知道了，开始学 →
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
