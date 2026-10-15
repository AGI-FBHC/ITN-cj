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
    if ((await page.locator('.tb-name').innerText()).trim() !== 'LUMIN') throw new Error('标题栏品牌名应为大写 LUMIN');
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
    /* 顶部栏：Lumin 文字居中、栏下那条发丝线不在、logo 位置不变 */
    const bar = await page.evaluate(() => {
      const t = document.querySelector('.titlebar');
      const name = document.querySelector('.tb-name');
      const logo = document.querySelector('.tb-logo');
      const tr = t.getBoundingClientRect();
      const nr = name.getBoundingClientRect();
      const lr = logo.getBoundingClientRect();
      const cs = getComputedStyle(t);
      return {
        barCenter: Math.round(tr.left + tr.width / 2),
        nameCenter: Math.round(nr.left + nr.width / 2),
        logoLeft: Math.round(lr.left),
        after: getComputedStyle(t, '::after').display,
        borderBottom: cs.borderBottomWidth,
        font: getComputedStyle(name).fontFamily.split(',')[0].replace(/"/g, ''),
      };
    });
    if (Math.abs(bar.barCenter - bar.nameCenter) > 4) {
      throw new Error('Lumin 文字应当水平居中：栏中心 ' + bar.barCenter + ' vs 文字中心 ' + bar.nameCenter);
    }
    if (bar.after !== 'none') throw new Error('顶部栏下面那条发丝线应当去掉，实际 ::after display=' + bar.after);
    if (bar.borderBottom !== '0px') throw new Error('顶部栏不该有下边框，实际 ' + bar.borderBottom);
    if (bar.logoLeft > 60) throw new Error('logo 位置不该动（应当还在最左），实际 left=' + bar.logoLeft);
    console.log('TOPBAR 文字居中 ' + bar.nameCenter + ' / 栏中心 ' + bar.barCenter + ' / 字体 ' + bar.font +
      ' / 发丝线 ' + bar.after + ' / logo left=' + bar.logoLeft);

    // 用户消息那一行不该有底色（只有气泡自己有）
    const userRowBg = await page.evaluate(() => {
      const u = document.querySelector('.msg-user');
      return u ? getComputedStyle(u).backgroundColor : 'none';
    });
    if (userRowBg !== 'rgba(0, 0, 0, 0)') throw new Error('用户消息整行不该铺底色，实际 ' + userRowBg);

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
    // 成果面板与对话同平面：窄窗口下也不许变成覆盖式抽屉，而且有拖动条
    const dockInfo = await page.evaluate(() => {
      const d = document.getElementById('resource-dock');
      if (!d) return { found: false };
      const cs = getComputedStyle(d);
      return { found: true, pos: cs.position, splitter: !!d.querySelector('.splitter-dock'), w: Math.round(d.getBoundingClientRect().width) };
    });
    if (dockInfo.found && dockInfo.pos === 'absolute') throw new Error('成果面板不该是覆盖式抽屉（会盖住对话）');
    if (dockInfo.found && !dockInfo.splitter) throw new Error('成果面板边缘应当有可拖的宽度手柄');
    console.log('DOCK-INLINE position=' + dockInfo.pos + ' splitter=' + dockInfo.splitter + ' w=' + dockInfo.w);

    /* 拖动条真的能改宽度，而且记住 —— 只挂手柄不改宽度是最容易骗过自己的假实现
       （踩过：--dock-w 设上了，但 workbench.css 里同特异性的宽度把它盖掉了）。 */
    const dragCheck = async (sel, splitterSel, dx) => {
      const before = await page.evaluate((x) => Math.round(document.querySelector(x).getBoundingClientRect().width), sel);
      const box = await page.locator(splitterSel).first().boundingBox();
      await page.mouse.move(box.x + 3, box.y + 150);
      await page.mouse.down();
      await page.mouse.move(box.x + 3 + dx, box.y + 150, { steps: 6 });
      await page.mouse.up();
      await sleep(500);
      const after = await page.evaluate((x) => Math.round(document.querySelector(x).getBoundingClientRect().width), sel);
      return { before, after };
    };
    const panelDrag = await dragCheck('.panel', '.splitter-panel', 60);
    if (Math.abs((panelDrag.after - panelDrag.before) - 60) > 8) throw new Error('会话栏宽度没跟着拖动：' + JSON.stringify(panelDrag));
    const dockDrag = await dragCheck('.resource-dock', '.splitter-dock', -80);
    if (Math.abs((dockDrag.after - dockDrag.before) - 80) > 8) throw new Error('成果面板宽度没跟着拖动：' + JSON.stringify(dockDrag));
    const prefsAfterDrag = await post('/api/prefs/get', {});
    if (!prefsAfterDrag.data.uiDockW || !prefsAfterDrag.data.uiPanelW) {
      throw new Error('拖过的宽度应当写进偏好，实际 ' + JSON.stringify([prefsAfterDrag.data.uiDockW, prefsAfterDrag.data.uiPanelW]));
    }
    console.log('DRAG 会话栏 ' + panelDrag.before + '→' + panelDrag.after + ' / 成果面板 ' + dockDrag.before + '→' + dockDrag.after +
      ' （存下 ' + prefsAfterDrag.data.uiPanelW + ' / ' + prefsAfterDrag.data.uiDockW + '）');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { const d = document.getElementById('resource-dock'); if (d) d.hidden = true; });
    await nav('chat');

    // ＋ → 常规聊天：新模式菜单必须真的能建出会话，并且那枚 chip 变成固定档
    await page.locator('#rail-new').click();
    await page.waitForSelector('.rail-menu.new-menu', { timeout: 5000 });
    await page.locator('.rail-menu.new-menu .rail-menu-item').first().click();
    await sleep(700);
    /* 常规对话：不给任何选项（工作区 chip 与权限 chip 都不摆）——
       用户要求"常规对话就不要有任何的选项"。 */
    // 查"真的看得见"：只查 [hidden] 属性不够 —— 元素自己的 display 会把它盖掉（踩过）
    const chatChips = await page.locator('.composer-chip:visible').count();
    if (chatChips !== 0) throw new Error('常规对话不该有工作区/权限选项，实际可见 ' + chatChips + ' 个');
    console.log('CHAT-MODE 常规对话没有任何选项');

    /* Work 模式（挂工作区的会话）：才给选项，权限默认"帮我批准"。
       顺带验一个真实踩过的坑：刚新建的空会话还没进会话列表，不能因此被当成常规对话。 */
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itn-work-'));
    const projSaved = await post('/api/projects/save', { root: projDir });
    const proj = projSaved.data;
    await nav('chat');
    await page.locator('#panel-body .rail-group-head[data-group="' + proj.id + '"] .rail-group-btn').last().click();
    await sleep(1000);
    const workCrumb = (await page.locator('.wb-crumb').innerText()).replace(/\s+/g, " ");
    if (workCrumb.indexOf(proj.name) < 0) throw new Error('从项目新建的会话，顶栏应当显示这个工作区：' + workCrumb);
    const workChips = await page.locator('.composer-chip:visible').allInnerTexts();
    const workChipsText = workChips.join(' | ').replace(/\s+/g, " ");
    // 输入框里只有"权限"这一枚 chip：工作区在顶栏面包屑上，不再在输入框里摆目录（用户要求）
    if (workChipsText.indexOf('帮我批准') < 0) throw new Error('Work 会话的权限默认应当是「帮我批准」，实际：' + workChipsText);
    if (workChipsText.indexOf(proj.name) >= 0) throw new Error('输入框里不该再出现工作区/目录 chip，实际：' + workChipsText);
    console.log('WORK-MODE 面包屑=' + workCrumb + ' / chip=' + workChipsText);

    /* 工作过程折叠组 + 变更文件卡（借鉴 pi-studio）：跑完只剩一行，改了哪些文件一目了然。
       在 Work 会话里验 —— 写文件的工具只在有工作目录时挂上。 */
    await page.locator('#chat-input').fill('帮我写个文件：写文件测试');
    await page.locator('.composer-send').click();
    await page.waitForFunction(() => !state.busyTurn, null, { timeout: 90000 });
    await sleep(900);
    const workOut = await page.evaluate(() => {
      const g = document.querySelector('.chat-thread .work-group');
      const f = document.querySelector('.chat-thread .file-card');
      return {
        group: !!g, open: g ? g.open : null, head: g ? g.querySelector('.work-head').innerText.replace(/\s+/g, ' ') : '',
        file: !!f, fileHead: f ? f.querySelector('.file-head').innerText.replace(/\s+/g, ' ') : '',
        row: f && f.querySelector('.file-row') ? f.querySelector('.file-row').textContent.replace(/\s+/g, ' ') : '',
      };
    });
    if (!workOut.group) throw new Error('一轮里有工具调用时应当出现「工作过程」折叠组');
    if (workOut.open) throw new Error('跑完之后工作过程应当收起，实际还开着');
    if (workOut.head.indexOf('工作过程') < 0) throw new Error('组头应当是「工作过程 …」，实际：' + workOut.head);
    if (!workOut.file) throw new Error('写了文件之后应当出现「改了 N 个文件」卡');
    if (workOut.fileHead.indexOf('改了 1 个文件') < 0 || workOut.fileHead.indexOf('+') < 0) {
      throw new Error('文件卡应当写着改了 1 个文件与 +/-，实际：' + workOut.fileHead);
    }
    if (workOut.row.indexOf('mock-test.md') < 0) throw new Error('文件卡里应当列出改了哪个文件，实际：' + workOut.row);
    console.log('WORK-GROUP ' + workOut.head + ' · FILE-CARD ' + workOut.fileHead + ' · ' + workOut.row);

    /* 改动草稿：写文件之前留了一份原样 —— 文件卡上能"看差异"，也能一键撤销（可还原）。 */
    await page.locator('.chat-thread .file-head').first().click();   // 文件卡默认折叠，先展开
    await sleep(300);
    const draftBtns = await page.locator('.chat-thread .file-row[data-draft] .file-acts .msg-icon-btn').count();
    if (draftBtns !== 2) throw new Error('文件行上应当有「看差异 / 撤销」两枚按钮，实际 ' + draftBtns);
    await page.locator('.chat-thread .file-row[data-draft] .file-acts .msg-icon-btn').first().click();
    await page.waitForSelector('.card.dialog .resource-diff-lines .diff-add', { timeout: 8000 });
    const diffLines = await page.locator('.card.dialog .resource-diff-lines > div').count();
    if (diffLines < 2) throw new Error('差异弹窗里应当有内容，实际 ' + diffLines + ' 行');
    const draftFile = path.join(projDir, 'mock-test.md');
    if (!fs.existsSync(draftFile)) throw new Error('写文件的工具应当真的落了盘：' + draftFile);
    await page.locator('.card.dialog button', { hasText: '撤销这次改动' }).click();
    await sleep(800);
    if (fs.existsSync(draftFile)) throw new Error('撤销之后文件应当被还原（新建的文件 = 删掉）');
    if ((await page.locator('.chat-thread .file-row .file-acts .file-tag').count()) < 1) {
      throw new Error('撤销之后那一行应当标上「已还原」');
    }
    console.log('DRAFT 看差异 ✓（' + diffLines + ' 行）· 撤销 ✓（mock-test.md 已删）');

    await page.locator('#chat-input').fill('工作区第一问');
    await page.locator('.composer-send').click();
    await page.waitForFunction(() => !state.busyTurn, null, { timeout: 90000 });
    await sleep(600);
    await nav('chat');

    await page.locator('#chat-input').fill('第二个会话');
    await page.waitForTimeout(50);
    await page.locator('.composer-send').click();
    await page.waitForFunction(() => !state.busyTurn, null, { timeout: 90000 });
    await sleep(800);

    /* 顶栏那条面包屑：📁 工作区 | 会话名（名字是这一段对话的，不是全书/全库的） */
    const crumb = await page.locator('.wb-crumb').innerText();
    if (crumb.indexOf('|') < 0) throw new Error('对话页顶栏应当是「工作区 | 会话名」，实际：' + crumb.replace(/\s+/g, " "));
    if (await page.locator('.wb-crumb .wb-crumb-ws svg').count() !== 1) throw new Error('工作区前面应当有一个文件夹图标');
    // 右上角的三个点：改名字 / 新建分支 / 复制会话链接
    await page.locator('.wb-menu-btn').click();
    await page.waitForSelector('.session-menu-right', { timeout: 5000 });
    const smText = (await page.locator('.session-menu-right').innerText()).replace(/\s+/g, " ");
    for (const need of ['修改会话名称', '新建分支', '复制会话链接']) {
      if (smText.indexOf(need) < 0) throw new Error('会话菜单里缺少「' + need + '」，实际：' + smText);
    }
    if (smText.indexOf('（从最新') >= 0 || smText.indexOf('(从最新') >= 0) throw new Error('分支项不该带括号说明');
    await page.keyboard.press('Escape');
    await sleep(200);
    console.log('CHAT-HEADER 面包屑=' + crumb.replace(/\s+/g, " ") + ' / 菜单=' + smText);

    /* 思考段与工具卡：**跑完就默认折叠**（用户要的"加载完之后就默认折叠，不要一直展开着"）。 */
    const openThink = await page.locator('#chat-thread .think-row[open]').count();
    if (openThink) throw new Error('跑完的轮次里思考段应当默认折叠，实际还有 ' + openThink + ' 个展开着');
    const openTool = await page.locator('#chat-thread .tool-card[open]').count();
    if (openTool) throw new Error('跑完的轮次里工具卡应当默认折叠，实际还有 ' + openTool + ' 个展开着');
    if (!(await page.locator('#chat-thread .think-row').count())) throw new Error('这一段应当有思考段（假模型也会回 reasoning）');
    console.log('COLLAPSED-BY-DEFAULT 思考段与工具卡都是收起的');


    /* ＋ 是"添加附件"，不是权限选项；权限只在权限 chip 上（用户明确要求）。 */
    await page.locator('.composer-icon').first().click();
    await page.waitForSelector('.cm-attach:not([hidden])', { timeout: 5000 });
    const attachText = (await page.locator('.composer-menu').innerText()).replace(/\s+/g, " ");
    if (attachText.indexOf('选文件') < 0 || attachText.indexOf('选文件夹') < 0) {
      throw new Error('＋ 里应当是添加附件，实际：' + attachText);
    }
    if (attachText.indexOf('批准') >= 0 || attachText.indexOf('完全访问') >= 0) {
      throw new Error('＋ 里不该出现权限选项，实际：' + attachText);
    }
    await page.keyboard.press('Escape');
    await sleep(200);
    console.log('ATTACH-MENU ' + attachText);

    // 模型名靠右、紧贴发送键左边
    const composerRight = await page.evaluate(() => {
      const m = document.querySelector('.composer-model');
      const s = document.querySelector('.composer-send');
      const row = document.querySelector('.composer-row') || (m && m.parentElement);
      if (!m || !s || !row) return null;
      const mr = m.getBoundingClientRect();
      const sr = s.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      return { modelRight: Math.round(mr.right), sendLeft: Math.round(sr.left), sendRight: Math.round(sr.right), rowRight: Math.round(rr.right) };
    });
    if (!composerRight) throw new Error('找不到模型名或发送键');
    if (composerRight.sendLeft < composerRight.modelRight || composerRight.sendLeft - composerRight.modelRight > 40) {
      throw new Error('模型名应当紧贴发送键左边：' + JSON.stringify(composerRight));
    }
    if (composerRight.rowRight - composerRight.sendRight > 60) throw new Error('发送键应当贴右：' + JSON.stringify(composerRight));

    /* 输入框：不许在底部留一条点不动的死留白，也不许在上面常驻一条空的"待分叉"横条（用户实测报过）。
       原因是 .composer 的 min-height 比内容高，和 .split-hint 自己写了 display:flex 把 [hidden] 盖掉了。 */
    const composerFit = await page.evaluate(() => {
      const c = document.querySelector('.composer');
      const ta = c && c.querySelector('textarea');
      const row = c && c.querySelector('.composer-row');
      const sh = document.querySelector('.split-hint');
      const cs = getComputedStyle(c);
      const inner = (ta ? ta.getBoundingClientRect().height : 0) + (row ? row.getBoundingClientRect().height : 0);
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      return {
        height: Math.round(c.getBoundingClientRect().height),
        inner: Math.round(inner),
        gap: Math.round(c.getBoundingClientRect().height - inner - pad),
        splitDisplay: sh ? getComputedStyle(sh).display : 'missing',
      };
    });
    if (composerFit.gap > 8) throw new Error('输入框底部不该留死白：容器比内容高 ' + composerFit.gap + 'px');
    if (composerFit.splitDisplay !== 'none') {
      throw new Error('没点过"开分支"时，待分叉提示条不该占位置（实际 display=' + composerFit.splitDisplay + '）');
    }
    console.log('COMPOSER-FIT 高 ' + composerFit.height + 'px（余量 ' + composerFit.gap + 'px）· split-hint=' + composerFit.splitDisplay);
    console.log('COMPOSER-ORDER 模型右缘 ' + composerRight.modelRight + ' → 发送键 ' + composerRight.sendLeft);

    /* 与 pi 对齐的那几条本地命令：/session /name /export /reload /hotkeys /copy 都要能跑，
       而且不花模型调用（命令表里必须能查到）。 */
    const cmdList = await page.evaluate(() => SLASH_COMMANDS.map((c) => c.cmd).join(" "));
    for (const need of ['/session', '/name', '/export', '/reload', '/hotkeys', '/copy']) {
      if (cmdList.indexOf(need) < 0) throw new Error('命令表里缺少 ' + need + '，实际：' + cmdList);
    }
    await page.locator('#chat-input').fill('/session');
    await page.keyboard.press('Enter');
    await sleep(500);
    const sessionDlg = (await page.locator('#view .card.dialog').first().innerText()).replace(/\s+/g, " ");
    if (sessionDlg.indexOf('会话 id') < 0 || sessionDlg.indexOf('工作区') < 0) {
      throw new Error('/session 应当给出会话信息，实际：' + sessionDlg.slice(0, 120));
    }
    await page.locator('#view .card.dialog button', { hasText: '知道了' }).first().click();
    await sleep(200);
    await page.locator('#chat-input').fill('/hotkeys');
    await page.keyboard.press('Enter');
    await sleep(400);
    const hk = (await page.locator('#view .card.dialog').first().innerText()).replace(/\s+/g, " ");
    if (hk.indexOf('Enter') < 0) throw new Error('/hotkeys 应当列出快捷键，实际：' + hk.slice(0, 120));
    await page.locator('#view .card.dialog button', { hasText: '知道了' }).first().click();
    await sleep(200);
    await page.locator('#chat-input').fill('/copy');
    await page.keyboard.press('Enter');
    await sleep(400);
    console.log('PI-COMMANDS 本地命令可用（/session /hotkeys /copy 已实测）');
    // 消息行：用户气泡下面是"时间 · 复制 · 重写"，回答下面是"复制 · 分支 · 时间\"
    if (!(await page.locator('#chat-thread .msg-user .msg-meta').count())) throw new Error('用户气泡下面应当有时间与图标');
    if (!(await page.locator('#chat-thread .msg-meta.left').count())) throw new Error('回答下面应当有复制/分支与时间');
    if (!(await page.locator('#chat-thread .msg-meta .msg-time').count())) throw new Error('消息底下应当显示时间');

    /* 会话名：第一轮提问后由模型起一次，列表里那行字要换掉"第一句话兜底"的默认标题；
       起过之后不再变（只生成一次）。 */
    let generatedTitle = "";
    for (let i = 0; i < 40; i++) {
      const titles = await page.locator('#panel-body .panel-item-title').allInnerTexts();
      const hit = titles.find((x) => x.indexOf('Mock 会话名') >= 0);
      if (hit) { generatedTitle = hit; break; }
      await sleep(250);
    }
    if (!generatedTitle) {
      throw new Error('第一轮之后会话标题应当被模型起名替换（期望含「Mock 会话名」），实际：' +
        (await page.locator('#panel-body .panel-item-title').allInnerTexts()).join(' / '));
    }
    if (generatedTitle.indexOf('"') >= 0 || generatedTitle.indexOf('。') >= 0) {
      throw new Error('标题里的引号/句号应当被清洗掉，实际：' + generatedTitle);
    }
    console.log('SESSION-TITLE 生成=' + generatedTitle);

    /* 已经起过名的那段：再调一次端点必须原样返回、不再生成（"只生成一次"是用户明确要的语义）。 */
    const titleAgain = await page.evaluate(async () => {
      const list = (await (await fetch('/api/sessions/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).data.sessions;
      const target = list.find((x) => String(x.title || '').indexOf('Mock 会话名') >= 0);
      if (!target) return { found: false, titles: list.map((x) => x.title) };
      const r = await (await fetch('/api/sessions/title', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: target.sessionId }) })).json();
      return { found: true, data: r.data, title: target.title };
    });
    if (!titleAgain.found) throw new Error('找不到起过名的那段会话：' + JSON.stringify(titleAgain.titles));
    if (titleAgain.data.generated) throw new Error('标题只能生成一次，第二次调用不该再生成：' + JSON.stringify(titleAgain.data));
    if (String(titleAgain.data.title || '') !== titleAgain.title) {
      throw new Error('第二次调用不该改标题：' + JSON.stringify(titleAgain));
    }
    console.log('SESSION-TITLE-ONCE 二次调用 generated=false，标题仍是 ' + titleAgain.title);


    // 旧的"项目 chip 一排"必须消失
    if (await page.locator('.rail-new').count()) throw new Error('新建对话那一排 chip 应该已经去掉（改成右上角 ＋ 的模式菜单）');
    const heads = await page.locator('#panel-body .rail-group-head').count();
    if (!heads) throw new Error('会话栏应当有分组标题（普通对话 / 项目）');
    const headTexts = await page.locator('#panel-body .rail-group-name').allInnerTexts();
    const headClean = headTexts.map((x) => x.replace(/\s+/g, ""));
    if (!headClean.some((x) => x.indexOf('普通对话') >= 0)) throw new Error('会话栏里应当有「普通对话」这一组，实际：' + headClean.join(' / '));
    // 项目在前、普通对话固定收尾（项目是这版的组织单元）
    if (headClean[headClean.length - 1].indexOf('普通对话') < 0) throw new Error('「普通对话」应当排在最后，实际：' + headClean.join(' / '));
    console.log('RAIL-GROUPS ' + headClean.join(' | '));
    if (await page.locator('#panel-body .rail-group-head[data-group=""] .rail-group-actions').count()) {
      throw new Error('「普通对话」行不该有项目动作（⋯ / 新建会话）');
    }

    // 右上角 ＋ ＝ 新模式菜单：常规聊天 / 指定工作区 / 新建项目
    await page.locator('#rail-new').click();
    await page.waitForSelector('.rail-menu.new-menu', { timeout: 5000 });
    const menuText = (await page.locator('.rail-menu.new-menu').innerText()).replace(/\s+/g, " ");
    if (menuText.indexOf('常规聊天') < 0) throw new Error('＋ 菜单里应当有「常规聊天」，实际：' + menuText);
    if (menuText.indexOf('新建项目') < 0) throw new Error('＋ 菜单里应当有「新建项目…」，实际：' + menuText);
    // 浮窗必须挂在 body 上（fixed）：面板是玻璃层，absolute 的菜单比面板宽就会被侧栏盖住
    const popInfo = await page.evaluate(() => {
      const m = document.querySelector('.rail-menu.popover');
      if (!m) return null;
      const r = m.getBoundingClientRect();
      return { pos: getComputedStyle(m).position, left: Math.round(r.left), top: Math.round(r.top),
               right: Math.round(r.right), bottom: Math.round(r.bottom),
               vw: window.innerWidth, vh: window.innerHeight, parent: m.parentElement.tagName };
    });
    if (!popInfo) throw new Error('＋ 的浮窗没出来');
    if (popInfo.pos !== 'fixed' || popInfo.parent !== 'BODY') throw new Error('浮窗应当是挂在 body 上的 fixed 层，实际 ' + JSON.stringify(popInfo));
    if (popInfo.left < 8 || popInfo.right > popInfo.vw - 8 || popInfo.top < 8 || popInfo.bottom > popInfo.vh - 8) {
      throw new Error('浮窗超出可视区（会被裁掉）：' + JSON.stringify(popInfo));
    }
    console.log('POPOVER fixed left=' + popInfo.left + ' top=' + popInfo.top + ' 视口=' + popInfo.vw + 'x' + popInfo.vh);
    await shot('16-new-menu');
    await page.keyboard.press('Escape');           // Esc 收起菜单
    await sleep(200);
    if (await page.locator('.rail-menu.new-menu').count()) throw new Error('点了别处，＋ 菜单应该收起');

    /* 新建会话必须把对话区清空。
       上一版只清了渲染缓存（paintCache）没摘 DOM，旧节点还挂在对话区上，
       用户看到的是"新会话把上一段的记录也带过来了"（实测报过）。 */
    const beforeNew = await page.locator('#chat-thread .turn-block').count();
    if (beforeNew < 1) throw new Error('这一段本来就该有内容，实际 ' + beforeNew);
    await page.locator('#rail-new').click();
    await page.waitForSelector('.rail-menu.new-menu', { timeout: 5000 });
    await page.locator('.rail-menu.new-menu .rail-menu-item').first().click();
    await sleep(900);
    const afterNew = await page.locator('#chat-thread .turn-block').count();
    if (afterNew !== 0) throw new Error('新建会话后对话区应当清空，实际还剩 ' + afterNew + ' 轮（旧记录没摘掉）');
    console.log('NEW-SESSION 新会话对话区已清空（旧内容 ' + beforeNew + ' 轮不再显示）');

    // 空会话不进列表（列表是按"有事件"的会话聚合出来的），所以这里数到 2 就够验切换
    const rows = await page.locator('#panel-body .panel-item').count();
    if (rows < 2) throw new Error('至少要两段会话才能验切换，实际 ' + rows);
    /* 会话列表不能每轮被整块重建：以前 renderPanel 先清空再等 HTTP，用户看到列表闪一下。
       这里数"面板被清空过几次" —— 一轮问答里应当只有收尾那一次（标题/时间变了才需要重建）。 */
    await page.evaluate(() => {
      window.__panelRebuilds = 0;
      const b = document.getElementById('panel-body');
      new MutationObserver((recs) => {
        for (const r of recs) if (r.type === 'childList' && r.removedNodes.length > 3) window.__panelRebuilds++;
      }).observe(b, { childList: true });
    });
    await page.locator('#chat-input').fill('第三轮，看看列表会不会闪');
    await page.locator('.composer-send').click();
    await page.waitForFunction(() => !state.busyTurn, null, { timeout: 90000 });
    await sleep(1200);
    const rebuilds = await page.evaluate(() => window.__panelRebuilds);
    if (rebuilds > 1) throw new Error('跑一轮期间会话列表被整块重建 ' + rebuilds + ' 次（就是"闪一下"的来源）');
    console.log('RAIL-NO-FLASH 一轮里列表重建 ' + rebuilds + ' 次');

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

    /* 气泡里直接编辑：点"重写"就地变成输入框（不是另开一个窗口），取消要原样还回来。 */
    const lastUser = page.locator('#chat-thread .msg-user').last();
    const beforeEdit = (await lastUser.innerText()).trim();
    await lastUser.locator('.msg-meta .msg-icon-btn').last().click();
    await sleep(300);
    if (!(await page.locator('#chat-thread .msg-user .msg-body .bubble-edit').count())) {
      throw new Error('编辑器应当长在气泡里面');
    }
    await page.locator('.bubble-edit-actions button', { hasText: '取消' }).click();
    await sleep(250);
    if (await page.locator('#chat-thread .bubble-edit').count()) throw new Error('取消之后编辑器应当消失');
    const afterEdit = (await lastUser.innerText()).trim();
    if (afterEdit !== beforeEdit) throw new Error('取消之后应当原样还回原来的文字：' + beforeEdit + ' → ' + afterEdit);
    console.log('BUBBLE-EDIT 就地编辑 + 取消还原 ✓');

    /* 新建分支：切到新会话、带着分支点之前的历史、名字叫「旧名（2）」；再开一次是（3）。 */
    await page.locator('#chat-input').fill('分支前的第二问');
    await page.locator('.composer-send').click();
    await page.waitForFunction(() => !state.busyTurn, null, { timeout: 90000 });
    await sleep(900);
    const sidBefore = await page.evaluate(() => state.chatSessionId);
    /* 会话树（同一会话内的分叉）：气泡下那枚"从这一轮开分支"发出去之后，
       当前线只看得到新问法、原线一字不动，气泡下面出现 ‹ n/m › 并且切得回去。 */
    const treeBefore = await page.evaluate(() => state.chatTurns.map((t) => t.user));
    if (treeBefore.length < 2) throw new Error('会话树断言需要至少两轮，实际 ' + treeBefore.length);
    await page.locator('#chat-thread .turn-block').first().locator('.msg-user .msg-meta .msg-icon-btn').nth(1).click();
    await sleep(500);
    if (!(await page.locator('.split-hint:not([hidden])').count())) throw new Error('点开分支后应当出现「待分叉」提示条');
    await page.locator('#chat-input').fill('分叉线的新问法');
    await page.locator('.composer-send').click();
    await page.waitForFunction(() => !state.busyTurn, null, { timeout: 90000 });
    await sleep(1200);
    const treeAfter = await page.evaluate(() => ({
      turns: state.chatTurns.map((t) => t.user),
      rows: document.querySelectorAll('#chat-thread .branch-switch').length,
      label: ((document.querySelector('#chat-thread .branch-switch') || {}).innerText || '').replace(/\s+/g, ''),
    }));
    if (treeAfter.turns.length !== 1 || treeAfter.turns[0] !== '分叉线的新问法') {
      throw new Error('分叉之后当前线应当只剩新问法，实际 ' + JSON.stringify(treeAfter.turns));
    }
    if (!treeAfter.rows) throw new Error('分叉之后气泡下面应当出现 ‹ n/m › 切换行（渲染指纹踩过坑）');
    if (treeAfter.label !== '‹2/2›') throw new Error('切换行应当是 ‹ 2/2 ›，实际 ' + treeAfter.label);
    await page.locator('#chat-thread .branch-switch .bs-btn').first().click();
    await page.waitForFunction((want) => JSON.stringify(state.chatTurns.map((t) => t.user)) === want,
      JSON.stringify(treeBefore), { timeout: 15000 });
    await sleep(400);
    const treeBack = await page.evaluate(() => state.chatTurns.map((t) => t.user));
    if (JSON.stringify(treeBack) !== JSON.stringify(treeBefore)) {
      throw new Error('切回原线应当还是原来的几轮：' + JSON.stringify(treeBack) + ' vs ' + JSON.stringify(treeBefore));
    }
    console.log('SESSION-TREE 分叉 ✓ ‹2/2› ✓ 切回 ' + JSON.stringify(treeBack));

    const openBranch = async () => {
      await page.locator('.wb-menu-btn').click();
      await page.waitForSelector('.session-menu-right', { timeout: 5000 });
      await page.locator('.session-menu-right .rail-menu-item', { hasText: '新建分支' }).click();
      await sleep(1800);
      return page.evaluate(() => ({
        sid: state.chatSessionId,
        turns: (state.chatTurns || []).length,
        title: (document.querySelector('.wb-crumb-title') || {}).textContent || '',
      }));
    };
    const baseTitle = (await page.evaluate(() => (document.querySelector('.wb-crumb-title') || {}).textContent || '')).trim();
    const b2 = await openBranch();
    if (b2.sid === sidBefore) throw new Error('开分支之后应当切到新会话');
    if (b2.turns < 1) throw new Error('新分支应当继承分支点之前的历史，实际 ' + b2.turns + ' 轮');
    if (b2.title.indexOf('（2）') < 0) throw new Error('分支会话名应当是「旧名（2）」，实际 ' + b2.title);
    /* 从**同一个父会话**再开一个分支 → 名字继续往后排（3） */
    await page.locator('#panel-body .panel-item', { hasText: baseTitle }).first().click();
    await sleep(1200);
    const b3 = await openBranch();
    if (b3.title.indexOf('（3）') < 0) throw new Error('同一会话的第二个分支应当是（3），实际 ' + b3.title);
    /* 从**分支**再分出去 → 接在这个分支自己的名字后面 →（2）（2） */
    await page.locator('#panel-body .panel-item', { hasText: '（2）' }).first().click();
    await sleep(1200);
    const b4 = await openBranch();
    if (b4.title.indexOf('（2）（2）') < 0) throw new Error('分支的分支应当是「旧名（2）（2）」，实际 ' + b4.title);
    console.log('BRANCH 切换 ✓ 继承 ' + b2.turns + ' 轮 · 命名 ' + b2.title + ' → ' + b3.title + ' → ' + b4.title);

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