/**
 * 六大核心知识点 — 工业机器人运维目标能力模型
 * 对齐国赛 / 1+X《工业机器人操作与运维》证书标准
 */

export interface KnowledgePoint {
  id: string;
  name: string;
  en: string;
  /** 目标能力模型权重 (0-1) */
  weight: number;
  /** 目标掌握水平 (0-100) */
  targetLevel: number;
  /** 当前全站资源覆盖率 (%) — 见总览 S5 */
  coverage: number;
  description: string;
  coreTopics: string[];
}

export const knowledgePoints: KnowledgePoint[] = [
  {
    id: 'kp-plc',
    name: 'PLC 编程',
    en: 'PLC PROGRAMMING',
    weight: 0.18,
    targetLevel: 80,
    coverage: 92,
    description: '产线控制核心：梯形图/结构化文本编程、I/O 联锁、与机器人控制器的信号交互。',
    coreTopics: ['梯形图与 ST 语言', 'I/O 映射与联锁', 'PROFINET/EtherCAT 通讯', '安全门回路'],
  },
  {
    id: 'kp-kinematics',
    name: '机器人运动学',
    en: 'ROBOT KINEMATICS',
    weight: 0.2,
    targetLevel: 82,
    coverage: 88,
    description: 'D-H 参数建模、正逆运动学求解、坐标系变换与奇异位形规避。',
    coreTopics: ['D-H 参数建模', '正/逆运动学', '工件/工具坐标系', '奇异点规避'],
  },
  {
    id: 'kp-sensor',
    name: '传感器标定',
    en: 'SENSOR CALIBRATION',
    weight: 0.17,
    targetLevel: 85,
    coverage: 95,
    description: '位姿准确度复现、零点标定、温度漂移补偿与激光跟踪仪比对测量。',
    coreTopics: ['零点标定五步', '位姿准确度 GB/T 12642', '温度漂移补偿', '重复定位精度'],
  },
  {
    id: 'kp-vision',
    name: '视觉引导',
    en: 'VISION GUIDANCE',
    weight: 0.15,
    targetLevel: 78,
    coverage: 90,
    description: '2D/3D 视觉定位、手眼标定（Eye-in-Hand / Eye-to-Hand）、分拣抓取位姿解算。',
    coreTopics: ['手眼标定 AX=XB', '特征匹配定位', '抓取位姿解算', '光照与曝光控制'],
  },
  {
    id: 'kp-safety',
    name: '安全规范',
    en: 'SAFETY COMPLIANCE',
    weight: 0.16,
    targetLevel: 90,
    coverage: 96,
    description: 'GB 11291.1 安全要求、风险评估、安全围栏/光幕/急停回路与协作边界。',
    coreTopics: ['GB 11291.1 安全要求', '风险评估 GB/T 15706', '急停与安全回路', '协作运行边界'],
  },
  {
    id: 'kp-diagnosis',
    name: '故障诊断',
    en: 'FAULT DIAGNOSIS',
    weight: 0.14,
    targetLevel: 80,
    coverage: 89,
    description: '报警代码解析、伺服/减速器/线缆典型故障树、预测性维护数据判读。',
    coreTopics: ['报警代码解析', '故障树分析', '减速器磨损判读', '预测性维护'],
  },
];

export const getKnowledgePoint = (id: string): KnowledgePoint =>
  knowledgePoints.find((k) => k.id === id) ?? knowledgePoints[0];
