export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
  timestamp: string;
}

export interface LoginResult {
  accessToken: string;
  tokenType: string;
  expiresInSeconds: number;
  user: {
    id: string;
    email: string;
    nickname: string;
    active: boolean;
    createdAt: string;
  };
  learnerId?: string | null;
  guest?: boolean;
  organizationCode?: string | null;
  organizationName?: string | null;
  departmentName?: string | null;
  roles?: string[];
}

export interface EnterpriseRegisterResult {
  login: LoginResult;
  employeeNo: string;
  organizationName: string;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? '';
export const TOKEN_KEY = 'lf.token';

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let message = `请求失败 (${res.status})`;
    try {
      const parsed = JSON.parse(await res.text()) as { detail?: string; message?: string };
      message = parsed.detail ?? parsed.message ?? message;
    } catch {
      /* keep status */
    }
    throw new Error(message);
  }
  if (res.status === 204) return null as T;
  const body = (await res.json()) as ApiEnvelope<T>;
  if (body.code !== 0) throw new Error(body.message);
  return body.data;
}

export const api = {
  login: (email: string, password: string) =>
    request<LoginResult>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  guestLogin: () => request<LoginResult>('/api/v1/auth/guest-login', { method: 'POST' }),
  demoLogin: (learnerCode: string) =>
    request<LoginResult>('/api/v1/auth/demo-login', {
      method: 'POST',
      body: JSON.stringify({ learnerCode }),
    }),
  identityLogin: (body: {
    identityType: 'ENTERPRISE' | 'WECHAT';
    identityValue: string;
    password?: string;
    verificationCode?: string;
  }) => request<LoginResult>('/api/v1/auth/identity-login', {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  sendCode: (email: string, purpose: 'REGISTER' | 'LOGIN') =>
    request<{ email: string; expiresInSeconds: number; retryAfterSeconds: number }>('/api/v1/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ email, purpose }),
    }),
  emailCodeLogin: (email: string, verificationCode: string) =>
    request<LoginResult>('/api/v1/auth/email-code-login', {
      method: 'POST',
      body: JSON.stringify({ email, verificationCode }),
    }),
  registerEnterprise: (body: {
    email: string;
    password: string;
    nickname?: string;
    verificationCode: string;
    enterpriseName: string;
  }) =>
    request<EnterpriseRegisterResult>('/api/v1/auth/register-enterprise', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getTutoringScript: (learnerCode: string) =>
    request<Record<string, unknown>>(`/v1/tutoring/scripts/${encodeURIComponent(learnerCode)}`),
  createTutoringSession: (learnerCode: string) =>
    request<Record<string, unknown>>('/v1/tutoring/sessions', {
      method: 'POST',
      body: JSON.stringify({ learnerCode }),
    }),
  getTutoringSession: (sessionId: string) =>
    request<Record<string, unknown>>(`/v1/tutoring/sessions/${encodeURIComponent(sessionId)}`),
  answerTutoringSession: (sessionId: string, body: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/v1/tutoring/sessions/${encodeURIComponent(sessionId)}/answer`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  completeTutoringSession: (sessionId: string) =>
    request<Record<string, unknown>>(`/v1/tutoring/sessions/${encodeURIComponent(sessionId)}/complete`, {
      method: 'POST',
    }),
};
