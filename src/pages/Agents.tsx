/**
 * 多智能体协同调度 `/agents` — agents.md 实现（全站核心页）
 * S1 协同控制台(sticky) + 实时指标条(MetricsBar) → S2 五体泳道拓扑 + S3 实时消息流
 * → S4 辩论与交叉验证 → S5 仲裁决策日志 → S6 本轮协同小结
 *
 * 联动：
 *  - useProfile 全局画像切换 → getCollabScript 按最弱知识点重排 16 条事件 → 重置并重播
 *  - 深链 ?autoplay=1 进页自动播放（总览页 CTA）；?agent=DIA-01 高亮定位泳道并过滤时间线
 *  - 顶栏「演示模式」开启时进页自动播放
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { useProfile } from '@/context/ProfileContext';
import { getCollabScript } from '@/data/collabScript';
import type { AgentId } from '@/data/agents';
import { agents } from '@/data/agents';
import ControlBar from '@/components/agents/ControlBar';
import MetricsBar from '@/components/agents/MetricsBar';
import SwimlaneBoard from '@/components/agents/SwimlaneBoard';
import MessageTimeline from '@/components/agents/MessageTimeline';
import type { TimelineFilter } from '@/components/agents/MessageTimeline';
import DebatePanel from '@/components/agents/DebatePanel';
import DecisionLog from '@/components/agents/DecisionLog';
import SummaryBanner from '@/components/agents/SummaryBanner';
import { usePlayback } from '@/components/agents/usePlayback';
import { getScriptIndices, getStages, scenarioMeta } from '@/components/agents/scriptModel';
import type { Scenario } from '@/components/agents/scriptModel';
import RealTeachingRunView from '@/components/agents/RealTeachingRunView';
import type { TeachingGroupRunPayload } from '@/lib/api';
import CourseRunView from '@/components/agents/CourseRunView';
import { api } from '@/lib/api';
import type { Course } from '@/lib/api';

const validAgentId = (v: string | null): AgentId | null =>
  v && agents.some((a) => a.id === v) ? (v as AgentId) : null;

export default function Agents() {
  const [searchParams] = useSearchParams();
  const autoplay = searchParams.get('autoplay') === '1';
  const agentParam = validAgentId(searchParams.get('agent'));
  const { currentLearner, currentLearnerId, demoMode } = useProfile();
  const location = useLocation();
  const teachingRun = (location.state as { teachingRun?: TeachingGroupRunPayload } | null)?.teachingRun;
  const courseMode = searchParams.get('run') === 'course';
  const [course, setCourse] = useState<Course | null>(null);
  const [courseLoading, setCourseLoading] = useState(courseMode);

  useEffect(() => {
    if (!courseMode) return;
    api.listCourses()
      .then((result) => setCourse(result.courses?.[0] ?? null))
      .catch(() => setCourse(null))
      .finally(() => setCourseLoading(false));
  }, [courseMode]);

  /* 画像驱动脚本（知识点/标题/事件内容全部随学习者重导） */
  const script = useMemo(() => getCollabScript(currentLearnerId), [currentLearnerId]);
  const playback = usePlayback(script.events);
  const indices = useMemo(() => getScriptIndices(script.events), [script.events]);
  const stages = useMemo(() => getStages(indices), [indices]);

  const [scenario, setScenario] = useState<Scenario>('lecture');
  const [filter, setFilter] = useState<TimelineFilter>(agentParam ?? 'ALL');
  const [autoScroll, setAutoScroll] = useState(true);

  /* 辩论开始自动滚动定位：cursor 首次越过 r1Challenge 时滚到 S4 辩论区块（每次播放 run 一次） */
  const debateSectionRef = useRef<HTMLDivElement>(null);
  const debateScrolledRef = useRef(false);
  useEffect(() => {
    if (playback.cursor === 0) {
      debateScrolledRef.current = false;
      return;
    }
    if (debateScrolledRef.current) return;
    if (playback.status !== 'running') return;
    if (indices.r1Challenge < 0 || playback.cursor <= indices.r1Challenge) return;
    debateScrolledRef.current = true;
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    debateSectionRef.current?.scrollIntoView({
      behavior: reduced ? 'auto' : 'smooth',
      block: 'start',
    });
  }, [playback.cursor, playback.status, indices.r1Challenge]);

  /* 供各一次性副作用调用的最新引用 */
  const playRef = useRef(playback.play);
  playRef.current = playback.play;
  const statusRef = useRef(playback.status);
  statusRef.current = playback.status;

  /* ?autoplay=1 / 演示模式：进页自动播放（一次） */
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStartedRef.current || (!autoplay && !demoMode)) return undefined;
    autoStartedRef.current = true;
    const t = window.setTimeout(() => playRef.current(), 600);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 演示模式后开启：待命状态下自动播放 */
  useEffect(() => {
    if (demoMode && statusRef.current === 'idle') playRef.current();
  }, [demoMode]);

  /* 切换画像：toast + 重置（usePlayback 内随 events 身份自动重置）+ 按新脚本重播 */
  const prevLearnerRef = useRef(currentLearnerId);
  useEffect(() => {
    if (prevLearnerRef.current === currentLearnerId) return undefined;
    prevLearnerRef.current = currentLearnerId;
    toast.success(`协同脚本已按 ${currentLearner.name} 的画像重排`, {
      description: `聚焦知识点：${script.kpName} · ${script.resourceTitle} · 脚本事件 ${script.events.length} 条`,
    });
    const t = window.setTimeout(() => playRef.current(), 800);
    return () => window.clearTimeout(t);
  }, [currentLearnerId, currentLearner.name, script]);

  const onScenarioChange = (s: Scenario) => {
    if (s === scenario) return;
    setScenario(s);
    playback.reset();
    toast.info(`场景已切换：${scenarioMeta[s].label}`, {
      description: '脚本已重置，点击「运行协同演示」观看新场景协同流程',
    });
  };

  const onSelectAgent = (id: AgentId) => {
    setFilter((f) => (f === id ? 'ALL' : id));
  };

  const blockedCount = script.events.filter(
    (e) => e.content.includes('幻觉拦截') || (e.payload ?? '').includes('hallucination_blocked'),
  ).length;

  if (teachingRun && teachingRun.events.length > 0) {
    return <RealTeachingRunView run={teachingRun} learnerName={currentLearner.name} />;
  }

  if (courseMode && courseLoading) {
    return <div className="mx-auto max-w-[980px] px-6 py-16 text-center text-[14px] text-ink-muted">正在读取真实课程生成记录…</div>;
  }

  if (courseMode && course) {
    return <CourseRunView course={course} learnerName={currentLearner.name} />;
  }

  if (courseMode && !course) {
    return <div className="mx-auto max-w-[980px] px-6 py-16 text-center text-[14px] text-ink-muted">还没有生成课程，请先进入“学”页生成我的课程。</div>;
  }

  return (
    <div className="mx-auto max-w-[1320px] px-8 pb-16 pt-6">
      {/* S1 协同控制台 */}
      <ControlBar
        learnerName={currentLearner.name}
        kpName={script.kpName}
        scenario={scenario}
        onScenarioChange={onScenarioChange}
        playback={playback}
        stages={stages}
      />

      {/* 本轮协同实时指标条 */}
      <MetricsBar script={script} cursor={playback.cursor} />

      {/* S2 泳道拓扑 + S3 消息流 */}
      <div className="mt-6 grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <SwimlaneBoard
            script={script}
            learner={currentLearner}
            cursor={playback.cursor}
            status={playback.status}
            focusAgent={agentParam}
            onSelectAgent={onSelectAgent}
          />
        </div>
        <div className="lg:col-span-5">
          <MessageTimeline
            events={script.events}
            cursor={playback.cursor}
            base={playback.playStartedAt}
            filter={filter}
            onFilterChange={setFilter}
            autoScroll={autoScroll}
            onAutoScrollChange={setAutoScroll}
            stepMode={playback.stepMode}
            status={playback.status}
            onStep={playback.stepOnce}
          />
        </div>
      </div>

      {/* S4 辩论与交叉验证 */}
      <div ref={debateSectionRef} className="scroll-mt-28">
        <DebatePanel
          script={script}
          cursor={playback.cursor}
          base={playback.playStartedAt}
          status={playback.status}
          stepMode={playback.stepMode}
        />
      </div>

      {/* S5 仲裁决策日志 */}
      <DecisionLog
        script={script}
        cursor={playback.cursor}
        base={playback.playStartedAt}
        learner={currentLearner}
      />

      {/* S6 本轮协同小结 */}
      <SummaryBanner
        status={playback.status}
        totalT={playback.totalT}
        msgCount={script.events.length}
        blockedCount={blockedCount}
        scenarioLabel={scenarioMeta[scenario].label}
      />
    </div>
  );
}
