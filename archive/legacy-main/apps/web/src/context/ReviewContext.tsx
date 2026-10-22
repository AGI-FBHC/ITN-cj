/**
 * ReviewContext — 遗忘曲线复习提醒（花园隐喻：记忆水分 / 浇水）
 * - 记录每个知识点的「上次学习时刻 + 复习次数」，按学习者分桶持久化
 * - 按艾宾浩斯曲线算出保持率与到期时间，给出「该浇水了」清单
 * - 应用打开期间定时（默认 5 分钟）巡检一次，对最渴的一株发一条温柔提醒
 *   去焦虑原则：只提示「有点渴了」，从不出现倒计时/断签/红叉；每株每会话只提醒一次
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { useProfile } from '@/context/ProfileContext';
import { knowledgePoints, getKnowledgePoint } from '@/data/knowledgePoints';
import {
  DAY_MS,
  moistLevel,
  reviewItemOf,
  type ReviewItem,
  type ReviewState,
} from '@/data/forgetting';

type Buckets = Record<string, Record<string, ReviewState>>;

interface ReviewContextValue {
  /** 全部知识点的复习状态（按最渴优先排序） */
  items: ReviewItem[];
  /** 已到期（该浇水）的知识点 */
  due: ReviewItem[];
  /** 取某知识点的复习状态 */
  itemOf: (kpId: string) => ReviewItem | undefined;
  /** 学过/复习过一次 → 重置计时并 +1 次复习 */
  markStudied: (kpId: string) => void;
  /** 标记存疑 → 这一株立刻进入"该浇水"队列，提醒尽快回来复习 */
  markDoubt: (kpId: string) => void;
  /** 巡检间隔（分钟），0 = 关闭提醒 */
  remindEveryMin: number;
  setRemindEveryMin: (m: number) => void;
}

const ReviewContext = createContext<ReviewContextValue | null>(null);
const K_REVIEW = 'lf.review';
const K_REMIND = 'lf.remindEveryMin';

/** 稳定字符串哈希（用于演示数据的确定性播种） */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function ReviewProvider({ children }: { children: ReactNode }) {
  const { currentLearnerId, currentLearner } = useProfile();
  const [buckets, setBuckets] = useState<Buckets>(() => {
    try {
      const raw = window.localStorage.getItem(K_REVIEW);
      return raw ? (JSON.parse(raw) as Buckets) : {};
    } catch {
      return {};
    }
  });
  const [remindEveryMin, setRemindEveryMin] = useState<number>(() => {
    const raw = Number(window.localStorage.getItem(K_REMIND));
    return Number.isFinite(raw) && raw >= 0 ? raw : 5;
  });
  /** 触发一次重算（时间流逝导致保持率变化） */
  const [tick, setTick] = useState(0);

  useEffect(() => {
    try { window.localStorage.setItem(K_REVIEW, JSON.stringify(buckets)); } catch { /* ignore */ }
  }, [buckets]);
  useEffect(() => {
    try { window.localStorage.setItem(K_REMIND, String(remindEveryMin)); } catch { /* ignore */ }
  }, [remindEveryMin]);

  /** 首次见到某学习者：为「已学过」的知识点播种一个合理的历史学习时间（演示可见性）
   *  只对预设画像播种——自建画像刚建档，园子必须从空开始，学习记录全部来自真实行为 */
  useEffect(() => {
    setBuckets((prev) => {
      if (prev[currentLearnerId]) return prev;
      if (currentLearner.custom) return { ...prev, [currentLearnerId]: {} };
      const seeded: Record<string, ReviewState> = {};
      const now = Date.now();
      knowledgePoints.forEach((kp) => {
        const score = currentLearner.scores[kp.id] ?? 50;
        /* 分数明显高于起点视为学过，才有「复习」可谈 */
        if (score < 55) return;
        const h = hash(`${currentLearnerId}:${kp.id}`);
        /* 复习次数 0~3；上次学习时间取「该次间隔」的 0.3~1.6 倍，
           使演示数据自然分布出「水分充足 / 还算滋润 / 有点渴了 / 需要浇水」四档 */
        const reps = h % 4;
        const interval = [2, 5, 10, 21][reps];
        const ratio = 0.3 + ((h >> 3) % 14) / 10;   // 0.3 ~ 1.6
        seeded[kp.id] = { lastAt: now - interval * ratio * DAY_MS, reps };
      });
      return { ...prev, [currentLearnerId]: seeded };
    });
  }, [currentLearnerId, currentLearner]);

  const markStudied = useCallback((kpId: string) => {
    setBuckets((prev) => {
      const mine = prev[currentLearnerId] ?? {};
      const cur = mine[kpId];
      return {
        ...prev,
        [currentLearnerId]: {
          ...mine,
          [kpId]: { lastAt: Date.now(), reps: cur ? cur.reps + 1 : 0 },
        },
      };
    });
  }, [currentLearnerId]);

  const markDoubt = useCallback((kpId: string) => {
    setBuckets((prev) => {
      const mine = prev[currentLearnerId] ?? {};
      const cur = mine[kpId];
      /* 把"上次学习"拨回足够久之前 → 保持率跌穿阈值，立刻排进待复习 */
      return {
        ...prev,
        [currentLearnerId]: { ...mine, [kpId]: { lastAt: Date.now() - 30 * DAY_MS, reps: cur?.reps ?? 0 } },
      };
    });
  }, [currentLearnerId]);

  const items = useMemo<ReviewItem[]>(() => {
    const mine = buckets[currentLearnerId] ?? {};
    const now = Date.now();
    void tick; // 依赖 tick 以随时间重算
    return Object.entries(mine)
      .map(([kpId, st]) => reviewItemOf(kpId, st, currentLearner.scores[kpId] ?? 50, now))
      .sort((a, b) => a.retention - b.retention);
  }, [buckets, currentLearnerId, currentLearner, tick]);

  const due = useMemo(() => items.filter((i) => i.due), [items]);

  /* ---- 定时巡检 + 温柔提醒（每株每会话只提醒一次） ---- */
  const remindedRef = useRef<Set<string>>(new Set());
  const dueRef = useRef<ReviewItem[]>([]);
  dueRef.current = due;

  useEffect(() => {
    if (remindEveryMin <= 0) return;
    const fire = () => {
      setTick((t) => t + 1); // 重算保持率
      const list = dueRef.current;
      const target = list.find((i) => !remindedRef.current.has(`${currentLearnerId}:${i.kpId}`));
      if (!target) return;
      remindedRef.current.add(`${currentLearnerId}:${target.kpId}`);
      const kp = getKnowledgePoint(target.kpId);
      const lvl = moistLevel(target.retention);
      toast(`「${kp.name}」${lvl === 'dry' ? '需要浇水了' : '有点渴了'}`, {
        description: `记忆水分 ${Math.round(target.retention * 100)}% · 复习一遍就能重新滋润`,
        duration: 7000,
      });
    };
    /* 进入应用 12 秒后先看一眼，之后按间隔巡检 */
    const first = setTimeout(fire, 12000);
    const timer = setInterval(fire, remindEveryMin * 60 * 1000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [remindEveryMin, currentLearnerId]);

  /* 切换学习者时清空本会话提醒记录 */
  useEffect(() => { remindedRef.current = new Set(); }, [currentLearnerId]);

  const value = useMemo<ReviewContextValue>(() => ({
    items,
    due,
    itemOf: (kpId: string) => items.find((i) => i.kpId === kpId),
    markStudied,
    markDoubt,
    remindEveryMin,
    setRemindEveryMin,
  }), [items, due, markStudied, markDoubt, remindEveryMin]);

  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}

export function useReview(): ReviewContextValue {
  const ctx = useContext(ReviewContext);
  if (!ctx) throw new Error('useReview must be used within ReviewProvider');
  return ctx;
}
