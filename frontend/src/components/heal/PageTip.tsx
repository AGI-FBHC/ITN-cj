/**
 * PageTip — 每页首次进入时的一句轻提示
 *
 * 解决「功能藏得深、用户不知道」：有些能力不在明面上（可以随时打断提问、
 * 能调语速、能开专注、引用可点开看出处…），第一次来的时候说一句就够了。
 *
 * 原则：一行、可关、只出现一次（按 id 记在 localStorage），绝不挡路。
 */
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Lightbulb } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { cn } from '@/lib/utils';

const KEY_PREFIX = 'lf.tip.';

export default function PageTip({
  id,
  children,
  className,
}: {
  /** 唯一标识，用于记住「这条已经看过了」 */
  id: string;
  children: React.ReactNode;
  className?: string;
}) {
  /* 「看过了」按学习者分别记录——新用户不该继承别人的已读状态 */
  const { currentLearnerId } = useProfile();
  const key = `${KEY_PREFIX}${currentLearnerId}.${id}`;
  const [closed, setClosed] = useState<Record<string, 1>>({});
  let open = !closed[key];
  try { if (window.localStorage.getItem(key) === '1') open = false; } catch { /* ignore */ }

  const close = () => {
    setClosed((prev) => ({ ...prev, [key]: 1 }));
    try { window.localStorage.setItem(key, '1'); } catch { /* ignore */ }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: -6, height: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto' }}
          exit={{ opacity: 0, y: -6, height: 0 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          <div
            className={cn(
              'flex items-start gap-2 rounded-[12px] border border-brand-amber/40 bg-brand-amber-tint/50 px-3 py-2',
              className,
            )}
          >
            <Lightbulb size={14} className="mt-[2px] shrink-0 text-ochre" />
            <p className="min-w-0 flex-1 text-[12.5px] leading-[19px] text-ink-2">{children}</p>
            <button
              type="button"
              onClick={close}
              aria-label="知道了"
              className="shrink-0 rounded-md p-0.5 text-ink-muted transition-colors hover:bg-paper-deep hover:text-ink"
            >
              <X size={14} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
