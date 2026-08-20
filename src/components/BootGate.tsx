/**
 * BootGate — 冷启动资源准备屏。
 *
 * 触发条件（满足其一）：
 * - 本设备从未登录过账号（无 token 且从未完成过冷启动）；
 * - 已登录但应用 localStorage 数据为空（信息不足，需要重建基础缓存）。
 *
 * 表现：全屏「正在准备一些系统资源…」加载屏 → 后台探测后端连通性并预热关键资源 →
 * 就绪后自动刷新进入应用；后端不可达时停留在准备屏并给出重试，避免刷新进死循环。
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Brain, Loader2 } from 'lucide-react';
import { getToken } from '@/lib/api';

const BOOT_FLAG = 'lf.bootReady:v1';      // session 级：本次会话已准备过
const BOOT_SEEN_KEY = 'lf.bootSeen:v1';   // 设备级：本设备已完成过冷启动
const MIN_DISPLAY_MS = 1600;
const FRONTEND_PREVIEW = import.meta.env.VITE_FRONTEND_PREVIEW === 'true';

function isColdStart(): boolean {
  try {
    /* 仅当本设备从未完成过冷启动时才准备一次（会话内由 sessionStorage 兜底），
       避免“有登录态但缓存被清空”时刷新后仍判定冷启动 → 死循环刷新 */
    if (window.localStorage.getItem(BOOT_SEEN_KEY) === '1') return false;
    const token = getToken();
    if (!token) return true;
    const appKeys = Object.keys(window.localStorage).filter((key) => key.startsWith('lf.'));
    return appKeys.length === 0;
  } catch {
    return false;
  }
}

export default function BootGate({ children }: { children: ReactNode }) {
  const cold = useMemo(() => !FRONTEND_PREVIEW && isColdStart(), []);
  const [ready] = useState(() => {
    try {
      return window.sessionStorage.getItem(BOOT_FLAG) === '1';
    } catch {
      return true;
    }
  });
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!cold || ready) return undefined;
    let cancelled = false;

    const warm = async (): Promise<boolean> => {
      // 连通性探测：未登录时 /auth/me 返回 401 即视为服务正常
      try {
        const headers: Record<string, string> = {};
        const token = getToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch('/api/v1/auth/me', { headers });
        const ok = res.status === 401 || res.ok;
        if (!cancelled) setBackendOk(ok);
        return ok;
      } catch {
        if (!cancelled) setBackendOk(false);
        return false;
      }
    };

    void (async () => {
      const [ok] = await Promise.all([warm(), new Promise((resolve) => setTimeout(resolve, MIN_DISPLAY_MS))]);
      if (cancelled) return;
      if (ok) {
        // 就绪后自动刷新：保证基础数据/模块都以完整状态进入应用
        try {
          window.localStorage.setItem(BOOT_SEEN_KEY, '1');
          window.sessionStorage.setItem(BOOT_FLAG, '1');
        } catch {
          /* ignore */
        }
        window.location.reload();
      }
      /* 后端不可达：留在准备屏，等用户重试或网络恢复 */
    })();

    return () => { cancelled = true; };
  }, [cold, ready, attempt]);

  if (!cold || ready) return <>{children}</>;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-gradient-to-br from-brand-tint/40 via-paper to-card-warm px-6">
      <div className="relative flex h-20 w-20 items-center justify-center rounded-[22px] border border-brand/20 bg-paper shadow-warm-lg">
        <span className="lf-orb absolute inset-0" />
        <Brain size={34} className="relative text-brand" />
      </div>
      <div className="text-center">
        <h1 className="font-serif text-[22px] font-semibold text-ink">正在准备一些系统资源…</h1>
        <p className="mt-2 max-w-[420px] text-[13px] leading-6 text-ink-muted">
          首次进入需要加载基础数据与学习环境，请稍候；加载完成后将自动进入，保证后续功能稳定运行。
        </p>
      </div>
      <div className="flex items-center gap-2 text-[12px] text-ink-muted">
        <Loader2 size={14} className="animate-spin" />
        {backendOk === false ? '服务连接异常，正在等待网络恢复…' : '正在加载基础资源…'}
      </div>
      {backendOk === false && (
        <button type="button" onClick={() => setAttempt((n) => n + 1)} className="lf-btn-ghost !py-1.5 text-[12px]">
          重新尝试
        </button>
      )}
      <p className="text-[11px] text-ink-muted/70">若长时间停留，请检查网络后刷新页面</p>
    </div>
  );
}
