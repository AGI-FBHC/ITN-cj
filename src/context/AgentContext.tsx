/**
 * AgentContext — 伴学助手的运行时：信号总线 + 消息流 + 置信度 + 验证会话
 * 所有页面通过 pushSignal 上报学习行为；伴学助手推理后：写画像(applyWriteback) + 发消息 + 涨置信度。
 * 消息/置信度/信号日志按学习者分桶，localStorage 持久化。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { useProfile } from '@/context/ProfileContext';
import { api } from '@/lib/api';
import type { AgentDockSession } from '@/lib/api';
import { fetchChatAttachmentBlob } from '@/lib/presentationApi';
import { collectLearningPageContext, type LearningPageContext } from '@/lib/pageContext';
import { useLearningMap } from '@/hooks/useLearningMap';
import type { QuizQuestion } from '@/data/quizBank';
import {
  describeSignal,
  inferQuizBatch,
  inferLectureRead,
  inferGuideComplete,
  inferTutoringFinished,
  inferNoteTaken,

  verifyResult,
} from '@/agent/agentBrain';
import type { Signal, Inference } from '@/agent/agentBrain';

/* ================= 消息模型 ================= */
export type AgentMessage =
  | { id: string; kind: 'agent'; text: string; time: string }
  | { id: string; kind: 'user'; text: string; time: string; image?: { name: string; url: string }; attachmentId?: string }
  | { id: string; kind: 'stage'; text: string; time: string }
  | {
      id: string;
      kind: 'update';
      text: string;
      deltas: { kpId: string; from: number; to: number }[];
      time: string;
    }
  | { id: string; kind: 'evidence'; text: string; items: string[]; time: string }
  | { id: string; kind: 'note'; title: string; text: string; noteId: string; time: string }
  | {
      id: string;
      kind: 'quiz-card';
      stem: string;
      options: string[];
      answerIndex: number;
      analysis?: string;
      picked?: number | null;
      settled?: boolean;
      correct?: boolean;
      time: string;
    }
  | {
      id: string;
      kind: 'verify';
      kpId: string;
      questions: QuizQuestion[];
      picks: (number | null)[];
      settled: boolean;
      time: string;
    };

export type AskKind = 'why-blind' | 'what-next' | 'challenge-score';

/** 决策日志条目（系统透视：信号 → 推理 → 写入 全链路） */
export interface DecisionEntry {
  id: string;
  time: string;
  stage: 'signal' | 'inference' | 'writeback';
  text: string;
}

interface AgentContextValue {
  messages: AgentMessage[];
  unread: number;
  open: boolean;
  setOpen: (v: boolean) => void;
  /** 伴学助手正在生成回复/题目，应暂时禁用新的发送入口。 */
  isResponding: boolean;
  /** 最新一条未读的简短提示（FAB 气泡） */
  latestHint: string | null;
  /** 真实知识网络中最弱章节（用于快捷问题与 kp 参数） */
  weakest: { id: string; name: string; mastery: number } | null;
  /** 动态快捷问题（面板 chips，后台定时刷新） */
  suggestions: { id: string; text: string; askType: string }[];
  /** 发起一条建议问题 */
  askSuggestion: (text: string, askType: string) => void;
  confidence: Record<string, number>;
  /** 决策日志（评委透视用） */
  decisions: DecisionEntry[];
  pushSignal: (s: Signal) => void;
  ask: (kind: AskKind) => void;
  /** 自由提问：直接回答，页面位置仅作为不可见上下文传递。 */
  askFree: (text: string, pageContext?: LearningPageContext) => void;
  askFreeWithImage: (text: string, image: { name: string; url: string; blob?: Blob }, pageContext?: LearningPageContext) => void;
  askSimilarQuiz: (pageContext?: LearningPageContext) => void;
  answerQuizCard: (msgId: string, optIndex: number) => void;
  pageContextEnabled: boolean;
  setPageContextEnabled: (v: boolean) => void;
  answerVerify: (msgId: string, qIndex: number, optIndex: number) => void;
  sessions: AgentDockSession[];
  currentSessionId: string | null;
  createAgentSession: () => Promise<void>;
  switchAgentSession: (id: string) => Promise<void>;
  deleteAgentSession: (id: string) => Promise<void>;
  renameAgentSession: (id: string, title: string) => Promise<void>;
}

const AgentContext = createContext<AgentContextValue | null>(null);

const K_MSGS = 'lf.agentMsgs';
const K_CONF = 'lf.agentConf';
const K_LOG = 'lf.agentLog';
const K_SEEN = 'lf.agentSeen';
const K_DEC = 'lf.agentDecisions';
const K_SESSION_CTX = 'lf.agentSessionContexts';

interface SessionStageRecord {
  pageType: string;
  pageTitle: string;
  focusTitle?: string;
  route: string;
  askedAt: string;
}

function backendToAgentMessages(list: { id: string; agentId?: string | null; kind: string; content: string; createdAt: string }[]): AgentMessage[] {
  return (list ?? [])
    .filter((m) => m.content && (m.kind === 'user' || m.agentId === 'DIA-01'))
    .map((m) => {
      const attachmentMatch = m.kind === 'user' ? m.content.match(/\[图片:([0-9a-fA-F-]{36})\]/) : null;
      const text = attachmentMatch ? m.content.replace(/\[图片:[0-9a-fA-F-]{36}\]/, '').trim() : m.content;
      return {
        id: `agent-${m.id}`,
        kind: m.kind === 'user' ? 'user' as const : 'agent' as const,
        text,
        ...(attachmentMatch ? { attachmentId: attachmentMatch[1] } : {}),
        time: new Date(m.createdAt).toLocaleString(),
      };
    });
}

async function hydrateAgentImages(messages: AgentMessage[]): Promise<AgentMessage[]> {
  const result = [...messages];
  for (let i = 0; i < result.length; i += 1) {
    const message = result[i];
    if (message.kind !== 'user' || !message.attachmentId || message.image) continue;
    try {
      const blob = await fetchChatAttachmentBlob(message.attachmentId);
      result[i] = { ...message, image: { name: '图片', url: URL.createObjectURL(blob) } };
    } catch { /* 附件加载失败时保留纯文本 */ }
  }
  return result;
}

const DEFAULT_SESSION_TITLE_RE = /^(新对话|伴学助手|阿诊)\s*·?\s*(学习诊断)?$/;

function buildSessionTitle(text: string): string {
  const cleanText = text.replace(/^\s*\[当前页面[：:]\s*[^\]]+\]\s*/, '').replace(/\s+/g, ' ').trim();
  return cleanText.length > 12 ? `${cleanText.slice(0, 12)}…` : cleanText;
}

function buildCrossPageBridge(history: SessionStageRecord[], current: LearningPageContext): string | null {
  const currentFocus = current.focus?.title || current.pageTitle;
  const now = `${current.pageType} · ${currentFocus}`;
  const recent = history.slice(-4);
  const startStage = history.length - recent.length + 2;
  const stageLines = [
    '阶段1：新对话',
    ...recent.map((item, index) => `阶段${startStage + index}：${item.pageType} · ${item.focusTitle || item.pageTitle}`),
  ];
  const currentStage = history.length + 2;
  if (!history.length) {
    return `[跨会话上下文：阶段1：新对话；现在阶段${currentStage}：${now}。若需引用之前内容，请区分不同阶段；回答优先结合当前页面。]`;
  }
  const last = history[history.length - 1];
  if (last.pageType === current.pageType && last.focusTitle === currentFocus) return null;
  const stages = stageLines.join('；');
  return `[跨会话上下文：此前${stages}；现在阶段${currentStage}：${now}。若需引用之前内容，请区分不同阶段；回答优先结合当前页面。]`;
}

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
const save = (key: string, v: unknown) => {
  try { window.localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
};

let seq = 0;
const mid = () => `m-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
const GREETING = '你好，我是伴学助手。你可以直接问当前内容、概念、例题或学习安排，我会先回答你的问题。';
const clampConf = (n: number) => Math.max(10, Math.min(95, Math.round(n)));

export function AgentProvider({ children }: { children: ReactNode }) {
  const { currentLearner, currentLearnerId, applyWriteback, viewMode } = useProfile();
  const isExpert = viewMode === 'expert';

  const [msgsAll, setMsgsAll] = useState<Record<string, AgentMessage[]>>(() => readJSON(K_MSGS, {}));
  const [sessions, setSessions] = useState<AgentDockSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [isResponding, setIsResponding] = useState(false);
  const sessionSelectionLocked = useRef(false);
  const [pageContextEnabled, setPageContextEnabled] = useState(true);
  const [confAll, setConfAll] = useState<Record<string, Record<string, number>>>(() => readJSON(K_CONF, {}));
  const [logAll, setLogAll] = useState<Record<string, string[]>>(() => readJSON(K_LOG, {}));
  const [decAll, setDecAll] = useState<Record<string, DecisionEntry[]>>(() => readJSON(K_DEC, {}));
  const [seen, setSeen] = useState<string[]>(() => readJSON(K_SEEN, []));
  const [unread, setUnread] = useState(0);
  const [open, setOpenRaw] = useState(false);
  const [latestHint, setLatestHint] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<{ id: string; text: string; askType: string }[]>([]);

  /* 真实知识网络：最弱章节 / 知识点名称，替代旧静态知识库（数据结构·计算机网络等） */
  const learningMap = useLearningMap({ deferNetwork: true });
  const weakest = useMemo<{ id: string; name: string; mastery: number } | null>(() => {
    const domains = learningMap.domains ?? [];
    if (!domains.length) return null;
    const top = [...domains].sort((a, b) => (learningMap.mastery[a.id] ?? 0) - (learningMap.mastery[b.id] ?? 0))[0];
    return top ? { id: top.id, name: top.name, mastery: learningMap.mastery[top.id] ?? 0 } : null;
  }, [learningMap.domains, learningMap.mastery]);
  const kpNameById = useMemo(() => {
    const map = new Map<string, string>();
    (learningMap.domains ?? []).forEach((d) => map.set(d.id, d.name));
    (learningMap.graphNodes ?? []).forEach((n) => { if (n.label) map.set(n.id, n.label); });
    return map;
  }, [learningMap.domains, learningMap.graphNodes]);
  const resolveKpName = (id: string) => kpNameById.get(id) ?? id;

  /* 快捷问题建议：面板打开时后台异步定时刷新 */
  const refreshSuggestions = useCallback(() => {
    if (!currentLearnerId) return;
    void api.askAgentSuggestions(currentLearnerId, weakest?.id)
      .then(({ questions }) => {
        if (questions && questions.length) setSuggestions(questions);
      })
      .catch(() => undefined);
  }, [currentLearnerId, weakest?.id]);
  useEffect(() => {
    if (!open || isExpert) return undefined;
    refreshSuggestions();
    const id = window.setInterval(refreshSuggestions, 25000);
    return () => window.clearInterval(id);
  }, [open, isExpert, refreshSuggestions]);

  /* 测验缓冲（内存态，3 题一结算） */
  const quizBuf = useRef<Record<string, { n: number; right: number; hardRight: number }>>({});
  /* 模态切换计数（内存态，连续 3 次同模态 → 确认风格偏好） */
  const modeBuf = useRef<Record<string, number>>({});
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => save(K_MSGS, msgsAll), [msgsAll]);
  useEffect(() => save(K_CONF, confAll), [confAll]);
  useEffect(() => save(K_LOG, logAll), [logAll]);
  useEffect(() => save(K_DEC, decAll), [decAll]);
  useEffect(() => save(K_SEEN, seen), [seen]);

  /* 伴学助手会话管理：加载该学习者的 agent-dock 会话，默认选中最新一条并合并消息 */
  useEffect(() => {
    if (!currentLearnerId) return;
    let cancelled = false;
    void api.listAgentSessions().then(async ({ sessions: list }) => {
      if (cancelled) return;
      const mine = list.filter(
        (s) => (s.sessionType === 'agent-dock' || s.sessionType === 'agent')
          && s.learnerId === currentLearnerId
          && (s.messages?.length ?? 0) > 0,
      );
      setSessions(mine);
      if (!mine.length) return;
      if (sessionSelectionLocked.current) return;
      const latest = mine[0];
      setCurrentSessionId(latest.id);
      const remote: AgentMessage[] = backendToAgentMessages(latest.messages ?? []);
      if (!remote.length) return;
      const hydrated = await hydrateAgentImages(remote);
      if (cancelled) return;
      setMsgsAll((prev) => {
        const list = [...(prev[currentLearnerId] ?? [])];
        const ids = new Set(list.map((m) => m.id));
        const add = hydrated.filter((m) => !ids.has(m.id));
        return add.length ? { ...prev, [currentLearnerId]: [...list, ...add] } : prev;
      });
    }).catch(() => undefined);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLearnerId]);

  const value = useMemo<AgentContextValue>(() => {
    const lid = currentLearnerId;
    const messages = msgsAll[lid] ?? [];
    let lastSignal: Signal | null = null;
    const confidence: Record<string, number> = {};
    (learningMap.domains ?? []).forEach((kp) => {
      confidence[kp.id] = confAll[lid]?.[kp.id] ?? 40;
    });

    const append = (...ms: AgentMessage[]) => {
      setMsgsAll((prev) => ({ ...prev, [lid]: [...(prev[lid] ?? []), ...ms].slice(-60) }));
    };

    const notify = (hint: string) => {
      setUnread((u) => u + 1);
      setLatestHint(hint);
      if (hintTimer.current) clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setLatestHint(null), 5000);
    };

    const bumpConf = (kpId: string, d: number) => {
      setConfAll((prev) => ({
        ...prev,
        [lid]: { ...(prev[lid] ?? {}), [kpId]: clampConf((prev[lid]?.[kpId] ?? 40) + d) },
      }));
    };

    const record = (stage: DecisionEntry['stage'], text: string) => {
      setDecAll((prev) => ({
        ...prev,
        [lid]: [{ id: mid(), time: now(), stage, text }, ...(prev[lid] ?? [])].slice(0, 40),
      }));
    };

    const logSignal = (s: Signal) => {
      setLogAll((prev) => ({ ...prev, [lid]: [describeSignal(s), ...(prev[lid] ?? [])].slice(0, 30) }));
      record('signal', describeSignal(s));
    };

    /** 推断落地：写画像 + 发消息 + 置信度 */
    const commit = (kpId: string, inf: Inference) => {
      bumpConf(kpId, inf.confDelta);
      const kpName = resolveKpName(kpId);
      record(
        'inference',
        `规则命中 → 「${kpName}」Δ${inf.delta > 0 ? '+' : ''}${inf.delta} · 置信度 +${inf.confDelta}`,
      );
      if (inf.delta !== 0 && inf.eventTitle) {
        const from = Math.round(learningMap.mastery[kpId] ?? learningMap.topicMastery[kpId] ?? 50);
        const to = Math.max(12, Math.min(96, from + inf.delta));
        applyWriteback(lid, [{ kpId, delta: inf.delta }], {
          week: '本次',
          title: inf.eventTitle,
          detail: inf.eventDetail,
        });
        record('writeback', `写入画像 「${kpName}」${from}→${to} · 变更时间线 +1 · 通知 ARB-05 重排路径`);
        append({ id: mid(), kind: 'update', text: inf.say, deltas: [{ kpId, from, to }], time: now() });
        notify(`${kpName} ${inf.delta > 0 ? '+' : ''}${inf.delta}`);
        toast.success('伴学助手更新了你的画像', { description: `「${kpName}」${inf.delta > 0 ? '+' : ''}${inf.delta} 分` });
      } else {
        append({ id: mid(), kind: 'agent', text: inf.say, time: now() });
        notify('伴学助手有话说');
      }
      void deepDiagnose(kpId);
    };

    /** 深度诊断：真实学情 + MiMo 生成话术与证据（不重复写分，避免与规则双写） */
    const deepDiagnose = (kpId: string) => {
      const sig = lastSignal;
      if (!sig) return;
      void (async () => {
        try {
          const deep = await api.agentInfer(lid, sig as unknown as Record<string, unknown>, currentSessionId ?? undefined);
          const tail = deep.nextStep ? ` 下一步：${deep.nextStep}` : '';
          append({ id: mid(), kind: 'agent', text: `${deep.say}${tail}`, time: now() });
          record('inference', `DIA-01 深度诊断 → 「${resolveKpName(kpId)}」Δ${deep.delta} · 置信度 +${deep.confDelta} · 证据 ${deep.evidence.length} 条`);
        } catch { /* 接口不可用时保留规则反馈 */ }
      })();
    };

    const pushSignal = (s: Signal) => {
      lastSignal = s;
      /* 广播给激励体系（能量账本等订阅方），与推理解耦 */
      try {
        window.dispatchEvent(new CustomEvent('lf-signal', { detail: { signal: s, learnerId: lid } }));
      } catch { /* ignore */ }
      logSignal(s);
      if (s.type === 'quiz-answer') {
        const key = `${lid}:${s.kpId}`;
        const buf = (quizBuf.current[key] ??= { n: 0, right: 0, hardRight: 0 });
        buf.n += 1;
        if (s.correct) {
          buf.right += 1;
          if (s.level !== 'basic') buf.hardRight += 1;
        }
        bumpConf(s.kpId, 4);
        if (buf.n >= 3) {
          commit(s.kpId, inferQuizBatch(s.kpId, buf));
          quizBuf.current[key] = { n: 0, right: 0, hardRight: 0 };
        }
        return;
      }
      /* 记笔记：首条成句鼓励，后续静默涨置信度（不刷屏） */
      if (s.type === 'note-taken') {
        const firstKey = `${lid}:note-first:${s.kpId}`;
        record('inference', `笔记回流 → 「${resolveKpName(s.kpId)}」置信度 +4 · 我的笔记 +1`);
        if (!seen.includes(firstKey)) {
          setSeen((prev) => [...prev, firstKey].slice(-100));
          commit(s.kpId, inferNoteTaken(s.kpId));
        } else {
          bumpConf(s.kpId, 4);
        }
        return;
      }

      /* 段落签到：元认知弱信号，只动置信度不动分数 */
      if (s.type === 'self-report') {
        const kpName = resolveKpName(s.kpId);
        bumpConf(s.kpId, s.feel === 'ok' ? 3 : 2);
        record(
          'inference',
          `学习者签到自评「${kpName}」${s.feel === 'ok' ? '很稳' : '还虚'} → 置信度 +${s.feel === 'ok' ? 3 : 2}${s.feel === 'unsure' ? ' · 已通知 GEN-03 备变式讲法' : ''}`,
        );
        return;
      }
      /* 模态切换：连续 3 次同模态 = 行为验证了学习风格 */
      if (s.type === 'modality-switch') {
        if (s.mode === 'read') return;
        const key = `${lid}:modality:${s.mode}`;
        const cnt = (modeBuf.current[key] = (modeBuf.current[key] ?? 0) + 1);
        record('inference', `模态偏好信号 ×${cnt} → ${s.mode === 'cards' ? '图卡' : '听讲'}`);
        if (cnt >= 3 && !seen.includes(key)) {
          setSeen((prev) => [...prev, key].slice(-100));
          append({
            id: mid(),
            kind: 'agent',
            text: `我注意到你已经第 ${cnt} 次把讲解切成${s.mode === 'cards' ? '「图卡」' : '「听讲」'}模式——这不是巧合，是你的学习风格在说话。我把${s.mode === 'cards' ? '「图示学习」' : '「碎片化学习」'}记进画像了，之后 GEN-03 生成的内容会更偏这种形式。`,
            time: now(),
          });
          notify('学习风格已被行为验证');
        }
        return;
      }

      /* 一次性信号去重（同学习者同资源只结算一次） */
      const dupKey = `${lid}:${s.type}:${s.title}`;
      if (s.type !== 'tutoring-finished' && seen.includes(dupKey)) return;
      setSeen((prev) => [...prev, dupKey].slice(-100));

      if (s.type === 'lecture-read') commit(s.kpId, inferLectureRead(s.kpId, s.title));
      else if (s.type === 'guide-complete') commit(s.kpId, inferGuideComplete(s.kpId, s.title));
      else if (s.type === 'tutoring-finished')
        commit(s.kpId, inferTutoringFinished(s.kpId, s.title, s.asked, s.correct));
    };

    /** 会话管理：新建 / 切换 / 删除（agent-dock 会话） */
    const createAgentSession = async () => {
      const hasMessages = (msgsAll[lid] ?? []).length > 0;
      if (!hasMessages && currentSessionId === null) {
        toast.info('已经是新对话，无需重复创建');
        return;
      }
      setCurrentSessionId(null);
      setPageContextEnabled(false);
      sessionSelectionLocked.current = true;
      setMsgsAll((prev) => ({ ...prev, [lid]: [] }));
    };
    const switchAgentSession = async (id: string) => {
      if (id === currentSessionId) return;
      setCurrentSessionId(id);
      sessionSelectionLocked.current = true;
      try {
        const { messages: list } = await api.getAgentSessionMessages(id);
        const remote: AgentMessage[] = backendToAgentMessages(list ?? []);
        const hydrated = await hydrateAgentImages(remote);
        setMsgsAll((prev) => ({ ...prev, [lid]: hydrated }));
      } catch { /* 会话加载失败保持现状 */ }
    };
    const deleteAgentSession = async (id: string) => {
      await api.deleteAgentSession(id);
      const remaining = sessions.filter((s) => s.id !== id);
      setSessions(remaining);
      if (id === currentSessionId) {
        const next = remaining[0];
        setCurrentSessionId(next?.id ?? null);
        sessionSelectionLocked.current = true;
        setMsgsAll((prev) => ({ ...prev, [lid]: [] }));
        if (next) {
          try {
            const { messages: list } = await api.getAgentSessionMessages(next.id);
            const remote: AgentMessage[] = backendToAgentMessages(list ?? []);
            const hydrated = await hydrateAgentImages(remote);
            setMsgsAll((prev) => ({ ...prev, [lid]: hydrated }));
          } catch { /* ignore */ }
        }
      }
    };

    const renameAgentSession = async (id: string, title: string) => {
      const clean = title.trim();
      if (!clean) return;
      const updated = await api.updateAgentSession(id, { title: clean });
      setSessions((prev) => prev.map((session) => session.id === id ? updated : session));
    };

    /** 真实学情问答：调后端 /agent/ask（MiMo），占位消息替换为真实回复 */
    const agentAsk = async (askType: string, userText: string, placeholder: string, pageContext?: LearningPageContext) => {
      // Lazy session: create on first message, title from user text
      let sid = currentSessionId;
      let activeSession = sessions.find((session) => session.id === sid);
      if (!sid) {
        const created = await api.createAgentSession(lid);
        sid = created.id;
        activeSession = created;
        setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
        setCurrentSessionId(sid);
        sessionSelectionLocked.current = true;
        setMsgsAll((prev) => ({ ...prev, [lid]: [] }));
      }
      // Only the first real question names a new/default session. Later messages do not overwrite it.
      const hasDefaultTitle = !activeSession?.title || DEFAULT_SESSION_TITLE_RE.test(activeSession.title.trim());
      if (hasDefaultTitle && userText.length > 0) {
        const title = buildSessionTitle(userText);
        void api.updateAgentSession(sid, { title }).then((updated) => {
          setSessions((prev) => prev.map((s) => s.id === sid ? updated : s));
        }).catch(() => {/* ignore */});
      }
      const currentPage = pageContextEnabled ? (pageContext ?? collectLearningPageContext()) : undefined;
      let bridge: string | null = null;
      let sendText = userText;
      if (currentPage) {
        const ctxMap = readJSON<Record<string, SessionStageRecord[]>>(K_SESSION_CTX, {});
        const history = ctxMap[sid] ?? [];
        bridge = buildCrossPageBridge(history, currentPage);
        sendText = bridge ? `${bridge}\n${userText}` : userText;
        const stage: SessionStageRecord = {
          pageType: currentPage.pageType,
          pageTitle: currentPage.pageTitle,
          ...(currentPage.focus?.title ? { focusTitle: currentPage.focus.title } : {}),
          route: currentPage.route,
          askedAt: new Date().toISOString(),
        };
        ctxMap[sid] = [...history, stage].slice(-6);
        save(K_SESSION_CTX, ctxMap);
        if (bridge) {
          const recent = history.slice(-4);
          const startStage = history.length - recent.length + 2;
          const stageLines = [
            '阶段1：新对话',
            ...recent.map((item, index) => `阶段${startStage + index}：${item.pageType} · ${item.focusTitle || item.pageTitle}`),
          ];
          const currentStage = history.length + 2;
          const currentFocus = currentPage.focus?.title || currentPage.pageTitle;
          append({ id: mid(), kind: 'stage', text: `跨页面承接\n${stageLines.join('\n')}\n阶段${currentStage}：${currentPage.pageType} · ${currentFocus}`, time: now() });
        }
      }
      append({ id: mid(), kind: 'user', text: userText, time: now() });
      const pendingId = mid();
      append({ id: pendingId, kind: 'agent', text: placeholder, time: now() });
      setIsResponding(true);
      let acc = '';
      try {
        await api.askAgentStream(
          lid, askType, sendText,
          askType === 'free' ? undefined : weakest?.id,
          sid ?? undefined,
          currentPage?.route,
          currentPage,
          (event) => {
            if (event.type === 'reply_delta' && event.content) {
              acc += event.content;
              setMsgsAll((prev) => ({
                ...prev,
                [lid]: (prev[lid] ?? []).map((m) => (
                  m.id === pendingId ? { id: pendingId, kind: 'agent', text: acc, time: now() } : m
                )),
              }));
            } else if (event.type === 'note_saved') {
              window.dispatchEvent(new CustomEvent('itn:assistant-note-saved'));
              if (event.note) {
                append({
                  id: `note-${event.note.id}`, kind: 'note', noteId: event.note.id,
                  title: event.note.title, text: event.note.content, time: now(),
                });
              }
            }
          },
        );
      } catch {
        setMsgsAll((prev) => ({
          ...prev,
          [lid]: (prev[lid] ?? []).map((m) => (
            m.id === pendingId ? { id: pendingId, kind: 'agent', text: '网络开小差了，稍后再问我～', time: now() } : m
          )),
        }));
      } finally {
        setIsResponding(false);
      }
    };

    /** 图片提问：MiMo 先理解图片，再走伴学助手回复链路（SSE）。 */
    const agentAskImage = async (
      askType: string, userText: string,
      image: { name: string; url: string; blob?: Blob },
      placeholder: string, pageContext?: LearningPageContext,
    ) => {
      let sid = currentSessionId;
      let activeSession = sessions.find((session) => session.id === sid);
      if (!sid) {
        const created = await api.createAgentSession(lid);
        sid = created.id;
        activeSession = created;
        setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
        setCurrentSessionId(sid);
        sessionSelectionLocked.current = true;
        setMsgsAll((prev) => ({ ...prev, [lid]: [] }));
      }
      const hasDefaultTitle = !activeSession?.title || DEFAULT_SESSION_TITLE_RE.test(activeSession.title.trim());
      if (hasDefaultTitle) {
        const title = buildSessionTitle(userText || '图片提问');
        void api.updateAgentSession(sid, { title }).then((updated) => {
          setSessions((prev) => prev.map((s) => s.id === sid ? updated : s));
        }).catch(() => {/* ignore */});
      }
      const currentPage = pageContextEnabled ? (pageContext ?? collectLearningPageContext()) : undefined;
      append({ id: mid(), kind: 'user', text: userText, image: { name: image.name, url: image.url }, time: now() });
      const pendingId = mid();
      append({ id: pendingId, kind: 'agent', text: placeholder, time: now() });
      setIsResponding(true);
      let acc = '';
      try {
        const blob = image.blob ?? await (await fetch(image.url)).blob();
        await api.askAgentImageStream(
          lid, askType, userText, blob, sid ?? undefined,
          currentPage?.route, currentPage,
          (event) => {
            if (event.type === 'reply_delta' && event.content) {
              acc += event.content;
              setMsgsAll((prev) => ({
                ...prev,
                [lid]: (prev[lid] ?? []).map((m) => (
                  m.id === pendingId ? { id: pendingId, kind: 'agent', text: acc, time: now() } : m
                )),
              }));
            } else if (event.type === 'note_saved') {
              window.dispatchEvent(new CustomEvent('itn:assistant-note-saved'));
              if (event.note) {
                append({
                  id: `note-${event.note.id}`, kind: 'note', noteId: event.note.id,
                  title: event.note.title, text: event.note.content, time: now(),
                });
              }
            }
          },
        );
      } catch {
        setMsgsAll((prev) => ({
          ...prev,
          [lid]: (prev[lid] ?? []).map((m) => (
            m.id === pendingId ? { id: pendingId, kind: 'agent', text: '图片识别或网络开小差了，稍后再问我～', time: now() } : m
          )),
        }));
      } finally {
        setIsResponding(false);
      }
    };

    const ask = (kind: AskKind) => {
      const weakName = weakest?.name ?? '当前章节';
      const weakScore = Math.round(weakest?.mastery ?? 50);
      if (kind === 'why-blind') {
        void agentAsk('why-blind', `为什么说我的盲区是「${weakName}」？`, '正在对照你的画像、测验和近期信号分析盲区依据…');
      } else if (kind === 'what-next') {
        void agentAsk('what-next', '我下一步该学什么？', '正在结合画像与资源进度规划下一步…');
      } else {
        /* challenge-score：真实学情核验（后端生成回复，不再用本地题库 mock） */
        void agentAsk('challenge-score', `我觉得我的「${weakName}」不止 ${weakScore} 分，依据是什么？`, '正在核对你的画像与测验记录…');
      }
    };

    /** 自由输入始终按原问题回答；学情快捷问题由 askSuggestion 显式分流。 */
    const askFree = (raw: string, pageContext?: LearningPageContext) => {
      const text = raw.trim();
      if (!text) return;
      void agentAsk('free', text, '正在查阅当前内容并回答…', pageContext);
    };

    const askFreeWithImage = (raw: string, image: { name: string; url: string; blob?: Blob }, pageContext?: LearningPageContext) => {
      const text = raw.trim();
      if (!text && !image) return;
      void agentAskImage('free', text, image, '正在分析图片并回答…', pageContext);
    };

    /** 出一道类似题：后端生成结构化题目后渲染为可交互随堂练习。 */
    const askSimilarQuiz = async (pageContext?: LearningPageContext) => {
      if (!lid) return;
      let sid = currentSessionId;
      let activeSession = sessions.find((session) => session.id === sid);
      if (!sid) {
        const created = await api.createAgentSession(lid);
        sid = created.id;
        activeSession = created;
        setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
        setCurrentSessionId(sid);
        sessionSelectionLocked.current = true;
        setMsgsAll((prev) => ({ ...prev, [lid]: [] }));
      }
      const hasDefaultTitle = !activeSession?.title || DEFAULT_SESSION_TITLE_RE.test(activeSession.title.trim());
      if (hasDefaultTitle) {
        const title = buildSessionTitle('出一道类似的题');
        void api.updateAgentSession(sid, { title }).then((updated) => {
          setSessions((prev) => prev.map((s) => s.id === sid ? updated : s));
        }).catch(() => {/* ignore */});
      }
      const currentPage = pageContextEnabled ? (pageContext ?? collectLearningPageContext()) : undefined;
      const userText = '出一道与这道题思路相近的练习题，让我在对话里作答';
      append({ id: mid(), kind: 'user', text: userText, time: now() });
      const pendingId = mid();
      append({ id: pendingId, kind: 'agent', text: '正在生成随堂练习…', time: now() });
      setIsResponding(true);
      try {
        const result = await api.askAgentSimilarQuiz(
          lid, undefined, sid ?? undefined, currentPage?.route, currentPage,
        );
        const q = result?.question;
        if (!q || !q.stem || !Array.isArray(q.options) || q.options.length < 2) {
          throw new Error('invalid quiz payload');
        }
        setMsgsAll((prev) => ({
          ...prev,
          [lid]: (prev[lid] ?? []).map((m) => (
            m.id === pendingId
              ? {
                  id: pendingId,
                  kind: 'quiz-card',
                  stem: q.stem,
                  options: q.options.slice(0, 6),
                  answerIndex: q.answerIndex,
                  analysis: q.analysis,
                  settled: false,
                  picked: null,
                  correct: false,
                  time: now(),
                }
              : m
          )),
        }));
      } catch {
        setMsgsAll((prev) => ({
          ...prev,
          [lid]: (prev[lid] ?? []).map((m) => (
            m.id === pendingId ? { id: pendingId, kind: 'agent', text: '类似题生成失败，稍后再试一次吧', time: now() } : m
          )),
        }));
      } finally {
        setIsResponding(false);
      }
    };

    /** 作答做题卡片：本地即时判分，并把解析留在卡片内展示。 */
    const answerQuizCard = (msgId: string, optIndex: number) => {
      setMsgsAll((prev) => {
        const list = [...(prev[lid] ?? [])];
        const i = list.findIndex((m) => m.id === msgId && m.kind === 'quiz-card');
        if (i < 0) return prev;
        const m = list[i];
        if (m.kind !== 'quiz-card' || m.settled) return prev;
        const correct = optIndex === m.answerIndex;
        const updated = [...list];
        updated[i] = {
          ...m,
          picked: optIndex,
          settled: true,
          correct,
          time: now(),
        };
        return { ...prev, [lid]: updated.slice(-60) };
      });
    };

    /** 动态建议问题：按建议原文发起（类型已知则透传，未知按自由提问） */
    const askSuggestion = (text: string, askType: string) => {
      const text2 = text.trim();
      if (!text2) return;
      void agentAsk(askType === 'free' ? 'free' : askType, text2, '正在结合你的学情回答…');
      refreshSuggestions();
    };

    const answerVerify = (msgId: string, qIndex: number, optIndex: number) => {
      setMsgsAll((prev) => {
        const list = [...(prev[lid] ?? [])];
        const i = list.findIndex((m) => m.id === msgId);
        if (i < 0) return prev;
        const m = list[i];
        if (m.kind !== 'verify' || m.settled || m.picks[qIndex] !== null) return prev;
        const picks = [...m.picks];
        picks[qIndex] = optIndex;
        const done = picks.every((p) => p !== null);
        list[i] = { ...m, picks, settled: done };
        if (done) {
          const right = m.questions.filter((q, qi) => picks[qi] === q.answerIndex).length;
          const res = verifyResult(m.kpId, right);
          const from = Math.round(learningMap.mastery[m.kpId] ?? learningMap.topicMastery[m.kpId] ?? 50);
          record(
            'inference',
            `学习者质疑评估 → 验证测验 ${right}/${m.questions.length} → 「${resolveKpName(m.kpId)}」Δ+${res.delta}`,
          );
          if (res.delta > 0) {
            applyWriteback(lid, [{ kpId: m.kpId, delta: res.delta }], {
              week: '本次',
              title: res.eventTitle,
              detail: `学习者质疑评估 → DIA-01 验证测验 ${right}/${m.questions.length} → 协商上调`,
            });
            record(
              'writeback',
              `写入画像 「${resolveKpName(m.kpId)}」${from}→${Math.min(96, from + res.delta)} · 协商上调 · 变更时间线 +1`,
            );
            list.push({
              id: mid(),
              kind: 'update',
              text: res.say,
              deltas: [{ kpId: m.kpId, from, to: Math.min(96, from + res.delta) }],
              time: now(),
            });
            toast.success('协商成功', { description: `「${resolveKpName(m.kpId)}」+${res.delta} 分` });
          } else {
            list.push({ id: mid(), kind: 'agent', text: res.say, time: now() });
          }
        }
        return { ...prev, [lid]: list };
      });
      const vMsg = (msgsAll[lid] ?? []).find((item) => item.id === msgId && item.kind === 'verify');
      if (vMsg && vMsg.kind === 'verify') bumpConf(vMsg.kpId, 8);
    };

    const setOpen = (v: boolean) => {
      setOpenRaw(v);
      if (v) {
        setUnread(0);
        setLatestHint(null);
        if (isExpert) {
          if (messages.length === 0) append({ id: mid(), kind: 'agent', text: GREETING, time: now() });
          return;
        }
        /* 打开面板不再自动新建会话：保留当前会话，避免自动提问后跳到新会话。
           没有会话时等首次提问再懒创建。 */
        if (!currentSessionId && sessions.length > 0) {
          setCurrentSessionId(sessions[0].id);
          sessionSelectionLocked.current = true;
        }
        refreshSuggestions();
      }
    };


    return {
      weakest,
      suggestions,
      askSuggestion,
      messages,
      unread,
      open,
      setOpen,
      isResponding,
      latestHint,
      confidence,
      decisions: decAll[lid] ?? [],
      pushSignal,
      ask,
      askFree,
      askFreeWithImage,
      askSimilarQuiz,
      answerQuizCard,
      pageContextEnabled,
      setPageContextEnabled,
      answerVerify,
      sessions,
      currentSessionId,
      createAgentSession,
      switchAgentSession,
      deleteAgentSession,
      renameAgentSession,
    };
  }, [msgsAll, confAll, logAll, decAll, seen, unread, open, isResponding, latestHint, currentLearner, currentLearnerId, applyWriteback, weakest, kpNameById, learningMap, suggestions, refreshSuggestions, sessions, currentSessionId, pageContextEnabled]);

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgent must be used within AgentProvider');
  return ctx;
}
