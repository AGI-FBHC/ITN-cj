/**
 * WrongBook `/me/wrong` — 错题本
 *
 * 不是一张静态清单：错题按遗忘曲线排「该重做了」，
 * 重做对了间隔变长、错了重置，直到你自己标「已掌握」。
 * 补上「练 → 错 → 针对性复习 → 再练」这段原本断掉的闭环。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, X, RotateCcw, BadgeCheck, Trash2, ChevronDown, Repeat, GraduationCap } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { useWrongBook } from '@/context/WrongBookContext';
import type { WrongItem } from '@/context/WrongBookContext';
import { getQuizByIds } from '@/data/quizBank';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import { humanAgo, moistLevel, MOIST_META } from '@/data/forgetting';
import TraceBadge from '@/components/TraceBadge';
import PageBack from '@/components/PageBack';
import GardenEmpty from '@/components/heal/GardenEmpty';
import PageTip from '@/components/heal/PageTip';
import { cn } from '@/lib/utils';

const letters = ['A', 'B', 'C', 'D'];

/** 把错题记录还原成可显示的题面：题库题查 quizBank，课件题用随记录存下的 inline */
function questionOf(item: WrongItem) {
  if (item.inline) return item.inline;
  const q = getQuizByIds([item.qid])[0];
  return q
    ? { stem: q.stem, options: q.options, answerIndex: q.answerIndex, analysis: q.analysis, kbRefs: q.kbRefs }
    : null;
}

const FROM_LABEL: Record<WrongItem['from'], string> = {
  quiz: '分阶题',
  checkpoint: '课件检查点',
  tutoring: '练习对话',
};

function WrongCard({ item }: { item: WrongItem }) {
  const navigate = useNavigate();
  const { redo, setMastered, remove } = useWrongBook();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<number | null>(null);
  const q = questionOf(item);
  const kp = getKnowledgePoint(item.kpId);
  const meta = MOIST_META[moistLevel(item.retention)];

  if (!q) return null;
  const answered = pick !== null;
  const gotIt = answered && pick === q.answerIndex;

  const choose = (i: number) => {
    if (answered) return;
    setPick(i);
    redo(item.qid, i === q.answerIndex, i);
  };

  return (
    <div className={cn('lf-card overflow-hidden', item.due && 'border-brand-amber/45')}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-3 px-4 py-3 text-left">
        <span
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg font-mono text-[11px] font-bold text-paper"
          style={{ backgroundColor: meta.ring }}
        >
          {item.wrongCount}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-md bg-paper-deep px-1.5 py-px text-[10.5px] text-ink-muted">{kp.name}</span>
            <span className="rounded-md bg-paper-deep px-1.5 py-px text-[10.5px] text-ink-muted">{FROM_LABEL[item.from]}</span>
            {item.due
              ? <span className="rounded-md bg-brand-amber-tint px-1.5 py-px text-[10.5px] font-medium text-ochre">该重做了</span>
              : <span className="rounded-md bg-brand-tint px-1.5 py-px text-[10.5px] text-brand">还记得牢</span>}
            {item.streak > 0 && (
              <span className="rounded-md bg-brand-tint px-1.5 py-px text-[10.5px] text-brand">连对 {item.streak}</span>
            )}
          </span>
          <span className="mt-1 block text-[14px] font-medium leading-[21px] text-ink">{q.stem}</span>
          <span className="mt-0.5 block font-mono text-[10.5px] text-ink-muted">
            上次 {humanAgo(Date.now() - item.lastAt)} · 错过 {item.wrongCount} 次
          </span>
        </span>
        <ChevronDown size={16} className={cn('mt-1 shrink-0 text-ink-muted transition-transform', open && 'rotate-180')} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-2 px-4 pb-4">
              {q.options.map((opt, i) => {
                const isAnswer = i === q.answerIndex;
                const isMine = i === pick;
                const wasMyOldPick = !answered && i === item.lastPick;
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={answered}
                    onClick={() => choose(i)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-[10px] border px-3.5 py-2.5 text-left text-[13.5px] transition-all',
                      !answered && 'cursor-pointer border-hairline bg-paper hover:border-brand/45 hover:bg-brand-tint/40',
                      !answered && wasMyOldPick && 'border-brand-danger/40 bg-brand-danger/[0.04]',
                      answered && isAnswer && 'border-brand bg-brand text-paper',
                      answered && isMine && !isAnswer && 'border-brand-danger bg-brand-danger text-paper',
                      answered && !isAnswer && !isMine && 'border-hairline bg-paper opacity-55',
                    )}
                  >
                    <span className="font-mono text-[11px]">{letters[i]}</span>
                    <span className="flex-1 leading-[20px]">{opt}</span>
                    {!answered && wasMyOldPick && (
                      <span className="shrink-0 text-[10.5px] font-medium text-brand-danger">上次选的</span>
                    )}
                    {answered && isAnswer && <Check size={15} className="shrink-0" />}
                    {answered && isMine && !isAnswer && <X size={15} className="shrink-0" />}
                  </button>
                );
              })}

              {answered && (
                <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
                  className={cn('rounded-[10px] border p-3.5', gotIt ? 'border-brand/35 bg-brand-tint/60' : 'border-brand-danger/30 bg-brand-danger/[0.05]')}>
                  <div className="text-[13px] font-semibold" style={{ color: gotIt ? '#4E7860' : '#B0483B' }}>
                    {gotIt ? '这次对了 · 下次会隔更久再问你' : '还是错了 · 过两天再来一遍'}
                  </div>
                  {q.analysis && <p className="mt-1.5 text-[12.5px] leading-[20px] text-ink-2">{q.analysis}</p>}
                  {q.kbRefs && q.kbRefs.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {q.kbRefs.map((id) => <TraceBadge key={id} kbId={id} />)}
                    </div>
                  )}
                </motion.div>
              )}

              <div className="flex flex-wrap items-center gap-2 border-t border-hairline/60 pt-2.5">
                {answered && (
                  <button type="button" onClick={() => setPick(null)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-paper px-2.5 py-1 text-[12px] text-ink-2 transition-colors hover:border-brand/40 hover:text-brand">
                    <RotateCcw size={12} /> 再做一次
                  </button>
                )}
                <button
                  type="button"
                  title="回到分阶题原题重新练一遍"
                  onClick={() => navigate(`/resources?tab=quiz&focus=${item.qid}`)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-paper px-2.5 py-1 text-[12px] text-ink-2 transition-colors hover:border-brand/40 hover:text-brand">
                  <Repeat size={12} /> 重练这道题
                </button>
                <button
                  type="button"
                  title="AI 老师围绕薄弱点带练"
                  onClick={() => navigate('/tutoring')}
                  className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-paper px-2.5 py-1 text-[12px] text-ink-2 transition-colors hover:border-brand/40 hover:text-brand">
                  <GraduationCap size={12} /> 去导学练
                </button>
                <button type="button" onClick={() => setMastered(item.qid, true)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-brand/35 bg-brand-tint/50 px-2.5 py-1 text-[12px] font-medium text-brand transition-colors hover:bg-brand-tint">
                  <BadgeCheck size={12} /> 这题我已经会了
                </button>
                <button type="button" onClick={() => remove(item.qid)}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-muted transition-colors hover:text-brand-danger">
                  <Trash2 size={12} /> 移除
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function WrongBook() {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const { items, due, mastered, setMastered } = useWrongBook();
  const [showMastered, setShowMastered] = useState(false);

  /* 按知识点分组，组内最该重做的在前 */
  const grouped = useMemo(() => {
    const m = new Map<string, WrongItem[]>();
    items.forEach((i) => {
      if (!m.has(i.kpId)) m.set(i.kpId, []);
      m.get(i.kpId)!.push(i);
    });
    return [...m.entries()].map(([kpId, list]) => ({ kp: getKnowledgePoint(kpId), list }));
  }, [items]);

  return (
    <div className="mx-auto max-w-[840px] px-5 pb-24 pt-8 md:px-6">
      <PageBack parent={{ label: '我的学习', to: '/me' }} current="错题本" />

      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex h-12 w-12 items-center justify-center rounded-[12px] border border-brand-danger/25 bg-brand-danger/10">
            <X size={22} className="text-brand-danger" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="font-serif text-[24px] font-semibold text-ink">错题本</h1>
            <p className="mt-0.5 text-[13px] text-ink-muted">
              {currentLearner.name} · 待攻克 {items.length} 题
              {due.length > 0 && <span className="text-ochre"> · {due.length} 题该重做了</span>}
              {mastered.length > 0 && ` · 已拿下 ${mastered.length} 题`}
            </p>
          </div>
        </div>
      </motion.div>

      <PageTip id="wrongbook" className="mt-4">
        错题不会一直堆着——系统按<span className="font-medium text-ink">记忆规律</span>安排你什么时候重做：
        做对了下次隔更久再问，做错了就近期再来。会了就点「这题我已经会了」。
      </PageTip>

      {items.length === 0 ? (
        <div className="lf-card mt-5">
          <GardenEmpty
            scene="sprout"
            title={mastered.length > 0 ? '错题都清完了' : '还没有错题'}
            hint={mastered.length > 0
              ? `已经拿下 ${mastered.length} 题。之后再做错的题会自动收进这里。`
              : '做分阶题或课件检查点时答错的题，会自动收进这里，并按记忆规律提醒你重做。'}
            action={
              <button type="button" onClick={() => navigate('/tutoring')} className="lf-btn-primary !py-2 text-[13.5px]">
                去练一节
              </button>
            }
          />
        </div>
      ) : (
        <div className="mt-5 space-y-6">
          {grouped.map(({ kp, list }) => (
            <section key={kp.id}>
              <div className="mb-2.5 flex items-center gap-2">
                <h2 className="text-[15.5px] font-semibold text-ink">{kp.name}</h2>
                <span className="rounded bg-brand-danger/10 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-brand-danger">
                  {list.length}
                </span>
              </div>
              <div className="space-y-2.5">
                {list.map((it) => <WrongCard key={it.qid} item={it} />)}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* 已掌握（折叠） */}
      {mastered.length > 0 && (
        <div className="mt-8">
          <button
            type="button"
            onClick={() => setShowMastered((v) => !v)}
            className="flex w-full items-center justify-between rounded-[12px] border border-hairline bg-card-warm/70 px-4 py-2.5 text-[13px] text-ink-2 transition-colors hover:border-brand/40"
          >
            <span className="inline-flex items-center gap-1.5">
              <BadgeCheck size={14} className="text-brand" /> 已经拿下的 {mastered.length} 题
            </span>
            <ChevronDown size={15} className={cn('transition-transform', showMastered && 'rotate-180')} />
          </button>
          {showMastered && (
            <div className="lf-anim-in-up mt-2 space-y-1.5">
              {mastered.map((it) => {
                const q = questionOf(it);
                return (
                  <div key={it.qid} className="flex items-center gap-2 rounded-[10px] border border-hairline bg-paper px-3 py-2">
                    <BadgeCheck size={14} className="shrink-0 text-brand" />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{q?.stem ?? it.qid}</span>
                    <button
                      type="button"
                      onClick={() => setMastered(it.qid, false)}
                      className="shrink-0 text-[11.5px] text-ink-muted hover:text-brand"
                    >
                      放回错题本
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
