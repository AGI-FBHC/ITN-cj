import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { adminApi } from './admin-api.js';
import { ErrorBlock, Loading, Notice } from './admin-ui.jsx';
import { CoursewareContent } from './CoursewareView.jsx';
import './courseware-collaboration.css';

const AGENTS = [
  {
    role: '规划',
    code: 'PLAN',
    name: '教学策划 Agent',
    duty: '分析章节结构，规划资源目标、内容层次与生成要求。',
    tone: 'violet',
    icon: 'M4 5h16M4 12h10M4 19h7',
  },
  {
    role: '检索',
    code: 'RETRIEVE',
    name: '知识检索 Agent',
    duty: '从知识库提取跨章节证据，为撰写提供可追溯依据。',
    tone: 'blue',
    icon: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 4 4',
  },
  {
    role: '撰写',
    code: 'GENERATE',
    name: '内容生成 Agent',
    duty: '依据规划与检索证据，生成讲义、实操、题目或幻灯片。',
    tone: 'amber',
    icon: 'M4 20h4l11-11-4-4L4 16v4Zm9-13 4 4',
  },
  {
    role: '质检',
    code: 'VERIFY',
    name: '质量核验 Agent',
    duty: '检查结构、内容完整性与生成规范，定位需要返修的问题。',
    tone: 'teal',
    icon: 'm5 12 4 4L19 6',
  },
  {
    role: '仲裁',
    code: 'ARBITRATE',
    name: '发布仲裁 Agent',
    duty: '仅在质检未通过时返修一次，并确认最终资源可发布。',
    tone: 'rose',
    icon: 'M12 3v18M5 8h14M7 8l-3 7h6L7 8Zm10 0-3 7h6l-3-7Z',
  },
];

const TYPE_LABEL = {
  lecture: '讲义文稿',
  guide: '实操指南',
  bank: '题库',
  slides: '教学幻灯片',
};

const STATUS_LABEL = {
  queued: '排队中',
  generating: '生成中',
  ready: '待发布',
  failed: '生成失败',
};

function iconPath(path) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>;
}

function readableSummary(value) {
  if (!value) return '';
  const text = String(value).trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function stepFor(steps, role) {
  let found = null;
  for (const step of steps) {
    if (step?.role === role) found = step;
  }
  return found;
}

function laneState(agent, step, itemStatus, previousDone) {
  if (step?.status === 'running') return { key: 'running', label: '执行中' };
  if (step?.status === 'failed') return { key: 'failed', label: '需处理' };
  if (step?.status === 'done') return { key: 'done', label: '已完成' };
  if (agent.role === '仲裁' && itemStatus === 'ready') return { key: 'skipped', label: '无需返修' };
  if (itemStatus === 'ready' && previousDone) return { key: 'done', label: '已完成' };
  if (itemStatus === 'failed' && previousDone) return { key: 'stopped', label: '已停止' };
  if (itemStatus === 'queued') return { key: 'waiting', label: '排队等待' };
  if (itemStatus === 'generating' && previousDone && !step) return { key: 'running', label: '执行中' };
  if (itemStatus === 'generating' && previousDone) return { key: 'waiting', label: '等待调用' };
  return { key: 'waiting', label: '待命' };
}

function formatTime(value) {
  return value || '—';
}

export default function CoursewareCollaboration() {
  const { coursewareId } = useParams();
  const navigate = useNavigate();
  const [state, setState] = React.useState({ loading: true, error: '', item: null, steps: [], content: null });
  const [selectedRole, setSelectedRole] = React.useState('规划');
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

  const states = React.useMemo(() => {
    let previousDone = true;
    return AGENTS.map((agent) => {
      const step = stepFor(state.steps, agent.role);
      const lane = laneState(agent, step, state.item?.status, previousDone);
      previousDone = lane.key === 'done' || lane.key === 'skipped';
      return { agent, step, lane };
    });
  }, [state.steps, state.item?.status]);

  React.useEffect(() => {
    const activeStates = states.filter((entry) => entry.lane.key === 'running');
    if (activeStates.length) setSelectedRole(activeStates[activeStates.length - 1].agent.role);
  }, [states]);

  if (state.loading && !state.item) return <Loading label="正在读取协作过程…" />;
  if (state.error && !state.item) return <ErrorBlock message={state.error} onRetry={load} />;

  const item = state.item;
  const selected = states.find((entry) => entry.agent.role === selectedRole) || states[0];
  const completed = states.filter((entry) => entry.lane.key === 'done' || entry.lane.key === 'skipped').length;
  const progress = Math.round(completed / AGENTS.length * 100);
  const summary = selected?.step ? readableSummary(selected.step.error || selected.step.summary) : selected?.agent.duty;

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
      <section className="zx-collab-path" aria-label="多智能体协作路径">
        <div className="zx-collab-path-progress"><i style={{ width: `${progress}%` }} /></div>
        {states.map(({ agent, lane }, index) => <React.Fragment key={agent.role}>
          {index ? <span className={`zx-collab-path-arrow is-${lane.key}`} aria-hidden="true">→</span> : null}
          <button type="button" className={`zx-collab-path-node is-${agent.tone} is-${lane.key}`} onClick={() => setSelectedRole(agent.role)}>
            <i>{index + 1}</i><span>{agent.role}</span>
          </button>
        </React.Fragment>)}
      </section>
    </header>

    {state.error ? <Notice kind="error">{state.error}，页面会在数秒后自动重试。</Notice> : null}

    <main className="zx-collab-layout">
      <section className="zx-collab-board" aria-label="Agent 协作泳道">
        <header>
          <div><p>AGENT SWIMLANES</p><h2>五体协同泳道</h2></div>
          <span>{completed}/{AGENTS.length} 已完成 · {formatTime(item.updatedAt)} 更新</span>
        </header>
        <div className="zx-collab-lanes">
          {states.map(({ agent, step, lane }, index) => {
            const detail = step ? readableSummary(step.error || step.summary) : agent.duty;
            return <article key={agent.role} className={`zx-collab-lane is-${agent.tone} is-${lane.key}${selectedRole === agent.role ? ' is-selected' : ''}`} onClick={() => setSelectedRole(agent.role)}>
              <button type="button" className="zx-collab-agent" aria-pressed={selectedRole === agent.role}>
                <span className="zx-collab-agent-glyph">{iconPath(agent.icon)}</span>
                <span className="zx-collab-agent-copy">
                  <small>{agent.code} · 0{index + 1}</small>
                  <strong>{agent.name}</strong>
                </span>
              </button>
              <div className="zx-collab-rail" aria-hidden="true"><i /></div>
              <div className="zx-collab-work">
                <div className="zx-collab-work-top">
                  <span className={`zx-collab-lane-state is-${lane.key}`}>{lane.label}</span>
                  {lane.key === 'running' ? <span className="zx-collab-activity">LIVE</span> : null}
                </div>
                <p>{detail || '等待上游 Agent 交付…'}</p>
                <button type="button" className="zx-collab-detail-link" onClick={(event) => { event.stopPropagation(); setSelectedRole(agent.role); }}>
                  查看执行详情
                </button>
              </div>
            </article>;
          })}
        </div>
      </section>

      <aside className="zx-collab-inspector">
        <header className={`is-${selected?.agent.tone}`}>
          <span className="zx-collab-inspector-icon">{selected ? iconPath(selected.agent.icon) : null}</span>
          <div><p>{selected?.agent.code} · EXECUTION DETAIL</p><h2>{selected?.agent.name}</h2></div>
          <span className={`zx-collab-lane-state is-${selected?.lane.key}`}>{selected?.lane.label}</span>
        </header>
        <section>
          <h3>职责</h3>
          <p>{selected?.agent.duty}</p>
        </section>
        <section>
          <h3>执行结果</h3>
          {selected?.step ? <pre className="zx-collab-summary">{summary}</pre> : <div className="zx-collab-empty">这个 Agent 还没有收到上游任务。</div>}
        </section>
        <section className="zx-collab-output">
          <div><h3>资源产物</h3><span>{state.content ? '已生成' : active ? '生成中' : '暂无内容'}</span></div>
          {state.content ? <CoursewareContent kind={item.kind} content={state.content} /> : <div className="zx-collab-empty">{active ? '生成完成后会在这里展示完整产物。' : '这次任务没有可预览的产物。'}</div>}
        </section>
      </aside>
    </main>
  </div>;
}
