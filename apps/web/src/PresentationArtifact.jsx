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

export default function PresentationArtifact({
  presentation,
  token = '',
  downloadName = 'presentation.pptx',
  className = '',
}) {
  const [state, setState] = React.useState({ loading: true, error: '', html: '', downloading: false });
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
      <button type="button" disabled={state.downloading || !presentation?.downloadUrl} onClick={download}>{state.downloading ? '下载中…' : '下载 PPTX'}</button>
    </header>
    {state.loading ? <div className="zx-cw-presentation-state">正在加载实际幻灯片预览…</div> : null}
    {state.error ? <div className="zx-cw-presentation-error" role="alert">{state.error}</div> : null}
    {state.html ? <iframe srcDoc={state.html} title="PPT 实际排版预览" /> : null}
  </section>;
}
