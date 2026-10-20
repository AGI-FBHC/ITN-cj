import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, useLoad } from './admin-ui.jsx';
import Markdown from './Markdown.jsx';

export default function AdminBundlePreview() {
  const { bundleId } = useParams();
  const navigate = useNavigate();
  const state = useLoad(() => adminApi.kbBundle(bundleId), [bundleId]);
  const [active, setActive] = React.useState(0);
  const [showLog, setShowLog] = React.useState(false);

  const bundle = state.data?.bundle;
  const docs = state.data?.docs || [];
  const totalChars = docs.reduce((sum, doc) => sum + (doc.charCount || 0), 0);
  const warningData = bundle?.warnings || state.data?.warnings;
  const warnings = Array.isArray(warningData) ? warningData.filter((item) => typeof item === 'string') : [];

  if (state.loading && !state.data) return <Loading label="正在读取整理结果…" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;
  if (!bundle) return <ErrorBlock message="没有找到这个资料包" onRetry={state.reload} />;

  return (
    <div className="zx-admin-page">
      <header className="zx-preview-bar">
        <button type="button" className="zx-preview-back" onClick={() => navigate('/admin/knowledge')}>
          ← 返回知识库
        </button>
        <div className="zx-preview-bar-title">
          <strong title={bundle.title || bundle.name}>{bundle.title || bundle.name}</strong>
          <span>
            {bundle.name} · {docs.length} 章 · {totalChars.toLocaleString('zh-CN')} 字
            {Number.isFinite(bundle.assetCount) ? ` · ${bundle.assetCount} 张图片` : ''}
          </span>
        </div>
        <div className="zx-preview-bar-actions">
          <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" onClick={() => setShowLog(!showLog)}>
            {showLog ? '隐藏日志' : '运行日志'}
          </button>
          <button
            type="button"
            className="zx-btn zx-btn-sm zx-btn-danger"
            onClick={async () => {
              if (!window.confirm(`删除《${bundle.name}》的整理结果？`)) return;
              try {
                await adminApi.deleteKbBundle(bundle.id);
                navigate('/admin/knowledge');
              } catch (failure) {
                window.alert(failure.message);
              }
            }}
          >
            删除
          </button>
        </div>
      </header>

      {bundle.errorMessage ? <Notice kind="error">{bundle.errorMessage}</Notice> : null}
      {warnings.length > 0 ? (
        <Notice kind="info">
          <strong>资料提示</strong>
          <ul className="zx-preview-warnings">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        </Notice>
      ) : null}
      {showLog ? <pre className="zx-bundle-log">{state.data.log || '（没有日志）'}</pre> : null}

      <div className="zx-preview">
        <aside className="zx-preview-toc">
          <div className="zx-preview-toc-title">章节</div>
          {docs.map((doc, index) => (
            <button
              key={doc.order}
              type="button"
              className={`zx-preview-toc-item ${active === index ? 'active' : ''}`}
              onClick={() => {
                setActive(index);
                document.getElementById(`chapter-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              <span className="zx-preview-toc-index">{doc.order}</span>
              <span>{doc.title}</span>
            </button>
          ))}
        </aside>

        <article className="zx-preview-body">
          {docs.length === 0 ? (
            <Notice kind="info">这个资料包还没有产出章节。</Notice>
          ) : (
            docs.map((doc, index) => (
              <section key={doc.order} id={`chapter-${index}`} className="zx-preview-chapter">
                <h2 className="zx-preview-chapter-title">{doc.title}</h2>
                {doc.sourcePath ? <p className="zx-preview-source">源文件：{doc.sourcePath}</p> : null}
                <Markdown text={doc.content} />
              </section>
            ))
          )}
        </article>
      </div>
    </div>
  );
}
