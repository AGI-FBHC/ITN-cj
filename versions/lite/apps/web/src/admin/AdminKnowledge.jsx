import * as React from 'react';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, PageHead, StatCard, useLoad } from './admin-ui.jsx';
import AdminBundles from './AdminBundles.jsx';
import Markdown from './Markdown.jsx';

const TABS = [
  { key: 'bundles', label: '资料包' },
  { key: 'search', label: '检索' },
];

export default function AdminKnowledge() {
  const state = useLoad(() => adminApi.kb(), []);
  const [tab, setTab] = React.useState('bundles');
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState('');

  const settings = state.data?.settings;
  const stats = state.data?.stats;

  async function search(event) {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy('search');
    setError('');
    try {
      setResults(await adminApi.kbSearch(query.trim(), settings?.topK || 6));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }

  if (state.loading && !state.data) return <Loading label="正在读取知识库…" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;

  return (
    <div className="zx-admin-page">
      <PageHead
        title="知识库"
        actions={<button type="button" className="zx-btn zx-btn-ghost" onClick={state.reload}>刷新</button>}
      />

      <div className="zx-tabs">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`zx-tab ${tab === item.key ? 'active' : ''}`}
            onClick={() => { setTab(item.key); setError(''); }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error ? <Notice kind="error">{error}</Notice> : null}

      {tab === 'bundles' ? (
        <>
          <div className="zx-stats" style={{ marginBottom: 16 }}>
            <StatCard label="文档" value={stats?.documents ?? 0} hint="已入库原文" />
            <StatCard label="切片" value={stats?.chunks ?? 0} hint="按内容块切分" />
            <StatCard
              label="已向量化"
              value={stats?.embedded ?? 0}
              hint={settings?.embedding?.keyConfigured ? `模型 ${settings.embedding.model || '未填写'}` : '未配置向量模型'}
            />
          </div>
          <AdminBundles />
        </>
      ) : (
        <div className="zx-card">
          <form style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }} onSubmit={search}>
            <input
              className="zx-field"
              style={{ flex: '1 1 320px', border: '1px solid rgba(80,51,130,.1)', borderRadius: 10, padding: '9px 11px', font: 'inherit' }}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="例如 循环队列怎么判断队满"
              aria-label="检索内容"
            />
            <button type="submit" className="zx-btn zx-btn-primary" disabled={busy === 'search'}>
              {busy === 'search' ? '检索中…' : '检索'}
            </button>
          </form>

          {results ? (
            <div className="zx-search-result">
              <div className="zx-search-meta">
                模式：{results.mode}
                {results.note ? ` · ${results.note}` : ''}
              </div>
              {results.hits.length === 0 ? (
                <Notice kind="info">没有命中任何切片。换一个更具体的说法，或者先补充知识库。</Notice>
              ) : (
                results.hits.map((hit, position) => (
                  <div className="zx-hit" key={hit.chunkId}>
                    <div className="zx-hit-head">
                      <span className="zx-hit-title">
                        {position + 1}. {hit.documentTitle}
                        {hit.headingPath ? ` · ${hit.headingPath}` : ''}
                      </span>
                      <span className="zx-hit-score">{hit.score.toFixed(4)}</span>
                    </div>
                    <div className="zx-hit-body">
                      <Markdown text={hit.text} />
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
