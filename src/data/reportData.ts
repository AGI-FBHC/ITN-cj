/**
 * 学情报告数据 — 每画像：盲区排序 / 能力曲线 / 资源难度匹配 / 路径规划
 */

export interface BlindSpot {
  kpId: string;
  score: number;
  target: number;
  gap: number;
  priority: '高' | '中' | '低';
  suggestion: string;
}

export interface AbilityPoint {
  week: string;
  score: number;
}

export interface DifficultyMatchPoint {
  /** 资源难度等级 1-5 */
  difficulty: number;
  /** 适配度 0-100（该画像完成此类资源的后测提升折算） */
  fit: number;
}

export type PathNodeStatus = 'done' | 'active' | 'todo' | 'locked';

export interface PathNode {
  id: string;
  title: string;
  kpId: string;
  status: PathNodeStatus;
  est: string;
  resourceRef?: string;
}

export interface LearnerReport {
  learnerId: string;
  adaptScore: number;
  adaptTrend: number[];
  weeks: string[];
  abilityCurves: { kpId: string; points: number[] }[];
  difficultyMatch: DifficultyMatchPoint[];
  blindSpots: BlindSpot[];
  path: PathNode[];
  summary: string;
  /* ---- 以下字段仅自建画像的现算报告携带（reportBuilder），预设静态报告不填 ---- */
  /** 现算报告标记：ScoreBand/GrowthSection 据此切换真数据展示 */
  generated?: boolean;
  /** Agent 介入点（由写回事件推导，替代静态 W3/W5/W7） */
  interventions?: { week: string; title: string; desc: string; color: string }[];
  /** 建档基线的高优先级盲区数 */
  baselineHighSpots?: number;
  /** 已消解的高优先级盲区数（基线 - 当前） */
  resolvedSpots?: number;
  /** 学习投入估算（小时） */
  investHours?: number;
  investNote?: string;
}

const WEEKS = ['W1','W2','W3','W4','W5','W6','W7','W8'];

export const reportData: LearnerReport[] = [
  {
    learnerId: 'lin',
    adaptScore: 86.2,
    adaptTrend: [58, 63, 69, 74, 78, 82, 85, 86.2],
    weeks: WEEKS,
    abilityCurves: [
      { kpId: 'kp-plc', points: [52, 53, 55, 56, 57, 58, 58, 58] },
      { kpId: 'kp-kinematics', points: [58, 59, 60, 61, 62, 63, 64, 64] },
      { kpId: 'kp-sensor', points: [30, 33, 36, 38, 40, 41, 42, 42] },
      { kpId: 'kp-vision', points: [45, 46, 48, 49, 50, 51, 51, 51] },
      { kpId: 'kp-safety', points: [68, 69, 70, 71, 72, 73, 73, 73] },
      { kpId: 'kp-diagnosis', points: [41, 42, 44, 45, 46, 47, 47, 47] },
    ],
    difficultyMatch: [
      { difficulty: 1, fit: 94 },
      { difficulty: 2, fit: 91 },
      { difficulty: 3, fit: 76 },
      { difficulty: 4, fit: 48 },
      { difficulty: 5, fit: 22 },
    ],
    blindSpots: [
      { kpId: 'kp-sensor', score: 42, target: 85, gap: 43, priority: '高', suggestion: '以《传感器标定精要·零基础版》切入，配合五步实操打卡' },
      { kpId: 'kp-diagnosis', score: 47, target: 80, gap: 33, priority: '高', suggestion: '从报警代码速查与故障树入门，跟随案例学排查链' },
      { kpId: 'kp-vision', score: 51, target: 78, gap: 27, priority: '中', suggestion: '先修视觉定位入门，暂缓手眼标定进阶内容' },
      { kpId: 'kp-plc', score: 58, target: 80, gap: 22, priority: '中', suggestion: '用梯形图联锁案例补课，每周 2 个小程序练习' },
    ],
    path: [
      { id: 'p1', title: '安全规范基础', kpId: 'kp-safety', status: 'done', est: '已完成', resourceRef: '《安全规范精讲》' },
      { id: 'p2', title: '运动学进阶巩固', kpId: 'kp-kinematics', status: 'done', est: '已完成', resourceRef: '《D-H 建模从零到一》' },
      { id: 'p3', title: '传感器标定零基础', kpId: 'kp-sensor', status: 'active', est: '本周 · 4 课时', resourceRef: '《传感器标定精要 · 零基础版》' },
      { id: 'p4', title: '零点标定实操打卡', kpId: 'kp-sensor', status: 'todo', est: '下周 · 2 课时', resourceRef: '《六轴臂零点标定五步实操》' },
      { id: 'p5', title: '故障诊断入门', kpId: 'kp-diagnosis', status: 'todo', est: '第 3 周 · 3 课时', resourceRef: '《报警代码速查》' },
      { id: 'p6', title: '视觉引导入门', kpId: 'kp-vision', status: 'locked', est: '第 4 周解锁', resourceRef: '《视觉定位入门》' },
    ],
    summary: '理论-实操剪刀差持续收敛：标定维度 8 周提升 12 分。建议保持「讲义+实操」交替节奏，优先消化标定与诊断两大盲区。',
  },
  {
    learnerId: 'chen',
    adaptScore: 89.4,
    adaptTrend: [61, 67, 73, 79, 83, 86, 88, 89.4],
    weeks: WEEKS,
    abilityCurves: [
      { kpId: 'kp-plc', points: [55, 56, 58, 59, 60, 61, 61, 61] },
      { kpId: 'kp-kinematics', points: [36, 38, 40, 42, 43, 44, 45, 45] },
      { kpId: 'kp-sensor', points: [58, 60, 62, 64, 65, 66, 66, 66] },
      { kpId: 'kp-vision', points: [51, 52, 54, 55, 56, 57, 58, 58] },
      { kpId: 'kp-safety', points: [74, 76, 78, 80, 81, 82, 82, 82] },
      { kpId: 'kp-diagnosis', points: [56, 57, 59, 60, 61, 62, 63, 63] },
    ],
    difficultyMatch: [
      { difficulty: 1, fit: 96 },
      { difficulty: 2, fit: 93 },
      { difficulty: 3, fit: 84 },
      { difficulty: 4, fit: 61 },
      { difficulty: 5, fit: 35 },
    ],
    blindSpots: [
      { kpId: 'kp-kinematics', score: 45, target: 82, gap: 37, priority: '高', suggestion: '用图解讲义补坐标变换，借助 TCP 实操经验建立直觉' },
      { kpId: 'kp-vision', score: 58, target: 78, gap: 20, priority: '中', suggestion: '从相机拆装与打光实操入手，再学标定原理' },
      { kpId: 'kp-plc', score: 61, target: 80, gap: 19, priority: '中', suggestion: '跟做联锁回路接线实训，逐步过渡到编程' },
      { kpId: 'kp-diagnosis', score: 63, target: 80, gap: 17, priority: '低', suggestion: '整理师傅口诀对照报警代码表，形成个人速查卡' },
    ],
    path: [
      { id: 'p1', title: '安全规范强化', kpId: 'kp-safety', status: 'done', est: '已完成', resourceRef: '《安全规范精讲》' },
      { id: 'p2', title: '传感器实操精进', kpId: 'kp-sensor', status: 'done', est: '已完成', resourceRef: '《零点回位五步法》' },
      { id: 'p3', title: '坐标系图解入门', kpId: 'kp-kinematics', status: 'active', est: '本周 · 3 课时', resourceRef: '《TCP 标定三步看懂》' },
      { id: 'p4', title: '运动学分阶闯关', kpId: 'kp-kinematics', status: 'todo', est: '下周 · 2 课时', resourceRef: '《运动学 12 题》' },
      { id: 'p5', title: '视觉拆装实操', kpId: 'kp-vision', status: 'todo', est: '第 3 周 · 2 课时', resourceRef: '《视觉定位入门》' },
      { id: 'p6', title: '省赛综合实训', kpId: 'kp-diagnosis', status: 'locked', est: '选拔后解锁', resourceRef: '《故障树分析实操》' },
    ],
    summary: '实操驱动路线成效显著：标定与安全维度已达标。运动学理论是当前唯一高危盲区，图解式学习适配度 93%。',
  },
  {
    learnerId: 'zhao',
    adaptScore: 91.1,
    adaptTrend: [70, 75, 80, 84, 87, 89, 90.2, 91.1],
    weeks: WEEKS,
    abilityCurves: [
      { kpId: 'kp-plc', points: [85, 86, 86, 87, 87, 88, 88, 88] },
      { kpId: 'kp-kinematics', points: [43, 45, 47, 49, 50, 51, 52, 52] },
      { kpId: 'kp-sensor', points: [63, 65, 67, 69, 70, 71, 71, 71] },
      { kpId: 'kp-vision', points: [34, 37, 39, 41, 42, 43, 44, 44] },
      { kpId: 'kp-safety', points: [80, 81, 82, 83, 84, 85, 85, 85] },
      { kpId: 'kp-diagnosis', points: [73, 74, 76, 77, 78, 79, 79, 79] },
    ],
    difficultyMatch: [
      { difficulty: 1, fit: 88 },
      { difficulty: 2, fit: 92 },
      { difficulty: 3, fit: 90 },
      { difficulty: 4, fit: 74 },
      { difficulty: 5, fit: 51 },
    ],
    blindSpots: [
      { kpId: 'kp-vision', score: 44, target: 78, gap: 34, priority: '高', suggestion: '以手眼标定案例对照切入，复用网络组态经验做迁移' },
      { kpId: 'kp-kinematics', score: 52, target: 82, gap: 30, priority: '高', suggestion: '先掌握坐标系变换的工程直觉，公式推导按需补充' },
      { kpId: 'kp-sensor', score: 71, target: 85, gap: 14, priority: '中', suggestion: '激光跟踪仪标定实操 1 次，打通高精度测量链路' },
      { kpId: 'kp-diagnosis', score: 79, target: 80, gap: 1, priority: '低', suggestion: '补充减速器振动分析即可达标' },
    ],
    path: [
      { id: 'p1', title: 'PLC 联锁豁免认证', kpId: 'kp-plc', status: 'done', est: '已豁免', resourceRef: '《安全联锁回路设计》' },
      { id: 'p2', title: '安全体系对齐', kpId: 'kp-safety', status: 'done', est: '已完成', resourceRef: '《风险评估三步法》' },
      { id: 'p3', title: '手眼标定迁移课', kpId: 'kp-vision', status: 'active', est: '本周 · 3 课时', resourceRef: '《手眼标定案例对照》' },
      { id: 'p4', title: '坐标变换工程直觉', kpId: 'kp-kinematics', status: 'todo', est: '下周 · 2 课时', resourceRef: '《逆运动学图解》' },
      { id: 'p5', title: '高精度标定实操', kpId: 'kp-sensor', status: 'todo', est: '第 3 周 · 2 课时', resourceRef: '《激光跟踪仪标定实操》' },
      { id: 'p6', title: '工作站独立运维认证', kpId: 'kp-diagnosis', status: 'locked', est: '第 6 周考核', resourceRef: '《预测性维护数据判读》' },
    ],
    summary: '经验迁移策略适配度 91.1% 全场最高：PLC 与安全已达专家级。视觉引导是最后一块短板，案例对照式讲义正在起效。',
  },
];

export const getReportFor = (learnerId: string): LearnerReport =>
  reportData.find((r) => r.learnerId === learnerId) ?? reportData[0];

/** 当前应学的路径节点：优先 active，其次首个 todo */
export const activePathNode = (report: LearnerReport): PathNode | null =>
  report.path.find((n) => n.status === 'active')
  ?? report.path.find((n) => n.status === 'todo')
  ?? null;

/** 学完某知识点后的“下一步”：该节点之后首个可学(active/todo)节点，退回当前应学节点 */
export const nextPathNodeAfter = (report: LearnerReport, kpId: string): PathNode | null => {
  const idx = report.path.findIndex((n) => n.kpId === kpId);
  if (idx >= 0) {
    const after = report.path.slice(idx + 1).find((n) => n.status === 'active' || n.status === 'todo');
    if (after) return after;
  }
  return activePathNode(report);
};
