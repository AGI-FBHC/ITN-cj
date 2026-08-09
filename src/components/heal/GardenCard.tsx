/**
 * GardenCard — 「我的园子」
 *
 * 保留旧前端的成长隐喻与视觉设计，但园子的状态全部由真实后端数据派生：
 * 已学资源推动树成长，完成整章结成果实，后端错题成为待补水内容。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { BookOpenCheck, ChevronDown, Droplets, Sun } from 'lucide-react';
import KnowledgeTree from '@/components/growth/KnowledgeTree';
import { LeafSmall } from '@/components/heal/Flora';
import { TREE_STAGES } from '@/context/GrowthContext';
import { useNotes } from '@/context/NotesContext';
import { api } from '@/lib/api';
import type { Course, LearningResourceSummary, WrongAnswerRecord } from '@/lib/api';

interface GardenCardProps {
  course: Course;
  resources: LearningResourceSummary[];
}

function stageFromProgress(progress: number, learnedCount: number): number {
  if (progress >= 100) return 4;
  if (progress >= 60) return 3;
  if (progress >= 25) return 2;
  if (learnedCount > 0) return 1;
  return 0;
}

export default function GardenCard({ course, resources }: GardenCardProps) {
  const { notes } = useNotes();
  const [wrongAnswers, setWrongAnswers] = useState<WrongAnswerRecord[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.listWrongAnswers()
      .then(({ items }) => { if (!cancelled) setWrongAnswers(items ?? []); })
      .catch(() => { if (!cancelled) setWrongAnswers([]); });
    return () => { cancelled = true; };
  }, []);

  const learned = resources.filter((resource) => resource.learned);
  const progress = resources.length ? Math.round(learned.length / resources.length * 100) : 0;
  const stage = stageFromProgress(progress, learned.length);
  const fruits = useMemo(() => course.chapters
    .filter((chapter) => {
      const chapterResources = resources.filter((resource) => resource.chapterId === chapter.id);
      return chapterResources.length > 0 && chapterResources.every((resource) => resource.learned);
    })
    .map((chapter) => ({ kpId: chapter.id, name: chapter.title })), [course.chapters, resources]);
  const thirsty = wrongAnswers.filter((item) => !item.mastered);
  const nextStage = TREE_STAGES[Math.min(stage + 1, TREE_STAGES.length - 1)];

  return (
    <div className="lf-card lf-glow-card relative p-5">
      <LeafSmall className="pointer-events-none absolute -top-3.5 right-8 h-[28px] w-[42px]" />

      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h3 className="font-serif text-[16.5px] font-semibold text-ink">我的园子</h3>
        <span className="font-mono text-[10.5px] text-ink-muted">结出 {fruits.length}/{course.chapters.length} 个章节果实</span>
      </div>
      <p className="mb-3 text-[12px] leading-[19px] text-ink-muted">
        每学完一份真实课程资源，园子都会长大一点；完成整章会结成果实，错题则会成为需要补水的植物。
      </p>

      <div className="grid items-center gap-4 sm:grid-cols-2">
        <KnowledgeTree stage={stage} fruits={fruits} size={180} />
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="relative flex h-14 w-14 items-center justify-center rounded-full border-2 border-brand-amber bg-brand-amber-tint">
              <Sun size={15} className="absolute top-1.5 text-ochre/70" />
              <span className="mt-3 font-display text-[18px] font-semibold text-ochre">{learned.length}</span>
            </div>
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium text-ink">真实学习养分 {learned.length}</div>
              <div className="text-[11.5px] leading-[16px] text-ink-muted">来自后端记录的已学讲义、实操与分阶题</div>
            </div>
          </div>

          <Link to="/learn" className="lf-btn-primary flex w-full !py-2 text-[13.5px]">
            <Droplets size={15} /> 去学习，继续滋养园子
          </Link>

          <div>
            <div className="mb-1 flex justify-between text-[11px] text-ink-muted">
              <span>{TREE_STAGES[stage].name}{stage >= 4 ? ' · 已长成' : ` → ${nextStage.name}`}</span>
              <span className="font-mono">{progress}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-paper-deep">
              <div className="h-full rounded-full bg-brand transition-all duration-700" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>
      </div>

      {thirsty.length > 0 ? (
        <div className="mt-4 rounded-[14px] border border-brand-amber/40 bg-brand-amber-tint/40 p-3">
          <div className="mb-2 text-[12.5px] font-medium text-ochre">
            有 {thirsty.length} 株知识植物需要补水，重做错题就能让它恢复
          </div>
          <div className="space-y-1.5">
            {thirsty.slice(0, 3).map((item) => (
              <div key={item.id} className="flex items-center gap-2.5 rounded-[11px] bg-paper/70 px-2.5 py-2">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-4 border-brand-amber/40 font-mono text-[10px] font-semibold text-ochre">
                  {item.reviewCount}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-ink">{item.stem}</div>
                  <div className="text-[10.5px] text-ink-muted">{item.knowledgeCategoryName || item.kpId || '课程错题'} · 已复习 {item.reviewCount} 次</div>
                </div>
                <Link to="/me/wrong" className="lf-btn-primary shrink-0 !rounded-[11px] !px-3 !py-1.5 !text-[12.5px]">去补水</Link>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-3 rounded-[12px] bg-paper/60 px-3 py-2 text-[12px] text-ink-muted">
          暂时没有待复习错题。继续按自己的节奏学习就好。
        </p>
      )}

      <button type="button" onClick={() => setDetailOpen((value) => !value)} className="mt-3 flex w-full items-center justify-between border-t border-hairline/60 pt-2 text-[11.5px] text-ink-muted transition-colors hover:text-ink">
        看细节：园子的数据从哪里来
        <ChevronDown size={13} className={`transition-transform ${detailOpen ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {detailOpen && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="grid gap-2 pt-3 sm:grid-cols-3">
              <div className="rounded-[11px] bg-paper px-3 py-2.5"><BookOpenCheck size={14} className="text-brand" /><div className="mt-1 font-display text-[18px] font-semibold text-ink">{learned.length}</div><div className="text-[11px] text-ink-muted">已学资源</div></div>
              <div className="rounded-[11px] bg-paper px-3 py-2.5"><Sun size={14} className="text-ochre" /><div className="mt-1 font-display text-[18px] font-semibold text-ink">{fruits.length}</div><div className="text-[11px] text-ink-muted">完成章节</div></div>
              <div className="rounded-[11px] bg-paper px-3 py-2.5"><Droplets size={14} className="text-brand" /><div className="mt-1 font-display text-[18px] font-semibold text-ink">{notes.length}</div><div className="text-[11px] text-ink-muted">后端笔记</div></div>
            </div>
            <p className="mt-2 text-[11px] leading-[17px] text-ink-muted">这些数字来自课程资源、学习状态、错题和笔记接口，不再使用旧前端预置的六知识点成长数据。</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
