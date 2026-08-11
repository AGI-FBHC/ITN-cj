/**
 * 画像建档共用先验 — 身份/学历/岗位选项 + 背景→六维初始偏移
 * 仅用于精简建档与精准定制两条建档链路
 */

export const AVATARS = ['/avatar-lin.png', '/avatar-chen.png', '/avatar-zhao.png'];
export const TAGS = ['在校学生', '应届毕业生', '职场新人（1-3年）', '中级工程师（3-5年）', '高级工程师（5年+）', '转岗/跨领域', '自由学习者'];
export const EDU = ['初中及以下', '高中', '大专', '本科', '硕士', '博士'];
export const JOBS = [
  'Agent工程师',
  'RAG应用工程师',
  '多智能体开发工程师',
  'Agent平台工程师',
];
export const STYLES = ['理论先行', '实操驱动', '图示学习', '案例迁移', '步骤清单', '碎片化学习', '视频演示', '项目实战', '同伴讨论'];

export const TAG_PRIOR: Record<string, Record<string, number>> = {
  在校学生: { 'kp-ds': 4, 'kp-co': 2, 'kp-os': 1, 'kp-network': 1, 'kp-db': 0, 'kp-agent': -1 },
  应届毕业生: { 'kp-ds': 8, 'kp-co': 5, 'kp-network': 4, 'kp-os': 3, 'kp-db': 2, 'kp-agent': -2 },
  '职场新人（1-3年）': { 'kp-network': 5, 'kp-db': 4, 'kp-os': 3, 'kp-ds': 1 },
  '中级工程师（3-5年）': { 'kp-network': 8, 'kp-db': 6, 'kp-os': 5, 'kp-ds': -1, 'kp-agent': 1 },
  '高级工程师（5年+）': { 'kp-network': 10, 'kp-db': 9, 'kp-os': 8, 'kp-agent': 2 },
  '转岗/跨领域': { 'kp-network': 6, 'kp-db': 4, 'kp-os': 3, 'kp-agent': -2, 'kp-ds': -3 },
  自由学习者: {},
};

export const EDU_PRIOR: Record<string, Record<string, number>> = {
  '初中及以下': { 'kp-ds': -6, 'kp-co': -4 },
  高中: { 'kp-ds': -3, 'kp-co': -2 },
  大专: { 'kp-network': 3, 'kp-db': 1 },
  本科: { 'kp-ds': 3, 'kp-co': 1, 'kp-os': 1 },
  硕士: { 'kp-ds': 6, 'kp-agent': 4, 'kp-co': 2 },
  博士: { 'kp-ds': 8, 'kp-agent': 6, 'kp-co': 4 },
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
    在校学生: '按「在校学生」的起点，基础课程正在学，我先把数据结构与组成原理稍抬高，网络与数据库按标准起点。',
    应届毕业生: '应届毕业生理论基础较新，数据结构、组成原理和网络的起点会调高一些。',
    '职场新人（1-3年）': '职场新人有一定工程感知，网络、数据库和操作系统起点略抬。',
    '中级工程师（3-5年）': '中级工程师经验丰富，网络、数据库和操作系统起点明显抬高。',
    '高级工程师（5年+）': '高级工程师的网络与数据库起点可以设得很高，智能体也开始有积累。',
    '转岗/跨领域': '转岗/跨领域学习者可能在网络和数据库有积累，但数据结构与智能体需要从新领域开始。',
    自由学习者: '自由学习者我不做任何假设，六维都从中位开始。',
  };
  return map[tag] ?? '这个身份我没有先验可用，六维从中位开始。';
}
