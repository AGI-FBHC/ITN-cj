const RELOAD_KEY = 'lf.chunkReloadAt';
const preloadErrors = new WeakSet<object>();

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
    // Persist the attempt before reloading; an unavailable store cannot bound retries.
    try {
      if (window.sessionStorage.getItem(RELOAD_KEY) !== null) return;
      window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    } catch {
      return;
    }
    window.location.reload();
  });
}
