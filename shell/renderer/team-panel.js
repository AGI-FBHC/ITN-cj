/* 协作面板与对话并排；只消费事件，不修改对话状态。 */
(() => {
  const panel = document.getElementById("team-panel");
  const scrim = document.getElementById("team-panel-scrim");
  const tree = document.getElementById("team-tree");
  const lines = document.getElementById("team-tree-lines");
  const detail = document.getElementById("team-detail");
  const canvas = document.querySelector(".team-tree-canvas");
  const stage = document.getElementById("team-tree-stage");
  const zoomValue = document.getElementById("team-zoom-value");
  const title = document.getElementById("team-panel-title");
  const meta = document.getElementById("team-panel-meta");
  const closeBtn = document.getElementById("team-panel-close");
  if (!panel || !scrim || !tree || !lines || !detail) return;

  const runs = new Map();
  let sessionId = "";
  let activeRunId = "";
  let selectedNodeId = "";
  let visible = false;
  let showFrame = 0;
  let renderedRunId = "";
  let detailKey = "";
  let detailHtml = "";
  const nodeButtons = new Map();
  const dismissed = new Set();
  const aliases = new Map();
  let scale = 1;
  let manualZoom = false;
  let overview = false;
  let graphWidth = 0;
  let graphHeight = 0;
  let layoutWidth = 0;

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

  function ensureRun(payload, eventSessionId, turnId = "") {
    const runId = String(payload.runId || "");
    if (!runId) return null;
    if (!runs.has(runId)) {
      runs.set(runId, {
        runId,
        turnId,
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

  const pendingId = (turnId, callId) => "pending:" + turnId + ":" + callId;

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
      const payload = event.payload || {};
      if (type === "tool/call" && toolNames[payload.tool]) {
        const id = pendingId(event.turnId || "—", payload.callId || payload.tool);
        if (aliases.has(id) || runs.has(id)) continue;
        const pending = ensureRun({runId: id}, sid, event.turnId || "—");
        pending.tool = payload.tool;
        pending.goal = String(payload.args?.goal || payload.args?.topic || "正在规划协作任务");
        pending.pending = true;
        if (options.autoOpen && !visible && !dismissed.has(id)) openRunId = id;
        continue;
      }
      if (type === "tool/result" && toolNames[payload.tool]) {
        const pending = runs.get(pendingId(event.turnId || "—", payload.callId || payload.tool));
        if (pending?.pending) {
          pending.status = payload.ok === false ? "failed" : "completed";
          pending.goal = String(payload.summary || (payload.ok === false ? "协作任务未完成" : "协作任务已结束"));
        }
      }
      if (!type.startsWith("team/")) continue;
      if (type === "team/run_started" && !runs.has(payload.runId)) {
        const pending = Array.from(runs.values()).find(r => r.pending && r.tool === payload.tool && r.turnId === (event.turnId || "—"));
        if (pending) {
          const oldId = pending.runId;
          runs.delete(oldId);
          aliases.set(oldId, payload.runId);
          pending.runId = payload.runId;
          pending.pending = false;
          runs.set(payload.runId, pending);
          if (dismissed.has(oldId)) dismissed.add(payload.runId);
          if (activeRunId === oldId) activeRunId = payload.runId;
          if (openRunId === oldId) openRunId = payload.runId;
        }
      }
      const run = ensureRun(payload, sid, event.turnId || "—");
      if (!run) continue;
      if (type === "team/run_started") {
        run.tool = String(payload.tool || "");
        run.goal = String(payload.goal || "");
        run.status = "running";
        run.startedAt = Date.now();
        if (options.autoOpen && !visible && !dismissed.has(run.runId)) openRunId = run.runId;
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
    if (nextSessionId && String(nextSessionId) === sessionId) {
      ingest(events, sessionId, {autoOpen: false});
      return;
    }
    hide();
    sessionId = String(nextSessionId || "");
    runs.clear();
    activeRunId = "";
    selectedNodeId = "";
    dismissed.clear();
    aliases.clear();
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
    meta.textContent = `${run.goal || "学习任务"} · ${run.nodes.size ? done + "/" + run.nodes.size + " 节点" : (statusNames[run.status] || run.status)}`;
    meta.title = run.goal;
    renderDetail(run);
    renderTree(run);
  }

  function renderTree(run) {
    if (renderedRunId !== run.runId) {
      tree.innerHTML = "";
      nodeButtons.clear();
      renderedRunId = run.runId;
    }
    lines.innerHTML = "";
    if (!run.nodes.size) {
      tree.innerHTML = `<div class="team-detail-empty">${run.status === "running" ? "协作树正在规划" : escapeHtml(run.goal || "协作任务已结束")}</div>`;
      graphWidth = graphHeight = 0;
      if (stage) { stage.style.width = "100%"; stage.style.height = "100%"; }
      tree.style.width = tree.style.height = "100%";
      tree.style.transform = lines.style.transform = "none";
      return;
    }

    const nodeWidth = 204;
    const nodeHeight = 88;
    const gapX = 24;
    const gapY = 38;
    const pad = 16;
    const roots = run.rootIds.length ? run.rootIds : Array.from(run.nodes.keys());
    const positions = new Map();
    const levels = new Map();
    const visited = new Set();
    const childrenOf = (nodeId) => Array.from(run.nodes.values()).filter((node) => node.parentId === nodeId);
    const collect = (nodeId) => {
      const node = run.nodes.get(nodeId);
      if (!node || visited.has(nodeId)) return;
      visited.add(nodeId);
      if (!levels.has(node.depth)) levels.set(node.depth, []);
      levels.get(node.depth).push(node);
      childrenOf(nodeId).forEach(child => collect(child.id));
    };
    roots.forEach(collect);
    // Every depth occupies exactly one row; wide levels remain horizontally scrollable.
    layoutWidth = canvas?.clientWidth || 620;
    const columnCount = Math.max(...Array.from(levels.values(), nodes => nodes.length));
    const levelWidth = columnCount * (nodeWidth + gapX) - gapX;
    let row = 0;
    for (const [, nodes] of [...levels].sort((a, b) => a[0] - b[0])) {
      for (let i = 0; i < nodes.length; i++) {
        const col = i % columnCount, rowSize = Math.min(columnCount, nodes.length - Math.floor(i / columnCount) * columnCount);
        const x = pad + (levelWidth - (rowSize * (nodeWidth + gapX) - gapX)) / 2 + col * (nodeWidth + gapX);
        positions.set(nodes[i].id, {x, y: pad + (row + Math.floor(i / columnCount)) * (nodeHeight + gapY), centerX: x + nodeWidth / 2});
      }
      row += Math.ceil(nodes.length / columnCount);
    }

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
    graphWidth = width;
    graphHeight = height;
    updateScale(!manualZoom);

    const edge = (fromId, toId) => {
      const from = positions.get(fromId);
      const to = positions.get(toId);
      if (!from || !to) return;
      const x1 = from.centerX;
      const y1 = from.y + nodeHeight;
      const x2 = to.centerX;
      const y2 = to.y;
      const bend = (y2 - y1) / 2;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", y2 - y1 <= gapY + 1
        ? `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`
        : `M ${x1} ${y1} V ${y1 + 14} H 6 V ${y2 - 14} H ${x2} V ${y2}`);
      path.setAttribute("class", "team-link status-" + (run.nodes.get(toId)?.status || "queued"));
      lines.appendChild(path);
    };
    Array.from(run.nodes.values()).forEach((node) => {
      if (node.parentId) edge(node.parentId, node.id);
    });

    Array.from(run.nodes.values()).forEach((node) => {
      const position = positions.get(node.id);
      if (!position) return;
      let entry = nodeButtons.get(node.id);
      if (!entry) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.nodeId = node.id;
        button.addEventListener("click", () => {
          selectedNodeId = node.id;
          render();
        });
        entry = {button, html: ""};
        nodeButtons.set(node.id, entry);
        if (tree.querySelector(".team-detail-empty")) tree.innerHTML = "";
        tree.appendChild(button);
      }
      const {button} = entry;
      button.className = `team-node status-${node.status}${node.id === selectedNodeId ? " selected" : ""}${node.depth === 0 ? " root" : ""}`;
      button.setAttribute("aria-pressed", String(node.id === selectedNodeId));
      button.title = `${node.role} · ${node.title}\n${node.objective}`;
      button.style.left = position.x + "px";
      button.style.top = position.y + "px";
      button.style.width = nodeWidth + "px";
      button.style.height = nodeHeight + "px";
      const html =
        `<span class="team-node-top"><span class="team-node-role">${escapeHtml(node.role)}</span>` +
        `<span class="team-node-state">${escapeHtml(statusNames[node.status] || node.status)}</span></span>` +
        `<span class="team-node-title">${escapeHtml(node.title)}</span>` +
        `<span class="team-node-caption">${escapeHtml(node.status === "running" ? (node.stage || "正在执行") : (node.objective || "等待执行"))}</span>`;
      if (entry.html !== html) {
        button.innerHTML = html;
        entry.html = html;
      }
    });
  }

  function renderDetail(run) {
    if (!selectedNodeId || !run.nodes.has(selectedNodeId)) {
      selectedNodeId = run.rootIds[0] || Array.from(run.nodes.keys())[0] || "";
    }
    const node = run.nodes.get(selectedNodeId);
    if (!node) {
      detail.innerHTML = `<div class="team-detail-empty">${run.status === "running" ? "正在规划协作树…" : escapeHtml(run.goal || "协作任务已结束")}</div>`;
      detailKey = "";
      detailHtml = "";
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
    const html =
      `<div class="team-detail-head"><div><h3 class="team-detail-title">${escapeHtml(node.title)}</h3>` +
      `<div class="team-detail-role">${escapeHtml(node.role)} · 深度 ${node.depth}</div></div>` +
      `<span class="team-detail-status">${escapeHtml(statusNames[node.status] || node.status)}${node.elapsedMs ? " · " + duration(node.elapsedMs) : ""}</span></div>` +
      `<p class="team-detail-objective">${escapeHtml(node.objective)}</p>` +
      `<div class="team-section-label">执行流程</div><div class="team-steps">${processHtml}</div>` +
      `<div class="team-section-label">最终回答</div>${answer}`;
    const key = run.runId + ":" + node.id;
    if (detailKey !== key || detailHtml !== html) {
      const scrollTop = detailKey === key ? detail.scrollTop : 0;
      detail.innerHTML = html;
      detail.scrollTop = scrollTop;
      detailKey = key;
      detailHtml = html;
    }
  }

  function show() {
    if (!activeRunId) return;
    if (typeof closeResourceDock === "function") closeResourceDock();
    panel.hidden = false;
    scrim.hidden = false;
    visible = true;
    cancelAnimationFrame(showFrame);
    showFrame = requestAnimationFrame(() => {
      panel.classList.add("open");
      scrim.classList.add("open");
      updateScale(!manualZoom);
    });
  }

  function hide(immediate = false) {
    cancelAnimationFrame(showFrame);
    if (!visible || immediate) {
      panel.classList.remove("open");
      scrim.classList.remove("open");
      visible = false;
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
    runId = aliases.get(runId) || runId;
    if (!runs.has(runId)) return;
    if (activeRunId !== runId) { selectedNodeId = ""; manualZoom = false; overview = false; }
    activeRunId = runId;
    selectedNodeId = selectedNodeId || "";
    render();
    show();
  }

  closeBtn?.addEventListener("click", () => {
    if (activeRunId) dismissed.add(activeRunId);
    hide();
  });
  // A dock has no dismissible backdrop. Only its close button or Escape hides it.
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
    close: (options = {}) => hide(!!options.immediate),
    isOpen: () => visible,
  };

  function updateScale(fit = false, force = false) {
    if (!canvas || !stage || !graphWidth || !graphHeight || !visible) return;
    if (fit) scale = Math.max(overview ? .15 : .75, Math.min(1, (canvas.clientWidth - 12) / graphWidth, (canvas.clientHeight - 8) / graphHeight));
    const width = Math.ceil(graphWidth * scale) + "px";
    const height = Math.ceil(graphHeight * scale) + "px";
    const changed = stage.style.width !== width || stage.style.height !== height;
    tree.style.transform = lines.style.transform = `scale(${scale})`;
    stage.style.width = width;
    stage.style.height = height;
    if (zoomValue) zoomValue.textContent = Math.round(scale * 100) + "%";
    if (fit && (changed || force)) { canvas.scrollLeft = Math.max(0, (parseFloat(width) - canvas.clientWidth) / 2); canvas.scrollTop = 0; }
  }
  document.getElementById("team-zoom-fit")?.addEventListener("click", () => { manualZoom = false; overview = true; updateScale(true, true); });
  for (const [id, factor] of [["team-zoom-in", 1.25], ["team-zoom-out", .8]]) {
    document.getElementById(id)?.addEventListener("click", () => {
      manualZoom = true;
      scale = Math.max(.15, Math.min(1.8, scale * factor));
      updateScale();
    });
  }
  if (canvas) new ResizeObserver(() => {
    const run = runs.get(activeRunId);
    if (visible && run && Math.abs(canvas.clientWidth - layoutWidth) > 1) renderTree(run);
    else updateScale(!manualZoom);
  }).observe(canvas);
  const resize = document.getElementById("team-resize");
  function setDockWidth(width) {
    const main = document.querySelector(".app > .main");
    const available = scrim.getBoundingClientRect().width + (main?.getBoundingClientRect().width || 600);
    const value = Math.max(280, Math.min(1000, available - 280, width));
    scrim.style.setProperty("--team-dock-width", value + "px");
    resize?.setAttribute("aria-valuenow", String(Math.round(value)));
  }
  resize?.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX, startWidth = scrim.getBoundingClientRect().width;
    resize.setPointerCapture(event.pointerId);
    const move = e => setDockWidth(startWidth + startX - e.clientX);
    const end = () => { resize.removeEventListener("pointermove", move); resize.removeEventListener("lostpointercapture", end); };
    resize.addEventListener("pointermove", move);
    resize.addEventListener("lostpointercapture", end);
  });
  resize?.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    setDockWidth(scrim.getBoundingClientRect().width + (event.key === "ArrowLeft" ? 40 : -40));
  });
})();
