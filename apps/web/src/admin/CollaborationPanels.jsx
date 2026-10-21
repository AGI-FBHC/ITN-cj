import * as React from 'react';
import Markdown from './Markdown.jsx';

// Translated from AGI-FBHC/ITN-cj:
// apps/web/src/pages/CollaborationWorkbench.tsx and
// apps/web/src/components/admin/ExecutionDetailPanel.tsx.
export const COLLAB_AGENTS = [
  { role: '规划', code: 'DIA-01', name: '教学策划 Agent', short: '教学策划', duty: '分析章节结构，规划资源目标、内容层次与生成要求。', tone: 'violet' },
  { role: '检索', code: 'RET-02', name: '知识检索 Agent', short: '知识检索', duty: '锁定本章原文，整理生成所需的依据与内容边界。', tone: 'blue' },
  { role: '撰写', code: 'GEN-03', name: '内容生成 Agent', short: '内容生成', duty: '严格依据规划与本章原文完成初稿生成。', tone: 'amber' },
  { role: '质检', code: 'VER-04', name: '质量核验 Agent', short: '质量核验', duty: '检查结构、引用、完整性与输出格式是否达标。', tone: 'teal' },
  { role: '仲裁', code: 'ARB-05', name: '发布仲裁 Agent', short: '发布仲裁', duty: '根据质检结论返修一次，并给出最终通过结论。', tone: 'rose' },
  { role: '排版', code: 'LAY-06', name: '演示交付 Agent', short: '演示交付', duty: '把已通过审核的结构化内容渲染为可编辑 PPTX、讲者备注和网页预览。', tone: 'slate' },
];

const AGENT_BY_ROLE = Object.fromEntries(COLLAB_AGENTS.map((agent) => [agent.role, agent]));
const STATUS_LABEL = { running: '执行中', done: '已完成', failed: '失败', waiting: '等待', skipped: '无需返修' };

function parseSnapshot(summary) {
  if (!summary) return {};
  try {
    const value = JSON.parse(summary);
    return value && typeof value === 'object' ? value : { summary };
  } catch {
    return { summary };
  }
}

export function buildCoursewareEvents(item, steps) {
  if (!item) return [];
  const events = [{
    seq: 0,
    time: item.updatedAt,
    agent: 'SYSTEM',
    agentName: '系统流程',
    phase: 'task',
    status: item.status,
    eventType: 'task_lifecycle',
    title: item.status === 'queued' ? '课件任务已进入队列' : '课件生成任务已启动',
    detail: `${item.bundleTitle || ''} · ${item.docTitle || ''}`,
    executionSummary: '',
    snapshot: { resourceKind: item.kind, source: item.docTitle, status: item.status },
  }];
  const latestByRole = {};
  (steps || []).forEach((step) => { if (step?.role) latestByRole[step.role] = step; });
  let inferredRunning = false;
  COLLAB_AGENTS.forEach((agent, index) => {
    const step = latestByRole[agent.role];
    if (step) {
      const summary = step.error || step.summary || agent.duty;
      const title = step.error
        ? `${agent.role}阶段发现异常`
        : step.status === 'running'
          ? `${agent.role}正在执行`
          : agent.role === '检索'
            ? '已锁定本章原文'
            : agent.role === '仲裁'
              ? '返修与最终确认'
              : agent.role === '排版'
                ? 'PPTX 与预览生成完成'
              : `${agent.role}阶段完成`;
      events.push({
        seq: index + 1,
        time: item.updatedAt,
        agent: agent.role,
        agentName: agent.name,
        phase: step.status,
        status: step.status,
        title,
        detail: summary,
        executionSummary: summary,
        snapshot: { role: step.role, status: step.status, summary: step.summary || '', error: step.error || '', ...parseSnapshot(step.summary) },
      });
      return;
    }
    if (item.status === 'generating' && !inferredRunning) {
      inferredRunning = true;
      events.push({
        seq: index + 1,
        time: item.updatedAt,
        agent: agent.role,
        agentName: agent.name,
        phase: 'running',
        status: 'running',
        title: `${agent.role}正在执行`,
        detail: agent.duty,
        executionSummary: agent.duty,
        snapshot: { role: agent.role, status: 'running', note: '等待当前阶段返回结果' },
      });
      return;
    }
    if (item.status === 'ready' && agent.role === '仲裁') {
      events.push({
        seq: index + 1,
        time: item.updatedAt,
        agent: agent.role,
        agentName: agent.name,
        phase: 'skipped',
        status: 'skipped',
        title: '质检通过，无需返修',
        detail: '质量核验阶段未发现需要仲裁的问题。',
        executionSummary: '质量核验通过，本轮无需进入返修流程。',
        snapshot: { role: agent.role, status: 'skipped', reason: '质检直接通过' },
      });
      return;
    }
    if (item.status === 'ready' && agent.role === '排版' && item.kind !== 'slides') {
      events.push({
        seq: index + 1,
        time: item.updatedAt,
        agent: agent.role,
        agentName: agent.name,
        phase: 'skipped',
        status: 'skipped',
        title: '当前资源无需 PPT 排版',
        detail: '只有教学幻灯片会进入 PPTX 渲染，其他资源在审核通过后直接交付。',
        executionSummary: '当前资源类型不包含 PPTX 交付产物。',
        snapshot: { role: agent.role, status: 'skipped', resourceKind: item.kind },
      });
      return;
    }
    if (item.status === 'ready' && agent.role === '排版' && item.kind === 'slides') {
      events.push({
        seq: index + 1,
        time: item.updatedAt,
        agent: agent.role,
        agentName: agent.name,
        phase: 'done',
        status: 'done',
        title: 'PPTX 与预览已生成',
        detail: '历史任务没有单独保存排版步骤，已根据现有结构化幻灯片产物补全交付状态。',
        executionSummary: '可编辑 PPTX、讲者备注、设计 JSON 和网页预览均已进入资源预览。',
        snapshot: { role: agent.role, status: 'done', compatibility: 'legacy-ready-task' },
      });
    }
  });
  return events;
}

function classNames(...items) {
  return items.filter(Boolean).join(' ');
}

export function AgentWorkflowSummary({ events, running }) {
  const path = events.filter((event) => event.agent !== 'SYSTEM').reduce((result, event) => {
    if (result.at(-1)?.agent !== event.agent) result.push(event);
    return result;
  }, []);
  if (!path.length) return null;
  return <section className="zx-core-path">
    <div className="zx-core-path-title"><strong>本次协同路径</strong><span>{running ? '实时更新' : '已归档'}</span></div>
    <div className="zx-core-path-list">
      {path.map((event, index) => <React.Fragment key={`${event.agent}-${event.seq}`}>
        {index > 0 ? <span className="zx-core-path-arrow" aria-hidden="true">→</span> : null}
        <span className={classNames('zx-core-path-chip', `is-${AGENT_BY_ROLE[event.agent]?.tone || 'violet'}`, `is-${event.status}`)}>
          {event.status === 'running' ? <i /> : null}
          {AGENT_BY_ROLE[event.agent]?.name || event.agentName}
          {event.status === 'skipped' ? <small>无需返修</small> : null}
        </span>
      </React.Fragment>)}
    </div>
  </section>;
}

function FlowLink({ fromCol, toCol, columnCount }) {
  const ref = React.useRef(null);
  const [geometry, setGeometry] = React.useState(null);
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const width = node.clientWidth;
    const height = node.clientHeight;
    const gap = 8;
    const columnWidth = (width - gap * (columnCount - 1)) / columnCount;
    const center = (column) => column * (columnWidth + gap) + columnWidth / 2;
    setGeometry({ width, height, x1: center(fromCol), x2: center(toCol) });
  }, [columnCount, fromCol, toCol]);
  const x1 = geometry?.x1 ?? 20;
  const x2 = geometry?.x2 ?? 20;
  const height = geometry?.height ?? 38;
  const path = Math.abs(x1 - x2) < 0.5 ? `M ${x1} 2 L ${x1} ${height - 2}` : `M ${x1} 2 C ${x1} ${height * 0.62}, ${x2} ${height * 0.38}, ${x2} ${height - 2}`;
  return <div ref={ref} className="zx-core-flow" aria-hidden="true">
    <i style={{ left: x1 }} />
    {geometry ? <svg viewBox={`0 0 ${geometry.width} ${geometry.height}`} preserveAspectRatio="none"><path d={path} /><path d={path} className="zx-core-flow-light" /></svg> : null}
    <i style={{ left: x2 }} />
  </div>;
}

export function CollaborationRounds({ events, selectedSeq, selectedAgent, runningAgent, running, onSelect, onSelectAgent }) {
  const units = events.filter((event) => event.agent !== 'SYSTEM').map((event, index) => ({
    agent: event.agent,
    events: [event],
    round: event.agent === '仲裁' ? 1 : 0,
    isRoundStart: event.agent === '仲裁',
    key: `${event.agent}-${event.seq}-${index}`,
  }));
  return <div className="zx-core-rounds" style={{ '--zx-agent-count': String(COLLAB_AGENTS.length) }}>
    <div className="zx-core-round-head">
      {COLLAB_AGENTS.map((agent) => {
        const own = events.some((event) => event.agent === agent.role);
        const live = runningAgent === agent.role;
        return <button key={agent.role} type="button" className={classNames('zx-core-agent-head', `is-${agent.tone}`, live && 'is-live', selectedAgent === agent.role && 'is-selected', own && 'has-events')} onClick={() => onSelectAgent(agent.role)} title={agent.duty}>
          <span>{agent.code.slice(0, 3)}</span><strong>{agent.short || agent.name}</strong>{live ? <i /> : null}
        </button>;
      })}
    </div>
    <div className="zx-core-round-body">
      {units.map((unit, index) => {
        const previous = units[index - 1];
        const lane = Math.max(0, COLLAB_AGENTS.findIndex((agent) => agent.role === unit.agent));
        const previousLane = previous ? Math.max(0, COLLAB_AGENTS.findIndex((agent) => agent.role === previous.agent)) : lane;
        const event = unit.events[0];
        const live = running && runningAgent === unit.agent;
        return <React.Fragment key={unit.key}>
          {index > 0 ? <FlowLink fromCol={previousLane} toCol={lane} columnCount={COLLAB_AGENTS.length} /> : null}
          <div className="zx-core-round-row" style={{ gridColumnStart: lane + 1 }}>
            {unit.isRoundStart ? <span className="zx-core-round-tag">仲裁轮</span> : null}
            <button type="button" className={classNames('zx-core-event', `is-${AGENT_BY_ROLE[unit.agent]?.tone || 'violet'}`, `is-${event.status}`, event.seq === selectedSeq && 'is-selected', live && 'is-live')} onClick={() => onSelect(event)} title={event.detail || event.title}>
              <i>{event.status === 'running' ? <span /> : null}</i>
              <span><strong>{event.title}</strong><small>{event.detail || ''}</small></span>
              <b>{STATUS_LABEL[event.status] || event.status}</b>
            </button>
          </div>
        </React.Fragment>;
      })}
      {!units.length ? <div className="zx-core-empty">等待第一条协同事件…</div> : null}
    </div>
  </div>;
}

function JsonTree({ value }) {
  if (value == null) return <span className="jz">—</span>;
  if (Array.isArray(value)) return <><span className="jp">[</span>{value.map((item, index) => <div className="zx-core-json-indent" key={index}><JsonTree value={item} />{index < value.length - 1 ? <span className="jp">,</span> : null}</div>)}<span className="jp">]</span></>;
  if (typeof value === 'object') return <><span className="jp">{'{'}</span>{Object.entries(value).map(([key, child], index) => <div className="zx-core-json-indent" key={key}><span className="jk">{JSON.stringify(key)}</span><span className="jp">: </span><JsonTree value={child} />{index < Object.keys(value).length - 1 ? <span className="jp">,</span> : null}</div>)}<span className="jp">{'}'}</span></>;
  if (typeof value === 'string') return <span className="js">{JSON.stringify(value)}</span>;
  if (typeof value === 'number') return <span className="jn">{String(value)}</span>;
  return <span className="jb">{String(value)}</span>;
}

export function ExecutionDetailPanel({ event, running = false }) {
  if (!event) return <div className="zx-core-detail-empty">请选择一条 Agent 执行记录。</div>;
  const summary = event.executionSummary || event.detail || '';
  return <div className="zx-core-detail">
    <header>
      <div><strong>{event.agentName || event.agent}</strong><small>{event.title}</small></div>
      <span>{event.time || '当前任务'}</span>
    </header>
    <section>
      <h4>执行摘要</h4>
      <div className="zx-core-markdown">{summary ? <Markdown text={summary} /> : <p>{running ? 'Agent 正在执行…' : '暂无执行摘要。'}</p>}</div>
    </section>
    <section>
      <h4>原始记录</h4>
      <pre className="zx-core-json"><JsonTree value={{ seq: event.seq, time: event.time, agent: event.agent, agentName: event.agentName, phase: event.phase, status: event.status, title: event.title, detail: event.detail, snapshot: event.snapshot }} /></pre>
    </section>
  </div>;
}
