/**
 * AgentContext — 「阿诊」(DIA-01) 的运行时：信号总线 + 消息流 + 置信度 + 验证会话
 * 所有页面通过 pushSignal 上报学习行为；阿诊推理后：写画像(applyWriteback) + 发消息 + 涨置信度。
 * 消息/置信度/信号日志按学习者分桶，localStorage 持久化。
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { useProfile } from '@/context/ProfileContext';
import { knowledgePoints, getKnowledgePoint } from '@/data/knowledgePoints';
import type { QuizQuestion } from '@/data/quizBank';
import {
  describeSignal,
  inferQuizBatch,
  inferLectureRead,
  inferGuideComplete,
  inferTutoringFinished,
  inferNoteTaken,
  pickVerifyQuestions,
  verifyResult,
} from '@/agent/agentBrain';
import type { Signal, Inference } from '@/agent/agentBrain';

/* ================= 消息模型 ================= */
export type AgentMessage =
  | { id: string; kind: 'agent'; text: string; time: string }
  | { id: string; kind: 'user'; text: string; time: string }
  | {
      id: string;
      kind: 'update';
      text: string;
      deltas: { kpId: string; from: number; to: number }[];
      time: string;
    }
  | { id: string; kind: 'evidence'; text: string; items: string[]; time: string }
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
  /** 最新一条未读的简短提示（FAB 气泡） */
  latestHint: string | null;
  confidence: Record<string, number>;
  /** 决策日志（评委透视用） */
  decisions: DecisionEntry[];
  pushSignal: (s: Signal) => void;
  ask: (kind: AskKind) => void;
  answerVerify: (msgId: string, qIndex: number, optIndex: number) => void;
}

const AgentContext = createContext<AgentContextValue | null>(null);

const K_MSGS = 'lf.agentMsgs';
const K_CONF = 'lf.agentConf';
const K_LOG = 'lf.agentLog';
const K_SEEN = 'lf.agentSeen';
const K_DEC = 'lf.agentDecisions';

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
const clampConf = (n: number) => Math.max(10, Math.min(95, Math.round(n)));

export function AgentProvider({ children }: { children: ReactNode }) {
  const { currentLearner, currentLearnerId, applyWriteback, weakestKp } = useProfile();

  const [msgsAll, setMsgsAll] = useState<Record<string, AgentMessage[]>>(() => readJSON(K_MSGS, {}));
  const [confAll, setConfAll] = useState<Record<string, Record<string, number>>>(() => readJSON(K_CONF, {}));
  const [logAll, setLogAll] = useState<Record<string, string[]>>(() => readJSON(K_LOG, {}));
  const [decAll, setDecAll] = useState<Record<string, DecisionEntry[]>>(() => readJSON(K_DEC, {}));
  const [seen, setSeen] = useState<string[]>(() => readJSON(K_SEEN, []));
  const [unread, setUnread] = useState(0);
  const [open, setOpenRaw] = useState(false);
  const [latestHint, setLatestHint] = useState<string | null>(null);

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

  const value = useMemo<AgentContextValue>(() => {
    const lid = currentLearnerId;
    const messages = msgsAll[lid] ?? [];
    const confidence: Record<string, number> = {};
    knowledgePoints.forEach((kp) => {
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
      const kpName = getKnowledgePoint(kpId).name;
      record(
        'inference',
        `规则命中 → 「${kpName}」Δ${inf.delta > 0 ? '+' : ''}${inf.delta} · 置信度 +${inf.confDelta}`,
      );
      if (inf.delta !== 0 && inf.eventTitle) {
        const from = currentLearner.scores[kpId] ?? 50;
        const to = Math.max(12, Math.min(96, from + inf.delta));
        applyWriteback(lid, [{ kpId, delta: inf.delta }], {
          week: '本次',
          title: inf.eventTitle,
          detail: inf.eventDetail,
        });
        record('writeback', `写入画像 「${kpName}」${from}→${to} · 变更时间线 +1 · 通知 ARB-05 重排路径`);
        append({ id: mid(), kind: 'update', text: inf.say, deltas: [{ kpId, from, to }], time: now() });
        notify(`${kpName} ${inf.delta > 0 ? '+' : ''}${inf.delta}`);
        toast.success('阿诊更新了你的画像', { description: `「${kpName}」${inf.delta > 0 ? '+' : ''}${inf.delta} 分` });
      } else {
        append({ id: mid(), kind: 'agent', text: inf.say, time: now() });
        notify('阿诊有话说');
      }
    };

    const pushSignal = (s: Signal) => {
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
        record('inference', `笔记回流 → 「${getKnowledgePoint(s.kpId).name}」置信度 +4 · 个人知识库 +1`);
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
        const kpName = getKnowledgePoint(s.kpId).name;
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

    const ask = (kind: AskKind) => {
      const weakName = weakestKp.name;
      if (kind === 'why-blind') {
        append({ id: mid(), kind: 'user', text: `为什么说我的盲区是「${weakName}」？`, time: now() });
        const score = currentLearner.scores[weakestKp.id] ?? 50;
        const conf = confidence[weakestKp.id];
        const sigs = (logAll[lid] ?? []).filter((t) => t.includes(weakName)).slice(0, 3);
        const items = [
          `理论测试「${weakName}」当前 ${score} 分，岗位目标 ${weakestKp.targetLevel} 分，缺口 ${Math.max(0, weakestKp.targetLevel - score)} 分（六维中最大）`,
          ...sigs.map((t) => `近期信号：${t}`),
          `我对这一维判断的置信度 ${conf}%${conf < 55 ? '（还偏低——多做两组题能让我更确定）' : ''}`,
        ];
        append({
          id: mid(),
          kind: 'evidence',
          text: `不是拍脑袋——证据在这里：`,
          items,
          time: now(),
        });
      } else if (kind === 'what-next') {
        append({ id: mid(), kind: 'user', text: '我下一步该学什么？', time: now() });
        append({
          id: mid(),
          kind: 'agent',
          text: `按当前画像，收益最高的是先攻「${weakName}」：它离岗位目标最远，而且你最近的信号显示基础在松动。我已经让 GEN-03 按你的水平备好了讲义和分阶题——从「学」页进去就是。练完我会当场更新你的画像。`,
          time: now(),
        });
      } else {
        /* challenge-score：讨价还价 → 验证测验 */
        append({ id: mid(), kind: 'user', text: `我觉得我的「${weakName}」不止 ${currentLearner.scores[weakestKp.id] ?? 50} 分`, time: now() });
        const qs = pickVerifyQuestions(weakestKp.id);
        append(
          {
            id: mid(),
            kind: 'agent',
            text: `有可能——我的记录也只是估计。这样：我出 ${qs.length} 道「${weakName}」的题当场验证，全对我就上调，敢不敢？`,
            time: now(),
          },
          { id: mid(), kind: 'verify', kpId: weakestKp.id, questions: qs, picks: qs.map(() => null), settled: false, time: now() },
        );
      }
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
          const from = currentLearner.scores[m.kpId] ?? 50;
          record(
            'inference',
            `学习者质疑评估 → 验证测验 ${right}/${m.questions.length} → 「${getKnowledgePoint(m.kpId).name}」Δ+${res.delta}`,
          );
          if (res.delta > 0) {
            applyWriteback(lid, [{ kpId: m.kpId, delta: res.delta }], {
              week: '本次',
              title: res.eventTitle,
              detail: `学习者质疑评估 → DIA-01 验证测验 ${right}/${m.questions.length} → 协商上调`,
            });
            record(
              'writeback',
              `写入画像 「${getKnowledgePoint(m.kpId).name}」${from}→${Math.min(96, from + res.delta)} · 协商上调 · 变更时间线 +1`,
            );
            list.push({
              id: mid(),
              kind: 'update',
              text: res.say,
              deltas: [{ kpId: m.kpId, from, to: Math.min(96, from + res.delta) }],
              time: now(),
            });
            toast.success('协商成功', { description: `「${getKnowledgePoint(m.kpId).name}」+${res.delta} 分` });
          } else {
            list.push({ id: mid(), kind: 'agent', text: res.say, time: now() });
          }
        }
        return { ...prev, [lid]: list };
      });
      bumpConf(currentLearnerId ? weakestKp.id : weakestKp.id, 8);
    };

    const setOpen = (v: boolean) => {
      setOpenRaw(v);
      if (v) {
        setUnread(0);
        setLatestHint(null);
        if (messages.length === 0) {
          append({
            id: mid(),
            kind: 'agent',
            text: `你好，我是阿诊（DIA-01 学情诊断 Agent）。我会一直看着你的答题、阅读和实操记录，随时更新你的画像——每一次调整都有证据，你也可以随时质疑我。`,
            time: now(),
          });
        }
      }
    };

    return {
      messages,
      unread,
      open,
      setOpen,
      latestHint,
      confidence,
      decisions: decAll[lid] ?? [],
      pushSignal,
      ask,
      answerVerify,
    };
  }, [msgsAll, confAll, logAll, decAll, seen, unread, open, latestHint, currentLearner, currentLearnerId, applyWriteback, weakestKp]);

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgent must be used within AgentProvider');
  return ctx;
}
