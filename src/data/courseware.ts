/**
 * courseware — 课件数据层（GEN-03 约束生成的前端实现）
 * 课件 = 结构化 block 序列（概念/交互演示/检查点/小结），由「模板 × KB 切片 × 学习者难度/风格」拼装：
 * 同一知识点，不同画像看到不同版本——每段挂 KB 溯源，检查点答错由 ARB-05 插入降维 block。
 */
import type { Learner } from '@/data/learners';
import { knowledgePoints, getKnowledgePoint } from '@/data/knowledgePoints';
import { kbSlices } from '@/data/kbSlices';
import type { KBSlice } from '@/data/kbSlices';
import { quizByKp } from '@/data/quizBank';
import type { QuizQuestion } from '@/data/quizBank';

/* ================= 讲播 Cue 模型（视听双通道同步） ================= */
/** 一句讲稿 + 触发的视觉动作：语音讲到哪，画面亮到哪 */
export interface Cue {
  say: string;
  /** 本句要点亮的演播元素下标（stage/demo 块用） */
  reveal?: number[];
  /** 本句朗读时溯源角标发光 */
  kbFlash?: boolean;
}

/** 演播块元素：黑板上的一件"教具" */
export type StageItem =
  | { type: 'bullet'; text: string }
  | { type: 'formula'; text: string; note?: string }
  | { type: 'bignum'; value: string; label: string }
  | { type: 'kb'; kbId: string }
  | { type: 'figure'; figure: 'deviation' | 'chain' };

/* ================= 课件 Block 模型 ================= */
export type CourseBlock =
  | { kind: 'concept'; id: string; title: string; text: string; kbRefs: string[]; script: string }
  | { kind: 'stage'; id: string; title: string; items: StageItem[]; cues: Cue[]; kbRefs: string[] }
  | { kind: 'demo'; id: string; demo: 'calibration' | 'frame' | 'plc' | 'safety' | 'vision' | 'fault'; title: string; script: string; cues?: Cue[] }
  | { kind: 'checkpoint'; id: string; q: QuizQuestion; script: string }
  | { kind: 'remedial'; id: string; title: string; text: string; kbRefs: string[]; script: string }
  | { kind: 'summary'; id: string; text: string; script: string };

/** 取 block 的 cue 序列：显式 cues 优先，否则按句自动切分（末句触发溯源发光） */
export function cuesOf(b: CourseBlock): Cue[] {
  if (b.kind === 'stage') return b.cues;
  if (b.kind === 'demo' && b.cues) return b.cues;
  const script = 'script' in b ? b.script : '';
  const sentences = script.split(/(?<=[。！？；])/).map((s) => s.trim()).filter(Boolean);
  const hasKb = 'kbRefs' in b && (b as { kbRefs: string[] }).kbRefs.length > 0;
  return sentences.map((s, i) => ({
    say: s,
    kbFlash: hasKb && i === sentences.length - 1,
  }));
}

export type Difficulty = '零基础' | '标准' | '进阶';

export interface CourseUnit {
  kpId: string;
  difficulty: Difficulty;
  styleLabel: string;
  blocks: CourseBlock[];
}

/* ================= 难度 / 风格适配 ================= */
export function difficultyOf(learner: Learner, kpId: string): Difficulty {
  const s = learner.scores[kpId] ?? 50;
  return s < 55 ? '零基础' : s <= 75 ? '标准' : '进阶';
}

export type StyleLabel = '实操导向' | '案例对照' | '图解优先' | '理论先行';
export const STYLE_LABELS: StyleLabel[] = ['实操导向', '案例对照', '图解优先', '理论先行'];

const STYLE_DEFS: Record<StyleLabel, (kp: string) => string> = {
  实操导向: (kp) => `咱们先干后学：下面每个概念都直接对应你在车间会遇到的操作场景，学完就能上手 ${kp}。`,
  案例对照: (kp) => `你有现场经验，我们用"老经验对照新概念"的方式来讲 ${kp}——每个知识点都告诉你它像你熟悉的什么。`,
  图解优先: (kp) => `这一讲以图和演示为主：先看 ${kp} 的直观图景，再补文字定义。`,
  理论先行: (kp) => `我们按"定义 → 原理 → 应用"的顺序系统讲一遍 ${kp}，先把概念地基打牢。`,
};

/** 学习风格 → 讲法模板；styleOverride 用于「换个角度再学一遍」强制重拼 */
function styleOf(learner: Learner, override?: StyleLabel): { label: StyleLabel; opener: (kp: string) => string } {
  if (override) return { label: override, opener: STYLE_DEFS[override] };
  const st = learner.learningStyle;
  if (st.includes('实操驱动') || st.includes('步骤清单')) return { label: '实操导向', opener: STYLE_DEFS['实操导向'] };
  if (st.includes('案例迁移')) return { label: '案例对照', opener: STYLE_DEFS['案例对照'] };
  if (st.includes('图示学习') || st.includes('视频演示')) return { label: '图解优先', opener: STYLE_DEFS['图解优先'] };
  return { label: '理论先行', opener: STYLE_DEFS['理论先行'] };
}

function difficultyLine(d: Difficulty): string {
  if (d === '零基础') return '本讲为零基础版：术语都会先解释再使用，遇到不懂随时暂停提问。';
  if (d === '进阶') return '本讲为进阶版：基础定义快速带过，重点放在工程判据与易错边界。';
  return '本讲为标准版：概念与应用并重。';
}

/* ================= 讲义拼装 ================= */
const slicesOf = (kpId: string): KBSlice[] =>
  kbSlices.filter((s) => s.kpId === kpId).sort((a, b) => b.credibility - a.credibility);

/** 降维 block 文案（检查点答错时由 ARB-05 插入） */
const remedialText: Record<string, { title: string; text: string }> = {
  'kp-plc': {
    title: '退一步 · 什么是联锁',
    text: '把联锁想成"门没关好，洗衣机就不转"：安全门的常闭触点串在使能回路里，门一开回路断、设备停。先记住"常闭=默认导通、断开即停"这一句，再回去看题。',
  },
  'kp-kinematics': {
    title: '退一步 · 坐标系是什么',
    text: '想象你在车间说"往左挪 10 公分"——"左"是相对谁的左？机器人也一样：基座标系是车间的"东南西北"，工具坐标系是夹爪自己的"前后左右"。位姿 = 位置（在哪）+ 姿态（朝哪）。',
  },
  'kp-sensor': {
    title: '退一步 · 为什么要标定',
    text: '机器人"以为"自己在 A 点，实际在 A′——这个差距就是要标定掉的。零点标定就是让"以为"和"真实"重新对齐，像给手表对时。',
  },
  'kp-vision': {
    title: '退一步 · 手眼标定在解决什么',
    text: '相机看到的是像素，机器人走的是毫米——中间需要一个"翻译官"，这就是手眼矩阵。AX=XB 求的就是这个翻译官。',
  },
  'kp-safety': {
    title: '退一步 · 安全的底层逻辑',
    text: '所有安全设计只有一句话：故障导向安全——任何一处断线、失电、失灵，结果都必须是"停下来"，而不是"继续动"。急停、光幕、联锁都是这句话的具体化。',
  },
  'kp-diagnosis': {
    title: '退一步 · 排故的第一原则',
    text: '先读懂报警，再动手。报警代码是设备在"说话"：级别（提示/警告/停机）告诉你多严重，代码含义告诉你从哪查。盲目断电重启 = 把证据擦掉。',
  },
};

/** 每知识点预置 QA（举手提问的知识库，关键词匹配） */
export interface PresetQA {
  keywords: string[];
  q: string;
  a: string;
  kbRef?: string;
}

export const qaBank: Record<string, PresetQA[]> = {
  'kp-plc': [
    { keywords: ['常闭', '常开', '区别'], q: '常开和常闭触点有什么区别？', a: '常开默认断开、信号来了闭合；常闭默认导通、信号来了断开。安全回路必须用常闭——断线时等效于"触发停机"，故障导向安全。', kbRef: 'KB-012' },
    { keywords: ['profinet', '通讯', '总线', '以太网'], q: '为什么用 PROFINET 而不是串口？', a: '工业以太网提供周期性 I/O 映射和毫秒级确定性时延，支持几十上百个节点组网；串口轮询速度慢、拓扑受限，只适合点对点调试。' },
    { keywords: ['联锁', '安全门'], q: '安全门联锁怎么接？', a: '门磁开关的常闭触点串入使能回路：门开 → 回路断 → 驱动下电。注意不能用软件轮询代替硬接线，响应等级不够。', kbRef: 'KB-012' },
  ],
  'kp-kinematics': [
    { keywords: ['dh', 'd-h', '参数'], q: 'D-H 参数到底是什么？', a: '用 4 个参数（连杆长度 a、扭转角 α、偏距 d、关节角 θ）唯一确定相邻关节的变换关系。六轴机器人 6 组参数连乘就是正运动学。', kbRef: 'KB-009' },
    { keywords: ['正解', '逆解', '区别'], q: '正解和逆解的区别？', a: '正解：已知各关节角，算末端位姿——唯一解。逆解：已知目标位姿，反求关节角——多解（六轴常见 8 组），要按最短行程和避奇异取舍。', kbRef: 'KB-022' },
    { keywords: ['奇异', '位形'], q: '什么是奇异位形？', a: '某些姿态下机器人丢失一个自由度（如腕部两轴共线），此时逆解发散、关节速度趋于无穷——轨迹规划必须绕开。' },
    { keywords: ['tcp', '工具坐标'], q: 'TCP 是什么？', a: '工具中心点（Tool Center Point）——工具坐标系的原点，比如焊枪尖端。所有"走直线到某点"都是在说 TCP 的轨迹。', kbRef: 'KB-002' },
  ],
  'kp-sensor': [
    { keywords: ['零点', '标定', '步骤'], q: '零点标定的步骤？', a: '五步：回零准备 → 粗对零（刻线错位≤一格）→ 精对零（百分表波动≤0.02mm）→ 写入零点 → 复测验证（10 点 TCP 偏移<0.5mm）。错一步回到上一步。', kbRef: 'KB-018' },
    { keywords: ['温度', '漂移', '补偿'], q: '温度漂移怎么补偿？', a: '线性补偿 Δθ=k(T−T₀)，k 由五点恒温实验拟合（典型 0.021°/10℃），只在验证区间（10–35℃）内有效，超出必须重新拟合，不能抄出厂默认值。', kbRef: 'KB-021' },
    { keywords: ['准确度', '重复', '区别'], q: '位姿准确度和重复定位精度的区别？', a: '准确度：指令位姿 vs 实到位姿集群重心的偏差（准不准）。重复精度：多次实到位姿彼此的离散度（稳不稳）。验收两个都要测，依据 GB/T 12642。', kbRef: 'KB-007' },
  ],
  'kp-vision': [
    { keywords: ['手眼', 'ax', 'xb'], q: 'AX=XB 是怎么回事？', a: 'A 是机器人两次运动的位姿变化，B 是相机看到的对应变化，X 就是要求的手眼矩阵。采集 12–20 组姿态、旋转要大于 30°，纯平移会让解退化。', kbRef: 'KB-011' },
    { keywords: ['eye in hand', 'eye to hand', '区别'], q: 'Eye-in-Hand 和 Eye-to-Hand 的区别？', a: '相机装在手上（跟着动，视野灵活、标定后精度高）vs 固定在外（视野固定、不占负载）。分拣常用固定式，精密装配常用手上式。' },
    { keywords: ['光照', '曝光'], q: '现场光照变化怎么办？', a: '曝光和增益必须随现场光照标定，配合遮光罩/背光源稳定成像；否则特征匹配阈值一失效，抓取位姿就漂。', kbRef: 'KB-016' },
  ],
  'kp-safety': [
    { keywords: ['250', '速度', '手动', '示教'], q: '为什么示教模式限速 250mm/s？', a: 'GB 11291.1 规定手动模式 TCP ≤250mm/s——这是人来得及躲避的速度上限，同时要求三位使能开关：松手或握死都停机。', kbRef: 'KB-005' },
    { keywords: ['急停', '复位', '重启'], q: '急停复位后为什么不能自动重启？', a: '标准要求复位只是"允许再启动"，必须由人再执行启动指令——防止急停原因未排除时设备突然动作伤人。', kbRef: 'KB-001' },
    { keywords: ['风险评估', '三步'], q: '风险评估三步法是什么？', a: '危险识别 → 风险估计（严重度×频率×可避免性）→ 防护措施确认，依据 GB/T 15706，输出 JHA 作业危害分析表。', kbRef: 'KB-012' },
  ],
  'kp-diagnosis': [
    { keywords: ['报警', '第一步'], q: '看到报警第一步做什么？', a: '查手册读懂报警：确认级别（提示/警告/停机）与含义，保留现场证据，再按故障树排查——盲目断电重启会擦掉证据。', kbRef: 'KB-020' },
    { keywords: ['减速器', '异响', '振动'], q: '减速器磨损怎么判断？', a: '与轴运动周期同步的异响先怀疑传动链；用振动频谱找特征频率（注意用对齿数参数），结合背隙测量和油液铁谱确认。', kbRef: 'KB-020' },
    { keywords: ['故障树', '割集'], q: '故障树怎么用？', a: '从顶事件（如"轴不动"）往下分解到基本事件，求最小割集找出"哪几件事同时发生就必然故障"——注意别漏共因失效（如同一电源）。' },
  ],
};

/** 通用兜底回答 */
export const fallbackAnswer =
  '这个问题超出了本讲的预置范围——我已记入你的提问清单，导学 Agent 会在「练」环节展开讲。先回到课程，也可以换个问法再试试。';

/* ================= 精品演播块（P2 手写剧本：视听同步示范） ================= */
const showcaseStage: Record<string, CourseBlock> = {
  'kp-sensor': {
    kind: 'stage',
    id: 'kp-sensor-stage',
    title: '先看明白：误差从哪来，标定标什么',
    kbRefs: ['KB-021'],
    items: [
      { type: 'figure', figure: 'deviation' },                                  // 0
      { type: 'bullet', text: '控制器"以为"的位置 A：来自编码器读数' },          // 1
      { type: 'bullet', text: '末端"真实"的位置 A′：受温漂/磨损/零点漂移影响' }, // 2
      { type: 'formula', text: 'Δθ = k (T − T₀)', note: 'k ≈ 0.021°/10℃ · 五点恒温实验拟合' }, // 3
      { type: 'bignum', value: '0.02 mm', label: '精对零判据 · 百分表波动上限' }, // 4
      { type: 'kb', kbId: 'KB-021' },                                           // 5
    ],
    cues: [
      { say: '开始之前，先看清楚我们到底在标定什么。', reveal: [0] },
      { say: '机器人的控制器有一个"以为"的位置，来自各轴编码器的读数。', reveal: [1] },
      { say: '但末端的真实位置会因为温度漂移、机械磨损和零点漂移，悄悄偏离——图上这段红色偏差，就是标定要消灭的东西。', reveal: [2] },
      { say: '其中温度的影响可以用线性模型补偿：偏差角等于系数 k 乘以温差。注意，k 不能抄默认值，要用五点恒温实验拟合。', reveal: [3] },
      { say: '精对零的验收判据记住这个数：百分表波动不超过零点零二毫米。', reveal: [4] },
      { say: '这些不是我说的，出处在这里——行标切片 KB-021，随时可以点开核对。', reveal: [5], kbFlash: true },
    ],
  },
  'kp-kinematics': {
    kind: 'stage',
    id: 'kp-kinematics-stage',
    title: '一图看懂：正解与逆解',
    kbRefs: ['KB-022'],
    items: [
      { type: 'figure', figure: 'chain' },                                    // 0
      { type: 'bullet', text: '正解：已知六个关节角 → 算末端位姿（唯一解）' },  // 1
      { type: 'formula', text: 'T = A₁·A₂·A₃·A₄·A₅·A₆', note: '六个连杆变换矩阵连乘' }, // 2
      { type: 'bullet', text: '逆解：已知目标位姿 → 反求关节角（多解）' },      // 3
      { type: 'bignum', value: '8 组', label: '六轴臂典型逆解数 · 按最短行程取舍' }, // 4
      { type: 'kb', kbId: 'KB-022' },                                          // 5
    ],
    cues: [
      { say: '运动学只回答两个方向的问题，先看这条运动链。', reveal: [0] },
      { say: '从关节到末端，叫正解：六个关节角已知，末端位姿算出来是唯一的。', reveal: [1] },
      { say: '数学上就是六个连杆变换矩阵依次连乘，得到总变换 T。', reveal: [2] },
      { say: '反过来，从目标位姿反求关节角，叫逆解——它麻烦在解不唯一。', reveal: [3] },
      { say: '六轴机器人典型情况有八组解，工程上按最短行程原则取舍，同时要避开奇异位形。', reveal: [4] },
      { say: '推导细节的出处是 KB-022，点角标可以看原文。', reveal: [5], kbFlash: true },
    ],
  },
};

/** 交互演示的导览剧本（"跟我看一遍"）：语音讲第几步，演示就演到第几步 */
const demoCues: Record<string, Cue[]> = {
  calibration: [
    { say: '下面这个模拟器，我先带你走一遍，看完你自己动手。', reveal: [] },
    { say: '第一步，回零准备：卸下工装，切到 T1 手动模式，各轴点动到零位刻线附近。', reveal: [0] },
    { say: '第二步，粗对零：目视对齐刻线，错位不能超过一格。', reveal: [1] },
    { say: '第三步，精对零：J2、J3 上百分表找正，波动小于等于零点零二毫米才算到位。', reveal: [2] },
    { say: '第四步，写入零点：示教器里逐轴写入，编码器值记录存档。', reveal: [3] },
    { say: '最后复测验证：跑十个教学点，TCP 偏移小于零点五毫米，合格。现在轮到你了——注意顺序不能乱。', reveal: [4] },
  ],
  frame: [
    { say: '这个演示我先动给你看：注意右边矩阵哪里在变。', reveal: [] },
    { say: '先沿 X 平移——看，矩阵最后一列的第一个数在跟着变，平移量藏在最后一列。', reveal: [0] },
    { say: '再沿 Y 平移——最后一列的第二个数动了。', reveal: [1] },
    { say: '现在旋转：左上角二乘二的旋转子块整体在变，这就是 R 和 t 的分工。接下来你自己拖拖看。', reveal: [2] },
  ],
  plc: [
    { say: '下面这张梯形图我先带你走一遍，再交给你玩。', reveal: [] },
    { say: '看结构：安全门、急停都是常闭触点，和启动按钮串成一条回路，末端是 K1 线圈。', reveal: [0] },
    { say: '按下启动——回路导通，K1 得电，电机运行。', reveal: [1] },
    { say: '注意第二行：K1 的辅助触点把启动按钮短接了，这叫自保持——松开按钮电机也继续转。', reveal: [2] },
    { say: '现在把安全门打开：常闭断开，整条回路瞬间失电，电机停——这就是联锁。轮到你操作了。', reveal: [3] },
  ],
  safety: [
    { say: '这条安全链路我先演一遍。', reveal: [] },
    { say: '从电源到驱动器，急停、光幕、门锁全部串联，而且都是常闭——任何一环断开，后面全部失电。', reveal: [0] },
    { say: '我按下急停——链路从这里断开，电机立刻停。', reveal: [1] },
    { say: '恢复急停之后按复位：注意，设备只是就绪，并不会自己转起来——复位不等于重启。', reveal: [2] },
    { say: '必须由人再按一次启动，电机才恢复运行。这是国标 11291 的硬性要求。你来试试。', reveal: [3] },
  ],
  vision: [
    { say: '视觉引导的最短闭环，我先走一遍。', reveal: [] },
    { say: '左边是相机看到的画面：工件的位置是像素坐标 u 和 v。', reveal: [0] },
    { say: '中间这组系数就是手眼标定的成果——像素坐标乘上它，翻译成机器人的毫米坐标。', reveal: [1] },
    { say: '右边机器人拿到坐标，直接走到抓取点。现在你拖动工件试试，看抓取点怎么跟着走。', reveal: [2] },
  ],
  fault: [
    { say: '排故不靠猜，我带你沿故障树走一遍。', reveal: [] },
    { say: '先读懂顶事件：J3 轴不动，报警号 SRVO-062——报警是设备在说话。', reveal: [0] },
    { say: '第一层分解成三类可能：电气、机械、参数。', reveal: [1] },
    { say: '报警含义指向编码器，先查电气支路。', reveal: [2] },
    { say: '测编码器电池：二点九伏，低于三伏阈值——根因命中。接下来你自己点开每个节点看证据。', reveal: [3] },
  ],
};

/** 各知识点的交互演示元数据（首个概念块后插入） */
const demoMeta: Record<string, { demo: 'calibration' | 'frame' | 'plc' | 'safety' | 'vision' | 'fault'; title: string; script: string }> = {
  'kp-sensor': {
    demo: 'calibration',
    title: '跟我看一遍，再自己动手 · 零点标定五步模拟器',
    script: '下面是零点标定模拟器。请按正确顺序点击五个步骤——顺序错了机器可不答应。做完我们继续。',
  },
  'kp-kinematics': {
    demo: 'frame',
    title: '跟我看一遍，再自己动手 · 拖动 TCP 看坐标变换',
    script: '下面是坐标变换演示。拖动滑块移动和旋转工具坐标系，右侧的变换矩阵会实时变化。',
  },
  'kp-plc': {
    demo: 'plc',
    title: '跟我看一遍，再自己动手 · 安全门联锁梯形图',
    script: '下面是联锁梯形图模拟。试着启动电机、打开安全门，看看常闭触点是怎么保命的。',
  },
  'kp-safety': {
    demo: 'safety',
    title: '跟我看一遍，再自己动手 · 安全回路：断开即停',
    script: '下面是安全回路演示。触发急停、光幕或安全门，观察链路从哪里断开——再体会为什么复位不等于重启。',
  },
  'kp-vision': {
    demo: 'vision',
    title: '跟我看一遍，再自己动手 · 像素坐标到机器人坐标',
    script: '下面是视觉引导演示。拖动工件改变它在相机里的像素位置，看机器人抓取点怎么跟着换算。',
  },
  'kp-diagnosis': {
    demo: 'fault',
    title: '跟我看一遍，再自己动手 · 沿故障树找根因',
    script: '下面是故障树排查演示。从报警出发逐层点开，用读数证据定位根因。',
  },
};

/* ================= 单元课件生成 ================= */
export function buildUnit(kpId: string, learner: Learner, styleOverride?: StyleLabel): CourseUnit {
  const kp = getKnowledgePoint(kpId);
  const d = difficultyOf(learner, kpId);
  const style = styleOf(learner, styleOverride);
  const slices = slicesOf(kpId);
  const quizzes = quizByKp(kpId);
  const checkpointQ = quizzes.find((q) => q.level === 'basic') ?? quizzes[0];
  const checkpointQ2 = quizzes.filter((q) => q.id !== checkpointQ?.id).find((q) => (d === '进阶' ? q.level !== 'basic' : q.level === 'basic')) ?? quizzes[1];

  const blocks: CourseBlock[] = [];

  /* 开场 */
  blocks.push({
    kind: 'concept',
    id: `${kpId}-intro`,
    title: `${kp.name} · 这一讲学什么`,
    text: `${style.opener(kp.name)}\n${difficultyLine(d)}\n${kp.description}`,
    kbRefs: slices.slice(0, 1).map((s) => s.id),
    script: `${style.opener(kp.name)} ${difficultyLine(d)} 这一讲我们学${kp.name}。${kp.description}`,
  });

  /* 精品演播块（有剧本的知识点：视听同步讲播） */
  if (showcaseStage[kpId]) blocks.push(showcaseStage[kpId]);

  /* 概念块：coreTopics × KB 切片 */
  kp.coreTopics.slice(0, d === '零基础' ? 2 : 3).forEach((topic, i) => {
    const slice = slices[i % Math.max(1, slices.length)];
    const cite = slice ? `依据${slice.type}《${slice.title}》${slice.standardNo ? `（${slice.standardNo}）` : ''}：${slice.excerpt}` : '';
    blocks.push({
      kind: 'concept',
      id: `${kpId}-c${i}`,
      title: `${i + 1} · ${topic}`,
      text: `${slice?.summary ?? kp.description}\n${cite}`,
      kbRefs: slice ? [slice.id] : [],
      script: `第${i + 1}个要点，${topic}。${slice?.summary ?? ''} ${slice ? `这一条有出处，来自${slice.type} ${slice.standardNo ?? slice.source}。` : ''}`,
    });
    /* 首个概念后插入交互演示（6 大知识点全覆盖，多模态铺满） */
    if (i === 0 && demoMeta[kpId]) {
      const meta = demoMeta[kpId];
      blocks.push({
        kind: 'demo',
        id: `${kpId}-demo`,
        demo: meta.demo,
        title: meta.title,
        script: meta.script,
        cues: demoCues[meta.demo],
      });
    }
    /* 概念后插检查点 */
    if (i === 0 && checkpointQ) {
      blocks.push({
        kind: 'checkpoint',
        id: `${kpId}-cp0`,
        q: checkpointQ,
        script: '到检查点了。做一道题看看刚才的内容接住没有——答错也没关系，我会换个讲法。',
      });
    }
  });

  /* 第二检查点（进阶/标准） */
  if (d !== '零基础' && checkpointQ2) {
    blocks.push({
      kind: 'checkpoint',
      id: `${kpId}-cp1`,
      q: checkpointQ2,
      script: '再来一道稍难的，验证一下这一讲的整体掌握。',
    });
  }

  /* 小结 */
  blocks.push({
    kind: 'summary',
    id: `${kpId}-sum`,
    text: `本讲要点：${kp.coreTopics.slice(0, 3).join('；')}。学完建议：到「练」里做 ${kp.name} 的分阶题巩固，阿诊会根据你的表现更新画像。`,
    script: `这一讲就到这里。要点回顾：${kp.coreTopics.slice(0, 3).join('，')}。建议接着去练一组分阶题，我会根据你的表现更新画像。`,
  });

  return { kpId, difficulty: d, styleLabel: style.label, blocks };
}

/** 降维 block（ARB-05 在检查点答错后插入） */
export function remedialBlockOf(kpId: string): CourseBlock {
  const r = remedialText[kpId] ?? remedialText['kp-sensor'];
  const slice = slicesOf(kpId)[0];
  return {
    kind: 'remedial',
    id: `${kpId}-remedial-${Date.now().toString(36)}`,
    title: r.title,
    text: r.text,
    kbRefs: slice ? [slice.id] : [],
    script: `没关系，我们退一步。${r.text}`,
  };
}

/** 变式讲法块（签到条「换个讲法」插入）：问答体重讲，内容取自 QA 库，与降维块不重复 */
export function variantBlockOf(kpId: string, seq: number): CourseBlock {
  const pool = qaBank[kpId] ?? [];
  const qa = pool.length > 0 ? pool[seq % pool.length] : null;
  const r = remedialText[kpId] ?? remedialText['kp-sensor'];
  return {
    kind: 'concept',
    id: `${kpId}-variant-${seq}-${Date.now().toString(36)}`,
    title: qa ? `换个讲法 · 自问自答：${qa.q}` : '换个讲法 · 直觉版',
    text: qa ? qa.a : r.text,
    kbRefs: qa?.kbRef ? [qa.kbRef] : [],
    script: qa ? `好，换个讲法，用一问一答再过一遍。${qa.q} ${qa.a}` : `好，换个讲法。${r.text}`,
  };
}

/** 抽题（签到条「出道题」/ 讲末微测与进阶挑战） */
export function drawQuestions(
  kpId: string,
  count: number,
  opts?: { excludeIds?: string[]; levels?: QuizQuestion['level'][] },
): QuizQuestion[] {
  const ex = new Set(opts?.excludeIds ?? []);
  return quizByKp(kpId)
    .filter((q) => !ex.has(q.id) && (!opts?.levels || opts.levels.includes(q.level)))
    .slice(0, count);
}

/** QA 匹配（举手提问） */
export function matchQA(kpId: string, question: string): PresetQA | null {
  const pool = qaBank[kpId] ?? [];
  const qLower = question.toLowerCase();
  let best: { qa: PresetQA; hits: number } | null = null;
  pool.forEach((qa) => {
    const hits = qa.keywords.filter((k) => qLower.includes(k.toLowerCase())).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { qa, hits };
  });
  return best ? (best as { qa: PresetQA }).qa : null;
}

/** 单元目录元数据 */
export const unitList = knowledgePoints.map((kp) => kp.id);
