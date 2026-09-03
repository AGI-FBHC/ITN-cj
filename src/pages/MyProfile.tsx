/**
 * MyProfile `/me/profile` — 「我的画像」活页
 * 可编辑：六维滑杆 / 盲区 chip / 目标；学习证据与时间线读取 Spring 学习分析数据。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { Save, Sparkles, Brain, History, HelpCircle, Clock3, Flame, ClipboardCheck, ArrowRight, Trash2, RefreshCw, X } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { useLearningMap } from '@/hooks/useLearningMap';
import { deriveAbilityScores } from '@/lib/abilityAdjust';
import { api, streamProfileAnalysis, type ProfileAnalysisEvent } from '@/lib/api';
import {
  readLearnerAnalytics,
  writeLearnerAnalytics,
  readLearnerJournal,
  writeLearnerJournal,
  bustLearnerJournal,
} from '@/lib/dataCache';
import type { LearnerAnalyticsProfile, LearnerGrowth, LearningJournal, OnboardingKnowledgePoint, UserMemory } from '@/lib/api';
import { weightedScore } from '@/components/profiles/profileMeta';
import { ReactECharts } from '@/components/ChartCard';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import PageBack from '@/components/PageBack';
import ConfidenceBadge from '@/components/ConfidenceBadge';
import { cn } from '@/lib/utils';

function radarOption(
  kps: OnboardingKnowledgePoint[],
  scores: Record<string, number>,
  confidence?: Record<string, number>,
) {
  return {
    animationDuration: 500,
    radar: {
      indicator: kps.map((kp) => {
        const c = confidence?.[kp.id] ?? 100;
        /* 标签实度 = 伴学助手对该维判断的置信度（弱证据维度淡显） */
        return { name: kp.name, max: 100, color: `rgba(70, 100, 80,${(0.3 + 0.7 * (c / 100)).toFixed(2)})` };
      }),
      radius: '66%',
      center: ['50%', '54%'] as [string, string],
      axisName: { color: '#5A6553', fontSize: 11, fontFamily: '"Noto Sans SC", sans-serif' },
      splitLine: { lineStyle: { color: '#E9E3D4' } },
      splitArea: { areaStyle: { color: ['rgba(253,252,249,0)', 'rgba(240,235,224,0.5)'] } },
      axisLine: { lineStyle: { color: '#DCE6DE' } },
    },
    legend: { bottom: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8, data: ['当前能力'] },
    series: [
      {
        type: 'radar' as const,
        data: [
          {
            value: kps.map((kp) => scores[kp.id] ?? 50),
            name: '当前能力',
            symbolSize: 4,
            lineStyle: { color: '#4E7860', width: 2.5 },
            itemStyle: { color: '#4E7860' },
            areaStyle: { color: 'rgba(78, 120, 96,0.24)' },
          },
        ],
      },
    ],
  };
}

const evidenceMeta: Record<string, { label: string; cls: string }> = {
  focus: { label: '专注', cls: 'border-brand/30 bg-brand-tint text-brand' },
  resource: { label: '资源', cls: 'border-ochre/40 bg-ochre-tint text-ochre' },
  quiz: { label: '测评', cls: 'border-brand-amber/50 bg-brand-amber-tint text-ochre' },
  chat: { label: '导学', cls: 'border-brand/30 bg-brand-tint text-brand' },
  knowledge: { label: '画像', cls: 'border-hairline bg-paper-deep text-ink-muted' },
};

const memoryTypeLabel: Record<UserMemory['namespace'], string> = {
  profile: '基本情况', goal: '学习目标', preference: '学习偏好', knowledge: '学习状态',
  misconception: '待巩固内容', learning_strategy: '有效方法', episodic: '近期学习',
};

function localDateKey(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

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

const LEGACY_KP_IDS: Record<string, string> = {
  'kp-ds': 'kp-plc',
  'kp-co': 'kp-kinematics',
  'kp-os': 'kp-sensor',
  'kp-network': 'kp-vision',
  'kp-db': 'kp-safety',
  'kp-agent': 'kp-diagnosis',
};

export default function MyProfile() {
  const { currentLearner, patchLearner, domainKnowledgePoints } = useProfile();
  const [analytics, setAnalytics] = useState<LearnerAnalyticsProfile | null>(null);
  const [journals, setJournals] = useState<LearningJournal[]>([]);
  const [growth, setGrowth] = useState<LearnerGrowth | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(true);
  const [evidenceError, setEvidenceError] = useState('');
  const [saving, setSaving] = useState(false);
  const [memories, setMemories] = useState<UserMemory[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(true);

  const loadMemories = useCallback(async () => {
    setMemoryLoading(true);
    try {
      const result = await api.listMemories();
      setMemories(result.items ?? []);
    } catch {
      setMemories([]);
    } finally {
      setMemoryLoading(false);
    }
  }, []);

  const loadEvidence = useCallback(async () => {
    setEvidenceLoading(true);
    setEvidenceError('');
    try {
      const learnerId = currentLearner.id;
      const dates = Array.from({ length: 7 }, (_, index) => localDateKey(index));
      const today = dates[0];
      const cachedAnalytics = isUuid(learnerId) ? readLearnerAnalytics(learnerId) : null;
      if (cachedAnalytics) setAnalytics(cachedAnalytics);
      const cachedJournals = dates.map((date) => (isUuid(learnerId) ? readLearnerJournal(learnerId, date, date === today) : null));
      const hitJournals = cachedJournals.filter((journal): journal is LearningJournal => journal !== null);
      if (hitJournals.length) setJournals(hitJournals);
      const missingDates = dates.filter((_date, index) => !cachedJournals[index]);
      const [profile, learnerGrowth, freshJournals] = await Promise.all([
        cachedAnalytics ? Promise.resolve(null) : api.getLearnerAnalyticsProfile(),
        isUuid(learnerId) ? api.getLearnerGrowth(learnerId) : Promise.resolve(null),
        Promise.all(missingDates.map((date) => api.getLearningJournal(date))),
      ]);
      setAnalytics(profile ?? cachedAnalytics);
      setGrowth(learnerGrowth);
      setJournals([...hitJournals, ...freshJournals]);
      if (isUuid(learnerId)) {
        if (profile) writeLearnerAnalytics(learnerId, profile);
        freshJournals.forEach((journal) => writeLearnerJournal(learnerId, journal.date, journal));
      }
    } catch (reason) {
      setEvidenceError(reason instanceof Error ? reason.message : '学习证据读取失败');
    } finally {
      setEvidenceLoading(false);
    }
  }, [currentLearner.id]);

  useEffect(() => {
    void loadEvidence();
  }, [currentLearner.id, loadEvidence]);

  useEffect(() => {
    void loadMemories();
  }, [currentLearner.id, loadMemories]);

  /* ===== 画像记忆驱动更新 ===== */
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysisText, setAnalysisText] = useState('');
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  const [proposedScores, setProposedScores] = useState<Record<string, number> | null>(null);

  const startAnalysis = useCallback(async () => {
    setAnalysisOpen(true);
    setAnalysisText('');
    setAnalysisError('');
    setAnalysisLoading(true);
    setProposedScores(null);
    const controller = new AbortController();
    try {
      await streamProfileAnalysis((event: ProfileAnalysisEvent) => {
        if (event.type === 'no_data') {
          setAnalysisError(event.message || '最近没有新的学习数据');
          setAnalysisLoading(false);
        } else if (event.type === 'delta') {
          setAnalysisText((prev) => prev + (event.content || ''));
        } else if (event.type === 'done') {
          setAnalysisText(event.analysis || '');
          setProposedScores(event.currentScores || null);
          setAnalysisLoading(false);
        } else if (event.type === 'error') {
          setAnalysisError(event.message || '分析失败');
          setAnalysisLoading(false);
        }
      }, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) {
        setAnalysisError(err instanceof Error ? err.message : '分析请求失败');
      }
    } finally {
      setAnalysisLoading(false);
    }
  }, []);

  const applyScores = useCallback(async () => {
    if (!proposedScores) return;
    try {
      await api.updateLearnerScores(proposedScores);
      setScores(proposedScores);
      setAnalysisOpen(false);
      toast.success('六维能力已更新');
    } catch {
      toast.error('保存失败');
    }
  }, [proposedScores]);

  useEffect(() => {
    const bustToday = () => {
      if (!isUuid(currentLearner.id)) return;
      bustLearnerJournal(currentLearner.id, localDateKey(0));
    };
    window.addEventListener('lf-signal', bustToday);
    window.addEventListener('lf:learning-state-changed', bustToday);
    return () => {
      window.removeEventListener('lf-signal', bustToday);
      window.removeEventListener('lf:learning-state-changed', bustToday);
    };
  }, [currentLearner.id]);

  const kps = domainKnowledgePoints;

  const normalizedScores = useMemo(() => {
    const base = currentLearner.scores;
    return kps.reduce((acc, kp) => {
      acc[kp.id] = base[kp.id] ?? base[LEGACY_KP_IDS[kp.id] ?? ''] ?? 50;
      return acc;
    }, {} as Record<string, number>);
  }, [currentLearner, kps]);



  const learningMap = useLearningMap();

  // 盲区标签动态取“最近学习过的知识点”：有学习进度或掌握度即算学过，按进度降序

  const recentTopics = useMemo(() => {

    const learned = learningMap.graphNodes.filter(

      (t) => t.kind === 'topic' && ((learningMap.topicProgress[t.id] ?? 0) > 0 || (learningMap.topicMastery[t.id] ?? 0) > 0),

    );

    return [...learned]

      .sort(

        (a, b) => (learningMap.topicProgress[b.id] ?? 0) - (learningMap.topicProgress[a.id] ?? 0)

          || (learningMap.topicMastery[b.id] ?? 0) - (learningMap.topicMastery[a.id] ?? 0),

      )

      .slice(0, 12);

  }, [learningMap]);

  // 六维能力 = 画像基础值 + 学习证据（章节/知识点 完成进度×掌握度 加权），只读展示

  const displayScores = useMemo(

    () => deriveAbilityScores(learningMap, normalizedScores),

    [learningMap, normalizedScores],

  );



  const [scores, setScores] = useState<Record<string, number>>(normalizedScores);
  const [blind, setBlind] = useState<string[]>(currentLearner.blindSpots);
  const [goal, setGoal] = useState(currentLearner.goal);

  /* 切换学习者或知识维度时重置编辑态 */
  useEffect(() => {
    setScores(normalizedScores);

    setBlind(currentLearner.blindSpots);

    setGoal(currentLearner.goal);
  }, [currentLearner.id, kps, normalizedScores]);

  const evidence = useMemo(() => {
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
  }, [growth, journals]);

  const deltas = useMemo(
    () =>
      kps
        .map((kp) => ({ kpId: kp.id, from: normalizedScores[kp.id] ?? 50, to: scores[kp.id] ?? 50 }))
        .filter((d) => d.from !== d.to),
    [kps, scores, normalizedScores],
  );
  const dirty = deltas.length > 0 || goal !== currentLearner.goal;

  const sorted = [...kps].map((kp) => ({ kp, s: displayScores[kp.id] ?? 50 })).sort((a, b) => a.s - b.s);
  const weakest = sorted[0];

  const diaLine = weakest
    ? `当前最弱「${weakest.kp.name}」${weakest.s} 分，距目标 ${Math.max(0, weakest.kp.targetLevel - weakest.s)} 分。${
        dirty ? '保存后我会据此重排学习路径。' : '画像与路径已同步。'
      }`
    : '';

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await patchLearner(currentLearner.id, {
        scores,
        goal,
        blindSpots: blind,
      });
      try {
        if (isUuid(currentLearner.id)) {
          await api.recordLearnerGrowthEvent({
            learnerId: currentLearner.id,
            eventType: 'profile_edit',
            title: '手动更新学情画像',
            amount: 0,
            metadata: {
              description: deltas.length ? `调整 ${deltas.length} 个能力维度，并重新确认目标与盲区` : '重新确认学习目标与知识盲区',
            },
          });
        }
      } catch {
        toast.warning('画像已保存，但学习时间线暂未写入');
      }
      await loadEvidence();
      toast.success('画像已保存', { description: '修改已持久化，后续真实练习会继续补充诊断证据' });
    } catch (reason) {
      toast.error('画像保存失败', { description: reason instanceof Error ? reason.message : '请稍后重试' });
    } finally {
      setSaving(false);
    }
  };

  if (kps.length === 0) {
    return (
      <div className="mx-auto max-w-[980px] px-5 pb-24 pt-8 md:px-6">
        <PageBack parent={{ label: '我的学习', to: '/me' }} current="我的画像" />
        <div className="lf-card mt-6 p-8 text-center text-[13.5px] text-ink-muted">
          画像知识维度加载中，请稍候…
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[980px] px-5 pb-24 pt-8 md:px-6">
      <PageBack parent={{ label: '我的学习', to: '/me' }} current="我的画像" />
      {/* 头部 */}
      <div className="flex flex-wrap items-center gap-4">
        <Avatar className="h-14 w-14 border border-hairline shadow-warm">
          <AvatarImage src={currentLearner.avatar} alt={currentLearner.name} />
          <AvatarFallback className="bg-brand-tint text-brand">{currentLearner.name.slice(0, 1)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <h1 className="font-serif text-[24px] font-semibold text-ink">
            {currentLearner.name} · 我的画像
            {currentLearner.custom && (
              <span className="ml-2 rounded-md border border-brand/30 bg-brand-tint px-1.5 py-0.5 align-middle font-mono text-[10px] text-brand">自建</span>
            )}
          </h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-muted">
            <span>{currentLearner.tag} · {currentLearner.targetJob} · 综合适配 {weightedScore({ scores: displayScores }, kps)} 分</span>
            <ConfidenceBadge learnerId={currentLearner.id} />
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* 左：可编辑 */}
        <div className="space-y-5">
          <div className="lf-card space-y-3 p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="lf-mono-label !text-[11px]">六维能力（随学习进度动态更新）</div>
                {dirty && <span className="font-mono text-[11px] text-ochre">未保存</span>}
              </div>
              <button type="button" onClick={() => void startAnalysis()} title="基于最近学习数据更新六维能力" className="lf-row-btn !p-1.5">
                <RefreshCw size={13} className={analysisLoading ? "animate-spin" : ""} />
              </button>
            </div>
            {kps.map((kp) => (
              <div key={kp.id}>
                <div className="mb-1 flex items-center justify-between text-[12.5px]">

                  <span className="text-ink-2">{kp.name}</span>

                  <span className="font-mono">

                    <span className="font-semibold text-brand">{displayScores[kp.id] ?? 50}</span>

                    <span className="text-ink-muted"> / 目标 {kp.targetLevel}</span>

                  </span>

                </div>

                <div className="relative h-2 w-full overflow-hidden rounded-full bg-paper-deep">

                  <div className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${displayScores[kp.id] ?? 50}%` }} />

                </div>
              </div>
            ))}

            <p className="border-t border-hairline pt-2 text-[10.5px] leading-[15px] text-ink-muted">

              六维能力 = 画像基础值 + 学习证据（各章节知识点「完成进度 × 掌握度」按维度权重折算），只读展示，随学习动态更新。

            </p>

          </div>

          <div className="lf-card p-5">
            <div className="lf-mono-label mb-2 !text-[11px]">盲区标签（点选增删）</div>
            <div className="flex flex-wrap gap-2">

              {recentTopics.length ? recentTopics.map((topic) => {

                const name = topic.label;

                const on = blind.includes(name);

                return (

                  <button

                    key={topic.id}

                    type="button"

                    onClick={() => setBlind((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]))}

                    className={cn(

                      'rounded-lg border px-2.5 py-1 text-[12.5px] font-medium transition-all',

                      on ? 'border-brand-danger/50 bg-brand-danger/10 text-brand-danger' : 'border-hairline bg-paper text-ink-muted hover:border-brand/40',

                    )}

                  >

                    {name}

                  </button>

                );

              }) : (

                <p className="text-[12px] leading-5 text-ink-muted">还没有学习记录，学过的知识点会动态出现在这里。</p>

              )}

            </div>
          </div>

          <div className="lf-card p-5">
            <div className="lf-mono-label mb-2 !text-[11px]">学习目标</div>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-[10px] border border-hairline bg-paper px-3 py-2 text-[13.5px] leading-[21px] text-ink outline-none focus:border-brand/50"
            />
          </div>

          {/* DIA 重诊断 + 保存 */}
          <div className="flex items-start gap-3 rounded-[12px] border border-brand/20 bg-brand-tint/40 p-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-brand text-paper">
              <Brain size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="lf-mono-label !text-[10px]">DIA-01 实时诊断</div>
              <p className="mt-0.5 text-[13px] leading-[20px] text-ink-2">{diaLine}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving}
              className={cn('lf-btn-primary !py-2 text-[13.5px]', (!dirty || saving) && 'cursor-not-allowed opacity-50')}
            >
              <Save size={15} />
              {saving ? '正在保存…' : '保存修改'}
            </button>
            <Link to="/me/calibrate" className="lf-btn-ghost !py-2 text-[13.5px]">
              <Sparkles size={15} />
              用真实练习校准画像
            </Link>
          </div>
          <div className="lf-card p-5">
            <div className="mb-1 flex items-center gap-2">
              <Brain size={16} className="text-brand" />
              <span className="text-[15px] font-semibold text-ink">我的学习记忆</span>
            </div>
            <p className="mb-3 text-[11.5px] leading-5 text-ink-muted">
              这些信息会用于资源定制、AI 辅导和学习推荐。学习进度来自真实操作，你也可以删除不希望继续使用的记忆。
            </p>
            {memoryLoading ? (
              <div className="py-5 text-center text-[12px] text-ink-muted">正在整理学习记忆…</div>
            ) : memories.length === 0 ? (
              <div className="rounded-[10px] bg-paper-deep px-3 py-4 text-center text-[12px] text-ink-muted">完成学习或测评后，相关记忆会出现在这里。</div>
            ) : (
              <div className="space-y-2">
                {memories.slice(0, 12).map((memory) => (
                  <div key={memory.id} className="flex items-start gap-3 rounded-[10px] border border-hairline bg-paper px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="rounded-md bg-brand-tint px-1.5 py-0.5 text-[10px] font-medium text-brand">{memoryTypeLabel[memory.namespace]}</span>
                        <span className="font-mono text-[9.5px] text-ink-muted">可信度 {Math.round(memory.confidence * 100)}%</span>
                      </div>
                      <p className="mt-1 text-[12.5px] leading-5 text-ink-2">{memory.summary}</p>
                    </div>
                    <button
                      type="button"
                      aria-label="删除这条学习记忆"
                      onClick={async () => {
                        try {
                          await api.deleteMemory(memory.id);
                          setMemories((items) => items.filter((item) => item.id !== memory.id));
                          toast.success('已删除这条学习记忆');
                        } catch (error) {
                          toast.error(error instanceof Error ? error.message : '删除失败');
                        }
                      }}
                      className="mt-0.5 rounded-md p-1.5 text-ink-muted transition hover:bg-brand-danger/10 hover:text-brand-danger"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 右：雷达 + 时间线 */}
        <div className="space-y-5">
          <div className="lf-card p-5">
            <div className="lf-mono-label mb-1 !text-[11px]">画像向量 · 六维能力</div>
            <ReactECharts option={radarOption(kps, displayScores)} height={320} />
            <p className="mt-1 border-t border-hairline pt-2 text-[11px] leading-[16px] text-ink-muted">
              当前能力来自已保存画像；下方实测掌握度与诊断证据只统计后端已经记录的真实学习和测评行为。
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="lf-card p-3.5">
              <Clock3 size={15} className="text-brand" />
              <div className="mt-2 font-mono text-[20px] font-semibold text-ink">{analytics?.stats.totalStudyMinutes ?? 0}<span className="ml-1 text-[10px] font-normal text-ink-muted">min</span></div>
              <div className="mt-0.5 text-[11px] text-ink-muted">累计学习</div>
            </div>
            <div className="lf-card p-3.5">
              <Flame size={15} className="text-ochre" />
              <div className="mt-2 font-mono text-[20px] font-semibold text-ink">{analytics?.stats.streakDays ?? 0}<span className="ml-1 text-[10px] font-normal text-ink-muted">天</span></div>
              <div className="mt-0.5 text-[11px] text-ink-muted">连续学习</div>
            </div>
            <div className="lf-card p-3.5">
              <ClipboardCheck size={15} className="text-brand" />
              <div className="mt-2 font-mono text-[20px] font-semibold text-ink">{analytics?.recentQuizzes.length ?? 0}</div>
              <div className="mt-0.5 text-[11px] text-ink-muted">近期测评</div>
            </div>
            <div className="lf-card p-3.5">
              <Brain size={15} className="text-brand" />
              <div className="mt-2 font-mono text-[20px] font-semibold text-ink">{Math.round((analytics?.mastery.overall ?? 0) * 100)}<span className="ml-1 text-[10px] font-normal text-ink-muted">%</span></div>
              <div className="mt-0.5 text-[11px] text-ink-muted">实测掌握度</div>
            </div>
          </div>

          <div className="lf-card p-5">
            <div className="mb-3 flex items-center gap-2">
              <History size={16} className="text-brand" />
              <span className="text-[15px] font-semibold text-ink">近 7 天诊断证据</span>
            </div>
            {evidenceLoading ? (
              <div className="py-8 text-center text-[13px] text-ink-muted">正在读取后端学习记录…</div>
            ) : evidenceError ? (
              <div className="py-7 text-center">
                <p className="text-[13px] text-brand-danger">{evidenceError}</p>
                <button type="button" onClick={() => void loadEvidence()} className="lf-btn-ghost mt-3 !px-3 !py-1.5 text-[12px]">重新读取</button>
              </div>
            ) : evidence.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <p className="max-w-[360px] text-[13px] leading-5 text-ink-muted">近 7 天还没有学习证据。完成真实讲义、练习或导学后，记录会自动出现在这里。</p>
                <Link to="/learn" className="lf-btn-ghost !px-4 !py-2 text-[13px]">
                  <Sparkles size={14} />
                  开始真实课程
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                {evidence.slice(0, 12).map((ev, i) => {
                  const meta = evidenceMeta[ev.kind] ?? evidenceMeta.knowledge;
                  return (
                    <motion.div
                      key={ev.id}
                      initial={{ opacity: 0, x: -12 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.04 }}
                      className="relative border-l-2 border-hairline pl-4"
                    >
                      <span className="absolute -left-[5px] top-1.5 h-2 w-2 rounded-full bg-brand" />
                      <div className="flex items-center gap-2">
                        <span className={cn('rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium', meta.cls)}>
                          {meta.label}
                        </span>
                        <span className="font-mono text-[10.5px] text-ink-muted">{evidenceTime(ev.occurredAt)}</span>
                      </div>
                      <div className="mt-1 text-[13.5px] font-medium text-ink">{ev.title}</div>
                      <div className="mt-0.5 text-[12px] leading-[18px] text-ink-muted">{ev.description}</div>
                      {(ev.knowledgeName || ev.correctCount != null) && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5 font-mono text-[10.5px] text-ink-muted">
                          {ev.knowledgeName && <span className="rounded-md bg-paper-deep px-1.5 py-0.5">{ev.knowledgeName}</span>}
                          {ev.correctCount != null && <span className="rounded-md bg-paper-deep px-1.5 py-0.5">答对 {ev.correctCount} · 答错 {ev.wrongCount ?? 0}</span>}
                        </div>
                      )}
                    </motion.div>
                  );
                })}
              </div>
            )}
            <Link to="/report" className="mt-4 flex items-center justify-center gap-1 border-t border-hairline pt-3 text-[12.5px] font-medium text-brand">
              查看完整学情报告 <ArrowRight size={13} />
            </Link>
          </div>


          <div className="space-y-2">
            {/* 帮助入口：把各页的一次性提示重新打开 */}
            <button
              type="button"
              onClick={() => {
                /* 只清当前学习者的已读记录，不影响同机其他用户 */
                Object.keys(localStorage)
                  .filter((k) => k.startsWith(`lf.tip.${currentLearner.id}.`))
                  .forEach((k) => localStorage.removeItem(k));
                try {
                  const raw = localStorage.getItem('lf.guideSeen');
                  if (raw && raw !== '1') {
                    const map = JSON.parse(raw) as Record<string, 1>;
                    delete map[currentLearner.id];
                    localStorage.setItem('lf.guideSeen', JSON.stringify(map));
                  } else {
                    localStorage.removeItem('lf.guideSeen');
                  }
                } catch { /* ignore */ }
                toast.success('页面引导已重新打开', {
                  description: '回到相关页面时会再次显示操作引导',
                });
              }}
              className="flex w-full items-center justify-center gap-2 rounded-[10px] border border-hairline bg-card-warm py-2 text-[13px] font-medium text-ink-2 transition-all hover:border-brand/40 hover:text-brand"
            >
              <HelpCircle size={14} />
              查看操作引导
            </button>

          </div>
        </div>
      </div>

      {/* 画像记忆驱动更新弹窗 */}
      {analysisOpen && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-ink/35 p-4 backdrop-blur-sm">
          <div className="lf-card flex h-[min(80vh,640px)] w-full max-w-2xl flex-col overflow-hidden rounded-3xl shadow-2xl">
            <div className="flex shrink-0 items-center justify-between border-b border-hairline px-5 py-4">
              <div>
                <h3 className="text-[15px] font-semibold text-ink">六维能力分析</h3>
                <p className="mt-0.5 text-[11px] text-ink-muted">基于最近学习记忆自动分析</p>
              </div>
              <button type="button" onClick={() => setAnalysisOpen(false)} className="lf-row-btn !p-2"><X size={15} /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {analysisError ? (
                <div className="py-8 text-center text-[13px] text-ink-muted">{analysisError}</div>
              ) : analysisLoading && !analysisText ? (
                <div className="py-8 text-center text-[13px] text-ink-muted">
                  <RefreshCw size={16} className="mx-auto mb-2 animate-spin text-brand" />
                  正在分析学习数据…
                </div>
              ) : (
                <div className="prose prose-sm max-w-none text-[13px] leading-6 text-ink-2 whitespace-pre-wrap">{analysisText}</div>
              )}
            </div>
            {proposedScores && (
              <div className="flex shrink-0 items-center justify-end gap-3 border-t border-hairline px-5 py-3">
                <button type="button" onClick={() => setAnalysisOpen(false)} className="lf-btn-ghost !px-3 !py-1.5 text-[12px]">取消</button>
                <button type="button" onClick={() => void applyScores()} className="lf-btn-primary !px-3 !py-1.5 text-[12px]">应用更新</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
