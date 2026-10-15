/**
 * 导出自检：Markdown → .pptx / .docx（壳里零依赖写包）+ 资源面板上的导出入口。
 *
 * 用法：node tools/deck-export-check.cjs
 *   1) 真导两份文件，用 python-pptx / python-docx 打开核对文字与页数；
 *   2) zipfile 完整性 + 包内每个 XML 用 minidom 解析一遍；
 *   3) 同一输入再导一次，字节必须一模一样（可复现）；
 *   4) 无头浏览器里点资源面板的「导出 pptx / 导出 docx」，确认真的把正文交给了外壳。
 */
const fs = require("fs"), os = require("os"), path = require("path");
const { spawn, execFileSync } = require("child_process");
function loadPlaywright() {
  const dirs = [process.env.ITN_PLAYWRIGHT_DIR, path.join(__dirname, "..", "node_modules"),
    "D:\\Desktop\\ITN\\ITN\\src\\frontend\\agent-demo\\node_modules"].filter(Boolean);
  for (const d of dirs) { try { return require(path.join(d, "playwright")); } catch (e) { /* next */ } }
  throw new Error("no playwright");
}
const { chromium } = loadPlaywright();
const REPO = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MD = [
  "# 输入与输出的约定",
  "",
  "每次任务先写**输入、规则、期望输出**和验收标准。",
  "",
  "## 最小样例",
  "",
  "- 用最小的一份数据跑通全流程",
  "- 先预测再执行，对照差异",
  "1. 记录中间状态",
  "2. 让另一人能复现",
  "",
  "> 结构决定质量：先定骨架再填内容。",
  "",
  "---",
  "",
  "# 验收与边界",
  "",
  "## 三种输入",
  "",
  "- 正常输入",
  "- 异常输入",
  "",
  "# 结论",
  "",
  "把可复现当作交付标准。",
].join("\n");

(async () => {
  let fails = 0;
  const check = (ok, label) => { console.log((ok ? "PASS " : "FAIL ") + label); if (!ok) fails++; };
  const outDir = path.join(REPO, "tmp", "deckexport-out");
  fs.mkdirSync(outDir, { recursive: true });
  const mod = require(path.join(REPO, "shell", "deck-export.js"));
  const pptxPath = path.join(outDir, "sample.pptx");
  const docxPath = path.join(outDir, "sample.docx");
  mod.exportPptx(MD, pptxPath);
  mod.exportDocx(MD, docxPath);
  console.log("WROTE " + pptxPath + " (" + fs.statSync(pptxPath).size + " B)");
  console.log("WROTE " + docxPath + " (" + fs.statSync(docxPath).size + " B)");

  // 可复现：同输入同字节
  const pptx2 = path.join(outDir, "sample-again.pptx");
  mod.exportPptx(MD, pptx2);
  check(fs.readFileSync(pptxPath).equals(fs.readFileSync(pptx2)), "同一输入导出两次，字节一致（可复现）");

  const py = [
    "import sys, zipfile",
    "from xml.dom import minidom",
    "def zip_ok(p):",
    "    z = zipfile.ZipFile(p)",
    "    bad = z.testzip()",
    "    n = 0",
    "    for name in z.namelist():",
    "        data = z.read(name)",
    "        if name.endswith('.xml') or name.endswith('.rels'):",
    "            minidom.parseString(data); n += 1",
    "    return bad, n",
    "b1, n1 = zip_ok(sys.argv[1]); b2, n2 = zip_ok(sys.argv[2])",
    "print('P1 zip-bad=%s xml-parts=%d' % (b1, n1))",
    "print('P2 zip-bad=%s xml-parts=%d' % (b2, n2))",
    "from pptx import Presentation",
    "prs = Presentation(sys.argv[1])",
    "texts = []",
    "for sl in prs.slides:",
    "    texts.append('\\n'.join(sh.text_frame.text for sh in sl.shapes if sh.has_text_frame))",
    "print('P3 slides=%d' % len(texts))",
    "print('P4 handoff=%s' % ('PASS' if (len(texts) == 2 and '输入与输出的约定' in texts[0] and '最小样例' in texts[0] and '验收与边界' in texts[1] and '结论' in texts[1]) else 'FAIL'))",
    "import docx",
    "d = docx.Document(sys.argv[2])",
    "paras = [p.text for p in d.paragraphs if p.text.strip()]",
    "styles = [p.style.name for p in d.paragraphs if p.text.strip()]",
    "print('P5 paras=%d' % len(paras))",
    "print('P6 handoff=%s' % ('PASS' if (any(s.startswith('Heading 1') for s in styles) and any('输入、规则' in p for p in paras) and any(p.startswith('用最小') for p in paras)) else 'FAIL'))",
    "print('P7 bold=%s' % ('PASS' if any(r.bold for p in d.paragraphs for r in p.runs) else 'FAIL'))",
  ].join("\n");
  const pyPath = path.join(outDir, "verify.py");
  fs.writeFileSync(pyPath, py, "utf8");
  let out = "";
  try {
    out = execFileSync("python", [pyPath, pptxPath, docxPath], { encoding: "utf8" });
  } catch (e) {
    out = "PY-ERR " + ((e && e.stdout) || "") + ((e && e.stderr) || "");
  }
  for (const line of out.split("\n")) if (line.trim()) console.log("  " + line.trim());
  check(/P1 zip-bad=None/.test(out) && /P2 zip-bad=None/.test(out), "两个包的 ZIP 完整、包内 XML 全部合法");
  check(/P3 slides=2/.test(out) && /P4 handoff=PASS/.test(out), "pptx 页数与文字和 Markdown 对得上");
  check(/P5 paras=\d+/.test(out) && /P6 handoff=PASS/.test(out), "docx 段落/标题和 Markdown 对得上");
  check(/P7 bold=PASS/.test(out), "docx 保留了 **粗体**");

  // ---- 资源面板上的导出入口（渲染层 → 外壳 IPC 的传参） ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "itn-deckui-"));
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
  await page.goto(base + "/#/chat");
  await page.waitForSelector("#view", { timeout: 30000 });
  await sleep(1200);
  const ui = await page.evaluate(async () => {
    const calls = [];
    window.itnWindow = window.itnWindow || {};
    window.itnWindow.exportResource = async (payload) => { calls.push(payload); return { ok: true, path: "D:/x/讲义.pptx" }; };
    workbench.selected = { id: "r1", kind: "lecture", title: "讲义：测试", markdown: "# 一\n\n- 甲\n- 乙", version: 1, versions: [1] };
    workbench.open = true;
    renderResourceDock();
    const dock = document.getElementById("resource-dock");
    const labels = Array.from(dock.querySelectorAll(".resource-actions .btn")).map((b) => b.textContent);
    const pptxBtn = Array.from(dock.querySelectorAll(".resource-actions .btn")).find((b) => b.textContent === "导出 pptx");
    const docxBtn = Array.from(dock.querySelectorAll(".resource-actions .btn")).find((b) => b.textContent === "导出 docx");
    if (pptxBtn) pptxBtn.click();
    if (docxBtn) docxBtn.click();
    await new Promise((r) => setTimeout(r, 500));
    return { labels: labels, calls: calls };
  });
  check(ui.labels.indexOf("导出 pptx") >= 0 && ui.labels.indexOf("导出 docx") >= 0, "资源面板上有「导出 pptx / 导出 docx」：" + ui.labels.join(" / "));
  check(ui.calls.length === 2, "两个按钮都真的调了外壳导出（" + ui.calls.length + " 次）");
  check(!!ui.calls[0] && ui.calls[0].kind === "pptx" && String(ui.calls[0].markdown).indexOf("甲") >= 0 && ui.calls[0].name === "讲义：测试",
    "导出传的是这份资源的正文与标题（kind=" + (ui.calls[0] && ui.calls[0].kind) + "）");
  check(pageErrors.length === 0, "没有 JavaScript 报错" + (pageErrors.length ? "：" + pageErrors[0] : ""));

  await browser.close(); core.kill();
  console.log("RESULT " + (fails ? (fails + " failed") : "all passed"));
  process.exit(fails ? 1 : 0);
})();
