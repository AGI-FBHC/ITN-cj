import * as React from 'react';
import Markdown from './admin/Markdown.jsx';
import {
  askTutorStream,
  createTutorConversation,
  deleteTutorConversation,
  getTutorConversations,
  getTutorHistory,
  prepareTutorImage,
  TUTOR_MAX_IMAGES,
  TUTOR_MAX_TOTAL_BYTES,
  updateTutorConversation,
} from './tutor.js';
import './tutor-chat.css';

function SparkIcon({ className = '' }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    <circle cx="12" cy="12" r="3.2" />
  </svg>;
}

function ImageIcon({ className = '' }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="m21 16-5-5L5 20" />
  </svg>;
}

function MicIcon({ className = '' }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
  </svg>;
}

function SendIcon({ className = '' }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" />
  </svg>;
}

function CloseIcon({ className = '' }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>;
}

function NewChatIcon({ className = '' }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M8 12h8M12 8v8M19 3v6M16 6h6" />
  </svg>;
}

function ConversationIcon({ className = '' }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
    <path d="M8 9h8M8 13h5" />
  </svg>;
}

function ActionIcon({ kind, className = '' }) {
  const paths = {
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    rename: <><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z" /></>,
    archive: <><path d="M4 8v12h16V8M3 4h18v4H3ZM9 12h6" /></>,
    restore: <><path d="M4 12a8 8 0 1 1 2 6M4 5v7h7" /></>,
    delete: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  };
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

function ImagePreview({ image, onClose }) {
  const dialog = React.useRef(null);
  React.useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="zx-tutor-image-dialog" onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }} aria-label="查看提问图片">
    <button type="button" aria-label="关闭图片预览" onClick={() => dialog.current?.close()}><CloseIcon className="h-4 w-4" /></button>
    <img src={image.dataUrl} alt={image.name || '提问图片'} />
  </dialog>;
}

function useSpeech(onText, onError) {
  const [listening, setListening] = React.useState(false);
  const recognition = React.useRef(null);
  const supported = typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  React.useEffect(() => () => {
    if (recognition.current) {
      recognition.current.onresult = null;
      recognition.current.onend = null;
      recognition.current.onerror = null;
      recognition.current.abort?.();
    }
  }, []);
  const stop = () => recognition.current?.stop?.();
  const toggle = () => {
    if (!supported) return;
    if (listening) { recognition.current?.stop?.(); return; }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const instance = new Recognition();
    instance.lang = 'zh-CN';
    instance.interimResults = false;
    instance.onresult = (event) => onText(Array.from(event.results).map((result) => result[0].transcript).join(''));
    instance.onend = () => setListening(false);
    instance.onerror = (event) => {
      setListening(false);
      if (event.error !== 'aborted') onError(`语音输入失败：${event.error || '无法识别，请重试'}`);
    };
    recognition.current = instance;
    setListening(true);
    try { instance.start(); } catch (error) {
      setListening(false);
      onError(`语音输入失败：${error.message}`);
    }
  };
  return { listening, supported, toggle, stop };
}

function quoteText(quote) {
  if (!quote) return '';
  if (typeof quote === 'string') return quote;
  return `${quote.heading ? `${quote.heading}：` : ''}${quote.text || ''}`;
}

function AnswerCitations({ citations, chapter }) {
  const sources = Array.isArray(citations) ? citations.filter((item) => item && [item.documentTitle, Array.isArray(item.headingPath) ? item.headingPath.filter((value) => typeof value === 'string' && value.trim()).join(' / ') : item.headingPath, item.text].some((value) => typeof value === 'string' && value.trim())) : [];
  if (!sources.length) return null;
  return <section className="zx-tutor-citations" aria-label="回答参考原文">
    <p>{chapter ? '本章原文' : '参考原文'} · {sources.length} 处</p>
    <ol>{sources.map((citation, order) => {
      const heading = Array.isArray(citation.headingPath) ? citation.headingPath.filter((value) => value?.trim()).join(' / ') : citation.headingPath?.trim();
      const title = citation.documentTitle?.trim();
      const label = <>{citation.index != null && <b>[{citation.index}]</b>}<span>{title || heading || citation.text.slice(0, 72)}{title && heading && <small>{heading}</small>}</span></>;
      return <li key={`${citation.documentId || 'source'}-${citation.index ?? order}-${order}`}>
        {citation.text ? <details><summary>{label}</summary><p>{citation.text}</p></details> : <div className="zx-tutor-citation-label">{label}</div>}
      </li>;
    })}</ol>
  </section>;
}

export default function TutorChat(props) {
  if (props.fullPage) return <AgentWorkspace {...props} />;
  if (props.conversationId) return <ChatSession key={props.conversationId} {...props} />;
  return <CourseChatSession key={`${props.courseId || 'general'}:${props.lessonIndex ?? -1}`} {...props} />;
}

function CourseChatSession(props) {
  const [conversation, setConversation] = React.useState(null);
  const [error, setError] = React.useState('');
  const [attempt, setAttempt] = React.useState(0);
  const creation = React.useRef({ courseId: props.courseId || '', lessonIndex: props.lessonIndex ?? -1, lessonTitle: props.lessonTitle || '' });
  React.useEffect(() => {
    const controller = new AbortController();
    setError('');
    // StrictMode cleans up the first effect before this microtask can create a session.
    queueMicrotask(async () => {
      if (controller.signal.aborted) return;
      try {
        const item = await createTutorConversation({ ...creation.current, signal: controller.signal });
        if (!controller.signal.aborted) {
          if (!item?.conversationId) throw new Error('服务未返回会话编号');
          setConversation(item);
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message || '会话创建失败');
      }
    });
    return () => controller.abort();
  }, [attempt]);

  if (conversation) return <ChatSession key={conversation.conversationId} {...props} conversationId={conversation.conversationId} />;
  return <aside className="zx-agent-chat-loading" aria-label="Lumin 学习助手对话">
    <div><SparkIcon className="h-8 w-8" />{error ? <><p role="alert">新建课程会话失败：{error}</p><button type="button" onClick={() => setAttempt((current) => current + 1)}>重试</button></> : <p role="status">正在为本次学习新建会话…</p>}</div>
  </aside>;
}

function AgentWorkspace(props) {
  const [conversations, setConversations] = React.useState([]);
  const [selected, setSelected] = React.useState(null);
  const [archived, setArchived] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [editing, setEditing] = React.useState(null);
  const [deleteTarget, setDeleteTarget] = React.useState(null);
  const [action, setAction] = React.useState(null);
  const [actionError, setActionError] = React.useState('');
  const [listLoading, setListLoading] = React.useState(true);
  const [listError, setListError] = React.useState('');
  const listRequest = React.useRef(null);
  const mutationRequest = React.useRef(null);
  const alive = React.useRef(true);

  const loadConversations = React.useCallback(async () => {
    if (mutationRequest.current) return;
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setListLoading(true);
    setListError('');
    try {
      const items = await getTutorConversations({ archived, signal: controller.signal });
      if (!alive.current || controller.signal.aborted) return;
      setConversations(items);
      setSelected((current) => {
        const refreshed = items.find((item) => item.conversationId === current?.conversationId);
        return refreshed ? { ...current, ...refreshed } : items[0] || null;
      });
    } catch (error) {
      if (alive.current && !controller.signal.aborted) setListError(error.message || '会话列表读取失败');
    } finally {
      if (alive.current && !controller.signal.aborted) setListLoading(false);
    }
  }, [archived]);

  React.useEffect(() => {
    alive.current = true;
    loadConversations();
    return () => {
      alive.current = false;
      listRequest.current?.abort();
      mutationRequest.current?.abort();
      mutationRequest.current = null;
    };
  }, [loadConversations]);

  const resetForms = () => { setEditing(null); setDeleteTarget(null); setActionError(''); };
  const selectConversation = (item) => { resetForms(); setSelected(item); };
  const switchArchive = (value) => {
    if (mutationRequest.current || value === archived) return;
    listRequest.current?.abort();
    resetForms();
    setSelected(null);
    setConversations([]);
    setListError('');
    setListLoading(true);
    setArchived(value);
  };
  const mutate = async (kind, item, title = '') => {
    if (mutationRequest.current) return;
    if (kind === 'rename' && !title.trim()) {
      setActionError('请输入会话名称');
      return;
    }
    const controller = new AbortController();
    mutationRequest.current = controller;
    listRequest.current?.abort();
    setListLoading(false);
    setAction({ kind, id: item?.conversationId });
    setActionError('');
    try {
      const result = kind === 'create'
        ? await createTutorConversation({ signal: controller.signal })
        : kind === 'delete'
          ? await deleteTutorConversation(item.conversationId, { signal: controller.signal })
          : await updateTutorConversation(item.conversationId, kind === 'rename' ? { title: title.trim() } : { archived: !archived }, { signal: controller.signal });
      if (!alive.current || controller.signal.aborted) return;
      if (kind === 'create') {
        if (!result?.conversationId) throw new Error('服务未返回会话编号');
        setConversations((current) => [result, ...current.filter((entry) => entry.conversationId !== result.conversationId && !entry.archived)]);
        setSelected(result);
        setSearch('');
        setArchived(false);
      } else if (kind === 'rename') {
        setConversations((current) => current.map((entry) => entry.conversationId === item.conversationId ? { ...entry, ...result } : entry));
        setSelected((current) => current?.conversationId === item.conversationId ? { ...current, ...result } : current);
      } else {
        const remaining = conversations.filter((entry) => entry.conversationId !== item.conversationId);
        setConversations(remaining);
        setSelected((current) => current?.conversationId === item.conversationId ? remaining[0] || null : current);
      }
      resetForms();
    } catch (error) {
      if (alive.current && !controller.signal.aborted) setActionError(`${kind === 'create' ? '新建会话' : `操作“${item.title || '学习对话'}”`}失败：${error.message}`);
    } finally {
      if (mutationRequest.current === controller) mutationRequest.current = null;
      if (alive.current && !controller.signal.aborted) setAction(null);
    }
  };
  const query = search.trim().toLocaleLowerCase();
  const visible = conversations.filter((item) => [item.title, item.preview, item.courseName, item.lessonTitle].some((value) => String(value || '').toLocaleLowerCase().includes(query)));
  return <div className="zx-agent-workspace">
    <aside className="zx-agent-conversation-rail" aria-label="对话列表">
      <header className="zx-agent-conversation-head">
        <div>
          <span>对话记录</span>
          <strong>学习对话</strong>
        </div>
        <button type="button" onClick={() => mutate('create')} disabled={!!action} title="新建对话" aria-label="新建对话" aria-busy={action?.kind === 'create'}>
          <NewChatIcon className="h-5 w-5" />
        </button>
      </header>
      <div className="zx-agent-conversation-tools">
        <label className="zx-agent-conversation-search">
          <ActionIcon kind="search" />
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索会话" aria-label="搜索会话名称或内容" />
        </label>
        <div className="zx-agent-conversation-filters" role="group" aria-label="会话归档筛选">
          <button type="button" aria-pressed={!archived} onClick={() => switchArchive(false)} disabled={!!action}>未归档</button>
          <button type="button" aria-pressed={archived} onClick={() => switchArchive(true)} disabled={!!action}>已归档</button>
        </div>
      </div>
      <div className="zx-agent-conversation-list">
        {actionError ? <p className="zx-agent-conversation-state is-error" role="alert">{actionError}</p> : null}
        {action?.kind === 'create' ? <p className="zx-agent-conversation-state" role="status">正在新建会话…</p> : null}
        {listLoading ? <p className="zx-agent-conversation-state">正在读取会话…</p> : null}
        {listError ? <div className="zx-agent-conversation-state is-error" role="alert">
          <span>{listError}</span>
          <button type="button" onClick={loadConversations}>重试</button>
        </div> : null}
        {!listLoading && !listError && visible.length === 0 ? <p className="zx-agent-conversation-state">{query ? '没有匹配的会话，请换个关键词。' : archived ? '暂无已归档会话。' : '还没有会话，点击右上角新建。'}</p> : null}
        {visible.map((item) => <div
          key={item.conversationId}
          className={`zx-agent-conversation-item${selected?.conversationId === item.conversationId ? ' is-active' : ''}`}
        >
          <button type="button" className="zx-agent-conversation-select" onClick={() => selectConversation(item)} disabled={!!action} aria-current={selected?.conversationId === item.conversationId ? 'page' : undefined}>
          <span className="zx-agent-conversation-icon"><ConversationIcon className="h-[18px] w-[18px]" /></span>
          <span className="zx-agent-conversation-copy">
            <strong>{item.title || '学习对话'}</strong>
            <small>{item.preview || item.lessonTitle || item.courseName || '继续这次对话'}</small>
          </span>
          </button>
          {editing?.id === item.conversationId ? <form className="zx-agent-conversation-edit" onSubmit={(event) => { event.preventDefault(); mutate('rename', item, editing.title); }}>
            <label>会话名称<input autoFocus maxLength={120} value={editing.title} disabled={!!action} onChange={(event) => { setEditing({ id: item.conversationId, title: event.target.value }); setActionError(''); }} onKeyDown={(event) => { if (event.key === 'Escape' && !action) resetForms(); }} /></label>
            <div><button type="submit" disabled={!!action || !editing.title.trim()}>{action?.kind === 'rename' ? '保存中…' : '保存'}</button><button type="button" disabled={!!action} onClick={resetForms}>取消</button></div>
          </form> : deleteTarget?.id === item.conversationId ? <div className="zx-agent-conversation-confirm" role="group" aria-label={`确认删除${deleteTarget.title}`}>
            <p>删除“{deleteTarget.title}”？<br />此会话的消息将一并删除。</p>
            <div><button type="button" className="is-danger" disabled={!!action} onClick={() => mutate('delete', { ...item, conversationId: deleteTarget.id, title: deleteTarget.title })}>{action?.kind === 'delete' ? '删除中…' : '确认删除'}</button><button type="button" disabled={!!action} onClick={resetForms}>取消</button></div>
          </div> : <div className="zx-agent-conversation-actions">
            <button type="button" disabled={!!action} onClick={() => { resetForms(); setEditing({ id: item.conversationId, title: item.title || '' }); }} aria-label={`重命名：${item.title || '学习对话'}`} title="重命名"><ActionIcon kind="rename" /><span>重命名</span></button>
            <button type="button" disabled={!!action} onClick={() => mutate('archive', item)} aria-label={`${archived ? '恢复' : '归档'}：${item.title || '学习对话'}`} title={archived ? '恢复会话' : '归档会话'}><ActionIcon kind={archived ? 'restore' : 'archive'} /><span>{action?.kind === 'archive' && action.id === item.conversationId ? '处理中…' : archived ? '恢复' : '归档'}</span></button>
            <button type="button" disabled={!!action} onClick={() => { resetForms(); setDeleteTarget({ id: item.conversationId, title: item.title || '学习对话' }); }} aria-label={`删除：${item.title || '学习对话'}`} title="删除会话"><ActionIcon kind="delete" /><span>删除</span></button>
          </div>}
        </div>)}
      </div>
      <footer className="zx-agent-conversation-foot">
        <span>{query ? `${visible.length} / ` : ''}{conversations.length} 个{archived ? '已归档' : '未归档'}会话</span>
      </footer>
    </aside>
    <section className="zx-agent-chat-pane">
      {selected ? <ChatSession
        key={selected.conversationId}
        {...props}
        conversationId={selected.conversationId}
        conversationTitle={selected.title || '新的学习对话'}
        courseId={selected.courseId || ''}
        lessonIndex={selected.lessonIndex ?? -1}
        courseName={selected.courseName || ''}
        lessonTitle={selected.lessonTitle || ''}
        archived={!!selected.archived || archived}
        onConversationUsed={loadConversations}
      /> : <div className="zx-agent-chat-loading"><div><SparkIcon className="h-8 w-8" /><p>{listLoading ? '正在准备对话…' : archived ? '选择一个归档会话查看记录' : '开始新的学习对话'}</p>{!listLoading && <button type="button" disabled={!!action} onClick={() => mutate('create')}>{action?.kind === 'create' ? '正在新建…' : '新建对话'}</button>}</div></div>}
    </section>
  </div>;
}

function ChatSession({ courseId = '', lessonIndex = -1, courseName = '', lessonTitle = '', quote, onClearQuote, inputRef, context = '', onSend, fullPage = false, suggestions = [], conversationId = '', conversationTitle = '', onConversationUsed, archived = false }) {
  const [messages, setMessages] = React.useState([]);
  const [draft, setDraft] = React.useState('');
  const [images, setImages] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [historyError, setHistoryError] = React.useState('');
  const [imageError, setImageError] = React.useState('');
  const [preparing, setPreparing] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [failed, setFailed] = React.useState(null);
  const [contextEnabled, setContextEnabled] = React.useState(true);
  const [copiedId, setCopiedId] = React.useState('');
  const [copyError, setCopyError] = React.useState('');
  const [toolTrace, setToolTrace] = React.useState([]);
  const [speechError, setSpeechError] = React.useState('');
  const [previewImage, setPreviewImage] = React.useState(null);
  const fileInput = React.useRef(null);
  const composer = React.useRef(null);
  const bottom = React.useRef(null);
  const alive = React.useRef(true);
  const request = React.useRef(null);
  const sendLock = React.useRef(false);
  const imageLock = React.useRef(false);
  const historyRequest = React.useRef(null);
  const copyTimer = React.useRef(null);
  const hasContext = !!(courseId || lessonTitle || quoteText(quote) || context);

  const greeting = lessonTitle
    ? `你好！我是你的个人学习助手——Lumin老师。学习“${lessonTitle}”时遇到任何问题，都可以引用课程内容或上传图片来问我。`
    : '你好！我是你的个人学习助手——Lumin老师，可以提问知识点，也可以上传截图或题目图片一起讨论。';

  const loadHistory = React.useCallback(async () => {
    historyRequest.current?.abort();
    const controller = new AbortController();
    historyRequest.current = controller;
    setLoading(true);
    setHistoryError('');
    try {
      const items = await getTutorHistory({ courseId, lessonIndex, conversationId, signal: controller.signal });
      if (alive.current && !controller.signal.aborted) {
        setMessages(items.map((item, index) => ({ ...item, id: item.id || `history-${index}`, text: item.content || item.text || '', streaming: false })));
      }
    } catch (error) {
      if (alive.current && !controller.signal.aborted) setHistoryError(`历史记录读取失败：${error.message}`);
    } finally {
      if (alive.current && !controller.signal.aborted) setLoading(false);
    }
  }, [conversationId, courseId, lessonIndex]);

  React.useEffect(() => {
    alive.current = true;
    loadHistory();
    return () => {
      alive.current = false;
      request.current?.controller.abort();
      request.current?.cancelFrame();
      request.current = null;
      sendLock.current = false;
      historyRequest.current?.abort();
      clearTimeout(copyTimer.current);
    };
  }, [loadHistory]);

  React.useEffect(() => {
    const scroller = bottom.current?.parentElement;
    if (!scroller) return;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
    if (nearBottom) bottom.current?.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
  }, [messages, sending, loading]);

  React.useEffect(() => { if (quote) composer.current?.focus(); }, [quote]);
  React.useEffect(() => {
    if (!composer.current) return;
    composer.current.style.height = 'auto';
    composer.current.style.height = `${Math.min(composer.current.scrollHeight, 160)}px`;
  }, [draft, loading]);

  const addImages = async (files) => {
    if (imageLock.current || sendLock.current) return;
    const selected = Array.from(files || []);
    if (!selected.length) return;
    setImageError('');
    if (selected.length + images.length > TUTOR_MAX_IMAGES) {
      setImageError('每条消息最多添加 3 张图片，请减少后重试');
      return;
    }
    imageLock.current = true;
    setPreparing(true);
    try {
      const additions = [];
      for (const file of selected) additions.push(await prepareTutorImage(file));
      if (!alive.current) return;
      if ([...images, ...additions].reduce((total, item) => total + item.dataUrl.length, 0) > TUTOR_MAX_TOTAL_BYTES) throw new Error('图片总量过大，请减少图片后重试');
      setImages((current) => [...current, ...additions]);
    } catch (error) {
      if (alive.current) setImageError(error.message);
    } finally {
      imageLock.current = false;
      if (alive.current) setPreparing(false);
    }
  };

  const send = async (retry = null, suggestion = null) => {
    if (sendLock.current || imageLock.current || loading || historyError || archived) return;
    const text = (suggestion ?? draft).trim();
    if (!retry && !text && !images.length) return;
    const id = retry?.id || (globalThis.crypto?.randomUUID?.() || `msg-${Date.now()}`);
    const payload = retry?.payload || {
      message: text,
      quote: hasContext && contextEnabled ? quoteText(quote) || context : '',
      courseId, lessonIndex, lessonTitle,
      conversationId,
      useContext: hasContext && contextEnabled,
      history: messages.filter((item) => ['user', 'assistant'].includes(item.role) && !item.pending && !item.streaming && !item.interrupted && !item.error && !item.greeting).slice(-12).map((item) => ({ role: item.role, content: item.text || '' })),
      attachments: images,
    };
    sendLock.current = true;
    setSending(true);
    setFailed(null);
    setToolTrace([]);
    setImageError('');
    setSpeechError('');
    speech.stop();
    const controller = new AbortController();
    if (!retry) {
      setMessages((current) => [...current, { id, role: 'user', text, attachments: images, quote: payload.useContext ? quoteText(quote) : '' }]);
      setDraft('');
      setImages([]);
      onClearQuote?.();
    }
    const answerId = `${id}-answer`;
    let streamed = '';
    let citations = [];
    let frame = 0;
    const active = {
      controller,
      cancelFrame: () => { if (frame) cancelAnimationFrame(frame); frame = 0; },
      stop: () => {
        controller.abort();
        active.cancelFrame();
        if (!alive.current || request.current !== active) return;
        setMessages((current) => current.map((item) => item.id === answerId ? { ...item, text: streamed, streaming: false, interrupted: true } : item));
        request.current = null;
        sendLock.current = false;
        setSending(false);
      },
    };
    request.current = active;
    const isCurrent = () => alive.current && request.current === active && !controller.signal.aborted;
    const paint = () => {
      frame = 0;
      if (!isCurrent()) return;
      setMessages((current) => current.map((item) => (item.id === answerId ? { ...item, text: streamed } : item)));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    // A retry replaces its previous partial answer, keeping one stable row per turn.
    setMessages((current) => [...current.filter((item) => item.id !== answerId), { id: answerId, role: 'assistant', text: '', streaming: true }]);
    try {
      onSend?.();
      const result = await askTutorStream(payload, (event) => {
        if (!isCurrent()) return;
        if (Array.isArray(event.citations)) {
          citations = event.citations;
          setMessages((current) => current.map((item) => item.id === answerId ? { ...item, citations } : item));
        }
        if (event.type === 'meta') {
          setMessages((current) => current.map((item) => (item.id === answerId
            ? { ...item, model: event.model } : item)));
          setToolTrace(Array.isArray(event.toolTrace) ? event.toolTrace : []);
        } else if (event.type === 'delta') {
          streamed += event.text || '';
          schedule();
        } else if (event.type === 'done') {
          streamed = event.answer || streamed;
          schedule();
        }
      }, { signal: controller.signal });
      if (!isCurrent()) return;
      active.cancelFrame();
      streamed = result?.answer || streamed;
      if (Array.isArray(result?.citations)) citations = result.citations;
      if (!streamed.trim()) throw new Error('没有收到回答，请重试');
      setMessages((current) => current.map((item) => (item.id === answerId
        ? { ...item, text: streamed, citations, streaming: false, interrupted: false } : item)));
    } catch (error) {
      active.cancelFrame();
      if (isCurrent()) {
        setMessages((current) => current.map((item) => (item.id === answerId
          ? { ...item, text: streamed, streaming: false, interrupted: true } : item)));
        setFailed({ id, payload, error: error.message });
      }
    } finally {
      if (request.current === active) {
        request.current = null;
        sendLock.current = false;
      }
      if (alive.current && !controller.signal.aborted) {
        setSending(false);
        onConversationUsed?.();
      }
    }
  };

  const speech = useSpeech((text) => {
    if (!alive.current || sendLock.current) return;
    setSpeechError('');
    setDraft((current) => `${current}${text}`);
  }, setSpeechError);
  const copyAnswer = async (item) => {
    setCopyError('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前浏览器无法访问剪贴板，请选中文字复制');
      await navigator.clipboard.writeText(item.text);
      if (!alive.current) return;
      setCopiedId(item.id);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedId(''), 2000);
    } catch (error) {
      if (alive.current) setCopyError(`复制失败：${error.message}`);
    }
  };
  const shownMessages = messages.length ? messages : loading || historyError ? [] : [{ id: 'greeting', role: 'assistant', text: greeting, greeting: true }];
  const lastAnswer = [...messages].reverse().find((item) => item.role === 'assistant');
  const topic = (lessonTitle || courseName || quote?.heading || '').trim();
  const followUps = [
    topic ? `请用一个具体例子解释“${topic}”中刚才讨论的内容。` : '请用一个具体例子解释刚才的内容。',
    '请把刚才讨论的内容整理成几个关键点。',
    topic ? `请围绕“${topic}”中刚才讨论的知识出一道练习题，先不要给答案。` : '请根据刚才讨论的知识出一道练习题，先不要给答案。',
  ];
  const canCompose = !loading && !sending && !historyError && !archived;
  const canSend = canCompose && !preparing && (draft.trim() || images.length);
  const chatTitle = conversationTitle || lessonTitle || '学习对话';
  const chatSource = archived ? '已归档' : (lessonTitle || courseName ? '课程对话' : '');

  return <aside className={`flex h-full flex-col bg-[#fcfcfd]${fullPage ? ' zx-tutor-full' : ''}`} aria-label="Lumin 学习助手对话">
    <div className="zx-agent-chat-head">
      <strong className="zx-agent-chat-title" title={chatTitle}>{chatTitle}</strong>
      {chatSource && <span className="zx-agent-chat-source">{chatSource}</span>}
    </div>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-6 sm:px-7" role="log" aria-label="对话记录" aria-live="polite" aria-busy={sending || loading}>
      {loading && <p className="text-xs font-bold text-[#9297a3]">正在读取对话记录…</p>}
      {historyError && <div className="zx-tutor-inline-error" role="alert"><span>{historyError}</span><button type="button" onClick={loadHistory} disabled={sending}>重试</button></div>}
      {shownMessages.map((item) => <div key={item.id} className={`flex ${item.role === 'user' ? 'justify-end' : 'justify-start'}`}>
        <div className={`max-w-[88%] ${item.role === 'user' ? 'text-right' : ''}`}>
          <p className={`mb-1.5 flex items-center gap-2 text-xs font-extrabold ${item.role === 'user' ? 'justify-end text-[#6038ef]' : 'text-[#4d83d1]'}`}>
            {item.role === 'assistant' && <span className="zx-tutor-speaker-dot" aria-hidden="true" />}
            {item.role === 'user' ? '你' : 'Lumin学习助手'}
          </p>
          {item.quote && <div className="mb-2 rounded-xl border-l-[3px] border-[#6038ef] bg-[#f2effc] px-3 py-2 text-left text-xs font-semibold leading-5 text-[#686c77]"><strong className="block text-[#454852]">引用：</strong>{quoteText(item.quote).slice(0, 80)}…</div>}
          {!!item.attachments?.length && <div className="zx-tutor-sent-images">{item.attachments.map((image, index) => image.dataUrl
            ? <button type="button" key={image.id || index} onClick={() => setPreviewImage(image)} aria-label={`查看图片：${image.name}`}><img src={image.dataUrl} alt={image.name || '提问图片'} /></button>
            : <span key={index}>{image.name || '图片附件'}</span>)}</div>}
          <div className={`zx-tutor-message ${item.role === 'user' ? 'is-user' : 'is-assistant'} rounded-2xl px-4 py-3 text-left text-sm font-semibold leading-6 ${item.role === 'user' ? 'zx-tutor-user-text rounded-tr-sm bg-[#6038ef] text-white' : 'rounded-tl-sm bg-[#eef2ff] text-[#555a75]'}`}>
            {item.role === 'assistant' ? <div className="zx-tutor-rich">{item.text ? <Markdown text={item.text} audience="learner" /> : <span className="zx-tutor-pending">{item.interrupted ? '回答中断，尚未收到正文。' : '正在回答…'}</span>}{item.streaming && item.text ? <span className="zx-tutor-caret" aria-hidden="true" /> : null}</div> : item.text}
          </div>
          {item.role === 'assistant' && <>
            <AnswerCitations citations={item.citations} chapter={!!courseId && lessonIndex >= 0} />
            <div className="zx-tutor-answer-tools">
              {item.text && !item.streaming && <button type="button" onClick={() => copyAnswer(item)} aria-label="复制回答"><ActionIcon kind="copy" />{copiedId === item.id ? '已复制' : '复制回答'}</button>}
              {item.interrupted && <span role="status">输出已中断，已保留收到的内容</span>}
            </div>
          </>}
        </div>
      </div>)}
      {!loading && !messages.length && !!suggestions.length && !archived && <div className="zx-tutor-suggestions">{suggestions.map((text) => <button key={text} type="button" onClick={() => send(null, text)} disabled={!canCompose || preparing}>{text}</button>)}</div>}
      {lastAnswer?.text && !lastAnswer.streaming && !lastAnswer.interrupted && !sending && !archived && <div className="zx-tutor-followups"><p>继续学习</p><div className="zx-tutor-suggestions">{followUps.map((text, index) => <button type="button" key={text} title={text} disabled={!canCompose || preparing} onClick={() => send(null, text)}>{['举个例子', '总结要点', '出一道练习题'][index]}</button>)}</div></div>}
      {sending && !lastAnswer?.text?.trim() && <div className="flex items-center gap-2 text-xs font-bold text-[#7a7f8c]" role="status"><span className="zx-tutor-dot" />Lumin 正在查看资料并思考…</div>}
      {!!toolTrace.length && !sending && <div className="zx-tutor-tool-trace" aria-label="Agent 工具调用记录"><span>Agent 已调用</span>{toolTrace.map((item, index) => <i key={`${item}-${index}`}>{item}</i>)}</div>}
      {failed && <div className="zx-tutor-inline-error" role="alert"><span>未能回答：{failed.error}</span><button type="button" onClick={() => send(failed)} disabled={sending}>重新发送</button></div>}
      {copyError && <p className="zx-tutor-image-error" role="alert">{copyError}</p>}
      <div ref={bottom} />
    </div>
    <div className="shrink-0 px-5 pb-2 pt-2">
      {archived && <p className="zx-tutor-archived-note">此会话已归档，恢复后可继续提问。</p>}
      {hasContext && <div className="zx-tutor-context">
        <div><strong>{contextEnabled ? '使用当前课程上下文' : '当前课程上下文已关闭'}</strong><span>{[courseName, lessonTitle || quote?.heading].filter(Boolean).join(' · ') || (quoteText(quote) ? '已引用内容' : '当前课程内容')}</span></div>
        <button type="button" role="switch" aria-checked={contextEnabled} aria-label="使用当前课程上下文" disabled={sending || archived} onClick={() => setContextEnabled((current) => !current)}><i /></button>
      </div>}
      {quote && <div className="mx-2 flex items-start gap-3 rounded-t-xl border border-b-0 border-[#dcd6f2] bg-[#f3f0fc] px-4 py-3 text-xs font-semibold text-[#626672]">
        <div className="min-w-0 flex-1"><strong className="block truncate text-[#3d4048]">{contextEnabled ? '正在引用' : '引用已暂停'}：{quote.heading || '所选内容'}</strong><p className="mt-1 line-clamp-2 leading-5">{typeof quote === 'string' ? quote : quote.text}</p></div>
        <button type="button" onClick={onClearQuote} aria-label="取消引用"><CloseIcon className="h-4 w-4" /></button>
      </div>}
      {!!images.length && <div className="zx-tutor-image-previews">{images.map((image) => <div key={image.id}><img src={image.dataUrl} alt={image.name} /><button type="button" aria-label={`移除图片：${image.name}`} onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))} disabled={sending || preparing}><CloseIcon className="h-3.5 w-3.5" /></button></div>)}</div>}
      {imageError && <p className="zx-tutor-image-error" role="alert">{imageError}</p>}
      {speechError && <p className="zx-tutor-image-error" role="alert">{speechError}</p>}
      <div className={`zx-tutor-composer flex items-center gap-3 bg-white px-4 py-3 shadow-[0_8px_28px_rgba(17,19,24,0.13)] ${quote ? 'rounded-b-2xl border border-[#dcd6f2]' : 'rounded-2xl border border-black/[0.07]'}`}>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(event) => { addImages(event.target.files); event.target.value = ''; }} />
        <button type="button" className="zx-tutor-attach" aria-label="添加图片" title="添加图片，最多 3 张" disabled={!canCompose || preparing || images.length >= TUTOR_MAX_IMAGES} onClick={() => fileInput.current?.click()}><ImageIcon className="h-6 w-6" /></button>
        <textarea ref={(node) => { composer.current = node; if (inputRef) inputRef.current = node; }} rows={1} value={draft} maxLength={12000} aria-label="向学习助手提问" aria-describedby={`zx-tutor-input-help-${conversationId}`} disabled={!canCompose} placeholder={archived ? '恢复会话后继续提问' : preparing ? '正在压缩图片…' : sending ? '正在回答…' : quote && contextEnabled ? '针对引用内容提问…' : '输入问题，或引用讲义内容…'} className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none placeholder:text-[#a1a4ad]" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); send(); } }} onPaste={(event) => { const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); addImages(files); } }} />
        <button type="button" onClick={speech.toggle} disabled={!speech.supported || !canCompose || preparing} className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition ${speech.listening ? 'animate-pulse bg-[#6038ef] text-white' : 'text-[#666b76] hover:bg-[#f0ebff] hover:text-[#6038ef]'} disabled:cursor-not-allowed disabled:opacity-30`} aria-label={speech.listening ? '停止语音输入' : '开始语音输入'} title={speech.supported ? '语音提问' : '当前浏览器不支持语音识别'}><MicIcon className="h-5 w-5" /></button>
        {sending ? <button type="button" className="zx-tutor-stop" onClick={() => request.current?.stop()} aria-label="停止输出" title="停止接收输出，保留已收到的回答"><ActionIcon kind="stop" /></button> : <button type="button" onClick={() => send()} disabled={!canSend} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#6038ef] text-white shadow-[0_6px_16px_rgba(96,56,239,0.28)] transition hover:bg-[#512bdc] disabled:cursor-not-allowed disabled:opacity-35" aria-label="发送消息" title="发送消息"><SendIcon className="h-5 w-5" /></button>}
      </div>
      <p id={`zx-tutor-input-help-${conversationId}`} className="mt-1 text-center text-[10px] font-semibold text-[#b7b9bf]">{images.length ? `${images.length}/3 张图片 · ` : ''}Enter 发送 · Shift+Enter 换行</p>
    </div>
    {previewImage && <ImagePreview image={previewImage} onClose={() => setPreviewImage(null)} />}
  </aside>;
}
