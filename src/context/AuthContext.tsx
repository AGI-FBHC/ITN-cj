/**
 * AuthContext — 登录态
 * 统一通过后端接口登录；演示画像也必须是数据库种子中的 learner。
 */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, setToken } from '@/lib/api';

export type LoginMethod = 'sso' | 'sms' | 'wechat' | 'guest' | 'persona';

export interface AuthSession {
  method: LoginMethod;
  account: string;
  label: string;
  at: number;
  token?: string;
  learnerId?: string;
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
  logout: () => void;
}

const Ctx = createContext<AuthContextValue | null>(null);
const K_AUTH = 'lf.auth';
const K_KNOWN = 'lf.knownAccounts';

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
          result = await api.guestLogin();
        } else if (method === 'persona') {
          result = await api.demoLogin(learnerId ?? account.replace(/^persona:/, ''));
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
        persistSession({
          method, account, label, at: Date.now(), token: result.accessToken,
          learnerId: result.learnerId ?? learnerId,
        });
        persistKnown({ ...known, [account]: { learnerId: learnerId ?? result.learnerId ?? account, lastAt: Date.now() } });
        return true;
      } catch {
        return false;
      }
    },
    bindAccount: (learnerId) => {
      if (!session) return;
      persistKnown({ ...known, [session.account]: { learnerId, lastAt: Date.now() } });
    },
    logout: () => persistSession(null),
  }), [session, known, persistSession, persistKnown]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthContextValue {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used within AuthProvider');
  return c;
}
