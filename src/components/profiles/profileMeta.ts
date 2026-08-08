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
    certificate: 'CET-6 · 计算机二级',
    blindWall: [
      { label: '故障诊断实操', severity: '高', evidence: '理论测试 §故障诊断 得分 47 · 近 3 次实操练习正确率 38%' },
      { label: '传感器标定实操', severity: '高', evidence: '理论测试 §传感器标定 得分 42 · 标定实操打卡 0/5 次' },
      { label: '视觉引导应用', severity: '中', evidence: '理论测试 §视觉引导 得分 51 · 尚未开始专项训练' },
      { label: 'PLC 通讯组态', severity: '低', evidence: '理论测试 §PLC 编程 得分 58 · 联锁案例练习 2/6' },
    ],
    pathChips: ['① 标定实操精讲', '② 故障树诊断案例', '③ 综合考核'],
  },
  chen: {
    bandLabel: '实操型 · 动手强',
    bandColor: '#E7B45A',
    bandBg: '#F8ECD2',
    workExp: '实训 480 学时',
    certificate: '1+X 初级备考中',
    blindWall: [
      { label: '运动学正逆解', severity: '高', evidence: '理论测试 §机器人运动学 得分 45 · 近 3 次练习正确率 41%' },
      { label: 'DH 参数建模', severity: '高', evidence: '随堂测验 §DH 建模 得分 38 · 公式推导题放弃率 62%' },
      { label: 'PLC 结构化编程', severity: '中', evidence: '理论测试 §PLC 编程 得分 61 · 梯形图作业完成 4/6' },
      { label: '标定原理', severity: '中', evidence: '理论测试 §传感器标定 得分 66 · 实操优秀 / 原理待补' },
    ],
    pathChips: ['① 坐标系图解入门', '② 运动学分阶闯关', '③ 省赛综合实训'],
  },
  zhao: {
    bandLabel: '经验型 · 转型中',
    bandColor: '#B77552',
    bandBg: '#F4E7DC',
    workExp: '15 年传统产线维护',
    certificate: '电工中级证 · 设备主管',
    blindWall: [
      { label: '视觉引导', severity: '高', evidence: '理论测试 §视觉引导 得分 44 · 转岗新领域零基础' },
      { label: '手眼标定', severity: '高', evidence: 'AX=XB 求解测验正确率 35% · 案例迁移学习进行中' },
      { label: '协作机器人功率与力限制', severity: '中', evidence: '理论测试 §安全规范 得分 85 · 协作条款为新增内容' },
      { label: '离线编程', severity: '低', evidence: '尚未开始 · 已排入第 4 周学习路径' },
    ],
    pathChips: ['① 手眼标定迁移课', '② 坐标变换工程直觉', '③ 工作站运维认证'],
  },
};

/** 六维理论测试错题摘要（按知识点，页面本地 Mock，KB 溯源取 kbSlicesByKp 前三条） */
export const wrongNotesByKp: Record<string, string[]> = {
  'kp-plc': [
    '安全门联锁回路的常闭触点串接逻辑写反，导致仿真急停失效',
    'PROFINET 设备名未与组态一致，I/O 映射全部漂移到下一槽位',
    'ST 语言中定时器 ENO 链式使用条件判断遗漏',
  ],
  'kp-kinematics': [
    'D-H 参数表中 α 扭转角符号约定混淆，正解矩阵整体错位',
    '逆解多解分支选择未考虑奇异位形，仿真轨迹穿越关节极限',
    '工件坐标系与工具坐标系复合变换顺序写反',
  ],
  'kp-sensor': [
    '位姿准确度与重复定位精度概念混淆，验收指标引用错误',
    '温度漂移补偿系数直接套用出厂值，未按实测区间重新拟合',
    '零点标定第 3 步精对零顺序错误，J2/J3 未用百分表找正',
  ],
  'kp-vision': [
    '手眼标定 AX=XB 方程组采集姿态数量不足，解算发散',
    '特征匹配阈值设置过高，低对比度工件定位丢失',
    '曝光与增益未随现场光照标定，分拣抓取位姿漂移',
  ],
  'kp-safety': [
    '风险评估三步法中「风险估计」等级漏评低频高危项',
    '协作运行功率与力限制阈值引用过期版本标准',
    '急停复位后自动重启条件判断与安全回路规范不符',
  ],
  'kp-diagnosis': [
    '报警代码分级读取错误，将警告级误判为停机级',
    '故障树最小割集求解漏掉共因失效分支',
    '减速器振动频谱特征频率计算用错齿数参数',
  ],
};

/** 对比视图三人配色（墨绿/琥珀/暖赭） */
export const compareColors: Record<string, string> = {
  lin: '#4E7860',
  chen: '#E7B45A',
  zhao: '#B77552',
};

/** 目标能力模型加权综合分（可计算画像向量），权重取 knowledgePoints.weight */
export function weightedScore(learner: { scores: Record<string, number> }): number {
  const total = knowledgePoints.reduce(
    (acc, kp) => acc + (learner.scores[kp.id] ?? 0) * kp.weight,
    0,
  );
  return Math.round(total);
}
