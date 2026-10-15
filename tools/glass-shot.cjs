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
    await page.evaluate(() => go('settings', 'about')); await sleep(700); await shot('09b-about');

    // 改名 Lumin + logo 接入：标题、品牌名、静态白名单、对话框里不再有单独的标签
    if (await page.title() !== 'Lumin') throw new Error('窗口标题应改成 Lumin，实际 ' + (await page.title()));
    if ((await page.locator('.tb-name').innerText()).trim() !== 'Lumin') throw new Error('标题栏品牌名应为 Lumin');
    if (await page.locator('.wb-brand').count()) throw new Error('对话框里不该再有单独的 lumin 标签');
    for (const f of ['/logo-mark.png', '/logo-light.png', '/logo-dark.png']) {
      const r = await page.request.get(base + f);
      if (r.status() !== 200) throw new Error(f + ' 取不到（HTTP ' + r.status() + '），静态白名单没放行');
    }
    if (!(await page.locator('.about-logo').isVisible())) throw new Error('关于页应显示品牌 logo');
    console.log('BRAND ok: title=Lumin / logo-mark /logo-light /logo-dark / about 品牌位');
    await nav('chat');
    await page.evaluate(() => applyTheme('dark')); await sleep(900);
    await shot('10-dark-workbench');
    // 品牌 logo 必须跟着主题换（深色挂深底那版、浅色挂浅底那版）
    await page.evaluate(() => go('settings', 'about')); await sleep(700);
    let src = await page.locator('.about-logo').getAttribute('src');
    if (!/logo-dark\.png$/.test(src)) throw new Error('深色下 about logo 应为深底那版，实际 ' + src);
    await shot('10b-dark-about');
    await page.evaluate(() => applyTheme('light')); await sleep(600);
    src = await page.locator('.about-logo').getAttribute('src');
    if (!/logo-light\.png$/.test(src)) throw new Error('浅色下 about logo 应为浅底那版，实际 ' + src);
    console.log('LOGO-THEME ok: dark=logo-dark light=logo-light');
    await page.evaluate(() => applyTheme('dark')); await sleep(400);
    await nav('resources'); await shot('11-dark-resources');
    await nav('settings'); await shot('12-dark-settings');
    await page.evaluate(() => applyTheme('light')); await sleep(400);

    // 滚动条：确认是自绘的细样式（9px 命中区 + 5px 视觉滑块），而不是系统原生
    await nav('resources');   // 对话页的 .view 是 overflow:hidden，量不到滚动条，换个正常滚动的页
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.id = 'sb-probe';
      d.style.height = '3000px';
      document.getElementById('view').appendChild(d);
    });
    await sleep(400);
    const sb = await page.evaluate(() => {
      const v = document.getElementById('view');
      const rail = document.querySelector('.panel-body');
      return {
        gutter: v.offsetWidth - v.clientWidth,
        width: getComputedStyle(v, '::-webkit-scrollbar').width,
        thumbBorder: getComputedStyle(v, '::-webkit-scrollbar-thumb').borderLeftWidth,
        thin: getComputedStyle(v).scrollbarWidth,   // 必须为 auto：写了标准属性会顶掉自绘样式
        railGutter: rail.scrollHeight > rail.clientHeight ? rail.offsetWidth - rail.clientWidth : -1,
        topbarBlur: getComputedStyle(document.querySelector('.titlebar')).backdropFilter,
      };
    });
    if (sb.thin === 'thin') throw new Error('不该写 scrollbar-width（会让 Chromium 忽略自绘滚动条）');
    if (sb.topbarBlur !== 'none') throw new Error('顶部栏不该再有 backdrop 模糊，实际 ' + sb.topbarBlur);
    await page.locator('#view').evaluate((el) => { el.scrollTop = 400; });
    await sleep(300);
    await page.screenshot({ path: path.join(shots, '14-scrollbar-full.png') });
    await page.screenshot({ path: path.join(shots, '14-scrollbar.png'), clip: { x: 1180, y: 200, width: 260, height: 620 } });
    await page.evaluate(() => document.getElementById('sb-probe').remove());
    console.log('SCROLLBAR gutter=' + sb.gutter + 'px width=' + sb.width + ' thumb=' + sb.thumbBorder + ' rail-gutter=' + sb.railGutter + ' topbar-blur=' + sb.topbarBlur);

    // 顶部栏与其控件必须"平"：无模糊、无扫光、无投影
    await nav('chat');
    await page.waitForSelector('#resource-dock:not([hidden])');
    await sleep(400);
    const chrome = await page.evaluate(() => {
      const css = (el) => {
        if (!el) return null;
        const c = getComputedStyle(el);
        return { blur: c.backdropFilter, img: c.backgroundImage === 'none' ? 'none' : 'has-image',
                 bg: c.backgroundColor, shadow: c.boxShadow === 'none' ? 'none' : 'has-shadow',
                 radius: c.borderRadius };
      };
      return {
        titlebar: css(document.querySelector('.titlebar')),
        tbBtn: css(document.querySelector('.tb-btn')),
        toolbarBtn: css(document.querySelector('#wb-artifacts')),
        dockClose: css(document.querySelector('.resource-dock-head .btn')),
        activeNav: css(document.querySelector('.nav-item.active')),
      };
    });
    for (const [k, v] of Object.entries(chrome)) console.log('CHROME ' + k + ' ' + JSON.stringify(v));
    const flatChecks = [['titlebar', chrome.titlebar], ['tbBtn', chrome.tbBtn], ['toolbarBtn', chrome.toolbarBtn]];
    for (const [k, v] of flatChecks) {
      if (v.blur !== 'none') throw new Error(k + ' 不该有 backdrop 模糊：' + v.blur);
      if (v.img !== 'none') throw new Error(k + ' 不该有玻璃扫光背景图');
      if (v.shadow !== 'none') throw new Error(k + ' 不该有投影');
    }

    // 窄窗口：三块玻璃并排时不允许出现横向溢出（留白 + 圆角会吃掉宽度）
    for (const [w, h] of [[1280, 800], [1120, 760], [980, 720]]) {
      await page.setViewportSize({ width: w, height: h });
      await nav('chat'); await sleep(500);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 0) throw new Error(w + 'x' + h + ' 横向溢出 ' + over + 'px');
      await shot('13-narrow-' + w);
    }
    /* 会话栏：形状照 Codex（项目 = 一行可折叠标题 + 缩进的会话），并且点一下必须"就地换"、
       不许整页重建（原来会闪一次"加载中…"）。
       成果面板是覆盖式的（窄窗口下盖住整个右侧），验点击前先把它收起。 */
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { const d = document.getElementById('resource-dock'); if (d) d.hidden = true; });
    await nav('chat');

    // ＋ → 常规聊天：新模式菜单必须真的能建出会话，并且那枚 chip 变成固定档
    await page.locator('#rail-new').click();
    await page.waitForSelector('.rail-menu.new-menu', { timeout: 5000 });
    await page.locator('.rail-menu.new-menu .rail-menu-item').first().click();
    await sleep(700);
    const chipText = (await page.locator('.composer-chip.fixed').innerText()).replace(/\s+/g, "");
    if (chipText.indexOf('常规聊天') < 0) throw new Error('常规聊天会话的 chip 应当是固定档「常规聊天」，实际：' + chipText);
    console.log('CHAT-MODE 常规聊天 chip=' + chipText);

    await page.locator('#chat-input').fill('第二个会话');
    await page.locator('.composer-send').click();
    await page.waitForFunction(() => !state.busyTurn, null, { timeout: 90000 });
    await sleep(800);

    // 旧的"项目 chip 一排"必须消失
    if (await page.locator('.rail-new').count()) throw new Error('新建对话那一排 chip 应该已经去掉（改成右上角 ＋ 的模式菜单）');
    const heads = await page.locator('#panel-body .rail-group-head').count();
    if (!heads) throw new Error('会话栏应当有分组标题（普通对话 / 项目）');
    const headText = (await page.locator('#panel-body .rail-group-name').first().innerText()).replace(/\s+/g, "");
    if (headText.indexOf('普通对话') < 0) throw new Error('第一组应当是「普通对话」，实际：' + headText);
    if (await page.locator('#panel-body .rail-group-head[data-group=""] .rail-group-actions').count()) {
      throw new Error('「普通对话」行不该有项目动作（⋯ / 新建会话）');
    }

    // 右上角 ＋ ＝ 新模式菜单：常规聊天 / 指定工作区 / 新建项目
    await page.locator('#rail-new').click();
    await page.waitForSelector('.rail-menu.new-menu', { timeout: 5000 });
    const menuText = (await page.locator('.rail-menu.new-menu').innerText()).replace(/\s+/g, " ");
    if (menuText.indexOf('常规聊天') < 0) throw new Error('＋ 菜单里应当有「常规聊天」，实际：' + menuText);
    if (menuText.indexOf('新建项目') < 0) throw new Error('＋ 菜单里应当有「新建项目…」，实际：' + menuText);
    await page.keyboard.press('Escape');           // Esc 收起菜单
    await sleep(200);
    if (await page.locator('.rail-menu.new-menu').count()) throw new Error('点了别处，＋ 菜单应该收起');

    const rows = await page.locator('#panel-body .panel-item').count();
    if (rows < 2) throw new Error('至少要两段会话才能验切换，实际 ' + rows);
    await page.evaluate(() => { window.__thread = document.querySelector('.chat-thread'); });
    const t0 = Date.now();
    await page.locator('#panel-body .panel-item').nth(1).click();
    await page.waitForFunction(() => state.chatTurns.length > 0, null, { timeout: 15000 });
    const ms = Date.now() - t0;
    const same = await page.evaluate(() => window.__thread === document.querySelector('.chat-thread'));
    if (!same) throw new Error('点会话把这页整页重建了（.chat-thread 换了节点）');
    const active = await page.locator('#panel-body .panel-item.active').count();
    if (active !== 1) throw new Error('切过去之后应只有一条高亮，实际 ' + active);
    console.log('SESSION-SWITCH 就地切换 ' + ms + 'ms，未整页重建');
    await shot('15-session-switch');

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