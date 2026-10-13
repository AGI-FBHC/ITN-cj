const $ = (id) => document.getElementById(id);

/* 极简 Markdown 渲染：先转义 HTML，再处理标题、代码块、列表、粗体与行内代码。
   只覆盖讲义与练习会用到的语法，不引入任何依赖。 */
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(src) {
  const lines = escapeHtml(src || "").split("\n");
  const out = [];
  let inCode = false;
  let listType = null;

  const closeList = () => {
    if (listType) { out.push(listType === "ul" ? "</ul>" : "</ol>"); listType = null; }
  };
  const inline = (s) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*```/.test(line)) {
      closeList();
      out.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(raw); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      out.push("<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">");
      continue;
    }
    if (/^\s*$/.test(line)) { closeList(); continue; }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push("<li>" + inline(ul[1]) + "</li>");
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
      out.push("<li>" + inline(ol[1]) + "</li>");
      continue;
    }
    closeList();
    out.push("<p>" + inline(line) + "</p>");
  }
  closeList();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

function setOutput(text) {
  $("chat-out").innerHTML = renderMarkdown(text);
}



let settings = { models: [], knowledgeBases: [] };

async function call(path, body) {
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

function setStatus(text, level) {
  const el = $("status");
  el.textContent = text;
  el.style.color = level === "err" ? "#b23c3c" : "#7b8794";
}

function setFooter(text) { $("footer").textContent = text || ""; }

function showTab(name) {
  for (const panel of document.querySelectorAll(".panel")) {
    panel.classList.toggle("hidden", panel.id !== "panel-" + name);
  }
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.tab === name);
  }
}

function option(value, label) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

function fillRoleSelect(el, selected) {
  el.innerHTML = "";
  el.appendChild(option("", "（未指定）"));
  for (const m of settings.models) {
    el.appendChild(option(m.id, m.name || m.id));
  }
  el.value = selected || "";
}

function renderModels() {
  const tb = $("m-list").querySelector("tbody");
  tb.innerHTML = "";
  for (const m of settings.models) {
    const tr = document.createElement("tr");
    const caps = (m.capabilities || []).join(" / ");
    tr.innerHTML = "<td>" + (m.name || m.id) + "<br><span class=\"tag\">" + m.id + "</span></td>" +
      "<td>" + m.baseUrl + "<br>" + (m.model || "") + "</td>" +
      "<td>" + (m.hasApiKey ? "已设置密钥" : "未设置密钥") + (caps ? "<br>" + caps : "") + "</td>";
    const actions = document.createElement("td");
    const test = document.createElement("button");
    test.textContent = "测试";
    test.onclick = async () => {
      setFooter("正在测试 " + m.id + " …");
      try {
        await call("/api/models/test", { id: m.id });
        setFooter("模型 " + m.id + " 连通");
      } catch (e) { setFooter("测试失败：" + e.message); }
    };
    const del = document.createElement("button");
    del.textContent = "删除";
    del.onclick = async () => {
      await call("/api/models/delete", { id: m.id });
      await refresh();
    };
    actions.appendChild(test);
    actions.appendChild(del);
    tr.appendChild(actions);
    tb.appendChild(tr);
  }
  fillRoleSelect($("role-chat"), settings.chatModelId);
  fillRoleSelect($("role-embed"), settings.embedModelId);
  fillRoleSelect($("role-chunk"), settings.chunkModelId);
}

function renderKbs() {
  const tb = $("kb-list").querySelector("tbody");
  tb.innerHTML = "";
  const sel = $("chat-kb");
  sel.innerHTML = "";
  for (const kb of settings.knowledgeBases) {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td>" + (kb.name || kb.id) + "</td><td>" + kb.rootDir + "</td>" +
      "<td>" + (kb.docCount || 0) + " 篇 / " + (kb.chunkCount || 0) + " 片 / " + (kb.imageCount || 0) + " 图</td>";
    tb.appendChild(tr);
    sel.appendChild(option(kb.id, kb.name || kb.id));
  }
}

async function refreshArtifacts() {
  const box = $("chat-artifacts");
  try {
    const data = await call("/api/artifacts/list", {});
    box.innerHTML = "";
    const items = data.artifacts || [];
    if (!items.length) {
      box.textContent = "还没有生成任何产物。";
      return;
    }
    const ul = document.createElement("ul");
    for (const it of items) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = it.name + "（" + it.size + " 字节）";
      const p = document.createElement("div");
      p.className = "path";
      p.textContent = it.path;
      li.appendChild(name);
      li.appendChild(p);
      ul.appendChild(li);
    }
    box.appendChild(ul);
  } catch (e) {
    box.textContent = "读取产物列表失败：" + e.message;
  }
}

async function refresh() {
  settings = await call("/api/settings");
  renderModels();
  renderKbs();
}

async function init() {
  try {
    const health = await call("/health");
    setStatus("内核已连接 · " + health.cangjie);
  } catch (e) {
    setStatus("内核未连接", "err");
  }
  try {
    await refresh();
  } catch (e) {
    setFooter("读取设置失败：" + e.message);
  }
  await refreshArtifacts();
}

$("chat-ask").onclick = async () => {
  const kbId = $("chat-kb").value;
  const question = $("chat-q").value.trim();
  if (!question) { setFooter("请先输入问题"); return; }
  setOutput("正在检索并生成…");
  $("chat-cites").innerHTML = "";
  setFooter("");
  try {
    const data = await call("/api/agent/ask", { kbId, question });
    setOutput(data.answer || data.message || "");
    renderCitations(data);
    if (data.citationReport) {
      setFooter("段落 " + data.citationReport.paragraphs + " · 带引用 " + data.citationReport.citedParagraphs + " · 越界引用 " + data.citationReport.outOfRange);
    }
  } catch (e) {
    setOutput("失败：" + e.message);
  }
};

async function generate(kind) {
  const kbId = $("chat-kb").value;
  const topic = $("chat-q").value.trim();
  if (!topic) { setFooter("请先在输入框写个主题"); return; }
  setOutput("正在生成" + (kind === "lecture" ? "讲义" : "练习") + "…");
  $("chat-cites").innerHTML = "";
  try {
    const data = await call("/api/agent/" + kind, { kbId, topic });
    setOutput(data.content || data.message || "");
    renderCitations(data);
    setFooter(data.artifactPath ? "已写出：" + data.artifactPath : "");
    await refreshArtifacts();
  } catch (e) {
    setOutput("失败：" + e.message);
  }
}

function renderCitations(data) {
  const box = $("chat-cites");
  box.innerHTML = "";
  if (!data.citations || !data.citations.length) return;
  const title = document.createElement("div");
  title.textContent = "出处";
  box.appendChild(title);
  const ul = document.createElement("ul");
  for (const c of data.citations) {
    const li = document.createElement("li");
    li.textContent = "[" + c.index + "] 《" + c.docTitle + "》" + (c.headingPath ? " · " + c.headingPath : "") + "（" + c.docPath + "）";
    ul.appendChild(li);
  }
  box.appendChild(ul);
}

$("chat-lecture").onclick = () => generate("lecture");
$("chat-quiz").onclick = () => generate("quiz");

$("kb-add").onclick = async () => {
  try {
    await call("/api/kb/save", { id: $("kb-id").value.trim(), name: $("kb-name").value.trim(), rootDir: $("kb-dir").value.trim() });
    await refresh();
    setFooter("知识库已保存");
  } catch (e) { setFooter("保存失败：" + e.message); }
};

$("kb-build").onclick = async () => {
  const id = $("kb-id").value.trim() || ($("chat-kb").value);
  setFooter("正在建立索引，首次会调用模型…");
  try {
    const st = await call("/api/kb/build", { id });
    await refresh();
    setFooter("索引完成：" + st.docCount + " 篇 / " + st.chunkCount + " 片 / " + st.imageCount + " 图，图片描述 " + st.captioned + " 条");
  } catch (e) { setFooter("建立索引失败：" + e.message); }
};

$("m-save").onclick = async () => {
  const payload = {
    id: $("m-id").value.trim(),
    name: $("m-name").value.trim(),
    baseUrl: $("m-base").value.trim(),
    apiKey: $("m-key").value,
    model: $("m-model").value.trim(),
    visionModel: $("m-vision").value.trim(),
    embeddingModel: $("m-embed").value.trim(),
  };
  if (!payload.id) { setFooter("请填写模型标识"); return; }
  try {
    await call("/api/models/save", payload);
    $("m-key").value = "";
    await refresh();
    setFooter("模型已保存");
  } catch (e) { setFooter("保存失败：" + e.message); }
};

$("role-save").onclick = async () => {
  try {
    await call("/api/models/roles", {
      chatModelId: $("role-chat").value,
      embedModelId: $("role-embed").value,
      chunkModelId: $("role-chunk").value,
    });
    await refresh();
    setFooter("用途绑定已保存");
  } catch (e) { setFooter("保存失败：" + e.message); }
};

for (const tab of document.querySelectorAll(".tab")) {
  tab.onclick = () => showTab(tab.dataset.tab);
}

showTab("kb");
init();
