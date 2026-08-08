/**
 * 3 组差异化学习者画像 — 全局 ProfileContext 驱动
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
    role: '机械电子工程 · 应届本科生',
    education: '本科 · 机械电子工程',
    school: '华东理工大学',
    background:
      '理论基础扎实但实操经验几乎为零：课程学过自动控制原理与机器人学导论，D-H 参数能推导却从未进过实训车间。对抽象概念理解快，对设备实操有畏难情绪。',
    targetJob: '机器人系统集成应用工程师',
    learningStyle: ['理论先行', '公式推导偏好', '零基础实操'],
    weeklyHours: 14,
    scores: {
      'kp-plc': 58,
      'kp-kinematics': 64,
      'kp-sensor': 42,
      'kp-vision': 51,
      'kp-safety': 73,
      'kp-diagnosis': 47,
    },
    strengths: ['机器人运动学理论', '安全规范条文', '英文资料阅读'],
    blindSpots: ['传感器标定实操', 'PLC 联锁编程', '故障诊断经验'],
    preferredFormat: '零基础讲义 + 分阶题',
    goal: '3 个月内达到工业机器人运维 1+X 中级考核水平，补齐实操短板。',
    diagnosisSummary:
      'DIA-01 诊断：理论-实操剪刀差显著（运动学 64 / 标定 42）。建议以「传感器标定零基础版」讲义切入，用分阶题巩固运动学优势，PLC 从梯形图联锁案例补起。',
  },
  {
    id: 'chen',
    code: 'chen',
    name: '陈雨桐',
    avatar: '/avatar-chen.png',
    age: 19,
    tag: '高职实训生',
    role: '工业机器人技术 · 高职二年级',
    education: '高职 · 工业机器人技术',
    school: '常州机电职业技术学院',
    background:
      '动手能力突出：实训课上完成过搬运程序示教与简单的 I/O 接线，万用表不离身。但理论体系薄弱，看公式容易发怵，故障排查依赖师傅经验口诀。',
    targetJob: '机器人运维技术员（产线）',
    learningStyle: ['实操驱动', '步骤清单偏好', '图示学习'],
    weeklyHours: 10,
    scores: {
      'kp-plc': 61,
      'kp-kinematics': 45,
      'kp-sensor': 66,
      'kp-vision': 58,
      'kp-safety': 82,
      'kp-diagnosis': 63,
    },
    strengths: ['安全规范执行', '传感器接线实操', '示教器操作'],
    blindSpots: ['运动学坐标变换', '视觉引导原理', '报警代码体系'],
    preferredFormat: '实操指南 + 图文步骤',
    goal: '通过 1+X 初级考核并备战省赛，把「会操作」升级为「懂原理」。',
    diagnosisSummary:
      'DIA-01 诊断：安全意识 82 分全场最佳，但运动学 45 分制约进阶。建议以「六轴臂零点标定五步实操」步骤清单强化优势，用图解式讲义补坐标变换概念。',
  },
  {
    id: 'zhao',
    code: 'zhao',
    name: '赵鸿',
    avatar: '/avatar-zhao.png',
    age: 38,
    tag: '转岗工程师',
    role: '传统产线设备主管 · 转岗',
    education: '大专 · 电气自动化（2009 届）',
    school: '苏州工业园区职业技术学院',
    background:
      '15 年传统产线维护经验：PLC 编程与电气故障诊断是看家本领，但机器人是转岗新领域。学习目的明确、时间碎片化，偏好「对照已有经验迁移」的讲法。',
    targetJob: '智能产线运维工程师',
    learningStyle: ['经验迁移', '案例对照', '碎片化学习'],
    weeklyHours: 6,
    scores: {
      'kp-plc': 88,
      'kp-kinematics': 52,
      'kp-sensor': 71,
      'kp-vision': 44,
      'kp-safety': 85,
      'kp-diagnosis': 79,
    },
    strengths: ['PLC 联锁与通讯', '电气故障诊断', '安全管理体系'],
    blindSpots: ['视觉引导系统', '机器人运动学', '手眼标定流程'],
    preferredFormat: '进阶讲义 + 案例对照',
    goal: '6 个月内独立完成焊接机器人工作站的日常运维与标定，带 2 人小组。',
    diagnosisSummary:
      'DIA-01 诊断：PLC 88 分可直接豁免基础课。短板集中在视觉引导 44 分，建议以「手眼标定案例对照」进阶讲义切入，复用其电气诊断经验做故障树迁移。',
  },
];

export const getLearner = (id: string): Learner =>
  learners.find((l) => l.id === id) ?? learners[0];

/** 最薄弱知识点 id */
export const weakestKpOf = (learner: Learner): string =>
  Object.entries(learner.scores).sort((a, b) => a[1] - b[1])[0][0];

/** 最强知识点 id */
export const strongestKpOf = (learner: Learner): string =>
  Object.entries(learner.scores).sort((a, b) => b[1] - a[1])[0][0];
