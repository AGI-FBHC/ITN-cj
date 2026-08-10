import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, NotebookPen, Plus, Trash2 } from 'lucide-react';
import PageBack from '@/components/PageBack';
import { useNotes } from '@/context/NotesContext';
import { useProfile } from '@/context/ProfileContext';
import { cn } from '@/lib/utils';

export default function MyNotes() {
  const { currentLearner, domainKnowledgePoints } = useProfile();
  const { notes, addNote, deleteNote } = useNotes();
  const [adding, setAdding] = useState(false);
  const [draftKp, setDraftKp] = useState(domainKnowledgePoints[0]?.id ?? 'uncategorized');
  const [draftText, setDraftText] = useState('');

  useEffect(() => {
    if (draftKp === 'uncategorized' && domainKnowledgePoints[0]) setDraftKp(domainKnowledgePoints[0].id);
  }, [domainKnowledgePoints, draftKp]);

  const nameById = useMemo(() => new Map(domainKnowledgePoints.map((point) => [point.id, point.name])), [domainKnowledgePoints]);
  const groups = useMemo(() => {
    const grouped = new Map<string, typeof notes>();
    notes.forEach((note) => grouped.set(note.kpId, [...(grouped.get(note.kpId) ?? []), note]));
    return [...grouped.entries()];
  }, [notes]);

  const submit = () => {
    const text = draftText.trim();
    if (!text) return;
    addNote({ kpId: draftKp, text, source: '手动添加', sourceKind: 'manual', kbRefs: [] });
    setDraftText('');
    setAdding(false);
  };

  return (
    <div className="mx-auto max-w-[860px] px-5 pb-24 pt-8 md:px-6">
      <PageBack parent={{ label: '我的学习', to: '/me' }} current="个人知识库" />
      <div className="flex flex-wrap items-center gap-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-[12px] border border-brand/25 bg-brand-tint"><NotebookPen size={22} className="text-brand" /></span>
        <div className="min-w-0 flex-1"><h1 className="font-serif text-[24px] font-semibold text-ink">个人知识库</h1><p className="mt-0.5 text-[13px] text-ink-muted">{currentLearner.name} · 后端已保存 {notes.length} 条笔记</p></div>
        <button type="button" onClick={() => setAdding((value) => !value)} className="lf-btn-ghost !px-4 !py-2 text-[13px]"><Plus size={14} />手动添加</button>
      </div>

      {adding && <div className="lf-card mt-5 p-4">
        <div className="mb-2 text-[12px] text-ink-muted">知识维度</div>
        <div className="flex flex-wrap gap-1.5">{domainKnowledgePoints.map((point) => <button key={point.id} type="button" onClick={() => setDraftKp(point.id)} className={cn('rounded-lg border px-2.5 py-1 text-[12.5px]', draftKp === point.id ? 'border-brand bg-brand-tint text-brand' : 'border-hairline bg-paper text-ink-2')}>{draftKp === point.id && <Check size={11} className="mr-1 inline" />}{point.name}</button>)}</div>
        <textarea value={draftText} onChange={(event) => setDraftText(event.target.value)} rows={4} placeholder="记录你的理解、疑问或总结…" className="mt-3 w-full resize-none rounded-[10px] border border-hairline bg-paper px-3 py-2 text-[13.5px] leading-6 text-ink outline-none focus:border-brand/50" />
        <div className="mt-2 flex justify-end gap-2"><button type="button" onClick={() => setAdding(false)} className="lf-btn-ghost">取消</button><button type="button" disabled={!draftText.trim()} onClick={submit} className="lf-btn-primary disabled:opacity-50">保存到后端</button></div>
      </div>}

      {!notes.length && !adding && <div className="lf-card mt-6 p-8 text-center"><h2 className="text-[17px] font-semibold text-ink">还没有已保存的笔记</h2><p className="mt-2 text-[13px] text-ink-muted">手动记录一条，或在学习内容中沉淀笔记。</p><Link to="/resources" className="lf-btn-primary mt-4 inline-flex">去学习资源</Link></div>}

      <div className="mt-6 space-y-6">{groups.map(([kpId, items]) => <section key={kpId}>
        <div className="mb-2 flex items-center gap-2"><h2 className="text-[15px] font-semibold text-ink">{nameById.get(kpId) ?? '未分类'}</h2><span className="rounded bg-brand-tint px-1.5 py-0.5 font-mono text-[10px] text-brand">{items.length}</span></div>
        <div className="space-y-2.5">{items.map((note) => <article key={note.id} className="lf-card group p-4"><p className="whitespace-pre-line text-[13.5px] leading-6 text-ink-2">{note.text}</p><div className="mt-2 flex flex-wrap items-center gap-2 border-t border-hairline/60 pt-2 font-mono text-[10.5px] text-ink-muted"><span>{note.source}</span><span>{note.time}</span>{note.kbRefs.map((ref) => <span key={ref} className="rounded bg-paper-deep px-1.5 py-0.5">{ref}</span>)}<button type="button" onClick={() => deleteNote(note.id)} className="ml-auto opacity-0 transition group-hover:opacity-100" title="删除笔记"><Trash2 size={13} /></button></div></article>)}</div>
      </section>)}</div>
    </div>
  );
}
