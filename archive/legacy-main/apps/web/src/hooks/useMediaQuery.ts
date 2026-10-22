/**
 * useMediaQuery — 让 JS 知道当前命中哪个断点。
 * 用途：当某个功能在窄屏被 CSS 隐藏时，代码要能感知到并提供替代入口
 *（原则：响应式应当「降级」，不能让功能凭空消失）。
 */
import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
