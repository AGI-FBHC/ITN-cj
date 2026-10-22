import { useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { api, getToken } from '@/lib/api';

/**
 * 全局学习计时：只要停留在学习相关页面（/learn 及其子路由），
 * 按可见时长每 60 秒把增量写入 learning_events（STUDY_END），
 * 页面隐藏/关闭时用 keepalive 补报，避免"学了但时长不记"。
 */

const IDLE_LIMIT_MS = 10 * 60_000;

interface StudySource {
  id: string;
  type: string;
  path: string;
}

/** 根据路由判断当前是否处于学习场景，并给出事件来源。 */
function resolveSource(pathname: string): StudySource | null {
  if (!pathname.startsWith('/learn')) return null;
  /* 定制生成流程不算学习时长 */
  if (pathname.startsWith('/learn/customize')) return null;

  const resource = pathname.match(/^\/learn\/resource\/([^/?#]+)/);
  if (resource) {
    return { id: decodeURIComponent(resource[1]), type: 'RESOURCE', path: pathname };
  }
  const slideResource = pathname.match(/^\/learn\/slide\/resource\/([^/?#]+)/);
  if (slideResource) {
    return { id: decodeURIComponent(slideResource[1]), type: 'RESOURCE', path: pathname };
  }
  const slide = pathname.match(/^\/learn\/slide\/([^/?#]+)/);
  if (slide) {
    return { id: decodeURIComponent(slide[1]), type: 'PRESENTATION', path: pathname };
  }
  const unit = pathname.match(/^\/learn\/([^/?#]+)/);
  if (unit) {
    return { id: decodeURIComponent(unit[1]), type: 'KNOWLEDGE_BASE', path: pathname };
  }
  return { id: 'learn', type: 'KNOWLEDGE_BASE', path: pathname };
}

function keepalivePost(payload: Record<string, unknown>): void {
  const token = getToken();
  if (!token) return;
  void fetch('/api/v1/learner-profile/events', {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  }).catch(() => undefined);
}

export function useStudyTimeTracker(): void {
  const location = useLocation();
  const sourceRef = useRef<StudySource | null>(null);
  const secondsRef = useRef(0);
  const reportedRef = useRef(0);
  const lastActivityRef = useRef(Date.now());

  const flush = useCallback((keepalive = false) => {
    const source = sourceRef.current;
    const delta = secondsRef.current - reportedRef.current;
    if (!source || delta < 5 || !getToken()) return;
    reportedRef.current = secondsRef.current;
    const payload = {
      eventType: 'STUDY_END',
      sourceType: source.type,
      sourceId: source.id,
      durationSeconds: delta,
      metadata: JSON.stringify({ auto: true, path: source.path, source: 'study-time-tracker' }),
    };
    if (keepalive) {
      keepalivePost(payload);
      return;
    }
    void api.recordLearningEvent(payload).catch(() => undefined);
  }, []);

  /* 记录用户活动，长时间无操作（10 分钟）后停止计时，避免挂机刷时长 */
  useEffect(() => {
    const markActive = () => { lastActivityRef.current = Date.now(); };
    const events: Array<keyof WindowEventMap> = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'wheel'];
    events.forEach((name) => window.addEventListener(name, markActive, { passive: true }));
    return () => events.forEach((name) => window.removeEventListener(name, markActive));
  }, []);

  /* 路由切换：先结算上一个页面的时长，再重置计时 */
  useEffect(() => {
    flush();
    sourceRef.current = resolveSource(location.pathname);
    secondsRef.current = 0;
    reportedRef.current = 0;
    lastActivityRef.current = Date.now();
  }, [location.pathname, flush]);

  /* 每秒累计 + 每 60 秒落库 + 页面隐藏/关闭补报 */
  useEffect(() => {
    const tick = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!sourceRef.current || !getToken()) return;
      if (Date.now() - lastActivityRef.current > IDLE_LIMIT_MS) return;
      secondsRef.current += 1;
    }, 1000);
    const timer = window.setInterval(() => flush(), 60_000);
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(true); };
    const onPageHide = () => flush(true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      flush();
    };
  }, [flush]);
}

export default useStudyTimeTracker;
