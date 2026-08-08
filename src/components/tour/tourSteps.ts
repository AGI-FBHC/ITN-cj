/**
 * tourSteps — 「评委一键导览」七步文案数据
 * 对齐赛题五步闭环叙事（画像→协同→生成→反馈→决策），拆成 7 个可导航的落点。
 * 每步字段：标题 / 路由 / 解说（2~3 句）/ 看点 bullets / 赛题评分维度 badge。
 */
import type { LucideIcon } from 'lucide-react';
import { Users, Network, PenLine, ShieldCheck, MessagesSquare, BarChart3, Database } from 'lucide-react';

/** 赛题评分维度：完整性 / 创新性 / 体验 / 实用价值 */
export type TourDimension = '完整性' | '创新性' | '体验' | '实用价值';

export interface TourStep {
  key: string;
  title: string;
  /** 目标路由（可带 query，如 ?tab=lecture） */
  route: string;
  icon: LucideIcon;
  narration: string;
  highlights: string[];
  badge: TourDimension;
  /** 额外提示（如「建议观看完整 25s」） */
  note?: string;
}

export const tourSteps: TourStep[] = [
  {
    key: 'profile',
    title: '学情画像',
    route: '/profiles',
    icon: Users,
    narration:
      '三组差异化画像——本科生、高职生、转岗人员，覆盖不同起点的学习者。切换画像会驱动全站数据重排，从雷达图到推荐资源全部联动更新。',
    highlights: ['六维知识雷达图直观呈现强弱分布', '技能盲区标签精准定位待补强领域'],
    badge: '完整性',
  },
  {
    key: 'agents',
    title: '多智能体协同',
    route: '/agents?autoplay=1',
    icon: Network,
    narration:
      '诊断 / 检索 / 生成 / 审核 / 仲裁五体分工协同，GEN-03 与 VER-04 两轮辩论交叉验证，一旦出现幻觉即被一票否决——这是整套系统最核心的可信机制。',
    highlights: ['泳道消息流转，看清每条消息的来龙去脉', '实时指标条量化协同效率', '辩论 diff 逐字对比审核意见'],
    badge: '创新性',
    note: '建议观看完整 25s 协同过程',
  },
  {
    key: 'resources-lecture',
    title: '资源生成',
    route: '/resources?tab=lecture',
    icon: PenLine,
    narration:
      '讲义采用流式生成，逐条论断强制挂接知识库溯源角标，杜绝无依据的表述。悬停角标即可查看该论断对应的可信度评分。',
    highlights: ['溯源密度徽标标注每千字引用数', '右侧溯源栏展开对照原文'],
    badge: '完整性',
  },
  {
    key: 'resources-guide',
    title: '实操与分阶',
    route: '/resources?tab=guide',
    icon: ShieldCheck,
    narration:
      '实操指南内置 LOTO 安全门控与步骤安全分级，涉及高风险操作会强制提示；分阶题目则依据画像自动判定适配难度。',
    highlights: ['安全徽标标出高 / 中 / 低风险步骤', '标准依据行标注每条操作对应的国标 / 行标条款'],
    badge: '实用价值',
  },
  {
    key: 'tutoring',
    title: '交互导学',
    route: '/tutoring',
    icon: MessagesSquare,
    narration:
      '苏格拉底式三阶追问——引导、追问、确认，让学习者自己推导出答案而非被动接受。答错触发 ARB-05「降维解释」，答对触发「进阶挑战」，反馈实时驱动难度调节。',
    highlights: ['幕后协商卡还原 Agent 间的决策讨论', '决策横幅公示当前难度调整的依据'],
    badge: '体验',
  },
  {
    key: 'report',
    title: '学情报告',
    route: '/report',
    icon: BarChart3,
    narration:
      '盲区雷达持续追踪能力短板的收敛过程，难度适配带展示学习路径的坡度设计，每一次曲线抬升都对应一次可溯源的 Agent 介入记录。',
    highlights: ['能力轨迹点标出关键测评节点', 'W3 / W5 / W7 介入标注让每次提升都有据可查'],
    badge: '完整性',
  },
  {
    key: 'knowledge',
    title: '知识库',
    route: '/knowledge',
    icon: Database,
    narration:
      '2,356 条覆盖国标 / 行标的领域切片构成整套系统的知识底座，支持反向检索——任意一条切片被哪些资源引用过，一查便知。',
    highlights: ['可信度评分量化每条切片的权威程度', '溯源检索反向定位切片的下游引用'],
    badge: '实用价值',
  },
];

/** sessionStorage key：{ active, stepIndex, minimized }，刷新不丢进度 */
export const TOUR_STORAGE_KEY = 'lf-demo-tour';
