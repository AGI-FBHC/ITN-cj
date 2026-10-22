/**
 * AuthContext — 登录态
 * 统一通过后端接口登录；演示画像也必须是数据库种子中的 learner。
 */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { api, setToken } from '@/lib/api';

export type LoginMethod = 'sso' | 'sms' | 'wechat' | 'guest' | 'persona' | 'admin';

export interface AuthSession {
  method: LoginMethod;
  account: string;
  label: string;
  at: number;
  token?: string;
  learnerId?: string;
  roles?: string[];
}

interface KnownRecord {
  learnerId: string;
  lastAt: number;
}

interface AuthContextValue {
  session: AuthSession | null;
  isAuthed: boolean;
  knownOf: (account: string) => KnownRecord | null;
  login: (method: LoginMethod, account: string, label: string, learnerId?: string) => void;
  loginRemote: (
    method: LoginMethod,
    account: string,
    label: string,
    learnerId?: string,
    secret?: string,
  ) => Promise<boolean>;
  bindAccount: (learnerId: string) => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthContextValue | null>(null);
const K_AUTH = 'lf.auth';
const K_KNOWN = 'lf.knownAccounts';

/** 界面偏好类缓存：退出游客时保留，其余 lf.* 都算体验数据 */
const KEEP_LOCAL_KEYS = new Set([
  'lf.background', 'lf.pptVolume', 'lf.qwenVoice', 'lf.remindEveryMin', 'lf.viewMode',
  'lf.agent-dock-side', 'lf.agent-dock-width', 'lf.schemaVersion', 'lf.chunkReloadCount',
  'lf.bootReady:v1', 'lf.bootSeen:v1', 'lf.guideSeen', 'lf.deviceId',
]);

/** 本机标识：游客账号按设备区分，避免不同电脑共用同一个游客画像、互相看到数据 */
const K_DEVICE = 'lf.deviceId';
function guestDeviceId(): string {
  try {
    const stored = window.localStorage.getItem(K_DEVICE);
    if (stored && /^[a-z0-9-]{8,40}$/.test(stored)) return stored;
    const raw = globalThis.crypto?.randomUUID?.()
      ?? `d${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const id = raw.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 36);
    window.localStorage.setItem(K_DEVICE, id);
    return id;
  } catch {
    return '';
  }
}

/** 退出游客时清掉本地缓存（书架、助手对话、知识图缓存、断点、笔记等） */
function clearGuestLocalData(): void {
  if (typeof window === 'undefined') return;
  try {
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith('lf.') && !KEEP_LOCAL_KEYS.has(key) && !key.startsWith('lf.tip.'))
      .forEach((key) => window.localStorage.removeItem(key));
  } catch { /* 隐私模式下拿不到 storage 时忽略 */ }
  try {
    Object.keys(window.sessionStorage)
      .filter((key) => key.startsWith('lf.'))
      .forEach((key) => window.sessionStorage.removeItem(key));
  } catch { /* 同上 */ }
}

/** 退出游客时打标记，等页面重载、各 Provider 尚未挂载时再清；避免被仍在运行的 effect 又写回来 */
const K_GUEST_WIPE = 'lf.guestWipe';

/** 应用启动时先执行：清掉上一次游客退出留下的数据 */
export function consumeGuestWipe(): void {
  if (typeof window === 'undefined') return;
  let pending = false;
  try { pending = window.localStorage.getItem(K_GUEST_WIPE) === '1'; } catch { return; }
  if (!pending) return;
  clearGuestLocalData();
  try { window.localStorage.removeItem(K_GUEST_WIPE); } catch { /* ignore */ }
}

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}


export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(() => readJSON<AuthSession | null>(K_AUTH, null));
  const [known, setKnown] = useState<Record<string, KnownRecord>>(() =>
    readJSON<Record<string, KnownRecord>>(K_KNOWN, {}),
  );

  useEffect(() => {
    if (!session || (session.method !== 'sso' && session.method !== 'sms')) return;
    if (known[session.account]) return;
    let cancelled = false;
    api.listLearners()
      .then((learners) => {
        if (!cancelled && learners.length > 0) {
          setKnown((prev) => ({ ...prev, [session.account]: { learnerId: learners[0].id, lastAt: Date.now() } }));
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [session, known]);

  const persistSession = useCallback((s: AuthSession | null) => {
    setSession(s);
    setToken(s?.token ?? null);
    try {
      if (s) window.localStorage.setItem(K_AUTH, JSON.stringify(s));
      else window.localStorage.removeItem(K_AUTH);
    } catch { /* ignore */ }
  }, []);

  const persistKnown = useCallback((next: Record<string, KnownRecord>) => {
    setKnown(next);
    try { window.localStorage.setItem(K_KNOWN, JSON.stringify(next)); } catch { /* ignore */ }
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    session,
    isAuthed: session !== null,
    knownOf: (account) => known[account] ?? null,
    login: (method, account, label, learnerId) => {
      persistSession({ method, account, label, at: Date.now() });
      if (learnerId) persistKnown({ ...known, [account]: { learnerId, lastAt: Date.now() } });
    },
    loginRemote: async (method, account, label, learnerId, secret) => {
      try {
        let result;
        if (method === 'guest') {
          const persona = account.startsWith('guest:') ? account.replace('guest:', '') : undefined;
          result = await api.guestLogin(persona, guestDeviceId());
        } else if (method === 'persona') {
          result = await api.demoLogin(learnerId ?? account.replace(/^persona:/, ''));
        } else if (method === 'admin') {
          result = await api.adminLogin(account.replace(/^admin:/, ''), secret ?? '');
        } else if (method === 'sso') {
          const value = account.replace(/^sso:/, '');
          result = value.includes('@')
            ? await api.login(value, secret ?? '')
            : await api.identityLogin({ identityType: 'ENTERPRISE', identityValue: value, password: secret ?? '' });
        } else if (method === 'sms') {
          result = await api.emailCodeLogin(account.replace(/^email:/, ''), secret ?? '');
        } else {
          result = await api.identityLogin({
            identityType: 'WECHAT',
            identityValue: account.replace(/^wx:/, ''),
            verificationCode: secret || 'demo',
          });
        }
        // 后端 issueLogin 总是把 user.getId() 当成 learnerId 返回，需要从 /learners 取出真实 learner UUID
        // 先写入 token，否则后续 /learners 请求仍带旧 token 会 401，导致 known 绑定失败
        setToken(result.accessToken);
        let realLearnerId: string | null = learnerId ?? null;
        /* 游客登录接口已直接返回真实 learner UUID，省掉一次 /learners 往返（进站更快） */
        if (method === 'guest' && result.learnerId) {
          realLearnerId = result.learnerId;
        } else {
          try {
            const learnedList = await api.listLearners();
            if (learnedList.length > 0) realLearnerId = learnedList[0].id;
            else realLearnerId = null;
          } catch { /* keep existing */ }
        }
        persistSession({
          method, account, label, at: Date.now(), token: result.accessToken,
          learnerId: realLearnerId ?? undefined, roles: result.roles ?? [],
        });
        if (realLearnerId) persistKnown({ ...known, [account]: { learnerId: realLearnerId, lastAt: Date.now() } });
        return true;
      } catch {
        return false;
      }
    },
    bindAccount: (learnerId) => {
      if (!session) return;
      persistKnown({ ...known, [session.account]: { learnerId, lastAt: Date.now() } });
    },
    logout: async () => {
      /* 游客是公用的体验账号：先清服务端记录，本地数据等整页重载后再清，避免被 Provider 写回 */
      if (session?.roles?.includes('guest')) {
        await api.guestReset().catch(() => undefined);
        try { window.localStorage.setItem(K_GUEST_WIPE, '1'); } catch { /* ignore */ }
      }
      persistSession(null);
    },
  }), [session, known, persistSession, persistKnown]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthContextValue {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used within AuthProvider');
  return c;
}
