import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice } from './admin-ui.jsx';
import { CoursewareContent, StepTimeline } from './CoursewareView.jsx';

const STATUS = {
  generating: { label: '生成中', kind: 'draft' },
  ready: { label: '待发布', kind: 'draft' },
  failed: { label: '失败', kind: 'draft' },
};

export default function AdminCoursewarePreview() {
  const { coursewareId } = useParams();
  const navigate = useNavigate();
  const [state, setState] = React.useState({ loading: true, error: '', item: null, steps: [], content: null });
  const [busy, setBusy] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState('');
  const timer = React.useRef(null);

  const load = React.useCallback(() => {
    setState((current) => ({ ...current, loading: true, error: '' }));
    adminApi
      .cwDetail(coursewareId)
      .then((result) => setState({ loading: false, error: '', item: result.item, steps: result.steps || [], content: result.content }))
      .catch((failure) => setState({ loading: false, error: failure.message, item: null, steps: [], content: null }));
  }, [coursewareId]);

  React.useEffect(() => { load(); }, [load]);

  // 生成中继续轮询
  React.useEffect(() => {
    if (state.item?.status !== 'generating') {
      if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
      return undefined;
    }
    timer.current = window.setTimeout(load, 3000);
    return () => {
      if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    };
  }, [state.item?.status, load]);

  async function act(key, task, okMessage) {
    setBusy(key);
    setError('');
    setMessage('');
    try {
      await task();
      if (okMessage) setMessage(okMessage);
      load();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }

  if (state.loading && !state.item) return <Loading label="正在读取课件…" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={load} />;
  if (!state.item) return <ErrorBlock message="没有找到这份课件" onRetry={load} />;

  const item = state.item;
  const status = item.published ? { label: '已发布', kind: 'live' } : (STATUS[item.status] || STATUS.draft);

  return (
    <div className="zx-admin-page">
      <header className="zx-preview-bar">
        <button type="button" className="zx-preview-back" onClick={() => navigate('/admin/courseware')}>← 返回课件</button>
        <div className="zx-preview-bar-title">
          <strong title={item.title}>{item.title || item.kindLabel}</strong>
          <span>{item.kindLabel} · {item.bundleTitle} · {item.docTitle}</span>
        </div>
        <div className="zx-preview-bar-actions">
          <span className={`zx-pill ${status.kind === 'live' ? 'zx-pill-live' : 'zx-pill-draft'}`}>{status.label}</span>
          {item.published ? (
            <button type="button" className="zx-btn zx-btn-sm zx-btn-ghost" disabled={busy === 'status'}
              onClick={() => act('status', () => adminApi.cwUnpublish(item.id), '已下架。')}>
              下架
            </button>
          ) : (
            <button type="button" className="zx-btn zx-btn-sm zx-btn-primary" disabled={busy === 'status' || item.status !== 'ready'}
              onClick={() => act('status', () => adminApi.cwPublish(item.id), '已发布。')}>
              发布
            </button>
          )}
          <button type="button" className="zx-btn zx-btn-sm zx-btn-danger" disabled={busy === 'delete'}
            onClick={() => {
              if (!window.confirm('删除这份课件？')) return;
              act('delete', async () => {
                await adminApi.cwDelete(item.id);
                navigate('/admin/courseware');
              }, '');
            }}>
            删除
          </button>
        </div>
      </header>

      {error ? <Notice kind="error">{error}</Notice> : null}
      {message ? <Notice kind="ok">{message}</Notice> : null}
      {item.status === 'failed' && item.errorMessage ? <Notice kind="error">{item.errorMessage}</Notice> : null}

      <div className="zx-card">
        <h2 className="zx-card-title">生成流程</h2>
        <StepTimeline steps={state.steps} />
        {item.status === 'generating' ? <div className="zx-card-hint">生成中，页面会自动刷新。</div> : null}
        {item.model ? <div className="zx-card-hint">模型：{item.model}</div> : null}
      </div>

      <div className="zx-card">
        {state.content ? (
          <CoursewareContent kind={item.kind} content={state.content} />
        ) : (
          <Notice kind="info">{item.status === 'generating' ? '还在生成，稍候刷新。' : '没有产物内容。'}</Notice>
        )}
      </div>
    </div>
  );
}
