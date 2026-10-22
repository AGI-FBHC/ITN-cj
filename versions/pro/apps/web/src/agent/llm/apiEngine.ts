/**
 * LLM 适配层 · 后端 API 实现（真大模型调用留后端接）
 *
 * 约定：后端暴露以下端点（返回体与前端类型一致，前端只做透传与降级）：
 *   POST {BASE}/generate  { kpId, learner, styleOverride? }        → CourseUnit
 *   POST {BASE}/tutor     { kpId, question }                        → TutorAnswer
 *   POST {BASE}/verify    { unit, groundedSliceIds }               → VerifyResult
 *
 * BASE 由 VITE_LLM_API_BASE 指定。任一步骤失败（未配置/网络错/非 2xx）→ 记一条 warning
 * 并回退到规则引擎实现，保证演示不因后端缺席而中断（"降级开关"的兜底语义）。
 */
import type { Learner } from '@/data/learners';
import type { StyleLabel } from '@/data/courseware';
import type { RetrievalHit } from '@/agent/retriever';
import type { GenerationService, TutorService, VerifyService, TutorAnswer } from './types';
import { ruleGeneration, ruleTutor, ruleVerify } from './ruleEngine';

const BASE = (import.meta.env.VITE_LLM_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

async function post<T>(path: string, body: unknown): Promise<T> {
  if (!BASE) throw new Error('VITE_LLM_API_BASE 未配置');
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

function warnFallback(path: string, e: unknown) {
  console.warn(`[llm:api] ${path} 调用失败，已回退规则引擎：`, e);
}

export const apiGeneration: GenerationService = {
  mode: 'api',
  async generateUnit(kpId: string, learner: Learner, styleOverride?: StyleLabel) {
    try {
      return await post('/generate', { kpId, learner, styleOverride });
    } catch (e) {
      warnFallback('/generate', e);
      return ruleGeneration.generateUnit(kpId, learner, styleOverride);
    }
  },
};

export const apiTutor: TutorService = {
  mode: 'api',
  async answerQuestion(kpId: string, question: string): Promise<TutorAnswer> {
    try {
      return await post('/tutor', { kpId, question });
    } catch (e) {
      warnFallback('/tutor', e);
      return ruleTutor.answerQuestion(kpId, question);
    }
  },
};

export const apiVerify: VerifyService = {
  mode: 'api',
  async verifyUnit(unit, grounded?: RetrievalHit[]) {
    try {
      return await post('/verify', {
        unit,
        groundedSliceIds: grounded?.map((h) => h.sliceId) ?? [],
      });
    } catch (e) {
      warnFallback('/verify', e);
      return ruleVerify.verifyUnit(unit, grounded);
    }
  },
};
