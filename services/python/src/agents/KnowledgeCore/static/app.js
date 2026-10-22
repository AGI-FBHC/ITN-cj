/* ITN 知识库控制台 — 纯原生 JS，无构建步骤 */
"use strict";

const $ = (id) => document.getElementById(id);
const LS_KEY = "itn.kc.apiBase";

// ── API 封装 ─────────────────────────────────────────────────────

function apiBase() {
  const v = $("apiBase").value.trim().replace(/\/+$/, "");
  return v || "";
}

function apiUrl(path) {
  const base = apiBase();
  return base ? `${base}/api/v1${path}` : `/api/v1${path}`;
}

async function api(path, options = {}) {
  const opts = { headers: { "Content-Type": "application/json" }, ...options };
  const resp = await fetch(apiUrl(path), opts);
  if (!resp.ok) {
    let detail = `${resp.status} ${resp.statusText}`;
    try {
      const body = await resp.json();
      detail = body.detail || JSON.stringify(body).slice(0, 200);
    } catch (_) { /* ignore */ }
    throw new Error(detail);
  }
  return resp.json();
}

function toast(msg, type = "") {
  const el = $("toast");
  el.textContent = msg;
  el.className = type;
  el.classList.remove("hidden");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add("hidden"), 3500);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function btnLoading(btn, loading, label) {
  if (loading) {
    btn.dataset.label = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 处理中…';
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.label || label || "重试";
  }
}

// ── Tab 切换 ─────────────────────────────────────────────────────

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// API 地址持久化
$("apiBase").value = localStorage.getItem(LS_KEY) || "";
$("apiBase").addEventListener("change", () => {
  localStorage.setItem(LS_KEY, $("apiBase").value.trim());
});

// ── Tab 1: 检索测试 ──────────────────────────────────────────────

const DECISION_LABEL = {
  mysql: "精确命中 MySQL",
  parent: "父级上卷",
  rag: "RAG 兜底",
  empty: "无结果",
};
const SOURCE_LABEL = { mysql: "MySQL", parent: "父级", rag: "RAG" };

async function runQuery() {
  const btn = $("btn-query");
  btnLoading(btn, true);
  const params = new URLSearchParams({ domain: $("q-domain").value.trim() || "agent" });
  const point = $("q-point").value.trim();
  const catId = $("q-category-id").value.trim();
  if (!point && !catId) {
    toast("请输入知识点名称或 category_id", "error");
    btnLoading(btn, false);
    return;
  }
  if (point) params.set("knowledge_point", point);
  if (catId) params.set("category_id", catId);
  const thr = $("q-threshold").value.trim();
  if (thr) params.set("threshold", thr);
  params.set("threshold_mode", $("q-threshold-mode").value);
  params.set("include_rag", $("q-include-rag").checked ? "true" : "false");
  params.set("backfill", $("q-backfill").checked ? "true" : "false");
  const mc = $("q-min-conf").value.trim();
  if (mc) params.set("min_confidence", mc);

  try {
    const r = await api(`/knowledge/chunks?${params}`);
    renderQueryResult(r);
  } catch (e) {
    toast(`检索失败: ${e.message}`, "error");
  } finally {
    btnLoading(btn, false);
  }
}

function renderQueryResult(r) {
  $("query-result").classList.remove("hidden");
  const decision = r.decision || "empty";
  const stats = r.stats || {};
  $("result-meta").innerHTML = `
    <div class="meta-line">
      <span class="decision-badge decision-${decision}">${DECISION_LABEL[decision]}</span>
      ${r.category_id ? `<span><b>${esc(r.category_name)}</b> <span class="muted">id=${r.category_id} · level=${r.category_level ?? "-"} · ${esc(r.node_type ?? "")}</span></span>` : ""}
      <span class="muted">阈值=${r.threshold}</span>
      ${r.via_parent ? '<span class="pill parent">via_parent</span>' : ""}
      ${r.backfill ? `<span class="pill rag">backfill=${r.backfill}</span>` : ""}
      <span class="pill mysql">exact ${stats.exact ?? 0}</span>
      <span class="pill parent">parent ${stats.parent ?? 0}</span>
      <span class="pill rag">rag ${stats.rag ?? 0}</span>
    </div>
    ${r.warning ? `<div class="muted" style="margin-top:6px">⚠️ ${esc(r.warning)}</div>` : ""}
  `;

  const list = $("chunk-list");
  if (!r.chunks || r.chunks.length === 0) {
    list.innerHTML = '<p class="muted">无切片返回</p>';
    return;
  }
  list.innerHTML = r.chunks.map((c, i) => `
    <div class="chunk-item">
      <div class="chunk-head">
        <span class="source-badge source-${c.source}">${SOURCE_LABEL[c.source] || c.source}</span>
        <span class="chunk-title">${esc(c.section_title || c.chunk_code || `#${i + 1}`)}</span>
        <span class="chunk-meta">
          ${c.chunk_code ? esc(c.chunk_code) : ""}
          ${c.confidence != null ? `· 分类置信度 <b>${Number(c.confidence).toFixed(2)}</b>` : ""}
          ${c.similarity != null ? `· 相似度 <b>${Number(c.similarity).toFixed(2)}</b>` : ""}
          ${c.relation_type ? `· ${esc(c.relation_type)}` : ""}
          ${c.document_id ? `· doc=${esc(c.document_id)}` : ""}
        </span>
      </div>
      <div class="chunk-content">${esc(c.content)}</div>
    </div>
  `).join("");
}

$("btn-query").addEventListener("click", runQuery);
$("q-point").addEventListener("keydown", (e) => { if (e.key === "Enter") runQuery(); });

// ── Tab 2: 覆盖报告 ─────────────────────────────────────────────

let coverageItems = [];
let coverageGapFilter = "all";

async function loadCoverage() {
  const btn = $("btn-coverage");
  btnLoading(btn, true);
  try {
    const r = await api(`/knowledge/coverage?domain=agent&threshold_mode=${$("c-threshold-mode").value}`);
    coverageItems = r.items || [];
    renderCoverage(r);
  } catch (e) {
    toast(`覆盖报告加载失败: ${e.message}`, "error");
  } finally {
    btnLoading(btn, false);
  }
}

function renderCoverage(r) {
  const s = r.summary || {};
  $("coverage-summary").innerHTML = `
    <div class="sum-card no_chunks"><div class="num">${s.no_chunks ?? 0}</div><div class="lbl">无切片</div></div>
    <div class="sum-card below_threshold"><div class="num">${s.below_threshold ?? 0}</div><div class="lbl">不足阈值</div></div>
    <div class="sum-card ok"><div class="num">${s.ok ?? 0}</div><div class="lbl">充足</div></div>
    <div class="sum-card"><div class="num">${s.total_chunks ?? 0}</div><div class="lbl">有效切片总数</div></div>
  `;
  renderCoverageTable();
}

function renderCoverageTable() {
  const tbody = $("coverage-table").querySelector("tbody");
  const rows = coverageItems
    .filter((i) => coverageGapFilter === "all" || i.gap === coverageGapFilter)
    .map((i) => `
      <tr class="clickable" data-point="${esc(i.name)}" data-cid="${i.category_id}">
        <td>${esc(i.name)}</td>
        <td class="muted">${esc(i.node_code)}</td>
        <td>L${i.level} ${i.node_type === "category" ? "章节" : "知识点"}</td>
        <td>${i.chunk_count}</td>
        <td>${i.threshold}</td>
        <td><span class="gap-badge gap-${i.gap}">${({ no_chunks: "无切片", below_threshold: "不足", ok: "充足" })[i.gap] || i.gap}</span></td>
        <td><button class="small">检索</button></td>
      </tr>
    `).join("");
  tbody.innerHTML = rows || '<tr><td colspan="7" class="muted">暂无数据</td></tr>';
  tbody.querySelectorAll("tr.clickable").forEach((tr) => {
    tr.addEventListener("click", () => {
      $("q-point").value = tr.dataset.point;
      $("q-category-id").value = tr.dataset.cid || "";
      document.querySelector('[data-tab="query"]').click();
      runQuery();
    });
  });
}

$("btn-coverage").addEventListener("click", loadCoverage);
document.querySelectorAll("#gap-chips .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll("#gap-chips .chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    coverageGapFilter = chip.dataset.gap;
    renderCoverageTable();
  });
});

// ── Tab 3: 目录树 ──────────────────────────────────────────────

let treeData = [];
let treeGapFilter = "all";

async function loadTree() {
  const btn = $("btn-tree");
  btnLoading(btn, true);
  try {
    const r = await api(`/knowledge/categories?domain=agent`);
    treeData = r.tree || [];
    $("tree-count").textContent = `共 ${r.total} 个节点`;
    renderTree();
  } catch (e) {
    toast(`目录树加载失败: ${e.message}`, "error");
  } finally {
    btnLoading(btn, false);
  }
}

function renderTree() {
  const wrap = $("tree-container");
  const hasFilter = treeGapFilter !== "all";
  const filterFn = (nodes) => nodes.filter((n) => treeGapFilter === "all" || n.gap === treeGapFilter);
  const render = (nodes, depth) => filterFn(nodes).map((n) => treeNodeHtml(n, depth)).join("");
  // 筛选模式下：父节点若全不匹配则隐藏；此处简化：直接过滤 + 展开全部
  wrap.innerHTML = render(treeData, 0);
  wrap.querySelectorAll("details").forEach((d) => { d.open = hasFilter; });
  wrap.querySelectorAll(".tree-search").forEach((b) => b.addEventListener("click", onTreeSearch));
}

function treeNodeHtml(n, depth) {
  const badge = `<span class="gap-badge gap-${n.gap}">${({ no_chunks: "无切片", below_threshold: "不足", ok: "充足" })[n.gap] || n.gap}</span>`;
  const meta = `<span class="tree-meta">${n.chunk_count} 条切片</span>`;
  const btn = `<button class="small tree-search" data-point="${esc(n.name)}" data-cid="${n.id}" title="检索该节点">🔍</button>`;
  const hasKids = n.children && n.children.length > 0;
  const isKp = n.node_type === "knowledge_point";
  const icon = isKp ? "📌" : (depth === 0 ? "🗂️" : "📁");
  const body = `<span class="tree-label ${n.gap}">${icon} ${esc(n.name)}</span> ${badge} ${meta} ${btn}`;
  if (!hasKids) return `<div class="tree-item" style="padding-left:${depth * 22 + 8}px">${body}</div>`;
  return `<details class="tree-node" style="padding-left:${depth * 22}px">
    <summary>${body}</summary>
    <div class="tree-children">${n.children.map((c) => treeNodeHtml(c, depth + 1)).join("")}</div>
  </details>`;
}

function onTreeSearch(e) {
  const b = e.currentTarget;
  $("q-point").value = b.dataset.point;
  $("q-category-id").value = b.dataset.cid || "";
  document.querySelector('[data-tab="query"]').click();
  runQuery();
}

$("btn-tree").addEventListener("click", loadTree);
document.querySelectorAll("#tree-chips .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll("#tree-chips .chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    treeGapFilter = chip.dataset.gap;
    renderTree();
  });
});

// ── Tab 4: 分类审计 ─────────────────────────────────────────────

async function loadAudit() {
  const btn = $("btn-audit");
  btnLoading(btn, true);
  const params = new URLSearchParams({ domain: "agent" });
  params.set("max_confidence", $("a-max-conf").value || "0.7");
  const src = $("a-source").value;
  if (src) params.set("source", src);
  try {
    const r = await api(`/knowledge/classifications/audit?${params}`);
    renderAudit(r);
  } catch (e) {
    toast(`审计加载失败: ${e.message}`, "error");
  } finally {
    btnLoading(btn, false);
  }
}

function renderAudit(r) {
  $("audit-count").textContent = `共 ${r.total} 条（展示 ${r.items.length}）`;
  const tbody = $("audit-table").querySelector("tbody");
  tbody.innerHTML = r.items.map((it) => `
    <tr data-cid="${it.classification_id}" data-chunk="${it.chunk_id}" data-cat="${it.category_id}">
      <td>${it.classification_id}</td>
      <td>
        <b>${esc(it.chunk_code || `chunk#${it.chunk_id}`)}</b>
        <div class="muted">${esc(it.section_title || "")}</div>
        <div class="content-preview">${esc(it.content_preview || "")}</div>
      </td>
      <td>
        ${esc(it.category_name)} <span class="muted">id=${it.category_id}</span>
        <div class="muted">${esc(it.node_code)} · L${it.level}</div>
      </td>
      <td>${esc(it.relation_type)}</td>
      <td>
        <div class="confidence-bar"><div class="fill" style="width:${Math.round((it.confidence ?? 0) * 100)}%"></div></div>
        <span class="muted">${(it.confidence ?? 0).toFixed(2)}</span>
      </td>
      <td>${esc(it.source)}</td>
      <td>
        <div class="audit-actions">
          <button class="small" data-act="move">改挂</button>
          <button class="small" data-act="conf">调置信度</button>
          <button class="small danger" data-act="delete">删除</button>
        </div>
        <div class="correct-form hidden">
          <input placeholder="目标知识点名称（自动解析 ID）">
          <button class="small primary" data-act="confirm">确认改挂</button>
          <button class="small" data-act="cancel">取消</button>
        </div>
      </td>
    </tr>
  `).join("");

  tbody.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", onAuditAction);
  });
}

async function onAuditAction(e) {
  const btn = e.target;
  const tr = btn.closest("tr");
  const cid = Number(tr.dataset.cid);
  const chunkId = Number(tr.dataset.chunk);
  const oldCat = Number(tr.dataset.cat);
  const act = btn.dataset.act;
  const form = tr.querySelector(".correct-form");

  if (act === "move") {
    form.classList.remove("hidden");
    form.querySelector("input").focus();
    return;
  }
  if (act === "cancel") {
    form.classList.add("hidden");
    return;
  }
  if (act === "confirm") {
    const name = form.querySelector("input").value.trim();
    if (!name) { toast("请输入目标知识点名称", "error"); return; }
    try {
      btnLoading(btn, true);
      // 复用检索接口解析知识点名称 → category_id
      const r = await api(`/knowledge/chunks?knowledge_point=${encodeURIComponent(name)}&include_rag=false&limit=1`);
      if (!r.category_id) throw new Error(`未找到知识点: ${name}`);
      const res = await api("/knowledge/classifications/correct", {
        method: "POST",
        body: JSON.stringify({ action: "move", classification_id: cid, new_category_id: r.category_id }),
      });
      toast(`✅ ${res.detail}`, "success");
      form.classList.add("hidden");
      loadAudit();
    } catch (err) {
      toast(`改挂失败: ${err.message}`, "error");
      btnLoading(btn, false);
    }
    return;
  }
  if (act === "conf") {
    const v = window.prompt("新的置信度 (0~1)：", "0.9");
    if (v === null || v === "") return;
    const conf = Number(v);
    if (isNaN(conf) || conf < 0 || conf > 1) { toast("置信度需在 0~1 之间", "error"); return; }
    try {
      const res = await api("/knowledge/classifications/correct", {
        method: "POST",
        body: JSON.stringify({ action: "set_confidence", classification_id: cid, confidence: conf }),
      });
      toast(`✅ ${res.detail}`, "success");
      loadAudit();
    } catch (err) { toast(`操作失败: ${err.message}`, "error"); }
    return;
  }
  if (act === "delete") {
    if (!window.confirm(`确认删除分类记录 #${cid}？(chunk ${chunkId} → 知识点 ${oldCat})`)) return;
    try {
      const res = await api("/knowledge/classifications/correct", {
        method: "POST",
        body: JSON.stringify({ action: "delete", classification_id: cid }),
      });
      toast(`✅ ${res.detail}`, "success");
      loadAudit();
    } catch (err) { toast(`删除失败: ${err.message}`, "error"); }
  }
}

$("btn-audit").addEventListener("click", loadAudit);

// ── Tab 4: 手动写回 ─────────────────────────────────────────────

async function runBackfill() {
  const point = $("b-point").value.trim();
  if (!point) { toast("请输入知识点名称", "error"); return; }
  const btn = $("btn-backfill");
  btnLoading(btn, true);
  try {
    const r = await api("/knowledge/backfill", {
      method: "POST",
      body: JSON.stringify({
        knowledge_point: point,
        domain: "agent",
        top_k: Number($("b-topk").value) || 8,
        similarity_threshold: Number($("b-sim").value) || 0.2,
      }),
    });
    $("backfill-result").classList.remove("hidden");
    $("backfill-result").innerHTML = `
<b>${esc(r.knowledge_point)}</b> (category_id=${r.category_id ?? "-"})
RAG 取回 ${r.rag_fetched} 条 → LLM 复判 ${r.judged} 条 → 写回 <b>${r.written}</b> 条
（重复跳过 ${r.skipped_duplicate} · 拒绝 ${r.rejected}）
${r.error ? `<div style="color:var(--danger)">⚠️ ${esc(r.error)}</div>` : ""}
`;
    toast(r.written > 0 ? `✅ 写回 ${r.written} 条` : (r.error ? `⚠️ ${r.error}` : "无写回（可能重复或 LLM 判定不相关）"), r.written > 0 ? "success" : "");
  } catch (e) {
    toast(`写回失败: ${e.message}`, "error");
  } finally {
    btnLoading(btn, false);
  }
}

$("btn-backfill").addEventListener("click", runBackfill);
