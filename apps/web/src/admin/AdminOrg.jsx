import * as React from 'react';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, PageHead, useLoad } from './admin-ui.jsx';

export default function AdminOrg() {
  const state = useLoad(() => adminApi.orgInfo(), []);
  const [form, setForm] = React.useState(null);
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');

  const org = state.data;

  React.useEffect(() => {
    if (org) setForm({ name: org.name || '', shortName: org.shortName || '' });
  }, [org?.name, org?.shortName]);

  if (state.loading && !state.data) return <Loading label="正在读取机构信息…" />;
  if (state.error) return <ErrorBlock message={state.error} onRetry={state.reload} />;
  if (!form) return <ErrorBlock message="机构信息读取失败" onRetry={state.reload} />;

  async function save(event) {
    event.preventDefault();
    setBusy('save');
    setError('');
    setMessage('');
    try {
      await adminApi.updateOrg({ name: form.name.trim(), shortName: form.shortName.trim() });
      setMessage('机构信息已保存。');
      state.reload();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }

  async function upload(file) {
    if (!file) return;
    setBusy('logo');
    setError('');
    setMessage('');
    try {
      await adminApi.uploadOrgLogo(file);
      setMessage('机构 Logo 已更新。');
      state.reload();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }

  async function removeLogo() {
    if (!window.confirm('移除机构 Logo？')) return;
    setBusy('logo');
    setError('');
    setMessage('');
    try {
      await adminApi.deleteOrgLogo();
      setMessage('机构 Logo 已移除。');
      state.reload();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="zx-admin-page">
      <PageHead title="机构设置" actions={<button type="button" className="zx-btn zx-btn-ghost" onClick={state.reload}>刷新</button>} />

      {error ? <Notice kind="error">{error}</Notice> : null}
      {message ? <Notice kind="ok">{message}</Notice> : null}

      <form className="zx-card" onSubmit={save}>
        <h2 className="zx-card-title">基础信息</h2>
        <div className="zx-form">
          <div className="zx-field">
            <label htmlFor="org-name">机构全称</label>
            <input
              id="org-name"
              value={form.name}
              maxLength={128}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </div>
          <div className="zx-field">
            <label htmlFor="org-short">机构简称</label>
            <input
              id="org-short"
              value={form.shortName}
              maxLength={64}
              onChange={(event) => setForm({ ...form, shortName: event.target.value })}
            />
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <button type="submit" className="zx-btn zx-btn-primary" disabled={busy === 'save' || !form.name.trim() || !form.shortName.trim()}>
            {busy === 'save' ? '保存中…' : '保存'}
          </button>
        </div>
      </form>

      <div className="zx-card">
        <h2 className="zx-card-title">机构 Logo</h2>
        <div className="zx-org-logo">
          <div className="zx-org-logo-box">
            {org.logoUrl ? (
              <img src={org.logoUrl} alt={org.shortName} />
            ) : (
              <span>还没有设置</span>
            )}
          </div>
          <div className="zx-org-logo-actions">
            <label className="zx-btn zx-btn-primary" style={{ cursor: 'pointer' }}>
              {busy === 'logo' ? '上传中…' : '上传 Logo'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                style={{ display: 'none' }}
                disabled={busy === 'logo'}
                onChange={(event) => {
                  upload(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            </label>
            {org.logoUrl ? (
              <button type="button" className="zx-btn zx-btn-danger" disabled={busy === 'logo'} onClick={removeLogo}>移除</button>
            ) : null}
            <small>支持 PNG / JPEG / WebP / GIF / SVG，不超过 4MB。</small>
          </div>
        </div>
      </div>
    </div>
  );
}
