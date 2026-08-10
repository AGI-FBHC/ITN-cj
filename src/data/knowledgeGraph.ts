/**
 * knowledgeGraph — 知识图谱数据层
 * 两层结构：6 个域节点（大液面球）+ 24 个子知识点（coreTopics，小球），
 * 语义边（前置/相关/应用）手工定义；布局为确定性极坐标（六域环形 + 子节点外侧扇形）。
 * 掌握度：域 = learner.scores；子 = 域分数 + 确定性偏移；"学过"判定复用阿诊信号去重记录。
 */
import { knowledgePoints } from '@/data/knowledgePoints';
import type { Learner } from '@/data/learners';

/* ================= 节点 ================= */
export interface GraphNode {
  id: string;            // 域: kpId；子: `${kpId}-t${i}`
  kpId: string;
  kind: 'domain' | 'topic';
  label: string;
  /** 子节点在父域 coreTopics 中的下标（深链课件概念块用） */
  topicIndex?: number;
  x: number;
  y: number;
  r: number;
  /** 标签排版：径向朝外摆放，避免重叠 */
  labelX: number;
  labelY: number;
  labelAnchor: 'start' | 'middle' | 'end';
}

export type EdgeKind = 'prereq' | 'related' | 'applies';

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** hover 提示 */
  note: string;
}

/* ================= 布局（按前置关系分层：阅读顺序 = 学习顺序） =================
 * 三列：基础层（PLC/运动学）→ 规范与应用（安全/视觉）→ 实操与运维（标定/诊断）。
 * 域级前置几乎是 DAG（plc→safety→sensor；kinematics→vision），分层后前置边全部同向流动，
 * 替代旧环形布局（旧版子节点扇角 72°>域间距 60° 互相侵入、跨域边穿环心交叉）。 */
const DOMAIN_R = 46;
const TOPIC_R = 13;

/* 两排靠拢：原 156/400 之间的 ~200px 是"展开子节点"的预留区，未展开时是死空间。
   压到 148/345 后，展开空间仍够（上排子节点下探、下排子节点上探，互不打架），整图矮 116px。 */
const DOMAIN_POS: Record<string, { x: number; y: number }> = {
  'kp-plc': { x: 150, y: 148 },
  'kp-kinematics': { x: 150, y: 345 },
  'kp-safety': { x: 448, y: 148 },
  'kp-vision': { x: 448, y: 345 },
  'kp-sensor': { x: 748, y: 148 },
  'kp-diagnosis': { x: 748, y: 345 },
};

/** 列标注（学习顺序） */
export const graphColumns = [
  { label: '基础层', x: 150 },
  { label: '规范与应用', x: 448 },
  { label: '实操与运维', x: 748 },
];

/** 子知识点短标签（coreTopics 原文太长，图上用短名，tooltip 给全名） */
const shortLabels: Record<string, string[]> = {
  'kp-plc': ['梯形图/ST', 'I/O 联锁', '工业以太网', '安全门回路'],
  'kp-kinematics': ['D-H 建模', '正/逆解', '坐标系', '奇异点'],
  'kp-sensor': ['零点标定', '位姿准确度', '温漂补偿', '重复精度'],
  'kp-vision': ['手眼标定', '特征匹配', '抓取位姿', '光照曝光'],
  'kp-safety': ['安全要求', '风险评估', '急停回路', '协作边界'],
  'kp-diagnosis': ['报警解析', '故障树', '减速器判读', '预测维护'],
};

function buildNodes(): GraphNode[] {
  const nodes: GraphNode[] = [];
  knowledgePoints.forEach((kp) => {
    const pos = DOMAIN_POS[kp.id] ?? { x: 460, y: 280 };
    const { x: dx, y: dy } = pos;
    nodes.push({
      id: kp.id,
      kpId: kp.id,
      kind: 'domain',
      label: kp.name,
      x: dx,
      y: dy,
      r: DOMAIN_R,
      labelX: dx,
      labelY: dy + DOMAIN_R + 19,
      labelAnchor: 'middle',
    });
    /* 子节点（点击域时才显示）：横排在域的下方（上排域）/上方（下排域），远离另一排避让。
       上探时标签在点上方、离本域近，故用更小的偏移，避免压到上排域的名字 */
    const dir = dy < 250 ? 1 : -1;
    kp.coreTopics.slice(0, 4).forEach((_, ti) => {
      const tx = dx - 99 + ti * 66;
      const ty = dy + dir * (DOMAIN_R + (dir === 1 ? 56 : 46));
      nodes.push({
        id: `${kp.id}-t${ti}`,
        kpId: kp.id,
        kind: 'topic',
        label: shortLabels[kp.id]?.[ti] ?? kp.coreTopics[ti],
        topicIndex: ti,
        x: tx,
        y: ty,
        r: TOPIC_R,
        labelX: tx,
        labelY: dir === 1 ? ty + TOPIC_R + 14 : ty - TOPIC_R - 8,
        labelAnchor: 'middle',
      });
    });
  });
  return nodes;
}

export const graphNodes: GraphNode[] = buildNodes();
export const graphViewBox = { w: 920, h: 440 };

/* ================= 域级聚合边（渐进披露的默认视图用） =================
 * 16 条子节点级语义边按"域对 × 边型"卷积：默认视图只画 6 域之间的聚合关系，
 * 点开某个域才展示它的子节点级明细边。 */
export interface DomainEdge {
  from: string;          // kpId
  to: string;            // kpId
  kind: EdgeKind;
  count: number;
  notes: string[];
}

export function domainEdgesOf(kind: EdgeKind): DomainEdge[] {
  const map = new Map<string, DomainEdge>();
  graphEdges.forEach((e) => {
    if (e.kind !== kind) return;
    const fromKp = getNode(e.from)?.kpId;
    const toKp = getNode(e.to)?.kpId;
    if (!fromKp || !toKp || fromKp === toKp) return;   // 域内边不参与聚合
    const key = `${fromKp}>${toKp}`;
    const cur = map.get(key);
    if (cur) {
      cur.count += 1;
      cur.notes.push(e.note);
    } else {
      map.set(key, { from: fromKp, to: toKp, kind, count: 1, notes: [e.note] });
    }
  });
  return [...map.values()];
}

export const getNode = (id: string): GraphNode | undefined => graphNodes.find((n) => n.id === id);

/* ================= 语义边（领域真实关系，手工定义） ================= */
export const graphEdges: GraphEdge[] = [
  /* 前置：学 from 才好学 to */
  { from: 'kp-kinematics-t0', to: 'kp-kinematics-t1', kind: 'prereq', note: 'D-H 建模是正/逆解的前置' },
  { from: 'kp-kinematics-t2', to: 'kp-vision-t0', kind: 'prereq', note: '坐标系变换是手眼标定的前置' },
  { from: 'kp-kinematics-t1', to: 'kp-vision-t2', kind: 'prereq', note: '逆解是抓取位姿解算的前置' },
  { from: 'kp-plc-t1', to: 'kp-plc-t3', kind: 'prereq', note: 'I/O 联锁是安全门回路的前置' },
  { from: 'kp-plc-t1', to: 'kp-safety-t2', kind: 'prereq', note: '联锁逻辑是急停回路设计的前置' },
  { from: 'kp-sensor-t0', to: 'kp-sensor-t3', kind: 'prereq', note: '零点标定是重复精度验收的前置' },
  { from: 'kp-diagnosis-t0', to: 'kp-diagnosis-t1', kind: 'prereq', note: '读懂报警才有故障树排查' },
  { from: 'kp-safety-t0', to: 'kp-sensor-t0', kind: 'prereq', note: '安全要求是一切实操的前置' },
  /* 相关：互补/同源 */
  { from: 'kp-sensor-t2', to: 'kp-diagnosis-t3', kind: 'related', note: '温漂数据是预测性维护的重要输入' },
  { from: 'kp-sensor-t3', to: 'kp-vision-t1', kind: 'related', note: '重复精度决定视觉定位的可信区间' },
  { from: 'kp-plc-t2', to: 'kp-diagnosis-t0', kind: 'related', note: '通讯丢站与报警排查同构' },
  { from: 'kp-safety-t1', to: 'kp-diagnosis-t1', kind: 'related', note: '风险评估与故障树共用分析方法' },
  { from: 'kp-vision-t3', to: 'kp-vision-t1', kind: 'related', note: '光照稳定是特征匹配的成败关键' },
  /* 应用：规范约束实操 */
  { from: 'kp-safety-t2', to: 'kp-sensor-t0', kind: 'applies', note: '标定作业必须在急停可用状态下进行' },
  { from: 'kp-safety-t3', to: 'kp-vision-t2', kind: 'applies', note: '协作边界约束抓取运动范围' },
  { from: 'kp-safety-t0', to: 'kp-plc-t3', kind: 'applies', note: 'GB 11291.1 直接约束安全门设计' },
];

/** 某节点的前置链（入边为 prereq 的源） */
export function prereqOf(nodeId: string): { node: GraphNode; note: string }[] {
  return graphEdges
    .filter((e) => e.kind === 'prereq' && e.to === nodeId)
    .map((e) => ({ node: getNode(e.from)!, note: e.note }))
    .filter((x) => Boolean(x.node));
}

/* ================= 学过判定 + 掌握度派生 ================= */
/** 学过：阿诊信号去重记录里有该知识点的 lecture-read/guide/tutoring 痕迹，或预设画像路径已完成 */
export function learnedKpIds(learner: Learner, pathDoneKpIds: string[]): Set<string> {
  const learned = new Set<string>(pathDoneKpIds);
  try {
    const seen: string[] = JSON.parse(window.localStorage.getItem('lf.agentSeen') ?? '[]');
    knowledgePoints.forEach((kp) => {
      if (seen.some((s) => s.startsWith(`${learner.id}:`) && s.includes(kp.name))) learned.add(kp.id);
    });
  } catch { /* ignore */ }
  /* 预设画像有历史学习记录：分数明显高于中位视为学过 */
  knowledgePoints.forEach((kp) => {
    if ((learner.scores[kp.id] ?? 50) >= 60) learned.add(kp.id);
  });
  return learned;
}

/** 子知识点掌握度：父域分数 + 确定性偏移（模拟同域内强弱不均） */
const TOPIC_OFFSET = [6, 0, -6, -10];
export function topicMastery(learner: Learner, kpId: string, topicIndex: number): number {
  const base = learner.scores[kpId] ?? 50;
  return Math.max(12, Math.min(96, base + TOPIC_OFFSET[topicIndex % 4]));
}
