/**
 * MyNotes `/me/notes` — 个人知识库
 * 学习者自己的"知识切片"：课件随手记自动汇入（带来源与 KB 溯源），也可手动添加；
 * 按知识点分组，可回跳课件原文；与领域知识库(kbSlices)形成"系统记忆 vs 个人记忆"的对照叙事。
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, NotebookPen, Plus, Trash2, CornerDownRight, Check, Hand } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { useNotes } from '@/context/NotesContext';
import { knowledgePoints } from '@/data/knowledgePoints';
import TraceBadge from '@/components/TraceBadge';
import PageBack from '@/components/PageBack';
import GardenEmpty from '@/components/heal/GardenEmpty';
import { cn } from '@/lib/utils';

export default function MyNotes() {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const { notes, addNote, deleteNote, countByKp } = useNotes();
  const [adding, setAdding] = useState(false);
  const [draftKp, setDraftKp] = useState(knowledgePoints[0].id);
  const [draftText, setDraftText] = useState('');

  const grouped = useMemo(() => {
    return knowledgePoints
      .map((kp) => ({ kp, list: notes.filter((n) => n.kpId === kp.id) }))
      .filter((g) => g.list.length > 0);
  }, [notes]);

  const coveredKps = Object.keys(countByKp).length;

  const submit = () => {
    const text = draftText.trim();
    if (!text) return;
    addNote({ kpId: draftKp, text, source: '手动添加', sourceKind: 'manual', kbRefs: [] });
    setDraftText('');
    setAdding(false);
  };

  return (
    <div className="mx-auto max-w-[840px] px-5 pb-24 pt-8 md:px-6">
      {/* 页头 */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
        <PageBack parent={{ label: '我的学习', to: '/me' }} current="个人知识库" />
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <span className="flex h-12 w-12 items-center justify-center rounded-[12px] border border-brand/25 bg-brand-tint">
            <NotebookPen size={22} className="text-brand" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="font-serif text-[24px] font-semibold text-ink">个人知识库</h1>
            <p className="mt-0.5 text-[13px] text-ink-muted">
              {currentLearner.name} 的知识切片 · {notes.length} 条笔记 · 覆盖 {coveredKps} 个知识点 · 每条都回流给阿诊
            </p>
          </div>
          <button type="button" onClick={() => setAdding((v) => !v)} className="lf-btn-ghost !px-4 !py-2 text-[13px]">
            <Plus size={14} />
            手动添加
          </button>
        </div>
      </motion.div>

      {/* 手动添加 */}
      {adding && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="lf-card mt-5 p-4">
          <div className="lf-mono-label mb-2 !text-[10.5px]">知识点归属</div>
          <div className="flex flex-wrap gap-1.5">
            {knowledgePoints.map((kp) => (
              <button
                key={kp.id}
                type="button"
                onClick={() => setDraftKp(kp.id)}
                className={cn(
                  'rounded-lg border px-2.5 py-1 text-[12.5px] font-medium transition-all',
                  draftKp === kp.id ? 'border-brand bg-brand-tint text-brand' : 'border-hairline bg-paper text-ink-2 hover:border-brand/40',
                )}
              >
                {draftKp === kp.id && <Check size={11} className="mr-1 inline" />}
                {kp.name}
              </button>
            ))}
          </div>
          <textarea
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            rows={3}
            placeholder="记下你的理解、口诀、现场经验…"
            className="mt-3 w-full resize-none rounded-[10px] border border-hairline bg-paper px-3 py-2 text-[13.5px] leading-[21px] text-ink outline-none focus:border-brand/50"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className="rounded-md px-3 py-1.5 text-[13px] text-ink-muted hover:text-ink">取消</button>
            <button
              type="button"
              disabled={!draftText.trim()}
              onClick={submit}
              className={cn('rounded-[10px] px-4 py-1.5 text-[13px] font-medium', draftText.trim() ? 'bg-brand text-paper hover:bg-brand-hover' : 'bg-paper-deep text-ink-muted/50')}
            >
              存入知识库
            </button>
          </div>
        </motion.div>
      )}

      {/* 空态 · 待耕耘的花园 */}
      {notes.length === 0 && !adding && (
        <div className="lf-card mt-6">
          <GardenEmpty
            scene="plot"
            title="这片园子还空着"
            hint="去课件里学一讲吧——每个段落下都能随手记一笔，它们会在这里慢慢长成你自己的知识库。"
            action={
              <button type="button" onClick={() => navigate('/learn')} className="lf-btn-primary !py-2 text-[13.5px]">
                去学习 <ArrowRight size={14} />
              </button>
            }
          />
        </div>
      )}

      {/* 分组列表 */}
      <div className="mt-6 space-y-6">
        {grouped.map(({ kp, list }) => (
          <section key={kp.id}>
            <div className="mb-2.5 flex items-center gap-2">
              <h2 className="text-[15.5px] font-semibold text-ink">{kp.name}</h2>
              <span className="rounded bg-brand-tint px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-brand">{list.length}</span>
              <button
                type="button"
                onClick={() => navigate(`/learn/${kp.id}`)}
                className="ml-auto inline-flex items-center gap-1 text-[12px] text-ink-muted hover:text-brand"
              >
                去学这个知识点 <ArrowRight size={11} />
              </button>
            </div>
            <div className="space-y-2.5">
              {list.map((n) => (
                <div key={n.id} className={cn('lf-card group p-4', n.sourceKind === 'qa' && 'border-l-[3px] border-l-brand-amber/60')}>
                  {n.sourceKind === 'qa' && (
                    <div className="mb-1.5 inline-flex items-center gap-1 rounded-md bg-brand-amber-tint/60 px-1.5 py-0.5 text-[10.5px] font-medium text-ochre">
                      <Hand size={10} /> 我问过的
                    </div>
                  )}
                  <p className="whitespace-pre-line text-[13.5px] leading-[22px] text-ink-2">{n.text}</p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-hairline/60 pt-2">
                    {n.blockAnchor ? (
                      <button
                        type="button"
                        onClick={() => navigate(`/learn/${n.kpId}?block=${n.blockAnchor!.replace(`${n.kpId}-`, '')}`)}
                        className="inline-flex items-center gap-1 font-mono text-[10.5px] text-brand hover:underline"
                      >
                        <CornerDownRight size={10} />
                        {n.source}
                      </button>
                    ) : (
                      <span className="font-mono text-[10.5px] text-ink-muted">{n.source}</span>
                    )}
                    {n.kbRefs.map((id) => (
                      <TraceBadge key={id} kbId={id} />
                    ))}
                    <span className="font-mono text-[10px] text-ink-muted/70">{n.time}</span>
                    <button
                      type="button"
                      onClick={() => deleteNote(n.id)}
                      title="删除"
                      className="ml-auto text-ink-muted/50 opacity-0 transition-opacity hover:text-brand-danger group-hover:opacity-100"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
