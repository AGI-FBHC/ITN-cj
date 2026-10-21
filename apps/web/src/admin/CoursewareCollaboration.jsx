import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice } from './admin-ui.jsx';
import { CoursewareContent } from './CoursewareView.jsx';
import {
  COLLAB_AGENTS,
  AgentWorkflowSummary,
  buildCoursewareEvents,
  CollaborationRounds,
  ExecutionDetailPanel,
} from './CollaborationPanels.jsx';
import './courseware-collaboration.css';

const TYPE_LABEL = {
  lecture: '讲义文稿',
  bank: '题库',
  slides: '教学幻灯片',
};

const STATUS_LABEL = {
  queued: '排队中',
  generating: '生成中',
  ready: '待发布',
  failed: '生成失败',
};

export default function CoursewareCollaboration() {
  const { coursewareId } = useParams();
  const navigate = useNavigate();
  const [state, setState] = React.useState({ loading: true, error: '', item: null, steps: [], content: null });
  const [selectedAgent, setSelectedAgent] = React.useState('规划');
  const [selectedSeq, setSelectedSeq] = React.useState(null);
  const activeRef = React.useRef(false);

  const load = React.useCallback(async () => {
    activeRef.current = true;
    try {
      const result = await adminApi.cwDetail(coursewareId);
      if (!activeRef.current) return;
      setState({
        loading: false,
        error: '',
        item: result.item,
        steps: Array.isArray(result.steps) ? result.steps : [],
        content: result.content || null,
      });
    } catch (error) {
      if (activeRef.current) setState((current) => ({ ...current, loading: false, error: error.message }));
    }
  }, [coursewareId]);

  React.useEffect(() => {
    activeRef.current = true;
    load();
    return () => { activeRef.current = false; };
  }, [load]);

  const active = state.item?.status === 'queued' || state.item?.status === 'generating';
  React.useEffect(() => {
    if (!active) return undefined;
    const timer = window.setTimeout(load, 2500);
    return () => window.clearTimeout(timer);
  }, [active, load, state.item?.updatedAt, state.steps.length]);

  const events = React.useMemo(
    () => buildCoursewareEvents(state.item, state.steps),
    [state.item, state.steps],
  );
  const workEvents = events.filter((event) => event.agent !== 'SYSTEM');
  const runningEvent = [...workEvents].reverse().find((event) => event.status === 'running') || null;

  React.useEffect(() => {
    const preferred = runningEvent || workEvents.at(-1) || null;
    if (!preferred) return;
    if (runningEvent || !workEvents.some((event) => event.seq === selectedSeq)) {
      setSelectedAgent(preferred.agent);
      setSelectedSeq(preferred.seq);
    }
  }, [runningEvent?.seq, workEvents.length, selectedSeq]);

  const selectedEvent = workEvents.find((event) => event.seq === selectedSeq) || null;
  const selectAgent = (role) => {
    const event = [...workEvents].reverse().find((item) => item.agent === role) || null;
    setSelectedAgent(role);
    setSelectedSeq(event?.seq ?? null);
  };
  const selectEvent = (event) => {
    setSelectedAgent(event.agent);
    setSelectedSeq(event.seq);
  };

  if (state.loading && !state.item) return <Loading label="正在读取协作过程…" />;
  if (state.error && !state.item) return <ErrorBlock message={state.error} onRetry={load} />;

  const item = state.item;
  const completed = workEvents.filter((event) => event.status === 'done' || event.status === 'skipped').length;
  return <div className="zx-collab-page">
    <header className="zx-collab-head">
      <button type="button" className="zx-collab-back" onClick={() => navigate('/admin/courseware')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m15 18-6-6 6-6" /></svg>
        返回课件库
      </button>
      <div className="zx-collab-title-row">
        <div>
          <p>MULTI-AGENT PRODUCTION</p>
          <h1>{item.title || item.docTitle || '课件生成任务'}</h1>
          <span>{item.bundleTitle} · {item.docTitle} · {TYPE_LABEL[item.kind] || item.kindLabel}</span>
        </div>
        <div className={`zx-collab-status is-${item.status}`}>
          <i />
          {item.published ? '已发布' : (STATUS_LABEL[item.status] || item.status)}
        </div>
      </div>
    </header>

    {state.error ? <Notice kind="error">{state.error}，页面会在数秒后自动重试。</Notice> : null}

    <main className="zx-collab-layout">
      <section className="zx-collab-board" aria-label="Agents 教研组协作泳道">
        <header>
          <div><p>AGENT SWIMLANES</p><h2>Agents 教研组协作泳道</h2></div>
          <span>{completed}/{COLLAB_AGENTS.length} 已完成 · {item.updatedAt || '正在执行'}</span>
        </header>
        <div className="zx-core-board">
          <AgentWorkflowSummary events={events} running={item.status === 'generating'} />
          <CollaborationRounds
            events={events}
            selectedSeq={selectedSeq}
            selectedAgent={selectedAgent}
            runningAgent={runningEvent?.agent || null}
            running={item.status === 'generating'}
            onSelect={selectEvent}
            onSelectAgent={selectAgent}
          />
        </div>
      </section>

      <aside className="zx-collab-inspector">
        <div className="zx-collab-inspector-title"><strong>执行详情</strong><span>操作、结论、依据与产物</span></div>
        <ExecutionDetailPanel event={selectedEvent} running={selectedEvent?.status === 'running'} />
        <section className="zx-collab-output">
          <div><h3>资源产物</h3><span>{state.content ? '已生成' : active ? '生成中' : '暂无内容'}</span></div>
          {state.content ? <CoursewareContent kind={item.kind} content={state.content} /> : <div className="zx-collab-empty">{active ? '生成完成后会在这里展示完整产物。' : '这次任务没有可预览的产物。'}</div>}
        </section>
      </aside>
    </main>
  </div>;
}
