/**
 * Learn `/learn` — 知识地图（学习者「学 · 练」主入口）· 一页三件套
 * 桌面端：左 = 知识图谱（结构唯一载体，场景控件驱动），右 = 单元详情（操作唯一载体）+ 单元速览（扫描唯一载体）。
 * 三向联动：点图谱域 / 点速览行 → 选中同步 → 详情更新。「图谱/列表」视图切换已删除（信息只此一份）。
 * 移动端：图谱隐藏，单元卡片作为小屏布局。
 */
import { useState } from 'react';
import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, Loader2 } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import { useLearningMap } from '@/hooks/useLearningMap';
import KnowledgeGraph from '@/components/learn/KnowledgeGraph';
import type { GraphScene } from '@/components/learn/KnowledgeGraph';
import KpDetailPanel from '@/components/learn/KpDetailPanel';
import UnitQuickList from '@/components/learn/UnitQuickList';
import { Fern, GrassTuft } from '@/components/heal/Flora';
import { cn } from '@/lib/utils';

const statusMeta: Record<string, { label: string; cls: string }> = {
  active: { label: '路径中 · 本周', cls: 'border-brand-amber/50 bg-brand-amber-tint text-ochre' },
  todo: { label: '路径中 · 待学', cls: 'border-hairline bg-paper-deep text-ink-2' },
  done: { label: '已完成', cls: 'border-brand/30 bg-brand-tint text-brand' },
};

const SCENES: { key: GraphScene; label: string; hint: string }[] = [
  { key: 'order', label: '学习顺序', hint: '只看前置箭头：从左往右就是学的顺序' },
  { key: 'network', label: '完整网络', hint: '三种知识关系全打开，图例可单独隐藏' },
  { key: 'route', label: '我的路线', hint: '阿诊为你排的学习路径，叠加在地图上' },
];

export default function Learn() {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const map = useLearningMap();
  const knowledgePoints = map.domains;
  const reportPath = map.path;
  const [scene, setScene] = useState<GraphScene>('order');
  const activeKp = map.activeKp ?? knowledgePoints[0]?.id ?? null;
  const [selectedKp, setSelectedKp] = useState<string | null>(activeKp);
  const [selectedTopic, setSelectedTopic] = useState<number | null>(null);
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

        {/* 场景切换（图谱是桌面端形态，控件同样只在桌面端出现） */}
        <div className="hidden items-center gap-0.5 rounded-[11px] border border-hairline bg-paper p-0.5 lg:inline-flex">
          {SCENES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setScene(s.key)}
              title={s.hint}
              className={cn(
                'rounded-[9px] px-3 py-1.5 text-[12.5px] font-medium transition-all',
                scene === s.key ? 'bg-card-warm text-ink shadow-xs ring-1 ring-hairline' : 'text-ink-muted hover:text-ink',
              )}
            >
              {s.label}
            </button>
          ))}
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
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.08 }}
        className="mt-5 hidden gap-7 lg:grid lg:grid-cols-[minmax(0,1fr)_340px]"
      >
        {/* 左栏 = 图谱 + 速览（左栏更长，右栏 sticky 跟随——短边放右侧才不会滚出空腔） */}
        <div className="min-w-0">
<KnowledgeGraph scene={scene} onSelectKp={(id) => { setSelectedKp(id); setSelectedTopic(null); }} onSelectTopic={setSelectedTopic} selectedKpId={selectedKp} nodes={map.graphNodes} edges={map.graphEdges} path={map.path} mastery={map.mastery} confidence={map.confidence} learned={map.learned} activeKp={map.activeKp} />
          <div className="mt-3 border-t border-hairline/60 pt-3">
            <UnitQuickList selectedKpId={selectedKp} onSelect={setSelectedKp} routeOrdered={scene === 'route'} columns items={knowledgePoints} path={map.path} learned={map.learned} mastery={map.mastery} />
          </div>
        </div>
        <div className="lg:sticky lg:top-6 lg:self-start">
<KpDetailPanel kpId={selectedKp} topicIndex={selectedTopic} onSelectTopic={setSelectedTopic} kp={knowledgePoints.find((kp) => kp.id === selectedKp) ?? null} mastery={map.mastery} confidence={map.confidence} path={map.path} resources={selectedKp ? map.resources[selectedKp] ?? [] : []} goalId={map.goalId} />
        </div>
      </motion.div>

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
    </div>
  );
}
