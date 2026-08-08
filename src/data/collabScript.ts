/**
 * 协同演示脚本 — 协同调度页泳道消息流 + 总览页动态流数据源
 * ~16 条带时间偏移的消息事件，含 2 轮辩论 + 仲裁决议
 * 按当前画像替换聚焦知识点与资源标题
 */

import type { AgentId } from './agents';
import { getLearner, weakestKpOf } from './learners';
import { getKnowledgePoint } from './knowledgePoints';

export type CollabEventType =
  | 'message'    // 常规消息
  | 'handoff'    // 任务交接
  | 'debate'     // 辩论发言
  | 'revision'   // 修订
  | 'verdict'    // 审核裁定
  | 'decision';  // 仲裁决议

export interface CollabEvent {
  /** 相对播放起点的时间偏移（秒） */
  t: number;
  from: AgentId;
  to: AgentId | 'ALL';
  type: CollabEventType;
  content: string;
  payload?: string;
  kbRefs?: string[];
  /** 辩论轮次（仅 debate 类型） */
  round?: 1 | 2 | 3;
}

export interface CollabScript {
  topic: string;
  learnerId: string;
  kpId: string;
  kpName: string;
  resourceTitle: string;
  events: CollabEvent[];
}

export function getCollabScript(learnerId: string): CollabScript {
  const learner = getLearner(learnerId);
  const kpId = weakestKpOf(learner);
  const kp = getKnowledgePoint(kpId);
  const topic = `${kp.name} · 个性化资源生成`;
  const resourceTitle =
    learnerId === 'chen'
      ? '《六轴臂零点标定五步实操》'
      : learnerId === 'zhao'
        ? '《手眼标定案例对照 · 迁移版》'
        : '《传感器标定精要 · 零基础版》';

  const events: CollabEvent[] = [
    { t: 0.0, from: 'DIA-01', to: 'ARB-05', type: 'message',
      content: `画像向量已更新：${learner.name} · ${kp.name}维度 ${learner.scores[kpId]} 分（目标 ${kp.targetLevel}），盲区标签「${learner.blindSpots[0]}」`,
      payload: `profile_vector = [${Object.values(learner.scores).join(', ')}] · target = ${kp.targetLevel} · gap = ${kp.targetLevel - learner.scores[kpId]}` },
    { t: 1.6, from: 'ARB-05', to: 'ALL', type: 'decision',
      content: `立项：为 ${learner.name} 生成「${kp.name}」个性化资源包，目标形态 3 种，截止本周期`,
      payload: `task_id = T-20250612-0047 · priority = HIGH · forms = [讲义, 实操指南, 分阶题]` },
    { t: 3.2, from: 'ARB-05', to: 'RET-02', type: 'handoff',
      content: `下发检索指令：${kp.name} · 优先国标/行标，可信度 ≥ 0.85`,
      payload: `query = "${kp.name} 标定 验收" · filter = {type: [国标, 行标], credibility ≥ 0.85}` },
    { t: 4.8, from: 'RET-02', to: 'ARB-05', type: 'message',
      content: '命中 23 条切片，采纳可信度 Top-6：KB-007 / KB-014 / KB-021 / KB-002 / KB-018 / KB-010',
      payload: 'hits = 2356 → 23 → 6 · top_credibility = 0.99 (GB/T 12642-2013)',
      kbRefs: ['KB-007', 'KB-014'] },
    { t: 6.4, from: 'ARB-05', to: 'GEN-03', type: 'handoff',
      content: `转发 6 条切片，开始约束生成${resourceTitle}初稿`,
      payload: 'constraint = 每个论断必须挂接 KB 溯源角标 · style = 画像适配',
      kbRefs: ['KB-007', 'KB-021'] },
    { t: 8.2, from: 'GEN-03', to: 'VER-04', type: 'message',
      content: '讲义草稿 v1 完成：§1 标定原理 / §2 五步法 / §3 温度补偿，共挂接溯源 14 处',
      payload: 'draft_v1.md · 3,842 字 · trace_count = 14 · est_level = 零基础适配 0.91',
      kbRefs: ['KB-007', 'KB-014', 'KB-021'] },
    { t: 10.0, from: 'VER-04', to: 'GEN-03', type: 'debate', round: 1,
      content: 'R1 质询：§2.3「重复定位精度 ±0.02 mm」未见出处，且未注明试验条件（负载/速度），违反 KB-007 试验条款',
      payload: 'challenge = missing_citation · clause = GB/T 12642-2013 §7.2',
      kbRefs: ['KB-007'] },
    { t: 11.8, from: 'GEN-03', to: 'VER-04', type: 'debate', round: 1,
      content: 'R1 应答：参数引自 KB-021 企业案例实测，但确未标注试验条件 —— 接受质询，补充「额定负载·最大速度 50%」限定并改挂 KB-007',
      payload: 'revision = §2.3 ±0.02mm → 附条件限定 + trace [KB-007]',
      kbRefs: ['KB-007', 'KB-021'] },
    { t: 13.6, from: 'GEN-03', to: 'VER-04', type: 'revision',
      content: '草稿 v2 提交：§2.3 修订完成，新增「温度补偿系数 k=0.021°/10℃」脚注 [KB-021]',
      payload: 'diff = 2 处修订 · trace_count 14 → 15',
      kbRefs: ['KB-021'] },
    { t: 15.4, from: 'VER-04', to: 'GEN-03', type: 'debate', round: 2,
      content: 'R2 质询：§3 温度补偿模型 Δθ=k(T−T₀) 线性假设在 <10℃ 区间的适用性存疑，KB-014 指出需五点恒温实验拟合',
      payload: 'challenge = assumption_scope · clause = KB-014 §6.4',
      kbRefs: ['KB-014'] },
    { t: 17.2, from: 'GEN-03', to: 'VER-04', type: 'debate', round: 2,
      content: 'R2 应答：接受。增加适用区间说明「10–35℃」并注明超出区间需重新拟合 —— 幻觉拦截 1 处（原稿未限区间）',
      payload: 'revision = §3 增加适用区间 · hallucination_blocked = 1',
      kbRefs: ['KB-014'] },
    { t: 19.0, from: 'VER-04', to: 'ARB-05', type: 'verdict',
      content: '交叉验证通过：草稿 v2 全部 15 处溯源可回溯，无无出处参数，建议采纳',
      payload: 'verify = PASS · citations 15/15 · hallucination = 0',
      kbRefs: ['KB-007'] },
    { t: 20.6, from: 'ARB-05', to: 'ALL', type: 'decision',
      content: `决议：采纳${resourceTitle} v2，置信度 0.96；同步生成实操指南与分阶题`,
      payload: 'adopt = draft_v2 · confidence = 0.96 · downstream = [guide, quiz]' },
    { t: 22.4, from: 'GEN-03', to: 'ARB-05', type: 'message',
      content: '实操指南 5 步 + 分阶题 12 题生成完毕，全部通过 VER-04 快速复核',
      payload: 'guide = 5 steps · quiz = 12 (基础4/进阶5/挑战3) · fast_verify = PASS',
      kbRefs: ['KB-018', 'KB-009'] },
    { t: 24.0, from: 'DIA-01', to: 'ARB-05', type: 'message',
      content: `追踪埋点已布设：${learner.name} 完成首测后正确率将实时回流，触发降维/进阶判定`,
      payload: 'tracking = quiz_first_pass · threshold = {降维 < 60%, 进阶 ≥ 85%}' },
    { t: 25.6, from: 'ARB-05', to: 'DIA-01', type: 'decision',
      content: '闭环确认：资源包已发布至学习者工作台，等待交互反馈以更新画像 —— 本轮协同结束',
      payload: 'loop = closed · next = tutoring_feedback · duration = 25.6s' },
  ];

  return { topic, learnerId, kpId, kpName: kp.name, resourceTitle, events };
}

/** 总览页 S5 实时动态流样本（24 条循环） */
export interface LiveFeedSample {
  agent: AgentId;
  content: string;
  kbRef?: string;
  payload: string;
}

export const liveFeedSamples: LiveFeedSample[] = [
  { agent: 'GEN-03', content: '生成《传感器标定》讲义 §2.3 已附 6 条溯源', kbRef: 'KB-007', payload: 'draft §2.3 · trace +6 · words 412' },
  { agent: 'VER-04', content: '拦截 1 处无出处参数（温度补偿系数）→ 退回修订', kbRef: 'KB-014', payload: 'block · reason = missing_citation' },
  { agent: 'RET-02', content: '命中 KB-007 · GB/T 12642-2013 位姿准确度条款', kbRef: 'KB-007', payload: 'semantic_score = 0.94' },
  { agent: 'DIA-01', content: '林晓舟 画像更新：运动学维度 58 → 64', payload: 'delta +6 · trigger = quiz_pass' },
  { agent: 'ARB-05', content: '决议：采纳讲义 v2，置信度 0.96', payload: 'adopt · confidence 0.96' },
  { agent: 'GEN-03', content: '分阶题「运动学 12 题」挑战级 3 题已挂 KB-022', kbRef: 'KB-022', payload: 'quiz gen · level3 ×3' },
  { agent: 'RET-02', content: '检索「手眼标定」命中 18 条，采纳 KB-011', kbRef: 'KB-011', payload: 'hits 18 → 1' },
  { agent: 'VER-04', content: '复核实操指南安全警示条，引用 KB-005 限速条款', kbRef: 'KB-005', payload: 'verify PASS · 250mm/s' },
  { agent: 'DIA-01', content: '陈雨桐 实操偏好权重上调 0.12 → 资源形态重排', payload: 'style = hands-on 0.78' },
  { agent: 'ARB-05', content: '决策：赵鸿 正确率 43% → 下发「降维解释」', payload: 'decision = simplify' },
  { agent: 'GEN-03', content: '《PLC 联锁》讲义为赵鸿切换「案例对照」模板', kbRef: 'KB-015', payload: 'template = case-compare' },
  { agent: 'RET-02', content: '命中 KB-018 · JB/T 8896-1999 零点复归检查', kbRef: 'KB-018', payload: 'std_hit · cred 0.93' },
  { agent: 'VER-04', content: '辩论 R2 发起：线性补偿模型适用区间存疑', kbRef: 'KB-014', payload: 'challenge · scope' },
  { agent: 'GEN-03', content: '接受质询，§3 增补适用区间 10–35℃', kbRef: 'KB-014', payload: 'revision accepted' },
  { agent: 'DIA-01', content: '今日第 47 次协同立项：视觉引导资源包', payload: 'task T-20250612-0047' },
  { agent: 'ARB-05', content: '决议：采纳零点标定实操指南，发布至陈雨桐', payload: 'publish · guide_v1' },
  { agent: 'RET-02', content: '命中 KB-021 · 焊装线零点漂移温度补偿案例', kbRef: 'KB-021', payload: 'case_hit · 2024' },
  { agent: 'VER-04', content: '幻觉拦截：「重复精度 ±0.01mm」超出标准试验数据', kbRef: 'KB-007', payload: 'block · overclaim' },
  { agent: 'GEN-03', content: '讲义脚注同步更新：新增 KB-010 试验环境条款', kbRef: 'KB-010', payload: 'footnote +1' },
  { agent: 'DIA-01', content: '赵鸿 盲区排序刷新：视觉引导 44 → 仍居首', payload: 'rank update · vision #1' },
  { agent: 'ARB-05', content: '今日协同 47 次 · 平均耗时 0.8s · 全链路正常', payload: 'daily stat' },
  { agent: 'GEN-03', content: '《安全规范精讲》讲义更新 GB 11291.1 引用', kbRef: 'KB-005', payload: 'sync std ref' },
  { agent: 'RET-02', content: '检索「预测性维护」采纳 KB-020 振动阈值', kbRef: 'KB-020', payload: 'paper_hit · cred 0.88' },
  { agent: 'VER-04', content: '快速复核通过：分阶题解析 12/12 可回溯', payload: 'fast_verify PASS' },
];
