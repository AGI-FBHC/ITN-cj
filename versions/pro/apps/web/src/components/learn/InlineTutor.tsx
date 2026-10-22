/**
 * InlineTutor — 块内苏格拉底追问（学练一体改版新增）
 * 「跟老师过一遍」不再跳去独立的练页：在课件现场展开 2~3 轮追问对话，
 * 聊完收起，人还在原地、上下文不丢。纯展示组件，状态由 LearnUnit 持有。
 */
import { useState } from 'react';
import { motion } from 'framer-motion';
import { GraduationCap, Send, X } from 'lucide-react';
import TraceBadge from '@/components/TraceBadge';
import { cn } from '@/lib/utils';

export interface TutorMsg {
  role: 'tutor' | 'me';
  text: string;
  kbRef?: string;
}

export default function InlineTutor({
  topic,
  msgs,
  step,
  onAnswer,
  onReveal,
  onMore,
  onClose,
}: {
  topic: string;
  msgs: TutorMsg[];
  /** ask = 等学习者作答；done = 本轮讲完，可再来一轮或收起 */
  step: 'ask' | 'done';
  onAnswer: (text: string) => void;
  onReveal: () => void;
  onMore: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const submit = () => {
    const t = draft.trim();
    if (!t) return;
    onAnswer(t);
    setDraft('');
  };
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex max-h-[420px] flex-col overflow-hidden rounded-[14px] border border-brand/35 bg-paper shadow-warm"
    >
      <div className="flex items-center gap-2 border-b border-hairline bg-brand-tint/40 px-3.5 py-2.5">
        <GraduationCap size={14} className="text-brand" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">
          跟老师过一遍 · {topic}
        </span>
        <button type="button" onClick={onClose} aria-label="收起对话" className="text-ink-muted hover:text-ink">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-3.5 py-3">
        {msgs.map((m, i) => (
          <div
            key={i}
            className={cn(
              'w-fit max-w-[92%] rounded-[11px] px-3 py-2 text-[12.5px] leading-[19px]',
              m.role === 'tutor'
                ? 'rounded-tl-[4px] border border-hairline bg-card-warm text-ink-2'
                : 'ml-auto rounded-br-[4px] bg-brand text-paper',
            )}
          >
            {m.text}
            {m.kbRef && (
              <span className="ml-1.5">
                <TraceBadge kbId={m.kbRef} />
              </span>
            )}
          </div>
        ))}
      </div>

      {step === 'ask' ? (
        <div className="border-t border-hairline bg-card-warm px-3 py-2.5">
          <div className="flex items-center gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              placeholder="用自己的话说说看…"
              className="h-9 min-w-0 flex-1 rounded-[9px] border border-hairline bg-paper px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-brand/50"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              aria-label="发送回答"
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]',
                draft.trim() ? 'bg-brand text-paper' : 'bg-paper-deep text-ink-muted/50',
              )}
            >
              <Send size={13} />
            </button>
          </div>
          <button
            type="button"
            onClick={onReveal}
            className="mt-1.5 text-[11.5px] font-medium text-ochre hover:underline"
          >
            不太会，直接讲给我听 →
          </button>
        </div>
      ) : (
        <div className="flex gap-2 border-t border-hairline bg-card-warm px-3 py-2.5">
          <button
            type="button"
            onClick={onMore}
            className="flex-1 rounded-[9px] border border-brand/35 bg-brand-tint/50 py-1.5 text-[12px] font-medium text-brand transition-colors hover:bg-brand-tint"
          >
            再追问一轮
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-[9px] border border-hairline bg-paper py-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:border-brand/40"
          >
            懂了，回到课程
          </button>
        </div>
      )}
    </motion.div>
  );
}
