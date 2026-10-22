import React from 'react';
import { resetPassword, sendEmailCode } from './learning-api.jsx';

export default function ForgotPasswordForm({ initialEmail = '', onDone, onCancel }) {
  const [email, setEmail] = React.useState(initialEmail);
  const [code, setCode] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [countdown, setCountdown] = React.useState(0);

  React.useEffect(() => {
    if (!countdown) return undefined;
    const timer = window.setTimeout(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const validEmail = () => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  async function sendCode() {
    if (busy || countdown) return;
    setError('');
    setMessage('');
    if (!validEmail()) { setError('请填写注册时使用的邮箱'); return; }
    setBusy('send');
    try {
      const result = await sendEmailCode(email.trim(), 'RESET_PASSWORD');
      setCountdown(result.retryAfterSeconds || 60);
      setMessage(result.message || '验证码已发送，请查收邮件。');
    } catch (failure) { setError(failure.message || '验证码发送失败，请稍后重试'); }
    finally { setBusy(''); }
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (!validEmail()) { setError('请填写注册时使用的邮箱'); return; }
    if (!/^\d{6}$/.test(code)) { setError('请输入 6 位邮箱验证码'); return; }
    if (password.length < 8) { setError('新密码至少需要 8 位'); return; }
    if (password !== confirm) { setError('两次输入的密码不一致'); return; }
    setBusy('reset');
    try {
      await resetPassword(email.trim(), code, password);
      setPassword('');
      setConfirm('');
      setCode('');
      onDone(email.trim());
    } catch (failure) { setError(failure.message || '重置失败，请稍后重试'); }
    finally { setBusy(''); }
  }

  return <form className="zhixun-login-form" onSubmit={submit}>
    <p className="zhixun-login-reset-description">使用注册邮箱验证后设置新密码。工号账号未绑定邮箱，请联系机构管理员。</p>
    <label><span>注册邮箱</span><input type="email" autoComplete="email" value={email} onChange={(event) => { setEmail(event.target.value); setCode(''); setMessage(''); }} placeholder="user@example.com" required disabled={Boolean(busy)} /></label>
    <label><span>邮箱验证码</span><div className="zhixun-login-code-row">
      <input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} autoComplete="one-time-code" inputMode="numeric" placeholder="6 位验证码" required disabled={Boolean(busy)} />
      <button type="button" disabled={Boolean(busy) || countdown > 0} onClick={sendCode}>{busy === 'send' ? '发送中…' : countdown > 0 ? `${countdown}s 后重发` : '获取验证码'}</button>
    </div></label>
    <label><span>新密码</span><input type="password" autoComplete="new-password" minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 位" required disabled={Boolean(busy)} /></label>
    <label><span>确认新密码</span><input type="password" autoComplete="new-password" minLength={8} maxLength={128} value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder="再次输入新密码" required disabled={Boolean(busy)} /></label>
    {error ? <p className="zhixun-login-error" role="alert">{error}</p> : null}
    {message ? <p className="zhixun-login-success" role="status">{message}</p> : null}
    <button type="submit" className="zhixun-login-primary" disabled={Boolean(busy)}>{busy === 'reset' ? '正在重置…' : '重置密码'}</button>
    <button type="button" className="zhixun-login-guest" disabled={Boolean(busy)} onClick={onCancel}>返回登录</button>
  </form>;
}
