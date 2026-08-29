/**
 * ResumeLearningFab — 全局「继续学习」浮标（学习者视角常驻，左下角）
 * 永远指向当前 active 路径节点，随时从任意页面回到「我在哪」，接回学习闭环。
 * 真实用户使用知识网络真实章节；预设画像保留原演示路径。
 * 已在该单元课件内 / 专注模式 / 无 active 节点时自动隐藏；与右下角伴学助手 Dock 不冲突。
 */
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Route, ArrowRight } from 'lucide-react';
import { useProfile, dataIdOf } from '@/context/ProfileContext';
import { useGrowth } from '@/context/GrowthContext';
import { activePathNode } from '@/data/reportData';
import { reportForLearner } from '@/data/reportBuilder';
import { resolveLearnTarget } from '@/data/resources';
import { useLearningMap } from '@/hooks/useLearningMap';
import { learningResourcePath, useCourseLearning } from '@/hooks/useCourseLearning';
import { learnMapPath } from '@/lib/learnNav';

export default function ResumeLearningFab() {
  const { currentLearner } = useProfile();
  const { focusMode } = useGrowth();
  const location = useLocation();
  const learningMap = useLearningMap();
  const learning = useCourseLearning();
  const isPreset = !currentLearner.custom;
  const node = isPreset
    ? activePathNode(reportForLearner(currentLearner))
    : (learningMap.path.find((p) => p.status === 'active') ?? learningMap.path[0] ?? null);
  const navigate = useNavigate();
  const goLearn = () => {
    if (isPreset) { navigate(resolveLearnTarget(dataIdOf(currentLearner), node?.kpId ?? '', node?.title ?? '').to); return; }
    if (learning.nextResource) { navigate(learningResourcePath(learning.nextResource)); return; }
    navigate(learnMapPath(currentLearner.id, node?.kpId ?? undefined));
  };

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
          <button
            type="button"
            onClick={goLearn}
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
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
