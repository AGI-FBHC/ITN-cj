/**
 * 六大核心能力 — 面向智能体与大模型方向
 * 对齐当前知识网络：智能体范式、LLM、RAG、上下文工程与多智能体应用
 */

export interface KnowledgePoint {
  id: string;
  name: string;
  en: string;
  /** L1 大分类名称（如"概念与基础"） */
  parentName?: string;
  /** 目标能力模型权重 (0-1) */
  weight: number;
  /** 目标掌握水平 (0-100) */
  targetLevel: number;
  /** 当前全站资源覆盖率 (%) — 见总览 S5 */
  coverage: number;
  description: string;
  coreTopics: string[];
}

export const knowledgePoints: KnowledgePoint[] = [
  {
    id: 'kp-ds',
    name: '知识理解',
    en: 'KNOWLEDGE COMPREHENSION',
    weight: 0.18,
    targetLevel: 80,
    coverage: 92,
    description: '理解智能体与大模型的核心概念，能解释术语、原理与设计动机。',
    coreTopics: ['智能体范式', 'LLM 基础', '提示工程', '上下文工程'],
  },
  {
    id: 'kp-co',
    name: '逻辑推理',
    en: 'LOGICAL REASONING',
    weight: 0.2,
    targetLevel: 82,
    coverage: 88,
    description: '面对智能体流程、工具调用与多智能体协作，能梳理条件关系并推导结果。',
    coreTopics: ['流程编排', '工具调用推理', '多智能体协作', '异常分支判断'],
  },
  {
    id: 'kp-os',
    name: '工程实践',
    en: 'ENGINEERING PRACTICE',
    weight: 0.17,
    targetLevel: 85,
    coverage: 95,
    description: '能使用平台与工具完成智能体开发、调试、测试与交付。',
    coreTopics: ['低代码搭建', '框架应用', '调试与测试', '部署与交付'],
  },
  {
    id: 'kp-network',
    name: '问题诊断',
    en: 'PROBLEM DIAGNOSIS',
    weight: 0.15,
    targetLevel: 78,
    coverage: 90,
    description: '智能体结果异常、检索失败或性能下降时，能定位原因并修复。',
    coreTopics: ['RAG 检索诊断', '上下文问题定位', '性能排查', '结果归因'],
  },
  {
    id: 'kp-db',
    name: '系统设计',
    en: 'SYSTEM DESIGN',
    weight: 0.16,
    targetLevel: 90,
    coverage: 96,
    description: '面对记忆、数据、并发与可靠性需求，能做系统拆分与技术选型。',
    coreTopics: ['记忆设计', '知识库结构', '接口设计', '可靠性设计'],
  },
  {
    id: 'kp-agent',
    name: '学习迁移',
    en: 'LEARNING TRANSFER',
    weight: 0.14,
    targetLevel: 80,
    coverage: 89,
    description: '接触新智能体场景时，能迁移已有经验并较快形成可用方案。',
    coreTopics: ['跨场景迁移', '新工具上手', '方案落地', '持续学习'],
  },
];

export const getKnowledgePoint = (id: string): KnowledgePoint =>
  knowledgePoints.find((k) => k.id === id) ?? knowledgePoints[0];
