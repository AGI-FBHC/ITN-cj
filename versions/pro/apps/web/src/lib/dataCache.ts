/**
 * 通用带 TTL 的本地缓存（按 learner 隔离 + 事件置脏）。
 *
 * 用法约定：
 * - 读取命中缓存时，调用方仍可选择“后台向服务端校准”；这里只负责“首屏秒开 + 减少重复请求”。
 * - 任何学习行为（lf-signal）都会置脏 analytics 与“今天”的日记，保证下一次读取是新鲜数据。
 * - key 带版本号；TTL 用时间戳判断，不依赖后端。
 */
import type { LearnerAnalyticsProfile, LearningJournal } from '@/lib/api';

export interface TimedCache<T> {
  data: T;
  savedAt: number;
}

export function readTimedCache<T>(key: string, ttlMs: number): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TimedCache<T>;
    if (!parsed || typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > ttlMs) {
      window.localStorage.removeItem(key);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export function writeTimedCache<T>(key: string, data: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ data, savedAt: Date.now() }));
  } catch {
    /* ignore */
  }
}

export function bustCache(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ---------------- 掌握度画像 analytics ---------------- */

export const ANALYTICS_CACHE_TTL_MS = 3 * 60 * 1000;
export const learnerAnalyticsKey = (learnerId: string) => `lf.analytics:v1:${learnerId}`;

export function readLearnerAnalytics(learnerId: string): LearnerAnalyticsProfile | null {
  return readTimedCache<LearnerAnalyticsProfile>(learnerAnalyticsKey(learnerId), ANALYTICS_CACHE_TTL_MS);
}

export function writeLearnerAnalytics(learnerId: string, data: LearnerAnalyticsProfile): void {
  writeTimedCache(learnerAnalyticsKey(learnerId), data);
}

export function bustLearnerAnalytics(learnerId: string): void {
  bustCache(learnerAnalyticsKey(learnerId));
}

/* ---------------- 学习日记 journals（按日） ---------------- */

/** 历史日记不可变，缓存久一点；今天的日记学习后 2 分钟内可见 */
export const JOURNAL_TTL_TODAY_MS = 2 * 60 * 1000;
export const JOURNAL_TTL_HISTORY_MS = 24 * 60 * 60 * 1000;
export const learnerJournalKey = (learnerId: string, date: string) => `lf.journal:v1:${learnerId}:${date}`;

export function readLearnerJournal(learnerId: string, date: string, today: boolean): LearningJournal | null {
  return readTimedCache<LearningJournal>(learnerJournalKey(learnerId, date), today ? JOURNAL_TTL_TODAY_MS : JOURNAL_TTL_HISTORY_MS);
}

export function writeLearnerJournal(learnerId: string, date: string, journal: LearningJournal): void {
  writeTimedCache(learnerJournalKey(learnerId, date), journal);
}

export function bustLearnerJournal(learnerId: string, date: string): void {
  bustCache(learnerJournalKey(learnerId, date));
}

/** 学习行为发生后置脏“今天”的日记与 analytics 缓存（供 lf-signal 监听方调用） */
export function bustTodayLearningCaches(learnerId: string, today: string): void {
  bustLearnerJournal(learnerId, today);
  bustLearnerAnalytics(learnerId);
}
