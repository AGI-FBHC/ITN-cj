/**
 * 交互导学 `/tutoring`
 * 保留同事设计的苏格拉底对话、幕后协商、答题走势和动态难度；
 * 会话、分支、答案与决策均由 FastAPI tutoring session 持久化。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDown, CheckCircle2, Loader2, RotateCcw, SendHorizonal, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import AgentChip from '@/components/AgentChip';
import PageTip from '@/components/heal/PageTip';
import { Vine } from '@/components/heal/Flora';
import {
  AnswerCard,
  BackstageCard,
  FeedbackBubble,
  LearnerBubble,
  TutorBubble,
} from '@/components/tutoring/bubbles';
import SidePanel from '@/components/tutoring/SidePanel';
import type { KpTopic } from '@/components/tutoring/SidePanel';
import { useProfile } from '@/context/ProfileContext';
import { useCourseLearning } from '@/hooks/useCourseLearning';
import { api } from '@/lib/api';
import type { LearningResourceSummary, TutoringDecision, TutoringSession } from '@/lib/api';
import type { DecisionEvent } from '@/components/tutoring/engine';
import type { TutorOption } from '@/data/tutoringScript';
import { cn } from '@/lib/utils';

function DecisionCard({ decision }: { decision: TutoringDecision }) {
  const challenge = decision.type === 'challenge';
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={cn('mx-auto w-full max-w-[560px] rounded-[14px] border p-4', challenge ? 'border-brand-amber/40 bg-brand-amber-tint/45' : 'border-brand/35 bg-brand-tint/45')}>
      <div className="flex items-center gap-2"><Sparkles size={14} className={challenge ? 'text-ochre' : 'text-brand'} /><span className="font-mono text-[10.5px] font-semibold text-agent-arb">ARB-05 · {decision.label}</span><span className="ml-auto font-mono text-[10px] text-ink-muted">置信 {decision.confidence.toFixed(2)}</span></div>
      <p className="mt-2 text-[12.5px] leading-5 text-ink-2">{decision.reason}</p>
    </motion.div>
  );
}

function SessionSummary({ session, resource }: { session: TutoringSession; resource: LearningResourceSummary }) {
  const correct = session.answers.filter(Boolean).length;
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mx-auto w-full max-w-[580px] rounded-[16px] border border-brand/30 bg-brand-tint/35 p-5">
      <div className="flex items-center gap-2"><CheckCircle2 size={18} className="text-brand" /><h3 className="font-serif text-[18px] font-semibold text-ink">本轮导学完成</h3></div>
      <p className="mt-2 text-[13px] leading-6 text-ink-2">围绕《{resource.title}》完成了 {session.answers.length} 次有效作答，答对 {correct} 次；会话、答题走势和 Agent 决策已经保存到后端。</p>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center"><div className="rounded-lg bg-paper p-2"><div className="font-display text-[18px] font-semibold text-brand">{correct}/{session.answers.length}</div><div className="text-[10.5px] text-ink-muted">本轮答题</div></div><div className="rounded-lg bg-paper p-2"><div className="font-display text-[18px] font-semibold text-brand">{session.decisions.length}</div><div className="text-[10.5px] text-ink-muted">动态决策</div></div><div className="rounded-lg bg-paper p-2"><div className="font-display text-[18px] font-semibold text-brand">L{session.level}</div><div className="text-[10.5px] text-ink-muted">结束难度</div></div></div>
      <div className="mt-4 flex flex-wrap gap-2"><Link to="/learn" className="lf-btn-primary">继续课程</Link><Link to="/me/wrong" className="lf-btn-ghost">查看错题本</Link><Link to="/report" className="lf-btn-ghost">查看学习报告</Link></div>
    </motion.div>
  );
}

export default function Tutoring() {
  const { currentLearner, viewMode } = useProfile();
  const learning = useCourseLearning();
  const quizzes = learning.resources.filter((resource) => resource.type === 'quiz');
  const recommended = quizzes.find((resource) => !resource.learned) ?? quizzes[0] ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = quizzes.find((resource) => resource.id === selectedId) ?? recommended;
  const [session, setSession] = useState<TutoringSession | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showBackBottom, setShowBackBottom] = useState(false);
  const nearBottomRef = useRef(true);
  const startedResourceRef = useRef<string | null>(null);
  const isLearner = viewMode === 'learner';

  const startSession = useCallback(async (resource: LearningResourceSummary, force = false) => {
    if (!force && startedResourceRef.current === resource.id) return;
    startedResourceRef.current = resource.id;
    setLoadingSession(true);
    setError('');
    try {
      setSession(await api.createTutoringSession({ resourceId: resource.id }));
    } catch (reason) {
      startedResourceRef.current = null;
      setSession(null);
      setError(reason instanceof Error ? reason.message : '真实导学会话创建失败');
    } finally { setLoadingSession(false); }
  }, []);

  useEffect(() => {
    if (selected) void startSession(selected);
  }, [selected, startSession]);

  useEffect(() => {
    if (nearBottomRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [session?.messages.length, submitting]);

  const answer = async (body: { optionIndex?: number; freeText?: string }) => {
    if (!session || submitting || session.status === 'completed') return;
    setSubmitting(true);
    setError('');
    try {
      setSession(await api.answerTutoringSession(session.id, body));
      setInput('');
      nearBottomRef.current = true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '回答提交失败');
    } finally { setSubmitting(false); }
  };

  const decisions = useMemo<DecisionEvent[]>(() => (session?.decisions ?? []).map((decision) => ({
    ...decision,
    time: new Date(session?.updatedAt ?? Date.now()).toLocaleTimeString('zh-CN', { hour12: false }),
  })), [session]);
  const topics = useMemo<KpTopic[]>(() => (session?.topics ?? []).map((topic) => ({
    topic: topic.name,
    mastery: currentLearner.scores[session?.kpId ?? ''] ?? session?.scoreBefore ?? 50,
    recapText: topic.description,
    kbRef: topic.kbRef ?? undefined,
  })), [currentLearner.scores, session]);
  const correct = session?.answers.filter(Boolean).length ?? 0;

  if (learning.loading) return <div className="mx-auto max-w-[980px] px-6 py-16 text-center text-[14px] text-ink-muted">正在读取真实课程与导学题目…</div>;

  return (
    <div className={`mx-auto ${isLearner ? 'max-w-[1080px] px-5 md:px-6' : 'max-w-[1320px] px-8'} py-10`}>
      <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-end justify-between gap-4">
        <div><div className="lf-mono-label flex items-center gap-2"><span className="inline-block h-px w-6 bg-brand/40" />{isLearner ? '边问边练 · 练' : 'SOCRATIC TUTORING · PERSISTED SESSION'}</div><h1 className="mt-2 font-serif text-[36px] font-bold leading-[44px] text-ink">{isLearner ? 'AI 老师陪你练一节' : '交互导学'}</h1><div className="mt-3 flex flex-wrap items-center gap-2.5"><span className="lf-chip !py-1.5">{learning.course?.title ?? '当前课程'}</span>{selected && <span className="rounded-lg border border-brand/25 bg-brand-tint px-2.5 py-1.5 font-mono text-[11.5px] text-brand">{selected.title}</span>}</div></div>
        {selected && <button type="button" onClick={() => void startSession(selected, true)} disabled={loadingSession || submitting} className="lf-btn-ghost !px-4 !py-2 text-[13.5px]"><RotateCcw size={14} />重新练一遍</button>}
      </motion.div>

      <PageTip id="tutoring-real" className="mt-5">这是后端持久化的<span className="font-medium text-ink">对话式导学</span>：可以点快答，也能直接说出你的想法。答错后，Agent 会切换到更细的解释路径。</PageTip>

      {quizzes.length > 1 && <div className="mt-5 flex gap-2 overflow-x-auto pb-1">{quizzes.map((quiz) => <button key={quiz.id} type="button" onClick={() => { setSelectedId(quiz.id); startedResourceRef.current = null; }} className={cn('shrink-0 rounded-lg border px-3 py-2 text-[12px]', selected?.id === quiz.id ? 'border-brand bg-brand text-paper' : 'border-hairline bg-card-warm text-ink-2 hover:border-brand/40')}>{quiz.title}</button>)}</div>}

      {!selected && <div className="lf-card mt-6 p-8 text-center"><h2 className="text-[18px] font-semibold text-ink">当前课程还没有分阶题</h2><p className="mt-2 text-[13px] text-ink-muted">先在章节资源中生成真实题目，导学老师会据此建立追问会话。</p><Link to="/learn" className="lf-btn-primary mt-5 inline-flex">进入我的课程</Link></div>}
      {error && <div className="mt-5 rounded-[11px] border border-brand-danger/35 bg-brand-danger/10 px-4 py-3 text-[13px] text-brand-danger">{error}</div>}

      {selected && <div className="mt-6 grid grid-cols-12 gap-6">
        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} className="relative col-span-12 lg:col-span-8">
          {isLearner && <Vine className="pointer-events-none absolute -top-3 right-10 z-10 hidden h-[96px] w-[48px] opacity-85 sm:block" />}
          <div className="lf-card relative flex h-[640px] flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-hairline bg-paper px-5 py-3"><span className="flex items-center gap-2">{isLearner ? <><span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand text-[12px] font-bold text-paper">诊</span><span className="text-[13.5px] font-semibold text-ink">阿诊老师</span></> : <AgentChip agentId="DIA-01" size="sm" showStatus={false} />}</span><span className="flex items-center gap-1.5 font-mono text-[10.5px] text-brand"><span className="h-1.5 w-1.5 animate-ping rounded-full bg-brand" />{session?.status === 'completed' ? '已完成并保存' : 'LIVE · 后端会话'}</span></div>
            <div ref={scrollRef} onScroll={() => { const el = scrollRef.current; if (!el) return; const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120; nearBottomRef.current = near; setShowBackBottom(!near); }} className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
              {loadingSession && <div className="flex h-full items-center justify-center gap-2 text-[13px] text-ink-muted"><Loader2 size={15} className="animate-spin" />正在创建真实导学会话…</div>}
              {session?.messages.map((message, index) => {
                const key = `${session.id}-${index}-${message.kind}`;
                if (message.kind === 'tutor') return <TutorBubble key={key} id={key} text={message.text ?? ''} stage={message.stage} kbRefs={message.kbRefs} confidence={0.95} onStreamDone={() => undefined} />;
                if (message.kind === 'learner') return <LearnerBubble key={key} text={message.text ?? ''} avatar={currentLearner.avatar} name={currentLearner.name} />;
                if (message.kind === 'feedback') return <FeedbackBubble key={key} verdict={message.verdict ?? 'wrong'} text={message.text ?? ''} />;
                if (message.kind === 'backstage' && message.notes) return <BackstageCard key={key} notes={message.notes} />;
                if (message.kind === 'decision') { const decision = session.decisions.find((item) => item.type === message.type && item.reason === message.reason); return decision ? <DecisionCard key={key} decision={decision} /> : null; }
                if (message.kind === 'summary') return <SessionSummary key={key} session={session} resource={selected} />;
                return null;
              })}
              {submitting && <div className="flex items-center justify-center gap-2 font-mono text-[11px] text-agent-arb"><Loader2 size={13} className="animate-spin" />ARB-05 正在判定回答并选择下一条路径…</div>}
              <AnimatePresence>{session?.currentNode?.options && !submitting && <AnswerCard key={`answer-${session.currentNode.id}`} options={session.currentNode.options.map((option) => ({ label: option.label, next: '' } as TutorOption))} onPick={(option) => { const optionIndex = session.currentNode?.options.findIndex((item) => item.label === option.label) ?? -1; if (optionIndex >= 0) void answer({ optionIndex }); }} />}</AnimatePresence>
            </div>
            <AnimatePresence>{showBackBottom && <motion.button type="button" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} onClick={() => { nearBottomRef.current = true; scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }} className="absolute bottom-[76px] left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-hairline bg-card-warm px-3 py-1.5 text-[12px] font-medium text-brand shadow-warm"><ArrowDown size={13} />回到底部</motion.button>}</AnimatePresence>
            <div className="border-t border-hairline bg-paper px-5 py-3.5"><div className="flex items-center gap-2.5"><input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && input.trim()) void answer({ freeText: input.trim() }); }} disabled={!session?.currentNode || submitting} placeholder={session?.status === 'completed' ? '本节已完成，可重新练一遍或切换其他章节' : '输入你的想法，或选择上方快答…'} className="h-10 flex-1 rounded-[10px] border border-hairline bg-card-warm px-3.5 text-[13.5px] text-ink outline-none focus:border-brand/50 disabled:cursor-not-allowed disabled:opacity-60" /><button type="button" onClick={() => void answer({ freeText: input.trim() })} disabled={!session?.currentNode || !input.trim() || submitting} className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-brand text-paper transition hover:bg-brand-hover disabled:cursor-not-allowed disabled:bg-paper-deep disabled:text-ink-muted"><SendHorizonal size={16} /></button></div></div>
          </div>
        </motion.div>

        <motion.aside initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} className="col-span-12 lg:col-span-4 lg:sticky lg:top-24 lg:self-start"><SidePanel asked={session?.answers.length ?? 0} correct={correct} level={session?.level ?? 2} decisions={decisions} topics={topics} answers={session?.answers ?? []} showSeedDecision={false} onRecap={(topic) => setInput(`请用更简单的方式复述：${topic.topic}`)} /></motion.aside>
      </div>}
    </div>
  );
}
