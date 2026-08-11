/** 通用六维能力：只用于画像评估与展示，不替代知识地图章节。 */
export const ABILITY_DIMENSION_NAMES: Record<string, string> = {
  'kp-ds': '知识理解',
  'kp-co': '逻辑推理',
  'kp-os': '工程实践',
  'kp-network': '问题诊断',
  'kp-db': '系统设计',
  'kp-agent': '学习迁移',
};

export const ABILITY_SELF_PROMPTS: Record<string, string> = {
  'kp-ds': '面对数据结构、网络、数据库或 AI 等专业概念，我能理解术语，并准确解释它们解决的问题。',
  'kp-co': '面对一段代码、规则或技术方案，我能梳理条件关系，推导运行结果并发现逻辑矛盾。',
  'kp-os': '面对明确的开发任务，我能使用工具完成编码、调试、测试和交付。',
  'kp-network': '系统出现报错、性能下降或结果异常时，我能根据现象和证据逐步定位原因。',
  'kp-db': '面对包含接口、数据、并发和可靠性要求的需求，我能做出合理的系统拆分与技术取舍。',
  'kp-agent': '接触陌生技术或新场景时，我能借助文档和实验迁移已有知识，较快形成可用方案。',
};

export const abilityName = (id: string, fallback = '综合能力') =>
  ABILITY_DIMENSION_NAMES[id] ?? fallback;

const TARGET_ABILITY_PRIORITY: Record<string, string[]> = {
  Agent工程师: ['kp-os', 'kp-agent', 'kp-co', 'kp-network', 'kp-db', 'kp-ds'],
  RAG应用工程师: ['kp-ds', 'kp-db', 'kp-network', 'kp-os', 'kp-co', 'kp-agent'],
  多智能体开发工程师: ['kp-co', 'kp-db', 'kp-network', 'kp-os', 'kp-agent', 'kp-ds'],
  Agent平台工程师: ['kp-db', 'kp-network', 'kp-os', 'kp-co', 'kp-ds', 'kp-agent'],
};

export const abilityOrderForTarget = (targetJob: string) =>
  TARGET_ABILITY_PRIORITY[targetJob] ?? TARGET_ABILITY_PRIORITY.Agent工程师;
