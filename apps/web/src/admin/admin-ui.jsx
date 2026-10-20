import * as React from 'react';

export function StatusPill({ status }) {
  const live = status === 'published';
  return (
    <span className={`zx-pill ${live ? 'zx-pill-live' : 'zx-pill-draft'}`}>
      {live ? '已发布' : '草稿'}
    </span>
  );
}

export function Notice({ kind = 'info', children }) {
  if (!children) return null;
  return <div className={`zx-notice zx-notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function PageHead({ title, description, actions }) {
  return (
    <header className="zx-admin-head">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="zx-admin-actions">{actions}</div> : null}
    </header>
  );
}

export function StatCard({ label, value, hint }) {
  return (
    <div className="zx-stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

export function useLoad(loader, deps = []) {
  const [state, setState] = React.useState({ loading: true, error: '', data: null });
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setState((current) => ({ ...current, loading: true, error: '' }));
    loader()
      .then((data) => { if (active) setState({ loading: false, error: '', data }); })
      .catch((error) => { if (active) setState({ loading: false, error: error.message, data: null }); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, revision]);
  return { ...state, reload: () => setRevision((value) => value + 1) };
}

export function Loading({ label = '正在加载…' }) {
  return <div className="zx-skeleton" role="status">{label}</div>;
}

export function ErrorBlock({ message, onRetry }) {
  return (
    <div className="zx-card">
      <Notice kind="error">{message || '加载失败'}</Notice>
      {onRetry ? <button type="button" className="zx-btn zx-btn-primary" style={{ marginTop: 12 }} onClick={onRetry}>重试</button> : null}
    </div>
  );
}

export function formatCount(value) {
  return typeof value === 'number' ? value.toLocaleString('zh-CN') : '—';
}
