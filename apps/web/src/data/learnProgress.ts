/**
 * learnProgress — 断点续学（课堂推进位置持久化）
 * 课堂推进模式下，"学到第几段"和"本节掌握度涨跌"原来只在内存里，刷新即失忆。
 * 这里按 学习者 × 知识点 存一份轻量进度，进课件时恢复，学完后清除。
 * 后端化后应迁到 learner_event（见 思路/04-数据库设计.md），此处为纯前端演示实现。
 */
const KEY = 'lf.learnProgress';
/** 超过 14 天的断点视为过期（内容可能已重新生成） */
const TTL_MS = 14 * 24 * 3600 * 1000;

export interface LearnProgress {
  /** 已解锁块数 */
  unlocked: number;
  /** 本节掌握度增量 */
  delta: number;
  /** 换讲法后的风格覆盖（恢复时保持同一版本的课件） */
  style?: string;
  /** 最后学习时间戳 */
  ts: number;
}

type Store = Record<string, LearnProgress>;

const keyOf = (learnerId: string, kpId: string) => `${learnerId}:${kpId}`;

function read(): Store {
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as Store;
  } catch {
    return {};
  }
}

function write(s: Store) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 隐私模式等拿不到 storage 时静默跳过 */
  }
}

/** 读断点：不存在或已过期返回 null */
export function loadProgress(learnerId: string, kpId: string): LearnProgress | null {
  const p = read()[keyOf(learnerId, kpId)];
  if (!p) return null;
  if (Date.now() - p.ts > TTL_MS) return null;
  return p;
}

/** 存断点：第 1 段（还没开始学）不记，避免"续学"提示噪音 */
export function saveProgress(learnerId: string, kpId: string, p: Omit<LearnProgress, 'ts'>) {
  if (p.unlocked <= 1 && p.delta === 0) return;
  const s = read();
  s[keyOf(learnerId, kpId)] = { ...p, ts: Date.now() };
  write(s);
}

/** 清断点（完课 / 学习者主动重学） */
export function clearProgress(learnerId: string, kpId: string) {
  const s = read();
  delete s[keyOf(learnerId, kpId)];
  write(s);
}
