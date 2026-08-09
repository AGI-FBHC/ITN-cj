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

export interface OnboardingTargetCategory {
  id: number;
  code: string;
  name: string;
  description: string | null;
  sortOrder: number;
  enabled: boolean;
}

export interface OnboardingTargetOption {
  id: number;
  code: string;
  categoryCode: string;
  name: string;
  description: string | null;
  sortOrder: number;
  enabled: boolean;
}

export interface OnboardingMeta {
  knowledgePoints: OnboardingKnowledgePoint[];
  tags: string[];
  edu: string[];
  targetCategories: OnboardingTargetCategory[];
  targetOptions: OnboardingTargetOption[];
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
  targetCategoryCode: string;
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

export interface TeachingGroupAgentDef {
  id: string;
  name: string;
  status: 'idle' | 'running' | 'done' | 'failed';
  duty: string;
}

export interface TeachingGroupRunInput {
  learnerId: string;
  knowledgePointId?: string | null;
  mode: 'prepare_next' | 'diagnose' | 'explain';
  prompt?: string | null;
}

export interface TeachingGroupEvent {
  type: 'run_started' | 'agent_started' | 'agent_output' | 'agent_completed' | 'agent_failed' | 'run_completed' | 'run_failed';
  agent?: string;
  runId?: string;
  learnerId?: string;
  success?: boolean;
  data: Record<string, unknown>;
}


export interface ProfileForgeStep {
  text: string;
  detail: string;
}

export interface GenerateProfileRequest {
  method: 'quick' | 'full';
  name: string;
  avatar: string;
  tag: string;
  education: string;
  targetJob: string;
  targetCategoryCode: string;
  scores: Record<string, number>;
  confidence: number;
  selfLevels?: Record<string, number>;
  answers?: OnboardingAnswerInput[];
}

export interface GenerateProfileResponse {
  name: string;
  avatar: string;
  scores: Record<string, number>;
  confidence: number;
  method: 'quick' | 'full';
  steps: ProfileForgeStep[];
  evidence: string[];
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

async function requestDirect<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let message = `请求失败 (${res.status})`;
    try {
      const parsed = (await res.json()) as { detail?: string; message?: string };
      message = parsed.detail ?? parsed.message ?? message;
    } catch { /* keep status */ }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export async function streamTeachingGroup(
  body: TeachingGroupRunInput,
  onEvent: (event: TeachingGroupEvent) => void,
): Promise<void> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(`${API_BASE}/v1/teaching-group/runs/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    let message = `请求失败 (${res.status})`;
    try {
      const parsed = (await res.json()) as { detail?: string; message?: string };
      message = parsed.detail ?? parsed.message ?? message;
    } catch { /* keep status */ }
    throw new Error(message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = () => {
    let sep = buffer.indexOf('\n\n');
    while (sep >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          onEvent(JSON.parse(line.slice(6)) as TeachingGroupEvent);
        } catch { /* ignore malformed event */ }
      }
      sep = buffer.indexOf('\n\n');
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    consume();
  }
  buffer += decoder.decode();
  consume();
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
  sendCode: (email: string, purpose: 'REGISTER' | 'LOGIN' | 'PASSWORD_RESET') =>
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
  resetPassword: (body: { email: string; verificationCode: string; newPassword: string }) =>
    request<Record<string, unknown>>('/api/v1/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getOnboardingMeta: () => request<OnboardingMeta>('/api/v1/onboarding/meta'),
  generateProfile: (body: GenerateProfileRequest) =>
    request<GenerateProfileResponse>('/api/v1/onboarding/generate-profile', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listTargetCategories: () => request<OnboardingTargetCategory[]>('/api/v1/onboarding/target-categories'),
  listTargetOptions: () => request<OnboardingTargetOption[]>('/api/v1/onboarding/targets'),
  listJobOptions: () => request<OnboardingTargetOption[]>('/api/v1/onboarding/jobs'),
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
  listTeachingGroupAgents: () =>
    requestDirect<{ agents: TeachingGroupAgentDef[] }>('/v1/teaching-group/agents'),
  runTeachingGroupStream: (body: TeachingGroupRunInput, onEvent: (event: TeachingGroupEvent) => void) =>
    streamTeachingGroup(body, onEvent),
};
