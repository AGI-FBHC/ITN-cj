import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { useProfile } from '@/context/ProfileContext';
import { useAgent } from '@/context/AgentContext';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import type { LearningNoteRecord } from '@/lib/api';
import { parseApiInstant } from '@/lib/utils';

export interface Note {
  id: string;
  kpId: string;
  text: string;
  source: string;
  sourceKind: 'course' | 'manual' | 'qa';
  blockAnchor?: string;
  kbRefs: string[];
  time: string;
  /** 后端记录时间，供周回顾等真实时间统计使用。 */
  createdAt?: string;
}

interface NotesContextValue {
  notes: Note[];
  addNote: (note: Omit<Note, 'id' | 'time'>) => void;
  deleteNote: (id: string) => void;
  countByKp: Record<string, number>;
}

const NotesContext = createContext<NotesContextValue | null>(null);

function toNote(record: LearningNoteRecord): Note {
  const sourceKind = record.sourceKind === 'qa' || record.sourceKind === 'course' ? record.sourceKind : 'manual';
  return {
    id: record.id,
    kpId: record.kpId ?? 'uncategorized',
    text: record.content,
    source: record.sourceContext || record.title,
    sourceKind,
    blockAnchor: record.sourceRef ?? undefined,
    kbRefs: record.kbRefs ?? [],
    time: (parseApiInstant(record.updatedAt) ?? new Date()).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    createdAt: record.createdAt,
  };
}

export function NotesProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const { currentLearnerId } = useProfile();
  const { pushSignal } = useAgent();
  const [notes, setNotes] = useState<Note[]>([]);

  const reloadNotes = () => {
    if (!session?.token) return;
    void api.listNotes()
      .then(({ notes: records }) => setNotes(records.map(toNote)))
      .catch(() => undefined);
  };

  useEffect(() => {
    if (!session?.token) {
      setNotes([]);
      return undefined;
    }
    let cancelled = false;
    api.listNotes()
      .then(({ notes: records }) => { if (!cancelled) setNotes(records.map(toNote)); })
      .catch(() => { if (!cancelled) setNotes([]); });
    return () => { cancelled = true; };
  }, [currentLearnerId, session?.token]);

  useEffect(() => {
    const onAssistantNoteSaved = () => reloadNotes();
    window.addEventListener('itn:assistant-note-saved', onAssistantNoteSaved);
    return () => window.removeEventListener('itn:assistant-note-saved', onAssistantNoteSaved);
    // reloadNotes intentionally follows the active auth/profile values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLearnerId, session?.token]);

  const value = useMemo<NotesContextValue>(() => {
    const countByKp: Record<string, number> = {};
    notes.forEach((note) => { countByKp[note.kpId] = (countByKp[note.kpId] ?? 0) + 1; });

    const addNote = (note: Omit<Note, 'id' | 'time'>) => {
      void api.createNote({
        title: note.source || '学习笔记', content: note.text,
        kpId: note.kpId, sourceKind: note.sourceKind, sourceType: note.sourceKind,
        sourceRef: note.blockAnchor, sourceContext: note.source, kbRefs: note.kbRefs,
      }).then((created) => {
        setNotes((current) => [toNote(created), ...current.filter((item) => item.id !== created.id)]);
        pushSignal({ type: 'note-taken', kpId: note.kpId, title: note.source });
        toast.success('已保存到我的笔记');
      }).catch((reason) => toast.error(reason instanceof Error ? reason.message : '笔记保存失败'));
    };

    const deleteNote = (id: string) => {
      void api.deleteNote(id)
        .then(() => setNotes((current) => current.filter((note) => note.id !== id)))
        .catch((reason) => toast.error(reason instanceof Error ? reason.message : '笔记删除失败'));
    };

    return { notes, addNote, deleteNote, countByKp };
  }, [currentLearnerId, notes, pushSignal]);

  return <NotesContext.Provider value={value}>{children}</NotesContext.Provider>;
}

export function useNotes(): NotesContextValue {
  const context = useContext(NotesContext);
  if (!context) throw new Error('useNotes must be used within NotesProvider');
  return context;
}
