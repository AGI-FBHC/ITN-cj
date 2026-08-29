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
const DEFAULT_W = Math.min(480, window.innerWidth * 0.38);
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

  const [side, setSide] = useState<'left' | 'right'>(readSide);
  const [panelW, setPanelW] = useState(readWidth);

  /* 每次切换页面后首次打开侧边栏，自动新建会话 */
  const lastPathRef = useRef<string>('');
  useEffect(() => {
    if (open && location.pathname !== lastPathRef.current) {
      lastPathRef.current = location.pathname;
      requestAnimationFrame(() => { void createAgentSession(); });
    }
  }, [open, location.pathname, createAgentSession]);

  /* 隐藏规则 */
  const hidden = useMemo(() => {
    const p = location.pathname;
    return p.startsWith('/admin') || p === '/login' || p === '/welcome' || p === '/onboarding';
  }, [location.pathname]);

  /* Escape 关闭 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && open) setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

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
      // 拖到屏幕边缘 → 自动收起
      if (Math.abs(offset) > window.innerWidth * 0.35) {
        setOpen(false);
        dragX.set(0);
        return;
      }
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
    const startW = panelW;
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
      writeWidth(panelW);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
  }, [panelW, side]);

  if (hidden) return null;

  const isLeft = side === 'left';
  const baseX = isLeft ? MARGIN : window.innerWidth - panelW - MARGIN;
  const panelX = useTransform(dragX, (dx) => baseX + dx);

  return (
    <>
      {/* ===== FAB ===== */}
      <div className={cn(
        'fixed bottom-4 z-40 flex flex-col gap-2 md:bottom-6',
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
            style={{ x: panelX, width: panelW }}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              'fixed top-3 z-50 flex h-[calc(100dvh-24px)] flex-col overflow-visible',
              'rounded-2xl border border-white/60',
              'bg-gradient-to-b from-white/90 to-white/75 backdrop-blur-2xl',
              'shadow-[0_8px_40px_rgba(0,0,0,0.12),0_2px_12px_rgba(0,0,0,0.06)]',
            )}
          >
            {/* 左/右边缘 resize 手柄 */}
            <div
              onMouseDown={startResize}
              onTouchStart={startResize}
              className={cn(
                'absolute top-0 z-10 h-full w-[6px] cursor-col-resize',
                isLeft ? '-right-[3px]' : '-left-[3px]',
              )}
            >
              <div className={cn(
                'absolute top-1/2 -translate-y-1/2 h-10 w-[3px] rounded-full transition-colors',
                isLeft ? 'right-0' : 'left-0',
                'bg-transparent hover:bg-brand/30',
              )} />
            </div>

            {/* 顶部拖拽横条 */}
            <div
              onMouseDown={startDragMove}
              onTouchStart={startDragMove}
              className="flex shrink-0 cursor-grab items-center justify-center py-1 active:cursor-grabbing"
            >
              <div className="flex h-[18px] w-12 items-center justify-center rounded-full bg-ink/[0.06] transition-colors hover:bg-ink/12">
                <GripHorizontal size={12} className="text-ink-muted/60" />
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
                <button type="button" onClick={() => { setOpen(false); navigate('/chat'); }} title="全屏" className="lf-row-btn !p-1">
                  <Maximize2 size={12} />
                </button>
                <button type="button" onClick={() => setOpen(false)} title="收起" className="lf-row-btn !p-1">
                  <X size={12} />
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
