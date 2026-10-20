import * as React from 'react';
import { adminApi } from './admin-api.js';

export default function AdminLogin({ onDone }) {
  const [account, setAccount] = React.useState('admin');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await adminApi.login(account.trim(), password);
      onDone();
    } catch (failure) {
      setError(failure.message || '登录失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="zx-admin-login">
      <section className="zx-admin-login-card">
        <div className="zx-admin-mark" aria-hidden="true">智</div>
        <h1>管理端</h1>
        <p>维护课程、课时与测验内容，保存后立即对学习者生效。</p>
        <form className="zx-admin-login-form" onSubmit={submit}>
          <div className="zx-field">
            <label htmlFor="zx-admin-account">管理员账号</label>
            <input
              id="zx-admin-account"
              value={account}
              autoComplete="username"
              onChange={(event) => setAccount(event.target.value)}
              required
            />
          </div>
          <div className="zx-field">
            <label htmlFor="zx-admin-password">密码</label>
            <input
              id="zx-admin-password"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          {error ? <div className="zx-notice zx-notice-error" role="alert">{error}</div> : null}
          <button type="submit" disabled={busy}>{busy ? '正在登录…' : '登录管理端'}</button>
        </form>
        <div className="zx-admin-login-foot">
          仅限管理员账号登录。学习账号请从<a href="/">学习端首页</a>进入。
          <br />
          忘记密码可执行 <code>scripts/create-admin.ps1</code> 重置。
        </div>
      </section>
    </div>
  );
}
