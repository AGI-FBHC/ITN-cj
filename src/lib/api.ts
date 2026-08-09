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

export interface TeachingGroupRunPayload {
  events: TeachingGroupEvent[];
  result?: Record<string, unknown> | null;
}

export interface CourseChapterResource {
  id?: string | null;
  status: string;
  progress?: number;
  title?: string | null;
  error?: string | null;
}

export interface CourseChapter {
  id: string;
  index: number;
  title: string;
  summary: string;
  objectives: string[];
  sections: { title: string; summary?: string; keyTopics?: string[] }[];
  status: string;
  progress: number;
  resources: Record<string, CourseChapterResource>;
  createdAt: string;
  updatedAt: string;
}

export interface Course {
  id: string;
  title: string;
  description: string;
  prompt: string;
  learningGoalId: string | null;
  learningGoalIds: string[];
  domainName: string;
  depth: string;
  scale: string;
  courseStyle: string;
  resourceTypes: string[];
  status: string;
  progress: number;
  stageMessage: string;
  errorMessage: string | null;
  currentChapterId: string | null;
  events: Record<string, unknown>[];
  chapters: CourseChapter[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateCourseInput {
  learnerId?: string | null;
  prompt: string;
  resourceTypes: string[];
  depth: 'introductory' | 'systematic' | 'advanced';
  scale: 'compact' | 'standard' | 'complete';
  courseStyle?: string;
}

export interface LearningResourceSummary {
  id: string;
  type: 'lecture' | 'practice' | 'quiz';
  title: string;
  topic: string;
  courseId: string | null;
  chapterId: string | null;
  sources: Record<string, unknown>[];
  state?: Record<string, unknown>;
  learned: boolean;
  learnedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LearningResource extends LearningResourceSummary {
  content: Record<string, unknown>;
  state: Record<string, unknown>;
  context: Record<string, unknown>;
  decision: Record<string, unknown>;
}

export interface RagDomain {
  id: number;
  code: string;
  name: string;
  description: string;
  icon: string | null;
  categoryCount: number;
  knowledgePointCount: number;
  documentCount: number;
  chunkCount: number;
  figureCount: number;
}

export interface RagTreeNode {
  id: number;
  parentId: number | null;
  nodeCode: string;
  name: string;
  level: number;
  nodeType: string;
  sortOrder: number;
  description: string | null;
  chunkCount: number | null;
  children: RagTreeNode[];
}

export interface RagTree {
  domain: RagDomain;
  nodes: RagTreeNode[];
  totalKnowledgePoints: number;
  totalChunks: number;
}

export interface RagChunkSummary {
  id: number;
  chunkCode: string;
  chunkIndex: number;
  sectionTitle: string | null;
  titlePath: string | null;
  summary: string | null;
  tokenCount: number | null;
  pageStart: number | null;
  pageEnd: number | null;
  documentCode: string;
  documentTitle: string;
  documentSourceName: string | null;
  categories: { id: number; nodeCode: string; name: string; fullPath: string }[];
}

export interface RagChunkPage {
  total: number;
  page: number;
  size: number;
  items: RagChunkSummary[];
}

export interface LearningNoteRecord {
  id: string;
  title: string;
  content: string;
  status: string;
  sourceType: string;
  sourceRef: string | null;
  sourceContext: string | null;
  learnerId: string | null;
  kpId: string | null;
  sourceKind: string | null;
  kbRefs: string[];
  knowledgeCategoryId: number | null;
  knowledgeCategoryName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WrongAnswerRecord {
  id: string;
  resourceId: string | null;
  questionId: string;
  stem: string;
  learnerId: string | null;
  kpId: string | null;
  fromSource: string | null;
  firstAt: string;
  streak: number;
  lastPick: number | null;
  mastered: boolean;
  kbRefs: string[];
  options: string[];
  userAnswer: number;
  correctAnswer: number;
  explanation: string;
  difficulty: string;
  knowledgeCategoryName: string | null;
  reviewStatus: string;
  reviewCount: number;
  createdAt: string;
  updatedAt: string;
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
  if (res.status === 204) return undefined as T;
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
  listRagDomains: () => request<RagDomain[]>('/api/v1/rag/domains'),
  getRagTree: (domainCode: string) =>
    request<RagTree>(`/api/v1/rag/tree/${encodeURIComponent(domainCode)}`),
  searchRagChunks: (query: string, page = 0, size = 20) => {
    const params = new URLSearchParams({ q: query, page: String(page), size: String(size) });
    return request<RagChunkPage>(`/api/v1/rag/chunks/search?${params.toString()}`);
  },
  listNotes: () => requestDirect<{ notes: LearningNoteRecord[] }>('/v1/notes'),
  createNote: (body: {
    title: string; content: string; learnerId?: string; kpId?: string;
    sourceKind?: string; sourceType?: string; sourceRef?: string; sourceContext?: string; kbRefs?: string[];
  }) => requestDirect<LearningNoteRecord>('/v1/notes', { method: 'POST', body: JSON.stringify(body) }),
  deleteNote: (noteId: string) => requestDirect<void>(`/v1/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' }),
  listWrongAnswers: () => requestDirect<{ items: WrongAnswerRecord[] }>('/v1/wrong-answers'),
  updateWrongAnswer: (wrongId: string, body: { reviewStatus?: string; mastered?: boolean; streak?: number; lastPick?: number }) =>
    requestDirect<WrongAnswerRecord>(`/v1/wrong-answers/${encodeURIComponent(wrongId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteWrongAnswer: (wrongId: string) => requestDirect<void>(`/v1/wrong-answers/${encodeURIComponent(wrongId)}`, { method: 'DELETE' }),
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
  listCourses: () => requestDirect<{ courses: Course[] }>('/v1/courses'),
  createCourse: (body: CreateCourseInput) =>
    requestDirect<Course>('/v1/courses', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  regenerateCourse: (courseId: string, body: { learnerId?: string; resourceTypes?: string[] }) =>
    requestDirect<Course>(`/v1/courses/${encodeURIComponent(courseId)}/regenerate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getCourse: (courseId: string) =>
    requestDirect<Course>(`/v1/courses/${encodeURIComponent(courseId)}`),
  updateCourse: (courseId: string, body: { title?: string; description?: string }) =>
    requestDirect<Course>(`/v1/courses/${encodeURIComponent(courseId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  updateCourseChapter: (courseId: string, chapterId: string, body: { title?: string; summary?: string }) =>
    requestDirect<Course>(`/v1/courses/${encodeURIComponent(courseId)}/chapters/${encodeURIComponent(chapterId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  generateChapterResource: (courseId: string, chapterId: string, resourceType: string) =>
    requestDirect<Course>(`/v1/courses/${encodeURIComponent(courseId)}/chapters/${encodeURIComponent(chapterId)}/resources/${encodeURIComponent(resourceType)}/retry`, {
      method: 'POST',
    }),
  listLearningResources: (params?: { courseId?: string; chapterId?: string; resourceType?: string }) => {
    const query = new URLSearchParams();
    if (params?.courseId) query.set('courseId', params.courseId);
    if (params?.chapterId) query.set('chapterId', params.chapterId);
    if (params?.resourceType) query.set('resourceType', params.resourceType);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return requestDirect<{ resources: LearningResourceSummary[] }>(`/v1/learning-resources${suffix}`);
  },
  getLearningResource: (resourceId: string) =>
    requestDirect<LearningResource>(`/v1/learning-resources/${encodeURIComponent(resourceId)}`),
  completeLearningResource: (resourceId: string) =>
    requestDirect<{ learned: boolean; resource: LearningResource }>(`/v1/learning-resources/${encodeURIComponent(resourceId)}/complete`, {
      method: 'POST',
    }),
  answerLearningQuiz: (resourceId: string, body: { questionId: string; answer: string; durationSeconds?: number }) =>
    requestDirect<Record<string, unknown>>(`/v1/learning-resources/${encodeURIComponent(resourceId)}/answers`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
