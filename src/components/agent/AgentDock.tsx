/**
 * AgentDock — 「伴学助手」常驻 FAB + 1/3 屏侧边栏
 *
 * FAB 点击 → 打开侧边栏（ChatStream compact 模式）
 * 侧边栏有"全屏"按钮 → 跳转 /chat 独立页面
 */
import { useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Brain, Maximize2, Plus, X } from 'lucide-react';
import { useAgent } from '@/context/AgentContext';
import { useProfile } from '@/context/ProfileContext';

import { cn } from '@/lib/utils';
import { ChatStream } from '@/components/agent/ChatStream';

export default function AgentDock() {
  const { unread, open, setOpen, latestHint, sessions, currentSessionId, createAgentSession, switchAgentSession } = useAgent();
  const { currentLearner, viewMode } = useProfile();
  const isExpert = viewMode === 'expert';
  const navigate = useNavigate();
  const location = useLocation();
  const inCourse = location.pathname.startsWith('/learn/');

  /* 每次切换页面后首次打开侧边栏，自动新建会话 */
  const lastPathRef = useRef<string>('');
  useEffect(() => {
    if (open && location.pathname !== lastPathRef.current) {
      lastPathRef.current = location.pathname;
      // 延迟一帧等 AgentContext 就绪
      requestAnimationFrame(() => {
        void createAgentSession();
      });
    }
  }, [open, location.pathname, createAgentSession]);

  /* 隐藏规则：管理页面、登录页、引导页不显示 FAB */
  const hidden = useMemo(() => {
    const p = location.pathname;
    return p.startsWith('/admin') || p === '/login' || p === '/welcome' || p === '/onboarding';
  }, [location.pathname]);

  /* 全局键盘快捷键：Escape 关闭 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && open) setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (hidden) return null;

  return (
    <>
      {/* ===== FAB ===== */}
      <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2 md:bottom-6 md:right-6">
        {/* 推断气泡 */}
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
          title={isExpert ? 'DIA-01 决策日志' : '伴学助手 · AI 学习助手'}
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

      {/* ===== 侧边栏（1/3 屏） ===== */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            className="fixed inset-y-0 right-0 z-50 flex h-dvh w-[min(520px,44vw)] flex-col overflow-hidden rounded-l-[20px] border-l border-hairline bg-paper shadow-warm-lg"
          >
            {/* 头 */}
            <div className="shrink-0 border-b border-hairline px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-paper">
                  <Brain size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-ink">伴学助手 · AI 学习助手</p>
                  <p className="text-[9px] text-ink-muted">DIA-01 学情诊断 · {currentLearner.name}</p>
                </div>
                <button type="button" onClick={() => { setOpen(false); navigate('/chat'); }} title="全屏对话" className="lf-row-btn !p-1.5">
                  <Maximize2 size={13} />
                </button>
                <button type="button" onClick={() => setOpen(false)} title="收起" className="lf-row-btn !p-1.5">
                  <X size={13} />
                </button>
              </div>
              {/* 会话切换 */}
              {sessions.length > 0 && (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <select
                    value={currentSessionId ?? ''}
                    onChange={(e) => { if (e.target.value) void switchAgentSession(e.target.value); }}
                    className="min-w-0 flex-1 rounded-md border border-hairline bg-paper px-2 py-1 text-[10.5px] text-ink outline-none"
                  >
                    {sessions.map((s) => (
                      <option key={s.id} value={s.id}>{s.title || '未命名对话'}</option>
                    ))}
                  </select>
                  <button type="button" onClick={() => void createAgentSession()} title="新建会话" className="lf-row-btn !p-1">
                    <Plus size={12} />
                  </button>
                </div>
              )}
              {/* 当前页面上下文标签 */}
              <div className="mt-1.5 flex items-center gap-1">
                <span className="rounded-full bg-brand-tint px-2 py-0.5 text-[9px] text-brand">
                  {location.pathname.startsWith('/learn/') ? '学习中' : location.pathname === '/me/profile' ? '画像页' : location.pathname === '/me' ? '首页' : location.pathname}
                </span>
              </div>
            </div>

            {/* 消息流 + composer（compact 模式） */}
            <ChatStream compact pageContext={location.pathname} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
