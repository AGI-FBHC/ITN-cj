import * as React from 'react';
import './presentation-artifact.css';

const BACKGROUND_LABELS = {
  'clean-minimal': '极简留白',
  'blue-white-minimal': '蓝白简约',
  'blue-conference': '蓝色会议',
  'abstract-gradient': '抽象渐变',
  'business-gray': '商务灰',
  'cartoon-doodle': '卡通涂鸦',
  'colorful-ink': '彩色水墨',
  'morandi-blue-gray': '莫兰迪蓝灰',
  'sunset-mountains': '橙红山脉',
  watercolor: '水彩',
  none: '纯色',
};

const PAGED_STYLE = [
  'body{padding:0!important;background:#e9e6f0!important;overflow:hidden!important}',
  '.slide{display:none!important;margin:0 auto!important;border-radius:0!important;box-shadow:none!important;max-width:1280px!important}',
  '.slide.zx-preview-active{display:block!important}',
].join('');

function ArrowIcon({ direction }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {direction === 'prev' ? <path d="m15 18-6-6 6-6" /> : <path d="m9 18 6-6-6-6" />}
  </svg>;
}

export default function PresentationArtifact({
  presentation,
  token = '',
  downloadName = 'presentation.pptx',
  className = '',
}) {
  const [state, setState] = React.useState({ loading: true, error: '', html: '', downloading: false });
  const [mode, setMode] = React.useState('scroll');
  const [page, setPage] = React.useState(1);
  const [total, setTotal] = React.useState(0);
  const frame = React.useRef(null);
  const wheelLock = React.useRef(0);
  const sessionToken = token || (typeof window === 'undefined' ? '' : (
    window.localStorage.getItem('zhixun-learning-v2-token')
    || window.localStorage.getItem('zhixun-admin-token')
    || ''
  ));

  React.useEffect(() => {
    if (!presentation?.previewUrl) {
      setState({ loading: false, error: '没有可用的 PPT 预览', html: '', downloading: false });
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    setState({ loading: true, error: '', html: '', downloading: false });
    setPage(1);
    setTotal(0);
    fetch(presentation.previewUrl, {
      headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {},
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('PPT 预览加载失败');
        const html = await response.text();
        if (active) setState({ loading: false, error: '', html, downloading: false });
      })
      .catch((error) => {
        if (active && error.name !== 'AbortError') setState({ loading: false, error: error.message, html: '', downloading: false });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [presentation?.previewUrl, sessionToken]);

  // The preview iframe is same-origin (srcDoc), so slide paging is driven here
  // instead of maintaining a second copy of the deck inside React.
  const applyMode = React.useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    const slides = Array.from(doc.querySelectorAll('.slide'));
    if (!slides.length) return;
    setTotal((current) => (current === slides.length ? current : slides.length));
    const active = Math.min(Math.max(1, page), slides.length);
    if (active !== page) setPage(active);
    let style = doc.getElementById('zx-preview-mode');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'zx-preview-mode';
      doc.head?.appendChild(style);
    }
    style.textContent = mode === 'paged' ? PAGED_STYLE : '';
    slides.forEach((slide, index) => slide.classList.toggle('zx-preview-active', mode === 'paged' && index === active - 1));
    if (mode === 'paged') {
      doc.documentElement.scrollTop = 0;
      doc.body.scrollTop = 0;
    }
  }, [mode, page]);

  React.useEffect(() => { applyMode(); }, [applyMode, state.html]);

  const go = React.useCallback((delta) => {
    setPage((current) => {
      const limit = total || 1;
      return Math.min(limit, Math.max(1, current + delta));
    });
  }, [total]);

  const onKeyDown = (event) => {
    if (mode !== 'paged') return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); go(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); go(1); }
  };

  const onWheel = (event) => {
    if (mode !== 'paged' || total < 2) return;
    const now = Date.now();
    if (now < wheelLock.current) return;
    const dominant = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (Math.abs(dominant) < 8) return;
    event.preventDefault();
    wheelLock.current = now + 420;
    go(dominant > 0 ? 1 : -1);
  };

  const download = async () => {
    if (!presentation?.downloadUrl || state.downloading) return;
    setState((current) => ({ ...current, downloading: true, error: '' }));
    try {
      const response = await fetch(presentation.downloadUrl, {
        headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {},
      });
      if (!response.ok) throw new Error('PPT 下载失败');
      const href = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = downloadName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    } finally {
      setState((current) => ({ ...current, downloading: false }));
    }
  };

  return <section className={['zx-cw-presentation', className].filter(Boolean).join(' ')}>
    <header>
      <div>
        <span>旧版模板 · {BACKGROUND_LABELS[presentation?.backgroundStyle] || '预设背景'}</span>
        <strong>{presentation?.renderer === 'lumin-python-pptx-v1' ? 'ITN Presentation Template' : '演示文稿'}</strong>
      </div>
      <div className="zx-cw-presentation-actions">
        {total > 1 ? <div className="zx-cw-presentation-modes" role="group" aria-label="幻灯片播放方式">
          <button type="button" className={mode === 'scroll' ? 'is-active' : ''} aria-pressed={mode === 'scroll'} onClick={() => setMode('scroll')}>连续滚动</button>
          <button type="button" className={mode === 'paged' ? 'is-active' : ''} aria-pressed={mode === 'paged'} onClick={() => setMode('paged')}>单页翻页</button>
        </div> : null}
        {total > 1 && mode === 'paged' ? <div className="zx-cw-presentation-pager">
          <button type="button" aria-label="上一页" title="上一页（←）" disabled={page <= 1} onClick={() => go(-1)}><ArrowIcon direction="prev" /></button>
          <span aria-live="polite">{page} / {total}</span>
          <button type="button" aria-label="下一页" title="下一页（→）" disabled={page >= total} onClick={() => go(1)}><ArrowIcon direction="next" /></button>
        </div> : null}
        <button type="button" className="zx-cw-presentation-download" disabled={state.downloading || !presentation?.downloadUrl} onClick={download}>{state.downloading ? '下载中…' : '下载 PPTX'}</button>
      </div>
    </header>
    {state.loading ? <div className="zx-cw-presentation-state">正在加载实际幻灯片预览…</div> : null}
    {state.error ? <div className="zx-cw-presentation-error" role="alert">{state.error}</div> : null}
    {state.html ? <div className="zx-cw-presentation-stage" tabIndex={0} role="region" aria-label="演示文稿预览，可用左右方向键翻页" onKeyDown={onKeyDown} onWheel={onWheel}>
      <iframe ref={frame} srcDoc={state.html} title="PPT 实际排版预览" onLoad={applyMode} />
    </div> : null}
  </section>;
}
