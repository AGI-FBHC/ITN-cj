/**
 * KpDetailPanel — 知识点详情侧栏（图谱选中即见进度 + 资源 + 跳转）
 * 选中任一知识点后：掌握度环（对目标差）、AI 把握、路径位置、
 * 已生成资源形态（讲义/实操/分阶题，点击深链资源页），以及"进入交互课件（现场生成）"。
 */
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowRight, BookOpen, Wrench, ListChecks, Sparkles, Target, Gauge, Route } from 'lucide-react';
import { useProfile, dataIdOf } from '@/context/ProfileContext';
import { useAgent } from '@/context/AgentContext';
import { reportForLearner } from '@/data/reportBuilder';
import type { PathNodeStatus } from '@/data/reportData';
import { getKnowledgePoint } from '@/data/knowledgePoints';
import type { KnowledgePoint } from '@/data/knowledgePoints';
import { resourcesForKp } from '@/data/resources';
import type { GeneratedResource } from '@/data/resources';
import type { ResourceForm } from '@/data/resources';
import { Succulent, LeafSmall } from '@/components/heal/Flora';
import type { PathNode } from '@/data/reportData';
import { cn } from '@/lib/utils';

const FORM_META: Record<ResourceForm, { label: string; icon: typeof BookOpen; hint: string }> = {
  lecture: { label: '定制讲义', icon: BookOpen, hint: '按你水平现写的讲义' },
  guide: { label: '实操指南', icon: Wrench, hint: '分步实操 + 安全门控' },
  quiz: { label: '分阶测试题', icon: ListChecks, hint: '基础/进阶/挑战三阶' },
};

const PATH_STATUS: Record<PathNodeStatus, { label: string; cls: string }> = {
  done: { label: '已完成', cls: 'border-brand/30 bg-brand-tint text-brand' },
  active: { label: '进行中 · 本周', cls: 'border-brand-amber/50 bg-brand-amber-tint text-ochre' },
  todo: { label: '待学', cls: 'border-hairline bg-paper-deep text-ink-2' },
  locked: { label: '未解锁', cls: 'border-hairline bg-paper-deep text-ink-muted' },
};

/** 掌握度环：当前分数填充 + 目标刻度 */
function MasteryRing({ score, target }: { score: number; target: number }) {
  const R = 30;
  const C = 2 * Math.PI * R;
  const passed = score >= target;
  const color = passed ? '#E7B45A' : '#4E7860';
  const targetAngle = (target / 100) * 360 - 90;
  const tx = 40 + R * Math.cos((targetAngle * Math.PI) / 180);
  const ty = 40 + R * Math.sin((targetAngle * Math.PI) / 180);
  return (
    <svg viewBox="0 0 80 80" className="h-[80px] w-[80px] shrink-0">
      <circle cx="40" cy="40" r={R} fill="none" stroke="#ECF1EA" strokeWidth="7" />
      <circle
        cx="40"
        cy="40"
        r={R}
        fill="none"
        stroke={color}
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={C * (1 - score / 100)}
        transform="rotate(-90 40 40)"
        style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.22,1,0.36,1)' }}
      />
      {/* 目标刻度 */}
      <circle cx={tx} cy={ty} r="3" fill="#B0483B" />
      <text x="40" y="38" textAnchor="middle" className="font-display" fontSize="20" fontWeight="700" fill="#3D4A3A">
        {score}
      </text>
      <text x="40" y="52" textAnchor="middle" fontSize="8.5" fill="#99A78F" fontFamily="monospace">
        /目标 {target}
      </text>
    </svg>
  );
}

export default function KpDetailPanel({ kpId, kp: kpProp, mastery: masteryProp, confidence: confidenceProp, path: pathProp, resources: resourcesProp }: {
  kpId: string | null;
  kp?: KnowledgePoint | null;
  mastery?: Record<string, number>;
  confidence?: Record<string, number>;
  path?: PathNode[];
  resources?: GeneratedResource[];
}) {
  const navigate = useNavigate();
  const { currentLearner } = useProfile();
  const { confidence } = useAgent();
  const dataId = dataIdOf(currentLearner);
  const report = reportForLearner(currentLearner);

  if (!kpId) {
    return (
      <div className="lf-glass relative flex h-full min-h-[280px] flex-col items-center justify-center rounded-[18px] p-6 text-center">
        <Succulent className="pointer-events-none absolute -top-5 right-5 h-[52px] w-[44px]" />
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-tint text-brand">
          <Route size={20} />
        </span>
        <p className="mt-3 text-[13.5px] font-medium text-ink">点图谱上任一知识点</p>
        <p className="mt-1 text-[12px] leading-[19px] text-ink-muted">
          这里会显示它的掌握进度、路径位置，<br />以及为你生成的学习资源入口。
        </p>
      </div>
    );
  }

  const kp = kpProp ?? getKnowledgePoint(kpId);
  const score = (masteryProp ?? {})[kpId] ?? currentLearner.scores[kpId] ?? 50;
  const conf = (confidenceProp ?? confidence)[kpId] ?? 40;
  const gap = Math.max(0, kp.targetLevel - score);
  const res = resourcesProp ?? resourcesForKp(dataId, kpId);
  const reportPath = pathProp ?? report.path;
  const pathNodes = reportPath.filter((n) => n.kpId === kpId);
  const primaryStatus = pathNodes.find((n) => n.status === 'active')?.status
    ?? pathNodes.find((n) => n.status === 'todo')?.status
    ?? pathNodes[0]?.status
    ?? null;

  return (
    <div className="lf-glass relative flex flex-col gap-4 rounded-[18px] p-5">
      {/* 破框小叶 */}
      <LeafSmall className="pointer-events-none absolute -top-3.5 left-5 h-[28px] w-[42px]" />
      {/* 标题 */}
      <div>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-serif text-[18px] font-semibold text-ink">{kp.name}</h3>
            <div className="mt-0.5 font-mono text-[9.5px] tracking-wide text-ink-muted">{kp.en}</div>
          </div>
          {primaryStatus && (
            <span className={cn('shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium', PATH_STATUS[primaryStatus].cls)}>
              {PATH_STATUS[primaryStatus].label}
            </span>
          )}
        </div>
        <p className="mt-2 text-[12.5px] leading-[19px] text-ink-muted">{kp.description}</p>
      </div>

      {/* 掌握进度 */}
      <div className="flex items-center gap-4 rounded-[12px] border border-hairline bg-card-warm p-3">
        <MasteryRing score={score} target={kp.targetLevel} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
            <Target size={12} className="text-brand-danger" />
            距目标还差 <span className="font-display font-semibold text-ink">{gap}</span> 分
          </div>
          <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
            <Gauge size={12} className="text-brand" />
            AI 把握 <span className="font-display font-semibold text-ink">{conf}%</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-paper-deep">
            <div className="h-full rounded-full bg-brand" style={{ width: `${conf}%` }} />
          </div>
        </div>
      </div>

      {/* 资源入口 */}
      <div>
        <div className="mb-2 text-[12px] font-medium text-ink-2">
          {res.length ? `已经做好 ${res.length} 份，挑一个开始` : 'AI 可以现做，挑一种：'}
        </div>
        <div className="space-y-2">
          {res.length > 0 &&
            res.map((r) => {
              const meta = FORM_META[r.form];
              const Icon = meta.icon;
              return (
                <button
                  key={r.form}
                  type="button"
                  onClick={() => navigate(`/resources?tab=${r.form}`)}
                  className="group flex w-full items-center gap-3 rounded-[10px] border border-hairline bg-paper px-3 py-2.5 text-left transition-all hover:border-brand/45 hover:bg-brand-tint/40"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint text-brand">
                    <Icon size={16} strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{meta.label}</span>
                    <span className="block truncate text-[11px] text-ink-muted">{r.title}</span>
                  </span>
                  <ArrowRight size={14} className="shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand" />
                </button>
              );
            })}

          {/* 无预制资源：三形态「点击生成」入口（GEN-03 按画像现场生成） */}
          {res.length === 0 &&
            (Object.keys(FORM_META) as ResourceForm[]).map((f) => {
              const meta = FORM_META[f];
              const Icon = meta.icon;
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => {
                    toast.success('AI 开始现做', {
                      description: `正在按你的水平现做《${kp.name} · ${meta.label}》`,
                    });
                    navigate(`/learn/${kpId}`);
                  }}
                  className="group flex w-full items-center gap-3 rounded-[10px] border border-dashed border-brand/35 bg-paper px-3 py-2.5 text-left transition-all hover:border-brand/60 hover:bg-brand-tint/40"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint text-brand">
                    <Icon size={16} strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">生成{meta.label}</span>
                    <span className="block truncate text-[11px] text-ink-muted">{meta.hint}</span>
                  </span>
                  <Sparkles size={13} className="shrink-0 text-brand/70 transition-transform group-hover:scale-110" />
                </button>
              );
            })}

          {/* 交互课件（始终可进；无预制资源时作为主入口高亮） */}
          <button
            type="button"
            onClick={() => navigate(`/learn/${kpId}`)}
            className={cn(
              'group flex w-full items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left transition-all',
              res.length
                ? 'border-hairline bg-paper hover:border-brand/45 hover:bg-brand-tint/40'
                : 'border-brand/35 bg-brand-tint/50 hover:border-brand/60',
            )}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-paper">
              <Sparkles size={15} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-ink">进入交互课件</span>
              <span className="block text-[11px] text-ink-muted">AI 现做课件 · 支持语音讲课</span>
            </span>
            <ArrowRight size={14} className="shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-brand" />
          </button>
        </div>
      </div>
    </div>
  );
}
