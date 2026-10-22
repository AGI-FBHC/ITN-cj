/**
 * 4 组差异化学习者画像 — 全局 ProfileContext 驱动
 * 分数为理论测试 6 维成绩 (0-100)，与 knowledgePoints.id 一一对应
 */

export interface Learner {
  id: string;
  /** 后端 learner code，演示画像为 lin/chen/zhao */
  code?: string;
  name: string;
  avatar: string;
  age: number;
  /** 用户自建画像（向导生成，存后端） */
  custom?: boolean;
  /** 自建画像借用哪个预设的富内容（报告/资源/导学静态数据） */
  dataBaseId?: string;
  /** 画像类型标签 */
  tag: string;
  role: string;
  education: string;
  school: string;
  background: string;
  targetJob: string;
  learningStyle: string[];
  weeklyHours: number;
  /** 理论测试 6 维成绩 */
  scores: Record<string, number>;
  strengths: string[];
  blindSpots: string[];
  /** 推荐资源形态侧重 */
  preferredFormat: string;
  goal: string;
  /** 画像摘要（用于诊断 Agent 输出） */
  diagnosisSummary: string;
  /** 建档方式与置信度，null 表示预设画像或未建档 */
  confidence?: { method: 'quick' | 'full'; value: number };
}

export const learners: Learner[] = [
  {
    id: 'lin',
    code: 'lin',
    name: '林晓舟',
    avatar: '/avatar-lin.png',
    age: 22,
    tag: '本科应届生',
    role: '智能体方向 · 应届本科生',
    education: '本科 · 人工智能',
    school: '华东理工大学',
    background: '理论基础扎实但项目经验几乎为零：熟悉 Agent、LLM 与 RAG 等概念，能梳理概念与流程，但尚未独立完成过智能体应用。',
    targetJob: 'Agent工程师',
    learningStyle: ['理论先行', '概念梳理偏好', '零基础实操'],
    weeklyHours: 14,
    scores: {
      'kp-ds': 64,
      'kp-co': 50,
      'kp-os': 56,
      'kp-network': 52,
      'kp-db': 48,
      'kp-agent': 38,
    },
    strengths: ['知识理解', '概念推理', '英文资料阅读'],
    blindSpots: ['Agent 工具调用', 'RAG 检索诊断', '工程实践'],
    preferredFormat: '零基础讲义 + 分阶题',
    goal: '3 个月内掌握 Agent 核心概念，并能独立完成一次带检索与工具调用的智能体应用。',
    diagnosisSummary:
      'DIA-01 诊断：知识理解较强（64），但工程实践与工具调用较弱（48/38）。建议从「Agent 工具调用零基础版」实操切入。',
  },
  {
    id: 'chen',
    code: 'chen',
    name: '陈雨桐',
    avatar: '/avatar-chen.png',
    age: 19,
    tag: '高职实训生',
    role: 'Agent 应用开发 · 高职二年级',
    education: '高职 · 人工智能技术应用',
    school: '常州机电职业技术学院',
    background: '动手能力强，用过 Python 写简单脚本，了解 LLM 基本概念，但对 Agent 流程、RAG 检索和系统设计掌握较浅。',
    targetJob: 'RAG应用工程师',
    learningStyle: ['实操驱动', '步骤清单偏好', '图示学习'],
    weeklyHours: 10,
    scores: {
      'kp-ds': 40,
      'kp-co': 35,
      'kp-os': 38,
      'kp-network': 55,
      'kp-db': 42,
      'kp-agent': 65,
    },
    strengths: ['智能体与 LLM', '动手实操', '快速试错'],
    blindSpots: ['Agent 流程推理', '上下文工程', '系统设计'],
    preferredFormat: '实操指南 + 图文步骤',
    goal: '补齐 RAG 评估、多智能体协作和工程化方法，能独立完成一个可交付的 RAG 应用。',
    diagnosisSummary:
      'DIA-01 诊断：智能体应用方向 65 分较强，但流程推理与系统设计较弱（35/42）。建议从 RAG 流程推理实操切入。',
  },
  {
    id: 'zhao',
    code: 'zhao',
    name: '赵鸿',
    avatar: '/avatar-zhao.png',
    age: 38,
    tag: '转岗工程师',
    role: 'IT 运维 · 转岗 Agent 工程师',
    education: '大专 · 计算机应用',
    school: '南京工业职业技术大学',
    background: '15 年 IT 运维经验，熟悉系统与服务排查，能读 Python 代码，但对 Agent、LLM 编排和 RAG 缺少系统训练。',
    targetJob: 'Agent平台工程师',
    learningStyle: ['经验迁移', '案例对照', '碎片化学习'],
    weeklyHours: 6,
    scores: {
      'kp-ds': 32,
      'kp-co': 45,
      'kp-os': 58,
      'kp-network': 88,
      'kp-db': 52,
      'kp-agent': 28,
    },
    strengths: ['问题诊断', '系统设计', '工程实践'],
    blindSpots: ['Agent 基础概念', '工具调用', '学习迁移'],
    preferredFormat: '进阶讲义 + 案例对照',
    goal: '6 个月内完成从运维到 Agent 平台工程的迁移，能独立搭建、调试并交付多智能体应用。',
    diagnosisSummary:
      'DIA-01 诊断：问题诊断 88 分可直接迁移到 Agent 调试。短板集中在 Agent 基础概念 32 分与工具调用 28 分。',
  },
];

export const getLearner = (id: string): Learner =>
  learners.find((l) => l.id === id) ?? learners[0];

/** 最薄弱知识点 id */
export const weakestKpOf = (learner: Learner): string =>
  Object.entries(learner.scores).sort((a, b) => a[1] - b[1])[0]?.[0] ?? 'kp-ds';

/** 最强知识点 id */
export const strongestKpOf = (learner: Learner): string =>
  Object.entries(learner.scores).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'kp-ds';
