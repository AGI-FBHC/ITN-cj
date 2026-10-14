/**
 * ui-shot.cjs —— 桌面端界面自检：逐页截图 + 结构摘要（不依赖 Electron 窗口）
 *
 * 用法：
 *   node tools/ui-shot.cjs http://localhost:52212/ [输出目录]
 * 前提：内核带 --ui-dir 指向 shell/renderer 启动（tools/ui-flow.ps1 一键拉起 mock + 样例库 + 内核）。
 * 依赖：playwright + 本机 Edge（channel: msedge，不额外下载浏览器）。
 *       playwright 解析顺序：环境变量 ITN_PLAYWRIGHT_DIR → 本仓 node_modules → 兄弟仓 src/frontend/agent-demo/node_modules。
 *
 * 为什么需要它：桌面窗口在无界面环境里没法截图，而内核把同一份 index.html/app.js/style.css 通过 HTTP 提供；
 * 用无头浏览器访问同一份文件即可验证"结构 + 交互 + 视觉"，并把每页截图留作证据（tmp/ui-shots/）。
 */
const fs = require('node:fs');
const path = require('node:path');

function loadPlaywright() {
  const dirs = [
    process.env.ITN_PLAYWRIGHT_DIR,
    path.join(__dirname, '..', 'node_modules'),
    'D:\\Desktop\\ITN\\ITN\\src\\frontend\\agent-demo\\node_modules',
  ].filter(Boolean);
  const tried = [];
  for (const dir of dirs) {
    const candidate = path.join(dir, 'playwright');
    try {
      return require(candidate);
    } catch (err) {
      tried.push(candidate + ' (' + err.code + ')');
    }
  }
  console.error('未找到 playwright，已尝试：\n  ' + tried.join('\n  '));
  console.error('解决：设置 ITN_PLAYWRIGHT_DIR 指向含 playwright 的 node_modules，或在本仓 npm i -D playwright。');
  process.exit(2);
}

const { chromium } = loadPlaywright();

(async () => {
  const base = process.argv[2] || 'http://localhost:52212/';
  const outDir = process.argv[3] || path.join(process.cwd(), 'tmp', 'ui-shots');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 160)));

  await page.goto(base, { waitUntil: 'load', timeout: 20000 });
  await page.waitForSelector('.nav-item', { timeout: 15000 });

  const navItems = await page.$$eval('.nav-item', (els) => els.map((e) => e.textContent.trim()));
  const summary = { base, title: await page.title(), navItems, pages: [] };

  for (let i = 0; i < navItems.length; i += 1) {
    // 页面切换会重建侧栏，必须每次按索引重新定位，不能复用 elementHandle
    await page.locator('.nav-item').nth(i).click();
    await page.waitForTimeout(900);
    await page.waitForFunction(() => !document.querySelector('#view .empty .spinner'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(200);
    const info = await page.evaluate(() => ({
      title: (document.querySelector('#page-title') || {}).textContent || '',
      sub: (document.querySelector('#page-sub') || {}).textContent || '',
      viewLen: ((document.querySelector('#view') || {}).innerText || '').length,
      head: ((document.querySelector('#view') || {}).innerText || '').replace(/\s+/g, ' ').slice(0, 120),
      cards: document.querySelectorAll('#view .card').length,
      buttons: document.querySelectorAll('#view button').length,
      emptyStates: document.querySelectorAll('#view .empty').length,
      deadEnds: Array.from(document.querySelectorAll('#view .empty')).filter(function (e) { return !e.querySelector('button'); }).length,
      checklistDone: document.querySelectorAll('#view .check-item.done').length,
      topActions: ((document.querySelector('#top-actions') || {}).innerText || '').replace(/\s+/g, ' ').slice(0, 60),
    }));
    const safe = navItems[i].replace(/[^\w\u4e00-\u9fa5]+/g, '_');
    const file = path.join(outDir, String(i + 1).padStart(2, '0') + '-' + safe + '.png');
    // 滚动容器是 #view 而不是 document，fullPage 只能拍一屏；先把视口拉高再拍
    await page.setViewportSize({ width: 1440, height: 2600 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: file });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(80);
    summary.pages.push({ index: i + 1, nav: navItems[i], ...info, shot: path.relative(process.cwd(), file) });
  }

  summary.consoleErrors = consoleErrors;
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
})().catch((err) => { console.error('UI_SHOT_FAILED:', err.message); process.exit(1); });