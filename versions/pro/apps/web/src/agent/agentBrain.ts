/**
 * agentBrain — 伴学助手的规则推理层（纯函数，无副作用）
 * 信号 → 推断（分数增量 + 置信度变化 + 一句人话 + 证据）
 * 纯前端演示：规则引擎扮演 Agent 大脑，话术模板扮演生成。
 */
import type { QuizLevel, QuizQuestion } from '@/data/quizBank';
import { quizByKp } from '@/data/quizBank';
import { getKnowledgePoint } from '@/data/knowledgePoints';

/* ================= 信号 ================= */
export type Signal =
  | { type: 'quiz-answer'; kpId: string; level: QuizLevel; correct: boolean; value?: number }
  | { type: 'lecture-read'; kpId: string; title: string; value?: number }
  | { type: 'guide-complete'; kpId: string; title: string; value?: number }
  | { type: 'tutoring-finished'; kpId: string; title: string; asked: number; correct: number; value?: number }
  | { type: 'note-taken'; kpId: string; title: string; value?: number }
  /* 课件段落签到：学习者主动自评（元认知证据，弱信号只动置信度） */
  | { type: 'self-report'; kpId: string; feel: 'ok' | 'unsure' }
  /* 模态切换：学习者用行为投票自己的学习风格 */
  | { type: 'modality-switch'; kpId: string; mode: 'read' | 'cards' | 'listen' };

/** 信号的人类可读描述（证据链用） */
export function describeSignal(s: Signal): string {
  const kp = getKnowledgePoint(s.kpId).name;
  switch (s.type) {
    case 'quiz-answer':
      return `${kp} · ${s.level === 'basic' ? '基础' : s.level === 'advanced' ? '进阶' : '挑战'}题 ${s.correct ? '答对' : '答错'}`;
    case 'lecture-read':
      return `读完讲义《${s.title}》（${kp}）`;
    case 'guide-complete':
      return `完成实操《${s.title}》五步打卡（${kp}）`;
    case 'tutoring-finished':
      return `完成《${s.title}》导学 · ${s.correct}/${s.asked} 答对（${kp}）`;
    case 'note-taken':
      return `在《${s.title}》记了一条笔记（${kp}）→ 我的笔记`;
    case 'self-report':
      return `课件签到：自评「${kp}」${s.feel === 'ok' ? '这段很稳' : '这段还虚'}（元认知信号）`;
    case 'modality-switch':
      return `把「${kp}」的讲解切成${s.mode === 'cards' ? '图卡' : s.mode === 'listen' ? '听讲' : '文字'}模式（风格偏好信号）`;
  }
}

/* ================= 推断 ================= */
export interface Inference {
  /** 分数增量（0 = 仅置信度/消息） */
  delta: number;
  /** 置信度增量 */
  confDelta: number;
  /** 伴学助手要说的话 */
  say: string;
  /** 时间线事件标题（delta≠0 时用） */
  eventTitle: string;
  eventDetail: string;
}

/** 3 题一组的测验缓冲结算 */
export function inferQuizBatch(kpId: string, buf: { n: number; right: number; hardRight: number }): Inference {
  const kp = getKnowledgePoint(kpId).name;
  const rate = buf.right / buf.n;
  if (rate >= 0.99) {
    const delta = buf.hardRight > 0 ? 6 : 4;
    return {
      delta,
      confDelta: 20,
      say: `刚才「${kp}」${buf.n} 题全对${buf.hardRight ? '（还包括进阶题）' : ''}，这一维我给你上调 ${delta} 分。下次给你上更难的。`,
      eventTitle: `「${kp}」测验 ${buf.n}/${buf.n} 全对`,
      eventDetail: `DIA-01 依据强证据上调 · 置信度提升`,
    };
  }
  if (rate >= 0.6) {
    return {
      delta: 3,
      confDelta: 15,
      say: `「${kp}」这组题答对 ${buf.right}/${buf.n}，稳中有进，+3 分。错的那道我记下了，之后会在导学里追问你。`,
      eventTitle: `「${kp}」测验 ${buf.right}/${buf.n}`,
      eventDetail: 'DIA-01 依据答题表现上调',
    };
  }
  if (rate > 0) {
    return {
      delta: 0,
      confDelta: 10,
      say: `「${kp}」这组答对 ${buf.right}/${buf.n}，我先不动你的分数，但对这一维的判断更有把握了——建议先回讲义补一下再来。`,
      eventTitle: '',
      eventDetail: '',
    };
  }
  return {
    delta: -3,
    confDelta: 15,
    say: `「${kp}」这组题都没答上来，我把这一维下调 3 分——不是坏事，画像准了，我推给你的内容才会真的适合你。已建议 ARB-05 给你降维讲义。`,
    eventTitle: `「${kp}」测验 0/${buf.n} · 下调修正`,
    eventDetail: 'DIA-01 下调该维评估 · 触发降维建议',
  };
}

export function inferLectureRead(kpId: string, title: string): Inference {
  const kp = getKnowledgePoint(kpId).name;
  return {
    delta: 2,
    confDelta: 6,
    say: `看到你读完了《${title}》。阅读是弱证据，我先给「${kp}」+2 分——想让我更确信的话，去做两道题验证一下。`,
    eventTitle: `读完《${title}》`,
    eventDetail: `DIA-01 依据阅读行为微调「${kp}」（弱证据）`,
  };
}

export function inferGuideComplete(kpId: string, title: string): Inference {
  const kp = getKnowledgePoint(kpId).name;
  return {
    delta: 3,
    confDelta: 10,
    say: `《${title}》五步全部打卡完成，实操留痕是硬证据，「${kp}」+3 分。开始前确认也全过了，这个习惯很好。`,
    eventTitle: `完成实操《${title}》`,
    eventDetail: `DIA-01 依据实操打卡上调「${kp}」`,
  };
}

export function inferTutoringFinished(kpId: string, title: string, asked: number, correct: number): Inference {
  const kp = getKnowledgePoint(kpId).name;
  const acc = asked > 0 ? correct / asked : 0;
  const delta = Math.round(2 + acc * 5);
  return {
    delta,
    confDelta: 18,
    say: `《${title}》这节导学答对 ${correct}/${asked}（${Math.round(acc * 100)}%），「${kp}」+${delta} 分。${
      acc >= 0.85 ? 'ARB-05 已解锁进阶挑战。' : acc < 0.6 ? '我让 ARB-05 准备了降维解释。' : '保持这个节奏。'
    }`,
    eventTitle: `完成《${title}》导学`,
    eventDetail: `答对 ${correct}/${asked} · ARB-05 回写「${kp}」`,
  };
}

/** 记笔记：弱证据，主要涨置信度；首条笔记给一句鼓励（去重由 AgentContext 负责） */
export function inferNoteTaken(kpId: string): Inference {
  const kp = getKnowledgePoint(kpId).name;
  return {
    delta: 0,
    confDelta: 4,
    say: `看到你在「${kp}」记了第一条笔记——用自己的话重述是最好的学习。笔记已存入「我的笔记」，我对这一维的判断也更有底了。`,
    eventTitle: '',
    eventDetail: '',
  };
}

/* ================= 验证测验（P2 讨价还价） ================= */
export function pickVerifyQuestions(kpId: string): QuizQuestion[] {
  const pool = quizByKp(kpId);
  const advanced = pool.filter((q) => q.level !== 'basic');
  const chosen = (advanced.length >= 2 ? advanced : pool).slice(0, 2);
  return chosen;
}

export function verifyResult(kpId: string, right: number): { delta: number; say: string; eventTitle: string } {
  const kp = getKnowledgePoint(kpId).name;
  if (right >= 2)
    return {
      delta: 6,
      say: `两道都对，是我保守了。「${kp}」上调 6 分，学习路径我也让 ARB-05 重排了。`,
      eventTitle: `「${kp}」验证测验 2/2 · 协商上调`,
    };
  if (right === 1)
    return {
      delta: 3,
      say: `对了一道——你比我记录的强一些，但还没到熟练。「${kp}」+3 分，另一道的考点我加进了你的复习清单。`,
      eventTitle: `「${kp}」验证测验 1/2 · 部分上调`,
    };
  return {
    delta: 0,
    say: `两道都没对上……这次先维持原评估。别灰心，错的这两个考点恰好说明我把盲区标对了——跟我去讲义把它补掉？`,
    eventTitle: '',
  };
}
