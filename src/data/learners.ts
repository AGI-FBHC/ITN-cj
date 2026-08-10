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
    role: '计算机科学 · 应届本科生',
    education: '本科 · 计算机科学与技术',
    school: '华东理工大学',
    background: '理论基础扎实但项目经验几乎为零：课程学过数据结构、算法设计与操作系统，能推导链表、树、图复杂度，但从未参与过完整工程项目。',
    targetJob: '后端开发工程师',
    learningStyle: ['理论先行', '公式推导偏好', '零基础实操'],
    weeklyHours: 14,
    scores: {
      'kp-ds': 64,
      'kp-co': 50,
      'kp-os': 56,
      'kp-network': 52,
      'kp-db': 48,
      'kp-agent': 38,
    },
    strengths: ['数据结构与算法', '算法分析', '英文资料阅读'],
    blindSpots: ['数据库设计', '计算机网络', '智能体开发'],
    preferredFormat: '零基础讲义 + 分阶题',
    goal: '3 个月内达到后端开发岗位基础要求，夯实数据库与网络知识。',
    diagnosisSummary:
      'DIA-01 诊断：数据结构与算法较强（64），但数据库与智能体较弱（48/38）。建议以「数据库零基础版」讲义切入。',
  },
  {
    id: 'chen',
    code: 'chen',
    name: '陈雨桐',
    avatar: '/avatar-chen.png',
    age: 19,
    tag: '高职实训生',
    role: '智能体开发 · 高职二年级',
    education: '高职 · 人工智能技术应用',
    school: '常州机电职业技术学院',
    background: '动手能力强，用过 Python 写简单脚本，了解 LLM 基本概念，但对数据结构、操作系统等基础课程掌握较浅。',
    targetJob: 'AI 应用开发工程师',
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
    strengths: ['智能体与 LLM', '网络基础', '动手实操'],
    blindSpots: ['计算机组成原理', '数据结构', '操作系统'],
    preferredFormat: '实操指南 + 图文步骤',
    goal: '通过 1+X 初级考核，把「会用 AI」升级为「懂底层」。',
    diagnosisSummary:
      'DIA-01 诊断：智能体方向 65 分较强，但组成原理 35 分严重制约进阶。建议从计算机组成原理零基础讲义切入。',
  },
  {
    id: 'zhao',
    code: 'zhao',
    name: '赵鸿',
    avatar: '/avatar-zhao.png',
    age: 38,
    tag: '转岗工程师',
    role: '传统 IT 运维 · 转岗',
    education: '大专 · 计算机网络技术（2009 届）',
    school: '南京工业职业技术大学',
    background: '15 年 IT 运维经验，熟悉网络和设备管理，能读 Python 代码但不会写算法，缺少现代软件开发经验。',
    targetJob: '全栈开发工程师',
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
    strengths: ['计算机网络', '操作系统', '数据库'],
    blindSpots: ['数据结构', '智能体与大模型', '算法设计'],
    preferredFormat: '进阶讲义 + 案例对照',
    goal: '6 个月内独立完成服务端与前端开发任务，能够使用 LLM 辅助编程。',
    diagnosisSummary:
      'DIA-01 诊断：网络 88 分可直接跳过基础课。短板集中在数据结构 32 分与智能体 28 分。',
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
