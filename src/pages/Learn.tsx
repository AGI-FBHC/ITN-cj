/**
 * Learn `/learn` — 课程目录（学习者「学」的主入口）
 * 6 大知识点单元卡：掌握度 / 阿诊置信度 / 学习路径位置 / 将生成的课件版本
 * 点击进入 /learn/:kpId 交互课件（GEN-03 按画像现场拼装）
 */
import { useState } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, PenLine, Sparkles, Volume2, Network, LayoutGrid } from 'lucide-react';
import { useProfile, dataIdOf } from '@/context/ProfileContext';
import { useAgent } from '@/context/AgentContext';
import { knowledgePoints } from '@/data/knowledgePoints';
import { reportForLearner } from '@/data/reportBuilder';
import { resourcesForKp } from '@/data/resources';
import type { ResourceForm } from '@/data/resources';
import KnowledgeGraph from '@/components/learn/KnowledgeGraph';
import KpDetailPanel from '@/components/learn/KpDetailPanel';
import PathProgressBar from '@/components/learn/PathProgressBar';
import { Fern, GrassTuft } from '@/components/heal/Flora';
import { cn } from '@/lib/utils';

const statusMeta: Record<string, { label: string; cls: string }> = {
  active: { label: '路径中 · 本周', cls: 'border-brand-amber/50 bg-brand-amber-tint text-ochre' },
  todo: { label: '路径中 · 待学', cls: 'border-hairline bg-paper-deep text-ink-2' },
  done: { label: '已完成', cls: 'border-brand/30 bg-brand-tint text-brand' },
};

const formShort: Record<ResourceForm, string> = {
  lecture: '讲义',
  guide: '实操',
  quiz: '分阶题',
};

export default function Learn() {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const { confidence } = useAgent();
  const dataId = dataIdOf(currentLearner);
  const report = reportForLearner(currentLearner);
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const activeKp = report.path.find((p) => p.status === 'active')?.kpId ?? knowledgePoints[0].id;
  const [selectedKp, setSelectedKp] = useState<string>(activeKp);

  const pathStatusOf = (kpId: string): string | null => {
    const nodes = report.path.filter((n) => n.kpId === kpId);
    if (nodes.some((n) => n.status === 'active')) return 'active';
    if (nodes.some((n) => n.status === 'todo')) return 'todo';
    if (nodes.length && nodes.every((n) => n.status === 'done')) return 'done';
    return null;
  };

  return (
    <div
      className={cn(
        'mx-auto px-5 pb-24 pt-8 transition-[max-width] duration-300 md:px-6',
        view === 'graph' ? 'max-w-[1280px]' : 'max-w-[960px]',
      )}
    >
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="relative">
        {/* 页头植物：蕨类 + 草丛 */}
        <Fern className="pointer-events-none absolute -top-2 right-1 hidden h-[84px] w-[60px] opacity-90 md:block" />
        <GrassTuft className="pointer-events-none absolute -top-1 right-[68px] hidden h-[40px] w-[56px] opacity-70 md:block" />
        <div className="lf-mono-label flex items-center gap-2">
          <span className="inline-block h-px w-6 bg-brand/40" />
          我的课程 · 学
        </div>
        <h1 className="mt-2 font-serif text-[32px] font-bold leading-[42px] text-ink">
          六大知识点，每讲都为你现做
        </h1>
        <p className="mt-2 max-w-[680px] text-[14.5px] leading-[24px] text-ink-muted">
          点开任何一个单元，AI 会按你当前的水平和偏好现做课件——支持
          <Volume2 size={13} className="mx-0.5 inline text-brand" />
          语音授课、随时举手提问、检查点答错自动降维换讲法。
        </p>

        {/* 视图切换 */}
        <div className="mt-4 inline-flex items-center gap-0.5 rounded-[11px] border border-hairline bg-paper p-0.5">
          {([
            ['graph', '知识图谱', Network],
            ['list', '单元列表', LayoutGrid],
          ] as const).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setView(key)}
              className={cn(
                'flex items-center gap-1.5 rounded-[9px] px-3 py-1.5 text-[12.5px] font-medium transition-all',
                /* 这是「换个看法」，不是行动。用中性选中态，把实心品牌色留给真正要点的按钮 */
                view === key
                  ? 'bg-card-warm text-ink shadow-xs ring-1 ring-hairline'
                  : 'text-ink-muted hover:text-ink',
              )}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>
      </motion.div>

      {/* 学习路径进度条（贯穿「学」流程） */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.08 }} className="mt-6">
        <PathProgressBar currentKpId={selectedKp} />
      </motion.div>

      {/* 知识图谱视图：左图谱 + 右侧详情（选点即见进度与资源） */}
      {view === 'graph' && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]"
        >
          <KnowledgeGraph onSelectKp={setSelectedKp} selectedKpId={selectedKp} />
          <div className="lg:sticky lg:top-6 lg:self-start">
            <KpDetailPanel kpId={selectedKp} />
          </div>
        </motion.div>
      )}

      {view === 'list' && (
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {knowledgePoints.map((kp, i) => {
          const score = currentLearner.scores[kp.id] ?? 50;
          const conf = confidence[kp.id] ?? 40;
          const st = pathStatusOf(kp.id);
          const meta = st ? statusMeta[st] : null;
          const gap = Math.max(0, kp.targetLevel - score);
          const res = resourcesForKp(dataId, kp.id);
          return (
            <motion.div
              key={kp.id}
              role="button"
              tabIndex={0}
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              onClick={() => navigate(`/learn/${kp.id}`)}
              onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/learn/${kp.id}`); }}
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

              {/* 掌握度条 + 目标差 + 置信度 */}
              <div className="mt-3">
                <div className="relative h-1.5 overflow-hidden rounded-full bg-paper-deep">
                  <div className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${score}%` }} />
                  <div className="absolute inset-y-0 w-[2px] bg-brand-amber" style={{ left: `${kp.targetLevel}%` }} title={`目标 ${kp.targetLevel}`} />
                </div>
                <div className="mt-1.5 flex items-center justify-between font-mono text-[10.5px] text-ink-muted">
                  <span>掌握 <span className="text-ink-2">{score}</span> · 距目标 <span className="text-ochre">{gap}</span></span>
                  <span>置信 {conf}%</span>
                </div>
              </div>

              {/* 资源入口：有预制则显示可点标签；否则「现场生成」 */}
              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-hairline pt-3">
                {res.length > 0 ? (
                  <>
                    <span className="font-mono text-[10px] text-ink-muted">资源</span>
                    {res.map((r) => (
                      <button
                        key={r.form}
                        type="button"
                        onClick={(e) => { e.stopPropagation(); navigate(`/resources?tab=${r.form}`); }}
                        className="rounded-md border border-brand/25 bg-brand-tint/60 px-1.5 py-0.5 text-[11px] font-medium text-brand transition-colors hover:bg-brand hover:text-paper"
                      >
                        {formShort[r.form]}
                      </button>
                    ))}
                  </>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-0.5 font-mono text-[10px] text-ink-muted">
                      <Sparkles size={10} className="text-brand" />
                      生成
                    </span>
                    {(['lecture', 'guide', 'quiz'] as ResourceForm[]).map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toast.success('AI 开始现做', {
                            description: `正在按 ${currentLearner.name} 的画像现场生成《${kp.name} · ${formShort[f]}》`,
                          });
                          navigate(`/learn/${kp.id}`);
                        }}
                        className="rounded-md border border-dashed border-brand/35 px-1.5 py-0.5 text-[11px] font-medium text-ink-2 transition-colors hover:border-brand/60 hover:bg-brand-tint/50 hover:text-brand"
                      >
                        {formShort[f]}
                      </button>
                    ))}
                  </>
                )}
                <span className="ml-auto inline-flex items-center gap-1 text-[12px] font-medium text-brand">
                  进入课件 <ArrowRight size={13} />
                </span>
              </div>
            </motion.div>
          );
        })}
      </div>
      )}

      {/* 生成资源入口 */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 }}
        className="mt-8 flex flex-wrap items-center gap-3 rounded-[14px] border border-hairline bg-card-warm p-4"
      >
        <PenLine size={18} className="text-ochre" />
        <div className="min-w-0 flex-1 text-[13px] text-ink-2">
          想看完整的<span className="font-medium">生成资源</span>（定制讲义 / 实操指南 / 分阶测试题）？
        </div>
        <Link to="/resources" className="lf-btn-ghost !px-4 !py-1.5 text-[13px]">
          去看生成资源
          <ArrowRight size={13} />
        </Link>
      </motion.div>
    </div>
  );
}
