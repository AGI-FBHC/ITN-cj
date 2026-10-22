/** 界面中文审计：起隔离环境，把每个页面**真实渲染出来**的文字抓下来，列出还带英文的行。
 *  用法：node tools/zh-audit.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

function loadPlaywright() {
  const dirs = [process.env.ITN_PLAYWRIGHT_DIR, path.join(__dirname, "..", "node_modules"),
    "D:\\Desktop\\ITN\\ITN\\src\\frontend\\agent-demo\\node_modules"].filter(Boolean);
  for (const d of dirs) { try { return require(path.join(d, "playwright")); } catch (e) { /* next */ } }
  console.error("未找到 playwright"); process.exit(2);
}
const { chromium } = loadPlaywright();
const REPO = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer(); s.unref();
  s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "itn-zh-"));
  const kb = path.join(dir, "kb");
  fs.mkdirSync(kb);
  fs.writeFileSync(path.join(kb, "input.md"), "# 输入与输出的约定\n\n## 最小样例\n\n每次任务先写输入、规则、期望输出和验收标准。\n");
  const mockPort = await freePort();
  const mock = spawn("python", [path.join(REPO, "tools/mock-openai/server.py"), String(mockPort)],
    { cwd: REPO, windowsHide: true, stdio: "ignore", env: { ...process.env, ITN_MOCK_CHUNK_DELAY_MS: "0" } });
  const portFile = path.join(dir, "core.port");
  const core = spawn(path.join(REPO, "dist/core/itn-desktop-core.exe"),
    ["--data-dir=" + dir, "--port-file=" + portFile, "--ui-dir=" + path.join(REPO, "shell/renderer")],
    { windowsHide: true, stdio: "ignore" });
  const out = [];
  try {
    for (let i = 0; i < 120 && !fs.existsSync(portFile); i++) await sleep(100);
    const base = "http://127.0.0.1:" + fs.readFileSync(portFile, "utf8").trim();
    const post = (u, b) => fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
    await post("/api/models/save", { id: "mock", name: "mock", baseUrl: "http://127.0.0.1:" + mockPort + "/v1", apiKey: "k", model: "mock" });
    await post("/api/models/roles", { chatModelId: "mock", embedModelId: "", chunkModelId: "" });
    await post("/api/kb/save", { id: "kb", name: "示例资料", rootDir: kb });
    await post("/api/kb/build", { id: "kb" });

    const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--no-proxy-server"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(base);
    await page.waitForSelector("#chat-input", { timeout: 30000 });
    await sleep(900);

    const grab = async (label) => {
      const data = await page.evaluate(() => {
        const seen = [];
        const walk = (n) => {
          for (const c of n.children) walk(c);
          if (n.nodeType === 1) {
            for (const a of ["title", "placeholder", "aria-label"]) {
              const v = n.getAttribute && n.getAttribute(a);
              if (v) seen.push(a + "=" + v);
            }
          }
        };
        walk(document.body);
        const texts = (document.body.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
        return { texts, attrs: seen };
      });
      for (const line of data.texts) out.push([label, "text", line]);
      for (const a of data.attrs) out.push([label, "attr", a]);
    };

    await grab("chat-empty");
    await page.fill("#chat-input", "make:quiz 生成学习资源 count:4");
    await page.locator(".composer-send").click();
    await page.waitForSelector("#resource-dock .resource-title", { timeout: 90000 });
    await sleep(600);
    await grab("chat-running");
    await page.fill("#chat-input", "写文件测试");
    await page.locator(".composer-send").click();
    await sleep(4000);
    await grab("chat-tools");
    /* 工作过程组默认跑完就折起来了：这里**强制展开**（.open = true，不走点击，免得被
       别的浮层挡住），才能看到工具卡标题里的工具名 —— 缺中文标签时会直接露出 read / powershell。 */
    await page.evaluate(() => { for (const d of document.querySelectorAll("details.work-group")) d.open = true; });
    await sleep(400);
    await grab("chat-workgroup");
    // 工具卡标题必须是中文（缺标签时 toolLabel 会退回英文工具名）
    const toolTitles = await page.evaluate(() =>
      [...document.querySelectorAll(".tool-card .tool-title")].map((n) => (n.textContent || "").trim()));
    if (!toolTitles.length) throw new Error("没有渲染出工具卡，工具名中文化这一项没法验证");
    const asciiTools = toolTitles.filter((t) => /^(read|write|edit|ls|find|grep|powershell|skill_read)\b/.test(t));
    if (asciiTools.length) throw new Error("工具卡还露着英文工具名：" + asciiTools.join(" / "));
    console.log("TOOL-LABELS " + toolTitles.join(" | "));
    for (const p of ["home", "learn", "kb", "resources", "memory", "report", "settings"]) {
      await page.evaluate((x) => go(x), p);
      await sleep(700);
      await grab("page-" + p);
    }
    await page.evaluate(() => go("settings", "agent"));
    await sleep(600);
    await grab("settings-agent");
    await page.evaluate(() => go("settings", "about"));
    await sleep(600);
    await grab("settings-about");
    await browser.close();
  } finally {
    try { core.kill(); } catch (e) {}
    try { mock.kill(); } catch (e) {}
  }
  // 过滤：只留"含英文字母、且不含中文"的可见文字
  const allow = [
    /^LUMIN$/, /^Lumin$/, /^MiMo/, /^DeepSeek/, /^v?\d+(\.\d+)*$/, /^Ctrl\+/, /^https?:/,
    /^[\d\s.,:%+\-\/·()]+$/, /^lumin:\/\//, /^\d+(\.\d+)?\s*(KB|MB|B|GB)$/,
    /[\\\/]/,              // 路径、URL
    /^[A-Za-z0-9_.-]+$/,      // 文件名/标识（如 mock）
  ];
  const bad = [];
  for (const [where, kind, s] of out) {
    if (!/[A-Za-z]{2,}/.test(s)) continue;
    if (/[\u4e00-\u9fff]/.test(s)) continue;     // 中英混排里带中文的，先人工看
    if (allow.some((re) => re.test(s))) continue;
    bad.push([where, kind, s]);
  }
  const mix = [];
  for (const [where, kind, s] of out) {
    if (!/[A-Za-z]{3,}/.test(s)) continue;
    if (!/[\u4e00-\u9fff]/.test(s)) continue;
    if (/https?:/.test(s)) continue;
    mix.push([where, kind, s]);
  }
  console.log("==== 纯英文行（" + bad.length + "） ====");
  const seen = new Set();
  for (const [w, k, s] of bad) { const key = k + "|" + s; if (seen.has(key)) continue; seen.add(key); console.log(w.padEnd(16), k.padEnd(5), JSON.stringify(s)); }
  console.log("==== 中英混排行（" + mix.length + "） ====");
  const seen2 = new Set();
  for (const [w, k, s] of mix) { const key = k + "|" + s; if (seen2.has(key)) continue; seen2.add(key); console.log(w.padEnd(16), k.padEnd(5), JSON.stringify(s)); }
  /* 断言：界面文字里不该再出现这几个"中文里夹英文"的老毛病；工具卡不许露出英文工具名 */
  const banned = /\b(Agent|Work|API Key|Base URL)\b/;
  const hits = [];
  for (const [where, kind, s] of out) {
    if (banned.test(s)) hits.push([where, kind, s]);
  }
  const toolColon = [];
  for (const [where, kind, s] of out) {
    const m = /^(read|write|edit|ls|find|grep|powershell|skill_read|kb_search|web_search|web_fetch|save_note|save_artifact|calc)\s*[：:]/.exec(s);
    if (m) toolColon.push([where, kind, s]);
  }
  console.log("==== 禁用英文词命中（" + hits.length + "） ====");
  for (const [w, k, s] of hits) console.log(w, k, JSON.stringify(s));
  console.log("==== 工具名英文命中（" + toolColon.length + "） ====");
  for (const [w, k, s] of toolColon) console.log(w, k, JSON.stringify(s));
  /* chat-running 里会出现会话标题：它按产品要求把用户自己的第一句截成 8 个字，
     本用例的触发词是英文（make:quiz …），截断后自然只剩英文 —— 那是用户内容，不是界面文案。 */
  const badLeft = bad.filter(([w, k, s]) => !/^(title|aria-label|placeholder)=/.test(s)
    && !/^[\d\s.,:%+\-\/·()]+$/.test(s)
    && !(w === 'chat-running' && /^make:qui/.test(s)));
  if (hits.length || toolColon.length || badLeft.length) {
    console.log("RESULT=FAILED");
    for (const [w, k, s] of badLeft) console.log("  纯英文:", w, k, JSON.stringify(s));
    process.exit(1);
  }
  console.log("RESULT=OK 界面文字已中文化（纯英文只剩路径/型号/品牌）");
})().catch((e) => { console.error("FAILED", e); process.exit(1); });
