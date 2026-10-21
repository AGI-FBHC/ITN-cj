/* 学习型多智能体协作树的右侧面板。
 * 只消费 team/* 事件，不修改对话状态。 */
(() => {
  const panel = document.getElementById("team-panel");
  const scrim = document.getElementById("team-panel-scrim");
  const tree = document.getElementById("team-tree");
  const lines = document.getElementById("team-tree-lines");
  const detail = document.getElementById("team-detail");
  const title = document.getElementById("team-panel-title");
  const meta = document.getElementById("team-panel-meta");
  const closeBtn = document.getElementById("team-panel-close");
  if (!panel || !scrim || !tree || !lines || !detail) return;

  const runs = new Map();
  let sessionId = "";
  let activeRunId = "";
  let selectedNodeId = "";
  let visible = false;
  const dismissed = new Set();

  const toolNames = {
    research_topic_team: "主题研究小组",
    plan_study_team: "学习计划小组",
  };
  const statusNames = {
    queued: "等待",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  const escapeHtml = (value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const renderMarkdown = (value) => {
    if (typeof md === "function") return md(String(value || ""));
    return "<p>" + escapeHtml(value).replace(/\n/g, "<br>") + "</p>";
  };
  const duration = (ms) => {
    const n = Number(ms || 0);
    if (n < 1000) return n > 0 ? n + "ms" : "";
    if (n < 60000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + "s";
    return Math.floor(n / 60000) + "m" + Math.round((n % 60000) / 1000) + "s";
  };

  function ensureRun(payload, eventSessionId) {
    const runId = String(payload.runId || "");
    if (!runId) return null;
    if (!runs.has(runId)) {
      runs.set(runId, {
        runId,
        sessionId: eventSessionId || sessionId,
        tool: "",
        goal: "",
        status: "running",
        nodes: new Map(),
        rootIds: [],
        startedAt: Date.now(),
        elapsedMs: 0,
      });
    }
    return runs.get(runId);
  }

  function nodeFor(run, payload) {
    const nodeId = String(payload.nodeId || "");
    if (!nodeId) return null;
    if (!run.nodes.has(nodeId)) {
      run.nodes.set(nodeId, {
        id: nodeId,
        parentId: String(payload.parentId || ""),
        depth: Number(payload.depth || 0),
        role: String(payload.role || "学习助手"),
        title: String(payload.title || "未命名节点"),
        objective: String(payload.objective || ""),
        status: "queued",
        stage: "",
        process: [],
        answer: "",
        error: "",
        elapsedMs: 0,
      });
      if (!payload.parentId) run.rootIds.push(nodeId);
    }
    const node = run.nodes.get(nodeId);
    if (payload.role) node.role = String(payload.role);
    if (payload.title) node.title = String(payload.title);
    if (payload.objective) node.objective = String(payload.objective);
    if (payload.status) node.status = String(payload.status);
    return node;
  }

  function ingest(events, incomingSessionId, options = {}) {
    const sid = String(incomingSessionId || sessionId || "");
    if (sid) sessionId = sid;
    let openRunId = "";
    for (const event of events || []) {
      const type = String(event.type || "");
      if (!type.startsWith("team/")) continue;
      const payload = event.payload || {};
      const run = ensureRun(payload, sid);
      if (!run) continue;
      if (type === "team/run_started") {
        run.tool = String(payload.tool || "");
        run.goal = String(payload.goal || "");
        run.status = "running";
        run.startedAt = Date.now();
        if (options.autoOpen && !dismissed.has(run.runId)) openRunId = run.runId;
      } else if (type === "team/node_created") {
        nodeFor(run, payload);
      } else if (type === "team/node_started") {
        const node = nodeFor(run, payload);
        if (node) {
          node.status = "running";
          node.stage = String(payload.label || payload.stage || "执行中");
        }
      } else if (type === "team/node_stage") {
        const node = nodeFor(run, payload);
        if (node) {
          node.status = "running";
          node.stage = String(payload.label || payload.stage || "执行中");
          const label = String(payload.label || "");
          if (label && node.process[node.process.length - 1] !== label) node.process.push(label);
        }
      } else if (type === "team/node_completed" || type === "team/node_failed") {
        const node = nodeFor(run, payload);
        if (node) {
          node.status = type === "team/node_completed" ? "completed" : "failed";
          node.answer = String(payload.answer || "");
          node.error = String(payload.error || "");
          node.elapsedMs = Number(payload.elapsedMs || 0);
          if (Array.isArray(payload.process)) node.process = payload.process.map(String);
          if (!selectedNodeId) selectedNodeId = node.id;
        }
      } else if (type === "team/run_completed") {
        run.status = String(payload.status || "completed");
        run.elapsedMs = Number(payload.elapsedMs || 0);
        if (payload.answer && run.nodes.size) {
          const rootId = run.rootIds[0] || Array.from(run.nodes.keys())[0];
          const root = run.nodes.get(rootId);
          if (root) {
            root.answer = String(payload.answer);
            root.status = run.status === "failed" ? "failed" : "completed";
          }
        }
      }
    }
    if (openRunId) openRun(openRunId);
    else render();
  }

  function syncSession(nextSessionId, events) {
    sessionId = String(nextSessionId || "");
    runs.clear();
    activeRunId = "";
    selectedNodeId = "";
    dismissed.clear();
    if (sessionId && events && events.length) ingest(events, sessionId, {autoOpen: false});
    else hide();
  }

  function render() {
    const run = runs.get(activeRunId);
    if (!run) {
      hide();
      return;
    }
    title.textContent = toolNames[run.tool] || "多智能体协作";
    const done = Array.from(run.nodes.values()).filter((n) => n.status === "completed").length;
    meta.textContent = `${run.goal || "学习任务"} · ${done}/${run.nodes.size} 节点`;
    renderTree(run);
    renderDetail(run);
  }

  function renderTree(run) {
    tree.innerHTML = "";
    lines.innerHTML = "";
    if (!run.nodes.size) {
      tree.innerHTML = `<div class="team-detail-empty">协作树正在规划</div>`;
      return;
    }

    const nodeWidth = 154;
    const nodeHeight = 72;
    const gapX = 52;
    const gapY = 24;
    const pad = 16;
    const roots = run.rootIds.length ? run.rootIds : Array.from(run.nodes.keys());
    const positions = new Map();
    let leafRow = 0;

    const childrenOf = (nodeId) => Array.from(run.nodes.values()).filter((node) => node.parentId === nodeId);
    const place = (nodeId) => {
      const node = run.nodes.get(nodeId);
      if (!node) return null;
      const children = childrenOf(nodeId);
      let centerY;
      if (!children.length) {
        centerY = pad + leafRow * (nodeHeight + gapY) + nodeHeight / 2;
        leafRow += 1;
      } else {
        const childPositions = children.map((child) => place(child.id)).filter(Boolean);
        centerY = childPositions.length
          ? (childPositions[0].centerY + childPositions[childPositions.length - 1].centerY) / 2
          : pad + nodeHeight / 2;
      }
      const position = {
        x: pad + node.depth * (nodeWidth + gapX),
        y: centerY - nodeHeight / 2,
        centerY,
      };
      positions.set(nodeId, position);
      return position;
    };
    roots.forEach(place);

    let width = 0;
    let height = 0;
    positions.forEach((position) => {
      width = Math.max(width, position.x + nodeWidth + pad);
      height = Math.max(height, position.y + nodeHeight + pad);
    });
    tree.style.width = width + "px";
    tree.style.height = height + "px";
    lines.setAttribute("viewBox", `0 0 ${width} ${height}`);
    lines.setAttribute("width", String(width));
    lines.setAttribute("height", String(height));
    lines.style.width = width + "px";
    lines.style.height = height + "px";

    const edge = (fromId, toId) => {
      const from = positions.get(fromId);
      const to = positions.get(toId);
      if (!from || !to) return;
      const x1 = from.x + nodeWidth;
      const y1 = from.centerY;
      const x2 = to.x;
      const y2 = to.centerY;
      const bend = Math.max(18, (x2 - x1) * .48);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
      path.setAttribute("class", "team-link status-" + (run.nodes.get(toId)?.status || "queued"));
      lines.appendChild(path);
    };
    Array.from(run.nodes.values()).forEach((node) => {
      if (node.parentId) edge(node.parentId, node.id);
    });

    Array.from(run.nodes.values()).forEach((node) => {
      const position = positions.get(node.id);
      if (!position) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `team-node status-${node.status}${node.id === selectedNodeId ? " selected" : ""}${node.depth === 0 ? " root" : ""}`;
      button.dataset.nodeId = node.id;
      button.style.left = position.x + "px";
      button.style.top = position.y + "px";
      button.style.width = nodeWidth + "px";
      button.style.height = nodeHeight + "px";
      button.innerHTML =
        `<span class="team-node-top"><span class="team-node-role">${escapeHtml(node.role)}</span>` +
        `<span class="team-node-state">${escapeHtml(statusNames[node.status] || node.status)}</span></span>` +
        `<span class="team-node-title">${escapeHtml(node.title)}</span>` +
        `<span class="team-node-caption">${escapeHtml(node.status === "running" ? (node.stage || "正在执行") : (node.objective || "等待执行"))}</span>`;
      button.addEventListener("click", () => {
        selectedNodeId = node.id;
        render();
      });
      tree.appendChild(button);
    });
  }

  function renderDetail(run) {
    if (!selectedNodeId || !run.nodes.has(selectedNodeId)) {
      selectedNodeId = run.rootIds[0] || Array.from(run.nodes.keys())[0] || "";
    }
    const node = run.nodes.get(selectedNodeId);
    if (!node) {
      detail.innerHTML = `<div class="team-detail-empty">点击左侧节点查看执行过程</div>`;
      return;
    }
    const steps = node.process || [];
    const stage = node.stage && !steps.includes(node.stage) ? steps.concat([node.stage]) : steps;
    const processHtml = stage.length
      ? stage.map((step, index) => {
          const active = node.status === "running" && index === stage.length - 1;
          return `<div class="team-step${active ? " active" : " done"}">${escapeHtml(step)}</div>`;
        }).join("")
      : `<div class="team-step active">等待执行</div>`;
    let answer = "";
    if (node.answer) answer = `<div class="team-answer">${renderMarkdown(node.answer)}</div>`;
    else if (node.error) answer = `<div class="team-answer-empty">${escapeHtml(node.error)}</div>`;
    else answer = `<div class="team-answer-empty">${node.status === "running" ? "正在生成节点回答…" : "尚未产生最终回答"}</div>`;
    detail.innerHTML =
      `<div class="team-detail-head"><div><h3 class="team-detail-title">${escapeHtml(node.title)}</h3>` +
      `<div class="team-detail-role">${escapeHtml(node.role)} · 深度 ${node.depth}</div></div>` +
      `<span class="team-detail-status">${escapeHtml(statusNames[node.status] || node.status)}${node.elapsedMs ? " · " + duration(node.elapsedMs) : ""}</span></div>` +
      `<p class="team-detail-objective">${escapeHtml(node.objective)}</p>` +
      `<div class="team-section-label">执行流程</div><div class="team-steps">${processHtml}</div>` +
      `<div class="team-section-label">最终回答</div>${answer}`;
  }

  function show() {
    if (!activeRunId) return;
    panel.hidden = false;
    scrim.hidden = false;
    requestAnimationFrame(() => {
      panel.classList.add("open");
      scrim.classList.add("open");
      visible = true;
    });
  }

  function hide() {
    if (!visible) {
      panel.hidden = true;
      scrim.hidden = true;
      return;
    }
    panel.classList.remove("open");
    scrim.classList.remove("open");
    visible = false;
    setTimeout(() => {
      if (!visible) {
        panel.hidden = true;
        scrim.hidden = true;
      }
    }, 280);
  }

  function openRun(runId) {
    if (!runs.has(runId)) return;
    activeRunId = runId;
    selectedNodeId = selectedNodeId || "";
    render();
    show();
  }

  closeBtn?.addEventListener("click", () => {
    if (activeRunId) dismissed.add(activeRunId);
    hide();
  });
  scrim?.addEventListener("click", () => {
    if (activeRunId) dismissed.add(activeRunId);
    hide();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && visible) {
      if (activeRunId) dismissed.add(activeRunId);
      hide();
    }
  });

  window.LuminTeamPanel = {
    ingest,
    syncSession,
    open: openRun,
    close: hide,
    isOpen: () => visible,
  };
})();
