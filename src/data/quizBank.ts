/**
 * 分阶测试题库 — CS/Agent 方向
 * 真实题目优先读取后端 onboarding meta；此文件仅作为降级空占位。
 */

export type QuizLevel = 'basic' | 'advanced' | 'challenge';

export interface QuizQuestion {
  id: string;
  kpId: string;
  level: QuizLevel;
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

export const quizBank: QuizQuestion[] = [];

export const quizByKp = (kpId: string): QuizQuestion[] =>
  quizBank.filter((q) => q.kpId === kpId);

export const getQuizByIds = (ids: string[]): QuizQuestion[] =>
  ids.map((id) => quizBank.find((q) => q.id === id)).filter((q): q is QuizQuestion => Boolean(q));
