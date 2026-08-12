/**
 * UnitQuickList — 章节速览（学页信息架构改版新增）
 * 承接原「单元列表」唯一的独有价值：一眼扫全 6 个单元。
 * 一行一单元：状态点（●达标金 / ◐在学绿 / ○未学）+ 名称 + 微型掌握条 + 分数；
 * 点行 = 选中图谱对应节点（与图谱、详情栏三向联动）；「我的路线」场景下按路径顺序重排带序号。
 * 无卡框：divide-y 细分隔线（结构进分隔线，不进边框）。
 */
import { useMemo } from 'react';
import { useProfile } from '@/context/ProfileContext';
import { reportForLearner } from '@/data/reportBuilder';
import { knowledgePoints } from '@/data/knowledgePoints';
import { learnedKpIds } from '@/data/knowledgeGraph';
import { cn } from '@/lib/utils';
import type { KnowledgePoint } from '@/data/knowledgePoints';
import type { PathNode } from '@/data/reportData';

/** 状态点：达标=实心金，在学=左半绿，未学=空圈 */
function StatusDot({ state }: { state: 'passed' | 'learning' | 'todo' }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" className="shrink-0" aria-hidden>
      {state === 'passed' && <circle cx="6" cy="6" r="5" fill="#DEA83F" />}
      {state === 'learning' && (
        <>
          <circle cx="6" cy="6" r="5" fill="none" stroke="#4E7860" strokeWidth="1.5" />
          <path d="M 6 1 A 5 5 0 0 0 6 11 Z" fill="#4E7860" opacity="0.85" />
        </>
      )}
      {state === 'todo' && <circle cx="6" cy="6" r="5" fill="none" stroke="#C4D3C8" strokeWidth="1.5" />}
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
  learned: learnedProp,
  mastery: masteryProp,
}: {
  selectedKpId?: string | null;
  onSelect: (kpId: string) => void;
  /** 「我的路线」场景：按学习路径顺序重排并带序号 */
  routeOrdered?: boolean;
  /** 横向紧凑网格：全局宽度下按可用空间扩到 2~5 列。 */
  columns?: boolean;
  items?: KnowledgePoint[];
  path?: PathNode[];
  learned?: Set<string>;
  mastery?: Record<string, number>;
}) {
  const { currentLearner } = useProfile();
  const report = reportForLearner(currentLearner);
  const reportPath = pathProp ?? report.path;
  const learned = learnedProp ?? useMemo(() => {
    const pathDone = reportPath.filter((p) => p.status === 'done').map((p) => p.kpId);
    return learnedKpIds(currentLearner, pathDone);
  }, [currentLearner, reportPath]);
  const mastery = masteryProp ?? {};

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
          const score = mastery[kp.id] ?? 50;
          const isLearned = learned.has(kp.id);
          const state: 'passed' | 'learning' | 'todo' =
            isLearned && score >= kp.targetLevel ? 'passed' : isLearned ? 'learning' : 'todo';
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
              <StatusDot state={state} />
              <span className="min-w-0 flex-1">
                {chapterTag && (
                  <span className="block text-[10.5px] font-medium leading-[14px] text-brand/70">{chapterTag}</span>
                )}
                <span className={cn('block text-[13px] leading-[17px] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden', selected ? 'font-medium text-ink' : 'text-ink-2')} title={kp.name}>
                  {title}
                </span>
              </span>
              {/* 微型掌握条 + 目标刻度（未学的单元不画刻度——空条上飘孤立红点很怪） */}
              <span className={cn('relative h-1 w-10 shrink-0 overflow-hidden rounded-full bg-paper-deep xl:w-12', !isLearned && 'opacity-50')}>
                {isLearned && (
                  <>
                    <span
                      className={cn('absolute inset-y-0 left-0 rounded-full', state === 'passed' ? 'bg-brand-amber' : 'bg-brand')}
                      style={{ width: `${score}%` }}
                    />
                    <span className="absolute inset-y-0 w-[2px] bg-brand-danger/60" style={{ left: `${kp.targetLevel}%` }} />
                  </>
                )}
              </span>
              <span className="w-6 shrink-0 text-right font-mono text-[10.5px] text-ink-muted tabular-nums">
                {isLearned ? score : '—'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
