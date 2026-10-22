/**
 * KnowledgeMap3DPanel — 供总览（系统透视 Dashboard）等其他页面复用的 3D 知识网络。
 * 自带数据加载（useLearningMap）与本地交互状态（选中/展开/已学路径），无需调用方接线。
 */
import { useState } from 'react';
import { useLearningMap } from '@/hooks/useLearningMap';
import KnowledgeGraph3D from '@/components/learn/KnowledgeGraph3D';

export default function KnowledgeMap3DPanel({ className = '' }: { className?: string }) {
  const map = useLearningMap();
  const [selectedKp, setSelectedKp] = useState<string | null>(null);
  const [expandedKpIds, setExpandedKpIds] = useState<Set<string>>(() => new Set());
  const [showLearnedPath] = useState(false);

  const toggleExpandedKp = (id: string) => {
    setExpandedKpIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (map.loading && map.graphNodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-ink-muted">
        正在加载知识网络…
      </div>
    );
  }
  if (!map.graphNodes.length) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[12px] leading-5 text-ink-muted">
        暂无知识网络数据，请先完成画像或等待后端数据。
      </div>
    );
  }

  return (
    <KnowledgeGraph3D
      nodes={map.graphNodes}
      edges={map.graphEdges}
      selectedKpId={selectedKp}
      expandedKpIds={expandedKpIds}
      onSelectKp={(id) => setSelectedKp(id)}
      onSelectTopic={() => undefined}
      onExpandedKpChange={toggleExpandedKp}
      learned={map.learned}
      mastery={map.mastery}
      chapterProgress={map.chapterProgress}
      topicMastery={map.topicMastery}
      topicProgress={map.topicProgress}
      showLearned={showLearnedPath}
      resources={map.resources}
      presentations={map.presentations}
      showHoverCards={false}
      showActionDialog={false}
      showProgressRings={false}
      className={`${className} !border-0 [mask-image:radial-gradient(ellipse_125%_125%_at_50%_50%,black_65%,transparent_98%)] [-webkit-mask-image:radial-gradient(ellipse_125%_125%_at_50%_50%,black_65%,transparent_98%)]`}
    />
  );
}
