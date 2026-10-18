/**
 * LLM 适配层 · 规则引擎实现（离线降级，默认走这条）
 *
 * 把现有确定性纯函数包装成 LLM 接口的默认实现：
 *   generateUnit → courseware.buildUnit
 *   answerQuestion → courseware.matchQA（命中预置 QA，否则兜底）
 *   verifyUnit → verify.validateUnit
 * 无网络、无外部模型，确定性可复现——评测与单测都跑在这条实现上。
 */
import type { Learner } from '@/data/learners';
import type { StyleLabel } from '@/data/courseware';
import { buildUnit, matchQA, fallbackAnswer } from '@/data/courseware';
import { validateUnit } from '@/agent/verify';
import type { RetrievalHit } from '@/agent/retriever';
import type { GenerationService, TutorService, VerifyService, TutorAnswer } from './types';

export const ruleGeneration: GenerationService = {
  mode: 'rule',
  async generateUnit(kpId: string, learner: Learner, styleOverride?: StyleLabel) {
    return buildUnit(kpId, learner, styleOverride);
  },
};

export const ruleTutor: TutorService = {
  mode: 'rule',
  async answerQuestion(kpId: string, question: string): Promise<TutorAnswer> {
    const qa = matchQA(kpId, question);
    if (qa) return { answer: qa.a, kbRef: qa.kbRef, grounded: true };
    return { answer: fallbackAnswer, grounded: false };
  },
};

export const ruleVerify: VerifyService = {
  mode: 'rule',
  async verifyUnit(unit, grounded?: RetrievalHit[]) {
    return validateUnit(unit, grounded);
  },
};
