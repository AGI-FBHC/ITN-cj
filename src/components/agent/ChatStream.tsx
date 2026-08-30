/**
 * ChatStream — 共享的消息流 + composer 组件
 *
 * 被 AiChat 页面和 AgentDockSidebar 侧边栏复用。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { Brain, Check, ChevronDown, Eye, NotebookPen, Pencil, Plus, SendHorizonal, Trash2, X } from 'lucide-react';
import { useAgent } from '@/context/AgentContext';
import type { AgentMessage } from '@/context/AgentContext';
import { cn } from '@/lib/utils';
import { collectLearningPageContext, describeLearningPageContext } from '@/lib/pageContext';
import type { LearningPageContext } from '@/lib/pageContext';

/* ===== 消息气泡 ===== */
function MessageBubble({ message }: { message: AgentMessage }) {
  const isUser = message.kind === 'user';
  const text = 'text' in message ? message.text : '';
  const visibleText = isUser ? text.replace(/^\s*\[当前页面[：:]\s*[^\]]+\]\s*/, '') : text;
  const loading = 'loading' in message ? message.loading : false;
  if (message.kind === 'verify') return null;
  if (message.kind === 'note') return (
    <div className="flex justify-start">
      <div className="w-[88%] rounded-2xl rounded-bl-md border border-brand/20 bg-brand-tint/30 p-3.5">
        <div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-paper"><NotebookPen size={13} /></span><div className="min-w-0"><div className="text-[10px] text-brand">已保存到笔记本</div><div className="truncate text-[13px] font-semibold text-ink">{message.title}</div></div></div>
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[11.5px] leading-5 text-ink-2">{message.text}</p>
        <Link to="/me/notes" className="mt-2 inline-flex text-[11px] font-medium text-brand hover:underline">查看笔记</Link>
      </div>
    </div>
  );
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn(
        'max-w-[85%] rounded-2xl px-4 py-2.5 text-[13px] leading-[1.7]',
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
          <div className="whitespace-pre-wrap">{visibleText}</div>
        )}
      </div>
    </div>
  );
}

/* ===== 消息流 + composer ===== */
export function ChatStream({ compact = false, pageContext }: { compact?: boolean; pageContext?: string }) {
  const { messages, askFree, suggestions, weakest } = useAgent();
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [currentContext, setCurrentContext] = useState<LearningPageContext>(() => collectLearningPageContext());

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const refresh = () => setCurrentContext(collectLearningPageContext());
    refresh();
    const timer = window.setInterval(refresh, 1500);
    document.addEventListener('selectionchange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('selectionchange', refresh); };
  }, [pageContext]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    const snapshot = collectLearningPageContext();
    setCurrentContext(snapshot);
    askFree(text, snapshot);
    setInput('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const resizeInput = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, compact ? 80 : 140)}px`;
  };

  const welcomeSuggestions = (() => {
    if (suggestions.length) return suggestions.map((s) => s.text);
    return weakest
      ? [`帮我理解「${weakest.name}」的核心概念`, `${weakest.name}有哪些常见错误？`]
      : ['今天想学什么？', '帮我解释一个概念'];
  })();

  return (
    <>
      <div className="shrink-0 border-b border-hairline/70 bg-brand-tint/20 px-3 py-2">
        <button type="button" onClick={() => setContextOpen((value) => !value)} className="flex w-full items-center gap-2 text-left" aria-expanded={contextOpen}>
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-brand/15 bg-paper text-brand"><Eye size={12} /></span>
          <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-ink-2">当前所见：{describeLearningPageContext(currentContext)}</span>
          <ChevronDown size={12} className={cn('shrink-0 text-ink-muted transition-transform', contextOpen && 'rotate-180')} />
        </button>
        {contextOpen && (
          <div className="mt-2 rounded-xl border border-hairline/70 bg-paper/80 px-3 py-2 text-[10.5px] leading-5 text-ink-muted">
            <p>{currentContext.selection ? '将优先使用选中的文字' : currentContext.focus ? `当前焦点：${currentContext.focus.title || currentContext.focus.kind}` : '当前没有选中文字或专属卡片'}</p>
            <p className="mt-0.5">可见内容约 {currentContext.visibleText.length} 字{currentContext.entities.resourceOrTaskId ? ' · 已关联当前资源' : ''}</p>
          </div>
        )}
      </div>
      {/* 消息流 */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="mx-auto max-w-[400px] pt-[8vh] text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-brand text-paper">
              <Brain size={20} />
            </div>
            <h3 className={cn('font-bold text-ink', compact ? 'text-[15px]' : 'text-[18px]')}>
              今天想学什么？
            </h3>
            <p className="mt-1 text-[12px] text-ink-muted">直接提问、解释概念、生成练习</p>
            <div className={cn('mt-4 gap-2', compact ? 'grid grid-cols-1' : 'grid grid-cols-2')}>
              {welcomeSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => askFree(s)}
                  className="rounded-xl border border-hairline bg-paper px-3 py-2 text-left text-[12px] text-ink transition hover:border-brand/40 hover:bg-brand-tint/20"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((m) => <MessageBubble key={m.id} message={m} />)}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-hairline px-3 py-2">
        <div className="flex items-end gap-2 rounded-xl border border-hairline bg-paper px-2.5 py-1.5">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); resizeInput(); }}
            onKeyDown={handleKeyDown}
            placeholder="输入你的问题…"
            rows={1}
            className={cn(
              'min-h-[24px] flex-1 resize-none bg-transparent text-[13px] leading-[1.6] text-ink outline-none placeholder:text-ink-muted',
              compact ? 'max-h-[80px]' : 'max-h-[140px]',
            )}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim()}
            className="shrink-0 rounded-lg bg-ink px-2.5 py-1.5 text-paper transition hover:opacity-90 disabled:opacity-30"
          >
            <SendHorizonal size={14} />
          </button>
        </div>
      </div>
    </>
  );
}

/* ===== 会话列表（全屏页面用） ===== */
export function SessionList() {
  const { sessions, currentSessionId, createAgentSession, switchAgentSession, deleteAgentSession, renameAgentSession } = useAgent();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');

  return (
    <>
      <div className="shrink-0 border-b border-hairline px-3 py-2">
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
              {editingId === s.id ? <input autoFocus value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Enter' && draftTitle.trim()) { event.stopPropagation(); void renameAgentSession(s.id, draftTitle).then(() => setEditingId(null)); } if (event.key === 'Escape') setEditingId(null); }} className="w-full rounded-md border border-brand/30 bg-paper px-2 py-1 text-[12px] text-ink outline-none" /> : <p className="truncate text-[12px] font-medium text-ink">{s.title || '未命名对话'}</p>}
              <p className="truncate text-[10px] text-ink-muted">{s.sessionType || ''}</p>
            </div>
            {editingId === s.id ? <><button type="button" onClick={(event) => { event.stopPropagation(); if (draftTitle.trim()) void renameAgentSession(s.id, draftTitle).then(() => setEditingId(null)); }} className="shrink-0 rounded-md p-1 text-brand"><Check size={12} /></button><button type="button" onClick={(event) => { event.stopPropagation(); setEditingId(null); }} className="shrink-0 rounded-md p-1 text-ink-muted"><X size={12} /></button></> : <button type="button" onClick={(event) => { event.stopPropagation(); setEditingId(s.id); setDraftTitle(s.title || ''); }} className="hidden shrink-0 rounded-md p-1 text-ink-muted transition hover:bg-brand-tint hover:text-brand group-hover:block"><Pencil size={12} /></button>}
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
    </>
  );
}
