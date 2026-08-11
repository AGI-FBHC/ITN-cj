/** 通用六维能力：只用于画像评估与展示，不替代知识地图章节。 */
export const ABILITY_DIMENSION_NAMES: Record<string, string> = {
  'kp-ds': '基础认知',
  'kp-co': '逻辑分析',
  'kp-os': '实践操作',
  'kp-network': '问题诊断',
  'kp-db': '系统设计',
  'kp-agent': '学习迁移',
};

export const abilityName = (id: string, fallback = '综合能力') =>
  ABILITY_DIMENSION_NAMES[id] ?? fallback;
