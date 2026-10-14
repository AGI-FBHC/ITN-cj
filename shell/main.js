const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const SMOKE = process.argv.includes("--smoke");

let win = null;
let kernel = null;

/** 开发期用 dist/core，打包后用 resources/kernel。 */
function kernelPath() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "kernel", "itn-desktop-core.exe") : null,
    path.join(__dirname, "..", "dist", "core", "itn-desktop-core.exe"),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function waitForPort(portFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (fs.existsSync(portFile)) {
        const text = fs.readFileSync(portFile, "utf8").trim();
        if (text) { clearInterval(timer); resolve(text); return; }
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("内核启动超时，未收到端口文件"));
      }
    }, 200);
  });
}

async function startKernel() {
  const exe = kernelPath();
  if (!exe) throw new Error("找不到内核可执行文件，请先运行 scripts/package.ps1");
  const portFile = path.join(os.tmpdir(), "itn-desktop-" + Date.now() + ".port");
  const uiDir = path.join(__dirname, "renderer");
  // 与内核独立运行时的默认目录保持一致。此前用 Electron 的 userData，
  // 导致同一个软件出现两个数据目录，用户和文档都会对不上。
  const dataRoot = process.env.LOCALAPPDATA || app.getPath("userData");
  const dataDir = path.join(dataRoot, "ITN-Desktop");
  fs.mkdirSync(dataDir, { recursive: true });

  kernel = spawn(exe, ["--data-dir", dataDir, "--port-file", portFile, "--ui-dir", uiDir], {
    cwd: path.dirname(exe),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    // 仓颉运行时默认堆上限 256MB，向量索引在真实规模下不够用
    env: Object.assign({}, process.env, { cjHeapSize: "2GB" }),
  });
  kernel.stdout.on("data", (d) => process.stdout.write("[core] " + d));
  kernel.stderr.on("data", (d) => process.stderr.write("[core] " + d));
  kernel.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error("内核退出，代码 " + code);
  });
  return await waitForPort(portFile, 20000);
}

async function createWindow() {
  let port;
  try {
    port = await startKernel();
  } catch (e) {
    dialog.showErrorBox("启动失败", String((e && e.message) || e));
    app.quit();
    return;
  }
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: "ITN-Desktop",
    backgroundColor: "#fbfcfd",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  if (win.removeMenu) win.removeMenu();

  win.webContents.on("did-fail-load", (_e, code, desc) => {
    console.log("SMOKE_LOAD_FAIL " + code + " " + desc);
    if (SMOKE) app.quit();
  });

  win.webContents.on("did-finish-load", async () => {
    if (!SMOKE) return;
    const lines = [];
    try {
      const title = await win.webContents.executeJavaScript("document.title");
      const status = await win.webContents.executeJavaScript("document.getElementById('status').textContent");
      const panels = await win.webContents.executeJavaScript("document.querySelectorAll('.panel').length");
      lines.push("TITLE=" + title);
      lines.push("STATUS=" + status);
      lines.push("PANELS=" + panels);
      lines.push("RESULT=OK");
    } catch (e) {
      lines.push("RESULT=ERR " + ((e && e.message) || e));
    }
    for (const l of lines) console.log("SMOKE_" + l);
    // 打包后的 Electron 是 GUI 程序，控制台看不到输出，因此同时写文件
    fs.writeFileSync(path.join(os.tmpdir(), "itn-desktop-smoke-result.txt"), lines.join("\n"), "utf8");
    setTimeout(() => app.quit(), 200);
  });

  win.loadURL("http://127.0.0.1:" + port + "/");
  win.on("closed", () => { win = null; });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  if (kernel) { try { kernel.kill(); } catch (e) { /* ignore */ } }
});
