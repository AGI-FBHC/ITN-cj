/**
 * UnitQuickList — 章节速览（学页信息架构改版新增）
 * 承接原「单元列表」唯一的独有价值：一眼扫全 6 个单元。
 * 一行一单元：状态点 + 名称 + 微型学习进度条 + 进度值；
 * 点行 = 选中网络对应节点（与网络、详情栏三向联动）；「我的路线」场景下按路径顺序重排带序号。
 * 无卡框：divide-y 细分隔线（结构进分隔线，不进边框）。
 */
import { useMemo, useState } from 'react';
import { useProfile } from '@/context/ProfileContext';
import { reportForLearner } from '@/data/reportBuilder';
import { knowledgePoints } from '@/data/knowledgePoints';
import { cn } from '@/lib/utils';
import type { KnowledgePoint } from '@/data/knowledgePoints';
import type { PathNode } from '@/data/reportData';

const lerpChannel = (from: number, to: number, ratio: number) => Math.round(from + (to - from) * ratio);

/** 状态点：未学为空心，开始后按真实进度从黄色连续过渡到绿色。 */
function StatusDot({ progress }: { progress: number }) {
  const normalized = Math.max(0, Math.min(100, progress)) / 100;
  const color = `rgb(${lerpChannel(222, 47, normalized)}, ${lerpChannel(168, 143, normalized)}, ${lerpChannel(63, 91, normalized)})`;
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" className="shrink-0" aria-hidden>
      {progress <= 0
        ? <circle cx="6" cy="6" r="5" fill="none" stroke="#C4D3C8" strokeWidth="1.5" />
        : <circle cx="6" cy="6" r="5" fill={color} stroke={color} strokeWidth="1.2" />}
    </svg>
  );
}

export default function UnitQuickList({
  selectedKpId,
  onSelect,
  routeOrdered = false,
  columns = false,
  items: itemsProp,
  path: pathProp,
  mastery: masteryProp,
  progress: progressProp,
  nodeTargets,
  onSelectTopic,
}: {
  selectedKpId?: string | null;
  onSelect: (kpId: string) => void;
  /** 「我的路线」场景：按学习路径顺序重排并带序号 */
  routeOrdered?: boolean;
  /** 横向紧凑网格：全局宽度下按可用空间扩到 2~5 列。 */
  columns?: boolean;
  items?: KnowledgePoint[];
  path?: PathNode[];
  mastery?: Record<string, number>;
  progress?: Record<string, number>;
  /** 目标岗位门槛：nodeCode → { target, name }（章节门槛在速览进度条体现） */
  nodeTargets?: Record<string, { target: number; name?: string }>;
  /** 点击展开区子知识点：模拟在 3D/2D 网络里点击该知识点 */
  onSelectTopic?: (kpId: string, topicIndex: number) => void;
}) {
  const { currentLearner } = useProfile();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const report = reportForLearner(currentLearner);
  const reportPath = pathProp ?? report.path;
  const mastery = masteryProp ?? {};
  const progress = progressProp ?? mastery;

  /* 路径顺序（去重保序） */
  const pathSeq = useMemo(() => {
    const seq: string[] = [];
    reportPath.forEach((p) => {
      if (!seq.includes(p.kpId)) seq.push(p.kpId);
    });
    return seq;
  }, [reportPath]);

  const items = useMemo(() => {
    const source = itemsProp ?? knowledgePoints;
    if (!routeOrdered) return source;
    return [...source].sort((a, b) => {
      const ia = pathSeq.indexOf(a.id);
      const ib = pathSeq.indexOf(b.id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [routeOrdered, pathSeq, itemsProp]);

  return (
    <div>
      <div className="flex items-baseline justify-between px-1">
        <span className="text-[12.5px] font-medium text-ink">章节速览</span>
        <span className="text-[10.5px] text-ink-muted">点一行 · 图上看它的位置</span>
      </div>
      <div className={cn('mt-1 items-start', columns ? 'flex flex-wrap gap-2.5' : 'divide-y divide-hairline/70')}>
        {items.map((kp) => {
          /* 速览统一显示掌握程度与目标（学习进度只在资源卡片里展示） */
          const progressValue = mastery[kp.id] ?? progress[kp.id] ?? 0;
          const threshold = nodeTargets?.[kp.id]?.target;
          const seq = routeOrdered ? pathSeq.indexOf(kp.id) : -1;
          const selected = selectedKpId === kp.id;
          const expanded = expandedId === kp.id;
          const categoryLabel = kp.parentName;
          const title = kp.name;
          const topicCount = kp.coreTopics?.length ?? 0;
          return (
            <div
              key={kp.id}
              style={expanded && columns ? { width: '100%' } : undefined}
              className={cn(
                'overflow-hidden transition-all duration-200',
                columns
                  ? 'w-full rounded-[14px] border bg-white/30 shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:border-black/10 hover:bg-white/70 sm:w-[calc(50%-0.3125rem)] lg:w-[calc(33.333%-0.4167rem)] xl:w-[calc(25%-0.46875rem)] 2xl:w-[calc(20%-0.5rem)]'
                  : 'w-full rounded-[10px] border border-transparent bg-white/20',
                expanded && 'border-[#2E6BA8]/25 bg-[#F5FAFF]',
              )}
            >
              <button
                type="button"
                onClick={() => {
                  const next = expanded ? null : kp.id;
                  setExpandedId(next);
                  onSelect(kp.id);
                }}
                className={cn(
                  'group flex w-full items-center gap-2.5 px-2 py-3 text-left transition-all duration-200',
                  columns ? 'rounded-[14px]' : 'rounded-[10px] px-2.5',
                  selected
                    ? 'bg-[#EAF3FB]'
                    : cn(columns && 'bg-transparent', !columns && 'bg-white/20 hover:bg-white/60'),
                )}
              >
                {seq >= 0 && (
                  <span className="w-4 shrink-0 font-mono text-[10.5px] font-semibold text-ochre">{seq + 1}</span>
                )}
                <StatusDot progress={progressValue} />
                <span className="min-w-0 flex-1">
                  {/* 第一行：章节标签 + 学习进度条 + 进度值，不挤压标题 */}
                  <span className="flex items-center gap-2">
                    <span className="text-[10.5px] font-medium leading-[14px] text-brand/70">{categoryLabel ?? ''}</span>
                    <span className="ml-auto flex items-center gap-2">
                      <span className="relative h-1.5 w-10 shrink-0 overflow-hidden rounded-full border border-black/[0.06] bg-[#E8EDF2] xl:w-12" title={`掌握程度 ${progressValue}%${threshold ? ` · 目标 ${threshold}%` : ''}`}>
                        <span className="absolute inset-y-0 left-0 rounded-full bg-[#3B82F6]" style={{ width: `${progressValue}%` }} />
                        {threshold != null && threshold > 0 && (
                          <span className="absolute inset-y-[-1.5px] w-[2px] rounded-full bg-[#155E9A]" style={{ left: `${Math.min(100, threshold)}%` }} title={`目标 ${threshold}%`} />
                        )}
                      </span>
                      <span className="w-12 shrink-0 text-right font-mono text-[10.5px] tabular-nums" title={`掌握程度 ${progressValue}%${threshold != null ? ` · 目标 ${threshold}%` : ''}`}>
                        <span className="text-[#174E43]">{progressValue}%</span>
                        {threshold != null && threshold > 0 && (
                          <span className="text-[#155E9A]">/{threshold}%</span>
                        )}
                      </span>
                    </span>
                  </span>
                  {/* 第二行：标题独占整行宽度 */}
                  <span className={cn('block text-[13px] leading-[17px] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden', selected ? 'font-medium text-ink' : 'text-ink-2')} title={kp.name}>
                    {title}
                  </span>
                </span>
              </button>
              {expanded && topicCount > 0 && (
                <div className={cn('border-t border-[#2E6BA8]/10 px-3 pb-3 pt-2.5', columns ? 'bg-[#F5FAFF]' : 'bg-[#F7FAFC]')}>
                  <div className="grid auto-rows-min grid-cols-2 gap-1.5 sm:grid-cols-4">
                    {kp.coreTopics.map((topic, index) => (
                      <button
                        key={`${kp.id}-${index}`}
                        type="button"
                        onClick={() => onSelectTopic?.(kp.id, index)}
                        className="flex items-center gap-1.5 rounded-lg border border-black/[0.04] bg-white/70 px-2 py-1.5 text-left text-[11.5px] leading-4 text-ink-2 transition-colors hover:border-brand/30 hover:bg-white hover:text-ink"
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand/50" />
                        <span className="min-w-0 truncate">{topic}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
