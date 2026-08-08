/**
 * GrowthContext — 学习激励体系：能量账本 + 知识树 + 专注模式
 * 能量只从真实学习信号派生（订阅 AgentContext 广播的 lf-signal 事件，零侵入）；
 * 能量先积在"能量球"，手动浇水才长树（养成仪式感）；树阶按累计浇灌量（演示阈值）。
 * focusMode 供外壳收起 chrome（专注上课），结算时能量加成回流。
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { useProfile } from '@/context/ProfileContext';
import { knowledgePoints } from '@/data/knowledgePoints';
import type { Signal } from '@/agent/agentBrain';

/* ================= 能量规则（演示数值） ================= */
function energyOf(s: Signal): { amt: number; text: string } | null {
  switch (s.type) {
    case 'quiz-answer':
      return s.correct ? { amt: 5, text: '答对一题' } : { amt: 1, text: '答题（虽然错了，努力也算）' };
    case 'lecture-read':
      return { amt: 15, text: `读完《${s.title.slice(0, 12)}…》` };
    case 'guide-complete':
      return { amt: 20, text: '实操五步打卡' };
    case 'tutoring-finished':
      return { amt: 25, text: `完成《${s.title}》导学` };
    case 'note-taken':
      return { amt: 8, text: '记了一条笔记' };
    default:
      return null;
  }
}

/* ================= 树阶（演示阈值：5 分钟可从种子到幼苗） ================= */
export const TREE_STAGES = [
  { at: 0, name: '种子', desc: '一切从这里开始' },
  { at: 30, name: '发芽', desc: '第一片叶子出来了' },
  { at: 80, name: '幼苗', desc: '站稳了' },
  { at: 160, name: '小树', desc: '开始分枝' },
  { at: 280, name: '大树', desc: '可以结果了' },
] as const;

export function stageOf(watered: number): number {
  let s = 0;
  TREE_STAGES.forEach((st, i) => { if (watered >= st.at) s = i; });
  return s;
}

export interface EnergyEntry { text: string; amt: number; time: string }

interface GrowthState { orb: number; watered: number; log: EnergyEntry[] }

interface GrowthContextValue {
  /** 能量球（待浇） */
  orb: number;
  /** 累计浇灌（含画像基线） */
  watered: number;
  stage: number;
  log: EnergyEntry[];
  /** 达标结果的知识点（树上的果实） */
  fruits: { kpId: string; name: string }[];
  earn: (amt: number, text: string) => void;
  water: () => void;
  /** 专注模式 */
  focusMode: boolean;
  setFocusMode: (v: boolean) => void;
}

const GrowthContext = createContext<GrowthContextValue | null>(null);
const K_GROWTH = 'lf.growth';

const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });

export function GrowthProvider({ children }: { children: ReactNode }) {
  const { currentLearnerId, currentLearner } = useProfile();
  const [all, setAll] = useState<Record<string, GrowthState>>(() => {
    try {
      const raw = window.localStorage.getItem(K_GROWTH);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const [focusMode, setFocusMode] = useState(false);

  useEffect(() => {
    try { window.localStorage.setItem(K_GROWTH, JSON.stringify(all)); } catch { /* ignore */ }
  }, [all]);

  /* 订阅信号总线 → 派生能量（解耦：AgentContext 只广播，不知道树的存在） */
  useEffect(() => {
    const onSignal = (e: Event) => {
      const { signal, learnerId } = (e as CustomEvent).detail as { signal: Signal; learnerId: string };
      const gain = energyOf(signal);
      if (!gain) return;
      setAll((prev) => {
        const cur = prev[learnerId] ?? { orb: 0, watered: 0, log: [] };
        return {
          ...prev,
          [learnerId]: {
            ...cur,
            orb: cur.orb + gain.amt,
            log: [{ text: gain.text, amt: gain.amt, time: now() }, ...cur.log].slice(0, 30),
          },
        };
      });
    };
    window.addEventListener('lf-signal', onSignal);
    return () => window.removeEventListener('lf-signal', onSignal);
  }, []);

  const value = useMemo<GrowthContextValue>(() => {
    const cur = all[currentLearnerId] ?? { orb: 0, watered: 0, log: [] };
    /* 预设画像基线：老学员的树不该是种子（按平均分派生一次性基线） */
    const avg = knowledgePoints.reduce((s, kp) => s + (currentLearner.scores[kp.id] ?? 50), 0) / knowledgePoints.length;
    const baseline = Math.max(0, Math.round((avg - 40) * 4));
    const watered = baseline + cur.watered;

    const earn = (amt: number, text: string) => {
      if (amt <= 0) return;
      setAll((prev) => {
        const c = prev[currentLearnerId] ?? { orb: 0, watered: 0, log: [] };
        return {
          ...prev,
          [currentLearnerId]: { ...c, orb: c.orb + amt, log: [{ text, amt, time: now() }, ...c.log].slice(0, 30) },
        };
      });
    };

    const water = () => {
      if (cur.orb <= 0) return;
      const before = stageOf(watered);
      const after = stageOf(watered + cur.orb);
      setAll((prev) => {
        const c = prev[currentLearnerId] ?? { orb: 0, watered: 0, log: [] };
        return {
          ...prev,
          [currentLearnerId]: {
            ...c,
            watered: c.watered + c.orb,
            orb: 0,
            log: [{ text: '给知识树浇水', amt: -c.orb, time: now() }, ...c.log].slice(0, 30),
          },
        };
      });
      if (after > before) {
        toast.success(`知识树长大了：${TREE_STAGES[after].name}！`, { description: TREE_STAGES[after].desc });
      } else {
        toast.success('浇水完成', { description: `距离「${TREE_STAGES[Math.min(after + 1, TREE_STAGES.length - 1)].name}」还差 ${Math.max(0, TREE_STAGES[Math.min(after + 1, TREE_STAGES.length - 1)].at - (watered + cur.orb))} 能量` });
      }
    };

    const fruits = knowledgePoints
      .filter((kp) => (currentLearner.scores[kp.id] ?? 0) >= kp.targetLevel)
      .map((kp) => ({ kpId: kp.id, name: kp.name }));

    return {
      orb: cur.orb,
      watered,
      stage: stageOf(watered),
      log: cur.log,
      fruits,
      earn,
      water,
      focusMode,
      setFocusMode,
    };
  }, [all, currentLearnerId, currentLearner, focusMode]);

  return <GrowthContext.Provider value={value}>{children}</GrowthContext.Provider>;
}

export function useGrowth(): GrowthContextValue {
  const ctx = useContext(GrowthContext);
  if (!ctx) throw new Error('useGrowth must be used within GrowthProvider');
  return ctx;
}
