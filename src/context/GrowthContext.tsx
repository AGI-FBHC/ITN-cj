/**
 * GrowthContext — 学习激励体系：能量账本 + 知识树 + 专注模式
 * 能量只从真实学习信号派生（订阅 AgentContext 广播的 lf-signal 事件，零侵入）；
 * 能量先积在"能量球"，手动浇水才长树（养成仪式感）；树阶按累计浇灌量（演示阈值）。
 * focusMode 供外壳收起 chrome（专注上课），结算时能量加成回流。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { useProfile } from '@/context/ProfileContext';
import { knowledgePoints } from '@/data/knowledgePoints';
import type { Signal } from '@/agent/agentBrain';
import { api } from '@/lib/api';
import type { LearnerGrowth } from '@/lib/api';

/* ================= 能量规则：只要有学习进度，就按对应分值攒养分 ================= */
const QUIZ_LEVEL_VALUE: Record<string, number> = { basic: 40, advanced: 70, challenge: 100 };
function energyOf(s: Signal): { amt: number; text: string } | null {
  const value = (s as { value?: number }).value;
  const amt = (n: number) => Math.max(1, Math.min(100, Math.round(n)));
  switch (s.type) {
    case 'quiz-answer':
      // 答对按难度分值（基础 40 / 进阶 70 / 挑战 100）；答错也按“有进步”给少量努力养分
      return s.correct
        ? { amt: amt(value ?? QUIZ_LEVEL_VALUE[s.level] ?? 40), text: `答对一道${s.level === 'basic' ? '基础' : s.level === 'advanced' ? '进阶' : '挑战'}题` }
        : { amt: 8, text: '答题（虽然错了，努力也算）' };
    case 'lecture-read':
      // 读完一讲 = 该讲进度满分
      return { amt: amt(value ?? 100), text: `读完《${s.title.slice(0, 12)}…》` };
    case 'guide-complete':
      return { amt: amt(value ?? 100), text: '实操五步打卡' };
    case 'tutoring-finished':
      // 按本次导学的正确率折算（0-100）
      return { amt: amt(value ?? (s.asked > 0 ? (s.correct / s.asked) * 100 : 25)), text: `完成《${s.title}》导学` };
    case 'note-taken':
      return { amt: 20, text: '记了一条笔记' };
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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function logOf(growth: LearnerGrowth | null): EnergyEntry[] {
  return (growth?.events ?? []).map((event) => ({
    text: event.title,
    amt: event.amount,
    time: new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }),
  }));
}

export function GrowthProvider({ children }: { children: ReactNode }) {
  const { currentLearnerId, currentLearner } = useProfile();
  const [growth, setGrowth] = useState<LearnerGrowth | null>(null);
  const [focusMode, setFocusMode] = useState(false);

  useEffect(() => {
    if (!UUID_PATTERN.test(currentLearnerId)) {
      queueMicrotask(() => setGrowth(null));
      return;
    }
    let cancelled = false;
    api.getLearnerGrowth(currentLearnerId)
      .then((result) => { if (!cancelled) setGrowth(result); })
      .catch(() => { if (!cancelled) setGrowth(null); });
    return () => { cancelled = true; };
  }, [currentLearnerId]);

  /* 园子实时同步：资源播放器的答题/完成/重新练习直接上报成长事件但不经过 lf-signal，
     且切回页面时也应刷新——监听状态变更与页面可见，防抖拉取最新养分/能量 */
  useEffect(() => {
    if (!UUID_PATTERN.test(currentLearnerId)) return undefined;
    let timer: number | null = null;
    const refreshGrowth = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const learnerId = currentLearnerId;
        if (!learnerId || !UUID_PATTERN.test(learnerId)) return;
        void api.getLearnerGrowth(learnerId)
          .then((result) => { if (learnerId === currentLearnerId) setGrowth(result); })
          .catch(() => undefined);
      }, 1500);
    };
    const onStateChanged = () => refreshGrowth();
    const onVisible = () => { if (!document.hidden) refreshGrowth(); };
    window.addEventListener('lf:learning-state-changed', onStateChanged);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('lf:learning-state-changed', onStateChanged);
      document.removeEventListener('visibilitychange', onVisible);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [currentLearnerId]);

  /* 订阅信号总线 → 派生能量（解耦：AgentContext 只广播，不知道树的存在） */
  useEffect(() => {
    const onSignal = (e: Event) => {
      const { signal, learnerId } = (e as CustomEvent).detail as { signal: Signal; learnerId: string };
      const gain = energyOf(signal);
      if (!gain) return;
      if (!UUID_PATTERN.test(learnerId)) return;
      const eventType = signal.type === 'quiz-answer' && signal.correct ? 'quiz-answer-correct' : signal.type;
      void api.recordLearnerGrowthEvent({ learnerId, eventType, title: gain.text, amount: gain.amt })
        .then((result) => { if (learnerId === currentLearnerId) setGrowth(result); })
        .catch(() => toast.error('养分暂未同步', { description: '学习记录已保留，请稍后再试。' }));
    };
    window.addEventListener('lf-signal', onSignal);
    return () => window.removeEventListener('lf-signal', onSignal);
  }, [currentLearnerId]);

  const earn = useCallback((amt: number, text: string) => {
    if (amt <= 0 || !UUID_PATTERN.test(currentLearnerId)) return;
    void api.recordLearnerGrowthEvent({ learnerId: currentLearnerId, eventType: 'focus-bonus', title: text, amount: amt })
      .then(setGrowth)
      .catch(() => toast.error('养分暂未同步'));
  }, [currentLearnerId]);

  const water = useCallback(() => {
    if (!growth?.orb || !UUID_PATTERN.test(currentLearnerId)) return;
    const before = stageOf(growth.watered);
    void api.nourishLearnerGrowth(currentLearnerId)
      .then((result) => {
        setGrowth(result);
        const after = stageOf(result.watered);
        if (after > before) toast.success(`知识树长大了：${TREE_STAGES[after].name}！`, { description: TREE_STAGES[after].desc });
        else toast.success('滋养完成', { description: `养分已写入园子，当前累计 ${result.watered}` });
      })
      .catch(() => toast.error('滋养失败', { description: '后端没有保存成功，请稍后重试。' }));
  }, [currentLearnerId, growth]);

  const value = useMemo<GrowthContextValue>(() => {
    const orb = growth?.orb ?? 0;
    const watered = growth?.watered ?? 0;

    const fruits = knowledgePoints
      .filter((kp) => (currentLearner.scores[kp.id] ?? 0) >= kp.targetLevel)
      .map((kp) => ({ kpId: kp.id, name: kp.name }));

    return {
      orb,
      watered,
      stage: stageOf(watered),
      log: logOf(growth),
      fruits,
      earn,
      water,
      focusMode,
      setFocusMode,
    };
  }, [growth, currentLearner, focusMode, earn, water]);

  return <GrowthContext.Provider value={value}>{children}</GrowthContext.Provider>;
}

export function useGrowth(): GrowthContextValue {
  const ctx = useContext(GrowthContext);
  if (!ctx) throw new Error('useGrowth must be used within GrowthProvider');
  return ctx;
}
