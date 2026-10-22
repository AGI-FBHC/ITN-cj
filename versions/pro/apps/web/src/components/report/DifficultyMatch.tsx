/**
 * DifficultyMatch — 资源难度匹配曲线（report.md S3，本页核心图，全宽）
 * 学习者能力曲线（墨绿）vs 已分配资源难度曲线（琥珀阶梯）+ ±10 适配带 + Y=85 适配目标线
 * 带外资源点以砖红圈出并标注「第 2 周已回调」
 */
import { useMemo } from 'react';
import type { Learner } from '@/data/learners';
import { weakestKpOf } from '@/data/learners';
import type { LearnerReport } from '@/data/reportData';
import { knowledgePoints, getKnowledgePoint } from '@/data/knowledgePoints';
import ChartCard, { ReactECharts } from '@/components/ChartCard';

/** 非带外知识点的资源难度偏移（均落在 ±10 适配带内） */
const offsetByKp: Record<string, number> = {
  'kp-plc': 5,
  'kp-kinematics': -6,
  'kp-sensor': -8,
  'kp-vision': -3,
  'kp-safety': -4,
  'kp-diagnosis': -7,
};

const clamp = (v: number) => Math.max(0, Math.min(100, v));

export default function DifficultyMatch({
  learner,
  report,
}: {
  learner: Learner;
  report: LearnerReport;
}) {
  const model = useMemo(() => {
    /* 按学习路径首现顺序排列 6 个知识点 */
    const orderedIds: string[] = [];
    report.path.forEach((n) => {
      if (!orderedIds.includes(n.kpId)) orderedIds.push(n.kpId);
    });
    knowledgePoints.forEach((kp) => {
      if (!orderedIds.includes(kp.id)) orderedIds.push(kp.id);
    });

    const weakestId = weakestKpOf(learner);
    const names = orderedIds.map((id) => getKnowledgePoint(id).name);
    const ability = orderedIds.map((id) => learner.scores[id] ?? 0);
    /* 最大盲区：初期直接投喂高难度资源（带外 +13），第 2 周已由 ARB-05 回调 */
    const difficulty = orderedIds.map((id, i) =>
      clamp(id === weakestId ? ability[i] + 13 : ability[i] + (offsetByKp[id] ?? 0)),
    );
    const outIdx = orderedIds.indexOf(weakestId);
    /* 能力更新轨迹：取最大盲区维度 3 个关键周的能力快照（W2/W5/W8），mock 推导为当前值 -8/-3/0 */
    const abilityNow = ability[outIdx];
    const trajectory = [
      { week: 'W2', value: clamp(abilityNow - 8) },
      { week: 'W5', value: clamp(abilityNow - 3) },
      { week: 'W8', value: clamp(abilityNow) },
    ];
    return { names, ability, difficulty, outIdx, trajectory };
  }, [learner, report]);

  const option = useMemo(() => {
    const { names, ability, difficulty, outIdx, trajectory } = model;
    return {
      animationDuration: 900,
      tooltip: {
        trigger: 'axis' as const,
        /* hover 联动十字准星（report.md S3） */
        axisPointer: {
          type: 'cross' as const,
          label: { show: false },
          lineStyle: { color: '#CFC8B8' },
          crossStyle: { color: '#CFC8B8' },
        },
        formatter: (params: unknown) => {
          const list = (params as { seriesName: string; value: number; axisValue: string }[]).filter(
            (p) => p.seriesName === '学习者能力曲线' || p.seriesName === '已分配资源难度',
          );
          const ab = list.find((p) => p.seriesName === '学习者能力曲线')?.value ?? 0;
          const df = list.find((p) => p.seriesName === '已分配资源难度')?.value ?? 0;
          const inBand = Math.abs(df - ab) <= 10;
          const title = list[0]?.axisValue ?? '';
          /* 命中最大盲区维度：融入学习者能力更新轨迹（W2/W5/W8 快照） */
          const trajLine = title === names[outIdx]
            ? `<div style="font-size:11.5px;line-height:18px;margin-top:4px;padding-top:4px;border-top:1px dashed #DCE6DE;color:#2F4A38">能力更新轨迹 ${trajectory.map((t) => `${t.week}:${t.value}`).join(' → ')}</div>`
            : '';
          return [
            `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:#66725E;margin-bottom:4px">${title}</div>`,
            `<div style="font-size:12px;line-height:20px">能力值 <b>${ab}</b> ／ 资源难度 <b>${df}</b></div>`,
            inBand
              ? `<div style="font-size:12px;color:#4E7860;font-weight:600">适配状态 ✓ 带内（±10）</div>`
              : `<div style="font-size:12px;color:#B0483B;font-weight:600">适配状态 ✗ 带外 · 第 2 周已回调</div>`,
            trajLine,
          ].join('');
        },
      },
      legend: {
        bottom: 0,
        icon: 'roundRect',
        itemWidth: 12,
        itemHeight: 8,
        data: ['学习者能力曲线', '已分配资源难度', '适配带 ±10', '能力更新轨迹'],
      },
      grid: { top: 40, left: 16, right: 24, bottom: 34, containLabel: true },
      xAxis: {
        type: 'category' as const,
        data: names,
        boundaryGap: false,
        axisLabel: { interval: 0, fontSize: 11 },
      },
      yAxis: { type: 'value' as const, min: 0, max: 100 },
      series: [
        {
          name: '适配带下沿',
          type: 'line' as const,
          data: ability.map((a) => a - 10),
          stack: 'adapt-band',
          symbol: 'none',
          silent: true,
          lineStyle: { opacity: 0 },
          areaStyle: { opacity: 0 },
          emphasis: { disabled: true },
        },
        {
          name: '适配带 ±10',
          type: 'line' as const,
          data: ability.map(() => 20),
          stack: 'adapt-band',
          symbol: 'none',
          silent: true,
          lineStyle: { opacity: 0 },
          areaStyle: { color: 'rgba(78, 120, 96,0.08)' },
          emphasis: { disabled: true },
          animationDuration: 600,
          animationDelay: 300,
        },
        {
          name: '学习者能力曲线',
          type: 'line' as const,
          data: ability,
          smooth: true,
          symbol: 'circle',
          symbolSize: 7,
          lineStyle: { color: '#4E7860', width: 2.5 },
          itemStyle: { color: '#4E7860', borderColor: '#FBFAF5', borderWidth: 1.5 },
          label: {
            show: true,
            position: 'bottom' as const,
            fontSize: 10,
            fontFamily: '"IBM Plex Mono", monospace',
            color: '#4E7860',
          },
          z: 5,
        },
        {
          name: '已分配资源难度',
          type: 'line' as const,
          data: difficulty,
          step: 'middle' as const,
          symbol: 'diamond',
          symbolSize: 9,
          lineStyle: { color: '#E7B45A', width: 2 },
          itemStyle: { color: '#E7B45A', borderColor: '#FBFAF5', borderWidth: 1 },
          animationDelay: 500,
          markPoint: {
            symbol: 'circle',
            symbolSize: 22,
            itemStyle: { color: 'rgba(176,72,59,0.08)', borderColor: '#B0483B', borderWidth: 2 },
            label: {
              show: true,
              position: 'top' as const,
              distance: 8,
              formatter: '带外 · 已回调',
              fontSize: 10,
              fontFamily: '"IBM Plex Mono", monospace',
              color: '#B0483B',
            },
            data: [{ coord: [outIdx, difficulty[outIdx]] }],
          },
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: '#66725E', type: 'dashed' as const, width: 1 },
            label: {
              formatter: '适配参考线',
              position: 'insideEndTop' as const,
              fontSize: 10,
              fontFamily: '"IBM Plex Mono", monospace',
              color: '#66725E',
            },
            data: [{ yAxis: 85 }],
          },
          z: 6,
        },
        {
          /* 学习者能力更新轨迹：最大盲区维度的 3 个关键周快照，小圆点墨绿描边 */
          name: '能力更新轨迹',
          type: 'scatter' as const,
          data: trajectory.map((t) => ({ value: [outIdx, t.value], name: t.week })),
          symbolSize: 9,
          itemStyle: { color: '#FBFAF5', borderColor: '#2F4A38', borderWidth: 1.8 },
          label: {
            show: true,
            formatter: '{b}',
            position: 'right' as const,
            distance: 6,
            fontSize: 9.5,
            fontFamily: '"IBM Plex Mono", monospace',
            color: '#2F4A38',
          },
          emphasis: { scale: 1.35 },
          animationDelay: 700,
          z: 7,
        },
      ],
    };
  }, [model]);

  return (
    <ChartCard
      title="资源难度匹配曲线"
      en="ABILITY × RESOURCE-DIFFICULTY · ADAPTATION BAND ±10"
      actions={
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-brand/30 bg-brand-tint px-2.5 py-1 font-mono text-[11px] font-medium text-brand">
          资源适配准确率 {report.adaptScore}%
        </span>
      }
    >
      <ReactECharts option={option} height={360} />
    </ChartCard>
  );
}
