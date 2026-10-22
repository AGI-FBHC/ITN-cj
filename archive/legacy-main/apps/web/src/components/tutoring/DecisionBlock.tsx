/**
 * DecisionBlock — 对话流内的动态决策演出（tutoring.md S3）
 * 全宽横幅（复用 DecisionBanner）+ 光晕扫过 + 展开内容卡：
 *  · 降维解释：3 个子概念 mini 卡（类比 + 溯源）+ 生活化类比 callout
 *  · 进阶挑战：任务卡（难度 ★★★ + 奖励 + 接受挑战按钮）
 * 副文案使用实时答题正确率（本地计算）
 */
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowUpRight, ChevronDown, Lightbulb, Medal, Users } from 'lucide-react';
import DecisionBanner from '@/components/DecisionBanner';
import TraceBadge from '@/components/TraceBadge';
import AgentChip from '@/components/AgentChip';
import { getAgent } from '@/data/agents';
import type { AgentId } from '@/data/agents';
import { useProfile } from '@/context/ProfileContext';
import type { DecisionType } from '@/data/tutoringScript';
import { cn } from '@/lib/utils';

interface Concept {
  title: string;
  analogy: string;
  kb: string;
}

/** 降维内容（page-local，按画像差异化） */
const simplifyContent: Record<string, { concepts: Concept[]; callout: string }> = {
  lin: {
    concepts: [
      { title: '可逆偏差', analogy: '像热胀冷缩的钢尺 —— 温度回来，偏差也回去', kb: 'KB-021' },
      { title: '不可逆偏差', analogy: '像磨平的鞋底 —— 磨损不会自己长回来', kb: 'KB-014' },
      { title: '渐变 vs 突变', analogy: '渐变每天一点点，突变立刻触发报警', kb: 'KB-010' },
    ],
    callout: '就像体温计用前甩一甩 —— 先分清偏差能不能「自己回去」，再决定标定还是维修。',
  },
  chen: {
    concepts: [
      { title: 'TCP 位置', analogy: '夹具尖端的「笔尖」，轨迹都按它走', kb: 'KB-002' },
      { title: '四点方程', analogy: '同一尖点碰 4 次 = 列 4 个方程解坐标', kb: 'KB-002' },
      { title: '绕点验证', analogy: '像万用表校零 —— 摇一摇不动才算准', kb: 'KB-018' },
    ],
    callout: '就像你校万用表：表笔短接先归零，测量才准；机器人认准 TCP，轨迹才准。',
  },
  zhao: {
    concepts: [
      { title: '平移激励', analogy: '只测延迟的 ping —— 激励不出旋转分量', kb: 'KB-011' },
      { title: '旋转激励', analogy: '加旋转 > 30°，矩阵的旋转项才被「点亮」', kb: 'KB-011' },
      { title: '解退化', analogy: '激励不足就像丢包率测不出 —— 解自然漂', kb: 'KB-017' },
    ],
    callout: '和你做网络排障一个道理：只用 ping 测延迟，永远测不出丢包率。',
  },
};

/** 进阶挑战任务（page-local） */
const challengeContent: Record<string, { title: string; desc: string; kb: string; reward: string; taskText: string }> = {
  lin: {
    title: '挑战任务 · 激光跟踪仪标定方案',
    desc: '为 2.3 m 工作空间设计 60 构型测量布点方案，说明最小二乘辨识 24 项参数的流程',
    kb: 'KB-017',
    reward: '掌握度 +12',
    taskText:
      '挑战任务已下发：在 2.3 m 工作空间内布设 60 个测量构型，用激光跟踪仪采集末端位置，最小二乘辨识 24 项运动学参数。目标：最大绝对定位误差由 2.84 mm 降至 0.21 mm。完成后到实操指南打卡 [KB-017]。',
  },
  chen: {
    title: '挑战任务 · 姿态标定两点法',
    desc: '在四点 TCP 标定基础上，用两个附加姿态确定工具 X/Z 方向并完成绕点验证',
    kb: 'KB-002',
    reward: '掌握度 +12',
    taskText:
      '挑战任务已下发：四点碰尖解出 TCP 位置后，再取 2 个姿态确定工具坐标系 X 与 Z 方向（右手定则）。验收标准：绕 TCP 姿态摆动时尖端纹丝不动。去实训台完成并拍照记录 [KB-002]。',
  },
  zhao: {
    title: '挑战任务 · 对偶四元数求解推导',
    desc: '推导 AX=XB 的对偶四元数解法，并与 Tsai-Lenz 法比较鲁棒性',
    kb: 'KB-011',
    reward: '掌握度 +12',
    taskText:
      '挑战任务已下发：采集 12–20 组姿态（旋转 > 30°），分别用 Tsai-Lenz 与对偶四元数法求解手眼矩阵，比较重投影误差。文献建议后者最低 —— 用数据验证这个结论 [KB-011]。',
  },
};

/** learner 视角下的 Agent 中文简称（隐藏代号） */
const learnerAgentLabel: Partial<Record<AgentId, string>> = {
  'DIA-01': '学情诊断',
  'VER-04': '审核裁判',
  'ARB-05': '决策仲裁',
};

/** 一条幕后协商气泡：expert 视角用 AgentChip(sm) 亮代号，learner 视角用色点 + 中文名 */
function NegotiationBubble({
  agentId,
  content,
  isLearner,
  delay,
}: {
  agentId: AgentId;
  content: string;
  isLearner: boolean;
  delay: number;
}) {
  const agent = getAgent(agentId);
  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="flex items-start gap-2 rounded-[10px] border px-3 py-2 text-[12px] leading-[18px]"
      style={{ borderColor: `${agent.color}35`, backgroundColor: `${agent.color}0D` }}
    >
      {isLearner ? (
        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: agent.color }} />
      ) : (
        <AgentChip agentId={agentId} size="sm" showStatus={false} />
      )}
      <span className="flex-1 text-ink-2">
        {isLearner && (
          <span className="mr-1 font-medium" style={{ color: agent.color }}>
            {learnerAgentLabel[agentId] ?? agent.name}：
          </span>
        )}
        {content}
      </span>
    </motion.div>
  );
}

export default function DecisionBlock({
  type,
  reason,
  accuracy,
  asked,
  learnerId,
  accepted,
  onAccept,
}: {
  type: DecisionType;
  reason: string;
  accuracy: number;
  asked: number;
  learnerId: string;
  accepted: boolean;
  onAccept: (taskText: string, kb: string) => void;
}) {
  const color = type === 'challenge' ? '#B77552' : '#4E7860';
  const n = Math.max(asked, 1);
  const subtitle =
    type === 'challenge'
      ? accuracy >= 80
        ? `近 ${n} 题正确率 ${accuracy}% ≥ 80%，ARB-05 已解锁挑战任务`
        : `近 ${n} 题正确率 ${accuracy}%，追问链路全部闭合，ARB-05 判定可解锁挑战任务`
      : accuracy < 60
        ? `检测到概念理解受阻（近 ${n} 题正确率 ${accuracy}% < 60%），ARB-05 已将讲解降维为 3 个子概念`
        : `检测到概念理解存在断点（近 ${n} 题正确率 ${accuracy}%），ARB-05 已将讲解降维为 3 个子概念`;

  const simplify = simplifyContent[learnerId] ?? simplifyContent.lin;
  const challenge = challengeContent[learnerId] ?? challengeContent.lin;

  const { viewMode } = useProfile();
  const isLearner = viewMode === 'learner';
  const [negotiationOpen, setNegotiationOpen] = useState(true);

  /** 幕后协商 3 条：DIA-01 建议 → VER-04 复核 → ARB-05 裁定，learner 视角换成口语化中文 */
  const negotiations: { agentId: AgentId; content: string }[] = isLearner
    ? [
        {
          agentId: 'DIA-01',
          content: `你已经答对 ${accuracy}%，我建议${type === 'challenge' ? '给你加点难度' : '先把基础再巩固一下'}`,
        },
        {
          agentId: 'VER-04',
          content:
            type === 'challenge'
              ? '这个挑战任务的要求，我们已经核对过标准了'
              : '这版讲解的出处我们也检查过了，没问题',
        },
        {
          agentId: 'ARB-05',
          content: `大家商量后决定：给你${type === 'challenge' ? '一个进阶挑战' : '换个更简单的讲法'}`,
        },
      ]
    : [
        {
          agentId: 'DIA-01',
          content: `正确率 ${accuracy}% · 建议${type === 'challenge' ? '提升挑战' : '降维巩固'}`,
        },
        {
          agentId: 'VER-04',
          content:
            type === 'challenge'
              ? `挑战任务与标准 ${challenge.kb} 对齐`
              : '内容事实已复核 · 降维版本溯源完整',
        },
        {
          agentId: 'ARB-05',
          content: `综合裁定：下发${type === 'challenge' ? '进阶挑战' : '降维解释'} · 置信度 ${type === 'challenge' ? 0.95 : 0.92}`,
        },
      ];

  return (
    <motion.div
      initial={{ scaleY: 0, opacity: 0 }}
      animate={{ scaleY: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 240, damping: 22 }}
      style={{ transformOrigin: 'top' }}
      className="relative"
    >
      <div className="relative overflow-hidden rounded-[14px]">
        <DecisionBanner type={type} reason={`${subtitle}。${reason}`} />
        {/* 光晕自左向右扫过一次 */}
        <motion.div
          initial={{ x: '-110%' }}
          animate={{ x: '110%' }}
          transition={{ duration: 1.1, delay: 0.25, ease: 'easeInOut' }}
          className="pointer-events-none absolute inset-y-0 w-1/3"
          style={{
            background: `linear-gradient(100deg, transparent, ${color}26, transparent)`,
          }}
        />
      </div>

      {/* 幕后协商：默认展开，可折叠；expert 视角亮代号，learner 视角换中文口语化 */}
      <div className="mt-2.5">
        <button
          type="button"
          onClick={() => setNegotiationOpen((v) => !v)}
          className="flex w-full items-center justify-center gap-2 rounded-[10px] border border-dashed border-hairline bg-paper-deep/70 px-3 py-2 font-mono text-[11px] text-ink-muted transition-colors hover:border-brand/40 hover:text-brand"
        >
          <Users size={12} />
          {isLearner ? '老师们商量了一下' : '⚙ 幕后协商'} · {negotiations.length} 条
          <ChevronDown size={12} className={cn('transition-transform duration-200', negotiationOpen && 'rotate-180')} />
        </button>
        <AnimatePresence initial={false}>
          {negotiationOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <div className="mt-1.5 space-y-1.5">
                {negotiations.map((n, i) => (
                  <NegotiationBubble
                    key={n.agentId}
                    agentId={n.agentId}
                    content={n.content}
                    isLearner={isLearner}
                    delay={0.15 * i}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 展开内容 */}
      {type === 'simplify' ? (
        <div className="mt-2.5 rounded-[14px] border border-brand/25 bg-card-warm p-4">
          <div className="grid gap-2.5 sm:grid-cols-3">
            {simplify.concepts.map((c, i) => (
              <motion.div
                key={c.title}
                initial={{ scale: 0.9, opacity: 0, y: 10 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                transition={{ delay: 0.2 + i * 0.1, type: 'spring', stiffness: 280, damping: 20 }}
                className="rounded-[10px] border border-hairline bg-paper p-3"
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[13px] font-semibold text-brand">{c.title}</span>
                  <TraceBadge kbId={c.kb} />
                </div>
                <p className="mt-1.5 text-[12px] leading-[19px] text-ink-2">{c.analogy}</p>
              </motion.div>
            ))}
          </div>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.55 }}
            className="mt-2.5 flex items-start gap-2 rounded-[10px] border border-brand-amber/40 bg-brand-amber-tint px-3.5 py-2.5 text-[13px] leading-[21px] text-ink-2"
          >
            <Lightbulb size={15} className="mt-0.5 shrink-0 text-ochre" />
            {simplify.callout}
          </motion.div>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="mt-2.5 rounded-[14px] border border-brand-amber/45 bg-brand-amber-tint/60 p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14.5px] font-semibold text-ochre">{challenge.title}</span>
                <span className="font-mono text-[11px] text-ochre">★★★</span>
                <TraceBadge kbId={challenge.kb} />
              </div>
              <p className="mt-1.5 max-w-[460px] text-[13px] leading-[21px] text-ink-2">
                {challenge.desc}
              </p>
              <div className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-ochre">
                <Medal size={12} /> 完成奖励：{challenge.reward}
              </div>
            </div>
            <button
              type="button"
              disabled={accepted}
              onClick={() => onAccept(challenge.taskText, challenge.kb)}
              className={
                accepted
                  ? 'inline-flex cursor-default items-center gap-1.5 rounded-[10px] border border-brand/40 bg-brand-tint px-4 py-2 text-[13px] font-medium text-brand'
                  : 'inline-flex items-center gap-1.5 rounded-[10px] bg-ochre px-4 py-2 text-[13px] font-medium text-paper transition-all duration-200 hover:shadow-warm'
              }
            >
              {accepted ? '已接受 · 任务已下发' : '接受挑战'} <ArrowUpRight size={14} />
            </button>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}
