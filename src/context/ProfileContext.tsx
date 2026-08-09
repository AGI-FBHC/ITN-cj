/**
 * ProfileContext — 全局学习者画像状态 + 视图模式 + 画像生命周期
 * 画像数据以后端 /api/v1/learners 为唯一数据源；本地只保存 UI 偏好与当前选中项。
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Learner } from '@/data/learners';
import { learners as presetLearners, getLearner, weakestKpOf, strongestKpOf } from '@/data/learners';
import type { KnowledgePoint } from '@/data/knowledgePoints';
import { knowledgePoints, getKnowledgePoint } from '@/data/knowledgePoints';
import { api } from '@/lib/api';
import type { LearnerProfileData, LearnerUpsertInput } from '@/lib/api';
import type { OnboardingKnowledgePoint } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';

export type ViewMode = 'learner' | 'expert';

export interface ProfileConfidence {
  method: 'quick' | 'full';
  value: number;
}

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
  /** 后端诊断摘要，未传时由后端建档接口按分数生成 */
  diagnosisSummary?: string;
}

/** 逐字段编辑覆盖 */
interface Override {
  scores?: Record<string, number>;
  goal?: string;
  blindSpots?: string[];
}

interface ProfileContextValue {
  /** 生效画像列表（后端 learners + 本地预设展示元数据） */
  learners: Learner[];
  /** 后端画像知识维度（数据结构/组成原理/操作系统/网络/数据库/智能体） */
  domainKnowledgePoints: OnboardingKnowledgePoint[];
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
  createLearner: (draft: LearnerDraft, confidence: ProfileConfidence) => Promise<string>;
  patchLearner: (id: string, patch: Override, event?: Omit<ProfileEvent, 'id'>) => Promise<Learner>;
  applyWriteback: (
    id: string,
    deltas: { kpId: string; delta: number }[],
    meta: { week: string; title: string; detail?: string },
  ) => void;
  bumpConfidence: (id: string, delta?: number) => Promise<void>;
  getEvents: (id: string) => ProfileEvent[];
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

const K_VIEW = 'lf.viewMode';
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

const NEW_KP_NAMES: Record<string, string> = {
  'kp-ds': '数据结构与算法',
  'kp-co': '计算机组成原理',
  'kp-os': '操作系统',
  'kp-network': '计算机网络',
  'kp-db': '数据库',
  'kp-agent': '智能体与大模型',
};

const LEGACY_SCORE_IDS: Record<string, string> = {
  'kp-ds': 'kp-plc',
  'kp-co': 'kp-kinematics',
  'kp-os': 'kp-sensor',
  'kp-network': 'kp-vision',
  'kp-db': 'kp-safety',
  'kp-agent': 'kp-diagnosis',
};

function kpName(id: string): string {
  return NEW_KP_NAMES[id] ?? getKnowledgePoint(id).name ?? id;
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

function tagFromRole(role?: string | null, education?: string | null): string {
  const roleTag = role?.split('·').pop()?.trim();
  if (roleTag && roleTag !== '精简建档') return roleTag;
  const eduTag = education?.split('·')[0]?.trim();
  return eduTag || '自建画像';
}

function diagnosisFromScores(scores: Record<string, number>): string {
  const entries = Object.entries(scores);
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);
  const strongest = kpName(sorted[0]?.[0] ?? 'kp-ds');
  const weakest = kpName(sorted[sorted.length - 1]?.[0] ?? 'kp-ds');
  const strongScore = sorted[0]?.[1] ?? 50;
  const weakScore = sorted[sorted.length - 1]?.[1] ?? 50;
  return `DIA-01 诊断：最强「${strongest}」${strongScore} 分，最弱「${weakest}」${weakScore} 分。建议从「${weakest}」切入，用分阶题巩固优势维度。`;
}

function confidenceOf(remote: LearnerProfileData): ProfileConfidence | undefined {
  if (remote.confidenceMethod && remote.confidenceValue != null) {
    return { method: remote.confidenceMethod, value: remote.confidenceValue };
  }
  return undefined;
}

function toUiLearner(remote: LearnerProfileData): Learner {
  const preset = presetLearners.find((p) => p.id === remote.code || p.id === remote.id);
  const scores = { ...(remote.scores ?? {}) };
  for (const [currentId, legacyId] of Object.entries(LEGACY_SCORE_IDS)) {
    if (scores[currentId] == null && scores[legacyId] != null) scores[currentId] = scores[legacyId];
  }
  if (Object.keys(scores).length === 0) {
    for (const kpId of Object.keys(NEW_KP_NAMES)) scores[kpId] = 50;
  }
  const entries = Object.entries(scores);
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);
  const strongest = kpName(sorted[0]?.[0] ?? 'kp-ds');
  const weakest = kpName(sorted[sorted.length - 1]?.[0] ?? 'kp-ds');

  if (preset) {
    return {
      ...preset,
      id: remote.id,
      code: remote.code ?? preset.code,
      name: remote.name || preset.name,
      avatar: remote.avatar || preset.avatar,
      role: remote.role || preset.role,
      education: remote.education || preset.education,
      targetJob: remote.targetJob || preset.targetJob,
      weeklyHours: remote.weeklyHours ?? preset.weeklyHours,
      learningStyle: remote.learningStyle?.length ? remote.learningStyle : preset.learningStyle,
      scores,
      goal: remote.goal || preset.goal,
      blindSpots: remote.blindSpots?.length ? remote.blindSpots : preset.blindSpots,
      preferredFormat: remote.preferredFormat || preset.preferredFormat,
      diagnosisSummary: remote.diagnosisSummary || preset.diagnosisSummary,
      confidence: confidenceOf(remote),
    };
  }

  const tag = tagFromRole(remote.role, remote.education);
  return {
    id: remote.id,
    code: remote.code ?? undefined,
    custom: true,
    dataBaseId: nearestPresetId(scores),
    name: remote.name || '我',
    avatar: remote.avatar || '/avatar-lin.png',
    age: 0,
    tag,
    role: remote.role || remote.targetJob || tag,
    education: remote.education || '',
    school: '—',
    background: `自建画像 · ${remote.learningStyle?.join(' / ') || '综合型'}。理论自测最强「${strongest}」，最弱「${weakest}」。`,
    targetJob: remote.targetJob || '',
    learningStyle: remote.learningStyle?.length ? remote.learningStyle : ['综合'],
    weeklyHours: remote.weeklyHours ?? 8,
    scores,
    strengths: sorted.slice(0, 2).map(([kp]) => kpName(kp)),
    blindSpots: remote.blindSpots?.length ? remote.blindSpots : [],
    preferredFormat: remote.preferredFormat || '按画像自适应',
    goal: remote.goal || '',
    diagnosisSummary: remote.diagnosisSummary || diagnosisFromScores(scores),
    confidence: confidenceOf(remote),
  };
}

function toUpsertInput(learner: Learner, patch?: Override): LearnerUpsertInput {
  return {
    code: learner.code ?? null,
    name: learner.name,
    avatar: learner.avatar,
    role: learner.role,
    education: learner.education,
    targetJob: learner.targetJob,
    weeklyHours: learner.weeklyHours,
    learningStyle: learner.learningStyle,
    scores: patch?.scores ? { ...learner.scores, ...patch.scores } : learner.scores,
    goal: patch?.goal ?? learner.goal,
    blindSpots: patch?.blindSpots ?? learner.blindSpots,
    preferredFormat: learner.preferredFormat,
    diagnosisSummary: learner.diagnosisSummary,
    confidenceMethod: learner.confidence?.method ?? null,
    confidenceValue: learner.confidence?.value ?? null,
  };
}

function draftToUpsert(draft: LearnerDraft, confidence: ProfileConfidence): LearnerUpsertInput {
  return {
    code: `learner-${Date.now().toString(36)}`,
    name: draft.name,
    avatar: draft.avatar,
    role: draft.role,
    education: draft.education,
    targetJob: draft.targetJob,
    weeklyHours: draft.weeklyHours,
    learningStyle: draft.learningStyle,
    scores: draft.scores,
    goal: draft.goal,
    blindSpots: draft.blindSpots,
    preferredFormat: '按画像自适应',
    diagnosisSummary: draft.diagnosisSummary || diagnosisFromScores(draft.scores),
    confidenceMethod: confidence.method,
    confidenceValue: confidence.value,
  };
}

let eventSeq = 0;
const newEventId = () => `ev-${Date.now().toString(36)}-${(eventSeq++).toString(36)}`;

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [currentLearnerId, setCurrentLearnerId] = useState<string>(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(K_CURRENT) : null;
    // Backend learner ids are UUIDs and must survive a full-page reload. Validation
    // happens after the authenticated learner list arrives.
    if (stored) return stored;
    return presetLearners[0].id;
  });
  const [demoMode, setDemoMode] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<ViewMode>(readInitialMode);
  const [learners, setLearners] = useState<Learner[]>(() => presetLearners);
  const [events, setEvents] = useState<Record<string, ProfileEvent[]>>(() =>
    readJSON<Record<string, ProfileEvent[]>>(K_EVENTS, {}),
  );
  const [domainKnowledgePoints, setDomainKnowledgePoints] = useState<OnboardingKnowledgePoint[]>([]);

  useEffect(() => {
    if (!session) {
      setLearners(presetLearners);
      return;
    }
    let cancelled = false;
    api.listLearners()
      .then((list) => {
        if (cancelled) return;
        const mapped = list.map(toUiLearner);
        setLearners(mapped.length ? mapped : presetLearners);
        const stored = window.localStorage.getItem(K_CURRENT);
        const target = [stored, session.learnerId]
          .map((id) => id && (mapped.length ? mapped : presetLearners).some((l) => l.id === id) ? id : null)
          .find(Boolean);
        if (target) setCurrentLearnerId(target);
      })
      .catch(() => {
        if (!cancelled) setLearners(presetLearners);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (!session) {
      setDomainKnowledgePoints([]);
      return;
    }
    let cancelled = false;
    api.getOnboardingMeta()
      .then((meta) => {
        if (!cancelled) setDomainKnowledgePoints(meta.knowledgePoints);
      })
      .catch(() => {
        if (!cancelled) setDomainKnowledgePoints([]);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    try {
      window.localStorage.setItem(K_VIEW, viewMode);
    } catch { /* ignore */ }
  }, [viewMode]);
  useEffect(() => {
    try { window.localStorage.setItem(K_CURRENT, currentLearnerId); } catch { /* ignore */ }
  }, [currentLearnerId]);
  useEffect(() => {
    try { window.localStorage.setItem(K_EVENTS, JSON.stringify(events)); } catch { /* ignore */ }
  }, [events]);

  const value = useMemo<ProfileContextValue>(() => {
    const byId = (id: string) => learners.find((l) => l.id === id);
    const currentLearner = byId(currentLearnerId) ?? learners[0] ?? presetLearners[0];

    const addEvent = (id: string, event: Omit<ProfileEvent, 'id'>) => {
      setEvents((prev) => ({ ...prev, [id]: [{ id: newEventId(), ...event }, ...(prev[id] ?? [])] }));
    };

    const createLearner = async (draft: LearnerDraft, confidence: ProfileConfidence): Promise<string> => {
      const remote = await api.createLearner(draftToUpsert(draft, confidence));
      const learner = toUiLearner(remote);
      setLearners((prev) => [...prev.filter((l) => l.id !== learner.id), learner]);
      setCurrentLearnerId(learner.id);
      addEvent(learner.id, {
        week: '建档',
        kind: 'create',
        title: '画像建档完成',
        detail: `由 DIA-01 诊断向导生成 · 借用「${getLearner(learner.dataBaseId ?? 'lin').name}」的领域资源基线`,
      });
      return learner.id;
    };

    const patchLearner = async (id: string, patch: Override, event?: Omit<ProfileEvent, 'id'>): Promise<Learner> => {
      const base = byId(id);
      if (!base) throw new Error('当前画像不存在或尚未加载完成');
      const next = {
        ...base,
        scores: patch.scores ? { ...base.scores, ...patch.scores } : base.scores,
        goal: patch.goal ?? base.goal,
        blindSpots: patch.blindSpots ?? base.blindSpots,
      };
      const remote = await api.updateLearner(id, toUpsertInput(next));
      const updated = toUiLearner(remote);
      setLearners((prev) => prev.map((l) => (l.id === id ? updated : l)));
      if (event) addEvent(id, event);
      return updated;
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
      void patchLearner(id, { scores: scorePatch }, {
        week: meta.week,
        kind: 'writeback',
        title: meta.title,
        detail: meta.detail,
        deltas: evDeltas,
      });
    };

    const bumpConfidence = async (id: string, delta = 3): Promise<void> => {
      const base = byId(id);
      if (!base?.confidence || base.confidence.value >= 90) return;
      const next = {
        ...base,
        confidence: { ...base.confidence, value: Math.min(90, base.confidence.value + delta) },
      };
      try {
        const remote = await api.updateLearner(id, toUpsertInput(next));
        const updated = toUiLearner(remote);
        setLearners((prev) => prev.map((l) => (l.id === id ? updated : l)));
      } catch {
        /* 忽略，下轮学习行为继续尝试 */
      }
    };

    const getEvents = (id: string): ProfileEvent[] => events[id] ?? [];

    return {
      learners,
      currentLearnerId,
      setCurrentLearnerId,
      currentLearner,
      weakestKp: getKnowledgePoint(weakestKpOf(currentLearner)),
      strongestKp: getKnowledgePoint(strongestKpOf(currentLearner)),
      domainKnowledgePoints,
      demoMode,
      setDemoMode,
      viewMode,
      setViewMode,
      createLearner,
      patchLearner,
      applyWriteback,
      bumpConfidence,
      getEvents,
    };
  }, [currentLearnerId, demoMode, viewMode, learners, events, domainKnowledgePoints]);

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used within ProfileProvider');
  return ctx;
}

/** 取用于拉取富内容（报告/资源/导学静态数据）的 id */
export const dataIdOf = (l: Learner): string => l.dataBaseId ?? l.id;
