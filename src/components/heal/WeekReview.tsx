/** 本周回顾：保留旧版“只讲长进，不算欠账”的设计，统计真实学习记录。 */
import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { LeafSmall } from '@/components/heal/Flora';
import { useNotes } from '@/context/NotesContext';
import { useCourseLearning } from '@/hooks/useCourseLearning';
import { api } from '@/lib/api';

const WEEK = 7 * 24 * 60 * 60 * 1000;

export default function WeekReview() {
  const learning = useCourseLearning();
  const { notes } = useNotes();
  const [wrongReviewed, setWrongReviewed] = useState(0);

  useEffect(() => {
    const since = Date.now() - WEEK;
    api.listWrongAnswers()
      .then(({ items }) => setWrongReviewed((items ?? []).filter((item) => item.reviewCount > 0 && new Date(item.updatedAt).getTime() >= since).length))
      .catch(() => setWrongReviewed(0));
  }, []);

  const stats = useMemo(() => {
    const since = Date.now() - WEEK;
    return {
      learned: learning.resources.filter((item) => item.learnedAt && new Date(item.learnedAt).getTime() >= since).length,
      notes: notes.filter((note) => note.createdAt && new Date(note.createdAt).getTime() >= since).length,
      reviewed: wrongReviewed,
    };
  }, [learning.resources, notes, wrongReviewed]);

  if (learning.loading || (stats.learned === 0 && stats.notes === 0 && stats.reviewed === 0)) return null;
  const lines = [
    stats.learned > 0 ? `学完 ${stats.learned} 份课程资源` : '',
    stats.notes > 0 ? `留下 ${stats.notes} 笔知识记录` : '',
    stats.reviewed > 0 ? `回头复习 ${stats.reviewed} 道错题` : '',
  ].filter(Boolean);

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.3 }} className="lf-card relative overflow-hidden p-5">
      <LeafSmall className="pointer-events-none absolute -top-3 right-6 h-[26px] w-[38px]" />
      <div className="flex items-center gap-2"><Sparkles size={15} className="text-ochre" /><h3 className="font-serif text-[15.5px] font-semibold text-ink">这一周，你长出了这些</h3></div>
      <p className="mt-2 text-[13.5px] leading-[23px] text-ink-2">{lines.join('、')}。</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {[['学习资源', stats.learned], ['笔记', stats.notes], ['复习错题', stats.reviewed]].map(([label, value]) => (
          <span key={label as string} className="rounded-[10px] border border-hairline bg-paper px-2.5 py-1.5"><span className="font-display text-[15px] font-semibold text-brand">{value as number}</span><span className="ml-1 text-[11.5px] text-ink-muted">{label as string}</span></span>
        ))}
      </div>
      <p className="mt-3 text-[11.5px] leading-[18px] text-ink-muted">这里只记后端确认过的学习动作——没做的不会被算账。慢一点也没关系。</p>
    </motion.div>
  );
}
