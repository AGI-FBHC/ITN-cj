import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Flame, NotebookPen, Sprout, TriangleAlert } from 'lucide-react';
import { useAgent } from '@/context/AgentContext';
import { useCustomizeActivity } from '@/context/CustomizeActivityContext';
import { cn } from '@/lib/utils';

/**
 * CompanionPet —「小鼋助手」常驻角色（移植自旧版 Vue 桌宠 DesktopPet 的核心交互）。
 *
 * 保留：完整动作状态机（idle/breathe/blink/wake/listen/think/speak/working/success）、
 *       拖拽定位（位置存 localStorage `itn.petPos`，仅界面偏好）、随系统状态自动变帧。
 * 简化：旧版桌宠自带录音 + ASR + TTS + 助手动作编排；当前版本改为把「提问/语音」交给
 *       已有且更完整的伴学助手浮窗（`useAgent().setOpen`），避免两套语音链路并存。
 */
type PetState =
  | 'idle' | 'breathe' | 'blink' | 'wake'
  | 'listen-1' | 'listen-2' | 'think-1' | 'think-2'
  | 'speak-1' | 'speak-2' | 'working' | 'success';

const FRAME_SEQUENCES: Record<PetState, PetState[]> = {
  idle: ['idle', 'idle', 'breathe', 'breathe', 'idle', 'blink', 'idle'],
  breathe: ['idle', 'breathe', 'breathe', 'idle'],
  blink: ['idle', 'blink', 'idle'],
  wake: ['idle', 'breathe', 'wake', 'wake', 'success', 'wake'],
  'listen-1': ['wake', 'listen-1', 'listen-1', 'listen-2', 'listen-2', 'listen-1'],
  'listen-2': ['listen-1', 'listen-1', 'listen-2', 'listen-2'],
  'think-1': ['listen-2', 'think-1', 'think-1', 'think-2', 'think-2', 'think-1'],
  'think-2': ['think-1', 'think-1', 'think-2', 'think-2'],
  'speak-1': ['think-2', 'speak-1', 'speak-2', 'speak-1', 'speak-2', 'speak-1', 'speak-1'],
  'speak-2': ['speak-1', 'speak-2', 'speak-1', 'speak-2', 'speak-2', 'speak-1'],
  working: ['think-2', 'working', 'working', 'think-1', 'working'],
  success: ['working', 'wake', 'success', 'success', 'wake'],
};

const STATE_LABELS: Record<PetState, string> = {
  idle: '待机', breathe: '呼吸', blink: '眨眼', wake: '唤醒',
  'listen-1': '倾听', 'listen-2': '倾听', 'think-1': '思考', 'think-2': '思考',
  'speak-1': '回答', 'speak-2': '回答', working: '执行中', success: '完成',
};

/** 每帧时长：说话/思考快一点，待机慢一点 */
const FRAME_MS: Partial<Record<PetState, number>> = {
  idle: 520, breathe: 460, blink: 220, wake: 240,
  working: 320, success: 260,
};

const PET_SIZE = 96;
const DEFAULT_OFFSET = { x: 0, y: 0 };

function clamp(x: number, y: number) {
  if (typeof window === 'undefined') return { x, y };
  const w = window.innerWidth;
  const h = window.innerHeight;
  const baseLeft = w - 16 - PET_SIZE;
  const baseTop = h - 160 - PET_SIZE;
  return {
    x: Math.max(Math.min(x, baseLeft), -baseLeft + 8),
    y: Math.max(Math.min(y, 8), -baseTop + 8),
  };
}

export default function CompanionPet() {
  const { isResponding } = useAgent();
  const navigate = useNavigate();
  const { activeTasks } = useCustomizeActivity();
  const location = useLocation();
  const [openPanel, setOpenPanel] = useState(false);
  const [position, setPosition] = useState(DEFAULT_OFFSET);
  const [frame, setFrame] = useState<PetState>('idle');
  const [successFlash, setSuccessFlash] = useState(false);
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, baseX: 0, baseY: 0 });
  const prevResponding = useRef(false);

  /* 系统状态 → 角色状态：等待回答/生成中/被点开/待机 */
  const state: PetState = useMemo(() => {
    if (successFlash) return 'success';
    if (isResponding) return 'speak-1';
    if (activeTasks.length > 0) return 'working';
    if (openPanel) return 'wake';
    return 'idle';
  }, [successFlash, isResponding, activeTasks.length, openPanel]);

  /* 回答结束闪一下「完成」，让角色有反馈 */
  useEffect(() => {
    if (prevResponding.current && !isResponding) {
      setSuccessFlash(true);
      const timer = window.setTimeout(() => setSuccessFlash(false), 1100);
      return () => window.clearTimeout(timer);
    }
    prevResponding.current = isResponding;
    return undefined;
  }, [isResponding]);

  /* 帧循环 */
  useEffect(() => {
    const sequence = FRAME_SEQUENCES[state] ?? FRAME_SEQUENCES.idle;
    let index = 0;
    setFrame(sequence[0]);
    const timer = window.setInterval(() => {
      index = (index + 1) % sequence.length;
      setFrame(sequence[index]);
    }, FRAME_MS[state] ?? 260);
    return () => window.clearInterval(timer);
  }, [state]);

  /* 位置：读取/持久化（纯界面偏好） */
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('itn.petPos');
      if (raw) {
        const parsed = JSON.parse(raw) as { x: number; y: number };
        setPosition(clamp(Number(parsed.x) || 0, Number(parsed.y) || 0));
      }
    } catch { /* ignore */ }
  }, []);

  const onPointerDown = useCallback((event: React.MouseEvent | React.TouchEvent) => {
    const point = 'touches' in event ? event.touches[0] : (event as React.MouseEvent);
    if (!point) return;
    dragging.current = true;
    dragStart.current = { x: point.clientX, y: point.clientY, baseX: position.x, baseY: position.y };
  }, [position.x, position.y]);

  useEffect(() => {
    const onMove = (event: MouseEvent | TouchEvent) => {
      if (!dragging.current) return;
      const point = 'touches' in event ? event.touches[0] : (event as MouseEvent);
      if (!point) return;
      const moved = Math.abs(point.clientX - dragStart.current.x) + Math.abs(point.clientY - dragStart.current.y);
      if (moved < 6) return;
      event.preventDefault?.();
      setPosition(clamp(dragStart.current.baseX + (point.clientX - dragStart.current.x), dragStart.current.baseY + (point.clientY - dragStart.current.y)));
    };
    const onUp = (event: MouseEvent | TouchEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      const point = 'changedTouches' in event ? event.changedTouches[0] : (event as MouseEvent);
      if (!point) return;
      const moved = Math.abs(point.clientX - dragStart.current.x) + Math.abs(point.clientY - dragStart.current.y);
      if (moved < 6) {
        setOpenPanel((value) => !value); // 视为点击
      } else {
        setPosition((current) => {
          try { window.localStorage.setItem('itn.petPos', JSON.stringify(current)); } catch { /* ignore */ }
          return current;
        });
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
    document.addEventListener('touchcancel', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      document.removeEventListener('touchcancel', onUp);
    };
  }, []);

  /* 幻灯播放器等全屏场景不显示，避免遮挡 */
  if (location.pathname.startsWith('/learn/slide/')) return null;

  const bubble = successFlash
    ? '搞定！继续下一题吧'
    : isResponding
      ? '我在整理回答…'
      : activeTasks.length > 0
        ? `正在生成 ${activeTasks.length} 项内容…`
        : openPanel
          ? '嗨，我是小鼋助手。想去哪儿？'
          : '';

  const entries = [
    { to: '/rankings', label: '持续热学榜', icon: Flame },
    { to: '/me/notes', label: '我的笔记', icon: NotebookPen },
    { to: '/me/wrong', label: '错题本', icon: TriangleAlert },
    { to: '/resources', label: '我的资源', icon: Sprout },
  ];

  return (
    <div
      className="fixed bottom-40 right-4 z-[9990] hidden select-none md:block"
      style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
    >
      {openPanel && (
        <div className="mb-2 w-[248px] rounded-[16px] border border-brand/25 bg-card-warm p-3 shadow-warm-lg">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[9.5px] tracking-[0.14em] text-ink-muted">COMPANION · {STATE_LABELS[state]}</span>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-5 text-ink-2">{bubble || '嗨，我是小鼋助手。想去哪儿？'}</p>
          <div className="mt-2.5 grid grid-cols-2 gap-1.5">
            {entries.map((entry) => (
              <Link
                key={entry.to}
                to={entry.to}
                onClick={() => setOpenPanel(false)}
                className="flex items-center gap-1.5 rounded-[10px] border border-hairline bg-paper px-2 py-1.5 text-[11.5px] text-ink-2 transition-colors hover:border-brand/35 hover:text-brand"
              >
                <entry.icon size={12} />
                {entry.label}
              </Link>
            ))}
          </div>
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              onClick={() => { setOpenPanel(false); navigate('/learn'); }}
              className="lf-btn-primary flex-1 justify-center !py-1.5 text-[11.5px]"
            >
              问伴学助手
            </button>
            <button type="button" onClick={() => setOpenPanel(false)} className="lf-btn-ghost !px-2.5 !py-1.5 text-[11.5px]">
              收起
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        aria-label={`伴学角色小鼋（${STATE_LABELS[state]}），点击展开快捷入口`}
        title={`小鼋助手 · ${STATE_LABELS[state]} · 可拖拽`}
        onMouseDown={onPointerDown}
        onTouchStart={onPointerDown}
        className={cn(
          'block w-[96px] cursor-grab active:cursor-grabbing transition-transform duration-200',
          !openPanel && 'hover:-translate-y-0.5',
        )}
      >
        <img
          src={`/mascot/xiaoyuanlong-${frame}.png`}
          alt=""
          draggable={false}
          className="h-[96px] w-[96px] object-contain drop-shadow-[0_10px_18px_rgba(44,63,52,0.18)]"
        />
      </button>
    </div>
  );
}
