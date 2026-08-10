/**
 * ProfileContext — 全局学习者画像状态 + 视图模式 + 画像生命周期
 * - 预设 3 画像（评委测试用例）保留只读基线
 * - 支持用户自建画像（向导生成）、逐字段编辑、学习交互回写，全部 localStorage 持久化
 * - currentLearnerId 改变 → 全站取数联动；viewMode 决定 IA/布局
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Learner } from '@/data/learners';
import { learners as presetLearners, getLearner, weakestKpOf, strongestKpOf } from '@/data/learners';
import type { KnowledgePoint } from '@/data/knowledgePoints';
import { knowledgePoints, getKnowledgePoint } from '@/data/knowledgePoints';

export type ViewMode = 'learner' | 'expert';

/** 画像变更事件（变更时间线） */
export interface ProfileEvent {
  id: string;
  /** 周次或"建档"等标签 */
  week: string;
  kind: 'create' | 'edit' | 'writeback';
  title: string;
  detail?: string;
  deltas?: { kpId: string; from: number; to: number }[];
}

/** 建档草稿（向导输出） */
export interface LearnerDraft {
  name: string;
  avatar: string;
  tag: string;
  role: string;
  education: string;
  targetJob: string;
  weeklyHours: number;
  learningStyle: string[];
  scores: Record<string, number>;
  blindSpots: string[];
  goal: string;
}

/** 逐字段编辑覆盖 */
interface Override {
  scores?: Record<string, number>;
  goal?: string;
  blindSpots?: string[];
}

interface ProfileContextValue {
  /** 生效画像列表（预设 + 自建，均已应用编辑覆盖） */
  learners: Learner[];
  currentLearnerId: string;
  setCurrentLearnerId: (id: string) => void;
  currentLearner: Learner;
  weakestKp: KnowledgePoint;
  strongestKp: KnowledgePoint;
  demoMode: boolean;
  setDemoMode: (v: boolean) => void;
  viewMode: ViewMode;
  setViewMode: (v: ViewMode) => void;
  /** 画像生命周期 */
  createLearner: (draft: LearnerDraft) => string;
  patchLearner: (id: string, patch: Override, event?: Omit<ProfileEvent, 'id'>) => void;
  applyWriteback: (
    id: string,
    deltas: { kpId: string; delta: number }[],
    meta: { week: string; title: string; detail?: string },
  ) => void;
  getEvents: (id: string) => ProfileEvent[];
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

const K_VIEW = 'lf.viewMode';
const K_CUSTOM = 'lf.customLearners';
const K_OVERRIDES = 'lf.overrides';
const K_EVENTS = 'lf.events';
const K_CURRENT = 'lf.currentLearnerId';

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function readInitialMode(): ViewMode {
  if (typeof window === 'undefined') return 'learner';
  return window.localStorage.getItem(K_VIEW) === 'expert' ? 'expert' : 'learner';
}

const clamp = (n: number) => Math.max(12, Math.min(96, Math.round(n)));

/** 自建画像借用最相近预设的富内容 */
function nearestPresetId(scores: Record<string, number>): string {
  let best = presetLearners[0].id;
  let bestD = Infinity;
  for (const p of presetLearners) {
    const d = knowledgePoints.reduce((acc, kp) => {
      const a = scores[kp.id] ?? 50;
      const b = p.scores[kp.id] ?? 50;
      return acc + (a - b) ** 2;
    }, 0);
    if (d < bestD) {
      bestD = d;
      best = p.id;
    }
  }
  return best;
}

/** 由草稿构造完整 Learner */
function buildLearner(id: string, draft: LearnerDraft): Learner {
  const entries = Object.entries(draft.scores);
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);
  const strongestName = getKnowledgePoint(sorted[0]?.[0] ?? 'kp-plc').name;
  const weakestName = getKnowledgePoint(sorted[sorted.length - 1]?.[0] ?? 'kp-plc').name;
  const strongScore = sorted[0]?.[1] ?? 50;
  const weakScore = sorted[sorted.length - 1]?.[1] ?? 50;
  return {
    id,
    custom: true,
    dataBaseId: nearestPresetId(draft.scores),
    name: draft.name || '我',
    avatar: draft.avatar,
    age: 0,
    tag: draft.tag || '自建画像',
    role: draft.role || draft.targetJob,
    education: draft.education,
    school: '—',
    background: `自建画像 · ${draft.learningStyle.join(' / ') || '综合型'}。理论自测最强「${strongestName}」，最弱「${weakestName}」。`,
    targetJob: draft.targetJob,
    learningStyle: draft.learningStyle.length ? draft.learningStyle : ['综合'],
    weeklyHours: draft.weeklyHours,
    scores: draft.scores,
    strengths: sorted.slice(0, 2).map(([kp]) => getKnowledgePoint(kp).name),
    blindSpots: draft.blindSpots,
    preferredFormat: '按画像自适应',
    goal: draft.goal,
    diagnosisSummary: `DIA-01 诊断：最强「${strongestName}」${strongScore} 分，最弱「${weakestName}」${weakScore} 分。建议从「${weakestName}」切入，用分阶题巩固优势维度。`,
  };
}

function applyOverride(base: Learner, ov?: Override): Learner {
  if (!ov) return base;
  return {
    ...base,
    scores: ov.scores ? { ...base.scores, ...ov.scores } : base.scores,
    goal: ov.goal ?? base.goal,
    blindSpots: ov.blindSpots ?? base.blindSpots,
  };
}

let eventSeq = 0;
const newEventId = () => `ev-${Date.now().toString(36)}-${(eventSeq++).toString(36)}`;

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [currentLearnerId, setCurrentLearnerId] = useState<string>(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(K_CURRENT) : null;
    if (stored) {
      const all = [...presetLearners, ...readJSON<Learner[]>(K_CUSTOM, [])];
      if (all.some((l) => l.id === stored)) return stored;
    }
    return presetLearners[0].id;
  });
  const [demoMode, setDemoMode] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<ViewMode>(readInitialMode);

  const [customLearners, setCustomLearners] = useState<Learner[]>(() =>
    readJSON<Learner[]>(K_CUSTOM, []),
  );
  const [overrides, setOverrides] = useState<Record<string, Override>>(() =>
    readJSON<Record<string, Override>>(K_OVERRIDES, {}),
  );
  const [events, setEvents] = useState<Record<string, ProfileEvent[]>>(() =>
    readJSON<Record<string, ProfileEvent[]>>(K_EVENTS, {}),
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(K_VIEW, viewMode);
    } catch { /* ignore */ }
  }, [viewMode]);
  useEffect(() => {
    try { window.localStorage.setItem(K_CURRENT, currentLearnerId); } catch { /* ignore */ }
  }, [currentLearnerId]);
  useEffect(() => {
    try { window.localStorage.setItem(K_CUSTOM, JSON.stringify(customLearners)); } catch { /* ignore */ }
  }, [customLearners]);
  useEffect(() => {
    try { window.localStorage.setItem(K_OVERRIDES, JSON.stringify(overrides)); } catch { /* ignore */ }
  }, [overrides]);
  useEffect(() => {
    try { window.localStorage.setItem(K_EVENTS, JSON.stringify(events)); } catch { /* ignore */ }
  }, [events]);

  const value = useMemo<ProfileContextValue>(() => {
    const merged: Learner[] = [...presetLearners, ...customLearners].map((l) =>
      applyOverride(l, overrides[l.id]),
    );
    const byId = (id: string) => merged.find((l) => l.id === id);
    const currentLearner = byId(currentLearnerId) ?? merged[0];

    const createLearner = (draft: LearnerDraft): string => {
      const id = `u-${Date.now().toString(36)}`;
      const learner = buildLearner(id, draft);
      setCustomLearners((prev) => [...prev, learner]);
      setEvents((prev) => ({
        ...prev,
        [id]: [
          {
            id: newEventId(),
            week: '建档',
            kind: 'create',
            title: '画像建档完成',
            detail: `由 DIA-01 诊断向导生成 · 借用「${getLearner(learner.dataBaseId ?? 'lin').name}」的领域资源基线`,
          },
        ],
      }));
      setCurrentLearnerId(id);
      return id;
    };

    const patchLearner = (id: string, patch: Override, event?: Omit<ProfileEvent, 'id'>) => {
      setOverrides((prev) => {
        const cur = prev[id] ?? {};
        return {
          ...prev,
          [id]: {
            scores: patch.scores ? { ...(cur.scores ?? {}), ...patch.scores } : cur.scores,
            goal: patch.goal ?? cur.goal,
            blindSpots: patch.blindSpots ?? cur.blindSpots,
          },
        };
      });
      if (event) {
        setEvents((prev) => ({ ...prev, [id]: [{ id: newEventId(), ...event }, ...(prev[id] ?? [])] }));
      }
    };

    const applyWriteback = (
      id: string,
      deltas: { kpId: string; delta: number }[],
      meta: { week: string; title: string; detail?: string },
    ) => {
      const base = byId(id);
      if (!base) return;
      const scorePatch: Record<string, number> = {};
      const evDeltas: { kpId: string; from: number; to: number }[] = [];
      deltas.forEach(({ kpId, delta }) => {
        const from = base.scores[kpId] ?? 50;
        const to = clamp(from + delta);
        if (to !== from) {
          scorePatch[kpId] = to;
          evDeltas.push({ kpId, from, to });
        }
      });
      if (evDeltas.length === 0) return;
      patchLearner(id, { scores: scorePatch }, {
        week: meta.week,
        kind: 'writeback',
        title: meta.title,
        detail: meta.detail,
        deltas: evDeltas,
      });
    };

    const getEvents = (id: string): ProfileEvent[] => events[id] ?? [];

    return {
      learners: merged,
      currentLearnerId,
      setCurrentLearnerId,
      currentLearner,
      weakestKp: getKnowledgePoint(weakestKpOf(currentLearner)),
      strongestKp: getKnowledgePoint(strongestKpOf(currentLearner)),
      demoMode,
      setDemoMode,
      viewMode,
      setViewMode,
      createLearner,
      patchLearner,
      applyWriteback,
      getEvents,
    };
  }, [currentLearnerId, demoMode, viewMode, customLearners, overrides, events]);

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used within ProfileProvider');
  return ctx;
}

/** 取用于拉取富内容（报告/资源/导学静态数据）的 id */
export const dataIdOf = (l: Learner): string => l.dataBaseId ?? l.id;
