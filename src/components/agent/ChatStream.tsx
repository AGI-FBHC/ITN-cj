/**
 * ChatStream — 共享的消息流 + composer 组件
 *
 * 被 AiChat 页面和 AgentDockSidebar 侧边栏复用。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Brain, Check, ChevronDown, Eye, EyeOff, ImagePlus, Mic, NotebookPen, Pencil, Plus, SendHorizonal, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAgent } from '@/context/AgentContext';
import { api } from '@/lib/api';
import { startWavRecording, type WavRecorder } from '@/lib/voiceRecorder';
import type { AgentMessage } from '@/context/AgentContext';
import { cn } from '@/lib/utils';
import { collectLearningPageContext, describeLearningPageContext } from '@/lib/pageContext';
import type { LearningPageContext } from '@/lib/pageContext';

const shortLabel = (text: string | undefined, max = 18) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value ? (value.length > max ? `${value.slice(0, max)}…` : value) : '';
};

function pageAwareSuggestions(ctx: LearningPageContext): string[] {
  const focusKind = ctx.focus?.kind ?? '';
  const focusTitle = shortLabel(ctx.focus?.title);
  const pageTitle = shortLabel(ctx.pageTitle);

  if (ctx.interaction?.kind === 'quiz' || focusKind === '当前题目') {
    return ctx.interaction?.submitted
      ? ['讲解这道题', '分析错误选项', '这道题考的是哪个知识点', '把这道题整理成错题']
      : ['分析题干', '给我一点提示', '帮我排除选项', '这道题会用到什么概念'];
  }
  if (focusKind === '当前实操步骤') {
    return focusTitle
      ? [`帮我讲一下「${focusTitle}」`, '这一步为什么这么做', '这个步骤容易踩哪些坑', '做完这一步怎么确认对错']
      : ['帮我拆解这个操作步骤', '这一步为什么这么做', '这个步骤容易踩哪些坑', '做完怎么确认对错'];
  }
  if (ctx.pageType === '幻灯片学习' || focusKind === '当前学习卡片') {
    return focusTitle
      ? [`帮我讲一下「${focusTitle}」`, '这页有哪几个关键点', '这页内容怎么记更容易', '把这页整理成笔记']
      : ['这页有哪几个关键点', '这页内容怎么记更容易', '帮我讲一下当前这一页', '把这页整理成笔记'];
  }
  if (ctx.pageType === '完整阅读' || focusKind === '当前阅读段落') {
    return focusTitle
      ? [`这段「${focusTitle}」我不太理解`, '帮我提炼这段的重点', '这个知识点怎么记', '根据这段给我出一道练习题']
      : ['帮我提炼当前这段的重点', '这段我不太理解', '这个知识点怎么记', '根据当前内容给我出一道练习题'];
  }
  if (ctx.selection) {
    return ['用更简单的说法讲一遍', '帮我总结选中内容的要点', '选中内容和我当前学的有什么关系', '根据选中内容出一道题'];
  }
  if (['知识点学习', '交互导学', '资源定制', '资源生成'].includes(ctx.pageType) && pageTitle) {
    return [`帮我讲一下「${pageTitle}」`, '我该怎么理解当前内容', '帮我提炼当前页面重点', '根据当前页面内容出个练习'];
  }
  return [];
}

function sessionTag(title?: string | null): string {
  const value = title || '';
  if (/新对话/.test(value)) return '未开始';
  if (/题目/.test(value)) return '题目';
  if (/实操/.test(value)) return '实操';
  if (/幻灯片/.test(value)) return '幻灯片';
  if (/讲义|阅读|段落/.test(value)) return '讲义/阅读';
  if (/盲区|下一步|学情|画像|分数/.test(value)) return '学情';
  if (/导学/.test(value)) return '导学';
  return '对话';
}

/* ===== 消息气泡 ===== */
function MessageBubble({ message }: { message: AgentMessage }) {
  const isUser = message.kind === 'user';
  const text = 'text' in message ? message.text : '';
  const visibleText = isUser ? text.replace(/^\s*\[(?:当前页面|跨会话上下文)[：:][^\]]+\]\s*/g, '') : text;
  const userImage = message.kind === 'user' && 'image' in message ? message.image : undefined;
  const loading = 'loading' in message ? message.loading : false;
  if (message.kind === 'stage') return (
    <div className="flex justify-center py-1.5">
      <div className="max-w-[90%] rounded-full border border-brand/20 bg-brand-tint/15 px-3 py-1 text-center text-[10.5px] leading-4 text-brand whitespace-pre-wrap">
        {message.text}
      </div>
    </div>
  );
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
        ) : isUser ? (
          <div className="min-w-0">{userImage && (
            <div className="mb-1.5 overflow-hidden rounded-lg">
              <img src={userImage.url} alt={userImage.name} className="max-h-40 w-auto rounded-lg object-cover" />
            </div>
          )}<div className="whitespace-pre-wrap">{visibleText}</div></div>
        ) : (
          <div className="[&_a]:text-brand [&_a]:underline [&_code]:rounded [&_code]:bg-ink/[0.06] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&_li]:my-0.5 [&_li]:ml-4 [&_ol]:my-1.5 [&_ol]:list-decimal [&_p]:my-1.5 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-ink/[0.06] [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-semibold [&_ul]:my-1.5 [&_ul]:list-disc">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{visibleText}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

/* ===== 消息流 + composer ===== */
export function ChatStream({ compact = false, pageContext }: { compact?: boolean; pageContext?: string }) {
  const { messages, askFree, askFreeWithImage, suggestions, weakest, pageContextEnabled, setPageContextEnabled } = useAgent();
  const [input, setInput] = useState('');
  const [image, setImage] = useState<{ name: string; url: string; blob?: Blob } | null>(null);
  const [recording, setRecording] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const voiceRecRef = useRef<WavRecorder | null>(null);
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
    if (!text && !image) return;
    const snapshot = collectLearningPageContext();
    setCurrentContext(snapshot);
    if (image) {
      askFreeWithImage(text, image, snapshot);
      setImage(null);
    } else {
      askFree(text, snapshot);
    }
    setInput('');
  };

  const finishVoice = async () => {
    const recorder = voiceRecRef.current;
    if (!recorder) return;
    voiceRecRef.current = null;
    setRecording(false);
    try {
      const blob = await recorder.stop();
      const { transcript } = await api.transcribeAssistantAudio(blob);
      const text = transcript.trim();
      if (!text) return;
      const snapshot = collectLearningPageContext();
      setCurrentContext(snapshot);
      askFree(text, snapshot);
      setInput('');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '语音识别失败');
    }
  };

  const toggleVoice = async () => {
    if (voiceRecRef.current) {
      void finishVoice();
      return;
    }
    try {
      const recorder = await startWavRecording({
        silenceMs: 1300,
        maxDurationMs: 15000,
        onSilence: () => { void finishVoice(); },
      });
      voiceRecRef.current = recorder;
      setRecording(true);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : '无法开始录音');
    }
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
    const pageBased = pageAwareSuggestions(currentContext);
    if (pageBased.length) return pageBased.slice(0, 4);
    if (suggestions.length) return suggestions.map((s) => s.text);
    return weakest
      ? [`帮我理解「${weakest.name}」的核心概念`, `${weakest.name}有哪些常见错误？`]
      : ['今天想学什么？', '帮我解释一个概念'];
  })();
  const quizActions = currentContext.interaction?.kind === 'quiz'
    ? currentContext.interaction.submitted
      ? ['讲解这道题', '分析错误选项', '查看原文依据', '出一道类似的题']
      : ['分析题干', '给我一点提示', '帮我排除选项']
    : [];

  return (
    <>
      <div className="shrink-0 border-b border-hairline/70 bg-brand-tint/20 px-3 py-2">
        <div className="flex w-full items-center gap-2">
          <button type="button" onClick={() => { setPageContextEnabled(!pageContextEnabled); if (pageContextEnabled) setContextOpen(false); }} title={pageContextEnabled ? '关闭当前所见' : '开启当前所见'} className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border bg-paper transition', pageContextEnabled ? 'border-brand/15 text-brand' : 'border-hairline text-ink-muted')}>
            {pageContextEnabled ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
          <span className={cn('min-w-0 flex-1 truncate text-[11.5px] font-medium', pageContextEnabled ? 'text-ink-2' : 'text-ink-muted')}>
            {pageContextEnabled ? `当前所见：${describeLearningPageContext(currentContext)}` : '当前所见已关闭'}
          </span>
          <button type="button" onClick={() => setContextOpen((value) => !value)} aria-expanded={contextOpen} className="shrink-0" disabled={!pageContextEnabled}>
            <ChevronDown size={12} className={cn('text-ink-muted transition-transform', contextOpen && 'rotate-180', !pageContextEnabled && 'opacity-40')} />
          </button>
        </div>
        {contextOpen && pageContextEnabled && (
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
                  onClick={() => askFree(s, currentContext)}
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

      {quizActions.length > 0 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t border-hairline/70 bg-brand-tint/15 px-3 py-2">
          {quizActions.map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => askFree(action === '出一道类似的题' ? '出一道与这道题思路相近的练习题，给出选项，让我直接在对话框里作答' : action, collectLearningPageContext())}
              className="shrink-0 rounded-full border border-brand/20 bg-paper px-2.5 py-1 text-[10.5px] font-medium text-brand transition hover:border-brand/45 hover:bg-brand-tint/40"
            >
              {action}
            </button>
          ))}
        </div>
      )}
      {/* Composer */}
      <div className="shrink-0 border-t border-hairline px-3 py-2">
        {image && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-hairline bg-paper p-1.5">
            <img src={image.url} alt={image.name} className="h-9 w-9 rounded object-cover" />
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-ink-2">{image.name}</span>
            <button type="button" onClick={() => setImage(null)} className="shrink-0 rounded p-1 text-ink-muted hover:text-brand-danger" title="移除图片"><X size={12} /></button>
          </div>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-hairline bg-paper px-2.5 py-1.5">
          <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) setImage({ name: file.name, url: URL.createObjectURL(file), blob: file }); event.target.value = ''; }} />
          <button
            type="button"
            onClick={() => void toggleVoice()}
            title={recording ? '停止录音并发送' : '语音提问'}
            aria-label="语音提问"
            className={cn('shrink-0 rounded-lg border p-2 transition', recording ? 'animate-pulse border-brand-danger bg-brand-danger text-paper' : 'border-hairline text-ink-muted hover:border-brand/40 hover:text-brand')}
          >
            <Mic size={14} />
          </button>
          <button
            type="button"
            onClick={() => imageInputRef.current?.click()}
            title="上传图片提问"
            className="shrink-0 rounded-lg border border-hairline p-2 text-ink-muted transition hover:border-brand/40 hover:text-brand"
          >
            <ImagePlus size={14} />
          </button>
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
            disabled={!input.trim() && !image}
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
              <p className="truncate text-[10px] text-ink-muted">{sessionTag(s.title)}</p>
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
