/**
 * PPT 任务与幻灯片播放接口。
 * 后端复用 agents 的 /v1/presentations，任务后台生成并落库 MySQL。
 */
import { getToken } from './api';

export type PresentationAudience = 'students' | 'teachers' | 'professionals' | 'general';
export type PresentationPurpose = 'courseware' | 'report' | 'sharing' | 'defense' | 'training';

export interface PresentationRequest {
  requirement: string;
  title?: string;
  audience: PresentationAudience;
  purpose: PresentationPurpose;
  style: 'academic' | 'business' | 'technology' | 'minimal' | 'vibrant' | 'education' | 'forest' | 'ocean' | 'terracotta' | 'editorial' | 'luxury' | 'dark';
  backgroundStyle: 'none' | 'colorful-ink' | 'sunset-mountains' | 'abstract-gradient' | 'clean-minimal' | 'cartoon-doodle' | 'blue-white-minimal' | 'blue-conference' | 'morandi-blue-gray' | 'business-gray' | 'watercolor';
  language: 'zh-CN' | 'en-US';
  slideCount: number;
  aspectRatio: '16:9' | '4:3';
  detailLevel: 'concise' | 'balanced' | 'detailed';
  includeSpeakerNotes: boolean;
  modelProvider: 'mimo' | 'kimi';
  generationMode?: 'template' | 'web';
  customStyle?: string;
  learningGoalId?: string;
  generationContext?: Record<string, unknown>;
}

export interface PresentationTask {
  id: string;
  status: 'queued' | 'analyzing' | 'outline_review' | 'generating' | 'reviewing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  stageMessage: string;
  title: string;
  outline?: { title?: string; subtitle?: string; slides?: Array<{ title?: string; kind?: string; points?: string[]; speakerNotes?: string }> } | null;
  events?: Record<string, unknown>[];
  errorMessage?: string | null;
  downloadUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PresentationTaskSummary {
  id: string;
  status: PresentationTask['status'];
  progress: number;
  stageMessage: string;
  title: string;
  errorMessage?: string | null;
  learned?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PresentationSlideshow {
  slideCount: number;
  imageUrl: string;
  audioUrl: string;
  speakerNotes: string[];
  audioAvailable: boolean[];
  teachingMoments: PresentationTeachingMoment[][];
}

export type PresentationTeachingMoment = {
  momentId: string;
  type: 'quiz' | 'summary';
  anchorText: string;
  anchorChar: number;
  anchorRatio: number;
  title: string;
  prompt?: string;
  options?: string[];
  answerIndex?: number;
  explanation?: string;
  points?: string[];
  notePrompt?: string;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let message = `请求失败 (${res.status})`;
    try {
      const parsed = (await res.json()) as { detail?: string; message?: string };
      message = parsed.detail ?? parsed.message ?? message;
    } catch {
      /* keep status */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const presentationApi = {
  createPresentation: (body: PresentationRequest) =>
    request<PresentationTask>('/v1/presentations', { method: 'POST', body: JSON.stringify(body) }),
  getPresentation: (taskId: string) =>
    request<PresentationTask>(`/v1/presentations/${encodeURIComponent(taskId)}`),
  listPresentationSummaries: (limit = 20, excludeCourse = false) =>
    request<{ tasks: PresentationTaskSummary[] }>(
      `/v1/presentations?summary=true&limit=${encodeURIComponent(limit)}${excludeCourse ? '&exclude_course=true' : ''}`,
    ),
  completePresentation: (taskId: string) =>
    request<{ learned: boolean }>(`/v1/presentations/${encodeURIComponent(taskId)}/complete`, { method: 'POST' }),
  startPresentationGeneration: (taskId: string) =>
    request<PresentationTask>(`/v1/presentations/${encodeURIComponent(taskId)}/generate`, { method: 'POST' }),
  getSlideshowSlides: (taskId: string) =>
    request<PresentationSlideshow>(`/v1/presentations/${encodeURIComponent(taskId)}/slides`),
};

export function slideImageUrl(taskId: string, index: number): string {
  return `/v1/presentations/${encodeURIComponent(taskId)}/slides/${index}`;
}

export function slideAudioUrl(taskId: string, index: number): string {
  return `/v1/presentations/${encodeURIComponent(taskId)}/audio/${index}`;
}

export async function fetchSlideAsset(taskId: string, index: number, kind: 'slides' | 'audio'): Promise<Blob> {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(`/v1/presentations/${encodeURIComponent(taskId)}/${kind}/${index}`, { headers });
  if (!res.ok) throw new Error(`PPT 资源加载失败 (${res.status})`);
  if (res.status === 401) throw new Error('登录状态已失效，请重新登录后重试');
  return res.blob();
}


export type PresentationAudioEvent = {
  type: 'control' | 'reply_delta' | 'result' | 'error';
  content?: string;
  transcript?: string;
  action?: 'none' | 'play' | 'pause' | 'next' | 'previous' | 'restart' | 'goto';
  page?: number | null;
  resume?: boolean;
  sessionId?: string | null;
  message?: string;
};

export type PresentationChatEvent = {
  type: 'phase' | 'chat_delta' | 'chat_reasoning_delta' | 'chat_completed' | 'chat_failed' | 'refused';
  content?: string;
  message?: string;
  banner?: string;
  code?: string;
};

export interface PresentationChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PresentationChatSession {
  id: string;
  taskId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface PresentationChatHistoryMessage extends PresentationChatMessage {
  id: string;
  seq: number;
  inputType: 'text' | 'voice';
  createdAt: string;
}

export const createPresentationChatSession = (taskId: string) =>
  request<PresentationChatSession>(`/v1/presentations/${encodeURIComponent(taskId)}/chat/sessions`, { method: 'POST' });

export const listPresentationChatSessions = (taskId: string) =>
  request<PresentationChatSession[]>(`/v1/presentations/${encodeURIComponent(taskId)}/chat/sessions`);

export const getPresentationChatMessages = (taskId: string, sessionId: string) =>
  request<PresentationChatHistoryMessage[]>(
    `/v1/presentations/${encodeURIComponent(taskId)}/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
  );

async function readSse(response: Response, onData: (payload: Record<string, unknown>) => void): Promise<void> {
  if (!response.body) throw new Error('浏览器没有收到流式响应');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      const line = block.split(/\r?\n/).find((item) => item.startsWith('data:'));
      if (line) onData(JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
    }
  }
}

export async function streamPresentationChatText(
  taskId: string,
  messages: PresentationChatMessage[],
  slideIndex: number,
  sessionId: string,
  onEvent: (event: PresentationChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' });
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`/v1/presentations/${encodeURIComponent(taskId)}/chat/stream`, {
    method: 'POST', headers, signal,
    body: JSON.stringify({ messages, slideIndex, sessionId, modelProvider: 'mimo' }),
  });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  await readSse(response, (payload) => onEvent(payload as PresentationChatEvent));
}

export async function streamPresentationChatTts(
  taskId: string,
  text: string,
  voice?: string,
  speed?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'audio/L16' });
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`/v1/presentations/${encodeURIComponent(taskId)}/chat/tts`, {
    method: 'POST', headers, signal, body: JSON.stringify({ text, voice, speed }),
  });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  if (!response.body) throw new Error('浏览器没有收到语音流');
  return response;
}

export function draftPresentationNote(taskId: string, slideIndex: number, instruction: string, currentDraft = '') {
  return request<{ title: string; content: string; sourceType: string; sourceRef: string; sourceContext: string }>(
    `/v1/presentations/${encodeURIComponent(taskId)}/notes/draft`,
    { method: 'POST', body: JSON.stringify({ slideIndex, instruction, currentDraft }) },
  );
}

export async function streamPresentationChatAudio(
  taskId: string,
  audio: Blob,
  slideIndex: number,
  sessionId: string,
  onEvent: (event: PresentationAudioEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append('audio', audio, 'presentation-question.wav');
  form.append('slide_index', String(slideIndex));
  form.append('session_id', sessionId);
  const headers = new Headers({ Accept: 'text/event-stream' });
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`/v1/presentations/${encodeURIComponent(taskId)}/chat/audio-stream`, {
    method: 'POST',
    headers,
    body: form,
    signal,
  });
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
  await readSse(response, (payload) => onEvent(payload as PresentationAudioEvent));
}
