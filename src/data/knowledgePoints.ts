/**
 * 六大核心知识点 — 计算机与智能体方向
 * 对齐知识库实际方向：数据结构、组成原理、操作系统、网络、数据库、智能体
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
    name: '数据结构与算法',
    en: 'DATA STRUCTURES AND ALGORITHMS',
    weight: 0.18,
    targetLevel: 80,
    coverage: 92,
    description: '线性表、栈、队列、树、图、排序、查找与算法分析。',
    coreTopics: ['线性表与链表', '栈与队列', '树与图', '排序与查找', '复杂度分析'],
  },
  {
    id: 'kp-co',
    name: '计算机组成原理',
    en: 'COMPUTER ORGANIZATION',
    weight: 0.2,
    targetLevel: 82,
    coverage: 88,
    description: '冯诺依曼体系、CPU、存储层次、指令系统与输入输出。',
    coreTopics: ['冯诺依曼体系', 'CPU 组成与指令周期', '存储层次与 Cache', '总线与 I/O'],
  },
  {
    id: 'kp-os',
    name: '操作系统',
    en: 'OPERATING SYSTEMS',
    weight: 0.17,
    targetLevel: 85,
    coverage: 95,
    description: '进程、内存、文件系统、设备管理与操作系统调度。',
    coreTopics: ['进程与线程', '内存管理', '文件系统', '设备管理与调度'],
  },
  {
    id: 'kp-network',
    name: '计算机网络',
    en: 'COMPUTER NETWORKS',
    weight: 0.15,
    targetLevel: 78,
    coverage: 90,
    description: 'TCP/IP、HTTP、网络安全与网络编程基础。',
    coreTopics: ['网络分层模型', 'TCP/IP 协议', 'HTTP/HTTPS', '网络编程与安全'],
  },
  {
    id: 'kp-db',
    name: '数据库',
    en: 'DATABASE SYSTEMS',
    weight: 0.16,
    targetLevel: 90,
    coverage: 96,
    description: '关系模型、SQL、索引、事务、锁与数据库设计。',
    coreTopics: ['关系模型与 SQL', '索引与 B+ 树', '事务与 MVCC', '锁与并发控制'],
  },
  {
    id: 'kp-agent',
    name: '智能体与大模型',
    en: 'AI AGENTS AND LLMS',
    weight: 0.14,
    targetLevel: 80,
    coverage: 89,
    description: '智能体范式、LLM、RAG、上下文工程与多智能体应用。',
    coreTopics: ['智能体范式', '大语言模型基础', 'RAG 与记忆', '多智能体与工具调用'],
  },
];

export const getKnowledgePoint = (id: string): KnowledgePoint =>
  knowledgePoints.find((k) => k.id === id) ?? knowledgePoints[0];
