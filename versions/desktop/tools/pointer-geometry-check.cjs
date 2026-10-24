/**
 * 点击域与组件位置回归。
 *
 * 真实 Edge + 隔离仓颉内核。对可见控件中心点和左右 25% 点执行
 * document.elementFromPoint()，并额外覆盖滚动、缩放、浮层和画布坐标。
 * 截图与 JSON 报告写入 tmp/pointer-geometry/。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright");

const root = path.resolve(__dirname, "..");
const uiDir = process.env.ITN_UI_DIR ? path.resolve(process.env.ITN_UI_DIR) : path.join(root, "shell/renderer");
const outDir = path.join(root, "tmp/pointer-geometry");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const pages = [
  ["home", null],
  ["learn", null],
  ["report", null],
  ["calibrate", null],
  ["notes", null],
  ["resources", null],
  ["kb", null],
  ["chat", null],
  ["chat", "overview"],
  ["models", null],
  ["memory", null],
  ["wrong", null],
  ["settings", "general"],
  ["settings", "appearance"],
  ["settings", "kb"],
  ["settings", "models"],
  ["settings", "agent"],
  ["settings", "data"],
  ["settings", "skills"],
  ["settings", "about"]
];

const compactPages = [
  ["home", null],
  ["learn", null],
  ["resources", null],
  ["kb", null],
  ["chat", null],
  ["settings", "models"]
];

async function until(fn, timeout = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn()) return;
    await sleep(100);
  }
  throw Error("等待条件超时");
}

async function installPointerAudit(page) {
  await page.evaluate(() => {
    const selector = [
      "button",
      "a[href]",
      "input:not([type=hidden])",
      "select",
      "textarea",
      "summary",
      "[role=button]",
      "[role=tab]",
      "[role=menuitem]",
      "[role=checkbox]",
      "[role=switch]",
      "[role=option]",
      ".clickable",
      ".knowledge-ev-card"
    ].join(",");

    const desc = element => {
      if (!element) return "null";
      const id = element.id ? "#" + element.id : "";
      const cls = String(element.className || "").trim().split(/\s+/).filter(Boolean).slice(0, 3).map(x => "." + x).join("");
      const text = String(element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 28);
      return element.tagName.toLowerCase() + id + cls + (text ? " [" + text + "]" : "");
    };

    const candidate = element => element.closest(selector);
    const clickable = (source, hit) => {
      if (!hit) return false;
      if (hit === source || source.contains(hit)) return true;
      const hitCandidate = candidate(hit);
      if (hitCandidate && (hitCandidate === source || hitCandidate.contains(source) || source.contains(hitCandidate))) return true;
      if (source.matches("input,select,textarea") && source.labels) {
        return [...source.labels].some(label => label === hit || label.contains(hit));
      }
      return false;
    };

    const visibleRect = element => {
      const rect = element.getBoundingClientRect();
      let left = Math.max(0, rect.left);
      let top = Math.max(0, rect.top);
      let right = Math.min(innerWidth, rect.right);
      let bottom = Math.min(innerHeight, rect.bottom);
      for (let parent = element.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const box = parent.getBoundingClientRect();
        if (style.overflowX !== "visible") {
          left = Math.max(left, box.left + parent.clientLeft);
          right = Math.min(right, box.left + parent.clientLeft + parent.clientWidth);
        }
        if (style.overflowY !== "visible") {
          top = Math.max(top, box.top + parent.clientTop);
          bottom = Math.min(bottom, box.top + parent.clientTop + parent.clientHeight);
        }
      }
      return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    };

    window.__luminPointerAudit = ({ rootSelector = "body" } = {}) => {
      const root = document.querySelector(rootSelector) || document.body;
      const all = [...document.querySelectorAll(selector)].filter(el => root === document.body || root.contains(el));
      const seen = new Set();
      const controls = [];
      for (const el of all) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.closest("[hidden],[aria-hidden=true]")) continue;
        if (el.matches(":disabled,[aria-disabled=true]")) continue;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
        const rect = el.getBoundingClientRect();
        const visible = visibleRect(el);
        if (rect.width < 2 || rect.height < 2) continue;
        if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) continue;
        if (visible.width < 2 || visible.height < 2) continue;
        controls.push({ el, rect, visible, style });
      }

      const issues = [];
      const byControl = new Map();
      for (const { el, rect, visible, style } of controls) {
        const xPoints = visible.width >= 18 ? [visible.left + visible.width * .25, visible.left + visible.width * .5, visible.left + visible.width * .75] : [visible.left + visible.width * .5];
        const y = visible.top + visible.height * .5;
        const failures = [];
        for (const x of xPoints) {
          if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) continue;
          const hit = document.elementFromPoint(x, y);
          if (!clickable(el, hit)) failures.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, hit: desc(hit) });
        }
        if (failures.length) {
          const issue = {
            control: desc(el),
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
            pointerEvents: style.pointerEvents,
            failures
          };
          issues.push(issue);
          byControl.set(el, issue);
        }
      }

      /*
       * elementFromPoint 会命中画布本身，无法发现 canvas 内部自绘区域的坐标偏移。
       * 这里只记录画布和缩放链路，具体命中由独立 canvas 用例验证。
       */
      const canvases = [...root.querySelectorAll("canvas")].filter(canvas => {
        const rect = canvas.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
      }).map(canvas => {
        const rect = canvas.getBoundingClientRect();
        return {
          className: desc(canvas),
          client: { w: canvas.clientWidth, h: canvas.clientHeight },
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          ratio: {
            x: rect.width ? canvas.clientWidth / rect.width : 0,
            y: rect.height ? canvas.clientHeight / rect.height : 0
          }
        };
      });

      return {
        root: rootSelector,
        viewport: { width: innerWidth, height: innerHeight, zoom: getComputedStyle(document.body).zoom },
        controls: controls.length,
        issues,
        canvases
      };
    };
  });
}

async function audit(label, page, report, failures, rootSelector = "body") {
  const result = await page.evaluate(selector => window.__luminPointerAudit({ rootSelector: selector }), rootSelector);
  report.push({ label, ...result });
  for (const issue of result.issues) {
    failures.push({ label, ...issue });
    console.error("FAIL " + label + " :: " + issue.control + " -> " + issue.failures.map(x => x.hit).join(" | "));
  }
  return result;
}

async function scanScrollable(label, page, report, failures, selector) {
  const scroll = page.locator(selector).first();
  if (!(await scroll.count())) {
    await audit(label + " / missing " + selector, page, report, failures);
    return;
  }
  const values = await scroll.evaluate(el => {
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    if (max < 2) return [0];
    return [...new Set([0, Math.round(max * .5), max])];
  });
  for (const top of values) {
    await scroll.evaluate((el, value) => { el.scrollTop = value; }, top);
    await sleep(80);
    await audit(label + " / scroll=" + top, page, report, failures, selector);
  }
  await scroll.evaluate(el => { el.scrollTop = 0; });
}

async function auditPage(page, report, failures, spec, config) {
  const [name, section] = spec;
  const base = config.name + "/" + name + (section ? "/" + section : "");
  console.log("SCAN " + base);
  const expected = name === "calibrate"
    ? { name: "report", section: "" }
    : name === "models"
      ? { name: "settings", section: "models" }
      : name === "wrong"
        ? { name: "notes", section: "" }
        : name === "settings" && section === "kb"
          ? { name: "kb", section: "manage" }
          : { name, section: section || "" };
  try {
    await page.evaluate(({ name, section }) => go(name, section || null), { name, section });
    await page.waitForFunction(
      expected => current === expected.name && (!expected.section || currentSection === expected.section) && document.getElementById("view")?.getAttribute("aria-busy") === "false",
      expected,
      { timeout: 30000 }
    );
  } catch (error) {
    const state = await page.evaluate(() => ({
      current: typeof current === "string" ? current : "",
      section: typeof currentSection === "string" ? currentSection : "",
      busy: document.getElementById("view")?.getAttribute("aria-busy"),
      title: document.getElementById("page-title")?.textContent || "",
      body: String(document.getElementById("view")?.textContent || "").replace(/\s+/g, " ").slice(0, 240)
    })).catch(() => ({}));
    failures.push({ label: base, kind: "navigation-timeout", error: error.message, state });
    console.error("FAIL " + base + " / navigation :: " + JSON.stringify(state));
    await page.screenshot({ path: path.join(outDir, base.replace(/[\\/]/g, "-") + "-navigation-fail.png") }).catch(() => {});
    return;
  }
  await sleep(180);
  await scanScrollable(base + " / view", page, report, failures, "#view");
  if (await page.locator("#panel-body").count()) {
    const panelScrollable = await page.locator("#panel-body").evaluate(el => el.scrollHeight > el.clientHeight + 2);
    if (panelScrollable) await scanScrollable(base + " / panel", page, report, failures, "#panel-body");
  }
}

async function assertInsideViewport(page, locator, label, failures, padding = 0) {
  const viewport = await page.viewportSize();
  const box = await locator.evaluate(el => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  });
  const ok = box.width > 0 && box.height > 0 && box.x >= padding - .5 && box.y >= padding - .5 && box.right <= viewport.width - padding + .5 && box.bottom <= viewport.height - padding + .5;
  if (!ok) failures.push({ label, kind: "outside-viewport", box });
  return { ok, box };
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumin-pointer-geometry-"));
  const portFile = path.join(dataDir, "port");
  const core = spawn(path.join(root, "dist/core/itn-desktop-core.exe"), [
    "--data-dir=" + dataDir,
    "--port-file=" + portFile,
    "--ui-dir=" + uiDir,
    "--seed-course-fixture=1"
  ], { windowsHide: true, stdio: "ignore" });

  let browser;
  let passed = 0;
  const failures = [];
  const report = [];
  const check = (name, ok, detail = "") => {
    if (ok) {
      passed++;
      console.log("PASS " + name);
    } else {
      failures.push({ label: name, kind: "assertion", detail });
      console.error("FAIL " + name + (detail ? " :: " + detail : ""));
    }
  };

  try {
    await until(() => fs.existsSync(portFile), 10000);
    const base = "http://127.0.0.1:" + fs.readFileSync(portFile, "utf8").trim();
    const post = async (route, body = {}) => {
      const response = await fetch(base + route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await response.json();
      if (payload.code !== 0) throw Error(route + ": " + payload.message);
      return payload.data;
    };

    const courseJob = await post("/api/course/generate", { kbId: "course-alpha" });
    await until(async () => {
      const state = await post("/api/course/job", { id: courseJob.id });
      return state.status !== "running";
    }, 30000);
    await post("/api/models/save", {
      id: "pointer-fixture",
      name: "点击域夹具",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "fixture",
      model: "fixture"
    });
    await post("/api/models/roles", { chatModelId: "pointer-fixture" });

    const nodeIds = [];
    for (let i = 0; i < 6; i++) {
      const saved = await post("/api/knowledge/save", {
        title: "点击命中知识点 " + i,
        definition: "用于检查缩放后的画布命中域。",
        color: ["#4F86C6", "#3AAE8F", "#D1A153", "#D56A63", "#8268C9", "#6E9B4B"][i]
      });
      nodeIds.push(saved.id);
      if (i) await post("/api/knowledge/link", { from: nodeIds[i - 1], to: saved.id, label: "关联" });
    }

    browser = await chromium.launch({
      channel: "msedge",
      headless: true,
      args: ["--no-proxy-server"]
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(base, { waitUntil: "load" });
    await page.waitForFunction(() => !document.getElementById("boot"), null, { timeout: 20000 });
    await page.waitForSelector(".notification-btn", { timeout: 15000 });
    await installPointerAudit(page);

    for (const config of [
      { name: "wide-130", width: 1440, height: 960, zoom: 1.3, pages },
      { name: "lap-100", width: 1024, height: 820, zoom: 1, pages: compactPages },
      { name: "narrow-100", width: 768, height: 820, zoom: 1, pages: compactPages }
    ]) {
      await page.setViewportSize({ width: config.width, height: config.height });
      await page.evaluate(value => setZoom(value), config.zoom);
      await page.waitForFunction(value => Math.abs(Number(document.body.style.zoom) - value) < .001, config.zoom);
      await sleep(180);
      for (const spec of config.pages) {
        await auditPage(page, report, failures, spec, config);
      }
    }

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.evaluate(() => setZoom(1.3));
    await page.waitForFunction(() => Math.abs(Number(document.body.style.zoom) - 1.3) < .001);
    await page.evaluate(() => go("chat", null));
    await page.waitForFunction(() => current === "chat" && document.getElementById("view")?.getAttribute("aria-busy") === "false");
    await sleep(180);

    const taskButton = page.locator(".task-btn");
    const noticeButton = page.locator(".notification-btn");
    await taskButton.click();
    await page.waitForSelector(".task-pop:not([hidden])");
    await audit("dynamic/task-pop", page, report, failures, ".task-center");
    await assertInsideViewport(page, page.locator(".task-pop"), "task-pop bounds", failures);

    await noticeButton.click();
    await page.waitForSelector(".notification-pop:not([hidden])");
    const openTopPopovers = await page.evaluate(() => ({
      tasks: !document.querySelector(".task-pop")?.hidden,
      notifications: !document.querySelector(".notification-pop")?.hidden
    }));
    check("top bar keeps task and notification popovers mutually exclusive", !openTopPopovers.tasks || !openTopPopovers.notifications, JSON.stringify(openTopPopovers));
    await audit("dynamic/notification-pop", page, report, failures, ".notification-center");
    await assertInsideViewport(page, page.locator(".notification-pop"), "notification-pop bounds", failures);
    await page.screenshot({ path: path.join(outDir, "top-popovers-130.png") });

    await page.evaluate(() => {
      window.LuminNotifications?.close?.();
      document.querySelector(".task-pop")?.setAttribute("hidden", "");
      document.querySelector(".notification-pop")?.setAttribute("hidden", "");
      document.querySelector(".task-btn")?.setAttribute("aria-expanded", "false");
      document.querySelector(".notification-btn")?.setAttribute("aria-expanded", "false");
    });

    await page.evaluate(() => {
      const trigger = document.createElement("button");
      trigger.id = "pointer-modal-trigger";
      trigger.textContent = "触发";
      document.body.appendChild(trigger);
      trigger.focus();
      confirmDialog("检查弹窗点击域", "只检查位置与点击命中，不执行任何写入。", async () => {}, {
        confirmLabel: "继续",
        danger: false
      });
    });
    await page.waitForSelector(".app-modal-layer");
    await audit("dynamic/confirmation-modal", page, report, failures, ".app-modal-layer");
    await assertInsideViewport(page, page.locator(".app-modal-layer"), "confirmation modal bounds", failures);
    await page.screenshot({ path: path.join(outDir, "confirmation-modal-130.png") });
    await page.keyboard.press("Escape");
    await page.waitForSelector(".app-modal-layer", { state: "detached" });

    await page.evaluate(() => openPalette());
    await page.waitForSelector(".palette-box");
    await audit("dynamic/command-palette", page, report, failures, "#palette");
    await assertInsideViewport(page, page.locator(".palette-box"), "command palette bounds", failures);
    await page.screenshot({ path: path.join(outDir, "command-palette-130.png") });
    await page.evaluate(() => closePalette());

    await page.evaluate(() => {
      window.LuminTeamPanel.ingest([
        {
          type: "team/run_started",
          turnId: "pointer-audit",
          payload: { runId: "pointer-audit-run", tool: "research_topic_team", goal: "检查协作面板的点击命中区域" }
        },
        {
          type: "team/node_created",
          turnId: "pointer-audit",
          payload: { runId: "pointer-audit-run", nodeId: "root", parentId: "", depth: 0, role: "规划者", title: "拆解学习任务", objective: "整理协作流程" }
        },
        {
          type: "team/node_created",
          turnId: "pointer-audit",
          payload: { runId: "pointer-audit-run", nodeId: "child-a", parentId: "root", depth: 1, role: "研究者", title: "检索资料", objective: "收集依据" }
        },
        {
          type: "team/node_created",
          turnId: "pointer-audit",
          payload: { runId: "pointer-audit-run", nodeId: "child-b", parentId: "root", depth: 1, role: "审校者", title: "核对结论", objective: "检查引用" }
        },
        {
          type: "team/node_started",
          turnId: "pointer-audit",
          payload: { runId: "pointer-audit-run", nodeId: "root", status: "running", label: "正在规划" }
        }
      ], "pointer-audit-session", { autoOpen: true });
    });
    await page.waitForSelector("#team-panel:not([hidden])");
    await sleep(350);
    await audit("dynamic/team-panel", page, report, failures, "#team-panel-scrim");
    await assertInsideViewport(page, page.locator("#team-panel"), "team panel bounds", failures);
    await page.screenshot({ path: path.join(outDir, "team-panel-130.png") });
    await page.evaluate(() => window.LuminTeamPanel.close({ immediate: true }));

    const knowledgeHitResults = [];
    for (const zoom of [.85, 1, 1.3]) {
      await page.evaluate(value => setZoom(value), zoom);
      await page.waitForFunction(value => Math.abs(Number(document.body.style.zoom) - value) < .001, zoom);
      await page.evaluate(() => go("home", null));
      await page.waitForSelector(".knowledge-canvas", { timeout: 20000 });
      await page.waitForFunction(() => document.getElementById("view")?.getAttribute("aria-busy") === "false");
      await page.evaluate(() => {
        knowledgeNet.stop?.();
        knowledgeNet.alpha = 0;
        knowledgeNet.introMotionUntil = 0;
        knowledgeNet.userInteracted = false;
        knowledgeNet.selected = "";
        knowledgeNet.fit(true);
        knowledgeNet.draw();
      });
      await sleep(80);
      for (const id of nodeIds) {
        const point = await page.evaluate(nodeId => {
          const canvas = document.querySelector(".knowledge-canvas");
          const rect = canvas.getBoundingClientRect();
          const node = knowledgeNet.projected.find(item => item.id === nodeId);
          if (!node) return null;
          return {
            x: rect.left + node.x * rect.width / canvas.clientWidth,
            y: rect.top + node.y * rect.height / canvas.clientHeight,
            radius: node.r
          };
        }, id);
        if (!point) {
          knowledgeHitResults.push({ zoom, id, ok: false, reason: "missing projected node" });
          continue;
        }
        await page.mouse.click(point.x, point.y);
        await sleep(70);
        const selected = await page.evaluate(() => knowledgeNet.selected);
        knowledgeHitResults.push({ zoom, id, ok: selected === id, selected, point });
      }
      await page.evaluate(() => {
        const drawer = document.getElementById("knowledge-detail");
        if (drawer) drawer.hidden = true;
        document.getElementById("knowledge-workspace")?.classList.remove("has-detail");
      });
    }
    const failedHits = knowledgeHitResults.filter(item => !item.ok);
    check("knowledge canvas nodes select at 85%, 100% and 130% zoom", failedHits.length === 0, JSON.stringify(failedHits));

    await page.evaluate(() => {
      const button = document.querySelector('.knowledge-seg[data-view="timeline"]');
      button?.click();
    });
    await page.waitForSelector(".knowledge-timeline", { timeout: 20000 });
    await audit("dynamic/knowledge-timeline", page, report, failures, "#view");
    await page.screenshot({ path: path.join(outDir, "knowledge-timeline.png") });

    check("no renderer exceptions during pointer geometry audit", pageErrors.length === 0, pageErrors.join(" | "));
    fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({
      generatedAt: new Date().toISOString(),
      uiDir,
      passed,
      failures,
      knowledgeHitResults,
      surfaces: report
    }, null, 2));
    console.log("RESULT=" + (!failures.length ? "OK" : "FAILED") + " " + passed + " passed, " + failures.length + " failed; data=" + dataDir);
    if (failures.length) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    core.kill();
  }
})().catch(error => {
  console.error("FAIL", error);
  process.exit(1);
});
