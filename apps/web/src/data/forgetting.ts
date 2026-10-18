/**
 * forgetting — 艾宾浩斯遗忘曲线 + 间隔重复排程（纯计算，无副作用）
 *
 * 记忆保持率：R = e^(-t / S)
 *   t = 距上次复习的天数；S = 记忆稳定度（天）
 * 稳定度随复习次数递增（间隔重复），并被掌握度加成：
 *   S = BASE_INTERVALS[reps] × (0.75 + mastery/200)
 * 达到 RETENTION_FLOOR 即视为「该复习了」。
 *
 * 花园隐喻：保持率 = 记忆的水分。水分低 = 这株渴了，复习 = 浇水。
 */

/** 间隔重复的目标间隔（天）：第 n 次复习后，期望隔这么久再复习 */
export const BASE_INTERVALS = [2, 5, 10, 21, 45, 90, 180] as const;

/** 低于此保持率即到期复习 */
export const RETENTION_FLOOR = 0.7;

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 记忆稳定度 S（天）
 * 关键：S 由「目标间隔」反解而来 —— 使保持率在目标间隔处恰好衰减到 RETENTION_FLOOR：
 *   R = e^(-interval/S) = FLOOR  →  S = interval / (-ln FLOOR) ≈ interval × 2.8
 * 若直接把 interval 当 S，会导致一天内就跌到 40%（过于激进，也违背去焦虑原则）。
 */
export function stability(reps: number, mastery: number): number {
  const interval = BASE_INTERVALS[Math.min(reps, BASE_INTERVALS.length - 1)];
  /* 掌握度越高，记得越牢：0.8x ~ 1.3x */
  const masteryBoost = 0.8 + Math.max(0, Math.min(100, mastery)) / 200;
  return (interval / -Math.log(RETENTION_FLOOR)) * masteryBoost;
}

/** 保持率 R ∈ (0,1]：距上次复习 elapsedDays 天后还记得多少 */
export function retention(elapsedDays: number, reps: number, mastery: number): number {
  if (elapsedDays <= 0) return 1;
  const S = stability(reps, mastery);
  return Math.exp(-elapsedDays / S);
}

/** 下次复习到期时刻（ms 时间戳）：保持率衰减到 RETENTION_FLOOR 的那一刻 */
export function dueAt(lastAt: number, reps: number, mastery: number): number {
  const S = stability(reps, mastery);
  /* R = e^(-t/S) = floor → t = -S·ln(floor) */
  const days = -S * Math.log(RETENTION_FLOOR);
  return lastAt + days * DAY_MS;
}

export interface ReviewState {
  /** 上次学习/复习时刻 */
  lastAt: number;
  /** 已复习次数（首次学习后为 0） */
  reps: number;
}

export interface ReviewItem {
  kpId: string;
  lastAt: number;
  reps: number;
  mastery: number;
  /** 当前保持率 0~1（= 记忆水分） */
  retention: number;
  /** 距上次学习天数 */
  elapsedDays: number;
  /** 到期时刻 */
  dueAt: number;
  /** 是否已到期 */
  due: boolean;
  /** 逾期天数（未到期为负，表示还剩几天） */
  overdueDays: number;
}

/** 计算单个知识点的复习状态 */
export function reviewItemOf(kpId: string, st: ReviewState, mastery: number, now: number): ReviewItem {
  const elapsedDays = Math.max(0, (now - st.lastAt) / DAY_MS);
  const due = dueAt(st.lastAt, st.reps, mastery);
  return {
    kpId,
    lastAt: st.lastAt,
    reps: st.reps,
    mastery,
    retention: retention(elapsedDays, st.reps, mastery),
    elapsedDays,
    dueAt: due,
    due: now >= due,
    overdueDays: (now - due) / DAY_MS,
  };
}

/** 水分档位（用于文案与配色，避免焦虑化表述） */
export type MoistLevel = 'fresh' | 'ok' | 'thirsty' | 'dry';
export function moistLevel(r: number): MoistLevel {
  if (r >= 0.85) return 'fresh';
  if (r >= RETENTION_FLOOR) return 'ok';
  if (r >= 0.45) return 'thirsty';
  return 'dry';
}

export const MOIST_META: Record<MoistLevel, { label: string; tone: string; ring: string }> = {
  fresh: { label: '水分充足', tone: '#4E7860', ring: '#7FB295' },
  ok: { label: '还算滋润', tone: '#4E7860', ring: '#9BC5AC' },
  thirsty: { label: '有点渴了', tone: '#B77552', ring: '#E7B45A' },
  dry: { label: '需要浇水', tone: '#B0483B', ring: '#D08A6A' },
};

/** 人性化时间差：「3 天前」「刚刚」 */
export function humanAgo(ms: number): string {
  const d = ms / DAY_MS;
  if (d < 1 / 24) return '刚刚';
  if (d < 1) return `${Math.round(d * 24)} 小时前`;
  if (d < 30) return `${Math.round(d)} 天前`;
  return `${Math.round(d / 30)} 个月前`;
}

/** 人性化剩余：「还有 2 天」 */
export function humanUntil(ms: number): string {
  const d = ms / DAY_MS;
  if (d < 1 / 24) return '就快到了';
  if (d < 1) return `还有 ${Math.round(d * 24)} 小时`;
  return `还有 ${Math.round(d)} 天`;
}

/**
 * 未来 N 天的保持率曲线采样（用于遗忘曲线图）
 * 返回 [{ day, retention }]，day 为距今天数（0 = 今天）
 */
export function retentionCurve(
  st: ReviewState,
  mastery: number,
  now: number,
  days = 30,
  step = 1,
): { day: number; retention: number }[] {
  const elapsedNow = Math.max(0, (now - st.lastAt) / DAY_MS);
  const out: { day: number; retention: number }[] = [];
  for (let d = 0; d <= days; d += step) {
    out.push({ day: d, retention: retention(elapsedNow + d, st.reps, mastery) });
  }
  return out;
}

/** 排程预览：从某次学习起，后续各次复习的日期（间隔重复） */
export function schedulePreview(lastAt: number, reps: number, mastery: number, count = 5): number[] {
  const out: number[] = [];
  let at = lastAt;
  for (let i = 0; i < count; i++) {
    at = dueAt(at, reps + i, mastery);
    out.push(at);
  }
  return out;
}
