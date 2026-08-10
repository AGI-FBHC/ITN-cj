/**
 * MyProfile `/me/profile` — 「我的画像」活页
 * 可编辑：六维滑杆 / 盲区 chip / 目标 → 保存即 DIA-01 重诊断 + 写入变更时间线
 * 变更时间线：建档 / 手动编辑 / 学习回写，均可溯源；含「模拟一次练习回写」演示
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { Save, Sparkles, Brain, History, Wand2, PlusCircle, RotateCcw, HelpCircle } from 'lucide-react';
import { useProfile } from '@/context/ProfileContext';
import type { ProfileEvent } from '@/context/ProfileContext';
import { useAgent } from '@/context/AgentContext';
import { knowledgePoints, getKnowledgePoint } from '@/data/knowledgePoints';
import { weightedScore } from '@/components/profiles/profileMeta';
import { ReactECharts } from '@/components/ChartCard';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import PageBack from '@/components/PageBack';
import ConfidenceBadge from '@/components/ConfidenceBadge';
import { cn } from '@/lib/utils';

function radarOption(scores: Record<string, number>, confidence?: Record<string, number>) {
  return {
    animationDuration: 500,
    radar: {
      indicator: knowledgePoints.map((kp) => {
        const c = confidence?.[kp.id] ?? 100;
        /* 标签实度 = 阿诊对该维判断的置信度（弱证据维度淡显） */
        return { name: kp.name, max: 100, color: `rgba(70, 100, 80,${(0.3 + 0.7 * (c / 100)).toFixed(2)})` };
      }),
      radius: '66%',
      center: ['50%', '54%'] as [string, string],
      axisName: { color: '#5A6553', fontSize: 11, fontFamily: '"Noto Sans SC", sans-serif' },
      splitLine: { lineStyle: { color: '#E9E3D4' } },
      splitArea: { areaStyle: { color: ['rgba(253,252,249,0)', 'rgba(240,235,224,0.5)'] } },
      axisLine: { lineStyle: { color: '#DCE6DE' } },
    },
    legend: { bottom: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8, data: ['当前能力', '岗位目标'] },
    series: [
      {
        type: 'radar' as const,
        data: [
          {
            value: knowledgePoints.map((kp) => kp.targetLevel),
            name: '岗位目标',
            symbol: 'none',
            lineStyle: { color: '#E7B45A', width: 1.5, type: 'dashed' as const },
            itemStyle: { color: '#E7B45A' },
            areaStyle: { color: 'rgba(231, 180, 90,0)' },
          },
          {
            value: knowledgePoints.map((kp) => scores[kp.id] ?? 50),
            name: '当前能力',
            symbolSize: 4,
            lineStyle: { color: '#4E7860', width: 2.5 },
            itemStyle: { color: '#4E7860' },
            areaStyle: { color: 'rgba(78, 120, 96,0.24)' },
          },
        ],
      },
    ],
  };
}

const kindMeta: Record<ProfileEvent['kind'], { label: string; cls: string }> = {
  create: { label: '建档', cls: 'border-brand/30 bg-brand-tint text-brand' },
  edit: { label: '手动编辑', cls: 'border-ochre/40 bg-ochre-tint text-ochre' },
  writeback: { label: '学习回写', cls: 'border-brand-amber/50 bg-brand-amber-tint text-ochre' },
};

export default function MyProfile() {
  const { currentLearner, patchLearner, applyWriteback, getEvents } = useProfile();
  const { confidence } = useAgent();

  const [scores, setScores] = useState<Record<string, number>>({ ...currentLearner.scores });
  const [blind, setBlind] = useState<string[]>(
    knowledgePoints.filter((kp) => currentLearner.blindSpots.includes(kp.name)).map((kp) => kp.id),
  );
  const [goal, setGoal] = useState(currentLearner.goal);

  /* 切换学习者时重置编辑态 */
  useEffect(() => {
    setScores({ ...currentLearner.scores });
    setBlind(knowledgePoints.filter((kp) => currentLearner.blindSpots.includes(kp.name)).map((kp) => kp.id));
    setGoal(currentLearner.goal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLearner.id]);

  const events = getEvents(currentLearner.id);

  const deltas = useMemo(
    () =>
      knowledgePoints
        .map((kp) => ({ kpId: kp.id, from: currentLearner.scores[kp.id] ?? 50, to: scores[kp.id] ?? 50 }))
        .filter((d) => d.from !== d.to),
    [scores, currentLearner],
  );
  const dirty = deltas.length > 0 || goal !== currentLearner.goal;

  const sorted = [...knowledgePoints].map((kp) => ({ kp, s: scores[kp.id] ?? 50 })).sort((a, b) => a.s - b.s);
  const weakest = sorted[0];

  const diaLine = `当前最弱「${weakest.kp.name}」${weakest.s} 分，距目标 ${Math.max(0, weakest.kp.targetLevel - weakest.s)} 分。${
    dirty ? '保存后我会据此重排学习路径。' : '画像与路径已同步。'
  }`;

  const save = () => {
    patchLearner(
      currentLearner.id,
      { scores, goal, blindSpots: blind.map((id) => getKnowledgePoint(id).name) },
      {
        week: '手动',
        kind: 'edit',
        title: '手动调整画像',
        detail: `${deltas.length ? `${deltas.length} 维改动` : '目标/盲区调整'} · DIA-01 已重排学习路径`,
        deltas: deltas.length ? deltas : undefined,
      },
    );
    toast.success('画像已保存', { description: 'DIA-01 已据新画像重排学习路径' });
  };

  const simulate = () => {
    applyWriteback(currentLearner.id, [{ kpId: weakest.kp.id, delta: 4 }], {
      week: '本次',
      title: `模拟完成《${weakest.kp.name}》练习`,
      detail: `后测提升 · ARB-05 回写「${weakest.kp.name}」`,
    });
    toast.success('画像已更新', { description: `「${weakest.kp.name}」+4 分 · 见变更时间线` });
  };

  return (
    <div className="mx-auto max-w-[980px] px-5 pb-24 pt-8 md:px-6">
      <PageBack parent={{ label: '我的学习', to: '/me' }} current="我的画像" />
      {/* 头部 */}
      <div className="flex flex-wrap items-center gap-4">
        <Avatar className="h-14 w-14 border border-hairline shadow-warm">
          <AvatarImage src={currentLearner.avatar} alt={currentLearner.name} />
          <AvatarFallback className="bg-brand-tint text-brand">{currentLearner.name.slice(0, 1)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <h1 className="font-serif text-[24px] font-semibold text-ink">
            {currentLearner.name} · 我的画像
            {currentLearner.custom && (
              <span className="ml-2 rounded-md border border-brand/30 bg-brand-tint px-1.5 py-0.5 align-middle font-mono text-[10px] text-brand">自建</span>
            )}
          </h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-muted">
            <span>{currentLearner.tag} · {currentLearner.targetJob} · 综合适配 {weightedScore({ scores })} 分</span>
            <ConfidenceBadge learnerId={currentLearner.id} />
          </p>
        </div>
        <Link to="/onboarding" className="lf-btn-ghost !px-4 !py-2 text-[13px]">
          <PlusCircle size={15} />
          新建画像
        </Link>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* 左：可编辑 */}
        <div className="space-y-5">
          <div className="lf-card space-y-3 p-5">
            <div className="flex items-center justify-between">
              <div className="lf-mono-label !text-[11px]">六维能力（拖动调整）</div>
              {dirty && <span className="font-mono text-[11px] text-ochre">未保存</span>}
            </div>
            {knowledgePoints.map((kp) => (
              <div key={kp.id}>
                <div className="mb-1 flex items-center justify-between text-[12.5px]">
                  <span className="text-ink-2">{kp.name}</span>
                  <span className="font-mono">
                    <span className="font-semibold text-brand">{scores[kp.id] ?? 50}</span>
                    <span className="text-ink-muted"> / 目标 {kp.targetLevel}</span>
                  </span>
                </div>
                <input
                  type="range"
                  min={20}
                  max={92}
                  value={scores[kp.id] ?? 50}
                  onChange={(e) => setScores((prev) => ({ ...prev, [kp.id]: Number(e.target.value) }))}
                  className="w-full accent-brand"
                />
              </div>
            ))}
          </div>

          <div className="lf-card p-5">
            <div className="lf-mono-label mb-2 !text-[11px]">盲区标签（点选增删）</div>
            <div className="flex flex-wrap gap-2">
              {knowledgePoints.map((kp) => {
                const on = blind.includes(kp.id);
                return (
                  <button
                    key={kp.id}
                    type="button"
                    onClick={() => setBlind((prev) => (prev.includes(kp.id) ? prev.filter((x) => x !== kp.id) : [...prev, kp.id]))}
                    className={cn(
                      'rounded-lg border px-2.5 py-1 text-[12.5px] font-medium transition-all',
                      on ? 'border-brand-danger/50 bg-brand-danger/10 text-brand-danger' : 'border-hairline bg-paper text-ink-muted hover:border-brand/40',
                    )}
                  >
                    {kp.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="lf-card p-5">
            <div className="lf-mono-label mb-2 !text-[11px]">学习目标</div>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-[10px] border border-hairline bg-paper px-3 py-2 text-[13.5px] leading-[21px] text-ink outline-none focus:border-brand/50"
            />
          </div>

          {/* DIA 重诊断 + 保存 */}
          <div className="flex items-start gap-3 rounded-[12px] border border-brand/20 bg-brand-tint/40 p-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-brand text-paper">
              <Brain size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="lf-mono-label !text-[10px]">DIA-01 实时诊断</div>
              <p className="mt-0.5 text-[13px] leading-[20px] text-ink-2">{diaLine}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={save}
              disabled={!dirty}
              className={cn('lf-btn-primary !py-2 text-[13.5px]', !dirty && 'cursor-not-allowed opacity-50')}
            >
              <Save size={15} />
              保存修改
            </button>
            <button type="button" onClick={simulate} className="lf-btn-ghost !py-2 text-[13.5px]">
              <Wand2 size={15} />
              模拟一次练习回写
            </button>
          </div>
        </div>

        {/* 右：雷达 + 时间线 */}
        <div className="space-y-5">
          <div className="lf-card p-5">
            <div className="lf-mono-label mb-1 !text-[11px]">画像向量 · 当前 vs 目标</div>
            <ReactECharts option={radarOption(scores, confidence)} height={320} />
            <p className="mt-1 border-t border-hairline pt-2 text-[11px] leading-[16px] text-ink-muted">
              维度标签越实，阿诊对该维的判断越有把握（置信度随答题、阅读等证据积累）；淡显的维度多做两组题即可提升。
            </p>
          </div>

          <div className="lf-card p-5">
            <div className="mb-3 flex items-center gap-2">
              <History size={16} className="text-brand" />
              <span className="text-[15px] font-semibold text-ink">画像变更时间线</span>
            </div>
            {events.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <p className="text-[13px] text-ink-muted">这个画像还没有变更记录。</p>
                <Link to="/onboarding" className="lf-btn-ghost !px-4 !py-2 text-[13px]">
                  <Sparkles size={14} />
                  用向导建立我的画像
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                {events.map((ev, i) => {
                  const meta = kindMeta[ev.kind];
                  return (
                    <motion.div
                      key={ev.id}
                      initial={{ opacity: 0, x: -12 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.04 }}
                      className="relative border-l-2 border-hairline pl-4"
                    >
                      <span className="absolute -left-[5px] top-1.5 h-2 w-2 rounded-full bg-brand" />
                      <div className="flex items-center gap-2">
                        <span className={cn('rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium', meta.cls)}>
                          {meta.label}
                        </span>
                        <span className="font-mono text-[10.5px] text-ink-muted">{ev.week}</span>
                      </div>
                      <div className="mt-1 text-[13.5px] font-medium text-ink">{ev.title}</div>
                      {ev.detail && <div className="mt-0.5 text-[12px] leading-[18px] text-ink-muted">{ev.detail}</div>}
                      {ev.deltas && ev.deltas.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {ev.deltas.map((d) => (
                            <span key={d.kpId} className="inline-flex items-center gap-1 rounded-md bg-paper-deep px-1.5 py-0.5 font-mono text-[10.5px]">
                              {getKnowledgePoint(d.kpId).name}
                              <span className={cn(d.to >= d.from ? 'text-brand-success' : 'text-brand-danger')}>
                                {d.from}→{d.to}
                              </span>
                            </span>
                          ))}
                        </div>
                      )}
                    </motion.div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-2">
            {/* 帮助入口：把各页的一次性提示重新打开 */}
            <button
              type="button"
              onClick={() => {
                /* 只清当前学习者的已读记录，不影响同机其他用户 */
                Object.keys(localStorage)
                  .filter((k) => k.startsWith(`lf.tip.${currentLearner.id}.`))
                  .forEach((k) => localStorage.removeItem(k));
                try {
                  const raw = localStorage.getItem('lf.guideSeen');
                  if (raw && raw !== '1') {
                    const map = JSON.parse(raw) as Record<string, 1>;
                    delete map[currentLearner.id];
                    localStorage.setItem('lf.guideSeen', JSON.stringify(map));
                  } else {
                    localStorage.removeItem('lf.guideSeen');
                  }
                } catch { /* ignore */ }
                toast.success('新手提示已重新打开', {
                  description: '回到「我的学习」「学」「练」等页面，会再各提示你一次能做什么',
                });
              }}
              className="flex w-full items-center justify-center gap-2 rounded-[10px] border border-hairline bg-card-warm py-2 text-[13px] font-medium text-ink-2 transition-all hover:border-brand/40 hover:text-brand"
            >
              <HelpCircle size={14} />
              重看新手提示（各页只提示一次的那些）
            </button>

            <Link to="/onboarding" className="flex items-center justify-center gap-2 text-[13px] font-medium text-ink-muted transition-colors hover:text-brand">
              <RotateCcw size={14} />
              重新走一遍诊断向导
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
