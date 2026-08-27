/**
 * Login `/login` — 登录与注册共用一张翻转卡片
 * - 正面：工号/邮箱 + 密码、邮箱验证码
 * - 背面：注册，自动生成 9 位工号
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  Building2,
  Loader2,
  Mail,
  KeyRound,
  MessageSquareText,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import type { LoginMethod } from '@/context/AuthContext';
import { BlossomBranch, Succulent } from '@/components/heal/Flora';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const LOOP_STEPS = ['画像建档', '协同调度', '个性化生成', '交互反馈', '动态更新'];

type Tab = Extract<LoginMethod, 'sso' | 'sms'>;

const TABS: { key: Tab; label: string; icon: typeof Building2 }[] = [
  { key: 'sso', label: '工号/邮箱', icon: Building2 },
  { key: 'sms', label: '邮箱登录', icon: Mail },
];

export default function Login() {
  const navigate = useNavigate();
  const { loginRemote } = useAuth();

  const [flipped, setFlipped] = useState(false);
  const [tab, setTab] = useState<Tab>('sso');
  const [busy, setBusy] = useState(false);
  const [adminMode, setAdminMode] = useState(false);

  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [codeSent, setCodeSent] = useState(false);

  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regNickname, setRegNickname] = useState('');
  const [regCode, setRegCode] = useState('');
  const [regInvitationCode, setRegInvitationCode] = useState('');
  const [regCountdown, setRegCountdown] = useState(0);

  const [forgotOpen, setForgotOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [resetCountdown, setResetCountdown] = useState(0);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);
  useEffect(() => {
    if (regCountdown <= 0) return;
    const t = setTimeout(() => setRegCountdown((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [regCountdown]);
  useEffect(() => {
    if (resetCountdown <= 0) return;
    const t = setTimeout(() => setResetCountdown((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [resetCountdown]);

  const doLogin = async (method: LoginMethod, account: string, label: string, learnerId?: string, secret?: string) => {
    setBusy(true);
    const ok = await loginRemote(method, account, label, learnerId, secret);
    setBusy(false);
    if (!ok) {
      toast.error('登录失败', { description: '账号或验证码不正确，请检查后重试' });
      return;
    }
    toast.success(`${label}，登录成功`);
    navigate(adminMode ? '/admin' : '/welcome');
  };

  const submitSso = () => {
    if (!account.trim() || !password.trim()) {
      toast('请输入工号/邮箱和密码');
      return;
    }
    doLogin(
      adminMode ? 'admin' : 'sso',
      adminMode ? `admin:${account.trim()}` : `sso:${account.trim()}`,
      adminMode ? `管理员 ${account.trim()}` : account.includes('@') ? account.trim() : `工号 ${account.trim()}`,
      undefined,
      password.trim(),
    );
  };

  const sendCode = async () => {
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      toast('请输入正确的邮箱地址');
      return;
    }
    setBusy(true);
    try {
      await api.sendCode(value, 'LOGIN');
      setCodeSent(true);
      setCountdown(60);
      toast.success('验证码已发送', { description: `已发送至 ${value}` });
    } catch (err) {
      toast.error('验证码发送失败', { description: err instanceof Error ? err.message : '请稍后重试' });
    } finally {
      setBusy(false);
    }
  };

  const submitEmailCode = () => {
    if (!codeSent) { toast('先获取验证码'); return; }
    if (!/^\d{6}$/.test(code.trim())) { toast('请输入 6 位验证码'); return; }
    doLogin('sms', `email:${email.trim()}`, email.trim(), undefined, code.trim());
  };

  const sendRegCode = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(regEmail.trim())) {
      toast('请输入正确的邮箱地址');
      return;
    }
    setBusy(true);
    try {
      await api.sendCode(regEmail.trim(), 'REGISTER');
      setRegCountdown(60);
      toast.success('验证码已发送', { description: `已发送至 ${regEmail.trim()}` });
    } catch (err) {
      toast.error('验证码发送失败', { description: err instanceof Error ? err.message : '请稍后重试' });
    } finally {
      setBusy(false);
    }
  };

  const submitRegister = async () => {
    if (!regEmail.trim() || !regPassword || !regCode.trim() || !regInvitationCode.trim()) {
      toast('请填写完整注册信息');
      return;
    }
    setBusy(true);
    try {
      const result = await api.registerEnterprise({
        email: regEmail.trim(),
        password: regPassword,
        nickname: regNickname.trim() || undefined,
        verificationCode: regCode.trim(),
        invitationCode: regInvitationCode.trim(),
      });
      toast.success('注册成功', {
        description: `机构：${result.organizationName} · 工号：${result.employeeNo}`,
      });
      const ok = await loginRemote('sso', `sso:${result.employeeNo}`, regEmail.trim(), undefined, regPassword);
      if (!ok) {
        toast.error('注册成功，但自动登录失败', { description: '请使用新工号或邮箱重新登录' });
        return;
      }
      navigate('/welcome');
    } catch (err) {
      toast.error('注册失败', { description: err instanceof Error ? err.message : '请稍后重试' });
    } finally {
      setBusy(false);
    }
  };


  const sendResetCode = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resetEmail.trim())) {
      toast('请输入正确的邮箱地址');
      return;
    }
    setResetting(true);
    try {
      await api.sendCode(resetEmail.trim(), 'PASSWORD_RESET');
      setResetCountdown(60);
      toast.success('验证码已发送', { description: `已发送至 ${resetEmail.trim()}` });
    } catch (err) {
      toast.error('验证码发送失败', { description: err instanceof Error ? err.message : '请稍后重试' });
    } finally {
      setResetting(false);
    }
  };

  const submitReset = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resetEmail.trim())) {
      toast('请输入正确的邮箱地址');
      return;
    }
    if (!/^\d{6}$/.test(resetCode.trim())) {
      toast('请输入 6 位验证码');
      return;
    }
    if (!/^(?=.*[A-Za-z])(?=.*\d).{8,64}$/.test(resetPassword)) {
      toast('新密码至少 8 位，且同时包含字母和数字');
      return;
    }
    setResetting(true);
    try {
      await api.resetPassword({
        email: resetEmail.trim(),
        verificationCode: resetCode.trim(),
        newPassword: resetPassword,
      });
      toast.success('密码已重置', { description: '请使用新密码重新登录' });
      setForgotOpen(false);
      setResetEmail('');
      setResetCode('');
      setResetPassword('');
    } catch (err) {
      toast.error('密码重置失败', { description: err instanceof Error ? err.message : '请稍后重试' });
    } finally {
      setResetting(false);
    }
  };

  const inputClass = 'w-full rounded-[10px] border border-hairline bg-paper px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors focus:border-brand/50';
  const loginGuest = () => {
    doLogin("guest", "guest", "游客");
  };
  const primaryClass = 'lf-btn-primary w-full justify-center !py-2.5';

  return (
    <div className="lf-learner grid min-h-[100dvh] lg:grid-cols-[1.05fr_1fr]">
      <div className="relative hidden flex-col justify-between overflow-hidden border-r border-hairline bg-card-warm/60 p-12 lg:flex">
        <BlossomBranch className="pointer-events-none absolute right-10 top-8 h-[88px] w-[132px] opacity-90" />
        <div className="flex items-center gap-3">
          <img src="/logo.svg" alt="智训云枢" className="h-9 w-9" />
          <span className="font-serif text-[20px] font-bold text-ink">智训云枢</span>
          <span className="font-mono text-[10.5px] tracking-wider text-ink-muted">LearnForge</span>
        </div>
        <div className="max-w-[460px]">
          <motion.h1
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            className="font-serif text-[34px] font-bold leading-[46px] text-ink"
          >
            会按你的水平
            <br />
            「现做」教材的学习系统
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12, duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            className="mt-4 text-[14.5px] leading-[25px] text-ink-muted"
          >
            同一个知识点，给你的讲法和给别人的不一样——而且每句话都有国标出处。
            面向工业机器人运维，从建一份属于你的学情画像开始。
          </motion.p>
          <div className="mt-8 flex flex-wrap items-center gap-y-2">
            {LOOP_STEPS.map((s, i) => (
              <span key={s} className="flex items-center">
                <span className={cn('rounded-[9px] border px-2.5 py-1 text-[12px] font-medium', i === 0 ? 'border-brand/40 bg-brand-tint text-brand' : 'border-hairline bg-paper text-ink-2')}>
                  {s}
                </span>
                {i < LOOP_STEPS.length - 1 && <span className="mx-1.5 h-px w-4 bg-hairline" />}
              </span>
            ))}
          </div>
          <p className="mt-2.5 text-[11.5px] text-ink-muted/80">登录即进入第一步：画像建档 —— 之后的一切都由它驱动。</p>
        </div>
        <div className="font-mono text-[10.5px] tracking-wide text-ink-muted/70">
          领域知识个性化生成与多智能体协同决策系统
        </div>
      </div>

      <div className="relative flex items-center justify-center px-5 py-10">
        <Succulent className="pointer-events-none absolute right-8 top-6 hidden h-[56px] w-[48px] md:block" />
        <div className="mb-6 flex items-center gap-2.5 lg:hidden">
          <img src="/logo.svg" alt="智训云枢" className="h-8 w-8" />
          <span className="font-serif text-[18px] font-bold text-ink">智训云枢</span>
        </div>

        <div className="relative w-full max-w-[400px]" style={{ minHeight: 600, height: 600, perspective: '1200px' }}>
          <div
            className="relative h-full w-full transition-transform duration-700 [transform-style:preserve-3d]"
            style={{ transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)' }}
          >
            {/* 登录面 */}
            <div className="absolute inset-0" style={{ backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' }}>
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                className="lf-card flex h-full flex-col p-6"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {adminMode && <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-tint text-brand"><ShieldCheck size={15} /></span>}
                    <h2 className="font-serif text-[20px] font-semibold text-ink">{adminMode ? '管理员端登录' : '登录'}</h2>
                  </div>
                  {!adminMode && <button type="button" onClick={() => setFlipped(true)} className="text-[13px] font-medium text-brand hover:underline">注册</button>}
                </div>
                {!adminMode && <div className="mt-4 flex gap-0.5 rounded-[11px] border border-hairline bg-paper p-0.5">
                  {TABS.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setTab(t.key)}
                      className={cn('flex flex-1 items-center justify-center gap-1.5 rounded-[9px] px-2 py-2 text-[12.5px] font-medium transition-all', tab === t.key ? 'bg-brand text-paper shadow-warm' : 'text-ink-muted hover:text-ink')}
                    >
                      <t.icon size={14} />
                      {t.label}
                    </button>
                  ))}
                </div>}

                {(adminMode || tab === 'sso') && (
                  <div className="lf-anim-in-up mt-5 space-y-3">
                    <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder={adminMode ? '管理员工号/邮箱' : '工号/邮箱（如 LF-0917 或 user@example.com）'} className={inputClass} />
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submitSso()} placeholder="密码" className={inputClass} />
                    <div className="flex items-center justify-between gap-3">
                      <button type="button" onClick={() => { setAdminMode((value) => !value); setTab('sso'); }} className="flex items-center gap-1 text-[12px] font-medium text-brand transition-colors hover:underline">
                        <ShieldCheck size={12} />
                        {adminMode ? '返回学习者登录' : '管理员端登录'}
                      </button>
                      <button type="button" onClick={() => setForgotOpen(true)} className="flex items-center gap-1 text-[12px] font-medium text-brand transition-colors hover:underline">
                        <KeyRound size={12} />
                        忘记密码？
                      </button>
                    </div>
                    <button type="button" disabled={busy} onClick={submitSso} className={primaryClass}>
                      {busy ? <Loader2 size={15} className="animate-spin" /> : <Building2 size={15} />}
                      {adminMode ? '进入管理员端' : '登录'}
                    </button>
                  </div>
                )}

                {tab === 'sms' && (
                  <div className="lf-anim-in-up mt-5 space-y-3">
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="邮箱" className={inputClass} />
                    <div className="flex gap-2">
                      <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={(e) => e.key === 'Enter' && submitEmailCode()} placeholder="验证码" inputMode="numeric" className="min-w-0 flex-1 rounded-[10px] border border-hairline bg-paper px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors focus:border-brand/50" />
                      <button type="button" disabled={countdown > 0 || busy} onClick={sendCode} className={cn('shrink-0 rounded-[10px] border px-3 py-2.5 text-[12.5px] font-medium transition-all', countdown > 0 ? 'border-hairline bg-paper-deep text-ink-muted/60' : 'border-brand/40 bg-brand-tint text-brand hover:border-brand/60')}>
                        {countdown > 0 ? `${countdown}s 后重发` : '获取验证码'}
                      </button>
                    </div>
                    <button type="button" disabled={busy} onClick={submitEmailCode} className={primaryClass}>
                      {busy ? <Loader2 size={15} className="animate-spin" /> : <MessageSquareText size={15} />}
                      验证并登录
                    </button>
                  </div>
                )}

                <div className="mt-auto pt-5">
                  {!adminMode && <button type="button" onClick={loginGuest} className="flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-hairline bg-paper py-2.5 text-[13px] font-medium text-ink-2 transition-all hover:border-brand/40 hover:text-ink">
                    <UserRound size={14} />
                    游客体验
                  </button>}
                </div>

              </motion.div>
            </div>

            {/* 注册面 */}
            <div className="absolute inset-0" style={{ transform: 'rotateY(180deg)', backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' }}>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.5, delay: 0.2 }}
                className="lf-card flex h-full flex-col p-6"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="font-serif text-[20px] font-semibold text-ink">注册</h2>
                    <p className="mt-1 text-[12px] text-ink-muted">注册后自动生成 9 位工号</p>
                  </div>
                  <button type="button" onClick={() => setFlipped(false)} className="text-[13px] font-medium text-brand hover:underline">返回登录</button>
                </div>

                <div className="mt-4 space-y-3 overflow-y-auto pr-1">
                  <input type="email" value={regEmail} onChange={(e) => setRegEmail(e.target.value)} placeholder="邮箱" className={inputClass} />
                  <input type="password" value={regPassword} onChange={(e) => setRegPassword(e.target.value)} placeholder="密码（至少 8 位，含字母和数字）" className={inputClass} />
                  <input value={regNickname} onChange={(e) => setRegNickname(e.target.value)} placeholder="昵称（选填）" className={inputClass} />
                  <input value={regInvitationCode} onChange={(e) => setRegInvitationCode(e.target.value.toUpperCase())} placeholder="机构邀请码" className={inputClass} />
                  <div className="flex gap-2">
                    <input value={regCode} onChange={(e) => setRegCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="验证码" inputMode="numeric" className="min-w-0 flex-1 rounded-[10px] border border-hairline bg-paper px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors focus:border-brand/50" />
                    <button type="button" disabled={busy || regCountdown > 0} onClick={sendRegCode} className={cn('shrink-0 rounded-[10px] border px-3 py-2.5 text-[12.5px] font-medium transition-all', regCountdown > 0 ? 'border-hairline bg-paper-deep text-ink-muted/60' : 'border-brand/40 bg-brand-tint text-brand hover:border-brand/60')}>
                      {regCountdown > 0 ? `${regCountdown}s 后重发` : '获取验证码'}
                    </button>
                  </div>
                  <button type="button" disabled={busy} onClick={submitRegister} className={primaryClass}>
                    {busy ? <Loader2 size={15} className="animate-spin" /> : <Building2 size={15} />}
                    注册并登录
                  </button>
                </div>
              </motion.div>
            </div>
          </div>
        {forgotOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 px-4" role="dialog" aria-modal="true" onClick={() => setForgotOpen(false)}>
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="lf-card w-full max-w-[420px] p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-serif text-[19px] font-semibold text-ink">重置密码</h2>
                  <p className="mt-1 text-[12px] text-ink-muted">通过邮箱验证码设置新密码</p>
                </div>
                <button type="button" onClick={() => setForgotOpen(false)} className="text-[13px] font-medium text-ink-muted transition-colors hover:text-ink">关闭</button>
              </div>
              <div className="mt-4 space-y-3">
                <input type="email" value={resetEmail} onChange={(e) => setResetEmail(e.target.value)} placeholder="邮箱" className={inputClass} />
                <div className="flex gap-2">
                  <input value={resetCode} onChange={(e) => setResetCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="验证码" inputMode="numeric" className={cn(inputClass, 'min-w-0 flex-1')} />
                  <button type="button" disabled={resetting || resetCountdown > 0} onClick={sendResetCode} className={cn('shrink-0 rounded-[10px] border px-3 py-2.5 text-[12.5px] font-medium transition-all', resetCountdown > 0 ? 'border-hairline bg-paper-deep text-ink-muted/60' : 'border-brand/40 bg-brand-tint text-brand hover:border-brand/60')}>
                    {resetCountdown > 0 ? `${resetCountdown}s 后重发` : '获取验证码'}
                  </button>
                </div>
                <input type="password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} placeholder="新密码（至少 8 位，含字母和数字）" className={inputClass} />
                <button type="button" disabled={resetting} onClick={submitReset} className={primaryClass}>
                  {resetting ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
                  确认重置
                </button>
              </div>
            </motion.div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
