/**
 * 导学右栏状态卡组（tutoring.md S4）
 * 1. 本轮状态卡：ECharts 环形正确率仪表 + 答题走势迷你图 + 难度 L1-L5 刻度（决策触发指针 tween）
 * 2. 决策历史卡：种子条目 + 实时条目顶部插入（layout 弹簧）
 * 3. 本节知识点卡：掌握度细环 chips，点击卡头展开复述全文 + 溯源角标 + 快捷入口（accordion）
 * 4. CTA → /report
 */
import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronDown, Gauge, History, ListChecks, MessageCircle, Scale } from 'lucide-react';
import { ReactECharts } from '@/components/ChartCard';
import TraceBadge from '@/components/TraceBadge';
import type { DecisionEvent } from './engine';
import { cn } from '@/lib/utils';

/** 统一缓动曲线（design.md 动效规范） */
const easeLf = [0.22, 1, 0.36, 1] as [number, number, number, number];

/** 掌握度细环（SVG 圆环进度） */
export function MasteryRing({ value, size = 30 }: { value: number; size?: number }) {
  const r = (size - 5) / 2;
  const c = 2 * Math.PI * r;
  const color = value >= 75 ? '#6BA080' : value >= 55 ? '#E7B45A' : '#B0483B';
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#EAF1EA" strokeWidth={3} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - value / 100) }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      <span className="absolute font-mono text-[8.5px] font-semibold tabular" style={{ color }}>
        {Math.round(value)}
      </span>
    </span>
  );
}

export interface KpTopic {
  topic: string;
  mastery: number;
  recapText: string;
  kbRef?: string;
}

/**
 * 答题走势迷你图（手绘 SVG，非 ECharts）
 * 最近 10 题的对错点列（墨绿=对 / 砖红=错）+ 累计正确率折线
 * answers 为空/未传 → 占位提示
 */
function AnswerTrend({ answers }: { answers?: boolean[] }) {
  const reduce = useReducedMotion();
  if (!answers || answers.length === 0) {
    return (
      <p className="mt-3 rounded-[8px] border border-dashed border-hairline px-2.5 py-2 text-center font-mono text-[10.5px] text-ink-muted">
        答题走势 · 尚未作答
      </p>
    );
  }

  const recent = answers.slice(-10);
  const correctTotal = answers.filter(Boolean).length;
  /* recent 区间内的滚动累计正确率（衔接 recent 之前的历史基数，折线不失真） */
  const priorAsked = answers.length - recent.length;
  const priorCorrect = answers.slice(0, priorAsked).filter(Boolean).length;
  const cumAcc = recent.map(
    (_, i) => (priorCorrect + recent.slice(0, i + 1).filter(Boolean).length) / (priorAsked + i + 1),
  );

  const barW = 8;
  const gap = 4;
  const barH = 20;
  const H = 26;
  const width = recent.length * (barW + gap) - gap;
  const points = cumAcc.map((v, i) => `${i * (barW + gap) + barW / 2},${(H - barH) + barH * (1 - v)}`).join(' ');

  return (
    <div className="mt-3 rounded-[8px] border border-hairline bg-paper px-2.5 py-2.5">
      <div className="flex items-center justify-between font-mono text-[10px] text-ink-muted">
        <span>答题走势 · 最近 {recent.length} 题</span>
        <span className="tabular text-ink-2">{correctTotal}/{answers.length}</span>
      </div>
      <svg width={width} height={H} className="mt-1.5 block overflow-visible">
        {recent.map((a, i) => (
          <motion.rect
            key={i}
            x={i * (barW + gap)}
            y={H - barH}
            width={barW}
            height={barH}
            rx={2}
            fill={a ? '#4E7860' : '#B0483B'}
            initial={reduce ? { opacity: 1, scaleY: 1 } : { opacity: 0, scaleY: 0.2 }}
            animate={{ opacity: 1, scaleY: 1 }}
            style={{ transformOrigin: `${i * (barW + gap) + barW / 2}px ${H}px` }}
            transition={{ duration: 0.32, delay: reduce ? 0 : i * 0.035, ease: easeLf }}
          />
        ))}
        <motion.polyline
          points={points}
          fill="none"
          stroke="#B77552"
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={reduce ? { opacity: 0.9 } : { opacity: 0 }}
          animate={{ opacity: 0.9 }}
          transition={{ duration: 0.4, delay: reduce ? 0 : 0.32, ease: easeLf }}
        />
      </svg>
      <p className="mt-1 font-mono text-[9.5px] text-ink-muted">
        走势 {recent.map((a) => (a ? '✓' : '✗')).join('')}
      </p>
    </div>
  );
}

export default function SidePanel({
  asked,
  correct,
  level,
  decisions,
  topics,
  onRecap,
  answers,
}: {
  asked: number;
  correct: number;
  level: number;
  decisions: DecisionEvent[];
  topics: KpTopic[];
  onRecap: (t: KpTopic) => void;
  /** 本轮答题对错序列（按作答顺序），供「答题走势」迷你图使用；未传则显示占位 */
  answers?: boolean[];
}) {
  const acc = asked > 0 ? Math.round((correct / asked) * 100) : 0;
  const accColor = acc >= 80 ? '#6BA080' : acc >= 60 ? '#E7B45A' : asked === 0 ? '#4E7860' : '#B0483B';
  /* 本节知识点卡：手风琴展开，同时只展开一个 */
  const [expandedTopic, setExpandedTopic] = useState<string | null>(null);

  const gaugeOption = {
    series: [
      {
        type: 'gauge',
        startAngle: 210,
        endAngle: -30,
        min: 0,
        max: 100,
        radius: '96%',
        center: ['50%', '64%'],
        progress: { show: true, width: 9, roundCap: true, itemStyle: { color: accColor } },
        axisLine: { roundCap: true, lineStyle: { width: 9, color: [[1, '#EAF1EA']] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        pointer: { show: false },
        detail: {
          valueAnimation: true,
          fontSize: 25,
          fontFamily: 'Fraunces, serif',
          fontWeight: 600,
          color: '#3D4A3A',
          offsetCenter: [0, '-12%'],
          formatter: '{value}%',
        },
        data: [{ value: acc }],
        animationDurationUpdate: 600,
      },
    ],
  };

  const history = [
    ...decisions.map((d) => ({
      id: d.id,
      time: d.time,
      label: d.label,
      reason: d.reason,
      confidence: d.confidence,
      live: true,
      tone: d.type === 'challenge' ? '#B77552' : '#4E7860',
    })),
    {
      id: 'seed-1',
      time: '10:31:40',
      label: '路径重排',
      reason: '实操指南前置，优先补齐实操短板',
      confidence: 0.88,
      live: false,
      tone: '#5A6553',
    },
  ];

  return (
    <div className="space-y-4">
      {/* 本轮状态 */}
      <div className="lf-card p-5">
        <div className="lf-mono-label flex items-center gap-1.5">
          <Gauge size={12} /> SESSION · 本轮状态
        </div>
        <div className="-mb-2 -mt-3">
          <ReactECharts option={gaugeOption} height={148} />
        </div>
        <div className="text-center font-mono text-[11.5px] text-ink-muted tabular">
          已答 {asked} 题 · 对 {correct}
        </div>

        {/* 答题走势迷你图 */}
        <AnswerTrend answers={answers} />

        {/* 难度刻度 L1-L5 */}
        <div className="mt-4">
          <div className="flex items-center justify-between font-mono text-[10.5px] text-ink-muted">
            <span>难度 LEVEL</span>
            <span className="font-semibold text-brand">L{level}</span>
          </div>
          <div className="relative mt-1.5 flex gap-1">
            {[1, 2, 3, 4, 5].map((l) => (
              <span
                key={l}
                className={cn(
                  'h-2 flex-1 rounded-full transition-colors duration-300',
                  l <= level ? 'bg-brand' : 'bg-paper-deep',
                )}
              />
            ))}
            <motion.span
              className="absolute -top-1 h-4 w-[3px] rounded-full bg-brand-amber"
              initial={false}
              animate={{ left: `calc(${((level - 0.5) / 5) * 100}% - 1.5px)` }}
              transition={{ type: 'spring', stiffness: 200, damping: 20 }}
            />
          </div>
          <div className="mt-1 flex justify-between font-mono text-[9px] text-ink-muted">
            <span>L1</span>
            <span>L5</span>
          </div>
        </div>
      </div>

      {/* 决策历史 */}
      <div className="lf-card p-5">
        <div className="lf-mono-label flex items-center gap-1.5">
          <History size={12} /> DECISIONS · 决策历史
        </div>
        <ul className="mt-3 space-y-2">
          {history.map((h) => (
            <motion.li
              key={h.id}
              layout="position"
              initial={{ opacity: 0, y: -10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 260, damping: 22 }}
              className={cn(
                'rounded-[10px] border p-2.5',
                h.live ? 'border-brand/30 bg-brand-tint/40' : 'border-hairline bg-paper',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10.5px] text-ink-muted tabular">{h.time}</span>
                <span
                  className="rounded-md border px-1.5 py-px font-mono text-[10px] font-semibold"
                  style={{ color: h.tone, borderColor: `${h.tone}50`, backgroundColor: `${h.tone}0D` }}
                >
                  {h.label}
                </span>
                {h.live && (
                  <span className="ml-auto font-mono text-[9.5px] uppercase tracking-wider text-brand">
                    LIVE
                  </span>
                )}
              </div>
              <p className="mt-1 text-[12px] leading-[18px] text-ink-2">{h.reason}</p>
              <p className="mt-0.5 flex items-center gap-1 font-mono text-[10px] text-ink-muted">
                <Scale size={10} /> 置信 {h.confidence.toFixed(2)}
              </p>
            </motion.li>
          ))}
        </ul>
      </div>

      {/* 本节知识点：点击卡头展开复述全文（accordion，同时只展开一个） */}
      <div className="lf-card p-5">
        <div className="lf-mono-label">FOCUS · 本节知识点</div>
        <div className="mt-3 space-y-2">
          {topics.map((t) => {
            const isOpen = expandedTopic === t.topic;
            return (
              <div
                key={t.topic}
                className={cn(
                  'overflow-hidden rounded-[10px] border transition-colors duration-200',
                  isOpen ? 'border-brand/40 bg-brand-tint/30' : 'border-hairline bg-paper',
                )}
              >
                <button
                  type="button"
                  onClick={() => setExpandedTopic(isOpen ? null : t.topic)}
                  title="点击展开该知识点详情"
                  aria-expanded={isOpen}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-200 hover:bg-brand-tint/20"
                >
                  <MasteryRing value={t.mastery} size={26} />
                  <span className="flex-1 truncate text-[12.5px] font-medium text-ink-2">{t.topic}</span>
                  <motion.span
                    animate={{ rotate: isOpen ? 180 : 0 }}
                    transition={{ duration: 0.25, ease: easeLf }}
                    className="shrink-0 text-ink-muted"
                  >
                    <ChevronDown size={14} />
                  </motion.span>
                </button>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      key="content"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.32, ease: easeLf }}
                      className="overflow-hidden"
                    >
                      <div className="border-t border-hairline px-2.5 pb-2.5 pt-2">
                        <p className="text-[12px] leading-[19px] text-ink-2">
                          {t.recapText}
                          {t.kbRef && <TraceBadge kbId={t.kbRef} className="ml-1" />}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => onRecap(t)}
                            className="lf-btn-ghost !px-2.5 !py-1.5 text-[11.5px]"
                          >
                            <MessageCircle size={12} /> 让老师复述
                          </button>
                          <Link to="/resources?tab=quiz" className="lf-btn-ghost !px-2.5 !py-1.5 text-[11.5px]">
                            <ListChecks size={12} /> 去针对练习
                          </Link>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
        <p className="mt-2.5 font-mono text-[10px] text-ink-muted">点击卡头展开详情，可让导师复述或去做针对练习</p>
      </div>

      {/* CTA */}
      <Link
        to="/report"
        className="lf-card lf-card-hover flex items-center justify-between p-4 text-[13.5px] font-medium text-brand"
      >
        查看学情报告 <ArrowRight size={15} />
      </Link>
    </div>
  );
}
