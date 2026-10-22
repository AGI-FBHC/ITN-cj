/**
 * CountUp — easeOutQuart 数字滚动（进入视口触发，1000-1200ms）
 * 画像页 / 报告页共用的页面级工具
 */
import { useEffect, useRef, useState } from 'react';

export function useCountUp(target: number, start: boolean, duration = 1000): number {
  const [value, setValue] = useState(0);
  const rafRef = useRef<number>(0);
  useEffect(() => {
    if (!start) return;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 4);
      setValue(target * eased);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [start, target, duration]);
  return value;
}

export function formatNum(v: number, decimals = 0): string {
  return v.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
