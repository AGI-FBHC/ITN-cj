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

/* ================= 布局（确定性极坐标） ================= */
const CX = 460;
const CY = 330;
const DOMAIN_RING = 218;
const TOPIC_RING = 104;
const DOMAIN_R = 34;
const TOPIC_R = 16;

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
  knowledgePoints.forEach((kp, di) => {
    const ang = -Math.PI / 2 + (di * 2 * Math.PI) / knowledgePoints.length;
    const dx = CX + DOMAIN_RING * Math.cos(ang) * 1.12;
    const dy = CY + DOMAIN_RING * Math.sin(ang) * 0.82;
    nodes.push({
      id: kp.id,
      kpId: kp.id,
      kind: 'domain',
      label: kp.name,
      x: dx,
      y: dy,
      r: DOMAIN_R,
      labelX: dx,
      labelY: dy + DOMAIN_R + 17,
      labelAnchor: 'middle',
    });
    /* 子节点：朝外扇形展开（加宽扇角，标签沿径向朝外摆放避免重叠） */
    kp.coreTopics.slice(0, 4).forEach((_, ti) => {
      const spread = Math.PI / 2.5;
      const a2 = ang - spread / 2 + (ti * spread) / 3;
      const c = Math.cos(a2);
      const s = Math.sin(a2);
      const tx = dx + TOPIC_RING * c * 1.18;
      const ty = dy + TOPIC_RING * s * 0.92;
      /* 标签锚点与偏移：按外向方向决定放在左/右/上/下。
         注意：植物会从花坛顶部探出约 1.4×TOPIC_R，故上方标签要留足净空，否则被叶子压住 */
      let labelAnchor: 'start' | 'middle' | 'end' = 'middle';
      let labelX = tx;
      let labelY = ty + 4;
      if (c > 0.35) {
        labelAnchor = 'start';
        labelX = tx + TOPIC_R + 6;
      } else if (c < -0.35) {
        labelAnchor = 'end';
        labelX = tx - TOPIC_R - 6;
      }
      if (s > 0.35) {
        labelY = ty + TOPIC_R + 13;
      } else if (s < -0.35) {
        labelY = ty - TOPIC_R - 20;   // 让开探出的植株
      }
      nodes.push({
        id: `${kp.id}-t${ti}`,
        kpId: kp.id,
        kind: 'topic',
        label: shortLabels[kp.id]?.[ti] ?? kp.coreTopics[ti],
        topicIndex: ti,
        x: tx,
        y: ty,
        r: TOPIC_R,
        labelX,
        labelY,
        labelAnchor,
      });
    });
  });
  return nodes;
}

export const graphNodes: GraphNode[] = buildNodes();
export const graphViewBox = { w: 920, h: 660 };

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
