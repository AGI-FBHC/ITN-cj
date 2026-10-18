/**
 * 管理端轻量 SWR 缓存（stale-while-revalidate）
 * - 首次请求后写入内存缓存
 * - 再次挂载组件（切 tab / 切目录 / 切类型）优先展示缓存，后台异步刷新
 * - TTL 内不重复发请求；写操作后调用 refresh(true) 强制绕过缓存
 * - 仅用于管理端只读列表/统计类请求；轮询与用户主动触发的搜索不走缓存
 */
export interface CacheEntry<T> {
  data: T;
  at: number;
}

const store = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export function readCache<T>(key: string): T | undefined {
  const entry = store.get(key);
  return entry ? (entry.data as T) : undefined;
}

export function ageOf(key: string): number | null {
  const entry = store.get(key);
  return entry ? Date.now() - entry.at : null;
}

export function writeCache<T>(key: string, data: T): void {
  store.set(key, { data, at: Date.now() });
}

export function removeCache(key: string): void {
  store.delete(key);
  inflight.delete(key);
}

export function clearCacheStartsWith(prefix: string): void {
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      inflight.delete(key);
    }
  }
}

export function peekInflight<T>(key: string): Promise<T> | undefined {
  return inflight.get(key) as Promise<T> | undefined;
}

export function setInflight(key: string, promise: Promise<unknown>): void {
  inflight.set(key, promise);
}

export function clearInflight(key: string): void {
  inflight.delete(key);
}
