const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");
const path = require("path");
const fs = require("fs");
const os = require("os");

/**
 * lumin 桌面壳（契约 docs/serve-rpc.md §1 启动参数 / §8 壳 IPC）。
 *
 * 主进程只做三件事：
 *   1. 拉起 `serve` 子进程 → 轮询端口文件 → 窗口 loadURL 到 http://127.0.0.1:<port>/；
 *   2. 经 preload 把 win / dlg / term / paths 四组能力交给渲染层（contextIsolation 开、渲染层无 Node）；
 *   3. 退窗时把 term 与 serve 两个子进程杀干净。
 *
 * 开发旗标 --no-serve：跳过 serve，直接开一份占位页，单独自测标题栏与终端通道。
 */
const NO_SERVE = process.argv.includes("--no-serve");

const shellDir = __dirname;
const luminRoot = path.resolve(shellDir, "..");
const uiDir = path.join(shellDir, "ui");

let win = null;
let serveProc = null;
let servePortFile = null;
/** 等端口期间 serve 提前挂了 → 立刻失败，别干等 20 秒超时。 */
let onServeExit = null;
let termProc = null;

/** 内核可执行文件：按序找，第一个存在的。 */
const KERNEL_CANDIDATES = [
  path.join(shellDir, "..", "dist", "lumin-demo", "lumin-demo.exe"), // 绿色包，自带 4 个 DLL，优先
  path.join(shellDir, "..", "target", "release", "bin", "main.exe"), // 开发产物，可能缺 DLL，次选
];

function findKernelExe() {
  for (const c of KERNEL_CANDIDATES) {
    const p = path.resolve(c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const kernelExe = findKernelExe();

function killQuiet(p) {
  if (!p) return;
  try {
    p.kill();
  } catch (e) {
    /* 已经退出 / 没权限，忽略 */
  }
}

/* ------------------------------------------------------------------ serve */

function waitForPort(portFile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      onServeExit = null;
      fn(v);
    };
    const timer = setInterval(() => {
      try {
        if (fs.existsSync(portFile)) {
          const text = fs.readFileSync(portFile, "utf8").trim();
          if (/^\d+$/.test(text)) {
            finish(resolve, text);
            return;
          }
        }
      } catch (e) {
        /* 端口文件可能正被写入，下一轮再读 */
      }
      if (Date.now() - started > timeoutMs) {
        finish(reject, new Error("serve 启动超时：20 秒内没有等到端口文件 " + portFile));
      }
    }, 200);
    onServeExit = (reason) => finish(reject, new Error(reason));
  });
}

async function startServe() {
  const portFile = path.join(os.tmpdir(), "lumin-serve-" + process.pid + "-" + Date.now() + ".port");
  servePortFile = portFile;
  try {
    fs.rmSync(portFile, { force: true });
  } catch (e) {
    /* 没有旧文件就算了 */
  }
  serveProc = spawn(
    // 不传 --workspace：serve 缺省用 $LUMIN_HOME/chat-workspace（契约 §1），
    // 比拿 shell 目录本身当工作区合理；用户在界面里可以再换。
    kernelExe,
    ["serve", "--port-file", portFile, "--ui-dir", uiDir],
    {
      cwd: shellDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.assign({}, process.env, { LUMIN_HOME: luminRoot }),
    }
  );
  serveProc.stdout.on("data", (d) => process.stdout.write("[serve] " + d));
  serveProc.stderr.on("data", (d) => process.stdout.write("[serve] " + d));
  serveProc.on("error", (err) => {
    const msg = "serve 启动错误：" + ((err && err.message) || err);
    console.error("[serve] " + msg);
    if (onServeExit) onServeExit(msg);
  });
  serveProc.on("exit", (code) => {
    console.log("[serve] 进程退出，代码 " + code);
    if (onServeExit) onServeExit("serve 进程提前退出，代码 " + code);
  });
  return await waitForPort(portFile, 20000);
}

/* ------------------------------------------------------------------- term */

function sendTerm(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

ipcMain.handle("term:start", async (_e, opts) => {
  const cwd = opts && opts.cwd ? String(opts.cwd) : path.join(luminRoot, "chat-workspace");
  if (termProc) {
    killQuiet(termProc);
    termProc = null;
  }
  let child;
  try {
    child = spawn(kernelExe, ["chat"], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: Object.assign({}, process.env, { LUMIN_HOME: luminRoot }),
    });
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  termProc = child;

  // stdout / stderr 各挂一个 StringDecoder：UTF-8 多字节字符可能被切在两次 data 之间，
  // 逐块 toString 会炸出替换字符（契约 §8 要求流式解码后回调）。
  const outDec = new StringDecoder("utf8");
  const errDec = new StringDecoder("utf8");
  // 只转发"当前这一个"子进程的事件：stop()/重启后旧进程迟到的输出与退出一律丢掉；
  // termProc 已被摘掉（stop 刚调过）时仍要转发，渲染层才收得到 onExit。
  const wanted = () => termProc === child || termProc === null;

  child.stdout.on("data", (d) => {
    const t = outDec.write(d);
    if (t && wanted()) sendTerm("term:data", t);
  });
  child.stderr.on("data", (d) => {
    const t = errDec.write(d);
    if (t && wanted()) sendTerm("term:data", t);
  });
  child.stdin.on("error", () => {
    /* 子进程先退了再写管道：不许把壳打崩 */
  });

  // 启动握手：150ms 内没报错就算起来了（spawn 的 ENOENT/坏 cwd 走 error 事件）。
  return await new Promise((resolve) => {
    let settled = false;
    let started = false;
    const settle = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      started = true;
      settle({ ok: true });
    }, 150);
    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        if (termProc === child) termProc = null;
        settle({ ok: false, error: String((err && err.message) || err) });
      } else {
        console.error("[term] 运行期错误：" + ((err && err.message) || err));
      }
    });
    // 用 close（exit + stdio 都关了）做收尾：此时 stdout 一定读完了，先 flush 解码器再转发。
    child.on("close", (code) => {
      clearTimeout(timer);
      const flush = outDec.end() + errDec.end();
      const forward = started && (termProc === child || termProc === null);
      if (termProc === child) termProc = null;
      settle({ ok: false, error: "子进程启动后立即退出，代码 " + code });
      if (forward) {
        if (flush) sendTerm("term:data", flush);
        sendTerm("term:exit", { code: code == null ? null : code });
      }
    });
  });
});

ipcMain.on("term:write", (_e, text) => {
  if (!termProc || !termProc.stdin || !termProc.stdin.writable) return;
  try {
    termProc.stdin.write(String(text));
  } catch (e) {
    /* 管道已断，忽略 */
  }
});

ipcMain.on("term:stop", () => {
  const child = termProc;
  termProc = null; // 先摘引用：随后到达的 close 仍按 wanted() 转发退出事件
  killQuiet(child);
});

/* -------------------------------------------------------- win / dlg / paths */

ipcMain.on("win:minimize", () => {
  if (!win) return;
  win.minimize();
  if (NO_SERVE) {
    setTimeout(() => console.log("[shell] SELFTEST_WIN minimized=" + (win ? win.isMinimized() : "gone")), 400);
  }
});

ipcMain.on("win:toggle-maximize", () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

ipcMain.on("win:close", () => {
  if (win) win.close();
});

/** 选目录走主进程：渲染层是普通网页，没有读本机绝对路径的能力。取消返回 ""。 */
ipcMain.handle("dlg:pick-directory", async (_e, title) => {
  const options = {
    title: typeof title === "string" && title ? title : "选择目录",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "用这个目录",
  };
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (r.canceled || !r.filePaths || !r.filePaths.length) return "";
  return r.filePaths[0];
});

/** lumin.paths 是同步值（契约 §8），preload 里用 sendSync 取一次。 */
ipcMain.on("paths:get", (event) => {
  event.returnValue = { luminRoot, kernelExe };
});

/* ------------------------------------------------------------ 占位页（--no-serve） */

function ensurePlaceholder() {
  const file = path.join(os.tmpdir(), "lumin-shell-placeholder.html");
  // 自测时可以先手写一份临时页放在这里；没有才落内置占位页，不覆盖人家的。
  if (!fs.existsSync(file)) fs.writeFileSync(file, PLACEHOLDER_HTML, "utf8");
  return file;
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>lumin — 占位页（--no-serve）</title>
<style>
  html,body{margin:0;height:100%;background:#12141a;color:#d7dce2;
    font:13px/1.5 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  #titlebar{display:flex;align-items:center;height:36px;background:#1b1f27;
    -webkit-app-region:drag;padding-left:12px;user-select:none}
  .brand{font-weight:600;color:#9fd0ff}
  .hint{margin-left:10px;color:#7b8494;font-size:12px}
  .btns{margin-left:auto;display:flex;-webkit-app-region:no-drag;height:100%}
  .btns button{width:64px;height:100%;border:0;background:transparent;color:#c8cfd9;
    font-size:12px;cursor:pointer}
  .btns button:hover{background:#2a3140}
  .btns button.close:hover{background:#c42b1c;color:#fff}
  #log{margin:16px;padding:12px;background:#0c0e12;border:1px solid #262b36;border-radius:8px;
    white-space:pre-wrap;word-break:break-all;min-height:200px}
</style>
</head>
<body>
  <div id="titlebar">
    <span class="brand">lumin</span>
    <span class="hint">占位页 · --no-serve 自测（标题栏三按钮 / 终端通道）</span>
    <span class="btns">
      <button id="btn-min">最小化</button>
      <button id="btn-max">最大化</button>
      <button id="btn-close" class="close">关闭</button>
    </span>
  </div>
  <pre id="log"></pre>
  <script>
  const L = window.lumin;
  const el = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let pass = true;
  function log(m) {
    console.log("SELFTEST " + m);
    el("log").textContent += m + "\\n";
  }
  const ok = (m) => log("OK " + m);
  const fail = (m) => { pass = false; log("ERR " + m); };
  async function waitFor(fn, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return true;
      await sleep(100);
    }
    return false;
  }
  window.onerror = (msg) => fail("页面异常 " + msg);

  function finish() {
    log(pass ? "RESULT=PASS" : "RESULT=FAIL");
    setTimeout(() => { try { L.win.close(); } catch (e) {} }, 300);
  }

  if (!L) {
    fail("window.lumin 不存在（preload 没挂上）");
    log("RESULT=FAIL");
  } else {
    el("btn-min").onclick = () => L.win.minimize();
    el("btn-max").onclick = () => L.win.toggleMaximize();
    el("btn-close").onclick = () => L.win.close();
    run().catch((e) => {
      fail("run 异常 " + String((e && e.message) || e));
      finish();
    });
  }

  async function run() {
    // 1) API 面：与契约 §8 逐个对
    const need = [
      ["win.minimize", L.win && L.win.minimize],
      ["win.toggleMaximize", L.win && L.win.toggleMaximize],
      ["win.close", L.win && L.win.close],
      ["win.onState", L.win && L.win.onState],
      ["dlg.pickDirectory", L.dlg && L.dlg.pickDirectory],
      ["term.start", L.term && L.term.start],
      ["term.write", L.term && L.term.write],
      ["term.onData", L.term && L.term.onData],
      ["term.onExit", L.term && L.term.onExit],
      ["term.stop", L.term && L.term.stop],
    ];
    const missing = need.filter(([, f]) => typeof f !== "function").map(([n]) => n);
    if (missing.length) fail("缺方法：" + missing.join(","));
    else ok("window.lumin 方法齐全（win 4 / dlg 1 / term 5）");
    if (L.paths && L.paths.kernelExe) ok("paths.kernelExe = " + L.paths.kernelExe);
    else fail("paths.kernelExe 为空");
    if (L.paths && L.paths.luminRoot) ok("paths.luminRoot = " + L.paths.luminRoot);
    else fail("paths.luminRoot 为空");

    // 2) 终端通道：起 chat 管道子进程
    //    已探明的内核侧行为：chat 的 stdout 在管道下是 4KB 全缓冲 —— 累计不足 4KB 的
    //    输出在进程干净退出前根本不回流（/quit 退出还会吞掉残余缓冲）。所以这里一次
    //    连发 6 行 /help，把输出推过 4KB 边界，用"中途就攒到 ≥4KB"证明整条
    //    管道→StringDecoder→IPC 真的在流式回字节。
    let buf = "";
    let exitInfo = null;
    L.term.onData((t) => { buf += t; });
    L.term.onExit((e) => { exitInfo = e; });
    const st = await L.term.start();
    if (st && st.ok) {
      ok("term.start ok");
      L.term.write(("/help\\n").repeat(6));
      if (await waitFor(() => buf.length >= 4096, 15000)) {
        ok("stdout 流式回显攒到 " + buf.length + " 字节（跨过 4KB 缓冲边界，管道+解码+IPC 全通）");
      } else {
        fail("15s 内 stdout 没攒到 4KB：" + buf.length + " 字节：" + JSON.stringify(buf.slice(0, 120)));
      }
      if (buf.indexOf("命令：") >= 0) ok("/help 中文回显（UTF-8 流解码正确）");
      else fail("/help 内容没出现：" + JSON.stringify(buf.slice(0, 200)));
      if (buf.indexOf("harness") >= 0) ok("banner 已随首批缓冲回流");
      else fail("banner 没出现：" + JSON.stringify(buf.slice(0, 200)));
      L.term.write("/quit\\n");
      if (await waitFor(() => exitInfo !== null, 10000)) ok("onExit code=" + exitInfo.code);
      else fail("10 秒没收到 onExit");
      L.term.stop();
    } else {
      fail("term.start 失败：" + (st && st.error));
    }

    // 3) 标题栏：onState 最大化往返 + 最小化（main 侧另打印 SELFTEST_WIN）
    const states = [];
    const off = L.win.onState((s) => states.push(!!(s && s.maximized)));
    L.win.toggleMaximize();
    await sleep(1000);
    L.win.toggleMaximize();
    await sleep(1000);
    if (states.length >= 2 && states[0] === true && states[1] === false) {
      ok("onState 最大化往返 " + JSON.stringify(states.slice(0, 2)));
    } else {
      fail("onState 序列不对 " + JSON.stringify(states));
    }
    if (typeof off === "function") off();
    L.win.minimize();
    await sleep(900);

    finish();
  }
  </script>
</body>
</html>
`;

/* ------------------------------------------------------------------- boot */

async function boot() {
  if (!kernelExe) {
    dialog.showErrorBox(
      "启动失败",
      "找不到 lumin 可执行文件…（依次找过 dist/lumin-demo/lumin-demo.exe、target/release/bin/main.exe，先构建再启动）"
    );
    app.quit();
    return;
  }
  let port = null;
  if (!NO_SERVE) {
    try {
      port = await startServe();
      console.log("[shell] serve 就绪 http://127.0.0.1:" + port + "/");
    } catch (e) {
      const msg = String((e && e.message) || e);
      console.error("[shell] 启动失败：" + msg);
      dialog.showErrorBox("启动失败", msg);
      app.quit();
      return;
    }
  }
  createWindow(port);
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "lumin",
    // 自绘标题栏：frame:false 去掉系统标题栏，界面顶部画 #titlebar，按钮走 win.* IPC
    frame: false,
    backgroundColor: "#12141a",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(shellDir, "preload.js"),
    },
  });
  if (win.removeMenu) win.removeMenu();

  const pushState = () => {
    if (win && !win.isDestroyed()) win.webContents.send("win:state", { maximized: win.isMaximized() });
  };
  win.on("maximize", pushState);
  win.on("unmaximize", pushState);
  win.webContents.on("did-finish-load", () => {
    if (win && !win.isDestroyed()) console.log("[shell] 已加载 " + win.getURL());
  });
  win.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error("[shell] 加载失败 " + code + " " + desc);
  });
  if (NO_SERVE) {
    // 自测模式：把渲染层 console 打到壳的标准输出，占位页的 SELFTEST 结果才看得到
    win.webContents.on("console-message", (...args) => {
      const d = args[0] && typeof args[0].message === "string" ? args[0] : { message: String(args[2]) };
      process.stdout.write("[ui] " + d.message + "\n");
    });
  }
  win.on("closed", () => {
    win = null;
  });

  if (NO_SERVE) win.loadFile(ensurePlaceholder());
  else win.loadURL("http://127.0.0.1:" + port + "/");
}

app
  .whenReady()
  .then(boot)
  .catch((e) => {
    const msg = String((e && e.stack) || e);
    console.error("[shell] " + msg);
    try {
      dialog.showErrorBox("启动失败", msg);
    } catch (_) {
      /* 框都弹不出来就只能记日志了 */
    }
    app.quit();
  });

app.on("window-all-closed", () => app.quit());

app.on("before-quit", () => {
  killQuiet(termProc);
  termProc = null;
  killQuiet(serveProc);
  if (servePortFile) {
    try {
      fs.rmSync(servePortFile, { force: true });
    } catch (e) {
      /* 临时端口文件清不掉也无妨 */
    }
  }
});
