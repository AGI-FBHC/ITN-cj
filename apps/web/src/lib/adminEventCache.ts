import type { AdminGenerationEvent } from '@/lib/api';

const CACHE_DB = 'itn-admin-event-cache';
const CACHE_STORE = 'tasks';
export const ADMIN_EVENT_CACHE_MAX = 200;

interface AdminEventCacheRecord {
  key: string;
  events: AdminGenerationEvent[];
  updatedAt: number;
}

function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = window.indexedDB.open(CACHE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storeRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function trimEvents(events: AdminGenerationEvent[]): AdminGenerationEvent[] {
  return [...events]
    .filter((event) => Number.isFinite(event.seq))
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .slice(-ADMIN_EVENT_CACHE_MAX);
}

export async function loadAdminEventCache(taskKind: 'resource' | 'ppt', taskId: string): Promise<AdminGenerationEvent[]> {
  try {
    const key = `${taskKind}:${taskId}`;
    const db = await openCacheDb();
    try {
      const transaction = db.transaction(CACHE_STORE, 'readonly');
      const record = await storeRequest(transaction.objectStore(CACHE_STORE).get(key));
      return record && Array.isArray(record.events) ? record.events : [];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export async function saveAdminEventCache(taskKind: 'resource' | 'ppt', taskId: string, events: AdminGenerationEvent[]): Promise<void> {
  try {
    const key = `${taskKind}:${taskId}`;
    const db = await openCacheDb();
    try {
      const transaction = db.transaction(CACHE_STORE, 'readwrite');
      transaction.objectStore(CACHE_STORE).put({
        key,
        events: trimEvents(events),
        updatedAt: Date.now(),
      } satisfies AdminEventCacheRecord);
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  } catch {
    // Cache is best-effort display acceleration; never break the workbench.
  }
}
