import React from "react";
import ForgotPasswordForm from './ForgotPasswordForm.jsx';
import SystemLogo from './SystemLogo.jsx';
import { adminApi } from "./admin/admin-api.js";
import {
  authenticate,
  loginWithEmailCode,
  sendEmailCode,
  useLearning,
} from "./learning-api.jsx";

export default function LoginPage({ onBack, onAuthenticated, initialAdmin = false, onAdminAuthenticated }) {
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
  const [adminFace, setAdminFace] = React.useState(() => (
    initialAdmin || new URLSearchParams(window.location.search).get("admin") === "1"
  ));
  const [adminAccount, setAdminAccount] = React.useState("admin");
  const [adminPassword, setAdminPassword] = React.useState("");
  const [adminBusy, setAdminBusy] = React.useState(false);
  const [adminError, setAdminError] = React.useState("");
  const studentFaceRef = React.useRef(null);
  const adminAccountRef = React.useRef(null);
  const focusAfterFlip = React.useRef(null);

  React.useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  React.useEffect(() => {
    const target = focusAfterFlip.current;
    if (!target) return;
    focusAfterFlip.current = null;
    const focusable = target.matches?.("input, button, a, select, textarea")
      ? target
      : target.querySelector?.("input:not([disabled])")
        || target.querySelector?.("select:not([disabled])")
        || target.querySelector?.("textarea:not([disabled])")
        || target.querySelector?.("button:not([disabled])")
        || target.querySelector?.("a[href]");
    focusable?.focus({ preventScroll: true });
  }, [adminFace]);

  const leaveAdminEntry = () => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("admin") !== "1") return;
    url.searchParams.delete("admin");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const showAdminFace = () => {
    setAdminError("");
    focusAfterFlip.current = adminAccountRef.current;
    setAdminFace(true);
  };

  const showStudentFace = () => {
    leaveAdminEntry();
    setAdminError("");
    focusAfterFlip.current = studentFaceRef.current;
    setAdminFace(false);
  };

  const goBack = () => {
    leaveAdminEntry();
    onBack?.();
  };

  const enter = async (mode) => {
    if (busy) return;
    setError("");
    if (!account.trim()) return setError("请输入邮箱");
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

  const enterAdmin = async (event) => {
    event.preventDefault();
    if (adminBusy) return;
    setAdminError("");
    if (!adminAccount.trim()) return setAdminError("请输入管理员账号");
    if (!adminPassword.trim()) return setAdminError("请输入管理员密码");
    setAdminBusy(true);
    try {
      await adminApi.login(adminAccount.trim(), adminPassword);
      if (onAdminAuthenticated) onAdminAuthenticated();
      else window.location.replace("/admin");
    } catch (reason) {
      setAdminError(reason.message || "管理员登录失败，请稍后重试");
    } finally {
      setAdminBusy(false);
    }
  };

  return (
    <div className="zhixun-login">
      <section className="zhixun-login-brand">
        <div className="zhixun-login-orbit zhixun-login-orbit-a" />
        <div className="zhixun-login-orbit zhixun-login-orbit-b" />
        <button type="button" className="zhixun-login-logo" onClick={goBack} aria-label="回到海报页">
          <SystemLogo size={38} />
          <span>智训云枢</span>
        </button>
        <div className="zhixun-login-editorial">
          <p className="zhixun-login-kicker">ZHIXUN · INTELLIGENT LEARNING</p>
          <h1>智启<span>未来</span><br />训见<span>成长</span></h1>
          <p>智训云枢致力于为每一位学习者，提供专业、高效、个性化的学习体验。</p>
          <div className="zhixun-login-figure zhixun-login-mascots" aria-hidden="true">
            <div className="zhixun-login-mascot-canvas">
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
        </div>
      </section>

      <main className="zhixun-login-main">
        <div className="zhixun-login-mobile-logo">
          <SystemLogo size={30} />
          <span>智训云枢</span>
        </div>
        <div className="zhixun-login-panel">
          <button type="button" className="zhixun-login-back" onClick={goBack}>
            <span aria-hidden="true">←</span>
            回到海报页
          </button>
          <div className={`zhixun-login-flip${adminFace ? " is-flipped" : ""}`}>
            <section
              ref={studentFaceRef}
              id="zhixun-login-learner-face"
              className="zhixun-login-card zhixun-login-card-front"
              aria-hidden={adminFace}
              inert={adminFace}
            >
          <div className="zhixun-login-card-head">
            <div>
              <p>{recovering ? 'RESET PASSWORD' : registering ? "CREATE ACCOUNT" : "WELCOME BACK"}</p>
              <h2>{recovering ? '忘记密码' : registering ? "创建学习账号" : "邮箱登录"}</h2>
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
              <button type="button" className={tab === "account" ? "active" : ""} onClick={() => { setTab("account"); setError(""); }}>邮箱登录</button>
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
                  <span>邮箱</span>
                  <input
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={account}
                    onChange={(event) => setAccount(event.target.value)}
                    placeholder="user@example.com"
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
              <div className="zhixun-login-card-brand-row">
                <p className="zhixun-login-admin">
                  <span>机构管理员？</span>
                  <button
                    type="button"
                    onClick={showAdminFace}
                    aria-controls="zhixun-login-admin-face"
                    aria-expanded={adminFace}
                  >
                    管理员登录
                  </button>
                </p>
                <span className="zhixun-login-powered">Powered by Cangjie</span>
              </div>
            </section>

            <section
              id="zhixun-login-admin-face"
              className="zhixun-login-card zhixun-login-card-back"
              aria-hidden={!adminFace}
              inert={!adminFace}
            >
              <div className="zhixun-login-card-head">
                <div>
                  <p>ADMIN ACCESS</p>
                  <h2>管理员登录</h2>
                </div>
                <button
                  type="button"
                  onClick={showStudentFace}
                  aria-controls="zhixun-login-learner-face"
                  aria-expanded={adminFace}
                >
                  返回学员登录
                </button>
              </div>
              <p className="zhixun-login-admin-copy">维护课程、知识库与机构设置。</p>
              <form className="zhixun-login-form zhixun-login-admin-form" onSubmit={enterAdmin}>
                <label>
                  <span>管理员账号</span>
                  <input
                    ref={adminAccountRef}
                    value={adminAccount}
                    autoComplete="username"
                    onChange={(event) => setAdminAccount(event.target.value)}
                    placeholder="请输入管理员账号"
                    required
                  />
                </label>
                <label>
                  <span>密码</span>
                  <input
                    type="password"
                    value={adminPassword}
                    autoComplete="current-password"
                    onChange={(event) => setAdminPassword(event.target.value)}
                    placeholder="请输入管理员密码"
                    required
                  />
                </label>
                {adminError && <p className="zhixun-login-error" role="alert">{adminError}</p>}
                <button type="submit" className="zhixun-login-primary" disabled={adminBusy}>
                  {adminBusy ? "正在登录…" : "登录管理端"}
                </button>
              </form>
              <p className="zhixun-login-admin-foot">
                仅限管理员账号登录。忘记密码可执行 <code>scripts/create-admin.ps1</code> 重置。
              </p>
              <div className="zhixun-login-card-brand-row">
                <span className="zhixun-login-admin-brand">智训云枢 · 管理端</span>
                <span className="zhixun-login-powered">Powered by Cangjie</span>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
