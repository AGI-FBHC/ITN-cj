/**
 * 知识点四类资源（定制讲义/实操指南/分阶测试题/交互课件）的本地状态缓存。
 * 规则：首次生成完成或状态变化时写缓存；再次打开同一知识点/子话题时优先读缓存，
 * 命中“已完成”后跳过列表类网络请求，减少重复请求。
 */
import type { ResourceForm } from '@/data/resources';

export interface CachedResourceEntry {
  id: string;
  title: string;
  status?: string;
  updatedAt: string;
}

export type ResourceCacheValue = Partial<Record<ResourceForm | 'ppt', CachedResourceEntry>>;

const CACHE_PREFIX = 'lf.kpResourceCache:v1:';

export function resourceCacheKey(scope: string): string {
  return `${CACHE_PREFIX}${scope}`;
}

export function readResourceCache(scope: string): ResourceCacheValue | null {
  try {
    const raw = window.localStorage.getItem(resourceCacheKey(scope));
    return raw ? (JSON.parse(raw) as ResourceCacheValue) : null;
  } catch {
    return null;
  }
}

export function writeResourceCache(scope: string, value: ResourceCacheValue) {
  try {
    if (!value || Object.keys(value).length === 0) {
      window.localStorage.removeItem(resourceCacheKey(scope));
    } else {
      window.localStorage.setItem(resourceCacheKey(scope), JSON.stringify(value));
    }
  } catch {
    /* ignore */
  }
}

export function upsertResourceCache(scope: string, form: keyof ResourceCacheValue, entry: CachedResourceEntry) {
  const current = readResourceCache(scope) ?? {};
  writeResourceCache(scope, { ...current, [form]: entry });
}

export function removeResourceCache(scope: string, form: keyof ResourceCacheValue) {
  const current = readResourceCache(scope);
  if (!current) return;
  const next = { ...current };
  delete next[form];
  writeResourceCache(scope, next);
}
