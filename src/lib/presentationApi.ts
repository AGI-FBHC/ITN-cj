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
  createdAt: string;
  updatedAt: string;
}

export interface PresentationSlideshow {
  slideCount: number;
  imageUrl: string;
  audioUrl: string;
  speakerNotes: string[];
  audioAvailable: boolean[];
}

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
  getSlideshowSlides: (taskId: string) =>
    request<PresentationSlideshow>(`/v1/presentations/${encodeURIComponent(taskId)}/slides`),
};

export function slideImageUrl(taskId: string, index: number): string {
  return `/v1/presentations/${encodeURIComponent(taskId)}/slides/${index}`;
}

export function slideAudioUrl(taskId: string, index: number): string {
  return `/v1/presentations/${encodeURIComponent(taskId)}/audio/${index}`;
}
