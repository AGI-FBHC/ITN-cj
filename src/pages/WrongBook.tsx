import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import PageBack from '@/components/PageBack';
import { api } from '@/lib/api';
import type { WrongAnswerRecord } from '@/lib/api';

const letters = ['A', 'B', 'C', 'D', 'E', 'F'];

export default function WrongBook() {
  const [items, setItems] = useState<WrongAnswerRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.listWrongAnswers()
      .then((result) => setItems(result.items ?? []))
      .catch((reason) => toast.error(reason instanceof Error ? reason.message : '错题读取失败'))
      .finally(() => setLoading(false));
  }, []);

  const setMastered = async (item: WrongAnswerRecord, mastered: boolean) => {
    try {
      const updated = await api.updateWrongAnswer(item.id, { mastered, reviewStatus: mastered ? 'mastered' : 'unreviewed' });
      setItems((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : '错题状态更新失败'); }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteWrongAnswer(id);
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : '错题删除失败'); }
  };

  const active = items.filter((item) => !item.mastered);
  const mastered = items.filter((item) => item.mastered);

  return (
    <div className="mx-auto max-w-[860px] px-5 pb-24 pt-8 md:px-6">
      <PageBack parent={{ label: '我的学习', to: '/me' }} current="错题本" />
      <div className="flex items-center gap-4"><span className="flex h-12 w-12 items-center justify-center rounded-[12px] border border-brand-danger/25 bg-brand-danger/10"><X size={22} className="text-brand-danger" /></span><div><h1 className="font-serif text-[24px] font-semibold text-ink">错题本</h1><p className="mt-0.5 text-[13px] text-ink-muted">真实答题回写 · 待复习 {active.length} 题 · 已掌握 {mastered.length} 题</p></div></div>

      {loading ? <div className="mt-6 lf-card p-8 text-center text-[13px] text-ink-muted">正在读取后端错题记录…</div> : !items.length ? <div className="mt-6 lf-card p-8 text-center"><h2 className="text-[17px] font-semibold text-ink">还没有真实错题记录</h2><p className="mt-2 text-[13px] text-ink-muted">在课程分阶题中答错后，题目会由后端自动收录到这里。</p><Link to="/tutoring" className="lf-btn-primary mt-4 inline-flex">去做分阶题</Link></div> : <div className="mt-6 space-y-3">{items.map((item) => <article key={item.id} className={`lf-card p-5 ${item.mastered ? 'opacity-65' : ''}`}>
        <div className="flex flex-wrap items-center gap-2"><span className="rounded bg-brand-danger/10 px-2 py-0.5 text-[10.5px] text-brand-danger">{item.difficulty}</span>{item.knowledgeCategoryName && <span className="rounded bg-paper-deep px-2 py-0.5 text-[10.5px] text-ink-muted">{item.knowledgeCategoryName}</span>}<span className="ml-auto font-mono text-[10px] text-ink-muted">{new Date(item.updatedAt).toLocaleString('zh-CN')}</span></div>
        <h2 className="mt-3 text-[14px] font-semibold leading-6 text-ink">{item.stem}</h2>
        <div className="mt-3 space-y-1.5">{item.options.map((option, index) => <div key={index} className={`rounded-[9px] border px-3 py-2 text-[12.5px] ${index === item.correctAnswer ? 'border-brand bg-brand-tint text-brand' : index === item.userAnswer ? 'border-brand-danger bg-brand-danger/5 text-brand-danger' : 'border-hairline text-ink-muted'}`}><span className="mr-2 font-mono text-[10px]">{letters[index]}.</span>{option}{index === item.correctAnswer && <span className="ml-2 text-[10px]">正确答案</span>}{index === item.userAnswer && index !== item.correctAnswer && <span className="ml-2 text-[10px]">你的答案</span>}</div>)}</div>
        {item.explanation && <p className="mt-3 rounded-[9px] bg-card-warm px-3 py-2 text-[12.5px] leading-5 text-ink-2">{item.explanation}</p>}
        <div className="mt-3 flex items-center gap-2 border-t border-hairline pt-3"><button type="button" onClick={() => void setMastered(item, !item.mastered)} className="lf-btn-ghost !px-3 !py-1.5 !text-[12px]"><BadgeCheck size={13} />{item.mastered ? '移回待复习' : '标记已掌握'}</button><button type="button" onClick={() => void remove(item.id)} className="ml-auto inline-flex items-center gap-1 text-[12px] text-ink-muted hover:text-brand-danger"><Trash2 size={13} />删除</button></div>
      </article>)}</div>}
    </div>
  );
}
