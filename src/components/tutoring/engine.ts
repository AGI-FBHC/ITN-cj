/**
 * useTutoringEngine — 导学对话脚本运行时
 * 脚本图（tutoringScript.ts）解释执行：typing → 流式导师气泡 → 快答分支 →
 * 决策仲裁（ARB-05 loading → 横幅）→ 课后小结
 * 答题正确率本地实时累计，供决策横幅与右栏仪表使用
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { BackstageNote, DecisionType, TutorOption, TutorStage, TutoringScript } from '@/data/tutoringScript';
import type { Learner } from '@/data/learners';
import { getKnowledgePoint } from '@/data/knowledgePoints';

export type Msg =
  | { kind: 'tutor'; id: string; nodeId?: string; stage?: TutorStage; text: string; kbRefs?: string[] }
  | { kind: 'learner'; id: string; text: string }
  | { kind: 'backstage'; id: string; notes: BackstageNote[] }
  | { kind: 'arbitrate'; id: string }
  | { kind: 'decision'; id: string; type: DecisionType; reason: string; accuracy: number; asked: number }
  | { kind: 'summary'; id: string }
  | { kind: 'feedback'; id: string; verdict: 'correct' | 'wrong'; text: string };

export interface DecisionEvent {
  id: string;
  type: DecisionType;
  label: string;
  reason: string;
  time: string;
  confidence: number;
}

const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

/** 答题反馈文案池（温和治愈系，不批判） */
const correctFeedback = [
  '答对了，这一步的因果链你已经抓住了。',
  '没错，思路很清楚，照这个节奏往下走。',
  '对，这一步稳稳拿下，继续保持。',
];
const wrongFeedback = [
  '先别急，换个角度再想想 —— 看看老师接下来的提示。',
  '这一步还没到，别担心，跟着提示再捋一遍。',
  '差一点点，别慌，老师换个说法带你重新过一遍。',
];
const pickFeedback = (correct: boolean) => {
  const pool = correct ? correctFeedback : wrongFeedback;
  return pool[Math.floor(Math.random() * pool.length)];
};

export function useTutoringEngine(script: TutoringScript, learner: Learner) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [awaitingNodeId, setAwaitingNodeId] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [answers, setAnswers] = useState<boolean[]>([]);
  const [decisions, setDecisions] = useState<DecisionEvent[]>([]);
  const [level, setLevel] = useState(2);
  const [finished, setFinished] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const sessionRef = useRef(0);
  const idRef = useRef(0);
  const answersRef = useRef<boolean[]>([]);
  const awaitingRef = useRef<string | null>(null);
  const streamResolvers = useRef(new Map<string, () => void>());

  /* refs 与 state 同步（effect 中写入，避免渲染期访问 ref） */
  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);
  useEffect(() => {
    awaitingRef.current = awaitingNodeId;
  }, [awaitingNodeId]);

  const nid = () => `m${++idRef.current}`;
  const alive = (s: number) => s === sessionRef.current;
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const accuracyNow = () => {
    const a = answersRef.current;
    if (!a.length) return { acc: 0, asked: 0 };
    return { acc: Math.round((a.filter(Boolean).length / a.length) * 100), asked: a.length };
  };

  /** 气泡流式打字完成回调（由 TutorBubble 触发） */
  const notifyStreamDone = useCallback((id: string) => {
    streamResolvers.current.get(id)?.();
    streamResolvers.current.delete(id);
  }, []);

  const waitStream = (id: string) =>
    new Promise<void>((res) => {
      streamResolvers.current.set(id, res);
    });

  const enterNode = useCallback(
    async (nodeId: string, session: number) => {
      const node = script.nodes[nodeId];
      if (!node) return;

      /* 幕后协商卡 */
      if (node.backstage?.length) {
        setMsgs((m) => [...m, { kind: 'backstage', id: nid(), notes: node.backstage! }]);
        await delay(380);
        if (!alive(session)) return;
      }

      /* typing → 流式导师气泡 */
      setTyping(true);
      await delay(520 + Math.random() * 320);
      if (!alive(session)) return;
      setTyping(false);
      setStreaming(true);
      const tMsgId = nid();
      setMsgs((m) => [
        ...m,
        { kind: 'tutor', id: tMsgId, nodeId: node.id, stage: node.stage, text: node.tutor, kbRefs: node.kbRefs },
      ]);
      await waitStream(tMsgId);
      if (!alive(session)) return;
      setStreaming(false);

      /* 决策仲裁：ARB-05 loading 行 → 横幅 + 历史 */
      if (node.decision) {
        const arbId = nid();
        setMsgs((m) => [...m, { kind: 'arbitrate', id: arbId }]);
        await delay(900);
        if (!alive(session)) return;
        setMsgs((m) => m.filter((x) => x.id !== arbId));
        const { acc, asked } = accuracyNow();
        const ev: DecisionEvent = {
          id: nid(),
          type: node.decision,
          label: node.decision === 'challenge' ? '进阶挑战' : '降维解释',
          reason: node.decisionReason ?? '',
          time: now(),
          confidence: node.decision === 'challenge' ? 0.95 : 0.92,
        };
        setDecisions((d) => [ev, ...d]);
        setMsgs((m) => [
          ...m,
          { kind: 'decision', id: ev.id, type: ev.type, reason: ev.reason, accuracy: acc, asked },
        ]);
        setLevel((l) => (node.decision === 'challenge' ? Math.min(5, l + 1) : Math.max(1, l - 1)));
        await delay(420);
        if (!alive(session)) return;
      }

      if (node.end) {
        setFinished(true);
        await delay(600);
        if (!alive(session)) return;
        setMsgs((m) => [...m, { kind: 'summary', id: nid() }]);
        const kp = getKnowledgePoint(script.kpId);
        const score = learner.scores[script.kpId] ?? 50;
        toast.success(`画像已更新：${kp.name} ${score} → ${score + 6}`, {
          description: '你的学习记录已更新',
        });
        return;
      }
      setAwaitingNodeId(node.id);
    },
    [script, learner],
  );

  const start = useCallback(() => {
    sessionRef.current += 1;
    const session = sessionRef.current;
    idRef.current = 0;
    streamResolvers.current.clear();
    setMsgs([]);
    setAwaitingNodeId(null);
    setTyping(false);
    setStreaming(false);
    setAnswers([]);
    setDecisions([]);
    setLevel(2);
    setFinished(false);
    setAccepted(false);
    void enterNode(script.startId, session);
  }, [enterNode, script.startId]);

  /* 开局 / 切换画像（脚本变化）时重置（defer 一帧，避免 effect 体内同步 setState） */
  useEffect(() => {
    const t = setTimeout(start, 0);
    return () => {
      clearTimeout(t);
      sessionRef.current += 1;
    };
  }, [start]);

  /** 快答 chip 作答 */
  const sendOption = useCallback(
    (option: TutorOption) => {
      const nodeId = awaitingRef.current;
      if (!nodeId) return;
      awaitingRef.current = null;
      setAwaitingNodeId(null);
      const session = sessionRef.current;
      setMsgs((m) => [...m, { kind: 'learner', id: nid(), text: option.label }]);
      /* 「明白了，继续」这类推进选项 correct 为 undefined，不算答题、不触发反馈 */
      if (option.correct !== undefined) {
        const isCorrect = option.correct === true;
        setAnswers((a) => [...a, isCorrect]);
        setMsgs((m) => [
          ...m,
          { kind: 'feedback', id: nid(), verdict: isCorrect ? 'correct' : 'wrong', text: pickFeedback(isCorrect) },
        ]);
      }
      void enterNode(option.next, session);
    },
    [enterNode],
  );

  /** 自由输入：沿当前节点的正确（或首个）分支推进 */
  const sendFreeText = useCallback(
    (text: string) => {
      const nodeId = awaitingRef.current;
      const trimmed = text.trim();
      if (!nodeId || !trimmed) return;
      const node = script.nodes[nodeId];
      const target = node?.options?.find((o) => o.correct) ?? node?.options?.[0];
      awaitingRef.current = null;
      setAwaitingNodeId(null);
      setMsgs((m) => [...m, { kind: 'learner', id: nid(), text: trimmed }]);
      if (!target) return;
      void enterNode(target.next, sessionRef.current);
    },
    [enterNode, script.nodes],
  );

  /** 接受进阶挑战：导师下发任务详情 */
  const acceptChallenge = useCallback(
    (taskText: string, kbRef?: string) => {
      if (accepted) return;
      setAccepted(true);
      const session = sessionRef.current;
      setMsgs((m) => [...m, { kind: 'learner', id: nid(), text: '接受挑战，请下发任务详情' }]);
      void (async () => {
        await delay(500);
        if (!alive(session)) return;
        setMsgs((m) => [
          ...m,
          { kind: 'tutor', id: nid(), stage: '确认', text: taskText, kbRefs: kbRef ? [kbRef] : undefined },
        ]);
      })();
    },
    [accepted],
  );

  /** 知识点 chip 点击 → 插入导师复述气泡 */
  const recap = useCallback((topic: string, text: string, kbRef?: string) => {
    setMsgs((m) => [
      ...m,
      { kind: 'tutor', id: nid(), stage: '引导', text: `【${topic} · 复述】${text}`, kbRefs: kbRef ? [kbRef] : undefined },
    ]);
  }, []);

  return {
    msgs,
    awaitingNode: awaitingNodeId ? script.nodes[awaitingNodeId] ?? null : null,
    typing,
    streaming,
    answers,
    decisions,
    level,
    finished,
    accepted,
    sendOption,
    sendFreeText,
    acceptChallenge,
    recap,
    reset: start,
    notifyStreamDone,
  };
}
