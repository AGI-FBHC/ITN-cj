/* Lumin 前端：无框架、无构建，界面由仓颉内核托管。
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

async function api(path, body, signal) {
  const init = { method: body === undefined ? "GET" : "POST" };
  if (signal) init.signal = signal;
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
  s.textContent = "";
  s.title = text;
  s.setAttribute("aria-label", text);
  s.dataset.connection = isErr ? "offline" : "online";
  s.classList.toggle("err", !!isErr);
}

let connectionTimer = null;
async function refreshKernelConnection() {
  try {
    const h = await api("/health", undefined, AbortSignal.timeout(4000));
    if (h.status !== "ok") throw new Error("内核未就绪");
    state.kernel = h;
    setStatus("内核已连接");
  } catch (e) { setStatus("内核未连接", true); }
}

function startConnectionMonitor() {
  clearInterval(connectionTimer);
  connectionTimer = setInterval(() => {
    if (!document.hidden) refreshKernelConnection();
  }, 5000);
}

/* ---------- 启动动画收尾 ----------
   启动动画分两段：内核冷启动时是 splash.html（窗口先亮出来），内核就绪后切到应用页，
   应用页自带同款动画层，等首屏真正渲染完（boot() 返回）再淡出。这里负责第二段。 */
const BOOT_AT = performance.now();
let bootSplashDone = false;
function finishBootSplash() {
  if (bootSplashDone) return;
  bootSplashDone = true;
  const node = document.getElementById("boot");
  if (!node) return;
  const wait = Math.max(0, 520 - (performance.now() - BOOT_AT));
  setTimeout(() => {
    node.classList.add("done");
    setTimeout(() => node.remove(), 460);
  }, wait);
}
/* 兜底：无论哪一步卡住（内核慢、配置读不动），最多 8 秒后都不让开屏挡住界面 */
setTimeout(finishBootSplash, 8000);

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

/** 会话栏时间：今天只显示时分；非今天补日期，跨年再补年份。 */
function fmtRailStamp(s) {
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return fmtStamp(s);
  const p = (x) => String(x).padStart(2, "0");
  const now = new Date();
  const hm = p(d.getHours()) + ":" + p(d.getMinutes());
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
  const md = p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + hm;
  return d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + "-" + md;
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
  dots: "M12 6h.01M12 12h.01M12 18h.01",
  // 横排三个点（顶栏"更多"用）：画成实心圆，比描边小点清楚
  dotsH: '<circle cx="5.2" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="18.8" cy="12" r="2" fill="currentColor" stroke="none"/>',
  folder: "M3.5 6.5a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-14a1 1 0 0 1-1-1z",
  // 新会话：一个方框 + 一支笔（Codex 侧栏项目行右边那个）
  compose: "M4 5.5A1.5 1.5 0 0 1 5.5 4H12M20 12v6.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4M17.5 3.2l3.3 3.3-7.6 7.6-4.2.9.9-4.2z",
  pin: "M9 3h6l-.8 5.2 3.3 3.3v1.7H13v4.6l-1 2.2-1-2.2v-4.6H6.5v-1.7l3.3-3.3z",
  close: "M6 6l12 12M18 6L6 18",
  copy: "M9 9h11v11H9zM5 15V4h11",
  // 会话分支：照着 Codex 的图标画 —— 一条从左中拐向右上的箭头 + 一条右下斜箭头
  branch: '<path d="M3.8 13.1h4.3a3.3 3.3 0 0 0 2.3-1l6.3-6.3"/><path d="M11.6 5.8h5.1v5.1"/><path d="M13.9 14.3l4.4 4.4"/><path d="M13.9 18.7h4.4v-4.4"/>',
  code: "M9 8l-4 4 4 4M15 8l4 4-4 4",
  pencil: "M4 20h4L20 8l-4-4L4 16z",
  label: '<path d="M3.6 11.2V5a1.4 1.4 0 0 1 1.4-1.4h6.2l9 9a1.4 1.4 0 0 1 0 2l-6 6a1.4 1.4 0 0 1-2 0z"/><circle cx="8.4" cy="8.4" r="1.4" fill="currentColor" stroke="none"/>',
  // 看差异（改了哪几行）：一条竖分隔 + 加号 / 减号
  diff: "M12 4v16M6.5 8.5h4M8.5 6.5v4M15 14.5h4",
  // 撤销（还原）：一个回头的箭头
  undo: "M9 5 4 10l5 5M4 10h11a5 5 0 0 1 0 10h-2",
  hand: '<path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v-2a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2.5"/><path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
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

function decodeMarkdownAttribute(value) {
  const node = document.createElement("textarea"); node.innerHTML = value; return node.value;
}

function documentImageTag(source, alt, options, width) {
  const src = decodeMarkdownAttribute(source || "").trim();
  const remote = /^(https?:)?\/\//i.test(src);
  const embedded = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src);
  if (!src || (!remote && !embedded && (!options.kbId || /^[a-z][\w+.-]*:/i.test(src)))) return esc(alt || "图片");
  const img = document.createElement("img");
  img.className = "kb-document-image";
  img.alt = decodeMarkdownAttribute(alt || "资料配图");
  img.loading = "lazy"; img.decoding = "async"; img.referrerPolicy = "no-referrer";
  if (width && /^(?:[1-9]\d{0,3})(?:%|px)?$/.test(width)) {
    const amount = parseInt(width, 10);
    if (width.endsWith("%") ? amount <= 100 : amount <= 4000) img.style.width = /^\d+$/.test(width) ? width + "px" : width;
  }
  if (embedded || !options.kbId) img.src = src.startsWith("//") ? "https:" + src : src;
  else { img.dataset.kbImage = src; img.dataset.kbId = options.kbId; img.dataset.docPath = options.docPath || ""; }
  return img.outerHTML;
}

function safeDocumentTag(escapedTag, options) {
  const match = escapedTag.match(/^&lt;(\/?)([a-z]+)\b/i);
  if (!match) return escapedTag;
  const name = match[2].toLowerCase();
  if (!["strong", "b", "em", "i", "u", "s", "sup", "sub", "br", "div", "p", "figure", "figcaption", "img"].includes(name)) return escapedTag;
  if (match[1]) return ["img", "br"].includes(name) ? "" : "</" + name + ">";
  const template = document.createElement("template"); template.innerHTML = decodeMarkdownAttribute(escapedTag);
  const original = template.content.firstElementChild;
  if (!original) return "";
  if (name === "img") return documentImageTag(original.getAttribute("src"), original.getAttribute("alt"), options, original.getAttribute("width"));
  const node = document.createElement(name);
  if (["left", "center", "right"].includes(original.getAttribute("align"))) node.className = "doc-align-" + original.getAttribute("align");
  return node.outerHTML.replace(new RegExp("</" + name + ">$"), "");
}

function hydrateKnowledgeImages(root) {
  for (const img of root.querySelectorAll("img[data-kb-image]")) {
    const load = async () => {
      img.onerror = () => {
        if (!img.isConnected) return;
        const fallback = el("div", "kb-image-unavailable");
        fallback.append(el("span", null, (img.alt || "图片") + " · 暂不可用"), btn("重试", "ghost sm", () => { fallback.replaceWith(img); img.removeAttribute("src"); load(); }));
        img.replaceWith(fallback);
      };
      try {
        const data = await api("/api/kb/image", { id: img.dataset.kbId, docPath: img.dataset.docPath, source: img.dataset.kbImage });
        if (img.isConnected) img.src = data.dataUrl || data.url;
      } catch (e) { img.onerror(); }
    };
    load();
  }
}

function md(src, options = {}) {
  const text = String(src == null ? "" : src);
  const lines = esc(text).split("\n");
  const out = [];
  let inCode = false, listType = null;
  const closeList = () => { if (listType) { out.push(listType === "ul" ? "</ul>" : "</ol>"); listType = null; } };
  const inline = (s) => {
    const held = [];
    const hold = html => { const key = held.push(html) - 1; return "\uE000" + key + "\uE001"; };
    s = s.replace(/`([^`]+)`/g, (_, code) => hold("<code>" + code + "</code>"));
    if (options.document) {
      s = s.replace(/&lt;\/?(?:strong|b|em|i|u|s|sup|sub|br|div|p|figure|figcaption|img)\b.*?&gt;/gi, tag => hold(safeDocumentTag(tag, options)));
      s = s.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_, alt, target) => {
        const source = target.match(/^&lt;(.*?)&gt;(?:\s+.*)?$/)?.[1] || target.replace(/\s+&quot;.*&quot;$/, "");
        return hold(documentImageTag(source, alt, options));
      });
    }
    return s.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '<span class="md-img">图片 · $1</span>')
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+|mailto:[^)\s]+|lumin:[^)\s]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[(\d+)\]/g, '<span class="cite">[$1]</span>')
    .replace(/\uE000(\d+)\uE001/g, (_, key) => held[Number(key)] || "");
  };
  /* GFM 表格的单元格切分：\| 是转义竖线，不当分隔符（结构对照 pi-studio 的 MarkdownBody + remark-gfm，MIT）。 */
  const cells = (row) => {
    let r = row.trim();
    if (r.startsWith("|")) r = r.slice(1);
    if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
    const parts = [];
    let cur = "";
    for (let i = 0; i < r.length; i++) {
      const ch = r[i];
      if (ch === "\\" && r[i + 1] === "|") { cur += "|"; i++; continue; }
      if (ch === "|") { parts.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    parts.push(cur.trim());
    return parts;
  };
  const alignments = (row) => {
    const c = cells(row);
    if (!c.length) return null;
    const al = [];
    for (const cell of c) {
      const t = cell.replace(/\s/g, "");
      if (!/^:?-{1,}:?$/.test(t)) return null;
      al.push(t.startsWith(":") && t.endsWith(":") ? "ta-c" : t.endsWith(":") ? "ta-r" : "ta-l");
    }
    return al;
  };
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.replace(/\s+$/, "");
    if (/^\s*```/.test(line)) { closeList(); out.push(inCode ? "</code></pre>" : "<pre><code>"); inCode = !inCode; continue; }
    if (inCode) { out.push(raw); continue; }
    if (options.document && /^\s*&lt;\/?(?:div|p|figure|figcaption)\b/i.test(line)) { closeList(); out.push(inline(line)); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); const n = h[1].length; out.push("<h" + n + ">" + inline(h[2]) + "</h" + n + ">"); continue; }
    if (/^\s*$/.test(line)) { closeList(); continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { closeList(); out.push("<hr>"); continue; }
    // GFM 表格：当前行是表头，下一行是 |---|:--:| 这类分隔行
    if (line.includes("|") && li + 1 < lines.length) {
      const al = alignments(lines[li + 1]);
      const head = cells(line);
      if (al && head.length > 0) {
        closeList();
        const align = head.map((_, i) => al[i] || "ta-l");
        const rows = [];
        let rj = li + 2;
        while (rj < lines.length && lines[rj].trim() !== "" && lines[rj].includes("|")) { rows.push(cells(lines[rj])); rj++; }
        const norm = (r) => { const a = r.slice(0, head.length); while (a.length < head.length) a.push(""); return a; };
        let html = '<div class="md-table-wrap"><table><thead><tr>';
        norm(head).forEach((c, i) => { html += '<th class="' + align[i] + '">' + inline(c) + "</th>"; });
        html += "</tr></thead><tbody>";
        for (const r of rows) { html += "<tr>"; norm(r).forEach((c, i) => { html += '<td class="' + align[i] + '">' + inline(c) + "</td>"; }); html += "</tr>"; }
        html += "</tbody></table></div>";
        out.push(html);
        li = rj - 1;
        continue;
      }
    }
    const bq = line.match(/^\s*&gt;\s?(.*)$/);
    if (bq) { closeList(); out.push("<blockquote>" + inline(bq[1]) + "</blockquote>"); continue; }
    // 任务清单（GFM）：- [x] 完成 / - [ ] 未完成
    const task = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push('<li class="md-task"><span class="md-task-box' + (task[1] === " " ? "" : " done") + '"></span><span>' + inline(task[2]) + "</span></li>");
      continue;
    }
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
  if (o.art === "brand") {
    // 主 logo：浅色用浅底那版、深色用深底那版（applyTheme 里会跟着主题换）
    badge.classList.add("empty-badge-brand");
    const img = el("img", "empty-logo");
    img.src = state.dark ? "/logo-dark.png" : "/logo-light.png";
    img.alt = "Lumin";
    img.draggable = false;
    badge.appendChild(img);
  } else {
    badge.innerHTML = icon(o.art || "plus", true);
  }
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
    // 一切正常时不摆统计（"段落 N · 带引用 M" 这类小字只是噪声）；只有真有问题才提醒
    const bad = (report.outOfRange || 0) + (report.outOfRangeWeb || 0);
    if (bad > 0) box.appendChild(tag("有 " + bad + " 处引用越界，正文编号可能对不上", "warn"));
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
  cfg: { models: [], knowledgeBases: [], chatModelId: "", embedModelId: "", chunkModelId: "", ttsModelId: "" },
  profile: {}, report: {}, artifacts: [], sessions: [],
  kb: "", chapter: null, artifactQuery: "", wrongTab: "due", wrongQuery: "",
  chatSessionId: "", chatTurns: [], chatEvents: [], tools: null, chatQuery: "", artifactFocus: "",
  webMode: "auto", skill: "", skills: [], lastReportArtifact: "", chatKb: null, railGroups: {},
  projects: [], chatProject: "", chatMode: "chat", railExpanded: {},
  busyTurn: false, pendingQuestion: "", lastQuestion: "", chatRequests: new Map(),
  // 主题与会话栏偏好存在内核的 settings 表里（内核端口每次启动都变，localStorage 活不过一次重启）
  theme: "system", dark: false, panelHidden: false, kernel: null, uiZoom: 1, uiFont: 1,
};

let current = "home";
let ttsPreviewAudio = null;

/** 桌宠只接收“状态摘要”，不参与业务；没有桌宠时事件也不会影响页面。 */
function mascotActivity(activityState, busyCount) {
  window.dispatchEvent(new CustomEvent("lumin:activity", {
    detail: { state: activityState, busyCount: Number(busyCount || 0) },
  }));
}

// 独立脚本（导学页、任务面板）也能上报同一套状态，不复制桌宠逻辑。
window.luminMascotActivity = mascotActivity;

async function loadCfg() {
  state.cfg = await api("/api/settings");
  // /api/settings 里没有界面与智能体偏好：用最近一次读到的合回来，别把设置页上的开关冲掉
  if (state.agentPrefs) Object.assign(state.cfg, state.agentPrefs);
  if (!state.cfg.models) state.cfg.models = [];
  if (!state.cfg.knowledgeBases) state.cfg.knowledgeBases = [];
  if (!state.kb || !state.cfg.knowledgeBases.some((k) => k.id === state.kb)) {
    const indexed = state.cfg.knowledgeBases.find((k) => (k.chunkCount || 0) > 0);
    state.kb = (indexed || state.cfg.knowledgeBases[0] || {}).id || "";
  }
}
/** 项目清单（一个项目 = 一个本机文件夹，对齐 Codex 的"一个项目一个文件夹"）。 */
async function loadProjects() {
  try {
    state.projects = (await api("/api/projects/list", {})).projects || [];
  } catch (e) {
    state.projects = [];
  }
}

function projectName(id) {
  const p = (state.projects || []).find((x) => x.id === id);
  return p ? (p.name || p.root || id) : "";
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
/* 会话列表的短窗缓存：切一次页面 Panel 与 Page 会各读一次，之前每次切换打 1–3 个
   重复请求（列表接口慢时就是"卡住 0.5 秒+"的来源之一）。被动读取 1.5s 内复用；
   显式 reloadSessions()（新建/改名/删除后）强制刷新，绝不吞掉刚发生的变化。 */
let sessionsCache = { at: 0, promise: null };
async function loadSessions(force) {
  const fresh = sessionsCache.at > 0 && Date.now() - sessionsCache.at < 1500;
  if (force || !fresh) {
    if (!sessionsCache.promise) {
      sessionsCache.promise = (async () => {
        try { state.sessions = (await api("/api/sessions/list", {})).sessions || []; }
        catch (e) { state.sessions = []; }
        sessionsCache.at = Date.now();
        sessionsCache.promise = null;
      })();
    }
    await sessionsCache.promise;
  }
  /* 正在跑、但还没出现在列表里的会话（新建的会话要等第一条事件落库才进列表接口）
     先补一行：转圈必须马上看得见，不能等这一轮跑完才冒出来。真实数据一到自然顶掉。 */
  for (const running of state.chatRequests.keys()) {
    if (!state.sessions.some((x) => x.sessionId === running)) {
      state.sessions.unshift({
        sessionId: running,
        title: state.lastQuestion || "新对话",
        projectId: "",
        kind: "ask",
        lastAt: new Date().toISOString(),
        eventCount: 0,
      });
    }
  }
  /* 列表是"会话元信息"的唯一来源：顶栏那条面包屑（工作区 | 会话名）也吃这份数据。
     标题是模型异步起好的、跑完一轮时间会变 —— 读一次列表就把顶栏一起对齐，
     否则会出现"列表里已经有名字、顶栏还写着新对话"（实测）。 */
  if (typeof refreshChatHeader === "function") refreshChatHeader();
}

/** 一次性把首页/侧栏需要的四类数据拉齐。 */
async function loadOverview() {
  await loadCfg();
  // 四份数据互不依赖：并发取，别让页面切换按 4 个串行来回等
  await Promise.all([loadProfile(), loadReport(), loadArtifacts(), loadSessions()]);
}

function hasChatModel() { return state.cfg.models.length > 0 && !!state.cfg.chatModelId; }
function hasKb() { return state.cfg.knowledgeBases.length > 0; }
function indexedKb() { return state.cfg.knowledgeBases.find((k) => (k.chunkCount || 0) > 0) || null; }
/**
 * 这一段对话的检索范围。
 *
 * 现在恒为"全部知识库"（空串）：会话按项目组织，资料范围不再按知识库切分，
 * 所以这里不再回退到"当前知识库"—— 留着那个回退，工具条就会显示一个已经
 * 不再生效的库名。
 */
function scopeNow() {
  return "";
}

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
    { done: hasChatModel(), title: "配置模型接口", text: "填接口地址与密钥，绑定到「对话与生成」。", go: () => go("settings", "models"), act: "去配置" },
    { done: kbs.length > 0, title: "指定资料目录", text: "选一个本机资料目录（Markdown / 文本）。", go: () => go("settings", "kb"), act: "去指定" },
    { done: kbs.some((k) => (k.chunkCount || 0) > 0), title: "建立索引", text: "扫描目录并切片，建完才能检索。", go: () => go("settings", "kb"), act: "去建立" },
    { done: state.sessions.length > 0, title: "问第一个问题", text: "就你的资料提问，答案带出处编号。", go: () => go("chat"), act: "去提问" },
    { done: state.artifacts.length > 0, title: "生成第一份产物", text: "把一章做成讲义或练习，存成本机 Markdown。", go: () => go("learn"), act: "去生成" },
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
    // 成长与校准合成一个根：校准是成长页里的一个动作，不再自己占一个入口（原来两个根互相甩按钮）
    { id: "report", label: "我的成长", icon: "chart" },
  ],
  [
    // 笔记与错题本都是"自己攒下来的学习记录"，合成一个根；生成的产物另起一项
    { id: "notes", label: "我的资源", icon: "note" },
    { id: "resources", label: "个性化资源", icon: "layers" },
    { id: "kb", label: "资料库", icon: "db" },
  ],
  // 对话与会话记录本来是同一件事的两面：会话栏就挂在对话页左侧。
  // 上一版把「会话记录」单列成一项，等于同一份数据两个入口，已经合并。
  [{ id: "chat", label: "伴学助手", icon: "chat" }],
];


/* ---------- 页面表 ---------- */

const PAGE_META = {
  home: { title: "首页", sub: "今天学什么，从这里开始" },
  learn: { title: "学 · 练", sub: "按章节读资料、出题、生成讲义" },
  notes: { title: "我的资源", sub: "笔记、错题与收集的网络资料，都留在本机" },
  wrong: { title: "错题本", sub: "做错的题在这里复习" },
  report: { title: "我的成长", sub: "记录、能力画像与校准都在这一页" },
  calibrate: { title: "我的成长", sub: "校准" },
  resources: { title: "个性化资源", sub: "生成的讲义与练习，全部在本机" },
  kb: { title: "资料库", sub: "找到资料、读原文，再开始学习" },
  chat: { title: "伴学助手", sub: "就你的资料提问" },
  sessions: { title: "全部会话", sub: "每段对话只追加地留了下来，可以回看" },
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
 * 错题本是「我的资源」里的一栏（原来自己占一个根入口，还和"我的成长"互相甩按钮）。
 * 所有"打开错题本"都走这里，页面与第二层面板共用同一份状态。
 */
function openWrong(opts) {
  state.resTab = "wrong";
  go("notes", null, opts || {});
}

/** 笔记是「我的资源」的另一栏。 */
function openNotes(opts) {
  state.resTab = "notes";
  go("notes", null, opts || {});
}

/**
 * 能力校准不是单独一页：它是成长页里就地展开的一段（一次问一条，三个按钮）。
 * key 为某一维时直接跳到那一条。
 */
function openCalibration(key) {
  state.calibOpen = true;
  if (key) {
    const i = ABILITY_DIMENSIONS.findIndex((d) => d.key === key);
    state.calibStep = i >= 0 ? i : 0;
  } else if (!(state.calibStep >= 0 && state.calibStep <= ABILITY_DIMENSIONS.length)) {
    state.calibStep = 0;
  }
  go("report");
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
  const n = typeof navigationRoot === "function" ? 0 : navBadge(item.id);
  b.innerHTML = icon(item.icon) + '<span class="rail-caption">' + esc(item.label) + '</span>' +
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
      if (it.id === (typeof navigationRoot === "function" ? navigationRoot(current) : current)) {
        b.classList.add("active"); b.setAttribute("aria-current", "page");
      }
      rail.appendChild(b);
    }
  });

  rail.appendChild(el("div", "rail-spacer"));
  rail.appendChild(el("div", "rail-sep"));

  rail.appendChild(railAction("rail-theme", state.dark ? "moon" : "sun",
    (state.dark ? "切到浅色" : "切到深色") + "（设置里可以跟随系统）", () => toggleTheme()));

  const setBtn = railButton({ id: "settings", label: "设置", icon: "gear" });
  if ((typeof navigationRoot === "function" ? navigationRoot(current) : current) === "settings") {
    setBtn.classList.add("active"); setBtn.setAttribute("aria-current", "page");
  }
  rail.appendChild(setBtn);
  // 齿轮是"设置"的通用记号：上一版用的图形像太阳，和主题按钮撞脸，已换成真正的齿轮
}

function pageFromHash() {
  const m = String(location.hash || "").match(/^#\/([a-z]+)(?:\/([^\/?#]+))?/);
  const page = m && PAGES[m[1]] ? m[1] : "chat";
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
  if(page==="settings"&&section==="kb"){page="kb";section="manage";}
  const navigation = state.navigationGeneration = (state.navigationGeneration || 0) + 1;
  state.knowledgeObserver?.disconnect();state.knowledgeObserver=null;
  state.notesListObserver?.disconnect(); state.notesListObserver = null;
  state.objectFocus = opts?.focus || null;
  const target = PAGES[page] ? page : "home";
  current = target;
  currentSection = section || "";
  const persistentDock = $("resource-dock");
  if (persistentDock && persistentDock.parentElement !== document.querySelector(".app")) document.querySelector(".app").appendChild(persistentDock);
  document.body.dataset.page = target;
  document.body.classList.toggle("library-workspace", target === "kb");
  document.body.classList.toggle("workspace-wide", ["home", "learn", "report", "calibrate", "resources", "notes", "wrong"].includes(target));
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
  document.querySelector(".study-citation")?.remove();
  if (typeof decorateWorkspace === "function") decorateWorkspace();
  const ta = $("top-actions");
  ta.innerHTML = "";
  if (meta.actions) for (const a of meta.actions()) ta.appendChild(a);
  const v = $("view");
  v.setAttribute("aria-busy", "true");
  v.classList.remove("chat-blank");
  state.chatOpenSession = null;   // 整页要重建了，就地换会话的句柄作废
  v.innerHTML = '<div class="empty inline"><span class="spinner"></span> 加载中…</div>';
  // 真正滚动的是 #view（.main 是 overflow:hidden）。此前重置的是 .main，等于没重置，
  // 于是从长页面切到别的页面会停在半截。就地更新（例如标记已读）则刻意不调用 go()，保住阅读位置。
  v.scrollTop = 0;
  try {
    // 第二层面板先渲染：它决定这一层的"目录"长什么样（章节 / 笔记 / 产物 / 会话…）
    await renderPanel();
    if (navigation !== state.navigationGeneration) return;
  } catch (e) {
    $("panel-body").innerHTML = '<div class="panel-empty">面板没能加载：' + esc(e.message) + "</div>";
  }
  try {
    await PAGES[target].render();
    if (navigation !== state.navigationGeneration) return;
  } catch (e) {
    if (navigation !== state.navigationGeneration) return;
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
  if (typeof workbenchAfterPage === "function") await workbenchAfterPage();
  if (navigation === state.navigationGeneration) v.setAttribute("aria-busy", "false");
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
  /* 这一页现在就是「知识网络」：整页内容由 workbench 的知识网络模块渲染（见文件末尾）。 */
  async render() { $("view").innerHTML = ""; },
};

async function continueStudy() {
  try {
    const course=await api('/api/study/course',{kbId:state.kb});
    state.chapter=course.next?.chapter || course.chapters?.[0]?.name || null;
    state.studySection=course.next?.sectionId || null;
  } catch(e) { state.chapter=null;state.studySection=null; }
  await go('learn');
}

/* ---------- 学 · 练 ---------- */


PAGES.learn = {
  async render() {
    const renderingGeneration = state.navigationGeneration;
    await loadCfg();
    if (renderingGeneration !== state.navigationGeneration) return;
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
    row.appendChild(btn("管理资料", "sm ghost", () => go("kb")));
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
  const renderingGeneration = state.navigationGeneration;
  const tree = await api("/api/study/tree", { kbId: state.kb });
  if (renderingGeneration !== state.navigationGeneration) return;
  const chapters = tree.chapters || [];
  v.appendChild(pathBar(tree));
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
    const extra = el("details", "chapter-more");
    extra.appendChild(el("summary", "btn sm ghost", "练习与生成"));
    const secondary = el("div", "row");
    secondary.appendChild(btn("出题练习", "sm ghost", () => openQuiz(v, c.name)));
    secondary.appendChild(btn("生成讲义", "sm ghost", () => askTopic("lecture", c.name)));
    secondary.appendChild(btn("生成练习册", "sm ghost", () => askTopic("quiz", c.name)));
    extra.appendChild(secondary); acts.appendChild(extra);
    it.appendChild(acts);
    it.onclick = (ev) => {
      if (ev.target.closest("button, details")) return;
      state.chapter = c.name;
      go("learn");
    };
    list.appendChild(it);
  });
  card.appendChild(list);
  v.appendChild(card);

}

async function renderChapter(v) {
  const renderingGeneration = state.navigationGeneration;
  const chap = await api("/api/study/chapter", { kbId: state.kb, chapter: state.chapter });
  if (renderingGeneration !== state.navigationGeneration) return;
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
  if (renderingGeneration !== state.navigationGeneration) return;
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
             btn("错题本", "sm ghost", () => openWrong())],
    },
    {
      n: 3, title: "记一条", done: chapterNotes.length > 0,
      desc: chapterNotes.length > 0 ? ("本章已有 " + chapterNotes.length + " 条笔记") : "把这一章的想法留下来",
      acts: [btn("写笔记", "primary sm", () => openNoteEditor(null, state.kb, state.chapter)),
             btn("全部笔记", "sm ghost", () => openNotes())],
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

  const moreActions = el("details", "card chapter-extra");
  moreActions.appendChild(el("summary", null, "生成学习材料与提问"));
  moreActions.appendChild(cardOf({
    body: (() => {
      const row = el("div", "row");
      row.appendChild(btn("生成讲义", "", () => askTopic("lecture", state.chapter)));
      row.appendChild(btn("生成练习册", "", () => askTopic("quiz", state.chapter)));
      row.appendChild(btn("去检索这部分", "ghost", () => go("kb")));
      row.appendChild(btn("问助手", "ghost", () => go("chat")));
      return row;
    })(),
  }));

  v.appendChild(moreActions);
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
  dlg.appendChild(fieldOf("主题", input));
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
 * 生成讲义 / 练习册：交给 Lumin 当**一次任务**跑（内核 /api/agent/task-pi）。
 *
 * 这里刻意没有"检索资料 → 拟大纲 → 逐节写作 → 引用自检 → 落盘"那条进度条：
 * 那是上一版网页端写死的工作流，和"步骤由 agent 自己决定"是两回事 —— 要不要查资料、查几次、
 * 先写哪一节，都由模型自己排。所以这里只画**一条时间线**：它调了什么工具、写了什么，
 * 按发生顺序摆出来，和伴学助手用的是同一套渲染。
 */
async function generateArtifact(kind, topic) {
  const title = kind === "lecture" ? "生成讲义" : "生成练习册";
  if (!hasChatModel()) {
    toast("还没有可用的对话模型");
    go("models");
    return;
  }
  const v = $("view");
  const started = Date.now();
  const card = el("div", "card gen-card");
  const head = el("div", "card-head");
  head.innerHTML = '<span class="spinner"></span><h2>' + esc("正在" + title + "：" + topic) + "</h2>";
  head.appendChild(spacer());
  const timer = el("span", "muted", "0.0 秒");
  head.appendChild(timer);
  card.appendChild(head);
  const thread = el("div", "gen-thread");
  card.appendChild(thread);
  v.insertBefore(card, v.firstChild);
  card.scrollIntoView({ block: "start" });
  const timerId = setInterval(() => { timer.textContent = ((Date.now() - started) / 1000).toFixed(1) + " 秒"; }, 100);

  let sid = "";
  try {
    sid = (await api("/api/sessions/new", {})).sessionId;
  } catch (e) { /* 拿不到会话也能生成，只是没有实时过程 */ }

  if (sid) {
    const stopBtn = btn("停止生成", "sm ghost", async () => {
      stopBtn.disabled = true;
      stopBtn.textContent = "正在停止…";
      try {
        await api("/api/agent/cancel", { sessionId: sid });
        toast("已请求停止，正在收尾…");
      } catch (e) {
        toast("停止失败：" + e.message);
        stopBtn.disabled = false;
        stopBtn.textContent = "停止生成";
      }
    });
    head.appendChild(stopBtn);
  }

  const paintThread = (turns, live) => {
    thread.innerHTML = "";
    for (const t of turns) {
      for (const it of t.items) {
        if (it.t === "tool") thread.appendChild(renderToolRows([it]));
        else if (it.text) thread.appendChild(assistantBlock(it.text, live && it.streaming));
      }
    }
    thread.scrollTop = thread.scrollHeight;
  };
  paintThread([], true);

  let poll = null;
  if (sid) {
    poll = setInterval(async () => {
      try {
        const d = await api("/api/sessions/events", { sessionId: sid });
        paintThread(turnsFromEvents(d.events || []), true);
      } catch (e) { /* 轮询失败不打扰用户，最终结果以收尾时那次为准 */ }
    }, 450);
  }

  let d = null;
  let fail = "";
  try {
    d = await api("/api/agent/task-pi", {
      kind: kind,
      kbId: state.kb || "",
      topic: topic,
      count: kind === "quiz" ? 5 : undefined,
      sessionId: sid,
      web: "auto",
      perm: state.cfg.agentPerm || "auto",
      ctxChapter: state.chapter || "",
    });
  } catch (e) {
    fail = e.message;
  }
  if (poll) clearInterval(poll);
  clearInterval(timerId);
  card.remove();

  if (fail || !d || d.ok !== true) {
    const msg = fail || (d && d.message) || "内核没有返回内容";
    // 取消不是失败：说清"这次没落盘"，别让用户以为草稿还在
    const cancelled = String(msg).indexOf("取消") >= 0;
    const box = cardOf({
      cls: "dialog",
      title: cancelled ? title + "已取消" : title + "没有完成",
      tag: cancelled ? "未保存" : "",
      tagCls: cancelled ? "warn" : "",
    });
    box.appendChild(el("p", "muted", msg));
    const row = el("div", "row");
    row.appendChild(btn("重新生成", "primary", () => { box.remove(); askTopic(kind, topic); }));
    if (!cancelled) row.appendChild(btn("检查模型设置", "", () => go("models")));
    row.appendChild(btn("关闭", "ghost", () => box.remove()));
    box.appendChild(row);
    v.insertBefore(box, v.firstChild);
    box.scrollIntoView({ block: "start" });
    return;
  }

  await loadArtifacts();
  await loadSessions();
  const name = artifactNameFromPath(d.artifactPath);
  const result = cardOf({
    cls: "dialog ok-dialog",
    title: (kind === "lecture" ? "讲义已生成" : "练习册已生成") + "：" + topic,
    tag: "已保存到我的资源",
    tagCls: "ok",
  });
  // 不再挂引用自检那行小字：「段落 N · 带引用 M · 越界 K」放在成品正文上面只是噪声，
  // 正文就在下面，引用对不对一眼能看见。
  let content = "";
  if (name) {
    try {
      content = (await api("/api/artifacts/read", { name: name })).content || "";
    } catch (e) { /* 读不到也能用下面的按钮打开 */ }
  }
  if (name) result.appendChild(el("div", "meta", name + (content ? " · " + content.length + " 字" : "")));
  const preview = el("div", "artifact-preview");
  preview.innerHTML = md(content.slice(0, 1200));
  result.appendChild(preview);
  const row = el("div", "row");
  row.appendChild(btn("按页播放", "primary", () => openSlidePlayer(name, content || undefined)));
  row.appendChild(btn("打开全文", "", () => openArtifactByName(name, content || undefined)));
  row.appendChild(copyButton(() => content, "复制 Markdown"));
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

/**
 * 我的资源 = 笔记 + 错题本。
 *
 * 左边栏只给一个根入口，页内用一排分段切换——这两样都是"自己攒下来的学习记录"，
 * 原来是两个并列的根功能，结果页里页外互相甩按钮，点两下就不知道自己在哪了。
 */
PAGES.notes = {
  async render() {
    const renderingGeneration = state.navigationGeneration;
    await loadCfg();
    if (renderingGeneration !== state.navigationGeneration) return;
    const v = $("view");
    v.innerHTML = "";
    const tab = ["wrong", "network"].includes(state.resTab) ? state.resTab : "notes";
    let wrongCount = 0;
    try {
      wrongCount = ((await api("/api/study/wrong", {})).records || []).length;
    } catch (e) { wrongCount = 0; }
    let noteCount = 0;
    try {
      noteCount = ((await api("/api/study/notes/list", {})).notes || []).length;
    } catch (e) { noteCount = 0; }
    if (renderingGeneration !== state.navigationGeneration) return;
    const bar = el("div", "card res-tabs");
    const seg = el("div", "seg");
    [["notes", "笔记 " + noteCount], ["wrong", "错题本 " + wrongCount], ["network", "网络资料"]].forEach(([k, label]) => {
      const b = el("button", "seg-item" + (tab === k ? " active" : ""), label);
      b.dataset.tab = k;
      b.onclick = () => {
        if (k === "network") { state.resTab = "network"; go("notes"); }
        else if (k === "wrong") openWrong();
        else openNotes();
      };
      seg.appendChild(b);
    });
    bar.appendChild(seg);
    v.appendChild(bar);
    if (tab === "network") {
      const networkBody = el("div");
      v.appendChild(networkBody);
      await renderHarvest(networkBody);
    } else if (tab === "wrong") {
      await renderWrongSection(v);
    } else {
      await renderNotesSection(v);
    }
  },
};

async function renderHarvest(v, embedded) {
  v.innerHTML = "";
  const explanation = "先存本机，检查文件后再并入知识库。暂存资料不会出现在检索结果里。";
  const card = embedded ? el("div") : cardOf({ title: "收集资料", sub: explanation });
  if (embedded) card.appendChild(el("p", "muted sm", explanation));
  card.classList.add("harvest-panel");
  const row = el("div", "row wrap");
  const kind = selectOf("harvest-kind", [{ value: "url", label: "网页链接" }, { value: "repo", label: "GitHub 仓库" }], "url");
  const url = inputOf("harvest-url", "https://… 或 owner/repo", "");
  url.classList.add("grow");
  const ref = inputOf("harvest-ref", "分支 / tag（可选）", "");
  ref.hidden = true;
  kind.onchange = () => { ref.hidden = kind.value !== "repo"; };
  kind.setAttribute("aria-label", "资料来源类型");
  url.setAttribute("aria-label", "资料链接或仓库");
  ref.setAttribute("aria-label", "仓库版本");
  row.appendChild(kind); row.appendChild(url); row.appendChild(ref);
  const status = el("p", "muted sm");
  status.setAttribute("role", "status");
  const start = btn("抓取到暂存区", "primary", async () => {
    if (!url.value.trim()) { status.textContent = "先填写链接或仓库。"; url.focus(); return; }
    start.disabled = true; status.textContent = "正在抓取，只写入本机暂存区…";
    card.setAttribute("aria-busy", "true");
    try {
      await api("/api/kb/stage", { kind: kind.value, url: url.value.trim(), ref: ref.value.trim() });
      status.textContent = "已暂存，请检查下面的文件清单。";
      await listSources();
    } catch (e) { status.textContent = "抓取失败：" + e.message; }
    finally { start.disabled = false; card.setAttribute("aria-busy", "false"); }
  });
  row.appendChild(start); card.appendChild(row); card.appendChild(status);
  const list = el("div", "list");
  card.appendChild(list); v.appendChild(card);

  async function listSources() {
    list.innerHTML = "";
    let data;
    try { data = await api("/api/kb/sources", {}); }
    catch (e) { list.appendChild(el("p", "muted", "来源清单读取失败：" + e.message)); return; }
    const sources = (data.sources || []).filter((s) => s.status !== "discarded")
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
    if (!sources.length) {
      list.appendChild(el("p", "muted", "还没有收集的网络资料。可以粘贴链接，或让伴学助手用 /kb-harvest 收集。"));
      return;
    }
    for (const s of sources) {
      const item = el("div", "item harvest-source");
      item.dataset.sourceId = s.id;
      const title = el("div", "row wrap");
      title.appendChild(el("strong", "grow", s.title || s.url));
      title.appendChild(tag(s.status === "ingested" ? "已并入 · " + kbName(s.kbId) : "待确认", s.status === "ingested" ? "ok" : "warn"));
      item.appendChild(title);
      item.appendChild(el("p", "path-line", s.url));
      if (s.commit) item.appendChild(el("p", "path-line", "版本 " + s.ref + " · commit " + s.commit));
      item.appendChild(el("p", "muted sm", "抓取于 " + fmtStamp(s.fetchedAt) + " · " + s.files.length + " 个文件 · 跳过 " + (s.skipped || 0) + " 个"));
      const files = el("details");
      files.appendChild(el("summary", null, "查看文件清单与内容（" + s.files.length + "，单文件预览最多 20KB）"));
      const preview = el("pre", "hit-body harvest-preview");
      preview.style.whiteSpace = "pre-wrap";
      preview.style.maxHeight = "320px"; preview.style.overflow = "auto";
      for (const f of s.files) {
        files.appendChild(btn(f.path + " · " + fmtSize(f.bytes), "sm ghost", async () => {
          preview.textContent = "读取中…";
          try {
            const text = (await api("/api/kb/source/preview", { id: s.id, path: f.path })).text;
            preview.textContent = s.kind === "url" ? text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "") : text;
          }
          catch (e) { preview.textContent = e.message; }
        }));
      }
      files.appendChild(preview); item.appendChild(files);
      const actions = el("div", "row wrap");
      const feedback = el("p", "muted sm"); feedback.setAttribute("role", "status");
      if (s.status === "staged") {
        const target = selectOf("harvest-target-" + s.id, [{ value: "", label: "选择要并入的知识库" }]
          .concat(state.cfg.knowledgeBases.map((k) => ({ value: k.id, label: k.name || k.id }))), state.kb || "");
        target.setAttribute("aria-label", "并入目标知识库");
        const checked = el("input"); checked.type = "checkbox";
        const label = el("label", "row");
        label.appendChild(checked); label.appendChild(el("span", null, "我已检查清单与来源"));
        const ingest = btn("确认并入并建索引", "primary sm", async () => {
          ingest.disabled = true; feedback.textContent = "正在并入…";
          try {
            await api("/api/kb/ingest", { id: s.id, kbId: target.value, confirmed: checked.checked });
            feedback.textContent = "资料已并入，正在重建索引…";
            await buildIndex(target.value);
            await listSources();
          } catch (e) { feedback.textContent = "并入失败：" + e.message; ingest.disabled = false; }
        });
        ingest.disabled = true;
        const ready = () => { ingest.disabled = !checked.checked || !target.value; };
        checked.onchange = ready; target.onchange = ready;
        actions.appendChild(target); actions.appendChild(label); actions.appendChild(ingest);
        actions.appendChild(btn("不并入", "sm ghost", async () => {
          try { await api("/api/kb/source/discard", { id: s.id }); await listSources(); }
          catch (e) { feedback.textContent = e.message; }
        }));
      } else {
        actions.appendChild(btn("重建此库索引", "sm", () => buildIndex(s.kbId)));
      }
      const refetch = btn("重新抓取", "sm ghost", async () => {
        refetch.disabled = true; feedback.textContent = "重新抓取中；原版本保留…";
        try { await api("/api/kb/source/refetch", { id: s.id }); await listSources(); }
        catch (e) { feedback.textContent = e.message; refetch.disabled = false; }
      });
      actions.appendChild(refetch); item.appendChild(actions); item.appendChild(feedback); list.appendChild(item);
    }
  }
  await listSources();
}

async function renderNotesSection(v) {
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
}

/* ---------- 错题本（合并进「我的资源」，见 PAGES.notes） ---------- */

PAGES.wrong = {
  // 错题本合并进「我的资源」：老的深链（#/wrong）要照旧能用
  async render() {
    state.resTab = "wrong";
    await go("notes", null, { replace: true });
  },
};

async function renderWrongSection(v) {
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
    banner.appendChild(el("div", "muted sm", "答对往后推（1 / 3 / 7 / 16 / 35 天），答错回到今天。"));
    card.appendChild(banner);

    const tools = el("div", "row artifact-tools");
    const seg = el("div", "seg");
    const tabs = [["due", "待复习 " + due.length], ["mastered", "已掌握 " + mastered.length], ["all", "全部 " + all.length]];
    for (const [k, label] of tabs) {
      const b = el("button", "seg-item" + (tab === k ? " active" : ""), label);
      b.onclick = () => { state.wrongTab = k; openWrong(); };
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
          actions: all.length ? [btn("看清空条件", "", () => { state.wrongTab = "all"; state.wrongQuery = ""; openWrong(); })]
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
            openWrong();
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
}

/**
 * 学习路径：把这一章一节的完成度画成一条（网页版那根 PathProgressBar 的意思）。
 *
 * 和网页版不同的一点：那边是"六阶段路线图"（写死的学习法），这里就是**你自己的章节**——
 * 完成/在读/未开始三段颜色，点一下就跳到那一章。
 */
function pathBar(tree) {
  const chapters = (tree && tree.chapters) || [];
  const card = cardOf({ title: "学习路径", tag: chapters.length ? chapters.length + " 章" : "" });
  if (!chapters.length) {
    card.appendChild(emptyState({
      inline: true,
      art: "book",
      title: "还没有章节",
      text: "建立索引后，这里会按你的资料列出学习路径。",
      actions: [btn("去建立索引", "primary", () => go("settings", "kb"))],
    }));
    return card;
  }
  const done = chapters.filter((c) => c.done).length;
  const reading = chapters.filter((c) => !c.done && (c.readCount || 0) > 0).length;
  const pct = Math.round((done / chapters.length) * 100);
  const row = el("div", "path-row");
  row.appendChild(el("div", "muted sm", "已完成 " + done + " / " + chapters.length + " 章 · " + pct + "%"));
  const track = el("div", "path-track");
  for (const c of chapters) {
    const seg = el("button", "path-seg" + (c.done ? " done" : ((c.readCount || 0) > 0 ? " reading" : "")));
    seg.type = "button";
    seg.title = c.name + " · " + (c.done ? "已完成" : (c.readCount || 0) > 0 ? "在读 " + c.readCount + "/" + c.chunkCount : "未开始");
    seg.dataset.chapter = c.name;
    if (state.chapter === c.name) seg.classList.add("active");
    seg.onclick = () => { state.chapter = c.name; go("learn"); };
    track.appendChild(seg);
  }
  row.appendChild(track);
  card.appendChild(row);
  return card;
}

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
      openWrong();
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
    dlg.appendChild(el("p", "muted sm", "这条是早期记录，没存下选项，请自己判定对错。"));
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
    actions: [],
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

/**
 * 学习日历（网页版那张 StreakCalendar 搬过来）。
 *
 * 连续打卡只认"这一天有没有真实的活"：读切片 / 章节完成 / 记笔记 / 答题 / 问过一次，
 * 都算（数据来自内核按天汇总的 studyDates）。日历运算放在前端做 —— 浏览器知道本地时区，
 * 内核硬算只会算错。
 */
function streakInfo(dates) {
  const set = new Set(dates || []);
  const key = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  };
  const today = new Date();
  let cur = 0;
  const probe = new Date(today);
  if (!set.has(key(probe))) {
    // 今天还没学：连续天数从昨天算（今天还没开始不等于断了）
    probe.setDate(probe.getDate() - 1);
  }
  while (set.has(key(probe))) {
    cur += 1;
    probe.setDate(probe.getDate() - 1);
  }
  // 最长连续：按升序走一遍
  const sorted = Array.from(set).sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of sorted) {
    if (prev) {
      const a = new Date(prev + "T00:00:00");
      a.setDate(a.getDate() + 1);
      run = key(a) === d ? run + 1 : 1;
    } else {
      run = 1;
    }
    best = Math.max(best, run);
    prev = d;
  }
  return { current: cur, longest: best, activeDays: set.size, todayActive: set.has(key(today)), dates: set };
}

function streakCard() {
  const info = streakInfo((state.report || {}).studyDates || []);
  const card = cardOf({
    title: "学习日历",
    tag: info.current > 0 ? "已连续 " + info.current + " 天" : (info.todayActive ? "今天已学" : "今天还没开始"),
    tagCls: info.current > 0 ? "ok" : "",
  });
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const grid = el("div", "streak-grid");
  for (const wd of ["日", "一", "二", "三", "四", "五", "六"]) {
    grid.appendChild(el("div", "streak-wd", wd));
  }
  for (let i = 0; i < firstWeekday; i++) grid.appendChild(el("div", "streak-cell empty"));
  const keyOf = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  for (let d = 1; d <= daysInMonth; d++) {
    const cell = el("div", "streak-cell");
    const dt = new Date(year, month, d);
    cell.dataset.date = keyOf(dt);
    cell.textContent = String(d);
    if (info.dates.has(keyOf(dt))) cell.classList.add("studied");
    if (keyOf(dt) === keyOf(today)) cell.classList.add("today");
    if (dt > today) cell.classList.add("future");
    grid.appendChild(cell);
  }
  card.appendChild(grid);
  card.appendChild(el("div", "muted sm", "累计学习 " + info.activeDays + " 天" +
    (info.longest > 0 ? " · 最长连续 " + info.longest + " 天" : "") +
    "。读切片、记笔记、答题、问助手都算一天。"));
  return card;
}

/** 最该补的一维 → 一句人话 + 一个能直接点走的动作。 */
const ABILITY_ADVICE = {
  "概念理解": { text: "资料还有没读完的部分，先把剩下的切片看掉，概念才连得起来。", act: "去读资料", go: () => go("learn") },
  "逻辑推理": { text: "答题正确率是这一维的主要依据：去做一组练习，错的会自动进错题本。", act: "出题练习", go: () => go("learn") },
  "工程实践": { text: "走完一章的「讲 → 练 → 记 → 完成」，这一维才会动。", act: "去学一章", go: () => go("learn") },
  "问题诊断": { text: "错题重做一次就能把这一维推上去，比再读一遍资料管用。", act: "去错题本", go: () => openWrong() },
  "系统设计": { text: "把学过的章节沉淀成讲义或练习册，产物数就是这一维的依据。", act: "生成讲义", go: () => go("learn") },
  "学习迁移": { text: "写下一条自己的例子或用法，笔记是这一维的依据。", act: "写一条笔记", go: () => openNoteEditor(null, state.kb, state.chapter || "") },
};

function suggestionBox(weakest, rows) {
  const box = el("div", "ability-advice");
  if (!weakest) {
    box.appendChild(el("div", "ability-advice-title", "数据还不足以下结论"));
    box.appendChild(el("div", "muted sm", "六维档案保留本人自评。阅读量不代表掌握度；资源测验的知识点证据可在「学习记忆」查看。"));
    box.appendChild(btn("查看学习证据", "sm ghost", () => go("memory")));
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
  const brand = (css.getPropertyValue("--brand") || "#1c211e").trim();
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
  const brand = (css.getPropertyValue("--brand") || "#1c211e").trim();
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


/* ============================================================
   我的成长 · 学习报告（网页版 Report 的"导出报告"搬过来）
   ------------------------------------------------------------
   报告正文是**按当前页上的真实数据现拼的**：概览 / 六维（含每一格的依据）/ 最近两周 /
   最该补的一维 / 错题清单。数据不够的地方就写"数据不够"，不编。
   ============================================================ */
function growthReportText() {
  const r = state.report || {};
  const rows = Array.isArray(r.abilities) ? r.abilities : [];
  const p = state.profile || {};
  const day = new Date().toLocaleDateString("sv-SE");
  const acc = r.quizTotal ? Math.round((r.quizRight || 0) * 100 / r.quizTotal) + "%" : "—";
  const lines = [];
  lines.push("# 学习报告 " + day);
  lines.push("");
  lines.push("## 概览");
  lines.push("");
  lines.push("- 已读切片：" + (r.readChunks || 0));
  lines.push("- 完成章节：" + (r.completedChapters || 0));
  lines.push("- 答题：" + (r.quizTotal || 0) + "（正确率 " + acc + "，错题 " + (r.quizWrong || 0) + " 条，今天该复习 " + (r.wrongDue || 0) + " 条）");
  lines.push("- 笔记：" + (r.noteCount || 0) + " 条 · 产物：" + (r.artifactCount || 0) + " 份");
  if (p.nickname || p.goal) {
    lines.push("- 学习目标：" + (p.goal || "（未填）") + (p.nickname ? "（" + p.nickname + "）" : ""));
  }
  lines.push("");
  if (rows.length) {
    lines.push("## 六维能力");
    lines.push("");
    lines.push("| 维度 | 自评 | 实测参考 | 依据 |");
    lines.push("| --- | --- | --- | --- |");
    for (const row of rows) {
      lines.push("| " + row.key + " | " + (row.self >= 0 ? row.self : "—") + " | " +
        (row.evidence >= 0 ? row.evidence : "—") + " | " + (row.basis || "") + " |");
    }
    lines.push("");
    lines.push("> 自评是设置里自己填的；实测参考由真实学习记录推算（见「依据」列）。数据不足的维度不给参考，不拿噪声当分数。");
    lines.push("");
  }
  const trend = Array.isArray(r.trend) ? r.trend : [];
  if (trend.length) {
    const DAY = 86400000;
    const byDate = {};
    for (const x of trend) byDate[x.date] = x;
    const days = [];
    for (let i = 13; i >= 0; i -= 1) {
      const key = new Date(Date.now() - i * DAY).toLocaleDateString("sv-SE");
      const row = byDate[key] || {};
      days.push({ key: key, read: Number(row.read || 0), quiz: Number(row.quiz || 0), notes: Number(row.notes || 0) });
    }
    const sum = (arr, k) => arr.reduce((a, x) => a + x[k], 0);
    const last7 = days.slice(7);
    const prev7 = days.slice(0, 7);
    lines.push("## 最近两周");
    lines.push("");
    lines.push("- 本周：读了 " + sum(last7, "read") + " 片 · 做了 " + sum(last7, "quiz") + " 题 · 笔记 " + sum(last7, "notes") + " 条");
    lines.push("- 上周：读了 " + sum(prev7, "read") + " 片 · 做了 " + sum(prev7, "quiz") + " 题 · 笔记 " + sum(prev7, "notes") + " 条");
    const active = days.filter((d) => d.read + d.quiz + d.notes > 0).length;
    lines.push("- 这 14 天里有 " + active + " 天在学");
    lines.push("");
  }
  if (r.weakest) {
    const row = rows.filter((x) => x.key === r.weakest)[0] || { key: r.weakest };
    const adv = ABILITY_ADVICE[r.weakest];
    lines.push("## 下一步");
    lines.push("");
    lines.push("- 最该补的一维：**" + row.key + "**" + (adv ? " —— " + adv.text : ""));
    if (row.basis) {
      lines.push("- 依据：" + row.basis);
    }
    if ((r.wrongDue || 0) > 0) {
      lines.push("- 有 " + r.wrongDue + " 条错题今天该重做。");
    }
    lines.push("");
  }
  lines.push("> 这份报告由 Lumin 在本机生成：数据只在本地数据库里，没有上传。");
  lines.push("");
  return lines.join("\n");
}

/** 学习报告：一个动作「导出报告」，导出后就地给一个"在个性化资源里看"的入口。 */
function growthReportCard() {
  const card = cardOf({
    title: "我的成长",
    sub: "按当前记录现拼一份 Markdown",
  });
  const row = el("div", "row");
  row.appendChild(btn("导出报告", "primary sm", async () => {
    const name = "我的成长-" + new Date().toLocaleDateString("sv-SE") + ".md";
    try {
      const r = await api("/api/artifacts/save", { name: name, content: growthReportText() });
      state.lastReportArtifact = r.name;
      toast("已导出：" + r.name);
      go("report");
    } catch (e) { toast("导出失败：" + e.message); }
  }));
  card.appendChild(row);
  if (state.lastReportArtifact) {
    const line = el("div", "row");
    line.appendChild(el("span", "muted sm grow", "刚导出：" + state.lastReportArtifact));
    line.appendChild(btn("在个性化资源里看", "sm ghost", () => go("resources")));
    card.appendChild(line);
  }
  return card;
}

/* ---------- 我的成长 ---------- */

/**
 * 我的成长：一页装完"记录 + 能力画像 + 校准"。
 *
 * 上一版把校准单列成一个根功能，于是成长页、校准页、两边第二层面板互相甩按钮
 * （去画像校准 / 看看我的成长 / 去我的成长…）。现在校准是这页里就地展开的一段，
 * 页面上不再存在"另一个页面"可以跳。
 * 一屏按钮的规矩：每张卡最多一个主动作，其余降成文字或列表里的链接。
 */
PAGES.report = {
  async render() {
    const renderingGeneration = state.navigationGeneration;
    await loadOverview();
    await loadProfile();
    if (renderingGeneration !== state.navigationGeneration) return;
    const v = $("view");
    v.innerHTML = "";
    const r = state.report;

    // 四张统计卡：顺序固定（自检按这个顺序读）
    const grid = el("div", "grid grid-4");
    grid.appendChild(statCard("学完小节", r.completedSections || 0, ""));
    grid.appendChild(statCard("完成章节", r.completedChapters || 0, ""));
    grid.appendChild(statCard("答题总数", r.quizTotal || 0, ""));
    grid.appendChild(statCard("正确率", r.quizTotal ? pct(r.quizRight, r.quizTotal) : 0, "%"));
    v.appendChild(grid);

    // 错题只留一行摘要：详细列表在「我的资源 → 错题本」，不在这页再抄一遍
    if ((r.quizWrong || 0) > 0) {
      const dueN = Number(r.wrongDue || 0);
      const line = el("div", "row review-nudge");
      line.appendChild(el("span", "muted grow",
        "错题 " + r.quizWrong + " 条" + (dueN > 0 ? "，其中 " + dueN + " 条今天该复习" : "")));
      line.appendChild(btn("去错题本", "sm", () => openWrong()));
      v.appendChild(line);
    }

    v.appendChild(streakCard());
    const abilities = el("details", "card growth-details");
    abilities.open = !!state.calibOpen;
    abilities.appendChild(el("summary", null, "我的能力 · 查看与自评"));
    abilities.append(calibrationCard(), abilityCard()); v.appendChild(abilities);
    const history = el("details", "card growth-details");
    history.appendChild(el("summary", null, "学习趋势与活动记录"));
    history.append(trendCard(), growthReportCard(), await activityCard());
    if (renderingGeneration !== state.navigationGeneration) return;
    v.appendChild(history);
  },
};

/** 最近的学习活动（来自会话日志）。 */
async function activityCard() {
  const card = cardOf({
    title: "最近的学习活动",
    sub: "来自会话日志",
  });
  if (!state.sessions.length) {
    card.appendChild(emptyState({
      inline: true,
      art: "clock",
      title: "还没有会话",
      text: "提问、出题和生成记录会出现在这里。",
      actions: [btn("问第一个问题", "primary", () => go("chat"))],
    }));
    return card;
  }
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
  card.appendChild(list);
  return card;
}

/**
 * 能力校准：就地展开，一次只问一条。
 *
 * 上一版是"六维 × 五档 + 六个输入框 + 两个保存按钮"（39 个控件）还外加一次跳页——
 * 那是在让人批量拍分。现在一次只问一条：跟参考比"偏高 / 差不多 / 偏低"三个按钮，
 * 依据选填，答完给一个「保存」，笔记变成一个可勾选的小选项。
 */
function calibrationCard() {
  const dims = ABILITY_DIMENSIONS;
  const scores = (state.profile && state.profile.selfScores) || {};
  if (!state.calib) state.calib = {};
  if (!state.calibNote) state.calibNote = {};
  const m = measuredLevelIndex();
  const open = !!state.calibOpen;
  const answered = dims.filter((d) => state.calib[d.key] !== undefined).length;

  const baseOf = (d) => (m ? m.index : levelIndexOf(scores[d.key]));
  const valueOf = (d) => {
    const idx = state.calib[d.key];
    if (idx !== undefined) return ABILITY_LEVELS[idx].value;
    return ABILITY_LEVELS[baseOf(d)].value;
  };

  const card = cardOf({
    title: "能力校准",
    sub: open ? "一条一条来" : null,
    tag: open ? "已答 " + answered + " / " + dims.length : "",
  });
  card.appendChild(el("div", "row calib-head"));
  if (!open) {
    card.appendChild(el("div", "muted sm", answered || Object.keys(scores).length
      ? "自评和最近的实测对不上时校准一下：六个维度各一句话，答完保存。"
      : "还没有自评分。用六句话给自己定个起点，雷达图才有第二条线。"));
    const row = el("div", "row");
    row.appendChild(btn(answered ? "继续校准" : "校准我的能力", "sm primary", () => {
      state.calibOpen = true;
      if (!(state.calibStep >= 0 && state.calibStep < dims.length)) state.calibStep = 0;
      go("report");
    }));
    card.appendChild(row);
    return card;
  }

  const step = Math.max(0, Math.min(Number(state.calibStep || 0), dims.length));
  if (step < dims.length) {
    const d = dims[step];
    const base = baseOf(d);
    const box = el("div", "calib-step");
    box.dataset.id = d.key;
    const head = el("div", "row");
    head.appendChild(el("div", "grow", "第 " + (step + 1) + " / " + dims.length + " 条 · " + d.key));
    head.appendChild(tag(ABILITY_LEVELS[base].label + " " + ABILITY_LEVELS[base].value + " 分"));
    box.appendChild(head);
    box.appendChild(el("div", "muted sm", d.hint));
    box.appendChild(el("div", "meta", m
      ? "参考：近 " + m.total + " 题正确率 " + m.accuracy + "%（约「" + ABILITY_LEVELS[m.index].label + "」）——你比它？"
      : "参考：你上次填的是「" + ABILITY_LEVELS[base].label + "」——你比它？"));
    const row = el("div", "row calib-pick");
    [["偏低", -1], ["差不多", 0], ["偏高", 1]].forEach(([label, delta]) => {
      const idx = Math.max(0, Math.min(ABILITY_LEVELS.length - 1, base + Number(delta)));
      const b = el("button", "seg-item" + (state.calib[d.key] === idx ? " active" : ""),
        label + " · " + ABILITY_LEVELS[idx].value);
      b.onclick = () => {
        state.calib[d.key] = idx;
        state.calibStep = step + 1;
        go("report");
      };
      row.appendChild(b);
    });
    box.appendChild(row);
    const noteInput = inputOf("calib-note", d.ask + "（选填）", state.calibNote[d.key] || "");
    noteInput.oninput = () => { state.calibNote[d.key] = noteInput.value; };
    box.appendChild(noteInput);
    card.appendChild(box);
  } else {
    card.appendChild(el("p", "muted", "六条都答完了。保存后雷达图会立刻按新的自评重画。"));
  }

  // 已答一览：想改哪条点哪条（这就是"就地修改"，不用回退流程）
  if (answered > 0) {
    const doneRow = el("div", "row calib-done");
    dims.forEach((d, i) => {
      const idx = state.calib[d.key];
      const b = el("button", "seg-item" + (i === step ? " active" : ""),
        d.key + (idx === undefined ? " —" : " " + ABILITY_LEVELS[idx].value));
      b.onclick = () => { state.calibStep = i; go("report"); };
      doneRow.appendChild(b);
    });
    card.appendChild(doneRow);
  }

  const foot = el("div", "row");
  foot.appendChild(btn("保存", "primary", async () => {
    const selfScores = {};
    dims.forEach((d) => { selfScores[d.key] = valueOf(d); });
    try {
      await saveProfile({ selfScores: selfScores });
      if (state.calibWantNote) {
        await api("/api/study/notes/save", {
          id: "", kbId: state.kb || "", chapter: "",
          title: "画像校准记录 " + fmtStamp(nowStamp()),
          text: calibrationNoteText(),
        });
      }
      await loadReport();
      state.calibOpen = false;
      state.calibStep = 0;
      toast(state.calibWantNote ? "已保存，并记了一条校准笔记" : "已保存");
      go("report");
    } catch (e) { toast("保存失败：" + e.message); }
  }));
  const wantNote = el("label", "muted sm calib-notebox");
  const cb = el("input");
  cb.type = "checkbox";
  cb.checked = !!state.calibWantNote;
  cb.onchange = () => { state.calibWantNote = cb.checked; };
  wantNote.appendChild(cb);
  wantNote.appendChild(el("span", null, " 顺手记一条校准笔记"));
  foot.appendChild(wantNote);
  foot.appendChild(btn("收起", "ghost sm", () => { state.calibOpen = false; go("report"); }));
  card.appendChild(foot);
  return card;
}

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
  // 校准不再是一页：老的深链（#/calibrate）重定向到成长页并就地展开那一段
  async render() {
    state.calibOpen = true;
    await go("report", null, { replace: true });
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
  row.appendChild(btn("播放", "sm primary", () => openSlidePlayer(a.name, undefined, undefined, a.path)));
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
    const renderingGeneration = state.navigationGeneration;
    await loadArtifacts();
    if (renderingGeneration !== state.navigationGeneration) return;
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
      actions: [
        btn("再生成一份", "sm primary", () => go("learn")),
        // 演示文稿很可能是别的工具生成的（PowerPoint / python-pptx），这里给一条直通预览的路
        btn("打开演示文稿…", "sm ghost", async () => {
          const a = window.itnWindow;
          if (!a || typeof a.pickDeck !== "function") { toast("只在桌面应用窗口里可用"); return; }
          const file = await a.pickDeck();
          if (!file) return;
          const short = String(file).replace(/\\/g, "/").split("/").pop();
          openSlidePlayer(short, undefined, undefined, file);
        }),
        // Word 文档同理：别处生成的 .docx 也能在窗口里读（文字预览，按标题分页）
        btn("打开文档…", "sm ghost", async () => {
          const a = window.itnWindow;
          if (!a || typeof a.pickDoc !== "function") { toast("只在桌面应用窗口里可用"); return; }
          const file = await a.pickDoc();
          if (!file) return;
          const short = String(file).replace(/\\/g, "/").split("/").pop();
          openSlidePlayer(short, undefined, undefined, file);
        }),
        btn("刷新", "sm ghost", () => go("resources")),
      ],
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
  // 品牌 logo 有浅底 / 深底两版：主题换了要跟着换，不然深色下会挂一张浅底图
  const wantLogo = state.dark ? "/logo-dark.png" : "/logo-light.png";
  for (const img of document.querySelectorAll("img.empty-logo, img.about-logo")) {
    if (img.getAttribute("src") !== wantLogo) img.src = wantLogo;
  }
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
  dlg.appendChild(el("p", "muted sm", "正文落到本机，引用时写成 [W1]。"));
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

/**
 * 显示大小：**页面缩放**（整体缩放，含布局）与**字体大小**（只动字）是两件事，分开存、分开调。
 * 缩放走 body 的 zoom（Chromium 支持，布局一起缩，最接近"浏览器缩放"的体感）；
 * 字体走根上的 --fs，CSS 里每个字号都是 calc(Npx * var(--fs))。
 */
const ZOOM_STEPS = [0.85, 1, 1.15, 1.3];
const FONT_STEPS = [0.9, 1, 1.1, 1.25];

function clampZoom(v) { return Math.max(0.8, Math.min(1.6, Number(v) || 1)); }
function clampFont(v) { return Math.max(0.85, Math.min(1.4, Number(v) || 1)); }

function applyZoom(v) {
  state.uiZoom = clampZoom(v);
  document.body.style.zoom = String(state.uiZoom);
}

function applyFont(v) {
  state.uiFont = clampFont(v);
  document.documentElement.style.setProperty("--fs", String(state.uiFont));
}

async function setZoom(v) {
  applyZoom(v);
  await savePrefs({ uiZoom: state.uiZoom });
}

async function setFont(v) {
  applyFont(v);
  await savePrefs({ uiFont: state.uiFont });
}

function nearestStep(steps, v) {
  let best = 0;
  let bestD = 1e9;
  steps.forEach((s, i) => {
    const d = Math.abs(s - Number(v || 1));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

function stepZoom(delta) {
  const i = nearestStep(ZOOM_STEPS, state.uiZoom);
  const j = Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + delta));
  setZoom(ZOOM_STEPS[j]);
  toast("页面缩放 " + Math.round(ZOOM_STEPS[j] * 100) + "%");
}

/** Ctrl +/- 加减号缩放、Ctrl 0 复位（与浏览器一致的习惯）。 */
function initZoomKeys() {
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key;
    if (k === "=" || k === "+" || e.code === "NumpadAdd") {
      e.preventDefault();
      stepZoom(1);
    } else if (k === "-" || k === "_" || e.code === "NumpadSubtract") {
      e.preventDefault();
      stepZoom(-1);
    } else if (k === "0" || e.code === "Numpad0") {
      e.preventDefault();
      setZoom(1);
      toast("页面缩放 100%");
    }
  });
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
  applyWidths(p);
  // 智能体那几项也在偏好里（/api/settings 不带它们），拷到 cfg 上给设置页与对话框用。
  // 另外留一份 state.agentPrefs：loadCfg() 会把 cfg 整个换掉，换完要用它合回来，
  // 否则"刚在设置里选的权限"会被下一次 loadCfg 冲成默认值（踩过）。
  state.agentPrefs = {
    agentWorkDir: p.agentWorkDir === undefined ? (state.agentPrefs ? state.agentPrefs.agentWorkDir : "") : p.agentWorkDir,
    agentPerm: p.agentPerm === undefined ? (state.agentPrefs ? state.agentPrefs.agentPerm : "ask") : p.agentPerm,
    // 命令默认开（内核那边 agent_exec 也默认 "1"）；用户关过就按关的来
    agentExec: p.agentExec === undefined ? (state.agentPrefs ? state.agentPrefs.agentExec : "1") : p.agentExec,
    // 用户没指定工作目录时，界面要显示"现在实际用的是哪个目录"，所以内核把默认目录也回过来
    defaultWorkDir: p.defaultWorkDir === undefined ? (state.agentPrefs ? state.agentPrefs.defaultWorkDir : "") : p.defaultWorkDir,
  };
  Object.assign(state.cfg, state.agentPrefs);
  // 没存过就用默认（1 / 1）；刷新后按内核里记的来
  applyZoom(p.uiZoom === undefined || p.uiZoom === "" ? 1 : p.uiZoom);
  applyFont(p.uiFont === undefined || p.uiFont === "" ? 1 : p.uiFont);
  // 知识网络连线上的“关系说明”是否显示（默认显示）；响应里缺这个字段时保留现值
  if (p.knowledgeLinkLabels !== undefined) state.knowledgeLinkLabels = p.knowledgeLinkLabels !== "0";
  // 知识网络默认视图（网络图 / 时间线），下次打开保持上次的选择
  if (p.knowledgeView === "timeline" || p.knowledgeView === "graph") state.knowledgeView = p.knowledgeView;
}

/* ---------- 分栏宽度可拖（对话页的会话栏 / 成果面板） ---------- */

/**
 * 两个可拖的边界。
 *
 * 拖动条做成"贴在面板边缘的一条细窄条"，而不是插到 .app 里当兄弟节点 ——
 * 成果面板是工作台脚本按需创建/移除的，插兄弟节点会在它出现时错位。
 */
const LAYOUT_COLS = {
  panel: { key: "uiPanelW", css: "--panel-w", min: 180, max: 520, dir: 1, sel: ".panel" },
  dock: { key: "uiDockW", css: "--dock-w", min: 300, max: 900, dir: -1, sel: ".resource-dock" },
};
const layoutW = { panel: null, dock: null };

function setColWidth(k, v) {
  const L = LAYOUT_COLS[k];
  const n = Math.max(L.min, Math.min(L.max, Math.round(Number(v))));
  layoutW[k] = n;
  document.documentElement.style.setProperty(L.css, n + "px");
  return n;
}

function applyWidths(p) {
  for (const k of Object.keys(LAYOUT_COLS)) {
    const raw = p ? p[LAYOUT_COLS[k].key] : "";
    const v = Number(raw);
    if (v && !Number.isNaN(v)) setColWidth(k, v);
  }
}

function makeSplitter(k) {
  const L = LAYOUT_COLS[k];
  const h = el("div", "splitter splitter-" + k, "");
  h.title = "拖动调整宽度 · 双击恢复默认";
  h.setAttribute("aria-label", "调整宽度");
  let startX = 0, startW = 0, startZoom = 1, dragging = false;
  h.addEventListener("pointerdown", (e) => {
    const target = document.querySelector(L.sel);
    if (!target) return;
    dragging = true;
    startX = e.clientX;
    /* 宽度换算成**布局坐标**再算，别直接拿屏幕坐标：
       界面上的"显示大小"是 body 的 zoom，指针事件给的是屏幕坐标、CSS 宽度是布局坐标，
       不换算的话拖动会按缩放比例滞后（实测 zoom 1.3 时鼠标走 100px、边界只走 78px —— 用户报的"偏移"）。
       zoom 不去读设置里的值，而是**就地自校准**：量出来的宽度 ÷ 计算样式的宽度就是实际缩放，
       这样无论缩放是怎么来的（设置、Ctrl +/-、还是别处写的 body zoom）都成立。
       起点优先取 CSS 变量本身（它就是要改的那个值），取不到再退回布局宽度。 */
    const layoutW = parseFloat(getComputedStyle(target).width) || 0;
    const screenW = target.getBoundingClientRect().width;
    startZoom = (layoutW > 0 && screenW > 0) ? (screenW / layoutW) : 1;
    const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(L.css));
    startW = (Number.isFinite(cur) && cur > 0) ? cur : layoutW;
    try { h.setPointerCapture(e.pointerId); } catch (err) { /* 老环境 */ }
    document.body.classList.add("splitting");
    e.preventDefault();
  });
  h.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    setColWidth(k, startW + L.dir * ((e.clientX - startX) / startZoom));
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("splitting");
    savePrefs({ [LAYOUT_COLS[k].key]: Number(layoutW[k] || 0) });
  };
  h.addEventListener("pointerup", end);
  h.addEventListener("pointercancel", end);
  h.addEventListener("dblclick", () => {
    layoutW[k] = null;
    document.documentElement.style.removeProperty(LAYOUT_COLS[k].css);
    savePrefs({ [LAYOUT_COLS[k].key]: "" });
    toast("这一栏恢复默认宽度");
  });
  return h;
}

/** 幂等：面板每次渲染都调一次，已挂过就不重复挂（成果面板是动态创建/移除的）。 */
function installSplitters() {
  for (const k of Object.keys(LAYOUT_COLS)) {
    const target = document.querySelector(LAYOUT_COLS[k].sel);
    if (target && !target.querySelector(".splitter-" + k)) target.appendChild(makeSplitter(k));
  }
}

/* ---------- 斜杠命令：窗口里也能用 lumin 那几个开关 ---------- */

/**
 * 输入框里以 / 开头的就是命令，不当正文发出去。
 *
 * 命令行那版 lumin 的 \ 开关（模型 / 联网 / 权限 / 技能）在窗口里没有等价入口，
 * 用户得跑到设置页去点；这里把它们搬到手边，语义与设置页完全一致 ——
 * 都是改同一份设置，不存在"命令行里改了、设置页看不见"的第二套状态。
 */
const SLASH_COMMANDS = [
  { cmd: "/help", args: "", desc: "看这一页能用哪些命令", run: () => showSlashHelp() },
  { cmd: "/new", args: "", desc: "开一段新的常规聊天", run: () => newChat("", "chat") },
  { cmd: "/model", args: "名字", desc: "切换对话模型（不带参数＝列出并打开设置）", run: (a) => slashModel(a) },
  { cmd: "/perm", args: "ask|auto|full", desc: "权限档位（常规聊天锁死在 ask）", run: (a) => slashPerm(a) },
  { cmd: "/web", args: "off|auto|on", desc: "联网档位", run: (a) => slashWeb(a) },
  { cmd: "/skill", args: "名字", desc: "绑定技能（不带参数＝列出可用技能）", run: (a) => slashSkill(a) },
  { cmd: "/dir", args: "", desc: "改默认工作目录（打开选择框）", run: () => slashDir() },
  { cmd: "/branch", args: "", desc: "从最后一轮开一段分支会话", run: () => slashBranch() },
  { cmd: "/stop", args: "", desc: "停止正在跑的这一轮", run: () => { const b = document.querySelector(".composer-send"); if (b) b.click(); } },
  { cmd: "/clear", args: "", desc: "清空输入框", run: () => { const t = $("chat-input"); if (t) { t.value = ""; t.focus(); } } },
  /* 下面这几条是照着 pi 的命令面补的（docs/slash-commands.md）：
     会话信息、改名、导出、重载、快捷键、复制上一条回答 —— 都是"本地动作"，不花模型调用。 */
  { cmd: "/session", args: "", desc: "看这一段会话的信息与用量", run: () => slashSessionInfo() },
  { cmd: "/name", args: "名字", desc: "给这段会话改名（不带参数＝看当前名字）", run: (a) => slashName(a) },
  { cmd: "/export", args: "", desc: "把这一段对话导出成 Markdown 存到成果里", run: () => slashExport() },
  { cmd: "/reload", args: "", desc: "重新读配置、技能、项目与会话列表", run: () => slashReload() },
  { cmd: "/hotkeys", args: "", desc: "看窗口里可用的快捷键", run: () => slashHotkeys() },
  { cmd: "/copy", args: "", desc: "复制最后一条回答", run: () => slashCopyLast() },
];

function slashMatches(text) {
  const t = String(text || "");
  if (t.charAt(0) !== "/") return [];
  const word = t.split(/\s+/)[0].toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.cmd.indexOf(word) === 0);
}

function slashHintShow(on, text) {
  let box = $("slash-hint");
  if (!box) {
    box = el("div", "slash-hint");
    box.id = "slash-hint";
    const ta = $("chat-input");
    if (ta && ta.parentElement) ta.parentElement.insertBefore(box, ta);
  }
  if (!on) { box.hidden = true; return; }
  const hits = slashMatches(text);
  box.innerHTML = "";
  if (!hits.length) {
    box.appendChild(el("div", "slash-row", "没有这个命令 · 输入 /help 看全部"));
  } else {
    for (const c of hits.slice(0, 6)) {
      const row = el("button", "slash-row", "");
      row.type = "button";
      row.innerHTML = "<b>" + esc(c.cmd + (c.args ? " " + c.args : "")) + "</b><span>" + esc(c.desc) + "</span>";
      row.onmousedown = (e) => { e.preventDefault(); const ta = $("chat-input"); if (ta) { ta.value = c.cmd + " "; ta.focus(); } slashHintShow(true, c.cmd + " "); };
      box.appendChild(row);
    }
  }
  box.hidden = false;
}

function showSlashHelp() {
  const v = $("view");
  const dlg = el("div", "card dialog");
  dlg.appendChild(cardHeadOnly("窗口里的命令"));
  const ul = el("ul", "about-list");
  for (const c of SLASH_COMMANDS) {
    ul.appendChild(el("li", null, c.cmd + (c.args ? " " + c.args : "") + " — " + c.desc));
  }
  dlg.appendChild(ul);
  dlg.appendChild(el("p", "muted sm", "命令改的就是设置页里那份状态：模型、联网、权限、技能、工作目录。"));
  const row = el("div", "row");
  row.appendChild(btn("知道了", "primary", () => dlg.remove()));
  dlg.appendChild(row);
  v.insertBefore(dlg, v.firstChild);
  dlg.scrollIntoView({ block: "start" });
}

async function slashModel(arg) {
  const models = state.cfg.models || [];
  if (!arg) {
    toast("当前：" + (modelLabel(state.cfg.chatModelId) || "未配置") + "（" + models.length + " 个可用）");
    go("settings", "models");
    return;
  }
  const hit = models.find((m) => m.id === arg || (m.name || "").toLowerCase() === arg.toLowerCase()
    || (m.model || "").toLowerCase() === arg.toLowerCase());
  if (!hit) { toast("没有这个模型：" + arg + "（用 /model 不带参数看清单）"); return; }
  await api("/api/models/roles", { chatModelId: hit.id, embedModelId: state.cfg.embedModelId, chunkModelId: state.cfg.chunkModelId, ttsModelId: state.cfg.ttsModelId });
  await loadCfg();
  toast("对话模型已切到「" + (hit.name || hit.id) + "」");
  renderPanel();
  go("chat");
}

async function slashPerm(arg) {
  if (state.chatProject === "") { toast("常规聊天是固定档（只写默认目录）；权限档位在「指定工作区」会话里选"); return; }
  const m = String(arg || "").toLowerCase();
  if (m !== "ask" && m !== "auto" && m !== "full") { toast("用法：/perm ask | auto | full"); return; }
  state.cfg.agentPerm = m;
  await savePrefs({ agentPerm: m });
  toast("权限：" + (PERM_LABEL[m] || m));
  go("chat");
}

async function slashWeb(arg) {
  const m = String(arg || "").toLowerCase();
  if (m !== "off" && m !== "auto" && m !== "on") { toast("用法：/web off | auto | on（当前 " + (state.webMode || "auto") + "）"); return; }
  try {
    await api("/api/websearch/save", { mode: m });
    state.webMode = m;
    toast("联网档位：" + m);
    go("chat");
  } catch (e) { toast("改不了：" + e.message); }
}

function slashSkill(arg) {
  const list = state.skills || [];
  if (!arg) {
    const names = list.map((s) => s.id).filter(Boolean);
    toast(names.length ? "可用技能：" + names.slice(0, 6).join("、") : "没有可用技能（先在设置里放技能目录）");
    return;
  }
  const hit = list.find((s) => s.id === arg || (s.title || "") === arg);
  if (!hit) { toast("没有这个技能：" + arg); return; }
  state.skill = hit.id;
  toast("已绑定技能：" + (hit.title || hit.id));
  go("chat");
}

async function slashDir() {
  const a = window.itnWindow;
  if (!a || typeof a.pickDirectory !== "function") { toast("选目录只在桌面应用窗口里可用"); return; }
  const picked = await a.pickDirectory();
  if (!picked) return;
  await savePrefs({ agentWorkDir: picked });
  state.cfg.agentWorkDir = picked;
  toast("默认工作目录：" + picked);
  go("chat");
}

/** /session：这一段会话的身份与用量（pi 的 /session 是同一种"本地体检"）。 */
function slashSessionInfo() {
  const sid = state.chatSessionId;
  if (!sid) { toast("还没有会话"); return; }
  const meta = sessionMetaOf(sid) || {};
  const wd = sessionWorkDir();
  const turns = (state.chatTurns || []);
  let usageIn = 0, usageOut = 0;
  for (const t of turns) { usageIn += Number(t.usageIn || 0); usageOut += Number(t.usageOut || 0); }
  const dlg = el("div", "card dialog");
  dlg.appendChild(cardHeadOnly("这一段会话"));
  const ul = el("ul", "about-list");
  ul.appendChild(el("li", null, "名字：" + ((meta.title) || "（还没有名字）")));
  ul.appendChild(el("li", null, "会话 id：" + sid + "（链接：lumin://thread/" + sid + "）"));
  ul.appendChild(el("li", null, "工作区：" + (wd.project ? "指定工作区 · " : "常规对话 · ") + (wd.path || "未指定")));
  ul.appendChild(el("li", null, "轮次：" + turns.filter((t) => t.user).length + " · 事件：" + (state.chatEvents || []).length + " 条"));
  ul.appendChild(el("li", null, "上一轮 token：输入 " + ((turns[turns.length - 1] || {}).usageIn || 0) +
    " · 输出 " + ((turns[turns.length - 1] || {}).usageOut || 0)));
  ul.appendChild(el("li", null, "累计（本窗口看到的）：输入 " + usageIn + " · 输出 " + usageOut));
  dlg.appendChild(ul);
  const row = el("div", "row");
  row.appendChild(btn("复制会话链接", "", () => copyText("lumin://thread/" + sid)));
  row.appendChild(btn("知道了", "primary", () => dlg.remove()));
  dlg.appendChild(row);
  $("view").insertBefore(dlg, $("view").firstChild);
  dlg.scrollIntoView({ block: "start" });
}

/** /name [名字]：不带参数就报当前名字（与 pi 的 /name 一致）。 */
async function slashName(arg) {
  const sid = state.chatSessionId;
  if (!sid) { toast("还没有会话"); return; }
  const meta = sessionMetaOf(sid) || {};
  if (!arg) { toast("当前名字：" + (meta.title || "（没有名字，用第一句话兜着）")); return; }
  try {
    await api("/api/sessions/rename", { sessionId: sid, title: arg });
    // 起过名字就不再让模型改名（内核那边 titleReady 已经守住了）
    state.chatTitleHint = state.chatTitleHint || {};
    state.chatTitleHint[sid] = arg;
    await reloadSessions();
    if (typeof refreshChatHeader === "function") refreshChatHeader();
    toast("已改名：" + arg);
  } catch (e) { toast("改名失败：" + e.message); }
}

/** /export：把这一段对话导成 Markdown 落到本机成果里（pi 的 /export 是导 HTML/JSONL）。 */
async function slashExport() {
  const sid = state.chatSessionId;
  const turns = state.chatTurns || [];
  if (!sid || !turns.length) { toast("这一段还没有可导出的内容"); return; }
  const meta = sessionMetaOf(sid) || {};
  const lines = ["# " + (meta.title || "会话记录"), "", "> 会话 id：" + sid + " · 导出时间：" + fmtStamp(new Date().toISOString())];
  for (const t of turns) {
    lines.push("", "## " + (t.user || "（无提问）").split("\n")[0]);
    if (t.user) lines.push("", "**我**：", "", t.user);
    for (const it of t.items) {
      if (it.t === "think" && it.text) lines.push("", "<details><summary>思考过程</summary>", "", it.text, "", "</details>");
      else if (it.t === "tool") lines.push("", "**工具 `" + (it.name || "") + "`**：" + (it.ok === false ? "失败" : "完成") +
        (it.args ? "\n\n```json\n" + JSON.stringify(it.args, null, 2) + "\n```" : ""));
      else if (it.text) lines.push("", "**Lumin**：", "", it.text);
    }
    if (t.ok === false) lines.push("", "_（这一轮没有完成：" + (t.message || "") + "）_");
  }
  const name = "会话-" + String(meta.title || sid).replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) + "-" +
    new Date().toISOString().slice(0, 10) + ".md";
  try {
    const r = await api("/api/artifacts/save", { name: name, content: lines.join("\n") });
    await loadArtifacts();
    toast("已导出到成果：" + (r && r.path ? r.path.split(/[\\/]/).pop() : name));
    if (typeof refreshWorkbenchState === "function") refreshWorkbenchState().catch(() => {});
  } catch (e) { toast("导出失败：" + e.message); }
}

/** /reload：改了设置/技能/新建项目之后不用重启（pi 的 /reload 同义）。 */
async function slashReload() {
  try {
    await loadCfg();
    await loadProjects();
    await loadSessions();
    await loadSkills(state.chatSessionId || "");
    renderPanel();
    if (typeof refreshChatHeader === "function") refreshChatHeader();
    toast("已重新读取配置、技能、项目与会话列表");
  } catch (e) { toast("重载失败：" + e.message); }
}

/** /hotkeys：把窗口里真正可用的键位列出来（不是抄一份用不上的清单）。 */
function slashHotkeys() {
  const dlg = el("div", "card dialog");
  dlg.appendChild(cardHeadOnly("快捷键"));
  const ul = el("ul", "about-list");
  [
    "Enter 发送 · Shift+Enter 换行（跑着的时候 Enter 是插话）",
    "Esc 停止这一轮（有浮层时先关浮层）",
    "Ctrl/Cmd + K 全局检索",
    "Ctrl/Cmd + Shift + S 显示/隐藏会话栏",
    "Ctrl/Cmd + 加号/减号 调整显示大小 · Ctrl/Cmd + 0 复位",
    "输入 / 出命令表 · /help 看全部命令",
    "空格键悬停…（不必）",
  ].forEach((x) => { if (x.indexOf("不必") < 0) ul.appendChild(el("li", null, x)); });
  dlg.appendChild(ul);
  const row = el("div", "row");
  row.appendChild(btn("知道了", "primary", () => dlg.remove()));
  dlg.appendChild(row);
  $("view").insertBefore(dlg, $("view").firstChild);
  dlg.scrollIntoView({ block: "start" });
}

/** /copy：复制最后一条回答（pi 的 /copy 同义）。 */
function slashCopyLast() {
  const turns = state.chatTurns || [];
  for (let i = turns.length - 1; i >= 0; i--) {
    for (let k = turns[i].items.length - 1; k >= 0; k--) {
      const it = turns[i].items[k];
      if (it.t === "a" && it.text) { copyText(it.text); return; }
    }
  }
  toast("还没有可复制的回答");
}

async function slashBranch() {
  await branchFromLatest();
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

/**
 * 在锚点旁边浮出一块菜单。
 *
 * 挂到 document.body 上用 fixed 定位，而不是当面板里的 absolute 子节点 ——
 * 面板自己有层叠上下文（玻璃层的 backdrop-filter 就会建一层），菜单一旦比面板宽，
 * 左边伸出去的那截就被最左侧栏盖住了（用户实测：＋ 的浮窗左边被侧栏遮住）。
 * fixed 层不受祖先的层叠与裁剪影响，再做一次夹取就永远在屏幕里。
 */
let activePopover = null;

function closePopover() {
  if (!activePopover) return;
  activePopover.menu.remove();
  document.removeEventListener("click", activePopover.away, true);
  document.removeEventListener("keydown", activePopover.onKey, true);
  window.removeEventListener("resize", activePopover.onAway);
  window.removeEventListener("scroll", activePopover.onAway, true);
  activePopover = null;
}

function popoverAt(anchor, build, opts) {
  closePopover();
  const menu = el("div", "rail-menu popover" + (opts && opts.cls ? " " + opts.cls : ""));
  build(menu);
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth || 240;
  const mh = menu.offsetHeight || 160;
  let left;
  if (opts && opts.side === "panel") {
    // 贴着整个面板的左缘（＋ 在面板右上角，菜单比面板宽，右对齐会伸到最左侧栏上面去）
    const panelEl = anchor.closest(".panel");
    left = panelEl ? panelEl.getBoundingClientRect().left : rect.left;
  } else if (opts && opts.side === "left") {
    left = rect.left;
  } else {
    left = rect.right - mw;
  }
  left = Math.max(8, Math.min(window.innerWidth - mw - 8, left));
  let top = rect.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 6);
  menu.style.left = Math.round(left) + "px";
  menu.style.top = Math.round(top) + "px";
  const entry = {
    menu: menu,
    away: (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) closePopover(); },
    onKey: (e) => { if (e.key === "Escape") { e.stopPropagation(); closePopover(); } },
    onAway: () => closePopover(),
  };
  activePopover = entry;
  setTimeout(() => {
    document.addEventListener("click", entry.away, true);
    document.addEventListener("keydown", entry.onKey, true);
    window.addEventListener("resize", entry.onAway);
    window.addEventListener("scroll", entry.onAway, true);
  }, 0);
  return menu;
}

/** 路径最后一段（面包屑上用短名，完整路径放 tooltip）。 */
function baseName(p) {
  const t = String(p || "").replace(/[\\/]+$/, "");
  return t.split(/[\\/]/).pop() || "";
}

/** 这段会话干活的目录：挂在项目下就用项目文件夹，否则用默认工作目录。 */
function sessionWorkDir(sid) {
  const id = sid || state.chatSessionId;
  const meta = (state.sessions || []).find((x) => x.sessionId === id) || {};
  /* 归属以这两个来源为准，**不能只看会话列表**：
     刚新建的会话还没有任何事件，列表里根本没有它（列表是按"有事件的会话"聚合的），
     于是它会被误判成常规对话 —— 用户实测："我点项目的新会话按钮，怎么还出现了常规聊天"。 */
  const isCurrent = !sid || sid === state.chatSessionId;
  const pid = (isCurrent ? (state.chatProject || "") : "") || meta.projectId || "";
  const project = (state.projects || []).find((p) => p.id === pid);
  if (project) {
    return { name: project.name || baseName(project.root) || project.root, path: project.root || "", project: project };
  }
  const dir = state.cfg.agentWorkDir || state.cfg.defaultWorkDir || "";
  return { name: baseName(dir) || "默认工作目录", path: dir, project: null };
}

/** 这一段会话的摘要（列表里那一行）。 */
function sessionMetaOf(sid) {
  return (state.sessions || []).find((x) => x.sessionId === (sid || state.chatSessionId)) || null;
}

/**
 * 对话页顶栏左边那条面包屑：📁 工作区名 | 会话名。
 *
 * 会话名是"这段对话的名字"：第一次提问后由模型起一次（见 maybeGenerateTitle），
 * 在那之前先用第一句话兜着；用户也能在右边的 ⋯ 里手动改。
 */
function sessionCrumb() {
  const wrap = el("span", "wb-crumb");
  const wd = sessionWorkDir();
  const folder = el("span", "wb-crumb-ws");
  folder.innerHTML = icon("folder") + "<span>" + esc(wd.name || "未指定工作区") + "</span>";
  folder.title = (wd.path ? wd.path + "\n" : "") +
    (wd.project ? "指定工作区：权限按对话框下面的档位来" : "常规聊天：只对默认工作目录可写") +
    "\n检索范围：本机全部知识库";
  if (wd.path && window.itnWindow && typeof window.itnWindow.openPath === "function") {
    folder.classList.add("clickable");
    folder.onclick = () => window.itnWindow.openPath(wd.path).then((r) => { if (r && r.ok === false) toast(r.error); });
  }
  wrap.appendChild(folder);
  wrap.appendChild(el("span", "wb-crumb-sep", "|"));
  const meta = sessionMetaOf();
  const hint = (state.chatTitleHint || {})[state.chatSessionId] || "";
  const fullTitle = (meta && meta.title) || hint || (state.chatSessionId ? "新对话" : "还没有对话");
  const letters = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(fullTitle)].map(x => x.segment)
    : Array.from(fullTitle);
  const title = el("span", "wb-crumb-title", letters.slice(0, 8).join("") + (letters.length > 8 ? "…" : ""));
  title.title = fullTitle;
  title.setAttribute("aria-label", fullTitle);
  wrap.appendChild(title);
  return wrap;
}

/**
 * 对话页顶栏右边那三个点：改名字 / 新建分支 / 复制会话链接。
 *
 * "新建分支"是从**最新一轮**分出去的：想换个问法重来、又想留着原来那条线时用它。
 * 链接是 `lumin://thread/<会话id>` —— 点开就回到这一段对话（与 Codex 的深度链接同一个用法）。
 */
function sessionMoreBtn() {
  const wrap = el("span", "wb-menu-wrap");
  const trigger = el("button", "wb-menu-btn", "");
  trigger.type = "button";
  trigger.title = state.chatSessionId ? "这段会话的更多操作" : "先开一段对话";
  trigger.setAttribute("aria-label", "会话操作");
  trigger.innerHTML = icon("dotsH");
  trigger.disabled = !state.chatSessionId;
  const item = (label, ic, fn) => {
    const b = el("button", "rail-menu-item", "");
    b.type = "button";
    b.innerHTML = icon(ic) + "<span class='rail-menu-main'>" + esc(label) + "</span>";
    b.onclick = (ev) => { ev.stopPropagation(); closePopover(); fn(); };
    return b;
  };
  trigger.onclick = (ev) => {
    ev.stopPropagation();
    const sid = state.chatSessionId;
    if (!sid) return;
    const meta = sessionMetaOf(sid) || { sessionId: sid, title: "" };
    popoverAt(trigger, (menu) => {
      menu.appendChild(el("div", "rail-menu-title", "这段会话"));
      menu.appendChild(item("修改会话名称…", "pencil", () => renameSessionDialog(meta)));
      menu.appendChild(item("新建分支", "branch", () => {
        /* 从**最新一轮**分出去：那一轮之前的历史原样带进新会话（用户要的语义）。
           传空 turnId 等于"什么都不复制"，内核会直接拒 —— 这里必须真拿一个轮次 id。 */
        const turns = (state.chatTurns || []).filter((x) => x.id && x.id !== "local");
        if (!turns.length) { toast("这一段还没有可以分支的轮次"); return; }
        branchFromTurn(turns[turns.length - 1]);
      }));
      menu.appendChild(item("复制会话链接", "copy", () => copyText("lumin://thread/" + sid)));
    }, { side: "right", cls: "session-menu-right" });
  };
  wrap.appendChild(trigger);
  return wrap;
}

/**
 * 会话标题：第一次提问之后，另起一次很小的模型请求给这段对话起名。
 *
 * 三条规矩（用户定的）：
 *   ① **只生成一次** —— 这段会话已经有名字（自动生成的、或用户手动改的）就不再问；
 *   ② 名字没回来之前，列表与顶栏先用第一句话 + 省略号兜着（内核的 summary 本来就这么兜）；
 *   ③ 用户后来改写了第一条提问也不重新生成 —— 标题是"这段对话的名字"，不是那句话的摘要。
 * 起名失败不影响对话：静默留着第一句话当名字。
 */
async function maybeGenerateTitle(sid) {
  if (!sid) return;
  state.titleAsked = state.titleAsked || {};
  const tries = state.titleAsked[sid] || 0;
  /* 一次成功就够：内核那边已经有名字（自动或手动）时会直接回 generated=false。
     失败允许再补 —— 第一次提问时模型正忙着生成正文，起名请求可能撞超时；
     但最多补 3 次，别为了一行字反复打扰模型。 */
  if (tries >= 3) return;
  state.titleAsked[sid] = tries + 1;
  try {
    const d = await api("/api/sessions/title", { sessionId: sid });
    if (!d || !d.generated) return;
    await loadSessions();
    if (current === "chat" && currentSection !== "overview") {
      await renderPanel();
      if (typeof refreshChatHeader === "function") refreshChatHeader();
    }
  } catch (e) {
    // 起名是锦上添花：拿不到就继续用第一句话兜着，不打扰用户
  }
}

/* ---------- 全局检索（Ctrl/Cmd + K）：一条命令找遍资料、章节、笔记、产物 ---------- */

const palette = { open: false, query: "", items: [], active: 0, timer: null, cache: null, seq: 0 };

/** 打开时把章节/笔记/产物读一次，之后每次输入只在本地过滤；只有资料切片走服务端检索。 */
async function loadPaletteCache() {
  if (palette.cache) return palette.cache;
  await loadCfg();
  const [tree, notes, arts] = await Promise.all([
    api("/api/study/course", { kbId: state.kb }).catch(() => ({ chapters: [] })),
    api("/api/study/notes/list", {}).catch(() => ({ notes: [] })),
    api("/api/artifacts/list", {}).catch(() => ({ artifacts: [] })),
  ]);
  palette.cache = { chapters: tree.chapters || [], tree: tree, notes: notes.notes || [], artifacts: arts.artifacts || [] };
  return palette.cache;
}

function paletteItemMain(label, sub, kind, run) {
  return { label: label, sub: sub || "", kind: kind || "", run: run, group: "" };
}

/* 每一类结果配一枚小图标（和左侧栏同一套图标语言） */
const PALETTE_ICON = { "对话": "chat", "生成": "plus", "章节": "book", "笔记": "note", "产物": "layers", "资料": "db", "提示": "alert" };

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
      paletteItemMain("就这个主题生成讲义：" + q, "交给 Lumin 一次任务完成，步骤由它自己排", "生成", () => { go("learn"); setTimeout(() => askTopic("lecture", q), 300); }),
    ]]);
  }

  const chapters = cache.chapters.filter((c) => hit(c.name)).slice(0, 5)
    .map((c) => paletteItemMain(c.title || c.name, "本章 " + c.sectionCount + " 节，学完 " + c.doneCount + " 节", "章节", () => {
      state.chapter = c.name;
      go("learn");
    }));
  if (chapters.length) groups.push(["章节", chapters]);

  const notes = cache.notes.filter((n) => !q && (hit(n.title) || hit(n.text))).slice(0, 5)
    .map((n) => paletteItemMain(n.title || "无标题", (n.chapter ? n.chapter + " · " : "") + String(n.text || "").slice(0, 40), "笔记", () => { state.resTab='notes'; return go('notes','',{focus:n.id}); }));
  if (notes.length) groups.push(["笔记", notes]);

  const arts = cache.artifacts.filter((a) => !q && hit(a.name)).slice(0, 5)
    .map((a) => paletteItemMain(a.name, fmtSize(a.size) + (a.page > 0 ? " · 上次讲到第 " + a.page + " 页" : ""), "产物", () => openSlidePlayer(a.name, undefined, undefined, a.path)));
  if (arts.length) groups.push(["产物", arts]);

  let flat = [];
  for (const [title, items] of groups) {
    for (const it of items) {
      it.group = title;
      flat.push(it);
    }
  }

  if (q) {
    try {
      const personal = await api('/api/personal/search',{query:q,limit:15});
      if(seq!==palette.seq || !palette.open)return;
      const labels={resource:'个性资源',note:'笔记',wrong:'错题',knowledge:'知识点'};
      for(const type of ['resource','knowledge','note','wrong']){
        const hits=(personal.hits || []).filter(h=>h.type===type).map(h=>paletteItemMain(h.title,h.snippet,type==='resource'?'产物':type==='knowledge'?'章节':'笔记',()=>openPersonalSearchHit(h)));
        if(hits.length)groups.push([labels[type],hits]);
      }
    }catch(e){groups.push(['个人内容',[paletteItemMain('个人内容搜索暂时失败',e.message,'提示',()=>openPalette())]]);}
    try {
      const result = await api('/api/sessions/search', {query:q, limit:12});
      if (seq !== palette.seq || !palette.open) return;
      const hits = (result.hits || []).map(h => paletteItemMain(h.title || '新对话', h.snippet, '对话', () => revealChatHit(h)));
      if (hits.length) groups.unshift(['对话内容', hits]);
    } catch(e) { groups.push(['对话内容', [paletteItemMain('对话搜索暂时失败',e.message,'提示',()=>openPalette())]]); }
  }
  // 资料内容在服务器检索，打开后定位到原文。
  if (q.length >= 2 && state.kb) {
    try {
      const d = await api("/api/kb/search", { id: state.kb, query: q, topK: 5 });
      if (seq !== palette.seq) return;   // 期间用户又改了输入，这次结果作废
      const hits = (d.hits || []).map((h) => paletteItemMain(
        "《" + (h.docTitle || "") + "》" + (h.headingPath ? " · " + h.headingPath : ""),
        String(h.text || "").replace(/\s+/g, " ").slice(0, 70),
        "资料",
        () => {
          openLibraryHit(h);
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
  if (seq !== palette.seq || !palette.open) return;
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
  const countEl = root.querySelector(".palette-count");
  if (countEl) countEl.textContent = palette.items.length ? palette.items.length + " 条结果" : "";
  if (!palette.items.length) {
    const empty = el("div", "palette-empty");
    empty.innerHTML = icon("search");
    empty.appendChild(el("span", null, palette.query ? "没有匹配的内容，换个关键词试试" : "输入关键词：资料切片、章节、笔记、产物都会一起找"));
    list.appendChild(empty);
    return;
  }
  let lastGroup = "";
  palette.items.forEach((it, i) => {
    if (it.group !== lastGroup) {
      lastGroup = it.group;
      const head = el("div", "palette-group-title");
      head.appendChild(el("span", null, it.group));
      head.appendChild(el("span", "palette-group-count", String(palette.items.filter((x) => x.group === it.group).length)));
      list.appendChild(head);
    }
    const b = el("button", "palette-item" + (i === palette.active ? " active" : ""));
    const mark = el("span", "pi-icon");
    mark.innerHTML = icon(PALETTE_ICON[it.kind] || "search");
    b.appendChild(mark);
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
    Promise.resolve(it.run()).catch(e => toast('打开失败：' + e.message));
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
  const search = el("div", "palette-search");
  const lead = el("span", "palette-lead");
  lead.innerHTML = icon("search");
  search.appendChild(lead);
  const input = el("input", "palette-input");
  input.id = "palette-input";
  input.placeholder = "搜索对话内容、资料、章节、笔记与成果…";
  search.appendChild(input);
  search.appendChild(el("span", "palette-esc", "Esc"));
  head.appendChild(search);
  box.appendChild(head);
  box.appendChild(el("div", "palette-list"));
  const foot = el("div", "palette-foot");
  foot.appendChild(el("span", "palette-hint", "↑↓ 选择 · Enter 打开"));
  foot.appendChild(el("span", "palette-count", ""));
  box.appendChild(foot);
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
  if (palette.open) await runPaletteSearch(input.value);
}

function closePalette() {
  const root = $("palette");
  if (!root) return;
  if (palette.timer) { clearTimeout(palette.timer); palette.timer = null; }
  palette.open = false;
  palette.seq++;
  root.hidden = true;
  root.innerHTML = "";
}

/* ---------- 课件播放器：把讲义/练习/章节按二级标题切成页，逐页讲授 ---------- */

const playerState = { key: "", name: "", slides: [], index: 0, fontSize: 18, tocOpen: false, collapsed: false, saveTimer: null };

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

/**
 * 一份演示文稿的每一页 → 播放器要的 {title, body}。
 *
 * pptx 的文字是壳里解出来的（见 shell/pptx.js）：第一行当标题，其余当正文。
 * 这是**文字预览** —— 排版、图片、动画还在 PowerPoint 里，按钮里给了直达入口。
 */
function deckToSlides(deck) {
  return (deck.slides || []).map((sl, i) => {
    const lines = String(sl.text || "").split("\n");
    const title = (lines.shift() || "").trim() || ("第 " + (i + 1) + " 页");
    return { title: title, body: lines.join("\n").trim() };
  });
}

/** 一份 .docx 的文字 → 播放器要的 {title, body}：按一/二级标题分页，太长再按段落数切开。 */
function docToSlides(doc) {
  const paras = doc.paragraphs || [];
  const pages = [];
  let cur = null;
  const flush = () => {
    if (cur && (cur.title || cur.lines.length)) pages.push(cur);
    cur = null;
  };
  for (const p of paras) {
    const level = Number(p.level || 0);
    if (level >= 1 && level <= 2) { flush(); cur = { title: p.text, lines: [] }; continue; }
    if (!cur) cur = { title: "", lines: [] };
    cur.lines.push(level >= 3 ? "## " + p.text : p.text);
    if (cur.lines.length >= 14 || cur.lines.join("\n").length > 1000) flush();
  }
  flush();
  if (!pages.length && paras.length) pages.push({ title: "", lines: paras.map((p) => p.text) });
  return pages.map((p, i) => ({ title: p.title || ("第 " + (i + 1) + " 页"), body: p.lines.join("\n") }));
}

async function openSlidePlayer(name, content, key, path) {
  const root = $("player");
  if (!root) return;
  playerState.path = path || "";
  playerState.deck = false;
  playerState.openLabel = "";
  let text = content;
  const isDeck = /\.(pptx|pptm|ppt)$/i.test(String(name || ""));
  const isDoc = /\.(docx|docm|doc)$/i.test(String(name || ""));
  if (isDoc && text === undefined) {
    // 文档也不是 Markdown：交给壳去解（离线、只读），文字按标题分页看
    const a = window.itnWindow;
    if (!a || typeof a.readDoc !== "function") {
      toast("读文档只在桌面应用窗口里可用");
      return;
    }
    const r = await a.readDoc(path || name);
    if (!r.ok) {
      toast("读不了这份文档：" + r.error);
      return;
    }
    playerState.deck = true;       // 复用"用系统程序打开"那个按钮
    playerState.openLabel = "用 Word 打开";
    playerState.slides = docToSlides(r);
    if (!playerState.slides.length) {
      toast("这份文档里没有可显示的文字");
      return;
    }
    playerState.name = name;
    playerState.key = key || name;
    playerState.tocOpen = false;
    playerState.index = 0;
    root.hidden = false;
    document.body.classList.add("player-open");
    applyPlayerFont();
    renderPlayer();
    toast(r.kind === "doc" ? "旧版 .doc 只能给出文字预览" : "文档按标题分页预览（文字）");
    return;
  }
  if (isDeck && text === undefined) {
    // 演示文稿不是 Markdown：交给壳去解（离线、只读），失败就如实说读不了
    const a = window.itnWindow;
    if (!a || typeof a.readDeck !== "function") {
      toast("读演示文稿只在桌面应用窗口里可用");
      return;
    }
    const r = await a.readDeck(path || name);
    if (!r.ok) {
      toast("读不了这份演示文稿：" + r.error);
      return;
    }
    playerState.deck = true;
    playerState.slides = deckToSlides(r);
    if (!playerState.slides.length) {
      toast("这份演示文稿里没有可显示的页面");
      return;
    }
    playerState.name = name;
    playerState.key = key || name;
    playerState.tocOpen = false;
    playerState.index = 0;
    root.hidden = false;
    document.body.classList.add("player-open");
    applyPlayerFont();
    renderPlayer();
    toast(r.kind === "ppt" ? "旧版 .ppt 只能给出文字预览" : "演示文稿按文字预览打开");
    return;
  }
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
  if (current === "resources") go("resources", currentSection);
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
  if(playerState.resourceForPpt)tools.appendChild(btn('制作 PPTX','sm',()=>{closePlayer();openPresentationBrief(playerState.resourceForPpt);}));
  tools.appendChild(btn("目录", "sm " + (playerState.tocOpen ? "primary" : "ghost"), () => {
    playerState.tocOpen = !playerState.tocOpen;
    renderPlayer();
  }));
  tools.appendChild(btn("A−", "sm ghost", () => { playerState.fontSize = Math.max(14, playerState.fontSize - 2); applyPlayerFont(); }));
  tools.appendChild(btn("A+", "sm ghost", () => { playerState.fontSize = Math.min(30, playerState.fontSize + 2); applyPlayerFont(); }));
  tools.appendChild(btn(document.fullscreenElement ? "退出全屏" : "全屏", "sm ghost", () => togglePlayerFullscreen()));
  tools.appendChild(btn(playerState.collapsed ? "展开" : "折叠", "sm ghost", () => {
    playerState.collapsed = !playerState.collapsed;
    renderPlayer();
  }));
  if (playerState.deck && playerState.path) {
    tools.appendChild(btn(playerState.openLabel || "用 PowerPoint 打开", "sm ghost", () => {
      const a = window.itnWindow;
      if (a && typeof a.openPath === "function") {
        a.openPath(playerState.path).then((r) => { if (r && r.ok === false) toast(r.error); });
      } else {
        toast("用系统程序打开只在桌面应用窗口里可用");
      }
    }));
  }
  tools.appendChild(btn("关闭", "sm", () => closePlayer()));
  head.appendChild(tools);
  root.appendChild(head);
  root.classList.toggle("collapsed", !!playerState.collapsed);
  if (playerState.collapsed) return;   // 折叠 = 只留这一条，页面主体让出来

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
    const renderingGeneration = state.navigationGeneration;
    await loadCfg();
    if (renderingGeneration !== state.navigationGeneration) return;
    const v = $("view"); v.innerHTML = "";
    if (!hasKb()) {
      v.appendChild(cardOf({body: emptyState({art: "db", title: "把想学的资料放进来", text: "添加本机文件或文件夹，之后可以搜内容、读原文、按章节学习。支持 Markdown、文本与 CSV 等文本格式。", actions: [btn("添加资料", "primary", () => go("settings", "kb"))]})})); return;
    }
    const id = state.kb;
    const k = state.cfg.knowledgeBases.find(x => x.id === id) || {};
    const search = cardOf({cls: "library-search", title: "搜资料", sub: "输入问题或关键词，找到有出处的内容"});
    const row = el("div", "row");
    const q = el("input", "grow"); q.placeholder = "例如：这份资料如何解释智能体？"; q.setAttribute("aria-label", "搜索资料内容");
    const runButton = btn("搜索", "primary", () => run()); row.append(q, runButton); search.appendChild(row);
    const out = el("div", "library-results"); out.setAttribute("aria-live", "polite"); search.appendChild(out); v.appendChild(search);
    let searching = false;
    async function run() {
      if (searching) return;
      const query = q.value.trim(); if (!query) { q.focus(); return; }
      searching = true; runButton.disabled = true; out.setAttribute("aria-busy", "true"); out.textContent = "正在查找相关内容…";
      try {
        const d = await api("/api/kb/search", {id, query, topK: 6}); out.innerHTML = "";
        out.appendChild(el("p", "muted sm", d.hits.length ? "找到 " + d.hits.length + " 段相关内容" : "没有找到相关内容，试试原文中的关键词，或检查资料是否已准备。"));
        for (const h of d.hits) {
          const item = el("div", "item"); item.appendChild(el("h3", "item-title", h.docTitle || h.docPath));
          item.appendChild(el("p", "muted sm", h.headingPath || "资料正文"));
          const body = el("div", "hit-body"); body.textContent = (h.text || "").slice(0, 280) + ((h.text || "").length > 280 ? "…" : ""); item.appendChild(body);
          const acts = el("div", "row"); acts.append(btn("查看原文", "sm", e => preview(h.docPath, e.currentTarget)), btn("就这段提问", "sm ghost", () => askAboutChunk(h)), copyButton(() => h.text || "", "复制")); item.appendChild(acts); out.appendChild(item);
        }
      } catch(e) { out.textContent = "搜索失败：" + e.message + "。可以再次点击搜索重试。"; }
      finally { searching = false; runButton.disabled = false; out.removeAttribute("aria-busy"); }
    }
    q.onkeydown = e => { if (e.key === "Enter" && !e.isComposing) run(); };
    const toolbar = el("div", "library-toolbar"); toolbar.appendChild(el("h2", null, k.name || "我的资料")); toolbar.appendChild(spacer());
    const add = el("details", "library-add"); add.appendChild(el("summary", "btn", "+ 添加资料"));
    const options = el("div", "library-add-options"); options.append(btn("本机文件或文件夹", "ghost", () => go("settings", "kb")), btn("网页或 GitHub", "ghost", () => { harvest.open = true; harvest.scrollIntoView({block: "nearest"}); })); add.appendChild(options); toolbar.appendChild(add); v.appendChild(toolbar);
    const listCard = cardOf({cls: "library-documents"});
    const filters = el("div", "row");
    const filter = el("input", "grow"); filter.placeholder = "按文档名称筛选"; filter.setAttribute("aria-label", "筛选文档名称");
    const status = el("select"); status.setAttribute("aria-label", "筛选资料状态");
    for (const [value, text] of [["", "全部状态"], ["ready", "已准备"], ["pending", "待准备"], ["missing", "原文件已移走"], ["unknown", "来源暂不可读"]]) { const o = el("option", null, text); o.value = value; status.appendChild(o); }
    filters.append(filter, status); listCard.appendChild(filters);
    const count = el("p", "muted sm"); count.setAttribute("aria-live", "polite"); listCard.appendChild(count);
    const list = el("div", "list"); listCard.appendChild(list); v.appendChild(listCard);
    const previewHost = el("section", "library-preview"); v.appendChild(previewHost);
    let st = null;
    const labels = {ready: "已准备", pending: "待准备", missing: "原文件已移走", unknown: "来源暂不可读"};
    const paint = () => {
      list.innerHTML = "";
      const docs = st.docs || [], rows = docs.filter(d => ((d.title || "") + " " + d.path).toLocaleLowerCase().includes(filter.value.toLocaleLowerCase()) && (!status.value || d.status === status.value));
      count.textContent = "显示 " + rows.length + " / " + docs.length + " 篇资料";
      if (!rows.length) list.appendChild(el("p", "muted", docs.length ? "没有匹配的文档，换个名称或状态试试。" : "还没有可读的资料。添加支持的文本文件后，点击准备资料。"));
      for (const d of rows) {
        const item = el("div", "item library-document"); item.dataset.path = d.path; item.dataset.status = d.status; const ic = el("div", "file-icon"); ic.innerHTML = icon("file"); item.appendChild(ic);
        const main = el("div", "grow"); main.appendChild(el("h3", "item-title", d.title || d.path));
        const meta = [d.sizeBytes >= 0 ? fmtSize(d.sizeBytes) : "大小暂不可用", d.chunks + " 个内容片段"];
        main.appendChild(el("p", "meta", meta.join(" · "))); main.appendChild(el("p", "muted sm library-path", d.path)); item.appendChild(main);
        item.appendChild(tag(labels[d.status] || "已准备", d.status === "ready" ? "ok" : "warn"));
        const read = btn("看内容", "sm", e => preview(d.path, e.currentTarget)); read.disabled = !d.chunks; item.appendChild(read); list.appendChild(item);
      }
    };
    const load = async () => {
      list.textContent = "正在读取资料清单…";
      try { st = await api("/api/kb/stats", {id}); paint(); }
      catch(e) { list.innerHTML = ""; list.append(el("p", "muted", "清单读取失败：" + e.message), btn("重试", "sm", load)); }
    };
    filter.oninput = () => { if (st) paint(); }; status.onchange = () => { if (st) paint(); };
    let previewRequest = 0;
    async function preview(path, origin) {
      const request = ++previewRequest; previewHost.innerHTML = "";
      list.querySelectorAll(".library-document").forEach(node => node.classList.toggle("selected", node.dataset.path === path));
      const box = cardOf({title: "资料原文", cls: "document-preview"}); previewHost.appendChild(box);
      const close = btn("收起原文", "ghost sm", () => { ++previewRequest; previewHost.innerHTML = ""; origin?.focus(); }); box.querySelector(".card-head").appendChild(close);
      box.appendChild(el("p", "muted sm", "这里展示上次准备资料时保存的内容，按片段顺序排列。"));
      const content = el("div"); box.appendChild(content); const more = btn("加载更多", "sm", () => read()); box.appendChild(more);
      let offset = 0;
      async function read() {
        more.disabled = true; more.textContent = "正在读取…";
        try {
          const d = await api("/api/kb/document", {id, path, offset, limit: 12}); if (request !== previewRequest) return;
          box.querySelector("h2").textContent = d.title || "资料原文";
          for (const c of d.chunks) { const item = el("article", "preview-chunk"); item.appendChild(el("p", "muted sm", c.headingPath || "正文")); const body = el("div", "md"); body.innerHTML = md(c.text, {document:true,kbId:id,docPath:path}); item.appendChild(body); content.appendChild(item); hydrateKnowledgeImages(body); }
          offset = d.nextOffset; more.hidden = offset < 0; more.textContent = "加载更多"; more.title = "共 " + d.total + " 个片段";
        } catch(e) { if (request !== previewRequest) return; more.textContent = "读取失败，点击重试"; toast(e.message); }
        finally { more.disabled = false; }
      }
      if (origin?.dataset.autoPreview !== "true") close.focus();
      previewHost.scrollIntoView({block: "nearest"}); await read();
    }
    const harvest = el("details", "card harvest-entry"); harvest.appendChild(el("summary", "item-title", "从网页或 GitHub 收集资料"));
    const harvestBody = el("div"); harvest.appendChild(harvestBody); let harvestLoaded = false;
    harvest.ontoggle = async () => { if (harvest.open && !harvestLoaded) { harvestLoaded = true; await renderHarvest(harvestBody, true); } }; v.appendChild(harvest);
    const details = el("details", "card library-info"); details.appendChild(el("summary", null, "资料库信息与管理"));
    details.appendChild(el("p", "muted sm", "重新准备会扫描整个资料库，更新用于搜索的内容，原文件保留。AI 整理会生成章节目录与摘要。"));
    details.appendChild(el("p", "muted sm", state.cfg.embedModelId ? "已选择语义搜索模型，同时按关键词查找。" : "尚未选择语义搜索模型，目前按关键词查找。"));
    details.appendChild(el("p", "path-line muted sm", "本机位置：" + (k.sourcePath || k.rootDir || "未设置")));
    const acts = el("div", "row");
    const prepare = btn(k.chunkCount ? "重新准备资料" : "准备资料", "sm", async () => { prepare.disabled = true; try { const ok = await buildIndex(id); if (ok && current === "kb" && state.kb === id) await go("kb"); } finally { prepare.disabled = false; } });
    acts.append(prepare, btn("AI 整理资料", "sm", () => organizeKb(id)), btn("管理来源", "ghost sm", () => go("settings", "kb"))); details.appendChild(acts); v.appendChild(details);
    await load();
    if (st?.skippedTotal) listCard.appendChild(el("p", "skip-note", "另有 " + st.skippedTotal + " 个文件未能纳入：" + st.skippedSummary));
    if (st?.embedError) listCard.appendChild(el("p", "skip-note", "语义搜索暂不可用，关键词搜索仍可使用。原因：" + shortReason(st.embedError)));
    if (st && !(k.chunkCount > 0)) { details.open = true; }
  },
};

/* ---------- 伴学助手：会话栏 + 主对话框（对标 Codex 的形态） ---------- */

const KIND_LABEL = { ask: "问答", lecture: "讲义", quiz: "练习", "": "对话" };
/** 联网档位的中文名（三处界面共用一份，免得各写各的）。 */
const WEB_MODE_LABEL = { off: "不联网", auto: "自动判断", always: "优先联网" };

/**
 * 权限档位：就是 Lumin 的 permissions 三档。对话框左下角那枚 chip 与"设置 → 智能体"共用这一份文案。
 * 它与"联网开关"的关系：不再单独让用户选联不联网 —— 联网按档位走（ask 每次都问、auto 只对风险问、full 不问）。
 */
const PERM_LABEL = { ask: "请求批准", auto: "帮我批准", full: "完全访问权限" };
/* 菜单里的副标题：对齐 ChatGPT 那一版的长度，一行放得下，不换行 */
const PERM_HINT_SHORT = {
  ask: "编辑外部文件和使用互联网时始终询问",
  auto: "仅对检测到的风险操作请求批准",
  full: "可不受限制地访问文件和互联网",
};
/* 每一行自己的图标（和 ChatGPT 一样：手 / 盾 / 警告三角） */
const PERM_ICON = { ask: "hand", auto: "shield", full: "alert" };
const PERM_HINT = {
  ask: "编辑工作区外的文件、跑命令、联网时都先问你",
  auto: "只有检测到的风险操作才问（危险命令、写工作区外、联网）",
  full: "不再逐条问（仍然不把你自己在用的密钥交出去）",
};
/** 工具按用途分组（面板上分节显示；"本机文件"那几个只有指定了工作目录才会出现） */
const TOOL_GROUP = {
  kb_stage: "知识库", kb_ingest: "知识库",
  kb_search: "知识库", list_documents: "知识库", read_chunk: "知识库",
  web_search: "联网", web_fetch: "联网",
  save_note: "笔记与产物", save_artifact: "笔记与产物",
  current_time: "其他", calc: "其他", skill_read: "技能", synthesize_speech: "语音",
  read: "本机文件", write: "本机文件", edit: "本机文件", ls: "本机文件", find: "本机文件", grep: "本机文件", powershell: "本机文件",
};
const TOOL_GROUP_ORDER = ["知识库", "联网", "语音", "笔记与产物", "技能", "本机文件", "其他"];

const TOOL_LABEL = {
  kb_stage: "暂存知识资料", kb_ingest: "请求并入确认",
  kb_search: "检索知识库",
  read_session: "读取应用会话",
  web_search: "联网搜索",
  web_fetch: "读取网页",
  list_documents: "列出文档",
  read_chunk: "读取切片",
  current_time: "当前时间",
  calc: "计算",
  save_note: "写笔记",
  save_artifact: "写产物", synthesize_speech: "生成朗读音频",
  skill_read: "读技能说明",
  read_course_map: "读取导图", generate_course_map: "生成导图", publish_course_map: "切换导图",
  manage_course_node: "管理节点", list_course_resources: "节点资源", read_course_resource: "读取资源",
  manage_course_resource: "管理资源", get_course_progress: "学习进展", save_course_resource: "收录资源",
  cancel_course_map: "取消导图", list_course_history: "导图历史", attach_existing_course_resource: "关联资源",
  restore_course_library: "恢复知识库", record_knowledge_point: "记录知识点", read_knowledge_point: "读取知识点",
  get_learning_context: "学习上下文", remember_learning_fact: "记住偏好", forget_learning_fact: "删除记忆",
  read_learning_resource: "读取学习资源", generate_learning_resource: "生成学习资源", revise_learning_resource: "修改学习资源",
  search_personal_resources: "搜索个人内容", read_personal_resource: "读取个人内容", save_personal_resource: "保存个人内容",
  create_presentation: "制作演示", list_activity_tasks: "查看任务", cancel_activity_task: "停止任务",
  // pi 运行时的本机工具：工具卡标题直接显示这个名字，缺了就露出 read / powershell 这种英文
  read: "读文件", write: "写文件", edit: "改文件", ls: "列目录", find: "找文件",
  grep: "搜内容", powershell: "跑命令",
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
  await loadSessions(true);
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
  const title = el("div", "panel-item-title");
  title.appendChild(el("span", "panel-item-label", opt.title || ""));
  if (opt.busy) title.insertBefore(el("span", "spinner panel-item-spin"), title.firstChild);
  b.appendChild(title);
  if (opt.meta) b.appendChild(el("div", "panel-item-meta", opt.meta));
  b.onclick = opt.onClick;
  return b;
}

/** 每一段会话自己跑自己的：按会话记正在执行的轮次（同会话最多一轮，跨会话可以同时跑）。
 * 列表行转圈、删除保护、“Enter 是插话”都看这份状态，不再用一个全局布尔碰全部。 */
function isSessionRunning(sid) { return !!sid && state.chatRequests.has(sid); }
/** 用户一发出内容，先在本地把该会话推到组内首位；真实数据回来后由内核时间覆盖。 */
function markSessionActivity(sessionId, at) {
  if (!sessionId) return;
  const stamp = at || new Date().toISOString();
  let item = (state.sessions || []).find((x) => x.sessionId === sessionId);
  if (!item) {
    item = {
      sessionId,
      title: state.lastQuestion || "新对话",
      projectId: sessionId === state.chatSessionId ? (state.chatProject || "") : "",
      kind: "ask",
      lastAt: stamp,
      eventCount: 0,
    };
    state.sessions.unshift(item);
  } else {
    item.lastAt = stamp;
  }
}

/** 把"当前会话是否正在跑"同步到全局镜像：busyTurn/chatRequest 只代表当前会话。 */
function syncChatBusy() {
  state.chatRequest = state.chatRequests.get(state.chatSessionId) || null;
  state.busyTurn = !!state.chatRequest;
  const running = [...state.chatRequests.values()];
  if (running.length) {
    const currentPhase = state.chatRequest && state.chatRequest.phase;
    const phase = currentPhase || running.find((r) => r.phase)?.phase || "thinking";
    mascotActivity(phase, running.length);
  } else {
    mascotActivity("idle", 0);
  }
  if (typeof state.chatRepaintBusy === "function") state.chatRepaintBusy();
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
/* 上一次面板渲染的"数据指纹"与它属于哪块面板：内容没变就不重建 DOM
   （renderPanel 会被会话结束、切页、改设置等好几个地方调到）。 */
let panelSig = "";
let panelSigFor = "";

async function renderPanel(force) {
  const def = PANELS[current];
  const body = $("panel-body");
  const foot = $("panel-foot");
  if (!body || !foot) return;
  const key = current + "/" + (currentSection || "");
  /* 指纹必须在**取完数**之后算：否则外部新建的项目/会话还没进 state，
     指纹与上次一样 → 直接跳过渲染 → 侧栏里永远看不到它（踩过）。 */
  if (def && typeof def.load === "function") {
    try { await def.load(); } catch (e) { /* 取数失败就按现有 state 画 */ }
  }
  const sig = def && def.sig ? String(def.sig()) : "";
  // 数据没变、还是同一块面板：连 DOM 都不碰（这是"列表老闪一下"的正解）
  if (!force && sig && sig === panelSig && key === panelSigFor && body.childNodes.length) {
    // 结构没变、内容变了：给面板一次就地改字的机会（会话栏靠它做到"列表不闪"）
    if (def && def.refresh) def.refresh(body);
    installSplitters();
    return;
  }
  panelHead(def ? def.title : (PAGE_META[current] || {}).title, def && def.actions ? def.actions() : []);
  installSplitters();
  if (!def || !def.render) {
    body.innerHTML = "";
    foot.innerHTML = "";
    panelSig = sig;
    panelSigFor = key;
    return;
  }
  /* 渲染到**离屏片段**里，最后一次性换上去。
     以前是先 body.innerHTML = "" 再 await 数据，于是"空面板"要挂着一个来回，
     用户看到的就是闪一下；顺带把滚动位置与正在输入的搜索词也保住了。 */
  const renderingGeneration = state.navigationGeneration;
  const nextBody = document.createDocumentFragment();
  const nextFoot = document.createDocumentFragment();
  const scrollTop = body.scrollTop;
  const ui = { foot: (node) => nextFoot.appendChild(node) };
  await def.render(nextBody, ui);
  if (renderingGeneration !== state.navigationGeneration) return;
  body.replaceChildren(nextBody);
  foot.replaceChildren(nextFoot);
  body.scrollTop = scrollTop;
  panelSig = sig;
  panelSigFor = key;
}

/**
 * 会话栏的**结构**指纹：只有"有哪些行、怎么分组"变了才值得重建那一列。
 *
 * 标题、最后活动时间这类**内容**刻意不进指纹 —— 每跑完一轮都会重读会话列表，
 * 内容一旦进了指纹，用户看到的就是整列重建（"老是刷新，闪一下"）。
 * 内容变化走 PANELS.chat.refresh 就地改字，行与滚动位置都留着。
 * 顺序（内核按最后一条事件排）算结构：位置变了要重排。
 */
/** 会话行按最后活动时间倒序；时间相同用 id 稳定兜底。
 * 不能直接比较 ISO 字符串：内核可能返回 +08:00，前端即时活动时间则是 Z，
 * 同一时刻附近按字典序会把较旧的一条误判为更新。 */
function railSessionCompare(a, b) {
  const ta = Date.parse(a.lastAt || ""), tb = Date.parse(b.lastAt || "");
  const byTime = (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  return byTime || String(a.sessionId || "").localeCompare(String(b.sessionId || ""));
}
/** 只把“组内顺序”纳入结构指纹：时间文字变化仍走 refresh，顺序变了才重建。 */
function railSessionOrderSig(sessions) {
  const groups = new Map();
  for (const s of sessions || []) {
    const key = s.projectId || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([key, items]) => key + ":" + items.slice().sort(railSessionCompare).map((x) => x.sessionId).join(","))
    .join("|");
}
function chatRailSig() {
  const sessions = railSessionOrderSig(state.sessions || []);
  const projects = (state.projects || []).map((x) => x.id + (x.pinned ? "1" : "")).join(",");
  // 搜索过滤用的是标题：带着搜索词时标题也算结构（过滤结果会跟着变）
  const q = String(state.chatQuery || "").trim().toLowerCase();
  const titles = q ? (state.sessions || []).map((x) => String(x.title || "")).join("\u0001") : "";
  return JSON.stringify([sessions, projects, q, titles,
    JSON.stringify(state.railGroups || {}), JSON.stringify(state.railExpanded || {})]);
}

/** 会话行下面那行小字：类型 + 最后活动时间。渲染与就地刷新共用同一份拼法。 */
function railMetaOf(x) {
  return ((x.kind && x.kind !== "ask") ? (KIND_LABEL[x.kind] || "对话") + " · " : "") + fmtRailStamp(x.lastAt);
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
        onClick: () => openWrong(),
      }));
    }
    if (r.readChunks || r.completedChapters) {
      body.appendChild(panelItem({
        title: "已读 " + (r.readChunks || 0) + " 片 · 完成 " + (r.completedChapters || 0) + " 章",
        meta: "去「学 · 练」接着读",
        onClick: () => go("learn"),
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
    ui.foot(btn("去个性化资源", "sm", () => go("resources")));
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

/* ---------- 我的资源（笔记 + 错题本）：第二层面板 ---------- */
PANELS.notes = {
  title: "我的资源",
  actions: () => [panelBtn("plus", "写一条笔记", () => openNoteEditor(null, state.kb, state.chapter || ""))],
  async render(body, ui) {
    await loadCfg();
    const tab = ["wrong", "network"].includes(state.resTab) ? state.resTab : "notes";
    let notes = [];
    let wrongs = [];
    try { notes = (await api("/api/study/notes/list", {})).notes || []; } catch (e) { notes = []; }
    try { wrongs = (await api("/api/study/wrong", {})).records || []; } catch (e) { wrongs = []; }
    const due = wrongs.filter((r) => r.due);
    body.appendChild(panelSeg([
      { key: "notes", label: "笔记 " + notes.length },
      { key: "wrong", label: "错题本 " + wrongs.length },
      { key: "network", label: "网络资料" },
    ], tab, (k) => {
      if (k === "network") { state.resTab = "network"; go("notes"); }
      else if (k === "wrong") openWrong();
      else openNotes();
    }));

    if (tab === "network") {
      body.appendChild(panelEmpty("收集的网页与仓库先暂存，检查后才并入知识库。"));
      ui.foot(btn("去领域知识库", "sm", () => go("knowledge")));
      return;
    }
    if (tab === "notes") {
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
          onClick: () => openNotes({ focus: n.id }),
        }));
      }
      return;
    }

    if (!wrongs.length) {
      body.appendChild(panelEmpty("还没有错题。答题答错会自动进来，并按间隔安排复习。"));
      ui.foot(btn("去做一组练习", "primary sm", () => go("learn")));
      return;
    }
    const mastered = wrongs.filter((r) => r.mastered);
    const wtab = state.wrongTab || "due";
    const pool = wtab === "due" ? due : wtab === "mastered" ? mastered : wrongs;
    body.appendChild(panelSeg([
      { key: "due", label: "待复习 " + due.length },
      { key: "mastered", label: "已掌握 " + mastered.length },
      { key: "all", label: "全部 " + wrongs.length },
    ], wtab, (k) => { state.wrongTab = k; openWrong(); }));
    if (!pool.length) {
      body.appendChild(panelEmpty("这个分类下是空的。"));
      return;
    }
    for (const r of pool) {
      body.appendChild(panelItem({
        id: r.id,
        title: r.question || "（题干缺失）",
        meta: (r.chapter ? r.chapter + " · " : "") + (r.mastered ? "已掌握" : r.due ? "今天该重做" : r.dueMs ? daysUntil(r.dueMs) + " 天后复习" : ""),
        onClick: () => openWrong({ focus: r.id }),
      }));
    }
    if (due.length) ui.foot(btn("开始复习（" + due.length + " 条）", "primary sm", () => openRedo(due[0])));
  },
};

/* ---------- 我的成长（含就地校准）：第二层面板 ---------- */
PANELS.report = {
  title: "我的成长",
  async render(body, ui) {
    await loadOverview();
    await loadProfile();
    const r = state.report || {};
    body.appendChild(panelGroup("概览"));
    const rows = [
      ["学完小节", r.completedSections || 0],
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
    if ((r.wrongDue || 0) > 0) {
      body.appendChild(panelItem({
        title: "今天该复习 " + r.wrongDue + " 条错题",
        meta: "在「我的资源 → 错题本」里重做",
        onClick: () => openWrong(),
      }));
    }
    const scores = (state.profile || {}).selfScores || {};
    body.appendChild(panelGroup("能力维度（自评）"));
    for (const d of ABILITY_DIMENSIONS) {
      const idx = state.calib ? state.calib[d.key] : undefined;
      body.appendChild(panelItem({
        id: d.key,
        title: d.key,
        meta: idx !== undefined
          ? "这次校准选到 " + ABILITY_LEVELS[idx].value + " 分"
          : (scores[d.key] === undefined ? "未填" : scores[d.key] + " 分"),
        onClick: () => openCalibration(d.key),
      }));
    }
    ui.foot(btn("校准我的能力", "sm primary", () => openCalibration()));
  },
};

// 老的深链（#/calibrate）落到同一个面板上
PANELS.calibrate = PANELS.report;

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
  title: "资料库",
  actions: () => [panelBtn("plus", "添加资料库", () => go("settings", "kb"))],
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
          : "资料待准备",
        onClick: () => {
          if (state.kb === k.id) return;
          state.kb = k.id;
          toast("已切到「" + (k.name || k.id) + "」");
          go("kb");
        },
      }));
    }
    ui.foot(btn("管理资料来源", "sm", () => go("settings", "kb")));
  },
};

/* ---------- 伴学助手：会话列表 ---------- */
PANELS.chat = {
  title: "对话",
  sig: () => chatRailSig(),
  load: async () => { await Promise.all([loadSessions(), loadProjects()]); },
  /**
   * 结构没变、只有内容变了（标题被模型起好了 / 这一轮跑完时间刷新了 / 换了一段会话）：
   * 就地改每一行的字与高亮，不重建行 —— 这就是"列表不再闪一下"的地方。
   */
  refresh(body) {
    const host = body || $("panel-body");
    if (!host) return;
    for (const row of host.querySelectorAll(".panel-item-row.rail-session")) {
      const item = row.querySelector(".panel-item");
      if (!item || !item.dataset) continue;
      const sid = item.dataset.id || "";
      const x = (state.sessions || []).find((y) => y.sessionId === sid);
      if (x) {
        const titleEl = item.querySelector(".panel-item-label");
        const title = x.title || "新对话";
        if (titleEl && titleEl.textContent !== title) titleEl.textContent = title;
        const metaEl = item.querySelector(".panel-item-meta");
        const meta = railMetaOf(x);
        if (metaEl && metaEl.textContent !== meta) metaEl.textContent = meta;
      }
      /* 转圈是就地开关，不进结构指纹：跑起来的会话不该让整列重建。 */
      const titleBox = item.querySelector(".panel-item-title");
      const busy = isSessionRunning(sid);
      const spin = titleBox ? titleBox.querySelector(".panel-item-spin") : null;
      if (busy && titleBox && !spin) titleBox.insertBefore(el("span", "spinner panel-item-spin"), titleBox.firstChild);
      else if (!busy && spin) spin.remove();
      item.classList.toggle("active", sid === state.chatSessionId);
    }
  },
  // ＋ ＝ 新建对话：点它选"常规聊天"还是某个项目的 Work（见 newChatMenu）
  actions: () => [
    panelBtn("plus", "新建对话", () => newChatMenu($("rail-new")), "rail-new"),
    panelBtn("search", "全部会话", () => go("chat", "overview"), "rail-all"),
  ],
  async render(body, ui) {
    await loadCfg();

    /* 会话栏的骨架照 Codex：项目是一行可折叠的标题（文件夹 + 名字 + 计数，悬停时右侧
       出现 ⋯ 与"新建会话"），会话缩进列在它下面；没挂项目的会话归到"普通对话"。
       "新建对话"只有一处入口 —— 右上角那个 ＋。 */
    const search = inputOf("rail-search", "搜索会话", state.chatQuery || "");
    search.className = "panel-search";
    body.appendChild(search);
    const results = el('div','rail-search-results'); results.hidden = true; body.appendChild(results);
    let searchTimer = null, searchSeq = 0;
    const updateSearch = async () => {
      const query = search.value.trim(), seq = ++searchSeq;
      state.chatQuery = search.value;
      for (const child of body.children) if (child !== search && child !== results) child.hidden = !!query;
      results.hidden = !query;
      if (!query) { results.replaceChildren(); return; }
      results.textContent = '正在搜索对话内容…';
      try {
        const data = await api('/api/sessions/search',{query,limit:50});
        if (seq !== searchSeq || !search.isConnected || query !== search.value.trim()) return;
        results.replaceChildren();
        for (const hit of data.hits || []) {
          const row = btn('', 'panel-item search-result', () => revealChatHit(hit).catch(e=>toast(e.message)));
          row.append(el('strong','panel-item-title',hit.title || '新对话'),el('span','search-result-snippet',hit.snippet));
          results.appendChild(row);
        }
        if (!results.children.length) results.appendChild(panelEmpty('没有匹配的对话内容。'));
      } catch(e) { if (seq === searchSeq) results.textContent = '搜索失败：'+e.message; }
    };
    search.oninput = () => { ++searchSeq; state.chatQuery = search.value; clearTimeout(searchTimer); searchTimer=setTimeout(updateSearch,220); };
    if (search.value.trim()) setTimeout(updateSearch,0);

    const q = '';
    const items = state.sessions.filter((x) => !q || String(x.title || "").toLowerCase().indexOf(q) >= 0);
    if (!items.length) {
      body.appendChild(panelEmpty(state.sessions.length ? "没有匹配的会话。" : "还没有对话。点右上角 ＋ 开一段。"));
      return;
    }

    /* 分组键："" ＝ 普通对话（没挂项目，工作目录就是默认目录），其余是项目 id。
       置顶的项目排最前，普通对话固定排最后 —— 它最常开，也最不需要找。 */
    const groups = new Map();
    for (const x of items) {
      const key = x.projectId || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(x);
    }
    const orderedProjects = (state.projects || []).slice()
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    const order = [];
    /* 所有项目都列出来，哪怕它一段会话都还没有 —— 否则新建的项目在侧栏里看不见，
       用户根本没法从它那里开第一段 Work 会话（用户实测：新建项目后找不到它）。
       搜索时则只留有命中的：空标题挂在搜索结果里是噪音。 */
    for (const pr of orderedProjects) {
      if (!q || groups.has(pr.id)) order.push(pr.id);
    }
    for (const k of groups.keys()) if (k !== "" && order.indexOf(k) < 0) order.push(k);
    if (groups.has("")) order.push("");

    const RAIL_OPEN_DEFAULT = 6;
    for (const key of order) {
      const mine = groups.get(key) || [];
      const project = key ? (state.projects || []).find((x) => x.id === key) : null;
      const name = key ? (project ? (project.name || project.root) : "已删除的项目") : "普通对话";
      const collapsed = !!state.railGroups[key];

      const head = el("div", "rail-group-head" + (collapsed ? " collapsed" : ""));
      head.dataset.group = key;
      const nameBtn = el("button", "rail-group-name", "");
      nameBtn.type = "button";
      nameBtn.title = project ? project.root : "没挂项目的对话（工作目录 = 默认目录）";
      nameBtn.innerHTML =
        '<span class="rail-group-chev">' + icon("chevron") + "</span>" +
        '<span class="rail-group-icon">' + icon(project ? "folder" : "chat") + "</span>" +
        "<span class='rail-group-text'>" + esc(name) + "</span>" +
        (mine.length ? "<span class='rail-group-count'>" + mine.length + "</span>" : "");
      nameBtn.onclick = () => { state.railGroups[key] = !collapsed; renderPanel(); };
      head.appendChild(nameBtn);
      if (key) {
        const acts = el("span", "rail-group-actions");
        acts.appendChild(projectMenu(project, key));
        if (project) {
          const add = el("button", "rail-group-btn", "");
          add.type = "button";
          add.title = "在「" + name + "」里开新会话";
          add.setAttribute("aria-label", "新建会话");
          add.innerHTML = icon("compose");
          add.onclick = (ev) => { ev.stopPropagation(); newChat(key, "work"); };
          acts.appendChild(add);
        }
        head.appendChild(acts);
      }
      body.appendChild(head);
      if (collapsed) continue;

      const sorted = mine.slice()
        .sort(railSessionCompare);
      const expanded = !!state.railExpanded[key];
      const shown = expanded ? sorted : sorted.slice(0, RAIL_OPEN_DEFAULT);
      for (const x of shown) {
        const rowEl = el("div", "panel-item-row rail-session");
        rowEl.appendChild(panelItem({
          id: x.sessionId,
          active: x.sessionId === state.chatSessionId,
          busy: isSessionRunning(x.sessionId),
          title: x.title || "新对话",
          meta: railMetaOf(x),
          onClick: () => openChatSession(x.sessionId),
        }));
        rowEl.appendChild(sessionRowMenu(x, rowEl));
        body.appendChild(rowEl);
      }
      if (sorted.length > RAIL_OPEN_DEFAULT) {
        const more = el("button", "rail-more", expanded
          ? "收起"
          : "展开显示（还有 " + (sorted.length - RAIL_OPEN_DEFAULT) + " 段）");
        more.type = "button";
        more.onclick = () => { state.railExpanded[key] = !expanded; renderPanel(); };
        body.appendChild(more);
      }
    }
  },
};

/**
 * 项目行的 ⋯ 菜单：置顶 / 编辑 / 在资源管理器中打开 / 移除项目。
 *
 * 只放引擎真的做得到的几件事（分区、归档这些还没有对应能力，先不摆出来当摆设）。
 */
function projectMenu(project, key) {
  const wrap = el("span", "rail-group-actions-slot");
  const trigger = el("button", "rail-group-btn", "");
  trigger.type = "button";
  trigger.title = "项目操作";
  trigger.setAttribute("aria-label", "项目操作");
  trigger.innerHTML = icon("dots");
  const item = (label, ic, cls, fn) => {
    /* 别漏 rail-menu-item：图标尺寸、行高、hover 全在这个类里（漏了就会出现巨型图标） */
    const b = el("button", "rail-menu-item" + (cls ? " " + cls : ""), "");
    b.type = "button";
    b.innerHTML = icon(ic || "chevron") + '<span class="rail-menu-main">' + esc(label) + "</span>";
    b.onclick = (ev) => { ev.stopPropagation(); closePopover(); fn(); };
    return b;
  };
  trigger.onclick = (ev) => {
    ev.stopPropagation();
    popoverAt(trigger, (menu) => {
    if (project) {
      const head = el("div", "rail-menu-head");
      head.innerHTML = icon("folder") + "<span>" + esc(project.name || project.root) + "</span>" +
        (project.pinned ? '<span class="rail-menu-pin">' + icon("pin") + "</span>" : "");
      menu.appendChild(head);
      menu.appendChild(el("div", "rail-menu-sub", project.root));
      menu.appendChild(item(project.pinned ? "取消置顶" : "置顶", "pin", "", async () => {
        try {
          await api("/api/projects/pin", { id: project.id, pinned: project.pinned ? "0" : "1" });
          await loadProjects();
          renderPanel();
          toast(project.pinned ? "已取消置顶" : "已置顶");
        } catch (e) { toast("失败：" + e.message); }
      }));
      menu.appendChild(item("编辑项目…", "gear", "", () => editProjectDialog(project)));
      menu.appendChild(item("在资源管理器中打开", "folder", "", () => {
        const a = window.itnWindow;
        if (a && typeof a.openPath === "function") a.openPath(project.root);
        else toast("打开文件夹只在桌面应用窗口里可用");
      }));
      menu.appendChild(el("div", "rail-menu-sep"));
      menu.appendChild(item("移除项目", "close", "danger", async () => {
        if (!window.confirm("移除项目「" + (project.name || project.root) + "」？\n\n只把它从列表里拿掉，对话与文件都不动 —— 那些对话会回到「普通对话」。")) return;
        try {
          await api("/api/projects/delete", { id: project.id });
          await loadProjects();
          await reloadSessions();
          renderPanel();
          toast("已移除项目");
        } catch (e) { toast("失败：" + e.message); }
      }));
    }
    }, { side: "panel", cls: "project-menu" });
  };
  wrap.appendChild(trigger);
  return wrap;
}

/** 编辑项目：改名（文件夹不动；改工作目录是另一件事）。 */
function editProjectDialog(project) {
  const v = $("view");
  const dlg = el("div", "card dialog");
  dlg.appendChild(cardHeadOnly("编辑项目"));
  const input = inputOf("project-name", "项目名字", project.name || "");
  dlg.appendChild(fieldOf("名字", input));
  dlg.appendChild(el("p", "muted sm", "文件夹不变：" + project.root));
  const row = el("div", "row");
  row.appendChild(btn("保存", "primary", async () => {
    const next = input.value.trim();
    if (!next) { toast("名字不能为空"); return; }
    try {
      await api("/api/projects/save", { id: project.id, name: next, root: project.root });
      dlg.remove();
      await loadProjects();
      renderPanel();
      toast("已改名");
    } catch (e) { toast("失败：" + e.message); }
  }));
  row.appendChild(btn("取消", "ghost", () => dlg.remove()));
  dlg.appendChild(row);
  v.insertBefore(dlg, v.firstChild);
  dlg.scrollIntoView({ block: "start" });
}

/**
 * 右上角 ＋ 的菜单：常规聊天 / 某个项目的 Work / 新建项目。
 *
 * 两种模式的差别只有"工作目录"和"能写哪儿"，所以把这两句写在选项下面 ——
 * 用户点之前就该知道它能碰自己哪些文件。
 */
function newChatMenu(anchor) {
  if (!anchor) return;
  const menu = popoverAt(anchor, (menu) => { buildNewChatMenu(menu); }, { side: "panel", cls: "new-menu" });
  return menu;
}

function buildNewChatMenu(menu) {
  const pick = (projectId, mode) => { closePopover(); newChat(projectId, mode); };

  menu.appendChild(el("div", "rail-menu-title", "新建对话"));

  const reg = el("button", "rail-menu-item", "");
  reg.type = "button";
  reg.innerHTML = icon("chat") + "<span class='rail-menu-main'>常规聊天</span>" +
    "<span class='rail-menu-note'>整机只读 · 只对默认工作目录可写</span>";
  reg.onclick = () => pick("", "chat");
  menu.appendChild(reg);

  const projects = state.projects || [];
  if (projects.length) {
    menu.appendChild(el("div", "rail-menu-sep"));
    menu.appendChild(el("div", "rail-menu-title", "指定工作区"));
    for (const pr of projects) {
      const b = el("button", "rail-menu-item", "");
      b.type = "button";
      b.innerHTML = icon("folder") + "<span class='rail-menu-main'>" + esc(pr.name || pr.root) + "</span>" +
        "<span class='rail-menu-note'>" + esc(pr.root) + "</span>";
      b.onclick = () => pick(pr.id, "work");
      menu.appendChild(b);
    }
  }

  menu.appendChild(el("div", "rail-menu-sep"));
  const mk = el("button", "rail-menu-item", "");
  mk.type = "button";
  mk.innerHTML = icon("plus") + "<span class='rail-menu-main'>新建项目…</span>" +
    "<span class='rail-menu-note'>选一个本机文件夹</span>";
  mk.onclick = async () => {
    closePopover();
    const a = window.itnWindow;
    if (!a || typeof a.pickDirectory !== "function") {
      toast("选文件夹只在桌面应用窗口里可用");
      return;
    }
    const dir = await a.pickDirectory();
    if (!dir) return;
    try {
      const project = await api("/api/projects/save", { root: dir });
      await loadProjects();
      await newChat(project.id, "work");
      toast("新项目 · " + (project.name || project.root));
    } catch (e) {
      toast("新建项目失败：" + e.message);
    }
  };
  menu.appendChild(mk);
}

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
  // 归属哪个项目跟着会话走；检索范围始终是全部知识库
  state.chatProject = meta ? (meta.projectId || "") : "";
  state.chatMode = state.chatProject ? "work" : "chat";
  state.chatKb = "";
  state.chatSessionId = id;
  // 已经在对话页：就地换这一段，不整页重建 —— 原来点一下就闪一次"加载中…"
  if (current === "chat" && currentSection !== "overview" && typeof state.chatOpenSession === "function") {
    await state.chatOpenSession(id);
    if (typeof refreshChatHeader === "function") refreshChatHeader();
    return;
  }
  await go("chat");
}

/**
 * 会话行的"⋯"菜单：重命名 / 删除 —— 会话多了总得管起来（Codex 的列表也是这么做的）。
 *
 * 只动这一段对话自己的记录：知识库、笔记、错题、产物都不是它的数据，不跟着动。
 */
async function revealChatHit(hit) {
  if (hit.turnId) await api('/api/sessions/reveal', {sessionId:hit.sessionId, turnId:hit.turnId});
  await openChatSession(hit.sessionId);
  if (!hit.turnId) return;
  const node = [...document.querySelectorAll('.turn-block')].find(n => n.dataset.turnId === hit.turnId);
  if (!node) throw Error('对话已打开，但这条记录暂时无法定位');
  state.stickBottom = false;
  requestAnimationFrame(() => { node.scrollIntoView({block:'center',behavior:'instant'}); node.classList.add('search-focus'); });
  setTimeout(() => node.classList.remove('search-focus'), 4000);
}

async function openLibraryHit(hit) {
  await go('kb');
  if (typeof revealLibrarySearchHit === 'function') await revealLibrarySearchHit(hit);
}

function sessionRowMenu(s, rowEl) {
  const wrap = el("span", "panel-item-actions");
  const trigger = el("button", "panel-item-more", "");
  trigger.type = "button";
  trigger.title = "更多操作";
  trigger.setAttribute("aria-label", "更多操作");
  trigger.innerHTML = icon("dots");
  const item = (label, cls, fn) => {
    const b = el("button", cls || "", label);
    b.type = "button";
    b.onclick = (ev) => { ev.stopPropagation(); closePopover(); fn(); };
    return b;
  };
  trigger.onclick = (ev) => {
    ev.stopPropagation();
    popoverAt(trigger, (menu) => {
      menu.appendChild(item("重命名…", "", () => renameSessionDialog(s)));
      menu.appendChild(item("移到项目…", "", () => moveSessionDialog(s)));
      menu.appendChild(item("删除…", "danger", () => deleteSessionDialog(s)));
    }, { cls: "session-menu" });
  };
  wrap.appendChild(trigger);
  return wrap;
}

/** 把一段已有对话挪到另一个项目（或挪回未归档）。 */
function moveSessionDialog(s) {
  if (!(state.projects || []).length) {
    toast("还没有项目：先在「新建对话」里点「新建项目…」");
    return;
  }
  const v = $("view");
  const dlg = el("div", "card dialog");
  dlg.appendChild(cardHeadOnly("移到项目"));
  const sel = el("select");
  const none = el("option", null, "未归档（不属于任何项目）");
  none.value = "";
  sel.appendChild(none);
  for (const p of state.projects) {
    const o = el("option", null, p.name || p.root);
    o.value = p.id;
    sel.appendChild(o);
  }
  sel.value = s.projectId || "";
  dlg.appendChild(fieldOf("项目", sel));
  const row = el("div", "row");
  row.appendChild(btn("保存", "primary", async () => {
    try {
      await api("/api/sessions/bind", { sessionId: s.sessionId, projectId: sel.value });
      dlg.remove();
      await reloadSessions();
      toast(sel.value ? ("已归到 " + projectName(sel.value)) : "已移回未归档");
    } catch (e) { toast("失败：" + e.message); }
  }));
  row.appendChild(btn("取消", "ghost", () => dlg.remove()));
  dlg.appendChild(row);
  v.insertBefore(dlg, v.firstChild);
  dlg.scrollIntoView({ block: "start" });
}

/** 重命名会话：只改列表里的名字，事件与内容一条不动。 */
function renameSessionDialog(s) {
  const v = $("view");
  const dlg = el("div", "card dialog");
  dlg.appendChild(cardHeadOnly("重命名会话"));
  const input = inputOf("session-rename-input", "新的名字", s.title || "新对话");
  dlg.appendChild(fieldOf("名字", input));
  const row = el("div", "row");
  const submit = async () => {
    const next = input.value.trim();
    if (!next) { toast("名字不能为空"); return; }
    try {
      await api("/api/sessions/rename", { sessionId: s.sessionId, title: next });
      dlg.remove();
      await reloadSessions();
      toast("已重命名");
    } catch (e) { toast("重命名失败：" + e.message); }
  };
  row.appendChild(btn("保存", "primary", submit));
  row.appendChild(btn("取消", "ghost", () => dlg.remove()));
  dlg.appendChild(row);
  v.insertBefore(dlg, v.firstChild);
  dlg.scrollIntoView({ block: "start" });
  input.focus();
  input.select();
  input.onkeydown = (e) => { if (e.key === "Enter") submit(); };
}

/** 删除会话：删掉这段对话自己的记录，删前说清"别的东西都不动"。 */
function deleteSessionDialog(s) {
  if (isSessionRunning(s.sessionId)) {
    toast("这段会话正在跑，先停止或等它跑完");
    return;
  }
  const v = $("view");
  const dlg = el("div", "card dialog");
  dlg.appendChild(cardHeadOnly("删除这段会话？"));
  dlg.appendChild(el("p", "muted", "只删这一段对话的记录（" + (s.eventCount || 0) +
    " 条事件）；知识库、笔记、错题、产物都不动。"));
  const row = el("div", "row");
  row.appendChild(btn("删除", "primary danger", async () => {
    try {
      await api("/api/sessions/delete", { sessionId: s.sessionId });
      dlg.remove();
      if (state.chatSessionId === s.sessionId) {
        // 删的正是现在打开的这一段：清空并回到新会话空态
        state.chatSessionId = "";
        state.chatTurns = [];
        state.chatEvents = [];
        await reloadSessions();
        await go("chat");
      } else {
        await reloadSessions();
      }
      toast("已删除");
    } catch (e) { toast("删除失败：" + e.message); }
  }));
  row.appendChild(btn("取消", "ghost", () => dlg.remove()));
  dlg.appendChild(row);
  v.insertBefore(dlg, v.firstChild);
  dlg.scrollIntoView({ block: "start" });
}

/**
 * 新建一段对话。
 *
 * kbId 必须由用户给（""=通用：本机所有知识库都能检索）——"这段对话用哪份资料"是开工前就该定的事，
 * 让它猜或者事后切库，都会把两边的资料混进同一段对话里。
 */
async function newChat(projectId, mode) {
  try {
    // 新对话只选模式与项目；检索范围不再按知识库切分 —— 永远是本机全部知识库。
    // mode: "chat" = 常规聊天（只写默认工作目录）/ "work" = 指定工作区（权限由 chip 定）
    const d = await api("/api/sessions/new", { projectId: projectId || "" });
    state.chatProject = d.projectId || "";
    state.chatMode = (mode === "work" || (d.projectId || "")) ? "work" : "chat";
    state.chatKb = "";
    state.chatSessionId = d.sessionId;
    state.chatEvents = [];
    state.lastEventId = 0;
    state.chatTurns = [];
    if (current === "chat" && currentSection !== "overview" && typeof state.chatOpenSession === "function") {
      await state.chatOpenSession(state.chatSessionId);
      return;
    }
    go("chat");
  } catch (e) {
    toast("新建会话失败：" + e.message);
  }
}

/** 把只追加的事件还原成可渲染的轮次。界面永远以事件为准，不自己编对话。 */
/**
 * 把只追加的事件还原成"一段对话"。
 *
 * 形状照 Codex：**一条时间线**，用户的话、模型的每一段正文、每一次工具调用按发生顺序排开。
 * 刻意没有"第 1 步：检索"这种东西 —— 这是 agent，先检索还是先问、要不要检索，都由模型自己决定；
 * 那套固定步骤是上一版网页工作流留下的，已经删掉（也删掉了内核里写死的那两条 step 事件）。
 */
function turnsFromEvents(events) {
  const turns = [];
  const byKey = {};
  for (const e of events) {
    const key = e.turnId || "—";
    if (!byKey[key]) {
      byKey[key] = { id: key, kind: "", user: "", items: [], report: null, citations: [], ok: null, message: "", webMode: "" };
      turns.push(byKey[key]);
    }
    const t = byKey[key];
    const p = e.payload || {};
    if (e.type === "turn/start") { t.kind = p.kind || ""; t.startedAt = e.at; }
    else if (e.type === "turn/usage") { t.usageIn = Number(p["in"] || 0); t.usageOut = Number(p.out || 0); }
    else if (e.type === "assistant/activity") { t.activity = p.phase || ""; t.activityTool=p.tool || ''; t.toolInputBytes=Number(p.receivedBytes || 0); }
    else if (e.type === 'model/retry') t.activity='retrying';
    else if(e.type==='model/request')t.activity='waiting';
    else if (e.type === "assistant/thinking") t.items.push({ t: "think", text: p.text || "", ms: p.ms || 0 });
    else if (e.type === "user/message") { t.user = p.text || ""; t.attachments = p.attachments || []; t.userAt = e.at; }
    else if (e.type === "assistant/delta") {
      t.activity="responding";
      const last = t.items[t.items.length - 1];
      if (last && last.t === "a") last.text += (p.text || "");
      else t.items.push({ t: "a", text: p.text || "", streaming: true });
    } else if (e.type === "assistant/message") {
      t.answerAt = e.at;
      const last = t.items[t.items.length - 1];
      if (last && last.t === "a") {
        // 增量与整段是同一段话：以整段为准（流式可能在收尾处少几个字）
        last.text = p.text || last.text;
        last.streaming = false;
      } else {
        t.items.push({ t: "a", text: p.text || "", streaming: false });
      }
    } else if (e.type === "tool/call") {
      t.items.push({ t: "tool", callId: p.callId || "", name: p.tool || "", args: p.args || {}, summary: "", ok: null, running: true });
    } else if (e.type === "tool/result") {
      // 写/改文件的工具会带回 {path, add, del}：攒成"这一轮改了哪些文件"（pi-studio 也有这张卡）
      const det = p.details;
      if (p.ok && (p.tool === "write" || p.tool === "edit") && det && det.path) {
        t.fileChanges = t.fileChanges || [];
        const hit = t.fileChanges.find((x) => x.path === det.path);
        if (hit) {
          hit.add = Math.max(hit.add || 0, Number(det.add || 0));
          hit.del = Math.max(hit.del || 0, Number(det.del || 0));
          hit.created = !!(hit.created || det.created);
          if (det.draftId) hit.draftId = String(det.draftId);
        } else {
          t.fileChanges.push({ path: String(det.path), absPath:String(det.absPath || ''), add: Number(det.add || 0), del: Number(det.del || 0),
                               created: !!det.created, draftId: det.draftId ? String(det.draftId) : "" });
        }
      }
      let target = null;
      for (let i = t.items.length - 1; i >= 0; i--) {
        const x = t.items[i];
        if (x.t === "tool" && x.running && (p.callId ? x.callId === p.callId : x.name === (p.tool || ""))) { target = x; break; }
      }
      if (target) {
        target.summary = p.summary || "";
        target.ok = p.ok !== false;
        target.running = false;
      }
    } else if(e.type==="knowledge/recorded"){
      t.items.push({t:"knowledge",point:p});
    } else if (e.type === "artifact/created") {
      t.items.push({t:"file",artifact:p});
    } else if (e.type === "resource/saved") {
      t.items.push({t: "resource", resource: p});
    } else if (e.type === "resource/progress") {
      t.resourceProgress = p;
    } else if (e.type === "web/policy") {
      t.webMode = p.mode || "";
    } else if (e.type === "validation") {
      t.report = p.report || null;
      t.citations = p.citations || [];
    } else if (e.type === "turn/end") {
      t.ok = p.ok !== false;
      t.message = p.message || "";
    }
  }
  // 收尾：还挂在 running 上的工具说明这一轮没跑完（取消/出错）
  for (const t of turns) {
    for (const it of t.items) {
      if (it.t === "tool" && it.running && t.ok === false) {
        it.running = false;
        it.ok = false;
        if (!it.summary) it.summary = "未完成";
      }
    }
  }
  return turns;
}

/** 一轮里的一段正文（Codex 里就是一条 assistant 消息，没有气泡与"谁说的"标签）。 */
function assistantBlock(text, live) {
  const a = el("div", "msg msg-ai");
  const b = el("div", "msg-body");
  b.innerHTML = md(text);
  if (live) markStreamTail(b);
  a.appendChild(b);
  return a;
}

/* 流式输出只让最后一段正文呼吸。动画相位跟全局时钟走，重建当前轮次时不会每次从 0 重播。 */
const STREAM_BREATH_MS = 2800;
function latestStreamBlock(host) {
  const root = host.querySelector(".md") || host;
  const last = root.children.length ? root.children[root.children.length - 1] : null;
  if (!last) return null;
  if (last.matches("ul, ol")) return last.lastElementChild;
  if (last.matches(".md-table-wrap")) {
    return last.querySelector("tbody tr:last-child td:last-child") ||
      last.querySelector("thead th:last-child");
  }
  return last.matches("p, h1, h2, h3, h4, h5, h6, blockquote, pre") ? last : null;
}

function markStreamTail(host) {
  const target = latestStreamBlock(host);
  if (!target || !target.textContent.trim()) return;
  target.classList.add("stream-line");
  const phase = Math.round(performance.now() % STREAM_BREATH_MS);
  target.style.setProperty("--stream-delay", "-" + phase + "ms");
}

/** 工具调用：一行，左边一个点（跑着时是转圈），右边一行摘要。点一下展开参数。 */
/**
 * 工具调用：一张可折叠的卡。
 *
 * 折起来只看"做了什么 + 成没成"，展开看传入参数与返回结果 —— 工具调用是过程，
 * 不该把正文挤没；但用户想核对时，又能一眼看到实际传了什么、拿回了什么。
 */
function toolCard(tool, live) {
  const state2 = tool.running ? "执行中" : (tool.ok === false ? "失败" : "完成");
  const d = el("details", "tool-card" + (tool.running ? " running" : (tool.ok === false ? " failed" : "")));
  const sum = el("summary", "tool-head");
  sum.innerHTML =
    '<span class="tool-icon">' + (tool.running ? '<span class="spinner"></span>' : icon("gear")) + "</span>" +
    '<span class="tool-title">' + esc(toolLabel(tool)) + "</span>" +
    '<span class="tool-state">' + esc(state2) + "</span>" +
    '<span class="tool-chev">' + icon("chevron") + "</span>";
  /* 这个调用**自己**结束就折起来，不等整轮回复完 ——
     跑着的时候展开（能看见它在干什么），一旦完成就收起。 */
  if (tool.running) d.open = true;
  d.appendChild(sum);
  const body = el("div", "tool-body");
  if (tool.args && Object.keys(tool.args).length) {
    body.appendChild(el("div", "tool-sub", "传入参数"));
    body.appendChild(el("pre", "tool-args", JSON.stringify(tool.args, null, 2)));
  }
  if (tool.summary) {
    body.appendChild(el("div", "tool-sub", "返回结果"));
    body.appendChild(el("pre", "tool-result", tool.summary));
  } else if (!tool.running) {
    body.appendChild(el("div", "tool-sub muted sm", "（这个工具没有回内容）"));
  }
  d.appendChild(body);
  return d;
}

/** 工具卡标题：名字 + 最有信息量的那个参数（查询词 / 命令 / 路径）。 */
function toolLabel(tool) {
  let label = TOOL_LABEL[tool.name] || tool.name || "工具";
  const a = tool.args || {};
  const key = a.query || a.command || a.expr || a.chunk_id || a.path || a.url || a.topic || a.kind;
  if (key) label += "：" + String(key).slice(0, 80);
  return label;
}

/**
 * 思考段：默认展开（用户要能看见它在想什么），点一下收起。
 * 摘要只报真实耗时 —— "已思考 N 秒"，不编造步骤。
 */
function thinkRow(it, live, isTail) {
  const d = el("details", "think-row");
  // 只有"正在写的最后一段"展开：这段思考一结束（开始出正文或动工具）就折起来
  d.open = !!(live && isTail);
  const secs = Math.max(1, Math.round(Number(it.ms || 0) / 1000));
  const s = el("summary", "think-sum", "思考过程 · " + secs + " 秒");
  d.appendChild(s);
  if (it.text) d.appendChild(el("div", "think-text", it.text));
  return d;
}

/** 正文下面那排 icon：复制 / 改这条重发 / 从这里开分支 / 看内部事件。 */
function iconBtn(label, iconName, onClick, cls) {
  const b = el("button", "msg-icon-btn" + (cls ? " " + cls : ""), "");
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = icon(iconName);
  b.onclick = onClick;
  return b;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板");
  } catch (e) {
    toast("复制失败，请手动选择文本");
  }
}

/** 这一轮的原始事件（界面显示的一切都是从它们渲染出来的，这里给出原始 JSON）。 */
function rawTurnToggle(t, box) {
  const b = iconBtn("看这一轮的内部事件（原始 JSON）", "code", () => {
    const live = box.querySelector(".turn-raw");
    if (live) { live.remove(); return; }
    const evs = (state.chatEvents || []).filter((e) => (e.turnId || "—") === t.id);
    const wrap = el("div", "turn-raw");
    wrap.appendChild(el("div", "turn-raw-title", "这一轮实际传输的事件（" + evs.length + " 条）"));
    wrap.appendChild(el("pre", "turn-raw-pre", JSON.stringify(evs, null, 2)));
    box.appendChild(wrap);
    wrap.scrollIntoView({ block: "nearest" });
  });
  return b;
}

/**
 * 一段消息下面的那行小字：时间 + 几个 icon。
 *
 * 用户消息：时间 · 复制 · 重写（重写只挂在最后一条 —— 中间那条改掉，
 * 后面的回答就全对不上了，那是"分支"该干的事）。
 * 助手回答：复制 · 分支 · 内部事件 · 时间。
 */
function msgMeta(opts) {
  const meta = el("div", "msg-meta " + (opts.side === "user" ? "right" : "left"));
  const stamp = el("span", "msg-time", fmtStamp(opts.at || "").slice(6) || "");
  const icons = [];
  if (opts.onCopy) icons.push(iconBtn("复制", "copy", opts.onCopy));
  if (opts.onBranch) icons.push(iconBtn("从这里开分支", "branch", opts.onBranch));
  if (opts.onRaw) icons.push(opts.onRaw);
  if (opts.onEdit) icons.push(iconBtn("改这条重发", "pencil", opts.onEdit));
  if (opts.side === "user") {
    meta.appendChild(stamp);
    for (const b of icons) meta.appendChild(b);
  } else {
    for (const b of icons) meta.appendChild(b);
    meta.appendChild(stamp);
  }
  if (!stamp.textContent) stamp.remove();
  return meta;
}

// Adapted from AACS111/pi-studio splitFinalAssistantBlocks, Copyright (c) 2026 agegr, MIT.
function splitAssistantDisplayBlocks(items) {
  const blocks=(items || []).filter(b=>b.t!=='think' || String(b.text || '').trim());
  const lastProcessIndex=blocks.findLastIndex(b=>b.t==='think' || b.t==='tool');
  if(lastProcessIndex===-1)return {answerBlocks:blocks,processBlocks:[]};
  return {answerBlocks:blocks.slice(lastProcessIndex+1),processBlocks:blocks.slice(0,lastProcessIndex+1)};
}

function renderTurnBlock(t, live) {
  live = !!live && t.ok == null;
  const box = el("div", "turn-block");
  box.dataset.turnId = t.id || '';
  const last = (state.chatTurns || [])[(state.chatTurns || []).length - 1];
  const isLast = !!last && last.id === t.id;
  const canEdit = !!t.user && t.id && t.id !== "local" && isLast && !(t.attachments || []).some(a=>a.kind==='image');
  if (t.user) {
    const u = el("div", "msg msg-user");
    const stack = el("div", "msg-stack");
    const b = el("div", "msg-body");
    b.innerHTML = md(t.user);
    stack.appendChild(b);
    if (t.attachments?.length) stack.appendChild(attachmentChips(t.attachments, false));
    if (!live) {
      stack.appendChild(msgMeta({
        side: "user",
        at: t.userAt,
        onCopy: () => copyText(t.user),
        onEdit: canEdit ? () => editTurnInline(t, box) : null,
      }));
      // 这一轮要是"同一分叉点上的几兄弟"之一，气泡下面给 ‹ n/m ›（会话树）
      const fam = (t.id && t.id !== "local") ? branchFamilyFor(t.id) : null;
      if (fam) stack.appendChild(branchSwitchRow(fam));
    }
    u.appendChild(stack);
    if (t.steer) u.appendChild(el("span", "msg-flag", "插话"));
    box.appendChild(u);
  }
  // Adapted from pi-studio lib/message-display.ts (MIT); see third_party/pi-studio-LICENSE.txt.
  // Preserve original order. Only adjacent process blocks share a collapsible group.
  const {processBlocks,answerBlocks}=splitAssistantDisplayBlocks(t.items);
  let pending=[],groupIndex=0;
  const appendContent=it=>{
    if(it.t==='knowledge'){const button=btn('知识点已记录：'+it.point.title,'ghost sm knowledge-recorded',()=>openKnowledgePoint(it.point.id));box.appendChild(button);}
    else if(it.t==='file')box.appendChild(fileArtifactCard(it.artifact));
    else if(it.t==='resource')box.appendChild(resourceCard(it.resource,true));
    else if(it.text){const node=assistantBlock(it.text,live&&it.streaming);node.dataset.timelineKind='text';box.appendChild(node);}
  };
  const flushProcess=()=>{
    if(!pending.length)return;
    const items=pending;pending=[];
    const tail=items[items.length-1]===processBlocks[processBlocks.length-1]&&answerBlocks.length===0;
    const active=live&&tail,secs=Math.max(0,Math.round(items.reduce((n,x)=>n+Number(x.ms || 0),0)/1000));
    const steps=items.filter(x=>x.t==='tool').length;
    const group=el('details','work-group');group.dataset.timelineKind='process';
    const key=(t.id || 'local')+':'+groupIndex++;
    const initial=state.workExpansions?.[key] ?? active;
    group.open=initial;
    group.ontoggle=()=>{
      // <details> 会为"创建时就 open"异步补发一次 toggle —— 那不是用户操作，不能写进偏好，
      // 否则"进行中默认展开"会在跑完后被当成用户要求，工作过程一直不收（实测偶发）。
      if(group.open===initial&&group.dataset.userToggled!=='1')return;
      group.dataset.userToggled='1';
      state.workExpansions=state.workExpansions || {};state.workExpansions[key]=group.open;
    };
    const head=el('summary','work-head');head.innerHTML='<span class="work-chev">'+icon('chevron')+'</span><span>工作过程</span><span class="work-stat">'+(active?'进行中':secs?secs+' 秒':'')+(steps?' · '+steps+' 步':'')+'</span>';
    const body=el('div','work-body');
    items.forEach((it,i)=>body.appendChild(it.t==='think'?thinkRow(it,active,active&&i===items.length-1):toolCard(it,active)));
    group.append(head,body);box.appendChild(group);
  };
  for(const item of processBlocks){if(item.t==='think'||item.t==='tool')pending.push(item);else{flushProcess();appendContent(item);}}
  flushProcess();answerBlocks.forEach(appendContent);
  // 这一轮改了哪些文件：一张小卡（逐文件 +/-），有就显示，没有就不占地方
  if (t.fileChanges && t.fileChanges.length) {
    const card = el("details", "file-card");
    const sum = el("summary", "file-head");
    const addAll = t.fileChanges.reduce((n, x) => n + (x.add || 0), 0);
    const delAll = t.fileChanges.reduce((n, x) => n + (x.del || 0), 0);
    sum.innerHTML = icon("file") + "<span>改了 " + t.fileChanges.length + " 个文件</span>" +
      '<span class="file-stat"><b class="add">+' + addAll + '</b> <b class="del">−' + delAll + "</b></span>";
    card.appendChild(sum);
    const list = el("div", "file-list");
    for (const f of t.fileChanges) {
      const row = el("div", "file-row");
      row.innerHTML = "<span class='file-name'>" + esc(f.path) + (f.created ? "<i class='file-tag'>新建</i>" : "") + "</span>" +
        "<span class='file-stat'><b class='add'>+" + (f.add || 0) + "</b> <b class='del'>−" + (f.del || 0) + "</b></span>";
      const preview=btn('预览','ghost sm',()=>openFilePreview(f.absPath || (sessionWorkDir().path.replace(/[\\/]$/, '')+'/' + f.path),{title:f.path}));row.appendChild(preview);
      /* 改动草稿：写之前留了一份原样，所以每个文件都能"看差异 / 撤销"（用户要的可还原） */
      if (f.draftId && !(state.draftSettled || {})[f.draftId]) {
        row.dataset.draft = f.draftId;
        const acts = el("span", "file-acts");
        acts.appendChild(iconBtn("看差异", "diff", () => draftDiffDialog(f)));
        acts.appendChild(iconBtn("撤销这次改动", "undo", () => draftDiscard(f)));
        row.appendChild(acts);
      }
      list.appendChild(row);
    }
    const pendingDrafts = t.fileChanges.filter((x) => x.draftId && !(state.draftSettled || {})[x.draftId]);
    if (pendingDrafts.length > 1) {
      const foot = el("div", "file-foot");
      foot.appendChild(btn("全部撤销", "sm ghost", () => draftDiscardAll(pendingDrafts, foot)));
      list.appendChild(foot);
    }
    card.appendChild(list);
    box.appendChild(card);
  }
  if (live && t.resourceProgress) {
    const names = {retrieve: "检索资料", plan: "规划结构", write_section: "撰写讲义", knowledge_points: "梳理知识点", questions: "生成题目", repair: "根据质检修订", artifact_save: "保存成果"};
    box.appendChild(el("div", "resource-progress", names[t.resourceProgress.name] || "正在生成与检查学习资源"));
  }
  const running = live && t.activity !== "responding";
  if (running) {
    const p2 = el("div", "msg msg-ai");
    const b = el("div", "msg-body");
    const active = t.items.filter((x) => x.t === "tool" && x.running);
    const phase = active.length ? "正在执行：" + active.map((x) => TOOL_LABEL[x.name] || x.name).join("、")
      : t.activity === 'tool_input' ? '正在接收'+(TOOL_LABEL[t.activityTool] || '工具')+'参数…'+(t.toolInputBytes?'（'+fmtSize(t.toolInputBytes)+'）':'')
      : t.activity === 'retrying' ? '输出太长，正在重新生成完整参数…'
      : t.activity === "thinking" ? "正在思考…" : "等待模型返回…";
    const elapsed = t.startedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(t.startedAt)) / 1000)) : 0;
    b.innerHTML = '<span class="spinner"></span> ' + esc(phase) + '<span class="live-elapsed" data-started-at="'+esc(t.startedAt || '')+'"> · 已用 '+elapsed+' 秒</span>';
    p2.appendChild(b);
    box.appendChild(p2);
  }
  if (!live && t.ok === false) {
    const cancelled = String(t.message || "").indexOf("取消") >= 0;
    const e = el("div", "msg msg-ai");
    e.appendChild(el("div", "msg-body " + (cancelled ? "muted" : "err-text"), t.message || "这一轮没有完成"));
    if (cancelled && t.user) {
      const eacts = el("div", "row msg-actions");
      eacts.appendChild(btn("重新问一次", "sm ghost", () => { if (state.chatResend) state.chatResend(t.user, t.attachments); }));
      e.appendChild(eacts);
    }
    box.appendChild(e);
  }
  const lastText = (() => {
    for (let i = t.items.length - 1; i >= 0; i--) {
      if (t.items[i].t === "a" && t.items[i].text) return t.items[i].text;
    }
    return "";
  })();
  if (!live && t.ok !== false && (t.citations.length || t.report)) box.appendChild(citationBox(t.citations, t.report));
  if (!live) {
    /* 回答下面那行：复制 / 分支 / 内部事件 / 时间。
       上一版这里是"做成讲义 / 练习册 / 实操 / 演示"四个文字按钮 —— 生成什么资源由你开口决定，
       不该在每条回答下面摆一排快捷方式。 */
    const hasAnswer = !!lastText;
    if (hasAnswer || (t.id && t.id !== "local")) {
      box.appendChild(msgMeta({
        side: "ai",
        at: t.answerAt || t.startedAt,
        onCopy: hasAnswer ? () => copyText(lastText) : null,
        onBranch: (t.id && t.id !== "local") ? () => branchFromTurn(t) : null,
        onRaw: (t.id && t.id !== "local") ? rawTurnToggle(t, box) : null,
      }));
    }
  }
  return box;
}
/**
 * 改一下这条用户消息再重发。
 *
 * 只对**最后一条**用户消息开放：中间某一条改掉，后面的回答就全对不上了 ——
 * 那是"分支"该干的事（原会话留着，另开一段重来）。
 * 两个去处：保存并重发（把这一轮起的历史删掉重发）/ 另开分支再发（原会话一字不动）。
 */
/**
 * 改一下这条用户消息再重发。
 *
 * 只对**最后一条**用户消息开放：中间某一条改掉，后面的回答就全对不上了 ——
 * 那是"分支"该干的事（原会话留着，另开一段重来）。
 * 编辑器就长在**气泡里面**（用户要求："我要直接在气泡里编辑"）；点取消原样还回去。
 */
function editTurnInline(t, box) {
  const u = box.querySelector(".msg-user");
  if (!u || u.querySelector(".bubble-edit")) return;
  const body = u.querySelector(".msg-body");
  const original = t.user || "";
  // 原正文先搬到一个"暂存盒"里：取消时原样放回去，一个字都不改
  const keep = el("div", "bubble-original");
  keep.hidden = true;
  while (body.firstChild) keep.appendChild(body.firstChild);
  body.appendChild(keep);
  const ta = el("textarea", "bubble-edit");
  ta.value = original;
  body.appendChild(ta);
  const grow = () => {
    ta.style.height = "auto";
    ta.style.height = Math.max(22, Math.min(320, ta.scrollHeight + 2)) + "px";
  };
  ta.addEventListener("input", grow);
  const row = el("div", "row bubble-edit-actions");
  const restore = () => {
    ta.remove();
    row.remove();
    while (keep.firstChild) body.appendChild(keep.firstChild);
    keep.remove();
  };
  row.appendChild(btn("保存并重发", "sm primary", () => resendEdited(t, ta.value.trim(), false)));
  row.appendChild(btn("另开分支再发", "sm ghost", () => resendEdited(t, ta.value.trim(), true)));
  row.appendChild(btn("取消", "sm ghost", restore));
  body.parentElement.appendChild(row);   // 按钮挂在这一列下面，气泡本身保持原样
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  setTimeout(grow, 0);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); resendEdited(t, ta.value.trim(), false); }
    if (e.key === "Escape") restore();
  });
}

/* ---------- 改动草稿：看差异 / 撤销（写之前留的那份原样） ---------- */

/** 记住这条草稿已经收摊（撤销 / 保留过）：重画时不再摆"看差异 / 撤销"。 */
function draftSettledMark(id, how) {
  state.draftSettled = state.draftSettled || {};
  state.draftSettled[id] = how;
  const acts = document.querySelector('.chat-thread .file-row[data-draft="' + id + '"] .file-acts');
  if (acts) acts.innerHTML = "<i class='file-tag'>" + (how === "merged" ? "已保留" : "已还原") + "</i>";
}

/** 看这次改动改了什么：原样 vs 现在，行级差异（与工作台里的资源版本对比同一套画法）。 */
async function draftDiffDialog(f) {
  let d;
  try {
    d = await api("/api/drafts/diff", { id: f.draftId });
  } catch (e) {
    toast("看不了差异：" + e.message);
    return;
  }
  if (d.ok !== true) { toast("这条改动已经收摊了"); return; }
  const v = $("view");
  const dlg = el("div", "card dialog");
  dlg.appendChild(cardHeadOnly("改动差异 · " + (d.path || f.path || "")));
  dlg.appendChild(el("div", "muted sm", d.existed ? "左：改动前　右：现在（+ 新增 / − 删掉）" : "这是新建的文件（原来不存在）"));
  const pre = el("pre", "resource-diff-lines");
  const lines = diffResourceLines(d.before || "", d.after || "");
  let n = 0;
  for (const [kind, text] of lines) {
    if (n++ > 500) { pre.appendChild(el("div", "diff-same", "……（只显示前 500 行）")); break; }
    pre.appendChild(el("div", "diff-" + kind, (kind === "add" ? "+ " : kind === "remove" ? "− " : "  ") + text));
  }
  const box = el("div", "diff-box");
  box.appendChild(pre);
  dlg.appendChild(box);
  const row = el("div", "row");
  row.appendChild(btn("撤销这次改动", "ghost", async () => {
    if (await draftDiscard(f)) dlg.remove();
  }));
  row.appendChild(btn("保留改动", "primary", async () => {
    try {
      const r = await api("/api/drafts/merge", { id: f.draftId });
      if (r.ok === true) { draftSettledMark(f.draftId, "merged"); toast("已保留这次改动"); }
      else toast("这条改动已经收摊了");
    } catch (e) { toast("保留失败：" + e.message); }
    dlg.remove();
  }));
  dlg.appendChild(row);
  v.insertBefore(dlg, v.firstChild);
  dlg.scrollIntoView({ block: "start" });
}

/** 撤销一处改动：把写之前那份原样写回去（新建的文件则删掉）。 */
async function draftDiscard(f) {
  try {
    const r = await api("/api/drafts/discard", { id: f.draftId });
    if (r.ok !== true) { toast("还原失败（这条改动可能已经收摊）"); return false; }
    draftSettledMark(f.draftId, "discarded");
    toast("已还原 " + (f.path || ""));
    return true;
  } catch (e) {
    toast("还原失败：" + e.message);
    return false;
  }
}

/** 一次撤销这一轮的所有文件改动。 */
async function draftDiscardAll(changes, foot) {
  const ids = changes.map((x) => x.draftId).filter(Boolean);
  if (!ids.length) return;
  try {
    const r = await api("/api/drafts/discard-all", { sessionId: state.chatSessionId, ids });
    for (const id of ids) draftSettledMark(id, "discarded");
    if (foot && foot.isConnected) foot.remove();
    toast("已还原 " + (r.restored || ids.length) + " 处改动");
  } catch (e) {
    toast("还原失败：" + e.message);
  }
}

/** 这一轮在会话树里属于哪一族分支（不在任何分支上时返回 null）。 */
function branchFamilyFor(turnId) {
  const fams = (state.chatTree && state.chatTree.families) || [];
  for (const f of fams) {
    const members = f.members || [];
    for (let i = 0; i < members.length; i++) {
      if (members[i].turnId === turnId) return { members, idx: i };
    }
  }
  return null;
}

/** 气泡下面那行 ‹ n/m ›：同一分叉点上的几条线，点一下就换到那条线上。 */
function branchSwitchRow(fam) {
  const row = el("div", "branch-switch");
  const prev = el("button", "bs-btn", "‹");
  prev.type = "button";
  prev.title = "上一条分支";
  prev.disabled = fam.idx <= 0;
  prev.onclick = () => switchToBranch(fam.members[fam.idx - 1]);
  const count = el("span", "bs-count", (fam.idx + 1) + "/" + fam.members.length);
  const next = el("button", "bs-btn", "›");
  next.type = "button";
  next.title = "下一条分支";
  next.disabled = fam.idx >= fam.members.length - 1;
  next.onclick = () => switchToBranch(fam.members[fam.idx + 1]);
  row.appendChild(prev);
  row.appendChild(count);
  row.appendChild(next);
  return row;
}

/** 切到另一条分支：换末端，然后按新分支重画这一段历史。 */
async function switchToBranch(member) {
  if (!member) return;
  try {
    const d = await api("/api/sessions/set-active", { sessionId: state.chatSessionId, turnId: member.tipTurnId });
    if (d.ok !== true) { toast("切不过去：这条分支找不到了"); return; }
    if (typeof state.chatOpenSession === "function") await state.chatOpenSession(state.chatSessionId);
  } catch (e) {
    toast("切换失败：" + e.message);
  }
}

/** 输入框上面那条"待分叉"提示（取消 = 放弃这次分叉，什么都不会变）。 */
function splitBarShow() {
  const bar = document.querySelector(".split-hint");
  if (!bar) return;
  bar.hidden = false;
  bar.innerHTML = "";
  bar.appendChild(el("span", "sh-text", "已从这一轮开分支：下一条消息从这里长出去，原来那条线保留（发完可用 ‹ 2/2 › 切回去）"));
  bar.appendChild(btn("取消", "sm ghost", () => { splitBarHide(); })); 
}
function splitBarHide() {
  const bar = document.querySelector(".split-hint");
  if (bar) { bar.hidden = true; bar.innerHTML = ""; }
}

/**
 * 从这一轮开分支：下一条消息接在**这一轮之前**，原来那条线一字不动。
 *
 * 用户没发消息就取消的话什么都不该变 —— 所以内核只记下"待分叉点"，真正挪末端是
 * 下一条事件追加时的事（见 session.cj 的 split / append）。
 */
async function splitFromTurn(t) {
  if (!state.chatSessionId || !t || !t.id || t.id === "local") return;
  try {
    const d = await api("/api/sessions/split", { sessionId: state.chatSessionId, turnId: t.id });
    if (d.ok !== true) { toast("找不到这一轮，刷新一下再试"); return; }
    splitBarShow();
    const input = $("chat-input");
    if (input) {
      input.value = t.user || "";
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  } catch (e) {
    toast("开分支失败：" + e.message);
  }
}

async function resendEdited(t, text, asBranch) {
  if (!text) { toast("内容不能为空"); return; }
  try {
    if (asBranch) {
      /* 同一会话内分叉（会话树）：原线留在库里，发完可以用 ‹ n/m › 切回来。
         以前这里是"复制成一段新会话"，用户实际想要的是"同一条会话里的另一条线"。 */
      const d = await api("/api/sessions/split", { sessionId: state.chatSessionId, turnId: t.id });
      if (d.ok !== true) { toast("这一轮已经找不到了，刷新一下再试"); return; }
      splitBarHide();
    } else {
      // 内核那边是物理删除：这一轮以及它之后的记录都会被删掉，再发新的
      const d = await api("/api/sessions/rewind", { sessionId: state.chatSessionId, turnId: t.id });
      if (!d.ok) { toast("这一轮已经找不到了，刷新一下再试"); return; }
      const fresh = await api("/api/sessions/events", { sessionId: state.chatSessionId });
      state.chatEvents = fresh.events || [];
      state.lastEventId = fresh.lastId || 0;
      state.chatTree = fresh.tree || null;
      state.chatTurns = turnsFromEvents(state.chatEvents);
    }
    await reloadSessions();
    if (current === "chat" && typeof state.chatOpenSession === "function") {
      await state.chatOpenSession(state.chatSessionId);
    } else {
      go("chat");
    }
    if (state.chatResend) state.chatResend(text, t.attachments);
  } catch (e) {
    toast("没改成：" + e.message);
  }
}

/**
 * 从**最新的一条**开分支：整段对话（含最后一轮）复制到新会话，原会话一字不动。
 *
 * 与 branchFromTurn 的差别：那个是"从某一轮之前分"（连那一轮一起不要了，换个问法重来）；
 * 这个是"把这段对话整个带走，换条路继续走" —— 顶栏 ⋯ 里的「新建分支」用的是它。
 */
/** 从这一轮开分支：原会话一字不动，新会话把这一轮（含）连同之前的历史一起带过去。 */
async function branchFromTurn(t) {
  try {
    const d = await api("/api/sessions/branch", { sessionId: state.chatSessionId, turnId: t.id });
    // 新分支可能还没有事件（从第一轮分出去时"之前的历史"是空的）：先把名字记在界面里，
    // 列表加载完之后 summary 会给出同一个名字（内核在分叉时就写进了 title:<sid>）
    state.chatTitleHint = state.chatTitleHint || {};
    if (d.title) state.chatTitleHint[d.sessionId] = d.title;
    await loadProjects();
    await reloadSessions();
    openChatSession(d.sessionId);
    toast(d.title ? ("已开新分支：" + d.title + "（原会话还在）") : "已从这一轮开出新分支（原会话还在）");
  } catch (e) {
    toast("分支失败：" + e.message);
  }
}

function attachmentKey() { return state.chatSessionId || ('new:' + (state.chatProject || 'chat')); }
function chatAttachments() { state.attachmentDrafts ||= {}; return state.attachmentDrafts[attachmentKey()] ||= []; }
function attachmentChips(items, editable) {
  const strip = el('div', editable ? 'attachment-strip' : 'message-attachments');
  strip.hidden = !items.length;
  for (const item of items) {
    const chip = el('div', 'attachment-chip'); chip.title = item.path || item.name;
    if (item.kind === 'image' && item.dataUrl) { const image = el('img'); image.src=item.dataUrl; image.alt=item.name || '图片附件'; chip.appendChild(image); }
    else { const mark=el('span','attachment-kind');mark.innerHTML=icon(item.kind==='directory'?'folder':'file');chip.appendChild(mark); }
    chip.appendChild(el('span','attachment-name',item.name || '附件'));
    if (editable) chip.appendChild(btn('×','attachment-remove',()=>{
      const draft=chatAttachments(),index=draft.indexOf(item);if(index>=0)draft.splice(index,1);state.paintAttachments?.();
    }));
    if (editable) chip.lastElementChild.setAttribute('aria-label','移除附件 '+(item.name || ''));
    strip.appendChild(chip);
  }
  return strip;
}
function addChatAttachments(items, draftKey=attachmentKey()) {
  state.attachmentDrafts ||= {}; const draft=state.attachmentDrafts[draftKey] ||= [];
  if(draft.length+items.length>8 || draft.filter(a=>a.kind==='image').length+items.filter(a=>a.kind==='image').length>4) {toast('每轮最多8个附件，其中图片最多4张');return;}
  if([...draft,...items].reduce((n,a)=>n+(a.dataUrl?.length || 0),0)>12*1024*1024) {toast('图片总量不能超过12MiB');return;}
  for(const item of items) {if(!draft.some(a=>a.kind===item.kind&&(item.path ? a.path===item.path : a.dataUrl===item.dataUrl)))draft.push(item);}
  if(draftKey===attachmentKey())state.paintAttachments?.();
}
async function ensureImageSupport() {
  if(state.busyTurn){toast('请等当前任务结束后添加图片');return false;}
  const model=(state.cfg.models || []).find(m=>m.id===state.cfg.chatModelId);
  if(!model){toast('请先配置对话模型');return false;}
  const key=[model.id,model.model,model.baseUrl].join('|');state.visionChecks ||= new Map();
  try {
    if(!state.visionChecks.has(key)){toast('正在检测当前对话模型的图片支持…');state.visionChecks.set(key,api('/api/models/vision-test',{}));}
    const result=await state.visionChecks.get(key);if(!result.supported)toast(result.reason);return !!result.supported;
  }catch(e){state.visionChecks.delete(key);toast('图片能力检测失败：'+e.message);return false;}
}
async function imageFromBlob(file) {
  if(file.size>10*1024*1024)throw Error('图片不能超过10MiB');
  const original=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
  const image=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(Error('图片无法识别'));img.src=original;});
  let dataUrl=original;
  if(Math.max(image.width,image.height)>2048 || dataUrl.length>4*1024*1024){
    const ratio=Math.min(1,2048/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.round(image.width*ratio);canvas.height=Math.round(image.height*ratio);canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);dataUrl=canvas.toDataURL('image/jpeg',.85);
  }
  if(dataUrl.length>4*1024*1024)throw Error('图片仍然太大，请选择较小的图片');
  return {kind:'image',name:file.name || '粘贴图片.png',mime:dataUrl.slice(5,dataUrl.indexOf(';')),dataUrl};
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
    // 空会话：欢迎块 + 输入区居中（Codex 新开一段的形状）。
    // 工具面板打开时先让位 —— 居中布局下内容高于窗口时顶部会被裁掉，收起按钮就点不到了。
    const paintBlank = () => {
      const sheetNow = $("tool-sheet");
      v.classList.toggle("chat-blank", !state.chatTurns.length && !(sheetNow && !sheetNow.hidden));
    };

    if (!hasChatModel()) {
      v.appendChild(cardOf({
        body: emptyState({
          art: "gear",
          title: "还没有可用的对话模型",
          text: "桌面版用你自己的模型服务：填一次接口地址和密钥，把「对话与生成」绑上去，就能开始对话。",
          actions: [btn("去配置模型", "primary", () => go("models"))],
        }),
      }));
      await renderPanel();
      return;
    }

    /* 这里原来有一条顶栏（知识库选择 + 检索标签 + 工具 + 全部会话）。
       用户说"很奇怪"，去掉了：知识库归会话管（见左侧会话栏的分组与新建），
       工具清单挪进 ＋ 菜单（「工具与技能…」），"全部会话"侧栏底部本来就有。 */

    /* 工具与技能：从 ＋ 菜单点开（原来是顶栏一个按钮，现在顶栏没了） */
    const sheet = el("div", "card tool-sheet");
    sheet.id = "tool-sheet";
    sheet.hidden = true;
    const shHead = el("div", "card-head");
    shHead.appendChild(el("h2", null, "工具与技能"));
    shHead.appendChild(spacer());
    const curSkill = (state.skills || []).find((x) => x.id === state.skill);
    if (curSkill) shHead.appendChild(tag("技能：" + curSkill.title, "ok"));
    shHead.appendChild(btn("收起", "sm ghost", () => { sheet.hidden = true; paintBlank(); }));
    sheet.appendChild(shHead);
    if (curSkill) {
      sheet.appendChild(el("p", "muted sm",
        "这次对话绑了技能「" + curSkill.title + "」：只有它声明的工具（" + (curSkill.tools || []).join(" / ") +
        "）能调用，别的会被拒绝并记进会话。"));
    }
    const tlist = el("div", "list");
    const tools = state.tools || [];
    if (!tools.length) {
      tlist.appendChild(el("div", "muted sm", "（还没读到工具清单）"));
    } else {
      for (const g of TOOL_GROUP_ORDER) {
        const mine = tools.filter((t) => (TOOL_GROUP[t.name] || "其他") === g);
        if (!mine.length) continue;
        tlist.appendChild(el("div", "panel-group-title", g));
        for (const t of mine) {
          const it = el("div", "item");
          const head = el("div", "row");
          const main = el("div", "grow");
          main.appendChild(el("div", "item-title", (TOOL_LABEL[t.name] || t.label || t.name)));it.title = t.name;
          main.appendChild(el("div", "muted sm", t.desc));
          head.appendChild(main);
          if (t.available === false) {
            head.appendChild(tag("需先配置", "warn"));
            head.appendChild(btn("去配置", "sm", () => go("settings", "models")));
          }
          it.appendChild(head);
          if (t.usage) it.appendChild(el("div", "meta", "参数示例 " + t.usage));
          tlist.appendChild(it);
        }
      }
      tlist.appendChild(el("div", "muted sm", "工作目录：常规聊天用默认目录（" +
        esc(state.cfg.agentWorkDir || state.cfg.defaultWorkDir || "") +
        "），指定工作区用项目文件夹 —— 可在「设置 → 智能体」里改默认目录。"));
    }
    sheet.appendChild(tlist);
    v.appendChild(sheet);

    /* 对话正文 */
    const thread = el("div", "chat-thread");
    thread.id = "chat-thread";
    v.appendChild(thread);
    /* 用户往上翻的时候就别再把他拽回底部（原来每 200ms 强拉一次，翻历史根本翻不动） */
    state.stickBottom = true;
    thread.addEventListener("scroll", () => {
      state.stickBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
    });

    /* 对话框：Codex 那种"一整块输入区"。一行控件只留三样：
       [＋ 动作] [权限档位] …… [↑ 发送 / ■ 停止]。

       刻意不放的东西（放过一轮，被用户指着说"乱七八糟"）：
       - 联网开关：这是 agent，要不要联网由它自己判断，工具直接给它；
       - 技能选择：技能用 "/" 调（占位符里就写着），不必占一个常驻入口；
       - 模型选择：那是设置里的东西，这里用一行小字告诉你现在是哪个模型。
       权限档位就是 Lumin 的三档：请求批准 / 帮我批准 / 完全访问权限。 */
    const inputRow = el("div", "composer");
    const ta = el("textarea");
    ta.id = "chat-input";
    ta.rows = 1;
    ta.placeholder = "描述你的学习目标，或让我围绕资料完成一个任务…";
    inputRow.appendChild(ta);
    let attachmentsStrip = attachmentChips(chatAttachments(), true); inputRow.prepend(attachmentsStrip);
    state.paintAttachments = () => { const next=attachmentChips(chatAttachments(),true);attachmentsStrip.replaceWith(next);attachmentsStrip=next; };
    ta.addEventListener('paste', async event => {
      const images=[...(event.clipboardData?.items || [])].filter(i=>i.type.startsWith('image/')).map(i=>i.getAsFile()).filter(Boolean);
      if(!images.length)return;event.preventDefault();const key=attachmentKey();
      if(!(await ensureImageSupport()))return;
      try{addChatAttachments(await Promise.all(images.map(imageFromBlob)),key);}catch(e){toast(e.message);}
    });

    const crow = el("div", "composer-row");
    /* ＋ ＝ 添加附件（对齐 Codex：加号是"把资料交给这一轮"，不是配置项）。
       权限是另一枚 chip 的事，别混在一个按钮里。 */
    const plusBtn = el("button", "composer-icon", "");
    plusBtn.type = "button";
    plusBtn.setAttribute("aria-label", "添加附件");
    plusBtn.title = "添加附件（把文件/文件夹交给 Lumin 读）";
    plusBtn.innerHTML = icon("plus");
    crow.appendChild(plusBtn);
    /* ＋ ＝ 添加附件（不是权限）；权限在右边那枚 chip 上，两枚按钮各开各的菜单。 */
    plusBtn.onclick = (ev) => {
      ev.stopPropagation();
      const at = menu.querySelector(".cm-attach");
      if (menuBuilt && !menu.hidden && at && !at.hidden) { closeMenu(); return; }
      openMenu("attach");
    };

    /* ---- 权限档位（= Lumin 的 permissions，文案在模块级的 PERM_LABEL）----
       只有挂工作区的会话才给档位；常规对话是固定行为（整机只读 + 只写默认目录），不给任何选项。 */
    const permChip = el("button", "composer-chip", "");
    permChip.type = "button";
    const isChatMode = () => !sessionWorkDir().project;
    const paintPermChip = () => {
      if (isChatMode()) {
        permChip.hidden = true;
        return;
      }
      permChip.hidden = false;
      const m = state.cfg.agentPerm || "auto";
      permChip.innerHTML = icon("shield") + "<span>" + esc(PERM_LABEL[m] || m) + "</span>" + icon("chevron");
      permChip.title = (PERM_HINT[m] || "") + "\\n工作目录：" + (sessionWorkDir().path || "");
    };
    paintPermChip();
    state.chatRepaintChips = () => { paintPermChip(); paintModelChip(); };
    crow.appendChild(permChip);
    crow.appendChild(spacer());

    /* 模型：一枚安静的 chip（圆点 + 模型名 + 下拉标），贴在发送键左边；点开直接切换 */
    const modelText = el("button", "composer-model", "");
    modelText.type = "button";
    modelText.title = "当前对话模型 · 点击切换";
    const paintModelChip = () => {
      const name = modelLabel(state.cfg.chatModelId) || "未配置模型";
      modelText.innerHTML = '<span class="cm-dot"></span><span class="cm-name">' + esc(name) + "</span>" + icon("chevron");
      modelText.dataset.model = state.cfg.chatModelId || "";
    };
    paintModelChip();
    modelText.onclick = (ev) => { ev.stopPropagation(); openMenu("model"); };
    /* 上一轮的 token 用量：这是用户判断"上下文是不是快满了"的唯一依据
       （pi 的 TUI 也在页脚显示同一个数）。没有数据就不显示，不写 0 糊弄人。 */
    const usageText = el("span", "composer-usage", "");
    usageText.hidden = true;
    const paintUsage = () => {
      const turns = (state.chatTurns || []).filter((t) => t.usageIn || t.usageOut);
      const last = turns[turns.length - 1];
      if (!last) { usageText.hidden = true; return; }
      const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
      usageText.hidden = false;
      usageText.textContent = "↑" + fmt(last.usageIn || 0) + " ↓" + fmt(last.usageOut || 0);
      usageText.title = "上一轮真实用掉的 token（供应商回的 usage）：输入 " + (last.usageIn || 0) +
        " · 输出 " + (last.usageOut || 0) + "\n上下文接近上限时该 /compact —— 现在还没有手动压缩，暂时只能靠它提示";
    };
    paintUsage();
    state.chatRepaintUsage = paintUsage;
    crow.appendChild(usageText);
    crow.appendChild(modelText);

    /* 一个按钮两种状态：空闲是"发送"，跑着是"停止"（Codex 也是这么干的） */
    const actionBtn = el("button", "composer-send", "");
    actionBtn.style.marginLeft = "2px";
    actionBtn.type = "button";
    const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
    const ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';
    const paintActionBtn = () => {
      const busy = !!state.busyTurn;
      const stopping = busy && state.chatRequest && state.cancelRequested === state.chatRequest.sessionId;
      actionBtn.innerHTML = busy ? ICON_STOP : ICON_SEND;
      actionBtn.classList.toggle("stop", busy);
      actionBtn.title = stopping ? "正在停止当前任务" : busy ? "停止（Esc）" : "发送（Enter，Shift+Enter 换行）";
      actionBtn.setAttribute("aria-label", stopping ? "正在停止" : busy ? "停止" : "发送");
      actionBtn.disabled = !!stopping || !!state.chatStarting;
    };
    actionBtn.onclick = () => {
      if (state.busyTurn) stopTurn();
      else send();
    };
    crow.appendChild(actionBtn);

    // 菜单懒建：没打开过就一个按钮都不存在，免得和页面别处的同名按钮撞上
    const menu = el("div", "composer-menu");
    menu.hidden = true;
    let menuBuilt = false;
    inputRow.appendChild(crow);
    // "待分叉"提示条：坐在输入框上面（没点过"从这条开分支"时它一直 hidden）
    const splitHint = el("div", "split-hint");
    splitHint.hidden = true;
    v.appendChild(splitHint);
    v.appendChild(inputRow);

    /* ＋ 菜单：只放真做得成的事。联网方式与技能列表都不在这儿（见上面那段注释）。 */
    let closeMenu = () => { menu.hidden = true; };
    const buildMenu = () => {
      const menuItem = (iconName, label, hint, onClick) => {
        const b2 = el("button", "composer-menu-item");
        b2.type = "button";
        b2.innerHTML = icon(iconName) + '<span class="cm-text"><span class="cm-label">' + esc(label) + "</span>" +
          (hint ? '<span class="cm-hint">' + esc(hint) + "</span>" : "") + "</span>";
        b2.onclick = () => { closeMenu(); onClick(); };
        return b2;
      };

      /* 权限档位：就是 Lumin 的三档，和左边那枚 chip 同步（这儿是"改"，chip 是"看"）。 */
      const permBox = el("div", "cm-perm");
      permBox.hidden = true;
      /* 标题行：左边一句问句，右边"了解更多"指向设置里的智能体页（那里把三档讲清楚）。 */
      const permHead = el("div", "cm-perm-head");
      permHead.appendChild(el("span", "cm-perm-title", "应如何批准 Lumin 操作？"));
      const permMore = el("button", "cm-perm-more", "了解更多");
      permMore.type = "button";
      permMore.onclick = () => { closeMenu(); go("settings", "agent"); };
      permHead.appendChild(permMore);
      permBox.appendChild(permHead);

      const mkPerm = (id) => {
        const b = el("button", "composer-menu-item cm-perm-item" + (id === "full" ? " full" : ""));
        b.type = "button";
        b.dataset.perm = id;
        b.innerHTML = icon(PERM_ICON[id]) +
          '<span class="cm-text"><span class="cm-label">' + esc(PERM_LABEL[id]) + "</span>" +
          '<span class="cm-hint">' + esc(PERM_HINT_SHORT[id]) + "</span></span>" +
          '<span class="cm-check">' + icon("check") + "</span>";
        b.onclick = async () => {
          closeMenu();
          state.cfg.agentPerm = id;
          paintPermChip();
          try {
            await savePrefs({ agentPerm: id });
          } catch (e) { toast("保存失败：" + e.message); }
          toast("权限：" + PERM_LABEL[id]);
        };
        return b;
      };
      permBox.appendChild(mkPerm("ask"));
      permBox.appendChild(mkPerm("auto"));
      permBox.appendChild(mkPerm("full"));
      /* 工作目录不是"权限"，不放进这个菜单；常规对话现在也总有一个默认目录，所以不再给这行提示。 */
      menu.appendChild(permBox);

      /* 模型：点聊天框那枚 chip 打开；列出所有已配置的模型，选中即切换。 */
      const modelBox = el("div", "cm-model");
      modelBox.hidden = true;
      const modelHead = el("div", "cm-perm-head");
      modelHead.appendChild(el("span", "cm-perm-title", "用哪个模型来对话？"));
      const modelMore = el("button", "cm-perm-more", "管理模型");
      modelMore.type = "button";
      modelMore.onclick = () => { closeMenu(); go("settings", "models"); };
      modelHead.appendChild(modelMore);
      modelBox.appendChild(modelHead);
      const pickModels = state.cfg.models || [];
      if (!pickModels.length) {
        modelBox.appendChild(el("div", "cm-hint", "还没有配置模型：设置 → 模型与接口"));
      }
      for (const m of pickModels) {
        const b = el("button", "composer-menu-item cm-model-item");
        b.type = "button";
        b.dataset.model = m.id;
        b.innerHTML = icon("sliders") +
          '<span class="cm-text"><span class="cm-label">' + esc(m.name || m.id) + "</span>" +
          '<span class="cm-hint">' + esc(m.model || "") + "</span></span>" +
          '<span class="cm-check">' + icon("check") + "</span>";
        b.onclick = async () => {
          closeMenu();
          try {
            await api("/api/models/roles", { chatModelId: m.id, embedModelId: state.cfg.embedModelId, chunkModelId: state.cfg.chunkModelId, ttsModelId: state.cfg.ttsModelId });
            await loadCfg();
            paintModelChip();
            state.chatRepaintChips();
            toast("对话模型已切到「" + (m.name || m.id) + "」");
          } catch (e) {
            toast("切换失败：" + e.message);
          }
        };
        modelBox.appendChild(b);
      }
      menu.appendChild(modelBox);

      /* 附件：＋ 的那一块。把本机文件/文件夹的路径交给这一轮（路径进输入框，发出去之后
         Lumin 会自己用 read/ls 去读；不复制、不改动你的文件）。 */
      const attachBox = el("div", "cm-attach");
      attachBox.hidden = true;
      const attachPick = (isDir) => async () => {
        const key=attachmentKey();
        if(state.busyTurn){toast('请等当前任务结束后添加附件');return;}
        const a = window.itnWindow;
        const fn = isDir ? (a && a.pickDirectory) : (a && a.pickFile);
        if (typeof fn !== "function") {
          toast("选文件只在桌面应用窗口里可用");
          return;
        }
        const picked = await (isDir ? a.pickDirectory() : a.pickFile());
        if (!picked) return;
        if(!isDir && /\.(png|jpe?g|webp|gif)$/i.test(picked)) {
          if(!(await ensureImageSupport()))return;
          const result=await a.readSelectedImage(picked);if(!result.ok){toast(result.error);return;}addChatAttachments([result.image],key);
        } else addChatAttachments([{kind:isDir?'directory':'file',name:String(picked).replace(/\\/g,'/').split('/').pop(),path:picked}],key);
        closeMenu();$("chat-input").focus();
      };
      attachBox.appendChild(menuItem("file", "选文件…", "作为独立附件添加，正文只写你想做什么", attachPick(false)));
      attachBox.appendChild(menuItem("folder", "选文件夹…", "添加文件夹附件，完整路径收在附件详情里", attachPick(true)));
      attachBox.appendChild(menuItem("file", "添加图片…", "先检测当前对话模型，再添加可预览的图片", async()=>{
        const key=attachmentKey();if(!(await ensureImageSupport()))return;
        const a=window.itnWindow;if(!a?.pickImage){toast('选图片只在桌面应用窗口里可用，也可以粘贴图片');return;}
        const result=await a.pickImage();if(!result.ok){toast(result.error);return;}addChatAttachments(result.images || [],key);closeMenu();
      }));
      attachBox.appendChild(el("div", "cm-note", "文件保留在原位置；图片识别由当前对话模型完成。支持粘贴截图。"));
      menu.appendChild(attachBox);

      /* 技能：只在输入 "/" 时出现。它是"调用一个技能"的动作，不是常驻配置项。 */
      const skillBox = el("div", "cm-skills");
      const pick = async (id) => {
        closeMenu();
        const prev = state.skill;
        state.skill = id;
        try {
          if (!state.chatSessionId) {
            state.chatSessionId = (await api("/api/sessions/new", {})).sessionId;
          }
          await api("/api/skills/bind", { sessionId: state.chatSessionId, skill: id });
          go("chat");
          const cur = (state.skills || []).find((x) => x.id === id);
          toast(id ? "这次对话用技能：「" + (cur ? cur.title : id) + "」" : "技能交给模型自己决定");
        } catch (e) {
          state.skill = prev;
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

    /** 两种开法：＋ 打开全部动作；输入 "/" 只挑技能。 */
    const openMenu = (mode) => {
      if (!menuBuilt) {
        buildMenu();
        inputRow.appendChild(menu);
        menuBuilt = true;
        document.addEventListener("click", closeMenu);
      }
      menu.hidden = false;
      // ＋ 与权限 chip 都只出权限档位；输入 "/" 才出技能。
      const sk = menu.querySelector(".cm-skills");
      if (sk) sk.hidden = mode !== "skills";
      const at = menu.querySelector(".cm-attach");
      if (at) at.hidden = mode !== "attach";
      const pf = menu.querySelector(".cm-perm");
      if (pf) {
        pf.hidden = mode !== "perm";
        for (const b of pf.querySelectorAll(".cm-perm-item")) {
          b.classList.toggle("active", b.dataset.perm === (state.cfg.agentPerm || "auto"));
        }
      }
      const mb = menu.querySelector(".cm-model");
      if (mb) {
        mb.hidden = mode !== "model";
        for (const b of mb.querySelectorAll(".cm-model-item")) {
          b.classList.toggle("active", b.dataset.model === state.cfg.chatModelId);
        }
      }
    };


    /* ＋ 与权限 chip：两枚按钮各自的开法（在按钮创建处已经绑好，这里不再重复绑定） */
    permChip.onclick = (ev) => {
      ev.stopPropagation();
      if (isChatMode()) {
        toast("常规聊天：整机可读，只对默认工作目录可写。要放开权限，请为那个目录建一个「指定工作区」会话");
        return;
      }
      openMenu("perm");
    };
    // 输入框随内容长高（最多 8 行），像桌面聊天客户端那样
    const grow = () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    };
    ta.addEventListener("input", () => {
      grow();
      /* 以 / 开头就是命令（窗口里的 lumin 开关），列出匹配项；
         原来这里只弹技能菜单 —— 现在技能是其中一条（/skill）。 */
      const v = ta.value.trimStart();
      slashHintShow(v.startsWith("/"), v);
    });
    grow();

    if (state.pendingQuestion) {
      ta.value = state.pendingQuestion;
      state.pendingQuestion = "";
    }

    /** 停下来：手写链路看取消标记，Lumin 那一轮直接 abort。 */
    async function stopTurn() {
      const sid = state.chatRequest ? state.chatRequest.sessionId : state.chatSessionId;
      if (!sid) return;
      if (state.cancelRequested === sid) return;
      // 记下来：这一轮按过停止，收尾时按"已取消"处理。
      // 内核那边的 abort 只在"下一轮请求之前"生效（运行时就是这么设计的），
      // 所以已经流出去的那半段保留着，剩下的不再继续 —— 这比假装它还是正常结束要诚实。
      state.cancelRequested = sid;
      paintActionBtn();
      try {
        await api("/api/agent/cancel", { sessionId: sid, turnId: state.chatRequest?.turnId || undefined });
        toast("正在停止当前任务…");
      } catch (e) {
        state.cancelRequested = null;
        paintActionBtn();
        toast("停止失败：" + e.message);
      }
    }

    /**
     * 跑着的时候还能打字 —— Enter 就是"插话"：这句话在下一次模型请求之前注入当前这一轮。
     * （pi 的 steering；不是排队等下一轮，也不是把输入框锁死。）
     */
    async function steer() {
      const text = ta.value.trim();
      const sid = state.chatSessionId;
      if (!text || !sid) return;
      ta.value = "";
      grow();
      try {
        await api("/api/agent/steer", { sessionId: sid, text: text });
        markSessionActivity(sid);
        renderPanel();
        // 先在正文里显示出来（内核把它注进这一轮时会再写一条 user/message 事件，正好对上）
        state.chatTurns.push({ id: "steer-" + Date.now(), kind: "ask", user: text, items: [], report: null, citations: [], ok: null, message: "", steer: true });
        paint();
        toast("已插入当前这一轮");
      } catch (e) {
        toast("插话失败：" + e.message);
      }
    }

    /* ---- 需要批准的动作用户确认（写工作区外 / 跑命令 / 联网） ---- */
    const APPROVAL_LABEL = {
      "file-read": "读取文件",
      "file-write": "写入文件",
      "path-outside": "写入工作区外的目录",
      command: "运行命令",
      "command-dangerous": "运行有风险的命令",
      web: "访问网络",
    };
    function approvalCard(req) {
      const card = el("div", "approval-card");
      const head = el("div", "row");
      head.appendChild(el("div", "grow approval-title", "Lumin 想在你的电脑上" + (APPROVAL_LABEL[req.kind] || req.kind)));
      head.appendChild(tag("需要批准", "warn"));
      card.appendChild(head);
      if (req.value) card.appendChild(el("div", "approval-path", req.value));
      if (req.detail) card.appendChild(el("div", "muted sm", String(req.detail).slice(0, 200)));
      const row = el("div", "row approval-acts");
      const answer = async (decision) => {
        try {
          await api("/api/agent/approvals/answer", { id: req.id, decision: decision });
          state.approvals = state.approvals.filter((x) => x.id !== req.id);
          paint();
        } catch (e) { toast("提交失败：" + e.message); }
      };
      row.appendChild(btn("允许一次", "primary sm", () => answer("once")));
      row.appendChild(btn("本会话都允许", "sm", () => answer("session")));
      row.appendChild(btn("总是允许", "sm", () => answer("always")));
      row.appendChild(btn("拒绝", "ghost sm", () => answer("deny")));
      card.appendChild(row);
      return card;
    }

    async function pollApprovals() {
      try {
        const sid = state.chatSessionId;
        const d = await api("/api/agent/approvals", sid ? { sessionId: sid } : {});
        const pend = (d.requests || []).filter((x) => !x.decision && (!sid || x.sessionId === sid));
        const changed = pend.length !== (state.approvals || []).length ||
          pend.some((x, i) => (state.approvals[i] || {}).id !== x.id);
        state.approvals = pend;
        if (changed) paint();
      } catch (e) { /* 轮询失败不打扰 */ }
    }

    /* ---- 增量渲染 ----
       原来每次轮询都 thread.innerHTML = "" 重建整段对话：长会话里等于每隔一两百毫秒
       把全篇 Markdown 重排一遍，这正是"打字机发卡"的主因。现在按轮次缓存节点，
       只有内容变了的那一轮（通常就是正在流式输出的那一轮）会重建，其余直接复用。 */
    const paintCache = new Map();   // 轮次 id → { node, sig, live }
    let paintOrder = "";            // 轮次顺序指纹：没变就不动 DOM 顺序
    function turnSig(t, live) {
      const parts = [t.kind || "", t.user || "", t.ok === null ? "" : String(t.ok), t.message || "",
                     t.activity || "", t.activityTool || '', t.toolInputBytes || 0, t.steer ? 1 : 0, (t.citations || []).length, t.report ? 1 : 0,
                     t.resourceProgress ? (t.resourceProgress.name || "1") : ""];
      // 会话树的分支行（‹ n/m ›）也要进指纹：这一轮跑完时先用旧树画过一版并进了缓存，
      // 随后才拉到带 families 的新树 —— 指纹不含它的话，切换行要等整页重画才出现（实测踩过）
      const famSig = (t.id && t.id !== "local") ? branchFamilyFor(t.id) : null;
      parts.push("bf:" + (famSig ? famSig.idx + "/" + famSig.members.length : ""));
      for (const it of t.items) {
        parts.push(it.t, it.name || "", it.running ? 1 : 0, it.ok == null ? "" : (it.ok ? 1 : 0),
                   it.text ? it.text.length : 0, it.summary ? it.summary.length : 0, it.ms || 0);
      }
      // The local clock updates its own text node, independently of network events.
      return parts.join("|");
    }

    /* DOM 认领表：这一轮渲染负责哪些子节点。
       只清 paintCache 是不够的 —— 上一段会话留下的节点已经没人认领，但只要还挂在 thread 上
       就会被看到（用户实测：新建会话后，上一段对话的历史继续显示在它上面，看着像被带过来了）。 */
    const approvalCache = new Map();   // 待批准请求 id → 节点，免得每次 paint 都重建一张卡
    function reconcileThread(keep) {
      for (const child of [...thread.children]) {
        if (!keep.has(child) && !child.classList.contains("empty")) child.remove();
      }
    }

    function paint() {
      // 会话 id 标在对话区上：自检要按"这一段会话"验联网档位，调试时也好对号
      thread.dataset.session = state.chatSessionId || "";
      if (typeof syncWorkbenchEvents === "function") syncWorkbenchEvents(state.chatEvents || []);
      paintBlank();
      const keep = new Set();
      if (!state.chatTurns.length) {
        paintCache.clear();
        paintOrder = "";
        /* 空态的文案跟着"这一段对话"走，不是一句写死的欢迎语：
           用户得先知道自己在哪个工作区、能写哪儿，再决定问什么（用户提的：
           "不要定死一个页面，用户根本不知道我当前新对话要在哪开始"）。 */
        const wdEmpty = sessionWorkDir();
        const wsKey = (wdEmpty.project ? "work:" : "chat:") + (wdEmpty.path || wdEmpty.name || "");
        let empty = thread.querySelector(".empty");
        if (empty && empty.dataset.ws !== wsKey) { empty.remove(); empty = null; }   // 换了会话/工作区就重画
        if (!empty) {
          empty = emptyState({
            inline: true,
            art: "brand",
            title: wdEmpty.project
              ? ("在「" + (wdEmpty.name || "这个工作区") + "」里做什么？")
              : "今天想学点什么？",
            // 作用范围在这里说清：这一段对话在哪个目录干活、检索什么
            text: (wdEmpty.project
                    ? "工作目录：" + (wdEmpty.path || "") + "（权限见输入框左下角）"
                    : "") +
                  "检索范围：本机全部知识库，答案带出处。" +
                  (state.chapter ? " 会带上你正在学的《" + state.chapter + "》。" : ""),
            actions: hasKb() ? [
              // 第一条跟着"当前在学什么"走：学过某一章才问"这一章"，否则问一个一定有落点的问题
              (state.chapter
                ? btn("本章重点", "", () => { ta.value = "这一章的核心结论是什么？"; send(); })
                : btn("资料重点", "", () => { ta.value = "我这边的资料里都有哪些重点？"; send(); })),
              btn("看知识库里有什么", "ghost", () => go("kb")),
            ] : [btn("去指定资料目录", "", () => go("settings", "kb"))],
          });
          empty.dataset.ws = wsKey;
          thread.appendChild(empty);
        }
        keep.add(empty);
      } else {
        const empty = thread.querySelector(".empty");
        if (empty) empty.remove();
        const order = [];
        for (const t of state.chatTurns) {
          const live = !!state.busyTurn && t.ok == null && (!state.chatRequest || state.chatRequest.sessionId === state.chatSessionId);
          const key = t.id || ("idx-" + order.length);
          order.push(key);
          const sig = turnSig(t, live);
          const hit = paintCache.get(key);
          if (!hit || hit.sig !== sig || hit.live !== live) {
            const node = renderTurnBlock(t, live);
            if (hit && hit.node.isConnected) hit.node.replaceWith(node);
            paintCache.set(key, { node, sig, live });
          }
        }
        const nowOrder = order.join(">");
        if (nowOrder !== paintOrder) {
          paintOrder = nowOrder;
          for (const key of order) {
            const hit = paintCache.get(key);
            if (hit) thread.appendChild(hit.node);   // 已在文档里的节点是"移动"，不重建
          }
        }
        for (const [key, hit] of [...paintCache]) {
          if (order.indexOf(key) < 0) { hit.node.remove(); paintCache.delete(key); }
        }
        for (const key of order) {
          const hit = paintCache.get(key);
          if (hit) keep.add(hit.node);
        }
      }
      // 待批准的动作可能来自任何一轮：同一张请求复用同一个节点，避免每 200ms 重建一次卡片
      const aliveApprovals = new Set();
      const approvalRequests = (state.approvals || []).filter((req) => !req.sessionId || req.sessionId === state.chatSessionId);
      for (const req of approvalRequests) {
        aliveApprovals.add(req.id);
        let node = approvalCache.get(req.id);
        if (!node) {
          node = approvalCard(req);
          approvalCache.set(req.id, node);
        }
        keep.add(node);
      }
      for (const [aid, node] of [...approvalCache]) {
        if (!aliveApprovals.has(aid)) {
          node.remove();
          approvalCache.delete(aid);
        }
      }
      reconcileThread(keep);
      for (const req of approvalRequests) thread.appendChild(approvalCache.get(req.id));
      paintActionBtn();
      if (typeof state.chatRepaintUsage === "function") state.chatRepaintUsage();
      if (state.stickBottom !== false) thread.scrollTop = thread.scrollHeight;
    }
    paint();

    async function send() {
      const draftKey=attachmentKey(),attachments=chatAttachments().slice();
      const text = ta.value.trim() || (attachments.length ? '请查看这些附件。' : '');
      if (!text) return;
      // 跑着的时候 Enter = 插话，不是"等这一轮跑完再说"
      if (state.busyTurn) { steer(); return; }
      if (state.chatStarting) return;
      if (!state.chatSessionId) {
        state.chatStarting = true;
        paintActionBtn();
        try {
          state.chatSessionId = (await api("/api/sessions/new", {})).sessionId;
        } catch (e) { toast("新建会话失败：" + e.message); return; }
        finally {state.chatStarting = false; paintActionBtn();}
        // 顶栏的面包屑跟着换到这一段（会话名先空着，模型起好名字会再刷一次）
        if (typeof refreshChatHeader === "function") refreshChatHeader();
      }
      const sid = state.chatSessionId;
      delete state.attachmentDrafts[draftKey];state.paintAttachments?.();
      ta.value = "";
      grow();
      state.lastQuestion = text;
      markSessionActivity(sid);
      const request = { sessionId: sid, controller: new AbortController(), baseline: (state.chatEvents || []).length, turnId: "", endedByEvents: false, phase: "thinking" };
      state.chatRequests.set(sid, request);
      syncChatBusy();
      renderPanel();   // 会话列表立刻给这一段挂上"正在回复"的转圈
      // 允许"已取消"的那一轮一键重问（取消多半是因为问题写错了）
      state.chatResend = (q, attached) => {
        if(attached?.some(a=>a.kind==='image'&&!a.dataUrl)){toast('请重新添加图片后再发送');return;}
        if(attached?.length)addChatAttachments(attached);
        const input = $("chat-input");
        if (input) input.value = q;
        send();
      };
      state.chatTurns.push({ id: "local", kind: "ask", user: text, attachments, items: [], report: null, citations: [], ok: null, message: "" });
      state.stickBottom = true;
      paint();

      // 生成过程中轮询会话事件，把 assistant/delta 渲染成"打字机"效果。
      // 内核 HTTP 是多线程的，长生成不会挡住这个轮询；顺便每 1.5 秒看一眼有没有要批准的动作。
      let approvalTick = 0;
      request.baseId = state.lastEventId || 0;
      request.lastId=request.baseId;
      let pollInFlight=false;
      const poll = setInterval(async () => {
        if(pollInFlight)return;pollInFlight=true;
        try {
          const d = await api("/api/sessions/events", { sessionId: sid, sinceId: request.lastId || 0 });
          if (d.lastId) request.lastId = d.lastId;
          const fresh = d.events || [];
          if (fresh.length) {
            /* 取 fresh 里最后一个 turn/start：带游标时它就是本轮的，
               不带游标（老内核回全量）时最后一条同样是本轮的，两种情况都对。 */
            for (const e of fresh) {
              if (e.type === "turn/start") request.turnId = e.turnId;
              if (e.type === "tool/call" || e.type === "tool/result") request.phase = "working";
              else if (e.type === "assistant/delta") request.phase = "speaking";
              else if (e.type === "assistant/thinking") request.phase = "thinking";
            }
            mascotActivity(request.phase, state.chatRequests.size);
          }
          if (state.chatSessionId !== sid) return;
          if(d.lastId)state.lastEventId=d.lastId;
          if (fresh.length) {
            state.chatEvents = (state.chatEvents || []).concat(fresh);
            state.chatTurns = turnsFromEvents(state.chatEvents);
            paint();
          }
          if (request.turnId && state.chatEvents.some((e) => e.type === "turn/end" && e.turnId === request.turnId)) {
            request.endedByEvents = true;
            request.controller.abort();
          }
        } catch (e) { /* 轮询失败不打扰用户，最终结果以收尾时那次为准 */ }
        finally { pollInFlight=false; }
        approvalTick = approvalTick + 1;
        if (approvalTick % 6 === 0) await pollApprovals();
      }, 220);

      let failure = "";
      try {
        // 对话一律走 Lumin（pi 运行时）：工具交给模型自己挑，步骤由它自己决定。
        // 原来那条手写循环（先检索、再生成、最后引用自检）不再参与对话——它是上一版的形状。
        // 工作目录与权限档位：没指定工作目录时，模型拿不到"本机文件"那几个工具，只能检索与联网。
        // 检索范围固定为"本机全部知识库"：空 kbId 在内核里就是通用模式的语义
        const payload = {
          kbId: "", question: text, attachments, sessionId: sid, web: "auto",
          // 模式由会话决定：普通对话（没项目）＝ 常规聊天，内核据此锁死"只写默认目录"
          mode: (state.chatProject ? "work" : "chat"),
          skill: state.skill || "", perm: state.cfg.agentPerm || "auto",
          // 界面上下文：用户正在看哪一章——"这一章"才有落点，不用模型反查/反问
          ctxChapter: state.chapter || "",
        };
        const res = await api("/api/agent/ask-pi", payload, request.controller.signal);
        if (res.ok !== true) failure = res.message || "这一轮没有完成";
      } catch (e) {
        failure = request.endedByEvents ? "" : e.message;
      }
      clearInterval(poll);
      await pollApprovals();
      try {
        const d = await api("/api/sessions/events", { sessionId: sid });
        if (state.chatSessionId === sid) {
          state.chatEvents = d.events || [];
          state.lastEventId = d.lastId || state.lastEventId || 0;
          state.chatTree = d.tree || null;
          state.chatTurns = turnsFromEvents(state.chatEvents);
          splitBarHide();   // 这一轮已经发出去了，"待分叉"提示可以收了
        }
      } catch (e) {
        state.chatTurns = state.chatTurns.filter((t) => t.id !== "local" && !String(t.id).startsWith("steer-"));
      }
      if (typeof syncWorkbenchEvents === "function") syncWorkbenchEvents(state.chatEvents || []);
      if (state.chatRequests.get(sid) === request) state.chatRequests.delete(sid);
      syncChatBusy();
      renderPanel();   // 跑完了把转圈摘掉（还是就地刷新，不动列表结构）
      const stopped = state.cancelRequested === sid;
      state.cancelRequested = null;
      if (stopped && !failure && state.chatSessionId === sid) {
        // 按过停止：这一轮标成"已取消"（正文保留），并把重问入口挂上
        const last = state.chatTurns[state.chatTurns.length - 1];
        if (last && last.id === "local") {
          last.ok = false;
          last.message = "已取消";
        }
        toast("已取消");
      } else if (failure) {
        if(attachments.length && current==='chat' && state.chatSessionId===sid && !chatAttachments().length) { addChatAttachments(attachments); if(!ta.value){ta.value=text;grow();} }
        toast(String(failure).indexOf("取消") >= 0 ? "已取消" : ("生成失败：" + failure));
      }
      mascotActivity(stopped || failure ? "idle" : "success", state.chatRequests.size);
      await reloadSessions();
      /* 这一轮跑完了再给这段对话起名：起名是**另一次模型请求**，
         和正文生成抢同一个模型（本地单线程服务甚至会直接撞超时），
         放在轮次收尾之后既不打扰正文，也让"名字只在第一次提问后生成一次"更好解释。
         名字回来之前，列表与顶栏先用第一句话兜着。 */
      maybeGenerateTitle(sid);
      if (typeof refreshWorkbenchState === "function") await refreshWorkbenchState();
      if (current === "chat" && !thread.isConnected) await go("chat");
      else paint();
    }

    // Enter 发送 / 跑着时 Enter 插话；Shift+Enter 换行；Esc 停止（有弹层时 Esc 先关弹层）
    ta.onkeydown = (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const raw = ta.value.trim();
        // 命令优先：/xxx 交给命令表，不发给模型（模型那头没有 lumin 的开关）
        if (raw.startsWith("/")) {
          const parts = raw.slice(1).split(/\s+/);
          const hit = SLASH_COMMANDS.find((c) => c.cmd === "/" + (parts[0] || "").toLowerCase());
          if (hit) {
            ta.value = "";
            grow();
            slashHintShow(false);
            hit.run(parts.slice(1).join(" ").trim());
            return;
          }
        }
        send();
        return;
      }
      if (e.key === "Escape") {
        const v = ta.value.trimStart();
        if (v.startsWith("/")) {
          e.preventDefault();
          ta.value = "";
          grow();
          slashHintShow(false);
          return;
        }
        if (state.busyTurn) {
          e.preventDefault();
          stopTurn();
        }
      }
    };
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.busyTurn && !document.querySelector(".card.dialog")) stopTurn();
    });
    // 待批准的动作可能来自任何一轮（包括直接打接口起的那一轮）：空闲时也要看
    await pollApprovals();
    if (state.approvalTimer) clearInterval(state.approvalTimer);
    state.approvalTimer = setInterval(() => {
      if (current !== "chat") return;
      pollApprovals();
    }, 2000);

    state.chatPaint = paint;
    state.chatRepaintBusy = paintActionBtn;
    /* 就地换会话：只换对话区那一段正文，不整页重建、也不重拉会话列表。
       会话栏只把高亮挪过去 —— 点一次就闪一次"加载中…"的问题就出在原来走的是整页 go()。 */
    state.chatOpenSession = async (id) => {
      state.chatSessionId = id;
      syncChatBusy();
      state.chatEvents = [];
      state.lastEventId = 0;
      state.chatTurns = [];
      paintCache.clear();
      paintOrder = "";
      try {
        const d = await api("/api/sessions/events", { sessionId: id });
        state.chatEvents = d.events || [];
        state.lastEventId = d.lastId || 0;
        state.chatTree = d.tree || null;
        state.chatTurns = turnsFromEvents(state.chatEvents);
      } catch (e) {
        toast("读取会话失败：" + e.message);
      }
      state.stickBottom = true;
      paint();
      for (const node of document.querySelectorAll("#panel-body .panel-item")) {
        node.classList.toggle("active", node.dataset.id === id);
      }
      if (typeof state.chatRepaintChips === "function") state.chatRepaintChips();
      // 顶栏那条面包屑（📁 工作区 | 会话名）也要跟着换，否则从项目新建会话后它还是上一段的
      if (typeof refreshChatHeader === "function") refreshChatHeader();
      ta.focus();
    };
    /* 已有会话：把历史事件还原成线程 */
    if (state.chatSessionId) {
      try {
        const d = await api("/api/sessions/events", { sessionId: state.chatSessionId });
        state.chatEvents = d.events || [];
        state.lastEventId = d.lastId || 0;
        state.chatTree = d.tree || null;
        state.chatTurns = turnsFromEvents(state.chatEvents);
        syncChatBusy();
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
  "tool/call": "调用工具",
  "tool/result": "工具结果",
  "assistant/message": "模型回复",
  "validation": "引用自检",
  "turn/end": "一轮结束",
  "assistant/thinking": "思考",
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
    $("page-title").textContent = "全部会话";
    $("page-sub").textContent = "查看每次问答和生成的过程";
    const ta = $("top-actions");
    ta.innerHTML = "";
    ta.appendChild(btn("回到对话", "sm primary", () => go("chat")));
    if (state.sessionId) {
      await renderSessionDetail(v, state.sessionId);
      return;
    }
    const card = cardOf({
      title: "全部会话",
      sub: "提问、工具调用与生成结果",
      tag: state.sessions.length + " 条",
      actions: [btn("问一个问题", "sm primary", () => go("chat"))],
    });
    if (!state.sessions.length) {
      card.appendChild(emptyState({
        art: "clock",
        title: "还没有任何会话",
        text: "去伴学助手提一个问题，或者生成一份讲义，这里会留下这次调用用到的工具与出处。",
        actions: [btn("去提问", "primary", () => go("chat")), btn("去生成讲义", "", () => go("learn"))],
      }));
    } else {
      const list = el("div", "list");
      for (const s of state.sessions) {
        const it = el("div", "item clickable");
        const row = el("div", "row");
        const main = el("div", "grow");
        const titleEl = el("div", "item-title", s.title || "（无标题会话）");
        if (isSessionRunning(s.sessionId)) titleEl.insertBefore(el("span", "spinner panel-item-spin"), titleEl.firstChild);
        main.appendChild(titleEl);
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
      else if (e.type === "tool/call") text = (p.tool || "") + " " + (p.query || "");
      else if (e.type === "validation") {
        const r = p.report || {};
        text = "段落 " + r.paragraphs + " · 带引用 " + r.citedParagraphs + " · 越界 " + r.outOfRange;
      } else if (e.type === "assistant/thinking") text = "已思考 " + Math.max(1, Math.round(Number(p.ms || 0) / 1000)) + " 秒";
      else if (e.type === "turn/end") text = p.ok === false ? (p.message || "失败") : "完成";
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
    label: "MiMo Flash",
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
    label: "MiMo Pro",
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
    key: "mimo-tts",
    label: "MiMo 语音",
    id: "mimo-tts",
    name: "MiMo 语音",
    base: "https://api.xiaomimimo.com/v1",
    model: "",
    vision: "",
    embed: "",
    ttsModel: "mimo-v2.5-tts",
    ttsVoice: "苏打",
    ttsFormat: "wav",
    ttsProtocol: "mimo",
    note: "独立朗读配置：使用 MiMo 语音服务的密钥；不要和 TokenPlan 对话密钥混用。保存后到「用途绑定」设为语音朗读。",
  },
  {
    key: "custom",
    label: "兼容服务",
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
        $("m-tts-model").value = p.ttsModel || "";
        $("m-tts-voice").value = p.ttsVoice || "";
        $("m-tts-format").value = p.ttsFormat || "wav";
        $("m-tts-protocol").value = p.ttsProtocol || "";
        hint.textContent = p.note;
        document.querySelectorAll(".chip").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
      };
      presetRow.appendChild(b);
    }
    mcard.appendChild(presetRow);
    mcard.appendChild(hint);

    const f1 = el("div", "row");
    f1.appendChild(fieldOf("标识", inputOf("m-id", "mimo")));
    f1.appendChild(fieldOf("显示名称", inputOf("m-name", "MiMo TokenPlan")));
    mcard.appendChild(f1);
    const f2 = el("div", "row");
    f2.appendChild(fieldOf("接口地址", inputOf("m-base", "https://token-plan-cn.xiaomimimo.com/v1")));
    const keyInput = inputOf("m-key", "留空则保留原密钥");
    keyInput.type = "password";
    f2.appendChild(fieldOf("密钥", keyInput));
    mcard.appendChild(f2);
    const f3 = el("div", "row");
    f3.appendChild(fieldOf("对话模型", inputOf("m-model", "mimo-v2.6-flash")));
    f3.appendChild(fieldOf("多模态模型（图片描述，可留空）", inputOf("m-vision", "mimo-v2.6-pro")));
    f3.appendChild(fieldOf("向量模型（可留空）", inputOf("m-embed", "")));
    mcard.appendChild(f3);
    const f4 = el("div", "row");
    f4.appendChild(fieldOf("朗读模型（可留空）", inputOf("m-tts-model", "mimo-v2.5-tts")));
    const voiceInput = inputOf("m-tts-voice", "苏打 / alloy");
    voiceInput.setAttribute("list", "tts-voices");
    const voiceField = fieldOf("音色", voiceInput);
    const voices = el("datalist");
    voices.id = "tts-voices";
    for (const voice of ["冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean", "alloy", "nova", "shimmer"]) {
      const option = el("option");
      option.value = voice;
      voices.appendChild(option);
    }
    voiceField.appendChild(voices);
    f4.appendChild(voiceField);
    f4.appendChild(fieldOf("音频格式", selectOf("m-tts-format", [
      { value: "", label: "自动" }, { value: "wav", label: "WAV" }, { value: "mp3", label: "MP3" },
      { value: "opus", label: "Opus" }, { value: "aac", label: "AAC" }, { value: "flac", label: "FLAC" },
    ], "wav")));
    f4.appendChild(fieldOf("接口协议", selectOf("m-tts-protocol", [
      { value: "", label: "自动判断" }, { value: "openai", label: "OpenAI /audio/speech" }, { value: "mimo", label: "MiMo 语音" },
    ], "")));
    mcard.appendChild(f4);
    const mact = el("div", "row");
    mact.appendChild(btn("保存模型", "primary", async () => {
      const id = $("m-id").value.trim();
      if (!id) { toast("请填写标识"); return; }
      const base = $("m-base").value.trim();
      const model = $("m-model").value.trim();
      const ttsModel = $("m-tts-model").value.trim();
      if (!base || (!model && !ttsModel)) { toast("接口地址以及对话模型或朗读模型不能为空"); return; }
      try {
        await api("/api/models/save", {
          id: id,
          name: $("m-name").value.trim(),
          baseUrl: base,
          apiKey: $("m-key").value,
          model: model,
          visionModel: $("m-vision").value.trim(),
          embeddingModel: $("m-embed").value.trim(),
          ttsModel: ttsModel,
          ttsVoice: $("m-tts-voice").value.trim(),
          ttsFormat: $("m-tts-format").value,
          ttsProtocol: $("m-tts-protocol").value,
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
        text: "点上面任意一个「快速填入」，地址与模型名会自动写进表单，补一个密钥保存即可。",
        actions: [btn("填入预设", "primary", () => {
          const b = document.querySelector(".chip");
          if (b) b.click();
          $("view").scrollTop = 0;
          toast("已填入，请补密钥");
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
          m.baseUrl + " · " + (m.model || "无对话模型") + (m.visionModel ? " · 多模态 " + m.visionModel : "") +
          (m.embeddingModel ? " · 向量 " + m.embeddingModel : "") +
          (m.ttsModel ? " · 朗读 " + m.ttsModel + (m.ttsVoice ? "/" + m.ttsVoice : "") : "") +
          (m.hasApiKey ? " · 已设置密钥" : " · 未设置密钥")));
        row.appendChild(main);
        if (state.cfg.chatModelId === m.id) row.appendChild(tag("主模型", "ok"));
        if (state.cfg.ttsModelId === m.id) row.appendChild(tag("朗读", "ok"));
        if (!m.hasApiKey) row.appendChild(tag("缺密钥", "warn"));
        it.appendChild(row);
        const acts = el("div", "row item-actions");
        if (m.model) {
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
            await api("/api/models/roles", { chatModelId: m.id, embedModelId: state.cfg.embedModelId, chunkModelId: state.cfg.chunkModelId, ttsModelId: state.cfg.ttsModelId });
            toast("已绑定「对话与生成」");
            go("settings", "models");
          }));
        }
        if (m.ttsModel) {
          acts.appendChild(btn("设为朗读模型", "sm", async () => {
            await api("/api/models/roles", { chatModelId: state.cfg.chatModelId, embedModelId: state.cfg.embedModelId, chunkModelId: state.cfg.chunkModelId, ttsModelId: m.id });
            toast("已绑定「语音朗读」");
            go("settings", "models");
          }));
          if (m.hasApiKey) acts.appendChild(btn("试听", "sm ghost", async (ev) => {
            const b = ev.currentTarget;
            b.disabled = true;
            b.textContent = "合成中…";
            if (ttsPreviewAudio) { ttsPreviewAudio.pause(); ttsPreviewAudio = null; }
            try {
              const data = await api("/api/models/tts-test", { id: m.id });
              ttsPreviewAudio = new Audio(data.dataUrl);
              ttsPreviewAudio.onplay = () => mascotActivity("speaking", 1);
              ttsPreviewAudio.onended = () => {
                const busy = state.chatRequests.size;
                mascotActivity(busy ? "working" : "success", busy);
                b.textContent = "试听"; b.disabled = false;
              };
              ttsPreviewAudio.onerror = () => { mascotActivity(state.chatRequests.size ? "working" : "idle", state.chatRequests.size); b.textContent = "试听"; b.disabled = false; toast("音频无法播放"); };
              b.textContent = "播放中…";
              await ttsPreviewAudio.play();
            } catch (e) {
              mascotActivity("idle", 0);
              b.textContent = "试听";
              b.disabled = false;
              toast("试听失败：" + e.message);
            }
          }));
        }
        acts.appendChild(btn("填到表单", "sm ghost", () => {
          $("m-id").value = m.id;
          $("m-name").value = m.name || "";
          $("m-base").value = m.baseUrl || "";
          $("m-model").value = m.model || "";
          $("m-vision").value = m.visionModel || "";
          $("m-embed").value = m.embeddingModel || "";
          $("m-tts-model").value = m.ttsModel || "";
          $("m-tts-voice").value = m.ttsVoice || "";
          $("m-tts-format").value = m.ttsFormat || "";
          $("m-tts-protocol").value = m.ttsProtocol || "";
          $("m-key").value = "";
          $("view").scrollTop = 0;
        }));
        if (m.hasApiKey && m.model) {
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

    const role = cardOf({ title: "用途绑定", sub: "四个用途可以指向同一个模型，也可以分开" });
    const rr = el("div", "row");
    const mk = (id, label, val, desc, candidates) => {
      const f = el("div", "field");
      f.appendChild(el("label", null, label));
      const options = (candidates || state.cfg.models).map((m) => ({ value: m.id, label: m.name || m.id }));
      // 当前绑定即使不满足筛选条件也要保留，避免打开设置时被静默清空。
      if (val && !options.some((x) => x.value === val)) {
        const bound = state.cfg.models.find((m) => m.id === val);
        if (bound) options.unshift({ value: bound.id, label: (bound.name || bound.id) + "（当前绑定）" });
      }
      const sel = selectOf(id, [{ value: "", label: "（未指定）" }].concat(options), val || "");
      f.appendChild(sel);
      f.appendChild(el("div", "field-hint", desc));
      return f;
    };
    rr.appendChild(mk("role-chat", "对话与生成", state.cfg.chatModelId, "主对话模型", state.cfg.models.filter((m) => m.model)));
    rr.appendChild(mk("role-embed", "向量检索", state.cfg.embedModelId, "留空则用关键词检索", state.cfg.models.filter((m) => m.embeddingModel)));
    rr.appendChild(mk("role-chunk", "切片与图片描述", state.cfg.chunkModelId, "用于图片与截图", state.cfg.models.filter((m) => m.model || m.visionModel)));
    rr.appendChild(mk("role-tts", "语音朗读", state.cfg.ttsModelId, "试听、朗读与 Lumin 语音工具", state.cfg.models.filter((m) => m.ttsModel)));
    role.appendChild(rr);
    role.appendChild(btn("保存绑定", "primary", async () => {
      try {
        await api("/api/models/roles", {
          chatModelId: $("role-chat").value,
          embedModelId: $("role-embed").value,
          chunkModelId: $("role-chunk").value,
          ttsModelId: $("role-tts").value,
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
    { value: "auto", label: "自动判断（默认）" },
    { value: "always", label: "优先联网" },
    { value: "off", label: "不联网" },
  ], mode)));
  const wsRow = el("div", "row");
  const wsKey = inputOf("ws-key", ws.hasKey ? "已设置，留空则保留原密钥" : "tvly-…");
  wsKey.type = "password";
  wsRow.appendChild(fieldOf("联网搜索密钥（Tavily）", wsKey));
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

  /* 域名黑白名单：黑名单优先；允许名单留空 = 不限制（默认） */
  const hostRow = el("div", "row");
  hostRow.appendChild(fieldOf("允许的域名（留空 = 不限制）", inputOf("ws-allow", "例如 example.com, *.gov.cn", ws.allowHosts || "")));
  hostRow.appendChild(fieldOf("禁止的域名（优先于允许名单）", inputOf("ws-block", "例如 *.doubleclick.net", ws.blockHosts || "")));
  wsCard.appendChild(hostRow);
  const wsActs = el("div", "row");
  wsActs.appendChild(btn("保存", "primary", async () => {
    try {
      await api("/api/websearch/save", {
        apiKey: $("ws-key").value.trim(),
        enabled: $("ws-enabled").value,
        results: Number($("ws-results").value) || 5,
        mode: $("ws-mode").value,
        allowHosts: $("ws-allow").value.trim(),
        blockHosts: $("ws-block").value.trim(),
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
  { id: "agent", label: "智能体", icon: "shield", title: "智能体" },
  { id: "data", label: "数据与备份", icon: "layers", title: "数据与备份" },
  { id: "skills", label: "技能", icon: "book", title: "技能" },
  { id: "about", label: "关于", icon: "file", title: "关于 Lumin" },
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
    const renderingGeneration = state.navigationGeneration;
    await loadCfg();
    if (renderingGeneration !== state.navigationGeneration) return;
    const sec = SETTINGS_SECTIONS.filter((x) => x.id === currentSection)[0] || SETTINGS_SECTIONS[0];
    if (sec.id === "general") await loadProfile();

    if (renderingGeneration !== state.navigationGeneration) return;
    const v = $("view");
    v.innerHTML = "";
    // 分区导航在第二层面板里（Codex 式），这里只放当前分区的内容
    const body = el("div", "settings-body");
    const head = el("div", "settings-head");
    head.appendChild(el("h2", null, sec.title));
    if (sec.sub) head.appendChild(el("p", null, sec.sub));
    body.appendChild(head);
    body.appendChild(await settingsSection(sec.id));
    if (renderingGeneration !== state.navigationGeneration) return;
    v.appendChild(body);
  },
};

/** 设置分区的路由表；每个 builder 返回一个可以整体塞进内容区的节点。 */
function settingsSection(id) {
  if (id === "appearance") return settingsAppearance();
  if (id === "agent") return settingsAgent();
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
      try {
        await saveProfile({
          nickname: $("pf-nick").value.trim(),
          goal: $("pf-goal").value.trim(),
          weeklyHours: Number($("pf-hours").value) || 0,
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
  /* 六维自评只在「我的成长 → 能力校准」里改：同一份数据两个入口，改一处漏一处是上一轮的教训 */
  const hint = el("div", "row profile-hint");
  hint.appendChild(el("span", "muted grow", "六维自评在「我的成长」里用一句话一条校准；这里只管称呼、目标与每周投入。"));
  hint.appendChild(btn("去校准", "sm", () => openCalibration()));
  prof.appendChild(hint);
  g.appendChild(prof);
  return g;
}

/**
 * 设置 · 智能体：Lumin 能不能动你的电脑。
 *
 * 三件事，别多：
 *   工作目录（不给就只能问答）；
 *   权限档位（就是 Lumin 的三档：请求批准 / 帮我批准 / 完全访问权限）；
 *   要不要放开跑命令（默认关 —— 命令比写文件危险得多）。
 * 红线写清楚：你自己在用的 API Key 不会被交出去；工作区里的 .env / .git / .ssh 写不进去。
 */
function settingsAgent() {
  const g = document.createDocumentFragment();
  const dir = state.cfg.agentWorkDir || "";
  const perm = state.cfg.agentPerm || "auto";

  const card = cardOf({
    title: "默认工作目录",
    tag: dir ? "已指定" : "用默认值",
    tagCls: dir ? "ok" : "",
    sub: "常规会话只写入此目录。",
  });
  const row = el("div", "row dir-row");
  const dirInput = inputOf("agent-dir", "默认目录", dir || (state.cfg.defaultWorkDir || ""));
  dirInput.className = "grow";
  dirInput.readOnly = true;
  row.appendChild(dirInput);
  row.appendChild(btn("选择…", "", async () => {
    const a = window.itnWindow;
    if (!a || typeof a.pickDirectory !== "function") {
      toast("选目录只在桌面应用窗口里可用");
      return;
    }
    const picked = await a.pickDirectory();
    if (!picked) return;
    try {
      await savePrefs({ agentWorkDir: picked });
      state.cfg.agentWorkDir = picked;
      toast("目录已更新");
      go("settings", "agent");
    } catch (e) { toast("保存失败：" + e.message); }
  }));
  if (dir) {
    row.appendChild(btn("清除", "ghost", async () => {
      try {
        await savePrefs({ agentWorkDirClear: true });
        state.cfg.agentWorkDir = "";
        toast("已恢复默认目录");
        go("settings", "agent");
      } catch (e) { toast("清除失败：" + e.message); }
    }));
  }
  card.appendChild(row);
  card.appendChild(el("p", "muted sm", "其他位置请使用独立工作区。"));
  g.appendChild(card);

  /* 工具与技能：原来挂在对话框的 ＋ 菜单里，按用户要求撤掉那边的入口，挪到这里。 */
  const toolsCard = cardOf({
    title: "工具与技能",
    tag: (state.tools || []).length + " 个工具",
    sub: "由 Lumin 按任务选择；技能可在对话中绑定",
  });
  const tlist = el("div", "list");
  for (const g of TOOL_GROUP_ORDER) {
    const mine = (state.tools || []).filter((t) => (TOOL_GROUP[t.name] || "其他") === g);
    if (!mine.length) continue;
    tlist.appendChild(el("div", "panel-group-title", g));
    for (const t of mine) {
      const it = el("div", "item");
      const head = el("div", "row");
      const main = el("div", "grow");
      main.appendChild(el("div", "item-title", (TOOL_LABEL[t.name] || t.label || t.name)));it.title = t.name;
      if (t.desc) main.appendChild(el("div", "muted sm", t.desc));
      head.appendChild(main);
      if (t.available === false) head.appendChild(tag("需先配置", "warn"));
      it.appendChild(head);
      tlist.appendChild(it);
    }
  }
  if (!tlist.childNodes.length) tlist.appendChild(el("div", "muted sm", "还没读到工具清单。"));
  toolsCard.appendChild(tlist);
  g.appendChild(toolsCard);

  const permCard = cardOf({ title: "权限（指定工作区）", sub: "与对话框左下角那枚开关是同一个设置；常规聊天是固定档：只写默认工作目录" });
  for (const m of ["ask", "auto", "full"]) {
    const line = el("div", "row setting-row");
    const left = el("div", "grow");
    left.appendChild(el("div", "switch-label", PERM_LABEL[m]));
    left.appendChild(el("div", "muted sm", PERM_HINT[m]));
    line.appendChild(left);
    const b = btn(m === perm ? "已选" : "选它", m === perm ? "sm" : "sm primary", async () => {
      state.cfg.agentPerm = m;
      try {
        await savePrefs({ agentPerm: m });
        toast("权限：" + PERM_LABEL[m]);
        go("settings", "agent");
      } catch (e) { toast("保存失败：" + e.message); }
    });
    if (m === perm) b.disabled = true;
    line.appendChild(b);
    permCard.appendChild(line);
  }
  const execLine = el("div", "row setting-row");
  const execLeft = el("div", "grow");
  execLeft.appendChild(el("div", "switch-label", "允许运行命令"));
  execLeft.appendChild(el("div", "muted sm", "两种模式都默认允许跑 PowerShell，每条命令仍然按上面的档位处理（ask 档每条都会先问你）。"));
  execLine.appendChild(execLeft);
  const execOn = state.cfg.agentExec === "1";
  execLine.appendChild(btn(execOn ? "关掉" : "打开", "sm" + (execOn ? " ghost" : ""), async () => {
    const next = execOn ? "0" : "1";
    try {
      await savePrefs({ agentExec: next });
      state.cfg.agentExec = next;
      toast(next === "1" ? "已允许跑命令" : "已关掉跑命令");
      go("settings", "agent");
    } catch (e) { toast("保存失败：" + e.message); }
  }));
  permCard.appendChild(execLine);
  g.appendChild(permCard);

  const safe = cardOf({ title: "红线" });
  const ul = el("ul", "about-list");
  [
    "你自己在用的密钥不会被交出去（配置里那份含密钥的文件永远不读）。",
    "工作目录里的 .env / .git / .ssh 写不进去。",
    "写工作目录之外的路径、跑命令、联网都会按上面的档位先问你 —— 每一次决定都留在会话里可回看。",
    "常规聊天不问你也不放行：工作目录之外一律拒绝（想改别的位置，就为它建一个「指定工作区」会话）。",
  ].forEach((t) => ul.appendChild(el("li", null, t)));
  safe.appendChild(ul);
  g.appendChild(safe);
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

  /* 显示大小：页面缩放（整体）与字体大小（只动字）分成两个旋钮，各自四档 */
  const sizeCard = cardOf({
    title: "显示大小",
    sub: "页面缩放也可以直接按 Ctrl + / Ctrl - ，Ctrl 0 复位",
  });
  const segRow = (label, steps, current, fmt, onPick) => {
    const row = el("div", "row setting-row");
    row.appendChild(el("div", "grow switch-label", label));
    const seg = el("div", "seg");
    const cur = nearestStep(steps, current);
    steps.forEach((v, i) => {
      const b = el("button", "seg-item" + (i === cur ? " active" : ""), fmt(v));
      b.dataset.step = String(v);
      b.onclick = () => onPick(v);
      seg.appendChild(b);
    });
    row.appendChild(seg);
    return row;
  };
  sizeCard.appendChild(segRow("页面缩放", ZOOM_STEPS, state.uiZoom, (v) => Math.round(v * 100) + "%", (v) => {
    setZoom(v);
    go("settings", "appearance");
  }));
  sizeCard.appendChild(segRow("字体大小", FONT_STEPS, state.uiFont,
    (v) => ({ 0.9: "小", 1: "标准", 1.1: "大", 1.25: "特大" })[v] || String(v), (v) => {
      setFont(v);
      go("settings", "appearance");
    }));
  g.appendChild(sizeCard);

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

  const petCard = cardOf({
    title: "小鼋龙",
    sub: "桌宠会跟随对话状态变化，可拖动到任意位置；隐藏后可在这里恢复",
  });
  let petHidden = false;
  try { petHidden = localStorage.getItem("lumin.mascot.hidden") === "1"; } catch (e) { /* 浏览器禁用存储时仍允许本次显示 */ }
  const petRow = el("div", "row switch-row");
  petRow.appendChild(el("div", "grow switch-label", petHidden ? "当前已隐藏" : "当前显示在窗口右下角"));
  petRow.appendChild(btn(petHidden ? "显示小鼋龙" : "隐藏小鼋龙", "sm", () => {
    window.dispatchEvent(new CustomEvent("lumin:mascot-visibility", { detail: { visible: petHidden } }));
    go("settings", "appearance");
  }));
  petRow.appendChild(btn("回到右下角", "sm ghost", () => {
    window.dispatchEvent(new CustomEvent("lumin:mascot-reset"));
    toast("小鼋龙已回到右下角");
    go("settings", "appearance");
  }));
  petCard.appendChild(petRow);
  g.appendChild(petCard);
  return g;
}

/** 上游报错很长时只留第一句（界面上的琥珀提示不该是一条小字报）。 */
function shortReason(msg) {
  const t = String(msg || "").split("；")[0].trim();
  return t.length > 120 ? t.slice(0, 120) + "…" : t;
}

/**
 * 选要导入的文件夹 / 文件。
 *
 * 这里刻意分成两个按钮：系统的"选文件夹"和"选文件"是两个不同的对话框，
 * 而且用户自己的意图本来就只有他自己知道——界面不该让他去猜"这条路径会被当成什么"。
 */
async function pickImportPath(kind) {
  const a = window.itnWindow;
  const fn = kind === "file" ? (a && a.pickFile) : (a && a.pickDirectory);
  const el0 = $("kb-import-path");
  if (!fn) {
    toast(kind === "file" ? "选文件只在桌面应用窗口里可用；这里可以直接粘贴路径" : "选文件夹只在桌面应用窗口里可用；这里可以直接粘贴路径");
    if (el0) { el0.focus(); el0.select && el0.select(); }
    return;
  }
  let picked = "";
  try {
    picked = await fn();
  } catch (e) {
    toast("打开对话框失败：" + e.message);
    return;
  }
  if (!picked) return; // 取消不是错误
  if (el0) {
    el0.value = picked;
    el0.dataset.kind = kind;
    const mode = $("kb-source-mode");
    if (mode) mode.textContent = kind === "dir" ? "文件夹 · 原地使用" : "文件 · 保存副本";
  }
  const base = picked.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  const nameEl = $("kb-import-name");
  if (nameEl && !nameEl.value.trim() && base) nameEl.value = base.replace(/\.[^.]+$/, "");
  toast("已选：" + picked);
}

/** 导入一种资料（文件夹原地登记 / 单文件复制进资料目录），然后可按需要立刻建索引。 */
async function importKbMaterial(withIndex) {
  const el0 = $("kb-import-path");
  const path = (el0 && el0.value || "").trim();
  if (!path) { toast("先选一个文件夹或一份文件"); return; }
  const nameEl = $("kb-import-name");
  const payload = { path: path, kind: (el0 && el0.dataset.kind) || "auto", name: (nameEl && nameEl.value.trim()) || "" };
  const buttons = [...document.querySelectorAll(".kb-import-actions button")];
  if (buttons.some(b => b.disabled)) return;
  buttons.forEach(b => { b.disabled = true; });
  try {
    const r = await api("/api/kb/import", payload);
    const info = (r && r.imported) || {};
    const id = info.id || "";
    state.kb = id || state.kb;
    await loadCfg();
    if (!id) { toast("导入完成"); go("settings", "kb"); return; }
    if (withIndex) {
      await buildIndex(id);
    } else {
      toast("已导入 " + (info.docs || 0) + " 篇资料，还没建立索引");
      go("settings", "kb");
    }
  } catch (e) {
    toast("导入失败：" + e.message);
  } finally {
    buttons.forEach(b => { b.disabled = false; });
  }
}

function renameKnowledgeBase(kb) {
  const dialog = courseDialog("重命名知识库");
  const name = inputOf("kb-rename-name", "知识库名称", kb.name || kb.id);
  name.maxLength = 80;
  const error = el("p", "kb-form-error");
  error.setAttribute("role", "alert");
  const save = btn("保存", "primary", async () => {
    if (!name.value.trim()) { error.textContent = "请输入名称"; name.focus(); return; }
    save.disabled = true;
    try {
      await api("/api/kb/rename", { id: kb.id, name: name.value.trim() });
      await loadCfg();
      dialog.close();
      await go("settings", "kb");
      toast("已重命名");
    } catch (e) { error.textContent = e.message; save.disabled = false; }
  });
  name.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing && !save.disabled) save.click(); });
  const actions = el("div", "course-dialog-actions");
  actions.append(btn("取消", "ghost", dialog.close), save);
  dialog.body.append(fieldOf("名称", name), error, actions);
  name.focus(); name.select();
}

/* ---------- 设置 · 知识库 ---------- */
function settingsKb() {
  const g = document.createDocumentFragment();
  /* 「导入资料」放在最上面：这才是用户真正要做的事。
     文件夹与单文件是两种形态，界面各给一个按钮，用户不用自己判断路径该怎么解析。 */
  const impCard = cardOf({
    title: "添加知识库",
  });
  const impForm = el("div", "kb-form");
  const nameRow = el("div", "row");
  nameRow.appendChild(fieldOf("名称（可选）", inputOf("kb-import-name", "默认使用文件或文件夹名")));
  impForm.appendChild(nameRow);
  const pickRow = el("div", "row dir-row");
  const pickInput = inputOf("kb-import-path", "选择文件夹、文件，或粘贴路径");
  pickInput.className = "grow";
  pickInput.setAttribute("aria-label", "资料路径");
  pickInput.addEventListener("input", () => { pickInput.dataset.kind = "auto"; $("kb-source-mode").textContent = ""; });
  pickRow.appendChild(pickInput);
  pickRow.appendChild(btn("选择文件夹", "", () => pickImportPath("dir")));
  pickRow.appendChild(btn("选择文件", "ghost", () => pickImportPath("file")));
  impForm.appendChild(fieldOf("资料", pickRow));
  const sourceMode = el("span", "kb-source-mode"); sourceMode.id = "kb-source-mode";
  impForm.appendChild(sourceMode);
  const impFacts = el("div", "row kb-import-actions");
  impFacts.appendChild(btn("添加并索引", "primary", () => importKbMaterial(true)));
  const addOnly = btn("仅添加", "ghost", () => importKbMaterial(false));
  addOnly.title = "先保存资料，稍后建立索引";
  impFacts.appendChild(addOnly);
  impForm.appendChild(impFacts);
  impCard.appendChild(impForm);
  g.appendChild(impCard);

  const kbCard = cardOf({
    title: "我的知识库",
    tag: state.cfg.knowledgeBases.length + " 个",
  });
  if (!state.cfg.knowledgeBases.length) {
    kbCard.appendChild(emptyState({
      inline: true,
      art: "db",
      title: "还没有知识库",
      text: "选择上方的文件夹或文件，开始添加。",
      actions: [btn("选择文件夹", "ghost", () => pickImportPath("dir"))],
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
      if (k.sourcePath && k.sourcePath !== k.rootDir) main.appendChild(el("div", "meta", "来源：" + k.sourcePath));
      if (k.builtAt) main.appendChild(el("div", "meta", "索引于 " + fmtStamp(k.builtAt)));
      row.appendChild(main);
      row.appendChild((k.chunkCount || 0) > 0 ? tag("已索引", "ok") : tag("未索引", "warn"));
      if (state.kb === k.id) row.appendChild(tag("当前"));
      it.appendChild(row);
      const acts = el("div", "row item-actions");
      acts.appendChild(btn((k.chunkCount || 0) > 0 ? "重建索引" : "建立索引", "sm primary", () => buildIndex(k.id)));
      acts.appendChild(btn("重命名", "sm ghost", () => renameKnowledgeBase(k)));
      // 资料散乱时让模型读一遍、给出一份教学目录；建索引时按它组织（结果可清除）
      acts.appendChild(btn("整理", "sm", () => organizeKb(k.id)));
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
      text: "备份会校验副本是否可打开。",
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
  const restore = el("details", "kb-management");restore.appendChild(el("summary", null, "恢复方式"));restore.appendChild(el("p", "muted sm", "退出应用后，用备份覆盖 itn.db；如存在 itn.db-journal，一并移除，再重新启动。"));bk.appendChild(restore);
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
  let data = { skills: [], userDir: "", bundledDir: "", sharedDirs: [] };
  try {
    data = await api("/api/skills/list", {});
  } catch (e) {
    g.appendChild(cardOf({ title: "技能", body: el("p", "muted", "读不到技能清单：" + e.message) }));
    return g;
  }
  const card = cardOf({
    title: "技能",
    sub: "扩展 Lumin 的工作方式",
    tag: (data.skills || []).length + " 个",
    actions: [
      btn("新建技能", "sm", async () => {
        try {
          const r = await api("/api/skills/template", {});
          toast("已创建技能：" + artifactNameFromPath(r.path));
          go("settings", "skills");
        } catch (e) { toast("创建失败：" + e.message); }
      }),
      copyButton(() => data.userDir || "", "复制目录"),
    ],
  });
  const list = el("div", "list");
  for (const sk of (data.skills || [])) {
    const it = el("div", "item skill-item");
    const row = el("div", "row skill-row");
    const main = el("div", "grow");
    main.appendChild(el("div", "item-title", sk.title || sk.id));
    if (sk.description && /[\u3400-\u9fff]/.test(sk.description)) main.appendChild(el("div", "meta skill-desc", sk.description));
    const meta = el("div", "meta");
    const source = sk.source === "bundled" ? "内置" : sk.source === "shared" ? "共享" : "我的";
    const toolCount = (sk.tools || []).length;
    meta.appendChild(el("span", null, source));
    meta.appendChild(el("span", null, toolCount ? "工具 " + toolCount + " 个" : "说明型"));
    if (sk.requiresConsent) meta.appendChild(el("span", null, "需要联网"));
    main.appendChild(meta);
    row.appendChild(main);
    if (sk.available) row.appendChild(tag("可用", "ok")); else it.title = sk.reason || "";
    row.appendChild(btn("查看", "sm", async () => {
      try {
        const d = await api("/api/skills/read", { id: sk.id });
        const dlg = el("div", "card dialog");
        dlg.appendChild(cardHeadOnly("技能说明 · " + d.title));
        const pre = el("div", "artifact-preview");
        pre.innerHTML = md(d.body || "");
        dlg.appendChild(pre);
        dlg.appendChild(btn("关闭", "ghost", () => dlg.remove()));
        $("view").insertBefore(dlg, $("view").firstChild);
      } catch (e) { toast("读取失败：" + e.message); }
    }));
    it.appendChild(row);
    list.appendChild(it);
  }
  if (!list.childNodes.length) list.appendChild(el("div", "muted", "还没有技能。"));
  card.appendChild(list);
  g.appendChild(card);

  const dirs = el("details", "kb-management");
  dirs.appendChild(el("summary", null, "存储位置"));
  if (data.userDir) dirs.appendChild(el("p", "path-line", "我的技能：" + data.userDir));
  for (const d of (data.sharedDirs || [])) dirs.appendChild(el("p", "path-line", "共享目录：" + d));
  if (data.bundledDir) dirs.appendChild(el("p", "path-line", "内置技能：" + data.bundledDir));
  g.appendChild(dirs);
  return g;
}

function settingsAbout() {
  const g = document.createDocumentFragment();
  const k = state.kernel || {};
  /* 品牌位：浅色用带浅底的 logo，深色用带深底的 logo（透明那版留给标题栏与窗口图标）。 */
  const brand = el("div", "about-brand");
  const logo = el("img", "about-logo");
  logo.src = state.dark ? "/logo-dark.png" : "/logo-light.png";
  logo.alt = "Lumin";
  brand.appendChild(logo);
  const bt = el("div", "about-brand-text");
  bt.appendChild(el("div", "about-brand-name", "Lumin"));
  bt.appendChild(el("div", "muted sm", "本地个人学习助手 · 数据只存在这台电脑上"));
  brand.appendChild(bt);
  g.appendChild(brand);
  const ver = cardOf({ title: "当前版本" });
  const kv = el("div", "kv-list");
  const line = (key, val) => {
    const l = el("div", "kv-line");
    l.appendChild(el("span", "kv-key", key));
    l.appendChild(el("span", "grow", val));
    return l;
  };
  kv.appendChild(line("应用", "Lumin " + (state.release?.version || k.version || "0.2.0") + " · 个人学习助手"));
  kv.appendChild(line("构建", (state.release?.sourceCommit && state.release.sourceCommit !== "development")
    ? state.release.sourceCommit : "开发版"));
  kv.appendChild(line("内核", "仓颉（Cangjie）运行时" + (k.cangjie ? " · " + k.cangjie : "")));
  kv.appendChild(line("数据目录", state.cfg.dataDir || "（启动时由内核决定，可在「数据与备份」里复制路径）"));
  ver.appendChild(kv);
  g.appendChild(ver);

  const about = cardOf({ title: "数据与隐私" });
  const ul = el("ul", "about-list");
  [
    "配置、学习记录与索引保存在本机数据库，可整体备份。",
    "资料只发送到你配置的模型服务。",
    "密钥仅保存在本机，界面不会回传。",
    "讲义与练习保存在本地 artifacts 目录。",
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
                btn("生成练习", "", () => { dlg.remove(); askTopic("quiz", chapter); })],
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
  foot.appendChild(btn("去错题本", "ghost", () => openWrong()));
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

/**
 * 让 Lumin 把这份资料整理成一份教学目录。
 *
 * 这是一次模型调用（不是让模型去读写文件）：内核把资料清单喂给模型，模型只回一份 JSON，
 * 校验后落成 <数据目录>/kb/<id>/outline.json，建索引时自动按它组织章节。
 */
async function organizeKb(kbId) {
  if (!kbId) { toast("先选择一个知识库"); return; }
  const v = $("view");
  const card = progressCard("正在整理：「" + kbName(kbId) + "」", ["读资料清单", "让模型给出目录", "校验并落盘"]);
  v.insertBefore(card, v.firstChild);
  card.scrollIntoView({ block: "start" });
  try {
    const r = await api("/api/kb/organize", { id: kbId });
    card._stop();
    card.remove();
    const box = cardOf({ cls: "dialog ok-dialog", title: "整理好了", tag: r.chapters + " 章", tagCls: "ok" });
    box.appendChild(el("p", "muted", r.note || ""));
    box.appendChild(el("p", "muted sm", "章节：" + r.chapters + " · 归入文档：" + r.docs + " 篇" +
      (r.missing > 0 ? " · 模型没提到的 " + r.missing + " 篇已接在「其他资料」里" : "") +
      (r.dropped > 0 ? " · 丢掉了 " + r.dropped + " 条无效路径" : "")));
    const row = el("div", "row");
    row.appendChild(btn("重建索引", "primary", () => { box.remove(); buildIndex(kbId); }));
    row.appendChild(btn("清除整理", "ghost", async () => {
      try {
        await api("/api/kb/organize", { id: kbId, clear: true });
        toast("已清除，回到按材料标题分章");
        box.remove();
        go("settings", "kb");
      } catch (e) { toast("清除失败：" + e.message); }
    }));
    row.appendChild(btn("收起", "ghost", () => box.remove()));
    box.appendChild(row);
    v.insertBefore(box, v.firstChild);
    toast("整理完成：" + r.chapters + " 章");
  } catch (e) {
    card._stop();
    card.remove();
    const box = cardOf({ cls: "dialog", title: "整理失败" });
    box.appendChild(el("p", "muted", e.message));
    box.appendChild(el("p", "muted sm", "失败不影响原有索引，可以直接重建索引或重试。"));
    box.appendChild(btn("关闭", "ghost", () => box.remove()));
    v.insertBefore(box, v.firstChild);
    toast("整理失败：" + e.message);
  }
}

async function buildIndex(kbId) {
  if (!kbId) { toast("先选择一个知识库"); return; }
  const v = $("view");
  const card = progressCard("正在准备资料：「" + kbName(kbId) + "」", ["扫描目录", "按章节整理内容片段", "识别图片（需要视觉模型）", "建立语义搜索（可选）", "写入本机数据库"]);
  v.insertBefore(card, v.firstChild);
  card.scrollIntoView({ block: "start" });
  try {
    const st = await api("/api/kb/build", { id: kbId });
    card._stop();
    card.remove();
    await loadCfg();
    await loadReport();
    const box = cardOf({ cls: "dialog ok-dialog", title: "资料准备完成", tag: "已就绪", tagCls: "ok" });
    const grid = el("div", "grid grid-4");
    grid.appendChild(statCard("文档", st.docCount || 0, "篇"));
    grid.appendChild(statCard("内容片段", st.chunkCount || 0, "片"));
    grid.appendChild(statCard("图片", st.imageCount || 0, "张"));
    grid.appendChild(statCard("图片描述", st.captioned || 0, "条"));
    box.appendChild(grid);
    if (st.embedError) {
      // 向量服务不给 /embeddings 是"少了一种检索方式"，不是"资料准备失败"——用琥珀色说清楚
      const warn = el("div", "skip-note");
      warn.appendChild(el("div", "skip-title", "索引已准备好，暂未开启语义搜索"));
      warn.appendChild(el("div", "muted sm", "原因：" + shortReason(st.embedError) + "（关键词检索照常）"));
      box.appendChild(warn);
    } else if (!st.embedded) {
      box.appendChild(el("p", "muted sm", "没有绑定向量模型，用关键词检索（不影响正常使用）。"));
    }
    if (st.skippedTotal > 0) {
      // 用户最可能遇到的情况：把 PDF/Word 放进目录却没被读到。静默跳过等于让他以为软件坏了。
      const warn = el("div", "skip-note");
      warn.appendChild(el("div", "skip-title", "有 " + st.skippedTotal + " 个文件没纳入：" + (st.skippedSummary || "")));
      warn.appendChild(el("div", "muted sm", "内核读 Markdown / 文本 / CSV / HTML / 日志 / JSON；PDF、Word、PPT 请先转成 Markdown 或文本。"));
      box.appendChild(warn);
    }
    const row = el("div", "row");
    row.appendChild(btn("去学 · 练", "primary", () => go("learn")));
    row.appendChild(btn("去检索", "", () => go("kb")));
    row.appendChild(btn("收起", "ghost", () => box.remove()));
    box.appendChild(row);
    v.insertBefore(box, v.firstChild);
    toast("资料准备完成：" + st.docCount + " 篇 / " + st.chunkCount + " 片");
    return true;
  } catch (e) {
    card._stop();
    card.remove();
    const box = cardOf({ cls: "dialog", title: "准备资料失败" });
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
    toast("资料准备失败：" + e.message);
    return false;
  }
}

/* ---------- 启动 ---------- */

async function boot() {
  initTitlebar();
  initZoomKeys();
  buildNav();
  /* 深链接：`lumin://thread/<id>`（窗口被链接拉起、或程序已在跑时把链接转交给它）。
     点开会话链接就直达那一段对话 —— 与 Codex 的 codex://threads/<id> 同一个用法。 */
  if (window.itnWindow && typeof window.itnWindow.onDeepLink === "function") {
    window.itnWindow.onDeepLink((sid) => {
      if (!sid) return;
      loadSessions().then(() => openChatSession(sid)).catch(() => openChatSession(sid));
    });
  }
  // 偏好要在首屏之前读：否则深色用户会先看到一帧白底
  await loadPrefs();
  await loadWebMode();
  buildNav();
  try {
    const h = await api("/health");
    state.kernel = h;
    try { state.release = await fetch('/release.json').then(r=>r.ok?r.json():null); } catch(e) {state.release=null;}
    setStatus("内核已连接");
    startConnectionMonitor();
  } catch (e) {
    setStatus("内核未连接", true);
    startConnectionMonitor();
    const v = $("view");
    v.innerHTML = "";
    v.appendChild(emptyState({
      art: "alert",
      title: "内核没有连上",
      text: e.message + "。桌面窗口会自动带起内核；如果是直接在浏览器里打开，请先运行 tools/ui-flow.ps1。",
      actions: [btn("重新连接", "primary", () => boot())],
    }));
    finishBootSplash();   // 内核没连上也要把开屏收掉，错误页才看得见
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
  finishBootSplash();
}

