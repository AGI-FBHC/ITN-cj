/**
 * 学情画像 `/profiles`（profiles.md）
 * S1 页面头 + 当前画像状态卡 / S2 三张画像卡 / S3 选中画像详情（雷达+档案+盲区墙+诊断）
 * S4 理论测试成绩明细 / S5 画像对比视图
 * 「设为当前画像」调用 ProfileContext.setCurrentLearnerId 驱动全站取数
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import { useProfile } from '@/context/ProfileContext';
import { getLearner } from '@/data/learners';
import SectionHeader from '@/components/SectionHeader';
import LiveDot from '@/components/LiveDot';
import ProfileCard from '@/components/profiles/ProfileCard';
import ProfileDetail from '@/components/profiles/ProfileDetail';
import ScoreTable from '@/components/profiles/ScoreTable';
import CompareRadar from '@/components/profiles/CompareRadar';

export default function Profiles() {
  const { learners, currentLearner, currentLearnerId, setCurrentLearnerId } = useProfile();
  const [searchParams, setSearchParams] = useSearchParams();
  const detailRef = useRef<HTMLDivElement>(null);

  const paramId = searchParams.get('learner');
  const validParam = learners.some((l) => l.id === paramId) ? paramId : null;
  const [selectedId, setSelectedId] = useState<string>(validParam ?? currentLearnerId);

  /* 全局画像切换（顶栏/画像卡 CTA）→ 详情区跟随；初次挂载保留 URL 深链 ?learner= */
  const prevCurrentIdRef = useRef(currentLearnerId);
  useEffect(() => {
    if (prevCurrentIdRef.current === currentLearnerId) return;
    prevCurrentIdRef.current = currentLearnerId;
    setSelectedId(currentLearnerId);
    setSearchParams({ learner: currentLearnerId }, { replace: true });
  }, [currentLearnerId, setSearchParams]);

  const selectedLearner = useMemo(() => getLearner(selectedId), [selectedId]);

  /** 点击卡片空白：定位详情区 + 刷新 URL 深链（不改变全局画像） */
  const handleSelect = (id: string) => {
    setSelectedId(id);
    setSearchParams({ learner: id }, { replace: true });
    requestAnimationFrame(() => {
      detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  /** 设为当前画像：驱动全站 */
  const handleSetCurrent = (id: string) => {
    if (id === currentLearnerId) return;
    setCurrentLearnerId(id);
    setSearchParams({ learner: id }, { replace: true });
    const l = getLearner(id);
    toast.success(`已切换为 ${l.name}，全站数据已更新`, {
      description: '画像 / 报告 / 资源 / 导学 / 协同五页已重新取数',
    });
  };

  return (
    <div className="mx-auto max-w-[1320px] px-8 py-10">
      {/* ============ S1 页面头 ============ */}
      <div className="mb-10 flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-[640px]">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
            className="lf-mono-label mb-3 flex items-center gap-2"
          >
            <span className="inline-block h-px w-6 bg-brand/40" />
            LEARNER PROFILES · 3 CASES
          </motion.div>
          <h1 className="font-serif text-[36px] font-bold leading-[44px] text-ink">
            {'学情画像'.split('').map((ch, i) => (
              <motion.span
                key={i}
                className="inline-block"
                initial={{ opacity: 0, y: 28 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              >
                {ch}
              </motion.span>
            ))}
          </h1>
          <motion.p
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15, duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            className="mt-3 text-[14.5px] leading-[24px] text-ink-muted"
          >
            整合学习者先验知识（学历背景、理论测试成绩）与领域专业知识库，由学情诊断 Agent
            构建可计算的画像向量。切换画像，全站资源与决策即时重排。
          </motion.p>
        </div>

        {/* 当前画像状态卡 */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          className="lf-card flex items-center gap-3 px-4 py-3"
        >
          <img
            src={currentLearner.avatar}
            alt={currentLearner.name}
            className="h-11 w-11 rounded-full border border-hairline object-cover"
          />
          <div className="leading-tight">
            <div className="lf-mono-label !text-[10px]">当前画像</div>
            <div className="mt-0.5 text-[15px] font-semibold text-ink">{currentLearner.name}</div>
            <div className="text-[11.5px] text-ink-muted">{currentLearner.tag}</div>
          </div>
          <span className="ml-2 flex items-center gap-1.5 rounded-lg border border-brand/25 bg-brand-tint px-2 py-1">
            <LiveDot status="running" />
            <span className="font-mono text-[10.5px] font-medium text-brand">驱动全站中</span>
          </span>
        </motion.div>
      </div>

      {/* ============ S2 三张画像卡 ============ */}
      <div className="grid gap-5 md:grid-cols-3">
        {learners.map((l, i) => (
          <ProfileCard
            key={l.id}
            learner={l}
            index={i}
            isCurrent={l.id === currentLearnerId}
            isSelected={l.id === selectedId}
            onSelect={() => handleSelect(l.id)}
            onSetCurrent={() => handleSetCurrent(l.id)}
          />
        ))}
      </div>

      {/* ============ S3 选中画像详情区 ============ */}
      <div ref={detailRef} className="mt-16 scroll-mt-20">
        <SectionHeader
          en="SELECTED PROFILE"
          title={`画像详情 · ${selectedLearner.name}`}
          desc="知识雷达对照岗位目标，盲区标签墙与 DIA-01 诊断报告随画像切换即时重算。"
        />
        <AnimatePresence mode="wait">
          <motion.div
            key={selectedId}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          >
            <ProfileDetail learner={selectedLearner} />
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ============ S4 理论测试成绩明细 ============ */}
      <div className="mt-14">
        <AnimatePresence mode="wait">
          <motion.div
            key={selectedId}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          >
            <ScoreTable learner={selectedLearner} />
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ============ S5 画像对比视图 ============ */}
      <div className="mt-14">
        <CompareRadar />
      </div>
    </div>
  );
}
