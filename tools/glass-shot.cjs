/** 玻璃质感视觉验收：起一套隔离环境，逐页截图（tmp/glass-shots/）。
 *  用法：node tools/glass-shot.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

function loadPlaywright() {
  const dirs = [process.env.ITN_PLAYWRIGHT_DIR, path.join(__dirname, '..', 'node_modules'),
    'D:\\Desktop\\ITN\\ITN\\src\\frontend\\agent-demo\\node_modules'].filter(Boolean);
  for (const d of dirs) { try { return require(path.join(d, 'playwright')); } catch (e) { /* next */ } }
  console.error('未找到 playwright'); process.exit(2);
}
const { chromium } = loadPlaywright();
const REPO = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer(); s.unref();
  s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itn-glass-'));
  const kb = path.join(dir, 'kb');
  fs.mkdirSync(kb);
  fs.writeFileSync(path.join(kb, 'input.md'), '# 输入与输出的约定\n\n## 最小样例\n\n每次任务先写输入、规则、期望输出和验收标准；记录中间状态，让另一人能复现。\n');
  fs.writeFileSync(path.join(kb, 'validate.md'), '# 输入与输出的验收\n\n## 边界与异常\n\n正常、最小、最大、异常输入分别验证；先预测再执行，对照差异。\n');

  const mockPort = await freePort();
  const mock = spawn('python', [path.join(REPO, 'tools/mock-openai/server.py'), String(mockPort)],
    { cwd: REPO, windowsHide: true, stdio: 'ignore', env: { ...process.env, ITN_MOCK_CHUNK_DELAY_MS: '0' } });
  const portFile = path.join(dir, 'core.port');
  const core = spawn(path.join(REPO, 'dist/core/itn-desktop-core.exe'),
    ['--data-dir=' + dir, '--port-file=' + portFile, '--ui-dir=' + path.join(REPO, 'shell/renderer')],
    { windowsHide: true, stdio: 'ignore' });
  const shots = path.join(REPO, 'tmp/glass-shots');
  fs.mkdirSync(shots, { recursive: true });
  const errors = [];

  try {
    for (let i = 0; i < 120 && !fs.existsSync(portFile); i++) await sleep(100);
    const base = 'http://127.0.0.1:' + fs.readFileSync(portFile, 'utf8').trim();
    const post = (u, b) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
    await post('/api/models/save', { id: 'mock', name: 'mock', baseUrl: 'http://127.0.0.1:' + mockPort + '/v1', apiKey: 'k', model: 'mock' });
    await post('/api/models/roles', { chatModelId: 'mock', embedModelId: '', chunkModelId: '' });
    await post('/api/kb/save', { id: 'kb', name: '示例资料', rootDir: kb });
    await post('/api/kb/build', { id: 'kb' });

    const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

    const shot = async (name) => { await page.screenshot({ path: path.join(shots, name + '.png') }); };
    const nav = async (p) => { await page.evaluate((x) => go(x), p); await sleep(700); };
    await page.goto(base);
    await page.waitForSelector('#chat-input', { timeout: 30000 });
    await sleep(900);
    await shot('01-workbench-empty');

    await page.fill('#chat-input', 'make:quiz 生成学习资源 count:4');
    await page.locator('.composer-send').click();
    await page.waitForSelector('#resource-dock .resource-title', { timeout: 90000 });
    await sleep(600);
    await shot('02-workbench-resource');

    await nav('resources'); await shot('03-resources');
    await nav('memory'); await shot('04-memory');
    await nav('kb'); await shot('05-kb');
    await nav('home'); await shot('06-home');
    await nav('learn'); await shot('07-learn');
    await nav('report'); await shot('08-report');
    await nav('settings'); await shot('09-settings');
    await nav('chat');
    await page.evaluate(() => applyTheme('dark')); await sleep(900);
    await shot('10-dark-workbench');
    await nav('resources'); await shot('11-dark-resources');
    await nav('settings'); await shot('12-dark-settings');
    await page.evaluate(() => applyTheme('light')); await sleep(400);

    // 窄窗口：三块玻璃并排时不允许出现横向溢出（留白 + 圆角会吃掉宽度）
    for (const [w, h] of [[1280, 800], [1120, 760], [980, 720]]) {
      await page.setViewportSize({ width: w, height: h });
      await nav('chat'); await sleep(500);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 0) throw new Error(w + 'x' + h + ' 横向溢出 ' + over + 'px');
      await shot('13-narrow-' + w);
    }
    await page.evaluate(() => { state.chatSessionId = ''; go('resources'); });
    await sleep(600);
    console.log('SHOTS ' + shots);
    console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
    await browser.close();
  } finally {
    try { core.kill(); } catch (e) { /* ignore */ }
    try { mock.kill(); } catch (e) { /* ignore */ }
  }
})();