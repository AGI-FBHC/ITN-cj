/**
 * 全局核心指标 — 赛题评分指标的可视化数据源
 * 幻觉率 < 5% / 适配准确率 ≥ 85% / 覆盖率 ≥ 90%
 */

export interface CoreMetric {
  id: string;
  en: string;
  name: string;
  /** 当前值（数值，展示时格式化） */
  value: number;
  /** count-up 起始值（幻觉率从 8.6 倒数） */
  fromValue: number;
  decimals: number;
  suffix: string;
  thresholdText: string;
  /** 达标徽标样式 */
  badgeTone: 'amber' | 'green' | 'gray';
  note: string;
  /** 近 12 周 sparkline（幻觉率下降，其余上升） */
  spark: number[];
  /** 阈值参考线（与 value 同量纲，幻觉率卡用） */
  thresholdLine?: number;
  /** 点击跳转 */
  href: string;
  tooltip: string;
}

export const coreMetrics: CoreMetric[] = [
  {
    id: 'hallucination',
    en: 'HALLUCINATION RATE',
    name: '幻觉率',
    value: 3.2,
    fromValue: 8.6,
    decimals: 1,
    suffix: '%',
    thresholdText: '达标 < 5%',
    badgeTone: 'amber',
    note: '近 30 日 · 审核裁判拦截 217 处',
    spark: [8.6, 8.1, 7.4, 6.9, 6.2, 5.8, 5.1, 4.7, 4.2, 3.8, 3.5, 3.2],
    thresholdLine: 5,
    href: '/agents',
    tooltip: '口径：VER-04 判定为无出处/失实的论断数 ÷ 全部生成论断数（近 30 日滚动）',
  },
  {
    id: 'adaptation',
    en: 'ADAPTATION ACCURACY',
    name: '画像-资源适配准确率',
    value: 88.6,
    fromValue: 62.0,
    decimals: 1,
    suffix: '%',
    thresholdText: '达标 ≥ 85%',
    badgeTone: 'green',
    note: '3 组画像 · 148 次资源分配',
    spark: [62, 65, 68, 71, 74, 77, 79, 82, 84, 86, 87.5, 88.6],
    thresholdLine: 85,
    href: '/report',
    tooltip: '口径：学习者完成资源后测提升 ≥ 5 分的分配次数 ÷ 总分配次数',
  },
  {
    id: 'coverage',
    en: 'COVERAGE',
    name: '核心知识点覆盖率',
    value: 92.4,
    fromValue: 71.0,
    decimals: 1,
    suffix: '%',
    thresholdText: '达标 ≥ 90%',
    badgeTone: 'green',
    note: '6 大知识点 · 岗位能力模型对齐',
    spark: [71, 74, 78, 81, 83, 85, 87, 89, 90.2, 91.1, 91.8, 92.4],
    thresholdLine: 90,
    href: '/report',
    tooltip: '口径：已生成合格资源的知识点条目 ÷ 岗位能力模型全部条目（对齐 1+X 标准）',
  },
  {
    id: 'learners',
    en: 'LEARNERS SERVED',
    name: '累计服务学习者',
    value: 12847,
    fromValue: 9600,
    decimals: 0,
    suffix: '',
    thresholdText: '持续运行',
    badgeTone: 'gray',
    note: '今日新增 63 · 企业合作 17 家',
    spark: [9600, 9920, 10280, 10610, 10980, 11340, 11720, 12050, 12320, 12540, 12700, 12847],
    href: '/profiles',
    tooltip: '口径：注册并完成至少一次画像诊断的学习者总数（含 17 家合作企业学员）',
  },
];

export const globalStats = {
  kbSlicesTotal: 2356,
  todayCollabCount: 47,
  agentsOnline: 5,
  avgCollabLatency: '0.8s',
  interceptedTotal: 217,
  allocationCount: 148,
  enterpriseCount: 17,
  todayNewLearners: 63,
  weeksLabels: ['W1','W2','W3','W4','W5','W6','W7','W8','W9','W10','W11','W12'],
};
