import React from 'react';

const TOKEN_KEY = 'zhixun-learning-v2-token';
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
      const data = await request('/bootstrap');
      if (!Array.isArray(data.courses) || !data.courses.length) throw new Error('课程目录暂未准备好，请稍后重试');
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
  localStorage.setItem('zhixun-display-name', data.displayName || credentials.account || '学习者');
  const bootstrapData = await request('/bootstrap');
  emit({ ready: true, loading: false, error: '', data: bootstrapData });
  return bootstrapData;
}
export const api = (path, method = 'GET', body) => request(path, { method, body });
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
export const AI_UNAVAILABLE = 'AI 导师服务尚未接入。你可以先阅读讲义、查看题目解析并完成测验；当前消息不会提交给模型。';
