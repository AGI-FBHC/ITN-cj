import * as React from 'react';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice, PageHead, useLoad } from './admin-ui.jsx';
import { loadOrgBrand } from '../org-brand.js';
import './org-invites.css';

const emptyOrg = () => ({ name: '', shortName: '', inviteCode: '' });

export default function AdminOrg() {
  const organizations = useLoad(() => adminApi.orgs(), []);
  const [selectedId, setSelectedId] = React.useState('');
  const state = useLoad(() => adminApi.orgInfo(selectedId), [selectedId]);
  const [form, setForm] = React.useState(null);
  const [creating, setCreating] = React.useState(false);
  const [newOrg, setNewOrg] = React.useState(emptyOrg);
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const org = state.data && (!selectedId || state.data.id === selectedId) ? state.data : null;
  const list = organizations.data?.organizations || [];
  const options = org && !list.some((item) => item.id === org.id) ? [org, ...list] : list;

  React.useEffect(() => {
    if (org) setForm({ orgId: org.id, name: org.name || '', shortName: org.shortName || '', inviteCode: org.inviteCode || '' });
  }, [org?.id, org?.name, org?.shortName, org?.inviteCode]);

  const begin = (action) => { setBusy(action); setError(''); setMessage(''); };
  const reload = () => { state.reload(); organizations.reload(); };
  async function save(event) {
    event.preventDefault();
    if (busy || !org) return;
    begin('save');
    try {
      await adminApi.updateOrg({ name: form.name.trim(), shortName: form.shortName.trim(), inviteCode: form.inviteCode.trim() }, org.id);
      setMessage('机构名称和邀请码已保存。更换邀请码不影响已有账号。');
      reload();
      await loadOrgBrand({ force: true });
    } catch (failure) { setError(failure.message); }
    finally { setBusy(''); }
  }

  async function create(event) {
    event.preventDefault();
    if (busy) return;
    begin('create');
    try {
      const created = await adminApi.createOrg({ name: newOrg.name.trim(), shortName: newOrg.shortName.trim(), inviteCode: newOrg.inviteCode.trim() });
      setSelectedId(created.id);
      setNewOrg(emptyOrg());
      setCreating(false);
      organizations.reload();
      setMessage('机构已创建，可继续设置 Logo 并分发邀请码。');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(''); }
  }

  async function upload(file) {
    if (!file || busy || !org) return;
    if (file.size > 4 * 1024 * 1024) { setError('Logo 不能超过 4MB。'); return; }
    begin('logo');
    try {
      await adminApi.uploadOrgLogo(file, org.id);
      setMessage('当前机构 Logo 已更新。');
      reload();
      await loadOrgBrand({ force: true });
    } catch (failure) { setError(failure.message); }
    finally { setBusy(''); }
  }

  async function removeLogo() {
    if (busy || !org || !window.confirm(`移除“${org.shortName}”的 Logo？`)) return;
    begin('logo');
    try {
      await adminApi.deleteOrgLogo(org.id);
      setMessage('当前机构 Logo 已移除。');
      reload();
      await loadOrgBrand({ force: true });
    } catch (failure) { setError(failure.message); }
    finally { setBusy(''); }
  }

  async function copyInvite() {
    setError(''); setMessage('');
    try {
      await navigator.clipboard.writeText(org.inviteCode);
      setMessage('已复制当前保存的邀请码。');
    } catch { setError('暂时无法自动复制，请选中已保存的邀请码后手动复制。'); }
  }

  return <div className="zx-admin-page">
    <PageHead title="机构设置" description="选择机构，管理名称、Logo 和注册邀请码。" actions={<button type="button" className="zx-btn zx-btn-ghost" disabled={Boolean(busy)} onClick={reload}>刷新</button>} />
    {error && <Notice kind="error">{error}</Notice>}
    {message && <Notice kind="ok">{message}</Notice>}
    <section className="zx-card">
      <div className="zx-org-select-row">
        <div className="zx-field zx-org-select-field"><label htmlFor="org-select">当前机构</label><select id="org-select" value={selectedId || org?.id || ''} disabled={Boolean(busy) || !options.length} onChange={(event) => { setSelectedId(event.target.value); setError(''); setMessage(''); }}>{!options.length && <option value="">正在读取机构…</option>}{options.map((item) => <option key={item.id} value={item.id}>{item.name || item.shortName}</option>)}</select></div>
        <button type="button" className="zx-btn zx-btn-primary" disabled={Boolean(busy)} onClick={() => { setCreating(!creating); setError(''); setMessage(''); }}>{creating ? '收起新增' : '新增机构'}</button>
      </div>
      {organizations.error && <div className="zx-org-list-error"><Notice kind="error">{organizations.error}</Notice><button type="button" className="zx-btn zx-btn-ghost" onClick={organizations.reload}>重试列表</button></div>}
      {creating && <form className="zx-org-create" onSubmit={create}>
        <h2 className="zx-card-title">新增机构</h2>
        <div className="zx-form">
          <div className="zx-field"><label htmlFor="new-org-name">机构全称</label><input id="new-org-name" required maxLength={128} value={newOrg.name} onChange={(event) => setNewOrg({ ...newOrg, name: event.target.value })} /></div>
          <div className="zx-field"><label htmlFor="new-org-short">机构简称</label><input id="new-org-short" required maxLength={64} value={newOrg.shortName} onChange={(event) => setNewOrg({ ...newOrg, shortName: event.target.value })} /></div>
          <div className="zx-field"><label htmlFor="new-org-invite">注册邀请码</label><input id="new-org-invite" required minLength={6} pattern="[A-Za-z0-9_-]{6,64}" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={64} value={newOrg.inviteCode} onChange={(event) => setNewOrg({ ...newOrg, inviteCode: event.target.value })} /><small>6–64 位字母、数字、短横线或下划线；不同机构不可重复。</small></div>
        </div>
        <div className="zx-org-save-row"><button type="submit" className="zx-btn zx-btn-primary" disabled={Boolean(busy) || !newOrg.name.trim() || !newOrg.shortName.trim() || !newOrg.inviteCode.trim()}>{busy === 'create' ? '创建中…' : '创建机构'}</button></div>
      </form>}
    </section>

    {state.error ? <ErrorBlock message={state.error} onRetry={state.reload} /> : !org || !form || form.orgId !== org.id ? <Loading label="正在读取机构信息…" /> : <>
      <form className="zx-card" onSubmit={save}>
        <h2 className="zx-card-title">基础信息与邀请码</h2>
        <div className="zx-form">
          <div className="zx-field"><label htmlFor="org-name">机构全称</label><input id="org-name" required value={form.name} maxLength={128} onChange={(event) => setForm({ ...form, name: event.target.value })} /></div>
          <div className="zx-field"><label htmlFor="org-short">机构简称</label><input id="org-short" required value={form.shortName} maxLength={64} onChange={(event) => setForm({ ...form, shortName: event.target.value })} /></div>
          <div className="zx-field zx-field-full"><label htmlFor="org-invite">注册邀请码</label><input id="org-invite" required minLength={6} pattern="[A-Za-z0-9_-]{6,64}" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={form.inviteCode} maxLength={64} onChange={(event) => setForm({ ...form, inviteCode: event.target.value })} /><small>6–64 位字母、数字、短横线或下划线。新用户凭此码加入机构；已有账号无须填写。</small></div>
        </div>
        <div className="zx-org-invite-saved"><span>已保存邀请码：</span><code>{org.inviteCode || '尚未设置'}</code><button type="button" className="zx-btn zx-btn-ghost" disabled={Boolean(busy) || !org.inviteCode} onClick={copyInvite}>复制邀请码</button></div>
        <div className="zx-org-save-row"><button type="submit" className="zx-btn zx-btn-primary" disabled={Boolean(busy) || !form.name.trim() || !form.shortName.trim() || !form.inviteCode.trim()}>{busy === 'save' ? '保存中…' : '保存'}</button></div>
      </form>
      <section className="zx-card">
        <h2 className="zx-card-title">机构 Logo</h2>
        <div className="zx-org-logo"><div className="zx-org-logo-box">{org.logoUrl ? <img key={org.logoUrl} src={org.logoUrl} alt={org.shortName} /> : <span>还没有设置</span>}</div><div className="zx-org-logo-actions"><label className={`zx-btn zx-btn-primary${busy ? ' zx-org-upload-busy' : ''}`}>
          {busy === 'logo' ? '上传中…' : '上传 Logo'}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" className="zx-org-file" disabled={Boolean(busy)} onChange={(event) => { upload(event.target.files?.[0]); event.target.value = ''; }} />
        </label>{org.logoUrl && <button type="button" className="zx-btn zx-btn-danger" disabled={Boolean(busy)} onClick={removeLogo}>移除</button>}<small>支持 PNG / JPEG / WebP / GIF / SVG，不超过 4MB。学员登录后使用所属机构的 Logo。</small></div></div>
      </section>
    </>}
  </div>;
}
