const { app, BrowserWindow, dialog, ipcMain, shell, Menu, nativeImage, Tray, nativeTheme } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const SMOKE = process.argv.includes("--smoke");

/**
 * 深链接：`lumin://thread/<会话id>`。
 *
 * 复制会话链接给同事/未来的自己，点开就能回到那一段对话 —— 与 Codex 的
 * `codex://threads/<id>` 同一个用法。实现靠两件事：
 *   ① 把 lumin 注册成系统协议的处理者（装一次，之后 click 链接就会拉起本程序）；
 *   ② 单实例：第二次启动只把 URL 交给已经在跑的那个实例，不新开窗口。
 * 单实例锁按 userData 目录区分，所以测试用的隔离数据目录与用户自己的实例互不打扰。
 */
const PROTOCOL = "lumin";

function threadIdFromArgs(args) {
  for (const a of args || []) {
    const m = String(a).match(/^lumin:\/\/thread\/([A-Za-z0-9_-]+)/i);
    if (m) return m[1];
  }
  return "";
}

function registerProtocol() {
  try {
    if (process.defaultApp) {
      // 开发期（npm start / electron .）：要把脚本路径一起注册，否则系统拉起来的是空壳
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
      }
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }
  } catch (e) {
    console.log("注册 " + PROTOCOL + ":// 失败（不影响其它功能）：" + ((e && e.message) || e));
  }
}

function openThreadFromArgs(args) {
  const sid = threadIdFromArgs(args);
  if (!sid) return false;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send("deeplink:thread", sid);
    console.log("DEEPLINK thread=" + sid);
  }
  return true;
}

let win = null;
let kernel = null;
let kernelDataDir = '';
let stopDesktopBridge = null;
let tray = null;
let quitting = false;
let trayHintShown = false;

/** 开发期用 dist/core，打包后用 resources/kernel。 */
function kernelPath() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "kernel", "lumin-core.exe") : null,
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

/**
 * 清掉「上次没正常退出」留下的数据库锁文件。
 *
 * 仓颉驱动用 <db>-cjflock 做跨进程互斥，但它在 Windows 上无法判断持锁进程是否已死
 * （见 third_party/sqlite-driver/src/storage_lockfile.cj：没有 /proc 时一律认为持锁者还活着），
 * 于是一次强杀（任务管理器 / 崩溃 / 自动化 smoke 的 kill）就会让数据目录永久不可用：
 * 之后每个要读库的接口都返回 500。外壳比驱动更适合做这件事——Node 能用
 * process.kill(pid, 0) 判断进程是否还在。
 */
function cleanStaleDbLock(dataDir) {
  const lock = path.join(dataDir, "itn.db-cjflock");
  try {
    if (!fs.existsSync(lock)) return false;
    const text = fs.readFileSync(lock, "utf8").trim();
    const pid = parseInt(String(text).split(/\s+/)[0], 10);
    let alive = false;
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (e) {
        alive = !!(e && e.code === "EPERM"); // 存在但没权限：当成还活着，宁可多等
      }
    }
    if (alive) {
      console.log("数据库锁的持有者 pid " + pid + " 仍在运行，保留锁文件");
      return false;
    }
    const aside = lock + ".stale-" + Date.now();
    fs.renameSync(lock, aside);
    console.log("清理了残留的数据库锁（pid " + pid + " 已不存在）：" + aside);
    return true;
  } catch (e) {
    console.log("清理数据库锁失败：" + ((e && e.message) || e));
    return false;
  }
}

/**
 * 数据目录。
 *
 * 软件从 ITN-Desktop 改名 Lumin，但**绝不能**让用户的学习数据看起来丢了：
 * 新目录没有库、老目录有库时，先把老目录整体拷过来（老目录原样留着当备份）；
 * 拷贝失败就继续用老目录 —— 宁可名字旧，也不能把数据放丢。
 */
function resolveDataDir(dataRoot) {
  const fresh = path.join(dataRoot, "Lumin");
  const legacy = path.join(dataRoot, "ITN-Desktop");
  try {
    if (fs.existsSync(path.join(fresh, "itn.db"))) return fresh;      // 新目录已经有数据
    if (!fs.existsSync(path.join(legacy, "itn.db"))) return fresh;    // 老目录也没有，正常新建
    fs.mkdirSync(fresh, { recursive: true });
    fs.cpSync(legacy, fresh, { recursive: true, force: true });
    // 拷过来的可能是"上次被强杀留下的锁标记"，在 Windows 上它会一直被认成有人持锁
    for (const f of fs.readdirSync(fresh)) {
      if (f.indexOf("itn.db-cjflock") === 0) fs.rmSync(path.join(fresh, f), { recursive: true, force: true });
    }
    console.log("DATA_MIGRATED " + legacy + " -> " + fresh);
    return fresh;
  } catch (e) {
    console.log("DATA_MIGRATE_FAIL " + ((e && e.message) || e) + " —— 继续用老目录");
    return legacy;
  }
}

async function startKernel() {
  const exe = kernelPath();
  if (!exe) throw new Error("找不到内核可执行文件，请先运行 scripts/package.ps1");
  const portFile = path.join(os.tmpdir(), "lumin-" + Date.now() + ".port");
  const uiDir = path.join(__dirname, "renderer");
  // 与内核独立运行时的默认目录保持一致。此前用 Electron 的 userData，
  // 导致同一个软件出现两个数据目录，用户和文档都会对不上。
  const dataRoot = process.env.LOCALAPPDATA || app.getPath("userData");
  const dataDir = resolveDataDir(dataRoot);
  kernelDataDir = dataDir;
  fs.mkdirSync(dataDir, { recursive: true });
  cleanStaleDbLock(dataDir);

  // 随包内置的技能（只读）：与界面同目录，打包时一起进 resources/app
  const skillsDir = path.join(__dirname, "skills");
  kernel = spawn(exe, ["--data-dir", dataDir, "--port-file", portFile, "--ui-dir", uiDir, "--skills-dir", skillsDir], {
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

/**
 * 托盘：关掉窗口不退出，Lumin 留在右下角；点托盘图标就回来。
 * --smoke 不建托盘（自检会连续起进程，别在任务栏留一堆图标）。
 */
function createTray() {
  if (tray || SMOKE) return;
  try {
    const image = nativeImage.createFromPath(path.join(__dirname, "assets", "logo.png"));
    tray = new Tray(image.resize({ width: 16, height: 16 }));
    tray.setToolTip("Lumin");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开 Lumin", click: () => showMainWindow() },
      { type: "separator" },
      { label: "退出", click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on("click", () => showMainWindow());
    tray.on("double-click", () => showMainWindow());
    if (process.env.LUMIN_TRAY_TEST === "1") { global.__luminTray = tray; global.__luminShowWindow = showMainWindow; }
  } catch (e) {
    console.log("TRAY_FAIL " + ((e && e.message) || e));
  }
}

function showMainWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function createWindow() {
  win = new BrowserWindow({
    // 先不显示：等启动动画页真正画出来（ready-to-show）再亮窗口 ——
    // 否则会先看到一段白/空窗口，就是用户说的"动画出现前卡一下"。
    show: false,
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: "Lumin",
    icon: path.join(__dirname, "assets", "logo.png"),
    // 自绘标题栏：Electron 的 frame:false 会把系统标题栏整条去掉，
    // 界面自己在顶部画一条深绿色的框（brand + 窗口按钮），看起来才是"一个软件"。
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#141614" : "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  if (win.removeMenu) win.removeMenu();
  let winShown = false;
  const showWindowNow = () => {
    if (winShown || process.argv.includes("--ui-check")) return;
    winShown = true;
    if (win && !win.isDestroyed()) win.show();
  };
  win.once("ready-to-show", showWindowNow);
  setTimeout(showWindowNow, 3000);   // 兜底：万一 ready-to-show 没来，3 秒后照常显示
  createTray();
  /* 先把启动动画放出来，再去等内核：仓颉内核冷启动要一两秒，这段时间不该只有一个空窗口。
     动画页在 renderer/splash.html（透明底 logo 的呼吸 + 光影扫过），内核起来后整页切到应用。
     --smoke 跳过动画页：冒烟脚本的 did-finish-load 检查只认应用页。 */
  const splashAt = Date.now();
  if (!SMOKE) {
    try { win.loadFile(path.join(__dirname, "renderer", "splash.html")); } catch (e) { /* 没有动画页就干等内核 */ }
  }
  let port;
  try {
    port = await startKernel();
    stopDesktopBridge?.();
    stopDesktopBridge = require('./desktop-bridge').startDesktopBridge('http://127.0.0.1:'+port,kernelDataDir);
  } catch (e) {
    dialog.showErrorBox("启动失败", String((e && e.message) || e));
    app.quit();
    return;
  }
  /* 让启动动画至少完整播一遍（约 0.9 秒）：内核在空数据目录上冷启很快，
     若立刻切走只剩一闪而过的 logo，看起来反而像卡了一下。 */
  if (!SMOKE) {
    const elapsed = Date.now() - splashAt;
    if (elapsed < 900) await new Promise((r) => setTimeout(r, 900 - elapsed));
  }
  win.webContents.on("context-menu", (_event, params) => {
    const flags = params.editFlags || {};
    if (!params.isEditable && !params.selectionText) return;
    const items = params.isEditable ? [
      { id: "undo", role: "undo", label: "撤销", enabled: !!flags.canUndo },
      { id: "redo", role: "redo", label: "重做", enabled: !!flags.canRedo },
      { type: "separator" },
      { id: "cut", role: "cut", label: "剪切", enabled: !!flags.canCut },
      { id: "copy", role: "copy", label: "复制", enabled: !!flags.canCopy },
      { id: "paste", role: "paste", label: "粘贴", enabled: !!flags.canPaste },
      { id: "paste-plain", role: "pasteAndMatchStyle", label: "粘贴为纯文本", enabled: !!flags.canPaste },
      { id: "delete", role: "delete", label: "删除", enabled: !!flags.canDelete },
      { type: "separator" },
      { id: "select-all", role: "selectAll", label: "全选", enabled: !!flags.canSelectAll },
    ] : [
      { id: "copy", role: "copy", label: "复制", enabled: !!flags.canCopy },
      { id: "select-all", role: "selectAll", label: "全选" },
    ];
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  const selectedFiles = new Set();
  const imageAttachment = (file) => {
    if (fs.statSync(file).size > 10 * 1024 * 1024) throw new Error("图片文件不能超过10MiB");
    let image = nativeImage.createFromPath(file);
    if (image.isEmpty()) throw new Error("这不是可识别的图片");
    const size = image.getSize();
    if (Math.max(size.width, size.height) > 2048) image = image.resize(size.width >= size.height ? {width:2048} : {height:2048});
    let bytes = image.toPNG(), mime = "image/png";
    if (bytes.length > 2 * 1024 * 1024) { bytes = image.toJPEG(85); mime = "image/jpeg"; }
    const dataUrl = "data:" + mime + ";base64," + bytes.toString("base64");
    if (dataUrl.length > 4 * 1024 * 1024) throw new Error("图片仍然太大，请选择较小的图片");
    return { kind:"image", name:path.basename(file), mime, dataUrl };
  };
  ipcMain.handle("dlg:pick-image", async () => {
    const result = await dialog.showOpenDialog(win, {title:"添加图片", properties:["openFile","multiSelections"], filters:[{name:"图片",extensions:["png","jpg","jpeg","webp","gif"]}]});
    if (result.canceled) return {ok:true, images:[]};
    if (result.filePaths.length > 4) return {ok:false,error:"每轮最多添加4张图片"};
    try { return {ok:true,images:result.filePaths.map(imageAttachment)}; } catch(e) { return {ok:false,error:e.message}; }
  });
  ipcMain.handle("image:read-selected", (_event, file) => {
    if (!selectedFiles.has(file)) return {ok:false,error:"请先通过文件选择器选择图片"};
    try { return {ok:true,image:imageAttachment(file)}; } catch(e) { return {ok:false,error:e.message}; }
  });
  // 窗口与任务栏都用网页版那个 logo（打包脚本会把 assets 一起带进 resources/app）
  try {
    win.setIcon(path.join(__dirname, "assets", "logo.png"));
  } catch (e) {
    console.log("设置窗口图标失败：" + ((e && e.message) || e));
  }

  // 窗口按钮走 IPC：渲染层只拿到三个方法，拿不到 Node
  ipcMain.on("win:minimize", () => { if (win) win.minimize(); });
  ipcMain.on("win:toggle-maximize", () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on("win:close", () => { if (win) win.close(); });
  /**
   * 选一个本机目录（登记知识库用）。
   *
   * 为什么必须走主进程：渲染层是普通网页（同源 http://127.0.0.1:port），
   * 网页没有"读本机绝对路径"的能力，只有 Electron 的 dialog 有。
   * 返回绝对路径字符串；用户取消就返回空串，界面不该把取消当成失败。
   */
  ipcMain.handle("dlg:pick-directory", async () => {
    if (!win) return "";
    const r = await dialog.showOpenDialog(win, {
      title: "选择资料目录",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "用这个目录",
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return "";
    return r.filePaths[0];
  });
  /**
   * 选一份资料文件（导入单个文件用）。
   *
   * 与"选目录"分开：系统对话框本身就分 openFile / openDirectory 两种，
   * 分开之后"这条路径是文件还是文件夹"就不需要再去猜了。
   */
  /**
   * 用系统默认程序打开路径。
   *
   * 侧栏项目菜单里的"在资源管理器中打开"、演示页的"用 PowerPoint 打开"都走这一条：
   * 路径由渲染层给，但只做"打开"，不读内容、不执行任何东西。
   */
  ipcMain.handle("shell:open-path", async (_e, p) => {
    if (!p) return { ok: false, error: "没有路径" };
    try {
      if (!fs.existsSync(p)) return { ok: false, error: "路径不存在：" + p };
      const msg = await shell.openPath(p);
      return msg ? { ok: false, error: msg } : { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  /**
   * 读演示文稿的文字（离线，只读）。
   *
   * pptx 就是一个 ZIP，壳里自己解一次中央目录就够了 —— 不引入依赖，
   * 打包后照样能用；老 .ppt 只能给出粗提取的文本，这一点在返回值里如实标出来。
   */
  /** 选一份演示文稿（.pptx / .ppt）—— 学习资源页的"打开演示文稿…"用。 */
  ipcMain.handle("dlg:pick-deck", async () => {
    if (!win) return "";
    const r = await dialog.showOpenDialog(win, {
      title: "选一份演示文稿",
      properties: ["openFile"],
      filters: [
        { name: "演示文稿", extensions: ["pptx", "pptm", "ppt"] },
        { name: "所有文件", extensions: ["*"] },
      ],
      buttonLabel: "打开它",
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return "";
    return r.filePaths[0];
  });

  ipcMain.handle('resource:read',async (_event,p)=>{
    try{return await require('./resource-reader').readResourceFile(p);}
    catch(e){return {ok:false,error:String(e.message||e)};}
  });
  ipcMain.handle("deck:read", async (_e, p) => {
    if (!p) return { ok: false, error: "没有路径" };
    if (!fs.existsSync(p)) return { ok: false, error: "文件不存在：" + p };
    try {
      const deck = require("./pptx").readDeck(p);
      return { ok: true, kind: deck.kind, slides: deck.slides };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  /** 选一份文档（.docx / .doc）—— 学习资源页的"打开文档…"用。 */
  ipcMain.handle("dlg:pick-doc", async () => {
    if (!win) return "";
    const r = await dialog.showOpenDialog(win, {
      title: "选一份文档",
      properties: ["openFile"],
      filters: [
        { name: "文档", extensions: ["docx", "docm", "doc"] },
        { name: "所有文件", extensions: ["*"] },
      ],
      buttonLabel: "打开它",
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return "";
    return r.filePaths[0];
  });

  ipcMain.handle("doc:read", async (_e, p) => {
    if (!p) return { ok: false, error: "没有路径" };
    if (!fs.existsSync(p)) return { ok: false, error: "文件不存在：" + p };
    try {
      const doc = require("./pptx").readDoc(p);
      return { ok: true, kind: doc.kind, paragraphs: doc.paragraphs };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  /**
   * 把一份 Markdown 导成**可编辑**的 .pptx / .docx（离线、零依赖，写包的是 shell/deck-export.js）。
   *
   * 学习成果本来就是 Markdown；要交给别人、或者自己接着改，就得有 Office 文件。
   * 保存路径让用户自己挑（系统对话框），失败原样返回错误，不假装成功。
   */
  ipcMain.handle("export:resource", async (_e, payload) => {
    const md = String((payload && payload.markdown) || "");
    const kind = String((payload && payload.kind) || "pptx").toLowerCase();
    const suggested = String((payload && payload.name) || "学习资源").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
    if (!md.trim()) return { ok: false, error: "这份资源没有内容可导出" };
    if (!win) return { ok: false, error: "没有窗口" };
    const isPptx = kind === "pptx";
    const r = await dialog.showSaveDialog(win, {
      title: isPptx ? "导出为 PowerPoint" : "导出为 Word 文档",
      defaultPath: suggested + (isPptx ? ".pptx" : ".docx"),
      filters: isPptx ? [{ name: "PowerPoint 演示文稿", extensions: ["pptx"] }]
                      : [{ name: "Word 文档", extensions: ["docx"] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      const mod = require("./deck-export");
      if (isPptx) mod.exportPptx(md, r.filePath);
      else mod.exportDocx(md, r.filePath);
      return { ok: true, path: r.filePath };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle("dlg:pick-file", async () => {
    if (!win) return "";
    const r = await dialog.showOpenDialog(win, {
      title: "选择一份资料文件",
      properties: ["openFile"],
      filters: [
        { name: "可读的资料", extensions: ["md", "markdown", "txt", "text", "csv", "tsv", "log", "json", "html", "htm"] },
        { name: "所有文件", extensions: ["*"] },
      ],
      buttonLabel: "用这个文件",
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return "";
    selectedFiles.add(r.filePaths[0]);
    return r.filePaths[0];
  });

  const pushWindowState = () => {
    if (win) win.webContents.send("win:state", { maximized: win.isMaximized() });
  };
  win.on("maximize", pushWindowState);
  win.on("unmaximize", pushWindowState);

  /* 点右上角 × 只是把窗口收进托盘：任务继续在本地跑，点托盘图标就回来。
     真正的退出走托盘菜单"退出"/应用退出流程（before-quit 里把 quitting 置位）。 */
  win.on("close", (event) => {
    if (SMOKE || quitting) return;
    event.preventDefault();
    win.hide();
    if (tray && !trayHintShown && process.env.LUMIN_TRAY_TEST !== "1") {
      trayHintShown = true;
      try { tray.displayBalloon({ title: "Lumin 在后台待命", content: "点右下角托盘图标就能回到应用。" }); } catch (e) { /* 系统不支持气球提示就算了 */ }
    }
  });

  win.webContents.on("did-fail-load", (_e, code, desc) => {
    console.log("SMOKE_LOAD_FAIL " + code + " " + desc);
    if (SMOKE) app.quit();
  });

  win.webContents.on("did-finish-load", async () => {
    // 启动动画页也会触发 did-finish-load：只有应用页（http）才做深链与冒烟检查
    if (!/^https?:/i.test(win.webContents.getURL())) return;
    // 本次是被链接拉起来的：等界面就绪后把那段会话打开
    const bootSid = threadIdFromArgs(process.argv);
    if (bootSid) setTimeout(() => { if (win) win.webContents.send("deeplink:thread", bootSid); console.log("DEEPLINK thread=" + bootSid); }, 1200);
    if (!SMOKE) return;
    const lines = [];
    try {
      const title = await win.webContents.executeJavaScript("document.title");
      const status = await win.webContents.executeJavaScript("document.getElementById('status').textContent");
      // 界面改成多页面后，用"导航项数 + 首屏节点数"判断界面真的渲染出来了；
      // 原来数的是 .panel，那个类名早就没有了，等于一直在数 0。
      // preload 没挂上就没有自绘窗口按钮可用：这一条必须能在打包版里验证
      const preloadOk = await win.webContents.executeJavaScript("!!(window.itnWindow && window.itnWindow.minimize && window.itnWindow.onDeepLink && window.itnWindow.readDeck && window.itnWindow.readDoc)");
      const titlebar = await win.webContents.executeJavaScript("!!document.querySelector('#titlebar')");
      lines.push("PRELOAD=" + (preloadOk ? "ok" : "missing"));
      lines.push("TITLEBAR=" + (titlebar ? "ok" : "missing"));
      const navs = await win.webContents.executeJavaScript("document.querySelectorAll('.nav-item').length");
      // did-finish-load 只是页面加载完，boot() 里还要等内核握手与读配置，
      // 这里最多等 10 秒，直到首页真的渲染出内容为止。
      let nodes = 0;
      for (let i = 0; i < 48; i++) {
        // 等到"首页真的渲染完"：有卡片，且不在加载态（加载态里有个 spinner）
        const ready = await win.webContents.executeJavaScript(
          "document.querySelectorAll('#view .card').length > 0 && !document.querySelector('#view .spinner')");
        if (ready) {
          nodes = await win.webContents.executeJavaScript("document.querySelectorAll('#view .card, #view .empty').length");
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      const check = await win.webContents.executeJavaScript("(document.querySelector('#view')||{}).innerText");
      lines.push("TITLE=" + title);
      lines.push("STATUS=" + status);
      lines.push("NAV=" + navs);
      lines.push("VIEW_NODES=" + nodes);
      lines.push("VIEW_TEXT=" + String(check || "").replace(/\s+/g, " ").slice(0, 60));
      /* 文档预览的完整链路（渲染层 → preload → 主进程 → pptx.js）：给了样张就真读一遍。
         用 executeJavaScript 调 window.itnWindow.readDoc = 真的过一次 IPC，不是直接调模块。 */
      const docFixture = process.env.LUMIN_SMOKE_DOC || "";
      let docOk = true;
      if (docFixture) {
        const r = await win.webContents.executeJavaScript("window.itnWindow.readDoc(" + JSON.stringify(docFixture) + ")");
        docOk = !!(r && r.ok && (r.paragraphs || []).length > 0);
        lines.push("DOCX=" + (docOk ? ("ok paragraphs=" + (r.paragraphs || []).length) : ("ERR " + ((r && r.error) || "?"))));
      } else {
        lines.push("DOCX=skipped（没有样张）");
      }
      lines.push("RESULT=" + (navs > 0 && nodes > 0 && docOk ? "OK" : "ERR 界面没渲染出来"));
    } catch (e) {
      lines.push("RESULT=ERR " + ((e && e.message) || e));
    }
    for (const l of lines) console.log("SMOKE_" + l);
    // 打包后的 Electron 是 GUI 程序，控制台看不到输出，因此同时写文件
    fs.writeFileSync(path.join(os.tmpdir(), "lumin-smoke-result.txt"), lines.join("\n"), "utf8");
    setTimeout(() => app.quit(), 200);
  });

  win.loadURL("http://127.0.0.1:" + port + "/");
  win.on("closed", () => { win = null; });
}

registerProtocol();
/* 第二个实例只负责把链接转交给第一个实例。
   --smoke 时不抢锁：自检会连续起进程，锁会让后面的实例直接退出。 */
if (!SMOKE) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on("second-instance", (_e, argv) => { openThreadFromArgs(argv); showMainWindow(); });
  }
}
/* macOS 的链接走 open-url 事件（Windows/Linux 走 argv） */
app.on("open-url", (e, url) => { e.preventDefault(); openThreadFromArgs([url]); });

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (quitting) app.quit(); });
app.on("before-quit", () => {
  quitting = true;
  if (kernel) { try { kernel.kill(); } catch (e) { /* ignore */ } }
});
