/**
 * Word 文档预览自检：外壳解析（shell/pptx.js readDoc）+ 界面分页渲染。
 *
 * 用法：node tools/docx-check.cjs
 *   - 有 python-docx 时用真 .docx 样张验解析（标题层级、正文、表格里的字）；
 *   - 渲染层在无头浏览器里验：按一/二级标题分页、正文出来、有"用 Word 打开"。
 */
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
function loadPlaywright() {
  const dirs = [process.env.ITN_PLAYWRIGHT_DIR, path.join(__dirname, "..", "node_modules"),
    "D:\\Desktop\\ITN\\ITN\\src\\frontend\\agent-demo\\node_modules"].filter(Boolean);
  for (const d of dirs) { try { return require(path.join(d, "playwright")); } catch (e) {} }
  throw new Error("no playwright");
}
const { chromium } = loadPlaywright();
const REPO = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "itn-docx-check-"));
  let fails = 0;
  const check = (ok, label) => { console.log((ok ? "PASS " : "FAIL ") + label); if (!ok) fails++; };

  // ---------- 1) 外壳解析 ----------
  let fixture = "";
  try {
    const py = ["import sys", "from docx import Document", "d = Document()",
      "d.add_heading('第一章', level=1)", "d.add_paragraph('正文一。')",
      "d.add_heading('第一节', level=2)", "d.add_paragraph('正文二。')",
      "d.add_heading('细节', level=3)", "d.add_paragraph('正文三。')",
      "d.save(sys.argv[1])"].join("\n");
    const pyPath = path.join(dir, "mk.py");
    fs.writeFileSync(pyPath, py, "utf8");
    fixture = path.join(dir, "fixture.docx");
    execFileSync("python", [pyPath, fixture], { stdio: "ignore" });
  } catch (e) { fixture = ""; }
  if (fixture && fs.existsSync(fixture)) {
    const doc = require(path.join(REPO, "shell", "pptx.js")).readDoc(fixture);
    const levels = doc.paragraphs.map((p) => p.level);
    check(doc.kind === "docx", "readDoc 认出 .docx（kind=" + doc.kind + "）");
    check(levels.join(",") === "1,0,2,0,3,0", "标题层级读对（" + levels.join(",") + "）");
    check(doc.paragraphs[1].text === "正文一。", "正文文本读对（" + doc.paragraphs[1].text + "）");
  } else {
    console.log("SKIP python-docx 不可用，跳过真样张解析（渲染层照跑）");
  }

  // ---------- 2) 渲染层分页 ----------
  const portFile = path.join(dir, "core.port");
  const core = spawn(path.join(REPO, "dist/core/itn-desktop-core.exe"),
    ["--data-dir=" + dir, "--port-file=" + portFile, "--ui-dir=" + path.join(REPO, "shell/renderer")],
    { windowsHide: true, stdio: "ignore" });
  for (let i = 0; i < 60 && !fs.existsSync(portFile); i++) await sleep(300);
  const base = "http://127.0.0.1:" + fs.readFileSync(portFile, "utf8").trim();
  const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(base + "/#/resources");
  await page.waitForSelector("#player", { state: "attached", timeout: 20000 });
  const opened = await page.evaluate(async () => {
    window.itnWindow = window.itnWindow || {};
    window.itnWindow.readDoc = async () => ({ ok: true, kind: "docx", paragraphs: [
      { level: 1, text: "第一章" }, { level: 0, text: "正文一。" },
      { level: 2, text: "第一节" }, { level: 0, text: "正文二。" },
    ]});
    window.itnWindow.openPath = async () => ({ ok: true });
    await openSlidePlayer("样张.docx", undefined, undefined, "样张.docx");
    const p = document.getElementById("player");
    return {
      visible: !!p && !p.hidden,
      counter: (p.querySelector(".player-counter") || {}).textContent || "",
      title: (p.querySelector(".slide-title") || {}).textContent || "",
      body: (p.querySelector(".slide-content") || {}).innerText || "",
      tools: Array.from(p.querySelectorAll(".player-tools .btn")).map((b) => b.textContent).join(" "),
    };
  });
  check(opened.visible, "文档预览打开了播放器");
  check(opened.counter.indexOf("1 / 2") >= 0, "按一/二级标题分成 2 页（" + opened.counter + "）");
  check(opened.title === "第一章", "首页标题是文档里的一级标题（" + opened.title + "）");
  check(opened.body.indexOf("正文一") >= 0, "首页正文渲染出来");
  check(opened.tools.indexOf("用 Word 打开") >= 0, "有「用 Word 打开」直达系统程序");
  check(pageErrors.length === 0, "没有 JavaScript 报错" + (pageErrors.length ? "：" + pageErrors[0] : ""));

  await browser.close(); core.kill();
  console.log("RESULT " + (fails ? (fails + " failed") : "all passed"));
  process.exit(fails ? 1 : 0);
})();
