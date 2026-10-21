/**
 * 侧边栏专项回归：左栏（第一层）、第二层面板、会话栏、右侧资源栏。
 *
 * 真实 Edge + 真实 renderer + 真实仓颉内核；用代理门控制造"请求还没回来"的时刻，
 * 专门测之前出过问题的场景：切页时旧组件滞留、面板内容与当前页对不上、
 * 折叠状态在切页/重载后丢失、右侧资源栏跟着页面残留。
 *
 * 覆盖不到：内核里会话/课程的业务语义（那些由各自的套件覆盖），这里只测界面结构与时序。
 * SIDEBAR_UI_DIR / SIDEBAR_CORE_EXE 可指向打包后的资源，用来复验包内行为。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {chromium} = require(require.resolve('playwright', {paths: [
  path.resolve(path.dirname(process.execPath), '..'),
  'D:/Desktop/ITN/ITN/src/frontend/agent-demo',
]}));

const root = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return true; await sleep(60); }
  throw Error('condition timed out');
};
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const PANEL_TITLE = {
  home: '首页', learn: '章节', notes: '我的资源', report: '我的成长',
  // resources 的面板标题被 workbench.js 覆写成「学习成果」（原 PANELS.resources 是「产物」）
  resources: '学习成果', kb: '资料库', chat: '对话', settings: '设置',
};
// 左栏只放四个去处 + 设置齿轮；学·练 / 成长 / 笔记 是顶部的二级标签
const RAIL_ROOT = {
  home: 'home', learn: 'home', report: 'home', notes: 'resources',
  resources: 'resources', kb: 'kb', chat: 'chat', settings: 'settings',
};

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumin-sidebar-'));
  const pf = path.join(dir, 'port');
  const kbDir = path.join(dir, 'kb');
  fs.mkdirSync(kbDir);
  fs.writeFileSync(path.join(kbDir, 'doc.md'), '# 侧栏回归\n\n用于资料库面板的样例。');

  const checks = [];
  const errors = [];
  const gates = [];
  const counters = {events: 0};
  let core, proxy, browser, page, base, mock;
  const check = (name, ok, detail = '') => {
    checks.push({name, ok, detail});
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ': ' + detail : ''));
  };
  const post = async (name, body = {}) => {
    const j = await (await fetch(base + '/api/' + name, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    })).json();
    if (j.code !== 0) throw Error(name + ': ' + j.message);
    return j.data;
  };
  const gate = (pathname) => {
    let start, release;
    const g = {pathname, used: false, started: new Promise((r) => (start = r)), wait: new Promise((r) => (release = r)), start, release};
    gates.push(g);
    return g;
  };
  const ready = () => page.waitForFunction(() => document.querySelector('#view')?.getAttribute('aria-busy') === 'false');
  const rail = (name) => page.locator('#rail [data-page="' + name + '"]');
  const nav = async (name) => { await rail(name).click(); await ready(); };
  const navPage = async (name) => {
    if (['learn', 'report'].includes(name)) { await nav('home'); }
    else if (['notes', 'wrong'].includes(name)) { await nav('resources'); }
    else { await nav(name); }
    if (['learn', 'report', 'notes', 'wrong'].includes(name)) {
      await page.locator('.workspace-tabs [data-page="' + name + '"]').click();
      await ready();
    }
  };
  const panelState = () => page.evaluate(() => ({
    title: document.getElementById('panel-title')?.textContent || '',
    hidden: document.body.classList.contains('panel-hidden'),
    panelVisible: !!document.getElementById('panel')?.offsetParent,
    items: document.querySelectorAll('#panel-body .panel-item').length,
    bodyChildren: document.getElementById('panel-body')?.childNodes.length || 0,
  }));

  try {
    core = spawn(process.env.SIDEBAR_CORE_EXE || path.join(root, 'dist/core/itn-desktop-core.exe'),
      ['--data-dir=' + dir, '--port-file=' + pf, '--ui-dir=' + path.join(root, 'shell/renderer'), '--seed-fixture=15000'],
      {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
    core.stderr.on('data', (d) => errors.push('core: ' + d));
    await until(() => fs.existsSync(pf));
    const upstream = 'http://127.0.0.1:' + fs.readFileSync(pf, 'utf8').trim();
    proxy = http.createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const g = gates.find((x) => !x.used && x.pathname === req.url.split('?')[0]);
        if (req.url.split('?')[0] === '/api/sessions/events') counters.events += 1;
        if (g) { g.used = true; g.start(); }
        const response = await fetch(upstream + req.url, {
          method: req.method,
          headers: {'Content-Type': req.headers['content-type'] || 'application/json'},
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
        });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (g) await g.wait;
        if (!res.destroyed) {
          res.writeHead(response.status, {'Content-Type': response.headers.get('content-type') || 'application/octet-stream'});
          res.end(bytes);
        }
      } catch (e) { if (!res.destroyed) { res.writeHead(502); res.end(String(e)); } }
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + proxy.address().port;

    // 准备一点真实数据，让资料库/会话面板有内容可点。
    await post('kb/save', {id: 'sidebar-kb', name: '侧栏样例库', rootDir: kbDir});
    await post('kb/build', {id: 'sidebar-kb'});
    // 没有对话模型时对话页只渲染空状态、不会拉会话事件 —— 那样测不到会话栏的真实行为。
    const mockPort = await freePort();
    mock = spawn('python', [path.join(root, 'tools/mock-openai/server.py'), String(mockPort)],
      {windowsHide: true, stdio: 'ignore', env: {...process.env, ITN_MOCK_CHUNK_DELAY_MS: '0'}});
    await post('models/save', {id: 'sidebar-mock', name: '侧栏夹具', baseUrl: 'http://127.0.0.1:' + mockPort + '/v1', apiKey: 'test', model: 'mock'});
    await post('models/roles', {chatModelId: 'sidebar-mock'});
    browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--no-proxy-server']});
    page = await browser.newPage({viewport: {width: 1440, height: 960}});
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base, {waitUntil: 'load'});
    await page.waitForFunction(() => !document.getElementById('boot'));
    await ready();

    // A) 八个页面各自的面板标题、内容与左栏高亮必须一一对应
    for (const name of Object.keys(PANEL_TITLE)) {
      await navPage(name);
      const st = await panelState();
      const active = await page.locator('#rail .nav-item.active').getAttribute('data-page').catch(() => null);
      check('面板标题跟随页面：' + name, st.title === PANEL_TITLE[name], JSON.stringify(st));
      check('面板有内容而不是空壳：' + name, st.bodyChildren > 0, JSON.stringify(st));
      check('左栏高亮与页面一致：' + name, active === RAIL_ROOT[name], 'active=' + active + ' want=' + RAIL_ROOT[name]);
    }

    // B) 连续快速切页（不等待）：最终页面、面板、浮层、工具栏都要收敛
    const burst = ['home', 'chat', 'kb', 'resources', 'settings', 'home', 'kb', 'chat', 'resources', 'home', 'chat', 'resources'];
    for (const name of burst) await rail(name).click({force: true});
    await page.waitForSelector('.workspace-tabs [data-page="notes"]', {timeout: 15000});
    await page.locator('.workspace-tabs [data-page="notes"]').click({force: true});
    await until(() => page.evaluate(() => current === 'notes' && document.querySelector('#view')?.getAttribute('aria-busy') === 'false'));
    const afterBurst = await page.evaluate(() => ({
      current,
      page: document.body.dataset.page,
      panelTitle: document.getElementById('panel-title')?.textContent || '',
      toolbars: document.querySelectorAll('.wb-toolbar').length,
      panelBodies: document.querySelectorAll('#panel-body').length,
      spinners: document.querySelectorAll('#view .spinner').length,
      overlays: document.querySelectorAll('.course-modal-overlay, .task-modal').length,
      teamScrim: !!document.querySelector('#team-panel-scrim.open'),
    }));
    check('连续切页 12 次后停在最后一个页面', afterBurst.current === 'notes' && afterBurst.page === 'notes', JSON.stringify(afterBurst));
    check('连续切页后面板与页面仍然一致', afterBurst.panelTitle === '我的资源', JSON.stringify(afterBurst));
    check('连续切页后没有重复的工具栏/面板/加载态', afterBurst.toolbars <= 1 && afterBurst.panelBodies === 1 && afterBurst.spinners === 0, JSON.stringify(afterBurst));
    check('连续切页后没有遗留浮层', afterBurst.overlays === 0 && afterBurst.teamScrim === false, JSON.stringify(afterBurst));

    // C) 折叠/展开：切页保持，重载后仍是同一个偏好
    await nav('chat');
    await page.evaluate(() => togglePanel(false));
    await nav('kb');
    await navPage('notes');
    const collapsed = await page.evaluate(() => ({
      hidden: document.body.classList.contains('panel-hidden'),
      visible: !!document.getElementById('panel')?.offsetParent,
      width: document.getElementById('panel')?.getBoundingClientRect().width || 0,
    }));
    check('折叠后切页仍然保持折叠', collapsed.hidden === true && collapsed.visible === false, JSON.stringify(collapsed));
    await page.reload({waitUntil: 'load'});
    await page.waitForFunction(() => !document.getElementById('boot'));
    await ready();
    const afterReload = await page.evaluate(() => document.body.classList.contains('panel-hidden'));
    check('重载后折叠偏好还在', afterReload === true);
    await page.evaluate(() => togglePanel(true));
    await nav('chat');
    const expanded = await panelState();
    check('展开后面板恢复且标题正确', expanded.hidden === false && expanded.title === '对话' && expanded.panelVisible === true, JSON.stringify(expanded));

    // D) 面板在请求还没回来时被折叠/展开，不能把页面搞坏
    await nav('chat');
    // 面板渲染时一定会拉项目清单（会话列表有 1.5s 缓存，门可能碰不到）
    const g1 = gate('/api/projects/list');
    await rail('chat').click();
    await Promise.race([g1.started, sleep(8000).then(() => { throw Error('gate not reached'); })]);
    await page.evaluate(() => togglePanel(false));
    await page.evaluate(() => togglePanel(true));
    g1.release();
    await sleep(400);
    const duringLoad = await page.evaluate(() => ({
      current,
      title: document.getElementById('panel-title')?.textContent || '',
      hidden: document.body.classList.contains('panel-hidden'),
      items: document.querySelectorAll('#panel-body .panel-item').length,
    }));
    check('加载中折叠/展开后页面与面板仍然正确', duringLoad.current === 'chat' && duringLoad.title === '对话' && duringLoad.hidden === false && duringLoad.items >= 2, JSON.stringify(duringLoad));

    // E) 右侧资源栏：跨页必须收起，回到对话再恢复
    await nav('chat');
    await page.evaluate(() => { workbench.open = true; renderResourceDock(); });
    const dockOpen = await page.evaluate(() => !document.getElementById('resource-dock').hidden);
    check('资源栏可以打开（构造前提）', dockOpen === true);
    await navPage('notes');
    const dockAway = await page.evaluate(() => ({
      hidden: document.getElementById('resource-dock').hidden,
      resourceOpen: document.body.classList.contains('resource-open'),
      open: !!workbench.open,
      onChat: current === 'chat',
    }));
    check('切到别的页面后右侧资源栏收起且不留类名', dockAway.hidden === true && dockAway.resourceOpen === false && dockAway.onChat === false, JSON.stringify(dockAway));

    // F) 左栏自身：任何页面都可见、不被浮层盖住、可以继续点
    const railHit = await page.evaluate(() => {
      const item = document.querySelector('#rail [data-page="chat"]');
      const r = item.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {visible: r.width > 0 && r.height > 0, hit: item.contains(top) || item === top};
    });
    check('左栏在内容页上可见且未被遮挡', railHit.visible === true && railHit.hit === true, JSON.stringify(railHit));
    await rail('chat').click();
    await ready();
    check('被遮挡检查之后左栏仍然可点', await page.evaluate(() => current === 'chat'));

    // G) 会话栏：快速连续切换会话，最后选中的那条必须是高亮的那条
    const sidList = await page.evaluate(() => (state.sessions || []).map((s) => s.sessionId));
    if (sidList.length >= 2) {
      const [a, b] = sidList;
      for (const sid of [a, b, a, b, a]) {
        await page.locator('#panel-body .panel-item[data-id="' + sid + '"]').click({force: true});
      }
      await until(() => page.evaluate((sid) => state.chatSessionId === sid, a));
      const selected = await page.evaluate(() => ({
        open: state.chatSessionId,
        highlighted: document.querySelector('#panel-body .panel-item.active')?.dataset.id || '',
        headers: document.querySelectorAll('#panel-body .panel-group-title').length,
      }));
      check('快速切换会话后高亮与打开的是同一条', selected.open === selected.highlighted && selected.open !== '', JSON.stringify(selected));
      check('会话栏没有重复分组标题', selected.headers <= 4, JSON.stringify(selected));

      // H) 慢响应乱序：先点 A 再点 B，让 A 的响应最后才回来。
      //    正文、面板高亮、state.chatSessionId 必须都还是 B；否则用户看到的是 A 的内容，
      //    下一条消息却发给 B —— 这正是"侧边栏切会话"最隐蔽的一类错位。
      const gA = gate('/api/sessions/events');
      const gB = gate('/api/sessions/events');
      await page.locator('#panel-body .panel-item[data-id="' + a + '"]').click();
      await Promise.race([gA.started, sleep(8000).then(() => { throw Error('gate A not reached; eventsCalls=' + counters.events); })]);
      await page.locator('#panel-body .panel-item[data-id="' + b + '"]').click();
      await Promise.race([gB.started, sleep(8000).then(() => { throw Error('gate B not reached'); })]);
      gB.release();
      await sleep(300);
      gA.release();
      await sleep(600);
      const raced = await page.evaluate(() => ({
        open: state.chatSessionId,
        thread: document.getElementById('chat-thread')?.dataset.session || '',
        highlighted: document.querySelector('#panel-body .panel-item.active')?.dataset.id || '',
      }));
      check('慢响应乱序返回后正文/高亮/打开仍是同一条',
        raced.open === b && raced.thread === b && raced.highlighted === b,
        JSON.stringify({want: b, raced}));
    } else {
      check('会话栏有两条以上会话可用于切换（夹具前提）', false, 'sessions=' + JSON.stringify(sidList));
    }

    check('全程没有前端或内核异常', errors.length === 0, errors.join('; '));
    const failed = checks.filter((c) => !c.ok);
    console.log('RESULT ' + (checks.length - failed.length) + '/' + checks.length + '; artifacts ' + dir);
    if (failed.length) process.exitCode = 1;
  } finally {
    for (const g of gates) g.release();
    if (browser) await browser.close();
    if (mock) mock.kill();
    if (proxy) { proxy.closeAllConnections(); await new Promise((r) => proxy.close(r)); }
    if (core) core.kill();
  }
}

main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
