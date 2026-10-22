/**
 * 通用模式知识库工具自检：会话没绑定知识库（kbId 为空）时，
 *   list_documents → 列本机全部已建索引的库（标题带《库名》）
 *   read_chunk     → 从检索结果的 id 直接读原文（跨库找）
 * 这两条以前都报"当前知识库还没有索引 / 找不到切片"（用户实测 2026-10-16 08:36）。
 *
 * 用法：node tools/kb-general-check.cjs   末行 RESULT 为结论。
 */
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process");
const REPO = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log((ok ? "PASS " : "FAIL ") + label); if (!ok) fails++; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "itn-kbgen-"));
  const kb = path.join(dir, "kb");
  fs.mkdirSync(kb);
  fs.writeFileSync(path.join(kb, "a.md"), "# 智能体通信协议\n\n## MCP 是什么\n\nMCP 是智能体的 USB-C：Host / Client / Server 三层，工具与资源都走它。\n");
  fs.writeFileSync(path.join(kb, "b.md"), "# 提示词工程\n\n## 基本概念\n\n提示词要把任务、约束与输出格式写清楚。\n");
  const mockPort = 8798;
  const mockErr = fs.openSync(path.join(REPO, "tmp", "mock-stderr.txt"), "w");
  const mock = spawn("python", [path.join(REPO, "tools/mock-openai/server.py"), String(mockPort)], { cwd: REPO, windowsHide: true, stdio: ["ignore", "ignore", mockErr], env: { ...process.env, ITN_MOCK_CHUNK_DELAY_MS: "0" } });
  const portFile = path.join(dir, "core.port");
  const core = spawn(path.join(REPO, "dist/core/itn-desktop-core.exe"),
    ["--data-dir=" + dir, "--port-file=" + portFile, "--ui-dir=" + path.join(REPO, "shell/renderer")], { windowsHide: true, stdio: "ignore" });
  for (let i = 0; i < 80 && !fs.existsSync(portFile); i++) await sleep(300);
  const base = "http://127.0.0.1:" + fs.readFileSync(portFile, "utf8").trim();
  const post = (u, b) => fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
  try {
    await post("/api/models/save", { id: "mock", name: "mock", baseUrl: "http://127.0.0.1:" + mockPort + "/v1", apiKey: "k", model: "mock" });
    await post("/api/models/roles", { chatModelId: "mock", embedModelId: "", chunkModelId: "" });
    await post("/api/kb/save", { id: "kb", name: "示例资料", rootDir: kb });
    const built = await post("/api/kb/build", { id: "kb" });
    check(built.code === 0 && built.data.chunkCount > 0, "先把样张知识库建好（" + built.data.docCount + " 篇 / " + built.data.chunkCount + " 切片）");

    const sid = (await post("/api/sessions/new", {})).data.sessionId;
    const ask = (q) => post("/api/agent/ask-pi", { kbId: "", question: q, sessionId: sid, web: "off", mode: "chat" });
    const toolResults = async () => {
      const evs = (await post("/api/sessions/events", { sessionId: sid })).data.events;
      return evs.filter((e) => e.type === "tool/result").map((e) => e.payload);
    };

    await ask("我这边的资料有哪些资料？");
    await sleep(500);
    const list = (await toolResults()).find((t) => t.tool === "list_documents");
    check(!!list && list.ok === true, "通用模式下 list_documents 成功（" + (list && list.summary) + "）");
    check(!!list && String(list.summary).indexOf("还没有索引") < 0, "不再报「当前知识库还没有索引」");
    const docs = list && Array.isArray(list.details) ? list.details : [];
    check(docs.length === 2, "列出 2 篇文档（实际 " + docs.length + "）");
    check(docs.length > 0 && String(docs[0].docTitle).startsWith("《示例资料》"), "标题带《库名》： " + (docs[0] && docs[0].docTitle));

    const before = (await toolResults()).length;
    await ask("把 MCP 那段读原文给我");
    await sleep(600);
    const after = (await toolResults()).slice(before);
    const search = after.find((t) => t.tool === "kb_search");
    const read = after.find((t) => t.tool === "read_chunk");
    check(!!search && search.ok === true, "先检索到切片（" + (search && search.summary) + "）");
    check(!!read && read.ok === true, "通用模式下 read_chunk 读得到原文（" + (read && read.summary) + "）");
    check(!!read && read.details && read.details.kbId === "kb" && String(read.details.text).length > 0, "返回里带库标识与正文");
  } catch (e) {
    check(false, "自检脚本异常：" + ((e && e.message) || e));
  } finally {
    core.kill(); mock.kill();
  }
  console.log("RESULT " + (fails ? (fails + " failed") : "all passed"));
  process.exit(fails ? 1 : 0);
})();
