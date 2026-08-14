/**
 * UnitQuickList — 章节速览（学页信息架构改版新增）
 * 承接原「单元列表」唯一的独有价值：一眼扫全 6 个单元。
 * 一行一单元：状态点 + 名称 + 微型学习进度条 + 进度值；
 * 点行 = 选中图谱对应节点（与图谱、详情栏三向联动）；「我的路线」场景下按路径顺序重排带序号。
 * 无卡框：divide-y 细分隔线（结构进分隔线，不进边框）。
 */
import { useMemo } from 'react';
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
}) {
  const { currentLearner } = useProfile();
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
      <div className={cn('mt-1', columns ? 'grid gap-x-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5' : 'divide-y divide-hairline/70')}>
        {items.map((kp) => {
          const progressValue = progress[kp.id] ?? 0;
          const threshold = nodeTargets?.[kp.id]?.target;
          const seq = routeOrdered ? pathSeq.indexOf(kp.id) : -1;
          const selected = selectedKpId === kp.id;
          // 数据库章节名自带「第X章」前缀，拆出来单独一行小字，主标题更清晰
          const nameMatch = kp.name.match(/^(第[一二三四五六七八九十百零\d]+章)\s*(.*)$/);
          const chapterTag = nameMatch ? nameMatch[1] : null;
          const title = nameMatch && nameMatch[2] ? nameMatch[2] : kp.name;
          return (
            <button
              key={kp.id}
              type="button"
              onClick={() => onSelect(kp.id)}
              className={cn(
                'flex w-full items-center gap-2.5 px-1.5 py-2.5 text-left transition-colors',
                columns && 'rounded-[8px] border-b border-hairline/50',
                selected ? 'bg-brand-tint/40' : 'hover:bg-paper-deep/40',
              )}
            >
              {seq >= 0 && (
                <span className="w-4 shrink-0 font-mono text-[10.5px] font-semibold text-ochre">{seq + 1}</span>
              )}
              <StatusDot progress={progressValue} />
              <span className="min-w-0 flex-1">
                {/* 第一行：章节标签 + 学习进度条 + 进度值，不挤压标题 */}
                <span className="flex items-center gap-2">
                  <span className="text-[10.5px] font-medium leading-[14px] text-brand/70">{chapterTag ?? ''}</span>
                  <span className="ml-auto flex items-center gap-2">
                    <span className="relative h-1.5 w-10 shrink-0 overflow-hidden rounded-full border border-hairline/80 bg-paper-deep xl:w-12" title={`学习进度 ${progressValue}%${threshold ? ` · 目标门槛 ${threshold}%` : ''}`}>
                      <span className="absolute inset-y-0 left-0 rounded-full bg-[#55B9DC]" style={{ width: `${progressValue}%` }} />
                      {threshold != null && threshold > 0 && (
                        <span className="absolute inset-y-[-1.5px] w-[2px] rounded-full bg-[#155E9A]" style={{ left: `${Math.min(100, threshold)}%` }} title={`目标门槛 ${threshold}%`} />
                      )}
                    </span>
                    <span className="w-8 shrink-0 text-right font-mono text-[10.5px] text-ink-muted tabular-nums">
                      {progressValue}%
                    </span>
                  </span>
                </span>
                {/* 第二行：标题独占整行宽度 */}
                <span className={cn('block text-[13px] leading-[17px] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden', selected ? 'font-medium text-ink' : 'text-ink-2')} title={kp.name}>
                  {title}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
