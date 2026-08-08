import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { Building2, Loader2, Mail, UserRound } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

export default function Register() {
  const navigate = useNavigate();
  const { loginRemote } = useAuth();
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [code, setCode] = useState('');
  const [enterpriseName, setEnterpriseName] = useState('');
  const [countdown, setCountdown] = useState(0);

  const sendCode = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      toast('请输入正确的邮箱地址');
      return;
    }
    setBusy(true);
    try {
      await api.sendCode(email.trim(), 'REGISTER');
      setCountdown(60);
      toast.success('验证码已发送', { description: `已发送至 ${email.trim()}` });
    } catch (err) {
      toast.error('验证码发送失败', { description: err instanceof Error ? err.message : '请稍后重试' });
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!email.trim() || !password || !code.trim() || !enterpriseName.trim()) {
      toast('请填写完整注册信息');
      return;
    }
    setBusy(true);
    try {
      const result = await api.registerEnterprise({
        email: email.trim(),
        password,
        nickname: nickname.trim() || undefined,
        verificationCode: code.trim(),
        enterpriseName: enterpriseName.trim(),
      });
      toast.success('企业注册成功', {
        description: `企业：${result.organizationName} · 工号：${result.employeeNo}`,
      });
      await loginRemote('sso', `sso:${result.employeeNo}`, email.trim(), undefined, password);
      navigate('/welcome');
    } catch (err) {
      toast.error('注册失败', { description: err instanceof Error ? err.message : '请稍后重试' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lf-learner flex min-h-[100dvh] items-center justify-center bg-card-warm/60 px-5 py-10">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="lf-card w-full max-w-[440px] p-6"
      >
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-serif text-[22px] font-semibold text-ink">企业注册</h1>
            <p className="mt-1 text-[12.5px] text-ink-muted">注册后自动生成 9 位企业工号</p>
          </div>
          <Link to="/login" className="text-[13px] font-medium text-brand hover:underline">返回登录</Link>
        </div>

        <div className="mt-5 space-y-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="邮箱"
            className="w-full rounded-[10px] border border-hairline bg-paper px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors focus:border-brand/50"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码（至少 8 位，含字母和数字）"
            className="w-full rounded-[10px] border border-hairline bg-paper px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors focus:border-brand/50"
          />
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="昵称（选填）"
            className="w-full rounded-[10px] border border-hairline bg-paper px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors focus:border-brand/50"
          />
          <input
            value={enterpriseName}
            onChange={(e) => setEnterpriseName(e.target.value)}
            placeholder="企业名称"
            className="w-full rounded-[10px] border border-hairline bg-paper px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors focus:border-brand/50"
          />
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="验证码"
              inputMode="numeric"
              className="min-w-0 flex-1 rounded-[10px] border border-hairline bg-paper px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors focus:border-brand/50"
            />
            <button
              type="button"
              disabled={busy || countdown > 0}
              onClick={sendCode}
              className={cn('shrink-0 rounded-[10px] border px-3 py-2.5 text-[12.5px] font-medium transition-all', countdown > 0 ? 'border-hairline bg-paper-deep text-ink-muted/60' : 'border-brand/40 bg-brand-tint text-brand hover:border-brand/60')}
            >
              {countdown > 0 ? `${countdown}s 后重发` : '获取验证码'}
            </button>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={submit}
            className="lf-btn-primary w-full justify-center !py-2.5"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Building2 size={15} />}
            注册并登录
          </button>
          <div className="flex items-center justify-center gap-1.5 text-[12px] text-ink-muted">
            <Mail size={12} />
            注册账号也可用邮箱验证码登录
          </div>
          <div className="flex items-center justify-center gap-1.5 text-[12px] text-ink-muted">
            <UserRound size={12} />
            企业名称会作为你的企业组织归属
          </div>
        </div>
      </motion.div>
    </div>
  );
}
