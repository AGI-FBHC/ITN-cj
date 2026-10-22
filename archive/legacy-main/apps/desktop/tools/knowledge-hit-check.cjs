/** Real pointer checks against the displayed canvas, with independent CSS zoom and DPI. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('D:/Desktop/ITN/ITN/src/frontend/agent-demo/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-knowledge-hit-'));
  const portFile = path.join(dir, 'port');
  const core = spawn(process.env.KC_CORE_EXE || path.join(root, 'dist/core/itn-desktop-core.exe'), [
    '--data-dir=' + dir, '--port-file=' + portFile,
    '--ui-dir=' + (process.env.KC_UI_DIR || path.join(root, 'shell/renderer'))
  ], { windowsHide: true, stdio: 'ignore' });
  let browser, page, passed = 0;
  const errors = [];
  const check = (name, ok, details) => {
    if (!ok) throw Error(name + (details ? ': ' + JSON.stringify(details) : ''));
    passed++;
  };
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // Convert the *painted bitmap* into screen coordinates. Do not reuse production hit math.
  const paintedPoint = (id, label = false) => page.evaluate(({ id, label }) => {
    const canvas = document.querySelector('.knowledge-canvas');
    const rect = canvas.getBoundingClientRect(), transform = canvas.getContext('2d').getTransform();
    const node = knowledgeNet.projected.find(p => p.id === id);
    const x = node.x + (label ? node.labelW * .44 : 0);
    return { id, x: rect.left + x * transform.a * rect.width / canvas.width,
      y: rect.top + node.y * transform.d * rect.height / canvas.height,
      logical: { x: node.x, y: node.y }, rect: { width: rect.width, height: rect.height },
      layout: { width: canvas.clientWidth, height: canvas.clientHeight } };
  }, { id, label });
  const clickNode = async (id, name, label = false) => {
    await frame();
    const point = await paintedPoint(id, label);
    await page.mouse.move(point.x, point.y);
    const hover = await page.locator('.knowledge-canvas').evaluate(e => e.style.cursor === 'pointer');
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(nid => knowledgeNet.selected === nid && !document.getElementById('knowledge-detail').hidden,
      id, { timeout: 3000 }).catch(() => {});
    check(name + ' selects the displayed node', await page.evaluate(nid => knowledgeNet.selected === nid, id), { ...point, hover });
    check(name + ' hover', hover, point);
    await frame();
  };
  try {
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
    const base = 'http://127.0.0.1:' + fs.readFileSync(portFile, 'utf8').trim();
    const post = async (url, body) => {
      const result = await (await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      if (result.code !== 0) throw Error(url + ': ' + result.message);
      return result.data;
    };
    const nodes = [];
    for (const title of ['输入与输出的约定（点选检查）', '模型上下文协议（点选检查）', '智能体工具调用（点选检查）']) {
      nodes.push(await post('/api/knowledge/save', { title, definition: '隔离数据：真实画布鼠标点选回归。' }));
    }
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    for (const dpr of [1, 1.25, 1.5, 2]) {
      const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: dpr });
      page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(base);
      await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 20000 });
      await page.evaluate(() => go('home'));
      await page.waitForSelector('.knowledge-canvas');
      for (const zoom of [.85, 1, 1.15, 1.3, 1.6]) {
        await page.evaluate(z => applyZoom(z), zoom);
        await frame();
        const tag = `DPI ${dpr}, page ${Math.round(zoom * 100)}%`;
        for (const node of nodes) {
          if (await page.locator('#knowledge-detail:not([hidden])').count()) {
            await page.getByRole('button', { name: '收起', exact: true }).click();
          }
          await clickNode(node.id, tag + ', closed drawer');
          const other = nodes.find(n => n.id !== node.id);
          await clickNode(other.id, tag + ', open drawer');
        }
        // The name extends beyond the orb; it must use the same coordinate conversion.
        const labelNode = nodes.find(n => n.id !== nodes[0].id);
        await clickNode(labelNode.id, tag + ', label', true);
        if (dpr === 1 && zoom === 1.3) {
          const shots = path.join(root, 'tmp/knowledge-hit-shots');
          fs.mkdirSync(shots, { recursive: true });
          await page.screenshot({ path: path.join(shots, 'page-130-drawer.png') });
        }
        console.log('PASS ' + tag + ': centers, labels and hover before/after drawer');
      }
      await context.close();
      page = null;
    }
    check('no JavaScript exceptions', errors.length === 0, errors);
    console.log('RESULT=OK ' + passed + ' checks; isolated data: ' + dir);
  } catch (error) {
    if (page && !page.isClosed()) {
      const shots = path.join(root, 'tmp/knowledge-hit-shots');
      fs.mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    core.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
