/**
 * Login `/login` — 登录页
 * - 工号/邮箱 + 密码
 * - 邮箱验证码
 * - 微信扫码（演示通道）
 * - 注册入口
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  BadgeCheck,
  Building2,
  Loader2,
  Mail,
  MessageSquareText,
  QrCode,
  ScanLine,
  Sparkles,
  UserRound,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import type { LoginMethod } from '@/context/AuthContext';
import { useProfile } from '@/context/ProfileContext';
import { startDemoTour } from '@/components/tour/DemoTour';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { BlossomBranch, Succulent } from '@/components/heal/Flora';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const LOOP_STEPS = ['画像建档', '协同调度', '个性化生成', '交互反馈', '动态更新'];

type Tab = Extract<LoginMethod, 'sso' | 'sms' | 'wechat'>;

const TABS: { key: Tab; label: string; icon: typeof Building2 }[] = [
  { key: 'sso', label: '工号/邮箱', icon: Building2 },
  { key: 'sms', label: '邮箱验证码', icon: Mail },
  { key: 'wechat', label: '微信扫码', icon: QrCode },
];

function FakeQr({ scanned }: { scanned: boolean }) {
  const cells: boolean[] = [];
  let seed = 7;
  for (let i = 0; i < 144; i++) {
    seed = (seed * 137 + 11) % 199;
    cells.push(seed % 3 !== 0);
  }
  return (
    <div className={cn('relative grid h-40 w-40 grid-cols-12 gap-[2px] rounded-[12px] border border-hairline bg-paper p-2.5 transition-opacity', scanned && 'opacity-30')}>
      {cells.map((on, i) => (
        <span key={i} className={cn('rounded-[1px]', on ? 'bg-ink/85' : 'bg-transparent')} />
      ))}
      {scanned && (
        <span className="absolute inset-0 flex items-center justify-center">
          <BadgeCheck size={40} className="text-brand" />
        </span>
      )}
    </div>
  );
}

export default function Login() {
  const navigate = useNavigate();
  const { login, loginRemote, knownOf } = useAuth();
  const { learners, setCurrentLearnerId, setViewMode } = useProfile();
  const presets = learners.filter((l) => !l.custom);

  const [tab, setTab] = useState<Tab>('sso');
  const [busy, setBusy] = useState(false);

  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [codeSent, setCodeSent] = useState(false);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const [wxScanned, setWxScanned] = useState(false);
  const wxTimer = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    wxTimer.current.forEach(clearTimeout);
    wxTimer.current = [];
    setWxScanned(false);
    if (tab !== 'wechat') return;
    wxTimer.current.push(
      setTimeout(() => setWxScanned(true), 2200),
      setTimeout(() => doLogin('wechat', 'wx:demo-user', '微信用户'), 3400),
    );
    return () => wxTimer.current.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const doLogin = async (method: LoginMethod, account: string, label: string, learnerId?: string, secret?: string) => {
    setBusy(true);
    const ok = await loginRemote(method, account, label, learnerId, secret);
    if (!ok) login(method, account, label, learnerId);
    const resolved = knownOf(account) ?? (learnerId ? { learnerId, lastAt: Date.now() } : null);
    if (resolved) setCurrentLearnerId(resolved.learnerId);
    setBusy(false);
    toast.success(`${label}，登录成功`, { description: resolved ? '检测到已有画像，直接继续' : '首次登录，先建一份学情画像' });
    navigate('/welcome');
  };

  const submitSso = () => {
    if (!account.trim() || !password.trim()) {
      toast('请输入工号/邮箱和密码');
      return;
    }
    doLogin('sso', `sso:${account.trim()}`, account.includes('@') ? account.trim() : `工号 ${account.trim()}`, undefined, password.trim());
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

  const loginAsPersona = (id: string) => {
    const l = presets.find((p) => p.id === id);
    if (!l) return;
    setBusy(true);
    doLogin('persona', `persona:${id}`, l.name, id).then(() => {
      setCurrentLearnerId(id);
      toast.success(`已以「${l.name}」登录`);
    });
  };

  const loginGuest = () => {
    const demo = presets[0];
    doLogin('guest', 'guest', '游客', demo.id).then(() => {
      setCurrentLearnerId(demo.id);
      toast('游客体验模式');
      navigate('/me');
    });
  };

  const enterJudge = () => {
    login('guest', 'judge', '评委演示');
    setViewMode('expert');
    toast('已进入系统透视 / 评委视角');
    startDemoTour();
    navigate('/');
  };

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

      <div className="relative flex flex-col items-center justify-center px-5 py-10">
        <Succulent className="pointer-events-none absolute right-8 top-6 hidden h-[56px] w-[48px] md:block" />
        <div className="mb-6 flex items-center gap-2.5 lg:hidden">
          <img src="/logo.svg" alt="智训云枢" className="h-8 w-8" />
          <span className="font-serif text-[18px] font-bold text-ink">智训云枢</span>
        </div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="lf-card w-full max-w-[400px] p-6"
        >
          <div className="flex items-center justify-between">
            <h2 className="font-serif text-[20px] font-semibold text-ink">登录</h2>
            <Link to="/register" className="text-[13px] font-medium text-brand hover:underline">注册</Link>
          </div>
          <div className="mt-4 flex gap-0.5 rounded-[11px] border border-hairline bg-paper p-0.5">
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
          </div>

          {tab === 'sso' && (
            <div className="lf-anim-in-up mt-5 space-y-3">
              <input
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="工号/邮箱（如 LF-0917 或 user@example.com）"
                className="w-full rounded-[10px] border border-hairline bg-paper px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors focus:border-brand/50"
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitSso()}
                placeholder="密码"
                className="w-full rounded-[10px] border border-hairline bg-paper px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors focus:border-brand/50"
              />
              <button type="button" disabled={busy} onClick={submitSso} className="lf-btn-primary w-full justify-center !py-2.5">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Building2 size={15} />}
                登录
              </button>
            </div>
          )}

          {tab === 'sms' && (
            <div className="lf-anim-in-up mt-5 space-y-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="邮箱"
                className="w-full rounded-[10px] border border-hairline bg-paper px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors focus:border-brand/50"
              />
              <div className="flex gap-2">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  onKeyDown={(e) => e.key === 'Enter' && submitEmailCode()}
                  placeholder="验证码"
                  inputMode="numeric"
                  className="min-w-0 flex-1 rounded-[10px] border border-hairline bg-paper px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors focus:border-brand/50"
                />
                <button
                  type="button"
                  disabled={countdown > 0 || busy}
                  onClick={sendCode}
                  className={cn('shrink-0 rounded-[10px] border px-3 py-2.5 text-[12.5px] font-medium transition-all', countdown > 0 ? 'border-hairline bg-paper-deep text-ink-muted/60' : 'border-brand/40 bg-brand-tint text-brand hover:border-brand/60')}
                >
                  {countdown > 0 ? `${countdown}s 后重发` : '获取验证码'}
                </button>
              </div>
              <button type="button" disabled={busy} onClick={submitEmailCode} className="lf-btn-primary w-full justify-center !py-2.5">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <MessageSquareText size={15} />}
                验证并登录
              </button>
            </div>
          )}

          {tab === 'wechat' && (
            <div className="lf-anim-in-up mt-5 flex flex-col items-center gap-3">
              <FakeQr scanned={wxScanned} />
              <p className="flex items-center gap-1.5 text-[12.5px] text-ink-muted">
                {wxScanned ? <><Loader2 size={13} className="animate-spin text-brand" />已扫码，请在手机上确认…</> : <><ScanLine size={13} className="text-brand" />打开微信「扫一扫」</>}
              </p>
            </div>
          )}

          <div className="mt-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-hairline" />
            <span className="text-[11px] text-ink-muted">或用演示画像快速进入</span>
            <span className="h-px flex-1 bg-hairline" />
          </div>
          <div className="mt-3.5 grid grid-cols-3 gap-2">
            {presets.map((l) => (
              <button key={l.id} type="button" disabled={busy} onClick={() => loginAsPersona(l.id)} className="group flex flex-col items-center gap-1.5 rounded-[12px] border border-hairline bg-paper px-2 py-3 transition-all hover:border-brand/45 hover:bg-brand-tint/40">
                <Avatar className="h-10 w-10 border border-hairline transition-transform group-hover:scale-105">
                  <AvatarImage src={l.avatar} alt={l.name} />
                  <AvatarFallback className="bg-brand-tint text-[12px] text-brand">{l.name.slice(0, 1)}</AvatarFallback>
                </Avatar>
                <span className="text-[12.5px] font-medium text-ink">{l.name}</span>
                <span className="text-[10.5px] leading-[14px] text-ink-muted">{l.tag}</span>
              </button>
            ))}
          </div>
          <button type="button" onClick={loginGuest} className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-hairline bg-paper py-2.5 text-[13px] font-medium text-ink-2 transition-all hover:border-brand/40 hover:text-ink">
            <UserRound size={14} />
            游客体验
          </button>
        </motion.div>
        <button type="button" onClick={enterJudge} className="mt-5 inline-flex items-center gap-1.5 text-[12px] text-ink-muted transition-colors hover:text-brand">
          <Sparkles size={12} />
          评委 / 访客演示通道
        </button>
      </div>
    </div>
  );
}
