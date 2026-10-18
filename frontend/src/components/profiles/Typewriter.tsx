/**
 * Typewriter — 打字机流式文本（16ms/字，首次进入视口播放一次）
 */
import { useEffect, useRef, useState } from 'react';
import { useInView } from 'framer-motion';
import { cn } from '@/lib/utils';

export default function Typewriter({
  text,
  speed = 16,
  className,
}: {
  text: string;
  speed?: number;
  className?: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const [n, setN] = useState(0);
  const done = n >= text.length;

  useEffect(() => {
    if (!inView) return;
    const timer = setInterval(() => {
      setN((v) => {
        if (v >= text.length) {
          clearInterval(timer);
          return v;
        }
        return v + 1;
      });
    }, speed);
    return () => clearInterval(timer);
  }, [inView, text, speed]);

  return (
    <p ref={ref} className={cn('whitespace-pre-wrap', className)}>
      {text.slice(0, n)}
      {!done && (
        <span className="ml-0.5 inline-block h-[14px] w-[7px] translate-y-[2px] animate-caret-blink bg-brand/70" />
      )}
    </p>
  );
}
