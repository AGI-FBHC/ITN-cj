/**
 * 个性化生成资源 — 3 画像 × 3 形态（定制讲义 / 实操指南 / 分阶题）
 * 内容为 GEN-03「已生成」的成品 Mock，全部携带 KB 溯源
 */

export type ResourceForm = 'lecture' | 'guide' | 'quiz';

export interface GuideStep {
  title: string;
  desc: string;
  kbRefs?: string[];
  warning?: string;
  /** 安全等级标注（可选，向后兼容）：safe 常规操作 / caution 注意事项 / danger 高危步骤 */
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
  /** lecture：Markdown 讲义 */
  markdown?: string;
  /** guide：实操步骤 */
  steps?: GuideStep[];
  safetyNotice?: string;
  /** quiz：引用 quizBank 题目 */
  quizIds?: string[];
  quizSummary?: { basic: number; advanced: number; challenge: number };
  kbRefs: string[];
}

/* ---------------- 林晓舟：零基础讲义 ---------------- */
const linLecture = `## 1. 为什么标定是运维的第一课

机器人每完成一次抓取，依赖的都是「控制器以为的位置」与「真实位置」的一致。出厂半年后，减速器磨损、温度漂移与拆装都会让两者悄悄分离 —— 这就是**位姿准确度**下降 [KB-007]。

> 位姿准确度 AP：指令位姿与实到位姿集群重心之间的偏差。试验须在额定负载、最大速度的 100%/50%/10% 下对立方体五点位姿各测 30 次 [KB-007]。

零基础阶段只需记住一句话：**标定 = 用更高精度的测量，把「以为」拉回「真实」。**

## 2. 零点标定五步法（认知版）

1. **回零准备**：各轴点动至机械零位刻线附近，确认工装已卸载 [KB-018]；
2. **粗对零**：对齐各轴零点刻线，错位不得超过刻度一格 [KB-018]；
3. **精对零**：用百分表/标定块找正 J2、J3 关键轴 [KB-014]；
4. **写入零点**：示教器执行零点设定并记录初始编码器值；
5. **验证**：跑 10 个教学点复测，TCP 偏移应 < 0.5 mm [KB-021]。

## 3. 温度漂移：冬天早班的隐形偏差

车间夜停降温后，金属构件收缩会让零点「漂移」。某焊装线实测：8℃ 环境下 TCP 偏移达 1.8 mm，引入 10 min 低速预热 + 温度补偿系数 k=0.021°/10℃ 后，首件合格率恢复 99.6% [KB-021]。

补偿模型 \\(\\Delta\\theta = k(T-T_0)\\) 为线性近似，**适用区间 10–35℃**；超出区间须按五点恒温实验重新拟合 [KB-014]。

## 4. 小结与自测

- 位姿准确度 vs 重复定位精度：前者是「准不准」，后者是「稳不稳」[KB-007]；
- 零点刻线错位不得超过一格 [KB-018]；
- 完成本讲讲义后，建议进入《运动学 12 题》基础 4 题自测 [KB-009]。`;

/* ---------------- 陈雨桐：实操导向 ---------------- */
const chenLecture = `## 1. 你会操作，现在补一层「为什么」

你已经在示教器上跑过搬运程序。这一讲只回答一个问题：**为什么老师傅每次换夹具后都要「重新对一下点」？** 答案藏在工具坐标系（TCP）里 [KB-002]。

> 工具坐标系原点定义在工具中心点；绕 X/Y/Z 的旋转依次为 RX、RY、RZ，正方向遵从右手定则 [KB-002]。

## 2. 三步看懂 TCP 标定（图解版）

1. **撞针法**：让夹具尖端从 4 个不同姿态去碰同一固定尖点 —— 机器人借此解出 TCP 位置；
2. **方向标定**：再取 2 个姿态确定工具 X、Z 方向；
3. **验证**：绕 TCP 做姿态摆动，尖端应「纹丝不动」。

> 安全警示：示教模式下 TCP 速度不得超过 250 mm/s，操作时右手始终放在急停上方 [KB-005]。

## 3. 和万用表一个道理

TCP 标定就像你用万用表前「校零」：表笔短接调零，测量才准；机器人认准 TCP，轨迹才准。下次师傅再对点，你就能说出他标的是哪个坐标系 [KB-025]。

## 4. 动手任务

按《六轴臂零点标定五步实操》完成一次完整回零并拍照记录刻线对齐状态，上传实训报告 [KB-018]。`;

/* ---------------- 赵鸿：案例对照进阶 ---------------- */
const zhaoLecture = `## 1. 从 PLC 到机器人：你只差一个「坐标系」

15 年电气经验让你对联锁与报警体系驾轻就熟。机器人运维的新知识其实只有一块：**多轴联动的空间坐标变换**。PLC 处理的是布尔量，机器人处理的是 4×4 齐次变换矩阵 [KB-009]。

## 2. 案例对照：焊装线零点漂移处置（2024）

某合资车企焊装工厂，冬季早班焊点偏移 1.8 mm。排查链与你熟悉的电气排障完全同构：

| 步骤 | 电气排障（你的经验） | 本次机器人排障 |
|---|---|---|
| 复现 | 报警是否可复现 | 早班必现、午后消失 |
| 定位 | 分段短接缩小范围 | 判定 J2/J3 零点漂移 |
| 根因 | 触点氧化/线缆断股 | 低温 8℃ 致构件收缩 |
| 处置 | 更换+点检周期 | 预热程序+补偿系数 k=0.021°/10℃ [KB-021] |

首件合格率由 96.1% 恢复至 99.6% [KB-021]。

## 3. 进阶：手眼标定 AX=XB

视觉引导工作站的核心方程是 AX=XB。工程要点：采集 12–20 组姿态，旋转运动大于 30°，避免纯平移导致解退化；推荐对偶四元数法，重投影误差最低 [KB-011]。

> 提示：你的 PROFINET 排障经验可直接迁移到视觉通讯 —— 相机触发丢帧与丢站的排查链同构 [KB-026]。

## 4. 自测与路径

建议完成《视觉引导分阶题》进阶 5 题；随后进入手眼标定实操 [KB-011]。`;

const guideStepsLin: GuideStep[] = [
  { title: '回零准备', desc: '卸载工装，各轴点动至机械零位刻线附近，确认示教器处于 T1 手动模式。', kbRefs: ['KB-018'], warning: 'T1 模式下 TCP 速度 ≤ 250 mm/s [KB-005]', safety: 'caution' },
  { title: '粗对零', desc: '目视对齐各轴零点刻线，错位不得超过刻度一格，从 J1 到 J6 逐轴确认。', kbRefs: ['KB-018'], safety: 'safe' },
  { title: '精对零', desc: 'J2、J3 轴用百分表找正标定块，表针读数波动 ≤ 0.02 mm 视为到位。', kbRefs: ['KB-014'], safety: 'safe' },
  { title: '写入零点', desc: '示教器进入零点设定界面逐轴写入，记录各轴初始编码器值并拍照存档。', kbRefs: ['KB-018'], safety: 'safe' },
  { title: '复测验证', desc: '运行 10 个教学点复测 TCP 偏移，< 0.5 mm 为合格；超差则回到第 2 步。', kbRefs: ['KB-021', 'KB-007'], safety: 'safe' },
];

const guideStepsChen: GuideStep[] = [
  { title: '安全确认', desc: '佩戴工牌，确认围栏门联锁有效、急停可及；报告指导教师后上电。', kbRefs: ['KB-005', 'KB-012'], warning: '联锁失效不得强行短接 [KB-012]', safety: 'danger' },
  { title: '回零准备', desc: '卸下夹爪工装，各轴点动回零位；万用表确认控制柜电压正常。', kbRefs: ['KB-018'], safety: 'safe' },
  { title: '刻线对齐', desc: '逐轴对齐零点刻线并打钩记录，J2/J3 请同伴互检。', kbRefs: ['KB-018'], safety: 'safe' },
  { title: '写入与记录', desc: '示教器写入零点，实训记录本登记编码器值与室温。', kbRefs: ['KB-014'], safety: 'safe' },
  { title: '抽点复测', desc: '任选 5 个示教点运行复测，偏移 < 0.5 mm 方可签字确认。', kbRefs: ['KB-021'], safety: 'safe' },
];

const guideStepsZhao: GuideStep[] = [
  { title: '风险评估', desc: '按三步法评估标定作业：危险识别 → 风险估计 → 防护确认，填 JHA 表。', kbRefs: ['KB-012'], safety: 'caution' },
  { title: '热态确认', desc: '记录车间温度；<10℃ 时先执行 10 min 低速预热程序再标定。', kbRefs: ['KB-021', 'KB-010'], safety: 'safe' },
  { title: '高精度找正', desc: '激光跟踪仪或百分表找正关键轴，测量系统不确定度优于指标 25%。', kbRefs: ['KB-017', 'KB-010'], safety: 'caution' },
  { title: '写入与补偿', desc: '写入零点并设定温度补偿系数 k=0.021°/10℃（按实测拟合修订）。', kbRefs: ['KB-021', 'KB-014'], safety: 'safe' },
  { title: '验收归档', desc: '按 JB/T 8896 做零点复归检查与 8h 连续运行考核，数据归档至设备台账。', kbRefs: ['KB-018'], safety: 'safe' },
];

export const resources: GeneratedResource[] = [
  // —— 林晓舟 ——
  {
    learnerId: 'lin', form: 'lecture',
    title: '《传感器标定精要 · 零基础版》',
    levelTag: '零基础', kpId: 'kp-sensor', version: 'v2', updatedAt: '2025-06-12 10:41',
    markdown: linLecture,
    kbRefs: ['KB-007', 'KB-014', 'KB-021'],
  },
  {
    learnerId: 'lin', form: 'guide',
    title: '《六轴臂零点标定五步实操》',
    levelTag: '认知实操', kpId: 'kp-sensor', version: 'v1', updatedAt: '2025-06-12 10:43',
    steps: guideStepsLin,
    safetyNotice: '全程 T1 手动模式，TCP ≤ 250 mm/s；急停装置须保持可及 [KB-005]。',
    kbRefs: ['KB-002', 'KB-018'],
  },
  {
    learnerId: 'lin', form: 'quiz',
    title: '《运动学 12 题 · 基础4/进阶5/挑战3》',
    levelTag: '分阶', kpId: 'kp-kinematics', version: 'v1', updatedAt: '2025-06-12 10:45',
    quizIds: ['q-01', 'q-02', 'q-03', 'q-04', 'q-05', 'q-06', 'q-07', 'q-08', 'q-09', 'q-10', 'q-11', 'q-12'],
    quizSummary: { basic: 4, advanced: 5, challenge: 3 },
    kbRefs: ['KB-009', 'KB-011'],
  },
  // —— 陈雨桐 ——
  {
    learnerId: 'chen', form: 'lecture',
    title: '《TCP 标定三步看懂 · 实操生图解版》',
    levelTag: '图解入门', kpId: 'kp-kinematics', version: 'v1', updatedAt: '2025-06-12 09:58',
    markdown: chenLecture,
    kbRefs: ['KB-002', 'KB-005', 'KB-025'],
  },
  {
    learnerId: 'chen', form: 'guide',
    title: '《零点回位五步法 · 实训打卡版》',
    levelTag: '实训实操', kpId: 'kp-sensor', version: 'v1', updatedAt: '2025-06-12 10:02',
    steps: guideStepsChen,
    safetyNotice: '围栏联锁与急停先行确认；互检签字后方可上电 [KB-012]。',
    kbRefs: ['KB-018', 'KB-005'],
  },
  {
    learnerId: 'chen', form: 'quiz',
    title: '《安全+运动学 10 题 · 基础5/进阶4/挑战1》',
    levelTag: '分阶', kpId: 'kp-safety', version: 'v1', updatedAt: '2025-06-12 10:05',
    quizIds: ['q-13', 'q-14', 'q-02', 'q-15', 'q-05', 'q-16', 'q-07', 'q-17', 'q-09', 'q-18'],
    quizSummary: { basic: 5, advanced: 4, challenge: 1 },
    kbRefs: ['KB-005', 'KB-009'],
  },
  // —— 赵鸿 ——
  {
    learnerId: 'zhao', form: 'lecture',
    title: '《手眼标定案例对照 · 转岗迁移版》',
    levelTag: '进阶迁移', kpId: 'kp-vision', version: 'v2', updatedAt: '2025-06-12 11:20',
    markdown: zhaoLecture,
    kbRefs: ['KB-011', 'KB-021', 'KB-009'],
  },
  {
    learnerId: 'zhao', form: 'guide',
    title: '《高精度标定五步法 · 工程师版》',
    levelTag: '进阶实操', kpId: 'kp-sensor', version: 'v1', updatedAt: '2025-06-12 11:24',
    steps: guideStepsZhao,
    safetyNotice: '标定前完成 JHA 风险评估；激光测量期间设立隔离区 [KB-012]。',
    kbRefs: ['KB-017', 'KB-010'],
  },
  {
    learnerId: 'zhao', form: 'quiz',
    title: '《视觉引导 10 题 · 基础3/进阶5/挑战2》',
    levelTag: '分阶', kpId: 'kp-vision', version: 'v1', updatedAt: '2025-06-12 11:28',
    quizIds: ['q-19', 'q-20', 'q-04', 'q-21', 'q-08', 'q-22', 'q-10', 'q-23', 'q-11', 'q-24'],
    quizSummary: { basic: 3, advanced: 5, challenge: 2 },
    kbRefs: ['KB-011', 'KB-004'],
  },
];

export const getResourcesFor = (learnerId: string): GeneratedResource[] =>
  resources.filter((r) => r.learnerId === learnerId);

export const getResource = (learnerId: string, form: ResourceForm): GeneratedResource | undefined =>
  resources.find((r) => r.learnerId === learnerId && r.form === form);

/** 某知识点在该学习者名下已生成的成品资源（讲义/实操/分阶题，可能 0~多个） */
export const resourcesForKp = (learnerId: string, kpId: string): GeneratedResource[] =>
  resources.filter((r) => r.learnerId === learnerId && r.kpId === kpId);

/**
 * 学习跳转目标解析：
 * - 若该知识点有预生成资源 → 打开资源页对应形态 Tab
 * - 否则回退到交互课件（GEN-03 现场拼装），逻辑自洽于「每讲现做」
 */
export interface LearnTarget {
  to: string;
  kind: 'resource' | 'courseware';
  form?: ResourceForm;
}

/** 按路径节点标题的语义挑资源形态：实操→guide、题/测→quiz、其余→讲义/首个 */
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
