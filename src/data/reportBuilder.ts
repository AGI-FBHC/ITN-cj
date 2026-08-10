/**
 * reportBuilder — 自建画像的学情报告"现算"生成器
 *
 * 预设 3 画像保留 reportData 的静态富数据（评委测试用例，有完整 8 周叙事）；
 * 自建画像不再借用预设报告，而是由三份真数据现场推导：
 *   1. 画像分数（含阿诊写回后的最新值）→ 盲区 / 适配分 / 难度匹配曲线
 *   2. 画像事件时间线（lf.events 的 writeback 增量）→ 成长曲线重放 + Agent 介入点
 *   3. 复习记录（lf.review，学过才有）→ 路径节点 done/active/todo
 * 刚建档 = 单点基线 + 全 todo 路径 + 零投入——没有任何伪造的历史。
 */
import type { Learner } from '@/data/learners';
import { knowledgePoints, getKnowledgePoint } from '@/data/knowledgePoints';
import {
  getReportFor,
  type LearnerReport,
  type BlindSpot,
  type PathNode,
} from '@/data/reportData';

/* 与 ProfileContext.ProfileEvent 对齐的最小结构（避免 data 层反向依赖 context） */
interface StoredEvent {
  week: string;
  kind: 'create' | 'edit' | 'writeback';
  title: string;
  detail?: string;
  deltas?: { kpId: string; from: number; to: number }[];
}

const K_EVENTS = 'lf.events';
const K_REVIEW = 'lf.review';

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 写回事件，旧 → 新 */
function writebacksOf(learnerId: string): StoredEvent[] {
  const all = readJSON<Record<string, StoredEvent[]>>(K_EVENTS, {});
  return (all[learnerId] ?? [])
    .filter((e) => e.kind === 'writeback' && e.deltas && e.deltas.length > 0)
    .slice()
    .reverse();
}

/** 学过的知识点（复习记录里有档案即学过；自建画像不播种，全部来自真实学习） */
function learnedKpsOf(learnerId: string): Set<string> {
  const all = readJSON<Record<string, Record<string, unknown>>>(K_REVIEW, {});
  return new Set(Object.keys(all[learnerId] ?? {}));
}

/** 学习动作数（园子养分明细条数，估算学习投入用） */
function actionCountOf(learnerId: string): number {
  const all = readJSON<Record<string, { log?: unknown[] }>>('lf.growth', {});
  return all[learnerId]?.log?.length ?? 0;
}

const mean = (s: Record<string, number>) =>
  knowledgePoints.reduce((acc, kp) => acc + (s[kp.id] ?? 50), 0) / knowledgePoints.length;

const std = (s: Record<string, number>) => {
  const m = mean(s);
  const v = knowledgePoints.reduce((acc, kp) => acc + ((s[kp.id] ?? 50) - m) ** 2, 0) / knowledgePoints.length;
  return Math.sqrt(v);
};

/** 适配分：能力分布越集中，同一难度档资源越"合身"；写回补短板 → 离散度降 → 适配升 */
const adaptOf = (s: Record<string, number>) =>
  Math.round(Math.max(55, Math.min(94, 92 - std(s) * 1.3)) * 10) / 10;

const INTERVENTION_COLORS = ['#4E7860', '#E7B45A', '#B77552'];

export function buildReportFor(l: Learner): LearnerReport {
  const scores = l.scores;
  const base = getReportFor(l.dataBaseId ?? 'lin');

  /* ============ 1. 盲区：自己的分数 vs 目标要求 ============ */
  const spots: BlindSpot[] = knowledgePoints
    .map((kp) => {
      const score = scores[kp.id] ?? 50;
      const gap = kp.targetLevel - score;
      const baseSuggestion = base.blindSpots.find((b) => b.kpId === kp.id)?.suggestion;
      return {
        kpId: kp.id,
        score,
        target: kp.targetLevel,
        gap,
        priority: (gap >= 30 ? '高' : gap >= 15 ? '中' : '低') as BlindSpot['priority'],
        suggestion: baseSuggestion ?? `从《${kp.name}》基础讲义起步，配检查点巩固`,
      };
    })
    .filter((b) => b.gap > 0)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 4);
  /* 全维达标的极端情况兜底：保底给 2 条最小缺口，报告组件不至于空转 */
  if (spots.length < 2) {
    knowledgePoints
      .map((kp) => ({ kp, gap: kp.targetLevel - (scores[kp.id] ?? 50) }))
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 2)
      .forEach(({ kp, gap }) => {
        if (!spots.some((s) => s.kpId === kp.id)) {
          spots.push({
            kpId: kp.id,
            score: scores[kp.id] ?? 50,
            target: kp.targetLevel,
            gap: Math.max(gap, 1),
            priority: '低',
            suggestion: `保持性复习《${kp.name}》，防遗忘回退`,
          });
        }
      });
  }

  /* ============ 2. 成长曲线：建档基线 + 写回事件重放 ============ */
  const evs = writebacksOf(l.id);
  /* 从当前分数倒放 deltas 还原建档基线 */
  const baseline: Record<string, number> = {};
  knowledgePoints.forEach((kp) => { baseline[kp.id] = scores[kp.id] ?? 50; });
  for (let i = evs.length - 1; i >= 0; i--) {
    evs[i].deltas!.forEach((d) => { baseline[d.kpId] = d.from; });
  }
  const steps: Record<string, number>[] = [{ ...baseline }];
  const weeks: string[] = ['建档'];
  let cur = { ...baseline };
  evs.forEach((e) => {
    cur = { ...cur };
    e.deltas!.forEach((d) => { cur[d.kpId] = d.to; });
    steps.push({ ...cur });
    weeks.push(e.week);
  });
  const adaptTrend = steps.map(adaptOf);
  const adaptScore = adaptTrend[adaptTrend.length - 1];
  const abilityCurves = knowledgePoints.map((kp) => ({
    kpId: kp.id,
    points: steps.map((s) => s[kp.id] ?? 50),
  }));

  /* Agent 介入点：最近 3 次写回事件（真数据，替代静态 W3/W5/W7） */
  const interventions = evs.slice(-3).map((e, i) => ({
    week: e.week,
    title: e.title,
    desc: e.detail ?? '阿诊依据学习信号写回画像',
    color: INTERVENTION_COLORS[i % INTERVENTION_COLORS.length],
  }));

  /* ============ 3. 难度匹配曲线：能力 → 理想难度档的钟形适配 ============ */
  const ideal = 1 + (4 * mean(scores)) / 100;
  const difficultyMatch = [1, 2, 3, 4, 5].map((difficulty) => ({
    difficulty,
    fit: Math.max(6, Math.round(97 * Math.exp(-((difficulty - ideal) ** 2) / (2 * 1.15 ** 2)))),
  }));

  /* ============ 4. 路径：缺口大的先学，学过的标 done，没有伪造的"已完成" ============ */
  const learned = learnedKpsOf(l.id);
  const metaByKp = new Map(base.path.map((n) => [n.kpId, n] as const));
  const ordered = [...knowledgePoints].sort((a, b) => {
    /* 安全规范不达标必须最先补——工业场景硬约束 */
    const aSafety = a.id === 'kp-safety' && (scores[a.id] ?? 50) < 60 ? 1 : 0;
    const bSafety = b.id === 'kp-safety' && (scores[b.id] ?? 50) < 60 ? 1 : 0;
    if (aSafety !== bSafety) return bSafety - aSafety;
    return (b.targetLevel - (scores[b.id] ?? 50)) - (a.targetLevel - (scores[a.id] ?? 50));
  });
  let activeAssigned = false;
  const path: PathNode[] = ordered.map((kp, i) => {
    const meta = metaByKp.get(kp.id);
    const isDone = learned.has(kp.id);
    let status: PathNode['status'] = 'todo';
    if (isDone) status = 'done';
    else if (!activeAssigned) { status = 'active'; activeAssigned = true; }
    /* est 不继承预设模板——预设的「已完成/第 4 周解锁/下周」是别人的排期，
       新用户的节点一律给时长估计 */
    return {
      id: `gp${i + 1}`,
      title: meta?.title ?? `${kp.name}系统学习`,
      kpId: kp.id,
      status,
      est: isDone ? '已完成' : '1 课时',
      resourceRef: meta?.resourceRef ?? `《${kp.name}》定制讲义`,
    };
  });

  /* ============ 5. 评分带辅助数（避免借用预设的 8 周叙事） ============ */
  const baselineHigh = knowledgePoints.filter((kp) => kp.targetLevel - (baseline[kp.id] ?? 50) >= 30).length;
  const currentHigh = spots.filter((b) => b.priority === '高').length;
  const actions = actionCountOf(l.id);

  const weakest = getKnowledgePoint(spots[0].kpId);
  return {
    learnerId: l.id,
    generated: true,
    adaptScore,
    adaptTrend,
    weeks,
    abilityCurves,
    difficultyMatch,
    blindSpots: spots,
    path,
    interventions,
    baselineHighSpots: baselineHigh,
    resolvedSpots: Math.max(0, baselineHigh - currentHigh),
    investHours: Math.round(actions * 0.5 * 10) / 10,
    investNote: actions > 0 ? `按 ${actions} 次学习动作估算 · 建档后实时累计` : '刚建档 · 学习时长从现在开始累计',
    summary: `由画像实时生成：最弱「${weakest.name}」（缺口 ${spots[0].gap}），路径按缺口降序排定，学习信号将持续写回并重排。`,
  };
}

/** 统一取报告入口：预设 → 静态富数据；自建 → 现算 */
export function reportForLearner(l: Learner): LearnerReport {
  return l.custom ? buildReportFor(l) : getReportFor(l.id);
}
