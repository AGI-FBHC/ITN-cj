import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ageOf, clearInflight, peekInflight, readCache, setInflight, writeCache,
} from '@/lib/swrCache';

export interface CachedState<T> {
  /** 当前展示数据：优先来自缓存，后台刷新完成后更新 */
  data: T | null;
  /** 首次加载（无任何缓存）为 true；有缓存时保持 false 避免闪烁 */
  loading: boolean;
  /** 正在后台异步刷新（已有缓存，本次为更新） */
  refreshing: boolean;
  error: Error | null;
  /**
   * 重新拉取。force=true 时绕过 TTL 强制请求并立即写入缓存
   * （写操作成功后应调用 refresh(true) 保证一致性）
   */
  refresh: (force?: boolean) => Promise<void>;
}

export interface CachedOptions {
  /** 新鲜期：TTL 内再次挂载不会发起后台请求，默认 10s */
  ttlMs?: number;
}

/**
 * stale-while-revalidate：
 * 1. key 有缓存 → data 立即为缓存值，并在过期后（或首次访问）后台刷新；
 * 2. key 无缓存 → loading=true 拉取并写缓存；
 * 3. 同 key 并发请求共享同一个 in-flight promise，不重复打接口。
 */
export function useCachedData<T>(
  key: string | null,
  loader: () => Promise<T>,
  options: CachedOptions = {},
): CachedState<T> {
  const ttlMs = options.ttlMs ?? 10_000;
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [data, setData] = useState<T | null>(() => (key ? readCache<T>(key) ?? null : null));
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  /* key（过滤条件）变化时，先把下一个 key 的缓存数据同步到界面 */
  useEffect(() => {
    if (!key) return;
    setData(readCache<T>(key) ?? null);
    setError(null);
  }, [key]);

  const refresh = useCallback(
    async (force = false) => {
      if (!key) return;
      const cached = readCache<T>(key);
      const stale = ageOf(key) === null || ageOf(key)! > ttlMs;
      if (!force && !stale) return;
      /* 复用 in-flight：同一 key 高并发（切目录连发）只打一次接口 */
      const flying = peekInflight<T>(key);
      if (flying && !force) {
        try { await flying; } catch { /* 等待方不重复报错 */ }
        return;
      }
      if (cached !== undefined && !force) setRefreshing(true);
      else if (cached === undefined) setLoading(true);
      const promise = (async () => {
        try {
          const value = await loaderRef.current();
          writeCache(key, value);
          setData(value);
          setError(null);
        } catch (reason) {
          /* 缓存仍在：静默保留旧数据，不打断管理员操作 */
          if (cached === undefined) setError(reason instanceof Error ? reason : new Error(String(reason)));
        } finally {
          setLoading(false);
          setRefreshing(false);
          clearInflight(key);
        }
      })();
      setInflight(key, promise);
      try { await promise; } catch { /* handled inside */ }
    },
    [key, ttlMs],
  );

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  return { data, loading, refreshing, error, refresh };
}
