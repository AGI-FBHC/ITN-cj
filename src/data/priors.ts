/**
 * 画像建档共用先验 — 身份/学历/岗位选项 + 背景→六维初始偏移
 * 供「精准定制」(/onboarding 五步向导) 与「精简建档」(/welcome 三步快建) 复用，
 * 保证两条路径的先验模型一致：精简 = 只有先验，精准 = 先验 + 自评 + 题目似然。
 */
import { knowledgePoints } from '@/data/knowledgePoints';

export const AVATARS = ['/avatar-lin.png', '/avatar-chen.png', '/avatar-zhao.png'];
export const TAGS = ['本科应届生', '高职实训生', '转岗工程师', '在职进修', '研究生在读', '企业新员工', '自由学习者'];
export const EDU = ['本科', '硕士', '博士', '高职', '大专', '中职', '高中及以下'];
export const JOBS = [
  '机器人系统集成应用工程师',
  '机器人运维技术员（产线）',
  '智能产线运维工程师',
  '视觉应用工程师',
  '机器人调试工程师',
  '设备维修技师',
  '自动化工艺工程师',
  '售后技术支持工程师',
];
export const STYLES = ['理论先行', '实操驱动', '图示学习', '案例迁移', '步骤清单', '碎片化学习', '视频演示', '项目实战', '同伴讨论'];

/* ================= 先验：背景 → 六维初始偏移 ================= */
export const TAG_PRIOR: Record<string, Record<string, number>> = {
  本科应届生: { 'kp-kinematics': 8, 'kp-safety': 4, 'kp-sensor': -6, 'kp-diagnosis': -5 },
  高职实训生: { 'kp-sensor': 8, 'kp-safety': 6, 'kp-diagnosis': 4, 'kp-kinematics': -8 },
  转岗工程师: { 'kp-plc': 14, 'kp-diagnosis': 10, 'kp-safety': 6, 'kp-vision': -8, 'kp-kinematics': -4 },
  在职进修: { 'kp-diagnosis': 6, 'kp-plc': 5 },
  研究生在读: { 'kp-kinematics': 10, 'kp-vision': 4, 'kp-sensor': -4 },
  企业新员工: { 'kp-safety': 4 },
  自由学习者: {},
};
export const EDU_PRIOR: Record<string, Record<string, number>> = {
  本科: { 'kp-kinematics': 3 },
  硕士: { 'kp-kinematics': 5, 'kp-vision': 3 },
  博士: { 'kp-kinematics': 7, 'kp-vision': 4 },
  高职: { 'kp-sensor': 4 },
  大专: { 'kp-sensor': 3 },
  中职: { 'kp-kinematics': -3 },
  高中及以下: { 'kp-kinematics': -4 },
};

export function priorOf(tag: string, edu: string): Record<string, number> {
  const p: Record<string, number> = {};
  knowledgePoints.forEach((kp) => {
    p[kp.id] = (TAG_PRIOR[tag]?.[kp.id] ?? 0) + (EDU_PRIOR[edu]?.[kp.id] ?? 0);
  });
  return p;
}

/** 先验的一句话解释（阿诊出声） */
export function priorLine(tag: string): string {
  const map: Record<string, string> = {
    本科应届生: '按「本科应届生」的背景，我先把理论两维的起点调高、实操两维调低——接下来用题目验证。',
    高职实训生: '「高职实训生」通常动手强于推导，我先把标定/安全的起点抬高、运动学放低——等你答题来纠正我。',
    转岗工程师: '有产线经验的转岗工程师，PLC 和故障诊断的起点我直接调高，视觉引导按新领域算——测测看准不准。',
    在职进修: '在职进修的学习者一般有些现场经验，诊断和 PLC 起点略抬——具体还要看你的作答。',
    研究生在读: '研究生的理论基础我先高估一点，运动学和视觉起点上调——进阶题见真章。',
    企业新员工: '企业新员工我只预设了安全培训底子，其余从中位开始——一切让题目说话。',
    自由学习者: '自由学习者我不做任何假设，六维都从中位开始——完全靠接下来的证据。',
  };
  return map[tag] ?? '这个身份我没有先验可用，六维从中位开始——靠你的自评和作答来定。';
}
