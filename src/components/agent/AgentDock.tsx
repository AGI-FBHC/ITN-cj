/**
 * AgentDock — 伴学助手常驻 FAB + 可拖拽/可调宽悬浮侧边栏
 *
 * 顶部横条：按住拖拽移动侧边栏，松手吸附最近一侧
 * 侧边边缘：按住拖拽调整宽度（左浮→右边拖，右浮→左边拖）
 * 位置和宽度持久化到 localStorage
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useMotionValue, useTransform, animate } from 'framer-motion';
import { Brain, GripHorizontal, Maximize2, Plus, X } from 'lucide-react';
import { useAgent } from '@/context/AgentContext';
import { cn } from '@/lib/utils';
import { ChatStream } from '@/components/agent/ChatStream';

const SIDE_KEY = 'lf.agent-dock-side';
const WIDTH_KEY = 'lf.agent-dock-width';
const MIN_W = 300;
const MAX_W = Math.min(720, window.innerWidth * 0.55);
const DEFAULT_W = Math.min(440, window.innerWidth * 0.36);
const MARGIN = 12;

function readSide(): 'left' | 'right' {
  try { return localStorage.getItem(SIDE_KEY) === 'left' ? 'left' : 'right'; } catch { return 'right'; }
}
function writeSide(s: 'left' | 'right') {
  try { localStorage.setItem(SIDE_KEY, s); } catch { /* */ }
}
function readWidth(): number {
  try { const v = parseInt(localStorage.getItem(WIDTH_KEY) || '', 10); return v >= MIN_W && v <= MAX_W ? v : DEFAULT_W; } catch { return DEFAULT_W; }
}
function writeWidth(w: number) {
  try { localStorage.setItem(WIDTH_KEY, String(Math.round(w))); } catch { /* */ }
}

export default function AgentDock() {
  const { unread, open, setOpen, latestHint, sessions, currentSessionId, createAgentSession, switchAgentSession } = useAgent();
  const navigate = useNavigate();
  const location = useLocation();
  const inCourse = location.pathname.startsWith('/learn/');
  const inSlidePlayer = location.pathname.startsWith('/learn/slide/');

  const [side, setSide] = useState<'left' | 'right'>(readSide);
  const [panelW, setPanelW] = useState(readWidth);
  const panelWRef = useRef(panelW);
  const effectiveSide = inSlidePlayer ? 'right' : side;
  const effectivePanelW = inSlidePlayer ? Math.min(400, window.innerWidth - MARGIN * 2) : panelW;

  useEffect(() => { panelWRef.current = panelW; }, [panelW]);

  useEffect(() => {
    if (!inSlidePlayer || !open) {
      document.documentElement.style.removeProperty('--lf-slide-assistant-width');
      return;
    }
    document.documentElement.style.setProperty('--lf-slide-assistant-width', `${effectivePanelW + MARGIN * 2}px`);
    return () => { document.documentElement.style.removeProperty('--lf-slide-assistant-width'); };
  }, [effectivePanelW, inSlidePlayer, open]);

  /* Sessions are now lazy-created on first message in agentAsk.
     No auto-create needed here. */

  /* 隐藏规则 */
  const hidden = useMemo(() => {
    const p = location.pathname;
    return p.startsWith('/admin') || p === '/login' || p === '/welcome' || p === '/onboarding';
  }, [location.pathname]);

  /* ====== 拖拽移动 ====== */
  const dragX = useMotionValue(0);
  const startDragMove = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    const pt = 'touches' in e ? e.touches[0] : e;
    const startX = pt.clientX;
    dragX.set(0);

    const onMove = (ev: MouseEvent | TouchEvent) => {
      const p = 'touches' in ev ? ev.touches[0] : ev;
      dragX.set(p.clientX - startX);
    };
    const onEnd = () => {
      const offset = dragX.get();
      if (Math.abs(offset) > panelW * 0.2) {
        const newSide = offset > 0 ? 'right' : 'left';
        setSide(newSide);
        writeSide(newSide);
      }
      animate(dragX, 0, { type: 'spring', stiffness: 400, damping: 30 });
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
  }, [dragX, panelW]);

  /* ====== 拖拽调宽 ====== */
  const startResize = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const pt = 'touches' in e ? e.touches[0] : e;
    const startX = pt.clientX;
    const startW = panelWRef.current;
    const isLeft = side === 'left';

    const onMove = (ev: MouseEvent | TouchEvent) => {
      const p = 'touches' in ev ? ev.touches[0] : ev;
      const dx = p.clientX - startX;
      // 左浮：右边缘拖拽 → dx>0 变宽；右浮：左边缘拖拽 → dx<0 变宽
      const newW = isLeft ? startW + dx : startW - dx;
      const clamped = Math.max(MIN_W, Math.min(MAX_W, newW));
      setPanelW(clamped);
    };
    const onEnd = () => {
      writeWidth(panelWRef.current);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
  }, [side]);

  if (hidden) return null;

  const isLeft = effectiveSide === 'left';
  const baseX = isLeft ? MARGIN : window.innerWidth - effectivePanelW - MARGIN;
  const panelX = useTransform(dragX, (dx) => baseX + dx);

  return (
    <>
      {/* ===== FAB ===== */}
      <div className={cn(
        'fixed bottom-4 flex flex-col gap-2 md:bottom-6',
        inSlidePlayer ? 'z-[10010]' : 'z-40',
        isLeft ? 'left-4 md:left-6' : 'right-4 md:right-6',
      )}>
        <AnimatePresence>
          {!open && latestHint && !inCourse && (
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.95 }}
              className="max-w-[220px] rounded-xl border border-brand/20 bg-paper px-3 py-2 text-[11.5px] leading-[16px] text-ink shadow-warm-lg"
            >
              {latestHint}
            </motion.div>
          )}
        </AnimatePresence>

        <button
          type="button"
          onClick={() => setOpen(!open)}
          title="伴学助手"
          className={cn(
            'relative flex h-[52px] w-[52px] items-center justify-center rounded-full border-2 shadow-warm-lg transition-all duration-200 hover:scale-105',
            open ? 'border-brand bg-paper text-brand' : 'border-brand/20 bg-brand text-paper',
          )}
        >
          {open ? <X size={20} /> : <Brain size={22} />}
          {!open && unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-danger px-1 font-mono text-[10.5px] font-bold text-paper">
              {unread}
            </span>
          )}
          {!open && (
            <span className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 rounded-full border-2 border-brand bg-brand-success" />
          )}
        </button>
      </div>

      {/* ===== 悬浮侧边栏 ===== */}
      <AnimatePresence>
        {open && (
          <motion.div
            style={{ x: panelX, width: effectivePanelW }}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              inSlidePlayer
                ? 'fixed top-16 flex h-[calc(100dvh-76px)] flex-col overflow-visible'
                : 'fixed top-3 flex h-[calc(100dvh-24px)] flex-col overflow-visible',
              inSlidePlayer ? 'z-[10010]' : 'z-50',
              'rounded-2xl border border-white/60',
              'bg-gradient-to-b from-white/90 to-white/75 backdrop-blur-2xl',
              'shadow-[0_8px_40px_rgba(0,0,0,0.12),0_2px_12px_rgba(0,0,0,0.06)]',
            )}
            data-agent-dock
          >
            {/* 左/右边缘 resize 手柄 */}
            {!inSlidePlayer && <div
              onMouseDown={startResize}
              onTouchStart={startResize}
              className={cn(
                'absolute top-0 z-10 h-full w-[10px] cursor-col-resize',
                isLeft ? '-right-[5px]' : '-left-[5px]',
              )}
              title="拖动调整宽度"
            >
              <div className={cn(
                'absolute top-1/2 -translate-y-1/2 h-12 w-[5px] rounded-full transition-colors',
                isLeft ? 'right-0' : 'left-0',
                'bg-brand/15 hover:bg-brand/40',
              )} />
            </div>}

            {/* 顶部拖拽横条 + macOS 风格窗口按钮 */}
            <div
              onMouseDown={startDragMove}
              onTouchStart={startDragMove}
              className={cn('relative flex shrink-0 items-center justify-center py-1', inSlidePlayer ? 'cursor-default' : 'cursor-grab active:cursor-grabbing')}
            >
              <div className="flex h-[18px] w-12 items-center justify-center rounded-full bg-ink/[0.06] transition-colors hover:bg-ink/12">
                <GripHorizontal size={12} className="text-ink-muted/60" />
              </div>
              <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
                <button type="button" onClick={() => { setOpen(false); navigate('/chat'); }} title="全屏" onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} className="flex h-5 w-5 items-center justify-center rounded-full bg-[#28C840] text-paper shadow-sm transition-transform hover:scale-110">
                  <Maximize2 size={9} />
                </button>
                <button type="button" onClick={() => setOpen(false)} title="关闭" onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} className="flex h-5 w-5 items-center justify-center rounded-full bg-[#FF5F57] text-paper shadow-sm transition-transform hover:scale-110">
                  <X size={10} />
                </button>
              </div>
            </div>

            {/* 头 */}
            <div className="shrink-0 border-b border-black/[0.06] px-3 py-2">
              <div className="flex items-center gap-1.5">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand text-paper shadow-sm">
                  <Brain size={12} />
                </span>
                <p className="shrink-0 text-[13px] font-semibold text-ink">伴学助手</p>
                {sessions.length > 0 && (
                  <select
                    value={currentSessionId ?? ''}
                    onChange={(e) => { if (e.target.value) void switchAgentSession(e.target.value); }}
                    className="min-w-0 flex-1 truncate rounded-md border border-hairline bg-white/80 px-1.5 py-0.5 text-[10px] text-ink outline-none"
                  >
                    {sessions.map((s) => (
                      <option key={s.id} value={s.id}>{s.title || '未命名对话'}</option>
                    ))}
                  </select>
                )}
                <button type="button" onClick={() => void createAgentSession()} title="新建会话" className="lf-row-btn !p-1">
                  <Plus size={11} />
                </button>
              </div>
            </div>

            {/* 消息流 + composer */}
            <ChatStream compact pageContext={location.pathname} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
