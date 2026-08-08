/**
 * 分阶测试题库 — 基础 / 进阶 / 挑战 三级
 * 每题含解析与 KB 溯源引用，供资源页与导学页共用
 */

export type QuizLevel = 'basic' | 'advanced' | 'challenge';

export interface QuizQuestion {
  id: string;
  kpId: string;
  level: QuizLevel;
  /** 难度星级 1-3 */
  stars: 1 | 2 | 3;
  stem: string;
  options: string[];
  answerIndex: number;
  analysis: string;
  kbRefs: string[];
}

export const quizLevelMeta: Record<QuizLevel, { label: string; color: string }> = {
  basic: { label: '基础', color: '#6BA080' },
  advanced: { label: '进阶', color: '#E7B45A' },
  challenge: { label: '挑战', color: '#B0483B' },
};

export const quizBank: QuizQuestion[] = [
  // ---------- 运动学 12 题（林晓舟）：基础 q-01..04 / 进阶 q-05..09 / 挑战 q-10..12 ----------
  {
    id: 'q-01', kpId: 'kp-kinematics', level: 'basic', stars: 1,
    stem: '机器人工具坐标系（TCP）的原点应定义在：',
    options: ['机械接口法兰中心', '工具中心点', '机器人底座中心', '工件几何中心'],
    answerIndex: 1,
    analysis: 'GB/T 16977-2019 规定工具坐标系原点定义在工具中心点（Tool Center Point），旋转 RX/RY/RZ 遵从右手定则。',
    kbRefs: ['KB-002'],
  },
  {
    id: 'q-02', kpId: 'kp-kinematics', level: 'basic', stars: 1,
    stem: '「位姿（pose）」一词在机器人术语中的准确含义是：',
    options: ['仅指末端空间位置', '空间位置与姿态的合称', '各轴关节角集合', '运动速度向量'],
    answerIndex: 1,
    analysis: 'GB/T 12643-2013（等同 ISO 8373）定义：位姿是空间位置与姿态的合称。',
    kbRefs: ['KB-025'],
  },
  {
    id: 'q-03', kpId: 'kp-sensor', level: 'basic', stars: 1,
    stem: '验收时各轴回零后，机械零点刻线错位允许的最大值是：',
    options: ['不超过刻度一格', '不超过两格', '不超过 1 mm', '不允许任何错位'],
    answerIndex: 0,
    analysis: 'JB/T 8896-1999 验收规则：各轴回零后机械零点刻线错位不得超过刻度一格。',
    kbRefs: ['KB-018'],
  },
  {
    id: 'q-04', kpId: 'kp-safety', level: 'basic', stars: 1,
    stem: '手动（示教）模式下，机器人 TCP 速度不得超过：',
    options: ['100 mm/s', '250 mm/s', '500 mm/s', '无强制限制'],
    answerIndex: 1,
    analysis: 'GB 11291.1-2011 §5.10：手动模式 TCP 速度不得超过 250 mm/s，且示教器须配三位使能装置。',
    kbRefs: ['KB-005'],
  },
  {
    id: 'q-05', kpId: 'kp-kinematics', level: 'advanced', stars: 2,
    stem: '改进 D-H 参数中，唯一确定连杆变换 i-1Ti 的四个参数是：',
    options: [
      'ai-1、αi-1、di、θi',
      'xi、yi、zi、θi',
      'ai、αi、βi、γi',
      '连杆质量、质心、惯量、摩擦',
    ],
    answerIndex: 0,
    analysis: 'Craig《机器人学导论》：连杆变换由连杆长度 ai-1、连杆转角 αi-1、连杆偏距 di、关节角 θi 唯一确定。',
    kbRefs: ['KB-009'],
  },
  {
    id: 'q-06', kpId: 'kp-sensor', level: 'advanced', stars: 2,
    stem: 'GB/T 12642-2013 位姿准确度试验规定的测量条件是：',
    options: [
      '空载、低速、单点单次',
      '额定负载，最大速度的 100%/50%/10%，立方体五点位姿各测 30 次',
      '任意负载、任意速度、测 3 次取平均',
      '仅最大速度下测中心点',
    ],
    answerIndex: 1,
    analysis: '位姿准确度 AP 试验须在额定负载、最大速度 100%/50%/10% 条件下对立方体五点位姿各测 30 次。',
    kbRefs: ['KB-007'],
  },
  {
    id: 'q-07', kpId: 'kp-plc', level: 'advanced', stars: 2,
    stem: 'PLC 与机器人信号交互时，「机器人就绪/报警」信号的正确做法是：',
    options: [
      '与动作输出共用地址以节省点位',
      '映射为独立输入位，严禁与动作输出共用地址',
      '接入普通继电器即可',
      '通过模拟量传输',
    ],
    answerIndex: 1,
    analysis: '工程规范要求状态信号独立映射，避免共用地址导致的状态覆盖与联锁失效。',
    kbRefs: ['KB-008'],
  },
  {
    id: 'q-08', kpId: 'kp-vision', level: 'advanced', stars: 2,
    stem: '相机标定采集棋盘格时，姿态数量与重投影误差的合理验收线是：',
    options: [
      '≥3 个姿态，误差 < 5 像素',
      '≥15 个姿态，误差 < 0.5 像素',
      '≥50 个姿态，误差 < 0.05 像素',
      '姿态数量无所谓',
    ],
    answerIndex: 1,
    analysis: '教材建议采集不少于 15 个姿态并覆盖视场四角与纵深，重投影误差控制在 0.5 像素以内。',
    kbRefs: ['KB-004'],
  },
  {
    id: 'q-09', kpId: 'kp-diagnosis', level: 'advanced', stars: 2,
    stem: '伺服过载报警频发但电流未超额，优先排查的方向是：',
    options: [
      '立刻更换伺服电机',
      '减速器润滑劣化与抱闸未完全释放',
      '修改报警阈值屏蔽报警',
      '重装控制系统',
    ],
    answerIndex: 1,
    analysis: '静态保持电流上升 15% 以上为减速器润滑劣化/抱闸未释放的典型征兆，应先机械后电气。',
    kbRefs: ['KB-006'],
  },
  {
    id: 'q-10', kpId: 'kp-kinematics', level: 'challenge', stars: 3,
    stem: '满足 Pieper 准则的六轴臂，其逆运动学求解的正确路径是：',
    options: [
      '只能数值迭代，无解析解',
      '位置与姿态解耦：先由腕心解前三轴（4 组解），再由腕部姿态解后三轴（2 组解）',
      '直接对雅可比矩阵求逆得唯一解',
      '逐轴顺序求解 6 个关节角',
    ],
    answerIndex: 1,
    analysis: '腕部三轴交于一点时可位姿分离求解，共 8 组解；工程上按「最短行程 + 避奇异」规则选解。',
    kbRefs: ['KB-022'],
  },
  {
    id: 'q-11', kpId: 'kp-vision', level: 'challenge', stars: 3,
    stem: '手眼标定 AX=XB 采集中容易导致解退化的情况是：',
    options: [
      '旋转运动大于 30°',
      '纯平移运动',
      '采集 12–20 组姿态',
      '使用对偶四元数法',
    ],
    answerIndex: 1,
    analysis: '纯平移运动无法约束旋转分量，导致手眼方程解退化；应保证充足旋转运动。',
    kbRefs: ['KB-011'],
  },
  {
    id: 'q-12', kpId: 'kp-sensor', level: 'challenge', stars: 3,
    stem: '激光跟踪仪运动学标定中，关于测量布点与参数辨识的正确说法是：',
    options: [
      '布点越少越好，辨识 6 个参数即可',
      '在工作空间布设 60 个构型，最小二乘辨识 24 项参数，可显著降低绝对定位误差',
      '只需标定 J1 轴',
      '标定对离线编程精度无影响',
    ],
    answerIndex: 1,
    analysis: '文献案例：60 构型辨识 24 项参数后，最大绝对定位误差由 2.84 mm 降至 0.21 mm。',
    kbRefs: ['KB-017'],
  },
  // ---------- 陈雨桐补充题 q-13..q-18 ----------
  {
    id: 'q-13', kpId: 'kp-safety', level: 'basic', stars: 1,
    stem: '发现围栏门联锁失效时，正确处置是：',
    options: ['短接联锁继续生产', '停机报修，禁止强行短接', '用胶带固定门开关', '降低速度继续观察'],
    answerIndex: 1,
    analysis: 'GB/T 15706-2012：防护装置失效不得导致防护功能丧失，强行短接属于重大违规。',
    kbRefs: ['KB-012'],
  },
  {
    id: 'q-14', kpId: 'kp-safety', level: 'basic', stars: 1,
    stem: '示教器三位使能装置的设计逻辑是：',
    options: [
      '松开即运行',
      '中间位保持才运行，松开或握紧到位均切断驱动动力',
      '仅握紧到位才停止',
      '纯装饰件',
    ],
    answerIndex: 1,
    analysis: 'GB 11291.1-2011：三位使能装置在松开或握紧到位时均应切断驱动动力，防止操作者僵直或脱手。',
    kbRefs: ['KB-005'],
  },
  {
    id: 'q-15', kpId: 'kp-sensor', level: 'basic', stars: 1,
    stem: '零点标定前对工装负载的正确要求是：',
    options: ['满载标定', '卸载工装后标定', '无所谓', '只卸一半'],
    answerIndex: 1,
    analysis: '回零准备须卸载工装，避免附加负载影响机械零位找正。',
    kbRefs: ['KB-018'],
  },
  {
    id: 'q-16', kpId: 'kp-safety', level: 'advanced', stars: 2,
    stem: '风险减小的优先顺序（三步法）是：',
    options: [
      '告知 → 防护 → 本质安全',
      '本质安全设计 → 防护装置 → 使用告知',
      '防护装置 → 本质安全 → 告知',
      '三步可任意排序',
    ],
    answerIndex: 1,
    analysis: 'GB/T 15706-2012：优先本质安全设计，其次防护装置，最后使用信息告知。',
    kbRefs: ['KB-012'],
  },
  {
    id: 'q-17', kpId: 'kp-plc', level: 'advanced', stars: 2,
    stem: '梯形图「启保停回路」的本质是：',
    options: ['计数逻辑', '自锁逻辑的最小单元', '脉冲输出', '模拟量滤波'],
    answerIndex: 1,
    analysis: '启保停回路通过常开触点并联启动信号实现自锁保持，是最基础的记忆回路。',
    kbRefs: ['KB-008'],
  },
  {
    id: 'q-18', kpId: 'kp-kinematics', level: 'challenge', stars: 3,
    stem: '绕 TCP 做姿态摆动验证标定质量时，理想现象是：',
    options: ['TCP 位置纹丝不动', 'TCP 画大圆', 'J1 轴高速旋转', '机器人回零'],
    answerIndex: 0,
    analysis: 'TCP 标定准确时，纯姿态运动下工具尖端位置应保持不动；明显划圆说明 TCP 偏差大。',
    kbRefs: ['KB-002'],
  },
  // ---------- 赵鸿补充题 q-19..q-24 ----------
  {
    id: 'q-19', kpId: 'kp-vision', level: 'basic', stars: 1,
    stem: 'Eye-in-Hand 构型指的是：',
    options: ['相机固定在机器人末端', '相机固定在工位上方', '相机装在工件上', '双目固定相机'],
    answerIndex: 0,
    analysis: 'Eye-in-Hand 即相机随机器人末端移动；固定于外部的是 Eye-to-Hand 构型。',
    kbRefs: ['KB-011'],
  },
  {
    id: 'q-20', kpId: 'kp-vision', level: 'basic', stars: 1,
    stem: '视觉引导抓件中，来料姿态偏差 ±15 mm 的常用消化策略是：',
    options: [
      '提高机器人速度',
      '模板匹配粗定位 + 边缘精定位两级处理',
      '更换更大夹具',
      '人工摆正',
    ],
    answerIndex: 1,
    analysis: '焊装线案例：两级定位消化来料偏差，配合曝光锁定应对光照波动。',
    kbRefs: ['KB-016'],
  },
  {
    id: 'q-21', kpId: 'kp-sensor', level: 'advanced', stars: 2,
    stem: '温度补偿模型 Δθ = k(T−T₀) 中的系数 k 应如何获得：',
    options: ['查机器人手册默认值', '通过五点恒温实验拟合', '拍脑袋估计', '与减速比成正比'],
    answerIndex: 1,
    analysis: 'KB-014：k 应通过五点恒温实验拟合；线性模型适用区间 10–35℃。',
    kbRefs: ['KB-014'],
  },
  {
    id: 'q-22', kpId: 'kp-plc', level: 'advanced', stars: 2,
    stem: '安全 PLC 三级联锁中，光幕触发后的正确动作是：',
    options: ['机器人降速继续运行', 'STO 安全转矩关断', '仅声光报警', '记录事件不动作'],
    answerIndex: 1,
    analysis: '光幕触发 → STO 安全转矩关断；复位须人工确认且双通道监控。',
    kbRefs: ['KB-015'],
  },
  {
    id: 'q-23', kpId: 'kp-diagnosis', level: 'advanced', stars: 2,
    stem: '编码器通讯报警摇动线缆可复现，最可能的根因是：',
    options: ['伺服参数漂移', '拖链内编码器线疲劳断股', '电网谐波', '示教器故障'],
    answerIndex: 1,
    analysis: '企业案例：高柔线缆在拖链内长期弯折疲劳断股；更换线缆并调整弯曲半径 ≥8D 后故障消除。',
    kbRefs: ['KB-013'],
  },
  {
    id: 'q-24', kpId: 'kp-vision', level: 'challenge', stars: 3,
    stem: '飞拍（on-the-fly）视觉分拣的核心同步机制是：',
    options: [
      '相机自由曝光，机器人减速等待',
      '输送链编码器定距触发 + 短曝光冻结 + 轨迹预规划',
      '人工目测触发',
      '提高光源功率即可',
    ],
    answerIndex: 1,
    analysis: '3C 案例：编码器每 5 mm 触发、200 μs 曝光冻结运动、机器人基于队列预测预规划，节拍 1.8 s→0.9 s。',
    kbRefs: ['KB-024'],
  },

  // ---------- 诊断向导补充：PLC / 故障诊断 基础题（q-25..q-28） ----------
  {
    id: 'q-25', kpId: 'kp-plc', level: 'basic', stars: 1,
    stem: '梯形图中「常闭触点」在编程界面里的含义是：',
    options: ['线圈得电时触点闭合', '默认导通，对应信号为 1 时断开', '仅用于急停回路', '与常开触点完全等价'],
    answerIndex: 1,
    analysis: '常闭触点默认导通，关联位为 1 时断开——安全回路常用常闭逻辑，断线即停，故障导向安全。',
    kbRefs: ['KB-012'],
  },
  {
    id: 'q-26', kpId: 'kp-plc', level: 'basic', stars: 1,
    stem: 'PLC 与机器人控制器之间最常见的现场总线通讯方式是：',
    options: ['RS-232 串口逐字节轮询', 'PROFINET / EtherCAT 等工业以太网', 'USB 直连', '蓝牙透传'],
    answerIndex: 1,
    analysis: '现代产线以 PROFINET / EtherCAT 等工业以太网为主流：周期性 I/O 映射 + 毫秒级确定性时延。',
    kbRefs: ['KB-012'],
  },
  {
    id: 'q-27', kpId: 'kp-diagnosis', level: 'basic', stars: 1,
    stem: '示教器上出现报警代码时，第一步应该做的是：',
    options: ['直接断电重启', '查阅报警代码手册确认级别与含义', '短接安全回路继续生产', '立即更换伺服电机'],
    answerIndex: 1,
    analysis: '报警处置第一步永远是「读懂报警」：确认级别（提示/警告/停机）与含义，再按故障树逐级排查——盲目重启会丢失现场证据。',
    kbRefs: ['KB-020'],
  },
  {
    id: 'q-28', kpId: 'kp-diagnosis', level: 'basic', stars: 1,
    stem: '机器人某轴运行时出现周期性异响，最合理的初步判断方向是：',
    options: ['控制柜风扇故障', '该轴减速器磨损或润滑不良', '示教器电池电量低', '视觉相机曝光异常'],
    answerIndex: 1,
    analysis: '与轴运动周期同步的异响优先怀疑传动链：减速器磨损、润滑不良或轴承损伤，可结合振动频谱进一步定位。',
    kbRefs: ['KB-020'],
  },
];

export const getQuizByIds = (ids: string[]): QuizQuestion[] =>
  ids.map((id) => quizBank.find((q) => q.id === id)).filter((q): q is QuizQuestion => Boolean(q));

export const quizByKp = (kpId: string): QuizQuestion[] =>
  quizBank.filter((q) => q.kpId === kpId);
