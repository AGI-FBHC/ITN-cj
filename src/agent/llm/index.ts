/**
 * LLM 适配层 · 入口与降级开关
 *
 * VITE_LLM_MODE=rule（默认）→ 规则引擎（离线、确定性、可复现）
 * VITE_LLM_MODE=api          → 后端真大模型（失败自动回退规则引擎，见 apiEngine.ts）
 *
 * 用法：
 *   import { getAgentServices } from '@/agent/llm';
 *   const { generation, verify, tutor, mode } = getAgentServices();
 *   const unit = await generation.generateUnit(kpId, learner);
 */
import type { AgentServices, LlmMode } from './types';
import { ruleGeneration, ruleTutor, ruleVerify } from './ruleEngine';
import { apiGeneration, apiTutor, apiVerify } from './apiEngine';

export * from './types';

export function resolveLlmMode(): LlmMode {
  const raw = (import.meta.env.VITE_LLM_MODE as string | undefined)?.toLowerCase();
  return raw === 'api' ? 'api' : 'rule';
}

let cached: AgentServices | null = null;

export function getAgentServices(): AgentServices {
  if (cached) return cached;
  const mode = resolveLlmMode();
  cached = mode === 'api'
    ? { mode, generation: apiGeneration, tutor: apiTutor, verify: apiVerify }
    : { mode, generation: ruleGeneration, tutor: ruleTutor, verify: ruleVerify };
  return cached;
}

/** 当前是否走真大模型（供 UI 显示"规则引擎/大模型"标识） */
export function isLlmApiMode(): boolean {
  return resolveLlmMode() === 'api';
}
