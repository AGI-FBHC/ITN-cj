import React from "react";
import ForgotPasswordForm from './ForgotPasswordForm.jsx';
import SystemLogo from './SystemLogo.jsx';
import {
  authenticate,
  loginWithEmailCode,
  sendEmailCode,
  useLearning,
} from "./learning-api.jsx";

export default function LoginPage({ onBack, onAuthenticated }) {
  const learning = useLearning();
  const [registering, setRegistering] = React.useState(false);
  const [recovering, setRecovering] = React.useState(false);
  const [success, setSuccess] = React.useState('');
  const [tab, setTab] = React.useState("account");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [account, setAccount] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [inviteCode, setInviteCode] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [verificationCode, setVerificationCode] = React.useState("");
  const [countdown, setCountdown] = React.useState(0);

  React.useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const enter = async (mode) => {
    if (busy) return;
    setError("");
    if (!account.trim()) return setError("请输入工号或邮箱");
    if (!password.trim()) return setError("请输入密码");
    if (mode === "register" && password !== confirmPassword) return setError("两次输入的密码不一致");
    if (mode === "register" && !inviteCode.trim()) return setError("请输入机构提供的邀请码");
    if (mode === "register" && !/^[a-z0-9_-]{6,64}$/i.test(inviteCode.trim())) return setError("邀请码应为 6–64 位字母、数字、短横线或下划线");
    setBusy(true);
    try {
      const data = await authenticate(mode, {
        account: account.trim(),
        password,
        displayName: displayName.trim(),
        ...(mode === "register" ? { inviteCode: inviteCode.trim() } : {}),
      });
      onAuthenticated?.(data.profile, data.profile?.name || displayName.trim() || account.trim());
    } catch (reason) {
      setError(reason.message || "登录失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const enterGuest = () => {
    const profile = learning.data?.profile;
    onAuthenticated?.(profile, profile?.name || "游客");
  };

  const requestCode = async () => {
    if (busy) return;
    setError("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("请填写有效的邮箱");
      return;
    }
    setBusy(true);
    try {
      await sendEmailCode(email.trim());
      setCountdown(60);
    } catch (reason) {
      setError(reason.message || "验证码发送失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const enterWithCode = async () => {
    if (busy) return;
    setError("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError("请填写有效的邮箱");
    if (!/^\d{6}$/.test(verificationCode.trim())) return setError("请输入 6 位邮箱验证码");
    setBusy(true);
    try {
      const data = await loginWithEmailCode(email.trim(), verificationCode.trim(), inviteCode);
      onAuthenticated?.(data.profile, data.profile?.name || email.trim().split("@")[0]);
    } catch (reason) {
      setError(reason.message || "验证码登录失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="zhixun-login">
      <section className="zhixun-login-brand">
        <div className="zhixun-login-orbit zhixun-login-orbit-a" />
        <div className="zhixun-login-orbit zhixun-login-orbit-b" />
        <button type="button" className="zhixun-login-logo" onClick={onBack} aria-label="返回首页">
          <SystemLogo size={38} />
          <span>智训云枢</span>
        </button>
        <div className="zhixun-login-editorial">
          <p className="zhixun-login-kicker">ZHIXUN · INTELLIGENT LEARNING</p>
          <h1>智启<span>未来</span><br />训见<span>成长</span></h1>
          <p>智训云枢致力于为每一位计算机学习者，提供专业、高效、个性化的学习体验。</p>
          <div className="zhixun-login-figure zhixun-login-mascots" aria-hidden="true">
            <span className="zhixun-login-mascot-glow glow-a" />
            <span className="zhixun-login-mascot-glow glow-b" />
            <span className="zhixun-login-mascot-ring" />
            <img className="zhixun-login-mascot mascot-strawberry" src="/login-characters/strawberry.webp" alt="" />
            <img className="zhixun-login-mascot mascot-pear" src="/login-characters/pear.webp" alt="" />
            <img className="zhixun-login-mascot mascot-donut" src="/login-characters/donut-pink.webp" alt="" />
            <img className="zhixun-login-mascot mascot-cherries" src="/login-characters/cherries.webp" alt="" />
            <img className="zhixun-login-mascot mascot-apple" src="/login-characters/apple.webp" alt="" />
            <img className="zhixun-login-mascot mascot-chick" src="/login-characters/chick.webp" alt="" />
            <img className="zhixun-login-mascot mascot-milk" src="/login-characters/milk.webp" alt="" />
            <img className="zhixun-login-mascot mascot-orange" src="/login-characters/orange.webp" alt="" />
            <img className="zhixun-login-mascot mascot-peas" src="/login-characters/peas.webp" alt="" />
            <span className="zhixun-login-mascot-note note-a">今天也要元气满满</span>
            <span className="zhixun-login-mascot-note note-b">开始你的学习旅程</span>
          </div>
        </div>
        <div className="zhixun-login-footer">
          <span className="zhixun-login-powered">Powered by Cangjie</span>
        </div>
      </section>

      <main className="zhixun-login-main">
        <div className="zhixun-login-mobile-logo">
          <SystemLogo size={30} />
          <span>智训云枢</span>
        </div>
        <div className="zhixun-login-card">
          <div className="zhixun-login-card-head">
            <div>
              <p>{recovering ? 'RESET PASSWORD' : registering ? "CREATE ACCOUNT" : "WELCOME BACK"}</p>
              <h2>{recovering ? '忘记密码' : registering ? "创建学习账号" : "登录"}</h2>
            </div>
            {!recovering && tab === "account" && (
              <button type="button" onClick={() => {
                setRegistering((value) => !value);
                setPassword("");
                setConfirmPassword("");
                setError("");
                setSuccess('');
              }}>
                {registering ? "返回登录" : "注册"}
              </button>
            )}
          </div>

          {!registering && !recovering && (
            <div className="zhixun-login-tabs" role="tablist" aria-label="登录方式">
              <button type="button" className={tab === "account" ? "active" : ""} onClick={() => { setTab("account"); setError(""); }}>账号登录</button>
              <button type="button" className={tab === "email" ? "active" : ""} onClick={() => { setTab("email"); setError(""); }}>邮箱验证码</button>
            </div>
          )}

          {recovering ? <ForgotPasswordForm
            initialEmail={/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.trim()) ? account.trim() : email}
            onCancel={() => setRecovering(false)}
            onDone={(resetEmail) => {
              setRecovering(false);
              setRegistering(false);
              setTab('account');
              setAccount(resetEmail);
              setPassword('');
              setConfirmPassword('');
              setError('');
              setSuccess('密码已重置，请使用新密码登录。');
            }}
          /> : <div className="zhixun-login-form">
            {tab === "email" ? (
              <>
                <label>
                  <span>邮箱</span>
                  <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="user@example.com" autoComplete="email" />
                </label>
                <label>
                  <span>验证码</span>
                  <div className="zhixun-login-code-row">
                    <input
                      value={verificationCode}
                      onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                      onKeyDown={(event) => event.key === "Enter" && enterWithCode()}
                      placeholder="6 位验证码"
                      inputMode="numeric"
                    />
                    <button type="button" disabled={busy || countdown > 0} onClick={requestCode}>
                      {countdown > 0 ? `${countdown}s 后重发` : "获取验证码"}
                    </button>
                  </div>
                </label>
              </>
            ) : (
              <>
                <label>
                  <span>工号 / 邮箱</span>
                  <input
                    autoComplete="username"
                    value={account}
                    onChange={(event) => setAccount(event.target.value)}
                    placeholder="如 LF-0917 或 user@example.com"
                  />
                </label>
                {registering && (
                  <label>
                    <span>昵称</span>
                    <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="我们该怎么称呼你" />
                  </label>
                )}
                <label>
                  <span>密码</span>
                  <input
                    type="password"
                    autoComplete={registering ? "new-password" : "current-password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && enter(registering ? "register" : "login")}
                    placeholder={registering ? "至少 8 位" : "请输入密码"}
                  />
                </label>
                {registering && (
                  <label>
                    <span>确认密码</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      onKeyDown={(event) => event.key === "Enter" && enter("register")}
                      placeholder="再次输入密码"
                    />
                  </label>
                )}
              </>
            )}
            {(registering || tab === "email") && <label>
              <span>机构邀请码{tab === "email" ? '（首次使用必填）' : ''}</span>
              <input
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && (tab === "email" ? enterWithCode() : enter("register"))}
                placeholder="请输入机构提供的邀请码"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={64}
                aria-describedby="login-invite-hint"
                required={registering}
              />
              <small id="login-invite-hint" className="zhixun-login-field-hint">{tab === "email" ? '首次使用此邮箱时填写；已有账号可直接登录。' : '注册后加入对应机构，邀请码请向机构管理员获取。'}</small>
            </label>}
            {error && <p className="zhixun-login-error" role="alert">{error}</p>}
            {success && <p className="zhixun-login-success" role="status">{success}</p>}
            {!registering && <button type="button" className="zhixun-login-forgot" disabled={busy} onClick={() => { setRecovering(true); setError(''); setSuccess(''); }}>忘记密码？</button>}
            <button type="button" className="zhixun-login-primary" disabled={busy} onClick={() => tab === "email" ? enterWithCode() : enter(registering ? "register" : "login")}>
              {busy ? "正在处理…" : tab === "email" ? "验证并登录" : registering ? "注册并登录" : "登录"}
            </button>
            {!registering && (
              <button type="button" className="zhixun-login-guest" disabled={busy} onClick={enterGuest}>
                游客体验
              </button>
            )}
          </div>}
          <p className="zhixun-login-admin"><a href="/admin/login">管理员登录</a></p>
        </div>
      </main>
    </div>
  );
}
