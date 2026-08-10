/**
 * verify — VER-04「审核裁判 Agent」的前端可落库版：溯源约束校验（纯函数）
 *
 * 核心约束（对应赛题"依托专业知识库确保零幻觉"）：
 *   每个"事实性叙述块"必须至少挂 1 条 KB 溯源，且该溯源：
 *     ① 真实存在于知识库；
 *     ② 与该知识点相关（属于同一 kp，或在该 kp 的召回集内 —— grounding）。
 *   违反其一即计为一次幻觉（无出处 / 出处不相关）。
 *
 * 评测脚本用它算"幻觉率"，单元测试用它验证"生成准确性"。
 */
import type { CourseBlock, CourseUnit } from '@/data/courseware';
import { getKBSlice } from '@/data/kbSlices';
import type { RetrievalHit } from '@/agent/retriever';

/** 需要溯源的叙述块类型（会做出事实性论断） */
const FACTUAL_KINDS = new Set(['concept', 'stage', 'remedial']);

export interface ClaimCheck {
  blockId: string;
  kind: CourseBlock['kind'];
  kbRefs: string[];
  supported: boolean;
  /** 未通过原因（supported=false 时给出） */
  reason?: 'missing-citation' | 'unknown-slice' | 'off-topic';
  detail?: string;
}

export interface VerifyResult {
  /** 需要溯源的断言总数 */
  claims: number;
  /** 有合规溯源的断言数 */
  supported: number;
  /** 未过审的断言 */
  unsupported: ClaimCheck[];
  checks: ClaimCheck[];
  /** 幻觉率 = unsupported / claims（claims=0 时为 0） */
  hallucinationRate: number;
}

/** 取块的 kbRefs（不同块结构字段一致，但 demo/checkpoint/summary 无该字段） */
function refsOf(b: CourseBlock): string[] {
  return 'kbRefs' in b && Array.isArray((b as { kbRefs?: string[] }).kbRefs)
    ? (b as { kbRefs: string[] }).kbRefs
    : [];
}

/**
 * 校验单个课件单元的溯源约束。
 * @param unit 生成的课件
 * @param grounded 该 kp 的召回集（retrieveForKp 结果）；提供时启用 grounding 校验
 */
export function validateUnit(unit: CourseUnit, grounded?: RetrievalHit[]): VerifyResult {
  const groundedIds = grounded ? new Set(grounded.map((h) => h.sliceId)) : null;
  const checks: ClaimCheck[] = [];

  for (const b of unit.blocks) {
    if (!FACTUAL_KINDS.has(b.kind)) continue;
    const kbRefs = refsOf(b);
    const base: ClaimCheck = { blockId: b.id, kind: b.kind, kbRefs, supported: false };

    if (kbRefs.length === 0) {
      checks.push({ ...base, reason: 'missing-citation', detail: '事实性叙述块未挂任何 KB 溯源' });
      continue;
    }
    // 只要有一条 kbRef 合规，即视为该断言可溯源
    let ok = false;
    let lastReason: ClaimCheck['reason'];
    let lastDetail: string | undefined;
    for (const ref of kbRefs) {
      const slice = getKBSlice(ref);
      if (!slice) {
        lastReason = 'unknown-slice';
        lastDetail = `引用了不存在的切片 ${ref}`;
        continue;
      }
      const sameKp = slice.kpId === unit.kpId;
      const inRecall = groundedIds ? groundedIds.has(ref) : true;
      if (sameKp || inRecall) {
        ok = true;
        break;
      }
      lastReason = 'off-topic';
      lastDetail = `切片 ${ref} 与知识点 ${unit.kpId} 不相关，且不在召回集内`;
    }
    checks.push(ok ? { ...base, supported: true } : { ...base, reason: lastReason, detail: lastDetail });
  }

  const unsupported = checks.filter((c) => !c.supported);
  const claims = checks.length;
  return {
    claims,
    supported: claims - unsupported.length,
    unsupported,
    checks,
    hallucinationRate: claims === 0 ? 0 : unsupported.length / claims,
  };
}
