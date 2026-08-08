/**
 * DebatePanel — S4 辩论与交叉验证面板（全宽，视觉高潮）
 * 左：GEN-03（琥珀）vs VER-04（砖红）两轮交锋气泡流 + typing 指示
 * 右：草稿 diff 修订视图（对照 / 终稿 tabs，v1→v2 删除线 + 高亮 + TraceBadge）
 * 头部徽标组：幻觉拦截 · 溯源补齐 · 复核通过（随脚本派发点亮）
 */
import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldAlert, Link2, BadgeCheck, Swords, ArrowDown } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { CollabScript } from '@/data/collabScript';
import SectionHeader from '@/components/SectionHeader';
import DebateBubble from '@/components/DebateBubble';
import TraceBadge from '@/components/TraceBadge';
import type { PlayStatus } from './usePlayback';
import { formatWallTime, reducedMotion } from './usePlayback';
import { getScriptIndices } from './scriptModel';
import { cn } from '@/lib/utils';

const easeLf = [0.22, 1, 0.36, 1] as [number, number, number, number];

interface DiffLine {
  text: string;
  kbs: string[];
}

interface DiffRound {
  round: number;
  at: number;
  section: string;
  removed: string[];
  added: DiffLine[];
}

function TypingDots({ side }: { side: 'left' | 'right' }) {
  return (
    <div className={cn('flex w-full', side === 'left' ? 'justify-start' : 'justify-end')}>
      <div className="flex items-center gap-1 rounded-[12px] border border-hairline bg-card-warm px-3.5 py-2.5">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-ink-muted"
            animate={{ opacity: [0.25, 1, 0.25] }}
            transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.18 }}
          />
        ))}
      </div>
    </div>
  );
}

function ResultBadge({
  icon: Icon,
  label,
  color,
  lit,
}: {
  icon: typeof ShieldAlert;
  label: string;
  color: string;
  lit: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11.5px] font-medium transition-all duration-300',
        !lit && 'opacity-40',
      )}
      style={{
        color,
        borderColor: `${color}50`,
        backgroundColor: lit ? `${color}12` : 'transparent',
      }}
    >
      <Icon size={12} />
      {label}
    </span>
  );
}

export default function DebatePanel({
  script,
  cursor,
  base,
  status,
  stepMode,
}: {
  script: CollabScript;
  cursor: number;
  base: number | null;
  status: PlayStatus;
  stepMode: boolean;
}) {
  const idx = useMemo(() => getScriptIndices(script.events), [script.events]);
  const [tab, setTab] = useState<'diff' | 'final'>('diff');

  const dispatched = script.events.slice(0, cursor);
  const debateItems = script.events
    .map((e, i) => ({ e, i }))
    .filter(({ e, i }) => e.type === 'debate' && i < cursor);

  const nextEvent = cursor < script.events.length ? script.events[cursor] : null;
  const typingAgent =
    nextEvent && nextEvent.type === 'debate' && (status === 'running' || (stepMode && status !== 'done' && status !== 'idle'))
      ? nextEvent.from
      : null;

  const blockedCount = dispatched.filter(
    (e) => e.content.includes('幻觉拦截') || (e.payload ?? '').includes('hallucination_blocked'),
  ).length;
  const citedKbs = new Set<string>();
  dispatched.forEach((e) => {
    if ((e.type === 'debate' && e.from === 'GEN-03') || e.type === 'revision') {
      e.kbRefs?.forEach((id) => citedKbs.add(id));
    }
  });
  const verdictDone = idx.verdict >= 0 && cursor > idx.verdict;

  const diffRounds: DiffRound[] = [
    {
      round: 1,
      at: idx.revision,
      section: '§2.3 重复定位精度',
      removed: ['重复定位精度 ±0.02 mm。'],
      added: [
        {
          text: '重复定位精度 ±0.02 mm（额定负载 · 最大速度 50% 工况，依 GB/T 12642-2013 §7.2 试验条款）。',
          kbs: ['KB-007'],
        },
        { text: '新增脚注：温度补偿系数 k=0.021°/10℃。', kbs: ['KB-021'] },
      ],
    },
    {
      round: 2,
      at: idx.r2Answer,
      section: '§3 温度补偿模型',
      removed: ['温度补偿模型 Δθ=k(T−T₀) 全温区线性适用。'],
      added: [
        {
          text: '线性补偿适用区间 10–35℃；超出区间须五点恒温实验重新拟合（KB-014 §6.4）。',
          kbs: ['KB-014'],
        },
      ],
    },
  ];
  const visibleRounds = diffRounds.filter((r) => r.at >= 0 && cursor > r.at);
  const removedTotal = visibleRounds.reduce((n, r) => n + r.removed.length, 0);

  return (
    <section className="mt-14" aria-label="辩论与交叉验证">
      <SectionHeader
        en="DEBATE & CROSS-VALIDATION"
        title="辩论与交叉验证 · 幻觉拦截实录"
        desc="GEN-03 与 VER-04 围绕草稿事实性展开多轮交锋：无出处表述一票否决，修订留痕可对照。"
        actions={
          <>
            <ResultBadge icon={ShieldAlert} label={`幻觉拦截 ${blockedCount} 处`} color="#B0483B" lit={blockedCount > 0} />
            <ResultBadge icon={Link2} label={`溯源补齐 ${citedKbs.size} 条`} color="#E7B45A" lit={citedKbs.size > 0} />
            <ResultBadge icon={BadgeCheck} label="复核通过" color="#4E7860" lit={verdictDone} />
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-12">
        {/* 左栏：辩论气泡流 */}
        <div className="lg:col-span-5">
          <div className="lf-card space-y-4 p-5">
            <div className="flex items-center gap-2 border-b border-hairline pb-3">
              <Swords size={15} className="text-brand-danger" />
              <span className="text-[14px] font-semibold text-ink">GEN-03 × VER-04 交锋记录</span>
              <span className="ml-auto font-mono text-[10.5px] text-ink-muted">
                {debateItems.length > 0 ? `R${debateItems[debateItems.length - 1].e.round ?? 1} 进行中` : 'STANDBY'}
              </span>
            </div>

            {debateItems.length === 0 && !typingAgent && (
              <div className="flex h-[180px] flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-hairline text-center">
                <Swords size={18} className="text-ink-muted" />
                <p className="px-8 text-[13px] leading-[20px] text-ink-muted">
                  辩论尚未开始 —— 草稿送审后，GEN-03 与 VER-04 将在此展开两轮交锋
                </p>
              </div>
            )}

            {debateItems.map(({ e }, k) => {
              const isVer = e.from === 'VER-04';
              const round = e.round ?? 1;
              const divider = k > 0 && round !== (debateItems[k - 1].e.round ?? 1);
              return (
                <div key={`${e.t}-${e.from}`}>
                  {divider && (
                    <div className="mb-4 flex items-center gap-3">
                      <span className="h-px flex-1 bg-hairline" />
                      <span className="font-mono text-[10px] tracking-[0.14em] text-ink-muted">
                        ROUND {round}
                      </span>
                      <span className="h-px flex-1 bg-hairline" />
                    </div>
                  )}
                  <motion.div
                    animate={
                      isVer && !reducedMotion() ? { x: [0, -2, 2, -2, 2, 0] } : undefined
                    }
                    transition={{ duration: 0.4, delay: 0.35 }}
                  >
                    <DebateBubble
                      agentId={e.from}
                      round={round as 1 | 2 | 3}
                      content={e.content}
                      kbRefs={e.kbRefs}
                    />
                  </motion.div>
                  <div
                    className={cn(
                      'mt-1 font-mono text-[10px] text-ink-muted',
                      isVer ? 'text-right' : 'text-left',
                    )}
                  >
                    {formatWallTime(base, e.t)}
                  </div>
                </div>
              );
            })}

            {typingAgent && <TypingDots side={typingAgent === 'GEN-03' ? 'left' : 'right'} />}
          </div>
        </div>

        {/* 右栏：diff 修订视图 */}
        <div className="lg:col-span-7">
          <div className="lf-card flex h-full flex-col p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-3">
              <div>
                <div className="lf-mono-label !text-[10.5px]">DRAFT DIFF</div>
                <div className="mt-0.5 text-[14px] font-semibold text-ink">
                  {script.resourceTitle} · v1 → v2
                </div>
              </div>
              <Tabs value={tab} onValueChange={(v) => setTab(v as 'diff' | 'final')}>
                <TabsList className="h-8 border border-hairline bg-paper">
                  <TabsTrigger value="diff" className="px-3 text-[12.5px]">对照</TabsTrigger>
                  <TabsTrigger value="final" className="px-3 text-[12.5px]">终稿</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="flex-1 pt-4"
              >
                {tab === 'diff' ? (
                  <div className="space-y-5">
                    {visibleRounds.length === 0 && (
                      <div className="flex h-[160px] items-center justify-center rounded-[10px] border border-dashed border-hairline px-8 text-center text-[13px] leading-[20px] text-ink-muted">
                        等待审核意见 —— VER-04 质询与 GEN-03 修订将以 v1→v2 对照形式留痕
                      </div>
                    )}
                    {visibleRounds.map((r, ri) => (
                      <motion.div
                        key={r.round}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.35, ease: easeLf, delay: ri * 0.2 }}
                      >
                        <div className="mb-2 flex items-center gap-2">
                          <span className="rounded-md border border-hairline bg-paper px-1.5 py-px font-mono text-[10.5px] font-semibold text-ink-2">
                            R{r.round}
                          </span>
                          <span className="text-[13px] font-medium text-ink">{r.section}</span>
                        </div>
                        <div className="space-y-1.5">
                          {r.removed.map((line) => (
                            <div
                              key={line}
                              className="rounded-lg border border-brand-danger/30 bg-brand-danger/[0.07] px-3 py-2 text-[13px] leading-[20px] text-brand-danger"
                            >
                              <span className="mr-2 font-mono text-[11px] font-semibold">-</span>
                              <span className="line-through opacity-90">{line}</span>
                            </div>
                          ))}
                          <div className="flex justify-center py-0.5">
                            <ArrowDown size={13} className="text-ink-muted" />
                          </div>
                          {r.added.map((line) => (
                            <div
                              key={line.text}
                              className="rounded-lg border border-brand/30 bg-brand-tint/60 px-3 py-2 text-[13px] leading-[20px] text-ink-2"
                            >
                              <span className="mr-2 font-mono text-[11px] font-semibold text-brand">+</span>
                              {line.text}
                              {line.kbs.map((id) => (
                                <TraceBadge key={id} kbId={id} className="ml-1.5" />
                              ))}
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {visibleRounds.length === 0 && (
                      <div className="flex h-[160px] items-center justify-center rounded-[10px] border border-dashed border-hairline px-8 text-center text-[13px] leading-[20px] text-ink-muted">
                        终稿将在 GEN-03 完成修订、VER-04 复核通过后定稿
                      </div>
                    )}
                    {visibleRounds.map((r) => (
                      <div
                        key={r.round}
                        className="rounded-lg border border-hairline bg-paper px-3.5 py-2.5"
                      >
                        <div className="mb-1 font-mono text-[10.5px] text-ink-muted">{r.section}</div>
                        {r.added.map((line) => (
                          <p key={line.text} className="text-[13.5px] leading-[22px] text-ink-2">
                            {line.text}
                            {line.kbs.map((id) => (
                              <TraceBadge key={id} kbId={id} className="ml-1.5" />
                            ))}
                          </p>
                        ))}
                      </div>
                    ))}
                    {verdictDone && (
                      <motion.div
                        initial={{ scale: 0.92, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: 'spring', stiffness: 260, damping: 20 }}
                        className="flex items-center gap-2 rounded-lg border border-brand/40 bg-brand-tint px-3.5 py-2.5 text-[13px] font-medium text-brand"
                      >
                        <BadgeCheck size={15} />
                        VER-04 复核通过 · 全部引用可溯源 · 幻觉风险 0
                      </motion.div>
                    )}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>

            <div className="mt-4 border-t border-hairline pt-3 font-mono text-[11px] text-ink-muted">
              -{removedTotal} 处问题表述 · +{citedKbs.size} 条权威引用 · 幻觉拦截 {blockedCount} 处 · 幻觉风险{' '}
              {verdictDone ? '0' : '核验中…'}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
