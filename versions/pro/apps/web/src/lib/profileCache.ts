import type { Learner } from '@/data/learners';

const CACHE_PREFIX = 'lf.profileCache:v1:';

export interface ProfileCacheValue {
  learners: Learner[];
  currentLearnerId: string | null;
  savedAt: number;
}

const keyOf = (account: string) => `${CACHE_PREFIX}${encodeURIComponent(account.trim().toLowerCase())}`;

export function readProfileCache(account?: string | null): ProfileCacheValue | null {
  if (typeof window === 'undefined' || !account) return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(keyOf(account)) ?? 'null') as Partial<ProfileCacheValue> | null;
    if (!parsed || !Array.isArray(parsed.learners)) return null;
    return {
      learners: parsed.learners,
      currentLearnerId: typeof parsed.currentLearnerId === 'string' ? parsed.currentLearnerId : null,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function writeProfileCache(account: string | null | undefined, learners: Learner[], currentLearnerId?: string | null): void {
  if (typeof window === 'undefined' || !account) return;
  try {
    window.localStorage.setItem(keyOf(account), JSON.stringify({
      learners,
      currentLearnerId: currentLearnerId ?? null,
      savedAt: Date.now(),
    } satisfies ProfileCacheValue));
  } catch { /* 缓存不可用时仍保留本次内存状态 */ }
}
