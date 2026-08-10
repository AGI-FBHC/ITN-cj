/**
 * 画像建档共用先验 — 身份/学历/岗位选项 + 背景→六维初始偏移
 * 仅用于精简建档与精准定制两条建档链路
 */

export const AVATARS = ['/avatar-lin.png', '/avatar-chen.png', '/avatar-zhao.png'];
export const TAGS = ['本科应届生', '高职实训生', '转岗工程师', '在职进修', '研究生在读', '企业新员工', '自由学习者'];
export const EDU = ['本科', '硕士', '博士', '高职', '大专', '中职', '高中及以下'];
export const JOBS = [
  'Agent工程师',
  'AI开发工程师',
  '大模型算法工程师',
  '算法评测工程师',
  '数据分析师',
  '网络工程师',
  '操作系统开发工程师',
  '数据库工程师',
  '中间件开发工程师',
  '后端开发工程师',
];
export const STYLES = ['理论先行', '实操驱动', '图示学习', '案例迁移', '步骤清单', '碎片化学习', '视频演示', '项目实战', '同伴讨论'];

export const TAG_PRIOR: Record<string, Record<string, number>> = {
  本科应届生: { 'kp-ds': 8, 'kp-co': 5, 'kp-network': 4, 'kp-os': 3, 'kp-db': 2, 'kp-agent': -2 },
  高职实训生: { 'kp-network': 6, 'kp-db': 4, 'kp-os': 3, 'kp-ds': -6, 'kp-co': -4, 'kp-agent': 2 },
  转岗工程师: { 'kp-network': 10, 'kp-db': 8, 'kp-os': 6, 'kp-agent': -4, 'kp-ds': -4 },
  在职进修: { 'kp-network': 5, 'kp-db': 4, 'kp-os': 3 },
  研究生在读: { 'kp-ds': 10, 'kp-co': 6, 'kp-agent': 4, 'kp-os': -2 },
  企业新员工: { 'kp-network': 4 },
  自由学习者: {},
};

export const EDU_PRIOR: Record<string, Record<string, number>> = {
  本科: { 'kp-ds': 3 },
  硕士: { 'kp-ds': 6, 'kp-agent': 4 },
  博士: { 'kp-ds': 8, 'kp-agent': 6 },
  高职: { 'kp-network': 4, 'kp-db': 2 },
  大专: { 'kp-network': 3 },
  中职: { 'kp-ds': -4 },
  高中及以下: { 'kp-ds': -5 },
};

export function priorOf(tag: string, edu: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [kpId, delta] of Object.entries(TAG_PRIOR[tag] ?? {})) {
    result[kpId] = delta;
  }
  for (const [kpId, delta] of Object.entries(EDU_PRIOR[edu] ?? {})) {
    result[kpId] = (result[kpId] ?? 0) + delta;
  }
  return result;
}

export function priorLine(tag: string): string {
  const map: Record<string, string> = {
    本科应届生: '按「本科应届生」的背景，我先把数据结构、组成原理和网络的起点调高，智能体从基础开始。',
    高职实训生: '「高职实训生」通常动手能力强于理论，我先把网络和数据库的起点抬高，数据结构与组成原理放低。',
    转岗工程师: '有工程经验的转岗学习者，网络和数据库起点可以抬高，数据结构、组成原理与智能体按新领域计算。',
    在职进修: '在职进修通常有一定工程经验，网络、数据库和操作系统起点略抬。',
    研究生在读: '研究生的理论起点较高，数据结构、组成原理和智能体方向会先高估一些。',
    企业新员工: '企业新员工我只预设了基础网络认知，其余从中位开始。',
    自由学习者: '自由学习者我不做任何假设，六维都从中位开始。',
  };
  return map[tag] ?? '这个身份我没有先验可用，六维从中位开始。';
}
