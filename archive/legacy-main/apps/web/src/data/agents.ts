/**
 * 5 个多智能体定义 — 全站统一代号 / 色值 / 图标
 * 色值见 design.md §4.1 Agent 专属色
 */

export type AgentId = 'DIA-01' | 'RET-02' | 'GEN-03' | 'VER-04' | 'ARB-05';

export interface AgentDef {
  id: AgentId;
  code: AgentId;
  name: string;
  en: string;
  duty: string;
  detail: string;
  color: string;
  /** lucide 图标名（在组件内映射） */
  icon: 'Brain' | 'Database' | 'PenLine' | 'ShieldCheck' | 'Scale';
  todayCount: number;
  avgLatency: string;
}

export const agents: AgentDef[] = [
  {
    id: 'DIA-01',
    code: 'DIA-01',
    name: '学情诊断 Agent',
    en: 'DIAGNOSIS',
    duty: '锚定理论强项与技能盲区，输出画像向量',
    detail:
      '整合学历背景、理论测试 6 维成绩与交互行为，构建六维画像向量；定位知识盲区并给出学习路径建议，是个性化流程的起点。',
    color: '#4E7860',
    icon: 'Brain',
    todayCount: 12,
    avgLatency: '0.6s',
  },
  {
    id: 'RET-02',
    code: 'RET-02',
    name: '知识检索 Agent',
    en: 'RETRIEVAL',
    duty: '命中领域知识切片，锁定权威出处与依据',
    detail:
      '在领域知识库中执行语义 + 标准号混合检索，优先命中国标/行标切片，为生成提供可溯源的事实依据，附可信度评分。',
    color: '#B77552',
    icon: 'Database',
    todayCount: 9,
    avgLatency: '0.4s',
  },
  {
    id: 'GEN-03',
    code: 'GEN-03',
    name: '内容生成 Agent',
    en: 'GENERATION',
    duty: '约束生成三种形态资源，强制逐条溯源',
    detail:
      '依据画像向量与检索切片进行约束生成：定制讲义 / 实操指南 / 分阶题目三种形态，每个论断强制挂接 KB 溯源角标，未过审不发布。',
    color: '#E7B45A',
    icon: 'PenLine',
    todayCount: 11,
    avgLatency: '1.8s',
  },
  {
    id: 'VER-04',
    code: 'VER-04',
    name: '审核裁判 Agent',
    en: 'VERIFICATION',
    duty: '交叉验证事实与引用，幻觉一票否决',
    detail:
      '对生成草稿逐句交叉验证：参数对照标准原文、引用核对 KB 切片、逻辑一致性检查。发现无出处内容直接拦截并退回修订，拥有一票否决权。',
    color: '#B0483B',
    icon: 'ShieldCheck',
    todayCount: 10,
    avgLatency: '0.9s',
  },
  {
    id: 'ARB-05',
    code: 'ARB-05',
    name: '决策仲裁 Agent',
    en: 'ARBITRATION',
    duty: '汇聚分歧、裁定采纳、调度降维与进阶',
    detail:
      '汇聚生成与审核的分歧意见，按置信度裁定采纳版本；根据学习交互反馈动态下发「降维解释」或「进阶挑战」决策，并回写画像。',
    color: '#5A6553',
    icon: 'Scale',
    todayCount: 5,
    avgLatency: '0.5s',
  },
];

export const getAgent = (id: AgentId): AgentDef =>
  agents.find((a) => a.id === id) ?? agents[0];

export const agentColorMap: Record<AgentId, string> = Object.fromEntries(
  agents.map((a) => [a.id, a.color]),
) as Record<AgentId, string>;
