import React from "react";
import {
  authenticate,
  loginWithEmailCode,
  sendEmailCode,
  useLearning,
} from "./learning-api.jsx";

const STEPS = ["填写资料", "选择目标", "开始学习"];

export default function LoginPage({ onBack, onAuthenticated }) {
  const learning = useLearning();
  const [registering, setRegistering] = React.useState(false);
  const [tab, setTab] = React.useState("account");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [account, setAccount] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [verificationCode, setVerificationCode] = React.useState("");
  const [countdown, setCountdown] = React.useState(0);

  React.useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const enter = async (mode) => {
    setError("");
    if (!account.trim()) return setError("请输入工号或邮箱");
    if (!password.trim()) return setError("请输入密码");
    if (mode === "register" && password !== confirmPassword) return setError("两次输入的密码不一致");
    setBusy(true);
    try {
      const data = await authenticate(mode, {
        account: account.trim(),
        password,
        displayName: displayName.trim(),
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
    setError("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError("请填写有效的邮箱");
    if (!/^\d{6}$/.test(verificationCode.trim())) return setError("请输入 6 位邮箱验证码");
    setBusy(true);
    try {
      const data = await loginWithEmailCode(email.trim(), verificationCode.trim());
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
          <span className="zhixun-login-logo-mark">智</span>
          <span>智训云枢</span>
        </button>
        <div className="zhixun-login-editorial">
          <p className="zhixun-login-kicker">ZHIXUN LEARNING SPACE</p>
          <h1>从适合你的内容<br />开始学习</h1>
          <p>设定目标，查看学习建议，再按自己的进度完成课程和练习。</p>
          <div className="zhixun-login-steps">
            {STEPS.map((step, index) => (
              <React.Fragment key={step}>
                <span className={index === 0 ? "active" : ""}>{step}</span>
                {index < STEPS.length - 1 && <i />}
              </React.Fragment>
            ))}
          </div>
          <small>首次使用先填写基本信息；再次登录可以继续上次的学习。</small>
        </div>
        <p className="zhixun-login-quote">学习、练习与复习，都可以在这里继续。</p>
      </section>

      <main className="zhixun-login-main">
        <div className="zhixun-login-mobile-logo"><span>智</span>智训云枢</div>
        <div className="zhixun-login-card">
          <div className="zhixun-login-card-head">
            <div>
              <p>{registering ? "CREATE ACCOUNT" : "WELCOME BACK"}</p>
              <h2>{registering ? "创建学习账号" : "登录"}</h2>
            </div>
            {tab === "account" && (
              <button type="button" onClick={() => { setRegistering((value) => !value); setError(""); }}>
                {registering ? "返回登录" : "注册"}
              </button>
            )}
          </div>

          {!registering && (
            <div className="zhixun-login-tabs" role="tablist" aria-label="登录方式">
              <button type="button" className={tab === "account" ? "active" : ""} onClick={() => { setTab("account"); setError(""); }}>账号登录</button>
              <button type="button" className={tab === "email" ? "active" : ""} onClick={() => { setTab("email"); setError(""); }}>邮箱验证码</button>
            </div>
          )}

          <div className="zhixun-login-form">
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
            {error && <p className="zhixun-login-error" role="alert">{error}</p>}
            <button type="button" className="zhixun-login-primary" disabled={busy} onClick={() => tab === "email" ? enterWithCode() : enter(registering ? "register" : "login")}>
              {busy ? "正在处理…" : tab === "email" ? "验证并登录" : registering ? "注册并登录" : "登录"}
            </button>
            {!registering && (
              <button type="button" className="zhixun-login-guest" disabled={busy} onClick={enterGuest}>
                游客体验
              </button>
            )}
          </div>
          <p className="zhixun-login-note">体验版使用本地隔离的学习档案，登录后会自动恢复已有进度。</p>
        </div>
      </main>
    </div>
  );
}
