/**
 * AgentDock — 「阿诊」常驻化身（学习者模式全站可见）
 * FAB（未读角标 + 新推断冒泡）→ 对话面板：汇报流 / 证据问答 / 验证测验（讨价还价）
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Brain, X, Check, MessageCircleQuestion, Radio, GitBranch, Database, SendHorizonal, Plus, Trash2 } from 'lucide-react';
import { useAgent } from '@/context/AgentContext';
import type { AgentMessage, DecisionEntry } from '@/context/AgentContext';
import { useProfile } from '@/context/ProfileContext';
import { knowledgePoints, getKnowledgePoint } from '@/data/knowledgePoints';
import { cn } from '@/lib/utils';

const letters = ['A', 'B', 'C', 'D'];

function Bubble({ m, onPick }: { m: AgentMessage; onPick: (msgId: string, q: number, o: number) => void }) {
  if (m.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-[14px] rounded-br-[4px] bg-brand px-3.5 py-2.5 text-[13px] leading-[20px] text-paper">
          {m.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-brand text-paper">
        <Brain size={14} />
      </span>
      <div className="min-w-0 max-w-[85%] space-y-2">
        {m.kind !== 'verify' && (
          <div className="rounded-[14px] rounded-tl-[4px] border border-hairline bg-card-warm px-3.5 py-2.5 text-[13px] leading-[21px] text-ink-2">
            {m.kind === 'evidence' ? (
              <>
                <p>{m.text}</p>
                <ul className="mt-2 space-y-1.5 border-t border-hairline pt-2">
                  {m.items.map((it, i) => (
                    <li key={i} className="flex gap-1.5 text-[12px] leading-[18px] text-ink-muted">
                      <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-brand" />
                      {it}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              m.text
            )}
            {m.kind === 'update' && (
              <div className="mt-2 flex flex-wrap gap-1.5 border-t border-hairline pt-2">
                {m.deltas.map((d) => (
                  <span key={d.kpId} className="inline-flex items-center gap-1 rounded-md bg-paper-deep px-1.5 py-0.5 font-mono text-[10.5px]">
                    {getKnowledgePoint(d.kpId).name}
                    <span className={d.to >= d.from ? 'text-brand-success' : 'text-brand-danger'}>
                      {d.from}→{d.to}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 验证测验卡 */}
        {m.kind === 'verify' &&
          m.questions.map((q, qi) => {
            const picked = m.picks[qi];
            return (
              <div key={q.id} className="rounded-[12px] border border-brand/25 bg-paper p-3">
                <div className="mb-1.5 font-mono text-[10px] text-ink-muted">
                  验证 {qi + 1}/{m.questions.length} · {q.level === 'basic' ? '基础' : q.level === 'advanced' ? '进阶' : '挑战'}
                </div>
                <p className="text-[12.5px] font-medium leading-[19px] text-ink">{q.stem}</p>
                <div className="mt-2 space-y-1.5">
                  {q.options.map((opt, oi) => {
                    const isAnswer = oi === q.answerIndex;
                    const isPicked = picked === oi;
                    const show = picked !== null;
                    return (
                      <button
                        key={oi}
                        type="button"
                        disabled={picked !== null}
                        onClick={() => onPick(m.id, qi, oi)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-[8px] border px-2.5 py-1.5 text-left text-[12px] leading-[17px] transition-all',
                          !show && 'border-hairline bg-card-warm text-ink-2 hover:border-brand/45',
                          show && isAnswer && 'border-brand-success/60 bg-brand-success/10 text-ink',
                          show && isPicked && !isAnswer && 'border-brand-danger/60 bg-brand-danger/10 text-ink',
                          show && !isAnswer && !isPicked && 'border-hairline bg-card-warm text-ink-muted opacity-60',
                        )}
                      >
                        <span className="font-mono text-[10.5px] text-ink-muted">{letters[oi]}</span>
                        {opt}
                        {show && isAnswer && <Check size={12} className="ml-auto shrink-0 text-brand-success" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}

const stageMeta: Record<DecisionEntry['stage'], { label: string; Icon: typeof Radio; cls: string }> = {
  signal: { label: 'SIGNAL', Icon: Radio, cls: 'text-ochre border-ochre/40 bg-ochre-tint' },
  inference: { label: 'INFER', Icon: GitBranch, cls: 'text-brand border-brand/40 bg-brand-tint' },
  writeback: { label: 'WRITE', Icon: Database, cls: 'text-agent-arb border-agent-arb/40 bg-paper-deep' },
};

/** 系统透视：决策日志视图（信号 → 推理 → 写入 全链路 + 置信度） */
function DecisionLogView() {
  const { decisions, confidence } = useAgent();
  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
      {/* 六维置信度 */}
      <div>
        <div className="lf-mono-label mb-2 !text-[10px]">DIMENSION CONFIDENCE · 各维判断置信度</div>
        <div className="space-y-1.5">
          {knowledgePoints.map((kp) => {
            const c = confidence[kp.id] ?? 40;
            return (
              <div key={kp.id} className="flex items-center gap-2">
                <span className="w-[72px] shrink-0 text-[11.5px] text-ink-2">{kp.name}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper-deep">
                  <div className="h-full rounded-full bg-brand transition-all duration-500" style={{ width: `${c}%` }} />
                </div>
                <span className="w-8 shrink-0 text-right font-mono text-[10.5px] text-ink-muted tabular">{c}%</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 决策链路 */}
      <div>
        <div className="lf-mono-label mb-2 !text-[10px]">DECISION LOG · 信号 → 推理 → 写入</div>
        {decisions.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-ink-muted">
            暂无决策记录 —— 切到学习者视角答几道题，回来就能看到全链路。
          </p>
        ) : (
          <div className="space-y-1.5">
            {decisions.map((d) => {
              const meta = stageMeta[d.stage];
              return (
                <div key={d.id} className="flex items-start gap-2 rounded-[8px] border border-hairline bg-card-warm px-2.5 py-2">
                  <span className={cn('mt-px inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold', meta.cls)}>
                    <meta.Icon size={9} />
                    {meta.label}
                  </span>
                  <span className="min-w-0 flex-1 text-[11.5px] leading-[17px] text-ink-2">{d.text}</span>
                  <span className="shrink-0 font-mono text-[9.5px] text-ink-muted">{d.time}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AgentDock() {
  const { messages, unread, open, setOpen, latestHint, ask, askFree, answerVerify, sessions, currentSessionId, createAgentSession, switchAgentSession, deleteAgentSession } = useAgent();
  const [draft, setDraft] = useState('');
  const { currentLearner, weakestKp, viewMode } = useProfile();
  const isExpert = viewMode === 'expert';
  const scrollRef = useRef<HTMLDivElement>(null);
  /* 上课时降噪：课件页里学习者正在读正文，阿诊不主动弹泡打断——推断照常积累，靠角标提示 */
  const inCourse = useLocation().pathname.startsWith('/learn/');

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, messages]);

  const chips: { label: string; kind: Parameters<typeof ask>[0] }[] = [
    { label: `为什么盲区是「${weakestKp.name}」？`, kind: 'why-blind' },
    { label: '我下一步学什么？', kind: 'what-next' },
    { label: `我的「${weakestKp.name}」不止这个分`, kind: 'challenge-score' },
  ];

  return (
    <>
      {/* ============ FAB ============ */}
      <div className="fixed bottom-24 right-4 z-50 flex flex-col items-end gap-2 md:bottom-6 md:right-6">
        {/* 新推断冒泡（学习者） */}
        <AnimatePresence>
          {!isExpert && !open && !inCourse && latestHint && (
            <motion.button
              type="button"
              initial={{ opacity: 0, y: 8, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.9 }}
              onClick={() => setOpen(true)}
              className="rounded-[12px] rounded-br-[4px] border border-brand/30 bg-card-warm px-3 py-2 text-[12.5px] font-medium text-brand shadow-warm"
            >
              {latestHint} ✦
            </motion.button>
          )}
        </AnimatePresence>

        <button
          type="button"
          onClick={() => setOpen(!open)}
          title={isExpert ? 'DIA-01 决策日志 · 系统透视' : '阿诊 · DIA-01 学情诊断'}
          className={cn(
            'relative flex h-13 w-13 items-center justify-center rounded-full border-2 shadow-warm-lg transition-all duration-200 hover:scale-105',
            'h-[52px] w-[52px]',
            open ? 'border-brand bg-paper text-brand' : 'border-brand/20 bg-brand text-paper',
          )}
        >
          {open ? <X size={20} /> : <Brain size={22} />}
          {!isExpert && !open && unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-danger px-1 font-mono text-[10.5px] font-bold text-paper">
              {unread}
            </span>
          )}
          {!open && (
            <span className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 rounded-full border-2 border-brand bg-brand-success" />
          )}
        </button>
      </div>

      {/* ============ 面板 ============ */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.97 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              'fixed bottom-[168px] right-4 z-50 flex max-h-[min(560px,calc(100dvh-140px))] w-[min(400px,calc(100vw-32px))] flex-col overflow-hidden rounded-[18px] md:bottom-[88px] md:right-6',
              isExpert ? 'border border-hairline bg-paper shadow-warm-lg' : 'lf-glass',
            )}
          >
            {/* 头 */}
            <div className="flex items-center gap-2.5 border-b border-hairline bg-card-warm px-4 py-3">
              <span className="relative flex h-9 w-9 items-center justify-center rounded-[10px] bg-brand text-paper">
                <Brain size={17} />
                <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card-warm bg-brand-success" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-ink">{isExpert ? 'DIA-01 决策日志' : '阿诊'}</div>
                <div className="font-mono text-[10px] text-ink-muted">
                  {isExpert
                    ? `SIGNAL → INFER → WRITE · 学习者 ${currentLearner.name}`
                    : `DIA-01 学情诊断 · 正在跟进 ${currentLearner.name}`}
                </div>
                {!isExpert && (
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <select
                      value={currentSessionId ?? ''}
                      onChange={(e) => { if (e.target.value) void switchAgentSession(e.target.value); }}
                      aria-label="阿诊会话"
                      className="min-w-0 flex-1 rounded-md border border-hairline bg-paper px-1.5 py-1 text-[10.5px] text-ink-2 outline-none"
                    >
                      {sessions.length === 0 && <option value="">暂无会话</option>}
                      {sessions.map((s) => (
                        <option key={s.id} value={s.id}>{s.title || '阿诊对话'} · {new Date(s.updatedAt).toLocaleDateString()}</option>
                      ))}
                    </select>
                    <button type="button" onClick={() => void createAgentSession()} title="新建会话" aria-label="新建会话" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-hairline bg-paper text-ink-2 transition hover:border-brand/40 hover:text-brand"><Plus size={12} /></button>
                    <button type="button" onClick={() => { if (currentSessionId) void deleteAgentSession(currentSessionId); }} disabled={!currentSessionId} title="删除当前会话" aria-label="删除当前会话" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-hairline bg-paper text-ink-muted transition hover:border-brand-danger/40 hover:text-brand-danger disabled:opacity-40"><Trash2 size={12} /></button>
                  </div>
                )}
              </div>
            </div>

            {isExpert ? (
              <DecisionLogView />
            ) : (
              <>
                {/* 消息流 */}
                <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
                  {messages.map((m) => (
                    <Bubble key={m.id} m={m} onPick={answerVerify} />
                  ))}
                </div>

                {/* 问题 chips：阿诊只管学情（画像/路径/证据链），知识点问题归课件里的「问一问」 */}
                <div className="border-t border-hairline bg-card-warm px-3 py-2.5">
                  <div className="mb-1.5 flex items-center gap-1 font-mono text-[9.5px] tracking-wide text-ink-muted">
                    <MessageCircleQuestion size={11} />
                    问问阿诊 · 关于你的学情
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {chips.map((c) => (
                      <button
                        key={c.kind}
                        type="button"
                        onClick={() => ask(c.kind)}
                        className="rounded-full border border-brand/30 bg-paper px-2.5 py-1 text-[11.5px] font-medium text-brand transition-all hover:bg-brand-tint"
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                  {/* 自由提问：不能只给三个预设——想自己打字问却没有输入框，就等于"问不了" */}
                  <div className="mt-2.5 flex items-center gap-2">
                    <input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' || !draft.trim()) return;
                        askFree(draft);
                        setDraft('');
                      }}
                      placeholder="也可以直接打字问我…"
                      aria-label="向阿诊提问"
                      className="h-9 min-w-0 flex-1 rounded-[10px] border border-hairline bg-paper px-3 text-[12.5px] text-ink outline-none transition-colors focus:border-brand/50"
                    />
                    <button
                      type="button"
                      disabled={!draft.trim()}
                      onClick={() => { askFree(draft); setDraft(''); }}
                      aria-label="发送"
                      className={cn(
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] transition-all',
                        draft.trim() ? 'bg-brand text-paper hover:bg-brand-hover' : 'cursor-not-allowed bg-paper-deep text-ink-muted/50',
                      )}
                    >
                      <SendHorizonal size={15} />
                    </button>
                  </div>
                  <p className="mt-1.5 text-[10.5px] leading-[15px] text-ink-muted">
                    知识点本身（比如"常闭触点是什么"）问课件里每段的
                    <span className="mx-0.5 font-medium text-brand">问一问</span>
                    更合适——那里带 KB 出处。
                  </p>
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
