/* ITN-Desktop 前端：无框架、无构建，界面由仓颉内核托管。
 *
 * 接手须知（写给下一个人）：
 * 1. 这份 app.js 就是桌面窗口里跑的全部前端逻辑。没有构建步骤，不能引外部依赖，不要加 npm 包。
 * 2. 产品只做三件事：知识库 / 讲义与练习 / 设置。但每一块都要能独立走通完整闭环——
 *    配模型 → 指定资料目录 → 建立索引 → 问答 / 出题 / 生成讲义 → 产物落在本机。
 * 3. 空态必须给出「可点的下一步」。任何页面都不允许出现没有出口的死胡同文案。
 * 4. 所有接口调用都要 try/catch 并把内核返回的失败原因显示出来，不静默、不伪造数据。
 * 5. 写完用 tools/ui-shot.cjs（结构 + 截图）与 tools/ui-e2e.cjs（点得动、跑得通）自检。
 *    注意：往这个文件写内容不要用 PowerShell 的 Set-Content -Value 数组写法，会破坏换行。
 */

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function api(path, body) {
  const init = { method: body === undefined ? "GET" : "POST" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw new Error("内核连接失败：" + e.message);
  }
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error("内核返回的不是 JSON（HTTP " + res.status + "）");
  }
  if (json.code !== 0) throw new Error(json.message || ("请求失败（HTTP " + res.status + "）"));
  return json.data;
}

/* ---------- 小工具 ---------- */

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3000);
}

function setStatus(text, isErr) {
  const s = $("status");
  s.textContent = text;
  s.classList.toggle("err", !!isErr);
}

function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0; }

function fmtSize(n) {
  const v = Number(n || 0);
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  return (v / 1024 / 1024).toFixed(2) + " MB";
}

/** 内核时间戳形如 2026-10-14T10:18:27+08:00，这里只保留 10-14 10:18。 */
function fmtStamp(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return String(s || "");
  return m[2] + "-" + m[3] + " " + m[4] + ":" + m[5];
}

function plural(n, unit) { return Number(n || 0) + " " + unit; }

/** 毫秒时间戳 → 08-16 14:30（错题的下次复习时间用它）。 */
function fmtMs(ms) {
  const v = Number(ms || 0);
  if (!v) return "";
  const d = new Date(v);
  const p = (x) => String(x).padStart(2, "0");
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/** 距今天还有几天（用于"下次复习 3 天后"）。 */
function daysUntil(ms) {
  const diff = Number(ms || 0) - Date.now();
  if (diff <= 0) return 0;
  return Math.ceil(diff / 86400000);
}

/** 本地时间戳，形如 2026-10-14T11:30（只用于笔记标题这类展示用途）。 */
function nowStamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
}

/* ---------- 图标 ---------- */

const ICONS = {
  home: "M3 10.5 12 3l9 7.5V21H3z",
  book: "M4 4h7v16H4zM13 4h7v16h-7z",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  file: "M6 2h8l4 4v16H6zM14 2v4h4",
  db: "M12 3c4 0 7 1 7 2s-3 2-7 2-7-1-7-2 3-2 7-2zM5 5v14c0 1 3 2 7 2s7-1 7-2V5",
  chat: "M4 4h16v12H8l-4 4z",
  note: "M5 3h14v18H5zM8 8h8M8 12h8M8 16h5",
  flag: "M6 3v18M6 4h11l-2 4 2 4H6",
  // 齿轮：外圈六个齿 + 内圈，画法和太阳明显不同（之前那个是"圆 + 六条短线"，太像太阳）
  gear: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7V20a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.8v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3.1"/>',
  clock: "M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  sliders: "M4 8h9M17 8h3M4 16h3M11 16h9M15 5v6M7 13v6",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l4 4",
  plus: "M12 5v14M5 12h14",
  play: "M7 4l12 8-12 8z",
  check: "M4 12l5 5L20 6",
  alert: "M12 3l9 16H3zM12 9v5M12 17h.5",
  layers: "M12 3l9 5-9 5-9-5zM3 14l9 5 9-5",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  target: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  sun: "M12 7.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8zM12 2.2v2.1M12 19.7v2.1M2.2 12h2.1M19.7 12h2.1M5.2 5.2l1.5 1.5M17.3 17.3l1.5 1.5M18.8 5.2l-1.5 1.5M6.7 17.3l-1.5 1.5",
  moon: "M20.4 14.4A8.4 8.4 0 0 1 9.6 3.6 8.4 8.4 0 1 0 20.4 14.4z",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3.5 9h17M3.5 15h17M12 3c2.4 2.4 3.6 5.4 3.6 9s-1.2 6.6-3.6 9c-2.4-2.4-3.6-5.4-3.6-9S9.6 5.4 12 3z",
  chevron: "M6 9.5 12 15.5 18 9.5",
  shield: "M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6zM9 12l2 2 4-4",
};

/**
 * 画一个图标。
 *
 * ICONS 里存的通常是 path 的 d；个别图标（齿轮）需要不止一段，就直接写整段
 * SVG 子元素——以 "<" 开头即按原样插入。
 */
function icon(name, box) {
  const d = ICONS[name] || ICONS.home;
  const vb = box ? "0 0 32 32" : "0 0 24 24";
  const inner = d.charAt(0) === "<" ? d : '<path d="' + d + '"/>';
  return '<svg viewBox="' + vb + '" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + inner + "</svg>";
}

/* ---------- Markdown（够用就好，不做完整实现） ---------- */

function md(src) {
  const text = String(src == null ? "" : src);
  const lines = esc(text).split("\n");
  const out = [];
  let inCode = false, listType = null;
  const closeList = () => { if (listType) { out.push(listType === "ul" ? "</ul>" : "</ol>"); listType = null; } };
  const inline = (s) => s
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '<span class="md-img">图片 · $1</span>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[(\d+)\]/g, '<span class="cite">[$1]</span>');
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*```/.test(line)) { closeList(); out.push(inCode ? "</code></pre>" : "<pre><code>"); inCode = !inCode; continue; }
    if (inCode) { out.push(raw); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); const n = h[1].length; out.push("<h" + n + ">" + inline(h[2]) + "</h" + n + ">"); continue; }
    if (/^\s*$/.test(line)) { closeList(); continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { closeList(); out.push("<hr>"); continue; }
    const bq = line.match(/^\s*&gt;\s?(.*)$/);
    if (bq) { closeList(); out.push("<blockquote>" + inline(bq[1]) + "</blockquote>"); continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) { if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; } out.push("<li>" + inline(ul[1]) + "</li>"); continue; }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) { if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; } out.push("<li>" + inline(ol[1]) + "</li>"); continue; }
    closeList();
    out.push("<p>" + inline(line) + "</p>");
  }
  closeList();
  if (inCode) out.push("</code></pre>");
  return '<div class="md">' + out.join("\n") + "</div>";
}

/* ---------- 通用组件 ---------- */

function option(value, label) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

function btn(label, cls, onClick) {
  const b = el("button", "btn " + (cls || ""), label);
  if (onClick) b.onclick = onClick;
  return b;
}

function tag(text, cls) {
  return el("span", "tag" + (cls ? " " + cls : ""), text);
}

function spacer() { return el("div", "spacer"); }

/** 统一卡片：title/sub/tag/actions 都可选，body 是一个节点。 */
function cardOf(opt) {
  const o = opt || {};
  const c = el("div", "card" + (o.cls ? " " + o.cls : ""));
  if (o.title || o.actions || o.tag) {
    const head = el("div", "card-head");
    if (o.title) head.appendChild(el("h2", null, o.title));
    if (o.sub) head.appendChild(el("span", "card-sub", o.sub));
    head.appendChild(spacer());
    if (o.tag) head.appendChild(tag(o.tag, o.tagCls));
    if (o.actions) for (const a of o.actions) head.appendChild(a);
    c.appendChild(head);
  }
  if (o.body) c.appendChild(o.body);
  return c;
}

/** 可操作空态：标题 + 说明 + 下一步按钮，禁用纯文字死胡同。 */
function emptyState(opt) {
  const o = opt || {};
  const box = el("div", "empty" + (o.inline ? " inline" : ""));
  const badge = el("div", "empty-badge");
  badge.innerHTML = icon(o.art || "plus", true);
  box.appendChild(badge);
  box.appendChild(el("strong", null, o.title || "还没有内容"));
  if (o.text) box.appendChild(el("p", "empty-text", o.text));
  if (o.actions && o.actions.length) {
    const row = el("div", "empty-actions");
    for (const a of o.actions) row.appendChild(a);
    box.appendChild(row);
  }
  return box;
}

function statCard(label, value, unit, onClick) {
  const s = el("div", "stat" + (onClick ? " clickable" : ""));
  s.innerHTML = '<div class="k">' + esc(label) + '</div><div class="v">' + esc(value) +
    (unit ? '<span class="u">' + esc(unit) + "</span>" : "") + "</div>";
  if (onClick) s.onclick = onClick;
  return s;
}

function fieldOf(label, input) {
  const f = el("div", "field");
  const l = el("label", null, label);
  f.appendChild(l);
  f.appendChild(input);
  return f;
}

function inputOf(id, placeholder, value) {
  const i = el("input");
  i.id = id;
  if (placeholder) i.placeholder = placeholder;
  if (value !== undefined && value !== null) i.value = value;
  return i;
}

function selectOf(id, items, value) {
  const s = el("select");
  s.id = id;
  for (const it of items) s.appendChild(option(it.value, it.label));
  if (value !== undefined) s.value = value;
  return s;
}

function copyButton(getText, label) {
  return btn(label || "复制", "sm ghost", async () => {
    const text = typeof getText === "function" ? getText() : getText;
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制到剪贴板");
    } catch (e) {
      toast("复制失败，请手动选择文本");
    }
  });
}

/** 生成类任务的过程卡：只报真实耗时 + 说明流水线，不假装进度。 */
function progressCard(title, steps) {
  const c = el("div", "card progress-card");
  const head = el("div", "card-head");
  head.innerHTML = '<span class="spinner"></span><h2>' + esc(title) + "</h2>";
  head.appendChild(spacer());
  const timer = el("span", "muted sm", "0.0 秒");
  head.appendChild(timer);
  c.appendChild(head);
  const box = el("div", "pipe");
  for (const s of steps) box.appendChild(el("span", "pipe-step", s));
  c.appendChild(box);
  c.appendChild(el("p", "muted sm", "生成过程会逐个调用模型，耗时取决于你配置的服务；期间可以先看别的页面。"));
  c._timer = setInterval(() => {
    const t = (Date.now() - c._start) / 1000;
    timer.textContent = t.toFixed(1) + " 秒";
  }, 100);
  c._start = Date.now();
  c._stop = () => clearInterval(c._timer);
  return c;
}

function citationBox(citations, report) {
  const box = el("div", "cites");
  if (report) {
    const bad = (report.outOfRange || 0) + (report.outOfRangeWeb || 0);
    const webBit = report.webCited ? " · 网络引用 " + report.webCited : "";
    box.appendChild(tag("段落 " + report.paragraphs + " · 带引用 " + report.citedParagraphs + webBit +
      " · 越界 " + bad, bad > 0 ? "warn" : "ok"));
  }
  if (citations && citations.length) {
    const ul = el("ul", "cite-list");
    for (const c of citations) {
      const li = el("li");
      // 网络来源单独一套编号：[n] 是本机资料，[Wn] 是抓回来的网页（会变，所以必须带抓取时间）
      const label = c.label || String(c.index);
      li.textContent = "[" + label + "] " + (c.docTitle ? "《" + c.docTitle + "》" : c.docPath || "") +
        (c.kind === "web" ? " · 网络资料 · 抓取于 " + (c.fetchedAt || "") : (c.headingPath ? " · " + c.headingPath : "")) +
        (c.docPath ? "（" + c.docPath + "）" : "");
      if (c.kind === "web") li.classList.add("cite-web");
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  return box;
}
/* ---------- 全局状态 ---------- */

const state = {
  cfg: { models: [], knowledgeBases: [], chatModelId: "", embedModelId: "", chunkModelId: "" },
  profile: {}, report: {}, artifacts: [], sessions: [],
  kb: "", chapter: null, artifactQuery: "", wrongTab: "due", wrongQuery: "",
  chatSessionId: "", chatTurns: [], chatEvents: [], tools: null, chatQuery: "", artifactFocus: "",
  webMode: "auto", skill: "", skills: [],
  busyTurn: false, pendingQuestion: "", lastQuestion: "",
  // 主题与会话栏偏好存在内核的 settings 表里（内核端口每次启动都变，localStorage 活不过一次重启）
  theme: "system", dark: false, panelHidden: false, kernel: null,
};

let current = "home";

async function loadCfg() {
  state.cfg = await api("/api/settings");
  if (!state.cfg.models) state.cfg.models = [];
  if (!state.cfg.knowledgeBases) state.cfg.knowledgeBases = [];
  if (!state.kb || !state.cfg.knowledgeBases.some((k) => k.id === state.kb)) {
    const indexed = state.cfg.knowledgeBases.find((k) => (k.chunkCount || 0) > 0);
    state.kb = (indexed || state.cfg.knowledgeBases[0] || {}).id || "";
  }
}
async function loadProfile() { state.profile = (await api("/api/profile/get", {})) || {}; }

/**
 * 保存档案。
 *
 * 内核的 /api/profile/save 是"整个档案覆盖写"：请求里没带的字段会被写成空。
 * 所以这里统一由一处拼装完整对象，调用方只传要改的部分——否则「保存自评分」会把
 * 昵称、学习目标、偏好格式全清掉（这是个真实的数据丢失口子）。
 */
async function saveProfile(patch) {
  const p = state.profile || {};
  const body = {
    nickname: patch.nickname !== undefined ? patch.nickname : (p.nickname || ""),
    goal: patch.goal !== undefined ? patch.goal : (p.goal || ""),
    weeklyHours: patch.weeklyHours !== undefined ? patch.weeklyHours : (p.weeklyHours || 0),
    preferredFormats: p.preferredFormats || [],
    selfScores: Object.assign({}, p.selfScores || {}, patch.selfScores || {}),
  };
  const d = await api("/api/profile/save", body);
  state.profile = d || state.profile;
  return state.profile;
}
async function loadReport() { state.report = (await api("/api/study/report", { kbId: state.kb || "" })) || {}; }
async function loadArtifacts() {
  try { state.artifacts = (await api("/api/artifacts/list", {})).artifacts || []; }
  catch (e) { state.artifacts = []; }
}
async function loadSessions() {
  try { state.sessions = (await api("/api/sessions/list", {})).sessions || []; }
  catch (e) { state.sessions = []; }
}

/** 一次性把首页/侧栏需要的四类数据拉齐。 */
async function loadOverview() {
  await loadCfg();
  await loadProfile();
  await loadReport();
  await loadArtifacts();
  await loadSessions();
}

function hasChatModel() { return state.cfg.models.length > 0 && !!state.cfg.chatModelId; }
function hasKb() { return state.cfg.knowledgeBases.length > 0; }
function indexedKb() { return state.cfg.knowledgeBases.find((k) => (k.chunkCount || 0) > 0) || null; }
function kbName(id) {
  const k = state.cfg.knowledgeBases.find((x) => x.id === id);
  return k ? (k.name || k.id) : (id || "未选择");
}
function modelLabel(id) {
  const m = state.cfg.models.find((x) => x.id === id);
  return m ? (m.name || m.id) : "";
}

/** 「首次使用清单」：五个必须走通的环节，完成状态全部来自真实数据。 */
function checklist() {
  const kbs = state.cfg.knowledgeBases;
  const steps = [
    { done: hasChatModel(), title: "配置模型接口", text: "填一次 Base URL 和 API Key，并把「对话与生成」绑定到它。", go: () => go("settings", "models"), act: "去配置" },
    { done: kbs.length > 0, title: "指定资料目录", text: "选一个本机的 Markdown / 纯文本目录，作为这门课的知识库。", go: () => go("settings", "kb"), act: "去指定" },
    { done: kbs.some((k) => (k.chunkCount || 0) > 0), title: "建立索引", text: "扫描目录并按标题切片；这一步过后检索才有内容。", go: () => go("settings", "kb"), act: "去建立" },
    { done: state.sessions.length > 0, title: "问第一个问题", text: "在伴学助手里就你的资料提问，答案会标出出处编号。", go: () => go("chat"), act: "去提问" },
    { done: state.artifacts.length > 0, title: "生成第一份产物", text: "把一章做成讲义或练习，落成本机 Markdown 文件。", go: () => go("learn"), act: "去生成" },
  ];
  return steps;
}

/* ---------- 导航与路由 ---------- */

/* 窄侧栏：只有图标，分组之间一条细线。
   文字靠悬停提示（.rail-tip），不靠常驻标签——栏窄了才不抢主区的空间。 */
const RAIL_GROUPS = [
  [
    { id: "home", label: "首页", icon: "home" },
    { id: "learn", label: "学 · 练", icon: "book" },
    { id: "notes", label: "我的笔记", icon: "note" },
    { id: "wrong", label: "错题本", icon: "flag" },
    { id: "report", label: "我的成长", icon: "chart" },
    { id: "calibrate", label: "画像校准", icon: "target" },
  ],
  [
    { id: "resources", label: "我的资源", icon: "layers" },
    { id: "kb", label: "领域知识库", icon: "db" },
  ],
  // 对话与会话记录本来是同一件事的两面：会话栏就挂在对话页左侧。
  // 上一版把「会话记录」单列成一项，等于同一份数据两个入口，已经合并。
  [{ id: "chat", label: "伴学助手", icon: "chat" }],
];


/* ---------- 页面表 ---------- */

const PAGE_META = {
  home: { title: "首页", sub: "今天学什么，从这里开始" },
  learn: { title: "学 · 练", sub: "按章节读资料、出题、生成讲义" },
  notes: { title: "我的笔记", sub: "随手记下的要点" },
  wrong: { title: "错题本", sub: "做错的题在这里复习" },
  report: { title: "我的成长", sub: "学习记录与能力变化" },
  calibrate: { title: "画像校准", sub: "用真实练习数据与自己的判断对齐六维能力" },
  resources: { title: "我的资源", sub: "生成的讲义与练习，全部在本机" },
  kb: { title: "领域知识库", sub: "检索资料，每一句都能追到原文" },
  chat: { title: "伴学助手", sub: "就你的资料提问" },
  sessions: { title: "全部会话与步骤", sub: "每一次检索、生成都留了可追溯的过程" },
  models: { title: "模型与接口", sub: "填写自己的模型服务，统一 OpenAI 兼容格式" },
  settings: { title: "设置", sub: "档案、外观、知识库、模型与数据都收在这里" },
};

function navBadge(id) {
  if (id === "notes") return state.report.noteCount || 0;
  if (id === "wrong") return state.report.quizWrong || 0;
  if (id === "resources") return state.artifacts.length || 0;
  if (id === "sessions") return state.sessions.length || 0;
  return 0;
}

/**
 * 窄侧栏上的一个"页面入口"。
 *
 * 栏只有 56px，写不下标签，所以文字做成悬停提示（.rail-tip）；
 * 有数量的入口在右上角点一个小徽标。类名统一叫 .nav-item —— 工具链
 * （tools/ui-shot.cjs、tools/ui-e2e.cjs）靠它枚举页面，改名会让自检失效。
 */
function railButton(item) {
  const b = el("button", "nav-item");
  b.type = "button";
  b.dataset.page = item.id;
  b.setAttribute("aria-label", item.label);
  const n = navBadge(item.id);
  b.innerHTML = icon(item.icon) +
    (n > 0 ? '<span class="nav-badge">' + (n > 99 ? "99+" : n) + "</span>" : "") +
    '<span class="rail-tip">' + esc(item.label) + (n > 0 ? " · " + n : "") + "</span>";
  b.onclick = () => go(item.id);
  return b;
}

/** 侧栏上的"动作"按钮（检索、主题、设置不进任何分组）。刻意不用 .nav-item，免得被当成页面。 */
function railAction(id, iconName, label, onClick) {
  const b = el("button", "rail-btn");
  b.type = "button";
  if (id) b.id = id;
  b.setAttribute("aria-label", label);
  b.innerHTML = icon(iconName) + '<span class="rail-tip">' + esc(label) + "</span>";
  b.onclick = onClick;
  return b;
}

function buildNav() {
  const rail = $("rail");
  if (!rail) return;
  rail.innerHTML = "";

  // 检索放在最上面：它是"入口"，不属于任何一页
  rail.appendChild(railAction("rail-search-btn", "search", "检索资料与笔记（Ctrl+K）", () => openPalette()));
  rail.appendChild(el("div", "rail-sep"));

  RAIL_GROUPS.forEach((group, gi) => {
    if (gi > 0) rail.appendChild(el("div", "rail-sep"));
    for (const it of group) {
      const b = railButton(it);
      if (it.id === current) b.classList.add("active");
      rail.appendChild(b);
    }
  });

  rail.appendChild(el("div", "rail-spacer"));
  rail.appendChild(el("div", "rail-sep"));

  rail.appendChild(railAction("rail-theme", state.dark ? "moon" : "sun",
    (state.dark ? "切到浅色" : "切到深色") + "（设置里可以跟随系统）", () => toggleTheme()));

  const setBtn = railButton({ id: "settings", label: "设置", icon: "gear" });
  if (current === "settings") setBtn.classList.add("active");
  rail.appendChild(setBtn);
  // 齿轮是"设置"的通用记号：上一版用的图形像太阳，和主题按钮撞脸，已换成真正的齿轮
}

function pageFromHash() {
  const m = String(location.hash || "").match(/^#\/([a-z]+)(?:\/([a-z]+))?/);
  const page = m && PAGES[m[1]] ? m[1] : "home";
  return { page: page, section: m && m[2] ? m[2] : "" };
}

/* 自己维护一份访问栈：前进/后退交给浏览器（pushState + popstate），
   箭头是否可点按这份栈来算——只看 history.length 分不出"在哪一格"。 */
const navStack = [];
let navIndex = -1;

function rememberHash(hash) {
  if (navStack[navIndex] === hash) return;
  navStack.length = navIndex + 1;
  navStack.push(hash);
  navIndex = navStack.length - 1;
  updateNavButtons();
}

function updateNavButtons() {
  const back = $("nav-back");
  const fwd = $("nav-forward");
  if (back) back.disabled = navIndex <= 0;
  if (fwd) fwd.disabled = navIndex >= navStack.length - 1;
}

let currentSection = "";

async function go(page, section, opts) {
  const target = PAGES[page] ? page : "home";
  current = target;
  currentSection = section || "";
  const hash = "#/" + target + (currentSection ? "/" + currentSection : "");
  try {
    if (opts && opts.replace) {
      history.replaceState(null, "", hash);
    } else if (location.hash !== hash) {
      history.pushState(null, "", hash);
    }
  } catch (e) {
    location.hash = hash;
  }
  // 历史回退/前进时**不能**再 rememberHash：那会把栈截断再压一条新记录，
  // 于是"后退之后前进按钮亮不起来"（前进栈被自己冲掉了）。回退只会去找已有位置。
  if (opts && opts.fromHistory) {
    var at = -1;
    if (opts.index !== undefined && opts.index >= 0) {
      at = opts.index;
    } else {
      at = navStack.lastIndexOf(hash);
    }
    if (at >= 0) navIndex = at;
    updateNavButtons();
  } else {
    rememberHash(hash);
  }
  // 把"这一格在访问栈里的位置"写进 history.state：光比 URL 分不出同一地址出现过两次
  try { history.replaceState({ i: navIndex }, "", location.href); } catch (e) { /* 忽略 */ }
  // 「会话总览」是对话页里的列表视图，不是对话框：标题栏与主区都要正常显示
  if (target !== "chat" || currentSection === "overview") setChatMode(false);
  buildNav();
  const meta = PAGE_META[target];
  $("page-title").textContent = meta.title;
  $("page-sub").textContent = meta.sub;
  const ta = $("top-actions");
  ta.innerHTML = "";
  if (meta.actions) for (const a of meta.actions()) ta.appendChild(a);
  const v = $("view");
  v.innerHTML = '<div class="empty inline"><span class="spinner"></span> 加载中…</div>';
  // 真正滚动的是 #view（.main 是 overflow:hidden）。此前重置的是 .main，等于没重置，
  // 于是从长页面切到别的页面会停在半截。就地更新（例如标记已读）则刻意不调用 go()，保住阅读位置。
  v.scrollTop = 0;
  try {
    // 第二层面板先渲染：它决定这一层的"目录"长什么样（章节 / 笔记 / 产物 / 会话…）
    await renderPanel();
  } catch (e) {
    $("panel-body").innerHTML = '<div class="panel-empty">面板没能加载：' + esc(e.message) + "</div>";
  }
  try {
    await PAGES[target].render();
  } catch (e) {
    v.innerHTML = "";
    v.appendChild(emptyState({
      art: "alert",
      title: "这一页没能加载出来",
      text: e.message,
      actions: [btn("重试", "primary", () => go(target, currentSection))],
    }));
  }
  buildNav();
  updateNavButtons();
  if (opts && opts.focus) focusInView(opts.focus);
}

/** 面板里点过的条目：滚到主区对应位置并闪一下描边，不弹窗、不跳页。 */
function focusInView(id) {
  const node = document.querySelector('#view [data-id="' + String(id).replace(/"/g, '\\"') + '"]');
  if (!node) return;
  node.classList.add("focus-ring");
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  setTimeout(() => node.classList.remove("focus-ring"), 2600);
}

const PAGES = {};

/* ---------- 我的学习 ---------- */

PAGES.home = {
  async render() {
    await loadOverview();
    const v = $("view");
    v.innerHTML = "";
    const kbs = state.cfg.knowledgeBases;
    const idx = indexedKb();

    /* 第一屏：我是谁、现在该干什么 */
    const hero = el("div", "card hero");
    const main = el("div", "hero-main");
    main.appendChild(el("h2", "hero-title",
      (state.profile.nickname ? state.profile.nickname + "，" : "") + "今天从哪一段开始？"));
    main.appendChild(el("p", "hero-sub", state.profile.goal
      ? "学习目标：" + state.profile.goal + (state.profile.weeklyHours ? " · 每周可投入 " + state.profile.weeklyHours + " 小时" : "")
      : "还没有写学习目标。到设置里补一句，首页建议会跟着变。"));
    const chips = el("div", "meta");
    chips.appendChild(tag(state.cfg.models.length ? "模型 " + state.cfg.models.length + " 个" : "未配置模型", state.cfg.models.length ? "" : "warn"));
    chips.appendChild(tag(kbs.length ? "知识库 " + kbs.length + " 个" : "未指定资料目录", kbs.length ? "" : "warn"));
    chips.appendChild(tag("产物 " + state.artifacts.length + " 份"));
    if (state.cfg.embedModelId) chips.appendChild(tag("向量检索已启用", "ok"));
    else chips.appendChild(tag("关键词检索（未绑向量模型）"));
    main.appendChild(chips);
    hero.appendChild(main);

    const heroAct = el("div", "hero-actions");
    if (!hasChatModel()) {
      heroAct.appendChild(btn("配置模型接口", "primary", () => go("models")));
      heroAct.appendChild(btn("先看看资料目录", "", () => go("settings", "kb")));
    } else if (!idx) {
      heroAct.appendChild(btn("建立知识库索引", "primary", () => go("settings", "kb")));
      heroAct.appendChild(btn("先和助手聊聊", "", () => go("chat")));
    } else {
      heroAct.appendChild(btn("继续学习", "primary", () => continueStudy()));
      heroAct.appendChild(btn("生成讲义", "", () => go("learn")));
      heroAct.appendChild(btn("问助手", "", () => go("chat")));
    }
    hero.appendChild(heroAct);
    v.appendChild(hero);

    /* 第二屏：首次使用清单 */
    const steps = checklist();
    const doneCount = steps.filter((s) => s.done).length;
    if (doneCount === steps.length) {
      const ok = cardOf({
        title: "环境已就绪",
        tag: doneCount + " / " + steps.length,
        tagCls: "ok",
        body: (() => {
          const wrap = el("div");
          wrap.appendChild(el("p", "muted", "模型、资料、索引、问答、产物五个环节都跑通了。接下来只管内容：读、练、生成。"));
          const row = el("div", "row");
          row.appendChild(btn("去学 · 练", "primary", () => go("learn")));
          row.appendChild(btn("看我的资源", "", () => go("resources")));
          wrap.appendChild(row);
          return wrap;
        })(),
      });
      v.appendChild(ok);
    } else {
      const body = el("div", "checklist");
      // 一列五个绿按钮太吵：只有"现在就该做的那一步"用主色
      const firstOpen = steps.filter((x) => !x.done)[0];
      steps.forEach((s, i) => {
        const item = el("div", "check-item" + (s.done ? " done" : ""));
        item.appendChild(el("div", "idx", s.done ? "✓" : String(i + 1)));
        const txt = el("div", "txt");
        txt.appendChild(el("b", null, s.title));
        txt.appendChild(el("span", null, s.text));
        item.appendChild(txt);
        if (!s.done) item.appendChild(btn(s.act, "sm" + (s === firstOpen ? " primary" : ""), s.go));
        else item.appendChild(tag("已完成", "ok"));
        body.appendChild(item);
      });
      v.appendChild(cardOf({
        title: "开始使用（还剩 " + (steps.length - doneCount) + " 步）",
        body,
      }));
    }

    /* 第三屏：今日建议 */
    const sug = el("div", "card");
    sug.innerHTML = '<div class="card-head"><h2>今日建议</h2><div class="spacer"></div><span class="card-sub">依据你的进度自动挑的下一章</span></div>';
    if (!idx) {
      sug.appendChild(emptyState({
        art: "db",
        title: hasKb() ? "知识库还没有索引" : "还没有可学的章节",
        text: hasKb()
          ? "「" + kbName(state.kb) + "」已登记目录但还没建索引，建立索引后才会出现章节。"
          : "先指定一个本机资料目录并建立索引，这里就会出现章节进度和下一步动作。",
        actions: [btn(hasKb() ? "去建立索引" : "去指定资料目录", "primary", () => go("settings", "kb")),
                  btn("看看模型配置", "", () => go("models"))],
      }));
    } else {
      try {
        const tree = await api("/api/study/tree", { kbId: state.kb });
        const next = (tree.chapters || []).find((c) => !c.done);
        if (!next) {
          sug.appendChild(emptyState({
            art: "check",
            title: "这一轮的章节都读完了",
            text: "共计 " + tree.chapters.length + " 章 / " + tree.chunkCount + " 片。可以出题巩固，或者生成整章讲义沉淀下来。",
            actions: [btn("出题巩固", "primary", () => openQuiz($("view"), (tree.chapters[0] || {}).name || "")),
                      btn("挑一章生成讲义", "", () => go("learn")),
                      btn("看我的资源", "", () => go("resources"))],
          }));
        } else {
          const p = pct(next.readCount, next.chunkCount);
          const box = el("div");
          box.appendChild(el("div", "item-title", next.name));
          box.appendChild(el("div", "meta", next.chunkCount + " 片 · " + next.sectionCount + " 个小节 · " + next.docCount + " 篇文档 · 已读 " + next.readCount + " 片"));
          const bar = el("div", "bar");
          bar.innerHTML = '<i style="width:' + p + '%"></i>';
          box.appendChild(bar);
          const row = el("div", "row");
          row.style.marginTop = "12px";
          row.appendChild(btn("继续学这一章", "primary", () => { state.chapter = next.name; go("learn"); }));
          row.appendChild(btn("出题练习", "", () => openQuiz(box, next.name)));
          row.appendChild(btn("生成讲义", "", () => askTopic("lecture", next.name)));
          row.appendChild(btn("写一条笔记", "", () => openNoteEditor(null, state.kb, next.name)));
          box.appendChild(row);
          sug.appendChild(box);
        }
      } catch (e) {
        sug.appendChild(emptyState({ art: "alert", title: "读取章节失败", text: e.message, actions: [btn("重试", "", () => go("home"))] }));
      }
    }
    v.appendChild(sug);

    /* 第三屏半：学习网络图（从真实学习状态算出来的，每次进首页重算） */
    v.appendChild(await graphCard());

    /* 第四屏：概览 + 最近产物 */
    const r = state.report;
    const grid = el("div", "grid grid-4");
    grid.appendChild(statCard("已读切片", r.readChunks || 0, "", () => go("report")));
    grid.appendChild(statCard("完成章节", r.completedChapters || 0, "", () => go("report")));
    grid.appendChild(statCard("笔记", r.noteCount || 0, "条", () => go("notes")));
    grid.appendChild(statCard("答题正确率", r.quizTotal ? pct(r.quizRight, r.quizTotal) : 0, "%", () => go("wrong")));
    v.appendChild(grid);

    const recent = el("div", "card");
    recent.innerHTML = '<div class="card-head"><h2>最近产物</h2><div class="spacer"></div><span class="card-sub">讲义与练习都落在本机 artifacts 目录</span></div>';
    if (!state.artifacts.length) {
      recent.appendChild(emptyState({
        inline: true,
        art: "layers",
        title: "还没有产物",
        text: "在「学 · 练」里挑一章，点「生成讲义」或「生成练习册」，产出会出现在这里。",
        actions: [btn("去生成", "primary", () => go("learn"))],
      }));
    } else {
      const list = el("div", "list");
      for (const a of state.artifacts.slice(0, 4)) {
        list.appendChild(artifactItem(a, false));
      }
      recent.appendChild(list);
      if (state.artifacts.length > 4) {
        recent.appendChild(btn("查看全部 " + state.artifacts.length + " 份", "ghost sm", () => go("resources")));
      }
    }
    v.appendChild(recent);
  },
};

async function continueStudy() {
  try {
    const tree = await api("/api/study/tree", { kbId: state.kb });
    const next = (tree.chapters || []).find((c) => !c.done);
    state.chapter = next ? next.name : ((tree.chapters[0] || {}).name || null);
  } catch (e) {
    state.chapter = null;
  }
  go("learn");
}

/* ---------- 学 · 练 ---------- */


/* ============================================================
   学习网络图（首页第三屏半）
   ------------------------------------------------------------
   三句设计说明：
   1. 不引三方库（桌面版前端只有三个白名单文件），用 canvas 2D 自己做透视投影；
   2. 每次进首页按**当前学习状态**重算：节点=章节（大小=切片数、颜色=进度），
      笔记/错题/产物挂在章节上，所以学完一章、做错一题，图自己就变；
   3. 有节制：>200 个章节只画主干并明说"折叠了多少"；切页就停渲染；
      prefers-reduced-motion 不自动旋转。
   ============================================================ */

const graphView = {
  canvas: null,
  raf: 0,
  spin: true,
  yaw: 0.6,
  pitch: -0.32,
  zoom: 1,
  vYaw: 0,
  vPitch: 0,
  drag: null,
  filter: "all",
  selected: "",
  hover: "",
  nodes: [],
  edges: [],
  folded: 0,
  data: null,
  pulse: 0,
};

/** 拉一次图数据；首页每次渲染都会调，所以"图会跟着学习状态变"。 */
async function graphCard() {
  const card = el("div", "card graph-card");
  const head = el("div", "card-head");
  head.appendChild(el("h2", null, "学习网络"));
  head.appendChild(spacer());
  const stat = el("span", "card-sub", "");
  head.appendChild(stat);
  const fullBtn = btn("全屏", "sm ghost", () => toggleGraphFull());
  head.appendChild(fullBtn);
  card.appendChild(head);

  let data = null;
  try {
    data = await api("/api/graph", { kbId: state.kb });
  } catch (e) {
    card.appendChild(emptyState({
      art: "alert",
      title: "算不出学习网络",
      text: e.message,
      actions: [btn("重试", "primary", () => go("home"))],
    }));
    return card;
  }
  if (!data || data.empty) {
    // 没索引就不画空图：给一条能走下去的路
    card.appendChild(emptyState({
      art: "db",
      title: "还没有可画的章节",
      text: (data && data.reason ? data.reason + "。" : "") + "指定资料目录并建立索引后，这里会按章节长出一张能点、能转的图。",
      actions: [btn("去指定资料目录", "primary", () => go("settings", "kb")),
                btn("去建立索引", "", () => { if (state.kb) buildIndex(state.kb); else go("settings", "kb"); })],
    }));
    return card;
  }

  graphView.data = data;
  graphView.folded = data.folded || 0;
  graphView.selected = "";
  graphView.hover = "";
  graphView.filter = "all";
  graphView.yaw = 0.6;
  graphView.pitch = -0.32;
  graphView.zoom = 1;
  graphView.vYaw = 0;
  graphView.vPitch = 0;
  // 布局直接改这两个数组里的坐标；graphView 持有它们，渲染与自检都读同一份
  graphView.nodes = data.nodes || [];
  graphView.edges = data.edges || [];
  layoutGraph(graphView.nodes, graphView.edges);

  const body = el("div", "graph-body");
  const canvas = el("canvas", "graph-canvas");
  canvas.width = 1200;
  canvas.height = 380;
  body.appendChild(canvas);
  const side = el("div", "graph-side");
  side.hidden = true;
  body.appendChild(side);
  const tools = el("div", "graph-tools");
  const filters = [["all", "全部"], ["reading", "只在读"], ["wrong", "只看错题"], ["artifact", "只看产物"]];
  for (const [k, label] of filters) {
    const b = el("button", "seg-item" + (k === "all" ? " active" : ""), label);
    b.dataset.filter = k;
    b.onclick = () => {
      graphView.filter = k;
      for (const x of tools.querySelectorAll("[data-filter]")) x.classList.toggle("active", x.dataset.filter === k);
      graphView.selected = "";
      side.hidden = true;
    };
    tools.appendChild(b);
  }
  const reset = btn("回到全图", "sm ghost", () => {
    graphView.yaw = 0.6;
    graphView.pitch = -0.32;
    graphView.zoom = 1;
    graphView.vYaw = 0;
    graphView.vPitch = 0;
    graphView.filter = "all";
    for (const x of tools.querySelectorAll("[data-filter]")) x.classList.toggle("active", x.dataset.filter === "all");
    graphView.selected = "";
    side.hidden = true;
  });
  tools.appendChild(reset);
  const hint = el("span", "muted sm graph-hint", "拖动旋转 · 滚轮缩放 · 点节点看细节");
  tools.appendChild(hint);
  body.appendChild(tools);
  card.appendChild(body);
  stat.textContent = "章节 " + (data.stats ? data.stats.chapters : graphView.nodes.length) +
    (graphView.folded > 0 ? "（只画主干，已折叠 " + graphView.folded + " 个）" : "") +
    " · 笔记 " + ((data.stats && data.stats.notes) || 0) + " · 已读切片 " + ((data.stats && data.stats.readChunks) || 0);

  attachGraphControls(canvas, side);
  startGraphLoop(canvas, side, tools);
  canvas.dataset.nodes = String(graphView.nodes.length);
  // 自检接缝：给一个章节名，返回它在画布上的像素坐标。
  // 自动化点节点不必去猜坐标，也顺便让"图上这个点对应哪一章"这件事可查。
  window.itnGraphPick = (name) => {
    const n = graphView.nodes.find((x) => x.id === name);
    if (!n) return null;
    const pr = graphProject(n, canvas.width, canvas.height, graphView);
    return { x: pr.x, y: pr.y, w: canvas.width, h: canvas.height, nodes: graphView.nodes.length };
  };
  // 全屏状态是挂在 card 上的，重渲染后要保持
  if (document.body.classList.contains("graph-full")) card.classList.add("full");
  return card;
}

/* ---------- 3D 位置：球面螺旋打底 + 一点斥力，够用就好 ---------- */
function layoutGraph(nodes, edges) {
  const n = nodes.length;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i += 1) {
    const t = (i + 0.5) / n;
    const y = 1 - 2 * t;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    const node = nodes[i];
    node.x = Math.cos(th) * r;
    node.y = y;
    node.z = Math.sin(th) * r;
    // 切片多的往外站一点：视觉上"主干更大"，也避免小章节被挤在中间
    const w = 0.72 + Math.min(1, (node.chunkCount || 1) / 12) * 0.5;
    node.wgt = w;
    node.x *= w;
    node.y *= w;
    node.z *= w;
  }
  // 只给最大的若干节点写标签：全写会糊成一片
  const bySize = nodes.slice().sort((x, y) => (y.chunkCount || 0) - (x.chunkCount || 0));
  bySize.forEach((x, i) => { x.big = i < 12; });

  // 连边当弹簧拉几下：不追求漂亮布局，只求"相连的章节离得近"
  const idx = {};
  nodes.forEach((x, i) => { idx[x.id] = i; });
  const links = edges.map((e) => [idx[e.from], idx[e.to]]).filter(([a, b]) => a !== undefined && b !== undefined);
  for (let it = 0; it < 30; it += 1) {
    for (const [a, b] of links) {
      const na = nodes[a];
      const nb = nodes[b];
      const dx = nb.x - na.x;
      const dy = nb.y - na.y;
      const dz = nb.z - na.z;
      const d = Math.max(0.08, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const push = (d - 0.9) * 0.05;
      na.x += (dx / d) * push; na.y += (dy / d) * push; na.z += (dz / d) * push;
      nb.x -= (dx / d) * push; nb.y -= (dy / d) * push; nb.z -= (dz / d) * push;
    }
    // 每轮往球壳上拉一把：只靠弹簧会把小图挤成一条线
    for (const n of nodes) {
      const d = Math.max(1e-6, Math.hypot(n.x, n.y, n.z));
      const f = (n.wgt || 0.9) / d;
      n.x *= f;
      n.y *= f;
      n.z *= f;
    }
  }
}

/**
 * 透视投影：简单到不能再简单——先绕 y 轴转、再绕 x 轴转，最后除以深度。
 * k 是"单位长度在屏幕上多少像素"：球半径 1 ≈ 画布短边的 28%，远近差由 depth 决定。
 */
const GRAPH_CAM = 3.6;
function graphProject(p, w, h, gv) {
  const cy = Math.cos(gv.yaw);
  const sy = Math.sin(gv.yaw);
  const cp = Math.cos(gv.pitch);
  const sp = Math.sin(gv.pitch);
  let x = p.x * cy - p.z * sy;
  let z = p.x * sy + p.z * cy;
  let y = p.y * cp - z * sp;
  z = p.y * sp + z * cp;
  const depth = GRAPH_CAM + z;
  const k = (Math.min(w, h) * 1.15 * gv.zoom) / Math.max(0.6, depth);
  return { x: w / 2 + x * k, y: h / 2 + y * k, k: k, z: depth };
}

/** 节点半径：切片越多越大；再按当前缩放等比例缩，避免远处一堆大圆。 */
function graphNodeRadius(n, pr) {
  const base = Math.max(4, Math.min(20, 4 + Math.sqrt(n.chunkCount || 1) * 2.6));
  return base * ((pr.k || 120) / 120);
}

function graphNodeVisible(node) {
  const f = graphView.filter;
  if (f === "all") return true;
  if (f === "reading") return node.status === "reading" || node.status === "todo";
  if (f === "wrong") return (node.wrong || 0) > 0;
  if (f === "artifact") return (node.artifacts || []).length > 0;
  return true;
}

function graphColor(node) {
  if (node.status === "done") return "#2f7053";
  if (node.status === "reading") return "#4f9a74";
  return "#b9c3bd";
}

function startGraphLoop(canvas, side, tools) {
  const gv = graphView;
  gv.canvas = canvas;
  const ctx = canvas.getContext("2d");
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const fit = () => {
    const cw = Math.max(320, Math.round(canvas.clientWidth * dpr));
    const ch = Math.max(240, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
  };
  const frame = () => {
    // 切页/重渲染后这个 canvas 就脱离文档了：自己停下，不做后台空转
    if (!canvas.isConnected) { gv.raf = 0; return; }
    fit();
    const w = canvas.width;
    const h = canvas.height;
    if (!gv.drag) {
      gv.yaw += gv.vYaw;
      gv.pitch += gv.vPitch;
      gv.vYaw *= 0.94;
      gv.vPitch *= 0.94;
      if (!reduce && gv.spin && !gv.selected) gv.yaw += 0.0016;
    }
    gv.pulse = (gv.pulse + 0.05) % (Math.PI * 2);
    ctx.clearRect(0, 0, w, h);
    const proj = new Map();
    for (const n of gv.nodes) {
      proj.set(n.id, graphProject(n, w, h, gv));
    }
    // 连边
    for (const e of gv.edges) {
      const a = proj.get(e.from);
      const b = proj.get(e.to);
      if (!a || !b) continue;
      const dim = !graphNodeVisible(gv.nodes.find((x) => x.id === e.from)) || !graphNodeVisible(gv.nodes.find((x) => x.id === e.to));
      ctx.strokeStyle = dim ? "rgba(140,150,145,.10)" : "rgba(47,112,83," + (0.10 + e.weight * 0.35).toFixed(3) + ")";
      ctx.lineWidth = (1 + Math.min(3, e.weight * 4)) * dpr;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    // 节点：先按深度排序，远的先画（伪遮挡）
    const order = gv.nodes.slice().sort((p1, p2) => (proj.get(p2.id).z - proj.get(p1.id).z));
    for (const n of order) {
      const p = proj.get(n.id);
      const vis = graphNodeVisible(n);
      const alpha = vis ? 1 : 0.25;
      const r = graphNodeRadius(n, p);
      const isSel = gv.selected === n.id;
      const isHover = gv.hover === n.id;
      ctx.globalAlpha = alpha;
      // 笔记：节点外圈的小点
      const notes = Math.min(6, n.notes || 0);
      for (let i = 0; i < notes; i += 1) {
        const ang = (i / notes) * Math.PI * 2;
        ctx.fillStyle = "#8a9a90";
        ctx.beginPath();
        ctx.arc(p.x + Math.cos(ang) * (r + 5 * dpr), p.y + Math.sin(ang) * (r + 5 * dpr), 1.8 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
      // 产物：两侧的方点（讲义=绿、练习=琥珀）
      (n.artifacts || []).slice(0, 4).forEach((a, i) => {
        ctx.fillStyle = a.kind === "lecture" ? "#2f7053" : "#b9762a";
        const bx = p.x - r - 6 * dpr;
        const by = p.y - 5 * dpr + i * 6 * dpr;
        ctx.fillRect(bx, by, 4 * dpr, 4 * dpr);
      });
      ctx.fillStyle = graphColor(n);
      ctx.globalAlpha = alpha * (isSel ? 1 : isHover ? 0.95 : 0.88);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (isSel || isHover) {
        ctx.strokeStyle = "#2f7053";
        ctx.lineWidth = 2 * dpr;
        ctx.stroke();
      }
      // 错题：红点；今天该复习的脉冲
      if ((n.wrong || 0) > 0) {
        const pulse = (n.wrongDue || 0) > 0 ? 1 + 0.5 * (1 + Math.sin(gv.pulse)) : 1;
        ctx.fillStyle = (n.wrongDue || 0) > 0 ? "#b0443b" : "rgba(176,68,59,.55)";
        ctx.beginPath();
        ctx.arc(p.x + r + 3 * dpr, p.y - r - 2 * dpr, 2.6 * dpr * pulse, 0, Math.PI * 2);
        ctx.fill();
      }
      // 标签：只给最大的若干个 + 选中的/悬停的，免得糊成一片
      if (n.big || isSel || isHover) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = "#3a4640";
        ctx.font = Math.round(11 * dpr) + "px -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif";
        ctx.fillText(String(n.name).slice(0, 14), p.x + r + 4 * dpr, p.y + 3 * dpr);
      }
      ctx.globalAlpha = 1;
    }
  };
  const loop = () => {
    frame();
    if (!canvas.isConnected) { gv.raf = 0; return; }
    gv.raf = requestAnimationFrame(loop);
  };
  if (gv.raf) cancelAnimationFrame(gv.raf);
  gv.raf = requestAnimationFrame(loop);
}

/** 鼠标/触摸：拖动转、滚轮缩放、点击选节点（带惯性）。 */
function attachGraphControls(canvas, side) {
  const gv = graphView;
  const hit = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const y = (ev.clientY - rect.top) * (canvas.height / rect.height);
    let best = null;
    let bestD = 1e9;
    for (const n of gv.nodes) {
      const p = graphProject(n, canvas.width, canvas.height, gv);
      const r = graphNodeRadius(n, p);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < r + 4 && d < bestD) { bestD = d; best = n; }
    }
    return best;
  };
  canvas.onpointerdown = (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    gv.drag = { x: ev.clientX, y: ev.clientY, moved: 0 };
    gv.vYaw = 0;
    gv.vPitch = 0;
  };
  canvas.onpointermove = (ev) => {
    if (gv.drag) {
      const dx = ev.clientX - gv.drag.x;
      const dy = ev.clientY - gv.drag.y;
      gv.drag.x = ev.clientX;
      gv.drag.y = ev.clientY;
      gv.drag.moved += Math.abs(dx) + Math.abs(dy);
      gv.yaw += dx * 0.006;
      gv.pitch = Math.max(-1.3, Math.min(1.3, gv.pitch + dy * 0.006));
      gv.vYaw = dx * 0.0016;
      gv.vPitch = dy * 0.0016;
      return;
    }
    const n = hit(ev);
    gv.hover = n ? n.id : "";
    canvas.style.cursor = n ? "pointer" : "grab";
  };
  canvas.onpointerup = (ev) => {
    const moved = gv.drag ? gv.drag.moved : 0;
    gv.drag = null;
    if (moved > 6) return; // 拖动结束不算点击
    const n = hit(ev);
    if (!n) {
      gv.selected = "";
      side.hidden = true;
      return;
    }
    gv.selected = n.id;
    paintGraphSide(side, n);
  };
  canvas.onpointerleave = () => { gv.hover = ""; };
  canvas.onwheel = (ev) => {
    ev.preventDefault();
    gv.zoom = Math.max(0.45, Math.min(3.2, gv.zoom * (ev.deltaY > 0 ? 0.9 : 1.1)));
  };
}

/** 点节点后的侧卡：这一章学到哪了 + 能直接做的三件事。 */
function paintGraphSide(side, n) {
  side.innerHTML = "";
  side.hidden = false;
  side.appendChild(el("div", "graph-side-title", n.name));
  const rows = [
    ["进度", (n.readCount || 0) + " / " + (n.chunkCount || 0) + " 片" + (n.done ? "（已完成）" : "")],
    ["小节", (n.sectionCount || 0) + " 节 · " + (n.docCount || 0) + " 篇文档"],
  ];
  if (n.notes) rows.push(["笔记", n.notes + " 条"]);
  if (n.wrong) rows.push(["错题", n.wrong + " 条" + ((n.wrongDue || 0) > 0 ? "（今天该重做 " + n.wrongDue + "）" : "")]);
  if ((n.artifacts || []).length) rows.push(["产物", n.artifacts.map((a) => a.name).join("、")]);
  for (const [k, v] of rows) {
    const line = el("div", "graph-side-row");
    line.appendChild(el("span", "k", k));
    line.appendChild(el("span", "v", String(v)));
    side.appendChild(line);
  }
  const acts = el("div", "row graph-side-acts");
  acts.appendChild(btn("继续学", "sm primary", () => { state.chapter = n.name; go("learn"); }));
  acts.appendChild(btn("出练习", "sm", () => { go("learn"); setTimeout(() => openQuiz($("view"), n.name), 200); }));
  acts.appendChild(btn("生成讲义", "sm", () => { go("learn"); setTimeout(() => askTopic("lecture", n.name), 200); }));
  side.appendChild(acts);
}

/** 全屏展开：卡片铺满主区，图更大。 */
function toggleGraphFull() {
  const card = document.querySelector(".graph-card");
  if (!card) return;
  const on = !document.body.classList.contains("graph-full");
  document.body.classList.toggle("graph-full", on);
  card.classList.toggle("full", on);
  const cv = card.querySelector("canvas");
  if (cv) {
    cv.height = on ? 900 : 380;
  }
  const b = card.querySelector(".card-head .btn:last-child");
  if (b) b.textContent = on ? "退出全屏" : "全屏";
}

PAGES.learn = {
  async render() {
    await loadCfg();
    const v = $("view");
    v.innerHTML = "";
    if (!hasKb()) {
      v.appendChild(cardOf({
        body: emptyState({
          art: "db",
          title: "还没有知识库",
          text: "桌面版只读你本机的资料。指定一个目录、建立一次索引，之后读讲义、出题、生成文档都从这份资料出发。",
          actions: [btn("去指定资料目录", "primary", () => go("settings", "kb")),
                    btn("先配置模型", "", () => go("models"))],
        }),
      }));
      return;
    }

    const head = el("div", "card");
    const row = el("div", "row");
    row.appendChild(kbSelector(() => { state.chapter = null; go("learn"); }));
    const info = el("div", "muted sm grow");
    const k = state.cfg.knowledgeBases.find((x) => x.id === state.kb) || {};
    info.textContent = (k.chunkCount || 0) > 0
      ? (k.docCount || 0) + " 篇 · " + k.chunkCount + " 片 · " + (k.imageCount || 0) + " 张图 · 索引于 " + fmtStamp(k.builtAt)
      : "这个知识库还没有索引，先建立索引。";
    row.appendChild(info);
    if ((k.chunkCount || 0) > 0) {
      row.appendChild(btn("重建索引", "sm", () => buildIndex(state.kb)));
      row.appendChild(btn("去检索", "sm ghost", () => go("kb")));
    } else {
      row.appendChild(btn("建立索引", "sm primary", () => buildIndex(state.kb)));
    }
    head.appendChild(row);
    v.appendChild(head);

    if (!state.chapter) {
      await renderChapterTree(v);
      return;
    }
    await renderChapter(v);
  },
};

function kbSelector(onChange) {
  const sel = el("select");
  for (const kb of state.cfg.knowledgeBases) {
    sel.appendChild(option(kb.id, kb.name || kb.id));
  }
  sel.value = state.kb;
  sel.onchange = () => {
    state.kb = sel.value;
    state.chapter = null;
    if (onChange) onChange();
  };
  return sel;
}

async function renderChapterTree(v) {
  const tree = await api("/api/study/tree", { kbId: state.kb });
  const chapters = tree.chapters || [];
  const card = cardOf({
    title: "知识库目录",
    sub: "按 Markdown 标题自动分章",
    tag: chapters.length + " 章 · " + tree.chunkCount + " 片",
  });
  if (!chapters.length) {
    card.appendChild(emptyState({
      art: "alert",
      title: "没有解析出章节",
      text: (state.cfg.knowledgeBases.find((x) => x.id === state.kb) || {}).chunkCount
        ? "索引里有切片，但没有标题层级。给资料加上 # / ## 标题会更整齐。"
        : "这个目录里没有 Markdown 或纯文本文件，或者还没建立索引。",
      actions: [btn("重新建立索引", "primary", () => buildIndex(state.kb)),
                btn("换一个目录", "", () => go("settings", "kb"))],
    }));
    v.appendChild(card);
    return;
  }
  const list = el("div", "list");
  chapters.forEach((c, i) => {
    const it = el("div", "item clickable");
    const p = pct(c.readCount, c.chunkCount);
    const top = el("div", "row");
    const dot = el("div", "chapter-idx", String(i + 1).padStart(2, "0"));
    const main = el("div", "grow");
    it.dataset.id = c.name;
    main.appendChild(el("div", "item-title", c.name));
    main.appendChild(el("div", "meta", c.sectionCount + " 小节 · " + c.chunkCount + " 片 · " + c.docCount + " 篇文档 · 已读 " + c.readCount));
    top.appendChild(dot);
    top.appendChild(main);
    top.appendChild(c.done ? tag("已完成", "ok") : tag(p + "%"));
    it.appendChild(top);
    const bar = el("div", "bar");
    bar.innerHTML = '<i style="width:' + p + '%"></i>';
    it.appendChild(bar);
    const acts = el("div", "row item-actions");
    acts.appendChild(btn("开始学", "sm primary", () => { state.chapter = c.name; go("learn"); }));
    acts.appendChild(btn("出题练习", "sm", () => openQuiz(v, c.name)));
    acts.appendChild(btn("生成讲义", "sm", () => askTopic("lecture", c.name)));
    acts.appendChild(btn("生成练习册", "sm", () => askTopic("quiz", c.name)));
    it.appendChild(acts);
    it.onclick = (ev) => {
      if (ev.target.closest("button")) return;
      state.chapter = c.name;
      go("learn");
    };
    list.appendChild(it);
  });
  card.appendChild(list);
  v.appendChild(card);

  v.appendChild(cardOf({
    title: "还能做什么",
    body: (() => {
      const wrap = el("div", "row");
      wrap.appendChild(btn("把整章做成讲义", "", () => askTopic("lecture", (tree.chapters[0] || {}).name || "")));
      wrap.appendChild(btn("问助手一个问题", "", () => go("chat")));
      wrap.appendChild(btn("看检索效果", "", () => go("kb")));
      return wrap;
    })(),
  }));
}

async function renderChapter(v) {
  const chap = await api("/api/study/chapter", { kbId: state.kb, chapter: state.chapter });
  const chunks = chap.chunks || [];
  const readCount = chunks.filter((c) => c.read).length;
  const bar = el("div", "card");
  const head = el("div", "card-head");
  head.appendChild(btn("← 返回目录", "ghost sm", () => { state.chapter = null; go("learn"); }));
  head.appendChild(el("h2", null, state.chapter));
  head.appendChild(spacer());
  const headTag = tag(readCount + " / " + chunks.length + " 片已读", readCount === chunks.length && chunks.length ? "ok" : "");
  head.appendChild(headTag);
  // 学 · 练 的一章就是一个"学习单元"：讲 → 练 → 记 → 完成。
  // 四步是否完成全部由真实记录判定（切片已读、本章答题、本章笔记、章节完成标记），
  // 不存"向导进度"这种东西，也就不会出现"界面说你做完了但记录是空的"。
  const [statRes, noteRes, treeRes] = await Promise.all([
    api("/api/study/quiz/stats", {}).catch(() => ({ chapters: [] })),
    api("/api/study/notes/list", {}).catch(() => ({ notes: [] })),
    api("/api/study/tree", { kbId: state.kb }).catch(() => ({ chapters: [] })),
  ]);
  const stat = ((statRes.chapters || []).filter((x) => x.chapter === state.chapter && x.kbId === state.kb)[0]) ||
    { total: 0, right: 0, wrong: 0 };
  const chapterNotes = (noteRes.notes || []).filter((n) => n.chapter === state.chapter);
  const chapterMeta = ((treeRes.chapters || []).filter((c) => c.name === state.chapter)[0]) || {};
  const markAllRead = async () => {
    for (const c of chunks) {
      if (c.read) continue;
      await api("/api/study/read", { kbId: state.kb, chunkId: c.id, chapter: state.chapter, chapterDone: true });
    }
    toast("已标记本章完成，回目录挑下一章");
    state.chapter = null;
    go("learn");
  };

  bar.appendChild(head);
  const prog = el("div", "bar");
  prog.innerHTML = '<i style="width:' + pct(readCount, chunks.length) + '%"></i>';
  prog.style.marginTop = "12px";
  bar.appendChild(prog);
  v.appendChild(bar);
  const progFill = prog.querySelector("i");

  /**
   * 就地刷新"已读进度"，不重渲染整页。
   *
   * 之前每标记一片就 go("learn") 重渲染，页面跳回顶部——一章几十片，读着读着就找不到位置了。
   * 阅读类操作必须保住滚动位置，所以这里只改该改的那几个节点。
   */
  const refreshReadProgress = () => {
    const n = chunks.filter((c) => c.read).length;
    headTag.textContent = n + " / " + chunks.length + " 片已读";
    headTag.className = "tag" + (n === chunks.length && chunks.length ? " ok" : "");
    if (progFill) progFill.style.width = pct(n, chunks.length) + "%";
    const step1 = unit.querySelector(".unit-step");
    if (step1) step1.classList.toggle("done", n > 0);
    const desc1 = step1 ? step1.querySelector(".unit-desc") : null;
    if (desc1) desc1.textContent = "按节翻一遍本章：已读 " + n + " / " + chunks.length + " 片";
    const unitTag = unit.querySelector(".card-head .tag");
    if (unitTag) unitTag.textContent = "已完成 " + unit.querySelectorAll(".unit-step.done").length + " / 4";
  };

  const steps = [
    {
      n: 1, title: "讲一遍", done: readCount > 0,
      desc: "按节翻一遍本章：已读 " + readCount + " / " + chunks.length + " 片",
      acts: [btn("按节播放", "primary sm", () => playChapter(state.chapter)),
             btn("整章标记已读", "sm ghost", markAllRead)],
    },
    {
      n: 2, title: "练一组", done: stat.total > 0,
      desc: stat.total > 0 ? ("本章已答 " + stat.total + " 题 · 对 " + stat.right + " · 错 " + stat.wrong)
                          : "还没有针对本章的作答记录",
      acts: [btn("出题练习", "primary sm", () => openQuiz(v, state.chapter)),
             btn("错题本", "sm ghost", () => go("wrong"))],
    },
    {
      n: 3, title: "记一条", done: chapterNotes.length > 0,
      desc: chapterNotes.length > 0 ? ("本章已有 " + chapterNotes.length + " 条笔记") : "把这一章的想法留下来",
      acts: [btn("写笔记", "primary sm", () => openNoteEditor(null, state.kb, state.chapter)),
             btn("全部笔记", "sm ghost", () => go("notes"))],
    },
    {
      n: 4, title: "完成本章", done: !!chapterMeta.done,
      desc: chapterMeta.done ? "已标记完成，会记进学习报告" : "标记后这一章进学习报告，目录里也会标已完成",
      acts: [btn("标记本章完成", "primary sm", markAllRead)],
    },
  ];
  const doneCount = steps.filter((x) => x.done).length;
  const unit = cardOf({
    title: "学习单元 · " + state.chapter,
    sub: "讲 → 练 → 记 → 完成，每一步都按本机真实记录判定",
    tag: "已完成 " + doneCount + " / 4",
    tagCls: doneCount === 4 ? "ok" : "",
  });
  const strip = el("div", "unit-steps");
  for (const st of steps) {
    const item = el("div", "unit-step" + (st.done ? " done" : "") + (!st.done && st.n === doneCount + 1 ? " current" : ""));
    item.appendChild(el("div", "unit-idx", st.done ? "✓" : String(st.n)));
    const body = el("div", "unit-body");
    body.appendChild(el("div", "unit-title", st.title));
    body.appendChild(el("div", "unit-desc", st.desc));
    item.appendChild(body);
    const acts = el("div", "unit-acts");
    for (const b of st.acts) acts.appendChild(b);
    item.appendChild(acts);
    strip.appendChild(item);
  }
  unit.appendChild(strip);
  if (doneCount === 4) {
    unit.appendChild(el("p", "unit-done-note", "这一章走完了：讲、练、记、完成都在本机留了记录。可以生成一份讲义沉淀，或者回目录挑下一章。"));
  }
  v.appendChild(unit);

  v.appendChild(cardOf({
    title: "还能做什么",
    body: (() => {
      const row = el("div", "row");
      row.appendChild(btn("生成讲义", "", () => askTopic("lecture", state.chapter)));
      row.appendChild(btn("生成练习册", "", () => askTopic("quiz", state.chapter)));
      row.appendChild(btn("去检索这部分", "ghost", () => go("kb")));
      row.appendChild(btn("问助手", "ghost", () => go("chat")));
      return row;
    })(),
  }));

  for (const c of chunks) {
    const box = el("div", "card chunk-card");
    const ch = el("div", "card-head");
    ch.appendChild(el("h2", "sm muted", c.headingPath || c.docTitle));
    ch.appendChild(spacer());
    if (c.read) ch.appendChild(tag("已读", "ok"));
    box.appendChild(ch);
    const body = el("div");
    body.innerHTML = md(c.text);
    box.appendChild(body);
    if (c.caption) {
      const cap = el("p", "caption-note", "图片说明：" + c.caption);
      box.appendChild(cap);
    }
    const row = el("div", "row chunk-actions");
    let readTag = null;
    if (c.read) {
      // 已在卡头挂了"已读"标签，这里记住它，取消/恢复时一起改
      readTag = ch.querySelector(".tag");
    }
    const readBtn = btn(c.read ? "取消已读标记？重读一次" : "标记已读", "sm " + (c.read ? "ghost" : ""), async () => {
      const next = !c.read;
      await api("/api/study/read", { kbId: state.kb, chunkId: c.id, chapter: state.chapter });
      c.read = next;
      if (next) {
        if (!readTag) {
          readTag = tag("已读", "ok");
          ch.appendChild(readTag);
        }
        toast("已标记");
      } else {
        if (readTag) {
          readTag.remove();
          readTag = null;
        }
        toast("已取消标记");
      }
      readBtn.textContent = c.read ? "取消已读标记？重读一次" : "标记已读";
      readBtn.className = "btn sm " + (c.read ? "ghost" : "");
      refreshReadProgress();
    });
    row.appendChild(readBtn);
    row.appendChild(btn("就这段记笔记", "sm ghost", () => openNoteEditor(null, state.kb, state.chapter, c)));
    row.appendChild(btn("就这段提问", "sm ghost", () => askAboutChunk(c)));
    row.appendChild(btn("把这章做成讲义", "sm ghost", () => askTopic("lecture", state.chapter)));
    box.appendChild(row);
    v.appendChild(box);
  }
  if (!chunks.length) {
    v.appendChild(cardOf({ body: emptyState({ art: "alert", title: "这一章没有切片", text: "可能是索引过期了，重建一次再试。", actions: [btn("重建索引", "primary", () => buildIndex(state.kb))] }) }));
  }
}

async function askAboutChunk(chunk) {
  state.pendingQuestion = "请解释这段资料：" + String(chunk.headingPath || chunk.docTitle || "");
  go("chat");
}

/** 出题或生成讲义前先确认主题（默认取章节名）。 */
function askTopic(kind, defaultTopic) {
  const v = $("view");
  const title = kind === "lecture" ? "生成讲义" : "生成练习册";
  const dlg = el("div", "card dialog");
  const head = el("div", "card-head");
  head.appendChild(el("h2", null, title));
  head.appendChild(spacer());
  head.appendChild(tag(state.chapter || kbName(state.kb)));
  dlg.appendChild(head);
  const input = inputOf("topic-input", "例如：提示词工程", defaultTopic || "");
  dlg.appendChild(fieldOf("主题（会先按这个主题检索资料，再生成）", input));
  const row = el("div", "row");
  const goBtn = btn(kind === "lecture" ? "开始生成讲义" : "开始生成练习册", "primary", async () => {
    const topic = input.value.trim();
    if (!topic) { toast("请填写主题"); return; }
    dlg.remove();
    await generateArtifact(kind, topic);
  });
  row.appendChild(goBtn);
  row.appendChild(btn("取消", "ghost", () => dlg.remove()));
  dlg.appendChild(row);
  v.insertBefore(dlg, v.firstChild);
  input.focus();
  input.onkeydown = (e) => { if (e.key === "Enter") goBtn.click(); };
}

/**
 * 调内核的生成链路（讲义 / 练习册），结果落在 artifacts 目录。
 *
 * 生成要跑几十秒到几分钟，所以这里先开一个会话、带着 sessionId 发请求，
 * 然后轮询 /api/sessions/events 把内核写下的 assistant/delta（带 stage/label）渲染出来——
 * 用户能看到"正在拟大纲 / 正在写第 2 节：常见问题"，而不是对着一句"生成中"干等。
 */
async function generateArtifact(kind, topic) {
  if (!hasChatModel()) {
    toast("还没有可用的对话模型");
    go("models");
    return;
  }
  const v = $("view");
  const steps = kind === "lecture"
    ? ["检索资料", "拟大纲", "逐节写作", "引用自检", "落盘"]
    : ["检索资料", "批量出题", "引用自检", "落盘"];
  const card = progressCard((kind === "lecture" ? "正在生成讲义" : "正在生成练习册") + "：「" + topic + "」", steps);
  const live = el("div", "gen-live");
  const stageEl = el("div", "gen-stage", "准备中…");
  const textEl = el("div", "gen-text");
  const secEl = el("div", "gen-sections");
  live.appendChild(stageEl);
  live.appendChild(textEl);
  live.appendChild(secEl);
  card.appendChild(live);
  v.insertBefore(card, v.firstChild);
  card.scrollIntoView({ block: "start" });

  let sid = "";
  try {
    sid = (await api("/api/sessions/new", {})).sessionId;
  } catch (e) { /* 拿不到会话也能生成，只是没有实时进度 */ }

  if (sid) {
    const stopGen = btn("停止生成", "sm ghost", async () => {
      stopGen.disabled = true;
      stopGen.textContent = "正在停止…";
      try {
        await api("/api/agent/cancel", { sessionId: sid });
        toast("已请求停止，正在收尾…");
      } catch (e) {
        toast("停止失败：" + e.message);
        stopGen.disabled = false;
        stopGen.textContent = "停止生成";
      }
    });
    const head = card.querySelector(".card-head");
    if (head) head.appendChild(stopGen);
  }

  let poll = null;
  if (sid) {
    poll = setInterval(async () => {
      try {
        const d = await api("/api/sessions/events", { sessionId: sid });
        let stage = "", label = "", buf = "";
        const secs = [];
        for (const e of d.events || []) {
          const p = e.payload || {};
          if (e.type === "section/done") {
            secs.push(p.section || "");
          } else if (e.type === "assistant/delta") {
            const st = p.stage || "";
            const lb = p.label || "";
            if (st !== stage || lb !== label) { buf = ""; stage = st; label = lb; }
            buf += (p.text || "");
          }
        }
        if (stage === "outline") stageEl.textContent = "正在拟大纲…";
        else if (stage === "section") stageEl.textContent = "正在写：" + (label || "正文");
        else if (stage === "quiz") stageEl.textContent = "正在出题…";
        else stageEl.textContent = "正在检索资料…";
        textEl.textContent = buf.slice(-800);
        if (secs.length) secEl.textContent = "已完成 " + secs.length + " 小节：" + secs.join(" / ");
      } catch (e) {
        // 轮询失败不打扰用户，最终结果以收尾时那次为准
      }
    }, 450);
  }

  let d = null;
  let fail = "";
  try {
    d = await api(kind === "lecture" ? "/api/agent/lecture" : "/api/agent/quiz",
      { kbId: state.kb, topic: topic, count: kind === "quiz" ? 5 : undefined, sessionId: sid });
  } catch (e) {
    fail = e.message;
  }
  if (poll) clearInterval(poll);
  card._stop();
  card.remove();

  if (fail) {
    const box = cardOf({ cls: "dialog", title: "生成失败" });
    box.appendChild(el("p", "muted", fail));
    const row = el("div", "row");
    row.appendChild(btn("检查模型设置", "primary", () => go("models")));
    row.appendChild(btn("看全部会话", "", () => go("chat", "overview")));
    row.appendChild(btn("关闭", "ghost", () => box.remove()));
    box.appendChild(row);
    v.insertBefore(box, v.firstChild);
    return;
  }

  if (d && d.cancelled === true) {
    // 取消不是失败：说清楚停在哪、有没有落盘，并给一个重来的入口
    const box = cardOf({ cls: "dialog", title: (kind === "lecture" ? "讲义生成已取消" : "练习册生成已取消"), tag: "未落盘" });
    box.appendChild(el("p", "muted", (d && d.message) || "已取消"));
    const row = el("div", "row");
    row.appendChild(btn("重新生成", "primary", () => { box.remove(); askTopic(kind, topic); }));
    row.appendChild(btn("关闭", "ghost", () => box.remove()));
    box.appendChild(row);
    v.insertBefore(box, v.firstChild);
    box.scrollIntoView({ block: "start" });
    return;
  }

  if (!d || d.ok !== true) {
    const msg = (d && d.message) || "内核没有返回内容";
    const box = cardOf({ cls: "dialog", title: "没有生成成功" });
    box.appendChild(el("p", "muted", msg + "（「全部会话」里能看到这次调用停在哪一步）"));
    const row = el("div", "row");
    row.appendChild(btn("去设置模型", "primary", () => go("models")));
    row.appendChild(btn("看全部会话", "", () => go("chat", "overview")));
    row.appendChild(btn("关闭", "ghost", () => box.remove()));
    box.appendChild(row);
    v.insertBefore(box, v.firstChild);
    box.scrollIntoView({ block: "start" });
    return;
  }

  await loadArtifacts();
  await loadSessions();
  const result = cardOf({
    cls: "dialog ok-dialog",
    title: (kind === "lecture" ? "讲义已生成" : "练习册已生成") + "：" + topic,
    tag: "已落盘",
    tagCls: "ok",
  });
  if (kind === "lecture" && d.sections) {
    result.appendChild(el("div", "meta", d.sections.length + " 个小节 · " + (d.content || "").length + " 字"));
  }
  if (d.citationReport) result.appendChild(citationBox(null, d.citationReport));
  const preview = el("div", "artifact-preview");
  preview.innerHTML = md(d.content || "");
  result.appendChild(preview);
  const row = el("div", "row");
  row.appendChild(btn("按页播放", "primary", () => openSlidePlayer(artifactNameFromPath(d.artifactPath), d.content)));
  row.appendChild(btn("打开全文", "", () => openArtifactByName(artifactNameFromPath(d.artifactPath), d.content)));
  row.appendChild(btn("去我的资源", "", () => go("resources")));
  row.appendChild(copyButton(() => d.content || "", "复制 Markdown"));
  row.appendChild(btn("收起", "ghost", () => result.remove()));
  result.appendChild(row);
  v.insertBefore(result, v.firstChild);
  result.scrollIntoView({ block: "start" });
  toast("生成完成，已保存到本机");
}

function artifactNameFromPath(p) {
  const s = String(p || "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}
/* ---------- 我的笔记 ---------- */

PAGES.notes = {
  async render() {
    await loadCfg();
    const v = $("view");
    v.innerHTML = "";
    const data = await api("/api/study/notes/list", {});
    const notes = data.notes || [];
    const card = cardOf({
      title: "全部笔记",
      tag: notes.length + " 条",
      actions: [btn("写一条笔记", "primary sm", () => openNoteEditor(null, state.kb, state.chapter || ""))],
    });
    if (!notes.length) {
      card.appendChild(emptyState({
        art: "note",
        title: "还没有笔记",
        text: "读资料时的想法写下来会存进本机数据库，之后可以按章节回看。",
        actions: [btn("写第一条笔记", "primary", () => openNoteEditor(null, state.kb, state.chapter || "")),
                  btn("去读资料", "", () => go("learn"))],
      }));
    } else {
      const list = el("div", "list");
      for (const n of notes) {
        const it = el("div", "item");
        const row = el("div", "row");
        const main = el("div", "grow");
        it.dataset.id = n.id;
        main.appendChild(el("div", "item-title", n.title || "无标题"));
        const meta = el("div", "meta");
        if (n.kbId) meta.appendChild(el("span", null, kbName(n.kbId)));
        if (n.chapter) meta.appendChild(el("span", null, n.chapter));
        if (n.updatedAt) meta.appendChild(el("span", null, fmtStamp(n.updatedAt)));
        main.appendChild(meta);
        row.appendChild(main);
        row.appendChild(btn("编辑", "sm", () => openNoteEditor(n, n.kbId, n.chapter)));
        row.appendChild(btn("删除", "sm ghost", async () => {
          await api("/api/study/notes/delete", { id: n.id });
          toast("已删除");
          go("notes");
        }));
        it.appendChild(row);
        const body = el("div", "note-body");
        body.innerHTML = md(n.text || "");
        it.appendChild(body);
        list.appendChild(it);
      }
      card.appendChild(list);
    }
    v.appendChild(card);
  },
};

/* ---------- 错题本 ---------- */

PAGES.wrong = {
  async render() {
    await loadCfg();
    const v = $("view");
    v.innerHTML = "";
    const data = await api("/api/study/wrong", {});
    const all = data.records || [];
    const due = all.filter((r) => r.due);
    const mastered = all.filter((r) => r.mastered);
    const tab = state.wrongTab || "due";
    const query = String(state.wrongQuery || "").trim().toLowerCase();
    const pool = tab === "due" ? due : tab === "mastered" ? mastered : all;
    const shown = pool.filter((r) => !query ||
      String(r.question || "").toLowerCase().indexOf(query) >= 0 ||
      String(r.chapter || "").toLowerCase().indexOf(query) >= 0);

    const card = cardOf({
      title: "错题本",
      sub: "答对一次往后推，答错就回到今天",
      tag: all.length + " 条",
    });

    /* 今天该复习多少条：这是这个页面存在的意义，放最上面 */
    const banner = el("div", "review-banner" + (due.length ? " due" : ""));
    const bTop = el("div", "row");
    bTop.appendChild(el("div", "review-count grow", due.length ? ("今天该复习 " + due.length + " 条") : "今天的复习都做完了"));
    if (due.length) bTop.appendChild(btn("开始复习", "primary sm", () => openRedo(due[0])));
    banner.appendChild(bTop);
    banner.appendChild(el("div", "muted sm", "间隔 1 / 3 / 7 / 16 / 35 天：重做答对就往后推，答错回到今天；特别熟的可以标记已掌握。"));
    card.appendChild(banner);

    const tools = el("div", "row artifact-tools");
    const seg = el("div", "seg");
    const tabs = [["due", "待复习 " + due.length], ["mastered", "已掌握 " + mastered.length], ["all", "全部 " + all.length]];
    for (const [k, label] of tabs) {
      const b = el("button", "seg-item" + (tab === k ? " active" : ""), label);
      b.onclick = () => { state.wrongTab = k; go("wrong"); };
      seg.appendChild(b);
    }
    tools.appendChild(seg);
    const search = inputOf("wrong-search", "按题目或章节搜索", state.wrongQuery || "");
    search.oninput = () => {
      state.wrongQuery = search.value;
      const q = search.value.trim().toLowerCase();
      const hits = pool.filter((r) => !q ||
        String(r.question || "").toLowerCase().indexOf(q) >= 0 ||
        String(r.chapter || "").toLowerCase().indexOf(q) >= 0);
      renderWrongList(hits);
    };
    tools.appendChild(search);
    card.appendChild(tools);

    const list = el("div", "list");
    card.appendChild(list);

    function renderWrongList(items) {
      list.innerHTML = "";
      if (!items.length) {
        list.appendChild(emptyState({
          inline: true,
          art: all.length ? "search" : "flag",
          title: all.length ? "这个条件下没有错题" : "还没有错题",
          text: all.length ? "换个分类或关键词看看。" : "在「学 · 练」里对某一章出题练习，答错的题会进这里，并按间隔复习安排提醒你重做。",
          actions: all.length ? [btn("看清空条件", "", () => { state.wrongTab = "all"; state.wrongQuery = ""; go("wrong"); })]
                             : [btn("去做一组练习", "primary", () => go("learn")), btn("看我的成长", "", () => go("report"))],
        }));
        return;
      }
      for (const r of items) {
        const it = el("div", "item");
        const head = el("div", "row");
        const main = el("div", "grow");
        it.dataset.id = r.id;
        main.appendChild(el("div", "item-title", r.question || "（题干缺失）"));
        const meta = el("div", "meta");
        if (r.chapter) meta.appendChild(el("span", null, r.chapter));
        if (r.createdAt) meta.appendChild(el("span", null, "错于 " + fmtStamp(r.createdAt).slice(0, 5)));
        if (r.reviews > 0) meta.appendChild(el("span", null, "已重做对 " + r.reviews + " 次"));
        if (!r.mastered && !r.due && r.dueMs) meta.appendChild(el("span", null, "下次复习 " + fmtMs(r.dueMs) + "（" + daysUntil(r.dueMs) + " 天后）"));
        main.appendChild(meta);
        head.appendChild(main);
        if (r.mastered) head.appendChild(tag("已掌握", "ok"));
        else if (r.due) head.appendChild(tag("该重做了", "warn"));
        it.appendChild(head);
        it.appendChild(el("div", "answer-line wrong-line", "我的答案：" + (r.myAnswer || "（空）")));
        if (r.reference) it.appendChild(el("div", "answer-line", "参考答案：" + r.reference));
        const acts = el("div", "row item-actions");
        acts.appendChild(btn(r.due ? "重做" : "再练一次", r.due ? "primary sm" : "sm", () => openRedo(r)));
        acts.appendChild(btn(r.mastered ? "取消已掌握" : "标记已掌握", "sm ghost", async () => {
          try {
            await api("/api/study/wrong/review", { id: r.id, mastered: !r.mastered });
            toast(r.mastered ? "已移回待复习" : "已标记掌握");
            go("wrong");
          } catch (e) { toast("操作失败：" + e.message); }
        }));
        it.appendChild(acts);
        list.appendChild(it);
      }
    }
    renderWrongList(shown);

    if (all.length) {
      const byChapter = {};
      for (const r of all) {
        const key = r.chapter || "未分章";
        byChapter[key] = (byChapter[key] || 0) + 1;
      }
      const advice = cardOf({ title: "哪几章错得多", sub: "点一下直接回去重练那一章" });
      const tips = el("div", "list");
      Object.keys(byChapter).sort((a, b) => byChapter[b] - byChapter[a]).slice(0, 6).forEach((key) => {
        const it = el("div", "item clickable");
        const row = el("div", "row");
        const main = el("div", "grow");
        main.appendChild(el("div", "item-title", key));
        main.appendChild(el("div", "meta", byChapter[key] + " 道错题"));
        row.appendChild(main);
        row.appendChild(btn("去练这一章", "sm primary", () => { state.chapter = key === "未分章" ? null : key; go("learn"); }));
        it.appendChild(row);
        tips.appendChild(it);
      });
      advice.appendChild(tips);
      v.appendChild(card);
      v.appendChild(advice);
    } else {
      v.appendChild(card);
    }
  },
};

/** 重做一道错题：存了原题就给一样的选项，没存就对着参考答案自评（不假装能判分）。 */
function openRedo(rec) {
  const v = $("view");
  const dlg = el("div", "card dialog");
  const head = cardHeadOnly("重做这道题");
  if (rec.chapter) head.appendChild(tag(rec.chapter));
  if (rec.reviews > 0) head.appendChild(tag("已重做对 " + rec.reviews + " 次"));
  dlg.appendChild(head);
  dlg.appendChild(el("div", "item-title", rec.question || ""));

  const finish = async (correct) => {
    try {
      await api("/api/study/wrong/review", { id: rec.id, correct: correct });
      const w = await api("/api/study/wrong", {});
      const now = (w.records || []).filter((x) => x.id === rec.id)[0];
      if (correct) toast("答对了 · 下次复习：" + (now && now.dueMs ? fmtMs(now.dueMs) + "（" + daysUntil(now.dueMs) + " 天后）" : "—"));
      else toast("没关系，这条回到今天，明天再来一次");
      go("wrong");
    } catch (e) {
      toast("记录失败：" + e.message);
    }
  };

  const origin = rec.origin || {};
  const opts = origin.options || [];
  if (opts.length) {
    const btns = [];
    opts.forEach((o, i) => {
      const b = btn(String.fromCharCode(65 + i) + ". " + o, "choice", () => {
        if (dlg.dataset.done) return;
        dlg.dataset.done = "1";
        const ok = i === Number(origin.answerIndex);
        b.classList.add(ok ? "right" : "wrong");
        if (!ok && btns[Number(origin.answerIndex)]) btns[Number(origin.answerIndex)].classList.add("right");
        const tip = el("div", "quiz-explain");
        tip.innerHTML = '<span class="tag ' + (ok ? "ok" : "warn") + '">' + (ok ? "答对了" : "答错了") + "</span> " +
          '<span class="muted">参考答案：' + esc(opts[Number(origin.answerIndex)] || rec.reference || "") + "</span>" +
          (origin.explain ? '<div class="muted sm" style="margin-top:6px">' + esc(origin.explain) + "</div>" : "");
        dlg.appendChild(tip);
        // 让对错先看清，再刷新页面
        setTimeout(() => { finish(ok); }, 650);
      });
      btns.push(b);
      dlg.appendChild(b);
    });
  } else {
    dlg.appendChild(el("div", "answer-line wrong-line", "我的答案：" + (rec.myAnswer || "（空）")));
    dlg.appendChild(el("div", "answer-line", "参考答案：" + (rec.reference || "—")));
    dlg.appendChild(el("p", "muted sm", "这条是早期记录（那时还没存下选项），所以由你自己判定这次答对了没有。"));
    const row = el("div", "row");
    row.appendChild(btn("这次答对了", "primary", () => finish(true)));
    row.appendChild(btn("还是没答对", "", () => finish(false)));
    dlg.appendChild(row);
  }
  const foot = el("div", "row");
  foot.appendChild(btn("关闭", "ghost", () => dlg.remove()));
  dlg.appendChild(foot);
  v.insertBefore(dlg, v.firstChild);
  dlg.scrollIntoView({ block: "start" });
}


/* ============================================================
   我的成长 · 六维能力画像（网页版 Report 那张雷达图搬过来的）
   ------------------------------------------------------------
   两条线：**自评**（设置里填的）与**实测参考**（真实信号推的）。
   实测参考每一格都把依据写在表里——网页版靠的是手工维护的"章节→维度权重表"，
   桌面版的章节来自用户自己的资料、没有那张表，所以改成"每维配一个真拿得到的信号"。
   数据不够就画空心点并在表里写"数据不够"，不拿噪声当分数。
   ============================================================ */
function abilityCard() {
  const r = state.report || {};
  const rows = Array.isArray(r.abilities) ? r.abilities : [];
  const card = cardOf({
    title: "六维能力",
    tag: r.weakest ? "该补：" + r.weakest : "",
    tagCls: r.weakest ? "warn" : "",
    actions: [btn("去画像校准", "sm", () => go("calibrate")), btn("去更新自评", "sm ghost", () => go("settings", "general"))],
  });
  if (!rows.length) {
    card.appendChild(emptyState({
      inline: true,
      art: "chart",
      title: "还没有可算的能力画像",
      text: "先在设置里填一行自评，或者去「学 · 练」读几片资料、做几道题，这里就会长出雷达图。",
      actions: [btn("去填写自评", "primary", () => go("settings", "general")), btn("去学 · 练", "", () => go("learn"))],
    }));
    return card;
  }

  const body = el("div", "ability-body");
  const cv = el("canvas", "ability-radar");
  body.appendChild(cv);
  const side = el("div", "ability-side");
  const legend = el("div", "ability-legend");
  legend.innerHTML = '<span class="lg self">自评</span><span class="lg ev">实测参考</span><span class="muted sm">空心点 = 这一维数据还不够</span>';
  side.appendChild(legend);
  const table = el("div", "ability-table");
  for (const row of rows) {
    const line = el("div", "ability-row");
    const head = el("div", "row");
    head.appendChild(el("span", "grow ability-key", row.key));
    head.appendChild(el("span", "ability-num", row.self >= 0 ? "自评 " + row.self : "自评 —"));
    head.appendChild(el("span", "ability-num ev", row.evidence >= 0 ? "参考 " + row.evidence : "参考 —"));
    line.appendChild(head);
    line.appendChild(el("div", "muted sm ability-basis", row.basis || ""));
    table.appendChild(line);
  }
  side.appendChild(table);
  body.appendChild(side);
  card.appendChild(body);
  side.appendChild(suggestionBox(r.weakest, rows));

  // 画完再画一次：字体与颜色要等布局稳定
  setTimeout(() => drawRadar(cv, rows), 0);
  return card;
}

/** 最该补的一维 → 一句人话 + 一个能直接点走的动作。 */
const ABILITY_ADVICE = {
  "概念理解": { text: "资料还有没读完的部分，先把剩下的切片看掉，概念才连得起来。", act: "去读资料", go: () => go("learn") },
  "逻辑推理": { text: "答题正确率是这一维的主要依据：去做一组练习，错的会自动进错题本。", act: "出题练习", go: () => go("learn") },
  "工程实践": { text: "走完一章的「讲 → 练 → 记 → 完成」，这一维才会动。", act: "去学一章", go: () => go("learn") },
  "问题诊断": { text: "错题重做一次就能把这一维推上去，比再读一遍资料管用。", act: "去错题本", go: () => go("wrong") },
  "系统设计": { text: "把学过的章节沉淀成讲义或练习册，产物数就是这一维的依据。", act: "生成讲义", go: () => go("learn") },
  "学习迁移": { text: "写下一条自己的例子或用法，笔记是这一维的依据。", act: "写一条笔记", go: () => openNoteEditor(null, state.kb, state.chapter || "") },
};

function suggestionBox(weakest, rows) {
  const box = el("div", "ability-advice");
  if (!weakest) {
    box.appendChild(el("div", "ability-advice-title", "数据还不足以下结论"));
    box.appendChild(el("div", "muted sm", "读几片、做几题之后，这里会指出最该补的那一维。"));
    return box;
  }
  const row = rows.filter((x) => x.key === weakest)[0] || { key: weakest };
  const adv = ABILITY_ADVICE[weakest] || { text: "这一维的实测参考最低，先从这里补。", act: "去学 · 练", go: () => go("learn") };
  box.appendChild(el("div", "ability-advice-title", "先补这一维：" + row.key));
  box.appendChild(el("div", "muted sm", adv.text));
  if (row.basis) box.appendChild(el("div", "muted sm", "依据：" + row.basis));
  box.appendChild(btn(adv.act, "sm primary", adv.go));
  return box;
}

/** 六维雷达：静态图（不做动画，减少动态的人也不会看到跳变）。 */
function drawRadar(canvas, rows) {
  const css = getComputedStyle(document.documentElement);
  const ink = (css.getPropertyValue("--ink-2") || "#3a4640").trim();
  const muted = (css.getPropertyValue("--muted") || "#6c7a72").trim();
  const line = (css.getPropertyValue("--line") || "#e5e9e6").trim();
  const brand = (css.getPropertyValue("--brand") || "#2f7053").trim();
  const amber = (css.getPropertyValue("--amber") || "#9a6a1c").trim();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = 380;
  const h = 300;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = "100%";
  canvas.style.maxWidth = w + "px";
  canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2 + 6;
  const R = Math.min(w, h) / 2 - 46;
  const n = rows.length;
  const pt = (i, v) => {
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const r = (R * Math.max(0, Math.min(100, v))) / 100;
    return [cx + Math.cos(ang) * r, cy + Math.sin(ang) * r];
  };
  // 网格：四圈 + 六条轴
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  for (let ring = 1; ring <= 4; ring += 1) {
    ctx.beginPath();
    for (let i = 0; i < n; i += 1) {
      const [x, y] = pt(i, (ring * 100) / 4);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }
  ctx.beginPath();
  for (let i = 0; i < n; i += 1) {
    const [x, y] = pt(i, 100);
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 两条数据线
  const series = [
    { key: "self", color: brand, fill: true },
    { key: "evidence", color: amber, fill: false },
  ];
  for (const se of series) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i += 1) {
      const v = Number(rows[i][se.key]);
      const [x, y] = pt(i, v >= 0 ? v : 0);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    }
    ctx.closePath();
    ctx.strokeStyle = se.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    if (se.fill) {
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = se.color;
      ctx.fill();
      ctx.restore();
    }
    // 顶点：数据不够的画空心点
    for (let i = 0; i < n; i += 1) {
      const v = Number(rows[i][se.key]);
      const [x, y] = pt(i, v >= 0 ? v : 0);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = v >= 0 ? se.color : "transparent";
      ctx.strokeStyle = se.color;
      ctx.fill();
      ctx.stroke();
    }
  }

  // 维度名 + 25/50/75/100 刻度
  ctx.fillStyle = muted;
  ctx.font = "11px -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif";
  ctx.textAlign = "center";
  for (let i = 0; i < n; i += 1) {
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const x = cx + Math.cos(ang) * (R + 20);
    const y = cy + Math.sin(ang) * (R + 20);
    ctx.fillText(String(rows[i].key).slice(0, 4), x, y + 3);
  }
  ctx.fillStyle = ink;
  ctx.textAlign = "left";
  ctx.fillText("100", cx + 3, cy - R + 10);
}


/* ============================================================
   我的成长 · 最近两周（网页版 Report 的 GrowthTrend 搬过来）
   ------------------------------------------------------------
   数据来自库里**已经存着的时间戳**（读了哪片 / 答题 / 笔记 / 完成章节 / 会话轮次）。
   内核只按已有日期分桶；"最近 14 天是哪几天"在前端算（JS 一行就是本地日期），
   两边各干自己擅长的，不用在仓颉里写日历。
   ============================================================ */
function trendCard() {
  const r = state.report || {};
  const byDate = {};
  for (const row of (r.trend || [])) byDate[row.date] = row;
  const DAY = 86400000;
  const days = [];
  for (let i = 13; i >= 0; i -= 1) {
    const key = new Date(Date.now() - i * DAY).toLocaleDateString("sv-SE");
    const row = byDate[key] || {};
    days.push({
      key: key,
      label: key.slice(5),
      read: Number(row.read || 0),
      quiz: Number(row.quiz || 0),
      notes: Number(row.notes || 0),
      done: Number(row.done || 0),
    });
  }
  const last7 = days.slice(7);
  const prev7 = days.slice(0, 7);
  const sum = (arr, k) => arr.reduce((acc, x) => acc + x[k], 0);
  const lRead = sum(last7, "read"), pRead = sum(prev7, "read");
  const lQuiz = sum(last7, "quiz"), pQuiz = sum(prev7, "quiz");
  const today = days[days.length - 1];
  const active = days.filter((d) => d.read + d.quiz + d.notes + d.done > 0).length;

  const card = cardOf({
    title: "最近两周",
    tag: active ? "有 " + active + " 天在学" : "还没有记录",
    tagCls: active ? "" : "warn",
    actions: [btn("去学 · 练", "sm", () => go("learn"))],
  });

  const body = el("div", "trend-body");
  const cv = el("canvas", "trend-chart");
  body.appendChild(cv);
  const side = el("div", "trend-side");
  const legend = el("div", "trend-legend");
  legend.innerHTML = '<span class="lg self">读了（片）</span><span class="lg ev">做了（题）</span>';
  side.appendChild(legend);

  const lineOf = (label, now, before, unit) => {
    const line = el("div", "trend-row");
    const head = el("div", "row");
    head.appendChild(el("span", "grow trend-key", label));
    head.appendChild(el("span", "trend-num", "本周 " + now + unit));
    head.appendChild(el("span", "trend-num ev", "上周 " + before + unit + diffText(now, before)));
    line.appendChild(head);
    side.appendChild(line);
  };
  lineOf("读了", lRead, pRead, " 片");
  lineOf("做了", lQuiz, pQuiz, " 题");
  const extra = el("div", "trend-row");
  const extraHead = el("div", "row");
  extraHead.appendChild(el("span", "grow trend-key", "其他"));
  extraHead.appendChild(el("span", "trend-num", "笔记 " + sum(last7, "notes") + " · 完成章节 " + sum(last7, "done")));
  extra.appendChild(extraHead);
  side.appendChild(extra);
  side.appendChild(el("div", "muted sm trend-basis",
    today.read + today.quiz + today.notes + today.done > 0
      ? "今天：读了 " + today.read + " 片 · 做了 " + today.quiz + " 题"
      : "今天还没有记录"));
  side.appendChild(weeklyAdvice(days, { lRead: lRead, pRead: pRead, lQuiz: lQuiz, pQuiz: pQuiz }));
  body.appendChild(side);
  card.appendChild(body);
  setTimeout(() => drawTrend(cv, days), 0);
  return card;
}

function diffText(now, before) {
  const d = now - before;
  if (d === 0) return "（持平）";
  return d > 0 ? "（+" + d + "）" : "（" + d + "）";
}

/** 每周建议：只说数据支持得住的话——没有上周可比就直说。 */
function weeklyAdvice(days, t) {
  const box = el("div", "trend-advice");
  const total = t.lRead + t.lQuiz;
  const prev = t.pRead + t.pQuiz;
  let title = "这个节奏可以保持";
  let text = "上周读了 " + t.pRead + " 片、做了 " + t.pQuiz + " 题。";
  if (total === 0 && prev === 0) {
    title = "这两周还没有学习记录";
    text = "从今天读一片开始：十分钟也算。";
  } else if (total === 0) {
    title = "这周还是零";
    text = "上周有 " + prev + " 次活动，挑一章接着往下读就好。";
  } else if (prev === 0) {
    title = "开了个头";
    text = "上周没有可比的数据，先把这个节奏保持住。";
  } else if (t.lRead > t.pRead && t.lQuiz <= t.pQuiz) {
    title = "读得多、练得少";
    text = "读的片数涨了，题数没跟上：挑刚读完的一章出几道题巩固。";
  } else if (t.lQuiz > t.pQuiz && t.lRead <= t.pRead) {
    title = "练得多、读得少";
    text = "题做得多，读的原文少了：把错题对应的那几段原文再看一遍。";
  } else if (t.lRead > t.pRead && t.lQuiz > t.pQuiz) {
    title = "两项都比上周多";
    text = "保持这个量，别忘了把做错的题重做一遍。";
  } else if (t.lRead < t.pRead && t.lQuiz < t.pQuiz) {
    title = "比上周少了";
    text = "每天十分钟也比周末赶工强，挑最短的一章先动起来。";
  }
  box.appendChild(el("div", "ability-advice-title", title));
  box.appendChild(el("div", "muted sm", text));
  return box;
}

/** 两周折线：只画"读了 / 做了"两条线（其他三项在右边文字里）。 */
function drawTrend(canvas, days) {
  const css = getComputedStyle(document.documentElement);
  const line = (css.getPropertyValue("--line") || "#e5e9e6").trim();
  const muted = (css.getPropertyValue("--muted") || "#6c7a72").trim();
  const brand = (css.getPropertyValue("--brand") || "#2f7053").trim();
  const amber = (css.getPropertyValue("--amber") || "#9a6a1c").trim();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = 420;
  const h = 240;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = "100%";
  canvas.style.maxWidth = w + "px";
  canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padL = 26, padR = 10, padT = 14, padB = 26;
  const iw = w - padL - padR;
  const ih = h - padT - padB;
  let max = 1;
  for (const d of days) max = Math.max(max, d.read, d.quiz);
  const x = (i) => padL + (days.length <= 1 ? 0 : (i / (days.length - 1)) * iw);
  const y = (v) => padT + ih - (v / max) * ih;

  // 网格 + 刻度
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.fillStyle = muted;
  ctx.font = "10px -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif";
  ctx.textAlign = "right";
  for (let g = 0; g <= 2; g += 1) {
    const v = (max * g) / 2;
    const yy = y(v);
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
    ctx.fillText(max < 4 ? String(Math.round(v * 10) / 10) : String(Math.round(v)), padL - 5, yy + 3);
  }
  // 日期（每三天一个标签）
  ctx.textAlign = "center";
  for (let i = 0; i < days.length; i += 1) {
    if (i % 3 === 0 || i === days.length - 1) ctx.fillText(days[i].label, x(i), h - 8);
  }
  // 两条线
  for (const se of [{ k: "read", color: brand }, { k: "quiz", color: amber }]) {
    ctx.beginPath();
    days.forEach((d, i) => {
      const px = x(i), py = y(d[se.k]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = se.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    days.forEach((d, i) => {
      ctx.beginPath();
      ctx.arc(x(i), y(d[se.k]), d[se.k] > 0 ? 3 : 1.6, 0, Math.PI * 2);
      ctx.fillStyle = d[se.k] > 0 ? se.color : line;
      ctx.fill();
    });
  }
}

/* ---------- 我的成长 ---------- */

PAGES.report = {
  async render() {
    await loadOverview();
    const v = $("view");
    v.innerHTML = "";
    const r = state.report;

    const grid = el("div", "grid grid-4");
    grid.appendChild(statCard("已读切片", r.readChunks || 0, ""));
    grid.appendChild(statCard("完成章节", r.completedChapters || 0, ""));
    grid.appendChild(statCard("答题总数", r.quizTotal || 0, ""));
    grid.appendChild(statCard("正确率", r.quizTotal ? pct(r.quizRight, r.quizTotal) : 0, "%"));
    v.appendChild(grid);

    /* 错题的"今天该复习"直接摆到成长页：不然用户不会想起来去错题本 */
    if (r.quizWrong > 0) {
      const nudge = el("div", "row review-nudge");
      const dueN = Number(r.wrongDue || 0);
      nudge.appendChild(el("span", "muted grow", "错题 " + r.quizWrong + " 条，其中 " + dueN + " 条今天该复习"));
      nudge.appendChild(btn(dueN > 0 ? "去复习 " + dueN + " 条" : "打开错题本", dueN > 0 ? "primary sm" : "sm", () => go("wrong")));
      v.appendChild(nudge);
    }

    v.appendChild(abilityCard());
    v.appendChild(trendCard());

    const recent = cardOf({
      title: "错题回顾",
      tag: (r.quizWrong || 0) + " 条",
      actions: [btn("全部错题", "sm ghost", () => go("wrong"))],
    });
    const wrong = await api("/api/study/wrong", {});
    const records = wrong.records || [];
    if (!records.length) {
      recent.appendChild(emptyState({
        inline: true,
        art: "check",
        title: "还没有错题",
        text: "做题之后这里会出现需要复习的题目。",
        actions: [btn("去做一组练习", "primary", () => go("learn"))],
      }));
    } else {
      const list = el("div", "list");
      for (const q of records.slice(0, 5)) {
        const it = el("div", "item");
        it.appendChild(el("div", "item-title", q.question || ""));
        it.appendChild(el("div", "answer-line wrong-line", "我的答案：" + (q.myAnswer || "")));
        if (q.reference) it.appendChild(el("div", "answer-line", "参考答案：" + q.reference));
        list.appendChild(it);
      }
      recent.appendChild(list);
    }
    v.appendChild(recent);

    const activity = cardOf({
      title: "最近的学习活动",
      sub: "来自 Agent 会话日志",
      actions: [btn("看全部会话", "sm ghost", () => go("chat", "overview"))],
    });
    if (!state.sessions.length) {
      activity.appendChild(emptyState({
        inline: true,
        art: "clock",
        title: "还没有会话",
        text: "每次问答、出题、生成讲义都会记录成一条会话，过程可追溯。",
        actions: [btn("问第一个问题", "primary", () => go("chat"))],
      }));
    } else {
      const list = el("div", "list");
      for (const s of state.sessions.slice(0, 5)) {
        const it = el("div", "item clickable");
        const row = el("div", "row");
        const main = el("div", "grow");
        main.appendChild(el("div", "item-title", s.title || "（无标题会话）"));
        main.appendChild(el("div", "meta", s.eventCount + " 条事件 · " + fmtStamp(s.lastAt)));
        row.appendChild(main);
        row.appendChild(tag(EVENT_LABEL[s.lastType] || s.lastType || ""));
        it.appendChild(row);
        it.onclick = () => openSession(s.sessionId);
        list.appendChild(it);
      }
      activity.appendChild(list);
    }
    v.appendChild(activity);
  },
};

/* ---------- 画像校准：用真实练习数据与自己的判断对齐六维能力 ---------- */

const ABILITY_DIMENSIONS = [
  { key: "概念理解", hint: "说得清概念之间的区别与联系", ask: "举一个你最近给别人讲清楚的例子" },
  { key: "逻辑推理", hint: "能从条件推到结论，并说明依据", ask: "举一个你最近做过的推理或判断" },
  { key: "工程实践", hint: "能把想法落成能跑起来的东西", ask: "举一个你最近亲手做出来的东西" },
  { key: "问题诊断", hint: "能找到问题出在哪一环", ask: "举一个你最近排查并解决的问题" },
  { key: "系统设计", hint: "能拆解复杂任务并排出先后", ask: "举一个你最近拆解过的任务" },
  { key: "学习迁移", hint: "能把学过的东西用到新场景", ask: "举一个你最近迁移过的用法" },
];

const ABILITY_LEVELS = [
  { value: 20, label: "刚起步", note: "需要照着做" },
  { value: 35, label: "能跟做", note: "有人带就能完成" },
  { value: 50, label: "能独立", note: "自己能把事做完" },
  { value: 65, label: "能带人", note: "能讲清并纠正别人" },
  { value: 80, label: "能设计", note: "能设计做法与标准" },
];

/** 当前分值落在哪一档（与五档自评互逆）。 */
function levelIndexOf(score) {
  const v = Number(score || 50);
  let best = 0, bestDiff = 1e9;
  ABILITY_LEVELS.forEach((lv, i) => {
    const d = Math.abs(lv.value - v);
    if (d < bestDiff) { bestDiff = d; best = i; }
  });
  return best;
}

/**
 * 真实练习数据给出的参考档位。
 * 题量少于 4 道就不给建议——拿噪声当依据比不给建议更糟。
 */
function measuredLevelIndex() {
  const r = state.report || {};
  const total = Number(r.quizTotal || 0);
  if (total < 4) return null;
  const acc = pct(r.quizRight || 0, total);
  let idx = 0;
  if (acc >= 85) idx = 4;
  else if (acc >= 70) idx = 3;
  else if (acc >= 55) idx = 2;
  else if (acc >= 40) idx = 1;
  return { index: idx, accuracy: acc, total: total };
}

function calibrationNoteText() {
  const r = state.report || {};
  const m = measuredLevelIndex();
  const lines = [
    "# 画像校准记录 " + new Date().toLocaleString("zh-CN"),
    "",
    "## 本次校准结果",
    "",
    "| 维度 | 档位 | 分值 | 我的依据 |",
    "| --- | --- | --- | --- |",
  ];
  ABILITY_DIMENSIONS.forEach((d) => {
    const lv = ABILITY_LEVELS[state.calib[d.key] || 0];
    lines.push("| " + d.key + " | " + lv.label + " | " + lv.value + " | " + ((state.calibNote || {})[d.key] || "—") + " |");
  });
  lines.push("", "## 当时的实测参考", "");
  lines.push("- 答题总数：" + (r.quizTotal || 0) + "，错题：" + (r.quizWrong || 0));
  if (m) {
    lines.push("- 正确率：" + m.accuracy + "%（" + m.total + " 题）→ 参考档位「" + ABILITY_LEVELS[m.index].label + "」");
  } else {
    lines.push("- 练习数据还不足 4 题，本次以自评为主");
  }
  lines.push("- 已读切片：" + (r.readChunks || 0) + " · 完成章节：" + (r.completedChapters || 0));
  lines.push("", "> 自评与实测不一致时优先看实测：正确率反映「能不能做对」，自评反映「敢不敢接活」。");
  lines.push("");
  return lines.join("\n");
}

PAGES.calibrate = {
  async render() {
    await loadCfg();
    await loadProfile();
    await loadReport();
    const v = $("view");
    v.innerHTML = "";
    const scores = (state.profile && state.profile.selfScores) || {};
    if (!state.calib) state.calib = {};
    if (!state.calibNote) state.calibNote = {};
    for (const d of ABILITY_DIMENSIONS) {
      if (state.calib[d.key] === undefined) state.calib[d.key] = levelIndexOf(scores[d.key]);
    }
    const m = measuredLevelIndex();
    const r = state.report || {};

    const steps = cardOf({ title: "校准怎么做" });
    const ul = el("ul", "about-list");
    [
      "六维能力各选一个档位：从「刚起步」到「能设计」，档位对应 20 / 35 / 50 / 65 / 80 分。",
      "右侧给出实测参考——你在这个知识库里的答题正确率。两者不一致时，优先相信自己最近的做题结果。",
      "保存后写回本机档案，「我的成长」页会立刻按新分值显示；也可以生成一条校准记录笔记，之后回看当时怎么判断的。",
    ].forEach((t) => ul.appendChild(el("li", null, t)));
    steps.appendChild(ul);
    v.appendChild(steps);

    const actual = cardOf({
      title: "实测参考",
      sub: "来自本机的真实作答记录",
      actions: [btn("去练一组题", "sm", () => go("learn"))],
    });
    const grid = el("div", "grid grid-4");
    grid.appendChild(statCard("答题总数", r.quizTotal || 0, "题"));
    grid.appendChild(statCard("正确率", r.quizTotal ? pct(r.quizRight, r.quizTotal) : 0, "%"));
    grid.appendChild(statCard("已读切片", r.readChunks || 0, ""));
    grid.appendChild(statCard("错题", r.quizWrong || 0, "条"));
    actual.appendChild(grid);
    if (m) {
      const hint = el("p", "calib-hint");
      hint.innerHTML = "近 " + m.total + " 题正确率 <b>" + m.accuracy + "%</b>，" +
        "参考档位「<b>" + ABILITY_LEVELS[m.index].label + "</b>」（" + ABILITY_LEVELS[m.index].value + " 分）。";
      actual.appendChild(hint);
      actual.appendChild(btn("六维都先按实测参考填", "", () => {
        ABILITY_DIMENSIONS.forEach((d) => { state.calib[d.key] = m.index; });
        go("calibrate");
      }));
    } else {
      actual.appendChild(el("p", "muted", "练习数据还不足 4 题，这次以自评为主。先去「学 · 练」做一组题，校准会更有依据。"));
    }
    v.appendChild(actual);

    const rows = cardOf({
      title: "六维自评",
      sub: "点档位即可，下面那行字是给自己留的依据（可留空）",
      tag: Object.keys(scores).length + " 项已有分值",
    });
    for (const d of ABILITY_DIMENSIONS) {
      const cur = state.calib[d.key];
      const box = el("div", "calib-row");
      box.dataset.id = d.key;
      const head = el("div", "row");
      const main = el("div", "grow");
      main.appendChild(el("div", "item-title", d.key));
      main.appendChild(el("div", "meta", d.hint));
      head.appendChild(main);
      head.appendChild(tag("当前 " + (scores[d.key] === undefined ? "未填" : scores[d.key])));
      box.appendChild(head);
      const seg = el("div", "seg seg-wide");
      ABILITY_LEVELS.forEach((lv, i) => {
        const b = el("button", "seg-item" + (i === cur ? " active" : ""), lv.label + " · " + lv.value);
        b.title = lv.note;
        if (m && m.index === i) b.appendChild(el("span", "seg-flag", "实测"));
        b.onclick = () => { state.calib[d.key] = i; go("calibrate"); };
        seg.appendChild(b);
      });
      box.appendChild(seg);
      const noteInput = inputOf("", d.ask + "（选填）", state.calibNote[d.key] || "");
      noteInput.oninput = () => { state.calibNote[d.key] = noteInput.value; };
      box.appendChild(noteInput);
      rows.appendChild(box);
    }
    v.appendChild(rows);

    const foot = el("div", "card");
    const row = el("div", "row");
    row.appendChild(btn("保存校准", "primary", async () => {
      const selfScores = {};
      ABILITY_DIMENSIONS.forEach((d) => { selfScores[d.key] = ABILITY_LEVELS[state.calib[d.key] || 0].value; });
      try {
        await saveProfile({ selfScores: selfScores });
        toast("已写回本机档案");
        go("report");
      } catch (e) { toast("保存失败：" + e.message); }
    }));
    row.appendChild(btn("保存并生成校准记录笔记", "", async () => {
      try {
        const selfScores = {};
        ABILITY_DIMENSIONS.forEach((d) => { selfScores[d.key] = ABILITY_LEVELS[state.calib[d.key] || 0].value; });
        await saveProfile({ selfScores: selfScores });
        await api("/api/study/notes/save", {
          id: "", kbId: state.kb || "", chapter: "",
          title: "画像校准记录 " + fmtStamp(nowStamp()) ,
          text: calibrationNoteText(),
        });
        await loadReport();
        toast("已写回档案，并生成一条校准记录笔记");
        go("notes");
      } catch (e) { toast("失败：" + e.message); }
    }));
    row.appendChild(btn("看看我的成长", "ghost", () => go("report")));
    foot.appendChild(row);
    foot.appendChild(el("p", "muted sm", "校准只改「自评能力」这一项，不会动你的昵称、学习目标与知识库。"));
    v.appendChild(foot);
  },
};

/* ---------- 我的资源 ---------- */

const ARTIFACT_KIND = (name) => {
  const n = String(name || "");
  if (n.indexOf("讲义") === 0) return "lecture";
  if (n.indexOf("练习") === 0) return "quiz";
  return "other";
};
const ARTIFACT_KIND_LABEL = { lecture: "讲义", quiz: "练习册", other: "其他" };

function artifactItem(a, clickable) {
  const kind = ARTIFACT_KIND(a.name);
  const it = el("div", "item" + (clickable ? " clickable" : ""));
  it.dataset.id = a.name;
  const row = el("div", "row");
  const ic = el("div", "file-icon");
  ic.innerHTML = icon(kind === "lecture" ? "layers" : "file");
  const main = el("div", "grow");
  main.appendChild(el("div", "item-title", a.name));
  const meta = el("div", "meta");
  meta.appendChild(el("span", null, ARTIFACT_KIND_LABEL[kind]));
  meta.appendChild(el("span", null, fmtSize(a.size)));
  meta.appendChild(el("span", null, "本机 Markdown"));
  if (a.page > 0 && a.pageCount > 0) {
    meta.appendChild(el("span", "progress-note", "上次讲到第 " + a.page + " / " + a.pageCount + " 页"));
  }
  main.appendChild(meta);
  row.appendChild(ic);
  row.appendChild(main);
  row.appendChild(tag(ARTIFACT_KIND_LABEL[kind], kind === "lecture" ? "ok" : ""));
  row.appendChild(btn("播放", "sm primary", () => openSlidePlayer(a.name)));
  if (clickable) {
    row.appendChild(btn("打开", "sm ghost", () => openArtifactByName(a.name)));
    row.appendChild(btn("重命名", "sm ghost", () => renameArtifactDialog(a)));
    row.appendChild(btn("删除", "sm ghost", () => {
      confirmDialog("删除这份产物？", "会从本机 artifacts 目录里删掉「" + a.name + "」，同时清掉它的播放进度。这一步不可撤销。", async () => {
        try {
          await api("/api/artifacts/delete", { name: a.name });
          toast("已删除：" + a.name);
          await loadArtifacts();
          go("resources");
        } catch (e) { toast("删除失败：" + e.message); }
      });
    }));
  }
  it.appendChild(row);
  it.onclick = (ev) => { if (!ev.target.closest("button")) openArtifactByName(a.name); };
  return it;
}

/** 通用确认弹层。用于删除这类不可撤销的动作（不用 window.confirm：桌面壳里观感差）。 */
function confirmDialog(title, text, onOk) {
  const v = $("view");
  const dlg = el("div", "card dialog");
  dlg.appendChild(cardHeadOnly(title));
  dlg.appendChild(el("p", "muted", text));
  const row = el("div", "row");
  row.appendChild(btn("确认删除", "primary", async () => {
    dlg.remove();
    await onOk();
  }));
  row.appendChild(btn("取消", "ghost", () => dlg.remove()));
  dlg.appendChild(row);
  v.insertBefore(dlg, v.firstChild);
  dlg.scrollIntoView({ block: "start" });
}

function renameArtifactDialog(a) {
  const v = $("view");
  const dlg = el("div", "card dialog");
  dlg.appendChild(cardHeadOnly("重命名产物"));
  const base = String(a.name || "").replace(/\.md$/i, "");
  const input = inputOf("rename-input", "新的文件名", base);
  dlg.appendChild(fieldOf("文件名（不写 .md 会自动补上）", input));
  const row = el("div", "row");
  const submit = async () => {
    const next = input.value.trim();
    if (!next) { toast("名字不能为空"); return; }
    if (next === base) { dlg.remove(); return; }
    try {
      const r = await api("/api/artifacts/rename", { name: a.name, newName: next });
      toast("已改名为：" + r);
      dlg.remove();
      await loadArtifacts();
      go("resources");
    } catch (e) { toast("改名失败：" + e.message); }
  };
  row.appendChild(btn("改名", "primary", submit));
  row.appendChild(btn("取消", "ghost", () => dlg.remove()));
  dlg.appendChild(row);
  v.insertBefore(dlg, v.firstChild);
  dlg.scrollIntoView({ block: "start" });
  input.focus();
  input.select();
  input.onkeydown = (e) => { if (e.key === "Enter") submit(); };
}

PAGES.resources = {
  async render() {
    await loadArtifacts();
    const v = $("view");
    v.innerHTML = "";
    if (!state.artifacts.length) {
      v.appendChild(cardOf({
        body: emptyState({
          art: "layers",
          title: "还没有产物",
          text: "产物是可复现的本地 Markdown：讲义按大纲逐节写作，练习册带答案与解析，每段结论都标了出处编号。",
          actions: [btn("去生成讲义", "primary", () => go("learn")),
                    btn("看看知识库", "", () => go("kb"))],
        }),
      }));
      return;
    }
    const filter = state.artifactFilter || "all";
    const q = String(state.artifactQuery || "").trim().toLowerCase();
    const card = cardOf({
      title: "已生成的产物",
      sub: "全部存在本机 artifacts 目录",
      tag: state.artifacts.length + " 份",
      actions: [btn("再生成一份", "sm primary", () => go("learn")), btn("刷新", "sm ghost", () => go("resources"))],
    });

    const tools = el("div", "row artifact-tools");
    const search = inputOf("artifact-search", "按文件名搜索，例如 提示词", state.artifactQuery || "");
    search.oninput = () => {
      state.artifactQuery = search.value;
      renderArtifactList();
    };
    tools.appendChild(search);
    const seg = el("div", "seg");
    const kinds = [["all", "全部"], ["lecture", "讲义"], ["quiz", "练习册"]];
    for (const [k, label] of kinds) {
      const b = el("button", "seg-item" + (filter === k ? " active" : ""), label);
      b.onclick = () => { state.artifactFilter = k; go("resources"); };
      seg.appendChild(b);
    }
    tools.appendChild(seg);
    const count = el("span", "muted sm artifact-count");
    tools.appendChild(count);
    card.appendChild(tools);

    const list = el("div", "list");
    card.appendChild(list);
    function renderArtifactList() {
      list.innerHTML = "";
      const query = String(state.artifactQuery || "").trim().toLowerCase();
      const kind = state.artifactFilter || "all";
      const items = state.artifacts.filter((a) =>
        (kind === "all" || ARTIFACT_KIND(a.name) === kind) &&
        (!query || String(a.name).toLowerCase().indexOf(query) >= 0));
      // 没有筛选/搜索时不必重复总数（头部标签已经写了），只在筛过时说明"显示了多少"
      const filtering = (kind !== "all") || (query.length > 0);
      count.textContent = filtering ? ("筛选后 " + items.length + " / 共 " + state.artifacts.length + " 份") : "";
      if (!items.length) {
        list.appendChild(emptyState({
          inline: true,
          art: "search",
          title: state.artifacts.length ? "没有匹配的产物" : "这个分类下还没有产物",
          text: state.artifacts.length ? "换个关键词，或者切回「全部」。" : "换个分类看看，或者现在生成一份。",
          actions: [btn("清空搜索", "", () => { state.artifactQuery = ""; go("resources"); }),
                    btn("去生成", "primary", () => go("learn"))],
        }));
        return;
      }
      for (const a of items) list.appendChild(artifactItem(a, true));
    }
    renderArtifactList();
    v.appendChild(card);

    const where = cardOf({
      title: "这些文件在哪",
      sub: "讲义与练习册就是普通 Markdown，可以直接拷走或用别的编辑器打开",
    });
    where.appendChild(el("p", "path-line", (state.cfg.dataDir || "（内核没有返回数据目录）") + "\\artifacts"));
    const wrow = el("div", "row");
    wrow.appendChild(btn("复制数据目录路径", "", () => {
      const p = (state.cfg.dataDir || "") + "\\artifacts";
      navigator.clipboard.writeText(p).then(() => toast("路径已复制"), () => toast("复制失败，请手动选择"));
    }));
    where.appendChild(wrow);
    v.appendChild(where);
  },
};

async function openArtifactByName(name, fallbackContent) {
  const v = $("view");
  let content = fallbackContent;
  if (content === undefined) {
    try {
      const d = await api("/api/artifacts/read", { name: name });
      content = d.content;
    } catch (e) {
      toast("读取失败：" + e.message);
      return;
    }
  }
  v.innerHTML = "";
  const top = cardOf({
    cls: "dialog",
    title: name,
    tag: "本机文件",
    actions: [
      btn("按页播放", "sm primary", () => openSlidePlayer(name, content)),
      copyButton(() => content, "复制全文"),
      btn("← 返回我的资源", "ghost sm", () => go("resources")),
    ],
  });
  v.appendChild(top);
  const body = el("div", "card");
  body.innerHTML = md(content || "");
  v.appendChild(body);
}

/* ---------- 主题（浅色 / 深色 / 跟随系统） ---------- */

/** 主题与应用偏好都存在内核里：内核端口每次都变，localStorage 活不过一次重启。 */
function applyTheme(theme) {
  const t = theme || "system";
  state.theme = t;
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
  state.dark = t === "dark" ||
    (t === "system" && !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches));
  // 成长页那张雷达图的颜色是从 CSS 变量读的：主题一换就重画一次
  const cv = document.querySelector(".ability-radar");
  const rows = state.report && state.report.abilities;
  if (cv && Array.isArray(rows)) setTimeout(() => drawRadar(cv, rows), 0);
}

function toggleTheme() {
  // 从"跟随系统"点一下时，切到与当前实际明暗相反的那一档（符合直觉）
  const next = state.dark ? "light" : "dark";
  applyTheme(next);
  savePrefs({ theme: next });
  buildNav();
  toast(next === "dark" ? "已切到深色" : "已切到浅色");
}

/**
 * 贴一个链接就读。
 *
 * 这是"零依赖"的那半边联网能力：不需要任何搜索服务，用户自己给的链接本身就是授权。
 * 抓完立刻把这一页的摘要贴进对话里当一条记录，并落本机缓存——不静默，也不假装读到了。
 */
async function openUrlFetchDialog() {
  const dlg = el("div", "card dialog");
  dlg.appendChild(cardHeadOnly("读取网页"));
  const row = el("div", "row");
  const input = inputOf("web-url", "https://…");
  input.className = "grow";
  row.appendChild(input);
  dlg.appendChild(fieldOf("网页地址", row));
  dlg.appendChild(el("p", "muted sm", "正文会落进本机 webcache，可以直接被引用（引用编号是 [W1] 这种）。"));
  const acts = el("div", "row");
  const goBtn = btn("读取", "primary", async () => {
    const url = input.value.trim();
    if (!url) { toast("先贴一个链接"); return; }
    goBtn.disabled = true;
    goBtn.textContent = "读取中…";
    try {
      const r = await api("/api/web/fetch", { url: url });
      dlg.remove();
      toast("已读取《" + r.title + "》");
      // 当成一条"用户给了资料"的消息塞进对话，方便接着提问
      const thread = $("chat-thread");
      if (thread) {
        const box = el("div", "turn-block");
        box.appendChild(el("div", "msg-who", "已读取网页"));
        const body = el("div", "note-body");
        body.innerHTML = md("**《" + r.title + "》**\n\n" + (r.excerpt || "") +
          "\n\n[来源](" + r.url + ") · 抓取于 " + r.fetchedAt + " · 已落本机");
        box.appendChild(body);
        thread.appendChild(box);
        thread.scrollTop = thread.scrollHeight;
      }
      const ta = $("chat-input");
      if (ta) {
        ta.value = "就我刚给你的这个网页（" + r.url + "）";
        ta.focus();
      }
    } catch (e) {
      toast("读取失败：" + e.message);
      goBtn.disabled = false;
      goBtn.textContent = "读取";
    }
  });
  acts.appendChild(goBtn);
  acts.appendChild(btn("取消", "ghost", () => dlg.remove()));
  dlg.appendChild(acts);
  const view = $("view");
  view.insertBefore(dlg, view.firstChild);
  input.focus();
}

/**
 * 技能清单 + 这段会话绑的技能。
 *
 * 技能是"用法说明书"：写个 <dataDir>/skills/<id>/SKILL.md 就多一种；内置的只读，用户自己的可以改。
 * 绑定是**会话级**的，换会话不串。
 */
async function loadSkills(sessionId) {
  try {
    const d = await api("/api/skills/list", { sessionId: sessionId || state.chatSessionId || "" });
    state.skills = d.skills || [];
    state.skill = d.bound || "";
  } catch (e) {
    state.skills = [];
    state.skill = "";
  }
}

/**
 * 这一段会话实际用哪一档联网。
 *
 * 会话里改过就用会话的，否则跟着设置——所以问内核时要带上 sessionId，
 * 不然界面会把"这次对话的选择"画成全局设置。
 */
async function loadWebMode(sessionId) {
  try {
    const r = await api("/api/web/cache", { sessionId: sessionId || state.chatSessionId || "" });
    state.webMode = r.mode || "auto";
  } catch (e) {
    state.webMode = "auto";
  }
}

async function loadPrefs() {
  try {
    const p = await api("/api/prefs/get", {});
    applyPrefs(p);
  } catch (e) {
    applyTheme("system");
  }
}

async function savePrefs(patch) {
  try {
    applyPrefs(await api("/api/prefs/save", patch));
  } catch (e) {
    toast("偏好保存失败：" + e.message);
  }
}

/** 把内核返回的偏好一次性应用到界面上（主题 + 两个侧栏状态）。 */
function applyPrefs(p) {
  applyTheme(p.theme);
  setPanelVisible(p.sessionRail !== "0");
}

/**
 * 显示 / 隐藏**第二层面板**（标题栏那个折叠按钮、Ctrl+Shift+S）。
 *
 * 注意收起的是第二层，不是最左侧那条窄栏：窄栏是功能树的第一层，永远在。
 * 状态存内核的 `ui_session_rail`——内核端口每次启动都变，不能只放 localStorage。
 */
function togglePanel(force) {
  const show = force === undefined ? state.panelHidden : !!force;
  setPanelVisible(show);
  savePrefs({ sessionRail: show ? "1" : "0" });
  toast(show ? "已展开功能面板" : "已收起功能面板（Ctrl+Shift+S 展开）");
}

/* ---------- 自绘窗口框：最小化 / 最大化 / 关闭 ---------- */

/**
 * 标题栏按钮接到预加载脚本暴露的三个方法上。
 *
 * 浏览器里打开同一份界面时（开发自测、E2E）没有这套能力，
 * 这时按钮不去假装能用——点一下会明确告诉你原因，也方便自动化验证接线。
 */
function initTitlebar() {
  const api = window.itnWindow || null;
  const bar = $("titlebar");
  const min = $("win-min");
  const max = $("win-max");
  const close = $("win-close");

  const wire = (node, label, run) => {
    if (!node) return;
    node.onclick = () => {
      if (api) {
        run(api);
      } else {
        toast(label + "只在桌面应用窗口里可用");
      }
    };
  };
  wire(min, "最小化", (a) => a.minimize());
  wire(max, "最大化", (a) => a.toggleMaximize());
  wire(close, "关闭窗口", (a) => a.close());

  if (bar) {
    // 双击标题栏切换最大化：Windows 上的习惯动作
    bar.addEventListener("dblclick", (e) => {
      if (e.target.closest(".tb-btn")) return;
      if (api) api.toggleMaximize();
    });
    if (!api) bar.classList.add("tb-browser");
  }
  const back = $("nav-back");
  const fwd = $("nav-forward");
  if (back) back.onclick = () => history.back();
  if (fwd) fwd.onclick = () => history.forward();
  const railToggle = $("rail-toggle");
  if (railToggle) railToggle.onclick = () => togglePanel();
  updateNavButtons();

  if (api && typeof api.onStateChange === "function") {
    api.onStateChange((st) => {
      const maximized = !!(st && st.maximized);
      document.body.classList.toggle("win-maximized", maximized);
      if (max) {
        const label = maximized ? "还原" : "最大化";
        max.title = label;
        max.setAttribute("aria-label", label);
      }
    });
  }
}

/* ---------- 全局检索（Ctrl/Cmd + K）：一条命令找遍资料、章节、笔记、产物 ---------- */

const palette = { open: false, query: "", items: [], active: 0, timer: null, cache: null, seq: 0 };

/** 打开时把章节/笔记/产物读一次，之后每次输入只在本地过滤；只有资料切片走服务端检索。 */
async function loadPaletteCache() {
  if (palette.cache) return palette.cache;
  await loadCfg();
  const [tree, notes, arts] = await Promise.all([
    api("/api/study/tree", { kbId: state.kb }).catch(() => ({ chapters: [] })),
    api("/api/study/notes/list", {}).catch(() => ({ notes: [] })),
    api("/api/artifacts/list", {}).catch(() => ({ artifacts: [] })),
  ]);
  palette.cache = { chapters: tree.chapters || [], tree: tree, notes: notes.notes || [], artifacts: arts.artifacts || [] };
  return palette.cache;
}

function paletteItemMain(label, sub, kind, run) {
  return { label: label, sub: sub || "", kind: kind || "", run: run, group: "" };
}

async function runPaletteSearch(raw) {
  const q = String(raw || "").trim();
  const lower = q.toLowerCase();
  const seq = (palette.seq = palette.seq + 1);
  const groups = [];
  const cache = palette.cache || { chapters: [], notes: [], artifacts: [] };
  const hit = (s) => String(s || "").toLowerCase().indexOf(lower) >= 0;

  if (q) {
    groups.push(["动作", [
      paletteItemMain("问助手：" + q, "就你的资料提问，会标出处", "对话", () => { state.pendingQuestion = q; go("chat"); }),
      paletteItemMain("就这个主题生成讲义：" + q, "检索资料 → 拟大纲 → 逐节写作", "生成", () => { go("learn"); setTimeout(() => askTopic("lecture", q), 300); }),
    ]]);
  }

  const chapters = cache.chapters.filter((c) => hit(c.name)).slice(0, 5)
    .map((c) => paletteItemMain(c.name, c.chunkCount + " 片 · 已读 " + c.readCount + (c.done ? " · 已完成" : ""), "章节", () => {
      state.chapter = c.name;
      go("learn");
    }));
  if (chapters.length) groups.push(["章节", chapters]);

  const notes = cache.notes.filter((n) => hit(n.title) || hit(n.text)).slice(0, 5)
    .map((n) => paletteItemMain(n.title || "无标题", (n.chapter ? n.chapter + " · " : "") + String(n.text || "").slice(0, 40), "笔记", () => go("notes")));
  if (notes.length) groups.push(["笔记", notes]);

  const arts = cache.artifacts.filter((a) => hit(a.name)).slice(0, 5)
    .map((a) => paletteItemMain(a.name, fmtSize(a.size) + (a.page > 0 ? " · 上次讲到第 " + a.page + " 页" : ""), "产物", () => openSlidePlayer(a.name)));
  if (arts.length) groups.push(["产物", arts]);

  let flat = [];
  for (const [title, items] of groups) {
    for (const it of items) {
      it.group = title;
      flat.push(it);
    }
  }

  // 资料切片：唯一需要打服务端的部分，输入 2 个字以上才查
  if (q.length >= 2 && state.kb) {
    try {
      const d = await api("/api/kb/search", { id: state.kb, query: q, topK: 5 });
      if (seq !== palette.seq) return;   // 期间用户又改了输入，这次结果作废
      const hits = (d.hits || []).map((h) => paletteItemMain(
        "《" + (h.docTitle || "") + "》" + (h.headingPath ? " · " + h.headingPath : ""),
        String(h.text || "").replace(/\s+/g, " ").slice(0, 70),
        "资料",
        () => {
          state.chapter = chapterNameOfHit(h);
          go("learn");
        }));
      if (hits.length) {
        const first = flat.length;
        flat = flat.concat(hits);
        groups.push(["资料切片", hits]);
        if (palette.active >= first) palette.active = 0;
      }
    } catch (e) {
      // 没有索引时检索会 404：给出可点的下一步，而不是静默空白
      groups.push(["资料切片", [paletteItemMain("还没法检索资料", e.message || "知识库没有索引", "提示", () => go("settings", "kb"))]]);
    }
  }

  flat = [];
  for (const [title, items] of groups) {
    for (const it of items) {
      it.group = title;
      flat.push(it);
    }
  }
  palette.items = flat;
  if (palette.active >= flat.length) palette.active = 0;
  renderPaletteList();
}

/** 切片命中 → 它属于哪一章（章节目录用的是章节名）。 */
function chapterNameOfHit(h) {
  const path = String((h && h.headingPath) || "");
  const first = path.split(" > ")[0];
  if (first) return first;
  return String((h && h.docTitle) || "");
}

function renderPaletteList() {
  const root = $("palette");
  if (!root || root.hidden) return;
  const list = root.querySelector(".palette-list");
  if (!list) return;
  list.innerHTML = "";
  if (!palette.items.length) {
    list.appendChild(el("div", "palette-empty", palette.query ? "没有匹配的内容" : "输入关键词：资料切片、章节、笔记、产物都会一起找"));
    return;
  }
  let lastGroup = "";
  palette.items.forEach((it, i) => {
    if (it.group !== lastGroup) {
      lastGroup = it.group;
      list.appendChild(el("div", "palette-group-title", it.group));
    }
    const b = el("button", "palette-item" + (i === palette.active ? " active" : ""));
    const main = el("div", "pi-main");
    main.appendChild(el("div", "pi-label", it.label));
    if (it.sub) main.appendChild(el("div", "pi-sub", it.sub));
    b.appendChild(main);
    if (it.kind) b.appendChild(el("span", "pi-kind", it.kind));
    b.onmouseenter = () => { palette.active = i; markPaletteActive(); };
    b.onclick = () => runPaletteItem(i);
    list.appendChild(b);
  });
}

function markPaletteActive() {
  const root = $("palette");
  if (!root) return;
  const nodes = root.querySelectorAll(".palette-item");
  nodes.forEach((n, i) => n.classList.toggle("active", i === palette.active));
  const cur = nodes[palette.active];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
}

function runPaletteItem(i) {
  const it = palette.items[i];
  if (!it) return;
  closePalette();
  try {
    it.run();
  } catch (e) {
    toast("打开失败：" + e.message);
  }
}

async function openPalette() {
  const root = $("palette");
  if (!root) return;
  palette.open = true;
  palette.query = "";
  palette.active = 0;
  palette.items = [];
  palette.cache = null;
  root.hidden = false;
  root.innerHTML = "";

  const box = el("div", "palette-box");
  const head = el("div", "palette-head");
  const input = el("input", "palette-input");
  input.id = "palette-input";
  input.placeholder = "找资料切片、章节、笔记、产物，或者直接问助手…";
  head.appendChild(input);
  const tip = el("div", "palette-tip");
  tip.innerHTML = "<kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 打开 · <kbd>Esc</kbd> 关闭";
  head.appendChild(tip);
  box.appendChild(head);
  box.appendChild(el("div", "palette-list"));
  root.appendChild(box);

  input.oninput = () => {
    palette.query = input.value;
    palette.active = 0;
    if (palette.timer) clearTimeout(palette.timer);
    palette.timer = setTimeout(() => { runPaletteSearch(input.value); }, 220);
  };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      palette.active = Math.min(palette.items.length - 1, palette.active + 1);
      markPaletteActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      palette.active = Math.max(0, palette.active - 1);
      markPaletteActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      runPaletteItem(palette.active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  };
  root.onclick = (e) => { if (e.target === root) closePalette(); };

  input.focus();
  await loadPaletteCache();
  await runPaletteSearch("");
}

function closePalette() {
  const root = $("palette");
  if (!root) return;
  if (palette.timer) { clearTimeout(palette.timer); palette.timer = null; }
  palette.open = false;
  root.hidden = true;
  root.innerHTML = "";
}

/* ---------- 课件播放器：把讲义/练习/章节按二级标题切成页，逐页讲授 ---------- */

const playerState = { key: "", name: "", slides: [], index: 0, fontSize: 18, tocOpen: false, saveTimer: null };

/**
 * 按标题把一份 Markdown 切成"页"。
 *
 * 优先按 `##`（讲义的小节）；如果整篇只有一个 `##` 页，再退回按 `###`（练习册每题一个三级标题）。
 * 都不行就整篇一页——宁可少切，也不要把一段话拦腰截断。
 */
function splitSlides(name, content) {
  const text = String(content || "");
  const base = String(name || "").replace(/\.md$/i, "");

  function cut(prefix) {
    const re = new RegExp("^" + prefix + "\\s+(.*)$");
    const out = [];
    let cur = null;
    for (const line of text.split("\n")) {
      const m = line.match(re);
      if (m) {
        if (cur) out.push(cur);
        cur = { title: m[1].trim(), body: [] };
        continue;
      }
      const h1 = line.match(/^#\s+(.*)$/);
      if (h1 && !cur && !out.length) {
        cur = { title: h1[1].trim(), body: [] };
        continue;
      }
      if (!cur) cur = { title: "", body: [] };
      cur.body.push(line);
    }
    if (cur) out.push(cur);
    return out.map((x) => ({ title: x.title, body: x.body.join("\n").replace(/\n{3,}/g, "\n\n").trim() }))
      .filter((x) => (x.title + x.body).trim().length > 0);
  }

  let slides = cut("##");
  if (slides.length <= 1) {
    const finer = cut("###");
    if (finer.length > 1) slides = finer;
  }
  if (!slides.length) slides = [{ title: base, body: text }];
  // 有的文档会出现"光有标题没有正文"的一页（模型在大纲标题下又写了一遍小节标题）。
  // 只要还有至少两页是有正文的，就把空白页去掉，免得讲课时翻到一页空白。
  const solid = slides.filter((x) => x.body.trim().length > 0);
  if (solid.length >= 2 && solid.length < slides.length) {
    const cover = slides[0].body.trim().length === 0 ? [slides[0]] : [];
    slides = cover.concat(solid);
  }
  return slides;
}

function applyPlayerFont() {
  const root = $("player");
  if (root) root.style.setProperty("--slide-font", playerState.fontSize + "px");
}

async function openSlidePlayer(name, content, key) {
  const root = $("player");
  if (!root) return;
  let text = content;
  if (text === undefined) {
    try {
      text = (await api("/api/artifacts/read", { name: name })).content;
    } catch (e) {
      toast("读不到这份产物：" + e.message);
      return;
    }
  }
  playerState.slides = splitSlides(name, text);
  playerState.name = name;
  playerState.key = key || name;
  playerState.tocOpen = false;
  let resume = 0;
  try {
    const p = await api("/api/artifacts/progress", { name: playerState.key });
    if (p && p.page > 0) resume = p.page;
  } catch (e) { /* 没有进度也能播 */ }
  playerState.index = Math.max(0, Math.min(playerState.slides.length - 1, resume - 1));
  root.hidden = false;
  document.body.classList.add("player-open");
  applyPlayerFont();
  renderPlayer();
  if (resume > 1) toast("从上次看到的第 " + resume + " 页继续");
}

function savePlayProgress(immediate) {
  if (!playerState.key) return;
  const body = { name: playerState.key, page: playerState.index + 1, pageCount: playerState.slides.length };
  if (playerState.saveTimer) { clearTimeout(playerState.saveTimer); playerState.saveTimer = null; }
  if (immediate) return api("/api/artifacts/progress/save", body).catch(() => {});
  playerState.saveTimer = setTimeout(() => {
    playerState.saveTimer = null;
    api("/api/artifacts/progress/save", body).catch(() => {});
  }, 500);
  return Promise.resolve();
}

function playerGo(index) {
  const max = playerState.slides.length - 1;
  const next = Math.max(0, Math.min(max, index));
  if (next === playerState.index) return;
  playerState.index = next;
  renderPlayer();
  savePlayProgress(false);
}

async function closePlayer() {
  const root = $("player");
  if (!root || root.hidden) return;
  if (document.fullscreenElement) {
    try { await document.exitFullscreen(); } catch (e) { /* ignore */ }
  }
  await savePlayProgress(true);
  root.hidden = true;
  document.body.classList.remove("player-open");
  if (current === "resources") go("resources");
}

async function togglePlayerFullscreen() {
  const root = $("player");
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await root.requestFullscreen();
  } catch (e) {
    toast("这个环境不支持全屏，可以先用窗口最大化");
  }
  renderPlayer();
}

function renderPlayer() {
  const root = $("player");
  if (!root) return;
  const total = playerState.slides.length;
  const slide = playerState.slides[playerState.index] || { title: "", body: "" };
  root.innerHTML = "";

  const head = el("div", "player-head");
  const info = el("div", "player-info");
  info.appendChild(el("div", "player-name", playerState.name));
  info.appendChild(el("div", "player-counter", "第 " + (playerState.index + 1) + " / " + total + " 页"));
  head.appendChild(info);
  const tools = el("div", "player-tools");
  tools.appendChild(btn("目录", "sm " + (playerState.tocOpen ? "primary" : "ghost"), () => {
    playerState.tocOpen = !playerState.tocOpen;
    renderPlayer();
  }));
  tools.appendChild(btn("A−", "sm ghost", () => { playerState.fontSize = Math.max(14, playerState.fontSize - 2); applyPlayerFont(); }));
  tools.appendChild(btn("A+", "sm ghost", () => { playerState.fontSize = Math.min(30, playerState.fontSize + 2); applyPlayerFont(); }));
  tools.appendChild(btn(document.fullscreenElement ? "退出全屏" : "全屏", "sm ghost", () => togglePlayerFullscreen()));
  tools.appendChild(btn("关闭", "sm", () => closePlayer()));
  head.appendChild(tools);
  root.appendChild(head);

  if (playerState.tocOpen) {
    const toc = el("div", "player-toc");
    playerState.slides.forEach((sl, i) => {
      const b = el("button", "toc-item" + (i === playerState.index ? " active" : ""));
      b.appendChild(el("span", "toc-idx", String(i + 1).padStart(2, "0")));
      b.appendChild(el("span", "toc-title", sl.title || "（无标题）"));
      b.onclick = () => { playerState.tocOpen = false; playerGo(i); };
      toc.appendChild(b);
    });
    root.appendChild(toc);
  }

  const body = el("div", "player-body");
  const page = el("article", "player-page");
  if (slide.title) page.appendChild(el("h1", "slide-title", slide.title));
  if (!slide.body) {
    // 封面页只有标题：说清楚这是封面，以及怎么往下走
    page.appendChild(el("p", "muted sm slide-cover-hint", "共 " + total + " 页 · 按「下一页」或 → 开始"));
  }
  const contentBox = el("div", "slide-content");
  contentBox.innerHTML = md(slide.body || "");
  page.appendChild(contentBox);
  body.appendChild(page);
  root.appendChild(body);

  const foot = el("div", "player-foot");
  const prev = btn("← 上一页", "", () => playerGo(playerState.index - 1));
  prev.disabled = playerState.index === 0;
  const next = btn("下一页 →", "primary", () => playerGo(playerState.index + 1));
  next.disabled = playerState.index >= total - 1;
  foot.appendChild(prev);
  foot.appendChild(next);
  const bar = el("div", "bar player-bar");
  bar.innerHTML = '<i style="width:' + pct(playerState.index + 1, total) + '%"></i>';
  foot.appendChild(bar);
  foot.appendChild(el("span", "player-hint", "← → 翻页 · 空格下一页 · T 目录 · Esc 关闭"));
  root.appendChild(foot);

  const bodyEl = root.querySelector(".player-body");
  if (bodyEl) bodyEl.scrollTop = 0;
}

async function playChapter(chapter) {
  try {
    const chap = await api("/api/study/chapter", { kbId: state.kb, chapter: chapter });
    const parts = ["# " + chapter, ""];
    for (const c of chap.chunks || []) {
      parts.push("## " + (c.headingPath || c.docTitle || "片段"));
      parts.push("");
      parts.push(c.text || "");
      parts.push("");
    }
    await openSlidePlayer(chapter, parts.join("\n"), "chapter:" + state.kb + ":" + chapter);
  } catch (e) {
    toast("取章节内容失败：" + e.message);
  }
}

/* ---------- 领域知识库 ---------- */

PAGES.kb = {
  async render() {
    await loadCfg();
    const v = $("view");
    v.innerHTML = "";
    if (!hasKb()) {
      v.appendChild(cardOf({
        body: emptyState({
          art: "db",
          title: "还没有知识库",
          text: "指定一个本机资料目录后，这里可以按关键词或向量检索，命中的每一段都能指回原文档位置。",
          actions: [btn("去指定资料目录", "primary", () => go("settings", "kb"))],
        }),
      }));
      return;
    }

    const k = state.cfg.knowledgeBases.find((x) => x.id === state.kb) || {};
    const card = el("div", "card");
    const head = el("div", "card-head");
    head.appendChild(el("h2", null, "检索"));
    head.appendChild(spacer());
    head.appendChild(tag(state.cfg.embedModelId ? "向量 + 关键词" : "关键词检索（未绑向量模型）"));
    card.appendChild(head);
    const row = el("div", "row");
    row.appendChild(kbSelector(null));
    const q = el("input");
    q.className = "grow";
    q.placeholder = "输入关键词或问题，例如「什么是提示词」";
    row.appendChild(q);
    row.appendChild(btn("检索", "primary", () => run()));
    card.appendChild(row);
    const out = el("div");
    out.style.marginTop = "14px";
    card.appendChild(out);
    v.appendChild(card);

    async function run() {
      const query = q.value.trim();
      if (!query) { toast("先输入要检索的内容"); return; }
      out.innerHTML = '<span class="spinner"></span> 检索中…';
      try {
        const d = await api("/api/kb/search", { id: state.kb, query: query, topK: 6 });
        out.innerHTML = "";
        out.appendChild(el("p", "muted sm", "命中 " + d.hits.length + " 段" + (d.mode ? " · " + d.mode + "检索" : "")));
        if (!d.hits.length) {
          out.appendChild(emptyState({
            inline: true,
            art: "search",
            title: "没有命中",
            text: "换一个更贴近资料原文的词试试；也可能是索引太旧了。",
            actions: [btn("重建索引", "", () => buildIndex(state.kb)), btn("去学 · 练", "", () => go("learn"))],
          }));
          return;
        }
        const list = el("div", "list");
        for (const h of d.hits) {
          const it = el("div", "item");
          it.appendChild(el("div", "item-title", "《" + (h.docTitle || "") + "》" + (h.headingPath ? " · " + h.headingPath : "")));
          it.appendChild(el("div", "meta", h.docPath + " · 相关度 " + Number(h.score || 0).toFixed(3)));
          const body = el("div", "hit-body");
          body.innerHTML = md(h.text);
          it.appendChild(body);
          if (h.caption) it.appendChild(el("p", "caption-note", "图片说明：" + h.caption));
          const acts = el("div", "row");
          acts.appendChild(btn("就这段提问", "sm ghost", () => askAboutChunk(h)));
          acts.appendChild(copyButton(() => h.text || "", "复制这段"));
          it.appendChild(acts);
          list.appendChild(it);
        }
        out.appendChild(list);
      } catch (e) {
        out.innerHTML = "";
        out.appendChild(emptyState({
          inline: true,
          art: "alert",
          title: "检索失败",
          text: e.message,
          actions: [btn("重建索引", "", () => buildIndex(state.kb)), btn("检查模型设置", "", () => go("models"))],
        }));
      }
    }
    q.onkeydown = (e) => { if (e.key === "Enter") run(); };

    let kbStats = null;
    try {
      kbStats = await api("/api/kb/stats", { id: state.kb });
    } catch (e) { /* 没建过索引就没有统计 */ }
    const stats = cardOf({
      title: "索引状态",
      sub: kbName(state.kb),
      actions: [btn("重建索引", "sm", () => buildIndex(state.kb)), btn("管理知识库", "sm ghost", () => go("settings", "kb"))],
    });
    if (!(k.chunkCount || 0)) {
      stats.appendChild(emptyState({
        inline: true,
        art: "alert",
        title: "还没有索引",
        text: "目录已登记（" + (k.rootDir || "未填写") + "），但还没有切片。建立索引后才能检索。",
        actions: [btn("现在建立索引", "primary", () => buildIndex(state.kb))],
      }));
    } else {
      const grid = el("div", "grid grid-4");
      grid.appendChild(statCard("文档", k.docCount || 0, "篇"));
      grid.appendChild(statCard("切片", k.chunkCount || 0, "片"));
      grid.appendChild(statCard("图片", k.imageCount || 0, "张"));
      grid.appendChild(statCard("建立时间", fmtStamp(k.builtAt) || "—", ""));
      stats.appendChild(grid);
      stats.appendChild(el("p", "muted sm", "目录：" + (k.rootDir || "")));
      // 向量服务不给 /embeddings 时索引照样建好了：这里如实说清楚，别让人以为坏了
      if (kbStats && kbStats.embedError) {
        const w = el("div", "skip-note");
        w.appendChild(el("div", "skip-title", "向量检索没启用（索引本身是好的）"));
        w.appendChild(el("div", "muted sm", String(kbStats.embedError).slice(0, 200) +
          "。当前用关键词检索；想用向量检索，把一个提供 /embeddings 的模型绑到「向量检索」后重建索引。"));
        stats.appendChild(w);
      }
      if (kbStats && kbStats.skippedSummary) {
        const warn = el("div", "skip-note");
        warn.appendChild(el("div", "skip-title", "上次建索引时未纳入：" + kbStats.skippedSummary));
        warn.appendChild(el("div", "muted sm", "这些文件读不了（PDF / Word / PPT 等），要么先转成 Markdown/文本，要么确认它们不需要参与检索。"));
        stats.appendChild(warn);
      }
    }
    v.appendChild(stats);
  },
};
/* ---------- 伴学助手：会话栏 + 主对话框（对标 Codex 的形态） ---------- */

const KIND_LABEL = { ask: "问答", lecture: "讲义", quiz: "练习", "": "对话" };
/** 联网档位的中文名（三处界面共用一份，免得各写各的）。 */
const WEB_MODE_LABEL = { off: "不联网", auto: "交给 agent 判断", always: "优先联网" };
const TOOL_LABEL = {
  kb_search: "检索知识库",
  web_search: "联网搜索（Tavily）",
  web_fetch: "读取网页",
  list_documents: "列出文档",
  read_chunk: "读取切片",
  current_time: "当前时间",
  calc: "计算",
  save_note: "写笔记",
  save_artifact: "写产物",
};

/**
 * 对话页的两栏形态开关。
 *
 * chat-mode 控制的是"整页变成对话框布局"（工具条、消息流、输入区固定）；
 * 会话栏是否真的显示是另一件事——用户可以把它收起来只留对话框。
 * 两个状态分开管，收起会话栏就不会把布局退回普通长页面。
 */
function setChatMode(on) {
  document.body.classList.toggle("chat-mode", !!on);
}

/** 第二层面板显隐。窄侧栏固定不动，折叠按钮收的是这一层。 */
function setPanelVisible(show) {
  state.panelHidden = !show;
  document.body.classList.toggle("panel-hidden", state.panelHidden);
}

async function reloadSessions() {
  await loadSessions();
  buildNav();
  // 会话列表就长在面板里：录完一轮要让它立刻出现
  if (current === "chat") await renderPanel();
}

/* ============================================================
   第二层面板：每个根功能都有自己的"第二层"
   ------------------------------------------------------------
   窄侧栏 = 功能树的第一层（固定不动）；点进去展开的是第二层：
   功能目录或列表（章节 / 笔记 / 错题 / 产物 / 会话 / 设置分区…）。
   面板只负责"挑一个"，细节永远在主区里——两栏各管一件事，不重复堆内容。
   ============================================================ */

const PANELS = {};

/** 面板头部：标题 + 若干图标按钮（26px，和标题栏按钮同一套手感）。 */
function panelHead(title, actions) {
  $("panel-title").textContent = title || "";
  const box = $("panel-actions");
  box.innerHTML = "";
  for (const a of actions || []) box.appendChild(a);
}

function panelBtn(iconName, label, onClick, id) {
  const b = el("button", "panel-btn");
  b.type = "button";
  if (id) b.id = id;
  b.setAttribute("aria-label", label);
  b.title = label;
  b.innerHTML = icon(iconName);
  b.onclick = onClick;
  return b;
}

/** 面板里的一条：标题 + 一行副信息；可高亮、可带 id（主区靠 id 定位）。 */
function panelItem(opt) {
  const b = el("button", "panel-item" + (opt.active ? " active" : ""));
  b.type = "button";
  if (opt.id !== undefined) b.dataset.id = String(opt.id);
  b.appendChild(el("div", "panel-item-title", opt.title || ""));
  if (opt.meta) b.appendChild(el("div", "panel-item-meta", opt.meta));
  b.onclick = opt.onClick;
  return b;
}

function panelGroup(text) { return el("div", "panel-group-title", text); }
function panelEmpty(text) { return el("div", "panel-empty", text); }

function panelSeg(items, activeKey, onPick) {
  const box = el("div", "panel-seg");
  for (const it of items) {
    const b = el("button", it.key === activeKey ? "active" : "", it.label);
    b.type = "button";
    b.onclick = () => onPick(it.key);
    box.appendChild(b);
  }
  return box;
}

/** 渲染当前页的第二层面板。 */
async function renderPanel() {
  const def = PANELS[current];
  const body = $("panel-body");
  const foot = $("panel-foot");
  if (!body || !foot) return;
  body.innerHTML = "";
  foot.innerHTML = "";
  panelHead(def ? def.title : (PAGE_META[current] || {}).title, def && def.actions ? def.actions() : []);
  if (!def || !def.render) return;
  const ui = { foot: (node) => { foot.innerHTML = ""; foot.appendChild(node); } };
  await def.render(body, ui);
}

/* ---------- 我的学习：开始 + 最近产物 ---------- */
PANELS.home = {
  title: "首页",
  async render(body, ui) {
    await loadOverview();
    const r = state.report || {};
    body.appendChild(panelGroup("今天"));
    // 清单本身在主区（新用户第一眼要看到它），这里只给"接着做什么"的捷径
    if (indexedKb()) {
      try {
        const tree = await api("/api/study/tree", { kbId: state.kb });
        const next = (tree.chapters || []).find((c) => !c.done);
        if (next) {
          body.appendChild(panelItem({
            id: next.name,
            title: "接着学：" + next.name,
            meta: "已读 " + next.readCount + " / " + next.chunkCount + " 片",
            onClick: () => { state.chapter = next.name; go("learn"); },
          }));
        }
      } catch (e) { /* 没有章节就什么都不放 */ }
    }
    if ((r.wrongDue || 0) > 0) {
      body.appendChild(panelItem({
        title: "今天该复习 " + r.wrongDue + " 条错题",
        meta: "按间隔复习排出来的",
        onClick: () => go("wrong"),
      }));
    }
    if (r.readChunks || r.completedChapters) {
      body.appendChild(panelItem({
        title: "已读 " + (r.readChunks || 0) + " 片 · 完成 " + (r.completedChapters || 0) + " 章",
        onClick: () => go("report"),
      }));
    }
    const arts = (state.artifacts || []).slice(0, 5);
    if (arts.length) {
      body.appendChild(panelGroup("最近产物"));
      for (const a of arts) {
        body.appendChild(panelItem({
          id: a.name,
          title: a.name,
          meta: fmtSize(a.size) + (a.page > 0 ? " · 上次讲到第 " + a.page + " 页" : ""),
          onClick: () => openArtifactByName(a.name),
        }));
      }
    }
    if (!body.querySelector(".panel-item")) {
      body.appendChild(panelEmpty("先从主区的「开始使用」五步走一遍。"));
    }
    ui.foot(btn("去我的资源", "sm", () => go("resources")));
  },
};

/* ---------- 学 · 练：章节列表 ---------- */
PANELS.learn = {
  title: "章节",
  actions: () => [panelBtn("gear", "管理知识库", () => go("settings", "kb"))],
  async render(body, ui) {
    await loadCfg();
    if (!hasKb()) {
      body.appendChild(panelEmpty("还没有指定资料目录。"));
      ui.foot(btn("去指定资料目录", "primary sm", () => go("settings", "kb")));
      return;
    }
    if (!indexedKb()) {
      body.appendChild(panelEmpty("「" + kbName(state.kb) + "」还没有索引。"));
      ui.foot(btn("去建立索引", "primary sm", () => buildIndex(state.kb)));
      return;
    }
    let tree = { chapters: [] };
    try { tree = await api("/api/study/tree", { kbId: state.kb }); } catch (e) { /* 下面按空处理 */ }
    const chapters = tree.chapters || [];
    if (!chapters.length) {
      body.appendChild(panelEmpty("这个知识库还没有可学的章节。"));
      return;
    }
    body.appendChild(panelGroup("共 " + chapters.length + " 章"));
    for (const c of chapters) {
      body.appendChild(panelItem({
        id: c.name,
        active: state.chapter === c.name,
        title: c.name,
        meta: c.chunkCount + " 片 · 已读 " + c.readCount + (c.done ? " · 已完成" : ""),
        onClick: () => { state.chapter = c.name; go("learn"); },
      }));
    }
    if (state.chapter) ui.foot(btn("返回章节目录", "sm", () => { state.chapter = null; go("learn"); }));
  },
};

/* ---------- 笔记 ---------- */
PANELS.notes = {
  title: "笔记",
  actions: () => [panelBtn("plus", "写一条笔记", () => openNoteEditor(null, state.kb, state.chapter || ""))],
  async render(body) {
    await loadCfg();
    let notes = [];
    try { notes = (await api("/api/study/notes/list", {})).notes || []; } catch (e) { notes = []; }
    if (!notes.length) {
      body.appendChild(panelEmpty("还没有笔记。读资料时点「就这段记笔记」会存到这里。"));
      return;
    }
    body.appendChild(panelGroup("共 " + notes.length + " 条"));
    for (const n of notes) {
      body.appendChild(panelItem({
        id: n.id,
        title: n.title || "无标题",
        meta: (n.chapter ? n.chapter + " · " : "") + (n.updatedAt ? fmtStamp(n.updatedAt).slice(6) : ""),
        onClick: () => go("notes", null, { focus: n.id }),
      }));
    }
  },
};

/* ---------- 错题本 ---------- */
PANELS.wrong = {
  title: "错题",
  async render(body, ui) {
    await loadCfg();
    let all = [];
    try { all = (await api("/api/study/wrong", {})).records || []; } catch (e) { all = []; }
    const due = all.filter((r) => r.due);
    const mastered = all.filter((r) => r.mastered);
    const tab = state.wrongTab || "due";
    const pool = tab === "due" ? due : tab === "mastered" ? mastered : all;
    body.appendChild(panelSeg([
      { key: "due", label: "待复习 " + due.length },
      { key: "mastered", label: "已掌握 " + mastered.length },
      { key: "all", label: "全部 " + all.length },
    ], tab, (k) => { state.wrongTab = k; go("wrong"); }));
    if (!pool.length) {
      body.appendChild(panelEmpty(all.length ? "这个分类下是空的。" : "还没有错题。答题答错会自动进来，并按间隔安排复习。"));
      return;
    }
    for (const r of pool) {
      body.appendChild(panelItem({
        id: r.id,
        title: r.question || "（题干缺失）",
        meta: (r.chapter ? r.chapter + " · " : "") + (r.mastered ? "已掌握" : r.due ? "今天该重做" : r.dueMs ? daysUntil(r.dueMs) + " 天后复习" : ""),
        onClick: () => go("wrong", null, { focus: r.id }),
      }));
    }
    if (due.length) ui.foot(btn("开始复习（" + due.length + " 条）", "primary sm", () => openRedo(due[0])));
  },
};

/* ---------- 我的成长 ---------- */
PANELS.report = {
  title: "我的成长",
  async render(body, ui) {
    await loadOverview();
    const r = state.report || {};
    body.appendChild(panelGroup("概览"));
    const rows = [
      ["已读切片", r.readChunks || 0],
      ["完成章节", r.completedChapters || 0],
      ["答题总数", r.quizTotal || 0],
      ["答题正确率", (r.quizTotal ? Math.round((r.quizRight || 0) * 100 / r.quizTotal) : 0) + "%"],
    ];
    for (const [k, v] of rows) {
      const line = el("div", "panel-kv");
      line.appendChild(el("span", "k", k));
      line.appendChild(el("span", "v", String(v)));
      body.appendChild(line);
    }
    const scores = (state.profile || {}).selfScores || {};
    body.appendChild(panelGroup("能力维度（自评）"));
    for (const d of ABILITY_DIMENSIONS) {
      body.appendChild(panelItem({
        id: d.key,
        title: d.key,
        meta: scores[d.key] === undefined ? "未填" : scores[d.key] + " 分",
        onClick: () => go("calibrate", null, { focus: d.key }),
      }));
    }
    ui.foot(btn("去做画像校准", "sm primary", () => go("calibrate")));
  },
};

/* ---------- 画像校准 ---------- */
PANELS.calibrate = {
  title: "六个维度",
  async render(body, ui) {
    await loadCfg();
    await loadProfile();
    const scores = (state.profile || {}).selfScores || {};
    body.appendChild(panelGroup("点一个维度，直接跳到它那一档"));
    for (const d of ABILITY_DIMENSIONS) {
      const cur = state.calib ? state.calib[d.key] : undefined;
      const lv = cur !== undefined ? ABILITY_LEVELS[cur] : null;
      body.appendChild(panelItem({
        id: d.key,
        title: d.key,
        meta: lv ? "选到「" + lv.label + "」" : (scores[d.key] === undefined ? "未填" : "已填 " + scores[d.key]),
        onClick: () => go("calibrate", null, { focus: d.key }),
      }));
    }
    ui.foot(btn("去我的成长", "sm", () => go("report")));
  },
};

/* ---------- 我的资源 ---------- */
PANELS.resources = {
  title: "产物",
  actions: () => [panelBtn("refresh", "刷新", () => go("resources"))],
  async render(body, ui) {
    await loadArtifacts();
    if (!state.artifacts.length) {
      body.appendChild(panelEmpty("还没有产物。讲义与练习册会落在这里，全是本机 Markdown。"));
      ui.foot(btn("去生成一份", "primary sm", () => go("learn")));
      return;
    }
    const search = inputOf("panel-artifact-search", "搜索文件名", state.artifactQuery || "");
    search.className = "panel-search";
    search.oninput = () => { state.artifactQuery = search.value; renderPanel(); };
    body.appendChild(search);
    const kind = state.artifactFilter || "all";
    const filterBtn = (k) => {
      state.artifactFilter = k;
      go("resources");
    };
    body.appendChild(panelSeg([
      { key: "all", label: "全部" },
      { key: "lecture", label: "讲义" },
      { key: "quiz", label: "练习册" },
    ], kind, filterBtn));
    const q = String(state.artifactQuery || "").trim().toLowerCase();
    const items = state.artifacts.filter((a) =>
      (kind === "all" || ARTIFACT_KIND(a.name) === kind) && (!q || String(a.name).toLowerCase().indexOf(q) >= 0));
    if (!items.length) {
      body.appendChild(panelEmpty("没有匹配的产物。"));
      return;
    }
    for (const a of items) {
      body.appendChild(panelItem({
        id: a.name,
        active: state.artifactFocus === a.name,
        title: a.name,
        meta: fmtSize(a.size) + " · " + (ARTIFACT_KIND_LABEL[ARTIFACT_KIND(a.name)] || "产物"),
        onClick: () => go("resources", null, { focus: a.name }),
      }));
    }
  },
};

/* ---------- 领域知识库 ---------- */
PANELS.kb = {
  title: "知识库",
  actions: () => [panelBtn("plus", "登记知识库", () => go("settings", "kb"))],
  async render(body, ui) {
    await loadCfg();
    const kbs = state.cfg.knowledgeBases || [];
    if (!kbs.length) {
      body.appendChild(panelEmpty("还没有知识库。指定一个本机目录，扫描后就能检索。"));
      ui.foot(btn("去登记", "primary sm", () => go("settings", "kb")));
      return;
    }
    for (const k of kbs) {
      body.appendChild(panelItem({
        id: k.id,
        active: state.kb === k.id,
        title: k.name || k.id,
        meta: (k.chunkCount || 0) > 0
          ? (k.docCount || 0) + " 篇 · " + (k.chunkCount || 0) + " 片"
          : "还没建索引",
        onClick: () => {
          if (state.kb === k.id) return;
          state.kb = k.id;
          toast("已切到「" + (k.name || k.id) + "」");
          go("kb");
        },
      }));
    }
    ui.foot(btn("管理知识库目录", "sm", () => go("settings", "kb")));
  },
};

/* ---------- 伴学助手：会话列表 ---------- */
PANELS.chat = {
  title: "对话",
  actions: () => [panelBtn("plus", "新建对话", () => newChat(), "rail-new")],
  async render(body, ui) {
    await loadSessions();
    const search = inputOf("rail-search", "搜索会话标题", state.chatQuery || "");
    search.className = "panel-search";
    search.oninput = () => { state.chatQuery = search.value; renderPanel(); };
    body.appendChild(search);
    const q = String(state.chatQuery || "").trim().toLowerCase();
    const items = state.sessions.filter((x) => !q || String(x.title || "").toLowerCase().indexOf(q) >= 0);
    if (!items.length) {
      const only = btn("全部会话与步骤 →", "sm ghost", () => go("chat", "overview"));
      only.id = "rail-all";
      body.appendChild(panelEmpty(state.sessions.length ? "没有匹配的会话。" : "还没有对话。点右上角的 ＋ 开一段。"));
      ui.foot(only);
      return;
    }
    body.appendChild(panelGroup("共 " + state.sessions.length + " 段"));
    for (const x of items) {
      body.appendChild(panelItem({
        id: x.sessionId,
        active: x.sessionId === state.chatSessionId,
        title: x.title || "新对话",
        meta: (KIND_LABEL[x.kind || ""] || "对话") + (x.kbId ? " · " + kbName(x.kbId) : "") + " · " + fmtStamp(x.lastAt).slice(6),
        onClick: () => openChatSession(x.sessionId),
      }));
    }
    const all = btn("全部会话与步骤 →", "sm ghost", () => go("chat", "overview"));
    all.id = "rail-all";
    ui.foot(all);
  },
};

/* ---------- 设置：分区 ---------- */
PANELS.settings = {
  title: "设置",
  async render(body, ui) {
    const nav = el("nav", "settings-nav");
    nav.setAttribute("aria-label", "设置分区");
    const active = SETTINGS_SECTIONS.filter((x) => x.id === currentSection)[0] || SETTINGS_SECTIONS[0];
    for (const x of SETTINGS_SECTIONS) {
      const b = el("button", x.id === active.id ? "active" : "");
      b.type = "button";
      b.dataset.section = x.id;
      b.innerHTML = icon(x.icon) + "<span>" + esc(x.label) + "</span>";
      b.onclick = () => { if (x.id !== active.id) go("settings", x.id); };
      nav.appendChild(b);
    }
    body.appendChild(nav);
    ui.foot(btn("数据与备份", "sm ghost", () => go("settings", "data")));
  },
};

/**
 * 打开一段旧会话。
 *
 * 一次会话是关于某个知识库的：打开它就把当前知识库切回去——否则用户会拿着「数学」的资料
 * 去问「语文」的会话，答出来的东西自然对不上。
 */
async function openChatSession(id) {
  const meta = (state.sessions || []).filter((x) => x.sessionId === id)[0];
  if (meta && meta.kbId && state.kb !== meta.kbId && state.cfg.knowledgeBases.some((k) => k.id === meta.kbId)) {
    state.kb = meta.kbId;
    toast("已切回这次会话用的知识库：" + kbName(meta.kbId));
  }
  state.chatSessionId = id;
  go("chat");
}

async function newChat() {
  try {
    const d = await api("/api/sessions/new", {});
    state.chatSessionId = d.sessionId;
    state.chatEvents = [];
    state.chatTurns = [];
    go("chat");
  } catch (e) {
    toast("新建会话失败：" + e.message);
  }
}

/** 把只追加的事件还原成可渲染的轮次。界面永远以事件为准，不自己编对话。 */
function turnsFromEvents(events) {
  const turns = [];
  const byKey = {};
  for (const e of events) {
    const key = e.turnId || "—";
    if (!byKey[key]) {
      byKey[key] = { id: key, kind: "", user: "", answer: "", deltas: "", tools: [], report: null, citations: [], ok: null, message: "" };
      turns.push(byKey[key]);
    }
    const t = byKey[key];
    const p = e.payload || {};
    if (e.type === "turn/start") t.kind = p.kind || "";
    else if (e.type === "user/message") t.user = p.text || "";
    else if (e.type === "assistant/delta") t.deltas += (p.text || "");
    else if (e.type === "assistant/message") t.answer = p.text || "";
    else if (e.type === "tool/call") t.tools.push({ name: p.tool || "", args: p.args || {}, summary: "" });
    else if (e.type === "tool/result") {
      let target = null;
      for (const x of t.tools) { if (x.name === p.tool && !x.summary) target = x; }
      if (!target && t.tools.length) target = t.tools[t.tools.length - 1];
      if (target) target.summary = p.summary || "";
    } else if (e.type === "validation") {
      t.report = p.report || null;
      t.citations = p.citations || [];
    } else if (e.type === "turn/end") {
      t.ok = p.ok !== false;
      t.message = p.message || "";
    }
  }
  return turns;
}

function renderToolRows(tools) {
  const box = el("div", "tool-rows");
  for (const tool of tools) {
    const row = el("div", "tool-row" + (tool.summary ? "" : " running"));
    row.appendChild(el("span", "tool-dot"));
    let label = TOOL_LABEL[tool.name] || tool.name || "工具";
    if (tool.args && tool.args.query) label += "：「" + tool.args.query + "」";
    if (tool.args && tool.args.expr) label += "：" + tool.args.expr;
    if (tool.args && tool.args.chunk_id) label += "：" + tool.args.chunk_id;
    row.appendChild(el("span", "tool-name", label));
    row.appendChild(el("span", "tool-sum", tool.summary || "执行中…"));
    box.appendChild(row);
  }
  return box;
}

function renderTurnBlock(t, live) {
  const box = el("div", "turn-block");
  if (t.user) {
    const u = el("div", "msg msg-user");
    u.appendChild(el("div", "msg-who", "我"));
    const b = el("div", "msg-body");
    b.innerHTML = md(t.user);
    u.appendChild(b);
    box.appendChild(u);
  }
  if (t.tools.length) box.appendChild(renderToolRows(t.tools));
  const text = t.answer || (live ? t.deltas : "");
  if (text) {
    const a = el("div", "msg msg-ai");
    a.appendChild(el("div", "msg-who", "伴学助手"));
    const b = el("div", "msg-body");
    b.innerHTML = md(text);
    if (live && !t.answer) b.appendChild(el("span", "caret"));
    a.appendChild(b);
    if (!live && (t.citations.length || t.report)) a.appendChild(citationBox(t.citations, t.report));
    if (!live && t.answer) {
      const acts = el("div", "row msg-actions");
      acts.appendChild(btn("做成讲义", "sm ghost", () => askTopic("lecture", topicFromText(t.user || t.answer))));
      acts.appendChild(btn("做成练习册", "sm ghost", () => askTopic("quiz", topicFromText(t.user || t.answer))));
      acts.appendChild(copyButton(() => t.answer, "复制"));
      a.appendChild(acts);
    }
    box.appendChild(a);
  } else if (live) {
    // 提问后到第一段文字到达之间，什么都不显示会让人以为没点上——
    // 这里给一个明确的"正在进行"占位
    const p = el("div", "msg msg-ai");
    p.appendChild(el("div", "msg-who", "伴学助手"));
    const b = el("div", "msg-body");
    b.innerHTML = '<span class="spinner"></span> 正在检索资料并作答…';
    p.appendChild(b);
    box.appendChild(p);
  } else if (!live && t.ok === false) {
    const cancelled = String(t.message || "").indexOf("取消") >= 0;
    const e = el("div", "msg msg-ai");
    e.appendChild(el("div", "msg-who", "伴学助手"));
    e.appendChild(el("div", "msg-body " + (cancelled ? "muted" : "err-text"),
      t.message || "这一轮没有完成"));
    if (cancelled && t.user) {
      const acts = el("div", "row msg-actions");
      acts.appendChild(btn("重新问一次", "sm ghost", () => {
        if (state.chatResend) state.chatResend(t.user);
      }));
      e.appendChild(acts);
    }
    box.appendChild(e);
  }
  return box;
}

PAGES.chat = {
  async render() {
    // 会话总览（原「会话记录」页）并进来的入口：同一个页面，两种视图
    if (currentSection === "overview") { await renderSessionsOverview(); return; }
    await loadCfg();
    await loadWebMode(state.chatSessionId);
    await loadSkills(state.chatSessionId);
    setChatMode(true);
    const v = $("view");
    v.innerHTML = "";

    if (!hasChatModel()) {
      v.appendChild(cardOf({
        body: emptyState({
          art: "gear",
          title: "还没有可用的对话模型",
          text: "桌面版用你自己的模型服务：填一次 Base URL 和 API Key，把「对话与生成」绑上去，就能开始对话。",
          actions: [btn("去配置模型", "primary", () => go("models"))],
        }),
      }));
      await renderPanel();
      return;
    }

    /* 顶部工具条 */
    const bar = el("div", "chat-head");
    if (hasKb()) bar.appendChild(kbSelector(() => {
      // 换知识库等于换了一套资料：接着用旧会话会把两边的资料混在一起，
      // 所以明确开一段新会话，并把原因说出来（旧会话仍留在会话栏里）
      state.chatSessionId = "";
      state.chatTurns = [];
      state.chatEvents = [];
      toast("已切到「" + kbName(state.kb) + "」，从这条消息开始用新资料（已开新会话）");
      go("chat");
    }));
    else bar.appendChild(tag("未配知识库 · 直接问模型", "warn"));
    bar.appendChild(spacer());
    if (hasKb()) bar.appendChild(tag("检索：" + kbName(state.kb)));
    const toolBtn = btn("工具 " + (state.tools ? state.tools.length : ""), "sm ghost", () => {
      const box = $("tool-sheet");
      if (box) box.hidden = !box.hidden;
    });
    bar.appendChild(toolBtn);
    bar.appendChild(btn("全部会话", "sm ghost", () => go("chat", "overview")));
    v.appendChild(bar);

    const sheet = el("div", "card tool-sheet");
    sheet.id = "tool-sheet";
    sheet.hidden = true;
    sheet.appendChild(el("div", "card-head", ""));
    sheet.querySelector(".card-head").appendChild(el("h2", null, "Agent 可调用的工具"));
    sheet.querySelector(".card-head").appendChild(spacer());
    const curSkill = (state.skills || []).find((x) => x.id === state.skill);
    if (curSkill) {
      sheet.querySelector(".card-head").appendChild(tag("技能：" + curSkill.title, "ok"));
      sheet.appendChild(el("p", "muted sm",
        "这次对话绑了技能「" + curSkill.title + "」：只有它声明的工具（" + (curSkill.tools || []).join(" / ") +
        "）能调用，别的会被拒绝并记进会话。"));
    }
    const tlist = el("div", "list");
    const tools = state.tools || [];
    if (!tools.length) {
      tlist.appendChild(el("div", "muted sm", "（还没读到工具清单）"));
    } else {
      for (const t of tools) {
        const it = el("div", "item");
        const head = el("div", "row");
        const main = el("div", "grow");
        main.appendChild(el("div", "item-title", (TOOL_LABEL[t.name] || t.name) + "  " + t.name));
        main.appendChild(el("div", "muted sm", t.desc));
        head.appendChild(main);
        // 只有联网搜索需要先配置：没配就不进提示词，这里如实标出来并给出入口
        if (t.available === false) {
          head.appendChild(tag("需先配置", "warn"));
          head.appendChild(btn("去配置", "sm", () => go("settings", "models")));
        }
        it.appendChild(head);
        it.appendChild(el("div", "meta", "参数示例 " + t.usage));
        tlist.appendChild(it);
      }
    }
    sheet.appendChild(tlist);
    v.appendChild(sheet);

    /* 对话正文 */
    const thread = el("div", "chat-thread");
    thread.id = "chat-thread";
    v.appendChild(thread);

    /* 对话框：Codex 那种"一整块圆角输入区"——
       上面是任务描述，下面一行是 [＋ 动作] [权限/联网] … [当前模型] [发送]。
       这是 agent：能不能联网由 agent 自己判断，不在这里让用户选工作流。 */
    const inputRow = el("div", "composer");
    const ta = el("textarea");
    ta.id = "chat-input";
    ta.rows = 1;
    ta.placeholder = "描述任务，输入 / 调用技能";
    inputRow.appendChild(ta);

    const crow = el("div", "composer-row");
    const plusBtn = el("button", "composer-icon", "");
    plusBtn.type = "button";
    plusBtn.setAttribute("aria-label", "更多动作");
    plusBtn.title = "更多动作";
    plusBtn.innerHTML = icon("plus");
    crow.appendChild(plusBtn);

    const webChip = el("button", "composer-chip", "");
    webChip.type = "button";
    const paintWebChip = () => {
      const off = (state.webMode || "auto") === "off";
      webChip.classList.toggle("off", off);
      webChip.innerHTML = icon("shield") +
        "<span>" + (off ? "不联网" : "交给 agent 判断") + "</span>" + icon("chevron");
      webChip.title = off ? "本次对话不允许联网（点开 ＋ 可改）" : "需要最新信息时，agent 自己决定要不要联网";
    };
    paintWebChip();
    crow.appendChild(webChip);

    const skillChip = el("button", "composer-chip", "");
    skillChip.type = "button";
    const paintSkillChip = () => {
      const cur = (state.skills || []).find((x) => x.id === state.skill);
      skillChip.classList.toggle("off", !cur);
      skillChip.innerHTML = icon("book") + "<span>技能：" + esc(cur ? cur.title : "自动") + "</span>" + icon("chevron");
      skillChip.title = cur
        ? "这次对话用技能「" + cur.title + "」，只允许：" + (cur.tools || []).join("/")
        : "让模型自己决定要不要读技能（输入 / 也能直接挑）";
    };
    paintSkillChip();
    crow.appendChild(skillChip);
    crow.appendChild(spacer());

    const modelChip = el("button", "composer-chip", "");
    modelChip.type = "button";
    modelChip.title = "当前对话模型（点开去设置）";
    modelChip.innerHTML = '<span class="composer-dot"></span><span>' +
      esc(modelLabel(state.cfg.chatModelId) || state.cfg.chatModelId || "未配置模型") + "</span>" + icon("chevron");
    modelChip.onclick = () => go("settings", "models");
    crow.appendChild(modelChip);

    const stopBtn = el("button", "composer-icon", "");
    stopBtn.type = "button";
    stopBtn.setAttribute("aria-label", "停止");
    stopBtn.title = "停止这一轮";
    stopBtn.innerHTML = icon("check");
    stopBtn.style.display = "none";
    stopBtn.onclick = async () => {
      stopBtn.disabled = true;
      try {
        await api("/api/agent/cancel", { sessionId: state.chatSessionId });
        toast("已请求停止，正在收尾…");
      } catch (e) {
        toast("停止失败：" + e.message);
      }
    };
    crow.appendChild(stopBtn);

    const sendBtn = el("button", "composer-send", "");
    sendBtn.type = "button";
    sendBtn.setAttribute("aria-label", "发送");
    sendBtn.title = "发送（Enter）";
    sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
    sendBtn.onclick = () => send();
    crow.appendChild(sendBtn);

    // 菜单懒建：没打开过就一个按钮都不存在，免得和页面别处的同名按钮撞上
    const menu = el("div", "composer-menu");
    menu.hidden = true;
    let menuBuilt = false;
    inputRow.appendChild(crow);
    v.appendChild(inputRow);

    /* ＋ 菜单：只放真做得成的事，不放"技能""编排模式"这类还没有的东西 */
    let closeMenu = () => { menu.hidden = true; };
    const buildMenu = () => {
      const actionsBox = el("div", "cm-actions");
    const menuItem = (iconName, label, hint, onClick) => {
      const b2 = el("button", "composer-menu-item");
      b2.type = "button";
      b2.innerHTML = icon(iconName) + '<span class="cm-text"><span class="cm-label">' + esc(label) + "</span>" +
        (hint ? '<span class="cm-hint">' + esc(hint) + "</span>" : "") + "</span>";
      b2.onclick = () => { closeMenu(); onClick(); };
      return b2;
    };
      actionsBox.appendChild(menuItem("globe", "读取网页…", "贴一个链接，抓正文落到本机", () => openUrlFetchDialog()));
      actionsBox.appendChild(menuItem("db", "添加资料目录…", "选一个本机目录加入知识库", async () => {
      const a2 = window.itnWindow;
      if (!a2 || typeof a2.pickDirectory !== "function") {
        toast("选目录只在桌面应用窗口里可用");
        go("settings", "kb");
        return;
      }
      const dir = await a2.pickDirectory();
      if (!dir) return;
      go("settings", "kb");
      const el2 = $("kb-dir");
      if (el2) {
        el2.value = dir;
        const base = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
        const idEl = $("kb-id");
        if (idEl && !idEl.value.trim() && base) idEl.value = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
        const nameEl = $("kb-name");
        if (nameEl && !nameEl.value.trim()) nameEl.value = base;
      }
    }));
      actionsBox.appendChild(menuItem("layers", "做成讲义 / 练习册…", "把某一章做成产物", () => {
      const topic = topicFromText(state.lastQuestion || "");
      askTopic("lecture", topic);
    }));
      actionsBox.appendChild(menuItem("refresh", "清空抓取缓存…", "删掉所有抓回来的网页", async () => {
      try {
        const c = await api("/api/web/cache", {});
        for (const pg of (c.pages || [])) {
          await api("/api/web/cache/delete", { name: pg.name });
        }
        toast("已清空 " + (c.pages || []).length + " 页抓取缓存");
      } catch (e) { toast("清空失败：" + e.message); }
    }));
      actionsBox.appendChild(menuItem("target", "联网方式", "默认交给 agent 自己判断", () => {}));
      const webBox = el("div", "composer-menu-sub");
    for (const m of ["auto", "always", "off"]) {
        const b3 = el("button", "composer-menu-item" + (m === (state.webMode || "auto") ? " active" : ""), "");
      b3.type = "button";
      b3.innerHTML = '<span class="cm-text"><span class="cm-label">' + esc(WEB_MODE_LABEL[m]) + "</span></span>";
      b3.onclick = async () => {
        closeMenu();
        state.webMode = m;
        paintWebChip();
        try {
          // 还没开始对话就先开一段：联网方式是"这一段会话"的，得有会话才存得住
          if (!state.chatSessionId) {
            state.chatSessionId = (await api("/api/sessions/new", {})).sessionId;
          }
          await api("/api/web/session", { sessionId: state.chatSessionId, mode: m });
          paint();
          toast("这次对话的联网方式：" + WEB_MODE_LABEL[m]);
        } catch (e) { toast("设置失败：" + e.message); }
      };
        webBox.appendChild(b3);
      }
      actionsBox.appendChild(webBox);
      menu.appendChild(actionsBox);

      // 技能：自动 / 每个技能（不可用的标出来，点了不假装能跑）
      const skillBox = el("div", "cm-skills");
      const pick = async (id) => {
        closeMenu();
        const prev = state.skill;
        state.skill = id;
        paintSkillChip();
        try {
          if (!state.chatSessionId) {
            state.chatSessionId = (await api("/api/sessions/new", {})).sessionId;
          }
          await api("/api/skills/bind", { sessionId: state.chatSessionId, skill: id });
          // 整页重画一次：工具面板上那句"这次只允许…"、chip、会话 id 都要跟着更新
          // （会话正文是从事件里还原的，重画不会丢东西）
          go("chat");
          const cur = (state.skills || []).find((x) => x.id === id);
          toast(id ? "这次对话用技能：「" + (cur ? cur.title : id) + "」" : "技能交给模型自己决定");
        } catch (e) {
          state.skill = prev;
          paintSkillChip();
          toast("绑定技能失败：" + e.message);
        }
      };
      skillBox.appendChild(menuItem("refresh", "自动", "不指定，模型自己决定要不要读技能", () => pick("")));
      for (const sk of (state.skills || [])) {
        const b4 = menuItem("book", sk.title + (sk.source === "bundled" ? "（内置）" : ""),
          sk.available ? ("允许的工具：" + (sk.tools || []).join("/")) : (sk.reason || "不可用"),
          () => { if (sk.available) pick(sk.id); else toast(sk.reason || "这个技能现在不可用"); });
        if (sk.id === state.skill) b4.classList.add("active");
        if (!sk.available) b4.classList.add("disabled");
        skillBox.appendChild(b4);
      }
      if (!(state.skills || []).length) {
        skillBox.appendChild(el("div", "cm-hint", "还没有技能：设置 → 技能 里可以新建一个。"));
      }
      menu.appendChild(skillBox);
    };

    /** 两种开法：＋ 打开全部；输入 / 只挑技能。 */
    const openMenu = (mode) => {
      if (!menuBuilt) {
        buildMenu();
        inputRow.appendChild(menu);
        menuBuilt = true;
        document.addEventListener("click", closeMenu);
      }
      menu.hidden = false;
      const acts = menu.querySelector(".cm-actions");
      if (acts) acts.hidden = mode === "skills";
    };

    plusBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (menuBuilt && !menu.hidden) { closeMenu(); return; }
      openMenu("all");
    };
    webChip.onclick = (ev) => { ev.stopPropagation(); openMenu("all"); };
    skillChip.onclick = (ev) => { ev.stopPropagation(); openMenu("skills"); };

    // 输入框随内容长高（最多 8 行），像桌面聊天客户端那样
    const grow = () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    };
    ta.addEventListener("input", () => {
      grow();
      // 输入 / 就是"调用技能"（和 Codex 一样）：只出技能，不出别的动作
      if (ta.value.trimStart().startsWith("/")) openMenu("skills");
    });
    grow();

    if (state.pendingQuestion) {
      ta.value = state.pendingQuestion;
      state.pendingQuestion = "";
    }

    function paint() {
      // 会话 id 标在对话区上：自检要按"这一段会话"验联网档位，调试时也好对号
      thread.dataset.session = state.chatSessionId || "";
      thread.innerHTML = "";
      if (!state.chatTurns.length) {
        thread.appendChild(emptyState({
          art: "chat",
          title: state.chatSessionId ? "这个会话还没有内容" : "开始一段对话",
          text: hasKb()
            ? "例如：「这一章的核心结论是什么？」「资料里提到哪三种手法？」。回答会先检索「" + kbName(state.kb) + "」，逐条标注出处。"
            : "当前没有知识库，问题会直接发给模型；指定资料目录后回答会带出处。",
          actions: hasKb() ? [
            btn("问：这一章的核心结论是什么", "", () => { ta.value = "这一章的核心结论是什么？"; send(); }),
            btn("看知识库里有什么", "ghost", () => go("kb")),
          ] : [btn("去指定资料目录", "", () => go("settings", "kb"))],
        }));
      } else {
        for (const t of state.chatTurns) thread.appendChild(renderTurnBlock(t, !t.answer && state.busyTurn));
      }
      // 正在生成时才显示「停止」：用户点错了主题/问题，不用等它跑完
      stopBtn.style.display = state.busyTurn ? "" : "none";
      stopBtn.disabled = false;
      stopBtn.textContent = "停止";
      thread.scrollTop = thread.scrollHeight;
      const main = document.querySelector(".main");
      if (main) main.scrollTop = main.scrollHeight;
    }
    paint();

    async function send() {
      const text = ta.value.trim();
      if (!text) return;
      if (state.busyTurn) { toast("上一轮还在生成中"); return; }
      if (!state.chatSessionId) {
        try {
          state.chatSessionId = (await api("/api/sessions/new", {})).sessionId;
        } catch (e) { toast("新建会话失败：" + e.message); return; }
      }
      const sid = state.chatSessionId;
      ta.value = "";
      state.lastQuestion = text;
      state.busyTurn = true;
      // 允许"已取消"的那一轮一键重问（取消多半是因为问题写错了）
      state.chatResend = (q) => {
        const input = $("chat-input");
        if (input) input.value = q;
        send();
      };
      state.chatTurns.push({ id: "local", kind: "ask", user: text, answer: "", deltas: "", tools: [], report: null, citations: [], ok: null, message: "" });
      paint();

      // 生成过程中轮询会话事件，把 assistant/delta 渲染成"打字机"效果。
      // 内核 HTTP 是多线程的，长生成不会挡住这个轮询。
      const poll = setInterval(async () => {
        try {
          const d = await api("/api/sessions/events", { sessionId: sid });
          const all = d.events || [];
          if (all.length !== (state.chatEvents || []).length) {
            state.chatEvents = all;
            state.chatTurns = turnsFromEvents(all);
            paint();
          }
        } catch (e) { /* 轮询失败不打扰用户，最终结果以收尾时那次为准 */ }
      }, 400);

      let failure = "";
      try {
        const res = await api("/api/agent/ask", { kbId: state.kb, question: text, sessionId: sid, web: state.webMode, skill: state.skill });
        if (res.ok !== true) failure = res.message || "这一轮没有完成";
      } catch (e) {
        failure = e.message;
      }
      clearInterval(poll);
      try {
        const d = await api("/api/sessions/events", { sessionId: sid });
        state.chatEvents = d.events || [];
        state.chatTurns = turnsFromEvents(state.chatEvents);
      } catch (e) {
        state.chatTurns = state.chatTurns.filter((t) => t.id !== "local");
      }
      state.busyTurn = false;
      // 取消不是失败，别把提示写成"生成失败"
      if (failure) toast(String(failure).indexOf("取消") >= 0 ? "已取消" : ("生成失败：" + failure));
      await reloadSessions();
      paint();
    }

    ta.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    };
    sendBtn.onclick = send;

    /* 已有会话：把历史事件还原成线程 */
    if (state.chatSessionId) {
      try {
        const d = await api("/api/sessions/events", { sessionId: state.chatSessionId });
        state.chatEvents = d.events || [];
        state.chatTurns = turnsFromEvents(state.chatEvents);
        paint();
      } catch (e) {
        toast("读取会话失败：" + e.message);
      }
    }
    await renderPanel();
    ta.focus();
  },
};

function topicFromText(text) {
  const first = String(text || "").split("\n").map((s) => s.replace(/^[#>*\-\s]+/, "").trim()).filter(Boolean)[0] || "";
  return first.slice(0, 24) || "本段内容";
}

/* ---------- 会话记录：Agent 每一步都留痕 ---------- */

const EVENT_LABEL = {
  "assistant/delta": "流式增量",
  "turn/start": "开始一轮",
  "user/message": "用户输入",
  "step/start": "步骤开始",
  "step/end": "步骤结束",
  "tool/call": "调用工具",
  "tool/result": "工具结果",
  "assistant/message": "模型回复",
  "validation": "引用自检",
  "turn/end": "一轮结束",
};
const STEP_LABEL = {
  retrieve: "检索资料",
  answer: "生成回答",
  outline: "拟大纲",
  write_section: "逐节写作",
  quiz_create: "出题",
  citation_check: "引用自检",
  artifact_save: "保存产物",
  model_call: "调用模型",
  tool_exec: "执行工具",
};

function openSession(sessionId) {
  state.sessionId = sessionId;
  go("chat", "overview");
}

/**
 * 会话总览（原独立的「会话记录」页）。
 *
 * 会话栏已经挂在对话页左侧了，同一份数据再占一个侧栏入口，用户根本分不清
 * 「对话」和「记录」有什么区别。所以这里只保留一个视图对象，由对话页转发进来。
 */
const SESSIONS_VIEW = {
  async render() {
    await loadSessions();
    const v = $("view");
    v.innerHTML = "";
    $("page-title").textContent = "全部会话与步骤";
    $("page-sub").textContent = "每一次检索、生成都留了可追溯的过程";
    const ta = $("top-actions");
    ta.innerHTML = "";
    ta.appendChild(btn("回到对话", "sm primary", () => go("chat")));
    if (state.sessionId) {
      await renderSessionDetail(v, state.sessionId);
      return;
    }
    const card = cardOf({
      title: "全部会话",
      sub: "每次问答与生成都会留下只追加的事件",
      tag: state.sessions.length + " 条",
      actions: [btn("问一个问题", "sm primary", () => go("chat"))],
    });
    if (!state.sessions.length) {
      card.appendChild(emptyState({
        art: "clock",
        title: "还没有任何会话",
        text: "去伴学助手提一个问题，或者生成一份讲义，这里会记录检索、模型调用、引用自检的每一步。",
        actions: [btn("去提问", "primary", () => go("chat")), btn("去生成讲义", "", () => go("learn"))],
      }));
    } else {
      const list = el("div", "list");
      for (const s of state.sessions) {
        const it = el("div", "item clickable");
        const row = el("div", "row");
        const main = el("div", "grow");
        main.appendChild(el("div", "item-title", s.title || "（无标题会话）"));
        main.appendChild(el("div", "meta",
          (s.kbId ? kbName(s.kbId) + " · " : "") +
          s.eventCount + " 条事件 · 最后 " + (EVENT_LABEL[s.lastType] || s.lastType || "—") + " · " + fmtStamp(s.lastAt)));
        row.appendChild(main);
        row.appendChild(tag(KIND_LABEL[s.kind || ""] || "对话", s.kind && s.kind !== "ask" ? "ok" : ""));
        row.appendChild(btn("查看", "sm", () => openSession(s.sessionId)));
        it.appendChild(row);
        it.onclick = (ev) => { if (!ev.target.closest("button")) openSession(s.sessionId); };
        list.appendChild(it);
      }
      card.appendChild(list);
    }
    v.appendChild(card);
  },
};

/** 老路由 #/sessions 仍然可用：直接落到对话页的总览视图。 */
PAGES.sessions = { async render() { await go("chat", "overview", { replace: true }); } };

async function renderSessionsOverview() { await SESSIONS_VIEW.render(); }

async function renderSessionDetail(v, sessionId) {
  const d = await api("/api/sessions/events", { sessionId: sessionId });
  const events = d.events || [];
  const meta = state.sessions.find((s) => s.sessionId === sessionId) || {};
  const card = cardOf({
    title: meta.title || sessionId,
    sub: events.length + " 条事件 · " + fmtStamp(meta.lastAt),
    actions: [btn("← 返回列表", "ghost sm", () => { state.sessionId = ""; go("chat", "overview"); })],
  });
  if (!events.length) {
    card.appendChild(emptyState({
      inline: true, art: "clock", title: "这个会话没有事件", text: "可能已经被清理。",
      actions: [btn("返回列表", "", () => { state.sessionId = ""; go("chat", "overview"); })],
    }));
    v.appendChild(card);
    return;
  }
  const turns = {};
  var deltaCount = 0;
  for (const e of events) {
    // assistant/delta 是流式增量，条数多且内容已包含在最终回复里，时间线里不逐条展示
    if (e.type === "assistant/delta") { deltaCount += 1; continue; }
    const key = e.turnId || "—";
    if (!turns[key]) turns[key] = [];
    turns[key].push(e);
  }
  if (deltaCount) {
    card.appendChild(el("p", "muted sm", "（另有 " + deltaCount + " 条流式增量事件未逐条列出）"));
  }
  const wrap = el("div", "timeline");
  Object.keys(turns).forEach((key, ti) => {
    const box = el("div", "turn");
    const head = el("div", "turn-head");
    head.appendChild(el("span", "turn-idx", "第 " + (ti + 1) + " 轮"));
    const start = turns[key].find((e) => e.type === "turn/start");
    if (start && (start.payload || {}).kind) head.appendChild(tag(KIND_LABEL[start.payload.kind] || start.payload.kind, "ok"));
    const last = turns[key][turns[key].length - 1];
    if (last && last.type === "turn/end") {
      const p = last.payload || {};
      head.appendChild(tag(p.ok === false ? "失败" : "成功", p.ok === false ? "warn" : "ok"));
      if (p.message) head.appendChild(el("span", "muted sm", p.message));
    }
    box.appendChild(head);
    for (const e of turns[key]) {
      const line = el("div", "ev");
      line.appendChild(el("span", "ev-time", fmtStamp(e.at).slice(6)));
      line.appendChild(el("span", "ev-type", EVENT_LABEL[e.type] || e.type));
      const p = e.payload || {};
      let text = "";
      if (e.type === "user/message") text = p.text || "";
      else if (e.type === "assistant/message") text = String(p.text || "").slice(0, 180);
      else if (e.type === "step/start" || e.type === "step/end") text = (p.index !== undefined ? "#" + p.index + " " : "") + (STEP_LABEL[p.name] || p.name || "");
      else if (e.type === "tool/call") text = (p.tool || "") + " " + (p.query || "");
      else if (e.type === "validation") {
        const r = p.report || {};
        text = "段落 " + r.paragraphs + " · 带引用 " + r.citedParagraphs + " · 越界 " + r.outOfRange;
      } else if (e.type === "turn/end") text = p.ok === false ? (p.message || "失败") : "完成";
      line.appendChild(el("span", "ev-text", text));
      box.appendChild(line);
    }
    wrap.appendChild(box);
  });
  card.appendChild(wrap);
  v.appendChild(card);
}
/* ---------- 模型与接口 ---------- */

const MODEL_PRESETS = [
  {
    key: "mimo-flash",
    label: "MiMo TokenPlan · v2.6 flash",
    id: "mimo",
    name: "MiMo TokenPlan",
    base: "https://token-plan-cn.xiaomimimo.com/v1",
    model: "mimo-v2.6-flash",
    vision: "mimo-v2.6-pro",
    embed: "",
    note: "日常问答与生成用 mimo-v2.6-flash，便宜且快；切片与图片描述走 mimo-v2.6-pro。该服务不提供 /embeddings，向量模型留空即可——知识库会自动退回关键词检索。",
  },
  {
    key: "mimo-pro",
    label: "MiMo TokenPlan · v2.6 pro",
    id: "mimo",
    name: "MiMo TokenPlan",
    base: "https://token-plan-cn.xiaomimimo.com/v1",
    model: "mimo-v2.6-pro",
    vision: "mimo-v2.6-pro",
    embed: "",
    note: "全部用 mimo-v2.6-pro：理解更稳、讲义更完整，单次耗时也更长。",
  },
  {
    key: "deepseek",
    label: "DeepSeek",
    id: "deepseek",
    name: "DeepSeek",
    base: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    vision: "",
    embed: "",
    note: "DeepSeek 提供对话与推理；要读图里的内容，需要另配一个多模态服务。",
  },
  {
    key: "custom",
    label: "其它 OpenAI 兼容服务",
    id: "",
    name: "",
    base: "",
    model: "",
    vision: "",
    embed: "",
    note: "任何兼容 /chat/completions 的服务都能用；如果它同时提供 /embeddings，把向量模型填上就能用向量检索。",
  },
];

/**
 * 模型与接口。
 *
 * 用户明确要求"模型和接口配置都放到设置页里"：这里只剩老路由的转发，
 * 真正的界面是设置页的「模型与接口」分区（settingsModels）。
 */
PAGES.models = {
  async render() { await go("settings", "models", { replace: true }); },
};

async function settingsModels() {
  await loadCfg();
  // 先用 DocumentFragment 攒起来，设置页再整体塞进右侧内容区
  const v = document.createDocumentFragment();

    const mcard = el("div", "card");
    mcard.innerHTML = '<div class="card-head"><h2>添加 / 更新模型</h2><div class="spacer"></div>' +
      '<span class="card-sub">密钥只写进本机数据库</span></div>';
    const presetRow = el("div", "presets");
    presetRow.appendChild(el("span", "presets-label", "快速填入："));
    const hint = el("p", "muted sm preset-note", "");
    for (const p of MODEL_PRESETS) {
      const b = el("button", "chip", p.label);
      b.onclick = () => {
        $("m-id").value = p.id;
        $("m-name").value = p.name;
        $("m-base").value = p.base;
        $("m-model").value = p.model;
        $("m-vision").value = p.vision;
        $("m-embed").value = p.embed;
        hint.textContent = p.note;
        document.querySelectorAll(".chip").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
      };
      presetRow.appendChild(b);
    }
    mcard.appendChild(presetRow);
    mcard.appendChild(hint);

    const f1 = el("div", "row");
    f1.appendChild(fieldOf("标识（英文短名）", inputOf("m-id", "mimo")));
    f1.appendChild(fieldOf("显示名称", inputOf("m-name", "MiMo TokenPlan")));
    mcard.appendChild(f1);
    const f2 = el("div", "row");
    f2.appendChild(fieldOf("Base URL", inputOf("m-base", "https://token-plan-cn.xiaomimimo.com/v1")));
    const keyInput = inputOf("m-key", "留空则保留原密钥");
    keyInput.type = "password";
    f2.appendChild(fieldOf("API Key", keyInput));
    mcard.appendChild(f2);
    const f3 = el("div", "row");
    f3.appendChild(fieldOf("对话模型", inputOf("m-model", "mimo-v2.6-flash")));
    f3.appendChild(fieldOf("多模态模型（图片描述，可留空）", inputOf("m-vision", "mimo-v2.6-pro")));
    f3.appendChild(fieldOf("向量模型（可留空）", inputOf("m-embed", "")));
    mcard.appendChild(f3);
    const mact = el("div", "row");
    mact.appendChild(btn("保存模型", "primary", async () => {
      const id = $("m-id").value.trim();
      if (!id) { toast("请填写标识"); return; }
      const base = $("m-base").value.trim();
      const model = $("m-model").value.trim();
      if (!base || !model) { toast("Base URL 与对话模型不能为空"); return; }
      try {
        await api("/api/models/save", {
          id: id,
          name: $("m-name").value.trim(),
          baseUrl: base,
          apiKey: $("m-key").value,
          model: model,
          visionModel: $("m-vision").value.trim(),
          embeddingModel: $("m-embed").value.trim(),
        });
        toast("模型已保存");
        go("settings", "models");
      } catch (e) { toast("保存失败：" + e.message); }
    }));
    mact.appendChild(btn("清空表单", "ghost", () => go("settings", "models")));
    mcard.appendChild(mact);
    v.appendChild(mcard);

    const list = cardOf({ title: "已配置的模型", tag: state.cfg.models.length + " 个" });
    if (!state.cfg.models.length) {
      list.appendChild(emptyState({
        inline: true,
        art: "gear",
        title: "还没有配置模型",
        text: "点上面任意一个「快速填入」，地址与模型名会自动写进表单，补一个 API Key 保存即可。",
        actions: [btn("填入 MiMo v2.6 flash 预设", "primary", () => {
          const b = document.querySelector(".chip");
          if (b) b.click();
          $("view").scrollTop = 0;
          toast("已填入，请补 API Key");
        })],
      }));
    } else {
      const box = el("div", "list");
      for (const m of state.cfg.models) {
        const it = el("div", "item");
        const row = el("div", "row");
        const main = el("div", "grow");
        main.appendChild(el("div", "item-title", m.name || m.id));
        main.appendChild(el("div", "meta",
          m.baseUrl + " · " + m.model + (m.visionModel ? " · 多模态 " + m.visionModel : "") +
          (m.embeddingModel ? " · 向量 " + m.embeddingModel : "") +
          (m.hasApiKey ? " · 已设置密钥" : " · 未设置密钥")));
        row.appendChild(main);
        if (state.cfg.chatModelId === m.id) row.appendChild(tag("主模型", "ok"));
        if (!m.hasApiKey) row.appendChild(tag("缺密钥", "warn"));
        it.appendChild(row);
        const acts = el("div", "row item-actions");
        acts.appendChild(btn("测试连通", "sm primary", async (ev) => {
          const b = ev.target;
          b.disabled = true;
          b.textContent = "测试中…";
          try {
            await api("/api/models/test", { id: m.id });
            b.textContent = "连通 ✓";
            toast("模型连通");
          } catch (e) {
            b.textContent = "测试连通";
            toast("失败：" + e.message);
          }
          b.disabled = false;
        }));
        acts.appendChild(btn("设为对话模型", "sm", async () => {
          await api("/api/models/roles", { chatModelId: m.id, embedModelId: state.cfg.embedModelId, chunkModelId: state.cfg.chunkModelId });
          toast("已绑定「对话与生成」");
          go("settings", "models");
        }));
        acts.appendChild(btn("填到表单", "sm ghost", () => {
          $("m-id").value = m.id;
          $("m-name").value = m.name || "";
          $("m-base").value = m.baseUrl || "";
          $("m-model").value = m.model || "";
          $("m-vision").value = m.visionModel || "";
          $("m-embed").value = m.embeddingModel || "";
          $("m-key").value = "";
          $("view").scrollTop = 0;
        }));
        if (m.hasApiKey) {
          acts.appendChild(btn("诊断连接", "sm ghost", async (ev) => {
            const b = ev.target;
            b.disabled = true;
            b.textContent = "诊断中…";
            try {
              const d = await api("/api/models/diagnose", { id: m.id });
              const attempts = (d.attempts || []).map((a) => (a.protocol || a.name || "尝试") + "：" + (a.ok ? "通" : (a.detail || a.error || "失败")));
              toast(attempts.slice(0, 2).join("；") || "诊断完成");
            } catch (e) { toast("诊断失败：" + e.message); }
            b.disabled = false;
            b.textContent = "诊断连接";
          }));
        }
        acts.appendChild(btn("删除", "sm ghost", async () => {
          await api("/api/models/delete", { id: m.id });
          toast("已删除");
          go("settings", "models");
        }));
        it.appendChild(acts);
        box.appendChild(it);
      }
      list.appendChild(box);
    }
    v.appendChild(list);

    const role = cardOf({ title: "用途绑定", sub: "三个用途可以指向同一个模型，也可以分开" });
    const rr = el("div", "row");
    const mk = (id, label, val, desc) => {
      const f = el("div", "field");
      f.appendChild(el("label", null, label));
      const sel = selectOf(id, [{ value: "", label: "（未指定）" }].concat(state.cfg.models.map((m) => ({ value: m.id, label: m.name || m.id }))), val || "");
      f.appendChild(sel);
      f.appendChild(el("div", "field-hint", desc));
      return f;
    };
    rr.appendChild(mk("role-chat", "对话与生成", state.cfg.chatModelId, "问答、讲义、练习册都走它"));
    rr.appendChild(mk("role-embed", "向量检索", state.cfg.embedModelId, "留空则知识库退回关键词检索"));
    rr.appendChild(mk("role-chunk", "切片与图片描述", state.cfg.chunkModelId, "需要多模态能力，才能读出图里的内容"));
    role.appendChild(rr);
    role.appendChild(btn("保存绑定", "primary", async () => {
      try {
        await api("/api/models/roles", {
          chatModelId: $("role-chat").value,
          embedModelId: $("role-embed").value,
          chunkModelId: $("role-chunk").value,
        });
        toast("已保存");
        go("settings", "models");
      } catch (e) { toast("保存失败：" + e.message); }
    }));
    v.appendChild(role);

  /* ---------- 联网搜索（Tavily） ----------
     Agent 唯一的外部通道。默认关着：不配就不把 web_search 交给模型。
     服务选 Tavily 是沿用网页版（src/agents 的 web_search_tool.py）的做法，保持两边一致。 */
  let ws = { provider: "tavily", enabled: false, hasKey: false, keyHint: "", results: 5 };
  try {
    ws = await api("/api/websearch/get", {});
  } catch (e) {
    // 内核没有这个接口时不该整页崩掉：卡片照常显示，只是状态读不到
  }
  const mode = ws.mode || "auto";
  const wsCard = cardOf({
    title: "联网",
    tag: mode === "off" ? "已关闭" : WEB_MODE_LABEL[mode],
    tagCls: mode === "off" ? "warn" : "ok",
    sub: "搜索走 Tavily，抓网页落本机",
  });
  // 联网档位：关 / 只在资料不足时 / 总是
  const modeRow = el("div", "row");
  // 这是 agent：默认把决定权交给它；只有用户明确不想要外发请求时才关掉
  modeRow.appendChild(fieldOf("什么时候联网", selectOf("ws-mode", [
    { value: "auto", label: "交给 agent 判断（默认）" },
    { value: "always", label: "优先联网：能查就查" },
    { value: "off", label: "不联网：一个请求都不发" },
  ], mode)));
  const wsRow = el("div", "row");
  const wsKey = inputOf("ws-key", ws.hasKey ? "已设置，留空则保留原密钥" : "tvly-…");
  wsKey.type = "password";
  wsRow.appendChild(fieldOf("Tavily API Key", wsKey));
  wsRow.appendChild(fieldOf("开关", selectOf("ws-enabled", [
    { value: "0", label: "关闭（不交给模型）" },
    { value: "1", label: "开启" },
  ], ws.enabled ? "1" : "0")));
  wsRow.appendChild(fieldOf("每次返回条数", selectOf("ws-results", [
    { value: "3", label: "3 条" },
    { value: "5", label: "5 条" },
    { value: "10", label: "10 条" },
  ], String(ws.results || 5))));
  wsCard.appendChild(modeRow);
  wsCard.appendChild(wsRow);
  const wsActs = el("div", "row");
  wsActs.appendChild(btn("保存", "primary", async () => {
    try {
      await api("/api/websearch/save", {
        apiKey: $("ws-key").value.trim(),
        enabled: $("ws-enabled").value,
        results: Number($("ws-results").value) || 5,
        mode: $("ws-mode").value,
      });
      toast("联网搜索已保存");
      go("settings", "models");
    } catch (e) { toast("保存失败：" + e.message); }
  }));
  wsActs.appendChild(btn("测试连接", "", async (ev) => {
    const b = ev.target;
    b.disabled = true;
    b.textContent = "搜索中…";
    try {
      const r = await api("/api/websearch/test", { apiKey: $("ws-key").value.trim(), results: 3 });
      toast("通了：搜到 " + r.count + " 条 · " + String(r.first || "").slice(0, 20));
      b.textContent = "再测一次";
    } catch (e) {
      toast("测试失败：" + e.message);
      b.textContent = "测试连接";
    }
    b.disabled = false;
  }));
  wsActs.appendChild(copyButton(() => "https://app.tavily.com/home", "复制申请地址"));
  wsActs.appendChild(btn("清除密钥", "sm ghost", async () => {
    try {
      await api("/api/websearch/save", { clearKey: "1", enabled: "0", results: Number($("ws-results").value) || 5 });
      toast("已清除密钥，并关闭联网搜索");
      go("settings", "models");
    } catch (e) { toast("清除失败：" + e.message); }
  }));
  wsCard.appendChild(wsActs);
  wsCard.appendChild(el("p", "muted sm", (ws.hasKey ? "搜索密钥 " + ws.keyHint : "还没有搜索密钥") +
    " · 搜索" + (ws.enabled ? "已启用" : "未启用") + "。抓网页不需要密钥；开了联网，「伴学助手」的工具里会多出「联网搜索」和「读取网页」。"));

  /* 手动抓一页：贴个链接就读，不用等模型自己决定 */
  const fetchRow = el("div", "row");
  const urlInput = inputOf("ws-url", "https://… 贴一个链接，抓回正文并落到本机");
  urlInput.className = "grow";
  fetchRow.appendChild(urlInput);
  fetchRow.appendChild(btn("抓取", "", async (ev) => {
    const b = ev.target;
    const url = $("ws-url").value.trim();
    if (!url) { toast("先贴一个链接"); return; }
    b.disabled = true;
    b.textContent = "抓取中…";
    try {
      const r = await api("/api/web/fetch", { url: url });
      toast("已读取《" + r.title + "》· 落到本机 " + artifactNameFromPath(r.path));
      go("settings", "models");
    } catch (e) {
      toast("抓取失败：" + e.message);
      b.disabled = false;
      b.textContent = "抓取";
    }
  }));
  wsCard.appendChild(fetchRow);

  /* 抓回来的东西：可审计、可删除（联网内容默认只在本机缓存里，不自动进知识库索引） */
  let cache = { pages: [], dir: "" };
  try { cache = await api("/api/web/cache", {}); } catch (e) { /* 读不到就不显示这一段 */ }
  if (cache.pages && cache.pages.length) {
    const box = el("div", "list");
    box.style.marginTop = "10px";
    for (const pg of cache.pages) {
      const it = el("div", "item");
      const row = el("div", "row");
      const main = el("div", "grow");
      main.appendChild(el("div", "item-title", pg.title || pg.name));
      main.appendChild(el("div", "meta", pg.url));
      main.appendChild(el("div", "meta", "抓取于 " + pg.fetchedAt + " · " + fmtSize(Number(pg.bytes) || 0)));
      row.appendChild(main);
      row.appendChild(btn("删除", "sm ghost", async () => {
        try {
          await api("/api/web/cache/delete", { name: pg.name });
          toast("已删除这一页缓存");
          go("settings", "models");
        } catch (e) { toast("删除失败：" + e.message); }
      }));
      it.appendChild(row);
      box.appendChild(it);
    }
    wsCard.appendChild(el("div", "panel-group-title", "抓回来的网页（" + cache.pages.length + " 页，都在本机）"));
    wsCard.appendChild(box);
    const crow = el("div", "row");
    crow.appendChild(btn("复制缓存目录", "sm ghost", () => {
      navigator.clipboard.writeText(cache.dir || "").then(() => toast("路径已复制"), () => toast("复制失败"));
    }));
    crow.appendChild(btn("全部清空", "sm ghost", async () => {
      for (const pg of cache.pages) {
        try { await api("/api/web/cache/delete", { name: pg.name }); } catch (e) { /* 继续删下一个 */ }
      }
      toast("已清空抓取缓存");
      go("settings", "models");
    }));
    wsCard.appendChild(crow);
  }
  v.appendChild(wsCard);
  return v;
}

/* ---------- 档案与知识库 ---------- */

const SELF_SCORE_KEYS = ["概念理解", "逻辑推理", "工程实践", "问题诊断", "系统设计", "学习迁移"];

const SETTINGS_SECTIONS = [
  { id: "general", label: "常规", icon: "sliders", title: "常规" },
  { id: "appearance", label: "外观", icon: "sun", title: "外观" },
  { id: "kb", label: "知识库", icon: "db", title: "知识库" },
  { id: "models", label: "模型与接口", icon: "gear", title: "模型与接口" },
  { id: "data", label: "数据与备份", icon: "layers", title: "数据与备份" },
  { id: "skills", label: "技能", icon: "book", title: "技能" },
  { id: "about", label: "关于", icon: "file", title: "关于 ITN-Desktop" },
];

/**
 * 设置页。
 *
 * 参照用户给的设置页截图：左边一条窄分区栏，右边一块内容区，一次只显示一块。
 * 分区写在 hash 里（#/settings/models），所以刷新、后退、从别处深链进来都能落到同一块。
 * 之前"档案与知识库""模型与接口"各占一个侧栏入口，现在是同一页里的两个分区。
 */
PAGES.settings = {
  async render() {
    await loadCfg();
    const sec = SETTINGS_SECTIONS.filter((x) => x.id === currentSection)[0] || SETTINGS_SECTIONS[0];
    if (sec.id === "general") await loadProfile();

    const v = $("view");
    v.innerHTML = "";
    // 分区导航在第二层面板里（Codex 式），这里只放当前分区的内容
    const body = el("div", "settings-body");
    const head = el("div", "settings-head");
    head.appendChild(el("h2", null, sec.title));
    if (sec.sub) head.appendChild(el("p", null, sec.sub));
    body.appendChild(head);
    body.appendChild(await settingsSection(sec.id));
    v.appendChild(body);
  },
};

/** 设置分区的路由表；每个 builder 返回一个可以整体塞进内容区的节点。 */
function settingsSection(id) {
  if (id === "appearance") return settingsAppearance();
  if (id === "skills") return settingsSkills();
  if (id === "kb") return settingsKb();
  if (id === "models") return settingsModels();
  if (id === "data") return settingsData();
  if (id === "about") return settingsAbout();
  return settingsGeneral();
}

/* ---------- 设置 · 常规：学习者档案 ---------- */
function settingsGeneral() {
  const g = document.createDocumentFragment();
  const p = state.profile || {};

  const prof = cardOf({
    title: "学习者档案",
    actions: [btn("保存档案", "primary sm", async () => {
      const selfScores = {};
      for (const k of SELF_SCORE_KEYS) {
        const val = Number((document.getElementById("pf-score-" + k) || {}).value);
        if (val > 0) selfScores[k] = Math.max(0, Math.min(100, val));
      }
      try {
        await saveProfile({
          nickname: $("pf-nick").value.trim(),
          goal: $("pf-goal").value.trim(),
          weeklyHours: Number($("pf-hours").value) || 0,
          selfScores: selfScores,
        });
        toast("档案已保存");
        go("settings", "general");
      } catch (e) { toast("保存失败：" + e.message); }
    })],
  });
  const prow1 = el("div", "row");
  prow1.appendChild(fieldOf("称呼", inputOf("pf-nick", "例如 李老师", p.nickname || "")));
  prow1.appendChild(fieldOf("学习目标", inputOf("pf-goal", "例如 两周内讲完提示词工程", p.goal || "")));
  prow1.appendChild(fieldOf("每周投入（小时）", inputOf("pf-hours", "8", p.weeklyHours || "")));
  prof.appendChild(prow1);
  const scores = p.selfScores || {};
  const grid = el("div", "grid grid-3");
  for (const k of SELF_SCORE_KEYS) {
    grid.appendChild(fieldOf(k + "（0-100）", inputOf("pf-score-" + k, "", scores[k] === undefined ? "" : scores[k])));
  }
  prof.appendChild(grid);
  g.appendChild(prof);

  /* 设置页最容易变成"填完就没人来"的地方，所以每个分区都给一条回到干活的捷径 */
  const jump = cardOf({ title: "下一步" });
  const jr = el("div", "row");
  jr.appendChild(btn("去配置模型接口", "primary sm", () => go("settings", "models")));
  jr.appendChild(btn("去指定资料目录", "sm", () => go("settings", "kb")));
  jr.appendChild(btn("去学 · 练", "sm ghost", () => go("learn")));
  jump.appendChild(jr);
  g.appendChild(jump);
  return g;
}

/* ---------- 设置 · 外观 ---------- */
function settingsAppearance() {
  const g = document.createDocumentFragment();

  const themeCard = cardOf({ title: "主题" });
  const picker = el("div", "theme-picker");
  const options = [
    { id: "light", cls: "light", label: "浅色" },
    { id: "dark", cls: "dark", label: "深色" },
    { id: "system", cls: "system", label: "跟随系统" },
  ];
  for (const o of options) {
    const b = el("button", "theme-card " + o.cls + (state.theme === o.id ? " active" : ""));
    b.type = "button";
    b.dataset.theme = o.id;
    b.appendChild(el("span", "swatch"));
    b.appendChild(el("span", "t-name", o.label));
    b.onclick = async () => {
      await savePrefs({ theme: o.id });
      toast(o.id === "system" ? "已跟随系统" : "已切到" + o.label);
      go("settings", "appearance");
    };
    picker.appendChild(b);
  }
  themeCard.appendChild(picker);
  g.appendChild(themeCard);

  const railCard = cardOf({ title: "侧栏" });
  const mkRow = (label, action, actLabel) => {
    const row = el("div", "row switch-row");
    row.appendChild(el("div", "grow switch-label", label));
    row.appendChild(btn(actLabel, "sm", action));
    return row;
  };
  railCard.appendChild(mkRow("第二层面板（Ctrl+Shift+S）", () => {
    togglePanel();
    go("settings", "appearance");
  }, state.panelHidden ? "展开" : "收起"));
  g.appendChild(railCard);
  return g;
}

/**
 * 选资料目录。
 *
 * 只有桌面窗口有"读本机绝对路径"的能力（Electron 的目录对话框，见 preload/main）；
 * 在浏览器里打开同一份界面时，按钮不假装能用，而是说清楚原因。
 * 选完顺手把「标识」补上（目录名的英文短名）：这一步本来也要用户打一遍。
 */
async function pickKbDir() {
  const a = window.itnWindow;
  if (!a || typeof a.pickDirectory !== "function") {
    toast("选目录只在桌面应用窗口里可用；这里可以直接粘贴路径");
    const el0 = $("kb-dir");
    if (el0) el0.focus();
    return;
  }
  let dir = "";
  try {
    dir = await a.pickDirectory();
  } catch (e) {
    toast("打开目录对话框失败：" + e.message);
    return;
  }
  if (!dir) return; // 用户取消：不是错误，什么都不做
  $("kb-dir").value = dir;
  const base = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  const idEl = $("kb-id");
  if (idEl && !idEl.value.trim() && base) {
    const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
    if (slug) idEl.value = slug;
  }
  const nameEl = $("kb-name");
  if (nameEl && !nameEl.value.trim() && base) nameEl.value = base;
  toast("已选：" + dir);
}

/* ---------- 设置 · 知识库 ---------- */
function settingsKb() {
  const g = document.createDocumentFragment();
  const kbCard = cardOf({
    title: "登记一个知识库",
    tag: state.cfg.knowledgeBases.length + " 个",
  });
  const form = el("div", "kb-form");
  const fr = el("div", "row");
  fr.appendChild(fieldOf("标识（英文短名）", inputOf("kb-id", "course")));
  fr.appendChild(fieldOf("显示名称", inputOf("kb-name", "我的课程资料")));
  form.appendChild(fr);
  // 目录靠系统对话框选，不用手打路径（手打很容易错在盘符、反斜杠、中文目录名上）
  const dirRow = el("div", "row dir-row");
  const dirInput = inputOf("kb-dir", "点右边「选择…」，或直接粘贴路径");
  dirInput.className = "grow";
  dirRow.appendChild(dirInput);
  dirRow.appendChild(btn("选择…", "", () => pickKbDir()));
  form.appendChild(fieldOf("资料目录", dirRow));
  const facts = el("div", "row");
  facts.appendChild(btn("保存知识库", "primary", async () => {
    const id = $("kb-id").value.trim();
    if (!id) { toast("请填写标识"); return; }
    const dir = $("kb-dir").value.trim();
    if (!dir) { toast("请填写目录绝对路径"); return; }
    try {
      await api("/api/kb/save", { id: id, name: $("kb-name").value.trim(), rootDir: dir });
      toast("已保存，接着建立索引");
      state.kb = id;
      go("settings", "kb");
    } catch (e) { toast("保存失败：" + e.message); }
  }));
  facts.appendChild(btn("保存并建立索引", "", async () => {
    const id = $("kb-id").value.trim();
    const dir = $("kb-dir").value.trim();
    if (!id || !dir) { toast("标识与目录都要填"); return; }
    try {
      await api("/api/kb/save", { id: id, name: $("kb-name").value.trim(), rootDir: dir });
      state.kb = id;
      await buildIndex(id);
    } catch (e) { toast("失败：" + e.message); }
  }));
  form.appendChild(facts);
  kbCard.appendChild(form);

  if (!state.cfg.knowledgeBases.length) {
    kbCard.appendChild(emptyState({
      inline: true,
      art: "db",
      title: "还没有知识库",
      text: "填一个英文标识（例如 course）、一个显示名称和资料目录的绝对路径，保存后建立索引。",
      actions: [btn("填一个示例", "ghost", () => {
        $("kb-id").value = "course";
        $("kb-name").value = "我的课程资料";
        $("kb-dir").focus();
      })],
    }));
  } else {
    const kbox = el("div", "list");
    kbox.style.marginTop = "12px";
    for (const k of state.cfg.knowledgeBases) {
      const it = el("div", "item");
      const row = el("div", "row");
      const main = el("div", "grow");
      main.appendChild(el("div", "item-title", k.name || k.id));
      main.appendChild(el("div", "meta", (k.rootDir || "未设置目录") + " · " + (k.docCount || 0) + " 篇 · " + (k.chunkCount || 0) + " 片 · " + (k.imageCount || 0) + " 张图"));
      if (k.builtAt) main.appendChild(el("div", "meta", "索引于 " + fmtStamp(k.builtAt)));
      row.appendChild(main);
      row.appendChild((k.chunkCount || 0) > 0 ? tag("已索引", "ok") : tag("未索引", "warn"));
      if (state.kb === k.id) row.appendChild(tag("当前"));
      it.appendChild(row);
      const acts = el("div", "row item-actions");
      acts.appendChild(btn((k.chunkCount || 0) > 0 ? "重建索引" : "建立索引", "sm primary", () => buildIndex(k.id)));
      if (state.kb !== k.id) acts.appendChild(btn("设为当前", "sm", () => { state.kb = k.id; toast("已切换为当前知识库"); go("learn"); }));
      acts.appendChild(btn("去检索", "sm ghost", () => { state.kb = k.id; go("kb"); }));
      acts.appendChild(btn("删除", "sm ghost", () => {
        // 删知识库是"连带"操作：登记没了，索引、阅读进度、本章学习记录就都找不回来了（原文件不动）
        confirmDialog("删除知识库登记？",
          "会把「" + (k.name || k.id) + "」的登记从本机删掉，索引与这一章的学习进度也会一起消失。\n" +
          "你目录里的原始资料不会被删，之后可以重新登记并建立索引。",
          async () => {
            try {
              await api("/api/kb/delete", { id: k.id });
              toast("已删除登记（本机原文件不会被删）");
              await loadCfg();
              go("settings", "kb");
            } catch (e) { toast("删除失败：" + e.message); }
          });
      }));
      it.appendChild(acts);
      kbox.appendChild(it);
    }
    kbCard.appendChild(kbox);
  }
  g.appendChild(kbCard);
  return g;
}

/* ---------- 设置 · 数据与备份 ---------- */
async function settingsData() {
  const g = document.createDocumentFragment();
  /* 用户最怕的是"攒了两个月的东西，一旦坏了就没了"。数据全在本机一个 SQLite 文件里，
     所以这里给一个明确的"立即备份"和一个看得见的备份列表。 */
  const bk = cardOf({
    cls: "data-backup",
    title: "数据与备份",
  });
  let maint = { dataDir: state.cfg.dataDir || "", dbSize: 0, backups: [] };
  try {
    maint = await api("/api/maintenance/status", {});
  } catch (e) {
    bk.appendChild(el("p", "muted", "读不到数据状态：" + e.message));
  }
  const info = el("div", "kv-list");
  const dirLine = el("div", "kv-line");
  dirLine.appendChild(el("span", "kv-key", "数据目录"));
  dirLine.appendChild(el("span", "path-line grow", maint.dataDir || "（未返回）"));
  dirLine.appendChild(btn("复制路径", "sm ghost", () => {
    navigator.clipboard.writeText(maint.dataDir || "").then(() => toast("路径已复制"), () => toast("复制失败，请手动选择"));
  }));
  info.appendChild(dirLine);
  const dbLine = el("div", "kv-line");
  dbLine.appendChild(el("span", "kv-key", "本地数据库"));
  dbLine.appendChild(el("span", "muted", "itn.db · " + fmtSize(maint.dbSize) + " · " + (maint.backups || []).length + " 份备份"));
  info.appendChild(dbLine);
  bk.appendChild(info);

  const doBackup = async (ev) => {
    const b = ev.target;
    b.disabled = true;
    b.textContent = "备份并校验中…";
    try {
      const r = await api("/api/maintenance/backup", {});
      toast("备份完成（已校验可打开）：" + r.name + " · " + fmtSize(r.size));
      go("settings", "data");
    } catch (e) {
      toast("备份失败：" + e.message);
      b.disabled = false;
      b.textContent = "立即备份";
    }
  };
  const bkActs = el("div", "row");
  bkActs.appendChild(btn("立即备份", "primary", doBackup));
  bkActs.appendChild(btn("复制备份目录", "ghost", () => {
    navigator.clipboard.writeText((maint.dataDir || "") + "\\backups").then(() => toast("路径已复制"), () => toast("复制失败"));
  }));
  bk.appendChild(bkActs);

  if (!(maint.backups || []).length) {
    bk.appendChild(emptyState({
      inline: true,
      art: "layers",
      title: "还没有备份",
      text: "点「立即备份」会把整个数据库复制到数据目录的 backups 子目录，并立刻打开副本校验一次——拷出来打不开的备份不算备份。",
      actions: [btn("立即备份", "primary", doBackup)],
    }));
  } else {
    const bl = el("div", "list");
    bl.style.marginTop = "10px";
    for (const b of maint.backups) {
      const it = el("div", "item backup-item");
      const row = el("div", "row");
      const main = el("div", "grow");
      main.appendChild(el("div", "item-title", b.name));
      main.appendChild(el("div", "meta", fmtSize(b.size) + " · " + b.name.replace(/^itn-/, "").replace(/\.db$/, "")));
      row.appendChild(main);
      row.appendChild(btn("复制路径", "sm ghost", () => {
        navigator.clipboard.writeText(b.path || "").then(() => toast("路径已复制"), () => toast("复制失败"));
      }));
      row.appendChild(btn("删除", "sm ghost", () => {
        confirmDialog("删除这份备份？", "会删掉 " + b.name + "。它只是一份副本，删了不影响当前数据。", async () => {
          try {
            await api("/api/maintenance/backups/delete", { name: b.name });
            toast("已删除备份");
            go("settings", "data");
          } catch (e) { toast("删除失败：" + e.message); }
        });
      }));
      it.appendChild(row);
      bl.appendChild(it);
    }
    bk.appendChild(bl);
  }
  bk.appendChild(el("p", "muted sm", "恢复方式：先退出应用，把备份文件改名成 itn.db 覆盖数据目录里的同名文件（若旁边还有 itn.db-journal，一并删掉），再启动即可。"));
  g.appendChild(bk);
  return g;
}

/* ---------- 设置 · 关于 ---------- */
/**
 * 设置 · 技能。
 *
 * 技能就是一份 Markdown：<数据目录>/skills/<id>/SKILL.md。内置的随包只读，
 * 用户自己的随便改；表格里把"允许的工具"和"要不要联网授权"直接摆出来——
 * 这两件事决定了它会怎么被用。
 */
async function settingsSkills() {
  const g = document.createDocumentFragment();
  let data = { skills: [], userDir: "", bundledDir: "" };
  try {
    data = await api("/api/skills/list", {});
  } catch (e) {
    g.appendChild(cardOf({ title: "技能", body: el("p", "muted", "读不到技能清单：" + e.message) }));
    return g;
  }
  const card = cardOf({
    title: "技能",
    tag: (data.skills || []).length + " 个",
    actions: [
      btn("打开技能目录", "sm", async () => {
        try {
          const r = await api("/api/skills/template", {});
          toast("已准备好用户技能目录；示例技能：" + artifactNameFromPath(r.path));
          go("settings", "skills");
        } catch (e) { toast("失败：" + e.message); }
      }),
      copyButton(() => data.userDir || "", "复制目录路径"),
    ],
  });
  card.appendChild(el("p", "muted sm",
    "技能 = 一份 Markdown 说明书（用法步骤 + 允许用哪些工具）。工具是内核的能力，技能只是怎么用它们的说明。" +
    "内置技能随包只读；自己的技能放在上面那个目录里，一层一个目录，里面放 SKILL.md。"));
  const list = el("div", "list");
  for (const sk of (data.skills || [])) {
    const it = el("div", "item");
    const row = el("div", "row");
    const main = el("div", "grow");
    main.appendChild(el("div", "item-title", sk.title + "　" + sk.id));
    if (sk.description) main.appendChild(el("div", "meta", sk.description));
    const meta = el("div", "meta");
    meta.appendChild(el("span", null, "允许工具：" + ((sk.tools || []).join(" / ") || "（没声明）")));
    if (sk.requiresConsent) meta.appendChild(el("span", null, "需要授权：" + sk.requiresConsent));
    meta.appendChild(el("span", null, sk.source === "bundled" ? "内置（只读）" : "自己的"));
    main.appendChild(meta);
    row.appendChild(main);
    row.appendChild(sk.available ? tag("可用", "ok") : tag(sk.reason || "不可用", "warn"));
    it.appendChild(row);
    const acts = el("div", "row item-actions");
    acts.appendChild(btn("看正文", "sm", async () => {
      try {
        const d = await api("/api/skills/read", { id: sk.id });
        const dlg = el("div", "card dialog");
        dlg.appendChild(cardHeadOnly("技能正文 · " + d.title));
        const pre = el("div", "artifact-preview");
        pre.innerHTML = md(d.body || "");
        dlg.appendChild(pre);
        dlg.appendChild(btn("收起", "ghost", () => dlg.remove()));
        $("view").insertBefore(dlg, $("view").firstChild);
      } catch (e) { toast("读取失败：" + e.message); }
    }));
    acts.appendChild(copyButton(() => sk.path || "", "复制路径"));
    it.appendChild(acts);
    list.appendChild(it);
  }
  card.appendChild(list);
  g.appendChild(card);

  if (data.bundledDir) {
    const b = cardOf({ title: "内置技能目录", sub: "随包只读，升级软件时跟着更新" });
    b.appendChild(el("p", "path-line", data.bundledDir));
    g.appendChild(b);
  }
  return g;
}

function settingsAbout() {
  const g = document.createDocumentFragment();
  const k = state.kernel || {};
  const ver = cardOf({ title: "当前版本" });
  const kv = el("div", "kv-list");
  const line = (key, val) => {
    const l = el("div", "kv-line");
    l.appendChild(el("span", "kv-key", key));
    l.appendChild(el("span", "grow", val));
    return l;
  };
  kv.appendChild(line("应用", "ITN-Desktop · 桌面端"));
  kv.appendChild(line("内核", "仓颉（Cangjie）运行时" + (k.cangjie ? " · " + k.cangjie : "")));
  kv.appendChild(line("数据目录", state.cfg.dataDir || "（启动时由内核决定，可在「数据与备份」里复制路径）"));
  ver.appendChild(kv);
  g.appendChild(ver);

  const about = cardOf({ title: "数据与隐私" });
  const ul = el("ul", "about-list");
  [
    "所有配置、学习记录、切片与向量都存在本机的 SQLite 单文件数据库里，可以整体拷走或备份。",
    "资料只发给你自己配置的模型服务，不经过任何第三方服务器。",
    "API Key 只写进本机数据库；「模型与接口」读取配置时永不回传密钥本身。",
    "讲义与练习是可复现的本地 Markdown 文件，放在数据目录的 artifacts 子目录下。",
  ].forEach((t) => ul.appendChild(el("li", null, t)));
  about.appendChild(ul);
  g.appendChild(about);
  return g;
}

/* ---------- 弹层：出题练习 / 笔记 / 建立索引 ---------- */

function cardHeadOnly(title, extra) {
  const head = el("div", "card-head");
  head.appendChild(el("h2", null, title));
  if (extra) { head.appendChild(spacer()); head.appendChild(extra); }
  return head;
}

async function openQuiz(container, chapter) {
  if (!chapter) { toast("先在目录里选一章"); go("learn"); return; }
  const dlg = el("div", "card dialog");
  const head = cardHeadOnly("出题练习 · " + chapter);
  head.insertBefore(el("span", "spinner"), head.firstChild);
  head.appendChild(el("span", "muted sm", "正在依据这一章的资料出题，请稍候"));
  dlg.appendChild(head);
  container.insertBefore(dlg, container.firstChild);
  dlg.scrollIntoView({ block: "start" });
  let data;
  try {
    data = await api("/api/study/quiz/generate", { kbId: state.kb, chapter: chapter, count: 3 });
  } catch (e) {
    dlg.innerHTML = "";
    dlg.appendChild(cardHeadOnly("出题没能完成"));
    dlg.appendChild(emptyState({
      inline: true,
      art: "alert",
      title: "题目没有生成出来",
      text: e.message + "。可以换一章，或确认「对话与生成」绑定的是可用模型；也可以直接产出 Markdown 练习册。",
      actions: [btn("关闭", "", () => dlg.remove()),
                btn("检查模型设置", "primary", () => go("models")),
                btn("生成练习册（Markdown）", "", () => { dlg.remove(); askTopic("quiz", chapter); })],
    }));
    return;
  }
  const qs = data.questions || [];
  dlg.innerHTML = "";
  dlg.appendChild(cardHeadOnly("出题练习 · " + chapter, tag(qs.length + " 题")));
  if (!qs.length) {
    dlg.appendChild(emptyState({
      inline: true,
      art: "alert",
      title: "没有生成出题目",
      text: "模型这次没有按格式返回题目。重试一次，或改用「生成练习册」产出一份 Markdown 练习。",
      actions: [btn("重试", "primary", () => { dlg.remove(); openQuiz(container, chapter); }),
                btn("生成练习册", "", () => { dlg.remove(); askTopic("quiz", chapter); })],
    }));
    return;
  }
  let answered = 0, right = 0;
  const score = el("span", "muted sm grow", "已答 0 / " + qs.length + " · 对 0");
  qs.forEach((q, qi) => {
    const box = el("div", "quiz-q");
    box.appendChild(el("div", "item-title", (qi + 1) + ". " + (q.question || "")));
    const opts = q.options || [];
    const btns = [];
    opts.forEach((o, oi) => {
      const b = el("button", "btn choice", String.fromCharCode(65 + oi) + ". " + o);
      b.onclick = async () => {
        if (box.dataset.done) return;
        box.dataset.done = "1";
        const ok = oi === q.answerIndex;
        b.classList.add(ok ? "right" : "wrong");
        if (!ok && btns[q.answerIndex]) btns[q.answerIndex].classList.add("right");
        answered += 1;
        if (ok) right += 1;
        const tip = el("div", "quiz-explain");
        tip.innerHTML = '<span class="tag ' + (ok ? "ok" : "warn") + '">' + (ok ? "答对了" : "答错了") + "</span> " +
          '<span class="muted">参考答案：' + esc(opts[q.answerIndex] || "") + "</span>" +
          (q.explain ? '<div class="muted sm" style="margin-top:6px">' + esc(q.explain) + "</div>" : "");
        box.appendChild(tip);
        score.textContent = "已答 " + answered + " / " + qs.length + " · 对 " + right;
        try {
          await api("/api/study/quiz/submit", {
            kbId: state.kb, chapter: chapter, question: q.question,
            myAnswer: opts[oi], reference: opts[q.answerIndex] || "", correct: ok,
            // 把原题也存下来：以后在错题本里"重做"给的是同一道题，而不是只能对着答案自评
            options: opts, answerIndex: q.answerIndex, explain: q.explain || "", source: q.source || "",
          });
          await loadReport();
          buildNav();
        } catch (e) { /* 记录失败不影响答题 */ }
      };
      btns.push(b);
      box.appendChild(b);
    });
    if (q.source) box.appendChild(el("div", "muted sm", "出处：" + q.source));
    dlg.appendChild(box);
  });
  const foot = el("div", "row");
  foot.appendChild(score);
  foot.appendChild(btn("收起", "", () => { dlg.remove(); go("learn"); }));
  foot.appendChild(btn("去错题本", "ghost", () => go("wrong")));
  foot.appendChild(btn("把这章做成讲义", "ghost", () => { dlg.remove(); askTopic("lecture", chapter); }));
  dlg.appendChild(foot);
}

function openNoteEditor(note, kbId, chapter, chunk) {
  const v = $("view");
  const dlg = el("div", "card dialog");
  const head = cardHeadOnly(note ? "编辑笔记" : "写笔记");
  if (chapter) head.appendChild(tag(chapter));
  if (kbId) head.appendChild(tag(kbName(kbId)));
  dlg.appendChild(head);
  // 从某个切片进来时，把原文摘录一起带上：笔记以后能追回它到底是哪一段的
  const quote = chunk ? String(chunk.text || "").replace(/\s+/g, " ").slice(0, 160) : "";
  const srcName = chunk ? String(chunk.headingPath || chunk.docTitle || "").split(" > ").pop() : "";
  const title0 = note ? note.title : (chunk ? srcName : "");
  const text0 = note ? (note.text || "")
    : (chunk ? "> 原文摘录（" + (chunk.headingPath || chunk.docTitle || "") + "）：" + quote + "\n\n我的想法：\n" : "");
  dlg.appendChild(fieldOf("标题", inputOf("nt-title", "这一段的要点", title0)));
  const ta = el("textarea");
  ta.id = "nt-text";
  ta.rows = 8;
  ta.value = text0;
  dlg.appendChild(fieldOf("内容（支持 Markdown）", ta));
  const row = el("div", "row");
  row.appendChild(btn("保存", "primary", async () => {
    try {
      await api("/api/study/notes/save", {
        id: note ? note.id : "", kbId: kbId || "", chapter: chapter || "",
        title: $("nt-title").value.trim(), text: $("nt-text").value,
      });
      toast("笔记已保存");
      dlg.remove();
      await loadReport();
      if (current === "notes") go("notes"); else buildNav();
    } catch (e) { toast("保存失败：" + e.message); }
  }));
  row.appendChild(btn("取消", "ghost", () => dlg.remove()));
  dlg.appendChild(row);
  v.insertBefore(dlg, v.firstChild);
  dlg.scrollIntoView({ block: "start" });
  $("nt-title").focus();
}

async function buildIndex(kbId) {
  if (!kbId) { toast("先选择一个知识库"); return; }
  const v = $("view");
  const card = progressCard("正在建立索引：「" + kbName(kbId) + "」", ["扫描目录", "按标题切片", "图片描述（配了多模态才做）", "向量化（配了向量模型才做）", "写入本机数据库"]);
  v.insertBefore(card, v.firstChild);
  card.scrollIntoView({ block: "start" });
  try {
    const st = await api("/api/kb/build", { id: kbId });
    card._stop();
    card.remove();
    await loadCfg();
    await loadReport();
    const box = cardOf({ cls: "dialog ok-dialog", title: "索引完成", tag: "已就绪", tagCls: "ok" });
    const grid = el("div", "grid grid-4");
    grid.appendChild(statCard("文档", st.docCount || 0, "篇"));
    grid.appendChild(statCard("切片", st.chunkCount || 0, "片"));
    grid.appendChild(statCard("图片", st.imageCount || 0, "张"));
    grid.appendChild(statCard("图片描述", st.captioned || 0, "条"));
    box.appendChild(grid);
    if (st.embedError) {
      // 向量服务不给 /embeddings 是"少了一种检索方式"，不是"索引失败"——用琥珀色说清楚
      const warn = el("div", "skip-note");
      warn.appendChild(el("div", "skip-title", "索引已建好，但向量检索没启用"));
      warn.appendChild(el("div", "muted sm", "「" + modelLabel(state.cfg.embedModelId) + "」调用向量接口失败：" +
        String(st.embedError).slice(0, 160) + "。当前用关键词检索，不影响正常使用；" +
        "想用向量检索，把一个提供 /embeddings 的模型绑到「向量检索」。"));
      box.appendChild(warn);
    } else if (!st.embedded) {
      box.appendChild(el("p", "muted sm", "没有绑定向量模型，当前用关键词检索，不影响正常使用；想用向量检索，把带 /embeddings 的模型绑到「向量检索」。"));
    }
    if (st.skippedTotal > 0) {
      // 用户最可能遇到的情况：把 PDF/Word 放进目录却没被读到。静默跳过等于让他以为软件坏了。
      const warn = el("div", "skip-note");
      warn.appendChild(el("div", "skip-title", "未纳入 " + st.skippedTotal + " 个文件：" + (st.skippedSummary || "")));
      warn.appendChild(el("div", "muted sm", "桌面版能读的是 Markdown / 纯文本 / CSV / HTML / 日志 / JSON（含中文的 HTML 会按标题分章）。" +
        "PDF、Word、PPT 这类格式在纯仓颉里没有解析依赖，读不了——可以先另存为 Markdown 或文本再放进来。"));
      box.appendChild(warn);
    }
    const row = el("div", "row");
    row.appendChild(btn("去学 · 练", "primary", () => go("learn")));
    row.appendChild(btn("去检索", "", () => go("kb")));
    row.appendChild(btn("收起", "ghost", () => box.remove()));
    box.appendChild(row);
    v.insertBefore(box, v.firstChild);
    toast("索引完成：" + st.docCount + " 篇 / " + st.chunkCount + " 片");
  } catch (e) {
    card._stop();
    card.remove();
    const box = cardOf({ cls: "dialog", title: "建立索引失败" });
    box.appendChild(el("p", "muted", e.message));
    // 只有"看起来像目录问题"的失败才给目录相关的排查提示；
    // 模型/网络类错误挂一句"目录路径写错"只会把人带偏。
    const dirish = !/模型|接口|embeddings|联网|超时|TLS|connect/i.test(e.message);
    box.appendChild(el("p", "muted sm", dirish
      ? "常见原因：目录路径写错、目录里没有可读的文件、目录不可读。"
      : "这一条不是目录的问题：先按上面的原因处理（例如换成提供该接口的模型，或先取消绑定）。"));
    const row = el("div", "row");
    row.appendChild(btn("去检查目录", "primary", () => go("settings", "kb")));
    row.appendChild(btn("关闭", "ghost", () => box.remove()));
    box.appendChild(row);
    v.insertBefore(box, v.firstChild);
    toast("索引失败：" + e.message);
  }
}

/* ---------- 启动 ---------- */

async function boot() {
  initTitlebar();
  buildNav();
  // 偏好要在首屏之前读：否则深色用户会先看到一帧白底
  await loadPrefs();
  await loadWebMode();
  buildNav();
  try {
    const h = await api("/health");
    state.kernel = h;
    setStatus("内核已连接 · " + h.cangjie);
  } catch (e) {
    setStatus("内核未连接", true);
    const v = $("view");
    v.innerHTML = "";
    v.appendChild(emptyState({
      art: "alert",
      title: "内核没有连上",
      text: e.message + "。桌面窗口会自动带起内核；如果是直接在浏览器里打开，请先运行 tools/ui-flow.ps1。",
      actions: [btn("重新连接", "primary", () => boot())],
    }));
    return;
  }
  try {
    await loadOverview();
  } catch (e) {
    toast("读取配置失败：" + e.message);
  }
  try {
    state.tools = (await api("/api/tools/list", {})).tools || [];
  } catch (e) {
    state.tools = [];
  }
  document.addEventListener("keydown", (e) => {
    // 网页版就是 ⌘K / Ctrl+K，这里保持同一个习惯
    if ((e.ctrlKey || e.metaKey) && String(e.key || "").toLowerCase() === "k") {
      e.preventDefault();
      if (palette.open) closePalette(); else openPalette();
      return;
    }
    // Ctrl+Shift+S：收起 / 展开第二层面板（和 Codex 的同一个习惯）
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && String(e.key || "").toLowerCase() === "s") {
      e.preventDefault();
      togglePanel();
      return;
    }
    const playerRoot = $("player");
    const playerOpen = playerRoot && !playerRoot.hidden;
    // 检索弹层与播放器都不在时，Esc 关掉最上面那个弹层（比找右上角的按钮快）
    if (!palette.open && !playerOpen && e.key === "Escape") {
      const dlg = document.querySelector("#view .card.dialog");
      if (dlg) {
        e.preventDefault();
        dlg.remove();
        return;
      }
    }
    const root = playerRoot;
    if (!root || root.hidden) return;
    const tag = String((e.target && e.target.tagName) || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || tag === "select";
    if (e.key === "Escape") { e.preventDefault(); closePlayer(); return; }
    if (typing) return;
    if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
      e.preventDefault();
      playerGo(playerState.index + 1);
    } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
      e.preventDefault();
      playerGo(playerState.index - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      playerGo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      playerGo(playerState.slides.length - 1);
    } else if (e.key === "t" || e.key === "T") {
      playerState.tocOpen = !playerState.tocOpen;
      renderPlayer();
    }
  });
  /* 前进 / 后退。
     pushState 不会触发 hashchange，所以两个事件都得听：地址变了就按地址重渲染。
     自己维护的 navStack 只用来算两个箭头能不能点——history.length 分不出"在哪一格"。 */
  const onLocationChange = (ev) => {
    const st = ev && ev.state;
    const at = st && typeof st.i === "number" ? st.i : -1;
    const p = pageFromHash();
    if (p.page === current && (p.section || "") === (currentSection || "")) {
      if (at >= 0 && at !== navIndex) { navIndex = at; updateNavButtons(); }
      return;
    }
    go(p.page, p.section, { replace: true, fromHistory: true, index: at });
  };
  window.addEventListener("popstate", onLocationChange);
  window.addEventListener("hashchange", onLocationChange);

  const first = pageFromHash();
  await go(first.page, first.section, { replace: true });
}

boot();