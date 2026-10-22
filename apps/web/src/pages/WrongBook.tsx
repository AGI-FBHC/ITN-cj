import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { BadgeCheck, Check, ChevronDown, GraduationCap, NotebookPen, Repeat, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import GardenEmpty from '@/components/heal/GardenEmpty';
import PageTip from '@/components/heal/PageTip';
import TraceBadge from '@/components/TraceBadge';
import { DAY_MS, dueAt, humanAgo, moistLevel, MOIST_META, retention } from '@/data/forgetting';
import { learningResourcePath, useCourseLearning } from '@/hooks/useCourseLearning';
import { useNotes } from '@/context/NotesContext';
import { api } from '@/lib/api';
import type { WrongAnswerRecord } from '@/lib/api';
import { cn } from '@/lib/utils';

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const FROM_LABEL: Record<string, string> = {
  quiz: '分阶题',
  checkpoint: '课件检查点',
  tutoring: '练习对话',
};

function memoryOf(item: WrongAnswerRecord) {
  const lastAt = Date.parse(item.updatedAt);
  const mastery = Math.max(10, Math.min(90, 40 + item.streak * 20 - item.reviewCount * 5));
  const currentRetention = retention(Math.max(0, (Date.now() - lastAt) / DAY_MS), item.streak, mastery);
  const nextDueAt = dueAt(lastAt, item.streak, mastery);
  return { lastAt, mastery, retention: currentRetention, dueAt: nextDueAt, due: !item.mastered && Date.now() >= nextDueAt };
}

function WrongCard({ item, categoryName, sourcePath, onChange, onRemove }: {
  item: WrongAnswerRecord;
  categoryName: string;
  sourcePath: string | null;
  onChange: (item: WrongAnswerRecord) => void;
  onRemove: (id: string) => void;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<number | null>(null);
  const [correct, setCorrect] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { addNote } = useNotes();
  const [note, setNote] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);
  const memory = memoryOf(item);
  const meta = MOIST_META[moistLevel(memory.retention)];
  const oldPick = item.lastPick ?? item.userAnswer;

  const review = async (answer: number) => {
    if (pick !== null || submitting) return;
    setSubmitting(true);
    try {
      const result = await api.reviewWrongAnswer(item.id, answer);
      setPick(answer);
      setCorrect(result.correct);
      onChange(result.item);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '重做结果保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  const setMastered = async () => {
    try {
      const updated = await api.updateWrongAnswer(item.id, {
        mastered: !item.mastered,
        reviewStatus: item.mastered ? 'reviewing' : 'mastered',
      });
      onChange(updated);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '错题状态更新失败');
    }
  };

  const saveNote = () => {
    const text = note.trim();
    if (!text || noteSaving) return;
    setNoteSaving(true);
    addNote({
      kpId: item.kpId ?? 'uncategorized',
      text: `【错题】${item.stem}\n\n我的记录：${text}\n\n正确答案：${letters[item.correctAnswer]}；解析：${item.explanation || '无'}`,
      source: `错题 · ${item.knowledgeCategoryName || '未分类'} · ${item.stem.slice(0, 18)}`,
      sourceKind: 'manual',
      blockAnchor: item.id,
      kbRefs: item.kbRefs ?? [],
    });
    setNoteSaving(false);
    setNoteSaved(true);
    setNote('');
    toast.success('已记入笔记本', { description: '错题和你的记录已保存到笔记本' });
  };
  return (
    <article className={cn('lf-card overflow-hidden', memory.due && 'border-brand-amber/45')}>
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-start gap-3 px-4 py-3 text-left">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg font-mono text-[11px] font-bold text-paper" style={{ backgroundColor: meta.ring }}>
          {item.reviewCount + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-md bg-paper-deep px-1.5 py-px text-[10.5px] text-ink-muted">{categoryName}</span>
            <span className="rounded-md bg-paper-deep px-1.5 py-px text-[10.5px] text-ink-muted">{FROM_LABEL[item.fromSource || 'quiz'] || '课程练习'}</span>
            {memory.due
              ? <span className="rounded-md bg-brand-amber-tint px-1.5 py-px text-[10.5px] font-medium text-ochre">该重做了</span>
              : <span className="rounded-md bg-brand-tint px-1.5 py-px text-[10.5px] text-brand">还记得牢</span>}
            {item.streak > 0 && <span className="rounded-md bg-brand-tint px-1.5 py-px text-[10.5px] text-brand">连对 {item.streak}</span>}
          </span>
          <span className="mt-1 block text-[14px] font-medium leading-[21px] text-ink">{item.stem}</span>
          <span className="mt-0.5 block font-mono text-[10.5px] text-ink-muted">上次 {humanAgo(Date.now() - memory.lastAt)} · 已复习 {item.reviewCount} 次</span>
        </span>
        <ChevronDown size={16} className={cn('mt-1 shrink-0 text-ink-muted transition-transform', open && 'rotate-180')} />
      </button>

      <AnimatePresence initial={false}>
        {open && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }} className="overflow-hidden">
          <div className="space-y-2 px-4 pb-4">
            {item.options.map((option, index) => {
              const answered = pick !== null;
              const isAnswer = index === item.correctAnswer;
              const isMine = index === pick;
              return <button key={index} type="button" disabled={answered || submitting} onClick={() => void review(index)} className={cn(
                'flex w-full items-center gap-3 rounded-[10px] border px-3.5 py-2.5 text-left text-[13.5px] transition-all',
                !answered && 'cursor-pointer border-hairline bg-paper hover:border-brand/45 hover:bg-brand-tint/40',
                !answered && index === oldPick && 'border-brand-danger/40 bg-brand-danger/[0.04]',
                answered && isAnswer && 'border-brand bg-brand text-paper',
                answered && isMine && !isAnswer && 'border-brand-danger bg-brand-danger text-paper',
                answered && !isAnswer && !isMine && 'border-hairline bg-paper opacity-55',
              )}>
                <span className="font-mono text-[11px]">{letters[index]}</span><span className="flex-1 leading-[20px]">{option}</span>
                {!answered && index === oldPick && <span className="shrink-0 text-[10.5px] font-medium text-brand-danger">上次选的</span>}
                {answered && isAnswer && <Check size={15} className="shrink-0" />}
                {answered && isMine && !isAnswer && <X size={15} className="shrink-0" />}
              </button>;
            })}

            {pick !== null && <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className={cn('rounded-[10px] border p-3.5', correct ? 'border-brand/35 bg-brand-tint/60' : 'border-brand-danger/30 bg-brand-danger/[0.05]')}>
              <div className="text-[13px] font-semibold" style={{ color: correct ? '#4E7860' : '#B0483B' }}>
                {correct ? '这次对了 · 下次会隔更久再问你' : '这次还没答对 · 系统已重新安排复习'}
              </div>
              {item.explanation && <p className="mt-1.5 text-[12.5px] leading-[20px] text-ink-2">{item.explanation}</p>}
              {!!item.kbRefs.length && <div className="mt-2 flex flex-wrap gap-1.5">{item.kbRefs.map((id) => <TraceBadge key={id} kbId={id} />)}</div>}
            </motion.div>}

            <div className="flex flex-wrap items-center gap-2 border-t border-hairline/60 pt-2.5">
              {pick !== null && <button type="button" onClick={() => { setPick(null); setCorrect(null); }} className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-paper px-2.5 py-1 text-[12px] text-ink-2 hover:border-brand/40 hover:text-brand"><RotateCcw size={12} />再做一次</button>}
              {sourcePath && <button type="button" onClick={() => navigate(`${sourcePath}&focus=${encodeURIComponent(item.questionId)}`)} className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-paper px-2.5 py-1 text-[12px] text-ink-2 hover:border-brand/40 hover:text-brand"><Repeat size={12} />回到原题</button>}
              <button type="button" title="打开「用真实练习校准画像」：按真实水平作答后会重新评估六维能力" onClick={() => navigate('/me/calibrate')} className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-paper px-2.5 py-1 text-[12px] text-ink-2 hover:border-brand/40 hover:text-brand"><GraduationCap size={12} />去练一组题</button>
              <button type="button" onClick={() => void setMastered()} className="inline-flex items-center gap-1.5 rounded-md border border-brand/35 bg-brand-tint/50 px-2.5 py-1 text-[12px] font-medium text-brand hover:bg-brand-tint"><BadgeCheck size={12} />{item.mastered ? '放回错题本' : '这题我已经会了'}</button>
              <button type="button" onClick={() => onRemove(item.id)} className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-muted hover:text-brand-danger"><Trash2 size={12} />移除</button>
            </div>

            <div className="border-t border-hairline/60 pt-2.5">
              <p className="text-[11px] font-medium text-ink-2">错题笔记</p>
              <textarea
                value={note}
                onChange={(event) => { setNote(event.target.value); if (noteSaved) setNoteSaved(false); }}
                rows={2}
                placeholder="记录这道错题的想法、错因或要点…"
                className="mt-1.5 w-full rounded-[10px] border border-hairline bg-paper px-3 py-2 text-[12.5px] leading-5 text-ink outline-none transition-colors focus:border-brand/40"
              />
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={saveNote}
                  disabled={!note.trim() || noteSaving}
                  className="inline-flex items-center gap-1.5 rounded-md border border-brand/30 bg-brand-tint/50 px-2.5 py-1 text-[11.5px] font-medium text-brand transition hover:border-brand/45 hover:bg-brand-tint disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <NotebookPen size={12} />保存到笔记本
                </button>
                {noteSaved && <span className="text-[11px] text-brand">已记入笔记本</span>}
              </div>
            </div>
          </div></motion.div>}
      </AnimatePresence>
    </article>
  );
}

export default function WrongBook() {
  const navigate = useNavigate();
  const learning = useCourseLearning();
  const [items, setItems] = useState<WrongAnswerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showMastered, setShowMastered] = useState(false);
  const [keyword, setKeyword] = useState('');

  useEffect(() => {
    setLoading(true);
    const timer = window.setTimeout(() => {
      api.listWrongAnswers(keyword || undefined).then((result) => setItems(result.items ?? []))
        .catch((reason) => toast.error(reason instanceof Error ? reason.message : '错题读取失败'))
        .finally(() => setLoading(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  const sourceNames = useMemo(() => {
    const chapters = new Map((learning.course?.chapters ?? []).map((chapter) => [chapter.id, chapter.title]));
    return new Map(learning.resources.map((resource) => [resource.id, chapters.get(resource.chapterId || '') || resource.title]));
  }, [learning.course, learning.resources]);
  const categoryOf = (item: WrongAnswerRecord) => item.knowledgeCategoryName || (item.resourceId ? sourceNames.get(item.resourceId) : null) || item.kpId || '课程知识点';
  const active = useMemo(() => items.filter((item) => !item.mastered).sort((a, b) => memoryOf(a).retention - memoryOf(b).retention), [items]);
  const mastered = items.filter((item) => item.mastered);
  const due = active.filter((item) => memoryOf(item).due);
  const grouped = useMemo(() => {
    const groups = new Map<string, WrongAnswerRecord[]>();
    active.forEach((item) => {
      const name = categoryOf(item);
      groups.set(name, [...(groups.get(name) ?? []), item]);
    });
    return [...groups.entries()];
  }, [active, sourceNames]);
  const sourcePaths = useMemo(() => new Map(learning.resources.map((resource) => [resource.id, learningResourcePath(resource)])), [learning.resources]);

  const change = (updated: WrongAnswerRecord) => setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
  const remove = async (id: string) => {
    try {
      await api.deleteWrongAnswer(id);
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '错题删除失败');
    }
  };

  return <div className="mx-auto max-w-[840px] px-5 pb-12 pt-8 md:px-6">
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <div className="flex flex-wrap items-center gap-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-[12px] border border-brand-danger/25 bg-brand-danger/10"><X size={22} className="text-brand-danger" /></span>
        <div className="min-w-0 flex-1"><h1 className="font-serif text-[24px] font-semibold text-ink">错题本</h1></div>
      </div>
    </motion.div>
    <PageTip id="wrongbook" className="mt-4">错题由后端长期保存，并按<span className="font-medium text-ink">记忆规律</span>安排重做。每次作答都会回写连续答对次数、复习次数和下次复习节奏。</PageTip>

    {/* 搜索栏 */}
    <div className="relative mt-4">
      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
      <input
        type="text"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        placeholder="搜索题干、解析或知识点名称..."
        className="w-full rounded-[12px] border border-hairline bg-paper py-2.5 pl-9 pr-9 text-[13px] text-ink outline-none transition-colors focus:border-brand/40"
      />
      {keyword && (
        <button type="button" onClick={() => setKeyword('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink">
          <X size={14} />
        </button>
      )}
    </div>

    {loading ? <div className="lf-card mt-5 p-8 text-center text-[13px] text-ink-muted">正在读取后端错题记录…</div> : active.length === 0 ? <div className="lf-card mt-5"><GardenEmpty scene="sprout" title={mastered.length ? '错题都清完了' : '还没有错题'} hint={mastered.length ? `已经拿下 ${mastered.length} 题。之后的真实错题仍会自动收进这里。` : '在课程分阶题中答错后，题目会自动收进这里，并按记忆规律提醒你重做。'} action={<button type="button" title="打开「用真实练习校准画像」：按真实水平作答后会重新评估六维能力" onClick={() => navigate('/me/calibrate')} className="lf-btn-primary !py-2 text-[13.5px]">去练一组题</button>} /></div> : <div className="mt-5 space-y-6">
      {grouped.map(([name, group]) => <section key={name}><div className="mb-2.5 flex items-center gap-2"><h2 className="text-[15.5px] font-semibold text-ink">{name}</h2><span className="rounded bg-brand-danger/10 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-brand-danger">{group.length}</span></div><div className="space-y-2.5">{group.map((item) => <WrongCard key={item.id} item={item} categoryName={categoryOf(item)} sourcePath={item.resourceId ? sourcePaths.get(item.resourceId) ?? null : null} onChange={change} onRemove={(id) => void remove(id)} />)}</div></section>)}
    </div>}

    {mastered.length > 0 && <div className="mt-8"><button type="button" onClick={() => setShowMastered((value) => !value)} className="flex w-full items-center justify-between rounded-[12px] border border-hairline bg-card-warm/70 px-4 py-2.5 text-[13px] text-ink-2 hover:border-brand/40"><span className="inline-flex items-center gap-1.5"><BadgeCheck size={14} className="text-brand" />已经拿下的 {mastered.length} 题</span><ChevronDown size={15} className={cn('transition-transform', showMastered && 'rotate-180')} /></button>{showMastered && <div className="lf-anim-in-up mt-2 space-y-1.5">{mastered.map((item) => <div key={item.id} className="flex items-center gap-2 rounded-[10px] border border-hairline bg-paper px-3 py-2"><BadgeCheck size={14} className="shrink-0 text-brand" /><span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{item.stem}</span><button type="button" onClick={async () => { try { change(await api.updateWrongAnswer(item.id, { mastered: false, reviewStatus: 'reviewing' })); } catch (reason) { toast.error(reason instanceof Error ? reason.message : '状态更新失败'); } }} className="shrink-0 text-[11.5px] text-ink-muted hover:text-brand">放回错题本</button></div>)}</div>}</div>}
  </div>;
}



