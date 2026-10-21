import * as React from 'react';
import Markdown from './admin/Markdown.jsx';
import { askTutor, getTutorHistory, prepareTutorImage, tutorHistory, TUTOR_MAX_IMAGES, TUTOR_MAX_TOTAL_BYTES } from './tutor.js';
import './tutor-chat.css';

function ChatIcon({ kind = 'chat', ...props }) {
  const paths = {
    chat: <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" />,
    image: <><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
    retry: <path d="M3 11a9 9 0 1 1 2.6 6.4M3 4v7h7" />,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[kind]}</svg>;
}

function quoteText(quote) {
  if (!quote) return '';
  if (typeof quote === 'string') return quote;
  return `${quote.heading ? `${quote.heading}：` : ''}${quote.text || ''}`;
}

function ImagePreview({ image, onClose }) {
  const dialog = React.useRef(null);
  React.useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="zx-tutor-image-dialog" onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }} aria-label="查看提问图片">
    <button type="button" aria-label="关闭图片预览" onClick={() => dialog.current?.close()}><ChatIcon kind="close" /></button>
    <img src={image.dataUrl} alt={image.name || '提问图片'} />
  </dialog>;
}

// A new instance isolates pending answers and drafts when changing chapters.
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

  const loadHistory = React.useCallback(async () => {
    historyRequest.current?.abort();
    const controller = new AbortController();
    historyRequest.current = controller;
    setLoading(true);
    setHistoryError('');
    try {
      const items = await getTutorHistory({ courseId, lessonIndex, signal: controller.signal });
      if (alive.current && !controller.signal.aborted) setMessages(items.map((item, index) => ({ ...item, id: item.id || `history-${index}`, text: item.content || item.text || '' })));
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
    bottom.current?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }, [messages, sending, loading]);
  React.useEffect(() => {
    if (quote) composer.current?.focus();
  }, [quote]);

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
      // Sequential decoding limits memory use with large camera photos.
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
    const id = retry?.id || crypto.randomUUID();
    const payload = retry?.payload || {
      message: text,
      quote: quoteText(quote) || context,
      courseId, lessonIndex, lessonTitle,
      history: tutorHistory(messages),
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
    try {
      const result = await askTutor({ ...payload, signal: controller.signal });
      if (!alive.current) return;
      if (!result.answer?.trim()) throw new Error('没有收到回答，请重试');
      setMessages((current) => [...current, { id: `${id}-answer`, role: 'assistant', text: result.answer, citations: result.citations, model: result.model }]);
    } catch (error) {
      if (alive.current && !controller.signal.aborted) setFailed({ id, payload, error: error.message });
    } finally {
      sendLock.current = false;
      if (alive.current) setSending(false);
    }
  };

  const greeting = lessonTitle
    ? `你好！学习“${lessonTitle}”时遇到问题，可以引用课程内容，也可以上传图片问我。`
    : '你好！我是你的学习导师。你可以提问知识点，也可以上传截图或题目图片一起讨论。';
  const shownMessages = messages.length ? messages : loading ? [] : [{ id: 'greeting', role: 'assistant', text: greeting }];
  const canSend = !loading && !sending && !preparing && (draft.trim() || images.length);

  return <aside className={`zx-tutor${fullPage ? ' zx-tutor-full' : ''}`} aria-label="人工智能导师对话">
    <header className="zx-tutor-heading">
      <span className="zx-tutor-heading-icon"><ChatIcon /></span>
      <div><h2>{fullPage ? '人工智能导师' : '对话'}</h2><p>{lessonTitle ? '围绕当前章节提问 · 支持图片' : '知识答疑 · 文字与图片'}</p></div>
    </header>
    <div className="zx-tutor-messages" role="log" aria-label="对话记录" aria-live="polite" aria-busy={sending || loading}>
      {loading && <p className="zx-tutor-status">正在读取对话记录…</p>}
      {historyError && <div className="zx-tutor-error" role="alert"><span>{historyError}</span><button type="button" onClick={loadHistory} disabled={sending}>重试读取</button></div>}
      {shownMessages.map((item) => <article key={item.id} className={`zx-tutor-message zx-tutor-message-${item.role}`}>
        <div className="zx-tutor-role">{item.role === 'user' ? '你' : 'AI 导师'}</div>
        <div className="zx-tutor-bubble">
          {item.quote && <blockquote className="zx-tutor-quote">{quoteText(item.quote).slice(0, 220)}</blockquote>}
          {!!item.attachments?.length && <div className="zx-tutor-sent-images">{item.attachments.map((image, index) => image.dataUrl
            ? <button type="button" key={image.id || index} onClick={() => setPreviewImage(image)} aria-label={`查看图片：${image.name}`}><img src={image.dataUrl} alt={image.name || '提问图片'} /></button>
            : <span key={index}>{image.name || '图片附件'}</span>)}</div>}
          {item.role === 'assistant' ? <Markdown text={item.text} audience="learner" /> : item.text && <p className="zx-tutor-user-text">{item.text}</p>}
        </div>
        {item.role === 'assistant' && !!item.citations?.length && <div className="zx-tutor-citations">参考：{item.citations.slice(0, 4).map((citation) => typeof citation === 'string' ? citation : citation.title || citation.docTitle || citation.sourcePath || '课程资料').join(' · ')}</div>}
      </article>)}
      {!loading && !messages.length && !!suggestions.length && <div className="zx-tutor-suggestions">{suggestions.map((text) => <button key={text} type="button" onClick={() => send(null, text)} disabled={sending}>{text}</button>)}</div>}
      {sending && <div className="zx-tutor-thinking" role="status"><span />导师正在查看资料并思考…</div>}
      {failed && <div className="zx-tutor-error" role="alert"><span>未能回答：{failed.error}</span><button type="button" onClick={() => send(failed)} disabled={sending}><ChatIcon kind="retry" />重新发送</button></div>}
      <div ref={bottom} />
    </div>
    <div className="zx-tutor-composer-wrap">
      {quote && <div className="zx-tutor-selected-quote"><div><strong>正在引用{quote.heading ? `：${quote.heading}` : ''}</strong><p>{quoteText(quote).slice(0, 180)}</p></div><button type="button" aria-label="取消引用" onClick={onClearQuote}><ChatIcon kind="close" /></button></div>}
      {!!images.length && <div className="zx-tutor-image-previews">{images.map((image) => <div key={image.id}><img src={image.dataUrl} alt={image.name} /><button type="button" aria-label={`移除图片：${image.name}`} onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))} disabled={sending || preparing}><ChatIcon kind="close" /></button></div>)}</div>}
      {imageError && <p className="zx-tutor-image-error" role="alert">{imageError}</p>}
      <form className="zx-tutor-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(event) => { addImages(event.target.files); event.target.value = ''; }} />
        <button type="button" className="zx-tutor-image-button" aria-label="添加图片" title="添加图片，最多 3 张" disabled={sending || preparing || images.length >= TUTOR_MAX_IMAGES} onClick={() => fileInput.current?.click()}><ChatIcon kind="image" /></button>
        <textarea ref={(node) => { composer.current = node; if (inputRef) inputRef.current = node; }} rows={2} value={draft} maxLength={12000} aria-label="向人工智能导师提问" disabled={loading || sending} placeholder={loading ? '正在读取对话…' : sending ? '导师正在回答…' : '输入问题，或添加图片…'} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} onPaste={(event) => { const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); addImages(files); } }} />
        <button type="submit" className="zx-tutor-send" disabled={!canSend} aria-label="发送消息" title="发送消息"><ChatIcon kind="send" /></button>
      </form>
      <p className="zx-tutor-footnote">{preparing ? '正在压缩图片…' : `${images.length ? `${images.length}/3 张图片 · ` : ''}支持 PNG、JPEG、WebP · Enter 发送，Shift+Enter 换行`}</p>
    </div>
    {previewImage && <ImagePreview image={previewImage} onClose={() => setPreviewImage(null)} />}
  </aside>;
}
