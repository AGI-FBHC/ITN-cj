import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  BookOpen,
  Clock3,
  FileDown,
  History,
  Loader2,
  Route,
  Sparkles,
  Target,
  X,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';
import SectionHeader from '@/components/SectionHeader';
import { ReactECharts } from '@/components/ChartCard';
import { useProfile } from '@/context/ProfileContext';
import { useCourseLearning } from '@/hooks/useCourseLearning';
import { useLearningMap } from '@/hooks/useLearningMap';
import { api } from '@/lib/api';
import { presentationApi } from '@/lib/presentationApi';
import type { PresentationTaskSummary } from '@/lib/presentationApi';
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
import { GrowthTrendChart, WeeklyAdviceCard } from '@/components/report/GrowthSection';
import BlindFocusBoard, { readBlindFocusRecords, type FocusKp } from '@/components/report/BlindFocusBoard';
import ScoreBand from '@/components/report/ScoreBand';
import StreakCalendar from '@/components/StreakCalendar';
import type { BlindSpot, LearnerReport, PathNodeStatus } from '@/data/reportData';
import { knowledgePoints, getKnowledgePoint } from '@/data/knowledgePoints';

const resourceLabel = { lecture: '讲义', practice: '实操', quiz: '分阶题', ppt: '交互课件' } as const;

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

/** 导出报告里的目标类型/水平文案（与页面上的选项保持一致） */
const GOAL_TYPE_LABEL: Record<string, string> = {
  JOB_PREPARATION: '求职准备', COURSE_STUDY: '系统学习一门课', PROJECT_DEVELOPMENT: '做项目',
  SKILL_IMPROVEMENT: '补技能', EXAM_PREPARATION: '应试', CUSTOM: '其他',
};
const GOAL_LEVEL_LABEL: Record<string, string> = {
  BEGINNER: '入门', ELEMENTARY: '能看懂', PROFICIENT: '能独立做', EXPERT: '能讲能带',
};

/** 生成自包含 HTML 报告（内联样式，可离线打开/打印/转 Word） */
function buildReportHtml(data: {
  learnerName: string;
  generatedAt: string;
  overallMastery: number;
  totalMinutes: number;
  streakDays: number;
  accuracy: number | null;
  accuracyDetail: string;
  abilities: { name: string; score: number; target: number }[];
  weakestChapter: string | null;
  weakestDetail: string;
  courseTitle: string | null;
  courseProgress: number;
  chapters: { index: number; title: string; learned: number; total: number; mastery: number; target: number }[];
  daily: { label: string; minutes: number; resources: number; questions: number; correct: number }[];
  journalStats: { questions: number; correct: number; durationMinutes: number; resources: number };
  todaySummary: string | null;
  goal: { title: string; type: string; level: string; progress: number } | null;
  quizzes: { name: string; type: string; time: string; summary: string; score: string }[];
  resources: { label: string; total: number; learned: number }[];
}): string {
  const card = (label: string, value: string, note: string) =>
    `<div class="card"><div class="card-label">${esc(label)}</div><div class="card-value">${esc(value)}</div><div class="card-note">${esc(note)}</div></div>`;

  const abilityRows = data.abilities.map((a) => {
    const score = Math.max(0, Math.min(100, Math.round(a.score)));
    const target = Math.max(0, Math.min(100, Math.round(a.target)));
    const gap = Math.max(0, target - score);
    const tone = gap <= 5 ? 'ok' : gap <= 20 ? 'warn' : 'danger';
    const label = gap <= 5 ? '接近目标' : gap <= 20 ? '待巩固' : '重点盲区';
    return `
        <div class="row">
          <div class="row-label">${esc(a.name)}</div>
          <div class="bar"><div class="bar-fill" style="width:${score}%"></div><div class="bar-threshold" style="left:${target}%"></div></div>
          <div class="row-note">${score} 分 · 目标 ${target}${gap ? ` · 差 ${gap}` : ' · 已达标'}</div>
          <span class="chip ${tone}">${label}</span>
        </div>`;
  }).join('');

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

  const maxMinutes = Math.max(10, ...data.daily.map((day) => day.minutes));
  const trendChart = (() => {
    const width = 760;
    const height = 190;
    const left = 36;
    const right = 14;
    const top = 16;
    const bottom = 34;
    const innerW = width - left - right;
    const innerH = height - top - bottom;
    const step = data.daily.length > 1 ? innerW / (data.daily.length - 1) : 0;
    const points = data.daily.map((day, index) => ({
      ...day,
      x: left + index * step,
      y: height - bottom - (Math.max(0, day.minutes) / maxMinutes) * innerH,
    }));
    const line = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
    const area = `${left},${height - bottom} ${line} ${(points[points.length - 1]?.x ?? left).toFixed(1)},${height - bottom}`;
    const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
      const y = top + innerH * ratio;
      return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" stroke="#EDF0EB" stroke-width="1" /><text x="4" y="${y + 4}" font-size="10" fill="#9AA49C">${Math.round(maxMinutes * (1 - ratio))}</text>`;
    }).join('');
    const dots = points.map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4" fill="#4E7860" stroke="#FFFFFF" stroke-width="2" />`).join('');
    const labels = points.map((point) => `<text x="${point.x.toFixed(1)}" y="${height - 12}" font-size="10" fill="#8A958D" text-anchor="middle">${esc(point.label)}</text>`).join('');
    const values = points.map((point) => `<text x="${point.x.toFixed(1)}" y="${(point.y - 10).toFixed(1)}" font-size="10" font-weight="600" fill="#2E5C46" text-anchor="middle">${Math.round(point.minutes)}</text>`).join('');
    return `<svg class="trend" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="近 7 天学习时长趋势">${grid}<polygon points="${area}" fill="rgba(78,120,96,0.14)" /><polyline points="${line}" fill="none" stroke="#4E7860" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />${dots}${labels}${values}</svg>`;
  })();

  const dailyRows = data.daily.map((day) => `
        <tr><td>${esc(day.label)}</td><td class="num">${esc(day.minutes)}</td><td class="num">${esc(day.resources)}</td><td class="num">${esc(day.questions)}</td><td class="num">${day.questions ? `${Math.round((day.correct / day.questions) * 100)}%` : '—'}</td></tr>`).join('');

  const quizRows = data.quizzes.map((q) => `
        <div class="row"><span class="row-label">${esc(q.name)}</span><span class="row-note">${esc(q.type)} · ${esc(q.time)} · ${esc(q.summary)}</span><span class="row-value">${esc(q.score)}</span></div>`).join('');

  const resourceRows = data.resources.map((r) => `
        <div class="row"><div class="row-label">${esc(r.label)}</div><div class="bar"><div class="bar-fill" style="width:${r.total ? Math.min(100, Math.round((r.learned / r.total) * 100)) : 0}%"></div></div><div class="row-note">可用 ${esc(r.total)} · 已学 ${esc(r.learned)}</div></div>`).join('');

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
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .chip { display: inline-block; border-radius: 6px; padding: 1px 8px; font-size: 10.5px; border: 1px solid; flex-shrink: 0; }
  .chip.ok { color: #2E5C46; border-color: #C9D8CE; background: #F0F6F1; }
  .chip.warn { color: #8A6A2F; border-color: #E7D3A8; background: #FBF3E2; }
  .chip.danger { color: #A6433A; border-color: #E7BFBA; background: #FBEDEB; }
  table.daily { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
  table.daily th { text-align: left; font-weight: 600; color: #7A877F; font-size: 11px; padding: 6px 8px; border-bottom: 1px solid #E3E8E1; }
  table.daily td { padding: 6px 8px; border-bottom: 1px dashed #EDF0EB; color: #44524B; }
  table.daily th.num, table.daily td.num { text-align: right; }
  .trend { display: block; margin-top: 8px; border: 1px solid #EDF0EB; border-radius: 10px; background: #FBFCF9; }
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
  <div class="sub">生成时间：${esc(data.generatedAt)} · 数据来源：学习记录</div>

  <h2>总体概览</h2>
  <div class="cards">
    ${card('实测综合掌握度', `${data.overallMastery}%`, '按学习证据计算')}
    ${card('累计学习投入', data.totalMinutes >= 60 ? `${Math.floor(data.totalMinutes / 60)} 小时 ${data.totalMinutes % 60} 分` : `${data.totalMinutes} 分钟`, '按学习会话统计')}
    ${card('连续学习', `${data.streakDays} 天`, '按每日学习会话统计')}
    ${card('近 7 天测评正确率', data.accuracy == null ? '暂无' : `${data.accuracy}%`, data.accuracy == null ? '尚无测评提交' : data.accuracyDetail)}
  </div>

  ${data.goal ? `<h2>学习目标</h2>
  <div class="summary">
    <div style="font-size:15px;font-weight:700;color:#2E5C46">${esc(data.goal.title)}</div>
    <div style="margin-top:6px;font-size:12px;color:#7A877F">${esc(GOAL_TYPE_LABEL[data.goal.type] ?? data.goal.type)} · 期望水平 ${esc(GOAL_LEVEL_LABEL[data.goal.level] ?? data.goal.level)} · 当前推进 ${Math.round(data.goal.progress)}%</div>
    <div class="bar" style="margin-top:10px"><div class="bar-fill" style="width:${Math.max(0, Math.min(100, Math.round(data.goal.progress)))}%"></div></div>
  </div>` : ''}

  ${data.weakestChapter ? `<h2>重点建议</h2><div class="summary">${esc(data.weakestDetail)}</div>` : ''}

  ${data.abilities.length ? `<h2>六维能力诊断</h2>${abilityRows}` : ''}

  ${data.resources.length ? `<h2>资源使用偏好</h2>${resourceRows}` : ''}

  ${data.chapters.length ? `<h2>课程学习路径</h2>${chapterRows}` : ''}

  <h2>近 7 天学习趋势</h2>
  <div style="border:1px solid #EDF0EB;border-radius:12px;padding:10px 6px 4px;background:#FBFCF9">${trendChart}</div>
  <table class="daily">
    <thead><tr><th>日期</th><th class="num">学习时长（分钟）</th><th class="num">资源</th><th class="num">答题</th><th class="num">正确率</th></tr></thead>
    <tbody>${dailyRows}</tbody>
  </table>
  <div class="summary" style="margin-top:12px">近 7 天共作答 ${esc(data.journalStats.questions)} 题、答对 ${esc(data.journalStats.correct)} 题，学习 ${esc(data.journalStats.durationMinutes)} 分钟，记录资源 ${esc(data.journalStats.resources)} 项。${data.todaySummary ? `今日总结：${esc(data.todaySummary)}` : ''}</div>

  ${data.quizzes.length ? `<h2>最近测评（按作答批次合并）</h2>${quizRows}` : ''}

  <div class="footer">本报告由智训云枢基于学习记录生成 · 仅用于个人学习复盘</div>
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
      type: 'line' as const, data: values, smooth: true,
      symbol: 'circle' as const, symbolSize: 7, showSymbol: true,
      lineStyle: { color: '#4E7860', width: 2.5 },
      itemStyle: { color: '#4E7860', borderColor: '#FBFAF5', borderWidth: 2 },
      areaStyle: {
        color: {
          type: 'linear' as const, x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(78,120,96,0.26)' },
            { offset: 1, color: 'rgba(78,120,96,0.02)' },
          ],
        },
      },
    }],
  };
}

/** 在资源内容里按 questionId 找到原始题目（题目可能嵌在任意层级）。 */
function findQuestionRecord(node: unknown, questionId: string): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findQuestionRecord(item, questionId);
      if (hit) return hit;
    }
    return null;
  }
  const record = node as Record<string, unknown>;
  if (String(record.id ?? '') === questionId || String(record.questionId ?? '') === questionId) return record;
  for (const value of Object.values(record)) {
    const hit = findQuestionRecord(value, questionId);
    if (hit) return hit;
  }
  return null;
}

type RecentQuiz = LearnerAnalyticsProfile['recentQuizzes'][number];

/** 一次测评的证据组：同一份资源、间隔 10 分钟内提交的单题记录合并成一组 */
interface QuizEvidenceGroup {
  key: string;
  records: RecentQuiz[];
  resourceId: string | null;
  categoryName: string | null;
  quizType: string;
  createdAt: string;
  questionCount: number;
  correctCount: number;
  durationSeconds: number | null;
  score: number | null;
  difficultyLevel: string | null;
}

function parseQuizDetails(raw?: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/** 按题数加权平均分，避免单题记录直接平均 */
function groupScore(records: RecentQuiz[]): number | null {
  let weighted = 0;
  let total = 0;
  records.forEach((record) => {
    if (record.score == null) return;
    const weight = Math.max(1, record.questionCount || 1);
    weighted += record.score * weight;
    total += weight;
  });
  return total > 0 ? weighted / total : null;
}

function buildQuizEvidenceGroups(quizzes: RecentQuiz[]): QuizEvidenceGroup[] {
  const sorted = [...quizzes].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const groups: QuizEvidenceGroup[] = [];
  sorted.forEach((quiz) => {
    const resourceId = typeof parseQuizDetails(quiz.details).resourceId === 'string'
      ? String(parseQuizDetails(quiz.details).resourceId)
      : null;
    const last = groups[groups.length - 1];
    const gapMs = last ? Math.abs(new Date(last.createdAt).getTime() - new Date(quiz.createdAt).getTime()) : Number.POSITIVE_INFINITY;
    if (last && resourceId && last.resourceId === resourceId && gapMs <= 10 * 60 * 1000) {
      last.records.push(quiz);
      last.questionCount += quiz.questionCount || 0;
      last.correctCount += quiz.correctCount || 0;
      last.durationSeconds = (last.durationSeconds ?? 0) + (quiz.durationSeconds ?? 0);
      last.score = groupScore(last.records);
      if (!last.difficultyLevel && quiz.difficultyLevel) last.difficultyLevel = quiz.difficultyLevel;
      return;
    }
    groups.push({
      key: quiz.id,
      records: [quiz],
      resourceId,
      categoryName: quiz.categoryName ?? null,
      quizType: quiz.quizType,
      createdAt: quiz.createdAt,
      questionCount: quiz.questionCount || 0,
      correctCount: quiz.correctCount || 0,
      durationSeconds: quiz.durationSeconds ?? null,
      score: quiz.score ?? null,
      difficultyLevel: quiz.difficultyLevel ?? null,
    });
  });
  return groups;
}

interface EvidenceQuestionItem {
  questionId: string;
  question: Record<string, unknown>;
  selectedIndex: number | null;
  correct: boolean;
}

export default function Report() {
  const navigate = useNavigate();
  const location = useLocation();
  const { currentLearner, domainKnowledgePoints, patchLearner } = useProfile();
  const { loading: courseLoading, course, resources, nextResource, nextChapter, learnedCount, totalCount, progress } = useCourseLearning();
  const learningMap = useLearningMap();
  /* 交互课件（PPTX）不在 /learning-resources 里，单独从 presentations 汇总 */
  const [presentationSummaries, setPresentationSummaries] = useState<PresentationTaskSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    presentationApi.listPresentationSummaries(300, true)
      .then((listed) => { if (!cancelled) setPresentationSummaries(listed.tasks ?? []); })
      .catch(() => { if (!cancelled) setPresentationSummaries([]); });
    return () => { cancelled = true; };
  }, [currentLearner.id]);
  const [analytics, setAnalytics] = useState<LearnerAnalyticsProfile | null>(null);
  const [evidence, setEvidence] = useState<QuizEvidenceGroup | null>(null);
  const [evidenceQuestions, setEvidenceQuestions] = useState<EvidenceQuestionItem[]>([]);
  const [evidenceIndex, setEvidenceIndex] = useState(0);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
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
  /** 盲区选择：学习者主动设为目标后，完成后自动计入盲区消解数 */
  const [focusStats, setFocusStats] = useState<{ active: number; resolved: number }>(() => {
    const records = isUuid(currentLearner.id) ? readBlindFocusRecords(currentLearner.id) : [];
    return {
      active: records.filter((record) => !record.resolvedAt).length,
      resolved: records.filter((record) => Boolean(record.resolvedAt)).length,
    };
  });

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

  /* 打开测评证据：按资源读取本次作答的全部题目与作答记录，支持左右切换 */
  useEffect(() => {
    if (!evidence) {
      setEvidenceQuestions([]);
      setEvidenceIndex(0);
      setEvidenceLoading(false);
      return;
    }
    const resourceId = evidence.resourceId;
    if (!resourceId) {
      setEvidenceQuestions([]);
      setEvidenceLoading(false);
      return;
    }
    let cancelled = false;
    setEvidenceQuestions([]);
    setEvidenceIndex(0);
    setEvidenceLoading(true);
    Promise.all([
      api.getLearningResource(resourceId),
      api.listWrongAnswers().catch(() => ({ items: [] })),
    ])
      .then(([resource, wrongBook]) => {
        if (cancelled) return;
        /* 老记录没有把选项下标写进测评详情：用错题本里的 user_answer 还原「你选了什么」 */
        const wrongPickById = new Map<string, number>();
        (wrongBook.items ?? []).forEach((item) => {
          if (typeof item.userAnswer === 'number') wrongPickById.set(String(item.questionId), item.userAnswer);
        });
        const state = (resource.state ?? {}) as Record<string, unknown>;
        const answered = Array.isArray(state.answered) ? state.answered as Record<string, unknown>[] : [];
        const answeredById = new Map<string, Record<string, unknown>>();
        answered.forEach((item) => answeredById.set(String(item.questionId ?? ''), item));
        const items: EvidenceQuestionItem[] = [];
        evidence.records.forEach((record, recordIndex) => {
          const details = parseQuizDetails(record.details);
          const questionId = typeof details.questionId === 'string' ? details.questionId : '';
          const question = questionId ? findQuestionRecord(resource.content, questionId) : null;
          if (!question) return;
          const answeredItem = answeredById.get(questionId);
          /* 错题本只对「这次答错」的题有效；答对的题可能残留旧错题记录，不能拿来当本次选择 */
          const wrongBookPick = record.correctCount > 0 ? null : (wrongPickById.get(questionId) ?? null);
          /* 资源 state 里的 answer 可能是字母（A/B/C/D），也可能是下标 */
          const rawAnswer = answeredItem?.answer;
          const letterIndex = typeof rawAnswer === 'string' && /^[a-z]$/i.test(rawAnswer.trim())
            ? rawAnswer.trim().toUpperCase().charCodeAt(0) - 65
            : null;
          /* 优先用测评记录里落库的选项下标（新记录都有），其次才是资源 state */
          const selectedIndex = typeof details.selectedIndex === 'number'
            ? details.selectedIndex
            : typeof answeredItem?.selectedIndex === 'number'
              ? answeredItem.selectedIndex
              : typeof answeredItem?.selectedAnswer === 'number'
                ? answeredItem.selectedAnswer
                : typeof wrongBookPick === 'number'
                  ? wrongBookPick
                  : letterIndex;
          items.push({
            questionId: questionId || `question-${recordIndex}`,
            question,
            selectedIndex,
            /* 以测评作答记录为准：资源 state 可能被历史数据污染（批量写入的种子数据一律 true） */
            correct: record.correctCount > 0,
          });
        });
        setEvidenceQuestions(items);
        setEvidenceIndex(0);
      })
      .catch(() => { if (!cancelled) setEvidenceQuestions([]); })
      .finally(() => { if (!cancelled) setEvidenceLoading(false); });
    return () => { cancelled = true; };
  }, [evidence]);

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

  /* 盲区候选：优先真实知识网络的章节/知识点；按学习路径顺序 + 低掌握度排序，供随机挑选 */
  const focusCandidates = useMemo<FocusKp[]>(() => {
    const order = new Map((learningMap.path ?? []).map((node, index) => [node.kpId, index]));
    return (learningMap.domains ?? [])
      .map((domain) => ({
        id: domain.id,
        name: domain.name,
        progress: Math.round(learningMap.chapterProgress[domain.id] ?? 0),
        mastery: Math.round(learningMap.mastery[domain.id] ?? 0),
      }))
      .sort((left, right) =>
        (order.get(left.id) ?? 99) - (order.get(right.id) ?? 99)
        || left.progress - right.progress
        || right.mastery - left.mastery,
      );
  }, [learningMap]);

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
    /* 能力成长曲线：优先用真实测评记录作为历史点，末端用当前综合能力分收口；
       不再用 W1-W8 的假趋势，避免没有真实历史时看起来像 mock。 */
    const quizTrendScores = (analytics?.recentQuizzes ?? [])
      .map((quiz) => quiz.score == null ? null : Math.round(quiz.score))
      .filter((score): score is number => score != null)
      .slice(-8);
    const currentAbilityScore = Math.max(0, Math.min(100, Math.round(avg)));
    const growthLabels = quizTrendScores.length
      ? [...quizTrendScores.map((_, index) => `第${index + 1}次测评`), '现在']
      : ['当前'];
    const growthTrend = quizTrendScores.length
      ? [...quizTrendScores, currentAbilityScore]
      : [currentAbilityScore];

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

    const courseResources = resources ?? [];
    const resourceTotal = courseResources.length;
    const resourceLearned = courseResources.filter((item) => item.learned).length;
    const resourceCoverage = resourceTotal ? resourceLearned / resourceTotal : 0;
    const topicNodes = learningMap.graphNodes.filter((node) => node.kind === 'topic');
    const topicTotal = topicNodes.length;
    const topicCovered = topicNodes.filter((node) =>
      (learningMap.topicProgress[node.id] ?? 0) > 0 || (learningMap.topicMastery[node.id] ?? 0) > 0,
    ).length;
    const topicCoverage = topicTotal ? topicCovered / topicTotal : 0;
    /* 知识覆盖率口径沿用原始算法：已完成资源 + 已开始/已形成掌握的知识点 */
    const knowledgeCoverage = Math.max(0, Math.min(100, Math.round((0.55 * resourceCoverage + 0.45 * topicCoverage) * 100)));
    const knowledgeCoverageNote = topicTotal > 0
      ? `完成 ${resourceLearned}/${resourceTotal} 个资源 · 覆盖 ${topicCovered}/${topicTotal} 个知识点`
      : `完成 ${resourceLearned}/${resourceTotal} 个学习资源`;
    const todayJournal = journals.find((journal) => journal.date === localDateKey(0)) ?? null;
    const todayStudySeconds = todayJournal?.stats.totalDurationSeconds ?? 0;

    return {
      learnerId: currentLearner.id,
      adaptScore,
      adaptTrend: growthTrend,
      weeks: growthLabels,
      abilityCurves,
      difficultyMatch,
      blindSpots: spots,
      path: pathNodes,
      summary: spots.length
        ? `当前最需优先补齐「${getKnowledgePoint(spots[0].kpId).name}」（差 ${spots[0].gap} 分），建议按路径顺序完成讲义、实操与分阶题。`
        : '六维能力均衡向好，保持当前学习节奏并定期测评即可。',
      generated: true,
      baselineHighSpots: focusStats.active + focusStats.resolved > 0
        ? focusStats.active + focusStats.resolved
        : spots.filter((spot) => spot.priority === '高').length,
      resolvedSpots: focusStats.resolved > 0
        ? focusStats.resolved
        : Math.max(0, Math.round(spots.filter((spot) => spot.gap <= 10).length / 2)),
      investHours: Number((todayStudySeconds / 3600).toFixed(1)),
      investNote: todayStudySeconds > 0 ? '今日学习时长' : '今天暂无学习记录',
      knowledgeCoverage,
      knowledgeCoverageNote,
    };
  }, [abilities, abilityScores, analytics, currentLearner, focusStats, journals, learningMap, resources]);
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

  /*
   * 计划完成度 / 资源偏好（W2）：两个都不新增接口，直接用页面上已经在手的两份真数据 ——
   *   计划完成度 = 知识网络章节进度与目标门槛（rag 树 + 学习事件算出来的 chapterProgress/mastery/nodeTargets）；
   *   资源偏好   = /learning-resources 返回的本人资源（讲义/实操/分阶题），加上 presentations 里已完成的交互课件（PPTX），按形态统计可用与已学。
   */
  const planChapters = learningMap.domains.map((chapter) => ({
    id: chapter.id,
    name: chapter.name,
    progress: Math.round(learningMap.chapterProgress[chapter.id] ?? 0),
    mastery: Math.round(learningMap.mastery[chapter.id] ?? 0),
    target: Math.round(learningMap.nodeTargets[chapter.id]?.target ?? 80),
  }));
  const planDone = planChapters.filter((chapter) => chapter.progress >= 100).length;
  const planAvg = planChapters.length
    ? Math.round(planChapters.reduce((sum, chapter) => sum + chapter.progress, 0) / planChapters.length)
    : 0;
  // 只列"已经动过"的章节：0% 的行只是把计划原样抄一遍，对决策没用
  const planTop = [...planChapters]
    .filter((chapter) => chapter.progress > 0)
    .sort((a, b) => b.progress - a.progress || b.mastery - a.mastery)
    .slice(0, 4);
  const completedPresentations = presentationSummaries.filter((item) => item.status === 'completed');
  const preferenceRows = [
    ...(['lecture', 'practice', 'quiz'] as const).map((type) => {
      const sameType = resources.filter((resource) => resource.type === type);
      return {
        type,
        total: sameType.length,
        learned: sameType.filter((resource) => resource.learned).length,
        started: sameType.filter((resource) => resource.started && !resource.learned).length,
      };
    }),
    {
      type: 'ppt' as const,
      total: completedPresentations.length,
      learned: completedPresentations.filter((item) => item.learned).length,
      started: 0,
    },
  ];
  /*
   * 学习目标（W8）：后端的 /api/v1/learning-goals 有 6 个接口，但前端一直没人用 ——
   * 报告页的"计划完成度"因此永远显示"还没有可对照的章节计划"。
   * 这里给一个最小的设定入口（领域 / 目标 / 目的 / 期望水平 / 期限），结构化的目标才能被统计。
   */
  const [goalFormOpen, setGoalFormOpen] = useState(false);
  const [goalDomains, setGoalDomains] = useState<{ id: number; name: string }[]>([]);
  const [goalDomainId, setGoalDomainId] = useState<string>('');
  const [goalTitle, setGoalTitle] = useState('');
  const [goalType, setGoalType] = useState('JOB_PREPARATION');
  const [goalLevel, setGoalLevel] = useState('PROFICIENT');
  const [goalTargetDate, setGoalTargetDate] = useState('');
  const [goalSaving, setGoalSaving] = useState(false);
  const [goalError, setGoalError] = useState('');
  const goalTypeLabels: { value: string; label: string }[] = [
    { value: 'JOB_PREPARATION', label: '求职准备' },
    { value: 'COURSE_STUDY', label: '系统学习一门课' },
    { value: 'PROJECT_DEVELOPMENT', label: '做项目' },
    { value: 'SKILL_IMPROVEMENT', label: '补技能' },
    { value: 'EXAM_PREPARATION', label: '应试' },
    { value: 'CUSTOM', label: '其他' },
  ];
  const goalLevelLabels: { value: string; label: string }[] = [
    { value: 'BEGINNER', label: '入门' },
    { value: 'ELEMENTARY', label: '能看懂' },
    { value: 'PROFICIENT', label: '能独立做' },
    { value: 'EXPERT', label: '能讲能带' },
  ];
  const openGoalForm = async () => {
    setGoalFormOpen(true);
    setGoalError('');
    if (!goalDomains.length) {
      try {
        const listed = await api.listRagDomains();
        setGoalDomains(listed.map((domain) => ({ id: domain.id, name: domain.name })));
        if (listed.length && !goalDomainId) setGoalDomainId(String(listed[0].id));
      } catch (reason) {
        setGoalError(reason instanceof Error ? reason.message : '领域列表读取失败');
      }
    }
  };
  const submitGoal = async () => {
    const title = goalTitle.trim();
    if (!goalDomainId || !title) { setGoalError('先把领域和目标写清楚'); return; }
    setGoalSaving(true);
    setGoalError('');
    try {
      const created = await api.createLearningGoal({
        knowledgeDomainId: Number(goalDomainId),
        goalType,
        title,
        expectedLevel: goalLevel,
        status: 'ACTIVE',
        targetDate: goalTargetDate || null,
      });
      await api.setCurrentLearningGoal(created.id);
      /* 同步回画像里的「学习目标」文本，避免我的画像页还显示旧目标 */
      void patchLearner(currentLearner.id, { goal: title }).catch(() => undefined);
      toast.success('学习目标已设定');
      setGoalFormOpen(false);
      setGoalTitle('');
      await loadReport();
    } catch (reason) {
      setGoalError(reason instanceof Error ? reason.message : '目标保存失败');
    } finally {
      setGoalSaving(false);
    }
  };

  const totalMinutesNote = (analytics?.stats.totalDays ?? 0) > 0
    ? `${analytics?.stats.totalDays ?? 0} 个学习日`
    : journalMinutes > 0
      ? '按学习会话滚动累计，暂无全量统计'
      : '完成学习后自动累计';
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

  /* 顶部“继续学习/进入课程”：与「我的学习」同口径 */
  const continueTarget = useMemo(() => {
    const mapActiveChapter = learningMap.activeKp
      ? learningMap.domains.find((domain) => domain.id === learningMap.activeKp)
      : null;
    const chapter = mapActiveChapter ?? weakestChapter;
    if (!chapter) return { chapterId: null, topicId: null };
    const topics = learningMap.graphNodes
      .filter((node) => node.kind === 'topic' && node.kpId === chapter.id)
      .sort((left, right) => (left.topicIndex ?? 99) - (right.topicIndex ?? 99));
    const topic = topics.find((node) => (learningMap.topicProgress[node.id] ?? 0) < 100) ?? topics[0] ?? null;
    return { chapterId: chapter.id, topicId: topic?.id ?? null };
  }, [learningMap, weakestChapter]);

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

  /** 测评证据按“同一次作答”合并：同资源、10 分钟内连续提交的单题记录合成一组 */
  const quizEvidenceGroups = useMemo(
    () => buildQuizEvidenceGroups(analytics?.recentQuizzes ?? []),
    [analytics],
  );
  const evidenceCurrent = evidenceQuestions[evidenceIndex] ?? null;

  const today = journals.find((journal) => journal.date === localDateKey(0)) ?? journals[0] ?? null;

  const exportReport = () => {
    const learnerName = currentLearner.name;
    const abilitiesData = abilities.map((ability) => ({ name: ability.name, score: ability.score, target: ability.targetLevel }));
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
    /* 近 7 天按天聚合：报告里用折线图 + 表格代替逐条流水 */
    const dailyData = Array.from({ length: 7 }, (_, index) => {
      const date = new Date();
      date.setDate(date.getDate() - (6 - index));
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const journal = journals.find((item) => item.date === key) ?? null;
      return {
        label: `${date.getMonth() + 1}/${date.getDate()}`,
        minutes: Math.round((journal?.stats.totalDurationSeconds ?? 0) / 60),
        resources: journal?.stats.resourceCount ?? 0,
        questions: journal?.stats.questionCount ?? 0,
        correct: journal?.stats.correctCount ?? 0,
      };
    });
    const resourceData = [
      { label: '讲义', kind: 'lecture' as const },
      { label: '实操', kind: 'practice' as const },
      { label: '分阶题', kind: 'quiz' as const },
    ].map(({ label, kind }) => {
      const same = resources.filter((resource) => resource.type === kind);
      return { label, total: same.length, learned: same.filter((resource) => resource.learned).length };
    }).concat([{
      label: '交互课件',
      total: completedPresentations.length,
      learned: completedPresentations.filter((item) => item.learned).length,
    }]);
    const currentGoal = analytics?.currentGoal ?? null;
    const today = journals.find((journal) => journal.date === localDateKey(0)) ?? journals[0] ?? null;
    const html = buildReportHtml({
      learnerName,
      generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      overallMastery,
      totalMinutes: totalMinutesShown,
      streakDays: analytics?.stats.streakDays ?? 0,
      accuracy,
      accuracyDetail: journalStats.questions ? `${journalStats.correct}/${journalStats.questions} 题答对` : '尚无测评提交',
      abilities: abilitiesData,
      weakestChapter: weakestChapter?.name ?? null,
      weakestDetail: weakestChapter
        ? `当前最弱章节是「${weakestChapter.name}」（掌握度 ${Math.round(learningMap.mastery[weakestChapter.id] ?? 0)}% · 进度 ${Math.round(learningMap.chapterProgress[weakestChapter.id] ?? 0)}%）。${weakestChapterDims}建议优先补齐该章节的资源与练习。`
        : '',
      courseTitle: course?.title ?? null,
      courseProgress: progress,
      chapters: chapterData,
      daily: dailyData,
      journalStats: {
        questions: journalStats.questions,
        correct: journalStats.correct,
        durationMinutes: Math.round(journalStats.durationSeconds / 60),
        resources: journalStats.resources,
      },
      todaySummary: today?.summary?.content ?? null,
      goal: currentGoal ? {
        title: currentGoal.title,
        type: currentGoal.goalType,
        level: currentGoal.expectedLevel,
        progress: currentGoal.progress,
      } : null,
      /* 同一批次（同资源、10 分钟内）的多道题合并成一条，避免每题一行 */
      quizzes: quizEvidenceGroups.slice(0, 6).map((group) => ({
        name: group.categoryName ?? '综合测评',
        type: group.quizType,
        time: new Date(group.createdAt).toLocaleString('zh-CN', { hour12: false }),
        summary: group.questionCount > 0
          ? `${group.correctCount}/${group.questionCount} 题 · 正确率 ${Math.round((group.correctCount / group.questionCount) * 100)}%`
          : '题级明细缺失',
        score: group.score == null
          ? (group.questionCount ? `${Math.round((group.correctCount / group.questionCount) * 100)}分` : '—')
          : `${Math.round(group.score)}分`,
      })),
      resources: resourceData,
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

  const summarizingRef = useRef(false);
  const generateSummary = useCallback(async () => {
    if (summarizingRef.current) return;
    const hasRecords = Boolean(today?.timeline.length)
      || rangeJournals.some((journal) => journal.date === localDateKey(0) && journal.timeline.length > 0);
    if (!hasRecords) return;
    summarizingRef.current = true;
    setSummarizing(true);
    try {
      const updated = await api.generateLearningJournalSummary(localDateKey(0));
      setJournals((previous) => [updated, ...previous.filter((journal) => journal.date !== updated.date)]);
      if (isUuid(currentLearner.id)) writeLearnerJournal(currentLearner.id, updated.date, updated);
    } catch {
      /* 自动生成失败时保留占位文案，不打断阅读 */
    } finally {
      summarizingRef.current = false;
      setSummarizing(false);
    }
  }, [currentLearner.id, rangeJournals, today]);

  /* 进入页面且今天有学习记录、还没有小结时自动生成一次 */
  const autoSummaryRef = useRef(false);
  useEffect(() => {
    if (loading || autoSummaryRef.current) return;
    if (!today?.timeline.length || today.summary) return;
    autoSummaryRef.current = true;
    void generateSummary();
  }, [generateSummary, loading, today]);

  if (loading || courseLoading) {
    return <div className="mx-auto max-w-[1100px] px-6 py-16 text-center text-[14px] text-ink-muted">正在汇总学习数据…</div>;
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
      <motion.header initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="lf-mono-label mb-2">LEARNING EVIDENCE REPORT</div>
          <h1 className="font-serif text-[34px] font-bold text-ink">{currentLearner.name}的学习成长</h1>
        </div>
        <button type="button" onClick={exportReport} className="lf-btn-ghost !px-4 !py-2 text-[13px]">
          <FileDown size={15} /> 导出 / 打印报告
        </button>
      </motion.header>

      <section className="grid gap-4 lg:grid-cols-[0.9fr_0.9fr_1.3fr]">
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
        <div className="lf-card border-brand/25 bg-brand-tint/25 p-5">
          <div className="flex items-center gap-2 text-[12px] text-ink-muted">
            <Sparkles size={15} className="text-brand" />
            下一步建议
          </div>
          <div className="mt-3 text-[15px] font-semibold text-ink">
            {weakestChapter ? `优先补齐「${weakestChapter.name}」` : '先完成一次学习'}
          </div>
          <p className="mt-1.5 text-[12.5px] leading-5 text-ink-muted">
            {weakestChapter ? `当前最弱章节是「${weakestChapter.name}」（掌握度 ${Math.round(learningMap.mastery[weakestChapter.id] ?? 0)}% · 进度 ${Math.round(learningMap.chapterProgress[weakestChapter.id] ?? 0)}%）。${weakestChapterDims}${nextResource ? `建议继续“${nextChapter?.title ?? nextResource.topic}”中的${resourceLabel[nextResource.type]}。` : '先生成对应章节的讲义与分阶题，形成可验证的学习证据。'}` : '先完成一次学习，能力与画像数据会随证据累积。'}
          </p>
          <button
              type="button"
              onClick={() => navigate(learnMapPath(currentLearner.id, continueTarget.chapterId, continueTarget.topicId))}
            className="lf-btn-primary mt-3 !px-3.5 !py-2 text-[12.5px]"
          >
            {nextResource ? '继续学习' : '进入课程'} <ArrowRight size={14} />
          </button>
        </div>
      </section>

      {/* 计划完成度 + 资源偏好（W2 补齐） */}
      <section className="mt-12">
        <SectionHeader
          en="PLAN & PREFERENCE"
          title="计划完成度与资源偏好"
          desc="左边看计划走到哪，右边看你实际用什么形式在学；两个数字都能追到来源。"
        />
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="lf-card p-5">
            <div className="flex items-center gap-2 text-[12px] text-ink-muted">
              <Route size={15} className="text-brand" />
              计划完成度
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-1">
              <span className="font-serif text-[30px] font-semibold text-ink">
                {analytics?.currentGoal ? Math.round(analytics.currentGoal.progress) : planAvg}%
              </span>
              <span className="pb-1 text-[12.5px] text-ink-muted">
                {analytics?.currentGoal
                  ? `学习目标「${analytics.currentGoal.title}」的推进度`
                  : planChapters.length
                    ? `${planDone}/${planChapters.length} 章完成 · 平均推进 ${planAvg}%`
                    : '还没有可对照的章节计划'}
              </span>
            </div>
      {/* 学习目标（W8）：没有结构化目标时给最小设定入口，有目标就只留一个"改目标" */}
      {goalFormOpen ? (
        <div className="mt-4 space-y-2.5 border-t border-hairline pt-3">
          <div className="flex flex-wrap gap-2">
            <select
              value={goalDomainId}
              onChange={(event) => setGoalDomainId(event.target.value)}
              aria-label="学习领域"
              className="h-9 rounded-[10px] border border-hairline bg-paper px-2.5 text-[12.5px] text-ink-2"
            >
              {goalDomains.map((domain) => <option key={domain.id} value={String(domain.id)}>{domain.name}</option>)}
            </select>
            <select
              value={goalType}
              onChange={(event) => setGoalType(event.target.value)}
              aria-label="学习目的"
              className="h-9 rounded-[10px] border border-hairline bg-paper px-2.5 text-[12.5px] text-ink-2"
            >
              {goalTypeLabels.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            <select
              value={goalLevel}
              onChange={(event) => setGoalLevel(event.target.value)}
              aria-label="期望水平"
              className="h-9 rounded-[10px] border border-hairline bg-paper px-2.5 text-[12.5px] text-ink-2"
            >
              {goalLevelLabels.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            <input
              type="date"
              value={goalTargetDate}
              onChange={(event) => setGoalTargetDate(event.target.value)}
              aria-label="期望完成日期"
              className="h-9 rounded-[10px] border border-hairline bg-paper px-2.5 text-[12.5px] text-ink-2"
            />
          </div>
          <input
            value={goalTitle}
            onChange={(event) => setGoalTitle(event.target.value)}
            placeholder="用一句话说清目标，例如：三个月内能独立搭一个 RAG 应用"
            aria-label="目标标题"
            className="h-9 w-full rounded-[10px] border border-hairline bg-paper px-3 text-[13px] text-ink outline-none focus:border-brand/50"
          />
          {goalError && <p className="text-[12px] text-brand-danger">{goalError}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={goalSaving} onClick={() => void submitGoal()} className="lf-btn-primary !px-3.5 !py-1.5 text-[12.5px] disabled:opacity-60">
              {goalSaving ? '保存中…' : '保存目标'}
            </button>
            <button type="button" onClick={() => setGoalFormOpen(false)} className="lf-btn-ghost !px-3.5 !py-1.5 text-[12.5px]">取消</button>
            <span className="text-[11.5px] text-ink-muted">目标会存进你的档案，「计划完成度」以后按它算。</span>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => void openGoalForm()} className="lf-btn-ghost mt-3 !px-3.5 !py-1.5 text-[12.5px]">
          {analytics?.currentGoal ? '改学习目标' : '设定学习目标'}
        </button>
      )}
            <div className="mt-4 space-y-3">
              {planTop.map((chapter) => (
                <div key={chapter.id}>
                  <div className="flex items-center justify-between gap-3 text-[12.5px]">
                    <span className="truncate text-ink-2">{chapter.name}</span>
                    <span className="shrink-0 font-mono text-[11px] text-ink-muted">
                      进度 {chapter.progress}% · 掌握 {chapter.mastery}% / 目标 {chapter.target}%
                    </span>
                  </div>
                  <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-hairline">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-brand"
                      style={{ width: `${Math.min(100, chapter.progress)}%` }}
                    />
                  </div>
                </div>
              ))}
              {planTop.length === 0 && <p className="text-[12.5px] text-ink-muted">还没有推进中的章节：从「学 · 练」挑一章开始，这里会列出推进最快的几章。</p>}
            </div>
          </div>

          <div className="lf-card p-5">
            <div className="flex items-center gap-2 text-[12px] text-ink-muted">
              <BookOpen size={15} className="text-brand" />
              资源偏好
            </div>
            <div className="mt-4 space-y-4">
              {preferenceRows.map((row) => {
                const pct = row.total ? Math.round((row.learned / row.total) * 100) : 0;
                return (
                  <div key={row.type}>
                    <div className="flex items-center justify-between text-[12.5px]">
                      <span className="text-ink-2">{resourceLabel[row.type]}</span>
                      <span className="font-mono text-[11px] text-ink-muted">
                        可用 {row.total} 份 · 已学 {row.learned}{row.started ? ` · 在读 ${row.started}` : ''}
                      </span>
                    </div>
                    <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-hairline">
                      <div
                        className="absolute inset-y-0 left-0 rounded-full bg-ochre"
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
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
        <div className="mb-5">
          <BlindFocusBoard
            learnerId={currentLearner.id}
            pending={focusCandidates}
            onStatsChange={setFocusStats}
          />
        </div>
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_440px]">
          <div className="min-w-0 space-y-5">
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
                {activeMatchTab === 'path' && <PathRoadmap learner={reportLearner} report={visualReport} tree={learningMap.tree} />}
              </div>
            </div>
            <GrowthTrendChart report={visualReport} />
          </div>
          <div className="space-y-5">
            <StreakCalendar
              streakDays={analytics?.stats.streakDays ?? 0}
              studyDates={analytics?.stats.studyDates ?? []}
              totalDays={analytics?.stats.totalDays ?? 0}
            />
            <WeeklyAdviceCard learner={reportLearner} report={visualReport} resources={resources} nodes={learningMap.graphNodes} fallbackTarget={continueTarget} />
          </div>
        </div>
      </section>
      <section className="mt-12">
        <SectionHeader en="GROWTH" title="近 7 天成长轨迹" desc="" />
        <div className="grid gap-5 lg:grid-cols-[1.25fr_0.75fr]">
          <div className="lf-card p-5">
            <div className="mb-2 text-[14px] font-semibold text-ink">每日学习时长</div>
            <ReactECharts option={weeklyOption(analytics?.stats.weeklyMinutes ?? Array(7).fill(0))} height={270} />
          </div>
          <div className="lf-card p-5">
            <div>
              <div className="text-[14px] font-semibold text-ink">今日学习小结</div>
              <div className="mt-1 text-[11px] text-ink-muted">{today?.date ?? localDateKey(0)}</div>
            </div>
            {today?.summary ? (
              <p className="mt-5 rounded-[12px] border border-brand/20 bg-brand-tint/35 p-4 text-[13px] leading-6 text-ink-2">{today.summary.content}</p>
            ) : (
              <div className="mt-5 rounded-[12px] border border-dashed border-hairline p-5 text-[13px] leading-6 text-ink-muted">{summarizing ? '正在根据今天的学习记录生成小结…' : today?.timeline.length ? `今天已有 ${today.timeline.length} 条学习记录，正在整理今日小结。` : '今天还没有形成学习轨迹。完成资源、练习或导学后会自动生成小结。'}</div>
            )}
            <div className="mt-5 grid grid-cols-2 gap-3 text-center">
              <div className="rounded-[10px] bg-paper-deep p-3"><div className="font-mono text-[20px] font-semibold text-ink">{journalStats.resources}</div><div className="mt-1 text-[10.5px] text-ink-muted">近 7 天资源记录</div></div>
              <div className="rounded-[10px] bg-paper-deep p-3"><div className="font-mono text-[20px] font-semibold text-ink">{Math.round(journalStats.durationSeconds / 60)}</div><div className="mt-1 text-[10.5px] text-ink-muted">近 7 天记录分钟</div></div>
            </div>
          </div>
        </div>
      </section>

      {quizEvidenceGroups.length ? (
        <section className="mt-12">
          <SectionHeader en="ASSESSMENTS" title="最近测评证据" />
          <div className="lf-card divide-y divide-hairline overflow-hidden">
            {quizEvidenceGroups.slice(0, 6).map((group) => (
              <button
                key={group.key}
                type="button"
                onClick={() => setEvidence(group)}
                className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-brand-tint/25"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-tint text-brand"><BookOpen size={16} /></span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium text-ink">{group.categoryName ?? '综合测评'}</div>
                  <div className="mt-1 font-mono text-[10.5px] text-ink-muted">
                    {group.quizType} · {new Date(group.createdAt).toLocaleString('zh-CN', { hour12: false })}
                    {group.questionCount > 0 ? ` · ${group.correctCount}/${group.questionCount} 题` : ''}
                  </div>
                </div>
                <span className="font-mono text-[20px] font-semibold text-brand">{group.score == null ? '—' : `${Math.round(group.score)}分`}</span>
                <ChevronRight size={15} className="shrink-0 text-ink-muted/50" />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {evidence && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setEvidence(null); }}
        >
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-h-[86vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-hairline bg-paper p-6 shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="lf-mono-label">ASSESSMENT EVIDENCE</div>
                <h3 className="mt-2 text-lg font-bold text-ink">{evidence.categoryName ?? '综合测评'}</h3>
                <p className="mt-1 font-mono text-[11px] text-ink-muted">
                  {evidence.quizType} · {new Date(evidence.createdAt).toLocaleString('zh-CN', { hour12: false })}
                </p>
              </div>
              <button type="button" onClick={() => setEvidence(null)} className="rounded-lg border border-hairline p-2 text-ink-muted hover:text-ink" aria-label="关闭测评证据">
                <X size={16} />
              </button>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([
                ['得分', evidence.score == null ? '—' : `${Math.round(evidence.score)} 分`],
                ['正确题数', `${evidence.correctCount}/${evidence.questionCount}`],
                ['用时', evidence.durationSeconds == null ? '—' : `${evidence.durationSeconds} 秒`],
                ['难度', evidence.difficultyLevel ?? '—'],
              ] as Array<[string, string]>).map(([label, value]) => (
                <div key={label} className="rounded-xl bg-white/70 px-3 py-2.5">
                  <p className="text-[10px] text-ink-muted">{label}</p>
                  <p className="mt-1 text-[13px] font-semibold text-ink">{value}</p>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-xl border border-hairline bg-white/60 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[11px] font-semibold text-ink-muted">题目与作答依据</p>
                {evidenceQuestions.length > 1 && (
                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={evidenceIndex <= 0}
                      onClick={() => setEvidenceIndex((index) => Math.max(0, index - 1))}
                      className="inline-flex items-center gap-0.5 rounded-lg border border-hairline px-2 py-1 text-[10.5px] text-ink-2 transition-colors hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <ChevronLeft size={12} />上一题
                    </button>
                    <span className="font-mono text-[10.5px] text-ink-muted">{evidenceIndex + 1}/{evidenceQuestions.length}</span>
                    <button
                      type="button"
                      disabled={evidenceIndex >= evidenceQuestions.length - 1}
                      onClick={() => setEvidenceIndex((index) => Math.min(evidenceQuestions.length - 1, index + 1))}
                      className="inline-flex items-center gap-0.5 rounded-lg border border-hairline px-2 py-1 text-[10.5px] text-ink-2 transition-colors hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      下一题<ChevronRight size={12} />
                    </button>
                  </div>
                )}
              </div>
              {evidenceLoading ? (
                <p className="mt-3 flex items-center gap-2 text-[12px] text-ink-muted"><Loader2 size={13} className="animate-spin" />正在读取原始题目…</p>
              ) : evidenceCurrent ? (
                (() => {
                  const question = evidenceCurrent.question;
                  const options = Array.isArray(question.options) ? question.options as unknown[] : [];
                  const rawAnswer = question.correctIndex ?? question.answerIndex ?? question.correctAnswer;
                  const correctIndex = typeof rawAnswer === 'number'
                    ? rawAnswer
                    : typeof rawAnswer === 'string' && /^[A-Za-z]$/.test(rawAnswer)
                      ? rawAnswer.toUpperCase().charCodeAt(0) - 65
                      : options.findIndex((option) => String(option) === String(rawAnswer));
                  return (
                    <div className="mt-3">
                      <p className="text-[13.5px] font-medium leading-6 text-ink">{String(question.stem ?? question.title ?? '题目')}</p>
                      {options.length > 0 && (
                        <div className="mt-3 space-y-1.5">
                          {options.map((option, optionIndex) => {
                            const isCorrect = optionIndex === correctIndex;
                            const isPicked = evidenceCurrent.selectedIndex === optionIndex;
                            return (
                              <div
                                key={optionIndex}
                                className={cn(
                                  'flex items-start gap-2 rounded-lg px-3 py-2 text-[12px] leading-5',
                                  isCorrect
                                    ? 'bg-emerald-50 font-semibold text-emerald-800 ring-1 ring-emerald-200'
                                    : isPicked
                                      ? 'bg-red-50 text-red-700 ring-1 ring-red-200'
                                      : 'bg-[#F3F5F0] text-ink-2',
                                )}
                              >
                                <span className="font-bold">{String.fromCharCode(65 + optionIndex)}.</span>
                                <span className="min-w-0 flex-1">{String(option)}</span>
                                {isPicked && <span className="shrink-0 rounded bg-white/70 px-1.5 py-0.5 text-[9.5px] font-normal">{isCorrect ? '你的答案' : '你的答案 ✕'}</span>}
                                {isCorrect && !isPicked && <span className="shrink-0 rounded bg-white/70 px-1.5 py-0.5 text-[9.5px] font-normal">正确答案</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {Boolean(question.explanation ?? question.analysis) && (
                        <p className="mt-3 rounded-lg bg-brand-tint/40 px-3 py-2 text-[12px] leading-5 text-ink-2">解析：{String(question.explanation ?? question.analysis)}</p>
                      )}
                      {options.length > 0 && evidenceCurrent.selectedIndex != null
                        && evidenceCurrent.selectedIndex >= 0 && evidenceCurrent.selectedIndex < options.length && (
                        <p className="mt-2 text-[12px] leading-5 text-ink-2">
                          你的答案：<b className={evidenceCurrent.correct ? 'text-emerald-700' : 'text-red-700'}>{String.fromCharCode(65 + evidenceCurrent.selectedIndex)}. {String(options[evidenceCurrent.selectedIndex])}</b>
                          {!evidenceCurrent.correct && correctIndex >= 0 && correctIndex < options.length && (
                            <span className="text-ink-muted"> · 正确答案：{String.fromCharCode(65 + correctIndex)}. {String(options[correctIndex])}</span>
                          )}
                        </p>
                      )}
                      <p className="mt-2 font-mono text-[10.5px] text-ink-muted">{evidenceCurrent.correct ? '本题作答正确' : '本题作答错误'}</p>
                    </div>
                  );
                })()
              ) : (
                <p className="mt-3 text-[12px] leading-5 text-ink-muted">
                  {evidence.resourceId ? '未能读到本次作答的题目明细（资源可能已更新或删除）。' : '整卷测评记录，没有单题明细。'}
                </p>
              )}
            </div>

          </motion.div>
        </div>
      )}
    </div>
  );
}
