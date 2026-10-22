import * as React from 'react';
import { api } from './learning-api.jsx';
import { buildActivityGrid, popularResourceLabel, popularResourceTarget, rankPopularResources, validateDashboardInsights } from './dashboard-insights.js';
import './home-learning-widgets.css';

export function useDashboardInsights(revision) {
  const [state, setState] = React.useState({ data: null, loading: true, error: '' });
  const [attempt, setAttempt] = React.useState(0);
  const retry = React.useCallback(() => setAttempt((current) => current + 1), []);
  React.useEffect(() => {
    let active = true;
    queueMicrotask(async () => {
      if (!active) return;
      setState((current) => ({ ...current, loading: true, error: '' }));
      try {
        const data = validateDashboardInsights(await api('/learner/dashboard'));
        if (active) setState({ data, loading: false, error: '' });
      } catch (error) {
        if (active) setState((current) => ({ ...current, loading: false, error: error.message || '学习数据读取失败' }));
      }
    });
    return () => { active = false; };
  }, [revision, attempt]);
  return { ...state, retry };
}

function InsightsState({ insights }) {
  if (insights.error) return <div className="zx-home-insights-error" role="alert"><span>{insights.error}</span><button type="button" onClick={insights.retry}>重试</button></div>;
  return insights.loading ? <p className="zx-home-insights-state" role="status">正在读取学习数据…</p> : null;
}

export function LearningActivityGrid({ insights }) {
  const activity = insights.data?.activity;
  const days = React.useMemo(() => buildActivityGrid(activity), [activity]);
  const [selectedDate, setSelectedDate] = React.useState('');
  const cells = React.useRef([]);
  const available = days.map((day, index) => day.count === null ? -1 : index).filter((index) => index >= 0);
  const selectedIndex = days.findIndex((day) => day.date === selectedDate && day.count !== null);
  const activeIndex = selectedIndex >= 0 ? selectedIndex : available.at(-1);
  const activeDay = days[activeIndex];
  const label = (day) => `${day.date} · ${day.count} 次学习`;
  const move = (event, index) => {
    const offsets = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
    let target = index;
    if (event.key === 'Home') target = available[0];
    else if (event.key === 'End') target = available.at(-1);
    else if (event.key in offsets) {
      if ((event.key === 'ArrowUp' && index % 7 === 0) || (event.key === 'ArrowDown' && index % 7 === 6)) return;
      target += offsets[event.key];
    } else return;
    event.preventDefault();
    if (days[target]?.count != null) cells.current[target]?.focus();
  };

  return <section className="zx-home-activity" aria-label="学习活跃记录" aria-busy={insights.loading}>
    <header><h4>学习活跃</h4><span>近 20 周</span></header>
    <InsightsState insights={insights} />
    {activity && <>
      <div className="zx-home-activity-calendar">
        <div className="zx-home-activity-weekdays" aria-hidden="true"><span>一</span><span /><span>三</span><span /><span>五</span><span /><span>日</span></div>
        <div className="zx-home-activity-cells" role="group" aria-label="每日学习次数，方向键切换日期，Home 和 End 跳到首尾">
          {days.map((day, index) => day.count === null ? <span key={day.date} className="zx-home-activity-day is-unavailable" aria-hidden="true" /> : <button
            key={day.date} type="button" ref={(node) => { cells.current[index] = node; }}
            className={`zx-home-activity-day level-${day.level}`} tabIndex={index === activeIndex ? 0 : -1}
            aria-label={label(day)} title={label(day)} onFocus={() => setSelectedDate(day.date)}
            onClick={() => setSelectedDate(day.date)} onKeyDown={(event) => move(event, index)}
          />)}
        </div>
      </div>
      <div className="zx-home-activity-legend"><span>每格一天</span><div><span>少</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`level-${level}`} aria-hidden="true" />)}<span>多</span></div></div>
      <p className="zx-home-activity-caption" aria-live="polite">{activeDay ? label(activeDay) : '此时间范围暂无学习记录'}</p>
    </>}
  </section>;
}

function RankBadge({ rank }) {
  const medals = ['gold', 'silver', 'bronze'];
  const names = ['冠军', '亚军', '季军'];
  return <span className={`zx-home-resource-rank${rank <= 3 ? ` is-${medals[rank - 1]}` : ''}`} aria-label={`第 ${rank} 名${rank <= 3 ? `，${names[rank - 1]}` : ''}`}>
    {rank <= 3 && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true"><path d="m3 6 5 4 4-7 4 7 5-4-2 13H5ZM5 16h14" /></svg>}
    <span aria-hidden="true">{rank}</span>
  </span>;
}

export function PopularLearningResources({ insights, catalog, onOpen, onViewAll }) {
  const items = React.useMemo(() => rankPopularResources(insights.data?.popularResources), [insights.data?.popularResources]);
  return <section className="zx-home-popular rounded-3xl border border-black/5 bg-white p-6" aria-label="为您推荐" aria-busy={insights.loading}>
    <header className="zx-home-popular-head"><div><h3 className="text-lg font-extrabold text-[#111318]">为您推荐</h3><p>热门学习资源 · 按学习人数排序</p></div><button type="button" onClick={onViewAll}>查看全部 &gt;</button></header>
    <InsightsState insights={insights} />
    {insights.data && !items.length && <p className="zx-home-insights-state">暂无热门资源，有学习记录后会显示在这里。</p>}
    {!!items.length && <ol className="zx-home-popular-list" aria-label="热门资源排行榜">{items.map((item, index) => {
      const target = popularResourceTarget(item, catalog);
      const course = target?.course;
      const lesson = course?.chapters?.[item.lessonIndex];
      return <li key={item.id || `${item.courseId}:${item.lessonIndex}:${item.kind}`}>
        <button type="button" className="zx-home-resource-row" disabled={!target} onClick={() => { if (target) onOpen(target); }}>
          <RankBadge rank={index + 1} />
          <span className="zx-home-resource-copy"><span className="zx-home-resource-title"><span className={`zx-home-resource-kind kind-${target?.mode || item.kind}`}>{popularResourceLabel(item.kind)}</span><strong>{[course?.name || item.courseName, lesson?.title || item.lessonTitle || item.title].filter(Boolean).join(' · ')}</strong></span>{!target && <span className="zx-home-resource-unavailable">课程或资源暂不可访问</span>}</span>
          <span className="zx-home-resource-count"><strong>{item.learnerCount}</strong><span>人学习</span></span>
        </button>
      </li>;
    })}</ol>}
  </section>;
}
