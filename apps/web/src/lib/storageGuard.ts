/**
 * storageGuard — 本地存储版本戳
 * localhost:3002 曾被旧项目（Kimi_Agent_k3_v2 等历史版本）使用过，
 * 两边 localStorage 键名相同（lf.*）但数据结构不兼容，脏数据会让应用启动即崩（白屏）。
 * 首次加载 / 版本不匹配时，一次性清空所有 lf.* 键，然后写入当前版本戳。
 */
const K_SCHEMA = 'lf.schemaVersion';
const SCHEMA_VERSION = '2';

function purge(storage: Storage) {
  const stale: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && (k.startsWith('lf.') || k.startsWith('lf-'))) stale.push(k);
  }
  stale.forEach((k) => storage.removeItem(k));
}

export function ensureStorageSchema() {
  if (typeof window === 'undefined') return;
  try {
    if (window.localStorage.getItem(K_SCHEMA) === SCHEMA_VERSION) return;
    purge(window.localStorage);
    purge(window.sessionStorage);
    window.localStorage.setItem(K_SCHEMA, SCHEMA_VERSION);
  } catch {
    /* 隐私模式等拿不到 storage 时静默跳过 */
  }
}

/** 供错误兜底 UI 使用：强制清空并刷新 */
export function resetLocalData() {
  try {
    purge(window.localStorage);
    purge(window.sessionStorage);
    window.localStorage.setItem(K_SCHEMA, SCHEMA_VERSION);
  } catch {
    /* ignore */
  }
  window.location.reload();
}
