/**
 * LLM 适配层 · 接口定义
 *
 * 三个生成/推理服务的抽象接口。默认实现 = 现有规则引擎（离线降级，见 ruleEngine.ts）；
 * 后端真大模型到位后，实现同一组接口即可无缝替换（见 apiEngine.ts），
 * 由 VITE_LLM_MODE=rule|api 开关决定（见 index.ts）。
 *
 * 这样"规则引擎扮演 Agent 大脑"就有了一个明确的可替换边界：
 * 上层 UI/评测只依赖接口，不关心背后是规则还是大模型。
 */
import type { Learner } from '@/data/learners';
import type { CourseUnit, StyleLabel } from '@/data/courseware';
import type { RetrievalHit } from '@/agent/retriever';
import type { VerifyResult } from '@/agent/verify';

export type LlmMode = 'rule' | 'api';

/** GEN-03 资源生成 */
export interface GenerationService {
  readonly mode: LlmMode;
  /** 依据画像+知识点约束生成课件单元（事实源来自检索召回） */
  generateUnit(kpId: string, learner: Learner, styleOverride?: StyleLabel): Promise<CourseUnit>;
}

/** 追问 / 举手提问 的答复 */
export interface TutorAnswer {
  answer: string;
  /** 命中的 KB 溯源（若有） */
  kbRef?: string;
  /** true = 命中预置/检索答案；false = 走了兜底 */
  grounded: boolean;
}

/** 导学追问服务 */
export interface TutorService {
  readonly mode: LlmMode;
  answerQuestion(kpId: string, question: string): Promise<TutorAnswer>;
}

/** VER-04 审核裁判：溯源约束校验 */
export interface VerifyService {
  readonly mode: LlmMode;
  verifyUnit(unit: CourseUnit, grounded?: RetrievalHit[]): Promise<VerifyResult>;
}

export interface AgentServices {
  mode: LlmMode;
  generation: GenerationService;
  tutor: TutorService;
  verify: VerifyService;
}
