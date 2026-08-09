/**
 * ResumeLearningFab — 全局「继续学习」浮标（学习者视角常驻，左下角）
 * 永远指向当前 active 路径节点，随时从任意页面回到「我在哪」，接回学习闭环。
 * 已在该单元课件内 / 专注模式 / 无 active 节点时自动隐藏；与右下角阿诊 Dock 不冲突。
 */
import { useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Route, ArrowRight } from 'lucide-react';
import { useProfile, dataIdOf } from '@/context/ProfileContext';
import { useGrowth } from '@/context/GrowthContext';
import { activePathNode } from '@/data/reportData';
import { reportForLearner } from '@/data/reportBuilder';
import { resolveLearnTarget } from '@/data/resources';
import type { PathNode } from '@/data/reportData';

export default function ResumeLearningFab() {
  const { currentLearner, domainKnowledgePoints } = useProfile();
  const { focusMode } = useGrowth();
  const location = useLocation();
  const dataId = dataIdOf(currentLearner);
  const node = useMemo<PathNode | null>(() => {
    if (!currentLearner.custom) return activePathNode(reportForLearner(currentLearner));
    const next = [...domainKnowledgePoints].sort(
      (a, b) => (b.targetLevel - (currentLearner.scores[b.id] ?? 50)) - (a.targetLevel - (currentLearner.scores[a.id] ?? 50)),
    )[0];
    if (!next) return null;
    return {
      id: `gp-${next.id}`,
      title: `${next.name}系统学习`,
      kpId: next.id,
      status: 'active' as const,
      est: '1 课时',
      resourceRef: `《${next.name}》定制讲义`,
    };
  }, [currentLearner, domainKnowledgePoints]);

  /* 不打扰的场合：专注模式 / 无节点 / 已经在「学」的区域里（那里本就有入口，浮标只会挡住花园） */
  const inLearnArea = location.pathname.startsWith('/learn');
  const show = !focusMode && !!node && !inLearnArea;

  return (
    <AnimatePresence>
      {show && node && (
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.96 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="fixed bottom-20 left-4 z-40 md:bottom-6 md:left-6"
        >
          <Link
            to={resolveLearnTarget(dataId, node.kpId, node.title).to}
            title={`继续学习：${node.title}`}
            className="lf-glass group flex items-center gap-2.5 rounded-full py-2 pl-2.5 pr-3.5 transition-all hover:border-brand/55"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-paper">
              <Route size={16} />
            </span>
            <span className="min-w-0">
              <span className="block font-mono text-[9px] uppercase tracking-wide text-ochre">继续学习</span>
              <span className="block max-w-[150px] truncate text-[12.5px] font-semibold text-ink">{node.title}</span>
            </span>
            <ArrowRight size={14} className="shrink-0 text-brand transition-transform group-hover:translate-x-0.5" />
          </Link>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
