/**
 * NotesContext — 个人知识库（学习者自己的"知识切片"）
 * 课件内随手记 / 知识库页手动添加；笔记自动携带来源（单元/块标题）与 KB 溯源；
 * 每条笔记回流 note-taken 信号（阿诊置信度 + 决策日志），按学习者分桶持久化。
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { useProfile } from '@/context/ProfileContext';
import { useAgent } from '@/context/AgentContext';
import { getKnowledgePoint } from '@/data/knowledgePoints';

export interface Note {
  id: string;
  kpId: string;
  text: string;
  /** 来源：课件块标题 / 手动 */
  source: string;
  /** qa = 课堂提问沉淀（你问过什么本身就是学情） */
  sourceKind: 'course' | 'manual' | 'qa';
  /** 深链回课件 */
  blockAnchor?: string;
  kbRefs: string[];
  time: string;
}

interface NotesContextValue {
  /** 当前学习者的笔记（新→ 旧） */
  notes: Note[];
  addNote: (n: Omit<Note, 'id' | 'time'>) => void;
  deleteNote: (id: string) => void;
  countByKp: Record<string, number>;
}

const NotesContext = createContext<NotesContextValue | null>(null);
const K_NOTES = 'lf.notes';

let seq = 0;
const nid = () => `n-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function NotesProvider({ children }: { children: ReactNode }) {
  const { currentLearnerId } = useProfile();
  const { pushSignal } = useAgent();
  const [all, setAll] = useState<Record<string, Note[]>>(() => {
    try {
      const raw = window.localStorage.getItem(K_NOTES);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try { window.localStorage.setItem(K_NOTES, JSON.stringify(all)); } catch { /* ignore */ }
  }, [all]);

  const value = useMemo<NotesContextValue>(() => {
    const notes = all[currentLearnerId] ?? [];
    const countByKp: Record<string, number> = {};
    notes.forEach((n) => { countByKp[n.kpId] = (countByKp[n.kpId] ?? 0) + 1; });

    const addNote = (n: Omit<Note, 'id' | 'time'>) => {
      const note: Note = {
        ...n,
        id: nid(),
        time: new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
      };
      setAll((prev) => ({ ...prev, [currentLearnerId]: [note, ...(prev[currentLearnerId] ?? [])].slice(0, 200) }));
      pushSignal({ type: 'note-taken', kpId: n.kpId, title: n.source });
      toast.success('已存入个人知识库', {
        description: `「${getKnowledgePoint(n.kpId).name}」笔记 +1 · 阿诊已记录`,
      });
    };

    const deleteNote = (id: string) => {
      setAll((prev) => ({ ...prev, [currentLearnerId]: (prev[currentLearnerId] ?? []).filter((x) => x.id !== id) }));
    };

    return { notes, addNote, deleteNote, countByKp };
  }, [all, currentLearnerId, pushSignal]);

  return <NotesContext.Provider value={value}>{children}</NotesContext.Provider>;
}

export function useNotes(): NotesContextValue {
  const ctx = useContext(NotesContext);
  if (!ctx) throw new Error('useNotes must be used within NotesProvider');
  return ctx;
}
