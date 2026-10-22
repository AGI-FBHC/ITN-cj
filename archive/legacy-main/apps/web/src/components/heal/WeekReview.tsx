/**
 * WeekReview — 本周回顾（去焦虑版）
 *
 * 刻意不做的事：不算「欠了几天」、不显示断签、没有红叉、没有连胜压力。
 * 只讲这一周**长出了什么**——学了几段、记了几笔、攒了多少养分、错题拿下几道。
 * 一周内没有任何动作时不出现，避免变成"你什么都没做"的指责。
 */
import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { useGrowth } from '@/context/GrowthContext';
import { useNotes } from '@/context/NotesContext';
import { useWrongBook } from '@/context/WrongBookContext';
import { useReview } from '@/context/ReviewContext';
import { DAY_MS } from '@/data/forgetting';
import { LeafSmall } from '@/components/heal/Flora';

/** 本周回顾的提醒语：按各项真实动作加权打分，分数越高鼓励越具体（前端静态判断，不依赖后端） */
function weekEncouragement(score: number): string {
  if (score >= 40) return '这股劲儿很稳——本周的每一步都在替你攒能力。';
  if (score >= 20) return '节奏已经在形成了，保持住，比昨天多一步就好。';
  if (score >= 10) return '正在往前走——慢一点没关系，方向对了就行。';
  if (score >= 5) return '开了一个好头，下次再多做一件就更好。';
  return '只要动起来，就比停在原地多走了一步。';
}

/** 「x 天前」样式的时间串 → 是否落在最近 7 天内（GrowthContext 的 log.time 是 HH:MM 形式，故按条数兜底） */
export default function WeekReview() {
  const { log, watered, fruits } = useGrowth();
  const { notes } = useNotes();
  const { mastered } = useWrongBook();
  const { items: reviewItems } = useReview();

  const stat = useMemo(() => {
    const since = Date.now() - 7 * DAY_MS;
    /* 笔记带完整时间戳（id 里含创建时刻），按 id 解析 */
    const weekNotes = notes.filter((n) => {
      const m = /^n-([a-z0-9]+)-/.exec(n.id);
      if (!m) return false;
      const t = parseInt(m[1], 36);
      return Number.isFinite(t) && t >= since;
    });
    /* 本周复习过的知识点（lastAt 在 7 天内） */
    const reviewed = reviewItems.filter((i) => i.lastAt >= since);
    /* 养分明细条数近似本周学习动作数 */
    const actions = log.length;
    return {
      notes: weekNotes.length,
      qa: weekNotes.filter((n) => n.sourceKind === 'qa').length,
      reviewed: reviewed.length,
      mastered: mastered.length,
      actions,
      watered,
      fruits: fruits.length,
      /* 动作权重：学习动作 1 · 笔记 2 · 复习 3 · 攻克错题 4 · 园子结果 2 */
      score: actions + weekNotes.length * 2 + reviewed.length * 3 + mastered.length * 4 + fruits.length * 2,
    };
  }, [notes, reviewItems, mastered, log, watered, fruits]);

  /* 一周内毫无动作 → 不出现（不做"你什么都没做"的提醒） */
  const hasSomething = stat.notes > 0 || stat.reviewed > 0 || stat.mastered > 0 || stat.actions > 0;
  if (!hasSomething) return null;

  const lines: string[] = [];
  if (stat.reviewed > 0) lines.push(`回头复习了 ${stat.reviewed} 个知识点`);
  if (stat.notes > 0) lines.push(`记下 ${stat.notes} 笔`);
  if (stat.qa > 0) lines.push(`问了 ${stat.qa} 个问题`);
  if (stat.mastered > 0) lines.push(`拿下 ${stat.mastered} 道以前做错的题`);
  if (stat.fruits > 0) lines.push(`园子里结了 ${stat.fruits} 个果`);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="lf-card relative overflow-hidden p-5"
    >
      <LeafSmall className="pointer-events-none absolute -top-3 right-6 h-[26px] w-[38px]" />
      <div className="flex items-center gap-2">
        <Sparkles size={15} className="text-ochre" />
        <h3 className="font-serif text-[15.5px] font-semibold text-ink">这一周，你长出了这些</h3>
      </div>

      <p className="mt-2 text-[13.5px] leading-[23px] text-ink-2">
        {lines.length > 0 ? lines.join('、') + '。' : weekEncouragement(stat.score)}
      </p>
      {lines.length > 0 && (
        <p className="mt-1 text-[12.5px] font-medium text-brand/85">{weekEncouragement(stat.score)}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {[
          ['学习动作', stat.actions],
          ['笔记', stat.notes],
          ['复习', stat.reviewed],
          ['攻克错题', stat.mastered],
        ].map(([label, v]) => (
          <span key={label as string} className="rounded-[10px] border border-hairline bg-paper px-2.5 py-1.5">
            <span className="font-display text-[15px] font-semibold text-brand tabular">{v as number}</span>
            <span className="ml-1 text-[11.5px] text-ink-muted">{label as string}</span>
          </span>
        ))}
      </div>

      <p className="mt-3 text-[11.5px] leading-[18px] text-ink-muted">
        这里只记你做过的事——没做的那些不会被算账。慢一点也没关系。
      </p>
    </motion.div>
  );
}
