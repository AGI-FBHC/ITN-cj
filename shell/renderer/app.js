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
  gear: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 12h2M18 12h2M12 4v2M12 18v2",
  clock: "M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  sliders: "M4 8h9M17 8h3M4 16h3M11 16h9M15 5v6M7 13v6",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l4 4",
  plus: "M12 5v14M5 12h14",
  play: "M7 4l12 8-12 8z",
  check: "M4 12l5 5L20 6",
  alert: "M12 3l9 16H3zM12 9v5M12 17h.5",
  layers: "M12 3l9 5-9 5-9-5zM3 14l9 5 9-5",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
};

function icon(name, box) {
  const d = ICONS[name] || ICONS.home;
  const vb = box ? "0 0 32 32" : "0 0 24 24";
  return '<svg viewBox="' + vb + '" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>';
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
    box.appendChild(tag("段落 " + report.paragraphs + " · 带引用 " + report.citedParagraphs +
      " · 越界 " + report.outOfRange, report.outOfRange > 0 ? "warn" : "ok"));
  }
  if (citations && citations.length) {
    const ul = el("ul", "cite-list");
    for (const c of citations) {
      const li = el("li");
      li.textContent = "[" + c.index + "] " + (c.docTitle ? "《" + c.docTitle + "》" : c.docPath || "") +
        (c.headingPath ? " · " + c.headingPath : "") + (c.docPath ? "（" + c.docPath + "）" : "");
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
  kb: "", chapter: null,
  chatSessionId: "", chatTurns: [], chatEvents: [], tools: null,
  busyTurn: false, pendingQuestion: "", lastQuestion: "",
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
async function loadReport() { state.report = (await api("/api/study/report", {})) || {}; }
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
    { done: hasChatModel(), title: "配置模型接口", text: "填一次 Base URL 和 API Key，并把「对话与生成」绑定到它。", go: () => go("models"), act: "去配置" },
    { done: kbs.length > 0, title: "指定资料目录", text: "选一个本机的 Markdown / 纯文本目录，作为这门课的知识库。", go: () => go("settings"), act: "去指定" },
    { done: kbs.some((k) => (k.chunkCount || 0) > 0), title: "建立索引", text: "扫描目录并按标题切片；这一步过后检索才有内容。", go: () => go("settings"), act: "去建立" },
    { done: state.sessions.length > 0, title: "问第一个问题", text: "在伴学助手里就你的资料提问，答案会标出出处编号。", go: () => go("chat"), act: "去提问" },
    { done: state.artifacts.length > 0, title: "生成第一份产物", text: "把一章做成讲义或练习，落成本机 Markdown 文件。", go: () => go("learn"), act: "去生成" },
  ];
  return steps;
}

/* ---------- 导航与路由 ---------- */

const NAV = [
  { group: "学习", items: [
    { id: "home", label: "我的学习", icon: "home" },
    { id: "learn", label: "学 · 练", icon: "book" },
    { id: "notes", label: "我的笔记", icon: "note" },
    { id: "wrong", label: "错题本", icon: "flag" },
    { id: "report", label: "我的成长", icon: "chart" },
  ]},
  { group: "内容", items: [
    { id: "resources", label: "我的资源", icon: "file" },
    { id: "kb", label: "领域知识库", icon: "db" },
  ]},
  { group: "助手", items: [
    { id: "chat", label: "伴学助手", icon: "chat" },
    { id: "sessions", label: "会话记录", icon: "clock" },
  ]},
  { group: "系统", items: [
    { id: "models", label: "模型与接口", icon: "gear" },
    { id: "settings", label: "档案与知识库", icon: "sliders" },
  ]},
];

const PAGE_META = {
  home: { title: "我的学习", sub: "今天学什么，从这里开始" },
  learn: { title: "学 · 练", sub: "按章节读资料、出题、生成讲义" },
  notes: { title: "我的笔记", sub: "随手记下的要点" },
  wrong: { title: "错题本", sub: "做错的题在这里复习" },
  report: { title: "我的成长", sub: "学习记录与能力变化" },
  resources: { title: "我的资源", sub: "生成的讲义与练习，全部在本机" },
  kb: { title: "领域知识库", sub: "检索资料，每一句都能追到原文" },
  chat: { title: "伴学助手", sub: "就你的资料提问" },
  sessions: { title: "会话记录", sub: "每一次检索、生成都留了可追溯的过程" },
  models: { title: "模型与接口", sub: "填写自己的模型服务，统一 OpenAI 兼容格式" },
  settings: { title: "档案与知识库", sub: "学习者档案与本地资料目录" },
};

function navBadge(id) {
  if (id === "notes") return state.report.noteCount || 0;
  if (id === "wrong") return state.report.quizWrong || 0;
  if (id === "resources") return state.artifacts.length || 0;
  if (id === "sessions") return state.sessions.length || 0;
  return 0;
}

function buildNav() {
  const nav = $("nav");
  nav.innerHTML = "";
  for (const g of NAV) {
    const box = el("div", "nav-group");
    box.appendChild(el("div", "nav-group-title", g.group));
    for (const it of g.items) {
      const b = el("button", "nav-item" + (it.id === current ? " active" : ""));
      const n = navBadge(it.id);
      b.innerHTML = icon(it.icon) + '<span class="nav-label">' + esc(it.label) + "</span>" +
        (n > 0 ? '<span class="nav-badge">' + n + "</span>" : "");
      b.onclick = () => go(it.id);
      box.appendChild(b);
    }
    nav.appendChild(box);
  }
}

function pageFromHash() {
  const m = String(location.hash || "").match(/^#\/([a-z]+)/);
  return m && PAGES[m[1]] ? m[1] : "home";
}

async function go(page, opts) {
  const target = PAGES[page] ? page : "home";
  current = target;
  const hash = "#/" + target;
  if (location.hash !== hash) {
    try { history.replaceState(null, "", hash); } catch (e) { location.hash = hash; }
  }
  if (target !== "chat") railShow(false);
  buildNav();
  const meta = PAGE_META[target];
  $("page-title").textContent = meta.title;
  $("page-sub").textContent = meta.sub;
  const ta = $("top-actions");
  ta.innerHTML = "";
  if (meta.actions) for (const a of meta.actions()) ta.appendChild(a);
  const v = $("view");
  v.innerHTML = '<div class="empty inline"><span class="spinner"></span> 加载中…</div>';
  document.querySelector(".main").scrollTop = 0;
  try {
    await PAGES[target].render();
  } catch (e) {
    v.innerHTML = "";
    v.appendChild(emptyState({
      art: "alert",
      title: "这一页没能加载出来",
      text: e.message,
      actions: [btn("重试", "primary", () => go(target))],
    }));
  }
  buildNav();
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
    main.appendChild(el("div", "eyebrow", "本地教培工作台 · 资料不出本机"));
    main.appendChild(el("h2", "hero-title",
      (state.profile.nickname ? state.profile.nickname + "，" : "") + "今天从哪一段开始？"));
    main.appendChild(el("p", "hero-sub", state.profile.goal
      ? "学习目标：" + state.profile.goal + (state.profile.weeklyHours ? " · 每周可投入 " + state.profile.weeklyHours + " 小时" : "")
      : "还没有写学习目标。到「档案与知识库」补一句，首页建议会跟着变。"));
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
      heroAct.appendChild(btn("先看看资料目录", "", () => go("settings")));
    } else if (!idx) {
      heroAct.appendChild(btn("建立知识库索引", "primary", () => go("settings")));
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
      steps.forEach((s, i) => {
        const item = el("div", "check-item" + (s.done ? " done" : ""));
        item.appendChild(el("div", "idx", s.done ? "✓" : String(i + 1)));
        const txt = el("div", "txt");
        txt.appendChild(el("b", null, s.title));
        txt.appendChild(el("span", null, s.text));
        item.appendChild(txt);
        if (!s.done) item.appendChild(btn(s.act, "sm primary", s.go));
        else item.appendChild(tag("已完成", "ok"));
        body.appendChild(item);
      });
      v.appendChild(cardOf({
        title: "开始使用（还剩 " + (steps.length - doneCount) + " 步）",
        sub: "五步走完，这个工作台就能自己出讲义了",
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
        actions: [btn(hasKb() ? "去建立索引" : "去指定资料目录", "primary", () => go("settings")),
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
          actions: [btn("去指定资料目录", "primary", () => go("settings")),
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
                btn("换一个目录", "", () => go("settings"))],
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
  head.appendChild(tag(readCount + " / " + chunks.length + " 片已读", readCount === chunks.length && chunks.length ? "ok" : ""));
  const acts = el("div", "row");
  acts.style.marginTop = "10px";
  acts.appendChild(btn("生成讲义", "primary sm", () => askTopic("lecture", state.chapter)));
  acts.appendChild(btn("生成练习册", "sm", () => askTopic("quiz", state.chapter)));
  acts.appendChild(btn("出题练习", "sm", () => openQuiz(v, state.chapter)));
  acts.appendChild(btn("写笔记", "sm ghost", () => openNoteEditor(null, state.kb, state.chapter)));
  acts.appendChild(btn("整章标记已读", "sm ghost", async () => {
    for (const c of chunks) {
      if (c.read) continue;
      await api("/api/study/read", { kbId: state.kb, chunkId: c.id, chapter: state.chapter, chapterDone: true });
    }
    toast("已标记整章");
    go("learn");
  }));
  bar.appendChild(acts);
  const prog = el("div", "bar");
  prog.innerHTML = '<i style="width:' + pct(readCount, chunks.length) + '%"></i>';
  prog.style.marginTop = "12px";
  bar.appendChild(prog);
  v.appendChild(bar);

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
    row.appendChild(btn(c.read ? "取消已读标记？重读一次" : "标记已读", "sm " + (c.read ? "ghost" : ""), async () => {
      await api("/api/study/read", { kbId: state.kb, chunkId: c.id, chapter: state.chapter });
      toast("已标记");
      go("learn");
    }));
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

/** 调内核的生成链路（讲义 / 练习册），结果落在 artifacts 目录。 */
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
  v.insertBefore(card, v.firstChild);
  card.scrollIntoView({ block: "start" });
  let d;
  try {
    d = await api(kind === "lecture" ? "/api/agent/lecture" : "/api/agent/quiz",
      { kbId: state.kb, topic: topic, count: kind === "quiz" ? 5 : undefined });
  } catch (e) {
    card._stop();
    card.remove();
    const box = cardOf({ cls: "dialog", title: "生成失败" });
    box.appendChild(el("p", "muted", e.message));
    const row = el("div", "row");
    row.appendChild(btn("检查模型设置", "primary", () => go("models")));
    row.appendChild(btn("看会话记录", "", () => go("sessions")));
    row.appendChild(btn("关闭", "ghost", () => box.remove()));
    box.appendChild(row);
    v.insertBefore(box, v.firstChild);
    return;
  }
  card._stop();
  card.remove();
  if (!d || d.ok !== true) {
    const msg = (d && d.message) || "内核没有返回内容";
    const box = cardOf({
      cls: "dialog",
      title: "没有生成成功",
      body: (() => {
        const w = el("div");
        w.appendChild(el("p", "muted", msg + "（查看「会话记录」可以看到这次调用停在哪一步）"));
        const row = el("div", "row");
        row.appendChild(btn("去设置模型", "primary", () => go("models")));
        row.appendChild(btn("看会话记录", "", () => go("sessions")));
        row.appendChild(btn("关闭", "ghost", () => box.remove()));
        w.appendChild(row);
        return w;
      })(),
    });
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
  row.appendChild(btn("打开产物全文", "primary", () => openArtifactByName(artifactNameFromPath(d.artifactPath), d.content)));
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
    const records = data.records || [];
    const card = cardOf({
      title: "错题本",
      tag: records.length + " 条",
      sub: "答错的题会自动收进来",
      actions: [btn("再练一组", "primary sm", () => {
        if (!state.chapter) { go("learn"); return; }
        openQuiz(v, state.chapter);
      })],
    });
    if (!records.length) {
      card.appendChild(emptyState({
        art: "flag",
        title: "还没有错题",
        text: "在「学 · 练」里对某一章出题练习，答错的题会记录在这里，方便回头复习。",
        actions: [btn("去做一组练习", "primary", () => go("learn")),
                  btn("看看我的成长", "", () => go("report"))],
      }));
    } else {
      const list = el("div", "list");
      for (const q of records) {
        const it = el("div", "item");
        it.appendChild(el("div", "item-title", q.question || "（题干缺失）"));
        const meta = el("div", "meta");
        if (q.chapter) meta.appendChild(el("span", null, q.chapter));
        if (q.createdAt) meta.appendChild(el("span", null, fmtStamp(q.createdAt)));
        it.appendChild(meta);
        const mine = el("div", "answer-line wrong-line", "我的答案：" + (q.myAnswer || "（空）"));
        it.appendChild(mine);
        if (q.reference) it.appendChild(el("div", "answer-line", "参考答案：" + q.reference));
        list.appendChild(it);
      }
      card.appendChild(list);
    }
    v.appendChild(card);

    if (records.length) {
      const retry = el("div", "card");
      retry.innerHTML = '<div class="card-head"><h2>复习建议</h2></div>';
      const tips = el("div", "list");
      const byChapter = {};
      for (const q of records) {
        const key = q.chapter || "未分章";
        byChapter[key] = (byChapter[key] || 0) + 1;
      }
      Object.keys(byChapter)
        .sort((a, b) => byChapter[b] - byChapter[a])
        .slice(0, 5)
        .forEach((key) => {
          const it = el("div", "item clickable");
          const row = el("div", "row");
          const main = el("div", "grow");
          main.appendChild(el("div", "item-title", key));
          main.appendChild(el("div", "meta", byChapter[key] + " 道错题"));
          row.appendChild(main);
          row.appendChild(btn("回到这一章", "sm primary", () => { state.chapter = key === "未分章" ? null : key; go("learn"); }));
          it.appendChild(row);
          tips.appendChild(it);
        });
      retry.appendChild(tips);
      v.appendChild(retry);
    }
  },
};

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

    const scores = (r.profile && r.profile.selfScores) ? r.profile.selfScores : {};
    const keys = Object.keys(scores);
    const ability = cardOf({
      title: "自评能力",
      sub: "由你在「档案与知识库」里维护",
      actions: [btn("去更新", "sm ghost", () => go("settings"))],
    });
    if (!keys.length) {
      ability.appendChild(emptyState({
        inline: true,
        art: "chart",
        title: "还没有填写自评能力",
        text: "填 0-100 的自评分，成长页就能和做题正确率对照着看。",
        actions: [btn("去填写", "primary", () => go("settings"))],
      }));
    } else {
      for (const k of keys) {
        const val = Number(scores[k]) || 0;
        const line = el("div", "score-line");
        line.innerHTML = '<div class="row"><span class="grow">' + esc(k) + '</span><span class="muted sm">' + val + "</span></div>";
        const bar = el("div", "bar");
        bar.innerHTML = '<i style="width:' + Math.max(0, Math.min(100, val)) + '%"></i>';
        line.appendChild(bar);
        ability.appendChild(line);
      }
    }
    v.appendChild(ability);

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
      actions: [btn("看全部会话", "sm ghost", () => go("sessions"))],
    });
    if (!state.sessions.length) {
      activity.appendChild(emptyState({
        inline: true,
        art: "clock",
        title: "还没有会话记录",
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
  const row = el("div", "row");
  const ic = el("div", "file-icon");
  ic.innerHTML = icon(kind === "lecture" ? "layers" : "file");
  const main = el("div", "grow");
  main.appendChild(el("div", "item-title", a.name));
  const meta = el("div", "meta");
  meta.appendChild(el("span", null, ARTIFACT_KIND_LABEL[kind]));
  meta.appendChild(el("span", null, fmtSize(a.size)));
  meta.appendChild(el("span", null, "本机 Markdown"));
  main.appendChild(meta);
  row.appendChild(ic);
  row.appendChild(main);
  row.appendChild(tag(ARTIFACT_KIND_LABEL[kind], kind === "lecture" ? "ok" : ""));
  it.appendChild(row);
  it.onclick = () => openArtifactByName(a.name);
  return it;
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
    const card = cardOf({
      title: "已生成的产物",
      sub: "全部存在本机 artifacts 目录",
      tag: state.artifacts.length + " 份",
      actions: [btn("再生成一份", "sm primary", () => go("learn")), btn("刷新", "sm ghost", () => go("resources"))],
    });
    const seg = el("div", "seg");
    const kinds = [["all", "全部"], ["lecture", "讲义"], ["quiz", "练习册"]];
    for (const [k, label] of kinds) {
      const b = el("button", "seg-item" + (filter === k ? " active" : ""), label);
      b.onclick = () => { state.artifactFilter = k; go("resources"); };
      seg.appendChild(b);
    }
    card.appendChild(seg);
    const list = el("div", "list");
    const items = state.artifacts.filter((a) => filter === "all" || ARTIFACT_KIND(a.name) === filter);
    if (!items.length) {
      card.appendChild(emptyState({ inline: true, art: "file", title: "这个分类下还没有产物", text: "换个分类看看，或者现在生成一份。", actions: [btn("去生成", "primary", () => go("learn"))] }));
    } else {
      for (const a of items) list.appendChild(artifactItem(a, true));
      card.appendChild(list);
    }
    v.appendChild(card);
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
    actions: [copyButton(() => content, "复制全文"), btn("← 返回我的资源", "ghost sm", () => go("resources"))],
  });
  v.appendChild(top);
  const body = el("div", "card");
  body.innerHTML = md(content || "");
  v.appendChild(body);
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
          actions: [btn("去指定资料目录", "primary", () => go("settings"))],
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

    const stats = cardOf({
      title: "索引状态",
      sub: kbName(state.kb),
      actions: [btn("重建索引", "sm", () => buildIndex(state.kb)), btn("管理知识库", "sm ghost", () => go("settings"))],
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
    }
    v.appendChild(stats);
  },
};
/* ---------- 伴学助手：会话栏 + 主对话框（对标 Codex 的形态） ---------- */

const KIND_LABEL = { ask: "问答", lecture: "讲义", quiz: "练习", "": "对话" };
const TOOL_LABEL = {
  kb_search: "检索知识库",
  list_documents: "列出文档",
  read_chunk: "读取切片",
  current_time: "当前时间",
  calc: "计算",
  save_note: "写笔记",
  save_artifact: "写产物",
};

function railShow(on) {
  const rail = $("session-rail");
  if (rail) rail.hidden = !on;
  document.body.classList.toggle("chat-mode", !!on);
}

function railRender() {
  const rail = $("session-rail");
  if (!rail || rail.hidden) return;
  const list = $("rail-list");
  if (!list) return;
  const q = String(($("rail-search") || {}).value || "").trim().toLowerCase();
  const items = state.sessions.filter((s) => !q || String(s.title || "").toLowerCase().indexOf(q) >= 0);
  list.innerHTML = "";
  if (!items.length) {
    list.appendChild(el("div", "rail-empty",
      state.sessions.length ? "没有匹配的会话" : "还没有对话。点上面的「新建」开始第一轮。"));
    return;
  }
  for (const s of items) {
    const b = el("button", "rail-item" + (s.sessionId === state.chatSessionId ? " active" : ""));
    b.appendChild(el("div", "rail-item-title", s.title || "新对话"));
    b.appendChild(el("div", "rail-item-meta",
      (KIND_LABEL[s.kind || ""] || "对话") + " · " + s.eventCount + " 步 · " + fmtStamp(s.lastAt).slice(6)));
    b.onclick = () => { state.chatSessionId = s.sessionId; go("chat"); };
    list.appendChild(b);
  }
}

async function reloadSessions() {
  await loadSessions();
  buildNav();
  railRender();
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
  } else if (!live && t.ok === false) {
    const e = el("div", "msg msg-ai");
    e.appendChild(el("div", "msg-who", "伴学助手"));
    e.appendChild(el("div", "msg-body err-text", t.message || "这一轮没有完成"));
    box.appendChild(e);
  }
  return box;
}

PAGES.chat = {
  async render() {
    await loadCfg();
    railShow(true);
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
      railRender();
      return;
    }

    /* 顶部工具条 */
    const bar = el("div", "chat-head");
    if (hasKb()) bar.appendChild(kbSelector(() => { state.chatSessionId = ""; state.chatTurns = []; go("chat"); }));
    else bar.appendChild(tag("未配知识库 · 直接问模型", "warn"));
    bar.appendChild(spacer());
    bar.appendChild(tag("模型 " + (modelLabel(state.cfg.chatModelId) || state.cfg.chatModelId), "ok"));
    if (hasKb()) bar.appendChild(tag("检索：" + kbName(state.kb)));
    const toolBtn = btn("工具 " + (state.tools ? state.tools.length : ""), "sm ghost", () => {
      const box = $("tool-sheet");
      if (box) box.hidden = !box.hidden;
    });
    bar.appendChild(toolBtn);
    bar.appendChild(btn("全部会话", "sm ghost", () => go("sessions")));
    bar.appendChild(btn("新建对话", "sm primary", () => newChat()));
    v.appendChild(bar);

    const sheet = el("div", "card tool-sheet");
    sheet.id = "tool-sheet";
    sheet.hidden = true;
    sheet.appendChild(el("div", "card-head", ""));
    sheet.querySelector(".card-head").appendChild(el("h2", null, "Agent 可调用的本地工具"));
    sheet.querySelector(".card-head").appendChild(spacer());
    sheet.querySelector(".card-head").appendChild(el("span", "card-sub", "模型按需自己调，不需要你操作"));
    const tlist = el("div", "list");
    const tools = state.tools || [];
    if (!tools.length) {
      tlist.appendChild(el("div", "muted sm", "（还没读到工具清单）"));
    } else {
      for (const t of tools) {
        const it = el("div", "item");
        it.appendChild(el("div", "item-title", (TOOL_LABEL[t.name] || t.name) + "  " + t.name));
        it.appendChild(el("div", "muted sm", t.desc));
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

    const inputRow = el("div", "composer");
    const ta = el("textarea");
    ta.id = "chat-input";
    ta.rows = 3;
    ta.placeholder = hasKb()
      ? "就你的资料提问，回答会标出处；也可以直接说「帮我算一下」「看下有哪些文档」。Enter 发送，Shift+Enter 换行"
      : "提一个问题。Enter 发送，Shift+Enter 换行";
    inputRow.appendChild(ta);
    const crow = el("div", "composer-row");
    const quick = el("div", "row");
    quick.appendChild(btn("生成讲义", "sm ghost", () => askTopic("lecture", topicFromText(state.lastQuestion || ""))));
    quick.appendChild(btn("生成练习册", "sm ghost", () => askTopic("quiz", topicFromText(state.lastQuestion || ""))));
    crow.appendChild(quick);
    crow.appendChild(spacer());
    const sendBtn = btn("发送", "primary", () => send());
    crow.appendChild(sendBtn);
    inputRow.appendChild(crow);
    v.appendChild(inputRow);

    if (state.pendingQuestion) {
      ta.value = state.pendingQuestion;
      state.pendingQuestion = "";
    }

    function paint() {
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
          ] : [btn("去指定资料目录", "", () => go("settings"))],
        }));
      } else {
        for (const t of state.chatTurns) thread.appendChild(renderTurnBlock(t, !t.answer && state.busyTurn));
      }
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
        const res = await api("/api/agent/ask", { kbId: state.kb, question: text, sessionId: sid });
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
      if (failure) toast("生成失败：" + failure);
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
    railRender();
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
  go("sessions");
}

PAGES.sessions = {
  async render() {
    await loadSessions();
    const v = $("view");
    v.innerHTML = "";
    if (state.sessionId) {
      await renderSessionDetail(v, state.sessionId);
      return;
    }
    const card = cardOf({
      title: "会话记录",
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
        main.appendChild(el("div", "meta", s.eventCount + " 条事件 · 最后 " + (EVENT_LABEL[s.lastType] || s.lastType || "—") + " · " + fmtStamp(s.lastAt)));
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

async function renderSessionDetail(v, sessionId) {
  const d = await api("/api/sessions/events", { sessionId: sessionId });
  const events = d.events || [];
  const meta = state.sessions.find((s) => s.sessionId === sessionId) || {};
  const card = cardOf({
    title: meta.title || sessionId,
    sub: events.length + " 条事件 · " + fmtStamp(meta.lastAt),
    actions: [btn("← 返回列表", "ghost sm", () => { state.sessionId = ""; go("sessions"); })],
  });
  if (!events.length) {
    card.appendChild(emptyState({
      inline: true, art: "clock", title: "这个会话没有事件", text: "可能已经被清理。",
      actions: [btn("返回列表", "", () => { state.sessionId = ""; go("sessions"); })],
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

PAGES.models = {
  async render() {
    await loadCfg();
    const v = $("view");
    v.innerHTML = "";

    const mcard = el("div", "card");
    mcard.innerHTML = '<div class="card-head"><h2>添加 / 更新模型</h2><div class="spacer"></div>' +
      '<span class="card-sub">密钥只写进本机数据库，接口永不回传</span></div>';
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
        go("models");
      } catch (e) { toast("保存失败：" + e.message); }
    }));
    mact.appendChild(btn("清空表单", "ghost", () => go("models")));
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
          document.querySelector(".main").scrollTop = 0;
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
          go("models");
        }));
        acts.appendChild(btn("填到表单", "sm ghost", () => {
          $("m-id").value = m.id;
          $("m-name").value = m.name || "";
          $("m-base").value = m.baseUrl || "";
          $("m-model").value = m.model || "";
          $("m-vision").value = m.visionModel || "";
          $("m-embed").value = m.embeddingModel || "";
          $("m-key").value = "";
          document.querySelector(".main").scrollTop = 0;
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
          go("models");
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
        go("models");
      } catch (e) { toast("保存失败：" + e.message); }
    }));
    v.appendChild(role);
  },
};
/* ---------- 档案与知识库 ---------- */

const SELF_SCORE_KEYS = ["概念理解", "逻辑推理", "工程实践", "问题诊断", "系统设计", "学习迁移"];

PAGES.settings = {
  async render() {
    await loadCfg();
    await loadProfile();
    const v = $("view");
    v.innerHTML = "";
    const p = state.profile || {};

    const prof = cardOf({
      title: "学习者档案",
      sub: "只存在本机数据库",
      actions: [btn("保存档案", "primary sm", async () => {
        const body = { nickname: $("pf-nick").value.trim(), goal: $("pf-goal").value.trim(), weeklyHours: Number($("pf-hours").value) || 0, selfScores: {} };
        for (const k of SELF_SCORE_KEYS) {
          const val = Number((document.getElementById("pf-score-" + k) || {}).value);
          if (val > 0) body.selfScores[k] = Math.max(0, Math.min(100, val));
        }
        try {
          await api("/api/profile/save", body);
          toast("档案已保存");
          go("settings");
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
    prof.appendChild(el("p", "muted sm", "自评分只在「我的成长」里用来和做题正确率对照，不参与评分。"));
    v.appendChild(prof);

    const kbCard = cardOf({
      title: "知识库",
      sub: "指定本机目录，递归读取 Markdown 与纯文本",
      tag: state.cfg.knowledgeBases.length + " 个",
    });
    const form = el("div", "kb-form");
    const fr = el("div", "row");
    fr.appendChild(fieldOf("标识（英文短名）", inputOf("kb-id", "course")));
    fr.appendChild(fieldOf("显示名称", inputOf("kb-name", "我的课程资料")));
    form.appendChild(fr);
    const dirInput = inputOf("kb-dir", "D:\\资料\\课程");
    dirInput.className = "grow";
    form.appendChild(fieldOf("目录绝对路径", dirInput));
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
        go("settings");
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
        acts.appendChild(btn("删除", "sm ghost", async () => {
          await api("/api/kb/delete", { id: k.id });
          toast("已删除登记（本机原文件不会被删）");
          await loadCfg();
          go("settings");
        }));
        it.appendChild(acts);
        kbox.appendChild(it);
      }
      kbCard.appendChild(kbox);
    }
    v.appendChild(kbCard);

    const about = cardOf({ title: "数据与隐私" });
    const ul = el("ul", "about-list");
    [
      "所有配置、学习记录、切片与向量都存在本机的 SQLite 单文件数据库里，可以整体拷走或备份。",
      "资料只发给你自己配置的模型服务，不经过任何第三方服务器。",
      "API Key 只写进本机数据库；「模型与接口」页面读取配置时永不回传密钥本身。",
      "讲义与练习是可复现的本地 Markdown 文件，放在数据目录的 artifacts 子目录下。",
    ].forEach((t) => ul.appendChild(el("li", null, t)));
    about.appendChild(ul);
    v.appendChild(about);
  },
};
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

function openNoteEditor(note, kbId, chapter) {
  const v = $("view");
  const dlg = el("div", "card dialog");
  const head = cardHeadOnly(note ? "编辑笔记" : "写笔记");
  if (chapter) head.appendChild(tag(chapter));
  if (kbId) head.appendChild(tag(kbName(kbId)));
  dlg.appendChild(head);
  dlg.appendChild(fieldOf("标题", inputOf("nt-title", "这一段的要点", note ? note.title : "")));
  const ta = el("textarea");
  ta.id = "nt-text";
  ta.rows = 8;
  ta.value = note ? (note.text || "") : "";
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
    if (!st.embedded) {
      box.appendChild(el("p", "muted sm", "没有绑定向量模型，当前用关键词检索，不影响正常使用；想用向量检索，把带 /embeddings 的模型绑到「向量检索」。"));
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
    box.appendChild(el("p", "muted sm", "常见原因：目录路径写错、目录里没有 .md/.txt 文件、目录不可读。"));
    const row = el("div", "row");
    row.appendChild(btn("去检查目录", "primary", () => go("settings")));
    row.appendChild(btn("关闭", "ghost", () => box.remove()));
    box.appendChild(row);
    v.insertBefore(box, v.firstChild);
    toast("索引失败：" + e.message);
  }
}

/* ---------- 启动 ---------- */

async function boot() {
  buildNav();
  try {
    const h = await api("/health");
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
  const railSearch = $("rail-search");
  if (railSearch) railSearch.oninput = () => railRender();
  const railNew = $("rail-new");
  if (railNew) railNew.onclick = () => newChat();
  const railAll = $("rail-all");
  if (railAll) railAll.onclick = () => go("sessions");
  window.addEventListener("hashchange", () => {
    const p = pageFromHash();
    if (p !== current) go(p);
  });
  await go(pageFromHash());
}

boot();