import * as React from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, useLoad } from './admin-ui.jsx';
import Markdown from './Markdown.jsx';
import BundleLogoPicker from './BundleLogoPicker.jsx';
import BundlePipeline, { BundleLogo, bundleBusy } from './BundlePipeline.jsx';

const PAGE_SIZE = 30;

export default function AdminBundlePreview() {
  const { bundleId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedDocId = searchParams.get('docId') || '';
  const state = useLoad(() => adminApi.kbBundle(bundleId), [bundleId]);
  const [active, setActive] = React.useState(0);
  const [view, setView] = React.useState('original');
  const [offset, setOffset] = React.useState(0);
  const [showLog, setShowLog] = React.useState(false);
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [pollError, setPollError] = React.useState('');
  const body = React.useRef(null);
  const bundle = state.data?.bundle;
  const docs = state.data?.docs || [];
  const selectedDoc = docs[Math.min(active, Math.max(0, docs.length - 1))];
  const chapter = useLoad(() => {
    if (view !== 'original' || !selectedDoc?.id) return Promise.resolve(null);
    return adminApi.kbBundleDocument(bundleId, selectedDoc.id);
  }, [bundleId, bundle?.status, view, selectedDoc?.id]);
  const totalChars = docs.reduce((sum, doc) => sum + (doc.charCount || 0), 0);
  const warningData = bundle?.warnings || state.data?.warnings;
  const warnings = Array.isArray(warningData) ? warningData.filter((item) => typeof item === 'string') : [];
  const published = bundle?.courseStatus === 'published';
  const pipeline = bundle?.pipeline;
  const progress = pipeline ? `${pipeline.totalChunks}:${pipeline.summarizedChunks}:${pipeline.embeddedChunks}:${pipeline.failedChunks}:${pipeline.status}` : '';
  const chunks = useLoad(
    () => view === 'chunks' ? adminApi.kbBundleChunks(bundleId, offset, PAGE_SIZE) : Promise.resolve(null),
    [bundleId, view, offset, progress],
  );
  const latest = React.useRef(state.data);
  latest.current = state.data;
  const processing = bundleBusy(bundle);
  React.useEffect(() => {
    if (!processing) return undefined;
    let active = true;
    let timer;
    const refresh = async () => {
      try {
        const { bundle: next } = await adminApi.kbBundleStatus(bundleId);
        if (!active || !next) return;
        setPollError('');
        const previous = latest.current?.bundle;
        // Preserve the source array: polling a large book must not download or
        // parse its complete text again just to update a progress counter.
        state.updateData((current) => current ? { ...current, bundle: next } : current);
        if (previous && (previous.docCount !== next.docCount || (previous.status !== 'ready' && next.status === 'ready'))) {
          state.reload();
        }
      } catch (failure) {
        if (active) setPollError(failure.message);
      } finally {
        if (active) timer = window.setTimeout(refresh, 2500);
      }
    };
    timer = window.setTimeout(refresh, 2500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [bundleId, processing, state.reload, state.updateData]);
  React.useEffect(() => { setActive(0); setOffset(0); setView('original'); setPollError(''); }, [bundleId]);
  React.useEffect(() => {
    if (!requestedDocId || docs.length === 0) return;
    const index = docs.findIndex((doc) => doc.id === requestedDocId);
    if (index >= 0 && index !== active) setActive(index);
  }, [active, docs, requestedDocId]);

  async function run(key, task, success) {
    if (busy) return;
    setBusy(key);
    setError('');
    setMessage('');
    try {
      const result = await task();
      setMessage(typeof success === 'function' ? success(result) : success);
      state.reload();
      if (view === 'chunks') chunks.reload();
    } catch (failure) {
      setError(failure.message);
    } finally { setBusy(''); }
  }

  function selectChapter(index) {
    setActive(index);
    body.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  if (state.loading && !state.data) return <Loading label="正在读取资料包…" />;
  if (state.error && !state.data) return <ErrorBlock message={state.error} onRetry={state.reload} />;
  if (!bundle) return <ErrorBlock message="没有找到这个资料包" onRetry={state.reload} />;
  const currentDoc = chapter.data?.doc?.id === selectedDoc?.id ? chapter.data.doc : null;
  const chunkData = chunks.data?.offset === offset ? chunks.data : null;
  const chunkTotal = chunkData?.total || 0;

  return (
    <div className="zx-admin-page">
      <header className="zx-preview-bar">
        <button type="button" className="zx-preview-back" onClick={() => navigate('/admin/knowledge')}>← 返回知识库</button>
        <div className="zx-preview-bar-title">
          <strong title={bundle.title || bundle.name}>{bundle.title || bundle.name}</strong>
          <span>{bundle.name} · {docs.length} 章 · {totalChars.toLocaleString('zh-CN')} 字{Number.isFinite(bundle.assetCount) ? ` · ${bundle.assetCount} 张图片` : ''}</span>
        </div>
        <div className="zx-preview-bar-actions">
          <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" onClick={() => setShowLog(!showLog)}>{showLog ? '隐藏日志' : '运行日志'}</button>
          
          <button type="button" className="zx-btn zx-btn-sm zx-btn-danger" disabled={Boolean(busy)} onClick={() => {
            if (!window.confirm(`删除《${bundle.name}》？对应课程、课件和学习记录将一并删除，无法恢复。`)) return;
            run('delete', async () => { await adminApi.deleteKbBundle(bundle.id); navigate('/admin/knowledge'); }, '');
          }}>删除</button>
        </div>
      </header>

      {error ? <Notice kind="error">{error}</Notice> : null}
      {state.error || pollError ? <Notice kind="error">进度暂时无法更新：{pollError || state.error} <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" onClick={state.reload}>重试</button></Notice> : null}
      {message ? <Notice kind="ok">{message}</Notice> : null}
      {bundle.errorMessage ? <Notice kind="error">{bundle.errorMessage}</Notice> : null}
      <section className="zx-bundle-overview">
        <BundleLogo bundle={bundle} size={64} />
        <BundlePipeline bundle={bundle} busy={busy} onRetry={(stage) => run(`retry-${stage}`, () => adminApi.retryKbBundle(bundle.id, stage), '已提交补全任务，将保留原文与已完成的处理结果。')} />
      </section>
      <BundleLogoPicker bundle={bundle} onChanged={state.reload} />
      {warnings.length > 0 ? <Notice kind="info"><strong>资料提示</strong><ul className="zx-preview-warnings">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></Notice> : null}
      {showLog ? <pre className="zx-bundle-log">{state.data.log || '（没有日志）'}</pre> : null}

      <div className="zx-preview-tabs" role="tablist" aria-label="资料预览方式">
        <button type="button" role="tab" aria-selected={view === 'original'} aria-controls="bundle-original" className={view === 'original' ? 'active' : ''} onClick={() => setView('original')}>原文</button>
        <button type="button" role="tab" aria-selected={view === 'chunks'} aria-controls="bundle-chunks" className={view === 'chunks' ? 'active' : ''} onClick={() => setView('chunks')}>切片与摘要{pipeline ? `（${pipeline.totalChunks || 0}）` : ''}</button>
      </div>

      {view === 'original' ? (
        <div className="zx-preview" id="bundle-original" role="tabpanel">
          <aside className="zx-preview-toc">
            <div className="zx-preview-toc-title">章节 · {docs.length}</div>
            {docs.map((doc, index) => (
              <button key={doc.id || doc.order || index} type="button" className={`zx-preview-toc-item ${active === index ? 'active' : ''}`} onClick={() => selectChapter(index)} aria-current={active === index ? 'true' : undefined}>
                <span className="zx-preview-toc-index">{doc.order ?? index + 1}</span><span>{doc.title}</span>
              </button>
            ))}
          </aside>
          <article className="zx-preview-body" ref={body}>
            {chapter.error ? <ErrorBlock message={chapter.error} onRetry={chapter.reload} /> : null}
            {!currentDoc && !chapter.error && selectedDoc ? <Loading label="正在读取当前章节…" /> : null}
            {currentDoc ? <section className="zx-preview-chapter" key={currentDoc.id || currentDoc.order || active}>
              <h2 className="zx-preview-chapter-title">{currentDoc.title}</h2>
              {currentDoc.sourcePath ? <p className="zx-preview-source">源文件：{currentDoc.sourcePath}</p> : null}
              <Markdown text={currentDoc.content} />
              <div className="zx-chapter-pager">
                <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" disabled={active === 0} onClick={() => selectChapter(active - 1)}>上一章</button>
                <span>{active + 1} / {docs.length}</span>
                <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" disabled={active >= docs.length - 1} onClick={() => selectChapter(active + 1)}>下一章</button>
              </div>
            </section> : !selectedDoc ? <Notice kind="info">原文正在整理，就绪后会自动显示。</Notice> : null}
          </article>
        </div>
      ) : (
        <section className="zx-chunks-preview" id="bundle-chunks" role="tabpanel">
          <div className="zx-chunk-page-head">
            <span>{chunkData ? `共 ${chunkTotal} 个切片，当前 ${chunkTotal ? offset + 1 : 0}–${Math.min(offset + PAGE_SIZE, chunkTotal)}` : '正在读取切片…'}</span>
            <div className="zx-preview-bar-actions">
              <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" disabled={chunks.loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</button>
              <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" disabled={chunks.loading || !chunkData || offset + PAGE_SIZE >= chunkTotal} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</button>
            </div>
          </div>
          {chunks.error ? <ErrorBlock message={chunks.error} onRetry={chunks.reload} /> : null}
          {!chunkData && !chunks.error ? <Loading label="正在读取当前页切片…" /> : null}
          {chunkData?.chunks?.length === 0 ? <Notice kind="info">还没有生成切片，处理完成后会自动显示。</Notice> : null}
          {chunkData?.chunks?.map((chunk, index) => <article className="zx-chunk-card" key={chunk.id}>
            <header className="zx-chunk-card-head">
              <h3>#{offset + index + 1} {Array.isArray(chunk.headingPath) ? chunk.headingPath.join(' / ') : chunk.headingPath || '正文'}</h3>
              <span className={`zx-pill ${chunk.hasVector ? 'zx-pill-live' : 'zx-pill-draft'}`}>{chunk.hasVector ? '已向量化' : '待向量化'}</span>
            </header>
            <p className="zx-preview-source">{chunk.sourcePath || '原文'}{Number.isFinite(chunk.startOffset) ? ` · 原文位置 ${chunk.startOffset}–${chunk.endOffset}` : ''}</p>
            <div className="zx-chunk-summary"><strong>AI 摘要</strong>
              <p>{chunk.summary || (chunk.summaryStatus === 'failed' ? '摘要生成失败，可在上方补全摘要与关键词。' : '摘要尚未生成。')}</p>
              {Array.isArray(chunk.keywords) && chunk.keywords.length > 0 ? <div className="zx-chunk-keywords">{chunk.keywords.map((word, key) => <span key={key}>{word}</span>)}</div> : null}
            </div>
            <details className="zx-chunk-original"><summary>查看切片原文</summary><Markdown text={chunk.text} /></details>
          </article>)}
        </section>
      )}
    </div>
  );
}
