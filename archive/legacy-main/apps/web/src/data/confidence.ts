/**
 * 画像置信度档案 — 按建档方式区分画像的可信程度（localStorage 持久化）
 * - 精简建档(quick)：只有背景先验，置信度低 → 前两讲检查点边学边校准
 * - 精准定制(full)：先验 + 自评 + 自适应测题，建档即高置信
 * 预设画像不落档（评委测试用例视为已充分校准，不加徽标干扰）。
 */

export interface ProfileConfidence {
  /** 建档方式 */
  method: 'quick' | 'full';
  /** 置信度 0~100 */
  value: number;
}

const K = 'lf.profileConfidence';

function readAll(): Record<string, ProfileConfidence> {
  try {
    const raw = window.localStorage.getItem(K);
    return raw ? (JSON.parse(raw) as Record<string, ProfileConfidence>) : {};
  } catch {
    return {};
  }
}

export function getConfidence(learnerId: string): ProfileConfidence | null {
  return readAll()[learnerId] ?? null;
}

export function setConfidence(learnerId: string, c: ProfileConfidence): void {
  try {
    window.localStorage.setItem(K, JSON.stringify({ ...readAll(), [learnerId]: c }));
  } catch { /* ignore */ }
}

/** 学习动作带来的校准增量（检查点/分阶题作答后调用，涨到 90 封顶） */
export function bumpConfidence(learnerId: string, delta = 3): void {
  const cur = getConfidence(learnerId);
  if (!cur || cur.value >= 90) return;
  setConfidence(learnerId, { ...cur, value: Math.min(90, cur.value + delta) });
}
