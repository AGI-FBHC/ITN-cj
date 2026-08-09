import { Link, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Route } from 'lucide-react';
import { useGrowth } from '@/context/GrowthContext';
import { learningResourcePath, useCourseLearning } from '@/hooks/useCourseLearning';

export default function ResumeLearningFab() {
  const { focusMode } = useGrowth();
  const location = useLocation();
  const learning = useCourseLearning();
  const resource = learning.nextResource;
  const chapter = learning.nextChapter;
  const inLearningArea = location.pathname.startsWith('/learn') || location.pathname.startsWith('/resources');
  const show = !focusMode && !learning.loading && Boolean(resource && chapter) && !inLearningArea;

  return <AnimatePresence>{show && resource && chapter && <motion.div initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.96 }} className="fixed bottom-20 left-4 z-40 md:bottom-6 md:left-6"><Link to={learningResourcePath(resource)} title={`继续学习：${chapter.title}`} className="lf-glass group flex items-center gap-2.5 rounded-full py-2 pl-2.5 pr-3.5 transition-all hover:border-brand/55"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-paper"><Route size={16} /></span><span className="min-w-0"><span className="block font-mono text-[9px] uppercase tracking-wide text-ochre">继续真实课程</span><span className="block max-w-[190px] truncate text-[12.5px] font-semibold text-ink">{chapter.title} · {resource.title}</span></span><ArrowRight size={14} className="shrink-0 text-brand transition-transform group-hover:translate-x-0.5" /></Link></motion.div>}</AnimatePresence>;
}
