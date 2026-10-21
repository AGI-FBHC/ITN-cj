import React from 'react';
import { loadOrgBrand, resetOrgBrand } from './org-brand.js';

const TOKEN_KEY = 'zhixun-learning-v2-token';

export async function readLearningBundleAsset(path, { signal } = {}) {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin || !/^\/api\/kb\/bundles\/[^/]+\/assets\/[^/]+$/.test(url.pathname)) {
    throw new Error('图片地址不可用');
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 20000);
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const response = await fetch(`${url.pathname}${url.search}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    if (response.status === 401) throw new Error('学习会话已失效，请重新登录后查看图片');
    if (!response.ok) throw new Error('图片不存在或该课程暂未发布');
    const blob = await response.blob();
    if (!blob.type.toLowerCase().startsWith('image/')) throw new Error('该文件不是可显示的图片');
    return blob;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

const listeners = new Set();
let snapshot = { ready: false, loading: true, error: '', data: null, pending: 0, saveError: '' };
let sessionPromise;
let bootstrapPromise;
let retrySave;
let saveQueue = Promise.resolve();
const emit = (patch) => {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
};
window.addEventListener('zx-org-updated', () => emit({ brandRevision: (snapshot.brandRevision || 0) + 1 }));
export function useLearning() {
  return React.useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => snapshot);
}
async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const response = await fetch(`/api${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
      signal: controller.signal,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('服务返回格式异常，请重试'); }
    if (!response.ok) {
      const error = new Error(data.message || `请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接超时，请重试');
    throw error;
  } finally { clearTimeout(timeout); }
}
async function ensureSession() {
  if (localStorage.getItem(TOKEN_KEY)) return;
  if (!sessionPromise) sessionPromise = request('/session', { method: 'POST', body: {} }).then((session) => {
    if (!session.token) throw new Error('学习会话创建失败');
    localStorage.setItem(TOKEN_KEY, session.token);
  }).finally(() => { sessionPromise = undefined; });
  await sessionPromise;
}
export async function bootstrap() {
  if (bootstrapPromise) return bootstrapPromise;
  emit({ loading: true, error: '' });
  bootstrapPromise = (async () => {
    try {
      await ensureSession();
      const [data] = await Promise.all([request('/bootstrap'), loadOrgBrand()]);
      if (!Array.isArray(data.courses)) throw new Error('课程目录读取失败，请重试');
      localStorage.setItem('zhixun-course-favorites', JSON.stringify(data.favorites || []));
      localStorage.setItem('zhixun-lecture-bookmarks', JSON.stringify(data.bookmarks || []));
      emit({ ready: true, loading: false, data });
      return data;
    } catch (error) {
      emit({ loading: false, error: error.message });
      throw error;
    } finally { bootstrapPromise = undefined; }
  })();
  return bootstrapPromise;
}
export async function refreshLearning() {
  const data = await request('/bootstrap');
  emit({ data });
  return data;
}
export async function authenticate(mode, credentials) {
  const data = await request(mode === 'register' ? '/auth/register' : '/auth/login', {
    method: 'POST',
    body: credentials,
  });
  if (!data.token) throw new Error('登录服务未返回学习会话');
  localStorage.setItem(TOKEN_KEY, data.token);
  resetOrgBrand();
  localStorage.setItem('zhixun-display-name', data.displayName || credentials.account || '学习者');
  const [bootstrapData] = await Promise.all([request('/bootstrap'), loadOrgBrand()]);
  emit({ ready: true, loading: false, error: '', data: bootstrapData });
  return bootstrapData;
}
export async function sendEmailCode(email, purpose = 'LOGIN') {
  return request('/auth/send-code', { method: 'POST', body: { email, purpose } });
}
export async function resetPassword(email, verificationCode, password) {
  return request('/auth/reset-password', { method: 'POST', body: { email, verificationCode, password } });
}
export async function loginWithEmailCode(email, verificationCode, inviteCode = '') {
  const data = await request('/auth/email-login', {
    method: 'POST',
    body: { email, verificationCode, ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}) },
  });
  if (!data.token) throw new Error('登录服务未返回学习会话');
  localStorage.setItem(TOKEN_KEY, data.token);
  resetOrgBrand();
  localStorage.setItem('zhixun-display-name', data.displayName || email);
  const [bootstrapData] = await Promise.all([request('/bootstrap'), loadOrgBrand()]);
  emit({ ready: true, loading: false, error: '', data: bootstrapData });
  return bootstrapData;
}
export const api = (path, method = 'GET', body) => request(path, { method, body });
export const getLearnerMemory = () => api('/learner/memory');
export const updateLearnerCustomMemory = (text) => api('/learner/memory/custom', 'PUT', { text });
export function clearLearningSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem('zhixun-display-name');
  emit({ ready: false, loading: false, error: '', data: null });
}
export async function saveProfile(profile) {
  const saved = await api('/profile', 'PUT', profile);
  const value = saved.profile ?? saved;
  emit({ data: { ...snapshot.data, profile: value } });
  return value;
}
export function persistState(patch) {
  if (!snapshot.ready) return;
  const desired = { favorites: snapshot.data.favorites || [], bookmarks: snapshot.data.bookmarks || [], ...patch };
  emit({ data: { ...snapshot.data, ...desired }, pending: snapshot.pending + 1, saveError: '' });
  const task = async () => {
    try {
      await api('/state', 'PUT', desired);
      retrySave = undefined;
      emit({ saveError: '' });
    } catch (error) {
      // Retry the latest full state, so an older failed request cannot undo a newer edit.
      retrySave = () => persistState({ favorites: snapshot.data.favorites, bookmarks: snapshot.data.bookmarks });
      emit({ saveError: `收藏/书签尚未同步：${error.message}` });
    } finally { emit({ pending: Math.max(0, snapshot.pending - 1) }); }
  };
  saveQueue = saveQueue.then(task, task);
}
export function SyncStatus() {
  const state = useLearning();
  if (!state.saveError && !state.pending) return null;
  return <div role="status" className="fixed bottom-4 left-1/2 z-[200] -translate-x-1/2 rounded-2xl border border-black/10 bg-white px-5 py-3 text-sm shadow-lg">
    {state.saveError || '正在保存收藏和书签…'}
    {state.saveError && <button className="ml-3 font-bold text-[#6038ef]" onClick={() => retrySave?.()}>重新保存</button>}
  </div>;
}
export function LoadPanel({ error, onRetry, onBack, message = '正在加载学习内容…' }) {
  return <div className="flex min-h-[70vh] items-center justify-center bg-[#fbfbfd] p-6">
    <section className="w-full max-w-md rounded-3xl border border-black/5 bg-white p-8 text-center shadow-sm" aria-live="polite">
      <div className="mx-auto mb-5 h-10 w-10 rounded-2xl bg-[#6038ef]/10 text-2xl text-[#6038ef]">✦</div>
      <h1 className="text-xl font-extrabold text-[#111318]">{error ? '暂时无法加载' : message}</h1>
      {error && <p className="mt-3 text-sm leading-6 text-[#626672]" role="alert">{error}</p>}
      {error && <button onClick={onRetry} className="mt-6 rounded-xl bg-[#6038ef] px-6 py-3 font-bold text-white">重试</button>}
      {onBack && <button onClick={onBack} className="ml-3 mt-6 rounded-xl px-5 py-3 font-bold text-[#626672]">返回课程</button>}
    </section>
  </div>;
}
export function useLesson(course, index) {
  const [state, setState] = React.useState({ loading: true, error: '', lesson: null });
  const [revision, retry] = React.useReducer((value) => value + 1, 0);
  React.useEffect(() => {
    let active = true;
    setState({ loading: true, error: '', lesson: null });
    api(`/courses/${encodeURIComponent(course.id)}/lessons/${index}`).then((lesson) => {
      if (active) setState({ loading: false, error: '', lesson });
    }).catch((error) => { if (active) setState({ loading: false, error: error.message, lesson: null }); });
    return () => { active = false; };
  }, [course.id, index, revision]);
  return { ...state, retry };
}
export const AI_UNAVAILABLE = 'Lumin 暂时无法回答，请稍后再试。';
