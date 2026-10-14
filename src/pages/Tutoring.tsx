/**
 * 交互导学 `/tutoring`（tutoring.md）
 * 苏格拉底式追问对话（tutoringScript.ts 脚本图解释执行）
 * 快答 chips / 自由输入 / 幕后协商卡 / 答题正确率实时回流 →
 * ARB-05「降维解释 · 进阶挑战」全宽决策横幅 → 课后小结回写画像（闭环）
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowDown,
  FileText,
  Image as ImageIcon,
  Mic,
  Presentation,
  RotateCcw,
  SendHorizonal,
  X,
} from 'lucide-react';
import { useProfile, dataIdOf } from '@/context/ProfileContext';
import { useAgent } from '@/context/AgentContext';
import { useReview } from '@/context/ReviewContext';
import { getTutoringScript } from '@/data/tutoringScript';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import AgentChip from '@/components/AgentChip';
import { Vine } from '@/components/heal/Flora';
import { useTutoringEngine } from '@/components/tutoring/engine';
import {
  TutorBubble,
  LearnerBubble,
  TypingIndicator,
  BackstageCard,
  ArbitrateRow,
  AnswerCard,
  FeedbackBubble,
} from '@/components/tutoring/bubbles';
import DecisionBlock from '@/components/tutoring/DecisionBlock';
import SidePanel from '@/components/tutoring/SidePanel';
import type { KpTopic } from '@/components/tutoring/SidePanel';
import SummaryCard from '@/components/tutoring/SummaryCard';
import PageTip from '@/components/heal/PageTip';
import { cn } from '@/lib/utils';

export default function Tutoring() {
  const { currentLearner, viewMode } = useProfile();
  const { pushSignal } = useAgent();
  const { markStudied } = useReview();
  const isLearner = viewMode === 'learner';
  const script = getTutoringScript(dataIdOf(currentLearner));
  const kp = getKnowledgePoint(script.kpId);
  const engine = useTutoringEngine(script, currentLearner);
  const {
    msgs,
    awaitingNode,
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
    reset,
    notifyStreamDone,
  } = engine;

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const [showBackBottom, setShowBackBottom] = useState(false);

  /* ---------- 多模态输入：语音 / 图片 / PPT / 文档 ---------- */
  type Attachment = { id: string; kind: 'voice' | 'image' | 'ppt' | 'doc'; name: string };
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [recording, setRecording] = useState(false);
  const recordStartRef = useRef(0);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pptInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);

  const attachmentLabel: Record<Attachment['kind'], string> = {
    voice: '语音',
    image: '图片',
    ppt: 'PPT',
    doc: '文档',
  };

  const addFileAttachment = (kind: 'image' | 'ppt' | 'doc') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAttachments((prev) => [...prev, { id: `${kind}-${Date.now()}`, kind, name: file.name }]);
    }
    e.target.value = '';
  };

  const toggleRecording = () => {
    if (!awaitingNode) return;
    if (!recording) {
      recordStartRef.current = Date.now();
      setRecording(true);
    } else {
      const secs = Math.max(1, Math.round((Date.now() - recordStartRef.current) / 1000));
      setAttachments((prev) => [
        ...prev,
        { id: `voice-${Date.now()}`, kind: 'voice', name: `0:${String(secs).padStart(2, '0')}` },
      ]);
      setRecording(false);
    }
  };

  const asked = answers.length;
  const correct = answers.filter(Boolean).length;

  /* 本节知识点 chips：掌握度由画像分数派生 */
  const topics = useMemo<KpTopic[]>(() => {
    const base = currentLearner.scores[script.kpId] ?? 50;
    return kp.coreTopics.slice(0, 3).map((topic, i) => ({
      topic,
      mastery: Math.min(96, Math.max(10, base + [14, 3, -9][i])),
      recapText: kp.description,
    }));
  }, [currentLearner, script.kpId, kp]);

  /* ---------- 自动滚动 ---------- */
  const scrollToBottom = (smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };
  useEffect(() => {
    if (nearBottomRef.current) scrollToBottom(true);
  }, [msgs, typing]);
  /* 流式期间持续跟底 */
  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => {
      if (nearBottomRef.current) scrollToBottom(false);
    }, 200);
    return () => clearInterval(t);
  }, [streaming]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    nearBottomRef.current = near;
    setShowBackBottom(!near);
  };

  const submit = () => {
    if ((!input.trim() && attachments.length === 0) || !awaitingNode) return;
    /* 附件以「【图片 · xx.png】」前缀随文本一起进入消息流 */
    const prefix = attachments
      .map((a) => `【${attachmentLabel[a.kind]} · ${a.name}】`)
      .join(' ');
    sendFreeText([prefix, input.trim()].filter(Boolean).join(' '));
    setInput('');
    setAttachments([]);
    setRecording(false);
    nearBottomRef.current = true;
  };

  /* 回写钩子：本节结束 → 交给伴学助手推理回写（画像 + 时间线 + 对话消息，闭环成环） */
  const wroteForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!finished) return;
    if (wroteForRef.current === currentLearner.id) return;
    wroteForRef.current = currentLearner.id;
    pushSignal({ type: 'tutoring-finished', kpId: script.kpId, title: script.title, asked, correct, value: asked > 0 ? Math.round((correct / asked) * 100) : 25 });
    /* 遗忘曲线：练过一节 = 给这株浇了水 */
    markStudied(script.kpId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished, currentLearner.id]);

  /* 学练一体：学习者视角不再有独立「练」页，统一收敛到 /me/calibrate（用真实练习校准画像）。
     本页在学习者视角下同样可用：苏格拉底式追问导学是常规学习能力，不再只服务于演示视角。
     注意：学习者侧入口必须直接指向 /me/calibrate，不要依赖这里的静默 replace 跳转
     （否则点「去练一组题」后地址栏突变、返回键也回不去，属 BUG-008）。 */
  if (isLearner) return <Navigate to="/me/calibrate" replace />;

  return (
    <div className={`mx-auto ${isLearner ? 'max-w-[1080px] px-5 md:px-6' : 'max-w-[1320px] px-8'} py-10`}>
      {/* ---------- S1 页头 ---------- */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="flex flex-wrap items-end justify-between gap-4"
      >
        <div>
          <div className="lf-mono-label flex items-center gap-2">
            <span className="inline-block h-px w-6 bg-brand/40" />
            {isLearner ? '边问边练 · 练' : 'SOCRATIC TUTORING'}
          </div>
          <h1 className="mt-2 font-serif text-[36px] font-bold leading-[44px] text-ink">
            {isLearner ? 'AI 老师陪你练一节' : '交互导学'}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <span className="lf-chip !py-1.5">
              {isLearner ? `今天练：${kp.name}` : `本节主题：${kp.name} · 为${currentLearner.tag}设计`}
            </span>
            <span className="rounded-lg border border-brand/25 bg-brand-tint px-2.5 py-1.5 font-mono text-[11.5px] text-brand">
              {script.title}
            </span>
          </div>
        </div>
        {/* 刚进来时说「重开」很怪（还没开始过）——按进度换措辞 */}
        <button
          type="button"
          onClick={reset}
          title={asked === 0 ? '换一节内容' : '从头再练一遍这一节'}
          className="lf-btn-ghost !px-4 !py-2 text-[13.5px]"
        >
          <RotateCcw size={14} /> {asked === 0 ? '换一节' : '重新练一遍'}
        </button>
      </motion.div>

      {isLearner && (
        <PageTip id="tutoring" className="mt-5">
          这是<span className="font-medium text-ink">对话式</span>练习：可以点快答，也能直接打字说你的想法。
          答不上来就说「不会」——AI 会换个更简单的问法，不会扣分。
        </PageTip>
      )}

      <div className="mt-6 grid grid-cols-12 gap-6">
        {/* ---------- S2 对话区 ---------- */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
          className="relative col-span-12 lg:col-span-8"
        >
          {/* 练页植物：垂藤（从对话区上缘垂下） */}
          {isLearner && (
            <Vine className="pointer-events-none absolute -top-3 right-10 z-10 hidden h-[96px] w-[48px] opacity-85 sm:block" />
          )}
          <div className="lf-card relative flex h-[640px] flex-col overflow-hidden">
            {/* 对话标题条 */}
            <div className="flex items-center justify-between border-b border-hairline bg-paper px-5 py-3">
              {isLearner ? (
                <span className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand text-[12px] font-bold text-paper">诊</span>
                  <span className="text-[13.5px] font-semibold text-ink">伴学助手老师</span>
                </span>
              ) : (
                <>
                  <AgentChip agentId="DIA-01" size="sm" showStatus={false} />
                  <span className="font-mono text-[10.5px] text-ink-muted">
                    苏格拉底三阶法 · 引导 → 追问 → 确认
                  </span>
                </>
              )}
              <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-brand">
                <span className="h-1.5 w-1.5 animate-ping rounded-full bg-brand" />
                {isLearner ? '在线' : 'LIVE'}
              </span>
            </div>

            {/* 消息流 */}
            <div
              ref={scrollRef}
              onScroll={onScroll}
              className="flex-1 space-y-4 overflow-y-auto px-5 py-5"
            >
              {msgs.map((m) => {
                switch (m.kind) {
                  case 'tutor':
                    /* 置信度为演示值：基础 0.92，若该气泡带 KB 溯源则 +0.05，上限 0.97 */
                    return (
                      <TutorBubble
                        key={m.id}
                        id={m.id}
                        text={m.text}
                        stage={m.stage}
                        kbRefs={m.kbRefs}
                        confidence={Math.min(0.97, 0.92 + (m.kbRefs?.length ? 0.05 : 0))}
                        onStreamDone={notifyStreamDone}
                      />
                    );
                  case 'feedback':
                    return <FeedbackBubble key={m.id} verdict={m.verdict} text={m.text} />;
                  case 'learner':
                    return (
                      <LearnerBubble
                        key={m.id}
                        text={m.text}
                        avatar={currentLearner.avatar}
                        name={currentLearner.name}
                      />
                    );
                  case 'backstage':
                    return <BackstageCard key={m.id} notes={m.notes} />;
                  case 'arbitrate':
                    return <ArbitrateRow key={m.id} />;
                  case 'decision':
                    return (
                      <DecisionBlock
                        key={m.id}
                        type={m.type}
                        reason={m.reason}
                        accuracy={m.accuracy}
                        asked={m.asked}
                        learnerId={currentLearner.id}
                        accepted={accepted}
                        onAccept={acceptChallenge}
                      />
                    );
                  case 'summary':
                    return (
                      <SummaryCard
                        key={m.id}
                        learner={currentLearner}
                        script={script}
                        topics={topics}
                        asked={asked}
                        correct={correct}
                        decisionCount={decisions.length}
                        isLearner={isLearner}
                      />
                    );
                  default:
                    return null;
                }
              })}
              {typing && <TypingIndicator />}
              {/* 答题卡气泡（随当前问题出现） */}
              <AnimatePresence>
                {awaitingNode?.options && !typing && !streaming && (
                  <AnswerCard
                    key={`ans-${awaitingNode.id}`}
                    options={awaitingNode.options}
                    onPick={(o) => {
                      sendOption(o);
                      nearBottomRef.current = true;
                    }}
                  />
                )}
              </AnimatePresence>
            </div>

            {/* 回到底部 */}
            <AnimatePresence>
              {showBackBottom && (
                <motion.button
                  type="button"
                  /* 水平居中交给 framer 的 x —— motion 的内联 transform 会覆盖 Tailwind 的 -translate 类 */
                  initial={{ opacity: 0, y: 10, x: '-50%' }}
                  animate={{ opacity: 1, y: 0, x: '-50%' }}
                  exit={{ opacity: 0, y: 10, x: '-50%' }}
                  onClick={() => {
                    nearBottomRef.current = true;
                    scrollToBottom(true);
                  }}
                  className="absolute bottom-[132px] left-1/2 z-10 flex items-center gap-1 rounded-full border border-hairline bg-card-warm px-3 py-1.5 text-[12px] font-medium text-brand shadow-warm"
                >
                  <ArrowDown size={13} /> 回到底部
                </motion.button>
              )}
            </AnimatePresence>

            {/* 输入条（多模态：语音 / 图片 / PPT / 文档 + 文本） */}
            <div className="border-t border-hairline bg-paper px-5 py-3.5">
              {/* 待发送附件 chips */}
              <AnimatePresence>
                {attachments.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {attachments.map((a) => (
                        <span
                          key={a.id}
                          className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand-tint/50 py-1 pl-2.5 pr-1.5 text-[11.5px] font-medium text-brand"
                        >
                          {a.kind === 'voice' && <Mic size={11} />}
                          {a.kind === 'image' && <ImageIcon size={11} />}
                          {a.kind === 'ppt' && <Presentation size={11} />}
                          {a.kind === 'doc' && <FileText size={11} />}
                          <span className="max-w-[140px] truncate">
                            {attachmentLabel[a.kind]} · {a.name}
                          </span>
                          <button
                            type="button"
                            onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                            aria-label={`移除${attachmentLabel[a.kind]}附件`}
                            className="flex h-4 w-4 items-center justify-center rounded-full text-brand/70 transition-colors hover:bg-brand/15 hover:text-brand"
                          >
                            <X size={10} />
                          </button>
                        </span>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="flex items-center gap-2.5">
                {/* 多模态入口 */}
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={toggleRecording}
                    disabled={!awaitingNode}
                    title={recording ? '停止录音' : '语音输入'}
                    aria-label={recording ? '停止录音' : '语音输入'}
                    className={cn(
                      'relative flex h-9 w-9 items-center justify-center rounded-[10px] border transition-all duration-200',
                      recording
                        ? 'border-brand-danger/50 bg-brand-danger/10 text-brand-danger'
                        : 'border-hairline bg-card-warm text-ink-muted hover:border-brand/40 hover:text-brand',
                      !awaitingNode && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <Mic size={15} />
                    {recording && (
                      <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-ping rounded-full bg-brand-danger" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => imageInputRef.current?.click()}
                    disabled={!awaitingNode}
                    title="发图片（题目照片 / 现场照片）"
                    aria-label="上传图片"
                    className={cn(
                      'flex h-9 w-9 items-center justify-center rounded-[10px] border border-hairline bg-card-warm text-ink-muted transition-all duration-200 hover:border-brand/40 hover:text-brand',
                      !awaitingNode && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <ImageIcon size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => pptInputRef.current?.click()}
                    disabled={!awaitingNode}
                    title="发 PPT / 讲义"
                    aria-label="上传 PPT"
                    className={cn(
                      'flex h-9 w-9 items-center justify-center rounded-[10px] border border-hairline bg-card-warm text-ink-muted transition-all duration-200 hover:border-brand/40 hover:text-brand',
                      !awaitingNode && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <Presentation size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => docInputRef.current?.click()}
                    disabled={!awaitingNode}
                    title="发文档 / 笔记"
                    aria-label="上传文档"
                    className={cn(
                      'flex h-9 w-9 items-center justify-center rounded-[10px] border border-hairline bg-card-warm text-ink-muted transition-all duration-200 hover:border-brand/40 hover:text-brand',
                      !awaitingNode && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <FileText size={15} />
                  </button>
                </div>
                <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={addFileAttachment('image')} />
                <input ref={pptInputRef} type="file" accept=".ppt,.pptx,.pdf" className="hidden" onChange={addFileAttachment('ppt')} />
                <input ref={docInputRef} type="file" accept=".txt,.md,.doc,.docx" className="hidden" onChange={addFileAttachment('doc')} />

                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submit();
                  }}
                  disabled={!awaitingNode}
                  placeholder={
                    finished
                      ? '本节已结束，可点击右上角「重开一节」'
                      : recording
                        ? '正在录音，再点一次麦克风结束…'
                        : awaitingNode
                          ? '输入你的回答，或用语音 / 图片提问…'
                          : '导师思考中…'
                  }
                  className={cn(
                    'h-10 min-w-0 flex-1 rounded-[10px] border border-hairline bg-card-warm px-3.5 text-[13.5px] text-ink outline-none transition-colors placeholder:text-ink-muted/70 focus:border-brand/50',
                    !awaitingNode && 'cursor-not-allowed opacity-60',
                  )}
                />
                <button
                  type="button"
                  onClick={submit}
                  disabled={!awaitingNode || (!input.trim() && attachments.length === 0)}
                  className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] transition-all duration-200',
                    awaitingNode && (input.trim() || attachments.length > 0)
                      ? 'bg-brand text-paper hover:bg-brand-hover hover:shadow-warm'
                      : 'cursor-not-allowed bg-paper-deep text-ink-muted/50',
                  )}
                  aria-label="发送"
                >
                  <SendHorizonal size={16} />
                </button>
              </div>
            </div>
          </div>
        </motion.div>

        {/* ---------- S4 右栏 ---------- */}
        <motion.aside
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="col-span-12 lg:col-span-4 lg:sticky lg:top-24 lg:self-start"
        >
          <SidePanel
            asked={asked}
            correct={correct}
            level={level}
            decisions={decisions}
            topics={topics}
            answers={answers}
            kpId={script.kpId}
            scores={currentLearner.scores}
            onRecap={(t) => recap(t.topic, t.recapText, t.kbRef)}
          />
        </motion.aside>
      </div>
    </div>
  );
}
