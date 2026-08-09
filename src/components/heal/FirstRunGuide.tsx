/** 首次使用引导：保留旧版轻量三问设计，内容改用真实课程状态。 */
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { MapPin, Play, Sparkles, X } from 'lucide-react';
import { Sprout } from '@/components/heal/Flora';
import { useProfile } from '@/context/ProfileContext';
import { useCourseLearning } from '@/hooks/useCourseLearning';

const K_SEEN = 'lf.guideSeen';

function readSeen(): Record<string, 1> {
  try {
    const raw = window.localStorage.getItem(K_SEEN);
    return raw && raw !== '1' ? JSON.parse(raw) as Record<string, 1> : {};
  } catch { return {}; }
}

export default function FirstRunGuide() {
  const { currentLearner } = useProfile();
  const learning = useCourseLearning();
  const [seen, setSeen] = useState<Record<string, 1>>(readSeen);
  const open = !seen[currentLearner.id] && !learning.loading && Boolean(learning.course);

  const close = () => {
    const next = { ...seen, [currentLearner.id]: 1 as const };
    setSeen(next);
    try { window.localStorage.setItem(K_SEEN, JSON.stringify(next)); } catch { /* UI 偏好写入失败不影响学习 */ }
  };

  const steps = [
    { icon: Sparkles, title: '这是什么', text: '一个会按你的目标与画像动态生成课程、章节和学习资源的系统。' },
    { icon: MapPin, title: '你现在在哪', text: `当前课程有 ${learning.course?.chapters.length ?? 0} 个章节、${learning.totalCount} 份已生成资源，你已经学完 ${learning.learnedCount} 份。` },
    { icon: Play, title: '先做哪一步', text: learning.nextResource ? `先从《${learning.nextResource.title}》开始，其余内容可以稍后再看。` : '当前课程已完成，可以回顾错题和个人知识库。' },
  ];

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mt-5 overflow-hidden">
          <div className="lf-card relative border-brand/20 bg-brand-tint/30 p-5">
            <Sprout className="pointer-events-none absolute -right-1 -top-6 h-[58px] w-[48px]" />
            <button type="button" onClick={close} aria-label="关闭引导" className="absolute right-3 top-3 rounded-full p-1 text-ink-muted hover:bg-paper hover:text-ink"><X size={14} /></button>
            <div className="grid gap-4 pr-5 md:grid-cols-3">
              {steps.map((step, index) => (
                <div key={step.title}>
                  <div className="mb-1.5 flex items-center gap-1.5"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand text-[10.5px] font-bold text-paper">{index + 1}</span><step.icon size={13} className="text-brand" /><span className="text-[13px] font-semibold text-ink">{step.title}</span></div>
                  <p className="text-[12px] leading-[19px] text-ink-2">{step.text}</p>
                </div>
              ))}
            </div>
            <button type="button" onClick={close} className="mt-3.5 text-[12.5px] font-medium text-brand hover:underline">知道了，开始学 →</button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
