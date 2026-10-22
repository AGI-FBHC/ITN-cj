/**
 * 个性化生成资源 — 管理员母版资源驱动
 * Mock 数据已移除；知识网络展示管理员端母版分组的通用资源。
 */

export type ResourceForm = 'lecture' | 'guide' | 'quiz';

export interface GuideStep {
  title: string;
  desc: string;
  kbRefs?: string[];
  warning?: string;
  safety?: 'safe' | 'caution' | 'danger';
}

export interface GeneratedResource {
  learnerId: string;
  form: ResourceForm;
  title: string;
  levelTag: string;
  kpId: string;
  version: string;
  updatedAt: string;
  markdown?: string;
  steps?: GuideStep[];
  safetyNotice?: string;
  quizIds?: string[];
  quizSummary?: { basic: number; advanced: number; challenge: number };
  kbRefs: string[];
}

export const resources: GeneratedResource[] = [];

export const getResourcesFor = (learnerId: string): GeneratedResource[] =>
  resources.filter((r) => r.learnerId === learnerId);

export const getResource = (learnerId: string, form: ResourceForm): GeneratedResource | undefined =>
  resources.find((r) => r.learnerId === learnerId && r.form === form);

export const resourcesForKp = (learnerId: string, kpId: string): GeneratedResource[] =>
  resources.filter((r) => r.learnerId === learnerId && r.kpId === kpId);

export interface LearnTarget {
  to: string;
  kind: 'resource' | 'courseware';
  form?: ResourceForm;
}

const pickFormByHint = (hint: string, res: GeneratedResource[]): GeneratedResource => {
  const guide = res.find((r) => r.form === 'guide');
  const quiz = res.find((r) => r.form === 'quiz');
  const lecture = res.find((r) => r.form === 'lecture');
  if (guide && /实操|打卡|操作|指南|动手|演练/.test(hint)) return guide;
  if (quiz && /分阶题|测评|测试|闯关|自测|做题|练题/.test(hint)) return quiz;
  if (lecture && /讲义|精讲|图解|入门|案例|迁移|讲/.test(hint)) return lecture;
  return res[0];
};

export const resolveLearnTarget = (learnerId: string, kpId: string, hint?: string): LearnTarget => {
  const res = resourcesForKp(learnerId, kpId);
  if (res.length) {
    const picked = hint ? pickFormByHint(hint, res) : res[0];
    return { to: `/resources?tab=${picked.form}`, kind: 'resource', form: picked.form };
  }
  return { to: `/learn/${kpId}`, kind: 'courseware' };
};
