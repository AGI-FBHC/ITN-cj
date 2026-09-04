/**
 * 画像页本地展示数据（非全局数据层成员，仅页面呈现用）
 * 理论测试 6 维成绩 / 盲区 / 风格等事实数据一律取自 src/data/learners.ts，
 * 此处仅补充数据层未覆盖的展示字段：标签带、工龄/持证、盲区严重度、错题摘要等。
 */
import { knowledgePoints } from '@/data/knowledgePoints';

export type Severity = '高' | '中' | '低';

export interface BlindWallItem {
  label: string;
  severity: Severity;
  /** hover tooltip 诊断依据 */
  evidence: string;
}

export interface LearnerUiMeta {
  /** 卡顶标签带文案 */
  bandLabel: string;
  /** 标签带主色（墨绿/琥珀/暖赭） */
  bandColor: string;
  bandBg: string;
  /** 先验知识档案：工龄/实训 */
  workExp: string;
  /** 先验知识档案：持证 */
  certificate: string;
  blindWall: BlindWallItem[];
  /** 诊断报告底部推荐路径 chips */
  pathChips: string[];
}

export const learnerUiMeta: Record<string, LearnerUiMeta> = {
  lin: {
    bandLabel: '学术型 · 理论强',
    bandColor: '#4E7860',
    bandBg: '#DFEDE4',
    workExp: '无工龄 · 应届生',
    certificate: 'CET-6 · 计算机等级证书',
    blindWall: [
      { label: 'Agent 工具调用实操', severity: '高', evidence: '理论测试 §工具调用 得分 47 · 近 3 次实操练习正确率 38%' },
      { label: 'RAG 检索链路实操', severity: '高', evidence: '理论测试 §RAG 检索 得分 42 · 实操打卡 0/5 次' },
      { label: '多智能体协作', severity: '中', evidence: '理论测试 §多智能体 得分 51 · 尚未开始专项训练' },
      { label: 'Agent 工程交付', severity: '低', evidence: '理论测试 §Agent 工程 得分 58 · 交付案例练习 2/6' },
    ],
    pathChips: ['① 工具调用实操', '② RAG 检索诊断案例', '③ 综合能力校验'],
  },
  chen: {
    bandLabel: '实操型 · 动手强',
    bandColor: '#E7B45A',
    bandBg: '#F8ECD2',
    workExp: '实训 480 学时',
    certificate: 'CET-4 · AI 应用证书备考中',
    blindWall: [
      { label: 'Agent 流程推理', severity: '高', evidence: '理论测试 §Agent 流程 得分 45 · 近 3 次练习正确率 41%' },
      { label: '系统设计', severity: '高', evidence: '随堂测验 §系统设计 得分 38 · 方案题放弃率 62%' },
      { label: '上下文工程', severity: '中', evidence: '理论测试 §上下文 得分 61 · 案例作业完成 4/6' },
      { label: '知识理解', severity: '中', evidence: '理论测试 §概念理解 得分 66 · 概念讲解优秀 / 推理待补' },
    ],
    pathChips: ['① Agent 概念图解', '② 流程推理分阶闯关', '③ 多智能体综合实训'],
  },
  zhao: {
    bandLabel: '经验型 · 转型中',
    bandColor: '#B77552',
    bandBg: '#F4E7DC',
    workExp: '15 年 IT 运维经验',
    certificate: '服务端运维 · 中级',
    blindWall: [
      { label: 'Agent 基础概念', severity: '高', evidence: '理论测试 §Agent 基础 得分 44 · 转岗新领域零基础' },
      { label: '上下文工程', severity: '高', evidence: '上下文设计测验正确率 35% · 案例迁移学习进行中' },
      { label: '多智能体协作', severity: '中', evidence: '理论测试 §多智能体 得分 85 · 协作条款为新增内容' },
      { label: 'Agent 工具调试', severity: '低', evidence: '尚未开始 · 已排入第 4 周学习路径' },
    ],
    pathChips: ['① Agent 概念迁移课', '② 上下文工程直觉', '③ 工程化运维认证'],
  },
};

/** 六维理论测试错题摘要（按知识点，页面本地 Mock，KB 溯源取 kbSlicesByKp 前三条） */
export const wrongNotesByKp: Record<string, string[]> = {
  'kp-ds': [
    '混淆 L L M 与 Agent 的边界，把模型能力直接当成系统能力',
    '对 RAG、上下文工程等概念理解停留在名词表面',
    '忽视提示与工具对智能体行为边界的共同约束',
  ],
  'kp-co': [
    '多智能体协作时遗漏条件分支，导致工具调用路径不确定',
    '对 Agent 流程中异常分支的判断顺序混乱',
    '将串行流程误判为可并行协同，状态依赖分析缺失',
  ],
  'kp-os': [
    '调用工具时参数与权限校验不完整，导致安全边界被绕过',
    '调试智能体应用时未先记录输入与日志，定位链路缺失',
    '交付时忽略配置化与测试步骤，迭代成本上升',
  ],
  'kp-network': [
    'RAG 召回为空时没有先区分文档切分、向量检索还是查询改写问题',
    '上下文超限被误判为模型幻觉，缺少证据链分析',
    '排查链路未记录检索分数与来源文档，归因困难',
  ],
  'kp-db': [
    '设计记忆与知识库时未考虑更新一致性与过期策略',
    '接口拆分的职责边界不清，导致多智能体协作冲突',
    '对可靠性要求只考虑单点实现，缺少回退与重试方案',
  ],
  'kp-agent': [
    '接触新工具时直接套用旧 API 写法，未先读权限与返回值结构',
    '新场景迁移缺少最小验证，方案落地前未做局部试验',
    '把已有流程硬映射到新框架，忽略生态差异与约束',
  ],
};

/** 对比视图三人配色（墨绿/琥珀/暖赭） */
export const compareColors: Record<string, string> = {
  lin: '#4E7860',
  chen: '#E7B45A',
  zhao: '#B77552',
};

/** 目标能力模型加权综合分（可计算画像向量），权重取 knowledgePoints.weight */
export function weightedScore(
  learner: { scores: Record<string, number> },
  points: { id: string; weight: number }[] = knowledgePoints,
): number {
  const total = points.reduce(
    (acc, kp) => acc + (learner.scores[kp.id] ?? 0) * kp.weight,
    0,
  );
  return Math.round(total);
}
