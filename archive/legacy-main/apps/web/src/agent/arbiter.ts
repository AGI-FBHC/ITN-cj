/**
 * arbiter — ARB-05「决策仲裁 Agent」的纯规则层（无副作用，可单测）
 *
 * 把散落在 LearnUnit.tsx 的协同调度规则抽成单一事实源：
 *   ① 进阶挑战门槛：掌握度 ≥ 66 才可直接进阶，否则需协商；
 *   ② 挑战护栏：进阶挑战两错 → ARB-05 兑现"接你回来"，插降维块；
 *   ③ 检查点答错 → 插降维块换讲法；
 *   ④ 导学正确率 → 降维（<60%）/ 进阶（≥85%）判定（与 collabScript 门槛一致）。
 *
 * 提交物要求"针对多智能体协同调度逻辑的单元测试"——测的就是这里。
 */

/** 进阶挑战门槛：掌握度达到即可解锁 */
export const CHALLENGE_THRESHOLD = 66;
/** 挑战护栏：累计答错达到此数，ARB-05 接学习者回到降维讲解 */
export const CHALLENGE_MAX_WRONG = 2;
/** 导学正确率判定门槛 */
export const SIMPLIFY_ACC = 0.6;
export const ADVANCE_ACC = 0.85;

/** 是否可直接开始进阶挑战（否则走"协商"路径） */
export function canStartChallenge(kpScore: number): boolean {
  return kpScore >= CHALLENGE_THRESHOLD;
}

export interface CheckpointContext {
  /** 本题是否答对 */
  correct: boolean;
  /** 本题是否属于进阶挑战题 */
  isChallenge: boolean;
  /** 进入本题前，挑战已累计的错题数 */
  priorChallengeWrong: number;
}

export interface CheckpointDecision {
  /** 是否插入降维（remedial）块 */
  insertRemedial: boolean;
  /** 是否触发"两错接回"（撤回未做挑战题） */
  pullBack: boolean;
  /** 更新后的挑战错题计数 */
  challengeWrongNext: number;
  /** 决策代号（可视化/日志用） */
  action: 'none' | 'remedial' | 'pull-back';
  /** 决策理由（写入 agent-trace） */
  reason: string;
}

/**
 * 检查点作答后的 ARB-05 裁定。
 * 规则优先级：挑战两错接回 > 普通答错降维 > 无动作。
 */
export function decideOnCheckpoint(ctx: CheckpointContext): CheckpointDecision {
  const { correct, isChallenge, priorChallengeWrong } = ctx;
  const challengeWrongNext =
    isChallenge && !correct ? priorChallengeWrong + 1 : priorChallengeWrong;

  if (isChallenge && !correct && challengeWrongNext >= CHALLENGE_MAX_WRONG) {
    return {
      insertRemedial: true,
      pullBack: true,
      challengeWrongNext,
      action: 'pull-back',
      reason: `进阶挑战累计答错 ${challengeWrongNext} 次（阈值 ${CHALLENGE_MAX_WRONG}）→ 兑现"接你回来"，撤回未做挑战题并插入降维讲解`,
    };
  }
  if (!correct) {
    return {
      insertRemedial: true,
      pullBack: false,
      challengeWrongNext,
      action: 'remedial',
      reason: '检查点答错 → 插入降维块，换一种讲法重讲',
    };
  }
  return {
    insertRemedial: false,
    pullBack: false,
    challengeWrongNext,
    action: 'none',
    reason: '检查点答对 → 维持推进，无需干预',
  };
}

export type AccuracyDecision = 'simplify' | 'advance' | 'keep';

/** 导学/微测正确率 → 降维 / 进阶 / 保持 */
export function decideByAccuracy(accuracy: number): AccuracyDecision {
  if (accuracy >= ADVANCE_ACC) return 'advance';
  if (accuracy < SIMPLIFY_ACC) return 'simplify';
  return 'keep';
}
