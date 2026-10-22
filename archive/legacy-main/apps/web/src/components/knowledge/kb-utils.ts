/**
 * 知识库页共享常量/工具（非组件，独立文件以满足 react-refresh 约束）
 */
import type { KBType } from '@/data/kbSlices';
import { resources } from '@/data/resources';
import type { ResourceForm } from '@/data/resources';

/** 类型徽标配色（knowledge.md S4：国标=砖红 / 行标=暖赭 / 教材=墨绿 / 企业案例=琥珀 / 论文=纸灰） */
export const kbTypeColor: Record<KBType, string> = {
  国标: '#B0483B',
  行标: '#B77552',
  教材: '#4E7860',
  企业案例: '#E7B45A',
  论文: '#66725E',
};

/** 被引资源名 → 深链路由（溯源链 back-links） */
export function resourceHref(name: string): string {
  if (/辩论|仲裁|交叉验证/.test(name)) return '/agents';
  if (/实操|指南/.test(name)) return '/resources?tab=guide';
  if (/分阶题|题 ·|测试/.test(name)) return '/resources?tab=quiz';
  if (/讲义/.test(name)) return '/resources?tab=lecture';
  return '/resources';
}

/** 资源形态徽标文案 */
export const resourceFormLabel: Record<ResourceForm, string> = {
  lecture: '讲义',
  guide: '指南',
  quiz: '分阶题',
};

export interface KBReferencingResource {
  learnerId: string;
  form: ResourceForm;
  title: string;
}

/**
 * 反向溯源：遍历 data/resources.ts 的真实生成资源，找出 kbRefs 包含该 kbId 的条目。
 * kbSlices.citedCount 是写死的 mock 数字，与这里遍历出的真实引用条数可能不一致——
 * Knowledge / KBDetailDrawer 展示"被引 n 次"时统一以这个函数的结果为准。
 */
export function referencingResources(kbId: string): KBReferencingResource[] {
  return resources
    .filter((r) => r.kbRefs.includes(kbId))
    .map((r) => ({ learnerId: r.learnerId, form: r.form, title: r.title }));
}
