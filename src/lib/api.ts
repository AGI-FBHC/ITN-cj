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

export interface LearnerAnalyticsProfile {
  profile: {
    educationLevel: string | null;
    major: string | null;
    learningPreference: string | null;
    technicalFoundation: string | null;
  };
  currentGoal: {
    title: string;
    goalType: string;
    expectedLevel: string;
    progress: number;
  } | null;
  stats: {
    totalStudyMinutes: number;
    totalDays: number;
    streakDays: number;
    weeklyMinutes: number[];
    eventDistribution: Record<string, number>;
  };
  mastery: {
    overall: number;
    categories: {
      id: number;
      name: string;
      score: number;
      attempts: number;
    }[];
    strongPoints: string[];
    weakPoints: string[];
  };
  recentQuizzes: {
    quizType: string;
    score: number | null;
    categoryName: string | null;
    createdAt: string;
  }[];
}

export interface LearningJournal {
  date: string;
  stats: {
    focusSeconds: number;
    totalDurationSeconds: number;
    resourceCount: number;
    knowledgeCount: number;
    questionCount: number;
    correctCount: number;
    wrongCount: number;
  };
  timeline: {
    id: string;
    occurredAt: string;
    kind: 'focus' | 'resource' | 'knowledge' | 'chat' | 'quiz' | string;
    title: string;
    description: string;
    durationSeconds: number | null;
    knowledgeName: string | null;
    correctCount: number | null;
    wrongCount: number | null;
  }[];
  summary: {
    content: string;
    metricsJson: string;
    generatedAt: string;
  } | null;
}

export interface RecordLearningEventInput {
  eventType: 'STUDY_START' | 'STUDY_END' | 'QUIZ_SUBMIT' | 'RESOURCE_VIEW' | 'CHAT_INTERACTION' | 'KP_MASTERY_CHECK';
  sourceType: 'CHAT' | 'RESOURCE' | 'QUIZ' | 'KNOWLEDGE_BASE' | 'WORKFLOW';
  sourceId?: string | null;
  knowledgeCategoryId?: number | null;
  durationSeconds?: number | null;
  metadata?: string | null;
}

export interface LearnerGrowth {
  orb: number;
  watered: number;
  stage: string | null;
  events: {
    eventType: string;
    title: string;
    amount: number;
    createdAt: string;
  }[];
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
  targetJob: string;
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
  id?: string;
  runId?: string;
  status?: 'running' | 'completed' | 'failed' | 'interrupted';
  createdAt?: string;
}

export interface TeachingGroupRunRecord extends TeachingGroupRunPayload {
  id: string;
  runId: string;
  learnerId: string;
  knowledgePointId?: string | null;
  mode: TeachingGroupRunInput['mode'];
  prompt?: string | null;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  eventCount: number;
  focus?: string;
  nextAction?: string;
  errorCode?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TeachingGroupRunSummary = Omit<TeachingGroupRunRecord, 'events'> & { events?: TeachingGroupEvent[] };

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
  learnerId: string | null;
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
  learnerId?: string | null;
  kpId?: string | null;
  state?: Record<string, unknown>;
  learned: boolean;
  learnedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LearningResourceGenerateInput {
  topic: string;
  title?: string;
  learnerId?: string | null;
  kpId?: string | null;
  learningGoalId?: string | null;
  goalDriven?: boolean;
  detailLevel?: 'concise' | 'balanced' | 'detailed';
  questionCount?: number;
}

export interface LearningResource extends LearningResourceSummary {
  content: Record<string, unknown>;
  state: Record<string, unknown>;
  context: Record<string, unknown>;
  decision: Record<string, unknown>;
}

export interface LearningResourceProgress {
  currentBlockId: string | null;
  visitedBlockIds: string[];
  completedStepIds: string[];
  elapsedSeconds: number;
  lastOpenedAt?: string | null;
}

export interface LearningResourceMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface LearningResourceTrace {
  id: number | string;
  title: string;
  type: string;
  credibility: number;
  excerpt: string;
  positions: string[];
  url?: string | null;
}

export type TtsSpeed = 'very_slow' | 'slow' | 'normal' | 'fast' | 'very_fast';

export interface UserProfileSettings {
  profileCompleted: boolean;
  ttsVoice: string;
  ttsSpeed: TtsSpeed;
  [key: string]: unknown;
}

export interface LearningResourceGenerationTask {
  id: string;
  resourceType: 'lecture' | 'practice' | 'quiz';
  title: string;
  status: 'queued' | 'retrieving' | 'planning' | 'generating' | 'verifying' | 'reviewing' | 'revising' | 'judging' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  stageMessage: string;
  events: Array<Record<string, unknown>>;
  resourceId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
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
  edges: {
    from: string;
    to: string;
    kind: 'prereq' | 'related' | 'applies';
    note: string | null;
  }[];
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
  documentType: string | null;
  standardNumber: string | null;
  publishYear: number | null;
  reliabilityScore: number | null;
  categories: { id: number; nodeCode: string; name: string; fullPath: string }[];
}

export interface RagDocumentSummary {
  id: number;
  documentCode: string;
  title: string;
  documentType: string | null;
  sourceType: string | null;
  sourceName: string | null;
  publisher: string | null;
  standardNumber: string | null;
  publishYear: number | null;
  version: string | null;
  language: string | null;
  reliabilityScore: number | null;
  summary: string | null;
  keywords: string[];
  status: string;
  chunkCount: number;
  figureCount: number;
  describedFigureCount: number;
}

export interface RagChunkDetail {
  id: number;
  chunkCode: string;
  chunkIndex: number;
  sectionTitle: string | null;
  titlePath: string | null;
  content: string;
  tokenCount: number | null;
  pageStart: number | null;
  pageEnd: number | null;
  charStart: number | null;
  charEnd: number | null;
  document: RagDocumentSummary;
  categories: RagChunkSummary['categories'];
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

export interface TutoringMessage {
  kind: 'tutor' | 'learner' | 'feedback' | 'backstage' | 'decision' | 'summary';
  text?: string;
  stage?: '引导' | '追问' | '确认';
  kbRefs?: string[];
  verdict?: 'correct' | 'wrong';
  notes?: { agent: 'DIA-01' | 'RET-02' | 'GEN-03' | 'VER-04' | 'ARB-05'; content: string }[];
  type?: 'simplify' | 'challenge';
  reason?: string;
  accuracy?: number;
  asked?: number;
}

export interface TutoringDecision {
  id: string;
  type: 'simplify' | 'challenge';
  label: string;
  reason: string;
  confidence: number;
}

export interface TutoringSession {
  id: string;
  learnerCode: string;
  resourceId: string | null;
  kpId: string;
  scriptTitle: string;
  status: 'running' | 'completed';
  currentNodeId: string | null;
  currentNode: { id: string; stage?: '引导' | '追问' | '确认'; options: { label: string }[] } | null;
  level: number;
  messages: TutoringMessage[];
  answers: boolean[];
  decisions: TutoringDecision[];
  topics: { id: string; name: string; description: string; kbRef?: string | null }[];
  scoreBefore: number;
  scoreAfter: number | null;
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

export interface PersonalizedLearningUnit {
  kpId: string;
  topicId: string;
  topicName: string;
  difficulty: '零基础' | '标准' | '进阶';
  styleLabel: '实操导向' | '案例对照' | '图解优先' | '理论先行';
  blocks: Record<string, unknown>[];
  sources: Record<string, unknown>[];
  cached: boolean;
  updatedAt: string;
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

const BACKEND_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isBackendId(value?: string | null): value is string {
  return Boolean(value && BACKEND_UUID_PATTERN.test(value));
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

export async function streamAssistantTts(
  text: string,
  speed: TtsSpeed = 'normal',
  signal?: AbortSignal,
): Promise<Response> {
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'audio/L16' });
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${API_BASE}/v1/assistant/tts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text, speed }),
    signal,
  });
  if (!response.ok) {
    let message = `语音生成失败 (${response.status})`;
    try {
      const parsed = JSON.parse(await response.text()) as { detail?: string; message?: string };
      message = parsed.detail ?? parsed.message ?? message;
    } catch { /* keep status */ }
    throw new Error(message);
  }
  if (!response.body) throw new Error('浏览器没有收到语音流');
  return response;
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
  getUserProfile: () => request<UserProfileSettings>('/api/v1/profile'),
  updateUserProfile: (body: UserProfileSettings) => request<UserProfileSettings>('/api/v1/profile', {
    method: 'PUT', body: JSON.stringify(body),
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
  getLearnerAnalyticsProfile: () => request<LearnerAnalyticsProfile>('/api/v1/learner-profile'),
  recordLearningEvent: (body: RecordLearningEventInput) =>
    request<void>('/api/v1/learner-profile/events', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getLearningJournal: (date?: string) =>
    request<LearningJournal>(`/api/v1/learner-profile/journal${date ? `?date=${encodeURIComponent(date)}` : ''}`),
  generateLearningJournalSummary: (date?: string) =>
    request<LearningJournal>(`/api/v1/learner-profile/journal/summary${date ? `?date=${encodeURIComponent(date)}` : ''}`, {
      method: 'POST',
    }),
  getLearnerGrowth: (learnerId?: string) =>
    request<LearnerGrowth>(`/api/v1/learner-profile/growth${learnerId ? `?learnerId=${encodeURIComponent(learnerId)}` : ''}`),
  recordLearnerGrowthEvent: (body: { learnerId: string; eventType: string; title: string; amount: number; metadata?: Record<string, unknown> }) =>
    request<LearnerGrowth>('/api/v1/learner-profile/growth-events', {
      method: 'POST',
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
  listRagChunksByCategory: (categoryId: number, page = 0, size = 50) =>
    request<RagChunkPage>(`/api/v1/rag/categories/${categoryId}/chunks?page=${page}&size=${size}`),
  getRagChunk: (chunkId: number) => request<RagChunkDetail>(`/api/v1/rag/chunks/${chunkId}`),
  getRagflowChunk: (ragflowChunkId: string) =>
    request<RagChunkDetail>(`/api/v1/rag/chunks/ragflow/${encodeURIComponent(ragflowChunkId)}`),
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
  reviewWrongAnswer: (wrongId: string, answer: number) =>
    requestDirect<{ item: WrongAnswerRecord; correct: boolean }>(`/v1/wrong-answers/${encodeURIComponent(wrongId)}/review`, { method: 'POST', body: JSON.stringify({ answer }) }),
  deleteWrongAnswer: (wrongId: string) => requestDirect<void>(`/v1/wrong-answers/${encodeURIComponent(wrongId)}`, { method: 'DELETE' }),
  getTutoringScript: (learnerCode: string) =>
    requestDirect<Record<string, unknown>>(`/v1/tutoring/scripts/${encodeURIComponent(learnerCode)}`),
  createTutoringSession: (body: { learnerCode?: string; resourceId?: string }) =>
    requestDirect<TutoringSession>('/v1/tutoring/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  getTutoringSession: (sessionId: string) =>
    requestDirect<TutoringSession>(`/v1/tutoring/sessions/${encodeURIComponent(sessionId)}`),
  answerTutoringSession: (sessionId: string, body: { optionIndex?: number; optionLabel?: string; freeText?: string }) =>
    requestDirect<TutoringSession>(`/v1/tutoring/sessions/${encodeURIComponent(sessionId)}/answer`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  completeTutoringSession: (sessionId: string) =>
    requestDirect<TutoringSession>(`/v1/tutoring/sessions/${encodeURIComponent(sessionId)}/complete`, {
      method: 'POST',
    }),
  listTeachingGroupAgents: () =>
    requestDirect<{ agents: TeachingGroupAgentDef[] }>('/v1/teaching-group/agents'),
  listTeachingGroupRuns: (limit = 30, learnerId?: string | null) => {
    if (learnerId && !isBackendId(learnerId)) return Promise.resolve({ runs: [] });
    return requestDirect<{ runs: TeachingGroupRunSummary[] }>(
      `/v1/teaching-group/runs?limit=${encodeURIComponent(limit)}${learnerId ? `&learnerId=${encodeURIComponent(learnerId)}` : ''}`,
    );
  },
  getTeachingGroupRun: (runId: string) =>
    requestDirect<TeachingGroupRunRecord>(`/v1/teaching-group/runs/${encodeURIComponent(runId)}`),
  runTeachingGroupStream: (body: TeachingGroupRunInput, onEvent: (event: TeachingGroupEvent) => void) =>
    streamTeachingGroup(body, onEvent),
  listCourses: (learnerId?: string | null) => {
    if (learnerId && !isBackendId(learnerId)) return Promise.resolve({ courses: [] });
    return requestDirect<{ courses: Course[] }>(
      `/v1/courses${learnerId ? `?learnerId=${encodeURIComponent(learnerId)}` : ''}`,
    );
  },
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
  retryCourse: (courseId: string) =>
    requestDirect<Course>(`/v1/courses/${encodeURIComponent(courseId)}/retry`, { method: 'POST' }),
  getCourse: (courseId: string) =>
    requestDirect<Course>(`/v1/courses/${encodeURIComponent(courseId)}`),
  deleteCourse: (courseId: string) =>
    requestDirect<void>(`/v1/courses/${encodeURIComponent(courseId)}`, { method: 'DELETE' }),
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
  createLearningLecture: (body: LearningResourceGenerateInput) =>
    requestDirect<LearningResource>('/v1/learning-resources/lectures', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  nourishLearnerGrowth: (learnerId?: string) =>
    request<LearnerGrowth>(`/api/v1/learner-profile/growth/nourish${learnerId ? `?learnerId=${encodeURIComponent(learnerId)}` : ''}`, {
      method: 'POST',
    }),
  createLearningPractice: (body: LearningResourceGenerateInput) =>
    requestDirect<LearningResource>('/v1/learning-resources/practices', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  createLearningQuiz: (body: LearningResourceGenerateInput) =>
    requestDirect<LearningResource>('/v1/learning-resources/quizzes', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  startLearningResourceTask: (resourceType: 'lecture' | 'practice' | 'quiz', body: LearningResourceGenerateInput) =>
    requestDirect<LearningResourceGenerationTask>(`/v1/learning-resource-tasks/${resourceType}`, {
      method: 'POST', body: JSON.stringify(body),
    }),
  listLearningResourceTasks: (limit = 30) =>
    requestDirect<{ tasks: LearningResourceGenerationTask[] }>(`/v1/learning-resource-tasks?limit=${limit}`),
  getLearningResourceTask: (taskId: string) =>
    requestDirect<LearningResourceGenerationTask>(`/v1/learning-resource-tasks/${encodeURIComponent(taskId)}`),
  cancelLearningResourceTask: (taskId: string) =>
    requestDirect<LearningResourceGenerationTask>(`/v1/learning-resource-tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' }),
  getLearningResource: (resourceId: string) =>
    requestDirect<LearningResource>(`/v1/learning-resources/${encodeURIComponent(resourceId)}`),
  getPersonalizedLearningUnit: (kpId: string, topicId: string, learnerId: string) =>
    requestDirect<PersonalizedLearningUnit>(`/v1/learning-units/${encodeURIComponent(kpId)}/topics/${encodeURIComponent(topicId)}?learnerId=${encodeURIComponent(learnerId)}`),
  prewarmPersonalizedLearningUnits: (learnerId: string) =>
    requestDirect<{ queued: number; granularity: string }>('/v1/learning-units/prewarm', {
      method: 'POST', body: JSON.stringify({ learnerId }),
    }),
  completeLearningResource: (resourceId: string) =>
    requestDirect<{ learned: boolean; resource: LearningResource }>(`/v1/learning-resources/${encodeURIComponent(resourceId)}/complete`, {
      method: 'POST',
    }),
  updateLearningResourceProgress: (resourceId: string, body: {
    currentBlockId?: string | null;
    visitedBlockIds?: string[];
    completedStepIds?: string[];
    elapsedSeconds?: number;
  }) => requestDirect<{ resource: LearningResource }>(`/v1/learning-resources/${encodeURIComponent(resourceId)}/progress`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }),
  listLearningResourceMessages: (resourceId: string) =>
    requestDirect<{ messages: LearningResourceMessage[] }>(`/v1/learning-resources/${encodeURIComponent(resourceId)}/messages`),
  chatLearningResource: (resourceId: string, body: {
    message: string;
    history?: { role: 'user' | 'assistant'; content: string }[];
    currentQuestionId?: string | null;
  }) => requestDirect<{ reply: string; followUps: string[] }>(`/v1/learning-resources/${encodeURIComponent(resourceId)}/chat`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  getLearningResourceTraceability: (resourceId: string) =>
    requestDirect<{ items: LearningResourceTrace[] }>(`/v1/learning-resources/${encodeURIComponent(resourceId)}/traceability`),
  submitLearningResourceSourceFeedback: (resourceId: string, body: {
    sourceId: string;
    issueType?: 'needs_review' | 'mismatch' | 'outdated' | 'broken_link' | 'other';
    note?: string | null;
  }) => requestDirect<{ feedback: { id: string; status: string } }>(`/v1/learning-resources/${encodeURIComponent(resourceId)}/source-feedback`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  answerLearningQuiz: (resourceId: string, body: { questionId: string; answer: string; durationSeconds?: number }) =>
    requestDirect<Record<string, unknown>>(`/v1/learning-resources/${encodeURIComponent(resourceId)}/answers`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  gradeLearningQuiz: (resourceId: string, body: { questionId: string; answer: string; durationSeconds?: number }) =>
    requestDirect<Record<string, unknown>>(`/v1/learning-resources/${encodeURIComponent(resourceId)}/answers/grade`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
