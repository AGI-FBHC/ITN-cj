import * as React from 'react';
import Markdown from './admin/Markdown.jsx';
import { askTutor, askTutorStream, getTutorHistory, prepareTutorImage, TUTOR_MAX_IMAGES, TUTOR_MAX_TOTAL_BYTES } from './tutor.js';
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

function ImagePreview({ image, onClose }) {
  const dialog = React.useRef(null);
  React.useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="zx-tutor-image-dialog" onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }} aria-label="查看提问图片">
    <button type="button" aria-label="关闭图片预览" onClick={() => dialog.current?.close()}><CloseIcon className="h-4 w-4" /></button>
    <img src={image.dataUrl} alt={image.name || '提问图片'} />
  </dialog>;
}

function useSpeech(onText) {
  const [listening, setListening] = React.useState(false);
  const recognition = React.useRef(null);
  const supported = typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  React.useEffect(() => () => recognition.current?.abort?.(), []);
  const toggle = () => {
    if (!supported) return;
    if (listening) { recognition.current?.stop?.(); return; }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const instance = new Recognition();
    instance.lang = 'zh-CN';
    instance.interimResults = false;
    instance.onresult = (event) => onText(Array.from(event.results).map((result) => result[0].transcript).join(''));
    instance.onend = () => setListening(false);
    instance.onerror = () => setListening(false);
    recognition.current = instance;
    setListening(true);
    instance.start();
  };
  return { listening, supported, toggle };
}

function quoteText(quote) {
  if (!quote) return '';
  if (typeof quote === 'string') return quote;
  return `${quote.heading ? `${quote.heading}：` : ''}${quote.text || ''}`;
}

export default function TutorChat(props) {
  return <ChatSession key={`${props.courseId || 'general'}:${props.lessonIndex ?? -1}`} {...props} />;
}

function ChatSession({ courseId = '', lessonIndex = -1, lessonTitle = '', quote, onClearQuote, inputRef, context = '', onSend, fullPage = false, suggestions = [] }) {
  const [messages, setMessages] = React.useState([]);
  const [draft, setDraft] = React.useState('');
  const [images, setImages] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [historyError, setHistoryError] = React.useState('');
  const [imageError, setImageError] = React.useState('');
  const [preparing, setPreparing] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [failed, setFailed] = React.useState(null);
  const [previewImage, setPreviewImage] = React.useState(null);
  const fileInput = React.useRef(null);
  const composer = React.useRef(null);
  const bottom = React.useRef(null);
  const alive = React.useRef(true);
  const request = React.useRef(null);
  const sendLock = React.useRef(false);
  const imageLock = React.useRef(false);
  const historyRequest = React.useRef(null);

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
      const items = await getTutorHistory({ courseId, lessonIndex, signal: controller.signal });
      if (alive.current && !controller.signal.aborted) {
        setMessages(items.map((item, index) => ({ ...item, id: item.id || `history-${index}`, text: item.content || item.text || '' })));
      }
    } catch (error) {
      if (alive.current && !controller.signal.aborted) setHistoryError(`历史记录读取失败：${error.message}`);
    } finally {
      if (alive.current && !controller.signal.aborted) setLoading(false);
    }
  }, [courseId, lessonIndex]);

  React.useEffect(() => {
    alive.current = true;
    loadHistory();
    return () => {
      alive.current = false;
      request.current?.abort();
      historyRequest.current?.abort();
    };
  }, [loadHistory]);

  React.useEffect(() => {
    const scroller = bottom.current?.parentElement;
    if (!scroller) return;
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
    if (nearBottom) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, sending, loading]);

  React.useEffect(() => { if (quote) composer.current?.focus(); }, [quote]);

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
    if (sendLock.current || imageLock.current || loading) return;
    const text = (suggestion ?? draft).trim();
    if (!retry && !text && !images.length) return;
    const id = retry?.id || (globalThis.crypto?.randomUUID?.() || `msg-${Date.now()}`);
    const payload = retry?.payload || {
      message: text,
      quote: quoteText(quote) || context,
      courseId, lessonIndex, lessonTitle,
      history: messages.filter((item) => ['user', 'assistant'].includes(item.role) && !item.pending).slice(-12).map((item) => ({ role: item.role, content: item.text || '' })),
      attachments: images,
    };
    sendLock.current = true;
    setSending(true);
    setFailed(null);
    setImageError('');
    const controller = new AbortController();
    request.current = controller;
    if (!retry) {
      setMessages((current) => [...current, { id, role: 'user', text, attachments: images, quote: quoteText(quote) }]);
      setDraft('');
      setImages([]);
      onClearQuote?.();
    }
    onSend?.();
    const answerId = `${id}-answer`;
    let streamed = '';
    let frame = 0;
    const paint = () => {
      frame = 0;
      if (!alive.current) return;
      setMessages((current) => current.map((item) => (item.id === answerId ? { ...item, text: streamed } : item)));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    setMessages((current) => [...current, { id: answerId, role: 'assistant', text: '', streaming: true }]);
    try {
      const result = await askTutorStream(payload, (event) => {
        if (!alive.current) return;
        if (event.type === 'meta') {
          setMessages((current) => current.map((item) => (item.id === answerId
            ? { ...item, citations: event.citations, model: event.model } : item)));
        } else if (event.type === 'delta') {
          streamed += event.text || '';
          schedule();
        } else if (event.type === 'done') {
          streamed = event.answer || streamed;
          schedule();
        }
      }, { signal: controller.signal });
      if (!alive.current) return;
      if (frame) cancelAnimationFrame(frame);
      streamed = streamed || result.answer || '';
      if (!streamed.trim()) throw new Error('没有收到回答，请重试');
      setMessages((current) => current.map((item) => (item.id === answerId
        ? { ...item, text: streamed, streaming: false } : item)));
    } catch (error) {
      if (frame) cancelAnimationFrame(frame);
      if (alive.current && !controller.signal.aborted) {
        setMessages((current) => current.map((item) => (item.id === answerId
          ? { ...item, text: streamed, streaming: false } : item)).filter((item) => item.id !== answerId || streamed));
        setFailed({ id, payload, error: error.message });
      }
    } finally {
      sendLock.current = false;
      if (alive.current) setSending(false);
    }
  };

  const speech = useSpeech((text) => setDraft((current) => `${current}${text}`));
  const shownMessages = messages.length ? messages : loading ? [] : [{ id: 'greeting', role: 'assistant', text: greeting }];
  const canSend = !loading && !sending && !preparing && (draft.trim() || images.length);

  return <aside className={`flex h-full flex-col bg-[#fcfcfd]${fullPage ? ' zx-tutor-full' : ''}`} aria-label="Lumin 学习助手对话">
    <div className="flex h-[76px] shrink-0 items-end justify-around border-b border-black/[0.08] px-5">
      <button type="button" className="flex h-12 items-center gap-2 px-6 text-sm font-bold text-[#8a8e98]" disabled>笔记</button>
      <button type="button" className="flex h-12 items-center gap-2 border-b-[3px] border-[#111318] px-6 text-sm font-black text-[#111318]" aria-current="page">对话</button>
    </div>
    <div className="flex items-center gap-2 border-b border-black/[0.06] px-6 py-3 text-sm font-extrabold text-[#444852]">
      <span className="h-2.5 w-2.5 rounded-full bg-[#358ff2]" />
      <span className="rounded bg-[#e9f4ff] px-2 py-0.5 text-xs text-[#2879cf]">Q&amp;A</span>
      Lumin
    </div>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-6 sm:px-7" role="log" aria-label="对话记录" aria-live="polite" aria-busy={sending || loading}>
      {loading && <p className="text-xs font-bold text-[#9297a3]">正在读取对话记录…</p>}
      {historyError && <div className="zx-tutor-inline-error" role="alert"><span>{historyError}</span><button type="button" onClick={loadHistory} disabled={sending}>重试</button></div>}
      {shownMessages.map((item) => <div key={item.id} className={`flex ${item.role === 'user' ? 'justify-end' : 'justify-start'}`}>
        <div className={`max-w-[88%] ${item.role === 'user' ? 'text-right' : ''}`}>
          <p className={`mb-1.5 flex items-center gap-2 text-xs font-extrabold ${item.role === 'user' ? 'justify-end text-[#6038ef]' : 'text-[#4d83d1]'}`}>
            {item.role === 'assistant' && <SparkIcon className="h-4 w-4" />}
            {item.role === 'user' ? '你' : 'Lumin 老师'}
          </p>
          {item.quote && <div className="mb-2 rounded-xl border-l-[3px] border-[#6038ef] bg-[#f2effc] px-3 py-2 text-left text-xs font-semibold leading-5 text-[#686c77]"><strong className="block text-[#454852]">引用：</strong>{quoteText(item.quote).slice(0, 80)}…</div>}
          {!!item.attachments?.length && <div className="zx-tutor-sent-images">{item.attachments.map((image, index) => image.dataUrl
            ? <button type="button" key={image.id || index} onClick={() => setPreviewImage(image)} aria-label={`查看图片：${image.name}`}><img src={image.dataUrl} alt={image.name || '提问图片'} /></button>
            : <span key={index}>{image.name || '图片附件'}</span>)}</div>}
          <div className={`rounded-2xl px-4 py-3 text-left text-sm font-semibold leading-6 ${item.role === 'user' ? 'rounded-tr-sm bg-[#6038ef] text-white' : 'rounded-tl-sm bg-[#eef2ff] text-[#555a75]'}`}>
            {item.role === 'assistant' ? <div className="zx-tutor-rich">{item.text ? <Markdown text={item.text} audience="learner" /> : <span className="zx-tutor-pending">正在回答…</span>}{item.streaming && item.text ? <span className="zx-tutor-caret" aria-hidden="true" /> : null}</div> : item.text}
          </div>
        </div>
      </div>)}
      {!loading && !messages.length && !!suggestions.length && <div className="zx-tutor-suggestions">{suggestions.map((text) => <button key={text} type="button" onClick={() => send(null, text)} disabled={sending}>{text}</button>)}</div>}
      {sending && <div className="flex items-center gap-2 text-xs font-bold text-[#7a7f8c]" role="status"><span className="zx-tutor-dot" />Lumin 正在查看资料并思考…</div>}
      {failed && <div className="zx-tutor-inline-error" role="alert"><span>未能回答：{failed.error}</span><button type="button" onClick={() => send(failed)} disabled={sending}>重新发送</button></div>}
      <div ref={bottom} />
    </div>
    <div className="shrink-0 p-5 pt-2">
      {quote && <div className="mx-2 flex items-start gap-3 rounded-t-xl border border-b-0 border-[#dcd6f2] bg-[#f3f0fc] px-4 py-3 text-xs font-semibold text-[#626672]">
        <div className="min-w-0 flex-1"><strong className="block truncate text-[#3d4048]">正在引用：{quote.heading}</strong><p className="mt-1 line-clamp-2 leading-5">{quote.text}</p></div>
        <button type="button" onClick={onClearQuote} aria-label="取消引用"><CloseIcon className="h-4 w-4" /></button>
      </div>}
      {!!images.length && <div className="zx-tutor-image-previews">{images.map((image) => <div key={image.id}><img src={image.dataUrl} alt={image.name} /><button type="button" aria-label={`移除图片：${image.name}`} onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))} disabled={sending || preparing}><CloseIcon className="h-3.5 w-3.5" /></button></div>)}</div>}
      {imageError && <p className="zx-tutor-image-error" role="alert">{imageError}</p>}
      <div className={`flex items-center gap-3 bg-white px-4 py-3 shadow-[0_8px_28px_rgba(17,19,24,0.13)] ${quote ? 'rounded-b-2xl border border-[#dcd6f2]' : 'rounded-2xl border border-black/[0.07]'}`}>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(event) => { addImages(event.target.files); event.target.value = ''; }} />
        <button type="button" className="zx-tutor-attach" aria-label="添加图片" title="添加图片，最多 3 张" disabled={sending || preparing || images.length >= TUTOR_MAX_IMAGES} onClick={() => fileInput.current?.click()}><ImageIcon className="h-6 w-6" /></button>
        <input ref={(node) => { composer.current = node; if (inputRef) inputRef.current = node; }} value={draft} maxLength={12000} aria-label="向 Lumin 老师提问" disabled={loading || sending} placeholder={preparing ? '正在压缩图片…' : sending ? 'Lumin 正在回答…' : quote ? '针对引用内容提问...' : '发送消息或引用讲义提问...'} className="min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none placeholder:text-[#a1a4ad]" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} onPaste={(event) => { const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); addImages(files); } }} />
        <button type="button" onClick={speech.toggle} disabled={!speech.supported || sending} className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition ${speech.listening ? 'animate-pulse bg-[#6038ef] text-white' : 'text-[#666b76] hover:bg-[#f0ebff] hover:text-[#6038ef]'} disabled:cursor-not-allowed disabled:opacity-30`} aria-label={speech.listening ? '停止语音输入' : '开始语音输入'} title={speech.supported ? '语音提问' : '当前浏览器不支持语音识别'}><MicIcon className="h-5 w-5" /></button>
        <button type="button" onClick={() => send()} disabled={!canSend} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#6038ef] text-white shadow-[0_6px_16px_rgba(96,56,239,0.28)] transition hover:bg-[#512bdc] disabled:cursor-not-allowed disabled:opacity-35" aria-label="发送消息" title="发送消息"><SendIcon className="h-5 w-5" /></button>
      </div>
      <p className="mt-2 text-center text-[10px] font-semibold text-[#a1a4ad]">{images.length ? `${images.length}/3 张图片 · ` : ''}支持 PNG、JPEG、WebP · Enter 发送</p>
    </div>
    {previewImage && <ImagePreview image={previewImage} onClose={() => setPreviewImage(null)} />}
  </aside>;
}
