/**
 * WrongBookContext — 错题本
 *
 * 背景：原先三处作答（分阶题 / 课件检查点 / 导学）都只发一个
 * `quiz-answer: {correct}` 统计信号，题目本身被丢弃——「错了」有记录，
 * 「错在哪、当时选了什么」全没了。这里把它接住。
 *
 * 与遗忘曲线共用一套节奏：错题不是一张静态清单，而是按 e^(-t/S) 排重做——
 * 重做对了间隔变长、错了重置，直到你自己标「已掌握」。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useProfile } from '@/context/ProfileContext';
import { DAY_MS, dueAt, retention } from '@/data/forgetting';

/** 一道错题的作答记录 */
export interface WrongEntry {
  /** 题目 id（quizBank）或课件检查点 id */
  qid: string;
  kpId: string;
  /** 来源：分阶题 / 课件检查点 / 导学 */
  from: 'quiz' | 'checkpoint' | 'tutoring';
  /** 首次答错时间 */
  firstAt: number;
  /** 最近一次重做时间（未重做过 = firstAt） */
  lastAt: number;
  /** 累计答错次数 */
  wrongCount: number;
  /** 连续答对次数（重做对 +1，错了归 0） */
  streak: number;
  /** 最近一次选择的选项下标（-1 = 未知） */
  lastPick: number;
  /** 已标记掌握（不再排复习，但仍留档） */
  mastered: boolean;
  /** 非题库题（课件检查点/导学）自带题面，避免依赖 quizBank */
  inline?: { stem: string; options: string[]; answerIndex: number; analysis?: string; kbRefs?: string[] };
}

export interface WrongItem extends WrongEntry {
  /** 记忆保持率 0~1 */
  retention: number;
  /** 到期时刻 */
  dueAt: number;
  /** 是否该重做了 */
  due: boolean;
}

interface WrongBookContextValue {
  /** 全部错题（未掌握的按最该重做优先） */
  items: WrongItem[];
  /** 该重做的 */
  due: WrongItem[];
  /** 已标记掌握的 */
  mastered: WrongItem[];
  /** 记一道错题（同题重复答错会累加） */
  addWrong: (e: {
    qid: string;
    kpId: string;
    from: WrongEntry['from'];
    pick: number;
    inline?: WrongEntry['inline'];
  }) => void;
  /** 重做结果：对了 streak+1 并延长间隔，错了归零 */
  redo: (qid: string, correct: boolean, pick: number) => void;
  /** 标记 / 取消「已掌握」 */
  setMastered: (qid: string, v: boolean) => void;
  /** 移除一条 */
  remove: (qid: string) => void;
  countByKp: Record<string, number>;
}

const Ctx = createContext<WrongBookContextValue | null>(null);
const K = 'lf.wrongBook';

type Buckets = Record<string, Record<string, WrongEntry>>;

export function WrongBookProvider({ children }: { children: ReactNode }) {
  const { currentLearnerId } = useProfile();
  const [buckets, setBuckets] = useState<Buckets>(() => {
    try {
      const raw = window.localStorage.getItem(K);
      return raw ? (JSON.parse(raw) as Buckets) : {};
    } catch {
      return {};
    }
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    try { window.localStorage.setItem(K, JSON.stringify(buckets)); } catch { /* ignore */ }
  }, [buckets]);

  /* 每 5 分钟重算一次保持率（页面长时间开着时到期状态也会更新） */
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  const patch = useCallback((qid: string, fn: (prev?: WrongEntry) => WrongEntry | null) => {
    setBuckets((all) => {
      const mine = { ...(all[currentLearnerId] ?? {}) };
      const next = fn(mine[qid]);
      if (next === null) delete mine[qid];
      else mine[qid] = next;
      return { ...all, [currentLearnerId]: mine };
    });
  }, [currentLearnerId]);

  const addWrong: WrongBookContextValue['addWrong'] = useCallback(({ qid, kpId, from, pick, inline }) => {
    const now = Date.now();
    patch(qid, (prev) => prev
      ? { ...prev, lastAt: now, wrongCount: prev.wrongCount + 1, streak: 0, lastPick: pick, mastered: false }
      : { qid, kpId, from, firstAt: now, lastAt: now, wrongCount: 1, streak: 0, lastPick: pick, mastered: false, inline });
  }, [patch]);

  const redo: WrongBookContextValue['redo'] = useCallback((qid, correct, pick) => {
    const now = Date.now();
    patch(qid, (prev) => {
      if (!prev) return null;
      return correct
        ? { ...prev, lastAt: now, streak: prev.streak + 1, lastPick: pick }
        : { ...prev, lastAt: now, streak: 0, wrongCount: prev.wrongCount + 1, lastPick: pick };
    });
  }, [patch]);

  const setMastered: WrongBookContextValue['setMastered'] = useCallback((qid, v) => {
    patch(qid, (prev) => (prev ? { ...prev, mastered: v } : null));
  }, [patch]);

  const remove: WrongBookContextValue['remove'] = useCallback((qid) => {
    patch(qid, () => null);
  }, [patch]);

  const value = useMemo<WrongBookContextValue>(() => {
    const mine = buckets[currentLearnerId] ?? {};
    const now = Date.now();
    void tick;
    /* 错题的「掌握度」用连续答对次数折算：错得越多、答对越少 → 稳定度越低 */
    const all: WrongItem[] = Object.values(mine).map((e) => {
      const pseudoMastery = Math.max(10, Math.min(90, 40 + e.streak * 20 - (e.wrongCount - 1) * 8));
      const elapsed = (now - e.lastAt) / DAY_MS;
      const due = dueAt(e.lastAt, e.streak, pseudoMastery);
      return {
        ...e,
        retention: retention(elapsed, e.streak, pseudoMastery),
        dueAt: due,
        due: !e.mastered && now >= due,
      };
    });
    const active = all.filter((i) => !i.mastered).sort((a, b) => a.retention - b.retention);
    const countByKp: Record<string, number> = {};
    active.forEach((i) => { countByKp[i.kpId] = (countByKp[i.kpId] ?? 0) + 1; });
    return {
      items: active,
      due: active.filter((i) => i.due),
      mastered: all.filter((i) => i.mastered),
      addWrong, redo, setMastered, remove, countByKp,
    };
  }, [buckets, currentLearnerId, tick, addWrong, redo, setMastered, remove]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWrongBook(): WrongBookContextValue {
  const c = useContext(Ctx);
  if (!c) throw new Error('useWrongBook must be used within WrongBookProvider');
  return c;
}
