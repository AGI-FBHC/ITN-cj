/* ITN-Desktop 前端：无框架、无构建，界面由仓颉内核托管 */

const $ = (id) => document.getElementById(id);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

const state = {
  settings: { models: [], knowledgeBases: [] },
  profile: null, report: null, tree: null,
  currentKb: "", chapter: null, chat: [],
};

async function api(path, body) {
  const init = { method: body === undefined ? "GET" : "POST" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const json = await res.json();
  if (json.code !== 0) throw new Error(json.message || "请求失败");
  return json.data;
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function setStatus(text, isErr) {
  const s = $("status");
  s.textContent = text;
  s.classList.toggle("err", !!isErr);
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function md(src) {
  const lines = esc(src || "").split("\n");
  const out = [];
  let inCode = false, listType = null;
  const closeList = () => { if (listType) { out.push(listType === "ul" ? "</ul>" : "</ol>"); listType = null; } };
  const inline = (s) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*```/.test(line)) { closeList(); out.push(inCode ? "</code></pre>" : "<pre><code>"); inCode = !inCode; continue; }
    if (inCode) { out.push(raw); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); const n = h[1].length; out.push("<h" + n + ">" + inline(h[2]) + "</h" + n + ">"); continue; }
    if (/^\s*$/.test(line)) { closeList(); continue; }
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

function option(value, label) {
  const o = document.createElement("option");
  o.value = value; o.textContent = label; return o;
}

function pct(a, b) { return b > 0 ? Math.round(a / b * 100) : 0; }

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
};

function icon(name) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="' + (ICONS[name] || ICONS.home) + '"/></svg>';
}

const NAV = [
  { group: "学习", items: [
    { id: "home", label: "我的学习", icon: "home" },
    { id: "learn", label: "学 · 练", icon: "book" },
    { id: "report", label: "我的成长", icon: "chart" },
  ]},
  { group: "内容", items: [
    { id: "resources", label: "我的资源", icon: "file" },
    { id: "kb", label: "领域知识库", icon: "db" },
  ]},
  { group: "辅助", items: [
    { id: "chat", label: "伴学助手", icon: "chat" },
    { id: "notes", label: "我的笔记", icon: "note" },
    { id: "wrong", label: "错题本", icon: "flag" },
  ]},
  { group: "系统", items: [
    { id: "models", label: "模型与接口", icon: "gear" },
    { id: "settings", label: "档案与知识库", icon: "note" },
  ]},
];

let current = "home";

function buildNav() {
  const nav = $("nav");
  nav.innerHTML = "";
  for (const g of NAV) {
    const box = el("div", "nav-group");
    const title = el("div", "nav-group-title");
    title.textContent = g.group;
    box.appendChild(title);
    for (const it of g.items) {
      const b = el("button", "nav-item" + (it.id === current ? " active" : ""));
      b.innerHTML = icon(it.icon) + "<span>" + it.label + "</span>";
      b.onclick = () => go(it.id);
      box.appendChild(b);
    }
    nav.appendChild(box);
  }
}

const PAGE_META = {
  home: { title: "我的学习", sub: "今天学什么，从这里开始" },
  learn: { title: "学 · 练", sub: "按章节读资料、做题、记笔记" },
  report: { title: "我的成长", sub: "学习记录与能力变化" },
  resources: { title: "我的资源", sub: "生成的讲义与练习" },
  kb: { title: "领域知识库", sub: "检索资料，每一句都能追到原文" },
  chat: { title: "伴学助手", sub: "就你的资料提问" },
  notes: { title: "我的笔记", sub: "随手记下的要点" },
  wrong: { title: "错题本", sub: "做错的题在这里复习" },
  models: { title: "模型与接口", sub: "填写自己的模型服务，统一 OpenAI 兼容格式" },
  settings: { title: "档案与知识库", sub: "学习者档案与本地资料目录" },
};

async function go(page) {
  current = page;
  buildNav();
  const meta = PAGE_META[page] || PAGE_META.home;
  $("page-title").textContent = meta.title;
  $("page-sub").textContent = meta.sub;
  $("top-actions").innerHTML = "";
  $("view").innerHTML = '<div class="empty"><span class="spinner"></span> 加载中…</div>';
  try {
    await PAGES[page].render();
  } catch (e) {
    $("view").innerHTML = '<div class="empty"><strong>加载失败</strong>' + esc(e.message) + "</div>";
  }
}

async function refreshSettings() {
  state.settings = await api("/api/settings");
  if (!state.currentKb && state.settings.knowledgeBases.length) {
    state.currentKb = state.settings.knowledgeBases[0].id;
  }
}

async function refreshProfile() {
  state.profile = await api("/api/profile/get", {});
}

function kbSelector(onChange) {
  const sel = el("select");
  if (!state.settings.knowledgeBases.length) {
    sel.appendChild(option("", "（还没有知识库）"));
    sel.disabled = true;
  } else {
    for (const kb of state.settings.knowledgeBases) {
      sel.appendChild(option(kb.id, kb.name || kb.id));
    }
    sel.value = state.currentKb;
  }
  sel.onchange = () => { state.currentKb = sel.value; if (onChange) onChange(); };
  return sel;
}

function needKb(container) {
  container.innerHTML = '<div class="empty"><strong>还没有建立知识库</strong>到「设置」里指定一个本地资料目录，再回到「学 · 练」建立索引。</div>';
}

const PAGES = {};

PAGES.home = {
  async render() {
    await refreshSettings();
    await refreshProfile();
    state.report = await api("/api/study/report", {});
    const v = $("view");
    v.innerHTML = "";

    const hello = el("div", "card");
    hello.innerHTML = '<div class="card-head"><h2>' +
      (state.profile.nickname ? esc(state.profile.nickname) + "，继续加油" : "欢迎使用") +
      '</h2></div><p class="muted">' +
      (state.profile.goal ? "目标：" + esc(state.profile.goal) : "还没有设置学习目标，可以到「设置」里填一个。") +
      (state.profile.weeklyHours ? " · 每周可投入 " + state.profile.weeklyHours + " 小时" : "") +
      "</p>";
    v.appendChild(hello);

    const r = state.report;
    const stats = el("div", "grid grid-4");
    const cards = [
      ["已读切片", r.readChunks, ""],
      ["完成章节", r.completedChapters, ""],
      ["笔记", r.noteCount, "条"],
      ["答题正确率", r.quizTotal ? pct(r.quizRight, r.quizTotal) : 0, "%"],
    ];
    for (const c of cards) {
      const s = el("div", "stat");
      s.innerHTML = '<div class="k">' + c[0] + '</div><div class="v">' + c[1] + '<span class="u">' + c[2] + "</span></div>";
      stats.appendChild(s);
    }
    v.appendChild(stats);

    const cont = el("div", "card");
    cont.innerHTML = '<div class="card-head"><h2>继续学习</h2></div>';
    if (!state.settings.knowledgeBases.length) {
      cont.innerHTML += '<div class="empty"><strong>还没有知识库</strong>先到「设置」指定一个资料目录。</div>';
    } else {
      try {
        const tree = await api("/api/study/tree", { kbId: state.currentKb });
        const next = tree.chapters.find((c) => !c.done);
        if (!next) {
          cont.innerHTML += '<p class="muted">所有章节都读完了。</p>';
          const b = el("button", "btn primary");
          b.textContent = "看看生成的资源";
          b.onclick = () => go("resources");
          cont.appendChild(b);
        } else {
          const p2 = pct(next.readCount, next.chunkCount);
          cont.innerHTML += '<div class="item-title">' + esc(next.name) + "</div>" +
            '<p class="muted sm">' + next.readCount + " / " + next.chunkCount + " 片已读 · " + next.sectionCount + " 个小节</p>" +
            '<div class="bar"><i style="width:' + p2 + '%"></i></div>';
          const b = el("button", "btn primary");
          b.style.marginTop = "12px";
          b.textContent = "继续学习这一章";
          b.onclick = () => { state.chapter = next.name; go("learn"); };
          cont.appendChild(b);
        }
      } catch (e) {
        cont.innerHTML += '<p class="muted">' + esc(e.message) + "</p>";
      }
    }
    v.appendChild(cont);
  },
};

PAGES.learn = {
  async render() {
    await refreshSettings();
    const v = $("view");
    v.innerHTML = "";
    if (!state.settings.knowledgeBases.length) { needKb(v); return; }

    const head = el("div", "card");
    const row = el("div", "row");
    row.appendChild(kbSelector(() => { state.chapter = null; go("learn"); }));
    const tip = el("div", "muted sm grow");
    tip.textContent = state.chapter ? "正在学习：" + state.chapter : "选择一个知识库，然后挑一章开始学";
    row.appendChild(tip);
    head.appendChild(row);
    v.appendChild(head);

    if (!state.chapter) {
      const tree = await api("/api/study/tree", { kbId: state.currentKb });
      const card = el("div", "card");
      card.innerHTML = '<div class="card-head"><h2>知识网络</h2><div class="spacer"></div><span class="tag">' +
        tree.chapters.length + " 章 · " + tree.chunkCount + " 片 · " + tree.docCount + " 篇文档</span></div>";
      const list = el("div", "list");
      for (const c of tree.chapters) {
        const it = el("div", "item clickable");
        const p2 = pct(c.readCount, c.chunkCount);
        it.innerHTML = '<div class="row"><div class="grow"><div class="item-title">' + esc(c.name) + "</div>" +
          '<div class="muted sm">' + c.sectionCount + " 个小节 · " + c.chunkCount + " 片 · 来自 " + c.docCount + " 篇文档</div></div>" +
          (c.done ? '<span class="tag ok">已完成</span>' : '<span class="tag">' + p2 + "%</span>") + "</div>" +
          '<div class="bar" style="margin-top:8px"><i style="width:' + p2 + '%"></i></div>';
        it.onclick = () => { state.chapter = c.name; go("learn"); };
        list.appendChild(it);
      }
      card.appendChild(list);
      v.appendChild(card);
      return;
    }

    const chap = await api("/api/study/chapter", { kbId: state.currentKb, chapter: state.chapter });
    const bar = el("div", "row");
    bar.style.marginBottom = "14px";
    const back = el("button", "btn");
    back.textContent = "← 返回知识网络";
    back.onclick = () => { state.chapter = null; go("learn"); };
    bar.appendChild(back);
    const quizBtn = el("button", "btn primary");
    quizBtn.textContent = "出题练习";
    quizBtn.onclick = () => openQuiz(v, state.chapter);
    bar.appendChild(quizBtn);
    const noteBtn = el("button", "btn");
    noteBtn.textContent = "写笔记";
    noteBtn.onclick = () => openNoteEditor(null, state.currentKb, state.chapter);
    bar.appendChild(noteBtn);
    const doneBtn = el("button", "btn");
    doneBtn.textContent = "标记本章已读完";
    doneBtn.onclick = async () => {
      for (const c of chap.chunks) {
        await api("/api/study/read", { kbId: state.currentKb, chunkId: c.id, chapter: state.chapter, chapterDone: true });
      }
      toast("已标记完成");
      go("learn");
    };
    bar.appendChild(doneBtn);
    v.appendChild(bar);

    for (const c of chap.chunks) {
      const box = el("div", "card");
      box.innerHTML = '<div class="card-head"><h2 class="sm muted" style="font-weight:500">' + esc(c.headingPath || c.docTitle) + "</h2>" +
        '<div class="spacer"></div>' + (c.read ? '<span class="tag ok">已读</span>' : "") + "</div>";
      const body = el("div");
      body.innerHTML = md(c.text);
      box.appendChild(body);
      if (c.caption) {
        const cap = el("p", "muted sm");
        cap.textContent = "图片说明：" + c.caption;
        box.appendChild(cap);
      }
      const btns = el("div", "row");
      btns.style.marginTop = "10px";
      const readBtn = el("button", "btn sm");
      readBtn.textContent = c.read ? "重新标记为已读" : "标记已读";
      readBtn.onclick = async () => {
        await api("/api/study/read", { kbId: state.currentKb, chunkId: c.id, chapter: state.chapter });
        toast("已标记");
        go("learn");
      };
      btns.appendChild(readBtn);
      box.appendChild(btns);
      v.appendChild(box);
    }
  },
};

PAGES.report = {
  async render() {
    await refreshProfile();
    const r = await api("/api/study/report", {});
    const v = $("view");
    v.innerHTML = "";

    const stats = el("div", "grid grid-4");
    const cards = [["已读切片", r.readChunks], ["完成章节", r.completedChapters], ["答题总数", r.quizTotal], ["错题", r.quizWrong]];
    for (const c of cards) {
      const s = el("div", "stat");
      s.innerHTML = '<div class="k">' + c[0] + '</div><div class="v">' + c[1] + "</div>";
      stats.appendChild(s);
    }
    v.appendChild(stats);

    const ability = el("div", "card");
    ability.innerHTML = '<div class="card-head"><h2>自评能力</h2><div class="spacer"></div><span class="muted sm">可在「设置」里更新</span></div>';
    const scores = (r.profile && r.profile.selfScores) ? r.profile.selfScores : {};
    const keys = Object.keys(scores);
    if (!keys.length) {
      ability.innerHTML += '<div class="empty">还没有填写自评能力。</div>';
    } else {
      for (const k of keys) {
        const val = scores[k];
        const line = el("div");
        line.style.marginBottom = "10px";
        line.innerHTML = '<div class="row"><span class="grow">' + esc(k) + '</span><span class="muted sm">' + val + '</span></div>' +
          '<div class="bar"><i style="width:' + val + '%"></i></div>';
        ability.appendChild(line);
      }
    }
    v.appendChild(ability);

    const quiz = await api("/api/study/wrong", {});
    const recent = el("div", "card");
    recent.innerHTML = '<div class="card-head"><h2>错题回顾</h2><div class="spacer"></div><span class="tag">' + quiz.records.length + " 条</span></div>";
    if (!quiz.records.length) {
      recent.innerHTML += '<div class="empty">还没有错题。</div>';
    } else {
      const list = el("div", "list");
      for (const q of quiz.records.slice(0, 5)) {
        const it = el("div", "item");
        it.innerHTML = '<div class="item-title">' + esc(q.question) + "</div>" +
          '<div class="sm muted">我的答案：' + esc(q.myAnswer) + "</div>" +
          (q.reference ? '<div class="sm muted">参考答案：' + esc(q.reference) + "</div>" : "");
        list.appendChild(it);
      }
      recent.appendChild(list);
    }
    v.appendChild(recent);
  },
};

PAGES.resources = {
  async render() {
    const v = $("view");
    v.innerHTML = "";
    const data = await api("/api/artifacts/list", {});
    const card = el("div", "card");
    card.innerHTML = '<div class="card-head"><h2>已生成的产物</h2><div class="spacer"></div><span class="tag">' + data.artifacts.length + " 份</span></div>";
    if (!data.artifacts.length) {
      card.innerHTML += '<div class="empty"><strong>还没有产物</strong>到「学 · 练」里让助手生成讲义或练习。</div>';
    } else {
      const list = el("div", "list");
      for (const a of data.artifacts) {
        const it = el("div", "item clickable");
        it.innerHTML = '<div class="item-title">' + esc(a.name) + '</div><div class="muted sm">' + a.size + " 字节 · 存放于本机</div>";
        it.onclick = async () => {
          const d = await api("/api/artifacts/read", { name: a.name });
          v.innerHTML = "";
          const top = el("div", "card");
          top.innerHTML = '<div class="card-head"><button class="btn ghost sm" id="back2">← 返回产物列表</button><h2 style="margin-left:6px">' + esc(a.name) + "</h2></div>";
          top.querySelector("#back2").onclick = () => go("resources");
          v.appendChild(top);
          const body = el("div", "card");
          body.innerHTML = md(d.content);
          v.appendChild(body);
        };
        list.appendChild(it);
      }
      card.appendChild(list);
    }
    v.appendChild(card);
  },
};

PAGES.kb = {
  async render() {
    await refreshSettings();
    const v = $("view");
    v.innerHTML = "";
    if (!state.settings.knowledgeBases.length) { needKb(v); return; }

    const card = el("div", "card");
    card.innerHTML = '<div class="card-head"><h2>检索资料</h2><div class="spacer"></div><span class="muted sm">命中的每一段都能追到原文档与章节</span></div>';
    const row = el("div", "row");
    row.appendChild(kbSelector(null));
    const q = el("input");
    q.className = "grow";
    q.placeholder = "输入关键词或问题，例如「少样本示例」";
    row.appendChild(q);
    const btn = el("button", "btn primary");
    btn.textContent = "检索";
    row.appendChild(btn);
    card.appendChild(row);
    const out = el("div");
    out.style.marginTop = "14px";
    card.appendChild(out);
    v.appendChild(card);

    async function run() {
      const query = q.value.trim();
      if (!query) { toast("请先输入内容"); return; }
      out.innerHTML = '<span class="spinner"></span> 检索中…';
      try {
        const d = await api("/api/kb/search", { id: state.currentKb, query: query, topK: 6 });
        out.innerHTML = '<p class="muted sm">命中 ' + d.hits.length + " 条" + (d.mode ? " · " + d.mode + "检索" : "") + "</p>";
        const list = el("div", "list");
        for (const h of d.hits) {
          const it = el("div", "item");
          it.innerHTML = '<div class="item-title">《' + esc(h.docTitle) + "》" + (h.headingPath ? " · " + esc(h.headingPath) : "") + "</div>" +
            '<div class="muted sm">' + esc(h.docPath) + " · 相似度 " + Number(h.score || 0).toFixed(3) + "</div>";
          const body = el("div");
          body.innerHTML = md(h.text);
          it.appendChild(body);
          if (h.caption) {
            const cap = el("p", "muted sm");
            cap.textContent = "图片说明：" + h.caption;
            it.appendChild(cap);
          }
          list.appendChild(it);
        }
        out.appendChild(list);
      } catch (e) {
        out.innerHTML = '<div class="empty">' + esc(e.message) + "</div>";
      }
    }
    btn.onclick = run;
    q.onkeydown = (e) => { if (e.key === "Enter") run(); };
  },
};

PAGES.chat = {
  async render() {
    await refreshSettings();
    const v = $("view");
    v.innerHTML = "";
    const ops = el("div", "card");
    const row = el("div", "row");
    row.appendChild(kbSelector(null));
    const clear = el("button", "btn");
    clear.textContent = "清空对话";
    clear.onclick = () => { state.chat = []; go("chat"); };
    row.appendChild(clear);
    ops.appendChild(row);
    v.appendChild(ops);

    const box = el("div", "card");
    v.appendChild(box);

    const inputRow = el("div", "row");
    const q = el("input");
    q.className = "grow";
    q.placeholder = "就你的资料提一个问题";
    const send = el("button", "btn primary");
    send.textContent = "发送";
    inputRow.appendChild(q);
    inputRow.appendChild(send);
    v.appendChild(inputRow);

    function paint() {
      box.innerHTML = "";
      if (!state.chat.length) {
        box.innerHTML = '<div class="empty">' + (state.settings.knowledgeBases.length ? "就你的资料提一个问题，回答会标注出处。" : "先到「设置」建立知识库。") + "</div>";
        return;
      }
      for (const m of state.chat) {
        const it = el("div", "item");
        it.style.marginBottom = "10px";
        it.innerHTML = '<div class="muted sm">' + (m.role === "user" ? "我" : "助手") + "</div>";
        const body = el("div");
        body.innerHTML = md(m.text);
        it.appendChild(body);
        if (m.citations && m.citations.length) {
          const ul = el("ul", "cite-list");
          for (const c of m.citations) {
            const li = el("li");
            li.textContent = "[" + c.index + "] 《" + c.docTitle + "》" + (c.headingPath ? " · " + c.headingPath : "") + "（" + c.docPath + "）";
            ul.appendChild(li);
          }
          it.appendChild(ul);
        }
        box.appendChild(it);
      }
    }
    paint();

    async function ask() {
      const text = q.value.trim();
      if (!text) return;
      q.value = "";
      state.chat.push({ role: "user", text: text });
      paint();
      const pending = el("div", "item");
      pending.innerHTML = '<span class="spinner"></span> 正在检索资料并作答…';
      box.appendChild(pending);
      try {
        const d = await api("/api/agent/ask", { kbId: state.currentKb, question: text });
        state.chat.push({ role: "ai", text: d.answer || d.message || "", citations: d.citations });
      } catch (e) {
        state.chat.push({ role: "ai", text: "失败：" + e.message });
      }
      paint();
    }
    send.onclick = ask;
    q.onkeydown = (e) => { if (e.key === "Enter") ask(); };
  },
};

PAGES.notes = {
  async render() {
    const v = $("view");
    v.innerHTML = "";
    const add = el("div", "row");
    add.style.marginBottom = "14px";
    const b = el("button", "btn primary");
    b.textContent = "写一条笔记";
    b.onclick = () => openNoteEditor(null, state.currentKb, state.chapter || "");
    add.appendChild(b);
    v.appendChild(add);

    const data = await api("/api/study/notes/list", {});
    const card = el("div", "card");
    card.innerHTML = '<div class="card-head"><h2>全部笔记</h2><div class="spacer"></div><span class="tag">' + data.notes.length + " 条</span></div>";
    if (!data.notes.length) {
      card.innerHTML += '<div class="empty">还没有笔记。</div>';
    } else {
      const list = el("div", "list");
      for (const n of data.notes) {
        const it = el("div", "item");
        it.innerHTML = '<div class="item-title">' + esc(n.title || "无标题") + "</div>" +
          (n.chapter ? '<div class="muted sm">' + esc(n.chapter) + "</div>" : "");
        const body = el("div");
        body.innerHTML = md(n.text);
        it.appendChild(body);
        const acts = el("div", "row");
        acts.style.marginTop = "8px";
        const e1 = el("button", "btn sm");
        e1.textContent = "编辑";
        e1.onclick = () => openNoteEditor(n, n.kbId, n.chapter);
        const e2 = el("button", "btn sm");
        e2.textContent = "删除";
        e2.onclick = async () => { await api("/api/study/notes/delete", { id: n.id }); toast("已删除"); go("notes"); };
        acts.appendChild(e1); acts.appendChild(e2);
        it.appendChild(acts);
        list.appendChild(it);
      }
      card.appendChild(list);
    }
    v.appendChild(card);
  },
};

PAGES.wrong = {
  async render() {
    const v = $("view");
    v.innerHTML = "";
    const data = await api("/api/study/wrong", {});
    const card = el("div", "card");
    card.innerHTML = '<div class="card-head"><h2>错题本</h2><div class="spacer"></div><span class="tag">' + data.records.length + " 条</span></div>";
    if (!data.records.length) {
      card.innerHTML += '<div class="empty"><strong>还没有错题</strong>做完练习后，答错的题会自动收进来。</div>';
    } else {
      const list = el("div", "list");
      for (const q of data.records) {
        const it = el("div", "item");
        it.innerHTML = '<div class="item-title">' + esc(q.question) + "</div>" +
          '<div class="sm">我的答案：<span style="color:var(--err)">' + esc(q.myAnswer) + "</span></div>" +
          (q.reference ? '<div class="sm">参考答案：<span style="color:var(--ok)">' + esc(q.reference) + "</span></div>" : "") +
          (q.chapter ? '<div class="muted sm">来自：' + esc(q.chapter) + "</div>" : "");
        list.appendChild(it);
      }
      card.appendChild(list);
    }
    v.appendChild(card);
  },
};

PAGES.settings = {
  async render() {
    await refreshSettings();
    await refreshProfile();
    const v = $("view");
    v.innerHTML = "";

    const prof = el("div", "card");
    prof.innerHTML = '<div class="card-head"><h2>学习者档案</h2><div class="spacer"></div><span class="muted sm">只存在本机</span></div>';
    const p0 = state.profile || {};
    f1 = el("div", "row");
    f1.innerHTML = '<div class="field grow"><label>称呼</label><input id="pf-name" value="' + esc(p0.nickname) + '"></div>' +
      '<div class="field grow"><label>学习目标</label><input id="pf-goal" value="' + esc(p0.goal) + '"></div>' +
      '<div class="field" style="width:150px"><label>每周投入（小时）</label><input id="pf-hours" type="number" min="1" value="' + (p0.weeklyHours || 8) + '"></div>';
    prof.appendChild(f1);
    const dims = ["概念理解", "逻辑推理", "工程实践", "问题诊断", "系统设计", "学习迁移"];
    const cur = p0.selfScores || {};
    const scoreBox = el("div", "grid grid-3");
    for (const d of dims) {
      const f = el("div", "field");
      f.innerHTML = '<label>' + d + '（0-100）</label><input data-dim="' + d + '" type="number" min="0" max="100" value="' + (cur[d] != null ? cur[d] : 60) + '">';
      scoreBox.appendChild(f);
    }
    prof.appendChild(scoreBox);
    const saveP = el("button", "btn primary");
    saveP.textContent = "保存档案";
    saveP.onclick = async () => {
      const scores = {};
      prof.querySelectorAll("input[data-dim]").forEach((i) => { scores[i.dataset.dim] = Number(i.value) || 0; });
      await api("/api/profile/save", {
        nickname: $("pf-name").value.trim(),
        goal: $("pf-goal").value.trim(),
        weeklyHours: Number($("pf-hours").value) || 8,
        preferredFormats: ["讲义", "练习"],
        selfScores: scores,
      });
      toast("档案已保存");
      await refreshProfile();
    };
    prof.appendChild(saveP);
    v.appendChild(prof);

    const kb = el("div", "card");
    kb.innerHTML = '<div class="card-head"><h2>知识库</h2><div class="spacer"></div><span class="muted sm">指定本地目录，递归读取 Markdown 与纯文本</span></div>';
    kb.innerHTML += '<div class="row"><div class="field" style="width:150px"><label>标识</label><input id="kb-id" placeholder="course"></div>' +
      '<div class="field grow"><label>显示名称</label><input id="kb-name" placeholder="我的课程资料"></div></div>' +
      '<div class="field"><label>目录绝对路径</label><input id="kb-dir" placeholder="D:\\资料\\课程"></div>';
    const kacts = el("div", "row");
    const kbSave = el("button", "btn primary");
    kbSave.textContent = "保存知识库";
    kbSave.onclick = async () => {
      const id = $("kb-id").value.trim();
      if (!id) { toast("请填写标识"); return; }
      await api("/api/kb/save", { id: id, name: $("kb-name").value.trim(), rootDir: $("kb-dir").value.trim() });
      toast("已保存");
      state.currentKb = id;
      go("settings");
    };
    const kbBuild = el("button", "btn");
    kbBuild.textContent = "建立索引";
    kbBuild.onclick = async () => {
      const id = $("kb-id").value.trim() || state.currentKb;
      if (!id) { toast("请先保存知识库"); return; }
      kbBuild.disabled = true;
      kbBuild.textContent = "建立中…";
      try {
        const st = await api("/api/kb/build", { id: id });
        toast("索引完成：" + st.docCount + " 篇 / " + st.chunkCount + " 片" + (st.captioned ? " / 图片描述 " + st.captioned + " 条" : ""));
        await refreshSettings();
        go("settings");
      } catch (e) { toast("失败：" + e.message); kbBuild.disabled = false; kbBuild.textContent = "建立索引"; }
    };
    kacts.appendChild(kbSave); kacts.appendChild(kbBuild);
    kb.appendChild(kacts);
    if (state.settings.knowledgeBases.length) {
      const klist = el("div", "list");
      klist.style.marginTop = "12px";
      for (const k of state.settings.knowledgeBases) {
        const it = el("div", "item");
        it.innerHTML = '<div class="item-title">' + esc(k.name || k.id) + "</div>" +
          '<div class="muted sm">' + esc(k.rootDir) + "</div>" +
          '<div class="muted sm">' + (k.docCount || 0) + " 篇 · " + (k.chunkCount || 0) + " 片 · " + (k.imageCount || 0) + " 张图</div>";
        klist.appendChild(it);
      }
      kb.appendChild(klist);
    }
    v.appendChild(kb);
  },
};

var f1 = null;

PAGES.models = {
  async render() {
    await refreshSettings();
    const v = $("view");
    v.innerHTML = "";

    const mcard = el("div", "card");
    mcard.innerHTML = '<div class="card-head"><h2>添加 / 更新模型</h2><div class="spacer"></div>' +
      '<span class="muted sm">密钥只保存本机，接口不会回传</span></div>' +
      '<div class="row"><div class="field grow"><label>标识</label><input id="m-id" placeholder="例如 deepseek"></div>' +
      '<div class="field grow"><label>显示名称</label><input id="m-name" placeholder="例如 DeepSeek"></div></div>' +
      '<div class="row"><div class="field grow"><label>Base URL</label><input id="m-base" placeholder="https://api.deepseek.com/v1"></div>' +
      '<div class="field grow"><label>API Key</label><input id="m-key" type="password" placeholder="留空则保留原密钥"></div></div>' +
      '<div class="row"><div class="field grow"><label>对话模型</label><input id="m-model" placeholder="deepseek-chat"></div>' +
      '<div class="field grow"><label>多模态模型（可留空）</label><input id="m-vision"></div>' +
      '<div class="field grow"><label>向量模型（可留空）</label><input id="m-embed"></div></div>';
    const saveM = el("button", "btn primary");
    saveM.textContent = "保存模型";
    saveM.onclick = async () => {
      const id = $("m-id").value.trim();
      if (!id) { toast("请填写标识"); return; }
      try {
        await api("/api/models/save", {
          id: id, name: $("m-name").value.trim(), baseUrl: $("m-base").value.trim(),
          apiKey: $("m-key").value, model: $("m-model").value.trim(),
          visionModel: $("m-vision").value.trim(), embeddingModel: $("m-embed").value.trim(),
        });
        $("m-key").value = "";
        toast("模型已保存");
        go("models");
      } catch (e) { toast("保存失败：" + e.message); }
    };
    mcard.appendChild(saveM);
    v.appendChild(mcard);

    const list = el("div", "card");
    list.innerHTML = '<div class="card-head"><h2>已配置的模型</h2></div>';
    if (!state.settings.models.length) {
      list.innerHTML += '<div class="empty">还没有配置模型。</div>';
    } else {
      const box = el("div", "list");
      for (const m of state.settings.models) {
        const it = el("div", "item");
        it.innerHTML = '<div class="item-title">' + esc(m.name || m.id) + "</div>" +
          '<div class="muted sm">' + esc(m.baseUrl) + " · " + esc(m.model) + (m.hasApiKey ? " · 已设置密钥" : " · 未设置密钥") + "</div>";
        const acts = el("div", "row");
        acts.style.marginTop = "8px";
        const tb = el("button", "btn sm");
        tb.textContent = "测试连通";
        tb.onclick = async () => {
          tb.textContent = "测试中…"; tb.disabled = true;
          try { await api("/api/models/test", { id: m.id }); tb.textContent = "连通"; toast("模型连通"); }
          catch (e) { tb.textContent = "测试连通"; toast("失败：" + e.message); }
          tb.disabled = false;
        };
        const db = el("button", "btn sm");
        db.textContent = "删除";
        db.onclick = async () => { await api("/api/models/delete", { id: m.id }); toast("已删除"); go("models"); };
        acts.appendChild(tb); acts.appendChild(db);
        it.appendChild(acts);
        box.appendChild(it);
      }
      list.appendChild(box);
    }
    v.appendChild(list);

    const role = el("div", "card");
    role.innerHTML = '<div class="card-head"><h2>用途绑定</h2><div class="spacer"></div>' +
      '<span class="muted sm">向量模型可留空，留空时知识库检索退回关键词匹配</span></div>';
    const rr = el("div", "row");
    const mk = (id, label, val) => {
      const f = el("div", "field grow");
      const l = el("label"); l.textContent = label;
      const sel = el("select"); sel.id = id;
      sel.appendChild(option("", "（未指定）"));
      for (const m of state.settings.models) sel.appendChild(option(m.id, m.name || m.id));
      sel.value = val || "";
      f.appendChild(l); f.appendChild(sel);
      return f;
    };
    rr.appendChild(mk("role-chat", "对话与生成", state.settings.chatModelId));
    rr.appendChild(mk("role-embed", "向量检索", state.settings.embedModelId));
    rr.appendChild(mk("role-chunk", "切片与图片描述", state.settings.chunkModelId));
    role.appendChild(rr);
    const saveR = el("button", "btn primary");
    saveR.textContent = "保存绑定";
    saveR.onclick = async () => {
      await api("/api/models/roles", {
        chatModelId: $("role-chat").value,
        embedModelId: $("role-embed").value,
        chunkModelId: $("role-chunk").value,
      });
      toast("已保存");
      await refreshSettings();
    };
    role.appendChild(saveR);
    v.appendChild(role);
  },
};

async function openQuiz(container, chapter) {
  const dlg = el("div", "card");
  dlg.style.borderColor = "var(--accent)";
  dlg.innerHTML = '<div class="card-head"><h2>出题练习 · ' + esc(chapter) + '</h2><div class="spacer"></div>' +
    '<span class="spinner"></span><span class="muted sm"> 正在依据资料出题，请稍候</span></div>';
  container.insertBefore(dlg, container.firstChild);
  dlg.scrollIntoView({ block: "start" });
  let data;
  try {
    data = await api("/api/study/quiz/generate", { kbId: state.currentKb, chapter: chapter, count: 3 });
  } catch (e) {
    dlg.innerHTML = '<div class="card-head"><h2>出题失败</h2></div><p class="muted">' + esc(e.message) + "</p>";
    return;
  }
  const qs = data.questions || [];
  dlg.innerHTML = '<div class="card-head"><h2>出题练习 · ' + esc(chapter) + '</h2><div class="spacer"></div><span class="tag">' + qs.length + " 题</span></div>";
  if (!qs.length) {
    dlg.innerHTML += '<div class="empty">没有生成出题目，可以换个章节再试。</div>';
    return;
  }
  let answered = 0;
  qs.forEach((q, qi) => {
    const box = el("div");
    box.style.marginBottom = "16px";
    const title = el("div", "item-title");
    title.textContent = (qi + 1) + ". " + q.question;
    box.appendChild(title);
    const opts = q.options || [];
    const btns = [];
    opts.forEach((o, oi) => {
      const btn = el("button", "btn choice");
      btn.textContent = String.fromCharCode(65 + oi) + ". " + o;
      btn.onclick = async () => {
        if (box.dataset.done) return;
        box.dataset.done = "1";
        const ok = oi === q.answerIndex;
        btn.classList.add(ok ? "right" : "wrong");
        if (!ok && btns[q.answerIndex]) btns[q.answerIndex].classList.add("right");
        answered = answered + 1;
        const tip = el("div", "sm");
        tip.innerHTML = '<span class="tag ' + (ok ? "ok" : "warn") + '">' + (ok ? "答对了" : "答错了") + "</span> " +
          '<span class="muted">参考答案：' + esc(opts[q.answerIndex] || "") + "</span>" +
          (q.explain ? '<div class="muted" style="margin-top:6px">' + esc(q.explain) + "</div>" : "");
        box.appendChild(tip);
        try {
          await api("/api/study/quiz/submit", {
            kbId: state.currentKb, chapter: chapter, question: q.question,
            myAnswer: opts[oi], reference: opts[q.answerIndex] || "", correct: ok,
          });
        } catch (e) { /* 记录失败不影响答题 */ }
      };
      btns.push(btn);
      box.appendChild(btn);
    });
    dlg.appendChild(box);
  });
  const foot = el("div", "row");
  const close = el("button", "btn");
  close.textContent = "收起";
  close.onclick = () => { dlg.remove(); if (answered) go("learn"); };
  const wrongBtn = el("button", "btn");
  wrongBtn.textContent = "去错题本";
  wrongBtn.onclick = () => go("wrong");
  foot.appendChild(close); foot.appendChild(wrongBtn);
  dlg.appendChild(foot);
}

function openNoteEditor(note, kbId, chapter) {
  const v = $("view");
  const dlg = el("div", "card");
  dlg.style.borderColor = "var(--accent)";
  dlg.innerHTML = '<div class="card-head"><h2>' + (note ? "编辑笔记" : "写笔记") + "</h2>" +
    (chapter ? '<div class="spacer"></div><span class="muted sm">' + esc(chapter) + "</span>" : "") + "</div>" +
    '<div class="field"><label>标题</label><input id="nt-title" value="' + esc(note ? note.title : "") + '"></div>' +
    '<div class="field"><label>内容（支持 Markdown）</label><textarea id="nt-text" rows="6">' + esc(note ? note.text : "") + "</textarea></div>";
  const row = el("div", "row");
  const save = el("button", "btn primary");
  save.textContent = "保存";
  save.onclick = async () => {
    await api("/api/study/notes/save", {
      id: note ? note.id : "", kbId: kbId, chapter: chapter,
      title: $("nt-title").value.trim(), text: $("nt-text").value,
    });
    toast("笔记已保存");
    dlg.remove();
    if (current === "notes") go("notes");
  };
  const cancel = el("button", "btn");
  cancel.textContent = "取消";
  cancel.onclick = () => dlg.remove();
  row.appendChild(save); row.appendChild(cancel);
  dlg.appendChild(row);
  v.insertBefore(dlg, v.firstChild);
  dlg.scrollIntoView({ block: "start" });
}

async function boot() {
  buildNav();
  try {
    const h = await api("/health");
    setStatus("内核已连接 · " + h.cangjie);
  } catch (e) {
    setStatus("内核未连接", true);
    $("view").innerHTML = '<div class="empty"><strong>内核未连接</strong>' + esc(e.message) + "</div>";
    return;
  }
  try {
    await refreshSettings();
    await refreshProfile();
  } catch (e) {
    toast("读取配置失败：" + e.message);
  }
  go("home");
}

boot();
