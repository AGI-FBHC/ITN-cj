/**
 * 六维能力动态调整（学习证据加权）
 *
 * 设计：
 * - 六维能力（kp-ds 知识理解 / kp-co 逻辑推理 / kp-os 工程实践 / kp-network 问题诊断 /
 *   kp-db 系统设计 / kp-agent 学习迁移）的基础值来自画像建档（onboarding/后端画像）。
 * - 当前知识网络每一章按内容映射到 1~2 个能力维度并给出权重（单章权重合计为 1）；
 *   章节内知识点全部按维度权重贡献到对应能力。
 * - 每个知识点：progress = 学习进度（四类资源完成度），mastery = 已完成进度上的掌握度；
 *   有效掌握度 = progress × mastery —— 未学完的知识点只按已完成进度折算，
 *   既不会因为没学完就清零，也不会把未完成部分当成已掌握。
 * - 章节证据 = 章内知识点有效掌握度均值；维度证据 = Σ(章节权重 × 章节证据)。
 * - 能力值 = clamp(基础值 + 维度证据 × 50, 12, 96)：学习越充分、掌握越好，能力越高，
 *   最高上浮 50 分；只读展示，不再由用户手动拖动。
 */
import type { LearningMapView } from '@/hooks/useLearningMap';

export const ABILITY_DIMENSIONS = ['kp-ds', 'kp-co', 'kp-os', 'kp-network', 'kp-db', 'kp-agent'] as const;
export type AbilityDimension = (typeof ABILITY_DIMENSIONS)[number];

export const CHAPTER_ABILITY_WEIGHTS: Record<string, Partial<Record<AbilityDimension, number>>> = {
  'ch1-intro': { 'kp-agent': 0.6, 'kp-ds': 0.4 },
  'ch2-history': { 'kp-ds': 0.6, 'kp-agent': 0.4 },
  'ch3-llm': { 'kp-ds': 0.7, 'kp-co': 0.3 },
  'ch4-paradigms': { 'kp-co': 0.6, 'kp-os': 0.4 },
  'ch5-lowcode': { 'kp-os': 0.7, 'kp-db': 0.3 },
  'ch6-frameworks': { 'kp-os': 0.6, 'kp-db': 0.4 },
  'ch7-helloagents': { 'kp-os': 0.8, 'kp-co': 0.2 },
  'ch8-memory-rag': { 'kp-ds': 0.5, 'kp-network': 0.5 },
  'ch9-context': { 'kp-network': 0.6, 'kp-ds': 0.4 },
  'ch10-protocols': { 'kp-network': 0.6, 'kp-db': 0.4 },
  'ch11-agentic-rl': { 'kp-co': 0.5, 'kp-db': 0.5 },
  'ch12-evaluation': { 'kp-db': 0.5, 'kp-co': 0.5 },
  'ch13-travel': { 'kp-os': 0.5, 'kp-db': 0.5 },
  'ch14-research': { 'kp-network': 0.5, 'kp-ds': 0.5 },
  'ch15-cyber': { 'kp-os': 0.5, 'kp-db': 0.5 },
  'ch16-graduation': { 'kp-db': 0.6, 'kp-os': 0.4 },
};

const clamp = (n: number) => Math.max(12, Math.min(96, Math.round(n)));

export function deriveAbilityScores(
  map: Pick<LearningMapView, 'domains' | 'graphNodes' | 'topicMastery' | 'topicProgress'>,
  baseScores: Record<string, number>,
): Record<string, number> {
  const evidence: Record<AbilityDimension, number> = {
    'kp-ds': 0,
    'kp-co': 0,
    'kp-os': 0,
    'kp-network': 0,
    'kp-db': 0,
    'kp-agent': 0,
  };
  map.domains.forEach((chapter) => {
    const weights = CHAPTER_ABILITY_WEIGHTS[chapter.id];
    if (!weights) return;
    const topics = map.graphNodes.filter((n) => n.kind === 'topic' && n.kpId === chapter.id);
    if (!topics.length) return;
    const effective = topics.reduce((sum, topic) => {
      const progress = (map.topicProgress[topic.id] ?? 0) / 100;
      const mastery = (map.topicMastery[topic.id] ?? 0) / 100;
      return sum + progress * mastery;
    }, 0) / topics.length;
    (Object.keys(weights) as AbilityDimension[]).forEach((dim) => {
      evidence[dim] += (weights[dim] ?? 0) * effective;
    });
  });
  const out: Record<string, number> = {};
  ABILITY_DIMENSIONS.forEach((dim) => {
    const base = baseScores[dim] ?? 50;
    out[dim] = clamp(base + evidence[dim] * 50);
  });
  return out;
}
