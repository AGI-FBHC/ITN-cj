import { useRef, useState } from 'react';
import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, Loader2, Route, Check } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { useLearningMap } from '@/hooks/useLearningMap';
import KnowledgeGraph3D from '@/components/learn/KnowledgeGraph3D';
import UnitQuickList from '@/components/learn/UnitQuickList';
import ChapterSidebar, { type SidebarResource } from '@/components/learn/ChapterSidebar';
import { Fern, GrassTuft } from '@/components/heal/Flora';
import { cn } from '@/lib/utils';

const statusMeta: Record<string, { label: string; cls: string }> = {
  active: { label: '路径中 · 本周', cls: 'border-brand-amber/50 bg-brand-amber-tint text-ochre' },
  todo: { label: '路径中 · 待学', cls: 'border-hairline bg-paper-deep text-ink-2' },
  done: { label: '已完成', cls: 'border-brand/30 bg-brand-tint text-brand' },
};

interface LearnViewState {
  selectedKp: string | null;
  selectedTopic: number | null;
  expandedKpIds: string[];
  showLearnedPath: boolean;
  showTopicEdges: boolean;
}

const learnViewKey = (learnerId: string) => `lf.learnView:v1:${learnerId}`;
const cameraReturnKey = (learnerId: string) => `lf.knowledgeGraph3dReturn:v1:${learnerId}`;

function consumeCameraReturn(learnerId: string): boolean {
  if (!learnerId || typeof window === 'undefined') return false;
  try {
    const key = cameraReturnKey(learnerId);
    const restore = window.sessionStorage.getItem(key) === 'breadcrumb';
    window.sessionStorage.removeItem(key);
    return restore;
  } catch { return false; }
}

function readLearnView(learnerId: string): LearnViewState | null {
  if (!learnerId || typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(learnViewKey(learnerId)) ?? 'null') as Partial<LearnViewState> | null;
    if (!parsed || !Array.isArray(parsed.expandedKpIds)) return null;
    return {
      selectedKp: typeof parsed.selectedKp === 'string' ? parsed.selectedKp : null,
      selectedTopic: typeof parsed.selectedTopic === 'number' ? parsed.selectedTopic : null,
      expandedKpIds: parsed.expandedKpIds.filter((id): id is string => typeof id === 'string'),
      showLearnedPath: Boolean(parsed.showLearnedPath),
      showTopicEdges: parsed.showTopicEdges !== false,
    };
  } catch { return null; }
}


export default function Learn() {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const [restoreMapState] = useState(() => consumeCameraReturn(currentLearner.id));
  /* 每次进入 learn 页面重置 3D 视图状态 */
  const restoredView: LearnViewState | null = null;
  const map = useLearningMap();
  const knowledgePoints = map.domains;
  const reportPath = map.path;
  /** “我的已学路径”：高亮已学章节/资源 */
  const [showLearnedPath, setShowLearnedPath] = useState(() => restoredView?.showLearnedPath ?? false);
  const [showTopicEdges, setShowTopicEdges] = useState(false);
  const [selectedKp, setSelectedKp] = useState<string | null>(() => restoredView?.selectedKp ?? null);
  const [expandedKpIds, setExpandedKpIds] = useState<Set<string>>(() => new Set(restoredView?.expandedKpIds ?? []));
  /** 3D：点击章节切换展开/收起，可同时展开多个 */
  const toggleExpandedKp = (id: string) => {
    setExpandedKpIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  /** 章节速览只展开单个章节 */
  const setSingleExpandedKp = (id: string | null) => {
    setExpandedKpIds(id === null ? new Set() : new Set([id]));
  };
  const [selectedTopic, setSelectedTopic] = useState<number | null>(() => restoredView?.selectedTopic ?? null);
  /** 章节速览点击后，请求 3D 相机把该域节点转到正前方 */
  const [graphFocus, setGraphFocus] = useState<{ id: string; at: number } | null>(null);
  /** 深链：?unitTopic= 定位子知识点（展开功能节点层，与手点知识点一致） */
  const [focusTopic, setFocusTopic] = useState<{ id: string; at: number } | null>(null);
  const [searchParams] = useSearchParams();
  useEffect(() => {
    if (!currentLearner.id || currentLearner.id === 'loading') return;
    try {
      window.sessionStorage.setItem(learnViewKey(currentLearner.id), JSON.stringify({
        selectedKp,
        selectedTopic,
        expandedKpIds: Array.from(expandedKpIds),
        showLearnedPath,
        showTopicEdges,
      } satisfies LearnViewState));
    } catch { /* sessionStorage 不可用时保持当前内存状态 */ }
  }, [currentLearner.id, selectedKp, selectedTopic, expandedKpIds, showLearnedPath, showTopicEdges]);
  // kp 参数只应用一次：地图数据分多次到达会导致本 effect 反复执行，
  // 每次都重新触发相机聚焦会造成“展开后视角又变一次”，这里用 ref 去重。
  const appliedKpParamRef = useRef<string | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const kpParam = searchParams.get('kp');
    const unitTopic = searchParams.get('unitTopic');
    if (!kpParam) {
      appliedKpParamRef.current = null;
      return;
    }
    const domainNode = map.graphNodes.find((node) => node.kind === 'domain' && (node.id === kpParam || node.kpId === kpParam));
    const topicNode = map.graphNodes.find((node) => node.kind === 'topic' && node.id === kpParam);
    if (!domainNode && !topicNode) return;
    const chapterId = domainNode?.id ?? topicNode?.kpId ?? kpParam;
    const topicId = topicNode?.id ?? unitTopic ?? null;
    const deepKey = `${chapterId}:${topicId ?? ''}`;
    if (appliedKpParamRef.current === deepKey) return;
    appliedKpParamRef.current = deepKey;
    // 首页“今天就学这一件/去学这块”进入：先跳转页面（默认 3D 视图），
    // 页面就绪后再模拟点击“章节速览”对应章节（与真实点击同一套逻辑，相机只动一次）
    if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    focusTimerRef.current = window.setTimeout(() => {
      focusTimerRef.current = null;
      setSelectedKp(chapterId);
      setSelectedTopic(null);
      setSingleExpandedKp(chapterId);
      setGraphFocus({ id: chapterId, at: Date.now() });
      // 深链到子知识点：展开功能节点层并选中（对应 3D 里点击知识点的效果）
      if (topicId) {
        const targetTopic = map.graphNodes.find((node) => node.kind === 'topic' && node.id === topicId);
        if (targetTopic) {
          setFocusTopic({ id: targetTopic.id, at: Date.now() });
          setSelectedTopic(targetTopic.topicIndex ?? null);
        }
      } else {
        setFocusTopic(null);
      }
    }, 450);
  }, [searchParams, knowledgePoints, map.graphNodes]);
  useEffect(() => () => {
    if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
  }, []);

  const pathStatusOf = (kpId: string): string | null => {
    const nodes = reportPath.filter((n) => n.kpId === kpId);
    if (nodes.some((n) => n.status === 'active')) return 'active';
    if (nodes.some((n) => n.status === 'todo')) return 'todo';
    if (nodes.length && nodes.every((n) => n.status === 'done')) return 'done';
    return null;
  };

  /* ---------- 右侧章节侧栏（W2）：选中章节 → 核心技能 + 推荐资源 ---------- */
  const sidebarChapter = (() => {
    if (selectedKp) {
      const picked = knowledgePoints.find((kp) => kp.id === selectedKp);
      if (picked) return picked;
    }
    const active = map.activeKp ? knowledgePoints.find((kp) => kp.id === map.activeKp) : null;
    if (active) return active;
    // 没选中也没有"在学"的章节时，退到最弱的一章 —— 与首页"今天就学这一件"同一套判断
    return [...knowledgePoints].sort((a, b) => (map.mastery[a.id] ?? 0) - (map.mastery[b.id] ?? 0))[0] ?? null;
  })();
  const sidebarTopics = sidebarChapter
    ? map.graphNodes
        .filter((node) => node.kind === 'topic' && node.kpId === sidebarChapter.id)
        .sort((a, b) => (a.topicIndex ?? 99) - (b.topicIndex ?? 99))
        .map((node) => ({
          id: node.id,
          label: node.label,
          progress: Math.round(map.topicProgress[node.id] ?? 0),
          mastery: Math.round(map.topicMastery[node.id] ?? 0),
          target: Math.round(map.nodeTargets[node.id]?.target ?? map.nodeTargets[sidebarChapter.id]?.target ?? 80),
        }))
    : [];
  /** 资源形态：运行时对象是 LearningResourceSummary（有 type），hook 的声明类型写窄了，两种都认 */
  const formOf = (resource: unknown): string => {
    const raw = (resource as { type?: string; form?: string });
    const kind = raw.type ?? raw.form ?? '';
    return kind === 'guide' ? 'practice' : kind;
  };
  const sidebarResources = (() => {
    const rows: SidebarResource[] = [];
    for (const topic of sidebarTopics) {
      for (const resource of map.resources[topic.id] ?? []) {
        rows.push({
          id: resource.id,
          type: formOf(resource),
          title: resource.title,
          topic: topic.label,
          learned: resource.learned,
          started: resource.started,
        });
      }
    }
    // 推荐顺序：在读 → 未学 → 已学（正在学的最该接着做）
    const rank = (row: SidebarResource) => (row.started && !row.learned ? 0 : row.learned ? 2 : 1);
    return rows.sort((a, b) => rank(a) - rank(b));
  })();
  const openWeakestChapter = () => {
    const weakest = [...knowledgePoints].sort((a, b) => (map.mastery[a.id] ?? 0) - (map.mastery[b.id] ?? 0))[0];
    if (!weakest) return;
    setSelectedKp(weakest.id);
    setSelectedTopic(null);
    setSingleExpandedKp(weakest.id);
    setGraphFocus({ id: weakest.id, at: Date.now() });
  };

  return (
    <div className="mx-auto max-w-[1280px] px-5 pb-24 pt-8 md:px-6">
      {/* 页头：标题 + 一句带动词的引导语 + 场景分段控件（全页唯一控件组） */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative flex flex-wrap items-end justify-between gap-x-6 gap-y-3"
      >
        <Fern className="pointer-events-none absolute -top-3 right-1 hidden h-[76px] w-[54px] opacity-80 xl:block" />
        <GrassTuft className="pointer-events-none absolute -top-2 right-[62px] hidden h-[36px] w-[50px] opacity-60 xl:block" />
        <div>
          <h1 className="font-serif text-[26px] font-bold leading-[36px] text-ink">我的知识网络</h1>
        </div>

      </motion.div>

      {/* ============ 桌面端：地图（结构）+ 详情（操作）+ 速览（扫描），三向联动 ============ */}
      {map.loading && knowledgePoints.length === 0 && (
        <div className="mt-8 flex flex-col items-center justify-center gap-2 rounded-[14px] border border-hairline bg-card-warm px-6 py-12 text-center text-[13.5px] text-ink-muted">
          <Loader2 size={16} className="animate-spin" />
          <span>正在加载学习内容…</span>
          <span className="text-[12px] text-ink-muted/70">若长时间没有响应，请尝试刷新网页。</span>
        </div>
      )}
      {!map.loading && knowledgePoints.length === 0 && (
        <div className="mt-8 rounded-[14px] border border-hairline bg-card-warm px-6 py-10 text-center text-[13.5px] text-ink-muted">
          暂无学习内容。完成资料填写后，可刷新页面重试。
        </div>
      )}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        layout
        animate={{ opacity: 1, y: 0 }}
        transition={{ layout: { duration: 0.32, ease: [0.22, 1, 0.36, 1] } }}
        className="mt-5 flex flex-col gap-0"
      >
        {/* 上层只承载网络与按需详情；章节速览在下方独立占满全局宽度。 */}
        <motion.div layout="position" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_336px]">
          <div className="relative min-w-0">
          <div className="absolute right-4 top-4 z-10 flex flex-col items-end gap-2">
            <button
              type="button"
              onClick={() => setShowLearnedPath((v: boolean) => !v)}
              aria-pressed={showLearnedPath}
              title="高亮已学章节/资源，不一定连续"
              className={cn(
                'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] backdrop-blur-sm transition-colors',
                showLearnedPath
                  ? 'border-brand/60 bg-brand-tint text-brand hover:bg-brand-tint'
                  : 'border-hairline/50 bg-white/90 text-ink-2 hover:bg-white hover:text-ink',
              )}
            >
              {showLearnedPath ? <Check size={12} /> : <Route size={12} />}
              {showLearnedPath ? '隐藏已学路径' : '已学路径'}
            </button>
          </div>
          <KnowledgeGraph3D
            nodes={map.graphNodes}
            edges={map.graphEdges}
            selectedKpId={selectedKp}
            expandedKpIds={expandedKpIds}
            onSelectKp={(id) => { setSelectedKp(id); setSelectedTopic(null); }}
            onSelectTopic={setSelectedTopic}
            onExpandedKpChange={toggleExpandedKp}
            learned={map.learned}
            mastery={map.mastery}
            chapterProgress={map.chapterProgress}
            topicMastery={map.topicMastery}
            topicMasteryRaw={map.topicMasteryRaw}
            topicProgress={map.topicProgress}
            focusTarget={graphFocus}
            focusTopicTarget={focusTopic}
            showLearned={showLearnedPath}
            showTopicEdges={showTopicEdges}
            resources={map.resources}
            presentations={map.presentations}
            nodeTargets={map.nodeTargets}
            jobName={map.jobName}
            persistenceKey={currentLearner.id}
            restorePersistedCamera={restoreMapState && !searchParams.get('kp')}
          />
          </div>

          {(map.loading || knowledgePoints.length > 0) && (
            <ChapterSidebar
              className="self-start lg:sticky lg:top-24"
              loading={map.loading}
              chapterName={sidebarChapter?.name ?? null}
              chapterProgress={Math.round(map.chapterProgress[sidebarChapter?.id ?? ''] ?? 0)}
              chapterMastery={Math.round(map.mastery[sidebarChapter?.id ?? ''] ?? 0)}
              chapterTarget={Math.round(map.nodeTargets[sidebarChapter?.id ?? '']?.target ?? 80)}
              topics={sidebarTopics}
              resources={sidebarResources}
              onPickTopic={(topicId) => {
                const chapterId = sidebarChapter?.id ?? null;
                setSelectedKp(chapterId);
                setSingleExpandedKp(chapterId);
                const topicNode = map.graphNodes.find((node) => node.id === topicId);
                setSelectedTopic(topicNode?.topicIndex ?? null);
                setFocusTopic({ id: topicId, at: Date.now() });
              }}
              onPickResource={(resourceId) => navigate(`/learn/resource/${encodeURIComponent(resourceId)}`)}
              onPickWeakest={openWeakestChapter}
            />
          )}
        </motion.div>
      </motion.div>

      {/* 全局章节速览不参与上方两栏动画，侧栏出现时不会被挤压或拉伸。 */}
      {knowledgePoints.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
          className="mt-4 border-t border-hairline/60 pt-4"
        >
          <UnitQuickList selectedKpId={selectedKp} onSelect={(kpId) => { setSelectedKp(kpId); setSelectedTopic(null); setSingleExpandedKp(kpId); setGraphFocus({ id: kpId, at: Date.now() }); }} onSelectTopic={(kpId, topicIndex) => {
            setSelectedKp(kpId);
            setSingleExpandedKp(kpId);
            const topicNode = map.graphNodes.find((node) => node.kind === 'topic' && node.kpId === kpId && node.topicIndex === topicIndex);
            setSelectedTopic(topicIndex);
            setGraphFocus({ id: kpId, at: Date.now() });
            setFocusTopic(topicNode ? { id: topicNode.id, at: Date.now() } : null);
          }} columns items={knowledgePoints} path={map.path} mastery={map.mastery} progress={map.chapterProgress} nodeTargets={map.nodeTargets} />
        </motion.div>
      )}

      {/* ============ 移动端：网络不适合小屏，单元卡片作为移动布局 ============ */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:hidden">
        {knowledgePoints.map((kp, i) => {
          const score = map.mastery[kp.id] ?? currentLearner.scores[kp.id] ?? 50;
          const confidenceValue = map.confidence[kp.id] ?? 40;
          const st = pathStatusOf(kp.id);
          const meta = st ? statusMeta[st] : null;
          const gap = Math.max(0, kp.targetLevel - score);
          return (
            <motion.div
              key={kp.id}
              role="button"
              tabIndex={0}
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              onClick={() => navigate(`/learn?kp=${kp.id}`)}
              onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/learn?kp=${kp.id}`); }}
              className="lf-card lf-card-hover flex flex-col p-5"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-[16.5px] font-semibold text-ink">{kp.name}</h3>
                  <div className="mt-0.5 font-mono text-[10px] tracking-wide text-ink-muted">{kp.en}</div>
                </div>
                {meta && (
                  <span className={cn('shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium', meta.cls)}>
                    {meta.label}
                  </span>
                )}
              </div>

              <p className="mt-2 line-clamp-2 text-[12.5px] leading-[19px] text-ink-muted">{kp.description}</p>

              <div className="mt-3">
                <div className="relative h-1.5 overflow-hidden rounded-full bg-paper-deep">
                  <div className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${score}%` }} />
                  <div className="absolute inset-y-0 w-[2px] bg-brand-amber" style={{ left: `${kp.targetLevel}%` }} title={`目标 ${kp.targetLevel}`} />
                </div>
                <div className="mt-1.5 flex items-center justify-between font-mono text-[10.5px] text-ink-muted">
                  <span>掌握 <span className="text-ink-2">{score}</span> · 距目标 <span className="text-ochre">{gap}</span></span>
                  <span>置信 {confidenceValue}%</span>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-end border-t border-hairline pt-3">
                <span className="inline-flex items-center gap-1 text-[12px] font-medium text-brand">
                  进入课件 <ArrowRight size={13} />
                </span>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
