import { useState } from 'react';
import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, Loader2, Box, Map, Expand, Shrink, Route, Check } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { useLearningMap } from '@/hooks/useLearningMap';
import KnowledgeGraph from '@/components/learn/KnowledgeGraph';
import KnowledgeGraph3D from '@/components/learn/KnowledgeGraph3D';
import KpDetailPanel from '@/components/learn/KpDetailPanel';
import NodeActionMenu from '@/components/learn/NodeActionMenu';
import UnitQuickList from '@/components/learn/UnitQuickList';
import { Fern, GrassTuft } from '@/components/heal/Flora';
import { cn } from '@/lib/utils';

const statusMeta: Record<string, { label: string; cls: string }> = {
  active: { label: '路径中 · 本周', cls: 'border-brand-amber/50 bg-brand-amber-tint text-ochre' },
  todo: { label: '路径中 · 待学', cls: 'border-hairline bg-paper-deep text-ink-2' },
  done: { label: '已完成', cls: 'border-brand/30 bg-brand-tint text-brand' },
};


export default function Learn() {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const map = useLearningMap();
  const knowledgePoints = map.domains;
  const reportPath = map.path;
  /** “我的已学路径”：高亮已学章节/资源 */
  const [showLearnedPath, setShowLearnedPath] = useState(false);
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('3d');
  const [selectedKp, setSelectedKp] = useState<string | null>(null);
  const [expandedKpIds, setExpandedKpIds] = useState<Set<string>>(new Set());
  /** 3D：点击章节切换展开/收起，可同时展开多个 */
  const toggleExpandedKp = (id: string) => {
    setExpandedKpIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  /** 2D：单展开语义（null = 全部收起） */
  const setSingleExpandedKp = (id: string | null) => {
    setExpandedKpIds(id === null ? new Set() : new Set([id]));
  };
  const [selectedTopic, setSelectedTopic] = useState<number | null>(null);
  /** 章节速览点击后，请求 3D 相机把该域节点转到正前方 */
  const [graphFocus, setGraphFocus] = useState<{ id: string; at: number } | null>(null);
  const [actionMenu, setActionMenu] = useState<{ kpId: string; topicIndex: number; label: string } | null>(null);
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const kpParam = searchParams.get('kp');
    if (kpParam && knowledgePoints.some((kp) => kp.id === kpParam)) {
      setSelectedKp(kpParam);
      setSelectedTopic(null);
    }
  }, [searchParams, knowledgePoints]);

  const pathStatusOf = (kpId: string): string | null => {
    const nodes = reportPath.filter((n) => n.kpId === kpId);
    if (nodes.some((n) => n.status === 'active')) return 'active';
    if (nodes.some((n) => n.status === 'todo')) return 'todo';
    if (nodes.length && nodes.every((n) => n.status === 'done')) return 'done';
    return null;
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
          <h1 className="font-serif text-[26px] font-bold leading-[36px] text-ink">我的知识地图</h1>
          <p className="mt-1 text-[13.5px] leading-[22px] text-ink-muted">
            沿箭头方向学：点一个域展开细看，双击直接开课。每一讲都按你的画像现做。
          </p>
        </div>

        {/* 场景切换 + 2D/3D 切换 */}
        <div className="flex items-center gap-2">
          {/* 2D/3D 切换 */}
          <div className="hidden items-center gap-0.5 rounded-[11px] border border-hairline bg-paper p-0.5 lg:inline-flex">
            <button
              type="button"
              onClick={() => setViewMode('2d')}
              title="2D 平面视图"
              className={cn(
                'rounded-[9px] px-3 py-1.5 text-[12.5px] font-medium transition-all flex items-center gap-1.5',
                viewMode === '2d' ? 'bg-card-warm text-ink shadow-xs ring-1 ring-hairline' : 'text-ink-muted hover:text-ink',
              )}
            >
              <Map size={14} />
              2D
            </button>
            <button
              type="button"
              onClick={() => setViewMode('3d')}
              title="3D 立体视图（Obsidian 风格）"
              className={cn(
                'rounded-[9px] px-3 py-1.5 text-[12.5px] font-medium transition-all flex items-center gap-1.5',
                viewMode === '3d' ? 'bg-card-warm text-ink shadow-xs ring-1 ring-hairline' : 'text-ink-muted hover:text-ink',
              )}
            >
              <Box size={14} />
              3D
            </button>
          </div>

        </div>
      </motion.div>

      {/* ============ 桌面端：地图（结构）+ 详情（操作）+ 速览（扫描），三向联动 ============ */}
      {map.loading && knowledgePoints.length === 0 && (
        <div className="mt-8 flex items-center justify-center gap-2 rounded-[14px] border border-hairline bg-card-warm py-12 text-[13.5px] text-ink-muted">
          <Loader2 size={16} className="animate-spin" />
          正在读取真实学习地图…
        </div>
      )}
      {!map.loading && knowledgePoints.length === 0 && (
        <div className="mt-8 rounded-[14px] border border-hairline bg-card-warm px-6 py-10 text-center text-[13.5px] text-ink-muted">
          暂无学习地图，请先完成画像或等待后端数据。
        </div>
      )}
      <motion.div
        initial={{ opacity: 0, y: 20, gridTemplateColumns: 'minmax(0, 1fr) 0px' }}
        layout
        animate={{ opacity: 1, y: 0, gridTemplateColumns: viewMode === '2d' ? 'minmax(0, 1fr) 340px' : 'minmax(0, 1fr) 0px', columnGap: viewMode === '2d' ? 28 : 0 }}
        transition={{ layout: { duration: 0.32, ease: [0.22, 1, 0.36, 1] }, gridTemplateColumns: { duration: 0.32, ease: [0.22, 1, 0.36, 1] }, columnGap: { duration: 0.28 } }}
        className="mt-5 hidden lg:grid"
      >
        {/* 上层只承载图谱与按需详情；章节速览在下方独立占满全局宽度。 */}
        <motion.div layout="position" className="relative min-w-0">
          <div className={cn('absolute top-4 z-10 flex flex-col gap-2', viewMode === '3d' ? 'right-4 items-end' : 'left-4 items-start')}>
            {viewMode === '3d' && (
              <button
                type="button"
                onClick={() => {
                  const allDomainIds = map.graphNodes.filter((n) => n.kind === 'domain').map((n) => n.id);
                  const isAllExpanded = expandedKpIds.size === allDomainIds.length;
                  setExpandedKpIds(isAllExpanded ? new Set() : new Set(allDomainIds));
                }}
                className="flex items-center gap-1.5 rounded-lg border border-hairline/50 bg-white/90 px-3 py-1.5 text-[11px] text-ink-2 backdrop-blur-sm transition-colors hover:bg-white hover:text-ink"
              >
                {expandedKpIds.size === map.graphNodes.filter((n) => n.kind === 'domain').length ? (
                  <>
                    <Shrink size={12} />
                    隐藏全部
                  </>
                ) : (
                  <>
                    <Expand size={12} />
                    展开全部
                  </>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowLearnedPath((v) => !v)}
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
          {viewMode === '3d' ? (
            <KnowledgeGraph3D
              onTopicClick={(kpId, topicIndex, label) => setActionMenu({ kpId, topicIndex, label })}
              nodes={map.graphNodes}
              edges={map.graphEdges}
              selectedKpId={selectedKp}
              expandedKpIds={expandedKpIds}
              onSelectKp={(id) => { setSelectedKp(id); setSelectedTopic(null); }}
              onSelectTopic={setSelectedTopic}
              onExpandedKpChange={toggleExpandedKp}
              learned={map.learned}
              mastery={map.mastery}
              topicMastery={map.topicMastery}
              topicProgress={map.topicProgress}
              focusTarget={graphFocus}
              showLearned={showLearnedPath}
            />
          ) : (
            <KnowledgeGraph showLearned={showLearnedPath} onSelectKp={(id) => { setSelectedKp(id); setSelectedTopic(null); }} onSelectTopic={setSelectedTopic} selectedKpId={selectedKp} expandedKpIds={expandedKpIds} onExpandedKpChange={setSingleExpandedKp} nodes={map.graphNodes} edges={map.graphEdges} path={map.path} mastery={map.mastery} topicMastery={map.topicMastery} topicProgress={map.topicProgress} learned={map.learned} activeKp={map.activeKp} />
          )}
        </motion.div>
        <AnimatePresence initial={false} mode="popLayout">
        {viewMode === '2d' && <motion.div
          key="knowledge-detail-panel"
          initial={{ opacity: 0, x: 26, scale: 0.975, filter: 'blur(4px)' }}
          animate={{ opacity: 1, x: 0, scale: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, x: 20, scale: 0.985, filter: 'blur(3px)' }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          className="min-w-0 lg:sticky lg:top-6 lg:self-start"
        >
          <KpDetailPanel kpId={selectedKp} topicIndex={selectedTopic} onSelectTopic={setSelectedTopic} kp={knowledgePoints.find((kp) => kp.id === selectedKp) ?? null} mastery={map.mastery} topicMastery={map.topicMastery} topicProgress={map.topicProgress} graphNodes={map.graphNodes} path={map.path} resources={selectedKp ? map.resources[selectedKp] ?? [] : Object.values(map.resources).flat()} goalId={map.goalId} knowledgeMap={{ chapters: knowledgePoints.map((chapter) => ({ id: chapter.id, name: chapter.name, topics: chapter.coreTopics })), edges: map.graphEdges }} />
        </motion.div>}
        </AnimatePresence>
      </motion.div>

      {/* 全局章节速览不参与上方两栏动画，侧栏出现时不会被挤压或拉伸。 */}
      {knowledgePoints.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
          className="mt-4 hidden border-t border-hairline/60 pt-4 lg:block"
        >
          <UnitQuickList selectedKpId={selectedKp} onSelect={(kpId) => { setSelectedKp(kpId); setSelectedTopic(null); setSingleExpandedKp(kpId); setGraphFocus({ id: kpId, at: Date.now() }); }} columns items={knowledgePoints} path={map.path} learned={map.learned} mastery={map.mastery} />
        </motion.div>
      )}

      {/* ============ 移动端：图谱不适合小屏，单元卡片作为移动布局 ============ */}
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
          {/* 3D 模式下的节点操作菜单 */}
      {actionMenu && viewMode === '3d' && (
        <NodeActionMenu
          kpId={actionMenu.kpId}
          topicIndex={actionMenu.topicIndex}
          label={actionMenu.label}
          onClose={() => setActionMenu(null)}
          goalId={map.goalId}
        />
      )}
    </div>
  );
}
