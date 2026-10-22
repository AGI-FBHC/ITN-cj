const RELOAD_COUNT_KEY = 'lf.chunkReloadCount';
const MAX_RELOADS = 2;
const preloadErrors = new WeakSet<object>();

/** 页面正常启动后清零，避免一次 chunk 失败让本会话之后再也不会自动恢复 */
export function clearChunkRecovery(): void {
  try {
    window.sessionStorage.removeItem(RELOAD_COUNT_KEY);
  } catch {
    /* 存储不可用时不影响页面 */
  }
}

export function isChunkLoadError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && preloadErrors.has(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading (?:CSS )?chunk .+ failed/i.test(message);
}

export function installChunkRecovery(): void {
  window.addEventListener('vite:preloadError', (event) => {
    const error = (event as Event & { payload?: unknown }).payload;
    if (typeof error === 'object' && error !== null) preloadErrors.add(error);

    // Keep Vite's rejection intact: cancelling it resolves React.lazy to undefined.
    // 部署后旧 chunk 已被替换：带 cache-buster 重新拉取 index.html，最多重试两次。
    let attempts = 0;
    try {
      attempts = Number(window.sessionStorage.getItem(RELOAD_COUNT_KEY) ?? '0') || 0;
      if (attempts >= MAX_RELOADS) return;
      window.sessionStorage.setItem(RELOAD_COUNT_KEY, String(attempts + 1));
    } catch {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set('v', String(Date.now()));
    window.location.replace(url.toString());
  });
}
