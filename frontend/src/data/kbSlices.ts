/**
 * 领域知识库切片 — ≥20 条，含国标 / 行标 / 教材 / 企业案例 / 论文
 * 全站 TraceBadge [KB-xxx] 的数据源，KBDrawer 据此渲染
 */

export type KBType = '国标' | '行标' | '教材' | '企业案例' | '论文';

export interface KBSlice {
  id: string;
  title: string;
  /** 标准号（教材/案例/论文为空，用 source 展示） */
  standardNo?: string;
  source: string;
  type: KBType;
  kpId: string;
  /** 可信度 0-1，检索 Agent 评分 */
  credibility: number;
  citedCount: number;
  year: number;
  summary: string;
  excerpt: string;
  relatedResources: string[];
}

export const kbSlices: KBSlice[] = [
  {
    id: 'KB-001',
    title: '机械电气安全 机械电气设备 第1部分：通用技术条件',
    standardNo: 'GB 5226.1-2019',
    source: '国家市场监督管理总局',
    type: '国标',
    kpId: 'kp-safety',
    credibility: 0.99,
    citedCount: 86,
    year: 2019,
    summary: '机械电气设备的设计、集成与验证通用安全技术要求，涵盖电源引入、电击防护、控制电路与急停功能。',
    excerpt:
      '9.2.5.4 急停功能应通过机电式装置或以安全相关的电子控制方式实现；急停致动后应切断危险运动的驱动电源，且复位不得自行重启机器。',
    relatedResources: ['《安全回路设计实务》讲义', '急停回路分阶题 · 基础'],
  },
  {
    id: 'KB-002',
    title: '机器人与机器人装备 坐标系和运动命名原则',
    standardNo: 'GB/T 16977-2019',
    source: '全国机器人标准化技术委员会',
    type: '国标',
    kpId: 'kp-kinematics',
    credibility: 0.98,
    citedCount: 124,
    year: 2019,
    summary: '规定工业机器人绝对坐标系、机座坐标系、机械接口坐标系与工具坐标系的定义及运动命名，等同采用 ISO 9787。',
    excerpt:
      '工具坐标系（TCP）原点应定义在工具中心点；绕 X、Y、Z 轴的旋转运动依次命名为 RX、RY、RZ，正方向遵从右手定则。',
    relatedResources: ['《坐标系变换图解》讲义', '运动学分阶题 · 进阶'],
  },
  {
    id: 'KB-003',
    title: '工业机器人 特性表示',
    standardNo: 'GB/T 12644-2001',
    source: '全国工业自动化系统标准化技术委员会',
    type: '国标',
    kpId: 'kp-kinematics',
    credibility: 0.95,
    citedCount: 42,
    year: 2001,
    summary: '规范机器人产品样本中的特性表示方法：自由度、额定负载、工作空间、最大速度与位姿特性的表达方式。',
    excerpt:
      '额定负载指机器人在规定性能条件下、机械接口处可承受的最大负载（含末端执行器），以 kg 表示；工作空间图应标注奇异边界。',
    relatedResources: ['《读懂机器人选型样本》讲义'],
  },
  {
    id: 'KB-004',
    title: '机器视觉技术及应用 · 第3章 成像与标定',
    source: '高等教育出版社《机器视觉技术及应用》（2021）',
    type: '教材',
    kpId: 'kp-vision',
    credibility: 0.9,
    citedCount: 57,
    year: 2021,
    summary: '工业相机成像模型、镜头畸变校正与张氏标定法流程，含棋盘格采集姿态数量与重投影误差验收阈值。',
    excerpt:
      '标定板采集建议不少于 15 个姿态，覆盖视场四角与纵深；重投影误差应控制在 0.5 像素以内，否则需检查光照均匀性与标定板平面度。',
    relatedResources: ['《视觉定位入门》讲义', '手眼标定实操指南'],
  },
  {
    id: 'KB-005',
    title: '工业环境用机器人 安全要求 第1部分：机器人',
    standardNo: 'GB 11291.1-2011',
    source: '国家标准化管理委员会（等同 ISO 10218-1）',
    type: '国标',
    kpId: 'kp-safety',
    credibility: 0.99,
    citedCount: 158,
    year: 2011,
    summary: '工业机器人本体安全的核心国标：安全功能分级、限速/限空间要求、示教器使能装置与安全防护装置选型。',
    excerpt:
      '5.10 手动模式下，机器人TCP速度不得超过 250 mm/s；示教器应配备三位使能装置，松开或握紧到位均应切断驱动动力。',
    relatedResources: ['《安全规范精讲》讲义', '安全规范分阶题 · 挑战'],
  },
  {
    id: 'KB-006',
    title: '工业机器人故障诊断与维护 · 第5章 伺服系统',
    source: '机械工业出版社（2020）',
    type: '教材',
    kpId: 'kp-diagnosis',
    credibility: 0.88,
    citedCount: 49,
    year: 2020,
    summary: '伺服驱动器报警体系、编码器故障判别与伺服刚度整定基础，附主流品牌报警代码对照表。',
    excerpt:
      '过载报警（OL）频发但电流未超额时，应排查减速器润滑劣化与抱闸未完全释放：静态保持电流上升 15% 以上为典型征兆。',
    relatedResources: ['《报警代码速查》讲义', '故障树分析实操'],
  },
  {
    id: 'KB-007',
    title: '工业机器人 性能规范及其试验方法 · 位姿准确度与重复性',
    standardNo: 'GB/T 12642-2013',
    source: '全国自动化系统与集成标委会（等同 ISO 9283）',
    type: '国标',
    kpId: 'kp-sensor',
    credibility: 0.99,
    citedCount: 203,
    year: 2013,
    summary: '机器人位姿准确度（AP）、位姿重复性（RP）等 14 项性能指标的定义与标准试验方法，是标定验收的根本依据。',
    excerpt:
      '位姿准确度 AP 指指令位姿与实到位姿集群重心之间的偏差；试验应在额定负载、最大速度的 100% / 50% / 10% 条件下对立方体五点位姿各测 30 次。',
    relatedResources: ['《传感器标定精要》讲义', '位姿准确度分阶题 · 进阶', '零点标定实操指南'],
  },
  {
    id: 'KB-008',
    title: 'PLC 编程及应用 · 第4版 · 梯形图与顺序控制',
    source: '机械工业出版社 · 廖常初（2019）',
    type: '教材',
    kpId: 'kp-plc',
    credibility: 0.92,
    citedCount: 96,
    year: 2019,
    summary: '经典 PLC 教材：梯形图基本回路、顺序功能图（SFC）编程与定时/计数指令的工程用法。',
    excerpt:
      '启保停回路是自锁逻辑的最小单元；与机器人交互时，应将「机器人就绪」「机器人报警」映射为独立输入位，严禁与动作输出共用地址。',
    relatedResources: ['《PLC 与机器人联锁》讲义', '梯形图分阶题 · 基础'],
  },
  {
    id: 'KB-009',
    title: '机器人学导论 · Craig 著 · D-H 参数与正运动学',
    source: '机械工业出版社中译本（2018）',
    type: '教材',
    kpId: 'kp-kinematics',
    credibility: 0.94,
    citedCount: 141,
    year: 2018,
    summary: '机器人学标准教材：改进 D-H 参数定义、连杆变换矩阵推导与六轴臂正运动学完整示例。',
    excerpt:
      '连杆变换 i-1Ti 由四个参数唯一确定：连杆长度 ai-1、连杆转角 αi-1、连杆偏距 di 与关节角 θi；六轴臂正解为六个变换矩阵的连乘。',
    relatedResources: ['《D-H 建模从零到一》讲义', '运动学 12 题 · 基础/进阶/挑战'],
  },
  {
    id: 'KB-010',
    title: '工业机器人 性能试验实施规范',
    standardNo: 'GB/T 20868-2007',
    source: '全国自动化系统与集成标委会',
    type: '国标',
    kpId: 'kp-sensor',
    credibility: 0.96,
    citedCount: 63,
    year: 2007,
    summary: 'GB/T 12642 的配套实施规范：试验环境温湿度、测量设备精度要求、采样点数与数据处理细则。',
    excerpt:
      '测量系统不确定度应优于被测指标预期值的 25%；环境温度 20±2℃，试验前机器人应在额定工况下预热 30 min 以稳定热漂移。',
    relatedResources: ['《标定试验环境搭建》实操指南'],
  },
  {
    id: 'KB-011',
    title: '机器人手眼标定方法综述：AX=XB 求解进展',
    source: '《机器人》期刊 · 2021 年第43卷',
    type: '论文',
    kpId: 'kp-vision',
    credibility: 0.87,
    citedCount: 71,
    year: 2021,
    summary: '系统比较 Tsai-Lenz、四元数法与对偶四元数法求解手眼方程 AX=XB 的精度与鲁棒性，给出工程选型建议。',
    excerpt:
      '当旋转运动大于 30° 且平移量充足时，对偶四元数法重投影误差最低；Eye-in-Hand 构型建议采集 12–20 组姿态，避免纯平移运动导致的解退化。',
    relatedResources: ['《手眼标定案例对照》进阶讲义', '视觉引导分阶题 · 挑战'],
  },
  {
    id: 'KB-012',
    title: '机械安全 设计通则 风险评估与风险减小',
    standardNo: 'GB/T 15706-2012',
    source: '全国机械安全标委会（等同 ISO 12100）',
    type: '国标',
    kpId: 'kp-safety',
    credibility: 0.98,
    citedCount: 92,
    year: 2012,
    summary: '机械全生命周期风险评估框架：危险识别 → 风险估计 → 风险评价 → 三步法风险减小（本质安全→防护→告知）。',
    excerpt:
      '风险减小应优先采用本质安全设计措施；当采用防护装置时，联锁装置的失效不得导致防护功能丧失，残余风险应在随机文件中明示。',
    relatedResources: ['《风险评估三步法》讲义', '安全案例分析题'],
  },
  {
    id: 'KB-013',
    title: '伺服报警 ALM-416 编码器通讯异常处置案例',
    source: '某新能源电池模组产线 · 运维日志归档（2023）',
    type: '企业案例',
    kpId: 'kp-diagnosis',
    credibility: 0.85,
    citedCount: 38,
    year: 2023,
    summary: '六轴臂 J4 轴偶发编码器通讯报警的真实排查过程：从线缆拖链弯折到航空插头针脚氧化的定位链路。',
    excerpt:
      '示教器报 ALM-416 且摇动 J4 线缆可复现，判定为拖链内编码器线疲劳断股；更换高柔性线缆并调整拖链弯曲半径至 ≥8D 后，连续运行 90 天无复发。',
    relatedResources: ['《线缆故障树》实操指南', '故障诊断分阶题 · 进阶'],
  },
  {
    id: 'KB-014',
    title: '传感器与检测技术 · 第6章 位移与位姿测量',
    source: '清华大学出版社（2022）',
    type: '教材',
    kpId: 'kp-sensor',
    credibility: 0.9,
    citedCount: 77,
    year: 2022,
    summary: '激光位移、视觉、编码器等位姿测量原理与误差链分析，含温度漂移建模与软件补偿方法。',
    excerpt:
      '编码器零点漂移的温度敏感性约为 0.02°/10℃（谐波减速器背隙叠加）；补偿模型 Δθ = k(T−T₀) 中 k 应通过五点恒温实验拟合获得。',
    relatedResources: ['《传感器标定精要》讲义', '温度补偿分阶题 · 挑战'],
  },
  {
    id: 'KB-015',
    title: '基于安全 PLC 的机器人工作站联锁系统设计',
    source: '《制造业自动化》· 2022 年第44卷',
    type: '论文',
    kpId: 'kp-plc',
    credibility: 0.86,
    citedCount: 45,
    year: 2022,
    summary: '安全 PLC 实现围栏门、光幕与机器人使能的三级联锁架构，给出 I/O 分配表与安全等级（PLd）验证过程。',
    excerpt:
      '围栏门开 → 机器人降速至 250 mm/s；光幕触发 → STO 安全转矩关断；复位须人工确认且双通道监控，单点故障不得导致安全功能丧失。',
    relatedResources: ['《安全联锁回路设计》讲义', 'PLC 联锁分阶题 · 进阶'],
  },
  {
    id: 'KB-016',
    title: '汽车焊装线视觉引导抓件改造项目',
    source: '某整车厂焊装车间 · 技改验收报告（2022）',
    type: '企业案例',
    kpId: 'kp-vision',
    credibility: 0.84,
    citedCount: 33,
    year: 2022,
    summary: '2D 视觉 + 机器人引导抓取冲压件的落地案例：定位精度 ±0.4 mm、节拍提升 18%，含光照波动应对方案。',
    excerpt:
      '来料姿态偏差 ±15 mm 由模板匹配粗定位 + 边缘精定位两级消化；天窗日光直射时段采用曝光锁定 + 遮光罩，误抓率由 1.2% 降至 0.05%。',
    relatedResources: ['《视觉引导产线案例》讲义'],
  },
  {
    id: 'KB-017',
    title: '基于激光跟踪仪的工业机器人运动学标定方法',
    source: '《机械工程学报》· 2020 年第56卷',
    type: '论文',
    kpId: 'kp-sensor',
    credibility: 0.91,
    citedCount: 88,
    year: 2020,
    summary: '以激光跟踪仪测量末端位置，最小二乘辨识 D-H 参数误差，标定后绝对定位精度提升一个数量级。',
    excerpt:
      '在 2.3 m 工作空间内布设 60 个测量构型，辨识 24 项运动学参数；标定后最大绝对定位误差由 2.84 mm 降至 0.21 mm，满足离线编程精度要求。',
    relatedResources: ['《激光跟踪仪标定实操》指南', '标定原理分阶题 · 挑战'],
  },
  {
    id: 'KB-018',
    title: '工业机器人 验收规则',
    standardNo: 'JB/T 8896-1999',
    source: '全国机器人行业标准化技术归口单位',
    type: '行标',
    kpId: 'kp-sensor',
    credibility: 0.93,
    citedCount: 51,
    year: 1999,
    summary: '机器人出厂与现场验收的行业标准：外观、功能、精度复测与连续运行考核的项目清单与合格判据。',
    excerpt:
      '精度复测应包含零点复归检查：各轴回零后机械零点刻线错位不得超过刻度一格；连续 8 h 运行考核中报警停机次数不得多于 1 次。',
    relatedResources: ['《六轴臂零点标定五步实操》指南', '验收流程分阶题 · 基础'],
  },
  {
    id: 'KB-019',
    title: '机械安全 控制系统安全相关部件 第1部分：设计通则',
    standardNo: 'GB/T 16855.1-2018',
    source: '全国机械安全标委会（等同 ISO 13849-1）',
    type: '国标',
    kpId: 'kp-safety',
    credibility: 0.98,
    citedCount: 67,
    year: 2018,
    summary: '安全相关控制系统的性能等级（PL a–e）评估方法：类别、MTTFd、诊断覆盖率与共因失效的组合判据。',
    excerpt:
      '机器人工作站急停回路通常要求 PLd / Cat.3：双通道冗余 + 监控，单通道 MTTFd ≥ 30 年，DCavg ≥ 90%，共因失效评分 ≥ 65。',
    relatedResources: ['《PL 等级评估入门》讲义'],
  },
  {
    id: 'KB-020',
    title: '工业机器人减速器磨损的振动特征提取与预测性维护',
    source: '《振动工程学报》· 2023 年第36卷',
    type: '论文',
    kpId: 'kp-diagnosis',
    credibility: 0.88,
    citedCount: 54,
    year: 2023,
    summary: 'RV 减速器磨损阶段与振动频谱特征的对应关系，给出基于特征频率幅值趋势的剩余寿命预警阈值。',
    excerpt:
      '磨损中期特征频率（输入轴转频 × 齿数）幅值上升 6 dB 且出现边频带；建议以每周采集一次的幅值斜率 > 0.8 dB/周作为换油与点检触发条件。',
    relatedResources: ['《预测性维护数据判读》讲义', '振动分析分阶题 · 挑战'],
  },
  {
    id: 'KB-021',
    title: '汽车焊装线六轴臂零点漂移处置与温度补偿案例',
    source: '某合资车企焊装工厂 · 设备月报（2024）',
    type: '企业案例',
    kpId: 'kp-sensor',
    credibility: 0.86,
    citedCount: 46,
    year: 2024,
    summary: '冬季早班焊点偏移 1.8 mm 的处置全过程：定位为低温导致零点漂移，实施预热程序 + 温度补偿参数后达标。',
    excerpt:
      '车间夜停后温度降至 8℃，J2/J3 轴零点漂移叠加致 TCP 偏移 1.8 mm；引入开机 10 min 低速预热程序并写入温度补偿系数 k=0.021°/10℃，首件合格率恢复至 99.6%。',
    relatedResources: ['《传感器标定精要》讲义', '温度补偿案例题'],
  },
  {
    id: 'KB-022',
    title: '六自由度串联机器人逆运动学解析解的 Pieper 准则应用',
    source: '《机械设计与研究》· 2019 年第35卷',
    type: '论文',
    kpId: 'kp-kinematics',
    credibility: 0.87,
    citedCount: 62,
    year: 2019,
    summary: '满足 Pieper 准则（三相邻轴交于一点）的六轴臂逆解推导：位姿分离、腕心求解与 8 组解的取舍策略。',
    excerpt:
      '腕部三轴交点构型可将位置与姿态解耦：先由腕心位置解前三轴（4 组解），再由腕部姿态解后三轴（2 组解）；工程上按「最短行程 + 避奇异」规则选解。',
    relatedResources: ['《逆运动学图解》讲义', '运动学 12 题 · 挑战'],
  },
  {
    id: 'KB-023',
    title: '工业机器人 力控制技术规范',
    standardNo: 'GB/T 38559-2020',
    source: '全国机器人标准化技术委员会',
    type: '国标',
    kpId: 'kp-safety',
    credibility: 0.95,
    citedCount: 29,
    year: 2020,
    summary: '力控机器人的技术指标与测试方法：恒力跟踪精度、碰撞检测响应时间与柔顺控制参数整定要求。',
    excerpt:
      '恒力控制模式下法向力波动应不超过设定值的 ±10%；碰撞检测响应时间应 ≤ 50 ms，触发后机器人应在 100 ms 内完成减速停止。',
    relatedResources: ['《力控与协作安全》讲义'],
  },
  {
    id: 'KB-024',
    title: '3C 装配线视觉分拣节拍优化案例',
    source: '某消费电子代工厂 · 精益改善归档（2023）',
    type: '企业案例',
    kpId: 'kp-vision',
    credibility: 0.83,
    citedCount: 27,
    year: 2023,
    summary: '飞拍（on-the-fly）视觉方案将分拣节拍从 1.8 s/件压缩至 0.9 s/件：曝光时刻同步、编码器触发与轨迹预规划。',
    excerpt:
      '相机由输送链编码器每 5 mm 触发一次，曝光窗口 200 μs 冻结运动；机器人基于队列预测提前规划抓取轨迹，视觉耗时完全隐入节拍。',
    relatedResources: ['《飞拍视觉入门》讲义'],
  },
  {
    id: 'KB-025',
    title: '机器人与机器人装备 词汇',
    standardNo: 'GB/T 12643-2013',
    source: '全国机器人标准化技术委员会（等同 ISO 8373）',
    type: '国标',
    kpId: 'kp-kinematics',
    credibility: 0.97,
    citedCount: 74,
    year: 2013,
    summary: '机器人领域术语的国家标准：操作机、控制器、示教、再现、自由度、位姿等 200+ 条术语的权威定义。',
    excerpt:
      '位姿（pose）：空间位置与姿态的合称；示教（teaching）：由人工引导机器人按预期动作与作业要求运动并记录程序的过程。',
    relatedResources: ['《术语速查卡》讲义'],
  },
  {
    id: 'KB-026',
    title: '冲压连线 PLC 与机器人 PROFINET 通讯中断排查案例',
    source: '某家电冲压车间 · 维修工单（2024）',
    type: '企业案例',
    kpId: 'kp-plc',
    credibility: 0.84,
    citedCount: 31,
    year: 2024,
    summary: 'PROFINET 周期性丢站导致整线急停：从交换机环网风暴到 MRP 环网协议配置错误的完整排查链。',
    excerpt:
      '抓包显示 IRT 报文抖动 > 2 ms 时机器人控制器退网；定位为新增视觉工位未划入 MRP 环网域，重新划分 VLAN 并将视觉流量限速至 30% 后故障消除。',
    relatedResources: ['《工业网络排障》实操指南', '通讯故障分阶题 · 进阶'],
  },
];

export const getKBSlice = (id: string): KBSlice | undefined =>
  kbSlices.find((k) => k.id === id);

export const kbSlicesByKp = (kpId: string): KBSlice[] =>
  kbSlices.filter((k) => k.kpId === kpId);
