/**
 * 分支按钮防重 + 写操作防抖的真实浏览器回归（真实 Edge + 真实 renderer，纯内存夹具）。
 *
 * 复现的真实问题：/api/sessions/branch 要跑好几秒，按钮既没有阻塞也没有防抖 ——
 * 连点几下，十秒后一次性多出好几段分支会话。
 *
 * 怎么测、能抓住什么：
 *  - 分支接口故意延迟 900ms 并计数；连点 5 次（含重画后点新按钮）断言只发一次请求。
 *  - 断言飞行中按钮是 disabled + is-busy，用户看得见"已经点上了"。
 *  - 菜单里的「新建分支」和 /branch 命令各算一个入口，都要只发一次。
 *  - 「导出报告」连点 4 次，断言只写一次文件。
 * 覆盖不到：真实内核的建会话语义（那部分由内核测试覆盖），这里只管界面不重复发请求。
 *
 * BRANCH_UI_DIR 可指向旧版本 renderer：旧代码下这些断言会失败，用来证明测试抓得住问题。
 */
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(require.resolve('playwright', {paths: [
  path.resolve(path.dirname(process.execPath), '..'),
  'D:/Desktop/ITN/ITN/src/frontend/agent-demo',
]}));

const root = path.resolve(__dirname, '..');
const ui = path.resolve(process.env.BRANCH_UI_DIR || path.join(root, 'shell/renderer'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--no-proxy-server']});
  let passed = 0;
  const failures = [];
  const check = (name, ok, details = '') => {
    if (ok) { passed += 1; console.log('PASS ' + name); }
    else { failures.push(name); console.error('FAIL ' + name + (details ? ' ' + details : '')); }
  };
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const calls = {branch: 0, save: 0, setActive: 0};
  let branchSeq = 0;
  const base = [
    {type: 'turn/start', turnId: 't1', payload: {kind: 'ask'}},
    {type: 'user/message', turnId: 't1', payload: {text: '第一问'}},
    {type: 'assistant/message', turnId: 't1', payload: {text: '第一答'}},
    {type: 'turn/end', turnId: 't1', payload: {ok: true}},
    {type: 'turn/start', turnId: 't2', payload: {kind: 'ask'}},
    {type: 'user/message', turnId: 't2', payload: {text: '第二问'}},
    {type: 'assistant/message', turnId: 't2', payload: {text: '第二答'}},
    {type: 'turn/end', turnId: 't2', payload: {ok: true}},
  ];
  const sessions = {s1: base};
  try {
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'branch-guard.test') return route.abort();
      if (url.pathname.startsWith('/api/')) {
        const body = route.request().postDataJSON() || {};
        let data = {};
        if (url.pathname === '/api/settings') data = {models: [{id: 'fixture', name: 'Fixture', model: 'fixture'}], chatModelId: 'fixture', knowledgeBases: []};
        if (url.pathname === '/api/projects/list') data = {projects: []};
        if (url.pathname === '/api/skills/list') data = {skills: [], bound: ''};
        if (url.pathname === '/api/web/cache') data = {mode: 'auto'};
        if (url.pathname === '/api/prefs/get') data = {};
        if (url.pathname === '/api/sessions/list') data = {sessions: Object.keys(sessions).map((id) => ({sessionId: id, title: id, projectId: ''}))};
        if (url.pathname === '/api/sessions/events') data = {events: sessions[body.sessionId] || [], lastId: (sessions[body.sessionId] || []).length};
        if (url.pathname === '/api/sessions/state') data = {status: 'idle'};
        if (url.pathname === '/api/sessions/branch') {
          calls.branch += 1;
          await sleep(900);
          const sid = 'branch-' + (++branchSeq);
          sessions[sid] = base.slice(0, 4);
          data = {sessionId: sid, title: '分支 ' + branchSeq};
        }
        if (url.pathname === '/api/sessions/set-active') { calls.setActive += 1; data = {ok: true}; }
        if (url.pathname === '/api/artifacts/save') { calls.save += 1; await sleep(700); data = {name: body.name || 'x.md'}; }
        return route.fulfill({json: {code: 0, data}});
      }
      const file = path.join(ui, url.pathname === '/' ? 'index.html' : path.basename(url.pathname));
      if (!fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      const raw = fs.readFileSync(file);
      if (url.pathname === '/') {
        return route.fulfill({contentType: 'text/html', body: raw.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')});
      }
      return route.fulfill({body: raw, contentType: file.endsWith('.css') ? 'text/css' : 'application/octet-stream'});
    });
    await page.goto('http://branch-guard.test/');
    await page.addStyleTag({path: path.join(ui, 'style.css')});
    await page.addScriptTag({path: path.join(ui, 'app.js')});
    await page.addScriptTag({path: path.join(ui, 'workbench.js')});
    await page.evaluate(async () => {
      document.getElementById('boot')?.remove();
      current = 'chat';
      currentSection = '';
      state.chatSessionId = 's1';
      await PAGES.chat.render();
      refreshChatHeader();
    });
    await page.waitForSelector('button[aria-label="从这里开分支"]');
    check('真实对话页渲染出「从这里开分支」按钮', await page.locator('button[aria-label="从这里开分支"]').count() >= 1);

    // 1) 单次点击：飞行中必须禁用 + 忙碌态。
    await page.locator('button[aria-label="从这里开分支"]').first().click();
    const flight = await page.evaluate(() => {
      const b = document.querySelector('button[aria-label="从这里开分支"]');
      return {disabled: b.disabled, busy: b.classList.contains('is-busy'), label: b.title};
    });
    check('分支请求飞行中按钮被禁用', flight.disabled === true, JSON.stringify(flight));
    check('分支请求飞行中显示忙碌态与提示', flight.busy === true && /正在开分支/.test(flight.label), JSON.stringify(flight));

    // 2) 请求还没回来时重画这一轮：新按钮是启用状态，但 Set 守卫必须拦住重复请求。
    await page.evaluate(() => { state.chatPaint?.(); });
    const reRendered = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button[aria-label="从这里开分支"]')];
      return buttons.length > 0 && buttons.some((b) => !b.disabled);
    });
    check('重画后出现新的可用按钮（说明只靠 disabled 不够）', reRendered === true);
    await page.evaluate(() => {
      for (let i = 0; i < 5; i += 1) {
        document.querySelector('button[aria-label="从这里开分支"]')
          ?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
      }
    });
    await sleep(1200);
    check('重画 + 连点 5 次后仍然只有 1 次分支请求', calls.branch === 1, 'branch=' + calls.branch);

    // 分支会把界面切到新会话；下面每个入口前先把对话页恢复成确定状态。
    const resetChat = async () => {
      await page.evaluate(async () => {
        state.chatSessionId = 's1';
        current = 'chat';
        currentSection = '';
        await PAGES.chat.render();
        refreshChatHeader();
      });
      await page.waitForSelector('button[aria-label="会话操作"]');
    };

    // 3) 顶栏 ⋯ 菜单里的「新建分支」是另一个入口，同样只能发一次。
    for (let i = 0; i < 3; i += 1) {
      await resetChat();
      await page.locator('button[aria-label="会话操作"]').click();
      await page.locator('.rail-menu-item', {hasText: '新建分支'}).click();
      await sleep(60);
    }
    await sleep(1300);
    check('菜单里连点 3 次「新建分支」只多出 1 次请求', calls.branch === 2, 'branch=' + calls.branch);

    // 4) /branch 命令：旧代码里 branchFromLatest 根本没定义，这里会直接抛错。
    await resetChat();
    const slash = await page.evaluate(async () => {
      if (typeof branchFromLatest !== 'function') return {defined: false};
      await slashBranch();
      return {defined: true};
    });
    await sleep(1300);
    check('/branch 命令有实现且只发一次请求', slash.defined === true && calls.branch === 3, JSON.stringify({slash, branch: calls.branch}));

    // 5) 导出报告：连点 4 次只能写一个文件。
    await resetChat();
    await page.evaluate(() => {
      document.body.appendChild(growthReportCard());
    });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.btn')].find((x) => x.textContent.trim() === '导出报告');
      for (let i = 0; i < 4; i += 1) b?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    });
    await sleep(1000);
    check('导出报告连点 4 次只写一次文件', calls.save === 1, 'save=' + calls.save);

    check('整个过程没有未捕获的前端异常', errors.length === 0, errors.join('; '));
    console.log('RESULT ' + passed + ' passed, ' + failures.length + ' failed; ui=' + ui);
    if (failures.length) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
