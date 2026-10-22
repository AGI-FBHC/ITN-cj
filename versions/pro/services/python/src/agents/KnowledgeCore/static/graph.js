/* ITN 知识图谱控制台：审核 + 建边情况 + DAG 图（纯原生，无构建） */
"use strict";

/* ── 基础工具（与 app.js 同风格） ─────────────────────────── */
const $ = (id) => document.getElementById(id);

function apiBase() {
  const v = $("apiBase").value.trim();
  return v ? v.replace(/\/+$/, "") : "/api/v1";
}
function apiUrl(path) {
  return `${apiBase()}${path}`;
}
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  const resp = await fetch(apiUrl(path), { ...options, headers });
  let data = null;
  try { data = await resp.json(); } catch (_) { /* 非 JSON */ }
  if (!resp.ok) throw new Error(data?.detail || `HTTP ${resp.status}`);
  return data;
}
function toast(msg, type = "") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  el.style.cssText = "position:fixed;top:16px;right:16px;z-index:999;padding:10px 16px;border-radius:8px;background:#111827;color:#fff;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.2)";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function fmtTime(s) {
  if (!s) return "–";
  return String(s).replace("T", " ").slice(0, 19);
}
function fmtConf(c) {
  return c == null ? "–" : Number(c).toFixed(2);
}

/* ── Tab 切换 ─────────────────────────────────────────────── */
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "dag") renderDag();
  });
});

/* ── 全局状态 ─────────────────────────────────────────────── */
let allEdges = [];      // 全部边（一次拉取，前端分组统计）
let catMap = {};        // category_id -> {name, level, node_type, sort_order, chunk_count}
let edgeFilter = { status: "", type: "", search: "" };

// T4.9：DAG 过滤器状态（默认 active + 高置信，降噪）
let dagFilter = {
  statuses: new Set(["active"]),
  types: new Set(["prerequisite", "cross_domain_prerequisite", "related"]),
  minConfidence: 0.7,
};
let dagFocusNodeId = null;   // 焦点模式：当前选中节点 id（null = 未激活）
let lastDagEdges = [];       // 最近一次渲染实际用到的边（供焦点模式 BFS 上下游）

const STATUS_LABEL = { active: "生效", proposed: "待审", rejected: "已拒", deprecated: "废弃", redundant: "冗余(已归约)" };
const TYPE_LABEL = {
  prerequisite: "先修",
  cross_domain_prerequisite: "跨域先修",
  related: "相关",
};

/* ── 数据加载 ─────────────────────────────────────────────── */

async function loadCategories() {
  const tree = await api("/knowledge/categories?domain=agent");
  catMap = {};
  const walk = (nodes) => {
    for (const n of nodes || []) {
      catMap[n.id] = {
        id: n.id, name: n.name, level: n.level, node_type: n.node_type,
        sort_order: n.sort_order || 0, parent_id: n.parent_id ?? null,
        chunk_count: n.chunk_count || 0,   // T4.9：节点半径 ∝ log(chunk 数)
      };
      walk(n.children);
    }
  };
  walk(tree.tree);
}

async function loadEdges() {
  allEdges = await api("/knowledge/graph/edges");
  allEdges.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

function catName(id) {
  return catMap[id] ? catMap[id].name : `#${id}（目录树中不存在）`;
}
function catLevel(id) {
  return catMap[id]?.level ?? 0;
}

/* ── 概览 ─────────────────────────────────────────────────── */

function renderOverview() {
  const count = (st) => allEdges.filter((e) => e.status === st).length;
  $("st-active").textContent = count("active");
  $("st-proposed").textContent = count("proposed");
  $("st-rejected").textContent = count("rejected");
  $("st-deprecated").textContent = count("deprecated");
  $("review-badge").textContent = count("proposed");
  $("review-badge").classList.toggle("zero", count("proposed") === 0);

  const tbody = $("recent-table").querySelector("tbody");
  tbody.innerHTML = allEdges.slice(0, 12).map((e) => `
    <tr>
      <td>${esc(catName(e.prereq_category_id))} <span class="muted">#${e.prereq_category_id}</span></td>
      <td>→</td>
      <td>${esc(catName(e.category_id))} <span class="muted">#${e.category_id}</span></td>
      <td>${esc(TYPE_LABEL[e.edge_type] || e.edge_type)}</td>
      <td><span class="st-badge st-${esc(e.status)}">${esc(STATUS_LABEL[e.status] || e.status)}</span></td>
      <td>${esc(e.source)}</td>
      <td>${fmtConf(e.confidence)}</td>
      <td class="muted">${esc(fmtTime(e.created_at))}</td>
    </tr>`).join("") || `<tr><td colspan="8" class="muted">暂无边数据 — 运行 ` + "`python -m app.graph.seed_l1 --domain 1`" + ` 与 sync 生成</td></tr>`;
}

/* 点击统计卡 → 跳到建边情况并过滤 */
document.querySelectorAll(".stat-card").forEach((card) => {
  card.addEventListener("click", () => {
    edgeFilter.status = card.dataset.st;
    document.querySelector('[data-tab="edges"]').click();
    syncChips();
    renderEdgeTable();
  });
});

/* ── 审核队列 ─────────────────────────────────────────────── */

function renderReview() {
  const proposed = allEdges.filter((e) => e.status === "proposed");
  const tbody = $("review-table").querySelector("tbody");
  tbody.innerHTML = proposed.map((e) => `
    <tr data-edge="${e.id}" class="review-row" style="cursor:pointer;">
      <td><input type="checkbox" class="review-check" data-id="${e.id}"></td>
      <td>${esc(catName(e.prereq_category_id))} <span class="muted">#${e.prereq_category_id}</span></td>
      <td>→</td>
      <td>${esc(catName(e.category_id))} <span class="muted">#${e.category_id}</span></td>
      <td>${fmtConf(e.confidence)}</td>
      <td>${esc(e.source)}</td>
      <td class="rationale-cell">${esc(evidencePreview(e))}</td>
      <td class="muted">${esc(fmtTime(e.created_at))}</td>
      <td>
        <button class="btn-mini btn-ok" data-act="approve" data-id="${e.id}">✅ 通过</button>
        <button class="btn-mini btn-no" data-act="reject" data-id="${e.id}">❌ 拒绝</button>
        <button class="btn-mini" data-act="reverse" data-id="${e.id}">🔀 反转</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="9" class="muted">审核队列为空 🎉 — proposed 边全部处理完毕</td></tr>`;
}

/* 批量审核（沿用既有 /review 批接口，已同步经过 T4.7 传递归约闸门） */
async function reviewEdges(ids, approve) {
  if (!ids.length) { toast("请先勾选边", "warn"); return; }
  try {
    const r = await api("/knowledge/graph/review", {
      method: "POST",
      body: JSON.stringify({ edge_ids: ids, approve }),
    });
    toast(`审核完成：${r.approved ?? r.status ?? JSON.stringify(r)}`);
    await refreshAll();
  } catch (err) {
    toast(`审核失败：${err.message}`, "error");
  }
}

/* ── T4.8：单边审批（approve/reject/reverse），全部经后端 activate_edges 闸门 ── */

function evidencePreview(e) {
  // 证据块预览：优先用 evidence_json（T3.2 证据驱动建边落地后可用），否则退回 rationale
  if (e.evidence_json) {
    try {
      const ev = typeof e.evidence_json === "string" ? JSON.parse(e.evidence_json) : e.evidence_json;
      const parts = [];
      if (ev.concept) parts.push(`概念「${ev.concept}」`);
      if (ev.def_chunk != null) parts.push(`定义块#${ev.def_chunk}`);
      if (ev.use_chunk != null) parts.push(`引用块#${ev.use_chunk}`);
      if (parts.length) return parts.join(" · ");
    } catch (_) { /* 非 JSON，退回 rationale */ }
  }
  return e.rationale || "–";
}

async function approveEdgeOne(id) {
  return api(`/knowledge/graph/edges/${id}/approve`, { method: "POST" });
}
async function rejectEdgeOne(id) {
  return api(`/knowledge/graph/edges/${id}/reject`, { method: "POST" });
}
async function reverseEdgeOne(id) {
  return api(`/knowledge/graph/edges/${id}/reverse`, { method: "POST" });
}

async function handleEdgeAction(id, act) {
  try {
    let r;
    if (act === "approve") r = await approveEdgeOne(id);
    else if (act === "reject") r = await rejectEdgeOne(id);
    else if (act === "reverse") r = await reverseEdgeOne(id);
    toast(
      act === "reverse"
        ? `已反转：旧边 #${r.old_edge_id}(${r.old_status}) → 新边 #${r.new_edge_id}(${r.new_status})`
        : `边 #${id} ${act === "approve" ? "已通过并激活" : "已拒绝"}`
    );
    closeEdgeDrawer();
    await refreshAll();
  } catch (err) {
    toast(`操作失败：${err.message}`, "error");
  }
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (btn) {
    e.stopPropagation();
    handleEdgeAction(Number(btn.dataset.id), btn.dataset.act);
    return;
  }
  const row = e.target.closest(".review-row");
  if (row) openEdgeDrawer(Number(row.dataset.edge));
});

/* ── T4.8：审批侧栏（两端名称/来源/置信度/证据块预览 + 三按钮） ───────── */

function openEdgeDrawer(edgeId) {
  const edge = allEdges.find((e) => e.id === edgeId);
  if (!edge) return;
  $("edge-drawer-body").innerHTML = `
    <div><b>边 ID</b>：#${edge.id}</div>
    <div><b>先修（A）</b>：${esc(catName(edge.prereq_category_id))} <span class="muted">#${edge.prereq_category_id}</span></div>
    <div><b>目标（B）</b>：${esc(catName(edge.category_id))} <span class="muted">#${edge.category_id}</span></div>
    <div><b>边类型</b>：${esc(TYPE_LABEL[edge.edge_type] || edge.edge_type)}</div>
    <div><b>来源</b>：${esc(edge.source)}${edge.created_by ? ` (${esc(edge.created_by)})` : ""}</div>
    <div><b>置信度</b>：${fmtConf(edge.confidence)}</div>
    <div><b>状态</b>：<span class="st-badge st-${esc(edge.status)}">${esc(STATUS_LABEL[edge.status] || edge.status)}</span></div>
    <div><b>创建时间</b>：${esc(fmtTime(edge.created_at))}</div>
    <div style="margin-top:8px;"><b>证据块预览 / 理由</b>：<div class="muted" style="white-space:pre-wrap;margin-top:4px;">${esc(evidencePreview(edge))}</div></div>
  `;
  const actions = $("edge-drawer-actions");
  if (edge.status === "proposed") {
    actions.innerHTML = `
      <button class="btn-mini btn-ok" data-act="approve" data-id="${edge.id}">✅ 通过</button>
      <button class="btn-mini btn-no" data-act="reject" data-id="${edge.id}">❌ 拒绝</button>
      <button class="btn-mini" data-act="reverse" data-id="${edge.id}">🔀 反转方向</button>
    `;
  } else {
    actions.innerHTML = `<span class="muted">该边状态为 ${STATUS_LABEL[edge.status] || edge.status}，不支持审批操作</span>`;
  }
  $("edge-drawer-mask").style.display = "block";
  $("edge-drawer").style.display = "block";
}

function closeEdgeDrawer() {
  $("edge-drawer-mask").style.display = "none";
  $("edge-drawer").style.display = "none";
}

$("edge-drawer-close").addEventListener("click", closeEdgeDrawer);
$("edge-drawer-mask").addEventListener("click", closeEdgeDrawer);

$("review-select-all").addEventListener("change", (e) => {
  document.querySelectorAll(".review-check").forEach((c) => (c.checked = e.target.checked));
});
$("btn-review-approve").addEventListener("click", () => {
  reviewEdges(selectedReviewIds(), true);
});
$("btn-review-reject").addEventListener("click", () => {
  reviewEdges(selectedReviewIds(), false);
});
function selectedReviewIds() {
  return [...document.querySelectorAll(".review-check:checked")].map((c) => Number(c.dataset.id));
}

/* ── 建边情况（列表） ─────────────────────────────────────── */

function syncChips() {
  document.querySelectorAll("#edge-status-chips .chip").forEach((c) => {
    c.classList.toggle("active", c.dataset.status === edgeFilter.status);
  });
  document.querySelectorAll("#edge-type-chips .chip").forEach((c) => {
    c.classList.toggle("active", c.dataset.type === edgeFilter.type);
  });
}

function renderEdgeTable() {
  const q = edgeFilter.search.trim().toLowerCase();
  const rows = allEdges
    .filter((e) => !edgeFilter.status || e.status === edgeFilter.status)
    .filter((e) => !edgeFilter.type || e.edge_type === edgeFilter.type)
    .filter((e) => {
      if (!q) return true;
      return catName(e.prereq_category_id).toLowerCase().includes(q)
        || catName(e.category_id).toLowerCase().includes(q);
    });
  const tbody = $("edge-table").querySelector("tbody");
  tbody.innerHTML = rows.map((e) => `
    <tr>
      <td class="muted">#${e.id}</td>
      <td>${esc(catName(e.prereq_category_id))} <span class="muted">#${e.prereq_category_id}</span></td>
      <td>→</td>
      <td>${esc(catName(e.category_id))} <span class="muted">#${e.category_id}</span></td>
      <td>
        <span class="st-badge ${e.edge_type === "cross_domain_prerequisite" ? "et-cross" : e.edge_type === "related" ? "et-related" : ""}">
          ${esc(TYPE_LABEL[e.edge_type] || e.edge_type)}
        </span>
      </td>
      <td><span class="st-badge st-${esc(e.status)}">${esc(STATUS_LABEL[e.status] || e.status)}</span></td>
      <td>${esc(e.source)}</td>
      <td>${fmtConf(e.confidence)}</td>
      <td class="rationale-cell">${esc(e.rationale || "–")}</td>
      <td class="muted">${esc(fmtTime(e.created_at))}</td>
    </tr>`).join("") || `<tr><td colspan="10" class="muted">无匹配边</td></tr>`;
}

document.querySelectorAll("#edge-status-chips .chip").forEach((c) => {
  c.addEventListener("click", () => { edgeFilter.status = c.dataset.status; syncChips(); renderEdgeTable(); });
});
document.querySelectorAll("#edge-type-chips .chip").forEach((c) => {
  c.addEventListener("click", () => { edgeFilter.type = c.dataset.type; syncChips(); renderEdgeTable(); });
});
$("edge-search").addEventListener("input", (e) => { edgeFilter.search = e.target.value; renderEdgeTable(); });

/* ── T4.9：DAG 过滤器（边状态/类型/置信度）+ 节点半径 + 焦点模式 ─────── */

function filteredDagEdges() {
  return allEdges.filter((e) =>
    dagFilter.statuses.has(e.status)
    && dagFilter.types.has(e.edge_type)
    && Number(e.confidence ?? 0) >= dagFilter.minConfidence
  );
}

function nodeRadius(id) {
  // 节点半径 ∝ log(chunk 数)：章节聚合子树切片数，知识点自身切片数
  const cnt = catMap[id]?.chunk_count || 0;
  const base = catLevel(id) === 2 ? 15 : 9;
  return base + 5 * Math.log(cnt + 1);
}

function syncDagFilterChips() {
  document.querySelectorAll("#dag-status-chips .chip").forEach((c) => {
    c.classList.toggle("active", dagFilter.statuses.has(c.dataset.status));
  });
  document.querySelectorAll("#dag-type-chips .chip").forEach((c) => {
    c.classList.toggle("active", dagFilter.types.has(c.dataset.type));
  });
}

document.querySelectorAll("#dag-status-chips .chip").forEach((c) => {
  c.addEventListener("click", () => {
    const st = c.dataset.status;
    if (dagFilter.statuses.has(st)) dagFilter.statuses.delete(st); else dagFilter.statuses.add(st);
    syncDagFilterChips();
    renderDag();
  });
});
document.querySelectorAll("#dag-type-chips .chip").forEach((c) => {
  c.addEventListener("click", () => {
    const ty = c.dataset.type;
    if (dagFilter.types.has(ty)) dagFilter.types.delete(ty); else dagFilter.types.add(ty);
    syncDagFilterChips();
    renderDag();
  });
});
$("dag-conf-slider").addEventListener("input", (e) => {
  dagFilter.minConfidence = Number(e.target.value);
  $("dag-conf-val").textContent = dagFilter.minConfidence.toFixed(2);
  renderDag();
});
document.querySelectorAll('input[name="dag-layout"]').forEach((r) => {
  r.addEventListener("change", () => { dagFocusNodeId = null; renderDag(); });
});

/* 焦点模式：BFS 上游（先修）+ 下游（后修），其余节点/边淡出（透明度 0.15） */
function computeFocusSet(nodeId, edges) {
  const downAdj = new Map(), upAdj = new Map();
  for (const e of edges) {
    if (!downAdj.has(e.prereq_category_id)) downAdj.set(e.prereq_category_id, []);
    downAdj.get(e.prereq_category_id).push(e.category_id);
    if (!upAdj.has(e.category_id)) upAdj.set(e.category_id, []);
    upAdj.get(e.category_id).push(e.prereq_category_id);
  }
  const visited = new Set([nodeId]);
  const bfs = (start, adj) => {
    const q = [start];
    while (q.length) {
      const cur = q.shift();
      for (const nxt of adj.get(cur) || []) {
        if (!visited.has(nxt)) { visited.add(nxt); q.push(nxt); }
      }
    }
  };
  bfs(nodeId, downAdj);
  bfs(nodeId, upAdj);
  return visited;
}

function toggleFocusNode(nodeId) {
  dagFocusNodeId = dagFocusNodeId === nodeId ? null : nodeId;
  applyFocusMode();
  $("btn-dag-clear-focus").style.display = dagFocusNodeId != null ? "" : "none";
}

function clearFocusMode() {
  dagFocusNodeId = null;
  applyFocusMode();
  $("btn-dag-clear-focus").style.display = "none";
}

function applyFocusMode() {
  const svg = $("dag-svg");
  if (dagFocusNodeId == null) {
    svg.querySelectorAll(".dag-node, .dag-edge, .dag-edge-dot").forEach((el) => { el.style.opacity = ""; });
    return;
  }
  const focusSet = computeFocusSet(dagFocusNodeId, lastDagEdges);
  svg.querySelectorAll(".dag-node").forEach((el) => {
    el.style.opacity = focusSet.has(Number(el.getAttribute("data-id"))) ? "1" : "0.15";
  });
  svg.querySelectorAll(".dag-edge[data-prereq]").forEach((el) => {
    const p = Number(el.getAttribute("data-prereq"));
    const t = Number(el.getAttribute("data-target"));
    const inFocus = focusSet.has(p) && focusSet.has(t);
    el.style.opacity = inFocus ? "1" : "0.15";
  });
  svg.querySelectorAll(".dag-edge-dot").forEach((el) => { el.style.opacity = "0.15"; });
}

$("btn-dag-clear-focus").addEventListener("click", clearFocusMode);
$("dag-svg").addEventListener("click", (e) => {
  if (e.target === $("dag-svg")) clearFocusMode();   // 点击空白处退出焦点模式
});

/* ── DAG 图（SVG 手绘，章节带布局） ─────────────────────────── */
// 每章一个"带"：章节节点在上、其知识点垂直排下；章节按 level1+sort 排成网格。
// 带内边（章节→知识点、同章知识点→知识点）= 短垂直边；带间边（章节→章节/跨域）= 曲线。
const DAG_BAND_W = 250;        // 章带宽
const DAG_BAND_GAP = 46;       // 带间距
const DAG_BAND_H = 40;         // 章节节点高
const DAG_KP_H = 30;           // 知识点节点高
const DAG_KP_GAP = 50;         // 知识点行距（行距 80px：带内先修边可见长度 50px，明显）
const DAG_ROWS = 2;            // 章节网格行数（16 章 → 8 列 × 2 行）

function renderDagBand() {
  const svg = $("dag-svg");
  const showKp = $("dag-show-kp").checked;
  const edges = filteredDagEdges();   // T4.9：过滤器（状态/类型/置信度）
  lastDagEdges = edges;

  const nodeIds = new Set();
  for (const e of edges) { nodeIds.add(e.prereq_category_id); nodeIds.add(e.category_id); }

  // 章节排序：按 level1 的 sort_order → 章内 sort_order（目录顺序）
  const chapters = Object.values(catMap)
    .filter((c) => c.level === 2 && nodeIds.has(c.id))
    .sort((a, b) => {
      const pa = catMap[a.parent_id], pb = catMap[b.parent_id];
      return ((pa?.sort_order ?? 0) - (pb?.sort_order ?? 0))
        || ((a.sort_order || 0) - (b.sort_order || 0)) || a.id - b.id;
    });

  // 章内先修深度：先修链越长缩进越深（先修在左、后修在右，水平表达章内关系）
  const depthOf = new Map();     // kp id -> 章内先修深度（最长链）
  const maxDepthByCh = new Map(); // 章 id -> 章内最大深度
  for (const ch of chapters) {
    const pres = new Map();      // target -> [prereqs]（章内边）
    for (const e of edges) {
      if (catMap[e.prereq_category_id]?.parent_id !== ch.id) continue;
      if (catMap[e.category_id]?.parent_id !== ch.id) continue;
      if (!pres.has(e.category_id)) pres.set(e.category_id, []);
      pres.get(e.category_id).push(e.prereq_category_id);
    }
    const kps = Object.values(catMap)
      .filter((c) => c.level === 3 && c.parent_id === ch.id);
    const kpById = new Map(kps.map((k) => [k.id, k]));
    const memo = new Map();
    const depthOfKp = (id) => {
      if (memo.has(id)) return memo.get(id);
      let d = 0;
      for (const pre of pres.get(id) || []) {
        if (!kpById.has(pre)) continue;
        d = Math.max(d, depthOfKp(pre) + 1);
      }
      memo.set(id, d);
      return d;
    };
    let md = 0;
    for (const kp of kps) {
      const d = depthOfKp(kp.id);
      depthOf.set(kp.id, d);
      md = Math.max(md, d);
    }
    maxDepthByCh.set(ch.id, md);
  }

  // 带宽：容纳最深缩进（INDENT_BASE + depth*STEP + KP_W + 余量）
  const INDENT_BASE = 16, INDENT_STEP = 220, KP_W = 200;  // 步长 > 节点宽：相邻深度不重叠
  const globalMaxDepth = Math.max(0, ...maxDepthByCh.values());
  const bandW = Math.max(DAG_BAND_W, INDENT_BASE + globalMaxDepth * INDENT_STEP + KP_W + 24);

  // 布局：带 (row, col) → 节点中心坐标
  const posOf = {};   // category_id -> {x, y, w, h}
  const chEndY = new Map();   // 章 id -> 带内最后一个节点底（背景高度用）
  const BAND_ROW_H = 860;  // 每行带的垂直空间（带内知识点最多 9 个，行距 80px）
  const PER_ROW = Math.ceil(chapters.length / DAG_ROWS);
  chapters.forEach((ch, i) => {
    const row = Math.floor(i / PER_ROW), col = i % PER_ROW;
    const bx = col * (bandW + DAG_BAND_GAP) + bandW / 2;
    const by = row * BAND_ROW_H + 60;
    posOf[ch.id] = { x: bx, y: by, w: bandW, h: DAG_BAND_H };
    if (!showKp) return;
    // 章内知识点按先修拓扑序垂直排列（先修在前）
    const kps = Object.values(catMap)
      .filter((c) => c.level === 3 && c.parent_id === ch.id)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
    const pres = new Map();
    for (const e of edges) {
      if (catMap[e.prereq_category_id]?.parent_id !== ch.id) continue;
      if (catMap[e.category_id]?.parent_id !== ch.id) continue;
      if (!pres.has(e.category_id)) pres.set(e.category_id, []);
      pres.get(e.category_id).push(e.prereq_category_id);
    }
    const ordered = [];
    const seen = new Set();
    const visit = (k) => {
      if (seen.has(k.id)) return;
      seen.add(k.id);
      for (const pre of pres.get(k.id) || []) {
        const pk = kps.find((x) => x.id === pre);
        if (pk) visit(pk);
      }
      ordered.push(k);
    };
    kps.forEach(visit);
    let y = by + DAG_BAND_H + 16;
    const maxChars = Math.max(8, Math.floor((KP_W - 16) / 11));  // 每行可容纳字数
    for (const kp of ordered) {
      // 缩进 = 章内先修深度：先修浅缩进（左）、后修深缩进（右）
      const d = depthOf.get(kp.id) ?? 0;
      const left = bx - bandW / 2 + INDENT_BASE + d * INDENT_STEP;
      const lines = wrapLines(makeLabel(kp.id), maxChars);
      const nodeH = Math.max(DAG_KP_H, 12 + lines.length * 13);  // 多行 → 节点加高
      posOf[kp.id] = { x: left + KP_W / 2, y, w: KP_W, h: nodeH };
      y += nodeH + DAG_KP_GAP;
    }
    chEndY.set(ch.id, y - DAG_KP_GAP);   // 带内最后一个节点底
  });

  // 章内先修边计数（徽标展示，makeLabel 依赖）
  bandEdgeCount.clear();
  for (const e of edges) {
    if (catMap[e.prereq_category_id]?.level !== 3) continue;
    const chId = catMap[e.prereq_category_id]?.parent_id;
    if (chId && catMap[e.category_id]?.parent_id === chId) {
      bandEdgeCount.set(chId, (bandEdgeCount.get(chId) || 0) + 1);
    }
  }

  const width = PER_ROW * (bandW + DAG_BAND_GAP) + 60;
  const height = DAG_ROWS * BAND_ROW_H + 80;
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.innerHTML = "";

  // 章带背景：每个章一个浅色色块（章节节点 + 知识点区域），强化分组
  chapters.forEach((ch, i) => {
    const row = Math.floor(i / PER_ROW), col = i % PER_ROW;
    const bx = col * (bandW + DAG_BAND_GAP);
    const by = row * BAND_ROW_H + 60 - DAG_BAND_H / 2 - 8;
    const bottom = showKp ? (chEndY.get(ch.id) ?? by + DAG_BAND_H) : by + DAG_BAND_H;
    const bgH = bottom - by + 26;
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x", bx - 4);
    bg.setAttribute("y", by - 4);
    bg.setAttribute("width", bandW + 8);
    bg.setAttribute("height", bgH + 8);
    bg.setAttribute("class", "dag-band-bg");
    svg.appendChild(bg);
  });

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8"/></marker>`;
  svg.appendChild(defs);

  // ── 边 ──
  // 带间边（章节→章节/跨域）：按 (源,目标) 分组，组内纵向偏移散开
  // 带内判定：仅「章节→其知识点」与「同章知识点→知识点」（同 x 不同行 ≠ 同章！）
  const sameBand = (a, b) => {
    const la = catLevel(a), lb = catLevel(b);
    if (la === 2 && lb === 3) return catMap[b].parent_id === a;
    if (la === 3 && lb === 3) return catMap[a].parent_id === catMap[b].parent_id;
    return false;
  };
  const crossGroups = new Map();
  const crossEdges = [];
  const intraEdges = [];
  for (const e of edges) {
    const p = posOf[e.prereq_category_id], t = posOf[e.category_id];
    if (!p || !t) continue;
    if (sameBand(e.prereq_category_id, e.category_id)) {
      intraEdges.push({ e, p, t });   // 带内垂直边（同章）
    } else {
      crossEdges.push({ e, p, t });   // 带间边（章节级/跨行/跨域）
    }
  }
  crossEdges.forEach(({ e, p, t }) => {
    const key = `${e.prereq_category_id}:${e.category_id}`;
    if (!crossGroups.has(key)) crossGroups.set(key, []);
    crossGroups.get(key).push({ e, p, t });
  });

  // 带内边：水平弧线从先修右缘 → 目标左缘（先修缩进浅在左、后修缩进深在右，
  // 弧线方向即先修方向；同一先修的边按起点 y 分组纵向错开，天然不重叠）
  const intraStartGroups = new Map();  // "startY" -> [下标]
  intraEdges.forEach(({ p }, i) => {
    const k = `${Math.round(p.y)}`;
    if (!intraStartGroups.has(k)) intraStartGroups.set(k, []);
    intraStartGroups.get(k).push(i);
  });
  for (let i = 0; i < intraEdges.length; i++) {
    const { e, p, t } = intraEdges[i];
    const cls = ["dag-edge", "intra", e.status === "active" ? "active" : "proposed"];
    if (e.edge_type === "cross_domain_prerequisite") cls.push("cross");
    const grp = intraStartGroups.get(`${Math.round(p.y)}`) || [i];
    const offset = (grp.indexOf(i) - (grp.length - 1) / 2) * 10;  // 同起点边纵向错开
    const x1 = p.x + p.w / 2, y1 = p.y + offset;
    const x2 = t.x - t.w / 2, y2 = t.y + offset;
    const dx = Math.max(20, Math.abs(x2 - x1) * 0.35);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", cls.join(" "));
    path.setAttribute("data-prereq", String(e.prereq_category_id));
    path.setAttribute("data-target", String(e.category_id));
    path.setAttribute("d", `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
    path.setAttribute("marker-end", "url(#arrow)");
    // 起点圆点（在弧线起点，标记"从这里出发"）
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", x1);
    dot.setAttribute("cy", y1);
    dot.setAttribute("r", 4);
    dot.setAttribute("class", "dag-edge-dot " + (e.status === "active" ? "active" : "proposed"));
    svg.appendChild(dot);
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${catName(e.prereq_category_id)} → ${catName(e.category_id)}（${STATUS_LABEL[e.status] || e.status}）`;
    path.appendChild(title);
    svg.appendChild(path);
  }

  // 带间边：贝塞尔曲线（源章右侧出 → 目标章左侧进），组内平行偏移
  for (const [key, group] of crossGroups) {
    const gIdx = group.map((_, i) => i);
    group.forEach(({ e, p, t }, idx) => {
      const cls = ["dag-edge", e.status === "active" ? "active" : "proposed"];
      if (e.edge_type === "cross_domain_prerequisite") cls.push("cross");
      const offset = (idx - (group.length - 1) / 2) * 16;
      const x1 = p.x + p.w / 2, y1 = p.y + p.h / 2 + offset;
      const x2 = t.x - t.w / 2, y2 = t.y + t.h / 2 + offset;
      const dx = Math.max(40, Math.abs(x2 - x1) * 0.4);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", cls.join(" "));
      path.setAttribute("data-prereq", String(e.prereq_category_id));
      path.setAttribute("data-target", String(e.category_id));
      path.setAttribute(
        "d",
        `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
      );
      path.setAttribute("marker-end", "url(#arrow)");
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = `${catName(e.prereq_category_id)} → ${catName(e.category_id)}（${STATUS_LABEL[e.status] || e.status}${e.edge_type === "cross_domain_prerequisite" ? " · 跨域" : ""}）`;
      path.appendChild(title);
      svg.appendChild(path);
    });
  }

  // ── 节点 ──
  for (const [id, pos] of Object.entries(posOf)) {
    const lv = catLevel(Number(id));
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", `dag-node ${lv === 2 ? "chapter" : "kp"}`);
    g.setAttribute("transform", `translate(${pos.x - pos.w / 2}, ${pos.y - pos.h / 2})`);
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("width", pos.w);
    rect.setAttribute("height", pos.h);
    const label = makeLabel(Number(id));
    const maxChars = Math.max(8, Math.floor((pos.w - 16) / 11));
    const lines = wrapLines(label, maxChars);
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", 8);
    text.setAttribute("y", lines.length > 1 ? 12 : pos.h / 2 + 4);   // 多行从顶部排
    lines.forEach((ln, i) => {
      const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      tspan.setAttribute("x", 8);
      tspan.setAttribute("dy", i === 0 ? 0 : 13);
      tspan.textContent = ln;
      text.appendChild(tspan);
    });
    g.appendChild(rect);
    g.appendChild(text);
    g.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "title")).textContent =
      `${label}\nid=${id} level=${lv}`;
    g.setAttribute("data-id", String(id));
    g.addEventListener("mouseenter", () => _highlightNodeEdges(Number(id)));
    g.addEventListener("mouseleave", () => _highlightNodeEdges(null));
    g.addEventListener("click", (ev) => { ev.stopPropagation(); toggleFocusNode(Number(id)); });
    svg.appendChild(g);
  }
  applyFocusMode();   // T4.9：焦点模式（刷新/切换过滤后重新应用当前焦点）

  // （hover 高亮函数已提升为顶层 _highlightNodeEdges）

  const kpCount = showKp ? Object.values(posOf).filter((p, i) => Object.keys(posOf)[i] && catLevel(Number(Object.keys(posOf)[i])) === 3).length : 0;
  $("dag-legend").innerHTML = `
    <span><i style="background:#22c55e"></i>active 生效边</span>
    <span><i style="background:#f59e0b"></i>proposed 待审边（虚线）</span>
    <span><i style="background:#8b5cf6"></i>跨域边</span>
    <span class="muted">布局：每章一个带（章节在上、知识点垂直排下）· 带内边=同章先修，带间边=章节先修</span>
    <span class="muted">节点：<b>${Object.keys(posOf).length}</b>（章节 ${chapters.length} + 知识点 ${kpCount}） · 边：<b>${edges.length}</b></span>`;
}

const bandEdgeCount = new Map();   // 章 id -> 章内先修边数（徽标，模块级供 makeLabel 用）

function makeLabel(id) {
  const lv = catLevel(id);
  if (lv === 2) {
    let label = `📖 ${catMap[id]?.name ?? "#" + id}`;
    if (bandEdgeCount.get(Number(id))) {
      label += `  ⛓×${bandEdgeCount.get(Number(id))}`;
    }
    return label;
  }
  const ch = catMap[id] ? catMap[catMap[id].parent_id] : null;
  const num = chapterNum(ch);
  return `• ${num ?? "?"}.${catMap[id]?.sort_order || "?"} ${catMap[id]?.name ?? "#" + id}`;
}

function wrapLines(label, maxChars) {
  // 按像素宽度（11px/中文字符）折行，不截断
  const lines = [];
  let cur = "";
  for (const ch of label) {
    if (cur.length >= maxChars) { lines.push(cur); cur = ""; }
    cur += ch;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/* ── T4.9：拓扑分层布局（dagre，本地引入 static/vendor/dagre.min.js，默认布局） ── */

function renderDagDagre() {
  const svg = $("dag-svg");
  const showKp = $("dag-show-kp").checked;
  let edges = filteredDagEdges();
  if (!showKp) {
    edges = edges.filter((e) => catLevel(e.prereq_category_id) === 2 && catLevel(e.category_id) === 2);
  }
  lastDagEdges = edges;

  svg.innerHTML = "";

  if (typeof dagre === "undefined") {
    // vendor/dagre.min.js 未正确加载：明确提示并回退章节带布局，不静默失败
    $("dag-legend").innerHTML = `<span style="color:#b91c1c">dagre 未加载（检查 /static/vendor/dagre.min.js），已回退章节带布局</span>`;
    renderDagBand();
    return;
  }

  const nodeIds = new Set();
  for (const e of edges) { nodeIds.add(e.prereq_category_id); nodeIds.add(e.category_id); }

  if (nodeIds.size === 0) {
    svg.setAttribute("width", 600);
    svg.setAttribute("height", 80);
    $("dag-legend").innerHTML = `<span class="muted">当前过滤条件下无匹配边/节点，试试放宽状态/类型/置信度过滤器</span>`;
    return;
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 18, ranksep: 100, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));

  const labelOf = {};
  for (const id of nodeIds) {
    const label = catName(id);
    labelOf[id] = label;
    const r = nodeRadius(id);
    const w = Math.max(r * 2 + 8, Math.min(200, 20 + label.length * 11));
    g.setNode(String(id), { width: w, height: Math.max(r * 2 + 8, 30) });
  }
  for (const e of edges) {
    if (nodeIds.has(e.prereq_category_id) && nodeIds.has(e.category_id)) {
      g.setEdge(String(e.prereq_category_id), String(e.category_id));
    }
  }
  dagre.layout(g);

  const posOf = {};
  let maxX = 0, maxY = 0;
  g.nodes().forEach((n) => {
    const d = g.node(n);
    posOf[Number(n)] = { x: d.x, y: d.y, w: d.width, h: d.height };
    maxX = Math.max(maxX, d.x + d.width / 2);
    maxY = Math.max(maxY, d.y + d.height / 2);
  });
  svg.setAttribute("width", Math.max(700, maxX + 80));
  svg.setAttribute("height", Math.max(300, maxY + 80));

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `<marker id="arrow-dagre" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8"/></marker>`;
  svg.appendChild(defs);

  // ── 边（含 redundant：浅灰虚线，弱化但可见——降噪不等于隐藏审计线索） ──
  for (const e of edges) {
    const p = posOf[e.prereq_category_id], t = posOf[e.category_id];
    if (!p || !t) continue;
    const cls = ["dag-edge"];
    if (e.status === "active") cls.push("active");
    else if (e.status === "proposed") cls.push("proposed");
    if (e.edge_type === "cross_domain_prerequisite") cls.push("cross");
    if (e.edge_type === "related") cls.push("related");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", cls.join(" "));
    path.setAttribute("data-prereq", String(e.prereq_category_id));
    path.setAttribute("data-target", String(e.category_id));
    const x1 = p.x + p.w / 2, y1 = p.y;
    const x2 = t.x - t.w / 2, y2 = t.y;
    const dx = Math.max(24, Math.abs(x2 - x1) * 0.4);
    path.setAttribute("d", `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
    path.setAttribute("marker-end", "url(#arrow-dagre)");
    if (e.status === "redundant") {
      path.style.stroke = "#cbd5e1";
      path.style.strokeDasharray = "2 4";
      path.style.opacity = "0.6";
    }
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${catName(e.prereq_category_id)} → ${catName(e.category_id)}（${STATUS_LABEL[e.status] || e.status}，置信度 ${fmtConf(e.confidence)}）`;
    path.appendChild(title);
    svg.appendChild(path);
  }

  // ── 节点（圆形，半径 ∝ log(chunk 数)） ──
  for (const [id, pos] of Object.entries(posOf)) {
    const nid = Number(id);
    const lv = catLevel(nid);
    const r = nodeRadius(nid);
    const grp = document.createElementNS("http://www.w3.org/2000/svg", "g");
    grp.setAttribute("class", `dag-node ${lv === 2 ? "chapter" : "kp"}`);
    grp.setAttribute("data-id", String(nid));
    grp.setAttribute("transform", `translate(${pos.x}, ${pos.y})`);
    grp.style.cursor = "pointer";

    const baseStroke = lv === 2 ? "#60a5fa" : "#94a3b8";
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("r", r.toFixed(1));
    circle.setAttribute("fill", lv === 2 ? "#dbeafe" : "#ffffff");
    circle.setAttribute("stroke", baseStroke);
    circle.setAttribute("stroke-width", "1.4");
    grp.appendChild(circle);

    const chunkCnt = catMap[nid]?.chunk_count ?? 0;
    if (chunkCnt > 0) {
      const chunkTag = document.createElementNS("http://www.w3.org/2000/svg", "text");
      chunkTag.setAttribute("x", 0);
      chunkTag.setAttribute("y", 3);
      chunkTag.setAttribute("text-anchor", "middle");
      chunkTag.setAttribute("font-size", "9");
      chunkTag.setAttribute("fill", "#64748b");
      chunkTag.textContent = `${chunkCnt}`;
      grp.appendChild(chunkTag);
    }

    const label = labelOf[nid] || catName(nid);
    const short = label.length > 11 ? label.slice(0, 10) + "…" : label;
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", 0);
    text.setAttribute("y", r + 13);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-size", "11");
    text.textContent = short;
    grp.appendChild(text);

    const titleEl = document.createElementNS("http://www.w3.org/2000/svg", "title");
    titleEl.textContent = `${label}\nid=${nid} level=${lv} 切片数=${chunkCnt}`;
    grp.appendChild(titleEl);

    grp.addEventListener("mouseenter", () => {
      _highlightNodeEdges(nid);
      circle.setAttribute("stroke", "#2563eb");
      circle.setAttribute("stroke-width", "3");
    });
    grp.addEventListener("mouseleave", () => {
      _highlightNodeEdges(null);
      circle.setAttribute("stroke", baseStroke);
      circle.setAttribute("stroke-width", "1.4");
    });
    grp.addEventListener("click", (ev) => { ev.stopPropagation(); toggleFocusNode(nid); });
    svg.appendChild(grp);
  }

  applyFocusMode();

  $("dag-legend").innerHTML = `
    <span><i style="background:#22c55e"></i>active</span>
    <span><i style="background:#f59e0b"></i>proposed（虚线）</span>
    <span><i style="background:#8b5cf6"></i>跨域</span>
    <span><i style="background:#cbd5e1"></i>redundant（T4.7 归约，浅灰虚线）</span>
    <span class="muted">拓扑分层（dagre，rankdir=LR）· 节点半径 ∝ log(切片数) · 点击节点=焦点模式（上下游高亮，其余淡出）</span>
    <span class="muted">节点：<b>${nodeIds.size}</b> · 边：<b>${edges.length}</b>（过滤后，全部 ${allEdges.length} 条）</span>`;
}

function renderDag() {
  const layout = document.querySelector('input[name="dag-layout"]:checked')?.value || "dagre";
  if (layout === "band") renderDagBand();
  else renderDagDagre();
}

/* hover 节点 → 高亮其全部关联边（先修与后修） */
function _highlightNodeEdges(nodeId) {
  document.querySelectorAll("#dag-svg .dag-edge[data-prereq]").forEach((el) => {
    const hit = nodeId != null &&
      (Number(el.getAttribute("data-prereq")) === nodeId ||
       Number(el.getAttribute("data-target")) === nodeId);
    el.classList.toggle("hl", hit);
  });
}

function chapterNum(c) {
  // 从章名解析章节号："第四章 智能体经典范式构建" → 4
  const m = (c?.name || "").match(/第([一二三四五六七八九十百]+)章/);
  if (!m) return null;
  const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
    十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20 };
  return CN[m[1]] ?? null;
}

$("btn-dag-refresh").addEventListener("click", renderDag);
$("dag-show-kp").addEventListener("change", renderDag);


/* ── 初始化 ───────────────────────────────────────────────── */

async function refreshAll() {
  try {
    await loadCategories();
    await loadEdges();
    renderOverview();
    renderReview();
    renderEdgeTable();
  } catch (err) {
    toast(`加载失败：${err.message}`, "error");
  }
}

$("apiBase").addEventListener("change", refreshAll);
refreshAll();
