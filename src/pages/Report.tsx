import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  BookOpen,
  CalendarRange,
  CheckCircle2,
  CircleDashed,
  Clock3,
  FileDown,
  History,
  Loader2,
  Route,
  Sparkles,
  Target,
} from 'lucide-react';
import { toast } from 'sonner';
import PageBack from '@/components/PageBack';
import SectionHeader from '@/components/SectionHeader';
import { ReactECharts } from '@/components/ChartCard';
import { useProfile } from '@/context/ProfileContext';
import { useCourseLearning } from '@/hooks/useCourseLearning';
import { useLearningMap } from '@/hooks/useLearningMap';
import { api } from '@/lib/api';
import { CHAPTER_ABILITY_WEIGHTS, deriveAbilityScores } from '@/lib/abilityAdjust';
import type { AbilityDimension } from '@/lib/abilityAdjust';
import { cn } from '@/lib/utils';
import { learnMapPath } from '@/lib/learnNav';
import {
  readLearnerAnalytics,
  writeLearnerAnalytics,
  readLearnerJournal,
  writeLearnerJournal,
  bustLearnerJournal,
} from '@/lib/dataCache';
import type { LearnerAnalyticsProfile, LearnerGrowth, LearningJournal, OnboardingKnowledgePoint } from '@/lib/api';
import GapSection from '@/components/report/GapSection';
import DifficultyMatch from '@/components/report/DifficultyMatch';
import PathRoadmap from '@/components/report/PathRoadmap';
import GrowthSection from '@/components/report/GrowthSection';
import ScoreBand from '@/components/report/ScoreBand';
import StreakCalendar from '@/components/StreakCalendar';
import type { BlindSpot, LearnerReport, PathNodeStatus } from '@/data/reportData';
import { knowledgePoints, getKnowledgePoint } from '@/data/knowledgePoints';

const resourceLabel = { lecture: '讲义', practice: '实操', quiz: '分阶题' } as const;

function localDateKey(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 日期范围约束：最多 7 天（含首尾），且不早于/晚于边界 */
function clampRange(start: string, end: string): { start: string; end: string } {
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return { start, end };
  if (s > e) return { start: end, end };
  const days = Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
  if (days > 7) {
    const ns = new Date(e);
    ns.setDate(ns.getDate() - 6);
    return { start: toDateKey(ns), end };
  }
  return { start, end };
}

interface EvidenceItem {
  id: string;
  kind: string;
  occurredAt: string;
  title: string;
  description: string;
  knowledgeName?: string | null;
  correctCount?: number | null;
  wrongCount?: number | null;
}

const NODE_COLORS: Record<string, { ring: string; dot: string }> = {
  focus: { ring: '#4B82B8', dot: '#4B82B8' },
  resource: { ring: '#D89238', dot: '#D89238' },
  quiz: { ring: '#B17818', dot: '#B17818' },
  chat: { ring: '#4E7860', dot: '#4E7860' },
  knowledge: { ring: '#9AA19A', dot: '#9AA19A' },
};

/** 节点上方动作短语（≤5 字）：按标题关键词提取，避免整段文字堆在路径上 */
function shortAction(ev: EvidenceItem): string {
  const title = ev.title ?? '';
  if (/讲义|阅读|打开|学习一项资源/.test(title)) return '学习资源';
  if (/实操|实践|动手/.test(title)) return '动手实操';
  if (/测试|测评|答题|答对|题/.test(title)) return '做分阶题';
  if (/笔记/.test(title)) return '记笔记';
  if (/导学|提问|问答|对话/.test(title)) return '导学问答';
  if (/成长|画像|校准/.test(title)) return '画像更新';
  if (/专注|讲播|听完/.test(title)) return '专注学习';
  return (evidenceMeta[ev.kind] ?? evidenceMeta.knowledge).label;
}

/** 十六进制颜色转 rgba（节点外发光呼吸效果用） */
function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface SplinePoint {
  x: number;
  y: number;
  ev: EvidenceItem;
  align: 'left' | 'right' | 'center';
}

/** 由节点位置生成一条完全连贯、平滑拐弯的 S 形 SVG 路径 */
function buildSplineLayout(items: EvidenceItem[], perRow: number, width: number): { points: SplinePoint[]; pathD: string; height: number } {
  const TOP = 34;
  const ROW_H = 84;
  const SIDE_PAD = 58;
  const w = Math.max(width, 320);
  const dx = perRow > 1 ? (w - SIDE_PAD * 2) / (perRow - 1) : 0;
  const points: SplinePoint[] = [];
  const rows = Math.ceil(items.length / perRow);
  for (let r = 0; r < rows; r++) {
    const row = items.slice(r * perRow, r * perRow + perRow);
    const y = TOP + r * ROW_H;
    row.forEach((ev, j) => {
      const col = r % 2 === 0 ? j : perRow - 1 - j;
      points.push({
        x: SIDE_PAD + col * dx,
        y,
        ev,
        align: col === 0 ? 'left' : col === perRow - 1 ? 'right' : 'center',
      });
    });
  }
  const EXT = 18;
  let d = '';
  /* 线头尾各向外延伸一段，超出首尾节点 */
  d = `M ${(points[0].x - EXT).toFixed(1)} ${points[0].y.toFixed(1)} L ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const prev = points[i - 1];
    if (Math.abs(p.y - prev.y) < 1) {
      d += ` L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    } else {
      /* 行尾 180° 圆弧转弯：起点/终点切线与行内直线连续，S 曲线整体平滑无硬角 */
      const radius = (p.y - prev.y) / 2;
      const sweep = p.x > w / 2 ? 1 : 0;
      d += ` A ${radius.toFixed(1)} ${radius.toFixed(1)} 0 0 ${sweep} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    }
  }
  /* 末行方向决定尾部延伸方向：偶数行向右，奇数行向左 */
  const last = points[points.length - 1];
  const lastRowEven = (rows - 1) % 2 === 0;
  d += ` L ${(last.x + (lastRowEven ? EXT : -EXT)).toFixed(1)} ${last.y.toFixed(1)}`;
  return { points, pathD: d, height: TOP + rows * ROW_H + 18 };
}

/** S 形路径上的圆形节点：圆 + 上（动作）/下（时间）两行字，详情放 hover 悬浮卡 */
function SPathNode({ pt }: { pt: SplinePoint }) {
  const ev = pt.ev;
  const meta = evidenceMeta[ev.kind] ?? evidenceMeta.knowledge;
  const colors = NODE_COLORS[ev.kind] ?? NODE_COLORS.knowledge;
  return (
    <div className="group absolute z-10 -translate-x-1/2 -translate-y-1/2" style={{ left: pt.x, top: pt.y }}>
      {/* 悬浮详情卡：参考 3D 悬浮卡片风格，仅 hover 出现 */}
      <div className={cn(
        'pointer-events-none absolute bottom-full mb-2 hidden w-60 rounded-[14px] border border-[#E1E6DF] bg-white/95 p-3.5 shadow-[0_12px_30px_rgba(41,63,51,0.16)] backdrop-blur-sm group-hover:block',
        pt.align === 'left' ? 'left-0' : pt.align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2',
      )}>
        <div className="flex items-center gap-2">
          <span className={cn('rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium', meta.cls)}>{meta.label}</span>
          <span className="font-mono text-[10.5px] text-ink-muted">{evidenceTime(ev.occurredAt)}</span>
        </div>
        <div className="mt-1.5 text-[13px] font-semibold leading-snug text-[#24332B]">{ev.title}</div>
        {ev.description && <p className="mt-1 text-[12px] leading-5 text-ink-muted">{ev.description}</p>}
        {(ev.knowledgeName || ev.correctCount != null) && (
          <div className="mt-1.5 flex flex-wrap gap-1.5 font-mono text-[10.5px] text-ink-muted">
            {ev.knowledgeName && <span className="rounded-md bg-paper-deep px-1.5 py-0.5">{ev.knowledgeName}</span>}
            {ev.correctCount != null && <span className="rounded-md bg-paper-deep px-1.5 py-0.5">答对 {ev.correctCount} · 答错 {ev.wrongCount ?? 0}</span>}
          </div>
        )}
      </div>
      <div className="flex flex-col items-center">
        <span className="mb-1.5 max-w-[72px] truncate text-[10px] font-medium text-ink">{shortAction(ev)}</span>
        <motion.span
          className="block h-6 w-6 rounded-full border border-white/70 group-hover:scale-110"
          style={{ backgroundColor: colors.dot }}
          animate={{ boxShadow: [
            `0 0 0 0 ${hexToRgba(colors.dot, 0.4)}`,
            `0 0 12px 3px ${hexToRgba(colors.dot, 0.55)}`,
            `0 0 0 0 ${hexToRgba(colors.dot, 0.4)}`,
          ] }}
          transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut' }}
        />
        <span className="mt-1.5 whitespace-nowrap font-mono text-[9px] text-ink-muted">{evidenceTime(ev.occurredAt)}</span>
      </div>
    </div>
  );
}

const evidenceMeta: Record<string, { label: string; cls: string }> = {
  focus: { label: '专注', cls: 'border-brand/30 bg-brand-tint text-brand' },
  resource: { label: '资源', cls: 'border-ochre/40 bg-ochre-tint text-ochre' },
  quiz: { label: '测评', cls: 'border-brand-amber/50 bg-brand-amber-tint text-ochre' },
  chat: { label: '导学', cls: 'border-brand/30 bg-brand-tint text-brand' },
  knowledge: { label: '画像', cls: 'border-hairline bg-paper-deep text-ink-muted' },
};

function evidenceTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** HTML 转义，避免用户数据里的特殊字符破坏模板 */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 生成自包含 HTML 报告（内联样式，可离线打开/打印/转 Word） */
function buildReportHtml(data: {
  learnerName: string;
  generatedAt: string;
  overallMastery: number;
  totalMinutes: number;
  streakDays: number;
  accuracy: number | null;
  accuracyDetail: string;
  abilities: { name: string; score: number }[];
  weakestChapter: string | null;
  weakestDetail: string;
  courseTitle: string | null;
  courseProgress: number;
  chapters: { index: number; title: string; learned: number; total: number; mastery: number; target: number }[];
  weeklyLabels: string[];
  weeklyMinutes: number[];
  journalStats: { questions: number; correct: number; durationMinutes: number; resources: number };
  todaySummary: string | null;
  quizzes: { name: string; type: string; score: string; time: string }[];
  evidence: { label: string; time: string; title: string; description: string }[];
}): string {
  const card = (label: string, value: string, note: string) =>
    `<div class="card"><div class="card-label">${esc(label)}</div><div class="card-value">${esc(value)}</div><div class="card-note">${esc(note)}</div></div>`;

  const abilityRows = data.abilities.map((a) => `
        <div class="row">
          <div class="row-label">${esc(a.name)}</div>
          <div class="bar"><div class="bar-fill" style="width:${Math.max(0, Math.min(100, a.score))}%"></div></div>
          <div class="row-value">${esc(a.score)}</div>
        </div>`).join('');

  const chapterRows = data.chapters.map((c) => {
    const pct = Math.max(0, Math.min(100, c.mastery));
    const targetPct = Math.max(0, Math.min(100, c.target));
    const done = c.total > 0 && c.learned === c.total ? ' ✓' : '';
    return `
        <div class="chapter">
          <div class="chapter-head"><strong>${esc(c.index)}. ${esc(c.title)}${done}</strong><span>${esc(c.learned)}/${esc(c.total)} 资源 · 掌握 ${esc(c.mastery)}%${c.target > 0 ? ` · 目标 ${esc(c.target)}%` : ''}</span></div>
          <div class="bar"><div class="bar-fill" style="width:${pct}%"></div><div class="bar-threshold" style="left:${targetPct}%"></div></div>
        </div>`;
  }).join('');

  const maxMinutes = Math.max(1, ...data.weeklyMinutes);
  const weekBars = data.weeklyMinutes.map((m, i) => `
        <div class="week-col"><div class="week-bar" style="height:${Math.max(2, Math.round((m / maxMinutes) * 120))}px"></div><div class="week-label">${esc(data.weeklyLabels[i] ?? '')}</div><div class="week-value">${esc(m)}</div></div>`).join('');

  const quizRows = data.quizzes.map((q) => `
        <div class="row"><span class="row-label">${esc(q.name)}</span><span class="row-note">${esc(q.type)} · ${esc(q.time)}</span><span class="row-value">${esc(q.score)}</span></div>`).join('');

  const evidenceRows = data.evidence.map((e) => `
        <div class="evidence"><span class="tag">${esc(e.label)}</span><span class="ev-time">${esc(e.time)}</span><div class="ev-title">${esc(e.title)}</div><div class="ev-desc">${esc(e.description)}</div></div>`).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>学习成长报告 · ${esc(data.learnerName)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #F4F2EB; color: #33403A; font-family: "PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif; }
  .page { max-width: 860px; margin: 24px auto; background: #FFFFFF; border-radius: 16px; padding: 40px 48px; box-shadow: 0 10px 30px rgba(60,80,70,0.08); }
  h1 { font-size: 26px; margin: 0 0 4px; color: #2E5C46; }
  .sub { color: #7A877F; font-size: 13px; margin-bottom: 24px; }
  h2 { font-size: 17px; margin: 28px 0 12px; color: #2E5C46; border-left: 4px solid #4E7860; padding-left: 10px; }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .card { border: 1px solid #E3E8E1; border-radius: 12px; padding: 14px; background: #FBFCF9; }
  .card-label { font-size: 11px; color: #7A877F; }
  .card-value { font-size: 22px; font-weight: 700; margin: 6px 0 2px; color: #2E5C46; }
  .card-note { font-size: 11px; color: #9AA49C; }
  .row { display: flex; align-items: center; gap: 12px; padding: 7px 0; border-bottom: 1px dashed #EDF0EB; font-size: 13px; }
  .row-label { width: 150px; flex-shrink: 0; color: #44524B; }
  .row-note { flex: 1; color: #8A958D; font-size: 11.5px; }
  .row-value { width: 70px; text-align: right; font-weight: 600; color: #2E5C46; }
  .bar { position: relative; flex: 1; height: 10px; border-radius: 6px; background: #EEF2EC; overflow: visible; }
  .bar-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 6px; background: #4E7860; }
  .bar-threshold { position: absolute; top: -2px; bottom: -2px; width: 3px; background: #155E9A; border-radius: 2px; }
  .chapter { padding: 8px 0; border-bottom: 1px dashed #EDF0EB; }
  .chapter-head { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 6px; color: #44524B; }
  .chapter-head span { font-size: 11.5px; color: #8A958D; }
  .week { display: flex; align-items: flex-end; gap: 14px; height: 150px; padding-top: 10px; }
  .week-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 4px; }
  .week-bar { width: 60%; border-radius: 6px 6px 0 0; background: #4E7860; }
  .week-label { font-size: 10px; color: #8A958D; }
  .week-value { font-size: 10.5px; color: #2E5C46; font-weight: 600; }
  .summary { border: 1px solid #E3E8E1; background: #F7FAF6; border-radius: 12px; padding: 14px 16px; font-size: 13px; line-height: 1.8; color: #44524B; }
  .evidence { border-left: 3px solid #4E7860; padding: 6px 0 6px 12px; margin-bottom: 10px; }
  .tag { display: inline-block; border: 1px solid #C9D8CE; border-radius: 6px; padding: 1px 8px; font-size: 10.5px; color: #2E5C46; background: #F0F6F1; }
  .ev-time { margin-left: 8px; font-size: 10.5px; color: #9AA49C; }
  .ev-title { font-size: 13px; font-weight: 600; margin-top: 4px; color: #33403A; }
  .ev-desc { font-size: 12px; color: #7A877F; margin-top: 2px; }
  .footer { margin-top: 32px; padding-top: 14px; border-top: 1px solid #E3E8E1; font-size: 11px; color: #9AA49C; text-align: center; }
  @media (max-width: 640px) { .page { padding: 20px 16px; } .cards { grid-template-columns: repeat(2, 1fr); } .row-label { width: 110px; } }
  @media print { body { background: #fff; } .page { box-shadow: none; margin: 0; border-radius: 0; } }
</style>
</head>
<body>
<div class="page">
  <h1>学习成长报告 · ${esc(data.learnerName)}</h1>
  <div class="sub">生成时间：${esc(data.generatedAt)} · 数据来源：后端真实学习记录</div>

  <h2>总体概览</h2>
  <div class="cards">
    ${card('实测综合掌握度', `${data.overallMastery}%`, '按真实学习证据计算')}
    ${card('累计学习投入', data.totalMinutes >= 60 ? `${Math.floor(data.totalMinutes / 60)} 小时 ${data.totalMinutes % 60} 分` : `${data.totalMinutes} 分钟`, '按学习会话统计')}
    ${card('连续学习', `${data.streakDays} 天`, '按每日学习会话统计')}
    ${card('近 7 天测评正确率', data.accuracy == null ? '暂无' : `${data.accuracy}%`, data.accuracy == null ? '尚无真实测评提交' : data.accuracyDetail)}
  </div>

  ${data.weakestChapter ? `<h2>重点建议</h2><div class="summary">${esc(data.weakestDetail)}</div>` : ''}

  ${data.abilities.length ? `<h2>六维能力画像</h2>${abilityRows}` : ''}

  ${data.chapters.length ? `<h2>真实课程学习路径</h2>${chapterRows}` : ''}

  <h2>近 7 天学习时长（分钟）</h2>
  <div class="week">${weekBars}</div>
  <div class="summary" style="margin-top:12px">近 7 天共作答 ${esc(data.journalStats.questions)} 题、答对 ${esc(data.journalStats.correct)} 题，学习 ${esc(data.journalStats.durationMinutes)} 分钟，记录资源 ${esc(data.journalStats.resources)} 项。${data.todaySummary ? `今日总结：${esc(data.todaySummary)}` : ''}</div>

  ${data.quizzes.length ? `<h2>最近测评证据</h2>${quizRows}` : ''}

  ${data.evidence.length ? `<h2>近 7 天真实学习记录</h2>${evidenceRows}` : ''}

  <div class="footer">本报告由智训云枢 LearnForge 基于真实学习记录生成 · 仅用于个人学习复盘</div>
</div>
</body>
</html>`;
}

/* 旧档案分 key → 当前六维 key 的兜底映射（与「我的画像」页一致） */
const LEGACY_KP_IDS: Record<string, string> = {
  'kp-ds': 'kp-plc',
  'kp-co': 'kp-kinematics',
  'kp-os': 'kp-sensor',
  'kp-network': 'kp-vision',
  'kp-db': 'kp-safety',
  'kp-agent': 'kp-diagnosis',
};

function displayMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function radarOption(kps: OnboardingKnowledgePoint[], scores: Record<string, number>) {
  return {
    animationDuration: 700,
    tooltip: { trigger: 'item' as const },
    radar: {
      indicator: kps.map((kp) => ({ name: kp.name, max: 100 })),
      radius: '65%',
      center: ['50%', '51%'] as [string, string],
      axisName: { color: '#5A6553', fontSize: 11 },
      splitLine: { lineStyle: { color: '#E9E3D4' } },
      splitArea: { areaStyle: { color: ['rgba(253,252,249,0)', 'rgba(240,235,224,0.45)'] } },
      axisLine: { lineStyle: { color: '#DCE6DE' } },
    },
    legend: { bottom: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8 },
    series: [{
      type: 'radar' as const,
      data: [
        {
          value: kps.map((kp) => scores[kp.id] ?? 50), name: '当前画像', symbolSize: 4,
          lineStyle: { color: '#4E7860', width: 2.5 },
          itemStyle: { color: '#4E7860' }, areaStyle: { color: 'rgba(78,120,96,0.22)' },
        },
      ],
    }],
  };
}

function weeklyOption(values: number[]) {
  const labels = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    return `${date.getMonth() + 1}/${date.getDate()}`;
  });
  return {
    animationDuration: 700,
    grid: { left: 36, right: 12, top: 24, bottom: 28 },
    tooltip: { trigger: 'axis' as const, formatter: (items: { axisValue: string; value: number }[]) => `${items[0]?.axisValue}<br/>学习 ${items[0]?.value ?? 0} 分钟` },
    xAxis: { type: 'category' as const, data: labels, axisLine: { lineStyle: { color: '#D8D1C1' } }, axisTick: { show: false }, axisLabel: { color: '#7B8475', fontSize: 10 } },
    yAxis: { type: 'value' as const, minInterval: 10, axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: '#EEE9DF' } }, axisLabel: { color: '#8B9387', fontSize: 10 } },
    series: [{
      type: 'bar' as const, data: values, barMaxWidth: 28,
      itemStyle: { color: '#4E7860', borderRadius: [6, 6, 0, 0] },
      showBackground: true, backgroundStyle: { color: 'rgba(78,120,96,0.07)', borderRadius: [6, 6, 0, 0] },
    }],
  };
}

export default function Report() {
  const navigate = useNavigate();
  const location = useLocation();
  const { currentLearner, domainKnowledgePoints } = useProfile();
  const { loading: courseLoading, course, resources, nextResource, nextChapter, learnedCount, totalCount, progress } = useCourseLearning();
  const learningMap = useLearningMap();
  const [analytics, setAnalytics] = useState<LearnerAnalyticsProfile | null>(null);
  const [journals, setJournals] = useState<LearningJournal[]>([]);
  const [growth, setGrowth] = useState<LearnerGrowth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summarizing, setSummarizing] = useState(false);
  /** 真实学习记录：可选择日期范围（最多 7 天） */
  const [rangeStart, setRangeStart] = useState(localDateKey(6));
  const [rangeEnd, setRangeEnd] = useState(localDateKey(0));
  const [rangeJournals, setRangeJournals] = useState<LearningJournal[]>([]);
  const [rangeLoading, setRangeLoading] = useState(false);
  /** 后台静默刷新：先展示缓存，拉取最新数据后自动更新 */
  const [refreshing, setRefreshing] = useState(false);
  const refreshSeqRef = useRef(0);
  /** 匹配报告速览当前展开的模块 */
  const [activeMatchTab, setActiveMatchTab] = useState<'score' | 'gap' | 'difficulty' | 'path'>('score');
  /** S 形路径每行节点数：按屏幕宽度自适应（4–8 个） */
  const [perRow, setPerRow] = useState(6);
  useEffect(() => {
    const update = () => {
      const width = window.innerWidth;
      setPerRow(width >= 1440 ? 8 : width >= 1024 ? 6 : width >= 640 ? 5 : 4);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const pathRef = useRef<HTMLDivElement>(null);
  const [pathWidth, setPathWidth] = useState(0);
  useEffect(() => {
    const el = pathRef.current;
    if (!el) return;
    const update = () => setPathWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
    /* 记录渲染完成后容器才存在，必须在数据出现后再测量，否则节点会挤在左侧 */
  }, [rangeJournals.length, rangeStart, rangeEnd]);

  /** 后台刷新整个时间窗：拉取最新数据后自动更新并写回缓存（并发用 seq 丢弃过期响应） */
  const refreshReportData = useCallback(async (dates: string[]) => {
    const seq = ++refreshSeqRef.current;
    setRefreshing(true);
    const learnerId = currentLearner.id;
    try {
      const [profile, learnerGrowth, ...freshJournals] = await Promise.all([
        api.getLearnerAnalyticsProfile(),
        isUuid(learnerId) ? api.getLearnerGrowth(learnerId) : Promise.resolve(null),
        ...dates.map((date) => api.getLearningJournal(date)),
      ]);
      if (seq !== refreshSeqRef.current) return;
      if (profile) {
        setAnalytics(profile);
        if (isUuid(learnerId)) writeLearnerAnalytics(learnerId, profile);
      }
      if (learnerGrowth) setGrowth(learnerGrowth);
      setJournals((current) => {
        const merged = [...current];
        freshJournals.forEach((journal) => {
          const index = merged.findIndex((item) => item.date === journal.date);
          if (index >= 0) merged[index] = journal;
          else merged.push(journal);
        });
        return merged;
      });
      if (isUuid(learnerId)) freshJournals.forEach((journal) => writeLearnerJournal(learnerId, journal.date, journal));
    } catch { /* 后台刷新失败保留缓存展示 */ }
    finally { if (seq === refreshSeqRef.current) setRefreshing(false); }
  }, [currentLearner.id]);

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError('');
    const learnerId = currentLearner.id;
    const dates = Array.from({ length: 7 }, (_, index) => localDateKey(index));
    const today = dates[0];
    /* 缓存优先：先渲染本地缓存，再后台静默拉取最新数据，完成后自动更新 */
    const cachedAnalytics = isUuid(learnerId) ? readLearnerAnalytics(learnerId) : null;
    if (cachedAnalytics) setAnalytics(cachedAnalytics);
    const cachedJournals = dates.map((date) => (isUuid(learnerId) ? readLearnerJournal(learnerId, date, date === today) : null));
    const hitJournals = cachedJournals.filter((journal): journal is LearningJournal => journal !== null);
    if (hitJournals.length) setJournals(hitJournals);
    if (cachedAnalytics || hitJournals.length > 0) {
      /* 有缓存：直接展示，后台刷新；无缓存时走一次完整加载 */
      setLoading(false);
      void refreshReportData(dates);
      return;
    }
    try {
      const [profile, learnerGrowth, ...freshJournals] = await Promise.all([
        api.getLearnerAnalyticsProfile(),
        isUuid(learnerId) ? api.getLearnerGrowth(learnerId) : Promise.resolve(null),
        ...dates.map((date) => api.getLearningJournal(date)),
      ]);
      setAnalytics(profile);
      setGrowth(learnerGrowth);
      setJournals(freshJournals);
      if (isUuid(learnerId)) {
        if (profile) writeLearnerAnalytics(learnerId, profile);
        freshJournals.forEach((journal) => writeLearnerJournal(learnerId, journal.date, journal));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '学情数据读取失败');
    } finally {
      setLoading(false);
    }
  }, [currentLearner.id, refreshReportData]);

  useEffect(() => {
    void loadReport();
  }, [currentLearner.id, loadReport]);

  /* 从“我的学习”跳转过来：定位到真实课程学习路径 */
  useEffect(() => {
    if (location.hash !== '#learning-path') return;
    const timer = window.setInterval(() => {
      const el = document.getElementById('learning-path');
      if (el) {
        window.clearInterval(timer);
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 300);
    return () => window.clearInterval(timer);
  }, [location.hash]);

  useEffect(() => {
    const onLearning = () => {
      if (!isUuid(currentLearner.id)) return;
      bustLearnerJournal(currentLearner.id, localDateKey(0));
      /* 学习行为发生后静默刷新最近 7 天数据，页面保持最新 */
      void refreshReportData(Array.from({ length: 7 }, (_, index) => localDateKey(index)));
    };
    window.addEventListener('lf-signal', onLearning);
    window.addEventListener('lf:learning-state-changed', onLearning);
    return () => {
      window.removeEventListener('lf-signal', onLearning);
      window.removeEventListener('lf:learning-state-changed', onLearning);
    };
  }, [currentLearner.id, refreshReportData]);

  /* 六维能力 = 画像基线 + 学习证据（章节/知识点 进度×掌握度 加权），与「我的画像」页同口径 */
  const normalizedScores = useMemo(() => {
    const base = currentLearner.scores;
    return domainKnowledgePoints.reduce((acc, point) => {
      acc[point.id] = base[point.id] ?? base[LEGACY_KP_IDS[point.id] ?? ''] ?? 50;
      return acc;
    }, {} as Record<string, number>);
  }, [currentLearner, domainKnowledgePoints]);

  const abilityScores = useMemo(() => deriveAbilityScores(learningMap, normalizedScores), [learningMap, normalizedScores]);

  const abilities = useMemo(() => domainKnowledgePoints.map((point) => ({
    ...point,
    score: abilityScores[point.id] ?? 50,
  })).sort((left, right) => left.score - right.score), [abilityScores, domainKnowledgePoints]);

  const reportLearner = useMemo(() => ({ ...currentLearner, scores: abilityScores }), [currentLearner, abilityScores]);

  const visualReport = useMemo<LearnerReport>(() => {
    const weeks = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8'];
    const spots: BlindSpot[] = abilities
      .filter((ability) => ability.score < getKnowledgePoint(ability.id).targetLevel)
      .map((ability) => {
        const kp = getKnowledgePoint(ability.id);
        const gap = kp.targetLevel - ability.score;
        return {
          kpId: ability.id,
          score: ability.score,
          target: kp.targetLevel,
          gap,
          priority: gap >= 30 ? '高' : gap >= 20 ? '中' : '低',
          suggestion: `先完成「${kp.name}」对应章节的讲义与分阶题，再用实操巩固。`,
        };
      })
      .sort((left, right) => right.gap - left.gap)
      .slice(0, 6);

    const pathNodes = knowledgePoints.map((kp, index) => {
      const chapterIds = Object.entries(CHAPTER_ABILITY_WEIGHTS)
        .filter(([, weights]) => weights[kp.id as AbilityDimension])
        .map(([chapterId]) => chapterId);
      const chapterResources = resources.filter((resource) => chapterIds.includes(resource.chapterId ?? ''));
      const learnedCount = chapterResources.filter((resource) => resource.learned).length;
      const status: PathNodeStatus = chapterResources.length > 0 && learnedCount === chapterResources.length
        ? 'done'
        : learnedCount > 0 ? 'active' : 'todo';
      return {
        id: `path-${kp.id}`,
        title: kp.name,
        kpId: kp.id,
        status,
        est: status === 'done' ? '已完成' : `第 ${Math.min(8, index + 1)} 周`,
        resourceRef: chapterResources.find((resource) => resource.learned)?.title ?? '配套讲义 / 实操 / 分阶题',
      };
    });

    const avg = abilities.reduce((sum, ability) => sum + ability.score, 0) / Math.max(1, abilities.length);
    const difficultyMatch = [1, 2, 3, 4, 5].map((difficulty) => ({
      difficulty,
      fit: Math.max(20, Math.min(100, Math.round(100 - Math.abs(avg - difficulty * 18) * 2.2))),
    }));
    const abilityCurves = knowledgePoints.map((kp) => {
      const current = abilityScores[kp.id] ?? 50;
      const start = Math.max(12, current - 8);
      return {
        kpId: kp.id,
        points: weeks.map((_, weekIndex) => Math.round(start + (current - start) * (weekIndex / 7))),
      };
    });
    const trendStart = Math.max(12, Math.round(avg - 10));

    /* 综合适配评分：定制覆盖为主，学习证据与测评表现为辅。
       覆盖 = 知识点上已挂接讲义/实操/分阶题等资源形态的比例；
       学习证据 = 章节进度 × 掌握度的均值；
       测评表现 = 近 6 次测评得分的均值，无测评时按 80 分中性计。 */
    const catalogForms = new Set<string>();
    let catalogKpCount = 0;
    Object.entries(learningMap.resources ?? {}).forEach(([kpId, list]) => {
      if (!list || list.length === 0) return;
      catalogKpCount += 1;
      list.forEach((resource) => catalogForms.add(`${kpId}::${resource.form}`));
    });
    const expectedForms = Math.max(1, catalogKpCount) * 3;
    const formCoverage = catalogKpCount ? Math.min(1, catalogForms.size / expectedForms) : 0;
    const domains = learningMap.domains ?? [];
    const learningEvidence = domains.length
      ? domains.reduce((sum, domain) => sum + ((learningMap.chapterProgress[domain.id] ?? 0) / 100) * ((learningMap.mastery[domain.id] ?? 0) / 100), 0) / domains.length
      : 0;
    const quizScores = (analytics?.recentQuizzes ?? [])
      .map((quiz) => quiz.score)
      .filter((score): score is number => score != null);
    const quizPerformance = quizScores.length
      ? quizScores.reduce((sum, score) => sum + score, 0) / quizScores.length / 100
      : 0.8;
    const adaptScore = Math.max(65, Math.min(98, Math.round(
      80 * (0.5 + 0.5 * formCoverage) +
      10 * learningEvidence +
      10 * quizPerformance,
    )));

    return {
      learnerId: currentLearner.id,
      adaptScore,
      adaptTrend: weeks.map((_, weekIndex) => Math.round(trendStart + (avg - trendStart) * (weekIndex / 7))),
      weeks,
      abilityCurves,
      difficultyMatch,
      blindSpots: spots,
      path: pathNodes,
      summary: spots.length
        ? `当前最需优先补齐「${getKnowledgePoint(spots[0].kpId).name}」（差 ${spots[0].gap} 分），建议按路径顺序完成讲义、实操与分阶题。`
        : '六维能力均衡向好，保持当前学习节奏并定期测评即可。',
      generated: true,
      baselineHighSpots: spots.filter((spot) => spot.priority === '高').length,
      resolvedSpots: Math.max(0, Math.round(spots.filter((spot) => spot.gap <= 10).length / 2)),
      investHours: Math.round((analytics?.stats.weeklyMinutes.reduce((sum, minutes) => sum + minutes, 0) ?? 0) / 60),
      investNote: '按近 7 天学习时长估算',
    };
  }, [abilities, abilityScores, analytics, currentLearner, learningMap, resources]);
  const resourcesByChapter = useMemo(() => new Map((course?.chapters ?? []).map((chapter) => {
    const chapterResources = resources.filter((resource) => resource.chapterId === chapter.id);
    return [chapter.id, { total: chapterResources.length, learned: chapterResources.filter((resource) => resource.learned).length }];
  })), [course, resources]);

  const journalStats = useMemo(() => journals.reduce((sum, journal) => ({
    questions: sum.questions + journal.stats.questionCount,
    correct: sum.correct + journal.stats.correctCount,
    durationSeconds: sum.durationSeconds + journal.stats.totalDurationSeconds,
    resources: sum.resources + journal.stats.resourceCount,
  }), { questions: 0, correct: 0, durationSeconds: 0, resources: 0 }), [journals]);

  const accuracy = journalStats.questions ? Math.round(journalStats.correct / journalStats.questions * 100) : null;
  const liveMasteryValues = Object.values(learningMap.mastery).filter((value) => value > 0);
  const overallMastery = liveMasteryValues.length
    ? Math.round(liveMasteryValues.reduce((sum, value) => sum + value, 0) / liveMasteryValues.length)
    : Math.round((analytics?.mastery.overall ?? 0) * 100);
  const analyticsMinutes = analytics?.stats.totalStudyMinutes ?? 0;
  const journalMinutes = Math.round(journalStats.durationSeconds / 60);
  const totalMinutesShown = Math.max(analyticsMinutes, journalMinutes);
  const totalMinutesNote = (analytics?.stats.totalDays ?? 0) > 0
    ? `${analytics?.stats.totalDays ?? 0} 个真实学习日`
    : journalMinutes > 0
      ? '按真实学习会话滚动累计，暂无全量统计'
      : '完成真实学习后自动累计';
  /* 真实地图口径的最弱章节：优先有学习痕迹的，其次整体掌握度/进度最低 */
  const weakestChapter = useMemo(() => {
    const domains = learningMap.domains ?? [];
    if (!domains.length) return null;
    const active = domains.filter((domain) => (learningMap.mastery[domain.id] ?? 0) > 0 || (learningMap.chapterProgress[domain.id] ?? 0) > 0);
    const pool = active.length ? active : domains;
    return [...pool].sort((a, b) =>
      (learningMap.mastery[a.id] ?? 0) - (learningMap.mastery[b.id] ?? 0)
      || (learningMap.chapterProgress[a.id] ?? 0) - (learningMap.chapterProgress[b.id] ?? 0),
    )[0] ?? null;
  }, [learningMap]);

  /* 最弱章节主要锻炼的六维（章节→能力权重映射） */
  const weakestChapterDims = useMemo(() => {
    if (!weakestChapter) return '';
    const weights = CHAPTER_ABILITY_WEIGHTS[weakestChapter.id];
    if (!weights) return '';
    const names = (Object.entries(weights) as [AbilityDimension, number][])
      .sort((a, b) => b[1] - a[1])
      .map(([dim]) => domainKnowledgePoints.find((point) => point.id === dim)?.name ?? dim);
    return names.length ? `该方向主要锻炼六维中的「${names.join('、')}」。` : '';
  }, [weakestChapter, domainKnowledgePoints]);

  const rangeDates = useMemo(() => {
    const dates: string[] = [];
    const cursor = new Date(`${rangeStart}T00:00:00`);
    const end = new Date(`${rangeEnd}T00:00:00`);
    if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return dates;
    while (cursor <= end && dates.length < 7) {
      dates.push(toDateKey(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return dates;
  }, [rangeStart, rangeEnd]);

  const handleRangeStart = (value: string) => {
    if (!value) return;
    setRangeStart(clampRange(value, rangeEnd).start);
  };
  const handleRangeEnd = (value: string) => {
    if (!value) return;
    setRangeEnd(clampRange(rangeStart, value).end);
  };

  /* 按所选日期范围加载日记（缓存优先），供真实学习记录展示 */
  useEffect(() => {
    if (!isUuid(currentLearner.id) || rangeDates.length === 0) return;
    let cancelled = false;
    setRangeLoading(true);
    const todayKey = localDateKey(0);
    const cached = rangeDates.map((date) => readLearnerJournal(currentLearner.id, date, date === todayKey));
    const hits = cached.filter((journal): journal is LearningJournal => journal !== null);
    if (hits.length) setRangeJournals(hits);
    const missing = rangeDates.filter((_date, index) => !cached[index]);
    Promise.all(missing.map((date) => api.getLearningJournal(date)))
      .then((fresh) => {
        if (cancelled) return;
        setRangeJournals([...hits, ...fresh]);
        fresh.forEach((journal) => writeLearnerJournal(currentLearner.id, journal.date, journal));
        /* 缓存展示后，后台刷新整个所选范围，保证记录与最新数据同步 */
        return refreshReportData(rangeDates);
      })
      .catch(() => { /* 保留已有缓存 */ })
      .finally(() => { if (!cancelled) setRangeLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLearner.id, rangeDates.join('|'), refreshReportData]);

  const rangeEvidence = useMemo(() => {
    const startKey = `${rangeStart}T00:00:00`;
    const endKey = `${rangeEnd}T23:59:59.999`;
    const journalEvidence = rangeJournals.flatMap((journal) => journal.timeline);
    const profileEvidence = (growth?.events ?? []).map((event, index) => ({
      id: `growth-${event.createdAt}-${index}`,
      occurredAt: event.createdAt,
      kind: 'knowledge',
      title: event.title,
      description: event.amount ? `成长能量 ${event.amount > 0 ? '+' : ''}${event.amount}` : '画像字段已保存到后端',
      durationSeconds: null,
      knowledgeName: null,
      correctCount: null,
      wrongCount: null,
    }));
    return [...journalEvidence, ...profileEvidence]
      .filter((ev) => ev.occurredAt >= startKey && ev.occurredAt <= endKey)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  }, [rangeJournals, growth, rangeStart, rangeEnd]);

  const recentEvidence = useMemo(() => {
    const journalEvidence = journals.flatMap((journal) => journal.timeline);
    const profileEvidence = (growth?.events ?? []).map((event, index) => ({
      id: `growth-${event.createdAt}-${index}`,
      occurredAt: event.createdAt,
      kind: 'knowledge',
      title: event.title,
      description: event.amount ? `成长能量 ${event.amount > 0 ? '+' : ''}${event.amount}` : '画像字段已保存到后端',
      durationSeconds: null,
      knowledgeName: null,
      correctCount: null,
      wrongCount: null,
    }));
    return [...journalEvidence, ...profileEvidence].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  }, [journals, growth]);

  const today = journals.find((journal) => journal.date === localDateKey(0)) ?? journals[0] ?? null;

  const exportReport = () => {
    const learnerName = currentLearner.name;
    const abilitiesData = abilities.map((ability) => ({ name: ability.name, score: ability.score }));
    const chapterData = (course?.chapters ?? []).map((chapter) => {
      const count = resourcesByChapter.get(chapter.id) ?? { learned: 0, total: 0 };
      return {
        index: chapter.index,
        title: chapter.title,
        learned: count.learned,
        total: count.total,
        mastery: Math.round(learningMap.mastery[chapter.id] ?? 0),
        target: learningMap.nodeTargets?.[chapter.id]?.target ?? 0,
      };
    });
    const today = journals.find((journal) => journal.date === localDateKey(0)) ?? journals[0] ?? null;
    const html = buildReportHtml({
      learnerName,
      generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      overallMastery,
      totalMinutes: Math.round((analytics?.stats.totalStudyMinutes ?? 0) / 60),
      streakDays: analytics?.stats.streakDays ?? 0,
      accuracy,
      accuracyDetail: journalStats.questions ? `${journalStats.correct}/${journalStats.questions} 题答对` : '尚无真实测评提交',
      abilities: abilitiesData,
      weakestChapter: weakestChapter?.name ?? null,
      weakestDetail: weakestChapter
        ? `当前最弱章节是「${weakestChapter.name}」（掌握度 ${Math.round(learningMap.mastery[weakestChapter.id] ?? 0)}% · 进度 ${Math.round(learningMap.chapterProgress[weakestChapter.id] ?? 0)}%）。${weakestChapterDims}建议优先补齐该章节的资源与练习。`
        : '',
      courseTitle: course?.title ?? null,
      courseProgress: progress,
      chapters: chapterData,
      weeklyLabels: Array.from({ length: 7 }, (_, index) => {
        const date = new Date();
        date.setDate(date.getDate() - (6 - index));
        return `${date.getMonth() + 1}/${date.getDate()}`;
      }),
      weeklyMinutes: (analytics?.stats.weeklyMinutes ?? Array(7).fill(0)).map((m) => Math.round(Number(m) || 0)),
      journalStats: {
        questions: journalStats.questions,
        correct: journalStats.correct,
        durationMinutes: Math.round(journalStats.durationSeconds / 60),
        resources: journalStats.resources,
      },
      todaySummary: today?.summary?.content ?? null,
      quizzes: (analytics?.recentQuizzes ?? []).slice(0, 6).map((quiz) => ({
        name: quiz.categoryName ?? '综合测评',
        type: quiz.quizType,
        score: quiz.score == null ? '—' : `${Math.round(quiz.score)}分`,
        time: new Date(quiz.createdAt).toLocaleString('zh-CN', { hour12: false }),
      })),
      evidence: recentEvidence.slice(0, 10).map((ev) => {
        const meta = evidenceMeta[ev.kind] ?? evidenceMeta.knowledge;
        return {
          label: meta.label,
          time: evidenceTime(ev.occurredAt),
          title: ev.title,
          description: ev.description,
        };
      }),
    });
    try {
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `学习成长报告-${learnerName}-${localDateKey(0)}.html`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast.success('报告已生成，正在下载', { description: 'HTML 报告可离线打开、打印或转 Word。' });
    } catch {
      toast.error('报告生成失败，请稍后重试');
    }
  };

  const generateSummary = async () => {
    if (summarizing) return;
    setSummarizing(true);
    try {
      const updated = await api.generateLearningJournalSummary(localDateKey(0));
      setJournals((previous) => [updated, ...previous.filter((journal) => journal.date !== updated.date)]);
      if (isUuid(currentLearner.id)) writeLearnerJournal(currentLearner.id, updated.date, updated);
      toast.success('今日学习总结已生成');
    } catch (reason) {
      toast.error('总结生成失败', { description: reason instanceof Error ? reason.message : '请稍后再试' });
    } finally {
      setSummarizing(false);
    }
  };

  if (loading || courseLoading) {
    return <div className="mx-auto max-w-[1100px] px-6 py-16 text-center text-[14px] text-ink-muted">正在汇总真实学习数据…</div>;
  }

  if (error && !analytics) {
    return (
      <div className="mx-auto max-w-[760px] px-6 py-16 text-center">
        <h1 className="text-[20px] font-semibold text-ink">学习报告暂时无法读取</h1>
        <p className="mt-2 text-[13px] text-brand-danger">{error}</p>
        <button type="button" onClick={() => void loadReport()} className="lf-btn-primary mt-5">重新读取</button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1180px] px-5 pb-24 pt-8 md:px-8">
      <PageBack parent={{ label: '我的学习', to: '/me' }} current="我的成长" />

      <motion.header initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="lf-mono-label mb-2">LEARNING EVIDENCE REPORT</div>
          <h1 className="font-serif text-[34px] font-bold text-ink">{currentLearner.name}的学习成长</h1>
          <p className="mt-2 max-w-[700px] text-[14px] leading-6 text-ink-muted">画像、测评、学习时长、课程进度与路径均来自后端已保存记录；没有证据的指标保持为空，不用演示曲线补位。</p>
        </div>
        <button type="button" onClick={exportReport} className="lf-btn-ghost !px-4 !py-2 text-[13px]">
          <FileDown size={15} /> 导出 / 打印报告
        </button>
      </motion.header>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-2">
        {[
          { icon: Target, label: '实测综合掌握度', value: `${overallMastery}%`, note: liveMasteryValues.length || (analytics?.mastery.categories.length ?? 0) ? `${Math.max(liveMasteryValues.length, analytics?.mastery.categories.length ?? 0)} 个章节形成证据` : '完成分阶题后开始累计', tone: 'text-brand' },
          { icon: Clock3, label: '累计学习投入', value: displayMinutes(totalMinutesShown), note: totalMinutesNote, tone: 'text-brand' },
        ].map((item, index) => {
          const Icon = item.icon;
          return (
            <motion.div key={item.label} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.06 }} className="lf-card p-5">
              <div className="flex items-center gap-2 text-[12px] text-ink-muted"><Icon size={15} className={item.tone} />{item.label}</div>
              <div className="mt-3 font-serif text-[28px] font-semibold text-ink">{item.value}</div>
              <div className="mt-2 border-t border-hairline pt-2 text-[11.5px] leading-5 text-ink-muted">{item.note}</div>
            </motion.div>
          );
        })}
      </section>

      <section className="mt-12">
        <SectionHeader en="DIAGNOSIS" title="六维能力画像" desc="" />
        <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="lf-card p-5">
            {domainKnowledgePoints.length ? <ReactECharts option={radarOption(domainKnowledgePoints, abilityScores)} height={350} /> : <div className="py-20 text-center text-[13px] text-ink-muted">画像知识维度尚未建立</div>}
          </div>
          <div className="lf-card divide-y divide-hairline overflow-hidden">
            {abilities.map((ability, index) => (
              <div key={ability.id} className="px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-[14px] font-semibold text-ink"><span className="font-mono text-[10px] text-ink-muted">{String(index + 1).padStart(2, '0')}</span>{ability.name}</span>
                  <span className="font-mono text-[11px] text-ink-muted">当前 {ability.score} 分</span>
                </div>
                <div className="relative mt-3 h-2 overflow-hidden rounded-full bg-hairline">
                  <div className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${Math.min(100, ability.score)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-12 print:break-before-page">
        <SectionHeader en="MATCH REPORT" title="学情与资源匹配度报告" desc="知识盲区、资源难度匹配与学习路径规划，帮助直观决策。" />
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_350px]">
          <div className="lf-card p-4">
            <div className="mb-3 flex flex-wrap gap-2 border-b border-hairline pb-3">
              {[
                { key: 'score' as const, label: '综合评分', Icon: Target },
                { key: 'gap' as const, label: '知识盲区', Icon: History },
                { key: 'difficulty' as const, label: '难度匹配', Icon: BookOpen },
                { key: 'path' as const, label: '路径规划', Icon: Route },
              ].map((tab) => {
                const Icon = tab.Icon;
                const active = activeMatchTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveMatchTab(tab.key)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-all',
                      active
                        ? 'bg-brand text-paper shadow-sm'
                        : 'bg-paper-deep text-ink-muted hover:bg-brand-tint hover:text-brand',
                    )}
                  >
                    <Icon size={13} />
                    {tab.label}
                  </button>
                );
              })}
            </div>
            <div className="max-h-[680px] overflow-y-auto pr-1">
              {activeMatchTab === 'score' && <ScoreBand report={visualReport} />}
              {activeMatchTab === 'gap' && <GapSection learner={reportLearner} report={visualReport} />}
              {activeMatchTab === 'difficulty' && <DifficultyMatch learner={reportLearner} report={visualReport} />}
              {activeMatchTab === 'path' && <PathRoadmap learner={reportLearner} report={visualReport} />}
            </div>
          </div>
          <StreakCalendar
            className="xl:sticky xl:top-6"
            streakDays={analytics?.stats.streakDays ?? 0}
            studyDates={analytics?.stats.studyDates ?? []}
            totalDays={analytics?.stats.totalDays ?? 0}
          />
        </div>
        <div className="mt-5">
          <GrowthSection learner={reportLearner} report={visualReport} />
        </div>
      </section>
      <section className="mt-12">
        <SectionHeader en="GROWTH" title="近 7 天真实成长轨迹" desc="学习时长与测评记录来自每日学习会话，不再用固定 W1–W8 模拟增长。" />
        <div className="grid gap-5 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="lf-card p-5">
            <div className="mb-2 text-[14px] font-semibold text-ink">每日学习时长</div>
            <ReactECharts option={weeklyOption(analytics?.stats.weeklyMinutes ?? Array(7).fill(0))} height={270} />
          </div>
          <div className="lf-card p-5">
            <div className="flex items-center justify-between gap-3">
              <div><div className="text-[14px] font-semibold text-ink">今日学习小结</div><div className="mt-1 text-[11px] text-ink-muted">{today?.date ?? localDateKey(0)}</div></div>
              <button type="button" onClick={() => void generateSummary()} disabled={summarizing} className="lf-btn-ghost !px-3 !py-1.5 text-[11.5px]"><Sparkles size={13} />{summarizing ? '生成中…' : '生成总结'}</button>
            </div>
            {today?.summary ? (
              <p className="mt-5 rounded-[12px] border border-brand/20 bg-brand-tint/35 p-4 text-[13px] leading-6 text-ink-2">{today.summary.content}</p>
            ) : (
              <div className="mt-5 rounded-[12px] border border-dashed border-hairline p-5 text-[13px] leading-6 text-ink-muted">{today?.timeline.length ? `今天已有 ${today.timeline.length} 条学习记录，可以生成一份基于真实证据的日总结。` : '今天还没有形成学习轨迹。完成资源、练习或导学后再来生成总结。'}</div>
            )}
            <div className="mt-5 grid grid-cols-2 gap-3 text-center">
              <div className="rounded-[10px] bg-paper-deep p-3"><div className="font-mono text-[20px] font-semibold text-ink">{journalStats.resources}</div><div className="mt-1 text-[10.5px] text-ink-muted">近 7 天资源记录</div></div>
              <div className="rounded-[10px] bg-paper-deep p-3"><div className="font-mono text-[20px] font-semibold text-ink">{Math.round(journalStats.durationSeconds / 60)}</div><div className="mt-1 text-[10.5px] text-ink-muted">近 7 天记录分钟</div></div>
            </div>
          </div>
        </div>
      </section>

      <section id="learning-path" className="mt-12 scroll-mt-24">
        <SectionHeader en="LEARNING PATH" title="真实课程学习路径" desc="章节状态由课程和资源完成记录计算；未生成资源的章节不会被标成已学完。" />
        {course && (
          <div className="lf-card overflow-hidden">
            <div className="flex flex-wrap items-center gap-4 border-b border-hairline bg-brand-tint/25 px-5 py-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand text-paper"><Route size={18} /></span>
              <div className="min-w-0 flex-1"><div className="text-[15px] font-semibold text-ink">{course.title}</div><div className="mt-1 text-[11.5px] text-ink-muted">{learnedCount}/{totalCount} 项资源已完成 · 总进度 {progress}%</div></div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-hairline sm:w-44"><div className="h-full rounded-full bg-brand" style={{ width: `${progress}%` }} /></div>
            </div>
            <div className="divide-y divide-hairline">
              {course.chapters.map((chapter) => {
                const count = resourcesByChapter.get(chapter.id) ?? { learned: 0, total: 0 };
                const done = count.total > 0 && count.learned === count.total;
                const active = nextChapter?.id === chapter.id;
                const mastery = Math.round(learningMap.mastery[chapter.id] ?? 0);
                const target = learningMap.nodeTargets?.[chapter.id]?.target ?? 0;
                return (
                  <div key={chapter.id} className={`flex items-start gap-3 px-5 py-4 ${active ? 'bg-brand-tint/20' : ''}`}>
                    {done ? <CheckCircle2 size={19} className="mt-0.5 shrink-0 text-brand" /> : <CircleDashed size={19} className={active ? 'mt-0.5 shrink-0 text-ochre' : 'mt-0.5 shrink-0 text-ink-muted'} />}
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-semibold text-ink">{chapter.index}. {chapter.title}{active && <span className="ml-2 rounded-md bg-brand-amber-tint px-1.5 py-0.5 text-[9.5px] text-ochre">正在这里</span>}</div>
                      <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">{chapter.summary}</p>
                      <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-hairline">
                        <div className="absolute inset-y-0 left-0 rounded-full bg-[#14B8A6]" style={{ width: `${Math.min(100, mastery)}%` }} />
                        {target > 0 && <div className="absolute inset-y-0 w-[3px] rounded-full bg-[#155E9A]" style={{ left: `${Math.min(100, target)}%` }} />}
                      </div>
                      <div className="mt-1 font-mono text-[10.5px] text-ink-muted">掌握度 {mastery}%{target > 0 ? ` · 目标 ${target}%` : ''}</div>
                    </div>
                    <span className="shrink-0 font-mono text-[11px] text-ink-muted">{count.learned}/{count.total}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 真实学习记录：可选择日期范围（最多 7 天），S 形路径展示 */}
        <div className="mt-4 lf-card p-5">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <History size={16} className="text-brand" />
            <span className="text-[15px] font-semibold text-ink">真实学习记录</span>
            <span className="font-mono text-[11px] text-ink-muted">{rangeStart} ~ {rangeEnd}</span>
            {(rangeLoading || refreshing) && <Loader2 size={13} className="animate-spin text-ink-muted" />}
          </div>
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-[12px] border border-hairline bg-card-warm px-3 py-2">
            <CalendarRange size={14} className="text-brand" />
            <input type="date" value={rangeStart} max={rangeEnd} onChange={(event) => handleRangeStart(event.target.value)} aria-label="开始日期" className="h-8 rounded-[8px] border border-hairline bg-paper px-2 text-[12px] text-ink outline-none focus:border-brand/45" />
            <span className="text-[11.5px] text-ink-muted">至</span>
            <input type="date" value={rangeEnd} min={rangeStart} max={localDateKey(0)} onChange={(event) => handleRangeEnd(event.target.value)} aria-label="结束日期" className="h-8 rounded-[8px] border border-hairline bg-paper px-2 text-[12px] text-ink outline-none focus:border-brand/45" />
            <span className="text-[11px] text-ink-muted">最多 7 天</span>
          </div>
          {rangeEvidence.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-ink-muted">这个时间段还没有学习记录。完成真实讲义、练习或导学后，记录会自动出现在这里。</p>
          ) : (
            <div ref={pathRef} className="relative w-full">
              {(() => {
                const layout = buildSplineLayout(rangeEvidence, perRow, pathWidth);
                return (
                  <div className="relative" style={{ height: layout.height }}>
                    {layout.pathD && (
                      <svg className="absolute inset-0 z-0 h-full w-full" viewBox={`0 0 ${Math.max(pathWidth, 320)} ${layout.height}`} preserveAspectRatio="none" aria-hidden>
                        <path d={layout.pathD} fill="none" stroke="#4E7860" strokeOpacity="0.55" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                    {layout.points.map((pt) => <SPathNode key={pt.ev.id} pt={pt} />)}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      </section>

      <section className="mt-12">
        <SectionHeader en="NEXT ACTION" title="下一步建议" desc="主线按真实地图最弱章节给出；六维能力只作佐证，不设目标。" />
        <div className="rounded-[16px] border border-brand/25 bg-brand-tint/35 p-6">
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-paper"><Sparkles size={19} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold text-ink">{weakestChapter ? `优先补齐「${weakestChapter.name}」` : '先完成一次真实学习'}</div>
              <p className="mt-1 text-[13px] leading-6 text-ink-muted">{weakestChapter ? `当前最弱章节是「${weakestChapter.name}」（掌握度 ${Math.round(learningMap.mastery[weakestChapter.id] ?? 0)}% · 进度 ${Math.round(learningMap.chapterProgress[weakestChapter.id] ?? 0)}%）。${weakestChapterDims}${nextResource ? `建议继续“${nextChapter?.title ?? nextResource.topic}”中的${resourceLabel[nextResource.type]}，完成后再用测评校准掌握度。` : '先生成对应章节的讲义与分阶题，形成可验证的学习证据。'}` : '先完成一次真实学习，能力与画像数据会随证据累积。'}</p>
            </div>
            <button
              type="button"
              onClick={() => navigate(learnMapPath(currentLearner.id, nextResource?.kpId ?? weakestChapter?.id))}
              className="lf-btn-primary shrink-0 !px-4 !py-2 text-[12.5px]"
            >
              {nextResource ? '继续学习' : '进入课程'} <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </section>

      {analytics?.recentQuizzes.length ? (
        <section className="mt-12">
          <SectionHeader en="ASSESSMENTS" title="最近测评证据" />
          <div className="lf-card divide-y divide-hairline overflow-hidden">
            {analytics.recentQuizzes.slice(0, 6).map((quiz, index) => (
              <div key={`${quiz.createdAt}-${index}`} className="flex items-center gap-4 px-5 py-4">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-tint text-brand"><BookOpen size={16} /></span>
                <div className="min-w-0 flex-1"><div className="text-[13.5px] font-medium text-ink">{quiz.categoryName ?? '综合测评'}</div><div className="mt-1 font-mono text-[10.5px] text-ink-muted">{quiz.quizType} · {new Date(quiz.createdAt).toLocaleString('zh-CN', { hour12: false })}</div></div>
                <span className="font-mono text-[20px] font-semibold text-brand">{quiz.score == null ? '—' : `${Math.round(quiz.score)}分`}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
