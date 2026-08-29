/**
 * AiChat — 独立 AI 对话页面
 *
 * 布局参考 INT-Slim/Chat.vue：
 * - 左栏：会话列表（新建 / 切换 / 删除）
 * - 右栏：消息流 + 底部 composer
 *
 * 复用 AgentContext 的全部 API（sessions, messages, askFree 等）。
 * 从 AgentDock FAB 跳转进入，替代原来的右侧滑出面板。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Brain, Plus, SendHorizonal, Trash2 } from 'lucide-react';
import { useAgent } from '@/context/AgentContext';
import { cn } from '@/lib/utils';

import type { AgentMessage } from '@/context/AgentContext';

export default function AiChat() {
  const navigate = useNavigate();
  const {
    messages, sessions, currentSessionId,
    createAgentSession, switchAgentSession, deleteAgentSession,
    askFree, suggestions, weakest,
  } = useAgent();

  const [input, setInput] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* 自动滚到底部 */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  /* 自动聚焦输入框 */
  useEffect(() => { inputRef.current?.focus(); }, [currentSessionId]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    askFree(text);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  /* 自动调整 textarea 高度 */
  const resizeInput = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  };

  const welcomeSuggestions = useMemo(() => {
    if (suggestions.length) return suggestions.map((s) => s.text);
    return weakest
      ? [`帮我理解「${weakest.name}」的核心概念`, `${weakest.name}有哪些常见错误？`, `给我出一道${weakest.name}的练习题`]
      : ['今天想学什么？', '帮我解释一个概念', '给我出一道练习题'];
  }, [suggestions, weakest]);

  return (
    <div className="mx-auto flex h-[calc(100dvh-80px)] max-w-[1200px] gap-3 overflow-hidden px-4 pb-2 pt-2">
      {/* ===== 左栏：会话列表 ===== */}
      <aside className={cn(
        'hidden w-[240px] shrink-0 flex-col overflow-hidden rounded-2xl border border-hairline bg-paper/60 lg:flex',
      )}>
        <div className="shrink-0 border-b border-hairline px-3 py-2.5">
          <button
            type="button"
            onClick={() => void createAgentSession()}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-hairline bg-ink py-2 text-[13px] font-semibold text-paper transition hover:opacity-90"
          >
            <Plus size={14} />新对话
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {sessions.length === 0 && (
            <p className="px-2 py-6 text-center text-[12px] text-ink-muted">暂无对话</p>
          )}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={cn(
                'group mb-0.5 flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 transition',
                s.id === currentSessionId ? 'bg-brand-tint/50' : 'hover:bg-paper-deep',
              )}
              onClick={() => void switchAgentSession(s.id)}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-medium text-ink">{s.title || '未命名对话'}</p>
                <p className="truncate text-[10px] text-ink-muted">{s.sessionType || ''}</p>
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); void deleteAgentSession(s.id); }}
                className="hidden shrink-0 rounded-md p-1 text-ink-muted transition hover:bg-brand-danger/10 hover:text-brand-danger group-hover:block"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* ===== 右栏：消息流 + composer ===== */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-hairline bg-paper/60">
        {/* 顶栏 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-4 py-2.5">
          <button type="button" onClick={() => navigate(-1)} className="lf-row-btn !p-1.5">
            <ArrowLeft size={14} />
          </button>
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-paper">
            <Brain size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-ink">阿诊 · AI 学习助手</p>
            <p className="text-[10px] text-ink-muted">DIA-01 学情诊断</p>
          </div>
        </div>

        {/* 消息流 */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {messages.length === 0 ? (
            /* 欢迎页 */
            <div className="mx-auto max-w-[560px] pt-[12vh] text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-paper">
                <Brain size={28} />
              </div>
              <h2 className="text-[22px] font-bold text-ink">今天想学什么？</h2>
              <p className="mt-2 text-[13px] text-ink-muted">可以直接提问、让它解释概念、生成练习，或帮你拆解一段不理解的内容。</p>
              <div className="mt-6 grid grid-cols-2 gap-2">
                {welcomeSuggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => { askFree(s); }}
                    className="rounded-xl border border-hairline bg-paper px-3 py-2.5 text-left text-[12.5px] text-ink transition hover:border-brand/40 hover:bg-brand-tint/20"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* 消息列表 */
            <div className="mx-auto max-w-[720px] space-y-4">
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="shrink-0 border-t border-hairline px-4 py-3">
          <div className="mx-auto flex max-w-[720px] items-end gap-2 rounded-2xl border border-hairline bg-paper px-3 py-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => { setInput(e.target.value); resizeInput(); }}
              onKeyDown={handleKeyDown}
              placeholder="输入你的问题…"
              rows={1}
              className="max-h-[140px] min-h-[28px] flex-1 resize-none bg-transparent text-[13.5px] leading-[1.7] text-ink outline-none placeholder:text-ink-muted"
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={!input.trim()}
              className="shrink-0 rounded-xl bg-ink px-3 py-2 text-paper transition hover:opacity-90 disabled:opacity-30"
            >
              <SendHorizonal size={16} />
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

/* ===== 消息气泡 ===== */
function MessageBubble({ message }: { message: AgentMessage }) {
  const isUser = message.kind === 'user';
  const text = 'text' in message ? message.text : '';
  const loading = 'loading' in message ? message.loading : false;
  if (message.kind === 'verify') return null; // 验证题单独处理，此处跳过
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn(
        'max-w-[85%] rounded-2xl px-4 py-2.5 text-[13.5px] leading-[1.7]',
        isUser
          ? 'rounded-br-md bg-ink text-paper'
          : 'rounded-bl-md border border-hairline bg-paper text-ink',
      )}>
        {loading && !text ? (
          <span className="inline-flex gap-1 text-ink-muted">
            <span className="animate-pulse">●</span>
            <span className="animate-pulse" style={{ animationDelay: '0.15s' }}>●</span>
            <span className="animate-pulse" style={{ animationDelay: '0.3s' }}>●</span>
          </span>
        ) : (
          <div className="whitespace-pre-wrap">{text}</div>
        )}
      </div>
    </div>
  );
}
