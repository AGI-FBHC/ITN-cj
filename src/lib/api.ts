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

export interface LearnerProfileData {
  id: string;
  code: string | null;
  name: string;
  avatar: string | null;
  role: string | null;
  education: string | null;
  targetJob: string | null;
  weeklyHours: number | null;
  learningStyle: string[];
  scores: Record<string, number>;
  goal: string | null;
  blindSpots: string[];
  preferredFormat: string | null;
  diagnosisSummary: string | null;
  confidenceMethod: 'quick' | 'full' | null;
  confidenceValue: number | null;
  overallMastery: number;
  createdAt: string;
  updatedAt: string;
}

export interface LearnerUpsertInput {
  code?: string | null;
  name?: string | null;
  avatar?: string | null;
  role?: string | null;
  education?: string | null;
  targetJob?: string | null;
  weeklyHours?: number | null;
  learningStyle?: string[];
  scores?: Record<string, number>;
  goal?: string | null;
  blindSpots?: string[];
  preferredFormat?: string | null;
  diagnosisSummary?: string | null;
  confidenceMethod?: 'quick' | 'full' | null;
  confidenceValue?: number | null;
}



export interface OnboardingKnowledgePoint {
  id: string;
  name: string;
  en: string;
  weight: number;
  targetLevel: number;
  coverage: number;
  description: string;
  coreTopics: string[];
}

export interface OnboardingQuestion {
  id: string;
  kpId: string;
  level: 'basic' | 'advanced' | 'challenge';
  stars: number;
  stem: string;
  options: string[];
  answerIndex: number;
  analysis: string;
  kbRefs: string[];
}

export interface OnboardingMeta {
  knowledgePoints: OnboardingKnowledgePoint[];
  tags: string[];
  edu: string[];
  jobs: string[];
  styles: string[];
  selfLevels: string[];
  questions: OnboardingQuestion[];
}

export interface OnboardingAnswerInput {
  questionId: string;
  result: 'correct' | 'wrong' | 'uncertain';
  attribution?: 'guess' | 'concept' | 'careless' | null;
  extra?: boolean;
  reason?: string | null;
}

export interface OnboardingAnswerRequest {
  tag: string;
  education: string;
  selfLevels: Record<string, number>;
  answers: OnboardingAnswerInput[];
  queueIds: string[];
}

export interface OnboardingAnswerResponse {
  estimates: Record<string, number>;
  confidence: Record<string, number>;
  averageConfidence: number;
  comment: string;
  nextQuestion: OnboardingQuestion | null;
  nextReason: string | null;
  quizDone: boolean;
}

export interface OnboardingDiagnoseRequest {
  tag: string;
  education: string;
  targetJob: string;
  selfLevels: Record<string, number>;
  answers: OnboardingAnswerInput[];
}

export interface OnboardingDiagnoseResponse {
  scores: Record<string, number>;
  confidence: Record<string, number>;
  averageConfidence: number;
  blindSpots: string[];
  goal: string;
  diagnosisSummary: string;
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
  listLearners: () => request<LearnerProfileData[]>('/api/v1/learners'),
  getLearner: (id: string) => request<LearnerProfileData>(`/api/v1/learners/${encodeURIComponent(id)}`),
  createLearner: (body: LearnerUpsertInput) =>
    request<LearnerProfileData>('/api/v1/learners', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateLearner: (id: string, body: LearnerUpsertInput) =>
    request<LearnerProfileData>(`/api/v1/learners/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  getOnboardingMeta: () => request<OnboardingMeta>('/api/v1/onboarding/meta'),
  answerOnboarding: (body: OnboardingAnswerRequest) =>
    request<OnboardingAnswerResponse>('/api/v1/onboarding/answer', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  diagnoseOnboarding: (body: OnboardingDiagnoseRequest) =>
    request<OnboardingDiagnoseResponse>('/api/v1/onboarding/diagnose', {
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
