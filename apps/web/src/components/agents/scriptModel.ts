/**
 * scriptModel — 协同脚本的页面级视图模型
 * 从 collabScript 事件序列动态定位关键节点下标（不依赖硬编码下标，脚本结构调整时自适应），
 * 供控制台阶段 stepper / 泳道演出 / 辩论面板 / 决策日志共用。
 */
import type { CollabEvent } from '@/data/collabScript';

export interface ScriptIndices {
  /** DIA-01 首条画像回报 */
  diaReport: number;
  /** ARB-05 立项决议 */
  kickoff: number;
  /** ARB-05 → RET-02 检索指令 */
  retCmd: number;
  /** RET-02 检索命中 */
  retHit: number;
  /** ARB-05 → GEN-03 生成指令 */
  genCmd: number;
  /** GEN-03 草稿 v1 送审 */
  draftV1: number;
  /** R1 VER 质询 / GEN 应答 */
  r1Challenge: number;
  r1Answer: number;
  /** GEN 修订 v2 */
  revision: number;
  /** R2 VER 质询 / GEN 应答（幻觉拦截） */
  r2Challenge: number;
  r2Answer: number;
  /** VER 复核通过 */
  verdict: number;
  /** ARB 采纳决议 */
  adopt: number;
  /** GEN 指南+分阶题产出 */
  guide: number;
  /** DIA 追踪埋点 */
  tracking: number;
  /** ARB 闭环确认 */
  closed: number;
}

const find = (events: CollabEvent[], pred: (e: CollabEvent, i: number) => boolean, from = 0) => {
  for (let i = from; i < events.length; i += 1) {
    if (pred(events[i], i)) return i;
  }
  return -1;
};

export function getScriptIndices(events: CollabEvent[]): ScriptIndices {
  const diaReport = find(events, (e) => e.from === 'DIA-01');
  const kickoff = find(events, (e) => e.type === 'decision' && e.from === 'ARB-05');
  const retCmd = find(events, (e) => e.to === 'RET-02');
  const retHit = find(events, (e) => e.from === 'RET-02');
  const genCmd = find(events, (e) => e.to === 'GEN-03');
  const draftV1 = find(events, (e) => e.from === 'GEN-03');
  const r1Challenge = find(events, (e) => e.type === 'debate' && e.round === 1 && e.from === 'VER-04');
  const r1Answer = find(events, (e) => e.type === 'debate' && e.round === 1 && e.from === 'GEN-03');
  const revision = find(events, (e) => e.type === 'revision');
  const r2Challenge = find(events, (e) => e.type === 'debate' && e.round === 2 && e.from === 'VER-04');
  const r2Answer = find(events, (e) => e.type === 'debate' && e.round === 2 && e.from === 'GEN-03');
  const verdict = find(events, (e) => e.type === 'verdict');
  const adopt = find(events, (e) => e.type === 'decision' && e.from === 'ARB-05', verdict + 1);
  const guide = find(events, (e) => e.from === 'GEN-03', verdict + 1);
  const tracking = find(events, (e) => e.from === 'DIA-01', verdict + 1);
  const closed = find(events, (e) => e.type === 'decision' && e.from === 'ARB-05', adopt + 1);
  return {
    diaReport, kickoff, retCmd, retHit, genCmd, draftV1,
    r1Challenge, r1Answer, revision, r2Challenge, r2Answer,
    verdict, adopt, guide, tracking, closed,
  };
}

/** 控制台 5 段 mini stepper（诊断 → 检索 → 生成 → 审核 → 仲裁） */
export interface StageDef {
  key: string;
  label: string;
  idxs: number[];
}

export function getStages(idx: ScriptIndices): StageDef[] {
  return [
    { key: 'dia', label: '诊断', idxs: [idx.diaReport, idx.tracking].filter((i) => i >= 0) },
    { key: 'ret', label: '检索', idxs: [idx.retCmd, idx.retHit].filter((i) => i >= 0) },
    {
      key: 'gen',
      label: '生成',
      idxs: [idx.genCmd, idx.draftV1, idx.r1Answer, idx.revision, idx.guide].filter((i) => i >= 0),
    },
    {
      key: 'ver',
      label: '审核',
      idxs: [idx.r1Challenge, idx.r2Challenge, idx.verdict].filter((i) => i >= 0),
    },
    { key: 'arb', label: '仲裁', idxs: [idx.kickoff, idx.adopt, idx.closed].filter((i) => i >= 0) },
  ];
}

export type StageState = 'upcoming' | 'active' | 'done';

/** cursor = 已派发条数；阶段任一派发即 active，全部越过即 done */
export function stageState(stage: StageDef, cursor: number): StageState {
  if (stage.idxs.length === 0) return 'upcoming';
  const min = Math.min(...stage.idxs);
  const max = Math.max(...stage.idxs);
  if (cursor > max) return 'done';
  if (cursor > min) return 'active';
  return 'upcoming';
}

/** 场景选择器（S1）：三种资源形态 */
export type Scenario = 'lecture' | 'guide' | 'quiz';

export const scenarioMeta: Record<Scenario, { label: string; en: string }> = {
  lecture: { label: '领学讲义', en: 'LECTURE' },
  guide: { label: '实操指南', en: 'GUIDE' },
  quiz: { label: '分阶测试题', en: 'QUIZ' },
};
